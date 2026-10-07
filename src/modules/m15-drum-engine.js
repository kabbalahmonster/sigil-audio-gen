'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m15 · DRUM ENGINE v2
   --------------------------------------------------------------------------
   ROUTING
     music:  mix → duck → crusher → tone
     drums:  buses.drums → glue compressor → drumSum → tone   (never ducked)
     kick:   its own shaped input, and it ducks the music when sidechain is on

   TUNING  the kick's body sits on the current chord's root, in key; the
           snare body is a fifth above it; hat and crash clusters are built on
           chord-relative fundamentals. Switch "tune to chord" off for fixed pitch.

   SIZE / COLOUR  drumX and drumY are patch fields, so they travel with the
           sigil, follow the section arc, and are saved per sigil.
   ══════════════════════════════════════════════════════════════════════════ */

const DrumEngine = (() => {
  'use strict';
  const { h } = UI;
  const DRUMS = new Set(['kick', 'snare', 'hat', 'shaker', 'crash']);
  const HAT_RATIOS = [1, 1.4471, 1.6317, 1.9323, 2.5465, 2.7];
  const METAL = [1, 1.4, 1.67, 2.1, 2.74];

  const S = { duck: 0.5, sidechain: true, tuneToKey: true, kickOct: 'auto', ...Prefs.get('drums', {}) };
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
    const bar = clamp(Math.floor((beat - ph.start) / 4), 0, 3);
    return ph.chords[bar];
  }

  /** MIDI of the current chord root, in the bass register. Falls back to the tonic. */
  function rootAt(song, beat) {
    if (!S.tuneToKey) return song.bassBase;
    return bassPitch(chordAt(song, beat), 'root', song.bassBase, song.scale);
  }

  function toneAt(beat) {
    const s = app.sigil;
    const letter = s ? s.reduced[mod(Math.round(beat * 4), s.reduced.length)] : 'T';
    return SD_TONE(letter);
  }
  const SD_TONE = (letter) => SoundDesign.CLASS_TONE[SoundDesign.CONSONANT_CLASS[letter] || 'fricative'];

  /* ── Routing ─────────────────────────────────────────────────────────── */

  function route(eng) {
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

    // Music path: mix → duck → crusher/tone.
    if (!eng.duck) eng.duck = ctx.createGain();
    eng.mix.disconnect();
    eng.mix.connect(eng.duck);
    eng.duck.disconnect();
    eng.duck.connect(eng.sfx || eng.tone);
    eng.duck.gain.setValueAtTime(1, ctx.currentTime);

    // Drums path: bus → glue (and nowhere else on the mix).
    try { bus.disconnect(eng.mix); } catch { /* was not connected */ }
    bus.connect(eng.drumGlue);
  }
  Hooks.on('buses', (_b, eng) => route(eng), 10);

  /** Sidechain: dip the music at t, then recover over `len` seconds. */
  function duck(eng, t, depth, len) {
    if (!S.sidechain || !eng.duck || depth <= 0.001) return;
    const g = eng.duck.gain;
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(1 - depth, t + 0.005);
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

  function kick(eng, t, vel, P, K, root) {
    const ctx = eng.ctx, lvl = P.drums, bus = eng.kickIn;
    const oct = S.kickOct === 'low' ? 1 : S.kickOct === 'high' ? 2 : (K.oct || 1);
    const f = mtof(root) * oct;
    const size = (0.35 + 0.65 * P.drumX) * (0.5 + 0.5 * K.decay);
    const colour = P.drumY;

    const out = ctx.createGain();
    out.gain.value = 0.95 * lvl * vel;
    out.connect(bus);

    // Body: a fast pitch drop from 2.6× into the chord root.
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(f * 2.6, t);
    body.frequency.exponentialRampToValueAtTime(f, t + 0.03 + 0.02 * size);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(1, t + 0.002);
    bg.gain.setTargetAtTime(0, t + 0.002, 0.05 + 0.16 * size);
    body.connect(bg); bg.connect(out);
    body.start(t); body.stop(t + 0.9 + size * 0.6);

    // Snap: a brief second harmonic, louder with colour.
    const h2 = ctx.createOscillator();
    h2.type = 'triangle';
    h2.frequency.setValueAtTime(f * 3.1, t);
    h2.frequency.exponentialRampToValueAtTime(f * 2, t + 0.015);
    const h2g = ctx.createGain();
    h2g.gain.setValueAtTime(0.1 + 0.3 * colour, t);
    h2g.gain.setTargetAtTime(0, t + 0.002, 0.012 + 0.01 * colour);
    h2.connect(h2g); h2g.connect(out);
    h2.start(t); h2.stop(t + 0.2);

    // Sub: the root itself, held under everything.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(f, t);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.55, t);
    sg.gain.setTargetAtTime(0, t + 0.03, 0.08 + 0.25 * size);
    sub.connect(sg); sg.connect(out);
    sub.start(t); sub.stop(t + 1.4);

    // Beater click.
    const n = eng.noise(t, 0.03);
    const hp = eng.filt('bandpass', 1500 + 2500 * colour, 1.1);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.35 * K.click, t);
    ng.gain.setTargetAtTime(0, t + 0.001, 0.0035);
    n.connect(hp); hp.connect(ng); ng.connect(out);

    duck(eng, t, S.duck * lvl * (0.45 + 0.55 * vel) * (0.5 + 0.5 * K.punch), 0.1 + 0.22 * size);
  }

  /* ── Snare ───────────────────────────────────────────────────────────── */

  function snare(eng, t, vel, P, K, root, beat) {
    const ctx = eng.ctx, lvl = P.drums, bus = eng.buses.drums, tone = toneAt(beat);
    const colour = P.drumY;
    const dec = (0.05 + 0.17 * K.snap) * tone[1];

    // Tonal body a fifth above the root, so the snare sings with the chord.
    const body = mtof(root + 19);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(body * 1.35, t);
    o.frequency.exponentialRampToValueAtTime(body, t + 0.035);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vel * 0.42 * lvl, t);
    og.gain.setTargetAtTime(0, t + 0.002, 0.025 + 0.05 * K.snap);
    o.connect(og); og.connect(bus);
    o.start(t); o.stop(t + 0.35);

    // Noise body.
    const n = eng.noise(t, 0.6);
    const bp = eng.filt('bandpass', (1100 + 1500 * K.noiseTone) * tone[0] * (0.8 + 0.4 * colour), 0.8);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * 0.55 * lvl * tone[2], t);
    ng.gain.setTargetAtTime(0, t + 0.002, dec);
    n.connect(bp); bp.connect(ng); toBus(eng, ng, 0, bus);

    // Crack.
    const n2 = eng.noise(t, 0.03);
    const hp = eng.filt('highpass', 4200 + 1400 * K.noiseTone, 0.6);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(vel * 0.22 * lvl, t);
    cg.gain.setTargetAtTime(0, t + 0.001, 0.006);
    n2.connect(hp); hp.connect(cg); toBus(eng, cg, 0, bus);

    duck(eng, t, S.duck * 0.3 * lvl, 0.12);
  }

  /* ── Hats ────────────────────────────────────────────────────────────── */

  function hat(eng, t, vel, P, K, open, root, beat, pan) {
    const ctx = eng.ctx, lvl = P.drums, tone = toneAt(beat);
    const base = (S.tuneToKey ? mtof(root + 30) : 300) * tone[0];
    const len = open ? 0.42 + 0.4 * K.hatDecay : 0.05 + 0.06 * K.hatDecay;
    const ratios = HAT_RATIOS.slice(0, open ? 6 : 4);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.1 * lvl * tone[2], t + 0.001);
    g.gain.setTargetAtTime(0, t + 0.001, len * 0.3);

    const hp = eng.filt('highpass', 6500 + 2500 * K.hatTone, 0.6);
    hp.connect(g);
    for (const r of ratios) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = base * r;
      const og = ctx.createGain();
      og.gain.value = 0.06;
      o.connect(og); og.connect(hp);
      o.start(t); o.stop(t + len * 1.2 + 0.02);
    }

    const n = eng.noise(t, 0.3);
    const bp = eng.filt('bandpass', 9000 + 3000 * K.hatTone, 1.1);
    const ng = ctx.createGain();
    ng.gain.value = 0.35;
    n.connect(bp); bp.connect(ng); ng.connect(g);

    toBus(eng, g, pan, eng.buses.drums);
  }

  /* ── Shaker and crash ────────────────────────────────────────────────── */

  function shaker(eng, t, vel, P, pan) {
    const n = eng.noise(t, 0.2);
    const bp = eng.filt('bandpass', 5200 + 2600 * P.kit.hatTone, 1.2);
    const g = eng.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.12 * P.drums, t + 0.014);
    g.gain.setTargetAtTime(0, t + 0.014, 0.024);
    n.connect(bp); bp.connect(g);
    toBus(eng, g, pan, eng.buses.drums);
  }

  function crash(eng, t, vel, P, K, root) {
    const ctx = eng.ctx, bus = eng.buses.bell || eng.buses.drums;
    const len = 0.9 + 0.6 * K.hatDecay;
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
      o.frequency.value = base * r / METAL[0];
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
    const root = song ? rootAt(song, beat) : 40;
    const K = P.kit, vel = ev.vel, pan = ev.pan || 0;

    switch (ev.type) {
      case 'kick':   kick(eng, t, vel, P, K, root); break;
      case 'snare':  snare(eng, t, vel, P, K, root, beat); break;
      case 'hat':    hat(eng, t, vel, P, K, !!ev.open, root, beat, pan); break;
      case 'shaker': shaker(eng, t, vel, P, pan); break;
      case 'crash':  crash(eng, t, vel, P, K, root); break;
    }
    return true;
  }, 10);

  /* ── Panel ───────────────────────────────────────────────────────────── */

  const pct = (v) => `${Math.round(v * 100)}%`;
  let dukeRow, scRow, tkRow, octRow, sizeRow, colRow;

  function refresh() {
    if (!sizeRow) return;
    dukeRow.set(S.duck);
    scRow.input.checked = S.sidechain;
    tkRow.input.checked = S.tuneToKey;
    octRow.input.value = S.kickOct;
    const P = Sound.state().P;
    if (P) { sizeRow.set(P.drumX); colRow.set(P.drumY); }
  }

  UI.section({ id: 'drums', title: 'Drum Engine', order: 14, build(el) {
    dukeRow = UI.slider({ label: 'Duck', min: 0, max: 1, step: 0.01, value: S.duck, format: pct,
      onInput: (v) => { S.duck = v; save(); } });
    scRow = UI.check({ label: 'Sidechain the music to the kick', checked: S.sidechain,
      onChange: (v) => { S.sidechain = v; save(); } });
    tkRow = UI.check({ label: 'Tune kick and drums to the chord', checked: S.tuneToKey,
      onChange: (v) => { S.tuneToKey = v; save(); } });
    octRow = UI.select({ label: 'Kick octave', value: S.kickOct,
      options: [['auto', 'Auto · from the dream'], ['low', 'Low'], ['high', 'High']],
      onChange: (v) => { S.kickOct = v; save(); } });
    sizeRow = UI.slider({ label: 'Size', min: 0, max: 1, step: 0.01, value: 0.5, format: pct,
      onInput: (v) => Sound.set('drumX', v) });
    colRow = UI.slider({ label: 'Colour', min: 0, max: 1, step: 0.01, value: 0.5, format: pct,
      onInput: (v) => Sound.set('drumY', v) });
    el.append(
      UI.note('The kick is pitched to the chord it lands on, its sub is the root, and its body snaps down into the key. Sidechain ducks the music under the kick. Size and Colour travel with the sigil and follow the sound arc.'),
      dukeRow, scRow, tkRow, octRow, sizeRow, colRow);
    refresh();
  } });

  Sound.subscribe(refresh);
  Hooks.on('song', refresh);
  UI.whenReady(refresh);

  return { chordAt, rootAt };
})();

if (typeof window !== 'undefined') window.DrumEngine = DrumEngine;