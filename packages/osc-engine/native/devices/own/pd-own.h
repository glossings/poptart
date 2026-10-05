// poptart's OWN devices, on the desktop: what every one of them is built on.
//
// The ported modules beside these (Plaits, Clouds, Galactic, ...) are one C++ source compiled
// twice, for WebAssembly and for scsynth, so they cannot drift. poptart's own devices are not
// that: their DSP is written in JavaScript, because it was written for an AudioWorklet, and a
// worklet is not something a server can run. So these are a SECOND IMPLEMENTATION of the same
// devices, which is the thing the ported ones were careful to avoid - and the way that is made
// safe is a parity test rather than a promise: native-device-parity.test.mjs runs the browser's
// processor and this one over the same input with the same controls and compares the output,
// device by device. A change to either side that is not a change to both fails there.
//
// WHAT HAS TO MATCH, AND WHAT CANNOT. The structure is translated line for line: the same state,
// the same per-sample arithmetic, in the same order, in double precision (a JavaScript number is
// a double, so anything else would drift on purpose). What differs is that a worklet reads a
// control PER SAMPLE when something is moving it and a device here reads one value for the
// block - that is the ABI, it is what the ported devices already do on both engines, and the
// block is 128 frames at most, so a swept control steps every 2.7 ms instead of every sample.
//
// The naming follows the JavaScript it is translated from rather than the local house style, so
// the two can be read side by side.
#pragma once

#include <cmath>
#include <cstring>
#include <type_traits>

#include "pd-device.h"

namespace pd_own {

/** The host's longest block, which is what every device's buffers are sized for. */
constexpr int kBlock = 128;

/** Decibels to a gain, the one conversion every device with a level in them needs. */
inline double dbToGain(double db) { return std::pow(10.0, db / 20.0); }

/**
 * JavaScript's Math.round, which is NOT C's.
 *
 * Math.round(-2.5) is -2: it rounds half UP, towards positive infinity, where std::lround and
 * std::round both go away from zero and answer -3. Every enum and every toggle on a device
 * arrives through one of these, so the difference is the difference between two modes.
 */
inline double jsRound(double x) { return std::floor(x + 0.5); }

/** As an index, for a mode or an option. */
inline int jsRoundInt(double x) { return static_cast<int>(jsRound(x)); }

inline double clamp(double x, double lo, double hi) { return x < lo ? lo : (x > hi ? hi : x); }

/**
 * JavaScript's ToUint32, on a number that was computed as a DOUBLE.
 *
 * This matters wherever a hash in the browser's DSP multiplies by a constant like 2654435761:
 * JavaScript has no 32-bit multiply unless Math.imul is written, so the product is a double, and
 * a product over 2^53 is ROUNDED there. Doing that multiply in exact 64-bit arithmetic here
 * would give a different hash, which means different unison phases and a different attack
 * transient - audible, and wrong. So the arithmetic is done in double, exactly as loosely as the
 * browser does it, and wrapped to 32 bits here.
 */
inline unsigned int toUint32(double x) {
  if (!std::isfinite(x)) return 0u;
  double t = std::trunc(x);
  t = std::fmod(t, 4294967296.0);
  if (t < 0) t += 4294967296.0;
  return static_cast<unsigned int>(t);
}

/**
 * Whether a number can be played. JavaScript's Number.isFinite, which NaN also fails.
 *
 * Not called `finite`: the SDK's math.h has a legacy `finite(double)` of its own, and a device
 * that pulls in a SuperCollider header gets both.
 */
inline bool isPlayable(double x) { return std::isfinite(x); }

/**
 * Two channels in, two channels out, one value per control, and the sample rate: the whole of
 * what a device has to offer the host, and the part of it that is identical for all of them.
 *
 * Laid out as the ABI wants it - two channels of kBlock frames end to end - so the host writes
 * and reads these buffers directly and a device's own process() sees exactly what the browser's
 * worklet sees in its `inputs[0]`, `inputs[1]`, `outputs[0]`, `outputs[1]`.
 */
template <int NParams, int NIn = 2>
struct Device {
  float io_in[NIn * kBlock] = { 0 };
  float io_out[2 * kBlock] = { 0 };
  float p[NParams] = { 0 };
  double sampleRate = 48000.0;

  int pd_param_count() { return NParams; }
  int pd_max_block() { return kBlock; }
  /** Two channels, or four for a device that takes its key as a pair (see PdAny::inChannels). */
  int pd_in_channels() { return NIn; }
  float* pd_in() { return io_in; }
  float* pd_out() { return io_out; }
  float* pd_params() { return p; }

  /** The input channels for this block. Both are always there; the host sums or copies. */
  const float* inL() const { return io_in; }
  const float* inR() const { return io_in + kBlock; }
  float* outL() { return io_out; }
  float* outR() { return io_out + kBlock; }

  /**
   * The key a sidechained device listens to, which is the second pair of its input.
   *
   * With nothing routed into the slot the host puts this track's own signal here, so a device
   * never has to ask whether it has a key - it listens to these two either way, exactly as the
   * browser's processor does when its host hands it no sidechain and it falls back to its input.
   */
  const float* keyL() const { static_assert(NIn >= 4, "this device did not ask for a key"); return io_in + 2 * kBlock; }
  const float* keyR() const { static_assert(NIn >= 4, "this device did not ask for a key"); return io_in + 3 * kBlock; }

  void silence(int frames) {
    std::memset(io_out, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(io_out + kBlock, 0, sizeof(float) * static_cast<size_t>(frames));
  }
};

}  // namespace pd_own
