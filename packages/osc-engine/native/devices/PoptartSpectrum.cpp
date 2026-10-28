// PoptartSpectrum: the mixer's band analyzer on the desktop, the same measurement the browser's
// takes (web-engine/src/engine/analysis.mjs).
//
// The browser reads four AnalyserNodes - left, right, mid (L+R)/2 and side (L-R)/2 - at a 4096
// point transform with no smoothing, and averages each band's bins as magnitudes. This does the
// same arithmetic: the last 4096 samples of each signal, a Blackman window (the Web Audio spec's,
// alpha 0.16), a transform, each bin's magnitude over the transform's length, and per band the
// mean over the bins between its neighbors' geometric midpoints - so a strip draws the same
// picture on either engine. A frame goes out `rate` times a second as a node reply, laid out
// [l, r, mid, side] per band, which is what the engine's mixer forwards.
//
// Inputs: left, right, rate, then the band centers in Hz. The transform runs on the block a frame
// is due in; between frames the unit only copies samples into its history, so a tapped track
// costs a ring buffer and four transforms twenty times a second.

#include "SC_PlugIn.hpp"

#include <cmath>
#include <cstring>

static InterfaceTable* ft;

namespace {

const int kSize = 4096;
const int kHalf = kSize / 2;
const int kSignals = 4; // left, right, mid, side

/** In-place iterative radix-2 transform of `re`/`im`, length kSize. */
void transform(double* re, double* im) {
    for (int i = 1, j = 0; i < kSize; ++i) {
        int bit = kSize >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); }
    }
    for (int len = 2; len <= kSize; len <<= 1) {
        const double ang = -2.0 * M_PI / len;
        const double wr = std::cos(ang), wi = std::sin(ang);
        for (int i = 0; i < kSize; i += len) {
            double cr = 1.0, ci = 0.0;
            for (int k = 0; k < len / 2; ++k) {
                const int a = i + k, b = a + len / 2;
                const double tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
                const double nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
    }
}

} // namespace

struct PoptartSpectrum : public SCUnit {
    PoptartSpectrum() {
        mBands = numInputs() - 3;
        if (mBands < 0) mBands = 0;
        const size_t floats = (size_t)kSize * 2 + (size_t)kSize            // history L, R; window
            + (size_t)kSize * 2                                            // re, im (as doubles: 2 floats each)
            + (size_t)mBands * 2 + (size_t)mBands * kSignals + 1;          // bins, the frame
        mMemory = (float*)RTAlloc(mWorld, sizeof(float) * floats + sizeof(double) * (size_t)kSize * 2);
        if (!mMemory) { set_calc_function<PoptartSpectrum, &PoptartSpectrum::idle>(); return; }
        float* at = mMemory;
        mHistL = at; at += kSize;
        mHistR = at; at += kSize;
        mWindow = at; at += kSize;
        mFrom = (int*)at; at += mBands;
        mTo = (int*)at; at += mBands;
        mFrame = at; at += (size_t)mBands * kSignals + 1;
        mRe = (double*)(((uintptr_t)at + 7) & ~(uintptr_t)7);
        mIm = mRe + kSize;
        std::memset(mHistL, 0, sizeof(float) * kSize);
        std::memset(mHistR, 0, sizeof(float) * kSize);
        // The Web Audio spec's Blackman window.
        const double a0 = 0.42, a1 = 0.5, a2 = 0.08;
        for (int n = 0; n < kSize; ++n) {
            const double x = (double)n / kSize;
            mWindow[n] = (float)(a0 - a1 * std::cos(2 * M_PI * x) + a2 * std::cos(4 * M_PI * x));
        }
        // Each band's bins: between its neighbors' geometric midpoints, at least one.
        const double binHz = sampleRate() / kSize;
        auto freq = [this](int b) { return (double)in0(3 + b); };
        for (int b = 0; b < mBands; ++b) {
            const double hz = freq(b);
            // As the browser's bandBins: the first and last band reach as far past their center as
            // their neighbor is on the other side.
            const double below = b == 0 ? (mBands > 1 ? hz * (freq(0) / freq(1)) : hz / 2) : freq(b - 1);
            const double above = b == mBands - 1 ? (mBands > 1 ? hz * (freq(b) / freq(b - 1)) : hz * 2) : freq(b + 1);
            const int from = std::max(0, (int)std::lround(std::sqrt(hz * below) / binHz));
            const int to = std::max(from + 1, (int)std::lround(std::sqrt(hz * above) / binHz));
            mFrom[b] = from;
            mTo[b] = std::min(to, kHalf);
        }
        const double rate = std::max(1.0, (double)in0(2));
        mPeriod = std::max(1, (int)(sampleRate() / rate));
        set_calc_function<PoptartSpectrum, &PoptartSpectrum::next>();
    }

    ~PoptartSpectrum() {
        if (mMemory) RTFree(mWorld, mMemory);
    }

    void idle(int) {}

    void next(int inNumSamples) {
        const float* l = in(0);
        const float* r = in(1);
        for (int i = 0; i < inNumSamples; ++i) {
            mHistL[mWrite] = l[i];
            mHistR[mWrite] = r[i];
            mWrite = (mWrite + 1) % kSize;
        }
        mSince += inNumSamples;
        if (mSince < mPeriod) return;
        mSince = 0;
        for (int s = 0; s < kSignals; ++s) {
            for (int n = 0; n < kSize; ++n) {
                const int at = (mWrite + n) % kSize;
                const double x = s == 0 ? mHistL[at] : s == 1 ? mHistR[at]
                    : s == 2 ? 0.5 * (mHistL[at] + mHistR[at]) : 0.5 * (mHistL[at] - mHistR[at]);
                mRe[n] = x * mWindow[n];
                mIm[n] = 0.0;
            }
            transform(mRe, mIm);
            for (int b = 0; b < mBands; ++b) {
                double sum = 0.0;
                for (int k = mFrom[b]; k < mTo[b]; ++k) sum += std::hypot(mRe[k], mIm[k]) / kSize;
                mFrame[b * kSignals + s] = (float)(sum / (mTo[b] - mFrom[b]));
            }
        }
        SendNodeReply(&mParent->mNode, (int)mParentIndex, "/poptart/mixSpec", mBands * kSignals, mFrame);
    }

    float* mMemory = nullptr;
    float* mHistL = nullptr;
    float* mHistR = nullptr;
    float* mWindow = nullptr;
    int* mFrom = nullptr;
    int* mTo = nullptr;
    float* mFrame = nullptr;
    double* mRe = nullptr;
    double* mIm = nullptr;
    int mBands = 0;
    int mWrite = 0;
    int mSince = 0;
    int mPeriod = 2400;
};

// Called from PoptartDevice.cpp's PluginLoad: one bundle has one load entry point.
void registerPoptartSpectrum(InterfaceTable* table) {
    ft = table;
    registerUnit<PoptartSpectrum>(ft, "PoptartSpectrum", false);
}
