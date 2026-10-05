// Wavetables: the transform that band-limits a frame, the mipmap pyramid, and the tables poptart
// ships with.
//
// Translated from web-engine/src/dsp/fft.mjs and src/dsp/tables.mjs. A wavetable is a stack of
// single-cycle FRAMES, and every frame is kept at several band limits so the oscillator can read
// whichever copy is safe at the rate it is traversing the table - which is the single biggest
// difference between a wavetable oscillator that sounds expensive and one that does not.
//
// The tables are built ONCE for the whole server, the first time a Wavetable device is opened,
// and shared read-only by every instance after that. Building them is a hundred milliseconds of
// harmonic sums; it happens on the non-realtime thread, where a device is created, and never on
// the audio thread. The browser does the same thing for the same reason (sharedBuiltInTables).
#pragma once

#include <cmath>
#include <cstring>
#include <vector>

#include "own/pd-own.h"

namespace pd_own {

/** The frame length every shipped table uses. */
constexpr int kFrameLength = 2048;

/** In-place bit-reversal permutation, the reordering a radix-2 transform starts from. */
inline void bitReverse(double* re, double* im, int n) {
  for (int i = 1, j = 0; i < n; ++i) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const double tr = re[i]; re[i] = re[j]; re[j] = tr;
      const double ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
}

/** In-place complex FFT. `inverse` runs it the other way and scales by 1/n. */
inline void fft(double* re, double* im, int n, bool inverse = false) {
  bitReverse(re, im, n);
  for (int len = 2; len <= n; len <<= 1) {
    const double ang = (inverse ? 2.0 : -2.0) * M_PI / len;
    const double wRe = std::cos(ang);
    const double wIm = std::sin(ang);
    for (int i = 0; i < n; i += len) {
      double curRe = 1;
      double curIm = 0;
      for (int k = 0; k < len / 2; ++k) {
        const double aRe = re[i + k];
        const double aIm = im[i + k];
        const double bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const double bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const double nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) for (int i = 0; i < n; ++i) { re[i] /= n; im[i] /= n; }
}

/**
 * One cycle built from a harmonic series. Summing the series rather than sampling an ideal
 * shape matters: sampling an ideal square at 2048 points folds its harmonics back down into the
 * table, so the "perfect" waveform arrives already aliased.
 */
template <class Amplitude>
inline std::vector<float> fromHarmonics(int length, int count, Amplitude amplitudeOf) {
  std::vector<float> out(static_cast<size_t>(length), 0.f);
  const int limit = count < length / 2 - 1 ? count : length / 2 - 1;
  for (int k = 1; k <= limit; ++k) {
    const double a = amplitudeOf(k);
    if (a == 0) continue;
    const double step = (2.0 * M_PI * k) / length;
    // Accumulated in double and rounded once per term, which is what `out[i] += ...` does to a
    // Float32Array: rounding the term first would round twice and the frames would not match.
    for (int i = 0; i < length; ++i) {
      out[i] = static_cast<float>(static_cast<double>(out[i]) + a * std::sin(step * i));
    }
  }
  return out;
}

/**
 * The harmonic limit of each mip level, brightest first. The spacing is uneven on purpose: half
 * an octave apart down the bright end, one harmonic at a time up the dull end where one harmonic
 * either way is the difference between two audibly different timbres.
 */
inline const std::vector<int>& harmonicSchedule() {
  static std::vector<int> schedule;
  if (schedule.empty()) {
    double h = kFrameLength / 2.0;
    while (h > 8) {
      const int keep = static_cast<int>(jsRound(h));
      schedule.push_back(keep < 1 ? 1 : keep);
      h /= M_SQRT2;
    }
    for (int k = 8; k >= 1; --k) schedule.push_back(k);
  }
  return schedule;
}

/** Harmonics kept at mip level L. */
inline int harmonicsAtLevel(int level) {
  const std::vector<int>& schedule = harmonicSchedule();
  const int top = static_cast<int>(schedule.size()) - 1;
  const int l = level < 0 ? 0 : (level > top ? top : level);
  return schedule[static_cast<size_t>(l)];
}

inline int levelCount() { return static_cast<int>(harmonicSchedule().size()); }

/**
 * How long a level's copy needs to be: four samples per harmonic, so reading it with
 * interpolation does not audibly dull it further.
 */
inline int lengthAtLevel(int level) {
  const int want = harmonicsAtLevel(level) * 4;
  int len = 16;
  while (len < want && len < kFrameLength) len *= 2;
  return len < kFrameLength ? len : kFrameLength;
}

/**
 * Where to read the pyramid when the table is traversed at `rate` cycles per sample.
 *
 * A FRACTIONAL level, whose floor always fits under the limit - so the brighter of the two
 * copies the oscillator blends is already safe - and which moves continuously with the rate, so
 * a sweeping pitch hears a gradual change and never a step.
 */
inline double mipLevelFor(double rate) {
  const std::vector<int>& schedule = harmonicSchedule();
  const int top = static_cast<int>(schedule.size()) - 1;
  const double r = std::fabs(rate);
  if (!(r > 0)) return 0;
  const double maxHarmonic = 0.5 / r;
  if (maxHarmonic >= schedule[0]) return 0;
  if (maxHarmonic <= schedule[static_cast<size_t>(top)]) return top;
  int level = 0;
  while (level < top && schedule[static_cast<size_t>(level)] > maxHarmonic) ++level;
  if (level >= top) return top;
  if (level == 0) return 0;
  const double prev = schedule[static_cast<size_t>(level - 1)];
  const double here = schedule[static_cast<size_t>(level)];
  const double w = prev == here ? 0 : (prev - maxHarmonic) / (prev - here);
  return level + clamp(w, 0.0, 1.0);
}

/** One frame's band-limited copies, level 0 first (every harmonic) down to a sine. */
inline std::vector<std::vector<float>> buildMipmaps(const std::vector<float>& frame) {
  const int n = static_cast<int>(frame.size());
  const int levels = levelCount();
  std::vector<std::vector<float>> out(static_cast<size_t>(levels));
  // Level 0 is the frame itself rather than a round trip through the transform.
  out[0] = frame;
  std::vector<double> re0(static_cast<size_t>(n));
  std::vector<double> im0(static_cast<size_t>(n), 0.0);
  for (int i = 0; i < n; ++i) re0[static_cast<size_t>(i)] = frame[static_cast<size_t>(i)];
  fft(re0.data(), im0.data(), n);
  std::vector<double> re(static_cast<size_t>(n));
  std::vector<double> im(static_cast<size_t>(n));
  for (int l = 1; l < levels; ++l) {
    int keep = harmonicsAtLevel(l);
    if (keep > n / 2 - 1) keep = n / 2 - 1;
    if (keep < 0) keep = 0;
    re = re0;
    im = im0;
    for (int k = keep + 1; k <= n / 2; ++k) {
      re[static_cast<size_t>(k)] = 0;
      im[static_cast<size_t>(k)] = 0;
      const int mirror = n - k;
      if (mirror > k && mirror < n) {
        re[static_cast<size_t>(mirror)] = 0;
        im[static_cast<size_t>(mirror)] = 0;
      }
    }
    fft(re.data(), im.data(), n, true);
    const int len = lengthAtLevel(l);
    std::vector<float> small(static_cast<size_t>(len));
    const int step = n / len;
    for (int i = 0; i < len; ++i) small[static_cast<size_t>(i)] = static_cast<float>(re[static_cast<size_t>(i * step)]);
    out[static_cast<size_t>(l)] = small;
  }
  return out;
}

/** A loaded wavetable: frames and their mipmaps. */
struct Table {
  const char* name = "";
  int length = kFrameLength;
  int frameCount = 0;
  int levels = 0;
  std::vector<std::vector<std::vector<float>>> mips;   // [frame][level][sample]
};

inline Table buildTable(const char* name, const std::vector<std::vector<float>>& frames) {
  Table t;
  t.name = name;
  t.length = static_cast<int>(frames[0].size());
  t.frameCount = static_cast<int>(frames.size());
  t.levels = levelCount();
  t.mips.reserve(frames.size());
  for (const auto& f : frames) t.mips.push_back(buildMipmaps(f));
  return t;
}

/** Peak-normalizes a frame to 1, leaving a silent frame alone. */
inline std::vector<float> normalizeFrame(const std::vector<float>& frame) {
  double peak = 0;
  for (float v : frame) peak = std::fmax(peak, std::fabs(static_cast<double>(v)));
  if (peak <= 0) return frame;
  const double g = 1.0 / peak;
  std::vector<float> out(frame.size());
  for (size_t i = 0; i < frame.size(); ++i) out[i] = static_cast<float>(frame[i] * g);
  return out;
}

/** Subtracts the mean, so a pulse frame sits around zero rather than pushing the amp off center. */
inline std::vector<float> removeDc(const std::vector<float>& frame) {
  double sum = 0;
  for (float v : frame) sum += v;
  const double mean = sum / frame.size();
  std::vector<float> out(frame.size());
  for (size_t i = 0; i < frame.size(); ++i) out[i] = static_cast<float>(frame[i] - mean);
  return out;
}

/** A band-limited rising sawtooth: every harmonic at 1/k. */
inline std::vector<float> sawFrame() {
  return fromHarmonics(kFrameLength, kFrameLength / 2 - 1,
                       [](int k) { return (k % 2 == 1 ? 1.0 : -1.0) * (2.0 / M_PI) / k; });
}

/** A band-limited square: odd harmonics at 1/k. */
inline std::vector<float> squareFrame() {
  return fromHarmonics(kFrameLength, kFrameLength / 2 - 1,
                       [](int k) { return k % 2 == 1 ? (4.0 / M_PI) / k : 0.0; });
}

/** A band-limited triangle: odd harmonics at 1/k squared, alternating sign. */
inline std::vector<float> triangleFrame() {
  return fromHarmonics(kFrameLength, kFrameLength / 2 - 1, [](int k) {
    if (k % 2 == 0) return 0.0;
    const double sign = ((k - 1) / 2) % 2 == 0 ? 1.0 : -1.0;
    return sign * (8.0 / (M_PI * M_PI)) / (static_cast<double>(k) * k);
  });
}

inline std::vector<float> sineFrame() {
  return fromHarmonics(kFrameLength, 1, [](int k) { return k == 1 ? 1.0 : 0.0; });
}

/**
 * A band-limited pulse of the given duty, built as the difference of two sawtooths a duty apart,
 * which keeps it exactly as band-limited as the saw is.
 */
inline std::vector<float> pulseFrame(double duty) {
  const std::vector<float> saw = sawFrame();
  const int shift = static_cast<int>(jsRound(duty * kFrameLength));
  std::vector<float> out(static_cast<size_t>(kFrameLength));
  for (int i = 0; i < kFrameLength; ++i) {
    out[static_cast<size_t>(i)] = saw[static_cast<size_t>(i)] - saw[static_cast<size_t>((i + shift) % kFrameLength)];
  }
  return normalizeFrame(removeDc(out));
}

/** A naive render of one cycle - for the shapes a series does not describe. */
template <class Fn>
inline std::vector<float> rendered(Fn fn) {
  std::vector<float> out(static_cast<size_t>(kFrameLength));
  for (int i = 0; i < kFrameLength; ++i) {
    out[static_cast<size_t>(i)] = static_cast<float>(fn(static_cast<double>(i) / kFrameLength));
  }
  return normalizeFrame(removeDc(out));
}

/** Triangle folding at a gain: past full scale the wave turns round and comes back. */
inline double foldWave(double x) {
  double q = (x + 1) * 0.25;
  q -= std::floor(q);
  return 1 - std::fabs(q * 4 - 2);
}

/** The vowels of the Vocal table, as formant centers in Hz over a fundamental near c2. */
constexpr double kVowels[5][3] = {
  { 730, 1090, 2440 },   // a
  { 530, 1840, 2480 },   // e
  { 270, 2290, 3010 },   // i
  { 570, 840, 2410 },    // o
  { 300, 870, 2240 },    // u
};

/** A frame with peaks at the given harmonics, each a Gaussian of the given width. */
inline std::vector<float> formantFrame(const double* centersHz) {
  return normalizeFrame(fromHarmonics(kFrameLength, 64, [centersHz](int k) {
    double a = 0;
    for (int i = 0; i < 3; ++i) {
      const double center = centersHz[i] / 130.0;
      const double width = 1.2 + i * 1.5;
      a += std::exp(-((k - center) * (k - center)) / (2 * width * width)) * (i == 0 ? 1.0 : 0.6);
    }
    return a / std::pow(static_cast<double>(k), 0.3);
  }));
}

/**
 * The tables poptart ships with, built once per process and shared read-only.
 *
 * "Basic" holds the classic waveforms in one stack, ordered softest to hardest and then through
 * narrowing pulse widths; the rest are each one classic technique laid out along the position.
 * The ORDER IS THE DESCRIPTOR'S option list, since an index is what a song holds.
 */
inline const std::vector<Table>& builtInTables() {
  static std::vector<Table> tables;
  if (!tables.empty()) return tables;

  std::vector<std::vector<float>> basic = {
    normalizeFrame(sineFrame()), normalizeFrame(triangleFrame()), normalizeFrame(sawFrame()),
    normalizeFrame(squareFrame()), normalizeFrame(pulseFrame(0.375)),
    normalizeFrame(pulseFrame(0.25)), normalizeFrame(pulseFrame(0.125)),
  };

  // A run from a pure tone to a full 1/k series: a lowpass sweep done as harmonic content.
  std::vector<std::vector<float>> harmonics;
  for (int count : { 1, 2, 3, 5, 8, 16, 32, 64 }) {
    harmonics.push_back(normalizeFrame(fromHarmonics(kFrameLength, count,
        [count](int k) { return k <= count ? 1.0 / k : 0.0; })));
  }

  // The same, odd harmonics only - hollow where the one above is bright.
  std::vector<std::vector<float>> odd;
  for (int count : { 1, 3, 5, 9, 17, 33, 65 }) {
    odd.push_back(normalizeFrame(fromHarmonics(kFrameLength, count,
        [count](int k) { return (k % 2 == 1 && k <= count) ? 1.0 / k : 0.0; })));
  }

  // Pulse width, from a square to a needle.
  std::vector<std::vector<float>> pwm;
  for (double duty : { 0.5, 0.42, 0.34, 0.26, 0.19, 0.13, 0.08, 0.05 }) pwm.push_back(pulseFrame(duty));

  // A sawtooth hard-synced to the note, the slave running from one to four times the master.
  std::vector<std::vector<float>> sync;
  for (double ratio : { 1.0, 1.3, 1.65, 2.0, 2.4, 2.9, 3.4, 4.0 }) {
    sync.push_back(rendered([ratio](double t) {
      const double q = std::fmod(t * ratio, 1.0);
      return q * 2 - 1;
    }));
  }

  // A sine through a wavefolder, driven harder frame by frame.
  std::vector<std::vector<float>> folded;
  for (double gain : { 1.0, 1.4, 1.9, 2.5, 3.2, 4.0, 5.0, 6.5 }) {
    folded.push_back(rendered([gain](double t) { return foldWave(std::sin(2 * M_PI * t) * gain); }));
  }

  // Two-operator FM at a ratio of two, the index rising: a sine into a bell into a buzz.
  std::vector<std::vector<float>> fm;
  for (double index : { 0.0, 0.4, 0.9, 1.5, 2.3, 3.4, 5.0, 7.0 }) {
    fm.push_back(rendered([index](double t) {
      return std::sin(2 * M_PI * t + index * std::sin(4 * M_PI * t));
    }));
  }

  // Drawbar organ: sub and fundamental, then thirds and fifths, then the mixture.
  static const double drawbars[6][9] = {
    { 0, 1, 0, 0, 0, 0, 0, 0, 0 },
    { 0.5, 1, 0, 0, 0, 0, 0, 0, 0 },
    { 0.5, 1, 0, 0.6, 0, 0, 0, 0, 0 },
    { 0.5, 1, 0.5, 0.6, 0, 0.4, 0, 0, 0 },
    { 0.6, 1, 0.6, 0.8, 0.5, 0.5, 0, 0.3, 0 },
    { 0.7, 1, 0.8, 0.9, 0.7, 0.7, 0.5, 0.5, 0.4 },
  };
  static const double organHarmonics[9] = { 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8 };
  std::vector<std::vector<float>> organ;
  for (const auto& bars : drawbars) {
    organ.push_back(rendered([&bars](double t) {
      // Summed in the array's order, as the browser's reduce does.
      double sum = 0;
      for (int i = 0; i < 9; ++i) sum += bars[i] * std::sin(2 * M_PI * organHarmonics[i] * 2 * t);
      return sum;
    }));
  }

  std::vector<std::vector<float>> vocal;
  for (const auto& centers : kVowels) vocal.push_back(formantFrame(centers));

  tables.push_back(buildTable("Basic", basic));
  tables.push_back(buildTable("Harmonics", harmonics));
  tables.push_back(buildTable("Odd", odd));
  tables.push_back(buildTable("PWM", pwm));
  tables.push_back(buildTable("Sync", sync));
  tables.push_back(buildTable("Fold", folded));
  tables.push_back(buildTable("FM", fm));
  tables.push_back(buildTable("Organ", organ));
  tables.push_back(buildTable("Vocal", vocal));
  return tables;
}

/** The sub oscillator's own two-frame table: a sine and a square, band-limited like any other. */
inline const Table& subTable() {
  static Table table;
  if (table.frameCount == 0) {
    const Table& basic = builtInTables()[0];
    table = buildTable("Sub", { basic.mips[0][0], basic.mips[3][0] });
  }
  return table;
}

}  // namespace pd_own
