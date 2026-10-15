'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M4 · FORM & LOOP — section navigation and seamless section looping
   --------------------------------------------------------------------------
   ⚠ THIS MODULE REPLACES Engine.prototype.pump AND beatNow,
     and WRAPS Engine.prototype.start AND seek. See the patch-point block at
     the top of 06-engine.js. If the Engine's scheduling changes, this must
     change with it.

   Engine fields used: region {start,end,si} | null, prevAnchor, reanchorAt.

   The loop is GAPLESS: the re-anchor time is exactly the region's end time, so
   the visuals jump at precisely the sample where the audio jumps.
   ══════════════════════════════════════════════════════════════════════════ */

const Form = (() => {
  'use strict';
  const { h } = UI;
  
  /* ── Navigation ────────────────────────────────────────────────────── */

  const playing = () => app.mode === 'playing' && app.song && app.engine;
  const cur = () => (renderer.info ? renderer.info.si : 0);

  function go(si) {
    if (!playing()) return;
    const S = app.song.sections;
    si = clamp(si, 0, S.length - 1);
    app.engine.seek(S[si].start);
    UI.announce(`${S[si].roman}. ${S[si].name}`);
  }

  /** `[` restarts the current section if you are more than 2 beats into it. */
  function prev() {
    const si = cur(), b = renderer.info ? renderer.info.beat : 0;
    go(b - app.song.sections[si].start > 2 ? si : si - 1);
  }

  function loop(si = cur()) {
    if (!playing()) return;
    const e = app.engine, s = app.song.sections[si];

    if (e.region && e.region.si === si) { e.region = null; UI.announce('Loop off'); }
    else {
      const b = e.beatNow();
      if (b < s.start || b >= s.end) e.seek(s.start);   // seek first: it clears foreign regions
      e.region = { start: s.start, end: s.end, si };
      UI.announce(`Looping ${s.name}`);
    }
    sync();
  }

  /* ── UI: panel, progress band, HUD badge ───────────────────────────── */

  UI.css(`.f-row{display:grid;grid-template-columns:34px 1fr auto auto;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(var(--line),.06)}
    .f-row.cur .f-name{color:rgb(var(--accent))}
    .f-roman{font-size:11px;letter-spacing:.2em;opacity:.6}.f-name{font-style:italic;font-size:15px}
    .f-len{font-size:11px;opacity:.45;margin-left:6px;font-style:normal}
    #progress .loopband{position:absolute;top:3px;height:9px;background:rgba(var(--accent),.16);border-left:1px solid rgba(var(--accent),.7);border-right:1px solid rgba(var(--accent),.7);pointer-events:none;display:none}
    #loopBadge{margin-left:.8em;letter-spacing:.1em}`);

  const band = h('div', { class: 'loopband' });
  document.querySelector('#progress').append(band);

  const badge = h('span', { id: 'loopBadge', hidden: true, title: 'Looping this section (L)' }, '⟲');
  document.querySelector('#secInfo .roman').after(badge);

  let list;

  function build() {
    if (!list) return;
    list.innerHTML = '';
    if (!app.song) { list.append(UI.note('Cast a sigil to see its form.')); return; }

    app.song.sections.forEach((s, i) => {
      list.append(h('div', { class: 'f-row', 'data-si': i },
        h('span', { class: 'f-roman' }, s.roman),
        h('span', { class: 'f-name', title: s.desc }, s.name,
          h('span', { class: 'f-len' }, `${(s.end - s.start) / 4} bars`)),
        UI.button('▶', () => go(i), { title: `Jump to ${s.name} (${i + 1})`, 'aria-label': `Jump to ${s.name}` }),
        UI.button('⟲', () => loop(i), { title: `Loop ${s.name}`, 'aria-label': `Loop ${s.name}`,
                                        'aria-pressed': 'false', 'data-loop': i })));
    });
    sync();
  }

  function sync() {
    const reg = app.engine && app.engine.region, song = app.song;
    badge.hidden = !reg;
    band.style.display = reg && song ? 'block' : 'none';
    if (reg && song) {
      band.style.left = (reg.start / song.total) * 100 + '%';
      band.style.width = ((reg.end - reg.start) / song.total) * 100 + '%';
    }
    if (list) list.querySelectorAll('[data-loop]')
      .forEach((b) => b.setAttribute('aria-pressed', String(!!reg && reg.si === +b.dataset.loop)));
  }

  UI.section({ id: 'form', title: 'Form & Loop', order: 20, build(el) {
    list = h('div');
    el.append(UI.note('Jump between sections, or loop one for extended charging. Keys: 1–9 jump · [ ] previous/next · L loop · Shift-click the progress bar.'), list);
    build();
  } });

  Hooks.on('song', () => { if (app.engine) app.engine.region = null; build(); });
  Hooks.on('stop', () => { if (app.engine) app.engine.region = null; sync(); });
  Hooks.on('section', (s, si) => {
    if (list) list.querySelectorAll('.f-row').forEach((r) => r.classList.toggle('cur', +r.dataset.si === si));
  });
  Hooks.on('region', sync);

  // Shift-click the progress bar to loop that section. Capture phase +
  // stopImmediatePropagation so the core's plain seek handler never runs.
  document.querySelector('#progress').addEventListener('click', (e) => {
    if (!e.shiftKey || !playing()) return;
    e.stopImmediatePropagation();
    const r = e.currentTarget.getBoundingClientRect();
    loop(sectionIndexAt(app.song, clamp((e.clientX - r.left) / r.width, 0, 0.999) * app.song.total));
  }, true);

  UI.key(['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'Jump to section N', (e) => go(+e.key - 1),
         { group: 'Form', display: '1 – 9' });
  UI.key('[', 'Previous section (or restart current)', prev, { group: 'Form', display: '[' });
  UI.key(']', 'Next section', () => go(cur() + 1), { group: 'Form', display: ']' });
  UI.key('l', 'Loop / unloop the current section', () => loop(), { group: 'Form', display: 'L' });

  return { go, loop, prev };
})();