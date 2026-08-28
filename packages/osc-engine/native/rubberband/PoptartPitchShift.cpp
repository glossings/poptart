// PoptartPitchShift - a real-time pitch shifter UGen for scsynth on the Rubber Band Live Shifter.
//
// This is the engine behind the DJ decks' keylock (sc/poptart.scd, poptart_songwarp_*): the deck
// plays the song repitched (a plain buffer read at `rate`) and this puts the pitch back by
// 1/rate, so a rate change moves time and not pitch - phase-vocoder quality, the way commercial
// "master tempo" features do it. The earlier in-graph SOLA player is still in poptart.scd as the
// fallback for an engine without this extension, but it is a time-domain stretcher and sounds
// like one on dense mixes.
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
        mDelay = (float)(mShifter->getStartDelay() + (size_t)mBlock);
        mFill = 0;

        // One planar scratch area: mChannels input rows then mChannels output rows, each mBlock
        // long, plus the two pointer tables shift() wants.
        const size_t floats = (size_t)mChannels * 2 * (size_t)mBlock;
        mData = (float*)RTAlloc(mWorld, floats * sizeof(float));
        mIn = (float**)RTAlloc(mWorld, sizeof(float*) * (size_t)mChannels * 2);
        if (!mData || !mIn) {
            Print("PoptartPitchShift: out of real-time memory\n");
            set_calc_function<PoptartPitchShift, &PoptartPitchShift::clear>();
            return;
        }
        memset(mData, 0, floats * sizeof(float));
        mOut = mIn + mChannels;
        for (int c = 0; c < mChannels; ++c) {
            mIn[c] = mData + (size_t)c * mBlock;
            mOut[c] = mData + (size_t)(mChannels + c) * mBlock;
        }
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
        }
        // Sample by sample so any server block size works: hand out the shifted sample sitting
        // at this slot, take the new input into the same slot, and run the shifter each time
        // the block fills. The slot is read back exactly one block later - a fixed delay of
        // mBlock on top of the shifter's own.
        for (int i = 0; i < n; ++i) {
            for (int c = 0; c < mChannels; ++c) {
                const int k = 2 + c;
                const float x = isAudioRateIn(k) ? in(k)[i] : in0(k);
                out(c)[i] = mOut[c][mFill];
                mIn[c][mFill] = x;
            }
            if (++mFill >= mBlock) {
                mShifter->shift(mIn, mOut);
                mFill = 0;
            }
        }
        float* d = out(mChannels);
        for (int i = 0; i < n; ++i) d[i] = mDelay;
    }

    RubberBand::RubberBandLiveShifter* mShifter = nullptr;
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
