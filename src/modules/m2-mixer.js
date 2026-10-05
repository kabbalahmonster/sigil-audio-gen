'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M2 · MIXER & TEMPO
   --------------------------------------------------------------------------
   Effective bus gain = default × song level × user level × mute × solo.

   TEMPO has two distinct modes, and the difference matters:
     • FACTOR  (default) — stored as a multiple of the sigil's native tempo, so
       it follows you between sigils. Applied to the live engine only.
     • LOCK    — an absolute bpm applied at COMPOSITION time, so the form can
       lengthen at fast tempos (see the 'plan' filter below).

   ENGINE EXTENSION: Engine.prototype.setTempo (documented as a patch point in
   06-engine.js) rescales the anchor so the musical POSITION is preserved.
   ══════════════════════════════════════════════════════════════════════════ */

const Mixer = (() => {
  'use strict';
  const { h } = UI;

  const BUSES = [['lead', 'Lead'], ['harm', 'Choir'], ['bell', 'Bells'], ['pad', 'Pad'],
                 ['bass', 'Bass'], ['arp', 'Arpeggio'], ['drums', 'Drums'], ['drone', 'Drone']];

  const BPM_MIN = 40, BPM_MAX = 240;
  /** Above this tempo the form doubles its verses and choruses. */
  const EXTEND_AT = 132;

  const defaults = () => ({
    master: 1, space: 1, tempo: 1, lock: 0,
    level: Object.fromEntries(BUSES.map(([k]) => [k, 1])),
    mute: {}, solo: {},
  });

  const saved = Prefs.get('mixer', {});
  const S = {
    ...defaults(), ...saved,
    level: { ...defaults().level, ...(saved.level || {}) },
    mute: saved.mute || {}, solo: saved.solo || {},
  };

  let saveT;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => Prefs.set('mixer', S), 300); };

  /* ── Engine extension: tempo change that preserves musical position ──── */
  Engine.claim('setTempo', 'M2 Mixer');
  Engine.prototype.setTempo = function (bpm) {
    if (!this.song || !(bpm > 0)) return;
    const now = this.ctx.currentTime;
    const r = (60 / bpm) / this.spb;
    const scale = (t) => now + (t - now) * r;   // rescale time about "now"

    this.anchor = scale(this.anchor);
    if (this.reanchorAt) { this.prevAnchor = scale(this.prevAnchor); this.reanchorAt = scale(this.reanchorAt); }
    this.spb = 60 / bpm;
    this.delay.delayTime.setTargetAtTime(this.spb * 0.75, now, 0.15);
  };

  /* ── Levels ────────────────────────────────────────────────────────── */

  function apply(eng = app.engine, instant = false) {
    if (!eng || !eng.buses) return;
    const now = eng.ctx.currentTime;
    const anySolo = BUSES.some(([k]) => S.solo[k]);
    const set = (param, v, tc = 0.05) => (instant ? param.setValueAtTime(v, now) : param.setTargetAtTime(v, now, tc));

    for (const [k] of BUSES) {
      const b = eng.buses[k];
      if (!b || b._base == null) continue;
      set(b.gain, b._base * S.level[k] * (S.mute[k] ? 0 : 1) * (anySolo && !S.solo[k] ? 0 : 1));
    }
    set(eng.out.gain, 0.85 * S.master);
    if (eng.revReturn) set(eng.revReturn.gain, 0.85 * S.space, 0.08);
  }

  // Record each bus's post-song-level gain as its baseline, then apply user levels.
  Hooks.on('buses', (buses, eng) => {
    for (const k of Object.keys(buses)) buses[k]._base = buses[k].gain.value;
    apply(eng, true);
  });

  /* ── Tempo ─────────────────────────────────────────────────────────── */

  const native = () => (app.song ? app.song.bpm : 0);
  const effective = () =>
    (app.engine && app.song && app.engine.song === app.song ? 60 / app.engine.spb : S.lock || 90);

  // Lock applies at composition time, AFTER moods and attunement, so it wins.
  Hooks.on('compose', (cfg) => { if (S.lock) cfg.bpm = clamp(S.lock, BPM_MIN, BPM_MAX); }, 50);

  // Fast tempos: double the verses and choruses so the song keeps its length.
  Hooks.on('plan', (plan, cfg) => {
    if (cfg.bpm < EXTEND_AT || cfg.formExtended) return;
    for (const s of plan) if (/^(verse|chorus)/.test(s.id)) s.phrases *= 2;
    cfg.formExtended = true;
  }, 50);

  Hooks.on('song', (sig, song) => {
    if (!S.lock && S.tempo !== 1) app.engine.setTempo(clamp(song.bpm * S.tempo, BPM_MIN, BPM_MAX));
    renderMeta();
    syncTempo(true);
  });

  Hooks.on('meta', (parts) => {
    if (!app.song) return;
    const i = parts.findIndex((p) => /bpm$/.test(p)), eff = Math.round(effective());
    if (i >= 0) {
      parts[i] = `${eff} bpm${S.lock ? ' · locked'
                : eff !== app.song.bpm ? ` (${Math.round((eff / app.song.bpm) * 100)}%)` : ''}`;
    }
  });

  let raf = 0, pending = 0, tempoRow, lockBox, tempoInfo;

  function setBpm(bpm) {
    bpm = clamp(Math.round(bpm), BPM_MIN, BPM_MAX);
    if (S.lock) S.lock = bpm;
    else if (app.song) S.tempo = bpm / app.song.bpm;

    // Coalesce to one engine update per frame while dragging.
    pending = bpm;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (app.engine && app.engine.song) app.engine.setTempo(pending);
      renderMeta(); syncTempo(false);
    });
    save();
  }

  /** moveSlider = false while the user is dragging (the engine updates a frame later). */
  function syncTempo(moveSlider) {
    if (!tempoRow) return;
    const eff = Math.round(pending && !moveSlider ? pending : effective());
    const n = native();
    if (moveSlider) tempoRow.set(eff);
    lockBox.input.checked = !!S.lock;
    tempoInfo.textContent =
      `${S.lock ? 'Locked for every casting' : n ? `Native ${n} bpm · ${Math.round((eff / n) * 100)}%` : ''}` +
      `${eff >= EXTEND_AT ? ' · the form is lengthened at this tempo (new castings)' : ''}`;
  }

  /* Tap tempo: averages the last up-to-6 taps; a 2 s gap starts a new phrase. */
  const taps = [];
  function tap() {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(t);
    if (taps.length > 6) taps.shift();
    if (taps.length >= 3) {
      const bpm = 60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1));
      setBpm(bpm); syncTempo(true); UI.announce(`${Math.round(bpm)} bpm`);
    }
  }

  /* ── Panel ─────────────────────────────────────────────────────────── */

  const SCENES = [
    ['Full',       () => { S.level = defaults().level; S.mute = {}; S.solo = {}; }],
    ['Meditation', () => { S.solo = {}; S.mute = { drums: true };
                           S.level = { ...defaults().level, bass: 0.6, arp: 0.5, pad: 1.2, drone: 1.3 }; }],
    ['Voices',     () => { S.mute = {}; S.solo = { lead: true, harm: true, bell: true }; }],
    ['Rhythm',     () => { S.mute = {}; S.solo = { drums: true, bass: true }; }],
  ];

  const rows = {};
  let master, space;
  const pct = (v) => `${Math.round(v * 100)}%`;

  function syncLevels() {
    master.set(S.master); space.set(S.space);
    for (const [k] of BUSES) {
      rows[k].slider.set(S.level[k]);
      rows[k].m.setAttribute('aria-pressed', String(!!S.mute[k]));
      rows[k].s.setAttribute('aria-pressed', String(!!S.solo[k]));
    }
  }

  UI.section({ id: 'mixer', title: 'Mixer & Tempo', order: 25, build(el) {
    UI.css(`.mx-strip{display:grid;grid-template-columns:64px 1fr 30px 30px;align-items:center;gap:8px;margin:4px 0;font-size:13px}
      .mx-strip>span{opacity:.72}.mx-strip button{padding:4px 0;font-size:10px;letter-spacing:.05em}`);

    tempoRow = UI.slider({
      label: 'Tempo', min: BPM_MIN, max: BPM_MAX, step: 1,
      value: Math.round(effective()), format: (v) => `${Math.round(v)} bpm`,
      onInput: (v, row) => {
        const n = native();
        if (!S.lock && n && Math.abs(v - n) <= 2) { v = n; row.set(n); }  // snap to native
        setBpm(v);
      },
    });

    lockBox = UI.check({
      label: 'Lock this tempo for every casting', checked: !!S.lock,
      onChange: (on) => {
        const e = effective();
        if (on) { S.lock = Math.round(e); S.tempo = 1; }
        else { S.lock = 0; S.tempo = app.song ? e / app.song.bpm : 1; }
        save(); renderMeta(); syncTempo(true);
      },
    });

    tempoInfo = UI.note('');
    master = UI.slider({ label: 'Volume', min: 0, max: 1.5, step: 0.01, value: S.master, format: pct,
                         onInput: (v) => { S.master = v; apply(); save(); } });
    space  = UI.slider({ label: 'Space', min: 0, max: 2, step: 0.01, value: S.space, format: pct,
                         onInput: (v) => { S.space = v; apply(); save(); } });

    el.append(tempoRow, lockBox,
      h('div', { class: 'sgrow' },
        UI.button('Tap', tap, { title: 'Tap tempo (B)' }),
        UI.button('Native', () => {
          S.lock = 0; S.tempo = 1;
          if (app.engine && app.song) app.engine.setTempo(app.song.bpm);
          pending = 0; save(); renderMeta(); syncTempo(true);
        }, { title: 'Return to the sigil’s own tempo' })),
      tempoInfo, master, space,
      h('div', { class: 'sgrow' }, SCENES.map(([name, fn]) =>
        UI.button(name, () => { fn(); syncLevels(); apply(); save(); UI.announce(`${name} mix`); }))));

    for (const [k, label] of BUSES) {
      const slider = UI.slider({ label, min: 0, max: 1.5, step: 0.01, value: S.level[k], format: pct,
                                 onInput: (v) => { S.level[k] = v; apply(); save(); } });
      const m = UI.button('M', () => { S.mute[k] = !S.mute[k]; syncLevels(); apply(); save(); },
        { title: `Mute ${label}`, 'aria-label': `Mute ${label}`, 'aria-pressed': 'false' });
      const s = UI.button('S', () => { S.solo[k] = !S.solo[k]; syncLevels(); apply(); save(); },
        { title: `Solo ${label}`, 'aria-label': `Solo ${label}`, 'aria-pressed': 'false' });
      rows[k] = { slider, m, s };
      el.append(h('div', { class: 'mx-strip' }, h('span', {}, label), slider.input, m, s));
    }

    el.append(h('div', { class: 'sgrow' }, UI.button('Reset all', () => {
      Object.assign(S, defaults());
      syncLevels(); apply();
      if (app.engine && app.song) app.engine.setTempo(app.song.bpm);
      pending = 0; save(); renderMeta(); syncTempo(true);
    })));

    syncLevels(); syncTempo(true);
  } });

  UI.key('b', 'Tap tempo', tap, { group: 'Performance', display: 'B' });

  return { apply, setBpm, state: S };
})();