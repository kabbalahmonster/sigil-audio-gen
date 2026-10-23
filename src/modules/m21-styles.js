'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m21 · STYLE & ELEMENT — the idiom the rite is played in, what it is made of,
        and the lots that choose them
   --------------------------------------------------------------------------
   WHERE THINGS LIVE
     what a style is    src/core/05f-style.js   the idioms, the elements, and how they are
                                                laid over a mood (pure; the rules are there)
     the moods          m6                      how a rite feels
     THIS FILE          remembers which style and element are chosen, hooks 05f into the
                        composer at the right moments, and gives the three choices one
                        place on the page: Mood · Style · Element, and the lots.

   WHEN EACH THING SPEAKS (priorities on the composer's filters)
     compose  −20  Style.before   what the sigil itself dealt is remembered
              −10  M10 Astral · 0 M6 Moods   the hour and the mood have their say
              +20  Style.compose  the style and the element are laid over the result
              +50  M2's tempo lock still has the last word on the tempo
     plan       0  M6 · +20 Style.plan (inside the mood's range) · +50 M2 (long forms)
     score      0  M15 writes the kit (the style's, through Groove's `feel`)
              +10  Style.parts    the rest of the band, then the swing over everyone

   THE WORKING. Mood, style and element travel together as one word,
   "mood.style.element" (trailing defaults dropped): in a link (#KRSTVM~dirge.trap.water),
   in the Grimoire, and through cast({ preset }). M6 reads the first part, this file the next
   two. A fourth word, if there is one, is the RITE (05g, M22): the form the working takes.
   M22 reads it, and puts its own tab in the chooser built here (addTab).

   THE LOTS draw a mood, a style and an element at random (it is the one place in SIGIL
   where chance is not the sigil's: what is drawn is then as deterministic as anything
   else, and the link says which). With Shift held they draw a rite too.
   ══════════════════════════════════════════════════════════════════════════ */

const Styles = (() => {
  'use strict';
  const { h } = UI;
  const ST = Style.STYLES, EL = Style.ELEMENTS;
  const hasMoods = typeof Moods !== 'undefined';

  let style = ST[Prefs.get('style', 'none')] ? Prefs.get('style', 'none') : 'none';
  let element = EL[Prefs.get('element', 'aether')] ? Prefs.get('element', 'aether') : 'aether';

  /* ── The working: the choices as one word ────────────────────────────── */

  const RT = typeof Rite !== 'undefined' ? Rite.RITES : {}, RITE0 = typeof Rite !== 'undefined' ? Rite.DEFAULT : 'sevenfold';
  const DEFAULTS = ['ritual', 'none', 'aether', RITE0];

  /** "mood.style.element.rite" with trailing defaults dropped ('' when all are the defaults). */
  function tagOf(mood, st, el, rite) {
    const parts = [mood || DEFAULTS[0], st || DEFAULTS[1], el || DEFAULTS[2], rite || DEFAULTS[3]];
    while (parts.length && parts[parts.length - 1] === DEFAULTS[parts.length - 1]) parts.pop();
    return parts.join('.');
  }
  /** The working a song was composed in. */
  const tag = (cfg) => tagOf(cfg && cfg.mood, cfg && cfg.style, cfg && cfg.element, cfg && cfg.rite);
  /** A working, as words: "Dirge · Trap · Water · Seven Gates". Defaults are left unsaid. */
  function words(t) {
    const [m, s, e, r] = String(t || '').split('.');
    return [hasMoods && m && m !== 'ritual' && Moods.MOODS[m] ? Moods.MOODS[m].label : '',
      s && s !== 'none' && ST[s] ? ST[s].label : '', e && e !== 'aether' && EL[e] ? EL[e].label : '',
      r && r !== RITE0 && RT[r] ? RT[r].label : ''].filter(Boolean).join(' · ');
  }

  function setStyle(id, { persist = true } = {}) {
    style = ST[id] ? id : 'none';
    if (persist) Prefs.set('style', style);
    sync();
  }
  function setElement(id, { persist = true } = {}) {
    element = EL[id] ? id : 'aether';
    if (persist) Prefs.set('element', element);
    sync();
  }
  /** Take the style and element from a working (a link, a Grimoire entry). The mood is M6's to take. */
  function adopt(t, opts) {
    const [, s, e] = String(t || '').toLowerCase().split('.');
    setStyle(s || 'none', opts); setElement(e || 'aether', opts);
  }

  /* ── The composer ────────────────────────────────────────────────────── */

  Hooks.on('compose', (cfg) => { Style.before(cfg); }, -20);
  Hooks.on('compose', (cfg, sigil) => { Style.compose(cfg, sigil, style, element); }, 20);
  Hooks.on('plan', (plan, cfg) => { Style.plan(plan, cfg); }, 20);
  Hooks.on('score', (events, ctx) => {
    const cfg = ctx.cfg;
    if (!cfg.feel) return undefined;
    // The kit is M15's to write (through the feel). Without M15, or if it did not, it is written here.
    if (!(cfg.groove && cfg.groove.style === cfg.feel.id)) events = Groove.score(events, ctx, { ...(cfg.drums || {}) });
    return Style.parts(events, ctx);
  }, 10);

  /* ── Links, the Grimoire, the HUD, the wheel's colours ───────────────── */

  Hooks.on('shareKey', (key) => {
    if (style === 'none' && element === 'aether') return undefined;
    const [head, patch] = String(key).split('!'), at = head.indexOf('~');
    const body = at < 0 ? head : head.slice(0, at), mood = at < 0 ? 'ritual' : head.slice(at + 1).split('.')[0];
    return `${body}~${tagOf(mood, style, element)}${patch ? '!' + patch : ''}`;
  }, 11);
  Hooks.on('beforeCast', (ctx) => { if (ctx.opts.preset) adopt(ctx.opts.preset, { persist: false }); });
  Hooks.on('link', (link) => { if (link.preset) adopt(link.preset, { persist: false }); });

  Hooks.on('meta', (parts) => {
    const cfg = app.song && app.song.cfg;
    if (!cfg) return;
    const felt = Style.felt(cfg, app.engine && app.engine.song === app.song ? 60 / app.engine.spb : app.song.bpm);
    const i = parts.findIndex((p) => /bpm/.test(p));
    if (felt && i >= 0) parts.splice(i + 1, 0, `felt ${felt}`);
    const d = Style.describe(cfg);
    if (d) parts.push(d);
  }, 5);

  Hooks.on('palette', () => {
    const e = app.song && app.song.cfg && Style.elementOf(app.song.cfg.element);
    return e && e.palette ? e.palette : undefined;
  }, 5);

  /* ── The lots ────────────────────────────────────────────────────────── */

  const pickOf = (list) => list[Math.floor(Math.random() * list.length)];
  /**
   * Draw a mood, a style and an element, never the three already chosen. Recomposes if a rite is sounding.
   * With Shift held (Shift-click, Shift+Y) a rite is drawn as well (M22), and the performance begins again
   * in it; without, the rite is left as it is and the performance resumes where it was.
   */
  function lots(ev) {
    const moods = hasMoods ? Object.keys(Moods.MOODS) : ['ritual'], styles = Object.keys(ST), els = Object.keys(EL);
    const now = tagOf(hasMoods ? Moods.get() : 'ritual', style, element);
    let m, s, e, tries = 0;
    do { m = pickOf(moods); s = pickOf(styles); e = pickOf(els); } while (tagOf(m, s, e) === now && ++tries < 20);
    if (hasMoods) Moods.set(m);
    setStyle(s); setElement(e);
    const rite = ev && ev.shiftKey && typeof Rites !== 'undefined' ? Rites.draw() : null;
    const said = words(tagOf(m, s, e, rite)) || 'Ritual, unstyled, of Aether';
    if (app.mode === 'playing') UI.recompose(rite ? { top: true } : undefined);
    toast(said, true, 2600);
    UI.announce(`The lots: ${said}.`);
    return tagOf(m, s, e, rite);
  }

  /* ── The chooser: Mood · Style · Element, and the lots ───────────────── */

  const choosers = [];   // every chooser on the page (the invocation's and the Tools panel's), kept in step
  const extras = [];     // tabs other modules have added (M22's Rite): { key, label, tray(live), name(), sum() }

  function pills(kind, live) {
    const table = kind === 'style' ? ST : EL, cur = () => (kind === 'style' ? style : element);
    const blurb = h('div', { class: 'mood-blurb' }, table[cur()].blurb);
    const g = h('div', { class: 'moods wk-own', role: 'group', 'aria-label': kind === 'style' ? 'Style' : 'Element' },
      h('div', { class: 'mood-pills' }, Object.keys(table).map((id) =>
        UI.button(table[id].label, () => {
          (kind === 'style' ? setStyle : setElement)(id);
          if (live && app.mode === 'playing') { UI.recompose(); UI.announce(`${table[id].label} ${kind}`); }
        }, { [`data-${kind}`]: id, title: table[id].blurb, 'aria-pressed': String(id === cur()) }))),
      blurb);
    g._sync = () => {
      g.querySelectorAll(`button[data-${kind}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[kind] === cur())));
      blurb.textContent = table[cur()].blurb;
    };
    return g;
  }

  /** Wrap a mood pill group (M6's) into a chooser: three tabs, three trays, the lots. */
  function chooser(moodGroup, live) {
    const trays = { mood: moodGroup, style: pills('style', live), element: pills('element', live) };
    const names = { mood: h('b'), style: h('b'), element: h('b') };
    const tabs = {};
    const show = (which) => {
      for (const k of Object.keys(trays)) {
        if (!trays[k]) continue;
        trays[k].hidden = k !== which;
        tabs[k].setAttribute('aria-selected', String(k === which));
        tabs[k].tabIndex = k === which ? 0 : -1;
      }
    };
    const bar = h('div', { class: 'wk-tabs', role: 'tablist', 'aria-label': 'What the rite is dressed in' });
    for (const [k, label] of [['mood', 'Mood'], ['style', 'Style'], ['element', 'Element']]) {
      if (!trays[k]) continue;
      tabs[k] = h('button', { class: 'wk-tab', type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => show(k) }, label, names[k]);
      bar.append(tabs[k]);
    }
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const keys = Object.keys(tabs), i = keys.findIndex((k) => tabs[k].getAttribute('aria-selected') === 'true');
      const k = keys[mod(i + (e.key === 'ArrowRight' ? 1 : -1), keys.length)];
      show(k); tabs[k].focus(); e.preventDefault(); e.stopPropagation();
    });
    const lotsBtn = UI.button('Cast lots', lots, { class: 'sm wk-lots', title: 'Draw a mood, a style and an element at random (Y). With Shift held, a rite as well' });
    bar.append(lotsBtn);
    const sum = h('div', { class: 'wk-sum', role: 'status', 'aria-live': 'off' });
    const box = h('div', { class: 'wk' }, bar);
    if (moodGroup) { moodGroup.before(box); moodGroup.addEventListener('click', () => setTimeout(sync, 0)); }
    box.append(...Object.values(trays).filter(Boolean), sum);
    const mine = [];       // the extra tabs of this chooser
    const c = { box, show, live,
      /** Another module's tab, after the three: its tray is built for this chooser and kept in step with it. */
      add(x) {
        const tray = x.tray(live);
        trays[x.key] = tray; names[x.key] = h('b');
        tabs[x.key] = h('button', { class: 'wk-tab', type: 'button', role: 'tab', 'aria-selected': 'false', tabindex: '-1', onclick: () => show(x.key) }, x.label, names[x.key]);
        lotsBtn.before(tabs[x.key]);
        tray.hidden = true;
        sum.before(tray);
        mine.push(x);
      },
      sync() {
        names.mood.textContent = hasMoods ? Moods.MOODS[Moods.get()].label : '';
        names.style.textContent = ST[style].label; names.element.textContent = EL[element].label;
        trays.style._sync(); trays.element._sync();
        for (const x of mine) { names[x.key].textContent = x.name(); if (trays[x.key]._sync) trays[x.key]._sync(); }
        const w = words(tagOf(hasMoods ? Moods.get() : 'ritual', style, element));
        const tempo = ST[style].tempo ? `${ST[style].tempo[0] * (ST[style].felt || 1)}–${ST[style].tempo[1] * (ST[style].felt || 1)} bpm` : '';
        sum.textContent = [w, tempo, ...mine.map((x) => (x.sum ? x.sum() : ''))].filter(Boolean).join(' · ') || 'the rite as the sigil wrote it';
      } };
    for (const x of extras) c.add(x);
    show(moodGroup ? 'mood' : 'style');
    choosers.push(c);
    return c;
  }

  function sync() { for (const c of choosers) c.sync(); }

  /** Give every chooser another tab (M22's Rite). x = { key, label, tray(live) → element with _sync(), name(), sum() }. */
  function addTab(x) {
    extras.push(x);
    for (const c of choosers) c.add(x);
    sync();
  }

  UI.css(`.wk{margin-top:14px}.wk .moods{margin-top:10px}
    .wk-tabs{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:4px 14px}
    .wk-tab{all:unset;cursor:pointer;font-size:10px;letter-spacing:.18em;text-transform:uppercase;opacity:.5;padding:4px 2px;border-bottom:1px solid transparent;pointer-events:auto}
    .wk-tab b{font-weight:normal;font-style:italic;text-transform:none;letter-spacing:.03em;font-size:13px;margin-left:7px;opacity:.9}
    .wk-tab[aria-selected=true]{opacity:1;border-bottom-color:rgba(var(--accent),.7)}
    .wk-tab:hover{opacity:.85}.wk-tab:focus-visible{outline:1px dotted rgba(var(--accent),.7);outline-offset:3px}
    .wk-lots{margin-left:6px}.wk-sum{font-size:11.5px;opacity:.4;text-align:center;margin-top:6px;letter-spacing:.04em;min-height:1.2em}
    #tool-moods .wk{margin-top:2px}#tool-moods .wk-tabs{justify-content:flex-start}#tool-moods .wk-sum{text-align:left}`);

  /* M6 has already put its pills on the invocation screen and in its Tools panel. Each becomes
     the first tray of a chooser. Without M6 there is still a chooser, of two. */
  const invoke = document.querySelector('#invoke');
  const there = invoke && invoke.querySelector('.moods');
  if (there) chooser(there, false);
  else if (invoke && invoke.querySelector('.hint')) { const c = chooser(null, false); invoke.querySelector('.hint').before(c.box); }
  const tool = document.querySelector('#tool-moods');
  if (tool && tool.querySelector('.moods')) {
    chooser(tool.querySelector('.moods'), true);
    tool.querySelector('summary').textContent = 'Mood · Style · Element';
    const note = tool.querySelector('.tool-note');
    if (note) note.textContent = 'The mood is how the rite feels, the style the idiom it is played in, the element what it is made of. Any three make one piece: the melody, the chords and the form are the sigil’s and are never touched. Changing one during a performance re-composes the song and resumes at the current section.';
  } else {
    UI.section({ id: 'styles', title: 'Style · Element', order: 10, build(el) { el.append(chooser(null, true).box); } });
  }

  UI.key('y', 'Cast lots: a random mood, style and element (with Shift, a rite too)', lots, { group: 'Performance', display: 'Y' });

  Hooks.on('song', sync);
  UI.whenReady(sync);

  return { setStyle, setElement, adopt, lots, tag, tagOf, words, addTab, sync, get: () => ({ style, element }) };
})();

if (typeof window !== 'undefined') window.Styles = Styles;
