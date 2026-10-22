'use strict';

// conf from the code: the editor menu's "conf this track" and a rebindable action, each aimed at
// the track the caret is in - either deck, a member inside a group's braces, a monitored copy - and
// the conf'd track's label lit in the code while it lasts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function grab(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found - this test needs updating`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
}

let trackKeyAt;
let deckB;
test.before(async () => {
  const dir = path.dirname(require.resolve('@poptart/pattern-core'));
  const url = (f) => require('node:url').pathToFileURL(path.join(dir, f)).href;
  const labelsMod = await import(url('labels.mjs'));
  const groupsMod = await import(url('groups.mjs'));
  deckB = { name: 'b' };
  const deckTrackId = (ed, label) => (ed === deckB ? `b:${label}` : label);
  // eslint-disable-next-line no-new-func
  trackKeyAt = new Function('labelsMod', 'groupsMod', 'deckTrackId', `${grab(CLIENT, 'trackKeyAt')}; return trackKeyAt;`)(labelsMod, groupsMod, deckTrackId);
});

const editor = (code, self = null) => Object.assign(self ?? {}, { getValue: () => code });

test('the caret names the track it is in, the innermost one inside a group', () => {
  const code = 'setbpm(120)\ndrums: group({\n  kick: s("bd")\n}).fx("Pro-C 2")\nbassM: s("sd")\n';
  const ed = editor(code);
  assert.equal(trackKeyAt(ed, code.indexOf('setbpm')), null, 'setup code is no track');
  assert.equal(trackKeyAt(ed, code.indexOf('"bd"')), 'kick');
  assert.equal(trackKeyAt(ed, code.indexOf('Pro-C')), 'drums');
  assert.equal(trackKeyAt(ed, code.indexOf('"sd"')), 'bass~M', 'a monitored copy is its own track');
});

test('on deck B it is deck B\'s track', () => {
  const code = 'lead: s("hh")\n';
  assert.equal(trackKeyAt(editor(code, deckB), 2), 'b:lead');
});

test('the editor menu and the action both reach conf, and the action starts without a chord', () => {
  const menu = grab(CLIENT, 'openEditorMenu');
  assert.match(menu, /on \? 'stop conf' : 'conf this track', \(\) => toggleConf\(key\)/);
  assert.match(CLIENT, /addBuiltinHotkey\('conf', \(\) => \{/);
  const chords = fs.readFileSync(path.join(__dirname, 'public', 'chords.js'), 'utf8');
  assert.match(chords, /\{ id: 'conf', section: 'code', label: 'conf the track at the caret', combos: \[\],/);
});

test('the conf\'d label is lit in the code, and the sidebar\'s button follows conf wherever it was turned on', () => {
  assert.match(grab(CLIENT, 'updateMutedDim'), /className: 'cm-conf-label'/);
  assert.match(grab(CLIENT, 'syncConfShown'), /b\.dataset\.track === confSession\?\.trackLabel/);
  assert.match(CLIENT, /confBtn\.dataset\.track = t\.key \?\? t\.label;/);
});

test('a rename while conf is on keeps the session, under the new name', () => {
  assert.match(grab(SERVER, 'rekeyTrack'), /conf\.was = from;/);
  assert.match(SERVER, /conf\.trackId !== trackId && conf\.was !== trackId/);
  assert.match(grab(CLIENT, 'pollConf'), /confSession\.trackLabel = now;/);
});
