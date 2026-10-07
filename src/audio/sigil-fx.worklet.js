/* ══════════════════════════════════════════════════════════════════════════
   sigil-fx.worklet.js v2 — drive → wavefold → bit-depth → sample-hold
   One instance per song, so the cost is constant regardless of polyphony.
   Deterministic: dither comes from an integer LCG seeded at construction.
   ══════════════════════════════════════════════════════════════════════════ */
   class SigilFX extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'bits',  defaultValue: 16, minValue: 2, maxValue: 16, automationRate: 'k-rate' },
        { name: 'hold',  defaultValue: 1,  minValue: 1, maxValue: 16, automationRate: 'k-rate' },
        { name: 'fold',  defaultValue: 0,  minValue: 0, maxValue: 1,  automationRate: 'k-rate' },
        { name: 'drive', defaultValue: 0,  minValue: 0, maxValue: 1,  automationRate: 'k-rate' },
        { name: 'mix',   defaultValue: 0,  minValue: 0, maxValue: 1,  automationRate: 'k-rate' },
      ];
    }
  
    constructor() {
      super();
      this.count = 0;
      this.held = [0, 0];
      this.seed = 0x2f6e2b1;
    }
  
    rand() {
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
      return this.seed / 4294967296;
    }
  
    process(inputs, outputs, params) {
      const input = inputs[0], output = outputs[0];
      if (!output || !output.length) return true;
  
      const mix = params.mix[0];
      const len = output[0].length;
  
      // Bypass fast path: copy through and keep the hold counter coherent.
      if (mix <= 0.0001) {
        for (let ch = 0; ch < output.length; ch++) {
          const src = input[ch];
          if (src) output[ch].set(src);
          else output[ch].fill(0);
        }
        this.count += len;
        return true;
      }
  
      const bits = params.bits[0];
      const hold = Math.max(1, Math.round(params.hold[0]));
      const fold = params.fold[0];
      const drive = params.drive[0];
      const levels = Math.pow(2, bits - 1);
      const k = 1 + drive * 5;
      const norm = drive > 0 ? Math.tanh(k) : 1;
  
      for (let i = 0; i < len; i++) {
        const reseed = this.count % hold === 0;
        for (let ch = 0; ch < output.length; ch++) {
          const x = input[ch] ? input[ch][i] : 0;
          if (reseed) {
            let v = drive > 0 ? Math.tanh(x * k) / norm : x;
            if (fold > 0) v = (1 - fold) * v + fold * Math.sin(v * Math.PI * 0.5 * (1 + 3 * fold));
            v = v < -1 ? -1 : v > 1 ? 1 : v;
            v += (this.rand() - 0.5) / levels;
            this.held[ch] = Math.round(v * levels) / levels;
          }
          output[ch][i] = x * (1 - mix) + this.held[ch] * mix;
        }
        this.count++;
      }
      return true;
    }
  }
  
  registerProcessor('sigil-fx', SigilFX);