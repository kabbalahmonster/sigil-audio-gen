'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m22 · RITES — which form the sigil is performed in
   --------------------------------------------------------------------------
   WHERE THINGS LIVE
     what a rite is     src/core/05g-rite.js   the forms, where each comes from, and how a
                                               form is dressed by any mood and style (pure)
     the Sevenfold      src/core/05-composer.js §5.1   the composer's own form, the default
     THIS FILE          remembers which rite is chosen, hooks 05g into the composer on
                        either side of the moods and styles, carries the choice in links
                        and the Grimoire, and puts a Rite tab beside Mood · Style · Element.

   WHEN IT SPEAKS (priorities on the composer's filters)
     compose  −30  the rite is named on cfg (cfg.rite; nothing is set for the Sevenfold)
     plan     −30  Rite.open   the rite's sections, answering to their roles' names
                0  M6 · +20 Style.plan · +50 M2 (long forms): the dressing, as ever
              +60  Rite.seal   the rite's holds, its length, each section's own id back

   THE CHOICE is a rite, or "by the sigil": the sigil draws its own rite from its own
   streams (one seed, everything derived). What it drew is then named like any other: the
   link and the Grimoire always carry the rite itself, as the fourth word of the working
   (#KRSTVM~dirge.trap.water.gates), so a shared link means the same rite for ever, whatever
   rites are added later.

   A CHANGE OF RITE during a performance begins the performance again: the form is what
   changed, so there is no "same section" to resume at. (A change of mood, style or
   element still resumes where it was.) The lots (M21) leave the rite alone, unless
   Shift is held: then they draw one of these as well (draw()).
   ══════════════════════════════════════════════════════════════════════════ */

const Rites = (() => {
  'use strict';
  const { h } = UI;
  const RT = Rite.RITES, DEFAULT = Rite.DEFAULT, OWN = 'own';
  const hasStyles = typeof Styles !== 'undefined';

  const valid = (id) => (id === OWN || RT[id] ? id : DEFAULT);
  let rite = valid(Prefs.get('rite', DEFAULT));

  /** The rite a sigil is performed in under the present choice: the one chosen, or the sigil's own draw. */
  const resolve = (sigil) => (rite === OWN ? (sigil ? Rite.own(sigil) : DEFAULT) : rite);
  /** The rite of the song that is loaded (what a link must say), else what the choice comes to. */
  const sounding = () => (app.song && app.song.cfg ? app.song.cfg.rite || DEFAULT : resolve(app.sigil));

  const trays = [];      // every Rite tray on the page, kept in step
  function sync() {
    if (hasStyles) Styles.sync(); else for (const t of trays) t._sync();
  }

  function set(id, { persist = true } = {}) {
    rite = valid(id);
    if (persist) Prefs.set('rite', rite);
    sync();
  }
  /** Choose a rite by lot (M21's lots, with Shift): any but the one sounding. Returns its id. */
  function draw() {
    const now = app.mode === 'playing' ? sounding() : rite, ids = Object.keys(RT).filter((id) => id !== now);
    const id = ids[Math.floor(Math.random() * ids.length)];
    set(id);
    return id;
  }
  /** Take the rite from a working (a link, a Grimoire entry): its fourth word, or the Sevenfold. */
  function adopt(t, opts) {
    set(String(t || '').toLowerCase().split('.')[3] || DEFAULT, opts);
  }

  /* ── The composer ────────────────────────────────────────────────────── */

  Hooks.on('compose', (cfg, sigil) => { const id = resolve(sigil); if (id !== DEFAULT) cfg.rite = id; }, -30);
  Hooks.on('plan', (plan, cfg) => Rite.open(cfg), -30);
  Hooks.on('plan', (plan, cfg) => { Rite.seal(plan, cfg); }, 60);

  /* ── Links, the Grimoire, the HUD ────────────────────────────────────── */

  // After M6 (10) and M21 (11) have written the mood, style and element; before M11 (20) appends a patch.
  Hooks.on('shareKey', (key) => {
    const id = sounding();
    if (id === DEFAULT) return undefined;
    const s = String(key), at = s.indexOf('~');
    const w = at < 0 ? [] : s.slice(at + 1).split('.');
    return `${at < 0 ? s : s.slice(0, at)}~${w[0] || 'ritual'}.${w[1] || 'none'}.${w[2] || 'aether'}.${id}`;
  }, 12);
  Hooks.on('beforeCast', (ctx) => { if (ctx.opts.preset) adopt(ctx.opts.preset, { persist: false }); });
  Hooks.on('link', (link) => { if (link.preset) adopt(link.preset, { persist: false }); });

  Hooks.on('meta', (parts) => {
    const d = app.song && Rite.describe(app.song.cfg);
    if (d) parts.push(d);
  }, 6);

  /* ── The tray: a pill for each rite, and what the chosen one is ──────── */

  const labelOf = (id) => (id === OWN ? 'By the sigil' : RT[id].label);
  const OWN_BLURB = 'The sigil chooses. Its own letters draw one of these rites, and it is performed in that one; the link then names the rite it drew.';

  /** "7 sections · 34 bars", and how long that is for the sigil now sounding, if this is its rite. */
  function lengthOf(id) {
    const m = Rite.measure(id), song = app.song;
    const here = song && app.mode === 'playing' && (song.cfg.rite || DEFAULT) === id;
    const spb = here && app.engine && app.engine.song === song ? app.engine.spb : song ? song.spb : 0;
    return `${m.sections} sections · ${m.bars} bars${here ? ` · ${UI.fmt(song.total * spb)} for this sigil` : ''}`;
  }

  function choose(id, live) {
    const was = sounding();
    set(id);
    if (!live || app.mode !== 'playing') return;
    const now = resolve(app.sigil);
    if (now !== was) UI.recompose({ top: true });
    UI.announce(`${RT[now].label} rite: ${lengthOf(now)}.`);
  }

  function tray(live) {
    const blurb = h('div', { class: 'mood-blurb' }), from = h('div', { class: 'rt-from' });
    const g = h('div', { class: 'moods wk-own', role: 'group', 'aria-label': 'Rite' },
      h('div', { class: 'mood-pills' }, [...Object.keys(RT), OWN].map((id) =>
        UI.button(labelOf(id), () => choose(id, live),
          { 'data-rite': id, title: id === OWN ? OWN_BLURB : `${RT[id].blurb} (${RT[id].from})`, 'aria-pressed': 'false' }))),
      blurb, from);
    g._sync = () => {
      g.querySelectorAll('button[data-rite]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rite === rite)));
      const drawn = rite === OWN && app.sigil && app.mode === 'playing' ? resolve(app.sigil) : null;
      blurb.textContent = rite === OWN ? (drawn ? `This sigil drew ${RT[drawn].label}. ${RT[drawn].blurb}` : OWN_BLURB) : RT[rite].blurb;
      const shown = rite === OWN ? drawn : rite;
      from.textContent = shown ? `${RT[shown].from} · ${lengthOf(shown)}` : '';
    };
    trays.push(g);
    g._sync();
    return g;
  }

  /** What the Rite tab says beside its name, and in the line under the chooser. */
  const name = () => (rite === OWN && app.sigil && app.mode === 'playing' ? `${RT[resolve(app.sigil)].label}, by the sigil` : labelOf(rite));
  const sum = () => (rite === DEFAULT ? '' : rite === OWN ? 'the rite by the sigil' : `${RT[rite].label}, ${Rite.measure(rite).bars} bars`);

  UI.css('.rt-from{font-size:11px;opacity:.38;margin-top:5px;letter-spacing:.03em;min-height:1.2em}');

  if (hasStyles) {
    Styles.addTab({ key: 'rite', label: 'Rite', tray, name, sum });
    const tool = document.querySelector('#tool-moods');
    if (tool && tool.querySelector('.wk')) {
      tool.querySelector('summary').textContent = 'Mood · Style · Element · Rite';
      const note = tool.querySelector('.tool-note');
      if (note) note.textContent = 'The mood is how it feels, the style the idiom it is played in, the element what it is made of, and the rite the form it takes: which of the sigil’s symmetries are performed, in what order, and how it ends. Any four make one piece; the melody and its chords are the sigil’s and are never touched. Changing the mood, style or element during a performance resumes at the current section. Changing the rite begins it again.';
    }
  } else {
    const hint = document.querySelector('#invoke .hint');
    if (hint) hint.before(tray(false));
    UI.section({ id: 'rites', title: 'Rite', order: 11, build(el) { el.append(tray(true)); } });
  }

  Hooks.on('song', sync);
  Hooks.on('stop', () => setTimeout(sync, 0));
  UI.whenReady(sync);

  return { set, adopt, draw, get: () => rite, resolve, sounding, OWN };
})();

if (typeof window !== 'undefined') window.Rites = Rites;
