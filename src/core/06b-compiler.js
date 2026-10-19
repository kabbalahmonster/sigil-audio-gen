'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §6b  SCORE → PLAN COMPILER
   --------------------------------------------------------------------------
   Turns composeSong's event objects into the DSP core's flat tables. All the
   musical THINKING happens here (pitch, lens, vowel, consonant, drum kit,
   chord roots); the core only makes sound.

     events    one STRIDE row per score event (crash → 1 row, pad → 1 row)
     sections  one PSTRIDE row per section: the Sound arc patch (SD.arc)
     tables    the wavetable cube, built in slices (reachable cells first)

   Live edits have three price levels (see Part 5 of the docs):
     refreshSections  ~µs   knobs the core reads at note-on / per block (incl. the drum FX chain)
     sendTables       ~ms   tilt, density, dream (background slices)
     replan           ~ms   anything baked into rows (drums, lens, vowels)

   DRUMS. The score says WHAT is struck and how hard; this file decides what
   that stroke sounds like: the kit cell, the chord it is tuned to, the letter
   that colours it, and (when the song carries a groove, 05c) how velocity
   reshapes the hit. A song without a groove compiles exactly as it always did.
   ══════════════════════════════════════════════════════════════════════════ */
const SigilPlan = (() => {
  'use strict';
  const D = SigilDSP, SD = SoundDesign;
  const { EV, STRIDE, KIND, BUS, PA, PSTRIDE } = D;

  const DEFAULTS = { tilt: 0, density: 1, kSub: 1, kPunch: 1, kDecay: 1, kTone: 0, sBody: 1, sSnap: 1, sTone: 1, hTone: 1, hDecay: 1 };
  const TIMBRE = { glass: 0, reed: 1, koto: 2 };
  const VOICE = { auto: 0, wave: 1, vox: 2, fm: 3, bow: 4, bell: 5 };
  const CONS = { liquid: 0, plosive: 1, fricative: 2, nasal: 3 };
  const KSTYLE = [
    { glide: 1.7, glideT: 0.09, decay: 1.0, click: 0.5 },
    { glide: 2.6, glideT: 0.03, decay: 0.5, click: 1.0 },
    { glide: 1.3, glideT: 0.06, decay: 1.4, click: 0.3 },
    { glide: 3.2, glideT: 0.02, decay: 0.65, click: 1.5 },
  ];
  const SSTYLE = [
    { body: 1.0, bodyDec: 0.035, noise: 1.0, snap: 0.9, rim: 0 },
    { body: 1.6, bodyDec: 0.075, noise: 0.8, snap: 0.6, rim: 0 },
    { body: 0.55, bodyDec: 0.02, noise: 0.6, snap: 1.2, rim: 1 },
    { body: 0.35, bodyDec: 0.02, noise: 1.35, snap: 1.1, rim: 0 },
  ];
  const SECTION_DUCK = [0, 0.45, 1.0, 0.7, 0.9, 1.15, 0.35];
  /** Mirrors m15's settings, for hosts without the module (Node bench, workers). */
  const DRUM_DEFAULTS = { duck: 0.5, sidechain: true, sectionAware: true, tuneToKey: true, kickOct: 'auto',
    fx: true, dynamics: 0.6 };
  /** Stereo seats for the three toms (audience view): floor right, rack centre, high left. */
  const TOM_PAN = [0.32, 0, -0.32];
  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const hasApp = () => typeof app !== 'undefined';
  const variantOf = (tb) => parseInt(String(tb.key).split(':').pop(), 10) || 0;

  /* ── Inputs from optional modules (all soft dependencies) ───────────── */
  function defaultSpec(sigil, song) {
    const mood = (song && song.cfg && song.cfg.sound) || {};
    return { P: { ...DEFAULTS, ...SD.derive(sigil.hash, 0), ...SD.drumFx(sigil.hash, 0), ...mood }, cube: SD.tables(sigil, 0),
      variant: 0, arc: true, frozen: false, verb: true, vowels: null };
  }
  /** The sound patch: the live Sound module's (knobs, dream, mood, render spec) or a derived one. */
  function soundSpec(sigil, song) {
    if (typeof Sound !== 'undefined' && sigil) {
      const st = Sound.state();
      const sp = Sound.currentSpec ? Sound.currentSpec() : st;
      if (sp && sp.P && sp.tables && st.key === (sigil.fusionKey || sigil.reduced)) {
        return {
          P: sp.P, cube: sp.tables, variant: variantOf(sp.tables),
          arc: Sound.arcOn, frozen: Sound.frozen, verb: Sound.sigilVerbOn,
          vowels: Sound.vowelMemory ? Sound.vowelMemory() : null,
        };
      }
    }
    return defaultSpec(sigil, song);
  }
  /** The drum settings in force: the module's, or the defaults; `over` wins (offline jobs, tests). */
  function drumSettings(over) {
    const base = (typeof DrumEngine !== 'undefined' && DrumEngine.settings) || DRUM_DEFAULTS;
    return over ? { ...DRUM_DEFAULTS, ...base, ...over } : base;
  }
  function waveOffset() {
    return typeof Sound !== 'undefined' && Sound.lensWave && typeof LiveLens !== 'undefined' ? LiveLens.shift * 0.6 : 0;
  }

  /* ── Sections ───────────────────────────────────────────────────────── */
  function patches(song, spec) {
    const n = song.sections.length;
    return song.sections.map((sec, si) => (spec.arc ? { ...spec.P, ...SD.arc(spec.P, sec, si, n) } : spec.P));
  }
  function sectionsTable(song, sigil, spec, Ps, DS) {
    const out = new Float64Array(Ps.length * PSTRIDE);
    const fxOn = DS.fx !== false;                    // the panel's bypass: every D* column at rest
    Ps.forEach((P, si) => {
      const o = si * PSTRIDE, sec = song.sections[si];
      const set = (k, v, d) => { out[o + PA[k]] = num(v, d); };
      set('START', sec.start, 0);
      set('BRIGHT', P.bright, 0.6); set('SUB', P.sub, 0.2); set('BREATH', P.breath, 0.2); set('THROAT', P.throat, 0);
      set('WAVE', P.wave, 2); set('LAYER', P.layer, 1);
      set('SWEEP', spec.frozen ? 0 : P.sweep, 0.5); set('DRIFT', spec.frozen ? 0 : P.drift, 0.3);
      set('VOWEL', P.vowel, 0); out[o + PA.VOICE] = VOICE[P.voice] || 0;
      set('DRUMS', P.drums, 1); set('HDECAY', P.hDecay, 1);
      set('CHORUS', P.chorus, 0.3); set('ECHO', P.echo, 0.3);
      const grit = num(P.grit, 0);
      out[o + PA.GRIT] = grit; out[o + PA.BITS] = grit > 0 ? num(P.bits, 8) : 16;
      set('HOLD', P.hold, 1); set('FOLD', P.fold, 0); set('DRIVE', P.drive, 0);
      out[o + PA.DUCK] = DS.sidechain ? num(DS.duck, 0.5) * (DS.sectionAware ? (SECTION_DUCK[si] ?? 1) : 1) : 0;
      out[o + PA.INTENSITY] = sec.intensity || 0;

      /* The kit's FX chain (DSP §5b). Left at rest, these columns reproduce the pre-chain kit exactly. */
      out[o + PA.DBITS] = 16; out[o + PA.DHOLD] = 1; out[o + PA.DSIZE] = 0.5; out[o + PA.DTIME] = 0.75;
      if (fxOn) {
        const crush = clamp(num(P.dCrush, 0), 0, 1);
        out[o + PA.DPUNCH] = clamp(num(P.dPunch, 0), -1, 1); out[o + PA.DBODY] = clamp(num(P.dBody, 0), -1, 1);
        out[o + PA.DDRIVE] = clamp(num(P.dDrive, 0), 0, 1); out[o + PA.DFILTER] = clamp(num(P.dFilter, 0), -1, 1);
        out[o + PA.DCRUSH] = crush; out[o + PA.DBITS] = crush > 0 ? num(P.dBits, 8) : 16;
        out[o + PA.DHOLD] = num(P.dHold, 1);
        out[o + PA.DSMASH] = clamp(num(P.dSmash, 0), 0, 1);
        // Each kit cell carries its own room: with the arc on, the cell colours the knob (×0.7…1.3).
        const kit = SD.drumKit(sigil.hash, num(P.drumX, 0.5), num(P.drumY, 0.5));
        out[o + PA.DROOM] = clamp(num(P.dRoom, 0) * (spec.arc ? 0.7 + 1.2 * kit.room : 1), 0, 1);
        out[o + PA.DSIZE] = clamp(num(P.drumX, 0.5), 0, 1);          // a bigger kit sits in a bigger room
        out[o + PA.DECHO] = clamp(num(P.dEcho, 0), 0, 1);
        out[o + PA.DTIME] = SD.ECHO_BEATS[clamp(Math.round(num(P.dTime, 2)), 0, SD.ECHO_BEATS.length - 1)];
      }
    });
    return out;
  }

  /* ── Events ─────────────────────────────────────────────────────────── */
  /** Noise seed from MUSICAL identity (beat, type, pitch): a render equals a performance. */
  function seedOf(ev) {
    let s = Math.round(ev.beat * 960) | 0;
    for (let i = 0; i < ev.type.length; i++) s = (Math.imul(s, 31) + ev.type.charCodeAt(i)) | 0;
    s ^= Math.imul((ev.midi || 0) | 0, 0x9e3779b1);
    return s || 1;
  }
  /** Bass-register chord root at a beat (same rule as m15's rootAt). */
  function rootAt(song, beat, DS) {
    if (!DS.tuneToKey) return song.bassBase;
    const P = song.phrases;
    let lo = 0, hi = P.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (P[m].start <= beat) lo = m; else hi = m - 1; }
    const ph = P[lo];
    return bassPitch(ph.chords[clamp(Math.floor((beat - ph.start) / 4), 0, 3)], 'root', song.bassBase, song.scale);
  }
  function compileEvents(song, sigil, spec, Ps, lens, DS) {
    const src = song.events, N = src.length, out = new Float64Array((N * 2 + 8) * STRIDE);
    const red = sigil.reduced, RL = red.length;
    /* Velocity → timbre. Only for songs that carry a groove (05c): a hard hit opens up and rings
       longer, a ghost is shorter, darker and more skin than wire. `hard` is the stroke relative
       to that drum's normal one (1 = normal); with dyn at 0 it is exactly 1 and nothing moves. */
    const dyn = song.cfg && song.cfg.groove ? clamp(num(DS.dynamics, 0.6), 0, 1) : 0;
    const hard = (vel, ref) => (dyn > 0 ? 1 + dyn * (clamp(num(vel, ref) / ref, 0.15, 1.35) - 1) : 1);
    const vowels = spec.vowels && spec.vowels.length ? spec.vowels : null;
    const starts = song.sections.map((s) => s.start);
    let si = 0, n = 0;
    const put = (ev, kind, bus, f) => {
      const o = n++ * STRIDE;
      out[o] = ev.beat; out[o + EV.KIND] = kind; out[o + EV.BUS] = bus; out[o + EV.F] = f;
      out[o + EV.VEL] = ev.vel ?? 0.8; out[o + EV.DUR] = ev.dur || 0.25; out[o + EV.SEED] = seedOf(ev);
      return o;
    };
    for (let i = 0; i < N; i++) {
      const raw = src[i];
      while (si + 1 < starts.length && raw.beat >= starts[si + 1]) si++;
      const ev = lens ? LiveLens.map(raw, song) : raw;
      const P = Ps[si];
      switch (ev.type) {
        case 'lead': case 'harm': {
          const lead = ev.type === 'lead';
          const o = put(ev, lead ? KIND.LEAD : KIND.VOX, lead ? BUS.lead : BUS.harm, mtof(ev.midi));
          out[o + EV.F0] = ev.from != null ? mtof(ev.from) : 0;
          out[o + EV.PAN] = ev.part === 1 ? -0.3 : ev.part === 2 ? 0.3 : 0;
          out[o + EV.AUX] = ev.deg ?? 0;
          out[o + EV.P0] = TIMBRE[ev.timbre] ?? 0;
          out[o + EV.P1] = vowels ? vowels[mod(Math.round((ev.beat ?? ev.deg) * 2), vowels.length)] : -1;
          out[o + EV.P2] = CONS[SD.CONSONANT_CLASS[red[mod(Math.round(ev.beat * 2), RL)]] || 'fricative'];
          out[o + EV.P3] = lead ? 1 : 0.7;
          break;
        }
        case 'bell': { const o = put(ev, KIND.BELL, BUS.bell, mtof(ev.midi)); out[o + EV.AUX] = ev.deg ?? 0; break; }
        case 'bass': {
          const o = put(ev, KIND.WAVE, BUS.bass, mtof(ev.midi));
          out[o + EV.P0] = 0.18; out[o + EV.P1] = 0.3; out[o + EV.P2] = 0.4; out[o + EV.P3] = 0; out[o + EV.P4] = 0;
          break;
        }
        case 'arp': {
          const o = put(ev, KIND.WAVE, BUS.arp, mtof(ev.midi));
          out[o + EV.PAN] = ev.pan || 0;
          out[o + EV.P0] = -1; out[o + EV.P1] = -1; out[o + EV.P2] = 0.26; out[o + EV.P3] = 0; out[o + EV.P4] = 0;
          break;
        }
        case 'pad': {
          const m = ev.midis, o = put(ev, KIND.PAD, BUS.pad, mtof(m[0]));
          for (let j = 1; j < 5; j++) out[o + EV.P0 + j - 1] = j < m.length ? mtof(m[j]) : 0;
          out[o + EV.P5] = ev.bright || 0;
          break;
        }
        case 'drone': put(ev, KIND.DRONE, BUS.drone, mtof(ev.midi)); break;
        case 'swell': {
          const o = put(ev, KIND.NOISE, BUS.bell, 0);
          out[o + EV.VEL] = (ev.vel ?? 0.8) * 0.09;
          out[o + EV.P0] = 1; out[o + EV.P1] = 300; out[o + EV.P2] = 6000; out[o + EV.P3] = 1.5;
          out[o + EV.P4] = 0; out[o + EV.P5] = 0.1; out[o + EV.AUX] = 1;
          break;
        }
        case 'kick': case 'snare': case 'hat': case 'shaker': case 'crash': case 'tom': case 'rim': {
          const kit = SD.drumKit(sigil.hash, num(P.drumX, 0.5), num(P.drumY, 0.5));
          const root = rootAt(song, ev.beat, DS);
          const tone = SD.CLASS_TONE[SD.CONSONANT_CLASS[red[mod(Math.round(ev.beat * 4), RL)]] || 'fricative'];
          const hTone = num(P.hTone, 1), hDecay = num(P.hDecay, 1);
          if (ev.type === 'kick') {
            const st = KSTYLE[kit.kickStyle], kPunch = num(P.kPunch, 1), h = hard(ev.vel, 0.95);
            const oct = DS.kickOct === 'low' ? 0.5 : DS.kickOct === 'high' ? 2 : 1;
            const f = mtof(root + (DS.tuneToKey ? kit.kickSemi : 0)) * oct * Math.pow(2, num(P.kTone, 0) / 12)
                    * (kit.kickStyle === 2 ? 0.5 : 1);
            const o = put(ev, KIND.KICK, BUS.drums, f);
            out[o + EV.P0] = st.glide; out[o + EV.P1] = st.glideT;
            out[o + EV.P2] = (0.2 + 0.55 * kit.kickDecay) * st.decay * num(P.kDecay, 1);
            out[o + EV.P3] = kit.kickSub * num(P.kSub, 1);
            out[o + EV.P4] = 0.45 * st.click * kPunch; out[o + EV.P5] = kPunch;
            out[o + EV.AUX] = 1400 + 2200 * num(P.drumY, 0.5);
            if (h !== 1) {                                // a soft kick: less beater, less dive, shorter
              out[o + EV.P0] = 1 + (st.glide - 1) * (0.55 + 0.45 * h);
              out[o + EV.P2] *= 0.7 + 0.3 * h; out[o + EV.P4] *= h * h;
            }
          } else if (ev.type === 'snare') {
            const st = SSTYLE[kit.snareStyle], sSnap = num(P.sSnap, 1), sTone = num(P.sTone, 1), h = hard(ev.vel, 0.8);
            const o = put(ev, KIND.SNARE, BUS.drums, mtof(root + kit.snareBody));
            out[o + EV.F0] = 0.55 * st.noise * tone[2];
            out[o + EV.P0] = 0.5 * st.body * num(P.sBody, 1);
            out[o + EV.P1] = (0.05 + 0.17 * sSnap) * tone[1];
            out[o + EV.P2] = 0.28 * st.snap;
            out[o + EV.P3] = (1200 + 1000 * sTone) * tone[0];
            out[o + EV.P4] = st.bodyDec * (0.6 + 0.8 * sSnap);
            out[o + EV.P5] = st.rim;
            out[o + EV.AUX] = 4800 + 1800 * sTone;
            if (h !== 1) {                                // a ghost: more skin than wire, short and dark
              out[o + EV.P0] *= 1.3 - 0.3 * h; out[o + EV.P1] *= 0.5 + 0.5 * h;
              out[o + EV.P2] *= h * h; out[o + EV.P3] *= 0.78 + 0.22 * h;
            }
          } else if (ev.type === 'rim') {                 // side-stick: the snare voice, all click and no wire
            const o = put(ev, KIND.SNARE, BUS.drums, mtof(root + kit.snareBody + 12));
            out[o + EV.PAN] = ev.pan || 0;
            out[o + EV.F0] = 0.1 * tone[2];
            out[o + EV.P0] = 0.22; out[o + EV.P1] = 0.018 * tone[1]; out[o + EV.P2] = 0.3;
            out[o + EV.P3] = 2400 * tone[0]; out[o + EV.P4] = 0.014; out[o + EV.P5] = 1;
            out[o + EV.AUX] = 5200;
          } else if (ev.type === 'tom') {
            /* Three toms on the chord: root, fifth, octave. A fill is therefore always in key. */
            const idx = clamp(ev.tom | 0, 0, 2), h = hard(ev.vel, 0.75);
            const low = fold(root + 12, 41, 52);
            const o = put(ev, KIND.TOM, BUS.drums, mtof(low + (idx === 2 ? 12 : idx === 1 ? 7 : 0)));
            out[o + EV.PAN] = ev.pan ?? TOM_PAN[idx];
            out[o + EV.P0] = (0.5 - 0.1 * idx) * (0.6 + 0.4 * h);
            out[o + EV.P1] = 0.07 - 0.015 * idx;
            // Short enough that sixteenths do not smear into one another; longer for the floor tom and a bigger kit.
            out[o + EV.P2] = (0.09 + 0.12 * kit.kickDecay) * (1.25 - 0.22 * idx) * (0.75 + 0.5 * num(P.drumX, 0.5))
                           * num(P.kDecay, 1) * (0.8 + 0.2 * h);
            out[o + EV.P3] = 0.32 * num(P.kPunch, 1) * tone[2] * h;
            out[o + EV.P4] = (1700 + 1500 * num(P.drumY, 0.5)) * tone[0];
            out[o + EV.P5] = 0.3;
          } else if (ev.type === 'hat') {
            const base = (DS.tuneToKey ? mtof(root + 30) : 320) * tone[0] * (0.7 + 0.3 * hTone), h = hard(ev.vel, 0.75);
            const len = (ev.open ? 0.4 + 0.45 * kit.hatDecay : 0.05 + 0.07 * kit.hatDecay) * hDecay;
            const o = put(ev, KIND.HAT, BUS.drums, base);
            out[o + EV.PAN] = ev.pan || 0;
            out[o + EV.P0] = len * 0.3; out[o + EV.P1] = 6500 + 2500 * hTone; out[o + EV.P2] = 9000 + 3000 * hTone;
            out[o + EV.P3] = 0.12 * tone[2]; out[o + EV.P4] = kit.hatStyle; out[o + EV.P5] = ev.open ? 6 : 4;
            if (h !== 1) {                                // a light tap: shorter and duller
              out[o + EV.P0] *= 0.65 + 0.35 * h; out[o + EV.P1] *= 0.86 + 0.14 * h; out[o + EV.P2] *= 0.9 + 0.1 * h;
            }
          } else if (ev.type === 'shaker') {
            const o = put(ev, KIND.NOISE, BUS.drums, 0), f = 5200 + 2600 * hTone;
            out[o + EV.VEL] = (ev.vel ?? 0.5) * 0.12; out[o + EV.PAN] = ev.pan || 0;
            out[o + EV.P0] = 1; out[o + EV.P1] = f; out[o + EV.P2] = f; out[o + EV.P3] = 1.2;
            out[o + EV.P4] = 0.014; out[o + EV.P5] = 0.024;
          } else {                                      // crash: metal cluster + HP noise on the bell bus
            const o = put(ev, KIND.HAT, BUS.bell, DS.tuneToKey ? mtof(root + 36) : 410);
            out[o + EV.P0] = kit.crashLen * hDecay * 0.35; out[o + EV.P1] = 2800; out[o + EV.P2] = 3600;
            out[o + EV.P3] = 1; out[o + EV.P4] = 3; out[o + EV.P5] = 5;
          }
          break;
        }
      }
    }
    return { events: out.slice(0, n * STRIDE), count: n };
  }

  /** Compile a song. opts: { spec, lens, events:false (sections only), drums (settings override) } */
  function compile(song, sigil, opts = {}) {
    const spec = opts.spec || soundSpec(sigil, song);
    const Ps = patches(song, spec), DS = drumSettings(opts.drums);
    const p = { spec, Ps, sections: sectionsTable(song, sigil, spec, Ps, DS), nSec: Ps.length, total: song.total };
    if (opts.events !== false) {
      const lens = opts.lens ?? (typeof LiveLens !== 'undefined' && LiveLens.active());
      Object.assign(p, compileEvents(song, sigil, spec, Ps, lens, DS));
    }
    return p;
  }

  /* ── Wavetables ─────────────────────────────────────────────────────── */
  /** Packed cube spectra: NCELL × {re[0..H], im[0..H]} as one Float32Array. */
  function spectra(cube) {
    const H1 = D.H + 1, out = new Float32Array(D.NCELL * 2 * H1);
    for (let y = 0; y < D.FY; y++) {
      for (let x = 0; x < D.FX; x++) {
        const c = cube.grid[y][x], o = (x + y * D.FX) * 2 * H1;
        for (let h = 0; h < H1; h++) { out[o + h] = c.re[h] || 0; out[o + H1 + h] = c.im[h] || 0; }
      }
    }
    return out;
  }
  /** Cells any section can start or travel to (both drift directions). */
  function reachable(Ps, off) {
    const set = new Set();
    const add = (x, y) => set.add(clamp(Math.round(x), 0, D.FX - 1) + clamp(Math.round(y), 0, D.FY - 1) * D.FX);
    for (const P of Ps) {
      const w = num(P.wave, 2) + off, l = num(P.layer, 1), sw = num(P.sweep, 0.5) * 4, dr = num(P.drift, 0.3) * 2.5;
      add(w, l); add(w + sw, l + dr); add(w + sw, l - dr);
    }
    return [...set];
  }
  /** Build and send the cube: reachable cells now, the rest in 16-cell slices. */
  function sendTables(eng, spec, Ps) {
    const tilt = num(spec.P.tilt, 0), dens = num(spec.P.density, 1);
    const key = `${spec.cube.key}|${tilt.toFixed(3)}|${dens.toFixed(3)}`;
    const st = eng._tables || (eng._tables = { key: '', cube: '', gen: 0, timer: 0 });
    if (st.key === key) return;
    const reset = st.cube !== spec.cube.key;        // a different sigil or dream: clear old cells
    st.key = key; st.cube = spec.cube.key;
    const gen = ++st.gen;
    clearTimeout(st.timer);
    const s32 = spectra(spec.cube);
    const send = (cells, rst) => {
      if (!cells.length) return;
      const data = new Float32Array(cells.length * D.CELL);
      cells.forEach((c, i) => D.buildCell(s32, c, tilt, dens, data, i * D.CELL));
      eng.post({ type: 'tables', reset: !!rst, cells: Int16Array.from(cells), data }, [data.buffer]);
    };
    const first = reachable(Ps, waveOffset());
    send(first, reset);
    const rest = [];
    for (let c = 0; c < D.NCELL; c++) if (!first.includes(c)) rest.push(c);
    const step = () => {
      if (gen !== st.gen) return;
      send(rest.splice(0, 16), false);
      if (rest.length) st.timer = setTimeout(step, 24);
    };
    st.timer = setTimeout(step, 60);
  }

  /* ── Reverb from the sigil's strokes ───────────────────────────────── */
  function reverbSpec(sigil, spec) {
    if (!sigil || !spec || !spec.verb) return { rt60: 2.6, damp: 0.55, taps: null };
    const r = SD.irSpec(sigil, spec.variant), taps = new Float64Array(r.taps.length * 3);
    r.taps.forEach((t, i) => { taps[i * 3] = t.t; taps[i * 3 + 1] = t.gain; taps[i * 3 + 2] = t.pan; });
    return { rt60: r.seconds * 0.6, damp: r.damp, taps };
  }
  function sendReverb(eng, sigil = hasApp() ? app.sigil : null) {
    const rv = reverbSpec(sigil, sigil ? soundSpec(sigil, eng.song) : null);
    eng.post({ type: 'reverb', rt60: rv.rt60, damp: rv.damp, taps: rv.taps }, rv.taps ? [rv.taps.buffer] : []);
  }

  /* ── Engine operations ──────────────────────────────────────────────── */
  function sendSong(eng, song, sigil) {
    const p = compile(song, sigil);
    eng.post({ type: 'plan', events: p.events, count: p.count, sections: p.sections, nSec: p.nSec,
      total: p.total, bpm: 60 / eng.spb, passes: 0, keep: false }, [p.events.buffer, p.sections.buffer]);
    eng.setParams({ waveOff: waveOffset() });
    sendTables(eng, p.spec, p.Ps);
    sendReverb(eng, sigil);
    return p;
  }
  /** Recompile and swap the events at the current playhead. Sounding voices ring on. */
  function replan(eng) {
    if (!eng || !eng.song || !hasApp() || !app.sigil) return;
    const p = compile(eng.song, app.sigil);
    eng.post({ type: 'plan', events: p.events, count: p.count, sections: p.sections, nSec: p.nSec,
      total: p.total, keep: true }, [p.events.buffer, p.sections.buffer]);
    sendTables(eng, p.spec, p.Ps);
  }
  /** Section patch only: what knob drags call. Cheap enough for every pointermove. */
  function refreshSections(eng) {
    if (!eng || !eng.song || !hasApp() || !app.sigil) return;
    const p = compile(eng.song, app.sigil, { events: false });
    eng.post({ type: 'sections', sections: p.sections, nSec: p.nSec }, [p.sections.buffer]);
    sendTables(eng, p.spec, p.Ps);
  }

  /* ── Rows for live notes and one-shots ─────────────────────────────── */
  /** Build one event row from named fields: {kind, bus, f, f0, dur (beats), vel, pan, aux, p:[P0…P5], seed}. */
  function row(o) {
    const r = new Float64Array(STRIDE);
    r[EV.KIND] = KIND[o.kind] || 0; r[EV.BUS] = BUS[o.bus || 'fx'] ?? BUS.fx;
    r[EV.F] = o.f || 0; r[EV.F0] = o.f0 || 0; r[EV.DUR] = o.dur ?? 1; r[EV.VEL] = o.vel ?? 0.8;
    r[EV.PAN] = o.pan || 0; r[EV.AUX] = o.aux || 0;
    (o.p || []).forEach((x, i) => { if (i < 6) r[EV.P0 + i] = x; });
    r[EV.SEED] = o.seed || ((Math.random() * 0x7fffffff) | 0) || 1;
    return r;
  }
  function liveNote(midi, deg, vel, timbre) {
    return row({ kind: 'LEAD', bus: 'fx', f: mtof(midi), dur: 0, vel, aux: deg, p: [TIMBRE[timbre] ?? 0, -1, CONS.nasal, 1] });
  }

  /* ── Offline jobs (m7 Render, m14 Stems/Evolve, tests/dsp-bench) ───── */
  function currentLevels(song) {
    if (hasApp() && app.engine && app.engine.song === song && app.engine.levels) return Object.assign({}, app.engine.levels);
    const out = {};
    D.BUS_NAMES.forEach((b, i) => { out[b] = D.BUS_DEFAULT[i] * num(song.levels && song.levels[b], 1); });
    return out;
  }
  /** Everything a worker needs to render: plain data only, structured-clone friendly. */
  function renderJob(song, sigil, o) {
    const p = compile(song, sigil, { lens: !!o.lens, spec: o.spec, drums: o.drums });
    const eng = hasApp() ? app.engine : null;
    return {
      sr: o.sr, bpm: 60 / o.spb, passes: Math.max(1, o.passes | 0), voices: 80,
      events: p.events, count: p.count, sections: p.sections, nSec: p.nSec, total: p.total,
      spectra: spectra(p.spec.cube), tilt: num(p.spec.P.tilt, 0), density: num(p.spec.P.density, 1),
      reverb: reverbSpec(sigil, p.spec), levels: o.levels || currentLevels(song),
      params: { reverb: eng && eng.params ? eng.params.reverb : 0.85, waveOff: waveOffset() },
    };
  }

  return {
    compile, sendSong, replan, refreshSections, sendTables, sendReverb,
    soundSpec, defaultSpec, waveOffset, row, liveNote, renderJob, spectra,
    KIND, BUS,
  };
})();