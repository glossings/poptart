// PoptartKeylock - the DJ decks' keylock as a scsynth UGen: a song buffer read at any rate with
// its pitch held.
//
// The stretcher is native/devices/own/dsp/keylock.h, the C++ translation of the browser's
// web-engine/src/dsp/keylock.mjs (native-device-parity.test.mjs holds the two to the same
// output): a phase vocoder below 1.9 kHz and WSOLA above it, held under a -0.1 dBFS ceiling by a
// lookahead limiter the stretcher runs ahead of. Like PlayBuf, this reads the buffer
// itself and owns its playhead, so it adds no latency - the deck hears the song where the
// playhead is.
//
// A trigger moves the playhead to startPos, crossfading the old position out under the new one
// over SONG_FADE_SEC (5 ms, linear), as the browser's song reader does. The playhead starts on
// startPos with the first block, so the trigger a player is spawned with does not crossfade.
//
// Interface (see PoptartKeylock.sc):
//   inputs:  [bufnum (kr), rate (kr), trigger (kr), startPos (kr)]
//   outputs: numChannels, which must be the buffer's channel count (otherwise silence)
// `rate` is song seconds per second: 1 is the record's own speed whatever the buffer's sample
// rate (BufRateScale is applied here).

#include "SC_PlugIn.hpp"

#include "own/dsp/keylock.h"

static InterfaceTable* ft;

namespace {

/** The crossfade a seek is made with: the song reader's SONG_FADE_SEC. */
constexpr double kFadeSec = 0.005;

struct PoptartKeylock : public SCUnit {
    PoptartKeylock() {
        mChannels = numOutputs();
        if (mChannels < 1 || mChannels > 2) {
            set_calc_function<PoptartKeylock, &PoptartKeylock::clear>();
            clear(1);
            return;
        }
        const int fade = (int)std::floor(kFadeSec * sampleRate() + 0.5);
        mPlayer = new pd_own::KeylockPlayer(sampleRate(), mChannels, fade);
        mPrevTrig = in0(2);
        mStarted = false;
        // set_calc_function runs next() for one sample, for the initial output: that one is
        // silence and moves nothing, so the playhead starts with the first block, on startPos.
        mPrimed = false;
        set_calc_function<PoptartKeylock, &PoptartKeylock::next>();
        mPrimed = true;
    }

    ~PoptartKeylock() { delete mPlayer; }

private:
    void clear(int n) {
        for (int c = 0; c < numOutputs(); ++c) {
            float* o = out(c);
            for (int i = 0; i < n; ++i) o[i] = 0.f;
        }
    }

    const SndBuf* buffer() {
        const float fbufnum = in0(0);
        if (fbufnum != mFbufnum) {
            uint32 bufnum = fbufnum < 0.f ? 0 : (uint32)fbufnum;
            if (bufnum >= mWorld->mNumSndBufs) bufnum = 0;
            mFbufnum = fbufnum;
            mBuf = mWorld->mSndBufs + bufnum;
        }
        return mBuf;
    }

    void next(int n) {
        if (!mPrimed) {
            clear(n);
            return;
        }
        const SndBuf* buf = buffer();
        LOCK_SNDBUF_SHARED(buf);
        if (!buf || !buf->data || buf->channels != mChannels || buf->frames <= 0) {
            clear(n);
            return;
        }
        mPlayer->setSource(buf->data, buf->frames, buf->channels, 1, buf->samplerate / sampleRate());
        const float trig = in0(2);
        if (!mStarted) {
            mPlayer->start(in0(3));
            mStarted = true;
        } else if (trig > 0.f && mPrevTrig <= 0.f) {
            mPlayer->seek(in0(3));
        }
        mPrevTrig = trig;
        float* outs[2] = { out(0), mChannels > 1 ? out(1) : nullptr };
        mPlayer->process(outs, n, (double)in0(1));
    }

    pd_own::KeylockPlayer* mPlayer = nullptr;
    int mChannels = 0;
    float mFbufnum = -1e9f;
    SndBuf* mBuf = nullptr;
    float mPrevTrig = 0.f;
    bool mStarted = false;
    bool mPrimed = false;
};

// PoptartStretch - a sampler voice's stretch (.stretch(), and .fit()/.splice() in "stretch" mode,
// under .stretchmode("clean")): the same stretcher as the keylock, through keylock.h's
// KeylockVoice - a window of the buffer read from startPos at `rate`, transposed by `pitch`, a
// loop's corners crossfaded over 5 ms.
//
// Interface (see PoptartKeylock.sc):
//   inputs:  [bufnum (ir), rate (ir), pitch (kr), startPos (ir), loop (ir), loopLo (ir),
//             loopHi (ir), pingpong (ir)]
//   outputs: numChannels, which must be the buffer's channel count (otherwise silence)
// `rate` is file seconds per second, signed; loopLo/loopHi and startPos are in frames.
//
// Voices come and go with every event, and a stretcher is a few hundred kilobytes of rings and
// tables: so each one is taken from a pool on the server's own thread and handed back when the
// voice is freed, and only a voice past the most that were ever sounding at once allocates.

struct StretchPool {
    double sampleRate = 0;
    int channels = 0;
    std::vector<pd_own::KeylockVoice*> free;
};

/** One pool per (rate, channels) pair; scsynth runs one of each at a time, so a handful at most. */
static std::vector<StretchPool> gStretchPools;

static StretchPool& stretchPool(double sampleRate, int channels) {
    for (auto& p : gStretchPools) if (p.sampleRate == sampleRate && p.channels == channels) return p;
    gStretchPools.push_back(StretchPool { sampleRate, channels, {} });
    return gStretchPools.back();
}

struct PoptartStretch : public SCUnit {
    PoptartStretch() {
        mChannels = numOutputs();
        if (mChannels < 1 || mChannels > 2) {
            set_calc_function<PoptartStretch, &PoptartStretch::clear>();
            clear(1);
            return;
        }
        StretchPool& pool = stretchPool(sampleRate(), mChannels);
        if (!pool.free.empty()) {
            mVoice = pool.free.back();
            pool.free.pop_back();
        } else {
            mVoice = new pd_own::KeylockVoice(sampleRate(), mChannels);
        }
        mStarted = false;
        mPrimed = false;
        set_calc_function<PoptartStretch, &PoptartStretch::next>();
        mPrimed = true;
    }

    ~PoptartStretch() {
        if (mVoice) stretchPool(sampleRate(), mChannels).free.push_back(mVoice);
    }

private:
    void clear(int n) {
        for (int c = 0; c < numOutputs(); ++c) {
            float* o = out(c);
            for (int i = 0; i < n; ++i) o[i] = 0.f;
        }
    }

    void next(int n) {
        if (!mPrimed) {
            clear(n);
            return;
        }
        const float fbufnum = in0(0);
        uint32 bufnum = fbufnum < 0.f ? 0 : (uint32)fbufnum;
        if (bufnum >= mWorld->mNumSndBufs) bufnum = 0;
        const SndBuf* buf = mWorld->mSndBufs + bufnum;
        LOCK_SNDBUF_SHARED(buf);
        if (!buf->data || buf->channels != mChannels || buf->frames <= 0) {
            clear(n);
            return;
        }
        mVoice->setSource(buf->data, buf->frames, buf->channels, 1, buf->samplerate / sampleRate());
        if (!mStarted) {
            mVoice->start(in0(3), in0(1), in0(4) > 0.5f, in0(5), in0(6), in0(7) > 0.5f);
            mStarted = true;
        }
        float* outs[2] = { out(0), mChannels > 1 ? out(1) : nullptr };
        mVoice->process(outs, n, (double)in0(2));
    }

    pd_own::KeylockVoice* mVoice = nullptr;
    int mChannels = 0;
    bool mStarted = false;
    bool mPrimed = false;
};

} // namespace

PluginLoad(PoptartKeylockUGens) {
    ft = inTable;
    registerUnit<PoptartKeylock>(ft, "PoptartKeylock");
    registerUnit<PoptartStretch>(ft, "PoptartStretch");
}
