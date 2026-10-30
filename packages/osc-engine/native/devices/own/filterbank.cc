// The Filterbank effect: band-passes spread evenly across the spectrum, their levels moved every sample.
//
// Translated from web-engine/src/devices/filterbank.mjs, which says how the bands are laid out; the
// picture they are read from is own/dsp/filterbank.h. The bands and cells are grown in the work
// round when the count goes up, so until they land the bank plays the bands it has room for.

#include "own/pd-own.h"
#include "own/dsp/filterbank.h"
#include "pd-own-ids.h"

namespace pd_Filterbank {

namespace ids = pd_ids::Filterbank;
using namespace pd_own;

/** Room made before the device plays: the default count's worth, so a fresh bank waits for nothing. */
constexpr int kFirstBands = 16;

struct Device : pd_own::Device<ids::kCount, 2> {
  ShapeField field;
  BandBank bank;
  ListSlots levels;

  void pd_init(double sr) {
    sampleRate = sr;
    field.cells.reserve(kFirstBands + 1);
    bank.bands.reserve(kFirstBands);
    levels.slots.reserve(2, [](ListRef&) {});
  }

  bool pd_shape(int param, int slot, const float* table, int count) {
    if (!table || count <= 0) return true;
    // A band count on its way: the engine says it when it SENDS the count, which is ahead of the
    // count's own time by the bundle's latency, so the room is made before the bands are played.
    if (param == ids::bands && slot < 0) {
      const int n = static_cast<int>(std::fmax(1.0, jsRound(table[0])));
      field.ask(n);
      bank.bands.ask(n);
      return true;
    }
    if (param != ids::levels) return true;
    return levels.put(slot, table, count);
  }

  int wantedBands() const { return static_cast<int>(std::fmax(1.0, jsRound(p[ids::bands]))); }

  bool pd_work_wanted() {
    const int n = wantedBands();
    field.ask(n);
    bank.bands.ask(n);
    const bool a = field.cells.wanted();
    const bool b = bank.bands.wanted();
    const bool c = levels.slots.wanted();
    return a || b || c;
  }
  void pd_work() { field.cells.build(); bank.bands.build(); levels.slots.build([](ListRef&) {}); }
  void pd_work_done() { field.cells.install(); bank.bands.install(); levels.slots.install(); }
  void pd_work_release() { field.cells.release(); bank.bands.release(); levels.slots.release(); }

  void reset() {
    field.reset();
    bank.reset();
  }

  /** For the device window: every sounding band's frequency and level (see BandBank::report). */
  int pd_report(float* out, int capacity) { return bank.report(field, out, capacity); }
  int pd_report_room() { return bank.reportRoom(); }

  void configure() {
    const double sr = sampleRate;
    int n = wantedBands();
    // The bands there is room for, until the work round has made room for the rest.
    if (n > field.room()) n = field.room();
    if (n > bank.bands.cap) n = bank.bands.cap;
    const double lo = p[ids::low];
    const double hi = p[ids::high];
    const double width = p[ids::width];
    const int slot = jsRoundInt(p[ids::levels]);
    const ListRef* table = slot >= 1 ? levels.at(slot) : nullptr;
    const int mode = static_cast<int>(clamp(jsRound(p[ids::mode]), 0.0, 1.0));
    field.setup(n, sr, mode, p[ids::scroll], p[ids::where], p[ids::wavespeed], p[ids::damping], p[ids::stereo]);
    bank.count = n;
    const double span = std::log(hi / lo);
    const double share = std::fabs(span) / n;
    const double k = 2 * std::sinh((width * share) / 2);
    double* X = bank.A(BandBank::x);
    double* AMP = bank.A(BandBank::amp);
    for (int i = 0; i < n; ++i) {
      bank.tune(i, lo * std::exp((span * (i + 0.5)) / n), k, share, 0, sr);
      X[i] = i;
      AMP[i] = listLevel(table, (i + 0.5) / n);
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

}  // namespace pd_Filterbank

extern "C" PdAny* pd_make_Filterbank() { return new PdAdapter<pd_Filterbank::Device>(); }
