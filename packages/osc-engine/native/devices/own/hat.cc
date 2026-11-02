// The Hat: an analog-style hi-hat, one hit at a time.
//
// Translated from web-engine/src/devices/hat.mjs, which says what each part is and why. The same
// state, the same arithmetic in the same order, in double; the parity test holds the two together.
// A control a signal moves is read per sample where the browser reads it per sample (see
// own/pd-own.h).

#include "own/pd-own.h"
#include "own/dsp/filters.h"
#include "own/dsp/metal.h"
#include "pd-own-ids.h"

namespace pd_Hat {

namespace ids = pd_ids::Hat;
using namespace pd_own;

constexpr int kSources = 4;
constexpr int kSourceThin = 1;
constexpr int kSourceDense = 2;
constexpr int kSourceBell = 3;
constexpr double kRootNote = 60;
constexpr double kMetalWidth = 0.48;
constexpr double kThinHz[kMetalCount] = { 245, 306, 365, 415, 437, 619 };
constexpr double kDenseHz[kMetalCount] = { 263.5, 331.7, 426.2, 471.9, 587.3, 713.1 };
constexpr int kBellKept = 2;
constexpr double kNoiseGain = 0.6;
constexpr double kToneDarkHz = 500;
constexpr double kToneBrightHz = 20000;
constexpr double kBandResonance = 0.6;
constexpr double kBellResonance = 0.9;
constexpr double kBodyResonance = 0.7;
constexpr double kHighpassRatio = 0.8;
constexpr double kBodyHighpassRatio = 0.6;
constexpr double kWideResonance = 0;
constexpr double kWideHighpassRatio = 0.25;
constexpr double kWideGain = 0.4;
constexpr double kBellGain = 1.4;
constexpr double kBodyRatio = 0.48;
constexpr double kBodyLength = 6;
constexpr double kBodyGain = 1.5;
constexpr double kAccentTone = 0.12;
constexpr double kJitterTone = 0.015;
constexpr double kJitterDecay = 0.06;
constexpr double kLofiRateTop = 44000;
constexpr double kLofiRateBottom = 16000;
constexpr double kLofiBitsTop = 16;
constexpr double kLofiBitsBottom = 4;
constexpr double kLofiFilter = 0.45;
constexpr double kHoldFloor = 0.85;
constexpr double kDecayDb = 60;
constexpr double kWarpLevel = 2.6;
constexpr double kRingTop = 0.97;
constexpr double kSweepSec = 0.03;
constexpr double kSweepDone = 1e-3;
constexpr double kChokeSec = 0.003;
constexpr double kGain = 5;

inline double lofiRate(double lofi, double sampleRate) {
  return std::fmin(0.9 * sampleRate, kLofiRateTop * std::pow(kLofiRateBottom / kLofiRateTop, lofi * lofi));
}
inline double lofiBits(double lofi) { return kLofiBitsTop - (kLofiBitsTop - kLofiBitsBottom) * lofi; }
inline double toneHz(double tone) { return kToneDarkHz * std::pow(kToneBrightHz / kToneDarkHz, tone); }
inline double draw(unsigned int seed) { return static_cast<double>((seed >> 8) & 0xffffu) / 32768.0 - 1; }
inline unsigned int nextSeed(unsigned int seed) { return seed * 1664525u + 1013904223u; }

/** hat.mjs's Lofi: a lowpass, then a sample-and-hold read at its own tick, its steps band-limited. */
struct Lofi {
  double sampleRate = 48000.0;
  Svf filter;
  HistoryLine history;
  BlepLine line;
  double phase = 0, held = 0, lastRate = -1;

  void init(double sr) { sampleRate = sr; filter.init(sr); reset(); }

  void reset() {
    filter.reset();
    history.reset();
    line.reset();
    phase = 0; held = 0; lastRate = -1;
  }

  double next(double x, double lofi) {
    if (!(lofi > 0)) {
      history.push(x);
      const double late = history.at(kBlepHalf);
      held = late;
      return line.push(late);
    }
    return hold(x, lofiRate(lofi, sampleRate), lofiBits(lofi));
  }

  double hold(double x, double rate, double bits) {
    if (rate != lastRate) {
      filter.setCutoff(kLofiFilter * rate, 0);
      lastRate = rate;
    }
    history.push(filter.next(x, 0));
    const double dt = rate / sampleRate;
    phase += dt;
    if (phase >= 1) {
      phase -= 1;
      const double ago = phase / dt;
      const double q = std::pow(2.0, bits - 1);
      const double v = std::floor(history.read(ago) * q + 0.5) / q;
      line.jump(ago, v - held);
      held = v;
    }
    return line.push(held);
  }
};

/** The squares, the noise and Lofi, shared by both hits. */
struct Source {
  MetalSource analog, thin, extra;
  double levels[kMetalCount] = { 0 };
  Lofi lofi;
  unsigned int state = 1;

  void init(double sr) {
    analog.init(sr, kMetalHz, kMetalWidth);
    thin.init(sr, kThinHz, 0.5);
    extra.init(sr, kDenseHz, 0.5);
    lofi.init(sr);
    reset();
  }

  void reset() {
    analog.reset(); thin.reset(); extra.reset(); lofi.reset();
    state = 1;
  }

  double white() {
    unsigned int x = state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    state = x;
    return static_cast<double>(x) / 2147483648.0 - 1.0;
  }

  double next(int source, double ratio, double noise, double warp, double lf) {
    double metal;
    int count;
    if (source == kSourceBell) {
      count = kBellKept;
      for (int k = 0; k < kMetalCount; ++k) levels[k] = k < kMetalCount - kBellKept ? 0.0 : 1.0 / count;
      metal = analog.nextFolded(ratio, levels, warp);
    } else if (source == kSourceThin) {
      count = kMetalCount;
      for (double& l : levels) l = 1.0 / count;
      metal = thin.nextFolded(ratio, levels, warp);
    } else if (source == kSourceDense) {
      count = 2 * kMetalCount;
      for (double& l : levels) l = 1.0 / count;
      metal = analog.nextFolded(ratio, levels, warp) + extra.nextFolded(ratio, levels, warp);
    } else {
      count = kMetalCount;
      for (double& l : levels) l = 1.0 / count;
      metal = analog.nextFolded(ratio, levels, warp);
    }
    const double loud = std::sqrt(static_cast<double>(count) / kMetalCount) / (1 + kWarpLevel * warp);
    const double x = metal * loud * (1 - noise) + white() * kNoiseGain * noise;
    return lofi.next(x, lf);
  }
};

/** hat.mjs's BandEnvelope. */
struct BandEnvelope {
  double sampleRate = 48000.0;
  double level = 1, lastDecay = -1, lastFloor = -1, k = 1;

  void start() { level = 1; lastDecay = -1; lastFloor = -1; k = 1; }

  double next(double decay, double floor) {
    if (decay != lastDecay || floor != lastFloor) {
      const double target = floor + std::pow(10.0, -kDecayDb / 20) * (1 - floor);
      k = std::exp(std::log(target) / (decay * sampleRate));
      lastDecay = decay;
      lastFloor = floor;
    }
    const double out = (level - floor) / (1 - floor);
    level *= k;
    return out > 0 ? out : 0.0;
  }
};

struct Voice {
  double sampleRate = 48000.0;
  Svf band, high, bodyBand, bodyHigh;
  BandEnvelope env, bodyEnv;
  bool active = false;
  double velocity = 1, toneShift = 0, decayScale = 1;
  int choke = -1;
  double lastTone = -1;
  int lastSource = -1;
  double lastRing = -1, lastShift = 0, swept = 1, ringGain = 1, kSweep = 1;
  long long age = 0;

  void init(double sr) {
    sampleRate = sr;
    band.init(sr); high.init(sr); bodyBand.init(sr); bodyHigh.init(sr);
    env.sampleRate = sr; bodyEnv.sampleRate = sr;
    kSweep = std::exp(-1 / (kSweepSec * sr));
    reset();
    age = 0;
  }

  void reset() {
    active = false;
    velocity = 1; toneShift = 0; decayScale = 1;
    choke = -1; lastTone = -1; lastSource = -1;
    lastRing = -1; lastShift = 0; swept = 1; ringGain = 1;
    env.start(); bodyEnv.start();
    band.reset(); high.reset(); bodyBand.reset(); bodyHigh.reset();
  }

  void noteOn(double vel, double shift, double scale) {
    reset();
    active = true;
    velocity = vel;
    toneShift = shift;
    decayScale = scale;
  }

  int chokeLength() const {
    const double c = jsRound(kChokeSec * sampleRate);
    return c < 1 ? 1 : static_cast<int>(c);
  }

  void chokeOff() { if (active && choke < 0) choke = chokeLength(); }

  double next(double x, int source, double tone, double decay, double hold, double body, double ring, double sweep, double level) {
    const double t = clamp(tone + toneShift, 0.0, 1.0);
    double shift = sweep * velocity * swept;
    if (std::fabs(shift) < kSweepDone) shift = 0;
    swept *= kSweep;
    if (t != lastTone || source != lastSource || ring != lastRing || shift != lastShift) {
      const double hz = toneHz(t) * std::pow(2.0, shift / 12);
      const bool wide = source == kSourceDense;
      band.setCutoff(hz, wide ? kWideResonance : source == kSourceBell ? kBellResonance : kBandResonance);
      high.setCutoff(hz * (wide ? kWideHighpassRatio : kHighpassRatio), ring * kRingTop);
      bodyBand.setCutoff(hz * kBodyRatio, wide ? kWideResonance : kBodyResonance);
      bodyHigh.setCutoff(hz * kBodyRatio * (wide ? kWideHighpassRatio : kBodyHighpassRatio), 0);
      lastTone = t;
      lastSource = source;
      lastRing = ring;
      lastShift = shift;
      ringGain = std::sqrt(high.k / 2);
    }
    const double d = decay * decayScale;
    const double floor = hold * kHoldFloor;
    const double e = env.next(d, floor);
    const double eBody = bodyEnv.next(d * kBodyLength, floor);
    const double upper = high.next(band.next(x, 2) * band.k * e, 1) * ringGain;
    const double lower = bodyHigh.next(bodyBand.next(x, 2) * bodyBand.k * eBody, 1);
    const double out = upper + lower * body * kBodyGain;
    double gain = velocity * level * kGain * (source == kSourceDense ? kWideGain : source == kSourceBell ? kBellGain : 1.0);
    if (choke >= 0) {
      gain *= static_cast<double>(choke) / chokeLength();
      choke -= 1;
      if (choke < 0) active = false;
    }
    if (e <= 0 && (eBody <= 0 || body <= 0) && std::fabs(upper) + std::fabs(lower * body) < 1e-6) active = false;
    return out * gain;
  }
};

using Base = pd_own::Device<ids::kCount, 2>;

struct Device : Base {
  Source source;
  Voice voices[2];
  long long clock = 0;
  unsigned int seed = 1;
  double note = kRootNote;
  double bend = 0;
  struct Event { double note; double velocity; };
  Event events[64];
  int eventCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    source.init(sr);
    for (auto& v : voices) v.init(sr);
    clock = 0;
    seed = 1;
    note = kRootNote;
    bend = 0;
    eventCount = 0;
  }

  void pd_note_on(float n, float velocity) {
    if (eventCount < 64) events[eventCount++] = { n, velocity };
  }

  /** A hit plays out whatever the note's length; all notes off fades whatever is sounding. */
  void pd_note_off(float n) {
    if (n < 0) {
      eventCount = 0;
      for (auto& v : voices) v.chokeOff();
    }
  }

  void pd_bend(float semitones) { bend = isPlayable(semitones) ? semitones : 0.0; }

  void startNote(double n, double velocity) {
    Voice* voice = nullptr;
    for (auto& v : voices) if (!v.active) { voice = &v; break; }
    if (!voice) voice = voices[0].age <= voices[1].age ? &voices[0] : &voices[1];
    for (auto& v : voices) if (&v != voice) v.chokeOff();
    seed = nextSeed(seed);
    const double toneDraw = draw(seed);
    seed = nextSeed(seed);
    const double decayDraw = draw(seed);
    const double shift = kAccentTone * (clamp(velocity, 0.0, 1.0) - 1) + kJitterTone * toneDraw;
    voice->noteOn(velocity, shift, 1 + kJitterDecay * decayDraw);
    voice->age = clock++;
    note = n;
  }

  void pd_process(int frames) {
    for (int i = 0; i < eventCount; ++i) startNote(events[i].note, events[i].velocity);
    eventCount = 0;
    float* outl = outL();
    float* outr = outR();
    std::memset(outl, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(outr, 0, sizeof(float) * static_cast<size_t>(frames));
    Voice& a = voices[0];
    Voice& b = voices[1];
    for (int i = 0; i < frames; ++i) {
      if (!a.active && !b.active) break;
      const double ratio = std::pow(2.0, (note + bend - kRootNote) / 12);
      const int src = static_cast<int>(clamp(jsRound(ctl(ids::source, i)), 0.0, kSources - 1.0));
      const double noise = clamp(ctl(ids::noise, i), 0.0, 1.0);
      const double lf = clamp(ctl(ids::lofi, i), 0.0, 1.0);
      const double warp = clamp(ctl(ids::warp, i), 0.0, 1.0);
      const double x = source.next(src, ratio, noise, warp, lf);
      const double tone = clamp(ctl(ids::tone, i), 0.0, 1.0);
      const double decay = std::fmax(1e-3, ctl(ids::decay, i));
      const double hold = clamp(ctl(ids::hold, i), 0.0, 1.0);
      const double body = clamp(ctl(ids::body, i), 0.0, 1.0);
      const double ring = clamp(ctl(ids::ring, i), 0.0, 1.0);
      const double sweep = ctl(ids::filtersweep, i);
      const double level = ctl(ids::level, i);
      double v = 0;
      if (a.active) v += a.next(x, src, tone, decay, hold, body, ring, sweep, level);
      if (b.active) v += b.next(x, src, tone, decay, hold, body, ring, sweep, level);
      outl[i] = static_cast<float>(outl[i] + v);
      outr[i] = static_cast<float>(outr[i] + v);
    }
    const Lofi& lf = source.lofi;
    if (!isPlayable(lf.held + lf.filter.ic1)) source.reset();
    for (auto& v : voices) {
      if (!isPlayable(v.band.ic1 + v.high.ic1 + v.bodyBand.ic1 + v.bodyHigh.ic1 + v.env.level + v.bodyEnv.level)) v.reset();
    }
  }
};

}  // namespace pd_Hat

extern "C" PdAny* pd_make_Hat() { return new PdAdapter<pd_Hat::Device>(); }
