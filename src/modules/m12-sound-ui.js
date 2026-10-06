'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m12 · SOUND UI — the instrument you actually play
   --------------------------------------------------------------------------
   • Ten drag-knobs: drag vertically (Shift for fine), wheel, arrows, and
     double-click to reset to this sigil's own value.
   • A live scope that draws the morphing wavetable.
   • Dream ◀ ▶: deterministic variants of the sigil's sound.
   • Patch library: save, apply, delete, import and export.
   • Play the sigil from the keyboard (X to toggle):
       home row  A S D F H J K ;   →  scale degrees 0–7
       top row   Q W E R U I O P   →  scale degrees 8–15
     Held notes sustain and release on key-up.
   • Click any letter on the wheel's HUD line to sound its note.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundUI = (() => {
  'use strict';
  const { h } = UI;

  function fmtNum(v) { return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2); }

  const KNOBS = [
    { name: 'wave',   label: 'Wave',   min: 0,  max: 8,  step: 0.01, fmt: fmtNum },
    { name: 'sweep',  label: 'Sweep',  min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { name: 'throat', label: 'Throat', min: -1, max: 1,  step: 0.01, fmt: fmtNum },
    { name: 'breath', label: 'Breath', min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { name: 'bright', label: 'Bright', min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { name: 'grit',   label: 'Grit',   min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { name: 'bits',   label: 'Bits',   min: 2,  max: 16, step: 1,    fmt: (v) => String(Math.round(v)) },
    { name: 'hold',   label: 'Hold',   min: 1,  max: 16, step: 1,    fmt: (v) => String(Math.round(v)) },
    { name: 'fold',   label: 'Fold',   min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { name: 'echo',   label: 'Echo',   min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
  ];

  /** Keyboard → scale degree. */
  const KEYMAP = { a: 0, s: 1, d: 2, f: 3, h: 4, j: 5, k: 6, ';': 7, q: 8, w: 9, e: 10, r: 11, u: 12, i: 13, o: 14, p: 15 };

  const knobs = {};
  const held = new Map();
  let scope, voiceSel, modeSel, liteBox, dreamLbl, keyBtn, libList;

  /* ── Knob ───────────────────────────────────────────────────────────── */

  function knob(def) {
    const { name, label, min, max, step, fmt } = def;
    let val = min, drag = null;
    const unit = Math.max(step, (max - min) / 80);

    const ring = h('div', { class: 'kb-ring' });
    const cap = h('div', { class: 'kb-cap' }, h('i'));
    const out = h('output', { class: 'kb-val' });
    const el = h('div', {
      class: 'kb', tabindex: '0', role: 'slider', 'aria-label': label,
      'aria-valuemin': min, 'aria-valuemax': max,
      title: `${label}: drag, wheel or arrows · Shift for fine · double-click resets`,
    }, ring, cap);
    const wrap = h('div', { class: 'kb-wrap' }, el, h('span', { class: 'kb-label' }, label), out);

    const snap = (v) => clamp(Math.round((v - min) / step) * step + min, min, max);
    const paint = () => {
      const p = (val - min) / (max - min);
      ring.style.background =
        `conic-gradient(from 225deg, rgb(var(--accent)) 0deg ${p * 270}deg, rgba(var(--line),.14) ${p * 270}deg 270deg, transparent 270deg)`;
      cap.style.transform = `rotate(${-135 + p * 270}deg)`;
      out.textContent = fmt(val);
      el.setAttribute('aria-valuenow', String(val));
    };
    const commit = (v) => {
      const nv = snap(v);
      if (nv === val) return;
      val = nv; paint();
      Sound.set(name, val);
    };

    el.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, v: val };
      el.setPointerCapture(e.pointerId);
      el.focus({ preventScroll: true });
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = e.shiftKey ? 0.2 : 1;
      commit(drag.v + ((drag.y - e.clientY) / 160) * (max - min) * k);
    });
    const endDrag = () => (drag = null);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      commit(val - Math.sign(e.deltaY) * unit * (e.shiftKey ? 1 : 4));
    }, { passive: false });
    el.addEventListener('dblclick', () => {
      const d = Sound.state().derived;
      commit(d ? d[name] : min);
    });
    el.addEventListener('keydown', (e) => {
      const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();                        // keep the Live Lens arrows out of it
      commit(val + dir * unit * (e.shiftKey ? 0.2 : 1));
    });

    return { el: wrap, set: (v) => { val = snap(v); paint(); } };
  }

  /* ── Scope: the morphing wavetable, drawn in the accent colour ──────── */

  function paintScope() {
    if (!scope) return;
    const st = Sound.state(), g = scope.getContext('2d');
    const W = scope.width, H = scope.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = rgba(renderer.pal.line, 0.12);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    if (!st.tables || !st.P) return;

    const fr = st.tables.frames, p = clamp(st.P.wave, 0, fr.length - 1);
    const a = Math.floor(p), b = Math.min(fr.length - 1, a + 1);
    const wave = SoundDesign.waveSamples(fr[a], fr[b], p - a, W);
    g.beginPath();
    for (let x = 0; x < W; x++) {
      const y = H / 2 - wave[x] * H * 0.42;
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = rgba(renderer.pal.accent, 0.95);
    g.lineWidth = 1.4;
    g.stroke();
  }

  /* ── Refresh and actions ────────────────────────────────────────────── */

  function refresh() {
    if (!voiceSel) return;
    const st = Sound.state();
    for (const d of KNOBS) if (knobs[d.name]) knobs[d.name].set(st.P ? st.P[d.name] : d.min);
    voiceSel.input.value = st.P ? st.P.voice : 'auto';
    modeSel.input.value = Sound.mode;
    liteBox.input.checked = Sound.lite;
    keyBtn.textContent = `Keys: ${Sound.keysOn ? 'on' : 'off'}`;
    dreamLbl.textContent = app.sigil && st.derived
      ? `dream ${st.variant} · ${st.derived.mult}×+${st.derived.off}`
      : 'cast to dream';
    paintScope();
  }

  function toggleKeys(force) {
    const on = Sound.toggleKeys(force);
    if (!on) { held.forEach((v) => v.release()); held.clear(); }
    toast(on ? 'Keys play the sigil: A S D F H J K ; and Q–P' : 'Keys off', true);
  }

  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Patch code copied', true));
    else prompt('Copy the patch code', text);
  }

  function renderLibrary() {
    if (!libList) return;
    libList.innerHTML = '';
    const items = Sound.library();
    if (!items.length) {
      libList.append(UI.note('No saved patches yet. Tune a sound, then save it. Patches carry tuning only, never words.'));
    }
    items.forEach((it, i) => libList.append(h('div', { class: 'lib-row' },
      h('span', { class: 'lib-name' }, it.name),
      UI.button('Apply', () => { Sound.applyLibrary(i); toast(`“${it.name}” applied`, true); }),
      UI.button('×', () => { Sound.removeLibrary(i); renderLibrary(); }, { class: 'sm ghost', 'aria-label': `Delete ${it.name}` }))));
  }

  /* ── Panel ──────────────────────────────────────────────────────────── */

  UI.css(`
    .kb-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px 6px;margin:10px 0}
    .kb-wrap{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:10px;user-select:none}
    .kb{position:relative;width:46px;height:46px;border-radius:50%;cursor:ns-resize;touch-action:none;outline:none}
    .kb:focus-visible{box-shadow:0 0 0 1px rgba(var(--accent),.7)}
    .kb-ring{position:absolute;inset:0;border-radius:50%;-webkit-mask:radial-gradient(circle,transparent 60%,#000 63%);mask:radial-gradient(circle,transparent 60%,#000 63%)}
    .kb-cap{position:absolute;inset:8px;border-radius:50%;background:rgba(var(--line),.05);border:1px solid rgba(var(--line),.18);transition:transform .08s}
    .kb-cap i{position:absolute;left:50%;top:3px;width:1.5px;height:9px;margin-left:-.75px;background:rgb(var(--accent))}
    .kb-label{opacity:.6;letter-spacing:.08em;text-transform:uppercase}
    .kb-val{font-variant-numeric:tabular-nums;opacity:.55}
    .snd-scope{width:100%;height:56px;display:block;margin:6px 0 4px}
    .dream{align-items:center}.dream-lbl{font-style:italic;opacity:.7;font-size:12.5px;min-width:9em;text-align:center}
    .lib-row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(var(--line),.06)}
    .lib-name{flex:1;font-style:italic}
    .snd-h{font-size:10.5px;letter-spacing:.3em;text-transform:uppercase;opacity:.6;margin:16px 0 4px}`);

  UI.section({ id: 'sound', title: 'Sound & Patch', order: 12, build(el) {
    const grid = h('div', { class: 'kb-grid' }, KNOBS.map((d) => {
      const k = knob(d);
      knobs[d.name] = k;
      return k.el;
    }));

    scope = h('canvas', { class: 'snd-scope', width: 240, height: 56, 'aria-hidden': 'true' });

    modeSel = UI.select({
      label: 'Engine', value: Sound.mode,
      options: [['sigil', 'Sigil · wavetable & vox'], ['legacy', 'Legacy · original voices']],
      onChange: (v) => Sound.setMode(v),
    });
    voiceSel = UI.select({
      label: 'Lead voice', value: 'auto',
      options: [['auto', 'Auto · per timbre'], ['vox', 'Vox · formant'], ['wave', 'Wavetable']],
      onChange: (v) => Sound.set('voice', v),
    });
    liteBox = UI.check({
      label: 'Lite mode (fewer oscillators, no spectrum halo)', checked: Sound.lite,
      onChange: (v) => Sound.setLite(v),
    });

    dreamLbl = h('output', { class: 'dream-lbl' });
    keyBtn = UI.button('Keys: off', () => toggleKeys(), { title: 'Play the sigil from the keyboard (X)' });
    libList = h('div', { class: 'lib' });

    const fileIn = h('input', {
      type: 'file', accept: 'application/json,.json', style: 'display:none',
      onchange: () => importFile(fileIn),
    });

    el.append(
      UI.note('Every sound here is derived from the sigil. Dream cycles deterministic variants. Knobs are remembered per sigil, and they travel in share links.'),
      grid,
      scope,
      h('div', { class: 'sgrow dream' },
        UI.button('◀ dream', () => Sound.dream(-1)),
        dreamLbl,
        UI.button('dream ▶', () => Sound.dream(1)),
        UI.button('Reset knobs', () => Sound.reset())),
      modeSel, voiceSel, liteBox,
      h('div', { class: 'sgrow' }, keyBtn, UI.button('Copy patch code', () => copy(Sound.code()))),
      h('div', { class: 'snd-h' }, 'Patch library'),
      h('div', { class: 'sgrow' },
        UI.button('Save as…', () => {
          const name = prompt('Name this patch', `patch ${Sound.library().length + 1}`);
          if (name) { Sound.save(name); renderLibrary(); toast(`saved “${name}”`, true); }
        }),
        UI.button('Export', () => download(
          new Blob([JSON.stringify({ sigilSounds: 1, patches: Sound.library() }, null, 1)], { type: 'application/json' }),
          'sigil-patches.json')),
        UI.button('Import', () => fileIn.click())),
      libList, fileIn);

    renderLibrary();
    refresh();
  } });

  async function importFile(input) {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    try {
      const n = Sound.importLibrary(JSON.parse(await f.text()));
      renderLibrary();
      toast(`${n} patch${n === 1 ? '' : 'es'} imported`, true);
    } catch { toast('That file is not a patch library', true); }
  }

  Sound.subscribe(() => { refresh(); renderLibrary(); });
  Hooks.on('cast', refresh);
  Hooks.on('song', refresh);
  UI.whenReady(refresh);

  /* ── Keyboard: play the sigil ──────────────────────────────────────── */

  UI.key('x', 'Play the sigil from the keyboard', () => toggleKeys(), { group: 'Sound', display: 'X' });
  UI.key(Object.keys(KEYMAP), 'Play scale degrees (keys on)', null,
         { group: 'Sound', display: 'A S D F H J K ; · Q–P' });

  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

  document.addEventListener('keydown', (e) => {
    if (!Sound.keysOn || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (!Object.hasOwn(KEYMAP, k) || held.has(k) || !app.song) return;
    e.preventDefault();
    const deg = KEYMAP[k];
    const v = Sound.noteOn({ midi: degToMidi(deg, app.song.leadBase, app.song.scale), deg, vel: 0.8 });
    if (v) held.set(k, v);
  });

  document.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase(), v = held.get(k);
    if (v) { v.release(); held.delete(k); }
  });

  /* ── Click a letter on the HUD to sound its node ───────────────────── */

  document.getElementById('letters').addEventListener('click', (e) => {
    const el = e.target.closest('span');
    if (!el || !app.song) return;
    // Only the primary word is playable. Partner letters carry p1/p2 or sep classes.
    if (el.classList.contains('sep') || el.classList.contains('p1') || el.classList.contains('p2')) return;
    const i = [...el.parentElement.children].indexOf(el);
    if (i < 0 || i >= app.song.chimes.length) return;
    const v = Sound.noteOn({ midi: app.song.chimes[i], deg: i, vel: 0.85 });
    if (v) setTimeout(() => v.release(), 650);
  });

  return { refresh, knobs };
})();