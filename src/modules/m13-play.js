'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M13 · PLAY — the wheel as a keyboard
   --------------------------------------------------------------------------
   Three rows of the computer keyboard are the three rings of the wheel, so
   the instrument's layout IS the sigil's layout:

       q w e r t y u i o p     outer ring (high)
       a s d f g h j k l ;     middle ring
       z x c v b n m , . /     inner ring (low)

   Press P (or the Play button) to enter play mode. While it is on, pointer
   gestures on the wheel play notes instead of turning the Live Lens, so the
   two never fight.

   Quantise snaps your notes to the nearest eighth of the running song, which
   makes it almost impossible to play something that does not fit.
   ══════════════════════════════════════════════════════════════════════════ */
const Play = (() => {
  'use strict';
  const { h } = UI;

  const ROWS = [
    [...'qwertyuiop'],   // ring 2
    [...'asdfghjkl;'],   // ring 1
    [...'zxcvbnm,./'],   // ring 0
  ];
  const RING_OF_ROW = [2, 1, 0];

  const S = { on: false, quantise: true, latch: false };
  const held = new Map();     // key or pointerId → voice handle
  let litSlot = null, litUntil = 0;

  const live = () => app.mode === 'playing' && app.engine && app.engine.buses;

  /** Slot + ring → MIDI, using exactly the composer's mapping. */
  function midiFor(slot, ring) {
    const song = app.song;
    if (!song) return 60;
    let deg = mod(slot, 7) + 7 * (ring - 1);
    while (deg < -2) deg += 7;
    while (deg > 14) deg -= 7;
    return degToMidi(deg, song.leadBase, song.scale);
  }

  /** Delay until the next eighth note, in ms. Zero when quantise is off. */
  function quantiseDelay() {
    if (!S.quantise || !live()) return 0;
    const b = app.engine.beatNow();
    return (0.5 - mod(b, 0.5)) * app.engine.spb * 1000;
  }

  function noteOn(id, slot, ring, vel = 0.85) {
    if (!live() || held.has(id)) return;
    const midi = midiFor(slot, ring);
    litSlot = slot; litUntil = performance.now() / 1000 + 0.45;
    const fire = () => {
      const v = app.engine.playNote(midi, vel);
      if (!v) return;
      if (S.latch) { setTimeout(() => v.release(), 1400); return; }
      if (held.has(id)) held.set(id, v); else v.release();   // released before it sounded
    };
    held.set(id, null);
    const d = quantiseDelay();
    d > 6 ? setTimeout(fire, d) : fire();
  }

  function noteOff(id) {
    const v = held.get(id);
    if (v && v.release) v.release();
    held.delete(id);
  }

  function toggle(on = !S.on) {
    S.on = on && live();
    document.body.classList.toggle('playing-sigil', S.on);
    if (!S.on) { for (const id of [...held.keys()]) noteOff(id); }
    if (btn) btn.setAttribute('aria-pressed', String(S.on));
    UI.announce(S.on ? 'Play mode on. Keyboard rows are the three rings.' : 'Play mode off.');
  }

  /* ── Keyboard ─────────────────────────────────────────────────────────── */
  document.addEventListener('keydown', (e) => {
    if (!S.on || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    for (let r = 0; r < ROWS.length; r++) {
      const i = ROWS[r].indexOf(e.key.toLowerCase());
      if (i < 0) continue;
      e.preventDefault();
      noteOn('k:' + e.key.toLowerCase(), i * 2, RING_OF_ROW[r]);   // spread 10 keys over 21 slots
      return;
    }
  });
  document.addEventListener('keyup', (e) => noteOff('k:' + e.key.toLowerCase()));
  addEventListener('blur', () => { for (const id of [...held.keys()]) noteOff(id); });

  /* ── Pointer on the wheel. Capture phase, so the Live Lens never sees it
        while play mode is on. ───────────────────────────────────────────── */
  const cv = renderer.cv;
  const slotAt = (e) => {
    const F = renderer.F;
    const dx = e.clientX - F.cx, dy = e.clientY - F.cy;
    const d = Math.hypot(dx, dy) / F.R;
    if (d > 1.35) return null;
    const T = Hooks.filter('viewT', displayTransform(app.song, app.engine.beatNow()), { beat: 0, song: app.song });
    // Undo the display rotation/mirror so a tap hits the letter you can see.
    let a = Math.atan2(dx, -dy) - (app.sigil.baseAngle + T.phi);
    if (T.s < 0) a = -a;
    const slot = mod(Math.round((a / TAU) * SLOTS), SLOTS);
    const ring = d < 0.47 ? 0 : d < 0.73 ? 1 : 2;
    return { slot, ring };
  };

  cv.addEventListener('pointerdown', (e) => {
    if (!S.on || !live()) return;
    const p = slotAt(e);
    if (!p) return;
    e.stopImmediatePropagation();
    try { cv.setPointerCapture(e.pointerId); } catch {}
    noteOn('p:' + e.pointerId, p.slot, p.ring);
  }, true);
  cv.addEventListener('pointerup', (e) => { if (S.on) noteOff('p:' + e.pointerId); }, true);
  cv.addEventListener('pointercancel', (e) => noteOff('p:' + e.pointerId), true);

  /* ── Visual feedback: the struck slot flares. ────────────────────────── */
  Hooks.on('drawPlaying', ({ r, F, T, lines }) => {
    if (litSlot == null) return;
    const now = performance.now() / 1000;
    if (now > litUntil) { litSlot = null; return; }
    const q = 1 - (litUntil - now) / 0.45;
    const [x, y] = polar(litSlot, 1.08, T, F);
    r.circle(x, y, 3 + F.R * 0.09 * q, r.pal.accent, 0.8 * (1 - q), false, 1.4);
  });

  let btn;
  UI.css(`body.playing-sigil canvas#stage{cursor:pointer}
    #playBadge{margin-left:.8em;letter-spacing:.2em;color:rgb(var(--accent))}`);

  UI.section({ id: 'play', title: 'Play', order: 18, build(el) {
    btn = UI.button('Play mode', () => toggle(), { 'aria-pressed': 'false', title: 'P' });
    el.append(
      UI.note('Press P, then play the sigil. The three keyboard rows are the three rings: q-row outer, a-row middle, z-row inner. Tap or drag the wheel to play it directly.'),
      h('div', { class: 'sgrow' }, btn),
      UI.check({ label: 'Quantise to the beat', checked: S.quantise, onChange: (v) => (S.quantise = v) }),
      UI.check({ label: 'Latch (notes release themselves)', checked: S.latch, onChange: (v) => (S.latch = v) }));
  } });

  UI.key('p', 'Play mode on / off', () => toggle(), { group: 'Instrument', display: 'P' });
  Hooks.on('stop', () => toggle(false));

  return { toggle, noteOn, noteOff };
})();