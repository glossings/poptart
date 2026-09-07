// Groups (groups.mjs): a block headed by group() is the mixdown of its variations, and the routing
// that makes it one is read off the structure of an evaluation's blocks - the group reads the bus
// named after itself, every variation of it sends there and stops playing directly. Nothing is
// written into the code for it, so these pin the rule itself: who reads what, who sends where,
// what an explicit .dry() and an existing send do, and that a variation of a plain track is left
// exactly as it was.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, group, audio } from './src/signal.mjs';
import { isGroupSig, routeGroups } from './src/groups.mjs';
import { splitLabeledBlocks } from './src/labels.mjs';

const blocksOf = (code, sigs) => splitLabeledBlocks(code)
  .filter((b) => b.kind === 'labeled')
  .map((b) => ({ label: b.label, base: b.base, variant: b.variant, sig: sigs[b.label] }));

test('group(): an audio head marked as a group, with no name of its own', () => {
  const g = group();
  assert.equal(isGroupSig(g), true);
  assert.equal(g.inputSource.io, 'audio');
  assert.equal(isGroupSig(audio('bus:kick')), false);
  assert.equal(isGroupSig(s('bd')), false);
});

test('routeGroups: the group reads its own bus, its variations send into it and go dry', () => {
  const blocks = blocksOf('kick: group()\n  #main: s("bd*4")\n  #fill: s("bd*8")\nhat: s("hh*8")', {
    kick: group(), 'kick#main': s('bd*4'), 'kick#fill': s('bd*8'), hat: s('hh*8'),
  });
  const { groups, members } = routeGroups(blocks);
  assert.deepEqual([...groups], ['kick']);
  assert.deepEqual([...members], ['kick#main', 'kick#fill']);
  const by = Object.fromEntries(blocks.map((b) => [b.label, b.sig]));
  assert.deepEqual(by.kick.inputSource, { io: 'audio', name: 'bus:kick' });
  assert.equal(isGroupSig(by.kick), false, 'resolved: the marker has done its job');
  assert.deepEqual(by['kick#main'].busSends, [{ name: 'kick', amount: 1 }]);
  assert.deepEqual(by['kick#fill'].busSends, [{ name: 'kick', amount: 1 }]);
  assert.equal(by['kick#main'].channel.dry.sample(0), 0);
  assert.deepEqual(by.hat.busSends, [], 'a plain track is untouched');
  assert.equal(by.hat.channel.dry, undefined);
});

test('routeGroups: the bus is named by busOf, so two decks\' groups do not share one', () => {
  const blocks = blocksOf('kick: group()\n  #main: s("bd*4")', { kick: group(), 'kick#main': s('bd*4') });
  routeGroups(blocks, (label) => `b:${label}`);
  assert.equal(blocks[0].sig.inputSource.name, 'bus:b:kick');
  assert.deepEqual(blocks[1].sig.busSends, [{ name: 'b:kick', amount: 1 }]);
});

test('routeGroups: a variation of a track that is not a group plays as it always did', () => {
  const blocks = blocksOf('kick: s("bd*4")\n  #fill: s("bd*8")', { kick: s('bd*4'), 'kick#fill': s('bd*8') });
  const { groups, members } = routeGroups(blocks);
  assert.equal(groups.size, 0);
  assert.equal(members.size, 0);
  assert.deepEqual(blocks[1].sig.busSends, []);
  assert.equal(blocks[1].sig.channel.dry, undefined);
});

test('routeGroups: a variation\'s own .dry() and an existing send to the bus are respected', () => {
  const blocks = blocksOf('kick: group()\n  #main: s("bd*4")\n  #wet: s("bd*8")', {
    kick: group(), 'kick#main': s('bd*4').dry(1), 'kick#wet': s('bd*8').bus('kick', 0.5),
  });
  routeGroups(blocks);
  assert.equal(blocks[1].sig.channel.dry.sample(0), 1, 'an explicit dry stands');
  assert.deepEqual(blocks[2].sig.busSends, [{ name: 'kick', amount: 0.5 }], 'not sent twice');
  assert.equal(blocks[2].sig.channel.dry.sample(0), 0);
});

test('routeGroups: a variation whose base is a group in another deck is not a member', () => {
  // a variation only ever belongs to the base block of the SAME evaluation
  const blocks = [{ label: 'kick#fill', base: 'kick', variant: 'fill', sig: s('bd*8') }];
  const { members } = routeGroups(blocks);
  assert.equal(members.size, 0);
  assert.deepEqual(blocks[0].sig.busSends, []);
});
