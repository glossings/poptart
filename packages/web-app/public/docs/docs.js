'use strict';

// The guide's pages: one chapter per file under /docs/, and this script is what they share.
//
// It builds the chapter list and the previous/next links from CHAPTERS (so a page is only its own
// content), writes every {mod+s} / {app+a} chord for the platform reading the page, colors every
// code block with the editor's own mode, draws the pattern timelines, and - in the browser build -
// turns the playable examples into small editors with a play button.
//
// In the browser build every page's <html> carries class "web" (see build-web.mjs), which shows
// the `data-build="web"` passages and hides the desktop's. An example is played by the same engine
// the app runs, booted isolated (boot.mjs) - no store, no prebake - so it sounds the same for
// everyone; one example plays at a time, and "open" hands it to the app as a share link.
//
// Markup, for whoever writes a chapter:
//   <pre><code>…</code></pre>              highlighted, in both builds
//   <pre data-run><code>…</code></pre>     a complete buffer, playable in the browser build
//   data-build="desktop" / "web"            on any element: shown in that build only
//   <figure class="timeline" data-cycles="2">
//     <div class="row">note("c3 e3").add("0 7")</div>
//   </figure>                               each row's expression drawn as the events it makes
//   <figure class="shot"><img …><figcaption>…</figcaption></figure>   a screenshot of the app

const CHAPTERS = [
  { file: 'index', title: 'Welcome', blurb: 'What poptart is, and a first sound.' },
  { file: 'start', title: 'Start here', blurb: 'Tracks, evaluating, muting, the panels, saving and sharing.' },
  { file: 'mini', title: 'Mini-notation', blurb: 'The string language for rhythm and melody.' },
  { file: 'pitch', title: 'Notes & scales', blurb: 'Note names, scale degrees, and one key for the whole song.' },
  { file: 'sound', title: 'Instruments & effects', blurb: 'Loading devices, setting their controls, keeping presets.' },
  { file: 'modulation', title: 'Modulation', blurb: 'LFOs, drawn shapes, envelopes and knobs on any control.' },
  { file: 'samples', title: 'Samples', blurb: 'Packs, chopping, loops, grains, and bouncing a track.' },
  { file: 'pianoroll', title: 'The piano roll', blurb: 'Drawing notes instead of typing them.' },
  { file: 'arrange', title: 'Arranging', blurb: 'Groups, clips, loop regions and automation: loops into a song.' },
  { file: 'mixing', title: 'Mixing & routing', blurb: 'The channel strip, buses, sidechains and the mixer.' },
  { file: 'live', title: 'Playing live', blurb: 'MIDI keyboards, the typing keyboard, recording takes.' },
  { file: 'transforms', title: 'Transforms', blurb: 'Arithmetic, time, randomness, and whose events win.' },
  { file: 'extending', title: 'Making it yours', blurb: 'Your own methods, editing events, prebake, snippets, hotkeys.' },
  { file: 'reference', title: 'Cheat sheet', blurb: 'Everything on one page.' },
];

const href = (file) => (file === 'index' ? '/docs/' : `/docs/${file}.html`);

if (typeof module !== 'undefined' && module.exports) module.exports = { CHAPTERS };

if (typeof document !== 'undefined') (function () {
  const isWeb = document.documentElement.classList.contains('web');
  const here = document.body.dataset.page ?? 'index';
  const at = CHAPTERS.findIndex((c) => c.file === here);

  // ---- chords -----------------------------------------------------------------------------------
  // Every chord is written {mod+s} / {app+a} in the markup and filled in here for this platform,
  // from the same file the app binds them with, so the guide cannot promise a key that isn't bound.
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const hits = [];
  let node;
  while ((node = walk.nextNode())) if (node.nodeValue.includes('{')) hits.push(node);
  for (const n of hits) {
    if (n.parentElement?.closest('pre, figure.timeline')) continue; // code braces are code
    n.nodeValue = expandChords(n.nodeValue);
  }
  paintChordLabels();

  // ---- the chapter list and the pager ----------------------------------------------------------
  const nav = document.createElement('nav');
  nav.className = 'chapters';
  nav.innerHTML = '<a class="brand" href="/docs/"><span class="dot"></span> poptart</a><p class="tagline">the guide</p>';
  CHAPTERS.forEach((c, i) => {
    const a = document.createElement('a');
    a.className = `chapter${i === at ? ' here' : ''}`;
    a.href = href(c.file);
    a.innerHTML = `<span class="num">${i === 0 ? '' : i}</span><span></span>`;
    a.lastChild.textContent = c.title;
    nav.append(a);
    if (i !== at) return;
    const heads = [...document.querySelectorAll('main h2[id]')];
    if (!heads.length) return;
    const toc = document.createElement('ul');
    toc.className = 'toc';
    for (const h of heads) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#${h.id}`;
      link.textContent = h.textContent;
      li.append(link);
      toc.append(li);
    }
    nav.append(toc);
  });
  const back = document.createElement('a');
  back.className = 'back';
  back.href = '/';
  back.textContent = '← back to poptart';
  nav.append(back);
  document.querySelector('.wrap')?.prepend(nav);

  const main = document.querySelector('main');
  if (main && at >= 0) {
    const pager = document.createElement('nav');
    pager.className = 'pager';
    const link = (c, dir, cls) => {
      const a = document.createElement('a');
      a.className = cls;
      a.href = href(c.file);
      a.innerHTML = `<span class="dir">${dir}</span><span></span>`;
      a.lastChild.textContent = c.title;
      return a;
    };
    if (at > 0) pager.append(link(CHAPTERS[at - 1], '← previous', 'prev'));
    if (at < CHAPTERS.length - 1) pager.append(link(CHAPTERS[at + 1], 'next →', 'next'));
    main.append(pager);
  }

  const cards = document.querySelector('.cards');
  if (cards) {
    CHAPTERS.slice(1).forEach((c, i) => {
      const a = document.createElement('a');
      a.href = href(c.file);
      a.innerHTML = `<span class="num">${i + 1}</span><span class="title"></span><span class="blurb"></span>`;
      a.querySelector('.title').textContent = c.title;
      a.querySelector('.blurb').textContent = c.blurb;
      cards.append(a);
    });
  }

  // ---- code ------------------------------------------------------------------------------------
  function highlight(el, text) {
    el.textContent = '';
    CodeMirror.runMode(text, 'poptart', el);
    el.classList.add('cm-s-docs');
  }

  for (const pre of document.querySelectorAll('pre')) {
    if (pre.hasAttribute('data-run') && isWeb) continue;
    const code = pre.querySelector('code') ?? pre;
    highlight(code, code.textContent.replace(/\n$/, ''));
  }

  drawTimelines().catch((err) => console.error('[docs] timelines:', err));
  if (isWeb) setUpExamples();

  // ---- timelines -------------------------------------------------------------------------------
  // Each row's expression is built with the real pattern-core and drawn from the events it makes,
  // so a figure can't disagree with what the pattern plays.

  const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const noteName = (m) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 2}`;

  function label(step, sig) {
    const v = step.value;
    if (typeof v === 'string') return step.cfg?.index ? `${v}:${step.cfg.index}` : v;
    if (typeof v !== 'number') return String(v);
    if (sig.pitchKind === 'note' && Number.isInteger(v)) return noteName(v);
    return String(Math.round(v * 1000) / 1000);
  }

  // Events that overlap go on separate lanes, first-fit.
  function lanes(events) {
    const ends = [];
    for (const e of events) {
      let lane = ends.findIndex((end) => end <= e.start + 1e-9);
      if (lane < 0) { lane = ends.length; ends.push(0); }
      ends[lane] = e.end;
      e.lane = lane;
    }
    return Math.max(1, ends.length);
  }

  async function drawTimelines() {
    const figs = document.querySelectorAll('figure.timeline');
    if (!figs.length) return;
    const core = await import('/pattern-core/index.mjs');
    const names = Object.keys(core).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    const make = new Function(...names, 'expr', 'return eval("(" + expr + ")")');
    const values = names.map((n) => core[n]);
    const SVG = 'http://www.w3.org/2000/svg';
    for (const fig of figs) {
      const cycles = Number(fig.dataset.cycles ?? 1);
      const beats = Number(fig.dataset.beats ?? 4);
      for (const row of fig.querySelectorAll('.row')) {
        const expr = row.textContent.trim();
        row.textContent = '';
        const code = document.createElement('code');
        highlight(code, expr);
        row.append(code);
        let events;
        let sig;
        try {
          sig = make(...values, expr);
          events = [];
          for (let c = 0; c < cycles; c++) {
            for (const s of sig.stepsForCycle(c)) {
              if (s.value == null) continue;
              const start = Math.max(c + s.start, 0);
              const end = Math.min(c + s.end, cycles);
              if (end > start) events.push({ start, end, tie: !!s.cont, text: label(s, sig) });
            }
          }
          events.sort((a, b) => a.start - b.start || a.end - b.end);
        } catch (err) {
          const e = document.createElement('div');
          e.className = 'error';
          e.textContent = String(err?.message ?? err);
          row.append(e);
          continue;
        }
        // Drawn at the width it is shown at, so the labels stay at their own size.
        const W = Math.max(280, Math.round(row.clientWidth || 700));
        const LANE = 24;
        const n = lanes(events);
        const H = n * LANE + 14;
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `${expr}: ${events.map((e) => e.text).join(' ')}`);
        const x = (t) => (t / cycles) * W;
        for (let b = 0; b <= cycles * beats; b++) {
          const line = document.createElementNS(SVG, 'line');
          const isCycle = b % beats === 0;
          line.setAttribute('class', isCycle ? 'cycle-line' : 'beat-line');
          line.setAttribute('x1', x(b / beats));
          line.setAttribute('x2', x(b / beats));
          line.setAttribute('y1', 0);
          line.setAttribute('y2', n * LANE + 2);
          svg.append(line);
          if (isCycle && b < cycles * beats && cycles > 1) {
            const t = document.createElementNS(SVG, 'text');
            t.setAttribute('class', 'cycle-num');
            t.setAttribute('x', x(b / beats) + 3);
            t.setAttribute('y', H - 1);
            t.textContent = `cycle ${b / beats}`;
            svg.append(t);
          }
        }
        for (const e of events) {
          const r = document.createElementNS(SVG, 'rect');
          r.setAttribute('class', `ev${e.tie ? ' tie' : ''}`);
          r.setAttribute('x', x(e.start) + 1.5);
          r.setAttribute('y', e.lane * LANE + 3);
          r.setAttribute('width', Math.max(2, x(e.end) - x(e.start) - 3));
          r.setAttribute('height', LANE - 6);
          r.setAttribute('rx', 4);
          svg.append(r);
          const t = document.createElementNS(SVG, 'text');
          t.setAttribute('class', 'ev-label');
          t.setAttribute('x', x(e.start) + 7);
          t.setAttribute('y', e.lane * LANE + LANE / 2 + 0.5);
          t.textContent = x(e.end) - x(e.start) > 22 ? e.text : '';
          svg.append(t);
        }
        row.append(svg);
      }
    }
  }

  // ---- playing (browser build) -----------------------------------------------------------------

  function setUpExamples() {
    let hostPromise = null;
    let playing = null; // the example on now: { el, button }
    const examples = [];

    function host() {
      if (!hostPromise) {
        hostPromise = import('/web/boot.mjs')
          .then((m) => m.boot({ isolated: true }))
          .catch((err) => {
            hostPromise = null; // a failed start can be tried again from the next click
            throw err;
          });
      }
      return hostPromise;
    }

    function setPlaying(example) {
      if (playing && playing !== example) playing.el.classList.remove('playing');
      playing = example;
      for (const ex of examples) ex.button.textContent = ex === playing ? '■ stop' : '▶ play';
      if (playing) playing.el.classList.add('playing');
    }

    async function stop() {
      if (!playing) return;
      const was = playing;
      setPlaying(null);
      was.el.classList.remove('playing');
      const h = await host();
      await h.call('POST', '/api/stop', {});
    }

    async function play(example) {
      example.status.textContent = '';
      example.button.disabled = true;
      try {
        const h = await host();
        // Created inside the boot, a moment after the click that asked for it; resumed here so it
        // starts on the first press rather than the second.
        await h.context?.resume?.();
        if (playing) await h.call('POST', '/api/stop', {});
        await h.call('POST', '/api/evaluate', { code: example.editor.getValue() });
        setPlaying(example);
      } catch (err) {
        example.status.textContent = String(err?.message ?? err);
        setPlaying(null);
      } finally {
        example.button.disabled = false;
      }
    }

    async function openInApp(example) {
      const { encodeShareHash } = await import('/web/share-link.mjs');
      window.open(`/#${await encodeShareHash(example.editor.getValue())}`, '_blank', 'noopener');
    }

    for (const pre of document.querySelectorAll('pre[data-run]')) {
      const text = (pre.querySelector('code') ?? pre).textContent.replace(/\n$/, '');
      const el = document.createElement('div');
      el.className = 'example';
      const bar = document.createElement('div');
      bar.className = 'example-bar';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '▶ play';
      button.title = `${chordLabel('mod+enter')} to play, ${chordLabel('mod+.')} to stop`;
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'open ↗';
      open.title = 'open this example in poptart';
      const status = document.createElement('span');
      status.className = 'example-status';
      bar.append(button, open, status);
      pre.replaceWith(el);
      const example = { el, button, status, editor: null };
      example.editor = CodeMirror(el, {
        value: text,
        mode: 'poptart',
        theme: 'docs',
        viewportMargin: Infinity,
        extraKeys: {
          'Cmd-Enter': () => play(example),
          'Ctrl-Enter': () => play(example),
          'Cmd-.': () => stop(),
          'Ctrl-.': () => stop(),
        },
      });
      el.append(bar);
      button.addEventListener('click', () => (playing === example ? stop() : play(example)));
      open.addEventListener('click', () => openInApp(example).catch((err) => { status.textContent = String(err?.message ?? err); }));
      examples.push(example);
    }
  }
})();
