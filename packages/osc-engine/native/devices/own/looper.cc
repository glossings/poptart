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

#include <algorithm>

#include "own/pd-own.h"
#include "pd-own-ids.h"

namespace pd_Looper {

namespace ids = pd_ids::Looper;
using namespace pd_own;

/** Frames per chunk of loop memory: the browser's LOOPER_CHUNK. */
constexpr int kChunk = 65536;
/** How late after a line a press may arrive and still count as on that line. */
constexpr double kLateSec = 0.03;
/** Samples of the overdub's punch ramp. */
constexpr double kFade = 64;
/** Seconds of crossfade at the loop's seam (see the browser's SEAM_SEC). */
constexpr double kSeamSec = 0.01;
/** How close under a whole sample the playhead may be and still write to it. */
constexpr double kSnap = 1e-6;
/** Seconds the loop takes to go quiet at the end of a played-out pass, and to come back in. */
constexpr double kGateSec = 0.005;
/** Each Length in beats: the browser's LENGTH_BEATS. */
constexpr double kLengthBeats[] = { 4, 8, 16, 32, 64, 128 };
constexpr int kLengths = sizeof(kLengthBeats) / sizeof(kLengthBeats[0]);
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
  double origin = 0;
  double loopBeats = 0;
  double offset = 0;
  bool state = false;
  bool pending = false;
  bool lastRecord = false;
  bool lastClear = false;
  bool taking = false;
  long long count = 0;
  bool haveLine = false;
  long long lastLine = 0;
  double lastGrid = 0;
  double punch = 0;
  long long lastWritten = -1;
  double takeIn = 1;
  long long headStart = 0;
  long long tailAt = 0;
  long long tailEnd = 0;
  double playhead = 0;  // through the loop, 0 to 1, for the report
  double lastBeat = 0;
  // Following the track (the browser's setRunning): whether it plays, a pass being played out
  // after a stop, and the loop's level as it goes quiet or comes back in.
  bool running = true;
  bool coasting = false;
  double coastPos = 0;
  double lastP = 0;
  double lastS = 1;
  double gate = 1;

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

  /** A new table of `want` chunks: the ones there are, and new zeroed ones. Not the audio thread. */
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
    origin = 0;
    loopBeats = 0;
    offset = 0;
    state = false;
    pending = false;
    lastRecord = false;
    lastClear = false;
    taking = false;
    count = 0;
    haveLine = false;
    lastLine = 0;
    lastGrid = 0;
    punch = 0;
    lastWritten = -1;
    takeIn = 1;
    headStart = 0;
    tailAt = 0;
    tailEnd = 0;
    playhead = 0;
    lastBeat = 0;
    running = true;
    coasting = false;
    coastPos = 0;
    lastP = 0;
    lastS = 1;
    gate = 1;
  }

  /** The track plays or stops: told every block, acted on when it changes (the browser's _run). */
  void pd_running(bool on) {
    if (on == running) return;
    running = on;
    if (!on) {
      const double L = static_cast<double>(length);
      const double raw = lastP + lastS;
      const double next = std::fabs(raw - jsRound(raw)) < kSnap ? jsRound(raw) : raw;
      coasting = length > 0 && gate > 0 && next >= 0 && next < L;
      coastPos = length > 0 ? next - std::floor(next / L) * L : 0;
    } else {
      coasting = false;
    }
  }

  /**
   * What the loop is doing, as the browser's report() says it: the status (LOOPER_STATUS's index:
   * empty, armed, recording, playing, overdub, stopped), its beats (-1 with no loop), its seconds,
   * the playhead through it, and a first take's seconds and beats so far. Read by
   * native-devices.js.
   */
  int pd_report(float* out, int capacity) {
    if (capacity < 6) return 0;
    int status = 0;
    if (taking) status = 2;
    else if (length > 0) status = state ? 4 : pending ? 1 : (running || coasting) ? 3 : 5;
    else if (pending) status = 1;
    out[0] = static_cast<float>(status);
    out[1] = length > 0 ? static_cast<float>(loopBeats) : -1.0f;
    out[2] = length > 0 ? static_cast<float>(static_cast<double>(length) / sampleRate) : 0.0f;
    out[3] = length > 0 ? static_cast<float>(playhead) : 0.0f;
    out[4] = taking ? static_cast<float>(static_cast<double>(count) / sampleRate) : 0.0f;
    out[5] = taking ? static_cast<float>(std::fmax(0.0, lastBeat - origin)) : 0.0f;
    return 6;
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

  /** Blends what followed the take into the loop's start at `k` (the browser's _blend). */
  void blend(long long k, double l, double r) {
    const double fade = static_cast<double>(jsRoundInt(kSeamSec * sampleRate));
    const double t = std::fmin(1.0, std::fmax(0.0, static_cast<double>(k - headStart) / fade)) * M_PI / 2;
    const double g = std::sin(t);
    const double h = std::cos(t);
    write(k, 0, read(k, 0) * g + l * h);
    write(k, 1, read(k, 1) * g + r * h);
  }

  /** A line, `late` seconds ago (the browser's _line). */
  void line(long long n, double grid, double late, bool held) {
    const bool want = pending || (state && held);
    pending = false;
    if (taking) close();
    if (!want) {
      state = false;
      return;
    }
    state = true;
    if (length > 0) return;   // an overdub: the punch ramp does the rest
    taking = true;
    origin = static_cast<double>(n) * grid;
    loopBeats = grid;
    count = static_cast<long long>(jsRound(late * sampleRate));
    // The part of the pass that went by before the press is silence.
    for (long long k = 0; k < count; ++k) { write(k, 0, 0); write(k, 1, 0); }
    headStart = count;
    tailEnd = 0;
  }

  /** The first take has run its pass, and the loop plays (the browser's _close). */
  void close() {
    taking = false;
    if (count > 0) length = count;
    tailAt = 0;
    tailEnd = length > 0 ? std::min(length, headStart + static_cast<long long>(jsRoundInt(kSeamSec * sampleRate))) : 0;
    offset = 0;
    punch = 0;
    lastWritten = -1;
  }

  void pd_process(int frames) {
    const double sr = sampleRate;
    const int lengthIx = jsRoundInt(p[ids::length]);
    const double fixed = lengthIx >= 0 && lengthIx < kLengths ? kLengthBeats[lengthIx] : kLengthBeats[0];
    const double gateStep = 1 / (kGateSec * sr);
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

      // Clear: the loop goes, and a take in progress with it.
      const bool clear = ctl(ids::clear, i) >= 0.5;
      if (clear && !lastClear) {
        length = 0;
        taking = false;
        state = false;
        pending = false;
        punch = 0;
        lastWritten = -1;
        tailEnd = 0;
        coasting = false;
      }
      lastClear = clear;

      // Record, a pass at a time on the grid: the loop's length once there is one, Length before.
      const bool held = ctl(ids::record, i) >= 0.5;
      const bool press = held && !lastRecord;
      lastRecord = held;
      const double grid = (length > 0 || taking) ? loopBeats : fixed;
      const long long n = static_cast<long long>(std::floor(beat / grid + 1e-9));
      const double late = (beat - static_cast<double>(n) * grid) * 60 / bpm;
      // A line crossed. A grid that changed is not a crossing: the index means another line.
      if (haveLine && lastGrid == grid && n != lastLine) line(n, grid, 0, held || press);
      haveLine = true;
      lastLine = n;
      lastGrid = grid;
      if (press && !state) {
        pending = true;
        if (late < kLateSec) line(n, grid, late, held);
      }

      double wetL = 0;
      double wetR = 0;
      const double mix = std::fmin(1.0, std::fmax(0.0, static_cast<double>(ctl(ids::mix, i))));
      const double speed = ctl(ids::speed, i);
      const double s = ctl(ids::reverse, i) >= 0.5 ? -speed : speed;
      if (taking) {
        // The crossfade with no loop under it yet: the input, as loud as Mix lets it in.
        takeIn = 1 - mix;
        write(count, 0, l * takeIn);
        write(count, 1, r * takeIn);
        count += 1;
      } else if (length > 0 && (running || coasting || gate > 0)) {
        const double L = static_cast<double>(length);
        const bool live = running || coasting;
        // The take's run-on, into the seam's crossfade, at the level the take ended on.
        if (tailAt < tailEnd) {
          blend(tailAt, l * takeIn, r * takeIn);
          tailAt += 1;
        }
        double pos;
        if (!running) {
          pos = coastPos;
        } else {
          const double x = beat - origin + offset;
          const double phase = x - std::floor(x / loopBeats) * loopBeats;
          pos = (phase / loopBeats) * L;
        }
        if (pos >= L) pos -= L;
        if (pos < 0) pos = 0;
        playhead = pos / L;
        lastP = pos;
        lastS = s;
        const long long a = static_cast<long long>(std::floor(pos));
        const double frac = pos - static_cast<double>(a);
        const long long b = a + 1 >= length ? 0 : a + 1;
        const double aL = read(a, 0);
        const double aR = read(a, 1);
        gate = live ? std::fmin(1.0, gate + gateStep) : std::fmax(0.0, gate - gateStep);
        wetL = (aL + (read(b, 0) - aL) * frac) * gate;
        wetR = (aR + (read(b, 1) - aR) * frac) * gate;

        // The overdub, read after the loop was (see the browser's for the snap).
        if (state) punch = std::fmin(1.0, punch + 1 / kFade);
        else punch = std::fmax(0.0, punch - 1 / kFade);
        long long idx = static_cast<long long>(std::floor(pos + kSnap));
        if (idx >= length) idx = 0;
        if (live && punch > 0 && idx != lastWritten) {
          // Mix's crossfade, punched in: the loop keeps `mix` of itself, the input the rest.
          const double g = punch;
          const double keep = 1 - g * (1 - mix);
          const double add = g * (1 - mix);
          write(idx, 0, read(idx, 0) * keep + l * add);
          write(idx, 1, read(idx, 1) * keep + r * add);
          lastWritten = idx;
        }

        if (!running) {
          // A played-out pass ends where it wraps; the level is then let down past the seam.
          double next = coastPos + s;
          if (coasting && (next >= L || next < 0)) coasting = false;
          next -= std::floor(next / L) * L;
          coastPos = next;
        }
      } else if (!running) {
        gate = 0;
      }
      offset += (s - 1) * bpm / (60 * sr);
      // Kept inside one loop length, where it means the same and keeps its precision.
      if (length > 0) offset -= std::floor(offset / loopBeats) * loopBeats;

      outl[i] = static_cast<float>(rawL * (1 - mix) + wetL * mix);
      outr[i] = static_cast<float>(rawR * (1 - mix) + wetR * mix);
      lastBeat = beat;
    }
  }
};

}  // namespace pd_Looper

extern "C" PdAny* pd_make_Looper() { return new PdAdapter<pd_Looper::Device>(); }
