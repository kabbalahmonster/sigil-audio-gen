'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS — the sigil draws what it is hearing (v2)
   --------------------------------------------------------------------------
   1. Waveform ring   the crushed output of the current patch, wrapped around
                      the wheel. Its radius is the sound; its stepping is the
                      bit depth and sample hold.
   2. Harmonic crown  the partials of the current morph position, as rays.
   3. Note ripples    an expanding ring for each recent onset, timed by the
                      musical beat, so a ripple meets its note.
   4. Spectrum halo   the live analyser, as dots (skipped in lite mode).
   5. Vowel glyph     the vowel being sung, fading below the seal.
   6. Grit tears      horizontal glitches when the crusher is hard on.

   PERFORMANCE
     The ring and the crown are read from precomputed arrays, so the frame loop
     makes no allocations and no trig beyond the two small 128-point loops.
     The ring is one closed path. Ripples are at most 16 circles.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';
  let freqBuf = null;

  Hooks.on('drawPlaying', ({ r, g, F, kp, beat }) => {
    const v = Sound.view();
    if (!v.P || !v.mags || !v.ring) return;
    const A = r.pal.accent, L = r.pal.line;
    const lift = 0.8 + 0.4 * kp;

    // 1 · Waveform ring (the crushed output, as the sigil's own outline)
    const ring = v.ring.crushed, N = ring.length;
    const clean = v.ring.clean;
    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const j = i % N;
      const th = (TAU * j) / N + F.base;
      const rad = F.R * (1.3 + 0.075 * ring[j] * lift);
      const x = F.cx + Math.sin(th) * rad, y = F.cy - Math.cos(th) * rad;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.strokeStyle = rgba(A, 0.5);
    g.lineWidth = 1.3;
    g.stroke();

    // The clean waveform sits faintly inside the crushed one, so the difference shows
    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const j = i % N;
      const th = (TAU * j) / N + F.base;
      const rad = F.R * (1.3 + 0.075 * clean[j] * lift);
      const x = F.cx + Math.sin(th) * rad, y = F.cy - Math.cos(th) * rad;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.strokeStyle = rgba(L, 0.14);
    g.lineWidth = 1;
    g.stroke();

    // 2 · Harmonic crown
    const m = v.mags, M = m.length;
    g.beginPath();
    for (let i = 0; i < M; i++) {
      const th = (TAU * i) / M + F.base;
      const s = Math.sin(th), c = Math.cos(th);
      const r0 = F.R * 1.18, r1 = F.R * (1.18 + m[i] * 0.1 * lift);
      g.moveTo(F.cx + s * r0, F.cy - c * r0);
      g.lineTo(F.cx + s * r1, F.cy - c * r1);
    }
    g.strokeStyle = rgba(A, 0.35);
    g.lineWidth = 1.1;
    g.stroke();

    // 3 · Note ripples, timed to the beat (or to wall-clock for keys)
    const notes = Sound.recentNotes();
    for (const n of notes) {
      let age;
      if (n.beat != null && beat != null) {
        age = (beat - n.beat) / 1.5;                       // a ripple lives 1.5 beats
        if (age < -0.05 || age > 1) continue;
        age = Math.max(0, age);
      } else {
        age = (performance.now() - n.at) / 1500;
        if (age < 0 || age > 1) continue;
      }
      const rr = F.R * (1.05 + age * 0.9);
      g.beginPath();
      g.arc(F.cx, F.cy, rr, 0, TAU);
      g.strokeStyle = rgba(n.kind === 'pad' ? L : A, (1 - age) * 0.28);
      g.lineWidth = 1;
      g.stroke();
    }

    // 4 · Spectrum halo (skipped in lite mode)
    const eng = Sound.live();
    if (eng && eng.analyser && !Sound.lite) {
      const an = eng.analyser, n = an.frequencyBinCount;
      if (!freqBuf || freqBuf.length !== n) freqBuf = new Uint8Array(n);
      an.getByteFrequencyData(freqBuf);
      for (let i = 0; i < 64; i++) {
        const bin = Math.min(n - 1, Math.floor(Math.pow(i / 64, 1.8) * n * 0.5));
        const val = freqBuf[bin] / 255;
        const th = (TAU * i) / 64 + F.base;
        const rad = F.R * 1.44 + val * F.R * 0.07;
        g.fillStyle = rgba(L, 0.1 + val * 0.45);
        g.fillRect(F.cx + Math.sin(th) * rad - 1, F.cy - Math.cos(th) * rad - 1, 2, 2);
      }
    }

    // 5 · Vowel glyph
    const lv = Sound.lastVowel();
    if (lv) {
      const age = (performance.now() - lv.at) / 1000;
      if (age < 1.2) {
        g.fillStyle = rgba(L, (1 - age / 1.2) * 0.45);
        g.font = `italic ${Math.max(11, F.R * 0.09)}px ${SERIF}`;
        g.textAlign = 'center';
        g.fillText(lv.name, F.cx, F.cy + F.R * 1.66);
      }
    }

    // 6 · Grit tears (visual only, so Math.random is fine)
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