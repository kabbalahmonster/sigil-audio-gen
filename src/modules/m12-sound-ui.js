'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m12 · SOUND UI v2
   --------------------------------------------------------------------------
   • Sixteen drag-knobs. Drag (Shift = fine), wheel, arrow keys, double-click
     resets to this sigil's own value.
   • Cube map: the 9 × 5 wavetable with the current cell and the travel vector.
   • Scope: the true signal path — blended cell, sub, drive, fold, bit-depth
     and sample-hold — with the clean wave behind it as a ghost.
   • Dream ◀ ▶, Mutate, Freeze, Reset.
   • Patch library, import and export.
   • Play the sigil: X toggles keys (A S D F H J K ; and Q–P), V freezes,
     and clicking any HUD letter sounds its note.
   Redraws are event-driven, never per frame.
   ══════════════════════════════════════════════════════════════════════════ */

const SoundUI = (() => {
  'use strict';
  const { h } = UI;

  function fmtNum(v) { return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2); }
  const fmtInt = (v) => String(Math.round(v));

  const KNOBS = [
    { name: 'wave',   label: 'Wave',   min: 0,  max: 8,   step: 0.01, fmt: fmtNum },
    { name: 'layer',  label: 'Layer',  min: 0,  max: 4,   step: 0.01, fmt: fmtNum },
    { name: 'sweep',  label: 'Sweep',  min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'drift',  label: 'Drift',  min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'sub',    label: 'Sub',    min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'chorus', label: 'Chorus', min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'throat', label: 'Throat', min: -1, max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'breath', label: 'Breath', min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'bright', label: 'Bright', min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'grit',   label: 'Grit',   min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'drive',  label: 'Drive',  min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'fold',   label: 'Fold',   min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'bits',   label: 'Bits',   min: 2,  max: 16,  step: 1,    fmt: fmtInt },
    { name: 'hold',   label: 'Hold',   min: 1,  max: 16,  step: 1,    fmt: fmtInt },
    { name: 'echo',   label: 'Echo',   min: 0,  max: 1,   step: 0.01, fmt: fmtNum },
    { name: 'drums',  label: 'Drums',  min: 0,  max: 1.5, step: 0.01, fmt: fmtNum },
  ];

  const KEYMAP = { a: 0, s: 1, d: 2, f: 3, h: 4, j: 5, k: 6, ';': 7, q: 8, w: 9, e: 10, r: 11, u: 12, i: 13, o: 14, p: 15 };

  const knobs = {};
  const held = new Map();
  let scope, cube, voiceSel, modeSel, liteBox, lensBox, vowBox, dreamLbl, keyBtn, freezeBtn, libList;

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

    el.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, v: val }; el.setPointerCapture(e.pointerId); el.focus({ preventScroll: true }); });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      commit(drag.v + ((drag.y - e.clientY) / 160) * (max - min) * (e.shiftKey ? 0.2 : 1));
    });
    const endDrag = () => (drag = null);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('wheel', (e) => { e.preventDefault(); commit(val - Math.sign(e.deltaY) * unit * (e.shiftKey ? 1 : 4)); }, { passive: false });
    el.addEventListener('dblclick', () => { const b = Sound.state().base; commit(b ? b[name] : min); });
    el.addEventListener('keydown', (e) => {
      const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!dir) return;
      e.preventDefault(); e.stopPropagation();
      commit(val + dir * unit * (e.shiftKey ? 0.2 : 1));
    });

    return { el: wrap, set: (v) => { val = snap(v); paint(); } };
  }

  /* ── Scope: the true signal path ─────────────────────────────────────── */

  function paintScope() {
    if (!scope) return;
    const st = Sound.state(), g = scope.getContext('2d');
    const W = scope.width, H = scope.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = rgba(renderer.pal.line, 0.12);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    if (!st.tables || !st.P) return;

    const P = st.P, tb = st.tables;
    const a = tb.cell(P.wave, P.layer);
    const b = tb.cell(P.wave + P.sweep * 4, P.layer + P.drift * 2.5);
    const clean = SoundDesign.waveSamples(a, b, 0.0, W);
    const target = SoundDesign.waveSamples(a, b, 1.0, W);

    // Sub-oscillator: an octave down is half a cycle across this window.
    const withSub = new Float32Array(W);
    let mx = 1e-9;
    for (let i = 0; i < W; i++) {
      const x = (2 * Math.PI * i) / W;
      withSub[i] = clean[i] + P.sub * 0.6 * Math.sin(x / 2);
      if (Math.abs(withSub[i]) > mx) mx = Math.abs(withSub[i]);
    }
    for (let i = 0; i < W; i++) withSub[i] /= mx;

    const wet = SoundDesign.applyFx(withSub, {
      bits: P.grit > 0 ? P.bits : 16, hold: P.hold, fold: P.fold, drive: P.drive, mix: P.grit,
    });

    const line = (arr, style, width) => {
      g.beginPath();
      for (let x = 0; x < W; x++) {
        const y = H / 2 - arr[x] * H * 0.42;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = style; g.lineWidth = width; g.stroke();
    };
    line(target, rgba(renderer.pal.line, 0.18), 1);     // where the travel is heading
    line(withSub, rgba(renderer.pal.line, 0.3), 1);     // clean, before the crusher
    line(wet, rgba(renderer.pal.accent, 0.95), 1.5);    // what you actually hear
  }

  /* ── Cube map: 9 × 5 cells, current position and travel vector ──────── */

  function paintCube() {
    if (!cube) return;
    const st = Sound.state(), g = cube.getContext('2d');
    const W = cube.width, H = cube.height;
    g.clearRect(0, 0, W, H);
    if (!st.P) return;
    const P = st.P;
    const px = (x) => 8 + (x / (SoundDesign.FX - 1)) * (W - 16);
    const py = (y) => H - 8 - (y / (SoundDesign.FY - 1)) * (H - 16);

    g.fillStyle = rgba(renderer.pal.line, 0.18);
    for (let y = 0; y < SoundDesign.FY; y++) {
      for (let x = 0; x < SoundDesign.FX; x++) g.fillRect(px(x) - 1, py(y) - 1, 2, 2);
    }
    const x0 = clamp(P.wave, 0, 8), y0 = clamp(P.layer, 0, 4);
    const x1 = clamp(x0 + P.sweep * 4, 0, 8), y1 = clamp(y0 + P.drift * 2.5, 0, 4);
    g.strokeStyle = rgba(renderer.pal.accent, 0.55);
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(px(x0), py(y0)); g.lineTo(px(x1), py(y1)); g.stroke();
    g.fillStyle = rgba(renderer.pal.accent, 0.95);
    g.beginPath(); g.arc(px(x0), py(y0), 3, 0, TAU); g.fill();
    g.fillStyle = rgba(renderer.pal.accent, 0.4);
    g.beginPath(); g.arc(px(x1), py(y1), 2, 0, TAU); g.fill();
  }

  /* ── Refresh ─────────────────────────────────────────────────────────── */

  let raf = 0;
  function refresh() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!voiceSel) return;
      const st = Sound.state();
      for (const d of KNOBS) if (knobs[d.name]) knobs[d.name].set(st.P ? st.P[d.name] : d.min);
      voiceSel.input.value = st.P ? st.P.voice : 'auto';
      modeSel.input.value = Sound.mode;
      liteBox.input.checked = Sound.lite;
      lensBox.input.checked = Sound.lensWave;
      vowBox.input.checked = Sound.vowelMemoryOn;
      keyBtn.textContent = `Keys: ${Sound.keysOn ? 'on' : 'off'}`;
      freezeBtn.textContent = Sound.frozen ? 'Unfreeze' : 'Freeze';
      freezeBtn.setAttribute('aria-pressed', String(Sound.frozen));
      dreamLbl.textContent = app.sigil && st.tables
        ? `dream ${st.variant} · ${st.tables.D.mult}×+${st.tables.D.off}`
        : 'cast to dream';
      paintScope(); paintCube();
    });
  }

  function toggleKeys(force) {
    const on = Sound.toggleKeys(force);
    if (!on) { held.forEach((v) => v.release()); held.clear(); }
    toast(on ? 'Keys play the sigil: A S D F H J K ; and Q–P' : 'Keys off', true);
  }
  function toggleFreeze() {
    toast(Sound.toggleFreeze() ? 'Wavetable frozen' : 'Wavetable moving again', true);
  }
  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Patch code copied', true));
    else prompt('Copy the patch code', text);
  }

  function renderLibrary() {
    if (!libList) return;
    libList.innerHTML = '';
    const items = Sound.library();
    if (!items.length) libList.append(UI.note('No saved patches yet. Tune a sound, then save it. Patches carry tuning only, never words.'));
    items.forEach((it, i) => libList.append(h('div', { class: 'lib-row' },
      h('span', { class: 'lib-name' }, it.name),
      UI.button('Apply', () => { Sound.applyLibrary(i); toast(`“${it.name}” applied`, true); }),
      UI.button('×', () => { Sound.removeLibrary(i); renderLibrary(); }, { class: 'sm ghost', 'aria-label': `Delete ${it.name}` }))));
  }

  /* ── Panel ──────────────────────────────────────────────────────────── */

  UI.css(`
    .kb-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px 6px;margin:10px 0}
    .kb-wrap{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:10px;user-select:none}
    .kb{position:relative;width:44px;height:44px;border-radius:50%;cursor:ns-resize;touch-action:none;outline:none}
    .kb:focus-visible{box-shadow:0 0 0 1px rgba(var(--accent),.7)}
    .kb-ring{position:absolute;inset:0;border-radius:50%;-webkit-mask:radial-gradient(circle,transparent 60%,#000 63%);mask:radial-gradient(circle,transparent 60%,#000 63%)}
    .kb-cap{position:absolute;inset:8px;border-radius:50%;background:rgba(var(--line),.05);border:1px solid rgba(var(--line),.18)}
    .kb-cap i{position:absolute;left:50%;top:3px;width:1.5px;height:9px;margin-left:-.75px;background:rgb(var(--accent))}
    .kb-label{opacity:.6;letter-spacing:.08em;text-transform:uppercase}
    .kb-val{font-variant-numeric:tabular-nums;opacity:.55}
    .snd-scope{width:100%;height:62px;display:block;margin:6px 0 2px}
    .snd-cube{width:100%;height:46px;display:block;margin:0 0 6px;opacity:.9}
    .dream{align-items:center}
    .dream-lbl{font-style:italic;opacity:.7;font-size:12.5px;min-width:8em;text-align:center}
    .lib-row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(var(--line),.06)}
    .lib-name{flex:1;font-style:italic}
    .snd-h{font-size:10.5px;letter-spacing:.3em;text-transform:uppercase;opacity:.6;margin:16px 0 4px}`);

  UI.section({ id: 'sound', title: 'Sound & Patch', order: 12, build(el) {
    const grid = h('div', { class: 'kb-grid' }, KNOBS.map((d) => { const k = knob(d); knobs[d.name] = k; return k.el; }));
    scope = h('canvas', { class: 'snd-scope', width: 280, height: 62, 'aria-hidden': 'true' });
    cube = h('canvas', { class: 'snd-cube', width: 280, height: 46, 'aria-hidden': 'true' });

    modeSel = UI.select({ label: 'Engine', value: Sound.mode,
      options: [['sigil', 'Sigil · cube & vox'], ['legacy', 'Legacy · original voices']],
      onChange: (v) => Sound.setMode(v) });
    voiceSel = UI.select({ label: 'Lead voice', value: 'auto',
      options: [['auto', 'Auto · per timbre'], ['vox', 'Vox · formant'], ['wave', 'Wavetable']],
      onChange: (v) => Sound.set('voice', v) });
    liteBox = UI.check({ label: 'Lite mode (fewer oscillators, simpler visuals)', checked: Sound.lite, onChange: (v) => Sound.setLite(v) });
    lensBox = UI.check({ label: 'Live Lens also sweeps the wavetable', checked: Sound.lensWave, onChange: (v) => Sound.setLensWave(v) });
    vowBox = UI.check({ label: 'Sing the vowels you struck out (this device only)', checked: Sound.vowelMemoryOn, onChange: (v) => Sound.setVowelMemory(v) });

    dreamLbl = h('output', { class: 'dream-lbl' });
    keyBtn = UI.button('Keys: off', () => toggleKeys(), { title: 'Play the sigil from the keyboard (X)' });
    freezeBtn = UI.button('Freeze', toggleFreeze, { title: 'Pin the wavetable position (V)', 'aria-pressed': 'false' });
    libList = h('div', { class: 'lib' });
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: () => importFile(fileIn) });

    el.append(
      UI.note('The sigil is a cube: across is the path drawn letter by letter, up is its spectral character, and every note travels through it. Dream cycles variants, Mutate nudges, and your knobs travel in share links.'),
      grid, scope, cube,
      h('div', { class: 'sgrow dream' },
        UI.button('◀ dream', () => Sound.dream(-1)), dreamLbl, UI.button('dream ▶', () => Sound.dream(1))),
      h('div', { class: 'sgrow' },
        UI.button('Mutate', () => Sound.mutate()), freezeBtn, UI.button('Reset knobs', () => Sound.reset())),
      modeSel, voiceSel, liteBox, lensBox, vowBox,
      h('div', { class: 'sgrow' }, keyBtn, UI.button('Copy patch code', () => copy(Sound.code()))),
      h('div', { class: 'snd-h' }, 'Patch library'),
      h('div', { class: 'sgrow' },
        UI.button('Save as…', () => {
          const name = prompt('Name this patch', `patch ${Sound.library().length + 1}`);
          if (name) { Sound.save(name); renderLibrary(); toast(`saved “${name}”`, true); }
        }),
        UI.button('Export', () => download(new Blob([JSON.stringify({ sigilSounds: 2, patches: Sound.library() }, null, 1)], { type: 'application/json' }), 'sigil-patches.json')),
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

  Sound.subscribe(refresh);
  Hooks.on('cast', refresh);
  Hooks.on('song', refresh);
  UI.whenReady(refresh);

  /* ── Keyboard ───────────────────────────────────────────────────────── */

  UI.key('x', 'Play the sigil from the keyboard', () => toggleKeys(), { group: 'Sound', display: 'X' });
  UI.key('v', 'Freeze / unfreeze the wavetable', toggleFreeze, { group: 'Sound', display: 'V' });
  UI.key(Object.keys(KEYMAP), 'Play scale degrees (keys on)', null, { group: 'Sound', display: 'A S D F H J K ; · Q–P' });

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
    const v = held.get(e.key.toLowerCase());
    if (v) { v.release(); held.delete(e.key.toLowerCase()); }
  });

  /* ── Click a HUD letter to sound its node ───────────────────────────── */

  document.getElementById('letters').addEventListener('click', (e) => {
    const el = e.target.closest('span');
    if (!el || !app.song) return;
    if (el.classList.contains('sep') || el.classList.contains('p1') || el.classList.contains('p2')) return;
    const i = [...el.parentElement.children].indexOf(el);
    if (i < 0 || i >= app.song.chimes.length) return;
    const v = Sound.noteOn({ midi: app.song.chimes[i], deg: i, vel: 0.85 });
    if (v) setTimeout(() => v.release(), 650);
  });

  return { refresh, knobs };
})();

window.SoundUI = SoundUI;