// A key of the roll's ⌨ on a sampler track strikes the file (a sampler answers no note-on). The
// browser build's route is played in web-host.test.mjs; the desktop's runs against a live engine,
// so here it is read: the same helper, the same one-shot with no note-off, as the browser's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const HOST = fs.readFileSync(path.join(__dirname, 'public', 'web', 'host.mjs'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function route(src, name, next) {
  const from = src.indexOf(`'POST /api/${name}': async`);
  assert.ok(from > 0, `${name} route not found - this test needs updating`);
  return src.slice(from, src.indexOf(`'POST /api/${next}'`, from));
}

test('both hosts strike a sampler key with keyStrike and send it no note-off', () => {
  for (const [name, body] of [['server.js', route(SERVER, 'keyNote', 'liveNotes')], ['host.mjs', route(HOST, 'keyNote', 'previewNote')]]) {
    assert.match(body, /keyStrike\?\.\(body\.sample, \{ note, index, vel \}\)/, `${name} does not build the strike with keyStrike`);
    assert.match(body, /engine\.playSample\(tid, strike\.ref/, `${name} does not play the struck file`);
    assert.equal((body.match(/if \(!held\.get\(key\)\.struck\) engine\.noteOff/g) ?? []).length, 2, `${name} sends a struck key a note-off`);
  }
});

test('the keyboard sends the roll\'s sample with a key, as the roll auditions a row', () => {
  const from = CLIENT.indexOf('function kbSend(');
  const body = CLIENT.slice(from, CLIENT.indexOf('\n}\n', from));
  assert.match(body, /const ref = prState\?\.chain\?\.ref;/);
  assert.match(body, /body\.sample = \{ ref: ref\.ref, index: ref\.index \?\? 0, begin, end \};/);
});
