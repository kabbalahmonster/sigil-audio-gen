'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5b  SOUND DESIGN v3 — pure, deterministic, no audio context
   --------------------------------------------------------------------------
   THE CUBE
     X  13 frames   the sigil drawn progressively, letter by letter
     Y   9 layers   spectral characters, from full to comb to scattered
     T  per note    every note travels a vector through the cube

   SHAPING (rebuilds the cube, so it is real, not a filter)
     warp     spectral tilt: dark and fundamental-heavy → bright and buzzing
     skew     phase scatter: coherent and punchy → diffuse and metallic
     density  how many partials survive: pure → dense

   ALSO HERE
     arc()        per-section automation, so the timbre follows the rite
     kitAt()      the drum cube: kit character per section
     irSpec()     the reverb impulse derived from the sigil's own strokes
     ringSamples()  one cycle, clean and crushed, for the visuals
     applyFx()    a pure mirror of the worklet, so displays tell the truth
   ══════════════════════════════════════════════════════════════════════════ */

const SoundDesign = (() => {
  'use strict';

  const H = 32;            // partials per cell
  const FX = 13;           // cube width  (path growth)
  const FY = 9;            // cube height (spectral layers)
  const HARM_SPAN = 24;    // slots map onto partials 1…24
  const RING_AMP = [0.45, 0.7, 1];
  const GOLDEN = 2.399963229728653;

  const LAYER_NAMES = ['full', 'hollow', 'octave', 'resonant', 'metallic', 'dark', 'glass', 'comb', 'scatter'];

  const VOWELS = [
    { name: 'ah', f: [800, 1150, 2900, 3900], g: [1, 0.50, 0.25, 0.12] },
    { name: 'eh', f: [530, 1840, 2480, 3500], g: [1, 0.45, 0.22, 0.10] },
    { name: 'ee', f: [270, 2290, 3010, 3500], g: [1, 0.40, 0.30, 0.12] },
    { name: 'oh', f: [450, 800, 2830, 3800], g: [1, 0.60, 0.20, 0.10] },
    { name: 'oo', f: [325, 700, 2530, 3500], g: [1, 0.50, 0.18, 0.08] },
  ];

  const CONSONANT_CLASS = {
    B: 'plosive', D: 'plosive', G: 'plosive', K: 'plosive', P: 'plosive', T: 'plosive', Q: 'plosive',
    F: 'fricative', S: 'fricative', H: 'fricative', V: 'fricative', Z: 'fricative', X: 'fricative', C: 'fricative',
    M: 'nasal', N: 'nasal', J: 'nasal',
    L: 'liquid', R: 'liquid', W: 'liquid', Y: 'liquid',
  };
  const CLASS_TONE = {
    plosive:   [0.85, 0.55, 0.60],
    fricative: [1.25, 1.45, 1.00],
    nasal:     [0.70, 0.90, 0.45],
    liquid:    [1.00, 1.10, 0.75],
  };

  /** Patch fields: name → [share code, min, max]. 'd' is reserved for the dream index. */
  const FIELDS = {
    wave: ['w', 0, 12], layer: ['l', 0, 8], sweep: ['s', 0, 1], drift: ['y', 0, 1],
    warp: ['p', 0, 1], skew: ['q', 0, 1], density: ['x', 0, 1],
    sub: ['u', 0, 1], chorus: ['c', 0, 1], voice: ['v'], vowel: ['o', 0, 4],
    throat: ['t', -1, 1], breath: ['b', 0, 1], bright: ['r', 0, 1],
    grit: ['g', 0, 1], bits: ['i', 2, 16], hold: ['h', 1, 16], fold: ['f', 0, 1],
    drive: ['n', 0, 1], echo: ['e', 0, 1],
    drums: ['k', 0, 1.5], drumX: ['m', 0, 1], drumY: ['z', 0, 1],
  };
  const INTEGER_FIELDS = new Set(['vowel', 'bits', 'hold']);
  const VOICES = ['auto', 'vox', 'wave'];
  const clampTo = (x, a, b) => Math.min(b, Math.max(a, x));

  /** The sigil's sound DNA. Draw order is fixed: append new fields at the END. */
  function derive(hash, variant = 0) {
    const R = stream(hash, variant ? `sound:dream:${variant}` : 'sound');
    const P = {
      mult: R.pick([1, 3, 5, 7, 11]),
      off: R.int(0, 23),
      layerShift: R.int(1, 11),
      wave: R.range(0, 6),
      layer: R.range(0, 8),
      sweep: R.range(0.15, 0.9),
      drift: R.range(0, 0.8),
      warp: R.range(0.3, 0.75),
      skew: R.range(0, 0.5),
      density: R.range(0.35, 0.95),
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
      drumX: R.range(0.25, 0.85),     // kit size: tight and small → long and large
      drumY: R.range(0.15, 0.8),      // kit colour: dull and round → bright and hard
    };
    P.kit = {
      tune: R.range(0, 1),
      decay: R.range(0.2, 1),
      click: R.range(0.2, 1),
      snap: R.range(0.2, 1),
      noiseTone: R.range(0, 1),
      hatDecay: R.range(0.3, 1),
      hatTone: R.range(0, 1),
      body: R.range(0, 1),
      punch: R.range(0.3, 1),
      kickOct: R.chance(0.28),        // some sigils kick an octave above the root
      room: R.range(0.1, 0.6),
    };
    return P;
  }

  /** Deterministic pseudo-noise for the scatter layer. No PRNG state needed. */
  const hashAmp = (h, seed) => {
    const x = Math.sin(h * 12.9898 + seed * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  /**
   * Build one cube cell.
   * @param y layer index, 0…FY-1, each a different spectral character
   * @param sh shaping { warp, skew, density }
   */
  function buildCell(sig, D, x, y, sh) {
    const re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    im[1] = 0.3;
    const n = sig.nodes.length;
    const count = Math.max(1, Math.round(((x + 1) / FX) * n));
    const off = (D.off + y * D.layerShift) % HARM_SPAN;
    const res = 2 + ((D.off + y * 3) % 14);
    const top = 1 + Math.round(sh.density * (HARM_SPAN - 1));   // partial ceiling
    const tilt = -1 + sh.warp * 2;                              // h^tilt spectral slope

    for (let i = 0; i < count; i++) {
      const nd = sig.nodes[i];
      const h = 1 + ((nd.slot * D.mult + off) % HARM_SPAN);
      if (h > top) continue;
      let amp = RING_AMP[nd.ring] * Math.pow(h, tilt * 0.75 - 0.5);
      let phi = i > 0 ? (sig.curves[i - 1] || 0) * Math.PI : 0;
      phi += sh.skew * h * GOLDEN;                              // phase scatter

      switch (y) {
        case 1: if (h % 2 === 0) amp *= 0.18; break;                                  // hollow
        case 2: if (h % 2 === 1 && h > 1) amp *= 0.3; break;                          // octave
        case 3: amp *= 1 + 2.6 * Math.exp(-Math.pow((h - res) / 2.0, 2)); break;      // resonant
        case 4: phi += h * GOLDEN; amp *= 0.9; break;                                 // metallic
        case 5: amp /= Math.sqrt(h); break;                                           // dark
        case 6: amp *= Math.sqrt(h) * 0.55; break;                                    // glass
        case 7: amp *= (h % 3 === 0 ? 0.12 : 1); break;                               // comb
        case 8: amp *= 0.4 + 1.2 * hashAmp(h, D.off + y); break;                      // scatter
      }
      im[h] += amp * Math.cos(phi);
      re[h] += amp * Math.sin(phi);
    }
    return { re, im };
  }

  const cache = new Map();
  const qz = (v) => Math.round(clampTo(v, 0, 1) * 20) / 20;   // shaping is quantised, so the cache works

  /**
   * The cube for a sigil, dream variant and shaping.
   * Cells are built lazily: a busy song touches a handful of the 117.
   * @returns {{key, D, shape, grid, cell(x,y)}}
   */
  function tables(sig, variant = 0, shape) {
    const sh = {
      warp: qz(shape && shape.warp !== undefined ? shape.warp : 0.5),
      skew: qz(shape && shape.skew !== undefined ? shape.skew : 0),
      density: qz(shape && shape.density !== undefined ? shape.density : 0.8),
    };
    const key = `${sig.hex}:${variant}:${sh.warp}:${sh.skew}:${sh.density}`;
    if (cache.has(key)) return cache.get(key);

    const D = derive(sig.hash, variant);
    const grid = Array.from({ length: FY }, () => new Array(FX).fill(null));
    const tb = {
      key, D, shape: sh, grid,
      cell(x, y) {
        const cx = clampTo(Math.round(x), 0, FX - 1), cy = clampTo(Math.round(y), 0, FY - 1);
        let c = grid[cy][cx];
        if (!c) { c = buildCell(sig, D, cx, cy, sh); grid[cy][cx] = c; }
        return c;
      },
    };
    if (cache.size > 14) cache.clear();
    cache.set(key, tb);
    return tb;
  }

  /** The vocal source: a glottal pulse, amplitude falling as h^-1.5. */
  function glottal() {
    const N = 32, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = 1 / Math.pow(h, 1.5);
    return { re, im };
  }

  /** One cycle of a blended cell pair, normalised to ±1. */
  function waveSamples(fa, fb, w, N = 160) {
    const out = new Float32Array(N);
    let mx = 1e-9;
    for (let i = 0; i < N; i++) {
      const x = (2 * Math.PI * i) / N;
      let s = 0;
      for (let h = 1; h <= H; h++) {
        const re = (1 - w) * fa.re[h] + w * fb.re[h];
        const im = (1 - w) * fa.im[h] + w * fb.im[h];
        if (re === 0 && im === 0) continue;
        s += re * Math.cos(h * x) + im * Math.sin(h * x);
      }
      out[i] = s;
      if (Math.abs(s) > mx) mx = Math.abs(s);
    }
    for (let i = 0; i < N; i++) out[i] /= mx;
    return out;
  }

  /** Pure mirror of the worklet: drive → fold → quantise → hold → wet/dry. */
  function applyFx(src, { bits = 16, hold = 1, fold = 0, drive = 0, mix = 0 }) {
    const out = new Float32Array(src.length);
    const levels = Math.pow(2, bits - 1);
    const k = 1 + drive * 5, norm = drive > 0 ? Math.tanh(k) : 1;
    const step = Math.max(1, Math.round(hold));
    let heldV = 0;
    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      if (i % step === 0) {
        let v = drive > 0 ? Math.tanh(x * k) / norm : x;
        if (fold > 0) v = (1 - fold) * v + fold * Math.sin(v * Math.PI * 0.5 * (1 + 3 * fold));
        v = clampTo(v, -1, 1);
        heldV = Math.round(v * levels) / levels;
      }
      out[i] = x * (1 - mix) + heldV * mix;
    }
    return out;
  }

  /** Clean and crushed cycles, plus the sub, for the visual ring and the scope. */
  function ringSamples(tb, P, N = 128) {
    const a = tb.cell(P.wave, P.layer);
    const b = tb.cell(P.wave + P.sweep * 4, P.layer + P.drift * 3);
    const base = waveSamples(a, b, 0.35, N);
    const clean = new Float32Array(N);
    let mx = 1e-9;
    for (let i = 0; i < N; i++) {
      clean[i] = base[i] + (P.sub || 0) * 0.6 * Math.sin((2 * Math.PI * i) / N / 2);
      if (Math.abs(clean[i]) > mx) mx = Math.abs(clean[i]);
    }
    for (let i = 0; i < N; i++) clean[i] /= mx;
    const crushed = applyFx(clean, {
      bits: P.grit > 0 ? P.bits : 16, hold: P.hold, fold: P.fold, drive: P.drive, mix: P.grit,
    });
    return { clean, crushed };
  }

  /* ── SOUND ARC: per-section automation ───────────────────────────────── */

  function arc(D, sec, si, n) {
    const k = n > 1 ? si / (n - 1) : 0;
    const I = (sec.intensity || 0) / 3;
    const out = {
      wave: clampTo(D.wave + k * 4.5, 0, FX - 1),
      layer: clampTo(D.layer + I * 1.6 + k * 1.1, 0, FY - 1),
      sweep: clampTo(D.sweep * (0.5 + 0.7 * I), 0, 1),
      drift: clampTo(D.drift * (0.4 + 1.0 * k), 0, 1),
      warp: clampTo(D.warp * (0.8 + 0.45 * I), 0, 1),
      density: clampTo(D.density * (0.72 + 0.4 * I), 0.05, 1),
      bright: clampTo(D.bright * (0.55 + 0.5 * I + 0.2 * k), 0, 1),
      grit: clampTo(D.grit * (0.25 + 1.0 * I), 0, 1),
      chorus: clampTo(D.chorus * (0.55 + 0.7 * k), 0, 1),
      sub: clampTo(D.sub * (0.75 + 0.45 * (1 - Math.abs(k - 0.5) * 2)), 0, 1),
      drums: D.drums * (0.8 + 0.4 * I),
      drumX: clampTo(D.drumX * (0.75 + 0.5 * k), 0, 1),
      drumY: clampTo(D.drumY * (0.6 + 0.8 * I), 0, 1),
    };
    if (sec.final) {
      out.bright *= 0.45; out.grit *= 0.3; out.drums *= 0.4;
      out.wave = clampTo(D.wave * 0.5, 0, FX - 1);
      out.chorus = clampTo(out.chorus * 1.2, 0, 1);
    }
    if (si === 0) { out.grit *= 0.25; out.bright *= 0.8; out.drums *= 0.6; }
    return out;
  }

  /* ── DRUM CUBE ───────────────────────────────────────────────────────── */

  function kitAt(D, sec, si, n) {
    const K = D.kit, k = n > 1 ? si / (n - 1) : 0, I = (sec.intensity || 0) / 3;
    return {
      tune: clampTo(K.tune + 0.1 * k, 0, 1),
      decay: clampTo(K.decay * (sec.halfTime ? 1.45 : 1) * (0.85 + 0.3 * k), 0.1, 1.6),
      click: clampTo(K.click * (0.6 + 0.7 * I), 0, 1.4),
      snap: clampTo(K.snap * (0.8 + 0.5 * I), 0.1, 1.4),
      noiseTone: clampTo(K.noiseTone + 0.25 * I, 0, 1),
      hatDecay: clampTo(K.hatDecay * (sec.halfTime ? 1.3 : 1), 0.1, 1.4),
      hatTone: clampTo(K.hatTone + 0.2 * k, 0, 1),
      body: K.body,
      punch: clampTo(K.punch * (0.75 + 0.5 * I), 0.1, 1.4),
      kickOct: K.kickOct,
      room: clampTo(K.room * (0.7 + 0.6 * k), 0, 1),
      width: 0.3 + 0.5 * I,
    };
  }

  /* ── SIGIL IMPULSE RESPONSE ──────────────────────────────────────────── */

  function irSpec(sig, variant = 0) {
    const D = derive(sig.hash, variant);
    const n = sig.nodes.length, taps = [];
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = sig.nodes[i], b = sig.nodes[i + 1];
      const th = (2 * Math.PI * (b.slot - a.slot)) / 21;
      const ra = [0.34, 0.6, 0.86][a.ring], rb = [0.34, 0.6, 0.86][b.ring];
      acc += Math.sqrt(ra * ra + rb * rb - 2 * ra * rb * Math.cos(th));
      taps.push({
        t: 0.012 + acc * 0.055,
        gain: 0.6 / (1 + i * 0.55),
        pan: (b.ring - 1) * 0.75,
        diffuse: 0.25 + Math.abs(sig.curves[i] || 0),
      });
    }
    return {
      seconds: clampTo(2.2 + acc * 0.22, 1.8, 5.5),
      decay: 1.6 + (1 - D.bright) * 2.4,
      damp: 0.35 + D.bright * 0.45,
      taps,
    };
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
    H, FX, FY, LAYER_NAMES, VOWELS, FIELDS, VOICES, CONSONANT_CLASS, CLASS_TONE,
    derive, tables, glottal, waveSamples, applyFx, ringSamples,
    arc, kitAt, irSpec,
    encodePatch, decodePatch, mutate, clampTo,
  };
})();

/* Browsers only. Guarded so the Node golden runner can load this file unchanged. */
if (typeof window !== 'undefined') window.SoundDesign = SoundDesign;