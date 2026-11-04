// The Phaser effect: a chain of first-order allpasses whose corner an LFO sweeps.
//
// Translated from web-engine/src/devices/phaser.mjs. The sweep is in octaves around the center,
// so it covers the same musical range wherever the center is put.

#include "own/pd-own.h"
#include "own/dsp/filters.h"
#include "own/dsp/moddelay.h"
#include "own/dsp/sync.h"
#include "pd-own-ids.h"

namespace pd_Phaser {

namespace ids = pd_ids::Phaser;
using namespace pd_own;

constexpr int kMaxStages = 12;

/**
 * The corner of the blocker on what the feedback's curve adds, in Hz: low, because round a loop
 * of nearly one its turn in phase is heard well above it, on the bass the feedback lifts.
 */
constexpr double kPhaserLoopDcHz = 2.0;

/** The corner of the output's coupling, in Hz. */
constexpr double kPhaserDcHz = 8.0;

/** The first-order allpass coefficient whose phase turns through a quarter cycle at `hz`. */
inline double coefficient(double hz, double sampleRate) {
  const double f = clamp(hz, 10.0, sampleRate * 0.45);
  const double t = std::tan((M_PI * f) / sampleRate);
  return (1 - t) / (1 + t);
}

/** One channel's chain of allpasses, its feedback sample and its output's coupling. */
struct Chain {
  double z[kMaxStages] = { 0 };
  double fb = 0;
  DcBlocker dc;
  DcBlocker out;

  void reset() {
    for (double& v : z) v = 0;
    fb = 0;
    dc.reset();
    out.reset();
  }

  double next(double x, int stages, double a, double feedback) {
    double v = x + fb * feedback;
    for (int s = 0; s < stages; ++s) {
      const double y = -a * v + z[s];
      z[s] = v + a * y;
      v = y;
    }
    // The allpasses pass DC; what the curve adds is AC-coupled, so the DC it makes of a lopsided
    // wave cannot build up round the loop, while the feedback itself keeps its bass.
    fb = v + dc.next(std::tanh(v) - v);
    return v;
  }
};

struct Device : pd_own::Device<ids::kCount> {
  Chain chains[2];
  double phase = 0;
  double bpm = 120;

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& c : chains) { c.dc.init(sr, kPhaserLoopDcHz); c.out.init(sr, kPhaserDcHz); c.reset(); }
    phase = 0;
    bpm = 120;
  }

  void pd_transport(double tempo, double seconds) { (void)seconds; bpm = tempo; }

  /** Where the LFO is, in cycles, so the panel's playhead follows the sound. */
  int pd_report(float* out, int capacity) {
    if (capacity < 1) return 0;
    out[0] = static_cast<float>(phase);
    return 1;
  }

  void pd_process(int frames) {
    const int sync = jsRoundInt(p[ids::sync]);
    const int stages = static_cast<int>(clamp(jsRound(p[ids::stages] / 2) * 2, 2.0,
                                              static_cast<double>(kMaxStages)));
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    for (int i = 0; i < frames; ++i) {
      phase += syncedHz(sync, bpm, ctl(ids::rate, i)) / sampleRate;
      if (phase >= 1) phase -= 1;
      const double center = ctl(ids::center, i);
      const double octaves = 3 * ctl(ids::depth, i);
      const double feedback = ctl(ids::feedback, i);
      const double spread = ctl(ids::spread, i) * 0.5;
      const double mix = ctl(ids::mix, i);
      const double hzL = center * std::pow(2.0, octaves * (lfoValue(phase, 0) * 2 - 1));
      const double hzR = center * std::pow(2.0, octaves * (lfoValue(phase + spread, 0) * 2 - 1));
      const double aL = coefficient(hzL, sampleRate);
      const double aR = coefficient(hzR, sampleRate);
      const double l = inl[i];
      const double r = inr[i];
      const double wetL = chains[0].next(l, stages, aL, feedback);
      const double wetR = chains[1].next(r, stages, aR, feedback);
      // The output's coupling, on the mixed signal so the dry and the wet turn together: a fast sweep
      // mixes what goes round at its own rate down to DC, which the feedback then builds on.
      outl[i] = static_cast<float>(chains[0].out.next(l + (wetL - l) * mix));
      outr[i] = static_cast<float>(chains[1].out.next(r + (wetR - r) * mix));
    }
    if (frames > 0 && !isPlayable(outl[frames - 1])) for (auto& c : chains) c.reset();
  }
};

}  // namespace pd_Phaser

extern "C" PdAny* pd_make_Phaser() { return new PdAdapter<pd_Phaser::Device>(); }
