// Cloud Seed, and the forty-five controls it has.
//
// Unlike the Airwindows ports, the names here are written out rather than read from the source.
// They have to be: upstream's label array is grouped for its own panel, so it repeats ("Mod
// Amt" three times, "Diffusion" twice) and - checked against the enum on 2026-09-22 - the first
// few entries are out of step with the constants they are supposed to name. Poptart needs every
// control to have a name of its own, because `.param("Mod Amt", …)` has to mean one thing.
//
// The ORDER is the contract: `SetParameter(index, value)` takes the enum's index, so this list
// must stay in the enum's order. The ids below are what a pattern writes, so they are also a
// promise; adding a control upstream would append, which is safe, but reordering would not be.
//
// MIT, copyright Ghost Note Engineering Ltd. The project moved from its original home and the
// algorithm core is published separately - see the lock file for which repository is pinned.

const IN = 'Input';
const OUT = 'Output';
const TAP = 'Multitap';
const EARLY = 'Early';
const LATE = 'Late';
const EQ = 'Equalizer';
const SEED = 'Seeds';

/**
 * What each control MEANS, by id.
 *
 * Nothing upstream carries this: the plugin is a list of sliders named after the stage of the
 * algorithm they belong to, and knowing what "Late Diffuse Mod Rate" does means knowing how the
 * reverb is built. A name nobody can act on is the same as no name, so the explanations live
 * here - beside the list, where the generator can reach them.
 */
const NOTES = Object.freeze({
    "interpolation": "Smooths the delay lines as they are modulated, so a moving line glides instead of stepping. Off is cheaper and grainier.",
    "lowcuton": "Whether the low cut below is in the path at all.",
    "highcuton": "Whether the high cut below is in the path at all.",
    "inputmix": "How much the two channels are summed before the reverb. Up is a mono feed, which keeps the tail centered.",
    "lowcut": "Takes the bottom off what goes INTO the tank, so low notes do not turn the tail to mud.",
    "highcut": "Takes the top off what goes into the tank, which is most of what makes this reverb dark.",
    "dry": "The untouched signal. This is a reverb with separate dry, early and late levels rather than one mix knob.",
    "early": "The level of the early reflections - the taps and the early diffuser, which are the first thing you hear back.",
    "late": "The level of the tail: the delay lines that go on feeding each other after the early reflections have gone.",
    "tapon": "Whether the multitap stage runs. It is the first set of reflections, before any diffusion.",
    "tapcount": "How many discrete echoes the multitap stage makes. A few is a slapback; many is the start of a room.",
    "tapdecay": "How much quieter each tap is than the one before it.",
    "tappredelay": "How long before the first tap arrives - the gap between the sound and the space answering it.",
    "taplength": "How far apart the taps are spread in time, which is what reads as the size of the room.",
    "earlydiffuseon": "Whether the early reflections are smeared by an allpass chain. Off leaves them as distinct echoes.",
    "earlystages": "How many allpass stages the early diffuser runs. More smears the reflections further into a wash.",
    "earlydelay": "The length of each early allpass stage, which sets the grain of that smear.",
    "earlymodamount": "How far the early stages are wobbled, which stops them ringing on one note.",
    "earlyfeedback": "How much of the early diffuser is fed back into itself - how long that first wash lasts.",
    "earlymodrate": "How fast that wobble runs.",
    "latemode": "How the late lines are wired: in parallel, or each one feeding the next.",
    "latelines": "How many delay lines make the tail. More is a denser and smoother tail for more work.",
    "latediffuseon": "Whether the tail is smeared by allpasses as well as delayed.",
    "latestages": "How many allpass stages that smear uses.",
    "latesize": "The length of the late delay lines: the size of the space the tail is running round.",
    "latelinemodamount": "How far the late delay lines are wobbled, which is what keeps a very long tail from settling into a ringing tone.",
    "latedelay": "The length of each late allpass stage.",
    "latediffusemodamount": "How far the late diffuser is wobbled, on top of the lines.",
    "latedecay": "How long the tail runs for. Near the top it barely decays at all, which is what this reverb is for.",
    "latelinemodrate": "How fast the delay lines wobble.",
    "latefeedback": "How much of the tail is fed back into the lines - density rather than length.",
    "latediffusemodrate": "How fast the late diffuser wobbles.",
    "lowshelfon": "Whether the low shelf below is in the tail’s feedback path.",
    "highshelfon": "Whether the high shelf below is in the tail’s feedback path.",
    "lowpasson": "Whether the lowpass below is in the tail’s feedback path. This is the usual way to make a tail darken as it decays.",
    "lowfreq": "Where the low shelf sits.",
    "highfreq": "Where the high shelf sits.",
    "cutoff": "Where the lowpass sits. It is inside the feedback, so the tail darkens as it goes.",
    "lowgain": "How much the low shelf lifts or cuts, per pass round the tank.",
    "highgain": "How much the high shelf lifts or cuts, per pass round the tank.",
    "crossseed": "How different the left and right sides are. Zero is the same space in both ears; up is two related spaces.",
    "tapseed": "Which random arrangement the multitap stage uses. Rearranges the echoes without changing the settings.",
    "diffusionseed": "Which random arrangement the early diffuser uses.",
    "delayseed": "Which random arrangement the late delay lines use.",
    "latediffusionseed": "Which random arrangement the late diffuser uses."
  });

/** A switch rather than a knob: these are read as on or off either side of a half. */
const toggle = (id, name, group) => ({ id, name, group, min: 0, max: 1, step: 1, default: 0, description: NOTES[id] });
const knob = (id, name, group) => ({ id, name, group, min: 0, max: 1, default: 0.5, description: NOTES[id] });

/** In the enum's order, which is the order SetParameter indexes. */
export const CLOUDSEED_PARAMS = Object.freeze([
  toggle('interpolation', 'Interpolation', IN),
  toggle('lowcuton', 'Low Cut On', IN),
  toggle('highcuton', 'High Cut On', IN),
  knob('inputmix', 'Input Mix', IN),
  knob('lowcut', 'Low Cut', IN),
  knob('highcut', 'High Cut', IN),
  knob('dry', 'Dry', OUT),
  knob('early', 'Early Level', OUT),
  knob('late', 'Late Level', OUT),

  toggle('tapon', 'Tap On', TAP),
  knob('tapcount', 'Tap Count', TAP),
  knob('tapdecay', 'Tap Decay', TAP),
  knob('tappredelay', 'Tap Predelay', TAP),
  knob('taplength', 'Tap Length', TAP),

  toggle('earlydiffuseon', 'Early Diffuse On', EARLY),
  knob('earlystages', 'Early Stages', EARLY),
  knob('earlydelay', 'Early Delay', EARLY),
  knob('earlymodamount', 'Early Mod Amount', EARLY),
  knob('earlyfeedback', 'Early Feedback', EARLY),
  knob('earlymodrate', 'Early Mod Rate', EARLY),

  knob('latemode', 'Late Mode', LATE),
  knob('latelines', 'Late Lines', LATE),
  toggle('latediffuseon', 'Late Diffuse On', LATE),
  knob('latestages', 'Late Stages', LATE),
  knob('latesize', 'Late Size', LATE),
  knob('latelinemodamount', 'Late Line Mod Amount', LATE),
  knob('latedelay', 'Late Delay', LATE),
  knob('latediffusemodamount', 'Late Diffuse Mod Amount', LATE),
  knob('latedecay', 'Late Decay', LATE),
  knob('latelinemodrate', 'Late Line Mod Rate', LATE),
  knob('latefeedback', 'Late Feedback', LATE),
  knob('latediffusemodrate', 'Late Diffuse Mod Rate', LATE),

  toggle('lowshelfon', 'Low Shelf On', EQ),
  toggle('highshelfon', 'High Shelf On', EQ),
  toggle('lowpasson', 'Lowpass On', EQ),
  knob('lowfreq', 'Low Freq', EQ),
  knob('highfreq', 'High Freq', EQ),
  knob('cutoff', 'Cutoff', EQ),
  knob('lowgain', 'Low Gain', EQ),
  knob('highgain', 'High Gain', EQ),
  knob('crossseed', 'Cross Seed', EQ),

  knob('tapseed', 'Tap Seed', SEED),
  knob('diffusionseed', 'Diffusion Seed', SEED),
  knob('delayseed', 'Delay Seed', SEED),
  knob('latediffusionseed', 'Late Diffusion Seed', SEED),
]);

/** The constant each slot is named by upstream, in the same order - used to read the program. */
const ENUM_NAMES = [
  'Interpolation', 'LowCutEnabled', 'HighCutEnabled', 'InputMix', 'LowCut', 'HighCut',
  'DryOut', 'EarlyOut', 'LateOut',
  'TapEnabled', 'TapCount', 'TapDecay', 'TapPredelay', 'TapLength',
  'EarlyDiffuseEnabled', 'EarlyDiffuseCount', 'EarlyDiffuseDelay', 'EarlyDiffuseModAmount',
  'EarlyDiffuseFeedback', 'EarlyDiffuseModRate',
  'LateMode', 'LateLineCount', 'LateDiffuseEnabled', 'LateDiffuseCount', 'LateLineSize',
  'LateLineModAmount', 'LateDiffuseDelay', 'LateDiffuseModAmount', 'LateLineDecay',
  'LateLineModRate', 'LateDiffuseFeedback', 'LateDiffuseModRate',
  'EqLowShelfEnabled', 'EqHighShelfEnabled', 'EqLowpassEnabled', 'EqLowFreq', 'EqHighFreq',
  'EqCutoff', 'EqLowGain', 'EqHighGain', 'EqCrossSeed',
  'SeedTap', 'SeedDiffusion', 'SeedDelay', 'SeedPostDiffusion',
];

/**
 * The factory program, as the defaults.
 *
 * A reverb whose every control rests at zero is not a reverb with a neutral setting - it is one
 * with no delay lines, no diffusion and nothing to hear. Upstream ships one program in its
 * source, and taking the resting position from it is what makes `fx("CloudSeed")` with nothing
 * else written make a sound.
 */
export function programDefaults(programsSource) {
  const values = new Array(ENUM_NAMES.length).fill(0);
  for (const m of programsSource.matchAll(/ProgramDarkPlate\[Parameter::(\w+)\]\s*=\s*([0-9.eE+-]+)\s*;/g)) {
    const at = ENUM_NAMES.indexOf(m[1]);
    if (at >= 0) values[at] = Number(m[2]);
  }
  return values;
}

/** The whole descriptor, with the program's values as the defaults. */
export function cloudSeedDescriptor(programsSource, sourceUrl) {
  const defaults = programDefaults(programsSource);
  return {
    id: 'CloudSeed',
    kind: 'fx',
    version: 1,
    description: 'A very large algorithmic reverb, for spaces that could not exist. Its defaults are upstream\'s own dark plate.',
    vendor: 'Ghost Note Engineering',
    license: 'MIT',
    source: sourceUrl,
    build: 'wasm',
    processor: 'poptart-wasm-cloudseed',
    channels: { in: 2, out: 2 },
    params: CLOUDSEED_PARAMS.map((p, i) => ({ ...p, rate: 'a', default: defaults[i] })),
  };
}
