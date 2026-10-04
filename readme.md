# ✶ SIGIL — a desire engine

A single-page, serverless, dependency-free generative audio/visual instrument.

You write a desire. SIGIL strikes out its vowels and repeated letters in the manner of
Austin Osman Spare (later popularised by Grant Morrison), hashes what remains with
SHA-256, and uses that hash to draw a **sigil** and to compose a **song** — where the
sigil *is* the score. The line and the note are one gesture.

Nothing you type ever leaves the page. There is no server, no build step, no
dependency, and no network request. Open the file and it runs.

---

## Table of contents

- [Quick start](#quick-start)
- [The rite](#the-rite)
- [How a line becomes music](#how-a-line-becomes-music)
- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Sharing & privacy](#sharing--privacy)
- [Architecture](#architecture)
- [Extending SIGIL: the Hooks API](#extending-sigil-the-hooks-api)
- [Writing a module](#writing-a-module)
- [Determinism contract](#determinism-contract)
- [Browser support](#browser-support)
- [Contributing](#contributing)
- [Licence & lineage](#licence--lineage)

---

## Quick start

```bash
git clone https://github.com/<you>/sigil.git
cd sigil
# any static server; file:// also works, but a server is recommended
python3 -m http.server 8080
# open http://localhost:8080
```

There is **no build step**. The scripts are plain classic `<script>` tags loaded in a
fixed order. Edit a file, reload the page.

> **Why no `crypto.subtle`?** It is unavailable in non-secure contexts, which would
> break `file://` usage in some browsers. SIGIL ships its own synchronous SHA-256
> (derived from prime roots at startup, with a self-test) so that "self-contained"
> actually means self-contained.

**First use:** type something in the present tense — *"It is my will to finish the
book"* — and press **Cast**. Audio is created inside the click handler to satisfy
browser autoplay policies.

---

## The rite

The app is a small state machine with four modes:

```
idle ──cast──► reducing ──► playing ⇄ charging
                               │
                               └── forget ──► burning ──► idle
```

1. **Invocation.** Type the desire. Optionally join up to two more desires (Fusion).
2. **Reduction.** Vowels and repeated letters are struck out on screen, each strike
   ticking like a quill. The surviving consonants are then lit one at a time, each
   sounding a bell tuned to the note it will occupy in the song.
3. **Inscription / performance.** The sigil is drawn by a pen clocked by the audio
   hardware. Seven sections unfold; each applies a different geometric transform,
   and the music transforms with it.
4. **Charge.** Fullscreen gnosis mode: all interface dissolves, the sigil centres
   and enlarges, and a breathing ring pulses on an 8-beat cycle.
5. **Banishing (Forget).** The lines break into embers and rise, a low-pass sweep
   and a crackling fire take the master bus down, the words are erased, the URL is
   cleared, and the sigil is removed from your grimoire. Forgetting means forgetting.

---

## How a line becomes music

The 21 consonants (`Y` counts as a consonant, so 21 = 3 × 7) are shuffled around a
wheel by a hash-seeded Fisher–Yates. Each letter also sits on one of three concentric
rings. Your reduced string traces a path between them.

```
pitch    = (displayed slot mod 7) + 7 × (ring − 1)     → scale degree
duration = length of the stroke leaving that node      → rhythm
legato   = the stroke arriving at the node is curved   → glide
```

Because pitch comes from *position*, the sigil's symmetries **are** the classical
melodic transformations:

| Geometry | Music |
|---|---|
| Rotation by *k* slots | Diatonic transposition by *k* mod 7 |
| Mirror (slot → −slot) | Melodic inversion about the tonic |
| Reversed path | Retrograde |
| Regular polygon at the hub | Euclidean rhythm E(k, n) |

The seven sections are exactly that list:

| № | Name | Transform |
|---|---|---|
| I | Invocation | identity, bells & drone only |
| II | Inscription | identity, the sigil as written |
| III | Exaltation | rotated *k*/21 — the melody rises a third/fourth/fifth |
| IV | Reflection | mirrored — the melody inverted |
| V | Reversal | retrograde, half-time |
| VI | Apotheosis | rotated again, every voice at once |
| VII | Banishing | identity, returning to silence |

**Harmony** is chosen *after* the melody, because the melody is the sigil and is
sacred. One chord per bar, via a Viterbi search over diatonic major/minor triads with
emission = fit to the bar's notes (weighted by duration and metric strength),
transition = preference for root motion by fourths/fifths, plus cadence bonuses and a
small hash-derived per-chord "personality".

---

## Features

### Core
- Deterministic sigil + song from any text (SHA-256 avalanche: one letter changes everything)
- Live Web Audio synthesis — **no samples**; three lead timbres (glass FM bell, reed, plucked koto), choir, pad, saturated bass, arpeggio, drone, synthesised drum kit, generated convolution reverb, tempo-synced dotted-eighth delay
- Canvas 2D renderer with additive "ember ink", motes, particle sparks, ghost transforms, Euclidean rhythm polygons
- Charge (fullscreen) mode with breath guide · Forget (banishing) with burn animation
- **Seal** export: 2048² PNG talisman · **Record**: canvas + master audio → WebM/MP4
- Share links that carry **only the consonants**, never the desire

### Modules
| Module | What it adds |
|---|---|
| **M1 Score · MIDI** | Multitrack GM Standard MIDI File (format 1, 480 PPQ) with tempo/key/time signature, section markers, chord text, letters as lyrics; plus a plain-text chord chart |
| **M2 Mixer & Tempo** | Per-bus faders, mute/solo, mix scenes, master + reverb send, 40–240 bpm with position-preserving tempo change, tap tempo, tempo lock (lengthens the form above 132 bpm) |
| **M3 Grimoire** | Local gallery of cast sigils (consonants only), generated thumbnails, replay, optional fade-after-N-days, JSON import/export |
| **M4 Form & Loop** | Section jump list, gapless section looping, keyboard navigation, loop band on the progress bar |
| **M5 Access** | Reduced motion, high contrast (wins over all palettes), larger text, screen-reader section announcements, `describe()` of the current sigil, progress bar as an ARIA slider |
| **M6 Moods** | Arrangement presets — Ritual, Ambient, Pulse, Lullaby, Dirge, Ecstatic — applied as `compose`/`plan` filters; re-composes live and resumes at the current section |
| **M7 Render & Export** | Offline faster-than-realtime render, **parallelised across CPU cores** with section-aligned cuts and crossfades, → WAV 16/24, MP3 (worker LAME), AAC (ADTS) and Opus (hand-written Ogg muxer) via WebCodecs |
| **M8 Fusion** | Up to three desires on one wheel as counterpoint; partners weigh into harmony at passing-tone strength |
| **M9 Live Lens** | Drag the wheel to transpose, double-tap to mirror — in real time, affecting melody, harmony, bass and arpeggios, and propagating to MIDI/audio export |
| **M10 Hours & Moon** | Planetary hours (true sunrise equation if you share location), moon phase, optional attunement of mode/timbre/tempo/palette to the hour, and timed charging sessions |

---

## Keyboard shortcuts

Press **?** for the in-app sheet.

| Key | Action |
|---|---|
| `Space` | Pause / resume |
| `C` | Charge mode |
| `Esc` | Leave charge · close panels |
| `T` | Tools drawer |
| `G` | Grimoire |
| `1`–`9` | Jump to section |
| `[` `]` | Previous / next section |
| `L` | Loop the current section |
| `B` | Tap tempo |
| `←` `→` | Lens: turn one step |
| `M` | Lens: mirror |
| `0` | Lens: reset |

---

## Sharing & privacy

- Nothing is transmitted. No analytics, no fonts, no CDN at runtime (the MP3 encoder
  falls back to a CDN **only** if you do not vendor `lame.min.js`).
- The URL fragment contains the reduced consonants and, optionally, a mood:
  `#KRSTVM+MNLP~ambient`. That is the *sigil*, not the desire behind it.
- The Grimoire stores consonant keys only, in `localStorage`, under the `sigil.*`
  namespace. **Forget** deletes the entry.

---

## Architecture

```
index.html
└── styles/core.css, styles/ui-kit.css
└── src/core/00-utils → 08-app      (load in order; they define globals)
└── src/ui/ui-kit.js                 (defines UI)
└── src/modules/m1 … m10             (self-registering IIFEs)
└── src/vendor/lame.min.js           (optional, for offline MP3)
```

| File | Section | Responsibility |
|---|---|---|
| `00-utils.js` | §0 | `$`, `wait`, `TAU`, `mod`, `clamp`, `lerp`, `ease`, `rgba`; **`Hooks`** event/filter bus; **`Prefs`** namespaced localStorage |
| `01-crypto.js` | §1 | Synchronous SHA-256 (constants derived from prime roots + self-test), `sfc32`, `mulberry32`, `Rng`, `stream(hash,label)` |
| `02-reduction.js` | §2 | `reduceDesire(text)` → struck/kept character fates + reduced string |
| `03-geometry.js` | §3 | `buildSigil`, wheel shuffle, ring assignment, Y collision repair, `polar`, `nodeXY`, `segmentPoints`, `tracePoints`, `polyLength`, `PALETTES` |
| `04-theory.js` | §4 | `MODES`, `degToMidi`, `mtof`, `fold`, `euclid` |
| `05-composer.js` | §5 | `makePlan`, `buildPhrase`, `addPassing`, `harmonize`, `padVoicing`, `bassPitch`, `arpTones`, drum/bass/arp bar emitters, **`composeSong`**, time-lookup helpers |
| `06-engine.js` | §6 | `Engine`: buses, FX, voices, lookahead scheduler, transport, ritual sounds |
| `07-renderer.js` | §7 | `Renderer`: frame composition, wheel, rhythm polygons, pen, particles, burn |
| `08-app.js` | §8 | `cast`, `performReduction`, HUD, controls, `exportSeal`, `toggleRecord`, `share`, `forget`, boot |

### Time model

- The score is a flat, sorted array of events measured in **beats**.
- `Engine.pump()` runs every 25 ms and books any event whose time falls inside a
  short horizon (0.18 s, or 1.6 s when the tab is hidden) onto the `AudioContext`
  clock.
- `Engine.beatNow()` converts context time back to beats, subtracting
  `outputLatency` so Bluetooth headphones do not desynchronise the drawing.
- The renderer never integrates its own time. It asks for the beat and draws that
  beat. Pause stops the pen; seek jumps the pen.

---

## Extending SIGIL: the Hooks API

```js
Hooks.on(name, fn, priority = 0)   // → unsubscribe()
Hooks.emit(name, ...args)
Hooks.filter(name, value, ...args) // listener returns replacement or undefined
```

Listeners run in ascending priority and are individually try/caught.

**Filters**

| Name | Value | Notes |
|---|---|---|
| `buildSigil` | `null` → sigil | Return a sigil object to take over construction (M8) |
| `compose` | config object | **Do not draw from the composer's `R`.** Use `stream(sigil.hash, 'your:label')` |
| `plan` | array of sections | Mutate in place or return a new array |
| `palette` | `{name,bg,line,accent}` | Contrast runs at priority 100 and wins |
| `meta` | `string[]` | HUD meta line parts |
| `shareKey` | string | URL fragment |
| `viewT` | `{phi, s}` | Compose your own rotation/mirror on top |

**Events**

`beforeCast(ctx)` · `cast(sigil, song, opts)` · `song(sigil, song, info)` ·
`buses(buses, engine)` · `section(sec, si, song)` · `drawPlaying(ctx)` ·
`stop(reason)` · `forget(sigil)` · `link({members, preset})`

`drawPlaying` receives `{ r, g, F, T, beat, song, sig, ph, pi, sec, si, kp, sp, lines, app }`.
Push your stroke point arrays into `lines` so that **Forget** burns them too.

---

## Writing a module

```js
/* M11 · EXAMPLE */
const Example = (() => {
  'use strict';
  const { h } = UI;

  // 1. Influence composition — draw randomness from your OWN stream.
  Hooks.on('compose', (cfg, sigil) => {
    const R = stream(sigil.hash, 'example');
    if (R.chance(0.5)) cfg.bpm += 4;
  });

  // 2. Draw on top of the performance.
  Hooks.on('drawPlaying', ({ r, F, beat, lines }) => {
    r.circle(F.cx, F.cy, F.R * 1.5, r.pal.accent, 0.1, false, 1);
  });

  // 3. Register a Tools panel.
  UI.section({ id: 'example', title: 'Example', order: 60, build(el) {
    el.append(UI.note('Hello.'), UI.button('Do it', () => toast('done', true)));
  }});

  // 4. Register a shortcut.
  UI.key('e', 'Do the example thing', () => {}, { group: 'Example' });

  return { /* public surface for other modules */ };
})();
```

Add the `<script src="src/modules/m11-example.js"></script>` **after** any module it
depends on.

### UI kit cheat-sheet

```js
UI.h(tag, attrs, ...kids)      // on* attrs become listeners
UI.css(text)                   // inject a stylesheet
UI.section({id,title,order,open,build})
UI.open(id?) / UI.close()
UI.slider / check / select / button / note
UI.key(keys, label, run, {group, display})
UI.announce(text)              // polite SR live region
UI.parseKey(str) / UI.formatKey({members,preset}) / UI.validMember(s)
UI.recompose()                 // rebuild the song in place, resume at section
UI.refreshPalette()
UI.whenReady(fn)               // after all module scripts have loaded
UI.fmt(seconds) / UI.fileKey()
```

---

## Determinism contract

This is the most important rule in the project.

1. **Never reorder, insert, or remove a random draw inside `composeSong`'s `R`
   stream.** Doing so changes every song that has ever been cast. The sequence is
   frozen by convention and by comment.
2. Feature code that needs randomness must open its own labelled stream:
   `stream(sigil.hash, 'mood:ambient')`.
3. Audio-side randomness (noise playback offsets, reverb IR) is seeded from the
   event's musical identity, not from wall-clock time. This is what makes M7's
   parallel offline render produce identical audio across segment boundaries.
4. `buildSigil` hashes `'SIGIL/v1::' + reduced`. If you ever need to change the
   geometry algorithm, bump to `v2` rather than silently mutating existing sigils.

---

## Browser support

| Feature | Requirement | Degrades to |
|---|---|---|
| Core audio/visual | Web Audio + Canvas 2D | — |
| Stereo panning | `createStereoPanner` | mono routing |
| Record | `MediaRecorder` + `captureStream` | toast: unsupported |
| Offline render | `OfflineAudioContext` | panel disabled |
| Parallel render | `OfflineAudioContext.suspend` | serial render |
| MP3 | Worker + LAME (vendored or CDN) | main-thread encode |
| AAC / Opus | WebCodecs `AudioEncoder` | hidden from the format list |
| Fullscreen charge | `requestFullscreen` | in-page charge mode |

Tested on current Chromium, Firefox and WebKit. iOS Safari: audio requires the
user gesture that `cast()` already provides.

---

## Contributing

- Keep it dependency-free at runtime.
- Keep it single-purpose per file and per module.
- Respect the determinism contract above.
- Comment *why*, not *what*. The codebase already documents intent heavily; match
  that register.
- Accessibility is not optional: new controls get labels, new state gets announced.

---

## Licence & lineage

Released under the MIT License (see `LICENSE`).

The method is Austin Osman Spare's, by way of *The Book of Pleasure* (1913) and
Grant Morrison's *Pop Magic!*. The Rose Cross lamen supplies the wheel. The
Euclidean rhythms follow Godfried Toussaint, *The Euclidean Algorithm Generates
Traditional Musical Rhythms* (2005). The SHA-256 implementation follows FIPS 180-4.

*Charge it. Then forget it.*