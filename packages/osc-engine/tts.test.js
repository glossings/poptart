'use strict';

// say() renders text to a cached WAV with macOS's `say` (see tts.js). These tests stand a fake
// `say` in for the real one - it writes a file of the size a word would be, or fails the way an
// unknown voice does - so they run anywhere and never touch the audio system.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-speech-'));
const BIN = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-fake-say-')), 'say');
const LOG = `${BIN}.log`;
// Logs its arguments and stdin, fails for the voice "Nobody", and otherwise writes 8KB to -o.
fs.writeFileSync(
  BIN,
  `#!/bin/sh
out=""; voice=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift;; -v) voice="$2"; shift;; esac
  shift
done
if [ "$voice" = "?" ]; then printf 'Whisper             en_US    # Hello\\nBad News            en_US    # Hello\\n'; exit 0; fi
text=$(cat)
echo "$voice|$text" >> "${LOG}"
if [ "$voice" = "Nobody" ]; then echo "Voice \\\`Nobody' not found." >&2; exit 1; fi
if [ "$voice" = "Mute" ]; then head -c 4096 /dev/zero > "$out"; exit 0; fi
head -c 8192 /dev/zero > "$out"
`,
  { mode: 0o755 },
);
process.env.POPTART_SPEECH_DIR = DIR;
process.env.POPTART_SAY_BIN = BIN;

const { parseSpeech, speechFile, cachedSpeech, renderSpeech } = require('./tts.js');
const renders = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : []);

const US = '\u001f'; // between a voice and its text in a ref's value (pattern-core's SAY_VOICE_SEP)

test('a voice comes before the separator, and none is the default voice', () => {
  assert.deepStrictEqual(parseSpeech(`Whisper${US}hello`), { voice: 'Whisper', text: 'hello' });
  assert.deepStrictEqual(parseSpeech('hello there'), { voice: null, text: 'hello there' });
  assert.deepStrictEqual(parseSpeech(`Bad News${US}a:b`), { voice: 'Bad News', text: 'a:b' });
  assert.deepStrictEqual(parseSpeech(`${US}hi`), { voice: null, text: 'hi' });
  // A colon is text: "3:30" is a time, not a voice called 3.
  assert.deepStrictEqual(parseSpeech('3:30'), { voice: null, text: '3:30' });
});

test('one file per voice and text, named so it reads at a glance', () => {
  assert.notStrictEqual(speechFile('Whisper', 'hi'), speechFile(null, 'hi'));
  assert.notStrictEqual(speechFile('Whisper', 'hi'), speechFile('Whisper', 'hi!'));
  assert.match(path.basename(speechFile('Whisper', 'hello there')), /^Whisper-hello-there-[0-9a-f]{10}\.wav$/);
});

test('renders once, through stdin, and serves the cache after', async () => {
  assert.strictEqual(cachedSpeech(`Whisper${US}-v Zarvox`), null);
  const [a, b] = await Promise.all([renderSpeech(`Whisper${US}-v Zarvox`), renderSpeech(`Whisper${US}-v Zarvox`)]);
  assert.strictEqual(a, b);
  assert.strictEqual(cachedSpeech(`Whisper${US}-v Zarvox`), a);
  await renderSpeech(`Whisper${US}-v Zarvox`);
  // Rendered once for three asks; the text that looks like a flag arrived as text.
  assert.deepStrictEqual(renders().filter((l) => l.includes('Zarvox')), ['Whisper|-v Zarvox']);
  assert.deepStrictEqual(fs.readdirSync(DIR).filter((f) => f.includes('.part-')), []);
});

test('an unknown voice, or a render with no audio in it, fails and leaves nothing behind', async () => {
  await assert.rejects(renderSpeech(`Nobody${US}hi`), /Nobody' not found/);
  await assert.rejects(renderSpeech(`Mute${US}hi`), /no audio came back for voice "Mute"/);
  assert.strictEqual(cachedSpeech(`Mute${US}hi`), null);
  assert.deepStrictEqual(fs.readdirSync(DIR).filter((f) => f.includes('Nobody') || f.includes('Mute')), []);
});

test('the engine resolves a rendered phrase like any one-file source, and waits for one that is not', async () => {
  const { OscEngine } = require('./index.js');
  const engine = new OscEngine({ sclangPath: '/usr/bin/false' });
  const pending = engine._resolveSource(`say:Bells${US}fresh`);
  assert.strictEqual(pending.paths, null);
  const [file] = await pending.render;
  assert.deepStrictEqual(engine._resolveSource(`say:Bells${US}fresh`).paths, [file]);
  assert.strictEqual(engine._resolveSource(`say:Bells${US}fresh`).render, undefined);
});

test('an installed voice is known by name, any case; anything else is not', async () => {
  const { voiceInstalled } = require('./tts.js');
  assert.strictEqual(await voiceInstalled('whisper'), true);
  assert.strictEqual(await voiceInstalled('Bad News'), true);
  assert.strictEqual(await voiceInstalled('Wisper'), false);
  assert.strictEqual(await voiceInstalled(null), true);
});
