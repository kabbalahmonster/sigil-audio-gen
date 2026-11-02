'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m23 · PALETTE — who plays the sigil
   --------------------------------------------------------------------------
   WHERE THINGS LIVE
     the worlds and instruments  src/core/05j-palette.js   who is in which room, and what each is made of (pure)
     the engines                 src/dsp/sigil-voices.js   plucked strings, modal bars, analog, organ, FM, breath, fold, grains
     the mapping                 src/core/06b-compiler.js  a part dealt an instrument is written as its rows
     THIS FILE                   shows the deal, and lets the listener change it: nothing here makes a sound of its own
                                 but the short phrase that answers a choice.

   WHAT IS STEERED (patch fields: saved with the sound, carried in a shared link, the same in every render)
     pal      which deal of the palette (0 = the sigil's own)
     palOff   the cube's own voices, as they were before there was a palette
     iLead … iPerc   an instrument, by id, for a part (0 = the one dealt)

   WHAT IS HEARD after a choice is a short phrase in the song's own key, in the voice of the part: the row the
   compiler would write for it, sent to the engine as a one-shot. There is no second way of making a sound for the
   panel to disagree with the song about.
   ══════════════════════════════════════════════════════════════════════════ */

const PalettePanel = (() => {
  'use strict';
  const { h } = UI;
  const hasSound = typeof Sound !== 'undefined';
  const patch = () => (hasSound ? Sound.state().P : null);
  const ROLES = ['lead', 'alt', 'harm', 'bell', 'bass', 'arp', 'pad', 'drone', 'comp', 'perc'];
  const SHOWN_ONLY = ['tom', 'rim', 'shaker'];            // what the world brings to the kit: heard, not chosen

  let deal = null;           // the resolved palette of the song on the stage
  let listEl, worldEl, blurbEl, lineEl, varLbl, offBox, resetBtn, hearEl, det;
  const rows = new Map();    // role → { sel, play }

  /** What the compiler will play with, for the song that is loaded. */
  function current() {
    if (!app.sigil || !app.song || typeof Palette === 'undefined') return null;
    const P = patch();
    return P ? Palette.resolve(app.sigil, app.song.cfg, P) : null;
  }

  /* ── Words ───────────────────────────────────────────────────────────── */

  const roleName = (r) => Palette.ROLE_LABEL[r] || r;
  const engineName = { pluck: 'string', modal: 'struck', analog: 'analog', organ: 'organ', dx: 'FM', breath: 'breath', fold: 'fold', cloud: 'grains', cube: 'cube' };

  /** "Lead Music box · Pad Glass pad · Bass FM bass" */
  function lineOf(res) {
    return ['lead', 'pad', 'bass', 'bell'].map((r) => (res.roles[r] ? `${roleName(r)} ${res.roles[r].name}` : '')).filter(Boolean).join('  ·  ');
  }

  /* ── Choosing ────────────────────────────────────────────────────────── */

  const P0 = () => patch() || {};
  function setField(name, v) {
    if (!hasSound) return;
    if (!v) Sound.unset(name); else Sound.set(name, v);
  }
  function stepDeal(d) {
    const n = ((((P0().pal | 0) + d) % 100) + 100) % 100;
    if (P0().palOff) Sound.unset('palOff');
    setField('pal', n);
    hearSoon('lead', 380);
  }
  function choose(role, id) {
    const f = Palette.ROLE_FIELD[role];
    if (!f) return;
    if (P0().palOff) Sound.unset('palOff');
    setField(f, id | 0);
    hearSoon(role, 380);
  }
  function resetParts() {
    for (const r of ROLES) { const f = Palette.ROLE_FIELD[r]; if (f && P0()[f]) Sound.unset(f); }
  }

  /* ── Hearing ─────────────────────────────────────────────────────────── */

  let hearT = 0;
  /** After a change has reached the engine (the bridge re-plans after a beat), play the part's phrase. */
  function hearSoon(role, ms = 320) {
    clearTimeout(hearT);
    hearT = setTimeout(() => hear(role), ms);
  }
  function hear(role) {
    const eng = app.engine, res = current();
    if (!eng || !eng.isDSP || !eng.buses || !app.song || !res) { toast('Cast a sigil to hear the palette', true); return false; }
    if (eng.ctx && eng.ctx.state !== 'running') { toast('Start the performance to hear it', true); return false; }
    const rowsOf = SigilPlan.auditionRows(role, app.song, res), ctx = eng.ctx, t0 = ctx.currentTime + 0.04;
    if (hearEl) hearEl.textContent = res.roles[role] ? `${roleName(role)}: ${res.roles[role].name}` : roleName(role);
    for (const { at, row } of rowsOf) eng.trigger(row, t0 + at * eng.spb);
    return true;
  }

  /* ── Drawing ─────────────────────────────────────────────────────────── */

  function optionsFor(role, res) {
    const own = res ? Palette.WORLDS.find((w) => w.id === res.world) : null;
    const ownIds = new Set(((own && own.cast[role]) || []).map((k) => Palette.BY_KEY.get(k).id));
    const all = Palette.forRole(role, res && res.world);
    const mk = (d) => h('option', { value: String(d.id) }, `${d.name}${d.engine === 'cube' ? ' · cube' : ''}`);
    const g1 = all.filter((d) => ownIds.has(d.id)), g2 = all.filter((d) => !ownIds.has(d.id) && d.engine !== 'cube'), g3 = all.filter((d) => d.engine === 'cube' && !ownIds.has(d.id));
    return [g1.length ? h('optgroup', { label: own ? `${own.name}’s own` : 'This world' }, g1.map(mk)) : null,
      g2.length ? h('optgroup', { label: 'Elsewhere' }, g2.map(mk)) : null,
      g3.length ? h('optgroup', { label: 'The cube’s own' }, g3.map(mk)) : null];
  }

  function refresh() {
    if (!listEl) return;
    deal = current();
    const P = P0(), on = !!deal;
    for (const el of [listEl.parentElement]) el.classList.toggle('pl-idle', !on);
    if (!on) {
      worldEl.textContent = 'No sigil yet';
      blurbEl.textContent = 'Cast a sigil, and the palette that plays it will be dealt here.';
      lineEl.textContent = '';
      varLbl.textContent = 'the sigil’s own deal';
      return;
    }
    const classic = deal.classic;
    worldEl.textContent = classic ? 'The original voices' : deal.name;
    blurbEl.textContent = classic ? 'Every part sung by the wavetable cube, as the sigil always was.' : deal.blurb;
    lineEl.textContent = classic ? '' : lineOf(deal);
    varLbl.textContent = (P.pal | 0) ? `deal ${P.pal | 0}` : 'the sigil’s own deal';
    offBox.input.checked = !!P.palOff;
    let any = false;
    for (const role of ROLES) {
      const r = rows.get(role);
      if (!r) continue;
      const f = Palette.ROLE_FIELD[role], id = (P[f] | 0);
      const d = deal.roles[role];
      const sig = `${deal.world}|${role}`;
      if (r.sig !== sig) {                                        // the options depend on the world only
        r.sel.replaceChildren(h('option', { value: '0' }, ''), ...optionsFor(role, deal).filter(Boolean));
        r.sig = sig;
      }
      const dealt = Palette.deal(app.sigil, app.song.cfg, P.pal | 0).roles[role];
      r.sel.options[0].textContent = `As dealt · ${dealt ? Palette.instrument(dealt).name : '—'}`;
      r.sel.value = id && Palette.instrument(id) ? String(id) : '0';
      r.row.classList.toggle('pl-set', !!id);
      r.eng.textContent = d ? engineName[d.engine] || '' : '';
      if (id) any = true;
    }
    resetBtn.disabled = !any;
    const sh = SHOWN_ONLY.map((r) => (deal.roles[r] ? `${roleName(r)} ${deal.roles[r].name}` : '')).filter(Boolean).join(' · ');
    kitEl.textContent = sh ? `The kit brings: ${sh}.` : '';
    const said = Palette.describe(deal);
    if (said !== lastSaid && typeof renderMeta === 'function' && app.song) { lastSaid = said; renderMeta(); }
  }
  let lastSaid = '';
  let kitEl;

  UI.section({ id: 'palette', title: 'Palette · Instruments', order: 10.5, build(el, d) {
    det = d;
    UI.css(`.pl-world{font-size:19px;font-style:italic;text-align:center;margin:2px 0 2px;letter-spacing:.02em}
      .pl-blurb{font-size:12.5px;opacity:.6;font-style:italic;text-align:center;line-height:1.4;margin:0 4px 6px}
      .pl-line{font-size:11.5px;opacity:.5;text-align:center;letter-spacing:.04em;margin-bottom:8px;min-height:1.2em}
      .pl-deal{align-items:center;margin-bottom:4px}
      .pl-lbl{flex:1;min-width:6em;text-align:center;font-style:italic;opacity:.7;font-size:12.5px}
      .pl-parts{margin-top:8px;display:grid;grid-template-columns:minmax(0,1fr);gap:1px}
      .pl-row{display:grid;grid-template-columns:78px minmax(0,1fr) 28px;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid rgba(var(--line),.06)}
      .pl-row label{font-size:12.5px;opacity:.75;display:flex;flex-direction:column;line-height:1.2}
      .pl-row label small{font-size:9.5px;opacity:.55;letter-spacing:.08em;text-transform:uppercase}
      .pl-row select{width:100%;min-width:0;font-size:12.5px;padding:4px 5px}
      .pl-row button{padding:3px 0;width:28px}
      .pl-set label{color:rgb(var(--accent));opacity:1}
      .pl-idle .pl-parts,.pl-idle .pl-deal{opacity:.4;pointer-events:none}
      .pl-hear{font-size:11.5px;opacity:.55;font-style:italic;text-align:center;min-height:1.3em;margin-top:6px}
      .pl-kit{font-size:11.5px;opacity:.5;text-align:center;line-height:1.4;margin-top:2px}`);

    worldEl = h('div', { class: 'pl-world', 'aria-live': 'polite' });
    blurbEl = h('div', { class: 'pl-blurb' });
    lineEl = h('div', { class: 'pl-line' });
    varLbl = h('output', { class: 'pl-lbl', 'aria-live': 'off' });
    const prev = UI.button('◀ palette', () => stepDeal(-1), { title: 'Another company of instruments for this sigil', 'aria-label': 'Previous palette' });
    const next = UI.button('palette ▶', () => stepDeal(1), { title: 'Another company of instruments for this sigil', 'aria-label': 'Next palette' });
    offBox = UI.check({ label: 'The cube’s own voices only', checked: false,
      title: 'Every part sung by the wavetable cube, as a sigil was before there was a palette. The instruments you chose stay chosen, and come back when this is off.',
      onChange: (v) => { setField('palOff', v ? 1 : 0); if (!v) hearSoon('lead', 420); } });
    listEl = h('div', { class: 'pl-parts' });
    for (const role of ROLES) {
      const sel = h('select', { class: 'sg', 'aria-label': roleName(role), onchange: () => choose(role, +sel.value) });
      const play = UI.button('▶', () => hear(role), { title: `Hear ${roleName(role).toLowerCase()}`, 'aria-label': `Hear ${roleName(role)}` });
      const eng = h('small', {});
      const row = h('div', { class: 'pl-row' }, h('label', {}, roleName(role), eng), sel, play);
      rows.set(role, { sel, play, row, eng, sig: '' });
      listEl.append(row);
    }
    resetBtn = UI.button('Back to the dealt parts', () => resetParts(), { disabled: true, title: 'Let every part be played by the instrument it was dealt' });
    hearEl = h('div', { class: 'pl-hear', role: 'status', 'aria-live': 'polite' });
    kitEl = h('div', { class: 'pl-kit' });
    const playAll = UI.button('Hear the parts', () => {
      let t = 0;
      for (const r of ['lead', 'pad', 'bass', 'arp', 'bell', 'perc']) { setTimeout(() => hear(r), t); t += 2300; }
    }, { title: 'Each of the main parts in turn, in this song’s key' });
    el.append(
      UI.note('Who plays the sigil. Each sigil is dealt a world (a company of instruments that belong in one room) and a part for each of them: a harp, a bowed bowl, a reese bass, a shakuhachi. Choose another deal, or name any part’s instrument. Renders, stems and links all carry the choice.'),
      worldEl, blurbEl, lineEl,
      h('div', { class: 'sgrow pl-deal' }, prev, varLbl, next),
      offBox, listEl,
      h('div', { class: 'sgrow', style: 'margin-top:8px' }, resetBtn, playAll),
      hearEl, kitEl);
    refresh();
  } });

  /* ── Keeping in step, and naming it on the HUD ───────────────────────── */

  Hooks.on('song', () => refresh());
  Hooks.on('cast', () => setTimeout(refresh, 0));
  if (hasSound) Sound.subscribe(() => refresh());
  // the HUD's line names who plays, where it used to name the lead's timbre
  Hooks.on('meta', (parts) => {
    const res = current();
    if (!res || res.classic || !app.song) return parts;
    const i = parts.indexOf(TIMBRE_NAMES[app.song.leadTimbre]);
    const say = Palette.describe(res);
    if (i >= 0) parts[i] = say; else parts.splice(Math.min(2, parts.length), 0, say);
    return parts;
  }, 5);
  // Once, on a first casting: say who is playing and where to change it. (After the Motion's own tip.)
  Hooks.on('cast', () => {
    if (Prefs.get('palette.hinted', false)) return;
    Prefs.set('palette.hinted', true);
    setTimeout(() => { const r = current(); if (r && !r.classic) toast(`${r.name} plays this one · Tools → Palette`, true, 4600); }, 26000);
  });
  UI.whenReady(() => refresh());

  return { refresh, hear, state: () => deal, stepDeal, choose };
})();

if (typeof window !== 'undefined') window.PalettePanel = PalettePanel;
