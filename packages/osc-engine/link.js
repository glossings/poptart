'use strict';

// poptart's membership of an Ableton Link session, as seen from Node.
//
// The session peer itself is a helper process (native/link/poptart-link, built by its build.sh
// and committed like the keylock UGen): the Link SDK is C++, and the one thing poptart needs
// that no SuperCollider binding offers is SETTING the session's play state - sclang's LinkClock
// can read a DAW's play state but never start one. The helper speaks line-delimited JSON over
// stdio and holds no opinions; what to follow and what to push is the host's business (see
// web-app's server.js and link-sync.js).
//
// The helper exits when its stdin closes, so a Node that dies without calling stop() leaves no
// orphan behind - unlike the Bonjour announcer, this needs no pidfile entry.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HELPER = path.join(__dirname, 'native', 'link', 'bin', 'poptart-link');

/**
 * Is there a Link helper for this platform? (Only macOS is built so far.)
 *
 * The platform check is not redundant with the file check: the helper is committed, so the
 * macOS binary is sitting on disk in every checkout, Windows and Linux included. Without it the
 * settings tab offers Link there and the toggle fails trying to run a Mach-O executable. Same
 * shape as audio-devices.js's helperAvailable().
 */
function helperAvailable(helper = HELPER) {
  try {
    return process.platform === 'darwin' && fs.statSync(helper).isFile();
  } catch {
    return false;
  }
}

/**
 * Join the Link session. Returns a handle:
 *
 *   onState      - set it to a function; called with { bpm, beats, atSec, peers, playing } on
 *                  every tempo, peer-count and play-state change, and twice a second regardless.
 *                  `beats` is the session's beat count at `atSec` (unix seconds, the same clock
 *                  the engine's getTime() reads), so a reader extrapolates at `bpm` between them.
 *   setTempo     - push a tempo into the session (every peer follows).
 *   setPlaying   - push the session's play state. `beat` (optional) asks Link to put this peer at
 *                  that beat as it happens, which is how a start lands on the session's bar
 *                  instead of wherever the session had got to.
 *   stop         - leave the session and reap the helper.
 *
 * `onError` is called with an Error if the helper can't be started or dies unexpectedly; the
 * handle then does nothing rather than throwing at the caller's next gesture.
 */
function joinLink({ helper = HELPER, spawnFn = spawn, onError = null, quantum = 4 } = {}) {
  const handle = {
    onState: null,
    setTempo(bpm) {
      send({ tempo: bpm });
    },
    setPlaying(playing, beat = null) {
      send(beat == null ? { playing: !!playing } : { playing: !!playing, beat });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        proc.stdin.end();
        proc.kill('SIGTERM');
      } catch { /* already gone */ }
    },
  };

  let stopped = false;
  let proc;
  try {
    proc = spawnFn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    onError?.(err);
    return { ...handle, stop() {}, setTempo() {}, setPlaying() {} };
  }

  function send(obj) {
    if (stopped || !proc.stdin?.writable) return;
    try {
      proc.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch { /* the helper died; its exit handler reports it */ }
  }

  // Line-buffered: a state line is small and stdio hands them over whole in practice, but a
  // partial read must never be parsed as a truncated number.
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let state;
      try {
        state = JSON.parse(line);
      } catch {
        continue; // not ours (a warning on stdout from some future SDK) - skip the line
      }
      if (typeof state?.bpm !== 'number') continue;
      handle.onState?.({
        bpm: state.bpm,
        beats: state.beats,
        atSec: state.at,
        peers: state.peers | 0,
        playing: !!state.playing,
      });
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (text) => {
    const trimmed = String(text).trim();
    // eslint-disable-next-line no-console
    if (trimmed) console.warn(`[poptart] link: ${trimmed}`);
  });
  proc.on('error', (err) => {
    if (!stopped) onError?.(err);
  });
  proc.on('exit', (code, signal) => {
    if (!stopped) onError?.(new Error(`the Link helper exited (${signal ?? code})`));
    stopped = true;
  });

  send({ quantum });
  return handle;
}

module.exports = { joinLink, helperAvailable, HELPER };
