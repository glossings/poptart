# Setup, configuration & troubleshooting

The README covers the short path (`npm install`, `npm run dev`, open the page). This is everything
else about getting poptart running on a particular machine — where it looks for things, what you
can point elsewhere, and what to do when the engine won't boot.

## Configuration

Most things work out of the box; a few can be pointed elsewhere.

| What | Where | Default |
| --- | --- | --- |
| Sample library folder | **settings** tab, or `POPTART_SAMPLES_DIR` | `~/.poptart/samples` |
| Audio output device | **settings** tab | system default |
| Extra audio **inputs** (combined into one device, so `input()` can reach several interfaces) | **settings** tab | none |
| Plugin scan directories | `POPTART_VST_DIRS` (colon-separated) | `~/.poptart/plugins` if it exists, else the standard VST locations |
| Plugins to skip when scanning | `POPTART_VST_EXCLUDE` (colon-separated paths) | none |
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

Plugins are probed one at a time. Probing them in parallel is faster but has crashed the audio
server partway through a large scan, so it is off by default; set `POPTART_VST_PARALLEL=1` to
turn it on. Either way only plugins that are new or changed since the last scan get probed.

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

SuperCollider is the audio engine poptart plays through. There are two ways to have one, and
poptart is happy either way.

**Your own install** is the default. Install it however you like —
`brew install --cask supercollider` on macOS, the installer from
[supercollider.github.io](https://supercollider.github.io/downloads) on Windows, your package
manager on Linux — and poptart finds it.

**Or let poptart fetch its own copy.** If SuperCollider isn't installed, poptart offers to
download one for itself. Say yes and it lands in `~/.poptart/sc`, and that is the whole
footprint:

- Nothing is installed system-wide and no administrator password is needed, so this works on a
  locked-down or shared machine.
- An existing SuperCollider, and its IDE, are left completely alone.
- Uninstalling is `rm -rf ~/.poptart/sc`.
- It is a download of 139–250 MB, which is why poptart asks first rather than doing it quietly.
  Answer in advance with `POPTART_INSTALL_SC=1`, or refuse once and for all with `=0`. With no
  terminal to ask in — a service, an editor's integrated runner — the answer is no.

macOS and Windows only: SuperCollider publishes no official Linux binaries, so on Linux this is
not offered and the package manager is the way.

The private copy is more isolated than an ordinary install, which is the real reason to want
one. sclang is started with a generated `sclang_conf.yaml` that excludes SuperCollider's default
search paths, so it compiles *only* the private copy's class library and poptart's own
`~/.poptart/sc/Extensions` folder. A broken extension in your SuperCollider user folder, a
VSTPlugin build that doesn't match your SC version, or a stale `sclang` symlink on your `PATH`
cannot affect it — those entries in Troubleshooting below simply stop applying.

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

## Installing VSTPlugin by hand

On first run poptart detects that the VSTPlugin server extension is missing, downloads the pinned
build for your platform (checksum-verified), and unzips it into your SuperCollider `Extensions`
directory. On macOS the pinned build comes from
[poptart's vstplugin fork](https://github.com/glossings/vstplugin/releases), which is upstream
v0.6.2 plus a fix for a probe crash that made some plugins (Auto-Tune Pro, sforzando, Arturia V
Collection, …) vanish from the scan.

Should the auto-install fail: it's a compiled binary extension, *not* a Quark. Download the macOS
zip from the fork releases page (other platforms: <https://git.iem.at/pd/vstplugin/-/releases>)
and unzip its `sc/VSTPlugin` folder into the `Extensions` directory (on macOS,
`~/Library/Application Support/SuperCollider/Extensions/`).

If poptart is running its own SuperCollider, that directory is `~/.poptart/sc/Extensions/`
instead — and only that one counts, since the private copy does not read your SuperCollider
user folder at all. `npm run doctor` prints the directory it is actually using.

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
- **VSTPlugin missing** — see above; poptart warns at startup if it isn't in the standard
  Extensions folder.
- **Broken files in `~/Library/Application Support/SuperCollider/`** (a half-installed
  extension, a bad `startup.scd`) left over from other SuperCollider projects. In the error's
  sclang output, look for lines starting with `ERROR:` or `WARNING:` — especially
  `duplicate Class found`, `Class not defined`, or `Library has not been compiled
  successfully` — and for any file path under `.../SuperCollider/Extensions/`. That path is the
  culprit. Move the offending extension out and retry:
  ```sh
  # back the whole Extensions folder out of the way (keeps VSTPlugin too, so you'll re-add that)
  mv ~/Library/Application\ Support/SuperCollider/Extensions ~/Desktop/sc-extensions-backup
  ```
  then reinstall just VSTPlugin (see above) into a fresh `Extensions/` and retry. Reinstalling
  SuperCollider itself does **not** help — the installer never touches this user directory, so
  the broken file survives.
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

**The engine was fine, then every track went silent.** If `scsynth` dies mid-session nothing
restarts it yet — the UI keeps saying "engine ready" while notes go nowhere. Re-pick the output
device in the settings tab (any device change restarts the engine), or restart `npm run dev`.
