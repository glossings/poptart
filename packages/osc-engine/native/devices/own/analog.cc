// The Analog synth: two oscillators, a sub and noise into an analog filter circuit with its own
// envelope, on every voice.
//
// Translated from web-engine/src/devices/analog.mjs, which says how the oscillators are drawn
// band-limited, how they drift, how the filter follows the note and the envelope, and how one
// voice plays as a monosynth. The same state, the same arithmetic in the same order, in double;
// the parity test holds the two together. The continuous controls are read per sample (see
// own/pd-own.h); the switches and the envelopes once a call, where it ends.
//
// THE FILTER is a circuit model from own/dsp/analog.h, the same ones the Filter device's analog
// modes run, one per voice, with its own saturation and oversampling.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "own/dsp/blep.h"
#include "own/dsp/analog.h"
#include "pd-own-ids.h"

#include <cmath>
#include <cstring>

namespace pd_Analog {

namespace ids = pd_ids::Analog;
using namespace pd_own;

/** The voices a fresh device has room for (see the Wavetable's kFirstVoices). */
constexpr int kFirstVoices = 16;
constexpr int kSaw = 0;
constexpr int kSquare = 1;
constexpr int kTriangle = 2;
constexpr int kShapes = 4;
constexpr double kTrackNote = 60;
constexpr double kDriftCents = 12;
constexpr double kDriftStepSec = 0.4;
constexpr double kDriftSmoothSec = 0.2;
constexpr double kMinWidth = 0.02;
constexpr double kTop = 0.45;
constexpr double kVoiceGain = 0.5;
constexpr double kGlideLand = 1e-6;
constexpr int kHeld = 64;
constexpr double kTwoPi = 2 * 3.141592653589793;

inline double clamp01(double x) { return std::fmin(1.0, std::fmax(0.0, x)); }

/** The Filter Type options: the circuit models, in analog.h's order. */
constexpr int kFilterTypes = kAnalogModelCount;

// --- the voice --------------------------------------------------------------------------------

struct AnalogRandom {
  unsigned int state = 1;
  void seed(unsigned int s) { state = s ? s : 1u; }
  double white() {
    unsigned int x = state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    state = x;
    return static_cast<double>(x) / 2147483648.0 - 1.0;
  }
};

inline double wave(int shape, double p, double w) {
  switch (shape) {
    case kSaw: return 2 * p - 1;
    case kSquare: return p < w ? 2 - 2 * w : -2 * w;
    case kTriangle: return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    default: return std::sin(kTwoPi * p);
  }
}

inline double slope(int shape, double p) {
  switch (shape) {
    case kSaw: return 2;
    case kSquare: return 0;
    case kTriangle: return p < 0.5 ? 4 : -4;
    default: return kTwoPi * std::cos(kTwoPi * p);
  }
}

/** Moves a phase from `from` to `to`, drawing what it passes (analog.mjs's travel). */
inline double travel(BlepLine& line, int shape, double w, double gain, double from, double to, double dt, double agoEnd) {
  switch (shape) {
    case kSaw:
      if (to >= 1) {
        to -= 1;
        line.jump(agoEnd + to / dt, -2 * gain);
      }
      return to;
    case kSquare:
      if (from < w && to >= w) line.jump(agoEnd + (to - w) / dt, -2 * gain);
      if (to >= 1) {
        to -= 1;
        line.jump(agoEnd + to / dt, 2 * gain);
        if (to >= w) line.jump(agoEnd + (to - w) / dt, -2 * gain);
      }
      return to;
    case kTriangle:
      if (from < 0.5 && to >= 0.5) line.kink(agoEnd + (to - 0.5) / dt, -8 * dt * gain);
      if (to >= 1) {
        to -= 1;
        line.kink(agoEnd + to / dt, 8 * dt * gain);
        if (to >= 0.5) line.kink(agoEnd + (to - 0.5) / dt, -8 * dt * gain);
      }
      return to;
    default:
      return to >= 1 ? to - 1 : to;
  }
}

/** What every voice reads once a call. */
struct Shared {
  int shape1 = 0, shape2 = 0, type = 0;
  bool sync = false;
  double glideK = 1, driftK = 0;
  int driftStep = 1;
  double attack = 0.005, decay = 0.1, sustain = 0.8, release = 0.15, acurve = -4, dcurve = -4, rcurve = -4;
  double fattack = 0.002, fdecay = 0.3, fsustain = 0.3, frelease = 0.2, facurve = -4, fdcurve = -4, frcurve = -4;
  double bend = 0;
};

using Base = pd_own::Device<ids::kCount, 2>;

struct Voice {
  double sampleRate = 48000.0;
  BlepLine line;
  AnalogFilter filter;
  Adsr ampEnv;
  Adsr filterEnv;
  AnalogRandom random;
  AnalogRandom noise;
  double note = -1;
  double velocity = 1;
  long long age = 0;
  bool releasing = false;
  int holds = 0;
  double target = 60;
  double pitch = 60;
  double phase1 = 0, phase2 = 0, sub = 1;
  double drift1 = 0, drift2 = 0, drift1To = 0, drift2To = 0;
  int driftLeft = 0;

  void init(double sr) {
    sampleRate = sr;
    line.reset();
    filter.init(sr);
    ampEnv.init(sr);
    filterEnv.init(sr);
    note = -1; velocity = 1; age = 0; releasing = false; holds = 0;
    target = 60; pitch = 60;
    phase1 = 0; phase2 = 0; sub = 1;
    drift1 = drift2 = drift1To = drift2To = 0;
    driftLeft = 0;
  }

  bool active() const { return ampEnv.active(); }

  /** Starts a note, sliding from `glideFrom` (a note) when it is not negative infinity. */
  void noteOn(double n, double vel, unsigned int seed, bool glides, double glideFrom) {
    if (!ampEnv.active()) {
      line.reset();
      filter.reset();
      random.seed(seed);
      noise.seed(seed ^ 0x9e3779b9u);
      phase1 = (random.white() + 1) * 0.5;
      phase2 = (random.white() + 1) * 0.5;
      sub = 1;
      drift1 = random.white();
      drift2 = random.white();
      drift1To = drift1;
      drift2To = drift2;
      driftLeft = 0;
    }
    note = n;
    velocity = vel;
    releasing = false;
    target = n;
    pitch = glides ? glideFrom : n;
    ampEnv.gateOn(true);
    filterEnv.gateOn(true);
  }

  void slide(double n) {
    note = n;
    target = n;
  }

  void noteOff() {
    releasing = true;
    ampEnv.gateOff();
    filterEnv.gateOff();
  }

  void process(float* outL, float* outR, int count, int offset, const Shared& s, const Base& c) {
    const double sr = sampleRate;
    filter.setModel(s.type);
    const int shape1 = s.shape1;
    const int shape2 = s.shape2;
    const bool sync = s.sync;
    const double glideK = s.glideK;
    const double driftK = s.driftK;
    const double vel = velocity;
    ampEnv.setStages(s.attack, s.decay, s.sustain, s.release, s.acurve, s.dcurve, s.rcurve);
    filterEnv.setStages(s.fattack, s.fdecay, s.fsustain, s.frelease, s.facurve, s.fdcurve, s.frcurve);
    double y = 0;

    {
      for (int i = 0; i < count; ++i) {
        const int j = offset + i;
        if (pitch != target) {
          pitch += (target - pitch) * glideK;
          if (std::fabs(target - pitch) < kGlideLand) pitch = target;
        }
        const double nt = pitch + s.bend;

        if (--driftLeft <= 0) {
          driftLeft = s.driftStep;
          drift1To = random.white();
          drift2To = random.white();
        }
        drift1 += (drift1To - drift1) * driftK;
        drift2 += (drift2To - drift2) * driftK;
        const double wander = (c.ctl(ids::drift, j) * kDriftCents) / 100;
        const double dt1 = std::fmin(kTop, midiToHz(nt + wander * drift1) / sr);
        const double tune2 = c.ctl(ids::osc2_semi, j) + c.ctl(ids::osc2_detune, j) / 100;
        const double dt2 = std::fmin(kTop, midiToHz(nt + tune2 + wander * drift2) / sr);
        const double w1 = std::fmin(1 - kMinWidth, std::fmax(kMinWidth, c.ctl(ids::osc1_width, j)));
        const double w2 = std::fmin(1 - kMinWidth, std::fmax(kMinWidth, c.ctl(ids::osc2_width, j)));
        const double mix = clamp01(c.ctl(ids::mix, j));
        const double g1 = 1 - mix;
        const double g2 = mix;
        const double gs = c.ctl(ids::sub, j);

        const double to1 = phase1 + dt1;
        const bool wrapped = to1 >= 1;
        const double ago1 = wrapped ? (to1 - 1) / dt1 : 0;
        phase1 = travel(line, shape1, w1, g1, phase1, to1, dt1, 0);
        if (wrapped) {
          line.jump(ago1, -2 * sub * gs);
          sub = -sub;
        }
        if (sync && wrapped) {
          const double end = travel(line, shape2, w2, g2, phase2, phase2 + dt2 * (1 - ago1), dt2, ago1);
          line.jump(ago1, g2 * (wave(shape2, 0, w2) - wave(shape2, end, w2)));
          const double bend = slope(shape2, 0) - slope(shape2, end);
          if (bend != 0) line.kink(ago1, g2 * bend * dt2);
          phase2 = travel(line, shape2, w2, g2, 0, dt2 * ago1, dt2, 0);
        } else {
          phase2 = travel(line, shape2, w2, g2, phase2, phase2 + dt2, dt2, 0);
        }
        const double plain = g1 * wave(shape1, phase1, w1) + g2 * wave(shape2, phase2, w2)
          + gs * sub + c.ctl(ids::noise, j) * noise.white();
        const double x = line.push(plain);

        const double fenv = filterEnv.next();
        const double v = c.ctl(ids::velocity, j);
        const double amount = c.ctl(ids::envamount, j) * (1 - v + v * vel);
        const double semis = c.ctl(ids::keytrack, j) * (nt - kTrackNote) + amount * fenv;
        filter.setResonance(c.ctl(ids::resonance, j));
        filter.setDrive(c.ctl(ids::drive, j));
        filter.setMorph(c.ctl(ids::morph, j));
        filter.setCutoff(c.ctl(ids::cutoff, j) * std::pow(2.0, semis / 12));
        y = filter.process(x);

        const double out = y * ampEnv.next() * vel * c.ctl(ids::level, j) * kVoiceGain;
        // Summed in double and rounded once, as `outL[i] += out` on a Float32Array is.
        outL[i] = static_cast<float>(static_cast<double>(outL[i]) + out);
        outR[i] = static_cast<float>(static_cast<double>(outR[i]) + out);
      }
      if (!isPlayable(y)) {
        line.reset();
        filter.reset();
      }
    }
  }
};

// --- the synth --------------------------------------------------------------------------------

struct Device : Base {
  Pool<Voice> voices;
  Shared shared;
  int voiceCount = 8;
  long long clock = 0;
  unsigned int seed = 1;
  struct Event { int at; int kind; double note; double velocity; };
  Event events[64];
  int eventCount = 0;
  double held[kHeld];
  int heldCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    voices.reserve(kFirstVoices, [](Voice&) {});
    for (auto& v : voices) v.init(sr);
    shared = Shared();
    shared.driftK = 1 - std::exp(-1 / (kDriftSmoothSec * sr));
    shared.driftStep = static_cast<int>(jsRound(kDriftStepSec * sr));
    voiceCount = 8;
    clock = 0;
    seed = 1;
    eventCount = 0;
    heldCount = 0;
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
      heldCount = 0;
      for (auto& v : voices) {
        v.holds = 0;
        if (v.active()) v.noteOff();
      }
      return;
    }
    if (eventCount < 64) events[eventCount++] = { offset > 0 ? offset : 0, 0, note, 0 };
  }

  void pd_bend(float semitones) { shared.bend = isPlayable(semitones) ? semitones : 0.0; }

  bool pd_work_wanted() { return voices.wanted(); }
  void pd_work() {
    const double sr = sampleRate;
    voices.build([sr](Voice& v) { v.init(sr); });
  }
  void pd_work_done() { voices.install(); }
  void pd_work_release() { voices.release(); }

  /** A control's value at the END of the call, as the browser's `endOf`. */
  double last(int id, int frames) const {
    return isMoving(id) && frames > 0 ? static_cast<double>(pb[id][frames - 1]) : static_cast<double>(p[id]);
  }

  void prepare(int frames) {
    Shared& s = shared;
    s.shape1 = static_cast<int>(std::fmin(kShapes - 1, std::fmax(0.0, jsRound(last(ids::osc1_shape, frames)))));
    s.shape2 = static_cast<int>(std::fmin(kShapes - 1, std::fmax(0.0, jsRound(last(ids::osc2_shape, frames)))));
    s.sync = last(ids::sync, frames) >= 0.5;
    s.type = static_cast<int>(std::fmin(kFilterTypes - 1, std::fmax(0.0, jsRound(last(ids::filter_type, frames)))));
    const double glide = last(ids::glide, frames);
    s.glideK = glide > 0 ? 1 - std::exp(-1 / (glide * sampleRate)) : 1;
    s.attack = last(ids::ampenv_attack, frames);
    s.decay = last(ids::ampenv_decay, frames);
    s.sustain = last(ids::ampenv_sustain, frames);
    s.release = last(ids::ampenv_release, frames);
    s.acurve = last(ids::env_acurve, frames);
    s.dcurve = last(ids::env_dcurve, frames);
    s.rcurve = last(ids::env_rcurve, frames);
    s.fattack = last(ids::fenv_attack, frames);
    s.fdecay = last(ids::fenv_decay, frames);
    s.fsustain = last(ids::fenv_sustain, frames);
    s.frelease = last(ids::fenv_release, frames);
    s.facurve = last(ids::fenv_acurve, frames);
    s.fdcurve = last(ids::fenv_dcurve, frames);
    s.frcurve = last(ids::fenv_rcurve, frames);
    // As many as asked for, room grown through the work round (see the Wavetable's).
    const double want = jsRound(last(ids::voices, frames));
    const int asked = want < 1 ? 1 : (want > 1e6 ? 1000000 : static_cast<int>(want));
    voices.ask(asked);
    const int next = asked < voices.size() ? asked : voices.size();
    if ((next == 1) != (voiceCount == 1)) heldCount = 0;
    voiceCount = next;
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
    seed = static_cast<unsigned int>(seed * 1664525u + 1013904223u);
    if (voiceCount == 1) {
      Voice& voice = voices[0];
      const bool legato = heldCount > 0 && voice.active() && !voice.releasing;
      if (heldCount >= kHeld) {
        for (int i = 1; i < heldCount; ++i) held[i - 1] = held[i];
        --heldCount;
      }
      held[heldCount++] = note;
      if (legato) {
        voice.slide(note);
        return;
      }
      voice.age = clock++;
      voice.noteOn(note, velocity, seed, false, 0);
      return;
    }
    Voice* voice = allocate(note);
    const bool glides = shared.glideK < 1 && voice->active();
    const double from = voice->pitch;
    const int holds = voice->active() && voice->note == note && !voice->releasing ? voice->holds + 1 : 1;
    voice->age = clock++;
    voice->noteOn(note, velocity, seed, glides, from);
    voice->holds = holds;
  }

  void stopNote(double note) {
    if (voiceCount == 1) {
      int k = -1;
      for (int i = heldCount - 1; i >= 0; --i) if (held[i] == note) { k = i; break; }
      if (k < 0) return;
      for (int i = k + 1; i < heldCount; ++i) held[i - 1] = held[i];
      --heldCount;
      Voice& voice = voices[0];
      if (!voice.active() || voice.releasing) return;
      if (heldCount == 0) { voice.noteOff(); return; }
      const double top = held[heldCount - 1];
      if (top != voice.note) voice.slide(top);
      return;
    }
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
        for (auto& v : voices) if (v.active()) v.process(outl + at, outr + at, n, at, shared, *this);
      }
      at = until;
    }
    int kept = 0;
    for (int i = next; i < eventCount; ++i) {
      Event e = events[i];
      e.at = e.at - frames > 0 ? e.at - frames : 0;
      events[kept++] = e;
    }
    eventCount = kept;
  }
};

}  // namespace pd_Analog

extern "C" PdAny* pd_make_Analog() { return new PdAdapter<pd_Analog::Device>(); }
