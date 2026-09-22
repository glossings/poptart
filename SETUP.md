# Setup, configuration & troubleshooting

The README covers the short path (`npm install`, `npm run dev`, open the page), and that path is
meant to be the whole of it: poptart fetches and configures what it needs on first run. This is
everything else — where it looks for things, what you can point elsewhere, and what to do when
something doesn't come up.

## Configuration

Most things work out of the box; a few can be pointed elsewhere.

| What | Where | Default |
| --- | --- | --- |
| Everything poptart writes - settings, songs, samples, recordings, caches, logs, its private SuperCollider | `POPTART_HOME` | `~/.poptart` |
| Sample library folder | **settings** tab, or `POPTART_SAMPLES_DIR` | `~/.poptart/samples` |
| Audio output device | **settings** tab | system default |
| Extra audio **inputs** (combined into one device, so `input()` can reach several interfaces) | **settings** tab | none |
| Plugin scan directories | `POPTART_VST_DIRS` (separated by `:`, or `;` on Windows) | `~/.poptart/plugins` if it exists, else the standard VST locations |
| Plugins to skip when scanning | `POPTART_VST_EXCLUDE` (same separator) | none |
| Prefer VST3 over VST2 (hide VST2 builds whose name also exists as VST3) | **settings** tab | on |
| Probe plugins in parallel while scanning | `POPTART_VST_PARALLEL=1` | off (one plugin at a time) |
| Saved patterns (and autosaved sessions, under `wip/`) | `POPTART_PATTERNS_DIR` | `~/.poptart/patterns` |
| Bounced tracks (filed by month, played with `sr()`) | `POPTART_RECORDINGS_DIR` | `~/.poptart/recordings` |
| Startup setup file / folder | `POPTART_PREBAKE_FILE`, `POPTART_PREBAKE_DIR` | `~/.poptart/prebake.js`, `~/.poptart/prebake/` |
| ★ library (pinned rolls/shapes/presets/packs) | the ★ in any picker (or edit the file) | `~/.poptart/prebake/pinned.js` |
| Persisted settings | `POPTART_SETTINGS_FILE` | `~/.poptart/settings.json` |
| OSC / scsynth ports | `POPTART_OSC_NODE_PORT`, `POPTART_OSC_SC_PORT`, `POPTART_SCSYNTH_PORT` | `57140` / `57150` / `57110` |
| SuperCollider binary | `POPTART_SCLANG` | auto-detected — see [Where SuperCollider comes from](#where-supercollider-comes-from) |
| Let poptart fetch its own SuperCollider | `POPTART_INSTALL_SC=1` (never: `=0`) | asks, when there's a terminal to ask in |
| Where that private copy lives | `POPTART_SC_ROOT` | `~/.poptart/sc` |
| Keep the SuperCollider download for reuse | `POPTART_SC_CACHE_DIR` | not kept (deleted after unpacking) |

`POPTART_HOME` moves the whole folder at once - onto an external drive, or to keep a second,
separate setup - and every `~/.poptart/...` default in this table moves with it; the narrower
variables still win for the one location each names.

No variable is needed to keep everything with poptart itself: make a folder called
`poptart-data` and it is used instead of `~/.poptart`, so poptart and everything it has written
travel as one folder. Where it goes depends on which poptart you have:

- **A checkout** (you cloned the repository): at its root, beside `packages/`. git ignores it.
- **Windows, the portable download**: already there. Unpack `poptart-<version>-portable-x64.zip`
  wherever you like and `poptart-data` is inside it, next to `poptart.exe` - that is the whole
  setup. To update, unpack the new zip over the same folder; your files are not in the zip, so
  they are left alone.
- **Windows, the installer**: not available, and poptart **refuses** a folder next to an
  installed copy rather than filling it (it says so in its log). Uninstalling or updating an
  installed copy deletes its whole folder and would take your songs with it - and the
  uninstaller travels with the app, so moving it elsewhere does not help. Use the portable
  download, or set `POPTART_HOME`.
- **macOS**: next to `poptart.app`. Make the folder yourself. The app must first be moved out of
  the folder it was downloaded into.

Except in the portable download, the folder has to exist before poptart starts - it is looked
for, never created. To bring what you already have, move the contents of `~/.poptart` into it;
an empty folder is a fresh start (including a fresh SuperCollider download, if poptart fetched
its own). Pointing `POPTART_HOME` at the checkout itself also works and is a bad idea: git would
list your songs as untracked files, and one `git clean` would delete them.

### Removing poptart

Delete the app (drag it to the Trash on macOS; on Windows use its uninstaller, which offers to
delete your data as well and keeps it unless you say otherwise), then delete the folder above -
that is where poptart keeps everything it wrote, including the SuperCollider copy it may have
downloaded for itself, which is most of its size.

One thing can live outside that folder: if you had SuperCollider installed already, poptart put
its pitch-shifting UGen in *your* SuperCollider Extensions folder rather than its own, as
`Extensions/poptart/`. Delete that folder too. (It may also have installed `Extensions/VSTPlugin/`
there, which is not poptart's - it is the SuperCollider extension that hosts plugins, useful on
its own, so poptart leaves that decision to you.) The Extensions folder is:

| macOS | `~/Library/Application Support/SuperCollider/Extensions` |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SuperCollider\Extensions` |
| Linux | `~/.local/share/SuperCollider/Extensions` |

If poptart downloaded its own SuperCollider, none of this applies - it used its own Extensions
folder inside the data folder. Either way, the diagnostic report says which one it used:
`npm run doctor` from a checkout, or Help > Save Diagnostic Report in the desktop app.

To make an environment variable permanent, add it to your shell profile. For the default zsh on
macOS:

```sh
echo 'export POPTART_SAMPLES_DIR="$HOME/Music/samples"' >> ~/.zshrc
```

Then open a new terminal (or `source ~/.zshrc`). Prefer the settings tab for the sample folder and
audio device — the environment variables exist for scripted or multi-machine setups.

### Curating the plugin scan

Scanning every default plugin location can be slow, and some plugins crash or hang their probe.
Two knobs help:

- `POPTART_VST_DIRS` narrows the scan to specific directories. A common setup is a folder of
  symlinks to just the plugins you play, at `~/.poptart/plugins` (used automatically when it
  exists) — this keeps scans fast and avoids problem plugins entirely.
- `POPTART_VST_EXCLUDE` skips individual plugins by absolute path, so they are never probed. Use
  it for copy-protection, metering, or analysis plugins that fail to probe headlessly.

Poptart adds two exclusions of its own, and says so at startup when it does. The first is any
file that has a plugin extension but is not a binary this machine could load — the Windows
build of a plugin left in a macOS plugin folder, say, or a text file someone named `notes.vst3`.
Probing one of those crashes the audio server outright, and because the plugin cache is only
written when a whole scan finishes, a single such file means no scan ever completes and no
plugin is ever found. The second is whatever a previous scan died on: the plugin being probed
is noted in `~/.poptart/scan-journal.json`, and if poptart sees the audio server die during
that probe, it skips that plugin from then on. (Quitting poptart mid-scan blames nothing.)
Delete that file to try the skipped plugins again.

Plugins are probed one at a time. Probing them in parallel is faster but has crashed the audio
server partway through a large scan, so it is off by default; set `POPTART_VST_PARALLEL=1` to
turn it on. Either way only plugins that are new or changed since the last scan get probed.

While a scan is running the header says so and counts the plugins as they are probed, and the
plugins panel names the one being probed right now — a plugin whose probe puts up its own
window (an activation dialog, typically) otherwise looks exactly like a scan that has hung.
Everything except plugin names works meanwhile; `.synth("Name")` says the scan is still running
rather than claiming the name does not exist. The scan runs one folder at a time, so each
folder's plugins become playable — and are saved to the cache — as it finishes, rather than
everything arriving at the end or nothing arriving at all.

A probe that fails is not fatal — it is reported as `error!` in the scan log and that plugin is
simply absent from the list. Plugins with copy protection or their own startup dialogs commonly
fail to probe headlessly while working fine in a DAW.

Many plugins install both a VST2 and a VST3 build. By default poptart lists only the VST3 when
both exist (the **prefer VST3 over VST2** toggle in the settings tab), and `.synth("Name")` /
`.fx("Name")` resolve name collisions to the VST3. Both builds are still scanned, and the VST2
stays loadable by its exact id: `.synth("Mangle")` is the VST2, `.synth("Mangle.vst3")` the VST3.

### Sync: MIDI clock out and Ableton Link

Both live in the settings tab's **sync** section, and both settings persist across restarts.

**midi clock out** sends MIDI clock, with start/stop and song position, to one MIDI destination,
so a drum machine or hardware sequencer follows poptart's tempo and transport. Pick the
destination by name — it is matched the same way as `midicc()` device names, so a
case-insensitive fragment is enough. In mix mode the hardware follows the desk's clock, tempo
migrations included.

**ableton link** joins the Link session on your local network, so poptart shares a timeline with
a DAW, a phone app or another livecoder:

- Change the tempo on either side and the other follows. Re-evaluating your code does not reset
  the tempo unless you actually edited its `setbpm`.
- Press play or stop in poptart and the other apps do the same. Their play and stop reach
  poptart too, except in mix mode, where nothing outside poptart can stop a set.
- Poptart starts in step with the session's bars, so starting mid-bar starts you mid-pattern,
  as in any Link app.

Link is macOS-only for now; on other systems the toggle is disabled.

## Where SuperCollider comes from

SuperCollider is the audio engine poptart plays through. You don't have to install it: poptart
looks for one on first run, and if there isn't one it offers to download its own.

**poptart's own copy.** Say yes at the prompt and it lands in `~/.poptart/sc`, and that is the
whole footprint:

- Nothing is installed system-wide and no administrator password is needed, so this works on a
  locked-down or shared machine.
- An existing SuperCollider, and its IDE, are left completely alone.
- Uninstalling is deleting `~/.poptart/sc`.
- It is a download of 139–250 MB, which is why poptart asks first rather than doing it quietly.
  Answer in advance with `POPTART_INSTALL_SC=1`, or refuse once and for all with `=0`. With no
  terminal to ask in — a service, an editor's integrated runner — the answer is no. (The desktop
  app asks with a dialog instead.)

macOS and Windows only: SuperCollider publishes no official Linux binaries, so on Linux this is
not offered — install it from your package manager and poptart finds it.

**Your own install.** If SuperCollider is already on the machine — Homebrew, the official
installer, a package manager — poptart finds it and uses it, and never offers the download. To
move to poptart's own copy anyway, run once with `POPTART_INSTALL_SC=1`. To point at a build in
an unusual place, set `POPTART_SCLANG` to the `sclang` binary.

poptart's own copy is the more isolated of the two, which is the real reason to prefer it.
sclang is started with a generated `sclang_conf.yaml` that excludes SuperCollider's default
search paths, so it compiles *only* the private copy's class library and poptart's own
`~/.poptart/sc/Extensions` folder. A broken extension in your SuperCollider user folder, a
plugin-hosting extension that doesn't match your SC version, or a stale `sclang` symlink on
your `PATH` cannot affect it — those entries in Troubleshooting below simply stop applying.

One thing it does **not** change: sclang still runs your personal `startup.scd` before poptart's
engine script, because SuperCollider derives that path from your home directory and no config
file overrides it. A startup file that hangs still hangs the boot (see Troubleshooting).

**Which one is in use?** `npm run doctor` prints every resolved path, the generated config, what
is in the Extensions folder, and what sclang itself reports once booted with it:

```sh
npm run doctor                      # to the terminal
npm run doctor -- --out doctor.txt  # to a file, for pasting into a bug report
```

The order poptart resolves in: `POPTART_SCLANG` → the private copy → `sclang` on your `PATH` →
the standard install location for your platform.

## Troubleshooting

**"engine did not finish booting."** The error message includes the last lines
of SuperCollider's own log plus a diagnosis — read that first; it names the actual cause. Then
run `npm run doctor -- --out doctor.txt`, which gathers every path, the class-library config and
sclang's own report into one file.

Several of the causes below are about poptart sharing SuperCollider with the rest of your
machine. If you let poptart fetch its own copy (see
[Where SuperCollider comes from](#where-supercollider-comes-from)) they stop applying — the
symlink, the broken extension and the version-mismatch entries all become impossible. The usual
suspects:

- **Orphaned processes from an earlier run** holding poptart's ports or the audio device:
  `pkill -f sclang; pkill -f scsynth`, then retry. (Also quit the SuperCollider IDE if open.)
- **A leftover `sclang` symlink on your `PATH`** from a manual install. A symlinked `sclang`
  can't find its class library and fails to compile; poptart finds the real binary by itself,
  so the symlink only gets in the way. Check for one:
  ```sh
  which -a sclang            # lists every sclang on your PATH (poptart needs none of them)
  ls -l "$(which sclang)"    # a symlink shows an arrow: /opt/homebrew/bin/sclang -> /Applications/SuperCollider.app/...
  ```
  If the `ls -l` line contains a `->`, it's a symlink — delete it (only removes the link, not
  the real app):
  ```sh
  rm "$(which sclang)"       # add sudo if it lives in /usr/local/bin or /opt/homebrew/bin and rm reports "Permission denied"
  ```
  Repeat `which -a sclang` until it prints nothing, then retry poptart.
- **The plugin-hosting extension didn't install.** SuperCollider hosts VST plugins through an
  extension called VSTPlugin, which poptart downloads (pinned, checksum-verified) and puts in
  place by itself on first run — you should never have to think about it. If that step failed,
  the setup report at startup says so and names the folder it wanted. To do it by hand: it is a
  compiled binary extension, *not* a Quark. On macOS take the zip from
  [poptart's vstplugin fork](https://github.com/glossings/vstplugin/releases) (upstream v0.6.2
  plus fixes for a probe crash that made some plugins vanish from the scan); elsewhere from
  <https://git.iem.at/pd/vstplugin/-/releases>. Unzip its `sc/VSTPlugin` folder into the
  Extensions directory poptart is using — `~/.poptart/sc/Extensions/` with poptart's own
  SuperCollider (the only one that counts then; your SuperCollider user folder is not read at
  all), otherwise your SuperCollider user Extensions folder (on macOS,
  `~/Library/Application Support/SuperCollider/Extensions/`). `npm run doctor` prints which.
- **Broken files in `~/Library/Application Support/SuperCollider/`** (a half-installed
  extension, a bad `startup.scd`) left over from other SuperCollider projects. In the error's
  sclang output, look for lines starting with `ERROR:` or `WARNING:` — especially
  `duplicate Class found`, `Class not defined`, or `Library has not been compiled
  successfully` — and for any file path under `.../SuperCollider/Extensions/`. That path is the
  culprit. Move the offending extension out and retry:
  ```sh
  # back the whole Extensions folder out of the way
  mv ~/Library/Application\ Support/SuperCollider/Extensions ~/Desktop/sc-extensions-backup
  ```
  then start poptart again — it notices its plugin-hosting extension went with the folder and
  reinstalls it into a fresh `Extensions/` by itself. Reinstalling SuperCollider does **not**
  help: the installer never touches this user directory, so the broken file survives. (Or
  sidestep the whole category: with poptart's own SuperCollider this folder is never read.)
- **The log has no `ERROR:` at all — it just stops.** The `poptart:` checkpoint lines say how
  far boot got, and the diagnosis reads them for you. The three cases:
  - *Nothing after the `Welcome to SuperCollider` banner*: sclang runs your personal
    `~/Library/Application Support/SuperCollider/startup.scd` **before** poptart's engine
    script, so a startup file that boots a server or opens a window hangs there forever. Move
    it aside (`mv ~/Library/Application\ Support/SuperCollider/startup.scd ~/Desktop/`) and
    retry.
  - *Nothing after `poptart: booting scsynth (…)`*: macOS blocked the audio server from
    starting. Launch SuperCollider.app once by hand (right-click it in `/Applications`, choose
    **Open**) so Gatekeeper approves it, and check **System Settings → Privacy & Security →
    Microphone** for a pending prompt for your terminal. Then retry.
  - *Some device output but never `server booted, ready`*: the audio device is wedged or
    misreporting. Pick a different output device in the settings tab — or replay poptart's
    exact boot config in the SuperCollider IDE, where the device's real complaint is visible
    instead of swallowed by the timeout. Copy the values from the error's `boot config` note:
    ```supercollider
    s.options.sampleRate = 48000;            // "sr"
    s.options.blockSize = 256;               // "block"
    s.options.numOutputBusChannels = 2;      // "out: Nch"
    s.options.numInputBusChannels = 0;       // "in: Nch"
    // only if boot config names a device (not "system default"):
    // s.options.inDevice = s.options.outDevice = "That Device Name";
    s.boot;
    ```
    If a plain `s.boot` in a fresh IDE session works but this doesn't, re-add the options one
    at a time — whichever one breaks the boot is what your hardware rejects (and worth
    reporting as a poptart issue: forced 48 kHz on a rate-locked device is the usual one).

**The plugin scan never finishes, or the engine dies during it.** Everything the engine prints
is also written to `~/.poptart/engine.log` (the previous run is kept as `engine.log.1`), which
is the first thing to read and what `npm run doctor` attaches. If the audio server dies mid-scan
poptart now says so, names the plugin it was probing, and skips that one on the next start.
Note that SuperCollider reports a crashed server as `exited with exit code 0` — that is not
evidence of a clean exit.

**The engine was fine, then every track went silent.** If `scsynth` dies mid-session nothing
restarts it yet — the UI keeps saying "engine ready" while notes go nowhere. The terminal and
`~/.poptart/engine.log` do say it: look for `Server 'poptart' exited`, and for a
`[poptart] restarting the engine: …` line before it — if there is none, poptart did not ask for
this and something killed the server. Re-pick the output
device in the settings tab (any device change restarts the engine), or restart `npm run dev`.
