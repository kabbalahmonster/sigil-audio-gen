'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5b  SOUND DESIGN v2 — pure, deterministic, no audio context
   --------------------------------------------------------------------------
   THE CUBE
     X (9 frames)  the sigil drawn progressively, letter by letter
     Y (5 layers)  spectral character applied to the same partials:
                     0 full · 1 hollow (odd) · 2 resonant · 3 metallic · 4 dark
     T (per note)  each note travels a vector from one cell toward another,
                   so timbre moves while the note sounds
   Cells are built on demand and cached; a whole cube is about 90 small arrays.

   Also here: the drum kit DNA, the consonant classes used for percussion
   colour, the patch codec, and a pure mirror of the bit-crusher maths so the
   on-screen scope can show exactly what you will hear.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundDesign = (() => {
  'use strict';

  const H = 24;            // partials per cell (band-limited by construction)
  const FX = 9;            // cube width  (path growth)
  const FY = 5;            // cube height (spectral layers)
  const HARM_SPAN = 16;    // slots map onto partials 1…16
  const RING_AMP = [0.45, 0.7, 1];
  const GOLDEN = 2.399963229728653;   // golden angle, used for phase scatter

  const VOWELS = [
    { name: 'ah', f: [800, 1150, 2900, 3900], g: [1, 0.50, 0.25, 0.12] },
    { name: 'eh', f: [530, 1840, 2480, 3500], g: [1, 0.45, 0.22, 0.10] },
    { name: 'ee', f: [270, 2290, 3010, 3500], g: [1, 0.40, 0.30, 0.12] },
    { name: 'oh', f: [450, 800, 2830, 3800], g: [1, 0.60, 0.20, 0.10] },
    { name: 'oo', f: [325, 700, 2530, 3500], g: [1, 0.50, 0.18, 0.08] },
  ];

  /** Consonant classes drive percussion colour and vocal onsets. */
  const CONSONANT_CLASS = {
    B: 'plosive', D: 'plosive', G: 'plosive', K: 'plosive', P: 'plosive', T: 'plosive', Q: 'plosive',
    F: 'fricative', S: 'fricative', H: 'fricative', V: 'fricative', Z: 'fricative', X: 'fricative', C: 'fricative',
    M: 'nasal', N: 'nasal', J: 'nasal',
    L: 'liquid', R: 'liquid', W: 'liquid', Y: 'liquid',
  };
  /** [high-pass centre multiplier, decay multiplier, noise brightness] per class. */
  const CLASS_TONE = {
    plosive:  [0.85, 0.55, 0.6],
    fricative:[1.25, 1.45, 1.0],
    nasal:    [0.7,  0.9,  0.45],
    liquid:   [1.0,  1.1,  0.75],
  };

  /** Patch fields: name → [share code, min, max]. 'd' is reserved for the dream index. */
  const FIELDS = {
    wave: ['w', 0, 8], layer: ['l', 0, 4], sweep: ['s', 0, 1], drift: ['y', 0, 1],
    sub: ['u', 0, 1], chorus: ['c', 0, 1], voice: ['v'], vowel: ['o', 0, 4],
    throat: ['t', -1, 1], breath: ['b', 0, 1], bright: ['r', 0, 1],
    grit: ['g', 0, 1], bits: ['i', 2, 16], hold: ['h', 1, 16], fold: ['f', 0, 1],
    drive: ['n', 0, 1], echo: ['e', 0, 1], drums: ['k', 0, 1.5],
  };
  const INTEGER_FIELDS = new Set(['vowel', 'bits', 'hold']);
  const VOICES = ['auto', 'vox', 'wave'];
  const clampTo = (x, a, b) => Math.min(b, Math.max(a, x));

  /**
   * The sigil's sound DNA. Draw order is fixed: append new fields at the END.
   * Variant 0 uses stream 'sound'; dreams use 'sound:dream:N'.
   */
  function derive(hash, variant = 0) {
    const R = stream(hash, variant ? `sound:dream:${variant}` : 'sound');
    const P = {
      mult: R.pick([1, 3, 5, 7]),
      off: R.int(0, 15),
      layerShift: R.int(1, 7),
      wave: R.range(0, 4),
      layer: R.range(0, 4),
      sweep: R.range(0.15, 0.9),
      drift: R.range(0, 0.8),
      sub: R.range(0, 0.7),
      chorus: R.range(0, 0.7),
      voice: R.pick(['auto', 'auto', 'vox', 'wave']),
      vowel: R.int(0, 4),
      throat: R.range(-0.5, 0.5),
      breath: R.range(0.05, 0.4),
      bright: R.range(0.3, 0.9),
      grit: R.chance(0.5) ? R.range(0.25, 0.75) : 0,
      bits: R.pick([4, 6, 8, 10]),
      hold: R.pick([1, 2, 3, 4]),
      fold: R.range(0, 0.35),
      drive: R.range(0, 0.5),
      echo: R.range(0.1, 0.6),
      drums: R.range(0.75, 1.15),
    };
    P.kit = {
      tune: R.range(0, 1),       // kick pitch
      decay: R.range(0.2, 1),    // kick length
      click: R.range(0.2, 1),    // beater
      snap: R.range(0.2, 1),     // snare length
      noiseTone: R.range(0, 1),  // snare colour
      hatDecay: R.range(0.3, 1),
      hatTone: R.range(0, 1),
      body: R.range(0, 1),       // snare body pitch
      punch: R.range(0.3, 1),    // drive into the shaper
    };
    return P;
  }

  /** Build one cube cell. Layer `y` reshapes the same partials. */
  function buildCell(sig, D, x, y) {
    const re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    im[1] = 0.3;                                   // fundamental anchors the pitch
    const n = sig.nodes.length;
    const count = Math.max(1, Math.round(((x + 1) / FX) * n));
    const off = (D.off + y * D.layerShift) % HARM_SPAN;
    const res = 2 + ((D.off + y * 3) % 10);        // resonance partial for layer 2

    for (let i = 0; i < count; i++) {
      const nd = sig.nodes[i];
      const h = 1 + ((nd.slot * D.mult + off) % HARM_SPAN);
      let amp = RING_AMP[nd.ring] / Math.sqrt(h);
      let phi = i > 0 ? (sig.curves[i - 1] || 0) * Math.PI : 0;

      switch (y) {
        case 1: if (h % 2 === 0) amp *= 0.22; break;                               // hollow
        case 2: amp *= 1 + 2.2 * Math.exp(-Math.pow((h - res) / 2.2, 2)); break;    // resonant
        case 3: phi += h * GOLDEN; amp *= 0.9; break;                               // metallic
        case 4: amp /= Math.sqrt(h); break;                                         // dark
      }
      im[h] += amp * Math.cos(phi);
      re[h] += amp * Math.sin(phi);
    }
    return { re, im };
  }

  const cache = new Map();

  /**
   * The cube for a sigil and dream variant.
   * @returns {{key, D, grid: Array<Array<{re,im}>>, cell(x,y)}}
   */
  function tables(sig, variant = 0) {
    const key = sig.hex + ':' + variant;
    if (cache.has(key)) return cache.get(key);
    const D = derive(sig.hash, variant);
    const grid = [];
    for (let y = 0; y < FY; y++) {
      const row = [];
      for (let x = 0; x < FX; x++) row.push(buildCell(sig, D, x, y));
      grid.push(row);
    }
    const tb = {
      key, D, grid,
      cell: (x, y) => grid[clampTo(Math.round(y), 0, FY - 1)][clampTo(Math.round(x), 0, FX - 1)],
    };
    if (cache.size > 24) cache.clear();
    cache.set(key, tb);
    return tb;
  }

  /** The vocal source: a glottal pulse, amplitude falling as h^-1.5. */
  function glottal() {
    const N = 32, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = 1 / Math.pow(h, 1.5);
    return { re, im };
  }

  /** One cycle of a blended cell pair, normalised to ±1. Used by the scope. */
  function waveSamples(fa, fb, w, N = 160) {
    const out = new Float32Array(N);
    let mx = 1e-9;
    for (let i = 0; i < N; i++) {
      const x = (2 * Math.PI * i) / N;
      let s = 0;
      for (let h = 1; h <= H; h++) {
        const re = (1 - w) * fa.re[h] + w * fb.re[h];
        const im = (1 - w) * fa.im[h] + w * fb.im[h];
        s += re * Math.cos(h * x) + im * Math.sin(h * x);
      }
      out[i] = s;
      if (Math.abs(s) > mx) mx = Math.abs(s);
    }
    for (let i = 0; i < N; i++) out[i] /= mx;
    return out;
  }

  /**
   * Pure mirror of the worklet's maths (minus dither) so the scope shows the
   * real signal: drive → fold → quantise → sample-hold → wet/dry.
   * Mutates a copy and returns it.
   */
  function applyFx(src, { bits = 16, hold = 1, fold = 0, drive = 0, mix = 0 }) {
    const out = new Float32Array(src.length);
    const levels = Math.pow(2, bits - 1);
    const k = 1 + drive * 5;
    let heldV = 0;
    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      if (i % Math.max(1, Math.round(hold)) === 0) {
        let v = drive > 0 ? Math.tanh(x * k) / Math.tanh(k) : x;
        if (fold > 0) v = (1 - fold) * v + fold * Math.sin(v * Math.PI * 0.5 * (1 + 3 * fold));
        v = clampTo(v, -1, 1);
        heldV = Math.round(v * levels) / levels;
      }
      out[i] = x * (1 - mix) + heldV * mix;
    }
    return out;
  }

  /* ── Patch codec ─────────────────────────────────────────────────────── */

  const b64 = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return atob(t);
  };

  function encodePatch(o = {}, variant = 0) {
    const j = {};
    for (const [name, [s]] of Object.entries(FIELDS)) {
      if (o[name] === undefined) continue;
      j[s] = typeof o[name] === 'number' ? +(+o[name]).toFixed(3) : o[name];
    }
    if (variant) j.d = variant;
    return Object.keys(j).length ? b64(JSON.stringify(j)) : '';
  }

  /** Decode and clamp. A malformed or hostile link can never leave safe ranges. */
  function decodePatch(code) {
    try {
      const j = JSON.parse(unb64(code));
      const o = {};
      for (const [name, [s, lo, hi]] of Object.entries(FIELDS)) {
        if (!(s in j)) continue;
        if (name === 'voice') { if (VOICES.includes(j[s])) o[name] = j[s]; }
        else if (typeof j[s] === 'number' && Number.isFinite(j[s])) {
          let v = clampTo(j[s], lo, hi);
          if (INTEGER_FIELDS.has(name)) v = Math.round(v);
          o[name] = v;
        }
      }
      return { o, variant: Number.isInteger(j.d) ? clampTo(j.d, 0, 99) : 0 };
    } catch { return null; }
  }

  /** Deterministic nudge of the numeric knobs: the Mutate button. */
  function mutate(hash, n, base, current) {
    const R = stream(hash, `mutate:${n}`);
    const o = { ...current };
    for (const [name, [, lo, hi]] of Object.entries(FIELDS)) {
      if (lo === undefined || name === 'bits' || name === 'hold') continue;
      if (!R.chance(0.45)) continue;
      const from = current[name] !== undefined ? current[name] : base[name];
      if (typeof from !== 'number') continue;
      let v = clampTo(from + R.range(-0.18, 0.18) * (hi - lo), lo, hi);
      if (INTEGER_FIELDS.has(name)) v = Math.round(v);
      o[name] = +v.toFixed(3);
    }
    return o;
  }

  return {
    H, FX, FY, VOWELS, FIELDS, VOICES, CONSONANT_CLASS, CLASS_TONE,
    derive, tables, glottal, waveSamples, applyFx,
    encodePatch, decodePatch, mutate, clampTo,
  };
})();

window.SoundDesign = SoundDesign;