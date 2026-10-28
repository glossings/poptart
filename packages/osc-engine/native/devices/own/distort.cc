// The Distort effect: fifteen waveshapers, oversampled, with one set of controls around them.
//
// Translated from web-engine/src/devices/distort.mjs. The fiddly parts are all here and are all
// there for a reason given in that file: the auto gain is applied INSIDE the curve so a change of
// curve does not step the level, a change of curve fades over ten milliseconds rather than
// cutting over mid-wave, and the DC blocker runs always and has its output faded in only for the
// curves that need one.
//
// A curve somebody DREW arrives as a table through the host's /shape command (pd_shape below),
// sampled by the engine exactly as the browser's engine samples one before posting it.

#include "own/pd-own.h"
#include "own/dsp/filters.h"
#include "own/dsp/oversample.h"
#include "own/dsp/shapers.h"
#include "pd-own-ids.h"

namespace pd_Distort {

namespace ids = pd_ids::Distort;
using namespace pd_own;

/** How long a change of curve takes to fade in. */
constexpr double kCurveFadeSec = 0.01;

/**
 * The mode control's entries a fresh device has room for: the named curves, then the eight drawn
 * ones it stopped at before it was open. Not a most - past them the room grows through the work
 * round (pd_own::Pool).
 */
constexpr int kFirstModeSlots = kShaperModes + 8;

/** The points a drawn curve is sampled at: the browser engine's SHAPE_POINTS. */
constexpr int kShapePoints = 256;

/** One channel's state, so the channels never share history. */
struct Channel {
  Oversampler over;
  DcBlocker dc;
  OnePole tone;
  double scratch[kBlock] = { 0 };
  double dry[kBlock] = { 0 };

  void init(double sr) { dc.init(sr); tone.init(sr); over.reset(); dc.reset(); tone.reset(); }
  void reset() { over.reset(); dc.reset(); tone.reset(); }
};

struct Device : pd_own::Device<ids::kCount> {
  Channel channels[2];
  int fadeLen = 1;
  int fadeLeft = 0;
  // The curve the last block played, and the one being faded out of.
  bool haveLast = false;
  int lastMode = 0;
  int lastStep = -1;
  double lastCharacter = 0.5;
  bool fading = false;
  int fadeMode = 0;
  double fadeComp = 1;
  double fadeCharacter = 0.5;
  // How much of the DC blocker's output is in the signal, 0..1.
  double dcMix = 0;
  double comp = -1;
  double lastTone = -1;
  /**
   * The drawn curves, by mode. Each slot keeps the curve before its latest too, because a redraw
   * into the slot that is playing FADES from the old curve to the new one, as a change of mode
   * does - so the old one has to be still there to fade from.
   */
  struct Curve {
    float table[2][kShapePoints];
    int length[2] = { 0, 0 };
    int half = 0;
    /** Which drawing the slot holds: bumped by every curve handed over, 0 for none. */
    unsigned id = 0;
  };
  Pool<Curve> drawn;
  unsigned nextDrawnId = 0;
  unsigned lastDrawn = 0;
  const float* lastTable = nullptr;
  int lastTableLength = 0;
  const float* fadeTable = nullptr;
  int fadeTableLength = 0;
  // The loudest input sample of the last block, for the picture of the curve.
  double peak = 0;
  // The drive in linear gain, per input sample, for a block where something is moving it.
  double driveGain[kBlock] = { 0 };

  void pd_init(double sr) {
    sampleRate = sr;
    drawn.reserve(kFirstModeSlots, [](Curve&) {});
    for (auto& c : channels) c.init(sr);
    fadeLen = static_cast<int>(jsRound(kCurveFadeSec * sr));
    if (fadeLen < 1) fadeLen = 1;
    fadeLeft = 0;
    haveLast = false;
    fading = false;
    dcMix = 0;
    comp = -1;
    lastTone = -1;
    lastDrawn = 0;
    lastTable = nullptr;
    fadeTable = nullptr;
    peak = 0;
  }

  /** A drawn curve for a mode past the named ones. Copied: the host's memory is not ours. */
  bool pd_shape(int param, int slot, const float* table, int count) {
    if (param != ids::mode || slot < kShaperModes || !table || count <= 0) return true;
    // A slot past the room there is: room is asked for, and the curve comes again once it is made.
    if (slot >= drawn.size()) { drawn.ask(slot + 1); return false; }
    const int n = count < kShapePoints ? count : kShapePoints;
    Curve& one = drawn[slot];
    const int half = one.id ? 1 - one.half : 0;
    std::memcpy(one.table[half], table, sizeof(float) * static_cast<size_t>(n));
    one.length[half] = n;
    one.half = half;
    one.id = ++nextDrawnId;
    return true;
  }

  bool pd_work_wanted() { return drawn.wanted(); }
  void pd_work() { drawn.build([](Curve&) {}); }
  void pd_work_done() { drawn.install(); }
  void pd_work_release() { drawn.release(); }

  /** What the panel draws on the curve: the correction in decibels and where the input is. */
  int pd_report(float* out, int capacity) {
    if (capacity < 2) return 0;
    out[0] = static_cast<float>(comp > 0 ? 20 * std::log10(comp) : 0);
    out[1] = static_cast<float>(peak);
    return 2;
  }

  void pd_process(int frames) {
    int mode = jsRoundInt(p[ids::mode]);
    // A drawn slot whose table has not arrived yet keeps the curve before it, as in the browser:
    // played empty, the slot is a hard clip for a block - a crack - on every pick.
    const bool drawnMode = mode >= kShaperModes;
    const bool haveTable = drawnMode && mode < drawn.size() && drawn[mode].id != 0;
    if (drawnMode && !haveTable && haveLast) mode = lastMode;
    const bool tabled = mode >= kShaperModes && mode < drawn.size() && drawn[mode].id != 0;
    const float* table = tabled ? drawn[mode].table[drawn[mode].half] : nullptr;
    const int tableLength = tabled ? drawn[mode].length[drawn[mode].half] : 0;
    const unsigned tableId = tabled ? drawn[mode].id : 0;
    // 1x, 2x, 4x by option index; anything else is the setting that costs nothing.
    const int factorIndex = jsRoundInt(p[ids::oversample]);
    const int factor = factorIndex >= 2 ? 4 : (factorIndex == 1 ? 2 : 1);
    const bool autogain = p[ids::autogain] >= 0.5;

    // The drive in linear gain: once for the block when it is still, once per input sample when
    // it moves, so the curve reads a number rather than taking a power per oversampled call.
    const bool driveMoving = isMoving(ids::drive);
    const double driveStill = dbToGain(p[ids::drive]);
    if (driveMoving) for (int i = 0; i < frames; ++i) driveGain[i] = dbToGain(ctl(ids::drive, i));
    const int endIndex = frames > 0 ? frames - 1 : 0;

    // The compensation is measured from where the controls END this block and reached from where
    // the last block left it, so a drive being dragged is corrected along a ramp rather than in
    // block-sized steps. The bias is read at the block's start, as the browser reads it.
    const double bias = p[ids::bias];
    const double character = ctl(ids::character, endIndex);
    const double driveEnd = driveMoving ? driveGain[endIndex] : driveStill;
    const double compTo = autogain ? autoGainFor(mode, driveEnd, bias, character, table, tableLength) : 1.0;
    if (comp < 0) comp = compTo;

    // A different curve from last block's fades in rather than cutting over. Its gain is set
    // outright, and the outgoing curve keeps its own inside the blend, so the level does not
    // jump either. The same for a character that moves a curve in whole steps.
    const int step = characterStep(mode, character);
    if (haveLast && (lastMode != mode || lastDrawn != tableId || lastStep != step)) {
      fading = true;
      fadeMode = lastMode;
      fadeTable = lastTable;
      fadeTableLength = lastTableLength;
      fadeComp = comp;
      fadeCharacter = lastCharacter;
      fadeLeft = fadeLen;
      comp = compTo;
    }
    haveLast = true;
    lastMode = mode;
    lastDrawn = tableId;
    lastTable = table;
    lastTableLength = tableLength;
    lastStep = step;
    lastCharacter = character;

    // Only the curves that actually leave an offset get a DC blocker: it is a 20 Hz high-pass,
    // and on a curve that needs none it took a decibel off a 41 Hz bass and turned its phase.
    const int chebyN = chebyHarmonic(character);
    const bool needsDc = shaperAsymmetric(mode) || bias != 0
        || (mode == kCheby && chebyN % 2 == 0);
    const double dcFrom = dcMix;
    const double dcTo = needsDc ? 1.0 : 0.0;
    const double dcStep = dcTo == dcFrom ? 0.0 : (dcTo - dcFrom) / fadeLen;

    const double toneHz = p[ids::tone];
    if (toneHz != lastTone) {
      for (auto& c : channels) c.tone.glideTo(toneHz, frames);
      lastTone = toneHz;
    }

    // One curve for the block, shared by both channels. The auto gain is applied in here, per
    // input sample, rather than to what comes out of the oversampler: that output lags its input
    // by the filter's delay, so at a change of curve the last few samples the old curve shaped
    // would come out under the new curve's gain.
    const double gainFrom = comp;
    const double gainStep = (compTo - gainFrom) / (frames > 1 ? frames : 1);
    const bool blending = fadeLeft > 0 && fading;
    const int done = fadeLen - fadeLeft;
    const bool fadeFollows = characterStep(fadeMode, fadeCharacter) == -1;
    const int outgoing = fadeMode;
    const float* outgoingTable = fadeTable;
    const int outgoingTableLength = fadeTableLength;
    const double outgoingComp = fadeComp;
    const int len = fadeLen;

    // The controls are read by input sample index, so an lfo on the character, drive or bias
    // moves the curve smoothly.
    auto curve = [&](double v, int i) -> double {
      const double driveNow = driveMoving ? driveGain[i] : driveStill;
      const double gained = shape(v, mode, driveNow, ctl(ids::bias, i), ctl(ids::character, i), table, tableLength) * (gainFrom + gainStep * i);
      if (!blending) return gained;
      const double t = std::fmin(1.0, static_cast<double>(done + i) / len);
      // A stepped character fades from the setting it had; otherwise the outgoing curve follows
      // the knob like the incoming one.
      const double characterNow = fadeFollows ? ctl(ids::character, i) : fadeCharacter;
      const double was = shape(v, outgoing, driveNow, ctl(ids::bias, i), characterNow, outgoingTable, outgoingTableLength) * outgoingComp;
      return was + (gained - was) * t;
    };

    double loudest = 0;
    for (int ch = 0; ch < 2; ++ch) {
      const float* input = ch == 0 ? inL() : inR();
      for (int i = 0; i < frames; ++i) loudest = std::fmax(loudest, std::fabs(static_cast<double>(input[i])));
      float* out = ch == 0 ? outL() : outR();
      Channel& c = channels[ch];
      for (int i = 0; i < frames; ++i) c.dry[i] = input[i];
      c.over.setFactor(factor);
      c.over.process(c.dry, c.scratch, frames, curve);

      for (int i = 0; i < frames; ++i) {
        double wet = c.scratch[i];
        // A biased curve leaves an offset behind. It is inaudible on its own and costs headroom
        // on everything after it, so it comes off here.
        const double blocked = c.dc.next(wet);
        const double k = dcStep == 0 ? dcFrom : clamp(dcFrom + dcStep * (i + 1), 0.0, 1.0);
        wet += (blocked - wet) * k;
        if (toneHz < 19999) wet = c.tone.next(wet);
        const double mix = clamp(ctl(ids::mix, i), 0.0, 1.0);
        const double gain = dbToGain(ctl(ids::output, i));
        out[i] = static_cast<float>((c.dry[i] * (1 - mix) + wet * mix) * gain);
      }
      // A NaN in the input would otherwise sit in the DC blocker and the tone filter for ever.
      if (frames > 0 && !isPlayable(out[frames - 1])) c.reset();
    }
    // After both channels, so the pair are corrected by the same ramp and fade the same way.
    comp = compTo;
    if (fadeLeft > 0) {
      fadeLeft = fadeLeft - frames;
      if (fadeLeft < 0) fadeLeft = 0;
      if (fadeLeft == 0) fading = false;
    }
    if (dcStep != 0) dcMix = clamp(dcFrom + dcStep * frames, 0.0, 1.0);
    peak = isPlayable(loudest) ? std::fmin(1.0, loudest) : 0.0;
  }
};

}  // namespace pd_Distort

extern "C" PdAny* pd_make_Distort() { return new PdAdapter<pd_Distort::Device>(); }
