'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS v4 — three ways of seeing the sound
   --------------------------------------------------------------------------
   RING      the crushed waveform wrapped around the wheel, with the clean
             wave ghosted inside it, a harmonic crown, and note ripples
   TERRAIN   a waterfall of captured scans receding in perspective, with
             struts, COLOURED BY SPECTRAL CENTROID: dark where the sound is
             low and heavy, accent-bright where it is shrill
   DOME      the hybrid: the terrain wrapped into a polar contour map, each
             scan a closed ring, newest innermost, so the sound becomes a
             topography around the seal

   All three share the crown, the vowel glyph and the grit tears.
   Scans are captured at 20 Hz into preallocated buffers. Nothing allocates
   inside the frame loop.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';

  const MODES = [['ring', 'Ring'], ['terrain', 'Terrain'], ['dome', 'Dome']];
  const ROWS_FULL = 22, COLS_FULL = 64;
  const ROWS_LITE = 10, COLS_LITE = 32;
  const CAPTURE_MS = 50;

  const S = { mode: Prefs.get('visuals.mode', 'ring'), crown: Prefs.get('visuals.crown', true),
              halo: Prefs.get('visuals.halo', true), ...{} };

  let rows = ROWS_FULL, cols = COLS_FULL;
  let grid = new Float32Array(rows * cols);
  let hue = new Float32Array(rows);          // spectral centroid per scan, 0…1
  let head = 0, lastCapture = 0;
  let timeBuf = null, freqBuf = null;

  function resize(lite) {
    const r = lite ? ROWS_LITE : ROWS_FULL, c = lite ? COLS_LITE : COLS_FULL;
    if (r === rows && c === cols) return;
    rows = r; cols = c;
    grid = new Float32Array(rows * cols);
    hue = new Float32Array(rows);
    head = 0;
  }

  /** Capture one scan plus its spectral centroid (the colour). */
  function capture(an) {
    const n = an.fftSize;
    if (!timeBuf || timeBuf.length !== n) timeBuf = new Uint8Array(n);
    an.getByteTimeDomainData(timeBuf);
    head = (head + 1) % rows;
    const base = head * cols, step = n / cols;
    for (let c = 0; c < cols; c++) {
      let peak = 0;
      const from = Math.floor(c * step), to = Math.floor((c + 1) * step);
      for (let i = from; i < to; i++) {
        const v = (timeBuf[i] - 128) / 128;
        if (Math.abs(v) > Math.abs(peak)) peak = v;
      }
      grid[base + c] = peak;
    }
    const bins = an.frequencyBinCount;
    if (!freqBuf || freqBuf.length !== bins) freqBuf = new Uint8Array(bins);
    an.getByteFrequencyData(freqBuf);
    let num = 0, den = 1e-9;
    for (let i = 0; i < bins; i++) { num += i * freqBuf[i]; den += freqBuf[i]; }
    hue[head] = clamp((num / den) / (bins * 0.4), 0, 1);     // 0 dark … 1 shrill
  }

  /** Blend ink toward ember by the scan's brightness. */
  function colourOf(L, A, k, alpha) {
    const r = L[0] + (A[0] - L[0]) * k;
    const g = L[1] + (A[1] - L[1]) * k;
    const b = L[2] + (A[2] - L[2]) * k;
    return `rgba(${r | 0},${g | 0},${b | 0},${alpha.toFixed(3)})`;
  }

  /* ── Shared layers ───────────────────────────────────────────────────── */

  function drawCrown(g, F, mags, A, kp) {
    const M = mags.length, lift = 0.85 + 0.35 * kp;
    g.beginPath();
    for (let i = 0; i < M; i++) {
      const th = (TAU * i) / M + F.base;
      const s = Math.sin(th), c = Math.cos(th);
      const r0 = F.R * 1.18, r1 = F.R * (1.18 + mags[i] * 0.1 * lift);
      g.moveTo(F.cx + s * r0, F.cy - c * r0);
      g.lineTo(F.cx + s * r1, F.cy - c * r1);
    }
    g.strokeStyle = rgba(A, 0.35);
    g.lineWidth = 1.1;
    g.stroke();
  }

  function drawRipples(g, F, beat, A, L) {
    for (const n of Sound.recentNotes()) {
      let age;
      if (n.beat != null && beat != null) {
        age = (beat - n.beat) / 1.5;
        if (age < -0.05 || age > 1) continue;
        age = Math.max(0, age);
      } else {
        age = (performance.now() - n.at) / 1500;
        if (age < 0 || age > 1) continue;
      }
      g.beginPath();
      g.arc(F.cx, F.cy, F.R * (1.05 + age * 0.9), 0, TAU);
      g.strokeStyle = rgba(n.kind === 'pad' ? L : A, (1 - age) * 0.26);
      g.lineWidth = 1;
      g.stroke();
    }
  }

  function closedRing(g, F, arr, radius, amp) {
    const N = arr.length;
    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const j = i % N;
      const th = (TAU * j) / N + F.base;
      const rad = F.R * (radius + amp * arr[j]);
      const x = F.cx + Math.sin(th) * rad, y = F.cy - Math.cos(th) * rad;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
  }

  /* ── Modes ───────────────────────────────────────────────────────────── */

  function drawRing(g, F, v, A, L, kp, beat) {
    const lift = 0.8 + 0.4 * kp;
    closedRing(g, F, v.ring.crushed, 1.3, 0.075 * lift);
    g.strokeStyle = rgba(A, 0.5); g.lineWidth = 1.3; g.stroke();
    closedRing(g, F, v.ring.clean, 1.3, 0.075 * lift);
    g.strokeStyle = rgba(L, 0.14); g.lineWidth = 1; g.stroke();
    drawRipples(g, F, beat, A, L);
  }

  function drawTerrain(g, F, A, L, kp, lite) {
    const baseY = F.cy + F.R * 1.12, depthY = F.R * 0.62;
    const nearW = F.R * 2.25, amp = F.R * 0.16 * (0.85 + 0.4 * kp);

    for (let d = rows - 1; d >= 0; d--) {
      const idx = ((head - d) + rows * 2) % rows;
      const k = d / (rows - 1 || 1);
      const persp = 1 - 0.52 * k, y0 = baseY - k * depthY, w = nearW * persp;
      const base = idx * cols;
      g.beginPath();
      for (let c = 0; c < cols; c++) {
        const x = F.cx - w / 2 + (c / (cols - 1)) * w;
        const y = y0 - grid[base + c] * amp * persp;
        c ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = colourOf(L, A, hue[idx], (1 - k) * 0.55 + 0.06);
      g.lineWidth = d === 0 ? 1.5 : 1;
      g.stroke();
    }

    if (!lite) {
      g.beginPath();
      for (let c = 0; c < cols; c += 8) {
        for (let d = 0; d < rows; d++) {
          const idx = ((head - d) + rows * 2) % rows;
          const k = d / (rows - 1 || 1), persp = 1 - 0.52 * k;
          const w = nearW * persp;
          const x = F.cx - w / 2 + (c / (cols - 1)) * w;
          const y = baseY - k * depthY - grid[idx * cols + c] * amp * persp;
          d ? g.lineTo(x, y) : g.moveTo(x, y);
        }
      }
      g.strokeStyle = rgba(L, 0.13);
      g.lineWidth = 1;
      g.stroke();
    }
  }

  function drawDome(g, F, A, L, kp, lite) {
    // Each scan becomes a closed contour. Newest innermost, oldest outermost,
    // so the sound's history is a topographic map around the seal.
    const amp = 0.055 * (0.85 + 0.4 * kp);
    for (let d = rows - 1; d >= 0; d--) {
      const idx = ((head - d) + rows * 2) % rows;
      const k = d / (rows - 1 || 1);
      const radius = 1.12 + k * 0.55;
      const base = idx * cols;
      const N = cols;
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const th = (TAU * j) / N + F.base;
        const rad = F.R * (radius + amp * grid[base + j] * (1 - 0.4 * k));
        const x = F.cx + Math.sin(th) * rad, y = F.cy - Math.cos(th) * rad;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = colourOf(L, A, hue[idx], (1 - k) * 0.45 + 0.05);
      g.lineWidth = d === 0 ? 1.4 : 1;
      g.stroke();
    }
    if (!lite) {
      // Meridians: join the same column across every contour.
      g.beginPath();
      for (let c = 0; c < cols; c += 4) {
        for (let d = 0; d < rows; d++) {
          const idx = ((head - d) + rows * 2) % rows;
          const k = d / (rows - 1 || 1);
          const radius = 1.12 + k * 0.55;
          const th = (TAU * c) / cols + F.base;
          const rad = F.R * (radius + amp * grid[idx * cols + c] * (1 - 0.4 * k));
          const x = F.cx + Math.sin(th) * rad, y = F.cy - Math.cos(th) * rad;
          d ? g.lineTo(x, y) : g.moveTo(x, y);
        }
      }
      g.strokeStyle = rgba(L, 0.1);
      g.lineWidth = 1;
      g.stroke();
    }
  }

  /* ── Frame ───────────────────────────────────────────────────────────── */

  Hooks.on('drawPlaying', ({ r, g, F, kp, beat }) => {
    const v = Sound.view();
    if (!v.P || !v.mags) return;
    const A = r.pal.accent, L = r.pal.line;
    const lite = Sound.lite;
    resize(lite);

    const eng = Sound.live();
    const now = performance.now();
    if (eng && eng.analyser && S.mode !== 'ring' && now - lastCapture > CAPTURE_MS) {
      lastCapture = now;
      capture(eng.analyser);
    }

    if (S.mode === 'ring') { if (v.ring) drawRing(g, F, v, A, L, kp, beat); }
    else if (S.mode === 'terrain') drawTerrain(g, F, A, L, kp, lite);
    else drawDome(g, F, A, L, kp, lite);

    if (S.crown) drawCrown(g, F, v.mags, A, kp);

    // Spectrum halo
    if (S.halo && !lite && eng && eng.analyser) {
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

    // Vowel glyph
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

    // Grit tears
    if (!lite && v.P.grit > 0.5 && kp > 0.55 && Math.random() < 0.3) {
      g.fillStyle = rgba(A, 0.25);
      for (let j = 0; j < 2; j++) {
        const x = F.cx - F.R * 1.3 + Math.random() * F.R * 2.6;
        const y = F.cy + (Math.random() - 0.5) * F.R * 1.4;
        g.fillRect(x, y, F.R * (0.05 + Math.random() * 0.2), 2);
      }
    }
  });

  UI.section({ id: 'visuals', title: 'Visuals', order: 13, build(el) {
    el.append(
      UI.note('Ring wraps the waveform around the wheel. Terrain is a receding landscape of the last second of sound. Dome wraps that landscape into a contour map. Terrain and Dome are coloured by brightness: dark where the sound is heavy, ember where it is shrill.'),
      UI.select({ label: 'Mode', value: S.mode, options: MODES,
        onChange: (v) => { S.mode = v; Prefs.set('visuals.mode', v); } }),
      UI.check({ label: 'Harmonic crown', checked: S.crown, onChange: (v) => { S.crown = v; Prefs.set('visuals.crown', v); } }),
      UI.check({ label: 'Spectrum halo', checked: S.halo, onChange: (v) => { S.halo = v; Prefs.set('visuals.halo', v); } }));
  } });

  return { setMode(m) { S.mode = m; Prefs.set('visuals.mode', m); } };
})();

if (typeof window !== 'undefined') window.SoundVisuals = SoundVisuals;