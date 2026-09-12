// poptart-link - poptart's Ableton Link peer, as a helper process.
//
// Link shares tempo, bar phase and play state between applications on a local network. This is a
// small program around the Link SDK that speaks line-delimited JSON over stdio, so Node owns the
// musical decisions (what to follow, what to push) and this side owns nothing but the protocol.
// It exists because the alternative - sclang's built-in LinkClock - can read the session's play
// state but has no way to SET it, so a poptart start could never start a DAW.
//
// Commands, one JSON object per line on stdin. Unknown keys are ignored, so a newer Node can
// talk to an older helper without a handshake:
//
//   {"tempo":128.5}                  set the session tempo (every peer follows)
//   {"playing":true}                 set the session's play state (start/stop sync)
//   {"playing":true,"beat":0}        ...and ask to be at that beat when it happens
//   {"quantum":4}                    beats per bar, for the phase the state lines report
//   {"quit":1}                       leave the session and exit
//
// State lines, one JSON object per line on stdout - on every tempo, peer-count and play-state
// change, and as a heartbeat twice a second:
//
//   {"bpm":128,"beats":41.5,"peers":2,"playing":true,"at":1757000000.123456}
//
// `beats` is the session's beat count at `at`, which is a unix timestamp in seconds sampled from
// the same instant - Link's own clock is a monotonic one with no relation to wall time, and Node
// reads the transport in unix seconds. Between lines Node extrapolates at `bpm`.

#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

#include <ableton/Link.hpp>

namespace {

constexpr double kDefaultTempo = 120.0;
constexpr auto kHeartbeat = std::chrono::milliseconds(500);

std::atomic<double> gQuantum{4.0};
std::atomic<bool> gRunning{true};
std::mutex gOutMutex;

// Both clocks read at the same instant: Link's monotonic one (what its session state is indexed
// by) and the wall clock (what Node's transport runs on).
struct Now {
  std::chrono::microseconds link;
  double wall; // (not `unix`: GNU-mode compilers predefine that as a macro)
};

Now now(ableton::Link& link) {
  const auto l = link.clock().micros();
  const auto u = std::chrono::system_clock::now().time_since_epoch();
  return {l, std::chrono::duration<double>(u).count()};
}

void emit(ableton::Link& link) {
  const auto t = now(link);
  const auto state = link.captureAppSessionState();
  const double quantum = gQuantum.load();
  char line[256];
  std::snprintf(line, sizeof(line),
    "{\"bpm\":%.6f,\"beats\":%.6f,\"peers\":%zu,\"playing\":%s,\"at\":%.6f}\n",
    state.tempo(), state.beatAtTime(t.link, quantum), link.numPeers(),
    state.isPlaying() ? "true" : "false", t.wall);
  std::lock_guard<std::mutex> lock(gOutMutex);
  std::fputs(line, stdout);
  std::fflush(stdout);
}

// A deliberately small JSON reader: every value poptart sends is a number or a bool at the top
// level of a flat object, so a real parser would be a dependency bought for nothing. Returns
// false when the key is absent; a malformed value reads as absent.
bool number(const std::string& line, const char* key, double& out) {
  const std::string needle = std::string("\"") + key + "\"";
  auto at = line.find(needle);
  if (at == std::string::npos) return false;
  at = line.find(':', at + needle.size());
  if (at == std::string::npos) return false;
  const char* start = line.c_str() + at + 1;
  char* end = nullptr;
  const double v = std::strtod(start, &end);
  if (end == start) return false;
  out = v;
  return true;
}

bool boolean(const std::string& line, const char* key, bool& out) {
  const std::string needle = std::string("\"") + key + "\"";
  auto at = line.find(needle);
  if (at == std::string::npos) return false;
  at = line.find(':', at + needle.size());
  if (at == std::string::npos) return false;
  while (at + 1 < line.size() && std::isspace(static_cast<unsigned char>(line[at + 1]))) ++at;
  if (line.compare(at + 1, 4, "true") == 0) { out = true; return true; }
  if (line.compare(at + 1, 5, "false") == 0) { out = false; return true; }
  double n = 0;
  if (!number(line, key, n)) return false;
  out = n != 0;
  return true;
}

void apply(ableton::Link& link, const std::string& line) {
  double n = 0;
  bool b = false;
  if (number(line, "quit", n) && n != 0) {
    gRunning = false;
    return;
  }
  if (number(line, "quantum", n) && n > 0) gQuantum = n;

  const bool hasTempo = number(line, "tempo", n) && n > 0;
  const double tempo = hasTempo ? n : 0;
  double beat = 0;
  const bool hasBeat = number(line, "beat", beat);
  const bool hasPlaying = boolean(line, "playing", b);
  if (!hasTempo && !hasPlaying) return;

  const auto t = now(link);
  auto state = link.captureAppSessionState();
  if (hasTempo) state.setTempo(tempo, t.link);
  if (hasPlaying) {
    // Asking for a beat as well is how a start lands on the session's bar rather than wherever
    // the session happens to be: Link moves the timeline so this peer is at `beat` when the
    // transport starts, and the other peers' phase is preserved.
    if (hasBeat) state.setIsPlayingAndRequestBeatAtTime(b, t.link, beat, gQuantum.load());
    else state.setIsPlaying(b, t.link);
  }
  link.commitAppSessionState(state);
}

} // namespace

int main() {
  ableton::Link link(kDefaultTempo);
  link.enableStartStopSync(true);
  link.enable(true);

  link.setTempoCallback([&link](double) { emit(link); });
  link.setNumPeersCallback([&link](std::size_t) { emit(link); });
  link.setStartStopCallback([&link](bool) { emit(link); });

  // stdin on its own thread: the read blocks, and the heartbeat below must not wait on it. EOF
  // (Node closed the pipe, or died) ends the process - a Link peer outliving poptart would keep
  // answering for a session member that is not there.
  std::thread reader([&link] {
    std::string line;
    while (gRunning && std::getline(std::cin, line)) {
      apply(link, line);
      if (gRunning) emit(link);
    }
    gRunning = false;
  });
  reader.detach();

  while (gRunning) {
    emit(link);
    std::this_thread::sleep_for(kHeartbeat);
  }
  link.enable(false);
  return 0;
}
