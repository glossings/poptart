// The Wavetable synth: two wavetable oscillators, a sub, noise and an amplitude envelope.
//
// Translated from web-engine/src/dsp/voice.mjs and src/devices/wavetable.mjs. What is NOT here is
// as much of the design as what is: no filter, no LFO, no modulation matrix - poptart already has
// a modulation system, and a filter belongs on the chain after this, where an env() on its cutoff
// is the filter envelope and where it is one device shared by every synth.
//
// CROSS-MODULATION is the one thing that changes the shape of the render: an oscillator whose
// warp switch names another source is rendered a sample at a time, interleaved with what it
// reads, so the block is walked sample by sample when either oscillator is bent that way and
// oscillator by oscillator when neither is.
//
// Two things the browser has and this does not. A control that a signal moves is read per sample
// there and per block here, which is the ABI (see own/pd-own.h). And a table loaded from a
// SAMPLE - `.param("Table", "mysample")` - arrives over a message port there; there is no path
// for one on this engine yet, so the table control reads the nine shipped tables and a slot past
// them plays the first, which is what the browser does with a slot nothing has been loaded into.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "own/dsp/oscillator.h"
#include "own/dsp/tables.h"
#include "own/dsp/warp.h"
#include "pd-own-ids.h"

namespace pd_Wavetable {

namespace ids = pd_ids::Wavetable;
using namespace pd_own;

constexpr int kMaxVoices = 16;

/** A small deterministic noise source, so a patch with noise in it still renders reproducibly. */
struct Noise {
  unsigned int state = 1;
  void seed(unsigned int s) { state = s ? s : 1u; }
  double next() {
    // xorshift32 - cheap, white enough for a noise oscillator, and identical on every machine.
    //
    // The middle shift is SIGNED, which is what the browser's does: `x ^= x >> 17` on a value
    // that has been through `>>> 0` reads it as a 32-bit signed integer and carries the sign
    // down. That is not the textbook xorshift and it does not matter that it is not - what
    // matters is that it is the same sequence on both engines, so a patch with noise in it
    // sounds the same. The other two shifts are unsigned there, as they are here.
    unsigned int x = state;
    x ^= x << 13;
    x ^= static_cast<unsigned int>(static_cast<int>(x) >> 17);
    x ^= x << 5;
    state = x;
    return (static_cast<double>(x) / 2147483648.0) - 1.0;
  }
};

/** The snapshot of every control, shared by all voices. */
struct VoiceParams {
  double osc1Level = 0.5, osc1Position = 0, osc1Warp = 0;
  int osc1WarpMode = 0;
  double osc1Phase = 0, osc1Octave = 0, osc1Semis = 0, osc1Cents = 0;
  double osc1Unison = 1, osc1Detune = 15, osc1Pan = 0.5, osc1PhaseRand = 1;
  int osc1Table = 0;

  double osc2Level = 0, osc2Position = 0, osc2Warp = 0;
  int osc2WarpMode = 0;
  double osc2Phase = 0, osc2Octave = 0, osc2Semis = 0, osc2Cents = 0;
  double osc2Unison = 1, osc2Detune = 15, osc2Pan = 0.5, osc2PhaseRand = 1;
  int osc2Table = 0;

  double subLevel = 0, subOctave = -1, subShape = 0;
  double noiseLevel = 0;

  double ampAttack = 0.005, ampDecay = 0.1, ampSustain = 0.8, ampRelease = 0.15;
  double envAttackCurve = -4, envDecayCurve = -4, envReleaseCurve = -4, envScale = 1;

  double glide = 0;
  int glideMode = 0;  // 0 legato (from a voice still sounding), 1 always - see Device
  double level = 0.7;
  /** Pitch bend in semitones, on every voice at once - the track's .bend(), not a knob. */
  double bend = 0;
};

struct Voice {
  double sampleRate = 48000.0;
  WavetableOscillator osc1;
  WavetableOscillator osc2;
  WavetableOscillator sub;
  Noise noise;
  Adsr ampEnv;

  double note = -1;
  double velocity = 1;
  long long age = 0;
  bool releasing = false;
  int holds = 0;  // note-ons on `note` still waiting for their offs (see Device)
  double targetHz = 440;
  double currentHz = 440;

  // Scratch: the oscillators add into these and the level reads them.
  float bufL[kBlock] = { 0 };
  float bufR[kBlock] = { 0 };

  void init(double sr) {
    sampleRate = sr;
    osc1.init(sr);
    osc2.init(sr);
    sub.init(sr);
    ampEnv.init(sr);
    note = -1;
    velocity = 1;
    age = 0;
    releasing = false;
    holds = 0;
  }

  bool active() const { return ampEnv.active(); }

  void noteOn(double n, double vel, const VoiceParams& p, unsigned int seed, double glideFrom) {
    note = n;
    velocity = vel;
    releasing = false;
    targetHz = midiToHz(n);
    currentHz = glideFrom > 0 && p.glide > 0 ? glideFrom : targetHz;

    osc1.phaseRand = p.osc1PhaseRand;
    osc2.phaseRand = p.osc2PhaseRand;
    sub.phaseRand = 0;
    osc1.start(seed);
    osc2.start(seed ^ 0x9e3779b9u);
    sub.start(seed ^ 0x85ebca6bu);
    noise.seed(seed ^ 0xc2b2ae35u);

    // A voice taken while it is still sounding keeps its envelope level: clearing it is a click
    // on the steal, and a steal is the one place clicks hide.
    ampEnv.gateOn(true);
  }

  void noteOff() {
    releasing = true;
    ampEnv.gateOff();
  }

  /** Silences the voice outright. Used when a voice has to be taken before it finished. */
  void kill() {
    ampEnv.reset();
    note = -1;
    releasing = false;
    holds = 0;
  }

  void setTables(const Table* t1, const Table* t2, const Table* subT) {
    osc1.setTable(t1);
    osc2.setTable(t2);
    sub.setTable(subT);
  }

  /** Hands an oscillator its controls for the block. */
  void aim(WavetableOscillator& osc, double baseHz, double octave, double levelWant,
           double phaseWant, double semisWant, double centsWant, double positionWant,
           double warpWant, int warpMode, double unison, double detune, double pan) {
    osc.frequency = baseHz * std::pow(2.0, octave);
    osc.level = levelWant;
    osc.phase = phaseWant;
    osc.semis = semisWant;
    osc.cents = centsWant;
    osc.position = positionWant;
    osc.warpAmount = warpWant;
    osc.warpMode = warpMode;
    osc.unison = unison;
    osc.detuneCents = detune;
    osc.panSpread = pan;
  }

  /** One sample of an oscillator bent by whatever its cross-mode names. */
  void bent(WavetableOscillator& osc, CrossMod cross, double amount, WavetableOscillator& other,
            double noiseSample, int i) {
    if (!cross.is()) { osc.sample(i, bufL, bufR); return; }
    const double mod = cross.source == kSourceOsc ? other.last
                     : (cross.source == kSourceSub ? sub.last : noiseSample);
    if (cross.kind == kCrossFm) osc.sample(i, bufL, bufR, 0, 1 + fmDepth(amount) * mod);
    else if (cross.kind == kCrossPm) osc.sample(i, bufL, bufR, pmDepth(amount) * mod);
    else osc.sample(i, bufL, bufR, 0, 1, 1 + amount * (mod - 1));
  }

  /** Renders one block and adds it into the output. */
  void process(float* outL, float* outR, int count, const VoiceParams& p) {
    if (!ampEnv.active()) return;
    for (int i = 0; i < count; ++i) { bufL[i] = 0; bufR[i] = 0; }

    // Glide is a per-block approach toward the target, which is plenty: a glide shorter than a
    // block is instant anyway, and anything audible lasts tens of blocks.
    if (p.glide > 0 && currentHz != targetHz) {
      const double blockSec = count / sampleRate;
      const double k = 1 - std::exp(-blockSec / std::fmax(1e-4, p.glide));
      currentHz += (targetHz - currentHz) * k;
      if (std::fabs(currentHz - targetHz) < 0.01) currentHz = targetHz;
    } else {
      currentHz = targetHz;
    }
    const double baseHz = p.bend ? currentHz * std::pow(2.0, p.bend / 12.0) : currentHz;

    aim(osc1, baseHz, p.osc1Octave, p.osc1Level, p.osc1Phase, p.osc1Semis, p.osc1Cents,
        p.osc1Position, p.osc1Warp, p.osc1WarpMode, p.osc1Unison, p.osc1Detune, p.osc1Pan);
    aim(osc2, baseHz, p.osc2Octave, p.osc2Level, p.osc2Phase, p.osc2Semis, p.osc2Cents,
        p.osc2Position, p.osc2Warp, p.osc2WarpMode, p.osc2Unison, p.osc2Detune, p.osc2Pan);
    sub.frequency = baseHz * std::pow(2.0, p.subOctave);
    sub.position = p.subShape;
    sub.level = p.subLevel;
    sub.cents = 0;

    const CrossMod cross1 = crossModOf(p.osc1WarpMode);
    const CrossMod cross2 = crossModOf(p.osc2WarpMode);
    // A source another oscillator reads has to render even at zero level.
    osc1.heard = cross2.source == kSourceOsc;
    osc2.heard = cross1.source == kSourceOsc;
    sub.heard = cross1.source == kSourceSub || cross2.source == kSourceSub;
    const bool wantNoise = p.noiseLevel > 0 || cross1.source == kSourceNoise
        || cross2.source == kSourceNoise;

    if (!cross1.is() && !cross2.is()) {
      osc1.process(bufL, bufR, count);
      osc2.process(bufL, bufR, count);
      sub.process(bufL, bufR, count);
      if (wantNoise) {
        for (int i = 0; i < count; ++i) {
          const double v = noise.next() * p.noiseLevel;
          bufL[i] = static_cast<float>(static_cast<double>(bufL[i]) + v);
          bufR[i] = static_cast<float>(static_cast<double>(bufR[i]) + v);
        }
      }
    } else {
      // Interleaved: each sample of osc 1, then osc 2, then the sub, reading each other as they
      // go. Osc 2 bending osc 1 is heard the same sample, osc 1 bending osc 2 a sample late,
      // which is the one-sample feedback delay every FM synth has somewhere.
      const bool on1 = osc1.begin(count);
      const bool on2 = osc2.begin(count);
      const bool onSub = sub.begin(count);
      double noiseSample = 0;
      for (int i = 0; i < count; ++i) {
        if (wantNoise) {
          noiseSample = noise.next();
          const double v = noiseSample * p.noiseLevel;
          bufL[i] = static_cast<float>(static_cast<double>(bufL[i]) + v);
          bufR[i] = static_cast<float>(static_cast<double>(bufR[i]) + v);
        }
        if (on1) bent(osc1, cross1, p.osc1Warp, osc2, noiseSample, i);
        if (on2) bent(osc2, cross2, p.osc2Warp, osc1, noiseSample, i);
        if (onSub) sub.sample(i, bufL, bufR);
      }
    }

    ampEnv.setStages(p.ampAttack, p.ampDecay, p.ampSustain, p.ampRelease,
                     p.envAttackCurve, p.envDecayCurve, p.envReleaseCurve, p.envScale);

    for (int i = 0; i < count; ++i) {
      const double g = ampEnv.next() * velocity * p.level;
      outL[i] = static_cast<float>(static_cast<double>(outL[i]) + bufL[i] * g);
      outR[i] = static_cast<float>(static_cast<double>(outR[i]) + bufR[i] * g);
    }
  }
};

struct Device : pd_own::Device<ids::kCount, 2> {
  VoiceParams params;
  Voice voices[kMaxVoices];
  int voiceCount = 8;
  long long clock = 0;       // bumped per note, so "oldest" has a meaning
  unsigned int seed = 1;
  struct Event { int kind; double note; double velocity; };
  Event events[64];
  int eventCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    // Builds the shipped tables the first time any Wavetable is opened - on this thread, which
    // is the non-realtime one (a device is created there), never on the audio thread.
    builtInTables();
    subTable();
    for (auto& v : voices) v.init(sr);
    params = VoiceParams();
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

  /** The table an index names; a slot nothing has been loaded into plays the first table. */
  const Table* tableFor(int index) {
    const std::vector<Table>& tables = builtInTables();
    const int i = index < 0 ? 0 : index;
    return i < static_cast<int>(tables.size()) ? &tables[static_cast<size_t>(i)] : &tables[0];
  }

  /** The controls, in real units, as the browser's setParams unpacks them into its struct. */
  void readParams() {
    VoiceParams& v = params;
    v.osc1Level = p[ids::osc1_level];
    v.osc1Table = jsRoundInt(p[ids::osc1_table]);
    v.osc1Position = p[ids::osc1_position];
    v.osc1Warp = p[ids::osc1_warp];
    v.osc1WarpMode = jsRoundInt(p[ids::osc1_warpmode]);
    v.osc1Phase = p[ids::osc1_phase];
    v.osc1Octave = p[ids::osc1_octave];
    v.osc1Semis = p[ids::osc1_semi];
    v.osc1Cents = p[ids::osc1_cents];
    v.osc1Unison = p[ids::osc1_unison];
    v.osc1Detune = p[ids::osc1_detune];
    v.osc1Pan = p[ids::osc1_spread];
    v.osc1PhaseRand = p[ids::osc1_phaserand];

    v.osc2Level = p[ids::osc2_level];
    v.osc2Table = jsRoundInt(p[ids::osc2_table]);
    v.osc2Position = p[ids::osc2_position];
    v.osc2Warp = p[ids::osc2_warp];
    v.osc2WarpMode = jsRoundInt(p[ids::osc2_warpmode]);
    v.osc2Phase = p[ids::osc2_phase];
    v.osc2Octave = p[ids::osc2_octave];
    v.osc2Semis = p[ids::osc2_semi];
    v.osc2Cents = p[ids::osc2_cents];
    v.osc2Unison = p[ids::osc2_unison];
    v.osc2Detune = p[ids::osc2_detune];
    v.osc2Pan = p[ids::osc2_spread];
    v.osc2PhaseRand = p[ids::osc2_phaserand];

    v.subLevel = p[ids::sub_level];
    v.subOctave = p[ids::sub_octave];
    v.subShape = p[ids::sub_shape];
    v.noiseLevel = p[ids::noise_level];

    v.ampAttack = p[ids::ampenv_attack];
    v.ampDecay = p[ids::ampenv_decay];
    v.ampSustain = p[ids::ampenv_sustain];
    v.ampRelease = p[ids::ampenv_release];
    v.envAttackCurve = p[ids::env_acurve];
    v.envDecayCurve = p[ids::env_dcurve];
    v.envReleaseCurve = p[ids::env_rcurve];
    v.envScale = p[ids::env_scale];

    v.glide = p[ids::glide];
    v.glideMode = static_cast<int>(jsRound(p[ids::glide_mode]));
    v.level = p[ids::level];
    voiceCount = static_cast<int>(clamp(jsRound(p[ids::voices]), 1.0, kMaxVoices));
  }

  /**
   * Picks a voice for a note: the one already playing it, a free one, the oldest one already
   * releasing, and finally the oldest sounding voice.
   *
   * Stealing the oldest RELEASING voice before any held one is what keeps a held chord intact
   * while a fast part runs over the top of it.
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

  void startNote(double note, double velocity) {
    Voice* voice = allocate(note);
    // Glide slides from whatever this voice was last playing, which is how a monophonic lead
    // with one voice glides between its notes.
    const double from = voice->active() && voice->note >= 0 ? midiToHz(voice->note) : -1;
    play(voice, note, velocity, from);
  }

  /** Starts `note` on `voice`, counting it as one more hold when the voice already held it. */
  void play(Voice* voice, double note, double velocity, double from) {
    const int holds = voice->active() && voice->note == note && !voice->releasing ? voice->holds + 1 : 1;
    voice->setTables(tableFor(params.osc1Table), tableFor(params.osc2Table), &subTable());
    voice->age = clock++;
    seed = static_cast<unsigned int>(seed * 1664525u + 1013904223u);
    voice->noteOn(note, velocity, params, seed, from);
    voice->holds = holds;
  }

  static bool contains(Voice* const* list, int n, const Voice* v) {
    for (int i = 0; i < n; ++i) if (list[i] == v) return true;
    return false;
  }

  /**
   * Note-ons that start together (events[from, to)). Legato plays them in order, as they came.
   * Always deals them as a set: a note already on a voice of its own pitch first, then the rest,
   * each sliding from the nearest pitch nobody in the set has claimed. The browser's
   * WavetableSynth#startNotes, step for step.
   */
  void startNotes(int from, int to) {
    if (params.glideMode < 1) {
      for (int i = from; i < to; ++i) startNote(events[i].note, events[i].velocity);
      return;
    }
    const int limit = voiceCount;
    Voice* claimed[kMaxVoices * 2 + 2];
    int claimedCount = 0;
    int later[64];
    int laterCount = 0;
    for (int i = from; i < to; ++i) {
      Voice* own = nullptr;
      for (int k = 0; k < limit && !own; ++k) {
        Voice& v = voices[k];
        if (v.note == events[i].note && !contains(claimed, claimedCount, &v)) own = &v;  // held, releasing or just quiet
      }
      if (!own) { later[laterCount++] = i; continue; }
      claimed[claimedCount++] = own;
      play(own, events[i].note, events[i].velocity, -1);
    }
    for (int j = 0; j < laterCount; ++j) {
      const Event& e = events[later[j]];
      Voice* source = nullptr;
      double best = 1e300;
      int sourceIndex = -1;
      for (int k = 0; k < kMaxVoices; ++k) {
        Voice& v = voices[k];
        if (v.note < 0 || contains(claimed, claimedCount, &v)) continue;
        bool pitchInSet = false;
        for (int i = from; i < to; ++i) if (events[i].note == v.note) { pitchInSet = true; break; }
        if (pitchInSet) continue;
        const double d = std::fabs(v.note - e.note);
        if (d < best) { best = d; source = &v; sourceIndex = k; }
      }
      const bool reuse = source && sourceIndex < limit && !(source->active() && !source->releasing);
      Voice* voice = reuse ? source : allocate(e.note);
      const double glideFrom = source ? midiToHz(source->note)
                                      : (voice->active() && voice->note >= 0 ? midiToHz(voice->note) : -1);
      if (source && claimedCount < kMaxVoices * 2 + 2) claimed[claimedCount++] = source;
      if (claimedCount < kMaxVoices * 2 + 2) claimed[claimedCount++] = voice;
      play(voice, e.note, e.velocity, glideFrom);
    }
  }

  void stopNote(double note) {
    for (auto& v : voices) {
      if (!(v.active() && v.note == note && !v.releasing)) continue;
      if (--v.holds > 0) continue;  // an earlier note on this pitch ending: a later one still holds it
      v.holds = 0;
      v.noteOff();
    }
  }

  void pd_process(int frames) {
    readParams();
    // A table swapped under a sounding voice reaches it at the block, which is soon enough and
    // clicks no more than a switch.
    const Table* t1 = tableFor(params.osc1Table);
    const Table* t2 = tableFor(params.osc2Table);
    for (auto& v : voices) {
      if (!v.active()) continue;
      if (v.osc1.table != t1) v.osc1.setTable(t1);
      if (v.osc2.table != t2) v.osc2.setTable(t2);
    }
    for (int i = 0; i < eventCount;) {
      if (events[i].kind != 1) { stopNote(events[i].note); ++i; continue; }
      // A run of note-ons in one block is one set (a chord), started together.
      int end = i + 1;
      while (end < eventCount && events[end].kind == 1) ++end;
      startNotes(i, end);
      i = end;
    }
    eventCount = 0;

    float* outl = outL();
    float* outr = outR();
    std::memset(outl, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(outr, 0, sizeof(float) * static_cast<size_t>(frames));
    // Every ACTIVE voice renders, not only the first `voiceCount`: the count limits what a new
    // note may take, and a voice above it finishes its note rather than being left silent.
    for (auto& v : voices) if (v.active()) v.process(outl, outr, frames, params);
  }
};

}  // namespace pd_Wavetable

extern "C" PdAny* pd_make_Wavetable() { return new PdAdapter<pd_Wavetable::Device>(); }
