'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5l  ARCADE: the second sound engine's arrangement
   --------------------------------------------------------------------------
   The cube is one way to sound a sigil. The arcade is another: a four-channel
   retro machine (src/dsp/sigil-arcade.js) with an FM lead, a pulse bass, a
   noise channel for every stroke of the kit and an arpeggiated chord channel.
   Which of the two plays is the patch's `engine` (0 the cube, 1 the arcade);
   in the arcade every part, the kit included, is the arcade's.

   This file is pure. It says
     • the macros: one set of controls shared by all four channels
         tempo (the transport's, not a patch field) · scale density · complexity
         swing · lead brightness · FM depth · pulse width · bass drive
         drum density · noise decay · arpeggio rate · space
     • the sigil's own values for the sound macros (`derive`, its own stream)
     • how a score is re-arranged for the machine (`arrange`): the notes it may
       use, how much is played, how it swings. Stateless noise keyed by where a
       note falls, so a macro is a threshold on a fixed field: more complexity
       adds notes, it never re-deals the ones that stay.
   The composer's R is never touched; with the cube chosen none of this runs.
   ══════════════════════════════════════════════════════════════════════════ */
const Arcade = (() => {
  'use strict';
  const CUBE = 0, ARCADE = 1;
  const ENGINES = [['cube', 'Cube'], ['arcade', 'Arcade']];

  /** The arpeggio's rate: steps per beat, by index. */
  const ARP_RATES = [2, 3, 4, 6, 8, 12, 16];
  const ARP_NAMES = ['1/8', '1/8T', '1/16', '1/16T', '1/32', '1/32T', '1/64'];

  /** Where the arrangement is as written: at these values `arrange` changes nothing but the swing it is asked for. */
  const NEUTRAL = { aDensity: 1, aComplex: 0.5, aDrums: 0.7, aSwing: 0 };
  /** Every macro's resting value, for a host that has no sigil to derive from. */
  const DEFAULTS = { engine: CUBE, ...NEUTRAL, aBright: 0.6, aFm: 0.5, aPw: 0.25, aDrive: 0.3, aDecay: 1, aArp: 2, aSpace: 0.4 };
  const KEYS = Object.keys(DEFAULTS);

  const on = (P) => !!P && (P.engine | 0) === ARCADE;

  /** The sigil's own sound for the machine. A stream of its own, drawn in a frozen order: append only. */
  const memo = new Map();
  function derive(hash) {
    const key = String(hash);
    if (memo.has(key)) return { ...memo.get(key) };
    const R = stream(hash, 'arcade');
    const r2 = (x) => Math.round(x * 100) / 100;
    const o = {
      aBright: r2(R.range(0.45, 0.8)),
      aFm: r2(R.range(0.3, 0.7)),
      aPw: R.pick([0.125, 0.25, 0.25, 0.5]),
      aDrive: r2(R.range(0.15, 0.45)),
      aDecay: r2(R.range(0.8, 1.25)),
      aArp: R.pick([2, 2, 3, 4]),
      aSpace: r2(R.range(0.25, 0.55)),
    };
    memo.set(key, o);
    return { ...o };
  }

  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  /** The macros in force, each in its range. */
  function params(P) {
    const g = (k, lo, hi) => clamp(num(P && P[k], DEFAULTS[k]), lo, hi);
    const arp = Math.round(g('aArp', 0, ARP_RATES.length - 1));
    return {
      density: g('aDensity', 0, 1), complex: g('aComplex', 0, 1), swing: g('aSwing', 0, 1),
      bright: g('aBright', 0, 1), fm: g('aFm', 0, 1), pw: g('aPw', 0.05, 0.5), drive: g('aDrive', 0, 1),
      drums: g('aDrums', 0, 1), decay: g('aDecay', 0.25, 2), arp, rate: ARP_RATES[arp], space: g('aSpace', 0, 1),
    };
  }

  /* ── Stateless noise keyed by musical position ───────────────────────── */
  function noise(beat, ch, salt) {
    let h = Math.imul(Math.round(beat * 960) | 0, 0x9e3779b1) ^ Math.imul((ch | 0) + 1, 0x85ebca6b) ^ (salt | 0);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function saltOf(sigil) {
    const s = String(sigil && (sigil.reduced || sigil.hash) || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h | 0;
  }
  const CH = { lead: 1, bell: 2, harm: 3, arp: 4, bass: 5, echo: 6, drum: 7, tick: 8, slide: 9 };

  /* ── Scale density: how many of the mode's seven notes the machine may use ── */
  /**
   * The degrees kept, most stable first: the tonic, the fifth and the third, then whichever degree clashes
   * least (by semitone) with those already kept. Five of them is the mode's own pentatonic; seven, the mode.
   */
  function degreeOrder(scale) {
    const kept = [0, 4, 2], pref = [1, 5, 3, 6];
    const pcs = () => kept.map((d) => scale[d]);
    while (kept.length < 7) {
      let best = -1, bd = -1;
      for (const d of pref) {
        if (kept.includes(d)) continue;
        const dist = Math.min(...pcs().map((p) => { const x = Math.abs(scale[d] - p) % 12; return Math.min(x, 12 - x); }));
        if (dist > bd) { bd = dist; best = d; }
      }
      kept.push(best);
    }
    return kept;
  }
  /** The pitch classes (relative to the tonic) a density allows: 2 (tonic and fifth) up to all 7. */
  function allowed(scale, density) {
    const k = clamp(Math.round(2 + density * 5), 2, 7);
    return degreeOrder(scale).slice(0, k).map((d) => scale[d]);
  }
  /** The nearest allowed note to a MIDI note (a tie goes down). */
  function snap(midi, tonic, set) {
    if (midi == null || set.length >= 7) return midi;
    const rel = (((midi - tonic) % 12) + 12) % 12;
    let best = 0, bd = 99;
    for (const p of set) {
      for (const cand of [p - 12, p, p + 12]) {
        const d = Math.abs(cand - rel);
        if (d < bd || (d === bd && cand < best)) { bd = d; best = cand; }
      }
    }
    return midi + (best - rel);
  }

  /* ── Swing: the eighths of every beat, pushed late ───────────────────── */
  /** A monotone warp of the beat: the off-beat eighth moves by up to a sixth of a beat (a triplet's shuffle), the beat stays. */
  function swingAt(beat, s) {
    if (!(s > 0)) return beat;
    const b = Math.floor(beat), x = beat - b, mid = 0.5 + s / 6;
    return b + (x < 0.5 ? x * (mid / 0.5) : mid + (x - 0.5) * ((1 - mid) / 0.5));
  }

  /* ── Drum density: what each stroke is worth to the groove ───────────── */
  const at = (b, q) => Math.abs(b / q - Math.round(b / q)) < 1e-3;
  function weight(ev) {
    const b = ev.beat, v = ev.vel ?? 0.7;
    switch (ev.type) {
      case 'kick': return at(b, 4) ? 1 : at(b, 1) ? 0.85 : 0.7;
      case 'snare': return v < 0.3 ? 0.3 : at(b - 1, 2) ? 1 : 0.75;
      case 'clap': return 0.9;
      case 'crash': return 1;
      case 'hat': return ev.open ? 0.55 : at(b, 1) ? 0.5 : at(b, 0.5) ? 0.45 : 0.35;
      case 'ride': return 0.5;
      case 'shaker': return 0.35;
      case 'rim': return 0.5;
      case 'tom': case 'perc': return 0.65;
      default: return 1;
    }
  }
  const DRUMS = new Set(['kick', 'snare', 'hat', 'shaker', 'crash', 'tom', 'perc', 'rim', 'clap', 'ride']);

  /**
   * The score, re-arranged for the machine. `events` are the score's (already turned by the Live Lens, if it is on);
   * returns a new array, in no particular order (the compiler sorts). Events it does not change are returned as they are.
   */
  function arrange(events, song, sigil, P) {
    const A = params(P), salt = saltOf(sigil);
    const tonic = song.leadBase, set = allowed(song.scale, A.density);
    const thin = A.complex < 0.5 ? (0.5 - A.complex) / 0.5 : 0, rich = A.complex > 0.5 ? (A.complex - 0.5) / 0.5 : 0;
    const dThin = A.drums < NEUTRAL.aDrums ? (NEUTRAL.aDrums - A.drums) / NEUTRAL.aDrums : 0;
    const dMore = A.drums > NEUTRAL.aDrums ? (A.drums - NEUTRAL.aDrums) / (1 - NEUTRAL.aDrums) : 0;
    const out = [];
    const hit = new Set(), hatBars = new Map();        // the sixteenths the kit already strikes; the bars that have hats, and their `when`

    for (const ev0 of events) {
      let ev = ev0;
      const b = ev.beat;
      switch (ev.type) {
        case 'lead': case 'harm': case 'bell': case 'arp': {
          if (set.length < 7) {
            const midi = snap(ev.midi, tonic, set), from = ev.from != null ? snap(ev.from, tonic, set) : ev.from;
            if (midi !== ev.midi || from !== ev.from) ev = { ...ev, midi, from };
          }
          if (thin > 0) {
            // less: the ornaments go first (the doubling bells, the choir, the arpeggio's off-steps), then the lead's short off-beat notes
            const r = noise(b, CH[ev.type], salt);
            if (ev.type === 'bell' && (ev.vel ?? 0.8) < 0.4 && r < thin * 1.2) continue;
            if (ev.type === 'harm' && r < thin) continue;
            if (ev.type === 'arp' && !at(b, 0.5) && r < thin) continue;
            if (ev.type === 'lead' && (ev.dur || 0) <= 0.3 && !at(b, 1) && r < thin * 0.6) continue;
          }
          if (rich > 0 && ev.type === 'lead' && !ev.part && (ev.dur || 0) >= 0.5 && noise(b, CH.echo, salt) < rich * 0.85) {
            // more: the machine's echo, a dotted eighth after, quieter and to one side (the trick a chip did with a spare channel)
            out.push({ ...ev, beat: b + 0.75, dur: Math.min(ev.dur, 0.6), vel: (ev.vel ?? 0.8) * 0.32, from: null, echo: true });
          }
          out.push(ev);
          break;
        }
        case 'bass': {
          const d = ev.dur || 0.5;
          if (rich > 0 && d >= 0.95 && noise(b, CH.bass, salt) < rich) {
            // more: the bass bounces in octaves, in eighths, as a chip bass does
            const n = Math.max(2, Math.floor(d / 0.5 + 1e-6));
            for (let j = 0; j < n; j++) {
              out.push({ ...ev, beat: b + j * 0.5, dur: 0.45, midi: ev.midi + (j % 2 ? 12 : 0), from: j ? null : ev.from, vel: (ev.vel ?? 0.85) * (j % 2 ? 0.82 : 1) });
            }
            break;
          }
          out.push(ev);
          break;
        }
        default: {
          if (DRUMS.has(ev.type)) {
            if (dThin > 0 && weight(ev) + 0.15 * (1 - noise(b, CH.drum, salt)) < dThin) continue;
            hit.add(Math.round(b * 4));
            if (ev.type === 'hat') {
              const bar = Math.floor(b / 4 + 1e-6);
              if (!hatBars.has(bar)) hatBars.set(bar, ev.when || null);
            }
          }
          out.push(ev);
        }
      }
    }

    if (dMore > 0) {
      // more: the noise channel ticks the sixteenths the kit leaves empty, in the bars that already have a hat
      for (const [bar, when] of hatBars) {
        for (let s = 0; s < 16; s++) {
          const q = bar * 16 + s;
          if (hit.has(q)) continue;
          const beat = q / 4;
          if (noise(beat, CH.tick, salt) >= dMore * 0.75) continue;
          const t = { beat, type: 'hat', vel: s % 2 ? 0.3 : 0.42, tick: true };
          if (when) t.when = when;
          out.push(t);
        }
      }
    }

    if (A.swing > 0) {
      for (let i = 0; i < out.length; i++) {
        const ev = out[i], b = swingAt(ev.beat, A.swing);
        if (b === ev.beat) continue;
        const nx = { ...ev, beat: b };
        if (ev.dur > 0) nx.dur = Math.max(0.02, swingAt(ev.beat + ev.dur, A.swing) - b);
        out[i] = nx;
      }
    }
    return out;
  }

  /** How much of the hall the machine wants, against the usual, and how big it is. */
  const space = (P) => { const s = params(P).space; return { send: 0.15 + 1.7 * s, size: 0.55 + 0.9 * s, echo: 0.05 + 0.75 * s }; };

  return { CUBE, ARCADE, ENGINES, ARP_RATES, ARP_NAMES, DEFAULTS, NEUTRAL, KEYS, on, derive, params, arrange, space,
    allowed, snap, swingAt, degreeOrder, weight };
})();

if (typeof window !== 'undefined') window.Arcade = Arcade;
