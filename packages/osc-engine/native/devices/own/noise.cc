// The Noise synth: a noise source per voice, in ten colors, with an amplitude envelope.
//
// Translated from web-engine/src/devices/noise.mjs, which says what each color is and why. The
// same state, the same arithmetic in the same order, in double; the parity test holds the two
// together. A control a signal moves is read per sample where the browser reads it per sample
// (see own/pd-own.h).
//
// The chaotic map is the one place where the order of two multiplications decides the sound -
// it is chaotic, so one bit of rounding becomes a different sequence within a few hundred steps
// - so it is compiled without the reassociation and fused multiply-adds -ffast-math would
// otherwise allow, and does exactly what the JavaScript does.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "pd-own-ids.h"

namespace pd_Noise {

namespace ids = pd_ids::Noise;
using namespace pd_own;

/** The voices a fresh device has room for: the old most, and no most (see the Wavetable's kFirstVoices). */
constexpr int kFirstVoices = 16;
constexpr int kColors = 10;
enum { kWhite = 0, kPink, kBrown, kBlue, kViolet, kVelvet, kCrackle, kDigital, kStepped, kChaos };

constexpr double kToneTop = 20000;
constexpr double kDcHz = 5;
constexpr double kBrownHz = 10;
constexpr int kPinkPoles = 6;
constexpr double kPinkHz[kPinkPoles] = { 15, 60, 240, 960, 3840, 15360 };
constexpr double kCrackleRing = 0.0003;
constexpr double kChaosGain = 0.8;
constexpr double kDigitalGain = 0.5773502691896258;
constexpr double kPi = 3.141592653589793;
constexpr double kSqrtHalf = 0.7071067811865476;

inline double onePoleK(double hz, double sampleRate) { return 1 - std::exp((-2 * kPi * hz) / sampleRate); }

/** The pink sections' coefficients and the two loudness scales (noise.mjs's pinkScales). */
struct Scales {
  double a[kPinkPoles] = { 0 };
  double g[kPinkPoles] = { 0 };
  double pink = 1;
  double blue = 1;

  void init(double sampleRate) {
    for (int k = 0; k < kPinkPoles; ++k) {
      a[k] = onePoleK(kPinkHz[k], sampleRate);
      g[k] = std::sqrt(kPinkHz[0] / kPinkHz[k]);
    }
    double r0 = 0, r1 = 0;
    for (int j = 0; j < kPinkPoles; ++j) {
      for (int k = 0; k < kPinkPoles; ++k) {
        const double c = (a[j] * a[k]) / (1 - (1 - a[j]) * (1 - a[k]));
        r0 += g[j] * g[k] * c;
        r1 += g[j] * g[k] * (1 - a[j]) * c;
      }
    }
    pink = std::sqrt(1 / r0);
    blue = std::sqrt(1 / (2 * (r0 - r1)));
  }
};

/** The logistic map's next value, rounded exactly as the browser rounds it. */
#pragma clang fp contract(off)
#pragma clang fp reassociate(off)
inline double logistic(double r, double x) {
  const double rx = r * x;
  return rx * (1 - x);
}
#pragma clang fp reassociate(on)
#pragma clang fp contract(fast)

struct Stream {
  const Scales* scales = nullptr;
  unsigned int state = 1;
  double pinkState[kPinkPoles] = { 0 };
  double pinkLast = 0, whiteLast = 0, brown = 0;
  double phase = 0, target = 0;
  bool fired = true;
  double pop = 0;
  unsigned int reg = 1;
  double held = 0, from = 0, chaos = 0.5;

  void reset() {
    for (double& s : pinkState) s = 0;
    pinkLast = 0; whiteLast = 0; brown = 0;
    phase = 0; target = 0; fired = true;
    pop = 0; reg = 1;
    held = 0; from = 0; chaos = 0.5;
  }

  void seed(unsigned int s) {
    state = s ? s : 1u;
    reg = next() & 0x7fffu;
    if (!reg) reg = 1;
    chaos = 0.1 + 0.8 * unit();
    held = unit() * 2 - 1;
    from = held;
  }

  unsigned int next() {
    unsigned int x = state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    state = x;
    return x;
  }

  double unit() { return static_cast<double>(next()) / 4294967296.0; }
  double white() { return static_cast<double>(next()) / 2147483648.0 - 1.0; }

  double sample(int color, double clock, double density, double character, double ring, double brownK) {
    switch (color) {
      case kPink: case kBlue: {
        const double w = white();
        double sum = 0;
        for (int k = 0; k < kPinkPoles; ++k) {
          pinkState[k] += scales->a[k] * (w - pinkState[k]);
          sum += scales->g[k] * pinkState[k];
        }
        if (color == kPink) return sum * scales->pink;
        const double d = sum - pinkLast;
        pinkLast = sum;
        return d * scales->blue;
      }
      case kBrown: {
        const double w = white();
        brown += brownK * (w - brown);
        return brown * std::sqrt((2 - brownK) / brownK);
      }
      case kViolet: {
        const double w = white();
        const double d = w - whiteLast;
        whiteLast = w;
        return d * kSqrtHalf;
      }
      case kVelvet: {
        phase += density;
        if (phase >= 1) {
          phase -= std::floor(phase);
          target = unit();
          fired = false;
        }
        if (!fired && phase >= target) {
          fired = true;
          return unit() < 0.5 ? -1.0 : 1.0;
        }
        return 0;
      }
      case kCrackle: {
        if (unit() < density) {
          const double w = white();
          pop = w * w * w;
        }
        const double out = pop;
        pop *= ring;
        return out;
      }
      case kDigital: case kStepped: case kChaos: {
        phase += clock;
        if (phase >= 1) {
          phase -= std::floor(phase);
          step(color, character);
        }
        if (color == kStepped) {
          const double glide = std::fmin(1.0, phase / std::fmax(1e-6, character));
          return from + (held - from) * glide;
        }
        return held;
      }
      default:
        return white();
    }
  }

  void step(int color, double character) {
    if (color == kDigital) {
      const unsigned int tap = character >= 0.5 ? 6u : 1u;
      const unsigned int r = reg;
      const unsigned int bit = (r ^ (r >> tap)) & 1u;
      reg = (r >> 1) | (bit << 14);
      held = ((reg & 1u) ? 1.0 : -1.0) * kDigitalGain;
    } else if (color == kStepped) {
      from = held;
      held = white();
    } else {
      const double r = 3.5 + 0.5 * character;
      double x = logistic(r, chaos);
      if (!(x > 1e-9 && x < 1 - 1e-9)) x = 0.1 + 0.8 * unit();
      chaos = x;
      held = (x * 2 - 1) * kChaosGain;
    }
  }
};

/** Every control for the block, in real units. */
struct Params {
  int color = 0;
  double character = 0.5, pitch = 0, tone = kToneTop, width = 1;
  double attack = 0.002, decay = 0.15, sustain = 0.6, release = 0.1;
  double acurve = -4, dcurve = -4, rcurve = -4;
  double level = 0.5;
  double bend = 0;
  double ring = 0, brownK = 0;
};

/** The device's base, which is where a voice reads a moving control from. */
using Base = pd_own::Device<ids::kCount, 2>;

struct Voice {
  double sampleRate = 48000.0;
  Stream a, b;
  Adsr env;
  double note = -1;
  double velocity = 1;
  long long age = 0;
  bool releasing = false;
  int holds = 0;
  double l1 = 0, l2 = 0, r1 = 0, r2 = 0;
  double dcInL = 0, dcOutL = 0, dcInR = 0, dcOutR = 0;

  void init(double sr, const Scales* scales) {
    sampleRate = sr;
    a.scales = scales;
    b.scales = scales;
    a.reset();
    b.reset();
    env.init(sr);
    note = -1; velocity = 1; age = 0; releasing = false; holds = 0;
    resetFilters();
  }

  void resetFilters() {
    l1 = 0; l2 = 0; r1 = 0; r2 = 0;
    dcInL = 0; dcOutL = 0; dcInR = 0; dcOutR = 0;
  }

  bool active() const { return env.active(); }

  void noteOn(double n, double vel, unsigned int seed) {
    if (!env.active()) {
      a.reset();
      b.reset();
      resetFilters();
    }
    note = n;
    velocity = vel;
    releasing = false;
    a.seed(seed ^ 0x9e3779b9u);
    b.seed(seed ^ 0x85ebca6bu);
    env.gateOn(true);
  }

  void noteOff() {
    releasing = true;
    env.gateOff();
  }

  /** Renders `count` samples, reading the moving controls per sample as noise.mjs does. */
  void process(float* outL, float* outR, int count, const Params& p, const Base& c) {
    const double sr = sampleRate;
    env.setStages(p.attack, p.decay, p.sustain, p.release, p.acurve, p.dcurve, p.rcurve);
    const bool pitchMoving = c.isMoving(ids::pitch);
    double clock = std::fmin(0.5, std::fmax(0.1 / sr, midiToHz(note + c.ctl(ids::pitch, 0) + p.bend) / sr));
    const double dcR = 1 - (2 * kPi * kDcHz) / sr;
    double lastTone = -1;
    double toneK = 1;
    for (int i = 0; i < count; ++i) {
      if (pitchMoving && i > 0) {
        clock = std::fmin(0.5, std::fmax(0.1 / sr, midiToHz(note + c.ctl(ids::pitch, i) + p.bend) / sr));
      }
      const double character = std::fmin(1.0, std::fmax(0.0, c.ctl(ids::character, i)));
      const double density = (20 * std::pow(1000.0, character)) / sr;
      const double x = a.sample(p.color, clock, density, character, p.ring, p.brownK);
      const double y = b.sample(p.color, clock, density, character, p.ring, p.brownK);
      const double width = std::fmin(1.0, std::fmax(0.0, c.ctl(ids::width, i)));
      const double norm = 1 / std::sqrt(1 + width * width);
      double l = (x + width * y) * norm;
      double r = (x - width * y) * norm;
      const double dl = l - dcInL + dcR * dcOutL;
      dcInL = l; dcOutL = dl; l = dl;
      const double dr = r - dcInR + dcR * dcOutR;
      dcInR = r; dcOutR = dr; r = dr;
      const double tone = c.ctl(ids::tone, i);
      if (tone < kToneTop - 1) {
        if (tone != lastTone) { toneK = 1 - std::exp((-2 * kPi * tone) / sr); lastTone = tone; }
        l1 += toneK * (l - l1); l2 += toneK * (l1 - l2); l = l2;
        r1 += toneK * (r - r1); r2 += toneK * (r1 - r2); r = r2;
      }
      const double gain = env.next() * velocity * c.ctl(ids::level, i);
      outL[i] = static_cast<float>(outL[i] + l * gain);
      outR[i] = static_cast<float>(outR[i] + r * gain);
    }
    if (!isPlayable(dcOutL + dcOutR + l2 + r2)) {
      a.reset();
      b.reset();
      resetFilters();
    }
  }
};

struct Device : Base {
  Scales scales;
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
    scales.init(sr);
    voices.reserve(kFirstVoices, [](Voice&) {});
    for (auto& v : voices) v.init(sr, &scales);
    params = Params();
    params.ring = std::exp(-1 / (kCrackleRing * sr));
    params.brownK = onePoleK(kBrownHz, sr);
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
    Params& v = params;
    v.color = static_cast<int>(clamp(jsRound(p[ids::color]), 0.0, kColors - 1));
    v.character = p[ids::character];
    v.pitch = p[ids::pitch];
    v.tone = p[ids::tone];
    v.width = p[ids::width];
    v.attack = p[ids::ampenv_attack];
    v.decay = p[ids::ampenv_decay];
    v.sustain = p[ids::ampenv_sustain];
    v.release = p[ids::ampenv_release];
    v.acurve = p[ids::env_acurve];
    v.dcurve = p[ids::env_dcurve];
    v.rcurve = p[ids::env_rcurve];
    v.level = p[ids::level];
    // As many as asked for, room grown through the work round (see the Wavetable's).
    const double want = jsRound(p[ids::voices]);
    const int asked = want < 1 ? 1 : (want > 1e6 ? 1000000 : static_cast<int>(want));
    voices.ask(asked);
    voiceCount = asked < voices.size() ? asked : voices.size();
  }

  bool pd_work_wanted() { return voices.wanted(); }
  void pd_work() {
    const double sr = sampleRate;
    Scales* sc = &scales;
    voices.build([sr, sc](Voice& v) { v.init(sr, sc); });
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
    voice->noteOn(note, velocity, seed);
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

}  // namespace pd_Noise

extern "C" PdAny* pd_make_Noise() { return new PdAdapter<pd_Noise::Device>(); }
