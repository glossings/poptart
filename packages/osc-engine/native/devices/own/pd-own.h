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
// a double, so anything else would drift on purpose). A control something is moving at audio rate
// is read per sample here exactly where the worklet reads it per sample (Device::ctl, the
// worklet's `at`), so the two follow a patched signal the same way.
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
 * worklet sees in its `inputs[0]`, `inputs[1]`, `outputs[0]`, `outputs[1]`. The Crossover writes
 * three pairs (NOut = 6), the browser's three outputs, in that order.
 */
template <int NParams, int NIn = 2, int NOut = 2>
struct Device {
  float io_in[NIn * kBlock] = { 0 };
  float io_out[NOut * kBlock] = { 0 };
  float p[NParams] = { 0 };
  double sampleRate = 48000.0;

  int pd_param_count() { return NParams; }
  int pd_max_block() { return kBlock; }
  /** Two channels, or four for a device that takes its key as a pair (see PdAny::inChannels). */
  int pd_in_channels() { return NIn; }
  /** Two channels, or six for the Crossover's three outputs (see PdAny::outChannels). */
  int pd_out_channels() { return NOut; }
  float* pd_in() { return io_in; }
  float* pd_out() { return io_out; }
  float* pd_params() { return p; }

  /**
   * A control with AUDIO patched onto it arrives as a value per sample of the call: the host
   * writes them into the control's buffer (real units, as p[] is) and says the control is moving.
   * p[id] holds the call's first value either way, so code that reads a control once a call reads
   * what it always read. ctl(id, i) is the browser's `at(values.x, i)`: the sample's value while
   * the control is moving, the call's otherwise.
   */
  float* pd_param_buffer(int id) { return id >= 0 && id < NParams ? pb[id] : nullptr; }
  void pd_param_moving(int id, bool on) { if (id >= 0 && id < NParams) pm[id] = on; }
  double ctl(int id, int i) const { return pm[id] ? static_cast<double>(pb[id][i]) : static_cast<double>(p[id]); }
  /** Whether a control has a value per sample this call - the browser's isMoving(values.x). */
  bool isMoving(int id) const { return pm[id]; }
  float pb[NParams > 0 ? NParams : 1][kBlock];
  bool pm[NParams > 0 ? NParams : 1] = { false };

  /** The input channels for this block. Both are always there; the host sums or copies. */
  const float* inL() const { return io_in; }
  const float* inR() const { return io_in + kBlock; }
  float* outL() { return io_out; }
  float* outR() { return io_out + kBlock; }
  /** Output channel `ch`, for a device with more than one pair. */
  float* out(int ch) { return io_out + ch * kBlock; }

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
    for (int ch = 0; ch < NOut; ++ch) std::memset(io_out + ch * kBlock, 0, sizeof(float) * static_cast<size_t>(frames));
  }
};

/**
 * A list with no most: a device's voices, its loaded tables, its drawn curves - as many as it is
 * asked for. It GROWS THROUGH THE WORK ROUND (PdAny::workWanted and the rest), never on the audio
 * thread:
 *
 *   ask(n)       audio thread: room for at least n is wanted. Until it arrives the device plays
 *                with what it has.
 *   wanted()     audio thread, from pd_work_wanted: whether a round should grow it, which also
 *                snapshots how far.
 *   build(init)  the non-realtime thread, from pd_work: a new chunk, each item handed to `init`.
 *   install()    audio thread, from pd_work_done: the chunk joins the list - a pointer swap.
 *   release()    the non-realtime thread, from pd_work_release: the old chunk table goes.
 *
 * Kept in chunks that never move, each twice the size of the one before, so an item's address
 * holds for its life (a voice a table points at, a table a voice points at) and nothing is ever
 * copied. reserve(n) is for pd_init, which runs on the non-realtime thread before the device is
 * playing.
 */
template <class T>
class Pool {
 public:
  Pool() = default;
  Pool(const Pool&) = delete;
  Pool& operator=(const Pool&) = delete;
  ~Pool() {
    for (int c = 0; c < chunkCount_; ++c) delete[] chunks_[c];
    delete[] chunks_;
    delete[] sizes_;
    // A round built and never installed (the device replaced mid-round): its chunk is the last.
    if (freshTable_) { delete[] freshTable_[chunkCount_]; delete[] freshTable_; delete[] freshSizes_; }
    delete[] oldChunks_;
    delete[] oldSizes_;
  }

  int size() const { return count_; }
  T& operator[](int i) {
    for (int c = 0; c < chunkCount_; ++c) {
      if (i < sizes_[c]) return chunks_[c][i];
      i -= sizes_[c];
    }
    return chunks_[0][0];
  }

  /** Every item, in order: `for (T& v : pool)`. */
  class iterator {
   public:
    iterator(Pool* p, int c, int i) : p_(p), c_(c), i_(i) {}
    T& operator*() const { return p_->chunks_[c_][i_]; }
    iterator& operator++() {
      if (++i_ >= p_->sizes_[c_]) { ++c_; i_ = 0; }
      return *this;
    }
    bool operator!=(const iterator& o) const { return c_ != o.c_ || i_ != o.i_; }
   private:
    Pool* p_;
    int c_;
    int i_;
  };
  iterator begin() { return iterator(this, count_ ? 0 : chunkCount_, 0); }
  iterator end() { return iterator(this, chunkCount_, 0); }

  /** Room for n now. The non-realtime thread, before the device plays (pd_init). */
  template <class Init>
  void reserve(int n, Init init) {
    while (count_ < n) {
      grow(n, init);
      installNow();
      release();
    }
  }

  void ask(int n) { if (n > count_ && n > want_) want_ = n; }
  bool wanted() {
    if (want_ <= count_) return false;
    building_ = want_;
    return true;
  }

  template <class Init>
  void build(Init init) { if (building_ > count_) grow(building_, init); }

  void install() { if (freshTable_) installNow(); }

  void release() {
    delete[] oldChunks_;
    delete[] oldSizes_;
    oldChunks_ = nullptr;
    oldSizes_ = nullptr;
  }

 private:
  template <class Init>
  void grow(int n, Init init) {
    // At least double: a count climbing one by one is a handful of rounds, not one per voice.
    int size = n - count_;
    if (size < count_) size = count_;
    if (size < 1) size = 1;
    T* chunk = new T[static_cast<size_t>(size)];
    for (int i = 0; i < size; ++i) init(chunk[i]);
    // The new tables of chunks, written here and only swapped in on the audio thread.
    T** chunks = new T*[static_cast<size_t>(chunkCount_ + 1)];
    int* sizes = new int[static_cast<size_t>(chunkCount_ + 1)];
    for (int c = 0; c < chunkCount_; ++c) { chunks[c] = chunks_[c]; sizes[c] = sizes_[c]; }
    chunks[chunkCount_] = chunk;
    sizes[chunkCount_] = size;
    freshTable_ = chunks;
    freshSizes_ = sizes;
    freshSize_ = size;
  }

  void installNow() {
    oldChunks_ = chunks_;
    oldSizes_ = sizes_;
    chunks_ = freshTable_;
    sizes_ = freshSizes_;
    ++chunkCount_;
    count_ += freshSize_;
    freshTable_ = nullptr;
    freshSizes_ = nullptr;
    freshSize_ = 0;
    if (want_ <= count_) want_ = 0;
  }

  T** chunks_ = nullptr;
  int* sizes_ = nullptr;
  int chunkCount_ = 0;
  int count_ = 0;
  int want_ = 0;
  int building_ = 0;
  T** freshTable_ = nullptr;
  int* freshSizes_ = nullptr;
  int freshSize_ = 0;
  T** oldChunks_ = nullptr;
  int* oldSizes_ = nullptr;
};

}  // namespace pd_own
