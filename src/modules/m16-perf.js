'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m16 · PERF GOVERNOR
   --------------------------------------------------------------------------
   Watches the 90th-percentile frame time over the last 90 frames.
     level 2  full: device pixel ratio up to 2, full motes, all visuals
     level 1  reduced: canvas at 1×, fewer motes
     level 0  minimal: canvas at 1×, almost no motes, visuals simplified
   Steps down fast when frames run long (above 26 ms), and steps back up
   only after 5 s of comfortable frames (below 16 ms), so it never oscillates.
   The audio engine is never touched.
   ══════════════════════════════════════════════════════════════════════════ */

const Perf = (() => {
  'use strict';
  const WINDOW = 90;
  const frames = new Float32Array(WINDOW);
  let n = 0, last = performance.now(), level = 2, calm = 0;
  let motesFull = null;

  /* Wrap the renderer's resize so the governor can choose the resolution. */
  const origResize = renderer.resize.bind(renderer);
  renderer.resize = (first) => {
    origResize(first);
    const want = level === 2 ? renderer.dpr : 1;
    if (want !== renderer.dpr) {
      renderer.dpr = want;
      renderer.cv.width = Math.round(renderer.w * want);
      renderer.cv.height = Math.round(renderer.h * want);
    }
  };
  motesFull = renderer.motes.slice();

  function apply() {
    renderer.resize(false);
    renderer.motes = level === 2 ? motesFull.slice() : motesFull.slice(0, level === 1 ? 30 : 10);
  }

  function step(now) {
    const dt = now - last;
    last = now;
    if (dt > 0 && dt < 250) frames[n++ % WINDOW] = dt;
    if (n >= 30 && n % 30 === 0) {
      const sorted = Array.from(frames.subarray(0, Math.min(n, WINDOW))).sort((a, b) => a - b);
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      if (p90 > 26 && level > 0) { level--; calm = 0; apply(); }
      else if (p90 < 16) {
        calm += 30;
        if (calm >= 300 && level < 2) { level++; calm = 0; apply(); }
      } else calm = 0;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);

  return { get level() { return level; } };
})();

window.Perf = Perf;