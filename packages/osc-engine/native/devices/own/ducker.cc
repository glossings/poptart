// The Ducker effect: a level dip on the beat, on a routed track's notes, or on a key's transients.
//
// Translated from web-engine/src/devices/ducker.mjs. The dip is a shape in time rather than a
// detector, which is the whole idea: the pump of a sidechain compressor with something to draw
// instead of something to fight.
//
// What triggers it is decided by what is routed into the slot, and on this engine that is said
// rather than guessed (pd_key_patched / pd_note_route): the key bus exists whether a route does
// or not, so silence on it means nothing. A note's own onset is not carried either - a note
// starts the dip at the block it arrives in, as a plugin's notes land - where the browser's host
// hands over the time the note was scheduled for.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "own/dsp/sync.h"
#include "pd-own-ids.h"

namespace pd_Ducker {

namespace ids = pd_ids::Ducker;
using namespace pd_own;

/** How many note onsets can be waiting. The browser's list is capped at the same number. */
constexpr int kMaxPending = 64;

struct Device : pd_own::Device<ids::kCount, 4> {
  double bpm = 120;
  double transportSec = 0;
  // Seconds since the last trigger, or "none yet" before the first.
  bool dipping = false;
  double elapsed = 0;
  double gain = 1;
  long long lastBeat = -1;
  bool armed = true;
  double env = 0;
  bool keyed = false;
  bool noteRouted = false;
  double pending[kMaxPending] = { 0 };
  int pendingCount = 0;
  double hit = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    bpm = 120;
    transportSec = 0;
    dipping = false;
    elapsed = 0;
    gain = 1;
    lastBeat = -1;
    armed = true;
    env = 0;
    keyed = false;
    noteRouted = false;
    pendingCount = 0;
    hit = 0;
  }

  void pd_transport(double tempo, double seconds) { bpm = tempo; transportSec = seconds; }
  void pd_key_patched(bool on) { keyed = on; }

  /** A route of notes was set or cleared (see the engine's injectMidi). */
  void pd_note_route(bool on) {
    noteRouted = on;
    if (!noteRouted) pendingCount = 0;
  }

  /** A note from the routed track: the dip starts where the note arrived. */
  void pd_note_on(float note, float velocity) {
    (void)note;
    if (!(velocity > 0)) return;
    noteRouted = true;
    if (pendingCount >= kMaxPending) {
      for (int i = 1; i < pendingCount; ++i) pending[i - 1] = pending[i];
      pendingCount -= 1;
    }
    pending[pendingCount++] = transportSec;
  }

  /** The dip is a shape in time, not a gate: an off changes nothing. */
  void pd_note_off(float note) { (void)note; }

  void pd_process(int frames) {
    const int sync = jsRoundInt(p[ids::sync]);
    const double period = syncedSeconds(sync, bpm, 0.5);
    const double curve = p[ids::curve];
    const bool byNotes = noteRouted && !keyed;
    const double start = transportSec;
    const double attackK = 1.0 - std::exp(-1.0 / std::fmax(1.0, p[ids::attack] * 0.001 * sampleRate));
    const double threshold = std::pow(10.0, p[ids::threshold] / 20.0);
    const double releaseK = 1.0 - std::exp(-1.0 / (0.05 * sampleRate));
    const float* inl = inL();
    const float* inr = inR();
    const float* keyl = keyL();
    float* outl = outL();
    float* outr = outR();

    for (int i = 0; i < frames; ++i) {
      // Where this sample sits on the clock: a trigger fires when the beat index changes.
      if (byNotes) {
        // A note at or before this sample starts the dip here. Anything that arrived late lands
        // at the first sample it can.
        const double now = start + i / sampleRate;
        while (pendingCount > 0 && pending[0] <= now) {
          for (int k = 1; k < pendingCount; ++k) pending[k - 1] = pending[k];
          pendingCount -= 1;
          elapsed = 0;
          dipping = true;
          hit = 1;
        }
        hit -= hit * releaseK;
      } else if (keyed) {
        const double key = std::fabs(keyl[i]);
        env += (key - env) * (key > env ? 0.5 : releaseK);
        if (armed && env > threshold) { elapsed = 0; dipping = true; armed = false; }
        if (env < threshold * 0.5) armed = true;
      } else {
        const long long beat = static_cast<long long>(std::floor(transportSec / period));
        if (beat != lastBeat) {
          // The first beat seen is not a trigger: the device has only just been told where the
          // transport is, and dipping on that would be a dip nobody asked for.
          if (lastBeat >= 0) { elapsed = 0; dipping = true; } else { dipping = false; }
          lastBeat = beat;
        }
      }
      const double amount = ctl(ids::amount, i);
      const double length = ctl(ids::length, i) * (keyed ? 2 : period);
      double target = 1;
      if (dipping) {
        const double x = std::fmin(1.0, elapsed / std::fmax(0.001, length));
        target = 1 - amount * (1 - curveShape(x, curve));
        elapsed += 1.0 / sampleRate;
      }
      // Down at the attack, up at the shape's own pace.
      gain += (target - gain) * (target < gain ? attackK : 1.0);
      outl[i] = static_cast<float>(inl[i] * gain);
      outr[i] = static_cast<float>(inr[i] * gain);
    }
    // The key's envelope follows the sidechain, and a NaN from it would hold every trigger off
    // for good. The same for the gain, which smooths toward its target from where it was.
    if (!isPlayable(env)) env = 0;
    if (!isPlayable(gain)) gain = 1;
  }
};

}  // namespace pd_Ducker

extern "C" PdAny* pd_make_Ducker() { return new PdAdapter<pd_Ducker::Device>(); }
