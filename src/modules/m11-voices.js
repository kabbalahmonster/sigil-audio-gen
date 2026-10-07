'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m11 · VOICES v3
   --------------------------------------------------------------------------
   PATCH LAYERS   derived DNA ◂ mood suggestion ◂ user knobs
                  then per section: blended by the Story strength
   ROUTING        'voice' hook. Return true when handled, undefined otherwise.
                  (null would cancel a later listener's true. Never return null.)
   VOICES         wave (cube travel + sub), vox (formants + breath), pad
                  Drums live in m15 (priority 10).
   FX             bus chorus (one per engine), worklet crusher, geometric reverb
   BUDGET         live only. Offline contexts schedule at currentTime 0, so the
                  budget is skipped there.
   ══════════════════════════════════════════════════════════════════════════ */

const Sound = (() => {
  'use strict';
  const SD = SoundDesign;
  const WORKLET_URL = 'src/audio/sigil-fx.worklet.js';
  const GLOTTAL = SD.glottal();
  const fxReady = new WeakSet();
  const VOICE_BUDGET = 34;

  const prefs = {
    mode: Prefs.get('sound.mode', 'sigil'),
    lite: Prefs.get('sound.lite', (navigator.hardwareConcurrency || 4) <= 2),
    lensWave: Prefs.get('sound.lensWave', false),
    vowelMemory: Prefs.get('sound.vowelMemory', true),
    story: Prefs.get('sound.story', 0.7),
    keys: false,
  };

  let bank = Prefs.get('soundbank', {});
  let library = Prefs.get('soundlib', []);
  const cur = { key: null, variant: 0, o: {}, base: null, P: null, tables: null, mags: null, mesh: null, mut: 0 };
  let renderSpec = null, pending = null, lastVowel = null, frozen = false, vowelMemory = null;
  const subs = new Set();
  const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error('[sound:ui]', e); } });
  const keyOf = (sig) => sig.fusionKey || sig.reduced;
  const lite = () => prefs.lite;
  const isOffline = (ctx) => ctx.constructor && ctx.constructor.name === 'OfflineAudioContext';

  /* ── Section automation presets. Written into the plan (music is unchanged). */
  const SECTION_SOUND = {
    intro:   { grit: 0, drive: 0, fold: 0, chorus: 0.2, sub: 0.25, bright: 0.45, drums: 0 },
    verse1:  { layer: 0, grit: 0, drive: 0, fold: 0, chorus: 0.25, bits: 16, bright: 0.55 },
    chorus1: { bright: 0.92, chorus: 0.7, sub: 0.6, drumX: 0.75, drumY: 0.8, echo: 0.45 },
    verse2:  { layer: 2, fold: 0.3, drumY: 0.3, chorus: 0.35, drive: 0.1 },
    bridge:  { grit: 0.55, bits: 6, hold: 3, drive: 0.3, layer: 4, drumX: 0.2, echo: 0.7 },
    chorus2: { bright: 1, chorus: 0.9, sub: 0.8, grit: 0.15, bits: 12, drumX: 1, drumY: 1, echo: 0.4 },
    outro:   { grit: 0.9, bits: 4, hold: 8, echo: 0.9, bright: 0.2, drive: 0.2, drumX: 0.1 },
  };
  Hooks.on('plan', (plan) => {
    for (const s of plan) {
      const p = SECTION_SOUND[s.id];
      if (p) s.sound = { ...p, ...(s.sound || {}) };
    }
  }, 70);

  /* ── Voice budget (live only) ────────────────────────────────────────── */
  let endTimes = [];
  function takeVoice(ctx, end) {
    if (isOffline(ctx)) return 0;
    const now = ctx.currentTime;
    if (endTimes.length > 8) endTimes = endTimes.filter((t) => t > now);
    endTimes.push(end || now + 1);
    return endTimes.length;
  }
  const leaning = (n) => lite() || n > VOICE_BUDGET;

  /* ── State ───────────────────────────────────────────────────────────── */

  function persist() {
    if (!cur.key) return;
    if (!Object.keys(cur.o).length && !cur.variant) delete bank[cur.key];
    else bank[cur.key] = { variant: cur.variant, o: { ...cur.o } };
    Prefs.set('soundbank', bank);
  }
  const saveLibrary = () => Prefs.set('soundlib', library);

  function magnitudes(tb, P) {
    const c = tb.cell(P.wave, P.layer);
    const out = new Float32Array(SD.H);
    let mx = 1e-9;
    for (let h = 1; h <= SD.H; h++) {
      const m = Math.hypot(c.re[h], c.im[h]);
      out[h - 1] = m;
      if (m > mx) mx = m;
    }
    for (let i = 0; i < out.length; i++) out[i] /= mx;
    return out;
  }

  function compose(sig, variant, overrides) {
    const derived = SD.derive(sig.hash, variant);
    const mood = (app.song && app.song.cfg && app.song.cfg.sound) || {};
    const base = { ...derived, ...mood };
    const P = { ...base, ...overrides };
    return { base, P, tables: SD.tables(sig, variant) };
  }

  function recompute() {
    const sig = app.sigil;
    if (!sig) return;
    const c = compose(sig, cur.variant, cur.o);
    cur.base = c.base; cur.P = c.P; cur.tables = c.tables;
    cur.mags = magnitudes(cur.tables, cur.P);
    cur.mesh = SD.lattice(cur.tables, cur.P);
  }

  function syncFrom(sig) {
    if (!sig) return;
    const key = keyOf(sig);
    if (key !== cur.key || !cur.P) {
      cur.key = key;
      const e = bank[key] || {};
      cur.variant = e.variant | 0;
      cur.o = { ...(e.o || {}) };
      cur.mut = 0;
    }
    if (pending && pending.key === key) {
      cur.variant = pending.variant;
      cur.o = { ...pending.o };
      pending = null;
      persist();
    }
    recompute();
  }

  /** Per-section patches: numeric sound presets blended in by Story strength. */
  function buildSecP(P) {
    const song = app.song;
    if (!song || !song.sections) return [];
    return song.sections.map((s) => {
      const o = { ...P };
      if (s.sound) {
        for (const [k, v] of Object.entries(s.sound)) {
          if (typeof v === 'number' && typeof P[k] === 'number') o[k] = P[k] + (v - P[k]) * prefs.story;
        }
      }
      return o;
    });
  }

  function specFor() {
    if (renderSpec) return renderSpec;
    return { P: cur.P, tables: cur.tables };
  }

  /* ── Engine plumbing ─────────────────────────────────────────────────── */

  function ensureChorus(eng) {
    if (eng.chorusIn) return;
    const ctx = eng.ctx;
    const input = eng.gain(0);
    const out = eng.gain(0.9);
    const voice = (time, rate, depth, pan) => {
      const d = ctx.createDelay(0.08);
      d.delayTime.value = time;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const lg = eng.gain(depth);
      lfo.connect(lg);
      lg.connect(d.delayTime);
      lfo.start();
      input.connect(d);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        d.connect(p); p.connect(out);
      } else d.connect(out);
    };
    voice(0.012, 0.23, 0.0035, -0.7);
    voice(0.019, 0.31, 0.0028, 0.7);
    out.connect(eng.mix);
    eng.chorusIn = input;
  }

  /** Geometric reverb, built once per sigil per context. */
  function applyImpulse(eng) {
    const sig = app.sigil;
    if (!sig || !eng.reverb || eng.irKey === sig.hex) return;
    const ir = SD.impulse(sig, eng.ctx.sampleRate);
    const buf = eng.ctx.createBuffer(2, ir.L.length, ir.sr);
    buf.copyToChannel(ir.L, 0);
    buf.copyToChannel(ir.R, 1);
    eng.reverb.buffer = buf;
    eng.irKey = sig.hex;
  }

  /** Live-changeable values, glided with setTargetAtTime so nothing clicks. */
  function pushFx(eng) {
    if (!eng || !eng.sig) return;
    const P = eng.sig.P, now = eng.ctx.currentTime;
    if (eng.sfx) {
      const p = eng.sfx.parameters;
      const to = (n, v) => p.get(n).setTargetAtTime(v, now, 0.03);
      to('bits', P.grit > 0 ? P.bits : 16);
      to('hold', P.hold);
      to('fold', P.fold);
      to('drive', P.drive);
      to('mix', P.grit);
    }
    if (eng.chorusIn) eng.chorusIn.gain.setTargetAtTime(P.chorus * 0.85, now, 0.05);
    if (eng.delayReturn) eng.delayReturn.gain.setTargetAtTime(0.2 + P.echo * 0.6, now, 0.05);
  }

  /**
   * Section automation, written at the time of the first event in each section.
   * Because it rides on event times, live playback and offline renders agree.
   */
  function sectionFX(eng, beat, t) {
    const song = app.song;
    if (!song || !eng.sig || !eng.sig.secP.length || beat == null) return;
    const si = sectionIndexAt(song, beat);
    if (si === eng.sig.lastSi) return;
    eng.sig.lastSi = si;
    const P = eng.sig.secP[si] || eng.sig.P;
    const at = Math.max(t, eng.ctx.currentTime);
    if (eng.sfx) {
      const p = eng.sfx.parameters;
      p.get('bits').setTargetAtTime(P.grit > 0 ? P.bits : 16, at, 0.02);
      p.get('hold').setTargetAtTime(P.hold, at, 0.02);
      p.get('fold').setTargetAtTime(P.fold, at, 0.02);
      p.get('drive').setTargetAtTime(P.drive, at, 0.02);
      p.get('mix').setTargetAtTime(P.grit, at, 0.02);
    }
    if (eng.chorusIn) eng.chorusIn.gain.setTargetAtTime(P.chorus * 0.85, at, 0.04);
    if (eng.delayReturn) eng.delayReturn.gain.setTargetAtTime(0.2 + P.echo * 0.6, at, 0.05);
  }

  /** The patch in force at a beat. Used by voices and by m15's drums. */
  function paramsAt(eng, beat) {
    const sig = eng && eng.sig;
    if (!sig) return null;
    if (beat == null || !app.song || !sig.secP.length) return sig.P;
    return sig.secP[sectionIndexAt(app.song, beat)] || sig.P;
  }

  /** Build or refresh an engine's binding to a patch. Keeps cached cells when the tables are unchanged. */
  function attach(eng) {
    syncFrom(app.sigil);
    const spec = specFor();
    if (!spec.P || !spec.tables) return;

    if (!eng.sound) {
      eng.sound = true;
      eng.analyser = eng.ctx.createAnalyser();
      eng.analyser.fftSize = 512;
      eng.analyser.smoothingTimeConstant = 0.72;
      eng.out.connect(eng.analyser);
      if (fxReady.has(eng.ctx)) {
        try {
          eng.sfx = new AudioWorkletNode(eng.ctx, 'sigil-fx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          eng.mix.disconnect(eng.tone);
          eng.mix.connect(eng.sfx);
          eng.sfx.connect(eng.tone);
        } catch (e) { console.warn('[sound] crusher not attached:', e.message); }
      }
    }

    applyImpulse(eng);
    const same = eng.sig && eng.sig.tables === spec.tables;
    eng.sig = {
      P: spec.P, tables: spec.tables,
      cells: same ? eng.sig.cells : new Map(),
      secP: buildSecP(spec.P), lastSi: -1,
    };
    if (!eng.glottalWave) eng.glottalWave = eng.ctx.createPeriodicWave(GLOTTAL.re, GLOTTAL.im);

    ensureChorus(eng);
    if (eng.buses) {
      eng.buses.lead.connect(eng.chorusIn);
      eng.buses.pad.connect(eng.chorusIn);
    }
    pushFx(eng);
  }

  /** Push a knob change into whichever engine is live. */
  function refreshLive() {
    const eng = app.engine;
    if (!eng || !eng.sig) return;
    if (eng.sig.tables !== cur.tables) attach(eng);
    else {
      eng.sig.P = cur.P;
      eng.sig.secP = buildSecP(cur.P);
      eng.sig.lastSi = -1;
      pushFx(eng);
    }
  }

  async function prepare(ctx) {
    if (fxReady.has(ctx)) return true;
    if (!ctx.audioWorklet || !window.AudioWorkletNode) {
      console.warn('[sound] AudioWorklet unsupported; bit-crusher bypassed.');
      return false;
    }
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      fxReady.add(ctx);
      return true;
    } catch (e) {
      console.warn('[sound] could not load', WORKLET_URL, '-', e.message);
      return false;
    }
  }

  /* ── Envelopes and scheduling ────────────────────────────────────────── */

  function shape(eng, amp, t, d, peak, hold) {
    if (hold) {
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(peak, t + 0.012);
      amp.gain.setTargetAtTime(peak * 0.8, t + 0.012, 0.25);
      return t + 600;
    }
    return eng.adsr(amp.gain, t, d, { a: 0.012, d: 0.25, s: 0.78, r: 0.22, peak });
  }

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

  /** The note's journey through the cube. Freeze pins it. Lens can sweep X. */
  function travel(P, ev) {
    const lens = prefs.lensWave && typeof LiveLens !== 'undefined' && LiveLens.shift !== undefined
      ? LiveLens.shift * 0.6 : 0;
    const x0 = clamp(P.wave + lens, 0, SD.FX - 1);
    const y0 = clamp(P.layer, 0, SD.FY - 1);
    if (frozen) return { x0, y0, x1: x0, y1: y0 };
    const dir = ((ev.deg ?? 0) % 2 === 0) ? 1 : -1;
    return {
      x0, y0,
      x1: clamp(x0 + P.sweep * 4, 0, SD.FX - 1),
      y1: clamp(y0 + dir * P.drift * 2.5, 0, SD.FY - 1),
    };
  }

  function cellWave(eng, x, y) {
    const cx = clamp(Math.round(x), 0, SD.FX - 1);
    const cy = clamp(Math.round(y), 0, SD.FY - 1);
    const k = cy * 16 + cx;
    let w = eng.sig.cells.get(k);
    if (!w) {
      const c = eng.sig.tables.grid[cy][cx];
      w = eng.ctx.createPeriodicWave(c.re, c.im);
      eng.sig.cells.set(k, w);
    }
    return w;
  }

  /* ── The wavetable core ──────────────────────────────────────────────── */

  function waveCore(eng, { ev, midi, from, t, d, P, detune = 0, bright = P.bright, single = false, sub = P.sub, lean }) {
    const ctx = eng.ctx, f = mtof(midi);
    const tv = travel(P, ev || {});
    const mixNode = ctx.createGain();

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    const c0 = f * (1.5 + 9 * bright);
    lp.frequency.setValueAtTime(c0, t);
    lp.frequency.setTargetAtTime(c0 * 0.4, t + 0.02, Math.max(0.05, d * 0.3));
    lp.connect(mixNode);

    const pair = (single || lean) ? [[tv.x0, tv.y0, 1]] : [[tv.x0, tv.y0, 1], [tv.x1, tv.y1, 0]];
    const oscs = [];
    for (const [x, y, g0] of pair) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(cellWave(eng, x, y));
      o.detune.value = detune;
      o.frequency.setValueAtTime(from != null ? mtof(from) : f, t);
      if (from != null) o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(g0, t);
      if (pair.length > 1) g.gain.linearRampToValueAtTime(1 - g0, t + d);
      o.connect(g);
      g.connect(lp);
      oscs.push(o);
    }

    if (sub > 0.02 && !lean) {
      const s = ctx.createOscillator();
      s.type = 'sine';
      s.frequency.setValueAtTime((from != null ? mtof(from) : f) / 2, t);
      if (from != null) s.frequency.exponentialRampToValueAtTime(f / 2, t + 0.08);
      s.detune.value = detune * 0.4;
      const sg = ctx.createGain();
      sg.gain.value = sub * 0.55;
      s.connect(sg);
      sg.connect(mixNode);
      oscs.push(s);
    }
    return { out: mixNode, oscs };
  }

  /* ── Voices ──────────────────────────────────────────────────────────── */

  function voiceWave(eng, ev, t, P, bus, hold, opt = {}) {
    const ctx = eng.ctx, d = hold ? 3 : ev.dur * eng.spb;
    const lean = leaning(takeVoice(ctx, t + d + 1));
    const core = waveCore(eng, {
      ev, midi: ev.midi, from: ev.from, t, d, P,
      bright: opt.bright ?? P.bright, single: opt.single, sub: opt.sub ?? P.sub, lean,
    });
    const amp = ctx.createGain();
    core.out.connect(amp);
    amp.connect(bus);

    const nodes = core.oscs.slice();
    if (!hold && !lean && ev.type === 'lead' && d > 0.45) {
      nodes.push(vibrato(ctx, t, d, core.oscs.slice(0, 2), mtof(ev.midi) * 0.004));
    }
    const end = shape(eng, amp, t, d, ev.vel * (opt.peak ?? 0.32), hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  function voiceVox(eng, ev, t, P, bus, hold) {
    const ctx = eng.ctx, f = mtof(ev.midi), d = hold ? 3 : ev.dur * eng.spb;
    const lean = leaning(takeVoice(ctx, t + d + 1));

    const src = ctx.createOscillator();
    src.setPeriodicWave(eng.glottalWave);
    src.frequency.setValueAtTime(ev.from != null ? mtof(ev.from) : f, t);
    if (ev.from != null) src.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    const nodes = [src];
    if (!hold && !lean) nodes.push(vibrato(ctx, t, d, [src], f * 0.006));

    const deg = ev.deg ?? 0;
    let i0 = mod(deg + P.vowel, 5);
    if (prefs.vowelMemory && vowelMemory && vowelMemory.length) {
      i0 = vowelMemory[mod(Math.round((ev.beat ?? deg) * 2), vowelMemory.length)];
    }
    const i1 = d > 0.6 ? mod(i0 + 1, 5) : i0;
    const V0 = SD.VOWELS[i0], V1 = SD.VOWELS[i1];
    const tk = Math.pow(2, P.throat * 0.35);
    const morph = t + Math.min(d * 0.9, 0.7);

    const sum = ctx.createGain();
    sum.gain.value = 0.7 + 0.4 * P.bright;
    const count = lean ? 3 : 4;
    for (let i = 0; i < count; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 6 + 7 * P.bright;
      bp.frequency.setValueAtTime(V0.f[i] * tk, t);
      bp.frequency.linearRampToValueAtTime(V1.f[i] * tk, morph);
      const g = ctx.createGain();
      g.gain.value = V0.g[i];
      src.connect(bp); bp.connect(g); g.connect(sum);
    }

    const amp = ctx.createGain();
    sum.connect(amp);
    amp.connect(bus);

    if (P.sub > 0.02 && !lean) {
      const s = ctx.createOscillator();
      s.type = 'sine';
      s.frequency.setValueAtTime(f / 2, t);
      const sg = ctx.createGain();
      sg.gain.value = P.sub * 0.22;
      s.connect(sg); sg.connect(amp);
      nodes.push(s);
    }

    if (P.breath > 0.01 && !lean) {
      const br = ctx.createBufferSource();
      br.buffer = eng.noiseBuf;
      br.loop = true;
      const bf = ctx.createBiquadFilter();
      bf.type = 'bandpass'; bf.frequency.value = 3200 * tk; bf.Q.value = 0.9;
      const bg = ctx.createGain();
      const bl = P.breath * 0.06 * ev.vel;
      bg.gain.setValueAtTime(0, t);
      bg.gain.linearRampToValueAtTime(bl, t + 0.04);
      bg.gain.linearRampToValueAtTime(bl * 0.4, t + d);
      br.connect(bf); bf.connect(bg); bg.connect(amp);
      nodes.push(br);
    }

    lastVowel = { name: V0.name, at: performance.now() };
    const end = shape(eng, amp, t, d, ev.vel * 0.42 * (ev.type === 'harm' ? 0.7 : 1), hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  function voicePad(eng, ev, t, P, bus, hold) {
    const ctx = eng.ctx, d = hold ? 3 : ev.dur * eng.spb;
    const lean = leaning(takeVoice(ctx, t + d + 1));
    const mix = ctx.createGain(), amp = ctx.createGain();
    mix.connect(amp);
    amp.connect(bus);
    const nodes = [];
    const spread = lean ? [0] : [-6, 6];
    for (const m of ev.midis) {
      for (const dt of spread) {
        const core = waveCore(eng, { ev, midi: m, t, d, P, detune: dt, bright: P.bright * 0.6, single: true, sub: 0, lean });
        core.out.connect(mix);
        nodes.push(...core.oscs);
      }
    }
    const end = shape(eng, amp, t, d, ev.vel * 0.05, hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /* ── The hook ────────────────────────────────────────────────────────── */

  /**
   * Return true when handled, undefined otherwise. Drums are m15's, so they fall
   * through here. Section automation is applied to every scored event first.
   */
  function voiceHook(_, ev, t, eng) {
    if (prefs.mode !== 'sigil' || !eng.sig || !eng.buses) return undefined;
    sectionFX(eng, ev.beat, t);
    const P = paramsAt(eng, ev.beat) || eng.sig.P;

    switch (ev.type) {
      case 'lead': {
        const vox = P.voice === 'vox' || (P.voice === 'auto' && ev.timbre === 'reed');
        (vox ? voiceVox : voiceWave)(eng, ev, t, P, eng.buses.lead, false);
        return true;
      }
      case 'harm':
        voiceVox(eng, ev, t, P, eng.buses.harm, false);
        return true;
      case 'bass':
        voiceWave(eng, ev, t, P, eng.buses.bass, false, { bright: 0.18, single: true, sub: Math.max(P.sub, 0.3), peak: 0.4 });
        return true;
      case 'pad':
        voicePad(eng, ev, t, P, eng.buses.pad, false);
        return true;
      default:
        return undefined;
    }
  }

  /* ── Playing by hand ─────────────────────────────────────────────────── */

  const live = () => (app.engine && app.sigil && app.engine.sig ? app.engine : null);

  function playBus(eng) {
    if (!eng.playBus) {
      const g = eng.gain(0.9), send = eng.gain(0.35);
      g.connect(eng.mix);
      g.connect(send);
      send.connect(eng.reverb);
      if (eng.chorusIn) g.connect(eng.chorusIn);
      eng.playBus = g;
    }
    return eng.playBus;
  }

  function noteOn({ midi, deg = 0, vel = 0.8 }) {
    const eng = live();
    if (!eng || eng.ctx.state !== 'running') return null;
    const P = eng.sig.P, t = eng.ctx.currentTime, bus = playBus(eng);
    const ev = { type: 'lead', midi, deg, vel, timbre: 'glass' };
    return P.voice === 'vox'
      ? voiceVox(eng, ev, t, P, bus, true)
      : voiceWave(eng, ev, t, P, bus, true);
  }

  /* ── Hooks ───────────────────────────────────────────────────────────── */

  Hooks.on('buses', (_b, eng) => attach(eng));
  Hooks.on('voice', voiceHook, 0);

  Hooks.on('beforeCast', (ctx) => {
    const seq = [];
    for (const ch of ctx.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()) {
      const i = 'AEIOU'.indexOf(ch);
      if (i >= 0) seq.push(i);
    }
    vowelMemory = seq.length ? seq : null;
  });

  Hooks.on('link', (link) => {
    const d = link.sound ? SD.decodePatch(link.sound) : null;
    pending = d ? { key: link.members.join('+'), ...d } : null;
    vowelMemory = null;
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
    vowelMemory = null;
  });

  /* ── API ─────────────────────────────────────────────────────────────── */

  const api = {
    SD, prepare, attach, noteOn, live, paramsAt,
    view: () => cur,
    state: () => ({ key: cur.key, variant: cur.variant, o: cur.o, P: cur.P, base: cur.base, tables: cur.tables, mags: cur.mags, mesh: cur.mesh }),
    get mode() { return prefs.mode; },
    get lite() { return prefs.lite; },
    get keysOn() { return prefs.keys; },
    get frozen() { return frozen; },
    get lensWave() { return prefs.lensWave; },
    get vowelMemoryOn() { return prefs.vowelMemory; },
    get story() { return prefs.story; },
    lastVowel: () => lastVowel,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    setMode(m) { prefs.mode = m; Prefs.set('sound.mode', m); notify(); },
    setLite(v) { prefs.lite = !!v; Prefs.set('sound.lite', prefs.lite); notify(); },
    setLensWave(v) { prefs.lensWave = !!v; Prefs.set('sound.lensWave', prefs.lensWave); notify(); },
    setVowelMemory(v) { prefs.vowelMemory = !!v; Prefs.set('sound.vowelMemory', prefs.vowelMemory); notify(); },
    setStory(v) { prefs.story = clamp(v, 0, 1); Prefs.set('sound.story', prefs.story); refreshLive(); notify(); },
    toggleKeys(force) { prefs.keys = force ?? !prefs.keys; notify(); return prefs.keys; },
    toggleFreeze(force) { frozen = force ?? !frozen; notify(); return frozen; },

    set(name, v) {
      if (!app.sigil) return;
      cur.o[name] = v;
      persist(); recompute(); refreshLive(); notify();
    },
    reset() {
      cur.o = {}; cur.mut = 0;
      persist(); recompute(); refreshLive(); notify();
    },
    mutate() {
      if (!app.sigil) return;
      cur.mut++;
      cur.o = SD.mutate(app.sigil.hash, cur.mut, cur.base, cur.o);
      persist(); recompute(); refreshLive(); notify();
    },
    dream(delta) {
      if (!app.sigil) return;
      cur.variant = mod(cur.variant + delta, 100);
      persist(); recompute();
      if (app.engine) { app.engine.sig = null; attach(app.engine); }
      notify();
    },
    code: () => SD.encodePatch(cur.o, cur.variant),

    setRenderSpec(spec) {
      if (!spec || !app.sigil) { renderSpec = null; return; }
      const c = compose(app.sigil, spec.variant ?? cur.variant, { ...cur.o, ...(spec.o || {}) });
      renderSpec = { P: c.P, tables: c.tables };
    },
    clearRenderSpec() { renderSpec = null; },

    library: () => library.slice(),
    save(name) { library.push({ name: String(name).slice(0, 40), o: { ...cur.o } }); saveLibrary(); notify(); },
    applyLibrary(i) {
      const it = library[i];
      if (!it || !app.sigil) return;
      cur.o = { ...it.o };
      persist(); recompute(); refreshLive(); notify();
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

window.Sound = Sound;