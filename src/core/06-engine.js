'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §6  AUDIO ENGINE v2: the main-thread face of the DSP worklet
   --------------------------------------------------------------------------
   The sound is made entirely on the audio thread (src/dsp/sigil-worklet.js
   running src/dsp/sigil-dsp.js). This class:
     • boots the worklet and queues messages until it is ready
     • compiles the score into a plan (via SigilPlan, 06b) and transfers it
     • owns transport commands (play/stop/seek/region/tempo)
     • owns the VISUAL CLOCK (TransportClock): beat and pass at the AUDIBLE time
     • keeps the page's copy of the motion table the core was sent, and answers
       "what is every mover doing now" with the core's own functions (motionNow)
     • exposes bus "proxies" with AudioParam-like gains, so the Mixer (M2) and
       Stems (m14) keep working without knowing the buses live in a worklet

   SIGNAL FLOW (native nodes after the worklet)
     worklet out[0] → tone (LP, swept by banish) → out → speakers
     worklet out[1] (post bus: banishing fire) ─────┘
     mix (GainNode) → tone    native insert for any custom Web Audio module
     out → analyser (m13), out → recDest (Record)
   ══════════════════════════════════════════════════════════════════════════ */

/* ── §6.1 TransportClock: beat at the moment the listener hears it ──────── */
class TransportClock {
  constructor(ctx) {
    this.ctx = ctx;
    this.segs = [];       // transport segments {t, beat, bps, lo, hi}, ascending t
    this.off = null;      // smoothed (audible context time − performance time), s
    this.last = 0;        // last audible time returned (monotonic while running)
    this.frameT = null;   // pinned for the duration of one animation frame
  }
  push(s) { this.segs.push(s); if (this.segs.length > 24) this.segs.shift(); }
  /** Audible context time at performance time `nowMs`, smoothed and monotonic. */
  time(nowMs = performance.now()) {
    const c = this.ctx;
    if (c.state !== 'running') { this.off = null; return this.last; }   // paused: the pen stops
    let raw;
    const ts = c.getOutputTimestamp ? c.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) raw = ts.contextTime + (nowMs - ts.performanceTime) / 1000;
    else raw = c.currentTime - (c.outputLatency || c.baseLatency || 0);
    if (raw > c.currentTime) raw = c.currentTime;
    const rawOff = raw - nowMs / 1000;
    if (this.off === null || Math.abs(rawOff - this.off) > 0.04) this.off = rawOff;   // snap on big jumps
    else this.off += (rawOff - this.off) * 0.03;                                       // glide on jitter
    let t = nowMs / 1000 + this.off;
    if (t < this.last && this.last - t < 0.04) t = this.last;                          // never step back on jitter
    this.last = t;
    return t;
  }
  frame(nowMs) { this.frameT = this.time(nowMs); }
  endFrame() { this.frameT = null; }
  now() { return this.frameT != null ? this.frameT : this.time(); }
  beatAt(t) {
    const S = this.segs;
    if (!S.length) return 0;
    let s = S[0];
    for (let i = S.length - 1; i >= 0; i--) if (S[i].t <= t) { s = S[i]; break; }
    let b = s.beat + Math.max(0, t - s.t) * s.bps;
    if (s.hi > s.lo && b >= s.hi) b = s.lo + ((b - s.lo) % (s.hi - s.lo));
    return b;
  }
  beat() { return this.beatAt(this.now()); }
  /**
   * Which pass of the rite is AUDIBLE at t (0 = the first). The core says so at every wrap; between
   * a wrap and its message arriving, the wraps are counted here. A looped section is not a new pass.
   */
  passAt(t) {
    const S = this.segs;
    if (!S.length) return 0;
    let s = S[0];
    for (let i = S.length - 1; i >= 0; i--) if (S[i].t <= t) { s = S[i]; break; }
    let p = s.pass | 0;
    if (!s.reg && s.hi > s.lo && s.bps > 0) {
      const b = s.beat + Math.max(0, t - s.t) * s.bps;
      if (b >= s.hi) p += Math.floor((b - s.lo) / (s.hi - s.lo));
    }
    return p;
  }
  pass() { return this.passAt(this.now()); }
}

/* ── §6.2 Engine ─────────────────────────────────────────────────────────── */
class Engine {
  constructor(ctx) {
    if (ctx) throw new Error('Engine v2 no longer renders through OfflineAudioContext. Use Render.renderSong (workers).');
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = new AC({ latencyHint: Prefs.get('audio.latency', 'playback') }));
    this.isDSP = true;

    this.tone = c.createBiquadFilter();
    this.tone.type = 'lowpass'; this.tone.frequency.value = 20000; this.tone.Q.value = 0.4;
    this.out = c.createGain(); this.out.gain.value = 0.85;
    this.mix = c.createGain();
    this.mix.connect(this.tone); this.tone.connect(this.out); this.out.connect(c.destination);
    this.comp = this.out;                       // legacy alias
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = 0.6;
    this.out.connect(this.analyser);
    this.recDest = c.createMediaStreamDestination ? c.createMediaStreamDestination() : null;
    if (this.recDest) this.out.connect(this.recDest);
    this.reverb = { buffer: null };             // legacy no-op target (m11 may assign to it)

    this.clock = new TransportClock(c);
    this.song = null; this.events = null; this.sigil = null;
    this.spb = 0.6; this.running = false; this.buses = null; this.region = null;
    this.levels = {};
    this.params = { reverb: 0.85, master: 1, waveOff: 0 };
    this.auto = null;        // the motion table the core holds (06b motionSync): { key, n, step, len, lanes, curves, meta }
    this.sections = null;    // a copy of the section table it holds
    this.moved = [];         // motionNow()'s reused result
    this.stats = { ready: false, voices: 0, budget: 0, steals: 0, load: -1, meters: null, beat: 0, errors: 0 };
    this.revReturn = { gain: Engine.param(0.85, (v) => this.setParams({ reverb: v })), connect() {}, disconnect() {} };

    this.node = null; this._queue = []; this._noteId = 0; this._pending = null; this._lvPending = false;
    this._tickSubs = new Set();
    this.ready = this._boot();
    this.ready.catch((e) => console.error('[engine]', e));
  }

  async _boot() {
    const c = this.ctx;
    if (!c.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      throw new Error('AudioWorklet is unavailable. Serve the app from http://localhost or https.');
    }
    await c.audioWorklet.addModule(Engine.WORKLET_URL);
    const node = new AudioWorkletNode(c, 'sigil-engine', {
      numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2],
      processorOptions: { voices: Engine.voiceBudget(), tickHz: 25 },
    });
    node.port.onmessage = (e) => this._onMessage(e.data);
    node.onprocessorerror = (e) => { this.stats.errors++; console.error('[engine] DSP processor failed', e); };
    node.connect(this.tone, 0);
    node.connect(this.out, 1);                  // post bus: after the banish filter
    this.node = node;
    const q = this._queue; this._queue = null;
    for (const [m, tr] of q) node.port.postMessage(m, tr);
    this.stats.ready = true;
    return this;
  }
  post(msg, transfer) {
    if (this._queue) this._queue.push([msg, transfer || []]);
    else this.node.port.postMessage(msg, transfer || []);
  }
  _onMessage(d) {
    switch (d.type) {
      case 'ready':
        // The page and the worklet must agree on the table layouts (STRIDE, PSTRIDE). A stale
        // cached worklet would misread every section row, silently; say so instead.
        if (d.version !== SigilDSP.VERSION) {
          this.stats.errors++;
          console.error(`[engine] DSP worklet is v${d.version} but the page expects v${SigilDSP.VERSION}. Hard-reload to clear the cached worklet.`);
        }
        break;
      case 'transport': this.clock.push(d); break;
      case 'tick':
        Object.assign(this.stats, { voices: d.voices, budget: d.budget, steals: d.steals, load: d.load, meters: d.meters, beat: d.beat,
          pass: d.pass | 0, moved: d.moved || null });
        for (const fn of this._tickSubs) { try { fn(d); } catch (e) { console.error('[engine:tick]', e); } }
        break;
      case 'error': this.stats.errors++; console.error('[dsp]', d.msg); break;
    }
  }
  /** Subscribe to ~25 Hz engine ticks {voices, load, meters, beat…}. Returns unsubscribe. */
  onTick(fn) { this._tickSubs.add(fn); return () => this._tickSubs.delete(fn); }

  /* ── transport ── */
  load(song, sigil = app.sigil) {
    this.song = song; this.spb = song.spb; this.events = song.events; this.sigil = sigil;
    this.region = null;
    this.buses = this._makeBuses(song.levels);
    Hooks.emit('buses', this.buses, this);       // M2 records _base and applies user levels
    Hooks.emit('region', null);
    this._flushLevels();
    SigilPlan.sendSong(this, song, sigil);       // plan + sections + tables + reverb
  }
  /** `pass`: which pass of the rite to begin on (0 = the first). UI.recompose hands back the one it was on. */
  start(_fade, pass = 0) {
    this.running = true;
    if (this.region) this.setRegion(null);
    this._play(0, Math.max(0, pass | 0));
  }
  /** play is deferred to a microtask so start()+seek() in one tick is ONE jump, not two. */
  _play(beat, pass = 0) {
    if (this._pending) { this._pending.beat = beat; this._pending.pass = pass; this._pending.cancel = false; return; }
    const m = (this._pending = { beat, pass, cancel: false });
    queueMicrotask(() => {
      this._pending = null;
      if (!m.cancel) this.post({ type: 'play', beat: m.beat, pass: m.pass, chase: true });
    });
  }
  stop(fade = 0.8) {
    this.running = false;
    if (this._pending) this._pending.cancel = true;
    if (this.region) this.setRegion(null);
    this.buses = null;
    this.post({ type: 'stop', fade });
  }
  seek(beat) {
    if (this.region && (beat < this.region.start || beat >= this.region.end)) this.setRegion(null);
    if (this._pending && !this._pending.cancel) { this._pending.beat = beat; return; }
    this.post({ type: 'seek', beat, chase: true });
  }
  /** Loop a region {start, end, si} (beats), or null. Gapless: the wrap happens on the audio thread. */
  setRegion(r) {
    this.region = r || null;
    this.post({ type: 'region', start: r ? r.start : 0, end: r ? r.end : 0 });
    Hooks.emit('region', this.region);
  }
  setTempo(bpm) {
    if (!this.song || !(bpm > 0)) return;
    this.spb = 60 / bpm;
    this.post({ type: 'tempo', bpm });
  }
  /** Musical time AT THE SPEAKER. Pinned per frame by Stage, so every reader agrees. */
  beatNow() { return this.song ? this.clock.beat() : 0; }
  /** The pass of the rite at the speaker: 0 is the first time through. */
  passNow() { return this.song ? this.clock.pass() : 0; }
  /**
   * What every mover is adding AT THE SPEAKER, worked out by the very functions the audio thread
   * uses (SigilDSP.autoPass / autoCurve) on the very table it was sent. So a bead drawn from this
   * is not a picture of the automation; it is the automation. Returns a reused array, one entry
   * per mover in table order: { off (column units), curve −1…1, depth, morph 0…1, shift }.
   */
  motionNow(beat = this.beatNow(), pass = this.passNow()) {
    const a = this.auto, out = this.moved;
    if (!a || !this.song) { out.length = 0; return out; }
    const T = Engine._mt, motion = this.params.motion ?? 1, evolve = this.params.evolve ?? 0;
    for (let j = 0; j < a.n; j++) {
      const m = out[j] || (out[j] = { off: 0, curve: 0, depth: 0, morph: 0, shift: 0 });
      SigilDSP.autoPass(a.lanes, j, pass, motion, evolve, T);
      m.depth = T[0]; m.morph = T[1]; m.shift = T[2];
      m.curve = SigilDSP.autoCurve(a.curves, a.len, a.step, j, beat, T[1]);
      m.off = m.curve * T[0] + T[2];
    }
    out.length = a.n;
    return out;
  }
  ts() { return clamp(this.spb / 0.6, 0.35, 1); }

  /* ── mix ── */
  setParams(p) { Object.assign(this.params, p); this.post(Object.assign({ type: 'params' }, p)); }
  setLevel(name, v) { this._level(name, v); }
  panic() { this.post({ type: 'panic' }); }

  /* ── live playing & ritual sounds ── */
  noteOn({ midi, deg = 0, vel = 0.8, timbre = 'glass' }) {
    const id = ++this._noteId, row = SigilPlan.liveNote(midi, deg, vel, timbre);
    this.post({ type: 'noteOn', id, row }, [row.buffer]);
    let done = false;
    return { id, release: () => { if (!done) { done = true; this.post({ type: 'noteOff', id }); } } };
  }
  /** One-shot from a plan row (SigilPlan.row). `when` = context time, 0 = now. */
  trigger(row, when = 0) { this.post({ type: 'trigger', row, when }, [row.buffer]); }
  tick(kind) {
    if (!this.buses) return;
    const f = kind === 'vowel' ? 2600 : 4200;
    this.trigger(SigilPlan.row({ kind: 'NOISE', bus: 'bell', vel: 0.22, dur: 0.1 / this.spb, p: [1, f, f, 3, 0.001, 0.012] }));
  }
  chime(midi) {
    if (this.buses) this.trigger(SigilPlan.row({ kind: 'BELL', bus: 'bell', f: mtof(midi), dur: 1.2 / this.spb, vel: 0.7 }));
  }
  /** The Banishing: a native low-pass sweep on the master, plus fire on the post bus (unfiltered). */
  banish(sec) {
    const now = this.ctx.currentTime, f = this.tone.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    f.exponentialRampToValueAtTime(140, now + sec);
    f.setValueAtTime(140, now + sec + 0.4);
    f.exponentialRampToValueAtTime(20000, now + sec + 1.6);
    this.trigger(SigilPlan.row({ kind: 'FIRE', bus: 'post', dur: sec / this.spb, vel: 1, p: [46 / sec] }));
  }

  /* ── internals ── */
  _makeBuses(songLevels) {
    const b = {};
    SigilDSP.BUS_NAMES.forEach((name, i) => {
      if (name === 'fx' || name === 'post') return;
      const lvl = SigilDSP.BUS_DEFAULT[i] * ((songLevels && songLevels[name]) ?? 1);
      this.levels[name] = lvl;
      b[name] = { name, gain: Engine.param(lvl, (v) => this._level(name, v)), connect() {}, disconnect() {} };
    });
    return b;
  }
  _level(name, v) {
    this.levels[name] = v;
    if (!this._lvPending) { this._lvPending = true; queueMicrotask(() => this._flushLevels()); }
  }
  _flushLevels() { this._lvPending = false; this.post({ type: 'levels', levels: Object.assign({}, this.levels) }); }

  /* legacy no-ops, so old wrappers (M9 play, M16 pump) stay harmless */
  pump() {}
  play() {}
}

Engine.WORKLET_URL = 'src/dsp/sigil-worklet.js';
Engine.prototype.horizon = 0;   // legacy readout (M16/M17). A data property, so old assignments don't throw.

/** An AudioParam look-alike that forwards every write to `onSet`. */
Engine.param = function (initial, onSet) {
  let v = initial;
  const p = {
    get value() { return v; },
    set value(x) { v = +x; onSet(v); },
    defaultValue: initial,
    cancelScheduledValues() { return p; },
    cancelAndHoldAtTime() { return p; },
  };
  const set = (x) => { v = +x; onSet(v); return p; };
  p.setValueAtTime = set; p.setTargetAtTime = set;
  p.linearRampToValueAtTime = set; p.exponentialRampToValueAtTime = set;
  return p;
};
Engine.voiceBudget = () => Prefs.get('audio.voices', (navigator.hardwareConcurrency || 4) <= 2 ? 32 : 48);
Engine._mt = new Float64Array(3);   // scratch for motionNow()
Engine.sharedIR = () => null;

/* Patch registry (kept for modules that still call Engine.claim). */
Engine.claims = Object.create(null);
Engine.claim = function (method, owner) {
  const prev = Engine.claims[method];
  if (prev && prev !== owner) console.warn(`[patch] Engine.${method} claimed by "${prev}" and "${owner}"`);
  Engine.claims[method] = owner;
};
Engine.EXPECTED_CLAIMS = {};   // Engine v2 owns its transport; nothing needs patching.