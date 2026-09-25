'use strict';

// A theme as a file: what the theme editor's export writes and its import reads back.
//
//     { "format": "poptart-theme-1", "name": "dusk", "base": "blueberry",
//       "vars": { "--bg": "#101018", "--accent": "#ff7ab6", … } }
//
// `base` is the built-in theme it was made on top of, which supplies anything `vars` leaves out -
// so a file from a build with fewer colors still opens, and one written by hand can name only the
// few it changes. The vars are the CSS variables themselves, the same keys the saved themes hold.
//
// A file is somebody else's input, so only the known variables are taken and only as hex colors.
// Anything else a value could be (a url(), a var() reaching another variable, a keyword) is
// dropped, since each one is written straight onto the page's root style.

const THEME_FORMAT = 'poptart-theme-1';

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The file for one theme, as text. */
function themeFileText({ name, base, vars }) {
  return `${JSON.stringify({ format: THEME_FORMAT, name, base, vars }, null, 2)}\n`;
}

/**
 * A theme file back into { name, base, vars, dropped }, where `dropped` counts the entries that
 * were not a known variable with a hex color. Throws when the text is not a theme at all.
 * `fallbackName` names a file that doesn't name itself - the file name, usually.
 */
function parseThemeFile(text, { presets, varNames, fallbackName = 'imported' }) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('the file is not a theme (it is not JSON)');
  }
  if (!data || typeof data !== 'object' || data.format !== THEME_FORMAT) {
    throw new Error('the file is not a theme (it has no "format": "poptart-theme-1")');
  }
  const known = new Set(varNames);
  const vars = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(data.vars && typeof data.vars === 'object' ? data.vars : {})) {
    if (known.has(key) && typeof value === 'string' && HEX_COLOR.test(value.trim())) vars[key] = value.trim().toLowerCase();
    else dropped += 1;
  }
  if (!Object.keys(vars).length) throw new Error('the theme sets no colors');
  const base = presets.includes(data.base) ? data.base : presets[0];
  const name = String(typeof data.name === 'string' && data.name.trim() ? data.name : fallbackName).trim().slice(0, 64);
  return { name, base, vars, dropped };
}

/**
 * A name for an imported theme that overwrites nothing: its own when that is free (or already
 * holds these very colors), otherwise the first free "name 2", "name 3"…. `taken` is the saved
 * themes by name; `reserved` the names that are not a saved theme's to have.
 */
function freeThemeName(name, theme, { taken, reserved }) {
  const same = (held) => held && held.base === theme.base && JSON.stringify(held.vars) === JSON.stringify(theme.vars);
  const free = (n) => !reserved.includes(n) && (!taken[n] || same(taken[n]));
  if (free(name)) return name;
  for (let i = 2; ; i += 1) {
    if (free(`${name} ${i}`)) return `${name} ${i}`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { THEME_FORMAT, themeFileText, parseThemeFile, freeThemeName };
}
