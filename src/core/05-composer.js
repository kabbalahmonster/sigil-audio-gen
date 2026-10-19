'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5  COMPOSER — geometry → song
   --------------------------------------------------------------------------
   CORE MAPPING, one note per node of the path:

     pitch    = (displayed slot mod 7) + 7 × (ring − 1)   → scale degree
     duration = length of the stroke leaving that node    → rhythm
     legato   = the stroke arriving at the node is curved → glide

   Because pitch comes from position, the sigil's symmetries ARE the classical
   melodic transformations:

     rotation by k slots   → diatonic transposition by k mod 7
     mirror (slot → −slot) → melodic inversion about the tonic
     reversed path         → retrograde

   The song form (§5.1) is then literally built from those transformations.

   ⚠ DETERMINISM: the ORDER OF RANDOM DRAWS from `R` inside composeSong is
   FROZEN. Changing it changes every existing song. Filters must never draw
   from R; they should open their own stream(sigil.hash, 'label').
   ══════════════════════════════════════════════════════════════════════════ */

/* ── §5.1 FORM ─────────────────────────────────────────────────────────── */

/** Interval names for the Exaltation description, keyed by degree shift. */
const INTERVAL_WORD = { 2: 'third', 3: 'fourth', 4: 'fifth' };

/**
 * The seven-section ritual arc: invocation → exaltation → banishing.
 *
 * Section fields:
 *   id, roman, name, desc   identity & HUD copy
 *   phrases                 number of 4-bar phrases
 *   tail                    extra beats of silence/decay after the section
 *   T {k, m, reverse}       the geometric transform this section applies
 *   intensity 0–3           drives drum density, pad brightness, line weight
 *   voice 'bell'|'lead'|'alt'
 *   harm / arp / octave / pad / bass / drone / halfTime / density / final
 *
 * Moods (M6) and Mixer (M2) mutate this array through the 'plan' filter.
 */
function makePlan(rotK, shift) {
  const id = { k: 0, m: 1, reverse: false };
  return [
    { id: 'intro',   roman: 'I',   name: 'Invocation',  desc: 'the wheel turns · the letters are named',
      phrases: 1, T: id, intensity: 0, voice: 'bell', pad: 0.55, drone: true, density: 0 },

    { id: 'verse1',  roman: 'II',  name: 'Inscription', desc: 'the sigil, exactly as written',
      phrases: 2, T: id, intensity: 1, voice: 'lead', pad: 0.8, bass: true, density: 0 },

    { id: 'chorus1', roman: 'III', name: 'Exaltation',  desc: `turned ${rotK}⁄21 · the melody rises a ${INTERVAL_WORD[shift]}`,
      phrases: 2, T: { k: rotK, m: 1, reverse: false }, intensity: 3, voice: 'lead',
      harm: true, arp: 'full', pad: 1, bass: true, density: 1 },

    { id: 'verse2',  roman: 'IV',  name: 'Reflection',  desc: 'mirrored · the melody inverted',
      phrases: 2, T: { k: 0, m: -1, reverse: false }, intensity: 2, voice: 'lead',
      arp: 'light', pad: 0.85, bass: true, density: 0 },

    { id: 'bridge',  roman: 'V',   name: 'Reversal',    desc: 'retraced · the melody in retrograde',
      phrases: 2, T: { k: 0, m: 1, reverse: true }, intensity: 2, halfTime: true,
      voice: 'alt', drone: true, pad: 0.95, bass: true, density: 1 },

    { id: 'chorus2', roman: 'VI',  name: 'Apotheosis',  desc: 'turned again · every voice at once',
      phrases: 2, T: { k: rotK, m: 1, reverse: false }, intensity: 3, voice: 'lead',
      harm: true, arp: 'full', octave: true, pad: 1, bass: true, density: 1 },

    { id: 'outro',   roman: 'VII', name: 'Banishing',   desc: 'the line returns to silence',
      phrases: 1, tail: 8, T: id, intensity: 0, voice: 'bell', drone: true,
      pad: 0.6, density: 0, final: true },
  ];
}

/* ── §5.2 PHRASE CONSTRUCTION ──────────────────────────────────────────── */


/**
 * Share `total` integer units among weights (largest-remainder method).
 * Every weight gets at least one unit whenever weights.length ≤ total, so
 * strokes become eighth-note rhythms that always fill the phrase exactly.
 *
 * Over-subscription (more weights than units) cannot honour the minimum of 1;
 * in that case the result sums to more than `total` and the caller must not
 * rely on it. The composer never hits this case: phrases have at most 22
 * weights against 32 units.
 *
 * Output is identical to the previous version for every input where
 * weights.length ≤ total, so existing sigils are unaffected.
 */
function allocate(weights, total) {
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map((r) => Math.max(1, Math.floor(r)));
  let diff = total - out.reduce((a, b) => a + b, 0);

  // Hand leftover units to the largest fractional remainders first.
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let j = 0; diff > 0; j++, diff--) out[order[j % order.length][1]]++;

  // Take back surplus from the longest entries, never below 1.
  while (diff < 0) {
    let mi = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i] > 1 && (mi < 0 || out[i] > out[mi])) mi = i;
    }
    if (mi < 0) break;                 // over-subscribed: stop rather than create zero-length notes
    out[mi]--;
    diff++;
  }
  return out;
}

/**
 * Build one 4-bar phrase (32 eighth notes) from the sigil under transform T.
 *
 * Short sigils (≤ 6 letters) are traced TWICE per phrase so the melody is
 * never too sparse. Visually the pen simply goes round the path twice.
 *
 * @returns {{seq, curves, path, notes}}
 *   seq/curves — the node sequence actually drawn (possibly doubled)
 *   path       — nodes annotated with the beat at which the pen arrives
 *   notes      — {start, dur, deg, passing, glide}
 */
function buildPhrase(sigil, T, density) {
  let seq    = T.reverse ? sigil.nodes.slice().reverse()  : sigil.nodes.slice();
  let curves = T.reverse ? sigil.curves.slice().reverse() : sigil.curves.slice();
  if (seq.length <= 6) { seq = seq.concat(seq); curves = curves.concat([0], curves); }

  // Rhythm from geometry: each note lasts in proportion to the stroke leaving it.
  const lens = [];
  for (let i = 0; i < seq.length - 1; i++) {
    lens.push(polyLength(segmentPoints(seq[i], seq[i + 1], curves[i], ID_T, UNIT_F, 1, 16)));
  }
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const units = allocate(lens.concat([mean * 1.6]), 32); // final node rests longer: a cadence

  const notes = [], path = [];
  let prev = null, u = 0;

  seq.forEach((nd, i) => {
    const s2 = mod(T.m * nd.slot + T.k, SLOTS);  // displayed slot under the transform
    let deg = mod(s2, 7) + 7 * (nd.ring - 1);     // angle → degree, ring → octave

    /* Voice-leading regulariser: leaps larger than a ninth are folded by an
       octave toward the previous note, so the melody stays singable. Then the
       whole line is clamped into a ~2-octave window. */
    if (prev !== null) { while (deg - prev > 8) deg -= 7; while (prev - deg > 8) deg += 7; }
    while (deg < -2) deg += 7;
    while (deg > 10) deg -= 7;
    prev = deg;

    path.push({ ...nd, beat: u * 0.5 });
    notes.push({
      start: u * 0.5,
      dur: units[i] * 0.5,
      deg,
      passing: false,
      glide: i > 0 && curves[i - 1] !== 0,
    });
    u += units[i];
  });

  return { seq, curves, path, notes: density > 0 ? addPassing(notes) : notes };
}

/**
 * Passing tones, used in "dense" sections.
 *
 * A long note followed by a leap gives up its tail to 1–2 stepwise notes that
 * walk into the next note. Geometrically these are the scale positions the pen
 * sweeps past on a long stroke.
 */
function addPassing(notes) {
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i], nx = notes[i + 1];
    if (!nx) { out.push(n); continue; }

    const units = Math.round(n.dur * 2), diff = nx.deg - n.deg;
    const k = Math.min(2, units - 2, Math.abs(diff) - 1);

    if (k >= 1) {
      out.push({ ...n, dur: (units - k) * 0.5 });
      for (let j = 0; j < k; j++) {
        out.push({
          start: n.start + (units - k + j) * 0.5,
          dur: 0.5,
          deg: nx.deg - Math.sign(diff) * (k - j),
          passing: true, glide: false,
        });
      }
    } else out.push(n);
  }
  return out;
}

/* ── §5.3 HARMONY ──────────────────────────────────────────────────────── */

/**
 * Transition weights for the Viterbi search, indexed by root motion in scale
 * degrees. 0 = repeat the chord, 3 = up a fourth, 4 = up a fifth, etc.
 * Strong root motion is rewarded; stasis is penalised.
 */
const TRANS = [-0.6, 0.15, 0.1, 0.5, 0.35, 0.4, 0.2];

/**
 * Harmoniser.
 *
 * The melody is sacred (it IS the sigil), so harmony adapts to it: one chord
 * per bar, chosen by a Viterbi search over diatonic triads.
 *
 *   emission   = how well the chord fits the bar's notes, weighted by duration
 *                and metric strength (downbeat ×2, beat 3 ×1.4, carried-in ×0.5,
 *                passing tones ×0.35)
 *   transition = TRANS, preferring strong root motion
 *   cadence    = tonic bonus on bar 1; half (V) or full (I) cadence on bar 4
 *   bias       = a small hash-derived "personality" per chord
 *
 * @param {string} cadence 'full' | 'half'
 * @returns {number[]} four scale-degree chord roots
 */
function harmonize(notes, scale, bias, cadence) {
  // Candidate chords: plain major/minor triads only (no diminished, no augmented)
  const cands = [];
  for (let c = 0; c < 7; c++) {
    const third = mod(scale[(c + 2) % 7] - scale[c], 12);
    const fifth = mod(scale[(c + 4) % 7] - scale[c], 12);
    if (fifth === 7 && (third === 3 || third === 4)) cands.push(c);
  }

  // Emission scores, per bar, per candidate
  const E = [];
  for (let b = 0; b < 4; b++) {
    const b0 = b * 4, b1 = b0 + 4;
    E.push(cands.map((c) => {
      let s = bias[c];
      for (const n of notes) {
        const ov = Math.min(b1, n.start + n.dur) - Math.max(b0, n.start);
        if (ov <= 0) continue;

        let w = ov;
        const inBar = n.start >= b0 && n.start < b1, pos = n.start - b0;
        if (inBar && pos === 0)      w *= 2;
        else if (inBar && pos === 2) w *= 1.4;
        else if (!inBar)             w *= 0.5;
        if (n.passing) w *= 0.35;

        const rel = mod(n.deg - c, 7);
        s += rel === 0 || rel === 2 || rel === 4 ?  w        // chord tone
           : rel === 6                           ?  0.15 * w // 7th: mild colour
           : rel === 5                           ? -0.25 * w // 6th: weak clash
           :                                      -0.7  * w; // 2nd/4th: real clash
      }

      if (b === 0 && c === 0) s += 1.0;                      // open on the tonic
      if (b === 3) {
        if (cadence === 'full' && c === 0) s += 1.4;
        if (cadence === 'half' && c === 4) s += 1.0;
        if (cadence === 'half' && c === 3) s += 0.4;
      }
      return s;
    }));
  }

  // Viterbi forward pass
  let score = E[0].slice();
  const back = [];
  for (let b = 1; b < 4; b++) {
    const ns = [], bk = [];
    cands.forEach((c, ci) => {
      let best = -1e9, bi = 0;
      cands.forEach((p, pi) => {
        const v = score[pi] + TRANS[mod(c - p, 7)];
        if (v > best) { best = v; bi = pi; }
      });
      ns.push(best + E[b][ci]); bk.push(bi);
    });
    score = ns; back.push(bk);
  }

  // Backtrace
  let ci = score.indexOf(Math.max(...score));
  const out = [cands[ci]];
  for (let b = 2; b >= 0; b--) { ci = back[b][ci]; out.unshift(cands[ci]); }
  return out;
}

/* ── §5.4 SHARED PITCH HELPERS ─────────────────────────────────────────────
   Factored out so the Live Lens (M9) can recompute pitches from the metadata
   stored on each event, using exactly the composer's own rules. If you change
   one of these, the Lens and the offline render follow automatically.
   ─────────────────────────────────────────────────────────────────────────── */

/** Diatonic triads that are plainly major or minor (no diminished/augmented). */
function validChords(scale) {
  const out = [];
  for (let c = 0; c < 7; c++) {
    const third = mod(scale[(c + 2) % 7] - scale[c], 12);
    const fifth = mod(scale[(c + 4) % 7] - scale[c], 12);
    if (fifth === 7 && (third === 3 || third === 4)) out.push(c);
  }
  return out;
}

/** Bass pitch for chord `c` in a role: 'root' | 'fifth' | 'oct' (root + octave). */
function bassPitch(c, role, bassBase, scale) {
  const root = fold(degToMidi(c, bassBase, scale), bassBase - 2, bassBase + 10);
  if (role === 'fifth') return fold(degToMidi(c + 4, bassBase, scale), bassBase - 2, bassBase + 12);
  return role === 'oct' ? root + 12 : root;
}

/** The five arpeggio tones (triad spread over two octaves) for chord `c`. */
function arpTones(c, scale, leadBase) {
  let tones = [c, c + 2, c + 4, c + 7, c + 9].map((d) => degToMidi(d, leadBase, scale));
  if (tones[0] > leadBase + 9) tones = tones.map((m) => m - 12); // keep it under the melody
  return tones;
}

/**
 * Close-position pad voicing inside a fixed one-octave window — which gives
 * smooth voice leading for free, because consecutive chords fold into the same
 * register — plus a low root an octave or two below.
 */
function padVoicing(c, scale, base, opt) {
  const degs = [c, c + 2, c + 4];
  if (opt.seventh) degs.push(c + 6);
  else if (opt.ninth) degs.push(c + 8);

  const lo = base - 7;
  const ms = degs.map((d) => fold(degToMidi(d, base, scale), lo, lo + 11));
  const root = fold(degToMidi(c, base, scale), base - 19, base - 8);
  return [root, ...ms].sort((a, b) => a - b);
}

/* ── §5.5 PER-BAR EMITTERS (rhythm section & accompaniment) ────────────────
   Each pushes events into `ev`. All pitched events carry `chord` and `role`
   (or `idx`) metadata so the pitch can be re-derived later under a transform.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Drums for one bar (16 sixteenth-note steps).
 * `fill` adds a rising snare roll + noise swell into the following chorus.
 */
function drumBar(ev, t0, sec, P, fill, R) {
  const I = sec.intensity;
  if (I === 0) return;

  const sw = (s) => (s % 2 ? P.swing * 0.25 : 0); // swing delays odd 16ths

  for (let s = 0; s < 16; s++) {
    const t = t0 + s * 0.25 + sw(s);

    if (sec.halfTime) {                            // backbeat on 3, sparse kicks
      if (s === 0 || (s === 10 && P.kick[10]))
        ev.push({ beat: t, type: 'kick', vel: s === 0 ? 0.9 : 0.6 });
      if (s === 8) ev.push({ beat: t, type: 'snare', vel: 0.75 });

      if (I >= 3) {                                // fast half-time: breakbeat hats + ghosts
        if (s % 2 === 0 || P.hat[s])
          ev.push({ beat: t, type: 'hat', vel: (s % 4 === 0 ? 0.45 : 0.75) * (0.7 + R.float() * 0.3),
                    open: s === 14, pan: (R.float() - 0.5) * 0.6 });
        if (P.ghost[s] && s !== 8) ev.push({ beat: t, type: 'snare', vel: 0.18 });
      } else if (s % 4 === 2) {
        ev.push({ beat: t, type: 'shaker', vel: 0.5 });
      }
      continue;
    }

    if (s === 0 || (I >= 2 && P.kick[s]))
      ev.push({ beat: t, type: 'kick', vel: s === 0 ? 0.95 : 0.7 });

    if (I >= 2 && (s === 4 || s === 12) && !(fill && s >= 12))
      ev.push({ beat: t, type: 'snare', vel: 0.8 });

    if (I >= 3 && P.ghost[s] && s !== 4 && s !== 12)
      ev.push({ beat: t, type: 'snare', vel: 0.16 });

    if (I === 1 && s % 4 === 2)
      ev.push({ beat: t, type: 'shaker', vel: 0.55 });

    if (I >= 2) {
      const on = I >= 3 ? s % 2 === 0 || P.hat[s] : P.hat[s];
      if (on) ev.push({ beat: t, type: 'hat', vel: (s % 4 === 0 ? 0.5 : 0.8) * (0.7 + R.float() * 0.3),
                        open: I >= 3 && s === 14, pan: (R.float() - 0.5) * 0.6 });
    }
  }

  if (fill) {
    for (let s = 12; s < 16; s++)
      ev.push({ beat: t0 + s * 0.25 + sw(s), type: 'snare', vel: 0.3 + 0.15 * (s - 12) });
    ev.push({ beat: t0, type: 'swell', dur: 4, vel: 0.8 });
  }
}

/** Bass for one bar. Patient roots at low intensity; Euclidean hits otherwise. */
function bassBar(ev, t0, c, sec, P, R, bassBase, scale) {
  if (sec.halfTime || sec.intensity <= 1) {
    ev.push({ beat: t0, type: 'bass', midi: bassPitch(c, 'root', bassBase, scale),
              dur: 2.6, vel: 0.8, chord: c, role: 'root' });
    const role = R.chance(0.5) ? 'fifth' : 'root';
    ev.push({ beat: t0 + 3, type: 'bass', midi: bassPitch(c, role, bassBase, scale),
              dur: 0.8, vel: 0.6, chord: c, role });
    return;
  }

  const hits = [];
  for (let s = 0; s < 16; s++) if (P.bass[s]) hits.push(s);

  hits.forEach((s, i) => {
    const nxt = i < hits.length - 1 ? hits[i + 1] : 16;
    let role = 'root';
    if (sec.intensity >= 3 && i === hits.length - 1 && hits.length > 2) role = 'fifth';
    if (sec.intensity >= 3 && i === 1 && R.chance(0.35)) role = 'oct';

    ev.push({
      beat: t0 + s * 0.25 + (s % 2 ? P.swing * 0.25 : 0),
      type: 'bass',
      midi: bassPitch(c, role, bassBase, scale),
      dur: Math.min((nxt - s) * 0.25 * 0.85, 2),
      vel: i === 0 ? 0.9 : 0.7,
      chord: c, role,
    });
  });
}

/** Arpeggio figures, as index sequences into the five tones of arpTones(). */
const ARP_PATTERNS = {
  up:       [0, 1, 2, 3, 4],
  updown:   [0, 1, 2, 3, 4, 3, 2, 1],
  pendulum: [0, 2, 1, 3, 2, 4, 3, 1],
  broken:   [0, 2, 4, 1, 3, 2, 4, 3],
};

/** Arpeggio for one bar. 'full' = sixteenths, 'light' = eighths. */
function arpBar(ev, t0, c, sec, P, scale, leadBase, barIdx) {
  const tones = arpTones(c, scale, leadBase);
  const pat = ARP_PATTERNS[P.arp];
  const rate = sec.arp === 'full' ? 0.25 : 0.5;
  const steps = 4 / rate;
  const vel = sec.arp === 'full' ? 0.8 : 0.55;

  for (let i = 0; i < steps; i++) {
    const idx = pat[(i + barIdx * steps) % pat.length]; // pattern continues across bars
    ev.push({
      beat: t0 + i * rate + (rate === 0.25 && i % 2 ? P.swing * 0.25 : 0),
      type: 'arp',
      midi: tones[idx],
      dur: rate * 0.9,
      vel: vel * (i % 4 === 0 ? 1 : 0.78),
      pan: ((i % 4) / 3 - 0.5) * 0.8,
      chord: c, idx,
    });
  }
}

/* ── §5.6 composeSong ──────────────────────────────────────────────────── */

/**
 * Build the full score.
 *
 * Everything is precomputed into ONE sorted event list measured in beats.
 * Playback then needs only a lookahead scheduler, and the renderer can read
 * the same data for perfect sync.
 *
 * MODULE INTEGRATION
 *   • Parameters are gathered into `cfg` and passed through the 'compose'
 *     filter (Moods, Hours & Moon, the Mixer's tempo lock).
 *   • The plan goes through the 'plan' filter.
 *   • The finished event list goes through the 'score' filter (step 4b).
 *   • Optional `sigil.partners` (Fusion, M8) are extra melodic voices traced
 *     on the same wheel. They help choose the harmony (at passing-tone weight)
 *     but never override the primary melody.
 *   • Pitched events carry metadata (deg/off/reg/add/cap, chord/role/idx) so
 *     any consumer can recompute pitch under a transform (Live Lens, M9).
 *
 * ⚠ ORDER OF RANDOM DRAWS FROM `R` IS FROZEN. Filters must never draw from R.
 *
 * @returns {object} song
 */
function composeSong(sigil) {
  const R = stream(sigil.hash, 'music');

  /* 1 ─ Base parameters. Same draws, same order, forever. ─────────────── */
  const tonicPc   = R.int(0, 11);
  const modeName  = R.weighted(MODE_NAMES, MODE_WEIGHTS);
  const bpm       = R.int(74, 98);
  const leadTimbre = R.pick(['glass', 'reed', 'koto']);
  const shift     = R.pick([2, 3, 4]);                 // 3rd / 4th / 5th
  const rotK      = shift + 7 * R.int(1, 2);           // same degree shift, different octave of the wheel

  const P = {
    kick:  euclid(R.pick([3, 4, 5]), 16, 0),
    hat:   euclid(R.pick([5, 7, 9, 11]), 16, R.int(0, 15)),
    ghost: euclid(R.pick([2, 3]), 16, R.int(1, 15)),
    bass:  euclid(R.pick([3, 5, 7]), 16, 0),
    swing: R.pick([0, 0.12, 0.2, 0.3]),
    arp:   R.pick(Object.keys(ARP_PATTERNS)),
  };

  const voicing = { seventh: R.chance(0.65), ninth: R.chance(0.4) };
  const bias = Array.from({ length: 7 }, () => R.range(-0.25, 0.25));

  /* 2 ─ Module adjustments. `levels` = per-bus gain multipliers applied at load. */
  const cfg = Hooks.filter('compose', {
    tonicPc, modeName, bpm, leadTimbre, shift, rotK, P, voicing, bias,
    levels: null, partnerTimbres: null, tags: [],
  }, sigil);

  const scale      = MODES[cfg.modeName] || MODES.Aeolian;
  const altTimbre  = cfg.leadTimbre === 'glass' ? 'reed' : 'glass';
  const leadBase   = 57 + mod(cfg.tonicPc - 9, 12);    // A3 … G♯4: a comfortable singing register
  const bassBase   = leadBase - 24;

  const plan = Hooks.filter('plan', makePlan(cfg.rotK, cfg.shift), cfg, sigil);

  /* 3 ─ Fusion partners. Partner 1 sings an octave below; partner 2 in the
         lead register with a contrasting timbre. */
  const partners = sigil.partners || [];
  const partnerVoice = partners.map((_, i) => ({
    timbre: (cfg.partnerTimbres && cfg.partnerTimbres[i]) || (i === 0 ? altTimbre : 'koto'),
    reg: i === 0 ? leadBase - 12 : leadBase,
    gain: 0.62,
    part: i + 1,
  }));

  const events = [], phrases = [];
  let beat = 0;

  /** Emit one melodic line (main or partner) for the current phrase. */
  function emitLine(notes, sec, o) {
    let prevMidi = null, prevDeg = null;

    for (const n of notes) {
      const midi = degToMidi(n.deg, o.reg, scale);
      const t = beat + n.start;
      const len = n.passing ? n.dur * 0.92 : n.glide ? n.dur * 1.04 : n.dur * 0.86;
      const vel = ((n.passing ? 0.5 : 0.78)
                 + (mod(n.start, 4) === 0 ? 0.14 : 0)      // downbeat accent
                 + R.range(-0.05, 0.05)) * o.gain;         // humanise

      // Metadata that lets the Live Lens re-derive pitch from the degree.
      const meta = { deg: n.deg, reg: o.reg, part: o.part || 0 };

      if (sec.voice === 'lead' || sec.voice === 'alt')
        events.push({ beat: t, type: 'lead', timbre: o.timbre, midi, dur: len, vel,
                      from: n.glide ? prevMidi : null, fromDeg: n.glide ? prevDeg : null,
                      ...meta, off: 0, add: 0 });

      if (sec.voice === 'bell' && !n.passing)
        events.push({ beat: t, type: 'bell', midi: midi + 12 > 90 ? midi : midi + 12,
                      dur: n.dur, vel: vel * 0.75, ...meta, off: 0, add: 12, cap: 90 });

      if (o.main && sec.octave && !n.passing)   // Apotheosis doubling
        events.push({ beat: t, type: 'bell', midi: midi + 12, dur: n.dur, vel: vel * 0.3,
                      ...meta, off: 0, add: 12 });

      if (o.main && sec.harm && !n.passing)     // choir, a diatonic third below
        events.push({ beat: t, type: 'harm', midi: degToMidi(n.deg - 2, o.reg, scale),
                      dur: n.dur * 0.95, vel: vel * 0.8, ...meta, off: -2, add: 0 });

      prevMidi = midi; prevDeg = n.deg;
    }
  }

  /* 4 ─ Walk the plan, phrase by phrase. ──────────────────────────────── */
  plan.forEach((sec, si) => {
    const next = plan[si + 1];
    sec.start = beat;
    sec.Tdisp = { phi: (TAU * sec.T.k) / SLOTS, s: sec.T.m };  // continuous form, for §7
    sec.key = sec.T.k + '|' + sec.T.m;                          // identity, for ghost de-duplication

    if (sec.intensity >= 3) events.push({ beat, type: 'crash', vel: 0.7 });

    for (let p = 0; p < sec.phrases; p++) {
      const ph = buildPhrase(sigil, sec.T, sec.density);
      const pps = partners.map((pt) => buildPhrase(pt, sec.T, sec.density));
      const lastPhrase = p === sec.phrases - 1;

      // Partner notes weigh into the harmony at "passing tone" strength.
      const hNotes = pps.length
        ? ph.notes.concat(...pps.map((x) => x.notes.map((n) => ({ ...n, passing: true }))))
        : ph.notes;

      const chords = harmonize(hNotes, scale, cfg.bias, lastPhrase ? 'full' : 'half');
      if (sec.final) chords[3] = 0;  // the Banishing always lands on the tonic

      ph.start = beat; ph.end = beat + 16; ph.chords = chords; ph.si = si; ph.partners = pps;
      ph.path.forEach((n) => (n.beat += beat));
      pps.forEach((x) => x.path.forEach((n) => (n.beat += beat)));

      emitLine(ph.notes, sec, {
        reg: leadBase,
        timbre: sec.voice === 'alt' ? altTimbre : cfg.leadTimbre,
        gain: 1, main: true,
      });
      pps.forEach((x, i) => emitLine(x.notes, sec, partnerVoice[i]));

      chords.forEach((c, b) => {
        const t0 = beat + b * 4;
        const isLastBar = lastPhrase && b === 3;
        // The final pad is held through the tail so the song decays, not stops.
        const padDur = sec.final && isLastBar ? 4 + (sec.tail || 0) + 0.5 : 4.25;

        events.push({ beat: t0, type: 'pad',
                      midis: padVoicing(c, scale, leadBase, cfg.voicing),
                      dur: padDur, vel: sec.pad, bright: sec.intensity, chord: c });

        if (sec.bass) bassBar(events, t0, c, sec, cfg.P, R, bassBase, scale);
        if (sec.arp)  arpBar(events, t0, c, sec, cfg.P, scale, leadBase, b);

        drumBar(events, t0, sec, cfg.P,
                isLastBar && next && next.intensity >= 3 && sec.intensity >= 1, R);
      });

      if (sec.final)  // the last bell, struck into the silence
        events.push({ beat: beat + 16, type: 'bell', midi: leadBase + 12, dur: 8, vel: 0.7,
                      deg: 0, off: 0, reg: leadBase, add: 12, part: 0 });

      phrases.push(ph);
      beat += 16;
    }

    beat += sec.tail || 0;
    sec.end = beat;

    if (sec.drone)
      events.push({ beat: sec.start, type: 'drone', midi: fold(leadBase - 24, 36, 47),
                    dur: sec.end - sec.start, vel: 1 });
  });

  /* 4b ─ Module hook: the whole score, before it is sorted and indexed. A listener may return a
          replacement array (the drum engine, m15, rewrites the kit's part here). It must NOT draw
          from R. With no listener this is the identity, so the core's own output is unchanged. */
  const score = Hooks.filter('score', events, { sigil, cfg, sections: plan, phrases, total: beat });
  score.sort((a, b) => a.beat - b.beat);

  /* 5 ─ Derived data used by the HUD, renderer and reduction ceremony. */
  const chimeNotes = buildPhrase(sigil, { k: 0, m: 1, reverse: false }, 0).notes;

  return {
    cfg,
    bpm: cfg.bpm, spb: 60 / cfg.bpm,
    tonicPc: cfg.tonicPc, modeName: cfg.modeName, scale,
    leadTimbre: cfg.leadTimbre, altTimbre,
    rotK: cfg.rotK, shift: cfg.shift,
    leadBase, bassBase,
    P: cfg.P, voicing: cfg.voicing, levels: cfg.levels,
    validChords: validChords(scale),
    sections: plan, phrases, events: score, total: beat,

    // Pre-extracted beat lists for the renderer's cheap pulse() lookups
    kicks:  score.filter((e) => e.type === 'kick').map((e) => e.beat),
    snares: score.filter((e) => e.type === 'snare' && e.vel > 0.5).map((e) => e.beat),

    // One bell per letter, for the reduction ceremony
    chimes: sigil.nodes.map((_, i) => degToMidi(chimeNotes[i].deg, leadBase, scale) + 12),

    keyName: `${NOTE_NAMES[cfg.tonicPc]} ${cfg.modeName}`,
  };
}

/* ── §5.7 TIME-LOOKUP HELPERS (shared by renderer and HUD) ─────────────── */

/** Index of the section containing `beat`. Linear scan; sections.length is 7. */
function sectionIndexAt(song, beat) {
  let j = 0;
  song.sections.forEach((s, i) => { if (beat >= s.start) j = i; });
  return j;
}

/** Index of the phrase containing `beat`. */
function phraseIndexAt(song, beat) {
  let j = 0;
  song.phrases.forEach((p, i) => { if (beat >= p.start) j = i; });
  return j;
}

/**
 * Pen position along a phrase path: node index + eased fraction.
 * The pen arrives at each node exactly on its note, and eases between them, so
 * a long note reads as a slow, deliberate stroke.
 */
function penProgress(ph, beat) {
  const p = ph.path;
  if (beat <= p[0].beat) return 0;
  for (let i = 0; i < p.length - 1; i++) {
    if (beat < p[i + 1].beat) return i + ease((beat - p[i].beat) / (p[i + 1].beat - p[i].beat));
  }
  return p.length - 1;
}

/**
 * Exponential decay since the most recent event in a sorted list of beats.
 * Binary search, so the renderer can call it every frame without cost.
 * @returns {number} 1 at the instant of the hit, → 0 after
 */
function pulse(arr, beat, rate) {
  let lo = 0, hi = arr.length - 1, last = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= beat) { last = m; lo = m + 1; } else hi = m - 1;
  }
  return last < 0 ? 0 : Math.exp(-(beat - arr[last]) * rate);
}

/**
 * Continuous display transform: morphs from one section's T to the next across
 * the section boundary, beginning 1 beat early and taking 2.5 beats. This is
 * why the wheel visibly *turns* into the Exaltation rather than snapping.
 */
function displayTransform(song, beat) {
  const S = song.sections;
  let j = 0;
  for (let i = 0; i < S.length; i++) if (beat >= S[i].start - 1) j = i;

  const to = S[j].Tdisp, from = S[mod(j - 1, S.length)].Tdisp;
  const p = ease((beat - (S[j].start - 1)) / 2.5);
  const dphi = mod(to.phi - from.phi + Math.PI, TAU) - Math.PI;  // shortest way round

  return { phi: from.phi + dphi * p, s: lerp(from.s, to.s, p) };
}