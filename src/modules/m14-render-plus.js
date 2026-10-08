'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m14 · STEMS & EVOLVE — built on top of m7's renderer
   --------------------------------------------------------------------------
   STEMS   Renders once per bus with every other bus silenced, and downloads
           one file each. The silencing happens in a 'buses' hook at priority
           100, so it runs after the Mixer and after Sound's attachment.

   EVOLVE  Renders each pass with a later dream variant and a gentle macro
           drift, then concatenates the passes with a short equal-power
           crossfade. A three-pass render becomes a three-act piece.

   Requires one small edit in m7 (see the instructions) so renderSong can take
   { loops } rather than always using the panel's value.
   ══════════════════════════════════════════════════════════════════════════ */

const RenderPlus = (() => {
  'use strict';
  const { h } = UI;

  const STEMS = [
    ['lead', 'Lead'], ['harm', 'Choir'], ['bell', 'Bells'], ['pad', 'Pad'],
    ['bass', 'Bass'], ['arp', 'Arpeggio'], ['drums', 'Drums'], ['drone', 'Drone'],
  ];
  const XF = 0.15;   // seconds of crossfade between evolved passes

  const S = { passes: 3, spread: 1, stems: Object.fromEntries(STEMS.map(([k]) => [k, true])), ...Prefs.get('renderplus', {}) };
  const save = () => Prefs.set('renderplus', S);

  let activeStem = null;   // null = full mix
  let busy = false, bar, status, evolveBtn, stemBtn, info;

  /** Silence every bus except the active stem, offline contexts only. */
    Hooks.on('buses', (buses, eng) => {
      if (!activeStem || !app.engine || eng === app.engine) return;
      for (const k of Object.keys(buses)) if (k !== activeStem) buses[k].gain.value = 0;
    }, 100);

  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const setBar = (f) => (bar.firstChild.style.width = `${Math.round(clamp(f, 0, 1) * 100)}%`);

  /** The patch for pass `p`: a later dream, drifting brighter and grittier. */
  function specForPass(p) {
    const st = Sound.state();
    const k = S.passes > 1 ? p / (S.passes - 1) : 0;
    return {
      variant: mod(st.variant + p * S.spread, 100),
      o: {
        bright: clamp((st.P.bright ?? 0.5) * (0.75 + 0.5 * k), 0, 1),
        grit: clamp((st.P.grit ?? 0) + 0.25 * k, 0, 1),
        sweep: clamp((st.P.sweep ?? 0.5) * (0.7 + 0.7 * k), 0, 1),
        drift: clamp((st.P.drift ?? 0.3) + 0.3 * k, 0, 1),
        chorus: clamp((st.P.chorus ?? 0.3) + 0.25 * k, 0, 1),
      },
    };
  }

  /** Render `passes` passes, each with its own spec, and stitch them together. */
  async function renderEvolved(song, sr, onProgress) {
    const out = [];
    for (let p = 0; p < S.passes; p++) {
      if (typeof Sound !== 'undefined') Sound.setRenderSpec(specForPass(p));
      // eslint-disable-next-line no-await-in-loop
      const r = await Render.renderSong(song, sr, (f) => onProgress((p + f) / S.passes), { loops: 1 });
      out.push(r);
    }
    if (typeof Sound !== 'undefined') Sound.clearRenderSpec();

    const passN = out[0].L.length - Math.round(7 * sr);   // pass length without the tail
    const xfN = Math.round(XF * sr);
    const total = passN * (S.passes - 1) + out[out.length - 1].L.length;
    const L = new Float32Array(total), R = new Float32Array(total);

    for (let p = 0; p < out.length; p++) {
      const pos = p * passN, src = out[p];
      const n = Math.min(src.L.length, total - pos);
      for (let i = 0; i < n; i++) {
        if (p > 0 && i < xfN) {
          const w = i / xfN;                               // equal power, so the seam keeps its level
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

  async function go(mode) {
    if (busy || !app.song) return;
    busy = true;
    bar.classList.add('busy'); setBar(0);
    const t0 = performance.now();
    const list = mode === 'stems' ? STEMS.filter(([k]) => S.stems[k]) : [[null, 'Mix']];

    try {
      for (let i = 0; i < list.length; i++) {
        const [busKey, label] = list[i];
        activeStem = busKey;
        status.textContent = `Rendering ${label}…`;
        await frame();
        const r = mode === 'stems' && S.passes <= 1
          ? await Render.renderSong(app.song, 44100, (f) => { bar.classList.remove('busy'); setBar((i + f * 0.9) / list.length); }, { loops: 1 })
          : await renderEvolved(app.song, 44100, (f) => { bar.classList.remove('busy'); setBar((i + f * 0.9) / list.length); });
        peakNormalise(r);
        const blob = await Render.encodeWav(r.L, r.R, r.sr, 24);
        download(blob, `sigil-${UI.fileKey()}${busKey ? '-' + busKey : '-evolved'}.wav`);
        setBar((i + 1) / list.length);
      }
      status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      UI.announce('Render complete.');
    } catch (e) {
      console.error('[render+]', e);
      status.textContent = 'Failed: ' + (e.message || e);
    } finally {
      activeStem = null;
      if (typeof Sound !== 'undefined') Sound.clearRenderSpec();
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
      UI.note('Evolve renders each pass as a later dream, drifting brighter and grittier, then stitches them into one piece. Stems give you every bus as its own file for a DAW.'),
      UI.select({ label: 'Passes', value: S.passes, options: [['1', 'One'], ['2', 'Two'], ['3', 'Three'], ['4', 'Four']], onChange: (v) => { S.passes = +v; save(); refresh(); } }),
      UI.select({ label: 'Dream step', value: S.spread, options: [['1', 'Next dream'], ['2', 'Every second'], ['3', 'Every third'], ['7', 'Every seventh']], onChange: (v) => { S.spread = +v; save(); refresh(); } }),
      info,
      h('div', { class: 'sgrow' }, STEMS.map(([k, label]) =>
        UI.check({ label, checked: S.stems[k], onChange: (v) => { S.stems[k] = v; save(); } }))),
      h('div', { class: 'sgrow' }, evolveBtn, stemBtn), bar, status);
    refresh();
  } });

  Hooks.on('song', refresh);
  return { specForPass };
})();

window.RenderPlus = RenderPlus;