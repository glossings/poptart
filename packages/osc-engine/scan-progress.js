'use strict';

// Reading the plugin scan's progress out of the engine's log.
//
// VSTPlugin reports a search's results only when the whole search returns, which on a fresh
// machine is minutes away - but it prints a line per plugin as it goes, and scsynth's output is
// piped through sclang to us. So the running count comes from the log rather than from a message
// that doesn't exist: "probing <path>... " when a probe starts, a result word when it ends.
//
// That also gives the journal (see plugin-scan.js) the only name it will ever have for a probe
// that is in flight when the server dies. Not every crash is caught this way - a file that
// crashes while its headers are being read takes scsynth down BEFORE the probing line is printed
// (vst/PluginFactory.cpp does that work in-process, which is the whole reason for the pre-scan
// check) - but a probe that dies once it has announced itself is named exactly.
//
// The parsing is deliberately forgiving: this is a progress indicator, and a VSTPlugin release
// that rewords a line should cost a count, never a boot.

// "ok!", "crashed!", "failed! ...", "error! ...", "couldn't load! ...", "unexpected error! ..."
// - postResult() in sc/src/VSTPlugin.cpp.
const RESULT = /^(ok!|crashed!|failed!|error!|couldn't load!|unexpected error!)/i;
const PROBING = /probing (.+?)\.\.\. ?/;
// A whole line that is one absolute plugin path ("C:/..." on Windows - VSTPlugin prints forward
// slashes there) and nothing else.
const CACHED = /^(\/|[A-Za-z]:[\\/]).*\.(vst3|vst|dll|so)$/i;

class ScanProgress {
  constructor({ total = 0, onProbeStart = null, onProbeEnd = null, onChange = null } = {}) {
    this.total = total; // what our own walk of the plugin folders counted
    this.onProbeStart = onProbeStart;
    this.onProbeEnd = onProbeEnd;
    this.onChange = onChange;
    this.reset();
  }

  reset() {
    this.phase = 'idle'; // idle | scanning | done | stopped | died
    this.reason = null;
    this.probed = 0;
    this.failed = 0;
    this.found = null; // plugins VSTPlugin reported, once it has
    this.current = null; // the plugin being probed right now
    this.dir = null; // the folder being walked right now
    this.foldersDone = 0; // search directories finished - each one's plugins are usable from then
    this.startedAt = null;
    this.finishedAt = null;
    this._buf = '';
  }

  // Called from the /poptart/scanState message, which is authoritative about the scan's
  // boundaries - the log only knows about individual probes.
  begin({ total } = {}) {
    const wasScanning = this.phase === 'scanning';
    this.phase = 'scanning';
    if (typeof total === 'number') this.total = total;
    if (!wasScanning) {
      this.foldersDone = 0;
      this.probed = 0;
      this.failed = 0;
      this.found = null;
      this.startedAt = Date.now();
      this.finishedAt = null;
    }
    this._changed();
  }

  // A search directory finished (the engine script says so - see runScan in poptart.scd).
  folderDone(count) {
    if (this.phase !== 'scanning') return;
    this.foldersDone = count;
    this._changed();
  }

  end({ found = null } = {}) {
    if (this.phase !== 'scanning') return;
    this.phase = 'done';
    this.found = found ?? this.found;
    this.current = null;
    this.finishedAt = Date.now();
    this._changed();
  }

  // The scan ended because poptart is stopping the engine. Same loss of work as a death, but it
  // is nobody's fault and nothing should be reported to anyone.
  cancel() {
    if (this.phase !== 'scanning') return null;
    this.phase = 'stopped';
    this.current = null;
    this.finishedAt = Date.now();
    this._changed();
    return this.snapshot();
  }

  // The audio server went away with the scan unfinished. Keeps the counts - they are what the
  // message to the user is made of - and leaves `current` in place, because that name is the
  // best answer anyone has to "which plugin did it".
  abort(reason = 'the audio server exited') {
    if (this.phase !== 'scanning') return null;
    this.phase = 'died';
    this.reason = reason;
    this.finishedAt = Date.now();
    const at = this.snapshot();
    this._changed();
    return at;
  }

  // Feed every chunk of sclang's output, raw.
  feed(chunk) {
    this._buf += String(chunk);
    // Cheap guard against a line that never ends (a plugin printing a megabyte of its own).
    if (this._buf.length > 64 * 1024) this._buf = this._buf.slice(-4096);
    const parts = this._buf.split('\n');
    this._buf = parts.pop() ?? '';
    for (const line of parts) this._line(line);
    // "probing X... " has no newline until its result arrives, so the tail is read too - that is
    // the moment the name is worth knowing, not when the probe is over.
    const pending = PROBING.exec(this._buf);
    if (pending && this._buf.trimEnd().endsWith('...')) this._startProbe(pending[1]);
  }

  snapshot() {
    return {
      phase: this.phase,
      reason: this.reason,
      scanning: this.phase === 'scanning',
      probed: this.probed,
      failed: this.failed,
      total: this.total,
      found: this.found,
      current: this.current,
      dir: this.dir,
      foldersDone: this.foldersDone,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? (this.finishedAt ?? Date.now()) - this.startedAt : 0,
    };
  }

  _line(line) {
    const probing = PROBING.exec(line);
    if (probing) {
      this._startProbe(probing[1]);
      const rest = line.slice(probing.index + probing[0].length).trim();
      if (RESULT.test(rest)) this._endProbe(rest);
      return;
    }
    const trimmed = line.trim();
    if (this.current && RESULT.test(trimmed)) {
      this._endProbe(trimmed);
      return;
    }
    // A plugin VSTPlugin already knows (from its cache, or from earlier this session) is not
    // probed again - it is re-verified and printed as its bare path on a line of its own. Those
    // count as progress too, or a rescan of a machine with a warm cache reads "0/407" throughout.
    // Nothing for the journal here: nothing is loaded, so nothing can crash.
    if (this.phase === 'scanning' && CACHED.test(trimmed)) {
      this.probed += 1;
      this._changed();
      return;
    }
    const dir = /searching in '(.+)'/.exec(line);
    if (dir) {
      this.dir = dir[1];
      this._changed();
      return;
    }
    const found = /Found (\d+) plugins?\./.exec(line);
    if (found) this.found = (this.found ?? 0) + Number(found[1]);
  }

  _startProbe(pluginPath) {
    const clean = pluginPath.trim();
    if (!clean || clean === this.current) return; // the tail and then the full line: one probe
    if (this.current) this._endProbe(''); // a probe that never reported; don't strand the count
    this.current = clean;
    if (this.phase !== 'scanning') this.begin();
    this.onProbeStart?.(clean);
    this._changed();
  }

  _endProbe(result) {
    const done = this.current;
    this.current = null;
    this.probed += 1;
    if (result && !/^ok!/i.test(result)) this.failed += 1;
    this.onProbeEnd?.(done, result);
    this._changed();
  }

  _changed() {
    this.onChange?.(this.snapshot());
  }
}

module.exports = { ScanProgress, RESULT, PROBING };
