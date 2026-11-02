// The Additive synth: every voice a bank of sine partials.
//
// Translated from web-engine/src/devices/additive.mjs, line for line, and held to it by
// native-device-parity.test.mjs. Each partial is a sine at a ratio of the note, its level set by
// the count, the slope, the odd/even balance and a drawn spectrum, brought to one loudness with
// the others; Damp brings the higher ones down faster through each note. Every partial's level
// and phase step is ramped across the block, through the cuts at note edges, so moving any
// control is click-free.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "own/dsp/oscillator.h"
#include "pd-own-ids.h"

#include <cmath>
#include <cstring>

namespace pd_Additive {

namespace ids = pd_ids::Additive;
using namespace pd_own;

/** The most partials a voice has (ADDITIVE_PARTIALS). */
constexpr int kPartials = 64;
/** The voices a fresh device has room for, as the browser makes at first. Not a most. */
constexpr int kFirstVoices = 16;
/** The room a fresh device has for drawn spectra, past 'flat'. Not a most either. */
constexpr int kFirstSpectrumSlots = 1 + 8;
/** The points a drawn spectrum is sampled at: the browser engine's SHAPE_POINTS. */
constexpr int kShapePoints = 256;

constexpr int kSineSize = 4096;
/** A partial fades out over this share of the sample rate below Nyquist. */
constexpr double kNyquistFade = 0.05;
/** Damp at 1, in nepers a second per unit of ratio above the fundamental. */
constexpr double kDampRate = 10;
constexpr double kVoiceGain = 0.5;
constexpr double kSilentPower = 1e-12;

/** The shared sine table; one more entry repeats the first, so a read never wraps. */
struct SineTable {
  double v[kSineSize + 1];
  SineTable() {
    for (int i = 0; i <= kSineSize; ++i) v[i] = std::sin((2 * M_PI * i) / kSineSize);
  }
};
static const SineTable kSine;

/** One partial's level from a drawn spectrum: the table read at `x` (0..1), linearly. */
inline double spectrumLevel(const float* table, int n, double x) {
  if (!table || n == 0) return 1;
  const double pos = std::fmin(1.0, std::fmax(0.0, x)) * (n - 1);
  const int i = static_cast<int>(std::floor(pos));
  const double a = table[i];
  const double b = table[i + 1 < n ? i + 1 : n - 1];
  return a + (b - a) * (pos - i);
}

/** What every voice reads, worked out once a block from the controls. */
struct Params {
  double ratio[kPartials];
  double base[kPartials];
  double dampMul[kPartials];
  int block = 128;
  double attack = 0.005, decay = 0.1, sustain = 0.8, release = 0.15;
  double acurve = -4, dcurve = -4, rcurve = -4;
  double glide = 0;
  double level = 0.7;
  const float* levelA = nullptr;
  double bend = 0;
};

struct Voice {
  double sampleRate = 48000.0;
  double phase[kPartials];
  double gain[kPartials];
  double gainTo[kPartials];
  double gainStep[kPartials];
  double inc[kPartials];
  double incStep[kPartials];
  double damp[kPartials];
  Adsr env;
  double note = -1;
  double velocity = 1;
  long long age = 0;
  bool releasing = false;
  int holds = 0;
  bool fresh = false;
  double targetHz = 440;
  double currentHz = 440;

  void init(double sr) {
    sampleRate = sr;
    env.init(sr);
    for (int k = 0; k < kPartials; ++k) {
      phase[k] = 0; gain[k] = 0; gainTo[k] = 0; gainStep[k] = 0; inc[k] = 0; incStep[k] = 0; damp[k] = 1;
    }
    note = -1;
    velocity = 1;
    age = 0;
    releasing = false;
    holds = 0;
    fresh = false;
    targetHz = 440;
    currentHz = 440;
  }

  bool active() const { return env.active(); }

  void noteOn(double n, double vel, const Params& p, unsigned int seed, double glideFrom) {
    note = n;
    velocity = vel;
    releasing = false;
    targetHz = midiToHz(n);
    currentHz = glideFrom > 0 && p.glide > 0 ? glideFrom : targetHz;
    for (int k = 0; k < kPartials; ++k) {
      phase[k] = hashPhase(seed, k);
      damp[k] = 1;
    }
    fresh = true;
    env.gateOn(true);
  }

  void noteOff() {
    releasing = true;
    env.gateOff();
  }

  void process(float* outL, float* outR, int count, int offset, const Params& p) {
    if (!env.active()) return;
    const double sr = sampleRate;
    if (p.glide > 0 && currentHz != targetHz) {
      const double k = 1 - std::exp(-(count / sr) / std::fmax(1e-4, p.glide));
      currentHz += (targetHz - currentHz) * k;
      if (std::fabs(currentHz - targetHz) < 0.01) currentHz = targetHz;
    } else {
      currentHz = targetHz;
    }
    const double hz = p.bend ? currentHz * std::pow(2.0, p.bend / 12.0) : currentHz;
    const double heard = hz;

    double power = 0;
    for (int k = 0; k < kPartials; ++k) {
      const double f = p.ratio[k] * heard;
      const double fade = std::fmin(1.0, std::fmax(0.0, (0.5 * sr - f) / (kNyquistFade * sr)));
      const double g = p.base[k] * fade;
      gainTo[k] = g;
      power += g * g;
    }
    const double norm = power > kSilentPower ? 1 / std::sqrt(power) : 0;
    const int remaining = p.block - offset;
    int top = 0;
    for (int k = 0; k < kPartials; ++k) {
      const double to = gainTo[k] * norm;
      gainTo[k] = to;
      const double incTo = (p.ratio[k] * hz) / sr;
      if (fresh) {
        gain[k] = to;
        inc[k] = incTo;
        gainStep[k] = 0;
        incStep[k] = 0;
      } else {
        gainStep[k] = (to - gain[k]) / remaining;
        incStep[k] = (incTo - inc[k]) / remaining;
      }
      if (to > 0 || gain[k] > 0) top = k + 1;
    }
    fresh = false;

    env.setStages(p.attack, p.decay, p.sustain, p.release, p.acurve, p.dcurve, p.rcurve);
    const double* sine = kSine.v;
    const double vel = velocity * kVoiceGain;
    for (int i = 0; i < count; ++i) {
      const int t = offset + i;
      double sum = 0;
      for (int k = 0; k < top; ++k) {
        const double d = damp[k];
        const double a = (gain[k] + gainStep[k] * i) * d;
        damp[k] = d * p.dampMul[k];
        double ph = phase[k];
        const double x = ph * kSineSize;
        const int j = static_cast<int>(x);
        const double s = sine[j];
        sum += (s + (sine[j + 1] - s) * (x - j)) * a;
        ph += inc[k] + incStep[k] * i;
        if (ph >= 1) ph -= std::floor(ph);
        phase[k] = ph;
      }
      const double g = env.next() * vel * (p.levelA ? static_cast<double>(p.levelA[t]) : p.level);
      // Summed in double and rounded once, as `outL[i] += sum * g` on a Float32Array is.
      outL[i] = static_cast<float>(static_cast<double>(outL[i]) + sum * g);
      outR[i] = static_cast<float>(static_cast<double>(outR[i]) + sum * g);
    }
    const bool end = offset + count >= p.block;
    for (int k = 0; k < kPartials; ++k) {
      gain[k] = end ? gainTo[k] : gain[k] + gainStep[k] * count;
      inc[k] = end ? (p.ratio[k] * hz) / sr : inc[k] + incStep[k] * count;
    }
  }
};

struct Device : pd_own::Device<ids::kCount, 2> {
  Params params;
  Pool<Voice> voices;
  int voiceCount = 8;
  long long clock = 0;
  unsigned int seed = 1;
  struct Event { int at; int kind; double note; double velocity; };
  Event events[64];
  int eventCount = 0;
  /** A drawn spectrum, by Spectrum slot. Copied: the host's memory is not ours. */
  struct Drawn { float table[kShapePoints]; int length = 0; };
  Pool<Drawn> spectra;

  void pd_init(double sr) {
    sampleRate = sr;
    params = Params();
    voices.reserve(kFirstVoices, [](Voice&) {});
    spectra.reserve(kFirstSpectrumSlots, [](Drawn&) {});
    for (auto& v : voices) v.init(sr);
    voiceCount = 8;
    clock = 0;
    seed = 1;
    eventCount = 0;
  }

  void pd_note_on(float note, float velocity) { pd_note_on_at(note, velocity, 0); }
  void pd_note_off(float note) { pd_note_off_at(note, 0); }

  void pd_note_on_at(float note, float velocity, int offset) {
    if (eventCount < 64) events[eventCount++] = { offset > 0 ? offset : 0, 1, note, velocity };
  }

  void pd_note_off_at(float note, int offset) {
    if (note < 0) {
      // Every note off at once.
      eventCount = 0;
      for (auto& v : voices) {
        v.holds = 0;
        if (v.active()) v.noteOff();
      }
      return;
    }
    if (eventCount < 64) events[eventCount++] = { offset > 0 ? offset : 0, 0, note, 0 };
  }

  void pd_bend(float semitones) { params.bend = isPlayable(semitones) ? semitones : 0.0; }

  bool pd_shape(int param, int slot, const float* table, int count) {
    if (param != ids::spectrum || slot < 0 || !table || count <= 0) return true;
    if (slot >= spectra.size()) { spectra.ask(slot + 1); return false; }
    const int n = count < kShapePoints ? count : kShapePoints;
    Drawn& one = spectra[slot];
    std::memcpy(one.table, table, sizeof(float) * static_cast<size_t>(n));
    one.length = n;
    return true;
  }

  bool pd_work_wanted() { return voices.wanted() | spectra.wanted(); }
  void pd_work() {
    const double sr = sampleRate;
    voices.build([sr](Voice& v) { v.init(sr); });
    spectra.build([](Drawn&) {});
  }
  void pd_work_done() { voices.install(); spectra.install(); }
  void pd_work_release() { voices.release(); spectra.release(); }

  /** A control's value at the END of the call, as the browser's `last`. */
  double last(int id, int frames) const {
    return isMoving(id) && frames > 0 ? static_cast<double>(pb[id][frames - 1]) : static_cast<double>(p[id]);
  }

  /** The block's partials - ratios, levels, damping - from the controls where the block ends. */
  void prepare(int frames) {
    Params& q = params;
    const double sr = sampleRate;
    q.block = frames;
    const double partials = std::fmin(kPartials, std::fmax(1.0, last(ids::partials, frames)));
    const double tilt = last(ids::tilt, frames);
    const double odd = std::fmin(1.0, std::fmax(-1.0, last(ids::odd, frames)));
    const double stretch = last(ids::stretch, frames);
    const double damp = std::fmax(0.0, last(ids::damp, frames));
    const int slot = jsRoundInt(last(ids::spectrum, frames));
    const Drawn* drawn = slot >= 1 && slot < spectra.size() && spectra[slot].length > 0 ? &spectra[slot] : nullptr;
    const float* table = drawn ? drawn->table : nullptr;
    const int length = drawn ? drawn->length : 0;
    const double oddLevel = std::fmin(1.0, 1 + odd);
    const double evenLevel = std::fmin(1.0, 1 - odd);
    for (int k = 0; k < kPartials; ++k) {
      const int n = k + 1;
      const double ratio = std::pow(static_cast<double>(n), 1 + stretch);
      q.ratio[k] = ratio;
      const double count01 = std::fmin(1.0, std::fmax(0.0, partials - k));
      const double slope = std::pow(10.0, (tilt * std::log2(ratio)) / 20);
      const double parity = n % 2 == 1 ? oddLevel : evenLevel;
      q.base[k] = count01 * slope * parity * spectrumLevel(table, length, static_cast<double>(k) / (kPartials - 1));
      q.dampMul[k] = std::exp(-(kDampRate * damp * (ratio - 1)) / sr);
    }
    q.attack = last(ids::ampenv_attack, frames);
    q.decay = last(ids::ampenv_decay, frames);
    q.sustain = last(ids::ampenv_sustain, frames);
    q.release = last(ids::ampenv_release, frames);
    q.acurve = last(ids::env_acurve, frames);
    q.dcurve = last(ids::env_dcurve, frames);
    q.rcurve = last(ids::env_rcurve, frames);
    q.glide = last(ids::glide, frames);
    q.level = p[ids::level];
    q.levelA = isMoving(ids::level) ? pb[ids::level] : nullptr;
    // As many as asked for, room grown through the work round (see the Wavetable's).
    const double want = jsRound(last(ids::voices, frames));
    const int asked = want < 1 ? 1 : (want > 1e6 ? 1000000 : static_cast<int>(want));
    voices.ask(asked);
    voiceCount = asked < voices.size() ? asked : voices.size();
  }

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
    const double from = voice->active() && voice->note >= 0 ? midiToHz(voice->note) : -1;
    const int holds = voice->active() && voice->note == note && !voice->releasing ? voice->holds + 1 : 1;
    voice->age = clock++;
    seed = static_cast<unsigned int>(seed * 1664525u + 1013904223u);
    voice->noteOn(note, velocity, params, seed, from);
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
    prepare(frames);
    // In time order, ties in arrival order - a stable sort, as the browser's Array.sort is.
    for (int i = 1; i < eventCount; ++i) {
      const Event e = events[i];
      int j = i - 1;
      while (j >= 0 && events[j].at > e.at) { events[j + 1] = events[j]; --j; }
      events[j + 1] = e;
    }
    float* outl = outL();
    float* outr = outR();
    std::memset(outl, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(outr, 0, sizeof(float) * static_cast<size_t>(frames));
    int at = 0;
    int next = 0;
    while (at < frames) {
      while (next < eventCount && events[next].at <= at) {
        const Event& e = events[next++];
        if (e.kind == 1) startNote(e.note, e.velocity);
        else stopNote(e.note);
      }
      const int until = next < eventCount && events[next].at < frames ? events[next].at : frames;
      const int n = until - at;
      if (n > 0) {
        for (auto& v : voices) if (v.active()) v.process(outl + at, outr + at, n, at, params);
      }
      at = until;
    }
    // Anything due after this block waits for the next one, at its place in that one.
    int kept = 0;
    for (int i = next; i < eventCount; ++i) {
      Event e = events[i];
      e.at = e.at - frames > 0 ? e.at - frames : 0;
      events[kept++] = e;
    }
    eventCount = kept;
  }
};

}  // namespace pd_Additive

extern "C" PdAny* pd_make_Additive() { return new PdAdapter<pd_Additive::Device>(); }
