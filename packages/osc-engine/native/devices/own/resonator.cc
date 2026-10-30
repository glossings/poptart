// The Resonator effect: narrow, ringing band-passes on every note of a scale, or on held notes.
//
// Translated from web-engine/src/devices/resonator.mjs, which says what it is tuned to and how;
// the picture its levels are read from is own/dsp/filterbank.h. A note lands on its own sample:
// the host cuts the block there (PoptartDevice's note path) and the call comes between the pieces.
//
// Everything that has a count - the notes of the scale in range, the notes held - is grown in the
// work round, AHEAD of being needed, so the desktop plays what the browser plays: a scale's room is
// made when its table arrives (before the control that selects it is due), with a period to spare
// for any shift, and held notes ask for more room while half of theirs is still free. Room for 128
// held notes (every MIDI key) is made before the device plays.

#include "own/pd-own.h"
#include "own/dsp/filterbank.h"
#include "pd-own-ids.h"

namespace pd_Resonator {

namespace ids = pd_ids::Resonator;
using namespace pd_own;

constexpr double kLn1000 = 6.907755278982137;
constexpr double kPhi = 1.618033988749895;
constexpr double kLn2 = 0.6931471805599453;
/** Room made before the device plays for held notes: every MIDI key at once. */
constexpr int kFirstNotes = 128;

inline double audiblePos(double freq) { return std::log2(freq / kAudibleLow) / std::log2(kAudibleHigh / kAudibleLow); }

inline double spreadSign(double x) {
  const double v = x * kPhi;
  return 2 * (v - std::floor(v)) - 1;
}

struct Device : pd_own::Device<ids::kCount, 2> {
  ShapeField field;
  BandBank bank;
  ListSlots levels;
  ListSlots scales;
  enum { pitch, step, kScaleArrays };
  Store<kScaleArrays> scale;
  int cellCount = 0;
  bool overflow = false;
  bool noteRouted = false;
  int slots = 0;
  double layPeriod = 12;
  int layCount = 12;

  void pd_init(double sr) {
    sampleRate = sr;
    // Room for the tuning it starts on (every semitone) at any shift, and for every MIDI key held.
    const int cells = scaleRoom(nullptr);
    field.cells.reserve(cells + 1);
    scale.reserve(cells);
    bank.bands.reserve(cells > kFirstNotes ? cells : kFirstNotes);
    levels.slots.reserve(2, [](ListRef&) {});
    scales.slots.reserve(2, [](ListRef&) {});
    noteRouted = false;
    slots = 0;
  }

  bool pd_shape(int param, int slot, const float* table, int count) {
    if (!table || count <= 0) return true;
    if (param == ids::levels) return levels.put(slot, table, count);
    if (param == ids::scale) {
      // A scale arrives ahead of the control that selects it, so its room is made on arrival.
      const ListRef one{ table, count };
      askRoom(scaleRoom(&one));
      return scales.put(slot, table, count);
    }
    return true;
  }

  /**
   * The cells a scale can need: its notes in the audible range at the shift there is now, and one
   * period's worth more, which is as many as any other shift can add - a window over a scale that
   * repeats every period holds at most that many more or fewer of its notes.
   */
  int scaleRoom(const ListRef* table) {
    const bool given = table && table->count >= 3;
    const double root = given ? table->table[0] : 0;
    const double period = given ? table->table[1] : 12;
    const int count = given ? table->count - 2 : 12;
    if (!(period > 0) || count <= 0) return 0;
    auto interval = [&](int i) -> double { return given ? static_cast<double>(table->table[2 + i]) : static_cast<double>(i); };
    const double pLo = 69 + 12 * std::log2(kAudibleLow / 440);
    const double pHi = 69 + 12 * std::log2(std::fmin(kAudibleHigh, sampleRate * 0.5) / 440);
    double lowest = interval(0);
    for (int i = 1; i < count; ++i) if (interval(i) < lowest) lowest = interval(i);
    const double base = root + p[ids::shift];
    int n = 0;
    for (double o = std::floor((pLo - base - lowest) / period) - 1; base + o * period + lowest < pHi; o += 1) {
      for (int i = 0; i < count; ++i) {
        const double pt = base + o * period + interval(i);
        if (pt >= pLo && pt < pHi) n += 1;
      }
    }
    return n + count;
  }

  void askRoom(int cells) {
    field.ask(cells);
    scale.ask(cells);
    bank.bands.ask(cells);
  }

  void pd_note_route(bool on) {
    noteRouted = on;
    if (!noteRouted) slots = 0;
  }

  void pd_note_on(float noteIn, float velocityIn) {
    noteRouted = true;
    play(noteIn, velocityIn > 0 ? velocityIn : 0);
  }

  void pd_note_off(float noteIn) { play(noteIn, 0); }

  void play(double note, double velocity) {
    double* N = bank.A(BandBank::note);
    double* V = bank.A(BandBank::vel);
    double* H = bank.A(BandBank::held);
    if (velocity <= 0) {
      for (int i = 0; i < slots; ++i) {
        if (N[i] == note && H[i] != 0) H[i] = 0;
      }
      return;
    }
    int at = -1;
    for (int i = 0; i < slots && at < 0; ++i) if (N[i] == note) at = i;
    for (int i = 0; i < slots && at < 0; ++i) if (H[i] == 0) at = i;
    if (at < 0) {
      if (slots >= bank.bands.cap) {
        bank.bands.ask(2 * (slots + 1));
        return;
      }
      at = slots;
      slots += 1;
    }
    N[at] = note;
    V[at] = velocity;
    H[at] = 1;
    // More room is asked for while half of it is still spare, so a new note never waits for any.
    if (2 * slots > bank.bands.cap) bank.bands.ask(2 * bank.bands.cap);
  }

  const ListRef* scaleTable() {
    const int slot = jsRoundInt(p[ids::scale]);
    return slot >= 1 ? scales.at(slot) : nullptr;
  }

  /** The scale's notes across the audible range, shifted: the cells, lowest first. */
  void layScale(const ListRef* table, double shift) {
    double root = 0;
    double period = 12;
    int count = 12;
    const bool given = table && table->count >= 3;
    if (given) {
      root = table->table[0];
      period = table->table[1];
      count = table->count - 2;
    }
    auto interval = [&](int i) -> double { return given ? static_cast<double>(table->table[2 + i]) : static_cast<double>(i); };
    const double pLo = 69 + 12 * std::log2(kAudibleLow / 440);
    const double pHi = 69 + 12 * std::log2(std::fmin(kAudibleHigh, sampleRate * 0.5) / 440);
    double* P = scale.a[pitch];
    double* S = scale.a[step];
    const int cap = scale.cap;
    int n = 0;
    int wanted = 0;
    if (period > 0 && count > 0) {
      double lowest = interval(0);
      for (int i = 1; i < count; ++i) if (interval(i) < lowest) lowest = interval(i);
      const double base = root + shift;
      for (double o = std::floor((pLo - base - lowest) / period) - 1; base + o * period + lowest < pHi; o += 1) {
        for (int i = 0; i < count; ++i) {
          const double pt = base + o * period + interval(i);
          if (!(pt >= pLo && pt < pHi)) continue;
          wanted += 1;
          if (n >= cap) continue;
          int j = n;
          while (j > 0 && P[j - 1] > pt) {
            P[j] = P[j - 1];
            S[j] = S[j - 1];
            j -= 1;
          }
          P[j] = pt;
          S[j] = o * count + i;
          n += 1;
        }
      }
    }
    cellCount = n;
    layPeriod = period;
    layCount = count;
    if (wanted > cap) scale.ask(wanted);
    overflow = wanted > n;
  }

  double cellOf(double pt) {
    const int n = cellCount;
    const double* P = scale.a[pitch];
    if (n <= 1 || pt <= P[0]) return 0;
    if (pt >= P[n - 1]) return n - 1;
    int c = 0;
    while (P[c + 1] <= pt) c += 1;
    return c + (pt - P[c]) / (P[c + 1] - P[c]);
  }

  bool pd_work_wanted() {
    // The room this block's settings want: the scale's notes in range and a band for each.
    layScale(scaleTable(), p[ids::shift]);
    // Whatever the scale in force can need at any shift (see scaleRoom).
    askRoom(scaleRoom(scaleTable()));
    const bool a = scale.wanted();
    const bool b = field.cells.wanted();
    const bool c = bank.bands.wanted();
    const bool d = levels.slots.wanted();
    const bool e = scales.slots.wanted();
    return a || b || c || d || e;
  }
  void pd_work() {
    scale.build(); field.cells.build(); bank.bands.build();
    levels.slots.build([](ListRef&) {}); scales.slots.build([](ListRef&) {});
  }
  void pd_work_done() {
    scale.install(); field.cells.install(); bank.bands.install();
    levels.slots.install(); scales.slots.install();
  }
  void pd_work_release() {
    scale.release(); field.cells.release(); bank.bands.release();
    levels.slots.release(); scales.slots.release();
  }

  void reset() {
    field.reset();
    bank.reset();
  }

  /** For the device window: every sounding band's frequency and level (see BandBank::report). */
  int pd_report(float* out, int capacity) { return bank.report(field, out, capacity); }
  int pd_report_room() { return bank.reportRoom(); }

  void configure() {
    const double sr = sampleRate;
    const double shift = p[ids::shift];
    const double tilt = p[ids::tilt];
    const double spread = clamp(p[ids::spread], 0.0, 1.0);
    const double decay = p[ids::decay];
    const int levelsSlot = jsRoundInt(p[ids::levels]);
    const ListRef* lv = levelsSlot >= 1 ? levels.at(levelsSlot) : nullptr;
    layScale(scaleTable(), shift);
    int n = cellCount;
    if (n > field.room()) n = field.room();
    cellCount = n;
    const int mode = static_cast<int>(clamp(jsRound(p[ids::mode]), 0.0, 1.0));
    field.setup(n, sr, mode, p[ids::scroll], p[ids::where], p[ids::wavespeed], p[ids::damping], p[ids::stereo]);
    double* X = bank.A(BandBank::x);
    double* AMP = bank.A(BandBank::amp);
    if (noteRouted) {
      const double* N = bank.A(BandBank::note);
      const double* V = bank.A(BandBank::vel);
      const double* H = bank.A(BandBank::held);
      bank.count = slots;
      const double dln = kLn2 / 12;
      for (int i = 0; i < slots; ++i) {
        const double pt = N[i] + shift;
        const double sign = spreadSign(N[i]);
        const double freq = pitchHz(pt + spread * sign * 0.5);
        bank.tune(i, freq, kLn1000 / (kFbPi * freq * decay), dln, spread * sign, sr);
        X[i] = cellOf(pt);
        const double pos = n > 0 ? (X[i] + 0.5) / n : 0.5;
        AMP[i] = H[i] != 0
          ? listLevel(lv, pos) * std::pow(10.0, (tilt * (audiblePos(freq) - 0.5)) / 20) * V[i]
          : 0;
      }
      return;
    }
    if (n > bank.bands.cap) n = bank.bands.cap;
    bank.count = n;
    const double* P = scale.a[pitch];
    const double* S = scale.a[step];
    const double dln = ((layPeriod / layCount) * kLn2) / 12;
    for (int i = 0; i < n; ++i) {
      const double sign = spreadSign(S[i]);
      const double up = i < n - 1 ? P[i + 1] - P[i] : (i > 0 ? P[i] - P[i - 1] : 0);
      const double down = i > 0 ? P[i] - P[i - 1] : up;
      const double half = (sign > 0 ? up : down) / 2;
      const double freq = pitchHz(P[i] + spread * sign * half);
      bank.tune(i, freq, kLn1000 / (kFbPi * freq * decay), dln, spread * sign, sr);
      X[i] = i;
      AMP[i] = listLevel(lv, (i + 0.5) / n) * std::pow(10.0, (tilt * (audiblePos(freq) - 0.5)) / 20);
    }
  }

  void pd_process(int frames) {
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    configure();
    double out[2] = { 0, 0 };
    for (int i = 0; i < frames; ++i) {
      field.tick(ctl(ids::shape, i));
      const double xl = inl[i];
      const double xr = inr[i];
      bank.run(field, xl, xr, out);
      const double mix = ctl(ids::mix, i);
      outl[i] = static_cast<float>(xl + (out[0] - xl) * mix);
      outr[i] = static_cast<float>(xr + (out[1] - xr) * mix);
    }
    if (!field.playable() || !bank.playable()) reset();
  }
};

}  // namespace pd_Resonator

extern "C" PdAny* pd_make_Resonator() { return new PdAdapter<pd_Resonator::Device>(); }
