'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §6c  STAGE: one frame loop, one visual clock, one quality governor
   --------------------------------------------------------------------------
   Per frame:
     1. pin the audible time (engine.clock.frame) so every reader agrees
     2. score cursor: events that became AUDIBLE since last frame → Hooks 'notes'
     3. Hooks 'frame' (per-frame logic for modules; no drawing)
     4. renderer.draw → HUD → overlay layers (Stage.add)
     5. governor: if frames run long, climb the LADDER (glow → resolution →
        30 fps); step back down after sustained headroom, with backoff so it
        cannot oscillate.
   The governor emits the existing Hooks 'budget' (renderer + m13 obey it).
   ══════════════════════════════════════════════════════════════════════════ */
const Stage = (() => {
  'use strict';
  const LADDER = [
    { q: 0, s: 1,    fps: 0,  label: 'full' },
    { q: 1, s: 1,    fps: 0,  label: 'lighter glow' },
    { q: 1, s: 0.85, fps: 0,  label: 'lighter glow · 85% res' },
    { q: 1, s: 0.72, fps: 0,  label: 'lighter glow · 72% res' },
    { q: 2, s: 0.72, fps: 0,  label: 'minimal glow · 72% res' },
    { q: 2, s: 0.6,  fps: 0,  label: 'minimal glow · 60% res' },
    { q: 2, s: 0.5,  fps: 30, label: 'minimal · 50% res · 30 fps' },
  ];
  const S = {
    adaptive: Prefs.get('stage.adaptive', true),
    fps: +Prefs.get('stage.fps', 0) || 0,
    rung: clamp(Prefs.get('stage.rung', 0) | 0, 0, LADDER.length - 1),
  };
  const st = { interval: 16.7, cost: 0, worst: 0, bad: 0, good: 0, settle: 800, upWait: 6000, lastUp: -1e9, clock: 0 };
  const F = { now: 0, dt: 16.7, frame: 0, t: 0, beat: 0, playing: false, quality: 0, scale: 1 };
  const layers = [];
  const cur = { song: null, events: null, ptr: 0, beat: 0, list: [] };
  let raf = 0, last = 0, running = false, lastQ = -1, errShown = false, saveT = 0;

  /* ── score cursor ── */
  function lower(E, b) {
    let lo = 0, hi = E.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (E[m].beat < b) lo = m + 1; else hi = m; }
    return lo;
  }
  function cursor(beat) {
    const song = app.song;
    if (!F.playing || !song) { cur.song = null; return; }
    // new song, a re-written score (the drum part can change while it plays), seek, loop, stall
    if (cur.song !== song || cur.events !== song.events || beat < cur.beat - 0.02 || beat - cur.beat > 4) {
      cur.song = song; cur.events = song.events; cur.ptr = lower(song.events, beat); cur.beat = beat;
      return;
    }
    const E = song.events, list = cur.list;
    list.length = 0;
    while (cur.ptr < E.length && E[cur.ptr].beat <= beat) list.push(E[cur.ptr++]);
    cur.beat = beat;
    if (list.length) Hooks.emit('notes', list, beat);
  }

  /* ── governor ── */
  function apply() {
    const L = LADDER[S.rung];
    F.quality = L.q; F.scale = L.s;
    if (typeof renderer !== 'undefined' && renderer.renderScale !== L.s) { renderer.renderScale = L.s; renderer.resize(false); }
    if (L.q !== lastQ) { lastQ = L.q; Hooks.emit('budget', L.q); }
  }
  function setRung(r) {
    r = clamp(r | 0, 0, LADDER.length - 1);
    if (r === S.rung) return;
    const up = r < S.rung;
    if (!up && st.clock - st.lastUp < 4000) st.upWait = Math.min(st.upWait * 2, 120000);  // failed climb: wait longer
    if (up) st.lastUp = st.clock;
    S.rung = r;
    apply();
    st.bad = 0; st.good = 0; st.settle = 800;
    clearTimeout(saveT); saveT = setTimeout(() => Prefs.set('stage.rung', S.rung), 1000);
  }
  function govern(dt, cost) {
    st.clock += dt;
    st.interval += (dt - st.interval) * 0.1;
    st.cost += (cost - st.cost) * 0.1;
    if (cost > st.worst) st.worst = cost;
    if (!S.adaptive) return;
    if (st.settle > 0) { st.settle -= dt; return; }
    const target = 1000 / (S.fps || LADDER[S.rung].fps || 60);
    const over = st.interval > target * 1.3 || st.cost > target * 0.55;
    const under = st.interval < target * 1.1 && st.cost < target * 0.3;
    if (over) { st.bad += dt; st.good = 0; }
    else if (under) { st.good += dt; st.bad = Math.max(0, st.bad - dt); }
    else { st.good = 0; st.bad = Math.max(0, st.bad - dt * 0.5); }
    if (st.bad > 1500 && S.rung < LADDER.length - 1) setRung(S.rung + 1);
    else if (st.good > st.upWait && S.rung > 0) setRung(S.rung - 1);
  }

  /* ── the loop ── */
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    const cap = S.fps || LADDER[S.rung].fps;
    if (cap && last && ts - last < 1000 / cap - 2) return;
    const dt = last ? Math.min(ts - last, 250) : 16.7;
    last = ts;
    const t0 = performance.now(), eng = app.engine, clock = eng && eng.clock;
    if (clock) clock.frame(t0);
    F.now = ts; F.dt = dt; F.frame++;
    F.playing = app.mode === 'playing' && !!app.song && !!eng;
    F.t = clock ? clock.now() : 0;
    F.beat = F.playing ? eng.beatNow() : 0;
    try {
      cursor(F.beat);
      Hooks.emit('frame', F);
      renderer.draw(app);
      updateHUD();
      for (const L of layers) L.fn(F, renderer.g);
    } catch (e) {
      if (!errShown) { errShown = true; console.error('[frame]', e); }
    }
    if (clock) clock.endFrame();
    govern(dt, performance.now() - t0);
  }
  document.addEventListener('visibilitychange', () => { st.settle = 800; last = 0; });

  function remove(id) { const i = layers.findIndex((l) => l.id === id); if (i >= 0) layers.splice(i, 1); }

  return {
    start() { if (running) return; running = true; apply(); raf = requestAnimationFrame(loop); },
    stop() { running = false; cancelAnimationFrame(raf); },
    /** Overlay layer drawn after the renderer: fn(frame, ctx2d). Save/restore your own state. */
    add(id, fn, order = 0) { remove(id); layers.push({ id, fn, order }); layers.sort((a, b) => a.order - b.order); return () => remove(id); },
    remove,
    frame: F,
    LADDER,
    get adaptive() { return S.adaptive; },
    get fps() { return S.fps; },
    setAdaptive(v) { S.adaptive = !!v; Prefs.set('stage.adaptive', S.adaptive); if (!S.adaptive) setRung(0); },
    setFps(v) { S.fps = v | 0; Prefs.set('stage.fps', S.fps); st.settle = 800; },
    setRung,
    stats: () => ({ rung: S.rung, label: LADDER[S.rung].label, fps: 1000 / st.interval, cost: st.cost, worst: st.worst, interval: st.interval }),
  };
})();