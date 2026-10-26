// The parity harness: one device, one block at a time, from a pipe.
//
// Built and run by osc-engine's native-device-parity.test.mjs, which plays the same input through
// the browser's JavaScript processor and through this and compares the two. It exists because
// poptart's own devices are the one part of the port that is a SECOND implementation rather than
// the same source compiled twice (see own/pd-own.h), and the only honest way to hold two
// implementations together is to run both.
//
// Not shipped, not linked into the extension: this has a main().
//
//   harness <device> <sampleRate> <frames> <blockSize> [bpm] [-k 0|1] [-n frame:note:vel ...]
//            [-S control:slot:rate:channels:frameLength:file ...] [-H control:slot:file ...]
//            [-A control:file ...] [-R file]
//
// stdin, little-endian: the parameter values in REAL UNITS (the position-to-value conversion is
// pd_denormalize's job and is tested separately), then the input as interleaved stereo floats.
// stdout: the output as interleaved stereo floats. Notes come in on the command line, as
// `-n frame:note:velocity` for an instrument, and land ON THEIR FRAME: the run is cut there and
// the note made between the two pieces, as PoptartDevice cuts its render at a note's offset into
// the block. `-k 0` says that nothing is routed into the slot's key input (the default for a
// sidechained device is that something is).
//
// `-S` is a FILE for a device that plays one - a granulator's sample, a convolver's impulse
// response, a wavetable. `control` is its index in the device's own control list, `slot` the
// entry on that control's option list it is loaded into, `channels` how many channels `file`
// holds interleaved (raw 32-bit floats at `rate`), and `frameLength` the wavetable frame length
// the file declares, 0 for none. The device is handed it in the shape the host hands one over
// (PdSample: the mono sum and the channels), and the host owns that memory for as long as the
// device plays it, so these vectors outlive the run.
//
// `-H` is a DRAWN curve, raw 32-bit floats, handed over as the host's /shape command does.
//
// `-A` is a control with a SIGNAL on it: `file` is one value per frame, in real units, raw 32-bit
// floats. The run is then rendered a sample at a time with that control set from the file at
// every sample, which is what PoptartDevice does while audio is patched onto a control (see
// kPatchPiece there) - so the browser's processor, handed the same values as a block-long
// array, should come out the same.
//
// A device that asks for work off the audio thread (pd-device.h's work calls) has the whole round
// done in place, before the block that asked: what the server does over a few blocks, this does
// at once, so the run is the one the device would play once its work had landed.
//
// `-R file` writes what the device reports (pd_report) at the end of the run, as raw floats.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "pd-device.h"

namespace {

struct Note { int frame; float note; float velocity; };
struct Loaded {
  int param; int slot; double rate; int channels; int frameLength;
  std::vector<float> frames; std::vector<float> mono;
};
struct Drawn { int param; int slot; std::vector<float> table; };
struct Moving { int param; std::vector<float> values; };

/** Every float in a file, which is how the harness is handed a sample. */
std::vector<float> readFloats(const char* path) {
  std::vector<float> out;
  FILE* file = std::fopen(path, "rb");
  if (!file) return out;
  float one = 0;
  while (std::fread(&one, sizeof(float), 1, file) == 1) out.push_back(one);
  std::fclose(file);
  return out;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 5) {
    std::fprintf(stderr, "usage: harness <device> <sampleRate> <frames> <blockSize> [bpm] [-n frame:note:vel ...]\n");
    return 2;
  }
  const char* name = argv[1];
  const double sampleRate = std::atof(argv[2]);
  const int frames = std::atoi(argv[3]);
  const int blockSize = std::atoi(argv[4]);
  const double bpm = argc > 5 && argv[5][0] != '-' ? std::atof(argv[5]) : 120.0;

  std::vector<Note> notes;
  std::vector<Loaded> samples;
  std::vector<Drawn> shapes;
  std::vector<Moving> moving;
  const char* reportFile = nullptr;
  int keyPatched = -1;
  for (int i = 5; i < argc; ++i) {
    if (std::strcmp(argv[i], "-S") == 0 && i + 1 < argc) {
      int param = 0, slot = 0, channels = 1, frameLength = 0;
      double rate = 48000;
      char file[1024] = { 0 };
      if (std::sscanf(argv[++i], "%d:%d:%lf:%d:%d:%1023s", &param, &slot, &rate, &channels, &frameLength, file) == 6) {
        Loaded one{ param, slot, rate, channels < 1 ? 1 : channels, frameLength, readFloats(file), {} };
        if (one.frames.empty()) {
          std::fprintf(stderr, "harness: %s has no samples in it\n", file);
          return 1;
        }
        const int count = (int)(one.frames.size() / (size_t)one.channels);
        one.mono.resize((size_t)count);
        pd_mono_sum(one.frames.data(), count, one.channels, one.mono.data());
        samples.push_back(std::move(one));
      }
      continue;
    }
    if (std::strcmp(argv[i], "-H") == 0 && i + 1 < argc) {
      int param = 0, slot = 0;
      char file[1024] = { 0 };
      if (std::sscanf(argv[++i], "%d:%d:%1023s", &param, &slot, file) == 3) {
        Drawn one{ param, slot, readFloats(file) };
        if (one.table.empty()) {
          std::fprintf(stderr, "harness: %s has no points in it\n", file);
          return 1;
        }
        shapes.push_back(std::move(one));
      }
      continue;
    }
    if (std::strcmp(argv[i], "-A") == 0 && i + 1 < argc) {
      int param = 0;
      char file[1024] = { 0 };
      if (std::sscanf(argv[++i], "%d:%1023s", &param, file) == 2) {
        Moving one{ param, readFloats(file) };
        if (one.values.empty()) {
          std::fprintf(stderr, "harness: %s has no values in it\n", file);
          return 1;
        }
        moving.push_back(std::move(one));
      }
      continue;
    }
    if (std::strcmp(argv[i], "-R") == 0 && i + 1 < argc) {
      reportFile = argv[++i];
      continue;
    }
    if (std::strcmp(argv[i], "-k") == 0 && i + 1 < argc) {
      keyPatched = std::atoi(argv[++i]);
      continue;
    }
    if (std::strcmp(argv[i], "-n") != 0 || i + 1 >= argc) continue;
    int frame = 0;
    float note = 60, velocity = 1;
    std::sscanf(argv[++i], "%d:%f:%f", &frame, &note, &velocity);
    notes.push_back({ frame, note, velocity });
  }

  const PdDeviceInfo* info = pd_find_device(name);
  if (!info) {
    std::fprintf(stderr, "harness: no device called %s\n", name);
    return 1;
  }
  PdAny* device = info->make();
  device->init(sampleRate);
  for (const Loaded& one : samples) {
    const int count = (int)one.mono.size();
    PdSample file{ one.mono.data(), one.channels > 1 ? one.frames.data() : one.mono.data(), count,
                   one.channels, one.rate, one.frameLength };
    device->sample(one.param, one.slot, file);
  }
  for (const Drawn& one : shapes) device->shape(one.param, one.slot, one.table.data(), (int)one.table.size());

  std::vector<float> params(static_cast<size_t>(info->paramCount) + 1, 0.f);
  if (info->paramCount > 0
      && std::fread(params.data(), sizeof(float), static_cast<size_t>(info->paramCount), stdin)
          != static_cast<size_t>(info->paramCount)) {
    std::fprintf(stderr, "harness: %s wants %d parameters\n", name, info->paramCount);
    return 1;
  }
  // As many channels as the device asked for, interleaved: its own pair, and the key after it
  // for one that takes a sidechain.
  const int inChannels = device->inChannels();
  std::vector<float> input(static_cast<size_t>(frames) * inChannels, 0.f);
  std::fread(input.data(), sizeof(float), input.size(), stdin);

  std::vector<float> output(static_cast<size_t>(frames) * 2, 0.f);
  const int stride = device->maxBlock();
  float* devIn = device->in();
  float* devOut = device->out();
  float* devParams = device->params();
  const int count = device->paramCount() < info->paramCount ? device->paramCount() : info->paramCount;

  size_t nextNote = 0;
  // A control on a signal is rendered a sample at a time.
  const int piece = moving.empty() ? blockSize : 1;
  const bool offsets = device->takesNoteOffsets();
  int blockEnd = 0;
  for (int at = 0; at < frames;) {
    if (at >= blockEnd) blockEnd = at + piece;
    int until = blockEnd < frames ? blockEnd : frames;
    if (until - at > stride) until = at + stride;
    if (offsets) {
      // Every note in the piece, with its place in it: the device cuts its own block.
      while (nextNote < notes.size() && notes[nextNote].frame < until) {
        const Note& one = notes[nextNote++];
        const int offset = one.frame > at ? one.frame - at : 0;
        if (one.velocity > 0) device->noteOnAt(one.note, one.velocity, offset);
        else device->noteOffAt(one.note, offset);
      }
    } else {
      // The notes due on this frame, then a piece up to the next note or the end of the block.
      while (nextNote < notes.size() && notes[nextNote].frame <= at) {
        const Note& one = notes[nextNote++];
        if (one.velocity > 0) device->noteOn(one.note, one.velocity);
        else device->noteOff(one.note);
      }
      if (nextNote < notes.size() && notes[nextNote].frame < until) until = notes[nextNote].frame;
    }
    const int n = until - at;
    for (int i = 0; i < count; ++i) devParams[i] = params[static_cast<size_t>(i)];
    for (const Moving& one : moving) {
      if (one.param >= 0 && one.param < count) {
        devParams[one.param] = one.values[static_cast<size_t>(at) < one.values.size() ? static_cast<size_t>(at) : one.values.size() - 1];
      }
    }
    if (device->workWanted()) {
      device->work();
      device->workDone();
      device->workRelease();
    }
    device->transport(bpm, static_cast<double>(at) / sampleRate);
    device->keyPatched(keyPatched >= 0 ? keyPatched != 0 : inChannels >= 4);
    device->noteRoute(!notes.empty());
    for (int ch = 0; ch < inChannels; ++ch) {
      for (int i = 0; i < n; ++i) {
        devIn[ch * stride + i] = input[static_cast<size_t>(at + i) * inChannels + ch];
      }
    }
    device->process(n);
    for (int i = 0; i < n; ++i) {
      output[static_cast<size_t>(at + i) * 2] = devOut[i];
      output[static_cast<size_t>(at + i) * 2 + 1] = devOut[stride + i];
    }
    at += n;
  }
  std::fwrite(output.data(), sizeof(float), output.size(), stdout);
  if (reportFile) {
    std::vector<float> report(4096, 0.f);
    const int got = device->report(report.data(), (int)report.size());
    FILE* file = std::fopen(reportFile, "wb");
    if (file) {
      if (got > 0) std::fwrite(report.data(), sizeof(float), (size_t)got, file);
      std::fclose(file);
    }
  }
  delete device;
  return 0;
}
