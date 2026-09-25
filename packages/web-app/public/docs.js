'use strict';

// The guide's code, colored by the editor's own mode - and in the browser build, played.
//
// Every `<pre><code>` is plain text in the markup and is highlighted here with CodeMirror's
// runmode and the poptart mode, so an example reads exactly as it would in the editor and nobody
// colors one by hand.
//
// In the browser build (docs.html's <html> carries class "web" there, see build-web.mjs) an
// example marked `<pre data-run>` becomes a small editor with a play button: the whole example is
// one buffer, evaluated by the same engine the app runs, started the first time anything is
// played. It is booted isolated (boot.mjs) - no store, no prebake - so an example sounds the same
// for everyone, and one example plays at a time. "open" hands the example to the app as a share
// link (web/share-link.mjs).
//
// Markup, for whoever writes the guide:
//   <pre><code>…</code></pre>            highlighted, in both builds
//   <pre data-run><code>…</code></pre>   a complete buffer, playable in the browser build
//   data-build="desktop" / "web"          on any element: shown in that build only (docs.html CSS)

(function () {
  const isWeb = document.documentElement.classList.contains('web');

  function highlight(pre) {
    const code = pre.querySelector('code') ?? pre;
    const text = code.textContent.replace(/\n$/, '');
    code.textContent = '';
    CodeMirror.runMode(text, 'poptart', code);
    code.classList.add('cm-s-docs');
    return text;
  }

  for (const pre of document.querySelectorAll('pre')) {
    if (pre.hasAttribute('data-run') && isWeb) continue;
    highlight(pre);
  }
  if (!isWeb) return;

  // ---- playing -----------------------------------------------------------------------------------

  let hostPromise = null;
  let playing = null; // the example on now: { el, button }

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

  const examples = [];
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
    const editor = CodeMirror(el, {
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
    const example = { el, button, status, editor };
    button.addEventListener('click', () => (playing === example ? stop() : play(example)));
    open.addEventListener('click', () => openInApp(example).catch((err) => { status.textContent = String(err?.message ?? err); }));
    examples.push(example);
  }
})();
