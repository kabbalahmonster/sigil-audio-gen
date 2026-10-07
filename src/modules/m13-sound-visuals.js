'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m13 · SOUND VISUALS v3: the wave as a 3D lattice
   --------------------------------------------------------------------------
   The mesh is precomputed by SoundDesign.lattice() whenever the patch changes
   (not per frame). Each frame only rotates and projects about 2,500 points and
   strokes ~10 paths. The camera drifts on a smooth sine, with no input, so it
   never fights the Live Lens drag.

   Layers, back to front:
     1 · lattice rings, bucketed by depth (three alpha levels)
     2 · ribs, linking the same phase across the grid
     3 · active cells (start and end of the travel vector), in the accent colour
     4 · the travelling pen, interpolated between those two cells
     5 · the harmonic crown (the current cell's partials)
     6 · the vowel glyph, and the grit tears
   ══════════════════════════════════════════════════════════════════════════ */

const SoundVisuals = (() => {
  'use strict';
  const SD = SoundDesign;
  const PERSP = 3.4;
  const RIBS = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44];
  let buf = null;        // projected xy, reused every frame
  let zbuf = null;       // projected depth, reused every frame

  /** Project a lattice-space point with the current camera. Writes into `out`. */
  function project(out, x, y, z, cy_, sy_, cx_, sx_, cx, cy, sc) {
    const x1 = x * cy_ + z * sy_;
    const z1 = -x * sy_ + z * cy_;
    const y1 = y * cx_ - z1 * sx_;
    const z2 = y * sx_ + z1 * cx_;
    const s = PERSP / (PERSP + z2);
    out[0] = cx + x1 * s * sc;
    out[1] = cy + y1 * s * sc;
    out[2] = z2;
    return out;
  }
  const tmp = new Float32Array(3);

  Hooks.on('drawPlaying', ({ r, g, F, kp, beat }) => {
    const v = Sound.view();
    if (!v.P || !v.mesh) return;
    const lite = Sound.lite || (typeof Perf !== 'undefined' && Perf.level === 0);
    const A = r.pal.accent, L = r.pal.line;
    const { pts: mesh, N } = v.mesh;
    const C = SD.FX * SD.FY, total = C * N;
    const t = performance.now() / 1000;

    /* Camera: slow drift on sines, lightly pumped by the kick. */
    const yaw = t * 0.07 + 0.35 * Math.sin(t * 0.11);
    const pitch = 0.34 + 0.1 * Math.sin(t * 0.05);
    const cy_ = Math.cos(yaw), sy_ = Math.sin(yaw), cx_ = Math.cos(pitch), sx_ = Math.sin(pitch);
    const sc = F.R * (0.9 + 0.04 * kp) * (lite ? 0.9 : 1);
    const cx = F.cx, cy = F.cy;

    if (!buf || buf.length !== total * 2) { buf = new Float32Array(total * 2); zbuf = new Float32Array(total); }
    for (let p = 0; p < total; p++) {
      const i = p * 3;
      project(tmp, mesh[i], mesh[i + 1], mesh[i + 2], cy_, sy_, cx_, sx_, cx, cy, sc);
      buf[2 * p] = tmp[0];
      buf[2 * p + 1] = tmp[1];
      zbuf[p] = tmp[2];
    }

    /* 1 · Lattice rings, bucketed by average depth. */
    const buckets = [new Path2D(), new Path2D(), new Path2D()];
    for (let c = 0; c < C; c++) {
      const base = c * N;
      let zm = 0;
      for (let j = 0; j < N; j++) zm += zbuf[base + j];
      zm /= N;
      const bk = zm < -0.25 ? 0 : zm < 0.25 ? 1 : 2;
      const path = buckets[bk];
      path.moveTo(buf[2 * base], buf[2 * base + 1]);
      for (let j = 1; j <= N; j++) {
        const q = base + (j % N);
        path.lineTo(buf[2 * q], buf[2 * q + 1]);
      }
    }
    const alphas = [0.1, 0.2, 0.34];
    g.lineWidth = 1;
    for (let b = 0; b < 3; b++) {
      g.strokeStyle = rgba(L, alphas[b]);
      g.stroke(buckets[b]);
    }

    /* 2 · Ribs: the same phase across every ring, joined through depth and height. */
    if (!lite) {
      const ribs = new Path2D();
      for (const j of RIBS) {
        for (let y = 0; y < SD.FY; y++) {
          for (let x = 0; x < SD.FX; x++) {
            const q = (y * SD.FX + x) * N + j;
            if (x === 0) ribs.moveTo(buf[2 * q], buf[2 * q + 1]);
            else ribs.lineTo(buf[2 * q], buf[2 * q + 1]);
          }
        }
      }
      g.strokeStyle = rgba(L, 0.09);
      g.lineWidth = 0.8;
      g.stroke(ribs);
    }

    /* 3 · Active cells: where the note starts, and where it is travelling. */
    const P = v.P;
    const x0 = clamp(Math.round(P.wave), 0, SD.FX - 1), y0 = clamp(Math.round(P.layer), 0, SD.FY - 1);
    const x1 = clamp(Math.round(P.wave + P.sweep * 4), 0, SD.FX - 1);
    const y1 = clamp(Math.round(P.layer + P.drift * 2.5), 0, SD.FY - 1);
    const act = new Path2D();
    for (const [x, y] of [[x0, y0], [x1, y1]]) {
      const base = (y * SD.FX + x) * N;
      act.moveTo(buf[2 * base], buf[2 * base + 1]);
      for (let j = 1; j <= N; j++) {
        const q = base + (j % N);
        act.lineTo(buf[2 * q], buf[2 * q + 1]);
      }
    }
    g.strokeStyle = rgba(A, 0.85);
    g.lineWidth = 1.4;
    g.stroke(act);

    /* 4 · The travelling pen, between the centres of the start and end cells. */
    const s = (t * 0.35) % 1;
    const ax = 0, ay = (y0 - 2) * SD.LATTICE_DY, az = (x0 - 4) * SD.LATTICE_DZ;
    const bx = 0, by = (y1 - 2) * SD.LATTICE_DY, bz = (x1 - 4) * SD.LATTICE_DZ;
    const px = ax + (bx - ax) * s, py = ay + (by - ay) * s, pz = az + (bz - az) * s;
    project(tmp, px, py, pz, cy_, sy_, cx_, sx_, cx, cy, sc);
    g.fillStyle = rgba(A, 0.95);
    g.beginPath();
    g.arc(tmp[0], tmp[1], 2.4, 0, TAU);
    g.fill();

    /* 5 · Harmonic crown: the current cell's 24 partials, as rays. */
    const m = v.mags, M = m.length, lift = 0.8 + 0.4 * kp;
    const crown = new Path2D();
    for (let i = 0; i < M; i++) {
      const th = (TAU * i) / M + F.base;
      const sn = Math.sin(th), cs = Math.cos(th);
      const r0 = F.R * 1.28, r1 = F.R * (1.28 + m[i] * 0.12 * lift);
      crown.moveTo(F.cx + sn * r0, F.cy - cs * r0);
      crown.lineTo(F.cx + sn * r1, F.cy - cs * r1);
    }
    g.strokeStyle = rgba(A, 0.34);
    g.lineWidth = 1.2;
    g.stroke(crown);

    /* 6 · Vowel glyph. */
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

    /* Grit tears on hard hits. */
    if (!lite && P.grit > 0.5 && kp > 0.55 && Math.random() < 0.3) {
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