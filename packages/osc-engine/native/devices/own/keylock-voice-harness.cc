// The sampler stretch's parity harness: a file through own/dsp/keylock.h's KeylockVoice, block by
// block. Built and run by osc-engine's native-device-parity.test.mjs, which plays the same file
// through web-engine/src/dsp/keylock.mjs's KeylockVoice and compares the two. Not shipped: this
// has a main().
//
//   keylock-voice-harness <sampleRate> <channels> <fileFrames> <bufRateScale> <script>
//
// stdin: the file as interleaved little-endian floats. <script> is a text file, one block per
// line: `<frames> <pitch> <start> <pos> <rate> <loop> <lo> <hi> <pingpong>` - with start 1 the
// voice starts (at pos, rate, and the loop given) before the block. stdout: the output as
// interleaved floats.

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "own/dsp/keylock.h"

int main(int argc, char** argv) {
  if (argc < 6) {
    std::fprintf(stderr, "usage: keylock-voice-harness <sampleRate> <channels> <fileFrames> <bufRateScale> <script>\n");
    return 2;
  }
  const double sampleRate = std::atof(argv[1]);
  const int channels = std::atoi(argv[2]);
  const long long fileFrames = std::atoll(argv[3]);
  const double brs = std::atof(argv[4]);
  std::vector<float> file((size_t)fileFrames * channels);
  if (std::fread(file.data(), sizeof(float), file.size(), stdin) != file.size()) {
    std::fprintf(stderr, "short file on stdin\n");
    return 1;
  }
  FILE* script = std::fopen(argv[5], "r");
  if (!script) {
    std::fprintf(stderr, "no script %s\n", argv[5]);
    return 1;
  }
  pd_own::KeylockVoice voice(sampleRate, channels);
  voice.setSource(file.data(), fileFrames, channels, 1, brs);
  std::vector<double> buf;
  std::vector<float> inter;
  int frames, start, loop, pingpong;
  double pitch, pos, rate, lo, hi;
  while (std::fscanf(script, "%d %lf %d %lf %lf %d %lf %lf %d", &frames, &pitch, &start, &pos, &rate, &loop, &lo, &hi, &pingpong) == 9) {
    if (start) voice.start(pos, rate, loop != 0, lo, hi, pingpong != 0);
    buf.assign((size_t)frames * channels, 0.0);
    double* rows[2] = { buf.data(), buf.data() + (channels > 1 ? frames : 0) };
    voice.process(rows, frames, pitch);
    inter.resize((size_t)frames * channels);
    for (int s = 0; s < frames; s++)
      for (int c = 0; c < channels; c++) inter[(size_t)s * channels + c] = (float)rows[c][s];
    std::fwrite(inter.data(), sizeof(float), inter.size(), stdout);
  }
  std::fclose(script);
  return 0;
}
