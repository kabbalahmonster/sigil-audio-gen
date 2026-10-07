'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m11 · VOICES — the sigil's synthesis engine (v2)
   --------------------------------------------------------------------------
   ROUTING
     Engine.play() offers every event to the 'voice' hook. Handled events
     return true. Legacy mode, and events this module does not own (bell,
     arp, choir in legacy), fall through.

   VOICES
     lead   wavetable (3D cell, morphing across the note) or vox (formants)
     harm   vox, quieter
     bass   single-frame wavetable, pluck filter
     pad    detuned single-frame wavetables, budgeted
     every pitched voice may carry a sub oscillator one octave down

   CHORUS & CRUSHER
     One stereo chorus and one AudioWorklet bit-crusher on the master
     chain, shared by every song. Their cost is constant, not per note.

   PERFORMANCE
     • MAX_VOICES budget. Pads drop first at 80%, then harms at 100%.
     • 3D cells are built lazily: at most nine PeriodicWave sets per context.
     • Lite mode (automatic on ≤2 cores): single-frame oscillators, no
       vibrato, no sub, no spectrum halo.
     • Evolve changes the worklet with scheduled automation, so each pass
       is timed to the score rather than to the clock.

   STATUS
     Sound.statusInfo() reports whether the crusher is live, and why not.
   ══════════════════════════════════════════════════════════════════════════ */

const Sound = (() => {
  'use strict';
  const SD = SoundDesign;
  const WORKLET_URL = 'src/audio/sigil-fx.worklet.js';
  const GLOTTAL = SD.glottal();
  const fxReady = new WeakSet();         // AudioContexts where the worklet module loaded
  const MAX_VOICES = 22;
  const NOTE_RING = 16;

  const prefs = {
    mode: Prefs.get('sound.mode', 'sigil'),
    lite: Prefs.get('sound.lite', (navigator.hardwareConcurrency || 4) <= 2),
    keys: false,
  };
  let bank = Prefs.get('soundbank', {});          // sigil key → { variant, o }
  let library = Prefs.get('soundlib', []);        // named override sets

  const cur = { key: null, variant: 0, o: {}, derived: null, P: null, tables: null, vol: null, mags: null, ring: null };
  const fxState = { fx: 'pending', reason: 'not loaded yet' };
  const notes = [];                               // recent onsets, for the visuals
  let pending = null;                             // a link's patch, waiting for its cast
  let lastVowel = null;
  const subs = new Set();
  const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error('[sound:ui]', e); } });
  const keyOf = (sig) => sig.fusionKey || sig.reduced;
  const lite = () => prefs.lite;
  const isLiveCtx = (ctx) => !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext);

  /* ── State ─────────────────────────────────────────────────────────────── */

  function persist() {
    if (!cur.key) return;
    if (!Object.keys(cur.o).length && !cur.variant) delete bank[cur.key];
    else bank[cur.key] = { variant: cur.variant, o: { ...cur.o } };
    Prefs.set('soundbank', bank);
  }

  function saveLibrary() { Prefs.set('soundlib', library); }

  /** The morph-position magnitude spectrum, for the crown. */
  function magnitudes(tb, pos) {
    const fr = tb.frames, n = fr.length;
    const p = clamp(pos, 0, n - 1), a = Math.floor(p), b = Math.min(n - 1, a + 1), w = p - a;
    const out = new Float32Array(SD.H);
    let mx = 1e-9;
    for (let h = 1; h <= SD.H; h++) {
      const m = (1 - w) * Math.hypot(fr[a].re[h], fr[a].im[h]) + w * Math.hypot(fr[b].re[h], fr[b].im[h]);
      out[h - 1] = m;
      if (m > mx) mx = m;
    }
    for (let i = 0; i < out.length; i++) out[i] /= mx;
    return out;
  }

  /** Recompute the effective patch: DNA < Aura < overrides. Called on cast, on knob change, and on dream. */
  function recompute() {
    const sig = app.sigil;
    if (!sig) return;
    cur.derived = { ...SD.derive(sig.hash, cur.variant), ...SD.derive2(sig.hash, cur.variant) };
    cur.P = { evolve: 0, ...cur.derived, ...(SD.AURAS[cur.o.aura] || {}), ...cur.o };
    cur.tables = SD.tables(sig, cur.variant);
    cur.vol = SD.volume(sig, cur.variant);
    cur.mags = magnitudes(cur.tables, cur.P.wave);

    // The display ring: the base morph position, shaped by this patch's fold and crush.
    const fr = cur.tables.frames, p = clamp(cur.P.wave, 0, fr.length - 1), a = Math.floor(p);
    const clean = SD.waveSamples(fr[a], fr[Math.min(fr.length - 1, a + 1)], p - a, 128);
    cur.ring = SD.shapeWave(clean, cur.P);
  }

  /** Adopt the patch for the sigil being cast, applying a waiting link patch if it matches. */
  function syncFrom(sig) {
    if (!sig) return;
    const key = keyOf(sig);
    if (key !== cur.key || !cur.P) {
      cur.key = key;
      const e = bank[key] || {};
      cur.variant = e.variant | 0;
      cur.o = { ...(e.o || {}) };
    }
    if (pending && pending.key === key) {
      cur.variant = pending.variant;
      cur.o = { ...pending.o };
      pending = null;
      persist();
    }
    recompute();
  }

  /* ── Worklet and master chain ──────────────────────────────────────────── */

  /** Load the bit-crusher module into a context. Must be awaited before Engine.load() in each context. */
  async function prepare(ctx) {
    if (fxReady.has(ctx)) return true;
    if (!ctx.audioWorklet || !window.AudioWorkletNode) {
      fxState.fx = 'bypassed';
      fxState.reason = window.isSecureContext
        ? 'this browser has no AudioWorklet'
        : 'AudioWorklet needs http://localhost or https (not file://)';
      return false;
    }
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      fxReady.add(ctx);
      return true;
    } catch (e) {
      fxState.fx = 'bypassed';
      fxState.reason = `could not load ${WORKLET_URL}: ${e.message}`;
      console.warn('[sound]', fxState.reason);
      return false;
    }
  }

  /**
   * Chain: mix → chorus (dry + stereo delayed wet) → target (crusher or tone).
   * The wet path has two delay lines with slow, slightly different LFOs, which
   * gives a lush, moving stereo width at almost no cost.
   */
  function buildChain(eng, target) {
    const c = eng.ctx;
    const chIn = c.createGain(), dry = c.createGain(), wet = c.createGain(), sum = c.createGain();
    const split = c.createChannelSplitter(2), merge = c.createChannelMerger(2);
    const dl = c.createDelay(0.05), dr = c.createDelay(0.05);
    dl.delayTime.value = 0.018;
    dr.delayTime.value = 0.024;

    const lfoL = c.createOscillator(), lfoR = c.createOscillator();
    const gL = c.createGain(), gR = c.createGain();
    lfoL.frequency.value = 0.31;
    lfoR.frequency.value = 0.43;
    gL.gain.value = 0.0035;
    gR.gain.value = 0.0035;
    lfoL.connect(gL); gL.connect(dl.delayTime);
    lfoR.connect(gR); gR.connect(dr.delayTime);
    lfoL.start(); lfoR.start();

    eng.mix.connect(chIn);
    chIn.connect(dry); dry.connect(sum);
    chIn.connect(split);
    split.connect(dl, 0); split.connect(dr, 1);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
    merge.connect(wet); wet.connect(sum);
    sum.connect(target);
    eng.chorus = { dry, wet };
  }

  /** Apply the current patch to the worklet and chorus now (click-free). */
  function pushFx(eng) {
    if (!eng || !cur.P) return;
    const P = cur.P, now = eng.ctx.currentTime;
    if (eng.sfx) {
      const p = eng.sfx.parameters;
      const to = (name, v) => p.get(name).setTargetAtTime(v, now, 0.03);
      to('bits', P.grit > 0 ? P.bits : 16);
      to('hold', P.hold);
      to('fold', P.fold);
      to('mix', P.grit);
    }
    if (eng.chorus) {
      eng.chorus.wet.gain.setTargetAtTime(P.chorus * 0.7, now, 0.05);
      eng.chorus.dry.gain.setTargetAtTime(1 - P.chorus * 0.35, now, 0.05);
    }
    if (eng.delayReturn) eng.delayReturn.gain.setTargetAtTime(0.2 + P.echo * 0.6, now, 0.05);
  }

  /**
   * The same fx values, but scheduled at a given time. This is how evolve
   * changes the crusher in sync with the score, because events are booked
   * ahead of their sound.
   */
  function scheduleFx(eng, P, t) {
    if (eng.sfx) {
      const p = eng.sfx.parameters;
      p.get('bits').setValueAtTime(P.grit > 0 ? P.bits : 16, t);
      p.get('hold').setValueAtTime(P.hold, t);
      p.get('fold').setValueAtTime(P.fold, t);
      p.get('mix').setValueAtTime(P.grit, t);
    }
    if (eng.chorus) {
      eng.chorus.wet.gain.setValueAtTime(P.chorus * 0.7, t);
      eng.chorus.dry.gain.setValueAtTime(1 - P.chorus * 0.35, t);
    }
  }

  /**
   * Called from the Engine's 'buses' hook on every load. Builds the analyser,
   * the chorus, and the crusher, once per engine. Rebuilds the 3D wave cache
   * when the sigil or dream changes.
   */
  function attach(eng) {
    syncFrom(app.sigil);
    const live = isLiveCtx(eng.ctx);

    if (!eng.sound) {
      eng.sound = true;
      eng.analyser = eng.ctx.createAnalyser();
      eng.analyser.fftSize = 512;
      eng.analyser.smoothingTimeConstant = 0.72;
      eng.out.connect(eng.analyser);

      eng.mix.disconnect(eng.tone);
      let target = eng.tone;
      if (fxReady.has(eng.ctx)) {
        try {
          const sfx = new AudioWorkletNode(eng.ctx, 'sigil-fx', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          });
          sfx.connect(eng.tone);
          eng.sfx = sfx;
          target = sfx;
          if (live) { fxState.fx = 'live'; fxState.reason = ''; }
        } catch (e) {
          if (live) { fxState.fx = 'bypassed'; fxState.reason = e.message; }
        }
      } else if (live && fxState.fx === 'pending') {
        fxState.fx = 'bypassed';
        fxState.reason = 'worklet not loaded for this context';
      }
      buildChain(eng, target);
    }

    if (eng.volOf !== cur.vol) { eng.volWaves = {}; eng.volOf = cur.vol; }
    if (!eng.glottalWave) eng.glottalWave = eng.ctx.createPeriodicWave(GLOTTAL.re, GLOTTAL.im);
    eng.fxPass = undefined;
    pushFx(eng);
  }

  /* ── Voice building blocks ─────────────────────────────────────────────── */

  /** Shape the amplitude. Scored notes use an ADSR and return an end time. Held notes sustain. */
  function shape(eng, amp, t, d, peak, hold) {
    if (hold) {
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(peak, t + 0.012);
      amp.gain.setTargetAtTime(peak * 0.8, t + 0.012, 0.25);
      return null;
    }
    return eng.adsr(amp.gain, t, d, { a: 0.012, d: 0.25, s: 0.78, r: 0.22, peak });
  }

  /**
   * Start the nodes and schedule their stop. Scored notes stop at `end`.
   * Held notes return release(), which fades and stops.
   */
  function schedule(ctx, nodes, t, end, hold, amp) {
    nodes.forEach((n) => n.start(t));
    if (!hold) {
      nodes.forEach((n) => n.stop(end));
      return { release() {} };
    }
    return {
      release() {
        const now = ctx.currentTime;
        amp.gain.cancelScheduledValues(now);
        amp.gain.setValueAtTime(amp.gain.value, now);
        amp.gain.setTargetAtTime(0, now, 0.06);
        nodes.forEach((n) => n.stop(now + 0.4));
      },
    };
  }

  /** A slow LFO on one or more frequency params. */
  function vibrato(ctx, t, d, targets, depthHz) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(depthHz, t + Math.min(0.6, d * 0.6));
    lfo.connect(g);
    targets.forEach((o) => g.connect(o.frequency));
    return lfo;
  }

  /**
   * The PeriodicWave set for the 3D cell a note addresses. Created lazily, so
   * each context builds only the cells it actually uses.
   */
  function waveSet(eng, P, deg) {
    const { yi, zi } = SD.address(P, deg);
    const k = yi * 3 + zi;
    if (!eng.volWaves[k]) {
      eng.volWaves[k] = eng.volOf.cells[yi][zi].map((f) => eng.ctx.createPeriodicWave(f.re, f.im));
    }
    lastAddr = { yi, zi };
    return eng.volWaves[k];
  }
  let lastAddr = { yi: 0, zi: 2 };

  /** One pitched wave with a lowpass, crossfading from frame A to B across the note. */
  function waveCore(eng, W, { midi, from, t, d, P, detune = 0, bright = P.bright, single = false }) {
    const ctx = eng.ctx, f = mtof(midi), N = W.length;
    const fa = clamp(Math.round(P.wave), 0, N - 1);
    const fb = clamp(Math.round(P.wave + P.sweep * 4), 0, N - 1);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    const c0 = f * (1.5 + 9 * bright);
    lp.frequency.setValueAtTime(c0, t);
    lp.frequency.setTargetAtTime(c0 * 0.4, t + 0.02, Math.max(0.05, d * 0.3));

    const frames = single || lite() ? [[fa, 1]] : [[fa, 1], [fb, 0]];
    const oscs = [];
    for (const [idx, g0] of frames) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(W[idx]);
      o.detune.value = detune;
      o.frequency.setValueAtTime(from != null ? mtof(from) : f, t);
      if (from != null) o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(g0, t);
      if (frames.length > 1) g.gain.linearRampToValueAtTime(1 - g0, t + d);
      o.connect(g);
      g.connect(lp);
      oscs.push(o);
    }
    return { out: lp, oscs };
  }

  /** The sub: a sine one octave below, following the note's glide. Skipped in lite mode. */
  function addSub(eng, ev, t, P, amp, nodes) {
    if (lite() || !(P.sub > 0.01)) return;
    const ctx = eng.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    const f = mtof(ev.midi) / 2;
    o.type = 'sine';
    o.frequency.setValueAtTime(ev.from != null ? mtof(ev.from) / 2 : f, t);
    if (ev.from != null) o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    g.gain.value = P.sub * 0.6;
    o.connect(g);
    g.connect(amp);
    nodes.push(o);
  }

  /* ── Voices ────────────────────────────────────────────────────────────── */

  function voiceWave(eng, ev, t, P, bus, hold, opt = {}) {
    const ctx = eng.ctx, d = hold ? 3 : ev.dur * eng.spb;
    const W = waveSet(eng, P, ev.deg);
    const core = waveCore(eng, W, {
      midi: ev.midi, from: ev.from, t, d, P,
      bright: opt.bright ?? P.bright, single: opt.single,
    });
    const amp = ctx.createGain();
    core.out.connect(amp);
    amp.connect(bus);

    const nodes = core.oscs.slice();
    if (!hold && ev.type === 'lead' && d > 0.45 && !lite()) {
      nodes.push(vibrato(ctx, t, d, core.oscs, mtof(ev.midi) * 0.004));
    }
    if (opt.sub !== false) addSub(eng, ev, t, P, amp, nodes);

    const end = shape(eng, amp, t, d, ev.vel * (opt.peak ?? 0.34), hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /** Formant voice: glottal source, four formants morphing between vowels, breath under it. */
  function voiceVox(eng, ev, t, P, bus, hold, opt = {}) {
    const ctx = eng.ctx, f = mtof(ev.midi), d = hold ? 3 : ev.dur * eng.spb;

    const src = ctx.createOscillator();
    src.setPeriodicWave(eng.glottalWave);
    src.frequency.setValueAtTime(ev.from != null ? mtof(ev.from) : f, t);
    if (ev.from != null) src.frequency.exponentialRampToValueAtTime(f, t + 0.08);

    const nodes = [src];
    if (!hold && !lite()) nodes.push(vibrato(ctx, t, d, [src], f * 0.006));

    // The melody chooses the vowel, and higher degrees drift through the chart.
    const deg = ev.deg ?? 0;
    const i0 = mod(deg + P.vowel, 5);
    const i1 = d > 0.6 ? mod(i0 + 1, 5) : i0;
    const V0 = SD.VOWELS[i0], V1 = SD.VOWELS[i1];
    const tk = Math.pow(2, P.throat * 0.35);
    const morph = t + Math.min(d * 0.9, 0.7);

    const sum = ctx.createGain();
    sum.gain.value = 0.7 + 0.4 * P.bright;
    for (let i = 0; i < 4; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 6 + 7 * P.bright;
      bp.frequency.setValueAtTime(V0.f[i] * tk, t);
      bp.frequency.linearRampToValueAtTime(V1.f[i] * tk, morph);
      const g = ctx.createGain();
      g.gain.value = V0.g[i];
      src.connect(bp);
      bp.connect(g);
      g.connect(sum);
    }

    const amp = ctx.createGain();
    sum.connect(amp);
    amp.connect(bus);

    if (P.breath > 0.01) {
      const br = ctx.createBufferSource();
      br.buffer = eng.noiseBuf;
      br.loop = true;
      const bf = ctx.createBiquadFilter();
      bf.type = 'bandpass';
      bf.frequency.value = 3200 * tk;
      bf.Q.value = 0.9;
      const bg = ctx.createGain();
      const bl = P.breath * 0.06 * ev.vel;
      bg.gain.setValueAtTime(0, t);
      bg.gain.linearRampToValueAtTime(bl, t + 0.04);
      bg.gain.linearRampToValueAtTime(bl * 0.4, t + d);
      br.connect(bf);
      bf.connect(bg);
      bg.connect(amp);
      nodes.push(br);
    }

    if (opt.sub !== false) addSub(eng, ev, t, P, amp, nodes);

    lastVowel = { name: V0.name, at: performance.now() };
    const end = shape(eng, amp, t, d, ev.vel * 0.42 * (ev.type === 'harm' ? 0.7 : 1), hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /** Pad: detuned single-frame waves. Budgeted in the hook. */
  function voicePad(eng, ev, t, P, bus, hold) {
    const ctx = eng.ctx, d = hold ? 3 : ev.dur * eng.spb;
    const W = waveSet(eng, P, ev.deg);
    const mix = ctx.createGain(), amp = ctx.createGain();
    mix.connect(amp);
    amp.connect(bus);

    const nodes = [];
    for (const m of ev.midis) {
      for (const dt of [-6, 6]) {
        const core = waveCore(eng, W, { midi: m, t, d, P, detune: dt, bright: P.bright * 0.6, single: true });
        core.out.connect(mix);
        nodes.push(...core.oscs);
      }
    }
    const end = shape(eng, amp, t, d, ev.vel * 0.05, hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /* ── Budget ─────────────────────────────────────────────────────────────── */

  /** Voices still sounding at time `now`. Pruned as it counts. */
  function countVoices(eng, now) {
    const list = eng.voiceEnds || (eng.voiceEnds = []);
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] < now) list.splice(i, 1);
      else n++;
    }
    return n;
  }

  function noteEvent(ev) {
    notes.push({ beat: ev.beat, deg: ev.deg ?? 0, kind: ev.type, at: performance.now() });
    if (notes.length > NOTE_RING) notes.shift();
  }

  /* ── The hook ──────────────────────────────────────────────────────────── */

  /**
   * Engine.play() calls this for every event.
   * Resolves the pass (offline events carry it; live uses the loop index),
   * evolves the patch, schedules any per-pass fx change, applies the budget,
   * then renders the event.
   */
  function voiceHook(_, ev, t, eng) {
    if (prefs.mode !== 'sigil' || !eng.buses || !eng.volOf || !cur.P) return null;
    if (!(ev.type === 'lead' || ev.type === 'harm' || ev.type === 'bass' || ev.type === 'pad')) return null;

    const pass = ev.pass ?? eng.loopIndex ?? 0;
    const passes = ev.passes ?? 4;
    const progress = eng.song ? ev.beat / eng.song.total : 0;
    const P = SD.evolve(cur.P, pass, passes, progress, cur.P.evolve || 0);

    if (eng.fxPass !== pass) {                 // once per pass, scheduled in score time
      eng.fxPass = pass;
      scheduleFx(eng, P, t);
    }

    const dur = (ev.dur || 0.5) * eng.spb;
    const active = countVoices(eng, t);
    if (ev.type === 'pad' && active > MAX_VOICES * 0.8) return true;
    if (ev.type === 'harm' && active > MAX_VOICES) return true;
    (eng.voiceEnds || (eng.voiceEnds = [])).push(t + dur + 0.35);
    noteEvent(ev);

    if (ev.type === 'lead') {
      const vox = P.voice === 'vox' || (P.voice === 'auto' && ev.timbre === 'reed');
      if (vox) { voiceVox(eng, ev, t, P, eng.buses.lead, false); lastVowel.at = performance.now(); }
      else voiceWave(eng, ev, t, P, eng.buses.lead, false);
    } else if (ev.type === 'harm') {
      voiceVox(eng, ev, t, P, eng.buses.harm, false, { sub: false });
    } else if (ev.type === 'bass') {
      voiceWave(eng, ev, t, P, eng.buses.bass, false, { bright: 0.18, single: true, peak: 0.42, sub: false });
    } else {
      voicePad(eng, ev, t, P, eng.buses.pad, false);
    }
    return true;
  }

  /* ── Keyboard and letter playing ───────────────────────────────────────── */

  const live = () => (app.engine && app.sigil && app.engine.volOf ? app.engine : null);

  function playBus(eng) {
    if (!eng.playBus) {
      const g = eng.gain(0.9), send = eng.gain(0.35);
      g.connect(eng.mix);
      g.connect(send);
      send.connect(eng.reverb);
      eng.playBus = g;
    }
    return eng.playBus;
  }

  /** Hold a note until release(). Returns null if the engine is not running. */
  function noteOn({ midi, deg = 0, vel = 0.8 }) {
    const eng = live();
    if (!eng || !cur.P || eng.ctx.state !== 'running') return null;
    const P = cur.P, t = eng.ctx.currentTime, bus = playBus(eng);
    const ev = { type: 'lead', midi, deg, vel, timbre: 'glass' };
    if (!eng.volWaves) return null;
    if (P.voice === 'vox') return voiceVox(eng, ev, t, P, bus, true);
    return voiceWave(eng, ev, t, P, bus, true);
  }

  /* ── Hooks ─────────────────────────────────────────────────────────────── */

  Hooks.on('buses', (_buses, eng) => attach(eng));
  Hooks.on('voice', voiceHook, 0);

  Hooks.on('link', (link) => {
    const d = link.sound ? SD.decodePatch(link.sound) : null;
    pending = d ? { key: link.members.join('+'), ...d } : null;
  });

  Hooks.on('shareKey', (key, sig) => {
    if (!sig || keyOf(sig) !== cur.key) return undefined;
    const code = SD.encodePatch(cur.o, cur.variant);
    return code ? key + '!' + code : undefined;
  }, 20);

  Hooks.on('forget', (sig) => {
    if (!sig) return;
    delete bank[keyOf(sig)];
    Prefs.set('soundbank', bank);
  });

  /* ── Public API ────────────────────────────────────────────────────────── */

  const api = {
    SD,
    prepare, attach, noteOn,
    view: () => cur,                                        // read-only, for per-frame visuals
    state: () => ({ key: cur.key, variant: cur.variant, o: cur.o, P: cur.P, derived: cur.derived, tables: cur.tables, mags: cur.mags, ring: cur.ring }),
    statusInfo: () => ({
      fx: fxState.fx, reason: fxState.reason, mode: prefs.mode, lite: prefs.lite,
      voices: app.engine && app.engine.voiceEnds ? app.engine.voiceEnds.length : 0,
      max: MAX_VOICES, aura: cur.o.aura || 'none', chorus: cur.P ? cur.P.chorus : 0,
    }),
    recentNotes: () => notes,
    lastVowel: () => lastVowel,
    lastCell: () => lastAddr,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get mode() { return prefs.mode; },
    get lite() { return prefs.lite; },
    get keysOn() { return prefs.keys; },
    live,

    setMode(m) { prefs.mode = m; Prefs.set('sound.mode', m); notify(); },
    setLite(v) { prefs.lite = !!v; Prefs.set('sound.lite', prefs.lite); notify(); },
    toggleKeys(force) { prefs.keys = force ?? !prefs.keys; notify(); return prefs.keys; },

    /** Set one knob or choice. Overrides are saved per sigil. */
    set(name, v) {
      if (!app.sigil) return;
      cur.o[name] = v;
      persist(); recompute(); pushFx(app.engine); notify();
    },
    setAura(name) {
      if (!app.sigil) return;
      if (name === 'none') delete cur.o.aura; else cur.o.aura = name;
      persist(); recompute(); pushFx(app.engine); notify();
    },
    reset() { cur.o = {}; persist(); recompute(); pushFx(app.engine); notify(); },
    /** Step through deterministic dream variants. Tuned overrides are kept. */
    dream(delta) {
      if (!app.sigil) return;
      cur.variant = mod(cur.variant + delta, 100);
      persist(); recompute();
      if (app.engine && app.engine.volOf) attach(app.engine);
      notify();
    },
    code: () => SD.encodePatch(cur.o, cur.variant),
    forgetKey(key) { delete bank[key]; Prefs.set('soundbank', bank); },

    library: () => library.slice(),
    save(name) {
      library.push({ name: String(name).slice(0, 40), o: { ...cur.o } });
      saveLibrary(); notify();
    },
    applyLibrary(i) {
      const it = library[i];
      if (!it || !app.sigil) return;
      cur.o = { ...it.o };
      persist(); recompute(); pushFx(app.engine); notify();
    },
    removeLibrary(i) { library.splice(i, 1); saveLibrary(); notify(); },
    importLibrary(data) {
      const list = Array.isArray(data) ? data : (data && data.patches) || [];
      let n = 0;
      for (const it of list) {
        const d = it && SD.decodePatch(SD.encodePatch(it.o || {}, 0));
        if (d && it.name) { library.push({ name: String(it.name).slice(0, 40), o: d.o }); n++; }
      }
      saveLibrary(); notify();
      return n;
    },
  };

  return api;
})();

window.Sound = Sound;   // for the console and for debugging; code uses the global binding directly