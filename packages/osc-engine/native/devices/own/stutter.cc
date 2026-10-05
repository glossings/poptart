// The Stutter effect: catches a slice of what is playing and repeats it on the grid.
//
// Translated from web-engine/src/devices/stutter.mjs. The chance is decided by a hash of the beat
// it falls on, so a song stutters in the same places every time it is played - which is the one
// thing in this device that has to be arithmetic-for-arithmetic identical on the two engines, or
// a song would repeat in different bars on the desktop.

#include "own/pd-own.h"
#include "own/dsp/sync.h"
#include "pd-own-ids.h"

namespace pd_Stutter {

namespace ids = pd_ids::Stutter;
using namespace pd_own;

constexpr double kRepeatMaxSec = 4.0;
/** Four seconds at 96 kHz. Above that rate the buffer stops growing. */
constexpr int kCapacity = 384000;

/**
 * A deterministic 0..1 for a beat and a seed - the same chance the same beat, every play.
 *
 * The browser's version does the first multiply in double precision and takes it modulo 2^32
 * afterwards, which is what the 64-bit arithmetic here reproduces; the rest is 32-bit, as
 * Math.imul and the shifts are.
 */
inline double hashChance(long long beat, int seed) {
  // In double, as the browser's is: a 32-bit multiply it does not have (see toUint32).
  unsigned int h = toUint32(static_cast<double>(static_cast<int>(beat)) * 2654435761.0
                            + static_cast<double>(seed) * 40503.0 + 2654435769.0);
  h ^= h >> 15;
  h = static_cast<unsigned int>(h * 2246822519u);
  h ^= h >> 13;
  return static_cast<double>(h) / 4294967296.0;
}

struct Device : pd_own::Device<ids::kCount> {
  int size = 0;
  float bufL[kCapacity] = { 0 };
  float bufR[kCapacity] = { 0 };
  int write = 0;
  // How much contiguous, current audio sits behind the write head. The buffer starts out as
  // silence, which counts: it is what went by before anything played.
  int fresh = 0;
  double bpm = 120;
  double transportSec = 0;
  long long lastInterval = -1;
  // The repeat in progress, if any.
  bool active = false;
  int start = 0;
  int length = 0;
  double pos = 0;
  int count = 0;
  int total = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    size = static_cast<int>(std::ceil(sr * kRepeatMaxSec));
    if (size > kCapacity) size = kCapacity;
    for (int i = 0; i < size; ++i) { bufL[i] = 0; bufR[i] = 0; }
    write = 0;
    fresh = size;
    bpm = 120;
    transportSec = 0;
    lastInterval = -1;
    active = false;
    start = 0;
    length = 0;
    pos = 0;
    count = 0;
    total = 0;
  }

  void pd_transport(double tempo, double seconds) { bpm = tempo; transportSec = seconds; }

  void pd_process(int frames) {
    const double interval = syncedSeconds(jsRoundInt(p[ids::interval]), bpm, 2);
    const double grid = std::fmin(kRepeatMaxSec * 0.9,
                                  syncedSeconds(jsRoundInt(p[ids::grid]), bpm, 0.125));
    const int seed = jsRoundInt(p[ids::seed]);
    const int wantTotal = static_cast<int>(std::fmax(1.0, jsRound(p[ids::repeats])));
    const double chance = p[ids::chance];
    const double decay = p[ids::decay];
    const double pitch = p[ids::pitch];
    const double wet = p[ids::wet];
    const double dryLevel = p[ids::dry];
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();

    for (int i = 0; i < frames; ++i) {
      const double l = inl[i];
      const double r = inr[i];
      // Recording stops where the slice being repeated begins, so it is never written over.
      const bool recording = !(active && write == start);
      if (recording) {
        // A number that cannot be played is stored as silence, or it would be repeated.
        bufL[write] = isPlayable(l) ? static_cast<float>(l) : 0.f;
        bufR[write] = isPlayable(r) ? static_cast<float>(r) : 0.f;
      } else {
        fresh = 0;
      }

      // A new interval on the clock: maybe catch the slice that just went by. The transport is
      // read once a block here, as the browser's host hands it over once a block too.
      const long long beat = static_cast<long long>(std::floor(transportSec / interval));
      if (beat != lastInterval) {
        const int sliceLength = static_cast<int>(std::fmax(1.0, jsRound(grid * sampleRate)));
        if (lastInterval >= 0 && fresh >= sliceLength && hashChance(beat, seed) < chance) {
          length = sliceLength;
          start = (write - length + size) % size;
          pos = 0;
          count = 0;
          total = wantTotal;
          active = true;
        }
        lastInterval = beat;
      }

      double wetL = 0;
      double wetR = 0;
      bool playing = false;
      if (active) {
        const double level = std::pow(1 - decay, count);
        const double rate = std::pow(2.0, (pitch * count) / 12.0);
        const int whole = static_cast<int>(std::floor(pos));
        const double frac = pos - whole;
        const int a = (start + whole) % size;
        const int b = (a + 1) % size;
        // A short fade at both ends of each repeat, so the loop point does not click.
        const double edge = std::fmin(1.0, std::fmin(pos, length - pos) / 64.0);
        wetL = (bufL[a] + (bufL[b] - bufL[a]) * frac) * level * edge;
        wetR = (bufR[a] + (bufR[b] - bufR[a]) * frac) * level * edge;
        playing = true;
        pos += rate;
        if (pos >= length) {
          pos -= length;
          count += 1;
          if (count >= total) active = false;
        }
      }
      if (recording) {
        write = (write + 1) % size;
        if (fresh < size) fresh += 1;
      }
      // The original at its own level only while a repeat is sounding: between repeats the
      // track plays as it is, whatever the dry control says.
      const double dry = playing ? dryLevel : 1.0;
      outl[i] = static_cast<float>(l * dry + wetL * wet);
      outr[i] = static_cast<float>(r * dry + wetR * wet);
    }
  }
};

}  // namespace pd_Stutter

extern "C" PdAny* pd_make_Stutter() { return new PdAdapter<pd_Stutter::Device>(); }
