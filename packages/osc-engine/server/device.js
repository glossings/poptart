'use strict';

// The handle on one of poptart's own devices in a synth (native/devices/PoptartDevice.cpp), in
// Node: a port of PoptartDeviceController, PoptartDeviceMIDIProxy and PoptartDeviceDesc from
// native/devices/PoptartDevice.sc. It has VstController's method names on purpose - that is what
// lets the engine drive a device through the code that drives plugins.
//
// Two answers come from here rather than from the server, because this object is the authority on
// them: a control's value (nothing else writes a device's controls) and the program (the positions).

const fs = require('node:fs');
const { standardizePath } = require('./vst');

const f32 = (v) => ({ type: 'f', value: Number(v) });
const i32 = (v) => ({ type: 'i', value: Math.trunc(Number(v)) | 0 });

/** What a device says about itself, in the shape a plugin's desc has (PoptartDeviceDesc). */
class DeviceDesc {
  /** params: [{ id, name, default }], in the device's own control order. */
  constructor(name, params = []) {
    this.name = String(name);
    this.parameters = params.map((p, i) => ({ name: String(p.name ?? p.id), label: '', index: i }));
    // Both spellings resolve, in any case, as they do in the browser.
    this.indices = new Map();
    params.forEach((p, i) => {
      if (p.id != null) this.indices.set(String(p.id).toLowerCase(), i);
      if (p.name != null) this.indices.set(String(p.name).toLowerCase(), i);
    });
  }

  get numParameters() { return this.parameters.length; }

  /** null: there is no plugin API here (so the "is it VST 3?" test says no, as the class's nil does). */
  get sdkVersion() { return null; }

  findParamIndex(name) {
    const i = this.indices.get(String(name).toLowerCase());
    return i == null ? null : i;
  }
}

/** Notes, in the shape a plugin takes them: the channel dropped, velocity as 0..1. */
class DeviceMidiProxy {
  constructor(owner) {
    this.owner = owner;
  }

  noteOn(chan, note, veloc = 64) { this.owner.sendMsg('/noteOn', f32(note), f32(veloc / 127)); }
  noteOnMsg(chan, note, veloc = 64) { return this.owner.msgFor('/noteOn', f32(note), f32(veloc / 127)); }
  noteOff(chan, note) { this.owner.sendMsg('/noteOff', f32(note)); }
  noteOffMsg(chan, note) { return this.owner.msgFor('/noteOff', f32(note)); }
  allNotesOff() { this.owner.sendMsg('/allNotesOff'); }
  // The track's bend reaches a device as a signal on the UGen's bend input, not as a message, so
  // these are quiet on purpose: the MIDI paths call them without asking what kind of slot it is.
  bend() {}
  control() {}
  polyTouch() {}
  touch() {}
  program() {}
}

class DeviceController {
  /** server: the ../server Server; synth: its node object; synthIndex: the UGen's index in the def. */
  constructor(server, synth, synthIndex, host = null) {
    this.server = server;
    this.synth = synth;
    this.synthIndex = synthIndex;
    this.host = host;
    this.id = null;
    this.info = null;
    this.midi = new DeviceMidiProxy(this);
    this.parameterAutomated = null;
    this.deviceName = null;
    this._positions = [];
    this._tempo = 120;
    this._beatPos = 0;
    this._reportId = 0;
  }

  _post(text) {
    if (this.host && typeof this.host.post === 'function') this.host.post(text);
    else console.log(text);
  }

  _warn(text) {
    if (this.host && typeof this.host.warn === 'function') this.host.warn(text);
    else console.warn(`WARNING: ${text}`);
  }

  get isOpen() { return this.info != null; }

  /** One handler for this UGen's replies (node and index matched); returns its remover. */
  _reply(address, fn) {
    const node = this.synth.nodeID;
    const index = this.synthIndex;
    const off = this.server.on(address, (a) => {
      if (Number(a[0]) !== node || Number(a[1]) !== index) return;
      fn([address, ...a]);
    });
    return off;
  }

  /**
   * Opens a device by name with the controls it is described as having. action(ctl, ok) once the
   * UGen says it is in - or, if it never says, false after openTimeout seconds.
   */
  open(name, params = [], action = null) {
    let answered = false;
    this.deviceName = String(name);
    this.info = new DeviceDesc(name, params ?? []);
    // The UGen opens every control at its default, so the record starts there.
    this._positions = (params ?? []).map((p) => p.default ?? 0);
    const off = this._reply('/poptart/deviceOpened', (msg) => {
      off();
      if (!answered) {
        answered = true;
        clearTimeout(timer);
        action?.(this, Number(msg[3]) > 0);
      }
    });
    const timer = setTimeout(() => {
      if (!answered) {
        answered = true;
        off();
        action?.(this, false);
      }
    }, DeviceController.openTimeout * 1000);
    this.sendMsg('/open', this.deviceName);
  }

  close() {
    this.info = null;
    this.deviceName = null;
    this.sendMsg('/close');
  }

  /** set(index, position, ...): 0..1 positions by control index. */
  set(...pairs) {
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const index = pairs[i];
      if (typeof index === 'number' && index >= 0 && index < this._positions.length) this._positions[index] = pairs[i + 1];
    }
    this.sendMsg('/set', ...pairs.map((v, i) => (i % 2 === 0 ? i32(v) : f32(v))));
  }

  setMsg(...pairs) {
    return this.msgFor('/set', ...pairs.map((v, i) => (i % 2 === 0 ? i32(v) : f32(v))));
  }

  /** action(position): answered here, at once - nothing else writes these controls. */
  get(index, action) {
    action?.(this._positions[index] ?? 0);
  }

  map(index, bus) {
    this.sendMsg('/map', i32(index), i32(busIndex(bus)));
  }

  /** An audio bus onto a control, read every sample: gain * signal + offset, clamped to 0..1. */
  mapAudio(index, bus, gain = 1, offset = 0) {
    this.sendMsg('/mapa', i32(index), i32(busIndex(bus)), f32(gain), f32(offset));
  }

  unmapAudio(index) {
    this.sendMsg('/mapa', i32(index), i32(-1), f32(1), f32(0));
  }

  unmap(...indices) {
    if (indices.length === 0) {
      // (0..n-1) - and, as the class's range does, [0] with no device and [0, -1] for one with none.
      const last = this.info ? this.info.numParameters - 1 : 0;
      const all = [];
      for (let i = 0; ; i += last >= 0 ? 1 : -1) {
        all.push(i);
        if (i === last) break;
      }
      this.sendMsg('/unmap', ...all.map(i32));
    } else {
      this.sendMsg('/unmap', ...indices.map(i32));
    }
  }

  /** The positions as this engine's own program text; action(ctl, ok). */
  writeProgram(p, action = null) {
    let ok = false;
    try {
      fs.writeFileSync(standardizePath(p), this._programString());
      ok = true;
    } catch (err) {
      this._warn(`poptart: could not write a device program to ${p}: ${err.message}`);
    }
    action?.(this, ok);
  }

  /** Reads a program written by writeProgram (by control name); action(ctl, ok). */
  readProgram(p, action = null) {
    let ok = false;
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(standardizePath(p), 'utf8')); } catch { doc = null; }
    const values = doc?.params;
    if (values && typeof values === 'object' && !Array.isArray(values) && this.info) {
      for (const [key, value] of Object.entries(values)) {
        const index = this.info.findParamIndex(key);
        if (index != null) this.set(index, Number(value));
      }
      ok = true;
    }
    action?.(this, ok);
  }

  _programString() {
    const parts = (this.info?.parameters ?? []).map((p, i) => `${JSON.stringify(p.name)}: ${num(this._positions[i] ?? 0)}`);
    return `{ "device": ${JSON.stringify(this.deviceName ?? '')}, "params": { ${parts.join(', ')} } }`;
  }

  // A device has no host transport to start; kept so the plugin paths can call it without a check.
  setPlaying() {}

  setTempo(bpm) {
    this._tempo = bpm ?? this._tempo;
    this.sendMsg('/transport', f32(this._tempo), f32(this._beatPos));
  }

  setTransportPos(beats) {
    this._beatPos = beats ?? this._beatPos;
    this.sendMsg('/transport', f32(this._tempo), f32(this._beatPos));
  }

  /** A file for a control that plays one, by buffer number (the UGen reads the frames itself). */
  loadSample(param, index, buffer, frameLength = 0) {
    if (buffer != null) this.sendMsg('/sample', i32(param), i32(index), i32(buffer.bufnum ?? buffer), i32(frameLength));
  }

  /** A drawn curve for a control that takes one, as its sampled points. */
  loadShape(param, index, points) {
    if (points && points.length > 0) this.sendMsg('/shape', i32(param), i32(index), ...points.map(f32));
  }

  /**
   * Where every control is as the device last read it, and its own report: action(positions,
   * report), or action(null, null) if no answer comes within `timeout` seconds.
   */
  report(action, timeout = 1) {
    this._reportId = (this._reportId + 1) % 16777216;
    const id = this._reportId;
    let answered = false;
    const off = this._reply('/poptart/deviceReport', (msg) => {
      // [address, node, ugen index, id, count, position..., reportCount, report...]
      if (answered || Math.trunc(msg[3]) !== id) return;
      answered = true;
      off();
      clearTimeout(timer);
      const count = Math.trunc(msg[4]);
      const positions = count > 0 ? msg.slice(5, 5 + count) : [];
      const reportCount = Math.trunc(msg[5 + count] ?? 0);
      const report = reportCount > 0 ? msg.slice(6 + count, 6 + count + reportCount) : [];
      action?.(positions, report);
    });
    const timer = setTimeout(() => {
      off();
      if (!answered) {
        answered = true;
        action?.(null, null);
      }
    }, timeout * 1000);
    this.sendMsg('/report', f32(id));
  }

  /** Whether anything is routed into this slot's key input. */
  sidechain(patched = false) {
    this.sendMsg('/sidechain', i32(patched ? 1 : 0));
  }

  /** Whether a track's notes are routed into this slot. */
  noteRoute(routed = false) {
    this.sendMsg('/noteRoute', i32(routed ? 1 : 0));
  }

  /**
   * How late a chain in the device's feedback loop comes back, in seconds (its devices; the UGen
   * adds its block), or below zero for none.
   */
  loopLatency(seconds = -1) {
    this.sendMsg('/loopLatency', f32(seconds));
  }

  editor() {
    this._post(`poptart: ${this.deviceName ?? 'this device'} has no plugin editor - its panel is poptart's own`);
  }

  sendMsg(cmd, ...args) {
    this.server.send(['/u_cmd', this.synth.nodeID, this.synthIndex, cmd, ...args]);
  }

  sendBundle(time, ...msgs) {
    this.server.sendBundle(time, msgs);
  }

  msgFor(cmd, ...args) {
    return ['/u_cmd', this.synth.nodeID, this.synthIndex, cmd, ...args];
  }
}

// How long an open may go unanswered before it answers itself (a failsafe, not a budget).
DeviceController.openTimeout = 10;

function busIndex(bus) {
  return bus && typeof bus === 'object' ? bus.index : Number(bus);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '0';
}

module.exports = { DeviceController, DeviceDesc, DeviceMidiProxy };
