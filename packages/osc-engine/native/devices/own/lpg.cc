// The LPG effect: a level and a lowpass opened together through a slow, uneven response.
//
// Translated from web-engine/src/devices/lpg.mjs, which says what the element is and why it
// sounds the way it does. A note's onset is not carried here: a strike lands at the start of the
// block its note arrives in, as the ducker's dip does, where the browser's host hands over the
// time the note was scheduled for.

#include "own/pd-own.h"
#include "pd-own-ids.h"

namespace pd_LPG {

namespace ids = pd_ids::LPG;
using namespace pd_own;

constexpr int kModes = 3;
constexpr double kAttackSec = 0.0015;
constexpr double kStrikeSec = 0.004;
constexpr double kCutoffLow = 20;
constexpr double kCutoffSpan = 1000;
constexpr double kDark = 1e-9;
constexpr double kPi = 3.141592653589793;
/** How many strikes can be waiting. The browser's list is capped at the same number. */
constexpr int kMaxPending = 64;

struct Device : pd_own::Device<ids::kCount, 2> {
  bool noteRouted = false;
  double pending[kMaxPending] = { 0 };   // velocities of strikes not yet played
  int pendingCount = 0;
  int strikeLen = 192;
  double attackK = 0;
  double light = 0, pulse = 0;
  int pulseLeft = 0;
  double ic1L = 0, ic2L = 0, ic1R = 0, ic2R = 0;
  double lastLight = -1, lastRes = -1;
  double a1 = 1, a2 = 0, a3 = 0, gain = 0;

  void reset() {
    light = 0; pulse = 0; pulseLeft = 0;
    ic1L = 0; ic2L = 0; ic1R = 0; ic2R = 0;
    lastLight = -1; lastRes = -1;
    a1 = 1; a2 = 0; a3 = 0; gain = 0;
  }

  void pd_init(double sr) {
    sampleRate = sr;
    noteRouted = false;
    pendingCount = 0;
    strikeLen = jsRoundInt(kStrikeSec * sr);
    attackK = 1 / (1 + kAttackSec * sr);
    reset();
  }

  void pd_note_route(bool on) {
    noteRouted = on;
    if (!noteRouted) pendingCount = 0;
  }

  void pd_note_on(float note, float velocity) {
    (void)note;
    if (!(velocity > 0)) return;
    noteRouted = true;
    if (pendingCount >= kMaxPending) {
      for (int i = 1; i < pendingCount; ++i) pending[i - 1] = pending[i];
      pendingCount -= 1;
    }
    pending[pendingCount++] = velocity;
  }

  void pd_note_off(float note) { (void)note; }

  void pd_process(int frames) {
    const double sr = sampleRate;
    const int mode = static_cast<int>(clamp(jsRound(p[ids::mode]), 0.0, kModes - 1));
    const double level = clamp(p[ids::level], 0.0, 1.0);
    const double decay = p[ids::decay];
    const double res = clamp(p[ids::resonance], 0.0, 1.0);
    const double out = dbToGain(p[ids::output]);
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    for (int i = 0; i < frames; ++i) {
      double drive = level;
      if (noteRouted) {
        // Every strike that arrived before this block lands on its first sample.
        if (i == 0) {
          for (int k = 0; k < pendingCount; ++k) {
            const double strike = level * pending[k];
            pulse = pulseLeft > 0 ? std::fmax(pulse, strike) : strike;
            pulseLeft = strikeLen;
          }
          pendingCount = 0;
        }
        drive = pulseLeft > 0 ? pulse : 0;
        if (pulseLeft > 0) pulseLeft -= 1;
      }
      if (drive > light) {
        light += (drive - light) * attackK;
      } else {
        const double tau = (decay * 0.25) / (0.3 + 0.7 * light);
        light += (drive - light) / (1 + tau * sr);
      }
      if (light < kDark) light = 0;

      if (light != lastLight || res != lastRes) {
        const double cutoff = std::fmin(0.45 * sr, kCutoffLow * std::pow(kCutoffSpan, light));
        const double g = std::tan((kPi * cutoff) / sr);
        const double k = 2 - 1.9 * res;
        a1 = 1 / (1 + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
        gain = light * light;
        lastLight = light;
        lastRes = res;
      }
      const double xl = inl[i];
      const double xr = inr[i];
      double yl = xl;
      double yr = xr;
      if (mode != 1) {
        double v3 = xl - ic2L;
        double v1 = a1 * ic1L + a2 * v3;
        double v2 = ic2L + a2 * ic1L + a3 * v3;
        ic1L = 2 * v1 - ic1L;
        ic2L = 2 * v2 - ic2L;
        yl = v2;
        v3 = xr - ic2R;
        v1 = a1 * ic1R + a2 * v3;
        v2 = ic2R + a2 * ic1R + a3 * v3;
        ic1R = 2 * v1 - ic1R;
        ic2R = 2 * v2 - ic2R;
        yr = v2;
      }
      if (mode != 2) { yl *= gain; yr *= gain; }
      outl[i] = static_cast<float>(yl * out);
      outr[i] = static_cast<float>(yr * out);
    }
    if (!isPlayable(ic1L + ic2L + ic1R + ic2R + light)) reset();
  }
};

}  // namespace pd_LPG

extern "C" PdAny* pd_make_LPG() { return new PdAdapter<pd_LPG::Device>(); }
