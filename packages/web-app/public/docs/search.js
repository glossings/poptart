'use strict';

// The guide's search: every chapter's headings and text, and the names its prose and tables
// mention, searched from the box at the top of the chapter list (docs.js draws it).
//
// The index is made in the page from the chapters themselves - each page fetched once, the first
// time the box is used - so there is nothing to build and nothing to keep in step: both builds serve
// the same pages, offline, and a chapter edited is a chapter searched. The pages are read as text
// rather than through the DOM, so the same code runs in the tests.
//
// A section is what sits under one <h2 id>: the chapter's opening, before its first heading, is a
// section of its own named after the chapter. Code examples (<pre>) are left out of the text, and
// the passages written for the other build are left out altogether.

(function (root) {
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', middot: '·', rarr: '→', larr: '←', hellip: '…', mdash: '—', ndash: '–' };
  const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*|#39);/gi, (m, e) => {
    if (e[0] === '#' && e !== '#39') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  const textOf = (html) => squash(decode(html.replace(/<[^>]+>/g, ' ')));

  /** `html` with every element marked `data-build="<build>"` taken out, whatever it holds. */
  function dropBuild(html, build) {
    const open = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bdata-build="${build}"[^>]*>`, 'gi');
    let out = html;
    let m;
    while ((m = open.exec(out))) {
      const tag = m[1].toLowerCase();
      const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
      re.lastIndex = m.index + m[0].length;
      let depth = 1;
      let end = out.length;
      let t;
      while ((t = re.exec(out))) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) {
          end = t.index + t[0].length;
          break;
        }
      }
      out = out.slice(0, m.index) + out.slice(end);
      open.lastIndex = m.index;
    }
    return out;
  }

  /** The names a stretch of HTML mentions in its inline <code>: `steps`, `scope`, `color`, ... */
  function namesIn(html) {
    const names = new Set();
    for (const m of html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) {
      for (const n of decode(m[1].replace(/<[^>]+>/g, '')).matchAll(/[A-Za-z_$][\w$]*/g)) names.add(n[0].toLowerCase());
    }
    return [...names];
  }

  /**
   * One page's sections: `{ file, chapter, section, anchor, text, names }` in page order. `chapter`
   * is the chapter's title; `anchor` the heading's id ('' for the opening).
   */
  function sectionsOf(html, { file, chapter, web = false }) {
    let body = String(html);
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body);
    body = main ? main[1] : body;
    body = dropBuild(body, web ? 'desktop' : 'web');
    body = body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    const heads = [...body.matchAll(/<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi)];
    const parts = [];
    let from = 0;
    let head = null;
    for (const h of heads) {
      parts.push({ head, html: body.slice(from, h.index) });
      head = { id: h[1], title: textOf(h[2]) };
      from = h.index + h[0].length;
    }
    parts.push({ head, html: body.slice(from) });
    const out = [];
    for (const p of parts) {
      // The chapter's own heading (its kicker and title) says nothing a search is for.
      const content = p.html.replace(/<header\b[\s\S]*?<\/header>/gi, ' ');
      const prose = content.replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ');
      const text = textOf(prose);
      if (!p.head && !text) continue;
      out.push({
        file,
        chapter,
        section: p.head ? p.head.title : chapter,
        anchor: p.head ? p.head.id : '',
        text,
        names: namesIn(prose),
      });
    }
    return out;
  }

  const words = (q) => squash(String(q ?? '').toLowerCase()).split(' ').filter(Boolean);
  const startsWord = (hay, w) => hay.startsWith(w) || hay.includes(` ${w}`) || hay.includes(`.${w}`) || hay.includes(`(${w}`);

  /**
   * The sections that hold every word of `query`, best first, each with `score` and a `snippet`:
   * `{ before, match, after }` around the first place the text says the first word. A name the
   * section mentions counts most, then a word in its heading, then its chapter's title, then its text.
   */
  function search(sections, query, limit = 20) {
    const ws = words(query);
    if (!ws.length) return [];
    const phrase = ws.join(' ');
    const hits = [];
    sections.forEach((s, order) => {
      const title = s.section.toLowerCase();
      const chapter = s.chapter.toLowerCase();
      const text = s.text.toLowerCase();
      let score = 0;
      for (const w of ws) {
        let best = 0;
        if (s.names.includes(w)) best = Math.max(best, 8);
        else if (s.names.some((n) => n.startsWith(w))) best = Math.max(best, 5);
        if (startsWord(title, w)) best = Math.max(best, 6);
        else if (title.includes(w)) best = Math.max(best, 4);
        if (startsWord(chapter, w)) best = Math.max(best, 3);
        if (startsWord(text, w)) best = Math.max(best, 2);
        else if (text.includes(w)) best = Math.max(best, 1);
        if (!best) return;
        score += best;
      }
      if (ws.length > 1 && (text.includes(phrase) || title.includes(phrase))) score += 3;
      hits.push({ ...s, score, order, snippet: snippetOf(s.text, ws[0]) });
    });
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    return hits.slice(0, limit);
  }

  /** A short stretch of `text` around where it first says `word`, cut at word boundaries. */
  function snippetOf(text, word, before = 40, after = 90) {
    const at = text.toLowerCase().indexOf(word);
    if (at < 0) return { before: '', match: '', after: text.slice(0, before + after).replace(/\s+\S*$/, '') + (text.length > before + after ? '…' : '') };
    let a = Math.max(0, at - before);
    if (a > 0) a = text.indexOf(' ', a) + 1 || a;
    let b = Math.min(text.length, at + word.length + after);
    if (text.length - b < 12) b = text.length; // a few words short of the end: show them
    else b = text.lastIndexOf(' ', b) > at + word.length ? text.lastIndexOf(' ', b) : b;
    return {
      before: (a > 0 ? '…' : '') + text.slice(a, at),
      match: text.slice(at, at + word.length),
      after: text.slice(at + word.length, b) + (b < text.length ? '…' : ''),
    };
  }

  /**
   * Every chapter's sections: `chapters` as docs.js lists them, `fetchPage(file)` the page's HTML
   * (a promise), `web` which build is reading. A page that can't be read is left out.
   */
  async function buildIndex(chapters, fetchPage, { web = false } = {}) {
    const pages = await Promise.all(chapters.map((c) => Promise.resolve().then(() => fetchPage(c.file)).catch(() => null)));
    return pages.flatMap((html, i) => (html ? sectionsOf(html, { file: chapters[i].file, chapter: chapters[i].title, web }) : []));
  }

  const api = { sectionsOf, search, snippetOf, buildIndex, dropBuild };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.poptartGuideSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
