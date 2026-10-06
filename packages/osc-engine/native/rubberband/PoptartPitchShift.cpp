// PoptartPitchShift - a real-time pitch shifter UGen for scsynth on the Rubber Band Live Shifter.
//
// This is the engine behind the DJ decks' keylock (sc/poptart.scd, poptart_songwarp_*): the deck
// plays the song repitched (a plain buffer read at `rate`) and this puts the pitch back by
// 1/rate, so a rate change moves time and not pitch - phase-vocoder quality, the way commercial
// "master tempo" features do it. The earlier in-graph SOLA player is still in poptart.scd as the
// fallback for an engine without this extension, but it is a time-domain stretcher and sounds
// like one on dense mixes.
//
// Two repairs sit on top of the shifter, both measured on mastered club tracks (2026-10-06):
//
//  - HIT BYPASS. A phase vocoder smears a drum hit: at any rate but exactly 1, the shifter cost
//    each hit 0.4-0.8 dB against its own tail on real tracks and 2-3 dB on a dry drum loop, the
//    same at +1% as at +6%. So the hits are not shifted at all: a detector on the incoming read
//    (which runs `delay` ahead of what is heard, so it sees every hit coming) crossfades the
//    output to the dry read - delayed to line up - from 3 ms before each hit to 8 ms after, and
//    back over 10 ms. A drum attack repitched by a few percent is inaudible; a smeared one is not.
//    Hits come back within 0.1 dB, and steady tones never trigger it. What it costs: a pad held
//    under the hits is the dry read's for those few ms, so a copy repitched by the tempo leaks in
//    at about -30 dB re the pad, under the hit that masks it. Longer windows leak more and win
//    nothing (15 + 15 ms: -25 dB, same attacks).
//  - CEILING. Mastered tracks peak just under 0 dBFS with their phases lined up by a limiter; the
//    shifter scrambles those phases and the peaks grow - up to +4.5 dB, clipping the interface
//    80-300 times in 28 s where plain playback never did. A 64-sample lookahead limiter at
//    -0.1 dBFS keeps keylocked audio no louder than the record: it does nothing to anything plain
//    playback could produce, and its lookahead is part of `delay`.
//
// Interface (see PoptartPitchShift.sc):
//   inputs:  [ratio (kr), window (ir), in0 .. inN-1 (ar)]
//   outputs: [out0 .. outN-1 (ar), delay (ar, constant)]
// `delay` is the pipeline's total delay in samples - Rubber Band's own start delay plus the
// block this UGen has to gather before it can hand the shifter a frame. It is exact and fixed
// for the life of the unit; the deck compensates for it (poptart.scd reads it once at boot with
// a probe synth and spawns keylocked players that much early).
//
// Rubber Band Library is GPL (Particular Programs Ltd). poptart is AGPL-3.0, so linking it is
// fine; the built .scx is GPL-derived. Built by build.sh from the single-file amalgamation
// (single/RubberBandSingle.cpp) with the vDSP FFT, so it has no dependencies beyond Accelerate.

#include "SC_PlugIn.hpp"
#include <algorithm>
#include <cmath>
#include "rubberband/RubberBandLiveShifter.h"

static InterfaceTable* ft;

namespace {

struct PoptartPitchShift : public SCUnit {
    PoptartPitchShift() {
        mChannels = numOutputs() - 1;
        const int window = (int)in0(1);
        const int options = RubberBand::RubberBandLiveShifter::OptionChannelsTogether
            | (window > 0 ? RubberBand::RubberBandLiveShifter::OptionWindowMedium
                          : RubberBand::RubberBandLiveShifter::OptionWindowShort);
        mShifter = new RubberBand::RubberBandLiveShifter((size_t)sampleRate(), (size_t)mChannels, options);
        mRatio = clampRatio(in0(0));
        mShifter->setPitchScale(mRatio);
        mBlock = (int)mShifter->getBlockSize();
        mDryDelay = (int)mShifter->getStartDelay() + mBlock;
        mDryTarget = mDryDelay;
        mDelay = (float)(mDryDelay + kLimitAhead);
        mFill = 0;
        mFastRel = std::exp(-1.0 / (0.002 * sampleRate()));
        mSlowRel = std::exp(-1.0 / (0.060 * sampleRate()));
        mPre = std::max(1, (int)(0.003 * sampleRate()));
        mHold = (int)(0.008 * sampleRate());
        mFade = std::max(1, (int)(0.010 * sampleRate()));
        mRefractory = (int)(0.050 * sampleRate());
        mRelease = (float)(1.0 - std::exp(-1.0 / (0.060 * sampleRate())));

        // One planar scratch area: mChannels input rows then mChannels output rows, each mBlock
        // long, plus the two pointer tables shift() wants; then the dry history (kRing per
        // channel), the limiter's lookahead (kLimitAhead + 1 per channel) and the per-sample
        // tables (the bypass gain, the limiter's needed gain and its windowed minimum).
        const size_t floats = (size_t)mChannels * 2 * (size_t)mBlock
            + (size_t)mChannels * kRing + (size_t)mChannels * kLimitLen + kRing + 2 * kLimitLen;
        mData = (float*)RTAlloc(mWorld, floats * sizeof(float));
        mIn = (float**)RTAlloc(mWorld, sizeof(float*) * (size_t)mChannels * 4);
        if (!mData || !mIn) {
            Print("PoptartPitchShift: out of real-time memory\n");
            set_calc_function<PoptartPitchShift, &PoptartPitchShift::clear>();
            return;
        }
        memset(mData, 0, floats * sizeof(float));
        mOut = mIn + mChannels;
        mDry = mIn + 2 * mChannels;
        mAhead = mIn + 3 * mChannels;
        float* p = mData;
        for (int c = 0; c < mChannels; ++c) mIn[c] = p, p += mBlock;
        for (int c = 0; c < mChannels; ++c) mOut[c] = p, p += mBlock;
        for (int c = 0; c < mChannels; ++c) mDry[c] = p, p += kRing;
        for (int c = 0; c < mChannels; ++c) mAhead[c] = p, p += kLimitLen;
        mBypass = p; p += kRing;
        mNeed = p; p += kLimitLen;
        mMinG = p;
        for (int i = 0; i < kLimitLen; ++i) mNeed[i] = mMinG[i] = 1.f;
        set_calc_function<PoptartPitchShift, &PoptartPitchShift::next>();
    }

    ~PoptartPitchShift() {
        delete mShifter;
        if (mData) RTFree(mWorld, mData);
        if (mIn) RTFree(mWorld, mIn);
    }

private:
    static float clampRatio(float r) {
        if (!(r > 0.f)) return 1.f;
        return r < 0.125f ? 0.125f : (r > 8.f ? 8.f : r);
    }

    void clear(int n) {
        for (int c = 0; c <= mChannels; ++c) {
            float* o = out(c);
            for (int i = 0; i < n; ++i) o[i] = 0.f;
        }
    }

    void next(int n) {
        const float ratio = clampRatio(in0(0));
        if (ratio != mRatio) {
            mRatio = ratio;
            mShifter->setPitchScale(ratio);
            // The shifter's own delay moves a little with the ratio (2112 samples at 1, 2205 at
            // 1/1.08 at 44.1k) - the dry read follows it, a sample at a time (see below).
            mDryTarget = (int)mShifter->getStartDelay() + mBlock;
        }
        // Sample by sample so any server block size works: hand out the shifted sample sitting
        // at this slot, take the new input into the same slot, and run the shifter each time
        // the block fills. The slot is read back exactly one block later - a fixed delay of
        // mBlock on top of the shifter's own.
        for (int i = 0; i < n; ++i) {
            // Slewed, never jumped: a jump in the dry read mid-bypass would click.
            if (mDryDelay != mDryTarget && (mClock & 31) == 0) mDryDelay += mDryTarget > mDryDelay ? 1 : -1;
            const int now = (int)(mClock & (kRing - 1));
            const int dryAt = (int)((mClock - mDryDelay) & (kRing - 1));
            const float g = mBypass[now];
            mBypass[now] = 0.f;
            const float th = g * 1.5707963f, gs = std::cos(th), gd = std::sin(th);
            float mono = 0.f;
            float peak = 0.f;
            const int ahead = (int)(mClock % kLimitLen);
            for (int c = 0; c < mChannels; ++c) {
                const int k = 2 + c;
                const float x = isAudioRateIn(k) ? in(k)[i] : in0(k);
                const float mixed = gs * mOut[c][mFill] + gd * mDry[c][dryAt];
                mIn[c][mFill] = x;
                mDry[c][now] = x;
                mono += x;
                mAhead[c][ahead] = mixed;
                peak = std::max(peak, std::fabs(mixed));
            }
            detect(mono / (float)mChannels);
            limit(i, peak, ahead);
            ++mClock;
            if (++mFill >= mBlock) {
                mShifter->shift(mIn, mOut);
                mFill = 0;
            }
        }
        float* d = out(mChannels);
        for (int i = 0; i < n; ++i) d[i] = mDelay;
    }

    // A hit on the incoming read: a fast envelope of its first difference (the high end, where a
    // hit stands out over the bass) jumping well past a slow one. Its bypass is written into the
    // per-sample gain table where it will be HEARD - mDryDelay from now - so the crossfade can
    // start before the hit does.
    void detect(float x) {
        const double d = std::fabs((double)x - mPrev);
        mPrev = x;
        mFast = d > mFast ? d : mFast * mFastRel;
        mSlow = d > mSlow ? mSlow + (d - mSlow) * 0.002 : mSlow * mSlowRel + d * (1.0 - mSlowRel);
        if (mClock - mLastHit < mRefractory || !(mFast > 3.0 * mSlow && mFast > 0.01)) return;
        mLastHit = mClock;
        const long long at = mClock + mDryDelay;
        for (int j = -mPre; j < mHold + mFade; ++j) {
            const float g = j < 0 ? (float)(j + mPre) / (float)mPre
                : j < mHold ? 1.f : 1.f - (float)(j - mHold) / (float)mFade;
            float& slot = mBypass[(int)((at + j) & (kRing - 1))];
            if (g > slot) slot = g;
        }
    }

    // The ceiling: the gain each sample needs, its minimum over the lookahead, box-averaged over
    // the same span - a ramp that reaches the minimum exactly when the peak comes out - with a
    // 60 ms release. Writes the output sample from kLimitAhead samples ago.
    void limit(int i, float peak, int ahead) {
        const int at = (int)(mClock % kLimitLen);
        mNeed[at] = peak > kCeiling ? kCeiling / peak : 1.f;
        float mn = 1.f;
        for (int j = 0; j < kLimitLen; ++j) mn = std::min(mn, mNeed[j]);
        mMinSum += (double)mn - (double)mMinG[at];
        mMinG[at] = mn;
        const float avg = (float)(mMinSum / kLimitLen);
        mLimitGain = avg < mLimitGain ? avg : std::min(avg, mLimitGain + (1.f - mLimitGain) * mRelease);
        const int from = (int)((mClock + 1) % kLimitLen); // kLimitAhead samples ago
        for (int c = 0; c < mChannels; ++c) out(c)[i] = mAhead[c][from] * mLimitGain;
        (void)ahead;
    }

    static constexpr int kRing = 16384;     // dry history + bypass schedule (> delay + a hit's span, at 96k too)
    static constexpr int kLimitLen = 64;    // limiter window
    static constexpr int kLimitAhead = kLimitLen - 1;
    static constexpr float kCeiling = 0.989f; // -0.1 dBFS

    RubberBand::RubberBandLiveShifter* mShifter = nullptr;
    float** mDry = nullptr;
    float** mAhead = nullptr;
    float* mBypass = nullptr;
    float* mNeed = nullptr;
    float* mMinG = nullptr;
    long long mClock = 0;
    long long mLastHit = -(1LL << 40);
    int mDryDelay = 0, mDryTarget = 0;
    int mPre = 1, mHold = 0, mFade = 1, mRefractory = 0;
    double mFast = 0, mSlow = 0, mPrev = 0, mFastRel = 0, mSlowRel = 0, mMinSum = kLimitLen;
    float mLimitGain = 1.f;
    float mRelease = 0.f;
    float* mData = nullptr;
    float** mIn = nullptr;
    float** mOut = nullptr;
    int mChannels = 0;
    int mBlock = 0;
    int mFill = 0;
    float mRatio = 1.f;
    float mDelay = 0.f;
};

} // namespace

PluginLoad(PoptartPitchShiftUGens) {
    ft = inTable;
    registerUnit<PoptartPitchShift>(ft, "PoptartPitchShift");
}
