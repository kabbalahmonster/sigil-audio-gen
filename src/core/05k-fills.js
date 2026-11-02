'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5k  FILLS — what a drummer does at the end of a phrase · pure, deterministic, no audio context
   --------------------------------------------------------------------------
   The kit used to have one way to fill: say the sigil's letters, as drums (05c `recite`). It is a good idea and it is
   kept: it is what makes a sigil's kit its own. But a whole song of it is one trick told again and again. A drummer
   has a dozen; which one, depends on where the music is going and what the bar before it was doing:

     recite    the sigil's name, said on the kit (the writers do this one themselves: it needs the letters)
     cascade   the toms, high to low (or low to high, into a rise), a few strokes of snare before them
     roll      the snare, accelerating: eighths, sixteenths, thirty-seconds, and louder
     flams     grace notes: snare flams with the toms between them, building
     stutter   the kick in sixteenths, a double-pedal run, then the snare
     tumble    a Euclidean figure over the toms and the hand-drums, ending on a stroke
     stoptime  everything stops: a unison hit on the first step, air, and a pickup into the next bar
     hatsweep  hats (or a shaker, when it is quiet) crescendo-ing into an open hat
     clave     hand-drums in a 3-3-2, with a side-stick on the end
     gallop    the dotted-eighth-sixteenth gallop on snare over a kick
     claps     hands, speeding up towards the end
     flutter   ghost notes: a breath of snare under the hands, one accent, a side-stick
     (and two steps wide, a turn is one of a handful of tags: a pair of toms, a flam, kick-snare, hand-drums…)

   A fill is chosen by STATELESS noise keyed by where it falls (the bar's number and a channel of its own), from weights
   that depend on the width of the fill, the section's intensity, the way the boundary goes (a rise, a fall, a turn, a
   dissolve), the idiom of the kit and the style. It is therefore the same fill, for the same song, every time; and moving
   the Fills slider (a threshold on WIDTH) does not re-deal the ones that stay.

   A figure is written as a list of hits: { s (the sixteenth in the bar, multiples of ½), type, vel, tom | pi, open, pan,
   grace }. `perc` is a type of its own: a hand-drum (pi 0…2: the three pitches of the chord) that the palette plays in
   the world's own instrument (05j), and the cube's kit plays as a high tom. The two writers (05c, 05f) put the hits where
   they are bound to.

   Nothing here touches the composer's `R`.
   ══════════════════════════════════════════════════════════════════════════ */

const Fills = (() => {
  'use strict';

  /** Noise channels (05c's are 1…16). */
  const CH = { pick: 20, vel: 21, pan: 22, flavour: 23, tag: 24 };

  /** The figures, in the order they are drawn from (⚠ append only: a weight is found by position). */
  const FIGURES = ['recite', 'cascade', 'roll', 'flams', 'stutter', 'tumble', 'stoptime', 'hatsweep', 'clave', 'gallop', 'claps', 'flutter'];
  const TAGS = ['pairTom', 'flamSnare', 'kickSnare', 'percPair', 'rimRim', 'hatOpen'];

  /** What each idiom of kit (05f FILLS) leans towards: a multiplier on a figure's weight (1 when not named). */
  const IDIOM = {
    rock: {},
    dry: { tumble: 0.5, cascade: 0.5 },
    sticks: { flutter: 2, clave: 1.6, hatsweep: 1.3, roll: 0.5, cascade: 0.3, stutter: 0, gallop: 0, claps: 0.4, flams: 0.5 },
    drop: { stoptime: 2.6, stutter: 1.5, tumble: 0.3, cascade: 0.25, clave: 0.4, hatsweep: 0.6 },
    machine: { roll: 1.6, stutter: 1.6, claps: 1.6, tumble: 0.5, cascade: 0.5, flams: 0.3, clave: 0.5 },
    brushes: { flutter: 2.2, clave: 1.3, hatsweep: 1.2, roll: 0.6, cascade: 0.4, flams: 0.3, stutter: 0, gallop: 0 },
  };
  /** …and each style, on top. */
  const STYLE = {
    metal: { gallop: 3, stutter: 2, cascade: 1.3, clave: 0.2, flutter: 0.3 },
    punk: { gallop: 1.6, flams: 0.7, roll: 1.2, clave: 0.3 },
    grunge: { cascade: 1.3, flams: 1.2, gallop: 0.6 },
    edm: { claps: 2.6, roll: 1.5, stoptime: 1.3 },
    house: { claps: 2, clave: 1.6, hatsweep: 1.4 },
    techno: { roll: 1.3, stutter: 1.3, hatsweep: 1.4 },
    dnb: { roll: 1.5, flams: 1.4, tumble: 1.2 },
    trap: { roll: 1.7, stutter: 1.2, stoptime: 1.3 },
    hiphop: { stoptime: 1.5, flutter: 1.2, clave: 1.1 },
    lofi: { flutter: 1.6, stoptime: 1.2, clave: 1.2 },
    funk: { flams: 1.6, flutter: 1.5, clave: 1.4, tumble: 1.2 },
    reggae: { clave: 2, stoptime: 1.6, cascade: 0.6 },
    jazz: { flutter: 2, flams: 1.5, tumble: 1.4, cascade: 0.8 },
    bossa: { clave: 2.6, flutter: 1.2 },
    dembow: { clave: 1.9, claps: 1.3, roll: 0.8 },
    folk: { clave: 1.3, cascade: 0.8 },
    chiptune: { roll: 1.5, gallop: 1.3, stutter: 1.2 },
    pop: { claps: 1.5, cascade: 1.1 },
    synthwave: { cascade: 1.6, roll: 1.2 },
  };

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  /** The weight of each figure in this place. 0 = not here. */
  function weights(c) {
    const { W, I, kind } = c, wide = W >= 4, quiet = I <= 1, loud = I >= 3;
    const rise = kind === 'rise', fall = kind === 'fall', dissolve = kind === 'dissolve';
    const w = {
      recite: c.noRecite ? 0 : 1.7,
      cascade: wide && !quiet ? (1 + (fall || kind === 'turn' ? 0.3 : 0)) : 0,
      roll: wide && !quiet ? (rise ? 1.7 : dissolve ? 0 : 0.5) : wide && W >= 8 && rise ? 0.6 : 0,
      flams: wide && !quiet && !c.half ? 0.8 : 0,
      stutter: wide && loud && !c.half ? (rise ? 1.1 : 0.3) : 0,
      tumble: wide ? (quiet ? 0.5 : 0.9) : 0,
      stoptime: wide && !quiet && !rise ? (dissolve ? 0.4 : 0.7) : 0,
      hatsweep: wide ? (quiet ? 1.2 : 0.6) * (dissolve ? 1.5 : 1) : 0,
      clave: wide ? (loud ? 0.4 : 1) : 0,
      gallop: wide && loud && !c.half ? 0.5 : 0,
      claps: wide && !quiet ? 0.4 : 0,
      flutter: wide && !loud ? 0.8 : 0,
    };
    const idiom = IDIOM[c.idiom] || {}, style = STYLE[c.style] || {};
    for (const k of FIGURES) if (k !== 'recite') w[k] *= (idiom[k] ?? 1) * (style[k] ?? 1);
    // a bar that has been said before is said again less: the kit does not say its name twice running
    if (c.recent === 'recite') w.recite *= 0.35;
    return w;
  }

  /** Which figure fills this place: 'recite' (the writer's own), or one of FIGURES, or, for a turn two steps wide, a tag. */
  function choose(c) {
    const u = c.N(0, CH.pick);
    if (c.W < 4) {
      const ok = TAGS.filter((t) => !(c.I <= 1 && (t === 'kickSnare' || t === 'flamSnare' || t === 'hatOpen')));
      const tags = ['recite', ...ok], wt = tags.map((t, i) => (i === 0 ? (c.noRecite ? 0 : 1.3) : 1));
      let x = u * wt.reduce((a, b) => a + b, 0);
      for (let i = 0; i < tags.length; i++) { x -= wt[i]; if (x < 0) return tags[i]; }
      return c.noRecite ? 'rimRim' : 'recite';
    }
    const w = weights(c);
    let total = 0;
    for (const k of FIGURES) total += w[k];
    let x = u * total;
    for (const k of FIGURES) { x -= w[k]; if (x < 0) return k; }
    return c.noRecite ? 'hatsweep' : 'recite';
  }

  /* ── the figures ───────────────────────────────────────────────────────── */

  /** How loud a hit is, along the fill (0…1), by the way the boundary goes. */
  const shape = (kind, pos) => (kind === 'rise' ? lerp(0.62, 1.08, pos) : kind === 'fall' ? lerp(1, 0.72, pos)
    : kind === 'dissolve' ? lerp(0.85, 0.42, pos) : lerp(0.78, 1, pos));

  const FIG = {
    cascade(c, hit) {
      const { W, from, kind } = c, up = kind === 'rise', lead = W >= 16 ? 4 : W >= 8 ? 2 : 0, m = W - lead;
      for (let j = 0; j < lead; j++) hit(from + j, 'snare', 0.42 + 0.08 * j);
      for (let j = 0; j < m; j++) {
        const k = Math.min(2, Math.floor((3 * j) / m)), idx = up ? k : 2 - k, last = j === m - 1;
        if (last && W >= 4) { hit(from + lead + j, up ? 'snare' : 'tom', up ? 0.9 : 0.86, up ? {} : { tom: 0 }); if (!up) hit(from + lead + j, 'kick', 0.8); }
        else hit(from + lead + j, 'tom', 0.7 + 0.18 * ((j + 1) / m), { tom: idx });
      }
    },
    roll(c, hit) {
      const { W, from, fast } = c;
      let s = 0;
      while (s < W) {
        const pos = s / W, step = W < 4 ? 1 : pos < 0.5 ? 2 : pos < 0.75 || fast ? 1 : 0.5;
        hit(from + s, 'snare', 0.3 + 0.6 * pos);
        s += step;
      }
      if (W >= 8 && c.I >= 3) for (let q = from; q < from + W; q += 4) hit(q, 'kick', 0.6);
    },
    flams(c, hit) {
      const { W, from } = c;
      for (let j = 0; j < W; j += 2) {
        const v = 0.5 + 0.35 * (j / W);
        hit(from + j, 'snare', v * 0.34, { grace: true }); hit(from + j, 'snare', v);
        if (j + 1 < W) hit(from + j + 1, 'tom', 0.5 + 0.25 * (j / W), { tom: Math.min(2, (j >> 1) % 3) });
      }
      hit(from + W - 1, 'snare', 0.82); hit(from + W - 1, 'kick', 0.8);
    },
    stutter(c, hit) {
      const { W, from } = c, half = Math.floor(W / 2);
      for (let j = 0; j < half; j++) if (j % 2 === 0) hit(from + j, 'hat', 0.5);
      for (let j = half; j < W - 1; j++) hit(from + j, 'kick', 0.5 + 0.4 * ((j - half) / Math.max(1, W - 1 - half)));
      hit(from + W - 1, 'snare', 0.9);
    },
    tumble(c, hit) {
      const { W, from, N } = c, ks = [3, 5, 6, 7].filter((k) => k < W), k = ks[Math.floor(N(1, CH.flavour) * ks.length)] || 3;
      const on = euclid(k, W, 0), pat = new Array(W).fill(false);
      on.forEach((x, j) => (pat[W - 1 - j] = x));            // a figure that ENDS on a stroke
      let i = 0;
      const n = pat.filter(Boolean).length, perc0 = N(2, CH.flavour) < 0.5 ? 0 : 1;
      pat.forEach((x, j) => {
        if (!x) return;
        const idx = clamp(2 - Math.floor((3 * i) / n), 0, 2), v = 0.6 + 0.25 * ((i + 1) / n);
        if ((i + perc0) % 2) hit(from + j, 'perc', v, { pi: idx }); else hit(from + j, 'tom', v, { tom: idx });
        i++;
      });
    },
    stoptime(c, hit) {
      const { W, from } = c;
      hit(from, 'snare', 0.88); hit(from, 'kick', 0.9);
      if (W >= 16) hit(from + 8, 'rim', 0.3);
      if (W >= 8) hit(from + W - 2, 'snare', 0.3);
      hit(from + W - 1, 'snare', W >= 8 ? 0.58 : 0.42);
    },
    hatsweep(c, hit) {
      const { W, from, kind, N, I } = c, type = I <= 1 ? 'shaker' : 'hat';
      for (let j = 0; j < W; j++) {
        const pos = j / Math.max(1, W - 1), v = kind === 'rise' ? lerp(0.28, 0.85, pos) : kind === 'fall' || kind === 'dissolve' ? lerp(0.7, 0.3, pos) : lerp(0.38, 0.76, pos);
        const x = type === 'hat' ? { pan: (N(from + j, CH.pan) - 0.5) * 0.6 } : {};
        if (j === W - 1 && type === 'hat' && kind !== 'dissolve') x.open = true;
        hit(from + j, type, v, x);
        if (W >= 8 && I >= 3 && !c.fast && j >= W - 4 && j < W - 1) hit(from + j + 0.5, type, v * 0.7, x);   // the last beat doubles
      }
      if (I >= 2 && kind !== 'dissolve') hit(from + W - 1, 'kick', 0.66);
    },
    clave(c, hit) {
      const { W, from } = c;
      const at = W >= 16 ? [0, 3, 6, 8, 11, 14, 15] : W >= 8 ? [0, 3, 6, 7] : [0, 3];
      at.forEach((j, i) => {
        const last = i === at.length - 1;
        if (last && W >= 8) hit(from + j, 'rim', 0.5);
        else hit(from + j, 'perc', (j === 0 ? 0.72 : 0.58) * shape(c.kind, j / W), { pi: [1, 0, 2, 0, 1, 2, 0][i % 7] });
      });
    },
    gallop(c, hit) {
      const { W, from } = c;
      for (let j = 0; j < W; j++) {
        const p = j % 4, v = 0.6 + 0.3 * (j / W);
        if (p === 0 || p === 3) hit(from + j, 'snare', v);
        if (p === 0) hit(from + j, 'kick', 0.7);
      }
      hit(from + W - 1, 'snare', 0.92);
    },
    claps(c, hit) {
      const { W, from } = c;
      const at = W >= 16 ? [0, 8, 12, 14, 15] : W >= 8 ? [0, 4, 6, 7] : [0, 2, 3];
      at.forEach((j, i) => hit(from + j, 'clap', 0.55 + 0.1 * i));
      hit(from, 'kick', 0.75);
    },
    flutter(c, hit) {
      const { W, from, N, I } = c;
      for (let j = 0; j < W - 1; j++) {
        const acc = j === Math.floor(W / 2) - 1 && W >= 8;
        const v = acc ? 0.5 : 0.14 + 0.1 * N(from + j, CH.vel);
        hit(from + j, I <= 1 ? 'rim' : 'snare', I <= 1 ? v * 0.8 : v, acc ? {} : { ghost: true });
      }
      hit(from + W - 1, I <= 1 ? 'rim' : 'snare', I <= 1 ? 0.42 : 0.62);
    },
    // two steps wide: the tags
    pairTom(c, hit) { const { from, N } = c, hi = N(1, CH.tag) < 0.5 ? 2 : 1; hit(from, 'tom', 0.74, { tom: hi }); hit(from + 1, 'tom', 0.8, { tom: hi - 1 }); },
    flamSnare(c, hit) { const { from } = c; hit(from, 'kick', 0.7); hit(from + 1, 'snare', 0.26, { grace: true }); hit(from + 1, 'snare', 0.84); },
    kickSnare(c, hit) { const { from } = c; hit(from, 'kick', 0.8); hit(from + 1, 'snare', 0.8); },
    percPair(c, hit) { const { from, N } = c, a = N(1, CH.tag) < 0.5 ? 2 : 1; hit(from, 'perc', 0.62, { pi: a }); hit(from + 1, 'perc', 0.7, { pi: a - 1 }); },
    rimRim(c, hit) { const { from } = c; hit(from, 'rim', 0.34); hit(from + 1, 'rim', 0.48); },
    hatOpen(c, hit) { const { from } = c; hit(from, 'hat', 0.55); hit(from + 1, 'hat', 0.7, { open: true }); },
  };

  /**
   * A figure's hits, dressed for the idiom of the kit.
   * @param {string} id a figure (not 'recite')
   * @param {object} c  { W, from, I, kind, fast, half, N, idiom, style, map?: {tom: 'snare'|null…}, soft }
   * @returns {{s, type, vel, ...}[]}
   */
  function write(id, c) {
    const fn = FIG[id];
    if (!fn) return [];
    const raw = [];
    const hit = (s, type, vel, x) => raw.push({ s, type, vel: clamp(vel, 0.05, 1), ...(x || {}) });
    fn(c, hit);
    const out = [], map = c.map || null, soft = c.soft || 1;
    for (const h of raw) {
      let type = h.type;
      // the idiom's kit: a dry kit has no toms (they are snare), a dropped beat has none at all
      if (map) {
        const key = type === 'perc' ? 'tom' : type;
        if (key in map) type = map[key];
        if (type === null) continue;
      }
      const x = { ...h, type };
      if (type !== h.type) { delete x.tom; delete x.pi; }
      // a quiet section fills quietly: sticks and skins
      if (c.I === 1) {
        if (type === 'snare') { x.type = 'rim'; x.vel *= 0.62; }
        else if (type === 'hat') { x.type = 'shaker'; x.vel *= 0.6; delete x.open; delete x.pan; }
        else if (type === 'kick') x.vel *= 0.85;
        else x.vel *= 0.8;
      }
      if (c.kind === 'dissolve') {
        if (x.type === 'snare') { x.type = 'rim'; x.vel *= 0.7; }
        if (x.s >= 15) continue;                               // the last sixteenth is left to the silence
      }
      x.vel = clamp(x.vel * soft, 0.05, 1);
      out.push(x);
    }
    return out;
  }

  return { FIGURES, TAGS, IDIOM, STYLE, CH, weights, choose, write, shape };
})();

if (typeof window !== 'undefined') window.Fills = Fills;
