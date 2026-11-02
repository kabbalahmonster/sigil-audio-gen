'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M7 · RENDER & EXPORT — the full track and its stems, in any format, ready to hand over
   --------------------------------------------------------------------------
   ONE PANEL, ONE PIPELINE. What to render (the full track, the stems, or both), how
   long (passes of the rite), where it is going (a destination: streaming, a PA, a
   club, a broadcaster…), and in what (WAV, FLAC, MP3, AAC, Opus). Every item goes
   through the same stages, and every format can be asked of every item:

     compile once     the job is compiled ONCE for the whole run, so the track and every stem are
                      the same performance: the same events, the same lanes, the same passes
     listen once      the master (m20) listens to the rite, through all its passes, and solves one
                      plan (trims, caps, rides, tone, the gain that lands the loudness)
     render           the DSP core in parallel workers: cut into segments, each warmed by pre-roll,
                      stitched with 30 ms crossfades (the core is deterministic, so the seams agree)
     finish           05h: the dead air at the end trimmed and the last breath glided to zero; the
                      file measured as a meter would, and brought the last fraction of a decibel to
                      the loudness asked for, never past the ceiling
     encode           src/export/codecs.js: dithered (16-bit), tagged, and written
     check            a lossy file is decoded again: its true peak must still be under the ceiling
     hand over        one download, a ZIP of several, or each file on its own; each can be auditioned

   EVERY RENDER EVOLVES. There is no separate "evolving" render. The rite goes round, and each
   pass of it is a little further evolved (05d Motion, by the Evolution patch field: the
   same control, and the same core, as the loop on the stage). Pass 1 is the rite as
   written. So a render is measured in passes, and its length in passes is what it is
   for: two passes, by default, is the rite and its evolution.

   AND THE PASSES FLOW (05i). They go round the rite's BODY, not the whole of it: the opening
   is heard once, at the start, and the ending once, at the end, so nothing in the middle
   fades or begins again, and the layers (the arpeggio, the choir, the drone) gather over the
   passes. A render's length is therefore not passes × the rite: it is SigilDSP.beatsOf.

   THE TRACK is finished by the master (chain, loudness, ceiling). THE STEMS are parts of
   one mix: they take the plan's trims and caps, and leave BEFORE the chain, so laid
   side by side at unity they are the mix as it entered it. By default they are all
   raised by one common gain (the mix they add up to peaks at −1.5 dBFS), so a stem is
   not a whisper in a DAW and the balance between them is still the mix's.

   Soft dependencies: m20 Master (the plan), m9 LiveLens, m11 Sound (the Evolution field),
   m2 Mixer (the levels a stem is heard at).
   ══════════════════════════════════════════════════════════════════════════ */

const Render = (() => {
  'use strict';
  const { h } = UI;

  const STEMS = [['lead', 'Lead'], ['harm', 'Choir'], ['bell', 'Bells'], ['pad', 'Pad'],
                 ['bass', 'Bass'], ['arp', 'Arpeggio'], ['drums', 'Drums'], ['drone', 'Drone']];
  const RENDER_WORKER = 'src/dsp/sigil-render.worker.js';
  const PRE_FX = 6;     // s of pre-roll: the hall (4.2 s) and the echoes must be ringing before a segment's first sample
  const XF = 0.03;      // s crossfade at each seam
  const MIN_SEG = 20;   // s: the least a segment is worth a worker for
  const lanesNow = () => (S.fast ? clamp((navigator.hardwareConcurrency || 2) - 1, 1, 6) : 1);
  const PASSES = [1, 2, 3, 4, 6, 8];
  const STEM_HEADROOM = 1.5;   // dB: the mix that the stems add up to peaks this far under full scale

  /* ── Settings (this listener's: Prefs 'render.v2') ──────────────────── */

  const DEFAULTS = {
    mix: true, stems: false, parts: Object.fromEntries(STEMS.map(([k]) => [k, true])),
    passes: 2,
    target: -14, ceiling: -1, master: true,
    format: 'wav', bits: 24, rate: 44100, kbps: {},
    dither: 'tpdf', trim: true, stemLevel: 'together',
    title: '', artist: '',
    pack: 'zip', auto: true,
    tempo: true, lens: true, fast: true,
  };
  const stored = Prefs.get('render.v2', {});
  const S = { ...DEFAULTS, ...stored, parts: { ...DEFAULTS.parts, ...(stored.parts || {}) }, kbps: { ...(stored.kbps || {}) } };
  const save = () => Prefs.set('render.v2', S);

  /** How long a render took per second of what it made, learned: the estimate gets better as it is used. */
  const pace = { mix: 0.55, stem: 0.5, ...Prefs.get('render.pace', {}) };   // (per lane: see lanesNow)

  let support = { wav: true, flac: true, mp3: true, aac: true, opus: true };   // until the browser says otherwise
  let busy = false, run = null, items = [], packed = null;
  const ui = {};

  const hasWorkers = typeof Worker !== 'undefined';
  const clock = Deliver.clock;
  const db = Deliver.db;
  // (Not requestAnimationFrame: a render must carry on in a tab that is not in front.)
  const frame = () => new Promise((r) => setTimeout(r, 0));
  const pctOf = (v) => `${Math.round(v * 100)}%`;

  /* ═════════ 1. WHAT IS ASKED ═════════ */

  /** The body the passes go round (05i), if they flow: the opening is heard once, and so is the ending. */
  const loopNow = () => (typeof Flow !== 'undefined' && Flow.enabled() && app.song ? Flow.loop(app.song) : null);
  const spbNow = () => (app.song ? (S.tempo && app.engine && app.engine.song === app.song ? app.engine.spb : app.song.spb) : 0.6);
  const lensOn = () => S.lens && typeof LiveLens !== 'undefined' && LiveLens.active();
  const evolveNow = () => (typeof Sound !== 'undefined' && app.sigil ? Sound.state().P.evolve ?? 0.5 : 0.5);

  /** The settings as a delivery: resolved to a format the browser can write, with the ceiling it is mastered to. */
  function resolved() {
    const r = Deliver.resolve({ format: S.format, bits: S.bits, rate: S.rate, kbps: S.kbps[S.format], target: S.target, ceiling: S.ceiling, dither: S.dither });
    if (support[r.format] !== true) return Deliver.resolve({ format: 'wav', bits: 24, rate: S.rate, target: S.target, ceiling: S.ceiling, dither: S.dither });
    return r;
  }

  /** The parts to render: the track, then the stems. A part the rite does not sing is marked, where it is known. */
  function chosen() {
    const list = [];
    if (S.mix) list.push({ id: 'mix', kind: 'mix', label: 'Full track' });
    if (S.stems) for (const [k, label] of STEMS) if (S.parts[k]) list.push({ id: k, kind: 'stem', bus: k, label });
    return list;
  }
  /** Which parts the stage's own listening heard (the rite as it is now), or null if it has not been. */
  function heardParts() {
    try {
      const p = typeof Master !== 'undefined' && Master.state().plan;
      const parts = p && p.report && p.report.parts;
      return parts ? Object.fromEntries(parts.map((q) => [q.name, !!q.heard])) : null;
    } catch { return null; }
  }

  /** What the render would be, said before it is asked for. */
  function forecast() {
    const r = resolved(), song = app.song, spb = spbNow();
    const loop = loopNow(), beats = (n) => (song ? SigilDSP.beatsOf(song.total, loop, n) : 0);
    const pass = song ? song.total * spb : 0, music = beats(S.passes) * spb, tail = 9, seconds = music + tail;
    const lengthOf = (n) => beats(n) * spb + tail;
    const list = chosen(), heard = heardParts();
    const live = list.filter((it) => !(it.kind === 'stem' && heard && heard[it.bus] === false));
    let bytes = 0, time = 0;
    for (const it of live) {
      bytes += Deliver.estimate(it.kind === 'mix' ? music + tail * 0.7 : seconds, r);
      time += (seconds * (it.kind === 'mix' ? pace.mix : pace.stem)) / lanesNow();
    }
    if (S.master && S.mix) time += 4 + music * 0.012;            // the listening
    const tooLong = Deliver.frames(seconds, r.rate) > Deliver.MAX_FRAMES;
    let problem = '';
    if (!song) problem = 'Cast a sigil to render it.';
    else if (!hasWorkers) problem = 'This browser cannot render in the background (no Web Workers).';
    else if (!list.length) problem = 'Choose what to render: the full track, or the stems.';
    else if (tooLong) problem = `This is too long to hold in memory at ${r.rate / 1000} kHz. Choose fewer passes, or a lower rate.`;
    else if (!live.length) problem = 'None of the chosen parts is heard in this rite.';
    return { r, song, spb, pass, music, tail, seconds, lengthOf, loop, list, live, bytes, time, problem, files: live.length };
  }

  /* ═════════ 2. RENDERING: the DSP core in parallel Web Workers ═════════
     Cut the song into K segments; each worker renders PRE_FX seconds of pre-roll (warming reverb and
     delay, chasing pads and drones) and returns only its own range; seams are 30 ms crossfades.
     Same core as the live engine. */

  const makeRun = () => {
    const r = { cancelled: false, hooks: new Set(), ctl: {}, t0: performance.now() };
    r.stop = () => r.cancelled;
    r.cancel = () => {
      if (r.cancelled) return;
      r.cancelled = true;
      r.ctl.aborted = true;
      if (r.ctl.cancel) r.ctl.cancel();
      for (const f of [...r.hooks]) f();
    };
    return r;
  };
  const CANCELLED = 'cancelled';
  const gone = (r) => { if (r.cancelled) throw new Error(CANCELLED); };

  /**
   * Render a job: { L, R, sr, segments }. The length is every pass of the rite and `tail` seconds of ring-out.
   * opts: { tail (s), fast (parallel), progress(0…1), run }
   */
  async function renderAudio(job, opts) {
    const sr = job.sr, spb = 60 / job.bpm, music = SigilDSP.beatsOf(job.total, job.loop, job.passes) * spb, total = music + opts.tail, r = opts.run;
    const lanes = lanesNow();
    const K = Math.max(1, Math.min(lanes * 2, Math.floor(music / MIN_SEG)));
    const q = (t) => (Math.round((t * sr) / 128) * 128) / sr;
    const cuts = [0];
    for (let k = 1; k < K; k++) cuts.push(q((music * k) / K));
    cuts.push(total);
    const segs = cuts.slice(0, -1).map((a, k) => ({ id: k, keep: a, from: Math.max(0, a - PRE_FX), to: k < K - 1 ? cuts[k + 1] + XF : total, frac: 0 }));
    const weight = segs.reduce((s, g) => s + (g.to - g.from), 0);
    const report = () => opts.progress(segs.reduce((s, g) => s + g.frac * (g.to - g.from), 0) / weight);

    await new Promise((resolve, reject) => {
      const workers = [];
      let next = 0, left = segs.length, over = false;
      const leave = (err) => {
        if (over) return;
        over = true; r.hooks.delete(abort);
        workers.forEach((w) => w.terminate());
        if (err) reject(err); else resolve();
      };
      const abort = () => leave(new Error(CANCELLED));
      r.hooks.add(abort);
      if (r.cancelled) { abort(); return; }
      for (let i = 0; i < Math.min(lanes, K); i++) {
        const w = new Worker(RENDER_WORKER);
        workers.push(w);
        w.onerror = (e) => leave(new Error(e.message || 'the render worker failed to load'));
        const take = () => {
          if (next >= segs.length) return;
          const g = segs[next++];
          w.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'progress') { g.frac = d.f; report(); }
            else if (d.type === 'done') { g.L = d.L; g.R = d.R; g.frac = 1; report(); if (--left === 0) leave(null); else take(); }
            else if (d.type === 'error') leave(new Error(d.msg));
          };
          w.postMessage({ type: 'render', job, from: g.from, to: g.to, keep: g.keep });
        };
        take();
      }
    });

    const N = Math.round(total * sr), xfN = Math.round(XF * sr);
    const L = new Float32Array(N), R = new Float32Array(N);
    for (const g of segs) {
      const pos = Math.round(g.keep * sr), n = Math.min(g.L.length, N - pos);
      for (let i = 0; i < n; i++) {
        if (g.id > 0 && i < xfN) {
          const w = i / xfN;
          L[pos + i] = L[pos + i] * (1 - w) + g.L[i] * w;
          R[pos + i] = R[pos + i] * (1 - w) + g.R[i] * w;
        } else { L[pos + i] = g.L[i]; R[pos + i] = g.R[i]; }
      }
      g.L = g.R = null;
    }
    opts.progress(1);
    return { L, R, sr, segments: segs.length };
  }

  /* ═════════ 3. ONE ITEM: render → finish → encode ═════════ */

  /**
   * What each part is heard at, alone: its fader, with the mixer's mute and solo taken off (a stem of a muted part is
   * asked for on purpose). Taken once, when the run begins, like everything else a run hears.
   */
  function partLevels(job) {
    const out = {};
    for (const [k] of STEMS) {
      let lv = null;
      try {
        const b = app.engine && app.engine.buses && app.engine.buses[k], f = typeof Mixer !== 'undefined' && Mixer.state.level[k];
        if (b && b._base != null && f != null) lv = b._base * f;
      } catch { /* the mix's own level will do */ }
      out[k] = lv ?? job.levels[k] ?? 1;
    }
    return out;
  }
  /** The levels of a stem: its own, and every other part at zero. */
  const stemLevels = (j, bus) => Object.fromEntries(STEMS.map(([k]) => [k, k === bus ? j.parts[k] : 0]));

  /** The true peak of what a decoder gives back from a lossy file, in dBTP; null if this browser cannot decode it. */
  async function decodedPeak(blob, sr) {
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Ctx) return null;
      const buf = await new Ctx(2, 1, sr).decodeAudioData(await blob.arrayBuffer());
      const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
      return 20 * Math.log10(Math.max(SigilDSP.truePeak(L), SigilDSP.truePeak(R)) + 1e-30);
    } catch { return null; }
  }

  const setItem = (it, patch) => { Object.assign(it, patch); paintItem(it); paintTotal(); };

  /**
   * Render and write one item. `j` is the run's: { cfg, job, plan, meta, base }.
   * The item is given, as it goes: state, frac (0…1), then blob, name, size, seconds, facts.
   */
  async function doItem(j, it) {
    const { cfg } = j, r = cfg.r, stem = it.kind === 'stem', sr = r.rate;
    const mark = (f0, f1) => (f) => setItem(it, { frac: f0 + f * (f1 - f0) });

    /* render */
    setItem(it, { state: 'rendering', frac: 0 });
    const levels = stem ? stemLevels(j, it.bus) : j.job.levels;
    // The track leaves through the chain. A stem does not: the plan's trims and caps, and one gain common to them all.
    const master = j.plan ? Mastering.table(j.plan, stem ? { lift: cfg.stemLevel === 'together', room: STEM_HEADROOM } : false) : null;
    const job = Object.assign({}, j.job, { levels, master });
    const t0 = performance.now();
    const audio = await renderAudio(job, { tail: j.tail, fast: cfg.fast, run: j.run, progress: mark(0, 0.8) });
    const took = (performance.now() - t0) / 1000;
    gone(j.run);
    const facts = [];

    /* finish */
    setItem(it, { state: 'finishing', frac: 0.8 });
    await frame();
    let { L, R } = audio, report = null;
    if (stem) {
      const pk = Deliver.peakOf(L, R);
      if (pk < 3e-6) { setItem(it, { state: 'skipped', frac: 1, note: 'silent in this rite: no file' }); return; }
      const t = Deliver.tidy(L, R, sr, { frames: L.length });
      L = t.L; R = t.R;
      let peak = 20 * Math.log10(pk);
      // A stem must not clip: under full scale, and (a lossy file rings around its peaks) further under for a lossy codec.
      const room = r.bits === 32 && r.format === 'wav' ? Infinity : r.lossless ? -0.3 : -1 - Deliver.LOSSY_MARGIN;
      if (cfg.stemLevel === 'each') { const g = (r.lossless ? -1 : -1 - 1.5 * Deliver.LOSSY_MARGIN) - peak; Deliver.gain(L, R, g); peak += g; facts.push({ ok: true, text: `${db(peak)} dBFS`, hint: 'peak: normalised on its own' }); }
      else if (peak > room) { const g = room - peak; Deliver.gain(L, R, g); peak += g; facts.push({ ok: false, text: `${db(peak)} dBFS`, hint: `turned down ${(-g).toFixed(1)} dB to fit under full scale` }); }
      else facts.push({ ok: true, text: `${db(peak)} dBFS`, hint: 'peak' });
      if (master && cfg.stemLevel === 'together') {
        const lift = master.p[SigilDSP.MA.OUT];
        if (Number.isFinite(lift) && Math.abs(lift) >= 0.05) facts.push({ ok: true, text: `${lift > 0 ? '+' : '−'}${Math.abs(lift).toFixed(1)} dB`, hint: `the gain all the stems share, so that together they peak ${STEM_HEADROOM} dB under full scale` });
      }
    } else {
      const t = Deliver.tidy(L, R, sr, { trim: cfg.trim });
      L = t.L; R = t.R;
      if (j.plan) {
        const landed = Deliver.land(L, R, sr, { target: cfg.r.target, ceiling: r.effective });
        report = landed.after;
        if (Math.abs(landed.gain) >= 0.02) facts.push({ key: 'land', ok: true, text: `${landed.gain > 0 ? '+' : '−'}${Math.abs(landed.gain).toFixed(2)} dB`, hint: 'the last correction, measured on the file itself' });
        it.limited = landed.limited;
      } else {
        // Unmastered: the engine's own mix, brought up to the ceiling (and never above it).
        const m = Deliver.analyse(L, R, sr);
        if (Number.isFinite(m.truePeak)) Deliver.gain(L, R, r.effective - m.truePeak);
        report = Deliver.analyse(L, R, sr);
      }
      it.measure = report;
      for (const f of Deliver.judge(report, j.plan ? { target: cfg.r.target, ceiling: r.ceiling } : { ceiling: r.ceiling })) facts.push(f);
    }
    const frames = L.length;

    /* encode */
    setItem(it, { state: 'encoding', frac: 0.85, facts });
    const meta = { ...j.meta, title: stem ? `${j.meta.title} · ${it.label}` : j.meta.title };
    const mix = { L, R, sr };
    let blob = await Codecs.encode(r, mix, meta, mark(0.85, 0.98), j.run.stop);
    gone(j.run);

    /* check: a lossy file, decoded, must still be under the ceiling. How far a codec overshoots is not proportional to the level it
       is given (it adds its own noise), so a file that is over is brought down by twice what it is over by, and looked at again */
    if (!stem && !r.lossless) {
      let tp = await decodedPeak(blob, sr), lowered = 0, tries = 0;
      while (tp != null && tp - r.ceiling > 0.05 && tries < 3) {
        tries++;
        setItem(it, { state: 'encoding', note: `the decoded peak is ${db(tp)} dBTP: encoding again, lower` });
        const g = -((tp - r.ceiling) * 2 + 0.1);
        Deliver.gain(L, R, g); lowered += g;
        blob = await Codecs.encode(r, mix, meta, mark(0.85 + 0.04 * tries, 0.98), j.run.stop);
        gone(j.run);
        tp = await decodedPeak(blob, sr);
      }
      if (tp != null) {
        // What a listener will have: the loudness the track was landed at, less what was taken off; the peak a decoder gives back.
        const fin = Object.assign({}, report, { lufs: report.lufs + lowered, truePeak: tp });
        it.measure = fin;
        const keep = facts.filter((f) => f.key === 'land');
        facts.length = 0;
        facts.push(...keep, ...Deliver.judge(fin, j.plan ? { target: cfg.r.target, ceiling: r.ceiling } : { ceiling: r.ceiling }).map((f) => (f.key === 'peak' ? { ...f, text: `decoded ${f.text}`, hint: 'the true peak of what a decoder gives back' } : f)));
        if (lowered) facts.push({ ok: tp <= r.ceiling + 0.1, text: `−${(-lowered).toFixed(1)} dB`, hint: 'a codec overshoots its own peaks: the file was encoded again, lower, so that what a listener decodes is under the ceiling' });
      }
    }
    if (!stem && it.limited && cfg.master && cfg.r.target - (it.measure || report).lufs > 0.3) facts.push({ ok: false, text: 'peak-limited', hint: 'the ceiling did not let it be any louder: the loudness is as near as it could go' });

    const name = `${j.base}${stem ? '-' + it.bus : ''}.${r.ext}`;
    it.seconds = frames / sr;
    // what this machine did, in seconds of work per second of sound per lane: the next forecast is made from it
    pace[stem ? 'stem' : 'mix'] = clamp(0.5 * pace[stem ? 'stem' : 'mix'] + 0.5 * ((took * lanesNow()) / Math.max(1, audio.L.length / sr)), 0.05, 4);
    setItem(it, { state: 'done', frac: 1, blob, name, size: blob.size, facts, note: '' });
  }

  /* ═════════ 4. THE RUN ═════════ */

  /** What the README of a ZIP says: the sigil's tempo and key, and how the files were made. */
  function readme(j, done) {
    const { cfg } = j, r = cfg.r, dest = Deliver.destination(cfg.dest);
    const line = (k, v) => `${k.padEnd(11)}${v}`;
    const mix = done.find((it) => it.kind === 'mix');
    const text = [
      'SIGIL render', '',
      line('sigil', j.key), line('tempo', `${Math.round(60 / j.spb)} bpm`), line('key', j.song.keyName || ''),
      line('length', `${cfg.passes} pass${cfg.passes === 1 ? '' : 'es'}, ${clock(done.length ? Math.max(...done.map((it) => it.seconds || 0)) : 0)}`),
      line('evolution', `${Math.round(cfg.evolve * 100)}% (pass 1 is the rite as written; each pass after it is further evolved)`),
      ...(cfg.flow && cfg.passes > 1 ? [line('flow', 'the passes go round the body of the rite: its opening once, at the start, and its ending once, at the end')] : []),
      line('format', `${Deliver.FORMATS[r.format].label}${r.bits ? `, ${r.bits === 32 ? '32-bit float' : r.bits + '-bit'}` : ''}${r.kbps ? `, ${r.kbps} kbps` : ''}, ${r.rate / 1000} kHz`),
      cfg.master && mix ? line('loudness', `${db(r.target)} LUFS, true peak under ${db(r.effective)} dBTP${dest ? ` (${dest.label})` : ''}`) : line('mastering', cfg.master ? 'stems only' : 'off: the engine’s own mix'),
      '', 'Files', ...done.map((it) => `  ${it.name}  ${it.kind === 'mix' ? 'the track' : 'stem: ' + it.label.toLowerCase()}${it.facts && it.kind === 'mix' ? '  ' + it.facts.filter((f) => f.key === 'lufs' || f.key === 'peak').map((f) => f.text).join(', ') : ''}`),
    ];
    if (done.some((it) => it.kind === 'stem')) {
      text.push('', 'The stems are parts of one mix, all the same length and all starting at zero.',
        cfg.stemLevel === 'together' ? 'They were raised by one common gain, so that laid side by side at unity they add up to the mix as it entered the master, peaking 1.5 dB under full scale.'
          : cfg.stemLevel === 'asmixed' ? 'They are left as mixed: laid side by side at unity they add up to the mix as it entered the master.'
          : 'Each stem was normalised on its own, so they no longer add up to the mix.',
        'They leave before the master chain: no EQ, compression or limiting. Master the sum elsewhere.');
    }
    return text.join('\n') + '\n';
  }

  const j0loop = () => loopNow();

  async function go() {
    if (busy) return;
    const fc = forecast();
    if (fc.problem) { setStatus(fc.problem); return; }
    clearResults();
    const song = app.song, sigil = app.sigil, spb = fc.spb, r = fc.r;
    const evolve = evolveNow();
    const cfg = { ...S, r, passes: S.passes, flow: !!j0loop(), evolve, dest: currentDest(), stemLevel: S.stemLevel, trim: S.trim, fast: S.fast, master: S.master };
    const key = UI.fileKey();
    const bpm = 60 / spb;
    run = makeRun();
    items = fc.list.map((it) => ({ ...it, state: 'queued', frac: 0, facts: [], note: '' }));
    const wasLite = typeof Sound !== 'undefined' ? Sound.lite : false;
    if (typeof Sound !== 'undefined') Sound.setLite(true);   // thin the live voices while the workers have the cores
    busy = true;
    paintAll();
    setStatus('Preparing…');
    ui.results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const t0 = performance.now();
    let j = null;

    try {
      // One compile for the whole run: the track and every stem are the same performance.
      const job = SigilPlan.renderJob(song, sigil, { sr: r.rate, spb, passes: S.passes, lens: lensOn(), holdK: r.rate / 44100, flow: typeof Flow !== 'undefined' && Flow.enabled() });
      j = { cfg, job, plan: null, song, key, spb, run, tail: Deliver.tailOf(job), parts: partLevels(job),
        base: Deliver.fileBase(key, bpm, song.keyName),
        meta: { title: S.title.trim() || `SIGIL ${key}`, artist: S.artist.trim(),
          comment: [key, `${Math.round(bpm)} bpm`, song.keyName, `${S.passes} pass${S.passes === 1 ? '' : 'es'}`].filter(Boolean).join(' · '),
          bpm, software: 'SIGIL' } };

      // Listen, once (the stage's own listening is used if it is the same rite: Master keeps what it has heard).
      if (S.master && typeof Master !== 'undefined') {
        run.phase = 'listening';
        setStatus('Listening to the rite…');
        try {
          const m = await Master.prepare(job, song, { on: true, opts: { target: r.target, ceiling: r.effective }, ctl: run.ctl,
            onProgress: (f) => { run.listened = f; paintTotal(); } });
          gone(run);
          if (m) j.plan = m.plan;
        } catch (e) {
          if (e && e.message === CANCELLED) throw e;
          // The rite could not be listened to. It is still rendered: unmastered, as the engine always left it.
          console.error('[render] the master could not listen; rendering without it', e);
          cfg.master = false;
          setStatus('The master could not listen: rendering without it…');
        }
      }
      run.listened = 1; run.phase = 'rendering';

      // A part the rite does not sing is not rendered: the listening knows.
      const heard = j.plan && j.plan.report && j.plan.report.parts ? Object.fromEntries(j.plan.report.parts.map((q) => [q.name, !!q.heard])) : null;
      for (const it of items) {
        if (it.kind === 'stem' && heard && heard[it.bus] === false) setItem(it, { state: 'skipped', frac: 1, note: 'not heard in this rite: no file' });
      }

      for (const it of items) {
        if (it.state === 'skipped') continue;
        gone(run);
        setStatus(it.kind === 'mix' ? 'Rendering the track…' : `Rendering the ${it.label.toLowerCase()} stem…`);
        try { await doItem(j, it); }
        catch (e) {
          if (e && e.message === CANCELLED) throw e;
          console.error('[render]', it.id, e);
          setItem(it, { state: 'failed', frac: 1, note: String((e && e.message) || e) });
        }
      }

      // Hand over.
      const done = items.filter((it) => it.state === 'done');
      if (!done.length) { setStatus(items.some((it) => it.state === 'failed') ? 'The render failed.' : 'Nothing was rendered.'); return; }
      j.done = done;
      packed = { j, done };
      const total = (performance.now() - t0) / 1000;
      Prefs.set('render.pace', pace);
      const summary = `${done.length} file${done.length === 1 ? '' : 's'} · ${Deliver.size(done.reduce((s, it) => s + it.size, 0))} · ${total < 90 ? `${total.toFixed(0)} s` : clock(total)}`;
      setStatus(`Done: ${summary}`);
      UI.announce(`Render finished: ${summary}.`);
      if (!document.getElementById('drawer').classList.contains('open')) toast(`Render finished · ${summary}`, true, 4200);
      if (S.auto) {
        try { await handOver(done, j); }
        catch (e) { console.error('[render] hand over', e); setStatus(`Done, but the files could not be packed (${(e && e.message) || e}): use the download buttons.`); }
      }
    } catch (e) {
      if (e && e.message === CANCELLED) {
        for (const it of items) if (!['done', 'skipped', 'failed'].includes(it.state)) setItem(it, { state: 'cancelled', frac: 0, note: 'cancelled' });
        const kept = items.filter((it) => it.state === 'done');
        if (j && kept.length) packed = { j, done: kept };                 // what was finished before the stop is still there to take
        setStatus('Cancelled.');
        UI.announce('Render cancelled.');
      } else {
        console.error('[render]', e);
        setStatus('The render failed: ' + ((e && e.message) || e));
      }
    } finally {
      if (typeof Sound !== 'undefined') Sound.setLite(wasLite);
      busy = false; run = null;
      paintAll();
    }
  }

  /** The files, as the listener asked to have them: one download, a ZIP of several, or each on its own. */
  async function handOver(done, j) {
    if (done.length === 1) { download(done[0].blob, done[0].name); return; }
    if (S.pack === 'zip') {
      setStatus('Packing the ZIP…');
      const blob = await Codecs.zip([...done.map((it) => ({ name: it.name, data: it.blob })), { name: 'README.txt', data: readme(j, done) }]);
      download(blob, `${j.base}-render.zip`);
      setStatus(`Done: ${done.length} files in one ZIP.`);
    } else {
      for (const it of done) { download(it.blob, it.name); await new Promise((r) => setTimeout(r, 350)); }
    }
  }

  function clearResults() {
    stopAudition();
    for (const it of items) if (it.url) URL.revokeObjectURL(it.url);
    items = []; packed = null;
    paintAll();
  }

  /* ═════════ 5. AUDITION ═════════ */

  let player = null, playing = null, pausedStage = false;
  function stopAudition() {
    if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
    if (playing) { const it = playing; playing = null; paintItem(it); }
    resumeStage();
  }
  // The stage is paused and resumed the way its own button does it (togglePause, which the audio guard watches: it
  // would otherwise take a pause for an interruption, and resume the stage under what is being auditioned).
  async function pauseStage() {
    try {
      const c = app.engine && app.engine.ctx;
      if (app.mode === 'playing' && c && c.state === 'running') { await window.togglePause(); pausedStage = true; }
    } catch { /* the stage plays on */ }
  }
  async function resumeStage() {
    if (!pausedStage) return;
    pausedStage = false;
    try { if (app.mode === 'playing' && app.engine.ctx.state === 'suspended') await window.togglePause(); } catch { /* nothing to resume */ }
  }
  async function audition(it) {
    if (!it.blob) return;
    if (playing === it) { stopAudition(); return; }
    stopAudition();
    if (!player) { player = new Audio(); player.addEventListener('ended', stopAudition); }
    if (!it.url) it.url = URL.createObjectURL(it.blob);
    player.src = it.url;
    playing = it; paintItem(it);
    await pauseStage();
    try { await player.play(); }
    catch { stopAudition(); toast('This browser cannot play that format here. Download it instead.', true, 3200); }
  }

  /* ═════════ 6. THE PANEL ═════════ */

  const currentDest = () => {
    const r = Deliver.resolve({ format: S.format, bits: S.bits, rate: S.rate, kbps: S.kbps[S.format] });
    const d = Deliver.DESTINATIONS.find((x) => x.format === r.format && (!x.bits || x.bits === r.bits) && (!x.kbps || x.kbps === r.kbps) && x.rate === r.rate && x.target === S.target && x.ceiling === S.ceiling);
    return d ? d.id : null;
  };
  function setDest(d) {
    S.target = d.target; S.ceiling = d.ceiling; S.format = d.format; S.rate = d.rate;
    if (d.bits) S.bits = d.bits;
    if (d.kbps) S.kbps[d.format] = d.kbps;
    S.master = true;
    save(); refresh();
    UI.announce(`${d.label}: ${d.target} LUFS, ${d.ceiling} dBTP, ${Deliver.FORMATS[d.format].label}.`);
  }

  let statusText = '', etaText = '', soon = 0, waited = 0;
  const later = () => { clearTimeout(soon); soon = setTimeout(refresh, 50); };   // (refresh, a moment from now, once)
  const setStatus = (t) => { statusText = t; refresh(); };
  /** The Tools button says how a render is going, for when the drawer is shut. */
  const tools = (t) => { const b = document.getElementById('toolsBtn'); if (b && b.textContent !== t) b.textContent = t; };

  /** Overall progress of the run, 0…1: the listening is the weight of a third of an item. */
  function overall() {
    const live = items.filter((it) => it.state !== 'skipped');
    if (!live.length) return 0;
    const wl = run && S.master && (S.mix || S.stems) ? 0.3 : 0;
    return (wl * (run ? run.listened || 0 : 1) + live.reduce((s, it) => s + it.frac, 0)) / (wl + live.length);
  }
  let paintAt = 0;
  function paintTotal() {
    if (!ui.track) return;
    const now = performance.now();
    if (now - paintAt < 90 && busy) return;
    paintAt = now;
    const f = clamp(overall(), 0, 1);
    ui.fill.style.width = `${Math.round(f * 1000) / 10}%`;
    ui.track.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    if (busy && run && f > 0.04) {
      const el = (performance.now() - run.t0) / 1000, left = (el * (1 - f)) / f;
      etaText = `${pctOf(f)} · about ${left < 60 ? `${Math.max(5, Math.round(left / 5) * 5)} s` : `${Math.max(1, Math.round(left / 60))} min`} left`;
    } else etaText = busy ? 'starting…' : '';
    if (busy && ui.sumB) ui.sumB.textContent = etaText;
    tools(busy ? `Rendering ${Math.round(f * 100)}%` : 'Tools');
  }

  const STATE_TEXT = { queued: 'waiting', rendering: 'rendering', finishing: 'finishing', encoding: 'encoding', done: '', skipped: '', failed: 'failed', cancelled: 'cancelled' };
  function paintItem(it) {
    if (!it.el) return;
    const e = it.el;
    e.row.className = `rx-item rx-${it.state}${playing === it ? ' rx-playing' : ''}`;
    e.bar.style.width = `${Math.round(clamp(it.frac, 0, 1) * 100)}%`;
    e.bar.parentNode.hidden = !['rendering', 'finishing', 'encoding'].includes(it.state);
    e.state.textContent = it.note || STATE_TEXT[it.state] || '';
    e.file.replaceChildren(...(it.state === 'done' ? [it.name, h('em', {}, ` · ${Deliver.size(it.size)}${it.seconds ? ` · ${clock(it.seconds)}` : ''}`)] : []));
    e.play.hidden = e.get.hidden = it.state !== 'done';
    e.play.textContent = playing === it ? '■' : '▶';
    e.play.setAttribute('aria-label', `${playing === it ? 'Stop' : 'Listen to'} ${it.label}`);
    e.play.title = playing === it ? 'Stop' : 'Listen to it here';
    if (it.facts && e.factsKey !== JSON.stringify(it.facts)) {
      e.factsKey = JSON.stringify(it.facts);
      e.facts.replaceChildren(...it.facts.map((f) => h('span', { class: 'rx-fact' + (f.ok === false ? ' rx-warn' : ''), title: f.hint || '' }, f.text)));
    }
  }
  function paintQueue() {
    ui.queue.replaceChildren(...items.map((it) => {
      const e = it.el = {};
      e.bar = h('i');
      e.state = h('span', { class: 'rx-state' });
      e.file = h('span', { class: 'rx-file' });
      e.facts = h('div', { class: 'rx-facts' });
      e.play = h('button', { class: 'sm rx-ico', type: 'button', hidden: true, onclick: () => audition(it) }, '▶');
      e.get = h('button', { class: 'sm rx-ico', type: 'button', hidden: true, title: 'Download it', 'aria-label': `Download ${it.label}`, onclick: () => download(it.blob, it.name) }, '↓');
      e.row = h('li', { class: 'rx-item' },
        h('div', { class: 'rx-main' },
          h('div', { class: 'rx-head' }, h('span', { class: 'rx-label' }, it.label), e.state),
          h('div', { class: 'rx-prog', role: 'progressbar', 'aria-label': `${it.label}`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, e.bar),
          e.file, e.facts),
        h('div', { class: 'rx-act' }, e.play, e.get));
      paintItem(it);
      return e.row;
    }));
    ui.results.hidden = !items.length;
    ui.zip.hidden = !(packed && packed.done.length > 1 && !busy);
    ui.clear.hidden = !items.length || busy;
  }

  function paintAll() { paintQueue(); refresh(); paintTotal(); }

  /** A select's options, rewritten only if they are not already these (an open list must not be pulled from under the hand). */
  function options(sel, pairs, value) {
    const have = [...sel.options].map((o) => `${o.value}|${o.textContent}`).join('\n'), want = pairs.map(([v, t]) => `${v}|${t}`).join('\n');
    if (have !== want) sel.replaceChildren(...pairs.map(([v, t]) => h('option', { value: v }, t)));
    sel.value = String(value);
  }

  /** Everything that depends on what is asked: labels, estimates, what can and cannot be chosen. */
  function refresh() {
    if (!ui.go) return;
    const fc = forecast(), r = fc.r, F = Deliver.FORMATS[r.format], dest = currentDest(), lock = (x, why = false) => { x.disabled = busy || why; };

    // what
    ui.cardMix.setAttribute('aria-pressed', String(S.mix));
    ui.cardStems.setAttribute('aria-pressed', String(S.stems));
    ui.parts.hidden = !S.stems;
    const heard = heardParts();
    // (the stage is still listening: look again in a moment, for a while)
    if (S.stems && !heard && fc.song && !busy && waited++ < 20) setTimeout(later, 2000);
    for (const [k, label] of STEMS) {
      const b = ui.partBtn[k], silent = heard && heard[k] === false;
      b.setAttribute('aria-pressed', String(!!S.parts[k]));
      b.classList.toggle('rx-dim', !!silent);
      b.title = silent ? `${label} is not heard in this rite: it will not be rendered` : `Include the ${label.toLowerCase()} stem`;
      lock(b);
    }
    lock(ui.cardMix); lock(ui.cardStems);
    {
      const res = typeof Palette !== 'undefined' && app.sigil && app.song && typeof Sound !== 'undefined' && Sound.state().P ? Palette.resolve(app.sigil, app.song.cfg, Sound.state().P) : null;
      ui.played.hidden = !res;
      if (res) ui.playedTxt.textContent = res.classic ? 'Played by the cube’s own voices.' : `Played by ${Palette.describe(res)}.`;
    }

    // how long
    options(ui.passSel.input, PASSES.map((n) => [String(n), `${n} pass${n === 1 ? '' : 'es'}${fc.song ? ` · ${clock(fc.lengthOf(n))}` : ''}${n === 1 ? ' · as written' : ''}`]), S.passes);
    for (const o of ui.passSel.input.options) o.disabled = Deliver.frames(fc.lengthOf(+o.value), r.rate) > Deliver.MAX_FRAMES;
    const E = evolveNow(), ev = Deliver.evolved(S.passes, E), key = ev.map((x) => x.toFixed(2)).join();
    if (ui.strip.dataset.key !== key) {
      ui.strip.dataset.key = key;
      ui.strip.replaceChildren(...ev.map((x, p) => h('span', { class: 'rx-pass', title: p ? `Pass ${p + 1}: ${pctOf(x)} evolved` : 'Pass 1: the rite as written' },
        h('div', {}, h('i', { style: `height:${Math.max(4, Math.round(x * 100))}%` })), h('b', {}, p ? pctOf(x) : '1'))));
    }
    ui.evolveRow.set(E);
    lock(ui.passSel.input); lock(ui.evolveRow.input, !app.sigil || typeof Sound === 'undefined');
    ui.evNote.textContent = S.passes === 1
      ? 'One pass is the rite as written: nothing has evolved yet. Two or more, and each pass is further on.'
      : E === 0 ? 'Evolution is at zero, so every pass is the first again.'
      : `Pass 1 is the rite as written. Each pass after it is further evolved (the bars): the movers lean, turn and wander, and the arpeggio, the choir and the drone gather, as they do when the rite goes round on the stage.${fc.loop ? ' The passes flow: the opening is heard once, at the start, and the ending once, at the end; between them the body comes round again, with nothing fading, and the kit’s last bar of each pass turns into the next with a fill.' : ''}`;

    // where to
    for (const d of Deliver.DESTINATIONS) { ui.destBtn[d.id].setAttribute('aria-pressed', String(dest === d.id)); lock(ui.destBtn[d.id]); }
    const dd = Deliver.destination(dest);
    ui.destNote.textContent = dd ? dd.note : 'Your own settings. Choose a destination to set them all at once.';
    ui.loud.set(S.target); ui.ceil.set(S.ceiling);
    ui.loud.classList.toggle('rx-off', !S.master || !S.mix);
    lock(ui.loud.input, !S.master); lock(ui.ceil.input);
    ui.loudNote.textContent = !S.mix ? 'The stems leave before the master chain, so loudness is not applied to them.'
      : !S.master ? 'The master is off: the track is the engine’s own mix, brought up to the ceiling.'
      : !F.lossless ? `Lossy codecs overshoot: the track is mastered to ${db(r.effective)} dBTP, so that what a listener decodes is still under ${db(r.ceiling)}.`
      : `Lands at ${db(r.target)} LUFS, with no peak over ${db(r.effective)} dBTP. Balance, noise and dynamics are set in Master.`;

    // in what
    for (const id of Deliver.FORMAT_IDS) {
      const b = ui.fmtBtn[id], ok = support[id] === true;
      b.setAttribute('aria-pressed', String(r.format === id));
      b.title = ok ? Deliver.FORMATS[id].note : `${Deliver.FORMATS[id].label}: ${support[id]}`;
      lock(b, !ok);
    }
    ui.fmtNote.textContent = F.note;
    ui.bitsSel.hidden = !F.bits; ui.kbpsSel.hidden = !F.kbps; ui.ditherSel.hidden = !(F.bits && r.bits === 16);
    if (F.bits) options(ui.bitsSel.input, F.bits.map((b) => [String(b), b === 32 ? '32-bit float' : `${b}-bit`]), r.bits);
    if (F.kbps) options(ui.kbpsSel.input, F.kbps.map((k) => [String(k), `${k} kbps`]), r.kbps);
    options(ui.rateSel.input, F.rates.map((x) => [String(x), `${x / 1000} kHz`]), r.rate);
    lock(ui.bitsSel.input); lock(ui.kbpsSel.input); lock(ui.rateSel.input);

    // more
    ui.flowBox.input.checked = typeof Flow === 'undefined' || Flow.enabled();
    ui.masterBox.input.checked = S.master; ui.trimBox.input.checked = S.trim; ui.ditherSel.input.value = S.dither;
    ui.stemSel.input.value = S.stemLevel; ui.packSel.input.value = S.pack;
    ui.autoBox.input.checked = S.auto; ui.tempoBox.input.checked = S.tempo; ui.lensBox.input.checked = S.lens; ui.fastBox.input.checked = S.fast;
    ui.packSel.hidden = fc.files < 2;
    ui.stemSel.hidden = !S.stems;
    for (const x of [ui.flowBox, ui.masterBox, ui.trimBox, ui.ditherSel, ui.stemSel, ui.packSel, ui.tempoBox, ui.lensBox, ui.fastBox]) lock(x.input);

    // the summary, and the button
    const what = !fc.list.length ? 'nothing chosen' : S.mix && S.stems ? `track + ${fc.list.length - 1} stem${fc.list.length === 2 ? '' : 's'}`
      : S.mix ? 'the full track' : `${fc.list.length} stem${fc.list.length === 1 ? '' : 's'}`;
    const fmt = `${F.label}${r.bits ? (r.bits === 32 ? ' 32f' : ` ${r.bits}`) : ''}${r.kbps ? ` ${r.kbps}k` : ''} · ${r.rate / 1000} kHz`;
    if (busy) { ui.sumA.textContent = statusText || 'Rendering…'; ui.sumB.textContent = etaText; ui.sumC.textContent = ''; }
    else if (fc.problem) { ui.sumA.textContent = fc.problem; ui.sumB.textContent = ui.sumC.textContent = ''; }
    else {
      ui.sumA.textContent = `${what} · ${S.passes} pass${S.passes === 1 ? '' : 'es'} · ${clock(fc.seconds)}`;
      ui.sumB.textContent = `${fmt}${S.mix && S.master ? ` · ${db(r.target)} LUFS` : ''}`;
      ui.sumC.textContent = `${fc.files} file${fc.files === 1 ? '' : 's'} · ≈ ${Deliver.size(fc.bytes)}${fc.bytes > 1.5e9 ? ' (very large)' : ''} · ≈ ${fc.time < 75 ? `${Math.max(10, Math.round(fc.time / 5) * 5)} s` : `${Math.round(fc.time / 60)} min`} to render`;
    }
    if (!busy) tools('Tools');
    ui.go.hidden = busy;
    ui.go.disabled = !!fc.problem;
    ui.go.textContent = fc.files > 1 ? `Render ${fc.files} files` : 'Render';
    ui.cancel.hidden = !busy;
    ui.status.hidden = busy;
    ui.status.textContent = busy ? '' : statusText;
  }

  /* ── building it ─────────────────────────────────────────────────────── */

  const chip = (label, onclick, attrs = {}) => h('button', { class: 'rx-chip', type: 'button', 'aria-pressed': 'false', onclick, ...attrs }, label);

  UI.section({ id: 'render', title: 'Render & Export', order: 45, build(el, det) {
    UI.css(`
      .rx-root .rx-h{font-size:10px;letter-spacing:.18em;text-transform:uppercase;opacity:.48;margin:16px 0 6px}
      .rx-root .rx-h:first-child{margin-top:4px}
      .rx-root button:disabled{opacity:.3}
      .rx-two{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      .rx-card,.rx-dest{display:flex;flex-direction:column;gap:2px;text-align:left;text-transform:none;letter-spacing:.02em;padding:9px 11px;font-size:14px;line-height:1.25}
      .rx-card small,.rx-dest small{font-size:11.5px;opacity:.55;font-style:italic;letter-spacing:.01em}
      .rx-card[aria-pressed=true],.rx-dest[aria-pressed=true],.rx-chip[aria-pressed=true]{color:rgb(var(--accent));border-color:rgba(var(--accent),.75);background:rgba(var(--accent),.07)}
      .rx-chips{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0}
      .rx-chip{padding:5px 10px;font-size:10px;letter-spacing:.14em}
      .rx-dim{opacity:.45}
      .rx-note{font-size:12px;opacity:.55;font-style:italic;line-height:1.5;margin:5px 0 8px}
      .rx-played{font-size:12px;opacity:.6;font-style:italic;line-height:1.5;margin:6px 0 2px}
      .rx-link{all:unset;cursor:pointer;text-decoration:underline dotted;opacity:.85;pointer-events:auto}.rx-link:hover,.rx-link:focus-visible{color:rgb(var(--accent));opacity:1}
      .rx-played[hidden]{display:none}
      .rx-strip{display:flex;gap:4px;margin:10px 0 2px}
      .rx-pass{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
      .rx-pass>div{display:flex;align-items:flex-end;height:34px;border-bottom:1px solid rgba(var(--line),.3)}
      .rx-pass i{display:block;width:100%;background:linear-gradient(to top,rgba(var(--accent),.6),rgba(var(--accent),.14));border-top:1px solid rgb(var(--accent))}
      .rx-pass b{font-weight:normal;font-size:10.5px;text-align:center;opacity:.6;white-space:nowrap;font-variant-numeric:tabular-nums}
      .rx-root .ctl.rx-wide{grid-template-columns:84px 1fr 86px}
      .rx-root .rx-off{opacity:.4}
      .rx-root .ctl[hidden],.rx-root .sgtoggle[hidden]{display:none}
      .rx-more{margin:14px 0 4px;border-top:1px solid rgba(var(--line),.08);padding-top:4px}
      .rx-more>summary{cursor:pointer;font-size:10px;letter-spacing:.18em;text-transform:uppercase;opacity:.55;padding:8px 0;list-style:none}
      .rx-more>summary::before{content:'+ ';}.rx-more[open]>summary::before{content:'− '}
      .rx-more input[type=text]{width:100%;background:transparent;color:inherit;border:1px solid rgba(var(--line),.22);font:inherit;font-size:13px;padding:5px 7px;pointer-events:auto}
      .rx-act-bar{position:sticky;bottom:-1px;z-index:2;margin:16px -22px 0;padding:10px 22px 9px;background:rgba(9,7,6,.97);border-top:1px solid rgba(var(--line),.14)}
      .rx-top{display:flex;gap:10px;align-items:center}
      .rx-sum{display:flex;flex-direction:column;gap:1px;font-size:12px;flex:1;min-width:0}
      .rx-sum b{font-weight:normal;font-size:14px;font-style:italic;line-height:1.3}.rx-sum span{opacity:.58;line-height:1.35}
      .rx-go{display:flex;gap:6px;flex:0 0 auto}
      .rx-go .rx-main-btn{color:rgb(var(--accent));border-color:rgba(var(--accent),.6);padding:11px 16px}
      .rx-track{height:3px;background:rgba(var(--line),.12);margin:9px 0 3px;overflow:hidden;position:relative}
      .rx-track>i{position:absolute;left:0;top:0;bottom:0;width:0;background:rgb(var(--accent));transition:width .25s}
      .rx-status{font-size:12.5px;font-style:italic;opacity:.75;margin:3px 0 0;line-height:1.45}.rx-status:empty,.rx-status[hidden]{display:none}.rx-go button[hidden]{display:none}
      .rx-queue{list-style:none;margin:8px 0 0;padding:0}
      .rx-item{display:grid;grid-template-columns:1fr auto;gap:8px;padding:8px 0;border-top:1px solid rgba(var(--line),.08)}
      .rx-head{display:flex;justify-content:space-between;gap:8px;font-size:14px}
      .rx-state{font-size:11.5px;font-style:italic;opacity:.6;text-align:right}
      .rx-prog{height:2px;background:rgba(var(--line),.12);margin:6px 0 2px;overflow:hidden}
      .rx-prog[hidden]{display:none}.rx-prog i{display:block;height:100%;width:0;background:rgb(var(--accent));transition:width .25s}
      .rx-file{display:block;font-size:11px;opacity:.5;overflow-wrap:anywhere;line-height:1.4;margin-top:2px}.rx-file em{white-space:nowrap}
      .rx-facts{display:flex;flex-wrap:wrap;gap:3px 10px;margin-top:4px;font-size:12px;font-variant-numeric:tabular-nums}
      .rx-fact{opacity:.78}.rx-fact::before{content:'✓ ';color:rgb(var(--accent));opacity:.8}
      .rx-fact.rx-warn{color:#f0b070;opacity:1}.rx-fact.rx-warn::before{content:'! ';color:#f0b070}
      .rx-act{display:flex;gap:4px;align-items:flex-start}.rx-ico{padding:5px 9px;font-size:12px;letter-spacing:0;min-width:30px}
      .rx-ico[hidden]{display:none}
      .rx-skipped .rx-label,.rx-cancelled .rx-label{opacity:.45}.rx-failed .rx-state{color:#ff8a70;opacity:1}
      .rx-playing .rx-label{color:rgb(var(--accent))}
      .rx-foot{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.rx-foot button[hidden]{display:none}
    `);
    el.classList.add('rx-root');
    ui.det = det;

    /* what */
    const cardMix = ui.cardMix = h('button', { class: 'rx-card', type: 'button', 'aria-pressed': 'true', onclick: () => { S.mix = !S.mix; save(); refresh(); } },
      'Full track', h('small', {}, 'Mastered, ready to play'));
    const cardStems = ui.cardStems = h('button', { class: 'rx-card', type: 'button', 'aria-pressed': 'false', onclick: () => { S.stems = !S.stems; save(); refresh(); } },
      'Stems', h('small', {}, 'Each part on its own, for a DAW'));
    ui.partBtn = {};
    ui.parts = h('div', {},
      h('div', { class: 'rx-chips', role: 'group', 'aria-label': 'Stems to render' },
        STEMS.map(([k, label]) => (ui.partBtn[k] = chip(label, () => { S.parts[k] = !S.parts[k]; save(); refresh(); })))),
      h('div', { class: 'sgrow' },
        UI.button('All', () => { for (const [k] of STEMS) S.parts[k] = true; save(); refresh(); }),
        UI.button('None', () => { for (const [k] of STEMS) S.parts[k] = false; save(); refresh(); })),
      h('p', { class: 'rx-note' }, 'Parts of one mix, the same length and all starting at zero. They leave before the master chain: no EQ, compression or limiting, so they can be mastered elsewhere. A part the rite does not sing is skipped.'));

    /* length */
    ui.passSel = UI.select({ label: 'Length', value: S.passes, options: PASSES.map((n) => [String(n), String(n)]),
      title: 'How many times the rite goes round. The first is the rite as written; each pass after it is further evolved.',
      onChange: (v) => { S.passes = +v; save(); refresh(); } });
    ui.strip = h('div', { class: 'rx-strip', role: 'img', 'aria-label': 'How far each pass has evolved' });
    ui.evolveRow = UI.slider({ label: 'Evolution', min: 0, max: 1, step: 0.01, value: 0.5, format: pctOf,
      title: 'How much each pass differs from the one before. The same control as in Motion: on the stage as the rite loops, and across the passes of a render.',
      onInput: (v) => { if (typeof Sound === 'undefined' || !app.sigil) return; if (v === 0.5) Sound.unset('evolve'); else Sound.set('evolve', v); } });
    ui.evNote = h('p', { class: 'rx-note' });

    /* where to */
    ui.destBtn = {};
    const dests = Deliver.DESTINATIONS.map((d) => (ui.destBtn[d.id] = h('button', { class: 'rx-dest', type: 'button', 'aria-pressed': 'false', onclick: () => setDest(d) },
      d.label, h('small', {}, `${d.target} LUFS · ${Deliver.FORMATS[d.format].label}${d.bits ? ' ' + d.bits : ''}${d.kbps ? ' ' + d.kbps + 'k' : ''}`.replace('-', '−')))));
    ui.destNote = h('p', { class: 'rx-note' });
    ui.loud = UI.slider({ label: 'Loudness', min: -23, max: -8, step: 0.5, value: S.target,
      format: (v) => `${db(v)} LUFS`, title: 'The integrated loudness the track lands at. Streaming services play everything at about −14; louder costs dynamics.',
      onInput: (v) => { S.target = v; save(); refresh(); } });
    ui.loud.classList.add('rx-wide');
    ui.ceil = UI.slider({ label: 'Ceiling', min: -6, max: -0.1, step: 0.1, value: S.ceiling,
      format: (v) => `${db(v)} dBTP`, title: 'The true peak the track is held under: what a converter or a codec would reconstruct between the samples.',
      onInput: (v) => { S.ceiling = Math.round(v * 10) / 10; save(); refresh(); } });
    ui.ceil.classList.add('rx-wide');
    ui.loudNote = h('p', { class: 'rx-note' });

    /* format */
    ui.fmtBtn = {};
    ui.fmtRow = h('div', { class: 'rx-chips', role: 'group', 'aria-label': 'File format' },
      Deliver.FORMAT_IDS.map((id) => (ui.fmtBtn[id] = chip(Deliver.FORMATS[id].label, () => { S.format = id; const F = Deliver.FORMATS[id]; if (F.bits && !F.bits.includes(S.bits)) S.bits = 24; save(); refresh(); }))));
    ui.bitsSel = UI.select({ label: 'Bit depth', value: S.bits, options: [['24', '24-bit']], onChange: (v) => { S.bits = +v; save(); refresh(); } });
    ui.kbpsSel = UI.select({ label: 'Bitrate', value: '', options: [['256', '256 kbps']], onChange: (v) => { S.kbps[S.format] = +v; save(); refresh(); } });
    ui.rateSel = UI.select({ label: 'Sample rate', value: S.rate, options: [['44100', '44.1 kHz']], title: 'The rite is rendered at this rate, not converted to it.', onChange: (v) => { S.rate = +v; save(); refresh(); } });
    ui.fmtNote = h('p', { class: 'rx-note' });

    /* more */
    ui.masterBox = UI.check({ label: 'Use the master', checked: S.master, title: 'Off: the track is the engine’s own mix, brought up to the ceiling, and the stems are not balanced by the master’s plan either.',
      onChange: (v) => { S.master = v; save(); refresh(); } });
    ui.flowBox = UI.check({ label: 'Flow between passes', checked: typeof Flow === 'undefined' || Flow.enabled(),
      title: 'The passes go round the body of the rite: the opening once, at the start, the ending once, at the end, and no fade between. Off: every pass is the whole rite, opening and ending and all. (It is the same on the stage, as the rite loops.)',
      onChange: (v) => { Flow.set(v); if (app.engine && app.mode === 'playing') SigilPlan.replan(app.engine); refresh(); } });
    ui.trimBox = UI.check({ label: 'Trim the silence at the end', checked: S.trim, title: 'The track ends where the hall stops ringing, with the last breath glided to zero, not on seconds of nothing.',
      onChange: (v) => { S.trim = v; save(); refresh(); } });
    ui.ditherSel = UI.select({ label: 'Dither', value: S.dither, options: [['tpdf', 'Flat (TPDF)'], ['shaped', 'Shaped, out of the ears’ band'], ['off', 'None']],
      title: 'For a 16-bit file. Flat is the usual; shaped moves the noise above about 10 kHz, where it is far less heard.', onChange: (v) => { S.dither = v; save(); refresh(); } });
    ui.stemSel = UI.select({ label: 'Stem level', value: S.stemLevel, options: [['together', 'Raised together'], ['asmixed', 'As mixed'], ['each', 'Each to full scale']],
      title: 'Raised together: one common gain, so the stems still add up to the mix, nearer full scale. As mixed: exactly as they enter the master chain. Each to full scale: normalised on its own; they will no longer add up.',
      onChange: (v) => { S.stemLevel = v; save(); refresh(); } });
    ui.titleIn = h('input', { type: 'text', maxlength: 80, placeholder: 'SIGIL …', 'aria-label': 'Title', value: S.title, oninput: (e) => { S.title = e.target.value; save(); } });
    ui.artistIn = h('input', { type: 'text', maxlength: 80, placeholder: 'Artist', 'aria-label': 'Artist', value: S.artist, oninput: (e) => { S.artist = e.target.value; save(); } });
    ui.packSel = UI.select({ label: 'Several files', value: S.pack, options: [['zip', 'One ZIP'], ['files', 'Separate files']], onChange: (v) => { S.pack = v; save(); refresh(); } });
    ui.autoBox = UI.check({ label: 'Download when finished', checked: S.auto, onChange: (v) => { S.auto = v; save(); } });
    ui.tempoBox = UI.check({ label: 'Use the current tempo', checked: S.tempo, title: 'Render at the tempo it is playing at, if you have moved it', onChange: (v) => { S.tempo = v; save(); refresh(); } });
    ui.lensBox = UI.check({ label: 'Apply the live lens', checked: S.lens, title: 'Render the turns and mirrors you have made with the Lens', onChange: (v) => { S.lens = v; save(); } });
    ui.fastBox = UI.check({ label: 'Fast render (uses several CPU cores)', checked: S.fast, onChange: (v) => { S.fast = v; save(); } });
    const more = h('details', { class: 'rx-more' },
      h('summary', {}, 'More'),
      ui.flowBox, ui.masterBox,
      h('div', { class: 'sgrow' }, UI.button('Balance, noise and finish…', () => UI.open('master'), { title: 'Open the Master panel: how the track is balanced and toned' })),
      ui.trimBox, ui.ditherSel, ui.stemSel,
      h('div', { class: 'rx-h' }, 'Tags'), ui.titleIn, h('div', { style: 'height:6px' }), ui.artistIn,
      h('p', { class: 'rx-note' }, 'Written into the file, with the tempo and the key of the sigil, so a DJ or a DAW knows them without opening anything.'),
      ui.packSel, ui.autoBox, ui.tempoBox, ui.lensBox, ui.fastBox,
      h('div', { class: 'sgrow' }, UI.button('Reset these settings', () => {
        const keep = { title: S.title, artist: S.artist };
        for (const k of Object.keys(S)) delete S[k];
        Object.assign(S, JSON.parse(JSON.stringify(DEFAULTS)), keep);
        ui.titleIn.value = S.title; ui.artistIn.value = S.artist;
        save(); refresh(); UI.announce('Render settings reset.');
      }, { title: 'Everything on this panel back to how it began (your title and artist are kept)' })));

    /* who plays it (M23): what the render will be played by, and a way to change it */
    ui.playedTxt = h('span', {});
    ui.played = h('div', { class: 'rx-played', hidden: true }, ui.playedTxt, ' ',
      h('button', { type: 'button', class: 'rx-link', onclick: () => UI.open('palette'), title: 'Choose another company of instruments, or any part’s instrument' }, 'Change'));

    /* the bar: summary, button, progress */
    ui.sumA = h('b'); ui.sumB = h('span'); ui.sumC = h('span');
    ui.sum = h('div', { class: 'rx-sum' }, ui.sumA, ui.sumB, ui.sumC);
    ui.go = h('button', { class: 'rx-main-btn', type: 'button', onclick: go }, 'Render');
    ui.cancel = h('button', { class: 'rx-cancel', type: 'button', hidden: true, onclick: () => { if (run) run.cancel(); } }, 'Cancel');
    ui.fill = h('i');
    ui.track = h('div', { class: 'rx-track', role: 'progressbar', 'aria-label': 'Render progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, ui.fill);
    ui.status = h('div', { class: 'rx-status', role: 'status', 'aria-live': 'off' });

    ui.queue = h('ul', { class: 'rx-queue', 'aria-label': 'Rendered files' });
    ui.zip = h('button', { type: 'button', class: 'sm', hidden: true, onclick: async () => {
      if (!packed) return;
      const { j, done } = packed;
      ui.zip.disabled = true;
      try { download(await Codecs.zip([...done.map((it) => ({ name: it.name, data: it.blob })), { name: 'README.txt', data: readme(j, done) }]), `${j.base}-render.zip`); }
      finally { ui.zip.disabled = false; }
    } }, 'Download all (.zip)');
    ui.clear = h('button', { type: 'button', class: 'sm', hidden: true, onclick: clearResults, title: 'Let go of the rendered files (they are kept in memory until you do)' }, 'Clear');
    ui.results = h('div', { hidden: true }, ui.queue, h('div', { class: 'rx-foot' }, ui.zip, ui.clear));

    el.append(
      UI.note('Render the whole rite, or each of its parts, faster than real time, exactly as the stage performs it: your mix, your tempo and lens, and every mover moving as it does live. The track leaves through the master, by the same plan.'),
      h('div', { class: 'rx-h' }, 'What'), h('div', { class: 'rx-two' }, cardMix, cardStems), ui.parts, ui.played,
      h('div', { class: 'rx-h' }, 'How long'), ui.passSel, ui.strip, ui.evolveRow, ui.evNote,
      h('div', { class: 'rx-h' }, 'Where it is going'), h('div', { class: 'rx-two' }, dests), ui.destNote, ui.loud, ui.ceil, ui.loudNote,
      h('div', { class: 'rx-h' }, 'In what'), ui.fmtRow, ui.bitsSel, ui.kbpsSel, ui.rateSel, ui.fmtNote,
      more,
      h('div', { class: 'rx-act-bar' }, h('div', { class: 'rx-top' }, ui.sum, h('div', { class: 'rx-go' }, ui.go, ui.cancel)), ui.track, ui.status),
      ui.results);
    paintAll();

    det.addEventListener('toggle', () => { if (det.open) refresh(); });
    Codecs.support().then((s) => { support = s; refresh(); });
  } });

  /* ── Keeping in step ─────────────────────────────────────────────────── */

  Hooks.on('song', () => { if (!busy) statusText = ''; waited = 0; later(); });
  Hooks.on('meta', later);                                            // the tempo moved (M2 rebuilds the meta line)
  Hooks.on('stop', later);
  Hooks.on('forget', () => { if (run) run.cancel(); setTimeout(() => { clearResults(); refresh(); }, 0); setTimeout(later, 7400); });   // forgetting means forgetting (and the song is gone a moment after)
  // (m11 loads after this file: what Sound says is listened for once every module is here.)
  UI.whenReady(() => { if (typeof Sound !== 'undefined') Sound.subscribe(later); refresh(); });
  // A render in progress must not be lost to a closed tab by accident.
  window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

  return { go, cancel: () => { if (run) run.cancel(); }, renderAudio, forecast, settings: S, items: () => items, busy: () => busy };
})();

window.Render = Render;
