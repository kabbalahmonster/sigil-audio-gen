/* ══════════════════════════════════════════════════════════════════════════
   06-engine.js · HOST ENGINE (Part 1)
   ----------------------------------------------------------------------------
   The main-thread side of the instrument. It keeps the same method surface the
   rest of the app already uses (load, start, stop, seek, beatNow, region,
   setTempo, chime, tick, banish, buses, out, revReturn), but the sound itself
   is produced by the AudioWorklet in src/dsp/sigil-dsp.js.

   Messages sent before the worklet exists are queued and flushed in order,
   so the app never has to wait on the async module load.
   ══════════════════════════════════════════════════════════════════════════ */

/** Bus order and defaults, mirrored from the DSP core. */
const ENGINE_BUSES = ['lead', 'harm', 'bell', 'pad', 'bass', 'arp', 'drums', 'drone', 'play', 'tick'];
const ENGINE_BUS_GAIN = [0.9, 0.55, 0.8, 0.8, 0.85, 0.55, 0.85, 0.7, 0.8, 0.6];

/**
 * A stand-in for an AudioParam. Reading returns the last value; writing posts
 * a parameter message to the core. Modules that use `gain.value` or the
 * `*AtTime` methods keep working unchanged.
 */
function paramShim(eng, key, init) {
  let v = init;
  const set = (x) => { v = x; eng.post({ cmd: 'param', key, value: x }); };
  return {
    get value() { return v; },
    set value(x) { set(x); },
    setValueAtTime: (x) => set(x),
    setTargetAtTime: (x) => set(x),
    linearRampToValueAtTime: (x) => set(x),
    exponentialRampToValueAtTime: (x) => set(x),
    cancelScheduledValues() {},
  };
}

/** Beat under a chord in the bass register, used to tune kicks and snares. */
function chordRootAt(song, beat) {
  let ph = song.phrases[0];
  for (const p of song.phrases) if (beat >= p.start) ph = p;
  const i = clamp(Math.floor((beat - ph.start) / 4), 0, ph.chords.length - 1);
  return bassPitch(ph.chords[i], 'root', song.bassBase, song.scale);
}

class Engine {
  /** @param {AudioContext} [ctx] */
  constructor(ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = ctx || new AC({ latencyHint: Prefs.get('audio.latency', 'playback') });
    this.sr = this.ctx.sampleRate;
    this.node = null; this.queue = []; this.song = null;
    this.spb = 0.5; this.total = 1; this.events = []; this.tk = null; this.startBeat = 0;
    this._region = null; this.running = false;

    // Output chain: worklet → master → analyser / speakers / recorder.
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = 0.6;
    this.master.connect(this.analyser); this.master.connect(this.ctx.destination);
    this.recDest = this.ctx.createMediaStreamDestination ? this.ctx.createMediaStreamDestination() : null;
    if (this.recDest) this.master.connect(this.recDest);

    // Mixer-compatible handles (the Mixer sets `.gain.value` on these).
    this.out = { gain: paramShim(this, 'master', 0.85) };
    this.buses = {};
    ENGINE_BUSES.forEach((k, i) => { this.buses[k] = { gain: paramShim(this, 'bus.' + k, ENGINE_BUS_GAIN[i]) }; });
    this.revReturn = { gain: paramShim(this, 'rev', 0.85) };
    this.delayReturn = { gain: paramShim(this, 'del', 1) };

    this.ready = Engine.prepare(this.ctx).then((ok) => { if (ok) this.makeNode(); return ok; });
  }

  /** Load the worklet module once per context. Resolves to false if unsupported. */
  static prepare(ctx) {
    if (!ctx || !ctx.audioWorklet) return Promise.resolve(false);
    if (!Engine._modP || Engine._modCtx !== ctx) {
      Engine._modCtx = ctx;
      Engine._modP = ctx.audioWorklet.addModule('src/dsp/sigil-dsp.js').then(
        () => true,
        (e) => { console.error('[sigil-dsp] could not load the worklet', e); return false; });
    }
    return Engine._modP;
  }

  makeNode() {
    this.node = new AudioWorkletNode(this.ctx, 'sigil-dsp', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.connect(this.master);
    this.node.port.onmessage = (e) => this.onMsg(e.data);
    for (const [msg, t] of this.queue) this.node.port.postMessage(msg, t || []);
    this.queue.length = 0;
  }
  post(msg, transfer) {
    if (this.node) this.node.port.postMessage(msg, transfer || []);
    else this.queue.push([msg, transfer]);
  }
  onMsg(d) {
    if (d.cmd === 'tick') this.tk = { beat: d.beat, t: d.f / this.sr, running: d.running };
    else if (d.cmd === 'meters') Hooks.emit('meters', d.peak);
    else if (d.cmd === 'fault') console.error('[sigil-dsp] block fault:', d.message);
  }

  /* ── Score ─────────────────────────────────────────────────────────── */
  /** Build the event list the core plays. LiveLens is applied here, once. */
  buildScore(song) {
    const useLens = typeof LiveLens !== 'undefined' && LiveLens.active && LiveLens.active();
    const pathAt = new Map();
    for (const ph of song.phrases) for (const nd of ph.path) pathAt.set(nd.beat.toFixed(4), nd);
    return song.events.map((raw) => {
      const ev = { ...(useLens ? LiveLens.map(raw, song) : raw) };
      if (ev.type === 'lead' || ev.type === 'harm') {
        // The letter on the path gives the consonant; its slot gives the vowel.
        const nd = pathAt.get(ev.beat.toFixed(4));
        if (nd) ev.syl = { c: nd.letter.toLowerCase(), v: 'aeiou'[nd.slot % 5] };
      }
      if (ev.type === 'kick' || ev.type === 'snare') ev.root = chordRootAt(song, ev.beat);
      return ev;
    });
  }
  load(song) {
    this.song = song; this.spb = song.spb; this.total = song.total;
    this.events = this.buildScore(song);
    this.startBeat = 0;
    this.post({ cmd: 'score', events: this.events, total: song.total, spb: song.spb });
    Hooks.emit('buses', this.buses, this);   // the Mixer applies user levels here
    Hooks.emit('engineLoad', this, song);
  }
  /** Re-score after LiveLens changes, keeping the beat position. */
  rescore() {
    if (!this.song) return;
    this.events = this.buildScore(this.song);
    this.post({ cmd: 'score', events: this.events, total: this.song.total, spb: this.spb });
  }
  pushFx() {}   // reserved: effect parameters are sent by the modules that own them

  /* ── Transport ─────────────────────────────────────────────────────── */
  start(lead = 0.12) {
    this.running = true;
    this.post({ cmd: 'play', at: Math.round((this.ctx.currentTime + lead) * this.sr), beat: this.startBeat || 0 });
  }
  stop(fade = 0.8) {
    this.running = false; this.tk = null;
    this.post({ cmd: 'stop', fade });
  }
  seek(beat) {
    this.startBeat = beat;
    this.post({ cmd: 'seek', beat });
  }
  setTempo(bpm) {
    if (!this.song || !(bpm > 0)) return;
    this.spb = 60 / bpm;
    this.post({ cmd: 'tempo', spb: this.spb });
  }
  /** Musical time for the visuals, extrapolated from the last tick and compensated for output latency. */
  beatNow() {
    if (!this.song) return 0;
    if (!this.tk || !this.tk.running) return this.startBeat || 0;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const T = this.song.total;
    const b = this.tk.beat + (this.ctx.currentTime - lat - this.tk.t) / this.spb;
    return ((b % T) + T) % T;
  }
  get region() { return this._region; }
  set region(r) { this._region = r; this.post({ cmd: 'region', region: r }); }

  /* ── One-shots and live notes ─────────────────────────────────────── */
  chime(midi) { this.post({ cmd: 'oneshot', kind: 'chime', midi }); }
  tick() { this.post({ cmd: 'oneshot', kind: 'tick' }); }
  banish(sec) { this.post({ cmd: 'banish', sec }); }
  noteOn({ midi, vel = 0.7 } = {}) {
    const id = (Engine._nid = (Engine._nid || 0) + 1);
    this.post({ cmd: 'noteon', id, midi, vel });
    return { release: () => this.post({ cmd: 'noteoff', id }) };
  }
}

/* Compatibility: modules used to "claim" engine internals. Nothing needs to now. */
Engine.claims = {};
Engine.EXPECTED_CLAIMS = {};
Engine.claim = function () {};
window.Engine = Engine;
Hooks.on('lensChanged', () => { if (app.engine && app.engine.song) app.engine.rescore(); });