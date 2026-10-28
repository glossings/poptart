// The Limiter effect: a brickwall peak limiter with lookahead.
//
// Translated from web-engine/src/devices/limiter.mjs. The signal is delayed by the lookahead and
// the gain is the smallest the window ahead needs to stay under the ceiling, so a peak is
// already being turned down when it arrives. The release is the only time constant to set; the
// attack IS the lookahead.

#include "own/pd-own.h"
#include "pd-own-ids.h"

namespace pd_Limiter {

namespace ids = pd_ids::Limiter;
using namespace pd_own;

/** The lookahead, in seconds. Two milliseconds is under a hundred samples at 48 kHz. */
constexpr double kLookaheadSec = 0.002;
/** Enough window for any rate a server is likely to run at. */
constexpr int kMaxLook = static_cast<int>(kLookaheadSec * 192000.0) + 8;

struct Device : pd_own::Device<ids::kCount> {
  int look = 1;
  float bufL[kMaxLook] = { 0 };
  float bufR[kMaxLook] = { 0 };
  float need[kMaxLook] = { 0 };   // the gain each delayed sample needs
  int pos = 0;
  double gain = 1;

  void pd_init(double sr) {
    sampleRate = sr;
    look = static_cast<int>(jsRound(sr * kLookaheadSec));
    if (look < 1) look = 1;
    if (look > kMaxLook - 1) look = kMaxLook - 1;
    pos = 0;
    gain = 1;
    // The window starts at zero rather than at unity, as the browser's buffers do: for the
    // first two milliseconds the limiter believes it has to be silent, and comes up out of it
    // at the release. That is audible exactly once, when a limiter is first put on a chain, and
    // it is the behavior a song was written against.
    for (int i = 0; i < kMaxLook; ++i) { bufL[i] = 0; bufR[i] = 0; need[i] = 0; }
  }

  void pd_process(int frames) {
    const int size = look + 1;
    const double attackK = 1.0 - std::exp(-1.0 / (look * 0.5));
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();

    for (int i = 0; i < frames; ++i) {
      const double pre = dbToGain(ctl(ids::gain, i));
      const double ceiling = dbToGain(ctl(ids::ceiling, i));
      const double releaseK = 1.0 - std::exp(-1.0 / (ctl(ids::release, i) * 0.001 * sampleRate));
      const double l = inl[i] * pre;
      const double r = inr[i] * pre;
      const double peak = std::fmax(std::fabs(l), std::fabs(r));
      // Where this sample goes into the delay, and the gain it will need when it comes out.
      bufL[pos] = static_cast<float>(l);
      bufR[pos] = static_cast<float>(r);
      need[pos] = static_cast<float>(peak > ceiling ? ceiling / peak : 1.0);
      // The smallest gain anything in the window needs: what the output must already be at.
      double target = 1;
      for (int k = 0; k < size; ++k) if (need[k] < target) target = need[k];
      // Down fast enough to be there by the time the peak arrives, back up at the release.
      gain += (target - gain) * (target < gain ? attackK : releaseK);
      const double g = std::fmin(gain, target);
      const int read = (pos + 1) % size;
      outl[i] = static_cast<float>(bufL[read] * g);
      outr[i] = static_cast<float>(bufR[read] * g);
      pos = read;
    }
    // A gain that is not a number would stay that way through every smoothing step after it,
    // and the lookahead would hand on anything unplayable it is holding: both start again.
    if (frames > 0 && (!isPlayable(gain) || !isPlayable(outl[frames - 1]))) {
      gain = 1;
      for (int i = 0; i < kMaxLook; ++i) { bufL[i] = 0; bufR[i] = 0; need[i] = 1; }
    }
  }
};

}  // namespace pd_Limiter

extern "C" PdAny* pd_make_Limiter() { return new PdAdapter<pd_Limiter::Device>(); }
