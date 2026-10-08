'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m11 · VOICES v4 — pitched synthesis (drums live in m15)
   --------------------------------------------------------------------------
   PATCH LAYERS   derived DNA ◂ mood suggestion ◂ your knobs ◂ section arc
   VOICES         wave (cube travel + sub) · vox (formants) · pad
   SHARED FX      one stereo chorus per engine, fed by sends
   EXPORTS        paramsAt(eng, beat)  the patch at a moment, for m15
                  recentNotes()        onsets for the visual ripples
                  view().ring          clean and crushed cycles for the ring
   ══════════════════════════════════════════════════════════════════════════ */

const Sound = (() => {
  'use strict';
  const SD = SoundDesign;
  const WORKLET_URL = 'src/audio/sigil-fx.worklet.js';
  const GLOTTAL = SD.glottal();
  const fxReady = new WeakSet();
  const irCache = new Map();

  const VOICE_BUDGET = 34;
  const prefs = {
    mode: Prefs.get('sound.mode', 'sigil'),
    lite: Prefs.get('sound.lite', (navigator.hardwareConcurrency || 4) <= 2),
    lensWave: Prefs.get('sound.lensWave', false),
    vowelMemory: Prefs.get('sound.vowelMemory', true),
    arc: Prefs.get('sound.arc', true),
    sigilVerb: Prefs.get('sound.sigilVerb', true),
    keys: false,
  };

  let bank = Prefs.get('soundbank', {});
  let library = Prefs.get('soundlib', []);
  const cur = { key: null, variant: 0, o: {}, base: null, P: null, tables: null, mags: null, ring: null, mut: 0 };
  let renderSpec = null, pending = null, lastVowel = null, frozen = false, vowelMemory = null;
  const notes = [];                        // recent onsets, for the visuals
  const subs = new Set();
  const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error('[sound:ui]', e); } });
  const keyOf = (sig) => sig.fusionKey || sig.reduced;
  const lite = () => prefs.lite;

  function noteMark(ev, kind) {
    notes.push({ beat: ev.beat, at: performance.now(), kind });
    if (notes.length > 24) notes.shift();
  }

  /* ── Voice budget ────────────────────────────────────────────────────── */
  let endTimes = [];
  function takeVoice(ctx, end) {
    const now = ctx.currentTime;
    if (endTimes.length > 8) endTimes = endTimes.filter((t) => t > now);
    endTimes.push(end || now + 1);
    return endTimes.length;
  }
  const leaning = (n) => lite() || n > VOICE_BUDGET;

  /* ── Patch state ─────────────────────────────────────────────────────── */

  function persist() {
    if (!cur.key) return;
    if (!Object.keys(cur.o).length && !cur.variant) delete bank[cur.key];
    else bank[cur.key] = { variant: cur.variant, o: { ...cur.o } };
    Prefs.set('soundbank', bank);
  }
  const saveLibrary = () => Prefs.set('soundlib', library);

  function magnitudes(tb, x, y) {
    const c = tb.cell(x, y), out = new Float32Array(SD.H);
    let mx = 1e-9;
    for (let h = 1; h <= SD.H; h++) {
      const m = Math.hypot(c.re[h], c.im[h]);
      out[h - 1] = m;
      if (m > mx) mx = m;
    }
    for (let i = 0; i < out.length; i++) out[i] /= mx;
    return out;
  }

  function composePatch(sig, variant, overrides) {
    const derived = SD.derive(sig.hash, variant);
    const mood = (app.song && app.song.cfg && app.song.cfg.sound) || {};
    const base = { ...derived, ...mood };
    const P = { ...base, ...overrides };
    return { base, P, tables: SD.tables(sig, variant, P) };
  }

  function recompute() {
    const sig = app.sigil;
    if (!sig) return;
    const c = composePatch(sig, cur.variant, cur.o);
    cur.base = c.base; cur.P = c.P; cur.tables = c.tables;
    cur.mags = magnitudes(cur.tables, cur.P.wave, cur.P.layer);
    cur.ring = SD.ringSamples(cur.tables, cur.P, 128);
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
      cur.variant = pending.variant; cur.o = { ...pending.o };
      pending = null; persist();
    }
    recompute();
  }

  const specFor = () => renderSpec || { P: cur.P, tables: cur.tables };

  /* ── Sound arc ───────────────────────────────────────────────────────── */

  function buildArc(eng) {
    const song = app.song, P = eng.sig.P;
    eng.arcOf = P;
    if (!song || !prefs.arc) { eng.arc = null; eng.kits = null; eng.secStarts = null; return; }
    const n = song.sections.length;
    eng.arc = song.sections.map((sec, si) => ({ ...P, ...SD.arc(P, sec, si, n) }));
    eng.kits = song.sections.map((sec, si) => SD.kitAt(P, sec, si, n));
    eng.secStarts = song.sections.map((s) => s.start);
  }

  function sectionIdx(eng, beat) {
    const s = eng.secStarts;
    if (!s) return 0;
    let j = 0;
    for (let i = 0; i < s.length; i++) if (beat >= s[i]) j = i;
    return j;
  }

  /** The effective patch (with its kit) at a beat. m15 calls this. */
  function paramsAt(eng, beat) {
    if (!eng || !eng.sig) return null;
    if (eng.arcOf !== eng.sig.P) buildArc(eng);
    if (!eng.arc) { const P = eng.sig.P; return { ...P, kit: P.kit }; }
    const si = sectionIdx(eng, beat || 0);
    const P = eng.arc[si];
    return P.kit === eng.kits[si] ? P : (eng.arc[si] = { ...P, kit: eng.kits[si] });
  }

  /* ── Engine attachment ───────────────────────────────────────────────── */

  function ensureChorus(eng) {
    if (eng.chorusIn) return;
    const ctx = eng.ctx;
    const input = eng.gain(0), out = eng.gain(0.9);
    const voice = (time, rate, depth, pan) => {
      const d = ctx.createDelay(0.08);
      d.delayTime.value = time;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const lg = eng.gain(depth);
      lfo.connect(lg); lg.connect(d.delayTime); lfo.start();
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

  /** The reverb impulse, built from the sigil's own strokes. */
  function sigilIR(ctx, sig, variant) {
    const key = `${ctx.sampleRate}:${sig.hex.slice(0, 12)}:${variant}`;
    if (irCache.has(key)) return irCache.get(key);

    const spec = SD.irSpec(sig, variant);
    const sr = ctx.sampleRate, len = Math.floor(sr * spec.seconds);
    const buf = ctx.createBuffer(2, len, sr);

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const rnd = mulberry32(0x1f2e3d + ch + variant * 7);
      let lp = 0;
      const pre = Math.floor(sr * 0.014);
      for (let i = pre; i < len; i++) {
        const tt = i / len;
        lp += (spec.damp * (1 - 0.6 * tt)) * ((rnd() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - tt, spec.decay) * 1.25;
      }
    }
    for (const tap of spec.taps) {
      const at = Math.floor(tap.t * sr);
      if (at >= len - 8) continue;
      const smear = Math.max(4, Math.floor(tap.diffuse * 0.02 * sr));
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        const side = ch === 0 ? 1 - Math.max(0, tap.pan) : 1 + Math.min(0, tap.pan);
        const rnd = mulberry32(at * 2654435761 + ch);
        for (let i = 0; i < smear && at + i < len; i++) {
          const w = 1 - i / smear;
          d[at + i] += tap.gain * side * w * w * (rnd() * 2 - 1);
        }
      }
    }
    if (irCache.size > 8) irCache.clear();
    irCache.set(key, buf);
    return buf;
  }

  function cellWave(eng, x, y) {
    const cx = clamp(Math.round(x), 0, SD.FX - 1);
    const cy = clamp(Math.round(y), 0, SD.FY - 1);
    const k = cy * 32 + cx;
    let w = eng.sig.cells.get(k);
    if (!w) {
      const c = eng.sig.tables.cell(cx, cy);
      w = eng.ctx.createPeriodicWave(c.re, c.im);
      eng.sig.cells.set(k, w);
    }
    return w;
  }

  function attach(eng) {
    syncFrom(app.sigil);
    const spec = specFor();
    if (!spec.P || !spec.tables) return;

    if (!eng.sound) {
      eng.sound = true;
      eng.analyser = eng.ctx.createAnalyser();
      eng.analyser.fftSize = 1024;
      eng.analyser.smoothingTimeConstant = 0.6;
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

    if (!eng.sig || eng.sig.tables !== spec.tables) {
      eng.sig = { P: spec.P, tables: spec.tables, cells: new Map() };
      eng.glottalWave = eng.glottalWave || eng.ctx.createPeriodicWave(GLOTTAL.re, GLOTTAL.im);
      eng.arcOf = null;
    }
    eng.sig.P = spec.P;
    buildArc(eng);

    if (prefs.sigilVerb && app.sigil) {
      try { eng.reverb.buffer = sigilIR(eng.ctx, app.sigil, cur.variant); }
      catch (e) { console.warn('[sound] sigil reverb failed:', e.message); }
    }

    ensureChorus(eng);
    if (eng.buses) {
      eng.buses.lead.connect(eng.chorusIn);
      eng.buses.pad.connect(eng.chorusIn);
    }
    pushFx(eng);
  }

  function pushFx(eng) {
    if (!eng || !eng.sig) return;
    const P = eng.sig.P, now = eng.ctx.currentTime;
    if (eng.sfx) {
      const p = eng.sfx.parameters;
      const to = (n, v) => p.get(n).setTargetAtTime(v, now, 0.03);
      to('bits', P.grit > 0 ? P.bits : 16);
      to('hold', P.hold); to('fold', P.fold); to('drive', P.drive); to('mix', P.grit);
    }
    if (eng.chorusIn) eng.chorusIn.gain.setTargetAtTime(P.chorus * 0.85, now, 0.05);
    if (eng.delayReturn) eng.delayReturn.gain.setTargetAtTime(0.2 + P.echo * 0.6, now, 0.05);
  }

  async function prepare(ctx) {
    if (fxReady.has(ctx)) return true;
    if (!ctx.audioWorklet || !window.AudioWorkletNode) return false;
    try { await ctx.audioWorklet.addModule(WORKLET_URL); fxReady.add(ctx); return true; }
    catch (e) { console.warn('[sound] could not load', WORKLET_URL, '-', e.message); return false; }
  }

  /* ── Envelope helpers ────────────────────────────────────────────────── */

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
    if (!hold) { nodes.forEach((n) => n.stop(end)); return { release() {} }; }
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

  function travel(P, ev) {
    const lens = prefs.lensWave && typeof LiveLens !== 'undefined' && LiveLens.shift !== undefined
      ? LiveLens.shift * 0.8 : 0;
    const x0 = clamp(P.wave + lens, 0, SD.FX - 1);
    const y0 = clamp(P.layer, 0, SD.FY - 1);
    if (frozen) return { x0, y0, x1: x0, y1: y0 };
    const dir = ((ev.deg ?? 0) % 2 === 0) ? 1 : -1;
    return {
      x0, y0,
      x1: clamp(x0 + P.sweep * 5, 0, SD.FX - 1),
      y1: clamp(y0 + dir * P.drift * 4, 0, SD.FY - 1),
    };
  }

  /* ── Wavetable core ──────────────────────────────────────────────────── */

  function waveCore(eng, { ev, midi, from, t, d, P, detune = 0, bright = P.bright, single = false, sub = P.sub, lean }) {
    const ctx = eng.ctx, f = mtof(midi);
    const tv = travel(P, ev || {});
    const mixNode = ctx.createGain();

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.7;
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
      o.connect(g); g.connect(lp);
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
      s.connect(sg); sg.connect(mixNode);
      oscs.push(s);
    }
    return { out: mixNode, oscs };
  }

  /* ── Voices ──────────────────────────────────────────────────────────── */

  function voiceWave(eng, ev, t, P, bus, hold, opt = {}) {
    const ctx = eng.ctx, d = hold ? 3 : ev.dur * eng.spb;
    const lean = leaning(takeVoice(ctx, t + d + 1));
    const core = waveCore(eng, { ev, midi: ev.midi, from: ev.from, t, d, P, bright: opt.bright ?? P.bright, single: opt.single, sub: opt.sub ?? P.sub, lean });
    const amp = ctx.createGain();
    core.out.connect(amp); amp.connect(bus);
    const nodes = core.oscs.slice();
    if (!hold && !lean && ev.type === 'lead' && d > 0.45) nodes.push(vibrato(ctx, t, d, core.oscs.slice(0, 2), mtof(ev.midi) * 0.004));
    const end = shape(eng, amp, t, d, ev.vel * (opt.peak ?? 0.32), hold);
    if (!hold) noteMark(ev, opt.kind || ev.type);
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
    for (let i = 0; i < (lean ? 3 : 4); i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 6 + 7 * P.bright;
      bp.frequency.setValueAtTime(V0.f[i] * tk, t);
      bp.frequency.linearRampToValueAtTime(V1.f[i] * tk, morph);
      const g = ctx.createGain();
      g.gain.value = V0.g[i];
      src.connect(bp); bp.connect(g); g.connect(sum);
    }

    const amp = ctx.createGain();
    sum.connect(amp); amp.connect(bus);

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
      br.buffer = eng.noiseBuf; br.loop = true;
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
    if (!hold) noteMark(ev, 'vox');
    const end = shape(eng, amp, t, d, ev.vel * 0.42 * (ev.type === 'harm' ? 0.7 : 1), hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  function voicePad(eng, ev, t, P, bus, hold) {
    const ctx = eng.ctx, d = hold ? 3 : ev.dur * eng.spb;
    const lean = leaning(takeVoice(ctx, t + d + 1));
    const mix = ctx.createGain(), amp = ctx.createGain();
    mix.connect(amp); amp.connect(bus);
    const nodes = [];
    for (const m of ev.midis) {
      for (const dt of (lean ? [0] : [-6, 6])) {
        const core = waveCore(eng, { ev, midi: m, t, d, P, detune: dt, bright: P.bright * 0.6, single: true, sub: 0, lean });
        core.out.connect(mix);
        nodes.push(...core.oscs);
      }
    }
    if (!hold) noteMark(ev, 'pad');
    const end = shape(eng, amp, t, d, ev.vel * 0.05, hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /* ── Hook: pitched events only. m15 handles drums at priority 10. ────── */

  function voiceHook(_, ev, t, eng) {
    if (prefs.mode !== 'sigil' || !eng.sig || !eng.buses) return null;
    const P = paramsAt(eng, ev.beat);
    if (!P) return null;

    switch (ev.type) {
      case 'lead': {
        const vox = P.voice === 'vox' || (P.voice === 'auto' && ev.timbre === 'reed');
        (vox ? voiceVox : voiceWave)(eng, ev, t, P, eng.buses.lead, false);
        return true;
      }
      case 'harm': voiceVox(eng, ev, t, P, eng.buses.harm, false); return true;
      case 'bass': voiceWave(eng, ev, t, P, eng.buses.bass, false, { bright: 0.18, single: true, sub: Math.max(P.sub, 0.3), peak: 0.4 }); return true;
      case 'pad': voicePad(eng, ev, t, P, eng.buses.pad, false); return true;
      default: return null;
    }
  }

  /* ── Playing by hand ─────────────────────────────────────────────────── */

  const live = () => (app.engine && app.sigil && app.engine.sig ? app.engine : null);

  function playBus(eng) {
    if (!eng.playBus) {
      const g = eng.gain(0.9), send = eng.gain(0.35);
      g.connect(eng.mix); g.connect(send); send.connect(eng.reverb);
      if (eng.chorusIn) g.connect(eng.chorusIn);
      eng.playBus = g;
    }
    return eng.playBus;
  }

  function noteOn({ midi, deg = 0, vel = 0.8 }) {
    const eng = live();
    if (!eng || eng.ctx.state !== 'running') return null;
    const P = eng.sig.P, t = eng.ctx.currentTime, bus = playBus(eng);
    const ev = { type: 'lead', midi, deg, vel, timbre: 'glass', beat: null };
    notes.push({ beat: null, at: performance.now(), kind: 'key' });
    if (notes.length > 24) notes.shift();
    return P.voice === 'vox' ? voiceVox(eng, ev, t, P, bus, true) : voiceWave(eng, ev, t, P, bus, true);
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

  const refreshEngine = () => {
    if (app.engine && app.engine.sig) {
      if (app.engine.sig.tables !== cur.tables) { app.engine.sig = null; attach(app.engine); return; }
      app.engine.sig.P = cur.P;
      buildArc(app.engine);
      pushFx(app.engine);
    }
  };

  return {
    SD, prepare, attach, noteOn, live, paramsAt,
    view: () => cur,
    state: () => ({ key: cur.key, variant: cur.variant, o: cur.o, P: cur.P, base: cur.base, tables: cur.tables, mags: cur.mags, ring: cur.ring }),
    recentNotes: () => notes,
    get mode() { return prefs.mode; },
    get lite() { return prefs.lite; },
    get keysOn() { return prefs.keys; },
    get frozen() { return frozen; },
    get lensWave() { return prefs.lensWave; },
    get vowelMemoryOn() { return prefs.vowelMemory; },
    get arcOn() { return prefs.arc; },
    get sigilVerbOn() { return prefs.sigilVerb; },
    lastVowel: () => lastVowel,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    setMode(m) { prefs.mode = m; Prefs.set('sound.mode', m); notify(); },
    setLite(v) { prefs.lite = !!v; Prefs.set('sound.lite', prefs.lite); notify(); },
    setLensWave(v) { prefs.lensWave = !!v; Prefs.set('sound.lensWave', prefs.lensWave); notify(); },
    setVowelMemory(v) { prefs.vowelMemory = !!v; Prefs.set('sound.vowelMemory', prefs.vowelMemory); notify(); },
    setArc(v) { prefs.arc = !!v; Prefs.set('sound.arc', prefs.arc); if (app.engine) { app.engine.arcOf = null; refreshEngine(); } notify(); },
    setSigilVerb(v) {
      prefs.sigilVerb = !!v; Prefs.set('sound.sigilVerb', prefs.sigilVerb);
      if (app.engine) {
        try {
          app.engine.reverb.buffer = prefs.sigilVerb && app.sigil
            ? sigilIR(app.engine.ctx, app.sigil, cur.variant) : Engine.sharedIR(app.engine.ctx);
        } catch (e) { console.warn(e); }
      }
      notify();
    },
    toggleKeys(force) { prefs.keys = force ?? !prefs.keys; notify(); return prefs.keys; },
    toggleFreeze(force) { frozen = force ?? !frozen; notify(); return frozen; },

    set(name, v) { if (!app.sigil) return; cur.o[name] = v; persist(); recompute(); refreshEngine(); notify(); },
    reset() { cur.o = {}; cur.mut = 0; persist(); recompute(); refreshEngine(); notify(); },
    mutate() {
      if (!app.sigil) return;
      cur.mut++;
      cur.o = SD.mutate(app.sigil.hash, cur.mut, cur.base, cur.o);
      persist(); recompute(); refreshEngine(); notify();
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
      const c = composePatch(app.sigil, spec.variant ?? cur.variant, { ...cur.o, ...(spec.o || {}) });
      renderSpec = { P: c.P, tables: c.tables };
    },
    clearRenderSpec() { renderSpec = null; },

    library: () => library.slice(),
    save(name) { library.push({ name: String(name).slice(0, 40), o: { ...cur.o } }); saveLibrary(); notify(); },
    applyLibrary(i) { const it = library[i]; if (!it || !app.sigil) return; cur.o = { ...it.o }; persist(); recompute(); refreshEngine(); notify(); },
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
})();

if (typeof window !== 'undefined') window.Sound = Sound;