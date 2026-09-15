'use strict';

// The magnifier drag's direction gate (axisGate in public/client.js), shared by the arrangement
// ruler and the piano roll's bar-number strip: sideways pans, up and down zooms, and a drag that is
// nearly along one axis is that axis ALONE. Only a drag clearly between the two - a diagonal band
// narrower than either axis's arc - pans and zooms together. Lifted out of the shipped client.js
// like the other panel tests, so this fails if it drifts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  let depth = 0;
  let end = SRC.indexOf('{', at);
  for (let i = end; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return SRC.slice(at, end);
}

function constLine(name) {
  const m = SRC.match(new RegExp(`^const ${name} = .*$`, 'm'));
  assert.ok(m, `${name} not found in client.js - this test needs updating`);
  return m[0];
}

// eslint-disable-next-line no-new-func
const { axisGate, axisGateState } = new Function(
  `${constLine('NAV_AXIS_ARC')}\n${constLine('NAV_AXIS_DECAY')}\n${constLine('axisGateState')}\n${grab('axisGate')}\nreturn { axisGate, axisGateState };`,
)();

/** Feed `n` identical movements through one drag's gate and return what came out of the last. */
function drag(moves) {
  const g = axisGateState();
  let out;
  for (const [dx, dy] of moves) out = axisGate(g, dx, dy);
  return out;
}
const times = (n, mv) => Array.from({ length: n }, () => mv);
const deg = (d, r = 6) => [Math.cos((d * Math.PI) / 180) * r, Math.sin((d * Math.PI) / 180) * r];

test('a sideways drag pans and never zooms, even with a pixel of drift in it', () => {
  assert.deepEqual(drag(times(5, [6, 0])), { dx: 6, dy: 0 });
  assert.deepEqual(drag(times(5, [6, 1])), { dx: 6, dy: 0 }, 'the drift is dropped, not applied');
});

test('an up-and-down drag zooms and never pans', () => {
  assert.deepEqual(drag(times(5, [0, 6])), { dx: 0, dy: 6 });
  assert.deepEqual(drag(times(5, [-1, 6])), { dx: 0, dy: 6 });
});

test('the arc around each axis is wide; the band between them is narrower than either', () => {
  // 20 degrees off sideways is still a pan; 70 (20 off vertical) is still a zoom; 45 is both.
  const [px, py] = deg(20);
  assert.deepEqual(drag(times(5, [px, py])), { dx: px, dy: 0 });
  const [zx, zy] = deg(70);
  assert.deepEqual(drag(times(5, [zx, zy])), { dx: 0, dy: zy });
  const [bx, by] = deg(45);
  assert.deepEqual(drag(times(5, [bx, by])), { dx: bx, dy: by }, 'a clear diagonal does both');
  // The both-band is what is left after two arcs of NAV_AXIS_ARC: less than a third of the quadrant.
  const arc = Number(constLine('NAV_AXIS_ARC').match(/= (\d+)/)[1]);
  assert.ok(90 - 2 * arc < arc, 'paired movement is the smaller region, not "anything off-axis"');
});

test('a pan that turns into a zoom gets there within a few movements', () => {
  // Read off the recent direction rather than the whole drag: after a long pan a vertical run
  // does not have to be as long as the pan before it to count.
  const g = axisGateState();
  for (let i = 0; i < 40; i++) axisGate(g, 6, 0);
  const out = [];
  for (let i = 0; i < 4; i++) out.push(axisGate(g, 0, 6).dy);
  assert.ok(out.some((dy) => dy === 6), 'the zoom engaged: ' + out.join(','));
  assert.equal(out[3], 6, 'and is fully through by the fourth movement');
});
