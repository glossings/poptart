// The device ABI, on the desktop side.
//
// The ported devices (Plaits, Clouds, Galactic, ...) are C++ that poptart already compiles to
// WebAssembly for the browser, behind a seven-function ABI generated per device: pd_init,
// pd_process, pd_params, pd_in, pd_out, pd_param_count, pd_max_block (see
// packages/web-engine/build/devices/build-devices.mjs). THE SAME DSP, COMPILED FOR scsynth
// INSTEAD, is what this header describes.
//
// The one thing that had to change is where a device keeps its state. The generated wrapper
// holds it in file-scope globals, which is right for a worklet - one AudioWorkletProcessor per
// node, one module instance per processor - and allows exactly one instance per process, which
// is wrong for a server where eight tracks may each want a Plaits. So the native build lifts the
// wrapper's state into a struct (`structify` in build/devices/native.mjs) and this is what it
// lifts it into: one object per device instance, created on the non-realtime thread, driven from
// the audio thread through these calls and nothing else.
//
// Every device looks identical from here. A Mutable module, an Airwindows reverb and a pitch
// shifter differ in what they include and how they are compiled; they do not differ in how they
// are played, which is why one UGen can host all of them.
#pragma once

#include <type_traits>

/**
 * What a control means, which is the descriptor's own answer carried into C++.
 *
 * A parameter TAKES A POSITION, 0..1, exactly as a VST parameter does - that is the contract the
 * whole pattern language rests on (`lfo()` runs 0..1, a macro is 0..1), and it is what lets a
 * modulator be pointed at any control on any device without a `.range()`. The position becomes
 * Hz, seconds, semitones or a mode number here, through the same three curves and the same
 * clamping the browser applies (descriptor.mjs's denormalize/clampParam), so a song written on
 * one engine means the same thing on the other.
 */
struct PdParamSpec {
  const char* id;        // the id `.param()` matches, lowercase
  const char* name;      // the display name, which `.param()` also matches
  float min;
  float max;
  /**
   * Where the control RESTS, as a position rather than as a value.
   *
   * A position because that is what the host holds a control at until something moves it, and
   * because the position of a default is not where a reader would guess: 2 kHz on a 20 Hz to
   * 20 kHz log sweep is two thirds of the way along, not a tenth.
   */
  float defaultPosition;
  float step;            // 0 = continuous; 1 for an enum or a toggle
  float curveExp;        // the exponent 'pow' bends the range by; unused otherwise
  int curve;             // 0 linear, 1 exponential (a ratio sweep), 2 power
};

/** Curve ids, matching the descriptor's own names. */
enum PdCurve { kPdLinear = 0, kPdExponential = 1, kPdPower = 2 };

/**
 * A FILE handed to a device: a granulator's sample, a convolver's impulse response, a wavetable.
 *
 * Two layouts of the same frames, because devices want different ones and none of them may build
 * the other on the audio thread. `mono` is every channel summed to one, with the browser's own
 * arithmetic (each channel divided by the count and added in order), which is what a granulator
 * and a wavetable read. `channels` is the file as it is, interleaved, which is what a convolver
 * reads: the browser convolves each side with its own side of a stereo response. For a mono file
 * the two are the same pointer.
 *
 * The frames are at the FILE'S OWN RATE and the host owns them for as long as the device is in
 * the slot; a later file for the same (param, slot) replaces them. A device keeps the pointers
 * rather than a copy.
 */
struct PdSample {
  const float* mono;
  const float* channels;
  int frames;
  int channelCount;
  double sampleRate;
  /**
   * The wavetable frame length the file declares in its `clm ` chunk, or 0 when it declares
   * none - the browser's decodeWav reads the same chunk, and a table cut at the wrong length is
   * every frame read through the end of the one before it.
   */
  int frameLength;
};

/**
 * One device instance.
 *
 * The methods are the generated ABI under different names: a virtual call per BLOCK (not per
 * sample) is free, and it buys one UGen that can host any device rather than a UGen per device
 * and a track SynthDef that would have to be rebuilt to change one.
 *
 * `in()`, `out()` and `params()` are the device's own buffers - two channels of `maxBlock()`
 * frames laid end to end, and `paramCount()` floats in real units. The host writes into them,
 * calls `process`, and reads out. Notes and bend are ignored by an effect.
 */
struct PdAny {
  virtual ~PdAny() {}
  virtual void init(double sampleRate) = 0;
  virtual int paramCount() = 0;
  virtual int maxBlock() = 0;
  virtual float* in() = 0;
  virtual float* out() = 0;
  virtual float* params() = 0;
  virtual void process(int frames) = 0;
  /**
   * A note lands on the sample it was scheduled for, one of two ways. By default the host cuts
   * its render there and makes the call between the two pieces, which is what the browser's
   * module host does too (wasm.worklet.js) and asks nothing of a device. A device whose browser
   * twin works out something across the WHOLE block - the FM synth ramps its matrix over the
   * block, so a cut would restart the ramp - takes the offset instead (`pd_note_on_at`), is never
   * cut for a note, and places the note inside its own block as the browser's processor does.
   */
  virtual void noteOn(float note, float velocity) { (void)note; (void)velocity; }
  virtual void noteOff(float note) { (void)note; }
  virtual bool takesNoteOffsets() { return false; }
  virtual void noteOnAt(float note, float velocity, int offset) { (void)offset; noteOn(note, velocity); }
  virtual void noteOffAt(float note, int offset) { (void)offset; noteOff(note); }
  virtual void bend(float semitones) { (void)semitones; }
  /**
   * The tempo, and where the transport is - in seconds since the beat the engine last anchored.
   *
   * A delay set to a sixteenth, a chorus synced to the bar and a stutter that fires on the grid
   * all need this, and none of the ported modules does: they are modular voices, and a module
   * has no idea what a beat is. So it is a hook rather than part of the ABI every device
   * implements - a device declares `pd_transport(double bpm, double seconds)` and gets it, and
   * the adapter below finds out at compile time whether to pass it along.
   */
  virtual void transport(double bpm, double seconds) { (void)bpm; (void)seconds; }
  /**
   * How many channels the host writes into `in()`: two, or four for a device that takes a
   * sidechain as a PAIR beside its own.
   *
   * Two is the whole story for the ported modules, and for Warps - the one of them with a
   * sidechain - two is what it wants: a modular carrier and modulator are each one signal, so
   * the host sums this track to mono on the left and puts the other track on the right.
   * poptart's own compressor and ducker are mixer tools rather than modules: they pass their
   * input through in stereo and listen to a stereo key, which is four channels in and two out.
   */
  virtual int inChannels() { return 2; }
  /**
   * Whether anything is routed into the slot's key input, and whether a track's notes are.
   *
   * Only the ducker asks: its dip is triggered by notes if a track is routed in, by the key's
   * transients if one is patched, and by the clock otherwise - and silence on the key input
   * cannot tell it which, because the bus is there whether a route is or not. The half of the
   * engine that wires the routes says so instead.
   */
  virtual void keyPatched(bool on) { (void)on; }
  virtual void noteRoute(bool on) { (void)on; }
  /**
   * A FILE the device plays: a granulator's sample, a convolver's impulse response, a table.
   * Audio thread.
   *
   * `param` is the control that takes it and `slot` the entry on that control's option list the
   * file was loaded into, which is the pair the browser keys a loaded file by too (its
   * _spareOption / loadSample) - a song that loads two samples and then switches between them by
   * index has to mean the same thing on both engines. See PdSample for what the device is given
   * and who owns it: megabytes are not copied on the audio thread. A device that has to BUILD
   * something out of the frames (a wavetable's pyramid, a convolver's partitions) asks for the
   * time to do it through the work calls below.
   */
  virtual void sample(int param, int slot, const PdSample& file) {
    (void)param; (void)slot; (void)file;
  }
  /**
   * A DRAWN curve for a control that takes one (`takes: 'shape'`): Distort's transfer curve, a
   * grain window. Audio thread.
   *
   * `table` is the curve as the engine sampled it - the browser's own SHAPE_POINTS, evenly
   * spaced, read by the device the way the browser's processor reads the table it is posted. The
   * host owns the memory on the same terms as a file's frames: for as long as the device is in
   * the slot, until a later curve for the same (param, slot) replaces it.
   */
  virtual void shape(int param, int slot, const float* table, int count) {
    (void)param; (void)slot; (void)table; (void)count;
  }
  /**
   * WORK OFF THE AUDIO THREAD: building something out of a setting or a file where it is allowed
   * to take time. The host crosses the same three threads a device's open does:
   *
   *   workWanted()   audio thread, before each block's process while no work is in flight. The
   *                  controls for the block are already in params(). A device that has something
   *                  to build says so and SNAPSHOTS what it needs into its own request state.
   *   work()         the non-realtime thread. Builds from the snapshot only, into state the audio
   *                  thread does not read: the device goes on playing meanwhile.
   *   workDone()     audio thread. Swaps what was built in - pointer swaps, nothing allocated.
   *   workRelease()  the non-realtime thread. Frees what workDone swapped out.
   *
   * At most one round is in flight per device. The host guarantees the device outlives its own
   * round, and that workDone is only called while it is still the device in the slot; a device
   * replaced mid-round never hears about it again, and frees whatever it built in its destructor.
   * Until workDone, the device plays what it had: a convolver keeps its old space, a new table
   * slot plays what an empty slot plays.
   */
  virtual bool workWanted() { return false; }
  virtual void work() {}
  virtual void workDone() {}
  virtual void workRelease() {}
  /**
   * What the device is DOING, for the window drawn of it: a granulator's grains in flight. Audio
   * thread, on request. Writes at most `capacity` floats into `out` and returns how many; the
   * layout is the device's own, and the engine's Node half reads it back into the shape the
   * browser's processor reports (native-devices.js's readReport).
   */
  virtual int report(float* out, int capacity) { (void)out; (void)capacity; return 0; }
};

/** Whether a device reads the transport. */
template <class Device, class = void>
struct PdTakesTransport : std::false_type {};
template <class Device>
struct PdTakesTransport<Device, decltype(std::declval<Device&>().pd_transport(0.0, 0.0))>
    : std::true_type {};

/** Whether a device says how many input channels it takes, rather than taking the two. */
template <class Device, class = void>
struct PdSaysInChannels : std::false_type {};
template <class Device>
struct PdSaysInChannels<Device, std::void_t<decltype(std::declval<Device&>().pd_in_channels())>>
    : std::true_type {};

/** Whether a device is played by notes: a synth, or an effect whose shape a note triggers. */
template <class Device, class = void>
struct PdTakesNotes : std::false_type {};
template <class Device>
struct PdTakesNotes<Device, decltype(std::declval<Device&>().pd_note_on(0.f, 0.f))>
    : std::true_type {};

/** Whether a device places notes inside its own block, at an offset the host hands it. */
template <class Device, class = void>
struct PdTakesNoteOffsets : std::false_type {};
template <class Device>
struct PdTakesNoteOffsets<Device, decltype(std::declval<Device&>().pd_note_on_at(0.f, 0.f, 0))>
    : std::true_type {};

/** Whether a device asks to be told what is routed into its slot's key input. */
template <class Device, class = void>
struct PdTakesKeyPatched : std::false_type {};
template <class Device>
struct PdTakesKeyPatched<Device, decltype(std::declval<Device&>().pd_key_patched(false))>
    : std::true_type {};

/** Whether a device asks to be told that a track's notes are routed to it. */
template <class Device, class = void>
struct PdTakesNoteRoute : std::false_type {};
template <class Device>
struct PdTakesNoteRoute<Device, decltype(std::declval<Device&>().pd_note_route(false))>
    : std::true_type {};

/** Whether a device plays files it is handed. */
template <class Device, class = void>
struct PdTakesSample : std::false_type {};
template <class Device>
struct PdTakesSample<Device,
    decltype(std::declval<Device&>().pd_sample(0, 0, std::declval<const PdSample&>()))>
    : std::true_type {};

/** Whether a device reads drawn curves. */
template <class Device, class = void>
struct PdTakesShape : std::false_type {};
template <class Device>
struct PdTakesShape<Device,
    decltype(std::declval<Device&>().pd_shape(0, 0, (const float*)nullptr, 0))>
    : std::true_type {};

/** Whether a device asks for work off the audio thread. It then has all four calls. */
template <class Device, class = void>
struct PdTakesWork : std::false_type {};
template <class Device>
struct PdTakesWork<Device, std::void_t<decltype(std::declval<Device&>().pd_work_wanted())>>
    : std::true_type {};

/** Whether a device reports what it is doing. */
template <class Device, class = void>
struct PdReports : std::false_type {};
template <class Device>
struct PdReports<Device, std::void_t<decltype(std::declval<Device&>().pd_report((float*)nullptr, 0))>>
    : std::true_type {};

/** Whether a device is bent. Every instrument is; nothing else is. */
template <class Device, class = void>
struct PdTakesBend : std::false_type {};
template <class Device>
struct PdTakesBend<Device, decltype(std::declval<Device&>().pd_bend(0.f))>
    : std::true_type {};

/**
 * One device's generated struct, as a PdAny.
 *
 * Instantiated in the device's OWN translation unit, because that is the only place its headers
 * and its compile flags are in force - Clouds wants a shimmed header of its own and Cloud Seed a
 * prelude, and neither should reach the other eight. What the registry sees is this interface and
 * a factory function, nothing else.
 *
 * Which of the calls a device actually takes is worked out from the device itself rather than
 * from its kind: an instrument has note functions and an effect has none, EXCEPT the ducker,
 * whose dip is triggered by the notes of a track routed into it. One kind flag could not say
 * that, and a wrong answer either way is a device that does not compile.
 */
template <class Device>
struct PdAdapter : PdAny {
  Device d;
  void init(double sampleRate) override { d.pd_init(sampleRate); }
  int paramCount() override { return d.pd_param_count(); }
  int maxBlock() override { return d.pd_max_block(); }
  float* in() override { return d.pd_in(); }
  float* out() override { return d.pd_out(); }
  float* params() override { return d.pd_params(); }
  void process(int frames) override { d.pd_process(frames); }
  // `if constexpr`, not `if`: an effect's wrapper has no note calls at all - they are what the
  // generated ABI gives an instrument and nothing else - so the branch has to go at compile time.
  void noteOn(float note, float velocity) override {
    if constexpr (PdTakesNotes<Device>::value) d.pd_note_on(note, velocity);
    else { (void)note; (void)velocity; }
  }
  void noteOff(float note) override {
    if constexpr (PdTakesNotes<Device>::value) d.pd_note_off(note);
    else { (void)note; }
  }
  bool takesNoteOffsets() override { return PdTakesNoteOffsets<Device>::value; }
  void noteOnAt(float note, float velocity, int offset) override {
    if constexpr (PdTakesNoteOffsets<Device>::value) d.pd_note_on_at(note, velocity, offset);
    else noteOn(note, velocity);
  }
  void noteOffAt(float note, int offset) override {
    if constexpr (PdTakesNoteOffsets<Device>::value) d.pd_note_off_at(note, offset);
    else noteOff(note);
  }
  void bend(float semitones) override {
    if constexpr (PdTakesBend<Device>::value) d.pd_bend(semitones);
    else { (void)semitones; }
  }
  void transport(double bpm, double seconds) override {
    if constexpr (PdTakesTransport<Device>::value) d.pd_transport(bpm, seconds);
    else { (void)bpm; (void)seconds; }
  }
  int inChannels() override {
    if constexpr (PdSaysInChannels<Device>::value) return d.pd_in_channels();
    else return 2;
  }
  void keyPatched(bool on) override {
    if constexpr (PdTakesKeyPatched<Device>::value) d.pd_key_patched(on);
    else { (void)on; }
  }
  void noteRoute(bool on) override {
    if constexpr (PdTakesNoteRoute<Device>::value) d.pd_note_route(on);
    else { (void)on; }
  }
  void sample(int param, int slot, const PdSample& file) override {
    if constexpr (PdTakesSample<Device>::value) d.pd_sample(param, slot, file);
    else { (void)param; (void)slot; (void)file; }
  }
  void shape(int param, int slot, const float* table, int count) override {
    if constexpr (PdTakesShape<Device>::value) d.pd_shape(param, slot, table, count);
    else { (void)param; (void)slot; (void)table; (void)count; }
  }
  bool workWanted() override {
    if constexpr (PdTakesWork<Device>::value) return d.pd_work_wanted();
    else return false;
  }
  void work() override { if constexpr (PdTakesWork<Device>::value) d.pd_work(); }
  void workDone() override { if constexpr (PdTakesWork<Device>::value) d.pd_work_done(); }
  void workRelease() override { if constexpr (PdTakesWork<Device>::value) d.pd_work_release(); }
  int report(float* out, int capacity) override {
    if constexpr (PdReports<Device>::value) return d.pd_report(out, capacity);
    else { (void)out; (void)capacity; return 0; }
  }
};

/** A device, as the registry lists it. */
struct PdDeviceInfo {
  const char* name;             // what `synth("Plaits")` / `fx("Galactic")` says
  int isSynth;                  // 1 = played by notes, 0 = fed by a chain
  int takesNotes;               // 1 = notes reach it even though it is an effect (the ducker)
  int sidechain;                // 1 = the second input is another signal, not this track's right channel
  /**
   * 1 = the device reads a control a signal moves PER SAMPLE in the browser, so a control with
   * audio patched onto it is fed per sample here too (PoptartDevice processes such a device in
   * one-sample pieces while anything is patched). 0 = a ported module, which reads its controls
   * once a block on both engines.
   */
  int perSample;
  int paramCount;
  const PdParamSpec* params;
  PdAny* (*make)();             // allocates: NON-REALTIME THREAD ONLY
};

/** Every device this extension was built with. */
extern "C" const PdDeviceInfo* pd_device_table();
extern "C" int pd_device_count();

/** A device by name, case-insensitively, or null. */
extern "C" const PdDeviceInfo* pd_find_device(const char* name);

/** A 0..1 position as the real value the DSP reads. The browser's denormalize(), in C++. */
float pd_denormalize(const PdParamSpec& spec, float position);

/**
 * A file's interleaved channels summed to one, as the browser sums them (PdSample::mono). Shared
 * by the UGen and the parity harness, so the frames the test hands a device are the frames the
 * server hands it.
 */
void pd_mono_sum(const float* interleaved, int frames, int channels, float* out);
