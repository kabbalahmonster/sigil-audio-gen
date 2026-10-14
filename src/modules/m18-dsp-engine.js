'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m18 · ENGINE BRIDGE & PANEL (Engine v2)
   --------------------------------------------------------------------------
   Keeps the DSP worklet in step with everything that changes the sound while
   it plays, WITHOUT those modules knowing the engine exists:
     Sound knobs (m11/m12) → section table (instant) · tables · re-plan
     Live Lens (m9)        → re-plan on the next frame
     Drum panel (m15)      → re-plan (polled at 2 Hz; m15 has no change event)
     Stage 'notes'         → Sound.recentNotes() for m13's ripples
   Plus the Engine panel: voices, DSP load, latency, meters, visual quality.
   ══════════════════════════════════════════════════════════════════════════ */
const DspEngine = (() => {
  'use strict';
  const { h } = UI;
  const live = () => {
    const e = app.engine;
    return e && e.isDSP && e.buses && app.song && e.song === app.song ? e : null;
  };

  /* ── Sound patch → engine ───────────────────────────────────────────── */
  const PLAN_KEYS = ['drumX', 'drumY', 'kSub', 'kPunch', 'kDecay', 'kTone', 'sBody', 'sSnap', 'sTone', 'hTone', 'hDecay'];
  const planNow = () => {
    const st = Sound.state();
    return st.P ? PLAN_KEYS.map((k) => st.P[k]).join(',') + `|${Sound.vowelMemoryOn}|${st.variant}` : '';
  };
  const verbNow = () => `${Sound.sigilVerbOn}|${Sound.state().variant}`;
  let planSig = '', verbSig = '', planT = 0;

  function onSound() {
    const e = live();
    if (!e || !Sound.state().P) return;
    SigilPlan.refreshSections(e);                                   // instant knobs
    e.setParams({ waveOff: SigilPlan.waveOffset(), voices: Sound.lite ? Math.min(28, Engine.voiceBudget()) : Engine.voiceBudget() });
    const ps = planNow();
    if (ps !== planSig) { planSig = ps; clearTimeout(planT); planT = setTimeout(() => SigilPlan.replan(live()), 150); }
    const vs = verbNow();
    if (vs !== verbSig) { verbSig = vs; SigilPlan.sendReverb(e, app.sigil); }
  }
  if (typeof Sound !== 'undefined') {
    Sound.subscribe(onSound);
    Hooks.on('song', () => { planSig = planNow(); verbSig = verbNow(); });
  }

  /* ── Lens → re-plan (coalesced to one per frame) ────────────────────── */
  let lensRaf = 0;
  Hooks.on('lens', () => {
    if (lensRaf) return;
    lensRaf = requestAnimationFrame(() => {
      lensRaf = 0;
      const e = live();
      if (e) { SigilPlan.replan(e); e.setParams({ waveOff: SigilPlan.waveOffset() }); }
    });
  });

  /* ── Drum panel → re-plan ───────────────────────────────────────────── */
  let drumSig = '';
  setInterval(() => {
    const e = live();
    if (!e || typeof DrumEngine === 'undefined' || !DrumEngine.settings) return;
    const s = JSON.stringify(DrumEngine.settings);
    if (drumSig && s !== drumSig) SigilPlan.replan(e);
    drumSig = s;
  }, 500);

  /* ── Audible note onsets → m13 ripples ──────────────────────────────── */
  const LOGGED = new Set(['lead', 'harm', 'pad', 'kick', 'snare']);
  Hooks.on('notes', (list) => {
    if (typeof Sound === 'undefined' || !Sound.recentNotes) return;
    const arr = Sound.recentNotes(), at = performance.now();
    for (const ev of list) {
      if (!LOGGED.has(ev.type)) continue;
      arr.push({ beat: ev.beat, at, kind: ev.type });
      if (arr.length > 48) arr.shift();
    }
  });

  /* ── Panel ──────────────────────────────────────────────────────────── */
  let info = null, meter = null, det = null;
  const NAMES = SigilDSP.BUS_NAMES.slice(0, 8);
  const hold = new Float32Array(NAMES.length + 1);
  const msOf = (x) => (x ? `${Math.round(x * 1000)} ms` : '—');

  function paint(d) {
    if (!det || !det.open || !info) return;
    const e = app.engine, c = e.ctx, s = Stage.stats();
    info.textContent =
      `engine   DSP worklet · ${c.sampleRate} Hz · ${c.state}\n` +
      `voices   ${d.voices} / ${d.budget} · stolen ${d.steals}\n` +
      `dsp      ${d.load >= 0 ? Math.round(d.load * 100) + ' % of the audio deadline' : 'load not reported by this browser'}\n` +
      `latency  base ${msOf(c.baseLatency)} · output ${msOf(c.outputLatency)}\n` +
      `visuals  ${s.label} · ${s.fps.toFixed(0)} fps · ${s.cost.toFixed(1)} ms JS/frame`;
    const g = meter.getContext('2d'), W = meter.width, Hh = meter.height, n = NAMES.length + 1, bw = W / n;
    const m = d.meters || [];
    g.clearRect(0, 0, W, Hh);
    g.font = `9px ${SERIF}`; g.textAlign = 'center';
    for (let i = 0; i < n; i++) {
      const v = i < NAMES.length ? m[i] : m[m.length - 1];
      hold[i] = Math.max(v || 0, hold[i] * 0.8);
      const f = clamp((20 * Math.log10(hold[i] + 1e-6) + 48) / 48, 0, 1);
      g.fillStyle = rgba(i === n - 1 ? renderer.pal.accent : renderer.pal.line, 0.6);
      g.fillRect(i * bw + 3, Hh - 12 - f * (Hh - 16), bw - 6, f * (Hh - 16));
      g.fillStyle = rgba(renderer.pal.line, 0.45);
      g.fillText(i < NAMES.length ? NAMES[i].slice(0, 4) : 'out', i * bw + bw / 2, Hh - 2);
    }
  }
  const watched = new WeakSet();
  Hooks.on('buses', (_b, e) => {
    if (!e.isDSP || watched.has(e)) return;
    watched.add(e);
    let lastPaint = 0;
    e.onTick((d) => { const now = performance.now(); if (now - lastPaint > 100) { lastPaint = now; paint(d); } });
  });

  UI.section({ id: 'dsp', title: 'Engine', order: 11, build(el, d) {
    det = d;
    UI.css(`.dsp-info{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.7;white-space:pre;opacity:.8;margin:6px 0;overflow:hidden}
      .dsp-meter{width:100%;height:64px;display:block;margin:4px 0 8px}`);
    info = h('pre', { class: 'dsp-info' }, 'Cast a sigil to start the engine.');
    meter = h('canvas', { class: 'dsp-meter', width: 280, height: 64, 'aria-hidden': 'true' });
    el.append(
      UI.note('Every voice and the scheduler run on the audio thread, so nothing the interface does can interrupt the sound. If the machine struggles, lower Voices first; the visuals adapt by themselves.'),
      info, meter,
      UI.select({ label: 'Voices', value: String(Engine.voiceBudget()),
        options: [['24', '24 · lightest'], ['32', '32'], ['48', '48 · default'], ['64', '64'], ['80', '80']],
        onChange: (v) => { Prefs.set('audio.voices', +v); if (app.engine) app.engine.setParams({ voices: +v }); } }),
      UI.select({ label: 'Latency', value: Prefs.get('audio.latency', 'playback'),
        options: [['playback', 'Playback · safest'], ['balanced', 'Balanced'], ['interactive', 'Interactive · lowest']],
        onChange: (v) => { Prefs.set('audio.latency', v); toast('Latency applies after a reload', true); } }),
      UI.check({ label: 'Adaptive visual quality', checked: Stage.adaptive, onChange: (v) => Stage.setAdaptive(v) }),
      UI.select({ label: 'Frame rate', value: String(Stage.fps),
        options: [['0', 'Display rate'], ['30', '30 fps · cooler, quieter']],
        onChange: (v) => Stage.setFps(+v) }),
      h('div', { class: 'sgrow' },
        UI.button('Rebuild plan', () => { const e = live(); if (e) { SigilPlan.replan(e); toast('Plan rebuilt', true); } }),
        UI.button('Silence', () => app.engine && app.engine.panic())));
  } });

  return { live, replan: () => SigilPlan.replan(live()) };
})();
if (typeof window !== 'undefined') window.DspEngine = DspEngine;