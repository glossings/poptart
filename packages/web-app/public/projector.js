'use strict';

// The projector window (F1) - the playing decks' code on the screen behind the set.
//
// This page computes nothing. It is handed a frame by the editor window over postMessage - each
// playing deck's text, already shaped (the editor's own data taken out, optionally run together;
// see projector-frame.js) plus the spans of whatever is sounding in it, exactly the spans the
// editor's own highlighter just drew - and its whole job is to put that on a black screen as
// large as it will go.
//
// The same frame goes out over the feed (GET /api/projector/events) for anything else that wants
// it. This window is simply the consumer that ships in the box.
// ---------------------------------------------------------------------------------------------

if (typeof document !== 'undefined') initProjector();

function initProjector() {
  const box = document.getElementById('box');
  const fit = document.getElementById('fit');

  let shownText = ''; // what the font size was last measured against - decks and all
  let sizedTo = ''; // the resolution already asked for, so a hand-resized window is left alone
  let applied = { token: null, seq: 0 }; // the frame on the wall, named back in every hello

  /** One deck's text as a run of nodes, the sounding atoms in boxes of their own. */
  function renderDeck(el, text, spans) {
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [s, e] of spans) {
      if (s > at) frag.appendChild(document.createTextNode(text.slice(at, s)));
      const lit = document.createElement('span');
      lit.className = 'lit';
      lit.textContent = text.slice(s, e);
      frag.appendChild(lit);
      at = e;
    }
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
    el.textContent = '';
    el.appendChild(frag);
  }

  /**
   * The largest font size the whole thing still fits in, by bisection. Lit spans are drawn with a
   * box-shadow, which costs no layout, so this only has to run when the TEXT changes (or the
   * window does) - not on every frame the sounding atom moves.
   */
  function refit() {
    const availW = box.clientWidth;
    const availH = box.clientHeight;
    if (!availW || !availH || !fit.textContent) return;
    let lo = 4;
    let hi = availH;
    for (let i = 0; i < 20 && hi - lo > 0.25; i++) {
      const mid = (lo + hi) / 2;
      fit.style.fontSize = `${mid}px`;
      if (fit.scrollHeight <= availH && fit.scrollWidth <= availW) lo = mid;
      else hi = mid;
    }
    fit.style.fontSize = `${lo}px`;
  }

  /** Take the window to the resolution the settings asked for, chrome and all. */
  function applySize(width, height) {
    const want = `${width}x${height}`;
    if (!(width > 0 && height > 0) || want === sizedTo) return;
    sizedTo = want;
    try {
      window.resizeTo(width + (window.outerWidth - window.innerWidth),
        height + (window.outerHeight - window.innerHeight));
    } catch {
      // Some window managers refuse; the projector is still the right picture, just not that size.
    }
  }

  function applyFrame(frame) {
    applied = { token: frame.token ?? null, seq: frame.seq ?? 0 };
    applySize(frame.width, frame.height);
    document.body.classList.toggle('collapsed', !!frame.collapse);
    const decks = frame.decks ?? [];
    // Rebuild the deck blocks only when their number changes - the common frame is the same decks
    // with a different atom lit, and that must not throw the layout away and measure it again.
    while (fit.children.length > decks.length) fit.lastElementChild.remove();
    while (fit.children.length < decks.length) {
      const el = document.createElement('div');
      el.className = 'deck';
      fit.appendChild(el);
    }
    decks.forEach((deck, i) => renderDeck(fit.children[i], deck.text ?? '', deck.spans ?? []));
    const text = decks.map((d) => d.text ?? '').join('\n');
    if (text === shownText) return;
    shownText = text;
    refit();
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === 'poptart-projector') applyFrame(e.data);
  });

  // Say hello, and keep saying it. It is how the first frame is asked for (this page can easily
  // finish loading after the editor has already sent one), and it is how this window is adopted
  // again by an editor page that has RELOADED under it - window.open re-targets a window by name,
  // so the one on the wall is the one that comes back, rather than a frozen second one.
  //
  // Each hello names the frame already on the wall, so an editor that has nothing newer answers
  // with nothing at all: in a steady set this costs one message every two seconds and no redraw.
  function hello() {
    try {
      if (!window.opener || window.opener.closed) {
        window.close(); // poptart went away; a frozen patch on the wall helps nobody
        return;
      }
      window.opener.postMessage(
        { type: 'poptart-projector-ready', token: applied.token, seq: applied.seq },
        location.origin);
    } catch {
      // The opener is on its way out - the next tick closes us.
    }
  }
  hello();
  setInterval(hello, 2000);

  // F1 put it up and F1 takes it down, from either window - and escape, because that is what a
  // full-screen window with nothing in it but text is expected to answer to.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F1' && e.key !== 'Escape') return;
    e.preventDefault();
    window.close();
  });

  new ResizeObserver(() => refit()).observe(box);
}
