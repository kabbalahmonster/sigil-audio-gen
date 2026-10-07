'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m15 · STEMS & EVOLVE
   --------------------------------------------------------------------------
   STEMS
     Renders each selected bus on its own, then packs the WAVs into one ZIP.
     A bus is isolated by setting every other bus's gain to 0, inside the
     offline context, through the 'buses' hook at priority 200 (after the
     mixer). Reverb and delay sends come only from the isolated bus, so each
     stem carries its own tail. The chorus and the crusher stay on the master
     chain, so every stem sounds like part of the same record.

     Stems use 24-bit WAV at 48 kHz and are NOT normalised, so their levels
     match the mixdown. Normalisation is per-file and would break the balance.

   EVOLVE
     A single amount (0–100%). Each pass drifts the morph, vowel, grit and
     throat, and the story arc opens brightness and echo across the whole
     performance. Evolve only shows when there is more than one pass:
     Render → Length, or simply let the song loop.
   ══════════════════════════════════════════════════════════════════════════ */

const Stems = (() => {
  'use strict';
  const { h } = UI;

  const STEMS = ['drums', 'bass', 'pad', 'lead', 'harm', 'bell', 'arp', 'drone'];
  const LABELS = { drums: 'Drums', bass: 'Bass', pad: 'Pad', lead: 'Lead', harm: 'Choir', bell: 'Bells', arp: 'Arpeggio', drone: 'Drone' };
  const selected = new Set(STEMS);
  let solo = null, busy = false;
  let bar, status, btn, evo, passOut;

  /* ── Solo isolation, offline only ──────────────────────────────────────── */

  Hooks.on('buses', (buses, eng) => {
    if (!solo || !(typeof OfflineAudioContext !== 'undefined' && eng.ctx instanceof OfflineAudioContext)) return;
    for (const k of Object.keys(buses)) buses[k].gain.setValueAtTime(k === solo ? 1 : 0, 0);
  }, 200);

  /* ── ZIP (store method, no compression: the WAVs are already PCM) ─────── */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder(), locals = [], centrals = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);           // UTF-8 names
      lh.setUint16(12, 0x21, true);            // a fixed DOS date
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      locals.push(new Uint8Array(lh.buffer), name, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      centrals.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + size;
    }
    const cdSize = centrals.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  /* ── Render the stems ──────────────────────────────────────────────────── */

  async function renderStems() {
    if (busy || !app.song || typeof Render === 'undefined') return;
    busy = true;
    btn.disabled = true;
    bar.classList.remove('busy');
    const list = STEMS.filter((k) => selected.has(k));
    const base = `sigil-${UI.fileKey()}`, files = [];

    try {
      for (let i = 0; i < list.length; i++) {
        const k = list[i];
        solo = k;
        status.textContent = `Rendering ${LABELS[k].toLowerCase()} (${i + 1}/${list.length})…`;
        const r = await Render.renderSong(app.song, 48000, (p) => {
          bar.firstChild.style.width = `${((i + p) / list.length) * 90}%`;
        });
        solo = null;
        const blob = Render.encodeWav(r.L, r.R, r.sr, 24);
        files.push({ name: `${base}-${k}.wav`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      status.textContent = 'Packing zip…';
      await new Promise((res) => setTimeout(res, 0));
      download(makeZip(files), `${base}-stems.zip`);
      bar.firstChild.style.width = '100%';
      status.textContent = `${files.length} stems saved as one zip.`;
      UI.announce('Stems ready.');
    } catch (e) {
      console.error('[stems]', e);
      status.textContent = 'Stem render failed: ' + (e.message || e);
    } finally {
      solo = null;
      busy = false;
      btn.disabled = false;
      bar.classList.remove('busy');
      setTimeout(() => { bar.firstChild.style.width = '0%'; }, 1200);
    }
  }

  /* ── Panel ─────────────────────────────────────────────────────────────── */

  UI.section({ id: 'stems', title: 'Stems & Evolve', order: 46, build(el) {
    btn = UI.button('Render stems (.zip)', renderStems);
    bar = h('div', { class: 'sgbar' }, h('i'));
    status = UI.note('');
    passOut = UI.note('');

    evo = UI.slider({
      label: 'Evolve', min: 0, max: 1, step: 0.01,
      value: Sound.view().P ? Sound.view().P.evolve || 0 : 0,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => Sound.set('evolve', v),
      title: 'How much each pass changes the sound (the sonic story)',
    });

    const checks = h('div', { class: 'sgrow', role: 'group', 'aria-label': 'Stems to render' },
      STEMS.map((k) => UI.check({
        label: LABELS[k], checked: true, title: `Include ${LABELS[k]}`,
        onChange: (on) => (on ? selected.add(k) : selected.delete(k)),
      })));

    el.append(
      UI.note('Evolve makes every pass different. The morph drifts, the vowels walk, the grit deepens, and the brightness opens across the whole story. It is heard live across loops, and in renders with more than one pass.'),
      evo, passOut,
      h('div', { class: 'snd-h' }, 'Stems'),
      UI.note('Each selected instrument is rendered alone, in the same room, then packed into one ZIP. 24-bit WAV at 48 kHz.'),
      checks,
      h('div', { class: 'sgrow' }, btn),
      bar, status);

    setInterval(() => {
      const d = document.getElementById('drawer');
      if (!d || !d.classList.contains('open')) return;
      const e = app.engine;
      const pass = e && e.loopIndex != null ? e.loopIndex + 1 : 1;
      const evoAmt = Sound.view().P ? Sound.view().P.evolve || 0 : 0;
      passOut.textContent = evoAmt > 0
        ? `pass ${pass} · the sound has drifted ${Math.round(evoAmt * (pass - 1) * 100) / 100} steps`
        : '';
    }, 1000);
  } });

  Sound.subscribe(() => {
    if (evo) evo.set(Sound.view().P ? Sound.view().P.evolve || 0 : 0);
  });

  return { renderStems, makeZip, crc32 };
})();