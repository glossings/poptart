'use strict';

// Changing an audio setting restarts the engine, and a restart takes the running plugin scan with
// it (public/client.js). VSTPlugin writes its cache only when a search finishes and poptart
// searches one folder at a time, so what is lost is the folder in progress - on a machine whose
// plugins live in one big folder, nearly the whole scan, which is minutes of probing.
//
// So the scan is not discarded silently. These are source-shape assertions - the handlers are DOM
// events against a live engine, which a unit test can't drive - but the failure they guard is a
// settings click that quietly throws away a quarter of an hour of somebody's first run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'public', 'client.js'), 'utf8');

function grab(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in client.js - this test needs updating`);
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
}

// The handler body, from its listener to the api() call that does the restart.
function handler(listener, endpoint) {
  const at = SRC.indexOf(listener);
  assert.ok(at > 0, `${listener} not found in client.js - this test needs updating`);
  const call = SRC.indexOf(`'${endpoint}'`, at);
  assert.ok(call > at, `${listener} no longer calls ${endpoint}`);
  return SRC.slice(at, call);
}

test('the guard asks only while a scan is running, and reports how much would be lost', () => {
  const fn = grab('scanSurvivesRestart');
  assert.match(fn, /if \(!lastScan\?\.scanning\) return true/, 'nothing to warn about when no scan is running');
  assert.match(fn, /lastScan\.probed/, 'the count already probed is what makes the choice informed');
  assert.match(fn, /lastScan\.total/);
  assert.match(fn, /window\.confirm/, 'the person losing the work is the one who decides');
});

// Each audio setting whose server endpoint calls restartEngine(). Keeping this list complete is
// the point - the completeness check at the bottom found the cue device missing from it, which is
// the regression this whole file exists to catch.
for (const [what, listener, endpoint] of [
  ['the output device', "audioDeviceSelect.addEventListener('change'", '/api/audioDevice'],
  ['the output channel count', "audioChannelSelect.addEventListener('change'", '/api/audioOutputChannels'],
  ['the input devices', "audioInputApply.addEventListener('click'", '/api/audioInputs'],
  ['the headphone cue device', "audioCueSelect.addEventListener('change'", '/api/audioCueDevice'],
]) {
  test(`changing ${what} asks first, before anything is torn down`, () => {
    const body = handler(listener, endpoint);
    assert.match(body, /scanSurvivesRestart\(/, `${endpoint} restarts the engine without asking`);
    // Before the teardown, not after: the point is to not have started.
    const asked = body.indexOf('scanSurvivesRestart(');
    const disabled = body.search(/\.disabled = true|engineStatus\.textContent/);
    if (disabled >= 0) assert.ok(asked < disabled, 'the question comes before the UI commits to a restart');
  });
}

test('declining the output-device change puts the menu back', () => {
  // The select has already moved to the device that was clicked, so returning early would leave
  // it naming a device the engine is not on.
  const body = handler("audioDeviceSelect.addEventListener('change'", '/api/audioDevice');
  const declined = body.slice(body.indexOf('scanSurvivesRestart('));
  assert.match(declined, /refreshAudioDevices\(\)/, 'the menu is re-read so it shows the device still in use');
  assert.match(declined, /return;/);
});

test('every endpoint that restarts the engine is covered here', () => {
  // Read from the server: the list above is only as good as its agreement with what actually
  // restarts, which is how the cue device came to be in the list above at all.
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const endpoints = [...server.matchAll(/'POST (\/api\/[A-Za-z]+)': async[\s\S]*?(?=\n {2}'(?:POST|GET) \/api|\n};)/g)]
    .filter((m) => /restartEngine\(/.test(m[0]))
    .map((m) => m[1]);
  const guarded = ['/api/audioDevice', '/api/audioOutputChannels', '/api/audioInputs', '/api/audioCueDevice'];
  const unguarded = endpoints.filter((e) => !guarded.includes(e));
  assert.deepEqual(unguarded, [], 'a settings endpoint restarts the engine with no scan guard in client.js');
});
