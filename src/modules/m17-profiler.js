'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m17 · PROFILER — where the milliseconds go
   --------------------------------------------------------------------------
   Measures, with almost no cost of its own:
     frame   the real interval between animation frames
     draw    time inside renderer.draw(), the whole visual frame
     visual  time inside the 'drawPlaying' hook, i.e. the sound visuals
     nodes   Web Audio nodes created per second (the synthesis cost proxy)
     gap     the worst scheduler gap, read from the AudioGuard

   It also runs the BUDGET: when drawing exceeds its share of a frame, it emits
   Hooks 'budget' with a level, and the visuals degrade themselves. The audio
   scheduler gets the frame back before it starves.

   Profiler.report() copies a full diagnostic to the clipboard. If anything is
   still stalling, send me that.
   ══════════════════════════════════════════════════════════════════════════ */

const Profiler = (() => {
  'use strict';
  const { h } = UI;

  const st = {
    frame: 16, draw: 0, visual: 0,
    nodes: 0, nodesPerSec: 0,
    level: 0, worstFrame: 0,
  };
  let nodeCount = 0, lastSecond = performance.now(), lastFrame = 0;

  /* ── Node counting: wrap the factory methods once, on the prototype ──── */
  const B = window.BaseAudioContext && BaseAudioContext.prototype;
  if (B) {
    for (const k of ['createOscillator', 'createGain', 'createBiquadFilter', 'createBufferSource',
                     'createWaveShaper', 'createStereoPanner', 'createDelay', 'createPeriodicWave',
                     'createConvolver', 'createDynamicsCompressor', 'createAnalyser']) {
      const orig = B[k];
      if (!orig) continue;
      B[k] = function (...a) { nodeCount++; return orig.apply(this, a); };
    }
  }

  /* ── Time the whole visual frame ─────────────────────────────────────── */
  const origDraw = renderer.draw.bind(renderer);
  renderer.draw = function (a) {
    const t0 = performance.now();
    origDraw(a);
    st.draw = st.draw * 0.9 + (performance.now() - t0) * 0.1;
  };

  /* ── Time just the sound visuals ─────────────────────────────────────── */
  const origEmit = Hooks.emit.bind(Hooks);
  Hooks.emit = function (name, ...args) {
    if (name !== 'drawPlaying') return origEmit(name, ...args);
    const t0 = performance.now();
    origEmit(name, ...args);
    st.visual = st.visual * 0.9 + (performance.now() - t0) * 0.1;
  };

  /* ── Budget: keep drawing under a third of the frame ─────────────────── */
  function setLevel(l) {
    if (l === st.level) return;
    st.level = l;
    Hooks.emit('budget', l);
    if (l > 0) console.info(`[profiler] budget level ${l}: draw ${st.draw.toFixed(1)} ms`);
  }

  function tick() {
    const now = performance.now();
    if (lastFrame) {
      const dt = now - lastFrame;
      st.frame = st.frame * 0.9 + Math.min(dt, 200) * 0.1;
      if (dt > st.worstFrame) st.worstFrame = dt;
    }
    lastFrame = now;

    if (now - lastSecond >= 1000) {
      st.nodesPerSec = nodeCount;
      st.nodes += nodeCount;
      nodeCount = 0;
      lastSecond = now;

      // Three steps: full, reduced, minimal. Recovers when the frame is cheap again.
      if (st.draw > 14) setLevel(2);
      else if (st.draw > 8) setLevel(1);
      else if (st.draw < 5) setLevel(0);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ── Diagnostic report ───────────────────────────────────────────────── */
  function report() {
    const eng = app.engine;
    const guard = typeof AudioGuard !== 'undefined' ? AudioGuard.stats() : null;
    return {
      when: new Date().toISOString(),
      ua: navigator.userAgent,
      cores: navigator.hardwareConcurrency || null,
      dpr: window.devicePixelRatio,
      canvas: [renderer.w, renderer.h, renderer.dpr],
      frameMs: +st.frame.toFixed(2),
      drawMs: +st.draw.toFixed(2),
      visualMs: +st.visual.toFixed(2),
      worstFrameMs: +st.worstFrame.toFixed(1),
      nodesPerSec: st.nodesPerSec,
      budgetLevel: st.level,
      guard,
      audio: eng ? {
        state: eng.ctx.state,
        sampleRate: eng.ctx.sampleRate,
        baseLatency: eng.ctx.baseLatency,
        outputLatency: eng.ctx.outputLatency,
        horizon: Engine.prototype.horizon,
        hasWorklet: !!eng.sfx,
      } : null,
      sound: typeof Sound !== 'undefined' ? {
        mode: Sound.mode, lite: Sound.lite, variant: Sound.state().variant,
      } : null,
      visualStyle: Prefs.get('visual.mode', 'terrain'),
      mood: app.song && app.song.cfg ? app.song.cfg.mood : null,
      sigil: app.sigil ? app.sigil.reduced : null,
    };
  }

  /* ── Panel ───────────────────────────────────────────────────────────── */
  let out, timer;
  const ms = (v) => `${v.toFixed(1)} ms`;

  function paint() {
    if (!out) return;
    const fps = st.frame > 0 ? 1000 / st.frame : 0;
    const g = typeof AudioGuard !== 'undefined' ? AudioGuard.stats() : { stalls: 0, stallTimes: 0, resumes: 0 };
    out.textContent =
      `frame   ${ms(st.frame)}  (${fps.toFixed(0)} fps, worst ${st.worstFrame.toFixed(0)} ms)\n` +
      `draw    ${ms(st.draw)}   of which visuals ${ms(st.visual)}\n` +
      `nodes   ${st.nodesPerSec}/s\n` +
      `budget  level ${st.level}\n` +
      `audio   stalls ${g.stalls} (${g.stallTimes} recent) · resumes ${g.resumes} · horizon ${Engine.prototype.horizon}`;
  }

  UI.section({ id: 'perf', title: 'Performance', order: 95, build(el) {
    UI.css('.perf-out{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.7;white-space:pre;opacity:.8}');
    out = h('pre', { class: 'perf-out' });
    el.append(
      UI.note('If the audio stutters, look here first. Anything above about 8 ms of draw time on a 60 Hz display is competing with the scheduler.'),
      out,
      h('div', { class: 'sgrow' },
        UI.button('Reset worst', () => { st.worstFrame = 0; }),
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

  return { stats: () => ({ ...st }), report };
})();

if (typeof window !== 'undefined') window.Profiler = Profiler;