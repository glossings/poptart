// Groups: a track whose head is group() is the mixdown of its variations (see the group() builder
// in signal.mjs). The routing that makes that true is not written in the code - it is READ off the
// code's structure, here, once per evaluation:
//
//   - a group block reads the bus named after itself (`bus:<its key>`);
//   - every variation of a group block sends its output into that bus, and plays nothing directly
//     unless it says otherwise with a .dry() of its own.
//
// Structure rather than a `.bus("kick")` written onto every variation, because the send is a
// consequence of being a variation of a group and nothing else: there is no line to fall out of
// step when a variation is copied, renamed or moved, and a reader of the code sees the group and
// knows where its variations go. A variation of a block that is NOT a group is left alone - it
// plays directly, as any track does.

import { Sig } from './signal.mjs';

/** Whether a Sig was headed by group(). */
export function isGroupSig(sig) {
  return sig instanceof Sig && !!sig.inputSource?.group;
}

/**
 * Apply the group routing to the blocks of one evaluation. Each block is `{ label, base, variant,
 * sig }` (labels.mjs's fields plus the evaluated Sig); `busOf(label)` names the bus a group reads -
 * the engine's key for the block, so two decks' `kick` groups don't share a bus. The blocks' `sig`s
 * are replaced in place; returns which labels are groups and which are members of one.
 */
export function routeGroups(blocks, busOf = (label) => label) {
  const groups = new Set();
  const members = new Set();
  for (const b of blocks) {
    if (!isGroupSig(b.sig)) continue;
    groups.add(b.label);
    b.sig = b.sig._clone({ inputSource: { io: 'audio', name: `bus:${busOf(b.label)}` } });
  }
  for (const b of blocks) {
    if (b.variant == null || !groups.has(b.base) || !(b.sig instanceof Sig)) continue;
    members.add(b.label);
    const bus = busOf(b.base);
    let sig = b.sig;
    if (!sig.busSends.some((s) => s.name === bus)) sig = sig.bus(bus);
    if (sig.channel.dry == null) sig = sig.dry(0);
    b.sig = sig;
  }
  return { groups, members };
}
