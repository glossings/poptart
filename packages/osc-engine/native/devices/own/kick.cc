// The Kick: an analog-style bass drum, one hit per note.
//
// Translated from web-engine/src/devices/kick.mjs, which says what each part is and why. The
// same state, the same arithmetic in the same order, in double; the parity test holds the two
// together. A control a signal moves is read per sample where the browser reads it per sample
// (see own/pd-own.h). A drawn Pitch Env curve reaches it through the host's /shape command
// (pd_shape), sampled by the engine exactly as the browser's engine samples it.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "pd-own-ids.h"

namespace pd_Kick {

namespace ids = pd_ids::Kick;
using namespace pd_own;

constexpr double kSweepMaxSt = 48;
constexpr double kSweepSec = 0.073;
constexpr double kSweepKnee = 0.66;
constexpr double kSweepHoldSec = 0.003;
constexpr double kChargeSec = 0.0005;
constexpr double kDrawSec = 0.4;
constexpr double kDriveMin = 0.1;
constexpr double kDriveMax = 6;
constexpr double kTailKneeMin = 0.02;
constexpr double kTailKneeMax = 3;
constexpr double kBodyBias = 0.08;
constexpr double kBodyHpHz = 4;
constexpr double kClickRiseSec = 0.0004;
constexpr double kNoiseGain = 0.7;
constexpr double kToneSoftHz = 150;
constexpr double kToneBrightHz = 20000;
constexpr double kSilent = 1e-5;
constexpr double kChokeSec = 0.003;
constexpr double kDriveFull = 1.0 / 48;
constexpr double kDriveNone = 1.0 / 12;
constexpr double kTwoPi = 6.283185307179586;
/** The points a drawn curve is sampled at: the browser engine's SHAPE_POINTS. */
constexpr int kShapePoints = 256;
/** The room a fresh device has for drawn curves. */
constexpr int kFirstShapeSlots = 8;

inline double kickDrive(double drive) { return kDriveMin + (kDriveMax - kDriveMin) * clamp(drive, 0.0, 1.0); }
inline double kickTailKnee(double tail) { return kTailKneeMin * std::pow(kTailKneeMax / kTailKneeMin, clamp(tail, 0.0, 1.0)); }
inline double kickDrawX(double seconds) { return std::sqrt(std::fmax(0.0, seconds) / kDrawSec); }
inline double kickSweptHz(double hz, double st, double e) { return hz * (1 + (std::pow(2.0, st / 12) - 1) * e); }

/** A drawn curve, read at `t` - linear between the points the engine sampled. */
inline double drawnAt(const float* table, int n, double t) {
  const double x = clamp(t, 0.0, 1.0) * (n - 1);
  const int i = static_cast<int>(std::floor(x));
  const double a = table[i];
  const double b = table[i + 1 < n ? i + 1 : n - 1];
  return a + (b - a) * (x - i);
}

/** The trigger pulse at sample `n` of a hit whose pulse ends at `edge` samples, both edges band-limited. */
inline double gateAt(long long n, double edge) {
  const double nd = static_cast<double>(n);
  double g = nd < edge ? 1.0 : 0.0;
  if (n == 0) g -= 0.5;
  if (nd < edge && edge <= nd + 1) {
    const double p = nd + 1 - edge;
    g -= p * p * 0.5;
  } else if (nd - 1 < edge && edge <= nd) {
    const double p = nd - edge;
    g += (1 - p) * (1 - p) * 0.5;
  }
  return g;
}

struct Drawn { float table[kShapePoints]; int length = 0; };

/** The fixed sweep, stepped a sample at a time (kick.mjs's KickSweep). */
struct Sweep {
  double kc = 0, kFall = 0, hold = 0;
  double edge = 0, charge = 0, fall = 1;

  void init(double sr) {
    kc = 1 - std::exp(-1 / (kChargeSec * sr));
    kFall = std::exp(-1 / (kSweepSec * sr));
    hold = kSweepHoldSec * sr;
    start(0);
  }

  void start(double e) { edge = e; charge = 0; fall = 1; }

  double next(double nd) {
    if (nd < edge) {
      charge += (1 - charge) * kc;
      return charge;
    }
    if (nd < edge + hold) return charge;
    const double e = (1 + kSweepKnee) * fall - kSweepKnee;
    fall *= kFall;
    return e > 0 ? charge * e : 0.0;
  }
};

/** The device's base, which is where a voice reads a moving control from. */
using Base = pd_own::Device<ids::kCount, 2>;

struct Voice {
  double sampleRate = 48000.0;
  bool active = false;
  long long n = 0;
  double note = 0;
  double velocity = 1;
  long long age = 0;
  double phase = 0, edge = 0, env = 1;
  const Drawn* pitchTable = nullptr;
  Sweep sweep;
  int choke = -1;
  unsigned int state = 1;
  double hpIn = 0, hpOut = 0, lp = 0;

  void init(double sr) { sampleRate = sr; sweep.init(sr); reset(); age = 0; }

  void reset() {
    active = false;
    n = 0; note = 0; velocity = 1;
    phase = 0; edge = 0;
    pitchTable = nullptr;
    sweep.start(0);
    env = 1;
    choke = -1;
    state = 1;
    hpIn = 0; hpOut = 0; lp = 0;
  }

  void noteOn(double nn, double vel, unsigned int seed, double clickMs, const Drawn* pt) {
    const long long keepAge = age;
    reset();
    age = keepAge;
    active = true;
    note = nn;
    velocity = vel;
    state = seed ? seed : 1u;
    edge = std::fmax(0.0, clickMs) * 0.001 * sampleRate;
    sweep.start(edge);
    pitchTable = pt;
  }

  int chokeLength() const {
    const double c = jsRound(kChokeSec * sampleRate);
    return c < 1 ? 1 : static_cast<int>(c);
  }

  void chokeOff() { if (active && choke < 0) choke = chokeLength(); }

  double white() {
    unsigned int x = state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    state = x;
    return static_cast<double>(x) / 2147483648.0 - 1.0;
  }

  void process(float* outL, float* outR, int count, double bend, const Base& c) {
    const double sr = sampleRate;
    const double hpA = std::exp((-kTwoPi * kBodyHpHz) / sr);
    const double kRise = std::exp(-1 / (kClickRiseSec * sr));
    double lastTone = -1;
    double kTone = 1;
    double lastDecay = -1;
    double lastTail = -1;
    double knee = 1;
    double kEnv = 1;
    for (int i = 0; i < count; ++i) {
      if (!active) break;
      const long long nn = n;
      const double nd = static_cast<double>(nn);

      const double noteHz = midiToHz(note + bend);
      double hz;
      if (pitchTable) {
        hz = noteHz * std::pow(2.0, (kSweepMaxSt * drawnAt(pitchTable->table, pitchTable->length, kickDrawX(nd / sr))) / 12);
      } else {
        const double st = clamp(c.ctl(ids::sweep, i), 0.0, kSweepMaxSt);
        hz = kickSweptHz(noteHz, st, sweep.next(nd));
      }
      hz = std::fmin(0.49 * sr, hz);

      const double decay = std::fmax(1e-3, c.ctl(ids::decay, i));
      const double tail = c.ctl(ids::tail, i);
      if (decay != lastDecay || tail != lastTail) {
        knee = kickTailKnee(tail);
        kEnv = std::exp(-std::log((1 + knee) / knee) / (decay * sr));
        lastDecay = decay;
        lastTail = tail;
      }
      const double envNow = (1 + knee) * env - knee;
      const double level = envNow > 0 ? envNow : 0.0;
      env *= kEnv;

      const double gate = gateAt(nn, edge);
      double click = 0;
      if (nd <= edge + 1) {
        const double tone = clamp(c.ctl(ids::clicktone, i), 0.0, 1.0);
        const double pulse = gate * (1 - std::pow(kRise, nd));
        click = c.ctl(ids::click, i) * ((1 - tone) * pulse + tone * white() * kNoiseGain * gate);
      }

      const double ratio = hz / sr;
      const double room = clamp((kDriveNone - ratio) / (kDriveNone - kDriveFull), 0.0, 1.0);
      const double drive = kDriveMin + (kickDrive(c.ctl(ids::drive, i)) - kDriveMin) * room;
      const double body = -std::sin(kTwoPi * phase) * level;
      phase += ratio;
      if (phase >= 1) phase -= 1;
      const double lift = std::tanh(drive * kBodyBias);
      const double shaped = (std::tanh(drive * (body + click + kBodyBias)) - lift) / (std::tanh(drive * (1 + kBodyBias)) - lift);
      hpOut = hpA * (hpOut + shaped - hpIn);
      hpIn = shaped;

      const double tone = clamp(c.ctl(ids::tone, i), 0.0, 1.0);
      if (tone != lastTone) {
        kTone = 1 - std::exp((-kTwoPi * kToneSoftHz * std::pow(kToneBrightHz / kToneSoftHz, tone)) / sr);
        lastTone = tone;
      }
      lp += kTone * (hpOut - lp);
      double gain = velocity * c.ctl(ids::level, i);
      if (choke >= 0) {
        gain *= static_cast<double>(choke) / chokeLength();
        choke -= 1;
        if (choke < 0) active = false;
      }
      const double v = lp * gain;
      outL[i] = static_cast<float>(outL[i] + v);
      outR[i] = static_cast<float>(outR[i] + v);
      n = nn + 1;

      if (level == 0 && nd > edge + 1 && std::fabs(lp) < kSilent && std::fabs(hpOut) < kSilent) active = false;
    }
    if (!isPlayable(lp + hpOut + phase)) reset();
  }
};

struct Device : Base {
  Voice voices[2];
  /** The drawn pitch curves, by option slot. */
  Pool<Drawn> shapes;
  long long clock = 0;
  unsigned int seed = 1;
  double bend = 0;
  double lastNote = -1;
  bool played = false;
  struct Event { double note; double velocity; };
  Event events[64];
  int eventCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& v : voices) v.init(sr);
    shapes.reserve(kFirstShapeSlots, [](Drawn&) {});
    clock = 0;
    seed = 1;
    bend = 0;
    played = false;
    eventCount = 0;
  }

  void pd_note_on(float note, float velocity) {
    if (eventCount < 64) events[eventCount++] = { note, velocity };
  }

  /** A hit plays out whatever the note's length; all notes off fades whatever is sounding. */
  void pd_note_off(float note) {
    if (note < 0) {
      eventCount = 0;
      for (auto& v : voices) v.chokeOff();
    }
  }

  void pd_bend(float semitones) { bend = isPlayable(semitones) ? semitones : 0.0; }

  /** A curve somebody drew, for a Pitch Env slot past the fixed one. */
  bool pd_shape(int param, int slot, const float* table, int count) {
    if (param != ids::pitchenv || slot < 0 || !table || count <= 0) return true;
    if (slot >= shapes.size()) { shapes.ask(slot + 1); return false; }
    const int n = count < kShapePoints ? count : kShapePoints;
    Drawn& one = shapes[slot];
    std::memcpy(one.table, table, sizeof(float) * static_cast<size_t>(n));
    one.length = n;
    return true;
  }

  /** The note last played, for the picture of the sweep (kick.mjs's report). */
  int pd_report(float* out, int capacity) {
    if (!played || capacity < 1) return 0;
    out[0] = static_cast<float>(lastNote);
    return 1;
  }

  bool pd_work_wanted() { return shapes.wanted(); }
  void pd_work() { shapes.build([](Drawn&) {}); }
  void pd_work_done() { shapes.install(); }
  void pd_work_release() { shapes.release(); }

  const Drawn* drawn() {
    const double index = jsRound(p[ids::pitchenv]);
    if (!(index >= 1)) return nullptr;
    const int i = static_cast<int>(index);
    if (i >= shapes.size() || shapes[i].length <= 0) return nullptr;
    return &shapes[i];
  }

  void startNote(double note, double velocity) {
    Voice* voice = nullptr;
    for (auto& v : voices) if (!v.active) { voice = &v; break; }
    if (!voice) voice = voices[0].age <= voices[1].age ? &voices[0] : &voices[1];
    for (auto& v : voices) if (&v != voice) v.chokeOff();
    seed = static_cast<unsigned int>(seed * 1664525u + 1013904223u);
    voice->noteOn(note, velocity, seed, p[ids::clicklength], drawn());
    voice->age = clock++;
    lastNote = note;
    played = true;
  }

  void pd_process(int frames) {
    for (int i = 0; i < eventCount; ++i) startNote(events[i].note, events[i].velocity);
    eventCount = 0;
    float* outl = outL();
    float* outr = outR();
    std::memset(outl, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(outr, 0, sizeof(float) * static_cast<size_t>(frames));
    for (auto& v : voices) if (v.active) v.process(outl, outr, frames, bend, *this);
  }
};

}  // namespace pd_Kick

extern "C" PdAny* pd_make_Kick() { return new PdAdapter<pd_Kick::Device>(); }
