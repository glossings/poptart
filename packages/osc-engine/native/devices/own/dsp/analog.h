// Circuit-modeled filters: the classic analog lowpass and multimode circuits, each with the
// nonlinearity that gives it its sound.
//
// Translated from web-engine/src/dsp/analog.mjs, which has the full account of each model. In
// short: every model is the circuit's own equations, one per capacitor, with each transistor
// pair, diode pair or amplifier as a saturating curve, discretized as a zero-delay-feedback
// (topology-preserving) filter. Each curve is linearized around where its input was a step ago
// (its secant slope as a gain) and the resulting linear system solved exactly - one solve per
// step, stable at any setting. Everything runs at two or four times the sample rate through
// polyphase IIR half-bands.
//
// API, one instance per channel:
//   AnalogFilter f; f.init(sampleRate, kAnalogDiode);
//   f.setCutoff(hz); f.setResonance(0..1); f.setDrive(1..8); f.setMorph(0..1);
//   double y = f.process(x);
// Every setter is cheap enough to call per sample. `follow(other)` copies another instance's
// tuning for the second channel of a pair. The small-signal response the browser draws is not
// needed here, so it is not translated.
#pragma once

#include <cmath>

#include "own/pd-own.h"

namespace pd_own {

/** The models, in the order of ANALOG_MODELS in analog.mjs. */
enum AnalogModel {
  kAnalogLadder = 0, kAnalogDiode, kAnalogSallen, kAnalogStatevar,
  kAnalogCmos, kAnalogOta, kAnalogPolar, kAnalogDiodePair,
  kAnalogModelCount,
};

enum AnalogStructure { kAnalogCascade = 0, kAnalogDiodeLadder, kAnalogSallenKey, kAnalogStateVar };

/** Per model: the linear onset, the feedback at the top of the knob, the internal full scale, the rate. */
struct AnalogSpec {
  AnalogStructure structure;
  double onset, top, headroom;
  int oversample;
  bool morphs;
};

constexpr AnalogSpec kAnalogSpecs[kAnalogModelCount] = {
  { kAnalogCascade,     4,      4.4,  1.2, 2, false },   // ladder
  { kAnalogDiodeLadder, 16.977, 16.6, 1.0, 4, false },   // diode
  { kAnalogSallenKey,   3,      3.3,  1.4, 2, true },    // sallen
  { kAnalogStateVar,    2,      1.94, 1.5, 2, true },    // statevar
  { kAnalogStateVar,    2,      2.1,  0.7, 4, true },    // cmos
  { kAnalogCascade,     4,      4.4,  1.8, 4, false },   // ota
  { kAnalogStateVar,    2,      2.2,  0.5, 4, true },    // polar
  { kAnalogSallenKey,   3,      3.35, 1.0, 2, true },    // diodepair
};

constexpr double kAnalogDiodeTune = 1.4132;
constexpr double kAnalogOtaCompensation = 0.5;
constexpr double kAnalogDiodeCompensation = 0.25;
constexpr double kAnalogDiodeFeedbackHz = 40;
constexpr double kAnalogSallenClip = 2;
constexpr double kAnalogDiodePairClip = 2.5;
constexpr double kAnalogRingKnee = 2.5;
constexpr double kAnalogCmosBias = 0.35;
constexpr double kAnalogPolarKnee = 1.5;
constexpr double kAnalogRail = 5;
constexpr double kAnalogMaxCutoff = 0.45;
constexpr double kAnalogMinCutoffHz = 20;
constexpr double kAnalogDcHz = 8;
constexpr double kAnalogFlush = 1e-20;

/** A rational tanh that reaches one at three and stays there. */
inline double analogClip(double x) {
  if (x <= -3) return -1;
  if (x >= 3) return 1;
  const double x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** analogClip(x) / x: the secant slope the linearized solve uses. */
inline double analogClipGain(double x) {
  const double ax = x < 0 ? -x : x;
  if (ax >= 3) return 1 / ax;
  const double x2 = x * x;
  return (27 + x2) / (27 + 9 * x2);
}

inline double analogClipSlope(double x) {
  if (x <= -3 || x >= 3) return 0;
  const double x2 = x * x;
  const double d = 27 + 9 * x2;
  return (9 * (9 - x2) * (9 - x2)) / (d * d);
}

/** The CMOS model's lopsided curve through zero, as a secant gain, unity at rest. */
inline double analogCmosGain(double x) {
  const double b = kAnalogCmosBias;
  const double slope = analogClipSlope(kAnalogCmosBias);
  if (x > -1e-9 && x < 1e-9) return analogClipSlope(b) / slope;
  return (analogClip(x + b) - analogClip(b)) / (x * slope);
}

/** The polar model's integrators running out of slew. */
inline double analogSlewGain(double x) { return analogClipGain(x * kAnalogPolarKnee); }

constexpr double kAnalogHalfbandA[8] = {
  0.040633460924193260, 0.15050512902267460, 0.30075705599187408, 0.46077450496145061,
  0.60952431489618830, 0.73850384111885725, 0.84922381039206607, 0.94974278370500020,
};
constexpr double kAnalogHalfbandB[4] = {
  0.070765948976184462, 0.25785307851345257, 0.51316757474879282, 0.81731735441713682,
};

/** One direction of a polyphase IIR half-band. */
template <int N>
struct AnalogHalfband {
  const double* c = nullptr;
  double x[N] = {};
  double y[N] = {};

  void init(const double* coefficients) { c = coefficients; reset(); }
  void reset() { for (int i = 0; i < N; ++i) { x[i] = 0; y[i] = 0; } }

  /** Runs one path (0 even coefficients, 1 odd) one step. */
  double path(double input, int which) {
    constexpr int half = N / 2;
    double v = input;
    for (int i = 0; i < half; ++i) {
      const int at = which * half + i;
      const double out = c[2 * i + which] * (v - y[at]) + x[at];
      x[at] = v;
      y[at] = out;
      v = out;
    }
    return v;
  }
};

struct AnalogFilter {
  double sampleRate = 48000.0;
  double rate = 96000.0;
  bool four = false;
  int model = -1;
  AnalogSpec spec = kAnalogSpecs[0];
  double s[4] = { 0, 0, 0, 0 };
  double v[6] = { 0, 0, 0, 0, 0, 0 };
  double fb = 0, fbG = 0;
  double dcX = 0, dcY = 0, dcR = 0;
  AnalogHalfband<8> upA, downA;
  AnalogHalfband<4> upB, downB;
  double cutoff = 1000, tuned = 1000, resonance = 0, drive = 1, morph = 0;
  double wc = 0, g = 0, k = 0;
  double wl = 1, wb = 0, wh = 0;

  void init(double sr, int m = 0) {
    sampleRate = sr;
    rate = sr * 2;
    model = -1;
    dcR = std::fmax(0.0, 1 - (2 * M_PI * kAnalogDcHz) / sr);
    upA.init(kAnalogHalfbandA);
    downA.init(kAnalogHalfbandA);
    upB.init(kAnalogHalfbandB);
    downB.init(kAnalogHalfbandB);
    cutoff = 1000;
    tuned = 1000;
    resonance = 0;
    drive = 1;
    morph = 0;
    setModel(m);
  }

  void reset() {
    for (double& x : s) x = 0;
    for (double& x : v) x = 0;
    fb = 0;
    dcX = 0;
    dcY = 0;
    upA.reset();
    downA.reset();
    upB.reset();
    downB.reset();
  }

  void setModel(int to) {
    const int m = to < 0 ? 0 : (to > kAnalogModelCount - 1 ? kAnalogModelCount - 1 : to);
    if (m == model) return;
    model = m;
    spec = kAnalogSpecs[m];
    four = spec.oversample == 4;
    rate = sampleRate * spec.oversample;
    const double hp = std::tan((M_PI * kAnalogDiodeFeedbackHz) / rate);
    fbG = hp / (1 + hp);
    reset();
    setCutoff(cutoff);
    setResonance(resonance);
    setMorph(morph);
  }

  void setCutoff(double hz) {
    cutoff = hz;
    const double f = std::fmin(sampleRate * kAnalogMaxCutoff, std::fmax(kAnalogMinCutoffHz, hz));
    tuned = f;
    double w = std::tan((M_PI * f) / rate);
    if (spec.structure == kAnalogDiodeLadder) w /= kAnalogDiodeTune;
    wc = w;
    g = w;
  }

  void setResonance(double r0) {
    const double r = clamp(r0, 0.0, 1.0);
    resonance = r;
    k = spec.top * r;
  }

  void setDrive(double d) { drive = std::fmax(0.0, d); }

  void setMorph(double m0) {
    const double m = clamp(m0, 0.0, 1.0);
    morph = m;
    if (!spec.morphs) {
      wl = 1; wb = 0; wh = 0;
    } else if (model == kAnalogStatevar) {
      wb = 0;
      wl = m < 0.5 ? 1 : 2 - 2 * m;
      wh = m < 0.5 ? 2 * m : 1;
    } else if (m < 0.5) {
      wl = 1 - 2 * m; wb = 2 * m; wh = 0;
    } else {
      wl = 0; wb = 2 - 2 * m; wh = 2 * m - 1;
    }
  }

  void follow(const AnalogFilter& o) {
    if (o.model != model) setModel(o.model);
    cutoff = o.cutoff;
    tuned = o.tuned;
    resonance = o.resonance;
    drive = o.drive;
    morph = o.morph;
    wc = o.wc;
    g = o.g;
    k = o.k;
    wl = o.wl;
    wb = o.wb;
    wh = o.wh;
  }

  double process(double input) {
    const double h = spec.headroom;
    const double x = (input * drive) / h;
    const double a = upA.path(x, 0);
    const double b = upA.path(x, 1);
    double ya, yb;
    if (four) {
      const double a0 = upB.path(a, 0);
      const double a1 = upB.path(a, 1);
      const double b0 = upB.path(b, 0);
      const double b1 = upB.path(b, 1);
      const double ya0 = step(a0);
      const double ya1 = step(a1);
      const double yb0 = step(b0);
      const double yb1 = step(b1);
      ya = 0.5 * (downB.path(ya1, 0) + downB.path(ya0, 1));
      yb = 0.5 * (downB.path(yb1, 0) + downB.path(yb0, 1));
    } else {
      ya = step(a);
      yb = step(b);
    }
    double y = 0.5 * (downA.path(yb, 0) + downA.path(ya, 1)) * h;
    if (model == kAnalogCmos) {
      const double out = y - dcX + dcR * dcY;
      dcX = y;
      dcY = out;
      y = out;
    }
    for (double& x0 : s) if (x0 > -kAnalogFlush && x0 < kAnalogFlush) x0 = 0;
    if (fb > -kAnalogFlush && fb < kAnalogFlush) fb = 0;
    return y;
  }

  /** One step of the circuit at its own rate, through the output amplifier's rails. */
  double step(double x) {
    double y;
    switch (spec.structure) {
      case kAnalogCascade: y = cascade(x); break;
      case kAnalogDiodeLadder: y = diode(x); break;
      case kAnalogSallenKey: y = sallenKey(x); break;
      default: y = stateVar(x); break;
    }
    return kAnalogRail * analogClip(y / kAnalogRail);
  }

  /** Four one-poles in a loop: the transistor ladder, or the OTA cascade. */
  double cascade(double x) {
    const bool ota = model == kAnalogOta;
    double G = 1, S = 0;
    double m[4], c[4];
    for (int i = 0; i < 4; ++i) {
      double alpha, beta;
      if (ota) {
        alpha = analogClipGain(v[i] - v[i + 1]);
        beta = alpha;
      } else {
        alpha = analogClipGain(v[i]);
        beta = analogClipGain(v[i + 1]);
      }
      const double d = 1 / (1 + g * beta);
      m[i] = d * g * alpha;
      c[i] = d * s[i];
      G = m[i] * G;
      S = m[i] * S + c[i];
    }
    double u;
    if (ota) {
      const double w = x * (1 + kAnalogOtaCompensation * k);
      const double a0 = analogClipGain(v[5]);
      u = (a0 * (w - k * S)) / (1 + a0 * k * G);
      v[5] = w - k * (G * u + S);
    } else {
      u = (x - k * S) / (1 + k * G);
    }
    v[0] = u;
    const double y1 = m[0] * u + c[0];
    const double y2 = m[1] * y1 + c[1];
    const double y3 = m[2] * y2 + c[2];
    const double y4 = m[3] * y3 + c[3];
    s[0] = 2 * y1 - s[0];
    s[1] = 2 * y2 - s[1];
    s[2] = 2 * y3 - s[2];
    s[3] = 2 * y4 - s[3];
    v[1] = y1; v[2] = y2; v[3] = y3; v[4] = y4;
    return y4;
  }

  /** The diode ladder, solved from the top down, its feedback through a coupling highpass. */
  double diode(double x) {
    const double e1 = analogClipGain(v[0] - v[1]);
    const double e2 = analogClipGain(v[1] - v[2]);
    const double e3 = analogClipGain(v[2] - v[3]);
    const double e4 = analogClipGain(v[3] - v[4]);
    const double g4 = 2 * g * e4;
    const double a4 = g4 / (1 + g4);
    const double b4 = s[3] / (1 + g4);
    const double d3 = 1 + g * e3 + g * e4 - g * e4 * a4;
    const double a3 = (g * e3) / d3;
    const double b3 = (s[2] + g * e4 * b4) / d3;
    const double d2 = 1 + g * e2 + g * e3 - g * e3 * a3;
    const double a2 = (g * e2) / d2;
    const double b2 = (s[1] + g * e3 * b3) / d2;
    const double d1 = 1 + g * e1 + g * e2 - g * e2 * a2;
    const double a1 = (g * e1) / d1;
    const double b1 = (s[0] + g * e2 * b2) / d1;
    const double A = a4 * a3 * a2 * a1;
    const double B = a4 * (a3 * (a2 * b1 + b2) + b3) + b4;
    const double hp = 1 - fbG;
    const double in = x * (1 + kAnalogDiodeCompensation * k);
    const double u = (in - k * hp * (B - fb)) / (1 + k * hp * A);
    const double y1 = a1 * u + b1;
    const double y2 = a2 * y1 + b2;
    const double y3 = a3 * y2 + b3;
    const double y4 = a4 * y3 + b4;
    s[0] = 2 * y1 - s[0];
    s[1] = 2 * y2 - s[1];
    s[2] = 2 * y3 - s[2];
    s[3] = 2 * y4 - s[3];
    const double st = (y4 - fb) * fbG;
    fb = fb + 2 * st;
    v[0] = u; v[1] = y1; v[2] = y2; v[3] = y3; v[4] = y4;
    return y4;
  }

  /** The Sallen-Key two-pole, fed at three points by the morph. */
  double sallenKey(double x) {
    const double xl = wl * x;
    const double xb = (wb - 2 * wh) * x;
    const double xh = wh * x;
    const bool diodepair = model == kAnalogDiodePair;
    const double e1 = analogClipGain(v[0] - v[1]);
    const double e2 = diodepair ? analogClipGain(v[1] - v[2]) : 1;
    const double f = analogClipGain(v[2] * (diodepair ? kAnalogDiodePairClip : kAnalogSallenClip));
    const double kf = k * f;
    const double p = (g * e2) / (1 + g * e2);
    const double q = (s[1] + xh) / (1 + g * e2);
    const double a = (s[0] + g * e1 * xl + xb + (g * e2 + kf) * q) / (1 + g * e1 + g * e2 - (g * e2 + kf) * p);
    const double b = p * a + q;
    s[0] = 2 * (a - kf * b - xb) - s[0];
    s[1] = 2 * (b - xh) - s[1];
    v[0] = xl; v[1] = a; v[2] = b;
    return b;
  }

  /** The state-variable two-pole, its resonance a saturating positive feedback of the band. */
  double stateVar(double x) {
    double a1, a2, c;
    if (model == kAnalogCmos) {
      a1 = analogCmosGain(v[0]);
      a2 = analogCmosGain(v[1]);
      c = analogCmosGain(v[1] * kAnalogRingKnee);
    } else if (model == kAnalogPolar) {
      a1 = analogSlewGain(v[0]);
      a2 = analogSlewGain(v[1]);
      c = analogSlewGain(v[1] * kAnalogRingKnee);
    } else {
      a1 = analogClipGain(v[0]);
      a2 = analogClipGain(v[1]);
      c = analogClipGain(v[1]);
    }
    const double kk = 2 - k * c;
    const double hp = (x - kk * s[0] - s[1] - g * a2 * s[0]) / (1 + kk * g * a1 + g * g * a1 * a2);
    const double bp = s[0] + g * a1 * hp;
    const double lp = s[1] + g * a2 * bp;
    s[0] = 2 * bp - s[0];
    s[1] = 2 * lp - s[1];
    v[0] = hp; v[1] = bp;
    return wl * lp + wb * bp + wh * hp;
  }
};

}  // namespace pd_own
