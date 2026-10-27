'use strict';

// The header's ⋯ menu (public/header-menu.js): what a narrow window folds out of the top bar - the
// theme picker, its edit button and the docs link - offered as the app's own context menu.

const test = require('node:test');
const assert = require('node:assert/strict');

const { headerMenuItems } = require('./public/header-menu.js');

const THEMES = [['poptart', 'poptart'], ['matcha', 'matcha'], ['custom', 'custom (unsaved)']];

test('every theme the picker holds, in its order, the current one ticked', () => {
  const items = headerMenuItems({ themes: THEMES, current: 'matcha' });
  assert.deepEqual(items[0], { head: 'theme' });
  const rows = items.slice(1, 4).map(([label]) => label);
  assert.deepEqual(rows, ['   poptart', '✓ matcha', '   custom (unsaved)']);
});

test('then edit, a rule, and the docs - the three controls the fold hides', () => {
  const items = headerMenuItems({ themes: THEMES, current: 'poptart' });
  const tail = items.slice(-3);
  assert.equal(tail[0][0], 'edit theme colors…');
  assert.equal(tail[1], '-');
  assert.equal(tail[2][0], 'docs ↗');
});

test('each entry does what its folded control does', () => {
  const calls = [];
  const items = headerMenuItems({
    themes: THEMES,
    current: 'poptart',
    onTheme: (v) => calls.push(['theme', v]),
    onEditTheme: () => calls.push(['edit']),
    onDocs: () => calls.push(['docs']),
  });
  for (const entry of items) if (Array.isArray(entry)) entry[1]();
  assert.deepEqual(calls, [['theme', 'poptart'], ['theme', 'matcha'], ['theme', 'custom'], ['edit'], ['docs']]);
});

test('no themes yet (the picker fills by script) still offers edit and docs', () => {
  const items = headerMenuItems();
  assert.deepEqual(items.map((e) => (Array.isArray(e) ? e[0] : e)), [{ head: 'theme' }, 'edit theme colors…', '-', 'docs ↗']);
});
