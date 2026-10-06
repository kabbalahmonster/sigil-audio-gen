/* ══════════════════════════════════════════════════════════════════════════
   sigil-fx.worklet.js — AudioWorklet: bit-depth and sample-rate reduction
   with a wavefold. One instance per song, so the CPU cost is constant.

   Deterministic: dither comes from an integer LCG seeded at construction,
   never from Math.random. Loaded via audioWorklet.addModule() in Sound.prepare().
   ══════════════════════════════════════════════════════════════════════════ */
class SigilFX extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 16, minValue: 2, maxValue: 16, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 1, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'fold', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.count = 0;            // samples since start, shared by both channels
    this.held = [0, 0];        // last held (sample-and-hold) value per channel
    this.seed = 0x2f6e2b1;     // LCG state for deterministic dither
  }

  rand() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;

    const bits = params.bits[0];
    const hold = Math.max(1, Math.round(params.hold[0]));
    const fold = params.fold[0];
    const mix = params.mix[0];
    const levels = Math.pow(2, bits - 1);
    const len = output[0].length;

    for (let i = 0; i < len; i++) {
      const reseed = this.count % hold === 0;    // sample-rate reduction: update every N samples
      for (let ch = 0; ch < output.length; ch++) {
        const x = input[ch] ? input[ch][i] : 0;
        if (reseed) {
          let v = x;
          if (fold > 0) v = (1 - fold) * v + fold * Math.sin(v * Math.PI * 0.5 * (1 + 3 * fold));
          v = Math.max(-1, Math.min(1, v));
          v += (this.rand() - 0.5) / levels;     // dither before quantising
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