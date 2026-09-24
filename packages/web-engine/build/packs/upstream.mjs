// Where the sourced sample packs come from, and exactly which recordings are taken.
//
// This file is the licensing record as much as it is a build input. Everything here was checked
// by reading the upstream project's own LICENSE file rather than its marketing: "free", "royalty
// free" and "free to use in your productions" all grant permission to USE and say nothing about
// permission to REDISTRIBUTE, which is what shipping a pack is. Only a public domain dedication
// or an attribution license clears that bar, and only those two appear below.
//
// WHAT IS DELIBERATELY ABSENT. There is no licensed recording of most of the classic drum
// machines - not the nine-oh-nine, not the linear-arithmetic boxes, not the early digital ones.
// The sets that circulate are either unlicensed outright (the widely used ones have open,
// unanswered requests for a LICENSE file going back years) or carry a dedication from somebody
// who was not the person who made the recording. Poptart's answer to that gap is to synthesize
// its own, which is what the rendered packs already are: audio we made is audio we can dedicate.
// See the web build entry in TODO.md.
//
// Nothing here is fetched at run time. A build step pulls these down and assembles a separate
// repository of packs (see fetch-packs.mjs); the app reads the index that build produces. The
// audio is not committed into this repository - a clone should not carry a hundred megabytes of
// other people's recordings - and the pinned commits in upstream.lock.json are what make a
// rebuild produce the same bytes as the build before it.

/**
 * The upstream projects. `ref` is what the build resolves to a commit; the resolved commit is
 * written to upstream.lock.json and is what later builds use, so a pack cannot change underneath
 * a song that was written against it.
 */
export const SOURCES = Object.freeze({
  drumbox: {
    title: 'Drum machine one-shots by Michael Fischer',
    kind: 'github',
    repo: 'tidalcycles/sounds-tr808-fischer',
    ref: 'main',
    license: 'CC0-1.0',
    by: 'Michael Fischer / Technopolis',
    // The provenance is unusually good and worth keeping with the files: a named person, a named
    // machine with its serial number, a date, and the method. Most drum machine sample sets on
    // the internet can say none of those things.
    provenance: 'Recorded from a Roland TR-808 (serial 103852) by Michael Fischer of Technopolis, 8 September 1994. '
      + 'Five dial positions per control, taken from the machine\'s individual outputs. '
      + 'Dedicated CC0 by the TidalCycles maintainers over the author\'s original "absolutely free" release.',
    homepage: 'https://github.com/tidalcycles/sounds-tr808-fischer',
  },

  vcsl: {
    title: 'Versilian Community Sample Library',
    kind: 'github',
    repo: 'sgossner/VCSL',
    ref: 'master',
    // The recordings live on the default branch; the per-instrument SFZ files, which are the
    // only reliable statement of what pitch each recording is at, live on a branch of their own.
    sfzRef: 'sfz',
    license: 'CC0-1.0',
    by: 'Versilian Studios LLC',
    provenance: 'Recorded by Versilian Studios and dedicated to the public domain. '
      + 'The library is several gigabytes; poptart takes one representative recording per instrument.',
    homepage: 'https://github.com/sgossner/VCSL',
  },

  freepats: {
    title: 'FreePats',
    kind: 'archive',
    license: 'CC0-1.0',
    by: 'FreePats contributors',
    provenance: 'Synthesized with free software instruments and dedicated to the public domain by the FreePats project. '
      + 'Each bank ships as an archive of FLAC recordings with an SFZ describing them.',
    homepage: 'https://freepats.zenvoid.org/',
  },
});

/**
 * The drum machine's own two-letter instrument names, in the order a kit is usually laid out.
 *
 * The dial positions in a filename are two digits each, and the trap is that `10` means the
 * knob at ten - its maximum - and not at one. So the musical order of the five positions is
 * 00, 25, 50, 75, 10, which is not their numeric order, and a pack sorted the obvious way puts
 * the brightest sample in the middle. `sweep` below is that order, written out once.
 */
export const DIAL_SWEEP = Object.freeze(['00', '25', '50', '75', '10']);

/** The dial position a kit's default sample is taken from: halfway up both controls. */
const MIDDLE = '50';

const DRUM_VOICES = Object.freeze([
  { code: 'BD', dir: 'bd8', name: 'kick', knobs: 2, title: 'Kick' },
  { code: 'SD', dir: 'sd8', name: 'snare', knobs: 2, title: 'Snare' },
  { code: 'RS', dir: 'rs8', name: 'rim', knobs: 0, title: 'Rim shot' },
  { code: 'CP', dir: 'cp8', name: 'clap', knobs: 0, title: 'Hand clap' },
  { code: 'CH', dir: 'ch8', name: 'hat', knobs: 0, title: 'Closed hi-hat' },
  { code: 'OH', dir: 'oh8', name: 'hatopen', knobs: 1, title: 'Open hi-hat' },
  { code: 'LT', dir: 'lt8', name: 'tomlo', knobs: 1, title: 'Low tom' },
  { code: 'MT', dir: 'mt8', name: 'tommid', knobs: 1, title: 'Mid tom' },
  { code: 'HT', dir: 'ht8', name: 'tomhi', knobs: 1, title: 'High tom' },
  { code: 'LC', dir: 'lc8', name: 'congalo', knobs: 1, title: 'Low conga' },
  { code: 'MC', dir: 'mc8', name: 'congamid', knobs: 1, title: 'Mid conga' },
  { code: 'HC', dir: 'hc8', name: 'congahi', knobs: 1, title: 'High conga' },
  { code: 'CY', dir: 'cy8', name: 'cymbal', knobs: 2, title: 'Cymbal' },
  { code: 'CB', dir: 'cb8', name: 'cowbell', knobs: 0, title: 'Cowbell' },
  { code: 'CL', dir: 'cl8', name: 'claves', knobs: 0, title: 'Claves' },
  { code: 'MA', dir: 'ma8', name: 'maracas', knobs: 0, title: 'Maracas' },
]);

/** Every file of one voice, in dial order: 1, 5 or 25 of them depending on its controls. */
export function voiceFiles(voice) {
  if (voice.knobs === 0) return [{ file: `${voice.dir}/${voice.code}.WAV`, name: voice.name, dial: null }];
  if (voice.knobs === 1) {
    return DIAL_SWEEP.map((d) => ({ file: `${voice.dir}/${voice.code}${d}.WAV`, name: `${voice.name}${d}`, dial: d }));
  }
  const out = [];
  for (const tone of DIAL_SWEEP) {
    for (const decay of DIAL_SWEEP) {
      out.push({ file: `${voice.dir}/${voice.code}${tone}${decay}.WAV`, name: `${voice.name}${tone}${decay}`, dial: `${tone}${decay}` });
    }
  }
  return out;
}

/** The one file that stands for a voice in the mixed kit: both controls at their midpoint. */
export function defaultFile(voice) {
  const dial = voice.knobs === 0 ? '' : voice.knobs === 1 ? MIDDLE : `${MIDDLE}${MIDDLE}`;
  return `${voice.dir}/${voice.code}${dial}.WAV`;
}

/**
 * The instruments taken from the community library, one recording each.
 *
 * `dir` is the instrument's folder; the build finds the SFZ that describes it and takes the
 * recording nearest the note below, so the sampler repitches as little as possible. They are
 * grouped into three packs rather than one because a pack is the unit somebody downloads, and
 * nobody wants forty megabytes of orchestral percussion to get a glockenspiel.
 */
export const VCSL_PACKS = Object.freeze([
  {
    id: 'pt_mallets',
    title: 'Mallets and bells',
    kind: 'melodic',
    description: 'Tuned percussion, one recording each, repitched by the sampler.',
    note: 60,
    instruments: [
      { dir: 'Idiophones/Struck Idiophones/Glockenspiel', name: 'glock' },
      { dir: 'Idiophones/Struck Idiophones/Vibraphone', name: 'vibes', prefer: 'Soft Mallets' },
      { dir: 'Idiophones/Struck Idiophones/Marimba', name: 'marimba' },
      { dir: 'Idiophones/Struck Idiophones/Xylophone', name: 'xylo', prefer: 'Medium Mallets' },
      { dir: 'Idiophones/Struck Idiophones/Tubular Bells 1', name: 'tubular' },
      { dir: 'Idiophones/Struck Idiophones/Hand Bells, Nepalese', name: 'handbell' },
      { dir: 'Idiophones/Struck Idiophones/Balafon', name: 'balafon' },
      { dir: 'Idiophones/Struck Idiophones/Tubular Glockenspiel', name: 'tubeglock' },
      { dir: 'Idiophones/Plucked Idiophones/Kalimba, Kenya', name: 'kalimba' },
      { dir: 'Idiophones/Plucked Idiophones/Mbira dzaVadzimu Nyamaropa, Zimbabwe, Low B', name: 'mbira' },
      { dir: 'Idiophones/Friction Idiophones/Wine Glasses', name: 'glass' },
    ],
  },
  {
    id: 'pt_piano',
    title: 'Keyboards',
    kind: 'melodic',
    description: 'Pianos, harpsichords and an organ, one recording each.',
    note: 60,
    instruments: [
      { dir: 'Chordophones/Zithers/Grand Piano, Kawai', name: 'grand' },
      { dir: 'Chordophones/Zithers/Upright Piano, Yamaha', name: 'upright' },
      { dir: 'Chordophones/Zithers/Harpsichord, French', name: 'harpsi' },
      { dir: 'Chordophones/Zithers/Harpsichord, Italian', name: 'harpsi2' },
      { dir: 'Chordophones/Zithers/Psaltery, Bowed and Plucked', name: 'psaltery', prefer: 'Plucked' },
      { dir: 'Chordophones/Composite Chordophones/Concert Harp', name: 'harp' },
      { dir: 'Chordophones/Composite Chordophones/Folk Harp', name: 'folkharp' },
      { dir: 'Chordophones/Composite Chordophones/Strumstick', name: 'strum' },
      { dir: 'Aerophones/Edge-blown Aerophones/Pipe Organ', name: 'organ' },
      { dir: 'Aerophones/Edge-blown Aerophones/Renaissance Organ', name: 'organ2' },
    ],
  },
  {
    id: 'pt_perc',
    title: 'Hand percussion',
    kind: 'drums',
    description: 'Acoustic percussion one-shots.',
    note: 60,
    instruments: [
      { dir: 'Membranophones/Struck Membranophones/Bongos', name: 'bongo' },
      { dir: 'Membranophones/Struck Membranophones/Conga', name: 'conga' },
      { dir: 'Membranophones/Struck Membranophones/Darbuka', name: 'darbuka' },
      { dir: 'Membranophones/Struck Membranophones/Frame Drum', name: 'frame' },
      { dir: 'Membranophones/Struck Membranophones/Timpani 1', name: 'timp' },
      { dir: 'Idiophones/Struck Idiophones/Claps', name: 'clap' },
      { dir: 'Idiophones/Struck Idiophones/Claves', name: 'claves' },
      { dir: 'Idiophones/Struck Idiophones/Cowbells', name: 'cowbell' },
      { dir: 'Idiophones/Struck Idiophones/Woodblock', name: 'woodblock' },
      { dir: 'Idiophones/Struck Idiophones/Triangles', name: 'triangle' },
      { dir: 'Idiophones/Struck Idiophones/Shaker, Small', name: 'shaker' },
      { dir: 'Idiophones/Struck Idiophones/Tambourine 1', name: 'tamb' },
      { dir: 'Idiophones/Struck Idiophones/Guiro', name: 'guiro' },
      { dir: 'Idiophones/Struck Idiophones/Cabasa', name: 'cabasa' },
      { dir: 'Idiophones/Struck Idiophones/Agogo Bells', name: 'agogo' },
      { dir: 'Idiophones/Struck Idiophones/Finger Cymbals', name: 'fingercym' },
    ],
  },
]);

/**
 * The synthesized banks, one sustained note each.
 *
 * These are tiny - a few tens of kilobytes apiece - because they were made with free software
 * synthesizers rather than recorded, which is also why their provenance is beyond question.
 * Each bank's archive holds an SFZ and a folder of recordings; the build takes the one nearest
 * middle C and keeps it in the format it arrives in, which browsers decode natively.
 *
 * They are SUSTAINED and looped upstream, so as one-shots they end when the recording does. That
 * is a usable sound for a livecoding pack - the sampler has its own envelope over the top - but
 * it is not the instrument the bank was cut for, and the loop points are carried in the manifest
 * for whenever the sampler learns to use them.
 */
export const FREEPATS_BANKS = Object.freeze([
  { name: 'bass1', title: 'Synth bass 1', repo: 'synth-bass-1', tag: '2019-07-23', file: 'SynthBass1-SFZ+FLAC-20190723.7z' },
  { name: 'bass2', title: 'Synth bass 2', repo: 'synth-bass-2', tag: '2021-04-05', file: 'SynthBass2-SFZ+FLAC-20210405.7z' },
  { name: 'latelybass', title: 'Lately bass', repo: 'lately-bass', tag: '2024-04-09', file: 'LatelyBass-SFZ+FLAC-20240409.7z' },
  { name: 'basslead', title: 'Bass and lead', repo: 'synth-bass-lead', tag: '2020-05-22', file: 'SynthBassLead-SFZ+FLAC-20200522.7z' },
  { name: 'brass1', title: 'Synth brass 1', repo: 'synth-brass-1', tag: '2021-04-26', file: 'SynthBrass1-SFZ+FLAC-20210426.7z' },
  { name: 'brass2', title: 'Synth brass 2', repo: 'synth-brass-2', tag: '2024-06-10', file: 'SynthBrass2-SFZ+FLAC-20240610.7z' },
  { name: 'square', title: 'Square lead', repo: 'synth-square', tag: '2020-05-12', file: 'SynthSquare-SFZ+FLAC-20200512.7z' },
  { name: 'calliope', title: 'Calliope lead', repo: 'synth-calliope', tag: '2020-05-12', file: 'SynthCalliope-SFZ+FLAC-20200512.7z' },
  { name: 'fifths', title: 'Fifths', repo: 'synth-fifths', tag: '2020-05-19', file: 'SynthFifths-SFZ+FLAC-20200519.7z' },
  { name: 'crystal', title: 'Crystal', repo: 'synth-crystal', tag: '2019-08-12', file: 'SynthCrystal-SFZ+FLAC-20190812.7z' },
  { name: 'choir', title: 'Choir pad', repo: 'synth-pad-choir', tag: '2020-05-16', file: 'SynthPadChoir-SFZ+FLAC-20200516.7z' },
  { name: 'bowed', title: 'Bowed pad', repo: 'synth-pad-bowed', tag: '2019-07-19', file: 'SynthPadBowed-SFZ+FLAC-20190719.7z' },
  { name: 'sweep', title: 'Sweep pad', repo: 'sweep-pad', tag: '2019-08-13', file: 'SweepPad-SFZ+FLAC-20190813.7z' },
  { name: 'newage', title: 'New age', repo: 'new-age', tag: '2019-07-30', file: 'NewAge-SFZ+FLAC-20190730.7z' },
  { name: 'strings1', title: 'Synth strings 1', repo: 'synth-strings-1', tag: '2020-05-28', file: 'SynthStrings1-SFZ+FLAC-20200528.7z' },
  { name: 'strings2', title: 'Synth strings 2', repo: 'synth-strings-2', tag: '2020-05-28', file: 'SynthStrings2-SFZ+FLAC-20200528.7z' },
  { name: 'goblins', title: 'Goblins', repo: 'synth-goblins', tag: '2020-06-12', file: 'SynthGoblins-SFZ+FLAC-20200612.7z' },
  { name: 'soundtrack', title: 'Soundtrack', repo: 'synth-soundtrack', tag: '20200521', file: 'SynthSoundtrack-SFZ+FLAC-20200521.7z' },
  { name: 'scifi', title: 'Sci-fi', repo: 'synth-scifi', tag: '2020-05-17', file: 'SynthSciFi-SFZ+FLAC-20200517.7z' },
]);

/** Where one FreePats bank's archive is downloaded from. */
export function freepatsUrl(bank) {
  return `https://github.com/freepats/${bank.repo}/releases/download/${bank.tag}/${bank.file}`;
}

/**
 * Every pack this build knows how to assemble, as a flat list of plans.
 *
 * A plan says which source it draws on and how to pick its files; fetch-packs.mjs turns one into
 * a folder of audio and a manifest. Splitting the description from the doing is what lets the
 * selection be unit-tested without anything being downloaded.
 */
export function packPlans() {
  const plans = [];

  plans.push({
    id: 'pt_drumbox',
    source: 'drumbox',
    title: 'Drum machine kit',
    kind: 'drums',
    description: 'One voice per slot, every control at its midpoint.',
    files: DRUM_VOICES.map((v) => ({ path: defaultFile(v), name: v.name })),
  });

  for (const voice of DRUM_VOICES) {
    if (voice.knobs === 0) continue;   // nothing to sweep; it is already in the kit above
    plans.push({
      id: `pt_drumbox_${voice.name}`,
      source: 'drumbox',
      title: `${voice.title} sweep`,
      kind: 'drums',
      description: voice.knobs === 2
        ? 'Every combination of the two controls, tone first then decay, in dial order.'
        : 'The one control swept, in dial order.',
      files: voiceFiles(voice).map((f) => ({ path: f.file, name: f.name })),
    });
  }

  for (const pack of VCSL_PACKS) {
    plans.push({
      id: pack.id,
      source: 'vcsl',
      title: pack.title,
      kind: pack.kind,
      description: pack.description,
      instruments: pack.instruments,
      note: pack.note,
    });
  }

  plans.push({
    id: 'pt_synth',
    source: 'freepats',
    title: 'Synthesizer one-shots',
    kind: 'melodic',
    description: 'One sustained note from each synthesized bank.',
    banks: FREEPATS_BANKS,
    note: 60,
  });

  return plans;
}
