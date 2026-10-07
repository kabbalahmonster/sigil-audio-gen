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
  // Declare the Engine methods this module replaces or wraps (see 06-engine.js §6.8).
  Engine.claim('start', 'M4 Form');
  Engine.claim('seek', 'M4 Form');
  Engine.claim('pump', 'M4 Form');
  Engine.claim('beatNow', 'M4 Form');
  /** Binary search: index of the first event with beat ≥ b. */
  function firstAt(events, b) {
    let lo = 0, hi = events.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (events[m].beat < b) lo = m + 1; else hi = m; }
    return lo;
  }

  /* ── Transport overrides ───────────────────────────────────────────── */

  const _start = Engine.prototype.start;
  Engine.prototype.start = function (lead) { this.region = null; return _start.call(this, lead); };

  const _seek = Engine.prototype.seek;
  Engine.prototype.seek = function (beat) {
    // Seeking outside the loop region cancels the loop.
    if (this.region && (beat < this.region.start || beat >= this.region.end)) { this.region = null; sync(); }
    _seek.call(this, beat);
    this.reanchorAt = 0;
  };

  /**
   * REPLACEMENT for Engine.prototype.pump, with region looping and an adaptive
   * horizon. The old 0.18 s lookahead was too tight: one long frame (a render,
   * a GC, a panel redraw) would let the playhead pass a booked event, which is
   * what the gaps were. 0.4 s of slack costs nothing and removes them.
   */
  Engine.prototype.pump = function () {
    if (!this.running || !this.buses) return;

    const c = this.ctx;
    const horizon = c.currentTime + (document.hidden ? 2.5 : 0.4);
    const total = this.song.total, totalSec = total * this.spb;

    for (let guard = 0; guard < 6000; guard++) {
      const reg = this.region, ev = this.events[this.ptr];

      if (reg && (!ev || ev.beat >= reg.end)) {
        const tEnd = this.anchor + (this.loopIndex * total + reg.end) * this.spb;
        if (tEnd > horizon) break;
        this.prevAnchor = this.anchor;
        this.reanchorAt = tEnd;
        this.anchor += (reg.end - reg.start) * this.spb;
        this.ptr = firstAt(this.events, reg.start);
        continue;
      }

      if (!ev) {
        if (this.anchor + (this.loopIndex + 1) * totalSec > horizon) break;
        this.loopIndex++; this.ptr = 0; continue;
      }

      const t = this.anchor + (this.loopIndex * total + ev.beat) * this.spb;
      if (t > horizon) break;
      // A late event is nudged forward rather than dropped, so a stall during
      // a render causes a small smear instead of a silent bar.
      if (t >= c.currentTime - 0.12) this.play(ev, Math.max(t, c.currentTime + 0.005));
      this.ptr++;
    }
  };

  /** REPLACEMENT for Engine.prototype.beatNow, honouring the pending re-anchor. */
  Engine.prototype.beatNow = function () {
    if (!this.song) return 0;
    const now = this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    const a = this.reanchorAt && now < this.reanchorAt ? this.prevAnchor : this.anchor;
    const b = (now - a) / this.spb;
    return b < 0 ? 0 : b % this.song.total;
  };

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