'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m11 · SOUND — the patch, and nothing else
   --------------------------------------------------------------------------
   This module used to build a node graph for every note. The kernel does the
   synthesis now, and Score decides how each event is voiced. What remains here
   is STATE: the sigil's patch (derived + mood + your knobs), the dream variant,
   the patch bank and library, and the feeds the visuals read.

   Any change to the patch calls engine.refresh(): the score is recompiled and
   swapped in without losing position.
   ══════════════════════════════════════════════════════════════════════════ */
const Sound = (() => {
  'use strict';
  const SD = SoundDesign;

  const prefs = {
    lite: Prefs.get('sound.lite', (navigator.hardwareConcurrency || 4) <= 2),
    lensWave: Prefs.get('sound.lensWave', false),
    vowelMemory: Prefs.get('sound.vowelMemory', true),
    arc: Prefs.get('sound.arc', true),
    sigilVerb: Prefs.get('sound.sigilVerb', true),
    keys: false,
  };

  let bank = Prefs.get('soundbank', {});
  let library = Prefs.get('soundlib', []);
  const cur = { key: null, variant: 0, o: {}, base: null, P: null, tables: null, mags: null, ring: null, mut: 0 };
  let renderSpec = null, pending = null, frozen = false, vowelMemory = null, keyVowel = null;

  const subs = new Set();
  const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error('[sound:ui]', e); } });
  const keyOf = (sig) => sig.fusionKey || sig.reduced;
  const engine = () => app.engine;
  /** Tell the engine the notes have changed. */
  const push = () => { const e = engine(); if (e && e.song) e.refresh(); };

  /* ── Patch state ─────────────────────────────────────────────────────── */
  function persist() {
    if (!cur.key) return;
    if (!Object.keys(cur.o).length && !cur.variant) delete bank[cur.key];
    else bank[cur.key] = { variant: cur.variant, o: { ...cur.o } };
    Prefs.set('soundbank', bank);
  }
  const saveLibrary = () => Prefs.set('soundlib', library);

  function magnitudes(tb, x, y) {
    const c = tb.cell(x, y), out = new Float32Array(SD.H);
    let mx = 1e-9;
    for (let h = 1; h <= SD.H; h++) {
      const m = Math.hypot(c.re[h], c.im[h]);
      out[h - 1] = m;
      if (m > mx) mx = m;
    }
    for (let i = 0; i < out.length; i++) out[i] /= mx;
    return out;
  }

  /** The wheel's waveform: a clean cycle and its crushed version, 128 points each. */
  function ringFor(tb, P) {
    const a = tb.cell(P.wave, P.layer), b = tb.cell(P.wave + P.sweep * 4, P.layer + P.drift * 2.5);
    const N = 128, raw = SD.waveSamples(a, b, 0.5, N), clean = new Float32Array(N);
    let mx = 1e-9;
    for (let i = 0; i < N; i++) {
      clean[i] = raw[i] + P.sub * 0.6 * Math.sin((Math.PI * i) / N);
      if (Math.abs(clean[i]) > mx) mx = Math.abs(clean[i]);
    }
    for (let i = 0; i < N; i++) clean[i] /= mx;
    const crushed = SD.applyFx(clean, { bits: P.grit > 0 ? P.bits : 16, hold: P.hold, fold: P.fold, drive: P.drive, mix: P.grit });
    return { clean, crushed };
  }

  /** derived from the sigil ← the mood's overlay ← your knobs */
  function composePatch(sig, variant, overrides) {
    const mood = (app.song && app.song.cfg && app.song.cfg.sound) || {};
    const base = { ...Score.PATCH_DEFAULTS, ...SD.derive(sig.hash, variant), ...mood };
    return { base, P: { ...base, ...overrides }, tables: SD.tables(sig, variant) };
  }

  function recompute() {
    const sig = app.sigil;
    if (!sig) return;
    const c = composePatch(sig, cur.variant, cur.o);
    cur.base = c.base; cur.P = c.P; cur.tables = c.tables;
    cur.mags = magnitudes(cur.tables, cur.P.wave, cur.P.layer);
    cur.ring = ringFor(cur.tables, cur.P);
  }

  function syncFrom(sig) {
    if (!sig) return;
    const key = keyOf(sig);
    if (key !== cur.key || !cur.P) {
      cur.key = key;
      const e = bank[key] || {};
      cur.variant = e.variant | 0;
      cur.o = { ...(e.o || {}) };
      cur.mut = 0;
    }
    if (pending && pending.key === key) {
      cur.variant = pending.variant; cur.o = { ...pending.o };
      pending = null; persist();
    }
    recompute();
  }

  /** Persist, recompute, recompile, repaint: the path every edit takes. */
  function touch() { persist(); recompute(); push(); notify(); }

  /** What Score compiles with. During an export, m14 may substitute a render spec. */
  function patchFor(song, sig, render) {
    if (render && renderSpec) return renderSpec;
    if (!cur.P || cur.key !== keyOf(sig)) syncFrom(sig);
    return { P: cur.P, variant: cur.variant };
  }

  /* ── Feeds for the visuals, derived from the score rather than logged ─── */
  const LOGGED = { lead: 1, harm: 1, pad: 1, kick: 1, snare: 1 };
  let onsets = [];
  const played = [], recent = [];
  Hooks.on('song', (_s, song) => {
    onsets = song.events.filter((e) => LOGGED[e.type]).map((e) => ({ beat: e.beat, at: 0, kind: e.type }));
  });

  /** Onsets of the last beat and a half, for the ripples. Reuses one array. */
  function recentNotes() {
    recent.length = 0;
    const e = engine();
    if (e && e.song && onsets.length) {
      const beat = e.beatNow(), from = beat - 1.6;
      let lo = 0, hi = onsets.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (onsets[m].beat < from) lo = m + 1; else hi = m; }
      for (let i = lo; i < onsets.length && onsets[i].beat <= beat + 0.02 && recent.length < 48; i++) recent.push(onsets[i]);
    }
    const now = performance.now();
    while (played.length && now - played[0].at > 1600) played.shift();
    for (const p of played) recent.push(p);
    return recent;
  }

  const vowelOut = { name: '', at: 0 };
  /** The vowel most recently sung: { name, at (performance time) } or null. */
  function lastVowel() {
    const e = engine(), info = e && e.plan;
    let best = keyVowel;
    if (info && e.song && info.vowels.length) {
      const v = info.vowels, beat = e.beatNow();
      let lo = 0, hi = v.length >> 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (v[m * 2] <= beat) lo = m + 1; else hi = m; }
      if (lo > 0) {
        const age = (beat - v[(lo - 1) * 2]) * e.spb * 1000, at = performance.now() - age;
        if (age < 1500 && (!best || at > best.at)) {
          vowelOut.name = SD.VOWELS[v[(lo - 1) * 2 + 1]].name;
          vowelOut.at = at;
          best = vowelOut;
        }
      }
    }
    return best;
  }

  /* ── Playing by hand ─────────────────────────────────────────────────── */
  const live = () => { const e = engine(); return e && app.sigil && e.song ? e : null; };

  function noteOn({ midi, deg = 0, vel = 0.8 }) {
    const eng = live();
    if (!eng || eng.ctx.state !== 'running') return null;
    const ke = Score.noteEvent({ midi, deg, vel }, eng);
    if (!ke) return null;
    played.push({ beat: null, at: performance.now(), kind: 'lead' });
    if (ke[0] === 'vox') keyVowel = { name: SD.VOWELS[ke[1].v0].name, at: performance.now() };
    return eng.note(ke[0], ke[1], { held: true });
  }

  /* ── Hooks ───────────────────────────────────────────────────────────── */
  // Runs inside engine.load(), before the score is compiled, so the plan is built from this sigil's patch.
  Hooks.on('buses', () => syncFrom(app.sigil));

  Hooks.on('beforeCast', (ctx) => {
    const seq = [];
    for (const ch of ctx.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()) {
      const i = 'AEIOU'.indexOf(ch);
      if (i >= 0) seq.push(i);
    }
    vowelMemory = seq.length ? seq : null;
  });
  Hooks.on('link', (link) => {
    const d = link.sound ? SD.decodePatch(link.sound) : null;
    pending = d ? { key: link.members.join('+'), ...d } : null;
    vowelMemory = null;
  });
  Hooks.on('shareKey', (key, sig) => {
    if (!sig || keyOf(sig) !== cur.key) return undefined;
    const code = SD.encodePatch(cur.o, cur.variant);
    return code ? key + '!' + code : undefined;
  }, 20);
  Hooks.on('forget', (sig) => {
    if (!sig) return;
    delete bank[keyOf(sig)];
    Prefs.set('soundbank', bank);
    vowelMemory = null;
  });

  const setPref = (name, v) => { prefs[name] = !!v; Prefs.set('sound.' + name, prefs[name]); push(); notify(); };

  return {
    SD, live, noteOn, patchFor, recentNotes, lastVowel,
    /** Kept for callers that awaited the old worklet: resolves when the kernel is running. */
    prepare: async () => { const e = engine(); if (e && !(await e.ready)) throw e.error; return true; },
    /** The struck vowels, as indices into SD.VOWELS, when vowel memory is on and known. */
    vowelSeq: () => (prefs.vowelMemory && vowelMemory && vowelMemory.length ? vowelMemory : null),
    paramsAt(eng, beat) {
      const P = eng && Score.patchAt(eng.plan, beat);
      return P ? { ...P } : null;
    },
    view: () => cur,
    state: () => ({ key: cur.key, variant: cur.variant, o: cur.o, P: cur.P, base: cur.base, tables: cur.tables, mags: cur.mags }),
    get mode() { return 'sigil'; },
    get lite() { return prefs.lite; },
    get keysOn() { return prefs.keys; },
    get frozen() { return frozen; },
    get lensWave() { return prefs.lensWave; },
    get vowelMemoryOn() { return prefs.vowelMemory; },
    get arcOn() { return prefs.arc; },
    get sigilVerbOn() { return prefs.sigilVerb; },
    hasVowelMemory: () => !!(vowelMemory && vowelMemory.length),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setMode() { notify(); },                     // the node engine is gone; kept so older panels do not throw
    setLite(v) { setPref('lite', v); },
    setLensWave(v) { setPref('lensWave', v); },
    setVowelMemory(v) { setPref('vowelMemory', v); },
    setArc(v) { setPref('arc', v); },
    setSigilVerb(v) { setPref('sigilVerb', v); },
    toggleKeys(force) { prefs.keys = force ?? !prefs.keys; notify(); return prefs.keys; },
    toggleFreeze(force) { frozen = force ?? !frozen; push(); notify(); return frozen; },
    set(name, v) { if (!app.sigil) return; cur.o[name] = v; touch(); },
    setMany(obj) { if (!app.sigil) return; Object.assign(cur.o, obj); touch(); },
    reset() { cur.o = {}; cur.mut = 0; touch(); },
    mutate() {
      if (!app.sigil) return;
      cur.mut++;
      cur.o = SD.mutate(app.sigil.hash, cur.mut, cur.base, cur.o);
      touch();
    },
    dream(delta) {
      if (!app.sigil) return;
      cur.variant = mod(cur.variant + delta, 100);
      touch();
    },
    code: () => SD.encodePatch(cur.o, cur.variant),
    setRenderSpec(spec) {
      if (!spec || !app.sigil) { renderSpec = null; return; }
      const variant = spec.variant ?? cur.variant;
      renderSpec = { P: composePatch(app.sigil, variant, { ...cur.o, ...(spec.o || {}) }).P, variant };
    },
    clearRenderSpec() { renderSpec = null; },
    library: () => library.slice(),
    save(name) { library.push({ name: String(name).slice(0, 40), o: { ...cur.o } }); saveLibrary(); notify(); },
    applyLibrary(i) { const it = library[i]; if (!it || !app.sigil) return; cur.o = { ...it.o }; touch(); },
    removeLibrary(i) { library.splice(i, 1); saveLibrary(); notify(); },
    importLibrary(data) {
      const list = Array.isArray(data) ? data : (data && data.patches) || [];
      let n = 0;
      for (const it of list) {
        const d = it && SD.decodePatch(SD.encodePatch(it.o || {}, 0));
        if (d && it.name) { library.push({ name: String(it.name).slice(0, 40), o: d.o }); n++; }
      }
      saveLibrary(); notify();
      return n;
    },
  };
})();
if (typeof window !== 'undefined') window.Sound = Sound;