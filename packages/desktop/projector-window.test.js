'use strict';

// The projector's window in the desktop shell.
//
// Everything the page opens with window.open is a link out, and the shell hands those to the
// user's browser - everything except the projector, which is a second window of poptart's own
// page. Getting that distinction wrong is silent in the worst way: F1 would open the projector in
// Safari, or a documentation link would open in a chromeless window with no way back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// main.js opens an Electron app on require, so the two functions are read out of its source -
// the same trick the web app's highlight-grid test uses on server.js.
function sliceFn(name) {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} not found in main.js - this test needs updating`);
  let depth = 0;
  let end = src.indexOf('{', at);
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(at, end)}; return ${name};`)();
}
const isProjectorUrl = sliceFn('isProjectorUrl');
const projectorWindowOptions = sliceFn('projectorWindowOptions');

test('the projector page is the one window.open the shell opens itself', () => {
  assert.equal(isProjectorUrl('http://127.0.0.1:3000/projector.html'), true);
  assert.equal(isProjectorUrl('http://127.0.0.1:52341/projector.html?x=1'), true);
});

test('a link out is still a link out', () => {
  for (const url of [
    'https://discord.gg/g5F59UdN8b',
    'http://127.0.0.1:3000/docs/projector.html',
    'http://127.0.0.1:3000/',
    'https://example.com/projector.html.evil',
    'about:blank',
    '',
    null,
  ]) {
    assert.equal(isProjectorUrl(url), false, `${url} is not the projector`);
  }
});

test('the window opens at the resolution the settings asked for', () => {
  const opts = projectorWindowOptions('width=2560,height=1440');
  assert.equal(opts.width, 2560);
  assert.equal(opts.height, 1440);
});

test('the window is black before it has painted anything', () => {
  // A white flash on the wall between the open and the first frame is the one thing it must not
  // do, and the page being black is too late - the BrowserWindow has to start that way.
  assert.equal(projectorWindowOptions('width=1920,height=1080').backgroundColor, '#000000');
});

test('features that carry no usable size leave the window to its default', () => {
  for (const features of ['', null, undefined, 'noopener', 'width=0,height=0', 'width=x,height=y']) {
    const opts = projectorWindowOptions(features);
    assert.equal('width' in opts, false, `${features} should not set a width`);
    assert.equal('height' in opts, false, `${features} should not set a height`);
  }
});

test('the projector reaches no further into the machine than the editor does', () => {
  const { webPreferences } = projectorWindowOptions('width=1920,height=1080');
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.contextIsolation, true);
});

test('neither window has its timers throttled for being in the background', () => {
  // Measured, not theoretical: with the editor behind another window, Chromium clamped its 33ms
  // ticker to one frame a SECOND, and the projector and its feed went with it - 10 frames in
  // eight seconds against 82 on the same playing set. During a set the focused window is never
  // the editor, so this is the ordinary case rather than an edge one.
  assert.equal(projectorWindowOptions('').webPreferences.backgroundThrottling, false);
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const at = main.indexOf('function createWindow(');
  assert.ok(/backgroundThrottling:\s*false/.test(main.slice(at, main.indexOf('win.loadFile', at))),
    'the editor window needs it too - it is the one holding the ticker');
  // And the occluded case, which the per-window flag does not reach.
  for (const flag of ['disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) {
    assert.ok(main.includes(`appendSwitch('${flag}')`), `missing ${flag}`);
  }
});
