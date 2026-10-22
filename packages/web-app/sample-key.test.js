'use strict';

// A sample's key from its file name (public/sample-key.js): what the track list says beside a
// sampler track. Strict on purpose - a name that does not plainly state a key is "unknown".

const test = require('node:test');
const assert = require('node:assert/strict');

const { keyFromSampleName: key } = require('./public/sample-key.js');

test('the spellings sample packs use, in the spelling .scale() takes', () => {
  assert.equal(key('Psy_Hyp_Lead_Am_140.wav'), 'A minor');
  assert.equal(key('Cymatics - Lead Loop 1 - 140 BPM A Min.wav'), 'A minor');
  assert.equal(key('LOOP_120_Gm.wav'), 'G minor');
  assert.equal(key('Vox_D_Major.aif'), 'D major');
  assert.equal(key('Bass - C sharp minor.wav'), 'C# minor');
  assert.equal(key('pad F# maj.wav'), 'F# major');
  assert.equal(key('Bbm_stab.wav'), 'Bb minor');
  assert.equal(key('120bpm_Cmin_lead.wav'), 'C minor');
  assert.equal(key('drum loop (Em) 128.flac'), 'E minor');
  assert.equal(key('CM_chord.wav'), 'C major');
  assert.equal(key('synth_F#.wav'), 'F#'); // a note with no mode is said as just the note
  assert.equal(key('Eb_pad.wav'), 'Eb');
});

test('words that only look like keys are not keys', () => {
  assert.equal(key('psyhyp_09.wav'), null);
  assert.equal(key('kick_A.wav'), null); // a take letter
  assert.equal(key('snare b.wav'), null);
  assert.equal(key('I_am_here.wav'), null);
  assert.equal(key('eb_pad.wav'), null);
  assert.equal(key('Dmaj7_pad.wav'), null); // a chord, not a key
});

test('the last key named wins, and a folder in the path is not read', () => {
  assert.equal(key('Am/loop_C_major.wav'), 'C major');
  assert.equal(key('Am_to_Em_riser.wav'), 'E minor');
});
