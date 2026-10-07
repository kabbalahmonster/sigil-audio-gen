'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m14 · STEMS & EVOLVE (smooth edition)
   --------------------------------------------------------------------------
   STEMS   one 24-bit WAV per bus, each with every other bus silenced
   EVOLVE  each pass is a later dream, drifting brighter and grittier, and
           passes are joined with an equal-power crossfade

   The WAV writer runs in blocks of 256 k samples and yields between them, so
   the main thread never stalls for long. Requires the renderSong(opts) edit in
   m7 (see §1b of the changelog).
   ══════════════════════════════════════════════════════════════════════════ */

const RenderPlus = (() => {
  'use strict';
  const { h } = UI;

  const STEMS = [
    ['lead', 'Lead'], ['harm', 'Choir'], ['bell', 'Bells'], ['pad', 'Pad'],
    ['bass', 'Bass'], ['arp', 'Arpeggio'], ['drums', 'Drums'], ['drone', 'Drone'],
  ];
  const XF = 0.15;
  const BLOCK = 1 << 18;

  const S = { passes: 3, spread: 1, stems: Object.fromEntries(STEMS.map(([k]) => [k, true])), ...Prefs.get('renderplus', {}) };
  const save = () => Prefs.set('renderplus', S);

  let activeStem = null;
  let busy = false, bar, status, evolveBtn, stemBtn, info;

  /* Silence every other bus. Priority 100 runs after the Mixer and Sound. */
  Hooks.on('buses', (buses) => {
    if (!activeStem) return;
    for (const k of Object.keys(buses)) if (k !== activeStem) buses[k].gain.value = 0;
  }, 100);

  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  const setBar = (f) => (bar.firstChild.style.width = `${Math.round(clamp(f, 0, 1) * 100)}%`);

  function specForPass(p) {
    const st = Sound.state();
    const k = S.passes > 1 ? p / (S.passes - 1) : 0;
    const P = st.P || {};
    return {
      variant: mod((st.variant || 0) + p * S.spread, 100),
      o: {
        bright: clamp((P.bright ?? 0.5) * (0.75 + 0.5 * k), 0, 1),
        grit: clamp((P.grit ?? 0) + 0.25 * k, 0, 1),
        sweep: clamp((P.sweep ?? 0.5) * (0.7 + 0.7 * k), 0, 1),
        drift: clamp((P.drift ?? 0.3) + 0.3 * k, 0, 1),
        chorus: clamp((P.chorus ?? 0.3) + 0.25 * k, 0, 1),
      },
    };
  }

  async function renderEvolved(song, sr, onProgress) {
    const out = [];
    for (let p = 0; p < S.passes; p++) {
      Sound.setRenderSpec(specForPass(p));
      // Passes are sequential on purpose: each one has its own patch.
      // eslint-disable-next-line no-await-in-loop
      const r = await Render.renderSong(song, sr, (f) => onProgress((p + f) / S.passes), { loops: 1 });
      out.push(r);
      await yieldNow();
    }
    Sound.clearRenderSpec();

    const tailN = Math.round(7 * sr);
    const passN = out[0].L.length - tailN;
    const xfN = Math.round(XF * sr);
    const total = passN * (S.passes - 1) + out[out.length - 1].L.length;
    const L = new Float32Array(total), R = new Float32Array(total);

    for (let p = 0; p < out.length; p++) {
      const pos = p * passN, src = out[p];
      const n = Math.min(src.L.length, total - pos);
      for (let i = 0; i < n; i++) {
        if (p > 0 && i < xfN) {
          const w = i / xfN;
          const a = Math.cos(w * Math.PI * 0.5), b = Math.sin(w * Math.PI * 0.5);
          L[pos + i] = L[pos + i] * a + src.L[i] * b;
          R[pos + i] = R[pos + i] * a + src.R[i] * b;
        } else {
          L[pos + i] = src.L[i];
          R[pos + i] = src.R[i];
        }
      }
    }
    return { L, R, sr, segments: out.length };
  }

  function peakNormalise(r, target = 0.891) {
    let peak = 0;
    for (let i = 0; i < r.L.length; i++) {
      const a = Math.abs(r.L[i]), b = Math.abs(r.R[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    if (!peak) return;
    const g = target / peak;
    for (let i = 0; i < r.L.length; i++) { r.L[i] *= g; r.R[i] *= g; }
  }

  /** Stereo WAV in blocks. Yields between blocks, so the page keeps responding. */
  async function wavBlob(r, bits = 24) {
    const n = r.L.length, bps = bits / 8, dataLen = n * 2 * bps;
    const buf = new ArrayBuffer(44 + dataLen);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    const str = (o, s) => { for (let k = 0; k < 4; k++) u8[o + k] = s.charCodeAt(k); };

    str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, r.sr, true); dv.setUint32(28, r.sr * 2 * bps, true);
    dv.setUint16(32, 2 * bps, true); dv.setUint16(34, bits, true);
    str(36, 'data'); dv.setUint32(40, dataLen, true);

    const full = bits === 24 ? 8388608 : 32768;
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let o = 44;
    const put = (x) => {
      x += (rnd() - rnd()) / full;                 // TPDF dither
      if (x < -1) x = -1; else if (x > 1) x = 1;
      const v = Math.round(x < 0 ? x * full : x * (full - 1));
      if (bits === 24) { u8[o] = v & 255; u8[o + 1] = (v >> 8) & 255; u8[o + 2] = (v >> 16) & 255; o += 3; }
      else { dv.setInt16(o, v, true); o += 2; }
    };

    for (let i0 = 0; i0 < n; i0 += BLOCK) {
      const i1 = Math.min(n, i0 + BLOCK);
      for (let i = i0; i < i1; i++) { put(r.L[i]); put(r.R[i]); }
      await yieldNow();
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function go(mode) {
    if (busy || !app.song) return;
    busy = true;
    bar.classList.add('busy');
    setBar(0);
    const t0 = performance.now();
    const list = mode === 'stems' ? STEMS.filter(([k]) => S.stems[k]) : [[null, 'Mix']];

    try {
      for (let i = 0; i < list.length; i++) {
        const [busKey, label] = list[i];
        activeStem = busKey;
        status.textContent = `Rendering ${label}…`;
        await yieldNow();
        const prog = (f) => { bar.classList.remove('busy'); setBar((i + f * 0.9) / list.length); };
        const r = S.passes <= 1 && mode === 'stems'
          ? await Render.renderSong(app.song, 44100, prog, { loops: 1 })
          : await renderEvolved(app.song, 44100, prog);
        peakNormalise(r);
        status.textContent = `Encoding ${label}…`;
        const blob = await wavBlob(r, 24);
        download(blob, `sigil-${UI.fileKey()}${busKey ? '-' + busKey : '-evolved'}.wav`);
        setBar((i + 1) / list.length);
        await yieldNow();
      }
      status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      UI.announce('Render complete.');
    } catch (e) {
      console.error('[render+]', e);
      status.textContent = 'Failed: ' + (e.message || e);
    } finally {
      activeStem = null;
      Sound.clearRenderSpec();
      busy = false;
      bar.classList.remove('busy');
      refresh();
    }
  }

  function refresh() {
    if (!evolveBtn) return;
    const on = !!app.song && !busy;
    evolveBtn.disabled = !on;
    stemBtn.disabled = !on;
    info.textContent = app.song
      ? `${S.passes} pass${S.passes === 1 ? '' : 'es'}, each a dream ${S.spread} further on. Stems are 24-bit WAV, one file per bus.`
      : 'Cast a sigil to render.';
  }

  UI.section({ id: 'renderplus', title: 'Stems & Evolve', order: 46, build(el) {
    bar = h('div', { class: 'sgbar' }, h('i'));
    status = UI.note('');
    info = UI.note('');
    evolveBtn = UI.button('Render evolving mix', () => go('mix'), { disabled: true });
    stemBtn = UI.button('Render stems', () => go('stems'), { disabled: true });

    el.append(
      UI.note('Evolve renders each pass as a later dream, drifting brighter and grittier, then joins them into one piece. Stems give every bus its own file for a DAW.'),
      UI.select({ label: 'Passes', value: S.passes, options: [['1', 'One'], ['2', 'Two'], ['3', 'Three'], ['4', 'Four']], onChange: (v) => { S.passes = +v; save(); refresh(); } }),
      UI.select({ label: 'Dream step', value: S.spread, options: [['1', 'Next dream'], ['2', 'Every second'], ['3', 'Every third'], ['7', 'Every seventh']], onChange: (v) => { S.spread = +v; save(); refresh(); } }),
      info,
      h('div', { class: 'sgrow' }, STEMS.map(([k, label]) =>
        UI.check({ label, checked: S.stems[k], onChange: (v) => { S.stems[k] = v; save(); } }))),
      h('div', { class: 'sgrow' }, evolveBtn, stemBtn),
      bar, status);
    refresh();
  } });

  Hooks.on('song', refresh);
  return { specForPass };
})();

window.RenderPlus = RenderPlus;