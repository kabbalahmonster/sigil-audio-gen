'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS v2 — the sigil draws what it is hearing
   --------------------------------------------------------------------------
   1 · Wave ring     the real output waveform wrapped around the seal, so the
                     circle itself breathes and ripples with the sound
   2 · Harmonic crown  the current cube cell's 24 partials, as rays
   3 · Vowel glyph   the vowel being sung, fading beneath the seal
   4 · Grit tears    small horizontal glitches when the crusher is hard on

   Budget: one 512-byte analyser read, about 150 canvas ops per frame, and no
   allocation inside the loop. Lite mode drops the wave ring to every other
   sample and skips the tears.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';
  let timeBuf = null;

  Hooks.on('drawPlaying', ({ r, g, F, kp }) => {
    const v = Sound.view();
    if (!v.P || !v.mags) return;
    const A = r.pal.accent, L = r.pal.line;
    const eng = Sound.live();

    /* 1 · Wave ring: the output waveform becomes the seal's outer circle. */
    if (eng && eng.analyser) {
      const an = eng.analyser, n = an.fftSize;
      if (!timeBuf || timeBuf.length !== n) timeBuf = new Uint8Array(n);
      an.getByteTimeDomainData(timeBuf);
      const step = Sound.lite ? 8 : 4;
      const pts = Math.floor(n / step);
      g.beginPath();
      for (let i = 0; i <= pts; i++) {
        const s = timeBuf[(i % pts) * step];
        const amp = (s - 128) / 128;
        const rad = F.R * (1.08 + amp * 0.085 * (0.8 + 0.5 * kp));
        const th = (TAU * i) / pts + F.base;
        const x = F.cx + Math.sin(th) * rad, y = F.cy - Math.cos(th) * rad;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.strokeStyle = rgba(L, 0.32);
      g.lineWidth = 1.1;
      g.stroke();
    }

    /* 2 · Harmonic crown. */
    const m = v.mags, N = m.length, lift = 0.8 + 0.4 * kp;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const th = (TAU * i) / N + F.base;
      const s = Math.sin(th), c = Math.cos(th);
      const r0 = F.R * 1.24, r1 = F.R * (1.24 + m[i] * 0.13 * lift);
      g.moveTo(F.cx + s * r0, F.cy - c * r0);
      g.lineTo(F.cx + s * r1, F.cy - c * r1);
    }
    g.strokeStyle = rgba(A, 0.36);
    g.lineWidth = 1.2;
    g.stroke();

    /* 3 · Vowel glyph. */
    const lv = Sound.lastVowel();
    if (lv) {
      const age = (performance.now() - lv.at) / 1000;
      if (age < 1.2) {
        g.fillStyle = rgba(L, (1 - age / 1.2) * 0.45);
        g.font = `italic ${Math.max(11, F.R * 0.09)}px ${SERIF}`;
        g.textAlign = 'center';
        g.fillText(lv.name, F.cx, F.cy + F.R * 1.62);
      }
    }

    /* 4 · Grit tears (visual only, so Math.random is fine). */
    if (!Sound.lite && v.P.grit > 0.5 && kp > 0.55 && Math.random() < 0.3) {
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

window.SoundVisuals = SoundVisuals;