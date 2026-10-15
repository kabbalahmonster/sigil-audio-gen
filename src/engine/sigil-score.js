'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   SCORE — song → plan
   --------------------------------------------------------------------------
   The one place that decides what each score event SOUNDS like. It reads the
   song (beats, degrees, chords), the sigil, the patch (Sound), the drum
   settings (DrumEngine) and the Live Lens, and writes kernel events.

   Everything here is main-thread work, done once per change, never per note
   at play time. A typical song compiles in a few milliseconds.

   EXTENSION
     Hooks.filter('kernel:event', false, ev, cx) — return true after calling
       cx.add(kind, params) to take over how one score event is voiced.
     Hooks.emit('kernel:plan', info, engine)      — after every compile.
   ══════════════════════════════════════════════════════════════════════════ */
const Score = (() => {
  'use strict';
  const SD = SoundDesign, KN = SigilKernel;

  const PATCH_DEFAULTS = { tilt: 0, density: 1, kSub: 1, kPunch: 1, kDecay: 1, kTone: 0,
                           sBody: 1, sSnap: 1, sTone: 1, hTone: 1, hDecay: 1 };
  const DRUM_DEFAULTS = { duck: 0.5, sidechain: true, sectionAware: true, tuneToKey: true, kickOct: 'auto' };
  /** Section-aware sidechain: the rite's shape, as a duck multiplier. */
  const SECTION_DUCK = [0, 0.45, 1.0, 0.7, 0.9, 1.15, 0.35];
  const KSTYLE = [
    { glide: 1.7, glideT: 0.09, decay: 1.0, click: 0.5 },   // 808 glide
    { glide: 2.6, glideT: 0.03, decay: 0.5, click: 1.0 },   // tight
    { glide: 1.3, glideT: 0.06, decay: 1.4, click: 0.3 },   // boom
    { glide: 3.2, glideT: 0.02, decay: 0.65, click: 1.5 },  // punch
  ];
  const SSTYLE = [
    { body: 1.0, bodyDec: 0.035, noise: 1.0, snap: 0.9, rim: 0 },   // tight
    { body: 1.6, bodyDec: 0.075, noise: 0.8, snap: 0.6, rim: 0 },   // fat
    { body: 0.55, bodyDec: 0.02, noise: 0.6, snap: 1.2, rim: 1 },   // rim
    { body: 0.35, bodyDec: 0.02, noise: 1.35, snap: 1.1, rim: 0 },  // snap
  ];
  const CONS = { liquid: 0, plosive: 1, fricative: 2, nasal: 3 };
  const MAX_TABLES = 160;

  /* ── Wavetables: built here, cached, sent to each kernel once ─────────── */
  const cache = new Map();       // key → { id, packed }
  let nextId = 2;                // 0 = sine and 1 = glottal are built into the kernel
  /** A session remembers which tables one kernel already holds. The live engine keeps one; each render makes its own. */
  const session = () => ({ sent: new Set() });

  /** Table id for one cube cell, shaped by Tilt (spectral slope) and Density (upper partial tier). */
  function cellTable(tb, cube, x, y, P, need) {
    const cx = clamp(Math.round(x), 0, SD.FX - 1), cy = clamp(Math.round(y), 0, SD.FY - 1);
    const tilt = P.tilt ?? 0, dens = P.density ?? 1;
    const key = `${cube}|${cx},${cy},${Math.round(tilt * 20)},${Math.round(dens * 20)}`;
    let t = cache.get(key);
    if (!t) {
      const c = tb.grid[cy][cx], n = c.re.length;
      const re = new Float32Array(n), im = new Float32Array(n);
      for (let h = 1; h < n; h++) {
        const g = Math.pow(h, -tilt) * (h >= SD.UPPER ? dens : 1);
        re[h] = c.re[h] * g; im[h] = c.im[h] * g;
      }
      t = { id: nextId++, packed: KN.buildTables(re, im) };
      cache.set(key, t);
    }
    need.set(t.id, t);
    return t.id;
  }

  /* ── Musical context ──────────────────────────────────────────────────── */

  /** The chord sounding at a beat. Phrases are sorted, so a binary search finds it. */
  function chordAt(song, beat) {
    const P = song.phrases;
    let lo = 0, hi = P.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (P[m].start <= beat) lo = m; else hi = m - 1;
    }
    const ph = P[lo];
    return ph.chords[clamp(Math.floor((beat - ph.start) / 4), 0, 3)];
  }
  /** MIDI of the chord root in the bass register, or the tonic when tuning is off. */
  function rootAt(song, beat, tune = true, lens = false) {
    if (!tune) return song.bassBase;
    let c = chordAt(song, beat);
    if (lens) c = LiveLens.mapChord(c, song);
    return bassPitch(c, 'root', song.bassBase, song.scale);
  }

  /** Which voice a lead note uses, given the patch and the score's own timbre. */
  function pickVoice(P, ev) {
    if (P.voice && P.voice !== 'auto') return P.voice;
    if (ev.timbre === 'reed') return 'vox';
    if (ev.timbre === 'koto') return 'bell';
    return 'wave';
  }

  /**
   * One melodic note → [instrument, parameters]. Shared by the compiler and by
   * notes played by hand, so both always sound the same.
   * cx = { spb, lite, R (reduced letters), vmem (struck vowels or null), vowels (sink or null) }
   */
  function voice(cx, ev, S, bus, kind) {
    const P = S.P, f = mtof(ev.midi), vel = ev.vel ?? 0.8;
    const d = ev.dur > 0 ? ev.dur * cx.spb : 3;
    const bright = P.bright ?? 0.6, sub = (P.sub ?? 0) > 0.02 ? P.sub : 0, deg = ev.deg ?? 0;
    const o = {
      beat: ev.beat || 0, bus, freq: f, from: ev.from != null ? mtof(ev.from) : 0, dur: ev.dur || 0, vel,
      pan: ev.pan || (ev.part ? (ev.part === 1 ? -0.3 : 0.3) : 0),
    };
    switch (kind) {
      case 'vox': {
        // The consonant at this beat articulates the onset; the vowel comes from the
        // vowels that were struck out when they are known, otherwise from the degree.
        const letter = cx.R[mod(Math.round(o.beat * 2), cx.R.length)];
        const cls = SD.CONSONANT_CLASS[letter] || 'fricative', tone = SD.CLASS_TONE[cls];
        let i0 = mod(deg + ((P.vowel ?? 0) | 0), 5);
        if (cx.vmem && cx.vmem.length) i0 = cx.vmem[mod(Math.round(o.beat * 2), cx.vmem.length)];
        const i1 = d > 0.6 ? mod(i0 + 1, 5) : i0;
        if (cx.vowels) cx.vowels.push(o.beat, i0);
        const breath = P.breath ?? 0.2;
        Object.assign(o, {
          ta: 1, v0: i0, v1: i1, throat: Math.pow(2, (P.throat ?? 0) * 0.35), q: 6 + 7 * bright,
          cons: CONS[cls],
          consLvl: (cls === 'fricative' ? 0.13 : cls === 'plosive' ? 0.18 : 0.05) * (0.5 + breath),
          consF: (cls === 'plosive' ? 1800 : 3600) * tone[0],
          breath: breath > 0.01 ? breath * 0.06 : 0,
          sub: sub * 0.22,
          peak: 0.42 * (bus === 'harm' ? 0.7 : 1) * (0.7 + 0.4 * bright),
          vib: cx.lite ? 0 : 0.006,
        });
        return ['vox', o];
      }
      case 'fm':
        Object.assign(o, {
          ta: S.base, ratio: 1 + (Math.round(P.wave) % 5) + (Math.round(P.layer) % 2) * 0.5,
          index: f * (0.6 + 3.4 * bright) * vel, indexEnd: 0.08, indexTau: 0.06 + 0.3 * d,
          cut: Math.min(16000, f * (6 + 12 * bright)), sub: sub * 0.4, a: 0.012, d: 0.083, s: 0.78, r: 0.073, peak: 0.3,
        });
        return ['fm', o];
      case 'bow':
        Object.assign(o, { ta: S.base, cut: f * (2.5 + 8 * bright), q: 1.6, wob: 0.3 + (P.breath ?? 0.2), det: cx.lite ? 0 : 7,
            a: 0.12, d: 0.1, s: 0.9, r: 0.117, peak: 0.3 });
        return ['bow', o];
      case 'bell':
        Object.assign(o, { ta: S.base, ring: Math.max(d * 1.6, 1.1) * (0.6 + 0.8 * (P.hDecay ?? 1)), bright, sub, peak: 0.7 });
        return ['bell', o];
      default:
        Object.assign(o, {
          ta: S.a, tb: cx.lite ? S.a : deg % 2 === 0 ? S.up : S.dn,     // every note travels a vector through the cube
          cut: f * (1.5 + 9 * bright), sub: sub * 0.55, peak: 0.32,
          vib: !cx.lite && ev.dur > 0 && d > 0.45 ? 0.004 : 0, cutTau: Math.max(0.05, d * 0.3),
        });
        return ['wave', o];
    }
  }

  /** One drum hit → kernel events. */
  function drum(cx, ev, S, plan) {
    const P = S.P, D = cx.D, lvl = P.drums ?? 1;
    if (ev.type === 'swell') {   // the breath before a chorus; not part of the kit, so the drum level does not gate it
      plan.add('noise', { beat: ev.beat, bus: 'bell', dur: ev.dur, vel: (ev.vel ?? 0.8) * 0.09, type: 1, f0: 300, f1: 6000, q: 1.5, shape: 1 });
      return;
    }
    if (lvl <= 0.001) return;
    const beat = ev.beat, vel = ev.vel ?? 0.8, kit = S.kit;
    const root = rootAt(cx.song, beat, D.tuneToKey, cx.lensOn);
    const letter = cx.R[mod(Math.round(beat * 4), cx.R.length)];
    const tone = SD.CLASS_TONE[SD.CONSONANT_CLASS[letter] || 'fricative'];   // plosives are sharp, liquids are soft
    const hTone = P.hTone ?? 1, hDecay = P.hDecay ?? 1;
    switch (ev.type) {
      case 'kick': {
        const st = KSTYLE[kit.kickStyle], kPunch = P.kPunch ?? 1;
        const oct = D.kickOct === 'low' ? 0.5 : D.kickOct === 'high' ? 2 : 1;
        const dec = (0.2 + 0.55 * kit.kickDecay) * st.decay * (P.kDecay ?? 1);
        plan.add('kick', {
          beat, bus: 'drums', vel: vel * lvl,
          freq: mtof(root + (D.tuneToKey ? kit.kickSemi : 0)) * oct * Math.pow(2, (P.kTone ?? 0) / 12) * (kit.kickStyle === 2 ? 0.5 : 1),
          glide: st.glide, glideT: st.glideT, decay: dec, sub: kit.kickSub * (P.kSub ?? 1),
          click: st.click * kPunch, clickF: 1400 + 2200 * (P.drumY ?? 0.5), harm: 0.05 + 0.05 * kit.kickDecay,
          duck: D.sidechain ? D.duck * S.duckMul * lvl * (0.45 + 0.55 * vel) * (0.6 + 0.4 * kPunch) : 0, duckLen: 0.1 + dec,
        });
        break;
      }
      case 'snare': {
        const st = SSTYLE[kit.snareStyle], sSnap = P.sSnap ?? 1, sTone = P.sTone ?? 1, sBody = P.sBody ?? 1;
        plan.add('snare', {
          beat, bus: 'drums', vel: vel * lvl, pan: (ev.pan || 0) * 0.4, freq: mtof(root + kit.snareBody),
          body: 0.5 * st.body * sBody, bodyDec: st.bodyDec * (0.6 + 0.8 * sSnap),
          noise: 0.55 * st.noise * tone[2], noiseDec: (0.05 + 0.17 * sSnap) * tone[1],
          snap: 0.28 * st.snap, toneF: (1200 + 1000 * sTone) * tone[0], snapF: 4800 + 1800 * sTone, rim: st.rim,
          duck: D.sidechain ? D.duck * S.duckMul * 0.3 * lvl : 0, duckLen: 0.12,
        });
        break;
      }
      case 'hat': {
        const len = (ev.open ? 0.4 + 0.45 * kit.hatDecay : 0.05 + 0.07 * kit.hatDecay) * hDecay;
        plan.add('hat', {
          beat, bus: 'drums', vel: vel * 0.12 * lvl * tone[2], pan: ev.pan || 0,
          decay: len * 0.3, hpF: 6500 + 2500 * hTone, bpF: 9000 + 3000 * hTone,
          metal: kit.hatStyle === 2 ? 0 : kit.hatStyle === 1 ? 2 : 1,
          baseF: (D.tuneToKey ? mtof(root + 30) : 320) * tone[0] * (0.7 + 0.3 * hTone),
          parts: ev.open ? 6 : 4, noise: kit.hatStyle === 2 ? 0.7 : 0.3,
        });
        break;
      }
      case 'shaker':
        plan.add('noise', { beat, bus: 'drums', vel: vel * 0.12 * lvl, pan: ev.pan || 0, type: 1, f0: 5200 + 2600 * hTone, q: 1.2,
                            attack: 0.014, decay: 0.024 });
        break;
      case 'crash': {   // a noise wash plus a metallic cluster tuned to the chord; on the bell bus for its long reverb
        const len = kit.crashLen * hDecay;
        plan.add('noise', { beat, bus: 'bell', vel: vel * 0.12 * lvl, type: 2, f0: 3600, q: 0.5, attack: 0.002, decay: len * 0.35 });
        plan.add('hat', { beat, bus: 'bell', vel: (vel * lvl) / 3, decay: len * 0.3, hpF: 2800, metal: 3,
                          baseF: D.tuneToKey ? mtof(root + 36) : 410, parts: 5, noise: 0 });
        break;
      }
    }
  }

  /**
   * Compile a song.
   * opts: { session, spb, sigil, lens (undefined = follow the live lens), render, lite, patch: { P, variant } }
   * @returns {{ events, count, total, scenes, tables, drop, reverb, info }}
   */
  function compile(song, opts = {}) {
    const sigil = opts.sigil || app.sigil;
    const spb = opts.spb || song.spb;
    const ses = opts.session || session();
    const snd = typeof Sound !== 'undefined' ? Sound : null;
    const base = opts.patch || (snd && snd.patchFor ? snd.patchFor(song, sigil, !!opts.render)
      : { P: { ...PATCH_DEFAULTS, ...SD.derive(sigil.hash, 0), ...((song.cfg && song.cfg.sound) || {}) }, variant: 0 });
    const P0 = base.P, variant = base.variant | 0;
    const tb = SD.tables(sigil, variant), cube = sigil.hex.slice(0, 16) + ':' + variant;
    const hasLens = typeof LiveLens !== 'undefined';
    const lensOn = hasLens && (opts.lens === undefined ? LiveLens.active() : !!opts.lens && LiveLens.active());
    const lensX = snd && snd.lensWave && hasLens ? LiveLens.shift * 0.6 : 0;
    const frozen = snd ? snd.frozen : false, arcOn = snd ? snd.arcOn : true;
    const lite = opts.lite ?? (snd ? snd.lite : false);
    const D = { ...DRUM_DEFAULTS, ...(typeof DrumEngine !== 'undefined' && DrumEngine.settings ? DrumEngine.settings : {}) };
    const need = new Map();
    const n = song.sections.length;

    // One merged patch per section (the sound arc), with its cube cells and kit resolved once.
    const secs = song.sections.map((sec, si) => {
      const P = arcOn ? { ...P0, ...SD.arc(P0, sec, si, n) } : P0;
      const x0 = clamp(P.wave + lensX, 0, SD.FX - 1), y0 = clamp(P.layer, 0, SD.FY - 1);
      const x1 = frozen ? x0 : x0 + P.sweep * 4, dy = frozen ? 0 : P.drift * 2.5;
      const cell = (x, y) => cellTable(tb, cube, x, y, P, need);
      return {
        si, start: sec.start, P,
        a: cell(x0, y0), up: cell(x1, y0 + dy), dn: cell(x1, y0 - dy), base: cell(P.wave, P.layer),
        kit: SD.drumKit(sigil.hash, P.drumX ?? 0.5, P.drumY ?? 0.5),
        duckMul: D.sectionAware ? (SECTION_DUCK[si] ?? 1) : 1,
      };
    });

    const plan = new KN.Plan(song.events.length * 2);
    const vowels = [];
    const cx = {
      spb, lite, song, sigil, lensOn, D, R: sigil.reduced, vowels,
      vmem: snd && snd.vowelSeq ? snd.vowelSeq() : null,
      section: secs[0], P: secs[0].P,
      add: (kind, o) => plan.add(kind, o),
    };
    const ts = clamp(spb / 0.6, 0.35, 1);   // bells shorten at fast tempos so they stay articulate
    let si = 0;
    for (const raw of song.events) {
      while (si + 1 < n && raw.beat >= secs[si + 1].start) si++;
      const S = secs[si], P = S.P;
      const ev = lensOn ? LiveLens.map(raw, song) : raw;
      cx.section = S; cx.P = P;
      if (Hooks.filter('kernel:event', false, ev, cx) === true) continue;
      const beat = ev.beat, vel = ev.vel ?? 0.8, bright = P.bright ?? 0.6;
      switch (ev.type) {
        case 'lead': { const [k, o] = voice(cx, ev, S, 'lead', pickVoice(P, ev)); plan.add(k, o); break; }
        case 'harm': { const [k, o] = voice(cx, ev, S, 'harm', 'vox'); plan.add(k, o); break; }
        case 'bass': {
          const f = mtof(ev.midi);
          plan.add('wave', { beat, bus: 'bass', freq: f, dur: ev.dur, vel, ta: S.a, cut: f * (1.5 + 9 * 0.18),
                             sub: Math.max(P.sub ?? 0, 0.3) * 0.55, peak: 0.4, cutTau: Math.max(0.05, ev.dur * spb * 0.3) });
          break;
        }
        case 'pad': {
          // A chord is expanded into detuned voices here, so the kernel stays simple.
          const dets = lite ? [0] : [-6, 6];
          for (const m of ev.midis) {
            for (const dt of dets) {
              const f = mtof(m) * Math.pow(2, dt / 1200);
              plan.add('wave', { beat, bus: 'pad', freq: f, dur: ev.dur, vel: vel * (lite ? 1.6 : 1), pan: dt / 15, ta: S.a,
                                 cut: f * (1.5 + 9 * bright * 0.6), a: 0.05, peak: 0.05, cutTau: Math.max(0.05, ev.dur * spb * 0.3) });
            }
          }
          break;
        }
        case 'arp': {
          const f = mtof(ev.midi);
          plan.add('wave', { beat, bus: 'arp', freq: f, dur: ev.dur, vel, pan: ev.pan || 0, ta: S.a, cut: f * (2 + 8 * bright),
                             cutEnd: 0.5, a: 0.002, d: 0.09, s: 0, r: 0.05, peak: 0.24, cutTau: 0.08 });
          break;
        }
        case 'bell': {
          const f = mtof(ev.midi), tau = 0.95 * Math.sqrt(ts);
          plan.add('fm', { beat, bus: 'bell', freq: f, vel, ratio: 3.5, index: f * 1.4 * vel, indexEnd: 0, indexTau: 0.6,
                           a: 0.003, d: tau, s: 0, r: tau, peak: 0.3 });
          break;
        }
        case 'drone':
          plan.add('drone', { beat, bus: 'drone', freq: mtof(ev.midi), dur: ev.dur, vel, ta: S.base, tb: S.a,
                              a: Math.min(4, (ev.dur * spb) / 3) });
          break;
        case 'kick': case 'snare': case 'hat': case 'shaker': case 'crash': case 'swell':
          drum(cx, ev, S, plan);
          break;
      }
    }

    const fin = plan.finish();
    const scenes = new Float64Array(n * KN.SC.STRIDE);
    secs.forEach((S, i) => {
      const P = S.P, o = i * KN.SC.STRIDE, grit = P.grit ?? 0;
      scenes[o + KN.SC.BEAT] = S.start;
      scenes[o + KN.SC.CHORUS] = P.chorus ?? 0;
      scenes[o + KN.SC.ECHO] = 0.2 + (P.echo ?? 0.3) * 0.6;
      scenes[o + KN.SC.MIX] = grit;
      scenes[o + KN.SC.BITS] = grit > 0 ? (P.bits ?? 16) : 16;
      scenes[o + KN.SC.HOLD] = P.hold ?? 1;
      scenes[o + KN.SC.FOLD] = P.fold ?? 0;
      scenes[o + KN.SC.DRIVE] = P.drive ?? 0;
    });

    // Tables this kernel has not seen yet; and, if it is holding too many, the ones it can forget.
    const tables = [], drop = [];
    for (const [id, t] of need) if (!ses.sent.has(id)) { tables.push([id, t.packed]); ses.sent.add(id); }
    if (ses.sent.size > MAX_TABLES) for (const id of [...ses.sent]) if (!need.has(id)) { drop.push(id); ses.sent.delete(id); }
    if (cache.size > MAX_TABLES) for (const [k, t] of cache) if (!need.has(t.id)) cache.delete(k);

    return {
      events: fin.events, count: fin.count, total: song.total, scenes, tables, drop,
      reverb: reverbFor(sigil, variant, snd),
      info: { count: fin.count, total: song.total, sections: secs, vowels: Float64Array.from(vowels), spb, lite,
              R: sigil.reduced, tables: need.size },
    };
  }

  /** The room. With "sigil reverb" on, the early reflections are the sigil's own strokes. */
  function reverbFor(sigil, variant, snd) {
    if (snd && !snd.sigilVerbOn) return { rt60: 3.1, bright: 0.5, pre: 0.018, taps: null };
    const spec = SD.irSpec(sigil, variant);
    return {
      rt60: spec.seconds * 0.75,
      bright: clamp((spec.damp - 0.35) / 0.45, 0, 1),
      pre: 0.014,
      taps: spec.taps.map((t) => [t.t, t.gain, t.pan]),
    };
  }

  /** A note played by hand, voiced exactly as the score would voice it at this moment. @returns [kind, params] | null */
  function noteEvent(note, eng) {
    const info = eng && eng.plan;
    if (!info) return null;
    const beat = eng.beatNow();
    let S = info.sections[0];
    for (const s of info.sections) if (beat >= s.start) S = s;
    const ev = { type: 'lead', midi: note.midi, deg: note.deg || 0, vel: note.vel ?? 0.8, timbre: 'glass', beat: 0, dur: 0 };
    return voice({ spb: eng.spb, lite: info.lite, R: info.R, vmem: null, vowels: null }, ev, S, 'play', pickVoice(S.P, ev));
  }

  /** The merged patch in force at a beat (after the sound arc). */
  function patchAt(info, beat) {
    if (!info) return null;
    let S = info.sections[0];
    for (const s of info.sections) if (beat >= s.start) S = s;
    return S.P;
  }

  return { compile, session, noteEvent, patchAt, chordAt, rootAt, pickVoice, PATCH_DEFAULTS, DRUM_DEFAULTS };
})();
if (typeof window !== 'undefined') window.Score = Score;