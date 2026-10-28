// The DJ desk, in the page.
//
// The browser build's half of what the desktop's server.js calls the performance mixer: two
// decks, a crossfader and the channel faders, a DJ stage on every stem (trim, a three-band
// isolator, a one-knob filter, a gate), solo and swap, the per-deck tempo faders, the loop and
// jog buttons, the headphone cue, the FX unit - and the song player, a real audio file on a deck
// with sync, nudge, keylock and quantized starts. Its routes answer the editor the way the
// desktop's do, field for field, because the editor's desk (client.js) is the same code in both.
//
// It is a PORT of the desktop's desk, function for function and with the same names, so that a
// fix to one can be read across to the other. What differs is what the page has instead of
// scsynth and the disk, and each difference is noted where it is:
//
//   - The engine runs on the audio context's clock, which is also the clock everything is
//     scheduled on - so there is no drift between the song players and the model of them, and
//     none of the desktop's drift servo.
//   - The player is told when each change is HEARD (see web-engine's song-player.mjs). A deck
//     with keylock on is heard the shifter's latency after its player reads, so a change made
//     "now" lands that lead later there, and none later with keylock off. The model here is kept
//     in heard time, and timed events are sent the most that lead can be early.
//   - A song comes from the music folder chosen in the settings (music-folder.mjs), decoded by
//     the browser, and is analyzed - its waveform, its beatgrid and its key - on a worker
//     (song-worker.mjs) with the same maths the desktop's analysis worker runs.
//   - What the desktop keeps between sessions is kept in this browser's store: the headphone
//     knobs, the regions default, the FX chains, and a beatgrid anchor placed by hand.
//
// Link is a desktop helper and stays one: its routes answer that it is off.

const DECKS = ['a', 'b'];
const deckOfKey = (key) => (String(key).includes(':') ? String(key).slice(0, String(key).indexOf(':')) : 'a');
const other = (deck) => (deck === 'a' ? 'b' : 'a');
const deckArg = (v) => (v === 'b' ? 'b' : 'a');

/** The tempo an undeclared deck plays at. */
const DEFAULT_BPM = 120;

// djf is the filter's cutoff (its center detent is 0); djres is that filter's resonance
// AMOUNT, deliberately a control of its own - see the DJ stage in web-engine's track.mjs.
export const DJ_NEUTRAL = Object.freeze({ trim: 1, eqlo: 1, eqmid: 1, eqhi: 1, djf: 0, djres: 0, fader: 1, deck: 1, cue: 0 });

/** The song decks' fixed keys. '#' cannot appear in a block label, so they never collide. */
export const SONG_KEYS = Object.freeze({ a: '#song', b: 'b:#song' });
const SONG_START_LEAD_SEC = 0.15; // enough for a start to reach the player before it is due
// How near the end counts AS the end when deciding whether a press should rewind.
const SONG_END_EPS_SEC = 0.1;
// The player's own release at the end of the file (see web-engine's song-reader.mjs).
const SONG_RELEASE_SEC = 0.05;
// How early a timed event (the end of the file, a loop's wrap) is SENT ahead of when the player
// does it. The event is timestamped, so this only has to cover the trip to the audio thread - but
// it is also the window in which a rate change can land after the message has gone.
const SONG_SEND_AHEAD_SEC = 0.08;

const DECK_TEMPO_RANGES = [6, 10, 16, 100];
const DECK_LOOP_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
const DECK_LOOP_DEFAULT_BEATS = 16;
const DECK_JOG_BEATS = [1, 2, 4, 8, 16, 32];
// Desk frames are coalesced to one per this long, however fast the desk changes.
const NOTIFY_MS = 30;
const LEVEL_MS = 40;
// How long the leader and the song-follow are re-sampled while the desk is open.
const LEADER_POLL_MS = 500;
const FOLLOW_POLL_MS = 50;

const HEADPHONES_KEY = 'settings/headphones';
const DJ_FX_KEY = 'settings/dj-fx';
const MIDI_KEY = 'settings/mix-midi';
// The FX unit's return tracks and the buses they read - '#' cannot appear in a block label.
const FX_KEYS = Object.freeze({ a: '#fx', b: 'b:#fx' });
const FX_BUSES = Object.freeze({ a: '#fxa', b: '#fxb' });
const FX_ASSIGNS = ['a', 'ab', 'b'];
const DJ_REGIONS_KEY = 'settings/dj-regions';

class Unsupported extends Error {
  constructor(what, why) {
    super(`${what} is not in the browser build${why ? ` - ${why}` : ''}`);
    this.name = 'Unsupported';
    this.unsupported = true;
  }
}

/**
 * @param {object} deps
 * @param deps.patternCore
 * @param deps.engine     the web engine (its song player, DJ stage, cue and meters)
 * @param deps.transport  the ROOM's clock: songs sync to it; each deck's code reads its own
 * @param deps.songSync   song-sync.js - the rate, grid and bend maths the desktop uses
 * @param deps.linkSync   link-sync.js - the follow maths the desktop's free-running songs use
 * @param deps.store      the page's key-value store, for the two settings the desk keeps
 * @param deps.songs      where a deck's song comes from and how it is analyzed (song-load.mjs)
 * @param deps.blockEvaluator  (builders) -> a block evaluator with the prebake in scope, for the
 *                        FX unit's chains (see block-eval.mjs)
 * @param deps.library    the music library (library.mjs): a song's record, and what a deck learns
 *                        about it - a tempo or key typed, an anchor placed, a measurement
 * @param deps.writeSet   (set, ended) -> where the set's tracklist went (storage's writeSetLog)
 * @param deps.midi       the page's MIDI (midi.mjs): what a controller learned for the desk speaks
 *                        through, and where the desk's lamps and meters are written back
 * @param deps.parseMeta  pattern-meta.js's reader of a buffer's @title, for the tracklist
 * @param deps.log        a line for the editor's console
 */
export function createDesk({ patternCore, engine, transport, songSync, linkSync, store = null, songs = null, blockEvaluator = null, library = null, writeSet = null, parseMeta = null, midi = null, log = () => {} }) {
  let evaluator = null;
  const now = () => engine.getTime();
  // The most a song is ever late: how far ahead a timed event is sent (see the header).
  const LAT = Number(engine.songLatency) || 0;

  // ---------------------------------------------------------------------------------------------
  // The desk's state. EPHEMERAL by design, as on the desktop: none of it is written into song
  // code, and it dies with the session.
  // ---------------------------------------------------------------------------------------------
  const mixState = {
    dj: false,
    swap: false,
    solo: { a: new Set(), b: new Set() },
    soloPrev: { a: null, b: null },
    perDeck: { a: new Map(), b: new Map() },
    perTrack: new Map(),
    xf: 0,
    faders: { a: 1, b: 1 },
    tempoOverride: null,
    deckTempo: { a: { frac: 0, range: 6 }, b: { frac: 0, range: 6 } },
    deckLoop: { a: { beats: DECK_LOOP_DEFAULT_BEATS }, b: { beats: DECK_LOOP_DEFAULT_BEATS } },
    deckJog: { a: { beats: 1 }, b: { beats: 1 } },
    // The DJ FX unit: one named CHAIN switched in as an insert per deck (see the FX section).
    fx: { chain: null, on: false, held: false, knob: 0, assign: 'ab' },
  };
  // A track inside a real group -> the key of the group it plays through (see mixGroupChain).
  const groupMembers = new Map();
  const songDecks = { a: null, b: null };
  const deckSongPrefs = { a: {}, b: {} };
  const songLoading = new Set();
  // Each deck's own clock: synced it rides the room's exactly; a nudge, a jog or sync off takes
  // it somewhere of its own.
  const deckClocks = { a: new patternCore.DeckClock(transport), b: new patternCore.DeckClock(transport) };
  const clockOf = (deck) => deckClocks[deck] ?? transport;
  const deckLive = { a: { sync: true, nudge: 0, bend: 0 }, b: { sync: true, nudge: 0, bend: 0 } };
  const deckLiveSynced = (deck) => !mixState.dj || deckLive[deck].sync;
  // What each deck's buffer is called and what it says about itself, for the set's tracklist and
  // the library's played marks.
  const deckBuffers = { a: { name: null, title: null }, b: { name: null, title: null } };
  const songPlayedSession = new Map();
  const codePlayedSession = new Set();
  const headphones = { level: 1, mix: 0 };
  let djRegionsMode = 'off';
  let songMasterDeck = null;
  let songMasterOctave = 1;
  const djDeclaredBpm = { a: undefined, b: undefined };

  const listeners = new Set();

  // ---------------------------------------------------------------------------------------------
  // The tracks the desk shows
  // ---------------------------------------------------------------------------------------------

  const schedulers = () => evaluator?.schedulers ?? new Map();
  const trackIdOf = (key) => evaluator?.trackIds?.get(key) ?? key;
  const songKeysLive = () => DECKS.filter((d) => songDecks[d]).map((d) => SONG_KEYS[d]);
  const isMixKey = (key) => schedulers().has(key) || songKeysLive().includes(key);
  function* mixKeys() {
    for (const key of schedulers().keys()) if (!groupMembers.has(key)) yield key;
    yield* songKeysLive();
  }
  const mixAllKeys = () => [...mixKeys(), ...[...groupMembers.keys()].filter(isMixKey)];
  const mixDeskKeys = (deck) => mixAllKeys().filter((k) => deckOfKey(k) === deck);
  function mixGroupChain(key) {
    const out = [];
    for (let at = groupMembers.get(key); at != null && !out.includes(at); at = groupMembers.get(at)) out.push(at);
    return out;
  }
  const setChannel = (key, name, value) => engine.setParam(trackIdOf(key), -1, name, value, 0);

  // Where a track's own pre-fader taps go: the deck meter side (0 = A, 1 = B), or -1 for none. A
  // group MEMBER taps nothing - its sound reaches the desk through its group, which meters it.
  const mixTapDeck = (key) => (groupMembers.has(key) ? -1 : deckOfKey(key) === 'b' ? 1 : 0);

  // The crossfader through one of two curves, following the swap toggle like a hardware desk's
  // curve switch: constant power for blend mixing, and each deck held full through the center for
  // the stem-swap workflow, where the gates decide what sounds.
  const xfGain = (u) => Math.round(
    (mixState.swap ? Math.sin((Math.PI / 2) * Math.min(1, u * 2)) : Math.sin((Math.PI / 2) * u)) * 1000,
  ) / 1000;
  const deckXfGain = (deck) => xfGain(deck === 'a' ? 1 - (mixState.xf + 1) / 2 : (mixState.xf + 1) / 2);

  function mixSetFader(key, value) {
    let per = mixState.perTrack.get(key);
    if (!per) mixState.perTrack.set(key, (per = new Map()));
    per.set('fader', value);
    setChannel(key, 'fader', value);
  }

  // The plain gate gesture on one stem; a click on a SOLOED stem ends the solo (see the desktop).
  function mixGateSet(key, on) {
    const deck = deckOfKey(key);
    if (mixState.solo[deck].has(key)) {
      mixSoloEnd(deck);
      return;
    }
    mixSetFader(key, on ? 1 : 0);
    mixState.soloPrev[deck]?.set(key, on ? 1 : 0);
  }

  function mixSoloEnd(deck) {
    const prev = mixState.soloPrev[deck];
    mixState.solo[deck].clear();
    mixState.soloPrev[deck] = null;
    if (!prev) return;
    for (const k of mixDeskKeys(deck)) mixSetFader(k, prev.get(k) ?? 1);
  }

  /** The faders a deck wears while its solo runs (see the desktop's mixSoloFaders). */
  function mixSoloFaders(deck) {
    const solo = mixState.solo[deck];
    const prev = mixState.soloPrev[deck];
    const open = new Set();
    for (const k of solo) for (const g of mixGroupChain(k)) open.add(g);
    const out = new Map();
    for (const key of mixDeskKeys(deck)) {
      if (solo.has(key) || open.has(key)) out.set(key, 1);
      else if (mixGroupChain(key).some((g) => solo.has(g))) out.set(key, prev?.get(key) ?? 1);
      else out.set(key, 0);
    }
    return out;
  }

  function mixGateAll(deck) {
    mixSoloEnd(deck);
    const gated = [...mixKeys()].filter((k) => deckOfKey(k) === deck);
    for (const key of gated) mixGateSet(key, false);
    return gated;
  }

  /** Everything the mix session holds for one track, applied - deck-wide values first. */
  function applyMixTo(key) {
    const per = mixState.perTrack.get(key);
    const member = groupMembers.has(key);
    for (const [name, value] of mixState.perDeck[deckOfKey(key)] ?? []) {
      if (!per?.has(name)) setChannel(key, name, member && name === 'cue' ? 0 : value);
    }
    for (const [name, value] of per ?? []) setChannel(key, name, value);
    setChannel(key, 'mdeck', mixTapDeck(key));
    if (member) setChannel(key, 'cue', 0);
    fxApplyTo(key); // the FX unit's send is desk state like the rest - a new stem joins it live
  }

  /** What a NEW track is born wearing, so a queued deck arrives at the desk as it stands. */
  function mixBirthFor(key) {
    const birth = {};
    for (const [name, value] of mixState.perDeck[deckOfKey(key)] ?? []) birth[name] = value;
    for (const [name, value] of mixState.perTrack.get(key) ?? []) birth[name] = value;
    if (!('deck' in birth)) birth.deck = deckXfGain(deckOfKey(key)) * mixState.faders[deckOfKey(key)];
    birth.mdeck = mixTapDeck(key);
    if (birth.mdeck < 0) birth.cue = 0;
    return birth;
  }

  function neutralizeMix(key) {
    for (const [name, value] of Object.entries(DJ_NEUTRAL)) setChannel(key, name, value);
    setChannel(key, 'mdeck', mixTapDeck(key) < 0 ? -1 : 0);
  }

  /** One mix-desk gesture: { name, value } and `deck` (broadcast) or `key` (one track). */
  function applyMixTargets(targets) {
    for (const t of targets) {
      const name = String(t.name ?? '');
      const value = Number(t.value);
      if (!Number.isFinite(value)) throw new Error(`mix/set ${name}: value must be a number`);
      if (name === 'xf') {
        mixState.xf = Math.min(1, Math.max(-1, value));
        applyMixTargets([
          { deck: 'a', name: 'deck', value: deckXfGain('a') * mixState.faders.a },
          { deck: 'b', name: 'deck', value: deckXfGain('b') * mixState.faders.b },
        ]);
        continue;
      }
      // The channel fader folds into that deck's `deck` gain: `fader` on a track is its gate.
      if (name === 'fader' && (t.deck === 'a' || t.deck === 'b')) {
        mixState.faders[t.deck] = Math.min(1, Math.max(0, value));
        applyMixTargets([{ deck: t.deck, name: 'deck', value: deckXfGain(t.deck) * mixState.faders[t.deck] }]);
        continue;
      }
      if (!(name in DJ_NEUTRAL)) throw new Error(`"${name}" is not a mix control`);
      if (t.deck === 'a' || t.deck === 'b') {
        mixState.perDeck[t.deck].set(name, value);
        for (const key of mixKeys()) {
          if (deckOfKey(key) === t.deck && !mixState.perTrack.get(key)?.has(name)) setChannel(key, name, value);
        }
        // The FX return rides its deck's gain and headphone cue (it IS that deck's wet), but never
        // the EQ/filter broadcasts - those already shaped its input, over the sends.
        if (fxTracksLive[t.deck] && (name === 'deck' || name === 'cue')) setChannel(FX_KEYS[t.deck], name, value);
      } else {
        const key = String(t.key ?? '');
        if (!isMixKey(key)) throw new Error(`mix/set: no playing track "${key}"`);
        let per = mixState.perTrack.get(key);
        if (!per) mixState.perTrack.set(key, (per = new Map()));
        per.set(name, value);
        setChannel(key, name, value);
      }
    }
    mixNotify();
  }

  // ---------------------------------------------------------------------------------------------
  // Song decks: a real audio file on a deck, mixed through the same desk as the pattern decks.
  // The song is ONE ordinary track - '#song' (deck a) or 'b:#song' - whose source is the song
  // player instead of a scheduler, which is what makes the whole strip apply to it unchanged.
  // ---------------------------------------------------------------------------------------------

  /**
   * The playhead in song-seconds at engine time `at` (defaults to now), as HEARD. Between a rate
   * change being sent and it being heard the playhead runs on at the rate it had (`rateBefore`);
   * before a start it stands where the start will begin.
   */
  function songPlayheadSec(deck, at = null) {
    const s = songDecks[deck];
    if (!s) return 0;
    const t = at ?? now();
    let pos = s.posSec;
    if (s.playing) {
      const dt = t - s.startSec;
      pos += dt >= 0 ? dt * s.rate : dt * (s.rateBefore ?? 0);
    }
    return Math.min(Math.max(0, pos), s.duration);
  }

  /** The soonest a change to a deck's song can be heard - and `heard`, held to it. */
  const leadOf = (deck) => Number(engine.songLead?.(trackIdOf(SONG_KEYS[deck]))) || 0;
  const heardNow = (deck) => now() + leadOf(deck);
  const heardAt = (deck, heard) => Math.max(heardNow(deck), heard);

  function songPause(deck, posSec = null) {
    const s = songDecks[deck];
    if (!s?.playing) return;
    const at = heardNow(deck);
    try { engine.songPause(trackIdOf(SONG_KEYS[deck]), at); } catch { /* torn down */ }
    // Where the halt is heard - a pause pressed now lands the deck's lead later.
    songMarkPaused(deck, posSec ?? songPlayheadSec(deck, at));
  }

  function songMarkPaused(deck, posSec = null) {
    const s = songDecks[deck];
    if (!s) return;
    s.posSec = posSec ?? songPlayheadSec(deck);
    s.playing = false;
    s.rateBefore = 0;
    clearTimeout(s.endTimer);
    s.endTimer = null;
    clearTimeout(s.loopTimer);
    clearTimeout(s.loopApplyTimer);
    s.loopTimer = null;
    s.loopApplyTimer = null;
    songHandGridOver(deck);
  }

  // End of file, and NOT a pause: a plain release sent so that it is over by the last sample.
  function songEndOfFile(deck, endAt) {
    const s = songDecks[deck];
    if (!s?.playing) return;
    try { engine.songStop(trackIdOf(SONG_KEYS[deck]), heardAt(deck, endAt - SONG_RELEASE_SEC), SONG_RELEASE_SEC); } catch { /* torn down */ }
    songMarkPaused(deck, s.duration);
    mixNotify();
  }

  function songArmTimers(deck) {
    songArmEndTimer(deck);
    songArmLoopTimer(deck);
  }

  function songArmEndTimer(deck) {
    const s = songDecks[deck];
    if (!s) return;
    clearTimeout(s.endTimer);
    s.endTimer = null;
    if (!s.playing || !(s.rate > 0)) return;
    const t = now();
    const begin = Math.max(t, s.startSec);
    const endAt = begin + (s.duration - songPlayheadSec(deck, begin)) / s.rate;
    // Sent ahead of the release by the most a deck's lead can be, so it is never late.
    const sendIn = endAt - SONG_RELEASE_SEC - LAT - SONG_SEND_AHEAD_SEC - t;
    s.endTimer = setTimeout(() => {
      s.endTimer = null;
      songEndOfFile(deck, endAt);
    }, Math.max(0, sendIn * 1000));
  }

  /**
   * Arm the next wrap of a song deck's loop: the seek that closes it, timestamped for the moment
   * the playhead reaches the loop's end, and the model moved when it is heard.
   */
  function songArmLoopTimer(deck) {
    const s = songDecks[deck];
    if (!s) return;
    clearTimeout(s.loopTimer);
    clearTimeout(s.loopApplyTimer);
    s.loopTimer = null;
    s.loopApplyTimer = null;
    if (!s.playing || !s.loop || !(s.rate > 0)) return;
    const t = now();
    const begin = Math.max(t, s.startSec);
    const wrapAt = begin + Math.max(0, (s.loop.to - songPlayheadSec(deck, begin)) / s.rate);
    s.loopTimer = setTimeout(() => {
      s.loopTimer = null;
      if (!s.playing || !s.loop) return;
      const to = s.loop.from;
      try { engine.songSeek(trackIdOf(SONG_KEYS[deck]), to, heardAt(deck, wrapAt)); } catch { /* torn down */ }
      s.loopApplyTimer = setTimeout(() => {
        s.loopApplyTimer = null;
        if (!s.playing || !s.loop) return;
        s.posSec = to;
        s.startSec = wrapAt;
        s.rateBefore = s.rate;
        songArmTimers(deck);
        mixNotify();
      }, Math.max(0, (wrapAt - now()) * 1000));
    }, Math.max(0, (wrapAt - LAT - SONG_SEND_AHEAD_SEC - t) * 1000));
  }

  /** Is anything besides this deck's song sounding? What a start has to lock onto. */
  function othersPlaying(deck) {
    return [...schedulers().values()].some((sch) => sch.running)
      || DECKS.some((d) => d !== deck && songDecks[d]?.playing);
  }

  function songBaseRate(deck) {
    const s = songDecks[deck];
    if (!s) return 1;
    if (!s.playing && s.sync && s.bpm && !othersPlaying(deck) && mixState.tempoOverride == null) return s.manualRate;
    if (s.sync && s.bpm) return songSync.syncRate(transport.cps * 240, s.bpm, songOctave(deck)) ?? s.manualRate;
    return s.manualRate;
  }

  function songOctave(deck) {
    const s = songDecks[deck];
    if (!s || !s.bpm) return 1;
    if (deck === songMasterDeck) return songMasterOctave;
    return songSync.syncOctave(transport.cps * 240, s.bpm, s.syncMult);
  }
  const songGridBpm = (deck) => (songDecks[deck]?.bpm ?? 0) / songOctave(deck);

  /** Hand the grid on, or give it up, when the deck holding it stops (see the desktop). */
  function songHandGridOver(deck) {
    if (songMasterDeck !== deck) return songMasterDeck;
    const to = other(deck);
    const heir = songDecks[to];
    const takes = !!(heir?.playing && heir.sync && heir.bpm);
    songMasterOctave = takes ? songOctave(to) : 1;
    songMasterDeck = takes ? to : null;
    if (takes) songApplyRate(to);
    return songMasterDeck;
  }

  /**
   * Apply the current effective rate (sync x nudge x bend), rebasing the playhead model at the
   * moment the change is HEARD - the deck's lead after it is sent - so the model stays exact
   * through any number of rate moves. A start not heard yet takes the new rate at its own moment.
   */
  function songApplyRate(deck) {
    const s = songDecks[deck];
    if (!s) return;
    const eff = songSync.effectiveRate(songBaseRate(deck), s.nudge, s.bend ?? 0);
    if (eff === s.rate) return;
    const tid = trackIdOf(SONG_KEYS[deck]);
    if (s.playing && heardNow(deck) >= s.startSec) {
      const at = heardNow(deck);
      s.posSec = songPlayheadSec(deck, at);
      s.startSec = at;
      s.rateBefore = s.rate;
      s.rate = eff;
      try { engine.songRate(tid, eff, at); } catch { /* torn down */ }
      songArmTimers(deck);
      if (deck === songFollow.deck) clockFollowSong();
    } else {
      s.rate = eff;
      if (s.playing) {
        try { engine.songRate(tid, eff, heardAt(deck, s.startSec)); } catch { /* torn down */ }
        songArmTimers(deck);
      }
    }
  }

  function songNudge(deck, { hold, jog }) {
    const s = songDecks[deck];
    if (!s) return liveNudge(deck, { hold, jog });
    if (hold !== undefined) {
      s.nudge = Math.sign(Number(hold) || 0);
      songApplyRate(deck);
    }
    const dir = Math.sign(Number(jog) || 0);
    if (dir) {
      const to = Math.min(Math.max(0, songPlayheadSec(deck) + (s.bpm ? (60 / s.bpm) * mixState.deckJog[deck].beats : 0.1) * dir), s.duration);
      if (s.playing) songSeekPlaying(deck, to);
      else s.posSec = to;
    }
    mixNotify();
    return { deck, nudge: s.nudge, pos: s.posSec, rate: s.rate };
  }

  /** A seek on a playing deck: heard as soon as the deck's lead allows. */
  function songSeekPlaying(deck, to) {
    const s = songDecks[deck];
    const at = heardNow(deck);
    try { engine.songSeek(trackIdOf(SONG_KEYS[deck]), to, at); } catch { /* torn down */ }
    s.posSec = to;
    s.startSec = at;
    s.rateBefore = s.rate;
    songArmTimers(deck);
  }

  // The CUE gesture: press and hold previews from the cue point, release drops the playhead back
  // on it, paused. The cue point MOVES only on a press while paused. Never quantized.
  function songCue(deck, hold) {
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    const tid = trackIdOf(SONG_KEYS[deck]);
    if (hold) {
      const before = songPlayheadSec(deck);
      const spent = before >= s.duration - SONG_END_EPS_SEC;
      if (!s.playing && !spent) {
        const at = songPlayheadSec(deck);
        s.cueSec = s.quantize === false
          ? at
          : songSync.snapToGrid(at, s.bpm, s.anchorSec, s.duration - SONG_END_EPS_SEC);
      }
      const startSec = now() + SONG_START_LEAD_SEC;
      s.nudge = 0;
      s.bend = 0;
      s.rate = songSync.effectiveRate(songBaseRate(deck), 0);
      engine.songStart(tid, s.cueSec, s.rate, heardAt(deck, startSec), !!s.keylock);
      s.posSec = s.cueSec;
      s.startSec = startSec;
      s.rateBefore = 0;
      s.playing = true;
      s.cueHeld = true;
      songArmTimers(deck);
    } else if (s.cueHeld) {
      s.cueHeld = false;
      songPause(deck);
      s.posSec = s.cueSec;
    }
    mixNotify();
    return { deck, cueSec: s.cueSec, playing: s.playing };
  }

  /**
   * Start (or resume) a deck's song (see the desktop's songPlayDeck): with nothing else sounding,
   * a synced song with a bpm TAKES the grid - the clock adopts its tempo and bar phase. With
   * something already playing, the start waits for the clock position that puts this song's cue
   * on a bar line - a bar at most, and never by moving the entry point.
   */
  function songPlayDeck(deck, { pos, rate, now: startNow } = {}) {
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    if (s.path && !songPlayedSession.has(s.path)) songPlayedSession.set(s.path, { at: Date.now(), deck });
    const r = Number(rate);
    if (Number.isFinite(r) && r > 0.01 && r <= 4) s.manualRate = r;
    const at = Number(pos);
    const spent = (v) => v >= s.duration - SONG_END_EPS_SEC;
    const from = Number.isFinite(at)
      ? (spent(at) ? 0 : Math.min(Math.max(0, at), s.duration))
      : (spent(s.posSec) ? 0 : s.posSec);
    clockTakeLeaderPlace(deck);
    const nowSec = now();
    let startSec = nowSec + SONG_START_LEAD_SEC;
    const others = othersPlaying(deck);
    const takeGrid = !others && s.sync && !!s.bpm;
    const quant = !startNow && s.quantize !== false;
    if (takeGrid) {
      songMasterDeck = deck;
      songMasterOctave = 1;
      if (mixState.tempoOverride == null) transport.setBpm(s.bpm * deckTempoMult(deck));
    }
    if (others && quant && !transport.paused) {
      const earliest = transport.cycleAt(nowSec + SONG_START_LEAD_SEC);
      let startCycle;
      if (s.sync && s.bpm) {
        const phase = songSync.gridPhase(from, songGridBpm(deck), s.anchorSec);
        startCycle = Math.floor(earliest - phase) + phase;
        if (startCycle < earliest) startCycle += 1;
      } else {
        const beat = 1 / songSync.BEATS_PER_CYCLE;
        startCycle = Math.ceil(earliest / beat) * beat;
      }
      startSec = transport.secAt(startCycle);
    }
    s.nudge = 0;
    s.bend = 0;
    s.cueHeld = false;
    s.rate = songSync.effectiveRate(songBaseRate(deck), 0);
    engine.songStart(trackIdOf(SONG_KEYS[deck]), from, s.rate, heardAt(deck, startSec), !!s.keylock);
    s.posSec = from;
    s.startSec = startSec;
    s.rateBefore = 0;
    s.playing = true;
    if (takeGrid) {
      // The clock resumes with this song's bar position AS its cycle position (cycle 1, not 0, so
      // a reading in the lead before the start never comes back negative).
      transport.startAt(startSec, 1 + songSync.gridPhase(from, songGridBpm(deck), s.anchorSec));
    }
    songArmTimers(deck);
    mixNotify();
    return {
      deck, pos: from, rate: s.rate, startSec: startSec + wallOffset(), master: takeGrid,
      bpm: transport.cps * 240, gridless: !others && !takeGrid,
    };
  }

  function songSeekTo(deck, posSec) {
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    if (!Number.isFinite(posSec)) throw new Error('song/seek needs pos (seconds)');
    const to = Math.min(Math.max(0, posSec), s.duration);
    if (s.playing) songSeekPlaying(deck, to);
    else s.posSec = to;
    mixNotify();
    return to;
  }

  /** The facts row as one patch: only the keys present are touched. */
  function songSetMeta(deck, patch) {
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    const facts = evaluator?.facts?.(deck);
    if ('bpm' in patch) {
      delete s.bpmDetected;
      if (patch.bpm == null || patch.bpm === '') {
        s.bpm = null;
        s.bpmByHand = false;
        s.sync = false;
        if (facts) facts.bpm = null;
      } else {
        const bpm = Number(patch.bpm);
        if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400) throw new Error('song/meta: bpm must be 20..400 (or null to clear)');
        s.bpm = bpm;
        s.bpmByHand = true;
        if (facts) facts.bpm = bpm;
        songDetectKick(deck);
      }
      // The track's record keeps what the hand typed, so the next load of this file comes back
      // with it (and an analysis never overwrites it).
      library?.rememberBpm?.(s.path, s.bpm).catch?.(() => {});
    }
    if ('key' in patch) {
      s.musicalKey = String(patch.key ?? '').trim() || null;
      delete s.keyDetected;
      library?.rememberKey?.(s.path, s.musicalKey).catch?.(() => {});
    }
    if ('anchorSec' in patch) {
      const a = Number(patch.anchorSec);
      if (!Number.isFinite(a)) throw new Error('song/meta: anchorSec must be a number (seconds)');
      s.anchorSec = Math.min(Math.max(0, a), s.duration);
      s.anchorByHand = true;
      s.gridDetected = null;
      // The grid outlives the session: the anchor goes on the track's record.
      library?.rememberAnchor?.(s.path, s.anchorSec).catch?.(() => {});
    }
    if ('sync' in patch) {
      if (patch.sync && s.bpm == null) throw new Error('sync needs a bpm - set one first (the tags had none)');
      s.sync = !!patch.sync;
      deckSongPrefs[deck].sync = s.sync;
    }
    if ('syncMult' in patch) {
      const m = patch.syncMult === 'auto' ? 'auto' : Number(patch.syncMult);
      if (m !== 'auto' && m !== 0.5 && m !== 1 && m !== 2) throw new Error('song/meta: syncMult must be "auto", 0.5, 1 or 2');
      s.syncMult = m;
    }
    if ('keylock' in patch && !!patch.keylock !== !!s.keylock) {
      s.keylock = !!patch.keylock;
      // Both paths carry the same moment of the song, so the switch is a crossfade - nothing moves.
      try { engine.songKeylock(trackIdOf(SONG_KEYS[deck]), s.keylock, now()); } catch { /* torn down */ }
    }
    if ('quantize' in patch) {
      s.quantize = !!patch.quantize;
      deckSongPrefs[deck].quantize = s.quantize;
    }
    songApplyRate(deck);
    mixNotify();
    return {
      deck, bpm: s.bpm, musicalKey: s.musicalKey, anchorSec: s.anchorSec,
      sync: s.sync, syncMult: s.syncMult, keylock: !!s.keylock, quantize: s.quantize !== false, rate: s.rate,
    };
  }

  // --- the per-deck tempo sliders (see the desktop's deckTempoApply for what each kind of deck
  // does with one) ---

  const deckTempoMult = (deck) => {
    const t = mixState.deckTempo[deck];
    return 1 + (t.frac * t.range) / 100;
  };

  function deckTempoApply(deck, { frac, range } = {}) {
    deckLeader();
    const t = mixState.deckTempo[deck];
    const prevMult = deckTempoMult(deck);
    if (range !== undefined) {
      const r = Number(range);
      if (!DECK_TEMPO_RANGES.includes(r)) throw new Error(`decktempo: range must be one of ±${DECK_TEMPO_RANGES.join('/±')}%`);
      t.range = r;
    }
    if (frac !== undefined) {
      const f = Number(frac);
      if (!Number.isFinite(f) || f < -1 || f > 1) throw new Error('decktempo: frac must be -1..1');
      t.frac = Math.abs(f) < 0.004 ? 0 : f;
    }
    const mult = deckTempoMult(deck);
    const s = songDecks[deck];
    if (s) {
      s.manualRate = Math.min(songSync.RATE_MAX, Math.max(songSync.RATE_MIN, mult));
      if (deck === songMasterDeck && s.playing && s.bpm) {
        transport.rampBpm(Math.min(400, Math.max(20, (s.bpm / songOctave(deck)) * mult)), 0);
      } else {
        songApplyRate(deck);
      }
    } else if (!deckLiveSynced(deck)) {
      deckClockApply(deck);
    } else if (!deckTempoLocked(deck)) {
      const base = (transport.cps * 240) / Math.max(0.01, prevMult);
      const bpm = Math.min(400, Math.max(20, base * mult));
      mixState.tempoOverride = bpm;
      transport.rampBpm(bpm, 0);
    }
    mixNotify();
    return { deck, frac: t.frac, range: t.range, pct: Math.round((mult - 1) * 1000) / 10 };
  }

  // --- the LEADER: whose tempo the room is - the deck playing longest (see the desktop) ---
  const deckPlayingSince = { a: null, b: null };
  const deckPlayingAt = { a: 0, b: 0 }; // wall-clock ms each deck's current run began
  let deckPlayingSeq = 0;
  let deckLeaderNow = null;

  function deckAudible(deck) {
    if (songDecks[deck]?.playing) return true;
    return [...schedulers()].some(([key, sch]) => deckOfKey(key) === deck && sch.running);
  }

  function deckLeader() {
    for (const d of DECKS) {
      if (!deckAudible(d)) deckPlayingSince[d] = null;
      else if (deckPlayingSince[d] == null) {
        deckPlayingSince[d] = ++deckPlayingSeq;
        deckPlayingAt[d] = Date.now();
      }
    }
    djSetObserve(Date.now());
    const playing = DECKS.filter((d) => deckPlayingSince[d] != null)
      .sort((x, y) => deckPlayingSince[x] - deckPlayingSince[y]);
    const leader = playing[0] ?? null;
    if (leader !== deckLeaderNow) {
      deckLeaderNow = leader;
      const s = leader && songDecks[leader];
      if (s?.playing && s.sync && s.bpm && songMasterDeck !== leader) {
        songMasterOctave = songOctave(leader);
        songMasterDeck = leader;
        songApplyRate(leader);
      }
    }
    // A saved pattern that stayed in the room counts as played tonight (the library's mark).
    return leader;
  }

  // --- the set's tracklist (see set-log-format.js; the desktop's djSet*) ---
  //
  // A set is a stretch of DJ mode with music in it: it begins with the first track that plays, and
  // ends when the desk closes or nothing has played for DJ_SET_GAP_MS. A track is a deck's RUN,
  // written once it has lasted DJ_SET_CONFIRM_MS (a cue held to audition is not a track of the
  // set), and a pause and resume of the same track is not a new line.
  const DJ_SET_CONFIRM_MS = 8000;
  const DJ_SET_GAP_MS = 30 * 60 * 1000;
  let djSet = null; // { started: Date, entries, file, lastActive, logged: { a, b }, lastId: { a, b } }

  /** What a deck is playing, as a tracklist line says it. */
  function djSetTrackOf(deck) {
    const s = songDecks[deck];
    if (s) {
      return { id: `song:${s.path}`, kind: 'song', title: s.artist ? `${s.artist} – ${s.title}` : s.title, bpm: s.bpm ?? null, key: s.musicalKey ?? null };
    }
    const { name, title } = deckBuffers[deck];
    const facts = evaluator?.facts?.(deck);
    return {
      id: `code:${name ?? title ?? ''}`,
      kind: 'livecode',
      title: name ?? title ?? 'unsaved buffer',
      subtitle: name && title && title !== name ? title : null,
      bpm: typeof facts?.bpm === 'number' ? facts.bpm : null,
      key: typeof facts?.scale === 'string' ? facts.scale : null,
    };
  }

  function djSetWrite(ended = null) {
    Promise.resolve(writeSet?.(djSet, ended)).catch((err) => log({ text: `[dj] couldn't write the set's tracklist: ${err?.message ?? err}`, level: 'warn' }));
  }

  /** Closes the set in progress: its end time and length, and its final name. */
  function djSetFinish() {
    if (!djSet) return;
    const anyPlaying = DECKS.some((d) => deckPlayingSince[d] != null);
    if (djSet.entries.length) djSetWrite(new Date(anyPlaying ? Date.now() : djSet.lastActive));
    djSet = null;
  }

  /** Called with every leader sample: confirms runs into tracklist lines. */
  function djSetObserve(t) {
    if (!mixState.dj) return;
    const playing = DECKS.filter((d) => deckPlayingSince[d] != null);
    if (djSet && !playing.length && t - djSet.lastActive > DJ_SET_GAP_MS) djSetFinish();
    if (!djSet && !playing.length) return;
    if (djSet && playing.length) djSet.lastActive = t;
    for (const d of playing) {
      const run = deckPlayingSince[d];
      if (djSet?.logged[d] === run || t - deckPlayingAt[d] < DJ_SET_CONFIRM_MS) continue;
      if (!djSet) djSet = { started: new Date(deckPlayingAt[d]), entries: [], file: null, lastActive: t, logged: { a: null, b: null }, lastId: { a: null, b: null } };
      djSet.logged[d] = run;
      const track = djSetTrackOf(d);
      if (track.id === djSet.lastId[d]) continue; // the same track resumed, not a new one
      djSet.lastId[d] = track.id;
      if (deckPlayingAt[d] < djSet.started.getTime()) djSet.started = new Date(deckPlayingAt[d]);
      djSet.entries.push({ at: deckPlayingAt[d], deck: d, ...track });
      if (track.kind === 'livecode' && deckBuffers[d].name) codePlayedSession.add(deckBuffers[d].name);
      djSetWrite();
    }
  }

  function deckTempoLocked(deck) {
    const leader = deckLeader();
    const s = songDecks[deck];
    if (s) return !!(s.sync && s.bpm && deck !== songMasterDeck && othersPlaying(deck));
    if (!deckLiveSynced(deck)) return false;
    return leader != null && leader !== deck;
  }

  function deckTempoBpm(deck) {
    const s = songDecks[deck];
    if (s) return s.bpm ? s.bpm * s.rate : null;
    return clockOf(deck).cps * 240;
  }

  // --- the deck clocks: a deck playing CODE has a platter, a sync button and a tempo of its own ---

  function deckClockApply(deck) {
    const clock = deckClocks[deck];
    const st = deckLive[deck];
    const file = !!songDecks[deck];
    clock.setFreeMult(deckTempoMult(deck));
    clock.setSync(file || deckLiveSynced(deck));
    clock.setBend(file ? 0 : songSync.effectiveRate(1, st.nudge, st.bend) - 1);
  }

  function deckLiveRelease(deck) {
    deckLive[deck].nudge = 0;
    deckLive[deck].bend = 0;
    deckClockApply(deck);
  }

  function deckSchedulers(deck) {
    const out = [...schedulers()].filter(([key]) => deckOfKey(key) === deck).map(([, sch]) => sch);
    if (fxSchedulers[deck]) out.push(fxSchedulers[deck]);
    return out;
  }

  function deckClockAlign(deck) {
    const clock = deckClocks[deck];
    const t = now();
    const before = clock.cycleAt(t);
    clock.align();
    const delta = clock.cycleAt(t) - before;
    if (delta) for (const sch of deckSchedulers(deck)) sch.relocate(delta);
  }

  const deckRunning = (deck) => evaluator?.deckRunning?.(deck) ?? false;

  function liveNudge(deck, { hold, jog }) {
    const clock = deckClocks[deck];
    const st = deckLive[deck];
    if (hold !== undefined) {
      st.nudge = Math.sign(Number(hold) || 0);
      deckClockApply(deck);
    }
    const dir = Math.sign(Number(jog) || 0);
    if (dir && deckRunning(deck)) {
      const delta = (dir * mixState.deckJog[deck].beats) / songSync.BEATS_PER_CYCLE;
      clock.jog(delta);
      for (const sch of deckSchedulers(deck)) sch.relocate(delta);
    }
    mixNotify();
    return { deck, nudge: st.nudge, offset: clock.offset };
  }

  function liveSetSync(deck, on) {
    deckLive[deck].sync = !!on;
    deckClockApply(deck);
    clockFollowSong();
    mixNotify();
    return { deck, sync: deckLive[deck].sync };
  }

  // --- the per-deck performance LOOP (see the desktop): a hold on the song clock for a deck of
  // code, a timestamped seek for a song deck ---

  function deckJogApply(deck, { beats, step } = {}) {
    const want = mixState.deckJog[deck];
    if (beats !== undefined) {
      if (!DECK_JOG_BEATS.includes(Number(beats))) throw new Error(`mix/jogsize: beats must be one of ${DECK_JOG_BEATS.join(', ')}`);
      want.beats = Number(beats);
    }
    const by = Math.sign(Number(step) || 0);
    if (by) {
      const n = DECK_JOG_BEATS.length;
      want.beats = DECK_JOG_BEATS[(DECK_JOG_BEATS.indexOf(want.beats) + by + n) % n];
    }
    mixNotify();
    return { beats: want.beats };
  }

  function deckLoopRung(beats) {
    const want = Number(beats);
    if (!Number.isFinite(want)) return DECK_LOOP_DEFAULT_BEATS;
    return DECK_LOOP_BEATS.reduce((best, b) => (Math.abs(b - want) < Math.abs(best - want) ? b : best));
  }

  const arrangeClockOf = (deck) => evaluator?.arrangeClockOf?.(deck) ?? null;

  function deckLoopWindow(deck, beats) {
    const s = songDecks[deck];
    if (s) {
      const bpm = songGridBpm(deck);
      if (!(bpm > 0)) return null;
      const beatSec = 60 / bpm;
      const pos = songPlayheadSec(deck);
      const from = s.quantize === false
        ? pos
        : s.anchorSec + Math.floor((pos - s.anchorSec) / beatSec) * beatSec;
      return { from: Math.max(0, from), to: Math.max(0, from) + beats * beatSec };
    }
    const clock = arrangeClockOf(deck);
    if (!clock) return null;
    const beatCyc = 1 / songSync.BEATS_PER_CYCLE;
    const pos = clock.posAt(clockOf(deck).cycleAt(now()));
    return deckLoopFit(deck, Math.max(0, Math.floor(pos / beatCyc) * beatCyc), beats * beatCyc);
  }

  function deckLoopFit(deck, from, span) {
    const end = arrangeClockOf(deck)?.end ?? 0;
    if (!(end > 0)) return { from, to: from + span };
    const len = Math.min(span, end);
    const at = Math.min(from, Math.max(0, end - len));
    return { from: at, to: at + len };
  }

  function deckLoopApply(deck, { on, beats, scale } = {}) {
    const want = mixState.deckLoop[deck];
    if (beats !== undefined) want.beats = deckLoopRung(beats);
    if (scale !== undefined) {
      const by = Number(scale);
      if (by !== 2 && by !== 0.5) throw new Error('mix/loop: scale must be 2 or 0.5');
      const at = DECK_LOOP_BEATS.indexOf(want.beats);
      want.beats = DECK_LOOP_BEATS[Math.min(DECK_LOOP_BEATS.length - 1, Math.max(0, at + (by === 2 ? 1 : -1)))];
    }
    const live = deckLoopLive(deck);
    const arm = on === undefined ? !!live : !!on;
    if (!arm) {
      deckLoopSet(deck, null);
    } else if (live && (beats !== undefined || scale !== undefined)) {
      const span = want.beats * deckLoopBeatLen(deck);
      deckLoopSet(deck, songDecks[deck] ? { from: live.from, to: live.from + span } : deckLoopFit(deck, live.from, span));
    } else {
      const window = deckLoopWindow(deck, want.beats);
      if (!window) {
        throw new Error(songDecks[deck]
          ? `deck ${deck}'s song has no tempo to count beats in - give it a bpm in the pane`
          : `deck ${deck} has nothing to loop yet`);
      }
      deckLoopSet(deck, window);
    }
    mixNotify();
    return deckLoopState(deck);
  }

  function deckLoopBeatLen(deck) {
    const bpm = songDecks[deck] ? songGridBpm(deck) : 0;
    return bpm > 0 ? 60 / bpm : 1 / songSync.BEATS_PER_CYCLE;
  }

  function deckLoopLive(deck) {
    const s = songDecks[deck];
    if (s) return s.loop ?? null;
    const hold = arrangeClockOf(deck)?.hold;
    return hold ? { from: hold.start, to: hold.end } : null;
  }

  function deckLoopSet(deck, window) {
    const s = songDecks[deck];
    if (s) {
      s.loop = window;
      songArmTimers(deck);
      return;
    }
    const clock = arrangeClockOf(deck);
    if (!clock) return;
    const cycle = !transport.paused ? clockOf(deck).cycleAt(now()) : 0;
    clock.setHold(window ? { start: window.from, end: window.to } : null, cycle);
  }

  function deckLoopState(deck) {
    const live = deckLoopLive(deck);
    return { on: !!live, beats: mixState.deckLoop[deck].beats, from: live?.from ?? null, to: live?.to ?? null };
  }

  // --- who holds the clock (see the desktop's clockHeldByDesk and djCodeTempo) ---

  function deckNativeBpm(deck) {
    const s = songDecks[deck];
    if (s) return s.bpm ?? DEFAULT_BPM;
    return evaluator?.nativeBpm?.(deck) ?? DEFAULT_BPM;
  }

  function djCodeTempo(deck, { fresh = false, alone = false } = {}) {
    const native = deckNativeBpm(deck);
    const before = fresh ? undefined : djDeclaredBpm[deck];
    djDeclaredBpm[deck] = native;
    if (!mixState.dj || native == null || !deckLiveSynced(deck)) return;
    const changed = before !== undefined && before !== native && deckLeader() === deck;
    if (!alone && !changed) return;
    const bpm = Math.min(400, Math.max(20, native * deckTempoMult(deck)));
    if (mixState.tempoOverride != null) mixState.tempoOverride = bpm;
    transport.rampBpm(bpm, 0);
    mixNotify();
  }

  function clockHeldByDesk(forDeck = null) {
    if (mixState.dj) return true;
    if (mixState.tempoOverride != null) return true;
    if (songMasterDeck != null && !!songDecks[songMasterDeck]?.playing) return true;
    if (!forDeck || deckRunning(forDeck)) return false;
    return DECKS.some((d) => d !== forDeck && deckRunning(d));
  }

  // --- the clock following a free-running song (or a deck of code with its sync off) ---
  const songFollow = { deck: null, offset: 0, adoptPending: false };
  let songFollowing = false;

  function songFollowDeck() {
    if (!mixState.dj) return null;
    const d = deckLeader();
    const s = d && songDecks[d];
    if (s) return s.playing && !s.sync && s.bpm ? d : null;
    return d && !deckLive[d].sync && deckRunning(d) ? d : null;
  }

  function songFollowReport(deck, atSec) {
    const s = songDecks[deck];
    if (!s) {
      const clock = deckClocks[deck];
      return { bpm: clock.cps * 240, beats: clock.cycleAt(atSec) * songSync.BEATS_PER_CYCLE, atSec };
    }
    return { bpm: s.bpm * s.rate, beats: ((songPlayheadSec(deck, atSec) - s.anchorSec) * s.bpm) / 60, atSec };
  }

  function songFollowPhaseAt(atSec) {
    const d = songFollowDeck();
    return d ? linkSync.sessionPhase(songFollowReport(d, atSec).beats) : null;
  }

  function clockFollowSong({ adopt = false } = {}) {
    if (songFollowing) return;
    const deck = songFollowDeck();
    if (deck !== songFollow.deck) {
      songFollow.deck = deck;
      songFollow.offset = 0;
      songFollow.adoptPending = deck != null;
    }
    if (!deck) return;
    songFollowing = true;
    try {
      const t = now();
      const report = songFollowReport(deck, t);
      if (!linkSync.sameTempo(report.bpm, transport.cps * 240)) transport.setCps(report.bpm / 240);
      if (transport.paused) return;
      const ridden = DECKS.some((d) => d !== deck
        && (songDecks[d] ? songDecks[d].playing && songDecks[d].sync : deckRunning(d) && deckLive[d].sync));
      const measured = linkSync.phaseDelta(transport.cycleAt(t), report.beats);
      const step = linkSync.followStep(measured, songFollow.offset, { mayAdopt: adopt || (songFollow.adoptPending && !ridden) });
      songFollow.offset = step.offset;
      if (step.kind === 'adopt' || step.kind === 'accept') songFollow.adoptPending = false;
      if (step.shift) transport.shiftCycles(step.shift);
      if (step.kind === 'adopt') mixNotify();
    } finally {
      songFollowing = false;
    }
  }

  function clockTakeLeaderPlace(forDeck) {
    if (transport.paused || !mixState.dj) return 0;
    const lead = deckLeader();
    const clock = lead && deckClocks[lead];
    if (!clock || lead === forDeck || songDecks[lead] || !deckLive[lead].sync) return 0;
    const o = other(lead);
    if (songDecks[o] ? songDecks[o].playing && songDecks[o].sync : deckAudible(o) && deckLive[o].sync) return 0;
    const off = clock.offset;
    if (Math.abs(off) < 1e-9) return 0;
    const t = now();
    const otherClock = deckClocks[o];
    const before = otherClock.cycleAt(t);
    transport.shiftCycles(off);
    clock.align();
    const moved = otherClock.cycleAt(t) - before;
    if (moved) for (const sch of deckSchedulers(o)) sch.relocate(moved);
    mixNotify();
    return off;
  }

  // A deck's clock moving on its own account - a nudge, a bend, its own tempo, a jog. Riding the
  // room it says nothing: the room's hook (onCpsChange below) speaks for every clock on it.
  for (const d of DECKS) {
    deckClocks[d].onCpsChange = () => {
      if (d === songFollow.deck) clockFollowSong();
      tellTempo();
      mixNotify();
    };
    deckClocks[d].onStateChange = () => {
      tellTempo();
      mixNotify();
    };
  }

  /**
   * The devices that keep time - a synced delay, a ducker, a beat repeat - hear the room's tempo,
   * except on a deck whose clock has left the room's (sync off, a nudge held, a jog): its tracks
   * hear that deck's own, as the desktop tells a deck's plugins its own (syncEngineClock).
   */
  function tellTempo() {
    if (typeof engine.setTempo !== 'function') return;
    const own = DECKS.filter((d) => deckClocks[d].deviates);
    const tracksOf = (d) => [...(evaluator?.trackIds ?? [])].filter(([key]) => deckOfKey(key) === d).map(([, id]) => id);
    const except = own.flatMap(tracksOf);
    engine.setTempo(transport.cps * 240, transport.secAt(0), except.length ? { except } : null);
    for (const d of own) {
      const only = tracksOf(d);
      if (only.length) engine.setTempo(deckClocks[d].cps * 240, deckClocks[d].secAt(0), { only });
    }
  }

  // --- the timers that run while the desk is open ---
  let leaderTimer = null;
  let followTimer = null;
  function setDj(on) {
    if (!on && mixState.dj && !songDecks.a && !deckLive.a.sync && deckRunning('a')) {
      transport.setCps(deckClocks.a.baseCps);
    }
    mixState.dj = !!on;
    djDeclaredBpm.a = djDeclaredBpm.b = undefined;
    for (const d of DECKS) deckLiveRelease(d);
    if (mixState.dj && !leaderTimer) {
      leaderTimer = setInterval(deckLeader, LEADER_POLL_MS);
      followTimer = setInterval(() => clockFollowSong(), FOLLOW_POLL_MS);
    } else if (!mixState.dj && leaderTimer) {
      clearInterval(leaderTimer);
      clearInterval(followTimer);
      leaderTimer = followTimer = null;
    }
    if (!mixState.dj) djSetFinish();
    mixNotify();
    return { dj: mixState.dj };
  }

  // ---------------------------------------------------------------------------------------------
  // Loading a song, and what it is measured to be
  // ---------------------------------------------------------------------------------------------

  /** Forget one deck's song: its player let go and its memory released. The track stays warm. */
  function songUnload(deck) {
    const s = songDecks[deck];
    if (!s) return;
    clearTimeout(s.endTimer);
    clearTimeout(s.loopTimer);
    clearTimeout(s.loopApplyTimer);
    s.endTimer = s.loopTimer = s.loopApplyTimer = null;
    s.playing = false;
    songDecks[deck] = null;
    deckClockApply(deck);
    songHandGridOver(deck);
    try { engine.songFree(trackIdOf(SONG_KEYS[deck])); } catch { /* torn down */ }
  }

  async function songLoad(body) {
    if (!songs) throw new Unsupported('loading a song onto a deck', 'this page has no way to read one');
    const deck = deckArg(body.deck);
    const key = SONG_KEYS[deck];
    const srcPath = String(body.path ?? '');
    songLoading.add(deck);
    let loaded;
    // What the collection already knows about this file: a tempo or key typed by hand, an anchor
    // placed by hand - the record a load comes back to.
    const record = await library?.recordOf?.(srcPath).catch?.(() => null) ?? null;
    try {
      // A tempo the playlist item states is the beatgrid fit's hint: it pins the octave, and the
      // fit refines it (see the desktop's songDetectKick).
      const hinted = Number(body.bpm);
      loaded = await songs.load(srcPath, { bpmHint: Number.isFinite(hinted) && hinted >= 20 && hinted <= 400 ? hinted : null });
      if (songDecks[deck]) songMarkPaused(deck);
      songUnload(deck);
      const tid = evaluator.claimTrack(key);
      engine.createTrack(tid, mixBirthFor(key));
      engine.songLoad(tid, { planes: loaded.planes, frames: loaded.frames });
    } finally {
      songLoading.delete(deck);
    }
    const duration = loaded.frames / loaded.sampleRate;
    const bodyBpm = Number(body.bpm);
    const tagBpm = loaded.tags?.bpm ?? null;
    // The item's word (a playlist row carries its record's), then the record, then the file's tag.
    const bpm = Number.isFinite(bodyBpm) && bodyBpm >= 20 && bodyBpm <= 400 ? bodyBpm : (record?.bpm ?? tagBpm);
    const bpmByHand = !!record?.byHand?.includes('bpm') && record.bpm === bpm;
    const heldAnchor = (() => {
      const held = record?.anchorSec;
      const a = held == null ? NaN : Number(held);
      return Number.isFinite(a) && a >= 0 && a <= duration ? a : null;
    })();
    deckLive[deck].nudge = 0;
    deckLive[deck].bend = 0;
    deckClocks[deck].setBend(0);
    deckClocks[deck].setSync(true);
    deckClockAlign(deck);
    songDecks[deck] = {
      path: srcPath,
      title: String(body.title ?? '').trim() || record?.title || loaded.tags?.title || loaded.title || srcPath.split('/').pop(),
      artist: record?.artist ?? loaded.tags?.artist ?? null, // the tracklist names it
      duration,
      sampleRate: loaded.sampleRate,
      channels: loaded.channels,
      frames: loaded.frames,
      decoded: true,
      rate: 1,
      rateBefore: 0,
      playing: false,
      posSec: 0,
      startSec: 0,
      endTimer: null,
      loop: null,
      loopTimer: null,
      loopApplyTimer: null,
      bpm,
      bpmByHand,
      musicalKey: String(body.key ?? '').trim() || record?.key || loaded.tags?.key || null,
      anchorSec: heldAnchor ?? 0,
      anchorByHand: heldAnchor != null,
      gridDetected: null,
      onsets: null,
      sync: bpm != null && (deckSongPrefs[deck].sync ?? true),
      syncMult: 'auto',
      keylock: false,
      quantize: deckSongPrefs[deck].quantize ?? true,
      manualRate: deckTempoMult(deck),
      nudge: 0,
      bend: 0,
      cueSec: 0,
      cueHeld: false,
      wave: loaded.wave,      // a promise of the waveform the pane draws
      facts: loaded.facts,    // ...and of the beatgrid, key and transients
    };
    const facts = evaluator?.facts?.(deck);
    if (facts) facts.bpm = bpm;
    songApplyRate(deck);
    fxApplyTo(key); // a fresh song track joins the FX unit's send like a stem
    mixNotify();
    songDetectKick(deck);
    return {
      deck, key, duration, sampleRate: loaded.sampleRate, channels: loaded.channels,
      decoded: true, bpm, musicalKey: songDecks[deck].musicalKey, sync: songDecks[deck].sync,
    };
  }

  /**
   * Adopt what the analysis measured, into the facts still open when it lands (see the desktop's
   * songDetectKick). The deck's state object is the staleness token: a re-load or an unload in
   * the meantime wins by construction. A bpm typed by hand is the fit's hint and stands.
   */
  async function songDetectKick(deck, { again = false } = {}) {
    const s = songDecks[deck];
    if (!s) return;
    let facts;
    try {
      facts = again ? await songs.measure(s.path, { bpmHint: s.bpm }) : await s.facts;
      if (s.bpmByHand && !again && facts?.bpmHint !== s.bpm) facts = await songs.measure(s.path, { bpmHint: s.bpm });
    } catch (err) {
      log({ text: `[song] deck ${deck.toUpperCase()}: the analysis failed - ${err?.message ?? err}`, level: 'warn' });
      return;
    }
    if (songDecks[deck] !== s || !facts) return;
    let changed = false;
    s.onsets = facts.onsets ? facts.onsets.filter((t) => t > 0.002) : null;
    if (facts.bpm != null && s.bpm !== facts.bpm && !s.bpmByHand) {
      const refining = s.bpm != null;
      if (!refining || Math.abs(facts.bpm / s.bpm - 1) < 0.03) {
        s.bpm = facts.bpm;
        if (!refining) s.bpmDetected = facts.bpmConfidence ?? 0;
        const f = evaluator?.facts?.(deck);
        if (f) f.bpm = facts.bpm;
        if (!refining && !s.playing && !s.sync) s.sync = true;
        changed = true;
      }
    }
    if (facts.anchorSec != null && !s.anchorByHand) {
      s.anchorSec = Math.min(Math.max(0, facts.anchorSec), s.duration);
      s.gridDetected = facts.gridConfidence ?? 0;
      changed = true;
    }
    if (s.musicalKey == null && facts.key != null) {
      s.musicalKey = facts.key;
      s.keyDetected = facts.keyConfidence ?? 0;
      changed = true;
    }
    // The collection learns what the deck just measured, rather than measuring the file again
    // later; its record only takes what nothing else stated.
    library?.setFacts?.(s.path, { bpm: facts.bpm, key: facts.key }).catch?.(() => {});
    if (!changed) return;
    songApplyRate(deck);
    mixNotify();
  }

  // ---------------------------------------------------------------------------------------------
  // The DJ FX unit: one named CHAIN of effects, written as ordinary poptart code, switched in as an
  // INSERT on each assigned deck (see the desktop's FX section for the whole reasoning). A chain is
  // chain code with its head left off - `.fx("Filter").param("Cutoff", fx1)` - and `fx1` is the
  // unit's knob as a signal. Each deck's tracks send their finished stage onto a bus that deck's
  // RETURN track reads (`song` in the chain's scope); the return wears the deck's crossfader gain,
  // so the gain applies exactly once. The chains are kept in this browser's store, global, so a
  // chain written once is there in every session.
  // ---------------------------------------------------------------------------------------------

  let djFx = { chains: {} };
  const fxTracksLive = { a: false, b: false };
  const fxSchedulers = { a: null, b: null };
  const djFxChainNames = () => Object.keys(djFx.chains);
  const saveDjFx = () => store?.put?.(DJ_FX_KEY, djFx).catch?.(() => {});
  const fxSounding = () => !!mixState.fx.chain && (mixState.fx.on || mixState.fx.held);

  function fxSendLevels() {
    const on = fxSounding();
    const { assign } = mixState.fx;
    return { a: on && assign.includes('a') ? 1 : 0, b: on && assign.includes('b') ? 1 : 0 };
  }

  /** Point one (possibly just-created) track's FX send where the unit wants it. */
  function fxApplyTo(key) {
    const deck = deckOfKey(key);
    if (!fxTracksLive[deck] || key === FX_KEYS[deck]) return;
    // A group member feeds the unit through its group, like everything else it makes.
    engine.setFxSend?.(trackIdOf(key), FX_BUSES[deck], groupMembers.has(key) ? 0 : fxSendLevels()[deck]);
  }

  function fxApplySends() {
    const levels = fxSendLevels();
    for (const key of mixKeys()) {
      const deck = deckOfKey(key);
      if (fxTracksLive[deck]) engine.setFxSend?.(trackIdOf(key), FX_BUSES[deck], levels[deck]);
    }
  }

  // The return track, created on first use, born wearing only the deck gain, its cue and its
  // meter side - never the EQ/filter broadcasts, which already shaped what reaches it.
  function fxEnsureTrack(deck) {
    const tid = evaluator.claimTrack(FX_KEYS[deck]);
    if (!fxTracksLive[deck]) {
      engine.createTrack(tid, {
        deck: deckXfGain(deck) * mixState.faders[deck],
        cue: mixState.perDeck[deck].get('cue') ?? 0,
        mdeck: deck === 'b' ? 1 : 0,
      });
      fxTracksLive[deck] = true;
    }
    return tid;
  }

  /** One deck's return Sig from a chain's code: `song` + the code, the knob bound as `fx1`. */
  function fxBuildSig(deck, code) {
    if (!blockEvaluator) throw new Unsupported('the DJ FX unit', 'this page has no evaluator to build a chain with');
    const builders = { song: patternCore.audio(`bus:${FX_BUSES[deck]}`) };
    for (let i = 1; i <= patternCore.FX_KNOB_COUNT; i++) builders[`fx${i}`] = patternCore.fxknob(i);
    const sig = blockEvaluator(builders)(`song${code}`);
    if (!(sig instanceof patternCore.Sig)) {
      throw new Error('an FX chain has to end up a chain - start it with .fx("…") and keep it one expression');
    }
    return sig;
  }

  /** Load a chain onto both decks (or clear the unit with a null name). Built before applied. */
  function fxLoadChain(name) {
    const chain = name == null ? null : djFx.chains[String(name)];
    if (name != null && !chain) throw new Error(`mix/fx: no FX chain called ${JSON.stringify(String(name))}`);
    if (!chain) {
      for (const deck of DECKS) {
        fxSchedulers[deck]?.stop();
        fxSchedulers[deck] = null;
      }
      mixState.fx.chain = null;
      fxApplySends();
      mixNotify();
      return null;
    }
    const code = chain.knobWet === false ? String(chain.code ?? '') : `${chain.code ?? ''}.wet(fx1)`;
    const sigs = { a: fxBuildSig('a', code), b: fxBuildSig('b', code) };
    for (const deck of DECKS) {
      const tid = fxEnsureTrack(deck);
      let sch = fxSchedulers[deck];
      if (!sch) {
        sch = new patternCore.Scheduler(engine, { transport: clockOf(deck), trackId: tid, label: FX_KEYS[deck], deck });
        fxSchedulers[deck] = sch;
      }
      sch.setPattern(sigs[deck]);
      if (!sch.running) sch.start(clockOf(deck).cycleAt(now()));
    }
    mixState.fx.chain = String(name);
    fxApplySends();
    mixNotify();
    return mixState.fx.chain;
  }

  function mixFxSet({ on, held, knob, assign } = {}) {
    if (on !== undefined) mixState.fx.on = !!on;
    if (held !== undefined) mixState.fx.held = !!held;
    if (knob !== undefined) {
      const v = Number(knob);
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('mix/fx: knob must be 0..1');
      mixState.fx.knob = v;
      patternCore.setFxKnob(1, v); // the chain reads this as `fx1` on its next poll
    }
    if (assign !== undefined) {
      if (!FX_ASSIGNS.includes(assign)) throw new Error("mix/fx: assign must be 'a', 'ab' or 'b'");
      mixState.fx.assign = assign;
    }
    fxApplySends();
    mixNotify();
    return { ...mixState.fx };
  }

  // `.fx("Name")` / `.fx("Name", { state: "…" })` -> the same call carrying `states[i]`, in chain
  // order, so slot N's capture lands on the Nth .fx() call however the chain is spaced (the
  // desktop's fxWriteStates). A null capture leaves its call exactly as it was.
  function fxWriteStates(code, states) {
    let i = 0;
    return String(code).replace(/\.fx\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*(?:,\s*\{[^}]*\}\s*)?\)/g, (whole, q, device) => {
      const state = states[i++];
      if (!state) return whole;
      return `.fx(${q}${device}${q}, { state: ${JSON.stringify(state)} })`;
    });
  }

  /**
   * What a chain's device window left in one slot, written into the chain's own code as that
   * slot's `state`, and the chain rebuilt onto both decks from it - that code is where the
   * chain's settings live, so the next session plays them too.
   */
  async function fxPinState(slot, state) {
    const name = mixState.fx.chain;
    const chain = name && djFx.chains[name];
    if (!chain || !state) return null;
    const states = [];
    states[slot - 1] = state;
    const written = fxWriteStates(chain.code, states);
    if (written === chain.code) return null;
    chain.code = written;
    await saveDjFx();
    fxLoadChain(name);
    return written;
  }

  // Leaving DJ mode: park every send, stop the chains, drop the return tracks. The chains
  // themselves are kept - they are what makes the unit the same unit next session.
  function fxTeardown() {
    for (const key of mixKeys()) {
      try { engine.setFxSend?.(trackIdOf(key), '', 0); } catch { /* torn down */ }
    }
    for (const deck of DECKS) {
      fxSchedulers[deck]?.stop();
      fxSchedulers[deck] = null;
      if (fxTracksLive[deck]) {
        fxTracksLive[deck] = false;
        evaluator?.dropTrack?.(FX_KEYS[deck]);
      }
    }
    mixState.fx.chain = null;
    mixState.fx.on = false;
    mixState.fx.held = false;
  }

  // ---------------------------------------------------------------------------------------------
  // A CONTROLLER for the desk, through Web MIDI: learning its knobs, pads and platter, driving the
  // desk from them, and writing the lamps and meters back - the desktop's mix-strip MIDI, ported as
  // it is (server.js). What the desktop keeps in settings.json is kept in this browser's store.
  // ---------------------------------------------------------------------------------------------

  // { map: target -> { device, channel, kind, num }, feedback: the talk-back port's name or null }
  const midiSettings = { map: {}, feedback: null };
  let mixFeedbackActive = null; // the port the lamps actually go to
  const saveMidi = () => store?.put?.(MIDI_KEY, { ...midiSettings }).catch?.(() => {});
  const say = (text) => log({ text, level: 'info' });
  const needMidi = () => {
    if (!midi?.available) throw new Unsupported('learning a controller for the desk', 'this browser has no MIDI - Chrome, Edge and Firefox do');
    return midi;
  };

  // The PLATTER as a continuous control (the `scrub` MIDI target): a jog wheel says how far it
  // just turned, not where in the track it is, so its messages are DELTAS and they arrive dozens
  // a second under a moving hand. Each one is accumulated and the deck is seeked once per flush -
  // a seek is an engine message plus a model rebase, a servo reset and a re-armed end timer, and
  // thirty of those a second is a deck fighting itself.
  const SONG_SCRUB_FLUSH_MS = 30;
  const songScrubPending = { a: 0, b: 0 };
  const songScrubTimer = { a: null, b: null };

  /** Move the playhead by `deltaSec`, coalesced. Silent about a deck with no song - a hand on the
   *  platter of an empty deck should feel like nothing, not raise anything. */
  function songScrub(deck, deltaSec) {
    if (!songDecks[deck] || !deltaSec) return;
    songScrubPending[deck] += deltaSec;
    if (songScrubTimer[deck]) return;
    songScrubTimer[deck] = setTimeout(() => {
      songScrubTimer[deck] = null;
      const by = songScrubPending[deck];
      songScrubPending[deck] = 0;
      if (!by || !songDecks[deck]) return;
      try { songSeekTo(deck, songPlayheadSec(deck) + by); } catch { /* engine between restarts */ }
    }, SONG_SCRUB_FLUSH_MS);
  }

  // The platter as a PITCH BEND (the `bend` MIDI target): a light wheel turn while the deck plays
  // bends the rate with the turn and eases back to base when the hand rests - the beatmatch
  // correction gesture, where scrub is the needle drop. Ticks are batched like the scrub's; the
  // rate math (proportional target, attack, release) is song-sync.js's bendStep, and the flush
  // keeps ticking until the bend has died away so the release is heard without further input.
  // The playhead model rides the bent rate (songApplyRate rebases on every step), so the phase a
  // bend moved STAYS moved - on a synced deck that is the whole point, and the drift servo, which
  // only measures engine-vs-model, has nothing to pull back.
  const SONG_BEND_FLUSH_MS = 30;
  const songBendState = {
    a: { ticks: 0, timer: null, last: 0 },
    b: { ticks: 0, timer: null, last: 0 },
  };

  /** One relative platter message's worth of bend (`ticks` signed, 64-centered cc convention). */
  function songBend(deck, ticks) {
    const st = songBendState[deck];
    if (!songDecks[deck] && !deckRunning(deck)) return; // an empty deck's platter should feel like nothing
    st.ticks += ticks || 0;
    if (st.timer) return;
    st.last = Date.now();
    st.timer = setInterval(() => {
      // A deck playing code bends its own clock (see liveNudge) - the same gesture, the same curve.
      const s = songDecks[deck] ?? (deckRunning(deck) ? deckLive[deck] : null);
      const now = Date.now();
      const dt = Math.max(0.001, (now - st.last) / 1000);
      st.last = now;
      const t = st.ticks;
      st.ticks = 0;
      if (!s) {
        clearInterval(st.timer);
        st.timer = null;
        return;
      }
      s.bend = songSync.bendStep(s.bend ?? 0, t, dt);
      if (!t && s.bend === 0) {
        clearInterval(st.timer);
        st.timer = null;
      }
      if (s === deckLive[deck]) deckClockApply(deck);
      else songApplyRate(deck);
      mixNotify(); // the pane's rate readout follows the bend (throttled like every desk frame)
    }, SONG_BEND_FLUSH_MS);
  }


  /**
   * The PLAY BUTTON, both halves: a playing deck pauses where it stands, a paused one resumes
   * from there. What a learned play pad presses (the deck head's button does the same thing for a
   * song deck, and evaluates the buffer for a deck holding code - which is the browser's, see
   * mixMidiButton).
   */
  function songTogglePlay(deck) {
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    if (!s.playing) return songPlayDeck(deck);
    s.cueHeld = false; // a pause under a held cue wins; the release finds nothing to undo
    songPause(deck);
    mixNotify();
    return { deck, pos: s.posSec, playing: false };
  }


  // The tempo-ratio button's cycle, ½x -> 1x -> 2x -> auto, shared by the pane's click and the
  // learned pad. The deck that set the clock has no ratio to choose (its tempo IS the clock), so
  // its button is grayed and its pad does nothing.
  const SONG_MULT_ORDER = ['auto', 0.5, 1, 2];
  function songMultNext(deck) {
    const cur = songDecks[deck]?.syncMult ?? 'auto';
    return SONG_MULT_ORDER[(SONG_MULT_ORDER.indexOf(cur) + 1) % SONG_MULT_ORDER.length];
  }


  /** Step the unit through the chain list (the fxnext/fxprev pads). */
  function mixFxStep(dir) {
    const list = djFxChainNames();
    if (!list.length) throw new Error('no FX chains yet - write one in the desk\'s FX editor');
    const at = list.indexOf(mixState.fx.chain);
    const next = list[((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir + list.length) % list.length];
    return Promise.resolve().then(() => fxLoadChain(next));
  }


  // --- mix-strip MIDI (learn + drive) ---
  //
  // A hardware control per desk control: `midiSettings.map` maps a target name to the
  // { device, channel, cc } that drives it, persisted in settings.json like everything else.
  // Learning is a long-poll: /api/mix/midilearn arms a target, the next CC message anywhere binds
  // it. A mapped (or learning) CC is CONSUMED - a knob given to the desk must not also drive a
  // midicc() in song code.
  //
  // Three kinds of target, because a controller has three kinds of control:
  //
  //   KNOBS   - the desk proper (crossfader, trim, the EQ bands, the filter pair, the channel
  //             faders). The CC's 0..1 lands in the control's own range (mixMidiValue) and is
  //             applied continuously.
  //   BUTTONS - a deck's transport and its facts row. HOLD buttons act on BOTH edges, because the
  //             gesture lasts as long as the finger does (a platter push bends the rate while
  //             held; cue previews while held and comes home on release). PRESS buttons act on
  //             the press edge only: play, the headphone audition, sync, the tempo ratio, keylock,
  //             the two jogs, and the two queue steps.
  //   PLATTER - two relative encoders per deck, which is how a jog wheel drives the playhead:
  //             `scrub` is the wheel at 1:1 with the record and `search` is the same wheel in its
  //             coarse mode, for crossing a track rather than placing a beat. See
  //             mixMidiScrubDelta for the convention and songScrub for the flush.
  //
  // Most targets are the SERVER's to act on, and that is the point of the mapping living here: a
  // learned control drives the engine with no browser in the loop, and the on-screen desk finds
  // out over the SSE mirror like any other watcher. Two things can't work that way, because the
  // state they need isn't here: stepping the set's queue is the library's (the playlists and the
  // pickers live in the browser), and `play` on a deck holding CODE means evaluating a buffer only
  // the editor has. Those press edges are forwarded to the client as an `action` frame on the same
  // channel, and it runs the gesture exactly as its own button does.
  const MIX_MIDI_KNOBS = ['trim', 'eqlo', 'eqmid', 'eqhi', 'djf', 'djres', 'fader'];
  const MIX_MIDI_HOLD = ['nudgedn', 'nudgeup', 'cue'];
  const MIX_MIDI_PRESS = ['jogdn', 'jogup', 'jogsize', 'play', 'phones', 'sync', 'mult', 'keylock', 'quant',
    'regions', 'loop', 'loophalve', 'loopdouble', 'temporange'];
  // `tempo` is the deck's pitch fader and `bend` the platter's pitch-bend mode - continuous like
  // the platter pair, but dispatched to their own gestures rather than through mixMidiValue.
  const MIX_MIDI_DECK_CTLS = [...MIX_MIDI_KNOBS, ...MIX_MIDI_HOLD, ...MIX_MIDI_PRESS, 'scrub', 'search', 'bend', 'tempo'];
  // The FX unit's controls carry no deck prefix - the unit is one shared thing with an assign
  // switch, like the crossfader. fxon latches, fxhold sounds it only while held (the two pad
  // flavors hardware has); fxnext/fxprev step the chain list; fxknob is the unit's knob (`fx1`).
  // --- the library browser's controls -----------------------------------------------------------
  //
  // Browsing is the BROWSER's: the sources, the sets, the table and its selection all live in the
  // page, so not one of these can be acted on from here. They are learned here like every other
  // control and forwarded as `action` frames (see mixActionNotify) - the road `next`/`prev` and a
  // code deck's play button already take.
  //
  // Four buttons and one knob - what it takes to work the browser with no keyboard at all. The
  // knob scrolls whatever has FOCUS, and two buttons move the focus in and out, the way a column
  // browser works:
  //   browse        the knob - one entry per tick, through whatever is focused
  //   browseload    ENTER: one layer in. On the sidebar that is "open this source and show me its
  //                 songs"; on the songs it is "load this one onto the active deck"
  //   browseout     one layer OUT: back to the sidebar, and it LATCHES there until an enter goes
  //                 back in. Learned from shift+enter on hardware that has a shift layer, which
  //                 is why the learn for it settles (see the `settle` option of /api/mix/midilearn:
  //                 holding shift sends a note of its own, and the first-message-wins learn bound
  //                 that instead of the combination, 2026-10-05)
  //   browsefilter  the tempo filter on and off
  //   browseopen    opens and closes the window itself
  const MIX_MIDI_BROWSE_PRESS = ['browseload', 'browseout', 'browsefilter', 'browseopen'];

  // The knob. Relative, and read in either convention hardware sends; see mixMidiBrowseTicks.
  const MIX_MIDI_BROWSE_KNOBS = ['browse'];

  const MIX_MIDI_GLOBAL_PRESS = ['fxon', 'fxnext', 'fxprev', 'fxassign', ...MIX_MIDI_BROWSE_PRESS];
  const MIX_MIDI_GLOBAL_HOLD = ['fxhold'];
  // `fxassign` above is the one-BUTTON form: a press cycles A -> A+B -> B, which is what a surface
  // with a single assign pad can drive. A surface with a three-position SWITCH cannot: it sends a
  // different message per position, so one binding only ever hears one of the three, and flipping
  // the switch cycled the unit onto whatever came next instead of the deck printed on the switch.
  // These are that switch - one target per position, each saying absolutely where the unit goes.
  const MIX_MIDI_FX_POS = { fxassigna: 'a', fxassignb: 'b', fxassignab: 'ab' };
  // The headphone section's two knobs, shared by both decks like the crossfader (see headphonesSet).
  const MIX_MIDI_PHONES_KNOBS = ['hplevel', 'hpmix'];
  const MIX_MIDI_GLOBAL = new Set(['xf', 'fxknob', ...MIX_MIDI_PHONES_KNOBS, ...MIX_MIDI_BROWSE_KNOBS, ...MIX_MIDI_GLOBAL_PRESS,
    ...MIX_MIDI_GLOBAL_HOLD, ...Object.keys(MIX_MIDI_FX_POS)]);
  const MIX_MIDI_TARGETS = new Set([...MIX_MIDI_GLOBAL,
    ...['a', 'b'].flatMap((d) => MIX_MIDI_DECK_CTLS.map((c) => `${d}:${c}`))]);
  // { target, finish, timer, settle?, candidate?, settleTimer? } while a learn long-poll is armed.
  //
  // `settle` is for learning a COMBINATION. Holding shift and pressing a pad sends two messages -
  // shift's own note first, then the pad's - and a learn that takes the first one bound shift
  // instead of the combination (2026-10-05, the browser wizard's "out" step). With a settle window
  // the arm keeps the LAST learnable message it saw and binds that once the window has passed
  // quietly, which is the same shape the switch sweep above uses. A single press settles to itself,
  // so the only cost is the window.
  let mixMidiLearn = null;

  // Long enough for a hand holding shift to reach a pad, short enough not to feel like a pause.
  const MIX_LEARN_SETTLE_MS = 450;
  let mixMidiMonitor = false; // while the desk's `midi` mode is on: say what the hardware sends
  const mixMidiSaid = new Map(); // "kind num ch" -> when the monitor last printed it (throttle)
  const mixMidiDown = new Map(); // target -> was the pad down last message: what makes an EDGE
  const mixMidiLastErr = new Map(); // target -> the last complaint it made, so it makes it once

  // A mapping is { device, channel, kind, num } - `kind` being 'cc' or 'note', because a cc 7 and
  // a note 7 are different controls. Entries learned before the note feed existed have neither
  // field and are read as the cc they were.
  const midiKind = (m) => m?.kind ?? 'cc';
  const midiNum = (m) => m?.num ?? m?.cc;
  const midiSame = (m, device, channel, num, kind) => !!m
    && m.device === device && m.channel === channel && midiNum(m) === num && midiKind(m) === kind;
  const midiSay = (channel, num, kind) => `${kind} ${num} (ch ${channel})`;

  // --- high-resolution (14-bit) ccs -------------------------------------------------------------
  //
  // A pitch fader worth beatmatching on does not send 128 steps. The MIDI convention for a
  // high-resolution control is a PAIR of ccs sent together, coarse first: the coarse half on a
  // number below 32 and the fine half on that number plus 32. Ignoring the pair goes wrong twice.
  //
  // The fine half looks exactly like a control of its own, and it is the half that moves MOST - so
  // a learn that takes the next message it likes can bind it, and the "fader" then sweeps 0..127
  // over and over across an inch of travel. That is not a hypothetical: a deck's tempo slider was
  // learned onto cc 32, which is the fine half of cc 0, and it jumped all over the place.
  //
  // And 7 bits is not enough for the control anyway. Over +-6%, 128 steps is 0.09% apiece - about
  // 0.11 bpm at 120, which is an audible step when you are matching beats by ear.
  //
  // So a coarse message is remembered; a fine message arriving just behind its own coarse half
  // REFINES that target instead of being a target. Only when the desk has a reason to care, mind:
  // plenty of surfaces use cc 32..63 as ordinary controls, and those still have to reach midicc().
  // The reason is either a binding already on the coarse address or a learn waiting to make one.
  // The two halves of one move. A hand cannot reach two separate knobs this close together, and
  // the pair is sent back-to-back by definition.
  const MIDI_14_WINDOW_MS = 60;
  const MIDI_14_LSB = 32;
  // "device|channel|coarse num" -> { raw, at }: the coarse half, waiting for its fine half.
  const midi14 = new Map();
  // Targets already complained about for being bound to a fine half - said once, not per message.
  const midi14Warned = new Set();
  const midi14Key = (device, channel, num) => `${device}|${channel}|${num}`;
  const midi14IsCoarse = (kind, num) => kind === 'cc' && num < MIDI_14_LSB;
  const midi14IsFine = (kind, num) => kind === 'cc' && num >= MIDI_14_LSB && num < MIDI_14_LSB * 2;

  /**
   * The coarse half this fine message belongs to, or null to leave the message alone. Null is the
   * answer whenever the desk has nothing to gain: an unbound coarse address with no learn armed
   * means cc 32..63 is somebody's ordinary knob and stays one.
   */
  function midi14Partner(device, channel, num, now) {
    const coarse = num - MIDI_14_LSB;
    const seen = midi14.get(midi14Key(device, channel, coarse));
    if (!seen || now - seen.at > MIDI_14_WINDOW_MS) return null;
    const wanted = mixMidiLearn
      || Object.values(midiSettings.map).some((m) => midiSame(m, device, channel, coarse, 'cc'));
    return wanted ? { coarse, raw: seen.raw } : null;
  }

  // --- learning a multi-position SWITCH, in one gesture -----------------------------------------
  //
  // A switch is not three buttons, and learning it as three was a mistake worth writing down: its
  // positions are in a row, so you cannot reach the far one without passing THROUGH the middle one.
  // Arming a learn for "deck A" and then flipping to the deck-A position therefore binds whatever
  // the switch brushed past on the way, every time, and the only way out of it is to approach each
  // position from the right side - which is not something anybody should have to know.
  //
  // So the whole switch is learned at once: sweep it from one end to the other and poptart keeps
  // the positions in the ORDER THEY ARRIVED. A sweep is one continuous movement, so that order IS
  // the physical order of the positions, and passing through the middle is no longer a hazard - it
  // is the middle entry. The one thing the gesture has to be told is which end to start at, which
  // is what the console line says.
  // A hand that has stopped moving: the sweep is over once no new position has arrived for this
  // long, rather than the moment the count is reached - a switch flicked past the far position and
  // back would otherwise be learned from the overshoot.
  const MIX_SWITCH_SETTLE_MS = 700;
  const MIX_SWITCH_TIMEOUT_MS = 20000;
  // { targets, seen, finish, timer, settle } while a sweep is armed.
  let mixMidiSwitch = null;

  /** The state this message represents, or null for one that is not a position being ENTERED. */
  function mixSwitchState(channel, num, value, kind) {
    if (kind === 'note') {
      // Note-offs are the position being LEFT - the same position, said backwards. Counting them
      // would fill the sweep with duplicates of where the switch has just been.
      return value >= 0.004 ? { key: `note:${channel}:${num}`, kind: 'note', num } : null;
    }
    // A cc switch sends one number at a different value per position, so the VALUE is the state.
    const raw = Math.round(value * 127);
    return { key: `cc:${channel}:${num}:${raw}`, kind: 'cc', num, raw };
  }

  /** A message while a sweep is armed. Always consumed: a switch mid-learn must not drive a desk. */
  function mixMidiSwitchSaw(device, channel, num, value, kind) {
    const sw = mixMidiSwitch;
    const state = mixSwitchState(channel, num, value, kind);
    if (!state) return true;
    // Every position seen once, in the order the sweep reached them.
    if (!sw.seen.some((x) => x.key === state.key)) {
      sw.seen.push({ ...state, device, channel });
      say(`[midi] switch position ${sw.seen.length}: ${midiSay(channel, num, kind)}`
        + (state.kind === 'cc' ? ` = ${state.raw}` : ''));
    }
    // The sweep ends when the hand stops, not when the count is reached: a switch flicked past the
    // far position and back would otherwise be learned from the overshoot.
    clearTimeout(sw.settle);
    if (sw.seen.length >= sw.targets.length) {
      sw.settle = setTimeout(() => mixMidiSwitchFinish(), MIX_SWITCH_SETTLE_MS);
    }
    return true;
  }

  /** Write what the sweep saw, or say why it cannot be written. */
  function mixMidiSwitchFinish(reason = null) {
    const sw = mixMidiSwitch;
    if (!sw) return;
    mixMidiSwitch = null;
    clearTimeout(sw.timer);
    clearTimeout(sw.settle);
    const { targets, seen } = sw;
    if (reason || seen.length < targets.length) {
      sw.finish({
        learned: null,
        why: reason ?? `only ${seen.length} of ${targets.length} positions came through - `
          + 'sweep the switch the whole way from one end to the other',
      });
      return;
    }
    // One cc number at three values cannot be told apart by a binding, which records an address and
    // not a value. Said plainly rather than bound wrong - all three targets would fire at once.
    if (seen.every((x) => x.kind === 'cc' && x.num === seen[0].num)) {
      sw.finish({
        learned: null,
        why: `this switch sends one control (${midiSay(seen[0].channel, seen[0].num, 'cc')}) at a `
          + 'different value per position, which poptart cannot map yet - bind it as the cycling pad instead',
      });
      return;
    }
    // A stale binding on one of these addresses would win the dispatch (first match takes the
    // message), so the old mapping of these very positions goes - including the cycling `fxassign`
    // that was probably learned onto one of them.
    for (const [target, m] of Object.entries(midiSettings.map)) {
      if (targets.includes(target)) continue;
      if (!seen.some((x) => midiSame(m, x.device, x.channel, x.num, x.kind))) continue;
      delete midiSettings.map[target];
      say(`[midi] ${target} was on one of those positions - unbound`);
    }
    const learned = targets.map((target, i) => {
      const at = seen[i];
      const m = { device: at.device, channel: at.channel, kind: at.kind, num: at.num };
      midiSettings.map = { ...midiSettings.map, [target]: m };
      mixMidiDown.delete(target);
      return { target, ...m };
    });
    saveMidi();
    sw.finish({ learned, why: null });
  }

  // Which target names are BUTTONS - the set the learn rule below needs, and the same lists
  // the dispatch reads.
  const MIX_MIDI_BUTTONS = new Set([...MIX_MIDI_HOLD, ...MIX_MIDI_PRESS, ...MIX_MIDI_GLOBAL_PRESS,
    ...MIX_MIDI_GLOBAL_HOLD, ...Object.keys(MIX_MIDI_FX_POS)]);

  /**
   * Is this message the one the armed target is waiting for? A learn used to bind the very next
   * message of any sort, which is wrong on a real control surface: a platter emits a stream of
   * ccs around its center whenever it is brushed, so arming a learn on a PAD and reaching for it
   * bound the jog instead - five of one deck's buttons ended up on the same jog cc (2026-09-09).
   *
   * So the rule follows the target's own nature. A knob or the platter is a cc, never a note. A
   * button is a note-on, or a cc PRESSED - and pressed means near the top, which is what a button
   * sends and what a platter drifting around its 64 center never does.
   */
  function mixMidiLearnable(target, kind, value) {
    const name = MIX_MIDI_GLOBAL.has(target) ? target : target.slice(2);
    if (!MIX_MIDI_BUTTONS.has(name)) return kind === 'cc'; // knobs and the platter are continuous
    return value >= (kind === 'note' ? 0.004 : 0.9); // a note-on of any velocity; a cc at the top
  }

  // A CC's 0..1 into the target's own range: two-sided controls center at 0, gains at unity.
  function mixMidiValue(target, v01) {
    const ctl = target === 'xf' ? 'xf' : target.slice(2);
    if (ctl === 'xf' || ctl === 'djf') return v01 * 2 - 1;
    if (ctl === 'fader' || ctl === 'djres') return v01; // one-sided 0..1, neutral at the bottom
    return v01 * 2; // trim and the EQ bands: 0..2, unity at center
  }

  // A jog wheel is a RELATIVE control: it says how far it just turned, never where in the track
  // it is. The convention taken here is the one DJ platters use - centered at 64, so 65 is one
  // tick forward and 63 one tick back, and a fast spin sends a bigger excursion the same way.
  // (The alternative convention, 1..63 forward and 65..127 back, would read a fast spin as a
  // backward one; a wheel that speaks it wants its output mode switched, which every controller
  // that has the mode also has the switch for.)
  //
  // The tick size is a record's: ~600 ticks to a revolution is the usual platter resolution and a
  // revolution at 33 1/3 rpm is 1.8 seconds, which puts a tick at 3ms. Tempo-independent on
  // purpose - a platter under the hand is moving the RECORD, not the grid.
  //
  // SEARCH is the same wheel in its coarse mode, and it exists because 1:1 is the wrong ratio for
  // getting somewhere: at 3ms a tick, crossing a five-minute track is a hundred revolutions. The
  // hardware answer is a second mode on the same platter, reached by holding shift - and because a
  // controller sends a DIFFERENT cc while shift is held, poptart needs no modifier concept for it.
  // `search` is simply a second continuous target, learned exactly like `scrub`. At 0.1s a tick a
  // revolution covers about a minute, so a five-minute track is five turns.
  const SONG_SCRUB_TICK_SEC = 0.003;
  const SONG_SEARCH_TICK_SEC = 0.1;
  function mixMidiScrubDelta(v01, tickSec = SONG_SCRUB_TICK_SEC) {
    return (Math.round(v01 * 127) - 64) * tickSec;
  }

  /**
   * A browse encoder's tick count: how many entries it just asked to move, signed, with + meaning
   * further down the list. Relative, because a browse knob has no ends - the list has those.
   *
   * Hardware sends this in one of two incompatible conventions, and poptart reads both:
   *
   *   64-centered   65 is one tick on, 63 one back - the platter convention above.
   *   two's complement   1 is one tick on, 127 one back - the other convention relative encoders commonly ship with.
   *
   * Reading everything as 64-centered is what made one controller's browse knob scroll backwards in jumps of 24:
   * its "one tick right" of 1 came out as 1 - 64 = -63, which then saturated at the step clamp
   * (reported 2026-10-05 - "turning it right subtracts 24"). Which convention a message is in is
   * read off how far it sits from center, since a tick is a SMALL number in both: near 64 is
   * centered, near either end is two's complement. A spin fast enough to send ~32 ticks in one
   * message would be read the wrong way round, which a browse knob does not do - and the caller
   * clamps the step regardless.
   */
  function mixMidiBrowseTicks(v01) {
    const raw = Math.round(v01 * 127);
    if (raw >= 32 && raw <= 96) return raw - 64;
    return raw < 32 ? raw : raw - 128;
  }

  function handleMixMidi(device, channel, num, value, kind) {
    // While the desk's `midi` mode is on, say what the hardware is sending - throttled per
    // control, since a platter says it eighty times a second. This is the thing that turns "the
    // pad won't learn" into "the pad sends a note and we were only listening for ccs".
    if (mixMidiMonitor) {
      const id = `${kind} ${num} ${channel}`;
      const now = Date.now();
      if (now - (mixMidiSaid.get(id) ?? 0) > 500) {
        mixMidiSaid.set(id, now);
        // The raw 0..127 as well as the fraction: a platter reads as 65/63 either side of a 64
        // center, and "0.51" hides exactly the thing you opened the monitor to see.
        say(`[midi] ${device}: ${midiSay(channel, num, kind)}`
          + ` = ${Math.round(value * 127)}/127 (${value.toFixed(3)})`);
      }
    }
    // The high-resolution pair (see above), resolved before anything else looks at the message, so
    // neither the learn nor the dispatch can see a fine half as a control. The monitor above still
    // prints what actually arrived - that is the whole point of the monitor.
    const now = Date.now();
    if (midi14IsCoarse(kind, num)) midi14.set(midi14Key(device, channel, num), { raw: Math.round(value * 127), at: now });
    else if (midi14IsFine(kind, num)) {
      const pair = midi14Partner(device, channel, num, now);
      if (pair) {
        num = pair.coarse;
        value = (pair.raw * 128 + Math.round(value * 127)) / 16383;
      } else if (midi14.has(midi14Key(device, channel, num - MIDI_14_LSB))) {
        // A binding ON the fine half, of a control whose coarse half this surface also sends: a
        // mapping made before the pair was understood, and the reason that control appears to jump
        // all over its range. Nothing can be done about it from here - the two halves are not
        // interchangeable - so it is said once, naming the fix.
        const stuck = Object.entries(midiSettings.map)
          .find(([, m]) => midiSame(m, device, channel, num, 'cc'));
        if (stuck && !midi14Warned.has(stuck[0])) {
          midi14Warned.add(stuck[0]);
          say(`[midi] ${stuck[0]} is bound to ${midiSay(channel, num, 'cc')}, which is the FINE `
            + `half of cc ${num - MIDI_14_LSB} on this control - that is why it jumps. Re-learn it: arm midi, `
            + `alt+click ${stuck[0]}'s control to unbind, then click it and move the hardware again`);
        }
      }
    }
    // A switch being swept owns every message until it settles (see the sweep section above).
    if (mixMidiSwitch) return mixMidiSwitchSaw(device, channel, num, value, kind);
    if (mixMidiLearn) {
      const { target, finish, timer } = mixMidiLearn;
      // Not what this target is waiting for: consumed (a control being learned must not also play
      // a midicc() in the song) but the arm stands, so the hand can go on to the real control.
      if (!mixMidiLearnable(target, kind, value)) return true;
      const taken = Object.entries(midiSettings.map)
        .filter(([other, m]) => other !== target && midiSame(m, device, channel, num, kind))
        .map(([other]) => other);
      if (taken.length) {
        // Two targets on one control is never what was meant, and it fails SILENTLY at play time
        // (the first match in the map wins and the rest never fire). Say so and keep listening.
        //
        // EVERY target on the address, not just the first: unbinding one and finding the control
        // still refused, with the same sentence naming a different target, is a loop with no end
        // in sight. (Which is exactly what blocked one deck's tempo fader - its coarse half had
        // two stale bindings sitting on it from an earlier session.)
        //
        // And said once per control: a fader being swept sends this fifty times, and fifty copies
        // of the reason bury everything else in the console - including the reason.
        const id = `taken:${kind} ${num} ${channel} ${target}`;
        const now = Date.now();
        if (now - (mixMidiSaid.get(id) ?? 0) > 3000) {
          mixMidiSaid.set(id, now);
          say(`[midi] ${midiSay(channel, num, kind)} already drives `
            + `${taken.join(' and ')} - alt+click ${taken.length > 1 ? 'those controls' : 'that control'} `
            + `to unbind ${taken.length > 1 ? 'them' : 'it'}, or use another control for ${target}`);
        }
        return true;
      }
      const m = { device, channel, kind, num };
      if (mixMidiLearn.settle) {
        // Hold it and wait: a later message inside the window replaces it, so shift+pad binds the
        // pad and a lone press binds itself.
        mixMidiLearn.candidate = m;
        clearTimeout(mixMidiLearn.settleTimer);
        mixMidiLearn.settleTimer = setTimeout(() => {
          if (mixMidiLearn?.finish !== finish) return; // superseded by another arm
          mixMidiLearn = null;
          clearTimeout(timer);
          midiSettings.map = { ...midiSettings.map, [target]: m };
          saveMidi();
          finish(m);
        }, mixMidiLearn.settle);
        return true;
      }
      mixMidiLearn = null;
      clearTimeout(timer);
      midiSettings.map = { ...midiSettings.map, [target]: m };
      saveMidi();
      finish(m);
      return true;
    }
    for (const [target, m] of Object.entries(midiSettings.map)) {
      if (!midiSame(m, device, channel, num, kind)) continue;
      mixMidiDrive(target, value);
      return true;
    }
    return false;
  }

  // One mapped control's message, whatever kind of control it is. Nothing in here is allowed to
  // throw: a pad aimed at a deck with no song, or pressed while the engine is between restarts,
  // has to do nothing rather than take the MIDI listener down with it.
  function mixMidiDrive(target, value) {
    // A binding for a target this build no longer has - a control that was renamed or dropped
    // between sessions - is ignored rather than dispatched. Without this it fell through to the
    // deck-prefixed branch of mixMidiApply and was read as a CONTROL NAME with its first two
    // characters sliced off: a stale `browsesource` pad pushed a param called "owsesource" at deck
    // b on every press (found 2026-10-05 in a settings.json written by an earlier build). Said
    // once, because a mapping that silently does nothing is the thing worth being told about.
    if (!MIX_MIDI_TARGETS.has(target)) {
      if (!mixMidiLastErr.has(target)) {
        mixMidiLastErr.set(target, 'unknown target');
        say(`[midi] "${target}" is not a control this version has - that binding is `
          + 'being ignored. Re-learn it, or clear it from settings.json');
      }
      return;
    }
    try {
      mixMidiApply(target, value);
      mixMidiLastErr.delete(target); // it works again: the next failure is news
    } catch (err) {
      // Worth a line rather than a silent nothing - a pad that does nothing all night because its
      // deck is empty is a mapping you want told about. Once per reason, though: the same pad
      // pressed through a whole track must not fill the console with one sentence.
      const said = err?.message ?? String(err);
      if (mixMidiLastErr.get(target) !== said) {
        mixMidiLastErr.set(target, said);
        say(`[midi] ${target}: ${said}`);
      }
    }
  }

  function mixMidiApply(target, value) {
    if (target !== 'xf' && MIX_MIDI_GLOBAL.has(target)) {
      // The FX unit's deck-less controls. The pads share the deck pads' edge detection.
      if (target === 'fxknob') {
        mixFxSet({ knob: value });
        return;
      }
      if (target === 'hplevel' || target === 'hpmix') {
        headphonesSet(target === 'hplevel' ? { level: value } : { mix: value });
        return;
      }
      // The browse knobs - the songs, and the sidebar under shift. Forwarded as a signed tick
      // count (see mixMidiBrowseTicks); what a tick MOVES is the browser's business, not this
      // knob's, so nothing here knows how long any list is.
      if (MIX_MIDI_BROWSE_KNOBS.includes(target)) {
        const ticks = mixMidiBrowseTicks(value);
        if (ticks) mixActionNotify(null, target, ticks);
        return;
      }
      // A switch POSITION, which is a state and not a press: the message says where the switch is,
      // so it is applied whenever it arrives and never edge-detected. A surface that re-sends the
      // position it is already in (and one that sends no note-off when the switch leaves a
      // position) would otherwise have its flip back to that position swallowed as "no edge".
      if (Object.hasOwn(MIX_MIDI_FX_POS, target)) {
        if (value >= 0.5) mixFxSet({ assign: MIX_MIDI_FX_POS[target] });
        return;
      }
      const down = value >= 0.5;
      if ((mixMidiDown.get(target) ?? false) === down) return;
      mixMidiDown.set(target, down);
      if (target === 'fxhold') mixFxSet({ held: down });
      else if (!down) { /* press pads act on the press edge only */ }
      // The browser's pads: the page owns the window, the selection and the active deck.
      else if (MIX_MIDI_BROWSE_PRESS.includes(target)) mixActionNotify(null, target);
      else if (target === 'fxon') mixFxSet({ on: !mixState.fx.on });
      else if (target === 'fxassign') mixFxSet({ assign: FX_ASSIGNS[(FX_ASSIGNS.indexOf(mixState.fx.assign) + 1) % FX_ASSIGNS.length] });
      else {
        // Stepping the chain list loads code off disk, so it is the one fx pad that is async.
        // Its own reporting: a rejection here must not reach the MIDI listener unhandled.
        mixFxStep(target === 'fxnext' ? 1 : -1)
          .catch((err) => say(`[midi] ${target}: ${err?.message ?? err}`));
      }
      return;
    }
    const deck = target[0];
    const name = target === 'xf' ? 'xf' : target.slice(2);
    if (name === 'scrub' || name === 'search') {
      // Both are the platter; they differ only in how far a tick carries. songScrub coalesces
      // either into one seek per flush, so a hand crossing modes mid-spin still moves once.
      songScrub(deck, mixMidiScrubDelta(value, name === 'search' ? SONG_SEARCH_TICK_SEC : SONG_SCRUB_TICK_SEC));
      return;
    }
    if (name === 'bend') {
      // The platter's pitch-bend mode: the same relative 64-centered convention as scrub, into
      // the bend gesture instead of a seek (see songBend).
      songBend(deck, Math.round(value * 127) - 64);
      return;
    }
    if (name === 'tempo') {
      // The deck's pitch fader, mounted the player way: PLUS is at the bottom of the throw, on
      // hardware and on the screen alike. The two disagree about which end counts up, though - a
      // pitch fader sends its HIGHEST value at that plus end, while the on-screen fader's own 0..1
      // counts upward from the bottom (see tempoFracOf, which is this with the sign the other
      // way). So a rising cc is a rising tempo, and reading it the other way put every hardware
      // fader in upside down.
      deckTempoApply(deck, { frac: (value - 0.5) * 2 });
      return;
    }
    const hold = MIX_MIDI_HOLD.includes(name);
    if (hold || MIX_MIDI_PRESS.includes(name)) {
      const down = value >= 0.5;
      if ((mixMidiDown.get(target) ?? false) === down) return; // no edge: a pad restating itself
      mixMidiDown.set(target, down);
      if (hold || down) mixMidiButton(deck, name, down);
      return;
    }
    applyMixTargets([target === 'xf'
      ? { name: 'xf', value: mixMidiValue(target, value) }
      : { deck, name, value: mixMidiValue(target, value) }]);
  }

  // The press (and, for a hold button, the release) of one learned pad. Every case here is a
  // gesture some on-screen control also calls - none of this is a second implementation.
  function mixMidiButton(deck, name, down) {
    const s = songDecks[deck];
    switch (name) {
      case 'nudgedn': songNudge(deck, { hold: down ? -1 : 0 }); return;
      case 'nudgeup': songNudge(deck, { hold: down ? 1 : 0 }); return;
      case 'jogdn': songNudge(deck, { jog: -1 }); return;
      case 'jogup': songNudge(deck, { jog: 1 }); return;
      case 'jogsize': deckJogApply(deck, { step: 1 }); return;
      case 'cue':
        // A deck holding a FILE previews from its cue point right here. A deck holding CODE has no
        // cue POINT - a pattern is not a recording with a place in it - but the gesture still means
        // the same thing: hold to hear this deck, release and it is quiet again. Starting it means
        // evaluating a buffer only the editor has, so like `play` the press goes to the browser.
        if (s) songCue(deck, down);
        else mixActionNotify(deck, down ? 'cue' : 'cueoff');
        return;
      case 'play':
        // A deck holding a FILE has its transport right here. A deck holding CODE is played by
        // evaluating a buffer that only the editor has, so that press goes to the browser.
        if (s) songTogglePlay(deck);
        else mixActionNotify(deck, 'play');
        return;
      case 'phones': {
        // The headphone audition: a deck-wide `cue` broadcast, exactly what the on-screen
        // headphone button posts (and named `phones` here so it can't be read as the cue POINT).
        const on = (mixState.perDeck[deck].get('cue') ?? 0) > 0;
        applyMixTargets([{ deck, name: 'cue', value: on ? 0 : 1 }]);
        return;
      }
      case 'sync':
        if (s) songSetMeta(deck, { sync: !s.sync });
        else liveSetSync(deck, !deckLive[deck].sync);
        return;
      case 'keylock': songSetMeta(deck, { keylock: !s?.keylock }); return;
      case 'quant': songSetMeta(deck, { quantize: s?.quantize === false }); return;
      case 'regions': evaluator?.setLoops?.(deck, !evaluator.loopsOf(deck)); return;
      // The performance loop: the pad arms one here or ends the one running, and the two
      // length pads resize it under the hand (see deckLoopApply).
      case 'loop': deckLoopApply(deck, { on: !deckLoopLive(deck) }); return;
      case 'loophalve': deckLoopApply(deck, { scale: 0.5 }); return;
      case 'loopdouble': deckLoopApply(deck, { scale: 2 }); return;
      case 'temporange': {
        const cur = mixState.deckTempo[deck].range;
        deckTempoApply(deck, { range: DECK_TEMPO_RANGES[(DECK_TEMPO_RANGES.indexOf(cur) + 1) % DECK_TEMPO_RANGES.length] });
        return;
      }
      case 'mult':
        // The deck that set the clock has no ratio to choose - its tempo IS the clock, and the
        // on-screen button is disabled for it. The pad matches.
        if (deck !== songMasterDeck) songSetMeta(deck, { syncMult: songMultNext(deck) });
        return;
      default:
    }
  }

  // The press edges the server can't act on itself (see the note at the top of this section),
  // pushed to the editor on the desk channel as a named frame. Not coalesced the way mixNotify
  // is: these are discrete presses, and dropping one loses a song change.
  /**
   * One press edge (or one knob tick) the server cannot act on itself, handed to the page. `deck`
   * is null for the controls that belong to no deck - the library browser's, which act on the
   * window and on whichever deck is active there. `value` rides along for the continuous ones.
   */
  function mixActionNotify(deck, action, value = null) {
    for (const l of listeners) l('action', { deck, action, value });
  }


  // --- TALK-BACK: what the desk writes to a control surface --------------------------------------
  //
  // A controller that shows you anything - a lit pad, a level meter - is shown it by the host. It
  // has no idea what the software is doing otherwise, so every lamp on it is a message somebody
  // sent. This is that end of the desk: the levels it already measures, and the state its own
  // buttons are bound to, written back out to the hardware.
  //
  // Two halves, and only one of them needs to know anything about the device:
  //
  //   - LAMPS need nothing. The convention these surfaces use is that a button lights when you
  //     send back the message it SENDS, so a learned binding is already the address to answer on
  //     (it records device, channel, kind and number - see handleMixMidi). Velocity 127 lights it,
  //     0 puts it out. That works on a surface nobody has ever written a profile for.
  //   - METERS do, because a meter is not a control: you cannot press it, so there is nothing to
  //     learn from, and its address has to come from somewhere. MIX_METER_PROFILES is that
  //     somewhere, matched against the name the device reports.
  //
  // OFF until a port is chosen, deliberately. The desk's controls can be learned from anything with
  // a MIDI socket, and echoing note-ons at a device that is actually a KEYBOARD would play it.
  const MIX_METER_PROFILES = [
    // Two-deck surfaces that meter each deck pre-fader, which is the same point poptart's own deck
    // meters tap (see deckMeters) - so the hardware and the screen show the same thing.
    { match: /ddj-flx4|ddj-flx\s*4/i, meters: { a: { channel: 0, num: 2 }, b: { channel: 1, num: 2 } } },
  ];

  /** The meter addresses for the chosen port, or null for a device nothing is known about. */
  function mixMeterProfile() {
    const port = midiSettings.feedback;
    if (!port) return null;
    return MIX_METER_PROFILES.find((p) => p.match.test(port))?.meters ?? null;
  }

  // The same dB window the on-screen meters draw (see MIX_METER_DB there), mapped onto a 0..127
  // control value: a hardware meter and the strip's meter read alike, which they have to, because
  // you gain-stage by whichever one you happen to be looking at.
  const MIX_FEEDBACK_DB_MIN = -42;

  function mixMeterValue(level) {
    const db = 20 * Math.log10(Math.max(Number(level) || 0, 1e-5));
    if (db <= MIX_FEEDBACK_DB_MIN) return 0;
    return Math.min(127, Math.round(((db - MIX_FEEDBACK_DB_MIN) / -MIX_FEEDBACK_DB_MIN) * 127));
  }

  /** Write both decks' levels to the surface's meters - called on each reading from the engine. */
  function mixFeedbackLevels(deckLevels) {
    // No gate on the desk being open: these readings only exist while the deck meters are
    // running, which is itself the strip being up (see subscribe).
    const meters = mixMeterProfile();
    if (!meters) return;
    const out = [];
    for (const deck of ['a', 'b']) {
      const at = meters[deck];
      const level = deckLevels[deck]?.p;
      if (!at || level == null) continue;
      out.push(['cc', at.channel, at.num, mixMeterValue(level)]);
    }
    midi?.feedback?.(out);
  }

  /**
   * Whether a learned control is lit right now - true, false, or null for one with nothing to
   * show (a jog step has no state; a knob is not a lamp). Everything here is read from the desk's
   * own truth, so a lamp cannot disagree with the screen.
   */
  function mixFeedbackLit(target) {
    const [deck, name] = target.includes(':') ? target.split(':') : [null, target];
    const s = deck ? songDecks[deck] : null;
    switch (name) {
      case 'play': return deckPlaying(deck);
      case 'cue': return !!s?.cueHeld;
      case 'phones': return (mixState.perDeck[deck]?.get('cue') ?? 0) > 0;
      case 'sync': return s ? !!s.sync : deckLive[deck].sync; // a deck playing code has one too
      case 'keylock': return !!s?.keylock;
      case 'quant': return s ? s.quantize !== false : null;
      case 'regions': return !!evaluator?.loopsOf?.(deck);
      case 'loop': return !!deckLoopLive(deck);
      case 'fxon': return !!mixState.fx.on;
      case 'fxhold': return !!mixState.fx.held;
      default: return null; // jogs, steps, the length pads: momentary, with no state to report
    }
  }

  // What each lamp was last told, so a frame only sends what CHANGED. The desk frames ~30 times a
  // second and most of it is a fader moving; re-lighting every pad each time would be a hundred
  // messages a second at a surface that asked for none of them.
  const mixLampSent = new Map();

  /** Light every learned button to match the desk. */
  function mixFeedbackLamps({ force = false } = {}) {
    if (!midiSettings.feedback) return;
    const out = [];
    for (const [target, m] of Object.entries(midiSettings.map)) {
      // Only a pad can be a lamp. A knob or fader binding is left alone: sending a value back at
      // one says nothing (there is no motor in it) and some surfaces answer their own echo.
      if (m.kind !== 'note') continue;
      // The desk's state is the desk's state whether or not a browser is watching it - a
      // learned pad still works with the page closed, and its lamp still has to follow.
      const lit = mixFeedbackLit(target);
      if (lit == null) continue;
      if (!force && mixLampSent.get(target) === lit) continue;
      mixLampSent.set(target, lit);
      // A learned binding counts channels 1-16, as the page shows them; the port counts 0-15.
      out.push(['note', (m.channel ?? 1) - 1, m.num, lit ? 127 : 0]);
    }
    if (out.length) {
      midi?.feedback?.(out);
    }
  }

  /** Put every lamp out and both meters to zero - leaving the desk, or changing port. */
  function mixFeedbackBlank() {
    if (!midiSettings.feedback) return;
    const out = [];
    for (const [target, m] of Object.entries(midiSettings.map)) {
      if (m.kind !== 'note' || mixFeedbackLit(target) == null) continue;
      out.push(['note', (m.channel ?? 1) - 1, m.num, 0]);
    }
    const meters = mixMeterProfile();
    for (const deck of ['a', 'b']) {
      if (meters?.[deck]) out.push(['cc', meters[deck].channel, meters[deck].num, 0]);
    }
    mixLampSent.clear();
    midi?.feedback?.(out);
  }


  // ---------------------------------------------------------------------------------------------
  // The headphone section
  // ---------------------------------------------------------------------------------------------

  let headphonesSaveTimer = null;
  function headphonesSet({ level, mix } = {}) {
    const clamp = (v) => Math.min(1, Math.max(0, Number(v)));
    if (level !== undefined && Number.isFinite(Number(level))) headphones.level = clamp(level);
    if (mix !== undefined && Number.isFinite(Number(mix))) headphones.mix = clamp(mix);
    engine.setHeadphones?.(headphones.level, headphones.mix);
    clearTimeout(headphonesSaveTimer);
    headphonesSaveTimer = setTimeout(() => {
      store?.put?.(HEADPHONES_KEY, { ...headphones }).catch?.(() => {});
    }, 500);
    mixNotify();
    return headphonesState();
  }

  const cueRouted = () => !!engine.cueRoute?.();
  const headphonesState = () => ({ ...headphones, cuePair: cueRouted() });

  // ---------------------------------------------------------------------------------------------
  // The desk as one plain object: what GET /api/mix returns and what the push channel frames.
  // Times leave on the wall clock, as the editor mirrors them (see the evaluator's
  // transportForEditor) - every time in here is on the audio context's.
  // ---------------------------------------------------------------------------------------------

  const wallOffset = () => Date.now() / 1000 - now();

  function deckPlaying(deck) {
    return [...schedulers()].some(([key, sch]) => deckOfKey(key) === deck && sch.running) || !!songDecks[deck]?.playing;
  }

  function mixDeskTracks() {
    const row = (key) => ({
      key,
      deck: deckOfKey(key),
      parent: groupMembers.get(key) ?? null,
      controls: Object.fromEntries(mixState.perTrack.get(key) ?? []),
    });
    return mixAllKeys().map(row);
  }

  function mixDeskBody() {
    for (const d of DECKS) if (songDecks[d] && !songDecks[d].playing) songApplyRate(d);
    const offset = wallOffset();
    const clocks = evaluator?.deckClocksForEditor?.() ?? { a: null, b: null };
    return {
      dj: mixState.dj,
      swap: mixState.swap,
      solo: { a: [...mixState.solo.a].filter(isMixKey), b: [...mixState.solo.b].filter(isMixKey) },
      playing: { a: deckPlaying('a'), b: deckPlaying('b') },
      perDeck: { a: Object.fromEntries(mixState.perDeck.a), b: Object.fromEntries(mixState.perDeck.b) },
      deckBpm: { a: deckNativeBpm('a'), b: deckNativeBpm('b') },
      tempo: { master: transport.cps * 240, override: mixState.tempoOverride },
      deckTempo: Object.fromEntries(DECKS.map((d) => [d, {
        ...mixState.deckTempo[d],
        pct: Math.round((deckTempoMult(d) - 1) * 1000) / 10,
        locked: deckTempoLocked(d),
        bpm: deckTempoBpm(d),
      }])),
      loops: { a: evaluator?.loopsOf?.('a') ?? true, b: evaluator?.loopsOf?.('b') ?? true },
      deckLoop: { a: deckLoopState('a'), b: deckLoopState('b') },
      deckJog: { a: mixState.deckJog.a.beats, b: mixState.deckJog.b.beats },
      playedN: songPlayedSession.size + codePlayedSession.size,
      fx: { ...mixState.fx, chains: djFxChainNames() },
      link: null,
      transport: evaluator?.transportForEditor?.() ?? null,
      deckTransport: clocks,
      live: Object.fromEntries(DECKS.map((d) => [d, { sync: deckLive[d].sync, nudge: deckLive[d].nudge }])),
      xf: mixState.xf,
      faders: { ...mixState.faders },
      headphones: headphonesState(),
      cue: cueRouted() ? { name: engine.cueRouteName ?? 'headphones' } : null,
      midi: {},
      neutral: DJ_NEUTRAL,
      song: Object.fromEntries(DECKS.map((d) => {
        const s = songDecks[d];
        // The editor mirrors the playhead as one line from (posSec, startSec) at `rate`. A rate
        // change is modeled from the moment it is HEARD, a latency on - so while one is on its way
        // the line is drawn from now instead, or the pane would hold still for that latency.
        const t = now();
        const rebasing = !!s?.playing && t < s.startSec && (s.rateBefore ?? 0) > 0;
        return [d, s && {
          key: SONG_KEYS[d],
          path: s.path,
          title: s.title,
          duration: s.duration,
          decoded: s.decoded,
          playing: s.playing,
          rate: s.rate,
          baseRate: songBaseRate(d),
          posSec: rebasing ? songPlayheadSec(d, t) : s.posSec,
          startSec: (rebasing ? t : s.startSec) + offset,
          bpm: s.bpm,
          musicalKey: s.musicalKey,
          anchorSec: s.anchorSec,
          cueSec: s.cueSec ?? 0,
          cueHeld: !!s.cueHeld,
          sync: s.sync,
          syncMult: s.syncMult ?? 'auto',
          syncMultEffective: songOctave(d),
          master: d === songMasterDeck,
          keylock: !!s.keylock,
          quantize: s.quantize !== false,
          nudge: s.nudge,
          loop: s.loop ? { ...s.loop } : null,
          bpmDetected: s.bpmDetected ?? null,
          keyDetected: s.keyDetected ?? null,
          gridDetected: s.gridDetected ?? null,
        }];
      })),
    };
  }

  // --- the desk push channel: the desktop's SSE stream, as a listener set (see subscribe) ---
  let mixNotifyTimer = null;
  let mixLampTimer = null;
  function mixNotify() {
    // The surface is told first, and on its own schedule: a learned pad moves the desk whether or
    // not the desk is on screen, and its lamp has to follow.
    if (midiSettings.feedback && !mixLampTimer) {
      mixLampTimer = setTimeout(() => {
        mixLampTimer = null;
        mixFeedbackLamps();
      }, NOTIFY_MS);
    }
    if (!listeners.size || mixNotifyTimer) return;
    mixNotifyTimer = setTimeout(() => {
      mixNotifyTimer = null;
      if (!listeners.size) return;
      const frame = mixDeskBody();
      for (const l of listeners) l('message', frame);
    }, NOTIFY_MS);
  }

  let levelTimer = null;
  function levelsStart() {
    if (levelTimer) return;
    engine.deckMeters?.(true);
    levelTimer = setInterval(() => {
      const levels = engine.deckLevels?.();
      if (!levels) return;
      mixFeedbackLevels(levels);
      if (!listeners.size) return;
      for (const l of listeners) l('level', levels);
    }, LEVEL_MS);
  }
  function levelsStop() {
    clearInterval(levelTimer);
    levelTimer = null;
    engine.deckMeters?.(false);
  }

  /**
   * The desk's push channel. `listener(kind, data)` hears 'message' (a desk frame), 'level' (the
   * meters) and 'action' (a press the editor has to act on itself). The first frame is sent at
   * once, and the meters run only while somebody listens - the desktop's /api/mix/events.
   */
  function subscribe(listener) {
    listeners.add(listener);
    if (listeners.size === 1) levelsStart();
    queueMicrotask(() => { if (listeners.has(listener)) listener('message', mixDeskBody()); });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) levelsStop();
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The routes
  // ---------------------------------------------------------------------------------------------

  const needSong = (deck) => {
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    return s;
  };

  const routes = {
    'GET /api/mix': async (_body, query) => ({ ...mixDeskBody(), tracks: query?.get?.('desk') ? undefined : mixDeskTracks() }),
    'POST /api/mix/dj': async (body) => setDj(!!body?.on),
    'POST /api/mix/set': async (body) => {
      applyMixTargets(Array.isArray(body?.targets) ? body.targets : [body ?? {}]);
      return { ok: true };
    },
    'POST /api/mix/swap': async (body) => {
      mixState.swap = !!body?.on;
      applyMixTargets([{ name: 'xf', value: mixState.xf }]);
      return { swap: mixState.swap };
    },
    'POST /api/mix/gate': async (body) => {
      const key = String(body?.key ?? '');
      if (!isMixKey(key)) throw new Error(`mix/gate: no playing track "${key}"`);
      const on = !!body.on;
      mixGateSet(key, on);
      let countered = null;
      if (mixState.swap) {
        const base = deckOfKey(key) === 'a' ? key : key.slice(key.indexOf(':') + 1);
        const twin = deckOfKey(key) === 'a' ? `b:${base}` : base;
        if (schedulers().has(twin)) {
          mixGateSet(twin, !on);
          countered = twin;
        }
      }
      mixNotify();
      return { key, on, countered };
    },
    'POST /api/mix/solo': async (body) => {
      const key = String(body?.key ?? '');
      if (!isMixKey(key)) throw new Error(`mix/solo: no playing track "${key}"`);
      const deck = deckOfKey(key);
      const solo = mixState.solo[deck];
      if (solo.has(key)) {
        solo.delete(key);
        if (solo.size === 0) mixSoloEnd(deck);
        else for (const [k, v] of mixSoloFaders(deck)) mixSetFader(k, v);
      } else {
        if (!mixState.soloPrev[deck]) {
          const prev = new Map();
          for (const k of mixDeskKeys(deck)) prev.set(k, mixState.perTrack.get(k)?.get('fader') ?? 1);
          mixState.soloPrev[deck] = prev;
        }
        if (!body.add) solo.clear();
        solo.add(key);
        for (const [k, v] of mixSoloFaders(deck)) mixSetFader(k, v);
      }
      mixNotify();
      return { key, deck, solo: [...solo] };
    },
    'POST /api/mix/gateall': async (body) => {
      const deck = deckArg(body?.deck);
      const gated = mixGateAll(deck);
      mixNotify();
      return { deck, gated };
    },
    'POST /api/mix/clear': async (body) => {
      const deck = deckArg(body?.deck);
      songUnload(deck);
      if (evaluator?.trackIds?.has(SONG_KEYS[deck])) evaluator.dropTrack(SONG_KEYS[deck]);
      evaluator?.clearDeck?.(deck);
      mixState.solo[deck].clear();
      mixState.soloPrev[deck] = null;
      deckBuffers[deck] = { name: null, title: null };
      mixNotify();
      return {};
    },
    'POST /api/mix/eject': async () => {
      fxTeardown();
      songUnload('b');
      if (evaluator?.trackIds?.has(SONG_KEYS.b)) evaluator.dropTrack(SONG_KEYS.b);
      evaluator?.clearDeck?.('b');
      mixState.perDeck.a.clear();
      mixState.perDeck.b.clear();
      mixState.perTrack.clear();
      mixState.xf = 0;
      mixState.faders = { a: 1, b: 1 };
      if (mixState.tempoOverride != null) {
        mixState.tempoOverride = null;
        const declared = evaluator?.facts?.('a')?.bpm;
        if (declared != null && typeof declared !== 'number') transport.setBpm(declared);
        else if (deckNativeBpm('a') != null) transport.rampBpm(deckNativeBpm('a'), 2);
      }
      for (const key of mixAllKeys()) neutralizeMix(key);
      mixState.deckTempo = { a: { frac: 0, range: 6 }, b: { frac: 0, range: 6 } };
      for (const d of DECKS) deckLiveRelease(d);
      evaluator?.setLoops?.('a', true, { pinned: false });
      evaluator?.setLoops?.('b', true, { pinned: false });
      deckBuffers.b = { name: null, title: null };
      mixNotify();
      return {};
    },
    'POST /api/mix/complete': async () => {
      const promotedKeys = [...schedulers().keys()].filter((k) => deckOfKey(k) === 'b');
      if (!promotedKeys.length) throw new Error('deck b has nothing playing - nothing to promote');
      fxTeardown();
      songUnload('a');
      if (evaluator.trackIds.has(SONG_KEYS.a)) evaluator.dropTrack(SONG_KEYS.a);
      if (songDecks.b) {
        evaluator.rekey(SONG_KEYS.b, SONG_KEYS.a);
        songDecks.a = songDecks.b;
        songDecks.b = null;
      }
      const promoted = evaluator.promote();
      const unprefixed = (k) => k.slice(k.indexOf(':') + 1);
      for (const key of [...groupMembers.keys()]) if (deckOfKey(key) === 'a') groupMembers.delete(key);
      for (const [key, parent] of [...groupMembers]) {
        groupMembers.delete(key);
        groupMembers.set(unprefixed(key), unprefixed(parent));
      }
      // The promoted tracks' schedulers keep the clock they were built on, so that clock is the
      // main deck's now, with what the hand had asked of it - and nothing they play moves.
      [deckClocks.a, deckClocks.b] = [deckClocks.b, deckClocks.a];
      [deckLive.a, deckLive.b] = [deckLive.b, deckLive.a];
      [djDeclaredBpm.a, djDeclaredBpm.b] = [djDeclaredBpm.b, undefined];
      deckBuffers.a = deckBuffers.b;
      deckBuffers.b = { name: null, title: null };
      mixState.perDeck.a.clear();
      mixState.perDeck.b.clear();
      mixState.perTrack.clear();
      mixState.xf = 0;
      mixState.faders = { a: 1, b: 1 };
      mixState.tempoOverride = null;
      mixState.deckTempo = { a: { frac: 0, range: 6 }, b: { frac: 0, range: 6 } };
      for (const d of DECKS) deckLiveRelease(d);
      evaluator.setLoops('a', true, { pinned: false });
      evaluator.setLoops('b', true, { pinned: false });
      for (const key of mixAllKeys()) neutralizeMix(key);
      mixNotify();
      return { promoted };
    },
    'POST /api/mix/decktempo': async (body) => deckTempoApply(deckArg(body?.deck), body ?? {}),
    'POST /api/mix/loop': async (body) => {
      const deck = deckArg(body?.deck);
      return { deck, ...deckLoopApply(deck, body ?? {}) };
    },
    'POST /api/mix/jogsize': async (body) => {
      const deck = deckArg(body?.deck);
      return { deck, ...deckJogApply(deck, body ?? {}) };
    },
    'POST /api/mix/livesync': async (body) => liveSetSync(deckArg(body?.deck), body?.sync),
    'POST /api/mix/headphones': async (body) => headphonesSet(body ?? {}),
    'GET /api/mix/headphones': async () => headphonesState(),
    // Learn a multi-position SWITCH in one gesture. Body: { targets } - the controls its positions
    // map to, IN ORDER. Waits while the switch is swept from one end to the other.
    'POST /api/mix/midiswitch': async (body) => {
      const targets = Array.isArray(body?.targets) ? body.targets.map(String) : [];
      if (targets.length < 2) throw new Error('midiswitch needs the targets its positions map to, in order');
      for (const t of targets) {
        if (!MIX_MIDI_TARGETS.has(t)) throw new Error(`"${t}" is not a learnable mix control`);
      }
      await needMidi().enable();
      mixMidiSwitchFinish('superseded by another learn');
      if (mixMidiLearn) {
        clearTimeout(mixMidiLearn.timer);
        clearTimeout(mixMidiLearn.settleTimer);
        mixMidiLearn.finish(null);
        mixMidiLearn = null;
      }
      return new Promise((resolve) => {
        mixMidiSwitch = {
          targets,
          seen: [],
          finish: resolve,
          settle: null,
          timer: setTimeout(() => mixMidiSwitchFinish('nothing came through - is the switch sending on this port?'), MIX_SWITCH_TIMEOUT_MS),
        };
      });
    },
    // MIDI-learn for a desk control. Body: { target } arms a learn and waits for the next message
    // that suits it -> { learned }, or { learned: null } after ten seconds. { target, clear } unbinds
    // it; { monitor } alone turns the desk's `midi` mode on or off and answers what is bound.
    'POST /api/mix/midilearn': async (body) => {
      if (body?.target == null && 'monitor' in (body ?? {})) {
        mixMidiMonitor = !!body.monitor;
        mixMidiSaid.clear();
        if (mixMidiMonitor) await needMidi().enable();
        return {
          monitor: mixMidiMonitor,
          feedback: midiSettings.feedback ?? null,
          bound: Object.entries(midiSettings.map).map(([target, m]) => ({
            target, device: m.device, channel: m.channel, kind: midiKind(m), num: midiNum(m),
          })),
        };
      }
      const target = String(body?.target ?? '');
      if (!MIX_MIDI_TARGETS.has(target)) throw new Error(`"${target}" is not a learnable mix control`);
      mixMidiDown.delete(target);
      if (body.clear) {
        if (midiSettings.map[target]) {
          delete midiSettings.map[target];
          saveMidi();
        }
        return { cleared: true };
      }
      await needMidi().enable();
      if (mixMidiLearn) {
        clearTimeout(mixMidiLearn.timer);
        clearTimeout(mixMidiLearn.settleTimer);
        mixMidiLearn.finish(null);
      }
      const settle = body.settle ? MIX_LEARN_SETTLE_MS : 0;
      const learned = await new Promise((resolve) => {
        mixMidiLearn = {
          target,
          settle,
          finish: resolve,
          timer: setTimeout(() => {
            if (mixMidiLearn?.finish === resolve) {
              clearTimeout(mixMidiLearn.settleTimer);
              mixMidiLearn = null;
            }
            resolve(null);
          }, 10000),
        };
      });
      return { learned };
    },
    // The talk-back port: the destinations this browser can write to, and the one chosen.
    'GET /api/mix/feedback': async () => ({
      destinations: midi?.enabled ? await midi.outputs().catch(() => []) : [],
      selected: midiSettings.feedback ?? null,
      active: mixFeedbackActive,
      meters: !!mixMeterProfile(),
    }),
    // Body: { device } - a destination's name (a fragment of it), or null for off. The surface
    // being left is blanked first, so a port change does not leave a pad lit on the old one.
    'POST /api/mix/feedback': async (body) => {
      const device = body?.device ? String(body.device).trim() : null;
      mixFeedbackBlank();
      let active = null;
      if (device) ({ active } = await needMidi().setFeedback(device));
      else midi?.setFeedback?.(null);
      midiSettings.feedback = device;
      mixFeedbackActive = active ?? null;
      saveMidi();
      mixLampSent.clear();
      if (mixFeedbackActive) mixFeedbackLamps({ force: true });
      return { selected: device, active: mixFeedbackActive, meters: !!mixMeterProfile() };
    },
    'POST /api/mix/fx': async (body) => {
      if (body?.chain !== undefined && body.chain !== mixState.fx.chain) fxLoadChain(body.chain);
      const out = mixFxSet(body ?? {});
      let editor;
      if (body?.editor) {
        // The window opens on deck A's return unless the unit is assigned to B alone. What is set
        // there is pinned into the chain's own code when the window closes (see fxPinState), and
        // the chain rebuilt onto both decks - so the two never drift apart.
        if (!mixState.fx.chain) throw new Error('mix/fx: no chain on the unit to edit');
        const deck = mixState.fx.assign === 'b' ? 'b' : 'a';
        const slots = fxSchedulers[deck]?.pattern?.fxChain?.length ?? 0;
        const slot = body.editor === true ? 1 : Number(body.editor);
        if (!Number.isInteger(slot) || slot < 1 || slot > slots) {
          throw new Error(`mix/fx: this chain has ${slots} effect${slots === 1 ? '' : 's'} - there is no slot ${slot}`);
        }
        // A device here has no window of its own: the editor draws the panel, from this.
        editor = { trackId: FX_KEYS[deck], slot };
      }
      return { ...out, chains: djFxChainNames(), ...(editor ? { editor } : {}) };
    },
    // The chains themselves: { save: name, code, knobWet? } | { rename, to } | { remove }. A save
    // builds the chain first and refuses one that does not, so a broken chain is a message in the
    // editor rather than a unit that dies when its pad is pressed mid-set.
    'POST /api/mix/fxchain': async (body) => {
      if (body?.save != null) {
        const name = String(body.save).trim();
        if (!name) throw new Error('fxchain: the chain needs a name');
        const code = String(body.code ?? '').trim();
        if (!code) throw new Error('fxchain: the chain needs some code - start it with .fx("…")');
        if (!code.startsWith('.')) throw new Error('fxchain: the code continues `song`, so it starts with a dot - e.g. .fx("Filter")');
        const knobWet = body.knobWet !== false;
        fxBuildSig('a', knobWet ? `${code}.wet(fx1)` : code);
        djFx.chains[name] = { code, knobWet };
        await saveDjFx();
        if (mixState.fx.chain === name) fxLoadChain(name);
        else mixNotify();
        return { saved: name, chains: djFxChainNames() };
      }
      if (body?.rename != null) {
        const from = String(body.rename);
        const to = String(body.to ?? '').trim();
        if (!djFx.chains[from]) throw new Error(`fxchain: no chain called ${JSON.stringify(from)}`);
        if (!to) throw new Error('fxchain: the new name cannot be empty');
        if (to !== from && djFx.chains[to]) throw new Error(`fxchain: there is already a chain called ${JSON.stringify(to)}`);
        if (to !== from) {
          djFx.chains = Object.fromEntries(Object.entries(djFx.chains).map(([k, v]) => [k === from ? to : k, v]));
          if (mixState.fx.chain === from) mixState.fx.chain = to;
          await saveDjFx();
        }
        mixNotify();
        return { renamed: to, chains: djFxChainNames() };
      }
      if (body?.remove != null) {
        const name = String(body.remove);
        if (!djFx.chains[name]) throw new Error(`fxchain: no chain called ${JSON.stringify(name)}`);
        delete djFx.chains[name];
        await saveDjFx();
        if (mixState.fx.chain === name) fxLoadChain(null);
        else mixNotify();
        return { removed: name, chains: djFxChainNames() };
      }
      throw new Error('fxchain: nothing to do - pass save, rename or remove');
    },
    'GET /api/mix/fxchain': async (_body, query) => {
      const name = query?.get?.('name') ?? mixState.fx.chain;
      const chain = name == null ? null : djFx.chains[name];
      return {
        name: chain ? name : null,
        code: chain ? String(chain.code ?? '') : '',
        knobWet: chain ? chain.knobWet !== false : true,
        chains: djFxChainNames(),
        knobs: Array.from({ length: patternCore.FX_KNOB_COUNT }, (_, i) => `fx${i + 1}`),
        head: 'song',
      };
    },

    'GET /api/djRegions': async () => ({ mode: djRegionsMode }),
    'POST /api/djRegions': async (body) => {
      const mode = body?.mode === 'on' ? 'on' : 'off';
      djRegionsMode = mode;
      await store?.put?.(DJ_REGIONS_KEY, { mode }).catch?.(() => {});
      return { mode };
    },

    'POST /api/arrangeLoops': async (body) => {
      const deck = deckArg(body?.deck);
      const on = evaluator.setLoops(deck, !!body?.on, { pinned: body?.pin !== false });
      return { deck, on, arrange: arrangeClockOf(deck)?.snapshot() ?? null };
    },

    // --- song decks ---
    'POST /api/song/load': async (body) => songLoad(body ?? {}),
    'POST /api/song/play': async (body) => songPlayDeck(deckArg(body?.deck), body ?? {}),
    'POST /api/song/cue': async (body) => {
      const deck = deckArg(body?.deck);
      const s = songDecks[deck];
      const pos = Number(body?.pos);
      if (s && !s.playing && body?.hold && Number.isFinite(pos) && Math.abs(pos - s.posSec) > 0.001) {
        s.posSec = Math.min(Math.max(0, pos), s.duration);
      }
      return songCue(deck, !!body?.hold);
    },
    'POST /api/song/pause': async (body) => {
      const deck = deckArg(body?.deck);
      const s = needSong(deck);
      s.cueHeld = false;
      songPause(deck);
      mixNotify();
      return { deck, pos: s.posSec };
    },
    'POST /api/song/seek': async (body) => {
      const deck = deckArg(body?.deck);
      return { deck, pos: songSeekTo(deck, Number(body?.pos)) };
    },
    'POST /api/song/stop': async (body) => {
      const deck = deckArg(body?.deck);
      const s = needSong(deck);
      s.cueHeld = false;
      try { engine.songStop(trackIdOf(SONG_KEYS[deck]), now(), 0.005); } catch { /* torn down */ }
      songMarkPaused(deck, 0);
      if (body?.unload) songUnload(deck);
      mixNotify();
      return { deck, unloaded: !!body?.unload };
    },
    'POST /api/song/meta': async (body) => songSetMeta(deckArg(body?.deck), body ?? {}),
    'POST /api/song/reanalyze': async (body) => {
      const deck = deckArg(body?.deck);
      const s = needSong(deck);
      s.anchorByHand = false;
      s.gridDetected = null;
      library?.rememberAnchor?.(s.path, null).catch?.(() => {});
      songDetectKick(deck, { again: true });
      mixNotify();
      return { deck, reanalyzing: true };
    },
    'POST /api/song/nudge': async (body) => songNudge(deckArg(body?.deck), body ?? {}),
    'GET /api/song/onsets': async (_body, query) => {
      const deck = deckArg(query?.get?.('deck'));
      const s = needSong(deck);
      return { deck, ready: s.onsets != null, onsets: s.onsets ?? [] };
    },
    'GET /api/song/waveform': async (_body, query) => {
      const deck = deckArg(query?.get?.('deck'));
      const s = needSong(deck);
      const wave = await s.wave;
      if (!wave) throw new Error(`couldn't read "${s.title}" for its waveform`);
      return { deck, path: s.path, title: s.title, ...wave };
    },
  };

  // ---------------------------------------------------------------------------------------------
  // The evaluator's hooks (see evaluate.mjs's `desk`)
  // ---------------------------------------------------------------------------------------------

  return {
    attach(ev) {
      evaluator = ev;
    },
    async restore() {
      const hp = await store?.get?.(HEADPHONES_KEY).catch?.(() => null);
      if (hp) {
        if (Number.isFinite(hp.level)) headphones.level = hp.level;
        if (Number.isFinite(hp.mix)) headphones.mix = hp.mix;
      }
      engine.setHeadphones?.(headphones.level, headphones.mix);
      const regions = await store?.get?.(DJ_REGIONS_KEY).catch?.(() => null);
      if (regions?.mode === 'on') djRegionsMode = 'on';
      const held = await store?.get?.(MIDI_KEY).catch?.(() => null);
      if (held?.map && typeof held.map === 'object') midiSettings.map = held.map;
      if (typeof held?.feedback === 'string') midiSettings.feedback = held.feedback;
      // Learned controls work from the start, with no pattern asking for MIDI - the desktop's
      // rule. The page was let use MIDI when they were learned, so this does not ask again.
      if ((Object.keys(midiSettings.map).length || midiSettings.feedback) && midi?.available) {
        midi.enable()
          .then(() => (midiSettings.feedback ? midi.setFeedback(midiSettings.feedback) : null))
          .then((r) => { if (r) mixFeedbackActive = r.active ?? null; })
          .catch(() => {});
      }
      const fx = await store?.get?.(DJ_FX_KEY).catch?.(() => null);
      if (fx?.chains && typeof fx.chains === 'object') djFx = { chains: fx.chains };
    },
    routes,
    subscribe,
    notify: mixNotify,
    on: () => mixState.dj,
    clockOf,
    clockHeld: (deck) => clockHeldByDesk(deck),
    birthFor: mixBirthFor,
    applyTo: applyMixTo,
    /** An FX return's key: its device windows pin into the chain, not into the buffer. */
    isFxKey: (key) => key === FX_KEYS.a || key === FX_KEYS.b,
    fxPinState,
    // The tracks the desk owns rather than any buffer: the songs and the FX unit's returns.
    isSongKey: (key) => key === SONG_KEYS.a || key === SONG_KEYS.b || key === FX_KEYS.a || key === FX_KEYS.b,
    cueRouted,
    noteBuffer(deck, { name, code }) {
      let title = null;
      try { title = parseMeta?.(String(code ?? '')).title || null; } catch { title = null; }
      deckBuffers[deck] = { name: typeof name === 'string' && name.trim() ? name.trim() : null, title };
    },
    setGroupMembers(deck, pairs) {
      for (const key of [...groupMembers.keys()]) if (deckOfKey(key) === deck) groupMembers.delete(key);
      for (const [key, parent] of pairs) groupMembers.set(key, parent);
    },
    /** Swap mode: a NEW stem arrives gated out while the other deck has a song up. */
    gateNewStem(key, deck, isNew) {
      if (!mixState.swap || !isNew || groupMembers.has(key)) return;
      if (![...schedulers().keys()].some((k) => deckOfKey(k) !== deck)) return;
      if (mixState.perTrack.get(key)?.has('fader')) return;
      let per = mixState.perTrack.get(key);
      if (!per) mixState.perTrack.set(key, (per = new Map()));
      per.set('fader', 0);
    },
    /** A deck about to (re)build its tracks: its tempo and place under the desk's clock. */
    beforeTracks(deck, { start, fresh, running }) {
      djCodeTempo(deck, { fresh, alone: !deckAudible('a') && !deckAudible('b') });
      if (start && !running) clockFollowSong({ adopt: true });
      if (start && !running) clockTakeLeaderPlace(deck);
      const facts = evaluator?.facts?.(deck);
      deckClocks[deck].setFreeBpm(facts?.bpm ?? DEFAULT_BPM);
      if (!transport.paused && start && !running) {
        deckLiveRelease(deck);
        deckClockAlign(deck);
      }
    },
    /** Starts the room's clock on a free-running leader's bar, when there is one. */
    transportStart(atSec) {
      if (!transport.paused) return false;
      const phase = songFollowPhaseAt(atSec);
      if (phase == null) return false;
      songFollow.offset = 0;
      songFollow.adoptPending = false;
      transport.startAt(atSec, phase);
      return true;
    },
    afterEvaluate() {
      mixNotify();
    },
    tellTempo,
    /**
     * A message from a controller, before anything else hears it: true when the desk took it (a
     * learned control, or one being learned), which the page then keeps from every pattern too.
     */
    handleMidi(device, msg) {
      const kind = msg.kind === 'cc' ? 'cc' : 'note';
      const value = msg.kind === 'off' ? 0 : msg.value;
      return !!handleMixMidi(device, msg.channel, msg.num, value, kind);
    },
    /** The room's tempo moved: every rate-locked song re-derives its rate (with a model rebase). */
    onCpsChange() {
      for (const d of DECKS) if (songDecks[d]?.sync && songDecks[d]?.bpm) songApplyRate(d);
      mixNotify();
    },
    deckStopped(deck) {
      const s = songDecks[deck];
      if (s) {
        s.cueHeld = false;
        songPause(deck);
      }
      deckLiveRelease(deck);
    },
    allStopped() {
      for (const d of DECKS) {
        const s = songDecks[d];
        if (s) {
          s.cueHeld = false;
          songPause(d);
        }
        deckLiveRelease(d);
      }
    },
    othersSounding: (deck) => DECKS.some((d) => d !== deck && songDecks[d]?.playing),
    forgetKey(key) {
      mixState.perTrack.delete(key);
      for (const d of DECKS) if (SONG_KEYS[d] === key && songDecks[d]) songUnload(d);
    },
    rekeyKey(from, to) {
      const v = mixState.perTrack.get(from);
      if (v !== undefined) {
        mixState.perTrack.delete(from);
        mixState.perTrack.set(to, v);
      }
    },
    // For a probe or a test: the model as it stands.
    state: () => ({ mixState, songDecks, deckClocks, deckLive, songMasterDeck }),
    songPlayheadSec,
    loading: () => songLoading.size > 0,
    /**
     * Why the library's measuring pass should hold back right now, or null: a deck loading or
     * playing a song wants the analysis worker first (the desktop's libAnalyzeWhyWait).
     */
    analysisWait() {
      if (songLoading.size) return 'a deck is loading';
      const live = DECKS.filter((d) => songDecks[d]?.playing);
      return live.length ? `deck ${live.map((d) => d.toUpperCase()).join(' and ')} is playing` : null;
    },
    /** What the library browser colors its rows by: played tonight, and on a deck now. */
    playedNow: () => ({
      playedSession: [...songPlayedSession.keys()],
      playedSaves: [...codePlayedSession],
      onDeck: Object.fromEntries(DECKS.filter((d) => songDecks[d]?.path)
        .map((d) => [d, { path: songDecks[d].path, playing: deckPlaying(d) }])),
    }),
  };
}

export { Unsupported as DeskUnsupported };
