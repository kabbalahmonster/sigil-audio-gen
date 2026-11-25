'use strict';

const Arcade = (() => {
  'use strict';

  const DEFAULTS = {
    aTempo: 128,
    aScale: 0.55,
    aComplex: 0.5,
    aSwing: 0.08,
    aBright: 0.65,
    aFm: 0.5,
    aPw: 0.25,
    aDrive: 0.35,
    aDrum: 0.6,
    aDecay: 0.7,
    aArp: 0.5,
    aSpace: 0.3,
  };

  const MACROS = [
    { name: 'aTempo',   label: 'Tempo',           min: 60,   max: 220,  step: 1 },
    { name: 'aScale',   label: 'Scale density',   min: 0,    max: 1,    step: 0.01 },
    { name: 'aComplex', label: 'Complexity',      min: 0,    max: 1,    step: 0.01 },
    { name: 'aSwing',   label: 'Swing',           min: 0,    max: 0.65, step: 0.01 },
    { name: 'aBright',  label: 'Lead brightness', min: 0,    max: 1,    step: 0.01 },
    { name: 'aFm',      label: 'FM depth',        min: 0,    max: 1,    step: 0.01 },
    { name: 'aPw',      label: 'Pulse width',     min: 0.1,  max: 0.9,  step: 0.01 },
    { name: 'aDrive',   label: 'Bass drive',      min: 0,    max: 1,    step: 0.01 },
    { name: 'aDrum',    label: 'Drum density',    min: 0,    max: 1,    step: 0.01 },
    { name: 'aDecay',   label: 'Noise decay',     min: 0.15, max: 2,    step: 0.01 },
    { name: 'aArp',     label: 'Arpeggio rate',   min: 0,    max: 1,    step: 0.01 },
    { name: 'aSpace',   label: 'Space',           min: 0,    max: 1,    step: 0.01 },
  ];

  const CUBE_MEMO = new WeakMap();
  const dmemo = new Map();
  const clampN = (x, a, b) => (x < a ? a : x > b ? b : x);
  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

  function hashNoise(seed, a, b, c) {
    let h = (seed | 0) ^ Math.imul((a | 0) + 1, 0x9e3779b1) ^ Math.imul((b | 0) + 1, 0x85ebca6b) ^ Math.imul((c | 0) + 1, 0xc2b2ae35);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function derive(hash, variant = 0) {
    const key = toHex(hash) + ':' + (variant | 0);
    let d = dmemo.get(key);
    if (!d) {
      const R = stream(hash, variant ? `arcade:${variant | 0}` : 'arcade');
      d = {
        seed: (R.float() * 4294967296) >>> 0,
        aTempo: R.int(112, 148),
        aScale: +R.range(0.38, 0.76).toFixed(2),
        aComplex: +R.range(0.36, 0.74).toFixed(2),
        aSwing: R.pick([0, 0, 0.08, 0.14, 0.2]),
        aBright: +R.range(0.48, 0.84).toFixed(2),
        aFm: +R.range(0.32, 0.74).toFixed(2),
        aPw: R.pick([0.13, 0.25, 0.25, 0.38, 0.5]),
        aDrive: +R.range(0.18, 0.56).toFixed(2),
        aDrum: +R.range(0.48, 0.82).toFixed(2),
        aDecay: +R.range(0.45, 0.92).toFixed(2),
        aArp: +R.range(0.38, 0.78).toFixed(2),
        aSpace: +R.range(0.18, 0.48).toFixed(2),
        fmRatio: R.pick([1, 2, 2, 3, 4]),
        fmRatio2: R.pick([3, 4, 5, 6]),
      };
      if (dmemo.size > 64) dmemo.clear();
      dmemo.set(key, d);
    }
    return { ...d };
  }

  function resolve(P, sigil, variant = 0) {
    const base = sigil ? derive(sigil.hash, variant) : DEFAULTS;
    const src = P || {};
    return {
      seed: base.seed || 0x13579bdf,
      fmRatio: base.fmRatio || 2,
      fmRatio2: base.fmRatio2 || 3,
      aTempo: Math.round(clampN(num(src.aTempo, base.aTempo ?? DEFAULTS.aTempo), 60, 220)),
      aScale: clampN(num(src.aScale, base.aScale ?? DEFAULTS.aScale), 0, 1),
      aComplex: clampN(num(src.aComplex, base.aComplex ?? DEFAULTS.aComplex), 0, 1),
      aSwing: clampN(num(src.aSwing, base.aSwing ?? DEFAULTS.aSwing), 0, 0.65),
      aBright: clampN(num(src.aBright, base.aBright ?? DEFAULTS.aBright), 0, 1),
      aFm: clampN(num(src.aFm, base.aFm ?? DEFAULTS.aFm), 0, 1),
      aPw: clampN(num(src.aPw, base.aPw ?? DEFAULTS.aPw), 0.1, 0.9),
      aDrive: clampN(num(src.aDrive, base.aDrive ?? DEFAULTS.aDrive), 0, 1),
      aDrum: clampN(num(src.aDrum, base.aDrum ?? DEFAULTS.aDrum), 0, 1),
      aDecay: clampN(num(src.aDecay, base.aDecay ?? DEFAULTS.aDecay), 0.15, 2),
      aArp: clampN(num(src.aArp, base.aArp ?? DEFAULTS.aArp), 0, 1),
      aSpace: clampN(num(src.aSpace, base.aSpace ?? DEFAULTS.aSpace), 0, 1),
    };
  }

  function mutate(hash, n, base, current) {
    const R = stream(hash, `arcade:mutate:${n}`);
    const o = { ...current };
    for (const m of MACROS) {
      if (m.name === 'aTempo') {
        if (R.chance(0.25)) {
          const from = num(current.aTempo, num(base && base.aTempo, DEFAULTS.aTempo));
          o.aTempo = Math.round(clampN(from + R.int(-14, 14), m.min, m.max));
        }
        continue;
      }
      if (!R.chance(0.55)) continue;
      const from = num(current[m.name], num(base && base[m.name], DEFAULTS[m.name]));
      const v = clampN(from + R.range(-0.2, 0.2) * (m.max - m.min), m.min, m.max);
      o[m.name] = +v.toFixed(2);
    }
    return o;
  }

  function isArcade(spec, song) {
    if (spec && spec.P && spec.P.eng !== undefined) return (spec.P.eng | 0) === 1;
    return !!(song && song.cfg && song.cfg.soundEngine === 'arcade');
  }

  function sigOf(o) {
    return [o.aScale, o.aComplex, o.aSwing, o.aDrum, o.aArp]
      .map((x) => +(+x).toFixed(3)).join('|');
  }

  function warpBeat(x, sw) {
    if (!(sw > 0)) return x;
    const b = Math.floor(x * 2), g = x * 2 - b;
    const k = 0.5 + sw * 0.38;
    const y = g < 0.5 ? g * (k / 0.5) : k + (g - 0.5) * ((1 - k) / 0.5);
    return (b + y) * 0.5;
  }

  function quantiseDeg(deg, chord, aScale) {
    if (aScale >= 0.35) return deg;
    const oct = Math.floor(deg / 7), pc = mod(deg, 7);
    const rel = mod(pc - chord, 7);
    if (aScale < 0.16) {
      const tri = [0, 0, 2, 2, 4, 4, 0][rel];
      return oct * 7 + chord + tri - (chord + tri >= 7 ? 7 : 0);
    }
    const pent = [0, 0, 2, 3, 4, 4, 5][rel];
    let out = oct * 7 + mod(chord + pent, 7);
    while (out - deg > 3) out -= 7;
    while (deg - out > 3) out += 7;
    return out;
  }

  function expandLeadNotes(notes, chordOf, aScale, aComplex, seed, phIdx) {
    const base = aScale < 0.25 ? notes.filter((n) => !n.passing) : notes.slice();
    const out = [];
    for (let i = 0; i < base.length; i++) {
      const n = base[i], nx = base[i + 1];
      const c = chordOf(n.start);
      const deg = quantiseDeg(n.deg, c, aScale);
      if (aScale > 0.64 && nx && n.dur >= 1.0) {
        const nxDeg = quantiseDeg(nx.deg, chordOf(nx.start), aScale);
        const diff = nxDeg - deg;
        const stepGrid = aScale > 0.84 ? 0.25 : 0.5;
        const maxSteps = Math.min(aScale > 0.84 ? 4 : 2, Math.floor((n.dur - stepGrid) / stepGrid), Math.max(1, Math.abs(diff)));
        if (maxSteps >= 1 && hashNoise(seed, phIdx, i, 1) < (aScale - 0.55) * 2.1) {
          const mainDur = n.dur - maxSteps * stepGrid;
          out.push({ ...n, deg, dur: mainDur });
          const dir = diff === 0 ? (i % 2 ? 1 : -1) : Math.sign(diff);
          for (let k = 0; k < maxSteps; k++) {
            const runDeg = diff === 0
              ? deg + (k % 2 === 0 ? dir : 0)
              : nxDeg - dir * (maxSteps - k);
            out.push({
              start: n.start + mainDur + k * stepGrid,
              dur: stepGrid,
              deg: quantiseDeg(runDeg, chordOf(n.start + mainDur + k * stepGrid), aScale),
              passing: true,
              glide: false,
            });
          }
          continue;
        }
      }
      out.push({ ...n, deg });
    }
    return out;
  }

  function chordTonesFor(c, scale, leadBase, aScale, aComplex) {
    let degs;
    if (aScale < 0.24) degs = [c, c + 4, c + 7];
    else if (aScale < 0.64) degs = [c, c + 2, c + 4, c + 7];
    else if (aComplex > 0.58) degs = [c, c + 2, c + 4, c + 6, c + 8];
    else degs = [c, c + 2, c + 4, c + 6, c + 7];
    let tones = degs.map((d) => degToMidi(d, leadBase, scale));
    if (tones[0] > leadBase + 7) tones = tones.map((m) => m - 12);
    return tones;
  }

  const ARP_FIGS = [
    [0, 1, 2],
    [0, 1, 2, 1],
    [0, 1, 2, 3, 2, 1],
    [0, 2, 1, 3, 2, 3],
    [0, 2, 4, 1, 3, 2, 4, 1],
  ];

  function arpRateLabel(v) {
    if (v >= 0.86) return `${Math.round(30 + (v - 0.86) / 0.14 * 30)} Hz`;
    if (v >= 0.68) return '1/32';
    if (v >= 0.42) return '1/16';
    if (v >= 0.20) return '1/8T';
    return '1/8';
  }

  function bassNoteMidi(c, role, bassBase, scale, cNext) {
    const root = fold(degToMidi(c, bassBase, scale), bassBase - 2, bassBase + 10);
    if (role === 'oct') return root + 12;
    if (role === 'fifth') return fold(degToMidi(c + 4, bassBase, scale), bassBase - 2, bassBase + 12);
    if (role === 'seventh') return fold(degToMidi(c + 6, bassBase, scale), bassBase - 2, bassBase + 12);
    if (role === 'third') return fold(degToMidi(c + 2, bassBase, scale), bassBase - 2, bassBase + 11);
    if (role === 'app') {
      const r2 = fold(degToMidi(cNext ?? c, bassBase, scale), bassBase - 2, bassBase + 10);
      return fold(degToMidi((cNext ?? c) - 1, bassBase, scale), r2 - 2, r2 + 9);
    }
    return root;
  }

  function pitch(ev, c, song, c2) {
    const sc = song.scale, lb = song.leadBase, bb = song.bassBase;
    if (ev.type === 'bass') return bassNoteMidi(c, ev.arcRole || ev.role || 'root', bb, sc, c2);
    if (ev.type === 'arp') {
      const tones = chordTonesFor(c, sc, lb, ev.aScale ?? 0.55, ev.aComplex ?? 0.5);
      if (ev.chip && ev.midis) return tones.slice(0, 4);
      return tones[mod(ev.idx || 0, tones.length)];
    }
    return ev.midi;
  }

  function turnPoly(pat, T) {
    if (typeof Groove !== 'undefined' && Groove.turn) return Groove.turn(pat, T);
    return pat.slice();
  }

  function anchorPoly(pat) {
    if (typeof Groove !== 'undefined' && Groove.anchor) return Groove.anchor(pat);
    return pat.slice();
  }

  function write(m, sigil, rawOpts) {
    const o = resolve(rawOpts, sigil, 0);
    const cfg = m.cfg || {};
    const scale = MODES[cfg.modeName] || MODES.Aeolian;
    const leadBase = 57 + mod((cfg.tonicPc ?? 0) - 9, 12);
    const bassBase = leadBase - 24;
    const red = sigil.reduced || 'KRS', RL = Math.max(1, red.length);
    const CLASS = SoundDesign.CONSONANT_CLASS;
    const ev = [];
    const { aScale, aComplex, aSwing, aDrum, aArp, seed } = o;

    let pCursor = 0;
    m.sections.forEach((sec, si) => {
      const nextSec = m.sections[si + 1];
      const I = sec.intensity | 0;
      const T = sec.T || { k: 0, m: 1, reverse: false };
      const kickPoly = anchorPoly(turnPoly(m.P.kick, T));
      const hatPoly = turnPoly(m.P.hat, T);
      const bassPoly = anchorPoly(turnPoly(m.P.bass, T));
      sec.rhythm = { kick: kickPoly, hat: hatPoly };

      const drumActive = aDrum > 0.01 && (I > 0 || aDrum > 0.85);
      if (drumActive && I >= 3 && aDrum >= 0.25) {
        ev.push({ beat: sec.start, type: 'crash', vel: 0.72, arc: 1, lfsr: 0 });
      }

      for (let p = 0; p < sec.phrases; p++) {
        const ph = m.phrases[pCursor++];
        if (!ph) continue;
        const pBeat = ph.start;
        const chords = ph.chords;
        const lastPhrase = p === sec.phrases - 1;
        const chordAtLocal = (bt) => chords[clampN(Math.floor(bt / 4), 0, 3)];

        if (sec.voice !== 'none') {
          const bellVoice = sec.voice === 'bell';
          const srcNotes = expandLeadNotes(ph.notes, chordAtLocal, aScale, aComplex, seed, pCursor);
          const ch1 = [];
          let prevMidi = null, prevDeg = null;
          const partnerNotes = ph.partners && ph.partners[0] ? ph.partners[0].notes : null;

          for (let ni = 0; ni < srcNotes.length; ni++) {
            const n = srcNotes[ni], nx = srcNotes[ni + 1];
            if (bellVoice && n.passing && aScale < 0.7) continue;
            let deg = n.deg;
            let octShift = bellVoice ? 12 : 0;
            if (!bellVoice && aComplex > 0.55 && (I >= 2 || sec.octave) && !n.passing
                && hashNoise(seed, pCursor, ni, 2) < (aComplex - 0.45) * 0.55) {
              octShift = 12;
            }
            let midi = degToMidi(deg, leadBase, scale) + octShift;
            if (bellVoice && midi > 90) { midi -= 12; octShift = 0; }

            if (!bellVoice && aComplex > 0.52 && !n.passing && n.dur >= 1.0 && n.start >= 0.25
                && hashNoise(seed, pCursor, ni, 3) < (aComplex - 0.45) * 0.6) {
              const gStart = n.start - 0.25;
              const prevEnd = ch1.length ? ch1[ch1.length - 1].endLocal : -1;
              if (gStart >= prevEnd - 1e-4) {
                const gDeg = quantiseDeg(deg - 1, chordAtLocal(gStart), aScale);
                const gMidi = degToMidi(gDeg, leadBase, scale) + octShift;
                ch1.push({
                  startLocal: gStart, endLocal: n.start,
                  deg: gDeg, add: octShift, midi: gMidi,
                  vel: 0.54, glide: false, mode: 0,
                  r1: o.fmRatio, r2: o.fmRatio2,
                });
                prevMidi = gMidi; prevDeg = gDeg;
              }
            }

            const gateFrac = bellVoice ? 0.95 : n.glide ? 0.98 : 0.84;
            const dur = Math.max(0.12, n.dur * gateFrac);
            const vel = clampN((n.passing ? 0.56 : 0.8) + (mod(n.start, 4) === 0 ? 0.12 : 0), 0.25, 0.98)
                      * (bellVoice ? 0.76 : 1);
            ch1.push({
              startLocal: n.start, endLocal: n.start + dur,
              deg, add: octShift, midi,
              from: n.glide ? prevMidi : null,
              fromDeg: n.glide ? prevDeg : null,
              vel, mode: bellVoice ? 1 : 0,
              r1: bellVoice ? 3.5 : sec.voice === 'alt' ? 3 : o.fmRatio,
              r2: bellVoice ? 7 : o.fmRatio2,
            });
            prevMidi = midi; prevDeg = deg;

            const gapEnd = nx ? nx.start : 16;
            const gap = gapEnd - (n.start + n.dur * 0.65);
            if (!bellVoice && aComplex > 0.38 && gap >= 0.75
                && hashNoise(seed, pCursor, ni, 4) < (aComplex - 0.25) * 0.85) {
              const echoStart = Math.ceil((n.start + Math.min(n.dur * 0.65, n.dur - 0.25)) * 2) * 0.5;
              if (echoStart > n.start + 0.2 && echoStart + 0.45 <= gapEnd) {
                const last = ch1[ch1.length - 1];
                if (last.endLocal > echoStart) last.endLocal = echoStart - 0.02;
                let eDeg = deg + (aScale < 0.25 ? 4 : 2);
                if (partnerNotes && partnerNotes.length) {
                  const pn = partnerNotes.find((q) => q.start <= echoStart && q.start + q.dur > echoStart);
                  if (pn) eDeg = quantiseDeg(pn.deg, chordAtLocal(echoStart), aScale);
                }
                while (eDeg > 11) eDeg -= 7;
                ch1.push({
                  startLocal: echoStart, endLocal: Math.min(gapEnd - 0.04, echoStart + 0.46),
                  deg: eDeg, add: 0, midi: degToMidi(eDeg, leadBase, scale),
                  from: null, fromDeg: null,
                  vel: vel * 0.62, mode: 2,
                  r1: o.fmRatio * 2 <= 6 ? o.fmRatio * 2 : 3, r2: o.fmRatio2,
                });
              }
            }
          }

          ch1.sort((a, b) => a.startLocal - b.startLocal);
          for (let i = 0; i < ch1.length; i++) {
            const cur = ch1[i], nxt = ch1[i + 1];
            const tStart = warpBeat(pBeat + cur.startLocal, aSwing);
            const rawEnd = nxt ? Math.min(cur.endLocal, nxt.startLocal - 0.015) : cur.endLocal;
            const tEnd = warpBeat(pBeat + Math.max(cur.startLocal + 0.08, rawEnd), aSwing);
            ev.push({
              beat: tStart,
              type: 'lead',
              midi: cur.midi,
              dur: Math.max(0.08, tEnd - tStart),
              vel: cur.vel,
              from: cur.from,
              fromDeg: cur.fromDeg,
              deg: cur.deg,
              reg: leadBase,
              off: 0,
              add: cur.add || 0,
              cap: cur.mode === 1 ? 90 : undefined,
              arc: 1,
              arcMode: cur.mode,
              r1: cur.r1,
              r2: cur.r2,
            });
          }
        }

        for (let b = 0; b < 4; b++) {
          const t0 = pBeat + b * 4;
          const c = chords[b];
          const cNext = b < 3 ? chords[b + 1] : chords[0];
          const isLastBar = lastPhrase && b === 3;
          const barIdx = Math.round(t0 / 4);

          if (sec.bass || (I >= 1 && sec.voice !== 'none') || (aComplex > 0.55 && sec.voice !== 'none')) {
            const bSteps = [];
            if (sec.halfTime && aComplex < 0.5) {
              bSteps.push({ s: 0, len: 8, role: 'root', vel: 0.84 });
              bSteps.push({ s: 8, len: 4, role: aScale > 0.3 ? 'fifth' : 'root', vel: 0.7 });
              if (aComplex > 0.25) bSteps.push({ s: 12, len: 4, role: aScale > 0.5 ? 'app' : 'oct', vel: 0.68 });
            } else if (aComplex < 0.25 || I === 0) {
              bSteps.push({ s: 0, len: 8, role: 'root', vel: I === 0 ? 0.6 : 0.85 });
              if (I > 0) bSteps.push({ s: 8, len: 8, role: b % 2 ? 'fifth' : 'root', vel: 0.72 });
            } else if (aComplex < 0.62) {
              for (let e = 0; e < 8; e++) {
                const s = e * 2;
                const onPoly = bassPoly[s] || bassPoly[s + 1];
                if (e % 2 === 0 || onPoly || aComplex > 0.44) {
                  let role = e === 0 ? 'root' : e % 2 === 1 ? 'oct' : (e === 6 && aScale > 0.35 ? 'fifth' : 'root');
                  if (e === 7 && aScale > 0.52 && aComplex > 0.48) role = 'app';
                  bSteps.push({ s, len: 2, role, vel: e === 0 ? 0.9 : e % 2 === 0 ? 0.78 : 0.68 });
                }
              }
            } else {
              for (let s = 0; s < 16; s++) {
                const active = s % 4 === 0 || s % 2 === 0 || bassPoly[s]
                  || hashNoise(seed, barIdx, s, 10) < (aComplex - 0.55) * 1.4;
                if (!active) continue;
                let role = 'root';
                if (s === 15 && aScale > 0.45) role = 'app';
                else if (s % 4 === 2) role = 'oct';
                else if (s === 10 || s === 12) role = aScale > 0.55 ? 'fifth' : 'oct';
                else if (s % 2 === 1) role = aScale > 0.68 && s === 13 ? 'seventh' : 'oct';
                const slide = s % 2 === 1 && role === 'oct' && hashNoise(seed, barIdx, s, 11) < 0.35;
                bSteps.push({ s, len: 1, role, vel: s === 0 ? 0.92 : s % 4 === 0 ? 0.8 : 0.68, slide });
              }
            }

            let prevBMidi = null;
            for (let bi = 0; bi < bSteps.length; bi++) {
              const cur = bSteps[bi], nxt = bSteps[bi + 1];
              const nextS = nxt ? nxt.s : 16;
              const tStart = warpBeat(t0 + cur.s * 0.25, aSwing);
              const rawSpan = Math.min(cur.len || (nextS - cur.s), nextS - cur.s);
              const tEnd = warpBeat(t0 + (cur.s + rawSpan * 0.86) * 0.25, aSwing);
              const midi = bassNoteMidi(c, cur.role, bassBase, scale, cNext);
              ev.push({
                beat: tStart,
                type: 'bass',
                midi,
                from: cur.slide && prevBMidi != null ? prevBMidi : undefined,
                dur: Math.max(0.08, tEnd - tStart),
                vel: cur.vel,
                chord: c,
                chord2: cNext,
                role: cur.role === 'fifth' || cur.role === 'oct' ? cur.role : 'root',
                arcRole: cur.role,
                arc: 1,
              });
              prevBMidi = midi;
            }
          }

          if (sec.pad || sec.arp || sec.drone || I > 0) {
            const tones = chordTonesFor(c, scale, leadBase, aScale, aComplex);
            const figIdx = clampN(Math.floor(aComplex * ARP_FIGS.length), 0, ARP_FIGS.length - 1);
            const fig = ARP_FIGS[figIdx];
            const velBase = I === 0 ? 0.42 : sec.arp === 'full' || I >= 3 ? 0.72 : 0.58;
            const holdTail = sec.final && isLastBar && sec.ends !== 'struck' ? (sec.tail || 0) : 0;

            if (aArp >= 0.86) {
              const beatsInBar = 4 + holdTail;
              const segLen = I === 0 ? 2 : aComplex > 0.55 ? 0.5 : 1;
              const steps = Math.max(1, Math.round(beatsInBar / segLen));
              for (let k = 0; k < steps; k++) {
                const sb = t0 + k * segLen;
                if (aComplex > 0.65 && k % 4 === 3 && !holdTail && hashNoise(seed, barIdx, k, 20) < 0.35) continue;
                const rot = (k + barIdx) % tones.length;
                const rotated = tones.slice(rot).concat(tones.slice(0, rot)).slice(0, 4);
                const tStart = warpBeat(sb, segLen <= 0.5 ? aSwing : 0);
                const tEnd = warpBeat(sb + segLen * (holdTail && k === steps - 1 ? 0.98 : 0.9), segLen <= 0.5 ? aSwing : 0);
                ev.push({
                  beat: tStart,
                  type: 'arp',
                  midi: rotated[0],
                  midis: rotated,
                  chip: 1,
                  dur: Math.max(0.1, tEnd - tStart),
                  vel: velBase * (k % 2 === 0 ? 1 : 0.84),
                  pan: (((k + barIdx) % 3) - 1) * 0.28,
                  chord: c,
                  idx: rot,
                  aScale,
                  aComplex,
                  arc: 1,
                });
              }
            } else {
              const rate = aArp < 0.20 ? 0.5 : aArp < 0.42 ? 1 / 3 : aArp < 0.68 ? 0.25 : 0.125;
              const spanBeats = 4 + holdTail;
              const steps = Math.round(spanBeats / rate);
              for (let k = 0; k < steps; k++) {
                const rawBeat = t0 + k * rate;
                if (I === 0 && k % 2 === 1 && aArp > 0.3) continue;
                const idx = fig[(k + barIdx * 2) % fig.length] % tones.length;
                const ringBoost = sigil.nodes[(k + barIdx) % sigil.nodes.length].ring;
                const swingable = Math.abs(rate - 0.25) < 1e-4 || Math.abs(rate - 0.125) < 1e-4;
                const tStart = swingable ? warpBeat(rawBeat, aSwing) : rawBeat;
                const tEnd = swingable ? warpBeat(rawBeat + rate * 0.88, aSwing) : rawBeat + rate * 0.88;
                ev.push({
                  beat: tStart,
                  type: 'arp',
                  midi: tones[idx],
                  dur: Math.max(0.05, tEnd - tStart),
                  vel: velBase * (k % 4 === 0 ? 1 : 0.78) * (0.88 + 0.08 * ringBoost),
                  pan: ((k % 4) / 3 - 0.5) * 0.5,
                  chord: c,
                  idx,
                  aScale,
                  aComplex,
                  arc: 1,
                });
              }
            }
          }

          if (drumActive) {
            const effD = I === 0 ? aDrum * 0.45 : clampN(aDrum * (0.65 + 0.15 * I), 0, 1);
            const doFill = (lastPhrase && b === 3 || (b === 3 && aComplex > 0.65))
              && effD >= 0.32 && aComplex >= 0.22
              && !(sec.final && sec.ends !== 'struck');
            const fillStart = doFill ? (aComplex > 0.68 && nextSec && nextSec.intensity > I ? 8 : 12) : 16;

            for (let s = 0; s < fillStart; s++) {
              const t = warpBeat(t0 + s * 0.25, aSwing);
              const ch = red[(s + barIdx * 3) % RL];
              const cls = CLASS[ch] || 'fricative';
              const metal = cls === 'plosive' || cls === 'fricative' ? 1 : 0;

              let hit = null;
              if (sec.halfTime) {
                if (s === 0 || (s === 10 && kickPoly[10] && effD > 0.35)) {
                  hit = { type: 'kick', vel: s === 0 ? 0.92 : 0.72, lfsr: 0 };
                } else if (s === 8 && effD >= 0.18) {
                  hit = { type: 'snare', vel: 0.84, lfsr: 0 };
                } else if (effD > 0.55 && aComplex > 0.45 && (s === 7 || s === 15) && hashNoise(seed, barIdx, s, 30) < aComplex * 0.5) {
                  hit = { type: 'snare', vel: 0.36, lfsr: 1 };
                }
              } else {
                const backbeat = (s === 4 || s === 12) && effD >= 0.18;
                const mainKick = s === 0 || (effD >= 0.3 && kickPoly[s] && s !== 4 && s !== 12 && hashNoise(seed, barIdx, s, 31) < effD + 0.25);
                const syncKick = effD >= 0.62 && aComplex > 0.5 && (s === 10 || s === 14) && b % 2 === 1 && hashNoise(seed, barIdx, s, 32) < aComplex * 0.55;
                const ghostSnare = effD >= 0.58 && aComplex > 0.4 && (s === 7 || s === 9 || s === 15) && hashNoise(seed, barIdx, s, 33) < (aComplex - 0.3) * 0.75;

                if (backbeat) hit = { type: 'snare', vel: 0.85, lfsr: b === 3 && s === 12 && aComplex > 0.6 ? 1 : 0 };
                else if (mainKick || syncKick) hit = { type: 'kick', vel: s === 0 ? 0.95 : 0.76, lfsr: 0 };
                else if (ghostSnare) hit = { type: 'snare', vel: 0.34, lfsr: 1 };
              }

              if (!hit) {
                const hatOn = effD >= 0.75 ? true
                  : effD >= 0.45 ? (s % 2 === 0 || hatPoly[s])
                  : effD >= 0.22 ? (s % 4 === 2 || (s % 4 === 0 && hatPoly[s]))
                  : (s === 4 || s === 12);
                if (hatOn && hashNoise(seed, barIdx, s, 34) < effD + 0.28) {
                  const open = effD >= 0.42 && (s === 14 || (aComplex > 0.55 && s === 6 && b % 2 === 1));
                  hit = {
                    type: 'hat',
                    vel: (s % 4 === 0 ? 0.48 : s % 2 === 0 ? 0.68 : 0.44) * (open ? 1.15 : 1),
                    open,
                    lfsr: metal,
                    pan: ((s % 3) - 1) * 0.2,
                  };
                }
              }

              if (hit) ev.push({ beat: t, ...hit, arc: 1 });
            }

            if (doFill) {
              const seqNodes = T.reverse ? sigil.nodes.slice().reverse() : sigil.nodes;
              for (let s = fillStart; s < 16; s++) {
                const t = warpBeat(t0 + s * 0.25, aSwing);
                const nd = seqNodes[(s - fillStart) % seqNodes.length];
                const ch = nd.letter;
                const riseVel = 0.52 + 0.42 * ((s - fillStart + 1) / (16 - fillStart));
                if (s === 15 && nextSec && nextSec.intensity >= I) {
                  ev.push({ beat: t, type: 'snare', vel: 0.9, lfsr: 0, arc: 1 });
                } else if ('BP'.includes(ch)) {
                  ev.push({ beat: t, type: 'kick', vel: riseVel, lfsr: 0, arc: 1 });
                } else if ('TKQ'.includes(ch)) {
                  ev.push({ beat: t, type: 'snare', vel: riseVel, lfsr: 0, arc: 1 });
                } else if ('SZFXHC'.includes(ch)) {
                  ev.push({ beat: t, type: 'hat', vel: riseVel * 0.85, open: s >= 14, lfsr: 1, arc: 1 });
                } else {
                  const tomIdx = T.m < 0 ? 2 - nd.ring : nd.ring;
                  ev.push({ beat: t, type: 'tom', tom: clampN(tomIdx, 0, 2), vel: riseVel, lfsr: 1, arc: 1 });
                }
              }
            }
          }
        }

        if (sec.final) {
          ev.push({
            beat: pBeat + 16,
            type: 'lead',
            midi: leadBase + 12,
            dur: 6,
            vel: 0.68,
            deg: 0, off: 0, reg: leadBase, add: 12,
            arc: 1, arcMode: 1, r1: 3.5, r2: 7,
          });
        }
        if (lastPhrase && sec.final && sec.ends === 'struck' && (sec.tail || 0) > 0) {
          const t = pBeat + 16, held = Math.min(3, sec.tail);
          const tones = chordTonesFor(0, scale, leadBase, aScale, aComplex).slice(0, 4);
          ev.push({ beat: t, type: 'arp', midi: tones[0], midis: tones, chip: 1, dur: held, vel: 0.8, chord: 0, idx: 0, aScale, aComplex, arc: 1 });
          ev.push({ beat: t, type: 'bass', midi: bassNoteMidi(0, 'root', bassBase, scale, 0), dur: held, vel: 0.9, chord: 0, role: 'root', arcRole: 'root', arc: 1 });
          if (drumActive) {
            ev.push({ beat: t, type: 'kick', vel: 0.95, lfsr: 0, arc: 1 });
            if (I >= 2) ev.push({ beat: t, type: 'crash', vel: 0.8, lfsr: 0, arc: 1 });
          }
        }
      }
    });

    const total = m.total || Infinity;
    const filtered = ev.filter((e) => e.beat < total);
    filtered.sort((a, b) => a.beat - b.beat);
    return {
      events: filtered,
      info: { sig: sigOf(o), channels: 4, arpRate: arpRateLabel(aArp) },
    };
  }

  function reindex(song) {
    song.events.sort((a, b) => a.beat - b.beat);
    song.kicks = song.events.filter((e) => e.type === 'kick').map((e) => e.beat);
    song.snares = song.events.filter((e) => e.type === 'snare' && e.vel > 0.5).map((e) => e.beat);
  }

  function score(events, ctx, rawOpts) {
    const cfg = ctx.cfg;
    if (!CUBE_MEMO.has(cfg)) {
      CUBE_MEMO.set(cfg, {
        events: events.slice(),
        rhythms: ctx.sections.map((s) => s.rhythm),
        groove: cfg.groove,
      });
    }
    delete cfg.groove;
    const w = write({ sections: ctx.sections, phrases: ctx.phrases, P: cfg.P, bpm: cfg.bpm, total: ctx.total, cfg }, ctx.sigil, rawOpts);
    cfg.arcade = w.info;
    cfg.soundEngine = 'arcade';
    return w.events;
  }

  function apply(song, sigil, rawOpts) {
    if (!song || !sigil || !song.cfg) return song;
    const cfg = song.cfg;
    if (!CUBE_MEMO.has(cfg)) {
      CUBE_MEMO.set(cfg, {
        events: song.events.slice(),
        rhythms: song.sections.map((s) => s.rhythm),
        groove: cfg.groove,
      });
    }
    delete cfg.groove;
    const w = write({ sections: song.sections, phrases: song.phrases, P: song.P, bpm: song.bpm, total: song.total, cfg }, sigil, rawOpts);
    song.events = w.events;
    cfg.arcade = w.info;
    cfg.soundEngine = 'arcade';
    reindex(song);
    return song;
  }

  function restore(song) {
    if (!song || !song.cfg) return song;
    const cfg = song.cfg, saved = CUBE_MEMO.get(cfg);
    delete cfg.arcade;
    delete cfg.soundEngine;
    if (!saved) return song;
    song.events = saved.events.slice();
    song.sections.forEach((s, i) => {
      if (saved.rhythms[i]) s.rhythm = saved.rhythms[i];
      else delete s.rhythm;
    });
    if (saved.groove) cfg.groove = saved.groove;
    else delete cfg.groove;
    reindex(song);
    return song;
  }

  function sync(song, sigil, rawOpts, active) {
    if (!song || !sigil || !song.cfg) return false;
    if (!active) {
      if (!song.cfg.arcade) return false;
      restore(song);
      return true;
    }
    const o = resolve(rawOpts, sigil, 0);
    const want = sigOf(o);
    const have = song.cfg.arcade ? song.cfg.arcade.sig : null;
    if (want === have) return false;
    apply(song, sigil, o);
    return true;
  }

  function wavePreview(rawP, N = 128) {
    const P = resolve(rawP, null, 0);
    const lead = new Float32Array(N), bass = new Float32Array(N), perc = new Float32Array(N), arp = new Float32Array(N);
    const idx = P.aFm * (0.25 + 1.35 * P.aFm) * (0.45 + 0.75 * P.aBright);
    const fb = 0.04 + 0.28 * P.aBright * P.aFm;
    let pm = 0, lfsr = 0x53a9, nz = 1;
    const step = Math.max(1, Math.round(6 - 4.2 * Math.min(1, P.aDrum * 0.5 + 0.3)));
    for (let i = 0; i < N; i++) {
      const p = i / N, th = TAU * p;
      const m1 = Math.sin(2 * th + fb * pm * TAU); pm = m1;
      lead[i] = Math.sin(th + idx * m1 * TAU) * (0.7 + 0.3 * P.aBright);
      const rawPulse = p < P.aPw ? 1 - P.aPw : -P.aPw;
      const drv = 1 + 5.5 * P.aDrive;
      bass[i] = Math.tanh((rawPulse * 1.4 + 0.25 * Math.sin(th)) * drv) / Math.tanh(drv);
      if (i % step === 0) {
        const bit = (lfsr ^ (lfsr >> 1)) & 1;
        lfsr = ((lfsr >> 1) | (bit << 14)) & 0x7fff;
        nz = bit ? 1 : -1;
      }
      const env = Math.exp((-i / N) * (3.2 / Math.max(0.2, P.aDecay)));
      perc[i] = nz * env * (P.aDrum > 0.01 ? 0.35 + 0.65 * P.aDrum : 0);
      const stages = P.aScale < 0.24 ? 3 : 4;
      const seg = Math.floor((p * (2 + Math.round(P.aArp * 6))) % stages);
      const ratio = [1, 1.25, 1.5, 2][seg];
      const ap = (p * ratio * 2) % 1;
      const apw = clampN(0.62 - 0.42 * P.aPw, 0.125, 0.5);
      arp[i] = (ap < apw ? 0.8 : -0.8) * (0.65 + 0.35 * P.aBright);
    }
    return { lead, bass, perc, arp };
  }

  return {
    DEFAULTS, MACROS, derive, resolve, mutate, isArcade, sigOf, arpRateLabel,
    warpBeat, quantiseDeg, chordTonesFor, pitch, write, score, apply, restore, sync, wavePreview,
  };
})();

if (typeof window !== 'undefined') window.Arcade = Arcade;
