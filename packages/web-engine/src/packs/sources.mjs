// Reading the compiled-device source list, and turning it into the credits a running page owes.
//
// AGPL section 13 means a page that serves this has to offer its source, and a catalog built out
// of several upstream projects has to be able to say whose code each device is. Generating that
// from the same file the build reads is the only way it stays true: a hand-written credits page
// is correct on the day it is written and drifts from then on.

/** License identifiers that make the web build permanently copyleft once one is compiled in. */
export const COPYLEFT = Object.freeze(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'AGPL-3.0-only']);

/**
 * Validates the source list. It is data the build acts on, so a malformed entry should fail
 * here rather than produce a device with no recorded license.
 */
export function validateSources(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('[sources] the source list must be an object');
  if (!doc.target) throw new Error('[sources] the source list must say what license the build targets');
  const sources = Array.isArray(doc.sources) ? doc.sources : null;
  if (!sources || sources.length === 0) throw new Error('[sources] there are no sources listed');

  const seen = new Set();
  const checked = sources.map((entry) => {
    const id = String(entry?.id ?? '').trim();
    if (!id) throw new Error('[sources] every source needs an id');
    if (seen.has(id)) throw new Error(`[sources] "${id}" is listed twice`);
    seen.add(id);
    if (!entry.title) throw new Error(`[sources] "${id}" needs a title`);
    if (!entry.repository) throw new Error(`[sources] "${id}" needs a repository, or nobody can check its license`);
    if (!entry.license) throw new Error(`[sources] "${id}" needs a license`);
    if (!['planned', 'built'].includes(entry.status)) {
      throw new Error(`[sources] "${id}" has status ${JSON.stringify(entry.status)}; it must be "planned" or "built"`);
    }
    // The point of the flag: nothing gets compiled in on the strength of what a project is
    // generally understood to use.
    if (entry.status === 'built' && entry.licenseVerified !== true) {
      throw new Error(`[sources] "${id}" is marked built but its license has not been verified`);
    }
    const devices = Array.isArray(entry.devices) ? entry.devices : [];
    if (devices.length === 0) throw new Error(`[sources] "${id}" lists no devices`);
    for (const d of devices) {
      if (!d?.id) throw new Error(`[sources] a device of "${id}" has no id`);
      if (!['synth', 'fx'].includes(d.kind)) throw new Error(`[sources] ${id}/${d.id} must be a synth or an fx`);
    }
    return Object.freeze({ ...entry, devices: Object.freeze(devices.map((d) => Object.freeze({ ...d }))) });
  });

  return Object.freeze({ target: doc.target, sources: Object.freeze(checked) });
}

/** Everything still to be checked before a source can be compiled in. */
export function unverified(doc) {
  return doc.sources.filter((s) => s.licenseVerified !== true).map((s) => ({
    id: s.id,
    license: s.license,
    repository: s.repository,
    note: s.licenseNote ?? null,
  }));
}

/** Sources that would make the build permanently copyleft if compiled in. */
export function copyleftRisk(doc) {
  return doc.sources.filter((s) => s.copyleft === true || s.copyleft === 'some');
}

/** How many devices the catalog would hold once every listed source is built. */
export function plannedDeviceCount(doc) {
  return doc.sources.reduce((n, s) => n + s.devices.length, 0);
}

/**
 * The credits file. Devices poptart wrote are listed from the registry; ported ones from the
 * source list, with the ones not yet built marked as such so the page never claims to contain
 * code it does not.
 */
export function creditsMarkdown({ devices = [], sources = null, packs = [] } = {}) {
  const lines = ['# What this build is made of', ''];

  lines.push('## Devices', '');
  for (const row of devices) {
    const who = row.vendor === 'poptart' ? 'poptart' : row.vendor;
    lines.push(`- **${row.id}** v${row.version} - ${row.license}, ${who}${row.source ? ` (${row.source})` : ''}`);
  }

  if (sources) {
    const built = sources.sources.filter((s) => s.status === 'built');
    const planned = sources.sources.filter((s) => s.status !== 'built');
    if (built.length) {
      lines.push('', '## Ported DSP', '');
      for (const s of built) lines.push(`- **${s.title}** - ${s.license}, ${s.repository}`);
    }
    if (planned.length) {
      lines.push('', '## Not in this build', '');
      lines.push('Listed so the plan is public, but no code from these is compiled in yet.', '');
      for (const s of planned) lines.push(`- ${s.title} (${s.license})`);
    }
  }

  if (packs.length) {
    lines.push('', '## Sample packs', '');
    for (const pack of packs) {
      lines.push(`- **${pack.title}** (\`${pack.id}\`) - ${pack.licenses.join(', ')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
