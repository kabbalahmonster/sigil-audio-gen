'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS v5
   --------------------------------------------------------------------------
   STYLES (N cycles; Tools → Visuals picks)
     terrain  the sound as a receding surface, filled and coloured by frequency
     orbit    the same terrain wrapped around the seal
     ring     the wheel's crushed waveform, with echoes of the terrain
     helix    a tumbling torus carrying the live waveform in three dimensions
     bloom    a spectral mandala: each scan a ring of frequency bins
     none     no sound visuals, for the lightest possible frame
   COLOUR     every scan is coloured by its spectral centroid, so colour follows pitch
   SMOOTHNESS scans at 20 Hz are drawn with a fractional scroll, so motion is
              continuous at 60 fps. The guard's stability level shrinks the grid.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';

  const MODES = ['terrain', 'orbit', 'ring', 'helix', 'bloom', 'none'];
  const LABEL = {
    terrain: 'Terrain · the sound as a receding surface',
    orbit: 'Orbit · the terrain wrapped around the seal',
    ring: 'Ring · the wheel’s waveform with terrain echoes',
    helix: 'Helix · a tumbling torus carrying the waveform',
    bloom: 'Bloom · a spectral mandala',
    none: 'None · no sound visuals',
  };
  let mode = Prefs.get('visual.mode', 'terrain');
  let glow = Prefs.get('visual.glow', true);

  const CAP = 50;                                      // ms per scan (20 Hz)
  const SIZES = { full: [22, 64, 48], small: [10, 32, 24] };  // rows, time columns, spectral bins
  let rows = 22, cols = 64, bins = 48;
  let timeGrid = new Float32Array(22 * 64), specGrid = new Float32Array(22 * 48), hue = new Float32Array(22);
  let head = 0, lastCap = 0, phase = 0, tb = null, fb = null;
  let ema = 16, last = 0, autoSmall = false, stability = 0, budget = 0, tock = 0;
  const trig = { n: 0, cu: null, su: null };

  function resize(small) {
    const [r, c, b] = small ? SIZES.small : SIZES.full;
    if (r === rows && c === cols && b === bins) return;
    rows = r; cols = c; bins = b;
    timeGrid = new Float32Array(rows * cols);
    specGrid = new Float32Array(rows * bins);
    hue = new Float32Array(rows);
    head = 0;
  }

  const rowIdx = (d) => ((head - d) % rows + rows) % rows;

  /** A colour between line and accent, as a CSS string. */
  function tint(L, A, t, a) {
    const r = (L[0] + (A[0] - L[0]) * t) | 0, g2 = (L[1] + (A[1] - L[1]) * t) | 0, b = (L[2] + (A[2] - L[2]) * t) | 0;
    return `rgba(${r},${g2},${b},${a.toFixed(3)})`;
  }

  function readTime(an) {
    const n = an.fftSize;
    if (!tb || tb.length !== n) tb = new Uint8Array(n);
    an.getByteTimeDomainData(tb);
  }

  /** One scan: waveform peaks, and a log-spaced spectrum with its centroid as the colour key. */
  function capture(an) {
    head = (head + 1) % rows;
    const n = tb.length, step = n / cols, base = head * cols;
    for (let c = 0; c < cols; c++) {
      let peak = 0;
      const a = Math.floor(c * step), b = Math.floor((c + 1) * step);
      for (let i = a; i < b; i++) {
        const v = (tb[i] - 128) / 128;
        if (Math.abs(v) > Math.abs(peak)) peak = v;
      }
      timeGrid[base + c] = peak;
    }

    if (!fb || fb.length !== an.frequencyBinCount) fb = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(fb);
    const fn = fb.length, sb = head * bins;
    let cent = 0, tot = 0;
    for (let b = 0; b < bins; b++) {
      const lo = Math.floor(Math.pow(b / bins, 2) * fn * 0.6);
      const hi = Math.max(lo + 1, Math.floor(Math.pow((b + 1) / bins, 2) * fn * 0.6));
      let m = 0;
      for (let i = lo; i < hi && i < fn; i++) if (fb[i] > m) m = fb[i];
      specGrid[sb + b] = m / 255;
      cent += b * m;
      tot += m;
    }
    hue[head] = tot > 0 ? clamp(cent / tot / bins, 0, 1) : 0;   // frequency → colour
  }

  /* ── Terrain ─────────────────────────────────────────────────────────── */

  function terrain(g, F, A, L, kp, small) {
    const baseY = F.cy + F.R * 1.12, depth = F.R * 0.72, nearW = F.R * 2.3;
    const amp = F.R * 0.2 * (0.85 + 0.4 * kp);
    let PX = 0, PY = 0;
    const proj = (k, c, idx) => {
      const persp = 1 - 0.55 * k;
      PX = F.cx - (nearW * persp) / 2 + (c / (cols - 1)) * nearW * persp;
      PY = baseY - k * depth - timeGrid[idx * cols + c] * amp * persp;
    };

    for (let d = rows - 1; d >= 0; d--) {
      const k = (d + phase) / rows;
      if (k >= 1) continue;
      const idx = rowIdx(d), t = hue[idx];

      if (!small && budget === 0 && d + 1 < rows) {
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
        const r = base + timeGrid[idx * cols + j] * amp;
        const x = F.cx + Math.sin(th) * r, y = F.cy - Math.cos(th) * r;
        c ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      if (!small && budget === 0) { g.fillStyle = tint(L, A, t, 0.03 + 0.05 * (1 - k)); g.fill(); }
      g.strokeStyle = tint(L, A, t, 0.16 + 0.5 * (1 - k));
      g.lineWidth = d === 0 ? 1.5 : 1;
      g.stroke();
    }
  }

  /* ── Ring ────────────────────────────────────────────────────────────── */

  function ring(g, F, A, L, kp, v) {
    for (const d of [3, 7, 12, 17]) {
      if (d >= rows) continue;
      const k = (d + phase) / rows, idx = rowIdx(d);
      const base = F.R * (1.12 + k * 0.9), amp = F.R * 0.09 * (1 - 0.5 * k);
      g.beginPath();
      for (let c = 0; c <= 96; c++) {
        const j = c % 96, src = Math.floor((j * cols) / 96);
        const th = (TAU * j) / 96 + F.base;
        const r = base + timeGrid[idx * cols + src] * amp;
        const x = F.cx + Math.sin(th) * r, y = F.cy - Math.cos(th) * r;
        c ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = tint(L, A, hue[idx], 0.08 + 0.22 * (1 - k));
      g.lineWidth = 1;
      g.stroke();
    }

    const N = v.ring.crushed.length, step = tb.length / N;
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const live = (tb[Math.floor(j * step)] - 128) / 128;
        const val = 0.6 * v.ring.crushed[j] + 0.4 * live;
        const rr = F.R * (1.3 + 0.08 * val * (0.85 + 0.4 * kp));
        const th = (TAU * j) / N + F.base;
        const x = F.cx + Math.sin(th) * rr, y = F.cy - Math.cos(th) * rr;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
    };
    if (glow) { path(); g.strokeStyle = rgba(A, 0.14); g.lineWidth = 4; g.stroke(); }
    path();
    g.strokeStyle = rgba(A, 0.6);
    g.lineWidth = 1.3;
    g.stroke();
  }

  /* ── Helix ───────────────────────────────────────────────────────────── */

  function helixTrig(n) {
    if (trig.n === n) return;
    trig.n = n;
    trig.cu = new Float32Array(n);
    trig.su = new Float32Array(n);
    for (let i = 0; i < n; i++) { trig.cu[i] = Math.cos((TAU * i) / n); trig.su[i] = Math.sin((TAU * i) / n); }
  }

  /**
   * A torus whose tube radius is the crushed waveform. Rotation is computed from
   * wall-clock time, so it is smooth regardless of frame rate.
   */
  function helix(g, F, A, L, kp, v, small) {
    const w = v.ring.crushed, N = w.length;
    helixTrig(N);
    const t = performance.now() / 1000;
    const ax = 0.55 + 0.18 * Math.sin(t * 0.13), ay = t * 0.22;
    const cax = Math.cos(ax), sax = Math.sin(ax), cay = Math.cos(ay), say = Math.sin(ay);
    const Rm = F.R * 0.6, tube = F.R * 0.3 * (0.9 + 0.3 * kp), M = small ? 12 : 24;
    const persp = F.R * 3.2;

    for (let m = 0; m < M; m++) {
      const v0 = (TAU * m) / M, cv = Math.cos(v0), sv = Math.sin(v0);
      g.beginPath();
      let zsum = 0;
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const r = tube * (0.55 + 0.6 * (0.5 + 0.5 * w[j]));
        const ring = Rm + r * trig.cu[j];
        const x = ring * cv, y = ring * sv, z = r * trig.su[j];
        const y1 = y * cax - z * sax, z1 = y * sax + z * cax;     // tilt about x
        const x2 = x * cay + z1 * say, z2 = -x * say + z1 * cay;  // spin about y
        const p = persp / (persp + z2);
        const X = F.cx + x2 * p, Y = F.cy + y1 * p;
        i ? g.lineTo(X, Y) : g.moveTo(X, Y);
        zsum += z2;
      }
      const depth = clamp(0.5 + zsum / (N + 1) / (F.R * 1.2), 0, 1);
      g.strokeStyle = tint(L, A, depth, 0.12 + 0.5 * depth);
      g.lineWidth = 1;
      g.stroke();
    }
  }

  /* ── Bloom ───────────────────────────────────────────────────────────── */

  function bloom(g, F, A, L, kp) {
    for (let d = rows - 1; d >= 0; d--) {
      const k = (d + phase) / rows;
      if (k >= 1) continue;
      const idx = rowIdx(d), t = hue[idx];
      const R0 = F.R * (0.42 + k * 1.0), amp = F.R * 0.5 * (1 - 0.6 * k) * (0.9 + 0.2 * kp);
      g.beginPath();
      for (let b = 0; b <= bins; b++) {
        const j = b % bins;
        const th = (TAU * j) / bins + F.base;
        const mandala = 1 + 0.14 * Math.cos(6 * th - k * 4);
        const rr = R0 + specGrid[idx * bins + j] * amp * mandala;
        const x = F.cx + Math.sin(th) * rr, y = F.cy - Math.cos(th) * rr;
        b ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.fillStyle = tint(L, A, t, 0.025 + 0.05 * (1 - k));
      g.fill();
      g.strokeStyle = tint(L, A, t, 0.14 + 0.5 * (1 - k));
      g.lineWidth = d === 0 ? 1.4 : 1;
      g.stroke();
    }
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
      g.strokeStyle = tint(L, A, n.kind === 'pad' ? 0 : 1, (1 - age) * 0.28);
      g.lineWidth = 1;
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
    const now = performance.now();
    const dt = now - last;
    last = now;
    ema = ema * 0.94 + Math.min(dt, 120) * 0.06;
    if (ema > 24) autoSmall = true;
    else if (ema < 16) autoSmall = false;

    const v = Sound.view();
    if (!v.P || !v.mags || !v.ring) return;
    const small = Sound.lite || autoSmall || stability >= 1 || budget >= 1;
    // At the tightest budget the sound visuals draw on alternate frames. The sigil
    // itself keeps drawing every frame, so nothing looks frozen.
    const heavy = budget < 2 || (tock++ & 1) === 0;
    const A = r.pal.accent, L = r.pal.line;
    const eng = Sound.live();
    const an = eng && eng.analyser;

    if (mode !== 'none' && an && heavy) {
      resize(small);
      readTime(an);
      if (now - lastCap >= CAP) { lastCap = now; capture(an); }
      phase = clamp((now - lastCap) / CAP, 0, 1);

      if (mode === 'terrain') terrain(g, F, A, L, kp, small);
      else if (mode === 'orbit') orbit(g, F, A, L, kp, small);
      else if (mode === 'ring') ring(g, F, A, L, kp, v);
      else if (mode === 'helix') helix(g, F, A, L, kp, v, small);
      else if (mode === 'bloom') bloom(g, F, A, L, kp);
    }

    if (mode !== 'none') {
      crown(g, F, A, v.mags, kp);
      ripples(g, F, A, L, beat);
      vowel(g, F, L);
      if (!small && v.P.grit > 0.5 && kp > 0.55 && Math.random() < 0.3) tears(g, F, A);
    }
  });

  /* The audio guard asks for lighter visuals when the scheduler struggles. */
  Hooks.on('stability', (level) => { stability = level; });
/* The profiler tells us how much of the frame drawing is taking. Level 1 drops
  the fills and shrinks the grid; level 2 halves the visual frame rate too. */
  Hooks.on('budget', (level) => { budget = level; });

  /* ── Controls ────────────────────────────────────────────────────────── */

  function setMode(m) {
    mode = m;
    Prefs.set('visual.mode', m);
    UI.announce(LABEL[m]);
  }
  const cycle = () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);

  UI.section({ id: 'visuals', title: 'Visuals', order: 13, build(el) {
    el.append(
      UI.note('Colour follows pitch: every row is tinted by its spectral centroid. Terrain and Orbit are the sound as structure. Ring and Helix carry the waveform. Bloom is the spectrum as a mandala. None removes the sound visuals entirely.'),
      UI.select({ label: 'Style', value: mode, options: MODES.map((m) => [m, LABEL[m]]), onChange: (v) => setMode(v) }),
      UI.check({ label: 'Glow on the front row and the ring', checked: glow, onChange: (v) => { glow = v; Prefs.set('visual.glow', v); } }),
      UI.button('Next style', cycle));
  } });

  UI.key('n', 'Cycle the visual style', cycle, { group: 'Visuals', display: 'N' });

  return { setMode, cycle };
})();

if (typeof window !== 'undefined') window.SoundVisuals = SoundVisuals;