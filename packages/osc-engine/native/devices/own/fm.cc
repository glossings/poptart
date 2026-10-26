// The FM synth: eight operators and a modulation matrix.
//
// Translated from web-engine/src/devices/fmsynth.mjs. No fixed algorithms: every operator can
// modulate every operator, itself included, by an amount in the matrix, and the classic
// algorithms are settings of that matrix rather than a list to pick from. Phase modulation
// throughout, which is what every FM synth since the first has actually done.
//
// The ramping in `Ramped` is not an optimization, it is the sound: a matrix cell, an operator's
// level and the depth are read on every sample of every voice and arrive once a block, and taking
// the new number at the block edge puts sidebands either side of everything sounding at the block
// rate - a buzz riding the note for as long as a control is moving.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "pd-own-ids.h"

namespace pd_FM {

namespace ids = pd_ids::FM;
using namespace pd_own;

constexpr int kOps = 8;
constexpr int kVoices = 12;

/** A wave at a phase in cycles, in -1..1, cheap enough for eight a sample a voice. */
inline double wave(int shape, double phase) {
  const double q = phase - std::floor(phase);
  switch (shape) {
    case 1: return q < 0.5 ? q * 4 - 1 : 3 - q * 4;
    case 2: return q * 2 - 1;
    case 3: return q < 0.5 ? 1 : -1;
    default: return std::sin(2.0 * M_PI * q);
  }
}

/** Values that reach their new setting ACROSS a block rather than at its edge. */
template <int N>
struct Ramped {
  double value[N];
  double target[N];
  double step[N];
  int moving[N];
  int movingCount = 0;

  void init(double fill) {
    for (int i = 0; i < N; ++i) { value[i] = fill; target[i] = fill; step[i] = 0; }
    movingCount = 0;
  }

  /** Where entry `i` should be by the end of the block. */
  void aim(int i, double want) { if (isPlayable(want)) target[i] = want; }

  /** Works out this block's per-sample increments, and which entries have one. */
  void begin(int samples) {
    movingCount = 0;
    for (int i = 0; i < N; ++i) {
      const double d = target[i] - value[i];
      if (d == 0) { step[i] = 0; continue; }
      step[i] = samples > 0 ? d / samples : 0;
      moving[movingCount++] = i;
    }
  }

  /** After the block, every entry is exactly where it was aimed - no drift over a long sweep. */
  void commit() {
    for (int r = 0; r < movingCount; ++r) value[moving[r]] = target[moving[r]];
    movingCount = 0;
  }

  /** Entry `i` at sample `t` of the block. */
  double at(int i, int t) const { return value[i] + step[i] * t; }
};

/** The per-block snapshot of every control, by operator. */
struct FmParams {
  double ratio[kOps];
  double detune[kOps];
  int fixed[kOps];
  int waveShape[kOps];
  double attack[kOps];
  double decay[kOps];
  double sustain[kOps];
  double release[kOps];
  double velocity[kOps];
  Ramped<kOps * kOps> matrix;
  Ramped<kOps> level;
  Ramped<1> depth;
  double glide = 0;
  double out = 0.6;
  double bend = 0;

  void init() {
    for (int o = 0; o < kOps; ++o) {
      ratio[o] = 1;
      detune[o] = 0;
      fixed[o] = 0;
      waveShape[o] = 0;
      attack[o] = 0.005;
      decay[o] = 0.3;
      sustain[o] = 0.7;
      release[o] = 0.3;
      velocity[o] = 0.5;
    }
    matrix.init(0);
    level.init(0);
    depth.init(0.5);
    glide = 0;
    out = 0.6;
    bend = 0;
  }

  /** Called once per block, with the whole block's length, before any voice renders. */
  void beginBlock(int samples) {
    matrix.begin(samples);
    level.begin(samples);
    depth.begin(samples);
  }

  /** And once after, so the next block starts where this one finished. */
  void commitBlock() {
    matrix.commit();
    level.commit();
    depth.commit();
  }
};

struct FmVoice {
  double sampleRate = 48000.0;
  double phase[kOps] = { 0 };
  double last[kOps] = { 0 };
  // Scratch for the controls that are moving: a voice follows the ramp into its own copy rather
  // than advancing the shared one, which the next voice of the block would then read spent.
  double mtx[kOps * kOps] = { 0 };
  double lvl[kOps] = { 0 };
  double inc[kOps] = { 0 };
  Adsr envs[kOps];
  double note = -1;
  double velocity = 1;
  long long age = 0;
  bool releasing = false;
  double targetHz = 440;
  double currentHz = 440;

  void init(double sr) {
    sampleRate = sr;
    for (auto& e : envs) e.init(sr);
    for (int o = 0; o < kOps; ++o) { phase[o] = 0; last[o] = 0; }
    note = -1;
    velocity = 1;
    age = 0;
    releasing = false;
    targetHz = 440;
    currentHz = 440;
  }

  bool active() const {
    for (const auto& e : envs) if (e.active()) return true;
    return false;
  }

  void noteOn(double n, double vel, const FmParams& p, double glideFrom) {
    note = n;
    velocity = vel;
    releasing = false;
    targetHz = midiToHz(n);
    currentHz = glideFrom > 0 && p.glide > 0 ? glideFrom : targetHz;
    for (int o = 0; o < kOps; ++o) { phase[o] = 0; last[o] = 0; }
    for (auto& e : envs) e.gateOn(true);
  }

  void noteOff() {
    releasing = true;
    for (auto& e : envs) e.gateOff();
  }

  void process(float* outl, float* outr, int count, int offset, FmParams& p) {
    if (!active()) return;
    if (p.glide > 0 && currentHz != targetHz) {
      const double k = 1 - std::exp(-(count / sampleRate) / std::fmax(1e-4, p.glide));
      currentHz += (targetHz - currentHz) * k;
      if (std::fabs(currentHz - targetHz) < 0.01) currentHz = targetHz;
    } else {
      currentHz = targetHz;
    }
    for (int o = 0; o < kOps; ++o) {
      // A fixed operator holds its frequency; the rest follow the note, bent.
      const double base = p.fixed[o] ? 100.0
                                     : currentHz * (p.bend ? std::pow(2.0, p.bend / 12.0) : 1.0);
      inc[o] = (base * p.ratio[o] * std::pow(2.0, p.detune[o] / 1200.0)) / sampleRate;
      envs[o].setStages(p.attack[o], p.decay[o], p.sustain[o], p.release[o], -4, -4, -4);
    }
    const double vel = velocity;
    // A still control is read straight out of the block's values; one that is moving is followed
    // per sample. Nothing moving is the usual case, and then this costs nothing.
    const bool mMoving = p.matrix.movingCount > 0;
    const bool lMoving = p.level.movingCount > 0;
    const bool dMoving = p.depth.movingCount > 0;
    double* matrix = mMoving ? mtx : p.matrix.value;
    double* level = lMoving ? lvl : p.level.value;
    if (mMoving) for (int i = 0; i < kOps * kOps; ++i) mtx[i] = p.matrix.value[i];
    if (lMoving) for (int i = 0; i < kOps; ++i) lvl[i] = p.level.value[i];

    for (int i = 0; i < count; ++i) {
      // Where this sample sits in the WHOLE block, not in this piece of it: the block is cut at
      // every note edge, and a ramp that restarted at each cut would step at the cuts instead.
      const int t = offset + i;
      for (int r = 0; r < p.matrix.movingCount; ++r) matrix[p.matrix.moving[r]] = p.matrix.at(p.matrix.moving[r], t);
      for (int r = 0; r < p.level.movingCount; ++r) level[p.level.moving[r]] = p.level.at(p.level.moving[r], t);
      const double depth = (dMoving ? p.depth.at(0, t) : p.depth.value[0]) * 4;

      double sum = 0;
      for (int o = 0; o < kOps; ++o) {
        const double env = envs[o].next() * (1 - p.velocity[o] + p.velocity[o] * vel);
        // The phase this operator reads: its own, plus everything modulating it from the last
        // sample - itself included, which is the matrix's diagonal: an operator's feedback.
        double mod = 0;
        for (int from = 0; from < kOps; ++from) {
          const double amount = matrix[from * kOps + o];
          if (amount > 0) mod += amount * depth * last[from];
        }
        const double v = wave(p.waveShape[o], phase[o] + mod) * env;
        last[o] = v;
        phase[o] += inc[o];
        if (phase[o] >= 1) phase[o] -= 1;
        sum += v * level[o];
      }
      const double g = p.out * 0.5;
      // Summed in double and rounded once, which is what `outL[i] += sum * g` does to a
      // Float32Array: rounding the voice's contribution first and adding it in float would
      // round twice, and eight voices of that is a difference from the browser for nothing.
      outl[i] = static_cast<float>(static_cast<double>(outl[i]) + sum * g);
      outr[i] = static_cast<float>(static_cast<double>(outr[i]) + sum * g);
    }
  }
};

// The parameter layout readParams depends on.
static_assert(ids::op1_ratio == ids::op1_level + 1, "an operator's controls are level, ratio, detune, fixed, wave, attack, decay, sustain, release, velocity");
static_assert(ids::op1_detune == ids::op1_level + 2, "an operator's controls moved");
static_assert(ids::op1_fixed == ids::op1_level + 3, "an operator's controls moved");
static_assert(ids::op1_wave == ids::op1_level + 4, "an operator's controls moved");
static_assert(ids::op1_attack == ids::op1_level + 5, "an operator's controls moved");
static_assert(ids::op1_decay == ids::op1_level + 6, "an operator's controls moved");
static_assert(ids::op1_sustain == ids::op1_level + 7, "an operator's controls moved");
static_assert(ids::op1_release == ids::op1_level + 8, "an operator's controls moved");
static_assert(ids::op1_velocity == ids::op1_level + 9, "an operator's controls moved");
static_assert(ids::op2_level == ids::op1_level + 10, "the operators are ten controls apart");
static_assert(ids::op8_level == ids::op1_level + 70, "the operators are ten controls apart");
static_assert(ids::mod_1_8 == ids::mod_1_1 + 7, "the matrix runs to-within-from");
static_assert(ids::mod_8_8 == ids::mod_1_1 + 63, "the matrix is one block of sixty-four");

struct Device : pd_own::Device<ids::kCount, 2> {
  FmParams params;
  FmVoice voices[kVoices];
  int voiceCount = 8;
  long long clock = 0;
  // Notes come with their offset into the block (pd-device.h's noteOnAt), because the matrix
  // ramps across the whole block: the block is cut at each note here, as the browser's process
  // cuts it, with the ramp read at the sample's place in the WHOLE block.
  struct Event { int at; int kind; double note; double velocity; };
  Event events[64];
  int eventCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    params.init();
    for (auto& v : voices) v.init(sr);
    voiceCount = 8;
    clock = 0;
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
      for (auto& v : voices) if (v.active()) v.noteOff();
      return;
    }
    if (eventCount < 64) events[eventCount++] = { offset > 0 ? offset : 0, 0, note, 0 };
  }

  void pd_bend(float semitones) { params.bend = isPlayable(semitones) ? semitones : 0.0; }

  /**
   * The controls, in real units, as the browser's setParams unpacks them.
   *
   * Each operator's ten controls are ten consecutive entries and the matrix is one block of
   * sixty-four, which is the descriptor's own order - asserted below rather than trusted, since a
   * control inserted in the middle of that list would otherwise quietly move every operator's
   * settings onto the operator before it.
   */
  void readParams() {
    FmParams& f = params;
    for (int o = 0; o < kOps; ++o) {
      const int base = ids::op1_level + o * 10;
      f.level.aim(o, p[base + 0]);
      f.ratio[o] = p[base + 1];
      f.detune[o] = p[base + 2];
      f.fixed[o] = p[base + 3] >= 0.5 ? 1 : 0;
      f.waveShape[o] = jsRoundInt(p[base + 4]);
      f.attack[o] = p[base + 5];
      f.decay[o] = p[base + 6];
      f.sustain[o] = p[base + 7];
      f.release[o] = p[base + 8];
      f.velocity[o] = p[base + 9];
      for (int to = 0; to < kOps; ++to) f.matrix.aim(o * kOps + to, p[ids::mod_1_1 + o * kOps + to]);
    }
    f.depth.aim(0, p[ids::depth]);
    f.glide = p[ids::glide];
    f.out = p[ids::level];
    voiceCount = static_cast<int>(clamp(jsRound(p[ids::voices]), 1.0, kVoices));
  }

  FmVoice* allocate(double note) {
    FmVoice* free = nullptr;
    FmVoice* oldestReleasing = nullptr;
    FmVoice* oldest = nullptr;
    for (int i = 0; i < voiceCount; ++i) {
      FmVoice& v = voices[i];
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
    FmVoice* voice = allocate(note);
    const double from = voice->active() && voice->note >= 0 ? midiToHz(voice->note) : -1;
    voice->age = clock++;
    voice->noteOn(note, velocity, params, from);
  }

  void stopNote(double note) {
    for (auto& v : voices) if (v.active() && v.note == note && !v.releasing) v.noteOff();
  }

  void pd_process(int frames) {
    readParams();
    // The ramps are worked out for the WHOLE block and committed after it.
    params.beginBlock(frames);
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
    params.commitBlock();
  }
};

}  // namespace pd_FM

extern "C" PdAny* pd_make_FM() { return new PdAdapter<pd_FM::Device>(); }
