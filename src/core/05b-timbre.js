'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5b  SOUND DESIGN v3 — pure, deterministic, Node-safe (no window/DOM)
   --------------------------------------------------------------------------
   THE CUBE      X (9) path growth · Y (5) spectral layers · per-note travel
   THE LATTICE   the cube as 45 closed waveform rings + ribs (3D, for visuals)
   THE IMPULSE   a reverb built from the sigil's own path geometry
   THE KIT       drum DNA and the drum cube's size/colour axes
   THE CODEC     short share codes for patches (no words)
   ══════════════════════════════════════════════════════════════════════════ */

const SoundDesign = (() => {
  'use strict';

  const H = 24;                 // partials per cell
  const FX = 9;                 // cube width (path growth)
  const FY = 5;                 // cube height (spectral layers)
  const HARM_SPAN = 16;
  const RING_AMP = [0.45, 0.7, 1];
  const GOLDEN = 2.399963229728653;

  /* Lattice layout: ring centres sit on a grid, X → depth, Y → height. */
  const LATTICE_R = 0.5;
  const LATTICE_DY = 0.42;
  const LATTICE_DZ = 0.3;

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
  /** [filter centre multiplier, decay multiplier, level multiplier] per class. */
  const CLASS_TONE = {
    plosive:   [0.85, 0.55, 0.6],
    fricative: [1.25, 1.45, 1.0],
    nasal:     [0.7, 0.9, 0.45],
    liquid:    [1.0, 1.1, 0.75],
  };

  /** Patch fields: name → [share code, min, max]. 'd' is reserved for the dream index. */
  const FIELDS = {
    wave: ['w', 0, 8], layer: ['l', 0, 4], sweep: ['s', 0, 1], drift: ['y', 0, 1],
    sub: ['u', 0, 1], chorus: ['c', 0, 1], voice: ['v'], vowel: ['o', 0, 4],
    throat: ['t', -1, 1], breath: ['b', 0, 1], bright: ['r', 0, 1],
    grit: ['g', 0, 1], bits: ['i', 2, 16], hold: ['h', 1, 16], fold: ['f', 0, 1],
    drive: ['n', 0, 1], echo: ['e', 0, 1], drums: ['k', 0, 1.5],
    drumX: ['x', 0, 1], drumY: ['z', 0, 1],
  };
  const INTEGER_FIELDS = new Set(['vowel', 'bits', 'hold']);
  const VOICES = ['auto', 'vox', 'wave'];
  const clampTo = (x, a, b) => Math.min(b, Math.max(a, x));

  /* ── DNA ──────────────────────────────────────────────────────────────── */

  /**
   * The sigil's sound DNA. Draw order is fixed, so new fields go at the end.
   * Variant 0 uses stream 'sound'. Dreams use 'sound:dream:N'.
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
      drumX: R.range(0, 1),     // drum cube: size (tight → boomy)
      drumY: R.range(0, 1),     // drum cube: colour (dark → bright)
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
      kickOct: R.pick([0, 0, 1]),   // kick one octave up from the chord root, or the root itself
    };
    return P;
  }

  /* ── Cube ─────────────────────────────────────────────────────────────── */

  function buildCell(sig, D, x, y) {
    const re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    im[1] = 0.3;
    const n = sig.nodes.length;
    const count = Math.max(1, Math.round(((x + 1) / FX) * n));
    const off = (D.off + y * D.layerShift) % HARM_SPAN;
    const res = 2 + ((D.off + y * 3) % 10);

    for (let i = 0; i < count; i++) {
      const nd = sig.nodes[i];
      const h = 1 + ((nd.slot * D.mult + off) % HARM_SPAN);
      let amp = RING_AMP[nd.ring] / Math.sqrt(h);
      let phi = i > 0 ? (sig.curves[i - 1] || 0) * Math.PI : 0;
      switch (y) {
        case 1: if (h % 2 === 0) amp *= 0.22; break;
        case 2: amp *= 1 + 2.2 * Math.exp(-Math.pow((h - res) / 2.2, 2)); break;
        case 3: phi += h * GOLDEN; amp *= 0.9; break;
        case 4: amp /= Math.sqrt(h); break;
      }
      im[h] += amp * Math.cos(phi);
      re[h] += amp * Math.sin(phi);
    }
    return { re, im };
  }

  const cache = new Map();

  /** The cube for a sigil and variant. grid[y][x] is a {re, im} cell. */
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

  /* ── Fast sampling with precomputed trig ─────────────────────────────── */

  const TRIG = new Map();
  function trig(N) {
    let t = TRIG.get(N);
    if (!t) {
      const c = new Float64Array(N), s = new Float64Array(N);
      for (let k = 0; k < N; k++) { c[k] = Math.cos((2 * Math.PI * k) / N); s[k] = Math.sin((2 * Math.PI * k) / N); }
      t = { c, s };
      TRIG.set(N, t);
    }
    return t;
  }

  /** One cycle of a cell, N samples, normalised to ±1. No trig calls in the loop. */
  function cellSamples(c, N = 48) {
    const { c: C, s: S } = trig(N);
    const out = new Float32Array(N);
    let mx = 1e-9;
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let h = 1; h <= H; h++) {
        const k = (h * i) % N;
        acc += c.re[h] * C[k] + c.im[h] * S[k];
      }
      out[i] = acc;
      if (Math.abs(acc) > mx) mx = Math.abs(acc);
    }
    for (let i = 0; i < N; i++) out[i] /= mx;
    return out;
  }

  /** A cycle between two cells at weight w (0 = a, 1 = b). */
  function waveSamples(fa, fb, w, N = 160) {
    const blend = { re: new Float32Array(H + 1), im: new Float32Array(H + 1) };
    for (let h = 1; h <= H; h++) {
      blend.re[h] = (1 - w) * fa.re[h] + w * fb.re[h];
      blend.im[h] = (1 - w) * fa.im[h] + w * fb.im[h];
    }
    return cellSamples(blend, N);
  }

  /** The vocal source: a glottal pulse, falling as h^-1.5. */
  function glottal() {
    const N = 32, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = 1 / Math.pow(h, 1.5);
    return { re, im };
  }

  /**
   * Pure mirror of the worklet: drive → fold → quantise → sample-hold → wet/dry.
   * The lattice and scope use it, so what you see is what you hear.
   */
  function applyFx(src, { bits = 16, hold = 1, fold = 0, drive = 0, mix = 0 }) {
    const out = new Float32Array(src.length);
    const levels = Math.pow(2, bits - 1);
    const k = 1 + drive * 5;
    const norm = drive > 0 ? Math.tanh(k) : 1;
    const every = Math.max(1, Math.round(hold));
    let heldV = 0;
    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      if (i % every === 0) {
        let v = drive > 0 ? Math.tanh(x * k) / norm : x;
        if (fold > 0) v = (1 - fold) * v + fold * Math.sin(v * Math.PI * 0.5 * (1 + 3 * fold));
        v = clampTo(v, -1, 1);
        heldV = Math.round(v * levels) / levels;
      }
      out[i] = x * (1 - mix) + heldV * mix;
    }
    return out;
  }

  /**
   * The lattice: FY × FX closed rings, each a cell's waveform as radius.
   * Ring (x, y) sits at depth (x − 4)·DZ and height (y − 2)·DY.
   * Point index: ((y·FX + x)·N + i), stored as x,y,z triples.
   * Sub-oscillator is included as a half-cycle across the ring.
   */
  function lattice(tb, P, N = 48) {
    const pts = new Float32Array(FY * FX * N * 3);
    const fx = { bits: P.grit > 0 ? P.bits : 16, hold: P.hold, fold: P.fold, drive: P.drive, mix: P.grit };
    for (let y = 0; y < FY; y++) {
      for (let x = 0; x < FX; x++) {
        let w = cellSamples(tb.grid[y][x], N);
        for (let i = 0; i < N; i++) w[i] += P.sub * 0.5 * Math.sin((Math.PI * i) / N);
        w = applyFx(w, fx);
        let mx = 1e-9;
        for (let i = 0; i < N; i++) if (Math.abs(w[i]) > mx) mx = Math.abs(w[i]);
        const cz = (x - 4) * LATTICE_DZ, cy = (y - 2) * LATTICE_DY;
        const base = (y * FX + x) * N * 3;
        for (let i = 0; i < N; i++) {
          const th = (2 * Math.PI * i) / N;
          const r = LATTICE_R * (1 + 0.38 * (w[i] / mx));
          pts[base + 3 * i] = r * Math.cos(th);
          pts[base + 3 * i + 1] = cy + r * Math.sin(th);
          pts[base + 3 * i + 2] = cz;
        }
      }
    }
    return { pts, N };
  }

  /* ── Geometric impulse response ──────────────────────────────────────── */

  const irCache = new Map();

  /**
   * A stereo impulse response built from the path itself.
   * Each stroke becomes an early reflection: its delay follows the stroke's
   * length, its pan follows the node's angle on the seal, and its level follows
   * the curve. A seeded diffuse tail sits underneath. Same sigil, same room.
   */
  function impulse(sig, sr, seconds = 2.4) {
    const key = sig.hex + ':' + sr;
    if (irCache.has(key)) return irCache.get(key);

    const N = Math.floor(seconds * sr);
    const L = new Float32Array(N), R = new Float32Array(N);
    const rnd = mulberry32(parseInt(sig.hex.slice(0, 8), 16) >>> 0);
    const F = { cx: 0, cy: 0, R: 1, base: sig.baseAngle };

    let tAcc = 0.006, prev = null;
    sig.nodes.forEach((nd, i) => {
      const p = nodeXY(nd, ID_T, F);
      const dist = prev ? Math.hypot(p[0] - prev[0], p[1] - prev[1]) : 0.4;
      prev = p;
      tAcc += 0.004 + dist * 0.03;
      const idx = Math.floor(tAcc * sr);
      if (idx >= N) return;
      const pan = 0.5 + 0.5 * Math.sin(Math.atan2(p[0], -p[1]));
      const curve = Math.abs(sig.curves[i - 1] || 0);
      const g = (0.55 - i * 0.02) * (1 + curve) * 0.35;
      L[idx] += g * Math.cos((pan * Math.PI) / 2);
      R[idx] += g * Math.sin((pan * Math.PI) / 2);
    });

    // Diffuse tail: one-pole-filtered seeded noise under a power-law decay.
    let lpL = 0, lpR = 0;
    const start = Math.floor(0.02 * sr);
    for (let i = start; i < N; i++) {
      const env = Math.pow(1 - i / N, 2.2);
      lpL += 0.5 * ((rnd() * 2 - 1) - lpL);
      lpR += 0.5 * ((rnd() * 2 - 1) - lpR);
      L[i] += lpL * env * 0.35;
      R[i] += lpR * env * 0.35;
    }

    let peak = 1e-9;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    for (let i = 0; i < N; i++) { L[i] *= 0.9 / peak; R[i] *= 0.9 / peak; }

    const ir = { L, R, sr };
    if (irCache.size > 12) irCache.clear();
    irCache.set(key, ir);
    return ir;
  }

  /* ── Codec ────────────────────────────────────────────────────────────── */

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

  /** Deterministic nudge of numeric knobs. Same sigil and count, same result. */
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
    H, FX, FY, LATTICE_R, LATTICE_DY, LATTICE_DZ,
    VOWELS, FIELDS, VOICES, CONSONANT_CLASS, CLASS_TONE,
    derive, tables, glottal, cellSamples, waveSamples, applyFx,
    lattice, impulse,
    encodePatch, decodePatch, mutate, clampTo,
  };
})();

/* Browser-only publication. Node (tests/golden.mjs) has no window. */
if (typeof window !== 'undefined') window.SoundDesign = SoundDesign;