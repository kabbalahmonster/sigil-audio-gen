'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M11 · INSTRUMENT — the generative synthesiser
   --------------------------------------------------------------------------
   Replaces the Engine's melodic voices with sigil-derived synthesis, adds a
   master effects rack, a voice budget and quality tiers. The classic voices
   are preserved and reachable via patch.engine = 0 (the "Classic" toggle), so
   nothing is lost.

   Patch points claimed: load, lead, pad, bass, arp, harm.
   Depends on: 09-dsp.js. Cooperates with M9 (which wraps play) and M7 (offline
   render, which must await engine.rackReady and set engine.originTime).
   ══════════════════════════════════════════════════════════════════════════ */
const Instrument = (() => {
  'use strict';

  /* ── Quality tiers ───────────────────────────────────────────────────── */
  const TIERS = {
    low:      { unison: 1, morph: false, breath: false, voices: 14, chorus: false, bins: 0 },
    balanced: { unison: 2, morph: false, breath: true,  voices: 24, chorus: true,  bins: 32 },
    high:     { unison: 3, morph: true,  breath: true,  voices: 40, chorus: true,  bins: 64 },
  };

  function autoTier() {
    const c = navigator.hardwareConcurrency || 4;
    const mobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
    if (c <= 2 || (mobile && c <= 4)) return 'low';
    return c >= 8 && !mobile ? 'high' : 'balanced';
  }

  let tierName = Prefs.get('quality', 'auto');
  const tier = () => TIERS[tierName === 'auto' ? autoTier() : tierName] || TIERS.balanced;

  /* ── Patch state ─────────────────────────────────────────────────────── */
  const LIB = 'patches';                    // Prefs key → { sigilKey: 'P…' }
  let pendingLink = null;                   // patch from a shared link, used once
  let struckVowels = null;                  // captured from the desire, never stored
  let override = null;                      // the live, user-edited patch

  const keyOf = (sig) => (sig && (sig.fusionKey || sig.reduced)) || '';

  /** Resolve the patch for a sigil: user override → link → saved → native. */
  function patchFor(sigil) {
    if (override) return override;
    if (pendingLink) { const p = pendingLink; pendingLink = null; return (override = p); }
    const saved = Prefs.get(LIB, {})[keyOf(sigil)];
    const dec = saved && DSP.decodePatch(saved);
    return (override = dec || DSP.defaultPatch(sigil));
  }

  const get = () => override;
  function set(p, { apply = true } = {}) {
    override = p;
    if (apply && app.engine && app.engine.patch) { app.engine.patch = p; app.engine.applyPatch(); }
    Hooks.emit('patch', p);
  }
  function save() {
    if (!app.sigil || !override) return;
    const lib = Prefs.get(LIB, {});
    lib[keyOf(app.sigil)] = DSP.encodePatch(override);
    Prefs.set(LIB, lib);
  }
  function reset() { if (app.sigil) set(DSP.defaultPatch(app.sigil)); }

  Hooks.on('beforeCast', (ctx) => {
    override = null;                                        // each casting re-resolves
    struckVowels = [...ctx.text.toUpperCase()].filter((c) => DSP.FORMANTS[c] && 'AEIOU'.includes(c)).join('');
  });
  Hooks.on('link', (link) => { if (link.patch) pendingLink = DSP.decodePatch(link.patch); });
  Hooks.on('shareKey', (key, sig) => {
    const p = get();
    return p && DSP.isEdited(p, sig) ? key + '!' + DSP.encodePatch(p) : undefined;
  }, 20);
  Hooks.on('meta', (parts) => {
    const p = get();
    if (p && p.engine === 1) parts.splice(2, 1, ['wavetable', 'voice', 'bell'][p.leadVoice] + ' · sigil');
  });

  /* ── Bit-crush AudioWorklet. Decimation (sample & hold) plus quantisation.
        Loaded from a blob so it works offline; a WaveShaper staircase is the
        fallback when AudioWorklet is unavailable. ───────────────────────── */
  const CRUSH_SRC = `
class C extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name:'bits', defaultValue:16, minValue:1, maxValue:16, automationRate:'k-rate' },
    { name:'step', defaultValue:1, minValue:0.02, maxValue:1, automationRate:'k-rate' },
    { name:'mix',  defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate' }]; }
  constructor(){ super(); this.h=[0,0]; this.p=0; }
  process(inp, out, p) {
    const I = inp[0], O = out[0];
    if (!I || !I.length) return true;
    const lv = Math.pow(2, p.bits[0] - 1), step = p.step[0], mix = p.mix[0];
    for (let i = 0; i < O[0].length; i++) {
      this.p += step;
      let adv = false;
      if (this.p >= 1) { this.p -= 1; adv = true; }
      for (let c = 0; c < O.length; c++) {
        const x = (I[c] || I[0])[i];
        if (adv) this.h[c] = Math.round(x * lv) / lv;
        O[c][i] = x + (this.h[c] - x) * mix;
      }
    }
    return true;
  }
}
registerProcessor('sigil-crush', C);`;

  const workletFor = new WeakMap();
  function ensureWorklet(ctx) {
    if (workletFor.has(ctx)) return workletFor.get(ctx);
    let p;
    try {
      const url = URL.createObjectURL(new Blob([CRUSH_SRC], { type: 'text/javascript' }));
      p = ctx.audioWorklet.addModule(url).then(() => true).catch(() => false);
    } catch { p = Promise.resolve(false); }
    workletFor.set(ctx, p);
    return p;
  }

  /* ══════════════════════════════════════════════════════════════════════
     ENGINE EXTENSIONS
     ══════════════════════════════════════════════════════════════════════ */
  ['load', 'lead', 'pad', 'bass', 'arp', 'harm'].forEach((m) => Engine.claim(m, 'M11 Instrument'));

  const _load = Engine.prototype.load;
  Engine.prototype.load = function (song) {
    _load.call(this, song);
    this.patch = patchFor(app.sigil);
    this.tier = tier();
    this.buildInstrument(app.sigil);
  };

  /** Build tables, the rack and the analyser. Idempotent per song. */
  Engine.prototype.buildInstrument = function (sigil) {
    const c = this.ctx, T = this.tier;
    this.voiceEnds = [];
    if (!sigil) return;

    /* Wavetables. Cheap enough to rebuild per song; cached per sigil hash. */
    const cacheKey = sigil.hex;
    Engine._wt = Engine._wt || {};
    const tables = (Engine._wt[cacheKey] = Engine._wt[cacheKey] || {
      lead: DSP.wavetable(sigil, 'lead'),
      pad: DSP.wavetable(sigil, 'pad'),
      bass: DSP.wavetable(sigil, 'bass'),
      glottal: DSP.glottal(sigil),
    });
    const wave = (t) => c.createPeriodicWave(t.real, t.imag, { disableNormalization: false });
    this.waves = {
      lead: wave(tables.lead), pad: wave(tables.pad),
      bass: wave(tables.bass), glottal: wave(tables.glottal),
    };
    this.profile = tables.lead.profile;              // the renderer draws this
    this.vowels = DSP.vowelsOf(sigil, this.patch.vowelSource ? struckVowels : null);

    /* ── FX rack, inserted between mix and tone ── */
    if (this.rack) { try { this.rack.in.disconnect(); this.rack.out.disconnect(); } catch {} }
    const input = this.gain(1), output = this.gain(1);

    const drive = c.createWaveShaper();
    drive.oversample = '2x';
    const crushFallback = c.createWaveShaper();
    const chorusIn = this.gain(1), chorusWet = this.gain(0), chorusDry = this.gain(1);
    const air = c.createBiquadFilter();
    air.type = 'highshelf'; air.frequency.value = 6500; air.gain.value = 0;

    input.connect(drive);
    drive.connect(crushFallback);
    crushFallback.connect(chorusIn);
    chorusIn.connect(chorusDry); chorusDry.connect(air);

    /* Chorus: two short modulated taps, fed by ONE shared LFO.
       originTime aligns the LFO phase so M7's parallel segments match. */
    let lfo = null, chorusTaps = [];
    if (T.chorus) {
      lfo = this.osc('sine', 0.25, 0);
      const f = 0.25, origin = this.originTime || 0;
      const delay = (1 / f) - mod(origin, 1 / f);
      lfo.start(delay);
      for (const [base, depth, pan] of [[0.0072, 0.0022, -0.6], [0.0113, 0.0017, 0.6]]) {
        const d = c.createDelay(0.06);
        d.delayTime.value = base;
        const mg = this.gain(depth);
        lfo.connect(mg); mg.connect(d.delayTime);
        const p = c.createStereoPanner ? c.createStereoPanner() : null;
        chorusIn.connect(d);
        if (p) { p.pan.value = pan; d.connect(p); p.connect(chorusWet); } else d.connect(chorusWet);
        chorusTaps.push(d);
      }
      chorusWet.connect(air);
    }
    air.connect(output);

    // Rewire the master chain: mix → rack → tone
    try { this.mix.disconnect(); } catch {}
    this.mix.connect(input);
    output.connect(this.tone);

    this.rack = { in: input, out: output, drive, crushFallback, crushNode: null, chorusWet, chorusDry, air, lfo };

    /* Real crusher, when the worklet is available. Spliced in asynchronously;
       the WaveShaper fallback carries the signal until then. */
    this.rackReady = ensureWorklet(c).then((ok) => {
      if (!ok || !this.rack || this.rack.crushNode) return;
      try {
        const n = new AudioWorkletNode(c, 'sigil-crush', { outputChannelCount: [2] });
        crushFallback.disconnect();
        crushFallback.connect(n);
        n.connect(chorusIn);
        this.rack.crushNode = n;
        this.applyPatch();
      } catch { /* keep the fallback */ }
    });

    /* Analyser for the visuals. Live contexts only; it costs nothing offline. */
    if (T.bins && c.createAnalyser && !this.analyser) {
      this.analyser = c.createAnalyser();
      this.analyser.fftSize = T.bins * 4;
      this.analyser.smoothingTimeConstant = 0.75;
      this.comp.connect(this.analyser);
    }

    this.applyPatch();
  };

  /** Push patch values into the rack and cache derived numbers for the voices. */
  Engine.prototype.applyPatch = function () {
    const p = this.patch, r = this.rack;
    if (!p) return;
    const now = this.ctx.currentTime;

    // Derived per-voice numbers, read on every note.
    this.vp = {
      cutoff: 280 * Math.pow(26, p.bright),            // 280 Hz … 7.3 kHz
      q: 0.6 + p.reso * 7,
      att: 0.004 + Math.pow(p.attack, 2) * 0.6,
      rel: 0.08 + Math.pow(p.release, 2) * 1.8,
      detune: p.detune,
      sub: p.sub,
      morph: this.tier.morph ? p.morph : 0,
      vib: p.vibrato,
      breath: this.tier.breath ? p.breath : 0,
    };
    if (!r) return;

    // Drive: tanh curve, amount 1 … 14
    const k = 1 + p.drive * 13, curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    r.drive.curve = curve;

    // Crush
    const bits = 16 - Math.round(p.crush * 12);                 // 16 … 4 bits
    const step = 1 - (1 - p.crushRate) * 0.96;                  // sample-rate ratio
    if (r.crushNode) {
      r.crushNode.parameters.get('bits').setValueAtTime(bits, now);
      r.crushNode.parameters.get('step').setValueAtTime(Math.max(0.02, p.crush > 0.02 ? step : 1), now);
      r.crushNode.parameters.get('mix').setValueAtTime(p.crush > 0.02 ? 1 : 0, now);
      r.crushFallback.curve = null;
    } else if (p.crush > 0.02) {                                 // quantise only
      const lv = Math.pow(2, bits - 1), cs = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) {
        const x = (i / 2047) * 2 - 1;
        cs[i] = x + (Math.round(x * lv) / lv - x) * 1;
      }
      r.crushFallback.curve = cs;
    } else r.crushFallback.curve = null;

    // Chorus + air
    if (r.chorusWet) {
      r.chorusWet.gain.setTargetAtTime(p.chorus * 0.7, now, 0.08);
      r.chorusDry.gain.setTargetAtTime(1 - p.chorus * 0.25, now, 0.08);
      if (r.lfo) r.lfo.frequency.setTargetAtTime(0.12 + p.motion * 1.4, now, 0.1);
    }
    r.air.gain.setTargetAtTime(-4 + p.air * 12, now, 0.1);
  };

  /* ── Voice budget. Scheduled voices are counted by their end time; when the
        ceiling is reached, the quietest incoming notes are dropped rather than
        stealing (cheaper, and it never clicks). ────────────────────────── */
  Engine.prototype.budget = function (t, dur, vel) {
    const cap = this.tier ? this.tier.voices : 24;
    const v = this.voiceEnds || (this.voiceEnds = []);
    for (let i = v.length - 1; i >= 0; i--) if (v[i] < t) { v[i] = v[v.length - 1]; v.pop(); }
    if (v.length >= cap && vel < 0.55) return false;
    if (v.length >= cap + 8) return false;
    v.push(t + dur);
    return true;
  };

  /* ══════════════════════════════════════════════════════════════════════
     VOICES
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * Wavetable voice: 1–3 detuned oscillators on the sigil's own waveform,
   * an optional morph partner, a sub sine, a resonant filter with an envelope
   * that follows velocity, and an ADSR.
   */
  Engine.prototype.wtVoice = function (ev, t, o) {
    const vp = this.vp, f = mtof(ev.midi), d = ev.dur * this.spb, v = ev.vel * (o.gain || 1);
    if (!this.budget(t, d + vp.rel, v)) return;

    const lp = this.filt('lowpass', 200, vp.q);
    const amp = this.gain();
    const nodes = [];

    const open = clamp(vp.cutoff * (0.5 + v) * (o.bright || 1), 120, 13000);
    lp.frequency.setValueAtTime(Math.max(120, open * 0.35), t);
    lp.frequency.linearRampToValueAtTime(open, t + vp.att + 0.02);
    lp.frequency.setTargetAtTime(Math.max(120, open * 0.45), t + vp.att + 0.02, Math.max(0.05, d * 0.6));

    const n = Math.max(1, Math.min(this.tier.unison, o.unison ?? this.tier.unison));
    for (let i = 0; i < n; i++) {
      const osc = this.ctx.createOscillator();
      osc.setPeriodicWave(this.waves[o.wave] || this.waves.lead);
      osc.frequency.setValueAtTime(f, t);
      osc.detune.setValueAtTime((i - (n - 1) / 2) * vp.detune, t);
      if (ev.from) {   // legato glide, as the classic reed had
        osc.frequency.setValueAtTime(mtof(ev.from), t);
        osc.frequency.exponentialRampToValueAtTime(f, t + 0.09);
      }
      const g = this.gain(1 / n);
      osc.connect(g); g.connect(lp);
      nodes.push(osc);
    }

    if (vp.morph > 0.02) {   // blend in the mirrored table: the glyph's other face
      const osc = this.ctx.createOscillator();
      osc.setPeriodicWave(this.waves.pad);
      osc.frequency.setValueAtTime(f, t);
      osc.detune.setValueAtTime(3, t);
      const g = this.gain(vp.morph * 0.6);
      osc.connect(g); g.connect(lp);
      nodes.push(osc);
    }

    if (vp.sub > 0.02 && ev.midi > 36) {
      const sub = this.osc('sine', f / 2, t);
      const g = this.gain(vp.sub * 0.45);
      sub.connect(g); g.connect(amp);      // sub bypasses the filter, stays solid
      nodes.push(sub);
    }

    lp.connect(amp);
    amp.connect(o.out);
    const stop = this.adsr(amp.gain, t, d, {
      a: vp.att, d: 0.25, s: o.sustain ?? 0.7, r: vp.rel * (o.rel || 1), peak: v * (o.peak || 0.36),
    });
    nodes.forEach((x) => { x.start(t); x.stop(stop); });
  };

  /**
   * Vocal voice: a glottal pulse through three parallel bandpass formants.
   * The vowel moves across the note toward the next one in the sequence, which
   * is what makes it read as singing rather than as a filtered buzz.
   */
  Engine.prototype.vocalVoice = function (ev, t, o) {
    const vp = this.vp, f = mtof(ev.midi), d = ev.dur * this.spb, v = ev.vel * (o.gain || 1);
    if (!this.budget(t, d + vp.rel, v)) return;

    const seq = this.vowels || ['A'];
    const i = Math.abs(Math.round((ev.beat || 0) * 2)) % seq.length;
    const A = DSP.FORMANTS[seq[i]], B = DSP.FORMANTS[seq[(i + 1) % seq.length]];

    const src = this.ctx.createOscillator();
    src.setPeriodicWave(this.waves.glottal);
    src.frequency.setValueAtTime(f, t);
    if (ev.from) {
      src.frequency.setValueAtTime(mtof(ev.from), t);
      src.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    }

    // Per-voice vibrato: deterministic, because it starts with the note.
    const nodes = [src];
    if (vp.vib > 0.02) {
      const lfo = this.osc('sine', 4.6 + vp.vib * 1.6, t);
      const lg = this.gain(0);
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(vp.vib * 22, t + Math.min(0.5, d * 0.5));   // cents
      lfo.connect(lg); lg.connect(src.detune);
      nodes.push(lfo);
    }

    const amp = this.gain();
    for (let k = 0; k < 3; k++) {
      const bp = this.filt('bandpass', A.f[k], A.f[k] / DSP.BANDWIDTH[k] * 1.4);
      bp.frequency.setValueAtTime(A.f[k], t);
      bp.frequency.setTargetAtTime(B.f[k], t + d * 0.35, Math.max(0.06, d * 0.5));
      const g = this.gain(A.g[k]);
      src.connect(bp); bp.connect(g); g.connect(amp);
    }

    if (vp.breath > 0.02) {   // the consonant of breath at the attack
      const nz = this.noise(t, Math.min(0.5, d));
      const hp = this.filt('highpass', 2200 + A.f[2] * 0.3, 0.8);
      const ng = this.gain();
      this.perc(ng.gain, t, v * vp.breath * 0.06, 0.07);
      nz.connect(hp); hp.connect(ng); ng.connect(o.out);
    }

    amp.connect(o.out);
    const stop = this.adsr(amp.gain, t, d, {
      a: Math.max(0.03, vp.att), d: 0.3, s: 0.78, r: Math.max(0.18, vp.rel) * (o.rel || 1),
      peak: v * (o.peak || 0.22),
    });
    nodes.forEach((x) => { x.start(t); x.stop(stop); });
  };

  /* ── Routing. Each classic voice is kept and used when engine = 0. ────── */
  const classic = {};
  for (const m of ['lead', 'pad', 'bass', 'arp', 'harm']) classic[m] = Engine.prototype[m];
  const isSigil = (e) => e.patch && e.patch.engine === 1 && e.waves;

  Engine.prototype.lead = function (ev, t) {
    if (!isSigil(this)) return classic.lead.call(this, ev, t);
    const mode = this.patch.leadVoice;
    if (mode === 2) return this.bell(ev.midi, t, ev.vel, this.buses.lead);
    const o = { out: this.buses.lead, wave: 'lead', peak: 0.34, gain: 1 };
    return mode === 1 ? this.vocalVoice(ev, t, { ...o, peak: 0.26 }) : this.wtVoice(ev, t, o);
  };

  Engine.prototype.harm = function (ev, t) {
    if (!isSigil(this)) return classic.harm.call(this, ev, t);
    return this.patch.choirVocal
      ? this.vocalVoice(ev, t, { out: this.buses.harm, peak: 0.17, gain: 0.9, rel: 1.6 })
      : this.wtVoice(ev, t, { out: this.buses.harm, wave: 'pad', peak: 0.14, unison: 2, rel: 1.4 });
  };

  Engine.prototype.pad = function (ev, t) {
    if (!isSigil(this)) return classic.pad.call(this, ev, t);
    // One wavetable voice per chord tone, soft and slow, never more than four.
    const tones = ev.midis.slice(0, 4);
    for (const m of tones) {
      this.wtVoice({ midi: m, dur: ev.dur, vel: ev.vel, beat: ev.beat }, t, {
        out: this.buses.pad, wave: 'pad', unison: 1, peak: 0.05,
        bright: 0.45 + 0.2 * (ev.bright || 0), sustain: 0.9, rel: 2.2,
      });
    }
  };

  Engine.prototype.bass = function (ev, t) {
    if (!isSigil(this)) return classic.bass.call(this, ev, t);
    return this.wtVoice(ev, t, { out: this.buses.bass, wave: 'bass', unison: 1, peak: 0.5, bright: 0.35, rel: 0.4 });
  };

  Engine.prototype.arp = function (ev, t) {
    if (!isSigil(this)) return classic.arp.call(this, ev, t);
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    const out = pan ? (pan.pan.value = ev.pan || 0, pan.connect(this.buses.arp), pan) : this.buses.arp;
    return this.wtVoice({ ...ev, dur: ev.dur }, t, { out, wave: 'lead', unison: 1, peak: 0.2, rel: 0.25, bright: 1.15 });
  };

  /* ── Playable one-shot, used by M13. Returns a release handle. ───────── */
  Engine.prototype.playNote = function (midi, vel = 0.8) {
    if (!this.buses || !this.vp) return null;
    const t = this.ctx.currentTime + 0.005, f = mtof(midi), vp = this.vp;
    const amp = this.gain(), lp = this.filt('lowpass', clamp(vp.cutoff * 1.2, 150, 13000), vp.q);
    const nodes = [];
    const n = Math.max(1, this.tier.unison);
    const useVocal = this.patch && this.patch.engine === 1 && this.patch.leadVoice === 1;

    if (useVocal) {
      const src = this.ctx.createOscillator();
      src.setPeriodicWave(this.waves.glottal);
      src.frequency.setValueAtTime(f, t);
      const V = DSP.FORMANTS[(this.vowels || ['A'])[midi % (this.vowels || ['A']).length]];
      for (let k = 0; k < 3; k++) {
        const bp = this.filt('bandpass', V.f[k], V.f[k] / DSP.BANDWIDTH[k] * 1.4);
        const g = this.gain(V.g[k]);
        src.connect(bp); bp.connect(g); g.connect(amp);
      }
      nodes.push(src);
    } else {
      for (let i = 0; i < n; i++) {
        const o = this.ctx.createOscillator();
        o.setPeriodicWave(this.waves ? this.waves.lead : undefined);
        o.frequency.setValueAtTime(f, t);
        o.detune.setValueAtTime((i - (n - 1) / 2) * vp.detune, t);
        const g = this.gain(1 / n);
        o.connect(g); g.connect(lp);
        nodes.push(o);
      }
      lp.connect(amp);
    }

    amp.connect(this.buses.lead);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel * 0.34, t + Math.max(0.006, vp.att));
    amp.gain.setTargetAtTime(vel * 0.26, t + vp.att, 0.25);
    nodes.forEach((x) => x.start(t));

    let released = false;
    return {
      midi,
      release: () => {
        if (released) return;
        released = true;
        const r = this.ctx.currentTime;
        amp.gain.cancelScheduledValues(r);
        amp.gain.setValueAtTime(amp.gain.value, r);
        amp.gain.setTargetAtTime(0, r, Math.max(0.05, vp.rel * 0.4));
        nodes.forEach((x) => x.stop(r + vp.rel * 2 + 0.2));
      },
    };
  };

  /* ── FPS watchdog: downgrade rather than stutter. ─────────────────────── */
  (function watchdog() {
    let last = performance.now(), acc = 0, n = 0, warned = false;
    function tick(now) {
      const dt = now - last; last = now;
      if (dt < 250) { acc += dt; n++; }
      if (n >= 120) {
        const avg = acc / n; acc = 0; n = 0;
        const current = tierName === 'auto' ? autoTier() : tierName;
        if (avg > 30 && current !== 'low' && !warned) {
          warned = true;
          tierName = current === 'high' ? 'balanced' : 'low';
          Prefs.set('quality', tierName);
          if (app.engine) app.engine.tier = tier();
          Hooks.emit('quality', tierName);
          toast(`Quality lowered to ${tierName} to keep the rite smooth`, true, 3600);
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  return {
    TIERS, tier, patchFor, get, set, save, reset,
    quality: () => tierName,
    setQuality: (q) => { tierName = q; Prefs.set('quality', q); if (app.engine) { app.engine.tier = tier(); } Hooks.emit('quality', q); },
    struck: () => struckVowels,
  };
})();