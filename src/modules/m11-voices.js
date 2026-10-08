/* ══════════════════════════════════════════════════════════════════════════
   M11 · SOUND (Part 1 compatibility layer)
   ----------------------------------------------------------------------------
   Keeps the Sound API that the panel (m12) and visualiser (m13) call:
     prepare, refresh, view, live, recentNotes, lastVowel, noteOn,
     set, setMany, reset, mutate, dream, code, library, setLite, …
   Timbre comes from the wavetable cells built from SoundDesign.tables().
   Knobs for tilt and density reshape the cells. Drum knobs reach the core
   through a 'kit' message. Other knobs are stored but not yet acted on.
   ══════════════════════════════════════════════════════════════════════════ */
   const Sound = (() => {
    'use strict';
    const NH = 32;
    const DEF = { tilt: 0, density: 1, kSub: 1, kPunch: 1, kDecay: 1, sBody: 1, sSnap: 1, hDecay: 1 };
    const cur = { ...DEF, ...Prefs.get('soundcur', {}) };
    const pref = { lite: (navigator.hardwareConcurrency || 4) <= 2, lensWave: true, vowelMemory: true, freeze: false, keys: false, ...Prefs.get('sound', {}) };
    const persist = () => { Prefs.set('soundcur', cur); Prefs.set('sound', pref); };
    const kit = () => ({ kSub: cur.kSub, kPunch: cur.kPunch, kDecay: cur.kDecay, sBody: cur.sBody, sSnap: cur.sSnap, hDecay: cur.hDecay });
    const ZERO = new Float32Array(256);
    let snap = null, timer = 0;
  
    /** Build the 16 geometry cells and the glottal source, then send them to the core. */
    function build() {
      const eng = app.engine, sig = app.sigil;
      if (!eng || !sig || typeof SoundDesign === 'undefined' || typeof SigilDSP === 'undefined') return;
      const tb = SoundDesign.tables(sig, 0), cells = [];
      const cut = Math.max(1, Math.round(cur.density * (NH - 1)));
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const c = tb.grid[y][x], re = new Float64Array(NH), im = new Float64Array(NH);
        for (let h = 1; h <= cut; h++) {
          const g = Math.pow(h, -cur.tilt);
          re[h] = (c.re[h] || 0) * g; im[h] = (c.im[h] || 0) * g;
        }
        cells.push(SigilDSP.buildMips(re, im, eng.sr));
      }
      const gre = new Float64Array(NH), gim = new Float64Array(NH);
      for (let h = 1; h < NH; h++) gre[h] = 1 / (h * h);
      const glot = SigilDSP.buildMips(gre, gim, eng.sr);
      eng.post({ cmd: 'cells', cells, glot });
      // Visual snapshot: one cell's first mip, sub-sampled for the scope.
      const t = cells[0][1], P = new Float32Array(256), crushed = new Float32Array(256);
      for (let i = 0; i < 256; i++) { P[i] = t[i * 4]; crushed[i] = Math.round(P[i] * 32) / 32; }
      const c0 = tb.grid[0][0], mags = new Float32Array(NH);
      for (let h = 1; h < NH; h++) mags[h] = Math.hypot(c0.re[h] || 0, c0.im[h] || 0);
      snap = { P, mags, ring: { clean: P, crushed } };
      eng.post({ cmd: 'kit', kit: kit() });
    }
  
    const Api = {
      prepare: (ctx) => (typeof Engine !== 'undefined' && Engine.prepare ? Engine.prepare(ctx) : Promise.resolve(false)),
      refresh() {
        clearTimeout(timer);
        timer = setTimeout(() => { try { build(); } catch (e) { console.error('[sound]', e); } }, 60);
      },
      /** Data for the scope and cube. Always returns arrays of the right shape. */
      view: () => snap || { P: ZERO, mags: new Float32Array(NH), ring: { clean: ZERO, crushed: ZERO } },
      /** The audible engine, if a sigil is playing. */
      live: () => (app.mode === 'playing' && app.engine ? app.engine : null),
      recentNotes: () => [],          // Part 2: event history from the core
      lastVowel: () => null,          // Part 2: vowel memory
      noteOn: (o) => (app.engine ? app.engine.noteOn(o) : null),
      get: (k) => cur[k],
      set(k, v) {
        cur[k] = v; persist();
        if (app.engine) app.engine.post({ cmd: 'kit', kit: kit() });
        if (k === 'tilt' || k === 'density') Api.refresh();
      },
      setMany(o) { Object.assign(cur, o); persist(); if (app.engine) app.engine.post({ cmd: 'kit', kit: kit() }); Api.refresh(); },
      reset() { Api.setMany({ ...DEF }); },
      mutate(amount = 0.15) {
        const o = {};
        o.tilt = clamp(cur.tilt + (Math.random() - 0.5) * amount * 2, -1, 1.5);
        o.density = clamp(cur.density + (Math.random() - 0.5) * amount, 0.25, 1);
        Api.setMany(o);
      },
      dream: () => Api.mutate(0.4),
      code: () => '',                 // Part 2: state codes
      library: () => [],              // Part 2: sound library
      setLite(v) { pref.lite = !!v; persist(); },
      setLensWave(v) { pref.lensWave = !!v; persist(); },
      setVowelMemory(v) { pref.vowelMemory = !!v; persist(); },
      toggleKeys() { pref.keys = !pref.keys; persist(); return pref.keys; },
      toggleFreeze() { pref.freeze = !pref.freeze; persist(); return pref.freeze; },
      setMode() {}, arcOn() {}, setArc() {}, sigilVerbOn() {}, setSigilVerb() {},   // Part 2
      pref,
    };
  
    Hooks.on('engineLoad', () => Api.refresh());
    Hooks.on('song', () => Api.refresh());
    return Api;
  })();
  window.Sound = Sound;