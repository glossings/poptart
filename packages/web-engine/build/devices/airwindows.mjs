// The Airwindows effects poptart ports, and how to read a descriptor out of their source.
//
// Airwindows plugins are all written to the same shape, which is what makes this a list rather
// than a pile of special cases: `<Name>.h` declares the parameter enum, `<Name>.cpp` sets the
// defaults in its constructor and names the parameters for the host, and `<Name>Proc.cpp` is the
// DSP. Nothing here is hand-copied from those files - the names, the count and the defaults are
// READ OUT of them at build time, so a plugin whose control was renamed upstream cannot end up
// with poptart showing the old name beside the new behavior.
//
// Everything is MIT (verified in each file's own header, 2026-09-22) and every parameter is a
// plain 0..1 slider, which is the other half of why these port mechanically.

/** The chosen revision of each effect, and what poptart calls it. */
export const AIRWINDOWS = Object.freeze([
  // One remains of a set of nine: the others were plain saturation, dynamics and console
  // emulation that poptart now writes itself, in worklets whose controls follow the same
  // contract as every other device. The reverb is the one that earns its binary.
  { id: 'Galactic', upstream: 'Galactic', kind: 'fx', description: 'A very large reverb, pitched toward the unreal end.' },
]);

/** The files one effect is built from, in the order they are compiled. */
export function filesFor(upstream) {
  return [`${upstream}.h`, `${upstream}.cpp`, `${upstream}Proc.cpp`];
}

export function upstreamPath(upstream, file) {
  return `plugins/LinuxVST/src/${upstream}/${file}`;
}

/**
 * How many parameters the effect has, from its own enum.
 *
 * Read rather than assumed: they range from two to eight across the set, and guessing four
 * would give some of them controls that do nothing and hide the rest.
 */
export function paramCount(header) {
  const m = header.match(/kNumParameters\s*=\s*(\d+)/);
  if (!m) throw new Error('no kNumParameters in the header - the plugin is not shaped the way this build expects');
  return Number(m[1]);
}

/**
 * The parameter names the plugin reports to a host, in slot order.
 *
 * `getParameterName` is a switch of `case kParamA: vst_strncpy(text, "Density", ...)`, and the
 * letters are the slot order, so the names come out in the order the values go in.
 */
export function paramNames(source, count) {
  const body = source.slice(source.indexOf('getParameterName'));
  const names = [];
  for (let i = 0; i < count; i++) {
    const letter = String.fromCharCode(65 + i);
    const re = new RegExp(`case\\s+kParam${letter}\\s*:[^;]*?vst_strncpy\\s*\\(\\s*text\\s*,\\s*"([^"]*)"`, 's');
    const m = body.match(re);
    names.push(m ? m[1].trim() : letter);
  }
  return names;
}

/**
 * The value each control rests at, from the constructor.
 *
 * These are not all 0.5: Density rests at 0.2 and most wet/dry controls at 1.0, and a plugin
 * loaded at the wrong defaults sounds like the wrong plugin.
 */
export function paramDefaults(source, count) {
  const ctor = source.slice(source.indexOf('::'), source.indexOf('}', source.indexOf('_canDo')));
  const out = [];
  for (let i = 0; i < count; i++) {
    const letter = String.fromCharCode(65 + i);
    const m = ctor.match(new RegExp(`(?:^|\\n)\\s*${letter}\\s*=\\s*([0-9.]+)\\s*;`));
    out.push(m ? Number(m[1]) : 0.5);
  }
  return out;
}

/**
 * What each control MEANS, by device and control id.
 *
 * Nothing upstream carries this: an Airwindows plugin is a list of 0..1 sliders with names like
 * "Replace" and "Bigness", and the explanation lives in a blog post rather than in the source.
 * A name nobody can guess the meaning of is the same as no name, so the ones that need it are
 * written here - once, where the generator can reach them - rather than left for a person to
 * work out by turning the knob and listening.
 */
const PARAM_NOTES = new Map(Object.entries({
  'Galactic.replace': 'How much of the reverb tail is replaced by new sound as it decays, rather than being fed back. Low keeps a long tail going; high keeps the tail following what is played into it.',
  'Galactic.brightness': 'How much high end survives each pass round the tank. Down is a dark hall; up is a bright metallic one.',
  'Galactic.detune': 'Pitch drift inside the tail, which is what stops a very long reverb ringing on one note. A little is a chorus on the tail; a lot is the unreal end of this device.',
  'Galactic.bigness': 'The size of the space - how long the tail runs and how far apart its reflections are.',
  'Galactic.drywet': 'Dry against reverb.',
}));

/** A name a person would rather read than "Ovrdrv" or "Hi Pass". */
const TIDY = new Map([
  ['Ovrdrv', 'Overdrive'],
  ['Hi Pass', 'High Pass'],
  ['Dry/Wet', 'Mix'],
  ['Drywet', 'Mix'],
  ['Dry-Wet', 'Mix'],
  ['Outgain', 'Output'],
  ['Out Gain', 'Output'],
  ['Outlevel', 'Output'],
]);

/**
 * The device descriptor for one effect, read out of its source.
 *
 * Every Airwindows control is a 0..1 slider with no unit, which is faithful rather than lazy:
 * the plugins scale them internally and there is no honest number to print beside most of them.
 */
export function descriptorFrom(entry, header, source) {
  const count = paramCount(header);
  const names = paramNames(source, count);
  const defaults = paramDefaults(source, count);
  return {
    id: entry.id,
    kind: entry.kind,
    version: 1,
    description: entry.description,
    vendor: 'Airwindows',
    license: 'MIT',
    source: `https://github.com/airwindows/airwindows (${entry.upstream})`,
    build: 'wasm',
    processor: `poptart-wasm-${entry.id.toLowerCase()}`,
    channels: { in: 2, out: 2 },
    params: names.map((name, i) => {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '') || `p${i}`;
      const description = PARAM_NOTES.get(`${entry.id}.${id}`) ?? null;
      return {
        id,
        name: TIDY.get(name) ?? name,
        min: 0,
        max: 1,
        default: defaults[i],
        // Read once a block, like everything else a worklet reads; see the note in shared.mjs.
        rate: 'a',
        group: 'Controls',
        ...(description ? { description } : {}),
      };
    }),
  };
}
