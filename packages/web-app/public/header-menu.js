'use strict';

// The header's ⋯ menu. A narrow window folds the theme picker, its edit button and the docs link
// out of the top bar (see the header breakpoints at the end of style.css), and this is where they
// go: the same choices, in the app's own context-menu widget (openCtxMenu's item format).

/**
 * The menu's entries.
 *   themes      - [value, label] per theme, in the picker's order
 *   current     - the value the picker holds now, ticked
 *   onTheme     - called with a theme's value
 *   onEditTheme - opens the theme colors panel
 *   onDocs      - opens the guide
 */
function headerMenuItems({ themes = [], current = '', onTheme = () => {}, onEditTheme = () => {}, onDocs = () => {} } = {}) {
  return [
    { head: 'theme' },
    ...themes.map(([value, label]) => [`${value === current ? '✓' : '  '} ${label}`, () => onTheme(value)]),
    ['edit theme colors…', onEditTheme, 'edit theme colors'],
    '-',
    ['docs ↗', onDocs, 'open the poptart guide in a new tab'],
  ];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { headerMenuItems };
}
