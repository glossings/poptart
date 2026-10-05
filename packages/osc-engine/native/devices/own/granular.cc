// The Granular synth: a sample played as a cloud of grains, one cloud per note.
//
// Translated from web-engine/src/devices/granular.mjs, and held to it sample for sample by
// osc-engine's native-device-parity.test.mjs.
//
// This is the device the SAMPLE PATH was built for: every other one of poptart's own devices
// makes its sound out of its controls, and this one makes it out of a file. The frames arrive
// through `pd_sample` - read out of the buffer sclang already loaded for the sample pack, summed
// to one channel on the non-realtime thread, and handed over as a pointer the host owns (see
// PoptartDevice.cpp's sample stages, and pd-device.h). With no file named the synth is silent,
// which is what the browser does too.
//
// One divergence, the same one every device here has: a control a signal moves is read per
// sample in the browser and per block here, which is the ABI. For the level that means a `.param
// ("Level", lfo())` is stepped per block rather than smooth, and nothing else here reads a
// control per sample at all.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "pd-own-ids.h"

#include <cmath>
#include <cstring>

namespace pd_Granular {

namespace ids = pd_ids::Granular;
using namespace pd_own;

constexpr int kVoices = 8;        // GRAIN_VOICES
constexpr int kMaxGrains = 24;    // per voice
/**
 * How many loaded files one of these holds.
 *
 * The browser's option list has room for 32 and the host holds frames for eight of them
 * (kMaxSamples in PoptartDevice.cpp), so this is the list, not the memory: an index past
 * anything loaded plays nothing, exactly as a slot nothing has been loaded into does there.
 */
constexpr int kSampleSlots = 32;

/** The last hundredth of a grain, faded, so a window that ends loud does not click. */
inline double grainTail(double t) { return std::fmin(1.0, (1.0 - t) * 100.0); }

/**
 * One grain's amplitude at `t` through its length, by window shape.
 *
 * The same six shapes the browser ships, in the same order - the order is the control's option
 * list, and an index is what a saved song holds. A DRAWN window (a shape somebody made) is a
 * table rather than a formula and there is no path for one on this engine yet, so an index past
 * these plays the first, which is what the browser does with an empty shape slot.
 */
inline double grainWindow(int mode, double t) {
  if (mode == 5) return 0.42 - 0.5 * std::cos(2 * M_PI * t) + 0.08 * std::cos(4 * M_PI * t);
  // A grain with a transient of its own: struck at the front, decaying away. This is what makes
  // a cloud read as notes rather than as a pad.
  if (mode == 4) return grainWindow(3, 1.0 - t);
  if (mode == 3) return (t < 0.01 ? t * 100.0 : std::exp(-6.0 * (t - 0.01))) * grainTail(t);
  if (mode == 2) return t < 0.05 ? t * 20.0 : (t > 0.95 ? (1.0 - t) * 20.0 : 1.0);
  if (mode == 1) return 1.0 - std::fabs(t * 2.0 - 1.0);
  return 0.5 - 0.5 * std::cos(2 * M_PI * t);
}

/** The controls, as the browser's own `p` struct holds them. */
struct Params {
  int sample = 0;
  double position = 0.2, spray = 0.05, scan = 0;
  double size = 120, density = 30, pitch = 0, random = 0;
  int window = 0;
  double spread = 0.5, reverse = 0;
  double attack = 0.02, decay = 0.1, sustain = 1, release = 0.3, level = 0.7;
  /** The track's .bend(), in semitones: read as each grain starts. */
  double bend = 0;
};

/** One loaded file: mono frames at the file's own rate, owned by the host. */
struct Sample {
  const float* data = nullptr;
  int frames = 0;
  double sampleRate = 48000.0;
};

struct Grain {
  bool on = false;
  double pos = 0, from = 0, pan = 0, rate = 1, l = 1, r = 1;
  int len = 1, at = 0;
};

struct Voice {
  double sampleRate = 48000.0;
  Adsr env;
  Grain grains[kMaxGrains];
  double note = -1;
  double velocity = 1;
  int age = 0;
  bool releasing = false;
  int until = 0;
  double scanned = 0;          // how far the scan has moved the position, in samples
  unsigned int seed = 1;

  void init(double sr) {
    sampleRate = sr;
    env.init(sr);
  }

  bool active() const { return env.active(); }

  /**
   * xorshift32, as the browser's voice writes it - and note that ALL THREE SHIFTS ARE UNSIGNED
   * here, where the wavetable's noise has a signed middle shift. They are two different
   * generators in the browser's own source and copying either one over the other would change
   * every grain's start, length and pan.
   */
  double random() {
    unsigned int x = seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    seed = x;
    return static_cast<double>(x) / 4294967296.0;
  }

  void noteOn(double n, double vel, unsigned int s) {
    note = n;
    velocity = vel;
    releasing = false;
    seed = s ? s : 1u;
    until = 0;
    scanned = 0;
    for (auto& g : grains) g.on = false;
    env.gateOn(true);
  }

  void noteOff() {
    releasing = true;
    env.gateOff();
  }

  void process(float* outl, float* outr, int count, const Params& p, const Sample* sample) {
    if (!env.active()) return;
    env.setStages(p.attack, p.decay, p.sustain, p.release, -4, -4, -4);
    const double sr = sampleRate;
    const float* data = sample ? sample->data : nullptr;
    const int len = data ? sample->frames : 0;
    // The file's own rate against the engine's: a sample read at one step a sample plays at its
    // recorded speed only when the two agree.
    const double fileRate = sample ? sample->sampleRate / sr : 1.0;
    const double ratioBase = std::pow(2.0, (note - 60 + p.pitch + p.bend) / 12.0) * fileRate;
    for (int i = 0; i < count; ++i) {
      const double env0 = env.next() * velocity;
      if (len > 0 && --until <= 0) {
        until = static_cast<int>(std::fmax(1.0, jsRound((sr / p.density) * (0.8 + 0.4 * random()))));
        Grain* g = nullptr;
        for (auto& one : grains) if (!one.on) { g = &one; break; }
        if (g) {
          const double spray = (random() * 2 - 1) * p.spray * len;
          const double center = std::fmod(p.position * len + scanned + spray + len * 4.0, (double)len);
          g->len = static_cast<int>(std::fmax(32.0, jsRound(p.size * 0.001 * sr)));
          g->rate = ratioBase * std::pow(2.0, (p.random * (random() * 2 - 1)) / 12.0);
          if (random() < p.reverse) g->rate = -g->rate;
          g->pos = center;
          g->from = center;
          g->at = 0;
          const double pan = (random() * 2 - 1) * p.spread;
          g->pan = pan;
          g->l = std::cos(((pan + 1) * M_PI) / 4) * M_SQRT2;
          g->r = std::sin(((pan + 1) * M_PI) / 4) * M_SQRT2;
          g->on = true;
        }
      }
      // The scan moves through the file at the same speed whatever note is playing: the note
      // repitches the grains, not the journey through the sample.
      scanned += p.scan * fileRate;
      double l = 0;
      double r = 0;
      if (len > 0) {
        for (auto& g : grains) {
          if (!g.on) continue;
          const double t = static_cast<double>(g.at) / g.len;
          const double w = grainWindow(p.window, t);
          const double pos = std::fmod(std::fmod(g.pos, (double)len) + len, (double)len);
          const int whole = static_cast<int>(std::floor(pos));
          const double frac = pos - whole;
          const int b = (whole + 1) % len;
          const double v = ((double)data[whole] + ((double)data[b] - (double)data[whole]) * frac) * w;
          l += v * g.l;
          r += v * g.r;
          g.pos += g.rate;
          if (++g.at >= g.len) g.on = false;
        }
      }
      const double gain = env0 * p.level * 0.5;
      // One rounding per voice, as `outL[i] += l * g` on a Float32Array gives: the sum is a
      // double there too, and only the store is a float.
      outl[i] = static_cast<float>((double)outl[i] + l * gain);
      outr[i] = static_cast<float>((double)outr[i] + r * gain);
    }
  }
};

struct Device : pd_own::Device<ids::kCount, 2> {
  Params params;
  Sample samples[kSampleSlots];
  Voice voices[kVoices];
  int voiceCount = 4;
  int clock = 0;
  unsigned int seed = 7;

  struct Event { int kind; double note; double velocity; };
  Event events[64];
  int eventCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& v : voices) v.init(sr);
    eventCount = 0;
  }

  /** A file the host read for us, on the control that takes one. */
  void pd_sample(int param, int slot, const float* data, int frames, double rate) {
    if (param != ids::sample) return;
    if (slot < 0 || slot >= kSampleSlots) return;
    samples[slot] = Sample{ data, frames, rate > 0 ? rate : sampleRate };
  }

  void pd_note_on(float note, float velocity) {
    if (eventCount < 64) events[eventCount++] = Event{ 1, note, velocity };
  }
  void pd_note_off(float note) {
    if (eventCount < 64) events[eventCount++] = Event{ 0, note, 0 };
  }
  void pd_bend(float semitones) { params.bend = isPlayable(semitones) ? semitones : 0.0; }

  void readParams() {
    Params& v = params;
    v.sample = jsRoundInt(p[ids::sample]);
    v.position = p[ids::position];
    v.spray = p[ids::spray];
    v.scan = p[ids::scan];
    v.size = p[ids::size];
    v.density = p[ids::density];
    v.pitch = p[ids::pitch];
    v.random = p[ids::random];
    v.window = jsRoundInt(p[ids::window]);
    v.spread = p[ids::spread];
    v.reverse = p[ids::reverse];
    v.attack = p[ids::attack];
    v.decay = p[ids::decay];
    v.sustain = p[ids::sustain];
    v.release = p[ids::release];
    v.level = p[ids::level];
    voiceCount = static_cast<int>(clamp(jsRound(p[ids::voices]), 1.0, kVoices));
  }

  /**
   * Picks a voice for a note: the one already playing it, a free one, the oldest one already
   * releasing, and finally the oldest sounding voice - the browser's allocate(), which is the
   * wavetable's too.
   */
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

  void pd_process(int frames) {
    readParams();
    for (int i = 0; i < eventCount; ++i) {
      if (events[i].kind == 1) {
        Voice* voice = allocate(events[i].note);
        voice->age = clock++;
        seed = seed * 1664525u + 1013904223u;
        voice->noteOn(events[i].note, events[i].velocity, seed);
      } else {
        for (auto& v : voices) {
          if (v.active() && v.note == events[i].note && !v.releasing) v.noteOff();
        }
      }
    }
    eventCount = 0;

    const int which = params.sample;
    const Sample* sample = (which >= 0 && which < kSampleSlots && samples[which].data
                            && samples[which].frames > 0) ? &samples[which] : nullptr;
    float* outl = outL();
    float* outr = outR();
    std::memset(outl, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(outr, 0, sizeof(float) * static_cast<size_t>(frames));
    // Every ACTIVE voice renders, not only the first `voiceCount`: the count limits what a new
    // note may take, and a voice above it finishes its note rather than being cut off.
    for (auto& v : voices) if (v.active()) v.process(outl, outr, frames, params, sample);
  }
};

}  // namespace pd_Granular

extern "C" PdAny* pd_make_Granular() { return new PdAdapter<pd_Granular::Device>(); }
