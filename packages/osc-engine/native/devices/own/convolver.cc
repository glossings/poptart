// The Convolver: a convolution reverb - five synthesized spaces, or any sample as the response.
//
// THIS IS THE ONE DEVICE WITH NOTHING TO TRANSLATE. Every other device here is a line-for-line
// port of a JavaScript processor; the browser's convolver is a graph of stock Web Audio nodes
// (web-engine/src/devices/builtins.mjs: a delay, a ConvolverNode, two BiquadFilterNodes and two
// gains), and a stock node is Chromium's code rather than poptart's. So what this has to agree
// with is CHROMIUM, and Chromium is readable:
//
//   - the convolution, and the gain a normalized response is given:
//     third_party/blink/renderer/platform/audio/reverb.cc (CalculateNormalizationScale: the
//     response's RMS power inverted, a -58 dB calibration, and 44100 over the sample rate) and
//     reverb_convolver.cc. Both are in own/dsp/convolve.h, with the citation.
//   - the delay: Delay::ProcessARate writes the sample, then reads `delayTime * sampleRate`
//     frames back with linear interpolation between the two neighbors - so a delay of nothing
//     passes the sample through, which is the behavior predelay 0 has to have.
//   - the filters: BiquadFilterNode's lowpass and highpass are the cookbook sections poptart's
//     own biquad already builds, with ONE difference that matters - Web Audio's Q is in DECIBELS
//     for those two types (Blink's biquad.cc: `resonance = pow10(resonance / 20)`), and the
//     node's default Q is 1, which is 1.122 as a plain Q. That number is below.
//
// The five SPACES are poptart's own, though: synthesizeImpulse in builtins.mjs, which is plain
// JavaScript and is ported here sample for sample - the test compares the responses themselves,
// not just the sound of them.
//
// What is not the same as the browser, both written down in TODO.md: a loaded stereo file is
// summed to one channel on the way in (the host's sample path hands a device mono frames), where
// the browser convolves each side with its own channel; and the response is laid out on the
// audio thread when the space changes, which costs a millisecond or two of a block's deadline
// once per change (the partitions big enough to be expensive are built over the blocks that
// follow instead - see Convolver::prepare).

#include "own/pd-own.h"
#include "own/dsp/biquad.h"
#include "own/dsp/convolve.h"
#include "pd-own-ids.h"

#include <cmath>
#include <cstring>
#include <vector>

namespace pd_Convolver {

namespace ids = pd_ids::Convolver;
using namespace pd_own;

/** The spaces, in the order the control's option list has them. */
enum { kRoom = 0, kHall, kPlate, kChamber, kCathedral, kSpaceCount };

/** How many responses the device can hold. The browser's option list has room for this many. */
constexpr int kSlots = 32;

/** As long a response as a space is ever built with: six seconds of the longest tail. */
constexpr double kMaxSeconds = 6.0 * 2.6 + 0.5;

/**
 * A BiquadFilterNode's default Q, as a plain Q.
 *
 * Web Audio takes Q in decibels for a lowpass and a highpass, and the node's default is 1 dB.
 * Reading that 1 as a plain Q - which is what every other filter in poptart means by it - would
 * put the corner 1 dB out and make both filters slightly the wrong shape.
 */
const double kNodeQ = std::pow(10.0, 1.0 / 20.0);

/** One space's shape, as builtins.mjs describes it. */
struct Space {
  double early;
  double tail;
  double bright;
  double diffuse;
};

inline Space spaceOf(int which) {
  switch (which) {
    case kRoom:      return { 0.02, 0.6, 0.5, 0.9 };
    case kPlate:     return { 0.002, 1.0, 0.8, 1.0 };
    case kChamber:   return { 0.03, 0.9, 0.45, 0.7 };
    case kCathedral: return { 0.09, 2.6, 0.25, 1.0 };
    default:         return { 0.05, 1.6, 0.35, 1.0 };   // hall, and anything unnamed
  }
}

/** The browser's own noise, for the spaces: xorshift32, every shift unsigned, over -1..1. */
struct ImpulseNoise {
  unsigned int state = 1;
  void seed(int which) { state = toUint32(0x1234567 + (double)which * 977.0); }
  double next() {
    unsigned int x = state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    state = x;
    return static_cast<double>(x) / 2147483648.0 - 1.0;
  }
};

/**
 * One of the five spaces: noise falling away exponentially, its top rolling off as it goes, with
 * an early cluster of reflections in front. Translated from synthesizeImpulse.
 *
 * Both channels come off ONE run of the noise, the left channel's whole length before the
 * right's - so the two sides differ, and they differ in exactly the way the browser's do.
 */
inline void synthesizeImpulse(int which, double seconds, double sampleRate,
                              std::vector<float>& left, std::vector<float>& right) {
  const Space shape = spaceOf(which);
  const int length = static_cast<int>(std::fmax(1.0, jsRound(sampleRate * std::fmax(0.1, seconds * shape.tail))));
  left.assign(static_cast<size_t>(length), 0.f);
  right.assign(static_cast<size_t>(length), 0.f);
  ImpulseNoise noise;
  noise.seed(which >= 0 && which < kSpaceCount ? which : kHall);
  const int earlyEnd = static_cast<int>(jsRound(shape.early * sampleRate));
  const int every = static_cast<int>(std::fmax(1.0, jsRound(static_cast<double>(earlyEnd) / 12.0)));
  for (int ch = 0; ch < 2; ++ch) {
    std::vector<float>& data = ch == 0 ? left : right;
    double lp = 0;
    for (int i = 0; i < length; ++i) {
      const double t = static_cast<double>(i) / length;
      // The tail's brightness falls with time: the lowpass tightens as the decay goes on.
      const double cutoff = shape.bright * (1 - 0.8 * t) + 0.02;
      lp += (noise.next() - lp) * cutoff;
      const double env = std::exp(-6.9 * t);
      double v = lp * env * shape.diffuse;
      // A few discrete early reflections, denser in a small room.
      if (i < earlyEnd && (i % every) == 0) v += noise.next() * 0.5 * (1 - static_cast<double>(i) / earlyEnd);
      data[static_cast<size_t>(i)] = static_cast<float>(v);
    }
  }
}

/** Blink's Delay, which is what a predelay of nothing passing straight through depends on. */
struct Predelay {
  std::vector<double> buf;
  int at = 0;

  void init(double sampleRate) {
    // createDelay(0.3) in the browser: the longest delay the node will take.
    buf.assign(static_cast<size_t>(std::fmax(2.0, jsRound(0.3 * sampleRate)) + 2), 0.0);
    at = 0;
  }

  double process(double x, double frames) {
    const int length = static_cast<int>(buf.size());
    const double want = clamp(frames, 0.0, static_cast<double>(length) - 1.0);
    buf[static_cast<size_t>(at)] = x;
    double read = static_cast<double>(at) + length - want;
    while (read >= length) read -= length;
    const int i1 = static_cast<int>(read);
    const double frac = read - i1;
    const int i2 = (i1 + 1) % length;
    if (++at >= length) at = 0;
    const double a = buf[static_cast<size_t>(i1)];
    const double b = buf[static_cast<size_t>(i2)];
    return a + frac * (b - a);
  }
};

struct Device : pd_own::Device<ids::kCount, 2> {
  /** A response held by the device: one channel per side, already normalized. */
  struct Held {
    std::vector<float> left, right;
    bool loaded = false;     // a file, rather than one of the spaces
  };

  Held slots[kSlots];
  Convolver convL, convR;
  Predelay preL, preR;
  Biquad cutL, cutR, dampL, dampR;

  int builtIndex = -1;
  double builtSize = -1;
  bool builtWasLoaded = false;

  void pd_init(double sr) {
    sampleRate = sr;
    preL.init(sr);
    preR.init(sr);
    cutL.reset();
    cutR.reset();
    dampL.reset();
    dampR.reset();
    builtIndex = -1;
    builtSize = -1;
    builtWasLoaded = false;
  }

  /**
   * A file to convolve with, in place of a space.
   *
   * Mono, which is the sample path's doing rather than this device's (see the file comment). It
   * is normalized here, as Chromium normalizes a response when it is set rather than when it is
   * played.
   */
  void pd_sample(int param, int slot, const float* data, int frames, double rate) {
    (void)rate;
    if (param != ids::ir) return;
    if (slot < 0 || slot >= kSlots || !data || frames <= 0) return;
    Held& held = slots[slot];
    held.left.assign(data, data + frames);
    held.right = held.left;
    held.loaded = true;
    normalize(held);
    if (builtIndex == slot) builtIndex = -1;   // rebuild: this is what is playing
  }

  /** Chromium's own gain for a normalized response, applied to the response itself. */
  void normalize(Held& held) {
    const float* channels[2] = { held.left.data(), held.right.data() };
    const double scale = convolverNormalizationScale(channels, 2, static_cast<int>(held.left.size()), sampleRate);
    for (auto& v : held.left) v = static_cast<float>(v * scale);
    for (auto& v : held.right) v = static_cast<float>(v * scale);
  }

  /** Lays the response out for the convolvers. Audio thread; see the file comment on the cost. */
  void choose(int which, double seconds) {
    Held& held = slots[which >= 0 && which < kSlots ? which : 0];
    if (!held.loaded) {
      synthesizeImpulse(which, seconds, sampleRate, held.left, held.right);
      normalize(held);
    }
    if (held.left.empty()) return;
    convL.prepare(held.left.data(), static_cast<int>(held.left.size()));
    convR.prepare(held.right.data(), static_cast<int>(held.right.size()));
    builtIndex = which;
    builtSize = seconds;
    builtWasLoaded = held.loaded;
  }

  void pd_process(int frames) {
    const int which = clamp(jsRoundInt(p[ids::ir]), 0, kSlots - 1);
    const double seconds = clamp(p[ids::size], 0.3, kMaxSeconds);
    const double predelayFrames = clamp(p[ids::predelay], 0.0, 0.3) * sampleRate;
    const double mix = p[ids::mix];
    const double out = dbToGain(p[ids::output]);
    // A space is rebuilt when it changes, and when its LENGTH changes - but a loaded file has a
    // length of its own and ignores the size control, exactly as the browser's does.
    const bool sizeMatters = !slots[which].loaded;
    if (which != builtIndex || (sizeMatters && seconds != builtSize) || builtWasLoaded != slots[which].loaded) {
      choose(which, seconds);
    }
    cutL.set(kHighPass, p[ids::lowcut], 0, kNodeQ, sampleRate);
    cutR.set(kHighPass, p[ids::lowcut], 0, kNodeQ, sampleRate);
    dampL.set(kLowPass, p[ids::damping], 0, kNodeQ, sampleRate);
    dampR.set(kLowPass, p[ids::damping], 0, kNodeQ, sampleRate);

    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    const bool ready = convL.ready();
    for (int i = 0; i < frames; ++i) {
      const double dryl = inl[i];
      const double dryr = inr[i];
      double wetl = 0;
      double wetr = 0;
      if (ready) {
        wetl = convL.process(preL.process(dryl, predelayFrames));
        wetr = convR.process(preR.process(dryr, predelayFrames));
        wetl = dampL.next(cutL.next(wetl));
        wetr = dampR.next(cutR.next(wetr));
      }
      // The dry gain is 1 and the mix is the WET gain, which is the browser's graph: a mix of
      // 0.3 is the whole dry signal with three tenths of the reverb over it, not a crossfade.
      outl[i] = static_cast<float>((dryl + wetl * mix) * out);
      outr[i] = static_cast<float>((dryr + wetr * mix) * out);
    }
    // Whatever is left of a long response's tail, a partition at a time.
    convL.advance();
    convR.advance();
  }
};

}  // namespace pd_Convolver

extern "C" PdAny* pd_make_Convolver() { return new PdAdapter<pd_Convolver::Device>(); }
