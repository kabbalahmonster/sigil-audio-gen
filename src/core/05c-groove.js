'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5c  GROOVE — the kit reads the sigil · pure, deterministic, no audio context
   --------------------------------------------------------------------------
   The composer (§5.5 drumBar) writes one bar per section and repeats it. This
   file writes the drum part again, bar by bar, from the same material the
   melody is made of, so that the kit is not an accompaniment laid under the
   sigil but another reading of it:

     POLYGONS    the song's Euclidean rhythms (P.kick / P.hat / P.ghost) are the
                 kit's material, and each section plays them under ITS OWN
                 transform: turned k/21 in the Exaltation, mirrored in the
                 Reflection, retraced in the Reversal. The drums obey the same
                 geometry as the melody, and §7 draws the polygon that is played.
     LETTERS     the reduced string cycles against the bar, one letter per
                 sixteenth (the same cycle the compiler already uses to colour
                 each hit). A letter's RING is its weight: outer letters are
                 struck harder. A sigil of n letters therefore phrases in n
                 against 16: unless n divides 16, the accents drift bar to bar.
     FILLS       at the end of a phrase the kit SPEAKS THE SIGIL: its letters
                 are recited as drums, one after another, in the section's own
                 order (backwards in the Reversal, inverted in the Reflection).
                 B P are the kick, T K Q the snare, D G and the liquids the
                 toms (pitched by ring), the nasals the floor tom, the sibilants
                 the hats. Every fill is the name of the thing, said on the kit.
     THE RITE    how much is said depends on where the rite is going: a rise is
                 built into, a fall is let go of, and the Banishing dissolves.

   DETERMINISM (the same contract as §5)
     • Nothing here draws from the composer's `R`. Structural choices come from
       stream(hash, 'groove') (or 'groove:<take>'), in a FROZEN order (see dna()).
     • Everything per bar and per hit is STATELESS noise keyed by musical
       position (bar, step, channel). A slider therefore acts as a threshold on
       a fixed field: raising Fills adds fills, it does not reshuffle the song.
     • Same sigil + same options = the same part, forever. tests/golden.json
       pins it.

   The composer's own bars are never lost: they are kept per song, and
   restore() puts them back exactly.
   ══════════════════════════════════════════════════════════════════════════ */

const Groove = (() => {
  'use strict';

  /** Event types this file owns. Everything else in the score is left alone. */
  const TYPES = new Set(['kick', 'snare', 'hat', 'shaker', 'crash', 'swell', 'tom', 'rim']);

  /**
   * take: which groove (0 = the sigil's own). The amounts are 0…1.
   * steady: the kick keeps strictly to its polygon (no answering kicks, no dropped half-bars).
   *         Not a panel control: a mood asks for it through cfg.drums (Pulse, Clockwork).
   */
  const DEFAULTS = { take: 0, variation: 0.6, fills: 0.6, ghosts: 0.5, human: 0.4, steady: false };

  const STEPS = 16;
  const CLASS = SoundDesign.CONSONANT_CLASS;

  /** The composer's bars for each song, keyed by its cfg (one per composition). */
  const CLASSIC = new WeakMap();

  /* ── §5c.1 NOISE: stateless, keyed by musical position ─────────────────── */

  /** Uniform [0,1) from (seed, bar, step, channel). An integer finaliser; no state, no order. */
  function noise(seed, a, b, c) {
    let h = seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b) ^ Math.imul(c + 1, 0xc2b2ae35);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /** Noise channels. Named so two decisions can never share a draw by accident. */
  const CH = { pickup: 1, push: 2, heart: 3, drop: 4, flam: 5, ghost: 6, ghostB: 7, whisper: 8, rim: 9,
    hatVel: 10, hatPan: 11, sib: 12, time: 13, vel: 14, turn: 15, fillVel: 16 };

  /* ── §5c.2 DNA: the few choices a groove is dealt ──────────────────────── */

  /**
   * ⚠ THE ORDER OF DRAWS IS FROZEN. Appending a draw is safe; inserting or
   * removing one re-deals every groove ever heard. Take 0 plays the composer's
   * own polygons; later takes keep the kick (it is the song's, and a mood may
   * have set it) but may mirror it, and are dealt new hats and ghosts.
   */
  function dna(sigil, P, take) {
    const G = stream(sigil.hash, take ? `groove:${take}` : 'groove');
    const d = {
      seed: (G.float() * 4294967296) >>> 0,
      pickup: G.pick([10, 14, 15, 11]),      // the extra kick of an answering bar
      push: G.pick([6, 7, 10, 14]),          // a second one, at full intensity, as the phrase turns
      open: G.pick([14, 14, 6, 10]),         // where the hat opens
      rim: G.pick([12, 12, 4, 14]),          // where the side-stick sits in the quiet sections
      flip: G.chance(0.5),
      hatK: G.pick([5, 7, 9, 11]), hatRot: G.int(0, 15),
      ghostK: G.pick([2, 3]), ghostRot: G.int(1, 15),
      lay: G.range(0.4, 1),                  // how far behind the beat this drummer's backbeat sits
    };
    const own = !take;
    d.kick = own || !d.flip ? P.kick.slice() : P.kick.map((_, s) => !!P.kick[mod(-s, STEPS)]);
    d.hat = own ? P.hat.slice() : euclid(d.hatK, STEPS, d.hatRot);
    d.ghost = own ? P.ghost.slice() : euclid(d.ghostK, STEPS, d.ghostRot);
    return d;
  }

  /* ── §5c.3 GEOMETRY: the section's transform, applied to rhythm ────────── */

  /** A turn of k/21 of the wheel, as sixteenths of the bar: the same angle, on the rhythm's own grid. */
  const turnSteps = (k) => mod(Math.round((k * STEPS) / SLOTS), STEPS);

  /**
   * A polygon under the section transform T = {k, m, reverse}: the rhythmic
   * twin of `displayed slot = m·slot + k`. Mirror reflects about the downbeat;
   * retrograde reads the bar from its end.
   */
  function turn(pat, T) {
    const r = turnSteps(T.k), out = new Array(STEPS);
    for (let s = 0; s < STEPS; s++) {
      const a = T.reverse ? STEPS - 1 - s : s;
      out[s] = !!pat[mod(T.m * (a - r), STEPS)];
    }
    return out;
  }

  /**
   * The kick keeps its feet: after the turn, the polygon is rotated the least
   * distance that puts a vertex back on the downbeat. Turning a kick pattern
   * therefore selects another MODE of the same necklace (as turning the wheel
   * selects another mode of the scale), with the same number of kicks.
   */
  function anchor(pat) {
    if (pat[0]) return pat;
    for (let d = 1; d <= STEPS / 2; d++) {
      for (const q of [d, -d]) if (pat[mod(q, STEPS)]) return pat.map((_, s) => pat[mod(s + q, STEPS)]);
    }
    return pat;                                                   // an empty polygon has nothing to anchor
  }

  /** The sigil as the kit will say it in this section: retraced, turned, and (mirrored) inverted. */
  function recite(sigil, T) {
    let seq = T.reverse ? sigil.nodes.slice().reverse() : sigil.nodes.slice();
    const off = mod(T.k, seq.length);
    if (off) seq = seq.slice(off).concat(seq.slice(0, off));
    return { seq, flip: T.m < 0 };
  }

  /**
   * Consonant → limb. This is how a mouth plays drums ("boots and cats"): B and P
   * are the kick; the hard unvoiced stops T K Q are the snare; the voiced stops
   * D G, being rounder, are toms, as are the liquids, pitched by the letter's
   * ring; what is hummed (M N J) is the floor tom; the sibilants are the hats,
   * and the breathed fricatives F V H a soft stroke on the snare. A mirrored
   * section inverts the rings, so its fills fall where the others rise.
   */
  function limb(nd, flip) {
    const L = nd.letter, cls = CLASS[L] || 'fricative', ring = flip ? 2 - nd.ring : nd.ring;
    if (L === 'B' || L === 'P') return { type: 'kick', ring, vel: 0.82 };
    if (L === 'D' || L === 'G') return { type: 'tom', tom: ring, ring, vel: 0.76 };
    if (cls === 'plosive') return { type: 'snare', ring, vel: 0.72 };
    if (cls === 'fricative') {
      return L === 'F' || L === 'V' || L === 'H'
        ? { type: 'snare', ring, vel: 0.46 }
        : { type: 'hat', ring, vel: 0.62, open: ring === 2 };
    }
    if (cls === 'nasal') return { type: 'tom', tom: 0, ring, vel: 0.76 };
    return { type: 'tom', tom: ring, ring, vel: 0.74 };
  }

  /* ── §5c.4 THE WRITER ──────────────────────────────────────────────────── */

  /** What the boundary after this bar asks of the kit. */
  function boundary(sec, next) {
    if (sec.final || !next || next.final || !(next.intensity > 0)) return 'dissolve';
    if (next.intensity > sec.intensity) return 'rise';
    if (next.intensity < sec.intensity) return 'fall';
    return 'turn';
  }

  /**
   * Width of the fill that ends this bar, in sixteenths (0 = none).
   * Section ends are sized by the boundary; phrase ends inside a section get a
   * short turn. `f` is the Fills amount: thresholds, so more never means different.
   */
  function fillWidth(I, kind, sectionEnd, f, u) {
    if (I <= 0 || f < 0.12) return 0;
    if (sectionEnd) {
      let w = kind === 'rise' ? (f >= 0.75 && I >= 2 ? 16 : f >= 0.3 ? 8 : 4)
            : kind === 'dissolve' ? (f >= 0.3 ? 8 : 4)
            : (f >= 0.45 ? 8 : 4);
      if (I === 1) w = Math.min(w, 8);
      return w;
    }
    if (I === 1) return f >= 0.7 ? 2 : 0;
    if (f >= 0.85) return 4;
    if (f >= 0.5) return u < 0.4 ? 4 : 2;                          // most turns are two notes; some are a beat
    return f >= 0.25 ? 2 : 0;
  }

  /**
   * Write the whole drum part.
   * @param {object} m  { sections, phrases, P, bpm, total }
   * @returns {{events: object[], info: object}}
   */
  function write(m, sigil, opts) {
    const o = { ...DEFAULTS, ...(opts || {}) };
    const v = clamp(+o.variation || 0, 0, 1), f = clamp(+o.fills || 0, 0, 1);
    const g = clamp(+o.ghosts || 0, 0, 1), hu = clamp(+o.human || 0, 0, 1);
    const kv = o.steady ? 0 : 1;                                   // scales every liberty the kick may take
    const P = m.P, D = dna(sigil, P, o.take | 0), seed = D.seed;
    const nodes = sigil.nodes, n = nodes.length;
    const sw = (P.swing || 0) * 0.25;                              // swing delays the odd sixteenths
    const flamBeats = (0.03 * (m.bpm || 90)) / 60;                 // a grace note ≈ 30 ms ahead, at any tempo
    const fast = (m.bpm || 90) > 112;                              // no thirty-seconds above this
    const ev = [], said = [];                                    // said: each letter the kit speaks, for §7 / m15 to light
    let turnCursor = 0, fills = 0;

    /** Swing offset (beats) at a half-step position (0…31); thirty-seconds sit between their neighbours. */
    const swingAt = (p2) => {
      const s = p2 >> 1, a = s & 1 ? sw : 0;
      if (!(p2 & 1)) return a;
      return (a + ((s + 1) & 1 && s + 1 < STEPS ? sw : 0)) / 2;
    };

    m.sections.forEach((sec, si) => {
      const I = sec.intensity | 0, half = !!sec.halfTime;
      const T = sec.T || { k: 0, m: 1, reverse: false };
      const kick = anchor(turn(D.kick, T)), hat = turn(D.hat, T), ghost = turn(D.ghost, T);

      // Half-time keeps the downbeat and at most two of the polygon's own kicks, where a half-time bar can carry them.
      const halfKicks = [10, 6, 14, 3, 11, 7].filter((s) => kick[s]).slice(0, I >= 3 ? 2 : 1);
      const played = new Array(STEPS).fill(false);
      played[0] = true;
      if (half) halfKicks.forEach((s) => (played[s] = true));
      else if (I >= 2) kick.forEach((on, s) => { if (on) played[s] = true; });
      sec.rhythm = I > 0 ? { kick: played, hat } : null;           // what §7 draws at the hub

      if (I <= 0) return;
      const next = m.sections[si + 1];
      const kind = boundary(sec, next);
      const phrases = m.phrases.filter((p) => p.si === si);
      const bars = Math.round((sec.phrases || phrases.length || 1) * 4);
      const say = recite(sigil, T);

      if (I >= 3) ev.push({ beat: sec.start, type: 'crash', vel: 0.7 });

      for (let bar = 0; bar < bars; bar++) {
        const t0 = sec.start + bar * 4, pb = bar % 4, phi = bar >> 2, ab = Math.round(t0 / 4);
        const answer = pb === 1 || pb === 3, sectionEnd = bar === bars - 1;
        const N = (step, ch) => noise(seed, ab, step, ch);
        // A section develops: its first phrase states the groove, its last one plays with it.
        const vv = clamp(v * (bars > 4 ? 0.7 + (0.6 * phi) / ((bars >> 2) - 1) : 1), 0, 1);
        const W = pb === 3 ? fillWidth(I, kind, sectionEnd, f, N(0, CH.turn)) : 0;
        const from = STEPS - W;

        /* One bar, as a map of hits, so that two reasons to strike the same drum
           at the same moment make one stroke (the louder), never a double. */
        const hits = new Map();
        const put = (p2, type, vel, x) => {
          const key = `${type}|${x && x.tom != null ? x.tom : ''}|${x && x.grace ? 'g' : ''}|${p2}`;
          const old = hits.get(key);
          if (old && old.vel >= vel) return;
          hits.set(key, { p2, type, vel, ...(x || {}) });
        };
        const has = (p2, type) => hits.has(`${type}|||${p2}`);
        const drop = (p2, type) => hits.delete(`${type}|||${p2}`);

        /** The letter passing at this sixteenth, and its weight: inner letters are lighter, outer heavier. */
        const letterAt = (s) => nodes[mod(Math.round(t0 * 4) + s, n)];
        const weight = (s) => 1 + (letterAt(s).ring - 1) * 0.12;

        // Where the pen arrives in this bar: the hats lean on the notes of the melody.
        const lands = new Set();
        const ph = phrases[phi];
        if (ph && ph.notes) {
          for (const nt of ph.notes) {
            const s = (nt.start - pb * 4) * 4;
            if (!nt.passing && s >= 0 && s < STEPS) lands.add(Math.round(s));
          }
        }

        /* ── KICK ─────────────────────────────────────────────────────── */
        put(0, 'kick', half ? 0.9 : 0.95);
        if (half) {
          for (const s of halfKicks) if (s < from) put(s * 2, 'kick', 0.6);
          const c = D.pickup >= 14 ? D.pickup : 14;
          if (answer && c < from && N(c, CH.pickup) < 0.7 * vv * kv) put(c * 2, 'kick', 0.55);
        } else if (I >= 2) {
          // The third bar of a phrase may leave its second half open: space before the turn.
          const open = I === 2 && pb === 2 && N(0, CH.drop) < 0.35 * v * kv;
          for (let s = 1; s < from; s++) {
            if (kick[s] && !(open && s >= 9)) put(s * 2, 'kick', 0.7 * (1 + (weight(s) - 1) * 0.5));
          }
          // The answering kicks go where this groove was dealt them, or, if the polygon already stands
          // there, on the nearest later step that is free (never on a backbeat).
          const free = (s) => s < from && s !== 4 && s !== 12 && !kick[s];
          const seat = (s) => { for (let j = 0; j < STEPS; j++) { const q = mod(s + j, STEPS); if (q > 0 && free(q)) return q; } return -1; };
          const pick = seat(D.pickup), push = seat(D.push);
          if (answer && pick > 0 && N(pick, CH.pickup) < 0.9 * vv * kv) put(pick * 2, 'kick', 0.62);
          if (I >= 3 && pb === 3 && push > 0 && push !== pick && N(push, CH.push) < 0.6 * vv * kv) put(push * 2, 'kick', 0.55);
        } else if (pb === 3 && 10 < from && N(10, CH.heart) < 0.6 * vv * kv) {
          put(20, 'kick', 0.5);                                     // intensity 1: a second heartbeat as the phrase turns
        }

        /* ── SNARE, GHOSTS, SIDE-STICK ────────────────────────────────── */
        const backbeats = half ? [8] : [4, 12];
        if (I >= 2) {
          // The backbeat holds through a turn or a fall; only a build (its roll) and a dissolve take it away.
          const keep = W > 0 && (kind === 'turn' || kind === 'fall' || !sectionEnd);
          for (const s of backbeats) if (s < from || keep) put(s * 2, 'snare', half ? 0.78 : 0.8, { back: true });
          if (!half && pb === 3 && 12 < from && N(12, CH.flam) < 0.7 * vv) put(24, 'snare', 0.26, { grace: true });
          const pA = I >= 3 ? Math.min(1, g * 2) : answer && !half ? Math.max(0, g - 0.5) * 2 : 0;
          const pB = I >= 3 && !half ? Math.max(0, g - 0.5) * 1.4 : 0;
          for (let s = 1; s < from; s++) {
            if (backbeats.includes(s)) continue;
            const a = ghost[s] && N(s, CH.ghost) < pA, b = ghost[mod(s - 5, STEPS)] && N(s, CH.ghostB) < pB;
            if (!a && !b) continue;
            const ring = letterAt(s).ring;
            if (ring === 0 && N(s, CH.whisper) < 0.5) continue;     // inner letters are sometimes only thought
            put(s * 2, 'snare', 0.13 + 0.045 * ring, { ghost: true });
          }
        }
        if (I === 1 || (I === 2 && half)) {
          // The quiet sections keep time with a side-stick once they have settled (from the second phrase).
          if (answer && D.rim < from && (phi >= 1 ? v > 0.05 : N(D.rim, CH.rim) < v * 0.5)) put(D.rim * 2, 'rim', 0.34);
        }

        /* ── HATS & SHAKER ────────────────────────────────────────────── */
        if (I >= 3 || (I === 2 && !half)) {
          const sixteenths = I >= 3 && !half && !!sec.octave;       // the Apotheosis drives
          for (let s = 0; s < from; s++) {
            const on = sixteenths || (I >= 3 ? s % 2 === 0 || hat[s] : hat[s]);
            if (!on) continue;
            let vel = (sixteenths ? [0.78, 0.42, 0.62, 0.42][s & 3] : s % 4 === 0 ? (half ? 0.45 : 0.5) : (half ? 0.75 : 0.8))
                    * (0.7 + 0.3 * N(s, CH.hatVel)) * weight(s);
            if (lands.has(s)) vel *= 1.18;
            const open = s === D.open && (half ? I >= 3 : I >= 3 ? answer : pb === 3);
            put(s * 2, 'hat', Math.min(vel, 0.98), { open, pan: (N(s, CH.hatPan) - 0.5) * 0.6 });
          }
          if (!half && I === 2 && pb === 3 && D.open < from && !has(D.open * 2, 'hat')) {
            put(D.open * 2, 'hat', 0.6, { open: true, pan: 0 });    // the phrase ends on an open hat even off the polygon
          }
        } else {
          for (let s = 2; s < from; s += 4) put(s * 2, 'shaker', (half ? 0.5 : 0.55) * weight(s));
          if (v >= 0.3 && phi >= 1) {
            // Once settled, the shaker also whispers where a sibilant passes on the hat polygon.
            for (let s = 0; s < from; s++) {
              if (s % 4 === 2 || !hat[s] || CLASS[letterAt(s).letter] !== 'fricative') continue;
              if (N(s, CH.sib) < v) put(s * 2, 'shaker', 0.27);
            }
          }
        }

        /* ── FILL: the kit speaks the sigil ───────────────────────────── */
        if (W > 0) {
          fills++;
          // Section ends say the name from its first letter; turns carry on from where the last one stopped.
          let cur = sectionEnd ? 0 : turnCursor;
          const slots = new Array(W).fill(true);
          if (W > 2 && I === 2) {
            const H = clamp(Math.round(W * (0.5 + 0.35 * f)), 2, W);
            euclid(H, W, 0).forEach((on, j) => (slots[W - 1 - j] = on));   // a Euclidean figure that ENDS on a stroke
          } else if (W > 2 && I === 1) {
            slots.forEach((_, j) => (slots[j] = (W - 1 - j) % 2 === 0));    // eighths, ending on the last
          }
          if (kind === 'dissolve') slots[W - 1] = false;            // the last sixteenth is left to the silence

          let last = null;
          for (let j = 0; j < W; j++) {
            if (!slots[j]) continue;
            const s = from + j, nd = say.seq[cur++ % say.seq.length], lb = limb(nd, say.flip);
            const pos = W > 1 ? j / (W - 1) : 1;
            const shape = kind === 'rise' ? lerp(0.62, 1.08, pos) : kind === 'fall' ? lerp(1, 0.72, pos)
                        : kind === 'dissolve' ? lerp(0.85, 0.42, pos) : lerp(0.78, 1, pos);
            let type = lb.type, vel = lb.vel * shape * (1 + (lb.ring - 1) * 0.08);
            const x = { fill: true };
            if (type === 'tom') x.tom = lb.tom;
            if (type === 'hat') { x.open = !!lb.open && j === W - 1; x.pan = (N(s, CH.hatPan) - 0.5) * 0.6; }
            if (I === 1) {                                          // a quiet section fills quietly: sticks and skins
              if (type === 'snare') { type = 'rim'; vel *= 0.62; }
              else if (type === 'hat') { type = 'shaker'; vel *= 0.6; delete x.open; delete x.pan; }
              else vel *= 0.78;
            }
            if (kind === 'dissolve' && type === 'snare') { type = 'rim'; vel *= 0.7; }
            put(s * 2, type, clamp(vel * (1 + (N(s, CH.fillVel) - 0.5) * 0.1), 0.08, 1), x);
            said.push({ beat: t0 + s * 0.25 + swingAt(s * 2), slot: nd.slot, ring: nd.ring });
            last = { s, type };
          }
          if (!sectionEnd) turnCursor = cur;

          if (kind === 'rise' && sectionEnd) {
            /* The composer's own build, kept: a snare roll rising through the last beat, over a swell of noise. */
            for (let j = 0; j < 4; j++) put((12 + j) * 2, 'snare', 0.3 + 0.15 * j, { fill: true });
            if (!fast && f >= 0.8 && I >= 2) { put(29, 'snare', 0.52, { fill: true }); put(31, 'snare', 0.66, { fill: true }); }
            if (W >= 8 && I >= 2) for (let s = from; s < STEPS; s += 4) put(s * 2, 'kick', 0.7, { fill: true });
            if (next && next.intensity >= 3) ev.push({ beat: t0, type: 'swell', dur: 4, vel: 0.8 });
          } else if (sectionEnd && kind !== 'dissolve') {
            if (W >= 8 && I >= 2 && from % 4 === 0) put(from * 2, 'kick', 0.7, { fill: true });   // the fill starts from a kick
            // …and ends on something with a body, so that the next bar is arrived at, not stumbled into.
            if (last && (last.type === 'hat' || last.type === 'shaker')) {
              drop(last.s * 2, last.type);
              put(last.s * 2, I === 1 ? 'rim' : 'snare', I === 1 ? 0.4 : 0.7, { fill: true });
            }
          } else if (kind === 'dissolve' && sectionEnd) {
            put(28, 'tom', 0.42, { tom: 0, fill: true });           // the last word is the floor tom, and then nothing
            put(28, 'kick', 0.45, { fill: true });
          }
          // A full-bar or half-bar fill into a section that is not announced by its own crash still lands on one.
          if (sectionEnd && W >= 8 && next && next.intensity === 2) ev.push({ beat: t0 + 4, type: 'crash', vel: 0.45 });
        }

        /* ── Hits → events: swing, feel, and the drummer's hand ───────── */
        for (const h of hits.values()) {
          const s = h.p2 >> 1, ch = h.type.charCodeAt(0) + (h.tom || 0);
          let t = t0 + h.p2 * 0.125 + swingAt(h.p2), vel = h.vel;
          if (h.grace) t -= flamBeats;
          if (hu > 0 && !(h.type === 'kick' && h.p2 === 0)) {
            if (h.type !== 'kick') t += (noise(seed, ab, h.p2 + 64, CH.time + ch) - 0.5) * 0.024 * hu;
            if (h.back) t += D.lay * (half ? 0.02 : 0.012) * hu;   // a backbeat sits behind the beat, more so in half-time
            vel *= 1 + (noise(seed, ab, h.p2 + 64, CH.vel + ch) - 0.5) * 0.16 * hu;
          }
          const e = { beat: Math.max(0, t), type: h.type, vel: clamp(vel, 0.05, 1) };
          if (h.type === 'hat') { e.open = !!h.open; e.pan = h.pan || 0; }
          if (h.type === 'tom') e.tom = h.tom | 0;
          if (h.type === 'shaker' && h.pan) e.pan = h.pan;
          if (h.fill) e.fill = true;
          ev.push(e);
        }
      }
    });

    const total = m.total || Infinity;
    const events = ev.filter((e) => e.beat < total);
    events.sort((a, b) => a.beat - b.beat);
    return {
      events,
      info: { take: o.take | 0, variation: v, fills: f, ghosts: g, human: hu, steady: !!o.steady,
        kick: D.kick.filter(Boolean).length, hat: D.hat.filter(Boolean).length, ghost: D.ghost.filter(Boolean).length,
        nFills: fills, nEvents: events.length, said },
    };
  }

  /* ── §5c.5 INSTALLING A PART ───────────────────────────────────────────── */

  /** The options as one string: what a part was written with. Two equal strings mean the same part. */
  const sigOf = (o) => {
    const x = { ...DEFAULTS, ...(o || {}) };
    return [x.take | 0, x.variation, x.fills, x.ghosts, x.human].map((q) => +(+q).toFixed(3)).join('|') + (x.steady ? '|steady' : '');
  };

  /** Swap the kit's events in a score for a freshly written part. Returns a NEW, unsorted array. */
  function merge(events, part) {
    return events.filter((e) => !TYPES.has(e.type)).concat(part);
  }

  function stamp(cfg, info, opts) {
    cfg.groove = { ...info, sig: sigOf(opts) };
  }

  /**
   * The 'score' filter body: called by composeSong before the score is sorted.
   * ctx = { sigil, cfg, sections, phrases, total }
   */
  function score(events, ctx, opts) {
    if (!CLASSIC.has(ctx.cfg)) CLASSIC.set(ctx.cfg, events.filter((e) => TYPES.has(e.type)));
    const w = write({ sections: ctx.sections, phrases: ctx.phrases, P: ctx.cfg.P, bpm: ctx.cfg.bpm, total: ctx.total },
                    ctx.sigil, opts);
    stamp(ctx.cfg, w.info, opts);
    return merge(events, w.events);
  }

  /** Everything the renderer and the modules pre-extract from the drum part. */
  function reindex(song) {
    song.events.sort((a, b) => a.beat - b.beat);
    song.kicks = song.events.filter((e) => e.type === 'kick').map((e) => e.beat);
    song.snares = song.events.filter((e) => e.type === 'snare' && e.vel > 0.5).map((e) => e.beat);
  }

  /** Re-write the drum part of a finished song, in place (live edits, tests, offline tools). */
  function apply(song, sigil, opts) {
    const cfg = song.cfg;
    if (!CLASSIC.has(cfg)) CLASSIC.set(cfg, song.events.filter((e) => TYPES.has(e.type)));
    const w = write({ sections: song.sections, phrases: song.phrases, P: song.P, bpm: cfg.bpm, total: song.total },
                    sigil, opts);
    song.events = merge(song.events, w.events);
    stamp(cfg, w.info, opts);
    reindex(song);
    return song;
  }

  /** Put the composer's own bars back, exactly as §5 wrote them. */
  function restore(song) {
    const cfg = song.cfg, own = CLASSIC.get(cfg);
    if (!cfg.groove || !own) return song;
    song.events = merge(song.events, own);
    delete cfg.groove;
    for (const sec of song.sections) delete sec.rhythm;
    reindex(song);
    return song;
  }

  /** For a panel or a screen reader: which groove (`short`), and what it is built from (`detail`). */
  function describe(song) {
    const gr = song && song.cfg && song.cfg.groove;
    if (!gr) return { short: 'classic', detail: 'the composer’s own bars: one bar per section, repeated' };
    return {
      short: `groove ${gr.take}`,
      detail: `kick E(${gr.kick},16) · hats E(${gr.hat},16) · ghosts E(${gr.ghost},16) · ${gr.nFills} fill${gr.nFills === 1 ? '' : 's'}`,
    };
  }

  return { TYPES, DEFAULTS, dna, turn, turnSteps, recite, limb, write, score, apply, restore, sigOf, describe, noise };
})();

if (typeof window !== 'undefined') window.Groove = Groove;
