'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m15 · DRUM ENGINE v3 · the flagship
   --------------------------------------------------------------------------
   KIT        a 4 × 4 drum cube (SD.drumKit), chosen by Size and Colour, with
              a different kick, snare, hat and crash per cell
   KICK       four layers: a tonal body that glides into the chord root, a sub
              that holds the root, a harmonic layer that reads on small speakers,
              and a beater click. Drive and sidechain come from the bus
   SNARE      tuned body, noise body, crack, and a rim voice for one style
   HATS       square clusters, inharmonic clusters or airy noise
   CRASH      noise plus a metallic cluster, tuned to the chord

   TONE & TEXTURE  the K·, S· and H· knobs live in the Sound panel (m12). They
                   reshape the kit in real time without replacing it.
   TIMING     the hit is scheduled on the audio clock, and the kit is memoised.
   CONTROLS   ducking, sidechain, section-aware ducking, tune-to-chord and kick
              octave live in this module's panel.

   ROUTING    music:  mix → duck → crusher → tone
              drums:  buses.drums → glue compressor → drumSum → tone (never ducked)
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
    ...Prefs.get('drums', {}),
  };
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

  /* ── Panel: controls for the drum engine ─────────────────────────────── */

  const pct = (v) => `${Math.round(v * 100)}%`;
  let duckRow, scRow, secRow, tuneRow, octRow;

  function refresh() {
    if (!duckRow) return;
    duckRow.set(S.duck);
    scRow.input.checked = S.sidechain;
    secRow.input.checked = S.sectionAware;
    tuneRow.input.checked = S.tuneToKey;
    octRow.input.value = S.kickOct;
  }

  UI.section({ id: 'drums', title: 'Drum Engine', order: 14, build(el) {
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
      UI.note('The kit is chosen by Size and Colour in the Sound panel, and shaped there too. This panel sets how the drums move the music: how hard the kick ducks, and whether the duck follows the rite. The kick’s pitch follows the chord it lands on.'),
      duckRow, scRow, secRow, tuneRow, octRow);
    refresh();
  } });

  Sound.subscribe(refresh);
  Hooks.on('song', refresh);
  UI.whenReady(refresh);

  return { chordAt, rootAt, settings: S };
})();

if (typeof window !== 'undefined') window.DrumEngine = DrumEngine;