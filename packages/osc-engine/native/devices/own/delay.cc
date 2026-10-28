// The Delay effect: a stereo delay line with feedback, a filter in the loop and tempo sync.
//
// Translated from web-engine/src/devices/delay.mjs. A change of length is glided rather than
// jumped, which pitches the tail for a moment the way a tape delay does and never clicks.

#include "own/pd-own.h"
#include "own/dsp/filters.h"
#include "own/dsp/reverb.h"
#include "own/dsp/sync.h"
#include "pd-own-ids.h"

namespace pd_Delay {

namespace ids = pd_ids::Delay;
using namespace pd_own;

constexpr double kMaxSec = 4.0;
/** Four seconds at 96 kHz, as a power of two: what the line costs, once, when a delay opens. */
constexpr int kLineCapacity = 524288;

/**
 * The soft clip on what is fed back, so a feedback near one saturates instead of running away.
 * A cubic with unity slope at zero that flattens out exactly where it meets the clamp.
 */
inline double clipTail(double x) {
  return x >= 1.5 ? 1.0 : (x <= -1.5 ? -1.0 : x - (4 * x * x * x) / 27);
}

struct Device : pd_own::Device<ids::kCount> {
  DelayLine<kLineCapacity> lines[2];
  OnePole tones[2];
  double length[2] = { 0, 0 };   // the delay each channel is actually at, in samples
  double bpm = 120;
  double lastTone = -1;

  void pd_init(double sr) {
    sampleRate = sr;
    const int want = static_cast<int>(std::ceil(sr * kMaxSec)) + 4;
    for (auto& l : lines) l.init(want);
    for (auto& t : tones) t.init(sr);
    length[0] = 0;
    length[1] = 0;
    bpm = 120;
    lastTone = -1;
  }

  void pd_transport(double tempo, double seconds) { (void)seconds; bpm = tempo; }

  void reset() {
    for (auto& l : lines) l.reset();
    for (auto& t : tones) t.reset();
  }

  void pd_process(int frames) {
    const int sync = jsRoundInt(p[ids::sync]);
    const double seconds = clamp(syncedSeconds(sync, bpm, p[ids::time]), 0.001, kMaxSec);
    const bool pingpong = p[ids::pingpong] >= 0.5;
    const double spread = p[ids::spread];
    const double targetL = seconds * sampleRate;
    // The right side sits later by the spread, up to half again the time.
    const double targetR = std::fmin(kMaxSec * sampleRate - 2, targetL * (1 + 0.5 * spread));
    const double tone = p[ids::tone];
    if (tone != lastTone) {
      for (auto& t : tones) t.glideTo(tone, frames);
      lastTone = tone;
    }
    // The length approaches its target over about twenty milliseconds, which is a glide and not
    // a jump: a set that sweeps the time hears a pitch bend, as it would from a tape.
    const double k = 1.0 - std::exp(-1.0 / (0.02 * sampleRate));

    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    double lenL = length[0] != 0 ? length[0] : targetL;
    double lenR = length[1] != 0 ? length[1] : targetR;

    for (int i = 0; i < frames; ++i) {
      lenL += (targetL - lenL) * k;
      lenR += (targetR - lenR) * k;
      const double fb = ctl(ids::feedback, i);
      const double mix = ctl(ids::mix, i);
      const double dryL = inl[i];
      const double dryR = inr[i];
      const double readL = lines[0].readLinear(lenL);
      const double readR = lines[1].readLinear(lenR);
      // Ping-pong feeds each side's repeat into the other line; a plain delay feeds it back into
      // its own. The input enters on the left in ping-pong, so the first repeat is right.
      const double fedL = clipTail(tones[0].next(pingpong ? readR : readL) * fb);
      const double fedR = clipTail(tones[1].next(pingpong ? readL : readR) * fb);
      if (pingpong) {
        lines[0].write((dryL + dryR) * 0.5 + fedL);
        lines[1].write(fedR);
      } else {
        lines[0].write(dryL + fedL);
        lines[1].write(dryR + fedR);
      }
      outl[i] = static_cast<float>(dryL + (readL - dryL) * mix);
      outr[i] = static_cast<float>(dryR + (readR - dryR) * mix);
    }
    length[0] = lenL;
    length[1] = lenR;
    if (frames > 0 && !isPlayable(outl[frames - 1])) reset();
  }
};

}  // namespace pd_Delay

extern "C" PdAny* pd_make_Delay() { return new PdAdapter<pd_Delay::Device>(); }
