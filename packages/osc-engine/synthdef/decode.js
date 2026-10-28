'use strict';

// Reads an SCgf (version 2) file back into plain objects - for tests and for comparing two
// encodings of the same def by structure.

function decodeScgf(buf) {
  let p = 0;
  const i8 = () => buf.readInt8(p++);
  const u8 = () => buf.readUInt8(p++);
  const i16 = () => { const v = buf.readInt16BE(p); p += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(p); p += 4; return v; };
  const f32 = () => { const v = buf.readFloatBE(p); p += 4; return v; };
  const pstr = () => { const n = u8(); const s = buf.toString('latin1', p, p + n); p += n; return s; };
  const magic = buf.toString('latin1', 0, 4);
  p = 4;
  if (magic !== 'SCgf') throw new Error('not an SCgf file');
  const version = i32();
  if (version !== 2) throw new Error(`SCgf version ${version}, expected 2`);
  const count = i16();
  const defs = [];
  for (let d = 0; d < count; d++) {
    const name = pstr();
    const constants = Array.from({ length: i32() }, f32);
    const params = Array.from({ length: i32() }, f32);
    const paramNames = Array.from({ length: i32() }, () => ({ name: pstr(), index: i32() }));
    const ugens = Array.from({ length: i32() }, () => {
      const u = { name: pstr(), rate: i8() };
      const nIn = i32();
      const nOut = i32();
      u.special = i16();
      u.inputs = Array.from({ length: nIn }, () => {
        const src = i32();
        const idx = i32();
        return src === -1 ? { c: constants[idx] } : { u: src, o: idx };
      });
      u.outputs = Array.from({ length: nOut }, i8);
      return u;
    });
    const variants = Array.from({ length: i16() }, () => ({ name: pstr(), values: params.map(f32) }));
    defs.push({ name, constants, params, paramNames, ugens, variants });
  }
  if (p !== buf.length) throw new Error(`${buf.length - p} trailing bytes`);
  return defs;
}

/** One line per UGen, constants inline - a readable form for diffs. */
function dumpDef(def) {
  const lines = [`${def.name} params=[${def.params.join(',')}] names=${def.paramNames.map((n) => `${n.name}@${n.index}`).join(',')}`];
  def.ugens.forEach((u, i) => {
    const ins = u.inputs.map((x) => ('c' in x ? String(x.c) : `${x.u}:${x.o}`)).join(' ');
    lines.push(`${i} ${u.name} r${u.rate} s${u.special} [${ins}] -> ${u.outputs.join('')}`);
  });
  return lines.join('\n');
}

module.exports = { decodeScgf, dumpDef };
