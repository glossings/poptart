// The Pluck synth: a plucked string per voice, by Karplus-Strong.
//
// Translated from web-engine/src/devices/pluck.mjs, which explains the loop. The one difference
// is where the memory comes from: each voice's lines are fixed arrays sized for the lowest note at
// 96 kHz, and sized down from there with the browser's arithmetic.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "pd-own-ids.h"

namespace pd_Pluck {

namespace ids = pd_ids::Pluck;
using namespace pd_own;

/** The voices a fresh device has room for (see the Wavetable's kFirstVoices). */
constexpr int kFirstVoices = 16;

constexpr double kLowestHz = 25;
constexpr double kHighestShare = 1.0 / 7;
constexpr int kStretchStages = 4;
constexpr double kStretchTightest = 1.5;
constexpr double kStretchRange = 64;
constexpr double kStretchMost = 0.999;
constexpr double kDampingRange = 100;
constexpr double kDampingFloor = 1.5;
constexpr double kMostGain = 0.99999;
constexpr double kShortestWhole = 1.5;
constexpr int kFitTries = 24;
constexpr double kBurstReference = 0.004;
constexpr double kExciteGain = 0.7;
constexpr double kVoiceGain = 0.8;
constexpr double kSilent = 1e-5;
constexpr double kFollowFall = 0.05;
constexpr double kPi = 3.141592653589793;

/** The longest line, at 96 kHz: the lowest note's period, and a little. */
constexpr int kLineCapacity = 4096;

inline double allpassDelay(double c, double w) {
  return 1 - (2 * std::atan2(c * std::sin(w), 1 + c * std::cos(w))) / w;
}

inline double lowpassDelay(double b, double w) {
  return std::atan2(b * std::sin(w), 1 - b * std::cos(w)) / w;
}

struct Tune {
  int whole = 1;
  double eta = 0, b = 0, c = 0, gain = 0, period = 4;
};

/** Everything one string's loop needs to play `hz` at these settings (pluck.mjs's tuneString). */
inline void tuneString(double hz, double sampleRate, double damping, double stretch, double seconds, Tune& out) {
  const double f = std::fmin(sampleRate * kHighestShare, std::fmax(kLowestHz, hz));
  const double w = (2 * kPi * f) / sampleRate;
  const double period = sampleRate / f;
  const double low = std::fmin(kMostGain, std::pow(10.0, -3 / (f * std::fmax(0.01, seconds))));
  const double shorter = std::pow(kDampingRange, clamp(damping, 0.0, 1.0));
  const double high = std::pow(10.0, -3 / (f * std::fmax(0.01, seconds) / shorter));
  const double floorPole = std::exp((-2 * kPi * std::fmin(sampleRate * 0.45, f * kDampingFloor)) / sampleRate);
  double b = std::fmin(floorPole, (low - high) / (low + high));
  const double stiff = clamp(stretch, 0.0, 1.0);
  double c = stiff > 0
    ? -std::fmin(kStretchMost, std::fmax(0.0, 1 - kStretchTightest * std::pow(kStretchRange, 1 - stiff) * w))
    : 0.0;
  double rest = period - lowpassDelay(b, w) - kStretchStages * allpassDelay(c, w);
  for (int i = 0; i < kFitTries && rest < kShortestWhole; ++i) {
    if (c < -1e-6) c *= 0.5;
    else b *= 0.5;
    rest = period - lowpassDelay(b, w) - kStretchStages * allpassDelay(c, w);
  }
  int whole = static_cast<int>(std::floor(rest - 0.5));
  if (whole < 1) whole = 1;
  const double d = rest - whole;
  out.whole = whole;
  out.eta = std::sin((w * (1 - d)) / 2) / std::sin((w * (1 + d)) / 2);
  out.b = b;
  out.c = c;
  out.gain = low;
  out.period = period;
}

struct PluckString {
  double line[kLineCapacity] = { 0 };
  int mask = kLineCapacity - 1;
  double ap[kStretchStages * 2] = { 0 };
  Tune tune;
  int pos = 0;
  double frac = 0;
  double lp = 0;

  void init(int size) {
    mask = size - 1;
    reset();
  }

  void reset() {
    std::memset(line, 0, sizeof(line));
    std::memset(ap, 0, sizeof(ap));
    pos = 0;
    frac = 0;
    lp = 0;
  }

  double next(double input) {
    const Tune& t = tune;
    const double u0 = line[(pos - t.whole) & mask];
    const double u1 = line[(pos - t.whole - 1) & mask];
    const double d = t.eta * u0 + u1 - t.eta * frac;
    frac = d;
    lp = (1 - t.b) * d + t.b * lp;
    double v = lp;
    for (int k = 0; k < kStretchStages; ++k) {
      const double y = t.c * v + ap[2 * k] - t.c * ap[2 * k + 1];
      ap[2 * k] = v;
      ap[2 * k + 1] = y;
      v = y;
    }
    v *= t.gain;
    line[pos] = input + v;
    pos = (pos + 1) & mask;
    return v;
  }
};

/** Every control for the block, in real units. */
struct Params {
  double bend = 0;
};

using Base = pd_own::Device<ids::kCount, 2>;

struct Voice {
  double sampleRate = 48000.0;
  PluckString left, right;
  double history[kLineCapacity] = { 0 };
  int mask = kLineCapacity - 1;
  double fall = 0;
  double note = -1;
  double velocity = 1;
  long long age = 0;
  bool releasing = false;
  int holds = 0;
  bool sounding = false;
  int burstLeft = 0;
  int burstLength = 1;
  double burstGain = 1;
  unsigned int seed = 1;
  int hpos = 0;
  double tone1 = 0, tone2 = 0, follow = 0;

  void init(double sr) {
    sampleRate = sr;
    int size = 16;
    while (size < static_cast<int>(std::ceil(sr / kLowestHz)) + 8 && size < kLineCapacity) size *= 2;
    left.init(size);
    right.init(size);
    mask = size - 1;
    fall = std::exp(-1 / (kFollowFall * sr));
    note = -1; velocity = 1; age = 0; releasing = false; holds = 0; sounding = false;
    burstLeft = 0; burstLength = 1; burstGain = 1; seed = 1;
    reset();
  }

  void reset() {
    left.reset();
    right.reset();
    std::memset(history, 0, sizeof(history));
    hpos = 0;
    tone1 = 0;
    tone2 = 0;
    follow = 0;
  }

  bool active() const { return sounding; }

  void noteOn(double n, double vel, unsigned int s, int burstSamples) {
    if (!sounding) reset();
    note = n;
    velocity = vel;
    releasing = false;
    seed = s ? s : 1u;
    burstLength = burstSamples > 1 ? burstSamples : 1;
    burstLeft = burstLength;
    burstGain = std::sqrt(std::fmin(1.0, (kBurstReference * sampleRate) / burstLength));
    sounding = true;
  }

  void noteOff() { releasing = true; }

  double white() {
    unsigned int x = seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    seed = x;
    return static_cast<double>(x) / 2147483648.0 - 1;
  }

  void process(float* outL, float* outR, int count, const Params& p, const Base& c) {
    const double sr = sampleRate;
    const double pitch = note + p.bend;
    const double detune = std::fmax(0.0, c.ctl(ids::detune, 0)) / 200;
    const double damping = c.ctl(ids::damping, 0);
    const double stretch = c.ctl(ids::stretch, 0);
    const double seconds = releasing ? c.ctl(ids::release, 0) : c.ctl(ids::decay, 0);
    tuneString(midiToHz(pitch - detune), sr, damping, stretch, seconds, left.tune);
    tuneString(midiToHz(pitch + detune), sr, damping, stretch, seconds, right.tune);
    const double toneK = 1 - std::exp((-2 * kPi * std::fmin(sr * 0.45, std::fmax(20.0, c.ctl(ids::tone, 0)))) / sr);
    const double position = clamp(c.ctl(ids::position, 0), 0.0, 0.5);
    const int comb = jsRoundInt(position * left.tune.period);
    for (int i = 0; i < count; ++i) {
      double e = 0;
      if (burstLeft > 0) {
        e = white() * (static_cast<double>(burstLeft) / burstLength) * burstGain;
        burstLeft -= 1;
      }
      tone1 += toneK * (e - tone1);
      tone2 += toneK * (tone1 - tone2);
      double x = tone2;
      history[hpos] = x;
      if (comb >= 1) x -= history[(hpos - comb) & mask];
      hpos = (hpos + 1) & mask;
      x *= velocity * kExciteGain;
      const double l = left.next(x);
      const double r = right.next(x);
      const double level = c.ctl(ids::level, i) * kVoiceGain;
      outL[i] = static_cast<float>(outL[i] + l * level);
      outR[i] = static_cast<float>(outR[i] + r * level);
      const double peak = std::fmax(std::fabs(x), std::fmax(std::fabs(l), std::fabs(r)));
      follow = peak > follow ? peak : follow * fall;
    }
    if (!isPlayable(follow)) reset();
    if (burstLeft <= 0 && follow < kSilent) sounding = false;
  }
};

struct Device : Base {
  Params params;
  Pool<Voice> voices;
  int voiceCount = 8;
  long long clock = 0;
  unsigned int seed = 1;
  struct Event { int kind; double note; double velocity; };
  Event events[64];
  int eventCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    voices.reserve(kFirstVoices, [](Voice&) {});
    for (auto& v : voices) v.init(sr);
    params = Params();
    voiceCount = 8;
    clock = 0;
    seed = 1;
    eventCount = 0;
  }

  void pd_note_on(float note, float velocity) {
    if (eventCount < 64) events[eventCount++] = { 1, note, velocity };
  }

  void pd_note_off(float note) {
    if (note < 0) {
      eventCount = 0;
      for (auto& v : voices) {
        v.holds = 0;
        if (v.active()) v.noteOff();
      }
      return;
    }
    if (eventCount < 64) events[eventCount++] = { 0, note, 0 };
  }

  void pd_bend(float semitones) { params.bend = isPlayable(semitones) ? semitones : 0.0; }

  void readParams() {
    // As many as asked for, room grown through the work round (see the Wavetable's).
    const double want = jsRound(p[ids::voices]);
    const int asked = want < 1 ? 1 : (want > 1e6 ? 1000000 : static_cast<int>(want));
    voices.ask(asked);
    voiceCount = asked < voices.size() ? asked : voices.size();
  }

  bool pd_work_wanted() { return voices.wanted(); }
  void pd_work() {
    const double sr = sampleRate;
    voices.build([sr](Voice& v) { v.init(sr); });
  }
  void pd_work_done() { voices.install(); }
  void pd_work_release() { voices.release(); }

  Voice* allocate(double note) {
    Voice* free = nullptr;
    Voice* oldestReleasing = nullptr;
    Voice* oldest = nullptr;
    for (int i = 0; i < voiceCount; ++i) {
      Voice& v = voices[i];
      if (v.active() && v.note == note && !v.releasing) return &v;
      if (!v.active()) { if (!free) free = &v; continue; }
      if (v.releasing && (!oldestReleasing || v.age < oldestReleasing->age)) oldestReleasing = &v;
      if (!oldest || v.age < oldest->age) oldest = &v;
    }
    if (free) return free;
    if (oldestReleasing) return oldestReleasing;
    if (oldest) return oldest;
    return &voices[0];
  }

  void startNote(double note, double velocity) {
    Voice* voice = allocate(note);
    const int holds = voice->active() && voice->note == note && !voice->releasing ? voice->holds + 1 : 1;
    voice->age = clock++;
    seed = static_cast<unsigned int>(seed * 1664525u + 1013904223u);
    const int burst = jsRoundInt(std::fmax(0.0, ctl(ids::burst, 0)) * sampleRate);
    voice->noteOn(note, velocity, seed, burst);
    voice->holds = holds;
  }

  void stopNote(double note) {
    for (auto& v : voices) {
      if (!(v.active() && v.note == note && !v.releasing)) continue;
      if (--v.holds > 0) continue;
      v.holds = 0;
      v.noteOff();
    }
  }

  void pd_process(int frames) {
    readParams();
    for (int i = 0; i < eventCount; ++i) {
      if (events[i].kind == 1) startNote(events[i].note, events[i].velocity);
      else stopNote(events[i].note);
    }
    eventCount = 0;
    float* outl = outL();
    float* outr = outR();
    std::memset(outl, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(outr, 0, sizeof(float) * static_cast<size_t>(frames));
    for (auto& v : voices) if (v.active()) v.process(outl, outr, frames, params, *this);
  }
};

}  // namespace pd_Pluck

extern "C" PdAny* pd_make_Pluck() { return new PdAdapter<pd_Pluck::Device>(); }
