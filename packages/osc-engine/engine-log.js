'use strict';

// A file copy of everything the engine says.
//
// sclang's output is the only place a plugin scan, a boot failure or a dying scsynth explains
// itself, and until now it existed solely as scrollback in whatever terminal started poptart.
// Diagnosing one scan crash took an afternoon of copied-and-pasted scrollback, and a user running
// the desktop app has no terminal at all - the output went to a pipe nobody was reading from.
//
// So it is written down: ~/.poptart/engine.log for this run, engine.log.1 for the previous one
// (rotated at boot, because the interesting run is usually the one that just died). Writes are
// synchronous and unbuffered - the whole point is the last few lines before a crash, and those
// are exactly what a buffered stream loses.

const fs = require('node:fs');
const path = require('node:path');
const { poptartHome } = require('./home');

const MAX_BYTES = 8 * 1024 * 1024;

function engineLogPath({ dir = poptartHome() } = {}) {
  return path.join(dir, 'engine.log');
}

// Never throws: a read-only home, a full disk or a missing directory must not stop the engine
// from booting. A log that couldn't be opened just writes nowhere.
function openEngineLog({ file = engineLogPath(), maxBytes = MAX_BYTES, fsImpl = fs } = {}) {
  let fd = null;
  let written = 0;
  let capped = false;
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fsImpl.renameSync(file, `${file}.1`);
    } catch {
      /* nothing to rotate */
    }
    fd = fsImpl.openSync(file, 'w');
  } catch {
    fd = null;
  }

  const write = (text) => {
    if (fd === null || capped) return;
    const chunk = String(text);
    try {
      if (written + chunk.length > maxBytes) {
        capped = true;
        fsImpl.writeSync(fd, '\n[poptart] log size limit reached - no more engine output is being recorded.\n');
        return;
      }
      fsImpl.writeSync(fd, chunk);
      written += chunk.length;
    } catch {
      fd = null; // the disk went away mid-run; stop trying
    }
  };

  // Timestamped one-liners for poptart's own narration - a restart and its reason, a scan
  // starting and ending. They interleave with sclang's output, which is the point: the question
  // being answered is always "what happened just before that".
  const note = (text) => write(`[${new Date().toISOString()}] ${text}\n`);

  const close = () => {
    if (fd === null) return;
    try {
      fsImpl.closeSync(fd);
    } catch {
      /* already gone */
    }
    fd = null;
  };

  return { write, note, close, path: fd === null ? null : file };
}

// Last `lines` lines of a log file, for doctor.js and for the error a failed boot reports.
function tailEngineLog({ file = engineLogPath(), lines = 200, maxBytes = 256 * 1024, fsImpl = fs } = {}) {
  try {
    const { size } = fsImpl.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const fd = fsImpl.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, maxBytes));
      fsImpl.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8');
      return text.split('\n').slice(-lines).join('\n');
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch {
    return '';
  }
}

module.exports = { engineLogPath, openEngineLog, tailEngineLog, MAX_BYTES };
