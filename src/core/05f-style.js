'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5f  STYLE & ELEMENT — the idiom the rite is played in, and what it is made of
        pure, deterministic, no audio context
   --------------------------------------------------------------------------
   A sigil writes a melody, its harmony and a form. Three things then decide
   how that is PERFORMED, and each owns a different part of the answer, which
   is why any three of them can be combined and still make one piece of music:

     MOOD (m6)      how it feels: the mode, how fast or slow it leans, how much
                    of the band plays in each section (the contour of the rite),
                    where the faders sit.
     STYLE (here)   the idiom it is played in: the tempo that idiom lives at,
                    its swing, what a drummer of that idiom plays at each level
                    of the mood's contour, what the bass does, how the chords
                    are played (held, strummed, stabbed, chugged), how the lead
                    is phrased, and the sound such a band has.
     ELEMENT (here) the matter it is made of: brighter or darker, drier or
                    wetter, heavier or lighter, and the colour of the wheel.

   HOW THEY MEET (the rules that keep any combination coherent)
     • The melody, the chords and the form are the sigil's and are never
       touched. A style re-plays the ACCOMPANIMENT: kit, bass, chords, arpeggio.
     • Tempo. The sigil deals 74–98 bpm; a style maps that span onto its own
       (so a fast sigil is a fast punk song and a slow one a slow punk song),
       and the mood's lean is then applied, damped, inside it.
     • Contour. The mood decides how intense each section is (0…3). The style
       decides what each level MEANS in its idiom, and may reshape the contour
       only inside the range the mood left it: a Lullaby stays hushed in any
       style, an Ambient rite stays drumless.
     • Sound. The sigil's own patch is drawn part of the way to the style's
       signature (SoundDesign.shape: two sigils in one style are still two
       sounds); what a mood sets outright it still sets; the element is laid
       over the result as a relative nudge, so it is always heard.
     • Who sings. The style names the voices that suit it, the element puts
       them in its own order of preference, the sigil chooses among the first.
     • The sigil is still read. A style's kit is built from the same Euclidean
       polygons, turned by the same section transforms, accented by the same
       letters, and its fills still speak the sigil (05c). The style decides
       where a polygon's syncopation may fall; the sigil decides where it does.

   WHAT THIS FILE PRODUCES
     compose()  cfg: tempo, swing, voicing, sound signature, levels, kit, master hints
     plan()     the contour, reshaped inside the mood's range
     kit        (through Groove's `feel`) the drum part
     parts()    the score: bass, chords, arpeggio and phrasing re-played; the
                whole score then swung or shuffled as one
     pitch()    the pitch of any note written here, for a chord (the Live Lens
                re-derives pitches through it)

   DETERMINISM. Nothing here draws from the composer's R. Choices come from
   stream(hash, 'style:<id>') / 'element:<id>' in a frozen order; everything per
   bar is stateless noise keyed by musical position (Groove.noise). With no
   style and no element, nothing in this file runs and the song is exactly what
   it was before the file existed.
   ══════════════════════════════════════════════════════════════════════════ */

const Style = (() => {
  'use strict';
  const G = Groove, CH = G.CH;
  const TPB = 24, BAR = 96;                       // ticks per beat and per bar: sixteenths, thirty-seconds and triplets all land on it
  const S = (step) => step * 6;                   // a sixteenth, in ticks
  const ID = { k: 0, m: 1, reverse: false };
  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

  /* ── §5f.1 TIME: swing and shuffle, laid over every part alike ─────────── */

  /**
   * Where a beat position falls once the feel is applied. `sh` (0…1) is shuffle: the off-beat
   * eighth moves from the half toward the two-thirds of its beat (1 = triplets). `sw` is the
   * composer's swing: within each eighth the second sixteenth is late by sw/4 of a beat.
   */
  function warp(x, sw, sh) {
    if (!(sw > 0) && !(sh > 0)) return x;
    const b = Math.floor(x);
    let y = x - b;
    if (sh > 0) { const k = 0.5 + sh / 6; y = y < 0.5 ? y * (k / 0.5) : k + (y - 0.5) * ((1 - k) / 0.5); }
    if (sw > 0) {
      const e = Math.floor(y * 2), g = y * 2 - e, k = 0.5 + sw * 0.5;
      y = (e + (g < 0.5 ? g * (k / 0.5) : k + (g - 0.5) * ((1 - k) / 0.5))) / 2;
    }
    return b + y;
  }

  /* ── §5f.2 PITCH: every note written here can be re-derived from its chord ─ */

  const ctxOf = (cfg) => {
    const scale = MODES[cfg.modeName] || MODES.Aeolian, leadBase = 57 + mod(cfg.tonicPc - 9, 12);
    return { scale, leadBase, bassBase: leadBase - 24 };
  };
  /** A bass note for chord c. Roles beyond the composer's three: third, seventh, low (an octave under), app (a step under the NEXT root). */
  function bassMidi(c, role, k, c2) {
    const { scale, bassBase: b } = k;
    if (role === 'third') return fold(degToMidi(c + 2, b, scale), b - 2, b + 12);
    if (role === 'seventh') return fold(degToMidi(c + 6, b, scale), b - 2, b + 12);
    if (role === 'low') return Math.max(24, bassPitch(c, 'root', b, scale) - (bassPitch(c, 'root', b, scale) - 12 >= b - 7 ? 12 : 0));
    if (role === 'app') { const r2 = bassPitch(c2 ?? c, 'root', b, scale); return fold(degToMidi((c2 ?? c) - 1, b, scale), r2 - 2, r2 + 9); }
    return bassPitch(c, role, b, scale);
  }
  /**
   * The tones of a chord as a band would voice them.
   *   power    root, fifth, octave: no third, so it can be driven hard
   *   triad    close position in the pad's own window
   *   seventh  third, fifth, seventh (and ninth): rootless, the bass has the root
   *   open     root, fifth, octave, third above: a strummed chord
   *   high     the triad an octave up: a skank, a stab
   */
  function chordTones(shape, c, k, ninth) {
    const { scale, leadBase: L } = k;
    const at = (d, lo) => fold(degToMidi(d, L, scale), lo, lo + 11);
    if (shape === 'power') { const r = at(c, L - 17); return [r, r + 7, r + 12]; }
    if (shape === 'open') { const r = at(c, L - 12); return [r, r + 7, r + 12, fold(degToMidi(c + 2, L, scale), r + 13, r + 24)]; }
    if (shape === 'seventh') {
      const t = [at(c + 2, L - 5), at(c + 4, L - 5), at(c + 6, L - 5)];
      if (ninth) t.push(at(c + 8, L - 5));
      return t.sort((a, b) => a - b);
    }
    if (shape === 'high') return [at(c, L + 2), at(c + 2, L + 2), at(c + 4, L + 2)].sort((a, b) => a - b);
    return [at(c, L - 7), at(c + 2, L - 7), at(c + 4, L - 7)].sort((a, b) => a - b);
  }
  /** A held chord (the pad) in a shape: the shape's tones over a low root. */
  function padMidis(shape, c, k, voicing) {
    if (shape === 'power') { const t = chordTones('power', c, k); return [t[0] - 12 >= 28 ? t[0] - 12 : t[0], t[0], t[1], t[2]].filter((m, i, a) => a.indexOf(m) === i); }
    return padVoicing(c, k.scale, k.leadBase, voicing || {});
  }
  /**
   * The pitch (or pitches) of an event this file wrote, for chord `c` (and, for an approach note,
   * the chord after it). The Live Lens calls this with the chord it has turned the event's to.
   */
  function pitch(ev, c, song, c2) {
    const k = { scale: song.scale, leadBase: song.leadBase, bassBase: song.bassBase };
    if (ev.type === 'bass') return bassMidi(c, ev.srole || ev.role, k, c2);
    if (ev.type === 'comp') return chordTones(ev.shape, c, k, ev.ninth)[ev.k] + (ev.add || 0);
    if (ev.type === 'arp') return arpTones(c, song.scale, song.leadBase)[ev.idx] + (ev.add || 0);
    if (ev.type === 'pad') return padMidis(ev.shape, c, k, song.voicing);
    return ev.midi;
  }

  /* ── §5f.3 ELEMENTS: what the rite is made of ──────────────────────────── */

  /**
   * mod      relative moves on the patch (SoundDesign.shape): ×mul, +add, at least min
   * voices   the lead voices in this element's order of preference; layers likewise (the cube's families)
   * levels   faders (multiplied with the mood's and the style's)
   * tempo    a lean on the tempo · swing: added · space: the hall's return · hall: its size and damping
   * lean     a lean on the master's finish (05e): air, weight, warmth, punch, glue, width
   * palette  the wheel's colours
   */
  const ELEMENTS = {
    aether: { label: 'Aether', blurb: 'The sigil’s own matter. Nothing is added to it.' },
    fire: {
      label: 'Fire', blurb: 'Driven, bright and close. The crusher’s drive is woken, the kit hits harder, the hall shrinks.',
      mod: { grit: { min: 0.4 }, drive: { add: 0.3 }, fold: { add: 0.08 }, bright: { mul: 1.15, add: 0.06 }, chorus: { mul: 0.7 },
        echo: { mul: 0.8 }, breath: { mul: 0.8 }, kPunch: { mul: 1.25 }, sSnap: { mul: 1.2 }, hTone: { mul: 1.12 },
        dDrive: { add: 0.2 }, dPunch: { add: 0.15 }, dSmash: { add: 0.1 } },
      voices: ['fm', 'wave', 'vox', 'bell', 'bow'], layers: [6, 3, 7, 2, 8, 0, 5, 1, 4],
      tempo: 1.04, space: 0.8, hall: { size: 0.8, damp: 0.05 }, lean: { punch: 0.5, air: 0.25, width: -0.2 },
      palette: { name: 'Pyre', bg: '#0d0604', line: [255, 226, 190], accent: [255, 98, 36] },
    },
    water: {
      label: 'Water', blurb: 'Flowing and deep. More chorus, more echo, a longer hall; the wave travels further in every note.',
      mod: { chorus: { add: 0.3 }, echo: { add: 0.2 }, sweep: { add: 0.25 }, drift: { add: 0.25 }, bright: { mul: 0.92 },
        drive: { mul: 0.5 }, breath: { mul: 1.1 }, hDecay: { mul: 1.25 }, kPunch: { mul: 0.85 }, sSnap: { mul: 0.9 },
        dRoom: { add: 0.15 }, dEcho: { add: 0.1 } },
      voices: ['vox', 'wave', 'bell', 'bow', 'fm'], layers: [1, 2, 0, 5, 8, 4, 6, 3, 7],
      tempo: 0.97, swing: 0.04, space: 1.35, hall: { size: 1.3, damp: -0.08 }, lean: { warmth: 0.5, width: 0.45, punch: -0.3 },
      palette: { name: 'Tide', bg: '#050a10', line: [196, 226, 246], accent: [64, 168, 230] },
    },
    air: {
      label: 'Air', blurb: 'Light, high and wide. Less sub, more breath and shimmer; the kit thins, the bells come forward.',
      mod: { bright: { mul: 1.12, add: 0.08 }, sub: { mul: 0.55 }, breath: { add: 0.2 }, tilt: { add: -0.2 }, density: { mul: 1.2 },
        echo: { add: 0.1 }, chorus: { add: 0.1 }, throat: { add: 0.2 }, kSub: { mul: 0.7 }, kDecay: { mul: 0.8 }, hTone: { mul: 1.25 },
        sTone: { mul: 1.15 }, drumX: { mul: 0.75 }, dRoom: { add: 0.08 } },
      voices: ['bell', 'fm', 'vox', 'wave', 'bow'], layers: [5, 1, 3, 0, 2, 8, 7, 6, 4],
      levels: { bass: 0.85, bell: 1.15, drone: 0.8, drums: 0.92 },
      space: 1.2, hall: { size: 1.15, damp: 0.1 }, lean: { air: 0.6, weight: -0.4, width: 0.3 },
      palette: { name: 'Zephyr', bg: '#090b0f', line: [228, 236, 248], accent: [246, 232, 170] },
    },
    earth: {
      label: 'Earth', blurb: 'Heavy, low and dry. More sub and body, a darker top, a bigger kit in a smaller room.',
      mod: { sub: { add: 0.3 }, bright: { mul: 0.8 }, tilt: { add: 0.25 }, throat: { add: -0.25 }, chorus: { mul: 0.6 }, echo: { mul: 0.6 },
        breath: { mul: 0.7 }, kSub: { mul: 1.3 }, kDecay: { mul: 1.25 }, sBody: { mul: 1.3 }, hTone: { mul: 0.8 }, drumX: { add: 0.2 },
        dBody: { add: 0.2 }, dSmash: { add: 0.15 } },
      voices: ['bow', 'vox', 'wave', 'bell', 'fm'], layers: [4, 0, 2, 1, 6, 7, 5, 8, 3],
      levels: { bass: 1.15, drone: 1.2, bell: 0.85 },
      tempo: 0.96, space: 0.7, hall: { size: 0.75, damp: -0.05 }, lean: { weight: 0.6, air: -0.3, glue: 0.3 },
      palette: { name: 'Loam', bg: '#0a0906', line: [226, 214, 184], accent: [150, 176, 88] },
    },
  };

  /* ── §5f.4 THE KIT: what a drummer of each idiom plays ─────────────────── */

  /* A kit is a function of one bar. It is handed B:
       I · half        the mood's level for this section (1…3) and whether the section is half-time
       pb · answer     the bar's place in its four-bar phrase (0…3); bars 1 and 3 answer 0 and 2
       kick hat ghost  the sigil's polygons, under this section's transform (05c)
       four            the mood insists on four-on-the-floor (Pulse)
       free            0 if the mood wants no liberties taken (Clockwork, Pulse), else 1
       put(step, type, vel, x) · putT(tick, …)   a stroke, unless a fill has taken that part of the bar
       sync(allowed, max)   where the sigil's kick polygon syncopates, moved to the nearest places
                            THIS idiom can carry a kick: the polygon chooses, the idiom allows
       N(step, ch) w(step) ring(step) lands   noise, the passing letter's weight and ring, where the melody lands */

  function hats(B, mode, o = {}) {
    const type = o.type || 'hat', lvl = o.vel ?? 0.7, open = o.open || [];
    for (let s = 0; s < 16; s++) {
      let on = false, acc = 1;
      if (mode === '16') { on = true; acc = [1, 0.55, 0.78, 0.55][s & 3]; }
      else if (mode === '8') { on = s % 2 === 0; acc = s % 4 === 0 ? 0.8 : 1; }
      else if (mode === '8+') { on = s % 2 === 0 || B.hat[s]; acc = s % 2 ? 0.5 : s % 4 === 0 ? 0.8 : 1; }
      else if (mode === 'off') on = s % 4 === 2;
      else if (mode === '4') on = s % 4 === 0;
      else if (mode === 'poly') { on = B.hat[s]; acc = s % 4 === 0 ? 0.7 : 1; }
      if (!on) continue;
      let vel = lvl * acc * (0.78 + 0.22 * B.N(s, CH.hatVel)) * B.w(s);
      if (B.lands.has(s)) vel *= 1.12;
      B.put(s, type, Math.min(vel, 0.98), { open: open.includes(s), pan: (B.N(s, CH.hatPan) - 0.5) * 0.6 });
    }
  }
  /** The backbeat. It holds through a turn; only a build or a dissolve takes it away (as in 05c). */
  const back = (B, steps, type = 'snare', vel = 0.8) => { for (const s of steps) B.put(s, type, vel, { back: true, keep: B.keepBack }); };
  /** Ghost notes on the snare, where the ghost polygon has them, by the listener's Ghosts amount. */
  function ghosts(B, scale = 1, skip = [4, 12]) {
    const p = clamp(B.g * scale * (B.I >= 3 ? 2 : 1), 0, 1);
    for (let s = 1; s < 16; s++) {
      if (skip.includes(s) || !B.ghost[s] || B.N(s, CH.ghost) >= p) continue;
      B.put(s, 'snare', 0.13 + 0.045 * B.ring(s), { ghost: true });
    }
  }
  /** The kick: the downbeat, then the polygon's syncopations where the idiom allows them. */
  function kicks(B, allowed, max, vel = 0.68) {
    B.put(0, 'kick', 0.95);
    for (const s of B.sync(allowed, max)) B.put(s, 'kick', vel * (1 + (B.w(s) - 1) * 0.5));
  }
  /** An answering bar's extra kick, where this groove was dealt it (if the idiom allows that step). */
  function pickup(B, allowed, vel = 0.6) {
    if (!B.answer || !B.free) return;
    const s = allowed.includes(B.D.pickup) ? B.D.pickup : allowed[Math.floor(B.N(1, CH.pickup) * allowed.length)];
    if (s > 0 && B.N(s, CH.pickup) < 0.85 * B.v) B.put(s, 'kick', vel);
  }
  const four = (B, vel = 0.92) => { for (const s of [0, 4, 8, 12]) B.put(s, 'kick', s ? vel : 0.96); };
  /** A burst of hats faster than the grid: `n` strokes across `span` ticks from a step (a roll, a triplet). */
  function roll(B, step, span, n, type = 'hat', v0 = 0.4, v1 = 0.7) {
    for (let j = 0; j < n; j++) B.putT(S(step) + Math.round((j * span) / n), type, v0 + ((v1 - v0) * j) / Math.max(1, n - 1), { pan: 0 });
  }

  const KITS = {
    /* Boom bap: the kick on one and wherever the polygon leans, late and heavy; the snare dead on two and four, behind the beat. */
    hiphop(B) {
      if (B.half) { kicks(B, [10, 11, 6], 1); back(B, [8]); hats(B, '8', { vel: 0.6 }); return; }
      kicks(B, [7, 10, 11, 6, 14, 15, 3], B.I >= 3 ? 3 : B.I === 2 ? 2 : 1);
      if (B.I === 1) { back(B, [4, 12], 'rim', 0.4); hats(B, '8', { vel: 0.42 }); return; }
      back(B, [4, 12], 'snare', 0.84);
      hats(B, B.I >= 3 ? '8+' : '8', { vel: 0.62, open: B.pb === 3 ? [B.D.open] : [] });
      if (B.I >= 3) { ghosts(B, 0.8); pickup(B, [14, 15, 11]); }
    },
    /* Trap: written at half its felt speed, so the clap is on two and four and the hats are the fast thing. */
    trap(B) {
      if (B.half) { B.put(0, 'kick', 0.95); if (B.answer) B.put(14, 'kick', 0.6); back(B, [8], 'clap', 0.8); hats(B, '8', { vel: 0.5 }); return; }
      kicks(B, [3, 6, 7, 10, 11, 14], B.I >= 3 ? 3 : B.I === 2 ? 2 : 1, 0.74);
      if (B.I === 1) { back(B, [12], 'clap', 0.6); hats(B, '8', { vel: 0.45 }); return; }
      back(B, [4, 12], 'clap', 0.8); back(B, [4, 12], 'snare', 0.5);
      hats(B, '16', { vel: 0.56, open: B.pb === 3 ? [B.D.open] : [] });
      // the rolls: thirty-seconds on an answering bar, triplets as the phrase turns
      if (B.answer && B.N(2, CH.flam) < 0.5 + 0.5 * B.v) roll(B, B.D.push >= 14 ? 6 : B.D.push, 12, 4);
      if (B.pb === 3 || B.I >= 3) roll(B, B.I >= 3 && B.pb !== 3 ? 10 : 14, 12, 3, 'hat', 0.45, 0.75);
    },
    /* Lo-fi: boom bap with the edges taken off: a side-stick for a snare, nothing loud, nothing open. */
    lofi(B) {
      if (B.half) { kicks(B, [10], 1, 0.55); back(B, [8], 'rim', 0.42); hats(B, '8', { vel: 0.36 }); return; }
      kicks(B, [7, 10, 11, 6], B.I >= 2 ? 2 : 1, 0.6);
      back(B, [4, 12], B.I >= 3 ? 'snare' : 'rim', B.I >= 3 ? 0.6 : 0.42);
      hats(B, B.I >= 2 ? '8+' : '8', { vel: B.I >= 2 ? 0.46 : 0.36 });
      if (B.I >= 2) for (let s = 2; s < 16; s += 4) B.put(s, 'shaker', 0.3);
    },
    /* Pop: kick on one and three, snare and clap on two and four, hats that double in the chorus. */
    pop(B) {
      if (B.half) { B.put(0, 'kick', 0.95); B.put(10, 'kick', 0.65); back(B, [8]); back(B, [8], 'clap', 0.5); hats(B, '8', { vel: 0.6 }); return; }
      B.put(0, 'kick', 0.95); B.put(8, 'kick', 0.85);
      if (B.I === 1) { back(B, [4, 12], 'clap', 0.45); hats(B, '8', { vel: 0.4 }); return; }
      for (const s of B.sync([6, 10, 14, 7], B.I >= 3 ? 2 : 1)) B.put(s, 'kick', 0.66);
      back(B, [4, 12]); back(B, [4, 12], 'clap', 0.5);
      hats(B, B.I >= 3 ? '16' : '8', { vel: B.I >= 3 ? 0.62 : 0.66, open: B.I >= 3 && B.answer ? [14] : [] });
    },
    /* Punk: the fast two-beat. Felt at twice the tempo: kick on every felt beat, snare on every felt off-beat. */
    punk(B) {
      if (B.half || B.I === 1) {                                  // the breakdown, and the quiet verse: the same kit at half the speed
        B.put(0, 'kick', 0.95); B.put(8, 'kick', 0.85); if (B.I >= 2) for (const s of B.sync([6, 10, 14], 2)) B.put(s, 'kick', 0.7);
        back(B, [4, 12], 'snare', B.I === 1 ? 0.6 : 0.9);
        hats(B, B.I >= 3 ? '4' : '8', { type: B.I >= 3 ? 'ride' : 'hat', vel: B.I >= 3 ? 0.8 : 0.6 });
        return;
      }
      four(B, 0.9);
      for (const s of B.sync([5, 13, 3, 11], B.I >= 3 ? 2 : 1)) B.put(s, 'kick', 0.68);
      back(B, [2, 6, 10, 14], 'snare', 0.86);
      if (B.I >= 3) { hats(B, '4', { type: 'ride', vel: 0.86 }); if (B.pb % 2 === 0) B.put(0, 'crash', 0.5); }
      else hats(B, '16', { vel: 0.7 });
    },
    /* Grunge: quiet, then loud. The verse is played with the wrists, the chorus with the shoulders. */
    grunge(B) {
      if (B.half) { B.put(0, 'kick', 0.95); for (const s of B.sync([3, 10, 11], 1)) B.put(s, 'kick', 0.7); back(B, [8], 'snare', 0.9); hats(B, '4', { type: 'ride', vel: 0.7 }); return; }
      kicks(B, [6, 7, 10, 11, 3, 14], B.I, 0.7);
      if (B.I === 1) { back(B, [4, 12], 'snare', 0.5); hats(B, '8', { vel: 0.42 }); return; }
      back(B, [4, 12], 'snare', B.I >= 3 ? 0.92 : 0.8);
      if (B.I >= 3) { hats(B, '8', { type: 'ride', vel: 0.78 }); if (B.pb === 0 || B.pb === 2) B.put(0, 'crash', 0.55); if (B.pb === 3) B.putT(S(12) - 2, 'snare', 0.3, { grace: true }); }
      else hats(B, '8', { vel: 0.64, open: B.answer ? [B.D.open] : [] });
    },
    /* Metal: the gallop, then both feet. The kick doubles the guitar; the snare stays where a head can find it. */
    metal(B) {
      if (B.half) { for (const s of [0, 3, 6]) B.put(s, 'kick', s ? 0.8 : 0.96); B.put(10, 'kick', 0.7); back(B, [8], 'snare', 0.95); hats(B, '4', { type: 'ride', vel: 0.8 }); B.put(0, 'crash', 0.5); return; }
      if (B.I === 1) { B.put(0, 'kick', 0.95); B.put(6, 'kick', 0.7); B.put(8, 'kick', 0.85); back(B, [4, 12], 'snare', 0.7); hats(B, '8', { vel: 0.5 }); return; }
      if (B.I === 2) for (const s of [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15]) B.put(s, 'kick', s % 4 === 0 ? 0.92 : 0.74);
      else for (let s = 0; s < 16; s++) B.put(s, 'kick', s % 2 ? 0.72 : 0.88);
      back(B, [4, 12], 'snare', 0.92);
      hats(B, '8', { type: B.I >= 3 ? 'ride' : 'hat', vel: 0.72 });
      if (B.I >= 3 && B.pb % 2 === 0) B.put(0, 'crash', 0.55);
    },
    /* EDM: four on the floor, the clap on two and four, the open hat between the kicks. */
    edm(B) {
      if (B.half) { B.put(0, 'kick', 0.96); for (const s of B.sync([10, 3, 11], 1)) B.put(s, 'kick', 0.7); back(B, [8], 'clap', 0.85); back(B, [8], 'snare', 0.6); hats(B, '16', { vel: 0.5 }); if (B.pb === 3) roll(B, 14, 12, 4); return; }
      four(B, B.I === 1 ? 0.82 : 0.94);
      hats(B, 'off', { vel: B.I === 1 ? 0.5 : 0.8, open: B.I >= 2 ? [2, 6, 10, 14] : [] });
      if (B.I === 1) return;
      back(B, [4, 12], 'clap', 0.82);
      if (B.I >= 3) { back(B, [4, 12], 'snare', 0.55); for (let s = 1; s < 16; s += 2) B.put(s, 'hat', 0.34 * B.w(s), { pan: (B.N(s, CH.hatPan) - 0.5) * 0.6 }); if (B.pb === 0) B.put(0, 'crash', 0.5); }
    },
    /* House: four on the floor, played softer and swung; the polygon becomes a rim that talks across it. */
    house(B) {
      if (B.half) { B.put(0, 'kick', 0.92); B.put(8, 'kick', 0.8); back(B, [8], 'clap', 0.7); hats(B, 'off', { vel: 0.6, open: [2, 10] }); return; }
      four(B, 0.86);
      if (B.I === 1) { for (let s = 0; s < 16; s++) B.put(s, 'shaker', [0.3, 0.2, 0.42, 0.2][s & 3]); return; }
      back(B, [4, 12], 'clap', 0.72);
      hats(B, 'off', { vel: 0.72, open: [2, 6, 10, 14] });
      for (let s = 0; s < 16; s++) B.put(s, 'shaker', [0.26, 0.18, 0.36, 0.2][s & 3]);
      if (B.I >= 3) for (let s = 1; s < 16; s++) if (B.ghost[s] && s % 4 !== 0) B.put(s, 'rim', 0.3);
    },
    /* Techno: the kick is the song. Everything else is a machine counting against it. */
    techno(B) {
      if (B.half) { B.put(0, 'kick', 0.96); for (const s of B.sync([6, 10, 11], 2)) B.put(s, 'kick', 0.78); hats(B, '16', { vel: 0.46 }); return; }
      four(B, 0.95);
      hats(B, B.I >= 2 ? '16' : 'off', { vel: B.I >= 2 ? 0.5 : 0.55 });
      if (B.I >= 2) { hats(B, 'off', { vel: 0.74, open: B.I >= 3 ? [2, 6, 10, 14] : [] }); back(B, [4, 12], 'clap', 0.5); }
      if (B.I >= 3) for (let s = 1; s < 16; s++) { if (B.ghost[s] && s % 4) B.put(s, 'rim', 0.34); if (B.kick[s] && s % 4) B.put(s, 'tom', 0.42, { tom: 0 }); }
    },
    /* Drum and bass: the two-step, felt at twice the tempo: kick, snare, (kick) snare. */
    dnb(B) {
      if (B.half || B.I === 1) { B.put(0, 'kick', 0.95); if (B.I >= 2) B.put(10, 'kick', 0.7); back(B, [4, 12], 'snare', B.I === 1 ? 0.6 : 0.88); hats(B, B.I === 1 ? '8' : '16', { vel: 0.5 }); return; }
      B.put(0, 'kick', 0.96); B.put(5, 'kick', 0.78); B.put(8, 'kick', 0.9);
      B.put(B.kick[11] || B.answer ? 11 : 13, 'kick', 0.76);
      if (B.I >= 3) for (const s of B.sync([3, 7, 15], 1)) B.put(s, 'kick', 0.6);
      back(B, [2, 6, 10, 14], 'snare', 0.86);
      hats(B, '16', { vel: 0.52, open: B.pb === 3 ? [B.D.open | 1] : [] });
      // the break's chatter: ghost strokes a thirty-second off the grid
      const p = clamp(B.g * (B.I >= 3 ? 1.6 : 0.9), 0, 1);
      for (let s = 1; s < 16; s++) if (B.ghost[s] && B.N(s, CH.ghost) < p) B.putT(S(s) + 3, 'snare', 0.16 + 0.04 * B.ring(s), { ghost: true });
    },
    /* Synthwave: a drum machine in a big gated room: kick, a fat snare on two and four, and the toms for fills. */
    synthwave(B) {
      if (B.half) { B.put(0, 'kick', 0.95); B.put(10, 'kick', 0.66); back(B, [8], 'snare', 0.92); hats(B, '8', { vel: 0.56 }); return; }
      if (B.I >= 3 || B.four) four(B, 0.9); else { B.put(0, 'kick', 0.95); B.put(8, 'kick', 0.86); for (const s of B.sync([10, 14, 6], B.I - 1)) B.put(s, 'kick', 0.66); }
      back(B, [4, 12], 'snare', B.I === 1 ? 0.66 : 0.9);
      hats(B, B.I === 1 ? '8' : '16', { vel: 0.54, open: B.I >= 3 && B.answer ? [14] : [] });
    },
    /* Funk: everything is on the one, and then nowhere you expect. Ghosts on the snare, sixteenths on the hat. */
    funk(B) {
      if (B.half) { B.put(0, 'kick', 0.96); for (const s of B.sync([7, 10, 6], 2)) B.put(s, 'kick', 0.68); back(B, [8], 'snare', 0.86); hats(B, '16', { vel: 0.5 }); ghosts(B, 1.4, [8]); return; }
      if (B.I >= 3) { four(B, 0.88); for (const s of B.sync([7, 11, 15, 3], 1)) B.put(s, 'kick', 0.6); }
      else kicks(B, [3, 6, 7, 10, 11, 13], B.I === 2 ? 3 : 1, 0.7);
      back(B, [4, 12], B.I === 1 ? 'rim' : 'snare', B.I === 1 ? 0.42 : 0.86);
      if (B.I >= 3) back(B, [4, 12], 'clap', 0.45);
      hats(B, '16', { vel: B.I === 1 ? 0.4 : 0.6, open: B.I >= 3 ? [2, 6, 10, 14] : B.answer ? [B.D.open] : [] });
      if (B.I >= 2) ghosts(B, 1.5);
    },
    /* Reggae: the one drop. Nothing on one; the kick and the rim fall together on three. */
    reggae(B) {
      if (B.I >= 3 && !B.half) { four(B, 0.8); back(B, [8], 'snare', 0.8); hats(B, '8+', { vel: 0.56, open: B.answer ? [B.D.open] : [] }); for (const s of [4, 12]) B.put(s, 'rim', 0.36); return; }
      B.put(8, 'kick', 0.9); back(B, [8], B.I === 1 ? 'rim' : 'snare', B.I === 1 ? 0.5 : 0.78);
      hats(B, B.I === 1 ? '8' : '8+', { vel: B.I === 1 ? 0.4 : 0.54, open: B.pb === 3 ? [B.D.open] : [] });
      if (B.I >= 2 && B.answer && B.free && B.N(14, CH.pickup) < B.v) B.put(14, 'kick', 0.5);
    },
    /* Jazz: time is kept on the ride; the hat closes on two and four; the kick and snare only comment. */
    jazz(B) {
      const soft = B.half || B.I === 1;
      for (const s of soft ? [0, 4, 8, 12] : [0, 4, 6, 8, 12, 14]) B.put(s, 'ride', (s % 4 ? 0.5 : 0.68) * (B.I >= 3 ? 1.15 : 1) * (soft ? 0.7 : 1), { pan: 0.2 });
      for (const s of [4, 12]) B.put(s, 'hat', 0.4, { pan: -0.3 });
      if (soft) { for (let s = 2; s < 16; s += 4) B.put(s, 'shaker', 0.24); return; }
      for (const s of [0, 4, 8, 12]) B.put(s, 'kick', 0.26);                     // feathered
      if (B.free) for (const s of B.sync([6, 14, 10, 2], B.I >= 3 ? 2 : 1)) if (B.answer || B.I >= 3) B.put(s, 'kick', 0.6);
      const p = clamp(B.g * (B.I >= 3 ? 1.8 : 1.1), 0, 1);
      for (let s = 2; s < 16; s += 2) if ((B.ghost[s] || B.ghost[s + 1]) && s !== 4 && s !== 12 && B.N(s, CH.ghost) < p) B.put(s, 'snare', 0.22 + 0.06 * B.ring(s), { ghost: true });
    },
    /* Bossa: the rim plays the clave, the kick a heartbeat, the shaker never stops. */
    bossa(B) {
      if (B.half || B.I === 1) { B.put(0, 'kick', 0.7); B.put(8, 'kick', 0.6); for (const s of [6, 13]) B.put(s, 'rim', 0.36); for (let s = 0; s < 16; s += 2) B.put(s, 'shaker', s % 4 ? 0.3 : 0.4); return; }
      for (const [s, v] of [[0, 0.8], [6, 0.5], [8, 0.72], [14, 0.5]]) B.put(s, 'kick', v);
      for (const s of B.pb % 2 ? [2, 5, 8, 11, 14] : [0, 3, 6, 10, 13]) B.put(s, 'rim', 0.44);
      for (let s = 0; s < 16; s++) B.put(s, 'shaker', [0.44, 0.24, 0.34, 0.26][s & 3] * (B.I >= 3 ? 1.15 : 1));
      if (B.I >= 3 && B.pb === 3) B.put(14, 'hat', 0.5, { open: true, pan: 0 });
    },
    /* Folk: a foot on the floor and something shaken. */
    folk(B) {
      B.put(0, 'kick', 0.78); if (!B.half) B.put(8, 'kick', 0.66);
      if (B.I >= 3 && !B.half) B.put(6, 'kick', 0.5);
      if (B.half) { B.put(8, 'rim', 0.44); for (let s = 2; s < 16; s += 4) B.put(s, 'shaker', 0.36); return; }
      if (B.I >= 2) back(B, [4, 12], B.I >= 3 ? 'snare' : 'rim', B.I >= 3 ? 0.6 : 0.46);
      for (let s = 0; s < 16; s += B.I >= 3 ? 1 : 2) B.put(s, 'shaker', (s % 4 === 0 ? 0.36 : s % 2 ? 0.24 : 0.46) * (B.I === 1 ? 0.85 : 1));
    },
    /* Chiptune: a noise channel doing a drummer's job. Short, bright, exact. */
    chiptune(B) {
      if (B.half) { B.put(0, 'kick', 0.95); B.put(10, 'kick', 0.7); back(B, [8], 'snare', 0.8); hats(B, '8', { vel: 0.55 }); return; }
      if (B.I >= 3 || B.four) four(B, 0.9); else kicks(B, [6, 8, 10, 14], B.I === 2 ? 2 : 1, 0.74);
      if (B.I >= 2) back(B, [4, 12], 'snare', 0.8);
      hats(B, B.I === 1 ? '8' : '16', { vel: 0.56 });
      if (B.I >= 3 && B.answer) roll(B, 14, 12, 4, 'snare', 0.3, 0.6);
    },
    /* Dembow: the kick walks in fours and the snare says boom-ch-boom-chick across it. */
    dembow(B) {
      if (B.half || B.I === 1) { B.put(0, 'kick', 0.92); B.put(8, 'kick', 0.8); for (const s of [6, 14]) B.put(s, B.I === 1 ? 'rim' : 'snare', B.I === 1 ? 0.42 : 0.74, { back: true, keep: B.keepBack }); hats(B, '8', { vel: 0.42 }); return; }
      four(B, 0.9);
      for (const s of [3, 6, 11, 14]) B.put(s, 'snare', s === 6 || s === 14 ? 0.8 : 0.62, { back: true, keep: B.keepBack });
      hats(B, B.I >= 3 ? '16' : '8', { vel: 0.5, open: B.I >= 3 && B.answer ? [14] : [] });
      if (B.I >= 3) for (let s = 1; s < 16; s++) if (B.ghost[s] && ![3, 6, 11, 14].includes(s) && s % 4) B.put(s, 'tom', 0.36, { tom: 0 });
    },
  };

  /* How each idiom fills. `map` turns the limb a letter asks for (05c limb) into what this kit has:
     null = that letter is a rest. `roll`: a rise is built with a snare roll that doubles its rate. */
  const FILLS = {
    rock: { max: 16 },                                                        // toms, snare, kick, hats: as the letters say
    dry: { max: 8, map: { tom: 'snare' } },
    sticks: { max: 4, map: { tom: 'rim', snare: 'rim', hat: 'shaker', kick: 'kick' }, soft: 0.7 },
    drop: { max: 8, map: { tom: null, hat: null } },                          // the beat falls out; only the hard letters speak
    machine: { max: 4, map: { tom: 'snare' }, roll: true },
    brushes: { max: 4, map: { tom: 'snare', hat: 'ride' }, soft: 0.6 },
  };

  /* ── §5f.5 THE BASS: one bar at a time ─────────────────────────────────────
     A bass is handed N:  I · half · pb · last (the phrase's last bar) · c (the chord) · kicks (the
     steps the kit's kick falls on this bar) · poly (the song's bass polygon) · note(step, role, beats,
     vel, x) · noteT(tick, …) · N(step, ch). Roles: root fifth oct third seventh low app. */

  const BASS = {
    /** On the kick: each note held until the next. (hip hop, grunge, dembow) */
    follow(N, o = {}) {
      const ks = N.kicks.length ? N.kicks : [0], max = o.max ?? 2.5;
      ks.forEach((s, i) => {
        const nxt = i < ks.length - 1 ? ks[i + 1] : 16, role = i && i === ks.length - 1 && N.I >= 3 ? 'fifth' : 'root';
        N.note(s, role, Math.min((nxt - s) * 0.25 * (o.gate ?? 0.92), max), i ? 0.74 : 0.92, o.x);
      });
      if (!ks.includes(0)) N.note(0, 'root', Math.min(ks[0] * 0.25 * 0.9, max), 0.9, o.x);
    },
    /** The 808: long, low, and sliding into its last note. (trap) */
    sub808(N) {
      const ks = (N.kicks.length ? N.kicks : [0]).filter((s, i) => i === 0 || N.I >= 2);
      ks.forEach((s, i) => {
        const nxt = i < ks.length - 1 ? ks[i + 1] : 16, end = i === ks.length - 1, slide = end && i > 0 && (N.last || N.N(s, CH.push) < 0.5);
        N.note(s, slide ? 'oct' : 'root', (nxt - s) * 0.25 * 0.98, i ? 0.8 : 0.95, { tone: 0.1, sub: 0.95, slide });
      });
    },
    /** Root on every eighth (or, `fast`, every sixteenth); the last of a phrase steps up. (pop, punk) */
    roots(N, o = {}) {
      const step = o.fast && N.I >= 2 && !N.half ? 1 : N.I >= 2 && !N.half ? 2 : 8;
      for (let s = 0; s < 16; s += step) {
        const lastNote = s + step >= 16;
        N.note(s, lastNote && N.last && step < 8 ? 'fifth' : 'root', step * 0.25 * (step === 8 ? 0.9 : o.gate ?? 0.8), s % 4 === 0 ? 0.88 : 0.72, o.x);
      }
    },
    /** Between the kicks: the off-beat eighths. Held under a breakdown. (EDM) */
    offbeat(N) {
      if (N.I <= 1 || N.half) { N.note(0, 'root', 3.6, 0.8, { tone: 0.12, sub: 0.8 }); return; }
      for (const s of [2, 6, 10, 14]) N.note(s, 'root', 0.3, 0.86);
      if (N.I >= 3) for (const s of [3, 11]) if (N.poly[s] || N.poly[s - 1]) N.note(s, 'oct', 0.16, 0.6);
    },
    /** A rumble under the kick: every sixteenth that is not a kick, low and dark. (techno) */
    rumble(N) {
      if (N.I <= 0) { N.note(0, 'root', 3.8, 0.7, { tone: 0.1, sub: 0.9 }); return; }
      for (let s = 0; s < 16; s++) {
        if (s % 4 === 0 || (N.I === 1 && s % 4 !== 2)) continue;
        N.note(s, 'root', 0.2, s % 4 === 2 ? 0.8 : 0.52, { tone: 0.11, sub: 0.85 });
      }
    },
    /** Root and octave, bouncing: eighths, or sixteenths at full tilt. (synthwave, funk's disco, chiptune) */
    octaves(N, o = {}) {
      if (N.I <= 1 || N.half) { for (const s of [0, 4, 8, 12]) N.note(s, 'root', 0.8, s ? 0.72 : 0.88, o.x); return; }
      const step = N.I >= 3 && o.fast ? 1 : 2;
      for (let s = 0; s < 16; s += step) N.note(s, (s / step) % 2 ? 'oct' : 'root', step * 0.25 * 0.8, s % 4 === 0 ? 0.88 : 0.72, o.x);
    },
    /** Slap: the polygon's sixteenths, the octave popped on the off ones. (funk) */
    slap(N) {
      N.note(0, 'root', 0.45, 0.95);
      const hits = [];
      for (let s = 1; s < 16; s++) if (N.poly[s] || N.kicks.includes(s)) hits.push(s);
      if (N.I >= 2 && hits.length < 3) for (const s of [6, 10, 14]) if (!hits.includes(s)) hits.push(s);
      hits.sort((a, b) => a - b).forEach((s) => N.note(s, s % 2 ? 'oct' : s === 14 && N.last ? 'app' : s % 4 === 0 ? 'root' : 'fifth', s % 2 ? 0.14 : 0.3, s % 2 ? 0.66 : 0.8));
    },
    /** The one drop's bass: it leaves the one, and speaks around three. (reggae) */
    drop(N) {
      const pat = N.pb % 2 ? [[2, 'root', 0.45], [6, 'third', 0.4], [8, 'root', 0.9], [14, 'fifth', 0.4]]
                          : [[0, 'root', 0.7], [3, 'root', 0.3], [6, 'fifth', 0.45], [10, 'root', 0.8]];
      for (const [s, role, d] of pat) if (N.I >= 2 || s % 4 !== 3) N.note(s, role, d, s === 0 || s === 8 ? 0.9 : 0.76, { tone: 0.12, sub: 0.9 });
    },
    /** Walking: a note to the beat, through the chord and into the next one. (jazz) */
    walk(N) {
      if (N.half || N.I <= 1) { N.note(0, 'root', 1.9, 0.8); N.note(8, 'fifth', 1.8, 0.7); return; }
      const up = N.N(0, CH.turn) < 0.5;
      [['root', 0.9], [up ? 'third' : 'fifth', 0.74], [up ? 'fifth' : 'third', 0.78], ['app', 0.74]].forEach(([role, v], i) => N.note(i * 4, role, 0.92, v));
      if (N.I >= 3 && N.answer) N.note(14, 'app', 0.3, 0.5);          // a skip into the next bar
    },
    /** Root, and the fifth on the pickups: the surdo's heartbeat. (bossa) */
    bossa(N) {
      for (const [s, role, d, v] of [[0, 'root', 1.3, 0.86], [6, 'fifth', 0.45, 0.66], [8, 'root', 1.3, 0.8], [14, 'fifth', 0.45, 0.66]]) N.note(s, role, d, v);
    },
    /** Root, then fifth: a thumb on alternate strings. (folk) */
    alternate(N) {
      N.note(0, 'root', 1.8, 0.86); N.note(8, N.half ? 'root' : 'fifth', 1.8, 0.74);
      if (N.I >= 3 && N.last) N.note(14, 'app', 0.45, 0.6);
    },
    /** The gallop: one and two quick ones, locked to the guitar. (metal) */
    gallop(N) {
      if (N.half) { for (const s of [0, 3, 6]) N.note(s, 'root', 0.7, 0.9); N.note(10, 'fifth', 1.2, 0.8); return; }
      if (N.I <= 1) { N.note(0, 'root', 1.8, 0.9); N.note(8, 'root', 1.8, 0.8); return; }
      const steps = N.I === 2 ? [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
      for (const s of steps) N.note(s, 'root', 0.2, s % 4 === 0 ? 0.9 : 0.72);
    },
    /** Long notes that lean: a whole bar, or three hits that slide. (drum and bass) */
    reese(N) {
      if (N.I <= 2 || N.half) { N.note(0, 'root', 3.7, 0.9, { tone: 0.16, sub: 0.9 }); return; }
      N.note(0, 'root', 1.4, 0.92, { tone: 0.16, sub: 0.9 }); N.note(6, 'root', 1.1, 0.8, { tone: 0.16, sub: 0.9 });
      N.note(11, N.last ? 'fifth' : 'oct', 1.2, 0.8, { tone: 0.16, sub: 0.9, slide: true });
    },
    /** The dembow's own bass: with the kick, and answering the snare. */
    dembow(N) {
      if (N.I <= 1 || N.half) { N.note(0, 'root', 1.8, 0.9); N.note(8, 'root', 1.6, 0.8); return; }
      for (const [s, role, d] of [[0, 'root', 0.7], [3, 'root', 0.3], [6, 'fifth', 0.45], [8, 'root', 0.7], [11, 'root', 0.3], [14, 'fifth', 0.45]]) N.note(s, role, d, s % 8 === 0 ? 0.92 : 0.76);
    },
    /** Root on one, and again where the polygon first leans. (lo-fi) */
    lazy(N) {
      N.note(0, 'root', 1.6, 0.86, { tone: 0.12, sub: 0.8 });
      const s = [10, 7, 11, 6].find((q) => N.kicks.includes(q) || N.poly[q]);
      if (s && N.I >= 2) N.note(s, N.last ? 'fifth' : 'root', 1.2, 0.68, { tone: 0.12, sub: 0.8 });
    },
  };

  /* ── §5f.6 THE CHORDS: held, strummed, stabbed or chugged ──────────────────
     A comp is handed C:  I · half · pb · last · c · hatP / ghostP (polygons) · N(step, ch)
       chord(step, beats, vel, x)   x: { shape, voice: 'wave'|'bell', bus: 'arp'|'pad', bright, strum (ticks
                                         between the notes; negative strums downward), add (semitones), top (notes) } */

  const COMP = {
    /** Power chords. Quiet: palm-muted and short. Loud: every stroke open. (punk) */
    punk(C) {
      const x = { shape: 'power', voice: 'wave', bus: 'arp' };
      if (C.I <= 1 || C.half) { for (let s = 0; s < 16; s += 2) C.chord(s, C.half ? 0.46 : 0.2, (s % 4 ? 0.5 : 0.62) * (C.half ? 1.2 : 1), { ...x, bright: C.half ? -1 : 0.3 }); return; }
      for (let s = 0; s < 16; s++) C.chord(s, 0.22, s % 2 ? 0.56 : s % 4 ? 0.66 : 0.78, x);
    },
    /** Quiet: nothing (the arpeggio has the verse). Loud: a power chord struck and left to ring, pushed early into the next bar. (grunge) */
    grunge(C) {
      if (C.I <= 1) return;
      const x = { shape: 'power', voice: 'wave', bus: 'arp' };
      if (C.half) { for (const s of [0, 3, 6]) C.chord(s, 0.7, 0.8, x); C.chord(10, 1.4, 0.74, x); return; }
      C.chord(0, 1.9, 0.84, x); C.chord(8, C.I >= 3 ? 1.4 : 1.9, 0.76, x);
      if (C.I >= 3) { C.chord(6, 0.45, 0.6, x); C.chord(14, 0.48, 0.7, x); }
    },
    /** The gallop, muted, with the chord let open on the one. (metal) */
    metal(C) {
      const x = { shape: 'power', voice: 'wave', bus: 'arp' };
      if (C.half) { for (const s of [0, 3, 6]) C.chord(s, 0.7, 0.86, x); C.chord(10, 1.4, 0.8, x); return; }
      if (C.I <= 1) { C.chord(0, 3.8, 0.74, x); return; }
      const steps = C.I === 2 ? [2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
      C.chord(0, 0.45, 0.86, x);
      for (const s of steps) C.chord(s, 0.14, s % 4 === 0 ? 0.7 : 0.52, { ...x, bright: 0.32, top: 2 });
    },
    /** Eighth-note stabs in the chorus, a chord to the beat before it. (pop) */
    pop(C) {
      if (C.I <= 1 || C.half) return;
      const x = { shape: 'triad', voice: 'wave', bus: 'arp' };
      if (C.I === 2) { for (const s of [0, 4, 8, 12]) C.chord(s, 0.6, s ? 0.5 : 0.6, x); return; }
      for (let s = 0; s < 16; s += 2) C.chord(s, 0.36, s % 4 ? 0.5 : 0.62, x);
    },
    /** Supersaw stabs in threes against the four of the kick. (EDM) */
    edm(C) {
      if (C.I <= 1 || C.half) return;
      const x = { shape: 'triad', voice: 'wave', bus: 'pad', add: 12 };
      const pat = C.N(0, CH.turn) < 0.5 ? [0, 3, 6, 8, 11, 14] : [0, 3, 6, 10, 12];
      for (const s of pat) C.chord(s, C.I >= 3 ? 0.5 : 0.32, s === 0 ? 0.8 : 0.66, x);
    },
    /** Organ stabs, off the beat and late. (house) */
    house(C) {
      if (C.I <= 1) return;
      const x = { shape: 'seventh', voice: 'wave', bus: 'arp' };
      for (const s of C.pb % 2 ? [2, 6, 11, 14] : [3, 6, 10, 13]) C.chord(s, 0.3, 0.6, x);
    },
    /** One dark chord, where the ghost polygon puts it. (techno) */
    techno(C) {
      if (C.I <= 1) return;
      const x = { shape: 'triad', voice: 'wave', bus: 'arp', bright: 0.34 };
      for (let s = 1; s < 16; s++) if (C.ghostP[s] && s % 4 !== 0) C.chord(s, 0.16, 0.56, x);
    },
    /** Keys, lazily: a chord on one and one that answers it. (hip hop, lo-fi) */
    keys(C) {
      if (C.I <= 1) return;
      const x = { shape: 'seventh', voice: 'bell', bus: 'arp', strum: 2, top: 3 };
      C.chord(0, 1.2, 0.56, x);
      if (C.I >= 3 || C.answer) C.chord(C.pb % 2 ? 7 : 10, 0.7, 0.46, x);
    },
    /** Chanks: muted sixteenths where the hat polygon is, a real chord where the ghosts are. (funk) */
    funk(C) {
      if (C.I <= 1) return;
      const x = { shape: 'seventh', voice: 'wave', bus: 'arp', add: 12 };
      for (let s = 0; s < 16; s++) {
        const acc = C.ghostP[s] || (s === 0 && C.pb === 0);
        if (acc) C.chord(s, 0.2, 0.66, x);
        else if (C.hatP[s] || s % 4 === 2) C.chord(s, 0.07, 0.3, { ...x, top: 2 });
      }
    },
    /** The skank: the off-beats, short and high. (reggae) */
    skank(C) {
      if (C.I <= 0) return;
      const x = { shape: 'high', voice: 'wave', bus: 'arp' };
      for (const s of [2, 6, 10, 14]) C.chord(s, 0.16, 0.62, x);
      if (C.I >= 3 && C.answer) C.chord(15, 0.1, 0.44, x);
    },
    /** Comping: the Charleston, and what the ghost polygon adds to it. (jazz) */
    jazz(C) {
      if (C.I <= 0) return;
      const x = { shape: 'seventh', voice: 'bell', bus: 'arp' };
      const pat = C.pb % 2 ? (C.ghostP[10] ? [4, 10] : [6, 12]) : [0, 6];
      pat.forEach((s, i) => C.chord(s, i ? 0.3 : 0.9, i ? 0.5 : 0.6, x));
      if (C.I >= 3 && C.answer) C.chord(14, 0.3, 0.46, x);
    },
    /** A nylon guitar on the clave. (bossa) */
    bossa(C) {
      if (C.I <= 0) return;
      const x = { shape: 'seventh', voice: 'bell', bus: 'arp', strum: 1 };
      for (const s of C.pb % 2 ? [2, 5, 8, 11, 14] : [0, 3, 6, 10, 13]) C.chord(s, 0.4, s % 4 === 0 ? 0.6 : 0.5, x);
    },
    /** Strummed: down, down-up, up-down-up. Quiet, it is left to the arpeggio. (folk) */
    strum(C) {
      if (C.I <= 1) return;
      const x = { shape: 'open', voice: 'bell', bus: 'arp' };
      for (const s of C.half ? [0, 8] : [0, 4, 6, 10, 12, 14]) C.chord(s, C.half ? 1.8 : 0.5, s % 4 === 0 ? 0.62 : 0.46, { ...x, strum: s % 4 === 0 ? 3 : -2 });
    },
    /** The dembow's pluck: with the snare. */
    dembow(C) {
      if (C.I <= 1) return;
      const x = { shape: 'high', voice: 'bell', bus: 'arp' };
      for (const s of [3, 6, 11, 14]) C.chord(s, 0.2, s % 8 === 6 ? 0.62 : 0.48, x);
    },
  };

  /* ── §5f.7 THE STYLES ───────────────────────────────────────────────────────
     tempo    [lo, hi] bpm the sigil's 74…98 is mapped onto · felt: how many times faster it FEELS
     bend     how far a mood's lean on the tempo is followed (an exponent, 0 = not at all)
     swing    [lo, hi] the composer's swing, mapped · shuffle: 0…1 toward triplets
     voicing  'triad' | 'seventh' | 'ninth' | 'power' (the pad and the chords)
     sound    { pull: {field: [target, weight]}, set: {field: value} } → SoundDesign.shape
     voices · layers   the lead voices, and the cube's families, that suit it
     levels   faders · kitStyle: the kit cell's kick/snare/hat characters, overridden
     form     the contour it would like, by section: applied inside the mood's range
     half     which sections it plays half-time: 'keep' (the mood's), or a list of section ids
     kit · fill · crash      the drummer (§5f.4)
     bass · comp             §5f.5 / §5f.6 (functions of one bar)
     pad      { shape }: how the held chord is voiced · arp: { rule: keep|off|always|quiet, rate by level, pat, gate, add, vel }
     lead     { art: × each note's length }
     (How LOUD a part is against the others is never set by velocities here: it is a fader, `levels`,
      or a move of the master's house balance, `master.house`, so that the master's levelling keeps it.)
     duck     × the sidechain · space: × the hall's return · master: hints for 05e
     ⚠ APPEND ONLY: the order of this table is the order of the panel and of the random draw. */

  const FORM_ROCK = { intro: 1, verse1: 2, chorus1: 3, verse2: 2, bridge: 2, chorus2: 3, outro: 1 };
  const STYLES = {
    none: { label: 'None', blurb: 'No idiom is laid over the rite: the band reads the sigil alone.' },

    hiphop: {
      label: 'Hip hop', blurb: 'Boom bap. A heavy, late kick and a snare behind the beat; keys on a dusty sampler; the bass is the kick’s shadow.',
      tempo: [82, 98], bend: 0.4, swing: [0.2, 0.36], voicing: 'ninth',
      sound: { pull: { bright: [0.45, 0.7], sub: [0.6, 0.7], chorus: [0.2, 0.6], echo: [0.25, 0.6], tilt: [0.2, 0.6], drumX: [0.7, 0.7] },
        set: { grit: 0.35, bits: 12, hold: 2, drive: 0.25, fold: 0, kSub: 1.3, kDecay: 1.2, kPunch: 1.1, sBody: 1.3, sSnap: 1, hTone: 0.8, hDecay: 0.7,
          dDrive: 0.3, dCrush: 0.25, dBits: 12, dHold: 1, dSmash: 0.5, dRoom: 0.12, dPunch: 0.3 } },
      voices: ['bell', 'wave', 'vox'], layers: [4, 1, 0], levels: { drums: 1.1, bass: 1.15, pad: 0.8 }, kitStyle: { kickStyle: 2, snareStyle: 1, hatStyle: 0 },
      form: FORM_ROCK, half: 'keep', kit: KITS.hiphop, fill: 'drop', lay: 1.6,
      bass: (N) => BASS.follow(N, { x: { tone: 0.12, sub: 0.85 } }), comp: COMP.keys,
      arp: { rule: 'off' }, lead: { art: 0.82 }, master: { noise: 3, house: { arp: 3 }, lean: { weight: 0.3 } },
    },
    trap: {
      label: 'Trap', blurb: 'Slow underneath, fast on top. An 808 that slides, claps on two and four, hats that roll in thirty-seconds and triplets.',
      tempo: [62, 76], felt: 2, bend: 0.35, swing: [0, 0], voicing: 'triad',
      sound: { pull: { bright: [0.5, 0.6], sub: [0.9, 0.9], chorus: [0.15, 0.6], echo: [0.45, 0.6], drumX: [0.8, 0.7] },
        set: { grit: 0, kSub: 1.6, kDecay: 1.7, kPunch: 0.9, sSnap: 1.4, sBody: 0.7, hTone: 1.5, hDecay: 0.45, dSmash: 0.3, dRoom: 0.05, dCrush: 0, dPunch: 0.3 } },
      voices: ['bell', 'fm', 'wave'], layers: [3, 4, 5], levels: { bass: 1.25, drums: 1.05, pad: 0.65 }, kitStyle: { kickStyle: 0, snareStyle: 3, hatStyle: 0 },
      form: { intro: 1, verse1: 2, chorus1: 3, verse2: 2, bridge: 1, chorus2: 3, outro: 1 }, half: 'keep', kit: KITS.trap, fill: 'machine',
      bass: BASS.sub808, arp: { rule: 'always', rate: { 1: 2, 2: 2, 3: 2 }, pat: 'broken', gate: 0.5, add: 12, vel: 0.7 },
      lead: { art: 0.7 }, master: { lean: { weight: 0.5 } },
    },
    lofi: {
      label: 'Lo-fi', blurb: 'Boom bap with the edges worn off. Soft keys, a side-stick for a snare, everything through an old sampler.',
      tempo: [66, 86], bend: 0.35, swing: [0.24, 0.4], voicing: 'ninth',
      sound: { pull: { bright: [0.32, 0.8], tilt: [0.35, 0.7], chorus: [0.45, 0.6], drift: [0.5, 0.5], echo: [0.3, 0.5], sub: [0.5, 0.6] },
        set: { grit: 0.5, bits: 10, hold: 3, drive: 0.15, fold: 0, kSub: 1.2, kPunch: 0.7, sBody: 1.2, sSnap: 0.6, hTone: 0.6, hDecay: 0.8,
          dFilter: -0.22, dCrush: 0.3, dBits: 10, dHold: 2, dRoom: 0.2, dSmash: 0.4, dDrive: 0.15 } },
      voices: ['bell', 'wave', 'vox'], layers: [1, 4, 0], levels: { drums: 0.85, pad: 1.1, bass: 1.05, lead: 0.92 }, kitStyle: { kickStyle: 2, snareStyle: 2, hatStyle: 0 },
      form: { intro: 1, verse1: 1, chorus1: 2, verse2: 2, bridge: 1, chorus2: 2, outro: 1 }, half: 'keep', kit: KITS.lofi, fill: 'sticks', crash: 0, lay: 1.8,
      bass: BASS.lazy, comp: COMP.keys, arp: { rule: 'off' }, lead: { art: 0.86 }, master: { noise: 5, tone: 0.6, house: { arp: 3, drums: -2 }, lean: { warmth: 0.4, air: -0.3 } },
    },
    pop: {
      label: 'Pop', blurb: 'Clean and forward. Kick on one and three, claps on two and four, chords that start to pulse when the chorus arrives.',
      tempo: [96, 124], bend: 0.4, swing: [0, 0.08], voicing: 'triad',
      sound: { pull: { bright: [0.7, 0.7], chorus: [0.5, 0.6], echo: [0.35, 0.5], sub: [0.35, 0.5], drumX: [0.55, 0.6] },
        set: { grit: 0, drive: 0, kPunch: 1.3, kDecay: 0.8, sSnap: 1.2, hTone: 1.2, dSmash: 0.45, dRoom: 0.18, dPunch: 0.35, dCrush: 0 } },
      voices: ['vox', 'wave', 'bell'], layers: [0, 5, 2], levels: { lead: 1.05, harm: 1.15, pad: 0.9 }, kitStyle: { kickStyle: 3, snareStyle: 0, hatStyle: 0 },
      form: { intro: 1, verse1: 1, chorus1: 3, verse2: 2, bridge: 2, chorus2: 3, outro: 1 }, half: 'keep', kit: KITS.pop, fill: 'rock',
      bass: BASS.roots, comp: COMP.pop, arp: { rule: 'keep', rate: { 1: 2, 2: 2, 3: 2 } }, lead: { art: 0.92 },
      master: { house: { arp: 2 }, lean: { air: 0.3, glue: 0.3 } },
    },
    punk: {
      label: 'Punk', blurb: 'The fast two-beat, felt at twice the tempo. Power chords on every stroke, a bass that never leaves the root, no ornaments.',
      tempo: [80, 98], felt: 2, bend: 0.35, swing: [0, 0], voicing: 'power',
      sound: { pull: { bright: [0.78, 0.8], echo: [0.05, 0.9], sub: [0.2, 0.7], drumX: [0.5, 0.7] },
        set: { chorus: 0, grit: 0.65, bits: 16, hold: 1, drive: 0.55, fold: 0.1, layer: 6, kPunch: 1.6, kDecay: 0.6, kSub: 0.8, sSnap: 1.5, sBody: 1.1, hTone: 1.3, hDecay: 1.1,
          dDrive: 0.4, dSmash: 0.55, dRoom: 0.3, dPunch: 0.5, dCrush: 0 } },
      voices: ['vox', 'wave'], layers: [6], levels: { arp: 1.5, pad: 0.16, drums: 1.05, bass: 1.05, lead: 1.05 }, kitStyle: { kickStyle: 3, snareStyle: 3, hatStyle: 0 },
      form: { intro: 2, verse1: 2, chorus1: 3, verse2: 3, bridge: 2, chorus2: 3, outro: 1 }, half: ['bridge'], kit: KITS.punk, fill: 'rock', crash: 0.75,
      bass: (N) => BASS.roots(N, { fast: true, gate: 0.86 }), comp: COMP.punk, pad: { shape: 'power' }, arp: { rule: 'off' }, lead: { art: 0.84 },
      drone: 'off', master: { house: { arp: 7, pad: -3 }, dynamics: 0.7, lean: { punch: 0.5, air: 0.2 } },
    },
    grunge: {
      label: 'Grunge', blurb: 'Quiet, then loud. A clean arpeggio and a murmur in the verse; in the chorus the power chords ring and the drummer stops being careful.',
      tempo: [92, 122], bend: 0.4, swing: [0, 0.06], voicing: 'power',
      sound: { pull: { bright: [0.55, 0.7], tilt: [0.25, 0.6], chorus: [0.4, 0.7], echo: [0.15, 0.7], sub: [0.5, 0.6], throat: [-0.3, 0.6], drumX: [0.9, 0.8] },
        set: { grit: 0.6, bits: 16, hold: 1, drive: 0.5, fold: 0.22, layer: 4, kDecay: 1.3, kSub: 1.2, kPunch: 1.1, sBody: 1.5, sSnap: 1, hTone: 0.9, hDecay: 1.5,
          dRoom: 0.4, dSmash: 0.6, dDrive: 0.35, dBody: 0.3, dCrush: 0 } },
      voices: ['vox', 'bow', 'wave'], layers: [4, 6], levels: { arp: 1.35, pad: 0.3, drums: 1.05 }, kitStyle: { kickStyle: 2, snareStyle: 1, hatStyle: 0 },
      form: { intro: 1, verse1: 1, chorus1: 3, verse2: 1, bridge: 2, chorus2: 3, outro: 1 }, half: ['bridge'], kit: KITS.grunge, fill: 'rock', crash: 0.8,
      bass: (N) => (N.I <= 1 ? BASS.roots(N) : BASS.follow(N, { max: 2 })), comp: COMP.grunge, pad: { shape: 'power' },
      arp: { rule: 'quiet', rate: { 1: 2, 2: 2, 3: 2 }, pat: 'broken', gate: 0.95, vel: 0.8 }, lead: { art: 1 },
      master: { house: { arp: 5, pad: -2 }, dynamics: 1.3, lean: { weight: 0.3, warmth: 0.3 } },
    },
    metal: {
      label: 'Metal', blurb: 'The gallop, then both feet. Felt at twice the tempo: muted chugs locked to the kick, the chord let open on the one.',
      tempo: [70, 94], felt: 2, bend: 0.35, swing: [0, 0], voicing: 'power',
      sound: { pull: { bright: [0.7, 0.8], echo: [0.05, 0.9], sub: [0.4, 0.6], tilt: [0, 0.5], drumX: [0.7, 0.7] },
        set: { chorus: 0, grit: 0.8, bits: 16, hold: 1, drive: 0.7, fold: 0.15, layer: 6, kPunch: 1.9, kDecay: 0.45, kSub: 0.9, kTone: 2, sSnap: 1.4, sBody: 1.2, hTone: 1.2,
          dPunch: 0.6, dSmash: 0.6, dRoom: 0.25, dDrive: 0.3, dCrush: 0 } },
      voices: ['wave', 'vox', 'fm'], layers: [6, 7], levels: { arp: 1.55, pad: 0.12, drums: 1.08 }, kitStyle: { kickStyle: 1, snareStyle: 0, hatStyle: 1 },
      form: { intro: 2, verse1: 2, chorus1: 3, verse2: 2, bridge: 2, chorus2: 3, outro: 1 }, half: ['bridge'], kit: KITS.metal, fill: 'rock', crash: 0.8,
      bass: BASS.gallop, comp: COMP.metal, pad: { shape: 'power' }, arp: { rule: 'off' }, lead: { art: 0.96 },
      drone: 'off', master: { house: { arp: 7, pad: -3 }, dynamics: 0.6, lean: { punch: 0.6, weight: 0.3 } },
    },
    edm: {
      label: 'EDM', blurb: 'Four on the floor, and everything ducking under it. Chord stabs in threes, a breakdown, a snare roll that doubles, and the drop.',
      tempo: [124, 132], bend: 0.25, swing: [0, 0], voicing: 'triad',
      sound: { pull: { bright: [0.85, 0.8], chorus: [0.65, 0.7], echo: [0.45, 0.6], sub: [0.6, 0.7], sweep: [0.7, 0.6], density: [1.4, 0.6], drumX: [0.6, 0.6] },
        set: { grit: 0, drive: 0, kPunch: 1.5, kDecay: 0.85, kSub: 1.2, sSnap: 1.3, sBody: 0.9, hTone: 1.5, hDecay: 0.6, dSmash: 0.4, dRoom: 0.1, dPunch: 0.45, dCrush: 0 } },
      voices: ['wave', 'fm'], layers: [6, 8, 5], levels: { drums: 1.05, arp: 1.1 }, kitStyle: { kickStyle: 3, snareStyle: 3, hatStyle: 1 },
      form: { intro: 1, verse1: 2, chorus1: 3, verse2: 2, bridge: 0, chorus2: 3, outro: 1 }, half: [], kit: KITS.edm, fill: 'machine', crash: 0.7,
      bass: BASS.offbeat, comp: COMP.edm, arp: { rule: 'always', rate: { 1: 2, 2: 2, 3: 1 }, pat: 'up', gate: 0.7 }, lead: { art: 0.92 },
      duck: 1.6, master: { house: { pad: 2 }, dynamics: 0.8, lean: { air: 0.4, width: 0.4, punch: 0.3 } },
    },
    house: {
      label: 'House', blurb: 'Four on the floor, played warm and a little late. An organ stabbing off the beat, an open hat between the kicks, a bass that syncopates.',
      tempo: [118, 126], bend: 0.25, swing: [0.08, 0.18], voicing: 'ninth',
      sound: { pull: { bright: [0.55, 0.7], chorus: [0.45, 0.6], echo: [0.4, 0.6], sub: [0.7, 0.7], tilt: [0.15, 0.5], drumX: [0.6, 0.6] },
        set: { grit: 0, drive: 0, kDecay: 1, kSub: 1.3, kPunch: 1, sSnap: 0.9, hTone: 1.1, hDecay: 0.9, dSmash: 0.35, dRoom: 0.2, dCrush: 0 } },
      voices: ['bell', 'vox', 'wave'], layers: [1, 2, 0], levels: { drums: 1.05, bass: 1.1, pad: 0.85, lead: 0.9 }, kitStyle: { kickStyle: 0, snareStyle: 3, hatStyle: 0 },
      form: { intro: 1, verse1: 2, chorus1: 3, verse2: 2, bridge: 1, chorus2: 3, outro: 1 }, half: [], kit: KITS.house, fill: 'machine', crash: 0.4,
      bass: BASS.slap, comp: COMP.house, arp: { rule: 'off' }, lead: { art: 0.82 },
      duck: 1.3, master: { house: { arp: 4 }, lean: { warmth: 0.4, weight: 0.3 } },
    },
    techno: {
      label: 'Techno', blurb: 'The kick is the song. A rumble under it, one dark chord where the polygon puts it, a sequence that does not resolve.',
      tempo: [128, 140], bend: 0.2, swing: [0, 0.06], voicing: 'triad',
      sound: { pull: { bright: [0.4, 0.7], chorus: [0.1, 0.7], echo: [0.5, 0.6], sub: [0.8, 0.7], tilt: [0.3, 0.6], drumX: [0.7, 0.6] },
        set: { grit: 0.3, bits: 16, hold: 1, drive: 0.45, fold: 0.15, kDecay: 1.1, kSub: 1.4, kPunch: 1.2, kTone: -1, hTone: 1.3, hDecay: 0.5, sSnap: 0.8,
          dDrive: 0.45, dSmash: 0.5, dRoom: 0.15, dEcho: 0.2, dCrush: 0 } },
      voices: ['fm', 'wave', 'bell'], layers: [3, 7, 4], levels: { drums: 1.1, bass: 1.1, pad: 0.3, lead: 0.8 }, kitStyle: { kickStyle: 2, snareStyle: 3, hatStyle: 1 },
      form: { intro: 1, verse1: 2, chorus1: 3, verse2: 2, bridge: 1, chorus2: 3, outro: 2 }, half: [], kit: KITS.techno, fill: 'machine', crash: 0.35,
      bass: BASS.rumble, comp: COMP.techno, arp: { rule: 'always', rate: { 1: 1, 2: 1, 3: 1 }, pat: 'up', gate: 0.5, tones: 3, vel: 0.8 },
      lead: { art: 0.6 }, drone: 'on', duck: 1.5, master: { dynamics: 0.6, lean: { weight: 0.4, punch: 0.4 } },
    },
    dnb: {
      label: 'Drum & bass', blurb: 'The two-step at twice the tempo, chattering; under it, a bass that holds one note for a whole bar and leans on it.',
      tempo: [80, 88], felt: 2, bend: 0.2, swing: [0, 0.06], voicing: 'ninth',
      sound: { pull: { bright: [0.6, 0.6], chorus: [0.4, 0.5], echo: [0.4, 0.5], sub: [0.9, 0.8], drumX: [0.5, 0.7] },
        set: { grit: 0, kDecay: 0.55, kPunch: 1.4, kSub: 1, sSnap: 1.5, sBody: 1.1, sTone: 1.3, hTone: 1.3, hDecay: 0.5, dSmash: 0.6, dDrive: 0.3, dRoom: 0.12, dPunch: 0.5, dCrush: 0 } },
      voices: ['wave', 'vox', 'bell'], layers: [1, 0, 5], levels: { drums: 1.08, bass: 1.2 }, kitStyle: { kickStyle: 1, snareStyle: 3, hatStyle: 0 },
      form: { intro: 1, verse1: 2, chorus1: 3, verse2: 2, bridge: 1, chorus2: 3, outro: 1 }, half: 'keep', kit: KITS.dnb, fill: 'dry', crash: 0.6,
      bass: BASS.reese, comp: null, arp: { rule: 'keep', rate: { 1: 2, 2: 2, 3: 2 } }, lead: { art: 1 }, master: { lean: { weight: 0.4, width: 0.3 } },
    },
    synthwave: {
      label: 'Synthwave', blurb: 'A drum machine in a gated room, a bass bouncing in octaves, arpeggios everywhere, and a lead that glides.',
      tempo: [84, 118], bend: 0.4, swing: [0, 0], voicing: 'triad',
      sound: { pull: { bright: [0.68, 0.7], chorus: [0.75, 0.8], echo: [0.5, 0.7], sub: [0.5, 0.5], sweep: [0.4, 0.5], drumX: [0.85, 0.8] },
        set: { grit: 0, drive: 0, layer: 6, kDecay: 0.9, kPunch: 1.2, sBody: 1.6, sSnap: 1, sTone: 0.9, hTone: 1.3, hDecay: 0.5, dRoom: 0.55, dBody: -0.3, dSmash: 0.5, dPunch: 0.4, dCrush: 0 } },
      voices: ['wave', 'fm'], layers: [6, 7], levels: { arp: 1.15, pad: 1.1 }, kitStyle: { kickStyle: 1, snareStyle: 1, hatStyle: 0 },
      form: FORM_ROCK, half: 'keep', kit: KITS.synthwave, fill: 'rock', crash: 0.6,
      bass: (N) => BASS.octaves(N, { fast: true }), comp: null, arp: { rule: 'always', rate: { 1: 2, 2: 1, 3: 1 }, pat: 'up', gate: 0.8 }, lead: { art: 0.98 },
      master: { lean: { width: 0.5, warmth: 0.3 } },
    },
    funk: {
      label: 'Funk', blurb: 'On the one, and then nowhere you expect. Ghost notes, sixteenth hats, a slapped bass and a guitar that only scratches.',
      tempo: [96, 120], bend: 0.35, swing: [0.06, 0.16], voicing: 'ninth',
      sound: { pull: { bright: [0.68, 0.7], chorus: [0.3, 0.5], echo: [0.15, 0.7], sub: [0.45, 0.5], drumX: [0.45, 0.7] },
        set: { grit: 0, drive: 0, layer: 2, kDecay: 0.6, kPunch: 1.3, sSnap: 1.3, sBody: 1, hTone: 1.2, hDecay: 0.6, dRoom: 0.1, dSmash: 0.5, dPunch: 0.5, dCrush: 0 } },
      voices: ['bell', 'wave', 'vox'], layers: [2, 0], levels: { bass: 1.15, arp: 1.1, pad: 0.5 }, kitStyle: { kickStyle: 1, snareStyle: 0, hatStyle: 0 },
      form: FORM_ROCK, half: 'keep', kit: KITS.funk, fill: 'dry', crash: 0.5,
      bass: BASS.slap, comp: COMP.funk, arp: { rule: 'off' }, lead: { art: 0.62 }, master: { house: { arp: 4 }, lean: { punch: 0.4 } },
    },
    reggae: {
      label: 'Reggae', blurb: 'The one drop: nothing on one, kick and rim together on three. The chords skank on the off-beat, the bass is the tune, the echo is an instrument.',
      tempo: [64, 82], bend: 0.3, swing: [0.1, 0.2], voicing: 'triad',
      sound: { pull: { bright: [0.45, 0.7], tilt: [0.2, 0.5], chorus: [0.3, 0.5], echo: [0.7, 0.8], sub: [0.9, 0.8], drumX: [0.6, 0.6] },
        set: { grit: 0, drive: 0, kDecay: 1.1, kSub: 1.4, kPunch: 0.8, sBody: 0.8, sSnap: 1, hTone: 1, hDecay: 0.6, dEcho: 0.45, dTime: 2, dRoom: 0.3, dSmash: 0.3, dCrush: 0 } },
      voices: ['vox', 'bell', 'wave'], layers: [1, 0], levels: { bass: 1.25, arp: 1.1, pad: 0.36 }, kitStyle: { kickStyle: 2, snareStyle: 2, hatStyle: 0 },
      form: { intro: 1, verse1: 2, chorus1: 3, verse2: 2, bridge: 1, chorus2: 3, outro: 1 }, half: [], kit: KITS.reggae, fill: 'sticks', crash: 0.3,
      bass: BASS.drop, comp: COMP.skank, arp: { rule: 'off' }, lead: { art: 0.86 }, space: 1.2, master: { house: { arp: 4 }, lean: { weight: 0.6, warmth: 0.3 } },
    },
    jazz: {
      label: 'Jazz', blurb: 'Swung in triplets. Time is kept on the ride and the bass walks; the piano comments, the kick and snare only answer.',
      tempo: [104, 148], bend: 0.4, swing: [0, 0], shuffle: 0.85, voicing: 'ninth',
      sound: { pull: { bright: [0.5, 0.7], chorus: [0.15, 0.6], echo: [0.12, 0.7], sub: [0.3, 0.6], tilt: [0.15, 0.5], drumX: [0.4, 0.7] },
        set: { grit: 0, drive: 0, kPunch: 0.6, kDecay: 0.8, kSub: 0.8, sBody: 0.9, sSnap: 0.7, hTone: 0.9, hDecay: 1.6, dRoom: 0.3, dSmash: 0.2, dPunch: -0.2, dDrive: 0, dCrush: 0 } },
      voices: ['vox', 'bell', 'bow'], layers: [1, 0, 4], levels: { drums: 0.8, bass: 1.1, pad: 0.2, arp: 1.1 }, kitStyle: { kickStyle: 2, snareStyle: 0, hatStyle: 1 },
      form: { intro: 1, verse1: 2, chorus1: 2, verse2: 2, bridge: 1, chorus2: 3, outro: 1 }, half: [], kit: KITS.jazz, fill: 'brushes', crash: 0,
      bass: BASS.walk, comp: COMP.jazz, arp: { rule: 'off' }, lead: { art: 0.96 }, drone: 'off', duck: 0.3,
      master: { house: { arp: 4, drums: -4 }, dynamics: 1.3, lean: { warmth: 0.4, punch: -0.3 } },
    },
    bossa: {
      label: 'Bossa', blurb: 'A nylon guitar on the clave, a rim that answers it, a bass like a heartbeat, and a shaker that never stops.',
      tempo: [112, 138], bend: 0.35, swing: [0, 0], voicing: 'ninth',
      sound: { pull: { bright: [0.55, 0.7], chorus: [0.3, 0.5], echo: [0.2, 0.6], sub: [0.35, 0.6], drumX: [0.35, 0.7] },
        set: { grit: 0, drive: 0, kPunch: 0.7, kDecay: 0.9, hTone: 1, dRoom: 0.25, dSmash: 0.2, dDrive: 0, dCrush: 0 } },
      voices: ['vox', 'bell'], layers: [1, 0], levels: { drums: 0.75, arp: 1.15, pad: 0.22 }, kitStyle: { kickStyle: 2, snareStyle: 2, hatStyle: 2 },
      form: { intro: 1, verse1: 2, chorus1: 2, verse2: 2, bridge: 1, chorus2: 3, outro: 1 }, half: [], kit: KITS.bossa, fill: 'sticks', crash: 0,
      bass: BASS.bossa, comp: COMP.bossa, arp: { rule: 'off' }, lead: { art: 0.96 }, drone: 'off', duck: 0.3,
      master: { house: { arp: 5, drums: -4 }, dynamics: 1.2, lean: { warmth: 0.3, air: 0.2 } },
    },
    folk: {
      label: 'Folk', blurb: 'A foot on the floor and something shaken. A picked arpeggio when it is quiet, a strummed chord when it is not, a bass on alternate strings.',
      tempo: [84, 112], bend: 0.4, swing: [0, 0.1], voicing: 'triad',
      sound: { pull: { bright: [0.6, 0.6], chorus: [0.2, 0.5], echo: [0.2, 0.6], sub: [0.25, 0.6], drumX: [0.4, 0.7] },
        set: { grit: 0, drive: 0, kPunch: 0.8, kDecay: 1, dRoom: 0.25, dSmash: 0.2, dDrive: 0, dCrush: 0 } },
      voices: ['bow', 'bell', 'vox'], layers: [0, 1, 5], levels: { drums: 0.7, arp: 1.2, pad: 0.5 }, kitStyle: { kickStyle: 2, snareStyle: 2, hatStyle: 2 },
      form: { intro: 1, verse1: 1, chorus1: 2, verse2: 2, bridge: 1, chorus2: 3, outro: 1 }, half: [], kit: KITS.folk, fill: 'sticks', crash: 0,
      bass: BASS.alternate, comp: COMP.strum, arp: { rule: 'quiet', rate: { 1: 2, 2: 2, 3: 2 }, pat: 'pendulum', gate: 0.95, vel: 0.9 }, lead: { art: 0.96 },
      drone: 'off', duck: 0.3, master: { house: { arp: 5, drums: -3 }, dynamics: 1.3, lean: { warmth: 0.3 } },
    },
    chiptune: {
      label: 'Chiptune', blurb: 'Four channels and no reverb. Square waves, chords played as arpeggios too fast to count, a noise channel doing the drummer’s job.',
      tempo: [112, 150], bend: 0.35, swing: [0, 0], voicing: 'triad',
      sound: { pull: { bright: [0.9, 0.9], echo: [0.2, 0.6], sub: [0.2, 0.7], drumX: [0.3, 0.8] },
        set: { chorus: 0, sweep: 0, drift: 0, grit: 0.7, bits: 5, hold: 4, drive: 0, fold: 0, layer: 7, kDecay: 0.35, kSub: 0.5, kPunch: 1.6, kTone: 5, sBody: 0.3, sSnap: 1.6, sTone: 1.6,
          hTone: 1.8, hDecay: 0.4, dCrush: 0.6, dBits: 5, dHold: 4, dRoom: 0, dSmash: 0.2, dEcho: 0 } },
      voices: ['wave'], layers: [7], levels: { pad: 0.08, arp: 1.2, drums: 0.95 }, kitStyle: { kickStyle: 1, snareStyle: 3, hatStyle: 0 },
      form: FORM_ROCK, half: 'keep', kit: KITS.chiptune, fill: 'dry', crash: 0.3,
      bass: (N) => BASS.octaves(N, { x: { tone: 0.34, sub: 0 } }), comp: null,
      arp: { rule: 'always', rate: { 1: 1, 2: 1, 3: 0.5 }, pat: 'up', gate: 0.9, tones: 3, vel: 0.85 }, lead: { art: 0.8 },
      drone: 'off', space: 0.35, master: { noise: 9, house: { arp: 4 }, lean: { air: 0.3 } },
    },
    dembow: {
      label: 'Dembow', blurb: 'The kick walks in fours and the snare says boom-ch-boom-chick across it. A plucked chord with the snare, a bass with the kick.',
      tempo: [86, 100], bend: 0.3, swing: [0, 0.06], voicing: 'triad',
      sound: { pull: { bright: [0.6, 0.6], chorus: [0.3, 0.5], echo: [0.3, 0.5], sub: [0.75, 0.7], drumX: [0.6, 0.6] },
        set: { grit: 0, drive: 0, kDecay: 0.9, kSub: 1.3, kPunch: 1.2, sSnap: 1.3, hTone: 1.2, dSmash: 0.45, dRoom: 0.12, dCrush: 0 } },
      voices: ['vox', 'bell', 'wave'], layers: [0, 1, 2], levels: { drums: 1.08, bass: 1.15, pad: 0.85 }, kitStyle: { kickStyle: 3, snareStyle: 2, hatStyle: 0 },
      form: FORM_ROCK, half: [], kit: KITS.dembow, fill: 'dry', crash: 0.5,
      bass: BASS.dembow, comp: COMP.dembow, arp: { rule: 'off' }, lead: { art: 0.84 }, duck: 1.2, master: { house: { arp: 4 }, lean: { weight: 0.3, punch: 0.3 } },
    },
  };
  Object.keys(STYLES).forEach((id) => { STYLES[id].id = id; });
  Object.keys(ELEMENTS).forEach((id) => { ELEMENTS[id].id = id; });

  const styleOf = (id) => (STYLES[id] && id !== 'none' ? STYLES[id] : null);
  const elementOf = (id) => (ELEMENTS[id] && id !== 'aether' ? ELEMENTS[id] : null);

  /* ── §5f.8 COMPOSE: the style and the element laid over what the mood made ─ */

  /** Before any mood has spoken: remember what the sigil itself dealt. (The app calls this first of all 'compose' filters.) */
  function before(cfg) {
    cfg.own = { bpm: cfg.bpm, swing: cfg.P.swing, seventh: !!cfg.voicing.seventh, ninth: !!cfg.voicing.ninth };
    return cfg;
  }

  const mulLevels = (...all) => {
    let out = null;
    for (const L of all) if (L) { out = out || {}; for (const k of Object.keys(L)) out[k] = (out[k] ?? 1) * L[k]; }
    return out;
  };
  /** Hints for the master (05e), merged: noise adds (dB), tone/level/dynamics multiply, house offsets and leans add. */
  function mergeMaster(...all) {
    const out = {};
    for (const m of all) {
      if (!m) continue;
      if (m.noise != null) out.noise = (out.noise || 0) + m.noise;
      for (const k of ['tone', 'level', 'dynamics']) if (m[k] != null) out[k] = (out[k] ?? 1) * m[k];
      for (const k of ['house', 'lean']) if (m[k]) { out[k] = out[k] || {}; for (const q of Object.keys(m[k])) out[k][q] = (out[k][q] || 0) + m[k][q]; }
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * After the moods. Sets, on cfg: bpm (and `felt`), P.swing (to 0: the feel is applied to the whole
   * score instead), voicing, styleSound / soundMod, levels, kit, duck, space, hall, master, and
   * drums.feel (how Groove is to write the kit). `cfg.own` is what before() kept.
   */
  function compose(cfg, sigil, styleId, elementId) {
    const st = styleOf(styleId), el = elementOf(elementId);
    if (!st && !el) return cfg;
    const own = cfg.own || { bpm: cfg.bpm, swing: cfg.P.swing, seventh: !!cfg.voicing.seventh, ninth: !!cfg.voicing.ninth };
    if (st) cfg.style = st.id;
    if (el) cfg.element = el.id;
    const R = stream(sigil.hash, `style:${st ? st.id : 'none'}:${el ? el.id : 'aether'}`);
    const seed = (R.float() * 4294967296) >>> 0;                  // ⚠ draw order is frozen: seed, voice, layer

    /* tempo: the sigil's place in its own span, in the style's span; the mood's lean, damped; the element's */
    let bpm = cfg.bpm;
    if (st) {
      const u = clamp((own.bpm - 74) / 24, 0, 1), lean = cfg.bpm / own.bpm;
      bpm = (st.tempo[0] + u * (st.tempo[1] - st.tempo[0])) * Math.pow(lean, st.bend);
    }
    if (el && el.tempo) bpm *= el.tempo;
    cfg.bpm = clamp(Math.round(bpm), 40, 240);
    if (st && st.felt) cfg.felt = st.felt;

    /* who sings, and from which family of the cube: the style's, in the element's order, the sigil's pick of the first two */
    const prefer = (mine, order) => {
      const list = mine && order ? order.filter((x) => mine.includes(x)) : mine || order;
      return list && list.length ? list.slice(0, 2) : null;
    };
    const voices = prefer(st && st.voices, el && el.voices), layers = prefer(st && st.layers, el && el.layers);
    const voice = voices ? R.pick(voices) : null, layer = layers ? R.pick(layers) : null;

    const set = { ...((st && st.sound && st.sound.set) || {}) };
    if (voice) set.voice = voice;
    if (layer != null && set.layer == null) set.layer = layer;
    cfg.styleSound = { pull: (st && st.sound && st.sound.pull) || {}, set };
    if (el && el.mod) cfg.soundMod = el.mod;

    if (st) {
      /* the feel: the composer's swing, as far along the style's span as the sigil (or the mood) put it */
      const sw = st.swing[0] + (st.swing[1] - st.swing[0]) * clamp(cfg.P.swing / 0.3, 0, 1) + ((el && el.swing) || 0);
      cfg.P.swing = 0;                                            // the composer writes straight; parts() swings everything as one
      // The voicing is the style's unless a mood has changed it.
      if (!!cfg.voicing.seventh === own.seventh && !!cfg.voicing.ninth === own.ninth) {
        cfg.voicing = { seventh: st.voicing === 'seventh' || st.voicing === 'ninth', ninth: st.voicing === 'ninth' };
      }
      const feel = { id: st.id, seed, swing: +sw.toFixed(3), shuffle: st.shuffle || 0, shape: st.voicing === 'power' ? 'power' : null };
      feel.write = (m, sg, o) => writeKit(m, sg, o, feel);
      cfg.feel = feel;
      cfg.drums = { ...(cfg.drums || {}), feel };
      if (st.kitStyle) cfg.kit = st.kitStyle;
      if (st.duck != null) cfg.duck = st.duck;
    }
    cfg.levels = mulLevels(cfg.levels, st && st.levels, el && el.levels);
    const space = ((st && st.space) || 1) * ((el && el.space) || 1);
    if (space !== 1) cfg.space = space;
    if (el && el.hall) cfg.hall = el.hall;
    cfg.master = mergeMaster(cfg.master, st && st.master, el && el.lean ? { lean: el.lean } : null);
    return cfg;
  }

  /* ── §5f.9 PLAN: the style's contour, inside the mood's range ──────────── */

  /**
   * The mood has shaped the plan. The style now asks for its own contour (how loud a verse is
   * against a chorus, which sections fall to half-time), but only between the lowest and the
   * highest levels the mood left anywhere in the rite: a hush stays a hush, a drumless rite drumless.
   * cfg.moodHalf 'speed' says the mood's half-time was only there because it was fast (Ecstatic):
   * in a style that is not fast, it is let go.
   */
  function plan(sections, cfg) {
    // `sections` are those of whichever rite is performed (05g), each answering to its role's name
    // (`id`), with the roles the rite does not use standing by as shadows: so the range read here
    // is the mood's over all seven roles, whatever the rite's own form.
    const st = styleOf(cfg.style);
    if (!st) return sections;
    const body = sections.filter((s) => s.id !== 'intro' && s.id !== 'outro');
    const all = sections.map((s) => s.intensity | 0);
    const hi = Math.max(...all), floor = Math.min(...all);
    const hadArp = sections.some((s) => s.arp), droneAll = sections.every((s) => s.drone);
    // Half-time in more than the Reversal is the mood's doing, and is kept, unless it was only there for speed.
    // (Counted by name: in a rite of another form, 05g, several sections may all be "the Reversal".)
    const forSpeed = cfg.moodHalf === 'speed' && cfg.bpm * (cfg.felt || 1) < 126;
    const moodHalf = new Set(body.filter((s) => s.halfTime).map((s) => s.id)).size > 1 && !forSpeed;
    for (const s of sections) {
      const want = st.form && st.form[s.id];
      const edge = s.id === 'intro' || s.id === 'outro';
      if (want != null) s.intensity = clamp(want, floor, hi);
      if (!moodHalf && Array.isArray(st.half)) s.halfTime = st.half.includes(s.id) && s.intensity > 0;
      else if (forSpeed) s.halfTime = s.id === 'bridge' && s.intensity > 0;
      const a = st.arp || { rule: 'keep' };
      if (a.rule === 'off') s.arp = null;
      else if (a.rule === 'always' && hadArp && s.intensity > 0) s.arp = s.intensity >= 3 ? 'full' : 'light';
      else if (a.rule === 'quiet' && hadArp) s.arp = s.intensity > 0 && s.intensity <= 2 ? 'light' : null;
      if (st.drone === 'off' && !droneAll && !edge) s.drone = false;
      if (st.drone === 'on' && s.intensity > 0) s.drone = true;
    }
    return sections;
  }

  /* ── §5f.10 THE KIT WRITER (called by Groove.write when a song has a feel) ─ */

  /**
   * The drum part of a styled song. The same measure, polygons, letters, amounts and fills as 05c;
   * what is struck in a plain bar is the style's (KITS). Returns { events, info } as Groove.write does;
   * info.kicks maps each bar (by its number in the song) to the steps its kick fell on, for the bass.
   */
  function writeKit(m, sigil, o, feel) {
    const st = STYLES[feel.id], kit = st.kit, F = FILLS[st.fill || 'rock'];
    const v = clamp(+o.variation || 0, 0, 1), f = clamp(+o.fills || 0, 0, 1);
    const g = clamp(+o.ghosts || 0, 0, 1), hu = clamp(+o.human || 0, 0, 1);
    const P = m.P, D = G.dna(sigil, P, o.take | 0), seed = (D.seed ^ feel.seed) >>> 0;
    const nodes = sigil.nodes, n = nodes.length;
    const isFour = !!o.steady && P.kick.filter(Boolean).length === 4 && [0, 4, 8, 12].every((s) => P.kick[s]);
    const flamBeats = (0.03 * (m.bpm || 90)) / 60, fast = (m.bpm || 90) * (st.felt || 1) > 150;
    const lay = st.lay || 1, crashVel = st.crash ?? 0.7;
    const W = (tick) => warp(tick / TPB, feel.swing, feel.shuffle);
    const ev = [], said = [], kicksAt = {};
    let turnCursor = 0, fills = 0;

    m.sections.forEach((sec, si) => {
      const I = sec.intensity | 0, half = !!sec.halfTime, T = sec.T || ID;
      const kick = G.anchor(G.turn(D.kick, T)), hat = G.turn(D.hat, T), ghost = G.turn(D.ghost, T);
      sec.rhythm = null;
      const next = m.sections[si + 1], kind = G.boundary(sec, next);
      // A section without a kit is silent here, unless this idiom builds into what follows (a breakdown before a drop).
      const buildsUp = !!F.roll && !!next && next.intensity >= 3 && f >= 0.12;
      if (I <= 0 && !buildsUp) return;
      const phrases = m.phrases.filter((p) => p.si === si);
      const bars = Math.round((sec.phrases || phrases.length || 1) * 4);
      const say = G.recite(sigil, T);
      if (I >= 3 && crashVel > 0) ev.push({ beat: sec.start, type: 'crash', vel: crashVel });

      for (let bar = 0; bar < bars; bar++) {
        const t0 = sec.start + bar * 4, pb = bar % 4, phi = bar >> 2, ab = Math.round(t0 / 4);
        const answer = pb === 1 || pb === 3, sectionEnd = bar === bars - 1;
        const N = (step, ch) => G.noise(seed, ab, step, ch);
        const vv = clamp(v * (bars > 4 ? 0.7 + (0.6 * phi) / ((bars >> 2) - 1) : 1), 0, 1);
        // how much of the bar's end the fill takes: the boundary's asking, the listener's Fills, the idiom's limit
        let width = pb === 3 ? G.fillWidth(I, kind, sectionEnd, f, N(0, CH.turn)) : 0;
        const build = F.roll && sectionEnd && kind === 'rise' && f >= 0.12;
        if (build) width = f >= 0.5 ? 16 : 8; else width = Math.min(width, F.max);
        const from = 16 - width, keepBack = width > 0 && !build && (kind === 'turn' || kind === 'fall' || !sectionEnd);

        const hits = new Map();
        const putT = (tick, type, vel, x) => {
          if (tick >= from * 6 && !(x && (x.keep || x.fill))) return;
          if (tick < 0 || tick >= BAR) return;
          const key = `${type}|${x && x.tom != null ? x.tom : ''}|${x && x.grace ? 'g' : ''}|${tick}`, old = hits.get(key);
          if (old && old.vel >= vel) return;
          hits.set(key, { tick, type, vel, ...(x || {}) });
        };
        const letterAt = (s) => nodes[mod(Math.round(t0 * 4) + s, n)];
        const lands = new Set(), ph = phrases[phi];
        if (ph && ph.notes) for (const nt of ph.notes) { const s = (nt.start - pb * 4) * 4; if (!nt.passing && s >= 0 && s < 16) lands.add(Math.round(s)); }

        const B = {
          I, half, pb, phi, answer, sectionEnd, from, kick, hat, ghost, D, lands, keepBack,
          v: vv, g, four: isFour, free: o.steady ? 0 : 1, N,
          w: (s) => 1 + (letterAt(s).ring - 1) * 0.12, ring: (s) => letterAt(s).ring,
          put: (s, type, vel, x) => putT(S(s), type, vel, x), putT,
          /* The polygon's own syncopations (every vertex but the downbeat), each moved to the nearest
             step this idiom allows; the nearest ones first. The polygon chooses, the idiom permits. */
          sync(allowed, max) {
            if (max <= 0) return [];
            const found = [];
            for (let s = 1; s < 16; s++) {
              if (!kick[s]) continue;
              let best = -1, bd = 99;
              for (const a of allowed) { const d = Math.min(mod(a - s, 16), mod(s - a, 16)); if (d < bd || (d === bd && a > best)) { bd = d; best = a; } }
              if (best >= 0 && !found.some((q) => q.s === best)) found.push({ s: best, d: bd, at: allowed.indexOf(best) });
            }
            found.sort((a, b) => a.d - b.d || a.at - b.at);
            const out = found.slice(0, max).map((q) => q.s);
            if (!out.length) out.push(allowed[0]);                // a polygon that is all downbeat still gets the idiom's first lean
            return out;
          },
        };
        if (I > 0) kit(B);
        if (I > 0 && isFour && !half) {                                    // the mood's four-on-the-floor outranks the idiom's kick
          for (const k of [...hits.keys()]) if (k.startsWith('kick|')) hits.delete(k);
          for (const s of [0, 4, 8, 12]) if (s < from) putT(S(s), 'kick', s ? 0.9 : 0.96);
        }
        // what the bass will follow, and what §7 draws at the hub
        const ks = [...hits.values()].filter((h) => h.type === 'kick' && h.tick % 6 === 0 && !h.fill).map((h) => h.tick / 6).sort((a, b) => a - b);
        kicksAt[ab] = ks;
        if (bar === 0 && I > 0) {
          const rk = new Array(16).fill(false), rh = new Array(16).fill(false);
          for (const h of hits.values()) {
            if (h.tick % 6) continue;
            if (h.type === 'kick') rk[h.tick / 6] = true;
            else if (h.type === 'hat' || h.type === 'ride' || h.type === 'shaker') rh[h.tick / 6] = true;
          }
          sec.rhythm = { kick: rk, hat: rh.some(Boolean) ? rh : hat };
        }

        /* ── the fill: the kit speaks the sigil, in this idiom's own voice ── */
        if (width > 0) {
          fills++;
          const put = (s, type, vel, x) => putT(S(s), type, vel, { ...(x || {}), fill: true });
          if (build) {
            /* A build: the snare doubles its rate as the bar runs out, over a swell of noise, and the kick lets go. */
            let tick = from * 6;
            const end = BAR, span = end - tick;
            while (tick < end) {
              const pos = (tick - from * 6) / span, stepT = pos < 0.5 ? 12 : pos < 0.75 || fast ? 6 : 3;
              putT(tick, 'snare', 0.3 + 0.6 * pos, { fill: true });
              if (pos >= 0.5 && tick % 12 === 0) putT(tick, 'clap', 0.4 + 0.4 * pos, { fill: true });
              tick += stepT;
            }
            const lead = bar >= 1 && width >= 16 ? 4 : 0;         // the swell starts a bar early when there is a bar to start it in
            if (next && next.intensity >= 3) ev.push({ beat: t0 - lead, type: 'swell', dur: 4 + lead, vel: 0.8 });
            for (let j = 0; j < width && j < say.seq.length; j += 4) said.push({ beat: t0 + W(S(from + j)), slot: say.seq[j % say.seq.length].slot, ring: say.seq[j % say.seq.length].ring });
          } else {
            let cur = sectionEnd ? 0 : turnCursor;
            const slots = new Array(width).fill(true);
            if (width > 2 && I === 2) { const H = clamp(Math.round(width * (0.5 + 0.35 * f)), 2, width); euclid(H, width, 0).forEach((on, j) => (slots[width - 1 - j] = on)); }
            else if (width > 2 && I === 1) slots.forEach((_, j) => (slots[j] = (width - 1 - j) % 2 === 0));
            if (kind === 'dissolve') slots[width - 1] = false;
            let last = null;
            for (let j = 0; j < width; j++) {
              if (!slots[j]) continue;
              const s = from + j, nd = say.seq[cur++ % say.seq.length], lb = G.limb(nd, say.flip);
              let type = lb.type;
              if (F.map && type in F.map) type = F.map[type];
              if (type === null) continue;                        // in this idiom that letter is a rest
              const pos = width > 1 ? j / (width - 1) : 1;
              const shape = kind === 'rise' ? lerp(0.62, 1.08, pos) : kind === 'fall' ? lerp(1, 0.72, pos) : kind === 'dissolve' ? lerp(0.85, 0.42, pos) : lerp(0.78, 1, pos);
              let vel = lb.vel * shape * (1 + (lb.ring - 1) * 0.08) * (F.soft || 1);
              const x = {};
              if (type === 'tom') x.tom = lb.tom;
              if (type === 'hat') { x.open = !!lb.open && j === width - 1; x.pan = (N(s, CH.hatPan) - 0.5) * 0.6; }
              if (I === 1 && type === 'snare') { type = 'rim'; vel *= 0.62; }
              if (kind === 'dissolve' && type === 'snare') { type = 'rim'; vel *= 0.7; }
              put(s, type, clamp(vel * (1 + (N(s, CH.fillVel) - 0.5) * 0.1), 0.08, 1), x);
              said.push({ beat: t0 + W(S(s)), slot: nd.slot, ring: nd.ring });
              last = { s, type };
            }
            if (!sectionEnd) turnCursor = cur;
            if (kind === 'rise' && sectionEnd) {
              for (let j = 0; j < 4; j++) put(12 + j, 'snare', (0.3 + 0.15 * j) * (F.soft || 1));
              if (width >= 8 && I >= 2 && !F.soft) for (let s = from; s < 16; s += 4) put(s, 'kick', 0.7);
              if ((next && next.intensity >= 3) || G.struck(sec)) ev.push({ beat: t0, type: 'swell', dur: 4, vel: 0.8 });
            } else if (sectionEnd && kind !== 'dissolve' && last && (last.type === 'hat' || last.type === 'shaker' || last.type === 'ride') && !F.soft) {
              put(last.s, I === 1 ? 'rim' : 'snare', I === 1 ? 0.4 : 0.7);     // arrive on something with a body
            } else if (kind === 'dissolve' && sectionEnd) {
              put(14, 'kick', 0.45);
            }
            if (sectionEnd && width >= 8 && next && next.intensity === 2 && crashVel > 0) ev.push({ beat: t0 + 4, type: 'crash', vel: crashVel * 0.65 });
          }
        }

        /* ── hits → events: the feel, and the drummer's hand ── */
        for (const h of hits.values()) {
          const ch = h.type.charCodeAt(0) + (h.tom || 0), p2 = Math.round(h.tick / 3);
          let t = t0 + W(h.tick), vel = h.vel;
          if (h.grace) t -= flamBeats;
          if (hu > 0 && !(h.type === 'kick' && (h.tick === 0 || isFour))) {
            if (h.type !== 'kick') t += (G.noise(seed, ab, p2 + 64, CH.time + ch) - 0.5) * 0.024 * hu;
            if (h.back) t += D.lay * (half ? 0.02 : 0.012) * hu * lay;
            vel *= 1 + (G.noise(seed, ab, p2 + 64, CH.vel + ch) - 0.5) * 0.16 * hu;
          }
          if (h.type === 'crash') { ev.push({ beat: Math.max(0, t), type: 'crash', vel: clamp(vel, 0.05, 1) }); continue; }
          const e = { beat: Math.max(0, t), type: h.type, vel: clamp(vel, 0.05, 1) };
          if (h.type === 'hat' || h.type === 'ride') { e.open = !!h.open; e.pan = h.pan || 0; }
          if (h.type === 'tom') e.tom = h.tom | 0;
          if (h.fill) e.fill = true;
          ev.push(e);
        }
      }
      // A rite that ends at its height (05g) is struck, in this idiom's own weight: its kick, and its crash if it has one.
      for (const e of lastStroke(sec, sec.start + bars * 4)) {
        if (e.type === 'crash') { if (crashVel > 0) ev.push({ ...e, vel: Math.min(1, e.vel * (crashVel / 0.7)) }); }
        else ev.push({ ...e, vel: e.vel * (F.soft || 1) });
      }
    });

    const total = m.total || Infinity;
    const events = ev.filter((e) => e.beat < total && e.beat >= 0);
    events.sort((a, b) => a.beat - b.beat);
    return {
      events,
      info: { take: o.take | 0, variation: v, fills: f, ghosts: g, human: hu, steady: !!o.steady, style: feel.id,
        kick: D.kick.filter(Boolean).length, hat: D.hat.filter(Boolean).length, ghost: D.ghost.filter(Boolean).length,
        nFills: fills, nEvents: events.length, said, kicks: kicksAt },
    };
  }

  /* ── §5f.11 PARTS: the rest of the band, and the feel over everyone ────── */

  /**
   * The 'score' filter body for a styled song (after the kit has been written). Re-plays the bass,
   * lays the chords, re-rates the arpeggio, re-voices the pad, phrases the lead, then applies the
   * feel (swing, shuffle) to every note of every part, and to the pen's own timetable.
   * ctx = { sigil, cfg, sections, phrases, total }. Returns a new, unsorted array.
   */
  function parts(events, ctx) {
    const cfg = ctx.cfg, feel = cfg.feel, st = feel && STYLES[feel.id];
    if (!st) return events;
    const k = ctxOf(cfg), tag = st.id, out = [];
    const kicksAt = (cfg.groove && cfg.groove.kicks) || {};
    const arpRule = (st.arp && st.arp.rule) || 'keep', reArp = arpRule !== 'keep' || !!(st.arp && (st.arp.rate || st.arp.pat));

    /* what stays, re-phrased */
    for (const e of events) {
      if (e.type === 'bass' && st.bass && !e.last) continue;        // (the last note of a rite that ends struck is kept: 05 §5.6)
      if (e.type === 'arp' && reArp) continue;
      if (e.type === 'pad') {
        const p = st.pad || {};
        const x = { ...e };
        if (p.shape && e.chord != null) { x.shape = p.shape; x.midis = padMidis(p.shape, e.chord, k, cfg.voicing); x.st = tag; }
        out.push(x);
        continue;
      }
      if ((e.type === 'lead' || e.type === 'harm') && st.lead) {
        out.push({ ...e, dur: Math.max(0.12, e.dur * (st.lead.art ?? 1)) });
        continue;
      }
      out.push(e);
    }

    /* bar by bar */
    const bars = [];
    ctx.phrases.forEach((ph) => {
      const sec = ctx.sections[ph.si], lastPh = !ctx.phrases.some((q) => q.si === ph.si && q.start > ph.start);
      for (let b = 0; b < 4; b++) bars.push({ t0: ph.start + b * 4, c: ph.chords[b], sec, pb: b, last: b === 3, sectionEnd: lastPh && b === 3 });
    });
    bars.forEach((bar, i) => {
      const { t0, c, sec, pb } = bar, c2 = i + 1 < bars.length ? bars[i + 1].c : c;
      const I = sec.intensity | 0, half = !!sec.halfTime, ab = Math.round(t0 / 4);
      const T = sec.T || ID, N = (step, ch) => G.noise(feel.seed, ab, step, ch + 40);
      const base = { I, half, pb, last: bar.last, answer: pb === 1 || pb === 3, c, N };

      if (st.bass && sec.bass) {
        const noteT = (tick, role, beats, vel, x) => {
          const basic = role === 'fifth' || role === 'oct' ? role : 'root';
          const e = { beat: t0 + tick / TPB, type: 'bass', midi: bassMidi(c, role, k, c2), dur: beats, vel, chord: c, role: basic, srole: role, st: tag };
          if (role === 'app') e.chord2 = c2;
          if (x) { if (x.tone != null) e.tone = x.tone; if (x.sub != null) e.sub = x.sub; if (x.slide) e.slide = true; }
          out.push(e);
        };
        st.bass({ ...base, kicks: kicksAt[ab] || [0], poly: G.turn(cfg.P.bass, T), note: (s, role, beats, vel, x) => noteT(S(s), role, beats, vel, x), noteT });
      }

      if (st.comp && I > 0) {
        st.comp({ ...base, hatP: G.turn(cfg.P.hat, T), ghostP: G.turn(cfg.P.ghost, T),
          chord(s, beats, vel, x) {
            // (a chord on bells rings on after it is struck: three notes of it are enough, and keep the voice pool free)
            const tones = chordTones(x.shape, c, k, cfg.voicing.ninth), top = Math.min(x.top || (x.voice === 'bell' ? 3 : 9), tones.length);
            const strum = x.strum || 0;
            for (let j = 0; j < top; j++) {
              const order = strum < 0 ? top - 1 - j : j;
              const e = { beat: t0 + (S(s) + order * Math.abs(strum)) / TPB, type: 'comp', midi: tones[j] + (x.add || 0), dur: beats,
                vel: vel * (1 - 0.06 * j), pan: (j / Math.max(1, top - 1) - 0.5) * 0.5, voice: x.voice || 'wave', bus: x.bus || 'arp',
                chord: c, k: j, shape: x.shape, ninth: !!cfg.voicing.ninth, st: tag };
              if (x.add) e.add = x.add;
              if (x.bright != null) e.bright = x.bright;
              out.push(e);
            }
          } });
      }

      if (reArp && sec.arp) {
        const a = st.arp, rate = ((a.rate && a.rate[clamp(I, 1, 3)]) || (sec.arp === 'full' ? 1 : 2)) * 0.25;   // beats per note
        const pat = ARP_PATTERNS[a.pat || cfg.P.arp] || ARP_PATTERNS.up, tonesN = a.tones || 5;
        const tones = arpTones(c, k.scale, k.leadBase), steps = Math.round(4 / rate);
        for (let j = 0; j < steps; j++) {
          const idx = pat[(j + pb * steps) % pat.length] % tonesN;
          out.push({ beat: t0 + j * rate, type: 'arp', midi: tones[idx] + (a.add || 0), dur: rate * (a.gate ?? 0.9),
            vel: (sec.arp === 'full' ? 0.8 : 0.6) * (a.vel ?? 1) * (j % Math.round(1 / rate) === 0 ? 1 : 0.78), pan: ((j % 4) / 3 - 0.5) * 0.8,
            chord: c, idx, st: tag, ...(a.add ? { add: a.add } : {}) });
        }
      }
    });

    /* a bass that slides arrives FROM the note before it */
    const bass = out.filter((e) => e.type === 'bass' && e.st === tag).sort((a, b) => a.beat - b.beat);
    bass.forEach((e, i) => { if (e.slide && i > 0) e.from = bass[i - 1].midi; });

    /* the feel, over everyone (the kit has applied it to itself), and over the pen's timetable */
    if (feel.swing > 0 || feel.shuffle > 0) {
      const wb = (x) => warp(x, feel.swing, feel.shuffle);
      for (let i = 0; i < out.length; i++) {
        const e = out[i];
        if (G.TYPES.has(e.type) || e.type === 'pad' || e.type === 'drone') continue;
        const b = wb(e.beat);
        if (e.dur != null && e.dur < 2) e.dur = Math.max(0.05, wb(e.beat + e.dur) - b);
        e.beat = b;
      }
      for (const ph of ctx.phrases) {
        for (const nd of ph.path) nd.beat = wb(nd.beat);
        for (const pp of ph.partners || []) for (const nd of pp.path) nd.beat = wb(nd.beat);
      }
    }
    return out;
  }

  /** Kit and parts in one call: the whole 'score' filter, for a host without the modules (tests, Node). */
  function score(events, ctx, opts) {
    if (!ctx.cfg.feel) return events;
    const withKit = G.score(events, ctx, { ...(opts || {}), ...(ctx.cfg.drums || {}) });
    return parts(withKit, ctx);
  }

  /* ── §5f.12 WORDS ──────────────────────────────────────────────────────── */

  /** "Trap · Water" for a HUD; '' when neither is in force. */
  function describe(cfg) {
    const st = styleOf(cfg && cfg.style), el = elementOf(cfg && cfg.element);
    return [st && st.label, el && el.label].filter(Boolean).join(' · ');
  }
  /** The tempo as it is felt: "88 bpm · felt 176". */
  const felt = (cfg, bpm) => (cfg && cfg.felt && cfg.felt !== 1 ? Math.round(bpm * cfg.felt) : 0);

  return {
    STYLES, ELEMENTS, KITS, BASS, COMP, FILLS, TPB,
    styleOf, elementOf, before, compose, plan, parts, score, writeKit,
    warp, pitch, bassMidi, chordTones, padMidis, describe, felt, mergeMaster,
  };
})();

if (typeof window !== 'undefined') window.Style = Style;
