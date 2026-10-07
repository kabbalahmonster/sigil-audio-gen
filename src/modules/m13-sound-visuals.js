'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS v3 — structural, three-dimensional
   --------------------------------------------------------------------------
   Nothing here wobbles. The sound is rendered as architecture.

   1 · WAVE TERRAIN   a waterfall of captured waveform scans receding into the
                      distance, with vertical struts every few columns, so the
                      sound reads as a built surface rather than a line
   2 · CUBE FRAME     the wavetable cube projected behind the seal: 9 columns
                      by 5 layers, with the current cell and the travel vector
   3 · CROWN          the 24 partials as fixed radial architecture
   4 · VOWEL          the sung vowel, beneath the seal

   BUDGET  one analyser read per frame; scans are captured at 20 Hz into a
   preallocated ring buffer; nothing is allocated inside the draw loop.
   Lite mode halves the rows and columns and drops the struts.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';

  const ROWS_FULL = 22, COLS_FULL = 64;
  const ROWS_LITE = 10, COLS_LITE = 32;
  const CAPTURE_MS = 50;                      // 20 scans a second

  let rows = ROWS_FULL, cols = COLS_FULL;
  let grid = new Float32Array(rows * cols);   // ring buffer of scans, newest at `head`
  let head = 0, lastCapture = 0, timeBuf = null;

  function resize(lite) {
    const r = lite ? ROWS_LITE : ROWS_FULL, c = lite ? COLS_LITE : COLS_FULL;
    if (r === rows && c === cols) return;
    rows = r; cols = c;
    grid = new Float32Array(rows * cols);
    head = 0;
  }

  /** Capture one scan: the waveform, downsampled to `cols` by peak. */
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
  }

  Hooks.on('drawPlaying', ({ r, g, F, kp }) => {
    const v = Sound.view();
    if (!v.P || !v.mags) return;
    const A = r.pal.accent, L = r.pal.line;
    const liteOn = Sound.lite;
    resize(liteOn);

    const eng = Sound.live();
    const now = performance.now();
    if (eng && eng.analyser && now - lastCapture > CAPTURE_MS) {
      lastCapture = now;
      capture(eng.analyser);
    }

    /* ── 1 · WAVE TERRAIN ──────────────────────────────────────────────
       Rows recede upward and shrink. Row 0 is the newest and nearest. The
       vanishing point sits above the seal, so the terrain reads as a floor
       the sigil stands on. */
    if (eng && eng.analyser) {
      const baseY = F.cy + F.R * 1.12;      // the near edge
      const depthY = F.R * 0.62;            // how far back the far edge sits
      const nearW = F.R * 2.25;
      const amp = F.R * 0.16 * (0.85 + 0.4 * kp);

      // Painter's algorithm: far rows first, so near rows overlap them.
      for (let d = rows - 1; d >= 0; d--) {
        const idx = ((head - d) + rows * 2) % rows;
        const k = d / (rows - 1 || 1);       // 0 near … 1 far
        const persp = 1 - 0.52 * k;          // width and amplitude shrink with depth
        const y0 = baseY - k * depthY;
        const w = nearW * persp;
        const a = (1 - k) * 0.5 + 0.06;
        const base = idx * cols;

        g.beginPath();
        for (let c = 0; c < cols; c++) {
          const x = F.cx - w / 2 + (c / (cols - 1)) * w;
          const y = y0 - grid[base + c] * amp * persp;
          c ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.strokeStyle = rgba(d === 0 ? A : L, d === 0 ? 0.8 : a * 0.45);
        g.lineWidth = d === 0 ? 1.4 : 1;
        g.stroke();
      }

      // Struts: connect the same column across depth, turning the rows into a mesh.
      if (!liteOn) {
        const stride = 8;
        g.beginPath();
        for (let c = 0; c < cols; c += stride) {
          for (let d = 0; d < rows; d++) {
            const idx = ((head - d) + rows * 2) % rows;
            const k = d / (rows - 1 || 1);
            const persp = 1 - 0.52 * k;
            const w = nearW * persp;
            const x = F.cx - w / 2 + (c / (cols - 1)) * w;
            const y = (F.cy + F.R * 1.12) - k * depthY - grid[idx * cols + c] * amp * persp;
            d ? g.lineTo(x, y) : g.moveTo(x, y);
          }
        }
        g.strokeStyle = rgba(L, 0.13);
        g.lineWidth = 1;
        g.stroke();
      }
    }

    /* ── 2 · CUBE FRAME ────────────────────────────────────────────────
       The wavetable cube, projected behind the seal in a shallow isometric.
       X is the path growth, Y is the spectral layer, and the bright node is
       where this patch currently sits. */
    if (!liteOn) {
      const P = v.P;
      const ox = F.cx, oy = F.cy - F.R * 1.02;
      const sx = F.R * 0.085, sy = F.R * 0.085, skew = F.R * 0.05;
      const px = (x, y) => ox + (x - 4) * sx + (y - 2) * skew;
      const py = (x, y) => oy - (y - 2) * sy + (x - 4) * skew * 0.18;

      g.strokeStyle = rgba(L, 0.16);
      g.lineWidth = 1;
      g.beginPath();
      for (let y = 0; y < SoundDesign.FY; y++) {
        g.moveTo(px(0, y), py(0, y));
        for (let x = 1; x < SoundDesign.FX; x++) g.lineTo(px(x, y), py(x, y));
      }
      for (let x = 0; x < SoundDesign.FX; x++) {
        g.moveTo(px(x, 0), py(x, 0));
        for (let y = 1; y < SoundDesign.FY; y++) g.lineTo(px(x, y), py(x, y));
      }
      g.stroke();

      const x0 = clamp(P.wave, 0, 8), y0 = clamp(P.layer, 0, 4);
      const x1 = clamp(x0 + P.sweep * 4, 0, 8), y1 = clamp(y0 + P.drift * 2.5, 0, 4);
      g.strokeStyle = rgba(A, 0.5);
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(px(x0, y0), py(x0, y0));
      g.lineTo(px(x1, y1), py(x1, y1));
      g.stroke();
      g.fillStyle = rgba(A, 0.95);
      g.beginPath(); g.arc(px(x0, y0), py(x0, y0), 2.6, 0, TAU); g.fill();
    }

    /* ── 3 · CROWN: the partials as fixed radial architecture ─────────── */
    const m = v.mags, N = m.length, lift = 0.85 + 0.3 * kp;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const th = (TAU * i) / N + F.base;
      const s = Math.sin(th), c = Math.cos(th);
      const r0 = F.R * 1.2, r1 = F.R * (1.2 + m[i] * 0.12 * lift);
      g.moveTo(F.cx + s * r0, F.cy - c * r0);
      g.lineTo(F.cx + s * r1, F.cy - c * r1);
    }
    g.strokeStyle = rgba(A, 0.34);
    g.lineWidth = 1.2;
    g.stroke();

    // A hairline arc joining the crown's tips: the spectrum as a silhouette.
    if (!liteOn) {
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const th = (TAU * j) / N + F.base;
        const rad = F.R * (1.2 + m[j] * 0.12 * lift);
        const x = F.cx + Math.sin(th) * rad, y = F.cy - Math.cos(th) * rad;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = rgba(A, 0.14);
      g.lineWidth = 1;
      g.stroke();
    }

    /* ── 4 · VOWEL ─────────────────────────────────────────────────────── */
    const lv = Sound.lastVowel();
    if (lv) {
      const age = (performance.now() - lv.at) / 1000;
      if (age < 1.2) {
        g.fillStyle = rgba(L, (1 - age / 1.2) * 0.4);
        g.font = `italic ${Math.max(11, F.R * 0.085)}px ${SERIF}`;
        g.textAlign = 'center';
        g.fillText(lv.name, F.cx, F.cy + F.R * 0.96);
      }
    }
  });

  return {};
})();

if (typeof window !== 'undefined') window.SoundVisuals = SoundVisuals;