'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m15 · DRUM ENGINE v4 · how the kit plays
   --------------------------------------------------------------------------
   WHERE THINGS LIVE
     the part     src/core/05c-groove.js   what is struck, and how hard (pure)
     the strokes  src/core/06b-compiler.js what each stroke sounds like
     the sound    src/dsp/sigil-dsp.js     the voices, and the kit's FX chain (§5b)
     the knobs    m12 (Sound & Patch)      kit tone, and the chain's D· knobs
     THIS FILE    the settings and panel that decide how the kit PLAYS and how
                  it moves the music, and the wiring that keeps a playing song
                  in step with them.

   PATTERN    Sigil   the kit reads the sigil (05c): polygons turned with each
                      section, letters as accents, fills that speak the name.
              Classic the composer's own bars, exactly as before this module.
   GROOVE     each sigil has a hundred grooves; 0 is its own. The number is a
              patch field (`take`), so it is kept per sigil, travels in a shared
              link and is forgotten with the sigil.
   AMOUNTS    Variation, Fills, Ghosts, Humanise, Dynamics. These are this
              listener's taste and apply to every sigil (a mood may override
              them for itself through cfg.drums).
   FX         one switch that rests the kit's whole FX chain.
   MOVEMENT   ducking, sidechain, section-aware ducking, tune-to-chord and kick
              octave, as before.

   HOW A CHANGE REACHES THE EAR
     at composition   the 'score' filter writes the part into the new song
     while playing    sync() rewrites the part IN PLACE and re-plans; the engine
                      swaps events at the playhead, so nothing restarts

   LEGACY. The Web Audio voices below (kick, snare, hat…, the 'voice' hook and
   route()) belong to Engine v1. Engine v2 makes every sound in the DSP worklet
   and never calls them (nothing filters 'voice', and route() returns at once
   for a DSP engine). They are left here untouched.
   ══════════════════════════════════════════════════════════════════════════ */

const DrumEngine = (() => {
  'use strict';
  const { h } = UI;
  const SD = SoundDesign;
  const DRUMS = new Set(['kick', 'snare', 'hat', 'shaker', 'crash']);
  const HAT_R = [1, 1.4471, 1.6317, 1.9323, 2.5465, 2.7];
  const HAT_METAL = [1, 1.3, 1.63, 1.95, 2.47, 3.0];
  const METAL = [1, 1.4, 1.67, 2.1, 2.74];

  /** Section-aware sidechain: the rite's shape, as a duck multiplier. */
  const SECTION_DUCK = [0, 0.45, 1.0, 0.7, 0.9, 1.15, 0.35];

  const KSTYLE = [
    { glide: 1.7, glideT: 0.09, decay: 1.0, click: 0.5 },   // 808 glide
    { glide: 2.6, glideT: 0.03, decay: 0.5, click: 1.0 },   // tight
    { glide: 1.3, glideT: 0.06, decay: 1.4, click: 0.3 },   // boom
    { glide: 3.2, glideT: 0.02, decay: 0.65, click: 1.5 },  // punch
  ];
  const SSTYLE = [
    { body: 1.0, bodyDec: 0.035, noise: 1.0, snap: 0.9, rim: 0 },   // tight
    { body: 1.6, bodyDec: 0.075, noise: 0.8, snap: 0.6, rim: 0 },   // fat
    { body: 0.55, bodyDec: 0.02, noise: 0.6, snap: 1.2, rim: 1 },   // rim
    { body: 0.35, bodyDec: 0.02, noise: 1.35, snap: 1.1, rim: 0 },  // snap
  ];

  const S = {
    duck: 0.5, sidechain: true, sectionAware: true, tuneToKey: true, kickOct: 'auto',
    style: 'sigil', variation: 0.6, fills: 0.6, ghosts: 0.5, human: 0.4, dynamics: 0.6, fx: true,
    ...Prefs.get('drums', {}),
  };
  if (S.style !== 'classic') S.style = 'sigil';
  const save = () => Prefs.set('drums', S);

  /* ── Musical context ─────────────────────────────────────────────────── */

  /** The chord sounding at a beat. Phrases are sorted, so a binary search finds it. */
  function chordAt(song, beat) {
    const P = song.phrases;
    let lo = 0, hi = P.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (P[m].start <= beat) lo = m; else hi = m - 1;
    }
    const ph = P[lo];
    return ph.chords[clamp(Math.floor((beat - ph.start) / 4), 0, 3)];
  }

  /** MIDI of the chord root in the bass register, or the tonic when tuning is off. */
  function rootAt(song, beat) {
    if (!S.tuneToKey) return song.bassBase;
    return bassPitch(chordAt(song, beat), 'root', song.bassBase, song.scale);
  }

  function letterAt(beat) {
    const s = app.sigil;
    return s ? s.reduced[mod(Math.round(beat * 4), s.reduced.length)] : 'T';
  }

  /** Consonant colour for percussion: plosives are sharp, liquids are soft. */
  function toneFor(letter) {
    return SD.CLASS_TONE[SD.CONSONANT_CLASS[letter] || 'fricative'];
  }

  /* ── Routing ─────────────────────────────────────────────────────────── */

  function route(eng) {
    if (eng.isDSP) return;
    const ctx = eng.ctx, bus = eng.buses && eng.buses.drums;
    if (!bus) return;

    if (!eng.drumSum) {
      eng.drumSum = ctx.createGain();
      eng.drumSum.connect(eng.tone);
    }
    if (!eng.drumGlue) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -14; c.ratio.value = 4; c.knee.value = 6;
      c.attack.value = 0.003; c.release.value = 0.12;
      c.connect(eng.drumSum);
      eng.drumGlue = c;
    }

    // Kick input: a saturating shaper, rebuilt per load so it targets the live bus.
    if (eng.kickIn) eng.kickIn.disconnect();
    eng.kickIn = ctx.createGain();
    const ws = ctx.createWaveShaper();
    ws.curve = eng.satCurve;
    ws.oversample = '2x';
    eng.kickIn.connect(ws);
    ws.connect(bus);

    if (!eng.duck) eng.duck = ctx.createGain();
    eng.mix.disconnect();
    eng.mix.connect(eng.duck);
    eng.duck.disconnect();
    eng.duck.connect(eng.sfx || eng.tone);
    eng.duck.gain.setValueAtTime(1, ctx.currentTime);

    try { bus.disconnect(eng.mix); } catch { /* was not connected */ }
    bus.connect(eng.drumGlue);
  }
  Hooks.on('buses', (_b, eng) => route(eng), 10);

  /** Sidechain: dip the music at t, recover over `len` seconds. */
  function duck(eng, t, depth, len) {
    if (!S.sidechain || !eng.duck || depth <= 0.001) return;
    const g = eng.duck.gain;
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(1 - Math.min(0.95, depth), t + 0.005);
    g.linearRampToValueAtTime(1, t + len);
  }

  function toBus(eng, node, pan, bus) {
    if (eng.ctx.createStereoPanner) {
      const p = eng.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      node.connect(p);
      p.connect(bus);
    } else node.connect(bus);
  }

  /* ── Kick ────────────────────────────────────────────────────────────── */

  function kick(eng, c) {
    const { t, vel, P, kit, root } = c, ctx = eng.ctx, st = KSTYLE[kit.kickStyle];
    const bus = eng.kickIn, lvl = P.drums;

    const oct = S.kickOct === 'low' ? 0.5 : S.kickOct === 'high' ? 2 : 1;
    const semi = S.tuneToKey ? kit.kickSemi : 0;
    const f = mtof(root + semi) * oct * Math.pow(2, P.kTone / 12) * (kit.kickStyle === 2 ? 0.5 : 1);
    const dec = (0.2 + 0.55 * kit.kickDecay) * st.decay * P.kDecay;
    const sub = kit.kickSub * P.kSub;

    const out = ctx.createGain();
    out.gain.value = lvl * vel * 0.9;
    out.connect(bus);

    // 1 · body: a tonal glide from above the root into it
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.setValueAtTime(f * st.glide, t);
    b.frequency.exponentialRampToValueAtTime(f, t + st.glideT);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(0.85, t + 0.002);
    bg.gain.setTargetAtTime(0, t + 0.002, dec * 0.3);
    b.connect(bg); bg.connect(out);
    b.start(t); b.stop(t + dec * 1.5 + 0.1);

    // 2 · sub: the weight, held on the root and left to ring
    const s = ctx.createOscillator();
    s.type = 'sine';
    s.frequency.setValueAtTime(f, t);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.9 * sub, t + 0.004);
    sg.gain.setTargetAtTime(0, t + 0.02, dec * 0.9);
    s.connect(sg); sg.connect(out);
    s.start(t); s.stop(t + dec * 2 + 0.2);

    // 3 · harmonics: the kick stays audible on speakers that cannot reach the sub
    const hm = ctx.createOscillator();
    hm.type = 'triangle';
    hm.frequency.setValueAtTime(f * 2.01, t);
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.22 * sub + 0.08, t);
    hg.gain.setTargetAtTime(0, t + 0.01, 0.05 + 0.05 * kit.kickDecay);
    hm.connect(hg); hg.connect(out);
    hm.start(t); hm.stop(t + 0.5);

    // 4 · click: the beater, brighter with Colour
    const n = eng.noise(t, 0.03);
    const bp = eng.filt('bandpass', 1400 + 2200 * P.drumY, 1.1);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.45 * st.click * P.kPunch, t);
    ng.gain.setTargetAtTime(0, t + 0.001, 0.004);
    n.connect(bp); bp.connect(ng); ng.connect(out);

    duck(eng, t, S.duck * c.duckMul * lvl * (0.45 + 0.55 * vel) * (0.6 + 0.4 * P.kPunch), 0.1 + dec);
  }

  /* ── Snare ───────────────────────────────────────────────────────────── */

  function snare(eng, c) {
    const { t, vel, P, kit, root } = c, ctx = eng.ctx, bus = eng.buses.drums, st = SSTYLE[kit.snareStyle];
    const lvl = P.drums, tone = toneFor(c.letter);
    const body = mtof(root + kit.snareBody);
    const dec = (0.05 + 0.17 * P.sSnap) * tone[1];

    // Tonal body: a triangle that falls into pitch, with a soft octave above it.
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(body * 1.4, t);
    o.frequency.exponentialRampToValueAtTime(body, t + 0.03);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vel * 0.5 * st.body * P.sBody * lvl, t);
    og.gain.setTargetAtTime(0, t + 0.002, st.bodyDec * (0.6 + 0.8 * P.sSnap));
    o.connect(og); og.connect(bus);
    o.start(t); o.stop(t + 0.4);

    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(body * 2, t);
    const o2g = ctx.createGain();
    o2g.gain.setValueAtTime(vel * 0.12 * P.sBody * lvl, t);
    o2g.gain.setTargetAtTime(0, t + 0.002, st.bodyDec * 0.7);
    o2.connect(o2g); o2g.connect(bus);
    o2.start(t); o2.stop(t + 0.3);

    // Noise body: the snare band, shaped by Tone.
    const n = eng.noise(t, 0.7);
    const bp = eng.filt('bandpass', (1200 + 1000 * P.sTone) * tone[0], 0.7);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * 0.55 * st.noise * lvl * tone[2], t);
    ng.gain.setTargetAtTime(0, t + 0.002, dec);
    n.connect(bp); bp.connect(ng); toBus(eng, ng, 0, bus);

    // Crack: a short, bright snap.
    const n2 = eng.noise(t, 0.03);
    const hp = eng.filt('highpass', 4800 + 1800 * P.sTone, 0.6);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(vel * 0.28 * st.snap * lvl, t);
    cg.gain.setTargetAtTime(0, t + 0.001, 0.007);
    n2.connect(hp); hp.connect(cg); toBus(eng, cg, 0, bus);

    // Rim style: a bright click in place of the body's tail.
    if (st.rim) {
      const r = ctx.createOscillator();
      r.type = 'triangle';
      r.frequency.setValueAtTime(1700, t);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(vel * 0.3 * lvl, t);
      rg.gain.setTargetAtTime(0, t + 0.001, 0.012);
      r.connect(rg); rg.connect(bus);
      r.start(t); r.stop(t + 0.1);
    }

    duck(eng, t, S.duck * c.duckMul * 0.3 * lvl, 0.12);
  }

  /* ── Hats ────────────────────────────────────────────────────────────── */

  function hat(eng, c, open, pan) {
    const { t, vel, P, kit, root } = c, ctx = eng.ctx, tone = toneFor(c.letter);
    const base = (S.tuneToKey ? mtof(root + 30) : 320) * tone[0] * (0.7 + 0.3 * P.hTone);
    const len = (open ? 0.4 + 0.45 * kit.hatDecay : 0.05 + 0.07 * kit.hatDecay) * P.hDecay;
    const lvl = P.drums;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.12 * lvl * tone[2], t + 0.001);
    g.gain.setTargetAtTime(0, t + 0.001, len * 0.3);

    if (kit.hatStyle !== 2) {
      const hp = eng.filt('highpass', 6500 + 2500 * P.hTone, 0.6);
      hp.connect(g);
      const ratios = kit.hatStyle === 1 ? HAT_METAL : HAT_R;
      for (const r of ratios.slice(0, open ? 6 : 4)) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = base * r;
        const og = ctx.createGain();
        og.gain.value = 0.06;
        o.connect(og); og.connect(hp);
        o.start(t); o.stop(t + len * 1.2 + 0.02);
      }
    }

    const n = eng.noise(t, 0.3);
    const bp = eng.filt('bandpass', 9000 + 3000 * P.hTone, 1.1);
    const ng = ctx.createGain();
    ng.gain.value = kit.hatStyle === 2 ? 0.7 : 0.3;
    n.connect(bp); bp.connect(ng); ng.connect(g);

    toBus(eng, g, pan, eng.buses.drums);
  }

  /* ── Shaker and crash ────────────────────────────────────────────────── */

  function shaker(eng, c) {
    const n = eng.noise(c.t, 0.2);
    const bp = eng.filt('bandpass', 5200 + 2600 * c.P.hTone, 1.2);
    const g = eng.gain(0);
    g.gain.setValueAtTime(0, c.t);
    g.gain.linearRampToValueAtTime(c.vel * 0.12 * c.P.drums, c.t + 0.014);
    g.gain.setTargetAtTime(0, c.t + 0.014, 0.024);
    n.connect(bp); bp.connect(g);
    toBus(eng, g, c.pan, eng.buses.drums);
  }

  function crash(eng, c) {
    const { t, vel, P, kit, root } = c, ctx = eng.ctx, bus = eng.buses.bell || eng.buses.drums;
    const len = kit.crashLen * P.hDecay;
    const n = eng.noise(t, 2.2);
    const hp = eng.filt('highpass', 3600, 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * 0.12 * P.drums, t);
    g.gain.setTargetAtTime(0, t + 0.01, len * 0.35);
    n.connect(hp); hp.connect(g); g.connect(bus);

    const base = S.tuneToKey ? mtof(root + 36) : 410;
    for (const r of METAL) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = (base * r) / METAL[0];
      const og = ctx.createGain();
      og.gain.setValueAtTime(vel * 0.02 * P.drums, t);
      og.gain.setTargetAtTime(0, t + 0.01, len * 0.3);
      const hp2 = eng.filt('highpass', 2800, 0.7);
      o.connect(og); og.connect(hp2); hp2.connect(bus);
      o.start(t); o.stop(t + len * 1.3);
    }
  }

  /* ── Hook ────────────────────────────────────────────────────────────── */

  Hooks.on('voice', (_, ev, t, eng) => {
    if (Sound.mode !== 'sigil' || !eng.sig || !eng.buses || !DRUMS.has(ev.type)) return undefined;
    const P = Sound.paramsAt(eng, ev.beat);
    if (!P || P.drums <= 0.001) return true;

    const song = app.song, beat = ev.beat || 0;
    const c = {
      t, vel: ev.vel, P, beat,
      kit: SD.drumKit(app.sigil.hash, P.drumX, P.drumY),
      letter: letterAt(beat),
      root: song ? rootAt(song, beat) : 40,
      pan: ev.pan || 0,
      duckMul: S.sectionAware && song ? (SECTION_DUCK[sectionIndexAt(song, beat)] ?? 1) : 1,
    };

    switch (ev.type) {
      case 'kick':   kick(eng, c); break;
      case 'snare':  snare(eng, c); break;
      case 'hat':    hat(eng, c, !!ev.open, c.pan); break;
      case 'shaker': shaker(eng, c); break;
      case 'crash':  crash(eng, c); break;
    }
    return true;
  }, 10);

  /* ── The part: which groove, written when, kept in step how ──────────── */

  const hasSound = typeof Sound !== 'undefined';

  /** The groove number for a sigil: its patch's, else the mood's, else the sigil's own (0). */
  function takeFor(sigil, cfg) {
    const o = hasSound && Sound.overridesFor ? Sound.overridesFor(sigil) : {};
    const mood = (cfg && cfg.sound) || {};
    return clamp((o.take ?? mood.take ?? 0) | 0, 0, 99);
  }

  /** What 05c is asked for: this listener's amounts, the sigil's groove, and any mood override. */
  function optionsFor(sigil, cfg) {
    return { take: takeFor(sigil, cfg), variation: S.variation, fills: S.fills, ghosts: S.ghosts, human: S.human,
             ...((cfg && cfg.drums) || {}) };
  }

  /** Who writes the kit: a style (05f), if the song has one; else the sigil, or (Classic) the composer. */
  const styled = (cfg) => !!(cfg && cfg.drums && cfg.drums.feel);
  const written = (cfg) => S.style === 'sigil' || styled(cfg);

  // Composition: write the part into the score. Classic leaves the composer's bars alone (unless a style plays).
  Hooks.on('score', (events, ctx) => (written(ctx.cfg) ? Groove.score(events, ctx, optionsFor(ctx.sigil, ctx.cfg)) : undefined));

  const liveEngine = () => {
    const e = app.engine;
    return e && e.isDSP && e.buses && app.song && e.song === app.song ? e : null;
  };
  let planT = 0;
  /** Re-plan soon: coalesces a slider drag into one compile. Sounding hits ring on. */
  function replanSoon() {
    clearTimeout(planT);
    planT = setTimeout(() => { const e = liveEngine(); if (e) SigilPlan.replan(e); }, 120);
  }

  /**
   * Bring a song's drum part in line with the settings. Rewrites the part in
   * place when (and only when) it was written with different options, so it is
   * safe to call on every change. Returns true if the part changed.
   */
  function sync(song = app.song, sigil = app.sigil, replan = true) {
    if (!song || !sigil || !song.cfg) return false;
    const opts = optionsFor(sigil, song.cfg);
    const want = written(song.cfg) ? Groove.sigOf(opts) : null;
    const have = song.cfg.groove ? song.cfg.groove.sig : null;
    if (want === have) return false;
    if (want === null) Groove.restore(song); else Groove.apply(song, sigil, opts);
    const e = app.engine;
    if (e && e.song === song) { e.events = song.events; if (replan) replanSoon(); }
    if (song === app.song) renderMeta();
    return true;
  }

  // Loading: by now Sound has synced the patch to this sigil (m11 attaches at priority 0), and the
  // plan is compiled straight after this hook. If the groove number the song was composed with is
  // not the patch's after all, this is where it is put right, before a single event is compiled.
  Hooks.on('buses', (_b, eng) => { sync(eng.song, eng.sigil, false); }, 20);

  Hooks.on('meta', (parts) => {
    const gr = app.song && app.song.cfg && app.song.cfg.groove;
    if (gr && gr.take) parts.push(`groove ${gr.take}`);
  });

  /* When the kit speaks a letter (a fill), that letter answers on the wheel: a small ring in the
     ink colour at its node, gone within a beat. The melody's flares are ember; these are not, so
     the two readings of the sigil can be told apart. `said` is sorted, so a binary search finds now. */
  const SAID_BEATS = 0.9;
  Hooks.on('drawPlaying', ({ r, F, T, beat, song }) => {
    const said = song.cfg && song.cfg.groove && song.cfg.groove.said;
    if (!said || !said.length) return;
    let lo = 0, hi = said.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (said[m].beat < beat - SAID_BEATS) lo = m + 1; else hi = m; }
    for (let i = lo; i < said.length && said[i].beat <= beat; i++) {
      const q = (beat - said[i].beat) / SAID_BEATS, [x, y] = nodeXY(said[i], T, F);
      r.circle(x, y, 2.6, r.pal.line, 0.9 * (1 - q), true);
      r.circle(x, y, 3 + F.R * 0.055 * q, r.pal.line, 0.7 * (1 - q), false, 1.2);
    }
  });

  /** Step to another groove of this sigil. The number lives in the patch, so Sound keeps and shares it. */
  function step(d) {
    if (!hasSound || !app.sigil || !app.song || !written(app.song.cfg)) return;
    const n = mod(takeFor(app.sigil, app.song.cfg) + d, 100);
    if (n) Sound.set('take', n); else Sound.unset('take');   // either notifies; the subscription below does the rest
    const now = Groove.describe(app.song);
    UI.announce(`${now.short}: ${now.detail}`);
  }

  /* ── Panel: how the kit plays, and how it moves the music ────────────── */

  const pct = (v) => `${Math.round(v * 100)}%`;
  let styleRow, grooveLbl, grooveInfo, prevBtn, nextBtn, fxRow, duckRow, scRow, secRow, tuneRow, octRow;
  const amounts = {};
  const AMOUNTS = [
    ['variation', 'Variation', 'How much each bar answers the one before: extra kicks, flams, side-stick, the shaker’s whispers'],
    ['fills', 'Fills', 'How much the kit does at the end of a phrase and of a section: the sigil’s name said on the kit, a tom cascade, a roll, flams, a double-kick run, hand-drums, stop-time, claves, claps… chosen by where the music is going. At zero it never fills'],
    ['ghosts', 'Ghosts', 'Ghost notes on the snare, between the backbeats'],
    ['human', 'Humanise', 'A drummer’s hand: small differences of timing and force, and a backbeat that sits behind the beat'],
    ['dynamics', 'Dynamics', 'How much a stroke’s force changes its sound, not only its level'],
  ];

  function showGroove() {
    if (!grooveLbl) return;
    const d = app.song ? Groove.describe(app.song) : { short: 'cast to hear', detail: '' };
    grooveLbl.textContent = d.short;
    // A mood may hold some of the amounts for itself (cfg.drums); say so, or the sliders would seem to lie.
    const held = app.song && app.song.cfg.groove && app.song.cfg.drums
      ? Object.entries(app.song.cfg.drums).map(([k, v]) => {
          if (k === 'steady') return v ? 'the kick steady' : '';
          const a = AMOUNTS.find((x) => x[0] === k);
          return a ? `${a[1].toLowerCase()} at ${pct(v)}` : '';
        }).filter(Boolean)
      : [];
    // A style writes the kit whatever Pattern says; say that too, for the same reason.
    const over = app.song && S.style !== 'sigil' && styled(app.song.cfg) ? ' · a style is playing, so it writes the kit' : '';
    grooveInfo.textContent = d.detail + (held.length ? ` · the mood holds ${held.join(', ')}` : '') + over;
  }

  function refresh() {
    if (!duckRow) return;
    const sigil = written(app.song && app.song.cfg);             // the amounts act on any written part, a style's included
    styleRow.input.value = S.style;
    for (const [k] of AMOUNTS) { amounts[k].set(S[k]); amounts[k].input.disabled = !sigil; }
    fxRow.input.checked = S.fx;
    prevBtn.disabled = nextBtn.disabled = !sigil || !app.song;
    showGroove();
    duckRow.set(S.duck);
    scRow.input.checked = S.sidechain;
    secRow.input.checked = S.sectionAware;
    tuneRow.input.checked = S.tuneToKey;
    octRow.input.value = S.kickOct;
  }

  UI.section({ id: 'drums', title: 'Drum Engine', order: 14, build(el) {
    UI.css(`.dr-groove{align-items:center}.dr-lbl{flex:1;min-width:6em;text-align:center;font-style:italic;opacity:.7;font-size:12.5px}
      .dr-info{text-align:center;margin-top:-2px}
      .dr-h{font-size:10.5px;letter-spacing:.3em;text-transform:uppercase;opacity:.6;margin:16px 0 4px}`);

    styleRow = UI.select({ label: 'Pattern', value: S.style,
      options: [['sigil', 'Sigil · the kit reads the sigil'], ['classic', 'Classic · the composer’s own bars']],
      title: 'Sigil writes a part from the sigil’s own geometry and letters. Classic is the single repeated bar per section.',
      onChange: (v) => {
        S.style = v === 'classic' ? 'classic' : 'sigil'; save(); sync(); refresh();
        UI.announce(S.style === 'sigil' ? 'Sigil patterns' : 'Classic patterns');
      } });

    grooveLbl = h('output', { class: 'dr-lbl', 'aria-live': 'off' });
    grooveInfo = UI.note('');
    grooveInfo.classList.add('dr-info');
    prevBtn = UI.button('◀ groove', () => step(-1), { title: 'Previous groove of this sigil (,)', 'aria-label': 'Previous groove' });
    nextBtn = UI.button('groove ▶', () => step(1), { title: 'Next groove of this sigil (.)', 'aria-label': 'Next groove' });

    for (const [k, label, title] of AMOUNTS) {
      amounts[k] = UI.slider({ label, min: 0, max: 1, step: 0.01, value: S[k], format: pct, title,
        onInput: (v) => {
          S[k] = v; save();
          if (k === 'dynamics') replanSoon(); else sync();        // dynamics is baked at compile, not in the part
          showGroove();
        } });
    }

    fxRow = UI.check({ label: 'The kit’s own FX chain (the D· knobs in Sound & Patch)', checked: S.fx,
      title: 'Unticked, the kit bypasses drive, punch, body, crusher, filter, smash, room and echo',
      onChange: (v) => { S.fx = v; save(); const e = liveEngine(); if (e) SigilPlan.refreshSections(e); } });

    duckRow = UI.slider({ label: 'Duck', min: 0, max: 1, step: 0.01, value: S.duck, format: pct,
      onInput: (v) => { S.duck = v; save(); } });
    scRow = UI.check({ label: 'Sidechain the music to the kick', checked: S.sidechain,
      onChange: (v) => { S.sidechain = v; save(); } });
    secRow = UI.check({ label: 'Section-aware ducking (follows the rite)', checked: S.sectionAware,
      onChange: (v) => { S.sectionAware = v; save(); } });
    tuneRow = UI.check({ label: 'Tune kick and drums to the chord', checked: S.tuneToKey,
      onChange: (v) => { S.tuneToKey = v; save(); } });
    octRow = UI.select({ label: 'Kick octave', value: S.kickOct,
      options: [['auto', 'Auto'], ['low', 'Low'], ['high', 'High']],
      onChange: (v) => { S.kickOct = v; save(); } });

    el.append(
      UI.note('The kit reads the sigil too. Its rhythms are the polygons at the hub, turned and mirrored with each section; each letter gives its sixteenth a weight; and at the end of a phrase the kit speaks the letters as drums. A sigil has a hundred grooves: 0 is its own.'),
      styleRow,
      h('div', { class: 'sgrow dr-groove' }, prevBtn, grooveLbl, nextBtn),
      grooveInfo,
      ...AMOUNTS.map(([k]) => amounts[k]),
      fxRow,
      h('div', { class: 'dr-h' }, 'How the kit moves the music'),
      UI.note('The kit is chosen by Size and Colour in the Sound panel and shaped there, along with its FX. Here: how hard the kick ducks the music, and whether the duck follows the rite. Kick, toms and hats are tuned to the chord they land on.'),
      duckRow, scRow, secRow, tuneRow, octRow);
    refresh();
  } });

  if (hasSound) Sound.subscribe(() => { sync(); refresh(); });
  Hooks.on('song', refresh);
  Hooks.on('forget', () => setTimeout(refresh, 7200));      // once the sigil has burned, the panel forgets it too
  UI.whenReady(refresh);

  UI.key(',', 'Previous groove', () => step(-1), { group: 'Drums', display: ',' });
  UI.key('.', 'Next groove', () => step(1), { group: 'Drums', display: '.' });

  return { chordAt, rootAt, settings: S, sync, step, optionsFor };
})();

if (typeof window !== 'undefined') window.DrumEngine = DrumEngine;