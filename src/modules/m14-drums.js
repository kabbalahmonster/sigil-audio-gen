'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m14 · DRUM ENGINE — four kits, tuned to the sigil
   --------------------------------------------------------------------------
   The score still decides WHEN drums play (kick, snare, hat, shaker, crash,
   swell). This module decides HOW they sound. It handles those events through
   the 'voice' hook, only in Sigil mode, so legacy drums remain available.

   KITS (chosen by the patch's 'kit' field, or an Aura)
     bone    deep, dry, short hats
     velvet  soft, warm, with a touch of clap
     glass   bright, ringing, clap-heavy
     ember   driven through the satCurve, lo-fi hats

   TUNING
     The kick's root is 42·2^(tonicPc/12) Hz, so every sigil's kick is in its
     own key. Same sigil, same key, every time.

   COST
     Each hit is one to four short nodes. Noise buffers are shared, and each
     hit's noise offset is seeded from the event, so renders are reproducible.
   ══════════════════════════════════════════════════════════════════════════ */

const DrumEngine = (() => {
  'use strict';

  const KITS = {
    bone:   { kick: 1.0,  kickDecay: 0.42, click: 0.25, snTone: 185, snNoise: 0.6,  snBand: 1900, clap: 0,   hat: 7500, hatDecay: 0.03,  drive: false },
    velvet: { kick: 0.9,  kickDecay: 0.55, click: 0.12, snTone: 200, snNoise: 0.45, snBand: 1400, clap: 0.2, hat: 6000, hatDecay: 0.05,  drive: false },
    glass:  { kick: 1.1,  kickDecay: 0.30, click: 0.35, snTone: 240, snNoise: 0.55, snBand: 3200, clap: 0.6, hat: 9500, hatDecay: 0.02,  drive: false },
    ember:  { kick: 1.05, kickDecay: 0.35, click: 0.30, snTone: 170, snNoise: 0.8,  snBand: 2400, clap: 0.3, hat: 8200, hatDecay: 0.025, drive: true  },
  };

  const bq = (ctx, type, f, q = 0.7) => {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q;
    return b;
  };

  /** Fast attack, exponential decay to silence. */
  function env(g, t, peak, decay) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  }

  /** A shared-buffer noise source, offset from the event seed so each hit differs deterministically. */
  function noise(eng, t, dur) {
    const s = eng.ctx.createBufferSource();
    s.buffer = eng.noiseBuf;
    s.start(t, (eng._nr ? eng._nr() : 0.5) * 1.5, dur);
    return s;
  }

  function kick(eng, t, v, k, f0, out) {
    const ctx = eng.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(f0 * 3, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.04);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + k.kickDecay);
    env(g, t, v * 0.95 * k.kick, k.kickDecay);
    o.connect(g);
    let last = g;
    if (k.drive) {
      const ws = ctx.createWaveShaper();
      ws.curve = eng.satCurve;
      g.connect(ws);
      last = ws;
    }
    last.connect(out);
    o.start(t);
    o.stop(t + k.kickDecay + 0.05);

    // Beater click
    const n = noise(eng, t, 0.03), hp = bq(ctx, 'highpass', 2800), cg = ctx.createGain();
    env(cg, t, v * k.click, 0.008);
    n.connect(hp); hp.connect(cg); cg.connect(out);
  }

  function snare(eng, t, v, k, out) {
    const ctx = eng.ctx;

    // Body: a pitch-dropping triangle
    const body = ctx.createOscillator(), bg = ctx.createGain();
    body.type = 'triangle';
    body.frequency.setValueAtTime(k.snTone * 1.5, t);
    body.frequency.exponentialRampToValueAtTime(k.snTone, t + 0.05);
    env(bg, t, v * 0.35, 0.14);
    body.connect(bg); bg.connect(out);
    body.start(t); body.stop(t + 0.2);

    // Wires
    const n = noise(eng, t, 0.3), bp = bq(ctx, 'bandpass', k.snBand, 0.8), ng = ctx.createGain();
    env(ng, t, v * 0.5 * k.snNoise, 0.16);
    n.connect(bp); bp.connect(ng); ng.connect(out);

    // Clap layer: three tight bursts, then the tail
    if (k.clap > 0) {
      for (const off of [0, 0.011, 0.022]) {
        const c = noise(eng, t + off, 0.05), cb = bq(ctx, 'bandpass', 1200, 1.2), cg = ctx.createGain();
        env(cg, t + off, v * 0.3 * k.clap, 0.03);
        c.connect(cb); cb.connect(cg); cg.connect(out);
      }
    }
  }

  function hat(eng, t, v, k, open, pan, out) {
    const ctx = eng.ctx, n = noise(eng, t, open ? 0.4 : 0.12);
    const hp = bq(ctx, 'highpass', k.hat, 0.7), g = ctx.createGain();
    env(g, t, v * 0.16, open ? 0.22 : k.hatDecay);
    n.connect(hp); hp.connect(g);
    let last = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan || 0;
      g.connect(p);
      last = p;
    }
    last.connect(out);
  }

  function shaker(eng, t, v, out) {
    const n = noise(eng, t, 0.2), bp = bq(eng.ctx, 'bandpass', 5500, 1.2), g = eng.ctx.createGain();
    env(g, t, v * 0.12, 0.03);
    n.connect(bp); bp.connect(g); g.connect(out);
  }

  function crash(eng, t, v, out) {
    const n = noise(eng, t, 2), hp = bq(eng.ctx, 'highpass', 4200, 0.5), g = eng.ctx.createGain();
    env(g, t, v * 0.12, 1.1);
    n.connect(hp); hp.connect(g); g.connect(out);
  }

  /** Rising filtered noise: the breath before a chorus. */
  function swell(eng, t, v, dur, out) {
    const ctx = eng.ctx, n = noise(eng, t, Math.min(dur, 1.95));
    const bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = 'bandpass'; bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.09, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(bp); bp.connect(g); g.connect(out);
  }

  Hooks.on('voice', (_, ev, t, eng) => {
    if (Sound.mode !== 'sigil' || !eng.buses || !Sound.view().P) return null;
    const P = Sound.view().P;
    const k = KITS[P.kit] || KITS.bone;
    const out = eng.buses.drums;
    const tonic = eng.song ? eng.song.tonicPc : 0;
    const f0 = 42 * Math.pow(2, tonic / 12);      // kick root in the sigil's key

    switch (ev.type) {
      case 'kick':    kick(eng, t, ev.vel, k, f0, out); return true;
      case 'snare':   snare(eng, t, ev.vel, k, out); return true;
      case 'hat':     hat(eng, t, ev.vel, k, ev.open, ev.pan, out); return true;
      case 'shaker':  shaker(eng, t, ev.vel, out); return true;
      case 'crash':   crash(eng, t, ev.vel, eng.buses.bell); return true;
      case 'swell':   swell(eng, t, ev.vel, (ev.dur || 4) * eng.spb, eng.buses.bell); return true;
      default: return null;
    }
  }, 0);

  return { KITS };
})();