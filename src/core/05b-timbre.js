'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5b  SOUND DESIGN — pure, deterministic, no audio context
   --------------------------------------------------------------------------
   Everything here is a function of the sigil (and an optional dream variant).
   Nothing touches the Web Audio API, so it can be tested in Node and it is
   identical on every machine.

   DETERMINISM
     • derive() uses stream(hash,'sound') for variant 0 and
       stream(hash,'sound:dream:N') for others. Independent of the composer.
     • tables() is a pure function of the sigil's nodes, curves and rings.

   PATCH CODES
     encodePatch / decodePatch turn a set of knob overrides into a short
     base64url string. It contains no words. Only the consonants and tuning
     travel, in keeping with the rest of the app.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundDesign = (() => {
  'use strict';

  /** Partials per wavetable frame. Band-limited by construction, so no aliasing. */
  const H = 24;
  /** Morph frames per wavetable. The sigil is drawn progressively across these. */
  const FRAMES = 9;
  /** Slots map onto partials 1…HARM_SPAN. */
  const HARM_SPAN = 16;
  /** Amplitude by ring (inner, middle, outer). Outer strokes are brightest. */
  const RING_AMP = [0.45, 0.7, 1];

  /**
   * Vowel formants: four resonances each (Hz) and their relative levels.
   * Values are close to published averages for adult voices.
   */
  const VOWELS = [
    { name: 'ah', f: [800, 1150, 2900, 3900], g: [1, 0.5, 0.25, 0.12] },
    { name: 'eh', f: [530, 1840, 2480, 3500], g: [1, 0.45, 0.22, 0.10] },
    { name: 'ee', f: [270, 2290, 3010, 3500], g: [1, 0.40, 0.30, 0.12] },
    { name: 'oh', f: [450, 800, 2830, 3800], g: [1, 0.60, 0.20, 0.10] },
    { name: 'oo', f: [325, 700, 2530, 3500], g: [1, 0.50, 0.18, 0.08] },
  ];

  /**
   * Patch fields: name → [short code, min, max]. Used by the share codec and
   * to clamp anything that arrives from a link, file or library import.
   */
  const FIELDS = {
    wave: ['w', 0, 8], sweep: ['s', 0, 1], voice: ['v'], vowel: ['o', 0, 4],
    throat: ['t', -1, 1], breath: ['b', 0, 1], bright: ['r', 0, 1], grit: ['g', 0, 1],
    bits: ['i', 2, 16], hold: ['h', 1, 16], fold: ['f', 0, 1], echo: ['e', 0, 1],
  };
  const INTEGER_FIELDS = new Set(['vowel', 'bits', 'hold']);
  const VOICES = ['auto', 'vox', 'wave'];

  const clampTo = (x, a, b) => Math.min(b, Math.max(a, x));

  /**
   * The sigil's own sound DNA. Each value is drawn in a fixed order, so adding a
   * new field at the END never changes existing ones.
   *
   * @returns {object} derived patch (knobs are overrides of this)
   */
  function derive(hash, variant = 0) {
    const R = stream(hash, variant ? `sound:dream:${variant}` : 'sound');
    return {
      mult: R.pick([1, 3, 5, 7]),            // how slots map onto partials
      off: R.int(0, 15),
      wave: R.range(0, 4),                   // starting morph frame
      sweep: R.range(0.15, 0.9),             // how far the morph travels per note
      voice: R.pick(['auto', 'auto', 'vox', 'wave']),
      vowel: R.int(0, 4),
      throat: R.range(-0.5, 0.5),
      breath: R.range(0.05, 0.4),
      bright: R.range(0.3, 0.9),
      grit: R.chance(0.5) ? R.range(0.25, 0.75) : 0,   // half of all sigils are gritty
      bits: R.pick([4, 6, 8, 10]),
      hold: R.pick([1, 2, 3, 4]),
      fold: R.range(0, 0.35),
      echo: R.range(0.1, 0.6),
    };
  }

  const cache = new Map();

  /**
   * Build the morph frames for a sigil.
   * Frame f includes the first ⌈(f+1)/FRAMES · n⌉ letters, so the morph is the
   * pen's own growth. Each letter adds a partial at its slot-derived harmonic,
   * with its ring as amplitude and its incoming curve as phase.
   *
   * @returns {{key: string, frames: {re: Float32Array, im: Float32Array}[]}}
   *          re/im are PeriodicWave coefficients, index 0 unused.
   */
  function tables(sig, variant = 0) {
    const key = sig.hex + ':' + variant;
    if (cache.has(key)) return cache.get(key);

    const D = derive(sig.hash, variant);
    const n = sig.nodes.length, frames = [];

    for (let f = 0; f < FRAMES; f++) {
      const re = new Float32Array(H + 1), im = new Float32Array(H + 1);
      im[1] = 0.3;                           // fundamental anchors the pitch
      const count = Math.max(1, Math.round(((f + 1) / FRAMES) * n));

      for (let i = 0; i < count; i++) {
        const nd = sig.nodes[i];
        const h = 1 + ((nd.slot * D.mult + D.off) % HARM_SPAN);
        const amp = RING_AMP[nd.ring] / Math.sqrt(h);
        const phi = i > 0 ? (sig.curves[i - 1] || 0) * Math.PI : 0;
        // sin(h·t + φ) = cos φ · sin(h·t) + sin φ · cos(h·t)
        im[h] += amp * Math.cos(phi);
        re[h] += amp * Math.sin(phi);
      }
      frames.push({ re, im });
    }

    const tb = { key, frames };
    if (cache.size > 48) cache.clear();  // keep memory bounded
    cache.set(key, tb);
    return tb;
  }

  /** A rich, fixed glottal pulse used as the vocal source. Amplitude falls as h^-1.5. */
  function glottal() {
    const N = 32, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = 1 / Math.pow(h, 1.5);
    return { re, im };
  }

  /**
   * A blended waveform for display (the scope), normalised to ±1.
   * @param {{re,im}} fa  frame at floor(position)
   * @param {{re,im}} fb  frame at ceil(position)
   * @param {number}  w   blend weight 0…1
   */
  function waveSamples(fa, fb, w, N = 128) {
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

  /* ── Patch codec ─────────────────────────────────────────────────────── */

  const b64 = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return atob(t);
  };

  /**
   * Encode knob overrides (plus a dream variant) as a compact code.
   * Returns '' when there is nothing to encode, so default sigils get no suffix.
   */
  function encodePatch(o = {}, variant = 0) {
    const j = {};
    for (const [name, [s]] of Object.entries(FIELDS)) {
      if (o[name] === undefined) continue;
      j[s] = typeof o[name] === 'number' ? +(+o[name]).toFixed(3) : o[name];
    }
    if (variant) j.d = variant;
    return Object.keys(j).length ? b64(JSON.stringify(j)) : '';
  }

  /**
   * Decode a patch code. Every value is clamped and type-checked, so a malformed
   * or hostile link cannot push the engine outside its safe ranges.
   * @returns {{o: object, variant: number} | null}
   */
  function decodePatch(code) {
    try {
      const j = JSON.parse(unb64(code));
      const o = {};
      for (const [name, [s, lo, hi]] of Object.entries(FIELDS)) {
        if (!(s in j)) continue;
        if (name === 'voice') {
          if (VOICES.includes(j[s])) o[name] = j[s];
        } else if (typeof j[s] === 'number' && Number.isFinite(j[s])) {
          let v = clampTo(j[s], lo, hi);
          if (INTEGER_FIELDS.has(name)) v = Math.round(v);
          o[name] = v;
        }
      }
      const variant = Number.isInteger(j.d) ? clampTo(j.d, 0, 99) : 0;
      return { o, variant };
    } catch {
      return null;
    }
  }

  return {
    H, FRAMES, VOWELS, FIELDS, VOICES,
    derive, tables, glottal, waveSamples,
    encodePatch, decodePatch, clampTo,
  };
})();