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

**The kit** reads the sigil too (`05c-groove.js`, played by M15). It is not an
accompaniment laid under the melody but a second reading of the same figure:

| The sigil | The kit |
|---|---|
| The Euclidean polygons at the hub | The kick, hat and ghost patterns |
| The section's transform (turn, mirror, retrace) | The same transform, applied to those polygons. A turned kick is re-anchored on the downbeat, so turning it selects another *mode* of the same necklace |
| The letters, cycling one per sixteenth | Each hit's colour (its consonant class) and weight (its ring: outer letters are struck harder). A sigil of *n* letters phrases in *n* against 16, so unless *n* divides 16 the accents drift from bar to bar |
| The letters, in the section's order | The **fills**: at the end of a phrase the kit speaks the sigil. `B P` kick · `T K Q` snare (`F V H` a soft stroke) · `D G` and the liquids toms, pitched by ring · nasals the floor tom · sibilants hats. Backwards in the Reversal, inverted in the Reflection |
| Where the rite is going | How much is said: a rise is built into, a fall is let go of, the Banishing dissolves |

The toms are tuned to the root, fifth and octave of the chord they land on, so a fill
is always in key. The composer's original bars (one bar per section, repeated) remain
available as **Classic** in the Drum Engine panel, and are reproduced exactly.

**Motion.** A patch is a still photograph of a sound; the sigil's letters make it move
(`05d-motion.js`, shown and steered by M19). A handful of letters each take hold of one
parameter and move it in time:

| The sigil | The motion |
|---|---|
| What kind of consonant a letter is | What it moves. Liquids the **flow** (wave, layer, chorus, sweep, drift) · fricatives the **air** (bright, echo, breath, grit) · nasals the **body** (sub, throat, the kit's room and body) · plosives the **strike** (the kit's punch, drive, smash, echo, filter, level). So different sigils move different things |
| The letter's ring | How far: outer letters reach further |
| The way its stroke turns round the wheel | The way the knob turns |
| The pen, the breath, the phrase, the section, the rite | How it moves: nine gestures, every one a function of the beat (the pen's height and sway as it draws, the Charge ring's eight-beat breath, a swell per phrase, a climb per section, a gathering into each new section, a throw at each phrase's end…) |
| The rite coming round again | **Evolution.** Pass 1 is the rite as written. After it each mover leans further, turns into a second gesture it was dealt, lets its resting point drift, and two more letters wake |

There is one table of movers and one reader of it. The worklet, every offline render
job (full mix or stem) and the interface all ask the same pure function the same
question, *what is mover j doing at this beat of this pass?*, so a knob's bead is not a
picture of the automation but the automation itself, and a render moves exactly as the
stage did. **Motion** (how far), **Evolution** (how much each pass differs) and the
deal of movers are patch fields: saved per sigil, carried in a shared link.

**Mastering.** Nothing upstream of the output ever *heard* the song it made. A reed
lead could sit eight decibels under a koto one, a four-bit crusher could hiss as loud
as the music it coloured, and one rite could leave nine decibels louder than the next.
So a rite is **listened to before it is played** (`05e-master.js`; the listening is two
fast passes of the song in workers, done during the reduction ceremony, M20), and it is
finished to what was heard:

| What is heard | What is done about it |
|---|---|
| How loud each part is | A **trim** per part toward a house balance (never more than +4.5 / −6 dB). The kit is judged against the music it plays over, after its own chain |
| What each crusher's quantiser adds that is not the signal: its **grain** | A **cap** per section, so the grain stays a chosen distance under the music. Drive and fold are colour and are never capped; the dither rides the signal, so a dying tail is no longer turned into crackle |
| How far each section lies under the loudest | A **ride** per section: the quiet ones are set a little further under, so the arc of the rite opens; one that would be lost is brought back |
| The spectrum, in six bands | Four broad **EQ** moves, half of the way to a house tone (which is darker on top for a rite without a kit) |
| What kind of consonants the sigil is made of | The **finish**, the character of the chain: fricatives open the top, nasals let the low end through, liquids warm it and soften the glue, plosives slow the glue so the hit gets through |
| How loud the result leaves | The **make-up** that lands it on the loudness asked for (−14 LUFS unless you say otherwise), under a true-peak ceiling of −1 dBTP |

The chain is the last thing in the DSP core (§5d): sub-sonic high-pass → EQ → three
bands (towards mono below 160 Hz, width above), each held by its own slow compressor →
glue → a little saturation → make-up → soft clip → look-ahead limiter that also watches
the peaks *between* the samples. Every number in it comes from one small table, the
**master plan**, which is a pure function of the compiled song and the listener's
settings. The stage and every render are handed the same plan and run the same code, so
what you render is what you heard; stems take the plan's trims and caps and leave before
the chain, so that side by side they are the mix that entered it. Switched off, the mix
leaves exactly as it did before any of this existed.

**Mood × Style × Element.** The sigil writes a melody, its chords and a form. Three
choices then decide how that is *performed*. Each owns a different part of the answer,
which is why any three can be combined and still make one piece of music
(`05f-style.js`, M6, M21):

| | Decides | Never touches |
|---|---|---|
| **Mood** (28) | How it feels: the mode, the lean of the tempo, how much of the band plays in each section, where the faders sit | The idiom |
| **Style** (19) | The idiom it is played in: the tempo that idiom lives at, its swing, what a drummer of that idiom plays at each level of the mood's contour, what the bass does, how the chords are played (held, strummed, stabbed, chugged), how the lead is phrased, the sound such a band has | The melody, the chords, the form |
| **Element** (4) | What it is made of: brighter or darker, drier or wetter, heavier or lighter; the colours of the wheel | The notes |

*Styles:* Hip hop · Trap · Lo-fi · Pop · Punk · Grunge · Metal · EDM · House · Techno ·
Drum & bass · Synthwave · Funk · Reggae · Jazz · Bossa · Folk · Chiptune · Dembow (and
None). *Elements:* Fire · Water · Air · Earth (and Aether, the sigil's own matter).
*Moods:* the twenty there were, and Triumph · Reverie · Wrath · Longing · Mischief ·
Hymn · Dread · Storm.

The rules that keep every combination coherent:

- **Tempo.** The sigil deals 74–98 bpm. A style maps that span onto its own (a fast
  sigil is a fast punk song, a slow one a slow punk song) and the mood's lean is applied
  inside it, damped. Punk, metal, drum & bass and trap are *felt* at twice the written
  tempo: the band plays double-time under a melody that stays singable.
- **Contour.** The mood decides how intense each section is; the style decides what each
  level *means* in its idiom and may reshape the contour only inside the range the mood
  left. A Lullaby stays hushed in any style, an Ambient rite drumless, Pulse keeps its
  four on the floor.
- **Sound.** The sigil's own patch is drawn part of the way to the style's signature (two
  sigils in one style are still two sounds); what a mood sets outright it still sets; the
  element is laid over the result as a relative lean, so it is always heard. The style
  names the voices that suit it, the element puts them in its order, the sigil picks.
- **The sigil is still read.** A style's kit is built from the same Euclidean polygons,
  turned by the same section transforms, accented by the same letters, and its fills
  still speak the sigil. The style decides where a polygon's syncopation *may* fall; the
  sigil decides where it does.
- **Swing is applied to the whole score as one**, and to the pen's own timetable, so a
  shuffle swings the lead, the bass, the kit and the drawing together.

With None and Aether chosen, none of this runs and the song is, event for event, what it
was. **Cast lots** (`Y`) draws a mood, a style and an element at random; the link then
says which: `#KRSTVM~dirge.trap.water`.

---

## Features

### Core
- Deterministic sigil + song from any text (SHA-256 avalanche: one letter changes everything)
- Live Web Audio synthesis — **no samples**; three lead timbres (glass FM bell, reed, plucked koto), choir, pad, saturated bass, arpeggio, drone, synthesised drum kit, generated convolution reverb, tempo-synced dotted-eighth delay
- **Mastered output**: every rite is listened to, then levelled, de-noised, toned and set to a loudness target under a true-peak ceiling, identically on the stage and in a render
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
| **M6 Moods** | Twenty-eight arrangement presets (Ritual, Ambient, Pulse, Lullaby, Dirge, Ecstatic … Triumph, Reverie, Wrath, Longing, Mischief, Hymn, Dread, Storm), applied as `compose`/`plan` filters; re-composes live and resumes at the current section |
| **M7 Render & Export** | Offline faster-than-realtime render, **parallelised across CPU cores** with section-aligned cuts and crossfades, → WAV 16/24, MP3 (worker LAME), AAC (ADTS) and Opus (hand-written Ogg muxer) via WebCodecs. Every mover moves as it does on the stage; over more than one pass the rite evolves, by the Evolution set in Motion. The file leaves through the same master as the stage, by the same plan, and the status line says what it measures (LUFS, true peak, range) |
| **M8 Fusion** | Up to three desires on one wheel as counterpoint; partners weigh into harmony at passing-tone strength |
| **M9 Live Lens** | Drag the wheel to transpose, double-tap to mirror — in real time, affecting melody, harmony, bass and arpeggios, and propagating to MIDI/audio export |
| **M10 Hours & Moon** | Planetary hours (true sunrise equation if you share location), moon phase, optional attunement of mode/timbre/tempo/palette to the hour, and timed charging sessions |
| **M19 Motion** | The movers, shown and steered. A row per mover (its letter, what it moves and how, a live meter, a switch to hold it still); `◀ motion ▶` for another deal; **Motion** 0–200 % and **Evolution** 0–100 %, which governs the live loop and the passes of a render alike. In Sound & Patch each moved knob wears its letter, a band for the span it travels and a bead that travels it; on the wheel a ray grows at each moving letter |
| **M21 Style & Element** | Nineteen styles and four elements laid over the mood (see *Mood × Style × Element* above), in one chooser on the invocation screen and in Tools: three tabs, a line saying what the combination is, and **Cast lots** for a random three. The working travels in the link and the Grimoire as one word (`mood.style.element`); an element also recolours the wheel |
| **M20 Master** | The rite is listened to, then finished (see *Mastering* above). **Loudness** (−16 / −14 / −12 / −10 LUFS), **Balance** (how far the parts are drawn to the house balance), **Noise** (how much of the crusher's grain is let through: cleaner ↔ rawer ↔ exactly as composed), **Dynamics** (how far the quiet sections sit under the loud), `◀ finish ▶` for another deal of the chain's character and **Character** for how strongly it colours. Live meters (loudness now and so far, true peak against the ceiling, gain held back) and a plain account of what the plan did: each part's trim, each section's ride and grain, the EQ. One switch turns it all off, for comparing |
| **M15 Drum Engine** | How the kit plays: Sigil or Classic patterns, a hundred grooves per sigil (`◀ groove ▶`; the number travels in the share link), Variation / Fills / Ghosts / Humanise / Dynamics, sidechain ducking, and a bypass for the kit's own FX chain. The chain itself (drive → punch/body transient shaper → crusher → filter, with parallel compression, a room and a tempo-synced ping-pong echo beside the dry hit) runs in the DSP worklet; its `D·` knobs are in Sound & Patch, dealt per sigil and saved with the patch |

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
| `,` `.` | Previous / next groove |
| `Y` | Cast lots: a random mood, style and element |

---

## Sharing & privacy

- Nothing is transmitted. No analytics, no fonts, no CDN at runtime (the MP3 encoder
  falls back to a CDN **only** if you do not vendor `lame.min.js`).
- The URL fragment contains the reduced consonants and, optionally, what the rite is
  dressed in (a mood, a style, an element): `#KRSTVM+MNLP~ambient`,
  `#KRSTVM~dirge.trap.water`. That is the *sigil*, not the desire behind it.
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
| `05c-groove.js` | §5c | `Groove`: the drum part written from the sigil (polygons under each section's transform, letter accents, fills). Pure; `apply` / `restore` rewrite a song's kit in place |
| `05d-motion.js` | §5d | `Motion`: which letter moves which parameter (`deal`), the nine gestures, and the baked table of curves the core and the interface both read (`bake`). Pure |
| `05f-style.js` | §5f | `Style`: the nineteen idioms and four elements, and the rules by which they are laid over a mood: `compose` (tempo, swing, voicing, sound signature, faders, master hints), `plan` (the contour, inside the mood's range), the kit writer (through `Groove`'s `feel`), `parts` (bass, chords, arpeggio, phrasing, and the swing over everyone), `pitch` (so the Live Lens can turn what a style wrote). Pure |
| `05e-master.js` | §5e | `Mastering`: the master plan. `character` (the letters' finish), `solveA` / `solveB` (from the Probe's measurements to trims, caps, rides, EQ and gains), loudness arithmetic (`lufs`, `range`, `measure`), and the job plumbing the listening needs. Pure; loaded after the DSP core, whose tables it reads |
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
| `score` | array of events | The whole score, before it is sorted and indexed; second argument `{sigil, cfg, sections, phrases, total}`. Return a replacement array (M15 rewrites the kit's part here). **Do not draw from `R`** |
| `palette` | `{name,bg,line,accent}` | Contrast runs at priority 100 and wins |
| `meta` | `string[]` | HUD meta line parts |
| `shareKey` | string | URL fragment |
| `viewT` | `{phi, s}` | Compose your own rotation/mirror on top |

**Events**

`beforeCast(ctx)` · `cast(sigil, song, opts)` · `song(sigil, song, info)` ·
`buses(buses, engine)` · `section(sec, si, song)` · `drawPlaying(ctx)` ·
`stop(reason)` · `forget(sigil)` · `link({members, preset})` ·
`motion(engine)` (the engine holds a new table of movers; read `engine.auto`,
and ask `engine.motionNow()` what they are doing at the audible beat) ·
`compiled(engine, kind)` (the engine was just sent something that changes what will be
heard: `kind` is `'song'`, `'plan'`, `'sections'`, `'tempo'` or `'params'`. M20 listens
for it to work out the master plan anew; `engine.master` is the plan in force) ·
`master(engine, plan)` (a master plan was laid on, or taken away)

A mood may speak to the master from its `compose` filter, as it does to the drummer:
`cfg.master = { noise: +dB, tone: ×, level: ×, dynamics: ×, house: {part: dB}, lean: {…} }`
(more grain let through for a mood that *is* its crusher; less tonal correction for one
that is dark on purpose; a style moves the house balance so that its chords are a bed and
not an ornament). A style (`05f`) reads what the moods did at a later priority
(`compose` +20, `plan` +20, `score` +10), so a mood never needs to know which style is on.
A new style is one entry in `Style.STYLES` (a tempo span, a sound signature, a contour,
and three small functions of one bar: kit, bass, chords); a new element one entry in
`Style.ELEMENTS`. Both tables are append-only: their order is the order of the lots.

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
5. The drum part obeys the same contract on its own streams. `Groove.dna` draws from
   `stream(hash, 'groove')` (or `'groove:<take>'`) and `SoundDesign.drumFx` from
   `'drumfx'`, each in a frozen order; everything per bar and per hit is stateless
   noise keyed by musical position, so the panel's amounts are thresholds on a fixed
   field (more Fills adds fills, it does not reshuffle the song). The composer's `R`
   is never touched: with no `score` listener its output is bit-for-bit what it was.

6. Motion obeys it too. `Motion.deal` draws from `stream(hash, 'motion')` (or
   `'motion:<n>'`) in a frozen order; `Motion.bake` draws nothing. What a mover does is
   a pure function of (beat, pass) evaluated by `SigilDSP.autoPass` / `autoCurve` /
   `autoApply`, and **those three are the only place it is ever evaluated**: on the audio
   thread, in a render worker, and on the page. A note reads its patch at its own beat,
   never at its block's, so a sound cannot depend on where 128-sample boundaries fell.
   Do not add a second implementation "for the UI".

7. So does the master. `Mastering.character` draws from `stream(hash, 'master')` (or
   `'master:<n>'`) in a frozen order; everything else in a plan is arithmetic on
   measurements of a deterministic render, so the same song and settings give the same
   plan, number for number. **A plan is never worked out on the audio thread and never
   adapts while it plays**: the stage and a render are handed the same table, and the
   chain that reads it (DSP §5d) is the same code in the worklet and in a render worker.
   Nothing in the chain remembers more than a second, so a render cut into parallel
   segments has settled well inside each segment's pre-roll. Without a plan the core
   runs the code path it always ran, untouched.

8. And so do styles and elements. `Style.compose` draws from
   `stream(hash, 'style:<style>:<element>')` in a frozen order (a seed, who sings, which
   family of the cube); everything per bar is stateless noise keyed by musical position.
   The composer's `R` is never touched: a style re-plays the accompaniment in the
   `score` filter and leaves the melody, the chords and the form exactly as dealt. With
   None and Aether the layer does not run at all. The one thing that is NOT the sigil's
   is the lots, which only choose; the link records what was chosen.

`npm run golden` pins all of the above. `npm run drums`, `npm run motion`,
`npm run style` and `npm run master` check the invariants, and that with the kit's FX bypassed, Motion and
Evolution at zero and no master plan the engine is, to the sample, the engine before
any of this existed. `npm run master` also holds the meter to BS.1770 reference tones,
the limiter to its ceiling, and a finished render to the loudness it was asked for.
`npm run style` composes every mood × style and style × element, checks that each idiom
is what it says (the strokes that make a style that style are where they should be) and
that the mood's contour survives every style.

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