'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m11 · VOICES — the sigil's own synthesis
   --------------------------------------------------------------------------
   ROUTING
     Engine.play() offers every event to the 'voice' hook first (see the
     extension point in 06-engine.js). If this module handles it, it returns
     true and the legacy voice is skipped. Legacy mode returns null at once.

   VOICES
     wave   two PeriodicWave oscillators crossfading across the note (the morph)
     vox    glottal source through four formant bandpasses, vowel morphing
     pad    several detuned single-frame wave voices
     bass   single-frame wave through a pluck filter

   PERFORMANCE
     • Wavetables are built once per sigil (9 frames). PeriodicWave objects are
       built once per AudioContext.
     • Lite mode (automatic on ≤2 cores) uses single-frame oscillators and no
       vibrato, and the visuals skip the spectrum halo.

   PATCH STATE
     cur.P = derived DNA (05b) merged with the user's overrides for this sigil.
     Overrides are saved per sigil in the bank, and travel in share links.
   ══════════════════════════════════════════════════════════════════════════ */

const Sound = (() => {
  'use strict';
  const SD = SoundDesign;
  const WORKLET_URL = 'src/audio/sigil-fx.worklet.js';
  const GLOTTAL = SD.glottal();
  const fxReady = new WeakSet();                 // AudioContexts where the worklet loaded

  const prefs = {
    mode: Prefs.get('sound.mode', 'sigil'),      // 'sigil' | 'legacy'
    lite: Prefs.get('sound.lite', (navigator.hardwareConcurrency || 4) <= 2),
    keys: false,
  };
  let bank = Prefs.get('soundbank', {});         // sigil key → { variant, o }
  let library = Prefs.get('soundlib', []);       // named override sets
  const cur = { key: null, variant: 0, o: {}, derived: null, P: null, tables: null, mags: null };
  let pending = null;                            // a patch from a shared link, awaiting its cast
  let lastVowel = null;
  const subs = new Set();
  const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error('[sound:ui]', e); } });
  const keyOf = (sig) => sig.fusionKey || sig.reduced;
  const lite = () => prefs.lite;

  /* ── State ───────────────────────────────────────────────────────────── */

  function persist() {
    if (!cur.key) return;
    if (!Object.keys(cur.o).length && !cur.variant) delete bank[cur.key];
    else bank[cur.key] = { variant: cur.variant, o: { ...cur.o } };
    Prefs.set('soundbank', bank);
  }

  function saveLibrary() { Prefs.set('soundlib', library); }

  /** Blend the two morph frames around `pos` into a magnitude spectrum for the crown. */
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

  /** Recompute the effective patch from the sigil, dream variant and overrides. */
  function recompute() {
    const sig = app.sigil;
    if (!sig) return;
    cur.derived = SD.derive(sig.hash, cur.variant);
    cur.P = { ...cur.derived, ...cur.o };
    cur.tables = SD.tables(sig, cur.variant);
    cur.mags = magnitudes(cur.tables, cur.P.wave);
  }

  /** Bring the patch in line with the sigil being cast. Applies a pending link patch if one matches. */
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

  /** Push the current patch into the live worklet and the echo return. Click-free via setTargetAtTime. */
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
    if (eng.delayReturn) eng.delayReturn.gain.setTargetAtTime(0.2 + P.echo * 0.6, now, 0.05);
  }

  /* ── Engine attachment ───────────────────────────────────────────────── */

  /**
   * Called from the Engine's 'buses' hook on every load. Creates the analyser
   * and the bit-crusher once per engine, splices the crusher into the master
   * chain, and builds PeriodicWaves for the current tables.
   */
  function attach(eng) {
    syncFrom(app.sigil);
    if (!eng.sound) {
      eng.sound = true;
      eng.analyser = eng.ctx.createAnalyser();
      eng.analyser.fftSize = 512;                // 256 bins: enough for the halo, cheap to read
      eng.analyser.smoothingTimeConstant = 0.72;
      eng.out.connect(eng.analyser);

      if (fxReady.has(eng.ctx)) {
        try {
          eng.sfx = new AudioWorkletNode(eng.ctx, 'sigil-fx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          eng.mix.disconnect(eng.tone);          // mix → crusher → tone
          eng.mix.connect(eng.sfx);
          eng.sfx.connect(eng.tone);
        } catch (e) { console.warn('[sound] crusher not attached:', e.message); }
      }
    }
    if (eng.wavesOf !== cur.tables) {
      eng.waves = cur.tables.frames.map((f) => eng.ctx.createPeriodicWave(f.re, f.im));
      eng.glottalWave = eng.glottalWave || eng.ctx.createPeriodicWave(GLOTTAL.re, GLOTTAL.im);
      eng.wavesOf = cur.tables;
    }
    pushFx(eng);
  }

  /**
   * Load the worklet into a context. Must be awaited before Engine.load() in
   * every context (live, and each offline render segment). Failure is graceful:
   * the crusher is bypassed and everything else still works.
   */
  async function prepare(ctx) {
    if (fxReady.has(ctx)) return true;
    if (!ctx.audioWorklet || !window.AudioWorkletNode) return false;
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      fxReady.add(ctx);
      return true;
    } catch (e) {
      console.warn('[sound] AudioWorklet unavailable (bit-crusher bypassed):', e.message);
      return false;
    }
  }

  /* ── Envelope and lifecycle helpers ──────────────────────────────────── */

  /** Shape the amplitude. Scored notes use the ADSR (returns an end time). Held notes sustain until released. */
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
   * Start a voice's nodes and schedule their stop. Scored notes stop at `end`.
   * Held notes return a release() that fades the amplitude and then stops.
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

  /** A slow LFO into one or more frequency params. Disabled in lite mode. */
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

  /* ── The wavetable core ──────────────────────────────────────────────── */

  /**
   * One pitched wave voice with a lowpass. It crossfades from frame A
   * (the start of the morph) to frame B across the note. In single-frame or
   * lite mode it holds one frame.
   */
  function waveCore(eng, { midi, from, t, d, P, detune = 0, bright = P.bright, single = false }) {
    const ctx = eng.ctx, f = mtof(midi), N = eng.waves.length;
    const fa = clamp(Math.round(P.wave), 0, N - 1);
    const fb = clamp(Math.round(P.wave + P.sweep * 4), 0, N - 1);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    const c0 = f * (1.5 + 9 * bright);
    lp.frequency.setValueAtTime(c0, t);
    lp.frequency.setTargetAtTime(c0 * 0.4, t + 0.02, Math.max(0.05, d * 0.3));   // pluck, then settle

    const frames = single || lite() ? [[fa, 1]] : [[fa, 1], [fb, 0]];
    const oscs = [];
    for (const [idx, g0] of frames) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(eng.waves[idx]);
      o.detune.value = detune;
      o.frequency.setValueAtTime(from != null ? mtof(from) : f, t);
      if (from != null) o.frequency.exponentialRampToValueAtTime(f, t + 0.08);   // legato glide
      const g = ctx.createGain();
      g.gain.setValueAtTime(g0, t);
      if (frames.length > 1) g.gain.linearRampToValueAtTime(1 - g0, t + d);      // the morph
      o.connect(g);
      g.connect(lp);
      oscs.push(o);
    }
    return { out: lp, oscs };
  }

  /* ── Voices ──────────────────────────────────────────────────────────── */

  /** Lead or bass wavetable voice. */
  function voiceWave(eng, ev, t, P, bus, hold, opt = {}) {
    const ctx = eng.ctx, d = hold ? 3 : ev.dur * eng.spb;
    const core = waveCore(eng, {
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
    const end = shape(eng, amp, t, d, ev.vel * (opt.peak ?? 0.34), hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /**
   * Formant voice. A glottal pulse train passes through four bandpass formants
   * that morph from the vowel chosen by the note's degree to the next vowel.
   * Breath noise sits beneath it.
   */
  function voiceVox(eng, ev, t, P, bus, hold) {
    const ctx = eng.ctx, f = mtof(ev.midi), d = hold ? 3 : ev.dur * eng.spb;

    const src = ctx.createOscillator();
    src.setPeriodicWave(eng.glottalWave);
    src.frequency.setValueAtTime(ev.from != null ? mtof(ev.from) : f, t);
    if (ev.from != null) src.frequency.exponentialRampToValueAtTime(f, t + 0.08);

    const nodes = [src];
    if (!hold && !lite()) nodes.push(vibrato(ctx, t, d, [src], f * 0.006));

    // The melody chooses the vowel. Higher degrees drift through the vowel chart.
    const deg = ev.deg ?? 0;
    const i0 = mod(deg + P.vowel, 5);
    const i1 = d > 0.6 ? mod(i0 + 1, 5) : i0;
    const V0 = SD.VOWELS[i0], V1 = SD.VOWELS[i1];
    const tk = Math.pow(2, P.throat * 0.35);       // throat: roughly ±¼ octave of formant shift
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

    lastVowel = { name: V0.name, at: performance.now() };   // read by the visuals
    const end = shape(eng, amp, t, d, ev.vel * 0.42 * (ev.type === 'harm' ? 0.7 : 1), hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /** Pad: several detuned single-frame waves for a slow, wide chord. */
  function voicePad(eng, ev, t, P, bus, hold) {
    const ctx = eng.ctx, d = hold ? 3 : ev.dur * eng.spb;
    const mix = ctx.createGain(), amp = ctx.createGain();
    mix.connect(amp);
    amp.connect(bus);

    const nodes = [];
    for (const m of ev.midis) {
      for (const dt of [-6, 6]) {
        const core = waveCore(eng, { midi: m, t, d, P, detune: dt, bright: P.bright * 0.6, single: true });
        core.out.connect(mix);
        nodes.push(...core.oscs);
      }
    }
    const end = shape(eng, amp, t, d, ev.vel * 0.05, hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /* ── Hooks and public entry points ───────────────────────────────────── */

  /**
   * The 'voice' hook. Engine.play() calls it for every event. Returns true when
   * this module rendered the event, and null to fall through to the legacy voice.
   */
  function voiceHook(_, ev, t, eng) {
    if (prefs.mode !== 'sigil' || !eng.waves || !eng.buses || !cur.P) return null;
    const P = cur.P;

    if (ev.type === 'lead') {
      const vox = P.voice === 'vox' || (P.voice === 'auto' && ev.timbre === 'reed');
      (vox ? voiceVox : voiceWave)(eng, ev, t, P, eng.buses.lead, false);
    } else if (ev.type === 'harm') {
      voiceVox(eng, ev, t, P, eng.buses.harm, false);
    } else if (ev.type === 'bass') {
      voiceWave(eng, ev, t, P, eng.buses.bass, false, { bright: 0.18, single: true, peak: 0.42 });
    } else if (ev.type === 'pad') {
      voicePad(eng, ev, t, P, eng.buses.pad, false);
    } else {
      return null;
    }
    return true;
  }

  /** Live engine only, and only when a sigil is loaded. Returns null otherwise. */
  const live = () => (app.engine && app.sigil && app.engine.waves ? app.engine : null);

  /** A small bus for played notes, so they bypass the score's mixer but keep the room. */
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

  /**
   * Play a note now, held until released. Used by the keyboard and by clicks on
   * the wheel's letters. Returns { release() }, or null if nothing is playing.
   */
  function noteOn({ midi, deg = 0, vel = 0.8 }) {
    const eng = live();
    if (!eng || !cur.P || eng.ctx.state !== 'running') return null;
    const P = cur.P, t = eng.ctx.currentTime, bus = playBus(eng);
    const ev = { type: 'lead', midi, deg, vel, timbre: 'glass' };
    return P.voice === 'vox'
      ? voiceVox(eng, ev, t, P, bus, true)
      : voiceWave(eng, ev, t, P, bus, true);
  }

  Hooks.on('buses', (_buses, eng) => attach(eng));
  Hooks.on('voice', voiceHook, 0);

  // A link may carry a patch code after '!'. Hold it until its sigil is cast.
  Hooks.on('link', (link) => {
    const d = link.sound ? SD.decodePatch(link.sound) : null;
    pending = d ? { key: link.members.join('+'), ...d } : null;
  });

  // Share links: key ~mood !patch. Priority 20 runs after the mood suffix.
  Hooks.on('shareKey', (key, sig) => {
    if (!sig || keyOf(sig) !== cur.key) return undefined;
    const code = SD.encodePatch(cur.o, cur.variant);
    return code ? key + '!' + code : undefined;
  }, 20);

  // Forgetting a sigil forgets its tuning too.
  Hooks.on('forget', (sig) => {
    if (!sig) return;
    delete bank[keyOf(sig)];
    Prefs.set('soundbank', bank);
  });

  /* ── Public API (used by m12 and m13) ────────────────────────────────── */

  return {
    SD,
    prepare, attach, noteOn,
    /** Read-only view for the visuals, which run every frame. No allocation. */
    view: () => cur,
    state: () => ({ key: cur.key, variant: cur.variant, o: cur.o, P: cur.P, derived: cur.derived, tables: cur.tables, mags: cur.mags }),
    get mode() { return prefs.mode; },
    get lite() { return prefs.lite; },
    get keysOn() { return prefs.keys; },
    live,
    lastVowel: () => lastVowel,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    setMode(m) { prefs.mode = m; Prefs.set('sound.mode', m); notify(); },
    setLite(v) { prefs.lite = !!v; Prefs.set('sound.lite', prefs.lite); notify(); },
    toggleKeys(force) { prefs.keys = force ?? !prefs.keys; notify(); return prefs.keys; },

    /** Set one knob. Overrides are kept per sigil and saved. */
    set(name, v) {
      if (!app.sigil) return;
      cur.o[name] = v;
      persist(); recompute(); pushFx(app.engine); notify();
    },
    reset() {
      cur.o = {}; persist(); recompute(); pushFx(app.engine); notify();
    },
    /** Step through deterministic dream variants. Tuned knobs are kept. */
    dream(delta) {
      if (!app.sigil) return;
      cur.variant = mod(cur.variant + delta, 100);
      persist(); recompute();
      if (app.engine && app.engine.waves) attach(app.engine);
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
    /** Imported entries are re-encoded and decoded, which clamps them to safe ranges. */
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
})();