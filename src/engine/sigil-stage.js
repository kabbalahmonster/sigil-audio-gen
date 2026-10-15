'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   STAGE — the frame engine
   --------------------------------------------------------------------------
   One requestAnimationFrame loop for the whole app. Each frame it:
     1. reads the audio clock ONCE (so every layer draws the same beat)
     2. runs the registered layers in z order, each isolated by try/catch
     3. measures what the frame cost and governs quality

   THE GOVERNOR keeps animation smooth on slow machines by spending less per
   frame rather than dropping frames: level 1 renders at 80% resolution and
   drops the widest glow pass; level 2 renders at 60% and keeps one pass.
   It emits Hooks 'budget' (level), which the renderer and m13 already obey.
   Stepping back up needs a long calm spell, and each failed attempt doubles
   the wait, so quality does not flap.

     Stage.layer({ id, z, draw(clock) })     register a layer
     Stage.clock                             { t, dt, n, beat, playing }
     Stage.rgba(col, a)                      cached colour strings
     Stage.glow(col, radius)                 cached radial-glow sprite
     Stage.setQuality('auto' | 0 | 1 | 2)
   ══════════════════════════════════════════════════════════════════════════ */
const Stage = (() => {
  'use strict';
  const layers = [];
  const clock = { t: 0, dt: 1 / 60, n: 0, beat: 0, playing: false };
  const stats = { frameMs: 16.7, drawMs: 0, worstMs: 0, period: 16.7, level: 0, scale: 1 };
  const SCALE = [1, 0.8, 0.6];
  const failed = new Set();
  let raf = 0, last = 0, evalAt = 0, hot = 0, calm = 0, calmNeed = 8;
  let pref = Prefs.get('stage.quality', 'auto');

  function layer(def) {
    layers.push({ id: def.id, z: def.z || 0, draw: def.draw, on: def.on !== false });
    layers.sort((a, b) => a.z - b.z);
  }
  function enable(id, on) { for (const L of layers) if (L.id === id) L.on = !!on; }

  function setLevel(l) {
    l = clamp(l | 0, 0, 2);
    if (l === stats.level) return;
    stats.level = l;
    stats.scale = SCALE[l];
    // Backdrop blur over a moving canvas is re-filtered every frame; drop it as soon as frames are tight.
    document.body.classList.toggle('lowfx', l > 0);
    Hooks.emit('budget', l);
  }
  function setQuality(v) {
    pref = v === 'auto' ? 'auto' : clamp(+v | 0, 0, 2);
    Prefs.set('stage.quality', pref);
    hot = 0; calm = 0; calmNeed = 8;
    if (pref !== 'auto') setLevel(pref);
  }

  function govern(ts) {
    if (ts - evalAt < 1000) return;
    evalAt = ts;
    if (pref !== 'auto') return;
    const p = stats.period;
    const slow = stats.frameMs > p * 1.5 || stats.drawMs > p * 0.7;
    const fine = stats.frameMs < p * 1.15 && stats.drawMs < p * 0.35;
    if (slow) {
      calm = 0;
      if (++hot >= 2 && stats.level < 2) { hot = 0; calmNeed = Math.min(120, calmNeed * 2); setLevel(stats.level + 1); }
    } else {
      hot = 0;
      if (fine && stats.level > 0) { if (++calm >= calmNeed) { calm = 0; setLevel(stats.level - 1); } }
      else calm = 0;
    }
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    const gap = last ? ts - last : 16.7;
    last = ts;
    clock.t = ts / 1000;
    clock.dt = Math.min(0.05, gap / 1000);      // clamp so a stalled tab cannot leap
    clock.n++;
    const A = typeof app !== 'undefined' ? app : null, eng = A && A.engine;
    clock.playing = !!eng && A.mode === 'playing';
    clock.beat = eng && eng.song ? eng.beatNow(ts) : 0;

    const t0 = performance.now();
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!L.on) continue;
      try { L.draw(clock); }
      catch (e) { if (!failed.has(L.id)) { failed.add(L.id); console.error(`[stage:${L.id}]`, e); } }
    }
    const cost = performance.now() - t0;

    if (gap < 250) {                             // ignore the gap after a hidden tab
      stats.drawMs += (cost - stats.drawMs) * 0.1;
      stats.frameMs += (gap - stats.frameMs) * 0.1;
      if (gap > stats.worstMs) stats.worstMs = gap;
      if (gap > 3 && gap < stats.period) stats.period += (gap - stats.period) * 0.2;   // learn the display's refresh period
      govern(ts);
    }
  }

  function start() { if (!raf) raf = requestAnimationFrame(frame); }
  function stop() { cancelAnimationFrame(raf); raf = 0; last = 0; }

  /* ── shared drawing resources ─────────────────────────────────────────── */

  const colours = new Map();
  /** rgba() strings, cached per colour at 1/255 alpha steps: no string building or colour parsing in the frame. */
  function rgbaQ(c, a) {
    const q = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    let row = colours.get(key);
    if (!row) { if (colours.size > 96) colours.clear(); colours.set(key, (row = new Array(256))); }
    return row[q] || (row[q] = `rgba(${c[0]},${c[1]},${c[2]},${(q / 255).toFixed(3)})`);
  }

  const sprites = new Map();
  /** A radial glow as a sprite, drawn once. Blit it with drawImage instead of building a gradient every frame. */
  function glow(col, radius, alpha = 0.55) {
    const key = `${col[0]},${col[1]},${col[2]}|${radius}|${alpha}`;
    let cv = sprites.get(key);
    if (!cv) {
      const s = radius * 4;                      // 2× oversampled
      cv = document.createElement('canvas');
      cv.width = cv.height = s;
      const g = cv.getContext('2d'), gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, rgba(col, alpha));
      gr.addColorStop(1, rgba(col, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
      if (sprites.size > 24) sprites.clear();
      sprites.set(key, cv);
    }
    return cv;
  }

  if (pref !== 'auto') { stats.level = clamp(+pref | 0, 0, 2); stats.scale = SCALE[stats.level]; }

  return { layer, enable, start, stop, clock, stats, setQuality, get quality() { return pref; }, rgba: rgbaQ, glow };
})();
if (typeof window !== 'undefined') window.Stage = Stage;