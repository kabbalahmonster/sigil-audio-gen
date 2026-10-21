/* ══════════════════════════════════════════════════════════════════════════
   sigil-worklet.js: the AudioWorklet host for the DSP core.
   The scheduler and every voice run here, on the audio thread. The main
   thread only sends plans (typed arrays) and small commands, and receives
   transport segments (for sync) and ~25 Hz ticks (meters, stats).
   ══════════════════════════════════════════════════════════════════════════ */
   import './sigil-dsp.js';

   class SigilEngineProcessor extends AudioWorkletProcessor {
     constructor(options) {
       super();
       const o = (options && options.processorOptions) || {};
       const D = globalThis.SigilDSP;
       this.core = new D.Core(sampleRate, o);
       this.scr = new Float32Array(128);
       this.every = Math.max(1, Math.round(sampleRate / 128 / (o.tickHz || 25)));
       this.k = 0;
       this.failed = false;
       this.perf = typeof performance !== 'undefined' && typeof performance.now === 'function';
       this.load = 0;
       this.core.onTransport = (t, beat, bps, lo, hi, pass, reg) =>
         this.port.postMessage({ type: 'transport', t, beat, bps, lo, hi, pass, reg: !!reg });
       this.port.onmessage = (e) => {
         try { this.core.command(e.data); }
         catch (err) { this.port.postMessage({ type: 'error', msg: String((err && err.stack) || err) }); }
       };
       this.port.postMessage({ type: 'ready', version: D.VERSION, sr: sampleRate, perf: this.perf });
     }
   
     process(inputs, outputs) {
       const main = outputs[0], post = outputs[1];
       if (!main || !main.length || this.failed) return true;
       const L = main[0], R = main.length > 1 ? main[1] : this.scr, n = L.length;
       const t0 = this.perf ? performance.now() : 0;
       try {
         this.core.blockTime = currentTime;
         this.core.process(L, R, n, post && post.length ? post[0] : undefined, post && post.length > 1 ? post[1] : undefined);
       } catch (err) {
         this.failed = true;   // go silent rather than spew; the host shows the error
         this.port.postMessage({ type: 'error', msg: String((err && err.stack) || err) });
         return true;
       }
       if (this.perf) this.load += ((performance.now() - t0) / ((n / sampleRate) * 1000) - this.load) * 0.05;
       if (++this.k >= this.every) {
         this.k = 0;
         this.port.postMessage(this.core.tickInfo(currentTime, this.perf ? this.load : -1));
       }
       return true;
     }
   }
   
   registerProcessor('sigil-engine', SigilEngineProcessor);