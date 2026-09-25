// The sourced sample packs: reading an upstream library's description of itself, choosing what
// to take, and reading back an index that arrived over the network.
//
// The fetching is not tested and cannot usefully be - it is a download. What IS tested is every
// decision made around it, because those are the ones that go wrong quietly: a sample chosen by
// its filename instead of its stated pitch plays a fifth out, an index taken on trust can point
// the app at any URL it likes, and a pack that loses its license on the way through is a pack
// that should never have shipped.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex, creditLine, fileUrl, isSafeRelativePath, validateIndex, INDEX_FORMAT } from './src/packs/library.mjs';
import { validateManifest } from './src/packs/manifest.mjs';
import { chooseRegion, noteNumber, parseSfz, readOpcodes, regionRoot, samplePath } from './build/packs/sfz.mjs';
import { chooseFromSfz, findSfz, planInstruments, servedName } from './build/packs/plan.mjs';
import { DIAL_SWEEP, defaultFile, packPlans, voiceFiles } from './build/packs/upstream.mjs';

// ---- reading an SFZ ---------------------------------------------------------------------------

test('note names are read the way SFZ writes them, with c4 as sixty', () => {
  assert.equal(noteNumber('c4'), 60);
  assert.equal(noteNumber('C4'), 60);
  assert.equal(noteNumber('a4'), 69);
  assert.equal(noteNumber('c#4'), 61);
  assert.equal(noteNumber('db4'), 61);
  assert.equal(noteNumber('c-1'), 0);
  assert.equal(noteNumber('60'), 60);
  assert.equal(noteNumber('nonsense'), null);
  assert.equal(noteNumber(''), null);
});

test('a sample path with spaces and commas survives being read', () => {
  // This is the one that matters: a library whose folders are named "Kalimba, Kenya" writes
  // paths with spaces in them, and splitting opcodes on whitespace truncates every one.
  const opcodes = readOpcodes('seq_length=2 sample=Kalimba, Kenya/Mbira6_MainSpirit_D#3_k6.wav pitch_keycenter=63');
  assert.equal(opcodes.sample, 'Kalimba, Kenya/Mbira6_MainSpirit_D#3_k6.wav');
  assert.equal(opcodes.pitch_keycenter, '63');
  assert.equal(opcodes.seq_length, '2');
});

test('a region inherits from its group and its global, and a new group replaces the last', () => {
  const { regions } = parseSfz(`
    <global> ampeg_release=0.5
    <group> volume=3
    <region> sample=a.wav key=60
    <group> volume=9
    <region> sample=b.wav key=62
  `);
  assert.equal(regions.length, 2);
  assert.equal(regions[0].ampeg_release, '0.5');
  assert.equal(regions[0].volume, '3');
  assert.equal(regions[1].volume, '9', 'the second group replaces the first rather than merging');
  assert.equal(regions[1].ampeg_release, '0.5', 'but global still reaches it');
});

test('comments are stripped, including the header banner these libraries use', () => {
  const { regions } = parseSfz(`
    //+ Name: Synth Bass 1
    //+ URL: https://example.invalid/
    <region> sample=samples/C4.flac pitch_keycenter=60 // the one we want
  `);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].sample, 'samples/C4.flac');
  assert.equal(regions[0].pitch_keycenter, '60');
});

test('default_path is put in front of every sample path', () => {
  const { control, regions } = parseSfz('<control> default_path=Samples/ \n <region> sample=a.wav key=60');
  assert.equal(samplePath(regions[0], control), 'Samples/a.wav');
});

test('a pitch is taken from the keycenter, or from a range that covers one key, or not at all', () => {
  assert.equal(regionRoot({ pitch_keycenter: '67' }), 67);
  assert.equal(regionRoot({ key: 'c4' }), 60);
  assert.equal(regionRoot({ lokey: '60', hikey: '60' }), 60);
  assert.equal(regionRoot({ lokey: '60', hikey: '72' }), null, 'a range of a whole octave has no one pitch');
});

test('the recording nearest the wanted pitch wins, then the layer an ordinary strike falls in', () => {
  const regions = [
    { sample: 'far.wav', pitch_keycenter: '84' },
    { sample: 'soft.wav', pitch_keycenter: '60', lovel: '0', hivel: '40' },
    { sample: 'mid.wav', pitch_keycenter: '60', lovel: '41', hivel: '110' },
  ];
  assert.equal(chooseRegion(regions, { note: 60 }).region.sample, 'mid.wav');
  assert.equal(chooseRegion(regions, { note: 60, velocity: 20 }).region.sample, 'soft.wav');
  assert.equal(chooseRegion(regions, { note: 86 }).region.sample, 'far.wav');
});

test('a key-release tail is never taken for the note itself', () => {
  // Several of these instruments ship their release tails as regions in the same file as the
  // notes. A release is what a key sounds like on the way UP - a thud and a decay - so a piano
  // whose one recording came from that folder is an instrument nobody would recognize.
  const regions = [
    { sample: 'Releases/piano_rel_C3.wav', pitch_keycenter: '60', trigger: 'release' },
    { sample: 'Sustains/piano_sus_C3.wav', pitch_keycenter: '60' },
  ];
  assert.equal(chooseRegion(regions, { note: 60 }).region.sample, 'Sustains/piano_sus_C3.wav');
  assert.equal(chooseRegion([regions[0]], { note: 60 }), null, 'and an instrument of nothing but tails yields nothing');
});

test('an articulation of nothing but tails is not the default reading of an instrument', () => {
  const paths = ['C/Wine Glasses - Releases.sfz', 'C/Wine Glasses - Sustains.sfz'];
  assert.equal(findSfz(paths, 'C/Wine Glasses'), 'C/Wine Glasses - Sustains.sfz');
});

test('round robins are resolved to the first, so a rebuilt pack plays what the old one did', () => {
  const regions = [
    { sample: 'b.wav', pitch_keycenter: '60', seq_position: '2' },
    { sample: 'a.wav', pitch_keycenter: '60', seq_position: '1' },
  ];
  assert.equal(chooseRegion(regions, { note: 60 }).region.sample, 'a.wav');
});

test('a transposed description is believed over the note in the filename', () => {
  // One of these libraries generates its descriptions with a transpose, so the file called G4
  // is mapped an octave below where its name suggests. Reading the name instead of the
  // description would put the whole instrument out by an octave.
  const chosen = chooseFromSfz(
    'Idiophones/Struck Idiophones/Glockenspiel.sfz',
    '<region> sample=Glockenspiel/glock_soft_G4_01.wav pitch_keycenter=67',
    { note: 60 },
  );
  assert.equal(chosen.rootNote, 67);
  assert.equal(chosen.path, 'Idiophones/Struck Idiophones/Glockenspiel/glock_soft_G4_01.wav');
});

test('loop points are carried through for a recording that was cut as a sustained note', () => {
  const chosen = chooseFromSfz('x.sfz', '<region> sample=s/C4.flac pitch_keycenter=60 loop_start=100 loop_end=5000');
  assert.deepEqual(chosen.loop, { start: 100, end: 5000 });
});

// ---- finding the description for an instrument ------------------------------------------------

test('an instrument is matched to the description that sits beside its folder', () => {
  const paths = [
    'Idiophones/Struck Idiophones/Glockenspiel.sfz',
    'Idiophones/Struck Idiophones/Glockenspiel/glock_soft_G4_01.wav',
    'Idiophones/Struck Idiophones/Marimba.sfz',
    'Chordophones/Zithers/Glockenspiel.sfz',
  ];
  assert.equal(
    findSfz(paths, 'Idiophones/Struck Idiophones/Glockenspiel'),
    'Idiophones/Struck Idiophones/Glockenspiel.sfz',
    'and not to the one of the same name in another category',
  );
  assert.equal(findSfz(paths, 'Idiophones/Struck Idiophones/Nonesuch'), null);
});

test('an articulation can be asked for, and the combined keyswitch file is never the default', () => {
  const paths = [
    'I/S/Vibraphone - Bowed.sfz',
    'I/S/Vibraphone - Hard Mallets.sfz',
    'I/S/Vibraphone - Soft Mallets.sfz',
    'I/S/Vibraphone - Keyswitch.sfz',
  ];
  assert.equal(findSfz(paths, 'I/S/Vibraphone', 'Soft Mallets'), 'I/S/Vibraphone - Soft Mallets.sfz');
  assert.equal(findSfz(paths, 'I/S/Vibraphone'), 'I/S/Vibraphone - Bowed.sfz', 'shortest plain name, never the keyswitch');
});

// ---- the drum machine's dial positions --------------------------------------------------------

test('the dial sweep is in musical order, where ten is the top of the dial and not the bottom', () => {
  assert.deepEqual([...DIAL_SWEEP], ['00', '25', '50', '75', '10']);
  assert.notEqual(DIAL_SWEEP[1], '10', 'sorting these as numbers puts the brightest sample in the middle');
});

test('a two-control voice sweeps both, tone first, and a no-control voice is one file', () => {
  const kick = voiceFiles({ code: 'BD', dir: 'bd8', name: 'kick', knobs: 2 });
  assert.equal(kick.length, 25);
  assert.equal(kick[0].file, 'bd8/BD0000.WAV');
  assert.equal(kick[24].file, 'bd8/BD1010.WAV');
  const cowbell = voiceFiles({ code: 'CB', dir: 'cb8', name: 'cowbell', knobs: 0 });
  assert.deepEqual(cowbell.map((f) => f.file), ['cb8/CB.WAV']);
});

test('the kit takes each voice from the middle of its dials', () => {
  assert.equal(defaultFile({ code: 'BD', dir: 'bd8', knobs: 2 }), 'bd8/BD5050.WAV');
  assert.equal(defaultFile({ code: 'OH', dir: 'oh8', knobs: 1 }), 'oh8/OH50.WAV');
  assert.equal(defaultFile({ code: 'CB', dir: 'cb8', knobs: 0 }), 'cb8/CB.WAV');
});

test('every planned pack has a usable id and would pass the shipping check', () => {
  for (const plan of packPlans()) {
    assert.ok(plan.id.startsWith('pt_'), `${plan.id} must not take a name somebody wants for their own pack`);
    assert.ok(/^[a-z0-9_]+$/.test(plan.id), `${plan.id} has to be typeable inside sp("…")`);
    assert.ok(plan.title, `${plan.id} needs a title`);
  }
  const ids = packPlans().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'two packs cannot share a name');
});

test('a served name says what the sound is and keeps the extension it arrived with', () => {
  assert.equal(servedName('kick', 'bd8/BD5050.WAV'), 'kick.wav');
  assert.equal(servedName('glock', 'x/glock_soft_G4_01.wav'), 'glock.wav');
  assert.equal(servedName('bass1', 's/C4.flac'), 'bass1.flac');
});

// ---- reading an index that came off the network -----------------------------------------------

const goodPack = {
  id: 'pt_test',
  title: 'Test',
  kind: 'drums',
  files: [{ file: 'kick.wav', name: 'kick', license: 'CC0-1.0', source: 'https://example.invalid/kick' }],
};

test('a well-formed index is read, and a pack index becomes the sample index', () => {
  const { packs, problems } = validateIndex({ format: INDEX_FORMAT, packs: [goodPack] });
  assert.equal(problems.length, 0);
  assert.equal(packs[0].files[0].index, 0);
  assert.equal(packs[0].files[0].license, 'CC0-1.0');
});

test('an index from a format this build does not read is refused outright', () => {
  const { packs, problems } = validateIndex({ format: 'something-else', packs: [goodPack] });
  assert.equal(packs.length, 0);
  assert.ok(problems[0].includes('something-else'));
});

test('one bad pack is dropped with a reason and the rest of the index still loads', () => {
  const { packs, problems } = validateIndex({
    format: INDEX_FORMAT,
    packs: [goodPack, { ...goodPack, id: 'pt_nolicense', files: [{ file: 'a.wav', source: 'x' }] }],
  });
  assert.equal(packs.length, 1, 'a broken entry must not empty the sample browser');
  assert.ok(problems.some((p) => p.includes('pt_nolicense') && p.includes('license')));
});

test('a pack cannot point the app anywhere but at its own folder', () => {
  for (const bad of ['../secrets.wav', '/etc/passwd', 'https://elsewhere.invalid/a.wav', 'a//b.wav', 'a\\b.wav']) {
    assert.equal(isSafeRelativePath(bad), false, `${bad} should be refused`);
  }
  assert.equal(isSafeRelativePath('sub/kick.wav'), true);

  const { packs, problems } = validateIndex({
    format: INDEX_FORMAT,
    packs: [{ ...goodPack, id: 'pt_escape', files: [{ ...goodPack.files[0], file: '../../etc/passwd' }] }],
  });
  assert.equal(packs.length, 0);
  assert.ok(problems[0].includes('pt_escape'));
});

test('a file URL is built under the pack, and refuses to be built anywhere else', () => {
  assert.equal(fileUrl('https://cdn.invalid/packs/', 'pt_test', 'kick.wav'), 'https://cdn.invalid/packs/pt_test/kick.wav');
  assert.throws(() => fileUrl('https://cdn.invalid', 'pt_test', '../x.wav'));
  assert.throws(() => fileUrl('https://cdn.invalid', 'notours', 'kick.wav'));
});

test('an index round-trips through building and reading it back', () => {
  const manifest = validateManifest({
    ...goodPack,
    files: [
      { file: 'glock.wav', name: 'glock', license: 'CC0-1.0', source: 'https://example.invalid/g', rootNote: 67 },
      { file: 'bass.flac', name: 'bass', license: 'CC-BY-4.0', source: 'https://example.invalid/b', by: 'Someone', loop: { start: 10, end: 90 } },
    ],
  });
  const index = buildIndex([manifest], { sizes: { pt_test: 1234 } });
  const { packs, problems } = validateIndex(index);
  assert.equal(problems.length, 0);
  assert.equal(packs[0].bytes, 1234);
  assert.equal(packs[0].files[0].rootNote, 67, 'the pitch a recording holds has to survive the round trip');
  assert.deepEqual(packs[0].files[1].loop, { start: 10, end: 90 });
});

test('an attribution license with nobody to credit is refused', () => {
  assert.throws(
    () => validateManifest({ ...goodPack, files: [{ file: 'a.wav', license: 'CC-BY-4.0', source: 'https://x.invalid' }] }),
    /nobody to credit/,
  );
});

test('the credit line names the license and everyone who has to be named', () => {
  const manifest = validateManifest({
    ...goodPack,
    files: [{ file: 'a.wav', license: 'CC-BY-4.0', source: 'https://x.invalid', by: 'A Person' }],
  });
  const line = creditLine(manifest);
  assert.ok(line.includes('CC-BY-4.0'));
  assert.ok(line.includes('A Person'));
});

test('an instrument can name the key it is taken from, and the root it really has', async () => {
  const sfz = [
    '<region> sample=Frame Drum/Hand.wav pitch_keycenter=60 lokey=60 hikey=60',
    '<region> lovel=0 hivel=83 sample=Frame Drum/Hit_v2.wav pitch_keycenter=61 lokey=61 hikey=61',
    '<region> lovel=84 hivel=127 sample=Frame Drum/Hit_v3.wav pitch_keycenter=61 lokey=61 hikey=61',
  ].join('\n');
  const plan = { id: 'pt_perc', note: 60, instruments: [
    { dir: 'M/Frame Drum', name: 'frame', note: 61, rootNote: 60 },
    { dir: 'M/Frame Drum', name: 'rub' },
    { dir: 'M/Frame Drum', name: 'pitched', note: 61 },
  ] };
  const { manifest } = await planInstruments(plan, { homepage: 'https://x.invalid' }, { audio: 'a' }, ['M/Frame Drum.sfz'], async () => sfz);
  assert.deepEqual(manifest.files.map((f) => f.from), ['M/Frame Drum/Hit_v3.wav', 'M/Frame Drum/Hand.wav', 'M/Frame Drum/Hit_v3.wav']);
  assert.deepEqual(manifest.files.map((f) => f.rootNote), [60, 60, 61], 'a key it is only filed under says so; otherwise the key is the pitch');
});
