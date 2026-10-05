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
  virtual void noteOn(float note, float velocity) { (void)note; (void)velocity; }
  virtual void noteOff(float note) { (void)note; }
  virtual void bend(float semitones) { (void)semitones; }
};

/**
 * One device's generated struct, as a PdAny.
 *
 * Instantiated in the device's OWN translation unit, because that is the only place its headers
 * and its compile flags are in force - Clouds wants a shimmed header of its own and Cloud Seed a
 * prelude, and neither should reach the other eight. What the registry sees is this interface and
 * a factory function, nothing else.
 */
template <class Device, bool IsSynth>
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
  void noteOn(float note, float velocity) override { if constexpr (IsSynth) d.pd_note_on(note, velocity); }
  void noteOff(float note) override { if constexpr (IsSynth) d.pd_note_off(note); }
  void bend(float semitones) override { if constexpr (IsSynth) d.pd_bend(semitones); }
};

/** A device, as the registry lists it. */
struct PdDeviceInfo {
  const char* name;             // what `synth("Plaits")` / `fx("Galactic")` says
  int isSynth;                  // 1 = played by notes, 0 = fed by a chain
  int sidechain;                // 1 = the second input is another signal, not this track's right channel
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
