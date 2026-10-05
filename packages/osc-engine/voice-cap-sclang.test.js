'use strict';

// The sampler's voice ceiling, and the server's pressure gauge (sc/poptart.scd).
//
// Every sample event is a NEW synth, which makes it the one thing in poptart that can allocate
// without limit - and what it spends is the server's real-time memory. Run that out and scsynth
// stops being able to create ANYTHING for the rest of the session: notes stop playing, plugins
// stop opening, and it does not recover, because nothing hands the memory back. A dense enough
// moment could take the engine down and keep it down. (It did: 2026-10-05, mid-set.)
//
// So the ceiling releases the OLDEST voice to make room, the way a hardware sampler does when you
// run it out of polyphony. The failure becomes "a moment that was too dense lost its tail" instead
// of "the drums stopped for the rest of the night" - which is the only version of this that is
// survivable live, and the reason it is worth a test rather than a comment.
//
// Like the other *-sclang tests: the closures are lifted out of the shipped poptart.scd, run in a
// real sclang, and skipped (not failed) where sclang cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SRC = fs.readFileSync(SCD, 'utf8');
const LANG_PORT = '57289'; // its own, like every sclang harness: only ten are tried from 57120 up

/**
 * A `name = { ... };` closure out of the shipped file. The single-line form is tried FIRST: the
 * multi-line pattern ends at the next line that is exactly `};`, which for a one-liner is the
 * close of whatever closure comes AFTER it - so it silently returns two closures and a stray
 * reference, and the harness then fails to compile with nothing to say about why.
 */
function extractClosure(name) {
  const oneLine = SRC.match(new RegExp(`^${name} = \\{.*\\};$`, 'm'));
  if (oneLine) return oneLine[0];
  const m = SRC.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find ${name} in sc/poptart.scd`);
  return m[0];
}

/**
 * Run the harness, or null when sclang never started - the welcome banner is the only reliable
 * sign, and a sandboxed sclang aborts before it (see the sclang-testing notes).
 */
function sclangSaid(script) {
  try {
    if (!fs.existsSync(resolveSclangPath())) return null;
  } catch {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-voicecap-'));
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let out;
  try {
    out = execFileSync(resolveSclangPath(), ['-u', LANG_PORT, file], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return /Welcome to SuperCollider/.test(out) ? out : null;
}

/**
 * The two closures over a ceiling of four, with seven voices to hand.
 *
 * The voices are real `Synth` objects on a Server whose ADDRESS just prints: an Event cannot stand
 * in for one here, because `.set` would hit the real Event:set primitive rather than the mock (see
 * the sclang-testing notes). Printing is how a gate-off becomes observable at all.
 */
function harness(body) {
  return `
{
var maxVoices = 4, liveVoices, voiceBorn, voiceDone, voiceCapSaidAt = 0;
var made, srv;
srv = Server(\\mockcap, NetAddr("127.0.0.1", 57998));
srv.addr = (addr: 1, isLocal: true, hostname: "127.0.0.1", ip: "127.0.0.1", port: 57998,
    sendMsg: { |self ...m| ("GATEOFF " ++ m.flatten.asArray[1]).postln }, know: true);
liveVoices = List.new;
made = (1..7).collect { |i| Synth.basicNew(\\x, srv, i) };
${extractClosure('voiceBorn')}
${extractClosure('voiceDone')}
${body}
}.try({ |e| ("HARNESS ERROR: " ++ e.errorString).postln });
0.exit;
`;
}

const SAY = (label, value) => `("${label}=" ++ (${value})).postln;`;
const LIVE = `${SAY('live', 'liveVoices.collect { |s| s.nodeID }.asArray')}`;

test('voices up to the ceiling all sound, and none is disturbed', (t) => {
  const out = sclangSaid(harness(`4.do { |i| voiceBorn.(made[i]) };\n${LIVE}`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.match(out, /live=\[1, 2, 3, 4\]/);
  assert.ok(!/GATEOFF/.test(out), 'a voice was released while there was still room for it');
});

test('past the ceiling the OLDEST voice is released, and only it', (t) => {
  const out = sclangSaid(harness(`
5.do { |i| voiceBorn.(made[i]) };
${LIVE}
`));
  if (out === null) return t.skip('no working SuperCollider here');
  const gated = out.match(/GATEOFF \d+/g) ?? [];
  assert.deepEqual(gated, ['GATEOFF 1'], 'the newest voice, or more than one, was taken instead');
  assert.match(out, /live=\[2, 3, 4, 5\]/, 'the ceiling has to hold at four, with the newest kept');
});

test('it keeps being the oldest, not whichever was taken first', (t) => {
  const out = sclangSaid(harness(`6.do { |i| voiceBorn.(made[i]) };\n${LIVE}`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.deepEqual(out.match(/GATEOFF \d+/g), ['GATEOFF 1', 'GATEOFF 2']);
  assert.match(out, /live=\[3, 4, 5, 6\]/);
});

test('a voice that ends on its own makes room without anything being stolen', (t) => {
  // The normal case, and by far the common one: voices come and go and the ceiling never binds.
  const out = sclangSaid(harness(`
4.do { |i| voiceBorn.(made[i]) };
voiceDone.(made[2]);
${SAY('afterDone', 'liveVoices.size')}
voiceBorn.(made[4]);
${LIVE}
`));
  if (out === null) return t.skip('no working SuperCollider here');
  assert.match(out, /afterDone=3/);
  assert.ok(!/GATEOFF/.test(out), 'a voice was released even though one had just ended');
  assert.match(out, /live=\[1, 2, 4, 5\]/);
});

test('the ceiling is a guard on the server, not a musical limit', () => {
  const m = SRC.match(/var maxVoices = (\d+)/);
  assert.ok(m, 'maxVoices is gone from poptart.scd');
  const cap = Number(m[1]);
  // Far above any musical number: at a few KB of real-time memory apiece this is single-digit
  // megabytes of the 256 the server is given. A cap low enough to shape a pattern would be a
  // different feature, and a worse one.
  assert.ok(cap >= 256, `${cap} voices is low enough to be heard as a limit`);
  // ...and comfortably inside the node table, which the voices share with everything else.
  const nodes = Number(SRC.match(/server\.options\.maxNodes = (\d+);/)[1]);
  assert.ok(cap < nodes / 2, `${cap} voices against a ${nodes}-node table leaves nothing for tracks`);
});

test('hitting the ceiling is reported, but not once per voice', () => {
  const fn = extractClosure('voiceBorn');
  assert.match(fn, /voiceCapSaidAt/, 'at the ceiling this happens as often as notes do');
  assert.match(fn, /> 10/, 'throttled to a line every ten seconds, not every voice');
  assert.match(fn, /\.warn/, 'and it has to be said at all - a pattern that dense is worth knowing about');
});

// --- the gauge ---------------------------------------------------------------------------------
//
// Real-time memory is not reported by scsynth at all, so the node table is the readable proxy: the
// things that consume the memory are nodes, and the two ceilings sit at comparable heights. Asked
// for, because nothing asked before and the only sign of a server filling up was it failing.

test('the server is asked what it is holding, on a timer', () => {
  assert.match(SRC, /server\.sendMsg\("\/status"\)/, 'nothing polls the server any more');
  assert.match(SRC, /OSCdef\(\\poptartStatusReply/, 'and nothing reads the answer');
});

test('the warning has hysteresis, so a figure resting on the line does not repeat', () => {
  const at = SRC.indexOf('OSCdef(\\poptartStatusReply');
  const body = SRC.slice(at, SRC.indexOf("}, '/status.reply'", at));
  const high = body.match(/limit \* ([\d.]+)\)\) \{/);
  const low = body.match(/limit \* ([\d.]+)\)\) \{ statusNodesHigh = false/);
  assert.ok(high && low, 'both thresholds have to be there');
  assert.ok(Number(low[1]) < Number(high[1]),
    'the re-arm threshold must be BELOW the warn threshold, or it warns on every poll');
  assert.match(body, /statusNodesHigh = true/);
});

test('the warning says what to do, because there is only one thing to do', () => {
  const at = SRC.indexOf('OSCdef(\\poptartStatusReply');
  const body = SRC.slice(at, SRC.indexOf("}, '/status.reply'", at));
  assert.match(body, /cannot recover without an engine restart/,
    'the point of warning early is that the late answer is a restart');
  assert.match(body, /liveVoices\.size/, 'the voice count is half of why it is filling up');
});
