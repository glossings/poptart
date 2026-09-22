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
- **Shares its clock.** MIDI clock out for hardware, Ableton Link for the other apps on the
  network.

Everything past that is in the built-in guide — the **docs ↗** button in the app.

## How it works

Three packages do the work: `pattern-core` (the pattern language and scheduler, pure JS),
`osc-engine` (spawns SuperCollider and talks OSC to it; SuperCollider hosts the plugins and runs
the native modulators), and `web-app` (a small Node server plus the browser editor). A fourth,
`desktop`, is an optional Electron window around that same server. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the long version.

## Download

[**Latest release**](https://github.com/glossings/poptart/releases/latest) - the app, with
nothing to install first. Everything below about SuperCollider applies: poptart sets that up
itself on first run.

| | |
| --- | --- |
| **Windows** | `poptart-<version>-setup.exe` - the normal installer. |
| **Windows, portable** | `poptart-<version>-portable-x64.zip` - unpack it anywhere, and poptart keeps your songs in the `poptart-data` folder inside it instead of your user folder. For an external drive, or two separate setups. |
| **macOS** | `poptart-<version>-arm64.dmg` for Apple Silicon, `-x64.dmg` for Intel Macs. **Not yet signed - see below.** |

**The macOS builds are not signed by a registered developer yet**, so macOS will refuse to open
them the first time. Drag Poptart to your Applications folder, then open **System Settings →
Privacy & Security**, scroll down to **Security**, and click **Open Anyway** next to the message
about Poptart. You only do this once.

If no such message appears there, remove the download flag from a terminal instead and open it
again:

```sh
xattr -dr com.apple.quarantine /Applications/Poptart.app
```

(Apple Developer signing is in progress. Once it lands, neither step is needed.)

Every installer is built by GitHub Actions from a tagged commit in this repository - the build
log for any release is public, so you can see exactly what went into it.

Intel Macs: the `-x64` build is produced by CI but has not been run by hand on an Intel machine.

## Requirements

**To build from source: Node 20+.** The downloads above need nothing installed.

The audio engine underneath poptart is [SuperCollider](https://supercollider.github.io), and
poptart sets it up for you on first run:

- **Don't have SuperCollider?** poptart asks, then downloads its own private copy into
  `~/.poptart/sc`. No administrator password, nothing installed system-wide, nothing else on
  your machine touched; deleting that folder undoes it. (macOS and Windows. SuperCollider
  publishes no Linux binaries, so on Linux install it from your package manager first.)
- **Already have it?** poptart finds it and uses it, and leaves it alone.

Everything SuperCollider needs in order to host plugins is fetched and put in place the same
way. There is nothing to configure.

No AudioUnit support — plugins are VST2/VST3 only; in practice nearly every AU also ships a VST3.

macOS is where poptart is developed and where everything works. It runs on Windows too, with
two gaps for now: no Ableton Link, and the decks' keylock uses its rougher fallback.

## Getting started from source

```sh
npm install
npm run dev
```

Then open <http://localhost:4000>.

The first run takes a little longer than the rest. If poptart needs its own SuperCollider it
asks first (`[y/N]` — it is a 140–250 MB download), and it scans your installed plugins, which
on a machine with a lot of them can take several minutes. The scan runs in the background: the
editor is usable straight away, the header counts the plugins as they are probed, and the list
fills in folder by folder as it goes. Plugin *names* are the one thing that won't resolve until
it has finished. After that first time, startup is quick.

1. Open the **Plugins** panel and click a plugin to copy its exact name — that's the string
   `.synth()` and `.fx()` want. (**rescan** picks up anything you install later.)
2. Write a pattern and press **eval** (⌘↵, or ctrl+enter off a Mac). **stop** is ⌘. / ctrl+.
3. Open **docs ↗** and follow the studies.

Prefer a window of its own to a browser tab? `npm run desktop` opens the same thing as an app
(it installs what it needs the first time) - the same window the downloads above give you,
running straight from your checkout.

The server listens on `127.0.0.1` only — evaluated code runs with your user's privileges, so it
must not be reachable from the network. (`POPTART_HOST=0.0.0.0` opts into LAN access, with a
warning.)

If something doesn't come up, `npm run doctor` prints everything poptart decided and why. Where
things live on disk, every setting, how to narrow the plugin scan, and what to do when the engine
won't boot: [SETUP.md](SETUP.md).

## License

Poptart is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-only) — see
[LICENSE](LICENSE).

In plain terms: you can use it, study it, share it, and modify it freely. Make whatever music you
like with it and sell that music — your tracks are yours, the license doesn't touch them. The one
condition is on the *code*: if you distribute a modified version, or run one as a network service,
you have to make your source available under the same license. That's deliberate — it keeps Poptart
open for artists and hobbyists while stopping anyone from quietly rolling it into a closed,
proprietary product.
