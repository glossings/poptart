'use strict';

// trackLevels/reorderTracks (sc/poptart.scd) - the node order between tracks that read each other.
//
// scsynth zeroes its buses every block, so a track ordered before what it reads hears silence.
// The order used to be nudged pairwise by whichever routing handler ran last (a bus writer moved
// to a head group, a bus reader to the tail, a track reader after its source), which left the
// ordinary shapes to luck: a track that both reads a bus and sends to one, a chain of three, a
// group of variations feeding a bus its group reads while the group sends on to a reverb. The
// order is now a DEPTH worked out from every route at once - 0 for a track that reads nothing,
// one past the deepest thing routed into it otherwise - and one Group per depth, in order.
//
// What this guards: (1) the closures compile; (2) bus writers sit above their readers and a
// reader that writes on sits above ITS readers (the group-into-reverb shape); (3) a track source
// counts like a bus; (4) a feedback pair terminates with a sensible answer instead of recursing
// forever; (5) a track still being built is skipped; (6) the level groups grow to the depth.
//
// Like the other *-sclang tests, the source under test is lifted out of the shipped poptart.scd
// and run in a real sclang; skipped (not failed) where sclang can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');

function extract(name) {
  const src = fs.readFileSync(SCD, 'utf8');
  const m = src.match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find the ${name} closure in sc/poptart.scd`);
  return m[0];
}

function runSclang() {
  const script = `(
var srv = Server(\\poptartProbe, NetAddr("127.0.0.1", 57999));
var server = srv;
var tracks = IdentityDictionary.new;
var sidechainByTarget = IdentityDictionary.new;
var recGroup = Group.basicNew(srv);
var levelGroups = [Group.basicNew(srv)];
var trackLevels, reorderTracks;
// Never-created nodes: moveToHead / Group.before just put a message on the wire to a server that
// isn't there. The levels are read straight off trackLevels; reorderTracks is run for its growth.
var mkTrack = { |sends| (group: Group.basicNew(srv), busSends: sends) };
var route = { |target, source, busName| (targetKey: target, source: source, busName: busName) };

${extract('trackLevels')}
${extract('reorderTracks')}

("COMPILES<" ++ [trackLevels, reorderTracks].every { |f| f.isKindOf(Function) } ++ ">").postln;

// kick and hat send to "drums"; drums reads that bus and sends on to "mix"; master reads "mix".
// verb reads the kick track's output directly. building is still being built.
tracks[\\kick] = mkTrack.(["drums"]);
tracks[\\hat] = mkTrack.(["drums"]);
tracks[\\drums] = mkTrack.(["mix"]);
tracks[\\master] = mkTrack.(nil);
tracks[\\verb] = mkTrack.(nil);
tracks[\\building] = \\pending;
sidechainByTarget[\\drums_0] = route.(\\drums, nil, "drums");
sidechainByTarget[\\master_0] = route.(\\master, nil, "mix");
sidechainByTarget[\\verb_0] = route.(\\verb, \\kick, nil);
// a pending track routed into: its route must not place anything
sidechainByTarget[\\building_0] = route.(\\building, \\kick, nil);
// a feedback pair
tracks[\\a] = mkTrack.(nil);
tracks[\\b] = mkTrack.(nil);
sidechainByTarget[\\a_0] = route.(\\a, \\b, nil);
sidechainByTarget[\\b_0] = route.(\\b, \\a, nil);

{
    var levels = trackLevels.();
    [\\kick, \\hat, \\drums, \\master, \\verb].do { |k| (k.asString ++ "<" ++ levels[k] ++ ">").postln };
    ("BUILDING<" ++ levels[\\building].isNil ++ ">").postln;
    ("LOOP<" ++ [levels[\\a], levels[\\b]].sort.asString ++ ">").postln;
    reorderTracks.();
    ("GROUPS<" ++ levelGroups.size ++ ">").postln;
    0.exit;
}.value;
)
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-scorder-')), 'harness.scd');
  fs.writeFileSync(file, script);
  try {
    return execFileSync(resolveSclangPath(), [file], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

test('tracks are ordered by how deep their reads go', (t) => {
  const out = runSclang();
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  const said = (tag) => out.match(new RegExp(`${tag}<([^>]*)>`))?.[1]?.replace(/ /g, '');

  assert.equal(said('COMPILES'), 'true', `the ordering closures did not compile:\n${out}`);
  assert.equal(said('kick'), '0');
  assert.equal(said('hat'), '0');
  assert.equal(said('drums'), '1', 'a bus reader sits one past the deepest writer');
  assert.equal(said('master'), '2', 'and a reader of what it writes on, one past that');
  assert.equal(said('verb'), '1', 'a track source counts like a bus');
  assert.equal(said('BUILDING'), 'true', 'a pending track has no place yet');
  assert.equal(said('LOOP'), '[0,1]', 'a feedback pair is broken at one edge, not recursed');
  assert.equal(said('GROUPS'), '3', 'one level group per depth, made as the depth appears');
});
