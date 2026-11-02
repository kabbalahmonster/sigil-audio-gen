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

   MOTION. The movers (05d) are compiled into the core's lane table here, and
   the SAME table goes to the live worklet (sendSong) and into every offline
   job (renderJob), full mix or stem. That is what makes a render move exactly
   as the performance did: there is only one table, and only one reader of it.

   MASTERING. A job also says how its song asks to be finished (job.mix: the
   letters' character for the chain, the kit level the patch asks for on
   purpose, anything the mood overrides), which is what 05e needs, besides the
   sound itself, to work out a master plan. The plan (job.master) is laid on
   by whoever renders; and every time the engine is sent something that changes
   what will be heard, 'compiled' is emitted so the plan can be worked out anew.
   ══════════════════════════════════════════════════════════════════════════ */
const SigilPlan = (() => {
  'use strict';
  const D = SigilDSP, SD = SoundDesign;
  const { EV, STRIDE, KIND, BUS, PA, PSTRIDE, AU, ASTRIDE } = D;

  const DEFAULTS = { tilt: 0, density: 1, kSub: 1, kPunch: 1, kDecay: 1, kTone: 0, sBody: 1, sSnap: 1, sTone: 1, hTone: 1, hDecay: 1,
    motion: 1, evolve: 0.5, mVar: 0, mMute: 0, finish: 0, fAmt: 1 };
  /** Mover (patch field) → the section column it moves. Only columns the core reads can be moved. */
  const LANE_COL = { wave: 'WAVE', layer: 'LAYER', sweep: 'SWEEP', drift: 'DRIFT', chorus: 'CHORUS', bright: 'BRIGHT',
    breath: 'BREATH', echo: 'ECHO', grit: 'GRIT', throat: 'THROAT', sub: 'SUB', drums: 'DRUMS', dRoom: 'DROOM', dBody: 'DBODY',
    dPunch: 'DPUNCH', dDrive: 'DDRIVE', dSmash: 'DSMASH', dEcho: 'DECHO', dFilter: 'DFILTER' };
  /** A row that is played only on some passes (05i's turnaround): the flag rides in the KIND's high bits (the core masks it off). */
  const WHEN = { wrap: 256, after: 512, end: 1024 };
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
    // The sigil's own patch, dressed by the song: a style's signature, a mood's values, an element's lean (SD.shape).
    let P = SD.shape({ ...DEFAULTS, ...SD.derive(sigil.hash, 0), ...SD.drumFx(sigil.hash, 0) }, song && song.cfg);
    if (typeof Palette !== 'undefined') P = Palette.dress(P, Palette.finish(sigil, song && song.cfg, P), SD.FIELDS);   // the world's own colour (M11 does the same for the stage)
    return { P, cube: SD.tables(sigil, 0),
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
      // (a style may ask for more or less of the pump: cfg.duck)
      out[o + PA.DUCK] = DS.sidechain ? clamp(num(DS.duck, 0.5) * (DS.sectionAware ? (SECTION_DUCK[si] ?? 1) : 1) * num(song.cfg && song.cfg.duck, 1), 0, 1.5) : 0;
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
  /** How long, in seconds, a note of a melodic part takes to die once it is let go (−60 dB): a bell that is a lead does not ring for twenty. */
  const DAMP = { lead: 1.1, alt: 1.1, harm: 1.4, arp: 0.5, comp: 1.0 };
  /** The note an instrument plays in a part, for a note the song writes: shifted by the instrument's own octave, and into its range. */
  function tuneFor(d, role, midi) {
    let m = midi + 12 * (d.oct[role] || 0);
    if (d.range) { while (m < d.range[0]) m += 12; while (m > d.range[1]) m -= 12; }
    return m;
  }
  function compileEvents(song, sigil, spec, Ps, lens, DS, pal) {
    const src = song.events, N = src.length;
    let out = new Float64Array((N * 2 + 8) * STRIDE);
    const red = sigil.reduced, RL = red.length;
    /* Velocity → timbre. Only for songs that carry a groove (05c): a hard hit opens up and rings
       longer, a ghost is shorter, darker and more skin than wire. `hard` is the stroke relative
       to that drum's normal one (1 = normal); with dyn at 0 it is exactly 1 and nothing moves. */
    const dyn = song.cfg && song.cfg.groove ? clamp(num(DS.dynamics, 0.6), 0, 1) : 0;
    const hard = (vel, ref) => (dyn > 0 ? 1 + dyn * (clamp(num(vel, ref) / ref, 0.15, 1.35) - 1) : 1);
    const vowels = spec.vowels && spec.vowels.length ? spec.vowels : null;
    const starts = song.sections.map((s) => s.start);
    let si = 0, n = 0, flag = 0;
    const put = (ev, kind, bus, f) => {
      if ((n + 1) * STRIDE > out.length) { const g = new Float64Array(Math.ceil(out.length * 1.5 / STRIDE) * STRIDE); g.set(out); out = g; }   // a pad of five notes is five rows
      const o = n++ * STRIDE;
      out[o] = ev.beat; out[o + EV.KIND] = kind + flag; out[o + EV.BUS] = bus; out[o + EV.F] = f;
      out[o + EV.VEL] = ev.vel ?? 0.8; out[o + EV.DUR] = ev.dur || 0.25; out[o + EV.SEED] = seedOf(ev);
      return o;
    };
    /* THE PALETTE (05j). A part that has been dealt an instrument of the new engines is written as that instrument's
       rows: P0 its slot in the core's table, P1 how hard (0…1), P2 a variation, a function of where the note falls,
       so the same note struck twice is two different strokes. A part dealt the cube's own voice is compiled as it ever was. */
    const inst = pal ? (role) => { const d = pal.roles[role]; return d && d.engine !== 'cube' ? d : null; } : () => null;
    const tune = tuneFor;
    const stroke = (ev, d, role, bus, midi, k = 1) => {
      const o = put(ev, Palette.KIND_OF[d.engine], bus, mtof(tune(d, role, midi)));
      const h = (Math.imul(seedOf(ev), 0x9e3779b1) >>> 8) & 0xffff, b = ev.beat || 0, v = ev.vel ?? 0.8;
      out[o + EV.VEL] = v * k;
      out[o + EV.P0] = Palette.SLOT[role];
      out[o + EV.P1] = clamp(0.85 * v + (b % 4 === 0 ? 0.15 : b % 1 === 0 ? 0.07 : 0), 0, 1);
      out[o + EV.P2] = h / 65536;
      out[o + EV.P3] = DAMP[role] || 0;
      return o;
    };

    /** A note of a part the palette has taken: written as the instrument's rows. Returns false for a part that stays the cube's. */
    const viaPalette = (ev) => {
      let d;
      switch (ev.type) {
        case 'lead': {
          const role = ev.part ? 'alt' : 'lead';
          if (!(d = inst(role))) return false;
          const o = stroke(ev, d, role, BUS.lead, ev.midi);
          out[o + EV.F0] = ev.from != null ? mtof(tune(d, role, ev.from)) : 0;
          out[o + EV.PAN] = ev.part === 1 ? -0.3 : ev.part === 2 ? 0.3 : 0;
          return true;
        }
        case 'harm': {
          if (!(d = inst('harm'))) return false;
          const o = stroke(ev, d, 'harm', BUS.harm, ev.midi);
          out[o + EV.PAN] = ev.part === 1 ? -0.3 : ev.part === 2 ? 0.3 : 0;
          return true;
        }
        case 'bell': if (!(d = inst('bell'))) return false; stroke(ev, d, 'bell', BUS.bell, ev.midi); return true;
        case 'bass': {
          if (!(d = inst('bass'))) return false;
          const o = stroke(ev, d, 'bass', BUS.bass, ev.midi);
          if (ev.from != null) out[o + EV.F0] = mtof(tune(d, 'bass', ev.from));
          return true;
        }
        case 'comp': {
          if (!(d = inst('comp'))) return false;
          const o = stroke(ev, d, 'comp', BUS[ev.bus] ?? BUS.arp, ev.midi, ev.voice === 'bell' ? 0.85 : 1);
          out[o + EV.PAN] = ev.pan || 0;
          return true;
        }
        case 'arp': {
          if (!(d = inst('arp'))) return false;
          const o = stroke(ev, d, 'arp', BUS.arp, ev.midi);
          out[o + EV.PAN] = ev.pan || 0;
          return true;
        }
        case 'pad': {
          if (!(d = inst('pad'))) return false;
          /* a chord is one row a note, each a part of the sum: as loud, together, as the cube's pad is */
          const ms = ev.midis.slice(0, d.engine === 'cloud' ? 3 : 5), k = 1.15 / Math.sqrt(ms.length);
          ms.forEach((m, j) => { const o = stroke(ev, d, 'pad', BUS.pad, m, k); out[o + EV.PAN] = (j % 2 ? 1 : -1) * Math.min(0.4, 0.12 * j); });
          return true;
        }
        case 'drone': {
          if (!(d = inst('drone'))) return false;
          stroke(ev, d, 'drone', BUS.drone, ev.midi, 0.8);
          const o = stroke(ev, d, 'drone', BUS.drone, ev.midi + 7, 0.45);       // and the fifth over it, as the cube's drone has
          out[o + EV.PAN] = 0.15;
          return true;
        }
        case 'tom': {
          if (!(d = inst('tom'))) return false;
          const root = rootAt(song, ev.beat, DS), idx = clamp(ev.tom | 0, 0, 2);
          const o = stroke(ev, d, 'tom', BUS.drums, fold(root + 12, 41, 52) + (idx === 2 ? 12 : idx === 1 ? 7 : 0));
          out[o + EV.PAN] = ev.pan ?? TOM_PAN[idx];
          return true;
        }
        case 'perc': {
          // the hand-drums and tuned percussion the fills play (05k): the tom's three pitches, an octave and a half higher
          const root = rootAt(song, ev.beat, DS), idx = clamp(ev.pi | 0, 0, 2);
          const m = fold(root + 24, 52, 64) + (idx === 2 ? 12 : idx === 1 ? 7 : 0), pan = ev.pan ?? TOM_PAN[idx] * 1.2;
          if (!(d = inst('perc'))) return false;            // the cube's kit plays it as a high tom (below)
          const o = stroke(ev, d, 'perc', BUS.drums, m);
          out[o + EV.PAN] = pan;
          return true;
        }
        case 'rim': {
          if (!(d = inst('rim'))) return false;
          const root = rootAt(song, ev.beat, DS);
          const o = stroke(ev, d, 'rim', BUS.drums, fold(root + 36, 67, 79));
          out[o + EV.PAN] = ev.pan || 0;
          return true;
        }
        case 'shaker': {
          if (!(d = inst('shaker'))) return false;
          const o = stroke(ev, d, 'shaker', BUS.drums, 96);
          out[o + EV.PAN] = ev.pan || 0;
          return true;
        }
      }
      return false;
    };

    for (let i = 0; i < N; i++) {
      const raw = src[i];
      while (si + 1 < starts.length && raw.beat >= starts[si + 1]) si++;
      const ev = lens ? LiveLens.map(raw, song) : raw;
      const P = Ps[si];
      flag = raw.when ? WHEN[raw.when] | 0 : 0;
      if (pal && viaPalette(ev)) continue;
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
          // A style's bass (05f) may slide in from the note before it, and say how dark and how deep it is.
          const o = put(ev, KIND.WAVE, BUS.bass, mtof(ev.midi));
          if (ev.from != null) out[o + EV.F0] = mtof(ev.from);
          out[o + EV.P0] = num(ev.tone, 0.18); out[o + EV.P1] = num(ev.sub, 0.3); out[o + EV.P2] = 0.4; out[o + EV.P3] = 0; out[o + EV.P4] = 0;
          break;
        }
        case 'comp': {
          /* A style's chords (05f): one row per note of each strum, stab or chug. 'bell' is struck and
             rings (keys, a nylon guitar); 'wave' is held for as long as it is written (a stab, a power chord). */
          const bell = ev.voice === 'bell', o = put(ev, bell ? KIND.BELL : KIND.WAVE, BUS[ev.bus] ?? BUS.arp, mtof(ev.midi));
          out[o + EV.PAN] = ev.pan || 0;
          if (bell) { out[o + EV.VEL] = (ev.vel ?? 0.6) * 0.7; out[o + EV.P5] = 0.22; }   // struck, and damped soon after
          else { out[o + EV.P0] = num(ev.bright, -1); out[o + EV.P1] = -1; out[o + EV.P2] = 0.24; out[o + EV.P3] = 0; out[o + EV.P4] = 0; }
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
        case 'kick': case 'snare': case 'hat': case 'shaker': case 'crash': case 'tom': case 'perc': case 'rim': case 'clap': case 'ride': {
          // The kit cell is the sigil's; a style may insist on the character of its kick, snare or hat (cfg.kit).
          const cell = SD.drumKit(sigil.hash, num(P.drumX, 0.5), num(P.drumY, 0.5));
          const kit = song.cfg && song.cfg.kit ? { ...cell, ...song.cfg.kit } : cell;
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
          } else if (ev.type === 'perc') {
            /* Percussion a fill plays (05k), in the cube's kit: a high tom on the chord's three pitches. */
            const idx = clamp(ev.pi | 0, 0, 2), h = hard(ev.vel, 0.75);
            const o = put(ev, KIND.TOM, BUS.drums, mtof(fold(root + 12, 50, 58) + (idx === 2 ? 12 : idx === 1 ? 7 : 0)));
            out[o + EV.PAN] = ev.pan ?? TOM_PAN[idx] * 1.2;
            out[o + EV.P0] = 0.3 * (0.6 + 0.4 * h); out[o + EV.P1] = 0.04;
            out[o + EV.P2] = (0.07 + 0.06 * kit.kickDecay) * (0.8 + 0.2 * h) * num(P.kDecay, 1);
            out[o + EV.P3] = 0.3 * num(P.kPunch, 1) * tone[2] * h;
            out[o + EV.P4] = (2400 + 1500 * num(P.drumY, 0.5)) * tone[0]; out[o + EV.P5] = 0.3;
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
          } else if (ev.type === 'clap') {
            /* A clap is several hands: three short bursts of band-passed noise a hundredth of a second
               apart, and a last one that is let ring. (The snare voice, with no body and no wire.) */
            const gap = (0.011 * song.bpm) / 60;
            for (let j = 0; j < 4; j++) {
              const o = put({ ...ev, beat: ev.beat + j * gap, midi: j }, KIND.SNARE, BUS.drums, 200);
              out[o + EV.VEL] = (ev.vel ?? 0.7) * (j === 3 ? 1 : 0.7);
              out[o + EV.F0] = 0.62 * tone[2]; out[o + EV.P0] = 0; out[o + EV.P1] = j === 3 ? 0.085 * num(P.sSnap, 1) : 0.008;
              out[o + EV.P2] = 0.08; out[o + EV.P3] = (1050 + 450 * num(P.sTone, 1)) * tone[0]; out[o + EV.P4] = 0.01; out[o + EV.P5] = 0;
              out[o + EV.AUX] = 5200;
            }
          } else if (ev.type === 'ride') {
            /* A ride: the hat's metal, lower and left to ring. */
            const o = put(ev, KIND.HAT, BUS.drums, (DS.tuneToKey ? mtof(root + 31) : 340) * tone[0]);
            out[o + EV.PAN] = ev.pan || 0;
            out[o + EV.P0] = Math.min(0.3, (0.1 + 0.08 * kit.hatDecay) * hDecay); out[o + EV.P1] = 5000 + 1500 * hTone; out[o + EV.P2] = 7400 + 2400 * hTone;
            out[o + EV.P3] = 0.085 * tone[2]; out[o + EV.P4] = 1; out[o + EV.P5] = 6;
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
    /* The core finds its place in the table by bisection and walks it forwards: it must be in order. A clap is four rows a hundredth of a beat apart,
       a swung or grace-noted stroke can come before the one that was written before it; a row out of place is a row that is never played. */
    let ordered = true;
    for (let i = 1; i < n; i++) if (out[i * STRIDE] < out[(i - 1) * STRIDE]) { ordered = false; break; }
    if (!ordered) {
      const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => out[a * STRIDE] - out[b * STRIDE] || a - b), g = new Float64Array(n * STRIDE);
      idx.forEach((from, to) => g.set(out.subarray(from * STRIDE, from * STRIDE + STRIDE), to * STRIDE));
      return { events: g, count: n };
    }
    return { events: out.slice(0, n * STRIDE), count: n };
  }

  /* ── Motion ─────────────────────────────────────────────────────────── */
  /**
   * The movers as the core wants them: { key, n, step, len, lanes (Float64Array, ASTRIDE each),
   * curves, meta }. The curves are 05d's, shared and cached per song; the packed lanes ride on
   * that cache. A mover at rest (held still, or a kit mover while the kit's FX are bypassed) is
   * packed with no depth and no drift, so it adds exactly nothing.
   */
  function motionTable(song, sigil, spec, DS) {
    if (typeof Motion === 'undefined' || !song.cfg) return null;
    const P = spec.P, t = Motion.bake(song, sigil, { variant: num(P.mVar, 0), mute: num(P.mMute, 0), kit: DS.fx !== false });
    if (!t.packed) {
      const L = new Float64Array(t.n * ASTRIDE);
      t.lanes.forEach((ln, j) => {
        const o = j * ASTRIDE;
        L[o + AU.COL] = PA[LANE_COL[ln.name]]; L[o + AU.LO] = ln.lo; L[o + AU.HI] = ln.hi;
        L[o + AU.DEPTH] = ln.resting ? 0 : ln.depth; L[o + AU.SHIFT] = ln.resting ? 0 : ln.shift * ln.depth;
        L[o + AU.GAIN] = ln.gain; L[o + AU.MORPH] = ln.morph;
        L[o + AU.LATENT] = ln.latent ? 1 : 0; L[o + AU.GATE] = ln.gate ? 1 : 0; L[o + AU.SEED] = ln.seed;
      });
      t.packed = L;
    }
    return { key: t.key, n: t.n, step: t.step, len: t.len, lanes: t.packed, curves: t.curves, meta: t.lanes };
  }
  /** What is sent: the numbers only. (Not transferred: the page keeps reading the same arrays.) */
  const autoMsg = (a) => (a ? { n: a.n, step: a.step, len: a.len, lanes: a.lanes, curves: a.curves } : null);

  /**
   * The body the passes go round (05i Flow): { lo, hi } in beats, or null (every pass the whole rite). Only where asked for:
   * `flow` true, or, by default, where the listener has it on and the module is here (tests and the bench are not).
   */
  const loopOf = (song, flow) => ((flow ?? (typeof Flow !== 'undefined' && Flow.enabled())) && typeof Flow !== 'undefined' ? Flow.loop(song) : null);

  /**
   * Who plays the song (05j): the palette this sigil, this song and this patch resolve to, or null for the cube's own voices.
   * On wherever the module is here, unless asked not to (opts.palette false: tests that pin the cube's rows, a patch that says
   * "the original voices"). The patch's own `palOff` is the listener's word, kept with the sound.
   */
  function paletteOf(song, sigil, spec, on) {
    // (and only where the engines are: a host that has the palette but not sigil-voices.js would be given parts that make no sound)
    if (typeof Palette === 'undefined' || typeof SigilVoices === 'undefined' || on === false || !sigil || !spec) return null;
    return Palette.resolve(sigil, song && song.cfg, spec.P);
  }
  /** The hall a song and its palette ask for together: the element's size and damping, and the world's on top. */
  function hallWith(song, pal) {
    const h = hallOf(song), w = pal && !pal.classic ? pal.hall : null;
    if (!w) return h;
    return { size: num(h && h.size, 1) * num(w.size, 1), damp: num(h && h.damp, 0) + num(w.damp, 0) };
  }
  const spaceWith = (song, pal) => clamp(spaceOf(song) * (pal && !pal.classic ? num(pal.space, 1) : 1), 0, 3);

  /** Compile a song. opts: { spec, lens, events:false (sections only), drums (settings override), flow (the passes go round the body), palette (false: the cube's voices only) } */
  function compile(song, sigil, opts = {}) {
    const spec = opts.spec || soundSpec(sigil, song);
    const Ps = patches(song, spec), DS = drumSettings(opts.drums), pal = paletteOf(song, sigil, spec, opts.palette);
    const loop = loopOf(song, opts.flow);
    // a pass that is followed by another turns: a fill into the body's start (05i). Played from a copy of the score.
    const score = loop && opts.turn !== false && typeof Flow !== 'undefined' && Flow.turnSong ? Flow.turnSong(song, sigil, loop) : song;
    const p = { spec, Ps, sections: sectionsTable(song, sigil, spec, Ps, DS), nSec: Ps.length, total: song.total,
      auto: motionTable(song, sigil, spec, DS),
      motion: clamp(num(spec.P.motion, 1), 0, 2), evolve: clamp(num(spec.P.evolve, 0.5), 0, 1), loop,
      pal, inst: pal && !pal.classic ? pal.table : null };
    if (opts.events !== false) {
      const lens = opts.lens ?? (typeof LiveLens !== 'undefined' && LiveLens.active());
      Object.assign(p, compileEvents(score, sigil, spec, Ps, lens, DS, pal && !pal.classic ? pal : null));
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
  /** `hall` (a song's cfg.hall, from its element): { size: × the decay, damp: + the damping }. */
  function reverbSpec(sigil, spec, hall) {
    const size = clamp(num(hall && hall.size, 1), 0.3, 2.5), dd = num(hall && hall.damp, 0);
    if (!sigil || !spec || !spec.verb) return { rt60: 2.6 * size, damp: clamp(0.55 + dd, 0.05, 0.95), taps: null };
    const r = SD.irSpec(sigil, spec.variant), taps = new Float64Array(r.taps.length * 3);
    r.taps.forEach((t, i) => { taps[i * 3] = t.t; taps[i * 3 + 1] = t.gain; taps[i * 3 + 2] = t.pan; });
    return { rt60: r.seconds * 0.6 * size, damp: clamp(r.damp + dd, 0.05, 0.95), taps };
  }
  const hallOf = (song) => (song && song.cfg && song.cfg.hall) || null;
  /** How much of the hall a song asks for, against the usual (a style's or an element's cfg.space). */
  const spaceOf = (song) => clamp(num(song && song.cfg && song.cfg.space, 1), 0, 3);
  function sendReverb(eng, sigil = hasApp() ? app.sigil : null) {
    const spec = sigil ? soundSpec(sigil, eng.song) : null, pal = paletteOf(eng.song, sigil, spec);
    const rv = reverbSpec(sigil, spec, hallWith(eng.song, pal));
    const space = spaceWith(eng.song, pal);
    if (eng.space !== space) { eng.space = space; if (eng.revReturn) eng.revReturn.gain.value = eng.revReturn.gain.value; }   // the world's room, in the listener's Space
    eng.post({ type: 'reverb', rt60: rv.rt60, damp: rv.damp, taps: rv.taps }, rv.taps ? [rv.taps.buffer] : []);
  }

  /* ── Engine operations ──────────────────────────────────────────────── */
  /**
   * Keep the page's copy of what the core was sent (the interface draws from it), and say whether
   * the lane table is new. The amounts are cheap and always sent; the table only when it changed.
   */
  function motionSync(eng, p) {
    const fresh = (p.auto ? p.auto.key : '') !== (eng.auto ? eng.auto.key : '');
    eng.auto = p.auto;
    eng.sections = p.sections.slice();                // the transfer below detaches p.sections
    if (eng.params.motion !== p.motion || eng.params.evolve !== p.evolve) eng.setParams({ motion: p.motion, evolve: p.evolve });
    if (fresh) Hooks.emit('motion', eng);
    return fresh;
  }
  function sendSong(eng, song, sigil) {
    const p = compile(song, sigil);
    eng.auto = null;                                  // a new song: its table is always sent
    eng.pal = p.pal && !p.pal.classic ? p.pal : null;   // who plays it (05j): for the notes played by hand
    motionSync(eng, p);
    eng.post({ type: 'plan', events: p.events, count: p.count, sections: p.sections, nSec: p.nSec,
      total: p.total, bpm: 60 / eng.spb, passes: 0, keep: false, auto: autoMsg(p.auto), loop: p.loop, inst: p.inst }, [p.events.buffer, p.sections.buffer]);
    eng.setParams({ waveOff: waveOffset(), motion: p.motion, evolve: p.evolve });
    sendTables(eng, p.spec, p.Ps);
    sendReverb(eng, sigil);
    Hooks.emit('compiled', eng, 'song');              // a new song is in the engine: its master plan is wanted
    return p;
  }
  /** Recompile and swap the events at the current playhead. Sounding voices ring on. */
  function replan(eng) {
    if (!eng || !eng.song || !hasApp() || !app.sigil) return;
    const p = compile(eng.song, app.sigil), msg = { type: 'plan', events: p.events, count: p.count, sections: p.sections,
      nSec: p.nSec, total: p.total, keep: true, loop: p.loop, inst: p.inst };
    eng.pal = p.pal && !p.pal.classic ? p.pal : null;
    if (motionSync(eng, p)) msg.auto = autoMsg(p.auto);
    eng.post(msg, [p.events.buffer, p.sections.buffer]);
    sendTables(eng, p.spec, p.Ps);
    Hooks.emit('compiled', eng, 'plan');
  }
  /** Section patch only: what knob drags call. Cheap enough for every pointermove. */
  function refreshSections(eng) {
    if (!eng || !eng.song || !hasApp() || !app.sigil) return;
    const p = compile(eng.song, app.sigil, { events: false }), msg = { type: 'sections', sections: p.sections, nSec: p.nSec };
    if (motionSync(eng, p)) msg.auto = autoMsg(p.auto);
    eng.post(msg, [p.sections.buffer]);
    sendTables(eng, p.spec, p.Ps);
    Hooks.emit('compiled', eng, 'sections');
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
  /** A note of a part as the palette's instrument plays it, as one row. */
  function palRow(d, role, bus, midi, vel, o = {}) {
    const r = new Float64Array(STRIDE);
    r[EV.KIND] = Palette.KIND_OF[d.engine]; r[EV.BUS] = BUS[bus] ?? BUS.fx;
    r[EV.F] = mtof(tuneFor(d, role, midi)); r[EV.DUR] = o.dur ?? 0; r[EV.VEL] = vel; r[EV.PAN] = o.pan || 0;
    r[EV.P0] = Palette.SLOT[role]; r[EV.P1] = o.accent ?? clamp(0.85 * vel, 0, 1); r[EV.P2] = o.vary ?? 0.37; r[EV.P3] = DAMP[role] || 0;
    r[EV.SEED] = o.seed || ((Math.random() * 0x7fffffff) | 0) || 1;
    return r;
  }
  /** A played note (the keys, a click on a letter): the lead's instrument, when the palette has dealt one. */
  function liveNote(midi, deg, vel, timbre, pal) {
    const d = pal && pal.roles && pal.roles.lead;
    if (d && d.engine !== 'cube') return palRow(d, 'lead', 'fx', midi, vel);
    return row({ kind: 'LEAD', bus: 'fx', f: mtof(midi), dur: 0, vel, aux: deg, p: [TIMBRE[timbre] ?? 0, -1, CONS.nasal, 1] });
  }

  /**
   * What a part sounds like, for a chooser: a short phrase in the song's own key, as rows with their times. `pal` names who
   * plays it (Palette.resolve); the parts a palette has left to the cube are played in the cube's own voices.
   * @returns {{ at: number, row: Float64Array }[]} `at` in beats from now
   */
  function auditionRows(role, song, pal) {
    const d = pal && pal.roles && pal.roles[role], inst = d && d.engine !== 'cube' ? d : null;
    const lb = song.leadBase, sc = song.scale, root = song.bassBase;
    const deg = (k, base = lb) => degToMidi(k, base, sc);
    const out = [], add = (at, bus, m, vel, dur, o) => {
      if (inst) out.push({ at, row: palRow(inst, role, bus, m, vel, { dur, ...(o || {}) }) });
      else out.push({ at, row: cubeRow(role, bus, m, vel, dur, o) });
    };
    switch (role) {
      case 'lead': case 'alt': case 'harm': [0, 2, 4, 2, 1].forEach((k, i) => add(i * 0.75, role === 'harm' ? 'harm' : 'lead', deg(k), 0.8, 0.7)); break;
      case 'bell': [4, 2, 0].forEach((k, i) => add(i * 1.2, 'bell', deg(k) + 12, 0.8, 1.1)); break;
      case 'bass': [0, 0, 4, 0].forEach((k, i) => add(i * 0.75, 'bass', root + (k ? 7 : 0), 0.85, 0.7)); break;
      case 'arp': [0, 2, 4, 7, 4, 2, 0, 2].forEach((k, i) => add(i * 0.25, 'arp', deg(k), 0.7, 0.22)); break;
      case 'pad': [0, 2, 4].forEach((k, j) => add(0, 'pad', deg(k, lb - 12), 0.7, 5)); break;
      case 'drone': add(0, 'drone', root + 12, 0.8, 6); add(0, 'drone', root + 19, 0.5, 6); break;
      case 'comp': [0, 2, 4].forEach((k, j) => add(j * 0.06, 'arp', deg(k), 0.65, 1.4)); add(1.5, 'arp', deg(1), 0.5, 0.5); break;
      case 'tom': [2, 1, 0].forEach((k, i) => add(i * 0.5, 'drums', 52 + (k === 2 ? 12 : k === 1 ? 7 : 0), 0.8, 0.4, { pan: TOM_PAN[k] })); break;
      case 'perc': [0, 1, 2, 1, 0].forEach((k, i) => add(i * 0.4, 'drums', 64 + (k === 2 ? 12 : k === 1 ? 7 : 0), 0.75, 0.4)); break;
      case 'rim': [0, 1, 2].forEach((k, i) => add(i * 0.5, 'drums', 72, 0.65, 0.2)); break;
      case 'shaker': for (let i = 0; i < 8; i++) add(i * 0.25, 'drums', 96, i % 2 ? 0.4 : 0.62, 0.15); break;
    }
    return out;
  }
  /** The cube's own voice for a part, as one row (what a part dealt the cube sounds like). */
  function cubeRow(role, bus, midi, vel, dur, o) {
    const f = mtof(midi), pan = (o && o.pan) || 0;
    switch (role) {
      case 'bass': return row({ kind: 'WAVE', bus, f, dur, vel, p: [0.18, 0.3, 0.4, 0, 0] });
      case 'bell': return row({ kind: 'BELL', bus, f, dur, vel });
      case 'pad': return row({ kind: 'PAD', bus, f, dur, vel: vel * 0.7 });
      case 'drone': return row({ kind: 'DRONE', bus, f, dur, vel });
      case 'arp': case 'comp': return row({ kind: 'WAVE', bus, f, dur, vel, p: [-1, -1, 0.26, 0, 0] });
      case 'tom': case 'perc': return row({ kind: 'TOM', bus, f: f / 2, dur, vel, pan, p: [0.4, 0.06, 0.1, 0.3, 2400, 0.3] });
      case 'rim': return row({ kind: 'SNARE', bus, f: 900, dur, vel, p: [0.22, 0.018, 0.3, 2400, 0.014, 1], aux: 5200 });
      case 'shaker': return row({ kind: 'NOISE', bus, vel: vel * 0.12, dur, p: [1, 6500, 6500, 1.2, 0.014, 0.024] });
      default: return row({ kind: 'LEAD', bus, f, dur, vel, p: [0, -1, CONS.nasal, 1] });
    }
  }

  /* ── Offline jobs (m7 Render & Export, tests/dsp-bench) ───── */
  function currentLevels(song) {
    if (hasApp() && app.engine && app.engine.song === song && app.engine.levels) return Object.assign({}, app.engine.levels);
    const out = {};
    D.BUS_NAMES.forEach((b, i) => { out[b] = D.BUS_DEFAULT[i] * num(song.levels && song.levels[b], 1); });
    return out;
  }
  /**
   * How a song asks to be finished (05e): the letters' character for the master chain and how
   * strongly it is applied (both in the patch), the kit level the patch asks for ON PURPOSE (its
   * Level against the sigil's own dealt one: a levelling that undid the knob would be no use),
   * and anything the mood overrides (cfg.master: { noise dB, level ×, tone × }).
   */
  function mixInfo(song, sigil, spec) {
    if (typeof Mastering === 'undefined') return null;
    const P = spec.P, own = SD.derive(sigil.hash, spec.variant || 0).drums || 1;
    return { finish: Mastering.character(sigil, num(P.finish, 0)), amount: clamp(num(P.fAmt, 1), 0, 1.5),
      kit: clamp(num(P.drums, own) / own, 0.25, 4), mood: (song.cfg && song.cfg.master) || null };
  }
  /**
   * Everything a worker needs to render: plain data only, structured-clone friendly.
   * o: { sr, spb, passes, lens, spec, drums, levels, pass0, flow, master (a plan's table, Mastering.table),
   *      holdK (the crushers' hold, in samples, is for 44.1 kHz: a render at another rate is given rate/44100, so a
   *      hold lasts as long in time) }
   */
  function renderJob(song, sigil, o) {
    const p = compile(song, sigil, { lens: !!o.lens, spec: o.spec, drums: o.drums, flow: o.flow, palette: o.palette });
    const eng = hasApp() ? app.engine : null;
    return {
      sr: o.sr, bpm: 60 / o.spb, passes: Math.max(1, o.passes | 0), voices: 80,
      events: p.events, count: p.count, sections: p.sections, nSec: p.nSec, total: p.total, loop: p.loop,
      spectra: spectra(p.spec.cube), tilt: num(p.spec.P.tilt, 0), density: num(p.spec.P.density, 1),
      reverb: reverbSpec(sigil, p.spec, hallWith(song, p.pal)), inst: p.inst, levels: o.levels || currentLevels(song),
      // The live engine's own lane table and amounts: a render, whole or stem, moves as the stage does.
      // pass0 starts the evolution further on (a render begins at pass 0, the rite as written).
      auto: autoMsg(p.auto),
      params: { reverb: eng && eng.params && eng.song === song ? eng.params.reverb : 0.85 * spaceWith(song, p.pal), waveOff: waveOffset(),
        motion: p.motion, evolve: p.evolve, pass0: Math.max(0, o.pass0 | 0),
        holdK: o.holdK > 0 ? o.holdK : 1 },
      // How the song asks to be finished, and (if the caller has one) the plan that finishes it.
      mix: mixInfo(song, sigil, p.spec), master: o.master || null,
    };
  }

  return {
    compile, sendSong, replan, refreshSections, sendTables, sendReverb,
    soundSpec, defaultSpec, waveOffset, row, liveNote, auditionRows, renderJob, spectra, mixInfo, paletteOf, hallWith,
    spaceOf: (song, sigil) => (sigil ? spaceWith(song, paletteOf(song, sigil, soundSpec(sigil, song))) : spaceOf(song)),
    KIND, BUS, LANE_COL,
  };
})();