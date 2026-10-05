// The GrainEcho effect: a delay whose repeats are grains rather than copies.
//
// Translated from web-engine/src/devices/grainecho.mjs. Each grain reads from around the delay
// time, windowed, transposed and panned, with what comes out fed back into the buffer - so the
// repeats smear and scatter instead of arriving whole.

#include "own/pd-own.h"
#include "own/dsp/sync.h"
#include "pd-own-ids.h"

namespace pd_GrainEcho {

namespace ids = pd_ids::GrainEcho;
using namespace pd_own;

constexpr double kGrainMaxSec = 4.0;
constexpr int kMaxGrains = 48;
/** Four seconds at 96 kHz. Above that rate the buffer stops growing and the delay is shorter. */
constexpr int kCapacity = 384000;

/** One grain: where it reads, how far through it is, its rate and pan. */
struct DelayGrain {
  bool on = false;
  double pos = 0;
  double len = 1;
  int at = 0;
  double rate = 1;
  double l = 1;
  double r = 1;
};

struct Device : pd_own::Device<ids::kCount> {
  int size = 0;
  float bufL[kCapacity] = { 0 };
  float bufR[kCapacity] = { 0 };
  int write = 0;
  DelayGrain grains[kMaxGrains];
  int until = 0;              // samples until the next grain starts
  unsigned int seed = 0x2545f491u;
  double bpm = 120;

  void pd_init(double sr) {
    sampleRate = sr;
    size = static_cast<int>(std::ceil(sr * kGrainMaxSec));
    if (size > kCapacity) size = kCapacity;
    for (int i = 0; i < size; ++i) { bufL[i] = 0; bufR[i] = 0; }
    write = 0;
    for (auto& g : grains) g = DelayGrain();
    until = 0;
    seed = 0x2545f491u;
    bpm = 120;
  }

  void pd_transport(double tempo, double seconds) { (void)seconds; bpm = tempo; }

  /** A deterministic 0..1, so the cloud is the same cloud every play. */
  double random() {
    unsigned int x = seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    seed = x;
    return static_cast<double>(x) / 4294967296.0;
  }

  void pd_process(int frames) {
    const int sync = jsRoundInt(p[ids::sync]);
    const double density = p[ids::density];
    const double timeWant = p[ids::time];
    const double sprayAmount = p[ids::spray];
    const double sizeMs = p[ids::size];
    const double pitch = p[ids::pitch];
    const double randomAmount = p[ids::random];
    const double spread = p[ids::spread];
    const double fb = p[ids::feedback];
    const double mix = p[ids::mix];
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();

    for (int i = 0; i < frames; ++i) {
      const double l = inl[i];
      const double r = inr[i];
      // Start a grain when one is due.
      if (--until <= 0) {
        // Guarded on the way into an int, which the browser's number does not have to be: a
        // density of zero is an infinite wait there and undefined behavior here.
        const double wait = jsRound(sampleRate / density * (0.7 + 0.6 * random()));
        until = (isPlayable(wait) && wait < 1e9) ? static_cast<int>(wait) : (1 << 30);
        if (until < 1) until = 1;
        DelayGrain* g = nullptr;
        for (auto& one : grains) if (!one.on) { g = &one; break; }
        if (g) {
          const double time = std::fmin(kGrainMaxSec * 0.9, syncedSeconds(sync, bpm, timeWant));
          const double spray = sprayAmount * time * (random() * 2 - 1);
          const double back = std::fmax(0.001, time + spray) * sampleRate;
          double len = std::fmax(32.0, jsRound(sizeMs * 0.001 * sampleRate));
          const double rate = std::pow(2.0, (pitch + randomAmount * (random() * 2 - 1)) / 12.0);
          // A grain read faster than time passes gains on the write head by (rate - 1) samples a
          // sample, and one read slower falls behind. It has to stay inside the recorded audio
          // for its whole life; one too long to fit either way is shortened.
          if (rate > 1 && (rate - 1) * len > size - 8) {
            len = std::fmax(32.0, std::floor((size - 8) / (rate - 1)));
          }
          const double gains = rate > 1 ? (rate - 1) * len : 0;
          const double loses = rate < 1 ? (1 - rate) * len : 0;
          const double start = std::fmin(size - 2 - loses, std::fmax(2 + gains, back + len * 0.5));
          g->len = len;
          g->rate = rate;
          g->pos = std::fmod(write - start + size * 4.0, static_cast<double>(size));
          g->at = 0;
          const double pan = (random() * 2 - 1) * spread;
          g->l = std::cos(((pan + 1) * M_PI) / 4) * M_SQRT2;
          g->r = std::sin(((pan + 1) * M_PI) / 4) * M_SQRT2;
          g->on = true;
        }
      }
      double wetL = 0;
      double wetR = 0;
      for (auto& g : grains) {
        if (!g.on) continue;
        const double w = 0.5 - 0.5 * std::cos((2 * M_PI * g.at) / g.len);
        const double pos = g.pos;
        const int whole = static_cast<int>(std::floor(pos));
        const double frac = pos - whole;
        const int a = whole % size;
        const int b = (a + 1) % size;
        const double sl = (bufL[a] + (bufL[b] - bufL[a]) * frac) * w;
        const double sr2 = (bufR[a] + (bufR[b] - bufR[a]) * frac) * w;
        const double mono = (sl + sr2) * 0.5;
        wetL += mono * g.l;
        wetR += mono * g.r;
        g.pos += g.rate;
        if (g.pos >= size) g.pos -= size;
        if (++g.at >= g.len) g.on = false;
      }
      // A number that cannot be played is stored as silence: kept, it would come back round the
      // feedback for as long as the device lives.
      const double keepL = l + std::tanh(wetL * fb);
      const double keepR = r + std::tanh(wetR * fb);
      bufL[write] = isPlayable(keepL) ? static_cast<float>(keepL) : 0.f;
      bufR[write] = isPlayable(keepR) ? static_cast<float>(keepR) : 0.f;
      write = (write + 1) % size;
      outl[i] = static_cast<float>(l + (wetL - l) * mix);
      outr[i] = static_cast<float>(r + (wetR - r) * mix);
    }
  }
};

}  // namespace pd_GrainEcho

extern "C" PdAny* pd_make_GrainEcho() { return new PdAdapter<pd_GrainEcho::Device>(); }
