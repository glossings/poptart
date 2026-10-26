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
//   unit commands: /open /close /set /map /mapa /unmap /noteOn /noteOff /allNotesOff
//                  /sample /shape /report /sidechain /noteRoute /transport
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
// audio thread, which is where the device's own `process` runs too - except what a device asks to
// have built where it may take time (a wavetable's pyramid, a convolver's partitions), which goes
// through the work round below, across the same threads an open does.
//
// NOTES LAND ON THEIR SAMPLE. A unit command is performed between blocks, but one that arrived
// in a timestamped bundle is performed with World's mSampleOffset set to where in the coming
// block its time falls - the number OffsetOut starts a voice at. A note keeps that offset, and
// the block is rendered in two pieces either side of it.

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
 * How many frames a device is given at a time while audio is patched onto one of its controls.
 *
 * One, because that is what patching audio onto a control MEANS: the browser's own devices read
 * a moving control per sample, and phase modulation or a cutoff swept at audio rate is nothing
 * else. The device's own `process` reads its controls once per call (the ABI), so a control that
 * changes every sample needs a call every sample. Measured on the parity harness, that costs the
 * synths about one and a half to two times their usual load and Distort - whose oversampler pays
 * per call - far more; it is paid only while something is patched.
 */
const int kPatchPiece = 1;

/**
 * The files and curves a device holds are lists with no length of their own: a device keeps
 * every one it was handed, the way the browser's option lists do, and the only bound is the
 * device's own number of slots for them (its descriptor's `capacity`). A file's entry is made on
 * the non-realtime thread along with the frames it holds, so the audio thread only links and
 * unlinks; a curve's is made from real-time memory, which the audio thread may take.
 *
 * The notes for the coming block are a list that doubles when it fills, from real-time memory.
 */
const int kFirstNoteRoom = 64;

/** The most floats one /report answer carries: every control's position and the device's own. */
const int kMaxReport = 1024;

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
    /**
     * A work round in flight for the device in this slot (see WorkJob), from the block that
     * asked until the non-realtime thread has freed what it swapped out. While it is set nothing
     * may delete that device: a unit freed meanwhile leaves it here instead, and the round's last
     * stage deletes it. Exchanged rather than read and written, so exactly one side does.
     */
    std::atomic<bool> workBusy{false};
    std::atomic<PdAny*> orphan{nullptr};

    void retain() { refs.fetch_add(1); }
    void release() {
        if (refs.fetch_sub(1) == 1) delete this;
    }
};

/**
 * One file a device holds: which control and slot it is on, and the frames themselves - malloc'd
 * on the non-realtime thread with its entry, and freed there.
 */
struct LoadedSampleNode {
    int param = -1;
    int index = -1;
    float* mono = nullptr;      // the file summed to one channel, at its own rate
    float* channels = nullptr;  // the same, interleaved; null for a mono file
    int count = 0;
    int channelCount = 1;
    int frameLength = 0;
    double sampleRate = 0.0;
    LoadedSampleNode* next = nullptr;
    ~LoadedSampleNode() {
        free(mono);
        free(channels);
    }
    PdSample file() const {
        return PdSample{ mono, channels ? channels : mono, count, channels ? channelCount : 1, sampleRate, frameLength };
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
    struct LoadedSampleNode* retiredSamples = nullptr;
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
    int frameLength = 0;        // a wavetable's declared frame length, 0 for none
    struct LoadedSampleNode* entry = nullptr;    // what stage 2 read, until stage 3 installs it
    struct LoadedSampleNode* retired = nullptr;  // what stage 3 replaced, for stage 4 to free
};

/**
 * ONE round of work off the audio thread for one device (pd-device.h's work calls).
 *
 * The device it was asked for is the one it works on, whatever happens to the slot meanwhile: a
 * device replaced mid-round is never told it finished (stage 3 checks it is still the one in the
 * slot), and a device can only be freed after the round's last stage - by FIFO order for one
 * retired by an open or a close (their freeing is queued behind this round's), and through the
 * slot's `orphan` for one whose unit was freed outright.
 */
struct WorkJob {
    DeviceSlot* slot = nullptr;
    PdAny* device = nullptr;
    bool finished = false;      // stage 3 swapped what was built in
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
            mAudioBus[i] = -1;
            mAudioGain[i] = 1.f;
            mAudioOffset[i] = 0.f;
        }
        mNotes = (NoteEvent*)RTAlloc(mWorld, sizeof(NoteEvent) * kFirstNoteRoom);
        mNoteRoom = mNotes ? kFirstNoteRoom : 0;

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
        // Freed here, on the audio thread, deliberately: the alternative is handing it to a
        // non-realtime command that may outlive the World during a server quit, and a device
        // leaked at quit is a worse trade than a free. It is a free of memory already
        // untouched - no DSP, no page faults - and this is the same choice
        // native/rubberband/PoptartPitchShift.cpp makes for its shifter.
        //
        // UNLESS a work round is still running on it, on the other thread: then it is left to the
        // round, whose last stage deletes it (WorkJob). If that stage finished between the two
        // loads, the exchange says so and it is deleted here after all.
        if (mDevice && mSlot->workBusy.load()) {
            mSlot->orphan.store(mDevice);
            if (!mSlot->workBusy.load()) delete mSlot->orphan.exchange(nullptr);
        } else {
            delete mDevice;
        }
        mSlot->release();
        // The files the device was playing, for the same reason and on the same terms.
        freeSamples(mSamples);
        freeSamples(mRetiringSamples);
        mSamples = mRetiringSamples = nullptr;
        freeShapes();
        if (mNotes) RTFree(mWorld, mNotes);
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
            // Onto whatever is already waiting to be freed, in case two swaps land before either
            // hands its leftovers on.
            LoadedSampleNode** tail = &mRetiringSamples;
            while (*tail) tail = &(*tail)->next;
            *tail = mSamples;
            mSamples = nullptr;
            // The curves too - but they are small and were allocated here, so they go here.
            freeShapes();
        }
        mNoteCount = 0;
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
            mAudioBus[i] = -1;
            mPosition[i] = (info && i < info->paramCount) ? info->params[i].defaultPosition : 0.f;
        }
        mAudioMapped = 0;
    }

    /**
     * Gives a device a file to play, and says what it replaced. Audio thread.
     *
     * Keyed by the control and the option slot together, which is how the browser keys a loaded
     * file as well: a device with two sample controls (an impulse response and a sample) holds
     * one for each, and a pattern that loaded two samples switches between them by index.
     */
    void installSample(SampleJob* job) {
        LoadedSampleNode* fresh = job->entry;
        job->entry = nullptr;
        LoadedSampleNode** at = &mSamples;
        while (*at && !((*at)->param == fresh->param && (*at)->index == fresh->index)) at = &(*at)->next;
        // The one it replaces (the same control and slot loaded again) goes back for freeing.
        if (*at) {
            fresh->next = (*at)->next;
            job->retired = *at;
            job->retired->next = nullptr;
        } else {
            fresh->next = nullptr;
        }
        *at = fresh;
        if (mDevice) mDevice->sample(fresh->param, fresh->index, fresh->file());
    }

    /**
     * A drawn curve for a control. Audio thread, from the unit command itself: a curve is a few
     * hundred floats, and the real-time allocator is the right size of tool for that. Kept, like
     * a file, so a device reopened by an evaluation is handed it again on the way in.
     */
    void installShape(int param, int index, const float* points, int count) {
        if (count <= 0) return;
        float* copy = (float*)RTAlloc(mWorld, sizeof(float) * (size_t)count);
        if (!copy) {
            Print("PoptartDevice: no real-time memory for a curve of %d points\n", count);
            return;
        }
        memcpy(copy, points, sizeof(float) * (size_t)count);
        LoadedShape* at = mShapes;
        while (at && !(at->param == param && at->index == index)) at = at->next;
        if (!at) {
            at = (LoadedShape*)RTAlloc(mWorld, sizeof(LoadedShape));
            if (!at) {
                RTFree(mWorld, copy);
                Print("PoptartDevice: no real-time memory to hold another curve\n");
                return;
            }
            *at = LoadedShape{ param, index, nullptr, 0, mShapes };
            mShapes = at;
        }
        float* old = at->table;
        at->table = copy;
        at->count = count;
        if (mDevice) mDevice->shape(param, index, copy, count);
        // The device copied it or keeps the new pointer; either way nothing reads the old one.
        if (old) RTFree(mWorld, old);
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
        for (const LoadedSampleNode* one = mSamples; one; one = one->next) mDevice->sample(one->param, one->index, one->file());
        for (const LoadedShape* one = mShapes; one; one = one->next) mDevice->shape(one->param, one->index, one->table, one->count);
    }

    /** The device the audio thread swapped out, for the caller's thread to free. */
    PdAny* takeRetiring() {
        PdAny* old = mRetiring;
        mRetiring = nullptr;
        return old;
    }

    /** And the files it was playing, for the caller's thread to free. */
    LoadedSampleNode* takeRetiringSamples() {
        LoadedSampleNode* old = mRetiringSamples;
        mRetiringSamples = nullptr;
        return old;
    }

    /**
     * The three ways a control is driven from a control bus or a value - and none of them takes
     * it off an AUDIO patch, which only an explicit unpatch (/mapa with a bus of -1) or a new
     * device in the slot does. A patch is the one driver that is wired once and then left alone,
     * and the others arrive in timestamped bundles a lookahead ahead: a release of the value the
     * pattern used to poll, landing just after the patch that replaced it, must not cut the patch.
     * While a control is patched, what these set is where it goes back to when the patch goes.
     */
    void setParam(int index, float position) {
        if (index < 0 || index >= kMaxParams) return;
        mPosition[index] = position;
        mBus[index] = -1;   // an outright set takes the control back off whatever was driving it
    }

    void mapParam(int index, int bus) {
        if (index < 0 || index >= kMaxParams) return;
        mBus[index] = bus;
    }

    /**
     * An AUDIO bus onto a control, read every sample: another track's output, or an envelope
     * running at the sample rate. `gain` and `offset` are the `.mul()` and `.add()` that rode in
     * with it, applied here so a patch needs no synth of its own - the control's position is
     * gain * signal + offset, clamped to 0..1, exactly what the browser's AudioParam makes of a
     * connection (its own value zeroed, the signal summed to mono, the sum clamped to the range).
     */
    void mapAudio(int index, int bus, float gain, float offset) {
        if (index < 0 || index >= kMaxParams) return;
        if (bus < 0) { clearAudio(index); return; }
        if (mAudioBus[index] < 0) ++mAudioMapped;
        mAudioBus[index] = bus;
        mAudioGain[index] = gain;
        mAudioOffset[index] = offset;
    }

    void unmapParam(int index) {
        if (index < 0 || index >= kMaxParams) return;
        mBus[index] = -1;
    }

    /**
     * Notes reach an instrument, and the one effect that is played by them: the ducker, whose
     * dip starts on the notes of whatever track is routed into it.
     */
    void noteOn(float note, float velocity) { queueNote(1, note, velocity); }
    void noteOff(float note) { queueNote(0, note, 0.f); }

    /**
     * A note at its place in the coming block (World's mSampleOffset, which a command performed
     * out of a timestamped bundle carries and anything else reads as 0). Every note off at once -
     * a negative note - is not a moment but a reset, and goes straight through.
     */
    void queueNote(int kind, float note, float velocity) {
        if (!mDevice || !mInfo || !mInfo->takesNotes) return;
        if (kind == 0 && note < 0) {
            mNoteCount = 0;
            mDevice->noteOff(note);
            return;
        }
        int offset = mWorld->mSampleOffset;
        if (offset < 0) offset = 0;
        if (offset >= mWorld->mBufLength) offset = mWorld->mBufLength - 1;
        if (mNoteCount >= mNoteRoom && !growNotes()) {
            // No real-time memory left to hold it in: it plays at the start of the block.
            if (kind == 1) mDevice->noteOn(note, velocity);
            else mDevice->noteOff(note);
            return;
        }
        // In time order, and in arrival order among notes at the same sample.
        int at = mNoteCount++;
        while (at > 0 && mNotes[at - 1].offset > offset) { mNotes[at] = mNotes[at - 1]; --at; }
        mNotes[at] = NoteEvent{ offset, kind, note, velocity };
    }

    /**
     * The control positions as the device last read them, and what it says it is doing: the
     * answer to /report, sent back the way an open is announced. A modulated control is where its
     * modulator has GOT TO, which nothing else in the engine can say - a modulator is a bus mapped
     * onto this UGen's input, read by nobody else.
     */
    void report(float id) {
        float* out = mReportBuf;
        int n = 0;
        out[n++] = id;
        const int count = mDevice ? mParamCount : 0;
        out[n++] = (float)count;
        for (int i = 0; i < count && n < kMaxReport - 1; ++i) out[n++] = mSeen[i];
        const int at = n++;
        const int got = mDevice ? mDevice->report(out + n, kMaxReport - n) : 0;
        out[at] = (float)got;
        n += got;
        SendNodeReply(&mParent->mNode, (int)mParentIndex, "/poptart/deviceReport", n, out);
    }

    /** Starts a work round for the device, if it wants one and none is in flight. Audio thread. */
    void maybeWork(PdAny* device);

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
    PdAny* device() const { return mDevice; }

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
        if (mAudioBus[index] >= 0) return audioPositionOf(index, 0);
        const int bus = mBus[index];
        if (bus < 0) return mPosition[index];
        const World* world = mWorld;
        if (bus >= (int)world->mNumControlBusChannels) return mPosition[index];
        return world->mControlBus[bus];
    }

    void clearAudio(int index) {
        if (mAudioBus[index] >= 0) --mAudioMapped;
        mAudioBus[index] = -1;
    }

    /**
     * One sample of an audio bus, as the mono signal a control is patched to.
     *
     * A bus nothing wrote this block reads as silence rather than as whatever is left in it -
     * scsynth does not clear a bus, it marks the block it was written in - and a track's output
     * is a stereo pair, summed to mono the way the browser sums one into an AudioParam.
     */
    float audioSample(int bus, int offset) const {
        const World* world = mWorld;
        if (bus < 0 || bus >= (int)world->mNumAudioBusChannels) return 0.f;
        const int length = world->mBufLength;
        const int32 counter = world->mBufCounter;
        const float left = world->mAudioBusTouched[bus] == counter ? world->mAudioBus[bus * length + offset] : 0.f;
        const bool hasRight = bus + 1 < (int)world->mNumAudioBusChannels;
        const float right = hasRight && world->mAudioBusTouched[bus + 1] == counter
            ? world->mAudioBus[(bus + 1) * length + offset] : 0.f;
        return 0.5f * (left + right);
    }

    /** A patched control's position at a sample of this block. */
    float audioPositionOf(int index, int offset) const {
        const float v = mAudioGain[index] * audioSample(mAudioBus[index], offset) + mAudioOffset[index];
        if (!(v > 0.f)) return 0.f;   // and a NaN, which compares false either way
        return v < 1.f ? v : 1.f;
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
            const float position = positionOf(i);
            mSeen[i] = position;
            params[i] = pd_denormalize(mInfo->params[i], position);
        }
        // With this block's controls in place, the device may ask for something to be built.
        maybeWork(device);
        // Which controls have audio patched onto them, for a device that reads them per sample.
        // A ported module reads its controls once a block on both engines, so for one of those
        // the block-start sample read above is already the whole story.
        int patched[kMaxParams];
        int patchedCount = 0;
        if (mAudioMapped > 0 && mInfo->perSample) {
            for (int i = 0; i < paramCount; ++i) if (mAudioBus[i] >= 0) patched[patchedCount++] = i;
        }

        const bool isSynth = mInfo->isSynth != 0;
        const bool sidechained = mInfo->sidechain != 0;
        const float* bendIn = in(kBendInput);
        const bool bendMoving = isSynth && inRate(kBendInput) == calc_FullRate;

        float* devIn = device->in();
        float* devOut = device->out();
        const int stride = device->maxBlock();

        const bool placesNotes = device->takesNoteOffsets();
        int nextNote = 0;
        int at = 0;
        while (at < inNumSamples) {
            int n = inNumSamples - at;
            if (n > mMaxBlock) n = mMaxBlock;
            // A moving bend is followed in short pieces so a vibrato is a curve and not a
            // staircase of blocks - the same BEND_PIECE the browser's host renders in.
            if (bendMoving && n > kBendPiece) n = kBendPiece;
            if (patchedCount > 0 && n > kPatchPiece) n = kPatchPiece;
            if (placesNotes) {
                // The device places them itself, inside the piece it is about to render.
                while (nextNote < mNoteCount && mNotes[nextNote].offset < at + n) {
                    const NoteEvent& e = mNotes[nextNote++];
                    const int offset = e.offset > at ? e.offset - at : 0;
                    if (e.kind == 1) device->noteOnAt(e.note, e.velocity, offset);
                    else device->noteOffAt(e.note, offset);
                }
            } else {
                // The notes due at this sample, then a piece only as far as the next one.
                while (nextNote < mNoteCount && mNotes[nextNote].offset <= at) {
                    const NoteEvent& e = mNotes[nextNote++];
                    if (e.kind == 1) device->noteOn(e.note, e.velocity);
                    else device->noteOff(e.note);
                }
                if (nextNote < mNoteCount && mNotes[nextNote].offset < at + n) n = mNotes[nextNote].offset - at;
            }
            // A control with audio patched onto it moves every sample, so the device is given
            // one sample at a time with that control where the signal is at that sample.
            if (patchedCount > 0) {
                if (n > kPatchPiece) n = kPatchPiece;
                for (int k = 0; k < patchedCount; ++k) {
                    const int i = patched[k];
                    const float position = audioPositionOf(i, at);
                    mSeen[i] = position;
                    params[i] = pd_denormalize(mInfo->params[i], position);
                }
            }

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
        // Anything left (a note past the block, which a clamped offset cannot be) plays now.
        for (; nextNote < mNoteCount; ++nextNote) {
            const NoteEvent& e = mNotes[nextNote];
            if (e.kind == 1) device->noteOn(e.note, e.velocity);
            else device->noteOff(e.note);
        }
        mNoteCount = 0;
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
    /** The audio bus patched onto each control (-1 for none), and the scale and offset it rides in on. */
    int mAudioBus[kMaxParams];
    float mAudioGain[kMaxParams];
    float mAudioOffset[kMaxParams];
    /** How many controls have audio patched onto them, so a block with none pays nothing. */
    int mAudioMapped = 0;
    static void freeSamples(LoadedSampleNode* list) {
        while (list) {
            LoadedSampleNode* next = list->next;
            delete list;
            list = next;
        }
    }
    LoadedSampleNode* mSamples = nullptr;          // every file this device holds
    LoadedSampleNode* mRetiringSamples = nullptr;  // a replaced device's, until a job takes them
    /** One drawn curve this device holds, in real-time memory. */
    struct LoadedShape {
        int param = -1;
        int index = -1;
        float* table = nullptr;
        int count = 0;
        LoadedShape* next = nullptr;
    };
    LoadedShape* mShapes = nullptr;
    void freeShapes() {
        while (mShapes) {
            LoadedShape* next = mShapes->next;
            if (mShapes->table) RTFree(mWorld, mShapes->table);
            RTFree(mWorld, mShapes);
            mShapes = next;
        }
    }
    /** The notes for the coming block, soonest first: room for mNoteRoom, doubled when full. */
    struct NoteEvent { int offset; int kind; float note; float velocity; };
    NoteEvent* mNotes = nullptr;
    int mNoteRoom = 0;
    int mNoteCount = 0;
    bool growNotes() {
        const int room = mNoteRoom > 0 ? mNoteRoom * 2 : kFirstNoteRoom;
        NoteEvent* more = (NoteEvent*)RTAlloc(mWorld, sizeof(NoteEvent) * (size_t)room);
        if (!more) return false;
        if (mNotes) {
            memcpy(more, mNotes, sizeof(NoteEvent) * (size_t)mNoteCount);
            RTFree(mWorld, mNotes);
        }
        mNotes = more;
        mNoteRoom = room;
        return true;
    }
    /** Each control's position as the device last read it, for /report. */
    float mSeen[kMaxParams] = { 0 };
    float mReportBuf[kMaxReport];
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
        job->retiredSamples = slot->unit->takeRetiringSamples();
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
    while (job->retiredSamples) {   // the files that device was playing
        LoadedSampleNode* next = job->retiredSamples->next;
        delete job->retiredSamples;
        job->retiredSamples = next;
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
    job->retiredSamples = self->takeRetiringSamples();
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

/** /mapa <index> <bus> <gain> <offset> ... - audio buses onto controls, read per sample; a bus of -1 unpatches. */
void cmdMapAudio(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    while (args->remain() >= 4) {
        const int index = args->geti(-1);
        const int bus = args->geti(-1);
        const float gain = args->getf(1.f);
        const float offset = args->getf(0.f);
        self->mapAudio(index, bus, gain, offset);
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
 * Non-realtime: read the file out of the server's buffer, in both the layouts a device may want
 * (PdSample): summed to one channel, and - for a file with more than one - as it is.
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
    const int channels = buf->channels;
    float* mono = (float*)malloc(sizeof(float) * (size_t)buf->frames);
    float* interleaved = channels > 1 ? (float*)malloc(sizeof(float) * (size_t)buf->frames * channels) : nullptr;
    if (!mono || (channels > 1 && !interleaved)) {
        Print("PoptartDevice: could not hold %d frames of sample\n", buf->frames);
        free(mono);
        free(interleaved);
        return true;
    }
    pd_mono_sum(buf->data, buf->frames, channels, mono);
    if (interleaved) memcpy(interleaved, buf->data, sizeof(float) * (size_t)buf->frames * channels);
    LoadedSampleNode* entry = new LoadedSampleNode();
    entry->param = job->param;
    entry->index = job->index;
    entry->mono = mono;
    entry->channels = interleaved;
    entry->channelCount = channels;
    entry->count = buf->frames;
    entry->frameLength = job->frameLength;
    entry->sampleRate = buf->samplerate > 0.0 ? buf->samplerate : job->slot->sampleRate;
    job->entry = entry;
    return true;
}

/** Audio thread: the device starts playing it, and says what it was playing before. */
bool sampleStage3(World* world, void* data) {
    (void)world;
    SampleJob* job = (SampleJob*)data;
    DeviceSlot* slot = job->slot;
    if (!slot->alive.load() || !slot->unit || !job->entry) return true;
    slot->unit->installSample(job);
    return true;
}

/** Non-realtime: free whatever is left over, whichever way it went. */
bool sampleStage4(World* world, void* data) {
    (void)world;
    SampleJob* job = (SampleJob*)data;
    delete job->entry;            // read and never installed
    delete job->retired;          // what the device was playing until stage 3
    job->entry = job->retired = nullptr;
    return true;
}

void sampleCleanup(World* world, void* data) {
    (void)world;
    SampleJob* job = (SampleJob*)data;
    job->slot->release();
    delete job;
}

/**
 * /sample <control> <optionSlot> <bufnum> [frameLength] - audio thread.
 *
 * The buffer is one sclang already read for a sample pack, so this never touches a file. The
 * generation an open claims is deliberately NOT bumped: a sample arriving must not cancel a
 * device that is still being built, and a device that arrives after its sample is handed it on
 * the way in (see openStage3). `frameLength` is the wavetable frame length the file declares,
 * which a server buffer does not keep, so the engine's Node half reads it from the file's header.
 */
void cmdSample(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    SampleJob* job = new SampleJob();
    job->slot = self->slot();
    job->slot->retain();
    job->param = args->geti(-1);
    job->index = args->geti(0);
    job->bufnum = args->geti(-1);
    job->frameLength = args->remain() > 0 ? args->geti(0) : 0;
    ft->fDoAsynchronousCommand(unit->mWorld, nullptr, "PoptartDeviceSample", (void*)job,
                               sampleStage2, sampleStage3, sampleStage4, sampleCleanup, 0, nullptr);
}

/**
 * /shape <control> <optionSlot> <point> <point> ... - a drawn curve, the points outright.
 *
 * Small enough for one message and wanting no buffer, no pack and no file: the engine samples
 * the curve exactly as the browser's engine does before posting it (SHAPE_POINTS), and the UGen
 * hands it over on the spot.
 */
void cmdShape(Unit* unit, sc_msg_iter* args) {
    PoptartDevice* self = (PoptartDevice*)unit;
    const int param = args->geti(-1);
    const int index = args->geti(0);
    float points[4096];
    int count = 0;
    while (args->remain() > 0 && count < 4096) points[count++] = args->getf(0.f);
    if (param < 0 || count == 0) return;
    self->installShape(param, index, points, count);
}

/** /report <id> - where every control is and what the device is doing, by SendNodeReply. */
void cmdReport(Unit* unit, sc_msg_iter* args) {
    ((PoptartDevice*)unit)->report(args->getf(0.f));
}

// ---- work off the audio thread, for a device that asks --------------------------------------

/** Non-realtime: the device builds what it asked for, from what it snapshotted. */
bool workStage2(World* world, void* data) {
    (void)world;
    WorkJob* job = (WorkJob*)data;
    job->device->work();
    return true;
}

/** Audio thread: swapped in - if the device is still the one in the slot. */
bool workStage3(World* world, void* data) {
    (void)world;
    WorkJob* job = (WorkJob*)data;
    DeviceSlot* slot = job->slot;
    if (slot->alive.load() && slot->unit && slot->unit->device() == job->device) {
        job->device->workDone();
        job->finished = true;
    }
    return true;
}

/**
 * Non-realtime: what was swapped out is freed, and the round is over. A device whose unit was
 * freed while this ran was left in the slot's `orphan` (see ~PoptartDevice), and goes now.
 */
bool workStage4(World* world, void* data) {
    (void)world;
    WorkJob* job = (WorkJob*)data;
    DeviceSlot* slot = job->slot;
    PdAny* orphan = slot->orphan.exchange(nullptr);
    if (job->finished || orphan == job->device) job->device->workRelease();
    slot->workBusy.store(false);
    // Taken again after the flag is down: a unit freed between the two reads left it here.
    if (!orphan) orphan = slot->orphan.exchange(nullptr);
    delete orphan;
    return true;
}

void workCleanup(World* world, void* data) {
    (void)world;
    WorkJob* job = (WorkJob*)data;
    job->slot->release();
    delete job;
}

void PoptartDevice::maybeWork(PdAny* device) {
    if (mSlot->workBusy.load()) return;
    if (!device->workWanted()) return;
    mSlot->workBusy.store(true);
    WorkJob* job = new WorkJob();
    job->slot = mSlot;
    job->device = device;
    mSlot->retain();
    ft->fDoAsynchronousCommand(mWorld, nullptr, "PoptartDeviceWork", (void*)job,
                               workStage2, workStage3, workStage4, workCleanup, 0, nullptr);
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
    DefineUnitCmd("PoptartDevice", "/mapa", cmdMapAudio);
    DefineUnitCmd("PoptartDevice", "/unmap", cmdUnmap);
    DefineUnitCmd("PoptartDevice", "/noteOn", cmdNoteOn);
    DefineUnitCmd("PoptartDevice", "/noteOff", cmdNoteOff);
    DefineUnitCmd("PoptartDevice", "/allNotesOff", cmdAllNotesOff);
    DefineUnitCmd("PoptartDevice", "/sidechain", cmdSidechain);
    DefineUnitCmd("PoptartDevice", "/noteRoute", cmdNoteRoute);
    DefineUnitCmd("PoptartDevice", "/transport", cmdTransport);
    DefineUnitCmd("PoptartDevice", "/sample", cmdSample);
    DefineUnitCmd("PoptartDevice", "/shape", cmdShape);
    DefineUnitCmd("PoptartDevice", "/report", cmdReport);
}
