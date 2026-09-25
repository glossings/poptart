'use strict';

// The guide's pages: one chapter per file under /docs/, and this script is what they share.
//
// It builds the chapter list and the previous/next links from CHAPTERS (so a page is only its own
// content), writes every {mod+s} / {app+a} chord for the platform reading the page, colors every
// code block with the editor's own mode, draws the pattern timelines, and - in the browser build -
// turns the playable examples into small editors with a play button.
//
// In the browser build every page's <html> carries class "web" (see build-web.mjs), which shows
// the `data-build="web"` passages and hides the desktop's, and a playable example becomes the app
// itself when it is used (see setUpExamples); "open" hands it to the app in a tab as a share link.
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
  // The page carries an empty <nav class="chapters"> so its column is there from the first paint;
  // filled here, nothing moves.
  let nav = document.querySelector('nav.chapters');
  if (!nav) {
    nav = document.createElement('nav');
    nav.className = 'chapters';
    document.querySelector('.wrap')?.prepend(nav);
  }
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
  // A track label inside a group's braces - an indented `name:` followed by code rather than by a
  // value, so `kick: s("bd")` counts and an option like `grid: 16` does not. JavaScript calls it a
  // property; the editor paints it as the label it is (client.js's markMemberLabels), and so does
  // this.
  const MEMBER_LABEL_RE = /^([ \t]+)([A-Za-z_$][\w$]*)(?=\s*:\s*[A-Za-z_$])/;

  function highlight(el, text) {
    el.textContent = '';
    const labels = text.split('\n').map((line) => {
      const m = MEMBER_LABEL_RE.exec(line);
      return m ? [m[1].length, m[1].length + m[2].length] : null;
    });
    CodeMirror.runMode(text, 'poptart', (tok, style, line, start) => {
      if (tok === '\n') {
        el.append('\n');
        return;
      }
      const label = labels[line];
      const cls = label && start >= label[0] && start < label[1] ? 'cm-variable cm-member-label' : style && `cm-${style.replace(/ +/g, ' cm-')}`;
      if (!cls) {
        el.append(tok);
        return;
      }
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = tok;
      el.append(span);
    });
    el.classList.add('cm-s-docs');
  }

  for (const pre of document.querySelectorAll('pre')) {
    if (pre.hasAttribute('data-run') && isWeb) continue; // setUpExamples highlights these
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
    // A playable example is its highlighted code with a ▶ play and an open ↗ under it, until it is
    // used: then the code gives way to the app itself, embedded (`/?embed`, see client.js's embed
    // section) and loaded with it - the editor's own highlighting, playback boxes, completion,
    // ctrl-hover, and the widgets a double-click opens (a piano roll, a device, a shape). The frame
    // boots isolated, so an example never touches the reader's own patterns or prebake. One example
    // is live at a time: using another hands the page back to code where the last one was.
    const examples = [];
    let live = null; // the example whose frame is up

    // The frame loads out of sight behind the code, at the code's size, and takes its place only
    // once the editor in it is ready - so the page never shows a blank or half-built frame, and
    // with the two laid out alike nothing moves when they swap.
    function frameFor(example) {
      return new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.className = 'example-frame loading';
        frame.title = 'playable example';
        frame.allow = 'autoplay; midi; microphone';
        frame.style.height = `${example.pre.offsetHeight}px`;
        example.status.textContent = 'starting…';
        example.onReady = () => {
          example.pre.hidden = true;
          frame.classList.remove('loading');
          if (example.status.textContent === 'starting…') example.status.textContent = '';
          resolve(frame);
        };
        import('/web/share-link.mjs')
          .then(({ encodeShareHash }) => encodeShareHash(example.code))
          .then((hash) => { frame.src = `/?embed#${hash}`; });
        example.pre.after(frame);
        example.frame = frame;
      });
    }

    function retire(example) {
      if (!example?.frame) return;
      const code = currentCode(example);
      example.post({ type: 'poptart-embed-stop' });
      example.code = code;
      highlight(example.codeEl, code);
      example.frame.remove();
      example.pre.hidden = false;
      example.frame = null;
      example.ready = null;
      setPlaying(example, false);
    }

    function currentCode(example) {
      try {
        return example.frame?.contentWindow?.poptartEmbedCode?.() ?? example.code;
      } catch {
        return example.code;
      }
    }

    // Brings the example's frame up (once), then sends it `message`.
    async function use(example, message) {
      if (live && live !== example) retire(live);
      live = example;
      example.ready ??= frameFor(example);
      await example.ready;
      if (message) example.post(message);
    }

    function setPlaying(example, on) {
      example.playing = on;
      example.button.textContent = on ? '■ stop' : '▶ play';
      example.el.classList.toggle('playing', on);
    }

    // Everything a frame says comes here; each is matched to its example by its window.
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
      const example = examples.find((ex) => ex.frame && ex.frame.contentWindow === e.source);
      if (!example) return;
      const { type } = e.data;
      if (type === 'poptart-embed-ready') example.onReady?.();
      else if (type === 'poptart-embed-height') {
        // With a panel open the frame is a window's worth tall, so the panel lays out as it would
        // in the app; closed, it is exactly the code's height (see client.js's embed section).
        const tall = e.data.panel ? Math.round(window.innerHeight * 0.9) : 0;
        example.frame.style.height = `${Math.max(48, e.data.height, tall)}px`;
        if (e.data.panel) example.frame.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      else if (type === 'poptart-embed-playing') setPlaying(example, !!e.data.playing);
      else if (type === 'poptart-embed-error') example.status.textContent = e.data.text;
    });

    // Where in the code text a click on the highlighted copy landed.
    function offsetAt(example, e) {
      const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (!range || !example.codeEl.contains(range.startContainer)) return 0;
      const before = document.createRange();
      before.setStart(example.codeEl, 0);
      before.setEnd(range.startContainer, range.startOffset);
      return before.toString().length;
    }

    for (const pre of document.querySelectorAll('pre[data-run]')) {
      const codeEl = pre.querySelector('code') ?? pre;
      const code = codeEl.textContent.replace(/\n$/, '');
      highlight(codeEl, code);
      const el = document.createElement('div');
      el.className = 'example';
      pre.replaceWith(el);
      const bar = document.createElement('div');
      bar.className = 'example-bar';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '▶ play';
      button.title = `${chordLabel('mod+enter')} in the code plays it, ${chordLabel('mod+.')} stops`;
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'open ↗';
      open.title = 'open this example in poptart';
      const status = document.createElement('span');
      status.className = 'example-status';
      bar.append(button, open, status);
      el.append(pre, bar);
      pre.title = 'click to edit, double-click a name to open its editor';

      const example = {
        el, pre, codeEl, code, button, status, frame: null, ready: null, playing: false, onReady: null,
        post: (message) => example.frame?.contentWindow?.postMessage(message, location.origin),
      };
      examples.push(example);

      button.addEventListener('click', () => {
        example.status.textContent = '';
        if (example.playing) example.post({ type: 'poptart-embed-stop' });
        else use(example, { type: 'poptart-embed-play' });
      });
      // A click waits a moment before it swaps the code for the editor: taken at once, the second
      // click of a double-click would land on the frame, and the word would never open.
      let pending = null;
      pre.addEventListener('click', (e) => {
        if (e.detail > 1) return; // the double-click below has it
        const at = offsetAt(example, e);
        clearTimeout(pending);
        pending = setTimeout(() => use(example, { type: 'poptart-embed-cursor', at }), 280);
      });
      pre.addEventListener('dblclick', (e) => {
        clearTimeout(pending);
        use(example, { type: 'poptart-embed-open', at: offsetAt(example, e) });
      });
      open.addEventListener('click', async () => {
        const { encodeShareHash } = await import('/web/share-link.mjs');
        window.open(`/#${await encodeShareHash(currentCode(example))}`, '_blank', 'noopener');
      });
    }
  }
})();
