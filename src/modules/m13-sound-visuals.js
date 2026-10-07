'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS v4
   --------------------------------------------------------------------------
   STYLES (press N, or pick in Tools → Visuals)
     terrain   the sound as a receding surface; each row coloured by its
               brightness (zero-crossing rate); surfaces filled for solidity
     orbit     the same terrain wrapped around the seal, rings expanding
               outward like sound leaving the sigil
     ring      the wheel's crushed waveform, with echoes of the terrain
   ALWAYS ON   the harmonic crown, note ripples, vowel glyph, grit tears
   SMOOTHNESS  scans are captured at 20 Hz but drawn with a fractional scroll,
               so motion is continuous at 60 fps. If frames run slow the grid
               shrinks automatically, and the style never stutters the page.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';

  const MODES = ['terrain', 'orbit', 'ring'];
  const LABEL = {
    terrain: 'Terrain · the sound as a receding surface',
    orbit: 'Orbit · the terrain wrapped around the seal',
    ring: 'Ring · the wheel’s waveform with terrain echoes',
  };
  let mode = Prefs.get('visual.mode', 'terrain');
  let glow = Prefs.get('visual.glow', true);

  const CAP = 50;                                  // ms per captured scan (20 Hz)
  const SIZES = { full: [22, 64], small: [10, 32] };
  let rows = 22, cols = 64;
  let grid = new Float32Array(22 * 64), hue = new Float32Array(22);
  let head = 0, lastCap = 0, phase = 0, tb = null;
  let ema = 16, last = 0, autoSmall = false;

  function resize(small) {
    const [r, c] = small ? SIZES.small : SIZES.full;
    if (r === rows && c === cols) return;
    rows = r; cols = c;
    grid = new Float32Array(rows * cols);
    hue = new Float32Array(rows);
    head = 0;
  }

  const rowIdx = (d) => ((head - d) % rows + rows) % rows;

  /** A colour between the line and accent colours, as a CSS string. */
  function tint(L, A, t, a) {
    const r = (L[0] + (A[0] - L[0]) * t) | 0, g2 = (L[1] + (A[1] - L[1]) * t) | 0, b = (L[2] + (A[2] - L[2]) * t) | 0;
    return `rgba(${r},${g2},${b},${a.toFixed(3)})`;
  }

  function read(an) {
    const n = an.fftSize;
    if (!tb || tb.length !== n) tb = new Uint8Array(n);
    an.getByteTimeDomainData(tb);
  }

  /** Capture one scan: peaks per column, and the zero-crossing rate as its colour. */
  function capture() {
    head = (head + 1) % rows;
    const n = tb.length, step = n / cols, base = head * cols;
    let zc = 0;
    for (let i = 1; i < n; i++) if ((tb[i] >= 128) !== (tb[i - 1] >= 128)) zc++;
    hue[head] = clamp(zc / 48, 0, 1);
    for (let c = 0; c < cols; c++) {
      let peak = 0;
      const a = Math.floor(c * step), b = Math.floor((c + 1) * step);
      for (let i = a; i < b; i++) {
        const v = (tb[i] - 128) / 128;
        if (Math.abs(v) > Math.abs(peak)) peak = v;
      }
      grid[base + c] = peak;
    }
  }

  /* ── Terrain ─────────────────────────────────────────────────────────── */

  function terrain(g, F, A, L, kp, small) {
    const baseY = F.cy + F.R * 1.12, depth = F.R * 0.72, nearW = F.R * 2.3;
    const amp = F.R * 0.2 * (0.85 + 0.4 * kp);

    // Projects (row depth k, column c) to screen space, into PX/PY.
    let PX = 0, PY = 0;
    const proj = (k, c, idx) => {
      const persp = 1 - 0.55 * k;
      PX = F.cx - (nearW * persp) / 2 + (c / (cols - 1)) * nearW * persp;
      PY = baseY - k * depth - grid[idx * cols + c] * amp * persp;
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
        g.lineWidth = 4;
        g.stroke();
        g.beginPath();
        for (let c = 0; c < cols; c++) { proj(k, c, idx); c ? g.lineTo(PX, PY) : g.moveTo(PX, PY); }
      }
      g.strokeStyle = tint(L, A, t, 0.16 + 0.5 * (1 - k));
      g.lineWidth = d === 0 ? 1.5 : 1;
      g.stroke();
    }

    // Struts tie each column through depth into a lattice.
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
        const r = base + grid[idx * cols + j] * amp;
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

  /* ── Ring ────────────────────────────────────────────────────────────── */

  function ring(g, F, A, L, kp, v, small) {
    // Echoes: older scans from the terrain history, travelling outward.
    for (const d of [3, 7, 12, 17]) {
      if (d >= rows) continue;
      const k = (d + phase) / rows, idx = rowIdx(d);
      const base = F.R * (1.12 + k * 0.9), amp = F.R * 0.09 * (1 - 0.5 * k);
      g.beginPath();
      for (let c = 0; c <= 96; c++) {
        const j = c % 96, src = Math.floor((j * cols) / 96);
        const th = (TAU * j) / 96 + F.base;
        const r = base + grid[idx * cols + src] * amp;
        const x = F.cx + Math.sin(th) * r, y = F.cy - Math.cos(th) * r;
        c ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = tint(L, A, hue[idx], 0.08 + 0.22 * (1 - k));
      g.lineWidth = 1;
      g.stroke();
    }

    // The wheel's waveform: the crushed structure, modulated by the live output.
    const N = v.ring.crushed.length, step = tb.length / N;
    const pts = () => {
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const live = (tb[Math.floor(j * step)] - 128) / 128;
        const val = 0.6 * v.ring.crushed[j] + 0.4 * live;
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
      g.beginPath();
      g.arc(F.cx, F.cy, F.R * (1.05 + age * 0.9), 0, TAU);
      g.strokeStyle = rgba(n.kind === 'pad' ? L : A, (1 - age) * 0.28);
      g.lineWidth = 1;
      g.stroke();
    }
  }

  function halo(g, F, L, an) {
    const n = an.frequencyBinCount;
    if (!halo.buf || halo.buf.length !== n) halo.buf = new Uint8Array(n);
    an.getByteFrequencyData(halo.buf);
    for (let i = 0; i < 64; i++) {
      const bin = Math.min(n - 1, Math.floor(Math.pow(i / 64, 1.8) * n * 0.5));
      const val = halo.buf[bin] / 255;
      const th = (TAU * i) / 64 + F.base;
      const rad = F.R * 1.44 + val * F.R * 0.07;
      g.fillStyle = rgba(L, 0.1 + val * 0.45);
      g.fillRect(F.cx + Math.sin(th) * rad - 1, F.cy - Math.cos(th) * rad - 1, 2, 2);
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
    const now = performance.now();
    const dt = now - last;
    last = now;
    ema = ema * 0.94 + Math.min(dt, 120) * 0.06;
    if (ema > 24) autoSmall = true;
    else if (ema < 16) autoSmall = false;

    const v = Sound.view();
    if (!v.P || !v.mags || !v.ring) return;
    const small = Sound.lite || autoSmall;
    resize(small);

    const A = r.pal.accent, L = r.pal.line;
    const eng = Sound.live();
    const an = eng && eng.analyser;

    if (an) {
      read(an);
      if (now - lastCap >= CAP) { lastCap = now; capture(); }
      phase = clamp((now - lastCap) / CAP, 0, 1);   // the fractional scroll that makes motion smooth
      if (mode === 'terrain') terrain(g, F, A, L, kp, small);
      else if (mode === 'orbit') orbit(g, F, A, L, kp, small);
      else ring(g, F, A, L, kp, v, small);
    }

    crown(g, F, A, v.mags, kp);
    ripples(g, F, A, L, beat);
    if (an && !small) halo(g, F, L, an);
    vowel(g, F, L);
    if (!small && v.P.grit > 0.5 && kp > 0.55 && Math.random() < 0.3) tears(g, F, A);
  });

  /* ── Controls ────────────────────────────────────────────────────────── */

  function setMode(m) {
    mode = m;
    Prefs.set('visual.mode', m);
    UI.announce(LABEL[m]);
  }
  const cycle = () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);

  UI.section({ id: 'visuals', title: 'Visuals', order: 13, build(el) {
    el.append(
      UI.note('Terrain: the sound as a receding surface, each row coloured by its brightness. Orbit: the same terrain wrapped around the seal. Ring: the wheel’s waveform, with echoes from the terrain.'),
      UI.select({ label: 'Style', value: mode, options: MODES.map((m) => [m, LABEL[m]]), onChange: (v) => setMode(v) }),
      UI.check({ label: 'Glow on the front row and the ring', checked: glow, onChange: (v) => { glow = v; Prefs.set('visual.glow', v); } }),
      UI.button('Next style', cycle));
  } });

  UI.key('n', 'Cycle the visual style', cycle, { group: 'Visuals', display: 'N' });

  return { setMode, cycle };
})();

if (typeof window !== 'undefined') window.SoundVisuals = SoundVisuals;