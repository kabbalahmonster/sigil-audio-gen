'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS v5
   --------------------------------------------------------------------------
   STYLES   none · terrain · orbit · ring · pillars · strata     (press N)
   COLOUR   every style is tinted by the SPECTRAL CENTROID of each captured
            scan, so bright sound reads accent and dark sound reads ink.
   DATA     one capture at 20 Hz holds both a waveform scan and a spectrum
            scan. Drawing scrolls by the fraction of a capture period, so
            motion is continuous at 60 fps from 20 Hz data.
   BUDGET   preallocated arrays, no allocation in the frame loop, automatic
            downgrade when frames run long.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';

  const MODES = ['terrain', 'orbit', 'ring', 'pillars', 'strata', 'none'];
  const LABEL = {
    terrain: 'Terrain · a receding surface',
    orbit: 'Orbit · the terrain around the seal',
    ring: 'Ring · the wheel’s waveform',
    pillars: 'Pillars · the spectrum marching into depth',
    strata: 'Strata · stacked slabs of sound',
    none: 'None · the sigil alone',
  };
  let mode = Prefs.get('visual.mode', 'terrain');
  let glow = Prefs.get('visual.glow', true);

  const CAP = 50;
  const SIZES = { full: [22, 64], small: [10, 32] };
  let rows = 22, cols = 64;
  let tgrid = new Float32Array(22 * 64);   // waveform peaks
  let fgrid = new Float32Array(22 * 64);   // spectrum magnitudes
  let hue = new Float32Array(22);          // spectral centroid, 0…1
  let head = 0, lastCap = 0, phase = 0;
  let tb = null, fb = null;
  let ema = 16, last = 0, autoSmall = false;

  function resize(small) {
    const [r, c] = small ? SIZES.small : SIZES.full;
    if (r === rows && c === cols) return;
    rows = r; cols = c;
    tgrid = new Float32Array(rows * cols);
    fgrid = new Float32Array(rows * cols);
    hue = new Float32Array(rows);
    head = 0;
  }
  const rowIdx = (d) => ((head - d) % rows + rows) % rows;

  function tint(L, A, t, a) {
    const r = (L[0] + (A[0] - L[0]) * t) | 0;
    const g = (L[1] + (A[1] - L[1]) * t) | 0;
    const b = (L[2] + (A[2] - L[2]) * t) | 0;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }

  function read(an) {
    const n = an.fftSize;
    if (!tb || tb.length !== n) tb = new Uint8Array(n);
    an.getByteTimeDomainData(tb);
  }

  /** One capture: waveform peaks, spectrum columns, and the centroid as colour. */
  function capture(an) {
    const bins = an.frequencyBinCount;
    if (!fb || fb.length !== bins) fb = new Uint8Array(bins);
    an.getByteFrequencyData(fb);

    head = (head + 1) % rows;
    const base = head * cols;

    // Waveform, by peak per column.
    const n = tb.length, step = n / cols;
    for (let c = 0; c < cols; c++) {
      let peak = 0;
      const a = Math.floor(c * step), b = Math.floor((c + 1) * step);
      for (let i = a; i < b; i++) {
        const v = (tb[i] - 128) / 128;
        if (Math.abs(v) > Math.abs(peak)) peak = v;
      }
      tgrid[base + c] = peak;
    }

    // Spectrum, logarithmically mapped, plus the centroid for colour.
    let wsum = 0, msum = 0;
    for (let c = 0; c < cols; c++) {
      const bin = Math.min(bins - 1, Math.floor(Math.pow(c / cols, 1.8) * bins * 0.6));
      const v = fb[bin] / 255;
      fgrid[base + c] = v;
      wsum += v * c;
      msum += v;
    }
    hue[head] = msum > 0.001 ? clamp((wsum / msum) / (cols * 0.55), 0, 1) : 0;
  }

  /* ── Terrain ─────────────────────────────────────────────────────────── */

  function terrain(g, F, A, L, kp, small) {
    const baseY = F.cy + F.R * 1.12, depth = F.R * 0.72, nearW = F.R * 2.3;
    const amp = F.R * 0.2 * (0.85 + 0.4 * kp);
    let PX = 0, PY = 0;
    const proj = (k, c, idx) => {
      const persp = 1 - 0.55 * k;
      PX = F.cx - (nearW * persp) / 2 + (c / (cols - 1)) * nearW * persp;
      PY = baseY - k * depth - tgrid[idx * cols + c] * amp * persp;
    };

    for (let d = rows - 1; d >= 0; d--) {
      const k = (d + phase) / rows;
      if (k >= 1) continue;
      const idx = rowIdx(d), t = hue[idx];

      if (!small && d + 1 < rows) {
        const k2 = (d + 1 + phase) / rows;
        if (k2 < 1) {
          const idx2 = rowIdx(d + 1);
          g.beginPath();
          for (let c = 0; c < cols; c++) { proj(k, c, idx); c ? g.lineTo(PX, PY) : g.moveTo(PX, PY); }
          for (let c = cols - 1; c >= 0; c--) { proj(k2, c, idx2); g.lineTo(PX, PY); }
          g.closePath();
          g.fillStyle = tint(L, A, t, 0.04 + 0.07 * (1 - k));
          g.fill();
        }
      }

      g.beginPath();
      for (let c = 0; c < cols; c++) { proj(k, c, idx); c ? g.lineTo(PX, PY) : g.moveTo(PX, PY); }
      if (glow && d < 3) {
        g.strokeStyle = tint(L, A, t, 0.12 * (1 - k));
        g.lineWidth = 4; g.stroke();
        g.beginPath();
        for (let c = 0; c < cols; c++) { proj(k, c, idx); c ? g.lineTo(PX, PY) : g.moveTo(PX, PY); }
      }
      g.strokeStyle = tint(L, A, t, 0.16 + 0.5 * (1 - k));
      g.lineWidth = d === 0 ? 1.5 : 1;
      g.stroke();
    }

    if (!small) {
      g.beginPath();
      for (let c = 0; c < cols; c += 8) {
        let started = false;
        for (let d = rows - 1; d >= 0; d--) {
          const k = (d + phase) / rows;
          if (k >= 1) continue;
          proj(k, c, rowIdx(d));
          started ? g.lineTo(PX, PY) : g.moveTo(PX, PY);
          started = true;
        }
      }
      g.strokeStyle = rgba(L, 0.1);
      g.lineWidth = 1;
      g.stroke();
    }
  }

  /* ── Orbit ───────────────────────────────────────────────────────────── */

  function orbit(g, F, A, L, kp, small) {
    const amp0 = F.R * 0.14 * (0.85 + 0.4 * kp);
    for (let d = rows - 1; d >= 0; d--) {
      const k = (d + phase) / rows;
      if (k >= 1) continue;
      const idx = rowIdx(d), t = hue[idx];
      const base = F.R * (1.12 + k * 0.95), amp = amp0 * (1 - 0.55 * k);
      g.beginPath();
      for (let c = 0; c <= cols; c++) {
        const j = c % cols;
        const th = (TAU * j) / cols + F.base;
        const r = base + tgrid[idx * cols + j] * amp;
        const x = F.cx + Math.sin(th) * r, y = F.cy - Math.cos(th) * r;
        c ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      if (!small) { g.fillStyle = tint(L, A, t, 0.03 + 0.05 * (1 - k)); g.fill(); }
      g.strokeStyle = tint(L, A, t, 0.16 + 0.5 * (1 - k));
      g.lineWidth = d === 0 ? 1.5 : 1;
      g.stroke();
    }
  }

  /* ── Pillars: the spectrum marching into depth ───────────────────────── */

  function pillars(g, F, A, L, kp, small) {
    const baseY = F.cy + F.R * 1.1, depth = F.R * 0.7, nearW = F.R * 2.2;
    const tall = F.R * 0.42 * (0.85 + 0.35 * kp);
    const stride = small ? 2 : 1;

    for (let d = rows - 1; d >= 0; d--) {
      const k = (d + phase) / rows;
      if (k >= 1) continue;
      const idx = rowIdx(d), t = hue[idx];
      const persp = 1 - 0.55 * k;
      const y0 = baseY - k * depth;
      const w = nearW * persp;
      const alpha = 0.1 + 0.45 * (1 - k);

      // Silhouette of the spectrum, filled.
      g.beginPath();
      g.moveTo(F.cx - w / 2, y0);
      for (let c = 0; c < cols; c += stride) {
        const x = F.cx - w / 2 + (c / (cols - 1)) * w;
        g.lineTo(x, y0 - fgrid[idx * cols + c] * tall * persp);
      }
      g.lineTo(F.cx + w / 2, y0);
      g.closePath();
      if (!small) { g.fillStyle = tint(L, A, t, 0.035 + 0.05 * (1 - k)); g.fill(); }
      g.strokeStyle = tint(L, A, t, alpha);
      g.lineWidth = d === 0 ? 1.4 : 1;
      g.stroke();

      // Columns: the structure of the field.
      if (!small) {
        g.beginPath();
        for (let c = 0; c < cols; c += 6) {
          const x = F.cx - w / 2 + (c / (cols - 1)) * w;
          g.moveTo(x, y0);
          g.lineTo(x, y0 - fgrid[idx * cols + c] * tall * persp);
        }
        g.strokeStyle = tint(L, A, t, alpha * 0.5);
        g.lineWidth = 1;
        g.stroke();
      }
    }
  }

  /* ── Strata: stacked slabs ───────────────────────────────────────────── */

  function strata(g, F, A, L, kp, small) {
    const w = F.R * 2.1, top = F.cy - F.R * 0.1;
    const gap = (F.R * 1.5) / rows;
    const amp = gap * 1.7 * (0.85 + 0.4 * kp);

    for (let d = rows - 1; d >= 0; d--) {
      const k = (d + phase) / rows;
      if (k >= 1) continue;
      const idx = rowIdx(d), t = hue[idx];
      const y0 = top + (d + phase) * gap;
      const slab = gap * 0.9;

      g.beginPath();
      g.moveTo(F.cx - w / 2, y0 + slab);
      for (let c = 0; c < cols; c++) {
        const x = F.cx - w / 2 + (c / (cols - 1)) * w;
        g.lineTo(x, y0 - Math.abs(tgrid[idx * cols + c]) * amp);
      }
      g.lineTo(F.cx + w / 2, y0 + slab);
      g.closePath();
      g.fillStyle = tint(L, A, t, 0.05 + 0.12 * (1 - k));
      g.fill();
      g.strokeStyle = tint(L, A, t, 0.18 + 0.45 * (1 - k));
      g.lineWidth = 1;
      g.stroke();
    }
  }

  /* ── Ring ────────────────────────────────────────────────────────────── */

  function ring(g, F, A, L, kp, v, small) {
    for (const d of [3, 7, 12, 17]) {
      if (d >= rows) continue;
      const k = (d + phase) / rows, idx = rowIdx(d);
      const base = F.R * (1.12 + k * 0.9), amp = F.R * 0.09 * (1 - 0.5 * k);
      g.beginPath();
      for (let c = 0; c <= 96; c++) {
        const j = c % 96, src = Math.floor((j * cols) / 96);
        const th = (TAU * j) / 96 + F.base;
        const r = base + tgrid[idx * cols + src] * amp;
        const x = F.cx + Math.sin(th) * r, y = F.cy - Math.cos(th) * r;
        c ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = tint(L, A, hue[idx], 0.08 + 0.22 * (1 - k));
      g.lineWidth = 1;
      g.stroke();
    }

    const N = v.ring.crushed.length, step = tb.length / N;
    const pts = () => {
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const liveV = (tb[Math.floor(j * step)] - 128) / 128;
        const val = 0.6 * v.ring.crushed[j] + 0.4 * liveV;
        const rad = F.R * (1.3 + 0.08 * val * (0.85 + 0.4 * kp));
        const th = (TAU * j) / N + F.base;
        const x = F.cx + Math.sin(th) * rad, y = F.cy - Math.cos(th) * rad;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
    };
    if (glow && !small) { pts(); g.strokeStyle = rgba(A, 0.14); g.lineWidth = 4; g.stroke(); }
    pts();
    g.strokeStyle = rgba(A, 0.6);
    g.lineWidth = 1.3;
    g.stroke();
  }

  /* ── Always-on layers ────────────────────────────────────────────────── */

  function crown(g, F, A, m, kp) {
    const M = m.length, lift = 0.85 + 0.3 * kp;
    g.beginPath();
    for (let i = 0; i < M; i++) {
      const th = (TAU * i) / M + F.base;
      const s = Math.sin(th), c = Math.cos(th);
      const r0 = F.R * 1.2, r1 = F.R * (1.2 + m[i] * 0.12 * lift);
      g.moveTo(F.cx + s * r0, F.cy - c * r0);
      g.lineTo(F.cx + s * r1, F.cy - c * r1);
    }
    g.strokeStyle = rgba(A, 0.34);
    g.lineWidth = 1.1;
    g.stroke();
  }

  function ripples(g, F, A, L, beat) {
    const now = performance.now();
    for (const n of Sound.recentNotes()) {
      let age;
      if (n.beat != null && beat != null) {
        age = (beat - n.beat) / 1.5;
        if (age < -0.02 || age > 1) continue;
        age = Math.max(0, age);
      } else {
        age = (now - n.at) / 1500;
        if (age < 0 || age > 1) continue;
      }
      const wide = n.kind === 'kick';
      g.beginPath();
      g.arc(F.cx, F.cy, F.R * (1.05 + age * (wide ? 1.2 : 0.9)), 0, TAU);
      g.strokeStyle = rgba(n.kind === 'pad' ? L : A, (1 - age) * (wide ? 0.34 : 0.26));
      g.lineWidth = wide ? 1.4 : 1;
      g.stroke();
    }
  }

  function vowel(g, F, L) {
    const lv = Sound.lastVowel();
    if (!lv) return;
    const age = (performance.now() - lv.at) / 1000;
    if (age >= 1.2) return;
    g.fillStyle = rgba(L, (1 - age / 1.2) * 0.45);
    g.font = `italic ${Math.max(11, F.R * 0.09)}px ${SERIF}`;
    g.textAlign = 'center';
    g.fillText(lv.name, F.cx, F.cy + F.R * 1.66);
  }

  function tears(g, F, A) {
    g.fillStyle = rgba(A, 0.25);
    for (let j = 0; j < 2; j++) {
      const x = F.cx - F.R * 1.3 + Math.random() * F.R * 2.6;
      const y = F.cy + (Math.random() - 0.5) * F.R * 1.4;
      g.fillRect(x, y, F.R * (0.05 + Math.random() * 0.2), 2);
    }
  }

  /* ── Frame ───────────────────────────────────────────────────────────── */

  Hooks.on('drawPlaying', ({ r, g, F, kp, beat }) => {
    if (mode === 'none') return;

    const now = performance.now();
    const dt = now - last;
    last = now;
    ema = ema * 0.94 + Math.min(dt, 120) * 0.06;
    if (ema > 24) autoSmall = true; else if (ema < 16) autoSmall = false;

    const v = Sound.view();
    if (!v.P || !v.mags || !v.ring) return;
    const small = Sound.lite || autoSmall || (typeof Perf !== 'undefined' && Perf.quality === 'low');
    resize(small);

    const A = r.pal.accent, L = r.pal.line;
    const eng = Sound.live();
    const an = eng && eng.analyser;

    if (an) {
      read(an);
      if (now - lastCap >= CAP) { lastCap = now; capture(an); }
      phase = clamp((now - lastCap) / CAP, 0, 1);
      if (mode === 'terrain') terrain(g, F, A, L, kp, small);
      else if (mode === 'orbit') orbit(g, F, A, L, kp, small);
      else if (mode === 'pillars') pillars(g, F, A, L, kp, small);
      else if (mode === 'strata') strata(g, F, A, L, kp, small);
      else if (mode === 'ring') ring(g, F, A, L, kp, v, small);
    }

    crown(g, F, A, v.mags, kp);
    ripples(g, F, A, L, beat);
    vowel(g, F, L);
    if (!small && v.P.grit > 0.5 && kp > 0.55 && Math.random() < 0.3) tears(g, F, A);
  });

  /* ── Controls ────────────────────────────────────────────────────────── */

  function setMode(m) { mode = m; Prefs.set('visual.mode', m); UI.announce(LABEL[m]); }
  const cycle = () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);

  UI.section({ id: 'visuals', title: 'Visuals', order: 13, build(el) {
    el.append(
      UI.note('Every style is tinted by the brightness of the sound, measured as its spectral centroid. Press N to cycle.'),
      UI.select({ label: 'Style', value: mode, options: MODES.map((m) => [m, LABEL[m]]), onChange: setMode }),
      UI.check({ label: 'Glow on the front edge', checked: glow, onChange: (v) => { glow = v; Prefs.set('visual.glow', v); } }),
      UI.button('Next style', cycle));
  } });

  UI.key('n', 'Cycle the visual style', cycle, { group: 'Visuals', display: 'N' });

  return { setMode, cycle };
})();

if (typeof window !== 'undefined') window.SoundVisuals = SoundVisuals;