// Notes from one track, played on another.
//
// `b: midi("a").synth("Wavetable")` plays b's instrument from a's notes, and
// `.fx("Ducker").midi("kick")` plays an effect from the kick's. The desktop does this in its
// engine wrapper, fanning each note edge out to the routes whose source it came from (see
// osc-engine's _fanoutMidi), and this is the same thing for the browser: the same rules, so a
// pattern routes alike in both builds.
//
//   - A route is (target track, slot) <- source name. One route per sink: setting a new one
//     replaces the old, and a re-evaluation that names a different source does not leave the old
//     one behind.
//   - A head route (slot 0, from `midi("a")`) carries the source's pitch operations - folded
//     statics (transpose, then the nearest pitch in a scale) or a per-note closure. An injector
//     (`.midi("a")` on an effect) carries neither, and may pin the pitch it plays with `{ note }`.
//   - A note-ON maps its pitch at its own time and remembers what it played; the note-OFF
//     releases THAT, never a fresh mapping - a map that changes over time would otherwise
//     release a different pitch and leave the real one hanging.
//   - A sampler event has no separate off edge, so it routes as a pair: on at the onset, off a
//     few milliseconds before the offset, so back-to-back hits on one pitch do not have the next
//     one's on land under the last one's off.
//   - Taking a route away releases whatever it is holding, because the offs that would have
//     released it will no longer reach it.
//
// A route may also come from a MIDI DEVICE - `midi("dev:Keystep")`, `midikeys("Keystep")`,
// `.midi("dev:Keystep")` into an effect. Its name is matched against the device's own name the
// way the desktop matches one: a case-insensitive fragment of it, so `Keystep` finds "Arturia
// KeyStep 32". A device route may listen on one channel (1-16) or on all of them (0), and it holds
// its sounding notes by channel and key, since two channels can play the same key at once.
//
// It knows nothing about audio. `deliver` is handed every note it decides to play - the engine
// turns those into messages to a synth or an effect.

/** The pitch a route fires for a source with no pitch of its own - a drum pattern, usually. */
export const DEFAULT_ROUTE_NOTE = 60;

/** How early a routed sampler note's off is pulled, and the shortest a routed note may be. */
export const NOTE_OFF_EARLY_SEC = 0.005;
export const MIN_ROUTE_NOTE_SEC = 0.001;

const wrap = (n, m) => ((n % m) + m) % m;

export class MidiRoutes {
  /**
   * `deliver(on, targetTrackId, slot, note, velocity, atTime)` plays one routed edge.
   * `resolve(name)` turns a name as written into a track id, or returns null.
   */
  constructor({ deliver, resolve = (n) => n }) {
    this.deliver = deliver;
    this.resolve = resolve;
    this.routes = [];
    // Per sink ("target:slot"), source pitch -> the pitch its on played.
    this.held = new Map();
  }

  get size() { return this.routes.length; }

  /** Sets the route into (target, slot), replacing whatever fed it before. */
  add(name, targetTrackId, slot, { note = null, transpose = 0, pcs = null, noteMap = null, channel = 0 } = {}) {
    // The held table is kept across the replacement on purpose: notes sounding through the old
    // route still need their offs to find what they played.
    this.routes = this.routes.filter((r) => !(r.targetTrackId === targetTrackId && r.slot === slot));
    this.routes.push({ name: String(name), targetTrackId, slot, note, transpose: transpose ?? 0, pcs: pcs ?? null, noteMap: noteMap ?? null, channel: Math.max(0, Math.round(Number(channel) || 0)) });
  }

  /** Whether any route listens to a MIDI device - the host asks for MIDI access only then. */
  get wantsDevices() { return this.routes.some((r) => r.name.startsWith('dev:')); }

  /** The device-name fragments the routes are listening for, as written. */
  devicePatterns() {
    return [...new Set(this.routes.filter((r) => r.name.startsWith('dev:')).map((r) => r.name.slice(4)))];
  }

  /** Whether a device route listens to this device on this channel. */
  _fromDevice(route, deviceName, channel) {
    if (!route.name.startsWith('dev:')) return false;
    const want = route.name.slice(4).trim().toLowerCase();
    if (want && !String(deviceName).toLowerCase().includes(want)) return false;
    return !route.channel || route.channel === channel;
  }

  /**
   * One note edge from a MIDI device, fanned out to every route listening to it. `onPlayed` is
   * told each note a route actually played - what the live log records, as the note sounds.
   */
  deviceEdge(deviceName, channel, note, velocity, atTime, isOn, onPlayed = null) {
    for (const r of this.routes) {
      if (!this._fromDevice(r, deviceName, channel)) continue;
      const held = this._heldFor(r);
      const key = `${channel}:${note}`;
      if (isOn && velocity > 0) {
        // A key struck again before it came up: release the first strike, so neither hangs.
        const again = held.get(key);
        if (again != null) {
          this.deliver(false, r.targetTrackId, r.slot, again, 0, atTime);
          onPlayed?.(r.targetTrackId, r.slot, again, 0, false);
        }
        const played = this.pitch(r, r.note ?? note, atTime);
        if (played == null) { held.delete(key); continue; }
        held.set(key, played);
        this.deliver(true, r.targetTrackId, r.slot, played, velocity, atTime);
        onPlayed?.(r.targetTrackId, r.slot, played, velocity, true);
      } else {
        const played = held.get(key);
        if (played == null) continue;
        held.delete(key);
        this.deliver(false, r.targetTrackId, r.slot, played, 0, atTime);
        onPlayed?.(r.targetTrackId, r.slot, played, 0, false);
      }
    }
  }

  /** Takes the route into (target, slot) away, releasing what it holds. */
  remove(targetTrackId, slot, atTime = 0) {
    this.routes = this.routes.filter((r) => !(r.targetTrackId === targetTrackId && r.slot === slot));
    const key = `${targetTrackId}:${slot}`;
    const held = this.held.get(key);
    if (!held) return;
    for (const played of held.values()) this.deliver(false, targetTrackId, slot, played, 0, atTime);
    this.held.delete(key);
  }

  /**
   * Releases every note a track's routes are holding in the tracks they feed, and forgets them -
   * for a source that is hushed or taken away, whose offs will not come to release them. The
   * routes stay: a hush is not a re-evaluation, and the next note through plays as before.
   */
  releaseFrom(sourceTrackId, atTime = 0) {
    for (const r of this.routes) {
      if (!this._fromTrack(r, sourceTrackId)) continue;
      const key = `${r.targetTrackId}:${r.slot}`;
      const held = this.held.get(key);
      if (!held) continue;
      for (const played of held.values()) this.deliver(false, r.targetTrackId, r.slot, played, 0, atTime);
      this.held.delete(key);
    }
  }

  /** Whether any route is into this sink - an effect is told when it starts and stops being played. */
  has(targetTrackId, slot) {
    return this.routes.some((r) => r.targetTrackId === targetTrackId && r.slot === slot);
  }

  /** Whether a route's source is this track. A `dev:` name is a device, never a track. */
  _fromTrack(route, sourceTrackId) {
    const name = route.name;
    if (name.startsWith('dev:')) return false;
    const bare = name.startsWith('track:') ? name.slice(6) : name;
    return bare === sourceTrackId || this.resolve(bare) === sourceTrackId;
  }

  /** The pitch a route plays for a source pitch at a time, or null for one it silences. */
  pitch(route, note, sec) {
    if (route.noteMap) {
      const mapped = route.noteMap(note, sec);
      return mapped == null || !Number.isFinite(mapped) ? null : Math.min(127, Math.max(0, mapped));
    }
    // A fractional note is a microtone and goes through as one - every sink here is an
    // instrument of the browser's own, which plays it. Snapping to a scale lands on a key.
    let out = note + (route.transpose ?? 0);
    const pcs = route.pcs;
    if (pcs && pcs.length > 0) {
      out = Math.round(out);
      // Nearest pitch class, ties downward - the rule the desktop's device routes use too.
      for (let d = 0; d < 12; d++) {
        if (pcs.includes(wrap(out - d, 12))) { out -= d; break; }
        if (pcs.includes(wrap(out + d, 12))) { out += d; break; }
      }
    }
    return Math.min(127, Math.max(0, out));
  }

  _heldFor(route) {
    const key = `${route.targetTrackId}:${route.slot}`;
    let held = this.held.get(key);
    if (!held) { held = new Map(); this.held.set(key, held); }
    return held;
  }

  /** One of a synth track's note edges, fanned out to every route it feeds. */
  noteEdge(sourceTrackId, note, velocity, atTime, isOn) {
    for (const r of this.routes) {
      if (!this._fromTrack(r, sourceTrackId)) continue;
      const held = this._heldFor(r);
      if (isOn) {
        const played = this.pitch(r, r.note ?? note, atTime);
        if (played == null) continue;
        held.set(note, played);
        this.deliver(true, r.targetTrackId, r.slot, played, velocity, atTime);
      } else {
        const played = held.get(note);
        if (played == null) continue;
        held.delete(note);
        this.deliver(false, r.targetTrackId, r.slot, played, 0, atTime);
      }
    }
  }

  /**
   * One sampler event, fanned out as an on and an off. `eventNote` is the event's own pitch -
   * what a pianoroll or an .n() on a sampler track writes - so a melodic sampler line routes as
   * the line it is; a drum pattern has none and plays DEFAULT_ROUTE_NOTE. A route's pinned
   * `{ note }` outranks both.
   */
  sampleEvent(sourceTrackId, velocity, onsetSec, offsetSec, eventNote = null) {
    const offSec = Math.max(onsetSec + MIN_ROUTE_NOTE_SEC, (Number.isFinite(offsetSec) ? offsetSec : onsetSec + 0.1) - NOTE_OFF_EARLY_SEC);
    const own = Number.isFinite(eventNote) ? eventNote : null;
    for (const r of this.routes) {
      if (!this._fromTrack(r, sourceTrackId)) continue;
      const note = this.pitch(r, r.note ?? own ?? DEFAULT_ROUTE_NOTE, onsetSec);
      if (note == null) continue;
      this.deliver(true, r.targetTrackId, r.slot, note, velocity, onsetSec);
      this.deliver(false, r.targetTrackId, r.slot, note, 0, offSec);
    }
  }
}
