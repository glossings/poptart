'use strict';

// Reaping engine processes that outlived the run that spawned them.
//
// The stack is sclang -> scsynth, and only sclang is our child: scsynth is spawned BY sclang, so
// node never holds a handle on it. That asymmetry is the whole problem. scsynth owns the audio
// device and UDP port 57110, and it survives every way sclang can die that isn't a clean
// `server.quit` - sclang being SIGKILLed after a slow shutdown, node crashing, the terminal being
// closed, or (the one that actually bites) scsynth wedging in CoreAudio when its audio device is
// yanked mid-session and never answering the quit at all. What's left holds 57110, and the next
// boot dies with "failed to open UDP socket: address in use" after opening the device - a failure
// whose only documented cure was telling the user to run `pkill -f scsynth` by hand.
//
// So: sclang reports scsynth's pid at /poptart/ready, we write both pids next to the settings, and
// the next engine start kills whatever is still alive from the last one. `pkill -f scsynth`, but
// aimed only at processes we started.
//
// Killing by remembered pid is only safe if the pid is still the process we remember - pids get
// recycled, and SIGKILLing a stranger is far worse than a port conflict. Every kill here is
// therefore gated on the pid's command name still being sclang or scsynth. A stale pidfile whose
// pids now belong to something else is a no-op, which is the correct outcome.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Beside settings.json, for the same reason it lives there: user-owned state that has to outlive
// the process, in a directory poptart already creates.
//
// Keyed by the stack's node port, because reaping is aimed BY pid file: two poptarts on different
// ports (a second session, a test run beside a live one) are separate stacks, and a shared file
// would have each of them kill the other's perfectly healthy engine on startup. The port is
// already what keeps those stacks apart everywhere else.
function pidfilePath(nodePort) {
  return process.env.POPTART_PIDFILE
    || path.join(os.homedir(), '.poptart', `engine-${nodePort}.pid`);
}

// Killing is done through a wrapper rather than passing `process.kill` itself: it is a method, and
// handing the bare reference around is the kind of thing that works until it doesn't.
const defaultKill = (pid, signal) => process.kill(pid, signal);

// The only command names we will ever kill. A remembered pid that now names anything else has
// been recycled and is somebody else's process.
const OURS = /^(sclang|scsynth|supernova)$/;

/**
 * The command of a running pid as `ps` reports it - the full path it was launched with - or null
 * when it isn't running (or can't be read).
 */
function commandName(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null; // no such process - ps exits non-zero
  }
}

/**
 * True when `pid` is alive AND still one of ours, i.e. safe to kill. The basename is taken here
 * rather than in commandName so the check holds whatever the name came from: this is the one
 * predicate standing between a stale pidfile and a SIGKILL, and it should not depend on its
 * caller having normalized the input.
 */
function isOurProcess(pid, { comm = commandName } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const name = comm(pid);
  return !!name && OURS.test(name.split('/').pop());
}

/**
 * Remember the pids of a booted stack, so a later run can clean up after this one if it doesn't
 * get to shut down properly. Best-effort: an unwritable home directory is not a reason to fail an
 * engine start.
 */
function recordEnginePids(pids, { file } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pids), 'utf8');
  } catch { /* best effort - see above */ }
}

/** Forget the recorded pids, after a shutdown that left nothing behind. */
function clearEnginePids({ file } = {}) {
  try {
    fs.rmSync(file, { force: true });
  } catch { /* best effort */ }
}

function readEnginePids({ file } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // no pidfile, or a corrupt one - nothing to reap either way
  }
}

/**
 * SIGKILL one remembered pid if it is still one of ours. Returns true if it killed something.
 *
 * SIGKILL rather than SIGTERM on purpose: everything reaching this function has already ignored
 * or outlived a polite request to quit (`/poptart/quit` to sclang, `/quit` to scsynth), and the
 * characteristic failure - a scsynth stuck in CoreAudio with a device that no longer exists - is
 * one a catchable signal doesn't reliably get it out of.
 */
function killIfOurs(pid, { comm = commandName, kill = defaultKill } = {}) {
  if (!isOurProcess(pid, { comm })) return false;
  try {
    kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false; // exited between the check and the kill, or not ours to signal
  }
}

/**
 * Kill anything still running from the previously recorded stack, and forget it. Called before
 * spawning a new sclang, which is the one moment nothing of ours should be running.
 *
 * scsynth goes first: it is the one holding the port and the device, and killing sclang first
 * would just leave it orphaned again for the length of this function.
 *
 * @returns {string[]} descriptions of what it killed, for logging - empty in the normal case.
 */
function reapOrphanedEngine({ file, comm = commandName, kill = defaultKill } = {}) {
  const pids = readEnginePids({ file });
  const killed = [];
  for (const name of ['scsynth', 'sclang']) {
    const pid = pids[name];
    if (pid != null && killIfOurs(pid, { comm, kill })) killed.push(`${name} (pid ${pid})`);
  }
  clearEnginePids({ file });
  return killed;
}

module.exports = {
  pidfilePath,
  commandName,
  isOurProcess,
  recordEnginePids,
  clearEnginePids,
  readEnginePids,
  killIfOurs,
  reapOrphanedEngine,
};
