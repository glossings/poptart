'use strict';

// "Prefer VST3" filtering for the plugin list (settings tab toggle, default on). Many plugins
// install both a VST2 and a VST3 build of the same thing; showing both just makes the browser
// and .synth()/.fx() autocomplete noisier and resolution-by-name ambiguous. When the setting is
// on, a VST2 entry is dropped whenever a VST3 entry with the same display name exists. Scanning
// is unaffected - both builds stay probed and loadable by exact id, this only shapes what the
// server exposes to the UI.

// VSTPlugin marks VST3 entries twice over: the dict key (our `id`) carries a literal `.vst3`
// extension, and sdkVersion (our `format`) reads "VST 3...". Either signal counts, so one field
// going missing can't misfile a plugin.
function isVst3(plugin) {
  return /\.vst3$/i.test(plugin.id ?? '') || /^VST ?3/i.test(plugin.format ?? '');
}

// The list with VST3-shadowed VST2 entries removed. Anything that isn't a VST2/VST3 name
// collision passes through untouched, order preserved.
function preferVst3(plugins) {
  const vst3Names = new Set(plugins.filter(isVst3).map((p) => p.name));
  return plugins.filter((p) => isVst3(p) || !vst3Names.has(p.name));
}

module.exports = { isVst3, preferVst3 };
