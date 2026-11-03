// The Drum: a struck body and a burst of noise, one hit per note.
//
// Translated from web-engine/src/devices/drum.mjs, which says what the body's modes are, how
// Material moves them and how the noise's bursts are laid out. The same state, the same
// arithmetic in the same order, in double; the parity test holds the two together. Every sound
// control is read once, a sample into the hit, and kept while it rings; Level is read per sample
// (see own/pd-own.h). A Click Sample reaches it through pd_sample, summed to one channel by the host.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "own/dsp/filters.h"
#include "pd-own-ids.h"

namespace pd_Drum {

namespace ids = pd_ids::Drum;
using namespace pd_own;

/** The voices a fresh device has room for (see the Wavetable's kFirstVoices). */
constexpr int kFirstVoices = 16;
constexpr int kModes = 6;
constexpr double kBarRatios[kModes] = { 1, 2.76, 5.40, 8.93, 2.65, 2.92 };
constexpr double kBarLevels[kModes] = { 1, 0.45, 0.25, 0.15, 0, 0 };
constexpr double kMembraneRatios[kModes] = { 1, 1.59, 2.14, 2.30, 2.65, 2.92 };
constexpr double kMembraneLevels[kModes] = { 1, 0.25, 0.18, 0.14, 0.1, 0.08 };
constexpr double kGapSec = 0.015;
constexpr int kBursts = 3;
constexpr double kBurstSec = 0.02;
constexpr double kDropShare = 0.12;
constexpr double kEdgePower = 4;
constexpr double kTailLevel = 0.3;
constexpr double kTailLength = 8;
constexpr double kDriveGain = 12;
constexpr double kDriveBlend = 4;
constexpr double kFmDepth = 6;
constexpr double kResMakeup = 0.5;
constexpr double kCutoffTop = 20000;
constexpr double kLadderK = 3.99;
constexpr double kFmFull = 0.35;
constexpr double kFmNone = 0.5;
constexpr double kClickSec = 0.003;
constexpr double kClickGain = 1.5;
constexpr double kClickHpMin = 20;
constexpr double kClickLpMax = 20000;
constexpr double kClickPitchSt = 24;
constexpr double kSqrtHalf = 0.7071067811865476;
/** The room a fresh device has for click files. */
constexpr int kFirstSampleSlots = 4;

/** One loaded click: mono frames at the file's own rate, owned by the host. */
struct Sample {
  const float* data = nullptr;
  int frames = 0;
  double sampleRate = 48000.0;
};
constexpr double kNoiseRes = 0.3;
constexpr double kBlFull = 0.4;
constexpr double kBlNone = 0.45;
constexpr double kSilent = 1e-5;
constexpr double kLn1000 = 6.907755278982137;
constexpr double kTwoPi = 2 * 3.141592653589793;
constexpr double kMinSec = 0.001;

/** The body's modes at a Material and an Edge (drum.mjs's drumModes). Returns the loudness gain. */
inline double drumModes(double material, double edge, double* ratios, double* levels) {
  const double m = std::fmin(1.0, std::fmax(0.0, material));
  const double e = kEdgePower * std::fmin(1.0, std::fmax(0.0, edge));
  double sum = 0;
  if (m <= 0.5) {
    const double u = m * 2;
    for (int k = 0; k < kModes; ++k) {
      ratios[k] = kBarRatios[k];
      levels[k] = (k == 0 ? 1.0 : u * kBarLevels[k]) * std::pow(ratios[k], e);
      sum += levels[k] * levels[k];
    }
  } else {
    const double u = (m - 0.5) * 2;
    for (int k = 0; k < kModes; ++k) {
      ratios[k] = kBarRatios[k] * std::pow(kMembraneRatios[k] / kBarRatios[k], u);
      levels[k] = (kBarLevels[k] + u * (kMembraneLevels[k] - kBarLevels[k])) * std::pow(ratios[k], e);
      sum += levels[k] * levels[k];
    }
  }
  return 1 / std::sqrt(sum);
}

/** The bandpassed noise's gain to white noise's loudness (drum.mjs's noiseGain). */
inline double noiseGain(double tone, double sampleRate) {
  const double k = 2 - 1.98 * kNoiseRes;
  const double f = std::fmin(sampleRate * 0.25, std::fmax(20.0, tone));
  return std::sqrt((2 * k) / std::sin((kTwoPi * f) / sampleRate));
}

/** drum.mjs's driveShape: a soft saturator, flat at plus and minus one from three on. */
inline double driveShape(double x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const double x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** drum.mjs's drive: the dry sound blended into the saturated one over the first quarter. */
inline double drive(double x, double amount) {
  if (!(amount > 0)) return x;
  const double g = 1 + (kDriveGain - 1) * amount;
  const double w = std::fmin(1.0, kDriveBlend * amount);
  return (1 - w) * x + (w * driveShape(g * x)) / driveShape(g);
}

/** xorshift32 on an unsigned int: the browser's sequence exactly. */
struct DrumNoise {
  unsigned int state = 1;
  void seed(unsigned int s) { state = s ? s : 1u; }
  double white() {
    unsigned int x = state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    state = x;
    return static_cast<double>(x) / 2147483648.0 - 1.0;
  }
};

/** The device's base, which is where a voice reads a moving control from. */
using Base = pd_own::Device<ids::kCount, 2>;

struct Voice {
  double sampleRate = 48000.0;
  double phase[kModes] = { 0 };
  double env[kModes] = { 0 };
  double ratios[kModes] = { 0 };
  double levels[kModes] = { 0 };
  double gains[kModes] = { 0 };
  double burstAt[kBursts] = { 0 };
  DrumNoise rng;
  Svf filter;
  Ladder ladder;
  double note = -1;
  double velocity = 1;
  long long age = 0;
  bool active = false;
  double t = 0;
  double dropEnv = 0, burst = 0, tail = 0;
  int nextBurst = kBursts;
  double tailAt = 0;
  bool tailOn = true;
  double click = 0, lastWhite = 0;
  const Sample* sample = nullptr;
  double spos = 0, sstep = 1;
  bool hpOn = false, lpOn = false;
  double hb0 = 0, hb1 = 0, hb2 = 0, ha1 = 0, ha2 = 0, kLp = 1;
  double hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0, clp = 0;
  // What the hit was struck with (see noteOn).
  double norm = 1, pitch = 0, drop = 0, dropG = 0, clickLevel = 0, mix = 0, toneGain = 1, tailG = 0, burstG = 0;
  double slowLevel = 0, slowG = 0, driveAmount = 0, slow = 0;
  double topRatio = 0;
  double fm = 0, fmRatio = 1, cutoff = kCutoffTop, resonance = 0, sweep = 0, sweepG = 0, sweepEnv = 0, fmPhase = 0;
  bool filtered = false;

  void init(double sr) {
    sampleRate = sr;
    filter.init(sr);
    ladder.init(sr);
    note = -1; velocity = 1; age = 0; active = false;
    reset();
  }

  void reset() {
    for (int k = 0; k < kModes; ++k) { phase[k] = 0; env[k] = 0; }
    t = 0;
    dropEnv = 0;
    burst = 0;
    tail = 0;
    slow = 0;
    nextBurst = kBursts;
    tailAt = 0;
    tailOn = true;
    click = 0;
    lastWhite = 0;
    spos = 0;
    hx1 = 0; hx2 = 0; hy1 = 0; hy2 = 0;
    clp = 0;
    sweepEnv = 0;
    fmPhase = 0;
    filter.reset();
    ladder.reset();
  }

  /** Starts a hit, reading every sound control at sample `j` of this call - the strike. */
  void noteOn(double n, double vel, unsigned int seed, const Base& c, int j, const Sample* file) {
    reset();
    note = n;
    velocity = vel;
    active = true;
    for (int k = 0; k < kModes; ++k) env[k] = 1;
    dropEnv = 1;
    click = 1;
    rng.seed(seed);
    const double sr = sampleRate;
    norm = drumModes(c.ctl(ids::material, j), c.ctl(ids::edge, j), ratios, levels);
    const double decay = std::fmax(kMinSec, c.ctl(ids::decay, j));
    const double d = decay * sr;
    const double tilt = 1 - std::fmin(1.0, std::fmax(0.0, c.ctl(ids::ring, j)));
    for (int k = 0; k < kModes; ++k) gains[k] = std::exp((-kLn1000 * std::pow(ratios[k], tilt)) / d);
    dropG = std::exp(-1 / (kDropShare * decay * sr));
    pitch = c.ctl(ids::pitch, j);
    drop = c.ctl(ids::drop, j);
    clickLevel = c.ctl(ids::click, j);
    sample = file;
    const double st = std::fmin(kClickPitchSt, std::fmax(-kClickPitchSt, c.ctl(ids::clickpitch, j)));
    sstep = file ? (file->sampleRate / sr) * std::pow(2.0, st / 12) : 1.0;
    const double floorHz = file ? midiToHz(n + pitch + std::fmax(0.0, drop)) : 0.0;
    const double hpHz = std::fmin(0.45 * sr, std::fmax(floorHz, c.ctl(ids::clickhp, j)));
    hpOn = hpHz > kClickHpMin;
    if (hpOn) {
      const double w = (kTwoPi * hpHz) / sr;
      const double cw = std::cos(w);
      const double alpha = std::sin(w) / (2 * kSqrtHalf);
      const double a0 = 1 + alpha;
      hb0 = (1 + cw) / 2 / a0;
      hb1 = -(1 + cw) / a0;
      hb2 = hb0;
      ha1 = (-2 * cw) / a0;
      ha2 = (1 - alpha) / a0;
    }
    const double lpHz = c.ctl(ids::clicklp, j);
    lpOn = lpHz < kClickLpMax;
    kLp = 1 - std::exp((-kTwoPi * std::fmin(0.49 * sr, std::fmax(1.0, lpHz))) / sr);
    mix = std::fmin(1.0, std::fmax(0.0, c.ctl(ids::noise, j)));
    const double tone = c.ctl(ids::noisetone, j);
    filter.setCutoff(tone, kNoiseRes);
    toneGain = noiseGain(tone, sr);
    const double snap = std::fmax(kMinSec, c.ctl(ids::noiselength, j));
    tailG = std::exp(-kLn1000 / (snap * sr));
    burstG = std::exp(-kLn1000 / (std::fmin(kBurstSec, snap) * sr));
    const double tl = std::fmin(1.0, std::fmax(0.0, c.ctl(ids::noisetail, j)));
    slowLevel = kTailLevel * tl * tl;
    slowG = std::exp(-kLn1000 / (kTailLength * snap * sr));
    driveAmount = std::fmin(1.0, std::fmax(0.0, c.ctl(ids::drive, j)));
    fm = kFmDepth * std::fmin(1.0, std::fmax(0.0, c.ctl(ids::fm, j)));
    fmRatio = c.ctl(ids::fmratio, j);
    cutoff = c.ctl(ids::cutoff, j);
    resonance = c.ctl(ids::resonance, j);
    sweep = c.ctl(ids::filtersweep, j);
    sweepG = std::exp(-kLn1000 / (std::fmax(kMinSec, c.ctl(ids::filterdecay, j)) * sr));
    sweepEnv = 1;
    filtered = !(cutoff >= kCutoffTop && sweep >= 0);
    if (filtered) tune(cutoff);
    topRatio = 0;
    for (int k = 0; k < kModes; ++k) if (levels[k] > 0 && ratios[k] > topRatio) topRatio = ratios[k];
    const double gap = std::fmin(1.0, std::fmax(0.0, c.ctl(ids::stutter, j))) * kGapSec * sr;
    for (int b = 0; b < kBursts; ++b) burstAt[b] = jsRound(b * gap);
    nextBurst = 0;
    tailAt = jsRound(kBursts * gap);
    tailOn = false;
  }

  /** drum.mjs's tune: the lowpass, with Resonance reaching nearly to oscillation. */
  void tune(double hz) {
    ladder.setCutoff(hz, 0);
    ladder.k = kLadderK * std::fmin(1.0, std::fmax(0.0, resonance));
  }

  /** Renders `count` samples with what the hit was struck with; Level per sample. */
  void process(float* outL, float* outR, int count, double bend, const Base& c) {
    const double sr = sampleRate;
    const double hz = midiToHz(note + pitch + bend);
    const double clickG = std::exp(-kLn1000 / (kClickSec * sr));
    const double clickGain = (sample ? 1.0 : kClickGain) * velocity * clickLevel;

    for (int i = 0; i < count; ++i) {
      const double semis = drop * dropEnv;
      dropEnv *= dropG;
      const double f = (hz * (semis > 1e-6 ? std::pow(2.0, semis / 12) : 1.0)) / sr;
      double bend = 0;
      if (fm > 0) {
        const double index = fm * sweepEnv;
        const double reach = f * (topRatio + (index + 1) * fmRatio);
        const double fade = reach <= kFmFull ? 1.0 : (reach >= kFmNone ? 0.0 : (kFmNone - reach) / (kFmNone - kFmFull));
        bend = index * fade * std::sin(kTwoPi * fmPhase);
        fmPhase += f * fmRatio;
        if (fmPhase >= 1) fmPhase -= std::floor(fmPhase);
      }
      double body = 0;
      for (int k = 0; k < kModes; ++k) {
        if (levels[k] > 0) {
          const double inc = f * ratios[k];
          const double bl = inc < kBlFull ? 1.0 : (inc >= kBlNone ? 0.0 : (kBlNone - inc) / (kBlNone - kBlFull));
          if (bl > 0) body += levels[k] * env[k] * bl * std::sin(kTwoPi * phase[k] + bend);
          phase[k] += inc;
          if (phase[k] >= 1) phase[k] -= std::floor(phase[k]);
        }
        env[k] *= gains[k];
      }

      while (nextBurst < kBursts && t >= burstAt[nextBurst]) {
        burst = 1;
        ++nextBurst;
      }
      if (!tailOn && t >= tailAt) {
        tail = 1;
        slow = 1;
        tailOn = true;
      }
      const double w = rng.white();
      const double stages = tail + slowLevel * slow;
      const double level = burst > stages ? burst : stages;
      const double noise = filter.next(w, 2) * toneGain * level;
      burst *= burstG;
      tail *= tailG;
      slow *= slowG;
      double clk = 0;
      if (sample) {
        const float* d = sample->data;
        const int len = sample->frames;
        if (spos < len) {
          const long long k = static_cast<long long>(std::floor(spos));
          const double fr = spos - static_cast<double>(k);
          const double a = d[k];
          const double b = k + 1 < len ? static_cast<double>(d[k + 1]) : 0.0;
          clk = a + (b - a) * fr;
          spos += sstep;
        }
      } else {
        clk = (w - lastWhite) * click;
        click *= clickG;
      }
      lastWhite = w;
      if (hpOn) {
        const double y = hb0 * clk + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2;
        hx2 = hx1; hx1 = clk;
        hy2 = hy1; hy1 = y;
        clk = y;
      }
      if (lpOn) {
        clp += kLp * (clk - clp);
        clk = clp;
      }
      t = t + 1;

      double x = ((1 - mix) * norm * body + mix * noise + clickGain * clk) * velocity;
      if (filtered) {
        if (sweep != 0) tune(cutoff * std::pow(2.0, (sweep * sweepEnv) / 12));
        x = ladder.next(x) * (1 + kResMakeup * ladder.k);
      }
      sweepEnv *= sweepG;
      const double v = drive(x, driveAmount) * c.ctl(ids::level, i);
      outL[i] = static_cast<float>(outL[i] + v);
      outR[i] = static_cast<float>(outR[i] + v);
    }

    if (!isPlayable(filter.ic1 + filter.ic2 + phase[0] + env[0] + hy1 + clp)) {
      reset();
      active = false;
      return;
    }
    const bool ringing = filtered && std::fabs(ladder.s[0]) + std::fabs(ladder.s[1]) + std::fabs(ladder.s[2]) + std::fabs(ladder.s[3]) >= kSilent;
    const bool clicking = (sample ? spos < sample->frames : click >= kSilent) || std::fabs(hy1) + std::fabs(clp) >= kSilent;
    if (tailOn && env[0] < kSilent && tail < kSilent && slowLevel * slow < kSilent && burst < kSilent && !clicking && !ringing) active = false;
  }
};

struct Device : Base {
  Pool<Voice> voices;
  /** The loaded clicks, by Click Sample's option slot. */
  Pool<Sample> samples;
  int voiceCount = 8;
  long long clock = 0;
  unsigned int seed = 1;
  double bend = 0;
  struct Event { double note; double velocity; };
  Event events[64];
  int eventCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    voices.reserve(kFirstVoices, [](Voice&) {});
    for (auto& v : voices) v.init(sr);
    samples.reserve(kFirstSampleSlots, [](Sample&) {});
    voiceCount = 8;
    clock = 0;
    seed = 1;
    bend = 0;
    eventCount = 0;
  }

  void pd_note_on(float note, float velocity) {
    if (eventCount < 64) events[eventCount++] = { note, velocity };
  }

  /** A hit plays out. A stop (a negative note) drops only the hits not yet started. */
  void pd_note_off(float note) {
    if (note < 0) eventCount = 0;
  }

  void pd_bend(float semitones) { bend = isPlayable(semitones) ? semitones : 0.0; }

  void readParams() {
    const double want = jsRound(p[ids::voices]);
    const int asked = want < 1 ? 1 : (want > 1e6 ? 1000000 : static_cast<int>(want));
    voices.ask(asked);
    voiceCount = asked < voices.size() ? asked : voices.size();
  }

  /** A file the host read for us, for Click Sample: summed to one channel. */
  bool pd_sample(int param, int slot, const PdSample& file) {
    if (param != ids::clicksample || slot < 0) return true;
    if (slot >= samples.size()) { samples.ask(slot + 1); return false; }
    samples[slot] = Sample{ file.mono, file.frames, file.sampleRate > 0 ? file.sampleRate : sampleRate };
    return true;
  }

  bool pd_work_wanted() { return voices.wanted() | samples.wanted(); }
  void pd_work() {
    const double sr = sampleRate;
    voices.build([sr](Voice& v) { v.init(sr); });
    samples.build([](Sample&) {});
  }
  void pd_work_done() { voices.install(); samples.install(); }
  void pd_work_release() { voices.release(); samples.release(); }

  /** The click file Click Sample is on at sample `j`, or none. */
  const Sample* clickFile(int j) {
    const double index = jsRound(ctl(ids::clicksample, j));
    if (!(index >= 1)) return nullptr;
    const int i = static_cast<int>(index);
    if (i >= samples.size() || !samples[i].data || samples[i].frames <= 0) return nullptr;
    return &samples[i];
  }

  Voice* allocate() {
    Voice* oldest = nullptr;
    for (int i = 0; i < voiceCount; ++i) {
      Voice& v = voices[i];
      if (!v.active) return &v;
      if (!oldest || v.age < oldest->age) oldest = &v;
    }
    return oldest ? oldest : &voices[0];
  }

  void startNote(double note, double velocity, int j) {
    Voice* voice = allocate();
    voice->age = clock++;
    seed = static_cast<unsigned int>(seed * 1664525u + 1013904223u);
    voice->noteOn(note, velocity, seed, *this, j, clickFile(j));
  }

  void pd_process(int frames) {
    readParams();
    // A call starts at its notes; they are struck a sample in, where the call has one (drum.mjs).
    for (int i = 0; i < eventCount; ++i) startNote(events[i].note, events[i].velocity, frames > 1 ? 1 : 0);
    eventCount = 0;
    float* outl = outL();
    float* outr = outR();
    std::memset(outl, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(outr, 0, sizeof(float) * static_cast<size_t>(frames));
    for (auto& v : voices) if (v.active) v.process(outl, outr, frames, bend, *this);
  }
};

}  // namespace pd_Drum

extern "C" PdAny* pd_make_Drum() { return new PdAdapter<pd_Drum::Device>(); }
