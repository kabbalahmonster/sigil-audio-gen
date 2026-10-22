'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m11 · VOICES v3
   --------------------------------------------------------------------------
   NEW IN v3
     • SOUND ARC     each section gets its own patch overlay (SD.arc), cached
                     per section so nothing is recomputed per note.
     • DRUM CUBE     the kit itself moves with the rite (SD.kitAt).
     • TUNED KICK    the kick's tail lands on the song's tonic, an octave or
                     two below the bass, with a click, a body and a sub layer
                     through a shaper. It is a chord tone, not a thud.
     • SIGIL REVERB  the convolution impulse is built from the sigil's strokes.
     • SMOOTHNESS    node budget, reused curves, no allocation on the hot path,
                     and a hard ceiling on simultaneous drum layers.
   ══════════════════════════════════════════════════════════════════════════ */

const Sound = (() => {
  'use strict';
  const SD = SoundDesign;
  const WORKLET_URL = 'src/audio/sigil-fx.worklet.js';
  const GLOTTAL = SD.glottal();
  const fxReady = new WeakSet();
  const irCache = new Map();                 // `${sampleRate}:${key}` → AudioBuffer

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
  const cur = { key: null, variant: 0, o: {}, base: null, P: null, tables: null, mags: null, mut: 0 };
  let renderSpec = null, pending = null, lastVowel = null, frozen = false, vowelMemory = null;
  const subs = new Set();
  const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error('[sound:ui]', e); } });
  const keyOf = (sig) => sig.fusionKey || sig.reduced;
  const lite = () => prefs.lite;

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

  /** Defaults for every knob, so a patch always has a value to show and to reset to. */
  const DEFAULTS = {
    tilt: 0, density: 1,
    kSub: 1, kPunch: 1, kDecay: 1, kTone: 0,
    sBody: 1, sSnap: 1, sTone: 1,
    hTone: 1, hDecay: 1,
    take: 0,                       // which groove the kit plays (05c); 0 is the sigil's own
    motion: 1, evolve: 0.5, mVar: 0, mMute: 0,   // the movers (05d): depth, change per pass, which deal, which are held
  };

  function composePatch(sig, variant, overrides) {
    const derived = SD.derive(sig.hash, variant);
    // The kit's FX (the D· knobs) are dealt from their own stream, so derive() stays as it was.
    // Then the song dresses the patch: a style's signature, a mood's values, an element's lean (SD.shape).
    const base = SD.shape({ ...DEFAULTS, ...derived, ...SD.drumFx(sig.hash, variant) }, app.song && app.song.cfg);
    return { base, P: { ...base, ...overrides }, tables: SD.tables(sig, variant) };
  }

  function recompute() {
    const sig = app.sigil;
    if (!sig) return;
    const c = composePatch(sig, cur.variant, cur.o);
    cur.base = c.base; cur.P = c.P; cur.tables = c.tables;
    cur.mags = magnitudes(cur.tables, cur.P.wave, cur.P.layer);
    cur.ring = ringFor(cur.tables, cur.P);
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

  /* ── Sound arc: one merged patch per section, built once ─────────────── */

  function buildArc(eng) {
    const song = app.song, P = eng.sig.P;
    eng.arcOf = P;
    if (!song || !prefs.arc) { eng.arc = null; eng.kits = null; return; }
    const n = song.sections.length;
    eng.arc = song.sections.map((sec, si) => ({ ...P, ...SD.arc(P, sec, si, n) }));
    eng.kits = song.sections.map((sec, si) => SD.kitAt(P, sec, si, n));
    eng.secStarts = song.sections.map((s) => s.start);
  }

  /** Section index for a beat. Linear over seven entries, with a one-slot memo. */
  function sectionIdx(eng, beat) {
    const s = eng.secStarts;
    if (!s) return 0;
    let j = 0;
    for (let i = 0; i < s.length; i++) if (beat >= s[i]) j = i;
    return j;
  }

  /** The effective patch and kit for an event. */
  function patchFor(eng, ev) {
    if (eng.arcOf !== eng.sig.P) buildArc(eng);
    if (!eng.arc) return { P: eng.sig.P, K: eng.sig.P.kit };
    const si = sectionIdx(eng, ev.beat || 0);
    return { P: eng.arc[si], K: eng.kits[si] };
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

  /** Build the sigil's own impulse response: early reflections from its strokes. */
  function sigilIR(ctx, sig, variant) {
    const spec = SD.irSpec(sig, variant);
    const key = `${ctx.sampleRate}:${sig.hex.slice(0, 12)}:${variant}`;
    if (irCache.has(key)) return irCache.get(key);

    const sr = ctx.sampleRate;
    const len = Math.floor(sr * spec.seconds);
    const buf = ctx.createBuffer(2, len, sr);


    // Diffuse bed: decaying, progressively darkened noise.
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
    // The strokes themselves, as discrete taps with a short diffuse smear.
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

    /** Build one cube cell, shaped by Tilt (spectral slope) and Density (upper tier). Cached by bucket. */
    function cellWave(eng, x, y, P) {
      const cx = clamp(Math.round(x), 0, SD.FX - 1);
      const cy = clamp(Math.round(y), 0, SD.FY - 1);
      const tilt = P.tilt ?? 0, dm = P.density ?? 1;
      const key = `${cy},${cx},${Math.round(tilt * 20)},${Math.round(dm * 20)}`;
      let w = eng.sig.cells.get(key);
      if (!w) {
        const c = eng.sig.tables.grid[cy][cx];
        const n = c.re.length;
        const re = new Float32Array(n), im = new Float32Array(n);
        for (let h = 1; h < n; h++) {
          const g = Math.pow(h, -tilt) * (h >= SD.UPPER ? dm : 1);
          re[h] = c.re[h] * g;
          im[h] = c.im[h] * g;
        }
        w = eng.ctx.createPeriodicWave(re, im);
        if (eng.sig.cells.size > 240) eng.sig.cells.clear();
        eng.sig.cells.set(key, w);
      }
      return w;
    }

  /** A shared drum-bus shaper curve, built once per engine. */
  function drumCurve(eng) {
    if (eng.drumCurve) return eng.drumCurve;
    const c = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      c[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
    }
    eng.drumCurve = c;
    return c;
  }

    /**
   * Build the cube's PeriodicWaves in small idle slices. Creating one on the main
   * thread in the middle of a phrase is a hitch; doing them all up front is not.
   */
    function warmCells(eng) {
      if (eng.warming) return;
      eng.warming = true;
      const list = [];
      for (let y = 0; y < SD.FY; y++) for (let x = 0; x < SD.FX; x++) list.push([x, y]);
      let i = 0;
      const step = () => {
        const end = performance.now() + 6;          // about 6 ms of work per slice
        while (i < list.length && performance.now() < end) {
          cellWave(eng, list[i][0], list[i][1], eng.sig.P);
          i++;
        }
        if (i < list.length) setTimeout(step, 8);
        else eng.warming = false;
      };
      setTimeout(step, 0);
    }

  function attach(eng) {
    syncFrom(app.sigil);
    const spec = specFor();
    if (!spec.P || !spec.tables) return;
    if (eng.isDSP) {                       // Engine v2: the DSP core plays; we just publish the patch
      eng.sig = { P: spec.P, tables: spec.tables, cells: null };
      return;
    }

    if (!eng.sound) {
      eng.sound = true;
      eng.analyser = eng.ctx.createAnalyser();
      eng.analyser.fftSize = 1024;                 // 512 time-domain points for the terrain
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
      try { eng.reverb.buffer = sigilIR(eng.ctx, app.sigil, renderSpec ? cur.variant : cur.variant); }
      catch (e) { console.warn('[sound] sigil reverb failed:', e.message); }
    }

    ensureChorus(eng);
    if (eng.buses) {
      eng.buses.lead.connect(eng.chorusIn);
      eng.buses.pad.connect(eng.chorusIn);
      // Drum bus gets its own shaper for glue and punch.
      if (!eng.drumShaped) {
        const ws = eng.ctx.createWaveShaper();
        ws.curve = drumCurve(eng);
        ws.oversample = '2x';
        eng.drumIn = ws;
        ws.connect(eng.buses.drums);
        eng.drumShaped = true;
      } else {
        eng.drumIn.disconnect();
        eng.drumIn.connect(eng.buses.drums);
      }
    }
    pushFx(eng);
    warmCells(eng);
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
    if (!ctx.audioWorklet || !window.AudioWorkletNode) {
      console.warn('[sound] AudioWorklet unsupported; bit-crusher bypassed.');
      return false;
    }
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
      o.setPeriodicWave(cellWave(eng, x, y, P));
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
    return schedule(ctx, nodes, t, end, hold, amp);
  }

    /**
   * Vox v2. The sigil does the singing:
   *   • the consonant at that beat articulates the note's onset, as a plosive
   *     burst, a fricative hiss, a nasal hum or a liquid glide
   *   • the vowel comes from the vowels you struck out, when they are known,
   *     and from the melody's degree when they are not
   *   • the vowel morphs across the note, as a singer's does
   */
    function voiceVox(eng, ev, t, P, bus, hold) {
      const ctx = eng.ctx, f = mtof(ev.midi), d = hold ? 3 : ev.dur * eng.spb;
      const lean = leaning(takeVoice(ctx, t + d + 1));
  
      const src = ctx.createOscillator();
      src.setPeriodicWave(eng.glottalWave);
      const nodes = [src];
  
      /* Consonant: the letter sounding at this beat decides the articulation. */
      const sig = app.sigil;
      const letter = sig ? sig.reduced[mod(Math.round((ev.beat ?? 0) * 2), sig.reduced.length)] : 'T';
      const cls = SD.CONSONANT_CLASS[letter] || 'fricative';
  
      // A liquid glides into pitch; a plosive snaps to it.
      const startF = cls === 'liquid' ? f * 0.82 : (ev.from != null ? mtof(ev.from) : f);
      src.frequency.setValueAtTime(startF, t);
      if (cls === 'liquid') src.frequency.exponentialRampToValueAtTime(f, t + 0.09);
      else if (ev.from != null) src.frequency.exponentialRampToValueAtTime(f, t + 0.08);
  
      if (!hold && !lean) nodes.push(vibrato(ctx, t, d, [src], f * 0.006));
  
      /* Vowel: struck vowels first, otherwise the melody's own degree. */
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
        // Nasals start with a closed, darker tract that opens into the vowel.
        const open = cls === 'nasal' ? 0.75 : 1;
        bp.frequency.setValueAtTime(V0.f[i] * tk * open, t);
        bp.frequency.linearRampToValueAtTime(V1.f[i] * tk, morph);
        const g = ctx.createGain();
        g.gain.value = V0.g[i] * (cls === 'nasal' && i > 1 ? 0.5 : 1);
        src.connect(bp); bp.connect(g); g.connect(sum);
      }
  
      const amp = ctx.createGain();
      sum.connect(amp);
      amp.connect(bus);
  
      /* The consonant itself, as a short articulation before the vowel. */
      if (!lean) {
        const tone = SD.CLASS_TONE[cls];
        const burst = ctx.createBufferSource();
        burst.buffer = eng.noiseBuf;
        burst.loop = true;
        const bf = ctx.createBiquadFilter();
        bf.type = cls === 'plosive' ? 'bandpass' : 'highpass';
        bf.frequency.value = (cls === 'plosive' ? 1800 : 3600) * tone[0];
        bf.Q.value = cls === 'plosive' ? 1.4 : 0.7;
        const bg = ctx.createGain();
        const level = ev.vel * (cls === 'fricative' ? 0.13 : cls === 'plosive' ? 0.18 : 0.05) * (0.5 + P.breath);
        const len = cls === 'fricative' ? 0.09 : 0.022;
        bg.gain.setValueAtTime(0, t);
        bg.gain.linearRampToValueAtTime(level, t + 0.003);
        bg.gain.setTargetAtTime(0, t + 0.004, len);
        burst.connect(bf); bf.connect(bg); bg.connect(amp);
        nodes.push(burst);
  
        // A plosive also thumps the tract.
        if (cls === 'plosive') {
          const thump = ctx.createOscillator();
          thump.type = 'sine';
          thump.frequency.setValueAtTime(f * 0.5, t);
          const tg = ctx.createGain();
          tg.gain.setValueAtTime(ev.vel * 0.12, t);
          tg.gain.setTargetAtTime(0, t + 0.002, 0.018);
          thump.connect(tg); tg.connect(amp);
          nodes.push(thump);
        }
      }
  
      /* Chest: a sub under the voice. */
      if (P.sub > 0.02 && !lean) {
        const s = ctx.createOscillator();
        s.type = 'sine';
        s.frequency.setValueAtTime(f / 2, t);
        const sg = ctx.createGain();
        sg.gain.value = P.sub * 0.22;
        s.connect(sg); sg.connect(amp);
        nodes.push(s);
      }
  
      /* Breath beneath the note. */
      if (P.breath > 0.01 && !lean) {
        const br = ctx.createBufferSource();
        br.buffer = eng.noiseBuf; br.loop = true;
        const bf2 = ctx.createBiquadFilter();
        bf2.type = 'bandpass'; bf2.frequency.value = 3200 * tk; bf2.Q.value = 0.9;
        const bg2 = ctx.createGain();
        const bl = P.breath * 0.06 * ev.vel;
        bg2.gain.setValueAtTime(0, t);
        bg2.gain.linearRampToValueAtTime(bl, t + 0.04);
        bg2.gain.linearRampToValueAtTime(bl * 0.4, t + d);
        br.connect(bf2); bf2.connect(bg2); bg2.connect(amp);
        nodes.push(br);
      }
  
      lastVowel = { name: V0.name, at: performance.now() };
      const end = shape(eng, amp, t, d, ev.vel * 0.42 * (ev.type === 'harm' ? 0.7 : 1), hold);
      return schedule(ctx, nodes, t, end, hold, amp);
    }

    /**
   * FM. The cube cell is the carrier, so the sigil's spectrum is still the
   * source; a sine modulator at a sigil-derived ratio adds sidebands. The index
   * falls over the note, which is what makes FM read as a struck sound.
   */
    function voiceFm(eng, ev, t, P, bus, hold) {
      const ctx = eng.ctx, f = mtof(ev.midi), d = hold ? 3 : ev.dur * eng.spb;
      const lean = leaning(takeVoice(ctx, t + d + 1));
  
      const car = ctx.createOscillator();
      car.setPeriodicWave(cellWave(eng, P.wave, P.layer, P));
      car.frequency.setValueAtTime(ev.from != null ? mtof(ev.from) : f, t);
      if (ev.from != null) car.frequency.exponentialRampToValueAtTime(f, t + 0.08);
  
      const ratio = 1 + (Math.round(P.wave) % 5) + (Math.round(P.layer) % 2) * 0.5;
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(f * ratio, t);
      const mg = ctx.createGain();
      const index = f * (0.6 + 3.4 * P.bright) * ev.vel;
      mg.gain.setValueAtTime(index, t);
      mg.gain.setTargetAtTime(index * 0.08, t + 0.004, 0.06 + 0.3 * d);
      mod.connect(mg); mg.connect(car.frequency);
  
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 0.6;
      lp.frequency.setValueAtTime(Math.min(16000, f * (6 + 12 * P.bright)), t);
      const amp = ctx.createGain();
      car.connect(lp); lp.connect(amp); amp.connect(bus);
  
      const nodes = [car, mod];
      if (P.sub > 0.02 && !lean) {
        const s = ctx.createOscillator();
        s.type = 'sine';
        s.frequency.setValueAtTime(f / 2, t);
        const sg = ctx.createGain();
        sg.gain.value = P.sub * 0.4;
        s.connect(sg); sg.connect(amp);
        nodes.push(s);
      }
      const end = shape(eng, amp, t, d, ev.vel * 0.3, hold);
      return schedule(ctx, nodes, t, end, hold, amp);
    }
  
    /**
     * Bow. A slow swell on two detuned cube oscillators, with a noise-driven
     * wobble on the filter that stands in for bow pressure. Sustains well, so it
     * suits pads, held keys and the Reversal.
     */
    function voiceBow(eng, ev, t, P, bus, hold) {
      const ctx = eng.ctx, f = mtof(ev.midi), d = hold ? 3 : ev.dur * eng.spb;
      const lean = leaning(takeVoice(ctx, t + d + 1));
  
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 1.6;
      const cut = f * (2.5 + 8 * P.bright);
      lp.frequency.setValueAtTime(cut * 0.5, t);
      lp.frequency.linearRampToValueAtTime(cut, t + Math.min(0.5, d * 0.5));
  
      const nodes = [];
      for (const dt of lean ? [0] : [-7, 7]) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(cellWave(eng, P.wave, P.layer, P));
        o.detune.value = dt;
        o.frequency.setValueAtTime(ev.from != null ? mtof(ev.from) : f, t);
        if (ev.from != null) o.frequency.exponentialRampToValueAtTime(f, t + 0.12);
        o.connect(lp);
        nodes.push(o);
      }
  
      // Bow pressure: filtered noise pushed into the filter's cutoff.
      if (!lean) {
        const n = ctx.createBufferSource();
        n.buffer = eng.noiseBuf; n.loop = true;
        const nf = ctx.createBiquadFilter();
        nf.type = 'lowpass'; nf.frequency.value = 9;
        const ng = ctx.createGain();
        ng.gain.value = cut * 0.25 * (0.3 + P.breath);
        n.connect(nf); nf.connect(ng); ng.connect(lp.frequency);
        nodes.push(n);
      }
  
      const amp = ctx.createGain();
      lp.connect(amp); amp.connect(bus);
      const end = hold
        ? shape(eng, amp, t, d, ev.vel * 0.3, true)
        : eng.adsr(amp.gain, t, d, { a: 0.12, d: 0.3, s: 0.9, r: 0.35, peak: ev.vel * 0.3 });
      return schedule(ctx, nodes, t, end, hold, amp);
    }
  
    /**
     * Bell. The cube cell struck, with an inharmonic partner at 2.76× and a
     * shimmer an octave and a fifth above. All three decay at different rates,
     * which is what makes a bell sound alive rather than like a filtered pulse.
     */
    function voiceBell(eng, ev, t, P, bus, hold) {
      const ctx = eng.ctx, f = mtof(ev.midi), d = hold ? 3 : ev.dur * eng.spb;
      const lean = leaning(takeVoice(ctx, t + d + 1));
      const ring = Math.max(d * 1.6, 1.1) * (0.6 + 0.8 * P.hDecay ?? 1);
  
      const amp = ctx.createGain();
      amp.connect(bus);
      const nodes = [];
      const partial = (mult, level, decay, wave) => {
        const o = ctx.createOscillator();
        if (wave) o.setPeriodicWave(cellWave(eng, P.wave, P.layer, P));
        else o.type = 'sine';
        o.frequency.setValueAtTime(f * mult, t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(level, t + 0.004);
        g.gain.setTargetAtTime(0, t + 0.004, decay);
        o.connect(g); g.connect(amp);
        nodes.push(o);
      };
      partial(1, 0.5, ring * 0.45, true);
      partial(2.76, 0.22 * (0.4 + P.bright), ring * 0.3, false);
      if (!lean) partial(3.01, 0.1 * (0.3 + P.bright), ring * 0.18, false);
      if (P.sub > 0.02) partial(0.5, P.sub * 0.3, ring * 0.6, false);
  
      amp.gain.value = ev.vel * 0.7;
      const end = t + ring + 0.4;
      return schedule(ctx, nodes, t, end, hold, amp);
    }
  
    /** Which voice a lead note uses, given the patch and the score's own timbre. */
    function pickVoice(P, ev) {
      if (P.voice && P.voice !== 'auto') return P.voice;
      if (ev && ev.timbre === 'reed') return 'vox';
      if (ev && ev.timbre === 'koto') return 'bell';
      return 'wave';
    }
  
    const VOICE_FN = { wave: voiceWave, vox: voiceVox, fm: voiceFm, bow: voiceBow, bell: voiceBell };

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
    const end = shape(eng, amp, t, d, ev.vel * 0.05, hold);
    return schedule(ctx, nodes, t, end, hold, amp);
  }

  /* ── Drum engine v3 ──────────────────────────────────────────────────── */

  /**
   * The kick's tonic, in Hz. The tail lands on the song's own tonic pitch
   * class, folded into 41–58 Hz, so the kick is a chord tone.
   */
  function kickTonic(eng) {
    const song = app.song;
    const pc = song ? song.tonicPc : 0;
    let m = 24 + pc;                         // C1 … B1
    let f = mtof(m);
    while (f < 40.5) { m += 12; f = mtof(m); }
    while (f > 58) { m -= 12; f = mtof(m); }
    return f;
  }

  function letterAt(beat) {
    const sig = app.sigil;
    if (!sig) return 'T';
    return sig.reduced[mod(Math.round(beat * 4), sig.reduced.length)];
  }
  function classTone(beat) {
    return SD.CLASS_TONE[SD.CONSONANT_CLASS[letterAt(beat)] || 'fricative'];
  }

  /**
   * Kick: four stacked layers, all tuned.
   *   1 transient  a 3 ms filtered noise tick (the beater)
   *   2 click      a fast high sine chirp that gives the attack its edge
   *   3 body       a sine swept from about four times the tonic down to it
   *   4 sub        a pure tonic sine that survives the body, for weight
   * Everything passes through the drum bus shaper, so hard hits compress.
   */
  function kick(eng, ev, t, P, K, lvl) {
    const ctx = eng.ctx, dest = eng.drumIn || eng.buses.drums;
    const f0 = kickTonic(eng) * (0.94 + 0.12 * K.tune);
    const vel = ev.vel * lvl;
    const decay = 0.16 + 0.42 * K.decay;

    // 3 · body
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(f0 * 5.5, t);
    body.frequency.exponentialRampToValueAtTime(f0 * 1.9, t + 0.016);
    body.frequency.exponentialRampToValueAtTime(f0, t + 0.055 + 0.06 * K.decay);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(vel * 0.95, t + 0.002);
    bg.gain.exponentialRampToValueAtTime(0.0008, t + decay);
    body.connect(bg); bg.connect(dest);
    body.start(t); body.stop(t + decay + 0.12);

    // 4 · sub, held on the tonic under the body
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(f0, t);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(vel * 0.5 * (0.6 + 0.6 * P.sub), t + 0.012);
    sg.gain.exponentialRampToValueAtTime(0.0006, t + decay * 1.45);
    sub.connect(sg); sg.connect(dest);
    sub.start(t); sub.stop(t + decay * 1.5 + 0.1);

    // 2 · click
    const click = ctx.createOscillator();
    click.type = 'triangle';
    click.frequency.setValueAtTime(f0 * 16, t);
    click.frequency.exponentialRampToValueAtTime(f0 * 4, t + 0.012);
    const cg = ctx.createGain();
    eng.perc(cg.gain, t, vel * 0.3 * K.click, 0.0045);
    click.connect(cg); cg.connect(dest);
    click.start(t); click.stop(t + 0.08);

    // 1 · transient
    const n = eng.noise(t, 0.02);
    const nf = eng.filt('lowpass', 1800 + 3200 * K.click, 0.8);
    const ng = ctx.createGain();
    eng.perc(ng.gain, t, vel * 0.26 * K.click, 0.0035);
    n.connect(nf); nf.connect(ng); ng.connect(dest);

    // Punch: a short dip in the kick's own level right after the peak reads as
    // compression without the cost of a compressor per hit.
    const post = ctx.createGain();
    post.gain.setValueAtTime(1, t);
    post.gain.setValueAtTime(1 - 0.25 * K.punch, t + 0.008);
    post.gain.linearRampToValueAtTime(1, t + 0.09);
    bg.disconnect(); bg.connect(post); post.connect(dest);
  }

  function snare(eng, ev, t, P, K, lvl) {
    const ctx = eng.ctx, dest = eng.drumIn || eng.buses.drums;
    const vel = ev.vel * lvl, tone = classTone(ev.beat || 0);
    const dec = (0.05 + 0.17 * K.snap) * tone[1];
    const tonic = kickTonic(eng);

    const n = eng.noise(t, 0.6);
    const bp = eng.filt('bandpass', (1200 + 1500 * K.noiseTone) * tone[0], 0.65);
    const hp = eng.filt('highpass', 820, 0.6);
    const g = ctx.createGain();
    eng.perc(g.gain, t, vel * 0.48 * tone[2], dec);
    n.connect(bp); bp.connect(hp); hp.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = (ev.pan || 0) * 0.4;
      g.connect(p); p.connect(dest);
    } else g.connect(dest);

    // Two body partials tuned to the song: a fifth apart, like a real shell.
    for (const [mul, lev, dk] of [[3, 0.26, 0.03], [4.5, 0.14, 0.022]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const bf = tonic * mul * (0.9 + 0.25 * K.body);
      o.frequency.setValueAtTime(bf * 1.25, t);
      o.frequency.exponentialRampToValueAtTime(bf, t + 0.04);
      const og = ctx.createGain();
      eng.perc(og.gain, t, vel * lev, dk);
      o.connect(og); og.connect(dest);
      o.start(t); o.stop(t + 0.3);
    }
  }

  function hat(eng, ev, t, P, K, lvl) {
    const ctx = eng.ctx, dest = eng.drumIn || eng.buses.drums;
    const vel = ev.vel * lvl, tone = classTone(ev.beat || 0);
    const dec = (ev.open ? 0.11 : 0.012) * (0.6 + 0.9 * K.hatDecay) * tone[1];
    const n = eng.noise(t, 0.45);
    const hp = eng.filt('highpass', (6200 + 3200 * K.hatTone) * tone[0], 0.7);
    const bp = eng.filt('bandpass', (9000 + 3000 * K.hatTone) * tone[0], 0.9);
    const g = ctx.createGain();
    eng.perc(g.gain, t, vel * 0.15 * tone[2], dec);
    n.connect(hp); hp.connect(bp); bp.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = (ev.pan || 0) * (K.width || 0.5);
      g.connect(p); p.connect(dest);
    } else g.connect(dest);
  }

  function drumVoice(eng, ev, t, P, K) {
    const lvl = P.drums;
    switch (ev.type) {
      case 'kick': return kick(eng, ev, t, P, K, lvl);
      case 'snare': return snare(eng, ev, t, P, K, lvl);
      case 'hat': return hat(eng, ev, t, P, K, lvl);
      case 'shaker': {
        const ctx = eng.ctx, dest = eng.drumIn || eng.buses.drums;
        const n = eng.noise(t, 0.2);
        const bp = eng.filt('bandpass', 5200 + 2600 * K.hatTone, 1.2);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(ev.vel * lvl * 0.11, t + 0.014);
        g.gain.setTargetAtTime(0, t + 0.014, 0.024);
        n.connect(bp); bp.connect(g); g.connect(dest);
        return;
      }
      case 'crash': {
        const n = eng.noise(t, 2);
        const hp = eng.filt('highpass', 3600, 0.5);
        const g = eng.ctx.createGain();
        eng.perc(g.gain, t, ev.vel * lvl * 0.12, 0.5 + 0.4 * K.hatDecay);
        n.connect(hp); hp.connect(g); g.connect(eng.buses.bell);
      }
    }
  }

  /* ── Hook ────────────────────────────────────────────────────────────── */

  /* ── Visual feeds ────────────────────────────────────────────────────── */

  /** The wheel's waveform: a clean cycle and its crushed version, 128 points each. */
  function ringFor(tb, P) {
    const a = tb.cell(P.wave, P.layer), b = tb.cell(P.wave + P.sweep * 4, P.layer + P.drift * 2.5);
    const N = 128, raw = SD.waveSamples(a, b, 0.5, N), clean = new Float32Array(N);
    let mx = 1e-9;
    for (let i = 0; i < N; i++) {
      clean[i] = raw[i] + P.sub * 0.6 * Math.sin((Math.PI * i) / N);
      if (Math.abs(clean[i]) > mx) mx = Math.abs(clean[i]);
    }
    for (let i = 0; i < N; i++) clean[i] /= mx;
    const crushed = SD.applyFx(clean, {
      bits: P.grit > 0 ? P.bits : 16, hold: P.hold, fold: P.fold, drive: P.drive, mix: P.grit,
    });
    return { clean, crushed };
  }

  /** Recent onsets, for the ripples. Wall-clock time for keys, beats for the score. */
  const LOGGED = new Set(['lead', 'harm', 'pad', 'kick', 'snare']);
  const notes = [];
  function logNote(ev) {
    notes.push({ beat: ev.beat ?? null, at: performance.now(), kind: ev.type });
    if (notes.length > 48) notes.shift();
  }

  /** Route each event to a voice. Drums belong to the DrumEngine (m15), so we pass them by. */
  function voiceHook(_, ev, t, eng) {
    if (prefs.mode !== 'sigil' || !eng.sig || !eng.buses) return null;
    if (LOGGED.has(ev.type)) logNote(ev);
    const { P } = patchFor(eng, ev);
    switch (ev.type) {
      case 'lead': {
        const fn = VOICE_FN[pickVoice(P, ev)] || voiceWave;
        fn(eng, ev, t, P, eng.buses.lead, false);
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
    if (eng.isDSP) return eng.noteOn({ midi, deg, vel });
    const P = eng.sig.P, t = eng.ctx.currentTime, bus = playBus(eng);
    const ev = { type: 'lead', midi, deg, vel, timbre: 'glass', beat: 0 };
    const fn = VOICE_FN[pickVoice(P, ev)] || voiceWave;
    return fn(eng, ev, t, P, bus, true);
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
      app.engine.sig.P = cur.P;
      buildArc(app.engine);
      pushFx(app.engine);
    }
  };

  const api = {
    SD, prepare, attach, noteOn, live,
    paramsAt(eng, beat) {
      if (!eng || !eng.sig) return null;
      const { P, K } = patchFor(eng, { beat });
      return { ...P, kit: K };
    },
    recentNotes: () => notes,
    setMany(obj) {
      if (!app.sigil) return;
      Object.assign(cur.o, obj);
      persist(); recompute(); refreshEngine(); notify();
    },
    view: () => cur,
    state: () => ({ key: cur.key, variant: cur.variant, o: cur.o, P: cur.P, base: cur.base, tables: cur.tables, mags: cur.mags }),
    /**
     * The knob overrides that WILL apply to a sigil once it is loaded: a shared link's patch,
     * else this device's bank. For code that runs at composition time, before attach() has
     * synced the live patch to the new sigil (the drum engine reads `take` this way).
     */
    overridesFor(sig) {
      if (!sig) return {};
      const key = keyOf(sig);
      if (pending && pending.key === key) return { ...pending.o };
      if (key === cur.key && cur.P) return { ...cur.o };
      return { ...((bank[key] && bank[key].o) || {}) };
    },
    get mode() { return prefs.mode; },
    get lite() { return prefs.lite; },
    get keysOn() { return prefs.keys; },
    get frozen() { return frozen; },
    get lensWave() { return prefs.lensWave; },
    get vowelMemoryOn() { return prefs.vowelMemory; },
    get arcOn() { return prefs.arc; },
    get sigilVerbOn() { return prefs.sigilVerb; },
    hasVowelMemory: () => !!(vowelMemory && vowelMemory.length),
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
            ? sigilIR(app.engine.ctx, app.sigil, cur.variant)
            : Engine.sharedIR(app.engine.ctx);
        } catch (e) { console.warn(e); }
      }
      notify();
    },
    toggleKeys(force) { prefs.keys = force ?? !prefs.keys; notify(); return prefs.keys; },
    toggleFreeze(force) { frozen = force ?? !frozen; notify(); return frozen; },

    set(name, v) { if (!app.sigil) return; cur.o[name] = v; persist(); recompute(); refreshEngine(); notify(); },
    /** Return one knob to this sigil's own value (and drop it from the patch code). */
    unset(name) { if (!app.sigil) return; delete cur.o[name]; persist(); recompute(); refreshEngine(); notify(); },
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
    currentSpec: () => specFor(),                                             // honours setRenderSpec (Evolve)
    vowelMemory: () => (prefs.vowelMemory && vowelMemory ? vowelMemory.slice() : null),
  };

  return api;
})();

if (typeof window !== 'undefined') window.Sound = Sound;