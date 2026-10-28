'use strict';

// The plugin list and the plugin scan (poptart.scd's pluginList, runScan and scanPlugins).

function install(E) {
  // Known plugins as plain data for the browser. Falls back to VSTPlugin's on-disk cache before
  // the first in-session search, so a scanned machine shows its list at once on boot.
  E.pluginList = () => {
    let dict = E.vst?.plugins();
    if (dict == null || dict.size === 0) dict = E.vst?.readPlugins() ?? new Map();
    return [...dict.values()].map((desc) => ({
      id: String(desc.key),
      name: desc.name,
      manufacturer: desc.vendor,
      category: desc.category,
      format: desc.sdkVersion,
      isInstrument: desc.synth,
      numInputChannels: desc.inputs?.[0]?.channels ?? 0,
      numOutputChannels: desc.outputs?.[0]?.channels ?? 0,
      numParameters: desc.numParameters,
    }));
  };

  // One search per directory: VSTPlugin writes its cache when a search finishes, so each folder
  // saves its own work and its plugins become playable while the rest is probed. The brackets
  // around it are how Node knows a scan is running (it counts the probes off the log).
  E.runScan = (onDone) => {
    const dirs = E.searchDirs ?? [null]; // null = VSTPlugin's own default locations
    E.scanning = true;
    E.tell('/poptart/scanState', 'started', dirs.length);
    return E.fork(async () => {
      for (let i = 0; i < dirs.length; i++) {
        await E.vst.search({ dir: dirs[i], options: E.searchOptions, verbose: true });
        if (E.stopped) return;
        // This folder's plugins are in the dict (and the cache) as of now.
        E.tell('/poptart/scanState', 'folder', i + 1);
      }
      E.scanning = false;
      E.tell('/poptart/scanState', 'finished', E.vst.pluginCount());
      onDone?.();
    });
  };

  E.on('/poptart/scanPlugins', (msg) => {
    const requestId = msg[1];
    // extraPaths (msg[2]) not wired through; POPTART_VST_DIRS covers custom directories.
    E.runScan(() => {
      E.replyOk('/poptart/scanPlugins', requestId, E.toJson({ plugins: E.pluginList(), crashed: [] }));
    });
  });
}

module.exports = { install };
