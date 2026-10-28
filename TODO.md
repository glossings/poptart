# poptart — TODO

Delete an entry when it's done. Details: TODO-verbose.md.

## Sound / mixing
[ ] Add setgain() song-level master gain; set each saved song by ear
[ ] Add LUFS metering to the ctrl+g console
[ ] Switch the mixer analyzer to RMS and a true windowed correlation
[ ] Bypass the 30 ms ramp for stepped plugin params (`stepped` in mappings)
[ ] Find the crunchy click on re-eval during playback

## Patterns / language
[ ] Add `smooth(t)`
[ ] Add `env(source)` envelope follower
[ ] Add `read("label")`
[ ] Add `count()`
[ ] Add `rot(n)`
[ ] Add `mutate()` for presets and patterns
[ ] Keep children's note channels through selector joins (cat etc.)
[ ] Add Roman-numeral chords (`chord("<I vi IV V7>")`) - parked
[ ] Add next-chord suggestions (harmony phase 5)
[ ] Add cascara to rhythmize
[ ] Support multi-cycle grooves
[ ] Make the groove depth drag live
[ ] Add a groove extraction offset

## Plugins / presets
[ ] Add preset morph
[ ] Host MIDI-FX plugins (`.midifx()`)
[ ] Patch pinned preset blobs (wavetables, mod matrix)
[ ] Resolve plugin names on demand
[ ] Show plugin files in the browser before they're probed
[ ] Pause the plugin scan while playing
[ ] Save scan progress per plugin (fork change)
[ ] Ship the fork fix for multi-plugin bundles
[ ] Report the non-plugin-file crash upstream

## Native devices (desktop)
[ ] Live figures: decide the EQ analyzer budget; reports for Chorus, Flanger, Phaser, Compressor, Limiter, Multiband, Ducker
[ ] Audio-rate lfo/cc/polled controls
[ ] Play-test devices in a live engine
[ ] Build for Windows/Linux

## Desktop engine
[ ] Cut sclang out: Node talks to scsynth directly (notes/params, then bookkeeping, SynthDef writer, VST control)
[ ] Windows MIDI without sclang (timestamped clock out, as CoreMIDI does on macOS)

## DJ / songs
[ ] Self-gate the song player at EOF
[ ] Evict the song decode cache
[ ] Allow complete-mix with a song-only deck b
[ ] Add song decks to the per-stem gate list
[ ] Calibrate platter bend against a reference player
[ ] Mix MIDI-learn phase 2 (stem faders, buttons, map panel)
[ ] Keylock latency option: uniform latency across decks (only if needed)

## Editor / UI
[ ] Remember small UI state across launches
[ ] Alt+drag scrubbing of literals
[ ] Reach the diagnostic report off macOS
[ ] Restart scsynth when it dies mid-session

## Samples
[ ] Evict unused sample packs (LRU)
[ ] Add `.warp()` with per-file warp markers
[ ] Synthesize a second drum kit

## Sync / platforms
[ ] Follow external MIDI clock
[ ] Build keylock on Linux/Windows
[ ] Build Link on Linux/Windows
[ ] Bonjour on Linux/Windows
[ ] Swap Rubber Band for Signalsmith Stretch

## Web
[ ] Zip export with audio
[ ] Grain scheduling in a worklet
[ ] FAUST devices (check license per function)
[ ] Resonate track audio through Rings/Elements
[ ] Vocoder
[ ] Move the host behind a message boundary
[ ] Plugins (local engine mode / WAM)
[ ] Sample map
[ ] Headphone cue
[ ] Link bridge
[ ] OSC bridge
