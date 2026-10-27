'use strict';

// What a file dragged over the window will do where the pointer is, decided in one place so the
// drag overlay says exactly what the drop then does. The same rules on both builds:
//
//   - a .mid imports as MIDI, into the code it lands on;
//   - audio on a DJ deck that is empty or holds a song loads there as the deck's song;
//   - audio on a DJ deck holding livecode becomes a sample, written into that code as s("files:…");
//   - audio in the organize window joins the track collection;
//   - audio on the code outside DJ mode becomes a sample, as on a livecode deck.
//
// The pack panel's list and the groove lanes take their own drops; this answers "theirs" there.
//
// Loaded as a plain script in the browser (before client.js) and require()d by the tests. Pure.

// What the sampler plays - the files a `files:` sample can be.
const DROP_SAMPLE_RE = /\.(wav|aif|aiff|flac|mp3)$/i;
// What a song deck plays beyond those: decoded on the way in. The browser decodes Ogg and Opus as
// well, which the desktop's decoder does not.
const DROP_SONG_ONLY_RE = { desktop: /\.(m4a|aac|caf)$/i, web: /\.(m4a|aac|caf|ogg|opus)$/i };
const DROP_MIDI_RE = /\.midi?$/i;
const DROP_MIDI_MIME_RE = /^audio\/(x-)?(midi|mid)$/i;

/**
 * What one dropped file is, by its name (or MIME type): 'midi', 'sample' (audio the sampler plays,
 * which a song deck plays too), 'song' (audio only a song deck plays), or null.
 */
function dropFileKind(name, type = '', { web = false } = {}) {
  const n = String(name ?? '');
  if (DROP_MIDI_RE.test(n) || DROP_MIDI_MIME_RE.test(type)) return 'midi';
  if (DROP_SAMPLE_RE.test(n)) return 'sample';
  if ((web ? DROP_SONG_ONLY_RE.web : DROP_SONG_ONLY_RE.desktop).test(n)) return 'song';
  return null;
}

/**
 * What a drag carries while it is still in the air, when only the items' MIME types can be read:
 * 'midi', 'audio' (some audio file, its exact format unknown until the drop), or null.
 */
function dragKind(types) {
  const list = Array.from(types ?? [], String);
  if (list.some((t) => DROP_MIDI_MIME_RE.test(t))) return 'midi';
  if (list.some((t) => /^audio\//i.test(t))) return 'audio';
  return null;
}

/** What several dropped files come to: MIDI wins (one file is imported), then playable audio. */
function dropKindOfFiles(kinds) {
  const list = Array.from(kinds ?? []);
  if (list.includes('midi')) return 'midi';
  if (list.includes('sample')) return list.includes('song') ? 'audio' : 'sample';
  if (list.includes('song')) return 'song';
  return null;
}

/**
 * The decision. `kind` is dropFileKind's / dragKind's answer ('audio' = a format not known yet).
 * `at` says where the pointer is:
 *   panel: 'pack' | 'groove' | null - a panel that takes its own drops;
 *   organize: in the organize window;
 *   deck: 'a' | 'b' | null - the DJ deck pane under the pointer (DJ mode only);
 *   holds: what that deck holds - 'song' | 'code' | 'empty';
 *   onCode: over an editor's text.
 * -> { act, label, deck? }, `act` one of:
 *   'pass'   - not this handler's: a panel's own, or a file it has nothing to do with;
 *   'midi'   - import the MIDI file;
 *   'song'   - load the first file onto `deck`;
 *   'tracks' - add the files to the track collection;
 *   'sample' - add the files as samples, into the code when `at.onCode` or on a livecode deck;
 *   'none'   - nothing to do here, and `label` says where it would go.
 */
function fileDropAction(kind, at = {}, { mixMode = false } = {}) {
  const D = at.deck ? at.deck.toUpperCase() : '';
  if (at.panel === 'groove') return { act: 'pass', label: 'read the feel of it' };
  if (at.panel) return { act: 'pass', label: null };
  if (!kind) return { act: 'pass', label: 'drop a .mid or an audio file' };
  if (kind === 'midi') return { act: 'midi', label: 'import MIDI', deck: at.deck ?? null };
  if (at.organize) return { act: 'tracks', label: 'add to the track collection' };
  if (mixMode && at.deck) {
    if (at.holds !== 'code') return { act: 'song', label: `load onto deck ${D}`, deck: at.deck };
    if (kind === 'song') return { act: 'none', label: `only wav, aif, aiff, flac and mp3 can be a sample - deck ${D} is playing code` };
    return { act: 'sample', label: 'add as a sample to this code', deck: at.deck };
  }
  if (mixMode) return { act: 'none', label: 'drop on a deck to load it, or in organize to add it to the track collection' };
  if (kind === 'song') return { act: 'none', label: 'only wav, aif, aiff, flac and mp3 can be a sample' };
  if (at.onCode) return { act: 'sample', label: 'add as a sample to this code' };
  return { act: 'sample', label: 'add as a sample to the files pack' };
}

/** What a deck holds, for fileDropAction: its song, else its code unless that is only blank. */
function deckHolding({ song = false, code = '' } = {}) {
  if (song) return 'song';
  return String(code ?? '').trim() ? 'code' : 'empty';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { dropFileKind, dragKind, dropKindOfFiles, fileDropAction, deckHolding };
}
