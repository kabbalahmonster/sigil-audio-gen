'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5b  SOUND DESIGN v4 · pure, deterministic, no audio context
   --------------------------------------------------------------------------
   THE CUBE
     X  FX = 13 frames   the sigil drawn progressively, letter by letter
     Y  FY = 9 layers    nine spectral characters (LAYER_NAMES)
     T                   each note travels a vector through the cube
     Z  (at playback)    Tilt and Density reshape any cell without rebuilding
                         the cube; cells are cached by their bucketed values

   MEMOISED derive(): the same sigil DNA is reused by the arc, the knobs, the
   drum engine and the visuals, so recomputing it is wasted work.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundDesign = (() => {
  'use strict';

  const H = 32;             // partials per cell
  const FX = 13;            // cube width  (path growth)
  const FY = 9;             // cube height (spectral layers)
  const HARM_SPAN = 16;     // base slot → partial map, 1…16 (identity preserved)
  const UPPER = 17;         // partials 17…32 are the density tier
  const RING_AMP = [0.45, 0.7, 1];
  const GOLDEN = 2.399963229728653;

  const LAYER_NAMES = ['full', 'hollow', 'resonant', 'metallic', 'dark', 'octave', 'saw', 'square', 'twin'];

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
    plosive:   [0.85, 0.55, 0.6],
    fricative: [1.25, 1.45, 1.0],
    nasal:     [0.7, 0.9, 0.45],
    liquid:    [1.0, 1.1, 0.75],
  };

  /** Patch fields: name → [share code, min, max]. 'd' is reserved for the dream index. */
  const FIELDS = {
    wave: ['w', 0, FX - 1], layer: ['l', 0, FY - 1], sweep: ['s', 0, 1], drift: ['y', 0, 1],
    tilt: ['x', -1, 1], density: ['z', 0, 2],
    sub: ['u', 0, 1], chorus: ['c', 0, 1], voice: ['v'], vowel: ['o', 0, 4],
    throat: ['t', -1, 1], breath: ['b', 0, 1], bright: ['r', 0, 1],
    grit: ['g', 0, 1], bits: ['i', 2, 16], hold: ['h', 1, 16], fold: ['f', 0, 1],
    drive: ['n', 0, 1], echo: ['e', 0, 1], drums: ['k', 0, 1.5],
    drumX: ['m', 0, 1], drumY: ['j', 0, 1],
    // drum tone and texture
    kSub: ['ks', 0, 2], kPunch: ['kp', 0, 2], kDecay: ['kd', 0.2, 2], kTone: ['kt', -5, 5],
    sBody: ['sb', 0, 2], sSnap: ['sn', 0, 2], sTone: ['st', 0, 2],
    hTone: ['ht', 0, 2], hDecay: ['hd', 0.2, 2],
    // the kit's own FX chain (DSP §5b). ⚠ APPEND ONLY below this line: mutate() draws once
    // per field in this order, so inserting one would re-deal every existing "Mutate".
    dDrive: ['dv', 0, 1], dPunch: ['dp', -1, 1], dBody: ['db', -1, 1],
    dCrush: ['dc', 0, 1], dBits: ['di', 2, 16], dHold: ['dh', 1, 16], dFilter: ['df', -1, 1],
    dSmash: ['ds', 0, 1], dRoom: ['dr', 0, 1], dEcho: ['de', 0, 1], dTime: ['dt', 0, 3],
    // which groove the kit plays (05c). Travels with the patch so a shared link keeps its drummer.
    take: ['tk', 0, 99],
    // motion (05d): how far the movers move, how much each pass evolves, which deal of movers
    // (0 = the sigil's own), and a bitmask of movers held still.
    motion: ['mo', 0, 2], evolve: ['ev', 0, 1], mVar: ['mv', 0, 99], mMute: ['mm', 0, 255],
  };
  const INTEGER_FIELDS = new Set(['vowel', 'bits', 'hold', 'dBits', 'dHold', 'dTime', 'take', 'mVar', 'mMute']);
  /**
   * Fields Mutate leaves alone: switches and indices, where a nudge is a different thing entirely;
   * and the kit's filter, which is a performance control (a nudge off centre takes the kick's sub away).
   */
  const FIXED_FIELDS = new Set(['bits', 'hold', 'voice', 'dBits', 'dHold', 'dTime', 'dFilter', 'take',
    'motion', 'evolve', 'mVar', 'mMute']);
  const VOICES = ['auto', 'vox', 'wave'];
  const clampTo = (x, a, b) => Math.min(b, Math.max(a, x));

  /* ── derive (memoised) ────────────────────────────────────────────────── */

  function deriveRaw(hash, variant) {
    const R = stream(hash, variant ? `sound:dream:${variant}` : 'sound');
    const P = {
      mult: R.pick([1, 3, 5, 7]),
      off: R.int(0, 15),
      layerShift: R.int(1, 7),
      densityBias: R.range(0.2, 0.9),         // how much of the upper partial tier the sigil carries
      wave: R.range(0, 4.5),
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
      drumX: R.range(0.3, 1),                 // drum size
      drumY: R.range(0, 1),                   // drum colour
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
      oct: R.chance(0.5) ? 2 : 1,             // kick octave from the dream
    };
    return P;
  }

  const dmemo = new Map();
  function derive(hash, variant = 0) {
    const key = toHex(hash) + ':' + variant;
    let d = dmemo.get(key);
    if (!d) {
      d = deriveRaw(hash, variant);
      if (dmemo.size > 64) dmemo.clear();
      dmemo.set(key, d);
    }
    return { ...d, kit: { ...d.kit } };   // callers may spread or mutate freely
  }

  /* ── drum FX: the sigil's own treatment of its kit ───────────────────────
     Drawn from a SEPARATE labelled stream, so derive() (and every sound golden)
     is untouched. The ranges are deliberately tame: a sigil may arrive with a
     little room and weight on its kit, never with it wrecked. The knobs go further. */
  /** Echo times for dTime 0…3, in beats: sixteenth, eighth, dotted eighth, quarter. */
  const ECHO_BEATS = [0.25, 0.5, 0.75, 1];
  const fxmemo = new Map();
  function drumFx(hash, variant = 0) {
    const key = toHex(hash) + ':' + variant;
    let d = fxmemo.get(key);
    if (!d) {
      const R = stream(hash, variant ? `drumfx:dream:${variant}` : 'drumfx');
      d = {                                     // ⚠ draw order is frozen, like derive()
        dDrive: R.range(0, 0.4),
        dPunch: R.range(0.1, 0.55),
        dBody: R.range(-0.25, 0.3),
        dCrush: R.chance(0.35) ? R.range(0.15, 0.45) : 0,
        dBits: R.pick([6, 8, 10, 12]),
        dHold: R.pick([1, 1, 2, 3]),
        dFilter: 0,                             // never dealt: a sigil does not arrive with its kit filtered
        dSmash: R.range(0.1, 0.5),
        dRoom: R.range(0.05, 0.35),
        dEcho: R.chance(0.4) ? R.range(0.1, 0.3) : 0,
        dTime: R.pick([0, 1, 2, 2]),
      };
      if (fxmemo.size > 64) fxmemo.clear();
      fxmemo.set(key, d);
    }
    return { ...d };
  }

  /* ── cell construction ───────────────────────────────────────────────── */

  function buildCell(sig, D, x, y) {
    const re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    im[1] = 0.3;
    const n = sig.nodes.length;
    const count = Math.max(1, Math.round(((x + 1) / FX) * n));
    const off = (D.off + y * D.layerShift) % HARM_SPAN;
    const res = 2 + ((D.off + y * 3) % 10);
    const dens = D.densityBias;
    const put = (h, a, p) => { im[h] += a * Math.cos(p); re[h] += a * Math.sin(p); };

    for (let i = 0; i < count; i++) {
      const nd = sig.nodes[i];
      const h = 1 + ((nd.slot * D.mult + off) % HARM_SPAN);
      const ring = RING_AMP[nd.ring];
      let amp = ring / Math.sqrt(h);
      let phi = i > 0 ? (sig.curves[i - 1] || 0) * Math.PI : 0;

      switch (y) {
        case 0: break;                                                                   // full
        case 1: if (h % 2 === 0) amp *= 0.22; break;                                     // hollow
        case 2: amp *= 1 + 2.2 * Math.exp(-Math.pow((h - res) / 2.2, 2)); break;         // resonant
        case 3: phi += h * GOLDEN; amp *= 0.9; break;                                    // metallic
        case 4: amp /= Math.sqrt(h); break;                                              // dark
        case 5: if (2 * h <= H) put(2 * h, (ring * 0.5) / Math.sqrt(2 * h), phi); break; // octave
        case 6: amp = ring / h; break;                                                   // saw
        case 7: amp = h % 2 === 0 ? 0 : ring / h; break;                                 // square
        case 8:                                                                          // twin
          amp *= 1 + 1.8 * Math.exp(-Math.pow((h - res) / 1.6, 2))
                   + 1.2 * Math.exp(-Math.pow((h - Math.round(res * 1.5)) / 1.6, 2));
          break;
      }
      put(h, amp, phi);

      // Density tier: a sigil's odd-parity strokes sing an upper partial too.
      if (((nd.slot + nd.ring) & 1) === 1) {
        const hu = UPPER + ((nd.slot * D.mult + off + nd.ring) % HARM_SPAN);
        put(hu, (ring * 0.5 * dens) / Math.sqrt(hu), phi * 0.5);
      }
    }
    if (y === 6) for (let h = 1; h <= H; h++) im[h] += (0.16 / h) * ((x + 1) / FX);   // saw fills with path
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

  function glottal() {
    const N = 32, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = 1 / Math.pow(h, 1.5);
    return { re, im };
  }

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

  /** Pure mirror of the worklet (minus dither), so the scope shows the real signal. */
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

  /* ── Sound arc ───────────────────────────────────────────────────────── */

  function arc(D, sec, si, n) {
    const k = n > 1 ? si / (n - 1) : 0, I = (sec.intensity || 0) / 3;
    const out = {
      wave: clampTo(D.wave + k * (FX - 1) * 0.3, 0, FX - 1),
      layer: clampTo(D.layer + I * (FY - 1) * 0.12 + k * 0.5, 0, FY - 1),
      sweep: clampTo(D.sweep * (0.5 + 0.7 * I), 0, 1),
      drift: clampTo(D.drift * (0.4 + 1.0 * k), 0, 1),
      bright: clampTo(D.bright * (0.55 + 0.5 * I + 0.2 * k), 0, 1),
      grit: clampTo(D.grit * (0.25 + 1.0 * I), 0, 1),
      chorus: clampTo(D.chorus * (0.55 + 0.7 * k), 0, 1),
      sub: clampTo(D.sub * (0.75 + 0.45 * (1 - Math.abs(k - 0.5) * 2)), 0, 1),
      drums: D.drums * (0.8 + 0.4 * I),
      drumX: clampTo(D.drumX + 0.3 * I, 0, 1),
      drumY: clampTo(D.drumY + 0.25 * k, 0, 1),
    };
    if (sec.final) {
      out.bright *= 0.45; out.grit *= 0.3; out.chorus = clampTo(out.chorus * 1.2, 0, 1);
      out.wave = clampTo(D.wave * 0.5, 0, FX - 1); out.drums *= 0.4;
    }
    if (si === 0) { out.grit *= 0.25; out.bright *= 0.8; }
    /* The kit's FX follow the rite too. Loud sections hit harder, dirtier and denser; sparse and
       half-time ones open into the room and let the echo speak; the Banishing dissolves into both.
       Only fields the patch actually carries are arced, so a patch without the chain stays without. */
    const half = sec.halfTime ? 1 : 0;
    const fx = (name, v, lo = 0, hi = 1) => { if (typeof D[name] === 'number') out[name] = clampTo(v, lo, hi); };
    fx('dPunch', D.dPunch * (0.75 + 0.4 * I), -1, 1);
    fx('dDrive', D.dDrive * (0.6 + 0.6 * I));
    fx('dCrush', D.dCrush * (0.4 + 0.8 * I));
    fx('dSmash', D.dSmash * (0.6 + 0.55 * I));
    fx('dRoom', D.dRoom * (1.1 - 0.3 * I + 0.3 * half) * (sec.final ? 1.5 : 1));
    fx('dEcho', D.dEcho * (1.1 - 0.5 * I + 0.4 * half) * (sec.final ? 1.6 : 1));
    return out;
  }

  /** Drum-cube kit for a section. Kept for compatibility; m15 reads drumX/drumY directly. */
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
      oct: K.oct,
    };
  }

  /* ── Sigil impulse response ──────────────────────────────────────────── */

  function irSpec(sig, variant = 0) {
    const D = derive(sig.hash, variant);
    const n = sig.nodes.length, taps = [];
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = sig.nodes[i], b = sig.nodes[i + 1];
      const th = (2 * Math.PI * (b.slot - a.slot)) / 21;
      const ra = [0.34, 0.6, 0.86][a.ring], rb = [0.34, 0.6, 0.86][b.ring];
      const len = Math.sqrt(ra * ra + rb * rb - 2 * ra * rb * Math.cos(th));
      acc += len;
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

    /* ── DRUM KIT CUBE ──────────────────────────────────────────────────────
     A 4 × 4 grid of kits, selected by drumX (size) and drumY (colour). Each
     cell is drawn from the sigil's own stream, so a sigil always has the same
     sixteen kits, and a dream has different ones. Memoised: it is called per hit. */
     const KIT_MEMO = new Map();
     function drumKit(hash, x, y) {
       const cx = clampTo(Math.round(x * 3), 0, 3), cy = clampTo(Math.round(y * 3), 0, 3);
       const key = toHex(hash) + ':' + cx + ':' + cy;
       let k = KIT_MEMO.get(key);
       if (k) return k;
       const R = stream(hash, `drumkit:${cx}:${cy}`);
       k = {
         cell: [cx, cy],
         kickStyle: R.pick([0, 0, 1, 2, 3]),        // 0 808 glide · 1 tight · 2 boom · 3 punch
         kickSemi: R.pick([0, 0, 5, 7, 12]),        // chord-relative offset, in key
         kickDecay: R.range(0.35, 1),
         kickSub: R.range(0.6, 1),                  // how much sub this kit carries
         snareStyle: R.pick([0, 1, 2, 3]),          // 0 tight · 1 fat · 2 rim · 3 snap
         snareBody: R.pick([5, 7, 12, 19]),         // semitones above the chord root
         hatStyle: R.pick([0, 1, 2]),               // 0 closed square · 1 metallic · 2 airy
         hatDecay: R.range(0.3, 1),
         crashLen: R.range(0.6, 1.6),
         room: R.range(0, 0.5),
       };
       if (KIT_MEMO.size > 128) KIT_MEMO.clear();
       KIT_MEMO.set(key, k);
       return k;
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
      if (lo === undefined || FIXED_FIELDS.has(name)) continue;
      if (!R.chance(0.4)) continue;
      const from = current[name] !== undefined ? current[name] : base[name];
      if (typeof from !== 'number') continue;
      let v = clampTo(from + R.range(-0.15, 0.15) * (hi - lo), lo, hi);
      if (INTEGER_FIELDS.has(name)) v = Math.round(v);
      o[name] = +v.toFixed(3);
    }
    return o;
  }

  return {
    H, FX, FY, UPPER, LAYER_NAMES, VOWELS, FIELDS, VOICES, CONSONANT_CLASS, CLASS_TONE,
    derive, tables, glottal, waveSamples, applyFx,
    arc, kitAt, irSpec, drumKit, drumFx, ECHO_BEATS,
    encodePatch, decodePatch, mutate, clampTo,
  };
})();

if (typeof window !== 'undefined') window.SoundDesign = SoundDesign;