// The keylock's parity harness: a song through own/dsp/keylock.h's KeylockPlayer, block by block.
//
// Built and run by osc-engine's native-device-parity.test.mjs, which plays the same song through
// web-engine/src/dsp/keylock.mjs and compares the two. Not shipped: this has a main().
//
//   keylock-harness <sampleRate> <channels> <fade> <songFrames> <bufRateScale> <script>
//
// stdin: the song as interleaved little-endian floats. <script> is a text file, one block per
// line: `<frames> <rate> <op> <pos>`, where op is 0 (none), 1 (start at pos) or 2 (seek to pos),
// applied before the block. stdout: the output as interleaved floats.

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "own/dsp/keylock.h"

int main(int argc, char** argv) {
  if (argc < 7) {
    std::fprintf(stderr, "usage: keylock-harness <sampleRate> <channels> <fade> <songFrames> <bufRateScale> <script>\n");
    return 2;
  }
  const double sampleRate = std::atof(argv[1]);
  const int channels = std::atoi(argv[2]);
  const int fade = std::atoi(argv[3]);
  const long long songFrames = std::atoll(argv[4]);
  const double brs = std::atof(argv[5]);
  std::vector<float> song((size_t)songFrames * channels);
  if (std::fread(song.data(), sizeof(float), song.size(), stdin) != song.size()) {
    std::fprintf(stderr, "short song on stdin\n");
    return 1;
  }
  FILE* script = std::fopen(argv[6], "r");
  if (!script) {
    std::fprintf(stderr, "no script %s\n", argv[6]);
    return 1;
  }
  pd_own::KeylockPlayer player(sampleRate, channels, fade);
  player.setSource(song.data(), songFrames, channels, 1, brs);
  std::vector<double> buf;
  std::vector<float> inter;
  int frames, op;
  double rate, pos;
  while (std::fscanf(script, "%d %lf %d %lf", &frames, &rate, &op, &pos) == 4) {
    if (op == 1) player.start(pos);
    else if (op == 2) player.seek(pos);
    buf.assign((size_t)frames * channels, 0.0);
    double* rows[2] = { buf.data(), buf.data() + (channels > 1 ? frames : 0) };
    player.process(rows, frames, rate);
    inter.resize((size_t)frames * channels);
    for (int s = 0; s < frames; s++)
      for (int c = 0; c < channels; c++) inter[(size_t)s * channels + c] = (float)rows[c][s];
    std::fwrite(inter.data(), sizeof(float), inter.size(), stdout);
  }
  std::fclose(script);
  return 0;
}
