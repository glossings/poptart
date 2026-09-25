// The prebake and the ★ library, run in the page.
//
// On the desktop both are files - ~/.poptart/prebake.js, somebody's own setup, and
// prebake/pinned.js, the definitions starred from the editor - and the server runs them into one
// set of definitions every buffer evaluation starts from (server.js, runPrebake). Here both live in
// the browser's store under the same names, and this is that runner for the page, with the same
// rules:
//
//   - the pinned file runs, then the user's prebake, block by block, each error said and none of
//     them stopping the rest - a broken prebake never keeps the page from starting;
//   - roll-style definitions go to the 'prebake' layer, which a buffer evaluation leaves standing
//     and a re-run replaces wholesale;
//   - the definitions are written into the SAME Map the evaluator was built with, so the next
//     evaluation starts from them without the evaluator being rebuilt.
//
// The pinned file's format - one definition per line, found and replaced by name - belongs to the
// desktop's pinned-defs.js, which is handed in rather than copied.

export function createPrebake({ patternCore, storage, prebakeDefs, createBlockEvaluator, pinnedDefs, log = () => {}, dehydrate = async (code) => ({ code }), afterClear = () => {} }) {
  /** Runs everything again. Answers the per-block errors, empty on success. */
  async function run() {
    const sources = [];
    const pinned = (await storage.readPinned()) ?? '';
    if (pinned.trim()) sources.push({ name: 'pinned.js', code: pinned });
    const own = (await storage.readPrebake()) ?? '';
    if (own.trim()) sources.push({ name: 'prebake.js', code: own });

    const errors = [];
    const evalBlock = createBlockEvaluator(patternCore, { defs: new Map() });
    patternCore.setRollLayer('prebake');
    patternCore.clearRolls('prebake');
    // What the host keeps in this layer and is not the prebake's to drop: the sample packs.
    afterClear();
    patternCore.setRollLayer('prebake');
    try {
      for (const src of sources) {
        for (const b of patternCore.splitLabeledBlocks(src.code)) {
          try {
            evalBlock(b.code);
          } catch (err) {
            const where = b.label && !b.label.startsWith('$') ? ` (${b.label})` : '';
            errors.push(`${src.name}${where}: ${err?.message ?? err}`);
          }
        }
      }
    } finally {
      patternCore.setRollLayer('buffer');
    }
    prebakeDefs.clear();
    for (const [k, v] of evalBlock.defs) prebakeDefs.set(k, v);
    if (sources.length) log(`prebake ran ${sources.length} file(s)${prebakeDefs.size ? `; defs: ${[...prebakeDefs.keys()].join(', ')}` : ''}`);
    for (const e of errors) log(`prebake ${e}`);
    return errors;
  }

  async function pinnedList() {
    return pinnedDefs.parsePinned((await storage.readPinned()) ?? '').map(({ kind, id, scope, code }) => ({ kind, id, scope, code }));
  }

  /** Stars a definition: files it under its name, replacing an older copy, and runs again. */
  async function pin({ kind, id, scope = '', code }) {
    const { code: stored } = await dehydrate(String(code ?? ''));
    await storage.writePinned(pinnedDefs.upsertPinned((await storage.readPinned()) ?? '', { kind: String(kind), id: String(id), scope: String(scope ?? ''), code: stored }));
    return { errors: await run(), pinned: await pinnedList() };
  }

  /** Unstars one, answering the code it held so the editor can keep a copy. */
  async function unpin({ kind, id, scope = '' }) {
    const list = await pinnedList();
    const had = list.find((e) => e.kind === kind && e.id === id && (kind !== 'preset' || e.scope === scope)) ?? null;
    if (had) await storage.writePinned(pinnedDefs.removePinned((await storage.readPinned()) ?? '', { kind, id, scope }));
    return { errors: had ? await run() : [], pinned: await pinnedList(), code: had?.code ?? null };
  }

  /**
   * The definitions a snippet or a copy needs, looked for in the pinned file and the prebake, and
   * rebuilt from the live registry where a name has no source line to copy - the desktop's order.
   */
  async function resolveDefs(want = []) {
    const sources = [(await storage.readPinned()) ?? '', (await storage.readPrebake()) ?? ''];
    const found = sources.flatMap((code) => pinnedDefs.parsePinned(code));
    return want.map((w) => {
      const kind = String(w?.kind ?? '');
      const id = String(w?.id ?? '');
      const scope = String(w?.scope ?? '');
      const hit = found.find((e) => e.kind === kind && e.id === id && (kind !== 'preset' || !e.scope || !scope || e.scope === scope));
      if (hit) return { kind, id, scope: hit.scope, code: hit.code };
      return rebuild(kind, id, scope) ?? { kind, id, scope, code: null, why: `no ${kind} definition named "${id}" to copy` };
    });
  }

  /** A definition written back out of the registry, for the kinds whose entry says everything. */
  function rebuild(kind, id, scope) {
    const line = (call, ...args) => ({ kind, id, scope, code: `${call}(${args.map((a) => JSON.stringify(a)).join(', ')})` });
    if (kind === 'shape') {
      const points = patternCore.lookupShape(id);
      return points ? line('_shape', id, patternCore.serializeShapePoints(points)) : null;
    }
    if (kind === 'preset') {
      const entry = patternCore.lookupPreset(id, scope || null);
      return entry ? { ...line('_preset', id, entry.plugin ?? '', entry.state ?? ''), scope: entry.plugin ?? '' } : null;
    }
    if (kind === 'pack') {
      const entry = patternCore.lookupPack(id);
      return entry ? { kind, id, scope, code: `_pack(${JSON.stringify(id)}, ${JSON.stringify((entry.files ?? []).map(String))})` } : null;
    }
    if (kind === 'automation') {
      const points = patternCore.lookupAuto(id);
      return points ? line('_auto', id, patternCore.serializeAutoPoints(points)) : null;
    }
    return null;
  }

  return { run, pin, unpin, pinnedList, resolveDefs };
}
