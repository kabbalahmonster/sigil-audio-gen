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
    // ── voice ──
    { group: 'voice', name: 'wave',    label: 'Wave',    min: 0,  max: 12, step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'layer',   label: 'Layer',   min: 0,  max: 8,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'tilt',    label: 'Tilt',    min: -1, max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'density', label: 'Density', min: 0,  max: 2,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'sweep',   label: 'Sweep',   min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'drift',   label: 'Drift',   min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'sub',     label: 'Sub',     min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'chorus',  label: 'Chorus',  min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'throat',  label: 'Throat',  min: -1, max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'breath',  label: 'Breath',  min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'bright',  label: 'Bright',  min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'grit',    label: 'Grit',    min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'drive',   label: 'Drive',   min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'fold',    label: 'Fold',    min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    { group: 'voice', name: 'bits',    label: 'Bits',    min: 2,  max: 16, step: 1,    fmt: fmtInt },
    { group: 'voice', name: 'hold',    label: 'Hold',    min: 1,  max: 16, step: 1,    fmt: fmtInt },
    { group: 'voice', name: 'echo',    label: 'Echo',    min: 0,  max: 1,  step: 0.01, fmt: fmtNum },
    // ── drums ──
    { group: 'drum', name: 'drums',     label: 'Kit',     min: 0, max: 1.5, step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'drumX',     label: 'Size',    min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'drumY',     label: 'Colour',  min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'kickSub',   label: 'K Sub',   min: 0, max: 1.5, step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'kickTone',  label: 'K Tone',  min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'kickDecay', label: 'K Decay', min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'kickClick', label: 'Click',   min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'snareBody', label: 'S Body',  min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'snareNoise',label: 'S Noise', min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'snareSnap', label: 'Snap',    min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'hatEdge',   label: 'Hat Edge',min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'hatLen',    label: 'Hat Len', min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'drumRoom',  label: 'Room',    min: 0, max: 1,   step: 0.01, fmt: fmtNum },
    { group: 'drum', name: 'drumDrive', label: 'Glue',    min: 0, max: 1,   step: 0.01, fmt: fmtNum },
  ];

  const KEYMAP = { a: 0, s: 1, d: 2, f: 3, h: 4, j: 5, k: 6, ';': 7, q: 8, w: 9, e: 10, r: 11, u: 12, i: 13, o: 14, p: 15 };

  const knobs = {};
  const held = new Map();
  let scope, cube, voiceSel, modeSel, liteBox, lensBox, vowBox, arcBox, verbBox, dreamLbl, keyBtn, freezeBtn, libList;

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

  /** The wavetable as a 3D surface: columns are frames, rows are layers, and
      the front edge is the actual signal, bit-crushing and all. */
  function paintScope() {
    if (!scope) return;
    const st = Sound.state(), g = scope.getContext('2d');
    const W = scope.width, H = scope.height;
    g.clearRect(0, 0, W, H);
    if (!st.tables || !st.P) return;
    const P = st.P, tb = st.tables, L = renderer.pal.line, A = renderer.pal.accent;

    const NX = SoundDesign.FX, NY = SoundDesign.FY, SAMP = 48;
    const ox = W * 0.5, oy = H * 0.72;
    const sx = (W * 0.62) / NX, sy = (H * 0.42) / NY, skew = W * 0.055;
    const px = (x, y) => ox + (x - (NX - 1) / 2) * sx + (y - (NY - 1) / 2) * skew;
    const py = (x, y) => oy - (y - (NY - 1) / 2) * sy;

    // Far layers first, so nearer ones occlude them.
    for (let y = NY - 1; y >= 0; y--) {
      const wave = SoundDesign.waveSamples(tb.grid[y][clamp(Math.round(P.wave), 0, NX - 1)], tb.grid[y][clamp(Math.round(P.wave), 0, NX - 1)], 0, SAMP);
      const near = 1 - y / (NY - 1);
      g.beginPath();
      for (let i = 0; i < SAMP; i++) {
        const x = (i / (SAMP - 1)) * (NX - 1);
        const h = wave[i] * sy * 0.55;
        const X = px(x, y), Y = py(x, y) - h;
        i ? g.lineTo(X, Y) : g.moveTo(X, Y);
      }
      const isCurrent = Math.round(clamp(P.layer, 0, NY - 1)) === y;
      g.strokeStyle = rgba(isCurrent ? A : L, isCurrent ? 0.9 : 0.1 + near * 0.18);
      g.lineWidth = isCurrent ? 1.5 : 1;
      g.stroke();
    }

    // Struts across the layers, which make the surface read as a solid.
    g.beginPath();
    for (let i = 0; i <= 8; i++) {
      const x = (i / 8) * (NX - 1);
      for (let y = 0; y < NY; y++) {
        const X = px(x, y), Y = py(x, y);
        y ? g.lineTo(X, Y) : g.moveTo(X, Y);
      }
    }
    g.strokeStyle = rgba(L, 0.12);
    g.lineWidth = 1;
    g.stroke();

    // Front edge: the real signal, with sub, drive, fold, bits and hold.
    const a = tb.cell(P.wave, P.layer), b = tb.cell(P.wave + P.sweep * 4, P.layer + P.drift * 2.5);
    const clean = SoundDesign.waveSamples(a, b, 0, W);
    const withSub = new Float32Array(W);
    let mx = 1e-9;
    for (let i = 0; i < W; i++) {
      withSub[i] = clean[i] + P.sub * 0.6 * Math.sin((2 * Math.PI * i) / W / 2);
      if (Math.abs(withSub[i]) > mx) mx = Math.abs(withSub[i]);
    }
    for (let i = 0; i < W; i++) withSub[i] /= mx;
    const wet = SoundDesign.applyFx(withSub, { bits: P.grit > 0 ? P.bits : 16, hold: P.hold, fold: P.fold, drive: P.drive, mix: P.grit });
    g.beginPath();
    for (let i = 0; i < W; i++) {
      const Y = H - 9 - wet[i] * 8;
      i ? g.lineTo(i, Y) : g.moveTo(i, Y);
    }
    g.strokeStyle = rgba(A, 0.8);
    g.lineWidth = 1.2;
    g.stroke();
  }

  /* ── Cube map: 9 × 5 cells, current position and travel vector ──────── */

  /** The cube map: 13 × 9 cells, the current cell, the travel vector, and the layer's name. */
  function paintCube() {
    if (!cube) return;
    const st = Sound.state(), g = cube.getContext('2d');
    const W = cube.width, H = cube.height, NX = SoundDesign.FX, NY = SoundDesign.FY;
    const px = (x) => 8 + (x / (NX - 1)) * (W - 16);
    const py = (y) => H - 8 - (y / (NY - 1)) * (H - 16);
    g.clearRect(0, 0, W, H);
    if (!st.P) return;
    const P = st.P;

    g.fillStyle = rgba(renderer.pal.line, 0.2);
    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) g.fillRect(px(x) - 1, py(y) - 1, 2, 2);

    const x0 = clamp(P.wave, 0, NX - 1), y0 = clamp(P.layer, 0, NY - 1);
    const x1 = clamp(x0 + P.sweep * 4, 0, NX - 1), y1 = clamp(y0 + P.drift * 2.5, 0, NY - 1);
    g.strokeStyle = rgba(renderer.pal.accent, 0.55);
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(px(x0), py(y0)); g.lineTo(px(x1), py(y1)); g.stroke();
    g.fillStyle = rgba(renderer.pal.accent, 0.95);
    g.beginPath(); g.arc(px(x0), py(y0), 3, 0, TAU); g.fill();
    g.fillStyle = rgba(renderer.pal.accent, 0.4);
    g.beginPath(); g.arc(px(x1), py(y1), 2, 0, TAU); g.fill();

    g.font = `italic 10px ${SERIF}`;
    g.textAlign = 'left';
    g.fillStyle = rgba(renderer.pal.line, 0.6);
    g.fillText(SoundDesign.LAYER_NAMES[Math.round(y0)] || '', 6, 10);
  }

  /* ── Refresh ─────────────────────────────────────────────────────────── */

  let raf = 0;

  /** Drag on the cube map to move through it. Moves are coalesced to one update per frame. */
  function attachCube(c) {
    let down = false, raf = 0, pt = null;
    const flush = () => {
      raf = 0;
      if (pt) Sound.setMany({ wave: +pt.x.toFixed(2), layer: +pt.y.toFixed(2) });
    };
    const read = (e) => {
      const r = c.getBoundingClientRect(), W = c.width, H = c.height;
      const nx = ((e.clientX - r.left) / r.width) * W, ny = ((e.clientY - r.top) / r.height) * H;
      pt = {
        x: clamp(((nx - 8) / (W - 16)) * (SoundDesign.FX - 1), 0, SoundDesign.FX - 1),
        y: clamp((1 - (ny - 8) / (H - 16)) * (SoundDesign.FY - 1), 0, SoundDesign.FY - 1),
      };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    c.style.cursor = 'crosshair';
    c.addEventListener('pointerdown', (e) => { down = true; c.setPointerCapture(e.pointerId); read(e); });
    c.addEventListener('pointermove', (e) => { if (down) read(e); });
    const up = () => { down = false; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

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
      arcBox.input.checked = Sound.arcOn;
      verbBox.input.checked = Sound.sigilVerbOn;
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
    .snd-scope{width:100%;height:110px;display:block;margin:6px 0 2px}
    .snd-cube{width:100%;height:84px;display:block;margin:0 0 6px;opacity:.9}
    .dream{align-items:center}
    .dream-lbl{font-style:italic;opacity:.7;font-size:12.5px;min-width:8em;text-align:center}
    .lib-row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(var(--line),.06)}
    .lib-name{flex:1;font-style:italic}
    .snd-h{font-size:10.5px;letter-spacing:.3em;text-transform:uppercase;opacity:.6;margin:16px 0 4px}`);

  UI.section({ id: 'sound', title: 'Sound & Patch', order: 12, build(el) {
    const mkGrid = (group) => h('div', { class: 'kb-grid' },
    KNOBS.filter((d) => d.group === group).map((d) => { const k = knob(d); knobs[d.name] = k; return k.el; }));
  const grid = mkGrid('voice');
  const drumGrid = mkGrid('drum');
    scope = h('canvas', { class: 'snd-scope', width: 280, height: 110, 'aria-hidden': 'true' });
    cube = h('canvas', { class: 'snd-cube', width: 280, height: 46, 'aria-hidden': 'true' });

    attachCube(cube);

    modeSel = UI.select({ label: 'Engine', value: Sound.mode,
      options: [['sigil', 'Sigil · cube & vox'], ['legacy', 'Legacy · original voices']],
      onChange: (v) => Sound.setMode(v) });
    voiceSel = UI.select({ label: 'Lead voice', value: 'auto',
      options: [['auto', 'Auto · per timbre'], ['vox', 'Vox · formant'], ['wave', 'Wavetable']],
      onChange: (v) => Sound.set('voice', v) });
    liteBox = UI.check({ label: 'Lite mode (fewer oscillators, simpler visuals)', checked: Sound.lite, onChange: (v) => Sound.setLite(v) });
    lensBox = UI.check({ label: 'Live Lens also sweeps the wavetable', checked: Sound.lensWave, onChange: (v) => Sound.setLensWave(v) });
    vowBox = UI.check({ label: 'Sing the vowels you struck out (this device only)', checked: Sound.vowelMemoryOn, onChange: (v) => Sound.setVowelMemory(v) });
    arcBox = UI.check({ label: 'Sound arc: the timbre follows the rite', checked: Sound.arcOn, onChange: (v) => Sound.setArc(v) });
    verbBox = UI.check({ label: 'Reverb built from the sigil’s own strokes', checked: Sound.sigilVerbOn, onChange: (v) => Sound.setSigilVerb(v) });

    dreamLbl = h('output', { class: 'dream-lbl' });
    keyBtn = UI.button('Keys: off', () => toggleKeys(), { title: 'Play the sigil from the keyboard (X)' });
    freezeBtn = UI.button('Freeze', toggleFreeze, { title: 'Pin the wavetable position (V)', 'aria-pressed': 'false' });
    libList = h('div', { class: 'lib' });
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: () => importFile(fileIn) });

    el.append(
      UI.note('The sigil is a cube: across is the path drawn letter by letter, up is its spectral character, and every note travels through it. Dream cycles variants, Mutate nudges, and your knobs travel in share links.'),
      grid, scope, cube,
      h('div', { class: 'snd-h' }, 'Drums'), drumGrid,
      h('div', { class: 'sgrow dream' },
        UI.button('◀ dream', () => Sound.dream(-1)), dreamLbl, UI.button('dream ▶', () => Sound.dream(1))),
      h('div', { class: 'sgrow' },
        UI.button('Mutate', () => Sound.mutate()), freezeBtn, UI.button('Reset knobs', () => Sound.reset())),
      modeSel, voiceSel, liteBox, lensBox, vowBox,      modeSel, voiceSel, liteBox, lensBox, vowBox, arcBox, verbBox,
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