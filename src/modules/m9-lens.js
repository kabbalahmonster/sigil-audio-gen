'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M9 · LIVE LENS — rotate and mirror the sigil in real time
   --------------------------------------------------------------------------
   MUSICAL STATE (m, k): displayed slot → m·slot + k, composed AFTER the
   section's own transform. It applies instantly.

   VISUAL STATE is separate and animated, composed as

       phi = s_u·phi_s + phi_u,   s = s_u·s_s
       where phi_u = 2πk/21 and s_u = m

   so the wheel can glide into place while the music has already moved.

   The visual state is a PURE FUNCTION OF TIME (view()), evaluated inside the
   'viewT' filter during the existing render loop. No extra RAF loop.

   PATCH POINT: wraps Engine.prototype.play, but only for the LIVE engine —
   offline renders call map() explicitly when the user asks for it, so an
   export is never silently transposed.
   ══════════════════════════════════════════════════════════════════════════ */

const LiveLens = (() => {
  'use strict';
  const { h } = UI;

  const STEP = TAU / SLOTS;
  const INTV = ['', 'a step', 'a third', 'a fourth', 'a fifth', 'a sixth', 'a seventh'];

  let m = 1, k = 0;   // mirror, rotation in slots

  /* ── Visual animation state ────────────────────────────────────────── */
  const V = { pf: 0, pt: 0, sf: 1, st: 1, t0: 0, dur: 0.001 };
  const nowS = () => performance.now() / 1000;

  function view() {
    const p = ease((nowS() - V.t0) / V.dur);
    return { phi: lerp(V.pf, V.pt, p), s: lerp(V.sf, V.st, p) };
  }
  function animateTo(phi, s, dur = 0.55) {
    const c = view();
    Object.assign(V, { pf: c.phi, sf: c.s, pt: phi, st: s, t0: nowS(), dur });
  }
  function jump(phi, s) { Object.assign(V, { pf: phi, pt: phi, sf: s, st: s, t0: 0, dur: 0.001 }); }

  /* ── Music mapping ─────────────────────────────────────────────────── */

  const active = () => m !== 1 || mod(k, 7) !== 0;
  const shift = () => mod(k, 7);

  /** Transpose (and invert) a scale degree, then clamp back into the singable window. */
  function mapDeg(d) {
    let x = m * d + shift() + (m < 0 ? 7 : 0);
    while (x < -2) x += 7;
    while (x > 10) x -= 7;
    return x;
  }

  /** Map a chord root. Diminished results fall back to the chord a third below. */
  function mapChord(c, song = app.song) {
    if (!active()) return c;
    let r = mod(m === 1 ? c + shift() : -c - 4 + shift(), 7);
    if (song && song.validChords && !song.validChords.includes(r)) r = mod(r - 2, 7);
    return r;
  }

  /**
   * Return a TRANSFORMED COPY of an event (or the same event if unaffected).
   * Pure, and therefore safe to call from the offline renderer and MIDI export.
   */
  function map(ev, song = app.song) {
    if (!active() || !song) return ev;
    const sc = song.scale;

    switch (ev.type) {
      case 'lead': case 'harm': case 'bell': {
        if (ev.deg == null) return ev;
        let midi = degToMidi(mapDeg(ev.deg) + (ev.off || 0), ev.reg, sc) + (ev.add || 0);
        if (ev.cap && midi > ev.cap) midi -= 12;
        const from = ev.fromDeg != null ? degToMidi(mapDeg(ev.fromDeg), ev.reg, sc) : ev.from;
        return { ...ev, midi, from };
      }
      case 'pad':  return ev.chord == null ? ev : { ...ev, midis: padVoicing(mapChord(ev.chord, song), sc, song.leadBase, song.voicing) };
      case 'bass': return ev.chord == null ? ev : { ...ev, midi: bassPitch(mapChord(ev.chord, song), ev.role, song.bassBase, sc) };
      case 'arp':  return ev.chord == null ? ev : { ...ev, midi: arpTones(mapChord(ev.chord, song), sc, song.leadBase)[ev.idx] };
      default:     return ev;
    }
  }

  Engine.claim('play', 'M9 Live Lens');
  const _play = Engine.prototype.play;
  Engine.prototype.play = function (ev, t) {
    return _play.call(this, this === app.engine && active() ? map(ev, this.song) : ev, t);
  };

  Hooks.on('viewT', (T) => {
    const u = view();
    if (u.phi === 0 && u.s === 1) return;   // identity: leave the value alone
    return { phi: u.s * T.phi + u.phi, s: u.s * T.s };
  });

  /* ── Actions ───────────────────────────────────────────────────────── */

  const playing = () => app.mode === 'playing';

  function rotate(d) { if (!playing()) return; k += d; animateTo(k * STEP, m, 0.35); sync(); }

  /** Mirror about the half-slot axis (k → 1 − k), which keeps the current slot fixed. */
  function mirror() { if (!playing()) return; m = -m; k = 1 - k; animateTo(k * STEP, m); sync(); }

  function reset() {
    const c = view();
    const wrapped = mod(c.phi + Math.PI, TAU) - Math.PI;   // don't unwind many turns
    jump(wrapped, c.s);
    m = 1; k = 0;
    animateTo(0, 1, 0.6);
    sync();
  }

  function describe() {
    const p = [], sh = shift();
    if (sh) p.push(`${INTV[sh]} up`);
    if (m < 0) p.push('inverted');
    if (!p.length && mod(k, SLOTS)) p.push('turned · same pitches');
    return p.join(' · ');
  }

  const badge = h('div', { id: 'lens', hidden: true },
    h('span', { class: 'lens-text' }),
    UI.button('Reset', reset, { class: 'sm ghost', title: 'Reset the lens (0)' }));
  document.querySelector('#center').append(badge);

  UI.css(`#lens{margin-top:8px;font-size:12px;letter-spacing:.12em;font-style:italic;display:flex;gap:10px;justify-content:center;align-items:center;color:rgb(var(--accent))}
    #lens[hidden]{display:none}#lens button{padding:3px 8px}`);

  let lastText = '';
  function sync() {
    const on = m !== 1 || mod(k, SLOTS) !== 0, t = on ? describe() : '';
    badge.hidden = !on;
    badge.querySelector('.lens-text').textContent = t ? `lens · ${t}` : '';
    if (t !== lastText) { lastText = t; if (t) UI.announce(`Lens: ${t}`); }
  }

  /* ── Pointer interaction ───────────────────────────────────────────── */

  const cv = renderer.cv;
  cv.style.touchAction = 'none';   // we handle the gesture ourselves

  let drag = null, lastTap = 0;
  const polarOf = (e) => {
    const F = renderer.F, dx = e.clientX - F.cx, dy = e.clientY - F.cy;
    return { a: Math.atan2(dx, -dy), d: Math.hypot(dx, dy) / F.R };
  };

  cv.addEventListener('pointerdown', (e) => {
    if (!playing() || app.charging) return;
    const p = polarOf(e);
    if (p.d > 1.3) return;
    drag = { id: e.pointerId, a0: p.a, phi: view().phi, x: e.clientX, y: e.clientY,
             moved: false, ring: p.d >= 0.45 };     // only the outer ring rotates
    try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  cv.addEventListener('pointermove', (e) => {
    if (!drag) {   // hover affordance
      if (playing() && !app.charging) {
        const p = polarOf(e);
        cv.style.cursor = p.d >= 0.45 && p.d <= 1.3 ? 'grab' : '';
      }
      return;
    }
    if (e.pointerId !== drag.id || !drag.ring) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;   // tap threshold

    drag.moved = true;
    cv.style.cursor = 'grabbing';
    const p = polarOf(e);
    drag.phi += mod(p.a - drag.a0 + Math.PI, TAU) - Math.PI;   // incremental, so multiple turns work
    drag.a0 = p.a;
    jump(drag.phi, view().s);

    const nk = Math.round(drag.phi / STEP);
    if (nk !== k) { k = nk; if (navigator.vibrate) navigator.vibrate(4); sync(); }
  });

  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    cv.style.cursor = '';
    if (moved) { animateTo(k * STEP, m, 0.35); return; }   // snap to the nearest slot

    const t = nowS(), p = polarOf(e);
    if (p.d <= 1.05 && t - lastTap < 0.33) { mirror(); lastTap = 0; } else lastTap = t;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);

  Hooks.on('cast', () => {
    m = 1; k = 0; jump(0, 1); sync();
    if (!Prefs.get('lens.hinted', false)) {
      Prefs.set('lens.hinted', true);
      setTimeout(() => toast('Tip: drag the wheel to transpose · double-tap to mirror', true, 4200), 7000);
    }
  });

  UI.key('ArrowLeft', 'Lens: turn one step down', () => rotate(-1), { group: 'Live lens', display: '←' });
  UI.key('ArrowRight', 'Lens: turn one step up', () => rotate(1), { group: 'Live lens', display: '→' });
  UI.key('m', 'Lens: mirror (invert the melody)', mirror, { group: 'Live lens', display: 'M' });
  UI.key('0', 'Lens: reset', reset, { group: 'Live lens', display: '0' });

  UI.section({ id: 'lens', title: 'Live Lens', order: 15, build(el) {
    el.append(
      UI.note('Turn the wheel and the melody transposes by scale steps; mirror it and the melody inverts. Drag the outer ring, double-tap the circle, or use these controls.'),
      h('div', { class: 'sgrow' },
        UI.button('⟲ step', () => rotate(-1)),
        UI.button('step ⟳', () => rotate(1)),
        UI.button('Mirror', mirror),
        UI.button('Reset', reset)));
  } });

  return { map, mapChord, active, rotate, mirror, reset };
})();