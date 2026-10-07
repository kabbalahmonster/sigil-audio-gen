'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M12 · VOICE LAB — the instrument's interface
   --------------------------------------------------------------------------
   Macros, an XY pad, voice selection, effects, quality, and patch management
   (save per sigil, reset to the sigil's native voice, copy a patch link).
   All edits are live: no recompose, no interruption, because a patch only
   touches synthesis, never the score.
   ══════════════════════════════════════════════════════════════════════════ */
const VoiceLab = (() => {
  'use strict';
  const { h } = UI;

  UI.css(`
    .vl-xy{position:relative;width:100%;aspect-ratio:1.6;border:1px solid rgba(var(--line),.18);
      margin:10px 0;touch-action:none;cursor:crosshair;background:
      linear-gradient(rgba(var(--line),.05) 1px,transparent 1px) 0 0/100% 25%,
      linear-gradient(90deg,rgba(var(--line),.05) 1px,transparent 1px) 0 0/25% 100%}
    .vl-xy i{position:absolute;width:13px;height:13px;margin:-7px 0 0 -7px;border-radius:50%;
      background:rgb(var(--accent));box-shadow:0 0 16px rgba(var(--accent),.7);pointer-events:none}
    .vl-xy span{position:absolute;bottom:4px;left:6px;font-size:10px;opacity:.45;letter-spacing:.2em;text-transform:uppercase}
    .vl-xy em{position:absolute;top:4px;left:6px;font-size:10px;opacity:.45;letter-spacing:.2em;font-style:normal;text-transform:uppercase}
    .vl-wave{width:100%;height:58px;display:block;margin:6px 0 2px;border-bottom:1px solid rgba(var(--line),.1)}
    .vl-cpu{font-size:11px;opacity:.45;font-style:italic}
  `);

  let xyDot, waveCv, rows = {}, cpu;
  const P = () => Instrument.get();

  const setField = (k, v, { redraw = false } = {}) => {
    const p = P(); if (!p) return;
    p[k] = DSP.clampField(k, v);
    Instrument.set(p);
    if (redraw) drawWave();
    sync();
  };

  /* ── The waveform display: the sigil's actual single cycle. ───────────── */
  function drawWave() {
    if (!waveCv) return;
    const prof = app.engine && app.engine.profile;
    const g = waveCv.getContext('2d'), W = waveCv.width, H = waveCv.height;
    g.clearRect(0, 0, W, H);
    if (!prof) return;
    g.strokeStyle = rgba(renderer.pal.accent, 0.9);
    g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i <= prof.length; i++) {
      const v = prof[i % prof.length];
      const x = (i / prof.length) * W, y = H / 2 - v * H * 0.42;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.strokeStyle = rgba(renderer.pal.line, 0.12);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  }

  /* ── XY pad: Brightness × Grit, the two that change the character most. ── */
  function buildXY() {
    xyDot = h('i');
    const pad = h('div', { class: 'vl-xy', 'aria-label': 'Brightness and grit pad' },
      xyDot, h('em', {}, 'grit ↑'), h('span', {}, 'brightness →'));
    let dragging = false;
    const move = (e) => {
      const r = pad.getBoundingClientRect();
      const p = P(); if (!p) return;
      p.bright = clamp((e.clientX - r.left) / r.width, 0, 1);
      p.grit = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      // Grit is a macro: it drives drive + crush together, which is what the
      // ear hears as "dirt", and keeps one gesture meaningful.
      p.drive = 0.05 + p.grit * 0.7;
      p.crush = p.grit < 0.25 ? 0 : (p.grit - 0.25) * 0.9;
      Instrument.set(p);
      sync();
    };
    pad.addEventListener('pointerdown', (e) => { dragging = true; pad.setPointerCapture(e.pointerId); move(e); });
    pad.addEventListener('pointermove', (e) => dragging && move(e));
    pad.addEventListener('pointerup', () => (dragging = false));
    pad.addEventListener('pointercancel', () => (dragging = false));
    return pad;
  }

  function sync() {
    const p = P();
    if (!p || !xyDot) return;
    xyDot.style.left = p.bright * 100 + '%';
    xyDot.style.top = (1 - p.grit) * 100 + '%';
    for (const [k, row] of Object.entries(rows)) if (row.set) row.set(p[k]);
    if (rows.leadVoice) rows.leadVoice.input.value = String(Math.round(p.leadVoice));
    if (rows.engine) rows.engine.input.checked = p.engine === 1;
    if (rows.vowelSource) rows.vowelSource.input.checked = p.vowelSource === 1;
    if (rows.choirVocal) rows.choirVocal.input.checked = p.choirVocal === 1;
    if (cpu) cpu.textContent = `quality: ${Instrument.quality()} (${Instrument.tier().voices} voices, ` +
      `${Instrument.tier().unison}× unison${Instrument.tier().chorus ? ', chorus' : ''})`;
  }

  const pct = (v) => `${Math.round(v * 100)}%`;

  UI.section({ id: 'voice', title: 'Voice Lab', order: 12, open: true, build(el) {
    waveCv = h('canvas', { class: 'vl-wave', width: 640, height: 116, 'aria-hidden': 'true' });

    const macro = (key, label, title) => (rows[key] = UI.slider({
      label, title, min: 0, max: 1, step: 0.01, value: 0.5, format: pct,
      onInput: (v) => setField(key, v),
    }));

    rows.engine = UI.check({
      label: 'Sigil synthesis (off = classic voices)', checked: true,
      title: 'The sigil’s own waveform drives every melodic voice',
      onChange: (v) => setField('engine', v ? 1 : 0),
    });
    rows.leadVoice = UI.select({
      label: 'Lead', value: 0,
      options: [['0', 'Wavetable'], ['1', 'Voice (formants)'], ['2', 'Bell (FM)']],
      onChange: (v) => setField('leadVoice', +v),
    });
    rows.choirVocal = UI.check({
      label: 'Choir sings (formant harmony)', checked: true,
      onChange: (v) => setField('choirVocal', v ? 1 : 0),
    });
    rows.vowelSource = UI.check({
      label: 'Sing the vowels your desire lost', checked: false,
      title: 'Off: vowels come from the hash, so a shared sigil sounds the same for everyone',
      onChange: (v) => { setField('vowelSource', v ? 1 : 0); if (app.engine && app.sigil) app.engine.buildInstrument(app.sigil); },
    });

    cpu = h('div', { class: 'vl-cpu' });

    el.append(
      UI.note('The waveform below is your sigil’s silhouette, read as one cycle. Lead, pad and bass use the glyph, its mirror and its retrograde.'),
      waveCv,
      buildXY(),
      rows.engine, rows.leadVoice, rows.choirVocal, rows.vowelSource,
      macro('morph', 'Morph', 'Blend the mirrored waveform into the lead'),
      macro('motion', 'Motion', 'Chorus rate and depth'),
      macro('air', 'Air', 'High shelf'),
      macro('detune', 'Spread'), macro('sub', 'Sub'),
      macro('attack', 'Attack'), macro('release', 'Release'), macro('reso', 'Resonance'),
      macro('crushRate', 'Crush rate', 'Sample-rate reduction, separate from bit depth'),
      macro('chorus', 'Chorus'), macro('vibrato', 'Vibrato'), macro('breath', 'Breath'),
      h('div', { class: 'sgrow' },
        UI.button('Save to this sigil', () => { Instrument.save(); toast('Patch saved', true); }),
        UI.button('Native voice', () => { Instrument.reset(); drawWave(); sync(); }),
        UI.button('Copy patch link', copyLink)),
      UI.select({
        label: 'Quality', value: Instrument.quality(),
        options: [['auto', 'Auto'], ['low', 'Low'], ['balanced', 'Balanced'], ['high', 'High']],
        onChange: (v) => Instrument.setQuality(v),
      }),
      cpu);

    // The sliders above use a placeholder value; fix them up once a patch exists.
    for (const k of ['morph', 'motion', 'air', 'detune', 'sub', 'attack', 'release', 'reso', 'crushRate', 'chorus', 'vibrato', 'breath']) {
      const f = DSP.FIELDS[DSP.FIELD_INDEX[k]];
      rows[k].input.min = f[1]; rows[k].input.max = f[2];
      rows[k].input.step = f[2] > 1 ? 0.5 : 0.01;
    }
    sync();
  } });

  function copyLink() {
    const url = location.href.split('#')[0] + '#' + shareKey();
    const ok = () => toast('Link copied: the sigil and its voice', true);
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok).catch(() => prompt('Copy this link', url));
    else prompt('Copy this link', url);
  }

  Hooks.on('song', () => { drawWave(); sync(); });
  Hooks.on('patch', sync);
  Hooks.on('quality', sync);
  UI.key('v', 'Open the Voice Lab', () => UI.open('voice'), { group: 'Instrument', display: 'V' });

  return { sync, drawWave };
})();