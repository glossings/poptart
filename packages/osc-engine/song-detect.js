'use strict';

// BPM + key detection fallback (songs phase 5): when a file's tags say nothing, estimate both
// from the audio itself. The maths is song-detect-core.mjs, which the browser build runs too;
// this file is the part that reads a WAV off the disk. The engine runs detectSongFacts on the
// analysis worker (analysis.js) because a full song's read and FFT pass is far past the
// scheduler's lookahead.

const { readWav, detectOnsets, detectOnsetHits } = require('./samples');
const { songFactsOf, detectBpm, detectKey, fitBeatGrid, fft } = require('./song-detect-core.mjs');

// ---------------------------------------------------------------------------------------------

/**
 * Everything a deck wants to know about a WAV file, in one read:
 * { bpm, bpmConfidence, anchorSec, gridConfidence, key, keyConfidence, onsets } with nulls
 * where nothing could be read, or null when the file isn't a parseable WAV at all. `bpmHint`
 * (the file's tag, the playlist's word) pins the tempo octave and is refined, not replaced:
 * the grid fit measures the period over the whole track, and a tag's "128" is usually 127.98.
 * `onsets` are the transient times (seconds) the anchor and cue gestures snap to.
 * `wavPath` must already be a WAV - see songs.js's resolveSongFile({ wav: true }).
 */
function detectSongFacts(wavPath, { bpmHint = null } = {}) {
  const wav = readWav(wavPath);
  if (!wav) return null;
  return songFactsOf(wav.samples, wav.sampleRate, { bpmHint, onsetFracs: detectOnsets(wav.samples, wav.sampleRate) });
}

/**
 * What a file can tell us about the FEEL it was played with: every hit in it, how hard each one
 * was struck, and the tempo and downbeat those hits have to be read against. Turning that into a
 * groove table is pattern-core's job (see groove-extract.mjs) - this is the audio half, and it
 * deliberately stops short of interpreting: a caller who knows the loop is two bars says so, and
 * one who doesn't gets the detector's reading of it to correct.
 *
 * `bars` is how many bars the file spans when the caller knows; otherwise it is derived from the
 * fitted tempo, and snapped to the loop lengths music is actually cut in - a 1.97-bar reading of a
 * two-bar break is a measurement error, not a 1.97-bar break.
 *
 * `wavPath` must already be a WAV (as everywhere Node-side - see samples.js's detectSlices).
 */
function detectGrooveHits(wavPath, { sensitivity = 1, bpmHint = null, bars = null } = {}) {
  const wav = readWav(wavPath);
  if (!wav) return null;
  const seconds = wav.samples.length / wav.sampleRate;
  const hits = detectOnsetHits(wav.samples, wav.sampleRate, { sensitivity });
  const grid = fitBeatGrid(wav.samples, wav.sampleRate, bpmHint);
  const bpm = grid?.bpm ?? (Number.isFinite(bpmHint) ? Number(bpmHint) : null);
  const told = Number(bars);
  return {
    hits, // positions along the file, 0..1, with a strength each
    seconds,
    bpm,
    bpmConfidence: grid?.confidence ?? null,
    // A loop's bar starts where the FILE starts - that is what makes it a loop, and it is how one
    // is played everywhere else (slice 0 is the file start). The grid fit's anchor is deliberately
    // not used for it: that anchor is some beat, not necessarily the first, and the beat it picks
    // depends on where the bass energy fell - which would rotate an extracted feel onto the wrong
    // slots. It is reported all the same, since a file that is NOT cut to the bar is a real thing
    // and the number is what would correct it.
    anchorSec: 0,
    beatAnchorSec: grid?.anchorSec ?? null,
    bars: Number.isFinite(told) && told > 0 ? told : barsOf(seconds, bpm),
  };
}

// How many bars a file of this length holds at this tempo, snapped to the lengths loops come in.
// A cycle is a bar of four beats here (bpm is cps * 240), as everywhere in poptart.
const LOOP_BARS = [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 32];
function barsOf(seconds, bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return 1; // nothing to measure against; read it as one bar
  const raw = (seconds * bpm) / 240;
  const near = LOOP_BARS.reduce((best, n) => (Math.abs(n - raw) < Math.abs(best - raw) ? n : best), LOOP_BARS[0]);
  // Within 6% of a loop length, it IS that loop length; otherwise the file is some other number of
  // bars long and the honest answer is the nearest whole one.
  if (Math.abs(near - raw) <= near * 0.06) return near;
  return Math.max(1, Math.round(raw));
}

module.exports = { detectSongFacts, detectGrooveHits, detectBpm, detectKey, fitBeatGrid, fft };
