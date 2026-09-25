'use strict';

// Applies the saved theme before the stylesheets paint, so there's no flash of the default. Loaded
// as a plain blocking script in the head of the app (index.html) and of every page of the guide
// (docs/), which is how the guide wears whatever theme the app has. Custom themes (the unsaved
// "custom" draft and any named saved theme) are a preset base plus per-variable inline overrides
// (see client.js). The palettes themselves are in themes.css.
(function () {
  var root = document.documentElement;
  var t = 'poptart';
  var base = t;
  var vars = null;
  try {
    t = localStorage.getItem('poptart-theme') || 'poptart';
    base = t;
    if (t === 'custom') {
      base = localStorage.getItem('poptart-custom-base') || 'poptart';
      vars = JSON.parse(localStorage.getItem('poptart-custom-theme')) || {};
    } else {
      var saved = JSON.parse(localStorage.getItem('poptart-saved-themes') || '{}');
      if (saved[t]) { base = saved[t].base || 'poptart'; vars = saved[t].vars || {}; }
    }
  } catch (e) {}
  root.dataset.theme = base;
  if (vars) for (var k in vars) root.style.setProperty(k, vars[k]);
})();
