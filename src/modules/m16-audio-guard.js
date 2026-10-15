'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m16 · AUDIO GUARD
   --------------------------------------------------------------------------
   The scheduler no longer lives on the main thread, so there are no scheduler
   stalls left to detect. Two jobs remain:

   RECOVERY   resume a context the browser, the tab or the OS suspended, unless
              the USER paused it (we track the user's own pause and never fight it)
   HEADROOM   watch the kernel's own load. If the audio thread is close to its
              deadline for several seconds, cap polyphony; if that is not enough,
              thin the voices (lite) and tell the visuals. Relax after a quiet minute.
   ══════════════════════════════════════════════════════════════════════════ */
const AudioGuard = (() => {
  'use strict';

  const st = { userPaused: false, resumes: 0, level: 0, hot: 0, calm: 0 };
  const VOICES = [72, 48, 32];

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

  function setLevel(level) {
    if (level === st.level) return;
    st.level = level;
    if (app.engine) app.engine.configure({ maxVoices: VOICES[level] });
    if (level === 2 && typeof Sound !== 'undefined' && !Sound.lite) {
      Sound.setLite(true);
      toast('Stability mode: lighter voices and visuals', true, 3000);
    }
    Hooks.emit('stability', level);
    console.info(`[audio] stability level ${level} (kernel load ${(app.engine.stats.load * 100).toFixed(0)}%)`);
  }

  setInterval(() => {
    const eng = app.engine;
    if (!eng) return;
    watch(eng);
    if (app.mode === 'playing' && !st.userPaused && eng.ctx.state !== 'running') resume('heartbeat');
    if (eng.ctx.state !== 'running') return;
    const load = eng.stats.load;
    if (load > 0.8) { st.calm = 0; if (++st.hot >= 3 && st.level < 2) { st.hot = 0; setLevel(st.level + 1); } }
    else { st.hot = 0; if (load < 0.45 && st.level > 0) { if (++st.calm >= 60) { st.calm = 0; setLevel(st.level - 1); } } else st.calm = 0; }
  }, 1000);

  return { stats: () => ({ ...st }) };
})();
if (typeof window !== 'undefined') window.AudioGuard = AudioGuard;