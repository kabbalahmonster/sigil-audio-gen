'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m16 · AUDIO GUARD
   --------------------------------------------------------------------------
   Keeps the music running when the browser, the tab or the OS interrupts it,
   and detects scheduler stalls, the cause of most audible gaps.

   RECOVERY   resumes a suspended or interrupted context unless the USER paused
              it (we track the user's own pause, so we never fight it)
   DETECTION  wraps the scheduler. A gap between pump() calls longer than the
              lookahead means the main thread was starved, and audio is at risk
   RESPONSE   escalates in three steps: widen the lookahead, lighten the voices,
              and tell the visuals to shrink. It recovers after 60 quiet seconds
   ══════════════════════════════════════════════════════════════════════════ */

const AudioGuard = (() => {
  'use strict';

  const st = {
    userPaused: false,
    resumes: 0,
    stalls: 0,
    stallTimes: [],
    lastPump: 0,
    level: 0,
    lastStall: 0,
  };
  const WINDOW = 20000, LIMIT = 3, QUIET = 60000;

  /* Track the user's own pause, so the guard never undoes it. */
  const origToggle = window.togglePause;
  window.togglePause = async function () {
    await origToggle();
    const c = app.engine && app.engine.ctx;
    st.userPaused = !!c && c.state === 'suspended';
  };

  function resume(reason) {
    const c = app.engine && app.engine.ctx;
    if (!c || app.mode !== 'playing' || st.userPaused || c.state === 'running') return;
    st.resumes++;
    c.resume().catch(() => {});
    console.info(`[audio] resumed (${reason})`);
  }

  function watch(eng) {
    if (eng._guarded) return;
    eng._guarded = true;
    eng.ctx.addEventListener('statechange', () => resume(`state → ${eng.ctx.state}`));
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume('tab visible'); });

  /* Measure the gap between scheduler ticks. */
  const basePump = Engine.prototype.pump;
  Engine.prototype.pump = function () {
    const now = performance.now();
    if (this.running && st.lastPump && now - st.lastPump < 2000) {
      const gap = now - st.lastPump;
      if (gap > 90) recordStall(gap);
    }
    st.lastPump = now;
    return basePump.call(this);
  };

  function recordStall(gap) {
    const now = performance.now();
    st.stalls++;
    st.lastStall = now;
    st.stallTimes = st.stallTimes.filter((t) => now - t < WINDOW);
    st.stallTimes.push(now);
    if (st.stallTimes.length >= LIMIT) escalate(gap);
  }

  function setLevel(level) {
    if (level === st.level) return;
    st.level = level;
    Hooks.emit('stability', level);
  }

  function escalate(gap) {
    if (st.level >= 2) { Engine.prototype.horizon = Math.min(1.0, Engine.prototype.horizon + 0.1); return; }
    if (st.level === 0) {
      Engine.prototype.horizon = 0.8;
      setLevel(1);
      console.warn(`[audio] scheduler stall ${Math.round(gap)} ms: widening lookahead`);
    } else {
      if (typeof Sound !== 'undefined') Sound.setLite(true);
      setLevel(2);
      toast('Stability mode: lighter voices and visuals', true, 3000);
      console.warn('[audio] repeated stalls: lite voices and visuals enabled');
    }
  }

  /* Heartbeat: resume if needed, watch the context, and step down after quiet. */
  setInterval(() => {
    const eng = app.engine;
    if (eng) watch(eng);
    if (eng && app.mode === 'playing' && !st.userPaused && eng.ctx.state !== 'running') resume('heartbeat');
    if (st.level > 0 && performance.now() - st.lastStall > QUIET) {
      Engine.prototype.horizon = 0.4;
      setLevel(0);
      console.info('[audio] quiet for a minute: stability settings relaxed');
    }
  }, 500);

  return {
    stats: () => ({ ...st, stallTimes: st.stallTimes.length, horizon: Engine.prototype.horizon }),
  };
})();

if (typeof window !== 'undefined') window.AudioGuard = AudioGuard;