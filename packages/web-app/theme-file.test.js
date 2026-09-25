'use strict';

// Theme files: what the theme editor exports reads back the same, and a file from anywhere else
// can only set known colors.

const test = require('node:test');
const assert = require('node:assert');
const { THEME_FORMAT, themeFileText, parseThemeFile, freeThemeName } = require('./public/theme-file.js');

const presets = ['poptart', 'blueberry', 'paper'];
const varNames = ['--bg', '--text', '--accent'];
const opts = { presets, varNames };

test('an exported theme imports as itself', () => {
  const theme = { name: 'dusk', base: 'blueberry', vars: { '--bg': '#101018', '--text': '#eeeeee', '--accent': '#ff7ab6' } };
  assert.deepStrictEqual(parseThemeFile(themeFileText(theme), opts), { ...theme, dropped: 0 });
});

test('only known variables with hex colors are taken', () => {
  const text = JSON.stringify({
    format: THEME_FORMAT,
    name: 'odd',
    base: 'paper',
    vars: { '--bg': ' #ABC ', '--text': 'url(https://example.com/x)', '--accent': 'var(--bg)', '--nope': '#000000' },
  });
  assert.deepStrictEqual(parseThemeFile(text, opts), { name: 'odd', base: 'paper', vars: { '--bg': '#abc' }, dropped: 3 });
});

test('an unknown base falls back to the first built-in; a missing name to the fallback', () => {
  const text = JSON.stringify({ format: THEME_FORMAT, base: 'gone', vars: { '--bg': '#000000' } });
  const got = parseThemeFile(text, { ...opts, fallbackName: 'from-file' });
  assert.strictEqual(got.base, 'poptart');
  assert.strictEqual(got.name, 'from-file');
});

test('what is not a theme is refused', () => {
  assert.throws(() => parseThemeFile('not json', opts), /not JSON/);
  assert.throws(() => parseThemeFile('{"vars":{"--bg":"#000"}}', opts), /poptart-theme-1/);
  assert.throws(() => parseThemeFile(JSON.stringify({ format: THEME_FORMAT, vars: { '--bg': 'red' } }), opts), /no colors/);
});

test('an import never overwrites a different theme or takes a reserved name', () => {
  const theme = { base: 'paper', vars: { '--bg': '#000000' } };
  const taken = { dusk: { base: 'paper', vars: { '--bg': '#ffffff' } }, 'dusk 2': { base: 'paper', vars: { '--bg': '#111111' } } };
  const reserved = [...presets, 'custom'];
  assert.strictEqual(freeThemeName('dusk', theme, { taken, reserved }), 'dusk 3');
  assert.strictEqual(freeThemeName('paper', theme, { taken, reserved }), 'paper 2');
  assert.strictEqual(freeThemeName('new', theme, { taken, reserved }), 'new');
  // The same colors under the same name is the same theme: importing it twice keeps one.
  assert.strictEqual(freeThemeName('dusk', taken.dusk, { taken, reserved }), 'dusk');
});
