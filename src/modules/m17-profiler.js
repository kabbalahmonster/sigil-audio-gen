'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m17 · PROFILER — where the milliseconds go
   --------------------------------------------------------------------------
   Reads two sources and adds no instrumentation of its own:
     Stage.stats     frame interval, draw time, governor level and scale
     engine.stats    kernel load (share of its deadline used), voices, peak,
                     per-bus meters, stolen voices, faults
   Profiler.report() copies a full diagnostic to the clipboard.
   ══════════════════════════════════════════════════════════════════════════ */
const Profiler = (() => {
  'use strict';
  const { h } = UI;

  function report() {
    const eng = app.engine, s = Stage.stats;
    return {
      when: new Date().toISOString(),
      ua: navigator.userAgent,
      cores: navigator.hardwareConcurrency || null,
      dpr: window.devicePixelRatio,
      canvas: [renderer.w, renderer.h, +renderer.dpr.toFixed(3)],
      stage: { frameMs: +s.frameMs.toFixed(2), drawMs: +s.drawMs.toFixed(2), worstMs: +s.worstMs.toFixed(1),
               periodMs: +s.period.toFixed(2), level: s.level, scale: s.scale, quality: Stage.quality },
      audio: eng ? {
        state: eng.ctx.state, sampleRate: eng.ctx.sampleRate,
        baseLatency: eng.ctx.baseLatency, outputLatency: eng.ctx.outputLatency,
        kernel: !!eng.node, error: eng.error ? String(eng.error) : null,
        load: +eng.stats.load.toFixed(3), voices: eng.stats.voices, peak: +eng.stats.peak.toFixed(3),
        stolen: eng.stats.stolen, faults: eng.stats.faults,
        plan: eng.plan ? { events: eng.plan.count, tables: eng.plan.tables } : null,
      } : null,
      guard: typeof AudioGuard !== 'undefined' ? AudioGuard.stats() : null,
      sound: typeof Sound !== 'undefined' ? { lite: Sound.lite, variant: Sound.state().variant } : null,
      visualStyle: Prefs.get('visual.mode', 'terrain'),
      mood: app.song && app.song.cfg ? app.song.cfg.mood : null,
      sigil: app.sigil ? app.sigil.reduced : null,
    };
  }

  let out, timer;
  const ms = (v) => `${v.toFixed(1)} ms`;
  function paint() {
    if (!out) return;
    const s = Stage.stats, e = app.engine && app.engine.stats;
    out.textContent =
      `frame   ${ms(s.frameMs)}  (${(1000 / s.frameMs).toFixed(0)} fps, worst ${s.worstMs.toFixed(0)} ms)\n` +
      `draw    ${ms(s.drawMs)}   quality ${s.level} · scale ${Math.round(s.scale * 100)}%\n` +
      (e ? `kernel  ${(e.load * 100).toFixed(0)}% of deadline · ${e.voices} voices · peak ${e.peak.toFixed(2)}\n` +
           `        stolen ${e.stolen} · faults ${e.faults}`
         : 'kernel  not started');
  }

  UI.section({ id: 'perf', title: 'Performance', order: 95, build(el) {
    UI.css('.perf-out{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.7;white-space:pre;opacity:.8}');
    out = h('pre', { class: 'perf-out' });
    el.append(
      UI.note('Audio runs on its own thread, so slow frames can no longer interrupt it. Kernel load is the share of each audio deadline the synthesis uses; draw is the time spent painting a frame.'),
      out,
      UI.select({ label: 'Visual quality', value: String(Stage.quality),
        options: [['auto', 'Automatic'], ['0', 'Full'], ['1', 'Reduced'], ['2', 'Minimal']],
        onChange: (v) => Stage.setQuality(v) }),
      h('div', { class: 'sgrow' },
        UI.button('Reset worst', () => { Stage.stats.worstMs = 0; }),
        UI.button('Visuals off', () => SoundVisuals.setMode('none')),
        UI.button('Copy report', () => {
          const t = JSON.stringify(report(), null, 1);
          if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Report copied', true));
          else prompt('Copy this report', t);
        })));
    clearInterval(timer);
    timer = setInterval(paint, 500);
    paint();
  } });

  return { stats: () => ({ ...Stage.stats }), report };
})();
if (typeof window !== 'undefined') window.Profiler = Profiler;