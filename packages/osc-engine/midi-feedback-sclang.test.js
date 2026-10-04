'use strict';

// The desk's talk-back port in sc/poptart.scd: the destination it opens, and the batched short
// messages it writes to a control surface (its level meters, the lamps in its pads).
//
// Two things are checked here, and the first one is not about this feature at all: poptart.scd is
// loaded once at engine start and never again, so a syntax error anywhere in it fails SILENTLY
// in the middle of a session - the engine simply comes up without whatever came after the error.
// Nothing guarded that until now. compileFile parses the shipped file without running a line of
// it, which is the cheapest possible version of that guard.
//
// Then the decoding: the messages arrive as a FLAT list of quadruples, and walking it by fours is
// exactly the kind of arithmetic that is wrong by one for a year without anybody noticing,
// because a meter that is a little off still looks like a meter.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const LANG_PORT = '57199'; // its own, like every sclang harness: only ten are tried from 57120 up

/** The body of one OSCdef, lifted whole out of the shipped file. */
function extractOSCdef(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^OSCdef\\(\\\\${name}, \\{ \\|msg\\|\\n([\\s\\S]*?)^\\}, '/poptart/[a-zA-Z]+'\\);$`, 'm'));
  assert.ok(m, `could not find the ${name} OSCdef in sc/poptart.scd`);
  return m[1];
}

function runSclang(dir, script) {
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the shipped engine file parses - a syntax error in it is a silent half-started engine', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-scdparse-'));
  const out = runSclang(dir, `(
// compileFile parses and compiles the file into a function WITHOUT evaluating it: no server, no
// MIDI, nothing started. A parse error prints and answers nil.
var f = thisProcess.interpreter.compileFile(${JSON.stringify(SCD)});
("PARSED<" ++ f.notNil ++ ">").postln;
0.exit;
)
`);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  assert.match(out, /^PARSED<true>$/m, `sc/poptart.scd did not parse:\n${out}`);
});

test('the talk-back port writes each quadruple as the message it names', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-midifeedback-'));
  // The real handler, against a mock destination that prints what it was asked to send. `kind` 1
  // is a note and anything else a control change; values past the MIDI range are clipped rather
  // than wrapped, because a meter pinned at the top is right and one that wrapped to 0 is not.
  const out = runSclang(dir, `(
var feedbackOut, handler, sent = List.new;
feedbackOut = (
    noteOn: { |self, chan, num, val| sent.add("note " ++ chan ++ " " ++ num ++ " " ++ val) },
    control: { |self, chan, num, val| sent.add("cc " ++ chan ++ " " ++ num ++ " " ++ val) }
);
handler = { |msg|
${extractOSCdef('poptartMidiOut')}
};
// Two decks' meters and two lamps, in one message, with the address in front as OSC delivers it.
handler.(['/poptart/midiOut', 0, 0, 2, 100, 0, 1, 2, 64, 1, 0, 17, 127, 1, 0, 18, 0]);
sent.do { |s| ("SENT<" ++ s ++ ">").postln };
sent = List.new;
handler.(['/poptart/midiOut', 0, 0, 200, 999, 1, 0, 11, -5]);
sent.do { |s| ("CLIP<" ++ s ++ ">").postln };
// Nothing chosen: the desk writes on every frame whether or not a port is open, so this has to
// be a no-op rather than an error that takes the OSC listener down.
feedbackOut = nil;
handler.(['/poptart/midiOut', 0, 0, 2, 100]);
"QUIET-OK".postln;
0.exit;
)
`);
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  const sent = [...out.matchAll(/^SENT<(.+)>$/gm)].map((m) => m[1]);
  assert.deepEqual(sent, ['cc 0 2 100', 'cc 1 2 64', 'note 0 17 127', 'note 0 18 0'],
    `the batch was not decoded as four messages:\n${out}`);
  const clipped = [...out.matchAll(/^CLIP<(.+)>$/gm)].map((m) => m[1]);
  assert.deepEqual(clipped, ['cc 0 127 127', 'note 0 11 0'], 'out-of-range values should clip');
  assert.match(out, /^QUIET-OK$/m, 'with no port open it should do nothing at all');
});
