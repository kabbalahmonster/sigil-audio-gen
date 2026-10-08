'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §6  AUDIO ENGINE
   --------------------------------------------------------------------------
   Everything is synthesised live with the Web Audio API; there are no samples.

   SIGNAL FLOW
     voices → instrument bus ─┬→ mix → tone (LP) → compressor → out → speakers
                              ├→ convolution reverb (generated IR) → mix
                              └→ tempo-synced feedback delay → mix (+ reverb)

   SCHEDULING uses the "two clocks" pattern: a 25 ms JS timer looks a short way
   ahead and books events on the sample-accurate AudioContext clock. Visual
   time is read back through beatNow(), which subtracts output latency so
   Bluetooth headphones cannot desynchronise the drawing.

   BUSES are rebuilt per song, so stopping a song fades its buses without
   touching the shared effects. There are no clicks and no orphaned drones.

   ─── DOCUMENTED PATCH POINTS ───────────────────────────────────────────────
   These methods are deliberately overridable on the prototype. Feature modules
   replace or wrap them; if you change a signature here, update the owner.

     Engine.prototype.start      → wrapped by M4 Form (clears this.region)
     Engine.prototype.seek       → wrapped by M4 Form (region awareness)
     Engine.prototype.pump       → REPLACED by M4 Form (gapless region looping)
     Engine.prototype.beatNow    → REPLACED by M4 Form (re-anchor aware)
     Engine.prototype.play       → wrapped by M9 Live Lens (pitch mapping)
     Engine.prototype.setTempo   → ADDED by M2 Mixer

   Fields that exist only because a module uses them, declared here so they are
   discoverable: `region`, `prevAnchor`, `reanchorAt`, `buses[k]._base`.
   ══════════════════════════════════════════════════════════════════════════ */

class Engine {
  /**
   * @param {BaseAudioContext} [ctx] optional — pass an OfflineAudioContext to
   *        render the same score faster than real time (M7 Render & Export).
   */
  constructor(ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
        // 'playback' trades a few milliseconds of latency for far fewer dropouts.
    // Change it in the console with: Prefs.set('audio.latency', 'interactive') and reload.
    const c = (this.ctx = ctx || new AC({ latencyHint: Prefs.get('audio.latency', 'playback') }));

    /* ── Master chain ──────────────────────────────────────────────────── */
    this.out = this.gain(0.85);

    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.ratio.value = 3;
    this.comp.knee.value = 12;
    this.comp.attack.value = 0.008;
    this.comp.release.value = 0.25;

    // A master low-pass, normally wide open. banish() sweeps it down to 140 Hz.
    this.tone = c.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 20000;
    this.tone.Q.value = 0.4;

    this.mix = this.gain(1);
    this.mix.connect(this.tone);
    this.tone.connect(this.comp);
    this.comp.connect(this.out);
    this.out.connect(c.destination);

    /* ── Recording tap (video export, §8 toggleRecord) ─────────────────── */
    this.recDest = c.createMediaStreamDestination ? c.createMediaStreamDestination() : null;
    if (this.recDest) this.out.connect(this.recDest);

    /* ── Reverb: a generated impulse response, so nothing is downloaded ── */
    this.reverb = c.createConvolver();
    this.reverb.buffer = Engine.sharedIR(c);
    const rr = this.gain(0.85);
    this.reverb.connect(rr);
    rr.connect(this.mix);
    this.revReturn = rr;             // M2 Mixer animates this as "Space"

    /* ── Delay with filtered feedback: each repeat is darker ───────────── */
    this.delayIn = this.gain(1);
    this.delay = c.createDelay(3);
    this.delay.delayTime.value = 0.5;                  // replaced in load()
    const fbf = c.createBiquadFilter();
    fbf.type = 'lowpass';
    fbf.frequency.value = 2600;
    const fb = this.gain(0.36), dr = this.gain(0.55), d2r = this.gain(0.25);
    this.delayReturn = dr;
    this.delayIn.connect(this.delay);
    this.delay.connect(fbf);
    fbf.connect(fb); fb.connect(this.delay);           // feedback loop
    fbf.connect(dr); dr.connect(this.mix);
    dr.connect(d2r); d2r.connect(this.reverb);         // echoes bleed into the hall

    /* ── Shared white noise (drums, breath, fire) ──────────────────────── */
    this.noiseBuf = Engine.sharedNoise(c);

    /* ── Gentle tanh saturation, for bass warmth on small speakers ─────── */
    this.satCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      this.satCurve[i] = Math.tanh(1.8 * x) / Math.tanh(1.8);
    }

    /* ── Transport state ───────────────────────────────────────────────── */
    this.buses = null;      // per-song instrument buses, or null when stopped
    this.song = null;
    this.running = false;
    this.anchor = 0;        // context time at which beat 0 occurs
    this.region = null;     // M4 Form: { start, end, si } | null
    this.prevAnchor = 0;    // M4 Form: anchor before a seamless loop re-anchor
    this.reanchorAt = 0;    // M4 Form: context time at which the new anchor applies
  }

  /* ── §6.1 Node helpers ─────────────────────────────────────────────── */

  gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }

  osc(type, f, t) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    return o;
  }

  filt(type, f, q = 0.7) {
    const b = this.ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q;
    return b;
  }

  /**
   * A noise voice. The playback offset comes from this._nr — a PRNG seeded per
   * event from its musical identity in play() — so offline renders reproduce
   * the live performance sample for sample.
   */
  noise(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.start(t, (this._nr ? this._nr() : Math.random()) * 1.2, dur);
    return s;
  }

  /** ADSR on an AudioParam. @returns {number} a safe time at which to stop. */
  adsr(p, t, dur, { a = 0.01, d = 0.2, s = 0.7, r = 0.3, peak = 1 } = {}) {
    const end = t + Math.max(dur, a + 0.01);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.setTargetAtTime(peak * s, t + a, Math.max(0.001, d / 3));
    p.setTargetAtTime(0, end, Math.max(0.001, r / 3));
    return end + r * 1.7 + 0.05;
  }

  /** Percussive envelope (instant attack, exponential decay). @returns stop time. */
  perc(p, t, peak, tc) {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + 0.002);
    p.setTargetAtTime(0, t + 0.002, tc);
    return t + 0.01 + tc * 7;
  }

  /* ── §6.2 Shared, deterministic buffers ────────────────────────────────
     Reverb and noise buffers are seeded and cached per sample rate. AudioBuffers
     may be shared between contexts, so parallel offline renders and the live
     engine use the same data, and it is built only once.
     ───────────────────────────────────────────────────────────────────── */

  static sharedIR(c) {
    Engine._ir = Engine._ir || {};
    return (Engine._ir[c.sampleRate] =
      Engine._ir[c.sampleRate] || Engine.prototype.makeIR.call({ ctx: c }, 4.2, 2.6));
  }

  static sharedNoise(c) {
    Engine._nz = Engine._nz || {};
    const k = c.sampleRate;
    if (!Engine._nz[k]) {
      const b = c.createBuffer(1, k * 2, k), d = b.getChannelData(0), r = mulberry32(0x5eed);
      for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
      Engine._nz[k] = b;
    }
    return Engine._nz[k];
  }

  /**
   * Build a stereo impulse response: decorrelated noise through a one-pole
   * low-pass that darkens over time, shaped by a power-law decay envelope.
   * 18 ms of pre-delay gives the hall a sense of size.
   */
  makeIR(sec, decay) {
    const c = this.ctx, sr = c.sampleRate;
    const len = Math.floor(sr * sec), buf = c.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.018);

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch), rnd = mulberry32(0x1f2e3d + ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const tt = i / len;
        lp += (0.6 - 0.5 * tt) * ((rnd() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - tt, decay) * 1.6;
      }
    }
    return buf;
  }

  /**
   * Envelope time scale. 1 at ≤ 100 bpm (every original tempo), shrinking to
   * 0.35 at very fast tempos, so pads, bells and the choir stay articulate
   * instead of smearing when M2 or the Ecstatic mood pushes the tempo up.
   */
  ts() { return clamp(this.spb / 0.6, 0.35, 1); }

  /* ── §6.3 Per-song instrument buses ────────────────────────────────────
     spec: [level, reverb send, delay send]. The bass bus additionally runs
     through the tanh waveshaper.
     ───────────────────────────────────────────────────────────────────── */
  makeBuses() {
    const spec = {
      lead:  [0.9,  0.32, 0.22],
      harm:  [0.55, 0.45, 0.1],
      bell:  [0.8,  0.55, 0.28],
      pad:   [0.8,  0.5,  0],
      bass:  [0.85, 0.04, 0],
      arp:   [0.55, 0.35, 0.42],
      drums: [0.85, 0.12, 0],
      drone: [0.7,  0.45, 0],
    };

    const buses = {};
    for (const [k, [lvl, rev, del]] of Object.entries(spec)) {
      const inp = this.gain(lvl);
      let node = inp;

      if (k === 'bass') {
        const ws = this.ctx.createWaveShaper();
        ws.curve = this.satCurve; ws.oversample = '2x';
        inp.connect(ws); node = ws;
      }

      node.connect(this.mix);
      if (rev) { const s = this.gain(rev); node.connect(s); s.connect(this.reverb); }
      if (del) { const s = this.gain(del); node.connect(s); s.connect(this.delayIn); }
      buses[k] = inp;
    }
    return buses;
  }

  /* ── §6.4 Transport ────────────────────────────────────────────────── */

  /** Attach a score. Builds fresh buses and announces them to the Mixer. */
  load(song) {
    this.song = song;
    this.spb = song.spb;
    this.events = song.events;
    this.buses = this.makeBuses();

    // Song-level balance (set by Moods via cfg.levels): multiply each default.
    if (song.levels) {
      for (const [k, v] of Object.entries(song.levels)) {
        if (this.buses[k]) this.buses[k].gain.value *= v;
      }
    }

    // Dotted-eighth echo, locked to the tempo.
    this.delay.delayTime.setValueAtTime(song.spb * 0.75, this.ctx.currentTime);

    Hooks.emit('buses', this.buses, this);   // M2 Mixer records _base and applies user levels
  }

  /** PATCH POINT — wrapped by M4 Form. */
  start(lead = 0.12) {
    this.reanchorAt = 0;
    this.anchor = this.ctx.currentTime + lead;
    this.loopIndex = 0;
    this.ptr = 0;
    this.running = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), 16);   // pairs with the 0.4 s horizon in M4
    this.pump();
  }

  /** Fade out and release this song's buses. Shared FX are untouched. */
  stop(fade = 0.8) {
    this.reanchorAt = 0;
    this.running = false;
    clearInterval(this.timer);

    const b = this.buses;
    if (!b) return;
    this.buses = null;                     // further play() calls become no-ops

    const now = this.ctx.currentTime;
    Object.values(b).forEach((n) => {
      n.gain.cancelScheduledValues(now);
      n.gain.setValueAtTime(n.gain.value, now);
      n.gain.linearRampToValueAtTime(0, now + fade);
    });
    setTimeout(() => Object.values(b).forEach((n) => n.disconnect()), fade * 1000 + 300);
  }

  /**
   * Jump to a beat. Used with section starts, so drones and pads re-enter
   * cleanly at their own onsets rather than mid-envelope.
   * PATCH POINT — wrapped by M4 Form.
   */
  seek(beat) {
    this.anchor = this.ctx.currentTime + 0.06 - beat * this.spb;
    this.loopIndex = 0;
    this.ptr = this.events.findIndex((e) => e.beat >= beat);
    if (this.ptr < 0) this.ptr = this.events.length;
  }

  /**
   * Musical time for the visuals, compensated for output latency.
   * PATCH POINT — REPLACED by M4 Form.
   */
  beatNow() {
    if (!this.song) return 0;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const b = (this.ctx.currentTime - lat - this.anchor) / this.spb;
    return b < 0 ? 0 : b % this.song.total;
  }

  /**
   * Lookahead scheduler. Books every event inside a short horizon and loops the
   * song forever. The horizon widens to 1.6 s when the tab is hidden, because
   * background timers are throttled.
   * PATCH POINT — REPLACED by M4 Form.
   */
  pump() {
    if (!this.running || !this.buses) return;

    const c = this.ctx, horizon = c.currentTime + (document.hidden ? 1.6 : 0.18);
    const totalSec = this.song.total * this.spb;

    for (let guard = 0; guard < 4000; guard++) {
      if (this.ptr >= this.events.length) {
        if (this.anchor + (this.loopIndex + 1) * totalSec > horizon) break;
        this.loopIndex++; this.ptr = 0; continue;
      }

      const ev = this.events[this.ptr];
      const t = this.anchor + (this.loopIndex * this.song.total + ev.beat) * this.spb;
      if (t > horizon) break;
      if (t >= c.currentTime - 0.03) this.play(ev, Math.max(t, c.currentTime));
      this.ptr++;
    }
  }

  /**
   * Dispatch one event.
   * PATCH POINT — wrapped by M9 Live Lens, which maps the event's pitch first.
   */
  play(ev, t) {
    /* Seed this event's noise from its MUSICAL identity (beat, type, pitch).
       Context time is deliberately not used: that is what makes an offline
       render byte-identical to the live performance, and what lets M7 stitch
       independently rendered segments together without a seam. */
    let s = Math.round(ev.beat * 960) | 0;
    for (let i = 0; i < ev.type.length; i++) s = (s * 31 + ev.type.charCodeAt(i)) | 0;
    this._nr = mulberry32(s ^ ((ev.midi || 0) * 2654435761));
        // Extension point: the Sound module (m11) may render this event itself.
    // It returns true when it has handled the event. Legacy voices run otherwise.
    if (Hooks.filter('voice', null, ev, t, this) === true) return;

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

  /* ── §6.5 VOICES ───────────────────────────────────────────────────────
     Three lead timbres give each sigil a distinct "voice":
       glass — 2-operator FM bell: luminous, temple-like
       reed  — triangle + saw with delayed vibrato and breath: vocal, human
       koto  — plucked saw with a snapping filter: intimate, ritual
     ───────────────────────────────────────────────────────────────────── */

  lead(ev, t) {
    const out = this.buses.lead, f = mtof(ev.midi), d = ev.dur * this.spb, v = ev.vel;

    if (ev.timbre === 'glass') {
      const car = this.osc('sine', f, t), md = this.osc('sine', f * 2, t);
      const mg = this.gain(), amp = this.gain();

      // A bright strike that mellows: FM index collapses over ~180 ms.
      mg.gain.setValueAtTime(f * 2.4 * v, t);
      mg.gain.setTargetAtTime(f * 0.15, t, 0.18);
      md.connect(mg); mg.connect(car.frequency);

      // A brief partial two octaves up: the "ping" of the strike.
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

      // Legato glide from the previous note (set when the arriving stroke curves).
      if (ev.from) {
        const f0 = mtof(ev.from);
        [o1, o2].forEach((o) => {
          o.frequency.setValueAtTime(f0, t);
          o.frequency.exponentialRampToValueAtTime(f, t + 0.09);
        });
      }

      // Vibrato blooms late, like a singer leaning into a held note.
      const lfo = this.osc('sine', 5.2, t), lg = this.gain();
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(f * 0.008, t + 0.45);
      lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);

      o1.connect(lp); o2.connect(m2); m2.connect(lp); lp.connect(amp); amp.connect(out);
      const stop = this.adsr(amp.gain, t, d, { a: 0.05, d: 0.35, s: 0.72, r: 0.28, peak: v * 0.36 });

      // Breath noise at the attack.
      const br = this.noise(t, 0.5), bf = this.filt('bandpass', f * 1.5, 1), bg = this.gain();
      this.perc(bg.gain, t, v * 0.035, 0.08);
      br.connect(bf); bf.connect(bg); bg.connect(out);

      [o1, o2, lfo].forEach((o) => { o.start(t); o.stop(stop); });

    } else { // koto
      const o = this.osc('sawtooth', f, t), o2 = this.osc('triangle', f, t);
      const lp = this.filt('lowpass', Math.min(f * 10, 9000), 5);
      lp.frequency.setValueAtTime(Math.min(f * 10, 9000), t);
      lp.frequency.setTargetAtTime(f * 1.4, t, 0.07);   // the pluck "snap"

      const g2 = this.gain(0.5), amp = this.gain(), tc = clamp(d * 0.45, 0.18, 0.9);
      o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(amp); amp.connect(out);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(v * 0.42, t + 0.003);
      amp.gain.setTargetAtTime(0, t + 0.003, tc);

      [o, o2].forEach((x) => { x.start(t); x.stop(t + tc * 7); });
    }
  }

  /**
   * Inharmonic FM bell (modulator ratio 3.5, plus a 2.76 partial).
   * Used for the Invocation, the Banishing, the reduction chimes, and the
   * final stroke.
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

  /** "Choir": soft detuned triangles for the chorus harmony line (a third below). */
  harm(ev, t) {
    const f = mtof(ev.midi), d = ev.dur * this.spb;
    const lp = this.filt('lowpass', 1500, 0.6), amp = this.gain();
    const os = [this.osc('triangle', f, t), this.osc('triangle', f, t), this.osc('sine', f * 2, t)];
    os[0].detune.value = -7; os[1].detune.value = 7;

    const g3 = this.gain(0.15);
    os[2].connect(g3); g3.connect(lp);
    os[0].connect(lp); os[1].connect(lp);
    lp.connect(amp); amp.connect(this.buses.harm);

    const stop = this.adsr(amp.gain, t, d, { a: 0.14, d: 0.4, s: 0.8, r: 0.6 * this.ts(), peak: ev.vel * 0.2 });
    os.forEach((o) => { o.start(t); o.stop(stop); });
  }

  /** Pad: detuned saw pairs through a slowly breathing LP; brightness ← intensity. */
  pad(ev, t) {
    const d = ev.dur * this.spb, base = 480 + 420 * ev.bright;
    const lp = this.filt('lowpass', base * 0.6, 0.7), amp = this.gain();

    lp.frequency.setValueAtTime(base * 0.6, t);
    lp.frequency.linearRampToValueAtTime(base, t + d * 0.5);

    const lfo = this.osc('sine', 0.11, t), lg = this.gain(160);
    lfo.connect(lg); lg.connect(lp.frequency);

    const oscs = [lfo];
    for (const m of ev.midis) for (const dt of [-9, 9]) {
      const o = this.osc('sawtooth', mtof(m), t);
      o.detune.value = dt;
      o.connect(lp); oscs.push(o);
    }

    lp.connect(amp); amp.connect(this.buses.pad);
    const stop = this.adsr(amp.gain, t, d,
      { a: 1.1 * this.ts(), d: this.ts(), s: 0.85, r: 1.8 * this.ts(), peak: ev.vel * 0.045 });
    oscs.forEach((o) => { o.start(t); o.stop(stop); });
  }

  bass(ev, t) {
    const f = mtof(ev.midi), d = ev.dur * this.spb;
    const o = this.osc('sine', f, t), o2 = this.osc('triangle', f, t);
    const g2 = this.gain(0.45), lp = this.filt('lowpass', f * 7, 0.8), amp = this.gain();

    lp.frequency.setValueAtTime(f * 7, t);
    lp.frequency.setTargetAtTime(f * 2.5, t, 0.09);   // a soft pluck on each note

    o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(amp);
    amp.connect(this.buses.bass);

    const stop = this.adsr(amp.gain, t, d, { a: 0.006, d: 0.3, s: 0.65, r: 0.1, peak: ev.vel * 0.55 });
    [o, o2].forEach((x) => { x.start(t); x.stop(stop); });
  }

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

  /* ── §6.6 DRUMS ────────────────────────────────────────────────────── */

  kick(ev, t) {
    const o = this.osc('sine', 150, t), g = this.gain();
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(ev.vel * 0.8, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g); g.connect(this.buses.drums);
    o.start(t); o.stop(t + 0.5);

    // A 4 ms noise transient gives the kick a beater click.
    const n = this.noise(t, 0.02), nf = this.filt('lowpass', 2500), ng = this.gain();
    this.perc(ng.gain, t, ev.vel * 0.15, 0.004);
    n.connect(nf); nf.connect(ng); ng.connect(this.buses.drums);
  }

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

  hat(ev, t) {
    const n = this.noise(t, 0.35), hp = this.filt('highpass', 7500, 0.7), g = this.gain();
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    this.perc(g.gain, t, ev.vel * 0.16, ev.open ? 0.08 : 0.012);
    n.connect(hp); hp.connect(g);
    if (pan) { pan.pan.value = ev.pan || 0; g.connect(pan); pan.connect(this.buses.drums); }
    else g.connect(this.buses.drums);
  }

  shaker(ev, t) {
    const n = this.noise(t, 0.2), bp = this.filt('bandpass', 5500, 1.2), g = this.gain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(ev.vel * 0.12, t + 0.015);
    g.gain.setTargetAtTime(0, t + 0.015, 0.025);
    n.connect(bp); bp.connect(g); g.connect(this.buses.drums);
  }

  crash(ev, t) {
    // Routed to the bell bus so it inherits the long reverb send.
    const n = this.noise(t, 2), hp = this.filt('highpass', 4200, 0.5), g = this.gain();
    this.perc(g.gain, t, ev.vel * 0.12, 0.5);
    n.connect(hp); hp.connect(g); g.connect(this.buses.bell);
  }

  /** Rising filtered noise: the breath before a chorus. */
  swell(ev, t) {
    const d = ev.dur * this.spb;
    const n = this.noise(t, Math.min(d, 1.95)), bp = this.filt('bandpass', 300, 1.5), g = this.gain();
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(6000, t + d);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(ev.vel * 0.09, t + d - 0.02);
    g.gain.linearRampToValueAtTime(0, t + d);
    n.connect(bp); bp.connect(g); g.connect(this.buses.bell);
    // The shared noise buffer is 2 s long; splice a second source for long swells.
    if (d > 1.95) { const n2 = this.noise(t + 1.9, d - 1.9); n2.connect(bp); }
  }

  /** The drone: a perfect fifth plus a sub-octave, through a breathing LP. */
  drone(ev, t) {
    const d = ev.dur * this.spb, f = mtof(ev.midi);
    const lp = this.filt('lowpass', 320, 3), amp = this.gain();
    const lfo = this.osc('sine', 0.06, t), lg = this.gain(140);
    lfo.connect(lg); lg.connect(lp.frequency);

    const os = [this.osc('sawtooth', f, t), this.osc('sawtooth', f * 1.4983, t), this.osc('sine', f / 2, t)];
    os[1].detune.value = 4;
    os.forEach((o) => o.connect(lp));

    lp.connect(amp); amp.connect(this.buses.drone);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(ev.vel * 0.11, t + Math.min(4, d / 3));
    amp.gain.setTargetAtTime(0, t + d - 1, 1.3);

    [lfo, ...os].forEach((o) => { o.start(t); o.stop(t + d + 6); });
  }

  /* ── §6.7 RITUAL SOUNDS (outside the score) ────────────────────────── */

  /** A quill striking a letter during the reduction. */
  tick(kind) {
    if (!this.buses) return;
    const t = this.ctx.currentTime;
    const n = this.noise(t, 0.05);
    const bp = this.filt('bandpass', kind === 'vowel' ? 2600 : 4200, 3), g = this.gain();
    this.perc(g.gain, t, 0.22, 0.012);
    n.connect(bp); bp.connect(g); g.connect(this.buses.bell);
  }

  /** A single bell, used to name each surviving consonant. */
  chime(midi) {
    if (this.buses) this.bell(midi, this.ctx.currentTime + 0.01, 0.7, this.buses.bell);
  }

  /** The Banishing: a low-pass sweep on the master plus a crackling fire. */
  banish(sec) {
    const now = this.ctx.currentTime, f = this.tone.frequency;

    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    f.exponentialRampToValueAtTime(140, now + sec);
    f.setValueAtTime(140, now + sec + 0.4);
    f.exponentialRampToValueAtTime(20000, now + sec + 1.6);   // reopen for the next sigil

    // Routed post-filter, to the compressor, so the fire stays audible.
    const n = this.noise(now, 1.99), bp = this.filt('bandpass', 900, 0.6), g = this.gain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.05, now + 1);
    g.gain.linearRampToValueAtTime(0, now + 1.99);
    n.connect(bp); bp.connect(g); g.connect(this.comp);

    for (let i = 0; i < 46; i++) {   // crackles — genuinely random; this is a one-shot gesture
      const t = now + Math.random() * sec;
      const c = this.noise(t, 0.03);
      const cf = this.filt('highpass', 1500 + Math.random() * 3000), cg = this.gain();
      this.perc(cg.gain, t, 0.05 + Math.random() * 0.12, 0.004 + Math.random() * 0.01);
      c.connect(cf); cf.connect(cg); cg.connect(this.comp);
    }
  }
}

/* ── §6.8 PATCH REGISTRY ─────────────────────────────────────────────────
   Modules announce which Engine method they replace or wrap. If two different
   owners claim the same method, a warning is logged, which turns a silent
   overwrite into a visible one. index.html's preflight compares the claims
   against EXPECTED_CLAIMS.
   ─────────────────────────────────────────────────────────────────────────── */
   Engine.claims = Object.create(null);

   /**
    * Record that `owner` replaces or wraps Engine.prototype[method].
    * @param {string} method e.g. 'pump'
    * @param {string} owner  e.g. 'M4 Form'
    */
   Engine.claim = function (method, owner) {
     const prev = Engine.claims[method];
     if (prev && prev !== owner) {
       console.warn(`[patch] Engine.${method} claimed by "${prev}" and "${owner}"`);
     }
     Engine.claims[method] = owner;
   };
   
   /** The canonical list of patch points and their owners. Keep in sync with the modules. */
   Engine.EXPECTED_CLAIMS = {
     start: 'M4 Form',
     seek: 'M4 Form',
     pump: 'M4 Form',
     beatNow: 'M4 Form',
     play: 'M9 Live Lens',
     setTempo: 'M2 Mixer',
   };