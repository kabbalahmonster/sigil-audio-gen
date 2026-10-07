'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M14 · SCOPE — the sound made visible
   --------------------------------------------------------------------------
   Three cheap additions, all driven by one AnalyserNode:
     • a spectrum ring on the rim: 32–64 radial ticks, the music's own halo
     • the derived single cycle drawn at the hub: you watch the timbre
     • RMS drives an extra glow on the live stroke, and at high crush the
       drawn path is quantised to a grid, so the picture is bit-crushed too

   Everything respects M5's reduced-motion setting and the quality tier.
   ══════════════════════════════════════════════════════════════════════════ */
const Scope = (() => {
  'use strict';

  let freq = null, time = null, rms = 0;

  Hooks.on('drawPlaying', ({ r, g, F, beat, lines, app: A }) => {
    const eng = A.engine, an = eng && eng.analyser;
    if (!an || (typeof Access !== 'undefined' && Access.reduced())) return;

    const bins = eng.tier ? eng.tier.bins : 32;
    if (!bins) return;
    if (!freq || freq.length !== an.frequencyBinCount) {
      freq = new Uint8Array(an.frequencyBinCount);
      time = new Uint8Array(an.fftSize);
    }
    an.getByteFrequencyData(freq);

    /* ── Rim spectrum. One tick per bin, logarithmically spaced so the bass
          does not eat the whole ring. ── */
    const N = Math.min(bins, 64);
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const src = Math.floor(Math.pow(i / N, 1.7) * (freq.length * 0.6));
      const v = freq[src] / 255;
      const th = (TAU * i) / N;
      const r0 = F.R * 1.205, r1 = F.R * (1.205 + v * 0.12);
      g.moveTo(F.cx + Math.sin(th) * r0, F.cy - Math.cos(th) * r0);
      g.lineTo(F.cx + Math.sin(th) * r1, F.cy - Math.cos(th) * r1);
    }
    g.strokeStyle = rgba(r.pal.accent, 0.3);
    g.lineWidth = 1.2;
    g.stroke();

    /* ── The waveform at the hub: the sigil's silhouette, one cycle, turning
          slowly so it reads as alive rather than as a diagram. ── */
    const prof = eng.profile;
    if (prof) {
      const rad = F.R * 0.09, spin = beat * 0.06;
      g.beginPath();
      for (let i = 0; i <= prof.length; i++) {
        const v = prof[i % prof.length];
        const th = (TAU * i) / prof.length + spin;
        const rr = rad * (1 + v * 0.55);
        const x = F.cx + Math.sin(th) * rr, y = F.cy - Math.cos(th) * rr;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.strokeStyle = rgba(r.pal.line, 0.35);
      g.lineWidth = 1;
      g.stroke();
    }

    /* ── Loudness glow on the live stroke. ── */
    let sum = 0;
    for (let i = 0; i < N; i++) sum += freq[i];
    rms = rms * 0.8 + (sum / (N * 255)) * 0.2;
    const live = lines[lines.length - 1];
    if (live && rms > 0.05) r.strokeGlow(live, r.pal.accent, 0.12 * rms, 2.4);

    /* ── Bit-crush the picture too: quantise the live stroke to a grid whose
          coarseness follows the crush amount. Costs one extra stroke. ── */
    const crush = eng.patch ? eng.patch.crush : 0;
    if (crush > 0.25 && live) {
      const step = F.R * (0.02 + crush * 0.07);
      const q = new Array(live.length);
      for (let i = 0; i < live.length; i++) q[i] = Math.round(live[i] / step) * step;
      r.strokeGlow(q, r.pal.line, 0.3 * crush, 1);
    }
  });

  return { rms: () => rms };
})();