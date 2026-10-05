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
#include <cstdlib>
#include <cstring>

static InterfaceTable* ft;

namespace {

/**
 * The most controls any device has.
 *
 * The FM synth has 148 of them - eight operators of ten, plus a sixty-four-cell modulation
 * matrix - which is what sets this number; Cloud Seed's 45 was what set the old one. A device
 * with more than this has its extra controls IGNORED rather than overflowing anything (see
 * install), and the build says how many each device has, so a device that outgrew this would be
 * noticed; the array costs four bytes a control a slot either way.
 */
const int kMaxParams = 192;

/** How many frames an instrument is given between bend updates while a bend is moving. */
const int kBendPiece = 32;

/**
 * How many loaded files one device may hold at once.
 *
 * A granulator's sample and a convolver's impulse response are kept so that a pattern switching
 * between two of them by index is a switch rather than two reloads, which is the browser's rule
 * for the same controls (its _spareOption keeps a slot per loaded reference). Eight is a few
 * more than any song has used and a few less than a megabyte of pointers.
 */
const int kMaxSamples = 8;

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
    /** The files the device it replaced was playing, which are nothing to the new one. */
    float* retiredSamples[kMaxSamples] = { nullptr };
};

/**
 * ONE file handed to a device, owned by the asynchronous command carrying it.
 *
 * A sample crosses the same three threads an open does, and for the same reason: the frames have
 * to be read out of the server's buffer and summed to one channel, which is a megabyte of work
 * that cannot happen on the audio thread. The audio thread only swaps the pointer in, and the
 * frames it swapped out are freed back on the non-realtime thread.
 *
 * The buffer it reads from belongs to the sample pack sclang already loaded (its samplePacks),
 * so there is no file read here and no lifetime to negotiate: this is queued on the same
 * non-realtime queue the pack's own reads went through, and what it leaves with is its own copy.
 */
struct SampleJob {
    DeviceSlot* slot = nullptr;
    int param = 0;
    int index = 0;
    int bufnum = -1;
    float* frames = nullptr;    // what stage 2 read out, until stage 3 installs it
    int count = 0;
    double sampleRate = 0.0;
    float* retired = nullptr;   // what stage 3 replaced, for stage 4 to free
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
        for (int i = 0; i < kMaxSamples; ++i) { mSamples[i] = LoadedSample(); mRetiringSamples[i] = nullptr; }

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
        // The files the device was playing, for the same reason and on the same terms.
        for (int i = 0; i < kMaxSamples; ++i) {
            free(mSamples[i].frames);
            free(mRetiringSamples[i]);
        }
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
        // The files go with the device that was playing them UNLESS the slot is being refilled
        // with the same device, which is what every evaluation does to every chain: control 3 of
        // one device is not control 3 of another, so a sample left in the table would be handed
        // to a control that never asked for one - but a granulator reopened with its own sample
        // still named must not have to read it again. The frames are the host's to free, so they
        // are retired the way the device is: dropped here on the audio thread, freed on the
        // other one (and the engine's own record of what is loaded follows the same rule - see
        // _rememberDevice in osc-engine's index.js).
        const bool sameDevice = info && info == mInfo;
        if (!sameDevice) {
            for (int i = 0; i < kMaxSamples; ++i) {
                mRetiringSamples[i] = mSamples[i].frames;
                mSamples[i] = LoadedSample();
            }
        }
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

    /**
     * Gives a device a file to play, and says what it replaced. Audio thread.
     *
     * Keyed by the control and the option slot together, which is how the browser keys a loaded
     * file as well: a device with two sample controls (an impulse response and a sample) holds
     * one for each, and a pattern that loaded two samples switches between them by index.
     */
    float* installSample(int param, int index, float* frames, int count, double rate) {
        LoadedSample* at = nullptr;
        for (int i = 0; i < kMaxSamples; ++i) {
            if (mSamples[i].frames && mSamples[i].param == param && mSamples[i].index == index) { at = &mSamples[i]; break; }
        }
        // Not loaded yet: the first empty entry, or - with every entry taken - the oldest, which
        // is the same answer the browser's option list gives when it is full.
        if (!at) {
            for (int i = 0; i < kMaxSamples; ++i) if (!mSamples[i].frames) { at = &mSamples[i]; break; }
        }
        if (!at) {
            at = &mSamples[0];
            for (int i = 1; i < kMaxSamples; ++i) if (mSamples[i].age < at->age) at = &mSamples[i];
        }
        float* old = at->frames;
        at->param = param;
        at->index = index;
        at->frames = frames;
        at->count = count;
        at->sampleRate = rate;
        at->age = ++mSampleAge;
        if (mDevice) mDevice->sample(param, index, frames, count, rate);
        return old;
    }

    /**
     * Hands the device every file it already holds. Audio thread.
     *
     * A device opened AFTER its sample arrived - a chain rebuilt by an evaluation, which reopens
     * every slot - would otherwise be the one device in the song playing nothing, until the
     * pattern's poll happened to name the sample again.
     */
    void resendSamples() {
        if (!mDevice) return;
        for (int i = 0; i < kMaxSamples; ++i) {
            const LoadedSample& one = mSamples[i];
            if (one.frames) mDevice->sample(one.param, one.index, one.frames, one.count, one.sampleRate);
        }
    }

    /** The device the audio thread swapped out, for the caller's thread to free. */
    PdAny* takeRetiring() {
        PdAny* old = mRetiring;
        mRetiring = nullptr;
        return old;
    }

    /** And the files it was playing, into the caller's array. */
    void takeRetiringSamples(float** into) {
        for (int i = 0; i < kMaxSamples; ++i) {
            into[i] = mRetiringSamples[i];
            mRetiringSamples[i] = nullptr;
        }
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

    /**
     * Notes reach an instrument, and the one effect that is played by them: the ducker, whose
     * dip starts on the notes of whatever track is routed into it.
     */
    void noteOn(float note, float velocity) {
        if (mDevice && mInfo && mInfo->takesNotes) mDevice->noteOn(note, velocity);
    }

    void noteOff(float note) {
        if (mDevice && mInfo && mInfo->takesNotes) mDevice->noteOff(note);
    }

    void setKeyPatched(bool on) { mKeyPatched = on; }
    void setNoteRoute(bool on) { mNoteRoute = on; }

    /**
     * The tempo, and the beat the transport is at. Turned into seconds here because that is
     * what a device is given, and anchored to the block it arrived in so the position goes on
     * advancing between messages instead of standing still until the next one.
     */
    void setTransport(float bpm, float beats) {
        mBpm = bpm > 1.f ? bpm : 1.f;
        mTransportSec = (double)beats * 60.0 / mBpm;
        mTransportAtBlock = mWorld->mBufCounter;
    }

    DeviceSlot* slot() { return mSlot; }
    const PdDeviceInfo* info() const { return mInfo; }

private:
    void silence(int frames) {
        const int outs = numOutputs();
        for (int ch = 0; ch < outs; ++ch) memset(out(ch), 0, sizeof(float) * (size_t)frames);
    }

    /**
     * The transport, in seconds, at a sample offset into this block.
     *
     * Counted from the server's own block counter rather than from a wall clock, so it advances
     * at exactly the rate the audio does and a grid laid out on it cannot drift from the audio
     * it is cutting up.
     */
    double transportAt(int offset) const {
        const double blockSec = (double)mWorld->mBufLength / (double)mWorld->mSampleRate;
        const double since = (double)(mWorld->mBufCounter - mTransportAtBlock) * blockSec;
        return mTransportSec + since + (double)offset / (double)mWorld->mSampleRate;
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
            // What is routed into this slot. Said every block rather than on the change: the
            // device that asks is one device, the call is a virtual one per block, and a flag
            // that arrives while a device is being swapped would otherwise be lost.
            device->keyPatched(mKeyPatched);
            device->noteRoute(mNoteRoute);
            // Where the transport is at the start of this piece: the position we were last told,
            // plus the time since. A device that is not synced to anything ignores it.
            device->transport(mBpm, transportAt(at));

            fillInput(devIn, stride, at, n, sidechained, device->inChannels());
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
    void fillInput(float* devIn, int stride, int at, int n, bool sidechained, int channels) {
        float* left = devIn;
        float* right = devIn + stride;
        const float* mainL = mNumMain > 0 ? in(kFirstMainInput) + at : nullptr;
        const float* mainR = mNumMain > 1 ? in(kFirstMainInput + 1) + at : mainL;
        const float* scL = mNumSidechain > 0 ? in(mFirstSidechain) + at : nullptr;
        const float* scR = mNumSidechain > 1 ? in(mFirstSidechain + 1) + at : scL;

        // A device that takes four channels keeps its own signal in stereo and the key beside
        // it: this track on the first pair, whatever `.audio("kick")` named on the second. A
        // compressor's image must not lean, which summing to mono would do.
        if (channels >= 4) {
            if (mainL) {
                memcpy(left, mainL, sizeof(float) * (size_t)n);
                memcpy(right, mainR, sizeof(float) * (size_t)n);
            } else {
                memset(left, 0, sizeof(float) * (size_t)n);
                memset(right, 0, sizeof(float) * (size_t)n);
            }
            float* keyL = devIn + 2 * stride;
            float* keyR = devIn + 3 * stride;
            // No key patched means the device listens to itself, which is what an effect with
            // nothing on its sidechain does on the web too (the browser's host passes null and
            // the processor falls back to its own input).
            const float* fromL = (mKeyPatched && scL) ? scL : (mainL ? mainL : nullptr);
            const float* fromR = (mKeyPatched && scL) ? scR : (mainL ? mainR : nullptr);
            if (fromL) {
                memcpy(keyL, fromL, sizeof(float) * (size_t)n);
                memcpy(keyR, fromR, sizeof(float) * (size_t)n);
            } else {
                memset(keyL, 0, sizeof(float) * (size_t)n);
                memset(keyR, 0, sizeof(float) * (size_t)n);
            }
            return;
        }

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
    /**
     * Whether anything is actually feeding this slot's key input.
     *
     * The aux bus is there whether or not a route is (poptart.scd parks it on a silent bus), so
     * silence on it means nothing on its own - and the difference matters: a compressor with no
     * key listens to ITSELF, which is what a compressor does, while one with a silent key would
     * never compress at all. sclang knows which it is, because it is the half that wires the
     * route, so it says so.
     */
    bool mKeyPatched = false;
    /** Whether a track's notes are routed to this slot (.midi(...)), for the ducker. */
    bool mNoteRoute = false;
    /** The tempo and the transport, for the devices that are synced to it. */
    double mBpm = 120.0;
    double mTransportSec = 0.0;
    /** The block this track's transport position was last told to us at. */
    int64 mTransportAtBlock = 0;
    float mPosition[kMaxParams];
    int mBus[kMaxParams];
    /** One file this device holds: which control it is on, and the frames themselves. */
    struct LoadedSample {
        int param = -1;
        int index = -1;
        float* frames = nullptr;   // malloc'd by the non-realtime thread, mono, the file's own rate
        int count = 0;
        double sampleRate = 0.0;
        int age = 0;               // which entry to take when they are all full
    };
    LoadedSample mSamples[kMaxSamples];
    float* mRetiringSamples[kMaxSamples] = { nullptr };
    int mSampleAge = 0;
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
        slot->unit->takeRetiringSamples(job->retiredSamples);
        // An evaluation reopens every slot in the chain, so a device arriving to find a file
        // already loaded for it is the ordinary path, not an edge case.
        slot->unit->resendSamples();
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
    for (int i = 0; i < kMaxSamples; ++i) {
        free(job->retiredSamples[i]);   // the files that device was playing
        job->retiredSamples[i] = nullptr;
    }
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
    self->takeRetiringSamples(job->retiredSamples);
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

/**
 * "a key is (not) patched into this slot", from whoever wired the route.
 */
void cmdSidechain(Unit* unit, sc_msg_iter* args) {
    ((PoptartDevice*)unit)->setKeyPatched(args->geti(0) != 0);
}

/** "a track's notes are (no longer) routed into this slot", from whoever wired that route. */
void cmdNoteRoute(Unit* unit, sc_msg_iter* args) {
    ((PoptartDevice*)unit)->setNoteRoute(args->geti(0) != 0);
}

/**
 * The tempo, and where the transport is: the beat position at this moment, in beats.
 *
 * Sent as the tempo changes and as the transport moves, exactly as it is sent to a plugin
 * (VSTPluginController's setTempo/setTransportPos, which poptart.scd already calls for every
 * controller). The device is given it in seconds since beat zero, because that is what the
 * browser's host hands its devices and a synced delay has to work out the same length on both.
 */
void cmdTransport(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    const float bpm = args->getf(120.f);
    const float beats = args->getf(0.f);
    self->setTransport(bpm, beats);
}

/**
 * Non-realtime: read the file out of the server's buffer, summed to one channel.
 *
 * Summed the way the browser sums it (granular.mjs's loadSample: each channel divided by the
 * count and added in order), because the two have to agree sample for sample - that is what the
 * parity test holds them to.
 */
bool sampleStage2(World* world, void* data) {
    SampleJob* job = (SampleJob*)data;
    if (!job->slot->alive.load()) return true;
    if (job->bufnum < 0 || (uint32)job->bufnum >= world->mNumSndBufs) {
        Print("PoptartDevice: there is no buffer %d to read a sample from\n", job->bufnum);
        return true;
    }
    // The non-realtime mirror, which is what an asynchronous command is allowed to read.
    const SndBuf* buf = World_GetNRTBuf(world, (uint32)job->bufnum);
    if (!buf || !buf->data || buf->frames <= 0 || buf->channels <= 0) return true;
    float* frames = (float*)malloc(sizeof(float) * (size_t)buf->frames);
    if (!frames) {
        Print("PoptartDevice: could not hold %d frames of sample\n", buf->frames);
        return true;
    }
    const int channels = buf->channels;
    if (channels == 1) {
        memcpy(frames, buf->data, sizeof(float) * (size_t)buf->frames);
    } else {
        // Accumulated the way the browser accumulates it: each channel DIVIDED by the count (not
        // multiplied by a reciprocal), added in channel order, and rounded to a float on every
        // add - which is what `data[i] += c[i] / chans.length` on a Float32Array does. The
        // arithmetic is the parity test's business, so it is copied rather than improved.
        for (int i = 0; i < buf->frames; ++i) {
            float sum = 0.f;
            for (int c = 0; c < channels; ++c) {
                sum = (float)((double)sum + (double)buf->data[i * channels + c] / (double)channels);
            }
            frames[i] = sum;
        }
    }
    job->frames = frames;
    job->count = buf->frames;
    job->sampleRate = buf->samplerate > 0.0 ? buf->samplerate : job->slot->sampleRate;
    return true;
}

/** Audio thread: the device starts playing it, and says what it was playing before. */
bool sampleStage3(World* world, void* data) {
    (void)world;
    SampleJob* job = (SampleJob*)data;
    DeviceSlot* slot = job->slot;
    if (!slot->alive.load() || !slot->unit || !job->frames) return true;
    job->retired = slot->unit->installSample(job->param, job->index, job->frames, job->count, job->sampleRate);
    job->frames = nullptr;
    return true;
}

/** Non-realtime: free whatever is left over, whichever way it went. */
bool sampleStage4(World* world, void* data) {
    (void)world;
    SampleJob* job = (SampleJob*)data;
    free(job->frames);    // read and never installed
    free(job->retired);   // what the device was playing until stage 3
    job->frames = nullptr;
    job->retired = nullptr;
    return true;
}

void sampleCleanup(World* world, void* data) {
    (void)world;
    SampleJob* job = (SampleJob*)data;
    job->slot->release();
    delete job;
}

/**
 * /sample <control> <optionSlot> <bufnum> - audio thread.
 *
 * The buffer is one sclang already read for a sample pack, so this never touches a file. The
 * generation an open claims is deliberately NOT bumped: a sample arriving must not cancel a
 * device that is still being built, and a device that arrives after its sample is handed it on
 * the way in (see openStage3).
 */
void cmdSample(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    SampleJob* job = new SampleJob();
    job->slot = self->slot();
    job->slot->retain();
    job->param = args->geti(-1);
    job->index = args->geti(0);
    job->bufnum = args->geti(-1);
    ft->fDoAsynchronousCommand(unit->mWorld, nullptr, "PoptartDeviceSample", (void*)job,
                               sampleStage2, sampleStage3, sampleStage4, sampleCleanup, 0, nullptr);
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
    DefineUnitCmd("PoptartDevice", "/sidechain", cmdSidechain);
    DefineUnitCmd("PoptartDevice", "/noteRoute", cmdNoteRoute);
    DefineUnitCmd("PoptartDevice", "/transport", cmdTransport);
    DefineUnitCmd("PoptartDevice", "/sample", cmdSample);
}
