'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m15 · DRUM ENGINE v3 — the flagship kit
   --------------------------------------------------------------------------
   ROUTING   music:  mix → duck → crusher → tone
             drums:  kick rack ┐
                     bus ──────┴→ glue compressor → drumSum → tone  (not ducked)
                     bus → room send → reverb

   KICK      body (pitch drop into the chord root) + held root sub + optional
             octave-down sub + beater click + transient, through a dedicated
             low-pass and saturator. Models: round, punch, deep, gated.

   SNARE     tuned shell partials + noise body with a falling filter + crack +
             wire rattle. Models: shell, clap, rim, layered. Ghosts and flams
             come from velocity and beat position, so they are deterministic.

   NOISE RACK  One looping source per live engine feeds pre-filtered taps, so a
             hit costs a single gain node. Offline renders use per-hit sources,
             which free themselves.

   CONTROLS  Tone and texture live in the Sound panel as knobs. This panel keeps
             the engine options: ducking, tuning, kick octave, models.
   ══════════════════════════════════════════════════════════════════════════ */

const DrumEngine = (() => {
  'use strict';
  const { h } = UI;
  const SD = SoundDesign;
  const DRUMS = new Set(['kick', 'snare', 'hat', 'shaker', 'crash']);
  const HAT_RATIOS = [1, 1.4471, 1.6317, 1.9323, 2.5465, 2.7];
  const METAL = [1, 1.4, 1.67, 2.1, 2.74];

  const S = {
    duck: 0.55, sidechain: true, tuneToKey: true, kickOct: 'auto',
    models: true, flams: true, ghosts: true,
    ...Prefs.get('drums', {}),
  };
  const save = () => Prefs.set('drums', S);

  const cap = (type, end, eng) =>
    (typeof Perf === 'undefined' ? true : Perf.take(type, end, eng.ctx.currentTime, eng.offline));
  const reap = (node, when) => { if (typeof Perf !== 'undefined') Perf.reap(node, when); };

  /* ── Musical context ─────────────────────────────────────────────────── */

  function chordAt(song, beat) {
    const P = song.phrases;
    let lo = 0, hi = P.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (P[m].start <= beat) lo = m; else hi = m - 1; }
    const ph = P[lo];
    return ph.chords[clamp(Math.floor((beat - ph.start) / 4), 0, 3)];
  }
  function rootAt(song, beat) {
    if (!S.tuneToKey) return song.bassBase;
    return bassPitch(chordAt(song, beat), 'root', song.bassBase, song.scale);
  }
  function toneAt(beat) {
    const s = app.sigil;
    const letter = s ? s.reduced[mod(Math.round(beat * 4), s.reduced.length)] : 'T';
    return SD.CLASS_TONE[SD.CONSONANT_CLASS[letter] || 'fricative'];
  }

  /* ── Routing and the noise rack ──────────────────────────────────────── */

  function route(eng) {
    const ctx = eng.ctx, bus = eng.buses && eng.buses.drums;
    if (!bus) return;
    eng.offline = typeof ctx.startRendering === 'function';

    if (!eng.drumSum) { eng.drumSum = ctx.createGain(); eng.drumSum.connect(eng.tone); }
    if (!eng.drumGlue) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -14; c.ratio.value = 4; c.knee.value = 6;
      c.attack.value = 0.003; c.release.value = 0.12;
      c.connect(eng.drumSum);
      eng.drumGlue = c;
    }

    // Kick chain: low-pass, then saturation, so the sub stays clean under drive.
    if (eng.kickIn) eng.kickIn.disconnect();
    eng.kickIn = ctx.createGain();
    const klp = eng.filt('lowpass', 220, 0.6);
    const kws = ctx.createWaveShaper();
    kws.curve = eng.satCurve; kws.oversample = '2x';
    const kout = ctx.createGain(); kout.gain.value = 1;
    eng.kickIn.connect(klp); klp.connect(kws); kws.connect(kout); kout.connect(bus);
    eng.kickLP = klp;

    // Room send for the kit.
    if (eng.drumRoomGain) eng.drumRoomGain.disconnect();
    eng.drumRoomGain = ctx.createGain();
    eng.drumRoomGain.gain.value = 0.12;
    bus.connect(eng.drumRoomGain);
    eng.drumRoomGain.connect(eng.reverb);

    // Music path, ducked by the kick.
    if (!eng.duck) eng.duck = ctx.createGain();
    eng.mix.disconnect();
    eng.mix.connect(eng.duck);
    eng.duck.disconnect();
    eng.duck.connect(eng.sfx || eng.tone);
    eng.duck.gain.setValueAtTime(1, ctx.currentTime);

    try { bus.disconnect(eng.mix); } catch { /* was not connected */ }
    bus.connect(eng.drumGlue);

    eng.rack = null;   // rebuilt lazily against the new bus
  }
  Hooks.on('buses', (_b, eng) => route(eng), 10);

  /** One looping noise source per live engine, with pre-filtered taps. */
  function rack(eng) {
    if (eng.rack) return eng.rack;
    const ctx = eng.ctx;
    const src = ctx.createBufferSource();
    src.buffer = eng.noiseBuf;
    src.loop = true;
    src.start();
    const tap = (type, f, q) => { const b = eng.filt(type, f, q); src.connect(b); return b; };
    eng.rack = {
      src,
      low: tap('lowpass', 2400, 0.7),
      body: tap('bandpass', 1700, 0.8),
      crack: tap('highpass', 4200, 0.6),
      metal: tap('bandpass', 9200, 1.1),
      air: tap('highpass', 7000, 0.7),
      shake: tap('bandpass', 5600, 1.2),
    };
    return eng.rack;
  }

  /**
   * A gain node fed by noise of a given colour, already connected to `dest`.
   * Live engines share the rack; offline renders use a throwaway source.
   */
  function noiseGain(eng, kind, t, dur, dest) {
    const ctx = eng.ctx, g = ctx.createGain();
    g.gain.value = 0;
    if (eng.offline) {
      const n = eng.noise(t, dur + 0.05);
      const f = { low: ['lowpass', 2400, 0.7], body: ['bandpass', 1700, 0.8], crack: ['highpass', 4200, 0.6],
                  metal: ['bandpass', 9200, 1.1], air: ['highpass', 7000, 0.7], shake: ['bandpass', 5600, 1.2] }[kind];
      const b = eng.filt(f[0], f[1], f[2]);
      n.connect(b); b.connect(g);
    } else {
      rack(eng)[kind].connect(g);
      reap(g, t + dur + 0.25);
    }
    g.connect(dest);
    return g;
  }

  function duck(eng, t, depth, len) {
    if (!S.sidechain || !eng.duck || depth <= 0.001) return;
    const g = eng.duck.gain;
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(1 - clamp(depth, 0, 0.85), t + 0.005);
    g.linearRampToValueAtTime(1, t + len);
  }

  function pan(eng, node, amount, dest) {
    if (eng.ctx.createStereoPanner) {
      const p = eng.ctx.createStereoPanner();
      p.pan.value = clamp(amount, -1, 1);
      node.connect(p); p.connect(dest);
      if (!eng.offline) reap(p, eng.ctx.currentTime + 4);
    } else node.connect(dest);
  }

  /* ── Kick ────────────────────────────────────────────────────────────── */

  function kick(eng, t, vel, P, cell, root) {
    const ctx = eng.ctx, lvl = P.drums, dest = eng.kickIn;
    if (!cap('kick', t + 1.6, eng)) return;

    const oct = S.kickOct === 'low' ? 1 : S.kickOct === 'high' ? 2 : ((P.kit && P.kit.oct) || 1);
    const f = mtof(root) * oct;
    const model = S.models ? cell.kick : 'round';
    const size = cell.size * (0.45 + 0.8 * P.kickDecay);
    const tone = P.kickTone;

    // Model shapes the sweep and the lengths.
    const M = {
      round: { ratio: 2.6, drop: 0.032, bodyDec: 0.06 + 0.17 * size, subDec: 0.1 + 0.3 * size, clickMul: 1 },
      punch: { ratio: 3.6, drop: 0.018, bodyDec: 0.04 + 0.1 * size, subDec: 0.07 + 0.18 * size, clickMul: 1.6 },
      deep: { ratio: 2.1, drop: 0.055, bodyDec: 0.09 + 0.3 * size, subDec: 0.16 + 0.55 * size, clickMul: 0.6 },
      gated: { ratio: 3.0, drop: 0.026, bodyDec: 0.05 + 0.12 * size, subDec: 0.06 + 0.12 * size, clickMul: 1.2 },
    }[model];

    const out = ctx.createGain();
    out.gain.value = 0.95 * lvl * vel;
    out.connect(dest);
    if (!eng.offline) reap(out, t + 2.5);

    // The low-pass opens with tone, so bright kicks keep their knock.
    if (eng.kickLP) {
      eng.kickLP.frequency.setTargetAtTime(150 + 420 * tone, t, 0.02);
    }

    // 1 · Body: a sweep from `ratio` into the chord root.
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(f * M.ratio, t);
    body.frequency.exponentialRampToValueAtTime(f, t + M.drop);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(1, t + 0.0015);
    bg.gain.setTargetAtTime(0, t + 0.0015, M.bodyDec);
    body.connect(bg); bg.connect(out);
    body.start(t); body.stop(t + 1.2 + size);

    // 2 · Sub: the root, held. This is the weight.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(f * 1.06, t);               // a whisker sharp, settling in
    sub.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.85 * P.kickSub, t + 0.008);
    if (model === 'gated') {
      sg.gain.setValueAtTime(0.85 * P.kickSub, t + M.subDec * 0.8);
      sg.gain.linearRampToValueAtTime(0, t + M.subDec * 0.95);   // the gate
    } else {
      sg.gain.setTargetAtTime(0, t + 0.01, M.subDec);
    }
    sub.connect(sg); sg.connect(out);
    sub.start(t); sub.stop(t + 2.2);

    // 3 · Octave-down sub, where it will still reproduce.
    const f2 = f / 2;
    if (f2 >= 27 && P.kickSub > 0.4) {
      const s2 = ctx.createOscillator();
      s2.type = 'sine';
      s2.frequency.setValueAtTime(f2, t);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0, t);
      g2.gain.linearRampToValueAtTime(0.4 * (P.kickSub - 0.4), t + 0.02);
      g2.gain.setTargetAtTime(0, t + 0.02, M.subDec * 1.3);
      s2.connect(g2); g2.connect(out);
      s2.start(t); s2.stop(t + 2.4);
    }

    // 4 · Beater click: a short high chirp plus a transient.
    const click = ctx.createOscillator();
    click.type = 'triangle';
    click.frequency.setValueAtTime(f * (10 + 8 * tone), t);
    click.frequency.exponentialRampToValueAtTime(f * 3, t + 0.012);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.32 * P.kickClick * M.clickMul, t);
    cg.gain.setTargetAtTime(0, t + 0.001, 0.004);
    click.connect(cg); cg.connect(out);
    click.start(t); click.stop(t + 0.08);

    const ng = noiseGain(eng, 'low', t, 0.05, out);
    ng.gain.setValueAtTime(0.3 * P.kickClick * M.clickMul, t);
    ng.gain.setTargetAtTime(0, t + 0.001, 0.0035);

    // 5 · Gated tail: a burst of filtered noise cut hard.
    if (model === 'gated') {
      const tail = noiseGain(eng, 'body', t, 0.3, out);
      tail.gain.setValueAtTime(0.12 * vel, t + 0.01);
      tail.gain.setValueAtTime(0.12 * vel, t + M.subDec * 0.8);
      tail.gain.linearRampToValueAtTime(0, t + M.subDec * 0.95);
    }

    const depth = S.duck * lvl * (P.duck ?? 1) * (0.45 + 0.55 * vel);
    duck(eng, t, depth, 0.09 + 0.25 * size);
  }

  /* ── Snare ───────────────────────────────────────────────────────────── */

  function snareHit(eng, t, vel, P, cell, root, beat, isGhost) {
    const ctx = eng.ctx, lvl = P.drums, bus = eng.buses.drums, tone = toneAt(beat);
    const model = S.models ? cell.snare : 'shell';
    const colour = cell.colour;
    const snap = P.snareSnap * (isGhost ? 0.55 : 1);
    const level = lvl * (isGhost ? 0.35 : 1);
    const dec = (0.04 + 0.18 * snap) * tone[1];

    if (model === 'clap') {
      // Four bursts a few milliseconds apart, then a short body: a handclap.
      for (let i = 0; i < 4; i++) {
        const tt = t + i * (0.006 + 0.004 * colour);
        const g = noiseGain(eng, 'body', tt, 0.12, bus);
        g.gain.setValueAtTime(0, tt);
        g.gain.linearRampToValueAtTime(vel * 0.4 * level * (i === 3 ? 1 : 0.7), tt + 0.001);
        g.gain.setTargetAtTime(0, tt + 0.001, i === 3 ? 0.05 + 0.08 * snap : 0.006);
      }
    } else if (model === 'rim') {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const fr = mtof(root + 31);
      o.frequency.setValueAtTime(fr * 1.6, t);
      o.frequency.exponentialRampToValueAtTime(fr, t + 0.012);
      const og = ctx.createGain();
      og.gain.setValueAtTime(vel * 0.45 * level, t);
      og.gain.setTargetAtTime(0, t + 0.001, 0.012 + 0.02 * snap);
      o.connect(og); og.connect(bus);
      o.start(t); o.stop(t + 0.2);
      const g = noiseGain(eng, 'crack', t, 0.06, bus);
      g.gain.setValueAtTime(vel * 0.3 * level, t);
      g.gain.setTargetAtTime(0, t + 0.001, 0.008);
    }

    if (model === 'shell' || model === 'layered') {
      // Two tuned shell partials, a fifth and an octave-plus above the root.
      for (const [semi, lev, dk] of [[19, 0.42, 0.03], [26, 0.2, 0.02]]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        const fr = mtof(root + semi);
        o.frequency.setValueAtTime(fr * 1.35, t);
        o.frequency.exponentialRampToValueAtTime(fr, t + 0.035);
        const og = ctx.createGain();
        og.gain.setValueAtTime(vel * lev * level * P.snareBody, t);
        og.gain.setTargetAtTime(0, t + 0.002, dk + 0.05 * snap);
        o.connect(og); og.connect(bus);
        o.start(t); o.stop(t + 0.4);
      }
      // Noise body, with the filter falling as the drum decays.
      const nb = noiseGain(eng, 'body', t, 0.6, bus);
      nb.gain.setValueAtTime(vel * 0.55 * level * P.snareNoise * tone[2], t);
      nb.gain.setTargetAtTime(0, t + 0.002, dec);
      // Crack on top.
      const cr = noiseGain(eng, 'crack', t, 0.1, bus);
      cr.gain.setValueAtTime(vel * 0.26 * level, t);
      cr.gain.setTargetAtTime(0, t + 0.001, 0.006 + 0.01 * snap);
      // Wire rattle: a second, later, duller burst.
      const wr = noiseGain(eng, 'low', t + 0.012, 0.2, bus);
      wr.gain.setValueAtTime(0, t + 0.012);
      wr.gain.linearRampToValueAtTime(vel * 0.16 * level * P.snareNoise, t + 0.016);
      wr.gain.setTargetAtTime(0, t + 0.016, dec * 1.2);
    }

    if (model === 'layered') {
      for (let i = 0; i < 3; i++) {
        const tt = t + 0.004 + i * 0.005;
        const g = noiseGain(eng, 'body', tt, 0.08, bus);
        g.gain.setValueAtTime(vel * 0.22 * level, tt);
        g.gain.setTargetAtTime(0, tt + 0.001, 0.007);
      }
    }

    if (!isGhost) duck(eng, t, S.duck * 0.3 * lvl * (P.duck ?? 1), 0.1);
  }

  function snare(eng, t, vel, P, cell, root, beat) {
    if (!cap('snare', t + 0.8, eng)) return;
    const ghost = S.ghosts && vel < 0.3;
    // Flam: a quiet grace note before accents, on a deterministic beat pattern.
    if (S.flams && !ghost && vel > 0.7 && Math.round(beat * 4) % 7 === 0) {
      snareHit(eng, t - 0.024, vel * 0.4, P, cell, root, beat, true);
    }
    snareHit(eng, t, vel, P, cell, root, beat, ghost);
  }

  /* ── Hats, shaker, crash ─────────────────────────────────────────────── */

  function hat(eng, t, vel, P, cell, open, root, beat, panAmt) {
    const ctx = eng.ctx, lvl = P.drums, bus = eng.buses.drums, tone = toneAt(beat);
    if (!cap('hat', t + 0.6, eng)) return;
    const model = S.models ? cell.hat : 'metal';
    const len = (open ? 0.35 + 0.45 * P.hatLen : 0.035 + 0.07 * P.hatLen) * tone[1];

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.11 * lvl * tone[2], t + 0.001);
    g.gain.setTargetAtTime(0, t + 0.001, len * 0.32);
    pan(eng, g, panAmt * 0.6, bus);
    if (!eng.offline) reap(g, t + len * 3 + 0.3);

    if (model !== 'noise') {
      const base = (S.tuneToKey ? mtof(root + 30) : 300) * tone[0];
      const hp = eng.filt('highpass', 6200 + 3000 * P.hatEdge, 0.6);
      hp.connect(g);
      const count = model === 'tight' ? 3 : (open ? 6 : 4);
      for (let i = 0; i < count; i++) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = base * HAT_RATIOS[i];
        const og = ctx.createGain();
        og.gain.value = 0.05;
        o.connect(og); og.connect(hp);
        o.start(t); o.stop(t + len * 1.2 + 0.02);
      }
    }
    const n = noiseGain(eng, model === 'noise' ? 'air' : 'metal', t, len + 0.1, g);
    n.gain.value = model === 'noise' ? 0.7 : 0.35;
  }

  function shaker(eng, t, vel, P, panAmt) {
    if (!cap('shaker', t + 0.3, eng)) return;
    const bus = eng.buses.drums;
    const g = noiseGain(eng, 'shake', t, 0.2, bus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.12 * P.drums, t + 0.012);
    g.gain.setTargetAtTime(0, t + 0.012, 0.022);
  }

  function crash(eng, t, vel, P, root) {
    if (!cap('crash', t + 3, eng)) return;
    const ctx = eng.ctx, bus = eng.buses.bell || eng.buses.drums;
    const len = 0.9 + 0.8 * P.hatLen;
    const g = noiseGain(eng, 'air', t, 2.4, bus);
    g.gain.setValueAtTime(vel * 0.12 * P.drums, t);
    g.gain.setTargetAtTime(0, t + 0.01, len * 0.35);

    const base = S.tuneToKey ? mtof(root + 36) : 410;
    for (const r of METAL) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = base * r;
      const og = ctx.createGain();
      og.gain.setValueAtTime(vel * 0.018 * P.drums, t);
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
    const cell = SD.drumCell(eng.sig.tables.D, P.drumX, P.drumY);

    // Room and glue follow the arc, smoothly.
    if (eng.drumRoomGain) eng.drumRoomGain.gain.setTargetAtTime(0.05 + 0.45 * P.drumRoom, t, 0.08);
    if (eng.drumGlue) eng.drumGlue.threshold.setTargetAtTime(-6 - 18 * P.drumDrive, t, 0.08);

    switch (ev.type) {
      case 'kick': kick(eng, t, ev.vel, P, cell, root); break;
      case 'snare': snare(eng, t, ev.vel, P, cell, root, beat); break;
      case 'hat': hat(eng, t, ev.vel, P, cell, !!ev.open, root, beat, ev.pan || 0); break;
      case 'shaker': shaker(eng, t, ev.vel, P, ev.pan || 0); break;
      case 'crash': crash(eng, t, ev.vel, P, root); break;
    }
    return true;
  }, 10);

  /* ── Panel: engine options only. Tone and texture live in Sound. ─────── */

  const pct = (v) => `${Math.round(v * 100)}%`;
  let duckRow, scRow, tkRow, octRow, mdRow, flRow, ghRow, kitOut;

  function refresh() {
    if (!duckRow) return;
    duckRow.set(S.duck);
    scRow.input.checked = S.sidechain;
    tkRow.input.checked = S.tuneToKey;
    octRow.input.value = S.kickOct;
    mdRow.input.checked = S.models;
    flRow.input.checked = S.flams;
    ghRow.input.checked = S.ghosts;
    const st = Sound.state();
    if (st.P && st.tables) {
      const c = SD.drumCell(st.tables.D, st.P.drumX, st.P.drumY);
      kitOut.textContent = `kit: ${c.kick} kick · ${c.snare} snare · ${c.hat} hats`;
    } else kitOut.textContent = 'cast a sigil to see its kit';
  }

  UI.section({ id: 'drums', title: 'Drum Engine', order: 14, build(el) {
    duckRow = UI.slider({ label: 'Duck', min: 0, max: 1, step: 0.01, value: S.duck, format: pct,
      onInput: (v) => { S.duck = v; save(); } });
    scRow = UI.check({ label: 'Sidechain the music to the kick', checked: S.sidechain, onChange: (v) => { S.sidechain = v; save(); } });
    tkRow = UI.check({ label: 'Tune the kit to the chord', checked: S.tuneToKey, onChange: (v) => { S.tuneToKey = v; save(); } });
    octRow = UI.select({ label: 'Kick octave', value: S.kickOct,
      options: [['auto', 'Auto · from the dream'], ['low', 'Low'], ['high', 'High']],
      onChange: (v) => { S.kickOct = v; save(); } });
    mdRow = UI.check({ label: 'Kit models from the drum cube', checked: S.models, onChange: (v) => { S.models = v; save(); refresh(); } });
    flRow = UI.check({ label: 'Flams on accents', checked: S.flams, onChange: (v) => { S.flams = v; save(); } });
    ghRow = UI.check({ label: 'Ghost notes', checked: S.ghosts, onChange: (v) => { S.ghosts = v; save(); } });
    kitOut = UI.note('');
    el.append(
      UI.note('Engine options live here. The kit’s tone and texture are knobs in the Sound panel, so they travel with the sigil. Size and Colour choose the kit model from the drum cube.'),
      kitOut, duckRow, scRow, tkRow, octRow, mdRow, flRow, ghRow);
    refresh();
  } });

  Sound.subscribe(refresh);
  Hooks.on('song', refresh);
  UI.whenReady(refresh);

  return { chordAt, rootAt, drumCell: SD.drumCell };
})();

if (typeof window !== 'undefined') window.DrumEngine = DrumEngine;