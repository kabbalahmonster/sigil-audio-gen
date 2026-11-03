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
- [Render & Export](#render--export)
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
   hardware. The sections of the chosen rite unfold (seven, in the Sevenfold; see
   *Rites* below); each applies a different geometric transform, and the music
   transforms with it.
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

**Rites.** That is the Sevenfold, the rite SIGIL has always performed, and it is still
the default. It is one answer to a question that has others: *in what order, and at
what weight, are the sigil's symmetries performed?* A rite (`05g-rite.js`, M22) is
another answer: another form, shorter or longer, built from the same three moves
(turn, mirror, retrace) and nothing else, so every rite is the same sigil and the same
music, differently unfolded. The forms are taken from ritual formulae that are
themselves sequences, and each is read for its *shape*: what repeats, what returns,
where the height is, how it ends.

| Rite | After | Phrases | Its shape |
|---|---|---|---|
| **Sevenfold** | SIGIL's own | 12 | Two heights, a dark reversal between them, a banishing |
| **Charge** | the barest sigil working (Spare) | 4 | Stated, held, let go |
| **Five Seasons** | the Discordian year | 5 | Five sections of one phrase; the height in the middle |
| **I·A·O** | Isis, Apophis, Osiris (Golden Dawn, Crowley) | 6 | As written, undone, exalted; **ends at its height**, struck once |
| **Death Posture** | Spare, *The Book of Pleasure* | 6 | Falls to a silence in which the path is traced but not sung; then the Flash |
| **Four Adorations** | Crowley, *Liber Resh* | 7 | Dawn, noon, sunset, midnight: an early height and a long going-down |
| **S.P.L.I.F.F.** | Phil Hine, *Condensed Chaos* | 8 | Statement, Pathways, Link, Intense gnosis, Fire, Forget |
| **Lesser Pentagram** | the Golden Dawn's pentagram ritual | 8 | A frame. The four quarters are the four forms of a melody: as written, mirrored, retraced, both |
| **Cone of Power** | the witches' circle | 8 | Only ever rises, a seventh of the wheel each round; **ends struck** |
| **Seven Gates** | the Descent of Inanna | 8 | Begins at its height; something is taken at each gate; seven sevenths are one whole turn |
| **Mantra** | japa; *Liber Null* | 8 | One phrase, never transformed; each round another voice has it |
| **Great Work** | the alchemists' four colours | 9 | Heard broken down first; as written only third; then exalted |
| **Conjuration** | the Goetia | 9 | Three calls, each a step higher; the answer; the charge; the licence to depart, retraced |
| **Eight Rays** | Carroll, *Liber Kaos* | 9 | The eight forms a melody has, each once: variations |
| **Servitor** | chaos magick's servitors (Hine) | 10 | A rondo: the name returns as written, each time with more voices |
| **Gnostic Pentagram** | Carroll, *Liber Kaos* | 12 | A palindrome: down a step at a time, the pentagrams, back up retraced |
| **Mass** | Crowley, *Liber XV* | 16 | The long ceremony, with a litany of versicle and response |
| **Abramelin** | *The Sacred Magic of Abramelin* | 17 | A long plateau of prayer, a vigil, one apex, a dark binding |
| **Bornless One** | the Bornless Ritual (PGM V; *Liber Samekh*) | 19 | Verse and refrain: five invocations, each answered by the same charge |

A phrase is four bars (the sigil traced once), so these run from under a minute to
about four at the sigil's own tempo (slower or faster as the mood and style have it).
Nothing here claims to *be* the rite it is named for; each rite's tab says where its
form is from.

What keeps any rite one piece of music with any mood and style:

- **Every section stands for one of the Sevenfold's seven** (its *role*: an opening, a
  plain statement, a lift, a turn, the dark half-time one, the crown, a close). Moods
  and styles already know what to make of those seven, and dress a rite's sections by
  role, so a Lullaby is hushed in every rite, an Ambient rite drumless, and in EDM
  Apophis is the breakdown and Osiris the drop.
- **A rite only ever takes away.** After the mood and the style have spoken, a rite may
  cap a level or silence a voice where its shape needs it (Vacuity stays empty in any
  mood; the Seven Gates never rise; the Cone never falls). It never adds above what the
  mood allowed.
- **Harmony and cadence are the composer's.** Each phrase is harmonised as it always
  was; a section may leave its last phrase open for the next to answer, and every rite
  ends on the tonic.
- **Two endings.** Most rites close as the Sevenfold does, bells over a held chord. A
  rite that ends at its height is *struck*: the whole band on the last bar-line (sized
  by the level the mood left, so a hushed mood ends on a soft foot), then its ring.

Choose **By the sigil** and the sigil draws its own rite from its own streams; the link
then names the rite it drew.

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

**Flow.** A rite has an opening (the Invocation: a few bells and a drone), a body, and an ending (the
Banishing: the line returns to silence, a last bell, the hall left to ring). Sung through whole, again and again, it
opens and ends every pass, and the seam between two passes is the end of a track, repeated. So the passes go round
the **body** (`05i-flow.js`, the DSP core's `passSpan`): the first begins at the start, with its opening; the last
plays through to the ending and rings out; every pass between is the body alone, the crown running into the verse
the way a chorus does. Nothing fades, because nothing has finished, and the end, when it comes, is an end. The same
on the stage, which goes round the body for ever (it never reaches its last pass, unless you walk into the ending
with the form list or the bar, and then it is played). And the layers **gather**: what Evolution asks for is held back
of the arpeggio, the choir and the drone at first (to a third of the arpeggio, at the most), and let go of over the
passes as the evolution settles; the last pass of a render has everything, and so does one pass alone. At Evolution
zero nothing is held back and every pass is the same. No note is changed: only the way round the rite, and how much of
it is there at first. Which stretch is the body is each rite's own: the Sevenfold's is its five middle sections; a rite
that ends at its height (I·A·O, the Cone of Power) holds its crown back for the end. *Flow between passes* (Render &
Export → More) turns it off, on the stage and in a render alike.

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

**Mood × Style × Element.** The sigil writes a melody and its chords; the rite (above)
is the form they take. Three more choices then decide how that is *performed*. Each
owns a different part of the answer, which is why any three can be combined, in any
rite, and still make one piece of music (`05f-style.js`, M6, M21):

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

### Who plays it: the palette

The sigil writes the notes; a **palette** decides who plays them (`05j-palette.js`, `sigil-voices.js`, M23).

- **Eight engines**, each a different *kind* of sound-making rather than another setting of the same one: **pluck** (a string: a Karplus–Strong loop with dispersion, a pick position, a body, a second string, a buzzing bridge), **modal** (a bank of resonators: the partials of a bar, a bowl, a bell, a skin, a gong, struck, rubbed or ratcheted), **analog** (band-limited saws, pulses and syncs, stacked and detuned, through a 24 dB filter), **organ** (nine drawbars and a rotating speaker, or a pipe with its chiff), **FM** (four operators, eight algorithms), **breath** (a blown pipe with its air, scoop and vibrato), **fold** (a west-coast sine, folded and gated by a vactrol) and **cloud** (grains). None of them uses a sample.
- **More than a hundred instruments** (115, and the cube's own eight), each one of those engines with its own numbers: a harp, a koto, a sitar, a kalimba, a tubular bell, a bowed singing bowl, a conga, a Moog bass, a reese, a tonewheel organ, an electric piano, a shakuhachi, a theremin, a shimmer of grains… and the cube's own eight, kept.
- **Twenty worlds**: a company of instruments that belong in one room, and the room (how big, how dark, how much of it): the **Temple** (bowls, bells, frame drums, a long drone), the **Glasshouse** (glass and tines, a wash of shimmer), the **Foundry** (a reese under a sync lead, an anvil), the **Meadow** (a nylon string, a flute, a shaker), **Neon**, **Tundra**, **Ember**, **Bazaar**, **Cathedral**, **Abyss**, **Toybox**, **Gamelan**, **Velvet**, **Storm**, **Dream**, **Tide**, **Circuit**, **Smoke**, **Hollow**, and the **Cube** itself. A song is in *one* world, so that it is one thing. A world also finishes the mix in its own colour, as offsets on the patch's own knobs (the Smoke's tape and dust, the Circuit's 8-bit crunch, the Dream's haze and echo), under any knob you set yourself.
- **What decides the world** is the sigil's own lot, leaned on by what the song asks for: a Dirge is not cast in the Toybox by accident, nor a Hymn in the Foundry, and Folk finds the Meadow. The listener has the last word: another deal (`◀ palette ▶`), any part's instrument by name, or the cube's own voices.
- **Two players in one world.** Every instrument's numbers are nudged by the sigil, within what that instrument can bear: a harp a little brighter, a bowl a little longer.
- **It moves.** The engines read the same section row the cube's voices do (brightness, wave position, width, sweep, drift, sub, breath, throat, ring, chorus), so every mover of Motion animates every instrument, and a render moves as the stage does.
- **The pool is looked after.** A voice that makes a number that is not one (it would be carried by its bus's filters for ever, and that whole part would be silent from then on, while the kit, on its own bus, played on) is found where it is made, put right and let go (the Engine panel counts them). When there are more notes than voices, the ones that go first are the tails that are only ringing out, then the ornaments (arpeggio, chords, bells, the kit's colour), then the lead parts; pads and drones, which hold the music up, go last. The stage's default is 64 voices (40 on a machine with two cores).
- **Each part is as loud as the voice it replaces** (`tools/calibrate-voices.mjs` measured them, K-weighted, in real songs), so the mixer, the master and the faders still mean what they meant.

### Fills

At the end of a phrase the kit does something. Where the music is going (a rise, a fall, a turn, a dissolve), how loud the section is, the idiom of the kit and the style choose *which* of a dozen figures (`05k-fills.js`): **recite** (the sigil's name, said on the kit: still the most likely single choice), **cascade**, **roll**, **flams**, **stutter**, **tumble** (a Euclidean figure over the toms and hand-drums, ending on a stroke), **stop-time**, **hat sweep**, **clave**, **gallop**, **claps**, **flutter**; and, two steps wide, a pair of toms, a flam, kick–snare, hand-drums, side-sticks or an open hat. The choice is stateless noise keyed by where the bar falls, so it is the same every render, and the Fills slider (a threshold on the *width* of a fill) never re-deals the ones that stay. Hand-drums are a kind of stroke of their own (`perc`), played by the world's percussion instrument, or as high toms by the cube's kit.

**The turnaround.** A pass that is followed by another does not end at the body's end, it *turns*: the kit's last bar is a fill into the body's start (and a crash lands on it, if the body comes round to something bigger), where the last pass, which ends, keeps the ending's own bar. The rows are marked in the plan and the core plays the right ones on each pass, on the stage and in every render alike.

With None and Aether chosen, none of this runs and the song is, event for event, what it
was. **Cast lots** (`Y`) draws a mood, a style and an element at random (it leaves the
rite alone; with Shift held it draws a rite as well); the link then says which: `#KRSTVM~dirge.trap.water`, or with a rite,
`#KRSTVM~dirge.trap.water.gates`.

---

## Features

### Core
- Deterministic sigil + song from any text (SHA-256 avalanche: one letter changes everything)
- Live Web Audio synthesis — **no samples**; three lead timbres (glass FM bell, reed, plucked koto), choir, pad, saturated bass, arpeggio, drone, synthesised drum kit, generated convolution reverb, tempo-synced dotted-eighth delay
- **A palette of instruments**: the sigil is not sung by one instrument any more. Each is dealt a *world* (one of twenty: the Temple, the Glasshouse, the Foundry, the Meadow …) and an instrument for every part of the song, from more than a hundred: plucked strings, struck bars and bowls, analog and FM synthesisers, organs, blown pipes, folded waves, clouds of grains, hand-drums. Two sigils in one world are still two players. The wavetable cube is one more of them, and "the cube's own voices" is a switch
- **Fills with a vocabulary**: a drummer's dozen instead of one trick (the sigil's name said on the kit is one of them): tom cascades, accelerating rolls, flams, double-kick runs, hand-drum tumbles, stop-time, hat sweeps, claves, gallops, claps, ghost flutters. Which is chosen follows where the music is going. When a performance goes round its body, the last bar of every pass turns into the next
- **Nineteen rites**: the Sevenfold and eighteen other forms, from four phrases to nineteen, each taken from a ritual formula (Spare's sigil working, the pentagram ritual, I·A·O, the Goetia's conjurations, the seven gates…) and each built from the sigil's own symmetries
- **Mastered output**: every rite is listened to, then levelled, de-noised, toned and set to a loudness target under a true-peak ceiling, identically on the stage and in a render
- **Render & Export**: the full track and each of its stems, in WAV, FLAC, MP3, AAC or Opus, delivered for where it is going (streaming, a PA, a club, broadcast), measured, tagged and checked
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
| **M4 Form & Loop** | Section jump list (of whichever rite is being performed, and where that rite is from), gapless section looping, keyboard navigation, loop band on the progress bar |
| **M5 Access** | Reduced motion, high contrast (wins over all palettes), larger text, screen-reader section announcements, `describe()` of the current sigil, progress bar as an ARIA slider |
| **M6 Moods** | Twenty-eight arrangement presets (Ritual, Ambient, Pulse, Lullaby, Dirge, Ecstatic … Triumph, Reverie, Wrath, Longing, Mischief, Hymn, Dread, Storm), applied as `compose`/`plan` filters; re-composes live and resumes at the current section |
| **M7 Render & Export** | One panel for the full track and its stems, in every format, ready to hand over: see *Render & Export* below. Parallel across CPU cores; every render evolves, by the Evolution set in Motion; destinations (Streaming, PA · Live, Club, Broadcast, Archive, Quick share); a queue with progress, cancel, audition and download per file, and a ZIP |
| **M8 Fusion** | Up to three desires on one wheel as counterpoint; partners weigh into harmony at passing-tone strength |
| **M9 Live Lens** | Drag the wheel to transpose, double-tap to mirror — in real time, affecting melody, harmony, bass and arpeggios, and propagating to MIDI/audio export |
| **M10 Hours & Moon** | Planetary hours (true sunrise equation if you share location), moon phase, optional attunement of mode/timbre/tempo/palette to the hour, and timed charging sessions |
| **M19 Motion** | The movers, shown and steered. A row per mover (its letter, what it moves and how, a live meter, a switch to hold it still); `◀ motion ▶` for another deal; **Motion** 0–200 % and **Evolution** 0–100 %, which governs the live loop and the passes of a render alike. In Sound & Patch each moved knob wears its letter, a band for the span it travels and a bead that travels it; on the wheel a ray grows at each moving letter |
| **M23 Palette** | Who plays the sigil: the world it was dealt and a chooser for the instrument of each part (lead, second voice, choir, bell, bass, arpeggio, pad, drone, chords, percussion), each with a button that plays its phrase in the song's key; `◀ palette ▶` for another deal; "the cube's own voices only" to go back to how a sigil always sounded. All of it is patch state: it is saved with the sound, carried in a shared link and rendered exactly as it is heard |
| **M22 Rites** | Eighteen rites beside the Sevenfold (see *Rites* above): a **Rite** tab in the chooser, with where each form is from and how long it is; **By the sigil** lets the sigil draw its own. The rite travels in the link and the Grimoire as the fourth word of the working; the Form panel and the screen-reader description name it. Changing the rite during a performance begins it again (the form is what changed) |
| **M21 Style & Element** | Nineteen styles and four elements laid over the mood (see *Mood × Style × Element* above), in one chooser on the invocation screen and in Tools: three tabs (M22 adds a fourth, the Rite), a line saying what the combination is, and **Cast lots** for a random three (with Shift held, a rite as well). The working travels in the link and the Grimoire as one word (`mood.style.element`, and `.rite` if it is not the Sevenfold); an element also recolours the wheel |
| **M20 Master** | The rite is listened to, then finished (see *Mastering* above). **Loudness** (−16 / −14 / −12 / −10 LUFS), **Balance** (how far the parts are drawn to the house balance), **Noise** (how much of the crusher's grain is let through: cleaner ↔ rawer ↔ exactly as composed), **Dynamics** (how far the quiet sections sit under the loud), `◀ finish ▶` for another deal of the chain's character and **Character** for how strongly it colours. Live meters (loudness now and so far, true peak against the ceiling, gain held back) and a plain account of what the plan did: each part's trim, each section's ride and grain, the EQ. One switch turns it all off, for comparing |
| **M15 Drum Engine** | How the kit plays: Sigil or Classic patterns, a hundred grooves per sigil (`◀ groove ▶`; the number travels in the share link), Variation / Fills / Ghosts / Humanise / Dynamics, sidechain ducking, and a bypass for the kit's own FX chain. The chain itself (drive → punch/body transient shaper → crusher → filter, with parallel compression, a room and a tempo-synced ping-pong echo beside the dry hit) runs in the DSP worklet; its `D·` knobs are in Sound & Patch, dealt per sigil and saved with the patch |

---

## Render & Export

One panel (Tools → **Render & Export**) renders the rite, whole or in parts, faster than real time and
exactly as the stage performs it: your mix, tempo and Live Lens, and every mover moving as it does live.
You choose four things, top to bottom, and the bar at the foot of the panel always says what you will get
(files, size, time) and holds the button.

| | |
|---|---|
| **What** | The **full track**, the **stems** (any of the eight parts), or both. Stems are parts of one mix, all the same length and all starting at zero; they leave *before* the master chain, so they can be mastered elsewhere. A part the rite does not sing is skipped, and marked before you ask |
| **How long** | Passes of the rite, with the running time of each choice. **Every render evolves**: the rite goes round, and each pass is further evolved than the last (Motion's *Evolution*, the same control and the same core as the loop on the stage; it is on this panel too). Pass 1 is the rite as written, so two passes, the default, is the rite and its evolution. The passes **flow** (see *Flow* above): the opening is heard once, at the start, and the ending once, at the end, with the body coming round again between, the arpeggio and the choir gathering as it does, and no fade anywhere in the middle. There is no separate "evolving" render |
| **Where it is going** | A destination sets the loudness, the true-peak ceiling, the format and the rate at once: **Streaming** (−14 LUFS, −1 dBTP, 24-bit 44.1 kHz WAV), **PA · Live** (−12, 48 kHz), **Club · Loud** (−9), **Broadcast** (−23, EBU R128), **Archive** (−18 LUFS, −3 dBTP, FLAC) and **Quick share** (−14, 256 kbps MP3). Any of them can then be moved |
| **In what** | **WAV** (16, 24 or 32-bit float), **FLAC** (16 or 24), **MP3**, **AAC** (M4A) and **Opus**; 44.1 to 96 kHz where the format takes it. *Every format can be asked of every item*: a stem may be an MP3 and the track a FLAC. A format the browser cannot write is shown, greyed, with the reason |

**What is done to the file on its way out** (`05h-deliver.js`; the master, `05e`, finishes the *sound*, this finishes the *file*):

- **One performance.** The job is compiled once for the whole run, so the track and every stem are the same
  events, the same lanes, the same passes. The master listens once, *through the passes* (the first four: by then
  a rite's evolution has settled), so the loudness it lands on is the file's, and the peak stems must fit under is
  the highest it heard.
- **Landing.** The plan was solved on a listening at 32 kHz. The file is measured again, at its own rate, as a
  BS.1770 meter would (integrated LUFS, range, true peak), and brought the last fraction of a decibel to the
  loudness asked for with one linear gain, never past the ceiling. (ffmpeg's EBU R128 meter agrees to a tenth.)
- **The end.** The dead air after the hall stops ringing is trimmed, and the last breath is glided to zero, over
  as long as what is still sounding asks: a file never ends on a step or on seconds of nothing.
- **Lossy headroom.** A lossy codec rings around a peak. A file to be encoded is mastered a decibel under its
  ceiling, then *decoded again* and its true peak measured; if it is over, it is encoded once more, lower.
- **Dither.** 16-bit files are dithered, flat (TPDF) or *shaped* out of the ears' most sensitive band, with a
  **seeded** generator: the same render is the same file, byte for byte. Digital silence stays silent; 24-bit is
  not dithered.
- **Stems.** All raised by one common gain (*Raised together*, the default: the mix they add up to peaks at
  −1.5 dBFS), so a stem is not a whisper in a DAW and the balance between them is still the mix's. Or *as mixed*
  (exactly as they enter the chain), or each *to full scale* (they then no longer add up).
- **Tags.** Title, artist, and the **tempo** and key of the sigil, written into the file (LIST/INFO, Vorbis
  comments, ID3v2.3, iTunes atoms), and into the file name: `sigil-KRSTVM-83bpm-Eb-Dorian-bass.wav`.
- **The report.** Each file says what it measures: loudness against the target, true peak against the ceiling,
  loudness range, and how much it loses if a system **sums it to mono** (on a PA, it matters).
- **Handing over.** One download, a ZIP of several (with a README of the tempo, key and how the files were
  made), or each on its own. Every file can be auditioned in the panel (the stage pauses while you listen) and
  downloaded singly; **Cancel** stops at any moment. Forgetting a sigil lets go of its files.

The loudness and ceiling here are *the render's*; the stage keeps the ones in the Master panel. Balance, noise,
dynamics and the finish are the sound, not the delivery, and are shared.

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
| `Y` | Cast lots: a random mood, style and element (`Shift`+`Y`: a rite as well) |

---

## Sharing & privacy

- Nothing is transmitted. No analytics, no fonts, no CDN at runtime (the MP3 encoder
  falls back to a CDN **only** if you do not vendor `lame.min.js`).
- The URL fragment contains the reduced consonants and, optionally, the working: what
  the rite is dressed in (a mood, a style, an element) and which rite it is:
  `#KRSTVM+MNLP~ambient`, `#KRSTVM~dirge.trap.water`, `#KRSTVM~ritual.none.aether.iao`.
  That is the *sigil*, not the desire behind it. A tuned sound (`#KRSTVM!…`) also carries who plays it: another deal of the palette, or the instruments you chose for each part (by id, which is why an instrument's id is for ever). A plain link is played by the palette the sigil is dealt.
- The Grimoire stores consonant keys only, in `localStorage`, under the `sigil.*`
  namespace. **Forget** deletes the entry.

---

## Architecture

```
index.html
└── styles/core.css, styles/ui-kit.css
└── src/core/00-utils → 08-app      (load in order; they define globals)
└── src/export/codecs.js             (the bytes of a file: WAV, FLAC, MP3, M4A, Opus, ZIP)
└── src/ui/ui-kit.js                 (defines UI)
└── src/dsp/sigil-dsp.js, sigil-voices.js   (the core, and the palette's eight engines)
└── src/modules/m1 … m23             (self-registering IIFEs)
└── src/vendor/lame.min.js           (optional, for offline MP3)
└── tools/voice-lab.mjs, calibrate-voices.mjs   (the palette, heard by a program: one note, a part of a song; and the gains that make every instrument as loud as the voice it replaces)
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
| `05g-rite.js` | §5g | `Rite`: the rites other than the Sevenfold (their sections, by role; where each is from), `open` (a rite's plan, before the moods, each section answering to its role's name) and `seal` (after the styles: the rite's holds, its length, each section's own id back), `own` (the rite a sigil draws for itself), `measure`. Pure |
| `05e-master.js` | §5e | `Mastering`: the master plan. `character` (the letters' finish), `solveA` / `solveB` (from the Probe's measurements to trims, caps, rides, EQ and gains), loudness arithmetic (`lufs`, `range`, `measure`), and the job plumbing the listening needs. Pure; loaded after the DSP core, whose tables it reads |
| `05h-deliver.js` | §5h | `Deliver`: what happens to a finished mix on its way into a file. Destinations, formats, the lossy margin, the end of a render (`tidy`), measurement (`analyse`, `judge`) and landing on a loudness (`land`), seeded dither (`quantise`), file names. Pure; loaded after the master, whose meter it uses |
| `export/codecs.js` | | `Codecs`: WAV, FLAC (written here: fixed predictors, Rice-coded, stereo decorrelated, MD5-signed), MP3 (LAME, in a worker), AAC in M4A and Opus in Ogg (the browser's encoders through WebCodecs, muxed here), ZIP, and the tags of each |
| `05j-palette.js` | §5j | `Palette`: the instruments (ids are for ever), the worlds, what a mood, a style and an element ask of them (`deal`), the listener's word over it (`cast`), and the core's table (`pack`, `resolve`). Pure |
| `05k-fills.js` | §5k | `Fills`: the figures of a fill, and which is chosen where (`choose`, `write`). Pure; called by the two kit writers (05c, 05f) and by `Flow.turn` |
| `dsp/sigil-voices.js` | | The palette's eight engines, registered with the core (`SigilDSP.registerVoice`): pluck, modal, analog, organ, DX, breath, fold, cloud |
| `05i-flow.js` | §5i | `Flow`: where the body of a rite is (`loop`: its opening heard once, its ending once, what the passes go round). Pure. What each pass then plays is the DSP core's (`SigilDSP.passSpan`) |
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
| `plan` | array of sections | Mutate in place or return a new array. Priorities: −30 a rite lays out its sections (M22) · 0 moods · +20 styles · +50 the mixer's long form · +60 the rite is sealed. Between −30 and +60 a section's `id` is its **role** (`intro`, `verse1`, `chorus1`, `verse2`, `bridge`, `chorus2`, `outro`), whatever the rite: dress by that name and you dress every rite. In the finished song `id` is the section's own and the role is `role` |
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

### Adding an instrument, a world, a figure

An **instrument** is a line in `05j-palette.js`: `def(id, 'key', 'Name', engine, { numbers }, { roles, tags })`. The numbers are the ones its engine has (the names are in `Palette.PARAMS`, the meanings beside the engine in `sigil-voices.js`); `roles` are the parts it can play; `tags` how it feels (bright, warm, organic, fierce, dreamy, sacred, eerie, playful), which is how a song's mood, idiom and element find it. **Take the next id and never change one that was used.** Then `npm run calibrate -- --only=key --write` to set its gain in each part (and `-- --verify` to see it is right), `npm run voices -- --only=key` to hear it in every part at every end of its range, and add it to the cast lists of the worlds it belongs in (at the end of a list if it should be rare, nearer the front if it should be common). A **world** is a `world(…)` line: its tags, who plays each part, and its room (`hall`, `space`, `finish`). A **figure** of a fill is a function in `05k-fills.js` that writes hits on a grid of sixteenths, and a weight for when it is wanted; both kit writers (and the turnaround) get it at once. A new **engine** is a `register(KIND.X, init, render)` in `sigil-voices.js` and a kind number appended in `sigil-dsp.js`: keep every bit of its state in the voice (the voices spec checks that the sound does not depend on where the 128-sample blocks fall), and allocate nothing per sample.

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

9. And rites. A rite draws nothing: its form is a table, dressed by the same filters as
   the Sevenfold. The composer's `R` is drawn from once per phrase and per bar as ever,
   so a rite's score is its own deterministic sequence, and **the Sevenfold's is
   untouched**: for it `Rite.open` returns nothing, the composer's own plan goes through,
   and none of the three things a rite may ask of the composer (an open cadence, a
   voice that is traced but not sung, a struck ending) is ever asked. The one draw is
   `Rite.own`: every rite draws a number against the sigil (`stream(hash, 'rite:<id>')`)
   and the highest takes it, so a rite added later changes the answer only for the sigils
   it wins. A link names the rite itself all the same, which is why **a rite's id is for
   ever**: add rites, never rename or remove one.

10. And flow. `Flow.loop` draws nothing and changes no note: the song is the song, and only the way round it differs
    (`SigilDSP.passSpan` says which beats a pass plays; the core, the page and every render worker ask the same
    function). The layers that gather are a function of (pass, passes, Evolution) alone. With no body, or Flow off,
    or Evolution at zero, the core plays what it always played, to the sample.

11. And so does a render's delivery. The dither is a seeded xorshift (`Deliver.prng`), the Ogg stream's serial is a
    function of the audio's length, and no encoder is given a clock or `Math.random()`: **the same render is the same
    file, byte for byte**. What a render hears is decided once (the job is compiled once for a whole run), and its loudness
    is measured on the file itself.

12. And the palette. `Palette.deal` draws from `stream(hash, 'palette')` (or `'palette:<n>'`) in a frozen order, and `Palette.pack` from
    `stream(hash, 'palette:<part>:<id>')`, one draw per number of an instrument whether it is nudged or not. Nothing touches the composer's `R` or
    the cube's stream, and with the palette off, or told not to (`compile(…, { palette: false })`), every row is the row it was. **Ids are for
    ever**: a link names an instrument by its id, and a world by its position. Add instruments and worlds at the end; never renumber or remove one.
    A note's variation is a function of where it falls in the music, not of a clock, and every engine's noise is an integer xorshift seeded from the
    event, so a note sounds the same wherever it is rendered from. The engines allocate nothing on the audio thread after a voice has been used once.

13. And fills. Which figure fills a bar is `Fills.choose` on stateless noise keyed by the bar and a channel of its own; nothing is drawn from a stream
    at all. The turnaround is a function of the song (`Flow.turn`), and the core picks the rows of each pass by flags in the plan, never by anything it
    has heard.

`npm run golden` pins all of the above. `npm run drums`, `npm run motion`,
`npm run style`, `npm run rite`, `npm run master`, `npm run flow`, `npm run deliver` and `npm run voices` check the invariants, and that with the kit's FX bypassed, Motion and
Evolution at zero and no master plan the engine is, to the sample, the engine before
any of this existed. `npm run master` also holds the meter to BS.1770 reference tones,
the limiter to its ceiling, and a finished render to the loudness it was asked for. `npm run deliver` checks the
last stretch: that every writer writes what a reader reads (FLAC decoded here, frame CRCs and MD5 checked; WAV, ZIP,
M4A, Ogg and ID3 parsed back, and ffmpeg asked to agree where it is installed), that dither is seeded, flat or shaped as
asked and silent where the signal is, that landing reaches the loudness without passing the ceiling, and that the
stems' common gain and the master's listening over all the passes of a render are what they say.
`npm run calibrate` measures every instrument in every part it can play against the cube's own voice of that part in real songs, K-weighted, and `-- --write` writes the gains into `05j-palette.js` (`--verify` measures again, `--refine` corrects what is there). `npm run voices` deals the palette to hundreds of sigils (every world is reached; a Dirge is not in the Toybox), checks that every instrument can play every part it is cast in, then **plays every instrument in every such part at both ends of the part's range and in the middle** (finite, bounded, not silent, ended, no click, the same twice, in tune where it is tonal), and a few against the cube's own voice in a real song; it also checks every figure of the fills, that a fill stays in its bar, and that the core plays the turnaround on the passes that turn and not on the last. `npm run style` composes every mood × style and style × element, checks that each idiom
is what it says (the strokes that make a style that style are where they should be) and
that the mood's contour survives every style. `npm run rite` composes every rite × mood
and rite × style, checks that each rite is the shape it says, that what is sung in every
section is the sigil's path under that section's transform, that the mood's word holds
in every rite, and that with the Sevenfold chosen the song is, event for event, the song
before rites existed.

---

## Browser support

| Feature | Requirement | Degrades to |
|---|---|---|
| Core audio/visual | Web Audio + Canvas 2D | — |
| Stereo panning | `createStereoPanner` | mono routing |
| Record | `MediaRecorder` + `captureStream` | toast: unsupported |
| Offline render | Web Workers (the DSP core) | panel says so |
| Parallel render | several Workers (`hardwareConcurrency`) | one Worker |
| WAV / FLAC / ZIP | written by `codecs.js`; nothing needed | — |
| MP3 | Worker + LAME (vendored or CDN) | main-thread encode |
| AAC / Opus | WebCodecs `AudioEncoder` | shown greyed, with the reason |
| Checking a lossy file | `decodeAudioData` of what was just encoded | the check is skipped |
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