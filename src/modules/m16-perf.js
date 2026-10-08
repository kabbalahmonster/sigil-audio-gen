'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m16 · PERF — audio stability and budget
   --------------------------------------------------------------------------
   WORKER CLOCK   The lookahead scheduler runs from a Worker timer, which the
                  browser does not throttle for layout, paint, GC or tab state.
                  This is the single biggest cause of dropouts removed.

   ADAPTIVE HORIZON  Tick jitter is measured. The scheduler's lookahead grows
                  with it, and grows further while a render is running.

   VOICE CAPS     Per event type. When the cap is reached the new voice is
                  skipped rather than allowed to overrun the audio thread.
                  Offline renders are never capped, so exports stay complete.

   REAPER         Nodes fed by persistent sources (the drum noise rack) are
                  disconnected on a schedule, so the graph cannot grow.

   WATCHDOG       Resumes a context the browser suspended, unless the user
                  pressed pause.

   This module WRAPS Engine.start and Engine.stop. It does not claim them, so
   M4 Form remains their registered owner.
   ══════════════════════════════════════════════════════════════════════════ */

const Perf = (() => {
  'use strict';
  const { h } = UI;

  /* ── Worker clock ────────────────────────────────────────────────────── */

  const TICK_SRC = `let id = null;
self.onmessage = (e) => {
  if (e.data && e.data.cmd === 'start') { clearInterval(id); id = setInterval(() => self.postMessage(0), e.data.ms || 20); }
  else { clearInterval(id); id = null; }
};`;

  let worker = null, fallbackTimer = 0;
  const engines = new Set();

  let lastTick = 0, jitter = 0, tickMs = 16, busy = false;
  const stats = { tick: 0, jitter: 0, voices: 0, dropped: 0, reaped: 0, resumes: 0 };

  function startClock() {
    if (worker || fallbackTimer) return;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([TICK_SRC], { type: 'text/javascript' })));
      worker.onmessage = tick;
      worker.postMessage({ cmd: 'start', ms: 20 });
    } catch {
      // No Worker: fall back to a timer, which is still better than nothing.
      fallbackTimer = setInterval(tick, 20);
    }
  }
  function stopClock() {
    if (worker) { worker.postMessage({ cmd: 'stop' }); worker.terminate(); worker = null; }
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = 0; }
    lastTick = 0;
  }

  /* ── Reaper: disconnect finished nodes fed by persistent sources ─────── */

  const pending = [];
  function reap(node, when) { pending.push({ node, when }); }
  function sweep(now) {
    if (!pending.length) return;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].when <= now) {
        try { pending[i].node.disconnect(); } catch { /* already gone */ }
        pending[i] = pending[pending.length - 1];
        pending.pop();
        stats.reaped++;
      }
    }
  }

  /* ── Voice caps ──────────────────────────────────────────────────────── */

  const CAPS = { lead: 12, harm: 8, pad: 5, bass: 5, kick: 3, snare: 4, hat: 7, shaker: 4, crash: 2, bell: 6, arp: 8, drone: 2 };
  const live = new Map();   // type → array of end times

  /**
   * Claim a voice slot. Returns false when the type is at its cap.
   * @param {string} type  event type
   * @param {number} end   context time the voice will be finished
   * @param {number} now   context time
   * @param {boolean} offline  renders are never capped
   */
  function take(type, end, now, offline) {
    if (offline) return true;
    let arr = live.get(type);
    if (!arr) { arr = []; live.set(type, arr); }
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] <= now) { arr[i] = arr[arr.length - 1]; arr.pop(); }
      else n++;
    }
    const cap = CAPS[type] || 8;
    if (n >= cap) { stats.dropped++; return false; }
    arr.push(end);
    return true;
  }

  function countVoices(now) {
    let n = 0;
    for (const arr of live.values()) for (const t of arr) if (t > now) n++;
    stats.voices = n;
    return n;
  }

  /* ── The tick ────────────────────────────────────────────────────────── */

  function tick() {
    const wall = performance.now();
    if (lastTick) {
      const dt = wall - lastTick;
      tickMs = tickMs * 0.9 + dt * 0.1;
      jitter = jitter * 0.9 + Math.abs(dt - 20) * 0.1;
      stats.tick = tickMs; stats.jitter = jitter;
    }
    lastTick = wall;

    // Lookahead grows with jitter, and further while rendering.
    const horizon = busy ? 1.5 : clamp(0.35 + jitter * 0.02, 0.35, 1.2);

    for (const eng of engines) {
      if (!eng.running) { engines.delete(eng); continue; }
      eng.horizon = horizon;
      try { eng.pump(); } catch (e) { console.error('[perf:pump]', e); }
    }

    const e = app.engine;
    if (e) {
      const now = e.ctx.currentTime;
      sweep(now);
      countVoices(now);
      // Watchdog: the browser suspended us, and the user did not.
      if (app.mode === 'playing' && !app.userPaused && e.ctx.state === 'suspended') {
        stats.resumes++;
        e.ctx.resume().catch(() => {});
      }
    }
    if (!engines.size) stopClock();
  }

  /* ── Engine wrappers ─────────────────────────────────────────────────── */

  const _start = Engine.prototype.start;
  Engine.prototype.start = function (lead) {
    const r = _start.call(this, lead);
    clearInterval(this.timer);     // the worker clock replaces the JS timer
    this.timer = null;
    this.horizon = 0.45;
    engines.add(this);
    startClock();
    return r;
  };

  const _stop = Engine.prototype.stop;
  Engine.prototype.stop = function (fade) {
    engines.delete(this);
    if (!engines.size) stopClock();
    live.clear();
    return _stop.call(this, fade);
  };

  /** Realign the playhead when something has drifted. */
  function resync() {
    if (app.mode !== 'playing' || !app.engine) return;
    const b = app.engine.beatNow();
    app.engine.seek(b);
    UI.announce('Transport resynchronised.');
  }

  /* ── Panel ───────────────────────────────────────────────────────────── */

  let out = null;
  function refresh() {
    if (!out) return;
    out.textContent =
      `clock ${stats.tick.toFixed(1)} ms · jitter ${stats.jitter.toFixed(1)} ms · ` +
      `voices ${stats.voices} · skipped ${stats.dropped} · resumes ${stats.resumes}`;
  }
  setInterval(refresh, 500);

  UI.section({ id: 'perf', title: 'Performance', order: 95, build(el) {
    out = UI.note('');
    el.append(
      UI.note('The scheduler runs on a worker clock, so it keeps time even when the page is busy. Voices above the cap are skipped rather than allowed to overrun the audio thread.'),
      out,
      h('div', { class: 'sgrow' },
        UI.button('Resync transport', resync),
        UI.button('Reset counters', () => { stats.dropped = 0; stats.resumes = 0; stats.reaped = 0; refresh(); })));
    refresh();
  } });

  UI.key('y', 'Resync the transport', resync, { group: 'Performance', display: 'Y' });

  return {
    take, reap, resync, stats,
    setBusy(v) { busy = !!v; },
    get quality() { return jitter > 14 ? 'low' : jitter > 7 ? 'mid' : 'high'; },
  };
})();

if (typeof window !== 'undefined') window.Perf = Perf;