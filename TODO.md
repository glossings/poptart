# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

## Signals (new)
- [ ] **`pianoroll`** signal that pulls up an interactive piano roll and emits the drawn notes/velocities
- [ ] Ability to send signals/midi to specific VSTs. E.g. Kickstart can use a midi trigger OR audio as a secondary input
  to control when the target sound is sidechained.

## Hotkeys
- [ ] Build **infrastructure** making it easy for the user to add their own hotkeys
- [ ] Port over the existing **Strudel hotkeys** (full source preserved below)
  - Cmd+Shift+`0` — refactor patterns → `const` + `blockArrange` scaffold
  - Cmd+Shift+`.` — insert one-line 8th-note wrapper `"<>*8"`
  - Cmd+Shift+`,` — insert multi-line 8th-note wrapper
  - Cmd+Shift+`d` — duplicate column at cursor in `blockArrange`
  - Cmd+Shift+`m` — replace highlighted steps with value + ties
  - Cmd+Shift+`g` — randomly deviate highlighted numbers
  - Cmd+Shift+`e` — replace highlighted steps with Euclidean hits
  - Cmd+Shift+`c` — count highlighted steps
  - Cmd+Shift+`b` — interactive beat insertion
  - Cmd+Shift+`/` — insert 16 rests
  - Cmd+Shift+`l` — insert standard lowpass filter controls
  - Cmd+Shift+`;` — interactive melody/control insertion (uses `_randn`, `_randExp`, `_randAcid` helpers)
  - NOTE: some rely on Strudel-specific APIs (`repl.setCode`, `blockArrange`, `bjorklund`,
    `rotate`, `_prompt`/`_alert`) — these need poptart equivalents when porting.

---

## Standing preferences (captured, not code tasks)
- [x] "Tell me before running bash / use fewer bash commands / batch checks at the end"
  → saved as a persistent feedback memory so future sessions honor it. See below.

<details>
<summary>Strudel hotkey source (reference for porting)</summary>

```js
// Random Normal (Box-Muller)
const _randn = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// Random exponential helper
const _randExp = (lambda = 1) => {
  return -Math.log(1 - Math.random() * (1 - Math.exp(-lambda))) / lambda;
};

// Configurable acid-like pattern generator that mostly stays near 0 but can jump up occasionally
const _randAcid = (acidity = 0) => {
  const mix = clamp(acidity, 0, 10) / 10;
  const low = _randExp(0.5 + 7.5 * mix);
  const jumpChance = 0.02 + 0.14 * mix;
  const jump = 1 - Math.pow(Math.random(), 3.5);
  const acid = Math.random() < jumpChance ? jump : low;
  return Math.random() * (1 - mix) + acid * mix;
};

// HOTKEYSSSSSSS
if (!window.__hotkeysAreSet) {
  const repl = window.strudelMirror;
  window.addEventListener('keydown', async (event) => {
    if (event.repeat) return;
    const meta = event.metaKey;
    const shift = event.shiftKey;
    if (meta && shift && event.key === '0') {
      event.preventDefault();
      const toStack = [];
      const names = new Set();
      let code = repl.code.replace(/^([A-z0-9$]+):\s*(.+)$/gm, (_m, name, pat) => {
        // Strip mutes and solos
        name = name.replace(/^[_S]+|[_S]+$/g, '');
        // Rename anonymized patterns
        if (name === '$') {
          name = 'anon';
        } else if (name.startsWith('$')) {
          name = name.slice(1);
        }
        // Bump idx of repeated names
        const match = name.match(/^(.*?)(\d+)$/);
        let idx = match ? Number(match[2]) : 1;
        const baseName = match ? match[1] : name
        while (names.has(name)) {
          idx++;
          name = baseName + idx;
        }
        names.add(name);
        toStack.push(name);
        return 'const ' + name + ' = ' + pat;
      });
      repl.setCode(code);
      if (toStack.length) {
        const sorted = [...toStack].sort();
        // align all block arrange patterns
        const offset = Math.max(...sorted.map(n => n.length));
        const rows = sorted.map(n => '  [' + n + ',' + ' '.repeat(offset - n.length + 3) + '`<' + Array(1).fill(0).join(' ') + '>`]');
        repl.appendCode('\n\n$: blockArrange([\n' + rows.join(',\n') + ',\n])');
      }
    }
    // CMD + SHIFT + . = insert one-line 8th note wrapper
    if (meta && shift && event.key === '.') {
      event.preventDefault();
      const x = repl.getCursorLocation();
      repl.insertCode('"<>*8"', x);
      repl.setCursorLocation(x + 2);
    }
    // CMD + SHIFT + , = insert multi-line 8th note wrapper
    if (meta && shift && event.key === ',') {
      event.preventDefault();
      const x = repl.getCursorLocation();
      repl.insertCode('\`<\n  \n>*8\`', x);
      repl.setCursorLocation(x + 5);
    }
    // CMD + SHIFT + d = duplicate column at cursor in blockArrange
    if (meta && shift && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      const cursorPos = repl.editor.state.selection.main.head;
      const code = repl.code;

      // Find blockArrange block containing cursor
      const baRegex = /\$:\s*blockArrange\(\[[\s\S]*?\]\)/g;
      let baMatch, baBlock = null;
      while ((baMatch = baRegex.exec(code)) !== null) {
        if (baMatch.index <= cursorPos && cursorPos < baMatch.index + baMatch[0].length) {
          baBlock = { text: baMatch[0], start: baMatch.index };
          break;
        }
      }
      if (!baBlock) return;

      // Find which `<...>` row contains cursor and determine column index
      const tickRegex = /`<([^>]*)>`/g;
      let tMatch, colIndex = -1;
      while ((tMatch = tickRegex.exec(baBlock.text)) !== null) {
        const contentStart = baBlock.start + tMatch.index + 2; // skip `<
        const contentEnd = contentStart + tMatch[1].length;
        if (contentStart <= cursorPos && cursorPos <= contentEnd) {
          const tokens = tMatch[1].split(' ');
          let pos = contentStart;
          for (let i = 0; i < tokens.length; i++) {
            if (cursorPos <= pos + tokens[i].length) { colIndex = i; break; }
            pos += tokens[i].length + 1;
          }
          break;
        }
      }
      if (colIndex === -1) return;

      // Duplicate the element at colIndex in every row
      const allTicks = [];
      tickRegex.lastIndex = 0;
      while ((tMatch = tickRegex.exec(baBlock.text)) !== null) {
        allTicks.push({ index: tMatch.index, text: tMatch[0], content: tMatch[1] });
      }

      let newBaText = baBlock.text;
      let extraOffset = 0;
      for (const tick of allTicks) {
        const tokens = tick.content.split(' ');
        const idx = Math.min(colIndex, tokens.length - 1);
        const newTokens = [...tokens.slice(0, idx + 1), tokens[idx], ...tokens.slice(idx + 1)];
        const newTick = '`<' + newTokens.join(' ') + '>`';
        const adjStart = tick.index + extraOffset;
        newBaText = newBaText.slice(0, adjStart) + newTick + newBaText.slice(adjStart + tick.text.length);
        extraOffset += newTick.length - tick.text.length;
      }

      repl.setCode(code.slice(0, baBlock.start) + newBaText + code.slice(baBlock.start + baBlock.text.length));
    }
    // CMD + SHIFT + m = replace highlighted steps with value + ties
    if (meta && shift && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      const selection = repl.editor.state.selection.main;
      const selected = repl.editor.state.doc.sliceString(selection.from, selection.to);
      const value = await _prompt('Value?', 1);
      let i = 0;
      const replacement = selected.replace(/\S+/g, () => (i++ === 0 ? String(value) : '_'));
      repl.replaceCode(replacement, selection.from, selection.to);
      repl.setCursorLocation(selection.from + replacement.length);
    }
    // CMD + SHIFT + g = randomly deviate highlighted numbers
    if (meta && shift && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      const selection = repl.editor.state.selection.main;
      const selected = repl.editor.state.doc.sliceString(selection.from, selection.to);
      const deviation = await _prompt('Deviation?', 0.5);
      const quantize = await _prompt('Quantize?', 1);
      const replacement = selected.replace(/-?\d*\.?\d+/g, (m) => {
        const n = parseFloat(m);
        const factor = Math.max(0.1, 1 - deviation) + Math.random() * 2 * deviation;
        const r = n * factor;
        const isInt = !m.includes('.');
        return quantize > 0.5 && isInt ? String(Math.round(r)) : r.toFixed(2);
      });
      repl.replaceCode(replacement, selection.from, selection.to);
      repl.setCursorLocation(selection.from + replacement.length);
    }
    // CMD + SHIFT + e = replace highlighted steps with Euclidean rhythm hits
    if (meta && shift && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      const selection = repl.editor.state.selection.main;
      const selected = repl.editor.state.doc.sliceString(selection.from, selection.to);
      const hits = parseInt(await _prompt('Hits?', 2));
      const rotation = parseInt(await _prompt('Start?', 0));
      const count = (selected.match(/\S+/g) || []).length;
      const pattern = rotate(bjorklund(hits, count), -rotation);
      let i = 0;
      const replacement = selected.replace(/\S+/g, (m) => (pattern[i++] ? '1' : m));
      repl.replaceCode(replacement, selection.from, selection.to);
      repl.setCursorLocation(selection.from + replacement.length);
    }
    // CMD + SHIFT + c = count # of steps highlighted
    if (meta && shift && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      const selection = repl.editor.state.selection.main;
      const selected = repl.editor.state.doc.sliceString(selection.from, selection.to);
      let count = 0, depth = 0;
      // Split across spaces and drop leading/trailing/empty
      for (const part of selected.split(/\s+/).filter(Boolean)) {
        if (depth === 0) count++;
        for (const ch of part) {
          // [] and <> should only count as one step
          if (ch === '[' || ch === '<') depth++;
          else if (ch === ']' || ch === '>') depth--;
        }
      }
      await _alert('Count: ' + count);
    }
    // CMD + SHIFT + b = interactive beat insertion
    if (meta && shift && event.key === 'b') {
      event.preventDefault();
      const numBeats = await _prompt('How many beats?', 4);
      const density = await _prompt('Density (out of 10)?', 5);
      const x = repl.getCursorLocation();
      let beatString = '';
      const getChoice = () => Math.random() < density / 10;
      for (let i = 0; i < numBeats; i++) {
        if (i > 0) beatString += ' ';
        const c1 = getChoice(),
          c2 = getChoice();
        if (c1 && c2) {
          beatString += '1';
        } else if (c1) {
          beatString += '[1 ~]';
        } else if (c2) {
          beatString += '[~ 1]';
        } else {
          beatString += '~';
        }
      }
      repl.insertCode(beatString, x);
      repl.setCursorLocation(x + beatString.length);
    }
    // CMD + SHIFT + / = insert 16 rests
    if (meta && shift && event.key === '/') {
      event.preventDefault();
      const x = repl.getCursorLocation();
      const rests = '~ '.repeat(16).trimEnd();
      repl.insertCode(rests, x);
      repl.setCursorLocation(x + rests.length);
    }
    // CMD + SHIFT + L = insert standard lowpass filter controls
    if (meta && shift && event.key === 'l') {
      event.preventDefault();
      const x = repl.getCursorLocation();
      const c = '.lpf(200).lpe(4).lpa(0).lpd(0.3).lps(0.4).lpr(0).lpq(1)'
      repl.insertCode(c, x);
      repl.setCursorLocation(x + c.length);
    }
    // CMD + SHIFT + ; = interactive melody/control insertion
    if (meta && shift && event.key === ';') {
      event.preventDefault();
      const x = repl.getCursorLocation();
      const numBeats = await _prompt('How many beats?', 8);
      const max = await _prompt('Max value?', 1);
      const quantize = await _prompt('Quantize?', 0);
      const restDensity = await _prompt('Rest density?', 0);
      const rhythm = await _prompt('Add rhythm?', 0);
      const acidity = await _prompt('Acidity? (0 uniform, 10 acid)', 0);
      const getChoice = (remainingBeats) => {
        const beats = rhythm > 0.5 ? clamp(Math.max(1, Math.round(1 + _randn() * 2)), 1, remainingBeats) : 1;
        if (10 * Math.random() < restDensity) {
          return ['~', beats];
        }
        const r = _randAcid(acidity) * max;
        const choice = quantize > 0.5 ? Math.round(r) : r.toFixed(2);
        return [choice, beats];
      }
      let randString = '';
      let totalBeats = 0;
      while (totalBeats < numBeats) {
        const [choice, beats] = getChoice(numBeats - totalBeats);
        randString += beats === 1 ? `${choice}` : `${choice}@${beats}`;
        totalBeats += beats;
        if (totalBeats < numBeats) {
          randString += ' ';
        }
      }
      repl.insertCode(randString, x);
    }
  });
}
window.__hotkeysAreSet = true;
```

</details>
