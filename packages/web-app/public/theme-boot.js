'use strict';

// Applies the saved theme before the stylesheets paint, so there's no flash of the default. Loaded
// as a plain blocking script in the head of the app (index.html) and of every page of the guide
// (docs/), which is how the guide wears whatever theme the app has. Custom themes (the unsaved
// "custom" draft and any named saved theme) are a preset base plus per-variable inline overrides
// (see client.js). The palettes themselves are in themes.css.
(function () {
  var root = document.documentElement;
  // A theme handed over in the address (?theme={"base":…,"vars":{…}}) - the desktop's docs link,
  // opening the guide in a browser that has never seen the app's theme. Kept, so the guide's own
  // links go on showing it, and taken back out of the address.
  try {
    var params = new URLSearchParams(location.search);
    var given = params.get('theme');
    if (given) {
      var t0 = JSON.parse(given);
      var hasVars = t0 && t0.vars && Object.keys(t0.vars).length;
      if (hasVars) {
        localStorage.setItem('poptart-custom-base', t0.base || 'poptart');
        localStorage.setItem('poptart-custom-theme', JSON.stringify(t0.vars));
        localStorage.setItem('poptart-theme', 'custom');
      } else if (t0 && t0.base) {
        localStorage.setItem('poptart-theme', t0.base);
      }
      params.delete('theme');
      var rest = params.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    }
  } catch (e) {}
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
