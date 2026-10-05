// The Multiband effect: three bands, each compressed or lifted on its own.
//
// Translated from web-engine/src/devices/multiband.mjs. Two Linkwitz-Riley crossovers per
// channel - the first takes the low band off, the second splits the rest - so the three bands
// sum back to the input when nothing is being done to them. The per-band meters the browser
// keeps for its three pictures are the panel's business and are not translated.

#include "own/pd-own.h"
#include "own/dsp/biquad.h"
#include "own/dsp/dynamics.h"
#include "pd-own-ids.h"

namespace pd_Multiband {

namespace ids = pd_ids::Multiband;
using namespace pd_own;

constexpr int kBands = 3;

/** How far below its threshold a band is still lifted: quieter than this is left alone. */
constexpr double kUpwardReachDb = 40;

/** Each band's six controls, named rather than counted off from the first one. */
struct BandIds { int threshold, ratio, upward, attack, release, gain; };
constexpr BandIds kBandIds[kBands] = {
  { ids::low_threshold, ids::low_ratio, ids::low_upward, ids::low_attack, ids::low_release, ids::low_gain },
  { ids::mid_threshold, ids::mid_ratio, ids::mid_upward, ids::mid_attack, ids::mid_release, ids::mid_gain },
  { ids::high_threshold, ids::high_ratio, ids::high_upward, ids::high_attack, ids::high_release, ids::high_gain },
};

struct Device : pd_own::Device<ids::kCount> {
  Crossover lowX[2];
  Crossover highX[2];
  Detector detectors[kBands];
  double lastLow = -1, lastHigh = -1;
  double lastAttack[kBands] = { -1, -1, -1 };
  double lastRelease[kBands] = { -1, -1, -1 };

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& x : lowX) x.init(sr);
    for (auto& x : highX) x.init(sr);
    for (auto& d : detectors) d.init(sr);
    lastLow = -1;
    lastHigh = -1;
    for (int b = 0; b < kBands; ++b) { lastAttack[b] = -1; lastRelease[b] = -1; }
  }

  void pd_process(int frames) {
    const double low = p[ids::lowsplit];
    const double high = std::fmax(low * 1.5, p[ids::highsplit]);
    if (low != lastLow || high != lastHigh) {
      // Glided across the block: a crossover that jumps steps the whole spectrum at once, which
      // is the loudest zipper of the lot.
      lowX[0].setFrequency(low, frames);
      lowX[1].follow(lowX[0]);
      highX[0].setFrequency(high, frames);
      highX[1].follow(highX[0]);
      lastLow = low;
      lastHigh = high;
    }
    // Each band follows its own pair of times.
    for (int b = 0; b < kBands; ++b) {
      const double attack = p[kBandIds[b].attack];
      const double release = p[kBandIds[b].release];
      if (attack != lastAttack[b] || release != lastRelease[b]) {
        detectors[b].setTimes(attack, release);
        lastAttack[b] = attack;
        lastRelease[b] = release;
      }
    }
    const double amount = p[ids::amount];
    const double mix = p[ids::mix];
    const double outGain = dbToGain(p[ids::output]);
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    double split[2][2];
    double bands[2][kBands];

    for (int i = 0; i < frames; ++i) {
      const double l = inl[i];
      const double r = inr[i];
      // Split both channels into their three bands.
      lowX[0].split(l, split[0]);
      bands[0][0] = split[0][0];
      highX[0].split(split[0][1], split[0]);
      bands[0][1] = split[0][0];
      bands[0][2] = split[0][1];
      lowX[1].split(r, split[1]);
      bands[1][0] = split[1][0];
      highX[1].split(split[1][1], split[1]);
      bands[1][1] = split[1][0];
      bands[1][2] = split[1][1];

      double sumL = 0;
      double sumR = 0;
      for (int b = 0; b < kBands; ++b) {
        const double key = std::fmax(std::fabs(bands[0][b]), std::fabs(bands[1][b]));
        const double level = dbOf(detectors[b].next(key));
        const double threshold = p[kBandIds[b].threshold];
        const double ratio = p[kBandIds[b].ratio];
        double change = gainComputer(level, threshold, ratio, 6);
        const double upward = p[kBandIds[b].upward];
        if (upward > 0 && level < threshold) {
          const double below = std::fmin(kUpwardReachDb, threshold - level);
          // Lifted by the same law, mirrored: the further below, the more lift, up to the reach,
          // then tapering back to nothing so silence is not raised to the threshold.
          const double taper = below >= kUpwardReachDb ? 0 : 1 - below / kUpwardReachDb;
          change += below * (1 - 1 / ratio) * upward * taper;
        }
        const double g = dbToGain(change * amount + p[kBandIds[b].gain]);
        sumL += bands[0][b] * g;
        sumR += bands[1][b] * g;
      }
      outl[i] = static_cast<float>((l + (sumL - l) * mix) * outGain);
      outr[i] = static_cast<float>((r + (sumR - r) * mix) * outGain);
    }
    if (frames > 0 && !isPlayable(outl[frames - 1])) {
      for (auto& x : lowX) x.reset();
      for (auto& x : highX) x.reset();
    }
    // Checked on their own: a NaN that is gone from the output by the end of the block can
    // still be sitting in a detector, and it stays there.
    for (auto& d : detectors) if (!isPlayable(d.env)) d.reset();
  }
};

}  // namespace pd_Multiband

extern "C" PdAny* pd_make_Multiband() { return new PdAdapter<pd_Multiband::Device>(); }
