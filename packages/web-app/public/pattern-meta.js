'use strict';

// Pattern metadata - Strudel-style `@key value` tags a pattern carries in its own comments:
//
//   // @title kick drift
//   // @by aria  @tags techno, generative
//
// They can sit anywhere in the buffer, not just in a header block - the whole file is scanned.
// Only text inside `//` and `/* */` comments counts, so an `@` in a string (a sample name, a
// url) is never mistaken for a tag. The file itself is the only source of truth: copy a pattern
// somewhere else and its metadata rides along.
//
// Used by the server to label and search the files tab, and by the editor to title the browser
// tab - which is what makes a URL findable again in browser history.
//
// Loaded as a plain script in the browser (before client.js) and require()d by server.js and
// pattern-meta.test.js, so both sides parse identically - same arrangement as public/api-docs.js.

// Aliases, so the obvious spelling works without anyone having to look it up.
const META_KEYS = {
  title: 'title',
  name: 'title',
  by: 'by',
  author: 'by',
  tags: 'tags',
  tag: 'tags',
};

// A `@key` only starts a tag at the start of a comment or after whitespace / a block comment's
// leading `*`. That's what keeps `ariamine94@gmail.com` from parsing as a `@gmail` tag.
const TAG_RE = /(^|[\s*])@([A-Za-z][A-Za-z0-9_-]*)[ \t]*/g;

// One left-to-right pass over the source, tracking quotes so a `//` inside a string isn't a
// comment. Returns the comment bodies (tags live in these) and the source with every comment
// blanked out (labels are looked for in that, so a commented-out block isn't mistaken for one).
// Regex literals aren't tracked - patterns don't use them, and the worst case is one stray
// comment body.
function scanComments(code) {
  const src = String(code ?? '');
  const comments = [];
  let stripped = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const start = i++;
      while (i < src.length) {
        if (src[i] === '\\') i += 2;
        else if (src[i] === c) { i++; break; }
        else i++;
      }
      stripped += src.slice(start, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      comments.push(src.slice(i + 2, end));
      i = end; // leave the newline, so line structure survives in `stripped`
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      const body = src.slice(i + 2, close === -1 ? src.length : close);
      comments.push(body);
      stripped += body.replace(/[^\n]/g, ' '); // keep newlines so line-anchored matching holds
      i = end;
      continue;
    }
    stripped += c;
    i++;
  }
  return { comments, stripped };
}

function splitTags(value) {
  return String(value)
    .split(/[,\s]+/)
    .map((t) => t.replace(/^#/, '').toLowerCase())
    .filter(Boolean);
}

// { title, by, tags, extra } - `extra` holds any other `@key` the user invented, first one wins.
// Repeated `@tags` accumulate (deduped); a repeated `@title` doesn't overwrite the first.
function parseMeta(code) {
  const meta = { title: '', by: '', tags: [], extra: {} };
  for (const body of scanComments(code).comments) {
    const hits = [];
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(body))) {
      hits.push({ key: m[2].toLowerCase(), at: m.index + m[1].length, valueStart: TAG_RE.lastIndex });
    }
    for (let h = 0; h < hits.length; h++) {
      const { key, valueStart } = hits[h];
      // The value runs to the next `@key` or the end of the line, whichever comes first - so
      // `@by aria @tags techno` reads as two tags, and a value never swallows the next line.
      const newline = body.indexOf('\n', valueStart);
      let end = newline === -1 ? body.length : newline;
      const next = hits[h + 1];
      if (next && next.at < end) end = next.at;
      const value = body.slice(valueStart, end).replace(/[\s*]+$/, '');
      if (!value) continue;
      const known = META_KEYS[key];
      if (known === 'tags') {
        for (const t of splitTags(value)) if (!meta.tags.includes(t)) meta.tags.push(t);
      } else if (known) {
        if (!meta[known]) meta[known] = value;
      } else if (!(key in meta.extra)) {
        meta.extra[key] = value;
      }
    }
  }
  return meta;
}

// The first labelled block's name (`bass: note(…)` -> "bass") - a last resort for a
// work-in-progress session that has neither an `@title` nor a name of its own. Mute/solo
// prefixes are part of the spelling, not the name, so `_bass:` and `Sbass:` both read as "bass";
// `$:` setup blocks aren't names at all, so they're skipped. Display only - it never has to be
// exactly right.
function deriveLabel(code) {
  const re = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*:/gm;
  const { stripped } = scanComments(code);
  let m;
  while ((m = re.exec(stripped))) {
    const name = m[1].replace(/^[_S](?=[A-Za-z_$])/, '');
    if (name && name !== '$') return name;
  }
  return '';
}

// How a pattern should read in the files list, in order of what it's most likely to be called:
//
//   title     its own `@title`
//   name      the name the user gave it - a saved pattern's file name, which always beats
//             guessing at one from the code
//   code      a block label borrowed out of the code, only with `borrowBlockLabel` - for a
//             work-in-progress session, which has no name until it's kept
//   fallback  something is better than nothing (a session's time of day)
function displayLabel({ title, name, code, fallback, borrowBlockLabel = false }) {
  return (title || '').trim()
    || (name || '').trim()
    || (borrowBlockLabel ? deriveLabel(code || '') : '')
    || (fallback || '').trim()
    || 'untitled';
}

// Does `entry` ({ name, title, by, tags, code }) match a search box's worth of text? Terms are
// AND-ed; a bare term matches anywhere (name, title, author, tags, or the code itself), and
// `tag:` / `by:` restrict it to that field. An incomplete `tag:` matches everything rather than
// blanking the list mid-keystroke.
function matchesQuery(entry, query) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const tags = (entry.tags || []).map((t) => String(t).toLowerCase());
  const by = String(entry.by || '').toLowerCase();
  const haystack = [entry.name, entry.title, by, tags.join(' '), entry.code]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return terms.every((term) => {
    if (term.startsWith('tag:')) {
      const want = term.slice(4);
      return !want || tags.some((t) => t.includes(want));
    }
    if (term.startsWith('by:')) {
      const want = term.slice(3);
      return !want || by.includes(want);
    }
    return haystack.includes(term);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMeta, deriveLabel, displayLabel, matchesQuery, scanComments };
}
