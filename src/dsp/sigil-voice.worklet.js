/* ══════════════════════════════════════════════════════════════════════════
   sigil-voice.worklet.js — the AudioWorklet host for the DSP core.
   The scheduler and every voice run here, on the audio thread, so nothing the
   page does can starve them. The main thread only sends plans and patches.
   ══════════════════════════════════════════════════════════════════════════ */

   class SigilVoiceProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.core = null;
      this.port.onmessage = (e) => {
        const d = e.data;
        try {
          switch (d.cmd) {
            case 'init':
              // The core arrives as source text, so the worklet needs no imports.
              (0, eval)(d.src);
              this.core = new globalThis.SigilDSP.EngineCore(sampleRate, 128);
              this.port.postMessage({ ready: true });
              break;
            case 'plan': this.core.setPlan(d.plan); break;
            case 'sections': this.core.setPatchAt(d.sections); break;
            case 'levels': this.core.setLevels(d.levels); break;
            case 'duck': this.core.duckDepth = d.depth; break;
            case 'master': this.core.master = d.gain; break;
            case 'play': this.core.playing = true; this.core.pos = Math.round((d.beat || 0) * this.core.plan.spb * sampleRate); this.core.seek(d.beat || 0); break;
            case 'stop': this.core.playing = false; break;
            case 'seek': this.core.seek(d.beat); break;
            case 'meters': this.port.postMessage({ meters: this.core.meters }); break;
          }
        } catch (err) {
          this.port.postMessage({ error: String((err && err.stack) || err) });
        }
      };
    }
  
    process(inputs, outputs) {
      const out = outputs[0];
      if (!this.core || !out || !out.length) return true;
      const n = out[0].length;
      this.core.process(out[0], out[1] || out[0], n);
      return true;
    }
  }
  
  registerProcessor('sigil-voice', SigilVoiceProcessor);