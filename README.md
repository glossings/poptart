# Poptart

A livecoding environment for real instruments. You arrange your music in simple notation; Poptart
plays and continuously modulates actual VST/VST3 plugins.

```js
n("0 2 3")
  .scale("F minor")
  .synth("Serum 2")
  .param("Filter 1 Freq", sine({ rate: 0.3 }).range(200, 5000))
```

That's a synth line in F minor played through Serum, with its filter cutoff swept by a 0.3 Hz sine. Edit the code, hit eval, and the sound changes underneath your hands.

If you somehow ended up here without previously checking out [Tidal Cycles](https://tidalcycles.org) and [Strudel](https://strudel.cc), please do yourself a favor and give them a try - Poptart mirrors a lot of the patterning concepts and mini notation pioneered in those programs.

## What it does

- **Real plugins as instruments and effects.** `.synth("…")` loads any VST2/VST3 instrument,
  `.fx("…")` chains effects after it, and `.param("Filter 1 Freq", …)` addresses knobs by their
  real names.
- **Modulation that actually moves.** LFOs, hand-drawn shapes and per-note envelopes run natively
  inside the audio engine, sample-accurate.
- **Strudel-style mini-notation** for notes, degrees, scales, rhythms and randomness.
- **A sampler, a piano roll, a mixer, MIDI in and out** — all of it writing code rather than
  hiding state, so the patch *is* the sound and a single file plays exactly what you heard.
- **Extensible from the editor.** Extend `Signal.prototype` live, the way you would in Strudel.

Everything past that is in the built-in guide — the **docs ↗** button in the app.

## How it works

Three packages: `pattern-core` (the pattern language and scheduler, pure JS), `osc-engine`
(spawns SuperCollider and talks OSC to it; SuperCollider hosts the plugins via the `VSTPlugin`
extension and runs the native modulators), and `web-app` (a small Node server plus the browser
editor — no Electron). See [ARCHITECTURE.md](ARCHITECTURE.md) for the long version.

## Requirements

- **Node 20+**
- **SuperCollider** — `brew install --cask supercollider` on macOS. poptart finds `sclang` at the
  standard install location by itself; if yours lives elsewhere, set
  `POPTART_SCLANG=/full/path/to/sclang`.
- **The VSTPlugin server extension** — installed for you on first run (downloaded, checksum-verified
  and unzipped into SuperCollider's `Extensions` folder). Manual install: see
  [SETUP.md](SETUP.md).

No AudioUnit support — `VSTPlugin` is VST2/VST3 only; in practice nearly every AU also ships a VST3.

## Getting started

```sh
npm install     # installs all workspaces
npm run dev     # starts the server; it spawns sclang itself
```

Then open <http://localhost:4000>. The first run prints a short setup report (SuperCollider found?
VSTPlugin installed? anything known to wreck a boot?) before the engine comes up.

1. Click **rescan** to scan your installed plugins. Click a result to copy its exact name — that's
   the string `.synth()` and `.fx()` want.
2. Write a pattern and press **eval** (Cmd/Ctrl+Enter). **stop** is Cmd/Ctrl+.
3. Open **docs ↗** and follow the studies.

The server listens on `127.0.0.1` only — evaluated code runs with your user's privileges, so it
must not be reachable from the network. (`POPTART_HOST=0.0.0.0` opts into LAN access, with a
warning.)

Where things live on disk, every environment variable, how to narrow the plugin scan, and what to
do when the engine won't boot: [SETUP.md](SETUP.md).

## License

Poptart is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-only) — see
[LICENSE](LICENSE).

In plain terms: you can use it, study it, share it, and modify it freely. Make whatever music you
like with it and sell that music — your tracks are yours, the license doesn't touch them. The one
condition is on the *code*: if you distribute a modified version, or run one as a network service,
you have to make your source available under the same license. That's deliberate — it keeps Poptart
open for artists and hobbyists while stopping anyone from quietly rolling it into a closed,
proprietary product.
