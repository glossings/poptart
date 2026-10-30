// The Delay effect: a stereo delay line with feedback, a filter in the loop and tempo sync.
//
// Translated from web-engine/src/devices/delay.mjs. A change of length is glided rather than
// jumped, which pitches the tail for a moment the way a tape delay does and never clicks.
//
// A chain in the feedback loop: the repeats leave through the second output pair, run through the
// chain on the track, and come back on the key pair. The engine says how late they come back
// (pd_loop: the UGen's block plus the chain's devices), and the tap that goes out reads that much
// early. With no chain it is the plain delay, sample for sample.

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

// Four in (its own pair and the loop's return) and four out (its own pair and the loop's send).
struct Device : pd_own::Device<ids::kCount, 4, 4> {
  DelayLine<kLineCapacity> lines[2];
  OnePole tones[2];
  double length[2] = { 0, 0 };   // the delay each channel is actually at, in samples
  double bpm = 120;
  double lastTone = -1;
  double loopSec = -1;   // how late the loop's chain returns, in seconds; below zero, no loop

  void pd_init(double sr) {
    sampleRate = sr;
    const int want = static_cast<int>(std::ceil(sr * kMaxSec)) + 4;
    for (auto& l : lines) l.init(want);
    for (auto& t : tones) t.init(sr);
    length[0] = 0;
    length[1] = 0;
    bpm = 120;
    lastTone = -1;
    loopSec = -1;
  }

  void pd_transport(double tempo, double seconds) { (void)seconds; bpm = tempo; }

  /** How late a chain in the feedback loop comes back, in seconds, or below zero for none. */
  void pd_loop(double seconds) { loopSec = std::isfinite(seconds) && seconds >= 0 ? seconds : -1; }

  void reset() {
    for (auto& l : lines) l.reset();
    for (auto& t : tones) t.reset();
  }

  void pd_process(int frames) {
    if (loopSec >= 0) { processLoop(frames); return; }
    // No chain in the loop: nothing goes out of the second pair.
    std::memset(out(2), 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(out(3), 0, sizeof(float) * static_cast<size_t>(frames));
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

  /**
   * The delay with a chain in its feedback loop: the repeat taken out through the second pair
   * and brought back in on the key. The output tap reads the time; the tap that goes out reads it
   * early by the way round, so every repeat lands on the grid. A time shorter than the way round
   * is held at it.
   */
  void processLoop(int frames) {
    const int sync = jsRoundInt(p[ids::sync]);
    const double seconds = clamp(syncedSeconds(sync, bpm, p[ids::time]), 0.001, kMaxSec);
    const bool pingpong = p[ids::pingpong] >= 0.5;
    const double spread = p[ids::spread];
    const double most = kMaxSec * sampleRate - 2;
    const double trip = std::fmin(most, loopSec * sampleRate);
    const double targetL = std::fmax(trip, seconds * sampleRate);
    const double targetR = std::fmax(trip, std::fmin(most, seconds * sampleRate * (1 + 0.5 * spread)));
    const double tone = p[ids::tone];
    if (tone != lastTone) {
      for (auto& t : tones) t.glideTo(tone, frames);
      lastTone = tone;
    }
    const double k = 1.0 - std::exp(-1.0 / (0.02 * sampleRate));

    const float* inl = inL();
    const float* inr = inR();
    const float* backl = keyL();
    const float* backr = keyR();
    float* outl = outL();
    float* outr = outR();
    float* sendl = out(2);
    float* sendr = out(3);
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
      const double retL = backl[i];
      const double retR = backr[i];
      const double fedL = clipTail(tones[0].next(pingpong ? retR : retL) * fb);
      const double fedR = clipTail(tones[1].next(pingpong ? retL : retR) * fb);
      if (pingpong) {
        lines[0].write((dryL + dryR) * 0.5 + fedL);
        lines[1].write(fedR);
      } else {
        lines[0].write(dryL + fedL);
        lines[1].write(dryR + fedR);
      }
      // After the write, a tap of one is the sample just written. A length still gliding up to a
      // longer way round reads no nearer than that sample.
      sendl[i] = static_cast<float>(lines[0].readLinear(std::fmax(1.0, lenL - trip + 1)));
      sendr[i] = static_cast<float>(lines[1].readLinear(std::fmax(1.0, lenR - trip + 1)));
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
