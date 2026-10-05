// The Distort effect: fifteen waveshapers, oversampled, with one set of controls around them.
//
// Translated from web-engine/src/devices/distort.mjs. The fiddly parts are all here and are all
// there for a reason given in that file: the auto gain is applied INSIDE the curve so a change of
// curve does not step the level, a change of curve fades over ten milliseconds rather than
// cutting over mid-wave, and the DC blocker runs always and has its output faded in only for the
// curves that need one.
//
// What is missing is the one thing a server has no path for: a curve somebody DREW, which reaches
// the browser's device over a message port. A drawn mode here behaves as it does in the browser
// before its table has arrived - a straight clip - and the modes that are named behave fully.

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

  void pd_init(double sr) {
    sampleRate = sr;
    for (auto& c : channels) c.init(sr);
    fadeLen = static_cast<int>(jsRound(kCurveFadeSec * sr));
    if (fadeLen < 1) fadeLen = 1;
    fadeLeft = 0;
    haveLast = false;
    fading = false;
    dcMix = 0;
    comp = -1;
    lastTone = -1;
  }

  void pd_process(int frames) {
    const int mode = jsRoundInt(p[ids::mode]);
    // 1x, 2x, 4x by option index; anything else is the setting that costs nothing.
    const int factorIndex = jsRoundInt(p[ids::oversample]);
    const int factor = factorIndex >= 2 ? 4 : (factorIndex == 1 ? 2 : 1);
    const bool autogain = p[ids::autogain] >= 0.5;
    const double character = p[ids::character];
    const double bias = p[ids::bias];
    const double drive = dbToGain(p[ids::drive]);

    // The compensation is measured from where the controls END this block and reached from where
    // the last block left it, so a drive being dragged is corrected along a ramp rather than in
    // block-sized steps.
    const double compTo = autogain ? autoGainFor(mode, drive, bias, character) : 1.0;
    if (comp < 0) comp = compTo;

    // A different curve from last block's fades in rather than cutting over. Its gain is set
    // outright, and the outgoing curve keeps its own inside the blend, so the level does not
    // jump either. The same for a character that moves a curve in whole steps.
    const int step = characterStep(mode, character);
    if (haveLast && (lastMode != mode || lastStep != step)) {
      fading = true;
      fadeMode = lastMode;
      fadeComp = comp;
      fadeCharacter = lastCharacter;
      fadeLeft = fadeLen;
      comp = compTo;
    }
    haveLast = true;
    lastMode = mode;
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
    const int fadeStepOf = characterStep(fadeMode, fadeCharacter);
    const double fadeCharacterNow = fadeStepOf == -1 ? character : fadeCharacter;
    const int outgoing = fadeMode;
    const double outgoingComp = fadeComp;
    const int len = fadeLen;

    auto curve = [&](double v, int i) -> double {
      const double gained = shape(v, mode, drive, bias, character) * (gainFrom + gainStep * i);
      if (!blending) return gained;
      const double t = std::fmin(1.0, static_cast<double>(done + i) / len);
      const double was = shape(v, outgoing, drive, bias, fadeCharacterNow) * outgoingComp;
      return was + (gained - was) * t;
    };

    for (int ch = 0; ch < 2; ++ch) {
      const float* input = ch == 0 ? inL() : inR();
      float* out = ch == 0 ? outL() : outR();
      Channel& c = channels[ch];
      for (int i = 0; i < frames; ++i) c.dry[i] = input[i];
      c.over.setFactor(factor);
      c.over.process(c.dry, c.scratch, frames, curve);

      const double mix = clamp(p[ids::mix], 0.0, 1.0);
      const double gain = dbToGain(p[ids::output]);
      for (int i = 0; i < frames; ++i) {
        double wet = c.scratch[i];
        // A biased curve leaves an offset behind. It is inaudible on its own and costs headroom
        // on everything after it, so it comes off here.
        const double blocked = c.dc.next(wet);
        const double k = dcStep == 0 ? dcFrom : clamp(dcFrom + dcStep * (i + 1), 0.0, 1.0);
        wet += (blocked - wet) * k;
        if (toneHz < 19999) wet = c.tone.next(wet);
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
  }
};

}  // namespace pd_Distort

extern "C" PdAny* pd_make_Distort() { return new PdAdapter<pd_Distort::Device>(); }
