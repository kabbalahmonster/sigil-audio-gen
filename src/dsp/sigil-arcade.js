/* ══════════════════════════════════════════════════════════════════════════
   sigil-arcade.js — the arcade engine's four channels
   --------------------------------------------------------------------------
   A second sound engine beside the cube: a four-channel machine of the kind
   that sang in arcades and on consoles. Every part of a song is given to one
   of four channels, each its own kind of chip voice:

     ARC_FM     the lead. Two operators (OPN/OPL style): a modulator with
                feedback bending a carrier, an index envelope, a little
                vibrato that arrives late. Lead, second voice, choir, bells.
     ARC_PULSE  the bass. A band-limited pulse (polyBLEP) with a width that
                breathes, through a driven low-pass. Bass and drone.
     ARC_NOISE  the percussion. A 15-bit LFSR clocked at a "pitch" (long or
                short, metallic, mode), a 4-bit stepped volume, and a swept
                triangle body for kicks and toms. Every stroke of the kit.
     ARC_ARP    the chords. One pulse voice that steps through the notes of a
                chord at a tempo-synced rate: the chip arpeggio, which is how
                a chord was played by a machine with one voice for it.

   The compiler (06b, from 05l's arrangement) writes every number a note
   needs into its row, so these engines read nothing but the row and the
   section row (BRIGHT, which the movers animate, and DRUMS, the kit's level).
   They are registered as "own" engines: they need no instrument table.

   DETERMINISM. All noise is an integer LFSR / xorshift seeded from the row's
   SEED. No allocation, no transcendental call per sample.
   ══════════════════════════════════════════════════════════════════════════ */
   (function (G) {
    'use strict';
    const D = G.SigilDSP;
    if (!D || !D.kit || !D.KIND.ARC_FM) return;
    const { sinAt, svfSet, decayOf, coefOf, envStart, common, sat, clamp, TAU, PA, EV, KIND, BUS } = D.kit;
    const LN2 = Math.LN2;
    const frac = (x) => x - Math.floor(x);
    const blep = (t, dt) => (t < dt ? ((t /= dt), t + t - t * t - 1) : t > 1 - dt ? ((t = (t - 1) / dt), t * t + t + t + 1) : 0);
    /** The core's slots for the voice-stealing order (sigil-dsp.js SLOT_*): who goes first when there are too many. */
    const SLOT_BELL = 3, SLOT_ARP = 5, SLOT_PAD = 6, SLOT_DRONE = 7, SLOT_TOM = 9;
    const register = (kind, init, render) => D.registerVoice(kind, init, render, true);

    /* ═════════════════════════════════════════════════════════════════════════
       ARC_FM — two operators
       ROW  F Hz · F0 glide-from Hz · P0 ratio (modulator : carrier) · P1 index (cycles of phase, at the peak)
            P2 index decay (s, toward 45 % of it) · P3 amplitude decay (s) · P4 sustain 0…1 · P5 feedback 0…1
            AUX vibrato (cents)
       SECTION BRIGHT opens the index and the carrier's low-pass (the movers animate it)
       ═════════════════════════════════════════════════════════════════════════ */
    function initFm(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, P = v.p;
      const dur = common(c, v, src, o, el);
      v.kind = KIND.ARC_FM; v.slot = v.bus === BUS.bell ? SLOT_BELL : -1;
      const f = v.f, ratio = clamp(src[o + EV.P0] || 1, 0.25, 12), bright = clamp(S[pb + PA.BRIGHT], 0, 1);
      // Carson's rule keeps the modulator's sidebands under the Nyquist, so a high note of a bright patch does not fold back
      const cap = Math.max(0.02, (0.4 * sr / (2 * f * Math.max(1, ratio)) - 1) / TAU);
      P[0] = Math.min(clamp(src[o + EV.P1], 0, 2) * (0.35 + 1.3 * bright), cap);
      P[1] = 0.45;                                                  // where the index settles
      P[2] = clamp(src[o + EV.P5], 0, 1) * 0.3;                     // feedback, in cycles
      v.inc[0] = f / sr; v.inc[1] = (f * ratio) / sr;
      v.ph[0] = 0; v.ph[1] = 0.25;
      v.dk[0] = decayOf(Math.max(0.01, src[o + EV.P2] || 0.2), sr);
      v.lv[0] = 1;                                                  // the index envelope
      v.lv[1] = 0; v.lv[2] = 0;                                     // feedback memory
      v.lv[3] = 0;                                                  // the low-pass's state
      const fc = Math.min(sr * 0.45, f * (2.5 + 18 * bright * bright) + 400);
      P[3] = 1 - Math.exp((-TAU * fc) / sr);
      const cents = Math.max(0, src[o + EV.AUX] || 0);
      P[4] = cents > 0 && dur > 0.25 ? (cents / 1200) * LN2 : 0;
      P[5] = 5.6 / sr;                                              // the vibrato's rate
      P[6] = 1 / (0.22 * sr);                                       // how soon it arrives
      v.lv[4] = 0; v.ph[2] = 0;
      P[7] = 1 - (TAU * 12) / sr; v.lv[5] = 0; v.lv[6] = 0;          // a DC blocker: a modulator at the carrier's own ratio leaves an offset
      const dec = src[o + EV.P3] > 0 ? src[o + EV.P3] : 0.4, sus = clamp(src[o + EV.P4], 0, 1);
      envStart(v, sr, 0.004, dec, sus, 0.03, v.vel * 0.075);
      v.glideC = coefOf(0.035, sr);
    }
    function rFm(c, v, L, R, from, n) {
      const P = v.p, idx = P[0], iSus = P[1], fb = P[2], la = P[3], vibD = P[4], vibI = P[5], vibA = P[6], hp = P[7];
      const ic = v.inc[0], im = v.inc[1], ed = v.dk[0], glC = v.glideC, kd = v.kd;
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak;
      const gl = v.gl * v.lvl, gr = v.gr * v.lvl;
      let pc = v.ph[0], pm = v.ph[1], vp = v.ph[2], ex = v.lv[0], fbA = v.lv[1], fbP = v.lv[2], lp = v.lv[3], von = v.lv[4], hx = v.lv[5], hy = v.lv[6];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, g = v.glide, i = from;
      for (; i < n; i++) {
        if (g !== 1) { g += (1 - g) * glC; if (g > 0.99995 && g < 1.00005) g = 1; }
        let mod = g;
        if (vibD > 0) { if (von < 1) von += vibA; vp += vibI; if (vp >= 1) vp -= 1; mod *= 1 + vibD * von * sinAt(vp); }
        pc += ic * mod; if (pc >= 1) pc -= 1;
        pm += im * mod; if (pm >= 1) pm -= 1;
        ex *= ed;
        const mp = pm + fb * fbA, m = sinAt(mp - Math.floor(mp));
        fbA = 0.5 * (m + fbP); fbP = m;
        const cp = pc + idx * (iSus + (1 - iSus) * ex) * m, y = sinAt(cp - Math.floor(cp));
        lp += (y - lp) * la;
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const k = e * kf; kf *= kd;
        const z = lp * k; hy = z - hx + hp * hy; hx = z;
        L[i] += hy * gl; R[i] += hy * gr;
      }
      v.ph[0] = pc; v.ph[1] = pm; v.ph[2] = vp; v.lv[0] = ex; v.lv[1] = fbA; v.lv[2] = fbP; v.lv[3] = lp; v.lv[4] = von; v.lv[5] = hx; v.lv[6] = hy;
      v.glide = g; v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.ARC_FM, initFm, rFm);

    /* ═════════════════════════════════════════════════════════════════════════
       ARC_PULSE — the pulse bass
       ROW  F Hz · F0 glide-from Hz · P0 width 0.05…0.5 · P1 drive 0…1 · P2 decay (s) · P3 sustain 0…1
            P4 width modulation 0…0.2 · P5 release (s) · AUX 1 = held (restarted after a seek)
       ═════════════════════════════════════════════════════════════════════════ */
    function initPulse(c, v, src, o, pb, el) {
      const sr = c.sr, P = v.p;
      common(c, v, src, o, el);
      v.kind = KIND.ARC_PULSE; v.slot = v.bus === BUS.drone ? SLOT_DRONE : -1;
      const f = v.f, drive = clamp(src[o + EV.P1], 0, 1);
      v.inc[0] = f / sr; v.ph[0] = 0; v.ph[1] = 0;
      P[0] = clamp(src[o + EV.P0] || 0.25, 0.05, 0.5);
      P[1] = clamp(src[o + EV.P4], 0, 0.2);
      P[2] = 0.7 / sr;                                              // the width's slow breath
      P[3] = 0.6 + 4.4 * drive;                                     // into the saturator
      P[4] = 1 / sat(P[3]);
      P[5] = f * (4 + 26 * drive) + 180;                            // the low-pass, where it rests
      P[6] = 1;                                                     // its envelope
      P[7] = decayOf(0.09, sr);
      P[8] = drive > 0.55 ? Math.pow(2, Math.round(9 - 10 * (drive - 0.55))) : 0;   // the top of the drive is a crusher: 9 bits down to 5
      v.fs[0] = 0; v.fs[1] = 0; v.fs[2] = 0; v.fs[3] = 0;
      P[9] = 1 - (TAU * 12) / sr;                                   // a DC blocker: a narrow pulse, driven, is not centred
      const dec = src[o + EV.P2] > 0 ? src[o + EV.P2] : 0.3, sus = clamp(src[o + EV.P3], 0, 1);
      envStart(v, sr, 0.002, dec, sus, Math.max(0.005, (src[o + EV.P5] || 0.04) / 3), v.vel * 0.17);
      v.glideC = coefOf(0.04, sr);
    }
    function rPulse(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, cf = v.cf, inc = v.inc[0], pw0 = P[0], pwD = P[1], pwR = P[2], pre = P[3], nrm = P[4], cut = P[5], fD = P[7], lev = P[8], hp = P[9];
      const glC = v.glideC, kd = v.kd, aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak;
      const gl = v.gl * v.lvl, gr = v.gr * v.lvl;
      let p = v.ph[0], lfo = v.ph[1], fe = P[6], s1 = v.fs[0], s2 = v.fs[1], hx = v.fs[2], hy = v.fs[3];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, g = v.glide, i = from;
      while (i < n) {
        const m = Math.min(n - i, 32);
        svfSet(cf, 0, sr, Math.min(sr * 0.42, cut * (1 + 1.6 * fe) * g), 0.75);
        const A1 = cf[0], A2 = cf[1], A3 = cf[2];
        fe *= Math.pow(fD, m);
        const pw = clamp(pw0 + pwD * sinAt(lfo), 0.04, 0.5);
        lfo += pwR * m; if (lfo >= 1) lfo -= Math.floor(lfo);
        const end = i + m;
        for (; i < end; i++) {
          if (g !== 1) { g += (1 - g) * glC; if (g > 0.99995 && g < 1.00005) g = 1; }
          const dt = inc * g;
          p += dt; if (p >= 1) p -= 1;
          const pp = p - pw;
          const x = (p < pw ? 1 : -1) + blep(p, dt) - blep(pp < 0 ? pp + 1 : pp, dt) - (2 * pw - 1);
          const v3 = x - s2, v1 = A1 * s1 + A2 * v3, v2 = s2 + A2 * s1 + A3 * v3;
          s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
          let y = sat(v2 * pre) * nrm;
          if (lev > 0) y = Math.round(y * lev) / lev;
          if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
          else if (st === 2) e += dC * (su - e);
          else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
          if (gate > 0 && --gate === 0) st = 3;
          const k = e * kf; kf *= kd;
          const z = y * k; hy = z - hx + hp * hy; hx = z;
          L[i] += hy * gl; R[i] += hy * gr;
        }
        if (st === 0) break;
      }
      v.ph[0] = p; v.ph[1] = lfo; P[6] = fe; v.fs[0] = s1; v.fs[1] = s2; v.fs[2] = hx; v.fs[3] = hy;
      v.glide = g; v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.ARC_PULSE, initPulse, rPulse);

    /* ═════════════════════════════════════════════════════════════════════════
       ARC_NOISE — the noise channel, and a triangle under it
       ROW  F LFSR clock Hz (the noise's pitch) · F0 attack (s; 0 = struck) · P0 mode (0 long · 1 short, metallic)
            P1 the noise's decay (s) · P2 where its clock is swept to (× F; 0 = not swept)
            P3 the body's level · P4 the body's Hz at the stroke · P5 its Hz after · AUX the body's decay (s)
       The noise's volume is stepped in sixteenths, as a chip's four-bit volume is.
       ═════════════════════════════════════════════════════════════════════════ */
    function initNoise(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, P = v.p;
      common(c, v, src, o, el);
      v.kind = KIND.ARC_NOISE; v.slot = SLOT_TOM; v.stage = 2; v.glide = 1;
      v.lvl = v.bus === BUS.drums ? S[pb + PA.DRUMS] : 1;
      const clk = clamp(src[o + EV.F], 40, sr * 0.98);
      v.mode = src[o + EV.P0] | 0;
      P[0] = clk / sr;
      const to = src[o + EV.P2] > 0 ? clamp(src[o + EV.P2] * clk, 40, sr * 0.98) / sr : P[0];
      P[1] = to; P[2] = coefOf(Math.max(0.004, (src[o + EV.P1] || 0.1) * 0.6), sr);
      v.dk[0] = decayOf(Math.max(0.002, src[o + EV.P1] || 0.1), sr);
      const atk = src[o + EV.F0];
      P[3] = atk > 0 ? 1 / Math.max(1, atk * sr) : 0;
      v.lv[0] = atk > 0 ? 0 : 1;                                   // the noise's envelope
      v.lv[1] = 0;                                                  // the attack's ramp
      v.lv[2] = clamp(src[o + EV.P3], 0, 2);                        // the body
      const b0 = Math.max(20, src[o + EV.P4] || 100), b1 = Math.max(20, src[o + EV.P5] || b0);
      v.inc[0] = b0 / sr; v.inc[1] = b1 / sr; P[4] = coefOf(Math.max(0.004, (src[o + EV.AUX] || 0.1) * 0.35), sr);
      v.dk[1] = decayOf(Math.max(0.002, src[o + EV.AUX] || 0.1), sr);
      v.lv[3] = v.lv[2] > 0 ? 1 : 0;                                // the body's envelope
      v.ph[0] = 0; v.ph[1] = 0.25;
      v.n = ((v.rng >>> 3) & 0x7fff) | 1;                           // the shift register
      v.env = v.vel * 1.05;
    }
    function rNoise(c, v, L, R, from, n) {
      const P = v.p, cT = P[1], cC = P[2], aI = P[3], bC = P[4], tap = v.mode === 1 ? 6 : 1;
      const nd = v.dk[0], bd = v.dk[1], bT = v.inc[1], bl = v.lv[2], kd = v.kd;
      const amp = v.env, gl = v.gl * v.lvl * amp, gr = v.gr * v.lvl * amp;
      let ci = P[0], acc = v.ph[0], bp = v.ph[1], bi = v.inc[0], ne = v.lv[0], ar = v.lv[1], be = v.lv[3], reg = v.n | 0, kf = v.kf, i = from;
      let out = reg & 1 ? 1 : -1;
      for (; i < n; i++) {
        ci += (cT - ci) * cC;
        acc += ci;
        if (acc >= 1) {
          acc -= 1;
          const bit = (reg ^ (reg >> tap)) & 1;
          reg = (reg >> 1) | (bit << 14);
          out = reg & 1 ? 1 : -1;
        }
        if (aI > 0 && ar < 1) { ar += aI; if (ar > 1) ar = 1; ne = ar; }
        else ne *= nd;
        const nq = Math.floor(ne * 15 + 0.5) * 0.0666667;
        let y = out * nq;
        if (bl > 0) {
          bi += (bT - bi) * bC;
          bp += bi; if (bp >= 1) bp -= 1;
          y += (4 * Math.abs(bp - 0.5) - 1) * be * bl;
          be *= bd;
        }
        y *= kf; kf *= kd;
        L[i] += y * gl; R[i] += y * gr;
      }
      P[0] = ci; v.ph[0] = acc; v.ph[1] = bp; v.inc[0] = bi; v.lv[0] = ne; v.lv[1] = ar; v.lv[3] = be; v.n = reg; v.kf = kf; v.age += i - from;
      if ((ne < 0.033 && (aI === 0 || ar >= 1) && be < 1e-4) || kf < 1e-3) v.active = false;
    }
    register(KIND.ARC_NOISE, initNoise, rNoise);

    /* ═════════════════════════════════════════════════════════════════════════
       ARC_ARP — a chord, one note at a time
       ROW  F, P0, P1, P2 the chord's notes in Hz (0 = none) · P3 steps per beat · P4 the pulse's width
            P5 the pattern (0 up · 1 up and down · 2 one note, not stepped) · F0 decay (s; 0 = held at full)
            AUX 1 = held (restarted after a seek)
       The steps are counted from the note's own start, in beats, so a chord steps in time at any tempo.
       ═════════════════════════════════════════════════════════════════════════ */
    function initArp(c, v, src, o, pb, el) {
      const sr = c.sr, P = v.p;
      const dec = src[o + EV.F0];
      common(c, v, src, o, el);
      v.kind = KIND.ARC_ARP; v.slot = v.bus === BUS.pad ? SLOT_PAD : SLOT_ARP; v.glide = 1;
      let nn = 0;
      const fs = [src[o + EV.F], src[o + EV.P0], src[o + EV.P1], src[o + EV.P2]];
      for (let j = 0; j < 4; j++) if (fs[j] > 0) v.inc[nn++] = Math.min(fs[j], sr * 0.2) / sr;
      if (!nn) v.inc[nn++] = v.f / sr;
      const pat = src[o + EV.P5] | 0;
      // the order of the steps, as indices into the chord: up (0 1 2 3), up and down (0 1 2 3 2 1), or the one note
      let len = 0;
      if (pat === 2 || nn === 1) v.q[len++] = 0;
      else {
        for (let j = 0; j < nn; j++) v.q[len++] = j;
        if (pat === 1) for (let j = nn - 2; j > 0; j--) v.q[len++] = j;
      }
      v.n = len;
      const rate = clamp(src[o + EV.P3] || 4, 0.5, 32);
      P[0] = rate;
      P[1] = clamp(src[o + EV.P4] || 0.25, 0.05, 0.5);
      // where in the pattern a note that begins `el` beats in (after a seek) already is
      const stepped = el * rate, k0 = Math.floor(stepped);
      P[2] = k0 % len;                                              // the step
      P[3] = stepped - k0;                                          // how far into it, in steps
      v.lv[0] = 1;                                                  // the step's own accent
      v.lv[1] = 0;                                                  // the low-pass's state
      v.ph[0] = 0;
      const top = v.inc[0] * sr;
      P[4] = 1 - Math.exp((-TAU * Math.min(sr * 0.42, top * 10 + 1800)) / sr);
      envStart(v, sr, 0.003, dec > 0 ? dec : 0.6, dec > 0 ? 0 : 0.9, 0.012, v.vel * 0.22);
    }
    function rArp(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, q = v.q, len = v.n, inc = v.inc, pw = P[1], la = P[4], kd = v.kd;
      const perS = P[0] * c.bps / sr;                               // steps per sample, at the tempo now
      const aC = 1 - Math.exp(-1 / Math.max(1, (0.35 / Math.max(perS, 1e-9)))), floorA = 0.62;
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak;
      const gl = v.gl * v.lvl, gr = v.gr * v.lvl;
      let step = P[2] | 0, into = P[3], acc = v.lv[0], lp = v.lv[1], p = v.ph[0];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      let dt = inc[q[step] | 0];
      for (; i < n; i++) {
        into += perS;
        if (into >= 1) { into -= 1; step++; if (step >= len) step = 0; dt = inc[q[step] | 0]; acc = 1; }
        acc += (floorA - acc) * aC;
        p += dt; if (p >= 1) p -= 1;
        const pp = p - pw;
        const x = (p < pw ? 1 : -1) + blep(p, dt) - blep(pp < 0 ? pp + 1 : pp, dt) - (2 * pw - 1);
        lp += (x - lp) * la;
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const k = e * kf * acc; kf *= kd;
        L[i] += lp * k * gl; R[i] += lp * k * gr;
      }
      P[2] = step; P[3] = into; v.lv[0] = acc; v.lv[1] = lp; v.ph[0] = p;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
    register(KIND.ARC_ARP, initArp, rArp);

    G.SigilArcade = Object.freeze({ version: 1, KINDS: [KIND.ARC_FM, KIND.ARC_PULSE, KIND.ARC_NOISE, KIND.ARC_ARP] });
  })(typeof globalThis !== 'undefined' ? globalThis : self);
