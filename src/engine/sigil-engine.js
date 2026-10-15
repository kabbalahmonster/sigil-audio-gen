'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   ENGINE — the main-thread host of the kernel
   --------------------------------------------------------------------------
   Keeps the public surface the app and its modules already use (load, start,
   stop, seek, beatNow, setTempo, tick, chime, banish, region, buses[k].gain,
   out.gain, revReturn.gain, analyser, recDest), but contains no synthesis and
   no scheduler. It only:
     • spawns the kernel into an AudioWorklet (from the kernel's own source)
     • asks Score to compile the song into a plan, and sends it
     • forwards parameters, notes and transport commands
     • turns the kernel's clock reports into beatNow() for the visuals

   THE CLOCK
     The kernel reports (frame, beat, beats per sample, loop bounds). beatNow()
     takes the time of the sample being HEARD right now, finds the newest report
     at or before it, and extrapolates. The visuals are therefore locked to the
     sound, smooth at any frame rate, and correct through latency.
   ══════════════════════════════════════════════════════════════════════════ */

/** A remote parameter with the few AudioParam methods the modules call. */
class ParamProxy {
  constructor(engine, name, value) { this._e = engine; this.name = name; this._v = value; }
  get value() { return this._v; }
  set value(v) { this._send(v, 0.01); }
  _send(v, time, mode) {
    this._v = v;
    this._e._post({ cmd: 'param', name: this.name, value: v, time, mode });
    return this;
  }
  setValueAtTime(v) { return this._send(v, 0.005); }
  setTargetAtTime(v, _t, tc) { return this._send(v, tc); }
  linearRampToValueAtTime(v, t) { return this._send(v, Math.max(0.005, t - this._e.ctx.currentTime), 'lin'); }
  exponentialRampToValueAtTime(v, t) { return this._send(v, Math.max(0.005, t - this._e.ctx.currentTime), 'exp'); }
  cancelScheduledValues() { return this; }
}

class Engine {
  constructor(ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    // 'playback' asks for larger hardware buffers: fewer dropouts on slow machines.
    // The visuals compensate for the extra latency. Prefs.set('audio.latency', 'interactive') for tighter keys.
    const c = (this.ctx = ctx || new AC({ latencyHint: Prefs.get('audio.latency', 'playback') }));

    this.node = null;
    this.error = null;
    this._queue = [];
    this._params = new Map();
    this._epoch = 0; this._minEpoch = 0; this._pending = false;
    this._anchors = [{ frame: 0, beat: 0, bps: 0, ls: 0, le: 1, loop: false }];
    this._t = 0;
    this._region = null;
    this._timer = 0;
    this._session = null;
    this._noteId = 0;

    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.recDest = c.createMediaStreamDestination ? c.createMediaStreamDestination() : null;

    this.out = { gain: this._param('master', 0.85) };
    this.tone = { frequency: this._param('tone', 20000) };
    this.revReturn = { gain: this._param('space', 0.85) };

    this.buses = null;     // per-song bus handles, or null when stopped
    this.song = null;
    this.events = null;
    this.spb = 0.6;
    this.running = false;
    this.plan = null;      // what Score last compiled: { count, sections, vowels, … }
    this.stats = { voices: 0, load: 0, peak: 0, faults: 0, stolen: 0, meters: new Float32Array(SigilKernel.BUS_DEF.length) };

    /** Resolves true when the kernel is running, false if it could not start (see this.error). */
    this.ready = this._boot().then(() => true, (e) => {
      this.error = e;
      console.error('[engine] the audio kernel could not start:', e);
      if (typeof toast === 'function') toast('The audio engine could not start. See the console.', true, 6000);
      return false;
    });
  }

  /* ── kernel lifecycle ─────────────────────────────────────────────────── */

  /** The kernel as source text: the factory function, called, booted. One source of truth; no fetch, no eval. */
  static kernelSource() { return `(${SigilKernelFactory.toString()})(globalThis).boot();`; }

  async _boot() {
    const c = this.ctx;
    if (!c.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      throw new Error('AudioWorklet is unavailable. It needs a current browser and https:// or localhost.');
    }
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([Engine.kernelSource()], { type: 'text/javascript' }));
      await c.audioWorklet.addModule(url);
    } catch (e) {
      await c.audioWorklet.addModule(Engine.KERNEL_URL);   // the file also boots itself when loaded by URL
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(c, 'sigil-kernel', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e) => this._onMessage(e.data);
    node.onprocessorerror = (e) => console.error('[engine] the kernel stopped:', e);
    node.connect(c.destination);
    node.connect(this.analyser);
    if (this.recDest) node.connect(this.recDest);
    this.node = node;
    const now = performance.now();
    for (const [m, transfer, at, ephemeral] of this._queue) {
      if (ephemeral && now - at > 300) continue;           // a chime that waited this long is no longer wanted
      node.port.postMessage(m, transfer || []);
    }
    this._queue.length = 0;
  }

  _post(m, transfer, ephemeral) {
    if (this.node) this.node.port.postMessage(m, transfer || []);
    else this._queue.push([m, transfer, performance.now(), !!ephemeral]);
  }

  _onMessage(m) {
    if (m.t === 'state') {
      const s = this.stats;
      s.voices = m.voices; s.faults = m.faults; s.stolen = m.stolen;
      s.load += (m.load - s.load) * 0.2;
      s.peak = Math.max(m.peak, s.peak * 0.9);
      for (let i = 0; i < s.meters.length; i++) s.meters[i] = Math.max(m.meters[i], s.meters[i] * 0.85);
      if (m.epoch >= this._minEpoch) {
        this._pending = false;
        const A = this._anchors;
        if (A.length > 64) A.splice(0, A.length - 32);      // nobody is drawing (hidden tab): keep only the newest
        A.push({ frame: m.frame, beat: m.beat, bps: m.bps, ls: m.ls, le: m.le, loop: m.loop });
      }
    } else if (m.t === 'error') {
      console.error('[kernel]', m.message);
    }
  }

  _param(name, value) {
    const p = new ParamProxy(this, name, value);
    this._params.set(name, p);
    return p;
  }

  /* ── the clock ────────────────────────────────────────────────────────── */

  /**
   * Context time of the sample leaving the speakers now.
   * currentTime only moves once per hardware buffer, which makes motion stutter;
   * getOutputTimestamp pairs it with performance time so we can interpolate.
   */
  timeNow(at) {
    const c = this.ctx;
    if (c.state !== 'running') return this._t;              // paused: time stands still, and so does the pen
    let t = c.currentTime - (c.outputLatency || c.baseLatency || 0);
    if (c.getOutputTimestamp) {
      const ts = c.getOutputTimestamp();
      if (ts && ts.performanceTime > 0) {
        const e = ts.contextTime + ((at === undefined ? performance.now() : at) - ts.performanceTime) / 1000;
        if (Math.abs(e - t) < 0.35) t = e;                  // trust it only while it agrees with the coarse clock
      }
    }
    if (t < this._t && this._t - t < 0.1) t = this._t;      // never let jitter run time backwards
    return (this._t = t);
  }

  /** Musical time for the visuals. Pass the animation-frame timestamp for the steadiest motion. */
  beatNow(at) {
    if (!this.song) return 0;
    const f = this.timeNow(at) * this.ctx.sampleRate;
    const A = this._anchors;
    while (A.length > 1 && A[1].frame <= f) A.shift();
    const a = A[0];
    let b = a.beat + (f > a.frame ? (f - a.frame) * a.bps : 0);
    if (a.loop && a.le > a.ls && b >= a.le) b = a.ls + ((b - a.le) % (a.le - a.ls));   // the kernel wraps here too
    return b < 0 ? 0 : b;
  }

  /* ── transport ────────────────────────────────────────────────────────── */

  _makeBuses() {
    const buses = {};
    for (const def of SigilKernel.BUS_DEF) {
      const name = def[0];
      if (name === 'play' || name === 'ritual') continue;   // engine-owned, not part of a song's mix
      const p = this._param('bus.' + name, def[1]);
      p.setTargetAtTime(def[1], 0, 0.02);
      buses[name] = { gain: p };
    }
    return buses;
  }

  /** Attach a score. Builds fresh bus handles, lets the Mixer and Sound react, then compiles and sends the plan. */
  load(song) {
    this.song = song;
    this.spb = song.spb;
    this.events = song.events;
    this.region = null;
    this.buses = this._makeBuses();
    if (song.levels) {
      for (const [k, v] of Object.entries(song.levels)) if (this.buses[k]) this.buses[k].gain.value *= v;
    }
    this._post({ cmd: 'tempo', spb: this.spb });
    Hooks.emit('buses', this.buses, this);
    this.refresh(true);
  }

  start(lead = 0.12) {
    if (!this.song) return;
    this.region = null;
    this.running = true;
    this._minEpoch = ++this._epoch;                         // reports from before this moment describe the old song
    this._pending = true;
    this._anchors = [{ frame: 0, beat: 0, bps: 0, ls: 0, le: this.song.total, loop: true }];
    this._post({ cmd: 'play', beat: 0, lead, epoch: this._epoch });
  }

  /** Fade out this song's voices. Effects tails and ritual sounds carry on. */
  stop(fade = 0.8) {
    this.running = false;
    clearTimeout(this._timer);
    this._timer = 0;
    if (!this.buses) return;
    this.buses = null;
    this.region = null;
    this._post({ cmd: 'stop', fade, epoch: ++this._epoch });
  }

  seek(beat) {
    if (!this.song) return;
    const r = this._region;
    if (r && (beat < r.start || beat >= r.end)) this.region = null;   // seeking outside a loop cancels it
    const epoch = ++this._epoch;
    if (this._pending) { this._anchors[0].beat = beat; this._minEpoch = epoch; }
    this._post({ cmd: 'seek', beat, epoch });
  }

  /** Change tempo. Position is kept in beats inside the kernel, so nothing needs re-anchoring. */
  setTempo(bpm) {
    if (!this.song || !(bpm > 0)) return;
    this.spb = 60 / bpm;
    this._post({ cmd: 'tempo', spb: this.spb, epoch: ++this._epoch });
  }

  /** A gapless loop region { start, end, … } in beats, or null. Emits Hooks 'region' when it changes. */
  get region() { return this._region; }
  set region(r) {
    const next = r && r.end > r.start ? r : null;
    if (next === this._region) return;
    this._region = next;
    this._post(next ? { cmd: 'region', start: next.start, end: next.end } : { cmd: 'region', start: 0, end: 0 });
    Hooks.emit('region', next);
  }

  /* ── the score ────────────────────────────────────────────────────────── */

  /**
   * Recompile the plan and swap it in without losing position. Call after anything
   * that changes what the notes ARE: patch, lens, drum settings, lite mode.
   * Calls are coalesced; pass true to compile immediately.
   */
  refresh(immediate) {
    if (!this.song) return;
    if (immediate) { clearTimeout(this._timer); this._timer = 0; this._compile(); return; }
    if (!this._timer) this._timer = setTimeout(() => { this._timer = 0; this._compile(); }, 40);
  }

  _compile() {
    if (!this.song || typeof Score === 'undefined') return;
    let plan;
    try {
      plan = Score.compile(this.song, { session: this._session || (this._session = Score.session()), spb: this.spb });
    } catch (e) {
      console.error('[engine] the score could not be compiled:', e);
      return;
    }
    if (plan.tables.length || plan.drop.length) this._post({ cmd: 'tables', set: plan.tables, drop: plan.drop });
    if (plan.reverb) this._post(Object.assign({ cmd: 'reverb' }, plan.reverb));
    this._post({ cmd: 'score', events: plan.events, count: plan.count, total: plan.total, scenes: plan.scenes },
               [plan.events.buffer, plan.scenes.buffer]);
    this.plan = plan.info;
    Hooks.emit('kernel:plan', plan.info, this);
  }

  configure(opts) { this._post(Object.assign({ cmd: 'config' }, opts)); }
  setParam(name, value, time, mode) { this._post({ cmd: 'param', name, value, time, mode }); }

  /* ── notes outside the score ──────────────────────────────────────────── */

  /**
   * Sound one note now (or after opt.delay seconds, timed on the audio clock).
   * Durations are in SECONDS here. With opt.held the note sustains until release().
   * @returns {{release: Function}|null}
   */
  note(kind, ev, opt) {
    const e = new Float64Array(SigilKernel.EV.STRIDE);
    SigilKernel.writeEvent(e, 0, kind, ev);
    const id = opt && opt.held ? ++this._noteId : 0;
    this._post({ cmd: 'note', e, id, delay: (opt && opt.delay) || 0 }, null, true);
    return id ? { release: () => this._post({ cmd: 'off', id }) } : null;
  }

  /** A quill striking a letter during the reduction. */
  tick(kind) {
    if (!this.buses) return;
    this.note('noise', { bus: 'ritual', vel: 0.22, type: 1, f0: kind === 'vowel' ? 2600 : 4200, q: 3, attack: 0.002, decay: 0.012 });
  }

  /** A single bell, used to name each surviving consonant. */
  chime(midi) {
    if (!this.buses) return;
    const f = mtof(midi);
    this.note('fm', { bus: 'ritual', freq: f, vel: 0.7, ratio: 3.5, index: f * 1.4 * 0.7, indexEnd: 0, indexTau: 0.6,
                      a: 0.003, d: 0.9, s: 0, r: 0.9, peak: 0.3 });
  }

  /** The Banishing: the master low-pass sweeps shut, a fire crackles, then the filter reopens for the next sigil. */
  banish(sec) {
    this._post({ cmd: 'param', name: 'tone', value: 140, time: sec, mode: 'exp' });
    this._post({ cmd: 'param', name: 'tone', value: 20000, time: 1.2, mode: 'exp', delay: sec + 0.4 });
    this.note('noise', { bus: 'ritual', vel: 0.05, type: 1, f0: 900, q: 0.6, attack: 1, decay: 0.99, shape: 2 });
    for (let i = 0; i < 46; i++) {   // crackles: genuinely random; this is a one-shot gesture
      this.note('noise', { beat: i, bus: 'ritual', vel: 0.05 + Math.random() * 0.12, type: 2, f0: 1500 + Math.random() * 3000,
                           q: 0.7, attack: 0.002, decay: 0.004 + Math.random() * 0.01 }, { delay: Math.random() * sec });
    }
  }

  /* ── offline rendering ────────────────────────────────────────────────── */

  /** Every mix parameter as it stands now, for a render to reproduce. `solo` silences all other buses (stems). */
  mixSnapshot(solo) {
    const list = [];
    for (const [name, p] of this._params) {
      let v = p.value;
      if (name === 'tone') v = 20000;
      if (solo && name.startsWith('bus.') && name !== 'bus.' + solo) v = 0;
      list.push([name, v, 0]);
    }
    return list;
  }

  /**
   * Render the song through a fresh kernel in a Worker, faster than real time.
   * o = { sr, spb, loops, frames, lens, solo }  →  { L, R, sr }
   */
  renderOffline(song, o, onProgress) {
    const plan = Score.compile(song, { session: Score.session(), spb: o.spb, lens: !!o.lens, render: true, lite: false });
    const setup = [
      { cmd: 'tables', set: plan.tables },
      { cmd: 'params', list: this.mixSnapshot(o.solo) },
      Object.assign({ cmd: 'reverb' }, plan.reverb),
      { cmd: 'tempo', spb: o.spb },
      { cmd: 'score', events: plan.events, count: plan.count, total: plan.total, scenes: plan.scenes, passes: o.loops || 1 },
      { cmd: 'play', beat: 0, lead: 0 },
    ];
    return Engine.runJob({ sr: o.sr, frames: o.frames, setup }, onProgress);
  }

  static async runJob(job, onProgress) {
    let worker = null, url = null;
    try {
      url = URL.createObjectURL(new Blob([Engine.kernelSource()], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch { worker = null; }
    if (worker) {
      try {
        return await new Promise((resolve, reject) => {
          worker.onmessage = (e) => {
            const d = e.data;
            if (d.progress !== undefined) { if (onProgress) onProgress(d.progress); }
            else if (d.done) resolve({ L: d.L, R: d.R, sr: job.sr });
            else if (d.error) reject(new Error(d.error));
          };
          worker.onerror = (e) => reject(new Error(e.message || 'the render worker failed'));
          worker.postMessage(Object.assign({ cmd: 'render' }, job));
        });
      } finally {
        worker.terminate();
        URL.revokeObjectURL(url);
      }
    }
    // No Worker available: the same kernel on this thread, a second of audio per slice.
    const r = SigilKernel.createRender(job);
    let p = 0;
    while (p < 1) {
      p = r.step(job.sr);
      if (onProgress) onProgress(p);
      await new Promise((res) => setTimeout(res, 0));
    }
    return { L: r.L, R: r.R, sr: job.sr };
  }
}

Engine.KERNEL_URL = 'src/engine/sigil-kernel.js';

/* ── Migration guard ──────────────────────────────────────────────────────
   The old engine was extended by replacing its prototype methods. The transport
   now lives in the kernel, so such a patch would silently break timing. These
   accessors ignore the assignment and say so, which turns a forgotten edit in a
   module into one console line instead of a subtle bug.
   ─────────────────────────────────────────────────────────────────────────── */
for (const name of ['load', 'start', 'stop', 'seek', 'beatNow', 'setTempo', 'pump', 'play']) {
  const fn = Engine.prototype[name] || function () {};
  Object.defineProperty(Engine.prototype, name, {
    configurable: false,
    get() { return fn; },
    set() { console.warn(`[engine] ignored a legacy patch of Engine.${name}: the transport now lives in the kernel.`); },
  });
}
Engine.claim = () => {};
Engine.claims = {};
Engine.EXPECTED_CLAIMS = {};