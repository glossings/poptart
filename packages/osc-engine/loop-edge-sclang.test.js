'use strict';

// Feedback between tracks (sc/poptart.scd's trackLevels and reorderTracks): two tracks reading each
// other, or one reading a bus it writes, have no order that runs every reader after its writer. One
// edge of each loop reads the block before - the edge that closes it, walking upstream from each
// track in the order the tracks were made, which is how the browser engine picks it too - and
// every other edge reads this block's audio. What is checked: which edge is chosen, that the choice
// follows creation order and not the tracks dictionary's, and - rendered - that the closing edge
// carries the signal a block late where an ordinary read would hear silence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SRC = fs.readFileSync(SCD, 'utf8');
const PORT = '57323';

function lift(name) {
  const m = SRC.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

function busreadDef() {
  const m = SRC.match(/^    SynthDef\(\\poptart_busread, \{[\s\S]*?\}\)\.add;$/m);
  assert.ok(m, 'could not find the poptart_busread def');
  return m[0].replace(/\.add;$/, '');
}

function runSclang(dir, body) {
  const file = path.join(dir, 'harness.scd');
  // The body opens with its own var declarations, which sclang takes only at the top of a block -
  // so the failsafe goes after it.
  fs.writeFileSync(file, `(
${body}
SystemClock.sched(60, { "FAILSAFE-EXIT".postln; 0.exit; nil });
)
`);
  try {
    return execFileSync(resolveSclangPath(), ['-u', PORT, file], { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('the edge that closes a loop is chosen by creation order', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-loops-'));
  try {
    const out = runSclang(dir, `
var tracks = IdentityDictionary.new, sidechainByTarget = IdentityDictionary.new, paramRoutes = IdentityDictionary.new;
var loopEdges = Set.new, trackLevels, routeCloses, busWriters;
${lift('trackLevels')}
${lift('routeCloses')}
${lift('busWriters')}
// b was made before a, though a sorts first: b's walk reaches a, and a's read of b closes the loop.
tracks[\\b] = (born: 1); tracks[\\a] = (born: 2);
// c sends to bus "loop" and reads it back.
tracks[\\c] = (born: 3, busSends: ["loop"]);
sidechainByTarget[\\ab] = (targetKey: \\a, source: \\b);
sidechainByTarget[\\ba] = (targetKey: \\b, source: \\a);
sidechainByTarget[\\cc] = (targetKey: \\c, busName: "loop");
trackLevels.();
("EDGES<" ++ loopEdges.asArray.sort.join(",") ++ ">").postln;
("CLOSES<" ++ [sidechainByTarget[\\ab], sidechainByTarget[\\ba], sidechainByTarget[\\cc]].collect { |e| routeCloses.(e[\\targetKey], e) }.join(",") ++ ">").postln;
// The other way round: a made first, so b's read of a closes it.
loopEdges = Set.new;
tracks[\\a][\\born] = 0;
trackLevels.();
("EDGES2<" ++ loopEdges.asArray.sort.join(",") ++ ">").postln;
0.exit;
`);
    if (!out.includes('Welcome to SuperCollider')) { t.skip('no sclang here'); return; }
    const mark = (tag) => out.match(new RegExp(`${tag}<([^>]*)>`))?.[1];
    // Walking from b first: b reads a, a reads b - and b is on the walk, so a's edge closes.
    assert.equal(mark('EDGES'), 'a|b,c|c');
    assert.equal(mark('CLOSES'), 'true,false,true');
    assert.equal(mark('EDGES2'), 'b|a,c|c');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a closing edge plays the block before; an ordinary one would hear silence', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-loops-'));
  try {
    const out = path.join(dir, 'loop.wav');
    const scsynth = path.join(path.dirname(resolveSclangPath()), 'scsynth');
    const text = runSclang(dir, `
var reader = ${busreadDef()};
var writer = SynthDef(\\loop_writer, { |out| Out.ar(out, DC.ar(0.5) ! 2) });
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
// Both readers run BEFORE the writer of bus 20, as the closing edge of a loop does.
Score.recordNRT([
    [0.0, ['/d_recv', reader.asBytes]],
    [0.0, ['/d_recv', writer.asBytes]],
    [0.0, ['/s_new', 'poptart_busread', 1000, 1, 0, 'out', 0, 'in', 20, 'fb', 1]],
    [0.0, ['/s_new', 'poptart_busread', 1001, 1, 0, 'out', 2, 'in', 20, 'fb', 0]],
    [0.0, ['/s_new', 'loop_writer', 1002, 1, 0, 'out', 20]],
    [0.2, ['/c_set', 0, 0]]
], ${JSON.stringify(`${out}.osc`)}, ${JSON.stringify(out)}, sampleRate: 48000, headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(4).blockSize_(64), duration: 0.2, action: { "RENDER-DONE".postln; 0.exit });
`);
    if (!text.includes('RENDER-DONE')) { t.skip(`could not render here: ${text.trim().split('\n').slice(-3).join(' | ')}`); return; }
    const wav = readWavRaw(out);
    const at = (ch, i) => wav.data[i * wav.channels + ch];
    // The closing edge: the first block is the bus before anything wrote it, then the writer's
    // 0.5 a block late - present, not silent.
    assert.ok(Math.abs(at(0, 10)) < 1e-6, 'the first block has nothing before it');
    assert.ok(Math.abs(at(0, 64 + 10) - 0.5) < 1e-6, `the loop's closing edge is silent (${at(0, 74)})`);
    assert.ok(Math.abs(at(0, 4800) - 0.5) < 1e-6);
    // An ordinary read of a bus written after it hears nothing, which is why the edge has to be marked.
    assert.ok(Math.abs(at(2, 4800)) < 1e-6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
