// What `.param()` accepts as the thing it is aiming at.
//
// A plugin parameter is reached by NAME ("Filter 1 Freq") or by INDEX (12, which the engine
// resolves directly). Nothing else can reach one - but `.param()` stored whatever it was handed
// without looking, and the first thing that ever examined it was the OSC encoder, by which point
// the whole evaluation was in flight. So a slip in the buffer - a device handle where the name
// goes, a signal passed in the wrong position, an options object - did not spoil one parameter, it
// returned a 500 from /api/evaluate and left NOTHING playing, with
// `cannot encode OSC argument: [object Object]` as the only clue (hit live, 2026-10-05).
//
// Userland mistakes warn and keep playing here, so that is what this does now.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, sine, setPatternWarn } from './src/signal.mjs';

/** Collects everything warnUser() says while `fn` runs. */
function warnings(fn) {
  const lines = [];
  setPatternWarn((line) => lines.push(line));
  try {
    return { out: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
}

/** The parameters a built Sig is actually speaking for. */
const paramKeys = (sig) => Object.keys(sig.paramSignals ?? {});

test('a name and an index are both accepted', () => {
  const { out, lines } = warnings(() => n("0").synth("Serum 2").param('Filter 1 Freq', 0.5).param(12, 0.25));
  assert.deepEqual(lines, [], 'neither spelling is a mistake');
  assert.deepEqual(paramKeys(out).sort(), ['0:12', '0:Filter 1 Freq'].sort());
});

test('anything else is warned about and the call is ignored', () => {
  const { out, lines } = warnings(() => n("0").synth("Serum 2").param({ cutoff: 1 }, 0.5));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\.param\(\) takes a parameter name or index first/);
  assert.match(lines[0], /keys cutoff/, 'the warning has to say what was actually passed');
  assert.match(lines[0], /everything else on this track still plays/, '...and that the rest survives');
  assert.deepEqual(paramKeys(out), [], 'the bad call must leave no parameter behind');
});

test('the track it was on is otherwise untouched', () => {
  // The whole point: one bad call is one bad call, not the end of the evaluation.
  const { out } = warnings(() => n("0 2").synth("Serum 2").param('Filter 1 Freq', 0.5).param(null, 1).param('Osc 1 Pan', 0.2));
  assert.deepEqual(paramKeys(out).sort(), ['0:Filter 1 Freq', '0:Osc 1 Pan'].sort(),
    'the parameters either side of the mistake have to survive it');
});

test('a signal in the name position is named as such, because it is the likely slip', () => {
  const { lines } = warnings(() => n("0").synth("Serum 2").param(sine(1), 0.5));
  assert.match(lines[0], /pattern or signal/);
  assert.match(lines[0], /as the VALUE/, 'the fix is almost always "that belongs in the other argument"');
});

test('null and undefined say so rather than reading as an object', () => {
  assert.match(warnings(() => n("0").synth("x").param(null, 1)).lines[0], /got null/);
  assert.match(warnings(() => n("0").synth("x").param(undefined, 1)).lines[0], /got undefined/);
});

test('NaN is not an index', () => {
  // typeof NaN is 'number', and an unparsed index arrives as one. It cannot address anything.
  const { lines, out } = warnings(() => n("0").synth("x").param(NaN, 1));
  assert.equal(lines.length, 1);
  assert.deepEqual(paramKeys(out), []);
});
