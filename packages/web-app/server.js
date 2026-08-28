'use strict';

// Plain Node HTTP server - serves the browser UI from public/ and exposes engine, transport,
// and file operations as JSON-over-HTTP endpoints (see `routes`). Everything is request/reply
// (no push updates needed), so plain HTTP is enough - no WebSocket dependency.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { MappedEngine, toRealWorld } = require('./param-mapping');
const { blockReason, isLoopbackHostname } = require('./request-guard');
const { preferVst3 } = require('./plugin-filter');
const { SNAPSHOT_DIR, putSnapshot, getSnapshot, pruneSnapshots } = require('./snapshots');
const blobs = require('./blobs');
const pinnedDefs = require('./pinned-defs');
const snippets = require('./snippets');
const recordings = require('@poptart/osc-engine/recordings');
const analysis = require('@poptart/osc-engine/analysis');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
// Loopback-only by default: this server evals arbitrary JS (/api/evaluate), so binding
// 0.0.0.0 would hand code execution to anyone on the same network. POPTART_HOST exists for
// a deliberate LAN bind (e.g. a collaborative jam) - that opt-out also relaxes the
// browser-level guards below, which only make sense for a loopback-only server.
const HOST = process.env.POPTART_HOST || '127.0.0.1';
const LOOPBACK_ONLY = isLoopbackHostname(HOST);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// CodeMirror (v5: plain script files, no build step) is served under /vendor/codemirror/
// straight out of node_modules - see resolveStaticPath(). pattern-core's dependency-free ESM
// sources are served under /pattern-core/ so the browser can run the same mini-notation parser
// and label splitter the server uses (playback highlighting needs identical step math).
const CODEMIRROR_DIR = path.dirname(require.resolve('codemirror/package.json'));
const PATTERN_CORE_SRC_DIR = path.join(__dirname, '..', 'pattern-core', 'src');

const DEFAULT_CPS = 0.5; // 120 bpm at 4 beats/cycle - overridable from code via setbpm()

let patternCore = null; // loaded via dynamic import() since it's an ESM package
let engine = null; // raw OscEngine (introspection/record endpoints talk to this directly)
let mappedEngine = null; // alias + unit-conversion wrapper (see param-mapping.js) - what the scheduler drives
let engineError = null;
let transport = null; // shared tempo clock (pattern-core Transport) - all schedulers read it
const schedulers = new Map(); // pattern label -> Scheduler (one engine track per label)

// Engine tracks are keyed by opaque ids ("#1", "#2", ...), not labels, so a track can be
// re-labeled (deck promotion, in the performance-mixing work - see TODO.md) without any engine
// churn. Everything client-facing stays in label space; translation happens only at the engine
// boundary (engineTrack) and at engine-callback entry (trackLabel, applied in wireEngine).
// Ids start with '#', which no block label can contain, so an unknown label passed through
// verbatim can't collide with a real track. Like the engine tracks they name, ids live for the
// server's life - there is no destroyTrack, and an engine restart recreates tracks under the
// same ids (each Scheduler re-sends createTrack with the id it was built with).
const trackIds = new Map(); // label -> engine track id
const trackLabels = new Map(); // engine track id -> label
let nextTrackNum = 1;
// Tracks come into being in exactly two places - the eval loop, and /api/song/load (the song
// decks' fixed '#song' keys) - so those are the only callers allowed to mint an id; everything
// else must use engineTrack, or a typo'd label would allocate a ghost track.
function claimEngineTrack(label) {
  let id = trackIds.get(label);
  if (!id) {
    id = `#${nextTrackNum++}`;
    trackIds.set(label, id);
    trackLabels.set(id, label);
  }
  return id;
}
// Non-minting: a label no eval has seen passes through verbatim, and the engine ignores it the
// same way it has always ignored notes aimed at tracks that don't exist.
const engineTrack = (label) => trackIds.get(label) ?? label;
const trackLabel = (id) => trackLabels.get(id) ?? id;

// The two performance decks (see TODO.md). 'a' is the main editor; 'b' is the queued song a mix
// brings in. A deck-b eval keys its schedulers "b:<label>" (a block label can't contain ':', so
// the namespace can't collide), and its song-level facts - the key setscale() left in force, the
// tempo setbpm() asked for - are recorded HERE rather than applied globally: deck b plays in its
// own key but at the main deck's tempo until the mix migrates it (phase 5). The process-global
// scale holds deck a's key at rest; a deck's eval borrows it and puts it back.
const decks = {
  a: { scale: null, bpm: null },
  b: { scale: null, bpm: null },
};
const deckOfKey = (key) => (key.includes(':') ? key.slice(0, key.indexOf(':')) : 'a');

// A deck's native tempo as the DESK sees it: what its track declared (setbpm, a song file's
// tags, the pane's bpm field), or the 120 default an unspecified track gets - the same tempo it
// would play at loaded outside dj mode. Only a signal-driven setbpm has no single number, and
// that reads as null (there is nothing for the migration slider to ride to).
function deckNativeBpm(deck) {
  const bpm = decks[deck].bpm;
  if (typeof bpm === 'number') return bpm;
  return bpm == null ? DEFAULT_CPS * 240 : null;
}

// Signal.prototype is SHARED between decks by design: extensions from one song are available to
// the other. The collision case - both songs defining the same name differently - gets a console
// warning rather than isolation, and the later eval wins for both. Tracked by diffing the
// prototype after every eval against the baseline captured after prebake (built-ins and the
// prebake library are nobody's).
const protoOwners = new Map(); // prop -> { deck, value }
let protoBaseline = null; // own props of Sig.prototype before any buffer extended it
function noteProtoOwnership(deck) {
  if (!protoBaseline || !patternCore?.Sig) return;
  const proto = patternCore.Sig.prototype;
  for (const prop of Object.getOwnPropertyNames(proto)) {
    if (protoBaseline.has(prop)) continue;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    const value = desc.get ?? desc.value;
    const prev = protoOwners.get(prop);
    if (prev && prev.value === value) continue;
    if (prev && prev.deck !== deck) {
      eventLogQueue.push(`[deck] Signal.prototype.${prop} is defined by both decks' code - deck ${deck}'s later definition now wins for both`);
    }
    protoOwners.set(prop, { deck, value });
  }
}

// ---------------------------------------------------------------------------------------------
// Performance-mix state (the DJ layer - see TODO.md). EPHEMERAL by design: none of this is ever
// written into song code (deliberately unlike the ctrl+g mixer's .gain() edits) - it belongs to
// the mix session and dies with it. The engine side is the DJ stage baked into every track
// SynthDef (trim / eqlo / eqmid / eqhi / djf / djres / fader / deck - see sc/poptart.scd): all are
// channel controls on pseudo-slot -1, so applying a value is one setParam. What's stored here is
// re-applied to a track every time an eval (re)creates it, which is what makes a queued deck
// arrive SILENT: the mix UI sets deck b's `deck` gain to 0 before its first eval, and every
// track that eval births wears that gain before its scheduler starts.
// ---------------------------------------------------------------------------------------------
// djf is the filter's cutoff (its center detent is 0); djres is that filter's resonance
// AMOUNT, deliberately a control of its own - see the DJ stage in sc/poptart.scd.
const DJ_NEUTRAL = { trim: 1, eqlo: 1, eqmid: 1, eqhi: 1, djf: 0, djres: 0, fader: 1, deck: 1, cue: 0 };
const mixState = {
  swap: false, // swap mode: gating a stem in throws the SAME-NAMED stem on the other deck out
  // Solo, per deck: the SET of soloed stems (cmd+click a gate; cmd+shift+click adds another) and
  // the faders as they stood before the first solo, restored when the last soloed stem leaves -
  // a solo is an audition, not an edit, so ending it returns the deck to what it was.
  solo: { a: new Set(), b: new Set() },
  soloPrev: { a: null, b: null }, // key -> fader snapshot while solo is on, else null
  perDeck: { a: new Map(), b: new Map() }, // deck-broadcast values (the crossfader's `deck`, a deck-wide djf)
  perTrack: new Map(), // key -> Map(name -> value): faders, per-track EQ, trim
  xf: -1, // crossfader position (-1 = hard at deck A) - the source of the two `deck` gains
  // The channel faders (one per deck, like a hardware desk's, on top of the crossfader): each
  // deck's engine-side `deck` gain is xf-curve x its fader. NOT broadcast as `fader` - that
  // synth control belongs to the per-stem gates and mini-faders, and a deck-wide write to it
  // would clobber them all at once.
  faders: { a: 1, b: 1 },
  // Tempo migration (phase 5): once the mix desk touches the clock (/api/mix/tempo), this holds
  // the bpm it asked for and the MAIN deck's setbpm stops driving the transport (it still
  // records the song's native tempo) - otherwise re-evaling deck a mid-migration would snap the
  // clock back to its declared bpm. Cleared by eject (deck a's declared tempo is restored) and
  // by complete (the promoted song's own setbpm takes over on its promotion re-eval).
  tempoOverride: null,
};

// ---------------------------------------------------------------------------------------------
// Song decks: a real audio file (a bought track, a bounce) playing on a DJ deck, mixed through
// the same desk as the pattern decks. The song is ONE ordinary engine track - key '#song'
// (deck a) or 'b:#song' - whose input is a persistent player synth (sc/poptart.scd's
// poptart_song_*) instead of a scheduler, which is what makes the whole strip (crossfader, EQ,
// filter, faders, meters, cue, per-deck stop) apply to it unchanged. '#' can't appear in a
// block label, so the key can never collide with user code. Node owns the musical bookkeeping:
// position, quantized starts, and the end-of-file pause (the engine-side Phasor would wrap and
// replay). See TODO.md's song-deck phases for what's still to come (waveform pane, tempo sync,
// nudge, metadata).
// ---------------------------------------------------------------------------------------------
const { resolveSongFile, classifySongFile } = require('@poptart/osc-engine/songs');
const { readSongTags } = require('@poptart/osc-engine/song-tags');
const songSync = require('./song-sync');
const { browseSongDir, statSongPaths, walkSongFiles, defaultSongDir } = require('./song-files');
const SONG_KEYS = { a: '#song', b: 'b:#song' };
const SONG_START_LEAD_SEC = 0.15; // enough for the timestamped start bundle to arrive early
const songDecks = { a: null, b: null };
// each: { path, title, duration, sampleRate, channels, frames, decoded, rate,
//         playing, posSec ("the playhead as of startSec" while playing; the resting playhead
//         while paused), startSec (engine-clock moment posSec was current), endTimer }

// Waveform analyses already computed, keyed by the analyzed file's identity (path + mtime +
// size - a .wav plays from its source path, so the path alone wouldn't notice an edit). A set
// that re-queues a song re-sends bytes, not work; bounded because the payloads are ~1MB each.
const songWaveCache = new Map();

const songKeysLive = () => ['a', 'b'].filter((d) => songDecks[d]).map((d) => SONG_KEYS[d]);
// The desk's full population: every scheduler-driven track plus any song tracks - what deck
// broadcasts, per-track mix sets and the strip's track list enumerate. A song is a stem too.
const isMixKey = (key) => schedulers.has(key) || songKeysLive().includes(key);
// One stem's DJ fader (the gate's control): remembered per track so a re-eval re-applies it.
function mixSetFader(key, value) {
  let per = mixState.perTrack.get(key);
  if (!per) mixState.perTrack.set(key, (per = new Map()));
  per.set('fader', value);
  engine.setParam(engineTrack(key), -1, 'fader', value, 0);
}

// The plain gate gesture on one stem. Outside solo it is just the fader.
//
// A plain click on a SOLOED stem means "done auditioning": the whole solo ends and the deck
// returns to the faders it had before it started - and nothing else. It deliberately does not
// also toggle the stem that was clicked; the gesture asked to leave the solo, not to make an
// edit on the way out, and a stem that vanished as you dismissed the audition would be a
// surprise. Leaving one stem of a solo at a time is cmd+click's job.
//
// Gating a stem that ISN'T soloed while a solo runs is a real edit, and goes into the snapshot
// too, so it survives the solo's end.
function mixGateSet(key, on) {
  const deck = deckOfKey(key);
  if (mixState.solo[deck].has(key)) {
    mixSoloEnd(deck);
    return;
  }
  mixSetFader(key, on ? 1 : 0);
  mixState.soloPrev[deck]?.set(key, on ? 1 : 0);
}

// End a deck's solo: every stem back to the fader it had before the first solo (stems born
// during the solo have no entry - they come in at 1, like any fresh stem).
function mixSoloEnd(deck) {
  const prev = mixState.soloPrev[deck];
  mixState.solo[deck].clear();
  mixState.soloPrev[deck] = null;
  if (!prev) return;
  for (const k of mixKeys()) if (deckOfKey(k) === deck) mixSetFader(k, prev.get(k) ?? 1);
}

// Every gate on one deck OUT in a single gesture (the deck head's `mute all`). Named for what it
// is FOR, not for what it holds: there is no mute state here and no unmute, it is the gate click
// you would have made on every stem, made on all of them at once. What it is for is the blank canvas - empty the deck, then
// bring parts back one gate at a time as the mix builds - so it takes out the stems that exist
// at the moment it is pressed and has no opinion about anything evaled afterwards.
//
// A solo on that deck ends first, or its snapshot would put back the very stems this took out.
// And it goes through mixGateSet rather than the /api/mix/gate route, so swap mode's counter
// never runs: emptying deck A must not throw all of deck B's stems in.
function mixGateAll(deck) {
  mixSoloEnd(deck);
  const gated = [...mixKeys()].filter((k) => deckOfKey(k) === deck);
  for (const key of gated) mixGateSet(key, false);
  return gated;
}

function* mixKeys() {
  yield* schedulers.keys();
  yield* songKeysLive();
}

/** The playhead in song-seconds at engine time `at` (defaults to now). */
function songPlayheadSec(deck, at = null) {
  const s = songDecks[deck];
  if (!s) return 0;
  const t = at ?? (engine ? engine.getTime() : s.startSec);
  const pos = s.playing ? s.posSec + Math.max(0, t - s.startSec) * s.rate : s.posSec;
  return Math.min(Math.max(0, pos), s.duration);
}

// Pause a deck where it stands, engine gate and bookkeeping together - what /api/song/pause,
// the per-deck stop and a cue release all want. (songMarkPaused below is the bookkeeping half
// on its own, for the callers that close the gate differently or not at all.)
//
// Two engine messages, not one. `run` 0 slews the phasor to a halt over ~20ms - the little
// turntable-style stop that makes a pause not a click. But a player halted that way is still a
// running synth reading a frozen buffer index, which is a CONSTANT SAMPLE: every paused deck
// was leaving a DC offset on its track's input bus, for as long as it stayed paused. It costs
// headroom, it lights the deck's channel meter over silence, and any later gain move (a
// crossfade, an EQ kill, the next start) steps that DC audibly. So the halted player is
// released a quarter second later, once the slew is over and it has nothing left to say - a
// resume spawns a fresh player at posSec regardless (see /api/song/play), so nothing is lost
// by letting the old one go.
const SONG_PAUSE_RELEASE_SEC = 0.25;
// The player's OWN release - sc/poptart.scd's poptart_song_* / poptart_songwarp_*, whose envelope
// is Env.asr(0.005, 1, 0.05), so a gate 0 takes this long to reach silence and free the synth.
// Node needs the number because the fade at the END of a file has to be finished by the last
// sample rather than started at it (see songEndOfFile).
const SONG_RELEASE_SEC = 0.05;
function songPause(deck, posSec = null) {
  if (!songDecks[deck]?.playing) return;
  if (engine) {
    const tid = engineTrack(SONG_KEYS[deck]);
    try {
      engine.songSet(tid, 'run', 0, 0);
      engine.songStop(tid, engine.getTime() + SONG_PAUSE_RELEASE_SEC);
    } catch { /* engine between restarts */ }
  }
  songMarkPaused(deck, posSec);
}

// Pause bookkeeping shared by pause/per-deck stop/end-of-file: fold the running playhead into
// posSec and disarm the end timer. The engine-side `run` gate is the caller's to close.
function songMarkPaused(deck, posSec = null) {
  const s = songDecks[deck];
  if (!s) return;
  s.posSec = posSec ?? songPlayheadSec(deck);
  s.playing = false;
  if (s.endTimer) clearTimeout(s.endTimer);
  s.endTimer = null;
}

// End of file, and NOT a pause. Pausing halts the Phasor (`run` 0, ~20ms of slew) and leaves the
// player holding a frozen sample - but doing that AT the end means the Phasor is still moving as
// it arrives there, and Phasor wraps: the deck jumps from the last sample to frame 0, which is a
// click, and then plays a few ms of the track's own beginning on the way down. It was audible on
// anything that doesn't happen to end in silence.
//
// So the end is a plain gate 0, sent one release EARLY: the player's own envelope fades the last
// 50ms out, reaches zero on the final sample, and frees the synth itself (doneAction 2). There is
// nothing left holding a loud sample to click, and nothing still moving to wrap.
//
// `endAt` is the engine moment the last sample plays, worked out when the timer was ARMED rather
// than measured on arrival, so a late event loop still fades at the right sample - and _latency
// clamps a moment already past to "now", which is the worst case rather than a wrong one.
function songEndOfFile(deck, endAt) {
  const s = songDecks[deck];
  if (!s?.playing) return;
  if (engine) {
    try {
      engine.songStop(engineTrack(SONG_KEYS[deck]), endAt - SONG_RELEASE_SEC);
    } catch { /* engine between restarts */ }
  }
  // The playhead is pinned to the duration rather than measured: this is where it got to, and the
  // model must land exactly on the end, not a millisecond either side of it.
  songMarkPaused(deck, s.duration);
  mixNotify();
}

// Arm the end of the file. Re-armed on every start and seek (and, later, rate change).
function songArmEndTimer(deck) {
  const s = songDecks[deck];
  if (!s) return;
  if (s.endTimer) clearTimeout(s.endTimer);
  s.endTimer = null;
  if (!s.playing || !(s.rate > 0) || !engine) return;
  const now = engine.getTime();
  const begin = Math.max(now, s.startSec); // a quantized start may not have begun yet
  const secondsLeft = (begin - now) + (s.duration - songPlayheadSec(deck, begin)) / s.rate;
  // Fired one release early, because the fade has to be OVER by the last sample rather than
  // beginning at it. songEndOfFile is handed the true end so the timer's own jitter doesn't move
  // where the fade lands.
  const endAt = now + secondsLeft;
  s.endTimer = setTimeout(() => {
    s.endTimer = null;
    songEndOfFile(deck, endAt);
  }, Math.max(0, (secondsLeft - SONG_RELEASE_SEC) * 1000));
}

// --- tempo sync + nudge + drift servo (songs phase 4; the math lives in song-sync.js) ---

// Is anything besides this deck's song sounding - a pattern deck, the other song? That is
// what a start has to lock onto; with nothing, the start defines the grid instead.
function othersPlaying(deck) {
  return [...schedulers.values()].some((sch) => sch.running)
    || ['a', 'b'].some((d) => d !== deck && songDecks[d]?.playing);
}

// The rate a deck's song should run at before the momentary nudge: locked to the master clock
// when synced (rate = master/native), the manual rate otherwise.
function songBaseRate(deck) {
  const s = songDecks[deck];
  if (!s) return 1;
  // Paused with nothing else on the clock, a synced song will take the grid when it plays
  // (see /api/song/play: the clock adopts ITS tempo, so it runs at 1) - say so now, or the pane
  // draws the strip at master/native against a clock the play is about to replace and the
  // waveform visibly rescales on the first press. The hand's tempo override is the exception:
  // play leaves the clock where it was put.
  if (!s.playing && s.sync && s.bpm && !othersPlaying(deck) && mixState.tempoOverride == null) return 1;
  if (s.sync && s.bpm && transport) {
    return songSync.syncRate(transport.cps * 240, s.bpm, deck === songMasterDeck ? 1 : s.syncMult) ?? s.manualRate;
  }
  return s.manualRate;
}

// The tempo ratio a deck's sync is riding (0.5 | 1 | 2 - song tempo over clock tempo; see
// songSync.syncOctave), and the bpm its GRID counts in at that ratio: a 70 bpm song running
// half-time under a 140 clock is aligned as a 140 - its eighths are the clock's beats, its
// half-bars the clock's cycles. The deck whose song set the clock is the clock: its ratio is
// 1 whatever the button says (the button is greyed for it), or a press there would re-pitch
// the master against itself.
let songMasterDeck = null; // the deck whose song last took the grid (see /api/song/play)
function songOctave(deck) {
  const s = songDecks[deck];
  if (!s || !s.bpm) return 1;
  if (deck === songMasterDeck) return 1;
  return songSync.syncOctave(transport ? transport.cps * 240 : s.bpm, s.bpm, s.syncMult);
}
const songGridBpm = (deck) => (songDecks[deck]?.bpm ?? 0) / songOctave(deck);

// What the engine's `rate` control is actually set to: the musical rate plus the drift servo's
// trim. The trim never enters Node's playhead model - it exists precisely to make the engine's
// playhead converge on that model.
function songSendRate(deck) {
  const s = songDecks[deck];
  if (!s || !engine) return;
  try { engine.songSet(engineTrack(SONG_KEYS[deck]), 'rate', s.rate + s.servo, 0); } catch { /* engine between restarts */ }
}

// Apply the current effective rate (sync x nudge), rebasing the linear playhead model at the
// same moment so it stays exact through any number of rate moves - a tempo ramp arrives as a
// step every few tens of ms, and each step re-anchors here. A quantized start that hasn't
// begun yet is left alone (its synth may not exist server-side yet); the first ramp step after
// it begins corrects the rate.
function songApplyRate(deck) {
  const s = songDecks[deck];
  if (!s) return;
  const eff = songSync.effectiveRate(songBaseRate(deck), s.nudge);
  if (eff === s.rate) return;
  if (s.playing && engine && engine.getTime() >= s.startSec) {
    const now = engine.getTime();
    s.posSec = songPlayheadSec(deck, now);
    s.startSec = now;
    s.rate = eff;
    songSendRate(deck);
    songArmEndTimer(deck);
  } else {
    s.rate = eff;
    if (s.playing && engine && !s.pendingRateTimer) {
      // A quantized start still pending was scheduled with an older rate baked into its
      // bundle, and the player doesn't exist server-side until that timestamp - push the
      // current rate just after it begins (the servo then trims out the sliver in between).
      s.pendingRateTimer = setTimeout(() => {
        s.pendingRateTimer = null;
        if (songDecks[deck] === s && s.playing) songSendRate(deck);
      }, Math.max(0, (s.startSec - engine.getTime()) * 1000) + 80);
    }
  }
}

// The drift servo's measurement side: the player reports its actual playhead ~2/sec (see the
// song defs in sc/poptart.scd), and Node's clock and scsynth's sample clock drift apart over
// minutes. Small error: trim the engine rate a hair (never audibly) until it closes. Large
// error: that's not drift, adopt the engine's truth. Reports racing a fresh start/seek/rebase
// are ignored - the model just moved, and the report predates it.
const SONG_SERVO_SETTLE_SEC = 0.6;
function handleSongPos(trackId, pos) {
  const deck = ['a', 'b'].find((d) => songDecks[d] && engineTrack(SONG_KEYS[d]) === trackId);
  const s = deck && songDecks[deck];
  if (!s || !s.playing || !engine) return;
  const now = engine.getTime();
  if (now - s.startSec < SONG_SERVO_SETTLE_SEC) return;
  const expected = songPlayheadSec(deck, now);
  const trim = songSync.servoTrim(pos - expected);
  if (trim == null) {
    // Too far to trim. The MODEL is the one on the grid (it is what every start was quantized
    // against), so the engine is put back on it - a seek, audible as a skip, but in time -
    // rather than the model adopting the engine and every deck silently falling out of phase.
    // Loud on purpose: this should only ever follow a dropout; anything else is a bug worth
    // the line in the pane.
    // eslint-disable-next-line no-console
    console.warn(`[song] deck ${deck} servo: engine at ${pos.toFixed(3)}s, model at ${expected.toFixed(3)}s (${(pos - expected).toFixed(3)}s off, ${(now - s.startSec).toFixed(2)}s after start) - seeking the engine back onto the grid`);
    s.servo = 0;
    songSendRate(deck);
    try { engine.songSeek(engineTrack(SONG_KEYS[deck]), songPlayheadSec(deck, now + SONG_START_LEAD_SEC), now + SONG_START_LEAD_SEC); } catch { /* engine between restarts */ }
  } else if (trim !== s.servo) {
    s.servo = trim;
    songSendRate(deck);
  }
}

// One nudge gesture, shared by /api/song/nudge and the mixMidi nudge/jog buttons. `hold` is
// the momentary rate offset (press +-1, release 0); `jog` steps the phase one song-beat (the
// bar-fix after a beat-aligned start), or 100ms when the song has no bpm.
function songNudge(deck, { hold, jog }) {
  const s = songDecks[deck];
  if (!s) throw new Error(`deck ${deck} has no song loaded`);
  if (hold !== undefined) {
    s.nudge = Math.sign(Number(hold) || 0);
    songApplyRate(deck);
  }
  const dir = Math.sign(Number(jog) || 0);
  if (dir) {
    const to = Math.min(Math.max(0, songPlayheadSec(deck) + (s.bpm ? 60 / s.bpm : 0.1) * dir), s.duration);
    if (s.playing && engine) {
      engine.songSeek(engineTrack(SONG_KEYS[deck]), to, 0);
      s.posSec = to;
      s.startSec = engine.getTime();
      s.servo = 0;
      songArmEndTimer(deck);
    } else {
      s.posSec = to;
    }
  }
  mixNotify();
  return { deck, nudge: s.nudge, pos: s.posSec, rate: s.rate };
}

// --- the cue point + the CUE gesture (the button on the song pane, and Ctrl+C) ---
//
// A deck's cue point is where the track "lives" when it isn't playing: press and HOLD cue to
// preview from it, release to drop the playhead back on it, paused and ready. That is one
// gesture, not two buttons, and it is the whole point of the control - the alternative (play,
// listen, stop, scrub back to where you meant) loses the position every time.
//
// The cue point MOVES only on a press while the deck is paused: park the playhead somewhere,
// press, and that is the new cue. Press while it is PLAYING and the position is left alone -
// that press is the "back to cue" that takes a running deck home without redefining home.
//
// Never quantized. Everything else a deck can be told to do joins the shared clock at the next
// cycle boundary; a cue preview has to answer the finger, because what it is for is hearing
// whether the finger landed in the right place.
function songCue(deck, hold) {
  const s = songDecks[deck];
  if (!s) throw new Error(`deck ${deck} has no song loaded`);
  if (!engine) throw new Error(engineError ?? 'engine not loaded');
  const tid = engineTrack(SONG_KEYS[deck]);
  if (hold) {
    const wasPlaying = s.playing;
    const before = songPlayheadSec(deck);
    if (!s.playing) {
      // Parked somewhere new: the cue is here now - and it IS the downbeat. A cue point is
      // where the hand says "one" is, so it anchors the beatgrid too: the two used to be
      // separate gestures, and a cue snapped to a grid whose downbeat was wrong went to the
      // wrong place. Taken EXACTLY where the pane shows the playhead - never moved at press
      // time (a jump under the finger is jarring); the pane's scrub magnet is what pulls the
      // playhead onto a transient beforehand, and a hand that wants to be between hits can be.
      const at = songPlayheadSec(deck);
      s.cueSec = at;
      s.anchorSec = at;
      s.anchorByHand = true;
      s.gridDetected = null;
    }
    // A playing deck comes home the same way a paused one previews - one songStart, which the
    // engine already handles as a swap (the old player releases exactly at the new one's start,
    // fading under it) rather than a stop followed by a start.
    const startSec = engine.getTime() + SONG_START_LEAD_SEC;
    s.nudge = 0;
    s.servo = 0;
    s.rate = songSync.effectiveRate(songBaseRate(deck), 0);
    engine.songStart(tid, s.cueSec, s.rate, startSec, s.keylock ? 1 : 0);
    s.posSec = s.cueSec;
    s.startSec = startSec;
    s.playing = true;
    s.cueHeld = true;
    songArmEndTimer(deck);
    // eslint-disable-next-line no-console
    console.log(`[song] deck ${deck} cue press: ${wasPlaying ? 'playing -> back to cue' : 'paused -> cue set'} at ${s.cueSec.toFixed(3)}s (playhead was ${before.toFixed(3)}s, anchor ${s.anchorSec.toFixed(3)}s, bpm ${s.bpm})`);
  } else if (s.cueHeld) {
    s.cueHeld = false;
    songPause(deck);
    s.posSec = s.cueSec; // home again: the next start (cue or play) reads posSec for its entry
  }
  mixNotify();
  return { deck, cueSec: s.cueSec, playing: s.playing };
}

// Forget one deck's song: player released and buffer freed engine-side, Node state dropped.
// The TRACK stays warm (it's dropTrack's to take down) - a new load reuses it.
function songUnload(deck) {
  const s = songDecks[deck];
  if (!s) return;
  if (s.endTimer) clearTimeout(s.endTimer);
  songDecks[deck] = null;
  if (engine) {
    try { engine.songFree(engineTrack(SONG_KEYS[deck])); } catch { /* engine between restarts */ }
  }
}

// --- bpm/key detection fallback (songs phase 5) ---
//
// When a load leaves bpm or key unknown (no tag, no playlist word), estimate them from the
// audio: onset-envelope autocorrelation for bpm, chroma + Krumhansl profiles for key (see
// osc-engine/song-detect.js), on the analysis worker. Fire-and-forget from /api/song/load; the
// results adopt into the deck's facts ONLY where they are still unset when the analysis lands -
// a typed value, a re-load, or an unload in the meantime wins by construction (the deck-state
// object's identity is the staleness token). Adopted facts carry their confidence
// (bpmDetected/keyDetected, 0..1) so the pane can show them as estimates; a manual edit clears
// the marker (see /api/song/meta). Results are cached by file identity - re-queuing the same
// untagged song re-reads a Map, not ninety seconds of audio.
const songFactsCache = new Map();

// Every load is analyzed, tags or no tags: the beatgrid (bpm to a hundredth, the downbeat
// offset) is what tempo sync stands on, and a tag only ever says "128". A tagged/typed bpm
// goes in as the hint - it pins the octave, and the fit refines it.
async function songDetectKick(deck) {
  const s = songDecks[deck];
  if (!s) return;
  const srcPath = s.path;
  const bpmHint = s.bpm;
  try {
    const st = fs.statSync(srcPath);
    const cacheKey = `${srcPath}|${Math.round(st.mtimeMs)}|${st.size}|${bpmHint ?? ''}`;
    let facts = songFactsCache.get(cacheKey);
    if (facts === undefined) {
      // Give the pane's waveform fetch first crack at the shared analysis worker - the picture
      // is what the user is waiting on; the estimate can land a beat later.
      await new Promise((r) => { setTimeout(r, 1500); });
      if (songDecks[deck] !== s) return;
      const resolved = await resolveSongFile(srcPath, { wav: true });
      facts = await analysis.songDetect(resolved.path, { bpmHint });
      songFactsCache.set(cacheKey, facts);
      while (songFactsCache.size > 24) songFactsCache.delete(songFactsCache.keys().next().value);
    }
    if (songDecks[deck] !== s || !facts) return;
    let changed = false;
    // The detector's list opens with a synthetic hit at 0:00 (its slice-0 convention); as a
    // snap target that would pull every cue placed near the top of a track onto the file
    // start rather than the first real transient just after it.
    s.onsets = facts.onsets ? facts.onsets.filter((t) => t > 0.002) : null;
    if (facts.bpm != null && s.bpm !== facts.bpm) {
      // Within a few percent of the hint it's the same tempo measured properly (the fit never
      // strays further - see fitBeatGrid); with no hint it's the estimate, and marked as one.
      const refining = s.bpm != null;
      if (!refining || Math.abs(facts.bpm / s.bpm - 1) < 0.03) {
        s.bpm = facts.bpm;
        if (!refining) s.bpmDetected = facts.bpmConfidence ?? 0;
        decks[deck].bpm = facts.bpm; // the native tempo slot the desk's migration slider rides to
        // The same default a tagged load gets - but never mid-play: flipping sync under a song
        // already running at manual rate would lurch it.
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
    if (!changed) return;
    songApplyRate(deck);
    mixNotify();
  } catch { /* detection is a fallback - a failure just leaves manual entry, as before phase 5 */ }
}

// --- mix-strip MIDI (learn + drive) ---
//
// A hardware knob per desk control, the crossfader first: `settings.mixMidi` maps a target name
// to the { device, channel, cc } that drives it, persisted in settings.json like everything
// else. Learning is a long-poll: /api/mix/midilearn arms a target, the next CC message anywhere
// binds it. A mapped (or learning) CC is CONSUMED - a knob given to the desk must not also
// drive a midicc() in song code.
const MIX_MIDI_TARGETS = new Set(['xf',
  ...['a', 'b'].flatMap((d) => ['trim', 'eqlo', 'eqmid', 'eqhi', 'djf', 'djres', 'fader',
    // The song deck's platter buttons (songs phase 4) - button targets, not knobs: a nudge
    // holds while the CC is high (press 127 / release 0), a jog fires on the press edge.
    'nudgedn', 'nudgeup', 'jogdn', 'jogup'].map((c) => `${d}:${c}`))]);
let mixMidiLearn = null; // { target, finish, timer } while a learn long-poll is armed

// A CC's 0..1 into the target's own range: two-sided controls center at 0, gains at unity.
function mixMidiValue(target, v01) {
  const ctl = target === 'xf' ? 'xf' : target.slice(2);
  if (ctl === 'xf' || ctl === 'djf') return v01 * 2 - 1;
  if (ctl === 'fader' || ctl === 'djres') return v01; // one-sided 0..1, neutral at the bottom
  return v01 * 2; // trim and the EQ bands: 0..2, unity at center
}

function handleMixMidi(device, channel, cc, value) {
  if (mixMidiLearn) {
    const { target, finish, timer } = mixMidiLearn;
    mixMidiLearn = null;
    clearTimeout(timer);
    settings.mixMidi = { ...(settings.mixMidi ?? {}), [target]: { device, channel, cc } };
    saveSettings();
    finish({ device, channel, cc });
    return true;
  }
  for (const [target, m] of Object.entries(settings.mixMidi ?? {})) {
    if (m && m.device === device && m.channel === channel && m.cc === cc) {
      const name = target === 'xf' ? 'xf' : target.slice(2);
      if (name.startsWith('nudge') || name.startsWith('jog')) {
        const press = value >= 0.5;
        try {
          if (name.startsWith('nudge')) songNudge(target[0], { hold: press ? (name === 'nudgeup' ? 1 : -1) : 0 });
          else if (press) songNudge(target[0], { jog: name === 'jogup' ? 1 : -1 });
        } catch { /* no song on that deck - the button just does nothing */ }
        return true;
      }
      const t = target === 'xf'
        ? { name: 'xf', value: mixMidiValue(target, value) }
        : { deck: target[0], name, value: mixMidiValue(target, value) };
      try {
        applyMixTargets([t]);
      } catch { /* engine between restarts - the knob just does nothing */ }
      return true;
    }
  }
  return false;
}

// Everything the mix session holds for one (possibly just-created) track, applied engine-side.
// Deck-broadcast values first, then the track's own, so a per-track value wins.
function applyMixTo(key) {
  if (!engine) return;
  const tid = engineTrack(key);
  const per = mixState.perTrack.get(key);
  for (const [name, value] of mixState.perDeck[deckOfKey(key)] ?? []) {
    if (!per?.has(name)) engine.setParam(tid, -1, name, value, 0);
  }
  for (const [name, value] of per ?? []) engine.setParam(tid, -1, name, value, 0);
}

// The crossfader as ONE control, server-side: position -1..1 (u is this deck's own 0..1 share)
// through one of TWO curves, following the swap toggle like a hardware desk's curve switch:
//   - swap OFF (blend mixing): constant power, the classic mixing curve - each side ~-3 dB at
//     center, so the summed energy stays level across the sweep instead of bumping ~+3 dB with
//     the fader parked in the middle (reported 2026-08-25);
//   - swap ON (the stem-swap workflow): each deck holds FULL from its end through CENTER and
//     only cuts on the far half - both decks wide open at center so the per-stem gates decide
//     what sounds, and a gate-swap is loudness-neutral.
// Server-side so the UI slider and a learned MIDI knob drive the same implementation (see
// /api/mix/set and mixMidi); /api/mix/swap re-derives the deck gains when the curve flips.
const xfGain = (u) => Math.round(
  (mixState.swap
    ? Math.sin((Math.PI / 2) * Math.min(1, u * 2)) // hold-through-center (scratch-style)
    : Math.sin((Math.PI / 2) * u) // constant power (cos on the other deck's mirrored share)
  ) * 1000,
) / 1000;
// One deck's side of the current crossfader position through that curve (before its fader).
const deckXfGain = (deck) => xfGain(deck === 'a' ? 1 - (mixState.xf + 1) / 2 : (mixState.xf + 1) / 2);

// One mix-desk gesture, shared by the HTTP endpoint and the MIDI path. A target is
// { name, value } plus `deck` (broadcast) or `key` (one track); name 'xf' is the crossfader
// pseudo-control, unpacked here into both decks' `deck` gains.
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
    // The channel fader (deck-addressed `fader`): folds into that deck's `deck` gain rather
    // than broadcasting - `fader` on the synths is the per-stem gates' control (see mixState).
    if (name === 'fader' && (t.deck === 'a' || t.deck === 'b')) {
      mixState.faders[t.deck] = Math.min(1, Math.max(0, value));
      applyMixTargets([{ deck: t.deck, name: 'deck', value: deckXfGain(t.deck) * mixState.faders[t.deck] }]);
      continue;
    }
    if (!(name in DJ_NEUTRAL)) throw new Error(`"${name}" is not a mix control`);
    if (t.deck === 'a' || t.deck === 'b') {
      mixState.perDeck[t.deck].set(name, value);
      for (const key of mixKeys()) {
        if (deckOfKey(key) === t.deck && !mixState.perTrack.get(key)?.has(name)) {
          engine.setParam(engineTrack(key), -1, name, value, 0);
        }
      }
    } else {
      const key = String(t.key ?? '');
      if (!isMixKey(key)) throw new Error(`mix/set: no playing track "${key}"`);
      let per = mixState.perTrack.get(key);
      if (!per) mixState.perTrack.set(key, (per = new Map()));
      per.set(name, value);
      engine.setParam(engineTrack(key), -1, name, value, 0);
    }
  }
  mixNotify();
}

// The desk's state as one plain object - what GET /api/mix returns (minus the track rows) and
// what the push channel below frames. One builder so the two can never drift.
// Is this deck sounding - a running pattern scheduler or its song playing? What the deck
// head's play/stop toggle reads (the browser's one `playing` flag is the whole set's).
function deckPlaying(deck) {
  return [...schedulers].some(([key, sch]) => deckOfKey(key) === deck && sch.running)
    || !!songDecks[deck]?.playing;
}

function mixDeskBody() {
  // A paused song's predicted rate depends on whether anything else is playing (songBaseRate),
  // and every start/stop builds a frame here - settle them so the strip's scale is right
  // before the frame goes out. The paused branch of songApplyRate never notifies back.
  for (const d of ['a', 'b']) if (songDecks[d] && !songDecks[d].playing) songApplyRate(d);
  return {
    swap: mixState.swap,
    // A solo whose stem has since gone (re-eval dropped it, the song unloaded) reads as none.
    solo: { a: [...mixState.solo.a].filter(isMixKey), b: [...mixState.solo.b].filter(isMixKey) },
    playing: { a: deckPlaying('a'), b: deckPlaying('b') },
    perDeck: { a: Object.fromEntries(mixState.perDeck.a), b: Object.fromEntries(mixState.perDeck.b) },
    // Never '-' for a loaded deck: an unspecified track reads as the 120 default, so the tempo
    // slider and detents always have two real endpoints to ride between.
    deckBpm: {
      a: deckNativeBpm('a'),
      b: deckNativeBpm('b'),
    },
    tempo: {
      master: transport ? transport.cps * 240 : null,
      override: mixState.tempoOverride,
    },
    xf: mixState.xf,
    faders: { ...mixState.faders },
    cue: activeCue ? { name: activeCue.name } : null,
    midi: settings.mixMidi ?? {},
    neutral: DJ_NEUTRAL,
    // The song decks (files on a deck - see the song section). The client mirrors the playhead
    // itself: posSec + (now - startSec) * rate while playing (engine time is Date.now()/1000).
    song: Object.fromEntries(['a', 'b'].map((d) => {
      const s = songDecks[d];
      return [d, s && {
        key: SONG_KEYS[d],
        path: s.path,
        title: s.title,
        duration: s.duration,
        decoded: s.decoded,
        playing: s.playing,
        rate: s.rate,
        posSec: s.posSec,
        startSec: s.startSec,
        bpm: s.bpm,
        musicalKey: s.musicalKey,
        anchorSec: s.anchorSec,
        cueSec: s.cueSec ?? 0, // the CUE gesture's home - the pane draws it on both waveforms
        sync: s.sync,
        syncMult: s.syncMult ?? 'auto',
        syncMultEffective: songOctave(d),
        master: d === songMasterDeck, // this song set the clock - its ratio is 1 by definition
        keylock: s.keylock,
        nudge: s.nudge,
        // Confidence (0..1) when a fact is a phase 5 ESTIMATE rather than a tag/typed value -
        // the pane marks these; a manual edit clears them (see /api/song/meta).
        bpmDetected: s.bpmDetected ?? null,
        keyDetected: s.keyDetected ?? null,
        gridDetected: s.gridDetected ?? null,
      }];
    })),
  };
}

// --- the desk push channel (SSE, GET /api/mix/events) ---
//
// The strip's mirror of MIDI-driven desk moves. Push, not poll: a learned knob streams CCs into
// this process at MIDI rate, and mirroring that by polling meant choosing between request
// chatter on the scheduler's event loop and a laggy knob graphic. Frames are throttled to one
// per ~30ms however fast the desk changes, and nothing at all is sent while the desk is idle -
// strictly less steady-state work than any poll. EventSource reconnects by itself, so an engine
// or server restart just resumes the stream.
const mixEventClients = new Set();

function serveMixEvents(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(mixDeskBody())}\n\n`); // the current state, immediately
  mixEventClients.add(res);
  // The deck meters live exactly as long as someone is watching the strip: first client in
  // starts the engine's two reader synths, last one out frees them.
  if (mixEventClients.size === 1) {
    try { engine?.deckMeters(true); } catch { /* engine between restarts */ }
  }
  res.on('close', () => {
    mixEventClients.delete(res);
    if (!mixEventClients.size) {
      try { engine?.deckMeters(false); } catch { /* engine between restarts */ }
    }
  });
}

// The strip's channel meter feed: latest pre-fader level per deck (max of the two channels -
// the conservative side for gain staging), framed to the same SSE clients as a NAMED event
// ('level', so the desk-state onmessage path never sees it) at most every ~40ms - the two
// decks' ~20/sec replies land as one combined frame.
const deckLevels = { a: null, b: null };
let deckLevelTimer = null;
function deckLevelNotify() {
  if (!mixEventClients.size || deckLevelTimer) return;
  deckLevelTimer = setTimeout(() => {
    deckLevelTimer = null;
    if (!mixEventClients.size) return;
    const frame = `event: level\ndata: ${JSON.stringify(deckLevels)}\n\n`;
    for (const res of mixEventClients) res.write(frame);
  }, 40);
}

let mixNotifyTimer = null;
function mixNotify() {
  if (!mixEventClients.size || mixNotifyTimer) return;
  mixNotifyTimer = setTimeout(() => {
    mixNotifyTimer = null;
    if (!mixEventClients.size) return;
    const frame = `data: ${JSON.stringify(mixDeskBody())}\n\n`;
    for (const res of mixEventClients) res.write(frame);
  }, 30);
}

// The merged desk view for one track (deck-broadcast under its own values), as a plain object:
// what a NEW track must be BORN wearing (engine.createTrack's birth args) - by the time a plain
// setParam could land, the first samples have already played.
function mixBirthFor(key) {
  const birth = {};
  for (const [name, value] of mixState.perDeck[deckOfKey(key)] ?? []) birth[name] = value;
  for (const [name, value] of mixState.perTrack.get(key) ?? []) birth[name] = value;
  // The crossfader's deck gains enter perDeck only when the fader MOVES - after eject/complete
  // (or on a fresh desk) the maps are empty while xf sits at hard-A, and a track born then
  // would wear the synthdef's deck=1: wide open on the silent side (reported 2026-08-25, a
  // deck-b song audible through a closed crossfader). Derive the gain when no gesture has.
  if (!('deck' in birth)) birth.deck = deckXfGain(deckOfKey(key)) * mixState.faders[deckOfKey(key)];
  // Which deck meter bus the synth sums its pre-fader signal into (see the scd's deckMeterBus)
  // - a birth arg like the rest, so a stem born mid-set meters from its first sample.
  birth.mdeck = deckOfKey(key) === 'b' ? 1 : 0;
  return birth;
}

// Every DJ-stage control back to neutral on one track - what complete-mix does to the promoted
// song (it is the main act now; the next mix starts from a clean desk).
function neutralizeMix(key) {
  if (!engine) return;
  const tid = engineTrack(key);
  for (const [name, value] of Object.entries(DJ_NEUTRAL)) engine.setParam(tid, -1, name, value, 0);
  // Post-mix every surviving track is the main deck: meter on the A side (a promoted deck-b
  // track's synth was born with mdeck 1).
  engine.setParam(tid, -1, 'mdeck', 0, 0);
}

// The "trackId|..."-keyed lease/capture maps, re-keyed or dropped together when a track changes
// name (promotion) or dies (eject / complete-mix). A function, not a const list: several are
// declared further down the file.
const PIPED_MAPS = () => [presetHolds, channelHolds, uncaptured, autoPinDirty, autoPinReady];

// Forget a track completely: its engine side is destroyed (plugins closed - see destroyTrack in
// sc/poptart.scd), its registry ids freed, and every server-side trace of the key dropped. Used
// by eject and complete-mix's teardown of the outgoing deck - NOT by the eval sweep, which keeps
// a dropped label's track warm for the label's return.
function dropTrack(key) {
  const id = trackIds.get(key);
  // A song track's Node-side state goes with it (the engine side - player synth, buffer - is
  // destroyTrack's; see sc/poptart.scd). Usually already cleared by songUnload; this is the net.
  for (const d of ['a', 'b']) {
    if (SONG_KEYS[d] === key && songDecks[d]) {
      if (songDecks[d].endTimer) clearTimeout(songDecks[d].endTimer);
      songDecks[d] = null;
    }
  }
  if (recTapped.has(key)) {
    recTapped.delete(key);
    if (id && engine) {
      try { engine.tapTrack(id, false); } catch { /* engine already down */ }
    }
  }
  if (id && engine) {
    try { engine.destroyTrack(id); } catch { /* engine already down */ }
  }
  if (id) trackLabels.delete(id);
  trackIds.delete(key);
  hlTracks.delete(key);
  liveHeld.delete(key);
  kbHeld.delete(key);
  mixState.perTrack.delete(key);
  const pfx = `${key}|`;
  for (const m of PIPED_MAPS()) for (const k of [...m.keys()]) if (k.startsWith(pfx)) m.delete(k);
  for (const k of [...handTaken]) if (k.startsWith(pfx)) handTaken.delete(k);
  if (conf?.trackId === key) conf = null;
}

// Promotion: everything filed under `from` answers to `to` from here on. The engine is never
// touched - the opaque-track-id payoff - so the music doesn't blink.
function rekeyTrack(from, to) {
  const id = trackIds.get(from);
  const oldId = trackIds.get(to); // a stale entry from a since-destroyed same-named track
  if (oldId) trackLabels.delete(oldId);
  trackIds.delete(from);
  if (id) {
    trackIds.set(to, id);
    trackLabels.set(id, to);
  }
  const sch = schedulers.get(from);
  if (sch) {
    schedulers.delete(from);
    schedulers.set(to, sch);
    sch.label = to; // user-facing lines say the new name; the trackId inside never changes
  }
  for (const m of [hlTracks, liveHeld, kbHeld, mixState.perTrack]) {
    const v = m.get(from);
    if (v !== undefined) {
      m.delete(from);
      m.set(to, v);
    }
  }
  if (recTapped.has(from)) {
    recTapped.delete(from);
    recTapped.add(to);
  }
  const pfx = `${from}|`;
  for (const m of PIPED_MAPS()) {
    for (const [k, v] of [...m]) {
      if (!k.startsWith(pfx)) continue;
      m.delete(k);
      const nv = v && typeof v === 'object' && 'trackId' in v ? { ...v, trackId: to } : v;
      m.set(`${to}|${k.slice(pfx.length)}`, nv);
    }
  }
  for (const k of [...handTaken]) {
    if (k.startsWith(pfx)) {
      handTaken.delete(k);
      handTaken.add(`${to}|${k.slice(pfx.length)}`);
    }
  }
  if (conf?.trackId === from) conf.trackId = to;
  if (trackRec?.label === from) trackRec.label = to;
}

// VST host-transport mirror: pushes the Transport's tempo + song position (in beats, 4 per
// cycle) into the engine, which forwards it to every open plugin as emulated DAW transport -
// what makes plugin-internal synced LFOs/delays/arpeggiators follow setbpm. Called on every
// tempo change (transport.onCpsChange), after every engine (re)start, and on a periodic timer:
// plugins advance their own transport on the audio clock between calls, so like the
// scheduler's LFO anchors, the periodic re-sync keeps ppm-level clock skew from accumulating
// into drift against the pattern grid (each correction is microseconds).
const VST_TRANSPORT_SYNC_MS = 4000;
const VST_TRANSPORT_LOOKAHEAD_SEC = 0.15; // applied engine-side at this target, like note events

function syncVstTransport() {
  if (!engine || !transport) return;
  const targetSec = engine.getTime() + VST_TRANSPORT_LOOKAHEAD_SEC;
  engine.setTempo(transport.cps * 240, transport.cycleAt(targetSec) * 4, targetSec);
}
setInterval(syncVstTransport, VST_TRANSPORT_SYNC_MS);

// Event-loop stall watchdog. The note scheduler shares this process, so any synchronous work
// that holds the loop near the 150ms lookahead is an audible stutter on EVERY playing deck -
// and in a live set that must never pass silently. 30ms resolution, logged with the overrun so
// the terminal says when it happened and how long it was; the eval timer below says whether an
// evaluation was the culprit.
{
  let lastTick = process.hrtime.bigint();
  setInterval(() => {
    const now = process.hrtime.bigint();
    const stalledMs = Number(now - lastTick) / 1e6 - 30;
    lastTick = now;
    if (stalledMs > 100) {
      // eslint-disable-next-line no-console
      console.warn(`[poptart] event loop stalled ~${Math.round(stalledMs)}ms - long enough to delay note scheduling`);
    }
  }, 30);
}

// ---------------------------------------------------------------------------------------------
// Settings - small persisted knobs (currently just the audio output device), plain JSON under
// ~/.poptart so they survive restarts and are hand-editable.
// ---------------------------------------------------------------------------------------------

const SETTINGS_FILE = process.env.POPTART_SETTINGS_FILE || path.join(os.homedir(), '.poptart', 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {}; // missing or corrupt - defaults
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

const settings = loadSettings();

// Apply the persisted sample-library folder to the engine's samples module (env var still wins
// - see samples.js). Chosen in the "settings" tab; null/absent means the default ~/.poptart/samples.
require('@poptart/osc-engine/samples').setSamplesRoot(settings.samplesDir ?? null);

// Audio devices with channel counts and UIDs, via the poptart-audio CoreAudio helper (with a
// system_profiler fallback - see audio-devices.js). Channel counts are why this isn't sclang's
// ServerOptions.outDevices: scsynth needs numOutputBusChannels at boot, and .o(n)'s
// stereo-pair wraparound has to match the hardware.
const audioDevices = require('@poptart/osc-engine/audio-devices');
const audioSelection = require('./audio-selection.js');

// Output-capable devices in the shape the settings tab and loadEngine expect. `channels` is the
// output count (what .o(n) wraps at); `inChannels` is the same device's input count, which is what
// numInputBusChannels gets sized from - scsynth opens this ONE device for both directions.
function audioOutputDevices() {
  return audioDevices.listOutputDevices().map((d) => ({
    uid: d.uid,
    name: d.name,
    channels: d.outChannels,
    inChannels: d.inChannels,
    isDefault: d.isDefaultOutput,
    isAggregate: d.isAggregate,
  }));
}

// The device-selection policy lives in audio-selection.js (pure, unit-tested); these two wire it
// to the settings and turn its warnings into log lines.
function plainOutputDevice(devices) {
  const { device, warning } = audioSelection.plainOutputDevice(
    devices, settings.audioOutputDevice ?? null, audioDevices.AGGREGATE_UID,
  );
  // eslint-disable-next-line no-console
  if (warning) console.warn(`[poptart] ${warning}`);
  return device;
}

// Which device scsynth should actually open - the plain output device, or poptart's aggregate when
// extra inputs have been combined in. Reading the aggregate's live membership is the point: an
// aggregate that has lost the device we play through is not a playback path, however happily it
// opens (see audio-selection.js).
// The cue/monitor device (the headphone out - mixing phase 7), stored as { uid, name }. It
// rides the SAME aggregate the extra input devices do - one more member, appended last so the
// main outs' channel numbers are untouched - and the cue pair's offset inside the combined
// device is read back from its layout at engine boot (see loadEngine). Changing it is a
// settings action with an engine restart, like every other device choice.
const cueDevice = () => settings.audioCueDevice ?? null;

// Everything the aggregate must contain beyond the output device: the extra inputs, in their
// saved order (input() offsets follow it), then the cue device.
function aggregateExtraUids() {
  const uids = [...(settings.audioInputDevices ?? [])];
  const cue = cueDevice();
  if (cue?.uid && !uids.includes(cue.uid)) uids.push(cue.uid);
  return uids;
}

// Make the aggregate match what is selected AND connected right now (extra inputs + cue),
// built around the current output device. The one place the member list is computed, so the
// cue device can never be forgotten by one caller and kept by another.
function syncAggregateNow() {
  const uids = aggregateExtraUids();
  const { present } = audioSelection.splitConnected(uids, audioDevices.listDevices().map((d) => d.uid));
  syncAggregate(present);
  return { uids, present };
}

function deviceToOpen(devices) {
  const inputUids = aggregateExtraUids();
  const { device, warning } = audioSelection.deviceToOpen({
    devices,
    wanted: settings.audioOutputDevice ?? null,
    inputUids,
    aggregateUid: audioDevices.AGGREGATE_UID,
    // Only worth a helper round-trip when there IS an aggregate in play.
    layout: inputUids.length ? audioDevices.deviceLayout(audioDevices.AGGREGATE_UID) : null,
  });
  // eslint-disable-next-line no-console
  if (warning) console.warn(`[poptart] ${warning}`);
  return device;
}

// The output-channel picture for the settings tab and for loadEngine: how many channels the device
// that would be opened can actually be heard on, which of those .o(n) is allowed to use, and the
// counts the tab may offer. One function so the tab can never show a choice the engine would not
// honour.
function outputChannelState(devices = audioOutputDevices()) {
  const args = {
    devices,
    wanted: settings.audioOutputDevice ?? null,
    active: deviceToOpen(devices),
    aggregateUid: audioDevices.AGGREGATE_UID,
  };
  const audible = audioSelection.audibleChannels(args);
  return {
    audible,
    channels: audioSelection.playbackChannels({ ...args, cap: settings.audioOutputChannels ?? null }),
    choices: audioSelection.outputChannelChoices(audible),
  };
}

/**
 * Make poptart's aggregate match `uids` (the extra input devices), built around whatever the
 * output device currently is - it goes in first and is the clock master. An empty list tears the
 * aggregate down. Returns the members it built, or null.
 *
 * MUTATES the machine's audio configuration, so every caller is an explicit settings action.
 */
function syncAggregate(uids) {
  if (!uids.length) {
    audioDevices.destroyAggregate();
    return null;
  }
  const out = plainOutputDevice(audioOutputDevices());
  if (!out?.uid) throw new Error('could not determine the output device to build the aggregate around');
  const members = audioSelection.aggregateMembers(out.uid, uids);
  audioDevices.rebuildAggregate(members, out.uid);
  return members;
}

// Which of the selected input devices are plugged in right now, and which aren't.
function splitSelectedInputs() {
  const uids = settings.audioInputDevices ?? [];
  return audioSelection.splitConnected(uids, audioDevices.listDevices().map((d) => d.uid));
}

// A selected device's name, remembered when it was applied - so one that is unplugged later reads
// as "EarPods" rather than as the raw CoreAudio UID, which is unreadable and, when it turned up in
// a checkbox list, unidentifiable.
function inputDeviceName(uid) {
  return settings.audioInputNames?.[uid] ?? uid;
}

/**
 * Bring the combined device back in line with what is selected AND connected, before the engine
 * opens it. This is what makes an unplugged interface a non-event: restart and the aggregate is
 * rebuilt from whatever is actually there, rather than the engine opening a stale one - or falling
 * back and leaving input() dead until somebody finds the settings tab and presses a button.
 *
 * The SELECTION is deliberately left alone. Auto-unticking would be the destructive reading of the
 * same idea: USB devices can take a second or two to enumerate after a wake, "absent right now"
 * is not "gone", and the order of that list is what input()'s channel offsets are computed from.
 * So the aggregate follows the hardware and the selection keeps the intent.
 */
function healAggregate() {
  const uids = aggregateExtraUids();
  if (!uids.length || !audioDevices.helperAvailable()) return;
  const { present } = audioSelection.splitConnected(uids, audioDevices.listDevices().map((d) => d.uid));
  const reason = audioSelection.aggregateStaleReason({
    layout: audioDevices.deviceLayout(audioDevices.AGGREGATE_UID),
    outUid: plainOutputDevice(audioOutputDevices())?.uid ?? null,
    wantUids: present,
  });
  if (!reason) return;
  try {
    syncAggregate(present);
    // eslint-disable-next-line no-console
    console.warn(`[poptart] rebuilt the combined audio device: ${reason}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] could not rebuild the combined audio device (${err.message})`);
  }
}

// What's wrong with the audio device setup right now, as { message, detail } - one line for the
// settings tab, the paragraph behind it for the console - or null. The whole reason this is
// surfaced at all: both failures are inaudible in the one way that matters, they leave the meters
// moving.
function audioDeviceWarning() {
  const uids = settings.audioInputDevices ?? [];
  if (!uids.length) return null;
  const problem = audioSelection.aggregateProblem({
    layout: audioDevices.deviceLayout(audioDevices.AGGREGATE_UID),
    outDevice: plainOutputDevice(audioOutputDevices()),
    absent: splitSelectedInputs().absent.map(inputDeviceName),
  });
  return problem ? { message: problem.message, detail: problem.detail } : null;
}

// The device scsynth actually opened, as reported by audioOutputDevices() - set by loadEngine on
// every start and read by wireEngine to tell pattern-core which input channels input() can address.
let activeAudioDevice = null;
// Non-null when the engine booted with a headphone-cue pair: { offset, name }. `offset` is the
// pair's first channel inside the combined device - what the track SynthDefs' cue send writes to.
let activeCue = null;

async function loadEngine() {
  try {
    // Before anything decides which device to open: make the combined device match reality. The
    // old scsynth is already stopped and the device released by here (see restartEngine), so this
    // is the one moment a rebuild can't collide with playback.
    healAggregate();
    const { OscEngine } = require('@poptart/osc-engine');
    // Whichever device scsynth will actually open decides how many channels exist at all, and
    // whose input channels input() addresses (wireEngine feeds the layout to pattern-core).
    const devices = audioOutputDevices();
    const active = deviceToOpen(devices);
    activeAudioDevice = active ?? null;
    // The headphone cue is real only when the aggregate is what's being opened AND the cue
    // device is actually inside it - its pair starts after every member before it. Anything
    // else (helper missing, cue unplugged, aggregate fallen back) means no cue this boot, said
    // out loud: silent headphones at a gig should never need debugging.
    activeCue = null;
    const cueWanted = cueDevice();
    if (cueWanted?.uid && active?.uid === audioDevices.AGGREGATE_UID) {
      const layout = audioDevices.deviceLayout(audioDevices.AGGREGATE_UID);
      let offset = 0;
      let found = false;
      for (const d of layout?.subDevices ?? []) {
        if (d.uid === cueWanted.uid) {
          found = true;
          break;
        }
        offset += d.outChannels ?? 0;
      }
      if (found) activeCue = { offset, name: cueWanted.name };
      else {
        // eslint-disable-next-line no-console
        console.warn(`[poptart] cue device "${cueWanted.name}" is not in the combined device - no headphone cue this boot (is it plugged in?)`);
      }
    } else if (cueWanted?.uid) {
      // eslint-disable-next-line no-console
      console.warn('[poptart] a cue device is configured but the engine is not opening the combined device - no headphone cue this boot');
    }
    // Pass the device name only when it isn't the system default: naming it pins inDevice too
    // (see poptart.scd), which is exactly what we want for a chosen device or the aggregate.
    const pinned = active && !active.isDefault ? active.name : null;
    const e = new OscEngine({
      outDevice: pinned,
      outChannels: active?.channels ?? 2,
      // What .o(n) wraps at: the channels anyone can actually hear, capped by the user's own
      // "output channels" choice - stereo unless they went looking for more (audio-selection.js).
      playChannels: audioSelection.playbackChannels({
        devices, wanted: settings.audioOutputDevice ?? null, active, aggregateUid: audioDevices.AGGREGATE_UID,
        cap: settings.audioOutputChannels ?? null,
      }),
      inChannels: active?.inChannels ?? 0,
      cueOffset: activeCue?.offset ?? null,
    });
    await e.start(48000, 256);
    engineError = null;
    return e;
  } catch (err) {
    engineError = err.message ?? String(err);
    // eslint-disable-next-line no-console
    console.error('[poptart] osc-engine failed to start:', err);
    return null;
  }
}

let engineRestarting = false;

// Tear the whole engine stack (sclang + scsynth) down and boot a fresh one - how an audio
// output device change is applied, since scsynth only picks its device at boot. Playing tracks
// are stopped rather than migrated (their synths and plugins lived in the old scsynth); the
// editor tells the user to re-evaluate.
async function restartEngine() {
  if (engineRestarting) throw new Error('an engine restart is already in progress');
  engineRestarting = true;
  try {
    for (const [label, sch] of schedulers) {
      sch.stop();
      mappedEngine?.removeChain(label);
    }
    schedulers.clear();
    // The song buffers and player synths died with the old scsynth; the deck states describe
    // sound that no longer exists. Cleared rather than reloaded - re-queuing a song after an
    // engine restart is a deliberate act, like re-evaling a pattern deck.
    for (const d of ['a', 'b']) {
      if (songDecks[d]?.endTimer) clearTimeout(songDecks[d].endTimer);
      songDecks[d] = null;
    }
    // The replacement engine has no tracks and no held notes - drop the held-key bookkeeping so
    // a stale held note isn't "released" against the new engine, and the live note log with it
    // (its times are the old clock's).
    kbHeld.clear();
    clearLiveLog();
    // Every plugin window went with the old scsynth, and so did whatever was being edited in one.
    // Left alone, these would hold slots still for windows that no longer exist and for captures
    // nothing can take any more (see the hand-editing section).
    handTaken.clear();
    uncaptured.clear();
    // The taps and any in-flight bounce died with the old scsynth. Dropping the state here is what
    // stops the editor from polling a recording that can never finish; the panel re-taps on its
    // next poll.
    if (trackRec?.timer) clearInterval(trackRec.timer);
    trackRec = null;
    // The MIDI recorder's tick reads engine.getTime() every 50ms and its window is measured in
    // cycles of a transport that is about to be frozen - neither survives the restart, so the
    // timer has to go with them. Leaving it running was a crash: it outlived the engine it was
    // ticking against and threw on a null one, in a bare interval callback with nothing to catch it.
    if (midiRec?.timer) clearInterval(midiRec.timer);
    midiRec = null;
    recTapped.clear();
    recLevels.clear();
    // The mixer's analysis synths died with the old scsynth. Flag off without sending anything
    // (there's nothing to send to); an open mixer sees on:false on its next poll and re-arms
    // itself against the fresh engine.
    mixMonitorOn = false;
    clearTimeout(mixOffTimer);
    mixOffTimer = null;
    mixLevels.clear();
    mixSpecs.clear();
    transport?.stop(); // playback is over - freeze the clock at cycle 0 until the next eval
    // Drop the shared references BEFORE the teardown, not after it. Everything that reaches for
    // `engine` outside a request - the VST transport re-sync on its 4s timer, the recorder ticks -
    // tests it for null and does nothing when it is null, and that test has to be true for the
    // WHOLE window in which the engine is unusable. Nulling these afterwards left a real one open:
    // OscEngine#stop closes its OSC port partway through, so a timer firing in the seconds between
    // that and the assignment found a non-null engine whose every send throws "OscEngine not
    // started". Thrown from a timer, that is an uncaught exception, and an uncaught exception is
    // the whole app - the crash you get for changing your audio device while something is playing.
    const dying = engine;
    engine = null;
    mappedEngine = null;
    if (dying) {
      await dying.stop();
      // Let the OS actually release the OSC UDP port and the audio device before the
      // replacement sclang/scsynth try to grab them - both frees complete asynchronously.
      await new Promise((r) => setTimeout(r, 300));
    }
    engine = await loadEngine();
    if (engine) wireEngine();
  } finally {
    engineRestarting = false;
  }
}

// ALL post-start engine wiring, shared by init() and restartEngine(). Single function on
// purpose: when these were two hand-maintained copies, onParamAutomated existed only on the
// restart path - so conf capture silently dropped every gesture on a fresh boot until the
// first audio-device change. Any new engine callback goes here and nowhere else.
function wireEngine() {
  mappedEngine = new MappedEngine(engine);
  // audio("kick")/.midi("kick") reference other tracks by label inside engine-call arguments;
  // the wrapper turns those into engine track ids on the way down (see MappedEngine._trackRef).
  // A reference from inside a deck resolves within that deck first - deck b's audio("kick")
  // means deck b's kick - then falls back to the plain label: a deliberate cross-deck
  // reference, or a name no eval has seen (passed through for the engine to shrug at).
  mappedEngine.setTrackResolver((label, callerTid) => {
    const caller = callerTid ? trackLabels.get(callerTid) : null;
    const at = caller ? caller.indexOf(':') : -1;
    if (at > 0) {
      const scoped = trackIds.get(caller.slice(0, at + 1) + label);
      if (scoped) return scoped;
    }
    return trackIds.get(label) ?? label;
  });
  // Captured plugin programs live in the blob store, not in the code (see blobs.js), so what the
  // scheduler hands the engine is usually a "@id" handle. This is the one place it is turned back
  // into a program.
  engine.setStateResolver((id) => blobs.getBlob(id));
  // Born paused at cycle 0: the clock only advances while something is playing (first eval
  // starts it, /api/stop freezes it back at 0). Survives engine restarts, hence the guard.
  if (!transport) transport = new patternCore.Transport(() => engine.getTime(), { cps: DEFAULT_CPS, paused: true });
  transport.onCpsChange = () => {
    syncVstTransport();
    // Rate-locked songs ride the clock: every ramp step re-derives rate = master/native (with
    // a model rebase, so the mirrored playhead stays exact) - see songApplyRate.
    for (const d of ['a', 'b']) if (songDecks[d]?.sync && songDecks[d]?.bpm) songApplyRate(d);
    mixNotify(); // a tempo ramp's every step reaches the strip's readout live
  };
  syncVstTransport(); // a fresh sclang needs the surviving transport's tempo, not 120
  // Live CC events (forwarded from sclang once MIDI is enabled) feed pattern-core's
  // live-value store - what a Tier-1 midicc() signal samples.
  engine.onMidiIn = (device, channel, cc, value) => {
    if (handleMixMidi(device, channel, cc, value)) return; // a desk knob is the desk's alone
    patternCore.feedMidiCC(device, channel, cc, value);
  };
  // Learned desk knobs must work without any midicc() in the song to enable MIDI for them.
  if (Object.keys(settings.mixMidi ?? {}).length) engine.enableMidi();
  // Live note edges from midikeys() routes - logged for the MIDI recorder and the roll's capture.
  engine.onMidiNoteIn = (trackId, note, vel, isOn) => handleMidiNoteIn(trackLabel(trackId), note, vel, isOn);
  // Plugin-GUI knob gestures - what conf capture writes into the code.
  engine.onParamAutomated = (trackId, slot, name, index, value) => handleParamAutomated(trackLabel(trackId), slot, name, index, value);
  // Any edit inside a plugin's own window - what auto-pin captures back into the code.
  engine.onPluginEdited = (trackId, slot) => handlePluginEdited(trackLabel(trackId), slot);
  // Peak level of a track tapped for recording - what the record panel's meter draws.
  engine.onRecLevel = (trackId, left, right) => handleRecLevel(trackLabel(trackId), left, right);
  // A song player's actual playhead, ~2/sec - the drift servo's measurement (songs phase 4).
  engine.onSongPos = handleSongPos;
  // Mixer monitoring feeds (per-track levels + band frames) - what the mixer modal draws.
  engine.onMixLevel = (key, peakL, rmsL, peakR, rmsR) => handleMixLevel(trackLabel(key), peakL, rmsL, peakR, rmsR);
  engine.onMixSpec = (key, values) => handleMixSpec(trackLabel(key), values); // "*" (master) has no label and passes through
  // The strip's channel meters (see deckLevelNotify): fold each ~20/sec reply to one
  // conservative mono figure per deck and push over the desk SSE stream.
  engine.onDeckLevel = (deck, peakL, rmsL, peakR, rmsR) => {
    deckLevels[deck === 1 ? 'b' : 'a'] = {
      p: Math.max(peakL, peakR),
      r: Math.max(rmsL, rmsR),
    };
    deckLevelNotify();
  };
  // An engine restart mid-DJ-session: the strip's SSE clients are still connected (EventSource
  // rides out the gap), so the fresh engine's readers must be re-armed here.
  if (mixEventClients.size) engine.deckMeters(true);
  // Which input channels input() can address, and what a device-relative input("name", n) resolves
  // against. Only the booted device has any, so this is re-fed on every start (a device change is
  // an engine restart) - a pattern written before the change picks up the new offsets on re-eval.
  patternCore.setAudioInputLayout(audioInputLayout());
  // A fresh engine knows no named packs; the registry (buffer + prebake) is still standing.
  syncSamplePacks();
}

// The booted device's input channels, split per subdevice when it's an aggregate - which is what
// makes input("Scarlett", 1) resolve to the right absolute channel across several interfaces. The
// order is read back from CoreAudio rather than assumed, and only ACTIVE subdevices are counted,
// since an unplugged one contributes no channels and renumbers everything after it.
function audioInputLayout() {
  if (!activeAudioDevice || !activeAudioDevice.inChannels) return [];
  const layout = audioDevices.deviceLayout(activeAudioDevice.uid);
  const subs = (layout?.subDevices ?? []).filter((d) => d.inChannels > 0);
  if (layout?.missing?.length) {
    // eslint-disable-next-line no-console
    console.warn(`[poptart] the audio device is missing ${layout.missing.length} configured `
      + 'sub-device(s) - input() channel numbers have shifted accordingly');
  }
  if (!subs.length) return [{ name: activeAudioDevice.name, inChannels: activeAudioDevice.inChannels }];
  return subs.map((d) => ({ name: d.name, inChannels: d.inChannels }));
}

async function init() {
  patternCore = await import('@poptart/pattern-core');
  extendStringPrototype(patternCore);
  // Sig#log() event lines go to the browser, not this terminal: the editor drains the queue on
  // its existing 500ms poll (see POST /api/pluginEdits) and prints each line in the in-app
  // console, which mirrors it to devtools. Livecoding happens in the browser, so that's where a
  // debug line is actually read - and the server's stdout stays a log of the server.
  patternCore.setEventLogger((line) => {
    eventLogQueue.push(line);
    if (eventLogQueue.length > EVENT_LOG_MAX) eventLogQueue.splice(0, eventLogQueue.length - EVENT_LOG_MAX);
  });
  // Userland warnings ride the same queue for the same reason: a pattern that asks for something
  // that no longer exists keeps playing (see pattern-core's "Warnings, not exceptions"), so the
  // only way the player learns about it is a line in the console they're already watching.
  patternCore.setPatternWarn((line) => {
    eventLogQueue.push(line);
    if (eventLogQueue.length > EVENT_LOG_MAX) eventLogQueue.splice(0, eventLogQueue.length - EVENT_LOG_MAX);
  });
  // First-run setup: SC detection, VSTPlugin auto-install, preflight warnings (see
  // PACKAGING.md Stage 1). Logs what it finds; never throws, never blocks the boot -
  // loadEngine()'s own diagnostics remain the backstop if something is still wrong.
  await require('@poptart/osc-engine/setup').runSetup();
  engine = await loadEngine();
  if (engine) wireEngine();
  runPrebake(); // once, after builders + transport exist and before the first eval
}

// Strudel-flavored ergonomics: let mini-notation strings be used directly as patterns in
// evaluated code - `"0 0.5 1 0.3".gte(0.5)`, `"0 3 5".add(12)`, `"200 800".range(...)`. Each
// method wraps the string in mini() and delegates. This deliberately shadows the dead Annex-B
// legacy String methods where names collide (.sub's "<sub>…</sub>" wrapper, nothing of value).
function extendStringPrototype(core) {
  const METHODS = [
    'add', 'sub', 'mul', 'div', 'mod', 'round', 'abs', 'floor', 'ceil', 'clamp',
    'gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'when', 'hold', 'seg', 'segment', 'scale', 'range', 'synth', 'fx', 'param',
    'gain', 'pan', 'o', 'vel', 'clip', 'as', 'sc',
  ];
  for (const m of METHODS) {
    Object.defineProperty(String.prototype, m, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(...args) {
        return core.mini(String(this))[m](...args);
      },
    });
  }
  builtinSigMethods = new Set(Object.getOwnPropertyNames(core.Sig.prototype));
}

// Names on Signal's prototype when the server booted - anything beyond these was added from
// userland (`Signal.prototype.co = ...`) and gets mirrored onto strings too, below.
let builtinSigMethods = null;

// Userland language extensions work on bare mini strings exactly like the built-in methods:
// after each evaluated block, any method newly added to Signal.prototype is mirrored onto
// String.prototype with the same mini()-wrapping shim - unless strings already have that name
// (never shadow a real String method like .slice()/.at()).
function syncUserStringMethods() {
  for (const m of Object.getOwnPropertyNames(patternCore.Sig.prototype)) {
    if (builtinSigMethods.has(m) || m in String.prototype) continue;
    if (typeof patternCore.Sig.prototype[m] !== 'function') continue;
    Object.defineProperty(String.prototype, m, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(...args) {
        return patternCore.mini(String(this))[m](...args);
      },
    });
  }
}

const BUILDER_NAMES = ['Signal', 'n', 'note', 'mini', 's', 'se', 'sr', 'sp', 'synth', 'sine', 'saw', 'tri', 'square', 'ramp', 'rand', 'perlin', 'lfo', 'env', 'midicc', 'midikeys', 'macro', 'choose', 'cat', 'seq', 'irand', 'midi', 'audio', 'input', 'pianoroll',
  // Every control method also as a top-level control builder - speed("-1"), begin(0.5), clip(2) -
  // so a combinator can aim at one channel of a pattern it was handed: x.mul(speed("-1")).
  'i', 'begin', 'end', 'loop', 'loopwrap', 'loopdir', 'speed', 'flip', 'stretch', 'fit', 'slice', 'attack', 'decay', 'sustain', 'release', 'vel', 'clip', 'nudge', 'swing', 'swinggrid',
  // Pure music-theory helpers (not signal builders, but handy when writing your own): note-name
  // -> MIDI, scale-degree -> MIDI, and the raw {rootMidi, intervals} of a scale name. Exposed by
  // name so a custom `Signal.prototype.chord = ...` can call them. Real in the browser prebake too
  // (see client.js), so they behave the same in patterns, setup blocks, and hotkey handlers.
  'noteToMidi', 'degreeToMidi', 'parseScaleName'];

// Builders the EDITOR writes and nobody types: the definition calls behind a drawn roll, an LFO
// shape, a captured plugin preset or a hand-picked sample pack. Bound so the buffer they are
// written into evaluates, but deliberately kept out of
// BUILDER_NAMES - which is what drives autocomplete and the docs - so the plain names `roll` and
// `shape` stay free for whatever they should mean to a person later. See the underscore in
// pattern-core: these are the editor's own calls, not part of the language.
const INTERNAL_BUILDERS = ['_roll', '_shape', '_preset', '_pack'];

// The Macros panel's knobs, pre-bound as ready-made signals: `macro1`..`macro8` in evaluated
// code are `macro(1)`..`macro(8)`, so a knob can be dropped straight into a control -
// param("Filter 1 Freq", macro1.range(200, 4000)). Built lazily: patternCore is a dynamic
// import and isn't loaded yet when this module's top level runs.
function macroSigNames() {
  return Array.from({ length: patternCore.MACRO_COUNT }, (_, i) => `macro${i + 1}`);
}

// What a `setbpm(...)` block evaluates to - lets /api/evaluate tell tempo-only blocks apart
// from actual patterns (blocks must otherwise evaluate to a Sig).
const TEMPO_BLOCK = Object.freeze({ poptartTempoBlock: true });

// setbpm is global (there's one transport), so it's a server-provided builder rather than a
// pattern-core export. Accepts a number or any signal - "120 140", sine(0.05).range(100, 160)...
function setbpm(value) {
  if (!transport) throw new Error(engineError ?? 'engine not loaded');
  transport.setBpm(typeof value === 'string' ? patternCore.mini(value) : value);
  return TEMPO_BLOCK;
}

// The setscale equivalent of TEMPO_BLOCK.
const SCALE_BLOCK = Object.freeze({ poptartScaleBlock: true });

// setscale sets the buffer's key, which every `.sc()` then reads (see pattern-core's notes.mjs).
// Global like setbpm - a patch is in one key at a time - and HOISTED by /api/evaluate below, so
// the LAST setscale in the buffer is the key the whole buffer plays in, patterns written above it
// included. That's the point: re-keying a patch mid-set is one edit wherever you make it, not an
// edit that only takes effect downwards. Like the tempo, it persists until something changes it.
function setscale(name) {
  patternCore.setGlobalScale(name);
  return SCALE_BLOCK;
}

// The builders the HOST provides (as opposed to pattern-core's), bound alongside BUILDER_NAMES in
// every evaluated block. Read out of this source by api-docs.test.js, so adding one here is what
// makes the editor's reference cover it.
// What an `arrange(...)` block evaluates to: the painted clips, which /api/evaluate applies to the
// blocks they name once every block is built (see the arrangement pass there). A plain object like
// TEMPO_BLOCK/SCALE_BLOCK so a `$: arrange()` block is a setup block, not a voice.
function arrange(str = '', opts = {}) {
  if (typeof str !== 'string') throw new Error('[arrange] arrange() takes the clip string the painter writes - double-click the arrange name to open it');
  if (!patternCore.looksLikeArrangeString(str)) throw new Error('[arrange] arrange() takes "label,lane,start,len …" clips - double-click the arrange name to paint them');
  return { poptartArrangeBlock: true, clips: patternCore.parseArrangement(str), opts: patternCore.normalizeArrangeOpts(opts) };
}

const HOST_BUILDERS = { setbpm, setscale, arrange };

// One block of editor code (see labels.mjs) -> its value, evaluated with the builders in
// scope. Evaluated via direct eval rather than wrapping the code in `return (...)` so a block
// may contain *statements*, not just one expression. eval's completion value (the last
// statement's value) is the block's result, so plain single-expression blocks behave exactly
// as before.
//
// The `label: pattern` paradigm is only for code that emits audio - a block may instead just
// declare things (`const kb = midikeys("Twister")` on an unlabeled line) and its top-level
// bindings stay visible to every block below it in the buffer. That sharing needs two tricks,
// because const/let declared inside a direct eval are scoped to that eval alone: top-level
// declarations are rewritten to `var` (which hoists into the wrapper function, where the
// harvest object literal can read it), and the harvested values are re-injected as extra
// parameters into each later block's wrapper. The typeof guard covers names the line-anchored
// regex picks up inside nested callbacks, which stay scoped there and never reach the wrapper.
// The prebake file is shared with the browser, which runs it too for its hotkeys/UI side (see
// runUserPrebake in client.js). Those browser-only calls - hotkey(), editor/repl, alert/prompt -
// have no meaning here, so we hand the evaluator harmless stubs rather than let them throw as
// ReferenceErrors. The pure utils (bjorklund/rotate/clamp) are real, since they're safe anywhere.
const PREBAKE_BROWSER_SHIMS = {
  hotkey: () => {},
  alert: () => {},
  prompt: (_msg, def) => def,
  log: (msg) => console.log(`[poptart] prebake log: ${msg}`),
  editor: new Proxy(() => '', { get: () => () => '', apply: () => '' }),
  get repl() { return this.editor; },
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  rotate: (arr, n) => {
    const len = arr.length;
    if (!len) return arr.slice();
    const k = ((n % len) + len) % len;
    return arr.slice(k).concat(arr.slice(0, k));
  },
  bjorklund: (pulses, steps) => {
    pulses = Math.max(0, Math.min(Math.floor(pulses), Math.floor(steps)));
    steps = Math.max(0, Math.floor(steps));
    if (steps === 0) return [];
    if (pulses === 0) return new Array(steps).fill(false);
    let groups = Array.from({ length: pulses }, () => [true]);
    let rem = Array.from({ length: steps - pulses }, () => [false]);
    while (rem.length > 1) {
      const n = Math.min(groups.length, rem.length);
      const ng = [], nr = [];
      for (let i = 0; i < n; i++) ng.push(groups[i].concat(rem[i]));
      if (groups.length > n) for (let i = n; i < groups.length; i++) nr.push(groups[i]);
      else for (let i = n; i < rem.length; i++) nr.push(rem[i]);
      groups = ng; rem = nr;
    }
    return groups.concat(rem).flat();
  },
};

function makeBlockEvaluator(defs = new Map(), hostBuilders = HOST_BUILDERS) {
  // defs: name -> value, accumulated down the buffer. Seeded from the prebake file so its
  // top-level bindings are in scope for every user block too (see runPrebake).
  const evalBlock = function evalBlock(code, locBase) {
    const declNames = [
      ...new Set([...code.matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])),
    ];
    // Playback-highlight source locations: when a document offset is given (a real editor block),
    // wrap pattern-position string literals in mini("…", ABS_OFFSET) so the emitted steps carry
    // document-absolute atom spans (see pattern-core/locations.mjs). Prebake/def blocks pass no
    // base and stay untagged. The wrapping only touches string literals inside expressions, so the
    // decl-name harvest above and the const/let->var rewrite below are unaffected.
    const located = typeof locBase === 'number' ? patternCore.injectLocations(code, locBase) : code;
    const body = located.replace(/^([ \t]*)(?:const|let)(\s+)/gm, '$1var$2');
    const macroNames = macroSigNames();
    const baseNames = [...BUILDER_NAMES, ...INTERNAL_BUILDERS, ...macroNames, ...Object.keys(hostBuilders)].filter((n) => !defs.has(n)); // defs may shadow builders
    const baseValues = baseNames.map((n) => {
      if (n in hostBuilders) return hostBuilders[n];
      if (macroNames.includes(n)) return patternCore.macro(Number(n.slice(5)));
      return patternCore[n];
    });
    // Browser-only userland API stubs, minus anything a builder or a user def already provides.
    const shimNames = Object.keys(PREBAKE_BROWSER_SHIMS).filter((n) => !defs.has(n) && !baseNames.includes(n));
    const shimValues = shimNames.map((n) => PREBAKE_BROWSER_SHIMS[n]);
    const harvest = declNames
      .map((n) => `${JSON.stringify(n)}: (typeof ${n} === 'undefined' ? undefined : ${n})`)
      .join(', ');
    // eslint-disable-next-line no-new-func
    const build = new Function(
      ...baseNames,
      ...shimNames,
      ...defs.keys(),
      '__blockCode',
      `var __value = eval(__blockCode); return { __value: __value, __defs: { ${harvest} } };`,
    );
    const { __value, __defs } = build(...baseValues, ...shimValues, ...defs.values(), body);
    for (const [n, v] of Object.entries(__defs)) if (v !== undefined) defs.set(n, v);
    syncUserStringMethods(); // the block may have extended Signal.prototype - strings follow
    return __value;
  };
  evalBlock.defs = defs;
  return evalBlock;
}

// ---------------------------------------------------------------------------------------------
// Prebake - a user-owned setup file (plus an optional prebake/ folder of files) evaluated once
// at load, before any pattern is played. It's for the setup you'd otherwise paste into every
// buffer: personal helpers, custom scales, Signal.prototype extensions. Plain .js under
// ~/.poptart so it's hand-editable like settings.json and the patterns folder.
//
// Blocks run as setup - their values are ignored (nothing auto-plays and the engine needn't even
// be up). What persists is the same two things a `$:` setup block leaves behind: Signal.prototype
// mutations (global) and top-level const/let/var bindings, which are harvested into prebakeDefs
// and seeded into every later /api/evaluate so `const kick = s("bd*4")` in prebake is usable by
// name in any pattern.
// ---------------------------------------------------------------------------------------------

const PREBAKE_FILE = process.env.POPTART_PREBAKE_FILE || path.join(os.homedir(), '.poptart', 'prebake.js');
const PREBAKE_DIR = process.env.POPTART_PREBAKE_DIR || path.join(os.homedir(), '.poptart', 'prebake');

let prebakeDefs = new Map(); // top-level bindings from the prebake sources, injected into every eval

// The prebake sources in run order: prebake.js first, then prebake/*.js by filename. Later files
// see earlier files' bindings (they share one evaluator), so numbered files impose an order.
function prebakeSources() {
  const sources = [];
  try {
    const code = fs.readFileSync(PREBAKE_FILE, 'utf8');
    if (code.trim()) sources.push({ name: 'prebake.js', code });
  } catch { /* no single-file prebake - fine */ }
  let names = [];
  try {
    names = fs.readdirSync(PREBAKE_DIR).filter((f) => f.endsWith('.js')).sort((a, b) => a.localeCompare(b));
  } catch { /* no prebake/ folder - fine */ }
  for (const f of names) {
    try {
      const code = fs.readFileSync(path.join(PREBAKE_DIR, f), 'utf8');
      if (code.trim()) sources.push({ name: `prebake/${f}`, code });
    } catch { /* unreadable entry - skip it */ }
  }
  return sources;
}

// Runs (or re-runs) all prebake sources into a fresh evaluator, replacing prebakeDefs with the
// result. Called once at startup and again whenever the browser saves the file, so an edit takes
// effect without a restart. Returns the list of per-block error messages (empty on success) for
// the save endpoint to hand back to the editor; a broken prebake never throws or blocks startup.
function runPrebake() {
  const sources = prebakeSources();
  const errors = [];
  const evalBlock = makeBlockEvaluator();
  // roll() definitions from prebake are a library shared by every patch, so they go to their own
  // layer: a buffer evaluation clears only its own rolls and leaves these standing. Re-running
  // prebake (the browser saved the file) replaces the layer wholesale, the same as prebakeDefs.
  patternCore.setRollLayer('prebake');
  patternCore.clearRolls('prebake');
  try {
    for (const src of sources) {
      for (const b of patternCore.splitLabeledBlocks(src.code)) {
        try {
          evalBlock(b.code); // value ignored - prebake is setup, not a track
        } catch (err) {
          const where = b.label && !b.label.startsWith('$') ? ` (${b.label})` : '';
          const msg = `${src.name}${where}: ${err.message ?? err}`;
          errors.push(msg);
          console.error(`[poptart] prebake ${msg}`);
        }
      }
    }
  } finally {
    patternCore.setRollLayer('buffer');
  }
  prebakeDefs = evalBlock.defs; // replaces the previous set - a cleared prebake clears its defs
  if (sources.length) {
    const defs = prebakeDefs.size ? `; defs: ${[...prebakeDefs.keys()].join(', ')}` : '';
    console.log(`[poptart] prebake ran ${sources.length} file(s)${defs}`);
  }
  syncSamplePacks(); // a _pack() in prebake is a library pack - the engine has to know its files
  // The prototype-collision baseline (see noteProtoOwnership): what Sig.prototype owns after
  // prebake - built-ins plus the prebake library - is nobody's; only what a buffer adds beyond
  // this is deck-attributable. Recaptured on every prebake re-run.
  protoBaseline = new Set(Object.getOwnPropertyNames(patternCore.Sig.prototype));
  return errors;
}

// The named sample packs (sp(), from _pack() definitions in the buffer or prebake), pushed to the
// engine wholesale. The registry is pattern-core's and the files are the engine's, and this is the
// one place they meet: after every evaluation, after prebake runs, and when an engine comes up
// (a fresh engine starts empty). Wholesale, so a pack whose definition went away is forgotten too.
function syncSamplePacks() {
  if (!engine || !patternCore || typeof engine.defineSamplePacks !== 'function') return;
  const defs = {};
  for (const { id } of patternCore.packIds()) defs[id] = patternCore.lookupPack(id)?.files ?? [];
  engine.defineSamplePacks(defs);
}

// The ★ library: definitions pinned from the editor, one per line in ~/.poptart/prebake/pinned.js
// (see pinned-defs.js). A prebake source like any other - runPrebake picks it up - so a pinned
// roll/shape/preset/pack is a library name in every project. The editor asks for the list to draw
// its stars and to know when a buffer definition has drifted from its pinned copy.
const PINNED_FILE = path.join(PREBAKE_DIR, 'pinned.js');

function readPinnedFile() {
  try {
    return fs.readFileSync(PINNED_FILE, 'utf8');
  } catch {
    return '';
  }
}

function pinnedList() {
  return pinnedDefs.parsePinned(readPinnedFile()).map(({ kind, id, scope, code }) => ({ kind, id, scope, code }));
}

function writePinnedFile(text) {
  fs.mkdirSync(PREBAKE_DIR, { recursive: true });
  fs.writeFileSync(PINNED_FILE, text, 'utf8');
}

/**
 * A definition written back out of the live registry, for a library name whose SOURCE is nowhere to
 * be found - a prebake file that builds its definitions in a loop, say. Only for the kinds a
 * registry entry says everything about: a shape is its points, a preset is its plugin and its
 * program, a pack is its files. A roll's entry is a Sig, which is a pattern rather than the note
 * string it was drawn from, so there is nothing faithful to write - that one answers null and the
 * save dialog says the name couldn't be carried.
 */
function rebuildDef(kind, id, scope) {
  const line = (call, ...args) => ({ kind, id, scope, code: `${call}(${args.map((a) => JSON.stringify(a)).join(', ')})` });
  if (kind === 'shape') {
    const points = patternCore.lookupShape(id);
    return points ? line('_shape', id, patternCore.serializeShapePoints(points)) : null;
  }
  if (kind === 'preset') {
    const entry = patternCore.lookupPreset(id, scope || null);
    return entry ? { ...line('_preset', id, entry.plugin ?? '', entry.state ?? ''), scope: entry.plugin ?? '' } : null;
  }
  if (kind === 'pack') {
    const entry = patternCore.lookupPack(id);
    if (!entry) return null;
    const files = (entry.files ?? []).map(String);
    return { kind, id, scope, code: `_pack(${JSON.stringify(id)}, ${JSON.stringify(files)})` };
  }
  return null;
}

// The single ~/.poptart/prebake.js file, read for the browser's prebake editor ('' if missing).
// The optional prebake/ folder is a disk-only power feature, so only this file is edited in-app.
function readPrebakeFile() {
  try {
    return fs.readFileSync(PREBAKE_FILE, 'utf8');
  } catch {
    return '';
  }
}

// Patterns evaluate lazily, so a bad value ("badnote" where a note name should be, a throwing
// signal) can first surface mid-playback rather than at eval. Force the first few cycles (and
// one continuous sample) here so those errors come back as an eval error the editor shows,
// instead of hitting the scheduler's timer. A few cycles because alternations (`<a b c>`) only
// visit each branch every N cycles - this catches the common cases, and the scheduler's own
// try/catch stops just the offending track for anything pathological beyond that.
const DRY_RUN_CYCLES = 8;

// Every signal a track carries that can hold a mini-notation pattern: the note/value pattern
// itself, plus each param modulation (.param), channel-strip control (.gain/.pan/.o/.dry), the
// velocity signal (.vel), and each sampler config (.i/.speed/…). LFO/env/constant controls have
// no step grid and fall out where callers check `.stepsForCycle`. Shared by the eval-time dry run
// and the highlight grid so BOTH see the whole track, not just its note pattern.
function patternSigs(sig) {
  // Sampler config and note channels are NOT listed: a patterned one is cross-merged into the
  // main grid at build time (structure + locs union, see pattern-core crossMerge), so the main
  // sig already lights them - and for a per-position control (choose) the config sig's own grid
  // only knows the phase-0 pick, which would wrongly light one option for the whole cycle.
  // A patterned lfo("<a b>") lights up too: the modulator itself has no step grid, but the shape
  // NAMES do - that pattern is what says which shape is running, and it is the thing on screen.
  // A .preset("<a b>") is the same case one level up: the names are a step pattern of their own,
  // and lighting them is what lets the preset panel open on the one you can hear.
  //
  // A slot the editor is HOLDING (the preset panel, or a plugin window open on it) is not playing
  // those names - but that is NOT decided here. A grid is computed in windows of many cycles and
  // shipped ahead of the sound, while a hold is taken and released between two of them, so a grid
  // with the hold baked in is wrong the moment the hold changes: it went on lighting names after a
  // hold was taken, and left them dark after one was dropped, until the next evaluation rebuilt it.
  // The grid says what the pattern says; the editor is told what is held on the poll it already
  // runs and suppresses those spans live. See client.js's syncHeldPresets.
  //
  // A modulator's signal-valued .range() bounds light up the same way: `sine(1).range("200 300",
  // 4000)` is native engine-side, but the "200 300" is a step pattern of its own that the scheduler
  // polls to move the running LFO's floor - it is what says where the sweep sits, and it is on
  // screen. Numeric bounds have nothing to light and are skipped.
  const presets = Object.values(sig.presetPatterns ?? {});
  const params = Object.values(sig.paramSignals).map((e) => e.sig);
  return [sig, ...params, ...Object.values(sig.channel), ...presets]
    .flatMap((s) => {
      const ir = s?.lfoIR ?? s?.envIR ?? s?.ccIR;
      if (!ir) return [s];
      const bounds = [ir.min, ir.max].filter((b) => b && typeof b === 'object');
      return [s, ...(ir.shapePattern ? [ir.shapePattern] : []), ...bounds];
    });
}

// What the editor's track row lists after "modulating:". A chain can carry the same parameter
// name on two different plugins, so a name that appears more than once is qualified with the
// plugin it belongs to - "Decapitator Mix, FilterFreak2 Mix" rather than "Mix, Mix". The common
// case (one Mix) stays the bare name.
function paramLabels(sig) {
  const entries = Object.values(sig.paramSignals ?? {});
  const chain = [sig.instrument, ...(sig.fxChain ?? [])];
  const seen = new Map();
  for (const e of entries) seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  return entries.map((e) => (seen.get(e.name) > 1 && chain[e.slot] ? `${chain[e.slot]} ${e.name}` : e.name));
}

function dryRunPattern(sig) {
  const cps = transport?.cps ?? DEFAULT_CPS;
  const sigs = patternSigs(sig);
  for (const s of sigs) {
    if (s.stepsForCycle) {
      for (let cycle = 0; cycle < DRY_RUN_CYCLES; cycle++) s.stepsForCycle(cycle);
    }
    s.sample(0, cps, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Playback-highlight grid. The browser highlights the atom currently sounding by reading the
// SAME step grid the scheduler plays - so any transform in the method chain (.fast/.slow/.when/
// degrade/…) is reflected exactly, instead of the browser re-guessing from the source text. The
// server (which holds the real evaluated Sig) computes, per active track, the sounding steps for
// a window of cycles, each step tagged with its document-absolute atom spans (`locs`), converted
// to block-relative offsets the client anchors at the track's start position. Deterministic per
// cycle, so a later window can be re-requested identically via /api/highlight.
// ---------------------------------------------------------------------------------------------

const HL_WINDOW = 32; // cycles of grid shipped per track (initial window and each top-up)

const hlTracks = new Map(); // label -> { sig, start, end } for the last eval's active tracks

// The sounding steps of a track for cycles [from, from+count), each as { start, end, cont?, locs }.
// Every pattern signal on the track contributes (see patternSigs), so a `.param("x","0 1")` /
// `.gain("1 0.5")` / `.speed("<1 2>")` modulation highlights just like the note pattern. `locs` are
// the step's source spans (see pattern-core stepLocs), kept only where they fall inside the block's
// own [start,end] document range - so a location that rode in from a prebake-defined pattern or a
// dynamic string (which the client can't place in this block) is dropped - then rebased to
// block-relative. Steps that end up with no in-range span are omitted (they light nothing).
function highlightGrid(sig, start, end, from, count) {
  const sigs = patternSigs(sig).filter((s) => s.stepsForCycle);
  const grid = [];
  const base = Math.max(0, from);
  for (let c = base; c < base + count; c++) {
    const out = [];
    const gates = [];
    for (const sub of sigs) {
      let steps;
      try {
        steps = sub.stepsForCycle(c);
      } catch {
        continue;
      }
      for (const s of steps) {
        if (s.value == null) continue;
        const at = c + s.start;
        // Where the onset is HEARD - nudge/swing move the sound (see below), and everything that
        // fires off a note fires off the shifted one.
        const startShift = patternCore.timeShift(s, sub.noteChannels, at, 1, at);
        // The track's note gates: every onset the engine will actually play, on the same test the
        // scheduler uses (_scheduleNoteEdges - a rest or a tie is not one). Note-gated lfo() modes
        // reset their phase on these (poptart.scd's noteOn/playSample gate every lfo on the
        // track), so the shape editor's playhead has nothing to draw without them. Only the
        // track's OWN sig carries them: its control patterns are already cross-merged into it, and
        // a param's step grid is not a trigger of anything. Kept whether or not the step lights an
        // atom - a note whose source is out of this block still gates the modulator.
        if (sub === sig && !s.cont) gates.push(s.start + startShift);
        const locs = patternCore
          .stepLocs(s)
          .filter((l) => l[0] >= start && l[1] <= end)
          .map((l) => [l[0] - start, l[1] - start]);
        // A lit atom stays lit for as long as its note SOUNDS, so clip is applied here exactly as
        // the scheduler applies it when placing the noteOff (see pattern-core soundingEnd) - the
        // highlighter is just another emitter of the same event. Same for nudge/swing (timeShift):
        // the highlight follows the EAR, lighting up when the note is heard rather than where it
        // sits on the grid, so a swung hat flashes with the sound and not a moment before it.
        if (locs.length) {
          const soundsTo = patternCore.soundingEnd(s, sub.noteChannels, at, 1, at);
          // Both edges are warped at their own positions, exactly as the scheduler warps them (see
          // endEdgeStep), so a swung flash starts and stops with the sound it belongs to.
          const endAt = c + soundsTo;
          const endStep = patternCore.endEdgeStep(s, endAt - Math.floor(endAt));
          const endShift = patternCore.timeShift(endStep, sub.noteChannels, endAt, 1, endAt);
          out.push({ start: s.start + startShift, end: soundsTo + endShift, ...(s.cont ? { cont: true } : {}), locs });
        }
      }
    }
    grid.push({ cycle: c, steps: out, ...(gates.length ? { gates: gates.sort((a, b) => a - b) } : {}) });
  }
  return grid;
}

// The cycle the transport is on right now (0 while paused / just after a stop). The highlight
// window starts here so a running clock gets the cycles it's about to play, not cycle 0.
function currentGridCycle() {
  if (!transport) return 0;
  return Math.max(0, Math.floor(transport.cycleAt(transport.getTime())));
}

// Pattern files - named saves and work-in-progress sessions under ~/.poptart/patterns, plus the
// metadata (`@title`/`@by`/`@tags`) the files tab lists and searches on. All the filesystem work
// lives in pattern-files.js / public/pattern-meta.js; the routes below are the HTTP face of it.
const {
  PATTERNS_DIR,
  WIP_DIR,
  patternFilePath,
  wipFilePath,
  listSavedPatterns,
  listWipPatterns,
  wipOlderThan,
  pruneWipSessions,
  readLibrary,
  writeLibrary,
} = require('./pattern-files');
const { matchesQuery } = require('./public/pattern-meta.js');

// ---------------------------------------------------------------------------------------------
// Live notes - every note edge played by hand on a track, kept for a while.
//
// Two sources, one log: sclang forwards each note edge of an active midikeys() route as
// /poptart/midiNoteIn (see poptart.scd's midiRoute handlers), and the browser POSTs the computer
// keyboard's key edges to /api/keyNote (the piano roll's ⌨ button). Both land in handleMidiNoteIn,
// which pairs a note-on with its note-off and files the completed event - absolute cycle start
// and end, velocity, the pitch, and the sample index when the key was struck on an index roll -
// under the track. The log is ALWAYS on while the engine runs, which is what makes the roll's
// capture button possible: "what did I just play" is a question about the last minute, asked
// after the fact, and the recorder proper (below) is just a window cut out of the same log. It is
// trimmed to the last LIVE_LOG_CYCLES cycles of each track and thrown away when the clock resets
// (stop, engine restart), since its times are the transport's own count and mean nothing across a
// reset. The browser owns turning events into roll notes (pattern-core's record.mjs, served to it),
// because the roll is in the code buffer, which only the editor can see.
// ---------------------------------------------------------------------------------------------

const PHRASE_CYCLES = 4;
const LIVE_LOG_CYCLES = 64; // how far back the log reaches, per track
const LIVE_LOG_MAX = 4096; // ...and a hard cap on events per track, whatever the tempo

const liveLog = new Map(); // trackId -> [{ note, vel, start, end, index? }], completed events, oldest first
const liveHeld = new Map(); // trackId -> Map<note, [{ note, vel, start, index? }]> - notes down right now

function clearLiveLog() {
  liveLog.clear();
  liveHeld.clear();
}

// Keys the browser has down on each track via /api/keyNote, so a stop or an engine restart can
// release them instead of leaving a note stuck on. (The live log's own held map is about LOGGING
// - it also sees midikeys() notes, which sclang releases itself.)
const kbHeld = new Map(); // trackId -> Map<liveKey, { note, index }>

// Send note-offs for every key still held on a track and forget them (stop, restart).
function releaseKbNotes(trackId) {
  const held = kbHeld.get(trackId);
  if (held && engine) {
    const now = engine.getTime();
    const tid = engineTrack(trackId);
    for (const { note, index } of held.values()) {
      engine.noteOff(tid, note, now);
      handleMidiNoteIn(trackId, note, 0, false, index); // close its logged event too
    }
  }
  kbHeld.delete(trackId);
}

// One live note edge. Held notes wait per track+key (a stack, so fast retriggers of the same key
// pair up correctly) until their note-off completes the event. The key is the note, and the index
// with it when there is one: index-roll keys all strike the same default pitch, and two of them down
// together must not close each other's events.
const liveKey = (note, index) => (Number.isFinite(index) ? `${note}:${Math.max(0, Math.round(index))}` : String(note));

function handleMidiNoteIn(trackId, note, vel, isOn, index = null) {
  if (!engine || !transport) return;
  const now = transport.cycleAt(engine.getTime());
  const key = liveKey(note, index);
  if (isOn && vel > 0) {
    let held = liveHeld.get(trackId);
    if (!held) liveHeld.set(trackId, (held = new Map()));
    let stack = held.get(key);
    if (!stack) held.set(key, (stack = []));
    const ev = { note, vel, start: now };
    if (Number.isFinite(index)) ev.index = Math.max(0, Math.round(index));
    stack.push(ev);
  } else {
    const ev = liveHeld.get(trackId)?.get(key)?.pop();
    if (!ev) return; // off for a note that was never logged on (or the log was cleared under it)
    pushLiveEvent(trackId, { ...ev, end: Math.max(ev.start + 1e-3, now) });
  }
}

function pushLiveEvent(trackId, ev) {
  let list = liveLog.get(trackId);
  if (!list) liveLog.set(trackId, (list = []));
  list.push(ev);
  // Trim by age and by count - from the front, where the oldest sit.
  const horizon = ev.end - LIVE_LOG_CYCLES;
  let drop = 0;
  while (drop < list.length && (list[drop].end < horizon || list.length - drop > LIVE_LOG_MAX)) drop++;
  if (drop) list.splice(0, drop);
}

// A track's log plus its still-held notes closed at `now` - what a capture reads, and what the
// recorder's live view shows. Events from `since` on (by start) when given.
function liveEventsFor(trackId, since = -Infinity, now = null) {
  const out = (liveLog.get(trackId) ?? []).filter((ev) => ev.start >= since);
  const held = liveHeld.get(trackId);
  if (held && now != null) {
    for (const stack of held.values()) {
      for (const ev of stack) if (ev.start >= since) out.push({ ...ev, end: Math.max(ev.start + 1e-3, now), held: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// MIDI record - a window cut out of the live log. Arming notes the cycle (armCycle), the window
// opens at the next phrase boundary (the wait is the count-in - watch the circles; see
// recordStartCycle for how longer power-of-two takes align to themselves) and closes `cycles`
// later. Status carries everything played since arming, count-in included, so the editor can draw
// the take into the open roll as it happens; on 'done' it hands over the same events, closed, and
// the editor writes each track's into its roll (see client.js applyRecording).
// ---------------------------------------------------------------------------------------------

let midiRec = null; // { phase: 'armed'|'recording'|'done', armCycle, startCycle, endCycle, cycles, grid, results, timer }

function midiRecStatus() {
  if (!midiRec) return { phase: 'idle' };
  const { phase, armCycle, startCycle, endCycle, cycles, grid, results } = midiRec;
  const body = { phase, armCycle, startCycle, endCycle, cycles, grid, results, transport: transport.snapshot() };
  if (phase !== 'done') {
    // The take so far, per track - completed events and the keys still down, closed at now.
    const now = transport.cycleAt(engine.getTime());
    body.now = now;
    body.events = liveTakes(armCycle, now);
  }
  return body;
}

// Every track's events from `since`, held ones closed at `now`: { label: events }.
function liveTakes(since, now) {
  const out = {};
  const ids = new Set([...liveLog.keys(), ...liveHeld.keys()]);
  for (const id of ids) {
    const evs = liveEventsFor(id, since, now);
    if (evs.length) out[id] = evs;
  }
  return out;
}

function midiRecTick() {
  if (!midiRec || midiRec.phase === 'done') return;
  const pos = transport.cycleAt(engine.getTime());
  if (midiRec.phase === 'armed' && pos >= midiRec.startCycle) midiRec.phase = 'recording';
  // Small overshoot so a note-off landing right on the end boundary completes its event first.
  if (pos >= midiRec.endCycle + 0.02) finalizeMidiRec();
}

function finalizeMidiRec() {
  clearInterval(midiRec.timer);
  midiRec.timer = null;
  // Keys still held when the window closes are taken as ringing to its end; the log itself keeps
  // them open until the key comes up, so a later capture still sees the whole note.
  const takes = liveTakes(midiRec.armCycle, midiRec.endCycle);
  const results = [];
  for (const [label, events] of Object.entries(takes)) {
    const inWindow = events
      .filter((ev) => ev.start < midiRec.endCycle)
      .map((ev) => ({ ...ev, end: Math.min(midiRec.endCycle, ev.end) }));
    if (inWindow.length) results.push({ label, events: inWindow });
  }
  midiRec.results = results;
  midiRec.phase = 'done';
}

// ---------------------------------------------------------------------------------------------
// Track record - bounce one labeled block's audio to a file it can then play back with sr().
//
// Same shape as the MIDI recorder above (arm at the next phrase boundary, poll for status, write
// the result into the code), but the payload is audio and the window's edges are decided by the
// audio clock rather than by this timer: engine.recordTrack schedules them as timestamped bundles,
// so the file's length is sample-exact whatever the event loop is doing.
//
// What lands on disk is wider than the window - [pre-roll][window][post-roll] - because freeing a
// DiskOut synth drops whatever is still in its realtime buffer. The post-roll covers that buffer
// and carries the release tail; trimRecording (wav.js, run on the analysis worker because it
// rewrites the whole capture) cuts the exact window back out, and only then does the take get a
// name and a home under ~/.poptart/recordings.
// ---------------------------------------------------------------------------------------------

// Insurance either side of the window. The pre-roll absorbs any rounding between this clock and
// the audio one; the post-roll MUST exceed DiskOut's buffer (65536 frames, ~1.4s at 48k) or the
// window's own last moments are what gets dropped.
const REC_PRE_ROLL_SEC = 0.25;
const REC_POST_ROLL_SEC = 3;
// A recording has to be armed far enough ahead that its pre-roll still lies in the future; when
// the next phrase is closer than this, arm for the one after it instead.
const REC_MIN_LEAD_SEC = REC_PRE_ROLL_SEC + 0.3;

let trackRec = null; // { phase: 'armed'|'recording'|'done', label, cycles, startCycle, endCycle, name, wrapTail, capture, result, error, timer }
const recTapped = new Set(); // labels currently tapped (a record panel is open on them)
const recLevels = new Map(); // label -> { peak, at } - latest meter reading, for the panel

// The engine meters ~20x/sec but the panel polls at ~10 - so readings QUEUE rather than overwrite,
// and a poll drains the lot. Throwing away every other reading would halve the live waveform's
// resolution and lose whichever transients landed in the gaps. Capped so a panel left open with
// nothing polling it can't grow without bound.
const REC_LEVEL_QUEUE_MAX = 64;

function handleRecLevel(trackId, peak, rms) {
  let queue = recLevels.get(trackId);
  if (!queue) recLevels.set(trackId, (queue = []));
  queue.push({ peak, rms, at: Date.now() });
  while (queue.length > REC_LEVEL_QUEUE_MAX) queue.shift();
}

// Drain every meter reading for one track since the last poll, oldest first, and clear the queue.
// Empty means the engine has stopped reporting (tap dropped, engine restarted) - the panel draws
// silence rather than freezing at whatever it last said.
function recLevelsOf(label) {
  const queue = recLevels.get(label);
  if (!queue?.length) return [];
  const cutoff = Date.now() - 1000;
  const out = queue.filter((r) => r.at >= cutoff).map((r) => ({ peak: r.peak, rms: r.rms }));
  queue.length = 0;
  return out;
}

// `levels` covers every tapped track, not just a recording one: an open panel meters its block
// from the moment it opens, which is most of what makes the panel worth opening. Each entry is
// every reading since the last poll, oldest first. Recording state rides alongside and is simply
// absent when nothing is armed.
function trackRecStatus() {
  const levels = Object.fromEntries([...recTapped].map((label) => [label, recLevelsOf(label)]));
  if (!trackRec) {
    return { phase: 'idle', tapped: [...recTapped], levels, transport: transport?.snapshot() };
  }
  const { phase, label, cycles, startCycle, endCycle, name, result, error } = trackRec;
  return {
    phase,
    label,
    cycles,
    startCycle,
    endCycle,
    name,
    result,
    error,
    tapped: [...recTapped],
    // A recording keeps its own tap even with the panel closed, so its readings may not be in
    // `levels` yet - drain them too.
    levels: recTapped.has(label) ? levels : { ...levels, [label]: recLevelsOf(label) },
    transport: transport.snapshot(),
  };
}

/** Open or close a track's meter tap - what the record panel being open costs. */
function setRecTap(label, on) {
  if (!engine) throw new Error(engineError ?? 'engine not loaded');
  if (on) recTapped.add(label);
  else if (trackRec?.label !== label) recTapped.delete(label); // a running bounce keeps its own tap
  else return; // don't pull the tap out from under a recording
  engine.tapTrack(engineTrack(label), on);
  if (!on) recLevels.delete(label);
}

function trackRecTick() {
  if (!trackRec || trackRec.phase === 'done') return;
  const pos = transport.cycleAt(engine.getTime());
  if (trackRec.phase === 'armed' && pos >= trackRec.startCycle) trackRec.phase = 'recording';
}

// The engine has closed the capture file: cut the window out of it, file it under a name nothing
// else has used, and hand the editor what it needs to write the sr() call. `wrote` is the engine's
// own report of what reached the disk ({ frames }), which is what tells an empty capture apart
// from an unreadable one.
// The trim itself runs on the analysis worker (it reads and rewrites the whole capture, which is
// seconds of audio and well over the scheduler's lookahead), so this is async and the bounce stays
// in phase 'recording' until it lands - which is exactly what the editor's status poll expects.
async function finalizeTrackRec(wrote = {}) {
  const rec = trackRec;
  clearInterval(rec.timer);
  rec.timer = null;
  try {
    if (wrote.frames === 0) {
      throw new Error(
        `the engine recorded nothing from "${rec.label}" - the track's recorder tap never carried audio ` +
        '(is the block still playing, and not soloed away?)',
      );
    }
    const name = recordings.mintName(rec.name || rec.label);
    const dest = recordings.newRecordingFile(name);
    const info = await analysis.trimRecording(rec.capture, dest, {
      startSec: REC_PRE_ROLL_SEC,
      lengthSec: rec.endSec - rec.startSec,
      wrapTail: rec.wrapTail,
    });
    if (!info) throw new Error(`couldn't read the capture the engine wrote (${rec.capture})`);
    rec.result = { name, file: dest, cycles: rec.cycles, ...info };
  } catch (err) {
    rec.error = err.message ?? String(err);
    console.error(`[poptart] track record (${rec.label}): ${rec.error}`);
  }
  // A failed capture is LEFT on disk: it's the only evidence of what went wrong, and the path is
  // in the error message. A good one has been trimmed into the recordings folder and is just a
  // temp file at this point.
  if (!rec.error) {
    try {
      fs.unlinkSync(rec.capture);
    } catch {
      // already gone - nothing to clean up
    }
  }
  rec.phase = 'done';
}

// Drop a recording's engine-side tap unless a panel is still open on that track.
function releaseRecTap(label) {
  if (recTapped.has(label)) return;
  try {
    engine.tapTrack(engineTrack(label), false);
  } catch {
    // engine already down - the tap went with it
  }
  recLevels.delete(label);
}

// ---------------------------------------------------------------------------------------------
// Global mixer monitoring - what the editor's mixer modal (ctrl+g) polls. While on, the engine
// taps every live track plus the master bus (see engine.mixMeters) and streams two feeds back:
// peak/RMS levels for the strips' meters, and per-band L/R amplitudes serving both the spectrum
// and the stereo-field display. The mixer's WRITES don't come through here at all - a fader edits
// the code (`.gain(x)` on the block) and re-evaluates, so the buffer stays the source of truth.
// ---------------------------------------------------------------------------------------------

let mixMonitorOn = false;
let mixOffTimer = null; // re-armed by every status poll; firing means the mixer went away
const mixLevels = new Map(); // key -> queued { peakL, rmsL, peakR, rmsR, at } ('*' = master bus)
const mixSpecs = new Map(); // key -> latest band frame [[l, r], ...] in mixBandFreqs() order

// Same queue-don't-overwrite reasoning as the record panel's meter (see REC_LEVEL_QUEUE_MAX).
const MIX_LEVEL_QUEUE_MAX = 64;
// Polls arrive ~10x/sec from an open mixer; a few missed beats is a hidden tab, not a gap.
const MIX_AUTO_OFF_MS = 4000;

function handleMixLevel(key, peakL, rmsL, peakR, rmsR) {
  let queue = mixLevels.get(key);
  if (!queue) mixLevels.set(key, (queue = []));
  queue.push({ peakL, rmsL, peakR, rmsR, at: Date.now() });
  while (queue.length > MIX_LEVEL_QUEUE_MAX) queue.shift();
}

// A band frame arrives flat; the client wants it per band. The stride is the engine's to state
// (see OscEngine#mixSpecStride) so adding a measured value per band stays a one-file change.
//
// Rounded on the way in, because these are JSON'd to the browser ten times a second and a raw
// float spells itself out as seventeen digits: at 96 bands x 4 values x 9 sources that was a
// 140KB poll (1.4MB/s) of which nearly all was decimal places no display could use. A millionth
// is -120dB - far below the plots' -72dB floor - so nothing visible survives the trim, and the
// payload drops by roughly two thirds.
function handleMixSpec(key, values) {
  const stride = engine?.mixSpecStride?.() ?? 4;
  const bands = [];
  for (let i = 0; i + stride <= values.length; i += stride) {
    const band = new Array(stride);
    for (let k = 0; k < stride; k++) band[k] = Math.round(values[i + k] * 1e6) / 1e6;
    bands.push(band);
  }
  mixSpecs.set(key, bands);
}

function setMixMonitor(on) {
  if (on && !engine) throw new Error(engineError ?? 'engine not loaded');
  clearTimeout(mixOffTimer);
  mixOffTimer = null;
  try {
    if (engine) engine.mixMeters(on);
  } catch (err) {
    if (on) throw err; // turning OFF a dead engine is fine - the taps died with it
  }
  mixMonitorOn = !!on && !!engine;
  if (!mixMonitorOn) {
    mixLevels.clear();
    mixSpecs.clear();
  }
}

// Everything one mixer poll needs. Meter readings queue engine-side of this map and are drained
// per poll, oldest first (the engine meters 20x/sec, the mixer polls ~10x - dropping every other
// reading would eat transients, exactly as the record panel found). Band frames are
// latest-value-wins: they draw a display that decays smoothly client-side, so a skipped frame is
// invisible. Polling is also the mixer's keep-alive: monitoring shuts itself off when the polls
// stop (closed tab, crashed page), so an abandoned mixer never leaves analysis synths running.
function mixStatus() {
  if (mixMonitorOn) {
    clearTimeout(mixOffTimer);
    mixOffTimer = setTimeout(() => setMixMonitor(false), MIX_AUTO_OFF_MS);
  }
  const cutoff = Date.now() - 1000;
  const levels = {};
  for (const [key, queue] of mixLevels) {
    levels[key] = queue.filter((r) => r.at >= cutoff)
      .map(({ peakL, rmsL, peakR, rmsR }) => ({ peakL, rmsL, peakR, rmsR }));
    queue.length = 0;
  }
  return {
    on: mixMonitorOn,
    tracks: [...schedulers.keys()],
    levels,
    spec: Object.fromEntries(mixSpecs),
    bandFreqs: engine ? engine.mixBandFreqs() : [],
    transport: transport?.snapshot(),
  };
}

// ---------------------------------------------------------------------------------------------
// "conf" (configure) capture - Ableton-style. While a track is in conf mode, sclang forwards
// every parameter a user moves in a plugin's own editor GUI as /poptart/paramAutomated; we
// coalesce the latest value per (slot, name) and hand them to the editor, which drops each into
// the code as .param(name, value). Values arrive normalized 0..1 (what VST params take); for a
// parameter with a units mapping (mappings/*.json) we convert back to real-world units so the
// written .param() call round-trips - and reads in Hz/dB/etc. like the rest of that plugin's code.
// ---------------------------------------------------------------------------------------------

let conf = null; // { trackId, touched: Map<`slot|name`, { slot, name, value }>, seen: Set<addr> } while a track configures

// Round to `sig` significant figures - real-world unit values (Hz, ms) span wide magnitudes, so a
// fixed decimal count would be either lossy or noisy. Normalized values use a plain 4 decimals.
function roundSig(x, sig = 4) {
  if (x === 0 || !Number.isFinite(x)) return x;
  const mag = 10 ** (sig - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * mag) / mag;
}

// The address a touched parameter is written as: its plain name, or "Name#index" when the
// plugin has more than one parameter sharing that name (Diva's three "Frequency", etc.), so the
// generated .param() call targets the exact one that was moved rather than the first match. Falls
// back to the plain name if the plugin's parameter list isn't cached yet (nothing to compare).
function paramAddr(plugin, name, index) {
  const list = paramsByPlugin.get(plugin);
  if (!list) return name;
  const sameName = list.reduce((n, p) => n + (p.name === name ? 1 : 0), 0);
  return sameName > 1 ? `${name}#${index}` : name;
}

function handleParamAutomated(trackId, slot, name, index, normValue) {
  if (!conf || conf.trackId !== trackId) {
    // sclang only forwards gestures for a conf-armed track, so landing here means the two ends
    // disagree about the session - log it, this is the diagnostic for every "conf writes
    // nothing" report.
    console.log(`[conf] gesture "${name}" from track "${trackId}" ignored - configuring: ${conf ? `"${conf.trackId}"` : 'none'}`);
    return;
  }
  const spec = mappedEngine?.specFor(engineTrack(trackId), slot, name);
  const value = spec ? roundSig(toRealWorld(normValue, spec)) : Math.round(normValue * 1e4) / 1e4;
  const addr = paramAddr(mappedEngine?.chains.get(engineTrack(trackId))?.[slot], name, index);
  // One line per param per session (not per gesture - dragging floods otherwise), so the server
  // console shows what conf is capturing.
  if (!conf.seen.has(addr)) {
    conf.seen.add(addr);
    console.log(`[conf] capturing "${addr}" (track "${trackId}" slot ${slot})`);
  }
  conf.touched.set(`${slot}|${addr}`, { slot, name: addr, value });
}

// ---------------------------------------------------------------------------------------------
// Auto-pin. `synth("Serum 2")` with no state argument means "however the plugin defaults" - but
// the moment you touch anything in the plugin's own window, that's no longer true, so we capture
// the full state and hand it to the editor to write into the call as `{ state }`. No pin button:
// the code always describes what you're hearing.
//
// The state itself goes in, gzipped and base64'd, megabytes and all - not a reference to it. A
// patch is then the whole sound: what you save, paste or send needs nothing else to exist, and
// commenting one line out and another in swaps presets, because both are right there. It was
// briefly a short id into a side store instead; that made buffers small but made a patch a pointer,
// and pointers dangle. What made big buffers expensive was never the bytes - it was the label
// splitter re-lexing a block per line (fixed in labels.mjs: 2MB went 225ms -> 11ms). An 8.5MB
// buffer with three pinned Serums now costs ~55ms an eval, and that is worth paying for a patch
// that can't lose its own sound.
//
// WHEN we capture is an audio decision, not a bookkeeping one, and it has two settings. A capture
// is VSTPlugin's `writeProgram`, and its docs are explicit about the cost: with `async: true` (the
// default)
// "plugin processing is temporarily suspended" while the plugin serializes itself - a couple of
// megabytes of wavetables for a Serum program, and an audible interruption of that track.
// `async: false` is not an escape: it moves the same work onto the audio thread, where it stalls
// the whole server rather than one plugin. Our own share is off the event loop (the gzip runs on
// the threadpool - see osc-engine), so there is no faster capture to write - only a better moment
// to spend one:
//
// `immediate` (the default) spends one as soon as each gesture settles, whatever the clock is
// doing: one brief suspension per tweak, and a buffer that always matches what you hear.
// `deferred` (POPTART_AUTOPIN=deferred) spends it only where it costs least:
//
//   - clock frozen -> capture as soon as the gesture settles. Nothing is playing to interrupt.
//   - clock running -> hold the slot dirty, and capture at the next moment the code has to be
//     true about the sound: an eval, a stop, a save, an export, a share link (the callers of
//     flushPluginCaptures). Those are moments you are already changing or leaving the sound, and
//     all of them are far rarer than knob moves. It also keeps a megabyte-scale rewrite of the
//     buffer out of the middle of a performance.
//
// Deferring buys an uninterrupted jam, and pays for it in the gap between the plugin and the
// buffer: sound design that exists only inside the plugin is lost if the tab or the server goes
// away, and anything reading the buffer meanwhile (an autosave, a snapshot) is describing a sound
// that has moved on. flushPluginCaptures closes the gap wherever the code is about to be written
// out, but not everything is one of those moments - which is why it isn't the default.
//
// The signal actually worth waiting for would be the plugin's own window closing, and VSTPlugin
// doesn't offer it: its events are /vst_param, /vst_auto, /vst_program*, /vst_latency, /vst_midi,
// /vst_sysex, /vst_update and /vst_crash (see the UGen reference). Nothing reports a closed editor.
//
// Debounced either way: sclang reports every gesture, so an undebounced capture would run that
// round trip dozens of times a second during a knob drag. One capture per gesture is enough
// anyway - the state is a full snapshot, so intermediate ones are pure waste.
// ---------------------------------------------------------------------------------------------

const AUTOPIN_DEBOUNCE_MS = 400;
// A capture slower than this is worth a log line: it is time the plugin spent suspended, which is
// the only part of a capture anyone can hear.
const AUTOPIN_SLOW_MS = 50;

// See the section header for what these two cost each other.
const AUTOPIN_MODE = process.env.POPTART_AUTOPIN === 'deferred' ? 'deferred' : 'immediate';

// "trackId|slot" -> { trackId, slot, plugin, preset } - edited, not yet captured. `plugin` is what
// sat in that slot when the gesture happened; a capture that finds something else there has been
// overtaken by a chain edit and is dropped rather than written to the wrong plugin. `preset` is the
// name a .preset(...) pattern had loaded there AT THE GESTURE - read now rather than at capture
// time because the capture is half a second later, by which point the pattern may well have moved
// on, and the knob you turned belongs to the sound you were hearing when you turned it.
const autoPinDirty = new Map();
// "trackId|slot" -> { preset, at } - the preset the editor's preset panel is holding that slot on
// (see the /api/presetHold route and Scheduler#holdPreset). Kept HERE rather than only on the
// Scheduler because setPattern rebuilds what a slot plays from on every evaluation - and a save
// re-evaluates - so a hold has to be re-asserted afterwards, or the panel would lose the sound it
// is editing on its own first keystroke.
//
// A hold is a LEASE, not a flag: the editor renews it on the poll it already runs, and it expires a
// few seconds after the editor stops asking. A held slot stops swapping, so one that outlived its
// panel - a closed tab, a reload, a browser that crashed - would leave a track quietly stuck on one
// preset with nothing on screen to explain why its pattern had stopped working.
const presetHolds = new Map();
const PRESET_HOLD_TTL_MS = 3000; // ~6 missed polls (see the editor's 500ms pluginEdits loop)

/**
 * Takes or releases one slot's hold. Returns the reason the preset couldn't be loaded, or null.
 * `force` is the panel picking a preset by hand - see the route, which captures first.
 */
function setPresetHold(trackId, slot, preset, { force = false } = {}) {
  const key = `${trackId}|${slot}`;
  if (preset == null) {
    presetHolds.delete(key);
    schedulers.get(trackId)?.holdPreset(slot, null);
    return null;
  }
  const prev = presetHolds.get(key);
  // Renewing an unchanged lease is a HEARTBEAT and must do nothing else. holdPreset() LOADS the
  // preset, and between auto-pin capturing a program out of the plugin and the evaluation that
  // files it in the store, the store still holds the OLD program - so a renewal in that window
  // would push the old sound back into the plugin, and the eval a moment later would put the new
  // one in again. Which is precisely what "it jumps back to the previous preset and then returns"
  // was. Only a hold that is new, or has moved to a different preset, applies anything.
  const renewal = prev?.preset === preset && prev.loaded;
  // A hold taken while the slot is frozen by hand editing is a hold that hasn't LOADED anything -
  // the plugin is sounding what your knobs made, which is the sound the panel is editing anyway.
  // Recorded as such, so the poll that comes after the freeze lifts loads it rather than reading
  // as a heartbeat and doing nothing for the rest of the session.
  const loaded = renewal || force || !stateHeld(key);
  presetHolds.set(key, { preset, at: Date.now(), loaded });
  if (renewal || !loaded) return null;
  return schedulers.get(trackId)?.holdPreset(slot, preset, { force }) ?? null;
}

/** Drops leases the editor has stopped renewing, handing those slots back to their patterns. */
function expirePresetHolds() {
  const cutoff = Date.now() - PRESET_HOLD_TTL_MS;
  for (const [key, held] of presetHolds) {
    if (held.at >= cutoff) continue;
    presetHolds.delete(key);
    const at = key.lastIndexOf('|');
    schedulers.get(key.slice(0, at))?.holdPreset(Number(key.slice(at + 1)), null);
  }
}

// "trackId|control" -> { name, value, at } - the channel-strip control a mixer fader or knob is
// holding while it is dragged (see the /api/channelHold route and Scheduler#holdChannel). Kept HERE
// as well as on the Scheduler for the same reason preset holds are: setPattern rebuilds what a
// track plays on every evaluation, and the release of a drag both writes code and evaluates - so
// the hold has to be re-asserted afterwards, or the level would snap back to the code in the gap
// between that eval landing and your finger actually lifting.
//
// A lease, not a flag: the editor renews it on the pluginEdits poll it already runs, and it expires
// a few seconds after the editor stops asking. Renewal can't ride the drag's own value posts - a
// finger held still on a fader sends no pointermove at all - so it goes on the poll, which is also
// what makes a closed tab, a reload, or a pointerup that never arrived give the control back. A
// held control ignores its pattern, so one that outlived its drag would leave a track stuck at
// whatever level your hand was at, with nothing on screen to explain why.
const channelHolds = new Map();
const CHANNEL_HOLD_TTL_MS = 3000; // ~6 missed polls (see the editor's 500ms pluginEdits loop)

/**
 * Takes, renews, or releases one channel control's hold. Returns the reason it couldn't be taken
 * (a Tier-2 modulator drives it), or null. Renewing an unchanged hold is a plain heartbeat - unlike
 * a preset hold there is nothing to re-load, so re-asserting the same value costs nothing.
 */
function setChannelHold(trackId, name, value) {
  const key = `${trackId}|${name}`;
  if (value == null) {
    channelHolds.delete(key);
    schedulers.get(trackId)?.holdChannel(name, null);
    return null;
  }
  channelHolds.set(key, { name, value, at: Date.now() });
  return schedulers.get(trackId)?.holdChannel(name, value) ?? null;
}

/** Drops leases the editor has stopped renewing, handing those controls back to their patterns. */
function expireChannelHolds() {
  const cutoff = Date.now() - CHANNEL_HOLD_TTL_MS;
  for (const [key, held] of channelHolds) {
    if (held.at >= cutoff) continue;
    channelHolds.delete(key);
    schedulers.get(key.slice(0, key.lastIndexOf('|')))?.holdChannel(held.name, null);
  }
}
// ---------------------------------------------------------------------------------------------
// Hand editing. While you are turning a plugin's own knobs, that plugin holds a sound nothing else
// has yet: not the preset store, not the buffer, not a `{ state }` argument. Anything that pushes a
// STORED program into the slot meanwhile overwrites what you just did - and auto-pin's capture
// lands a moment later and puts it back, so the slot audibly flips to the old sound for a cycle and
// then to the new one. That is what "the preset keeps switching back and forth" is.
//
// So a slot being edited by hand is frozen: whole-program pushes are held off, and nothing else is
// (see Scheduler#holdPluginState). Two things freeze one, and it stays frozen while either holds:
//
//   - the slot has been TAKEN BY HAND: you opened its plugin's own window (/api/showEditor), and
//     have not been back to the code since. Opening a plugin window is the gesture that means "I am
//     shaping this sound myself now", and clicking anywhere in the code (/api/releaseEditors) is
//     the one that hands it back - the two ends of a session at the plugin, both of them things a
//     person actually did rather than states we tried to infer.
//
//     Inference is what this replaced, and it is worth saying why. Nothing reports a plugin window
//     CLOSING - VSTPlugin's events are params, programs, latency, midi, sysex and crash, and
//     nothing else - so the first attempt guessed the end of a session from the browser regaining
//     focus, and guessed wrong constantly: a window that opens behind the browser never takes the
//     focus away, so holds ended a second or two after they started, in the middle of a knob turn.
//
//     Kept HERE rather than in the browser because it outlives a tab: reload the page and the
//     plugin window is still up, still holding, and the editor is told so on its first poll.
//   - a captured program hasn't reached the code yet. The round trip is capture -> poll -> write ->
//     eval, comfortably a cycle or two of a running clock, and the store is stale for every one of
//     them. The editor reports each capture it has filed BY SEQUENCE NUMBER, so a knob turned while
//     the last capture was in flight isn't released by the report of that one; a capture that never
//     lands (no chain call left to write into, a browser that went away) times out rather than
//     freezing the slot for the rest of the set.
// ---------------------------------------------------------------------------------------------

const handTaken = new Set(); // "trackId|slot" of every slot taken over by hand (see above)
const uncaptured = new Map(); // "trackId|slot" -> { seq, at } - edited, not yet filed into the code
const UNCAPTURED_TTL_MS = 20000; // covers a capture, a poll, a write and the eval that files it
let editSeq = 0;

/** Whether either reason to leave a slot's plugin alone is in force (see the section header). */
function stateHeld(key) {
  return handTaken.has(key) || uncaptured.has(key);
}

/** Tells the track's scheduler whether one of its slots is being edited by hand right now. */
function syncStateHold(key) {
  const at = key.lastIndexOf('|'); // a label may contain a pipe; the slot never does
  schedulers.get(key.slice(0, at))?.holdPluginState(Number(key.slice(at + 1)), stateHeld(key));
}

/** Every slot of one track frozen right now, for the eval that rebuilds its scheduler. */
function stateHeldSlotsFor(label) {
  const out = new Set();
  for (const key of [...handTaken, ...uncaptured.keys()]) {
    const at = key.lastIndexOf('|');
    if (key.slice(0, at) === label) out.add(Number(key.slice(at + 1)));
  }
  return out;
}

/**
 * Every chain slot that is NOT following its preset pattern right now, with the preset it is
 * actually sitting on. The editor draws these (see its holds section): a held slot is a place where
 * the code says one thing and the sound is another, and the only honest way to show that is on the
 * code itself. Both kinds are in here - the preset panel's hold and the hand-editing freeze -
 * because from the buffer's point of view they are one fact: this slot plays that preset for now.
 */
function currentHolds() {
  const out = [];
  const seen = new Set();
  const add = (key, why) => {
    if (seen.has(key)) return; // first reason wins, most deliberate first
    seen.add(key);
    const at = key.lastIndexOf('|');
    const trackId = key.slice(0, at);
    const slot = Number(key.slice(at + 1));
    out.push({ trackId, slot, why, preset: schedulers.get(trackId)?.livePreset(slot) ?? null });
  };
  for (const key of presetHolds.keys()) add(key, 'panel');
  for (const key of handTaken) add(key, 'hand');
  for (const key of uncaptured.keys()) add(key, 'capture');
  return out;
}

/** Opening a plugin's own window takes that slot by hand until the code is touched again. */
function takeSlotByHand(trackId, slot) {
  const key = `${trackId}|${slot}`;
  if (handTaken.has(key)) return;
  handTaken.add(key);
  syncStateHold(key);
}

/**
 * Hands every by-hand slot back to its pattern - one click in the code releases all of them, not
 * just the one you were looking at. There is no per-slot release because there is no per-slot
 * gesture: you are either working in the code or you are working in a plugin.
 */
function releaseSlotsHeldByHand() {
  const keys = [...handTaken];
  handTaken.clear();
  for (const key of keys) syncStateHold(key);
  return keys.length;
}

/** A gesture in a plugin's own window: its slot is frozen from here until the capture is filed. */
function noteHandEdit(key) {
  uncaptured.set(key, { seq: ++editSeq, at: Date.now() });
  syncStateHold(key);
  return editSeq;
}

/** The editor saying a captured program has reached the code, by the sequence number it came with. */
function commitCapture(at) {
  const key = `${String(at?.trackId ?? '')}|${Number(at?.slot ?? 0)}`;
  // A knob turned while the last capture was being written left a NEWER one uncaptured, and the
  // report of the old one must not release it - that edit is still only in the plugin.
  if (uncaptured.get(key)?.seq !== Number(at?.seq)) return;
  uncaptured.delete(key);
  syncStateHold(key);
}

/** Drops captures that never made it into the code. Windows are not in here: one is closed, never
 * expired - see the section header. */
function expireStateHolds() {
  const now = Date.now();
  for (const [key, held] of uncaptured) {
    // A slot still waiting to be captured is not late, however long it has waited: deferred mode
    // holds captures for the whole of a performance on purpose, and thawing there would hand the
    // pattern a plugin whose sound is still only in the plugin - the one thing this prevents.
    if (autoPinDirty.has(key)) continue;
    if (now - held.at < UNCAPTURED_TTL_MS) continue;
    uncaptured.delete(key);
    console.log(`[auto-pin] ${key.slice(0, key.lastIndexOf('|'))} slot ${key.slice(key.lastIndexOf('|') + 1)}: the capture never reached the code - the slot goes back to its pattern`);
    syncStateHold(key);
  }
}

const autoPinReady = new Map(); // same key -> { trackId, slot, plugin, preset, state, seq } - editor drains it
// Sig#log() lines waiting for the editor to drain them (see init's setEventLogger). Capped, so a
// .log() left running with no browser attached can't grow without bound: the oldest lines go,
// which is the right end to lose - the interesting one is what just played.
const EVENT_LOG_MAX = 500;
const eventLogQueue = [];
let autoPinTimer = null;
let autoPinRun = null; // the capture pass in flight, so a flush can wait for it instead of racing

function handlePluginEdited(trackId, slot) {
  // Not for the queued deck's tracks: at mix time the songs are ~done (mixing is playback, per
  // the design), deck b's code lives in the other pane under UNPREFIXED labels the pin-writer
  // can't target - every capture ended in "auto-pin: no .fx(...) call for b:kick - state not
  // written" (and a loaded song's own preset restores fire these edit events too, so mixing
  // sprayed that warning constantly). A promoted track re-keys to a plain label on complete-mix
  // and pins normally again from there.
  if (deckOfKey(trackId) === 'b') return;
  const key = `${trackId}|${slot}`;
  autoPinDirty.set(key, {
    trackId,
    slot,
    plugin: pluginInSlot(trackId, slot),
    preset: schedulers.get(trackId)?.livePreset(slot) ?? null,
  });
  // Frozen from the GESTURE, not from the capture: the swap that would overwrite this edit can come
  // round long before the debounce below has even fired (see the hand-editing section).
  noteHandEdit(key);
  clearTimeout(autoPinTimer);
  // In deferred mode, capture on the gesture only while the clock is frozen - nothing to interrupt.
  // A running clock leaves the slot dirty until something flushes it.
  if (AUTOPIN_MODE === 'immediate' || (transport?.paused ?? true)) {
    autoPinTimer = setTimeout(flushPluginCaptures, AUTOPIN_DEBOUNCE_MS);
  }
}

function pluginInSlot(trackId, slot) {
  return mappedEngine?.chains.get(engineTrack(trackId))?.[slot] ?? null;
}

/**
 * Capture every slot edited since the last flush. Safe to call at any time and from anywhere:
 * concurrent callers share the one pass (captures are serialized - each is a disk write in sclang,
 * and two writeProgram calls must not race for the same slot's temp file), and a slot that can't
 * be captured is logged rather than thrown, so a flush never fails the request it rides on.
 */
function flushPluginCaptures() {
  if (!autoPinRun) {
    autoPinRun = captureDirtyPlugins().finally(() => {
      autoPinRun = null;
    });
  }
  return autoPinRun;
}

async function captureDirtyPlugins() {
  if (!engine) return;
  while (autoPinDirty.size) {
    const [key, { trackId, slot, plugin, preset }] = autoPinDirty.entries().next().value;
    autoPinDirty.delete(key);
    // Reordering a chain moves which plugin a slot holds. A pending capture for slot 2 would then
    // read - and the editor would write - the wrong plugin's program, so drop it instead. The
    // plugin still holds the edit; touching it again captures it where it now lives.
    const now = pluginInSlot(trackId, slot);
    if (plugin && now !== plugin) {
      console.log(`[auto-pin] skipped ${trackId} slot ${slot}: it held ${plugin} when it was edited and holds ${now ?? 'nothing'} now`);
      continue;
    }
    try {
      const t0 = performance.now();
      const state = await engine.getPluginState(engineTrack(trackId), slot);
      const ms = performance.now() - t0;
      // Nearly all of this is the plugin serializing itself with its processing suspended - the
      // gzip on our side is off the event loop (see osc-engine). Worth logging when it's slow:
      // it's the only part of a capture anyone can hear.
      if (ms > AUTOPIN_SLOW_MS) {
        console.log(`[auto-pin] ${trackId} slot ${slot}: plugin took ${Math.round(ms)}ms to hand over its program`);
      }
      // Into the store, and the editor is handed the handle: a program is megabytes, and the
      // buffer it would be written into is copied on every autosave, checkpoint and eval (see
      // blobs.js). Nothing downstream can tell the difference - the scheduler compares states as
      // opaque strings, and the engine resolves the handle when it loads one.
      const handle = await blobs.putBlob(state);
      // The time the editor has to file this starts HERE, not at the gesture: in deferred mode the
      // capture itself may have been held back for a whole performance.
      const held = uncaptured.get(key);
      if (held) held.at = Date.now();
      autoPinReady.set(key, { trackId, slot, plugin, preset, state: handle, seq: held?.seq ?? 0 });
      // The state came *from* the plugin, so the next eval must not push it straight back:
      // tell the track's scheduler it's already applied. Without this, every eval would have
      // the plugin re-chew a state it already has (a reload, and an audible one on some).
      // Marked under the handle, because that is what the code the next eval reads will say.
      schedulers.get(trackId)?.markStateApplied(slot, mappedEngine?.chains.get(engineTrack(trackId))?.[slot], handle);
    } catch (e) {
      // Slot emptied, engine restarted mid-gesture, writeProgram refused - all recoverable and
      // all self-correcting on the next edit. Log once per slot so it's diagnosable.
      console.log(`[auto-pin] could not capture ${trackId} slot ${slot}: ${e.message ?? e}`);
      // Nothing will ever file this one, so it must not go on freezing the slot: the plugin's
      // window being open is the only reason left to, and the next edit captures again.
      uncaptured.delete(key);
      syncStateHold(key);
    }
  }
}

// Pruning is housekeeping, not part of answering the request: it runs after a delay, coalesced,
// so a burst of evals prunes once and never between the notes of one.
let pruneTimer = null;
function schedulePrune() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    // Oldest first, then the states they were holding alive: a knob held for a minute is a hundred
    // captures and a hundred stored programs, and the ones no session and no history entry mentions
    // any more are simply gone (see blobs.js). Ordered, not raced - a session or snapshot deleted
    // after the sweep read it would leave its states behind until the next round, which is harmless
    // but pointless.
    Promise.resolve(expireWipSessions())
      .then(() => pruneSnapshots())
      .then(() => blobs.sweepBlobs({ scanDirs: [WIP_DIR, SNAPSHOT_DIR, PREBAKE_DIR, snippets.SNIPPETS_DIR], alsoKeep: [...liveStateIds.a, ...liveStateIds.b] }))
      .then(({ deleted, freed }) => {
        if (deleted) console.log(`[poptart] released ${deleted} captured plugin state(s), ${(freed / 1048576).toFixed(1)}MB`);
      })
      .catch((e) => console.error(`[poptart] snapshot prune failed: ${e.message ?? e}`));
  }, 30000).unref();
}

// Handles the editor's live buffer mentions, held out of the sweep by name rather than by age.
// Refreshed from both places the server sees that buffer - the eval request and the autosave - so
// a state stays safe from the moment it is written into the code, whether or not it has reached a
// file yet.
const liveStateIds = { a: new Set(), b: new Set() }; // per deck - both decks' states are in use

// The retention policy, if the settings tab has been asked for one: session files older than
// `wipRetentionMonths` go, which is also what lets the state store shrink (a session pins the
// states it names). Off unless set, and off is the default - a session file is the recovery net
// for work that was never named, and how long that is worth keeping isn't the app's call.
function expireWipSessions() {
  const months = Number(settings.wipRetentionMonths ?? 0);
  if (!(months > 0)) return;
  const { deleted, freed } = pruneWipSessions(months);
  if (deleted) {
    console.log(`[poptart] expired ${deleted} session(s) older than ${months} month(s), ${(freed / 1048576).toFixed(1)}MB`);
  }
}

// ---------------------------------------------------------------------------------------------
// API handlers, keyed "METHOD /path" and dispatched by the plumbing at the bottom of the file.
// ---------------------------------------------------------------------------------------------

// Walked sample trees, held briefly for /api/findSamples (see there). Keyed by folder; a handful
// of folders at a time is all a search session touches, so the map is trimmed rather than managed.
const walkCache = new Map(); // dir -> { at, walk: Promise }
const WALK_CACHE_MS = 5000;
const WALK_CACHE_MAX = 8;

function cachedWalk(dir, run) {
  const now = Date.now();
  const hit = walkCache.get(dir);
  if (hit && now - hit.at < WALK_CACHE_MS) return hit.walk;
  const walk = run().catch((err) => { walkCache.delete(dir); throw err; });
  walkCache.delete(dir); // re-insert, so the map stays in oldest-first order for the trim below
  walkCache.set(dir, { at: now, walk });
  for (const [key, val] of [...walkCache]) {
    if (key !== dir && now - val.at >= WALK_CACHE_MS) walkCache.delete(key);
  }
  while (walkCache.size > WALK_CACHE_MAX) walkCache.delete(walkCache.keys().next().value);
  return walk;
}

const routes = {
  'GET /api/status': async () => ({
    status: 200,
    // `scale` is whatever setscale() last set (the prebake may have, before any eval), so a fresh
    // page load already knows the key its piano roll should be drawing.
    body: { loaded: !!engine, error: engineError, scale: patternCore ? patternCore.globalScale() : null },
  }),

  // Both plugin-list endpoints run through the prefer-VST3 filter (settings tab, default on):
  // a VST2 entry is hidden when a VST3 with the same name exists. The scan itself still probes
  // everything, and an exact `.synth("Name.vst")` id still loads - this only shapes the list
  // the browser and autocomplete see.
  'POST /api/scanPlugins': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const result = await engine.scanPlugins(body.extraPaths ?? []);
    if (settings.preferVst3 !== false) result.plugins = preferVst3(result.plugins);
    return { status: 200, body: result };
  },

  'GET /api/knownPlugins': async () => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const plugins = await engine.getKnownPlugins();
    return { status: 200, body: settings.preferVst3 !== false ? preferVst3(plugins) : plugins };
  },

  'GET /api/midiDevices': async () => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.getMidiDevices() };
  },

  // Sample packs on disk - one folder per pack under the samples root (see osc-engine's
  // samples.js). Files come back in the same filename-sorted order the sampler indexes them
  // in, so a file's position in the list is its `s("pack:idx")` index. Reads the filesystem
  // directly rather than going through the engine, so it works even before the engine is up.
  'GET /api/samples': async () => {
    const { samplesRoot, listPackFiles } = require('@poptart/osc-engine/samples');
    const root = samplesRoot();
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      // missing root = no packs, not an error
    }
    const packs = entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => ({ name: e.name, files: (listPackFiles(e.name) ?? []).map((f) => path.basename(f)) }))
      .filter((p) => p.files.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, body: { root, packs } };
  },

  // The sample-library folder shown/edited in the settings tab. `envOverride` is true when
  // POPTART_SAMPLES_DIR is set, in which case the saved folder is ignored until it's unset.
  'GET /api/samplesDir': async () => {
    const { samplesRoot } = require('@poptart/osc-engine/samples');
    return {
      status: 200,
      body: { dir: samplesRoot(), envOverride: !!process.env.POPTART_SAMPLES_DIR },
    };
  },

  // Filesystem folder browser for the settings-tab folder picker. Query `path` is the folder to
  // list (absolute, or ~-relative; defaults to home); returns its immediate subfolders plus its
  // parent so the client can navigate up. Hidden (dot) folders are included on purpose - the
  // default library lives in ~/.poptart. Only ever lists one directory (never recurses), so this
  // stays cheap. If the requested folder doesn't exist or can't be read (e.g. the default
  // ~/.poptart/samples on a fresh install), it walks up to the nearest readable ancestor and
  // lists that instead, so the picker always opens somewhere navigable rather than an error.
  'GET /api/browseDir': async (query) => {
    const raw = (query.path || '').trim();
    const expanded = raw.startsWith('~')
      ? path.join(os.homedir(), raw.slice(1))
      : (raw || os.homedir());
    const listDir = (d) => fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink()) return false;
        try { return fs.statSync(path.join(d, e.name)).isDirectory(); } catch { return false; }
      })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    let dir = path.resolve(expanded);
    let dirs;
    for (;;) {
      try { dirs = listDir(dir); break; } catch {
        const up = path.dirname(dir);
        if (up === dir) break; // reached the filesystem root; give up
        dir = up;
      }
    }
    if (!dirs) throw new Error(`can't read ${path.resolve(expanded)}`);
    const parent = path.dirname(dir);
    // The audio files in it too, for the pack panel, which picks files as well as folders. The
    // settings folder picker ignores them. And where the sample library is, so a pick under it can
    // be written relative to the root (which is how a pack travels with the library).
    const { isAudioName, samplesRoot } = require('@poptart/osc-engine/samples');
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && isAudioName(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch { /* listed the dirs a moment ago - a race; files stay empty */ }
    return { status: 200, body: { path: dir, parent: parent === dir ? null : parent, dirs, files, samplesRoot: path.resolve(samplesRoot()) } };
  },

  // Everything audio under a folder, for the pack panel: `q` filters (all terms must appear in the
  // path), no `q` is the whole tree - which is what adding a folder recursively takes. The walk is
  // capped; `truncated` says it saw only part of the tree, and `matched` is the real count when
  // more matched than `limit` returns.
  //
  // A search is a request per keystroke over the same tree, so the walk is held for a few seconds:
  // typing costs one walk, not one per letter, and a folder that changed on disk is still picked up
  // by the time anyone notices.
  'GET /api/findSamples': async (query) => {
    const raw = (query.path || '').trim();
    const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : (raw || os.homedir());
    const dir = path.resolve(expanded);
    const limit = Math.max(1, Math.min(20000, Number(query.limit) || 500));
    const { walkAudioFiles, matchAudioPaths } = require('@poptart/osc-engine/samples');
    let walked;
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error('not a folder');
      walked = await cachedWalk(dir, () => walkAudioFiles(dir));
    } catch {
      throw new Error(`can't read ${dir}`);
    }
    const hits = matchAudioPaths(walked.files, query.q || '');
    return {
      status: 200,
      body: {
        path: dir,
        files: hits.slice(0, limit),
        matched: hits.length,
        total: walked.files.length,
        truncated: !!walked.truncated,
      },
    };
  },

  // Prefer-VST3 toggle (settings tab). Default on; body: { enabled }. Applied on the next
  // plugin-list fetch - no rescan needed, the filter sits on the endpoints above.
  'GET /api/preferVst3': async () => ({
    status: 200,
    body: { enabled: settings.preferVst3 !== false },
  }),

  'POST /api/preferVst3': async (body) => {
    settings.preferVst3 = !!body.enabled;
    saveSettings();
    return { status: 200, body: { enabled: settings.preferVst3 } };
  },

  // Body: { dir } - a folder path, or null/"" to reset to the default (~/.poptart/samples).
  // Persisted and applied immediately; the next `s(...)` eval reads packs from the new root.
  'POST /api/samplesDir': async (body) => {
    const { setSamplesRoot, samplesRoot } = require('@poptart/osc-engine/samples');
    const dir = body.dir ? String(body.dir).trim() : null;
    settings.samplesDir = dir;
    setSamplesRoot(dir);
    saveSettings();
    return { status: 200, body: { dir: samplesRoot(), envOverride: !!process.env.POPTART_SAMPLES_DIR } };
  },

  // `code` is the whole editor buffer: one or more labeled blocks (see pattern-core's
  // labels.mjs - `$:` anonymous, `name:` named, `_name:` muted, `Sname:` soloed), each
  // evaluating to a Sig and playing on its own engine track named after the label. Unlabeled
  // code is treated as a single anonymous block, so the original one-expression usage still
  // works.
  'POST /api/evaluate': async (body) => {
    if (!engine || !mappedEngine) throw new Error(engineError ?? 'engine not loaded');
    const evalT0 = performance.now(); // see the eval-cost log at the success return

    // Which performance deck this buffer is (see the decks table above): 'a', the main editor,
    // unless the caller says 'b'. Everything below that keys or scopes by label goes through
    // keyOfBlock, so the two decks' identically-named blocks stay separate tracks.
    const deck = body.deck === 'b' ? 'b' : 'a';
    const keyOfBlock = (label) => (deck === 'a' ? label : `b:${label}`);

    // Whatever you last moved in a plugin's own window is captured here, before anything else:
    // this eval may reload the very plugin holding the only copy of that tweak, and it is the
    // moment the code has to describe the sound anyway (see the auto-pin section).
    await flushPluginCaptures();

    const blocks = patternCore.splitLabeledBlocks(body.code ?? '');
    if (blocks.length === 0) throw new Error('nothing to evaluate');
    liveStateIds[deck] = blobs.referencedIds(body.code ?? ''); // this buffer's states are in use

    // Rewind the random builders' seed counter before building anything, so choose()/irand()
    // seeds are a function of position in the buffer rather than of how many times this server
    // has evaluated. Without it every re-eval re-rolls the take, and since /api/stop rewinds the
    // clock to cycle 0, stop-then-play would come back as a different performance of the same
    // code. Blocks are built below in document order, which is what makes the seeds stable.
    patternCore.resetRandomSeeds();

    // Roll definitions are rebuilt from the buffer every time, for the reason the track teardown
    // below exists: a roll(...) call you just deleted has to stop being playable. Prebake's layer
    // is untouched - it is a library, not part of this buffer. What was there is kept until the
    // build below gets to the end (see the catch): an evaluation that throws applies nothing, so
    // the tracks still playing must still find the definitions they resolve by name each cycle.
    patternCore.setDefOwner(deck);
    const definitionsBefore = patternCore.clearRolls('buffer', deck);
    // Enter the eval with NO key in force: the buffer's own setscale (hoisted below, so it
    // runs before any pattern is built) is the only thing that sets one. Starting from the
    // deck's previous scale instead is how one track's key used to leak into the next - a
    // song without a setscale must play in the default key, not whatever the last song left.
    patternCore.setGlobalScale(null);

    // Fresh copy of the prebake bindings each eval: they're the starting scope for the buffer,
    // and a redeclared name in the buffer overrides the copy without clobbering the original.
    // setbpm records this deck's native tempo, but only the MAIN deck's drives the shared
    // clock: a queued song declares what it wants, and the mix migrates toward it (phase 5).
    let sawSetbpm = false;
    const hostBuilders = {
      ...HOST_BUILDERS,
      setbpm: (value) => {
        const v = typeof value === 'string' ? patternCore.mini(value) : value;
        if (typeof v !== 'number' && typeof v?.sample !== 'function') {
          throw new Error('[transport] setbpm() takes a number or a signal (mini string / LFO / pattern)');
        }
        sawSetbpm = true;
        decks[deck].bpm = v;
        // While a tempo migration holds the clock, even the main deck's setbpm only RECORDS.
        return deck === 'a' && mixState.tempoOverride == null ? setbpm(value) : TEMPO_BLOCK;
      },
    };
    const evalBlock = makeBlockEvaluator(new Map(prebakeDefs), hostBuilders);

    // setscale is HOISTED: every block that is nothing but a `setscale(...)` call runs here, in
    // document order, before any pattern is built - so the LAST one in the buffer is the key the
    // whole buffer plays in, and a `.sc()` pattern written ABOVE it follows it too. A hoisted call
    // that can't run out of order (its argument comes from a `const` declared further up) is left
    // alone and simply runs in its own position, where it always did.
    const hoisted = new Map(); // block -> its value, so the in-order pass below doesn't run it twice
    let evaluated;
    try {
      for (const b of blocks) {
        if (!patternCore.isBareCallBlock(b.code, 'setscale')) continue;
        try {
          evalBlock(b.code, b.start);
          hoisted.set(b, SCALE_BLOCK);
        } catch {
          // not evaluable up here - it keeps its place in the pass below (and reports errors there)
        }
      }

      evaluated = blocks.map((b) => {
        try {
          const value = hoisted.has(b) ? hoisted.get(b) : evalBlock(b.code, b.start);
          // Only an explicitly *named* block promises sound. Anything anonymous (bare code
          // outside labels, or `$:`) that doesn't produce a pattern is a setup block, Strudel-
          // style: declarations shared with the blocks below (const kb = midikeys("...")),
          // language extensions (Signal.prototype.co = ...), one-off side effects - whatever
          // it evaluated to is simply not played. (A pattern is dry-run below, not here.)
          const isPattern = value instanceof patternCore.Sig;
          if (!isPattern && value !== TEMPO_BLOCK && value !== SCALE_BLOCK && !value?.poptartArrangeBlock && !b.label.startsWith('$')) {
            throw new Error('must evaluate to a pattern (e.g. n("0 2 3").scale("F minor").synth("Serum 2"))');
          }
          return { ...b, sig: value };
        } catch (err) {
          throw new Error(`${b.label}: ${err.message ?? err}`);
        }
      });

      // Only now, with every block evaluated, are any cycles built. A pattern resolves the rolls
      // and shapes it NAMES lazily, one cycle at a time, so that the definitions may sit anywhere
      // in the buffer - and the editor writes them in a block at the FOOT of it, below the patterns
      // that play them. Building a cycle inside the pass above therefore asked the registry for
      // definitions the pass had not reached yet: every `pianoroll("lead")` in a normally-laid-out
      // buffer reported itself undefined on every evaluation, on a name that was defined two lines
      // later and played perfectly.
      for (const b of evaluated) {
        if (!(b.sig instanceof patternCore.Sig)) continue;
        try {
          dryRunPattern(b.sig);
        } catch (err) {
          throw new Error(`${b.label}: ${err.message ?? err}`);
        }
      }
    } catch (err) {
      // Nothing has been applied yet - no track was stopped, no pattern was set - so the buffer's
      // definitions go back exactly as they were. Without this a block that doesn't parse takes
      // every roll/shape/preset defined BELOW it out of the registry, and the tracks that are
      // still playing (which resolve them by name, lazily) fall silent on a buffer nobody meant
      // to change.
      patternCore.restoreRolls(definitionsBefore, 'buffer', deck);
      patternCore.setDefOwner('a'); // definitions filed outside an eval (live roll edits) are the main pane's
      decks[deck].scale = patternCore.globalScale();
      patternCore.setGlobalScale(decks.a.scale ?? null); // the global holds the main deck's key at rest
      throw err;
    }
    patternCore.setDefOwner('a'); // definitions filed outside an eval (live roll edits) are the main pane's
    // What setscale() left in force is this deck's key; the global goes back to holding the main
    // deck's, which is what every non-eval reader (/api/status, live-note quantization) means.
    const deckScale = (decks[deck].scale = patternCore.globalScale());
    patternCore.setGlobalScale(decks.a.scale ?? null);
    // Same for tempo: a buffer with no setbpm() specifies nothing, so nothing of the previous
    // track's may stand - its native reads as the 120 default (deckNativeBpm), and on the main
    // deck the clock itself returns there (unless the mix desk holds it), exactly as if the
    // song had been loaded outside dj mode.
    if (!sawSetbpm) {
      decks[deck].bpm = null;
      if (deck === 'a' && mixState.tempoOverride == null) setbpm(DEFAULT_CPS * 240);
    }
    noteProtoOwnership(deck);

    // The buffer's _pack() definitions are in the registry now - the engine needs their files
    // before the schedulers below ask it to play them.
    syncSamplePacks();

    // Tempo-only and definitions-only blocks act at eval time and don't become tracks.
    // A block of roll(...) definitions evaluates to its last definition, which is a real Sig but
    // not a track - playing it would turn the definitions block into an extra voice (see
    // signal.mjs's isDef). Anything derived from one (`roll(0, "…").synth(…)`) has lost the mark
    // and plays as normal.
    const built = evaluated.filter((b) => b.sig instanceof patternCore.Sig && !b.sig.isDef);

    // The arrangement pass: a block painted into an arrange() plays only inside its clips, so the
    // bare loop it was is gated to the part it has become (see pattern-core's arrange.mjs). Every
    // arrangement in the buffer contributes clips to ONE timeline - they are one song - and its
    // length is the longest of them. A clip naming a block that isn't here is worth a line: the
    // painter offers only the labels it can see, so this is a rename or a deleted block, and the
    // part it stood for is silently gone.
    const arrangements = evaluated.map((b) => b.sig).filter((v) => v?.poptartArrangeBlock);
    if (arrangements.length) {
      const clips = arrangements.flatMap((a) => a.clips);
      const loopLen = Math.max(...arrangements.map((a) => patternCore.arrangementLength(a.clips, a.opts)));
      const spans = patternCore.arrangementSpans(clips);
      const labels = new Set(built.map((b) => b.label));
      for (const label of spans.keys()) {
        if (!labels.has(label)) eventLogQueue.push(`[arrange] no block called ${JSON.stringify(label)} - its clips play nothing`);
      }
      for (const b of built) {
        if (spans.has(b.label)) b.sig = b.sig._arrangeGate(spans.get(b.label), loopLen);
      }
    }

    // Solo wins over everything except mute: if anything is soloed, only soloed patterns play.
    const anySolo = built.some((b) => b.soloed && !b.muted);
    const active = built.filter((b) => !b.muted && (!anySolo || b.soloed));

    // Stop tracks whose label disappeared (or that are now muted / un-soloed) - within THIS
    // deck only: the other deck's tracks are not in this buffer, and this eval must not touch
    // them (each deck sweeps its own).
    for (const [key, sch] of schedulers) {
      if (deckOfKey(key) !== deck) continue;
      if (!active.some((b) => keyOfBlock(b.label) === key)) {
        sch.stop();
        schedulers.delete(key);
        mappedEngine.removeChain(engineTrack(key));
      }
    }

    // Playback (re)starts: un-freeze the clock. After a stop it sits at cycle 0, so every
    // pattern comes in from the top of the grid; mid-performance evals are a no-op here.
    // `start: false` (the editor's "Update" button) evaluates without touching the clock: a
    // stopped clock stays frozen (patterns load silently), a running one keeps running.
    // Where this eval's schedulers open their window: the clock's position NOW, read before
    // anything below advances it. On play-from-stop that is exactly cycle 0 (the transport is
    // still frozen there), so the downbeat - and a `.preset()`'s first application, which is
    // what used to leave synths on their init program for the whole first cycle - is inside the
    // window instead of a few microseconds behind it (see Scheduler#start).
    const scheduleFrom = transport.cycleAt(engine.getTime());
    if (active.length > 0 && body.start !== false) transport.start();

    for (const b of active) {
      const key = keyOfBlock(b.label);
      // The wrapper needs to know which plugin sits in each slot to pick the right mapping file.
      const tid = claimEngineTrack(key);
      mappedEngine.setChain(tid, [b.sig.instrument, ...b.sig.fxChain]);
      // With swap mode on, an incoming stem starts GATED OUT (fader 0) whenever the OTHER deck
      // already has a song up - on either deck, symmetrically: the whole point of the mode is
      // choosing when each stem swaps its twin out, so none may play just by being evaluated.
      // The first song of the session (other deck empty) plays normally, and only genuinely NEW
      // stems are gated - a re-eval of a playing deck must not mute what is already sounding.
      // Recorded (not just applied) so its gate shows OFF.
      if (mixState.swap && !schedulers.has(key)
        && [...schedulers.keys()].some((k) => deckOfKey(k) !== deck)
        && !mixState.perTrack.get(key)?.has('fader')) {
        let per = mixState.perTrack.get(key);
        if (!per) mixState.perTrack.set(key, (per = new Map()));
        per.set('fader', 0);
      }
      // Pre-claim the engine track with the desk's current values as BIRTH args (deck gain 0 =
      // born silent). This must ride the creation itself: a track is built asynchronously
      // sclang-side, and a setParam sent while it is still pending is dropped - the race that
      // had a freshly evaled stem play at full volume until the desk was touched. Idempotent:
      // the scheduler's own createTrack (inside setPattern) finds the key taken and no-ops.
      mappedEngine.createTrack(tid, mixBirthFor(key));
      let sch = schedulers.get(key);
      if (!sch) {
        sch = new patternCore.Scheduler(mappedEngine, { transport, trackId: tid, label: key });
        schedulers.set(key, sch);
      }
      // Hand-edit freezes go on BEFORE the pattern does: setPattern pushes any pinned `{ state }`,
      // and a slot whose plugin is being edited must not have a stored program pushed into it (see
      // the hand-editing section). Re-asserted here because a Scheduler is rebuilt whenever its
      // label comes back, and unlike a preset hold this sends nothing - it only holds things off.
      for (const slot of stateHeldSlotsFor(key)) sch.holdPluginState(slot, true);
      sch.setPattern(b.sig);
      for (const [holdKey, held] of presetHolds) {
        const at = holdKey.lastIndexOf('|');
        if (holdKey.slice(0, at) === key) sch.holdPreset(Number(holdKey.slice(at + 1)), held.preset);
      }
      // A mixer control still under someone's finger keeps its level across this eval - which is
      // the eval its own release just triggered (see setChannelHold). After setPattern, so the
      // refusal for a natively modulated control reads the pattern that is now playing.
      for (const [holdKey, held] of channelHolds) {
        if (holdKey.slice(0, holdKey.lastIndexOf('|')) === key) sch.holdChannel(held.name, held.value);
      }
      // The mix session's DJ-stage values (see mixState): a track (re)created into a live mix
      // must come up wearing them - this is what makes a queued deck's tracks arrive silent.
      // Already-live tracks get a re-assert; a NEW track had its values baked into its birth
      // args above, and this is a harmless no-op while it builds.
      applyMixTo(key);
      sch.start(scheduleFrom);
    }

    // Any midicc()/midikeys() seen at eval time needs MIDI input running engine-side. The
    // native paths (setParamCC/setMidiNotes) enable it themselves; this covers Tier-1-only
    // use (a cc signal inside arithmetic), whose JS-side sampling needs the /poptart/midiIn
    // feed. Idempotent, so re-sending every eval is fine.
    if (patternCore.midiInUse()) engine.enableMidi();

    // Re-arm conf capture engine-side: sclang keeps the flag on its track object, which an
    // engine restart discards - the eval that recreates the track re-sends it. Idempotent.
    if (conf && active.some((b) => keyOfBlock(b.label) === conf.trackId)) engine.setConfMode(engineTrack(conf.trackId), true);

    // Refresh the highlight-grid source set to this eval's active tracks, and ship each active
    // track's first window inline so playback lights up immediately without a follow-up request.
    for (const k of [...hlTracks.keys()]) if (deckOfKey(k) === deck) hlTracks.delete(k);
    for (const b of active) hlTracks.set(keyOfBlock(b.label), { sig: b.sig, start: b.start, end: b.end });
    const gridFrom = currentGridCycle();

    // Pairs with the event-loop watchdog above: an evaluation that held the process this long
    // starved the scheduler of the OTHER deck too, and the terminal should name the culprit.
    const evalMs = performance.now() - evalT0;
    if (evalMs > 100) {
      // eslint-disable-next-line no-console
      console.warn(`[poptart] evaluate (deck ${deck}) took ${Math.round(evalMs)}ms`);
    }

    mixNotify(); // the deck head's play/stop toggle follows the desk stream
    return {
      status: 200,
      body: {
        cps: transport.cps,
        transport: transport.snapshot(),
        scale: deckScale, // what setscale() left in force for this deck - the piano roll colours by it
        deck,
        deckBpm: deckNativeBpm(deck),
        gridFrom,
        gridCount: HL_WINDOW,
        tracks: built.map((b) => ({
          label: b.label,
          key: keyOfBlock(b.label), // what this track is called server-side (deck b keys are "b:<label>")
          muted: b.muted,
          soloed: b.soloed,
          active: active.includes(b),
          start: b.start,
          end: b.end,
          instrument: b.sig.instrument,
          fxChain: b.sig.fxChain,
          paramNames: paramLabels(b.sig),
          grid: active.includes(b) ? highlightGrid(b.sig, b.start, b.end, gridFrom, HL_WINDOW) : null,
        })),
      },
    };
  },

  // Playback-highlight top-up. Patterns that vary per cycle (`<…>`, r/i, degrade, choice) outrun
  // the window shipped with /api/evaluate; the browser requests the next window as its clock nears
  // the end of what it has. Query: { from, count? }. Returns the same per-track grid shape, for the
  // still-active tracks of the last eval - deterministic, so it matches what /api/evaluate sent.
  // What roll ids are playable right now. The buffer's own definitions the editor can read for
  // itself; this is how it learns about the prebake library, which is nowhere in the buffer.
  // Every handler returns { status, body } - this one didn't, so it 500'd on every call and the
  // picker's library list was quietly always empty.
  'GET /api/rolls': async () => ({
    status: 200,
    body: {
      rolls: patternCore.rollIds(),
      shapes: patternCore.shapeIds(),
      presets: patternCore.presetIds(),
      // A pack's files come too: the pack panel shows a library pack's contents, which - unlike a
      // buffer pack's - are nowhere in the code it can read.
      packs: patternCore.packIds().map((p) => ({ ...p, files: patternCore.lookupPack(p.id)?.files ?? [] })),
      pinned: pinnedList(),
    },
  }),

  // Body: { id, notes, opts } - re-files one roll definition from the piano roll panel while a
  // gesture is still in the hand (a lane drag, the swing slider). Because a pattern resolves the
  // rolls it NAMES once per cycle, this is heard on the next cycle without the buffer being
  // rewritten or re-evaluated - which is the whole point: an eval per frame of a drag would mean a
  // full re-transpile, a browser-history entry and an autosave for a value still moving. The write
  // to the code, and the ordinary eval that comes with it, land once when the gesture is let go.
  //
  // Nothing here touches the engine, so it works stopped as well as playing, and it deliberately
  // does NOT report an unknown id: the panel may be ahead of the buffer (a roll drawn before the
  // first eval names it), and re-filing is how it catches up.
  'POST /api/liveRoll': async (body) => {
    const id = body?.id;
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('liveRoll needs the roll id');
    patternCore.liveRoll(id, String(body.notes ?? ''), body.opts ?? {});
    return { status: 200, body: { ok: true } };
  },

  // --- the ★ library (see pinned-defs.js) ---

  'GET /api/pinned': async () => ({ status: 200, body: { pinned: pinnedList() } }),

  // Body: { kind, id, scope?, code } - `code` is the whole definition as it stands in the buffer.
  // Files it under that name (replacing an older pinned copy) and re-runs prebake, so the name is a
  // library name from this moment. A preset's program is stored by handle (see blobs.js), so the
  // file stays small; the sweep keeps the handle alive by scanning the prebake folder.
  'POST /api/pinned': async (body) => {
    const kind = String(body?.kind ?? '');
    const id = String(body?.id ?? '');
    const scope = String(body?.scope ?? '');
    const { code } = await blobs.dehydrate(String(body?.code ?? ''));
    writePinnedFile(pinnedDefs.upsertPinned(readPinnedFile(), { kind, id, scope, code }));
    return { status: 200, body: { errors: runPrebake(), pinned: pinnedList() } };
  },

  // Body: { kind, id, scope? }. Takes the entry out and re-runs prebake; returns the code it held,
  // so the editor can keep a copy in the buffer when it wants to.
  'POST /api/pinned/remove': async (body) => {
    const kind = String(body?.kind ?? '');
    const id = String(body?.id ?? '');
    const scope = String(body?.scope ?? '');
    const had = pinnedList().find((e) => e.kind === kind && e.id === id && (kind !== 'preset' || e.scope === scope)) ?? null;
    if (had) writePinnedFile(pinnedDefs.removePinned(readPinnedFile(), { kind, id, scope }));
    return { status: 200, body: { errors: had ? runPrebake() : [], pinned: pinnedList(), code: had?.code ?? null } };
  },

  // --- snippets (see snippets.js) ---
  //
  // Where the ★ library generalises one DEFINITION across projects, a snippet generalises a phrase
  // plus the definitions it names. The file is a whole poptart buffer, so the split into body and
  // sidecar happens here rather than in the browser - snippets.js owns that format, and the editor
  // is handed the two halves already apart.

  // Query: { q } - the same free text the files tab takes (`tag:bass`, a word from the code).
  // `code` is dropped on the way out: the browser wants the body and what rides with it, and a
  // snippet carrying a captured program is megabytes it has no use for.
  'GET /api/snippets': async (query) => ({
    status: 200,
    body: { snippets: snippets.listSnippets(query?.q ?? '').map(({ code, ...rest }) => rest) },
  }),

  // Body: { name, title?, tags?, body, defs } - `defs` are whole `_roll(…)`/`_preset(…)` lines,
  // the ones the selection named. Overwrites silently, like saving a pattern.
  //
  // Stored DEHYDRATED (handles, not bytes), which is why SNIPPETS_DIR is one of the folders the
  // blob sweep scans - see the note at the top of snippets.js.
  'POST /api/snippets/save': async (body) => {
    const composed = snippets.composeSnippet({
      title: String(body?.title ?? ''),
      tags: body?.tags ?? [],
      body: String(body?.body ?? ''),
      defs: Array.isArray(body?.defs) ? body.defs : [],
    });
    const { code } = await blobs.dehydrate(composed);
    snippets.writeSnippet(body?.name, code);
    return { status: 200, body: { name: String(body?.name ?? '').trim() } };
  },

  // Body: { name }.
  'POST /api/snippets/delete': async (body) => {
    snippets.deleteSnippet(body?.name);
    return { status: 200, body: {} };
  },

  // Body: { from, to }.
  'POST /api/snippets/rename': async (body) => {
    snippets.renameSnippet(body?.from, body?.to);
    return { status: 200, body: {} };
  },

  // Body: { want: [{ kind, id, scope? }] } -> the same entries with `code` filled in.
  //
  // This is what lets a snippet CARRY a library definition rather than merely point at one, so it
  // can never be broken later by an unpin or a hand-edit of prebake. The editor can't do it for
  // itself: it knows the library's names (see /api/rolls) but has no source for them - openRollById
  // says as much when you try to open a prebake roll. Answered in order of how faithful the answer
  // is: the ★ file, then the prebake sources, then rebuilt from the registry for the kinds where
  // that is lossless. A roll that exists only as a registered Sig has no source anywhere, and says
  // so rather than being quietly dropped.
  'POST /api/snippets/resolveDefs': async (body) => {
    const want = Array.isArray(body?.want) ? body.want : [];
    const sources = [{ code: readPinnedFile() }, ...prebakeSources()];
    const found = sources.flatMap((s) => pinnedDefs.parsePinned(s.code));
    const out = want.map((w) => {
      const kind = String(w?.kind ?? '');
      const id = String(w?.id ?? '');
      const scope = String(w?.scope ?? '');
      const match = (e) => e.kind === kind && e.id === id && (kind !== 'preset' || !e.scope || !scope || e.scope === scope);
      const hit = found.find(match);
      if (hit) return { kind, id, scope: hit.scope, code: hit.code };
      const rebuilt = rebuildDef(kind, id, scope);
      return rebuilt ?? { kind, id, scope, code: null, why: `no ${kind} definition named "${id}" to copy` };
    });
    return { status: 200, body: { defs: out } };
  },

  'GET /api/highlight': async (q) => {
    const from = Math.max(0, Math.floor(Number(q.from)) || 0);
    const count = Math.min(HL_WINDOW * 4, Math.max(1, Math.floor(Number(q.count)) || HL_WINDOW));
    const tracks = [...hlTracks.entries()].map(([label, t]) => ({
      label,
      grid: highlightGrid(t.sig, t.start, t.end, from, count),
    }));
    return { status: 200, body: { gridFrom: from, gridCount: count, tracks } };
  },

  'POST /api/stop': async (body) => {
    // { deck } stops just that deck's playback (DJ mode's per-pane Cmd+.): its schedulers stop,
    // tracks stay warm, and the shared clock keeps running for the other deck. Only when
    // nothing is left playing anywhere does it fall through to the full stop below - so
    // stopping the last playing deck behaves exactly like a normal stop.
    const deck = body?.deck === 'a' || body?.deck === 'b' ? body.deck : null;
    // A deck's song pauses where it stands (a stop is not an unload - play resumes from here).
    const pauseSong = (d) => {
      if (!songDecks[d]) return;
      songDecks[d].cueHeld = false; // a stop under a held cue wins; the release finds nothing to undo
      songPause(d);
    };
    if (deck) {
      for (const [key, sch] of schedulers) if (deckOfKey(key) === deck) sch.stop();
      pauseSong(deck);
      for (const id of [...kbHeld.keys()]) if (deckOfKey(id) === deck) releaseKbNotes(id);
      const otherPlaying = [...schedulers].some(([key, sch]) => deckOfKey(key) !== deck && sch.running)
        || ['a', 'b'].some((d) => d !== deck && songDecks[d]?.playing);
      if (otherPlaying) {
        mixNotify(); // the paused song's pane must hear playing:false, or its playhead sweeps on
        return { status: 200, body: { deck, transport: null } };
      }
    }
    for (const sch of schedulers.values()) sch.stop();
    for (const d of ['a', 'b']) pauseSong(d);
    // Release any live-keyboard notes still held so nothing rings through the stop.
    for (const id of [...kbHeld.keys()]) releaseKbNotes(id);
    // Reset the shared clock to cycle 0 and freeze it - the next eval starts from the top. The
    // live note log counts in that clock's cycles, so it goes too.
    transport?.stop();
    clearLiveLog();
    // Now that nothing is playing, any plugin edit held back during the performance is free to
    // capture (the suspension it costs has nothing left to interrupt).
    flushPluginCaptures();
    mixNotify(); // both decks' songs just paused - the panes' playheads follow the SSE frame
    return { status: 200, body: { transport: transport?.snapshot() ?? null } };
  },

  // A live computer-keyboard note edge from the browser - the piano roll's ⌨ button, aimed at the
  // roll's track. Body: { trackId, note, vel, isOn[, index] }. Routed straight to the instrument
  // like a scheduled note, so env()/lfo() shapes gate the same way; also logged (see "Live notes")
  // so typed takes record and capture. `index` is the sample index of a key struck on an INDEX
  // roll - it rides into the log for the roll to read back, and is nothing to the instrument. A
  // track that hasn't been evaluated (no instrument) simply makes no sound.
  'POST /api/keyNote': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const trackId = String(body.trackId ?? '');
    if (!trackId) return { status: 200, body: { ok: false, reason: 'no track' } };
    const note = Math.round(Number(body.note));
    if (!Number.isFinite(note)) throw new Error('keyNote: note must be a number');
    const isOn = !!body.isOn;
    const index = body.index == null ? null : Number(body.index);
    const key = liveKey(note, index);
    const now = engine.getTime();
    const tid = engineTrack(trackId);
    let held = kbHeld.get(trackId);
    if (!held) kbHeld.set(trackId, (held = new Map()));
    if (isOn) {
      const vel = Math.max(0, Math.min(1, Number(body.vel ?? 1)));
      if (vel <= 0) return { status: 200, body: { ok: true } };
      // Retrigger a re-pressed key cleanly (some layouts fire keydown without an intervening
      // keyup); the browser suppresses auto-repeat, so a real double-down means a new hit.
      if (held.has(key)) {
        engine.noteOff(tid, note, now);
        handleMidiNoteIn(trackId, note, 0, false, index);
      }
      engine.noteOn(tid, note, vel, now);
      held.set(key, { note, index });
      handleMidiNoteIn(trackId, note, vel, true, index);
    } else {
      if (!held.has(key)) return { status: 200, body: { ok: true } };
      engine.noteOff(tid, note, now);
      held.delete(key);
      handleMidiNoteIn(trackId, note, 0, false, index);
    }
    return { status: 200, body: { ok: true } };
  },

  // What a track has had played on it lately - the live log (see "Live notes"), held keys closed
  // at now - for the piano roll's capture button. Body: { trackId }. The editor picks the window
  // and writes the notes (record.mjs's captureWindow / recordingToRoll).
  'POST /api/liveNotes': async (body) => {
    if (!engine || !transport) throw new Error(engineError ?? 'engine not loaded');
    const trackId = String(body.trackId ?? '');
    const now = transport.cycleAt(engine.getTime());
    return { status: 200, body: { events: liveEventsFor(trackId, -Infinity, now), now, transport: transport.snapshot() } };
  },

  // A one-off audition note from the piano roll editor. Body: { trackId, note, vel, isOn }. Unlike
  // keyNote it is NOT logged - a note auditioned while drawing is not a note played - but like it
  // the note goes straight to whatever track the pianoroll(...) block built, so it previews through
  // that track's own synth. If the track hasn't been evaluated (no instrument loaded), the engine
  // call simply makes no sound.
  'POST /api/previewNote': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const trackId = String(body.trackId ?? '');
    const note = Math.round(Number(body.note));
    if (!trackId || !Number.isFinite(note)) return { status: 200, body: { ok: false } };
    const now = engine.getTime();
    const tid = engineTrack(trackId);
    if (body.isOn) {
      const vel = Math.max(0, Math.min(1, Number(body.vel ?? 0.8)));
      if (vel > 0) engine.noteOn(tid, note, vel, now);
    } else {
      engine.noteOff(tid, note, now);
    }
    return { status: 200, body: { ok: true } };
  },

  // Introspection: real parameter names of the plugin in a track slot. Body: { trackId, slot }.
  'POST /api/params': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.getParams(engineTrack(body.trackId ?? 'default'), body.slot ?? 0) };
  },

  // Parameter lists for every plugin in the currently-evaluated chain, for the editor's
  // autocomplete and params panel. Loading a plugin is fire-and-forget (the eval response
  // doesn't wait for it), so a slot whose plugin is still opening is retried for a while
  // before giving up - the client calls this in the background right after an eval.
  'GET /api/chainParams': async () => {
    if (!engine || !mappedEngine) throw new Error(engineError ?? 'engine not loaded');
    const slots = [];
    for (const [trackId, chain] of mappedEngine.chains) {
      for (let slot = 0; slot < chain.length; slot++) {
        const plugin = chain[slot];
        if (!plugin) continue;
        if (!paramsByPlugin.has(plugin)) {
          try {
            paramsByPlugin.set(plugin, await getParamsWhenLoaded(trackId, slot));
          } catch (err) {
            slots.push({ track: trackLabel(trackId), slot, plugin, params: [], error: err.message ?? String(err) });
            continue;
          }
        }
        slots.push({ track: trackLabel(trackId), slot, plugin, params: paramsByPlugin.get(plugin) });
      }
    }
    return { status: 200, body: { slots } };
  },

  // Auto-pin drain (see captureDirtyPlugins): the plugin states captured since the last poll, for
  // the editor to write into their synth/fx calls as `{ state }` - or, when the slot was on a
  // named preset at the time, into that preset's definition instead (see writePluginState).
  // Draining on read means a
  // slot the editor already wrote isn't written again; a slot edited since is still pending
  // capture and arrives on a later poll. `logs` rides along on the same drain - the .log() event
  // lines fired since the last poll, in order, for the in-app console.
  'POST /api/pluginEdits': async (body) => {
    // `flush: true` means the editor is about to write the buffer out somewhere it matters -
    // saving, exporting, copying a share link - so a plugin edit still held back gets captured
    // now rather than writing out a stale state. The 500ms poll never asks for this.
    if (body?.flush) await flushPluginCaptures();
    // The preset panel's lease rides along on this poll rather than on a timer of its own - one
    // request either way, and a browser that stops polling releases what it was holding.
    if (body?.hold) setPresetHold(String(body.hold.trackId ?? ''), Number(body.hold.slot ?? 0), String(body.hold.preset ?? ''));
    expirePresetHolds();
    // The mixer's drag lease renews here too, and for a reason its own value posts can't cover: a
    // finger resting motionless on a fader emits no pointermove, so the drag alone would look
    // abandoned (see setChannelHold).
    if (body?.channelHold) {
      setChannelHold(String(body.channelHold.trackId ?? ''), String(body.channelHold.name ?? ''), Number(body.channelHold.value));
    }
    expireChannelHolds();
    // Hand editing, both halves, on the same poll and for the same reason (see that section):
    // `editing` renews the lease on every plugin window the editor has open, and `committed` says
    // which captures have reached the code - by sequence number, so the report of one capture can
    // never release a knob turned after it.
    for (const at of body?.committed ?? []) commitCapture(at);
    expireStateHolds();
    const logs = eventLogQueue.splice(0, eventLogQueue.length);
    const edits = [...autoPinReady.values()];
    autoPinReady.clear();
    // Slots deliberately left uncaptured (deferred mode, mid-performance), so the editor can say so
    // once rather than leave a plugin tweak looking like it went unnoticed. In immediate mode a
    // dirty slot is merely one whose debounce hasn't fired yet - nothing worth announcing.
    const holding = AUTOPIN_MODE === 'deferred' && !(transport?.paused ?? true) ? autoPinDirty.size : 0;
    // What is held right now, every poll, so the editor can draw it on the code and stop lighting
    // names that are not playing. Sent whole rather than as changes: it is a handful of entries,
    // and a poll that drops (or a tab that reloads) then costs nothing to recover from.
    return { status: 200, body: { edits, logs, pending: holding, holds: currentHolds() } };
  },

  // Hold one chain slot on a named preset while the editor's preset panel is open on it, so what
  // you hear is what you are editing (see Scheduler#holdPreset). Body: { trackId, slot, preset },
  // preset null to release. A preset is edited by turning the plugin's own knobs, so this is not a
  // convenience: without it a `.preset("<a b>")` swaps the sound out from under the edit.
  'POST /api/presetHold': async (body) => {
    const trackId = String(body?.trackId ?? '');
    const slot = Number(body?.slot ?? 0);
    const name = body?.preset == null ? null : String(body.preset);
    // Picking one in the panel is a deliberate "let me hear this", so it loads even over a plugin
    // you have been turning knobs in (see the hand-editing section) - but never before those knobs
    // have been captured, or the capture would read the preset you switched TO and file it under
    // the one you switched from. Only a real change pays for the capture; the poll's heartbeat
    // goes through the same function without this route.
    if (name != null && presetHolds.get(`${trackId}|${slot}`)?.preset !== name) await flushPluginCaptures();
    const why = setPresetHold(trackId, slot, name, { force: true });
    return { status: 200, body: { held: name, why } };
  },

  // Hold one channel-strip control at the value under a mixer fader/knob while it is dragged, so
  // riding it sounds instead of waiting for the release to write code and evaluate (see
  // Scheduler#holdChannel). Body: { trackId, name, value }, value null to release. Called on every
  // pointermove, so like /api/macros/set it deliberately touches nothing but the in-memory store -
  // the code write happens once, on release.
  'POST /api/channelHold': async (body) => {
    const trackId = String(body?.trackId ?? '');
    const name = String(body?.name ?? '');
    const value = body?.value == null ? null : Number(body.value);
    if (value != null && !Number.isFinite(value)) throw new Error('channelHold: value must be a number');
    const why = setChannelHold(trackId, name, value);
    return { status: 200, body: { held: value, why } };
  },

  // Pop open the native editor window of the plugin in a chain slot (design your supersaw in
  // Serum's own UI, then livecode the modulation). Body: { trackId, slot }.
  'POST /api/showEditor': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const trackId = body.trackId ?? 'default';
    const slot = body.slot ?? 0;
    engine.showPluginEditor(engineTrack(trackId), slot);
    // The window is up, so the slot's program is yours to change from here: take it now rather than
    // on the editor's next poll, or a swap in between would change the preset out from under the
    // window you just opened - and a knob turned after that would land in the wrong preset.
    takeSlotByHand(trackId, slot);
    return { status: 200, body: {} };
  },

  // "I'm back in the code" - the editor sends this on a click in the buffer, and every slot being
  // held by hand goes back to its pattern (see the hand-editing section). No body: a click is not
  // about one slot, it is about which of the two places you are working in.
  'POST /api/releaseEditors': async () => ({ status: 200, body: { released: releaseSlotsHeldByHand() } }),

  // Turn "conf" (configure) capture on/off for a track (see handleParamAutomated). Only one
  // track configures at a time; turning it on for a track supersedes any previous one. Body:
  // { trackId, on }.
  'POST /api/confMode': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const trackId = body.trackId ?? 'default';
    if (conf && conf.trackId !== trackId) engine.setConfMode(engineTrack(conf.trackId), false); // release the previous track
    conf = body.on ? { trackId, touched: new Map(), seen: new Set() } : null;
    engine.setConfMode(engineTrack(trackId), !!body.on);
    return { status: 200, body: { on: !!body.on, trackId } };
  },

  // Drain the parameters touched since the last poll while conf mode is on: the editor polls this
  // and writes each into the code. Returns latest-value-per-param (coalesced), then clears, so a
  // knob swept between polls lands once at its final position. Body: { trackId }.
  'POST /api/confPending': async (body) => {
    const trackId = body.trackId ?? 'default';
    if (!conf || conf.trackId !== trackId) return { status: 200, body: { active: false, params: [] } };
    const params = [...conf.touched.values()];
    conf.touched.clear();
    return { status: 200, body: { active: true, params } };
  },

  // --- pattern files (the editor's "files" tab) ---

  // Query: { q } - free text matched against name, @title, @by, @tags and the code itself
  // (`tag:techno`, `by:aria` restrict a term to one field). Returns named saves and
  // work-in-progress sessions separately, newest first. Searching happens here rather than in
  // the browser because it reads file contents.
  'GET /api/patterns': async (query) => {
    const q = query?.q ?? '';
    const keep = (entries) => entries
      .filter((e) => matchesQuery(e, q))
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ code, ...rest }) => rest); // the buffer was only needed for searching
    return { status: 200, body: { patterns: keep(listSavedPatterns()), wip: keep(listWipPatterns()) } };
  },

  // Body: { name, code }. Overwrites silently - "save" in a livecoding tool means "keep this".
  //
  // Written HYDRATED: a saved pattern is a file someone can hand to someone else, or drop into
  // another machine's patterns folder, so it carries its captured plugin states in full rather
  // than handles into a store that machine hasn't got (see blobs.js).
  'POST /api/patterns/save': async (body) => {
    const file = patternFilePath(body.name);
    const { code, missing } = await blobs.hydrate(String(body.code ?? ''));
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
    fs.writeFileSync(file, code, 'utf8');
    // Saved anyway: the patch is worth more than the states it couldn't fill in, and the handles
    // are still in the file - if the store turns up, so do the sounds. But say so.
    return { status: 200, body: { missingStates: missing.length } };
  },

  // Body: { name } -> { code }. The file holds its states in full; the editor is given handles in
  // their place, so the buffer it copies on every keystroke stays kilobytes (see blobs.js). The
  // states themselves are put in the store on the way past, which is also how a patch from another
  // machine gets its programs in here.
  'POST /api/patterns/load': async (body) => {
    const file = patternFilePath(body.name);
    if (!fs.existsSync(file)) throw new Error(`no saved pattern named "${body.name}"`);
    const { code } = await blobs.dehydrate(fs.readFileSync(file, 'utf8'));
    return { status: 200, body: { code } };
  },

  // Body: { name }.
  'POST /api/patterns/delete': async (body) => {
    const file = patternFilePath(body.name);
    if (!fs.existsSync(file)) throw new Error(`no saved pattern named "${body.name}"`);
    fs.unlinkSync(file);
    return { status: 200, body: {} };
  },

  // Body: { from, to }.
  'POST /api/patterns/rename': async (body) => {
    const from = patternFilePath(body.from);
    const to = patternFilePath(body.to);
    if (!fs.existsSync(from)) throw new Error(`no saved pattern named "${body.from}"`);
    if (fs.existsSync(to)) throw new Error(`a pattern named "${body.to}" already exists`);
    fs.renameSync(from, to);
    // The rename follows the song into every playlist that plays it - a set is a list of names,
    // and the name just changed. (A DELETE deliberately does not do this: the slot stays and
    // renders as missing; the playlist is the user's document, not an index to repair.)
    const lib = readLibrary();
    let inSets = false;
    for (const p of lib.playlists) {
      p.items = p.items.map((k) => (k === body.from ? ((inSets = true), String(body.to)) : k));
    }
    if (inSets) writeLibrary(lib);
    return { status: 200, body: {} };
  },

  // --- the library (playlists; see pattern-files.js) ---

  // The whole document both ways: the client edits its copy and posts it back coalesced (a drag
  // through a playlist is one write, not one per row). POST returns what was actually kept, so
  // the client's copy converges on the normalized truth.
  'GET /api/library': async () => ({ status: 200, body: readLibrary() }),
  'POST /api/library': async (body) => ({ status: 200, body: writeLibrary(body) }),

  // --- work in progress (the editor autosaves the live buffer here; see wipFilePath) ---

  // Body: { id, code }. Called on a debounce while typing, so it must stay cheap and must never
  // be the thing that interrupts a jam - a blank buffer deletes the session file instead of
  // leaving an empty one behind, and that's the only way a WIP file is removed automatically.
  // Autosave fires every second or so while the user types, and this process also runs the
  // pattern scheduler - so the write is async. Synchronously writing a buffer carrying captured
  // plugin state is milliseconds the scheduler spends not sending notes, against a 150ms
  // lookahead, several times a minute.
  'POST /api/patterns/wip/save': async (body) => {
    const file = wipFilePath(body.id);
    // Machine-local scratch, so it keeps handles - and a buffer that somehow holds states in full
    // (a pasted patch) gives them up here rather than being written out at that size every second
    // or so. This is the write that left 519MB of autosaves on one month of playing.
    const { code } = await blobs.dehydrate(String(body.code ?? ''));
    // The freshest sighting of what the editor is holding, and a complete one - this is the whole
    // buffer - so it replaces rather than adds. It fires a second after a capture is written into
    // the code, where an eval can be an hour later, which is what makes it safe for the sweep's age
    // floor to be short.
    liveStateIds.a = blobs.referencedIds(code); // the wip autosave is the MAIN editor's buffer (deck b's arrives with phase 4)
    if (!code.trim()) {
      await fs.promises.unlink(file).catch(() => {}); // already gone is the wanted state
      return { status: 200, body: { saved: false } };
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, code, 'utf8');
    return { status: 200, body: { saved: true } };
  },

  // Code snapshots - what the editor's URL points at (see snapshots.js). The buffer used to be
  // base64'd into the hash itself, which put a megabyte-URL pushState in front of every eval.
  // Body: { code } -> { id }.
  'POST /api/snapshot': async (body) => {
    // Handles, like the wip autosave and for the same reason: a snapshot is one checkpoint of a
    // buffer that is machine-local by definition (its id means nothing anywhere else).
    const { code } = await blobs.dehydrate(String(body.code ?? ''));
    const id = await putSnapshot(code);
    schedulePrune();
    return { status: 200, body: { id } };
  },

  // Query: { id } -> { code } - or { code: null } for a state pruned away or from another
  // machine, which the editor reports rather than treating as an empty buffer.
  'GET /api/snapshot': async (q) => {
    const code = await getSnapshot(q.id);
    // Snapshots written before the store existed hold their states in full - they are stored on the
    // way back out, so walking Back through old history entries lightens them as it goes.
    return { status: 200, body: { code: code == null ? null : (await blobs.dehydrate(code)).code } };
  },

  // Body: { id } -> { code }. Dehydrated like the saved-pattern load, for the sessions recorded
  // before the store existed.
  'POST /api/patterns/wip/load': async (body) => {
    const file = wipFilePath(body.id);
    if (!fs.existsSync(file)) throw new Error(`no work-in-progress session "${body.id}"`);
    const { code } = await blobs.dehydrate(fs.readFileSync(file, 'utf8'));
    return { status: 200, body: { code } };
  },

  // Body: { id }.
  'POST /api/patterns/wip/delete': async (body) => {
    const file = wipFilePath(body.id);
    if (!fs.existsSync(file)) throw new Error(`no work-in-progress session "${body.id}"`);
    fs.unlinkSync(file);
    return { status: 200, body: {} };
  },

  // The editor's own two crossings of the same line the routes above handle for it.
  //
  // Body: { code } -> { code, missing } - captured states filled back in, for the file the export
  // action hands to the browser. `missing` names handles this store hasn't got, which the editor
  // reports rather than passing off a patch with silent holes in it as the whole thing.
  'POST /api/blobs/hydrate': async (body) => {
    const { code, missing } = await blobs.hydrate(String(body?.code ?? ''));
    return { status: 200, body: { code, missing } };
  },

  // Body: { code } -> { code, stored } - the reverse, for a patch arriving from outside (an
  // imported file, a pasted buffer): its states go into the store and the editor gets handles.
  'POST /api/blobs/dehydrate': async (body) => {
    const { code, stored } = await blobs.dehydrate(String(body?.code ?? ''));
    return { status: 200, body: { code, stored } };
  },

  // Query: { id } -> { bytes } - what one stored state weighs, which the buffer can no longer say
  // now that it only holds the handle. `bytes: null` for one this store hasn't got.
  'GET /api/blobs/stat': async (q) => {
    const state = await blobs.getBlob(q?.id);
    return { status: 200, body: { bytes: state == null ? null : state.length } };
  },

  // --- prebake (the settings tab's "edit prebake" panel; see runPrebake) ---

  'GET /api/prebake': async () => ({ status: 200, body: { code: readPrebakeFile() } }),

  // Body: { code }. Overwrites prebake.js and re-runs all prebake sources immediately, so an edit
  // applies without a restart. Returns per-block errors (empty on success) for the editor to show.
  // (Removing a Signal.prototype extension still needs a restart - the prototype keeps it.)
  'POST /api/prebake': async (body) => {
    fs.mkdirSync(path.dirname(PREBAKE_FILE), { recursive: true });
    fs.writeFileSync(PREBAKE_FILE, String(body.code ?? ''), 'utf8');
    return { status: 200, body: { errors: runPrebake() } };
  },

  // --- MIDI record (see the "MIDI record" section above) ---

  // Arm a recording. Body: { cycles, grid } - grid is slots per cycle (16 = sixteenth notes at
  // 4 beats/cycle), 0 = unquantized; it is carried back out in the status for the editor, which
  // does the quantizing (into a roll). Starts at the next phrase boundary, pushed on to a multiple
  // of the length for power-of-two takes (see recordStartCycle); the response carries start/end
  // cycles + a transport snapshot so the editor renders the count-in locally.
  'POST /api/midiRecord/start': async (body) => {
    if (!engine || !transport) throw new Error(engineError ?? 'engine not loaded');
    if (midiRec && midiRec.phase !== 'done') throw new Error('a MIDI recording is already armed or running - cancel it first');
    const cycles = Math.min(64, Math.max(1, Math.round(Number(body.cycles) || 4)));
    const grid = Math.max(0, Math.round(body.grid == null ? 16 : Number(body.grid) || 0));
    const armCycle = transport.cycleAt(engine.getTime());
    const startCycle = patternCore.recordStartCycle(armCycle, cycles, PHRASE_CYCLES);
    if (midiRec?.timer) clearInterval(midiRec.timer);
    midiRec = {
      phase: 'armed',
      armCycle,
      startCycle,
      endCycle: startCycle + cycles,
      cycles,
      grid,
      results: null,
      timer: setInterval(midiRecTick, 50),
    };
    return { status: 200, body: midiRecStatus() };
  },

  'GET /api/midiRecord/status': async () => ({ status: 200, body: midiRecStatus() }),

  // Abort an armed/running recording, or acknowledge a finished one (clears its results).
  'POST /api/midiRecord/cancel': async () => {
    if (midiRec?.timer) clearInterval(midiRec.timer);
    midiRec = null;
    return { status: 200, body: {} };
  },

  // Bounce the master bus to a WAV. Body: { path, seconds }.
  'POST /api/record': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    return { status: 200, body: await engine.record(body.path, body.seconds ?? 4) };
  },

  // --- track record (see the "Track record" section above) ---

  // Open/close a track's meter tap. Body: { label, on }. The editor calls this when a .record()
  // panel opens and closes; it's what makes the panel's meter live before anything is armed.
  'POST /api/trackRecord/tap': async (body) => {
    const label = String(body.label ?? '').trim();
    if (!label) throw new Error('trackRecord/tap needs a block label');
    setRecTap(label, body.on !== false);
    return { status: 200, body: trackRecStatus() };
  },

  // Arm a bounce of one labeled block. Body: { label, cycles, name, wrapTail }. Starts at the next
  // phrase boundary that leaves room for the pre-roll; the response carries the start/end cycles so
  // the editor can draw the count-in against its own copy of the transport.
  // --- the performance mixer (two decks + the DJ stage; see TODO.md) ---

  // The mix session's state, for the UI to (re)build from. `?desk=1` returns only the desk
  // values (no per-track rows) - the shape the client polls at ~150ms to mirror MIDI-driven
  // knob moves smoothly, so it must stay cheap.
  'GET /api/mix': async (query) => ({
    status: 200,
    body: {
      ...mixDeskBody(),
      tracks: query?.desk ? undefined : [...mixKeys()].map((key) => ({
        key,
        deck: deckOfKey(key),
        controls: Object.fromEntries(mixState.perTrack.get(key) ?? []),
      })),
    },
  }),

  // MIDI-learn for a desk control. Body: { target } arms a learn and waits (long-poll) for the
  // next CC anywhere -> { learned: { device, channel, cc } }, or { learned: null } after 10s.
  // { target, clear: true } unbinds it. Targets: 'xf' or '<deck>:<control>' ("a:djf").
  'POST /api/mix/midilearn': async (body) => {
    const target = String(body.target ?? '');
    if (!MIX_MIDI_TARGETS.has(target)) throw new Error(`"${target}" is not a learnable mix control`);
    if (body.clear) {
      if (settings.mixMidi?.[target]) {
        delete settings.mixMidi[target];
        saveSettings();
      }
      return { status: 200, body: { cleared: true } };
    }
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    engine.enableMidi();
    if (mixMidiLearn) {
      clearTimeout(mixMidiLearn.timer);
      mixMidiLearn.finish(null); // a new arm supersedes a stale one
    }
    const learned = await new Promise((resolve) => {
      mixMidiLearn = {
        target,
        finish: resolve,
        timer: setTimeout(() => {
          if (mixMidiLearn?.finish === resolve) mixMidiLearn = null;
          resolve(null);
        }, 10000),
      };
    });
    return { status: 200, body: { learned } };
  },

  // Tempo migration: move the shared clock (all decks, one Transport) toward a bpm - instantly
  // (the slider ride) or as a glide over `seconds` (the detent buttons). Body: { bpm, seconds? }
  // or { deck: 'a'|'b', seconds? } to target that deck's native tempo. Cycle position stays
  // continuous through the whole ramp (Transport#rampBpm rebases every step) - nothing jumps,
  // nothing re-triggers, multi-cycle structures keep their phase. Ephemeral like the rest of
  // the desk: from the first touch, song-code setbpm stops driving the clock (see mixState).
  'POST /api/mix/tempo': async (body) => {
    if (!transport) throw new Error(engineError ?? 'engine not loaded');
    let bpm = Number(body.bpm);
    if (body.deck === 'a' || body.deck === 'b') {
      const native = deckNativeBpm(body.deck); // 120 when the deck's track specifies nothing
      if (native == null) {
        throw new Error(`deck ${body.deck}'s tempo is signal-driven - no single native bpm to migrate to`);
      }
      bpm = native;
    }
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400) throw new Error('mix/tempo: bpm must be 20..400');
    const seconds = Math.min(600, Math.max(0, Number(body.seconds) || 0));
    const from = transport.cps * 240;
    mixState.tempoOverride = bpm;
    transport.rampBpm(bpm, seconds);
    mixNotify();
    return { status: 200, body: { from, bpm, seconds } };
  },

  // Set DJ-stage controls, ephemerally (never into code). Body: one { name, value, key? | deck? }
  // or { targets: [...] } of them. A `deck` target broadcasts to every track of that deck AND is
  // remembered for tracks its later evals create; a `key` target is one track's own (and wins
  // over the broadcast).
  'POST /api/mix/set': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    applyMixTargets(Array.isArray(body.targets) ? body.targets : [body]);
    return { status: 200, body: { ok: true } };
  },

  // Swap mode. Body: { on }. With it on, gating a stem IN throws the other deck's same-named
  // stem OUT in the same gesture (see /api/mix/gate) - the phase-continuous stem swap.
  'POST /api/mix/swap': async (body) => {
    mixState.swap = !!body.on;
    // The crossfader curve follows the toggle (see xfGain): re-derive both deck gains from the
    // current fader position under the new curve, so flipping swap is audible immediately.
    if (engine) applyMixTargets([{ name: 'xf', value: mixState.xf }]); // notifies
    else mixNotify();
    return { status: 200, body: { swap: mixState.swap } };
  },

  // Gate one stem in or out (its DJ fader, 1 or 0). In swap mode, gating IN also gates the
  // other deck's same-named stem out - the phase-continuous stem swap. Body: { key, on }.
  'POST /api/mix/gate': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const key = String(body.key ?? '');
    if (!isMixKey(key)) throw new Error(`mix/gate: no playing track "${key}"`);
    const on = !!body.on;
    mixGateSet(key, on);
    // The swap counter runs BOTH ways: gating a stem IN throws its same-named twin out, and
    // gating it back OUT brings the twin back in - so a swap can be toggled back and forth to
    // audition either song's version of the stem.
    let countered = null;
    if (mixState.swap) {
      const base = deckOfKey(key) === 'a' ? key : key.slice(key.indexOf(':') + 1);
      const other = deckOfKey(key) === 'a' ? `b:${base}` : base;
      if (schedulers.has(other)) {
        mixGateSet(other, !on);
        countered = other;
      }
    }
    mixNotify();
    return { status: 200, body: { key, on, countered } };
  },

  // Solo within a deck (cmd+click a gate). Body: { key, add }.
  //   - a stem not yet soloed: it becomes THE solo, every other stem on the deck gating out -
  //     so cmd+clicking another stem mid-solo SWAPS the solo over to it, however many were in
  //     it. With `add` (cmd+shift+click) it joins them instead.
  //   - a soloed stem: it leaves the solo. If others remain they keep playing without it; if it
  //     was the last, the deck returns to the faders it had before the first solo - so taking a
  //     multi-solo apart one stem at a time ends exactly where dismissing it whole does.
  // Deck-local: the other deck is never touched, swap mode or not - a solo is for auditioning
  // a part, not for swapping it. -> { key, deck, solo: [keys soloed after the gesture] }.
  'POST /api/mix/solo': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const key = String(body.key ?? '');
    if (!isMixKey(key)) throw new Error(`mix/solo: no playing track "${key}"`);
    const deck = deckOfKey(key);
    const solo = mixState.solo[deck];
    if (solo.has(key)) {
      solo.delete(key);
      if (solo.size === 0) mixSoloEnd(deck);
      else mixSetFader(key, 0);
    } else {
      if (!mixState.soloPrev[deck]) { // first solo on this deck: remember what to come back to
        const prev = new Map();
        for (const k of mixKeys()) if (deckOfKey(k) === deck) prev.set(k, mixState.perTrack.get(k)?.get('fader') ?? 1);
        mixState.soloPrev[deck] = prev;
      }
      if (!body.add) solo.clear();
      solo.add(key);
      for (const k of mixKeys()) if (deckOfKey(k) === deck) mixSetFader(k, solo.has(k) ? 1 : 0);
    }
    mixNotify();
    return { status: 200, body: { key, deck, solo: [...solo] } };
  },

  // Gate every stem on one deck out at once (the deck head's `mute all`) - see mixGateAll.
  // Body: { deck }.
  'POST /api/mix/gateall': async (body) => {
    if (!engine) throw new Error(engineError ?? 'engine not loaded');
    const deck = body.deck === 'b' ? 'b' : 'a';
    const gated = mixGateAll(deck);
    mixNotify();
    return { status: 200, body: { deck, gated } };
  },

  // Empty ONE deck - a pane is loading a different song (DJ mode's load button). The old song's
  // schedulers stop, its engine tracks are destroyed (plugins closed: switching songs all night
  // must not accumulate a set's worth of idle plugins), and its song facts and definitions go.
  // The DESK (crossfader, deck gains, EQ, swap, tempo) stays exactly as it stands - clearing a
  // deck mid-mix is part of the performance, not the end of it. Body: { deck }.
  'POST /api/mix/clear': async (body) => {
    if (!mappedEngine) throw new Error(engineError ?? 'engine not loaded');
    const deck = body.deck === 'b' ? 'b' : 'a';
    songUnload(deck); // buffer freed before the track sweep below destroys the track itself
    for (const [key, sch] of [...schedulers]) {
      if (deckOfKey(key) !== deck) continue;
      sch.stop();
      schedulers.delete(key);
      mappedEngine.removeChain(engineTrack(key));
      dropTrack(key);
    }
    for (const key of [...trackIds.keys()]) if (deckOfKey(key) === deck) dropTrack(key);
    mixState.solo[deck].clear();
    mixState.soloPrev[deck] = null;
    decks[deck] = { scale: null, bpm: null };
    if (deck === 'a') patternCore.setGlobalScale(null); // the resting scale was this deck's fact
    liveStateIds[deck] = new Set();
    patternCore.clearRolls('buffer', deck);
    mixNotify();
    return { status: 200, body: {} };
  },

  // Eject the queued deck - abort the mix. Deck b's schedulers stop through the normal teardown,
  // its engine tracks are destroyed (plugins closed), its song-level facts and definitions are
  // forgotten, and the performance state resets: deck a comes back to a clean desk.
  'POST /api/mix/eject': async () => {
    if (!mappedEngine) throw new Error(engineError ?? 'engine not loaded');
    songUnload('b'); // the queued song goes with its deck; the track dies in the sweep below
    for (const [key, sch] of [...schedulers]) {
      if (deckOfKey(key) !== 'b') continue;
      sch.stop();
      schedulers.delete(key);
      mappedEngine.removeChain(engineTrack(key));
      dropTrack(key);
    }
    for (const key of [...trackIds.keys()]) if (deckOfKey(key) === 'b') dropTrack(key);
    mixState.perDeck.a.clear();
    mixState.perDeck.b.clear();
    mixState.perTrack.clear();
    mixState.xf = -1; // desk home: the next mix session re-arms from hard-A
    mixState.faders = { a: 1, b: 1 };
    if (mixState.tempoOverride != null) {
      mixState.tempoOverride = null;
      // The surviving deck gets its declared tempo back - as a short glide, not a lurch (it is
      // still playing). A signal tempo re-installs itself; no declaration means the deck's
      // native is the 120 default, and the clock glides home to that.
      if (decks.a.bpm != null && typeof decks.a.bpm !== 'number') transport?.setBpm(decks.a.bpm);
      else if (deckNativeBpm('a') != null) transport?.rampBpm(deckNativeBpm('a'), 2);
    }
    for (const key of mixKeys()) neutralizeMix(key);
    decks.b = { scale: null, bpm: null };
    liveStateIds.b = new Set();
    patternCore.clearRolls('buffer', 'b');
    mixNotify();
    return { status: 200, body: {} };
  },

  // Complete the mix: the queued song IS the set now. The outgoing deck's tracks stop and are
  // destroyed; deck b's schedulers, holds, highlights and definitions re-key to plain labels
  // with ZERO engine churn (the opaque-track-id payoff: the music doesn't blink); its scale and
  // native tempo become the main deck's facts; the performance state resets to neutral. The
  // client then loads deck b's code into the main editor and re-evals as deck a, which finds
  // every track already playing under its new name and reprograms nothing.
  'POST /api/mix/complete': async () => {
    if (!mappedEngine) throw new Error(engineError ?? 'engine not loaded');
    const promoted = [...schedulers.keys()].filter((k) => deckOfKey(k) === 'b');
    if (!promoted.length) throw new Error('deck b has nothing playing - nothing to promote');
    songUnload('a'); // the outgoing song (if any) goes with its deck...
    for (const [key, sch] of [...schedulers]) {
      if (deckOfKey(key) !== 'a') continue;
      sch.stop();
      schedulers.delete(key);
      mappedEngine.removeChain(engineTrack(key));
      dropTrack(key);
    }
    if (trackIds.has(SONG_KEYS.a)) dropTrack(SONG_KEYS.a); // ...its track too (it has no scheduler)
    // A song riding deck b is promoted alongside the stems: re-keyed BEFORE the leftovers sweep
    // below, or it would be destroyed as never-promoted. Playback and the engine never blink.
    if (songDecks.b) {
      rekeyTrack(SONG_KEYS.b, SONG_KEYS.a);
      songDecks.a = songDecks.b;
      songDecks.b = null;
    }
    for (const key of promoted) rekeyTrack(key, key.slice(key.indexOf(':') + 1));
    for (const key of [...trackIds.keys()]) if (deckOfKey(key) === 'b') dropTrack(key); // never-promoted leftovers
    decks.a = { ...decks.b };
    decks.b = { scale: null, bpm: null };
    patternCore.setGlobalScale(decks.a.scale ?? null);
    liveStateIds.a = liveStateIds.b;
    liveStateIds.b = new Set();
    patternCore.clearRolls('buffer', 'a'); // the outgoing song's definitions
    patternCore.adoptDefs('b', 'a'); // the promoted song's are the main deck's now
    for (const [prop, o] of protoOwners) if (o.deck === 'b') protoOwners.set(prop, { ...o, deck: 'a' });
    mixState.perDeck.a.clear();
    mixState.perDeck.b.clear();
    mixState.perTrack.clear();
    mixState.xf = -1; // desk home: the next mix session re-arms from hard-A
    mixState.faders = { a: 1, b: 1 };
    // The promoted song's declared tempo takes over on the client's promotion re-eval (override
    // gone, its setbpm drives again) - a no-op when the migration already landed on its native.
    mixState.tempoOverride = null;
    for (const key of mixKeys()) neutralizeMix(key);
    mixNotify();
    return { status: 200, body: { promoted: promoted.map((k) => k.slice(k.indexOf(':') + 1)) } };
  },

  // --- song decks (files on a DJ deck - see the song section near mixState) ---

  // Load a file onto a deck's song track, replacing whatever song it held. Body: { deck, path,
  // bpm?, title?, key? }. wav/aiff/flac load directly; mp3/m4a/aac/caf go through the afconvert
  // cache (~/.poptart/cache/songs). The track is created (or reused) wearing the desk's current
  // state, so a song queued onto deck b arrives silent exactly like a queued pattern deck.
  // The song's native bpm - the playlist item's if it says, the file's own tags otherwise
  // (ID3 TBPM/TKEY, vorbis comments, mp4 tmpo - see song-tags.js) - feeds decks[].bpm, which is
  // what lets /api/mix/tempo migrate toward it; rate-lock (sync) defaults on when it's known.
  // Everything stays editable via /api/song/meta.
  'POST /api/song/load': async (body) => {
    if (!engine || !mappedEngine) throw new Error(engineError ?? 'engine not loaded');
    const deck = body.deck === 'b' ? 'b' : 'a';
    const key = SONG_KEYS[deck];
    const srcPath = String(body.path ?? '');
    const resolved = await resolveSongFile(srcPath);
    if (songDecks[deck]) songMarkPaused(deck); // stop the old song's timers before its buffer goes
    const tid = claimEngineTrack(key);
    mappedEngine.createTrack(tid, mixBirthFor(key)); // idempotent - a reload keeps the track warm
    const meta = await mappedEngine.songLoad(tid, resolved.path);
    const duration = meta.sampleRate > 0 ? meta.frames / meta.sampleRate : 0;
    const tags = readSongTags(srcPath);
    const bodyBpm = Number(body.bpm);
    const bpm = Number.isFinite(bodyBpm) && bodyBpm >= 20 && bodyBpm <= 400 ? bodyBpm : tags.bpm;
    songDecks[deck] = {
      path: srcPath,
      title: String(body.title ?? '').trim() || path.basename(srcPath),
      duration,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      frames: meta.frames,
      decoded: resolved.decoded,
      rate: 1,
      playing: false,
      posSec: 0,
      startSec: 0,
      endTimer: null,
      // The musical facts (songs phase 4) - the playlist item's word beats the file's tags,
      // and /api/song/meta edits any of it later.
      bpm,
      musicalKey: String(body.key ?? '').trim() || tags.key,
      anchorSec: 0,
      anchorByHand: false, // an anchor pressed by hand outlives the analysis' guess
      gridDetected: null, // confidence of the fitted beatgrid (null until analyzed / when it failed)
      onsets: null, // transient times (seconds) the anchor and cue gestures snap to
      sync: bpm != null,
      syncMult: 'auto', // tempo octave for sync: 'auto' | 0.5 | 1 | 2 (see songSync.syncOctave)
      keylock: false,
      manualRate: 1,
      nudge: 0,
      servo: 0,
      cueSec: 0, // the CUE gesture's home (see songCue) - the top until a press while paused moves it
      cueHeld: false,
    };
    decks[deck].bpm = bpm; // null included: an untagged song reads as the 120 default, never the previous track's
    songApplyRate(deck); // not playing: just settles s.rate so the pane's readout is honest
    mixNotify();
    songDetectKick(deck); // fire-and-forget: fills any fact still missing, once analyzed (phase 5)
    return {
      status: 200,
      body: {
        deck, key, duration, sampleRate: meta.sampleRate, channels: meta.channels,
        decoded: resolved.decoded, bpm, musicalKey: songDecks[deck].musicalKey, sync: songDecks[deck].sync,
      },
    };
  },

  // Start playback. Body: { deck, pos? (seconds; default: resume where it stands, or the top
  // after EOF), rate? (manual rate when not synced; 1 = native), now? (skip quantization) }.
  //
  // With the shared clock running, the start lands on the next cycle boundary - a song against
  // a playing deck joins the grid the way a deck-b eval does - and a synced song (phase 4)
  // snaps its own entry point to the nearest BAR of its beatgrid, so the material entering at
  // that boundary is a downbeat. With rate locked to master/native the two grids then stay in
  // step, bar for bar.
  //
  // With NOTHING ELSE PLAYING there is no grid to join, so a synced song becomes the master:
  // it starts immediately, the clock takes its native tempo (so it plays at rate 1 and the
  // other deck stretches to it - unless the hand has already moved the tempo), and the
  // transport is re-based with its cycle boundaries on this song's bar lines
  // (Transport#startAt). This is what makes two songs mix. Only patterns used to start the
  // clock, so a pair of song decks left it frozen forever: the second deck found
  // `transport.paused` true, skipped the quantization AND the beat snap, and started the
  // instant the key was pressed - the two decks could only ever be in time by luck.
  //
  // A joining deck starts FROM ITS CUE, exactly - never from somewhere near it - and waits
  // for the moment the clock's bar phase equals the cue's own (a downbeat cue waits for the
  // next downbeat; a beat-three cue for the next beat three): a bar at most, bar-aligned. An
  // earlier cut moved the entry point instead to shorten the wait, and a play that jumps
  // ahead of the cue you just set is exactly the wrong kind of surprise.
  'POST /api/song/play': async (body) => {
    if (!engine || !transport) throw new Error(engineError ?? 'engine not loaded');
    const deck = body.deck === 'b' ? 'b' : 'a';
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    const rate = Number(body.rate);
    if (Number.isFinite(rate) && rate > 0.01 && rate <= 4) s.manualRate = rate;
    const pos = Number(body.pos);
    let from = Number.isFinite(pos)
      ? Math.min(Math.max(0, pos), s.duration)
      : (s.posSec >= s.duration ? 0 : s.posSec);
    const now = engine.getTime();
    let startSec = now + SONG_START_LEAD_SEC;
    const others = othersPlaying(deck);
    // Grid-master: nothing else is on the clock, and this song knows where its bars are. When
    // it doesn't (no bpm, or sync deliberately off) it runs free and the response says so -
    // the next deck up will have nothing to lock onto, and that is worth a word.
    const takeGrid = !others && s.sync && !!s.bpm;
    // Before the rate is read: the master's native tempo IS the clock.
    if (takeGrid) {
      songMasterDeck = deck;
      if (mixState.tempoOverride == null) transport.setBpm(s.bpm);
    }
    if (others && !body.now) {
      const earliest = transport.cycleAt(now + SONG_START_LEAD_SEC);
      let startCycle;
      if (s.sync && s.bpm) {
        // The next clock position with the cue's bar phase.
        const phase = songSync.gridPhase(from, songGridBpm(deck), s.anchorSec);
        startCycle = Math.floor(earliest - phase) + phase;
        if (startCycle < earliest) startCycle += 1;
      } else {
        const beat = 1 / songSync.BEATS_PER_CYCLE; // no grid: at least land on a beat
        startCycle = Math.ceil(earliest / beat) * beat;
      }
      startSec = transport.secAt(startCycle);
    }
    s.nudge = 0;
    s.servo = 0;
    s.cueHeld = false; // a real start supersedes a preview - its release must not yank us home
    s.rate = songSync.effectiveRate(songBaseRate(deck), 0);
    engine.songStart(engineTrack(SONG_KEYS[deck]), from, s.rate, startSec, s.keylock ? 1 : 0);
    s.posSec = from;
    s.startSec = startSec;
    s.playing = true;
    if (takeGrid) {
      // The clock resumes with this song's bar position AS its cycle position, so from here the
      // shared grid is this record's grid: the other deck's song quantizes onto its downbeats,
      // and so does any eval. The entry point itself is left exactly where the hand put it -
      // it's the grid that moves to the music, not the music to the grid.
      // Cycle 1, not 0: the start is a lead ahead of `now`, and reading the clock in that
      // window (an eval landing between the two) must not come back with a negative position.
      transport.startAt(startSec, 1 + songSync.gridPhase(from, songGridBpm(deck), s.anchorSec));
      syncVstTransport(); // plugins' host transport just jumped - don't wait out the 4s timer
    }
    songArmEndTimer(deck);
    mixNotify();
    return {
      status: 200,
      body: { deck, pos: from, rate: s.rate, startSec, master: takeGrid, bpm: transport.cps * 240, gridless: !others && !takeGrid },
    };
  },

  // The CUE gesture: press-and-hold previews from the cue point, release drops the playhead
  // back on it, paused. Body: { deck, hold (true = press, false = release), pos? }. `pos` is
  // where the PANE shows the playhead - on a paused deck that is where the cue goes, whatever
  // this side's model says: the hand acted on what it saw. See songCue.
  'POST /api/song/cue': async (body) => {
    const deck = body.deck === 'b' ? 'b' : 'a';
    const s = songDecks[deck];
    const pos = Number(body.pos);
    if (s && !s.playing && body.hold && Number.isFinite(pos) && Math.abs(pos - s.posSec) > 0.001) {
      // eslint-disable-next-line no-console
      console.warn(`[song] deck ${deck} pane showed ${pos.toFixed(3)}s but the model had ${s.posSec.toFixed(3)}s - taking the pane's`);
      s.posSec = Math.min(Math.max(0, pos), s.duration);
    }
    return { status: 200, body: songCue(deck, !!body.hold) };
  },

  // Pause where it stands; /api/song/play resumes from there. Body: { deck }.
  'POST /api/song/pause': async (body) => {
    const deck = body.deck === 'b' ? 'b' : 'a';
    if (!songDecks[deck]) throw new Error(`deck ${deck} has no song loaded`);
    songDecks[deck].cueHeld = false;
    songPause(deck);
    mixNotify();
    return { status: 200, body: { deck, pos: songDecks[deck].posSec } };
  },

  // Jump the playhead. Body: { deck, pos (seconds) }. Click-free while playing (the player
  // seeks in place); while paused it just moves the resume point.
  'POST /api/song/seek': async (body) => {
    const deck = body.deck === 'b' ? 'b' : 'a';
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    const pos = Number(body.pos);
    if (!Number.isFinite(pos)) throw new Error('song/seek needs pos (seconds)');
    const to = Math.min(Math.max(0, pos), s.duration);
    if (s.playing && engine) {
      engine.songSeek(engineTrack(SONG_KEYS[deck]), to, 0);
      s.posSec = to;
      s.startSec = engine.getTime();
      if (s.servo) {
        s.servo = 0; // the drift the trim was closing jumped away with the playhead
        songSendRate(deck);
      }
      songArmEndTimer(deck);
    } else {
      s.posSec = to;
    }
    // eslint-disable-next-line no-console
    console.log(`[song] deck ${deck} seek -> ${to.toFixed(3)}s (${s.playing ? 'playing' : 'paused'})`);
    mixNotify();
    return { status: 200, body: { deck, pos: to } };
  },

  // Stop and rewind to the top (the song stays loaded); { unload: true } forgets it entirely
  // (buffer freed - the track stays warm for the next load). Body: { deck, unload? }.
  'POST /api/song/stop': async (body) => {
    const deck = body.deck === 'b' ? 'b' : 'a';
    if (!songDecks[deck]) throw new Error(`deck ${deck} has no song loaded`);
    songDecks[deck].cueHeld = false;
    if (engine) {
      try { engine.songStop(engineTrack(SONG_KEYS[deck]), 0); } catch { /* engine between restarts */ }
    }
    songMarkPaused(deck, 0);
    if (body.unload) songUnload(deck);
    mixNotify();
    return { status: 200, body: { deck, unloaded: !!body.unload } };
  },

  // Edit a song's musical facts (songs phase 4) - all of them user-editable, always: the tags
  // are a convenience, not an authority. Body: { deck, bpm? (20..400, or null to clear - which
  // also drops sync), key?, anchorSec? (the beatgrid's downbeat anchor, clamped to the file),
  // sync? (rate-lock to the master clock; needs a bpm), keylock? (Warp1 timestretch player -
  // rate moves time, not pitch; toggling mid-song is a declicked player swap at the playhead) }.
  'POST /api/song/meta': async (body) => {
    const deck = body.deck === 'b' ? 'b' : 'a';
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    if ('bpm' in body) {
      delete s.bpmDetected; // whatever the hand says, it is no longer an estimate
      if (body.bpm == null || body.bpm === '') {
        s.bpm = null;
        s.sync = false;
        decks[deck].bpm = null; // native slot back to the 120 default
      } else {
        const bpm = Number(body.bpm);
        if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400) throw new Error('song/meta: bpm must be 20..400 (or null to clear)');
        s.bpm = bpm;
        decks[deck].bpm = bpm; // the native tempo the desk's migration slider/detents ride to
        songDetectKick(deck); // re-fit the grid around the typed tempo (it pins the octave; the fit refines)
      }
    }
    if ('key' in body) {
      s.musicalKey = String(body.key ?? '').trim() || null;
      delete s.keyDetected;
    }
    if ('anchorSec' in body) {
      const a = Number(body.anchorSec);
      if (!Number.isFinite(a)) throw new Error('song/meta: anchorSec must be a number (seconds)');
      s.anchorSec = Math.min(Math.max(0, a), s.duration); // as given - the pane's magnet did any snapping
      s.anchorByHand = true;
      s.gridDetected = null;
    }
    if ('sync' in body) {
      if (body.sync && s.bpm == null) throw new Error('sync needs a bpm - set one first (the tags had none)');
      s.sync = !!body.sync;
    }
    if ('syncMult' in body) {
      const m = body.syncMult === 'auto' ? 'auto' : Number(body.syncMult);
      if (m !== 'auto' && m !== 0.5 && m !== 1 && m !== 2) throw new Error('song/meta: syncMult must be "auto", 0.5, 1 or 2');
      s.syncMult = m;
    }
    if ('keylock' in body && !!body.keylock !== s.keylock) {
      s.keylock = !!body.keylock;
      if (s.playing && engine) {
        // Swap the running player for the other def at the current playhead, declicked (the
        // old one release-fades under the new one, exactly like a restart).
        const now = engine.getTime();
        const pos = songPlayheadSec(deck, now);
        const startSec = now + SONG_START_LEAD_SEC;
        engine.songStart(engineTrack(SONG_KEYS[deck]), pos, s.rate + s.servo, startSec, s.keylock ? 1 : 0);
        s.posSec = pos;
        s.startSec = startSec;
        songArmEndTimer(deck);
      }
    }
    songApplyRate(deck); // bpm/sync edits change the effective rate; paused songs settle too
    mixNotify();
    return {
      status: 200,
      body: {
        deck, bpm: s.bpm, musicalKey: s.musicalKey, anchorSec: s.anchorSec,
        sync: s.sync, keylock: s.keylock, rate: s.rate,
      },
    };
  },

  // The platter (songs phase 4). Body: { deck, hold?: -1|0|1, jog?: -1|1 }. `hold` is the
  // momentary rate offset (press +-1, release 0 - +-4% while held, the classic push/drag);
  // `jog` steps the phase by one song-beat (the bar-fix after a beat-aligned start; 100ms when
  // no bpm is known). The mixMidi nudge/jog button targets drive the same gesture.
  'POST /api/song/nudge': async (body) => {
    const deck = body.deck === 'b' ? 'b' : 'a';
    return { status: 200, body: songNudge(deck, body) };
  },

  // The song's transient times (seconds, ascending) - what the pane's scrub magnet pulls the
  // playhead onto. Empty until the analysis has run; `ready` says which.
  'GET /api/song/onsets': async (q) => {
    const deck = q.deck === 'b' ? 'b' : 'a';
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    return { status: 200, body: { deck, ready: s.onsets != null, onsets: s.onsets ?? [] } };
  },

  // The waveform pane's data (songs phase 3): a high-resolution detail strip plus a full-track
  // overview in one response - per-bucket peak + rms + low/mid/high balance, the recorder's
  // envelope pass generalized (wav.js's songWaveform) and run on the analysis worker so a
  // 5-minute file's read never blocks the note scheduler. aiff/flac sources take an afconvert
  // pass first (Node's WAV reader can't parse them); mp3/m4a reuse their playback decode.
  // Query: { deck }.
  'GET /api/song/waveform': async (q) => {
    const deck = q.deck === 'b' ? 'b' : 'a';
    const s = songDecks[deck];
    if (!s) throw new Error(`deck ${deck} has no song loaded`);
    const resolved = await resolveSongFile(s.path, { wav: true });
    const st = fs.statSync(resolved.path);
    const cacheKey = `${resolved.path}|${Math.round(st.mtimeMs)}|${st.size}`;
    let wave = songWaveCache.get(cacheKey);
    if (!wave) {
      wave = await analysis.songWaveform(resolved.path);
      if (!wave) throw new Error(`couldn't read "${s.title}" for its waveform`);
      songWaveCache.set(cacheKey, wave);
      while (songWaveCache.size > 6) songWaveCache.delete(songWaveCache.keys().next().value);
    }
    return { status: 200, body: { deck, path: s.path, title: s.title, ...wave } };
  },

  // The file browser behind the organize modal's "+ file" (songs phase 2): one directory at a
  // time, subdirectories plus playable audio files - the client can't produce disk paths, so
  // this is how a real file gets into a playlist. Query: { dir? } (absent = ~/Music or home).
  'GET /api/songfiles': async (q) => ({ status: 200, body: browseSongDir(q.dir) }),

  // Every playable file under a folder, filtered by a search - the organize modal's tree
  // search and its whole-folder adds (mirroring /api/findSamples, which does the same for the
  // pack browser over the sample formats). Query: { dir?, q?, limit? } -> { path, files
  // (relative), matched, total, truncated }.
  'GET /api/songfiles/find': async (q) => {
    const dir = path.resolve(String(q.dir ?? '').trim() || defaultSongDir());
    const limit = Math.max(1, Math.min(20000, Number(q.limit) || 500));
    const { matchAudioPaths } = require('@poptart/osc-engine/samples');
    let walked;
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error('not a folder');
      // cachedWalk is shared with the sample browser - the key prefix keeps a folder walked
      // for songs (mp3s included) apart from the same folder walked for packs.
      walked = await cachedWalk(`songs:${dir}`, () => walkSongFiles(dir));
    } catch {
      throw new Error(`can't read ${dir}`);
    }
    const hits = matchAudioPaths(walked.files, q.q || '');
    return {
      status: 200,
      body: {
        path: dir,
        files: hits.slice(0, limit),
        matched: hits.length,
        total: walked.files.length,
        truncated: !!walked.truncated,
      },
    };
  },

  // Which of a library's file items still exist - a moved or deleted file renders as missing,
  // the same contract as a deleted save. Body: { paths: [...] } -> { exists: { [path]: bool } }.
  'POST /api/songfiles/stat': async (body) => ({ status: 200, body: { exists: statSongPaths(body.paths) } }),

  'POST /api/trackRecord/start': async (body) => {
    if (!engine || !transport) throw new Error(engineError ?? 'engine not loaded');
    if (trackRec && trackRec.phase !== 'done') throw new Error('a bounce is already armed or running - cancel it first');
    const label = String(body.label ?? '').trim();
    if (!label) throw new Error('trackRecord/start needs a block label');
    if (!schedulers.has(label)) throw new Error(`"${label}" isn't playing - only a live block can be bounced`);
    const cycles = Math.min(128, Math.max(1, Math.round(Number(body.cycles) || 4)));

    // Arm for the next phrase boundary far enough out that the pre-roll is still in the future -
    // otherwise the engine would clamp the start to "now" and the trim would cut in the wrong place.
    const now = engine.getTime();
    let startCycle = (Math.floor(transport.cycleAt(now) / PHRASE_CYCLES) + 1) * PHRASE_CYCLES;
    while (transport.secAt(startCycle) - now < REC_MIN_LEAD_SEC) startCycle += PHRASE_CYCLES;
    const startSec = transport.secAt(startCycle);
    const endSec = transport.secAt(startCycle + cycles);

    if (trackRec?.timer) clearInterval(trackRec.timer);
    trackRec = {
      phase: 'armed',
      label,
      cycles,
      startCycle,
      endCycle: startCycle + cycles,
      startSec,
      endSec,
      name: String(body.name ?? '').trim(),
      wrapTail: body.wrapTail === true,
      capture: recordings.captureFile(label),
      result: null,
      error: null,
      timer: setInterval(trackRecTick, 50),
    };

    // The capture path identifies THIS bounce: a reply that arrives after the user cancelled and
    // started another must not finalize (or clobber) the newer one.
    const capture = trackRec.capture;
    // The tap has to be up before the window opens; a panel may already have opened it.
    engine.tapTrack(engineTrack(label), true);
    engine
      .recordTrack(engineTrack(label), trackRec.capture, startSec - REC_PRE_ROLL_SEC, endSec + REC_POST_ROLL_SEC)
      .then((wrote) => {
        if (trackRec?.capture === capture) finalizeTrackRec(wrote);
      })
      .catch((err) => {
        if (trackRec?.capture !== capture) return; // superseded by a newer bounce
        clearInterval(trackRec.timer);
        trackRec.timer = null;
        trackRec.error = err.message ?? String(err);
        trackRec.phase = 'done';
      })
      .finally(() => releaseRecTap(label));
    return { status: 200, body: trackRecStatus() };
  },

  'GET /api/trackRecord/status': async () => ({ status: 200, body: trackRecStatus() }),

  // Abort an armed/running bounce, or acknowledge a finished one (clears its result). The engine
  // side stops with the tap; a cancelled capture is simply never trimmed.
  'POST /api/trackRecord/cancel': async () => {
    if (!trackRec) return { status: 200, body: {} };
    const { label, phase, capture, timer } = trackRec;
    if (timer) clearInterval(timer);
    trackRec = null;
    if (phase !== 'done' && engine) {
      engine.tapTrack(engineTrack(label), false); // frees the DiskOut synth and closes the file mid-flight
      recTapped.delete(label);
      try {
        fs.unlinkSync(capture);
      } catch {
        // the engine may not have created it yet
      }
    }
    return { status: 200, body: {} };
  },

  // --- the mixer modal (ctrl+g) ---

  // Engine-side monitoring on/off. Body: { on }. Off is always accepted (even with the engine
  // down); on needs a live engine to tap.
  'POST /api/mixer/monitor': async (body) => {
    setMixMonitor(!!body.on);
    return { status: 200, body: { on: mixMonitorOn } };
  },

  // What an open mixer polls ~10x/sec: playing track labels, drained meter readings, the latest
  // band frames, and the band centers they're measured at. Also the keep-alive - see mixStatus.
  'GET /api/mixer/status': async () => ({ status: 200, body: mixStatus() }),

  // Every bounce on disk, newest first - the sr() autocomplete's word list and the recordings
  // browser. Reads the filesystem directly, so it works with the engine down.
  'GET /api/recordings': async () => ({
    status: 200,
    body: { root: recordings.recordingsRoot(), items: recordings.listRecordings() },
  }),

  // One folder of the sample library, for se()'s autocomplete: subfolders first, then audio files.
  // Query `dir` is root-relative ("" = the root itself).
  'GET /api/sampleFiles': async (query) => {
    const { browseSamples, samplesRoot } = require('@poptart/osc-engine/samples');
    const listing = browseSamples(query.dir ?? '');
    if (!listing) throw new Error(`can't read ${path.join(samplesRoot(), query.dir ?? '')}`);
    return { status: 200, body: { root: samplesRoot(), ...listing } };
  },

  // --- macros (the editor's "macros" knob bank) ---

  // Knob values are live performance state (in-memory, reset on restart); names persist in
  // settings so a renamed knob keeps its name across sessions.
  'GET /api/macros': async () => ({
    status: 200,
    body: {
      macros: Array.from({ length: patternCore.MACRO_COUNT }, (_, i) => ({
        index: i + 1,
        value: patternCore.macroValue(i + 1),
        name: settings.macroNames?.[i] || `Macro ${i + 1}`,
      })),
    },
  }),

  // Body: { index, value } - value 0..1. Called on every knob move (throttled client-side),
  // so it deliberately touches nothing but the in-memory store.
  'POST /api/macros/set': async (body) => {
    patternCore.setMacro(Number(body.index), Number(body.value));
    return { status: 200, body: {} };
  },

  // Body: { index, name }. An empty name resets to the default "Macro N".
  'POST /api/macros/name': async (body) => {
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 1 || index > patternCore.MACRO_COUNT) {
      throw new Error(`macro index must be 1..${patternCore.MACRO_COUNT}`);
    }
    const name = String(body.name ?? '').trim().slice(0, 24);
    settings.macroNames = settings.macroNames ?? [];
    settings.macroNames[index - 1] = name;
    saveSettings();
    return { status: 200, body: { name: name || `Macro ${index}` } };
  },

  // --- settings (the editor's "settings" tab) ---

  // How long unnamed work-in-progress sessions are kept. Off by default (`months: 0` - keep them
  // forever), because a session file is the recovery net for work that was never named.
  //
  // GET reports the policy and what applying it would cost right now, so the editor can ask before
  // anything is deleted rather than after. `preview` months lets it price a policy that isn't in
  // force yet - the number in the confirmation dialog.
  'GET /api/patterns/wip/retention': async (q) => {
    const months = Number(settings.wipRetentionMonths ?? 0);
    const asked = q?.months == null ? months : Number(q.months);
    const { ids, bytes } = wipOlderThan(asked);
    return { status: 200, body: { months, preview: { months: asked, sessions: ids.length, bytes } } };
  },

  // Body: { months } - 0 to keep sessions forever. Applies the policy immediately, so what the
  // dialog said would go, goes now rather than at some later sweep.
  'POST /api/patterns/wip/retention': async (body) => {
    const months = Math.max(0, Math.min(120, Number(body?.months ?? 0) || 0));
    settings.wipRetentionMonths = months;
    saveSettings();
    const { deleted, freed } = months > 0 ? pruneWipSessions(months) : { deleted: 0, freed: 0 };
    // The states those sessions were holding alive can go with them, if nothing else names them.
    const swept = await blobs.sweepBlobs({ scanDirs: [WIP_DIR, SNAPSHOT_DIR, PREBAKE_DIR, snippets.SNIPPETS_DIR], alsoKeep: [...liveStateIds.a, ...liveStateIds.b] });
    return { status: 200, body: { months, deleted, freed: freed + swept.freed } };
  },

  // Output devices with channel counts, plus the saved selection (null = system default) and the
  // output-channel picture for the device that would be opened: `channels` is what .o(n) wraps at
  // right now, `choices` the counts the tab may offer, `audible` how wide the device really is.
  'GET /api/audioDevices': async () => {
    const devices = audioOutputDevices();
    const { channels, choices, audible } = outputChannelState(devices);
    return {
      status: 200,
      body: {
        devices,
        selected: settings.audioOutputDevice ?? null,
        outputChannels: channels,
        outputChannelChoices: choices,
        audibleChannels: audible,
        cueAvailable: audioDevices.helperAvailable(),
        cueSelected: settings.audioCueDevice?.name ?? null,
        cueActive: activeCue?.name ?? null, // what the RUNNING engine actually has (null = no cue this boot)
      },
    };
  },

  // Body: { device } - the headphone/cue output device's name, or null/"" for no cue. The cue
  // rides the combined (aggregate) device as its last member, and the track SynthDefs compile a
  // cue send only when the engine boots with the pair - so this is a before-the-gig settings
  // choice: it MUTATES the audio configuration and restarts the engine, like every device change.
  'POST /api/audioCueDevice': async (body) => {
    const name = body.device ? String(body.device) : null;
    if (!name) {
      settings.audioCueDevice = null;
    } else {
      if (!audioDevices.helperAvailable()) {
        throw new Error('the headphone cue needs the poptart-audio helper, which is not available on this system');
      }
      const dev = audioOutputDevices().find((d) => d.name === name && !d.isAggregate);
      if (!dev) throw new Error(`no audio output device named "${name}"`);
      if (dev.uid && dev.uid === plainOutputDevice(audioOutputDevices())?.uid) {
        throw new Error('the cue device must be different from the main output device - it is the separate pair your headphones are on');
      }
      settings.audioCueDevice = { uid: dev.uid, name: dev.name };
    }
    let rebuildWarning = null;
    try {
      syncAggregateNow();
    } catch (err) {
      rebuildWarning = {
        message: 'the combined audio device could not be rebuilt - press apply to retry',
        detail: `the combined audio device could not be rebuilt (${err.message}) - the cue pair is not available.`,
      };
      // eslint-disable-next-line no-console
      console.warn(`[poptart] ${rebuildWarning.detail}`);
    }
    saveSettings();
    await restartEngine();
    if (!engine) throw new Error(engineError ?? 'engine failed to restart');
    return {
      status: 200,
      body: {
        device: settings.audioCueDevice?.name ?? null,
        active: activeCue?.name ?? null,
        warning: rebuildWarning ?? audioDeviceWarning(),
      },
    };
  },

  // Body: { channels } - how many output channels .o(n) may address, as a count of whole stereo
  // pairs. Clamped to what the device can be heard on rather than refused, for the same reason
  // playbackChannels clamps: the saved number outlives the device it was chosen for. Restarts the
  // engine, because the pair count is compiled into every track SynthDef at boot.
  'POST /api/audioOutputChannels': async (body) => {
    // Whole stereo pairs only - a pair is the unit .o(n) addresses, and an odd count would leave
    // one channel no orbit could reach.
    const pairs = Math.max(1, Math.floor(Number(body?.channels) / 2) || 1);
    settings.audioOutputChannels = pairs * 2;
    saveSettings();
    await restartEngine();
    if (!engine) throw new Error(engineError ?? 'engine failed to restart');
    const { channels, choices, audible } = outputChannelState();
    return { status: 200, body: { outputChannels: channels, outputChannelChoices: choices, audibleChannels: audible } };
  },

  // Body: { device } - a device name, or null/"" for the system default. Persists the choice
  // and restarts the engine on the new device (scsynth can't switch devices while running),
  // so the response takes a few seconds and any playing tracks stop.
  'POST /api/audioDevice': async (body) => {
    const device = body.device ? String(body.device) : null;
    if (device && !audioOutputDevices().some((d) => d.name === device)) {
      throw new Error(`no audio output device named "${device}"`);
    }
    settings.audioOutputDevice = device;
    // The aggregate is built AROUND the output device - it's the clock master and its channels are
    // the ones playback lands on - so a new output device means a new aggregate. Without this the
    // choice is silently inert: deviceToOpen keeps opening an aggregate built around the device you
    // just stopped using, and picking your speakers changes nothing you can hear.
    let rebuildWarning = null;
    if (aggregateExtraUids().length) {
      try {
        syncAggregateNow();
      } catch (err) {
        // Not fatal, and not a reason to refuse the device the user just asked for: deviceToOpen
        // sees an aggregate that no longer holds it and opens it directly instead. Say so, though -
        // input() loses the extra devices until the aggregate is rebuilt.
        rebuildWarning = {
          message: 'the combined audio device could not be rebuilt - press apply to retry',
          detail: `the combined audio device could not be rebuilt (${err.message}) - playing through `
            + `"${device ?? 'the system default'}" directly, so input() cannot reach the extra devices.`,
        };
        // eslint-disable-next-line no-console
        console.warn(`[poptart] ${rebuildWarning.detail}`);
      }
    }
    saveSettings();
    await restartEngine();
    if (!engine) throw new Error(engineError ?? 'engine failed to restart');
    return { status: 200, body: { device, warning: rebuildWarning ?? audioDeviceWarning() } };
  },

  // Input-capable devices, the saved extra-input selection, and the live channel layout input()
  // resolves against. `available: false` means no poptart-audio helper, so only the booted device's
  // own inputs can be used (absolute channel numbers still work).
  'GET /api/audioInputs': async () => ({
    status: 200,
    body: {
      available: audioDevices.helperAvailable(),
      // Never poptart's own aggregate: it's assembled FROM these, so offering it as one of them
      // is offering to make it a member of itself.
      devices: audioDevices.listInputDevices().filter((d) => d.uid !== audioDevices.AGGREGATE_UID),
      selected: settings.audioInputDevices ?? [],
      // uid -> the name it had when it was applied, so a device that has since been unplugged can
      // still be shown as itself.
      names: settings.audioInputNames ?? {},
      layout: audioInputLayout(),
      active: activeAudioDevice?.name ?? null,
      // Non-null when the combined device has degraded under us - the settings tab is the only
      // place this is visible, because the audio itself gives nothing away.
      warning: audioDeviceWarning(),
    },
  }),

  // Body: { uids } - the extra input devices to aggregate with the output device, in the order
  // their channels should appear. An empty list tears the aggregate down and goes back to opening
  // the output device directly.
  //
  // This MUTATES the machine's audio configuration (the aggregate shows up in Audio MIDI Setup)
  // and then restarts the engine, so any playing tracks stop - which is exactly why it's an
  // explicit settings action and never something an eval can trigger.
  'POST /api/audioInputs': async (body) => {
    const uids = Array.isArray(body.uids) ? body.uids.map(String) : [];
    if (uids.length && !audioDevices.helperAvailable()) {
      throw new Error('combining several input devices needs the poptart-audio helper, which is not available on this system');
    }
    // A device that isn't plugged in right now must NOT fail the whole request - see
    // splitConnected. Build from what's actually here; keep the rest saved, so plugging an
    // interface back in and pressing apply brings it straight back.
    const knownDevices = audioDevices.listDevices();
    const { absent } = audioSelection.splitConnected(uids, knownDevices.map((d) => d.uid));

    settings.audioInputDevices = uids;
    // The output device goes in as the clock master: it's the one whose timing playback is bound
    // to, and every other member gets drift compensation against it. The cue device (if chosen)
    // rides along - see syncAggregateNow.
    syncAggregateNow();
    // Remember what each one is CALLED while it's here to ask. A UID is all that survives an
    // unplug, and on its own it's unreadable - the difference between "EarPods · not plugged in"
    // and "AppleUSBAudioEngine:Apple, Inc.:EarPods:DHK4XW9QTV:2 · not plugged in".
    const nameOf = new Map(knownDevices.map((d) => [d.uid, d.name]));
    settings.audioInputNames = Object.fromEntries(
      uids.map((uid) => [uid, nameOf.get(uid) ?? inputDeviceName(uid)]),
    );
    saveSettings();
    await restartEngine();
    if (!engine) throw new Error(engineError ?? 'engine failed to restart');
    const skipped = absent.length
      ? {
        message: `${absent.length} selected ${absent.length === 1 ? 'device was' : 'devices were'} `
          + 'not plugged in and got left out',
        detail: `${absent.length} selected ${absent.length === 1 ? 'device is' : 'devices are'} not `
          + `plugged in and were left out of the combined device (${absent.map(inputDeviceName).join(', ')}). `
          + 'They stay selected - plug them back in and the next engine start brings them in by '
          + 'itself, or untick them to forget them.',
      }
      : null;
    return {
      status: 200,
      body: { selected: uids, layout: audioInputLayout(), warning: skipped ?? audioDeviceWarning() },
    };
  },
};

// Full parameter lists keyed by plugin name - Serum 2's is 2,621 entries and round-trips
// through sclang via a temp file, so fetch it once per plugin, not once per eval.
const paramsByPlugin = new Map();

// Plugin loading is a fire-and-forget OSC send, so right after an eval getParams can race the
// plugin's own (potentially slow - Serum takes seconds) open. Poll until it answers.
async function getParamsWhenLoaded(trackId, slot, { tries = 30, delayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await engine.getParams(trackId, slot);
    } catch (err) {
      const stillOpening = /no plugin loaded/i.test(err.message ?? '');
      if (!stillOpening || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Plumbing: static file serving + JSON body parsing + route dispatch.
// ---------------------------------------------------------------------------------------------

const STATIC_ROOTS = [
  { prefix: '/vendor/codemirror/', root: CODEMIRROR_DIR },
  { prefix: '/pattern-core/', root: PATTERN_CORE_SRC_DIR },
];

function resolveStaticPath(urlPath) {
  const entry = STATIC_ROOTS.find((e) => urlPath.startsWith(e.prefix));
  const root = entry?.root ?? PUBLIC_DIR;
  const rel = entry ? urlPath.slice(entry.prefix.length) : urlPath;
  const filePath = path.join(root, rel);
  return filePath.startsWith(root) ? filePath : null;
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = resolveStaticPath(urlPath);

  if (!filePath) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(filePath);
    // no-cache (= revalidate, not "don't cache"): without it browsers heuristically cache
    // client.js etc., so after a server update a plain reload can keep running stale UI code.
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------------------------
// Live-reload: the browser holds one SSE stream open (GET /api/devReload) and reloads itself
// when told to. Two signals cover the two kinds of edit:
//   - a change under public/ broadcasts `reload` with the server still running - the engine and
//     the sound are untouched, only the page refreshes;
//   - an edit to server-side code (server.js, pattern-core, osc-engine) restarts the process
//     (npm run dev is `node --watch`), the stream drops, and the reconnecting client sees a new
//     boot id and reloads then. The changed ID - not the dropped connection - is the trigger, so
//     a transient hiccup reconnects without a spurious reload.
// pattern-core's src/ is served to the browser but not watched here on purpose: the server loads
// those same files, so --watch already answers with a restart, and the boot id covers it.
// ---------------------------------------------------------------------------------------------

const BOOT_ID = `${process.pid}:${Date.now()}`;
const reloadClients = new Set();

function serveDevReload(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: boot\ndata: ${BOOT_ID}\n\n`);
  reloadClients.add(res);
  res.on('close', () => reloadClients.delete(res));
}

// One save can land as several fs events (write + rename, an editor's temp-file dance); the
// browser needs one reload, so broadcasts settle for a beat first.
let reloadTimer = null;
function broadcastReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const res of reloadClients) res.write('event: reload\ndata: 1\n\n');
  }, 80);
}

try {
  fs.watch(PUBLIC_DIR, { recursive: true }, (_event, file) => {
    if (file && path.basename(file).startsWith('.')) return; // editor swap files, .DS_Store
    broadcastReload();
  });
} catch {
  // watching is a convenience - a platform without recursive fs.watch just loses auto-reload
}

// Streams a single sample file's raw bytes for the sounds-browser preview (the client decodes
// it with Web Audio). Addressed the same way `s("pack:i")` is - by the file's index in its
// pack's filename-sorted list - so what you preview is exactly what that pattern plays. Kept out
// of the JSON `routes` table because it returns binary audio, not JSON.
const AUDIO_MIME = {
  '.wav': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
};

// Song preview bytes - the organize disk pane's audition (the pack browser's, mirrored onto
// the song formats). The browser's own decoder handles wav/mp3/m4a/aac/flac; aiff and caf it
// generally can't, so those take the same afconvert pass (and cache) deck playback uses.
async function serveSongAudio(query, res) {
  const raw = String(query.file ?? '');
  if (!raw || !path.isAbsolute(raw) || !classifySongFile(raw)) {
    res.writeHead(400).end('bad request');
    return;
  }
  let filePath = path.resolve(raw);
  try {
    if (['.aif', '.aiff', '.caf'].includes(path.extname(filePath).toLowerCase())) {
      filePath = (await resolveSongFile(filePath, { wav: true })).path;
    }
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  });
}

function serveSampleAudio(query, res) {
  const { listPackFiles, isAudioName, samplesRoot } = require('@poptart/osc-engine/samples');
  let filePath;
  if (query.file != null) {
    // One file by path - what the pack panel auditions. Absolute, or relative to the samples root
    // (the two spellings a pack entry has). Only audio: the same machine's own files, but this is
    // still a sound preview and not a file server.
    const raw = String(query.file);
    if (!raw || !isAudioName(raw)) {
      res.writeHead(400).end('bad request');
      return;
    }
    filePath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(samplesRoot(), raw);
  } else {
    const pack = String(query.pack ?? '');
    const i = Number(query.i);
    // Pack is a single folder name under the samples root; reject anything that could escape it.
    if (!pack || pack.includes('/') || pack.includes('\\') || pack.includes('..') || !Number.isInteger(i) || i < 0) {
      res.writeHead(400).end('bad request');
      return;
    }
    filePath = listPackFiles(pack)?.[i];
  }
  if (!filePath) {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': AUDIO_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Chunks are concatenated as BYTES and decoded once. Decoding each chunk on arrival (`raw +=
// chunk`) splits any multi-byte character that happens to straddle a chunk boundary into two
// replacement characters - which, on a buffer big enough to arrive in several chunks, silently
// corrupts the code being evaluated wherever it holds an accent or an emoji.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (LOOPBACK_ONLY) {
    const refusal = blockReason({
      method: req.method,
      hostHeader: req.headers.host,
      originHeader: req.headers.origin,
    });
    if (refusal) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: refusal }));
      return;
    }
  }

  const url = new URL(req.url, 'http://localhost');

  // Binary sample preview - answered outside the JSON route table (see serveSampleAudio).
  if (req.method === 'GET' && url.pathname === '/api/sampleAudio') {
    return serveSampleAudio(Object.fromEntries(url.searchParams), res);
  }

  // Song preview bytes for the organize modal's disk pane - same deal (see serveSongAudio).
  if (req.method === 'GET' && url.pathname === '/api/songAudio') {
    return serveSongAudio(Object.fromEntries(url.searchParams), res);
  }

  // Live-reload stream - long-lived SSE, so also outside the JSON route table.
  if (req.method === 'GET' && url.pathname === '/api/devReload') {
    return serveDevReload(res);
  }

  // The desk push channel (mix mode's knob mirror) - same deal.
  if (req.method === 'GET' && url.pathname === '/api/mix/events') {
    return serveMixEvents(res);
  }

  const handler = routes[`${req.method} ${url.pathname}`];

  if (!handler) {
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(404).end('not found');
    return;
  }

  try {
    // POST handlers receive the parsed JSON body; GET handlers receive the query params.
    const arg = req.method === 'POST'
      ? await readJsonBody(req)
      : Object.fromEntries(url.searchParams);
    const { status, body: responseBody } = await handler(arg);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message ?? String(err) }));
  }
});

init().then(() => {
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[poptart] listening on http://localhost:${PORT}`);
    if (!LOOPBACK_ONLY) {
      // eslint-disable-next-line no-console
      console.warn(
        `[poptart] WARNING: bound to ${HOST} (POPTART_HOST) - anyone who can reach this ` +
          'address can execute code on this machine via /api/evaluate. Only use on networks ' +
          'you trust.',
      );
    }
  });
});

process.on('SIGINT', () => {
  // stop() is async (it waits for sclang to quit scsynth cleanly) - give it a moment, but
  // never hang the Ctrl-C.
  setTimeout(() => process.exit(0), 4000).unref();
  Promise.resolve(engine?.stop()).finally(() => process.exit(0));
});

// Last line of defence: an error thrown where nobody can catch it - a timer callback, an OSC reply
// handler, a stray rejected promise - must not take the server down. Node's default for both of
// these is to print the stack and exit, and exiting is the worst thing that can happen here: the
// browser keeps its code but loses the engine, sclang and scsynth are orphaned holding the audio
// device, and whatever was playing stops mid-set. Staying up is recoverable; the engine can be
// restarted from the settings tab, and the pattern re-evaluated. So log it loudly - to the editor's
// own console as well as this terminal, since the terminal is not what a player is looking at - and
// keep going. This is a backstop, not a licence: the bug it caught first (a VST transport re-sync
// firing at an engine that was being torn down for an audio-device change) got fixed where it was.
for (const [event, label] of [['uncaughtException', 'uncaught error'], ['unhandledRejection', 'unhandled rejection']]) {
  process.on(event, (err) => {
    const detail = err?.stack ?? String(err);
    // eslint-disable-next-line no-console
    console.error(`[poptart] ${label} (the server is staying up):\n${detail}`);
    eventLogQueue.push(`${label}: ${err?.message ?? String(err)} - see the terminal for the full trace`);
    if (eventLogQueue.length > EVENT_LOG_MAX) eventLogQueue.splice(0, eventLogQueue.length - EVENT_LOG_MAX);
  });
}
