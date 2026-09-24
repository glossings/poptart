// Just enough SFZ to read a sample library's own account of itself.
//
// The libraries poptart draws its sourced packs from ship an SFZ file per instrument, and that
// file is the only trustworthy statement of what each recording actually IS: which pitch it was
// played at, which velocity layer it belongs to, where it loops. The filenames LOOK like they
// carry the same information and they do not - one library writes `_vl2` where another writes
// `_v2`, take numbers sit where round-robin numbers sit elsewhere, notes appear mid-string, and
// at least one instrument is deliberately transposed an octave in its SFZ so that the note in
// the filename is not the note the file plays. Parsing filenames would give a pack that is
// quietly a fifth out in places, which is the kind of wrong that sounds like bad playing.
//
// This is NOT an SFZ player and must not become one. It reads the handful of opcodes needed to
// choose one file per instrument and say what pitch it is, and ignores everything else. Anything
// it does not understand is data it passes through, not an error: an unknown opcode is somebody
// else's feature, not a failure of ours.

/** The opcodes that mean something here. Everything else is carried but unread. */
export const KNOWN_OPCODES = Object.freeze([
  'sample', 'pitch_keycenter', 'key', 'lokey', 'hikey', 'lovel', 'hivel',
  'tune', 'volume', 'loop_start', 'loop_end', 'loop_mode', 'offset', 'end',
  'seq_length', 'seq_position', 'default_path',
]);

/** Headers that stack: a region inherits from its group, which inherits from global. */
const LEVELS = ['global', 'master', 'group', 'region'];

/**
 * Note names to MIDI numbers, as SFZ writes them: `c4`, `C#3`, `Db-1`.
 *
 * SFZ's own convention is c4 = 60, and a key opcode may be a bare number instead. Both spellings
 * appear in the wild inside the same library, so both are read here and everything downstream
 * deals in numbers only.
 */
const NOTE_STEPS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function noteNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    return n >= 0 && n <= 127 ? n : null;
  }
  const m = /^([a-gA-G])([#b]?)(-?\d+)$/.exec(text);
  if (!m) return null;
  const step = NOTE_STEPS[m[1].toLowerCase()];
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  // SFZ counts c4 as 60, so the octave is offset by one against the usual (c-1 = 0) reading.
  const n = (Number(m[3]) + 1) * 12 + step + accidental;
  return n >= 0 && n <= 127 ? n : null;
}

/** Strips SFZ comments without touching a `//` that is inside a filename. */
export function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

/**
 * Splits one header's body into opcodes.
 *
 * A value may contain spaces - sample paths in these libraries routinely do, commas and all -
 * so the split is on whitespace that is FOLLOWED by another opcode name rather than on
 * whitespace itself. Getting this wrong truncates every path with a space in it, which in one
 * of these libraries is most of them.
 */
export function readOpcodes(body) {
  const out = {};
  const text = body.trim();
  if (!text) return out;
  for (const part of text.split(/\s+(?=[A-Za-z0-9_]+=)/)) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/**
 * Parses an SFZ into its regions, each carrying the opcodes it inherits.
 *
 * Returns `{ control, regions }`. `control` holds the file-level opcodes (`default_path`, which
 * prefixes every sample path in the file); `regions` is one merged opcode map per `<region>`.
 */
export function parseSfz(source) {
  const text = stripComments(source);
  const headers = [...text.matchAll(/<([a-zA-Z_]+)>/g)];
  const control = {};
  const inherited = { global: {}, master: {}, group: {} };
  const regions = [];

  for (let i = 0; i < headers.length; i++) {
    const name = headers[i][1].toLowerCase();
    const from = headers[i].index + headers[i][0].length;
    const to = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const opcodes = readOpcodes(text.slice(from, to));

    if (name === 'control') {
      Object.assign(control, opcodes);
      continue;
    }
    if (name === 'region') {
      regions.push({ ...inherited.global, ...inherited.master, ...inherited.group, ...opcodes });
      continue;
    }
    if (!LEVELS.includes(name)) continue;     // curve, effect, midi - not ours to read
    // A new header at one level clears the levels below it, which is what makes a second
    // <group> stop inheriting the first one's opcodes.
    inherited[name] = opcodes;
    const below = LEVELS.indexOf(name) + 1;
    for (let k = below; k < LEVELS.length - 1; k++) inherited[LEVELS[k]] = {};
  }
  return { control, regions };
}

/** The sample path a region names, with the file's default_path in front of it. */
export function samplePath(region, control = {}) {
  const raw = region.sample;
  if (!raw) return null;
  const prefix = control.default_path ?? '';
  return `${prefix}${raw}`.replace(/\\/g, '/');
}

/**
 * The pitch a region plays at.
 *
 * `pitch_keycenter` is the honest answer when it is there. Failing that a region that covers one
 * key names it with `key`, and failing that a single-key range says the same thing. A region
 * spanning several keys with no keycenter has no one pitch and is refused rather than guessed
 * at - a guess here is an instrument that is out of tune in patches.
 */
export function regionRoot(region) {
  const explicit = noteNumber(region.pitch_keycenter ?? region.key);
  if (explicit !== null) return explicit;
  const lo = noteNumber(region.lokey);
  const hi = noteNumber(region.hikey);
  if (lo !== null && lo === hi) return lo;
  return null;
}

/**
 * Picks the one recording that best stands for an instrument.
 *
 * Nearest to the wanted pitch first, because repitching a sample a long way is what makes a
 * sampled instrument sound like a sampled instrument. Then the velocity layer that covers an
 * ordinary playing strength - the softest layer of a piano is a different instrument from the
 * hardest, and the middle is what somebody expects to hear. Then the first round robin, so the
 * choice is stable between builds and a rebuilt pack does not change what a saved song plays.
 */
export function chooseRegion(regions, { note = 60, velocity = 100 } = {}) {
  const usable = regions
    .map((r) => ({ region: r, root: regionRoot(r) }))
    .filter((r) => r.root !== null && r.region.sample)
    // A region with a trigger is conditional: `release` is the sound a key makes on the way UP,
    // `legato` and `first` fire only in sequence. None of them is the note, and a piano whose
    // one recording is its key-release tail is a thud where an instrument should be. An absent
    // trigger means `attack`, which is the ordinary case and the one wanted here.
    .filter((r) => {
      const trigger = String(r.region.trigger ?? 'attack').toLowerCase();
      return trigger === 'attack';
    });
  if (usable.length === 0) return null;

  const score = ({ region, root }) => {
    const lovel = Number(region.lovel ?? 0);
    const hivel = Number(region.hivel ?? 127);
    const coversVelocity = velocity >= lovel && velocity <= hivel ? 0 : 1;
    const seq = Number(region.seq_position ?? 1);
    return [Math.abs(root - note), coversVelocity, seq, String(region.sample)];
  };

  return usable.slice().sort((a, b) => {
    const [aDist, aVel, aSeq, aName] = score(a);
    const [bDist, bVel, bSeq, bName] = score(b);
    if (aDist !== bDist) return aDist - bDist;
    if (aVel !== bVel) return aVel - bVel;
    if (aSeq !== bSeq) return aSeq - bSeq;
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  })[0];
}
