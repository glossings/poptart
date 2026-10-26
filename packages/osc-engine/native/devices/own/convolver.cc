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
// A loaded file keeps its two sides apart, as the browser's convolver does, and is brought to the
// engine's rate first. The response is laid out OFF the audio thread, through the work calls
// (pd-device.h): a space chosen by a knob turn goes on sounding as the old one until the new one
// is ready, every partition of it, a few milliseconds later.

#include "own/pd-own.h"
#include "own/dsp/biquad.h"
#include "own/dsp/convolve.h"
#include "pd-own-ids.h"

#include <cmath>
#include <cstring>
#include <utility>
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
  /** A file handed over for a slot: the host's frames, which this only points at. */
  struct Source {
    const float* channels = nullptr;   // interleaved, `channelCount` of them
    int frames = 0;
    int channelCount = 0;
    double rate = 0;
  };
  Source sources[kSlots];
  /** Bumped by every file handed over, so a slot refilled while it plays is rebuilt. */
  unsigned sourceId[kSlots] = { 0 };
  unsigned nextSourceId = 0;

  /** The response playing. */
  Convolver convL, convR;
  Predelay preL, preR;
  Biquad cutL, cutR, dampL, dampR;

  /** What was last asked for, so a block that asks for the same again asks for nothing. */
  int askedIndex = -1;
  double askedSize = -1;
  bool askedLoaded = false;
  unsigned askedSource = 0;

  /** The round in flight: what work() builds from, and what it builds into. */
  struct Request { int which = 0; double seconds = 0; Source source; };
  Request request;
  Convolver nextL, nextR;

  void pd_init(double sr) {
    sampleRate = sr;
    preL.init(sr);
    preR.init(sr);
    cutL.reset();
    cutR.reset();
    dampL.reset();
    dampR.reset();
    askedIndex = -1;
    askedSize = -1;
    askedLoaded = false;
    askedSource = 0;
  }

  /**
   * A file to convolve with, in place of a space. Audio thread: only the pointers are kept, and
   * the response is laid out in work(). Both sides of a stereo file are kept apart, as the
   * browser's convolver keeps them: each channel of the input is convolved with its own side.
   */
  void pd_sample(int param, int slot, const PdSample& file) {
    if (param != ids::ir) return;
    if (slot < 0 || slot >= kSlots || !file.channels || file.frames <= 0 || file.channelCount <= 0) return;
    sources[slot] = Source{ file.channels, file.frames, file.channelCount, file.sampleRate > 0 ? file.sampleRate : sampleRate };
    sourceId[slot] = ++nextSourceId;
  }

  /**
   * A new response when the space changes, when a synthesized space's LENGTH changes - a loaded
   * file has a length of its own and ignores the size control, as the browser's does - and when
   * the file in the slot playing is replaced.
   */
  bool pd_work_wanted() {
    const int which = clamp(jsRoundInt(p[ids::ir]), 0, kSlots - 1);
    const double seconds = clamp(p[ids::size], 0.3, kMaxSeconds);
    const bool loaded = sources[which].channels != nullptr;
    const bool same = which == askedIndex && loaded == askedLoaded
        && (loaded ? sourceId[which] == askedSource : seconds == askedSize);
    if (same) return false;
    askedIndex = which;
    askedSize = seconds;
    askedLoaded = loaded;
    askedSource = sourceId[which];
    request = Request{ which, seconds, sources[which] };
    return true;
  }

  /**
   * Lays the response out: a file's channels at the engine's rate, or a space synthesized; then
   * normalized as Chromium normalizes a response when it is set, and every partition transformed.
   * The non-realtime thread, so the whole of a six-second tail is ready on the block it arrives.
   */
  void pd_work() {
    std::vector<float> left, right;
    const Source& src = request.source;
    if (src.channels) {
      // The browser's bufferFromChannels: the file brought to the context's rate by linear
      // interpolation, keeping at most two channels.
      const double ratio = src.rate / sampleRate;
      const int length = static_cast<int>(std::fmax(1.0, jsRound(src.frames / ratio)));
      const int kept = src.channelCount < 2 ? src.channelCount : 2;
      for (int ch = 0; ch < kept; ++ch) {
        std::vector<float>& dst = ch == 0 ? left : right;
        dst.assign(static_cast<size_t>(length), 0.f);
        for (int i = 0; i < length; ++i) {
          const double x = i * ratio;
          const int j = static_cast<int>(std::fmin(src.frames - 1.0, std::floor(x)));
          const int k = j + 1 < src.frames ? j + 1 : src.frames - 1;
          const double a = src.channels[static_cast<size_t>(j) * src.channelCount + ch];
          const double b = src.channels[static_cast<size_t>(k) * src.channelCount + ch];
          dst[static_cast<size_t>(i)] = static_cast<float>(a + (b - a) * (x - j));
        }
      }
      // A mono response is heard on both sides, as a one-channel buffer is by a ConvolverNode.
      if (kept < 2) right = left;
    } else {
      synthesizeImpulse(request.which, request.seconds, sampleRate, left, right);
    }
    if (left.empty()) return;
    const float* channels[2] = { left.data(), right.data() };
    const double scale = convolverNormalizationScale(channels, 2, static_cast<int>(left.size()), sampleRate);
    for (auto& v : left) v = static_cast<float>(v * scale);
    for (auto& v : right) v = static_cast<float>(v * scale);
    nextL.prepare(left.data(), static_cast<int>(left.size()));
    nextR.prepare(right.data(), static_cast<int>(right.size()));
    nextL.settle();
    nextR.settle();
  }

  /** The new response in, the old one out to be freed: swaps, nothing allocated. */
  void pd_work_done() {
    if (!nextL.ready()) return;
    std::swap(convL, nextL);
    std::swap(convR, nextR);
  }

  void pd_work_release() {
    nextL = Convolver();
    nextR = Convolver();
  }

  void pd_process(int frames) {
    const double predelayFrames = clamp(p[ids::predelay], 0.0, 0.3) * sampleRate;
    const double mix = p[ids::mix];
    const double out = dbToGain(p[ids::output]);
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
  }
};

}  // namespace pd_Convolver

extern "C" PdAny* pd_make_Convolver() { return new PdAdapter<pd_Convolver::Device>(); }
