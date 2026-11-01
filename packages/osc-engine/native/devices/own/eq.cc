// The EQ effect: four bands, each any biquad response, the cuts and shelves at 12 to 96 dB per octave.
//
// Translated from web-engine/src/devices/eq.mjs. The browser draws the summed magnitude from the
// same coefficients these bands filter with; the drawing is the panel's half and stays there.

#include "own/pd-own.h"
#include "own/dsp/biquad.h"
#include "own/dsp/spectrum.h"
#include "pd-own-ids.h"

namespace pd_EQ {

namespace ids = pd_ids::EQ;
using namespace pd_own;

constexpr int kBands = 4;

/** Each band's five controls, named rather than counted off from the first one. */
constexpr int kBandIds[kBands][5] = {
  { ids::band1_type, ids::band1_freq, ids::band1_gain, ids::band1_q, ids::band1_slope },
  { ids::band2_type, ids::band2_freq, ids::band2_gain, ids::band2_q, ids::band2_slope },
  { ids::band3_type, ids::band3_freq, ids::band3_gain, ids::band3_q, ids::band3_slope },
  { ids::band4_type, ids::band4_freq, ids::band4_gain, ids::band4_q, ids::band4_slope },
};

struct Device : pd_own::Device<ids::kCount> {
  // Each band is a cascade of up to kMaxSections biquads per channel, `sections[n]` of them in use.
  Biquad bands[kBands][2][kMaxSections];
  int sections[kBands];
  double last[kBands * 5];
  // What the window draws behind the curve: the spectrum of what comes out (see pd_report).
  SpectrumTap spectrum;

  void pd_init(double sr) {
    sampleRate = sr;
    spectrum.init(sr);
    for (auto& pair : bands) for (auto& chain : pair) for (auto& b : chain) { b = Biquad(); }
    for (int& s : sections) s = 1;
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
      const int slope = jsRoundInt(p[kBandIds[n][4]]);
      const int k = n * 5;
      if (type != last[k] || hz != last[k + 1] || gain != last[k + 2] || q != last[k + 3] || slope != last[k + 4]) {
        // A type or slope change is a different filter rather than a move, so it lands at once:
        // gliding between two unrelated responses passes through shapes that are neither.
        const bool jump = type != last[k] || slope != last[k + 4];
        const int count = biquadSections(type, slope);
        // Sections coming into use start from silence, not from whatever they last held.
        for (int s = sections[n]; s < count; ++s) { bands[n][0][s].reset(); bands[n][1][s].reset(); }
        sections[n] = count;
        for (int s = 0; s < count; ++s) {
          if (jump) bands[n][0][s].setSection(type, hz, gain, q, count, s, sampleRate);
          else bands[n][0][s].glideToSection(type, hz, gain, q, count, s, sampleRate, frames);
          bands[n][1][s].follow(bands[n][0][s]);
        }
        last[k] = type; last[k + 1] = hz; last[k + 2] = gain; last[k + 3] = q; last[k + 4] = slope;
      }
    }
    for (int ch = 0; ch < 2; ++ch) {
      const float* input = ch == 0 ? inL() : inR();
      float* out = ch == 0 ? outL() : outR();
      for (int i = 0; i < frames; ++i) {
        double x = input[i];
        for (int n = 0; n < kBands; ++n) {
          for (int s = 0; s < sections[n]; ++s) x = bands[n][ch][s].next(x);
        }
        out[i] = static_cast<float>(x * dbToGain(ctl(ids::output, i)));
      }
      if (frames > 0 && !isPlayable(out[frames - 1])) {
        for (int n = 0; n < kBands; ++n) for (auto& b : bands[n][ch]) b.reset();
      }
    }
    for (int i = 0; i < frames; ++i) spectrum.push(outL()[i], outR()[i]);
  }

  /** For the device window: the output's spectrum, as the browser's SpectrumTap reads it. */
  int pd_report(float* out, int capacity) { return spectrum.report(out, capacity); }
};

}  // namespace pd_EQ

extern "C" PdAny* pd_make_EQ() { return new PdAdapter<pd_EQ::Device>(); }
