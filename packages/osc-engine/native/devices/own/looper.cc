// The Looper: records what is playing into a loop, plays it back, and layers more on top.
//
// Translated from web-engine/src/devices/looper.mjs, line for line; read that file for what the
// device does. What is this file's own is where the loop's memory comes from. The browser adds a
// chunk on the audio thread when a take reaches the end of what it has; here a chunk is never
// allocated on the audio thread, so the take asks for more through the work round (pd-device.h)
// while it still has CHUNKS_AHEAD chunks in hand. A round builds a bigger table of chunk pointers
// and the new zeroed chunks off the audio thread, the audio thread swaps the table pointer in,
// and the old table is freed off it again. A write that lands where no chunk is yet is dropped -
// the take never waits - and a read there is silence, as a chunk that arrives later starts out.

#include "own/pd-own.h"
#include "own/dsp/sync.h"
#include "pd-own-ids.h"

namespace pd_Looper {

namespace ids = pd_ids::Looper;
using namespace pd_own;

/** Frames per chunk of loop memory: the browser's LOOPER_CHUNK. */
constexpr int kChunk = 65536;
/** How late after a grid line an edge may arrive and still count as on that line. */
constexpr double kLateSec = 0.03;
/** Samples of fade at the loop's seam, and of the overdub's punch ramp. */
constexpr double kFade = 64;
/** How close under a whole sample the playhead may be and still write to it. */
constexpr double kSnap = 1e-6;
/** Chunks kept ready past the one a take is writing into, so a round has time to land. */
constexpr int kChunksAhead = 2;

struct Device : pd_own::Device<ids::kCount> {
  // The loop's memory: a table of chunks, each kChunk frames of left then kChunk of right.
  float** table = nullptr;
  int chunkCount = 0;
  // A round of the work: how many chunks it was asked for, what it built, what it swapped out.
  int wantChunks = 0;
  float** freshTable = nullptr;
  int freshCount = 0;
  float** oldTable = nullptr;

  double bpm = 120;
  double transportSec = 0;
  long long length = 0;
  bool locked = false;
  double origin = 0;
  double loopBeats = 0;
  double offset = 0;
  double freePos = 0;
  bool state = false;
  bool lastRecord = false;
  bool lastClear = false;
  bool taking = false;
  bool takeLocked = false;
  long long count = 0;
  long long countAtLine = 0;
  bool haveLine = false;
  long long lastLine = 0;
  double lastGrid = 0;
  bool haveGrid = false;
  double punch = 0;
  long long lastWritten = -1;

  ~Device() {
    for (int c = 0; c < chunkCount; ++c) delete[] table[c];
    delete[] table;
    // A round built and never installed (the device replaced mid-round): its own chunks are the
    // ones past what the installed table holds.
    if (freshTable) {
      for (int c = chunkCount; c < freshCount; ++c) delete[] freshTable[c];
      delete[] freshTable;
    }
    delete[] oldTable;
  }

  /** A new table of `count` chunks: the ones there are, and new zeroed ones. Not the audio thread. */
  void build(int want) {
    float** next = new float*[static_cast<size_t>(want)];
    for (int c = 0; c < chunkCount; ++c) next[c] = table[c];
    for (int c = chunkCount; c < want; ++c) next[c] = new float[2 * static_cast<size_t>(kChunk)]();
    freshTable = next;
    freshCount = want;
  }

  void install() {
    oldTable = table;
    table = freshTable;
    chunkCount = freshCount;
    freshTable = nullptr;
    freshCount = 0;
  }

  void pd_init(double sr) {
    sampleRate = sr;
    // The first chunks before the device plays: pd_init runs off the audio thread.
    if (!table) {
      build(kChunksAhead + 1);
      install();
      delete[] oldTable;
      oldTable = nullptr;
    }
    bpm = 120;
    transportSec = 0;
    length = 0;
    locked = false;
    origin = 0;
    loopBeats = 0;
    offset = 0;
    freePos = 0;
    state = false;
    lastRecord = false;
    lastClear = false;
    taking = false;
    takeLocked = false;
    count = 0;
    countAtLine = 0;
    haveLine = false;
    lastLine = 0;
    lastGrid = 0;
    haveGrid = false;
    punch = 0;
    lastWritten = -1;
  }

  void pd_transport(double tempo, double seconds) { bpm = tempo; transportSec = seconds; }

  // ---- the work round: more chunks while a take runs -------------------------------------------

  bool pd_work_wanted() {
    if (!taking) return false;
    const long long need = count / kChunk + kChunksAhead + 1;
    if (need <= chunkCount) return false;
    wantChunks = static_cast<int>(need);
    return true;
  }
  void pd_work() { if (wantChunks > chunkCount) build(wantChunks); }
  void pd_work_done() { if (freshTable) install(); }
  void pd_work_release() {
    delete[] oldTable;
    oldTable = nullptr;
  }

  // ---- the loop's memory -----------------------------------------------------------------------

  float* at(long long index, int channel) {
    const long long c = index / kChunk;
    if (index < 0 || c >= chunkCount) return nullptr;
    return table[c] + channel * kChunk + (index - c * kChunk);
  }
  double read(long long index, int channel) {
    const float* x = at(index, channel);
    return x ? static_cast<double>(*x) : 0.0;
  }
  void write(long long index, int channel, double value) {
    float* x = at(index, channel);
    if (x) *x = static_cast<float>(value);
  }

  /** Record turns on or off, `late` seconds after the grid line it counts as on. */
  void apply(bool on, double late, bool free, double beat, long long line, double grid) {
    state = on;
    if (on) {
      if (length > 0 || taking) return;   // an overdub: the punch ramp does the rest
      taking = true;
      takeLocked = !free;
      origin = free ? 0 : static_cast<double>(line) * grid;
      count = free ? 0 : static_cast<long long>(jsRound(late * sampleRate));
      // The part of the first grid step that went by before the press is silence.
      for (long long k = 0; k < count; ++k) { write(k, 0, 0); write(k, 1, 0); }
      countAtLine = count;
      return;
    }
    if (!taking) return;
    taking = false;
    // A take that ends on a line is as long as it was AT that line: a late release is cut back.
    const long long taken = free ? count : countAtLine;
    if (takeLocked) {
      const double beats = (free ? beat : static_cast<double>(line) * grid) - origin;
      if (beats > 0 && taken > 0) {
        length = taken;
        loopBeats = beats;
        locked = true;
      }
    } else if (taken > 0) {
      length = taken;
      locked = false;
    }
    offset = 0;
    freePos = 0;
    punch = 0;
    lastWritten = -1;
  }

  void pd_process(int frames) {
    const double sr = sampleRate;
    const double grid = syncBeats(jsRoundInt(p[ids::quantize]));
    const bool free = grid < 0;
    const float* inl = inL();
    const float* inr = inR();
    float* outl = outL();
    float* outr = outR();

    for (int i = 0; i < frames; ++i) {
      const double rawL = inl[i];
      const double rawR = inr[i];
      const double l = isPlayable(rawL) ? rawL : 0.0;
      const double r = isPlayable(rawR) ? rawR : 0.0;
      const double beat = (transportSec + i / sr) * bpm / 60;

      // Clear: the loop goes, and a take in progress with it. Record still held starts over.
      const bool clear = ctl(ids::clear, i) >= 0.5;
      if (clear && !lastClear) {
        length = 0;
        taking = false;
        state = false;
        punch = 0;
        lastWritten = -1;
      }
      lastClear = clear;

      // Record, on the grid.
      const bool record = ctl(ids::record, i) >= 0.5;
      const bool edge = record != lastRecord;
      lastRecord = record;
      if (free) {
        haveLine = false;
        if (record != state) apply(record, 0, true, beat, 0, 0);
      } else {
        const long long line = static_cast<long long>(std::floor(beat / grid + 1e-9));
        const double late = (beat - static_cast<double>(line) * grid) * 60 / bpm;
        // A line crossed. A grid that changed is not a crossing: the index means another line.
        if (haveGrid && lastGrid == grid && haveLine && line != lastLine) {
          if (taking) countAtLine = count;
          if (record != state) apply(record, 0, false, beat, line, grid);
        }
        haveLine = true;
        lastLine = line;
        haveGrid = true;
        lastGrid = grid;
        if (edge && record != state && late < kLateSec) apply(record, late, false, beat, line, grid);
      }

      double wetL = 0;
      double wetR = 0;
      const double speed = ctl(ids::speed, i);
      const double s = ctl(ids::reverse, i) >= 0.5 ? -speed : speed;
      if (taking) {
        write(count, 0, l);
        write(count, 1, r);
        count += 1;
      } else if (length > 0) {
        const double L = static_cast<double>(length);
        double pos;
        if (locked) {
          const double x = beat - origin + offset;
          const double phase = x - std::floor(x / loopBeats) * loopBeats;
          pos = (phase / loopBeats) * L;
        } else {
          pos = freePos;
        }
        if (pos >= L) pos -= L;
        if (pos < 0) pos = 0;
        const long long a = static_cast<long long>(std::floor(pos));
        const double frac = pos - static_cast<double>(a);
        const long long b = a + 1 >= length ? 0 : a + 1;
        const double seam = std::fmin(1.0, std::fmin(pos, L - pos) / kFade);
        const double aL = read(a, 0);
        const double aR = read(a, 1);
        wetL = (aL + (read(b, 0) - aL) * frac) * seam;
        wetR = (aR + (read(b, 1) - aR) * frac) * seam;

        // The overdub, read after the loop was (see the browser's for the snap).
        if (state) punch = std::fmin(1.0, punch + 1 / kFade);
        else punch = std::fmax(0.0, punch - 1 / kFade);
        long long idx = static_cast<long long>(std::floor(pos + kSnap));
        if (idx >= length) idx = 0;
        if (punch > 0 && idx != lastWritten) {
          const double g = punch;
          const double keep = 1 - g * (1 - ctl(ids::feedback, i));
          write(idx, 0, read(idx, 0) * keep + l * g);
          write(idx, 1, read(idx, 1) * keep + r * g);
          lastWritten = idx;
        }

        if (!locked) {
          double next = freePos + s;
          next -= std::floor(next / L) * L;
          freePos = next;
        }
      }
      offset += (s - 1) * bpm / (60 * sr);
      // Kept inside one loop length, where it means the same and keeps its precision.
      if (length > 0 && locked) offset -= std::floor(offset / loopBeats) * loopBeats;

      const double dry = ctl(ids::dry, i);
      const double wet = ctl(ids::wet, i);
      outl[i] = static_cast<float>(rawL * dry + wetL * wet);
      outr[i] = static_cast<float>(rawR * dry + wetR * wet);
    }
  }
};

}  // namespace pd_Looper

extern "C" PdAny* pd_make_Looper() { return new PdAdapter<pd_Looper::Device>(); }
