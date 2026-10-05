// PoptartDevice - one UGen that hosts any of poptart's own devices inside scsynth.
//
// The browser build plays Plaits, Clouds, Galactic, Cloud Seed and the rest as compiled modules
// behind a tiny ABI (see pd-device.h). This is the desktop side of the same devices: the DSP is
// the same source compiled for scsynth instead of for WebAssembly, so `synth("Plaits")` opens
// the same instrument on either engine, with the same control names and the same 0..1 positions.
//
// WHY ONE UGEN AND NOT ONE PER DEVICE. A track is a single SynthDef with a fixed chain of slots
// (sc/poptart.scd, buildTrackDef), and a device is chosen long after that def was built - so a
// UGen per device would mean rebuilding the def and respawning the track synth to change an
// effect. VSTPlugin solved this years ago by being one generic UGen that loads a plugin at
// runtime, and this follows it exactly, down to the interface:
//
//   inputs:  [bend (kr), numMain, main0..., numSidechain, sidechain0...]
//   outputs: numChannels audio channels
//   unit commands: /open /close /set /map /unmap /noteOn /noteOff /allNotesOff
//
// which is what lets sc/poptart.scd treat a native device and a plugin as the same kind of thing
// (see PoptartDeviceController in classes/PoptartDevice.sc): one `.set`, one `.map`, one
// `resolveParamIndex`, so a ramp, an LFO, an envelope, a MIDI control and an OSC control all
// reach a native device through the code that already drives plugins.
//
// WHAT RUNS WHERE. Opening a device allocates - Cloud Seed's delay lines are tens of megabytes -
// so an open is an asynchronous command: the instance is built on the non-realtime thread, the
// audio thread only swaps a pointer, and the device it swapped out is freed back on the
// non-realtime thread. Everything else (a parameter, a note, a bend) is a plain call from the
// audio thread, which is where the device's own `process` runs too.

#include "SC_PlugIn.hpp"
#include "SC_Graph.h"
#include "pd-device.h"

#include <atomic>
#include <cmath>
#include <cstring>

static InterfaceTable* ft;

namespace {

/** The most controls any device has. Cloud Seed, with the most, has well under this. */
const int kMaxParams = 96;

/** How many frames an instrument is given between bend updates while a bend is moving. */
const int kBendPiece = 32;

/** Input offsets. Everything before the main signal count is fixed. */
enum { kBendInput = 0, kNumMainInput = 1, kFirstMainInput = 2 };

struct PoptartDevice;

/**
 * The UGen's end of an open, which an open still in flight can outlive.
 *
 * An open crosses three threads (audio -> non-realtime -> audio -> non-realtime) and the UGen
 * can be freed at any point in that crossing: a track torn down while its device was still being
 * built is ordinary livecoding, not an edge case. So what an open needs to find its way back does
 * NOT live in the unit - it lives here, refcounted, with the unit holding one of the references.
 * `alive` going false is how a late stage learns there is nothing left to install into.
 */
struct DeviceSlot {
    std::atomic<int> refs{1};
    std::atomic<bool> alive{true};
    /**
     * Bumped by every open and every close. A job whose number is no longer this one has been
     * superseded and must not install what it built - two `synth()` changes in one evaluation
     * are two opens in flight, and the one that finishes second is not necessarily the one the
     * pattern asked for last.
     */
    std::atomic<int> generation{0};
    PoptartDevice* unit = nullptr;
    double sampleRate = 48000.0;

    void retain() { refs.fetch_add(1); }
    void release() {
        if (refs.fetch_sub(1) == 1) delete this;
    }
};

/**
 * ONE open or close, owned by the asynchronous command carrying it out.
 *
 * Per job rather than per unit, which is the whole reason this struct exists separately: two
 * opens of the same slot overlap, and a single scratch area shared between them would have the
 * second overwriting what the first was still building - a device leaked, or installed twice.
 *
 * Allocated with `new` on the audio thread, as native/rubberband/PoptartPitchShift.cpp allocates
 * its shifter: it is a hundred bytes, once per device change, and it buys the ordinary thread
 * safety of the system allocator for a pointer three threads pass between. The allocation that
 * actually matters - the device, which for Cloud Seed is tens of megabytes - happens in stage 2,
 * where it belongs.
 */
struct DeviceJob {
    DeviceSlot* slot = nullptr;
    int generation = 0;
    char name[64] = {0};
    const PdDeviceInfo* info = nullptr;
    PdAny* made = nullptr;      // what stage 2 built, until stage 3 installs it
    PdAny* retired = nullptr;   // what stage 3 swapped out, for stage 4 to free
};

struct PoptartDevice : public SCUnit {
    PoptartDevice() {
        mNumMain = (int)in0(kNumMainInput);
        if (mNumMain < 0) mNumMain = 0;
        const int scCountAt = kFirstMainInput + mNumMain;
        mNumSidechain = (numInputs() > scCountAt) ? (int)in0(scCountAt) : 0;
        if (mNumSidechain < 0) mNumSidechain = 0;
        mFirstSidechain = scCountAt + 1;

        for (int i = 0; i < kMaxParams; ++i) {
            mPosition[i] = 0.f;
            mBus[i] = -1;
        }

        // Shared with every open this unit ever asks for, and outliving the unit if one is
        // still in flight when it goes.
        mSlot = new DeviceSlot();
        mSlot->unit = this;
        mSlot->sampleRate = (double)fullSampleRate();

        set_calc_function<PoptartDevice, &PoptartDevice::next>();
        // Silence rather than a first block of whatever the output buffers held: a device is
        // never open on the block it is born in.
        silence(1);
    }

    ~PoptartDevice() {
        mSlot->alive.store(false);
        mSlot->unit = nullptr;
        mSlot->release();
        // Freed here, on the audio thread, deliberately: the alternative is handing it to a
        // non-realtime command that may outlive the World during a server quit, and a device
        // leaked at quit is a worse trade than a free. It is a free of memory already
        // untouched - no DSP, no page faults - and this is the same choice
        // native/rubberband/PoptartPitchShift.cpp makes for its shifter.
        delete mDevice;
    }

    /**
     * Installs a device the non-realtime thread built. Audio thread.
     *
     * Every control goes back to the new device's own default, and every control bus mapping is
     * dropped. Both because the slot is now a DIFFERENT instrument: control 4 of one device is
     * not control 4 of another, so a position or a modulator left pointing at it would be
     * driving something nobody asked for - and a bus whose ramp synth has since been freed holds
     * whatever the last thing to use that bus left in it. This is what VSTPlugin does on an open
     * too, which is why the engine already re-sends what the pattern is saying afterwards (see
     * dropSlotRamps and the Tier-1 poll in sc/poptart.scd).
     */
    void install(const PdDeviceInfo* info, PdAny* device) {
        mRetiring = mDevice;
        mDevice = device;
        mInfo = info;
        // The device's own count AND the table's, whichever is smaller. They agree today, and
        // the one that would make them disagree is an upstream release adding a parameter to a
        // plugin whose descriptor is read from its source: reading one control past the end of
        // the table would be a crash in the audio thread, which is not a thing to leave to a
        // pin being bumped.
        mParamCount = device ? device->paramCount() : 0;
        if (info && mParamCount > info->paramCount) mParamCount = info->paramCount;
        if (mParamCount > kMaxParams) mParamCount = kMaxParams;
        mMaxBlock = device ? device->maxBlock() : 0;
        for (int i = 0; i < kMaxParams; ++i) {
            mBus[i] = -1;
            mPosition[i] = (info && i < info->paramCount) ? info->params[i].defaultPosition : 0.f;
        }
    }

    /** The device the audio thread swapped out, for the caller's thread to free. */
    PdAny* takeRetiring() {
        PdAny* old = mRetiring;
        mRetiring = nullptr;
        return old;
    }

    void setParam(int index, float position) {
        if (index < 0 || index >= kMaxParams) return;
        mPosition[index] = position;
        mBus[index] = -1;   // an outright set takes the control back off whatever was driving it
    }

    void mapParam(int index, int bus) {
        if (index < 0 || index >= kMaxParams) return;
        mBus[index] = bus;
    }

    void unmapParam(int index) {
        if (index < 0 || index >= kMaxParams) return;
        mBus[index] = -1;
    }

    void noteOn(float note, float velocity) {
        if (mDevice && mInfo && mInfo->isSynth) mDevice->noteOn(note, velocity);
    }

    void noteOff(float note) {
        if (mDevice && mInfo && mInfo->isSynth) mDevice->noteOff(note);
    }

    DeviceSlot* slot() { return mSlot; }
    const PdDeviceInfo* info() const { return mInfo; }

private:
    void silence(int frames) {
        const int outs = numOutputs();
        for (int ch = 0; ch < outs; ++ch) memset(out(ch), 0, sizeof(float) * (size_t)frames);
    }

    /** This block's position for one control: whatever is driving it, or what it was set to. */
    float positionOf(int index) {
        const int bus = mBus[index];
        if (bus < 0) return mPosition[index];
        const World* world = mWorld;
        if (bus >= (int)world->mNumControlBusChannels) return mPosition[index];
        return world->mControlBus[bus];
    }

    void next(int inNumSamples) {
        PdAny* device = mDevice;
        const int outs = numOutputs();
        // Nothing open: silence, NOT the input passed through. A slot's dry path is already
        // carried around the device by the track SynthDef's own bypass (the `active` control -
        // see buildTrackDef), so passing the input through here would mean the chain heard it
        // twice. The browser's host has no such bypass and does pass through; this one must not.
        if (!device || mMaxBlock <= 0) {
            silence(inNumSamples);
            return;
        }

        const int paramCount = mParamCount;
        float* params = device->params();
        for (int i = 0; i < paramCount; ++i) {
            params[i] = pd_denormalize(mInfo->params[i], positionOf(i));
        }

        const bool isSynth = mInfo->isSynth != 0;
        const bool sidechained = mInfo->sidechain != 0;
        const float* bendIn = in(kBendInput);
        const bool bendMoving = isSynth && inRate(kBendInput) == calc_FullRate;

        float* devIn = device->in();
        float* devOut = device->out();
        const int stride = device->maxBlock();

        int at = 0;
        while (at < inNumSamples) {
            int n = inNumSamples - at;
            if (n > mMaxBlock) n = mMaxBlock;
            // A moving bend is followed in short pieces so a vibrato is a curve and not a
            // staircase of blocks - the same BEND_PIECE the browser's host renders in.
            if (bendMoving && n > kBendPiece) n = kBendPiece;

            if (isSynth) device->bend(bendMoving ? bendIn[at] : bendIn[0]);

            fillInput(devIn, stride, at, n, sidechained);
            device->process(n);
            for (int ch = 0; ch < outs; ++ch) {
                const float* from = devOut + (size_t)(ch < 2 ? ch : 1) * stride;
                memcpy(out(ch) + at, from, sizeof(float) * (size_t)n);
            }
            at += n;
        }
    }

    /**
     * The device's two input channels for one piece of this block.
     *
     * A device with a sidechain (Warps, whose carrier is another track) takes one signal per
     * channel: this track summed to mono on the left, the other signal on the right. Every other
     * device takes the chain's own stereo pair. Both match what the browser's host feeds, because
     * a device that hears a different signal on the two engines is a different device.
     */
    void fillInput(float* devIn, int stride, int at, int n, bool sidechained) {
        float* left = devIn;
        float* right = devIn + stride;
        const float* mainL = mNumMain > 0 ? in(kFirstMainInput) + at : nullptr;
        const float* mainR = mNumMain > 1 ? in(kFirstMainInput + 1) + at : mainL;
        const float* scL = mNumSidechain > 0 ? in(mFirstSidechain) + at : nullptr;

        if (sidechained) {
            if (mainL) {
                for (int i = 0; i < n; ++i) left[i] = (mainL[i] + mainR[i]) * 0.5f;
            } else {
                memset(left, 0, sizeof(float) * (size_t)n);
            }
            if (scL) memcpy(right, scL, sizeof(float) * (size_t)n);
            else memset(right, 0, sizeof(float) * (size_t)n);
            return;
        }
        if (mainL) {
            memcpy(left, mainL, sizeof(float) * (size_t)n);
            memcpy(right, mainR, sizeof(float) * (size_t)n);
        } else {
            memset(left, 0, sizeof(float) * (size_t)n);
            memset(right, 0, sizeof(float) * (size_t)n);
        }
    }

    PdAny* mDevice = nullptr;
    PdAny* mRetiring = nullptr;
    const PdDeviceInfo* mInfo = nullptr;
    DeviceSlot* mSlot = nullptr;
    int mParamCount = 0;
    int mMaxBlock = 0;
    int mNumMain = 0;
    int mNumSidechain = 0;
    int mFirstSidechain = 0;
    float mPosition[kMaxParams];
    int mBus[kMaxParams];
};

// ---- the open, across the threads it has to cross --------------------------------------------

/** Non-realtime: build the instance. Nothing here touches the unit. */
bool openStage2(World* world, void* data) {
    (void)world;
    DeviceJob* job = (DeviceJob*)data;
    DeviceSlot* slot = job->slot;
    if (!slot->alive.load() || job->generation != slot->generation.load()) return true;
    const PdDeviceInfo* info = pd_find_device(job->name);
    if (!info) {
        Print("PoptartDevice: no device called '%s'\n", job->name);
        return true;
    }
    PdAny* made = info->make();
    if (!made) {
        Print("PoptartDevice: could not allocate '%s'\n", job->name);
        return true;
    }
    made->init(slot->sampleRate);
    job->info = info;
    job->made = made;
    return true;
}

/**
 * Audio thread: swap it in, and say so. The only moment the graph changes.
 *
 * The reply is what makes an open ASYNCHRONOUS RATHER THAN ASSUMED, and it has to be: the engine
 * holds a track's notes until its instrument is in (sc/poptart.scd's awaitLoaded and waitForLoad -
 * the note at a `.preset("<a b>")` boundary is the one that used to be eaten), and it can only do
 * that if "in" is something it is told rather than something it guesses from a message having
 * been sent. It is addressed the way VSTPlugin's own replies are, by node id and the UGen's index
 * in the graph, so one message serves a track whose every slot is a native device.
 */
bool openStage3(World* world, void* data) {
    (void)world;
    DeviceJob* job = (DeviceJob*)data;
    DeviceSlot* slot = job->slot;
    // Superseded while it was being built, or its unit is gone: stage 4 frees what stage 2 made,
    // and nobody is left waiting to be told.
    if (!slot->alive.load() || !slot->unit || job->generation != slot->generation.load()) return true;
    if (job->made) {
        slot->unit->install(job->info, job->made);
        job->made = nullptr;
        job->retired = slot->unit->takeRetiring();
    }
    const float ok = slot->unit->info() ? 1.f : 0.f;
    Unit* unit = (Unit*)slot->unit;
    SendNodeReply(&unit->mParent->mNode, (int)unit->mParentIndex, "/poptart/deviceOpened", 1, &ok);
    return true;
}

/** Non-realtime: free whatever is left over, whichever way it went. */
bool deviceStage4(World* world, void* data) {
    (void)world;
    DeviceJob* job = (DeviceJob*)data;
    delete job->made;        // built and never installed
    delete job->retired;     // replaced by the one that was, or closed outright
    job->made = nullptr;
    job->retired = nullptr;
    return true;
}

/** Non-realtime: the job itself, and the unit's slot if this was the last reference to it. */
void deviceCleanup(World* world, void* data) {
    (void)world;
    DeviceJob* job = (DeviceJob*)data;
    job->slot->release();
    delete job;
}

/** A close has nothing to build and nothing to announce; the device left is freed in stage 4. */
bool closeNoop(World* world, void* data) {
    (void)world;
    (void)data;
    return true;
}

/** A job against this unit's slot, claiming the right to be the open that lands. */
DeviceJob* claim(PoptartDevice* self) {
    DeviceSlot* slot = self->slot();
    DeviceJob* job = new DeviceJob();
    job->slot = slot;
    slot->retain();
    job->generation = slot->generation.fetch_add(1) + 1;
    return job;
}

/** /open <deviceName> - audio thread. */
void cmdOpen(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    const char* name = args->gets("");
    DeviceJob* job = claim(self);
    strncpy(job->name, name ? name : "", sizeof(job->name) - 1);
    job->name[sizeof(job->name) - 1] = 0;
    ft->fDoAsynchronousCommand(unit->mWorld, nullptr, "PoptartDeviceOpen", (void*)job,
                               openStage2, openStage3, deviceStage4, deviceCleanup, 0, nullptr);
}

/**
 * /close - the slot goes empty.
 *
 * Detached here, on the audio thread, so the device stops sounding on this block: an effect
 * commented out of a chain has to go quiet when it is commented out. Only the freeing waits for
 * a thread that may take its time over it.
 */
void cmdClose(Unit* unit, sc_msg_iter* args) {
    (void)args;
    PoptartDevice* self = (PoptartDevice*)unit;
    DeviceJob* job = claim(self);
    self->install(nullptr, nullptr);
    job->retired = self->takeRetiring();
    ft->fDoAsynchronousCommand(unit->mWorld, nullptr, "PoptartDeviceClose", (void*)job,
                               closeNoop, closeNoop, deviceStage4, deviceCleanup, 0, nullptr);
}

void cmdSet(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    while (args->remain() >= 2) {
        const int index = args->geti(-1);
        const float value = args->getf(0.f);
        self->setParam(index, value);
    }
}

void cmdMap(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    while (args->remain() >= 2) {
        const int index = args->geti(-1);
        const int bus = args->geti(-1);
        self->mapParam(index, bus);
    }
}

void cmdUnmap(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    while (args->remain() >= 1) self->unmapParam(args->geti(-1));
}

void cmdNoteOn(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    const float note = args->getf(-1.f);
    const float velocity = args->getf(1.f);
    if (note >= 0.f) self->noteOn(note, velocity);
}

void cmdNoteOff(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    self->noteOff(args->getf(-1.f));
}

/** Every note off at once, which a device reads as a negative note. */
void cmdAllNotesOff(Unit* unit, sc_msg_iter* args) {
    (void)args;
    ((PoptartDevice*)unit)->noteOff(-1.f);
}

} // namespace

PluginLoad(PoptartDeviceUGens) {
    ft = inTable;
    registerUnit<PoptartDevice>(ft, "PoptartDevice");
    DefineUnitCmd("PoptartDevice", "/open", cmdOpen);
    DefineUnitCmd("PoptartDevice", "/close", cmdClose);
    DefineUnitCmd("PoptartDevice", "/set", cmdSet);
    DefineUnitCmd("PoptartDevice", "/map", cmdMap);
    DefineUnitCmd("PoptartDevice", "/unmap", cmdUnmap);
    DefineUnitCmd("PoptartDevice", "/noteOn", cmdNoteOn);
    DefineUnitCmd("PoptartDevice", "/noteOff", cmdNoteOff);
    DefineUnitCmd("PoptartDevice", "/allNotesOff", cmdAllNotesOff);
}
