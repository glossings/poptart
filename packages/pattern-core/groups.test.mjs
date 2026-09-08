// Groups (groups.mjs): the track tree. A block headed by group() is a mixdown, the `_groups(...)`
// tree says who is under it, and the routing is read off the two - the group reads the bus named
// after itself, its members send there and stop playing directly. Nothing is written into a
// member's code for it, so these pin the rule itself: who reads what, who sends where, what an
// explicit .dry() and an existing send do, how nesting and the implicit `main` root behave, and
// that a track whose group has gone is freed rather than silenced.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, group, audio } from './src/signal.mjs';
import {
  isGroupSig, routeGroups, normalizeGroupTree, parentsOf, ancestorsOf, descendantsOf,
  groupOrder, serializeGroupTree, pruneGroupTree, _groups, GROUP_ROOT,
} from './src/groups.mjs';

const blocksOf = (sigs) => Object.entries(sigs).map(([label, sig]) => ({ label, sig }));
const byLabel = (blocks) => Object.fromEntries(blocks.map((b) => [b.label, b.sig]));

test('group(): an audio head marked as a group, with no name of its own', () => {
  const g = group();
  assert.equal(isGroupSig(g), true);
  assert.equal(g.inputSource.io, 'audio');
  assert.equal(isGroupSig(audio('bus:kick')), false);
  assert.equal(isGroupSig(s('bd')), false);
});

// --- the tree itself ---

test('normalizeGroupTree: a plain object in, a Map of parent -> ordered children out', () => {
  const t = normalizeGroupTree({ drums: ['kick', 'snare'], kick: ['kickMain', 'kickFill'] });
  assert.deepEqual([...t.keys()], ['drums', 'kick']);
  assert.deepEqual(t.get('drums'), ['kick', 'snare']);
  assert.deepEqual(parentsOf(t).get('kickFill'), 'kick');
});

test('normalizeGroupTree: one track, one group - the first parent named keeps it', () => {
  const t = normalizeGroupTree({ drums: ['kick'], perc: ['kick', 'shaker'] });
  assert.deepEqual(t.get('drums'), ['kick']);
  assert.deepEqual(t.get('perc'), ['shaker'], 'the second claim is dropped, not the whole entry');
});

test('normalizeGroupTree: drops self-membership, a repeated child, and `main` as a child', () => {
  const t = normalizeGroupTree({ drums: ['drums', 'kick', 'kick', GROUP_ROOT, 'snare'] });
  assert.deepEqual(t.get('drums'), ['kick', 'snare']);
});

test('normalizeGroupTree: the edge that closes a cycle goes, the rest of the tree stands', () => {
  const t = normalizeGroupTree({ a: ['b'], b: ['c'], c: ['a', 'd'] });
  assert.deepEqual(t.get('a'), ['b']);
  assert.deepEqual(t.get('b'), ['c']);
  assert.deepEqual(t.get('c'), ['d'], 'c -> a would close the loop');
});

test('normalizeGroupTree: junk in, empty out - never a throw', () => {
  assert.equal(normalizeGroupTree(null).size, 0);
  assert.equal(normalizeGroupTree({ drums: 'kick' }).size, 0, 'a non-array value is not an entry');
  assert.equal(normalizeGroupTree({ drums: [1, '', null] }).size, 0);
});

test('ancestorsOf / descendantsOf: up the tree nearest first, down it in order', () => {
  const t = normalizeGroupTree({ drums: ['kick', 'snare'], kick: ['kickMain', 'kickFill'] });
  assert.deepEqual(ancestorsOf('kickFill', parentsOf(t)), ['kick', 'drums']);
  assert.deepEqual(ancestorsOf('drums', parentsOf(t)), []);
  assert.deepEqual(descendantsOf('drums', t), ['kick', 'kickMain', 'kickFill', 'snare']);
  assert.deepEqual(descendantsOf('kickMain', t), []);
});

test('groupOrder: a group, then everything under it, indented by depth', () => {
  const t = normalizeGroupTree({ drums: ['kick', 'snare'], kick: ['kickMain', 'kickFill'] });
  const rows = groupOrder(['kickMain', 'drums', 'kick', 'snare', 'kickFill', 'bass'], t);
  assert.deepEqual(rows.map((r) => [r.label, r.depth]), [
    ['drums', 0], ['kick', 1], ['kickMain', 2], ['kickFill', 2], ['snare', 1], ['bass', 0],
  ]);
  assert.equal(rows.find((r) => r.label === 'kickFill').parent, 'kick');
});

test('groupOrder: a member whose group is not in the buffer stays, at the top level', () => {
  const t = normalizeGroupTree({ drums: ['kick'] });
  assert.deepEqual(groupOrder(['kick', 'bass'], t).map((r) => [r.label, r.depth]), [['kick', 0], ['bass', 0]]);
});

test('serializeGroupTree: strict JSON, so the buffer reads back with JSON.parse', () => {
  const text = serializeGroupTree({ drums: ['kick', 'snare'] });
  assert.equal(text, '{ "drums": ["kick", "snare"] }');
  assert.deepEqual(JSON.parse(text), { drums: ['kick', 'snare'] });
  assert.equal(serializeGroupTree({}), '{}');
});

test('pruneGroupTree: a group or a member the buffer has lost is dropped', () => {
  const t = pruneGroupTree({ drums: ['kick', 'gone'], ghost: ['x'] }, ['drums', 'kick']);
  assert.deepEqual([...t.keys()], ['drums']);
  assert.deepEqual(t.get('drums'), ['kick']);
});

test('_groups(): a definition marker carrying the normalized tree', () => {
  const def = _groups({ drums: ['kick'] });
  assert.equal(def.poptartGroupsBlock, true);
  assert.deepEqual(def.tree.get('drums'), ['kick']);
});

// --- the routing ---

test('routeGroups: the group reads its own bus, its members send into it and go dry', () => {
  const blocks = blocksOf({ kick: group(), kickMain: s('bd*4'), kickFill: s('bd*8'), hat: s('hh*8') });
  const { groups, members } = routeGroups(blocks, undefined, { kick: ['kickMain', 'kickFill'] });
  assert.deepEqual([...groups], ['kick']);
  assert.deepEqual([...members], ['kickMain', 'kickFill']);
  const by = byLabel(blocks);
  assert.deepEqual(by.kick.inputSource, { io: 'audio', name: 'bus:kick' });
  assert.equal(isGroupSig(by.kick), false, 'resolved: the marker has done its job');
  assert.deepEqual(by.kickMain.busSends, [{ name: 'kick', amount: 1 }]);
  assert.deepEqual(by.kickFill.busSends, [{ name: 'kick', amount: 1 }]);
  assert.equal(by.kickMain.channel.dry.sample(0), 0);
  assert.deepEqual(by.hat.busSends, [], 'a track in no group is untouched');
  assert.equal(by.hat.channel.dry, undefined);
});

test("routeGroups: the bus is named by busOf, so two decks' groups do not share one", () => {
  const blocks = blocksOf({ kick: group(), kickMain: s('bd*4') });
  routeGroups(blocks, (label) => `b:${label}`, { kick: ['kickMain'] });
  assert.equal(blocks[0].sig.inputSource.name, 'bus:b:kick');
  assert.deepEqual(blocks[1].sig.busSends, [{ name: 'b:kick', amount: 1 }]);
});

test('routeGroups: a member of a track that is NOT a group plays as it always did', () => {
  const blocks = blocksOf({ kick: s('bd*4'), kickFill: s('bd*8') });
  const { groups, members } = routeGroups(blocks, undefined, { kick: ['kickFill'] });
  assert.equal(groups.size, 0);
  assert.equal(members.size, 0);
  assert.deepEqual(blocks[1].sig.busSends, [], 'losing a group frees its members, never silences them');
  assert.equal(blocks[1].sig.channel.dry, undefined);
});

test("routeGroups: a member's own .dry() and an existing send to the bus are respected", () => {
  const blocks = blocksOf({ kick: group(), kickMain: s('bd*4').dry(1), kickWet: s('bd*8').bus('kick', 0.5) });
  routeGroups(blocks, undefined, { kick: ['kickMain', 'kickWet'] });
  assert.equal(blocks[1].sig.channel.dry.sample(0), 1, 'an explicit dry stands');
  assert.deepEqual(blocks[2].sig.busSends, [{ name: 'kick', amount: 0.5 }], 'not sent twice');
  assert.equal(blocks[2].sig.channel.dry.sample(0), 0);
});

test('routeGroups: a SUBGROUP reads its own bus and sends into its parent', () => {
  const blocks = blocksOf({ drums: group(), kick: group(), kickMain: s('bd*4'), snare: s('sd*2') });
  const { members } = routeGroups(blocks, undefined, { drums: ['kick', 'snare'], kick: ['kickMain'] });
  const by = byLabel(blocks);
  assert.deepEqual(by.kick.inputSource, { io: 'audio', name: 'bus:kick' }, 'still reads its own');
  assert.deepEqual(by.kick.busSends, [{ name: 'drums', amount: 1 }], '...and sends into its parent');
  assert.equal(by.kick.channel.dry.sample(0), 0);
  assert.deepEqual(by.kickMain.busSends, [{ name: 'kick', amount: 1 }], 'two levels down, one hop up');
  assert.deepEqual(by.snare.busSends, [{ name: 'drums', amount: 1 }]);
  assert.deepEqual(by.drums.busSends, [], 'the top of the tree plays out');
  assert.equal(members.has('kick'), true);
  assert.equal(members.has('drums'), false);
});

test('routeGroups: with a `main:` group, everything ungrouped reaches it', () => {
  const blocks = blocksOf({ main: group(), drums: group(), kick: s('bd*4'), bass: s('bass') });
  const { routedParents } = routeGroups(blocks, undefined, { drums: ['kick'] });
  const by = byLabel(blocks);
  assert.deepEqual(by.bass.busSends, [{ name: 'main', amount: 1 }], 'a loose track goes to the root');
  assert.deepEqual(by.drums.busSends, [{ name: 'main', amount: 1 }], '...and so does a top-level group');
  assert.deepEqual(by.kick.busSends, [{ name: 'drums', amount: 1 }], 'a grouped track keeps its own group');
  assert.deepEqual(by.main.busSends, [], 'the root itself plays out');
  assert.deepEqual(by.main.inputSource, { io: 'audio', name: 'bus:main' });
  assert.equal(routedParents.get('bass'), GROUP_ROOT);
  assert.equal(routedParents.get('kick'), 'drums');
  assert.equal(routedParents.has('main'), false);
});

test('routeGroups: no `main:` block, no root routing - tracks play straight out', () => {
  const blocks = blocksOf({ kick: s('bd*4'), bass: s('bass') });
  const { members } = routeGroups(blocks, undefined, {});
  assert.equal(members.size, 0);
  assert.deepEqual(blocks[0].sig.busSends, []);
  assert.equal(blocks[0].sig.channel.dry, undefined, 'a mastering chain costs nothing until it is asked for');
});
