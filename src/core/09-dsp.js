'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §9  DSP — sigil → timbre (pure maths, no Web Audio, no DOM)
   --------------------------------------------------------------------------
   Everything here is a deterministic function of the sigil, so it can be
   golden-tested in Node and reproduced identically offline.

     DSP.radialProfile(nodes, curves, N)  the path's silhouette, one cycle
     DSP.wavetable(sigil, variant)        Fourier series → PeriodicWave coeffs
     DSP.FORMANTS / DSP.vowelsOf()        vocal synthesis data
     DSP.defaultPatch(sigil)              the sigil's native patch
     DSP.encodePatch / decodePatch        compact base64url codec for links
   ══════════════════════════════════════════════════════════════════════════ */
const DSP = (() => {
  'use strict';

  const PROFILE_BINS = 128;   // angular resolution of the silhouette
  const HARMONICS = 64;       // Web Audio band-limits PeriodicWave per frequency

  /* ── §9.1 The silhouette ───────────────────────────────────────────────
     Walk the drawn path in the abstract unit frame, bin every sample point by
     its angle, and take the mean radius in each bin. Empty bins (angles the
     path never visits) are filled by circular interpolation between the two
     nearest occupied bins, so the curve stays smooth and the spectrum stays
     tame. The result is centred on zero and normalised to ±1: one cycle.
     ─────────────────────────────────────────────────────────────────────── */
  function radialProfile(nodes, curves, N = PROFILE_BINS) {
    const pts = tracePoints(nodes, curves, ID_T, UNIT_F, nodes.length - 1);
    const sum = new Float64Array(N), cnt = new Int32Array(N);

    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      // Same angular convention as polar(): 0 at 12 o'clock, clockwise.
      const b = Math.floor((mod(Math.atan2(x, -y), TAU) / TAU) * N) % N;
      sum[b] += Math.hypot(x, y);
      cnt[b]++;
    }

    const src = new Float64Array(N);
    let filled = 0;
    for (let i = 0; i < N; i++) { if (cnt[i]) { src[i] = sum[i] / cnt[i]; filled++; } else src[i] = NaN; }
    if (!filled) return new Float64Array(N);   // degenerate: silence

    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      if (!Number.isNaN(src[i])) { out[i] = src[i]; continue; }
      let a = 1, b = 1;
      while (Number.isNaN(src[mod(i - a, N)]) && a < N) a++;
      while (Number.isNaN(src[mod(i + b, N)]) && b < N) b++;
      const lo = src[mod(i - a, N)], hi = src[mod(i + b, N)];
      out[i] = lo + (hi - lo) * (a / (a + b));   // circular linear interpolation
    }

    let mean = 0;
    for (let i = 0; i < N; i++) mean += out[i];
    mean /= N;
    let peak = 1e-9;
    for (let i = 0; i < N; i++) { out[i] -= mean; if (Math.abs(out[i]) > peak) peak = Math.abs(out[i]); }
    for (let i = 0; i < N; i++) out[i] /= peak;
    return out;
  }

  /** Apply a wheel transform to a node list (and its strokes) without touching the sigil. */
  function view(sigil, T) {
    let nodes = sigil.nodes.map((n) => ({ ...n, slot: mod(T.m * n.slot + T.k, SLOTS) }));
    let curves = sigil.curves.slice();
    if (T.reverse) { nodes = nodes.reverse(); curves = curves.reverse(); }
    return { nodes, curves };
  }

  /**
   * The three faces of one glyph. Lead is the sigil as written; Pad is its
   * reflection; Bass is its retrograde. Related, never identical.
   */
  const VARIANTS = {
    lead: { k: 0, m: 1, reverse: false },
    pad:  { k: 0, m: -1, reverse: false },
    bass: { k: 0, m: 1, reverse: true },
  };

  /**
   * Fourier series of the silhouette → PeriodicWave coefficients.
   *
   * Two hash-derived colourings give each sigil a voice of its own without
   * destroying the geometric link:
   *   tilt  — how fast the harmonics roll off (hollow ↔ buzzing)
   *   bump  — a resonant emphasis around one harmonic (a fixed formant)
   *
   * @returns {{real: Float32Array, imag: Float32Array, profile: Float64Array}}
   */
  function wavetable(sigil, variant = 'lead', H = HARMONICS) {
    const T = VARIANTS[variant] || VARIANTS.lead;
    const { nodes, curves } = view(sigil, T);
    const v = radialProfile(nodes, curves);
    const N = v.length;

    const R = stream(sigil.hash, 'wavetable:' + variant);
    const knee = R.range(5, 18);          // harmonic at which roll-off begins
    const slope = R.range(0.9, 2.2);
    const bumpAt = R.int(2, 14);
    const bumpQ = R.range(1.5, 5);
    const bumpDb = R.range(0, 7);

    const real = new Float32Array(H + 1), imag = new Float32Array(H + 1);
    for (let h = 1; h <= H; h++) {
      let a = 0, b = 0;
      for (let n = 0; n < N; n++) {
        const th = (TAU * h * n) / N;
        a += v[n] * Math.cos(th);
        b += v[n] * Math.sin(th);
      }
      const tilt = 1 / (1 + Math.pow(h / knee, slope));
      const d = (h - bumpAt) / bumpQ;
      const bump = 1 + (bumpDb / 6) * Math.exp(-d * d);
      real[h] = (2 / N) * a * tilt * bump;
      imag[h] = (2 / N) * b * tilt * bump;
    }
    return { real, imag, profile: v };
  }

  /**
   * A glottal pulse for the vocal voice: a rounded sawtooth (Rosenberg-like),
   * tinted 25% by the sigil's own spectrum so even the voice carries the glyph.
   */
  function glottal(sigil, H = 40) {
    const wt = wavetable(sigil, 'lead', H);
    const real = new Float32Array(H + 1), imag = new Float32Array(H + 1);
    for (let h = 1; h <= H; h++) {
      const base = (1 / h) * Math.exp(-h / 12);
      imag[h] = base * 0.75 + wt.imag[h] * 0.25 * base * h;
      real[h] = wt.real[h] * 0.25 * base * h;
    }
    return { real, imag };
  }

  /* ── §9.2 Vocal tract ──────────────────────────────────────────────────
     Three formants per vowel: [Hz, Hz, Hz], relative gains, bandwidths.
     Classic Peterson & Barney style values, rounded.
     ─────────────────────────────────────────────────────────────────────── */
  const FORMANTS = {
    A: { f: [730, 1090, 2440], g: [1.0, 0.45, 0.22] },
    E: { f: [530, 1840, 2480], g: [1.0, 0.50, 0.25] },
    I: { f: [270, 2290, 3010], g: [1.0, 0.38, 0.28] },
    O: { f: [570, 840, 2410],  g: [1.0, 0.55, 0.15] },
    U: { f: [300, 870, 2240],  g: [1.0, 0.40, 0.10] },
    Y: { f: [440, 1020, 2240], g: [1.0, 0.48, 0.18] },   // schwa-ish, a hum
  };
  const VOWEL_KEYS = Object.keys(FORMANTS);
  const BANDWIDTH = [90, 110, 160];

  /**
   * The sequence of vowels the voice sings.
   * @param {string|null} struck the vowels removed by the reduction, or null
   *        to derive them from the hash (the default, so shared links match)
   */
  function vowelsOf(sigil, struck) {
    const n = Math.max(4, sigil.nodes.length);
    if (struck) {
      const v = [...struck.toUpperCase()].filter((c) => FORMANTS[c]);
      if (v.length) return Array.from({ length: n }, (_, i) => v[i % v.length]);
    }
    const R = stream(sigil.hash, 'vowels');
    return Array.from({ length: n }, () => R.pick(VOWEL_KEYS));
  }

  /* ── §9.3 Patches ──────────────────────────────────────────────────────
     A patch is a flat record of named scalars. Each field declares a range and
     a default drawn from stream(hash,'patch'), so every sigil arrives with a
     native voice. The codec quantises each field to one byte: 20 bytes, which
     base64urls to 27 characters in a share link.
     ─────────────────────────────────────────────────────────────────────── */
  const FIELDS = [
    // key          min   max   default(R, sigil)
    ['engine',      0,    1,    () => 1],                      // 0 classic, 1 sigil
    ['leadVoice',   0,    2,    (R) => R.weighted([0, 1, 2], [5, 3, 1])], // wavetable | vocal | bell
    ['choirVocal',  0,    1,    () => 1],
    ['vowelSource', 0,    1,    () => 0],                      // 0 hash, 1 struck
    ['bright',      0,    1,    (R) => R.range(0.35, 0.8)],
    ['motion',      0,    1,    (R) => R.range(0.15, 0.6)],
    ['grit',        0,    1,    (R) => R.range(0, 0.35)],
    ['air',         0,    1,    (R) => R.range(0.2, 0.7)],
    ['morph',       0,    1,    (R) => R.range(0, 0.6)],        // lead ↔ pad table blend
    ['detune',      0,    30,   (R) => R.range(4, 16)],         // unison spread, cents
    ['sub',         0,    1,    (R) => R.range(0.1, 0.5)],
    ['attack',      0,    1,    (R) => R.range(0.02, 0.3)],
    ['release',     0,    1,    (R) => R.range(0.2, 0.6)],
    ['reso',        0,    1,    (R) => R.range(0.1, 0.5)],
    ['drive',       0,    1,    (R) => R.range(0.05, 0.4)],
    ['crush',       0,    1,    (R) => R.chance(0.25) ? R.range(0.2, 0.6) : 0],
    ['crushRate',   0,    1,    (R) => R.range(0.3, 1)],
    ['chorus',      0,    1,    (R) => R.range(0.1, 0.5)],
    ['vibrato',     0,    1,    (R) => R.range(0.2, 0.6)],
    ['breath',      0,    1,    (R) => R.range(0.1, 0.5)],
  ];
  const FIELD_INDEX = Object.fromEntries(FIELDS.map(([k], i) => [k, i]));

  function defaultPatch(sigil) {
    const R = stream(sigil.hash, 'patch');
    const p = {};
    for (const [key, , , def] of FIELDS) p[key] = def(R, sigil);
    return p;
  }

  const clampField = (key, v) => {
    const [, min, max] = FIELDS[FIELD_INDEX[key]];
    return clamp(+v || 0, min, max);
  };

  /* base64url without btoa/Buffer, so the same code runs in the browser,
     in a Worker and in Node. */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64e(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      const k = bytes.length - i;
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (k > 1 ? B64[(n >> 6) & 63] : '') + (k > 2 ? B64[n & 63] : '');
    }
    return s;
  }
  function b64d(str) {
    const out = [];
    for (let i = 0; i < str.length; i += 4) {
      const q = [0, 1, 2, 3].map((j) => B64.indexOf(str[i + j] || 'A'));
      if (q.some((v) => v < 0)) return null;
      const n = (q[0] << 18) | (q[1] << 12) | (q[2] << 6) | q[3];
      const k = str.length - i;
      out.push((n >> 16) & 255);
      if (k > 2) out.push((n >> 8) & 255);
      if (k > 3) out.push(n & 255);
    }
    return Uint8Array.from(out);
  }

  /** Patch → 'P' + base64url(version, …one byte per field). */
  function encodePatch(p) {
    const bytes = new Uint8Array(FIELDS.length + 1);
    bytes[0] = 1;
    FIELDS.forEach(([key, min, max], i) => {
      bytes[i + 1] = Math.round((clamp((p[key] ?? min), min, max) - min) / (max - min) * 255);
    });
    return 'P' + b64e(bytes);
  }

  /** 'P…' → patch, or null if malformed / from a future version. */
  function decodePatch(str) {
    if (typeof str !== 'string' || str[0] !== 'P') return null;
    const bytes = b64d(str.slice(1));
    if (!bytes || bytes.length < FIELDS.length + 1 || bytes[0] !== 1) return null;
    const p = {};
    FIELDS.forEach(([key, min, max], i) => { p[key] = min + (bytes[i + 1] / 255) * (max - min); });
    // Enums must land on exact integers.
    for (const k of ['engine', 'leadVoice', 'choirVocal', 'vowelSource']) p[k] = Math.round(p[k]);
    return p;
  }

  /** True when `p` differs audibly from the sigil's native patch. */
  function isEdited(p, sigil) {
    return encodePatch(p) !== encodePatch(defaultPatch(sigil));
  }

  return {
    PROFILE_BINS, HARMONICS, VARIANTS, FIELDS, FIELD_INDEX, FORMANTS, VOWEL_KEYS, BANDWIDTH,
    radialProfile, wavetable, glottal, vowelsOf,
    defaultPatch, clampField, encodePatch, decodePatch, isEdited,
  };
})();