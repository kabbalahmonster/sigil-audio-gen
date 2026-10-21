'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5d  MOTION — the letters move the knobs · pure, deterministic, no audio context
   --------------------------------------------------------------------------
   A patch is a still photograph of a sound. This file makes it move, and makes
   it move for the same reason everything else here does: because of the sigil.

     MOVERS    a handful of the sigil's LETTERS each take hold of one parameter.
               What a letter moves is decided by what kind of consonant it is,
               in the same four families the kit and the voices already use:
                 liquids  L R W Y          FLOW    wave · layer · chorus · sweep · drift
                 fricatives F S H V Z X C  AIR     bright · echo · breath · grit
                 nasals   M N J            BODY    sub · throat · the kit's room and body
                 plosives B D G K P T Q    STRIKE  the kit's punch, drive, smash, echo,
                                                   filter and level
               So a sigil of liquids travels through its wavetable, one of plosives
               works its drums: different sigils move different things.
     GESTURES  how a parameter moves is one of nine gestures, every one of them
               in time, because every one is a function of the beat:
                 pen      the pen's distance from the centre, as it draws
                 sway     the pen's position, left to right
                 breath   eight beats in and out (the Charge ring's own cycle)
                 phrase   one swell per four-bar phrase
                 section  a climb through each section, released at the next
                 rite     up to the middle of the rite and away again
                 rings    bar by bar through the rings of the letters
                 swell    a gathering in the last bar before each new section
                 throw    thrown at the last beat of each phrase, then let go
               The outer a letter sits, the further it moves its parameter; the
               way its stroke turns round the wheel is the way the knob turns.
     PASSES    the rite loops. The first pass is the rite as written. After it
               each mover leans further, turns gradually into a second gesture
               it was dealt, lets its resting point drift, and two more letters
               wake that were asleep. How much of this happens is `evolve`; how
               the numbers come out is in the DSP core (autoPass), because the
               core is what must agree with itself between a stage and a file.

   WHAT THIS FILE PRODUCES is a table: two curves per mover on a sixteenth-note
   grid across the whole song, normalised to −1…1. The DSP core reads it; the
   interface reads the SAME table with the SAME function to move a knob's bead.
   Nothing is computed twice in two ways, so nothing can disagree.

   DETERMINISM. deal() draws from stream(hash, 'motion') (or 'motion:<n>' for a
   variation) in a FROZEN order. bake() draws nothing: it is geometry and
   arithmetic on the song. Same sigil, same variation, same table, forever.
   ══════════════════════════════════════════════════════════════════════════ */

const Motion = (() => {
  'use strict';

  /** Beats per grid point: one per sixteenth note. */
  const STEP = 0.25;
  const CLASS = SoundDesign.CONSONANT_CLASS;
  const FAMILY = { liquid: 'flow', fricative: 'air', nasal: 'body', plosive: 'strike' };

  /**
   * What may be moved. Only parameters the DSP core reads from the section row (at note-on or
   * per block) are here, because only those can be moved identically live and in a render.
   *   d      how far one mover takes it at full depth, in the parameter's own units
   *   src    the gestures that suit it, likeliest first. The first ones are CONTINUOUS (something
   *          is always happening); a gathering or a throw comes later in the list
   *   lead   heard in every voice of every sigil (the filter, the wavetable, the sends): the
   *          first two movers are always dealt one of these, so no sigil is left standing still
   *   gate   only moves what the patch already has on (a mover must not switch a crusher ON)
   *   kit    belongs to the kit's FX chain, so it rests when that chain is bypassed
   * ⚠ APPEND ONLY: deal() picks from these lists by position.
   */
  const PARAMS = {
    wave:    { fam: 'flow',   label: 'Wave',     lo: 0,  hi: 12,  d: 2.2,  src: ['pen', 'sway', 'phrase', 'rings'], lead: true },
    layer:   { fam: 'flow',   label: 'Layer',    lo: 0,  hi: 8,   d: 0.4,  src: ['section', 'rings', 'rite'] },
    chorus:  { fam: 'flow',   label: 'Chorus',   lo: 0,  hi: 1,   d: 0.38, src: ['breath', 'phrase', 'section', 'rite'], lead: true },
    sweep:   { fam: 'flow',   label: 'Sweep',    lo: 0,  hi: 1,   d: 0.36, src: ['breath', 'phrase', 'pen', 'section'] },
    drift:   { fam: 'flow',   label: 'Drift',    lo: 0,  hi: 1,   d: 0.36, src: ['phrase', 'sway', 'section'] },
    bright:  { fam: 'air',    label: 'Bright',   lo: 0,  hi: 1,   d: 0.3,  src: ['pen', 'phrase', 'breath', 'section', 'swell'], lead: true },
    echo:    { fam: 'air',    label: 'Echo',     lo: 0,  hi: 1,   d: 0.38, src: ['phrase', 'breath', 'throw', 'swell'], lead: true },
    breath:  { fam: 'air',    label: 'Breath',   lo: 0,  hi: 1,   d: 0.3,  src: ['pen', 'phrase', 'breath'] },
    grit:    { fam: 'air',    label: 'Grit',     lo: 0,  hi: 1,   d: 0.26, src: ['section', 'rings', 'swell'], gate: true },
    sub:     { fam: 'body',   label: 'Sub',      lo: 0,  hi: 1,   d: 0.22, src: ['phrase', 'section', 'breath', 'rite'], lead: true },
    throat:  { fam: 'body',   label: 'Throat',   lo: -1, hi: 1,   d: 0.45, src: ['pen', 'sway', 'breath'] },
    dRoom:   { fam: 'body',   label: 'D·Room',   lo: 0,  hi: 1,   d: 0.3,  src: ['phrase', 'breath', 'swell', 'throw'], kit: true },
    dBody:   { fam: 'body',   label: 'D·Body',   lo: -1, hi: 1,   d: 0.4,  src: ['section', 'phrase', 'rings'], kit: true },
    dPunch:  { fam: 'strike', label: 'D·Punch',  lo: -1, hi: 1,   d: 0.4,  src: ['section', 'rings', 'swell'], kit: true },
    dDrive:  { fam: 'strike', label: 'D·Drive',  lo: 0,  hi: 1,   d: 0.3,  src: ['section', 'phrase', 'swell'], kit: true },
    dSmash:  { fam: 'strike', label: 'D·Smash',  lo: 0,  hi: 1,   d: 0.35, src: ['phrase', 'section', 'breath'], kit: true },
    dEcho:   { fam: 'strike', label: 'D·Echo',   lo: 0,  hi: 1,   d: 0.4,  src: ['throw', 'swell'], kit: true },
    dFilter: { fam: 'strike', label: 'D·Filter', lo: -1, hi: 1,   d: 0.5,  src: ['swell'], kit: true },
    drums:   { fam: 'strike', label: 'Level',    lo: 0,  hi: 1.5, d: 0.12, src: ['section', 'phrase'] },
  };
  const NAMES = Object.keys(PARAMS);

  /** Gestures that only ever add (0…1): they are thrown or gathered, never pulled below rest. */
  const UNIPOLAR = new Set(['swell', 'throw']);

  /** What each gesture does, for a legend and a screen reader: "<Wave> <rises and falls with the pen>". */
  const GESTURE = {
    pen: 'rises and falls with the pen',
    sway: 'leans with the pen, left and right',
    breath: 'breathes, eight beats in and out',
    phrase: 'swells once a phrase',
    section: 'climbs through each section',
    rite: 'rises to the middle of the rite and falls away',
    rings: 'steps bar by bar through the letters’ rings',
    swell: 'gathers into each new section',
    throw: 'is thrown at the end of each phrase',
  };
  const SOURCES = Object.keys(GESTURE);

  /** How many letters move something on the first pass (3…6, by the length of the sigil), and how many more can wake. */
  const activeCount = (n) => clamp(Math.round(2.5 + n / 4), 3, 6);
  const LATENT = 2;

  /* ── §5d.1 DEAL: which letter moves what, and how ──────────────────────── */

  const dealt = new Map();

  /**
   * ⚠ THE ORDER OF DRAWS IS FROZEN. Variation 0 is the sigil's own: it starts from its first
   * letter. Other variations start elsewhere on the path and are dealt afresh.
   * @returns {object[]} movers, active ones first: { name, label, letter, node, slot, ring, fam, own,
   *   src, srcB, sign, signB, depth, lo, hi, gain, morph, shift, latent, gate, kit, seed }
   */
  function deal(sigil, variant = 0) {
    const key = sigil.hex + ':' + (variant | 0);
    if (dealt.has(key)) return dealt.get(key);

    const R = stream(sigil.hash, variant ? `motion:${variant | 0}` : 'motion');
    const nodes = sigil.nodes, n = nodes.length, active = activeCount(n);
    const turn0 = R.int(0, n - 1), rot = variant ? turn0 : 0;

    // Which letters: the active movers are spread evenly along the path; the sleepers are letters
    // that move nothing yet, if the sigil has any to spare.
    const who = [];
    for (let i = 0; i < active; i++) who.push(mod(rot + Math.floor((i * n) / active), n));
    const spare = nodes.map((_, i) => i).filter((i) => !who.includes(i));
    for (let i = 0; i < LATENT; i++) {
      who.push(spare.length ? spare[Math.floor(((i + 0.5) * spare.length) / LATENT)]
                            : mod(rot + Math.floor(((i + 0.5) * n) / LATENT), n));
    }

    const taken = new Set(), perFamily = {}, cap = Math.ceil(active / 2), lanes = [];
    // A gated parameter is only dealt to a sigil whose own patch has it on (a mover given a crusher
    // that is off would be a mover wasted). The sigil's nature decides, not the knobs of the moment.
    const gritty = SoundDesign.derive(sigil.hash, 0).grit > 0;
    const free = (k) => !taken.has(k) && (gritty || !PARAMS[k].gate);
    const lead = (k) => !!PARAMS[k].lead;
    const TONE = ['bright', 'wave'];                             // the filter and the wavetable: what "the sound moving" means

    who.forEach((node, i) => {
      const latent = i >= active, nd = nodes[node], first = i < 2;
      const fam = FAMILY[CLASS[nd.letter] || 'fricative'];

      /* What the letter moves: a parameter of its own family if one is free. Two rules keep every
         sigil alive in every mood. The FIRST TWO letters always take a parameter that every voice
         of every sigil answers to (so something is heard to move whatever the kit and the lead
         are doing), one of them the filter or the wavetable; and no family takes more than half
         the movers. */
      let pool = NAMES.filter((k) => free(k) && PARAMS[k].fam === fam && (!first || lead(k)));
      if (!pool.length || (perFamily[fam] || 0) >= cap) {
        pool = NAMES.filter((k) => free(k) && (first ? lead(k) : PARAMS[k].fam !== fam));
        if (!pool.length) pool = NAMES.filter(free);
      }
      // …and one of those two is the filter or the wavetable, whichever the letter is nearer to.
      if (i === 1 && !TONE.includes(lanes[0].name)) {
        const tone = TONE.filter((k) => PARAMS[k].fam === fam);
        pool = tone.length ? tone : TONE;
      }
      const name = R.pick(pool), Pm = PARAMS[name];
      taken.add(name);
      perFamily[Pm.fam] = (perFamily[Pm.fam] || 0) + 1;

      // The first two move all the time (a continuous gesture); the others may also gather or be thrown.
      const steady = Pm.src.filter((x) => !UNIPOLAR.has(x) && x !== 'rite');
      const choice = first && steady.length ? steady : Pm.src;
      const src = R.weighted(choice, choice.map((_, q) => choice.length - q));
      const rest = Pm.src.filter((x) => x !== src);
      const srcB = rest.length ? R.pick(rest) : src;

      // The knob turns the way the stroke leaving this letter turns round the wheel.
      const nx = nodes[mod(node + 1, n)];
      const sign = UNIPOLAR.has(src) ? 1 : mod(nx.slot - nd.slot, SLOTS) <= SLOTS / 2 ? 1 : -1;
      const signB = UNIPOLAR.has(srcB) ? 1 : srcB === src ? -sign : sign;

      lanes.push({
        name, label: Pm.label, letter: nd.letter, node, slot: nd.slot, ring: nd.ring, fam: Pm.fam, own: Pm.fam === fam,
        src, srcB, sign, signB,
        depth: Pm.d * [0.7, 1, 1.3][nd.ring] * R.range(0.85, 1.15),   // outer letters reach further
        lo: Pm.lo, hi: Pm.hi,
        // What Evolve does to it, at full: it reaches this much further, turns this far into its second
        // gesture, and its resting point drifts this many of its own depths (up or down).
        gain: R.range(0.5, 1.2), morph: R.range(0.5, 1),
        shift: R.range(0.8, 1.6) * (R.chance(0.5) ? 1 : -1),
        latent, gate: !!Pm.gate, kit: !!Pm.kit,
        seed: (R.float() * 4294967296) | 0,
      });
    });

    if (dealt.size > 64) dealt.clear();
    dealt.set(key, lanes);
    return lanes;
  }

  /* ── §5d.2 GESTURES: every one a function of the beat ──────────────────── */

  /** Where the pen is at `beat` of phrase `ph`, in the unit frame, exactly as §7 draws it. */
  function penXY(ph, sec, F, beat) {
    const prog = penProgress(ph, beat), i = Math.min(ph.seq.length - 2, Math.floor(prog)), t = prog - i;
    const a = ph.seq[i], b = ph.seq[i + 1], T = sec.Tdisp || ID_T;
    const [x0, y0] = nodeXY(a, T, F), [x1, y1] = nodeXY(b, T, F);
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, k = ph.curves[i] || 0;
    const qx = mx + (F.cx - mx) * k, qy = my + (F.cy - my) * k, u = 1 - t;
    return [u * u * x0 + 2 * u * t * qx + t * t * x1, u * u * y0 + 2 * u * t * qy + t * t * y1];
  }

  /**
   * All nine gestures across the song, one Float32Array(len) each.
   * Bipolar gestures are −1…1; swell and throw are 0…1.
   */
  function gestures(song, sigil, len) {
    const S = song.sections, PH = song.phrases, total = song.total, n = sigil.nodes.length;
    const out = {};
    for (const k of SOURCES) out[k] = new Float32Array(len);
    const F = { cx: 0, cy: 0, R: 1, base: sigil.baseAngle || 0 }, rim = RINGS[RINGS.length - 1];
    const ringAt = (bar) => sigil.nodes[mod(bar, n)].ring - 1;
    let si = 0, pi = 0;

    for (let g = 0; g < len; g++) {
      const b = Math.min(g * STEP, total);
      while (si + 1 < S.length && b >= S[si + 1].start) si++;
      while (pi + 1 < PH.length && b >= PH[pi + 1].start) pi++;
      const sec = S[si], ph = PH[pi], last = si === S.length - 1;
      // The music of a section ends where its tail (the final decay) begins.
      const secEnd = sec.end - (sec.tail || 0), inPhrase = Math.min(b, ph.end);

      const [x, y] = penXY(ph, S[ph.si], F, inPhrase);
      out.pen[g] = clamp((Math.hypot(x, y) / rim) * 2 - 1, -1, 1);
      out.sway[g] = clamp(x / rim, -1, 1);

      out.breath[g] = -Math.cos((TAU * b) / 8);
      out.phrase[g] = -Math.cos((TAU * (inPhrase - ph.start)) / 16);
      out.section[g] = -1 + 2 * ease((b - sec.start) / Math.max(1, secEnd - sec.start));
      out.rite[g] = -Math.cos((TAU * b) / Math.max(1, total));

      const bar = Math.floor(b / 4), into = b - bar * 4;
      out.rings[g] = lerp(ringAt(bar - 1), ringAt(bar), ease(into));           // glides over the bar's first beat

      // swell: gathers through the last bar of a section, and lets go over two beats of the next.
      let sw = 0;
      if (!last && b >= secEnd - 4 && b < secEnd) { const q = (b - (secEnd - 4)) / 4; sw = q * q; }
      else if (si > 0 && b - sec.start < 2) sw = 1 - ease((b - sec.start) / 2);
      out.swell[g] = sw;

      // throw: up in the half-beat before the last beat of a phrase, held through it, gone 1½ beats on.
      let th = 0;
      const toEnd = ph.end - b, since = b - ph.start;
      if (toEnd <= 1.5 && toEnd > 0) th = ease((1.5 - toEnd) / 0.5);
      else if (b >= ph.end) th = 1 - ease((b - ph.end) / 1.5);                 // the song's last throw dies in the tail
      else if (pi > 0 && since < 1.5) th = 1 - ease(since / 1.5);
      out.throw[g] = th;
    }
    return out;
  }

  /* ── §5d.3 BAKE: the table the core and the interface both read ────────── */

  const baked = new WeakMap();   // song.cfg → Map(key → table): one per composition, dropped with it

  /**
   * The automation table for a song.
   * @param {object} o  { variant (0…99), mute (bitmask of movers at rest), kit (false = the kit's FX are bypassed) }
   * @returns {{ key, n, step, len, lanes: object[], curves: Float32Array }}
   *   curves holds, for mover j, curve A at [2j·len, (2j+1)·len) and curve B after it.
   */
  function bake(song, sigil, o = {}) {
    const variant = clamp(o.variant | 0, 0, 99), mute = o.mute | 0, kit = o.kit !== false;
    const key = `${sigil.hex}|${variant}|${mute}|${kit ? 1 : 0}|${song.total}`;
    let per = baked.get(song.cfg);
    if (!per) baked.set(song.cfg, (per = new Map()));
    if (per.has(key)) return per.get(key);

    const lanes = deal(sigil, variant).map((ln, j) => {
      const muted = !!(mute & (1 << j)), resting = muted || (ln.kit && !kit);
      return { ...ln, index: j, muted, resting, why: muted ? 'held still' : ln.kit && !kit ? 'the kit’s FX are bypassed' : '' };
    });
    const len = Math.ceil(song.total / STEP) + 2;
    const G = gestures(song, sigil, len), curves = new Float32Array(lanes.length * 2 * len);
    lanes.forEach((ln, j) => {
      if (ln.resting) return;                              // a mover at rest is a flat line: it adds nothing
      const A = G[ln.src], B = G[ln.srcB], a0 = 2 * j * len, b0 = a0 + len;
      for (let g = 0; g < len; g++) { curves[a0 + g] = A[g] * ln.sign; curves[b0 + g] = B[g] * ln.signB; }
    });

    const table = { key, n: lanes.length, step: STEP, len, lanes, curves };
    if (per.size > 8) per.clear();
    per.set(key, table);
    return table;
  }

  /** "Wave rises and falls with the pen", and which letter is doing it. */
  function describe(ln) {
    return {
      short: `${ln.label} · ${ln.letter}`,
      what: `${ln.label} ${GESTURE[ln.src]}`,
      who: `moved by the letter ${ln.letter}`,
      later: ln.srcB !== ln.src ? `in later passes it ${GESTURE[ln.srcB]}` : 'in later passes it turns the other way',
    };
  }

  return { STEP, PARAMS, NAMES, SOURCES, GESTURE, UNIPOLAR, LATENT, activeCount, deal, gestures, bake, describe };
})();

if (typeof window !== 'undefined') window.Motion = Motion;
