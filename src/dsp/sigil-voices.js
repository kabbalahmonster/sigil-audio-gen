/* ══════════════════════════════════════════════════════════════════════════
   sigil-voices.js — the palette's engines
   --------------------------------------------------------------------------
   The core (sigil-dsp.js) has one family of voices: the sigil's wavetable cube, sung as a
   wave, a vowel, a bell, a bowed pair, a pad, a drone. That is one instrument, many times.
   These are the others. Each is a different KIND of sound-making, not a different setting
   of the same one:

     PLUCK    a string: a delay line with a lossy loop (Karplus–Strong, with dispersion, pick
              position, a wooden body, a second string, a buzzing bridge). Harp, guitar, koto,
              sitar, kalimba-like tines, a struck piano wire.
     MODAL    a resonator bank: the partials of a bar, a bowl, a bell, a skin, a gong, each
              ringing at its own pitch and its own decay, struck, rubbed or shaken.
              Marimba to temple bowl to conga to tam-tam to tambourine.
     ANALOG   band-limited saws, pulses and syncs, stacked and detuned, through a resonant
              filter with its own envelope. Supersaw, reese, acid, PWM strings, brass, sync lead.
     ORGAN    nine drawbars of sine, key click and percussion, a rotating speaker; or a pipe
              with its chiff. Tonewheel, pipe, harmonium, reed.
     DX       four operators and eight ways of joining them: an electric piano, a tine, a
              metal bell, an FM bass, a clavinet, a brass.
     BREATH   something blown: a flute, a shakuhachi, a clarinet, a horn, a whistle; its
              breath, its chiff, its scoop and its vibrato.
     FOLD     a west-coast voice: a sine folded on itself, through a low-pass gate that
              rings like a vactrol. A ping, a bongo, a singing metal.
     CLOUD    grains: a hundred small windowed sounds a second, scattered in pitch and space.
              A shimmer, a swarm, weather.

   HOW THEY ARE PLAYED. An event row names its instrument in P0 (the engine's own slot in the
   INSTRUMENT TABLE: IST numbers each, dealt by the palette, 05j); P1 is the note's accent
   (0…1), P2 its variation (0…1, a function of where it falls in the music, so that the
   same note struck twice is not the same sound twice: a round robin, without samples).
   What the slot says is how the instrument is built. What the SECTION ROW says is how it is
   sounding now, and these engines read it as the cube's voices do, so that every mover (05d)
   animates every engine without being told about any of them:

        BRIGHT   how open it is (cutoff, damping, index, the upper modes)
        WAVE     its position in its own space (pick point, strike point, pulse width, ratio)
        LAYER    how wide it is (the unison's spread, the second string, the doubling)
        SWEEP    how far it moves (the depth of its own LFOs)
        DRIFT    how fast it moves (their rate) and how far it wanders
        SUB      the octave under it
        BREATH   the air in it (noise, chiff, bow, friction)
        THROAT   its body: a formant, a resonance, a cavity, up or down
        HDECAY   how long it rings
        CHORUS   how much it is doubled

   DETERMINISM. Every random number is an integer xorshift seeded from the event's SEED (as
   the core's are). A note sounds the same wherever it is rendered from.

   REAL TIME. No allocation on the audio thread after a voice has been used once (the delay
   lines and modal banks are made the first time a voice slot wants one). No transcendental
   call in a per-sample loop; those are done per note, or per block.
   ══════════════════════════════════════════════════════════════════════════ */
   (function (G) {
    'use strict';
    const D = G.SigilDSP;
    if (!D || !D.kit) return;
    const { sinAt, tabAt, svfSet, decayOf, coefOf, envStart, common, sat, clamp, NZ, TAU, PA, EV, KIND } = D.kit;
    const { NINST, IST } = D;
  
    /**
     * Every engine is registered through this: the row's P3, if it is more than zero, is the seconds in which the note is damped
     * (−60 dB) once it has been let go. A struck or plucked thing rings on its own, and a bell used as a lead would ring for
     * twenty seconds; the part asks for it to be stopped, and the voice does what every voice does when it is told to die.
     */
    const register = (kind, init, render) => D.registerVoice(kind, (c, v, src, o, pb, el) => {
      init(c, v, src, o, pb, el);
      v.slot = src[o + EV.P0] | 0;
      const t60 = src[o + EV.P3];
      if (t60 > 0 && src[o + EV.DUR] > 0) {
        const dur = Math.max(0.02, (src[o + EV.DUR] - el) * c.spb());
        v.dampAt = Math.max(1, Math.round(dur * c.sr));
        v.dampC = decayOf(Math.max(0.02, t60 / 6.9078), c.sr);
      }
    }, render);
    const SQ2 = Math.SQRT2;
  
    /** The instrument slot a row names, as an offset into the table. */
    const slotOf = (c, src, o) => clamp(src[o + EV.P0] | 0, 0, NINST - 1) * IST;
    const lerp = (a, b, t) => a + (b - a) * t;
    /** 1 in [0,1) → phase wrap */
    const frac = (x) => x - Math.floor(x);
  
    /* ═════════════════════════════════════════════════════════════════════════
       PLUCK — Karplus–Strong, with a body
       ─────────────────────────────────────────────────────────────────────────
       IN (the table's numbers)
         2 T60      seconds the note rings, at A3 (220 Hz)
         3 damp     the loop's brightness 0…1: how much of the top the string keeps each round trip
         4 pick     where it is plucked, as a fraction of the string (0 = nowhere in particular)
         5 stiff    0…1: dispersion, the inharmonic shimmer of a thick string (piano, kalimba)
         6 exc      the pluck: 0 noise · 1 a triangle of displacement · 2 the sigil's own cube cell · 3 a fingertip
         7 exb      how hard it is plucked: the brightness of that first shape
         8 body     0…1 how much wooden box there is
         9 bodyLo   Hz of its low resonance        10 bodyHi   Hz of its high one
        11 pair     cents: a second string this far off (0 = one string)      12 pairLvl  its level
        13 mute     0…1 how fast a note-off damps it (0 = let it ring)
        14 buzz     0…1 a bridge that rattles (sitar, tanpura)
        15 vib      cents of vibrato        16 vibHz its rate (the string is bent, by re-tuning the read)
        17 tilt     how much sooner high notes die (decay ∝ (220/f)^tilt)
        18 click    the noise of the plectrum, 0…1
        19 width    0…1 stereo width (the pair on either side)
       ROW  P1 accent · P2 variation (pick point and the second string's drift)
       ═════════════════════════════════════════════════════════════════════════ */
    const KS_MASK = 8191;
  
    /** Phase delay (samples) at ω of a one-pole lowpass y = a·x + (1−a)·y₁. */
    const pdLP = (a, w) => Math.atan2((1 - a) * Math.sin(w), 1 - (1 - a) * Math.cos(w)) / w;
    /** Phase delay (samples) at ω of the first-order allpass (c + z⁻¹)/(1 + c·z⁻¹). */
    function pdAP(c, w) {
      const cs = Math.cos(w), sn = Math.sin(w);
      const nr = c + cs, ni = -sn, dr = 1 + c * cs, di = -c * sn, den = dr * dr + di * di;
      const hr = (nr * dr + ni * di) / den, hi = (ni * dr - nr * di) / den;
      return -Math.atan2(hi, hr) / w;
    }
  
    function initPluck(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, I = c.inst, b = slotOf(c, src, o), P = v.p, q = v.q;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.PLUCK; v.stage = 3;
      const accent = clamp(src[o + EV.P1], 0, 1), vary = clamp(src[o + EV.P2], 0, 1);
      const f = v.f, bright = clamp(S[pb + PA.BRIGHT], 0, 1);
      const seed = v.rng | 0;
      // the loop
      const N = sr / f;
      const damp = clamp(I[b + 3] + (bright - 0.6) * 0.5 + accent * 0.1, 0.05, 1);
      const a = 0.3 + 0.7 * damp;                                  // the loop lowpass's coefficient (1 = no filtering)
      const stiff = clamp(I[b + 5], 0, 1), w0 = TAU * f / sr;
      let cd = -0.85 * stiff * stiff;                              // dispersion allpass (negative: lows lag)
      let tauD = 0;
      if (cd !== 0) { tauD = pdAP(cd, w0); for (let k = 0; k < 8 && tauD > 0.3 * N; k++) { cd *= 0.6; tauD = pdAP(cd, w0); } }  // never more than a third of the line
      const tauLP = pdLP(a, w0);
      let Dt = N - tauLP - tauD;
      if (Dt < 3) Dt = 3;                                          // very high notes: the line cannot be shorter than this
      const Lint = Math.max(2, Math.floor(Dt - 0.5)), d = Dt - Lint;   // d ∈ [0.5, 1.5)
      const ca = (1 - d) / (1 + d);
      // how long it rings
      const t60 = Math.max(0.05, I[b + 2] * Math.pow(220 / f, I[b + 17]) * (0.5 + 0.5 * S[pb + PA.HDECAY]));
      const g = Math.pow(10, (-3 * (1 / f)) / t60);
      P[0] = Lint; P[1] = ca; P[2] = cd; P[3] = a; P[4] = Math.min(0.9999, g);
      P[5] = I[b + 14] * (0.4 + 0.6 * (S[pb + PA.SWEEP] + 0.3));   // buzz
      // the second string
      const pair = I[b + 11], two = pair !== 0 && I[b + 12] > 0;
      P[6] = two ? 1 : 0; P[7] = I[b + 12] * (0.5 + 0.5 * clamp(S[pb + PA.CHORUS] / 0.3, 0, 2));
      let L2 = Lint, ca2 = ca;
      if (two) {
        const N2 = sr / (f * Math.pow(2, (pair + (vary - 0.5) * 2) / 1200));
        let D2 = N2 - tauLP - tauD; if (D2 < 3) D2 = 3;
        L2 = Math.max(2, Math.floor(D2 - 0.5)); ca2 = (1 - (D2 - L2)) / (1 + (D2 - L2));
      }
      P[8] = L2; P[9] = ca2;
      // the delay lines
      if (!v.buf) v.buf = new Float32Array(KS_MASK + 1);
      if (two && !v.buf2) v.buf2 = new Float32Array(KS_MASK + 1);
      // the pluck: the string's first shape
      const exb = clamp(I[b + 7] * (0.6 + 0.6 * accent) + (bright - 0.6) * 0.3, 0.02, 1);
      const pick = I[b + 4] > 0 ? clamp(I[b + 4] * (0.55 + 0.9 * frac(S[pb + PA.WAVE] / 13 + vary * 0.5)), 0.03, 0.5) : 0;
      const exc = I[b + 6] | 0;
      const tab = exc === 2 ? (c.pickCells(pb, 0, false), c.c0) : null, o0 = exc === 2 ? c.tier(f) : 0;
      let r = seed || 0x2545f491, lp = 0, sum = 0;
      const k = 0.04 + 0.96 * exb * exb, buf = v.buf;
      const Lx = Math.max(Lint, L2);
      for (let i = 0; i < Lx; i++) {
        let x;
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        if (exc === 1) { const pp = pick > 0 ? pick : 0.3, u = i / Lx; x = u < pp ? u / pp : (1 - u) / (1 - pp); x = (x * 2 - 1) * 0.8 + 0.25 * exb * r * NZ; }
        else if (exc === 2) x = tabAt(tab, o0, i / Lx);
        else x = r * NZ;
        lp += k * (x - lp);
        buf[i] = exc === 3 ? lp * (0.6 + 0.4 * Math.sin(Math.PI * i / Lx)) : lp;
        sum += buf[i];
      }
      // remove the mean, comb by pick position, normalise
      const mean = sum / Lx;
      let e = 0;
      if (pick > 0) {
        const pd = Math.max(1, Math.round(pick * Lx));
        for (let i = Lx - 1; i >= 0; i--) buf[i] = buf[i] - mean - (buf[(i - pd + Lx) % Lx] - mean) * 0.9;
      } else for (let i = 0; i < Lx; i++) buf[i] -= mean;
      for (let i = 0; i < Lx; i++) e += buf[i] * buf[i];
      const nrm = 0.7 / Math.sqrt(e / Lx + 1e-12);
      for (let i = 0; i < Lx; i++) buf[i] *= nrm;
      if (two) { const b2 = v.buf2; for (let i = 0; i < L2; i++) b2[i] = buf[i % Lx] * (1 - 0.2 * vary) * (1 + 0.2 * (vary - 0.5)); }
      q[0] = Lint; q[6] = L2;            // write heads
      // the body
      const body = I[b + 8] * (0.4 + 0.6 * clamp(S[pb + PA.THROAT] * 0.5 + 0.5, 0, 1.5));
      P[10] = body;
      if (body > 0.001) {
        const sh = Math.pow(2, S[pb + PA.THROAT] * 0.25);
        svfSet(v.cf, 0, sr, I[b + 9] * sh, 5); svfSet(v.cf, 4, sr, I[b + 10] * sh, 4);
      }
      P[11] = (I[b + 18] * (0.4 + 0.6 * accent)) * 0.5;              // the plectrum's noise
      P[12] = decayOf(0.004 + 0.004 * (1 - exb), sr);
      v.lv[0] = 1;
      // vibrato (a slow pitch wobble by re-reading the line at a fractional offset)
      // (a delay swung by A samples at fv Hz bends the pitch by A·2π·fv/sr: so A for the cents asked)
      P[13] = I[b + 15] > 0 && I[b + 16] > 0 ? ((I[b + 15] * Math.LN2) / 1200) * sr / (TAU * I[b + 16]) : 0;
      P[14] = I[b + 16] > 0 ? I[b + 16] / sr : 0;
      // a note that is let go is damped
      P[15] = I[b + 13] > 0 ? decayOf(0.4 - 0.37 * I[b + 13], sr) : 1;
      v.gate = I[b + 13] > 0 ? Math.max(1, Math.round(dur * sr)) : -1;
      v.peak = v.vel * (0.55 + 0.45 * accent) * I[b + 1];
      P[16] = I[b + 19];
      v.ph[0] = 0;
      // what the voice does at its end: it has lost it
      v.lv[1] = 1;
    }
  
    function rPluck(c, v, L, R, from, n) {
      const P = v.p, q = v.q, buf = v.buf, buf2 = v.buf2, sr = c.sr;
      const Lint = P[0] | 0, ca = P[1], cd = P[2], a = P[3], g0 = P[4], buzz = P[5], two = P[6] === 1, lvl2 = P[7], L2 = P[8] | 0, ca2 = P[9];
      const body = P[10], click = P[11], clickD = P[12], vibD = P[13], vibI = P[14], relD = P[15], width = P[16];
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2], b1 = v.cf[4], b2 = v.cf[5], b3 = v.cf[6];
      const gL = v.gl * v.lvl * v.peak, gR = v.gr * v.lvl * v.peak, kd = v.kd;
      let w = q[0] | 0, dx = q[1], dy = q[2], tx = q[3], ty = q[4], zp = q[5];
      let w2 = q[6] | 0, dx2 = q[7], dy2 = q[8], tx2 = q[9], ty2 = q[10], zp2 = q[11];
      let s1 = v.fs[0], s2 = v.fs[1], t1 = v.fs[2], t2 = v.fs[3];
      let vp = v.ph[0], ef = v.lv[1], rel = v.lv[0], cl = click, r = v.rng | 0, kf = v.kf, gate = v.gate;
      const vA = vibD, useVib = vibD > 0;
      for (let i = from; i < n; i++) {
        // the string
        let rd = w - Lint;
        if (useVib) { vp += vibI; if (vp >= 1) vp -= 1; rd -= vA * sinAt(vp); }
        const ri = Math.floor(rd), fr = rd - ri;
        let x = buf[ri & KS_MASK] * (1 - fr) + buf[(ri + 1) & KS_MASK] * fr;
        if (cd !== 0) { const yd = cd * x + dx - cd * dy; dx = x; dy = yd; x = yd; }
        const yt = ca * x + tx - ca * ty; tx = x; ty = yt;
        const z = a * yt + (1 - a) * zp; zp = z;
        let out = z * g0;
        if (buzz > 0) out = out - buzz * 0.33 * out * out * out;
        buf[w & KS_MASK] = out; w++;
        let y = z, y2 = 0;
        if (two) {
          const x2 = buf2[(w2 - L2) & KS_MASK];
          const yt2 = ca2 * x2 + tx2 - ca2 * ty2; tx2 = x2; ty2 = yt2;
          const z2 = a * yt2 + (1 - a) * zp2; zp2 = z2;
          buf2[w2 & KS_MASK] = z2 * g0; w2++;
          y2 = z2;
          y = y * (1 - 0.3 * lvl2) + z2 * lvl2;
        }
        if (cl > 1e-4) { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; y += r * NZ * cl; cl *= clickD; }
        let yl = y, yr = y;
        if (two && width > 0) { const sd = (z - y2) * 0.5 * width; yl += sd; yr -= sd; }
        if (body > 0.001) {
          let u3 = y - s2, u1 = a1 * s1 + a2 * u3, u2 = s2 + a2 * s1 + a3 * u3; s1 = 2 * u1 - s1; s2 = 2 * u2 - s2;
          let w3 = y - t2, w1 = b1 * t1 + b2 * w3, w2v = t2 + b2 * t1 + b3 * w3; t1 = 2 * w1 - t1; t2 = 2 * w2v - t2;
          const bd = (u1 * 1.2 + w1 * 0.9) * body;
          yl += bd; yr += bd;
        }
        if (gate > 0 && --gate === 0) { rel = 1; gate = -2; }
        if (gate === -2) { rel *= relD; }
        const m = (gate === -2 ? rel : 1) * kf; kf *= kd;
        const o1 = yl * m, o2 = yr * m;
        ef = Math.max(Math.abs(o1), ef * 0.99985);
        L[i] += o1 * gL; R[i] += o2 * gR;
      }
      q[0] = w; q[1] = dx; q[2] = dy; q[3] = tx; q[4] = ty; q[5] = zp;
      q[6] = w2; q[7] = dx2; q[8] = dy2; q[9] = tx2; q[10] = ty2; q[11] = zp2;
      v.fs[0] = s1; v.fs[1] = s2; v.fs[2] = t1; v.fs[3] = t2; v.ph[0] = vp; v.lv[1] = ef; v.lv[0] = rel; v.rng = r; v.kf = kf; v.gate = gate;
      P[11] = cl; v.age += n - from;
      if ((ef < 2e-5 && v.age > 256) || kf < 1e-3) v.active = false;
    }
    register(KIND.PLUCK, initPluck, rPluck);
  
  
    /* ═════════════════════════════════════════════════════════════════════════
       MODAL — a bank of resonators
       ─────────────────────────────────────────────────────────────────────────
       A struck or rubbed thing rings at a handful of pitches, each with its own
       decay. Here every one of them is a two-pole resonator, and the "material" is
       the list of them: their ratios to the note, their relative levels and lives.
       The sets below are the partials of real things (bars, bowls, bells, skins,
       gongs), rounded to what is audible; the instrument picks one and says how it
       is struck.
       IN
         2 set      which material (MODAL_SETS)          3 T60     seconds the first mode rings, at middle C
         4 tilt     decay ∝ (261.6/f)^tilt (higher notes die sooner)
         5 colour   −1…1: the upper modes' level (−1 dull, 1 glassy)
         6 hard     0…1 the mallet: soft (few modes) … hard (all of them)
         7 exc      0 struck · 1 a burst of noise (a brush, a fingertip on a skin) · 2 rubbed or bowed · 3 ratcheted
         8 excLen   seconds: the burst, or the bow's attack, or the ratchet's length
         9 bend     the pitch the skin begins at, as a ratio (1 = steady)   10 bendT  seconds it takes to settle
        11 spread   0…1 how far the modes are placed apart in the stereo field
        12 trem     Hz of the tremolo (a vibraphone's fan; 0 = none)          13 tremD  its depth
        14 noise    0…1 the stick, the breath: noise struck with it            15 pos    where it is struck, 0…0.5
        16 upper    a multiple on how long the upper modes live               17 gainVel  how much velocity opens it (0…1)
        18 rel      seconds a rubbed note takes to let go                      19 drive   0…1 a little saturation (a hot skin)
        20 fix      0: follows the note · 1: the pitch is the note's, but the modes are not moved (a drum tuned by hand)
       ROW  P1 accent · P2 variation (the strike point, a little)
       ═════════════════════════════════════════════════════════════════════════ */
    const MAXM = 12, MS = 8;    // modes, and numbers kept for each
    /* [ratios], [levels], [relative lives] */
    const MODAL_SETS = [
      /* 0  marimba (rosewood)   */ [[1, 3.93, 9.2, 16.4], [1, 0.5, 0.16, 0.05], [1, 0.22, 0.07, 0.03]],
      /* 1  vibraphone (metal)   */ [[1, 3.98, 9.84, 15.9], [1, 0.42, 0.22, 0.08], [1, 0.55, 0.3, 0.12]],
      /* 2  glockenspiel         */ [[1, 2.76, 5.4, 8.93, 13.3], [1, 0.55, 0.32, 0.2, 0.1], [1, 0.5, 0.3, 0.18, 0.1]],
      /* 3  tubular bell         */ [[0.5, 1, 1.19, 1.5, 2, 2.5, 3, 4.1], [0.55, 1, 0.8, 0.5, 0.7, 0.32, 0.25, 0.14], [1.9, 1.6, 1.3, 1, 0.85, 0.6, 0.45, 0.3]],
      /* 4  singing bowl         */ [[1, 1.003, 2.71, 2.716, 5.15, 5.16, 8.4], [1, 0.9, 0.6, 0.5, 0.3, 0.25, 0.1], [1, 1, 0.8, 0.8, 0.6, 0.6, 0.4]],
      /* 5  gamelan (bronze)     */ [[1, 2.32, 4.06, 6.21], [1, 0.6, 0.35, 0.16], [1, 0.8, 0.5, 0.3]],
      /* 6  steel pan            */ [[1, 2, 3.01, 4.08, 5.9], [1, 0.7, 0.4, 0.25, 0.1], [1, 0.7, 0.5, 0.35, 0.2]],
      /* 7  kalimba tine         */ [[1, 5.92, 14.1], [1, 0.38, 0.1], [1, 0.12, 0.04]],
      /* 8  wood block           */ [[1, 2.35, 4.6, 7.2], [1, 0.6, 0.3, 0.1], [1, 0.5, 0.3, 0.2]],
      /* 9  conga (membrane)     */ [[1, 1.59, 2.14, 2.3, 2.65, 2.92], [1, 0.55, 0.35, 0.3, 0.2, 0.14], [1, 0.55, 0.35, 0.3, 0.25, 0.2]],
      /* 10 taiko / frame drum   */ [[1, 1.59, 2.14, 2.3, 2.65, 2.92], [1, 0.7, 0.5, 0.4, 0.3, 0.2], [1, 0.7, 0.5, 0.45, 0.4, 0.3]],
      /* 11 timpani              */ [[1, 1.5, 1.99, 2.44, 2.92], [1, 0.6, 0.35, 0.2, 0.12], [1, 0.8, 0.6, 0.45, 0.3]],
      /* 12 tabla (treble)       */ [[1, 2, 3, 4, 5, 6], [1, 0.8, 0.55, 0.4, 0.25, 0.15], [1, 0.8, 0.65, 0.5, 0.4, 0.3]],
      /* 13 cowbell              */ [[1, 1.48, 2.52, 3.9], [1, 0.9, 0.35, 0.15], [1, 0.8, 0.3, 0.2]],
      /* 14 triangle / jingles   */ [[1, 2.74, 5.07, 6.6, 8.6, 10.8], [1, 0.8, 0.6, 0.5, 0.4, 0.3], [1, 0.9, 0.8, 0.7, 0.6, 0.5]],
      /* 15 glass harmonica      */ [[1, 2.32, 4.25, 6.63], [1, 0.45, 0.2, 0.1], [1, 0.8, 0.6, 0.4]],
      /* 16 crotales             */ [[1, 2.47, 4.13, 6.01, 8.4], [1, 0.7, 0.5, 0.35, 0.2], [1, 0.9, 0.8, 0.7, 0.6]],
      /* 17 log drum / slit drum */ [[1, 2.0, 2.92], [1, 0.45, 0.2], [1, 0.45, 0.25]],
      /* 18 tam-tam (gong)       */ [[1, 1.32, 1.76, 2.18, 2.65, 3.0, 3.61, 4.2, 5.3], [0.9, 1, 0.8, 0.7, 0.6, 0.55, 0.45, 0.35, 0.25], [1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4]],
      /* 19 music box comb       */ [[1, 6.27, 12.5], [1, 0.3, 0.08], [1, 0.1, 0.04]],
      /* 20 wind chimes          */ [[1, 2.13, 3.05, 4.6], [1, 0.6, 0.4, 0.25], [1, 0.8, 0.6, 0.4]],
      /* 21 handpan              */ [[1, 2, 2.99, 4.1], [1, 0.75, 0.5, 0.2], [1, 0.65, 0.45, 0.25]],
      /* 22 clave / claves       */ [[1, 2.7], [1, 0.4], [1, 0.3]],
      /* 23 anvil / metal plate  */ [[1, 1.47, 2.09, 2.56, 3.32, 4.6], [1, 0.9, 0.7, 0.55, 0.4, 0.3], [1, 0.9, 0.75, 0.6, 0.5, 0.4]],
    ];
  
    function initModal(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, I = c.inst, b = slotOf(c, src, o), P = v.p, q = v.q;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.MODAL;
      const accent = clamp(src[o + EV.P1], 0, 1), vary = clamp(src[o + EV.P2], 0, 1);
      if (!v.m || v.m.length < M_SIZE) v.m = new Float64Array(M_SIZE);      // (one block of numbers serves the modal bank and the grains: whichever came first, it is the size of the larger)
      const m = v.m; m.fill(0);
      const set = MODAL_SETS[clamp(I[b + 2] | 0, 0, MODAL_SETS.length - 1)], [rat, amp, life] = set;
      const f = v.f, bright = clamp(S[pb + PA.BRIGHT], 0, 1), exc = I[b + 7] | 0;
      const vel = v.vel, velS = I[b + 17];
      const hard = clamp(I[b + 6] * (1 - velS + velS * (0.5 + 0.8 * vel)) + (bright - 0.6) * 0.5 + accent * 0.08, 0.02, 1);
      const colour = clamp(I[b + 5] + (bright - 0.6) * 0.8, -1, 1);
      const t60 = clamp(I[b + 3] * Math.pow(261.6 / f, I[b + 4]) * (0.5 + 0.5 * S[pb + PA.HDECAY]), 0.03, 30);
      const pos = I[b + 15] > 0 ? clamp(I[b + 15] * (0.55 + 0.9 * frac(S[pb + PA.WAVE] / 13 + vary * 0.3)), 0.04, 0.5) : 0;
      const bendR = I[b + 9] > 0 ? I[b + 9] : 1, bendT = Math.max(0.005, I[b + 10]);
      const spread = clamp(I[b + 11] * (0.6 + 0.8 * S[pb + PA.CHORUS] / 0.3), 0, 1.2);
      const bowed = exc === 2;
      let K = 0, endS = 0, ampSum = 0;
      const upper = I[b + 16] > 0 ? I[b + 16] : 1;
      for (let k = 0; k < rat.length && K < MAXM; k++) {
        const fk = f * rat[k];
        if (fk > sr * 0.45) continue;
        const th = TAU * fk / sr;
        // how much of this mode: its own level, the mallet's low pass, the strike point, the tilt of colour
        const hk = Math.min(1, 1 / (1 + Math.pow(fk / (350 + 14000 * hard * hard), 2)));
        const posw = pos > 0 ? 0.3 + 0.7 * Math.abs(Math.sin(Math.PI * (k + 1) * pos * 2)) : 1;
        const lv = amp[k] * hk * posw * Math.pow(k + 1, 0.35 * colour) * (k ? 1 : 1);
        const tk = Math.max(0.01, t60 * life[k] * (k ? upper : 1));
        const r = Math.exp(-6.9078 / (tk * sr));
        const o8 = K * MS;
        m[o8] = 2 * r * Math.cos(th);          // c1
        m[o8 + 1] = -r * r;                     // c2
        // b: the input gain. A rubbed mode is driven by noise the whole time it rings, and a narrow resonator's rms grows as 1/√(1−r):
        // it is given that back, so that a long-ringing bowl is not louder than a short one
        m[o8 + 2] = lv * Math.sin(th) * (bowed ? 0.9 * Math.sqrt(1 - r) : 1);
        m[o8 + 3] = 0; m[o8 + 4] = 0;           // y1, y2
        const pn = spread * Math.sin(1.7 * (k + 1) + 3 * vary + 0.9 * (I[b + 2] | 0));
        const pa = ((clamp(pn, -1, 1) + 1) * Math.PI) / 4;
        m[o8 + 5] = Math.cos(pa) * SQ2; m[o8 + 6] = Math.sin(pa) * SQ2;
        m[o8 + 7] = th;
        endS = Math.max(endS, (tk / 6.9078) * Math.log(Math.max(1.0001, lv * 4e3)) * sr);
        ampSum += lv;
        K++;
      }
      P[0] = K; P[1] = ampSum > 0 ? 1 / Math.sqrt(ampSum) : 1;
      P[2] = exc;
      // the exciter
      // (a mallet cannot stay on the bar for longer than the bar takes to ring once or twice: high notes are struck crisply)
      const lenMallet = Math.max(1, Math.min(Math.round((0.0002 + 0.0042 * (1 - hard)) * sr), Math.round(0.7 * sr / f)));
      P[3] = lenMallet;
      const exLen = Math.max(0.002, I[b + 8]);
      P[4] = exc === 1 ? decayOf(exLen * 0.35, sr) : exc === 3 ? decayOf(Math.max(0.02, exLen * 0.4), sr) : 1;
      P[5] = Math.max(1, I[b + 12] > 0 && exc === 3 ? sr / (I[b + 12]) : 0);         // ratchet period (samples)
      const lpk = 0.04 + 0.96 * hard * hard;
      P[6] = lpk;
      P[7] = bendR; P[8] = Math.exp(-1 / (bendT * sr));
      P[9] = I[b + 14] * (0.4 + 0.8 * accent);                                        // noise layer
      P[10] = decayOf(0.004 + 0.02 * (1 - hard), sr);
      P[11] = I[b + 12] > 0 && exc !== 3 ? I[b + 12] / sr : 0; P[12] = I[b + 13];     // tremolo
      P[13] = I[b + 19];                                                               // drive
      P[14] = Math.sqrt((2 - lpk) / lpk) / 0.577;                                      // the rubbing noise, at unit variance
      v.peak = vel * (0.5 + 0.5 * accent) * I[b + 1];
      v.lv[2] = v.peak;            // (a bowed voice's envelope is re-started below, and wants a peak of its own)
      q[0] = 0;                    // samples since the start
      q[1] = 0;                    // exciter lowpass state
      q[2] = 1;                    // the noise layer's/burst's envelope
      q[3] = 0;                    // tremolo phase
      q[4] = 1;                    // the bend's remaining excess
      q[5] = 0;                    // the bend has been put right
      v.gate = bowed ? Math.max(1, Math.round(dur * sr)) : -1;
      if (bowed) { v.stage = 1; envStart(v, sr, Math.max(0.02, exLen), 0.2, 1, Math.max(0.02, I[b + 18] || 0.3), 1); }
      else v.stage = 3;
      // a voice is over when its modes and its exciter are both over (a brush or a ratchet outlives a short mode)
      const exTail = exc === 1 ? (exLen * 0.35 * 9.2) * sr : exc === 3 ? (Math.max(0.02, exLen * 0.4) * 9.2) * sr : 0;
      v.lv[0] = Math.max(endS, exTail) + (bowed ? (dur + (I[b + 18] || 0.3)) * sr : 0);
      v.lv[1] = 0;
    }
  
    function rModal(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, q = v.q, m = v.m, K = P[0] | 0, norm = P[1], exc = P[2] | 0;
      const lenM = P[3] | 0, bD = P[4], ratchet = P[5], lpk = P[6], bendR = P[7], bendD = P[8], nz = P[9], nzD = P[10], trI = P[11], trD = P[12], drive = P[13];
      const gL = v.gl * v.lvl * v.lv[2] * norm, gR = v.gr * v.lvl * v.lv[2] * norm, kd = v.kd;
      let t = q[0] | 0, lp = q[1], en = q[2], tp = q[3], ex = q[4], r = v.rng | 0, kf = v.kf;
      let e = v.env, st = v.stage, gate = v.gate, aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak;
      // the bend: the modes' frequencies are re-aimed once a block
      if (bendR !== 1 && ex > 1e-3) {
        const ratio = 1 + (bendR - 1) * ex;
        for (let k = 0; k < K; k++) { const o8 = k * MS; const th = m[o8 + 7] * ratio; m[o8] = 2 * Math.sqrt(-m[o8 + 1]) * Math.cos(th); }
        ex *= Math.pow(bendD, n - from);
      } else if (bendR !== 1 && q[5] === 0) {                     // settled: exactly in tune
        for (let k = 0; k < K; k++) { const o8 = k * MS; m[o8] = 2 * Math.sqrt(-m[o8 + 1]) * Math.cos(m[o8 + 7]); }
        q[5] = 1;
      }
      let i = from;
      const bowed = exc === 2;
      for (; i < n; i++) {
        // exciter
        let x = 0;
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        const w = r * NZ;
        if (exc === 0) {
          if (t < lenM) x = Math.sin((Math.PI * (t + 0.5)) / lenM) * (Math.PI / (2 * lenM));
          if (nz > 0 && en > 1e-4) { x += w * nz * en * 0.05; en *= nzD; }
        } else if (exc === 1) {
          if (en > 1e-4) { lp += lpk * (w - lp); x = lp * en * 0.08; en *= bD; }
        } else if (exc === 2) {
          lp += lpk * (w - lp);
          if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
          else if (st === 2) e += dC * (su - e);
          else { e -= rC * e; if (e < 1e-5) { st = 0; } }
          if (gate > 0 && --gate === 0) st = 3;
          x = lp * (e / pk) * P[14];
        } else {
          if (en > 1e-4) {
            const ph = (t % ratchet) / ratchet;
            lp += lpk * (w - lp);
            x = ph < 0.35 ? lp * en * 0.1 * (1 - ph / 0.35) : 0;
            en *= bD;
          }
        }
        if (trI > 0) { tp += trI; if (tp >= 1) tp -= 1; }
        // the modes
        let yl = 0, yr = 0;
        for (let k = 0, o8 = 0; k < K; k++, o8 += MS) {
          const y = m[o8] * m[o8 + 3] + m[o8 + 1] * m[o8 + 4] + m[o8 + 2] * x;
          m[o8 + 4] = m[o8 + 3]; m[o8 + 3] = y;
          yl += y * m[o8 + 5]; yr += y * m[o8 + 6];
        }
        if (trI > 0) { const tm = 1 - trD * (0.5 + 0.5 * sinAt(tp)); yl *= tm; yr *= tm; }
        if (drive > 0) { yl = sat(yl * (1 + 3 * drive)) / (1 + 1.5 * drive); yr = sat(yr * (1 + 3 * drive)) / (1 + 1.5 * drive); }
        const kk = kf; kf *= kd;
        L[i] += yl * gL * kk; R[i] += yr * gR * kk;
        t++;
      }
      q[0] = t; q[1] = lp; q[2] = en; q[3] = tp; q[4] = ex; v.rng = r; v.kf = kf;
      v.env = e; v.stage = st; v.gate = gate; v.age += i - from;
      if (bowed && st === 0 && v.age > v.lv[0]) v.active = false;
      if (!bowed && v.age > v.lv[0]) v.active = false;
      if (kf < 1e-3) v.active = false;
    }
    register(KIND.MODAL, initModal, rModal);
  
  
    /* ═════════════════════════════════════════════════════════════════════════
       ANALOG — band-limited oscillators, stacked, through a resonant filter
       ─────────────────────────────────────────────────────────────────────────
       Saws and pulses with a polyBLEP edge (no aliasing to speak of), up to seven of
       them, spread in pitch and in the stereo field; a 24 dB filter whose cutoff
       follows the note and has an envelope of its own; a sub, some noise, a little
       drive, and the drift of something that is not quite in tune with itself.
       IN
         2 wave     0 saw · 1 pulse (PWM) · 2 triangle · 3 hard sync · 4 saw + pulse
         3 voices   1…7          4 detune   cents, the whole spread        5 spread  0…1 stereo
         6 pw       pulse width 0.05…0.5   7 pwm  depth                    8 pwmHz   its rate
         9 cut      cutoff, in multiples of the note   10 Q   resonance 0.5…10
        11 fenv     how far the filter envelope opens it (× the note)        12 fdec   its decay, seconds
        13 atk      seconds            14 dec  time constant   15 sus 0…1    16 rel   seconds
        17 sub      level of the octave below            18 noise  level
        19 sync     how far a hard sync's slave is swept by the filter envelope (× the note)
        20 drive    0…1                21 drift  cents of slow wander         22 vib   cents   23 vibHz
       ROW  P1 accent (opens the filter) · P2 variation (the unison's start phases)
       ═════════════════════════════════════════════════════════════════════════ */
    const blep = (t, dt) => (t < dt ? ((t /= dt), t + t - t * t - 1) : t > 1 - dt ? ((t = (t - 1) / dt), t * t + t + t + 1) : 0);
    const MAXU = 7;
  
    function initAnalog(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, I = c.inst, b = slotOf(c, src, o), P = v.p, q = v.q;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.ANALOG;
      const accent = clamp(src[o + EV.P1], 0, 1), vary = clamp(src[o + EV.P2], 0, 1), vel = v.vel;
      const bright = clamp(S[pb + PA.BRIGHT], 0, 1), f = v.f;
      const nU = clamp(Math.round(I[b + 3] * (0.5 + 0.5 * clamp(S[pb + PA.LAYER] / 4, 0.4, 1.6)) + 0.0), 1, MAXU);
      const det = I[b + 4] * (0.6 + 0.8 * clamp(S[pb + PA.CHORUS] / 0.3, 0.2, 2));
      const spread = clamp(I[b + 5], 0, 1);
      P[0] = nU; P[1] = I[b + 2] | 0;
      const norm = 1 / Math.sqrt(nU) * (nU > 1 ? 1.15 : 1);
      for (let i = 0; i < nU; i++) {
        const u = nU > 1 ? (i / (nU - 1)) * 2 - 1 : 0;
        const rr = Math.sin((i + 1) * 12.9898 + vary * 78.233 + (v.rng & 1023) * 0.0137);    // a fixed pseudo-random in [-1,1], per unison voice
        const cents = det * u * 0.5 + rr * 0.15 * det * (nU > 1 ? 1 : 0);
        v.inc[i] = (f * Math.pow(2, cents / 1200)) / sr;
        v.ph[i] = frac(0.5 + (nU > 1 ? 0.61803 * (i + 1) + vary * 0.37 : 0));
        const pn = spread * u, pa = ((pn + 1) * Math.PI) / 4;
        v.dk[i] = Math.cos(pa) * SQ2 * norm; v.lv[i] = Math.sin(pa) * SQ2 * norm;
        q[i] = 0;          // slow drift of this voice
      }
      P[2] = I[b + 6]; P[3] = I[b + 7] * (0.4 + 1.2 * S[pb + PA.SWEEP]); P[4] = I[b + 8] * (0.5 + S[pb + PA.DRIFT]) / sr;
      P[5] = I[b + 9]; P[6] = clamp(I[b + 10], 0.5, 12); P[7] = I[b + 11] * (0.5 + accent + 0.5 * vel); P[8] = decayOf(Math.max(0.01, I[b + 12]), sr);
      P[9] = 0.4 + 1.2 * bright;                                      // the BRIGHT column opens and closes the whole filter
      P[10] = I[b + 17] + S[pb + PA.SUB] * 0.5; P[11] = I[b + 18] + S[pb + PA.BREATH] * 0.06;
      P[12] = I[b + 19]; P[13] = 1 + 3 * I[b + 20]; P[14] = I[b + 21];
      P[15] = 1;                                                       // the filter envelope
      P[16] = I[b + 22] > 0 && dur > 0.3 ? (I[b + 22] / 1200) * Math.LN2 : 0; P[17] = I[b + 23] / sr;
      P[18] = 0;                                                       // vibrato's onset
      v.sub = 0; v.ph[9] = 0.25; v.ph[10] = 0;                         // sub phase, vibrato phase
      v.glideC = coefOf(0.03, sr);
      const a = Math.max(0.001, I[b + 13]);
      envStart(v, sr, a, Math.max(0.01, I[b + 14]), clamp(I[b + 15], 0, 1), Math.max(0.01, I[b + 16] / 3), vel * (0.6 + 0.4 * accent) * I[b + 1]);
      svfSet(v.cf, 0, sr, Math.min(sr * 0.4, f * P[5] * P[9]), P[6]);
      v.n = nU;
    }
  
    function rAnalog(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, q = v.q, nU = v.n, wave = P[1] | 0, inc = v.inc, ph = v.ph, gLs = v.dk, gRs = v.lv;
      const pw0 = P[2], pwD = P[3], pwR = P[4], cut = P[5], Q = P[6], fAmt = P[7], fD = P[8], bmul = P[9], subL = P[10], noiseL = P[11];
      const syncD = P[12], drv = P[13], drift = P[14], vibD = P[16], vibI = P[17];
      const glC = v.glideC, kd = v.kd, f = v.f;
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak;
      let fe = P[15], vp = ph[10], psub = ph[9], gl = v.glide, r = v.rng | 0;
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      let l1 = v.fs[0], l2 = v.fs[1], l3 = v.fs[2], l4 = v.fs[3], r1 = v.fs[4], r2 = v.fs[5], r3 = v.fs[6], r4 = v.fs[7];
      let lfo = v.t, a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2];
      const cf = v.cf;
      let vibOn = v.lv[7];
      while (i < n) {
        const m = Math.min(n - i, 32);
        // the filter, once a sub-block
        const fc = Math.min(sr * 0.42, Math.max(30, f * (cut + fAmt * fe) * bmul));
        svfSet(cf, 0, sr, fc, Q); a1 = cf[0]; a2 = cf[1]; a3 = cf[2];
        fe *= Math.pow(fD, m);
        if (drift > 0) for (let u = 0; u < nU; u++) { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; q[u] += ((r * NZ) * drift * 0.00058 - q[u]) * 0.04; }
        const pwNow = clamp(pw0 + pwD * sinAt(frac(lfo)) * 0.45, 0.04, 0.5);
        lfo += pwR * m;
        if (vibD > 0) { vibOn = Math.min(1, vibOn + m / (0.25 * sr)); }
        const end = i + m;
        for (; i < end; i++) {
          if (gl !== 1) { gl += (1 - gl) * glC; if (gl > 0.99995 && gl < 1.00005) gl = 1; }
          let mod = gl;
          if (vibD > 0) { vp += vibI; if (vp >= 1) vp -= 1; mod *= 1 + vibD * vibOn * sinAt(vp) * 0.5; }
          let sl = 0, sr_ = 0;
          for (let u = 0; u < nU; u++) {
            const dt = inc[u] * mod * (1 + q[u]);
            let p = ph[u] + dt; let wrapped = false;
            if (p >= 1) { p -= 1; wrapped = true; }
            ph[u] = p;
            let x;
            if (wave === 0) x = 2 * p - 1 - blep(p, dt);
            else if (wave === 1) { const pp = p - pwNow; x = (p < pwNow ? 1 : -1) + blep(p, dt) - blep(pp < 0 ? pp + 1 : pp, dt) - (2 * pwNow - 1); }
            else if (wave === 2) x = 4 * Math.abs(p - 0.5) - 1;
            else if (wave === 3) {                                  // hard sync: a slave at a swept ratio, reset by its master
              const ratio = 1 + syncD * fe + 0.15 * u;
              let sp = wrapped ? p * ratio : q[8 + u] + dt * ratio;
              if (sp >= 1) sp -= Math.floor(sp);
              q[8 + u] = sp;
              x = 2 * sp - 1;
            } else { const pp = p - pwNow; x = 0.5 * (2 * p - 1 - blep(p, dt)) + 0.5 * ((p < pwNow ? 1 : -1) + blep(p, dt) - blep(pp < 0 ? pp + 1 : pp, dt) - (2 * pwNow - 1)); }
            sl += x * gLs[u]; sr_ += x * gRs[u];
          }
          if (subL > 0.001) { psub += inc[0] * mod * 0.5; if (psub >= 1) psub -= 1; const sb = sinAt(psub) * subL; sl += sb; sr_ += sb; }
          if (noiseL > 0.0005) { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const nz = r * NZ * noiseL; sl += nz; sr_ += nz; }
          if (drv > 1) { sl = sat(sl * drv) / (0.7 + 0.3 * drv); sr_ = sat(sr_ * drv) / (0.7 + 0.3 * drv); }
          // two poles each, twice: 24 dB
          let v3 = sl - l2, v1 = a1 * l1 + a2 * v3, v2 = l2 + a2 * l1 + a3 * v3; l1 = 2 * v1 - l1; l2 = 2 * v2 - l2;
          v3 = v2 - l4; v1 = a1 * l3 + a2 * v3; let v2b = l4 + a2 * l3 + a3 * v3; l3 = 2 * v1 - l3; l4 = 2 * v2b - l4;
          const yl = v2b;
          v3 = sr_ - r2; v1 = a1 * r1 + a2 * v3; v2 = r2 + a2 * r1 + a3 * v3; r1 = 2 * v1 - r1; r2 = 2 * v2 - r2;
          v3 = v2 - r4; v1 = a1 * r3 + a2 * v3; v2b = r4 + a2 * r3 + a3 * v3; r3 = 2 * v1 - r3; r4 = 2 * v2b - r4;
          const yr = v2b;
          if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
          else if (st === 2) e += dC * (su - e);
          else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
          if (gate > 0 && --gate === 0) st = 3;
          const k = e * kf; kf *= kd;
          L[i] += yl * k * v.gl * v.lvl; R[i] += yr * k * v.gr * v.lvl;
        }
        if (st === 0) break;
      }
      v.fs[0] = l1; v.fs[1] = l2; v.fs[2] = l3; v.fs[3] = l4; v.fs[4] = r1; v.fs[5] = r2; v.fs[6] = r3; v.fs[7] = r4;
      P[15] = fe; ph[10] = vp; ph[9] = psub; v.glide = gl; v.rng = r; v.t = lfo; v.lv[7] = vibOn;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.ANALOG, initAnalog, rAnalog);
  
  
    /* ═════════════════════════════════════════════════════════════════════════
       ORGAN — drawbars, a key click, a rotating speaker; or a pipe and its chiff
       ─────────────────────────────────────────────────────────────────────────
       Nine sines at 16′ 5⅓′ 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′, each with its own level; a percussion
       (the second or third harmonic, struck and let go); the click of the contact
       and, for a pipe, the breath of its mouth; the speaker's two rotors, an
       amplitude wobble and a small Doppler, turning left against right.
       IN
         2…10 the drawbars, 0…1, at the ratios ORGAN_RATIO     11 perc  level       12 percH  2 or 3 (the harmonic)
        13 percDec  seconds        14 click   level                      15 chiff   level (the pipe's mouth)
        16 leslie   depth 0…1      17 leslieHz  how fast it turns        18 drive   0…1
        19 reed     0…1 odd harmonics added (a reed pipe, a harmonium)   20 atk    seconds   21 rel   seconds
        22 drift    cents of a slow detune (a tonewheel is not a crystal)  23 vib   cents (a slow swell of pitch)
       ROW  P1 accent · P2 variation
       ═════════════════════════════════════════════════════════════════════════ */
    const ORGAN_RATIO = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];
  
    function initOrgan(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, I = c.inst, b = slotOf(c, src, o), P = v.p;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.ORGAN;
      const accent = clamp(src[o + EV.P1], 0, 1), vary = clamp(src[o + EV.P2], 0, 1), f = v.f;
      const bright = clamp(S[pb + PA.BRIGHT], 0, 1);
      const reed = clamp(I[b + 19], 0, 1);
      let tot = 0;
      for (let k = 0; k < 9; k++) {
        const r = ORGAN_RATIO[k], fk = f * r;
        let lv = fk < sr * 0.45 ? clamp(I[b + 2 + k], 0, 1) : 0;
        // the brightness: the upper drawbars are pulled out as it opens, the lowest let in as it closes
        const up = Math.log2(Math.max(0.5, r)) / 3;
        lv *= clamp(0.45 + 0.9 * bright + (0.5 - bright) * (-up) * 0.3 - up * (1 - bright) * 0.4, 0.1, 1.4);
        if (reed > 0 && (r === 3 || r === 5 || r === 1) && fk < sr * 0.45) lv += reed * 0.5 / r;      // (and never above the Nyquist: a phase that steps more than once round is off the table)
        v.q[k] = lv; tot += lv;                                // (the levels are kept in q)
        v.inc[k] = (fk / sr);
        v.ph[k] = frac(0.37 * k + vary * 0.2);
      }
      const nrm = tot > 0 ? 1 / Math.max(1, tot * 0.55) : 1;
      for (let k = 0; k < 9; k++) v.q[k] *= nrm;
      const pn = I[b + 12] >= 3 ? 3 : 2, pf = f * pn;
      P[0] = pf < sr * 0.45 ? I[b + 11] * (0.5 + 0.5 * accent) : 0; P[1] = pf / sr; v.q[23] = vary;
      P[2] = decayOf(Math.max(0.02, I[b + 13]), sr);
      P[3] = I[b + 14] * (0.6 + 0.8 * accent); P[4] = decayOf(0.003, sr);
      P[5] = I[b + 15] * (0.5 + S[pb + PA.BREATH] * 2); P[6] = decayOf(0.05 + 0.03 * vary, sr);
      svfSet(v.cf, 0, sr, clamp(f * 3, 200, 9000), 2.2);
      P[7] = I[b + 16] * (0.5 + S[pb + PA.SWEEP]); P[8] = (I[b + 17] * (0.6 + S[pb + PA.DRIFT] * 0.8)) / sr;
      P[9] = I[b + 18] > 0 ? 1 + 3 * I[b + 18] : 0;
      P[10] = I[b + 22] > 0 ? (I[b + 22] / 1200) * Math.LN2 : 0;
      P[11] = I[b + 23] > 0 ? (I[b + 23] / 1200) * Math.LN2 : 0;
      P[12] = 1 - 2 * (vary - 0.5) * 0.2;
      v.sub = S[pb + PA.SUB] * 0.3;
      envStart(v, sr, Math.max(0.003, I[b + 20]), 0.05, 1, Math.max(0.01, I[b + 21] / 3), v.vel * (0.6 + 0.4 * accent) * I[b + 1]);
      v.lv[0] = 1; v.lv[1] = 1; v.q[19] = P[3] > 0 ? 1 : 0;           // (the key click's envelope: kept from block to block)
    }
  
    function rOrgan(c, v, L, R, from, n) {
      const P = v.p, q = v.q, inc = v.inc, ph = v.ph, kd = v.kd;
      const pLvl = P[0], pInc = P[1], pDec = P[2], clk = P[3], clkD = P[4], chf = P[5], chfD = P[6];
      const lesD = P[7], lesI = P[8], drv = P[9], drift = P[10], vib = P[11], sub = v.sub;
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2];
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak;
      const gl = v.gl * v.lvl, gr = v.gr * v.lvl;
      let pp = q[22], rot = q[21], wob = q[20], pp2 = q[23], pe = v.lv[0], ce = q[19], he = v.lv[1], prevN = v.lv[3], r = v.rng | 0;
      let s1 = v.fs[0], s2 = v.fs[1];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from, t = v.t;
      for (; i < n; i++) {
        // a tonewheel's drift and a slow swell of pitch
        let md = 1;
        if (drift > 0 || vib > 0) { wob += 1.7 / c.sr; if (wob >= 1) wob -= 1; md = 1 + drift * sinAt(frac(wob * 0.37)) * 0.5 + vib * sinAt(wob) * Math.min(1, t * 0.8) * 0.5; }
        let y = 0;
        for (let k = 0; k < 9; k++) {
          const lv = q[k];
          if (lv === 0) continue;
          let p = ph[k] + inc[k] * md; if (p >= 1) p -= 1; ph[k] = p;
          y += sinAt(p) * lv;
        }
        if (sub > 0.001) { pp = ph[0] * 0.5; y += sinAt(pp) * sub; }
        if (pLvl > 0 && pe > 1e-4) { pp2 += pInc * md; if (pp2 >= 1) pp2 -= 1; y += sinAt(pp2) * pe * pLvl; pe *= pDec; }
        if (clk > 0 && ce > 1e-4 || chf > 0 && he > 1e-4) {
          r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const nz = r * NZ;
          if (clk > 0 && ce > 1e-4) { y += (nz - prevN) * clk * ce * 0.5; prevN = nz; ce *= clkD; }
          if (chf > 0 && he > 1e-4) {
            const v3 = nz - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3; s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
            y += v1 * chf * he * 0.6; he *= chfD;
          }
        }
        if (drv > 0) y = sat(y * drv) / (0.8 + 0.2 * drv);
        // the rotors
        let yl = y, yr = y;
        if (lesD > 0) { rot += lesI; if (rot >= 1) rot -= 1; const m = sinAt(rot) * lesD * 0.5; yl = y * (1 + m); yr = y * (1 - m); }
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const k2 = e * kf; kf *= kd; t += 1 / c.sr;
        L[i] += yl * k2 * gl; R[i] += yr * k2 * gr;
      }
      q[19] = ce; q[20] = wob; q[21] = rot; q[22] = pp; q[23] = pp2; v.lv[0] = pe; v.lv[1] = he; v.lv[3] = prevN; v.rng = r; v.fs[0] = s1; v.fs[1] = s2; v.t = t;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.ORGAN, initOrgan, rOrgan);
  
    /* ═════════════════════════════════════════════════════════════════════════
       DX — four operators
       ─────────────────────────────────────────────────────────────────────────
       Sines that bend one another's phase. Eight ways of joining four of them (ALG), each
       with a ratio, a level (an index, if it modulates; an amplitude, if it is heard) and
       an envelope of its own. A note's loudness also opens it, so a hard key barks and a
       soft one is round.
       IN
         2 alg  0…7     3 fb   the last modulator's feedback 0…1.5
         4…7   ratios of operators 1…4 to the note
         8…11  levels of 1…4 (in cycles of phase, if modulating)
        12…15  decay time constants of 1…4 (seconds)            16…19  sustain levels of 1…4 (0…1)
        20 vel   0…1 how much velocity opens the modulators     21 atk   seconds
        22 open  0…1 how much the BRIGHT column opens the indices    23 rel   seconds
       ROW  P1 accent · P2 variation
       ═════════════════════════════════════════════════════════════════════════ */
    /* for operator j (0 = the first, heard last): the operators that modulate it; and which are heard */
    const DX_ALG = [
      { mods: [[1], [2], [3], []], car: [1, 0, 0, 0], fb: 3 },                 // 0  4→3→2→1
      { mods: [[1, 2], [], [3], []], car: [1, 0, 0, 0], fb: 3 },               // 1  (4→3) + 2 → 1
      { mods: [[1], [], [3], []], car: [1, 0, 1, 0], fb: 3 },                  // 2  4→3 and 2→1, both heard (the electric piano's)
      { mods: [[1, 2, 3], [], [], []], car: [1, 0, 0, 0], fb: 3 },             // 3  2, 3 and 4 all into 1
      { mods: [[1, 2], [3], [], []], car: [1, 0, 0, 0], fb: 3 },               // 4  4→2→1 and 3→1
      { mods: [[3], [3], [3], []], car: [1, 1, 1, 0], fb: 3 },                 // 5  4 into 1, 2 and 3, all heard
      { mods: [[], [], [3], []], car: [1, 1, 1, 0], fb: 3 },                   // 6  three voices, the third bent by the fourth
      { mods: [[], [], [], []], car: [1, 1, 1, 1], fb: 3 },                    // 7  four sines, added
    ];
  
    function initDx(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, I = c.inst, b = slotOf(c, src, o), P = v.p, q = v.q;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.DX;
      const accent = clamp(src[o + EV.P1], 0, 1), vary = clamp(src[o + EV.P2], 0, 1), f = v.f, vel = v.vel;
      const bright = clamp(S[pb + PA.BRIGHT], 0, 1), alg = clamp(I[b + 2] | 0, 0, 7), A = DX_ALG[alg];
      P[0] = alg; P[1] = I[b + 3] * (0.5 + 0.5 * bright);
      const open = I[b + 22] > 0 ? (1 - I[b + 22]) + I[b + 22] * (0.35 + 1.3 * bright) : 1;
      const vs = I[b + 20], velK = 1 - vs + vs * (0.35 + 0.9 * vel + 0.25 * accent);
      for (let j = 0; j < 4; j++) {
        v.inc[j] = (f * I[b + 4 + j]) / sr;
        v.ph[j] = frac(j * 0.173 + vary * 0.11);
        const lvl = I[b + 8 + j];
        // a modulator's bandwidth (Carson: 2·fm·(1 + index)) is kept under the Nyquist, so that a high note of a bright patch is not folded back
        const cap = A.car[j] ? Infinity : Math.max(0.02, (0.4 * sr / (2 * f * I[b + 4 + j]) - 1) / TAU);
        q[j] = A.car[j] ? lvl : Math.min(lvl * open * velK, cap);   // modulators are opened; what is heard is not
        v.dk[j] = decayOf(Math.max(0.005, I[b + 12 + j] * (0.6 + 0.8 * S[pb + PA.HDECAY] * 0.5 + 0.2)), sr);
        q[4 + j] = clamp(I[b + 16 + j], 0, 1);                       // sustain level
        q[8 + j] = 1;                                                // the operator's envelope position
        q[12 + j] = 0;                                               // its last output (for feedback)
      }
      v.glideC = coefOf(0.03, sr);
      envStart(v, sr, Math.max(0.002, I[b + 21]), 0.08, 1, Math.max(0.01, I[b + 23] / 3), vel * (0.6 + 0.4 * accent) * I[b + 1]);
    }
  
    function rDx(c, v, L, R, from, n) {
      const P = v.p, q = v.q, inc = v.inc, ph = v.ph, dk = v.dk, kd = v.kd;
      const A = DX_ALG[P[0] | 0], fbAmt = P[1], glC = v.glideC;
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak;
      const gl = v.gl * v.lvl, gr = v.gr * v.lvl;
      const l0 = q[0], l1 = q[1], l2 = q[2], l3 = q[3];
      const bits = (list) => list.reduce((m, k) => m | (1 << k), 0);
      const mm0 = bits(A.mods[0]), mm1 = bits(A.mods[1]), mm2 = bits(A.mods[2]);
      const c0 = A.car[0], c1 = A.car[1], c2 = A.car[2], c3 = A.car[3];
      let ec0 = q[8], ec1 = q[9], ec2 = q[10], ec3 = q[11], fbA = q[15], fbP = q[14];
      const s0 = q[4], s1 = q[5], s2 = q[6], s3 = q[7], d0 = dk[0], d1 = dk[1], d2 = dk[2], d3 = dk[3];
      const i0 = inc[0], i1 = inc[1], i2 = inc[2], i3 = inc[3];
      let p0 = ph[0], p1 = ph[1], p2 = ph[2], p3 = ph[3];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from, g = v.glide;
      for (; i < n; i++) {
        if (g !== 1) { g += (1 - g) * glC; if (g > 0.99995 && g < 1.00005) g = 1; }
        p3 += i3 * g; if (p3 >= 1) p3 -= 1;
        p2 += i2 * g; if (p2 >= 1) p2 -= 1;
        p1 += i1 * g; if (p1 >= 1) p1 -= 1;
        p0 += i0 * g; if (p0 >= 1) p0 -= 1;
        ec0 *= d0; ec1 *= d1; ec2 *= d2; ec3 *= d3;
        // the fourth operator is bent by nothing but its own last two outputs; the third by the fourth; and so down
        const ph3 = p3 + fbAmt * fbA, raw3 = sinAt(ph3 - Math.floor(ph3));
        fbA = 0.5 * (raw3 + fbP); fbP = raw3;
        const o3 = raw3 * l3 * (s3 + (1 - s3) * ec3);
        const ph2 = p2 + (mm2 & 8 ? o3 : 0), o2 = sinAt(ph2 - Math.floor(ph2)) * l2 * (s2 + (1 - s2) * ec2);
        const ph1 = p1 + (mm1 & 4 ? o2 : 0) + (mm1 & 8 ? o3 : 0), o1 = sinAt(ph1 - Math.floor(ph1)) * l1 * (s1 + (1 - s1) * ec1);
        const ph0 = p0 + (mm0 & 2 ? o1 : 0) + (mm0 & 4 ? o2 : 0) + (mm0 & 8 ? o3 : 0), o0 = sinAt(ph0 - Math.floor(ph0)) * l0 * (s0 + (1 - s0) * ec0);
        const y = (c0 ? o0 : 0) + (c1 ? o1 : 0) + (c2 ? o2 : 0) + (c3 ? o3 : 0);
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const k = e * kf; kf *= kd;
        L[i] += y * k * gl; R[i] += y * k * gr;
      }
      ph[0] = p0; ph[1] = p1; ph[2] = p2; ph[3] = p3; q[8] = ec0; q[9] = ec1; q[10] = ec2; q[11] = ec3; q[15] = fbA; q[14] = fbP; v.glide = g;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.DX, initDx, rDx);
  
  
    /* ═════════════════════════════════════════════════════════════════════════
       BREATH — something blown
       ─────────────────────────────────────────────────────────────────────────
       A harmonic spectrum (of whichever parity the tube has), breath noise shaped around the
       note, a cavity that colours it, the chiff of the attack and the scoop up into pitch,
       a vibrato that arrives after the note has begun, and the slight instability of lungs.
       Not a physical model: a model of what is heard, which is in tune at once.
       IN
         2 air     breath level 0…1                 3 band   the breath's centre, in multiples of the note
         4 tilt    harmonic fall-off exponent       5 even   the even harmonics' level 0…1 (0: a clarinet's tube)
         6 vib     cents         7 vibHz   8 vibDelay  seconds before it arrives
         9 atk     seconds       10 rel    seconds           11 chiff   level of the attack's noise
        12 scoop   semitones it comes up from       13 scoopT  seconds it takes
        14 over    0…1 how much velocity overblows it (the second harmonic swells)
        15 formant Hz of the cavity        16 formantQ  0…1 how much of it
        17 jitter  cents of lungs          18 flutter  0…1 tremolo          19 drive  0…1     20 edge   0…1 a bray (brass, sax)
       ROW  P1 accent · P2 variation
       ═════════════════════════════════════════════════════════════════════════ */
    const BR_H = 8;
  
    function initBreath(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, I = c.inst, b = slotOf(c, src, o), P = v.p, q = v.q;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.BREATH;
      const accent = clamp(src[o + EV.P1], 0, 1), vary = clamp(src[o + EV.P2], 0, 1), f = v.f, vel = v.vel;
      const bright = clamp(S[pb + PA.BRIGHT], 0, 1);
      const tilt = clamp(I[b + 4] * (1.3 - 0.6 * bright), 0, 4), even = I[b + 5], over = I[b + 14] * (0.4 + 0.9 * vel);
      let tot = 0;
      for (let h = 1; h <= BR_H; h++) {
        let a = Math.pow(h, -tilt) * (h % 2 === 0 ? even : 1);
        if (h === 2) a *= 1 + over * 2.2;
        if (f * h > sr * 0.45) a = 0;
        q[h - 1] = a; tot += a;
      }
      const nrm = tot > 0 ? 1 / Math.sqrt(tot) * 0.9 : 1;
      for (let h = 0; h < BR_H; h++) q[h] *= nrm;
      P[0] = I[b + 2] * (0.6 + 0.8 * vel + 2 * S[pb + PA.BREATH]) * 0.25; P[1] = I[b + 3];
      P[2] = I[b + 6] > 0 ? (I[b + 6] / 1200) * Math.LN2 : 0; P[3] = I[b + 7] / sr; P[4] = Math.max(0.001, I[b + 8]) * sr;
      P[5] = I[b + 11] * (0.5 + accent) * 0.5; P[6] = decayOf(0.025 + 0.03 * vary, sr);
      P[7] = (I[b + 12] * Math.LN2) / 12; P[8] = Math.exp(-1 / (Math.max(0.005, I[b + 13]) * sr));
      P[9] = I[b + 17] > 0 ? (I[b + 17] / 1200) * Math.LN2 : 0;
      P[10] = I[b + 18]; P[11] = I[b + 19] > 0 ? 1 + 2 * I[b + 19] : 0; P[12] = I[b + 20];
      P[13] = I[b + 16] * (0.5 + 0.5 * clamp(S[pb + PA.THROAT] * 0.5 + 0.5, 0, 1.5));
      const fk = I[b + 15] * Math.pow(2, S[pb + PA.THROAT] * 0.3);
      svfSet(v.cf, 0, sr, clamp(f * P[1], 80, sr * 0.4), 1.6);          // the breath's band
      svfSet(v.cf, 4, sr, clamp(fk > 0 ? fk : f * 2, 100, sr * 0.4), 3.5); // the cavity
      svfSet(v.cf, 8, sr, clamp(f * 6, 200, sr * 0.42), 0.9);           // the chiff's band
      v.ph[10] = 0; v.ph[11] = 0;
      v.lv[0] = 1;                         // the scoop's remaining excess
      v.lv[1] = 1;                         // the chiff's envelope
      v.glideC = coefOf(0.03, sr);
      v.t = 0;
      envStart(v, sr, Math.max(0.004, I[b + 9]), 0.1, 0.92, Math.max(0.01, I[b + 10] / 3), vel * (0.6 + 0.4 * accent) * I[b + 1]);
      q[12] = 0; q[13] = 0;                // the lungs' wander; the flutter's phase
    }
  
    function rBreath(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, q = v.q, ph = v.ph, kd = v.kd;
      const air = P[0], vibD = P[2], vibI = P[3], vibDelay = P[4], chf = P[5], chfD = P[6], scoop = P[7], scoopD = P[8], jit = P[9];
      const flut = P[10], drv = P[11], edge = P[12], formant = P[13];
      const b1 = v.cf[0], b2 = v.cf[1], b3 = v.cf[2], bk = v.cf[3], f1 = v.cf[4], f2 = v.cf[5], f3 = v.cf[6], fk = v.cf[7];
      const h1 = v.cf[8], h2 = v.cf[9], h3 = v.cf[10], hk = v.cf[11];
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak, glC = v.glideC;
      const gl = v.gl * v.lvl, gr = v.gr * v.lvl, inc0 = v.f / sr;
      let pa = ph[0], vp = ph[10], fp = q[13], wander = q[12], sc = v.lv[0], ce = v.lv[1], r = v.rng | 0, g = v.glide;
      let bs1 = v.fs[0], bs2 = v.fs[1], fs1 = v.fs[2], fs2 = v.fs[3], cs1 = v.fs[4], cs2 = v.fs[5];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from, t = v.t;
      for (; i < n; i++) {
        if (g !== 1) { g += (1 - g) * glC; if (g > 0.99995 && g < 1.00005) g = 1; }
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        const nz = r * NZ;
        // the pitch: the scoop, the vibrato (late), the lungs
        sc *= scoopD;
        // (one exponential a sample at most, and none at all while the bend is small: 1 + x + x²/2 + x³/6 is good to a millionth of an octave at x = 0.05)
        let ex = -scoop * sc;
        if (jit > 0) { wander += (nz * jit * 0.5 - wander) * 0.0006; ex += wander; }
        if (vibD > 0) { vp += vibI; if (vp >= 1) vp -= 1; const on = t * sr > vibDelay ? Math.min(1, (t * sr - vibDelay) / (0.3 * sr)) : 0; ex += vibD * on * sinAt(vp) * 0.5; }
        const mod = g * (ex > -0.08 && ex < 0.08 ? 1 + ex * (1 + ex * (0.5 + ex * 0.16666667)) : Math.exp(ex));
        pa += inc0 * mod; if (pa >= 1) pa -= 1;
        // the tube
        let y = 0;
        for (let h = 1; h <= BR_H; h++) { const a = q[h - 1]; if (a !== 0) { const p = pa * h; y += sinAt(p - Math.floor(p)) * a; } }
        if (edge > 0) { const dt = inc0 * mod; y += edge * (2 * pa - 1 - blep(pa, dt)) * 0.35; }      // (a band-limited saw: a naive one folds its upper harmonics back into the hiss)
        if (drv > 0) y = sat(y * drv) / (0.7 + 0.3 * drv);
        // the breath
        let v3 = nz - bs2, v1 = b1 * bs1 + b2 * v3, v2 = bs2 + b2 * bs1 + b3 * v3; bs1 = 2 * v1 - bs1; bs2 = 2 * v2 - bs2;
        y += v1 * bk * air;
        // the cavity
        if (formant > 0) { v3 = y - fs2; v1 = f1 * fs1 + f2 * v3; v2 = fs2 + f2 * fs1 + f3 * v3; fs1 = 2 * v1 - fs1; fs2 = 2 * v2 - fs2; y += v1 * formant * 0.8; }
        // the chiff
        if (chf > 0 && ce > 1e-4) {
          v3 = nz - cs2; v1 = h1 * cs1 + h2 * v3; v2 = cs2 + h2 * cs1 + h3 * v3; cs1 = 2 * v1 - cs1; cs2 = 2 * v2 - cs2;
          y += v1 * chf * ce; ce *= chfD;
        }
        if (flut > 0) { fp += 5.3 / sr; if (fp >= 1) fp -= 1; y *= 1 - flut * 0.2 * (0.5 + 0.5 * sinAt(fp)); }
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const k = e * kf; kf *= kd; t += 1 / sr;
        L[i] += y * k * gl; R[i] += y * k * gr;
      }
      ph[0] = pa; ph[10] = vp; q[13] = fp; q[12] = wander; v.lv[0] = sc; v.lv[1] = ce; v.rng = r; v.glide = g; v.t = t;
      v.fs[0] = bs1; v.fs[1] = bs2; v.fs[2] = fs1; v.fs[3] = fs2; v.fs[4] = cs1; v.fs[5] = cs2;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.BREATH, initBreath, rBreath);
  
    /* ═════════════════════════════════════════════════════════════════════════
       FOLD — a sine, folded on itself, through a low-pass gate
       ─────────────────────────────────────────────────────────────────────────
       A sine bent by another, then wrapped round and round by a wavefolder: harmonics
       that have nothing to do with a filter's, and that move with how hard it is driven.
       The low-pass gate is the voice's own amplifier and its own filter in one, and, like
       the vactrol it imitates, it closes slowly and never quite as it was opened.
       IN
         2 ratio    carrier to note        3 modR  modulator to carrier     4 index   the modulation, in cycles
         5 fold     the folder's gain 0…10   6 asym   0…1 asymmetry (even harmonics)
         7 lpg      seconds the gate rings   8 base   its cutoff when shut, × note   9 amt   how far it opens, × note
        10 mode     0 struck (it closes by itself) · 1 gated (open while the note lasts)
        11 atk      seconds    12 rel   seconds    13 sub   level of the octave under   14 zap   noise at the strike
        15 second   a second oscillator's ratio (0 = none)   16 lvl2  its level   17 idxDec  seconds the index falls in
        18 drive    0…1
       ROW  P1 accent · P2 variation
       ═════════════════════════════════════════════════════════════════════════ */
    function initFold(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, I = c.inst, b = slotOf(c, src, o), P = v.p, q = v.q;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.FOLD;
      const accent = clamp(src[o + EV.P1], 0, 1), vary = clamp(src[o + EV.P2], 0, 1), f = v.f, vel = v.vel;
      const bright = clamp(S[pb + PA.BRIGHT], 0, 1);
      const mode = I[b + 10] | 0;
      v.inc[0] = (f * I[b + 2]) / sr; v.inc[1] = (f * I[b + 2] * I[b + 3]) / sr; v.inc[2] = I[b + 15] > 0 ? (f * I[b + 15]) / sr : 0;
      v.ph[0] = frac(vary * 0.3); v.ph[1] = 0; v.ph[2] = 0.25; v.ph[3] = 0.25;
      P[0] = I[b + 4] * (0.4 + 0.9 * bright + 0.3 * accent);            // index
      P[1] = Math.exp(-1 / (Math.max(0.02, I[b + 17]) * sr));
      // how deep it folds, kept to what the note can bear: the folder's bandwidth is about the modulator's sidebands times the fold's own (π/2 a unit),
      // and what goes over the Nyquist comes back as a wall of noise
      const room = (0.42 * sr) / (f * Math.max(1, I[b + 3]) * (1 + P[0])), foldCap = Math.max(0.5, (room - 1) / 1.5708);
      P[2] = Math.min(foldCap, clamp(I[b + 5] * (0.4 + 1.2 * bright + 0.3 * vel) * (0.6 + 0.8 * (0.5 + S[pb + PA.WAVE] / 26)), 0.2, 14));
      P[3] = I[b + 6];
      P[4] = Math.exp(-1 / (Math.max(0.01, I[b + 7] * (0.5 + 0.5 * S[pb + PA.HDECAY])) * sr));
      P[5] = I[b + 8]; P[6] = I[b + 9] * (0.6 + 0.6 * accent);
      P[7] = mode; P[8] = I[b + 13] + S[pb + PA.SUB] * 0.4; P[9] = I[b + 14] * (0.5 + accent); P[10] = I[b + 16]; P[11] = I[b + 18] > 0 ? 1 + 3 * I[b + 18] : 0;
      P[12] = Math.exp(-1 / (0.004 * sr));
      q[0] = 1;        // the gate's vactrol
      q[1] = 0;        // the index's envelope
      q[2] = 1;        // the strike noise's
      q[3] = 0;        // the low-pass state
      v.glideC = coefOf(0.03, sr);
      envStart(v, sr, Math.max(0.002, I[b + 11]), 0.1, 1, Math.max(0.01, I[b + 12] / 3), vel * (0.6 + 0.4 * accent) * I[b + 1]);
      if (mode === 0) { v.stage = 2; v.gate = -1; v.env = v.peak; }       // struck: the gate is the envelope
      v.sub = 0;
    }
  
    function rFold(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, q = v.q, inc = v.inc, ph = v.ph, kd = v.kd;
      const idx0 = P[0], idxD = P[1], fold = P[2], asym = P[3], lpgD = P[4], base = P[5], amt = P[6], mode = P[7] | 0, subL = P[8], zap = P[9], lvl2 = P[10], drv = P[11], zapD = P[12];
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak, glC = v.glideC;
      const gl = v.gl * v.lvl, gr = v.gr * v.lvl, f = v.f;
      let vac = q[0], ix = q[1], ze = q[2], lp = q[3], r = v.rng | 0, g = v.glide, psub = ph[3];
      let dx1 = q[4], dy1 = q[5], dcI = v.age === 0 && from === v.off;
      let p0 = ph[0], p1 = ph[1], p2 = ph[2];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      if (v.age === 0 && ix === 0) ix = 1;
      let cutA = 0;
      for (; i < n;) {
        const m = Math.min(n - i, 16);
        // the gate's cutoff, once a sub-block: a one-pole low-pass, aimed
        const fc = clamp(f * (base + amt * vac), 30, sr * 0.45);
        cutA = 1 - Math.exp((-TAU * fc) / sr);
        const end = i + m;
        for (; i < end; i++) {
          if (g !== 1) { g += (1 - g) * glC; if (g > 0.99995 && g < 1.00005) g = 1; }
          ix *= idxD;
          p1 += inc[1] * g; if (p1 >= 1) p1 -= 1;
          p0 += inc[0] * g; if (p0 >= 1) p0 -= 1;
          const ph0 = p0 + idx0 * ix * sinAt(p1);
          let x = sinAt(ph0 - Math.floor(ph0));
          if (inc[2] > 0) { p2 += inc[2] * g; if (p2 >= 1) p2 -= 1; x = x * (1 - 0.4 * lvl2) + sinAt(p2) * lvl2; }
          // the folder
          const xa = x + asym * 0.45;
          x = sinAt(frac(0.25 * fold * xa)) - (asym > 0 ? sinAt(frac(0.25 * fold * asym * 0.45)) : 0);
          if (drv > 0) x = sat(x * drv) / (0.7 + 0.3 * drv);
          if (zap > 0 && ze > 1e-4) { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; x += r * NZ * zap * ze * 0.6; ze *= zapD; }
          if (subL > 0.001) { psub += inc[0] * g * 0.5; if (psub >= 1) psub -= 1; x += sinAt(psub) * subL; }
          // a folder that is not symmetric has a DC in it, and the gate would make it a thump: taken out (a 20 Hz high-pass, begun at the first sample's value)
          if (dcI) { dx1 = x; dy1 = 0; dcI = false; }
          dy1 = x - dx1 + 0.9972 * dy1; dx1 = x; x = dy1;
          // the gate: a low-pass and an amplifier, moved together
          lp += cutA * (x - lp);
          const y = lp * (mode === 0 ? vac : 0.15 + 0.85 * vac);      // (a struck gate closes all the way: it must not end on a step)
          // the vactrol, and the note's own envelope
          if (mode === 0) { vac *= lpgD; if (vac < 1e-4) { st = 0; break; } }
          else {
            vac += ((st === 3 ? 0 : 1) - vac) * (st === 3 ? 0.0008 : 0.004);
            if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
            else if (st === 2) e += dC * (su - e);
            else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
            if (gate > 0 && --gate === 0) st = 3;
          }
          const k = (mode === 0 ? pk : e) * kf; kf *= kd;
          L[i] += y * k * gl; R[i] += y * k * gr;
        }
        if (st === 0) break;
      }
      q[0] = vac; q[1] = ix; q[2] = ze; q[3] = lp; q[4] = dx1; q[5] = dy1; ph[0] = p0; ph[1] = p1; ph[2] = p2; ph[3] = psub; v.glide = g; v.rng = r;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.FOLD, initFold, rFold);
  
    /* ═════════════════════════════════════════════════════════════════════════
       CLOUD — grains
       ─────────────────────────────────────────────────────────────────────────
       A note is not one sound but a hundred small ones a second, each a windowed slice of a
       sine, a triangle, the sigil's own cube cell or a bell, scattered round the note's pitch
       and across the stereo field, some an octave or a fifth above. Slow and dense, it is a
       pad that shimmers; fast and sparse, rain.
       IN
         2 src     0 sine · 1 triangle · 2 the cube cell · 3 bell      3 rate   grains a second (per voice)
         4 len     grain length, seconds      5 jitter  cents of scatter       6 oct   probability of an octave up
         7 fifth   probability of a fifth up   8 spread  0…1 stereo            9 atk    seconds    10 rel  seconds
        11 wander  0…1 how much the rate and level drift          12 rnd   0…1 level scatter        13 soft   0…1 darkens the grains
       ROW  P1 accent · P2 variation
       ═════════════════════════════════════════════════════════════════════════ */
    const GRAINS = 24, GS = 8;
    const M_SIZE = Math.max(MAXM * MS, GRAINS * GS);     // (the voice's block of numbers for a mode bank or for grains)
  
    function initCloud(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, I = c.inst, b = slotOf(c, src, o), P = v.p, q = v.q;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.CLOUD;
      const accent = clamp(src[o + EV.P1], 0, 1), vary = clamp(src[o + EV.P2], 0, 1), f = v.f, vel = v.vel;
      const bright = clamp(S[pb + PA.BRIGHT], 0, 1);
      if (!v.m || v.m.length < M_SIZE) v.m = new Float64Array(M_SIZE);
      v.m.fill(0);
      const srcK = I[b + 2] | 0;
      if (srcK === 2) { c.pickCells(pb, 0, false); v.tab = c.c0; v.o0 = c.tier(f * 2); }
      P[0] = srcK;
      const rate = I[b + 3] * (0.6 + 0.8 * clamp(S[pb + PA.SWEEP] + 0.3, 0.3, 1.5));
      P[1] = rate / sr; P[2] = Math.max(0.004, I[b + 4]) * sr;
      P[3] = (I[b + 5] * (0.5 + S[pb + PA.DRIFT])) / 1200 * Math.LN2;
      P[4] = I[b + 6]; P[5] = I[b + 7]; P[6] = I[b + 8] * (0.6 + 0.8 * S[pb + PA.CHORUS] / 0.3);
      P[7] = I[b + 11]; P[8] = I[b + 12];
      P[9] = clamp(0.5 + 1.2 * bright - I[b + 13] * 0.7, 0.15, 1.6);    // brightness of the grains: their upper partial's level
      const overlap = Math.max(1, rate * Math.max(0.004, I[b + 4]));
      P[10] = 1 / Math.sqrt(overlap) * 1.4;
      q[0] = 0; q[1] = 1; q[2] = 0;         // the rate accumulator, the drift's level, its phase
      q[3] = 0;                             // how many grains are sounding
      envStart(v, sr, Math.max(0.01, I[b + 9]), 0.3, 1, Math.max(0.01, I[b + 10] / 3), vel * (0.6 + 0.4 * accent) * I[b + 1]);
    }
  
    function rCloud(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, q = v.q, m = v.m, kd = v.kd, srcK = P[0] | 0;
      const rateI = P[1], len = P[2], jit = P[3], pOct = P[4], pFifth = P[5], spread = P[6], wander = P[7], rnd = P[8], bri = P[9], nrm = P[10];
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak;
      const gl = v.gl * v.lvl, gr = v.gr * v.lvl, f = v.f;
      const t = v.tab, o0 = v.o0;
      let acc = q[0], lv = q[1], wp = q[2], r = v.rng | 0, nAct = q[3] | 0;        // the grains in use are listed in q[24…]
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      for (; i < n; i++) {
        if (wander > 0) { wp += 0.3 / sr; if (wp >= 1) wp -= 1; lv = 1 + wander * 0.4 * sinAt(wp) + wander * 0.2 * sinAt(frac(wp * 2.71)); }
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        acc += rateI * lv * (0.5 + (r * NZ + 1) * 0.5);
        if (acc >= 1 && nAct < GRAINS) {
          acc -= 1;
          // a grain: the first free slot
          for (let gk = 0; gk < GRAINS; gk++) {
            const o8 = gk * GS;
            if (m[o8 + 2] > 0) continue;
            r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const u1 = r * NZ;
            r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const u2 = r * NZ;
            r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const u3 = (r * NZ + 1) * 0.5;
            r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const u4 = (r * NZ + 1) * 0.5;
            let ratio = Math.exp(u1 * jit);
            if (u3 < pOct) ratio *= 2; else if (u3 < pOct + pFifth) ratio *= 1.5;
            const pn = clamp(u2 * spread, -1, 1), pa = ((pn + 1) * Math.PI) / 4;
            m[o8] = 0;                                   // phase
            m[o8 + 1] = (f * ratio) / sr;                // increment
            m[o8 + 2] = len * (0.7 + 0.6 * u4);          // length in samples (> 0: the slot is in use)
            m[o8 + 3] = 0;                               // age
            m[o8 + 7] = 1 / m[o8 + 2];                   // one over its length
            m[o8 + 4] = (1 - rnd * 0.6 * u4) * nrm;      // level
            m[o8 + 5] = Math.cos(pa) * SQ2; m[o8 + 6] = Math.sin(pa) * SQ2;
            q[24 + nAct++] = gk;
            break;
          }
        } else if (acc >= 1) acc = 1;
        let yl = 0, yr = 0;
        for (let ai = 0; ai < nAct; ai++) {
          const o8 = q[24 + ai] * GS, age = m[o8 + 3], u = age * m[o8 + 7];            // (m[o8+7] is one over the grain's length: no division in the loop)
          if (u >= 1) { m[o8 + 2] = 0; q[24 + ai] = q[24 + --nAct]; ai--; continue; }
          const w = u * (1 - u) * 4, win = w * w;                                      // a smooth window: zero at both ends, round on top
          let p = m[o8] + m[o8 + 1]; if (p >= 1) p -= 1; m[o8] = p;
          let x;
          if (srcK === 0) x = sinAt(p) + bri * 0.25 * sinAt(p + p - (p >= 0.5 ? 1 : 0));
          else if (srcK === 1) x = 4 * Math.abs(p - 0.5) - 1;
          else if (srcK === 2) x = tabAt(t, o0, p) * 0.8;
          else x = sinAt(p) * 0.8 + sinAt(frac(p * 2.76)) * 0.22 * bri + sinAt(frac(p * 5.4)) * 0.08 * bri;
          x *= win * m[o8 + 4];
          yl += x * m[o8 + 5]; yr += x * m[o8 + 6];
          m[o8 + 3] = age + 1;
        }
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const k = e * kf; kf *= kd;
        L[i] += yl * k * gl; R[i] += yr * k * gr;
      }
      q[0] = acc; q[1] = lv; q[2] = wp; q[3] = nAct; v.rng = r;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.CLOUD, initCloud, rCloud);
  
    G.SigilVoices = Object.freeze({ version: 1 });
  })(typeof globalThis !== 'undefined' ? globalThis : self);
  