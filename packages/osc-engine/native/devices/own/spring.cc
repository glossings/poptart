// The Spring effect: a two-spring tank, with width, mix and an output trim.
//
// Translated from web-engine/src/devices/spring.mjs. The tank's geometry is set per block and the
// transition frequency glides from there; drive, shake, width, mix and output are read per sample.
// Routed notes arrive with their offset into the block (pd_note_on_at), so they land on their
// own sample with no cut in the render, and the once-a-block settings land where the browser's do.

#include "own/pd-own.h"
#include "own/dsp/spring.h"
#include "pd-own-ids.h"

namespace pd_Spring {

namespace ids = pd_ids::Spring;
using namespace pd_own;

/** How many notes can be waiting in one block. The browser's list is capped at the same number. */
constexpr int kMaxPending = 64;

struct Device : pd_own::Device<ids::kCount> {
  spring::Tank tank;
  bool shaking = false;
  bool noteRouted = false;
  bool haveNote = false;
  double noteHz = 0;
  // The notes due this block, soonest first: where in it, their frequency and velocity.
  int pendingAt[kMaxPending] = { 0 };
  double pendingHz[kMaxPending] = { 0 };
  double pendingVel[kMaxPending] = { 0 };
  int pendingCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    tank.init(sr);
    shaking = false;
    noteRouted = false;
    haveNote = false;
    pendingCount = 0;
  }

  /** A route of notes was set or cleared (see the engine's injectMidi). */
  void pd_note_route(bool on) {
    noteRouted = on;
    if (!noteRouted) {
      pendingCount = 0;
      haveNote = false;
    }
  }

  void pd_note_on(float note, float velocity) { pd_note_on_at(note, velocity, 0); }
  void pd_note_off(float note) { (void)note; }

  /** A note from the routed track, `offset` samples into the next block: it lands there. */
  void pd_note_on_at(float note, float velocity, int offset) {
    if (!(velocity > 0)) return;
    noteRouted = true;
    if (pendingCount >= kMaxPending) {
      for (int k = 1; k < pendingCount; ++k) {
        pendingAt[k - 1] = pendingAt[k]; pendingHz[k - 1] = pendingHz[k]; pendingVel[k - 1] = pendingVel[k];
      }
      pendingCount -= 1;
    }
    int k = pendingCount;
    while (k > 0 && pendingAt[k - 1] > offset) {
      pendingAt[k] = pendingAt[k - 1]; pendingHz[k] = pendingHz[k - 1]; pendingVel[k] = pendingVel[k - 1];
      k -= 1;
    }
    pendingAt[k] = offset;
    pendingHz[k] = 440 * std::pow(2.0, (static_cast<double>(note) - 69) / 12);
    pendingVel[k] = velocity;
    pendingCount += 1;
  }

  /** A note is a ping and a pitch, not a gate: an off changes nothing. */
  void pd_note_off_at(float note, int offset) { (void)note; (void)offset; }

  void pd_process(int frames) {
    // Every block: the transition frequency glides, so what follows from it moves while it does.
    tank.set(p[ids::decay], p[ids::length], p[ids::chirp],
             noteRouted && haveNote ? noteHz : static_cast<double>(p[ids::transition]),
             p[ids::modulation], p[ids::damping], p[ids::lowcut], p[ids::feedback]);

    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();
    double wet[2] = { 0, 0 };
    int next = 0;
    for (int i = 0; i < frames; ++i) {
      const double l = inl[i];
      const double r = inr[i];
      const bool held = ctl(ids::shake, i) >= 0.5;
      const bool pressed = held && !shaking;
      shaking = held;
      double level = pressed ? 1 : 0;
      while (next < pendingCount && pendingAt[next] <= i) {
        noteHz = pendingHz[next];
        haveNote = true;
        tank.retune(noteHz);
        level = std::fmax(level, pendingVel[next]);
        next += 1;
      }
      if (level > 0) tank.knock(level, pressed);
      tank.next((l + r) * 0.5, dbToGain(ctl(ids::drive, i)), wet);
      const double width = clamp(ctl(ids::width, i), 0.0, 1.0);
      const double same = (1 + width) * 0.5;
      const double cross = (1 - width) * 0.5;
      const double wl = wet[0] * same + wet[1] * cross;
      const double wr = wet[1] * same + wet[0] * cross;
      const double mix = clamp(ctl(ids::mix, i), 0.0, 1.0);
      const double gain = dbToGain(ctl(ids::output, i));
      outl[i] = static_cast<float>((l * (1 - mix) + wl * mix) * gain);
      outr[i] = static_cast<float>((r * (1 - mix) + wr * mix) * gain);
    }
    // Anything left was due at the block's end; it lands at the start of the next.
    for (int k = next; k < pendingCount; ++k) {
      pendingAt[k - next] = 0; pendingHz[k - next] = pendingHz[k]; pendingVel[k - next] = pendingVel[k];
    }
    pendingCount -= next;
    if (frames > 0 && !isPlayable(outl[frames - 1])) tank.reset();
  }
};

}  // namespace pd_Spring

extern "C" PdAny* pd_make_Spring() { return new PdAdapter<pd_Spring::Device>(); }
