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
//            [-S control:slot:rate:file ...]
//
// stdin, little-endian: the parameter values in REAL UNITS (the position-to-value conversion is
// pd_denormalize's job and is tested separately), then the input as interleaved stereo floats.
// stdout: the output as interleaved stereo floats. Notes come in on the command line, as
// `-n frame:note:velocity` for an instrument, and `-k 0` says that nothing is routed into the
// slot's key input (the default for a sidechained device is that something is).
//
// `-S` is a FILE for a device that plays one - a granulator's sample, a convolver's impulse
// response. `control` is its index in the device's own control list, `slot` the entry on that
// control's option list it is loaded into, and `file` is raw 32-bit floats, mono, at `rate` -
// which is the shape the host hands a device its frames in (see PoptartDevice.cpp's sample
// stages). The host owns that memory for as long as the device plays it, so these vectors
// outlive the run.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "pd-device.h"

namespace {

struct Note { int frame; float note; float velocity; };
struct Loaded { int param; int slot; double rate; std::vector<float> frames; };

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
  int keyPatched = -1;
  for (int i = 5; i < argc; ++i) {
    if (std::strcmp(argv[i], "-S") == 0 && i + 1 < argc) {
      int param = 0, slot = 0;
      double rate = 48000;
      char file[1024] = { 0 };
      if (std::sscanf(argv[++i], "%d:%d:%lf:%1023s", &param, &slot, &rate, file) == 4) {
        Loaded one{ param, slot, rate, readFloats(file) };
        if (one.frames.empty()) {
          std::fprintf(stderr, "harness: %s has no samples in it\n", file);
          return 1;
        }
        samples.push_back(std::move(one));
      }
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
    device->sample(one.param, one.slot, one.frames.data(), (int)one.frames.size(), one.rate);
  }

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
  for (int at = 0; at < frames; at += blockSize) {
    int n = frames - at;
    if (n > blockSize) n = blockSize;
    if (n > stride) n = stride;
    // Notes land on a block boundary, as they do on the engine: the host plays a note at the
    // start of the block its onset falls in.
    while (nextNote < notes.size() && notes[nextNote].frame < at + n) {
      const Note& one = notes[nextNote++];
      if (one.velocity > 0) device->noteOn(one.note, one.velocity);
      else device->noteOff(one.note);
    }
    for (int i = 0; i < count; ++i) devParams[i] = params[static_cast<size_t>(i)];
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
  }
  std::fwrite(output.data(), sizeof(float), output.size(), stdout);
  delete device;
  return 0;
}
