'use strict';

// Speech as a sample source: say("hello world") plays each word as a file the system's text-to-speech
// rendered. The engine sees the ref "say:<value>", where a value is the text with an optional voice
// in front, and resolves it like any one-file source once it is on disk.
//
// The voice travels in front of the text, split off by a control character (see parseSpeech).
//
// Rendering is macOS's `say`, run once per (voice, text) and cached for good under
// ~/.poptart/cache/speech: a word costs one render the first time it is ever spoken and a file read
// after that. A render is async (a spawn, never spawnSync - it takes a few hundred milliseconds,
// which is a stall mid-set), so the first event of a word nobody has spoken before may be dropped,
// exactly as the first event of a pack still loading is.
//
// Plain filesystem and child-process work, no server and no engine, so tts.test.js drives it with a
// fake `say`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { poptartHome } = require('./home');

const SAY_BIN = '/usr/bin/say';
const RENDER_TIMEOUT_MS = 30000;
// What the file is written as: a WAV, so .slice() can analyze it, at a rate the sampler plays
// without a second resample. `say` resamples its voice's native rate (22050 for most) up to this.
const DATA_FORMAT = 'LEI16@44100';

function speechRoot() {
  if (process.env.POPTART_SPEECH_DIR) return process.env.POPTART_SPEECH_DIR;
  return path.join(poptartHome(), 'cache', 'speech');
}

/** Whether this machine can render speech at all - `say` is macOS's. */
function speechAvailable() {
  return process.platform === 'darwin' || !!process.env.POPTART_SAY_BIN;
}

// Between a step's voice and its text in a ref's value (pattern-core's SAY_VOICE_SEP): a control
// character, so nothing anybody types - "3:30", "note: this" - can be mistaken for a voice.
const VOICE_SEP = '\u001f';

/**
 * A ref's value as { voice, text }: "<voice><US><text>", or the text alone for the system's
 * default voice.
 */
function parseSpeech(value) {
  const s = String(value ?? '');
  const at = s.indexOf(VOICE_SEP);
  if (at < 0) return { voice: null, text: s.trim() };
  const voice = s.slice(0, at).trim();
  return { voice: voice || null, text: s.slice(at + 1).trim() };
}

/** Where one (voice, text) lives once rendered: readable at a glance, unique by hash. */
function speechFile(voice, text) {
  const hash = crypto.createHash('sha1').update(`${voice ?? ''}\0${text}`).digest('hex').slice(0, 10);
  const slug = `${voice ?? 'default'}-${text}`
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return path.join(speechRoot(), `${slug || 'speech'}-${hash}.wav`);
}

/** The rendered file for a ref value, or null when it has not been rendered (yet). */
function cachedSpeech(value) {
  const { voice, text } = parseSpeech(value);
  if (!text) return null;
  const file = speechFile(voice, text);
  return fs.existsSync(file) ? file : null;
}

// One render per file at a time: every event of a word nobody has heard yet asks for it, and the
// eval-time warm-up asks too.
const inFlight = new Map();

/**
 * Renders a ref value to its file, resolving with the path. Resolves at once when it is already on
 * disk. The text goes in on stdin, so a word starting with "-" is never read as a flag. Written to
 * a temporary name and renamed, so a killed render never leaves a half-file that looks finished.
 */
function renderSpeech(value) {
  const { voice, text } = parseSpeech(value);
  if (!text) return Promise.reject(new Error('nothing to say'));
  if (!speechAvailable()) return Promise.reject(new Error('speech needs macOS (it uses the system voices)'));
  const file = speechFile(voice, text);
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (inFlight.has(file)) return inFlight.get(file);

  const job = new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file.slice(0, -4)}.part-${process.pid}.wav`; // `say` picks the format from the extension
    const args = [...(voice ? ['-v', voice] : []), '-o', tmp, `--data-format=${DATA_FORMAT}`];
    const child = spawn(process.env.POPTART_SAY_BIN || SAY_BIN, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), RENDER_TIMEOUT_MS);
    const fail = (message) => {
      fs.rmSync(tmp, { force: true });
      reject(new Error(message));
    };
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(err.message);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // `say` with an unknown voice prints "Voice `x' not found." and exits 1. One that renders
      // nothing at all (no audio session, a sandbox) still writes a bare header, so an empty file
      // is a failure too rather than a silent sample.
      if (code !== 0) return fail(stderr.trim() || `say exited with ${code}`);
      let size = 0;
      try {
        size = fs.statSync(tmp).size;
      } catch {
        // missing - handled below
      }
      if (size <= 4096) return fail(`no audio came back${voice ? ` for voice "${voice}"` : ''}`);
      fs.renameSync(tmp, file);
      resolve(file);
    });
    child.stdin.end(text);
  }).finally(() => inFlight.delete(file));
  inFlight.set(file, job);
  return job;
}

// The voices installed, read once from `say -v '?'` (a line per voice: name, locale, "# sample").
// `say` given a name it doesn't know quietly speaks with the default voice instead, so this is
// the only way a misspelled voice gets noticed.
let voiceList = null;
function installedVoices() {
  if (!voiceList) {
    voiceList = new Promise((resolve) => {
      const child = spawn(process.env.POPTART_SAY_BIN || SAY_BIN, ['-v', '?'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const names = out
          .split('\n')
          .map((line) => /^(.+?)\s+[a-z]{2,3}_[A-Za-z0-9]+\s+#/.exec(line)?.[1].trim())
          .filter(Boolean);
        resolve(names.length ? new Set(names.map((n) => n.toLowerCase())) : null);
      });
    });
  }
  return voiceList;
}

/** False when `voice` is certainly not installed; true when it is, or when nobody can tell. */
async function voiceInstalled(voice) {
  if (!voice) return true;
  const names = await installedVoices();
  return !names || names.has(voice.toLowerCase());
}

module.exports = { speechRoot, speechAvailable, parseSpeech, speechFile, cachedSpeech, renderSpeech, voiceInstalled };
