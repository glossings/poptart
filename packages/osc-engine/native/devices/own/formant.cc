// The Formant synth: an oscillator whose spectral peak is set apart from its pitch, in two ways.
//
// Translated from web-engine/src/devices/formant.mjs, which says what each mode is and why. The
// same state, the same arithmetic in the same order, in double; the parity test holds the two
// together. A control a signal moves is read per sample where the browser reads it per sample
// (see own/pd-own.h).

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "own/dsp/oversample.h"
#include "pd-own-ids.h"

namespace pd_Formant {

namespace ids = pd_ids::Formant;
using namespace pd_own;

/** The voices a fresh device has room for (see the Wavetable's kFirstVoices). */
constexpr int kFirstVoices = 16;
constexpr int kModes = 2;
constexpr int kSquare = 1;
constexpr int kOver = 4;
constexpr int kMaxCount = 16;
constexpr double kReceptive = 0.2;
constexpr double kDcHz = 10;
constexpr double kAirSec = 0.005;
constexpr double kTrackNote = 60;
constexpr double kFormantTop = 0.45;
constexpr double kSlopeEpsilon = 1e-6;
constexpr double kPi = 3.141592653589793;

inline double formantHz(double knob, double track, double pitchHz, double sampleRate) {
  const double hz = knob * std::pow(pitchHz / midiToHz(kTrackNote), track);
  return std::fmin(kFormantTop * sampleRate, std::fmax(1.0, hz));
}

inline int pulsesFor(double count, double formant, double pitch) {
  const double fit = std::floor(formant / pitch);
  if (fit < 1) return 0;
  const double want = std::fmin(kMaxCount, std::fmax(1.0, jsRound(count)));
  return static_cast<int>(fit < want ? fit : want);
}

inline double driveOf(double air) { return 0.1 * std::pow(30.0, air); }

inline double curve(double v) { return std::sin(kPi * 0.5 * std::fmin(1.0, std::fmax(-1.0, v))); }

inline double curveIntegral(double v) {
  if (v > 1) return v - 1;
  if (v < -1) return -v - 1;
  return -std::cos(kPi * 0.5 * v) / (kPi * 0.5);
}

/** The controls read once a call. */
struct Params {
  int mode = 0;
  double glide = 0;
  double attack = 0.005, decay = 0.1, sustain = 0.8, release = 0.15;
  double acurve = -4, dcurve = -4, rcurve = -4;
  double bend = 0;
};

using Base = pd_own::Device<ids::kCount, 2>;

struct Voice {
  double sampleRate = 48000.0;
  Adsr env;
  double note = -1;
  double velocity = 1;
  long long age = 0;
  bool releasing = false;
  int holds = 0;
  double targetHz = 440, currentHz = 440;
  double phase = 0;
  double pulse = 0;
  bool pulsing = false;
  int index = 0, pulses = 0;
  double amp = 1;
  bool pending = false, under = false;
  double u = 0;
  int stage = 0;
  double out = 0;
  double air = 0;
  double v = -1, vInt = 0;
  double dcIn = 0, dcOut = 0;

  void init(double sr) {
    sampleRate = sr;
    env.init(sr);
    note = -1; velocity = 1; age = 0; releasing = false; holds = 0;
    targetHz = 440; currentHz = 440;
    reset();
  }

  void reset() {
    phase = 0;
    pulse = 0; pulsing = false; index = 0; pulses = 0; amp = 1; pending = false; under = false;
    u = 0; stage = 0; out = 0; air = 0;
    v = -1; vInt = 0;
    dcIn = 0; dcOut = 0;
  }

  bool active() const { return env.active(); }

  void noteOn(double n, double vel, const Params& s, const Base& c, double glideFrom) {
    const bool fresh = !env.active();
    note = n;
    velocity = vel;
    releasing = false;
    targetHz = midiToHz(n);
    currentHz = glideFrom >= 0 && s.glide > 0 ? glideFrom : targetHz;
    if (fresh) {
      reset();
      phase = 1;
      const double pitch = currentHz * std::pow(2.0, s.bend / 12);
      const double formant = formantHz(c.ctl(ids::formant, 0), c.ctl(ids::track, 0), pitch, sampleRate);
      air = c.ctl(ids::air, 0);
      v = -driveOf(air);
      vInt = curveIntegral(v);
      if (s.mode == kSquare) {
        const double length = pitch / formant;
        const double covers = length > 1 ? std::ceil(length) : 1.0;
        dcIn = -0.5 * (1 - length / covers);
      } else {
        const int count = pulsesFor(c.ctl(ids::count, 0), formant, pitch);
        const double b = c.ctl(ids::decay, 0);
        double sum = 0;
        double g = 1;
        for (int k = 0; k < (count < 1 ? 1 : count); ++k) { sum += g; g *= b; }
        const double length = pitch / formant;
        const double covers = count < 1 ? std::ceil(length) : 1.0;
        dcIn = (0.5 * sum * length) / covers;
      }
      dcOut = 0;
    }
    env.gateOn(true);
  }

  void noteOff() {
    releasing = true;
    env.gateOff();
  }

  void train(double start, double count, double formant, double pitch) {
    const int n = pulsesFor(count, formant, pitch);
    under = n < 1;
    pulses = n < 1 ? 1 : n;
    index = 0;
    amp = 1;
    pulse = start;
    pulsing = true;
    pending = false;
  }

  double vosim(double inc, double pinc, double count, double decay, double formant, double pitch) {
    if (pulsing) {
      pulse += pinc;
      if (pulse >= 1) {
        pulse -= 1;
        if (pending) train(pulse, count, formant, pitch);
        else if (++index < pulses) amp *= decay;
        else pulsing = false;
      }
    }
    phase += inc;
    if (phase >= 1) {
      phase -= 1;
      if (!pulsing) train((phase / inc) * pinc, count, formant, pitch);
      else if (!under) pending = true;
    }
    if (!pulsing) return 0;
    const double s = std::sin(kPi * pulse);
    return amp * s * s;
  }

  double square(double inc, double rise, double fall) {
    const double before = phase;
    phase += inc;
    double trigger = -1;
    if (phase >= 1) {
      phase -= 1;
      trigger = (1 - before) / inc;
      if (trigger > 1) trigger = 1;
    }
    double t = 0;
    double h = u;
    double next = 0;
    for (int guard = 0; guard < 8; ++guard) {
      const double slope = stage == 1 ? rise : (stage == 2 ? -fall : 0.0);
      double end = 2;
      if (stage == 1) end = t + (1 - h) / rise;
      else if (stage == 2) end = t + h / fall;
      const double fires = trigger >= t ? trigger : 2.0;
      if (end > 1 && fires > 1) { h += slope * (1 - t); break; }
      double change;
      if (fires <= end) {
        h += slope * (fires - t);
        t = fires;
        trigger = -1;
        if (stage == 0 || (stage == 2 && h <= kReceptive)) {
          stage = 1;
          change = rise - slope;
        } else {
          continue;
        }
      } else {
        t = end;
        if (stage == 1) { h = 1; stage = 2; change = -fall - rise; } else { h = 0; stage = 0; change = fall; }
      }
      const double a = 1 - t;
      out += (change * a * a * a) / 6;
      next += (change * t * t * t) / 6;
    }
    u = h;
    const double value = out;
    out = h + next;
    return value;
  }

  /** Renders `count` samples at the voice's rate into `buf`, enveloped, added to what is there. */
  void process(double* buf, int count, const Params& s, const Base& c) {
    const double sr = sampleRate;
    env.setStages(s.attack, s.decay, s.sustain, s.release, s.acurve, s.dcurve, s.rcurve);
    const bool sq = s.mode == kSquare;
    const double fast = sr * kOver;
    const double glideK = s.glide > 0 ? 1 - std::exp(-1 / (sr * s.glide)) : 1.0;
    const double dcR = 1 - (2 * kPi * kDcHz) / fast;
    const double airK = 1 - std::exp(-1 / (kAirSec * sr));
    const bool pitchMoving = currentHz != targetHz;
    double pitch = currentHz * std::pow(2.0, s.bend / 12);
    for (int i = 0; i < count; ++i) {
      if (currentHz != targetHz) {
        currentHz += (targetHz - currentHz) * glideK;
        if (std::fabs(currentHz - targetHz) < 0.01) currentHz = targetHz;
      }
      if (pitchMoving) pitch = currentHz * std::pow(2.0, s.bend / 12);
      const double formant = formantHz(c.ctl(ids::formant, i), c.ctl(ids::track, i), pitch, sr);
      const double inc = pitch / fast;
      const double gain = env.next() * velocity * c.ctl(ids::level, i);
      double rise = 0, fall = 0, drive = 0, norm = 1;
      const double pinc = formant / fast;
      if (sq) {
        const double length = fast / formant;
        const double share = 1 - std::fmin(1.0, std::fmax(0.0, c.ctl(ids::shape, i)));
        rise = 1 / std::fmax(1.0, share * length);
        fall = 1 / std::fmax(1.0, (1 - share) * length);
        air += (c.ctl(ids::air, i) - air) * airK;
        drive = driveOf(air);
        norm = 0.5 / std::sin(kPi * 0.5 * std::fmin(1.0, drive));
      }
      const double count0 = c.ctl(ids::count, i);
      const double decay = std::fmin(1.0, std::fmax(0.0, c.ctl(ids::decay, i)));
      for (int k = 0; k < kOver; ++k) {
        double x;
        if (sq) {
          const double w = drive * (2 * square(inc, rise, fall) - 1);
          const double wInt = curveIntegral(w);
          const double dv = w - v;
          x = (std::fabs(dv) > kSlopeEpsilon ? (wInt - vInt) / dv : curve(0.5 * (w + v))) * norm;
          v = w;
          vInt = wInt;
        } else {
          x = vosim(inc, pinc, count0, decay, formant, pitch);
        }
        const double d = x - dcIn + dcR * dcOut;
        dcIn = x;
        dcOut = d;
        buf[i * kOver + k] += d * gain;
      }
    }
    if (!isPlayable(dcOut + out)) reset();
  }
};

struct Device : Base {
  Params params;
  Pool<Voice> voices;
  int voiceCount = 8;
  long long clock = 0;
  struct Event { int kind; double note; double velocity; };
  Event events[64];
  int eventCount = 0;
  Stage2x stageA, stageB;
  double fastBuf[kBlock * kOver] = { 0 };
  double halfBuf[kBlock * 2] = { 0 };
  double downBuf[kBlock] = { 0 };

  void pd_init(double sr) {
    sampleRate = sr;
    voices.reserve(kFirstVoices, [](Voice&) {});
    for (auto& v : voices) v.init(sr);
    params = Params();
    voiceCount = 8;
    clock = 0;
    eventCount = 0;
    stageA.reset();
    stageB.reset();
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
    v.mode = static_cast<int>(clamp(jsRound(p[ids::mode]), 0.0, kModes - 1));
    v.glide = p[ids::glide];
    v.attack = p[ids::ampenv_attack];
    v.decay = p[ids::ampenv_decay];
    v.sustain = p[ids::ampenv_sustain];
    v.release = p[ids::ampenv_release];
    v.acurve = p[ids::env_acurve];
    v.dcurve = p[ids::env_dcurve];
    v.rcurve = p[ids::env_rcurve];
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
    const double from = voice->active() && voice->note >= 0 ? midiToHz(voice->note) : -1;
    voice->age = clock++;
    voice->noteOn(note, velocity, params, *this, from);
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
    std::memset(fastBuf, 0, sizeof(double) * static_cast<size_t>(frames * kOver));
    for (auto& v : voices) if (v.active()) v.process(fastBuf, frames, params, *this);
    stageB.down(fastBuf, halfBuf, frames * 2);
    stageA.down(halfBuf, downBuf, frames);
    float* outl = outL();
    float* outr = outR();
    for (int i = 0; i < frames; ++i) {
      outl[i] = static_cast<float>(downBuf[i]);
      outr[i] = static_cast<float>(downBuf[i]);
    }
  }
};

}  // namespace pd_Formant

extern "C" PdAny* pd_make_Formant() { return new PdAdapter<pd_Formant::Device>(); }
