'use strict';

// VSTPlugin's class side, in Node: the plugin dictionary, the search and probe, the on-disk cache,
// and VSTPluginController - the handle on one VSTPlugin UGen in one synth.
//
// A port of VSTPlugin.sc, VSTPluginController.sc, VSTPluginDesc.sc and VSTPluginMIDIProxy.sc
// (VSTPlugin 0.6.2). Everything goes through the UGen's /u_cmd protocol and the server's /cmd
// plugin commands, exactly as those classes send them, so the probe host and the editor windows
// are the installed VSTPlugin's own - the poptart fork's patches included.
//
// Method names, argument order and callback shapes are the class library's, so code ported from
// sclang reads the same: `ctl.get(index, (value) => ...)`, `ctl.open(path, { action })` with
// action(ctl, ok), `ctl.writeProgram(path, (ctl, ok) => ...)`. A reply handler gets `msg` as an
// OSCFunc did: msg[0] the address, msg[1] the node, msg[2] the UGen index.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Buffer: ScBuffer } = require('./objects');

const f32 = (v) => ({ type: 'f', value: Number(v) });
const i32 = (v) => ({ type: 'i', value: Math.trunc(Number(v)) | 0 });
const blob = (bytes) => ({ type: 'b', value: Uint8Array.from(bytes, (x) => x & 0xFF) });

/** "~" expanded, as String.standardizePath does for the paths these classes send. */
function standardizePath(p) {
  const s = String(p);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

let uniqueId = 0;
/** VSTPlugin.prMakeTmpPath */
function makeTmpPath() {
  uniqueId += 1;
  return path.join(os.tmpdir(), `vst_${process.pid}_${uniqueId}`);
}

/** VSTPlugin.prMakeDest: a temp file path, a bufnum, a Buffer, or nothing (-1). */
function makeDest(dest) {
  if (dest == null) return i32(-1);
  if (typeof dest === 'string') return standardizePath(dest);
  if (typeof dest === 'object' && dest.bufnum != null) return i32(dest.bufnum);
  if (typeof dest === 'number') return i32(dest);
  throw new Error(`bad type '${typeof dest}' for 'dest' argument!`);
}

/** VSTPluginController.msg2string: [len, chars...] from `onset`. */
function msg2string(msg, onset = 0) {
  const len = Math.trunc(Number(msg[onset]));
  if (!(len > 0)) return '';
  let s = '';
  for (let i = onset + 1; i <= onset + len && i < msg.length; i++) s += String.fromCharCode(Math.trunc(Number(msg[i])));
  return s;
}

// --- VSTPluginDesc -----------------------------------------------------------------------------

const FLAG_NAMES = ['editor', 'synth', 'singlePrecision', 'doublePrecision', 'midiInput', 'midiOutput',
  'sysexInput', 'sysexOutput', 'bridged', 'editorResizable'];

const hex2int = (str) => parseInt(String(str).trim(), 16) || 0;

/** What a plugin says about itself (VSTPluginDesc). */
class PluginDesc {
  constructor() {
    this.key = null;
    this.path = null;
    this.name = null;
    this.vendor = null;
    this.category = null;
    this.version = null;
    this.sdkVersion = null;
    this.id = null;
    this.inputs = [];
    this.outputs = [];
    this.parameters = [];
    this.programs = [];
    for (const f of FLAG_NAMES) this[f] = false;
    this._paramIndex = new Map();
    this._presets = null;
  }

  get numParameters() { return this.parameters.length; }
  get numPrograms() { return this.programs.length; }
  get numPresets() { return this.presets.length; }

  /** The index of the parameter with this name, or null. */
  findParamIndex(name) {
    const i = this._paramIndex.get(String(name));
    return i == null ? null : i;
  }

  get isVst3() {
    return String(this.sdkVersion ?? '').includes('VST 3');
  }

  /** Where presets of a type live (VSTPluginDesc.presetFolder). */
  presetFolder(type = 'user') {
    const vst3 = this.isVst3;
    let folder = null;
    if (process.platform === 'win32') {
      folder = { user: process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Documents'),
        userFactory: process.env.APPDATA, sharedFactory: process.env.PROGRAMDATA }[type] ?? null;
      if (folder) folder = path.join(folder, vst3 ? 'VST3 Presets' : 'VST2 Presets');
    } else if (process.platform === 'darwin') {
      folder = { user: '~/Library/Audio/Presets', sharedFactory: '/Library/Audio/Presets' }[type] ?? null;
    } else {
      const vst = (type === 'user' ? '.' : '') + (vst3 ? 'vst3' : 'vst');
      folder = { user: '~', sharedFactory: '/usr/local/share', global: '/usr/share' }[type] ?? null;
      if (folder) folder = path.join(folder, vst, 'presets');
    }
    if (folder == null) return null;
    return path.join(standardizePath(folder), PluginDesc.bashPath(this.vendor ?? ''), PluginDesc.bashPath(this.name ?? ''));
  }

  presetPath(name, type = 'user') {
    return path.join(this.presetFolder(type), PluginDesc.bashPath(name)) + (this.isVst3 ? '.vstpreset' : '.fxp');
  }

  static bashPath(p) {
    return String(p).replace(/[/\\"?*:<>|]/g, '_');
  }

  /** The preset files on disk, read on first ask (VSTPluginDesc.scanPresets reads them at parse). */
  get presets() {
    if (this._presets == null) this.scanPresets();
    return this._presets;
  }

  scanPresets() {
    const vst3 = this.isVst3;
    const found = { user: [], userFactory: [], sharedFactory: [], global: [] };
    for (const type of Object.keys(found)) {
      const folder = this.presetFolder(type);
      if (!folder) continue;
      let names = [];
      try { names = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
      for (const e of names) {
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).slice(1);
        if ((vst3 && ext === 'vstpreset') || (!vst3 && (ext === 'fxp' || ext === 'FXP'))) {
          found[type].push({ name: path.basename(e.name, path.extname(e.name)), path: path.join(folder, e.name), type });
        }
      }
    }
    const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
    this._presets = Object.values(found).flatMap((l) => l.sort(cmp));
    return this;
  }

  findPreset(preset) {
    if (typeof preset === 'number') return this.presets[Math.trunc(preset)] ?? null;
    return this.presets.find((p) => p.name === String(preset)) ?? null;
  }
}

/** Reads lines off a text, as VSTPlugin.prGetLine does (skip: blank lines and comments). */
class LineReader {
  constructor(text) {
    this.lines = String(text).split('\n');
    this.at = 0;
  }

  next(skip = false) {
    while (this.at < this.lines.length) {
      let line = this.lines[this.at++];
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (skip && (line.length === 0 || line[0] === '#' || line[0] === ';')) continue;
      return line;
    }
    return null;
  }
}

function parseCount(line) {
  const at = line.indexOf('=');
  if (at < 0) throw new Error("expecting 'n=<number>'");
  return parseInt(line.slice(at + 1), 10) || 0;
}

function parseKeyValue(line) {
  const at = line.indexOf('=');
  if (at < 0) throw new Error("expecting 'key=value'");
  return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
}

const VERSION = [0, 6, 2];

/** VSTPluginDesc.prParse: one [plugin] section. */
function parseDesc(r, major = null, minor = null) {
  const info = new PluginDesc();
  const future = major != null && (major > VERSION[0] || (major === VERSION[0] && minor > VERSION[1]));
  const busses = () => {
    const n = parseCount(r.next());
    const out = [];
    for (let i = 0; i < n; i++) {
      const [channels, type, ...name] = r.next().split(',');
      out.push({ channels: parseInt(channels, 10) || 0, type: parseInt(type, 10) === 1 ? 'aux' : 'main', name: name.join(',').trim() });
    }
    return out;
  };
  let line = r.next(true);
  if (line !== '[plugin]') throw new Error('missing [plugin] header');
  for (;;) {
    line = r.next(true);
    if (line == null) throw new Error('EOF reached');
    if (line === '[parameters]') {
      const n = parseCount(r.next());
      info.parameters = [];
      for (let i = 0; i < n; i++) {
        const [name = '', label = '', , flags] = r.next().split(',');
        const fl = flags != null ? hex2int(flags) : 1;
        info.parameters.push({ name: name.trim(), label: label.trim(), automatable: (fl & 1) !== 0 });
      }
      info._paramIndex = new Map();
      // The last of a repeated name wins, as an IdentityDictionary built in order does.
      info.parameters.forEach((p, i) => info._paramIndex.set(p.name, i));
    } else if (line === '[inputs]') {
      info.inputs = busses();
    } else if (line === '[outputs]') {
      info.outputs = busses();
    } else if (line === '[programs]') {
      const n = parseCount(r.next());
      info.programs = [];
      for (let i = 0; i < n; i++) info.programs.push({ name: r.next() ?? '' });
    } else if (line === '[keys]') {
      const n = parseCount(r.next());
      const keys = [];
      for (let i = 0; i < n; i++) keys.push(r.next());
      info.key = keys[0] ?? null;
      return info;
    } else {
      const [key, value] = parseKeyValue(line);
      switch (key) {
        case 'path': info.path = value; break;
        case 'name': info.name = value; break;
        case 'vendor': info.vendor = value; break;
        case 'category': info.category = value; break;
        case 'version': info.version = value; break;
        case 'sdkversion': info.sdkVersion = value; break;
        case 'id': info.id = value; break;
        case 'pgmchange': case 'bypass': break;
        case 'flags': {
          const flags = hex2int(value);
          FLAG_NAMES.forEach((f, i) => { info[f] = (flags & (1 << i)) !== 0; });
          break;
        }
        default:
          if (!future) throw new Error(`bad key '${key}'`);
      }
    }
  }
}

/** VSTPlugin.prParseIni: every plugin of a search result or a cache file. */
function parseIni(text) {
  const r = new LineReader(text);
  let major = 0;
  let minor = 0;
  for (;;) {
    const line = r.next(true);
    if (line == null) throw new Error('missing [plugins] header');
    if (line === '[version]') {
      [major, minor] = r.next().split('.').map((x) => parseInt(x, 10) || 0);
      if (major === 0 && minor < 5) {
        throw new Error('The plugin cache file is incompatible with this version. Please perform a new search!');
      }
    }
    if (line === '[plugins]') {
      const n = parseCount(r.next(true));
      const out = [];
      for (let i = 0; i < n; i++) out.push(parseDesc(r, major, minor));
      return out;
    }
  }
}

/** VSTPlugin.prAddPlugin: a non-bridged plugin is never replaced by a bridged one. */
function addPlugin(dict, key, info) {
  const k = String(key);
  const had = dict.get(k);
  if (had && !had.bridged && info.bridged) return;
  dict.set(k, info);
}

/** Where VSTPlugin keeps its cache file (VSTPlugin.readPlugins). */
function cacheFilePath(dir = null) {
  const arch = { ia32: 'i386', x64: 'amd64', arm: 'arm', arm64: 'aarch64' }[process.arch];
  if (!arch) throw new Error(`unknown CPU architecture: ${process.arch}`);
  const file = `cache_${arch}.ini`;
  if (dir != null) return path.join(dir, file);
  let appdata = process.env.XDG_DATA_HOME;
  if (!appdata) {
    if (process.platform === 'darwin') appdata = path.join(os.homedir(), 'Library', 'Application Support');
    else if (process.platform === 'win32') appdata = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    else appdata = path.join(os.homedir(), '.local', 'share');
  }
  return path.join(appdata, 'vstplugin', 'sc', file);
}

// --- VSTPlugin (the class side) ----------------------------------------------------------------

class VstHost {
  /** server: a ../server Server. post(text)/warn(text): the engine's log. */
  constructor(server, { post = (t) => console.log(t), warn = (t) => console.warn(`WARNING: ${t}`) } = {}) {
    this.server = server;
    this.post = post;
    this.warn = warn;
    this.dict = new Map(); // key -> PluginDesc, the class's pluginDict[server]
    this._syncId = 0x40000000;
  }

  /** VSTPlugin.plugins(server): key -> desc (a desc may sit under its key and its path). */
  plugins() {
    return this.dict;
  }

  /** VSTPlugin.pluginList: each plugin once, sorted by name on request. */
  pluginList(sorted = false) {
    const list = [...new Set(this.dict.values())];
    if (sorted) list.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'accent' }));
    return list;
  }

  pluginKeys() {
    return this.pluginList().map((d) => d.key);
  }

  /** How many keys the dictionary holds - what VSTPlugin.plugins(server).size says. */
  pluginCount() {
    return this.dict.size;
  }

  /** A /sync that waits as long as the server needs: a search can take minutes. */
  _syncLong() {
    const id = this._syncId++;
    return new Promise((resolve) => {
      const off = this.server.on('/synced', (a) => {
        if (a[0] !== id) return;
        off();
        resolve();
      });
      this.server.send(['/sync', id]);
    });
  }

  /** VSTPlugin.readPlugins: the on-disk cache, as a fresh key -> desc Map. */
  readPlugins(dir = null) {
    const dict = new Map();
    const file = cacheFilePath(dir);
    if (!fs.existsSync(file)) {
      if (dir != null) this.warn(`Couldn't find plugin cache file in ${dir}!`);
      else this.warn("Couldn't find plugin cache file! Make sure to call VSTPlugin.search at least once.");
      return dict;
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      this.warn(`Failed to read plugin info file (${file})!`);
      return dict;
    }
    for (const info of parseIni(text)) addPlugin(dict, info.key, info);
    return dict;
  }

  static searchMsg(dir, options = null, verbose = false, dest = null) {
    let dirs = dir == null ? [] : (Array.isArray(dir) ? dir : [dir]);
    dirs = dirs.map(standardizePath);
    let save = true;
    let parallel = true;
    let timeout = null;
    let exclude = [];
    let cacheFileDir = null;
    for (const [k, v] of Object.entries(options ?? {})) {
      switch (k) {
        case 'save': save = !!v; break;
        case 'parallel': parallel = !!v; break;
        case 'timeout': timeout = v == null ? null : Number(v); break;
        case 'exclude': exclude = v == null ? [] : (Array.isArray(v) ? v : [v]); break;
        case 'cacheFileDir': cacheFileDir = v; break;
        default: throw new Error(`unknown option '${k}'`);
      }
    }
    exclude = exclude.map(standardizePath);
    const flags = (verbose ? 1 : 0) | (save ? 2 : 0) | (parallel ? 4 : 0);
    return ['/cmd', '/vst_search', i32(flags), makeDest(dest), f32(timeout ?? 0), i32(dirs.length), ...dirs,
      i32(exclude.length), ...exclude, ...(cacheFileDir != null ? [String(cacheFileDir)] : [])];
  }

  /**
   * VSTPlugin.search: probes `dir` (one folder, several, or null for VSTPlugin's default places)
   * and adds what it finds. `action` runs when it is done; the promise resolves then too.
   */
  async search({ dir = null, options = null, verbose = true, action = null } = {}) {
    if (!this.server.running) {
      this.warn('VSTPlugin.search requires the Server to be running!');
      action?.();
      return;
    }
    const tmp = makeTmpPath();
    this.server.send(VstHost.searchMsg(dir, options, verbose, tmp));
    await this._syncLong();
    let text = null;
    try {
      text = fs.readFileSync(tmp, 'utf8');
      try { fs.unlinkSync(tmp); } catch { this.warn(`Could not delete tmp file: ${tmp}`); }
    } catch {
      this.post('ERROR: Failed to read tmp file!');
    }
    if (text != null) {
      for (const info of parseIni(text)) addPlugin(this.dict, info.key, info);
    }
    action?.();
  }

  stopSearch() {
    this.server.send(['/cmd', '/vst_search_stop']);
  }

  /** VSTPlugin.clear: forgets every plugin, here and in the server (remove: and its temp file). */
  clear(remove = true) {
    this.dict = new Map();
    this.server.send(['/cmd', '/vst_clear', i32(remove ? 1 : 0)]);
  }

  readCache(dir) {
    this.server.send(['/cmd', '/vst_cache_read', String(dir)]);
  }

  /**
   * VSTPlugin.prQuery: the desc for a key or path - straight from the dictionary when it is there
   * (action runs at once), otherwise probed by the server and stored under its key and path.
   * action(desc) with null when it could not be probed. Returns a promise of the same.
   */
  query(p, action = null) {
    const known = this.dict.get(String(p));
    if (known) {
      action?.(known);
      return Promise.resolve(known);
    }
    return (async () => {
      const tmp = makeTmpPath();
      this.server.send(['/cmd', '/vst_query', standardizePath(p), makeDest(tmp)]);
      await this._syncLong();
      let info = null;
      if (fs.existsSync(tmp)) {
        let text = null;
        try { text = fs.readFileSync(tmp, 'utf8'); } catch { this.post('ERROR: Failed to read tmp file!'); }
        try { fs.unlinkSync(tmp); } catch { this.warn(`Could not delete tmp file: ${tmp}`); }
        if (text != null) {
          info = parseDesc(new LineReader(text));
          addPlugin(this.dict, info.key, info);
          addPlugin(this.dict, p, info);
        }
      }
      action?.(info);
      return info;
    })();
  }

  /** The controller for the VSTPlugin at `synthIndex` in `synth`. */
  controller(synth, synthIndex) {
    return new VstController(this.server, synth, synthIndex, this);
  }
}

// --- VSTPluginMIDIProxy ------------------------------------------------------------------------

/** ctl.midi: MIDIOut's surface, sending to the plugin. */
class VstMidiProxy {
  constructor(owner) {
    this.owner = owner;
    this.uid = null;
  }

  get latency() { return 0; }

  write(len, hiStatus, loStatus, a = 0, b = 0, detune = null) {
    this.owner.sendMidi(hiStatus | loStatus, a, b, detune);
  }

  writeMsg(len, hiStatus, loStatus, a = 0, b = 0, detune = null) {
    return this.owner.sendMidiMsg(hiStatus | loStatus, a, b, detune);
  }

  static _frac(x) { return x - Math.floor(x); }

  noteOn(chan, note = 60, veloc = 64) {
    this.write(3, 0x90, Math.trunc(chan), Math.trunc(note), Math.trunc(veloc), VstMidiProxy._frac(note) * 100);
  }

  noteOnMsg(chan, note = 60, veloc = 64) {
    return this.writeMsg(3, 0x90, Math.trunc(chan), Math.trunc(note), Math.trunc(veloc), VstMidiProxy._frac(note) * 100);
  }

  noteOff(chan, note = 60, veloc = 64) {
    this.write(3, 0x80, Math.trunc(chan), Math.trunc(note), Math.trunc(veloc), VstMidiProxy._frac(note) * 100);
  }

  noteOffMsg(chan, note = 60, veloc = 64) {
    return this.writeMsg(3, 0x80, Math.trunc(chan), Math.trunc(note), Math.trunc(veloc), VstMidiProxy._frac(note) * 100);
  }

  polyTouch(chan, note = 60, val = 64) { this.write(3, 0xA0, Math.trunc(chan), Math.trunc(note), Math.trunc(val)); }
  polyTouchMsg(chan, note = 60, val = 64) { return this.writeMsg(3, 0xA0, Math.trunc(chan), Math.trunc(note), Math.trunc(val)); }
  control(chan, ctlNum = 7, val = 64) { this.write(3, 0xB0, Math.trunc(chan), Math.trunc(ctlNum), Math.trunc(val)); }
  controlMsg(chan, ctlNum = 7, val = 64) { return this.writeMsg(3, 0xB0, Math.trunc(chan), Math.trunc(ctlNum), Math.trunc(val)); }
  program(chan, num = 1) { this.write(2, 0xC0, Math.trunc(chan), Math.trunc(num)); }
  programMsg(chan, num = 1) { return this.writeMsg(2, 0xC0, Math.trunc(chan), Math.trunc(num)); }
  touch(chan, val = 64) { this.write(2, 0xD0, Math.trunc(chan), Math.trunc(val)); }
  touchMsg(chan, val = 64) { return this.writeMsg(2, 0xD0, Math.trunc(chan), Math.trunc(val)); }

  bend(chan, val = 8192) {
    const v = Math.trunc(val);
    this.write(3, 0xE0, Math.trunc(chan), v & 127, v >> 7);
  }

  bendMsg(chan, val = 8192) {
    const v = Math.trunc(val);
    return this.writeMsg(3, 0xE0, Math.trunc(chan), v & 127, v >> 7);
  }

  allNotesOff(chan) { this.control(chan, 123, 0); }
  allNotesOffMsg(chan) { return this.controlMsg(chan, 123, 0); }

  songPtr(songPtr) {
    const p = Math.trunc(songPtr);
    this.write(4, 0xF0, 0x02, p & 0x7f, (p >> 7) & 0x7f);
  }

  songSelect(song) { this.write(3, 0xF0, 0x03, Math.trunc(song)); }
  midiClock() { this.write(1, 0xF0, 0x08); }
  start() { this.write(1, 0xF0, 0x0A); }
  continue() { this.write(1, 0xF0, 0x0B); }
  stop() { this.write(1, 0xF0, 0x0C); }
  reset() { this.write(1, 0xF0, 0x0F); }
  sysex(packet) { this.owner.sendSysex(packet); }
  sysexMsg(packet) { return this.owner.sendSysexMsg(packet); }
}

// --- VSTPluginController -----------------------------------------------------------------------

class VstController {
  /** server: the ../server Server; synth: its node object; synthIndex: the UGen's index in the def. */
  constructor(server, synth, synthIndex, host = null) {
    if (synth == null) throw new Error("'synth' argument must not be nil");
    this.server = server;
    this.synth = synth;
    this.synthIndex = synthIndex;
    this.host = host ?? new VstHost(server);
    this.info = null;
    this.wait = -1;
    this.midi = new VstMidiProxy(this);
    this._program = null;
    this.latency = null;
    // callbacks
    this.parameterAutomated = null;
    this.midiReceived = null;
    this.sysexReceived = null;
    this.latencyChanged = null;
    this.pluginCrashed = null;
    this.parameterCache = null;
    this.programCache = null;
    this.currentPreset = null;
    this._window = false;
    this._loading = false;
    this._needQueryParams = true;
    this._needQueryPrograms = true;
    this._deferred = false;
    this._dependants = new Set();
    this._oscFuncs = [];
    this._init();
  }

  _post(text) { this.host.post(text); }
  _warn(text) { this.host.warn(text); }

  _init() {
    const add = (fn, p) => this._oscFuncs.push(this.makeOscFunc(fn, p));
    add((msg) => {
      const index = Math.trunc(msg[3]);
      const value = Number(msg[4]);
      const display = msg.length > 5 ? msg2string(msg, 5) : null;
      if (this.parameterCache && index < this.parameterCache.length) {
        this.parameterCache[index] = [value, display];
        this.changed('param', index, value, display);
      } else this._warn(`parameter index ${index} out of range!`);
    }, '/vst_param');
    add((msg) => {
      this._program = Math.trunc(msg[3]);
      this.changed('program_index', this._program);
    }, '/vst_program_index');
    add((msg) => {
      const index = Math.trunc(msg[3]);
      const name = msg2string(msg, 4);
      if (this.programCache && index < this.programCache.length) {
        this.programCache[index] = name;
        this.changed('program_name', index, name);
      } else this._warn(`program number ${index} out of range!`);
    }, '/vst_program');
    add((msg) => {
      const index = Math.trunc(msg[3]);
      const value = Number(msg[4]);
      this.parameterAutomated?.(index, value);
      this.changed('automated', index, value);
    }, '/vst_auto');
    add((msg) => {
      this.latency = Math.trunc(msg[3]);
      this.latencyChanged?.(this.latency);
      this.changed('latency', this.latency);
    }, '/vst_latency');
    add(() => { this._queryParams(); }, '/vst_update');
    add(() => {
      this._warn(`plugin '${this.info?.name}' crashed`);
      this.close();
      this.pluginCrashed?.();
      this.changed('crashed');
    }, '/vst_crash');
    add((msg) => {
      this.midiReceived?.(...msg.slice(3).map((x) => Math.trunc(Number(x))));
    }, '/vst_midi');
    add((msg) => {
      const rest = msg.slice(3);
      const bytes = rest.length === 1 && rest[0] instanceof Uint8Array ? rest[0] : rest.map((x) => Number(x));
      this.sysexReceived?.(Int8Array.from(bytes, (x) => (x << 24) >> 24));
    }, '/vst_sysex');
    // synth.onFree: tidy up after the node goes.
    this._offEnd = this.server.on('/n_end', (a) => {
      if (this.synth && Number(a[0]) === this.synth.nodeID) this._free();
    });
  }

  _free() {
    for (const f of this._oscFuncs) f.free();
    this._oscFuncs = [];
    this._offEnd?.();
    this._offEnd = null;
    this.synth = null;
    this._clear();
    this.changed('free');
  }

  // --- dependants (Object.changed / addDependant) ---------------------------------------------

  addDependant(fn) {
    this._dependants.add(fn);
    if (this.isOpen) {
      if (this._needQueryParams) this._queryParams();
      if (this._needQueryPrograms) this._queryPrograms();
    }
  }

  removeDependant(fn) { this._dependants.delete(fn); }

  changed(what, ...args) {
    for (const fn of [...this._dependants]) {
      try { fn(this, what, ...args); } catch (err) { this._warn(`dependant: ${err.message}`); }
    }
  }

  // --- messages -------------------------------------------------------------------------------

  sendMsg(cmd, ...args) {
    if (this.synth == null) {
      this._warn('VSTPluginController: empty controller (no Synth)');
      return;
    }
    this.server.send(['/u_cmd', this.synth.nodeID, this.synthIndex, cmd, ...args]);
  }

  makeMsg(cmd, ...args) {
    return ['/u_cmd', this.synth.nodeID, this.synthIndex, cmd, ...args];
  }

  /**
   * OSCFunc on one of this UGen's replies: fn(msg) for each, msg[0] the address. `template`
   * matches the arguments after node and index. The result has free() and oneShot().
   */
  makeOscFunc(fn, address, ...template) {
    const node = this.synth.nodeID;
    const index = this.synthIndex;
    let once = false;
    const handle = {
      free: () => off(),
      oneShot: () => { once = true; return handle; },
    };
    const off = this.server.on(address, (a) => {
      if (Number(a[0]) !== node || Number(a[1]) !== index) return;
      for (let i = 0; i < template.length; i++) if (Number(a[2 + i]) !== Number(template[i])) return;
      if (once) off();
      fn([address, ...a]);
    });
    return handle;
  }

  _checkPlugin(method) {
    if (!this.isOpen) throw new Error(`cannot call '${method}' method without plugin!`);
  }

  _checkEmpty(method) {
    if (this.synth == null) throw new Error(`cannot call '${method}' method without Synth`);
  }

  // --- editor ---------------------------------------------------------------------------------

  editor(show = true) {
    if (this._window) this.sendMsg('/vis', i32(show ? 1 : 0));
    else this._post('no editor!');
  }

  editorMsg(show = true) { return this.makeMsg('/vis', i32(show ? 1 : 0)); }
  moveEditor(x, y) { this.sendMsg('/pos', i32(x), i32(y)); }
  moveEditorMsg(x, y) { return this.makeMsg('/pos', i32(x), i32(y)); }
  resizeEditor(w, h) { this.sendMsg('/size', i32(w), i32(h)); }
  resizeEditorMsg(w, h) { return this.makeMsg('/size', i32(w), i32(h)); }
  haveEditor() { return this._window; }

  // --- open / close ---------------------------------------------------------------------------

  static _mode(mode) {
    if (mode == null) return 0;
    const m = { auto: 0, sandbox: 1, bridge: 2 }[String(mode)];
    if (m == null) throw new Error(`bad value '${mode}' for 'mode' argument`);
    return m;
  }

  /**
   * Opens a plugin by key or path. action(ctl, ok) once it is in (or could not be). The plugin is
   * probed first when the host has no desc for it, as the class does.
   */
  open(p = null, { editor = true, verbose = false, action = null, multiThreading = false, mode = null } = {}) {
    this._checkEmpty('open');
    if (this._loading) {
      this._warn('VSTPluginController: already opening another plugin');
      action?.(this, false);
      return this;
    }
    if (p == null) {
      if (this.info) p = this.info.key;
      else throw new Error("'path' is nil but VSTPlugin doesn't have a plugin info");
    }
    const intMode = VstController._mode(mode);
    this._loading = true;
    this.host.query(p, (info) => {
      if (info) {
        this._clear();
        this._loading = true;
        this.makeOscFunc((msg) => {
          const loaded = Number(msg[3]) !== 0;
          if (loaded) {
            this._window = Number(msg[4]) !== 0;
            this.latency = Math.trunc(msg[5]);
            this.info = info;
            this.parameterCache = Array.from({ length: info.numParameters }, () => [0, null]);
            this._queryParams();
            this.programCache = info.programs.map((x) => x.name);
            this._needQueryPrograms = false;
            this._program = 0;
            if (verbose) this._post(describe(info));
          } else {
            this._post(`ERROR: couldn't open '${p}'`);
          }
          this._loading = false;
          this._deferred = multiThreading || String(mode) !== 'auto' || info.bridged;
          this.changed('open', p, loaded);
          action?.(this, loaded);
          if (this.latency != null) this.latencyChanged?.(this.latency);
        }, '/vst_open').oneShot();
        this.sendMsg('/open', standardizePath(p), i32(editor ? 1 : 0), i32(multiThreading ? 1 : 0), i32(intMode));
      } else {
        this._post(`ERROR: couldn't open '${p}'`);
        this._loading = false;
        action?.(this, false);
      }
    });
    return this;
  }

  openMsg(p = null, { editor = false, multiThreading = false, mode = null } = {}) {
    if (p == null) {
      if (this.info) p = this.info.key;
      else throw new Error("'path' is nil but VSTPlugin doesn't have a plugin info");
    }
    return this.makeMsg('/open', standardizePath(p), i32(editor ? 1 : 0), i32(multiThreading ? 1 : 0), i32(VstController._mode(mode)));
  }

  get isOpen() {
    return this.info != null;
  }

  _clear() {
    this._window = false;
    this.latency = null;
    this.info = null;
    this.parameterCache = null;
    this._needQueryParams = false;
    this.programCache = null;
    this._needQueryPrograms = true;
    this._program = null;
    this.currentPreset = null;
    this._loading = false;
  }

  close() {
    if (this.isOpen) {
      this.sendMsg('/close');
      this._clear();
      this.changed('close');
    }
  }

  closeMsg() { return this.makeMsg('/close'); }
  reset(async = false) { this.sendMsg('/reset', i32(async ? 1 : 0)); }
  resetMsg(async = false) { return this.makeMsg('/reset', i32(async ? 1 : 0)); }

  // --- parameters -----------------------------------------------------------------------------

  get numParameters() { return this.info?.numParameters ?? 0; }

  /** set(index or name, value, ...): values go out as floats, indices as ints. */
  set(...args) { this.sendMsg('/set', ...VstController._pairs(args)); }
  setMsg(...args) { return this.makeMsg('/set', ...VstController._pairs(args)); }

  static _pairs(args) {
    return args.map((v, i) => (i % 2 === 0 ? (typeof v === 'number' ? i32(v) : String(v)) : f32(v)));
  }

  setn(...args) { this.server.send(this.setnMsg(...args)); }

  setnMsg(...args) {
    const out = [];
    for (let i = 0; i + 1 < args.length; i += 2) {
      const index = typeof args[i] === 'number' ? i32(args[i]) : String(args[i]);
      const values = args[i + 1];
      if (Array.isArray(values)) out.push(index, i32(values.length), ...values.map(f32));
      else out.push(index, i32(1), f32(values));
    }
    return this.makeMsg('/setn', ...out);
  }

  _resolve(index) {
    if (typeof index === 'number') return index;
    const i = this.info?.findParamIndex(index);
    if (i == null) throw new Error(`unknown parameter '${index}'`);
    return i;
  }

  /** action(value) with the parameter's current value, asked of the plugin. */
  get(index, action) {
    const i = this._resolve(index);
    this.makeOscFunc((msg) => action?.(msg[4]), '/vst_set', i).oneShot();
    this.sendMsg('/get', i32(i));
  }

  /** action(values) with `count` parameters from `index` (-1: to the end). */
  getn(index = 0, count = -1, action = null) {
    const i = this._resolve(index);
    this.makeOscFunc((msg) => action?.(msg.slice(5)), '/vst_setn', i).oneShot();
    this.sendMsg('/getn', i32(i), i32(count));
  }

  /** map(index, bus, ...): a control bus (or a bus index) maps with /map, an audio bus with /mapa. */
  map(...args) {
    for (const m of this.mapMsg(...args)) this.server.send(m);
  }

  mapMsg(...args) {
    const kr = [];
    const ar = [];
    for (let i = 0; i + 1 < args.length; i += 2) {
      const index = typeof args[i] === 'number' ? i32(args[i]) : String(args[i]);
      const bus = args[i + 1];
      const b = bus && typeof bus === 'object' ? bus : { rate: 'control', index: Number(bus), numChannels: 1 };
      if (b.rate === 'audio') ar.push(index, i32(b.index), i32(b.numChannels));
      else if (b.rate === 'control') kr.push(index, i32(b.index), i32(b.numChannels));
    }
    const out = [];
    if (kr.length) out.push(this.makeMsg('/map', ...kr));
    if (ar.length) out.push(this.makeMsg('/mapa', ...ar));
    return out;
  }

  mapn(...args) { this.sendMsg('/map', ...args); }
  mapnMsg(...args) { return this.makeMsg('/map', ...args); }
  mapan(...args) { this.sendMsg('/mapa', ...args); }
  mapanMsg(...args) { return this.makeMsg('/mapa', ...args); }
  unmap(...args) { this.sendMsg('/unmap', ...args.map((v) => (typeof v === 'number' ? i32(v) : String(v)))); }
  unmapMsg(...args) { return this.makeMsg('/unmap', ...args.map((v) => (typeof v === 'number' ? i32(v) : String(v)))); }

  // --- programs -------------------------------------------------------------------------------

  get numPrograms() { return this.info?.numPrograms ?? 0; }

  get program() { return this._program; }

  set program(number) {
    this._checkPlugin('program_');
    if (number >= 0 && number < this.numPrograms) {
      this.sendMsg('/program_set', i32(number));
      this._program = number;
      this.changed('program_index', number);
      this._queryParams();
    } else throw new Error(`program number ${number} out of range`);
  }

  programMsg(number) { return this.makeMsg('/program_set', i32(number)); }

  get programName() {
    return this._program != null ? this.programCache?.[this._program] ?? null : null;
  }

  set programName(name) {
    this._checkPlugin('programName_');
    this.sendMsg('/program_name', String(name));
  }

  programNameMsg(name) { return this.makeMsg('/program_name', String(name)); }

  _fileCmd(cmd, reply, p, action, async, after) {
    const file = standardizePath(p);
    this.makeOscFunc((msg) => {
      const ok = Number(msg[3]) !== 0;
      action?.(this, ok);
      after?.();
    }, reply).oneShot();
    this.sendMsg(cmd, file, i32(async ? 1 : 0));
  }

  /** Loads a program file (.fxp / .vstpreset); action(ctl, ok). */
  readProgram(p, action = null, async = true) {
    this._checkPlugin('readProgram');
    this._fileCmd('/program_read', '/vst_program_read', p, action, async, () => this._queryParams());
  }

  readProgramMsg(dest, async = true) { return this.makeMsg('/program_read', makeDest(dest), i32(async ? 1 : 0)); }

  readBank(p, action = null, async = true) {
    this._checkPlugin('readBank');
    this._fileCmd('/bank_read', '/vst_bank_read', p, action, async, () => { this._queryParams(); this._queryPrograms(); });
  }

  readBankMsg(dest, async = true) { return this.makeMsg('/bank_read', makeDest(dest), i32(async ? 1 : 0)); }

  /** Writes the plugin's program to a file; action(ctl, ok). */
  writeProgram(p, action = null, async = true) {
    this._checkPlugin('writeProgram');
    this._fileCmd('/program_write', '/vst_program_write', p, action, async);
  }

  writeProgramMsg(dest, async = true) { return this.makeMsg('/program_write', makeDest(dest), i32(async ? 1 : 0)); }

  writeBank(p, action = null, async = true) {
    this._checkPlugin('writeBank');
    this._fileCmd('/bank_write', '/vst_bank_write', p, action, async);
  }

  writeBankMsg(dest, async = true) { return this.makeMsg('/bank_write', makeDest(dest), i32(async ? 1 : 0)); }

  /** A program from bytes (any size, through a temp file); action(ctl, ok). */
  setProgramData(data, action = null, async = true) {
    this._checkPlugin('setProgramData');
    this._setData(data, action, false, async);
  }

  setBankData(data, action = null, async = true) {
    this._checkPlugin('setBankData');
    this._setData(data, action, true, async);
  }

  _setData(data, action, bank, async) {
    const tmp = makeTmpPath();
    try {
      fs.writeFileSync(tmp, toBytes(data));
    } catch {
      throw new Error('Failed to write data');
    }
    const cb = (self, ok) => {
      action?.(self, ok);
      try { fs.unlinkSync(tmp); } catch { this._warn(`Could not delete data file: ${tmp}`); }
    };
    if (bank) this.readBank(tmp, cb, async);
    else this.readProgram(tmp, cb, async);
  }

  /** The program's bytes (through a temp file); action(data), a Buffer, or null on failure. */
  getProgramData(action, async = true) {
    this._checkPlugin('getProgramData');
    this._getData(action, false, async);
  }

  getBankData(action, async = true) {
    this._checkPlugin('getBankData');
    this._getData(action, true, async);
  }

  _getData(action, bank, async) {
    const tmp = makeTmpPath();
    const cb = (self, ok) => {
      let data = null;
      if (ok) {
        try {
          data = fs.readFileSync(tmp);
        } catch {
          this._post('ERROR: Failed to read data');
        }
        try { fs.unlinkSync(tmp); } catch { this._warn(`Could not delete data file: ${tmp}`); }
      } else this._warn("Couldn't read data file");
      action?.(data);
    };
    if (bank) this.writeBank(tmp, cb, async);
    else this.writeProgram(tmp, cb, async);
  }

  /** Streams a program to the plugin through a server Buffer (for a server on another machine). */
  sendProgramData(data, wait = null, action = null, async = true) {
    this._checkPlugin('sendProgramData');
    this._sendData(data, wait ?? this.wait, action, false, async);
  }

  sendBankData(data, wait = null, action = null, async = true) {
    this._checkPlugin('sendBankData');
    this._sendData(data, wait ?? this.wait, action, true, async);
  }

  _sendData(data, wait, action, bank, async) {
    const sym = bank ? 'bank' : 'program';
    const bytes = toBytes(data);
    const values = Array.from(bytes, (x) => (x << 24) >> 24);
    let buffer = null;
    this.makeOscFunc((msg) => {
      buffer?.free();
      action?.(this, Number(msg[3]) !== 0);
      this._queryParams(wait);
      if (bank) this._queryPrograms(wait);
    }, `/vst_${sym}_read`).oneShot();
    buffer = ScBuffer.sendCollection(this.server, values, 1, (buf) => {
      this.sendMsg(`/${sym}_read`, makeDest(buf), i32(async ? 1 : 0));
    });
  }

  /** Reads the program back through a server Buffer; action(data) with a Buffer or null. */
  receiveProgramData(wait = null, timeout = 3, action = null, async = true) {
    this._checkPlugin('receiveProgramData');
    return this._receiveData(action, false, async);
  }

  receiveBankData(wait = null, timeout = 3, action = null, async = true) {
    this._checkPlugin('receiveBankData');
    return this._receiveData(action, true, async);
  }

  async _receiveData(action, bank, async) {
    const sym = bank ? 'bank' : 'program';
    const buf = new ScBuffer(this.server);
    this.sendMsg(`/${sym}_write`, makeDest(buf), i32(async ? 1 : 0));
    await this.host._syncLong();
    await buf.query();
    const n = (buf.numFrames ?? 0) * (buf.numChannels ?? 0);
    const values = n > 0 ? await buf.getn(0, n) : [];
    buf.free();
    const data = values.length ? Buffer.from(Int8Array.from(values, (x) => Math.trunc(x)).buffer) : null;
    action?.(data);
    return data;
  }

  // --- MIDI / sysex ---------------------------------------------------------------------------

  sendMidi(status, data1 = 0, data2 = 0, detune = null) {
    this.sendMsg('/midi_msg', blob([status, data1, data2]), f32(detune ?? 0));
  }

  sendMidiMsg(status, data1 = 0, data2 = 0, detune = null) {
    return this.makeMsg('/midi_msg', blob([status, data1, data2]), f32(detune ?? 0));
  }

  sendSysex(msg) { this.server.send(this.sendSysexMsg(msg)); }

  sendSysexMsg(msg) {
    const bytes = toBytes(msg);
    if (bytes.length > 1600) this._warn('sending sysex data larger than 1600 bytes is risky');
    return this.makeMsg('/midi_sysex', blob(bytes));
  }

  // --- transport ------------------------------------------------------------------------------

  setTempo(bpm = 120) { this.sendMsg('/tempo', f32(bpm)); }
  setTempoMsg(bpm = 120) { return this.makeMsg('/tempo', f32(bpm)); }
  setTimeSignature(num = 4, denom = 4) { this.sendMsg('/time_sig', i32(num), i32(denom)); }
  setTimeSignatureMsg(num = 4, denom = 4) { return this.makeMsg('/time_sig', i32(num), i32(denom)); }
  setPlaying(b) { this.sendMsg('/transport_play', i32(b ? 1 : 0)); }
  setPlayingMsg(b) { return this.makeMsg('/transport_play', i32(b ? 1 : 0)); }
  setTransportPos(pos) { this.sendMsg('/transport_set', f32(pos)); }
  setTransportPosMsg(pos) { return this.makeMsg('/transport_set', f32(pos)); }

  /** action(beats) with the plugin's transport position. */
  getTransportPos(action) {
    this._checkPlugin('getTransportPos');
    this.makeOscFunc((msg) => action?.(msg[3]), '/vst_transport').oneShot();
    this.sendMsg('/transport_get');
  }

  // --- advanced -------------------------------------------------------------------------------

  canDo(what, action) {
    this._checkPlugin('canDo');
    this.makeOscFunc((msg) => action?.(Math.trunc(msg[3])), '/vst_can_do').oneShot();
    this.sendMsg('/can_do', String(what));
  }

  vendorMethod(index = 0, value = 0, ptr = null, opt = 0, action = null, async = true) {
    this._checkPlugin('vendorMethod');
    this.makeOscFunc((msg) => action?.(Math.trunc(msg[3])), '/vst_vendor_method').oneShot();
    this.sendMsg('/vendor_method', i32(index), i32(value), blob(ptr ? toBytes(ptr) : []), f32(opt), i32(async ? 1 : 0));
  }

  vendorMethodMsg(index = 0, value = 0, ptr = null, opt = 0, action = null, async = true) {
    return this.makeMsg('/vendor_method', i32(index), i32(value), blob(ptr ? toBytes(ptr) : []), f32(opt), i32(async ? 1 : 0));
  }

  // --- queries (only while something depends on the caches) -----------------------------------

  _queryParams(wait = null) {
    if (this._dependants.size > 0) {
      this._query(wait, this.numParameters, '/param_query');
      this._needQueryParams = false;
    } else this._needQueryParams = true;
  }

  _queryPrograms(wait = null) {
    if (this._dependants.size > 0) {
      this._query(wait, this.numPrograms, '/program_query');
      this._needQueryPrograms = false;
    } else this._needQueryPrograms = true;
  }

  async _query(wait, num, cmd) {
    const w = wait ?? this.wait;
    const div = Math.floor(num / 16);
    const mod = num % 16;
    for (let i = 0; i < div; i++) {
      this.sendMsg(cmd, i32(i * 16), i32(16));
      if (w >= 0) await new Promise((r) => setTimeout(r, w * 1000));
      else await this.host._syncLong();
    }
    if (mod > 0) this.sendMsg(cmd, i32(num - mod), i32(mod));
  }
}

function toBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array || data instanceof Int8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.from(Int8Array.from(data).buffer);
  throw new Error('expected bytes (Buffer, Uint8Array, Int8Array or an array)');
}

/** VSTPluginDesc.prToString, for open(verbose: true). */
function describe(d) {
  const bus = (bs) => bs.map((b) => (d.isVst3 ? `[${b.type}] '${b.name}' ${b.channels}ch` : `${b.channels}ch`)).join('\n');
  return ['---', `name: ${d.name}`, `type: ${d.sdkVersion}${d.synth ? ' (synth)' : ''}${d.bridged ? ' [bridged]' : ''}`,
    `path: ${d.path}`, `vendor: ${d.vendor}`, `category: ${d.category}`, `version: ${d.version}`,
    `inputs: ${bus(d.inputs)}`, `outputs: ${bus(d.outputs)}`, `parameters: ${d.numParameters}`,
    `programs: ${d.numPrograms}`, `editor: ${d.editor}`, `resizable: ${d.editorResizable}`,
    `MIDI input: ${d.midiInput}`, `MIDI output: ${d.midiOutput}`, '---'].join('\n');
}

module.exports = {
  VstHost, VstController, VstMidiProxy, PluginDesc,
  parseIni, parseDesc, LineReader, cacheFilePath, makeTmpPath, standardizePath, msg2string,
};
