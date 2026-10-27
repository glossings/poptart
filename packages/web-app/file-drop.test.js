'use strict';

// What a file dropped on the window does where it lands (public/file-drop.js) - the one decision
// both the drag overlay's words and the drop itself read, on both builds.

const test = require('node:test');
const assert = require('node:assert/strict');

const { dropFileKind, dragKind, dropKindOfFiles, fileDropAction, deckHolding } = require('./public/file-drop.js');

const mix = { mixMode: true };

test('a file is MIDI, a sample, a song-only format, or nothing of ours', () => {
  assert.equal(dropFileKind('take.mid'), 'midi');
  assert.equal(dropFileKind('take.MIDI'), 'midi');
  assert.equal(dropFileKind('noname', 'audio/midi'), 'midi');
  assert.equal(dropFileKind('loop.wav'), 'sample');
  assert.equal(dropFileKind('Track.FLAC'), 'sample');
  assert.equal(dropFileKind('set.m4a'), 'song');
  // Ogg plays on a song deck only where the browser decodes it.
  assert.equal(dropFileKind('set.ogg'), null);
  assert.equal(dropFileKind('set.ogg', '', { web: true }), 'song');
  assert.equal(dropFileKind('notes.txt'), null);
});

test('mid-drag, only the MIME types say what is coming', () => {
  assert.equal(dragKind(['audio/wav']), 'audio');
  assert.equal(dragKind(['audio/x-m4a', 'audio/midi']), 'midi');
  assert.equal(dragKind(['audio/mid']), 'midi');
  assert.equal(dragKind(['text/plain', '']), null);
  assert.equal(dropKindOfFiles(['sample', 'midi']), 'midi');
  assert.equal(dropKindOfFiles(['sample', 'song']), 'audio');
  assert.equal(dropKindOfFiles(['song', null]), 'song');
  assert.equal(dropKindOfFiles([null]), null);
});

test('DJ mode: a song loads onto an empty deck or one holding a song', () => {
  assert.deepEqual(fileDropAction('sample', { deck: 'a', holds: 'empty' }, mix), { act: 'song', label: 'load onto deck A', deck: 'a' });
  assert.deepEqual(fileDropAction('song', { deck: 'b', holds: 'song' }, mix), { act: 'song', label: 'load onto deck B', deck: 'b' });
  assert.equal(fileDropAction('audio', { deck: 'b', holds: 'song', onCode: true }, mix).act, 'song');
});

test('DJ mode: audio on a deck holding livecode becomes a sample in that code', () => {
  assert.deepEqual(fileDropAction('sample', { deck: 'b', holds: 'code', onCode: true }, mix),
    { act: 'sample', label: 'add as a sample to this code', deck: 'b' });
  // Off the text but on the deck: still that deck's code.
  assert.equal(fileDropAction('audio', { deck: 'a', holds: 'code' }, mix).deck, 'a');
  // A format the sampler can't play is refused, and says why.
  const refused = fileDropAction('song', { deck: 'a', holds: 'code' }, mix);
  assert.equal(refused.act, 'none');
  assert.match(refused.label, /can be a sample/);
});

test('organize takes audio into the track collection, in or out of DJ mode', () => {
  for (const opts of [mix, {}]) {
    assert.deepEqual(fileDropAction('sample', { organize: true }, opts), { act: 'tracks', label: 'add to the track collection' });
    assert.equal(fileDropAction('song', { organize: true, deck: 'a', holds: 'empty' }, opts).act, 'tracks');
  }
});

test('outside DJ mode, audio on the code becomes a sample there', () => {
  assert.deepEqual(fileDropAction('sample', { onCode: true }), { act: 'sample', label: 'add as a sample to this code' });
  assert.deepEqual(fileDropAction('audio', {}), { act: 'sample', label: 'add as a sample to the files pack' });
  assert.equal(fileDropAction('song', { onCode: true }).act, 'none');
  // The deck panes only mean decks in DJ mode.
  assert.equal(fileDropAction('sample', { deck: 'a', holds: 'empty', onCode: true }).act, 'sample');
});

test('a .mid imports wherever it lands, except where a panel takes its own drops', () => {
  assert.deepEqual(fileDropAction('midi', { onCode: true }), { act: 'midi', label: 'import MIDI', deck: null });
  assert.equal(fileDropAction('midi', { deck: 'b', holds: 'song' }, mix).deck, 'b');
  assert.deepEqual(fileDropAction('midi', { panel: 'pack' }), { act: 'pass', label: null });
  assert.deepEqual(fileDropAction('sample', { panel: 'groove', onCode: true }), { act: 'pass', label: 'read the feel of it' });
});

test('DJ mode off both decks and organize: nothing happens, and the overlay says where to go', () => {
  const r = fileDropAction('sample', {}, mix);
  assert.equal(r.act, 'none');
  assert.match(r.label, /deck/);
  assert.equal(fileDropAction(null, { onCode: true }, mix).act, 'pass');
});

test("a deck's holding: its song, else code unless the buffer is blank", () => {
  assert.equal(deckHolding({ song: true, code: 'x' }), 'song');
  assert.equal(deckHolding({ code: 's("bd")' }), 'code');
  assert.equal(deckHolding({ code: '  \n\t' }), 'empty');
  assert.equal(deckHolding({}), 'empty');
});
