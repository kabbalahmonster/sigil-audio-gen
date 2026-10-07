'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5b  SOUND DESIGN — pure, deterministic, no audio context
   --------------------------------------------------------------------------
   Everything here is a pure function of the sigil, the dream variant, and
   (for evolve) the pass and progress. It can be tested in Node.

   3D WAVETABLE
     X  morph frame   0…8   the sigil drawn progressively (the pen's growth)
     Y  spectral tilt  3    bright → dark (from the Bright knob)
     Z  phase twist    3    pure → fully curved (from the note's degree mod 3)

   DETERMINISM
     derive()  → stream(hash,'sound')   — UNCHANGED, so existing snapshots hold
     derive2() → stream(hash,'sound2')  — sub, chorus, kit. Independent.
     tables()  → frames at Y=0,Z=full — UNCHANGED arithmetic
     volume()  → all 9 cells (3×3 of frame sets)
   ══════════════════════════════════════════════════════════════════════════ */

const SoundDesign = (() => {
  'use strict';

  /** Partials per frame. Band-limited, so no aliasing. */
  const H = 24;
  /** Morph frames (X). */
  const FRAMES = 9;
  /** Slots map onto partials 1…HARM_SPAN. */
  const HARM_SPAN = 16;
  /** Amplitude by ring (inner, middle, outer). */
  const RING_AMP = [0.45, 0.7, 1];
  /** Y axis: spectral tilt exponents. Index 0 is brightest. */
  const TILTS = [0, 0.6, 1.4];
  /** Z axis: phase scale. Index 2 is the full curved phase. */
  const PHASES = [0, 0.5, 1];

  /** Vowel formants (Hz) and relative levels. Close to averages for adult voices. */
  const VOWELS = [
    { name: 'ah', f: [800, 1150, 2900, 3900], g: [1, 0.5, 0.25, 0.12] },
    { name: 'eh', f: [530, 1840, 2480, 3500], g: [1, 0.45, 0.22, 0.10] },
    { name: 'ee', f: [270, 2290, 3010, 3500], g: [1, 0.40, 0.30, 0.12] },
    { name: 'oh', f: [450, 800, 2830, 3800], g: [1, 0.60, 0.20, 0.10] },
    { name: 'oo', f: [325, 700, 2530, 3500], g: [1, 0.50, 0.18, 0.08] },
  ];

  const KITS = ['bone', 'velvet', 'glass', 'ember'];
  const VOICES = ['auto', 'vox', 'wave'];

  /**
   * Auras: fixed timbral moods. They sit between derived DNA and user overrides.
   * Only the listed fields are set; everything else comes from the DNA.
   */
  const AURAS = {
    none: {},
    ember: { grit: 0.55, bits: 6, hold: 2, fold: 0.3, bright: 0.8, sub: 0.2, chorus: 0.1, kit: 'ember' },
    undertow: { sub: 0.85, chorus: 0.55, grit: 0, bright: 0.25, echo: 0.55, bits: 16, hold: 1, fold: 0, kit: 'bone' },
    glass: { bright: 0.95, chorus: 0.3, sub: 0.05, grit: 0.1, bits: 12, hold: 1, voice: 'wave', kit: 'glass' },
    choir: { voice: 'vox', chorus: 0.45, breath: 0.28, sub: 0.15, throat: 0.1, kit: 'velvet' },
    reliquary: { throat: -0.4, breath: 0.05, grit: 0.15, bits: 10, hold: 3, echo: 0.7, sub: 0.3, kit: 'bone' },
    static: { grit: 0.85, bits: 4, hold: 6, fold: 0.5, chorus: 0.2, bright: 0.6, kit: 'ember' },
    dusk: { sweep: 0.9, bright: 0.45, chorus: 0.4, breath: 0.18, sub: 0.4, echo: 0.45, kit: 'velvet' },
  };

  /**
   * Patch fields: name → [short code, min, max]. ORDER MATTERS for the share
   * codec. The original twelve stay first, in their original order, so existing
   * codes and the codec golden snapshot are unchanged. New fields go at the end.
   */
  const FIELDS = {
    wave: ['w', 0, 8], sweep: ['s', 0, 1], voice: ['v'], vowel: ['o', 0, 4],
    throat: ['t', -1, 1], breath: ['b', 0, 1], bright: ['r', 0, 1], grit: ['g', 0, 1],
    bits: ['i', 2, 16], hold: ['h', 1, 16], fold: ['f', 0, 1], echo: ['e', 0, 1],
    sub: ['u', 0, 1], chorus: ['c', 0, 1], evolve: ['x', 0, 1], kit: ['k'], aura: ['a'],
  };
  const ENUMS = { voice: VOICES, kit: KITS, aura: Object.keys(AURAS) };
  const INTEGER_FIELDS = new Set(['vowel', 'bits', 'hold']);

  const clampTo = (x, a, b) => Math.min(b, Math.max(a, x));
  const wrap = (x, lo, hi) => lo + (((x - lo) % (hi - lo)) + (hi - lo)) % (hi - lo);

  /* ── DNA ───────────────────────────────────────────────────────────────── */

  /** Original DNA. DO NOT reorder or change these draws: the sound snapshots depend on them. */
  function derive(hash, variant = 0) {
    const R = stream(hash, variant ? `sound:dream:${variant}` : 'sound');
    return {
      mult: R.pick([1, 3, 5, 7]),
      off: R.int(0, 15),
      wave: R.range(0, 4),
      sweep: R.range(0.15, 0.9),
      voice: R.pick(['auto', 'auto', 'vox', 'wave']),
      vowel: R.int(0, 4),
      throat: R.range(-0.5, 0.5),
      breath: R.range(0.05, 0.4),
      bright: R.range(0.3, 0.9),
      grit: R.chance(0.5) ? R.range(0.25, 0.75) : 0,
      bits: R.pick([4, 6, 8, 10]),
      hold: R.pick([1, 2, 3, 4]),
      fold: R.range(0, 0.35),
      echo: R.range(0.1, 0.6),
    };
  }

  /** Second DNA stream. Independent of derive(), so adding to it never shifts the original. */
  function derive2(hash, variant = 0) {
    const R = stream(hash, variant ? `sound2:dream:${variant}` : 'sound2');
    return {
      sub: R.range(0.15, 0.6),
      chorus: R.range(0.1, 0.5),
      kit: R.pick(KITS),
    };
  }

  /* ── Wavetables ────────────────────────────────────────────────────────── */

  const cache = new Map();

  /**
   * Build the nine morph frames for one (tilt, phase) cell.
   * With tilt = 0 and phaseScale = 1 this is exactly the original arithmetic.
   */
  function buildFrames(sig, D, tilt, phaseScale) {
    const n = sig.nodes.length, frames = [];
    for (let f = 0; f < FRAMES; f++) {
      const re = new Float32Array(H + 1), im = new Float32Array(H + 1);
      im[1] = 0.3;                                           // fundamental anchors the pitch
      const count = Math.max(1, Math.round(((f + 1) / FRAMES) * n));
      for (let i = 0; i < count; i++) {
        const nd = sig.nodes[i];
        const h = 1 + ((nd.slot * D.mult + D.off) % HARM_SPAN);
        const amp = (RING_AMP[nd.ring] / Math.sqrt(h)) * Math.pow(h, -tilt);
        const phi = i > 0 ? (sig.curves[i - 1] || 0) * Math.PI * phaseScale : 0;
        im[h] += amp * Math.cos(phi);          // sin(h·t+φ) = cosφ·sin(h·t) + sinφ·cos(h·t)
        re[h] += amp * Math.sin(phi);
      }
      frames.push({ re, im });
    }
    return frames;
  }

  /** Base frames (Y = 0, Z = full). Unchanged from the original. */
  function tables(sig, variant = 0) {
    const key = sig.hex + ':' + variant;
    if (cache.has(key)) return cache.get(key);
    const D = derive(sig.hash, variant);
    const tb = { key, frames: buildFrames(sig, D, 0, 1) };
    if (cache.size > 48) cache.clear();
    cache.set(key, tb);
    return tb;
  }

  /**
   * The full 3D volume. cells[y][z] is an array of nine frames.
   * Built once per sigil and variant. Nothing is allocated per note.
   */
  function volume(sig, variant = 0) {
    const key = 'vol:' + sig.hex + ':' + variant;
    if (cache.has(key)) return cache.get(key);
    const D = derive(sig.hash, variant);
    const cells = TILTS.map((tl) => PHASES.map((ps) => buildFrames(sig, D, tl, ps)));
    const v = { key, cells };
    if (cache.size > 48) cache.clear();
    cache.set(key, v);
    return v;
  }

  /** Which volume cell a note addresses. Y from brightness, Z from the melody's degree. */
  function address(P, deg = 0) {
    const yi = clampTo(Math.round((1 - P.bright) * 2), 0, 2);
    const zi = ((Math.round(deg) % 3) + 3) % 3;
    return { yi, zi };
  }

  /** A glottal pulse train for the vocal source. Amplitude falls as h^-1.5. */
  function glottal() {
    const N = 32, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = 1 / Math.pow(h, 1.5);
    return { re, im };
  }

  /** A blended, normalised waveform for display. */
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

  /**
   * The three display lanes: clean, folded (the wavefold transfer),
   * crushed (the real output of the worklet: fold → quantise → sample-and-hold,
   * mixed by Grit). The hold is display-scaled by 2 so stepping is visible.
   */
  function shapeWave(src, P) {
    const N = src.length;
    const folded = new Float32Array(N), crushed = new Float32Array(N);
    const fold = P.fold || 0, grit = P.grit || 0;
    const levels = Math.pow(2, (grit > 0 ? P.bits : 16) - 1);
    const hold = Math.max(1, Math.round((grit > 0 ? P.hold : 1) * 2));

    for (let i = 0; i < N; i++) {
      let v = src[i];
      if (fold > 0) v = (1 - fold) * v + fold * Math.sin(v * Math.PI * 0.5 * (1 + 3 * fold));
      folded[i] = clampTo(v, -1, 1);
    }
    let held = 0;
    for (let i = 0; i < N; i++) {
      if (i % hold === 0) held = Math.round(folded[i] * levels) / levels;
      crushed[i] = src[i] * (1 - grit) + held * grit;
    }
    return { clean: src, folded, crushed };
  }

  /* ── Evolve: the sonic story across passes ─────────────────────────────── */

  /**
   * Drift a patch across passes and across the render.
   *   pass      0,1,2… the loop or render pass
   *   passes    total passes in the story (for the arc)
   *   progress  0…1 position within the pass
   *   amount    0…1 (P.evolve). Zero returns P unchanged.
   */
  function evolve(P, pass = 0, passes = 4, progress = 0, amount = 0) {
    if (!amount) return P;
    const story = Math.min(1, (pass + progress) / Math.max(1, passes));
    return {
      ...P,
      wave: wrap(P.wave + amount * pass * 1.3, 0, 8),                 // the morph drifts each pass
      vowel: (P.vowel + Math.round(amount * pass)) % 5,                // the vowel walks
      throat: clampTo(P.throat + amount * pass * 0.15, -1, 1),
      grit: clampTo(P.grit + amount * pass * 0.12, 0, 1),              // the sound decays into grit
      bright: clampTo(P.bright + amount * story * 0.35, 0, 1),         // and opens over the arc
      echo: clampTo(P.echo + amount * story * 0.25, 0, 1),
    };
  }

  /* ── Patch codec ───────────────────────────────────────────────────────── */

  const b64 = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return atob(t);
  };

  /** Encode overrides and a dream variant. Returns '' when there is nothing to encode. */
  function encodePatch(o = {}, variant = 0) {
    const j = {};
    for (const [name, [s]] of Object.entries(FIELDS)) {
      if (o[name] === undefined) continue;
      j[s] = typeof o[name] === 'number' ? +(+o[name]).toFixed(3) : o[name];
    }
    if (variant) j.d = variant;
    return Object.keys(j).length ? b64(JSON.stringify(j)) : '';
  }

  /** Decode and sanitise. Everything is clamped or checked against its enum. */
  function decodePatch(code) {
    try {
      const j = JSON.parse(unb64(code));
      const o = {};
      for (const [name, spec] of Object.entries(FIELDS)) {
        const [s, lo, hi] = spec;
        if (!(s in j)) continue;
        if (ENUMS[name]) {
          if (ENUMS[name].includes(j[s])) o[name] = j[s];
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
    H, FRAMES, TILTS, PHASES, VOWELS, KITS, VOICES, AURAS, FIELDS, ENUMS,
    derive, derive2, tables, volume, address, glottal, waveSamples, shapeWave,
    evolve, encodePatch, decodePatch, clampTo,
  };
})();