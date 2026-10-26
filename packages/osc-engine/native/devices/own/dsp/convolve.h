// Convolution: a signal through an impulse response of any length, in real time.
//
// Nothing in the browser build corresponds to this file. There the convolution is a
// ConvolverNode - native code inside Chromium - and a device that wanted one simply asked for
// one. On this engine there is no such node, so the convolution is here, and what it has to
// match is therefore not another of poptart's modules but CHROMIUM'S OWN BEHAVIOR, read from
// Blink's source:
//
//   third_party/blink/renderer/platform/audio/reverb.cc          - the normalization below
//   third_party/blink/renderer/platform/audio/reverb_convolver.cc - staged partitions
//   third_party/blink/renderer/platform/audio/fft_convolver.cc    - one stage
//
// WHAT IT COMPUTES is not in question: a convolution is a convolution, and the test holds this
// to a direct sum over the taps (native-device-parity.test.mjs). What the structure buys is the
// cost of computing it. A direct sum over a three-second response is 150,000 multiplies a
// sample, and one FFT partition size for the whole of it is either far too slow (a 128-sample
// partition means a thousand spectra multiplied every block) or far too late (a 2048-sample
// partition cannot answer for the first 2048 taps of the response). So, as Blink does it:
//
//   - the first 128 taps are convolved DIRECTLY, sample by sample, which is what makes the whole
//     thing answer with no latency at all;
//   - everything after them is covered by stages of partitions, each stage eight partitions
//     long, the partition size growing by eight at every stage (128, 1024, 8192). A stage whose
//     partitions are P long cannot answer sooner than P samples, and it does not have to: it
//     starts at tap P or later.
//
// The arithmetic is in double, as JavaScript's would be, so the reference the test compares
// against can be written in the language the rest of the browser's DSP is written in.
#pragma once

#include <cmath>
#include <cstring>
#include <vector>

#include "own/dsp/tables.h"
#include "own/pd-own.h"

namespace pd_own {

/** Taps convolved directly, which is also the shortest partition: one host block. */
constexpr int kConvHead = 128;
/** How many partitions a stage holds before the next stage takes over with bigger ones. */
constexpr int kConvStagePartitions = 8;
/** How much bigger each stage's partitions are than the last stage's. */
constexpr int kConvStageGrowth = 8;
/** The biggest partition, which the last stage uses for however much response is left. */
constexpr int kConvMaxPartition = 8192;
/** Partitions up to this size are transformed where the response is set, whatever thread that is. */
constexpr int kConvImmediate = 2048;
/** How many of the bigger partitions are transformed per block afterwards (see Convolver::advance). */
constexpr int kConvPerBlock = 1;

/**
 * One stage: a run of equal-sized partitions of the response, convolved by spectrum.
 *
 * Overlap-SAVE rather than overlap-add - the transform is twice the partition size, the input is
 * the last two partitions' worth of samples, and the valid half of the result is its second
 * half. That is the form the partitions' spectra can simply be summed in, which is the whole
 * point of partitioning: one transform of the input per block, however long the response is.
 */
struct ConvStage {
  int partition = 0;     // P
  int offset = 0;        // the tap this stage's first partition starts at
  int count = 0;         // how many partitions
  int size = 0;          // the transform, 2P

  std::vector<double> hRe, hIm;   // count * size: the response's spectra
  std::vector<double> xRe, xIm;   // count * size: the input's spectra, newest at `head`
  std::vector<double> inBuf;      // size: the previous partition, then the one filling
  std::vector<double> workRe, workIm;
  int head = 0;
  int fill = 0;

  /** Transforms one partition of the response. Not a real-time call for a big partition. */
  void buildPartition(int k, const float* ir, int irLength) {
    double* re = &hRe[static_cast<size_t>(k) * size];
    double* im = &hIm[static_cast<size_t>(k) * size];
    std::memset(re, 0, sizeof(double) * static_cast<size_t>(size));
    std::memset(im, 0, sizeof(double) * static_cast<size_t>(size));
    for (int i = 0; i < partition; ++i) {
      const int tap = offset + k * partition + i;
      re[i] = tap < irLength ? static_cast<double>(ir[tap]) : 0.0;
    }
    fft(re, im, size);
  }

  void build(const float* ir, int irLength, int partitionSize, int startTap, int partitions) {
    partition = partitionSize;
    offset = startTap;
    count = partitions;
    size = partitionSize * 2;
    hRe.assign(static_cast<size_t>(count) * size, 0.0);
    hIm.assign(static_cast<size_t>(count) * size, 0.0);
    xRe.assign(static_cast<size_t>(count) * size, 0.0);
    xIm.assign(static_cast<size_t>(count) * size, 0.0);
    inBuf.assign(static_cast<size_t>(size), 0.0);
    workRe.assign(static_cast<size_t>(size), 0.0);
    workIm.assign(static_cast<size_t>(size), 0.0);
    head = 0;
    fill = 0;
  }

  /** How far ahead of the input this stage's output lands. */
  int latency() const { return offset - partition; }

  /**
   * One sample in. When the partition fills, the block it completes is transformed, multiplied
   * into every partition's spectrum and added to `into` - a ring of future output, which is
   * where a stage's answer waits for the samples it belongs to.
   */
  void push(double x, double* into, int ringLength, int writeAt) {
    inBuf[static_cast<size_t>(partition + fill)] = x;
    if (++fill < partition) return;
    fill = 0;
    double* re = &xRe[static_cast<size_t>(head) * size];
    double* im = &xIm[static_cast<size_t>(head) * size];
    std::memcpy(re, inBuf.data(), sizeof(double) * static_cast<size_t>(size));
    std::memset(im, 0, sizeof(double) * static_cast<size_t>(size));
    fft(re, im, size);
    std::memset(workRe.data(), 0, sizeof(double) * static_cast<size_t>(size));
    std::memset(workIm.data(), 0, sizeof(double) * static_cast<size_t>(size));
    for (int k = 0; k < count; ++k) {
      // Partition k is the response k blocks back, so it multiplies the input spectrum from k
      // blocks back.
      const int slot = ((head - k) % count + count) % count;
      const double* xr = &xRe[static_cast<size_t>(slot) * size];
      const double* xi = &xIm[static_cast<size_t>(slot) * size];
      const double* hr = &hRe[static_cast<size_t>(k) * size];
      const double* hi = &hIm[static_cast<size_t>(k) * size];
      for (int i = 0; i < size; ++i) {
        workRe[static_cast<size_t>(i)] += xr[i] * hr[i] - xi[i] * hi[i];
        workIm[static_cast<size_t>(i)] += xr[i] * hi[i] + xi[i] * hr[i];
      }
    }
    fft(workRe.data(), workIm.data(), size, true);
    // The valid half, placed where the taps this stage holds put it.
    //
    // The block that just closed is the P samples ending at `writeAt`, so the earliest output it
    // can speak for is one sample later - and this stage's first tap is `offset`, which pushes
    // the whole of its answer that much further into the future. That `+ 1` is the alignment the
    // parity test checks by convolving directly: without it the whole tail arrives a sample early
    // and nothing else about the sound gives it away.
    const int base = writeAt + latency() + 1;
    for (int i = 0; i < partition; ++i) {
      const int at = ((base + i) % ringLength + ringLength) % ringLength;
      into[at] += workRe[static_cast<size_t>(partition + i)];
    }
    head = (head + 1) % count;
    // The partition that just closed becomes the previous one.
    std::memcpy(inBuf.data(), inBuf.data() + partition, sizeof(double) * static_cast<size_t>(partition));
  }
};

/**
 * One channel of convolution with a response of any length, and no latency.
 *
 * `prepare` is where the cost is - the response's partitions are transformed once - and it is
 * NOT a real-time call: a convolver is prepared when the space changes, which on this engine is
 * a knob turn (see own/convolver.cc, which says what that costs and when).
 */
struct Convolver {
  std::vector<float> response;             // the whole response, for the partitions still to build
  std::vector<float> head;                 // the first taps, convolved directly
  std::vector<double> delayLine;           // the input, for the direct part
  std::vector<ConvStage> stages;
  std::vector<double> ring;                // future output from the stages
  int ringLength = 0;
  int ringAt = 0;                          // where `now` is in the ring
  int lineAt = 0;
  int taps = 0;
  /** The next partition still to be transformed, as a stage and an index into it. */
  int pendingStage = 0;
  int pendingPartition = 0;

  void reset() {
    std::fill(delayLine.begin(), delayLine.end(), 0.0);
    std::fill(ring.begin(), ring.end(), 0.0);
    for (auto& s : stages) {
      std::fill(s.xRe.begin(), s.xRe.end(), 0.0);
      std::fill(s.xIm.begin(), s.xIm.end(), 0.0);
      std::fill(s.inBuf.begin(), s.inBuf.end(), 0.0);
      s.head = 0;
      s.fill = 0;
    }
    ringAt = 0;
    lineAt = 0;
  }

  /**
   * Lays out the stages for a response of `length` taps, and transforms as much of it as can be
   * afforded where this is called from.
   *
   * THE SMALL PARTITIONS ARE DONE HERE AND THE BIG ONES ARE NOT, so that this can be called from
   * the audio thread: transforming a six-second response costs about ten milliseconds, which is
   * four blocks' worth of deadline, and the partitions bigger than `kConvImmediate` can be built
   * a few per block afterwards (see `advance`). The Convolver device calls it off the audio
   * thread instead (own/convolver.cc's work calls) and `settle`s straight after, so a space
   * arrives whole; the staging is here for a caller that has no such thread.
   */
  void prepare(const float* ir, int length) {
    taps = length > 0 ? length : 0;
    response.assign(ir, ir + (taps > 0 ? taps : 0));
    stages.clear();
    const int direct = taps < kConvHead ? taps : kConvHead;
    head.assign(static_cast<size_t>(direct > 0 ? direct : 1), 0.f);
    for (int i = 0; i < direct; ++i) head[static_cast<size_t>(i)] = ir[i];
    delayLine.assign(static_cast<size_t>(direct > 0 ? direct : 1), 0.0);

    int at = direct;
    int partition = kConvHead;
    int furthest = 0;
    while (at < taps) {
      const int left = taps - at;
      int wanted = (left + partition - 1) / partition;
      if (partition < kConvMaxPartition && wanted > kConvStagePartitions) wanted = kConvStagePartitions;
      stages.emplace_back();
      ConvStage& stage = stages.back();
      stage.build(ir, taps, partition, at, wanted);
      if (partition <= kConvImmediate) {
        for (int k = 0; k < wanted; ++k) stage.buildPartition(k, ir, taps);
      }
      at += wanted * partition;
      const int reach = stages.back().latency() + partition;
      if (reach > furthest) furthest = reach;
      if (partition < kConvMaxPartition) partition *= kConvStageGrowth;
    }
    // The ring has to hold everything a stage can write into the future, and a power of two is
    // not required - the index is taken modulo its length.
    ringLength = furthest + kConvMaxPartition + 1;
    if (ringLength < kConvHead * 2) ringLength = kConvHead * 2;
    ring.assign(static_cast<size_t>(ringLength), 0.0);
    ringAt = 0;
    lineAt = 0;
    // Where the deferred work starts: the first stage whose partitions are too big to have been
    // done above.
    pendingStage = 0;
    pendingPartition = 0;
    while (pendingStage < static_cast<int>(stages.size())
           && stages[static_cast<size_t>(pendingStage)].partition <= kConvImmediate) {
      ++pendingStage;
    }
  }

  /** Whether every partition of the response has been transformed. */
  bool settled() const { return pendingStage >= static_cast<int>(stages.size()); }

  /**
   * Transforms up to `budget` of the partitions still waiting. Called once a block.
   *
   * A partition that has not been built yet holds zeros, which is silence: the response grows
   * into its own tail rather than arriving wrong.
   */
  void advance(int budget = kConvPerBlock) {
    for (int done = 0; done < budget && !settled(); ++done) {
      ConvStage& stage = stages[static_cast<size_t>(pendingStage)];
      stage.buildPartition(pendingPartition, response.data(), taps);
      if (++pendingPartition >= stage.count) {
        pendingPartition = 0;
        ++pendingStage;
      }
    }
  }

  /** Builds the whole response now, whatever it costs: a render, a test, a bounce. */
  void settle() { advance(1 << 30); }

  bool ready() const { return taps > 0; }

  /** One sample through the whole response. */
  double process(double x) {
    if (taps <= 0) return 0.0;
    // The direct head: the first taps, as a plain sum, which is what answers immediately.
    delayLine[static_cast<size_t>(lineAt)] = x;
    double sum = 0.0;
    const int n = static_cast<int>(head.size());
    int at = lineAt;
    for (int i = 0; i < n; ++i) {
      sum += static_cast<double>(head[static_cast<size_t>(i)]) * delayLine[static_cast<size_t>(at)];
      if (--at < 0) at = n - 1;
    }
    if (++lineAt >= n) lineAt = 0;
    // Everything the stages have already answered for this moment, which they then forget.
    sum += ring[static_cast<size_t>(ringAt)];
    ring[static_cast<size_t>(ringAt)] = 0.0;
    for (auto& s : stages) s.push(x, ring.data(), ringLength, ringAt);
    if (++ringAt >= ringLength) ringAt = 0;
    return sum;
  }
};

/**
 * The gain Chromium applies to a normalized impulse response, which a convolver has to apply
 * too or every space is a different loudness on the two engines.
 *
 * Blink's reverb.cc, CalculateNormalizationScale: the response's root-mean-square power across
 * every channel, inverted, times a fixed calibration of -58 dB, times 44100 over the sample
 * rate - and halved again for a four-channel ("true stereo") response, which poptart never
 * builds. The calibration is what makes a convolved signal come out at about the loudness it
 * went in at; the rate term is there because a response read at a higher rate has more samples
 * in it and so more power.
 */
inline double convolverNormalizationScale(const float* const* channels, int channelCount,
                                          int frames, double sampleRate) {
  constexpr double kGainCalibrationDb = -58.0;
  constexpr double kGainCalibrationSampleRate = 44100.0;
  constexpr double kMinPower = 0.000125;
  if (channelCount <= 0 || frames <= 0) return 0.0;
  double power = 0.0;
  for (int c = 0; c < channelCount; ++c) {
    const float* data = channels[c];
    for (int i = 0; i < frames; ++i) power += static_cast<double>(data[i]) * data[i];
  }
  power = std::sqrt(power / (static_cast<double>(channelCount) * frames));
  // A response of silence, or one with a NaN in it, would otherwise be amplified without limit.
  if (!std::isfinite(power) || power < kMinPower) power = kMinPower;
  double scale = 1.0 / power;
  scale *= std::pow(10.0, 0.05 * kGainCalibrationDb);
  scale *= kGainCalibrationSampleRate / sampleRate;
  return scale;
}

}  // namespace pd_own
