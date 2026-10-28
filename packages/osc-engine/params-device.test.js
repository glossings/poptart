'use strict';

// The device-only handlers of engine/params.js, on the engine with no server behind it: a file and
// a curve handed to the device in a slot, the note route, and the live report answered inline. A
// slot with nothing that takes one warns and stays playing; a report with no device answers -1.

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeEngine } = require('./test-support/fake-engine');

function deviceCtl() {
  const c = {
    log: [],
    loadSample(...a) { c.log.push(['loadSample', ...a]); },
    loadShape(...a) { c.log.push(['loadShape', ...a]); },
    noteRoute(on) { c.log.push(['noteRoute', on]); },
    report(cb) { cb([0.5, 0.25], [7]); },
  };
  return c;
}

function rig() {
  const fe = fakeEngine({ sections: ['tracks', 'routing', 'loads', 'ids', 'params', 'expr'] });
  const dev = deviceCtl();
  const plugin = { set() {} }; // a plugin answers none of the device calls
  fe.E.tracks.set('t', { controllers: new Map([[1, dev], [2, plugin]]) });
  fe.dev = dev; // kept on fe itself: its output is a getter
  return fe;
}

test('a file and a curve reach the device in the slot, and a slot without one says so', () => {
  const { E, dev } = rig();
  const buf = { bufnum: 42 };
  E.samplePacks.set('kit', [{ bufnum: 41 }, buf]);
  E.dispatch('/poptart/deviceSample', ['t', 1, 3, 2, 'kit', 1, 256]);
  E.dispatch('/poptart/deviceShape', ['t', 1, 4, 0, 0, 0.5, 1]);
  E.dispatch('/poptart/deviceNoteRoute', ['t', 1, 1]);
  assert.deepStrictEqual(dev.log, [['loadSample', 3, 2, buf, 256], ['loadShape', 4, 0, [0, 0.5, 1]], ['noteRoute', true]]);
});

test('what cannot be handed over warns and changes nothing', () => {
  const fe = rig();
  fe.E.samplePacks.set('kit', []);
  fe.E.dispatch('/poptart/deviceSample', ['t', 2, 0, 0, 'kit', 0]);
  fe.E.dispatch('/poptart/deviceSample', ['t', 1, 0, 0, 'kit', 5]);
  fe.E.dispatch('/poptart/deviceShape', ['t', 2, 0, 0, 1]);
  assert.match(fe.output, /no device in slot 2 of 't' to give a sample to/);
  assert.match(fe.output, /'kit' has no file 5 to play on t slot 1/);
  assert.match(fe.output, /no device in slot 2 of 't' to draw a curve on/);
  assert.deepStrictEqual(fe.dev.log, []);
});

test('the live report is answered inline, and -1 where there is no device', () => {
  const { E, told } = rig();
  E.dispatch('/poptart/deviceLive', [9, 't', 1]);
  E.dispatch('/poptart/deviceLive', [10, 't', 2]);
  E.dispatch('/poptart/deviceLive', [11, 'gone', 0]);
  const data = told.filter((m) => m.address === '/poptart/deviceLive.data').map((m) => m.args);
  assert.deepStrictEqual(data, [[9, 2, 0.5, 0.25, 1, 7], [10, -1], [11, -1]]);
});
