// The EQ effect: four bands, each any biquad response.
//
// Translated from web-engine/src/devices/eq.mjs. The browser draws the summed magnitude from the
// same coefficients these bands filter with; the drawing is the panel's half and stays there.

#include "own/pd-own.h"
#include "own/dsp/biquad.h"
#include "pd-own-ids.h"

namespace pd_EQ {

namespace ids = pd_ids::EQ;
using namespace pd_own;

constexpr int kBands = 4;

/** Each band's four controls, named rather than counted off from the first one. */
constexpr int kBandIds[kBands][4] = {
  { ids::band1_type, ids::band1_freq, ids::band1_gain, ids::band1_q },
  { ids::band2_type, ids::band2_freq, ids::band2_gain, ids::band2_q },
  { ids::band3_type, ids::band3_freq, ids::band3_gain, ids::band3_q },
  { ids::band4_type, ids::band4_freq, ids::band4_gain, ids::band4_q },
};

struct Device : pd_own::Device<ids::kCount> {
  Biquad bands[kBands][2];
  double last[kBands * 4];

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& pair : bands) for (auto& b : pair) { b = Biquad(); }
    for (double& v : last) v = -1;
  }

  void pd_process(int frames) {
    // Recomputed once a block when a band's settings changed, and WALKED there across the block
    // rather than jumping (see Biquad::glideTo): four bands stepping a hundred and fifty times a
    // second is the buzz that rides every sweep.
    for (int n = 0; n < kBands; ++n) {
      const int type = jsRoundInt(p[kBandIds[n][0]]);
      const double hz = p[kBandIds[n][1]];
      const double gain = p[kBandIds[n][2]];
      const double q = p[kBandIds[n][3]];
      const int k = n * 4;
      if (type != last[k] || hz != last[k + 1] || gain != last[k + 2] || q != last[k + 3]) {
        // A type change is a different filter rather than a move, so it lands at once: gliding
        // between two unrelated responses passes through shapes that are neither.
        if (type != last[k]) bands[n][0].set(type, hz, gain, q, sampleRate);
        else bands[n][0].glideTo(type, hz, gain, q, sampleRate, frames);
        bands[n][1].follow(bands[n][0]);
        last[k] = type; last[k + 1] = hz; last[k + 2] = gain; last[k + 3] = q;
      }
    }
    for (int ch = 0; ch < 2; ++ch) {
      const float* input = ch == 0 ? inL() : inR();
      float* out = ch == 0 ? outL() : outR();
      for (int i = 0; i < frames; ++i) {
        double x = input[i];
        for (int n = 0; n < kBands; ++n) x = bands[n][ch].next(x);
        out[i] = static_cast<float>(x * dbToGain(ctl(ids::output, i)));
      }
      if (frames > 0 && !isPlayable(out[frames - 1])) for (int n = 0; n < kBands; ++n) bands[n][ch].reset();
    }
  }
};

}  // namespace pd_EQ

extern "C" PdAny* pd_make_EQ() { return new PdAdapter<pd_EQ::Device>(); }
