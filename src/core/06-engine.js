'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §6  AUDIO ENGINE
   --------------------------------------------------------------------------
   Everything is synthesised live with the Web Audio API. There are no samples.

   SIGNAL FLOW
     voices → instrument bus ─┬→ mix → tone (LP) → compressor → out → speakers
                              ├→ convolution reverb (generated IR) → mix
                              └→ tempo-synced feedback delay → mix (+ reverb)

   SCHEDULING — the "two clocks" pattern. A 25 ms JS timer looks a short way
   ahead (`pump`) and books events on the sample-accurate AudioContext clock.

   PER-SONG BUSES — rebuilt on every load(). stop() fades a song's buses and
   disconnects them after the fade. The shared effects (reverb, delay, master)
   persist, so there are no clicks and no orphaned drones.

   ─── PATCH POINTS ──────────────────────────────────────────────────────────
   The following Engine.prototype methods are DELIBERATELY reassigned by
   feature modules. Treat them as public extension points, not private detail:

     start, seek, pump, beatNow   owner: M4 Form & Loop (loop regions)
     setTempo                      owner: M2 Mixer & Tempo (adds it)
     play                          owner: M9 Live Lens (maps events live)

   If you change the signature or the meaning of any of these, update the
   owning module in the same commit. Core code calls them only through the
   instance, so an override is always picked up.
   ══════════════════════════════════════════════════════════════════════════ */

class Engine {
  /**
   * @param {BaseAudioContext} [ctx] optional, e.g. an OfflineAudioContext for
   *        WAV/MP3 rendering (M7). Omit for live playback, which creates an
   *        AudioContext. Creating it inside a user gesture satisfies autoplay.
   */
  constructor(ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = ctx || new AC({ latencyHint: 'interactive' }));

    /* ── Master chain: mix → tone → compressor → out → destination ─────── */
    this.out = this.gain(0.85);
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.ratio.value = 3;
    this.comp.knee.value = 12;
    this.comp.attack.value = 0.008;
    this.comp.release.value = 0.25;

    // Global tone control. Sweeping its frequency is how banish() darkens the room.
    this.tone = c.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 20000;
    this.tone.Q.value = 0.4;

    this.mix = this.gain(1);
    this.mix.connect(this.tone);
    this.tone.connect(this.comp);
    this.comp.connect(this.out);
    this.out.connect(c.destination);

    // Recording tap for video export (M-record). Absent in some offline contexts.
    this.recDest = c.createMediaStreamDestination ? c.createMediaStreamDestination() : null;
    if (this.recDest) this.out.connect(this.recDest);

    /* ── Reverb: a generated impulse response, so there are no files to fetch ── */
    this.reverb = c.createConvolver();
    this.reverb.buffer = Engine.sharedIR(c);
    const rr = this.gain(0.85);            // reverb return level
    this.reverb.connect(rr);
    rr.connect(this.mix);
    this.revReturn = rr;                   // M2 adjusts this live

    /* ── Delay: tempo-synced, with a darkening low-pass in the feedback loop ── */
    this.delayIn = this.gain(1);
    this.delay = c.createDelay(3);
    this.delay.delayTime.value = 0.5;
    const fbf = c.createBiquadFilter();
    fbf.type = 'lowpass';
    fbf.frequency.value = 2600;            // each repeat is darker than the last
    const fb = this.gain(0.36);            // feedback amount
    const dr = this.gain(0.55);            // delay return to the mix
    const d2r = this.gain(0.25);           // delay return into the reverb (smears the echoes)
    this.delayReturn = dr;
    this.delayIn.connect(this.delay);
    this.delay.connect(fbf);
    fbf.connect(fb);
    fb.connect(this.delay);
    fbf.connect(dr);
    dr.connect(this.mix);
    dr.connect(d2r);
    d2r.connect(this.reverb);

    // Shared white noise for drums, breath and fire.
    this.noiseBuf = Engine.sharedNoise(c);

    // Gentle tanh saturation for bass warmth on small speakers. Normalised so
    // the curve passes through (±1, ±1).
    this.satCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      this.satCurve[i] = Math.tanh(1.8 * x) / Math.tanh(1.8);
    }

    this.buses = null;
    this.song = null;
    this.running = false;
    this.anchor = 0;        // context time at which beat 0 occurred
    this.loopIndex = 0;     // how many times the whole song has looped
    this.ptr = 0;           // index of the next event to schedule
    this.timer = null;
    this.reanchorAt = 0;    // used by M4 for gapless loops (0 = none)
  }

  /* ── Node helpers ─────────────────────────────────────────────────────── */

  /** A GainNode initialised to v. */
  gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }

  /** An OscillatorNode with its frequency set at time t (no ramp). */
  osc(type, f, t) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    return o;
  }

  /** A BiquadFilterNode. */
  filt(type, f, q = 0.7) {
    const b = this.ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q;
    return b;
  }

  /**
   * A buffer source playing the shared noise from a pseudo-random offset.
   * The offset comes from `_nr` (set per event in play()) so that noise is
   * deterministic per musical event, which offline rendering depends on.
   */
  noise(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.start(t, (this._nr ? this._nr() : Math.random()) * 1.2, dur);
    return s;
  }

  /**
   * ADSR envelope on an AudioParam, using exponential-ish target curves.
   * @returns {number} a safe stop time for the owning oscillators
   */
  adsr(p, t, dur, { a = 0.01, d = 0.2, s = 0.7, r = 0.3, peak = 1 } = {}) {
    const end = t + Math.max(dur, a + 0.01);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.setTargetAtTime(peak * s, t + a, Math.max(0.001, d / 3));
    p.setTargetAtTime(0, end, Math.max(0.001, r / 3));
    return end + r * 1.7 + 0.05;
  }

  /**
   * Percussive envelope: instant attack, exponential decay with time constant tc.
   * @returns {number} a stop time after the sound has decayed below audibility
   */
  perc(p, t, peak, tc) {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + 0.002);
    p.setTargetAtTime(0, t + 0.002, tc);
    return t + 0.01 + tc * 7;
  }

  /* ── Shared, cached buffers ───────────────────────────────────────────── */

  /**
   * The impulse response, cached per sample rate. Built with a seeded PRNG
   * so the same room is reproduced in every context (live or offline).
   */
  static sharedIR(c) {
    Engine._ir = Engine._ir || {};
    return (Engine._ir[c.sampleRate] =
      Engine._ir[c.sampleRate] || Engine.prototype.makeIR.call({ ctx: c }, 4.2, 2.6));
  }

  /** Two seconds of seeded white noise, cached per sample rate. */
  static sharedNoise(c) {
    Engine._nz = Engine._nz || {};
    const k = c.sampleRate;
    if (!Engine._nz[k]) {
      const b = c.createBuffer(1, k * 2, k);
      const d = b.getChannelData(0);
      const r = mulberry32(0x5eed);
      for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
      Engine._nz[k] = b;
    }
    return Engine._nz[k];
  }

  /**
   * Generate a stereo impulse response: seeded noise through a one-pole
   * low-pass whose cutoff falls over time (air absorbs highs as sound decays).
   * @param {number} sec   length in seconds
   * @param {number} decay exponent of the amplitude envelope
   */
  makeIR(sec, decay) {
    const c = this.ctx, sr = c.sampleRate, len = Math.floor(sr * sec);
    const buf = c.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.018);     // 18 ms pre-delay
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const rnd = mulberry32(0x1f2e3d + ch); // different seed per channel = stereo width
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const tt = i / len;
        lp += (0.6 - 0.5 * tt) * ((rnd() * 2 - 1) - lp); // coefficient falls with time
        d[i] = lp * Math.pow(1 - tt, decay) * 1.6;
      }
    }
    return buf;
  }

  /**
   * Envelope time scale: 1 at ≤ 100 bpm (every original tempo), shrinking to
   * 0.35 at very fast tempos, so pads, bells and the choir stay articulate
   * instead of smearing.
   */
  ts() { return clamp(this.spb / 0.6, 0.35, 1); }

  /**
   * Per-song instrument buses: [level, reverb send, delay send] per bus.
   * Bass passes through the saturator first.
   */
  makeBuses() {
    const spec = {
      lead:  [0.9, 0.32, 0.22], harm:  [0.55, 0.45, 0.1],  bell:  [0.8, 0.55, 0.28],
      pad:   [0.8, 0.5, 0],     bass:  [0.85, 0.04, 0],    arp:   [0.55, 0.35, 0.42],
      drums: [0.85, 0.12, 0],   drone: [0.7, 0.45, 0],
    };
    const buses = {};
    for (const [k, [lvl, rev, del]] of Object.entries(spec)) {
      const inp = this.gain(lvl);
      let node = inp;
      if (k === 'bass') {
        const ws = this.ctx.createWaveShaper();
        ws.curve = this.satCurve;
        ws.oversample = '2x';
        inp.connect(ws);
        node = ws;
      }
      node.connect(this.mix);
      if (rev) { const s = this.gain(rev); node.connect(s); s.connect(this.reverb); }
      if (del) { const s = this.gain(del); node.connect(s); s.connect(this.delayIn); }
      buses[k] = inp;   // voices connect to the INPUT side; the caller sets levels here
    }
    return buses;
  }

  /* ── Transport ────────────────────────────────────────────────────────── */

  /**
   * Prepare to play a song. Creates fresh buses; does not start the clock.
   * Fires the 'buses' hook so M2 can apply user levels.
   * @param {object} song output of composeSong()
   */
  load(song) {
    this.song = song;
    this.spb = song.spb;
    this.events = song.events;
    this.buses = this.makeBuses();

    // Song-level balance (set by Moods): multiply each bus's default level.
    if (song.levels)
      for (const [k, v] of Object.entries(song.levels))
        if (this.buses[k]) this.buses[k].gain.value *= v;

    this.delay.delayTime.setValueAtTime(song.spb * 0.75, this.ctx.currentTime); // dotted-eighth echo
    Hooks.emit('buses', this.buses, this);
  }

  /**
   * Start the clock. `lead` seconds of latency-cover before beat 0.
   * PATCH POINT (M4 overrides to clear loop regions first).
   */
  start(lead = 0.12) {
    this.reanchorAt = 0;
    this.anchor = this.ctx.currentTime + lead;
    this.loopIndex = 0;
    this.ptr = 0;
    this.running = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), 25);
    this.pump();
  }

  /**
   * Stop: fade the current buses over `fade` seconds, then disconnect them.
   * Does not touch the shared effects.
   */
  stop(fade = 0.8) {
    this.reanchorAt = 0;
    this.running = false;
    clearInterval(this.timer);
    const b = this.buses;
    if (!b) return;
    this.buses = null;
    const now = this.ctx.currentTime;
    Object.values(b).forEach((n) => {
      n.gain.cancelScheduledValues(now);
      n.gain.setValueAtTime(n.gain.value, now);
      n.gain.linearRampToValueAtTime(0, now + fade);
    });
    setTimeout(() => Object.values(b).forEach((n) => n.disconnect()), fade * 1000 + 300);
  }

  /**
   * Jump to a beat (used with section starts so drones and pads re-enter cleanly).
   * PATCH POINT (M4 overrides to respect loop regions).
   */
  seek(beat) {
    this.anchor = this.ctx.currentTime + 0.06 - beat * this.spb;
    this.loopIndex = 0;
    this.ptr = this.events.findIndex((e) => e.beat >= beat);
    if (this.ptr < 0) this.ptr = this.events.length;
  }

  /**
   * Musical time for the visuals, compensated for output latency (Bluetooth etc.).
   * Wraps at the song length so the pen loops with the music.
   * PATCH POINT (M4 overrides for gapless loop re-anchoring).
   */
  beatNow() {
    if (!this.song) return 0;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const b = (this.ctx.currentTime - lat - this.anchor) / this.spb;
    return b < 0 ? 0 : b % this.song.total;
  }

  /**
   * The lookahead scheduler. Books every event whose time falls inside the
   * horizon, then loops the song forever.
   * PATCH POINT (M4 overrides to add loop regions).
   *
   * The horizon is 180 ms normally and 1.6 s when the tab is hidden, because
   * browsers throttle timers in background tabs.
   */
  pump() {
    if (!this.running || !this.buses) return;
    const c = this.ctx;
    const horizon = c.currentTime + (document.hidden ? 1.6 : 0.18);
    const totalSec = this.song.total * this.spb;

    for (let guard = 0; guard < 4000; guard++) {
      if (this.ptr >= this.events.length) {
        // End of the score: wait until the next loop's start is within the horizon.
        if (this.anchor + (this.loopIndex + 1) * totalSec > horizon) break;
        this.loopIndex++;
        this.ptr = 0;
        continue;
      }
      const ev = this.events[this.ptr];
      const t = this.anchor + (this.loopIndex * this.song.total + ev.beat) * this.spb;
      if (t > horizon) break;
      if (t >= c.currentTime - 0.03) this.play(ev, Math.max(t, c.currentTime));
      this.ptr++;
    }
  }

  /**
   * Dispatch one event to its voice. Seeds the noise generator from the event's
   * MUSICAL identity (beat, type, pitch), never from context time, so the same
   * score always produces the same noise.
   * PATCH POINT (M9 wraps this to apply the live lens).
   */
  play(ev, t) {
    let s = Math.round(ev.beat * 960) | 0;
    for (let i = 0; i < ev.type.length; i++) s = (s * 31 + ev.type.charCodeAt(i)) | 0;
    this._nr = mulberry32(s ^ ((ev.midi || 0) * 2654435761));

    switch (ev.type) {
      case 'lead':   return this.lead(ev, t);
      case 'bell':   return this.bell(ev.midi, t, ev.vel, this.buses.bell);
      case 'harm':   return this.harm(ev, t);
      case 'pad':    return this.pad(ev, t);
      case 'bass':   return this.bass(ev, t);
      case 'arp':    return this.arp(ev, t);
      case 'kick':   return this.kick(ev, t);
      case 'snare':  return this.snare(ev, t);
      case 'hat':    return this.hat(ev, t);
      case 'shaker': return this.shaker(ev, t);
      case 'crash':  return this.crash(ev, t);
      case 'swell':  return this.swell(ev, t);
      case 'drone':  return this.drone(ev, t);
    }
  }

  /* ── VOICES ───────────────────────────────────────────────────────────────
     Three lead timbres give each sigil a distinct "voice":
       glass — 2-operator FM bell: luminous, temple-like
       reed  — triangle + saw, delayed vibrato and breath: vocal, human
       koto  — plucked saw with a snapping filter: intimate, ritual
     ─────────────────────────────────────────────────────────────────────── */

  /** Melodic lead. Timbre is chosen per event; `from` enables a glide. */
  lead(ev, t) {
    const out = this.buses.lead, f = mtof(ev.midi), d = ev.dur * this.spb, v = ev.vel;

    if (ev.timbre === 'glass') {
      const car = this.osc('sine', f, t), md = this.osc('sine', f * 2, t);
      const mg = this.gain(), amp = this.gain();
      // Bright strike that mellows: modulation index starts high and decays.
      mg.gain.setValueAtTime(f * 2.4 * v, t);
      mg.gain.setTargetAtTime(f * 0.15, t, 0.18);
      md.connect(mg); mg.connect(car.frequency);

      // A faint high partial for shimmer, struck once.
      const sh = this.osc('sine', f * 4, t), sg = this.gain();
      this.perc(sg.gain, t, v * 0.05, 0.12);
      sh.connect(sg); sg.connect(out);

      const ring = Math.max(d * 1.5, 1.2 * this.ts());
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(v * 0.42, t + 0.005);
      amp.gain.setTargetAtTime(0, t + 0.005, ring / 3.5);
      car.connect(amp); amp.connect(out);

      const end = t + ring + 0.6;
      [car, md, sh].forEach((o) => { o.start(t); o.stop(end); });

    } else if (ev.timbre === 'reed') {
      const o1 = this.osc('triangle', f, t), o2 = this.osc('sawtooth', f, t);
      const lp = this.filt('lowpass', Math.min(f * 5, 5000), 0.5);
      const m2 = this.gain(0.18), amp = this.gain();
      o2.detune.setValueAtTime(5, t);

      // Portamento from the previous note, if this note is a legato glide.
      if (ev.from) {
        const f0 = mtof(ev.from);
        [o1, o2].forEach((o) => {
          o.frequency.setValueAtTime(f0, t);
          o.frequency.exponentialRampToValueAtTime(f, t + 0.09);
        });
      }

      // Vibrato that blooms late, like a singer settling on a note.
      const lfo = this.osc('sine', 5.2, t), lg = this.gain();
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(f * 0.008, t + 0.45);
      lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);

      o1.connect(lp); o2.connect(m2); m2.connect(lp); lp.connect(amp); amp.connect(out);
      const stop = this.adsr(amp.gain, t, d, { a: 0.05, d: 0.35, s: 0.72, r: 0.28, peak: v * 0.36 });

      // Breath: a short bandpassed noise burst at the attack.
      const br = this.noise(t, 0.5), bf = this.filt('bandpass', f * 1.5, 1), bg = this.gain();
      this.perc(bg.gain, t, v * 0.035, 0.08);
      br.connect(bf); bf.connect(bg); bg.connect(out);

      [o1, o2, lfo].forEach((o) => { o.start(t); o.stop(stop); });

    } else { // koto
      const o = this.osc('sawtooth', f, t), o2 = this.osc('triangle', f, t);
      const lp = this.filt('lowpass', Math.min(f * 10, 9000), 5);
      // The filter snaps shut after the pluck: the characteristic "tock".
      lp.frequency.setValueAtTime(Math.min(f * 10, 9000), t);
      lp.frequency.setTargetAtTime(f * 1.4, t, 0.07);
      const g2 = this.gain(0.5), amp = this.gain(), tc = clamp(d * 0.45, 0.18, 0.9);
      o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(amp); amp.connect(out);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(v * 0.42, t + 0.003);
      amp.gain.setTargetAtTime(0, t + 0.003, tc);
      [o, o2].forEach((x) => { x.start(t); x.stop(t + tc * 7); });
    }
  }

  /**
   * Inharmonic FM bell (carrier:modulator ratio 3.5, plus a 2.76 partial).
   * Used for the invocation, banishing, chimes and the final stroke.
   * @param {GainNode} out destination bus (the caller chooses it)
   */
  bell(midi, t, v, out) {
    const f = mtof(midi);
    const car = this.osc('sine', f, t), md = this.osc('sine', f * 3.5, t);
    const mg = this.gain(), amp = this.gain();
    mg.gain.setValueAtTime(f * 1.4 * v, t);
    mg.gain.setTargetAtTime(0, t, 0.6);
    md.connect(mg); mg.connect(car.frequency);
    car.connect(amp); amp.connect(out);
    amp.gain.setTargetAtTime(0, t + 0.003, 0.95 * Math.sqrt(this.ts()));

    const p2 = this.osc('sine', f * 2.76, t), g2 = this.gain();
    this.perc(g2.gain, t, v * 0.06, 0.35);
    p2.connect(g2); g2.connect(out);

    [car, md, p2].forEach((o) => { o.start(t); o.stop(t + 5.5); });
  }

  /** "Choir": soft detuned triangles for the chorus harmony line (a diatonic third below). */
  harm(ev, t) {
    const f = mtof(ev.midi), d = ev.dur * this.spb;
    const lp = this.filt('lowpass', 1500, 0.6), amp = this.gain();
    const os = [this.osc('triangle', f, t), this.osc('triangle', f, t), this.osc('sine', f * 2, t)];
    os[0].detune.value = -7;   // the two triangles beat against each other: a chorus
    os[1].detune.value = 7;
    const g3 = this.gain(0.15);
    os[2].connect(g3); g3.connect(lp);
    os[0].connect(lp); os[1].connect(lp);
    lp.connect(amp); amp.connect(this.buses.harm);
    const stop = this.adsr(amp.gain, t, d, { a: 0.14, d: 0.4, s: 0.8, r: 0.6 * this.ts(), peak: ev.vel * 0.2 });
    os.forEach((o) => { o.start(t); o.stop(stop); });
  }

  /**
   * Pad: pairs of detuned saws through a slowly breathing low-pass.
   * Brightness follows section intensity.
   */
  pad(ev, t) {
    const d = ev.dur * this.spb, base = 480 + 420 * ev.bright;
    const lp = this.filt('lowpass', base * 0.6, 0.7), amp = this.gain();
    lp.frequency.setValueAtTime(base * 0.6, t);
    lp.frequency.linearRampToValueAtTime(base, t + d * 0.5);

    // Slow filter breathing, 0.11 Hz, ±160 Hz.
    const lfo = this.osc('sine', 0.11, t), lg = this.gain(160);
    lfo.connect(lg); lg.connect(lp.frequency);

    const oscs = [lfo];
    for (const m of ev.midis) for (const dt of [-9, 9]) {
      const o = this.osc('sawtooth', mtof(m), t);
      o.detune.value = dt;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(amp); amp.connect(this.buses.pad);
    const stop = this.adsr(amp.gain, t, d, { a: 1.1 * this.ts(), d: this.ts(), s: 0.85, r: 1.8 * this.ts(), peak: ev.vel * 0.045 });
    oscs.forEach((o) => { o.start(t); o.stop(stop); });
  }

  /** Bass: sine + triangle through a low-pass that closes after the attack. */
  bass(ev, t) {
    const f = mtof(ev.midi), d = ev.dur * this.spb;
    const o = this.osc('sine', f, t), o2 = this.osc('triangle', f, t);
    const g2 = this.gain(0.45), lp = this.filt('lowpass', f * 7, 0.8), amp = this.gain();
    lp.frequency.setValueAtTime(f * 7, t);
    lp.frequency.setTargetAtTime(f * 2.5, t, 0.09);
    o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(amp); amp.connect(this.buses.bass);
    const stop = this.adsr(amp.gain, t, d, { a: 0.006, d: 0.3, s: 0.65, r: 0.1, peak: ev.vel * 0.55 });
    [o, o2].forEach((x) => { x.start(t); x.stop(stop); });
  }

  /** Arpeggio note: a triangle with a quiet octave partial, panned per step. */
  arp(ev, t) {
    const f = mtof(ev.midi);
    const o = this.osc('triangle', f, t), o2 = this.osc('sine', f * 2, t);
    const g2 = this.gain(0.15), amp = this.gain();
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    o.connect(amp); o2.connect(g2); g2.connect(amp);
    if (pan) { pan.pan.value = ev.pan || 0; amp.connect(pan); pan.connect(this.buses.arp); }
    else amp.connect(this.buses.arp);
    const stop = this.perc(amp.gain, t, ev.vel * 0.22, 0.09);
    [o, o2].forEach((x) => { x.start(t); x.stop(stop); });
  }

  /** Kick: a falling sine plus a 4 ms click of filtered noise. */
  kick(ev, t) {
    const o = this.osc('sine', 150, t), g = this.gain();
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(ev.vel * 0.8, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g); g.connect(this.buses.drums);
    o.start(t); o.stop(t + 0.5);

    const n = this.noise(t, 0.02), nf = this.filt('lowpass', 2500), ng = this.gain();
    this.perc(ng.gain, t, ev.vel * 0.15, 0.004);
    n.connect(nf); nf.connect(ng); ng.connect(this.buses.drums);
  }

  /** Snare: bandpassed noise body plus a short triangle knock. */
  snare(ev, t) {
    const n = this.noise(t, 0.35), bp = this.filt('bandpass', 1900, 0.8), g = this.gain();
    this.perc(g.gain, t, ev.vel * 0.5, 0.05);
    n.connect(bp); bp.connect(g); g.connect(this.buses.drums);

    const o = this.osc('triangle', 190, t), og = this.gain();
    o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    this.perc(og.gain, t, ev.vel * 0.3, 0.03);
    o.connect(og); og.connect(this.buses.drums);
    o.start(t); o.stop(t + 0.3);
  }

  /** Hi-hat: highpassed noise. `open` lets it ring; each hat is panned slightly. */
  hat(ev, t) {
    const n = this.noise(t, 0.35), hp = this.filt('highpass', 7500, 0.7), g = this.gain();
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    this.perc(g.gain, t, ev.vel * 0.16, ev.open ? 0.08 : 0.012);
    n.connect(hp); hp.connect(g);
    if (pan) { pan.pan.value = ev.pan || 0; g.connect(pan); pan.connect(this.buses.drums); }
    else g.connect(this.buses.drums);
  }

  /** Shaker: a brief bandpassed noise puff. */
  shaker(ev, t) {
    const n = this.noise(t, 0.2), bp = this.filt('bandpass', 5500, 1.2), g = this.gain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(ev.vel * 0.12, t + 0.015);
    g.gain.setTargetAtTime(0, t + 0.015, 0.025);
    n.connect(bp); bp.connect(g); g.connect(this.buses.drums);
  }

  /** Crash: two seconds of highpassed noise with a long decay, into the bells bus. */
  crash(ev, t) {
    const n = this.noise(t, 2), hp = this.filt('highpass', 4200, 0.5), g = this.gain();
    this.perc(g.gain, t, ev.vel * 0.12, 0.5);
    n.connect(hp); hp.connect(g); g.connect(this.buses.bell);
  }

  /** Rising filtered noise: the breath before a chorus. */
  swell(ev, t) {
    const d = ev.dur * this.spb;
    const n = this.noise(t, Math.min(d, 1.95));
    const bp = this.filt('bandpass', 300, 1.5), g = this.gain();
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(6000, t + d);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(ev.vel * 0.09, t + d - 0.02);
    g.gain.linearRampToValueAtTime(0, t + d);
    n.connect(bp); bp.connect(g); g.connect(this.buses.bell);
    // Sources can be at most ~2 s: a second source covers the remainder.
    if (d > 1.95) { const n2 = this.noise(t + 1.9, d - 1.9); n2.connect(bp); }
  }

  /**
   * Drone: two detuned saws and a sub sine through a very dark, slowly
   * breathing low-pass. Lasts a whole section.
   */
  drone(ev, t) {
    const d = ev.dur * this.spb, f = mtof(ev.midi);
    const lp = this.filt('lowpass', 320, 3), amp = this.gain();
    const lfo = this.osc('sine', 0.06, t), lg = this.gain(140);
    lfo.connect(lg); lg.connect(lp.frequency);
    const os = [
      this.osc('sawtooth', f, t),
      this.osc('sawtooth', f * 1.4983, t),   // a just fifth, slightly flat: an open, uneasy interval
      this.osc('sine', f / 2, t),
    ];
    os[1].detune.value = 4;
    os.forEach((o) => o.connect(lp));
    lp.connect(amp); amp.connect(this.buses.drone);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(ev.vel * 0.11, t + Math.min(4, d / 3));
    amp.gain.setTargetAtTime(0, t + d - 1, 1.3);
    [lfo, ...os].forEach((o) => { o.start(t); o.stop(t + d + 6); });
  }

  /* ── Ritual sounds used outside the score ──────────────────────────── */

  /** A quill striking a letter during the reduction ceremony. */
  tick(kind) {
    if (!this.buses) return;
    const t = this.ctx.currentTime;
    const n = this.noise(t, 0.05), bp = this.filt('bandpass', kind === 'vowel' ? 2600 : 4200, 3), g = this.gain();
    this.perc(g.gain, t, 0.22, 0.012);
    n.connect(bp); bp.connect(g); g.connect(this.buses.bell);
  }

  /** A single bell, used for each named letter during the ceremony and for session chimes. */
  chime(midi) {
    if (this.buses) this.bell(midi, this.ctx.currentTime + 0.01, 0.7, this.buses.bell);
  }

  /**
   * Banishing: a low-pass sweep on the master (the room closes, then reopens)
   * and a crackling fire. Runs in the master chain, after the buses.
   * @param {number} sec duration of the closing sweep
   */
  banish(sec) {
    const now = this.ctx.currentTime, f = this.tone.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    f.exponentialRampToValueAtTime(140, now + sec);
    f.setValueAtTime(140, now + sec + 0.4);
    f.exponentialRampToValueAtTime(20000, now + sec + 1.6);

    const n = this.noise(now, 1.99), bp = this.filt('bandpass', 900, 0.6), g = this.gain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.05, now + 1);
    g.gain.linearRampToValueAtTime(0, now + 1.99);
    n.connect(bp); bp.connect(g); g.connect(this.comp);

    for (let i = 0; i < 46; i++) { // individual crackles scattered across the sweep
      const t = now + Math.random() * sec;
      const c = this.noise(t, 0.03);
      const cf = this.filt('highpass', 1500 + Math.random() * 3000), cg = this.gain();
      this.perc(cg.gain, t, 0.05 + Math.random() * 0.12, 0.004 + Math.random() * 0.01);
      c.connect(cf); cf.connect(cg); cg.connect(this.comp);
    }
  }
}