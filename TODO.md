# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

## Signals (new)
- [ ] **`pianoroll`** signal that pulls up an interactive piano roll and emits the drawn notes/velocities

## Hotkeys
Infrastructure shipped: `hotkey(combo, handler)` + an `editor`/`repl` facade are provided to the
prebake sandbox in the browser (see `runUserPrebake` in `client.js`); the server no-ops those
calls when it runs the same prebake for DSL defs. Built-in chords: ctrl+p (settings), ctrl+r
(record), ctrl+b (midi keyboard). The ported Strudel hotkeys live in the gitignored
`packages/web-app/prebake.hotkeys.js` — paste into `~/.poptart/prebake.js` to use them.
