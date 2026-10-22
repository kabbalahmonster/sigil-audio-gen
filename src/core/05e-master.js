'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5e  MASTERING — the rite is listened to, then finished · pure, no audio context
   --------------------------------------------------------------------------
   The sigil writes the song and deals its sound. Nothing before this file ever
   HEARD the result: a reed lead might sit eight decibels under a koto one, a
   four-bit crusher might hiss as loud as the music it was colouring, and one
   rite might leave six decibels louder than the next. A mastering engineer
   fixes those by listening. So does this.

     LISTEN   The song is rendered twice at a low rate with the DSP core's Probe
              attached (no sound is kept, only measurements, a number per tenth
              of a second for everything the probe hears):
                pass A  the parts: how loud each bus is, what each crusher adds
                        that is not the signal, the spectrum of music and kit
                pass B  the mix with the plan laid on: how loud it now leaves
     SOLVE    From pass A: a TRIM for each part, toward a house balance; a CAP
              per section on each crusher's GRAIN (what its bit-depth and
              sample-hold add: the drive and fold are left alone), so that it
              stays a chosen distance under what it colours; a RIDE per section,
              which gives back to the arc of the rite the contrast that
              levelling takes from it; four broad EQ gains toward a house tone;
              and the gain that brings the mix to the level the chain is tuned
              for. From pass B: the make-up gain that lands the result on the
              loudness asked for. Every one is bounded, so a plan can only ever
              nudge: a song is finished, never rewritten.
     FINISH   The letters choose the character of the chain, by the same four
              families that already colour the voices, the kit and the movers:
                fricatives F S H V Z X C   AIR     the top end opens
                nasals     M N J           WEIGHT  the low end is let through
                liquids    L R W Y         WARMTH  more saturation, a softer glue
                plosives   B D G K P T Q   PUNCH   the glue is slower to close
              So a sigil of fricatives is finished bright and one of nasals
              heavy: the finish varies for the reason everything else does.

   THE PLAN is a pure function of (the compiled job, the listener's settings).
   The stage and every render are handed the same plan, and the core that reads
   it is the same core, so what is rendered is what was heard.

   DETERMINISM. character() draws from stream(hash, 'master') (or 'master:<n>')
   in a FROZEN order. Everything else is arithmetic on measurements of a
   deterministic render. Same sigil, same settings: same plan, forever.
   ══════════════════════════════════════════════════════════════════════════ */

const Mastering = (() => {
  'use strict';
  const D = SigilDSP, { MA, MSTRIDE, PA, PSTRIDE, BUS, BUS_NAMES, BUS_DEFAULT, NBAND } = D;

  /** Bump when a plan for the same measurements would come out different (it is part of every cache key). */
  const VERSION = 1;
  /**
   * The rate the song is listened to at; the pre-roll each range is given (the hall and the echoes
   * must be ringing); and how much of the ring-out after the last bar is heard too (a file ends
   * with it, and a loudness meter counts it).
   */
  const RATE = 32000, PRE = 6, TAIL = 6;
  /** The loudness the chain is fed at (LUFS): its thresholds are tuned for a mix at this level. */
  const REF = -20;
  const PARTS = BUS_NAMES.slice(0, 8), KIT = BUS.drums;

  /**
   * THE HOUSE BALANCE.
   * The music's parts: each one's loudness (LUFS, K-weighted, gated) after its default fader and
   * before the effects. Only the differences between them matter. These are the medians of the
   * engine as it was tuned by ear, with two deliberate moves: the choir comes up to where a
   * backing voice belongs (it sat eleven under the lead), and the arpeggio a little with it.
   */
  const HOUSE = { lead: -21.4, harm: -29, bell: -23.4, pad: -26.2, bass: -22.1, arp: -28, drone: -22.9 };
  /**
   * The kit against the music, while the kit is playing (LU, the kit after its own chain, the
   * music after its effects). Measured, the engine put the kit anywhere from two under the music
   * to six over it, four over at the median. The house has it lead, by less.
   */
  const KIT_LEAD = 2.5;
  /**
   * A trim never lifts a part by more than UP or drops it by more than DOWN (dB); a part must sound
   * this long to be judged (s). The kit may be lifted further (KIT_UP): its trim is a plain gain after
   * its own chain, and under a music bus driven as hard as a style can drive it (punk, metal) the kit
   * starts a long way down.
   */
  const TRIM_UP = 4.5, TRIM_DOWN = 6, KIT_UP = 9, MIN_SOUNDING = 2;

  /**
   * THE HOUSE TONE: energy of the low end (below 200 Hz), the low-mids (200–600), the presence
   * (2–6 k) and the air (above 6 k), each against the mids (600–2 k), in dB, as the Probe's bands
   * measure them. WITH a kit, then WITHOUT one: a rite of pads and drones is rightly darker on top
   * than one with cymbals in it, and is not asked to be otherwise. The engine's own median is
   * a touch thick in the low-mids and three to six decibels shy on top; a mix is brought HALF of
   * the way to the house tone, so the correction is a nudge towards clear, never a re-voicing.
   */
  const TONE = [[8.4, 3.6, -4.3, -9], [8.4, 3.6, -6.3, -13]];
  /** How far each EQ band may go, down and up (dB): low shelf, low-mid bell, presence bell, air shelf. */
  const EQ_LIM = [[-5, 3], [-3, 1.5], [-2.5, 3.5], [-3, 4]];

  /**
   * THE NOISE BUDGET: how far under the music a crusher's GRAIN may sit, in dB. The grain is what
   * the quantiser adds (bit-depth steps, dither, sample-hold images) and nothing else: drive and
   * fold are colour, and are never capped. A section asking for more grit is allowed more grain,
   * so the arc of the rite keeps its shape; a mood may ask for more still (cfg.master.noise); the
   * listener's Noise setting moves the whole budget by up to ±span, and at its top lifts it off.
   */
  const NOISE = { base: -26, perGrit: 12, kitBase: -24, perCrush: 10, span: 12, floor: 0.02 };

  /**
   * THE RIDES: a gain per section, on its way into the chain, that shapes the arc of the rite.
   * The chain's compressors press the loud sections toward the quiet ones, and levelling the kit
   * takes away some of the lift its entrances gave; the rides give that contrast back, by setting
   * each quieter section further under the loudest one:
   *   share   …by this share of the distance it already keeps (at full Dynamics)
   *   wide    …but never to more than this distance in all: lo at Dynamics 0, hi at Dynamics 1 (LU)
   *   down    the most any section is ever set down (dB)
   * And a section that ALREADY lies further under than `wide` (an Invocation under a rite whose
   * crusher is driven hard can lie fifteen under) is brought back `lift` of the excess, at most `up`:
   * a quiet opening should draw the ear in, not lose it.
   */
  const RIDE = { share: 0.8, wide: [4, 9], down: 3.5, lift: 0.6, up: 6 };

  const clampN = (x, a, b) => (x < a ? a : x > b ? b : x);
  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const dB = (x) => 10 * Math.log10(x + 1e-30);          // of a power
  const lin = (db) => Math.pow(10, db / 20);             // to an amplitude

  /* ── Loudness, from the probe's hops ─────────────────────────────────── */

  /**
   * Integrated loudness (LUFS) of hops [from, to), as BS.1770 gates it: 400 ms blocks every hop,
   * nothing under −70 LUFS, then nothing more than 10 LU under the mean of what is left.
   * `e` holds K-weighted sums of squares (both channels), `per` samples in each.
   */
  function lufs(e, per, from = 0, to = e.length) {
    let sum = 0, cnt = 0;
    const blk = [];
    for (let i = from; i + 4 <= to; i++) {
      const ms = (e[i] + e[i + 1] + e[i + 2] + e[i + 3]) / (4 * per);
      if (-0.691 + dB(ms) > -70) { blk.push(ms); sum += ms; cnt++; }
    }
    if (!cnt) return -Infinity;
    const gate = (sum / cnt) * 0.1;                       // −10 LU
    let s2 = 0, c2 = 0;
    for (const ms of blk) if (ms > gate) { s2 += ms; c2++; }
    return c2 ? -0.691 + dB(s2 / c2) : -Infinity;
  }
  /** Seconds during which a part is sounding (400 ms blocks above −70 LUFS). */
  function sounding(e, per, hop) {
    let c = 0;
    for (let i = 0; i + 4 <= e.length; i++) if (-0.691 + dB((e[i] + e[i + 1] + e[i + 2] + e[i + 3]) / (4 * per)) > -70) c++;
    return c * hop;
  }
  /** Loudness range (LU, EBU 3342): the spread of 3-second loudness, 10th to 95th percentile, gated at −70 and −20 LU. */
  function range(e, per, hop) {
    const w = Math.max(1, Math.round(3 / hop)), st = [];
    let run = 0;
    for (let i = 0; i < e.length; i++) {
      run += e[i];
      if (i >= w) run -= e[i - w];
      if (i >= w - 1) { const l = -0.691 + dB(run / (w * per)); if (l > -70) st.push(l); }
    }
    if (st.length < 2) return 0;
    const mean = st.reduce((s, l) => s + Math.pow(10, (l + 0.691) / 10), 0) / st.length, rel = -0.691 + dB(mean) - 20;
    const g = st.filter((l) => l > rel).sort((a, b) => a - b);
    if (g.length < 2) return 0;
    const q = (f) => g[clampN(Math.round(f * (g.length - 1)), 0, g.length - 1)];
    return q(0.95) - q(0.1);
  }
  /** The loudest 400 ms (momentary) and 3 s (short-term) of a run of hops, in LUFS. */
  function loudest(e, per, hop) {
    let m = 0, s = 0, run = 0;
    const w = Math.max(1, Math.round(3 / hop));
    for (let i = 0; i < e.length; i++) {
      run += e[i];
      if (i >= w) run -= e[i - w];
      if (i >= w - 1 && run > s) s = run;
      if (i + 4 <= e.length) { const x = e[i] + e[i + 1] + e[i + 2] + e[i + 3]; if (x > m) m = x; }
    }
    return { momentary: -0.691 + dB(m / (4 * per)), short: -0.691 + dB(s / (w * per)) };
  }

  /**
   * Measure finished audio the way a loudness meter would: integrated LUFS, loudness range,
   * loudest short-term, sample peak and true peak (dBFS / dBTP). For reports and tests.
   */
  function measure(L, R, sr) {
    const c = D.kWeight(sr), st = new Float64Array(8), per = Math.round(sr * 0.1), n = Math.floor(L.length / per);
    const e = new Float64Array(n);
    for (let h = 0; h < n; h++) e[h] = D.kSum(c, st, 0, L.subarray(h * per, (h + 1) * per), R.subarray(h * per, (h + 1) * per), per, 1);
    let pk = 0;
    for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > pk) pk = a; if (b > pk) pk = b; }
    const tp = Math.max(D.truePeak(L), D.truePeak(R)), ld = loudest(e, per, 0.1);
    return { lufs: lufs(e, per), range: range(e, per, 0.1), short: ld.short, momentary: ld.momentary,
      peak: 20 * Math.log10(pk + 1e-30), truePeak: 20 * Math.log10(tp + 1e-30), seconds: L.length / sr };
  }

  /* ── The finish: what the letters ask of the chain ───────────────────── */

  const CLASS = SoundDesign.CONSONANT_CLASS;
  /** How much of an ordinary reduced desire each family makes up: a sigil is judged against this. */
  const USUAL = { fricative: 0.31, nasal: 0.16, liquid: 0.2, plosive: 0.33 };
  /**
   * The character of a sigil's finish: six numbers, each −1…1 (0 = the house's own).
   *   air · weight · warmth · punch   from the share of fricatives, nasals, liquids, plosives
   *   glue · width                    from the figure: a long sigil is held together more, one
   *                                   that reaches the outer ring is spread wider
   * Variation 0 is the sigil's own. Another variation keeps half of that and deals the rest.
   */
  function character(sigil, variant = 0) {
    const red = sigil.reduced || '', n = Math.max(1, red.length), share = { fricative: 0, nasal: 0, liquid: 0, plosive: 0 };
    for (const ch of red) share[CLASS[ch] || 'fricative'] += 1 / n;
    const lean = (k) => clampN((share[k] - USUAL[k]) / (USUAL[k] * 1.25), -1, 1);
    const nodes = sigil.nodes || [], outer = nodes.length ? nodes.filter((nd) => nd.ring === 2).length / nodes.length : 1 / 3;
    const own = {
      air: lean('fricative'), weight: lean('nasal'), warmth: lean('liquid'), punch: lean('plosive'),
      glue: clampN((nodes.length - 8.5) / 6, -1, 1), width: clampN((outer - 1 / 3) * 2.4, -1, 1),
    };
    const v = clampN(variant | 0, 0, 99);
    const R = stream(sigil.hash, v ? `master:${v}` : 'master');
    const keep = v ? 0.5 : 0.8, deal = v ? 0.85 : 0.3, out = { variant: v };
    for (const k of ['air', 'weight', 'warmth', 'punch', 'glue', 'width']) {   // ⚠ draw order is frozen
      out[k] = +clampN(own[k] * keep + R.range(-1, 1) * deal, -1, 1).toFixed(3);
    }
    return out;
  }
  /** Two or three words for a finish: "bright · heavy · wide". An even one is called so. */
  function describe(ch) {
    const W = { air: ['veiled', 'bright'], weight: ['lean', 'heavy'], warmth: ['clean', 'warm'], punch: ['smooth', 'struck'],
      glue: ['open', 'held'], width: ['close', 'wide'] };
    const words = Object.keys(W).map((k) => [Math.abs(ch[k] || 0), W[k][(ch[k] || 0) < 0 ? 0 : 1]])
      .filter(([a]) => a >= 0.3).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, w]) => w);
    return words.length ? words.join(' · ') : 'even';
  }

  /* ── The listener's settings ─────────────────────────────────────────── */

  const DEFAULTS = { on: true, target: -14, level: 0.75, noise: 0, dynamics: 0.5, ceiling: -1 };
  /** LUFS targets worth naming. */
  const TARGETS = [[-16, 'Dynamic'], [-14, 'Streaming'], [-12, 'Forward'], [-10, 'Loud']];
  function options(o) {
    o = o || {};
    return { on: o.on !== false, target: clampN(num(o.target, DEFAULTS.target), -24, -8),
      level: clampN(num(o.level, DEFAULTS.level), 0, 1), noise: clampN(num(o.noise, DEFAULTS.noise), -1, 1),
      dynamics: clampN(num(o.dynamics, DEFAULTS.dynamics), 0, 1),
      ceiling: clampN(num(o.ceiling, DEFAULTS.ceiling), -6, -0.1) };
  }

  /* ── Solve, pass A: trims, caps, tone, and the gain in ───────────────── */

  /** Section boundaries as hop indices: [h0, h1) for each section of a job. */
  function sectionHops(job, hop, n) {
    const spb = 60 / job.bpm, S = job.sections, out = [];
    for (let s = 0; s < job.nSec; s++) {
      const a = S[s * PSTRIDE + PA.START] * spb, b = (s + 1 < job.nSec ? S[(s + 1) * PSTRIDE + PA.START] : job.total) * spb;
      out.push([clampN(Math.round(a / hop), 0, n), clampN(Math.round(b / hop), 0, n)]);
    }
    return out;
  }
  const sumOver = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s; };
  const maxOf = (a) => { let m = 0; if (a) for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

  /**
   * How much of a crusher's grain a section may keep. xx: the (K-weighted) energy of the signal
   * without the grain; dd: of the grain; dx: how alike the two are. The part of the grain that is
   * simply "the signal, a little duller" (dx/xx: a sample-hold is also a filter) is not noise and
   * is not counted; the rest is. Scaling the grain by q scales both parts, and this is the largest
   * q that meets the budget.
   */
  function capFor(xx, dd, dx, budgetDb) {
    if (!(xx > 0) || !(dd > 0)) return { cap: 1, ratio: -Infinity };
    const a = dx / xx, noise = Math.max(0, dd - (dx * dx) / xx);
    const ratio = dB(noise / ((1 + a) * (1 + a) * xx));          // where it sits now, under the music
    const b = Math.sqrt(Math.pow(10, budgetDb / 10) * xx), den = Math.sqrt(noise) - a * b;
    const q = den > 0 ? b / den : 1;
    return { cap: clampN(q, NOISE.floor, 1), ratio, gain: a, noise };
  }

  /**
   * From the parts (pass A) to everything except the last gain.
   * `job` is the job that was probed (its sections, levels and `mix` are read); `opts` the listener's settings.
   */
  function solveA(A, job, opts) {
    opts = options(opts);
    const n = A.n, per = A.per, hop = A.hop, mixInfo = job.mix || {}, ch = mixInfo.finish || {}, mood = mixInfo.mood || {};
    const amount = clampN(num(mixInfo.amount, 1), 0, 1.5);
    const levels = job.levels || {}, lv = (b) => num(levels[PARTS[b]], BUS_DEFAULT[b]);
    const bus = (b) => A.bus.subarray(b * n, (b + 1) * n);

    /* 1 · the music's parts against the house, and against each other */
    const secs = sectionHops(job, hop, n), S = job.sections, nSec = job.nSec;
    const music = PARTS.map((_, b) => b).filter((b) => b !== KIT);
    const parts = PARTS.map((name, b) => {
      const kit = b === KIT, e = kit ? A.drm : bus(b);
      const raw = lufs(e, per), secsOn = sounding(e, per, hop), level = lv(b);
      const heard = Number.isFinite(raw) && secsOn >= MIN_SOUNDING && level > 0;
      // Judged at its DEFAULT fader: where the mood put the fader is the mood's business, and is kept.
      // A style may move the house itself (mood.house, dB): in punk the chords are the bed, not an ornament.
      const off = heard && !kit ? HOUSE[name] + num(mood.house && mood.house[name], 0) - (raw + 20 * Math.log10(BUS_DEFAULT[b])) : 0;
      return { name, lufs: raw, secs: secsOn, level, heard, off, trim: 0 };
    });
    // The music as a whole stays where it is (its crusher and its ducking were measured at this level):
    // each trim is a distance from the music's own energy-weighted mean.
    let wsum = 0, wdev = 0;
    for (const b of music) {
      const p = parts[b];
      if (!p.heard) continue;
      const w = Math.pow(10, (p.lufs + 20 * Math.log10(p.level)) / 10) * p.secs;
      wsum += w; wdev += w * p.off;
    }
    const anchor = wsum > 0 ? wdev / wsum : 0;
    const strength = opts.level * clampN(num(mood.level, 1), 0, 1.5);
    const trim = new Float64Array(BUS_NAMES.length).fill(1);
    for (const b of music) {
      const p = parts[b];
      if (!p.heard) continue;
      p.trim = clampN((p.off - anchor) * strength, -TRIM_DOWN, TRIM_UP);
      trim[b] = lin(p.trim);
    }

    /* 2 · what each crusher may keep of its grain, section by section */
    const sec = new Float64Array(3 * nSec).fill(1, 0, 2 * nSec), noise = [];
    const raw = opts.noise >= 1;                                  // "as composed": nothing is capped
    const shift = opts.noise * NOISE.span + num(mood.noise, 0);
    secs.forEach(([h0, h1], s) => {
      const grit = S[s * PSTRIDE + PA.GRIT], crush = S[s * PSTRIDE + PA.DCRUSH];
      const m = capFor(sumOver(A.crX, h0, h1), sumOver(A.crD, h0, h1), sumOver(A.crDX, h0, h1), NOISE.base + NOISE.perGrit * grit + shift);
      const k = capFor(sumOver(A.kcX, h0, h1), sumOver(A.kcD, h0, h1), sumOver(A.kcDX, h0, h1), NOISE.kitBase + NOISE.perCrush * crush + shift);
      if (!raw) { sec[s] = m.cap; sec[nSec + s] = k.cap; }
      noise.push({ music: m.ratio, musicCap: sec[s], kit: k.ratio, kitCap: sec[nSec + s], gain: m.gain || 0, n: m.noise || 0,
        xx: sumOver(A.crX, h0, h1) });
    });

    /* 3 · the music these will make, hop by hop: re-weighed by the trims, and by the grain that is gone */
    const musE = new Float64Array(n), weigh = new Float64Array(n);
    let si = 0, anyMusic = 0;
    for (let h = 0; h < n; h++) {
      while (si + 1 < nSec && h >= secs[si][1]) si++;
      let was = 0, will = 0;
      for (const b of music) { const e = A.bus[b * n + h] * lv(b) * lv(b); was += e; will += e * trim[b] * trim[b]; }
      anyMusic += was;
      let f = was > 0 ? will / was : 1;
      const z = noise[si];
      if (z && z.xx > 0 && z.musicCap < 1) {
        const q = z.musicCap, a = z.gain, r = z.n / z.xx;
        f *= ((1 + q * a) * (1 + q * a) + q * q * r) / ((1 + a) * (1 + a) + r);
      }
      weigh[h] = f; musE[h] = A.mus[h] * f;
    }

    /* 4 · the kit against the music, over the stretches where the kit is playing */
    const kit = parts[KIT];
    let balance = NaN;
    if (kit.heard) {
      let mean = 0, cnt = 0;
      for (let h = 0; h < n; h++) if (A.drm[h] > 0) { mean += A.drm[h]; cnt++; }
      const gate = cnt ? (mean / cnt) * 0.01 : Infinity, beside = new Float64Array(n);
      for (let h = 0; h < n; h++) if (A.drm[h] > gate) beside[h] = musE[h];
      const under = lufs(beside, per);
      // (If there is no music beside it, or next to none (a kit playing alone still has its own hall
      // under it, on the music's side of the mix), there is nothing to balance the kit against.)
      if (anyMusic > 0 && Number.isFinite(under) && under > kit.lufs - 24) {
        balance = kit.lufs - under;
        // What the mood did to the kit's fader, and what the patch asks of its Level on purpose, are kept.
        // (and a style may seat the kit differently: jazz keeps it under the band. mood.house.drums, dB)
        const want = KIT_LEAD + num(mood.house && mood.house.drums, 0) + 20 * Math.log10(Math.max(1e-3, kit.level) / BUS_DEFAULT[KIT])
          + 20 * Math.log10(clampN(num(mixInfo.kit, 1), 0.25, 4));
        kit.off = want - balance;
        kit.trim = clampN(kit.off * strength, -TRIM_DOWN, KIT_UP);
        trim[KIT] = lin(kit.trim);
      }
    }

    /* 5 · the mix that makes, its sections, and the rides that open its arc */
    const mixE = new Float64Array(n), band = new Float64Array(NBAND), tk = trim[KIT] * trim[KIT];
    let eMus = 0, eKit = 0;
    for (let h = 0; h < n; h++) {
      const both = A.mus[h] + A.drm[h], co = both > 0 ? A.mix[h] / both : 1;
      mixE[h] = (musE[h] + A.drm[h] * tk) * co;
      eMus += musE[h]; eKit += A.drm[h] * tk;
      for (let j = 0; j < NBAND; j++) band[j] += A.bMus[j * n + h] * weigh[h] + A.bDrm[j * n + h] * tk;
    }
    const flat = lufs(mixE, per);                                 // before the rides: what pass B will find entering the chain
    const secLufs = secs.map(([h0, h1]) => lufs(mixE, per, h0, h1));
    const top = Math.max(...secLufs.filter(Number.isFinite), -Infinity);
    const dyn = clampN(opts.dynamics * clampN(num(mood.dynamics, 1), 0, 2), 0, 1), rides = [];
    const wide = RIDE.wide[0] + (RIDE.wide[1] - RIDE.wide[0]) * dyn;
    secs.forEach(([h0, h1], s) => {
      let ride = 0;
      if (Number.isFinite(secLufs[s]) && Number.isFinite(top)) {
        const gap = top - secLufs[s];
        ride = gap < wide ? -Math.min(gap * dyn * RIDE.share, wide - gap, RIDE.down) : Math.min((gap - wide) * RIDE.lift, RIDE.up);
      }
      sec[2 * nSec + s] = ride; rides.push(ride);
      const g = Math.pow(10, ride / 10);
      if (g !== 1) for (let h = h0; h < h1; h++) mixE[h] *= g;
    });
    const mixLufs = lufs(mixE, per), heardAny = Number.isFinite(mixLufs);
    const gainIn = heardAny ? clampN(REF - mixLufs, -24, 24) : 0;

    /* 6 · tone: four broad moves, half of the way to the house's (which is darker on top for a rite without a kit) */
    const kitness = clampN(eKit / (eKit + eMus + 1e-30) / 0.4, 0, 1);
    const goal = TONE[0].map((x, j) => x * kitness + TONE[1][j] * (1 - kitness));
    const mid = band[3] || 1e-30;
    const have = [dB((band[0] + band[1]) / mid), dB(band[2] / mid), dB(band[4] / mid), dB(band[5] / mid)];
    const toward = 0.5 * clampN(num(mood.tone, 1), 0, 1.5);
    // The letters' finish, leaned on by the song (an element's, a style's: mood.lean), by the Character amount.
    const lean = (k) => clampN(num(ch[k], 0) + num(mood.lean && mood.lean[k], 0), -1, 1) * amount;
    const colour = [1.3 * lean('weight'), 0.5 * lean('warmth'), 0.6 * lean('air'), 1.4 * lean('air')];
    const eq = have.map((x, j) => (heardAny ? clampN((goal[j] - x) * toward, EQ_LIM[j][0], EQ_LIM[j][1]) : 0) + colour[j]);

    /* 7 · the chain, as the letters ask for it */
    const p = Float64Array.from(D.MASTER_REST);
    p[MA.ON] = 1; p[MA.IN] = gainIn; p[MA.OUT] = 0;
    eq.forEach((g, j) => { p[MA.LOW + j] = g; });
    // Thresholds sit where only the loudest quarter of a −20 LUFS mix reaches them: the bands are
    // held when they jump, not turned down for good (a drone is not a transient).
    p[MA.LO_T] = -23 + 2 * lean('weight'); p[MA.LO_R] = 2.2;       // a heavy finish lets more of the low end through
    p[MA.MID_T] = -24; p[MA.MID_R] = 1.5;
    p[MA.HI_T] = -36 + 2 * lean('air'); p[MA.HI_R] = 2;
    p[MA.GLUE_T] = -23 - 2 * lean('glue'); p[MA.GLUE_R] = 1.8 + 0.5 * lean('glue');
    p[MA.GLUE_A] = 0.03 * Math.pow(2, lean('punch'));              // 15–60 ms: the slower it closes, the more of the hit gets through
    p[MA.GLUE_RL] = 0.25 * Math.pow(2, 0.6 * lean('warmth') - 0.4 * lean('punch'));
    p[MA.DRIVE] = clampN(0.14 + 0.16 * lean('warmth'), 0, 0.5);
    p[MA.WIDTH] = clampN(1.05 + 0.13 * lean('width'), 0.8, 1.3);
    p[MA.MONO] = 0.85;
    p[MA.CEIL] = opts.ceiling; p[MA.CLIP] = 1.5;
    p[MA.GATE] = raw ? 0 : 1;

    return { version: VERSION, on: true, opts, p, trim, sec, nSec, hops: secs,
      report: { parts, anchor, balance, noise, rides, sections: secLufs, mix: mixLufs, flat, kitness, have, goal, eq, finish: ch, amount,
        gainIn, hop, seconds: n * hop, mixPeak: 20 * Math.log10(maxOf(A.pk) + 1e-30) } };
  }

  /* ── Solve, pass B: the last gain ────────────────────────────────────── */

  /** What the chain usually takes from a mix on the way through, in LU: the guess pass B starts from. */
  const CHAIN_LOSS = 2;
  /**
   * If the make-up turns out far from the guess pass B was heard at, the clip and the limiter were
   * heard working at the wrong depth, and pass B is worth hearing once more at the gain found.
   * "Far" is 0.75 dB when they have real work to do, twice that when the loudest peak barely
   * reaches them (then what they take hardly depends on the gain at all).
   */
  const RELISTEN = 0.75;
  const settled = (plan, heardAt) => {
    const d = Math.abs(plan.p[MA.OUT] - heardAt.p[MA.OUT]), r = plan.report || {};
    return d <= RELISTEN || (d <= 2 * RELISTEN && num(r.peak, 99) <= plan.opts.ceiling + 1.5);
  };
  /**
   * Pass A's plan with a first guess at the make-up: what pass B listens to, and what the stage
   * is given while pass B is still being heard. The guess only has to be near: pass B measures
   * what actually leaves the limiter at this gain, and the difference is added.
   */
  function interim(plan) {
    const p = Float64Array.from(plan.p);
    p[MA.OUT] = clampN(plan.opts.target - (REF - CHAIN_LOSS), -24, 30);
    return Object.assign({}, plan, { p, final: false });
  }
  /**
   * `B` is what the probe heard with the interim plan laid on. The make-up moves by the distance
   * from what left the limiter to the loudness asked for. Also notes what the clip and limiter
   * are asked to do, and how the finished mix measures, for the panel.
   */
  function solveB(B, plan) {
    const fin = lufs(B.fin, B.per), heard = Number.isFinite(fin);
    const gainOut = heard ? clampN(plan.p[MA.OUT] + plan.opts.target - fin, -24, 30) : plan.p[MA.OUT];
    const d = gainOut - plan.p[MA.OUT];
    const pk = maxOf(B.opk);
    const p = Float64Array.from(plan.p);
    p[MA.OUT] = gainOut;
    const band = new Float64Array(NBAND);
    for (let j = 0; j < NBAND; j++) band[j] = sumOver(B.bOut, j * B.n, (j + 1) * B.n);
    const mid = band[3] || 1e-30, mEn = sumOver(B.mid, 0, B.n), sEn = sumOver(B.side, 0, B.n);
    const ld = loudest(B.fin, B.per, B.hop), secs = plan.report && plan.report.seconds ? sectionHopsOf(plan, B) : [];
    const report = Object.assign({}, plan.report, {
      measured: lufs(B.mix, B.per),                               // the mix going in: pass A's forecast (flat), checked
      mixPeak: 20 * Math.log10(maxOf(B.pk) + 1e-30),              // its highest sample peak, before the chain (dBFS)
      gainOut, lufs: heard ? fin + d : -Infinity, range: range(B.fin, B.per, B.hop),
      short: ld.short + d, momentary: ld.momentary + d,
      peak: 20 * Math.log10(pk + 1e-30) + gainOut,                // the highest peak the clip and limiter will meet (dBFS)
      after: secs.map(([h0, h1]) => lufs(B.fin, B.per, h0, h1) + d),
      tone: [dB((band[0] + band[1]) / mid), dB(band[2] / mid), dB(band[4] / mid), dB(band[5] / mid)],
      side: dB(sEn / (mEn + 1e-30)),
    });
    return Object.assign({}, plan, { p, report, final: true });
  }
  /** The section boundaries a plan was solved with, as hops of another probe result. */
  function sectionHopsOf(plan, B) { return (plan.hops || []).map(([a, b]) => [clampN(a, 0, B.n), clampN(b, 0, B.n)]); }

  /* ── What the core is sent ───────────────────────────────────────────── */

  /**
   * The plan as the core's 'master' message wants it.
   * `stem`: parts of one mix. They are given the trims and the caps and leave BEFORE the chain, so
   * that side by side they are the mix that entered it; all of them are turned down by the same
   * amount, if the mix they add up to would not fit under full scale with a little to spare.
   */
  function table(plan, stem) {
    if (!plan || !plan.on) return null;
    const p = Float64Array.from(plan.p);
    if (stem) { p[MA.STEM] = 1; p[MA.OUT] = Math.min(0, -1.5 - num(plan.report && plan.report.mixPeak, -1.5)); }
    return { p, trim: Float64Array.from(plan.trim), sec: Float64Array.from(plan.sec) };
  }
  /** A plan that only listens: the chain at rest, the dither riding the signal as it will. For pass A. */
  function neutral(nSec) {
    const p = Float64Array.from(D.MASTER_REST);
    p[MA.ON] = 1; p[MA.GATE] = 1; p[MA.STEM] = 1;
    return { p, trim: new Float64Array(BUS_NAMES.length).fill(1), sec: new Float64Array(3 * nSec).fill(1, 0, 2 * nSec) };
  }
  /**
   * What the stage is given before anything has been heard: the chain as the letters ask, the
   * crushers held back. `like` is the plan the same sigil was last finished by, if there is one
   * (a mood was changed mid-rite): its gains are a far better first guess than the house's.
   */
  function provisional(job, opts, like) {
    opts = options(opts);
    const nSec = job.nSec, n = 8, zero = new Float32Array(n);
    const A = { n, per: 1, hop: 0.1, bus: new Float32Array(8 * n), mus: zero, drm: zero, mix: zero,
      crX: zero, crD: zero, crDX: zero, kcX: zero, kcD: zero, kcDX: zero, bMus: new Float32Array(NBAND * n), bDrm: new Float32Array(NBAND * n) };
    const plan = interim(solveA(A, job, opts));
    if (opts.noise < 1) for (let s = 0; s < nSec; s++) plan.sec[s] = 0.4;
    plan.p[MA.IN] = -4;                                           // the engine's usual mix sits near −16 LUFS
    if (like && like.p && like.opts) {
      plan.p[MA.IN] = like.p[MA.IN]; plan.p[MA.OUT] = like.p[MA.OUT] + (opts.target - like.opts.target);
    }
    return Object.assign(plan, { provisional: true });
  }

  /* ── Jobs and ranges ─────────────────────────────────────────────────── */

  /** A job's reference levels: every fader where the song (its mood) put it, the listener's own moves left out. */
  function referenceLevels(song) {
    const out = {};
    BUS_NAMES.forEach((b, i) => { out[b] = BUS_DEFAULT[i] * num(song && song.levels && song.levels[b], 1); });
    return out;
  }
  /**
   * The job to listen to: the render job at the listening rate, one pass, reference levels.
   * The crushers hold their samples for as long, in time, as they would at a playing rate.
   */
  function probeJob(job, levels, master) {
    return Object.assign({}, job, { sr: RATE, passes: 1, levels: levels || job.levels, master,
      params: Object.assign({}, job.params, { holdK: RATE / 44100 }) });
  }
  /** Cut [0, seconds) into `lanes` ranges on the probe's hop grid: [{ from, to, keep }]. */
  function ranges(seconds, lanes) {
    const hop = D.probeHop(RATE), hops = Math.max(1, Math.ceil(seconds / hop - 1e-9));
    const K = clampN(Math.min(lanes | 0 || 1, Math.floor(seconds / 24) || 1), 1, 8), out = [];
    const pre = Math.ceil(PRE / hop) * hop;
    for (let k = 0; k < K; k++) {
      const a = Math.round((hops * k) / K), b = Math.round((hops * (k + 1)) / K);
      out.push({ keep: a * hop, to: b * hop, from: Math.max(0, a * hop - pre) });
    }
    return out;
  }
  /** Join the probe results of consecutive ranges into one. */
  function join(parts) {
    if (parts.length === 1) return parts[0];
    const n = parts.reduce((s, r) => s + r.n, 0), first = parts[0], out = Object.assign({}, first, { n });
    for (const k of Object.keys(first)) {
      const a = first[k];
      if (!(a instanceof Float32Array) && !(a && a.constructor && a.constructor.name === 'Float32Array')) continue;
      const rows = Math.round(a.length / first.n), dst = new Float32Array(rows * n);
      let at = 0;
      for (const r of parts) {
        for (let j = 0; j < rows; j++) dst.set(r[k].subarray(j * r.n, (j + 1) * r.n), j * n + at);
        at += r.n;
      }
      out[k] = dst;
    }
    return out;
  }
  /** How long a job's first pass lasts, in seconds; and how much of it is listened to (the pass and its ring-out). */
  const secondsOf = (job) => (job.total * 60) / job.bpm;
  const heardOf = (job) => secondsOf(job) + TAIL;

  /**
   * A key for everything pass A hears: the compiled job itself (its events, sections, spectra,
   * lanes, amounts, levels). Two jobs with the same key are the same song to the probe.
   */
  function keyOf(job, levels) {
    let h = 2166136261;
    const mixIn = (x) => { h = Math.imul(h ^ (x | 0), 16777619); };
    const bytes = (a) => {
      if (!a) { mixIn(0); return; }
      const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      // every byte of the small tables; a stride through the large ones (the count and the ends are always in)
      const step = u.length > 1 << 16 ? 7 : 1;
      mixIn(u.length);
      for (let i = 0; i < u.length; i += step) h = Math.imul(h ^ u[i], 16777619);
      for (let i = Math.max(0, u.length - 64); i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
    };
    const text = (s) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); };
    bytes(job.events ? job.events.subarray(0, job.count * D.STRIDE) : null); bytes(job.sections); bytes(job.spectra);
    if (job.auto) { bytes(job.auto.lanes); bytes(job.auto.curves); text(`${job.auto.n}|${job.auto.step}|${job.auto.len}`); }
    if (job.reverb) { bytes(job.reverb.taps); text(`${job.reverb.rt60}|${job.reverb.damp}`); }
    const P = job.params || {};
    text(JSON.stringify([VERSION, D.VERSION, job.count, job.nSec, job.total, +(+job.bpm).toFixed(4), job.tilt, job.density,
      P.reverb, P.waveOff, P.motion, P.evolve, P.pass0 | 0, levels || job.levels]));
    return (h >>> 0).toString(16);
  }
  /** Everything pass B hears that pass A did not: a second key, so a setting that changes nothing is not listened to again. */
  function keyOfPlan(plan) {
    let h = 2166136261;
    const f = new Float64Array(MSTRIDE + plan.trim.length + plan.sec.length);
    f.set(plan.p); f.set(plan.trim, MSTRIDE); f.set(plan.sec, MSTRIDE + plan.trim.length);
    const u = new Uint8Array(f.buffer);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
    return (h >>> 0).toString(16);
  }

  /**
   * The whole thing in one call, on this thread: listen twice, solve, return the plan.
   * (Node, tests, and any host without workers. The app does the same in parallel: m20.)
   * `job` is a render job (SigilPlan.renderJob) at any rate; `levels` its reference levels.
   */
  function analyse(job, opts, levels) {
    const listen = (master, mode) => join(ranges(heardOf(job), 1).map((r) => D.probeRange(probeJob(job, levels, master), r.from, r.to, r.keep, mode)));
    const A = listen(neutral(job.nSec), 1);
    const first = interim(solveA(A, probeJob(job, levels), opts));
    const plan = solveB(listen(table(first), 2), first);
    return settled(plan, first) ? plan : solveB(listen(table(plan), 2), plan);
  }

  return {
    VERSION, RATE, PRE, TAIL, REF, HOUSE, KIT_LEAD, TONE, NOISE, RIDE, DEFAULTS, TARGETS, PARTS,
    lufs, range, loudest, measure, character, describe, options,
    solveA, solveB, interim, table, neutral, provisional,
    referenceLevels, probeJob, ranges, join, secondsOf, heardOf, keyOf, keyOfPlan, analyse, capFor, settled,
  };
})();

if (typeof window !== 'undefined') window.Mastering = Mastering;
