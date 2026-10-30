// The filter bank under Filterbank and Resonator: many band-passes side by side, each with its own level
// every sample, and the moving picture (scroll or ripple) those levels are read from.
//
// Translated from web-engine/src/dsp/filterbank.mjs, which says what the picture is, why the wave
// is stable at every setting (sub-steps keep its Courant number under 1/sqrt(2)), and how a band
// is scaled. The one thing this side does that the browser's does not is GROW ITS ARRAYS OFF THE
// AUDIO THREAD: a bank has as many bands as it is asked for, so its arrays are made bigger in the
// device's work round (Store below) and the device plays with the room it has until they land.
#pragma once

#include <cmath>
#include <cstring>

#include "own/pd-own.h"

namespace pd_own {

constexpr double kAudibleLow = 20;
constexpr double kAudibleHigh = 20000;
constexpr double kTwoOverPi = 2 / 3.141592653589793;
constexpr double kFbPi = 3.141592653589793;
constexpr double kFbSqrt2 = 1.4142135623730951;

inline double fbClamp01(double x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

/**
 * N arrays of doubles, all `cap` long, that grow and keep what they held - the browser's Store.
 *
 *   ask(n)     audio thread: room for n is wanted.
 *   wanted()   audio thread, from pd_work_wanted: whether a round should grow them.
 *   build()    the non-realtime thread: the new, zeroed arrays.
 *   install()  audio thread: the old contents copied in, the pointers swapped. No allocation.
 *   release()  the non-realtime thread: the old arrays freed.
 */
template <int N>
struct Store {
  double* a[N] = { nullptr };
  int cap = 0;
  int want = 0;
  int building = 0;
  double* fresh[N] = { nullptr };
  int freshCap = 0;
  double* old[N] = { nullptr };

  Store() = default;
  Store(const Store&) = delete;
  Store& operator=(const Store&) = delete;
  ~Store() {
    for (int i = 0; i < N; ++i) { delete[] a[i]; delete[] fresh[i]; delete[] old[i]; }
  }

  void ask(int n) { if (n > cap && n > want) want = n; }
  bool wanted() {
    if (want <= cap) return false;
    building = want;
    return true;
  }
  void build() {
    if (building <= cap || freshCap) return;
    int size = building;
    if (size < 2 * cap) size = 2 * cap;
    for (int i = 0; i < N; ++i) fresh[i] = new double[static_cast<size_t>(size)]();
    freshCap = size;
  }
  void install() {
    if (!freshCap) return;
    for (int i = 0; i < N; ++i) {
      if (cap > 0) std::memcpy(fresh[i], a[i], sizeof(double) * static_cast<size_t>(cap));
      old[i] = a[i];
      a[i] = fresh[i];
      fresh[i] = nullptr;
    }
    cap = freshCap;
    freshCap = 0;
    if (want <= cap) want = 0;
  }
  void release() {
    for (int i = 0; i < N; ++i) { delete[] old[i]; old[i] = nullptr; }
  }
  /** Room for n now: pd_init, on the non-realtime thread, before the device plays. */
  void reserve(int n) {
    ask(n);
    if (wanted()) { build(); install(); release(); }
  }
  void fill(int which, double v) { for (int k = 0; k < cap; ++k) a[which][k] = v; }
};

/** A list handed over for an option slot (see pd_shape): the host's floats, pointed at. */
struct ListRef {
  const float* table = nullptr;
  int count = 0;
};

/** The value of a list of levels at `pos`: the last triple covering it, 0 for none, 1 with no list. */
inline double listLevel(const ListRef* list, double pos) {
  if (!list || !list->table) return 1;
  double v = 0;
  const float* t = list->table;
  for (int i = 0; i + 2 < list->count; i += 3) {
    if (pos >= t[i] && pos < t[i + 1]) v = t[i + 2];
  }
  return v;
}

inline double pitchHz(double pitch) { return 440 * std::pow(2.0, (pitch - 69) / 12); }

/** The moving picture: one level per cell for each side, every sample. */
struct ShapeField {
  enum { hist, uL, pL, xL, uR, pR, xR, lvL, lvR, kArrays };
  Store<kArrays> cells;
  int n = 0;
  double phase = 0;
  int mode = 0;
  double adv = 0;
  bool reverse = false;
  double stereo = 0;
  double whereL = 0, whereR = 0;
  int sub = 1;
  double c2 = 0;
  double lambda = 1;
  bool primed = false;

  double* A(int which) { return cells.a[which]; }

  void reset() {
    for (int i = 0; i < kArrays; ++i) cells.fill(i, 0);
    phase = 0;
    primed = false;
  }

  /** Room for n cells, and the n + 1 snapshots a scroll keeps. */
  void ask(int count) { cells.ask(count + 1); }
  /** How many cells there is room for. */
  int room() const { return cells.cap > 0 ? cells.cap - 1 : 0; }

  void setup(int count, double sampleRate, int m, double scroll, double where, double speed, double damping, double st) {
    n = count;
    mode = m;
    adv = std::fabs(scroll) / sampleRate;
    reverse = scroll < 0;
    stereo = fbClamp01(st);
    whereL = fbClamp01(where);
    whereR = whereL + stereo * ((1 - whereL) - whereL);
    const double raw = std::fmax(0.0, speed) / sampleRate;
    sub = static_cast<int>(std::fmax(1.0, std::ceil(raw * kFbSqrt2)));
    const double c = raw / sub;
    c2 = c * c;
    lambda = std::pow(1 - fbClamp01(damping), 2 * c);
  }

  void tick(double shape) {
    if (n <= 0) return;
    double* h = A(hist);
    double* lL = A(lvL);
    double* lR = A(lvR);
    if (!primed) {
      double* a = A(uL); double* b = A(pL); double* c = A(uR); double* d = A(pR);
      for (int k = 0; k <= n; ++k) { h[k] = shape; a[k] = shape; b[k] = shape; c[k] = shape; d[k] = shape; }
      primed = true;
    }
    if (mode == 1) {
      for (int s = 0; s < sub; ++s) {
        stepSide(A(uL), A(pL), A(xL), whereL, shape);
        if (stereo > 0) stepSide(A(uR), A(pR), A(xR), whereR, shape);
      }
      double* a = A(uL); double* b = A(pL); double* c = A(uR); double* d = A(pR);
      for (int k = 0; k < n; ++k) {
        lL[k] = fbClamp01(a[k]);
        if (stereo > 0) {
          lR[k] = fbClamp01(c[k]);
        } else {
          c[k] = a[k];
          d[k] = b[k];
          lR[k] = lL[k];
        }
      }
      return;
    }
    phase += adv;
    while (phase >= 1) {
      phase -= 1;
      for (int j = n; j > 0; --j) h[j] = h[j - 1];
      h[0] = shape;
    }
    const int last = n - 1;
    for (int k = 0; k < n; ++k) {
      const int fwd = reverse ? last - k : k;
      const int back = last - fwd;
      lL[k] = fbClamp01(ageValue(shape, fwd));
      lR[k] = fbClamp01(ageValue(shape, fwd + stereo * (back - fwd)));
    }
  }

  double ageValue(double shape, double age) {
    const double ph = phase;
    const double* h = A(hist);
    if (age <= ph) return ph > 0 ? shape + (h[0] - shape) * (age / ph) : shape;
    const double x = age - ph;
    const double jf = std::floor(x);
    const int j = static_cast<int>(jf);
    const double f = x - jf;
    const double a = h[j];
    return a + (h[j + 1] - a) * f;
  }

  void stepSide(double* u, double* p, double* nx, double where, double drive) {
    const int last = n - 1;
    const double lam = lambda;
    for (int k = 0; k < n; ++k) {
      const double left = k > 0 ? u[k - 1] : (n > 1 ? u[1] : u[0]);
      const double right = k < last ? u[k + 1] : (n > 1 ? u[last - 1] : u[last]);
      const double uk = u[k];
      nx[k] = uk + lam * (uk - p[k]) + c2 * (left + right - 2 * uk);
    }
    const double at = where * last;
    const double jf = std::floor(at);
    const int j = static_cast<int>(jf);
    const double f = at - jf;
    nx[j] += (1 - f) * (drive - nx[j]);
    if (j < last) nx[j + 1] += f * (drive - nx[j + 1]);
    for (int k = 0; k < n; ++k) {
      p[k] = u[k];
      u[k] = nx[k];
    }
  }

  double levelAt(const double* lv, double x) const {
    if (n <= 0) return 1;
    const double jf = std::floor(x);
    const int j = static_cast<int>(jf);
    const double f = x - jf;
    if (f == 0 || j >= n - 1) return lv[j < n ? j : n - 1];
    return lv[j] + (lv[j + 1] - lv[j]) * f;
  }

  bool playable() {
    double s = phase;
    const double* a = A(uL); const double* c = A(uR); const double* h = A(hist);
    for (int k = 0; k < n; ++k) s += a[k] + c[k] + h[k];
    return isPlayable(s);
  }
};

/** The bands: a tuning and a level each, and a stereo band-pass apiece. */
struct BandBank {
  enum { a1, a2, a3, gL, gR, x, amp, on, ic1L, ic2L, ic1R, ic2R, note, vel, held, hz, kArrays };
  Store<kArrays> bands;
  int count = 0;

  double* A(int which) { return bands.a[which]; }

  void reset() {
    bands.fill(ic1L, 0); bands.fill(ic2L, 0); bands.fill(ic1R, 0); bands.fill(ic2R, 0);
  }

  void tune(int i, double freq, double k, double dln, double pan, double sampleRate) {
    A(hz)[i] = freq;
    if (!(freq > 0 && freq < sampleRate * 0.5)) {
      A(on)[i] = 0;
      return;
    }
    const double g = std::tan((kFbPi * freq) / sampleRate);
    A(a1)[i] = 1 / (1 + g * (g + k));
    A(a2)[i] = g * A(a1)[i];
    A(a3)[i] = g * A(a2)[i];
    const double norm = std::sqrt(kTwoOverPi * dln * k);
    const double angle = ((pan + 1) * kFbPi) / 4;
    A(gL)[i] = norm * kFbSqrt2 * std::cos(angle);
    A(gR)[i] = norm * kFbSqrt2 * std::sin(angle);
    A(on)[i] = 1;
  }

  void run(ShapeField& field, double xl, double xr, double* out) {
    const double* lvL = field.A(ShapeField::lvL);
    const double* lvR = field.A(ShapeField::lvR);
    double* A1 = A(a1); double* A2 = A(a2); double* A3 = A(a3);
    double* GL = A(gL); double* GR = A(gR); double* X = A(x); double* AMP = A(amp); double* ON = A(on);
    double* I1L = A(ic1L); double* I2L = A(ic2L); double* I1R = A(ic1R); double* I2R = A(ic2R);
    double yl = 0;
    double yr = 0;
    for (int i = 0; i < count; ++i) {
      if (ON[i] == 0) continue;
      const double levL = field.levelAt(lvL, X[i]) * AMP[i];
      const double levR = field.levelAt(lvR, X[i]) * AMP[i];
      const double c1 = A1[i];
      const double c2 = A2[i];
      const double c3 = A3[i];
      double ic1 = I1L[i];
      double ic2 = I2L[i];
      double v3 = xl * levL - ic2;
      double v1 = c1 * ic1 + c2 * v3;
      double v2 = ic2 + c2 * ic1 + c3 * v3;
      I1L[i] = 2 * v1 - ic1;
      I2L[i] = 2 * v2 - ic2;
      yl += v1 * GL[i];
      ic1 = I1R[i];
      ic2 = I2R[i];
      v3 = xr * levR - ic2;
      v1 = c1 * ic1 + c2 * v3;
      v2 = ic2 + c2 * ic1 + c3 * v3;
      I1R[i] = 2 * v1 - ic1;
      I2R[i] = 2 * v2 - ic2;
      yr += v1 * GR[i];
    }
    out[0] = yl;
    out[1] = yr;
  }

  /**
   * What the bands are doing, for the device window: [count, frequency..., level...] of every
   * band below Nyquist, in the browser's BandBank#report order. Returns the floats written.
   */
  int report(ShapeField& field, float* out, int capacity) {
    const double* ON = A(on);
    int n = 0;
    for (int i = 0; i < count; ++i) if (ON[i] != 0) n += 1;
    if (capacity < 1 + 2 * n) return 0;
    out[0] = static_cast<float>(n);
    const double* lvL = field.A(ShapeField::lvL);
    const double* lvR = field.A(ShapeField::lvR);
    int k = 0;
    for (int i = 0; i < count; ++i) {
      if (ON[i] == 0) continue;
      out[1 + k] = static_cast<float>(A(hz)[i]);
      out[1 + n + k] = static_cast<float>(((field.levelAt(lvL, A(x)[i]) + field.levelAt(lvR, A(x)[i])) / 2) * A(amp)[i]);
      k += 1;
    }
    return 1 + 2 * n;
  }
  /** The room a report needs: everything report() can write. */
  int reportRoom() const { return 1 + 2 * bands.cap; }

  bool playable() {
    double s = 0;
    const double* a = A(ic1L); const double* b = A(ic2L); const double* c = A(ic1R); const double* d = A(ic2R);
    for (int i = 0; i < count; ++i) s += a[i] + b[i] + c[i] + d[i];
    return isPlayable(s);
  }
};

/** Option slots of lists, by slot: grown through the work round like everything else here. */
struct ListSlots {
  Pool<ListRef> slots;
  /** Returns false while there is no room for `slot` yet, as pd_shape must. */
  bool put(int slot, const float* table, int count) {
    if (slot < 0) return true;
    // Room is asked for while half of it is still spare, so a list rarely has to wait for any.
    if (2 * (slot + 1) > slots.size()) slots.ask(2 * (slot + 1));
    if (slot >= slots.size()) return false;
    slots[slot] = ListRef{ table, count };
    return true;
  }
  const ListRef* at(int slot) {
    if (slot < 1 || slot >= slots.size()) return nullptr;
    const ListRef& one = slots[slot];
    return one.table ? &one : nullptr;
  }
};

}  // namespace pd_own
