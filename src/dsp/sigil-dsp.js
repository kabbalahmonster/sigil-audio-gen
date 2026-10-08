/* ══════════════════════════════════════════════════════════════════════════
   sigil-dsp.js · SIGIL DSP CORE (Part 1)
   ----------------------------------------------------------------------------
   One file, two hosts:
     • AudioWorklet 'sigil-dsp': the live instrument. Runs on the audio thread,
       so the music never depends on the main thread's timers.
     • (Part 2) a Web Worker running the identical DSP for offline render/stems.

   Signal flow (per 128-frame block)
     voices → 10 buses (gain) → send taps ─┬→ Freeverb-style reverb ─┐
                                           ├→ tempo-synced delay ───┤→ master
                                           └→ dry sum ──────────────┘   banish LP
                                                                        → soft clip

   Scheduling: the score is a flat, beat-sorted event list. Each block converts
   frames to beats via an anchor (beat 0 at frame `anchor`), starts every event
   whose beat falls in the block, and loops the song by advancing `pass`.
   Because time is frames, not timers, events are sample-accurate.

   Voices (all sample-by-sample, no per-note graph nodes)
     wave   wavetable oscillator (morph between two geometry cells), glide, sub
     vox    glottal source through 3 bandpass formants, syllable consonant onset
     pluck  Karplus–Strong string
     chime  FM bell (ratio 3.5), index decays (velocity-to-timbre: harder = brighter)
     perc   kick / snare / hat / crash / shaker / swell / tick (noise and sines)

   Messages (host → core)  {cmd, …}
     cells {cells[16][8], glot[8]}   wavetable mips per geometry cell
     score {events,total,spb}        replace the score, keep the transport
     play  {at, beat}                start at context frame `at`
     stop  {fade}                    fade out, then go silent
     seek  {beat}                    jump, dropping ringing voices
     tempo {spb}                     change tempo, keep the beat position
     region{region|null}             loop a beat range
     param {key,value}               'bus.<name>' | 'master' | 'rev' | 'del'
     kit   {kit}                     drum shaping knobs
     oneshot {kind:'chime'|'tick'}
     banish{sec}                     LP sweep to silence
     noteon {id,midi,vel} / noteoff {id}

   Messages (core → host)
     tick   {beat, f, running}       every 8 blocks (≈ 23 ms)
     meters {peak[10]}               per-bus peaks
     fault  {message}                once, if a block throws
   ══════════════════════════════════════════════════════════════════════════ */
   (function () {
    'use strict';
  
    /* ── Constants ─────────────────────────────────────────────────────────── */
    const WT = 1024, MIPS = 8, NH = 32, BLK = 128, TAU = Math.PI * 2, MAXV = 48;
    /** Bus order. The index is the key for gain, sends and metering. */
    const BN = ['lead', 'harm', 'bell', 'pad', 'bass', 'arp', 'drums', 'drone', 'play', 'tick'];
    const BUS_GAIN = [0.9, 0.55, 0.8, 0.8, 0.85, 0.55, 0.85, 0.7, 0.8, 0.6];
    const SEND_REV = [0.32, 0.45, 0.55, 0.5, 0.04, 0.35, 0.12, 0.45, 0.3, 0.4];
    const SEND_DEL = [0.22, 0.1, 0.28, 0, 0, 0.42, 0, 0, 0, 0];
    /** Formant centres for the vowels a e i o u (Hz). */
    const VOWEL = { a: [800, 1150, 2900], e: [400, 1600, 2700], i: [350, 1700, 2700], o: [450, 800, 2830], u: [325, 700, 2530] };
    const COS = new Float64Array(WT), SIN = new Float64Array(WT);
    for (let i = 0; i < WT; i++) { COS[i] = Math.cos((TAU * i) / WT); SIN[i] = Math.sin((TAU * i) / WT); }
  
    /* ── Small pure helpers ────────────────────────────────────────────────── */
    const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    /** Per-sample decay factor for a time constant `t` seconds. */
    const ex = (t, sr) => Math.exp(-1 / (Math.max(1e-4, t) * sr));
    /** Mip level for a fundamental `f`: the lowest level whose band limit covers it. */
    const mipFor = (f) => clamp(Math.ceil(Math.log2(Math.max(f, 1) / 31.25)), 0, MIPS - 1);
    /** Linear interpolation inside one wavetable period. `ph` is in [0,1). */
    function tab(t, ph) {
      const x = ph * WT, i = x | 0, a = t[i], b = t[(i + 1) & (WT - 1)];
      return a + (b - a) * (x - i);
    }
    /** Deterministic per-voice noise in [-1, 1) (xorshift32). */
    function rnd(v) {
      let x = v.rs;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      v.rs = x;
      return (x >>> 0) / 2147483648 - 1;
    }
    /** Seed from the event's frame and pitch, so repeated renders are identical. */
    const seedOf = (fr, midi) => (Math.imul(fr | 0, 2654435761) ^ ((midi | 0) * 40503)) | 1;
    /** Constant-peak bandpass (RBJ). Coefficients plus its own input/output history. */
    function bpCoef(fc, Q, sr) {
      const w = (TAU * clamp(fc, 20, sr * 0.45)) / sr, al = Math.sin(w) / (2 * Q), a0 = 1 + al, c = Math.cos(w);
      return { b0: al / a0, b2: -al / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    }
    function bq(x, c) {
      const y = c.b0 * x + c.b2 * c.x2 - c.a1 * c.y1 - c.a2 * c.y2;
      c.x2 = c.x1; c.x1 = x; c.y2 = c.y1; c.y1 = y;
      return y;
    }
    /** Soft knee above 0.9, so loud peaks round off instead of clipping hard. */
    function softClip(x) {
      const a = x < 0 ? -x : x;
      if (a <= 0.9) return x;
      const y = 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1);
      return x < 0 ? -y : y;
    }
  
    /**
     * Band-limited wavetable mips from a harmonic spectrum (re/im per harmonic).
     * Mip m serves fundamentals up to 31.25·2^m Hz, so only harmonics below
     * Nyquist are kept. Shared by the live core, the host and the Part 2 worker.
     */
    function buildMips(re, im, sr) {
      const mips = [];
      for (let m = 0; m < MIPS; m++) {
        const top = 31.25 * Math.pow(2, m);
        const cut = clamp(Math.floor((0.9 * sr) / (2 * top)), 1, NH - 1);
        const t = new Float32Array(WT);
        for (let h = 1; h <= cut; h++) {
          const a = re[h] || 0, b = im[h] || 0;
          if (a === 0 && b === 0) continue;
          for (let i = 0; i < WT; i++) { const k = (h * i) & (WT - 1); t[i] += a * COS[k] - b * SIN[k]; }
        }
        let pk = 0;
        for (let i = 0; i < WT; i++) pk = Math.max(pk, Math.abs(t[i]));
        if (pk > 0) for (let i = 0; i < WT; i++) t[i] *= 0.9 / pk;
        mips.push(t);
      }
      return mips;
    }
  
    /* ══════════════════════════════════════════════════════════════════════
       THE CORE
       ══════════════════════════════════════════════════════════════════════ */
    class DSP {
      constructor(sr) {
        this.sr = sr;
        this.post = () => {};
        this.fs = 0;                                   // context frame at the start of this block
        this.busL = BN.map(() => new Float32Array(BLK));
        this.busR = BN.map(() => new Float32Array(BLK));
        this.gain = Float32Array.from(BUS_GAIN);
        this.masterG = 0.85; this.revG = 0.85; this.delG = 1;
        this.sendR = new Float32Array(BLK); this.sendD = new Float32Array(BLK);
        this.mono = new Float32Array(BLK);
        this.voices = [];
        this.events = []; this.total = 1; this.spb = 0.5; this.spbF = 0.5 * sr;
        this.anchor = 0; this.pass = 0; this.idx = 0;
        this.running = false; this.silentUntil = 0; this.region = null;
        this.stopping = false; this.stopG = 1; this.stopFade = 0.8;
        this.banishAt = null; this.banishSec = 0;
        this.blocks = 0; this.meterAcc = new Float32Array(BN.length);
        this.mlL = 0; this.mlR = 0;
        this.kit = { kSub: 1, kPunch: 1, kDecay: 1, sBody: 1, sSnap: 1, hDecay: 1 };
        this.cells = defaultCells(sr);
        this.glot = defaultGlot(sr);
        this.mkReverb(); this.mkDelay();
      }
  
      /* ── Effects ─────────────────────────────────────────────────────── */
      /** Freeverb-style reverb: 8 damped combs + 4 allpasses per channel, with a 23-sample stereo spread. */
      mkReverb() {
        const sc = this.sr / 44100, C = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], A = [556, 441, 341, 225];
        this.combs = [0, 23].map((off) => C.map((n) => ({ buf: new Float32Array(Math.round((n + off) * sc)), i: 0, lp: 0 })));
        this.aps = [0, 23].map((off) => A.map((n) => ({ buf: new Float32Array(Math.round((n + off) * sc)), i: 0 })));
      }
      revChan(ch, x) {
        let acc = 0;
        for (const c of this.combs[ch]) {
          const y = c.buf[c.i];
          c.lp = y * 0.8 + c.lp * 0.2;                // damp = 0.2
          c.buf[c.i] = x * 0.015 + c.lp * 0.84;       // room feedback = 0.84
          c.i = c.i + 1 === c.buf.length ? 0 : c.i + 1;
          acc += y;
        }
        for (const a of this.aps[ch]) {
          const b = a.buf[a.i];
          a.buf[a.i] = acc + b * 0.5;
          a.i = a.i + 1 === a.buf.length ? 0 : a.i + 1;
          acc = b - acc;
        }
        return acc;
      }
      mkDelay() {
        const len = Math.round(3 * this.sr);
        this.dl = { L: new Float32Array(len), R: new Float32Array(len), len, i: 0, lpL: 0, lpR: 0 };
      }
  
      /* ── Transport & time ─────────────────────────────────────────────── */
      beatAt(f) { return (f - this.anchor) / this.spbF; }
      lowerBound(rel) {
        let lo = 0, hi = this.events.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (this.events[m].beat < rel) lo = m + 1; else hi = m; }
        return lo;
      }
      /** Re-anchor so `beat` occurs at frame `f`, without touching voices. */
      reanchor(beat, f) {
        this.anchor = f - beat * this.spbF;
        this.pass = this.total > 0 ? Math.floor(beat / this.total) : 0;
        let idx = this.lowerBound(beat - this.pass * this.total);
        if (idx >= this.events.length) { idx = 0; this.pass++; }
        this.idx = idx;
      }
      seekBeat(beat, f, keep) {
        this.reanchor(beat, f);
        if (!keep) this.voices = this.voices.filter((v) => v.held);
      }
  
      /** Start every event whose absolute beat lies in [b0, b1), at its exact frame. */
      schedule(f0, n) {
        const E = this.events, len = E.length;
        if (!len) return;
        const b0 = this.beatAt(f0), b1 = this.beatAt(f0 + n);
        for (let guard = 0; guard < 5000; guard++) {
          const ev = E[this.idx];
          const ab = this.pass * this.total + ev.beat;
          if (ab >= b1) break;
          if (ab >= b0) this.startEvent(ev, Math.max(f0, Math.round(this.anchor + ab * this.spbF)));
          this.idx++;
          if (this.idx >= len) { this.idx = 0; this.pass++; }
        }
      }
  
      /* ── Voice construction ───────────────────────────────────────────── */
      push(v) {
        if (this.voices.length >= MAXV) this.voices.shift();  // steal the oldest
        this.voices.push(v);
        return v;
      }
      startEvent(ev, fr) {
        const durF = Math.max(1, (ev.dur || 0.25) * this.spbF);
        switch (ev.type) {
          case 'lead': {
            const k = ev.timbre === 'reed' ? 'vox' : ev.timbre === 'koto' ? 'pluck' : 'wave';
            this.addNote(k, 'lead', ev, fr, durF); break;
          }
          case 'harm': this.addNote('vox', 'harm', ev, fr, durF); break;
          case 'bell': this.addNote('chime', 'bell', ev, fr, durF); break;
          case 'pad': for (const m of ev.midis || []) this.addNote('wave', 'pad', { ...ev, midi: m, vel: ev.vel * 0.7, attack: 0.5 }, fr, durF); break;
          case 'bass': this.addNote('wave', 'bass', { ...ev, sub: true }, fr, durF); break;
          case 'arp': this.addNote('pluck', 'arp', ev, fr, durF); break;
          case 'drone': this.addNote('wave', 'drone', { ...ev, sub: true, attack: 1.2 }, fr, durF); break;
          case 'kick': case 'snare': case 'hat': case 'crash': case 'shaker': case 'swell':
            this.addPerc(ev.type, ev, fr); break;
          default: break;
        }
      }
      addNote(k, bus, ev, fr, durF) {
        const sr = this.sr, midi = ev.midi ?? 60, f = mtof(midi), vel = ev.vel ?? 0.7;
        const morphS = Number.isFinite(durF) ? durF : 2 * sr;
        const v = {
          perc: false, k, bus: BN.indexOf(bus), start: fr, endF: fr + durF, held: false, rel: false, dead: false,
          age: 0, vel, pan: ev.pan || 0, f, fc: f, gk: 1, ph: 0, m: mipFor(f), stage: 0, e: 0,
          ra: 1 / (Math.max(0.002, ev.attack ?? 0.006) * sr), S: 0.8,
          rd: ex(0.35, sr), rr: ex(0.22, sr), rs: seedOf(fr, midi), lp: 0,
          lk: 1 - Math.exp((-TAU * (500 + 4500 * (ev.bright ?? 0.5) * vel)) / sr),
          sub: !!ev.sub, ps: 0, morph: morphS, w0: 0, w1: 0.5,
        };
        if (ev.from != null && k !== 'pluck') { v.fc = mtof(ev.from); v.gk = 1 - Math.exp(-1 / (0.03 * sr)); }
        if (k === 'wave') {
          const cell = ev.cell ?? (((ev.deg ?? 0) % 16) + 16) % 16;
          v.tA = this.cells[cell][v.m];
          v.tB = this.cells[(cell + 5) & 15][v.m];
          if (ev.w0 != null) v.w0 = ev.w0;
          if (ev.w1 != null) v.w1 = ev.w1;
          v.vel *= 0.35;
        } else if (k === 'vox') {
          const syl = ev.syl || {}, c = String(syl.c || '').toLowerCase();
          v.vowel = VOWEL[syl.v] ? syl.v : 'a';
          v.nasal = c === 'm' || c === 'n';
          const F = VOWEL[v.vowel].slice(); if (v.nasal) F[0] = 280;
          v.fm = [bpCoef(F[0], 8, sr), bpCoef(F[1], 10, sr), bpCoef(F[2], 12, sr)];
          v.onset = 0.035 * sr; v.cn = v.nasal ? 0.05 : 0.35;
          v.gt = this.glot[v.m];
          v.vel *= 0.7;
        } else if (k === 'pluck') {
          const N = Math.max(2, Math.round(sr / f));
          v.buf = new Float32Array(N); v.bi = 0; v.damp = 0.996;
          for (let i = 0; i < N; i++) v.buf[i] = rnd(v) * 0.5;
          v.S = 1; v.rd = 1; v.ra = 1 / (0.002 * sr); v.vel *= 0.6;
        } else if (k === 'chime') {
          v.I0 = 1.2 + 3.0 * vel; v.pm = 0; v.S = 0; v.rd = ex(1.8, sr);
          v.ra = 1 / (0.002 * sr); v.fc = f; v.gk = 1; v.vel *= 0.8;
        }
        return this.push(v);
      }
      addPerc(t, ev, fr) {
        const sr = this.sr, open = !!ev.open;
        const life = { kick: 0.6, snare: 0.5, hat: open ? 1.0 : 0.3, crash: 3.5, shaker: 0.2, swell: (ev.dur || 1) * this.spb + 0.3 }[t] || 0.5;
        this.push({
          perc: true, k: t, bus: t === 'crash' || t === 'shaker' || t === 'swell' ? 6 : 6,
          start: fr, endF: Infinity, held: false, rel: false, dead: false, age: 0,
          vel: ev.vel ?? 0.7, pan: ev.pan || 0, life: life * sr, dur: (ev.dur || 1) * this.spb,
          nl: 0, gain: 1, ph: 0, root: mtof(ev.root ?? 36), dec: open ? 0.25 : 0.04, rs: seedOf(fr, ev.midi),
        });
      }
  
      /* ── Per-sample voice kernels ──────────────────────────────────────── */
      /** Sustained envelope: attack, decay toward S, release on `rel`. */
      env(v) {
        if (v.stage === 0) { v.e += v.ra; if (v.e >= 1) { v.e = 1; v.stage = 1; } }
        else v.e = v.S + (v.e - v.S) * v.rd;
        if (v.rel) { v.e *= v.rr; if (v.e < 1e-4) v.dead = true; }
        return v.e;
      }
      sTone(v) {
        switch (v.k) {
          case 'wave': return this.sWave(v);
          case 'vox': return this.sVox(v);
          case 'pluck': return this.sPluck(v);
          case 'chime': return this.sChime(v);
          default: return 0;
        }
      }
      sWave(v) {
        const e = this.env(v), sr = this.sr;
        v.fc += (v.f - v.fc) * v.gk;
        const inc = v.fc / sr;
        v.ph += inc; v.ph -= Math.floor(v.ph);
        const w = v.w0 + (v.w1 - v.w0) * Math.min(1, v.age / v.morph);
        let y = tab(v.tA, v.ph) * (1 - w) + tab(v.tB, v.ph) * w;
        if (v.sub) { v.ps += inc * 0.5; v.ps -= Math.floor(v.ps); y = 0.8 * y + 0.35 * Math.sin(TAU * v.ps); }
        v.lp += (y - v.lp) * v.lk;
        v.age++;
        return v.lp * e * v.vel;
      }
      sVox(v) {
        const e = this.env(v), sr = this.sr;
        v.fc += (v.f - v.fc) * v.gk;
        v.ph += (v.fc * (1 + 0.006 * Math.sin((TAU * 5.2 * v.age) / sr))) / sr;
        v.ph -= Math.floor(v.ph);
        const g = tab(v.gt, v.ph);
        let s = (bq(g, v.fm[0]) + 0.7 * bq(g, v.fm[1]) + 0.4 * bq(g, v.fm[2])) * 2.2 + rnd(v) * 0.012;
        if (v.age < v.onset) s += rnd(v) * v.cn * (1 - v.age / v.onset);  // consonant onset
        v.age++;
        return s * e * v.vel;
      }
      sPluck(v) {
        const e = this.env(v), b = v.buf, N = b.length, i = v.bi;
        const y0 = b[i], y1 = b[(i + 1) % N];
        b[i] = (y0 + y1) * 0.4995 * v.damp;
        v.bi = (i + 1) % N; v.age++;
        return y0 * e * v.vel;
      }
      sChime(v) {
        const e = this.env(v), sr = this.sr;
        const I = v.I0 * Math.exp(-v.age / (0.6 * sr));   // the bell brightens, then mellows
        v.ph += v.fc / sr; v.ph -= Math.floor(v.ph);
        v.pm += (v.fc * 3.5) / sr; v.pm -= Math.floor(v.pm);
        v.age++;
        return Math.sin(TAU * v.ph + I * Math.sin(TAU * v.pm)) * e * v.vel;
      }
      sPerc(v) {
        const sr = this.sr, K = this.kit, t = v.age / sr, r = rnd(v);
        let y = 0;
        switch (v.k) {
          case 'kick': {
            const f = v.root * (1 + 2.6 * Math.exp(-t * 30));
            v.ph += f / sr; v.ph -= Math.floor(v.ph);
            const a = Math.exp(-t / (0.26 * K.kDecay));
            y = (Math.sin(TAU * v.ph) * K.kSub + 0.12 * Math.sin(TAU * 2 * v.ph) * Math.exp(-t / 0.05)) * a;
            if (t < 0.004) y += r * 0.5 * K.kPunch * (1 - t / 0.004);
            break;
          }
          case 'snare': {
            v.ph += 190 / sr; v.ph -= Math.floor(v.ph);
            v.nl += (r - v.nl) * 0.35;                              // one-pole low-pass
            y = Math.sin(TAU * v.ph) * Math.exp(-t / 0.07) * 0.55 * K.sBody
              + (r - v.nl) * Math.exp(-t / 0.16) * 0.45 * K.sSnap;   // high-passed noise
            break;
          }
          case 'hat': v.nl += (r - v.nl) * 0.5; y = (r - v.nl) * Math.exp(-t / (v.dec * K.hDecay)) * 0.35; break;
          case 'crash': v.nl += (r - v.nl) * 0.15; y = (r - v.nl) * Math.exp(-t / 1.4) * 0.25; break;
          case 'shaker': v.nl += (r - v.nl) * 0.6; y = (r - v.nl) * Math.exp(-t / 0.03) * 0.25; break;
          case 'swell': v.nl += (r - v.nl) * 0.05; y = v.nl * Math.min(1, t / v.dur) * 0.35; break;
          case 'tick': v.nl += (r - v.nl) * 0.4; y = (r - v.nl) * Math.exp(-t / 0.012) * 0.5; break;
          default: break;
        }
        v.age++;
        if (v.age > v.life) v.dead = true;
        return y * v.vel * v.gain;
      }
  
      /** Run every live voice over the block and sum it into its bus. */
      voiceRender(v, f0, n, i0) {
        const m = this.mono;
        for (let i = i0; i < n; i++) {
          const fr = f0 + i;
          if (!v.held && !v.rel && fr >= v.endF) v.rel = true;
          m[i] = v.perc ? this.sPerc(v) : this.sTone(v);
          if (v.dead) { m.fill(0, i, n); break; }
        }
        const p = ((v.pan + 1) * Math.PI) / 4, gl = Math.cos(p), gr = Math.sin(p);
        const L = this.busL[v.bus], R = this.busR[v.bus];
        for (let i = i0; i < n; i++) { const x = m[i]; L[i] += x * gl; R[i] += x * gr; }
        return !v.dead;
      }
      renderVoices(f0, n) {
        const vs = this.voices;
        for (let k = vs.length - 1; k >= 0; k--) {
          const v = vs[k];
          if (v.start >= f0 + n) continue;                  // starts in a later block
          if (!this.voiceRender(v, f0, n, Math.max(0, v.start - f0))) vs.splice(k, 1);
        }
      }
  
      /* ── Mixing, effects, master ─────────────────────────────────────── */
      mix(L, R, n, f0) {
        const sr = this.sr, rv = this.sendR, dv = this.sendD;
        // Sends, measured after each bus's gain, and peak metering.
        for (let bi = 0; bi < BN.length; bi++) {
          const g = this.gain[bi], sR = SEND_REV[bi] * g, sD = SEND_DEL[bi] * g;
          const bl = this.busL[bi], br = this.busR[bi];
          for (let i = 0; i < n; i++) {
            const a = Math.max(Math.abs(bl[i]), Math.abs(br[i]));
            if (a > this.meterAcc[bi]) this.meterAcc[bi] = a;
            const mo = 0.5 * (bl[i] + br[i]);
            rv[i] += mo * sR; dv[i] += mo * sD;
          }
        }
        // Optional banish low-pass sweep (an exponential LP across the master).
        let bk = 0;
        if (this.banishAt != null) {
          const t = (f0 - this.banishAt) / sr, s = this.banishSec;
          let fc = 0;
          if (t < s) fc = 20000 * Math.pow(140 / 20000, t / s);
          else if (t < s + 0.4) fc = 140;
          else if (t < s + 1.6) fc = 140 * Math.pow(20000 / 140, (t - s - 0.4) / 1.2);
          else this.banishAt = null;
          if (fc > 0) bk = 1 - Math.exp((-TAU * fc) / sr);
        }
        const D = this.dl, dt = clamp(Math.round(0.75 * this.spb * sr), 1, D.len - 1);
        const sg = this.stopping ? this.stopG : 1;
        for (let i = 0; i < n; i++) {
          let l = 0, r = 0;
          for (let bi = 0; bi < BN.length; bi++) {
            const g = this.gain[bi];
            l += this.busL[bi][i] * g; r += this.busR[bi][i] * g;
          }
          const wl = this.revChan(0, rv[i]), wr = this.revChan(1, rv[i]);
          const ri = (D.i - dt + D.len) % D.len;
          const dl = D.L[ri], dr = D.R[ri];
          D.lpL += (dl - D.lpL) * 0.35; D.lpR += (dr - D.lpR) * 0.35;   // darker repeats
          D.L[D.i] = dv[i] + D.lpL * 0.36; D.R[D.i] = dv[i] + D.lpR * 0.36;
          D.i = (D.i + 1) % D.len;
          l += wl * this.revG * 0.35 + dl * this.delG * 0.6;
          r += wr * this.revG * 0.35 + dr * this.delG * 0.6;
          if (bk) { this.mlL += (l - this.mlL) * bk; l = this.mlL; this.mlR += (r - this.mlR) * bk; r = this.mlR; }
          L[i] = softClip(l * this.masterG * sg);
          R[i] = softClip(r * this.masterG * sg);
        }
        rv.fill(0); dv.fill(0);
      }
  
      /* ── Block entry point ───────────────────────────────────────────── */
      render(L, R, n) {
        const sr = this.sr, f0 = this.fs;
        try {
          for (let bi = 0; bi < BN.length; bi++) { this.busL[bi].fill(0); this.busR[bi].fill(0); }
          if (this.running && f0 >= this.silentUntil) {
            // Loop a region by jumping back to its start at the boundary.
            if (this.region && this.total > 0) {
              const b = this.beatAt(f0), rel = b - Math.floor(b / this.total) * this.total;
              if (rel + n / this.spbF >= this.region.end && this.region.end > this.region.start) this.seekBeat(this.region.start, f0, true);
            }
            this.schedule(f0, n);
            this.renderVoices(f0, n);
          }
          this.mix(L, R, n, f0);
          if (this.stopping) {
            this.stopG -= n / (this.stopFade * sr);
            if (this.stopG <= 0) { this.running = false; this.stopping = false; this.stopG = 1; this.voices.length = 0; }
          }
          if (++this.blocks % 8 === 0) {
            this.post({ cmd: 'tick', beat: this.beatAt(f0), f: f0, running: this.running });
            this.post({ cmd: 'meters', peak: Array.from(this.meterAcc) });
            this.meterAcc.fill(0);
          }
        } catch (e) {
          if (!this._faulted) { this._faulted = true; this.post({ cmd: 'fault', message: String(e && e.message || e) }); }
          L.fill(0); R.fill(0);
        }
      }
  
      /* ── Host messages ───────────────────────────────────────────────── */
      handle(m) {
        switch (m.cmd) {
          case 'cells': this.cells = m.cells; this.glot = m.glot; break;
          case 'score': {
            const cur = this.beatAt(this.fs);
            this.events = m.events; this.total = m.total; this.spb = m.spb; this.spbF = m.spb * this.sr;
            if (this.running) this.reanchor(cur, this.fs);   // keep the beat position
            break;
          }
          case 'tempo': {
            const cur = this.beatAt(this.fs);
            this.spb = m.spb; this.spbF = m.spb * this.sr;
            this.reanchor(cur, this.fs);
            break;
          }
          case 'play':
            this.running = true; this.stopping = false; this.stopG = 1;
            this.silentUntil = m.at;
            this.seekBeat(m.beat, m.at, false);
            break;
          case 'stop': this.stopping = true; this.stopFade = Math.max(0.01, m.fade || 0.8); break;
          case 'seek': this.seekBeat(m.beat, this.fs, false); break;
          case 'region': this.region = m.region; break;
          case 'param': this.setParam(m.key, m.value); break;
          case 'kit': this.kit = { ...this.kit, ...m.kit }; break;
          case 'oneshot':
            if (m.kind === 'chime') this.addNote('chime', 'bell', { midi: m.midi, vel: 0.7 }, this.fs, 4 * this.sr);
            else this.addPerc('tick', { vel: 0.5 }, this.fs);
            break;
          case 'banish': this.banishAt = this.fs; this.banishSec = m.sec; break;
          case 'noteon': {
            const v = this.addNote('wave', 'lead', { midi: m.midi, vel: m.vel, bright: 0.6 }, this.fs, Infinity);
            v.held = true; v.id = m.id; break;
          }
          case 'noteoff':
            for (const v of this.voices) if (v.id === m.id) { v.held = false; v.rel = true; }
            break;
          default: break;
        }
      }
      setParam(key, val) {
        if (key.startsWith('bus.')) { const i = BN.indexOf(key.slice(4)); if (i >= 0) this.gain[i] = val; }
        else if (key === 'master') this.masterG = val;
        else if (key === 'rev') this.revG = val;
        else if (key === 'del') this.delG = val;
      }
    }
  
    /** Fallback wavetables so the worklet is audible before the host sends real cells. */
    function defaultCells(sr) {
      const cells = [];
      for (let c = 0; c < 16; c++) {
        const re = new Float64Array(NH), im = new Float64Array(NH);
        re[1] = 1; re[2] = 0.3 * ((c & 3) / 3); re[3] = 0.2 * ((c >> 2) / 3);
        cells.push(buildMips(re, im, sr));
      }
      return cells;
    }
    function defaultGlot(sr) {
      const re = new Float64Array(NH), im = new Float64Array(NH);
      for (let h = 1; h < NH; h++) re[h] = 1 / (h * h);
      return buildMips(re, im, sr);
    }
  
    /* ── Exports ───────────────────────────────────────────────────────── */
    const api = { DSP, buildMips, BN, BUS_GAIN, SEND_REV, SEND_DEL };
    if (typeof window !== 'undefined') window.SigilDSP = api;
  
    /* ── AudioWorklet registration (runs only on the audio thread) ──────── */
    if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
      class SigilProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.core = new DSP(sampleRate);
          this.core.post = (m) => this.port.postMessage(m);
          this.port.onmessage = (e) => this.core.handle(e.data);
        }
        process(_inputs, outputs) {
          const out = outputs[0];
          if (!out || !out[0]) return true;
          const L = out[0], R = out[1] || out[0];
          this.core.fs = currentFrame;                  // the context frame at the start of this block
          this.core.render(L, R, L.length);
          return true;
        }
      }
      registerProcessor('sigil-dsp', SigilProcessor);
    }
  })();