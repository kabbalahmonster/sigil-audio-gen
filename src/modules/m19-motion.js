'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m19 · MOTION — the movers, shown and steered
   --------------------------------------------------------------------------
   WHERE THINGS LIVE
     who moves what   src/core/05d-motion.js   the deal and the baked curves (pure)
     the moving       src/dsp/sigil-dsp.js     §2b/§5c: the core lays the lanes over the patch
     the one table    src/core/06b-compiler.js sent to the worklet AND put in every render job
     THIS FILE        shows it, and steers it: nothing here makes a sound.

   WHAT IS SHOWN, and why it can be trusted
     Every bead, meter and ray is drawn from engine.motionNow(), which runs the
     core's own functions on the core's own table at the AUDIBLE beat and pass,
     and is laid over the core's own section row (engine.sections) by the
     core's own rule (SigilDSP.autoApply). So a bead is at the value the engine
     is using, the Sound arc included; it is not a sketch of it. There is no
     second model of the automation to drift out of step.
       knobs   m12 dresses the knob a letter has hold of: its letter, the band
               it travels this pass, and a bead travelling it (SoundUI.mark/bead)
       panel   one row per mover: the letter, what it moves and how, a meter,
               and a switch to hold it still
       wheel   a ray at each moving letter, as long as its mover is far along

   WHAT IS STEERED (all four are patch fields, so they are saved per sigil,
   travel in a shared link, and apply identically to a render)
     motion   how far the movers move (0 = nothing moves)
     evolve   how much each pass of the rite differs from the one before, on
              the stage and across the passes of a render alike
     mVar     which deal of movers (0 = the sigil's own)
     mMute    which movers are held still
   ══════════════════════════════════════════════════════════════════════════ */

const MotionPanel = (() => {
  'use strict';
  const { h } = UI;
  const hasSound = typeof Sound !== 'undefined', hasKnobs = typeof SoundUI !== 'undefined' && !!SoundUI.mark;

  const S = { rays: true, ...Prefs.get('motion', {}) };
  const save = () => Prefs.set('motion', S);

  /** The engine, if it is playing the current song and holds a lane table. */
  const live = () => {
    const e = app.engine;
    return e && e.auto && app.song && e.song === app.song && app.mode === 'playing' ? e : null;
  };
  const patch = () => (hasSound ? Sound.state().P : null);
  const reduced = () => typeof Access !== 'undefined' && Access.reduced && Access.reduced();

  /* ── What the movers are doing, this pass ────────────────────────────── */

  const st = { key: '', who: '', pass: -1, si: -1, sig: '', span: [], rest: [], marked: new Set(), now: null };
  const { AU, ASTRIDE, PSTRIDE } = SigilDSP;

  /** The resting value of mover j's column in section si: what the engine's own table holds. */
  const baseOf = (eng, j, si) => eng.sections[si * PSTRIDE + (eng.auto.lanes[j * ASTRIDE + AU.COL] | 0)];

  /**
   * The span each mover travels in this pass and this section, as VALUES of its column: found by
   * walking its curve across the section with the core's own reader and the core's own rule for
   * laying it over the resting value. Redone only when the pass, the section or an amount changes.
   */
  function spans(eng, pass, si) {
    const a = eng.auto, T = new Float64Array(3), out = [], sec = app.song.sections[si];
    const g0 = Math.max(0, Math.floor(sec.start / a.step)), g1 = Math.min(a.len - 1, Math.ceil(sec.end / a.step));
    for (let j = 0; j < a.n; j++) {
      const ln = a.meta[j], base = baseOf(eng, j, si);
      SigilDSP.autoPass(a.lanes, j, pass, eng.params.motion ?? 1, eng.params.evolve ?? 0, T);
      let lo = base, hi = base;
      if (T[0] !== 0 || T[2] !== 0) {
        lo = Infinity; hi = -Infinity;
        for (let g = g0; g <= g1; g++) {
          const c = T[0] !== 0 ? SigilDSP.autoCurve(a.curves, a.len, a.step, j, g * a.step, T[1]) : 0;
          const v = SigilDSP.autoApply(base, c * T[0] + T[2], ln.lo, ln.hi);
          if (v < lo) lo = v; if (v > hi) hi = v;
        }
      }
      out.push({ lo, hi, base, depth: T[0], shift: T[2] });
    }
    return out;
  }

  /** Why a mover is not moving just now, or '' if it is. */
  function restingWhy(ln, sp) {
    if (ln.resting) return ln.why;
    if (ln.gate && sp && sp.base === 0) return `${ln.label} is off in this patch`;
    if (sp && sp.depth === 0 && sp.shift === 0) {
      return ln.latent ? 'asleep: it wakes as the rite repeats' : 'Motion is at zero';
    }
    return '';
  }

  /** Bring every view in line with the table, the pass, the section and the amounts. Cheap; called on change, not per frame. */
  function sync(force) {
    const eng = live();
    if (!eng || !eng.sections) {
      if (st.key) { undress(); st.key = ''; st.who = ''; st.sig = ''; st.pass = -1; st.si = -1; st.now = null; renderRows(); showPass(); renderMeta(); }
      return;
    }
    const pass = eng.passNow(), si = sectionIndexAt(app.song, eng.beatNow());
    // The section table is resent on every knob move, so its values for this section are part of the signature.
    const sig = `${eng.auto.key}|${pass}|${si}|${eng.params.motion}|${eng.params.evolve}|${eng.auto.meta.map((_, j) => baseOf(eng, j, si)).join(',')}`;
    if (!force && sig === st.sig) return;
    // The rows are rebuilt only when the movers themselves are different ones (a new sigil or deal).
    // Holding one still changes the table but not who is in it, and must not take the focus away.
    const who = eng.auto.meta.map((l) => l.name + l.letter).join(' ');
    const newSong = eng.auto.key.split('|')[0] !== st.key.split('|')[0];
    const newTable = who !== st.who, newPass = pass !== st.pass && st.pass >= 0 && !newSong;
    st.key = eng.auto.key; st.who = who; st.sig = sig; st.pass = pass; st.si = si;
    st.span = spans(eng, pass, si);
    st.rest = eng.auto.meta.map((ln, j) => restingWhy(ln, st.span[j]));

    if (hasKnobs) {
      const names = new Set(eng.auto.meta.map((l) => l.name));
      for (const nm of st.marked) if (!names.has(nm)) SoundUI.mark(nm, null);
      st.marked = names;
      eng.auto.meta.forEach((ln, j) => {
        const d = Motion.describe(ln), why = st.rest[j];
        SoundUI.mark(ln.name, { letter: ln.letter, what: d.what, who: d.who, resting: !!why, why });
      });
    }
    if (newTable) renderRows(); else updateRows();
    showPass();
    if (newPass) {
      renderMeta();
      UI.announce(pass > 0 ? `The rite begins again: pass ${pass + 1}.` : 'The rite begins again.');
    }
  }

  function undress() {
    if (hasKnobs) for (const nm of st.marked) SoundUI.mark(nm, null);
    st.marked = new Set();
  }

  /* ── Every frame: read the movers once, and move what can be seen ────── */

  let det = null, rows = [], passLbl = null, listEl = null, varLbl = null, varInfo = null;
  let motionRow = null, evolveRow = null, prevBtn = null, nextBtn = null, freeBtn = null, raysBox = null;

  const panelOpen = () => {
    const dr = document.getElementById('drawer');
    return !!(det && det.open && dr && dr.classList.contains('open'));
  };

  Hooks.on('frame', (F) => {
    const eng = live();
    if (!eng || !eng.sections) { if (st.key) sync(); return; }
    if (eng.passNow() !== st.pass || eng.auto.key !== st.key || sectionIndexAt(app.song, F.beat) !== st.si) sync();
    st.now = eng.motionNow();                       // one reading per frame, shared by the knobs, the rows and the wheel
    const still = reduced(), knobs = hasKnobs && SoundUI.visible(), list = panelOpen();
    const meta = eng.auto.meta;
    for (let j = 0; j < meta.length; j++) {
      const ln = meta[j], sp = st.span[j], m = st.now[j];
      if (!sp || !m) continue;
      // Where the engine has this column now. A listener who has asked for less motion is shown the
      // span, and the bead at rest in the middle of it.
      const v = still ? (sp.lo + sp.hi) / 2 : SigilDSP.autoApply(sp.base, m.off, ln.lo, ln.hi), w = sp.hi - sp.lo;
      m.value = v;
      m.u = w > 1e-9 ? clamp((v - sp.lo) / w, 0, 1) : 0.5;     // how far along its travel, 0…1
      if (knobs) SoundUI.bead(ln.name, v, sp.lo, sp.hi);
      if (list && rows[j]) {
        const px = Math.round(m.u * 480) / 10;
        if (rows[j].px !== px) { rows[j].px = px; rows[j].bead.style.transform = `translateX(${px}px)`; }
      }
    }
  });

  /* ── The wheel: a ray at each letter that is moving something ────────── */

  Hooks.on('drawPlaying', ({ r, F, T, lines }) => {
    const eng = live();
    if (!S.rays || !eng || !st.now || app.charging) return;      // Charge is the sigil alone
    const meta = eng.auto.meta;
    for (let j = 0; j < meta.length; j++) {
      const m = st.now[j];
      if (!m || st.rest[j] || m.u === undefined) continue;
      const u = m.u;
      const [x0, y0] = polar(meta[j].slot, 1.225, T, F), [x1, y1] = polar(meta[j].slot, 1.235 + 0.085 * u, T, F);
      const pts = [x0, y0, x1, y1];
      r.strokeGlow(pts, r.pal.accent, 0.28 + 0.42 * u, 1.1);
      r.circle(x1, y1, 1.5, r.pal.accent, 0.55 + 0.4 * u, true);
      lines.push(pts);                                           // so that Forget burns them too
    }
  });

  Hooks.on('meta', (parts) => {
    const eng = live();
    if (eng && st.pass > 0) parts.push(`pass ${st.pass + 1}`);
  });

  /* ── Steering ────────────────────────────────────────────────────────── */

  const pct = (v) => `${Math.round(v * 100)}%`;
  const setField = (name, v, rest) => {
    if (!hasSound || !app.sigil) return;
    if (v === rest) Sound.unset(name); else Sound.set(name, v);
  };

  /** Another deal of movers for this sigil. The held-still switches belong to a deal, so they are let go. */
  function step(d) {
    const P = patch();
    if (!P || !app.sigil) return;
    const n = mod((P.mVar | 0) + d, 100);
    if (P.mMute) Sound.unset('mMute');
    setField('mVar', n, 0);
    const eng = live();
    if (eng) UI.announce(`Motion ${n}: ${eng.auto.meta.filter((l) => !l.latent).map((l) => l.label).join(', ')} move.`);
  }

  function hold(j) {
    const P = patch();
    if (!P) return;
    setField('mMute', ((P.mMute | 0) ^ (1 << j)) & 255, 0);
  }

  /* ── Panel ───────────────────────────────────────────────────────────── */

  function showPass() {
    if (!passLbl) return;
    const eng = live();
    if (!eng) { passLbl.textContent = 'Cast a sigil to see what moves.'; return; }
    const p = st.pass, ev = eng.params.evolve ?? 0;
    const grown = Math.round(SigilDSP.autoTrend(p) * ev * 100);
    passLbl.textContent = p <= 0 ? 'pass 1 · the rite as written'
      : ev > 0 ? `pass ${p + 1} · ${grown}% evolved` : `pass ${p + 1} · Evolution is at zero, so it is the first again`;
  }

  function updateRows() {
    const eng = live();
    if (!eng) return;
    eng.auto.meta.forEach((ln, j) => {
      const row = rows[j];
      if (!row) return;
      const d = Motion.describe(ln), why = st.rest[j] || '';
      row.el.classList.toggle('mo-rest', !!why);
      row.what.textContent = why || d.what.slice(ln.label.length + 1);
      row.holdBtn.setAttribute('aria-pressed', String(!!ln.muted));
      row.holdBtn.textContent = ln.muted ? 'held' : 'hold';
    });
    if (freeBtn) freeBtn.disabled = !eng.auto.meta.some((l) => l.muted);
  }

  function renderRows() {
    if (!listEl) return;
    listEl.innerHTML = '';
    rows = [];
    const eng = live(), P = patch();
    prevBtn.disabled = nextBtn.disabled = !eng;
    if (!eng) { varLbl.textContent = 'cast to move'; varInfo.textContent = ''; if (freeBtn) freeBtn.disabled = true; return; }
    const meta = eng.auto.meta, active = meta.filter((l) => !l.latent).length, asleep = meta.length - active;
    varLbl.textContent = `motion ${P ? P.mVar | 0 : 0}`;
    varInfo.textContent = `${active} letters move the sound` + (asleep ? ` · ${asleep} more wake as the rite repeats` : '');
    meta.forEach((ln, j) => {
      const d = Motion.describe(ln);
      const bead = h('i');
      const what = h('span', { class: 'mo-what' });
      const name = h('button', { class: 'mo-name', type: 'button', title: `Show the ${ln.label} knob`,
        'aria-label': `${ln.label}, ${d.who}. Show its knob`,
        onclick: () => { if (hasKnobs) SoundUI.show(ln.name); } }, ln.label);
      const holdBtn = UI.button('hold', () => hold(j), { class: 'sm mo-hold', 'aria-pressed': 'false',
        title: `Hold ${ln.label} still (it stays where its knob is set)`, 'aria-label': `Hold ${ln.label} still` });
      const el = h('div', { class: 'mo-row' + (ln.latent ? ' mo-latent' : ''), title: `${d.what}; ${d.later}.` },
        h('span', { class: 'mo-by', 'aria-hidden': 'true' }, ln.letter),
        h('div', { class: 'mo-txt' }, name, what),
        h('div', { class: 'mo-meter', 'aria-hidden': 'true' }, bead),
        holdBtn);
      listEl.append(el);
      rows.push({ el, bead, what, holdBtn, px: -1 });
    });
    updateRows();
  }

  function refresh() {
    if (!motionRow) return;
    const P = patch();
    motionRow.set(P ? P.motion ?? 1 : 1);
    evolveRow.set(P ? P.evolve ?? 0.5 : 0.5);
    motionRow.input.disabled = evolveRow.input.disabled = !P || !app.sigil;
    raysBox.input.checked = S.rays;
    if (varLbl && P && live()) varLbl.textContent = `motion ${P.mVar | 0}`;
  }

  UI.section({ id: 'motion', title: 'Motion', order: 13, build(el, d) {
    det = d;
    UI.css(`.mo-pass{text-align:center;font-style:italic;opacity:.7;font-size:12.5px;margin:2px 0 8px}
      .mo-var{align-items:center}.mo-lbl{flex:1;min-width:6em;text-align:center;font-style:italic;opacity:.7;font-size:12.5px}
      .mo-info{text-align:center;margin-top:-2px}
      .mo-row{display:grid;grid-template-columns:20px 1fr 54px auto;gap:9px;align-items:center;padding:7px 0;border-bottom:1px solid rgba(var(--line),.06)}
      .mo-by{font-style:italic;font-size:19px;text-align:center;color:rgb(var(--accent))}
      .mo-txt{display:flex;flex-direction:column;min-width:0}
      .mo-name{all:unset;cursor:pointer;font-size:14px;letter-spacing:.04em;border-bottom:1px dotted rgba(var(--line),.28);align-self:flex-start;pointer-events:auto}
      .mo-name:hover,.mo-name:focus-visible{color:rgb(var(--accent));border-bottom-color:rgb(var(--accent))}
      .mo-name:focus-visible{outline:1px dotted rgba(var(--accent),.7);outline-offset:3px}
      .mo-what{font-size:12px;opacity:.55;font-style:italic;line-height:1.35}
      .mo-meter{position:relative;height:14px}
      .mo-meter::before{content:'';position:absolute;left:3px;right:3px;top:6.5px;height:1px;background:rgba(var(--line),.22)}
      .mo-meter i{position:absolute;left:0;top:4px;width:6px;height:6px;border-radius:50%;background:rgb(var(--accent));box-shadow:0 0 7px rgba(var(--accent),.9);will-change:transform}
      .mo-hold{padding:4px 8px}
      .mo-rest .mo-by,.mo-rest .mo-name{opacity:.4}.mo-rest .mo-meter i{display:none}
      .mo-latent .mo-by::after{content:'·';opacity:.6}`);

    passLbl = h('div', { class: 'mo-pass', role: 'status', 'aria-live': 'off' });
    motionRow = UI.slider({ label: 'Motion', min: 0, max: 2, step: 0.01, value: 1, format: pct,
      title: 'How far the movers move. At zero nothing moves, and the sound is the patch alone',
      onInput: (v) => setField('motion', v, 1) });
    evolveRow = UI.slider({ label: 'Evolution', min: 0, max: 1, step: 0.01, value: 0.5, format: pct,
      title: 'How much each pass of the rite differs from the one before: on the stage as it loops, and across the passes of a render',
      onInput: (v) => setField('evolve', v, 0.5) });

    varLbl = h('output', { class: 'mo-lbl', 'aria-live': 'off' });
    varInfo = UI.note(''); varInfo.classList.add('mo-info');
    prevBtn = UI.button('◀ motion', () => step(-1), { title: 'Another deal of movers for this sigil', 'aria-label': 'Previous motion' });
    nextBtn = UI.button('motion ▶', () => step(1), { title: 'Another deal of movers for this sigil', 'aria-label': 'Next motion' });
    listEl = h('div', { class: 'mo-list' });
    freeBtn = UI.button('Let all move', () => { if (hasSound) Sound.unset('mMute'); }, { disabled: true, title: 'Release every mover that is held still' });
    raysBox = UI.check({ label: 'Show the movers on the wheel', checked: S.rays,
      title: 'A ray at each letter that is moving something, as long as its mover is far along',
      onChange: (v) => { S.rays = v; save(); } });

    el.append(
      UI.note('The sigil’s letters move the knobs, in time with the pen. Liquids move the wave, fricatives the air, nasals the body, plosives the kit. Each time the rite comes round they move a little differently. A render, whole or in stems, moves exactly as the stage does.'),
      passLbl, motionRow, evolveRow,
      h('div', { class: 'sgrow mo-var' }, prevBtn, varLbl, nextBtn),
      varInfo, listEl,
      h('div', { class: 'sgrow' }, freeBtn),
      raysBox);
    renderRows(); refresh(); showPass();
  } });

  /* ── Keeping in step ─────────────────────────────────────────────────── */

  Hooks.on('motion', () => sync(true));                 // the engine holds a new table (06b motionSync)
  Hooks.on('song', () => { sync(true); refresh(); });
  // Once, on a first casting: say that the knobs are being moved and where to look. (After the Lens's own tip.)
  Hooks.on('cast', () => {
    if (Prefs.get('motion.hinted', false)) return;
    Prefs.set('motion.hinted', true);
    setTimeout(() => { if (live()) toast('The letters are moving the sound · Tools → Motion', true, 4600); }, 16000);
  });
  Hooks.on('stop', () => setTimeout(() => sync(true), 0));
  Hooks.on('forget', () => setTimeout(() => sync(true), 7200));
  if (hasSound) Sound.subscribe(() => { refresh(); setTimeout(() => sync(), 0); });   // after the bridge (m18) has told the engine
  UI.whenReady(() => { refresh(); sync(true); });

  return { step, hold, sync, state: () => st, settings: S };
})();

if (typeof window !== 'undefined') window.MotionPanel = MotionPanel;
