'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS — the sigil draws what it is hearing
   --------------------------------------------------------------------------
   Four layers, all drawn from existing state. Nothing here changes the sound.
     1. Harmonic crown   the 24 partials of the current morph, as rays
     2. Spectrum halo    the live analyser, as a ring of dots (skipped in lite)
     3. Vowel glyph      the vowel being sung, fading out beneath the seal
     4. Grit glitch      small horizontal tears when the crusher is hard on
   Cost: about 90 canvas ops per frame. No per-frame allocation.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';
  let freqBuf = null;

  Hooks.on('drawPlaying', ({ r, g, F, kp }) => {
    const v = Sound.view();
    if (!v.P || !v.mags) return;
    const A = r.pal.accent, L = r.pal.line;
    const lift = 0.8 + 0.4 * kp;                       // the crown swells on the kick

    // 1 · Harmonic crown
    const m = v.mags, N = m.length;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const th = (TAU * i) / N + F.base;
      const s = Math.sin(th), c = Math.cos(th);
      const r0 = F.R * 1.2, r1 = F.R * (1.2 + m[i] * 0.13 * lift);
      g.moveTo(F.cx + s * r0, F.cy - c * r0);
      g.lineTo(F.cx + s * r1, F.cy - c * r1);
    }
    g.strokeStyle = rgba(A, 0.38);
    g.lineWidth = 1.2;
    g.stroke();

    // 2 · Spectrum halo (lite mode skips it)
    const eng = Sound.live();
    if (eng && eng.analyser && !Sound.lite) {
      const an = eng.analyser, n = an.frequencyBinCount;
      if (!freqBuf || freqBuf.length !== n) freqBuf = new Uint8Array(n);
      an.getByteFrequencyData(freqBuf);
      for (let i = 0; i < 64; i++) {
        // Logarithmic bin mapping, so the low end is not a sliver
        const bin = Math.min(n - 1, Math.floor(Math.pow(i / 64, 1.8) * n * 0.5));
        const val = freqBuf[bin] / 255;
        const th = (TAU * i) / 64 + F.base;
        const rad = F.R * 1.38 + val * F.R * 0.08;
        g.fillStyle = rgba(L, 0.12 + val * 0.5);
        g.fillRect(F.cx + Math.sin(th) * rad - 1, F.cy - Math.cos(th) * rad - 1, 2, 2);
      }
    }

    // 3 · Vowel glyph
    const lv = Sound.lastVowel();
    if (lv) {
      const age = (performance.now() - lv.at) / 1000;
      if (age < 1.2) {
        g.fillStyle = rgba(L, (1 - age / 1.2) * 0.45);
        g.font = `italic ${Math.max(11, F.R * 0.09)}px ${SERIF}`;
        g.textAlign = 'center';
        g.fillText(lv.name, F.cx, F.cy + F.R * 1.6);
      }
    }

    // 4 · Grit glitch (visual only, so Math.random is fine here)
    if (v.P.grit > 0.5 && kp > 0.55 && Math.random() < 0.3) {
      g.fillStyle = rgba(A, 0.25);
      for (let j = 0; j < 2; j++) {
        const x = F.cx - F.R * 1.3 + Math.random() * F.R * 2.6;
        const y = F.cy + (Math.random() - 0.5) * F.R * 1.4;
        g.fillRect(x, y, F.R * (0.05 + Math.random() * 0.2), 2);
      }
    }
  });

  return {};
})();