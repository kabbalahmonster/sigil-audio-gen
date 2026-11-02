/* ══════════════════════════════════════════════════════════════════════════
   MASTER SPEC — the plan (05e), the chain, the limiter and the probe (DSP §5d).
   No browser, no dependencies.

     node tests/master.spec.mjs            everything (a few minutes: it listens to songs)
     node tests/master.spec.mjs --quick    skip everything that renders
     node tests/master.spec.mjs §7 §3      only the groups whose names contain one of these

   What it defends
     1. OFF IS OFF. Without a plan, or with it switched off, the engine is, bit
        for bit, the engine before mastering existed (the same hashes the
        drum and motion specs hold it to).
     2. THE METER IS A METER. A tone of known level reads what BS.1770 says it
        must, at any rate; the gate gates; a peak between samples is found.
     3. THE LIMITER HOLDS. Nothing leaves above the ceiling, between the
        samples included; under the ceiling it is a delay and nothing else.
     4. THE CHAIN AT REST is flat, and a new plan is glided to, not jumped to.
     5. THE FINISH follows the letters, is the same every time, and varies.
     6. THE PLAN is deterministic; lands on the loudness asked for; holds the
        ceiling; forecasts the trimmed mix it will meet; never moves anything
        further than its bounds; and each setting does what it says.
     7. THE GRAIN. A cap takes away what the quantiser adds and only that, and
        what is left sits at the budget.
     8. THE STAGE AND THE FILE. A plan laid on a running core is faded in, a
        range rendered on its own measures as it does inside the whole, and
        probe ranges join into the whole.
     9. STEMS ADD UP to the mix that entered the chain.
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05k-fills.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/core/05e-master.js', 'src/core/06b-compiler.js'];
   const QUICK = process.argv.includes('--quick');
   const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('--'));
   
   /** A fresh VM: the pure layers, the DSP core, the mastering layer and the compiler, in index.html's order. No modules. */
   function fresh() {
     const sandbox = { TextEncoder, btoa, atob, console, performance };
     sandbox.window = sandbox; sandbox.globalThis = sandbox;
     const ctx = createContext(sandbox);
     for (const f of FILES) runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
     return (code) => runInContext(code, ctx);
   }
   
   let pass = 0, fail = 0;
   const ok = (cond, label, detail) => {
     if (cond) { pass++; console.log(`  ✓ ${label}`); }
     else { fail++; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
   };
   const eq = (a, b, label) => ok(Object.is(a, b), label, `expected ${JSON.stringify(b)}  got ${JSON.stringify(a)}`);
   const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, `${label} (${(+a).toFixed(2)})`, `expected ${b} ± ${tol}  got ${a}`);
   function group(name, fn) {
     if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
     console.log(`\n${name}`);
     try { fn(); } catch (e) { ok(false, `${name}: threw`, String((e && e.stack) || e)); }
   }
   
   /** Helpers every group shares, defined inside the VM so that typed arrays stay in one realm. */
   const HELPERS = `
     globalThis.D = SigilDSP; globalThis.M = Mastering; globalThis.MA = SigilDSP.MA;
     globalThis.hash = (r) => { let h = 2166136261; for (let i = 0; i < r.L.length; i++) {
       h = Math.imul(h ^ (Math.round(r.L[i] * 32767) & 0xffff), 16777619); h = Math.imul(h ^ (Math.round(r.R[i] * 32767) & 0xffff), 16777619); }
       return (h >>> 0).toString(16); };
     /** A sine in both channels: peak in dBFS, phase in turns. */
     globalThis.tone = (sr, secs, hz, dbfs, phase = 0) => { const n = Math.round(sr * secs), L = new Float32Array(n), a = Math.pow(10, dbfs / 20);
       for (let i = 0; i < n; i++) L[i] = a * Math.sin(2 * Math.PI * (hz * i / sr + phase)); return { L, R: Float32Array.from(L) }; };
     globalThis.join2 = (a, b) => { const L = new Float32Array(a.L.length + b.L.length), R = new Float32Array(L.length);
       L.set(a.L); L.set(b.L, a.L.length); R.set(a.R); R.set(b.R, a.R.length); return { L, R }; };
     /** The song the app would play (the groove and the movers on), as a render job, cut to its first sections. */
     globalThis.songOf = (word, cfg) => { const sig = buildSigil(word);
       const off = cfg ? Hooks.on('compose', (c) => { Object.assign(c, cfg(c) || {}); }) : null;
       const song = Groove.apply(composeSong(sig), sig, {}); if (off) off();
       return { sig, song }; };
     globalThis.jobOf = (word, nSec, o = {}) => { const { sig, song } = songOf(word, o.cfg), spec = SigilPlan.defaultSpec(sig, song);
       Object.assign(spec.P, o.patch || {});
       const job = SigilPlan.renderJob(song, sig, { sr: o.sr || M.RATE, spb: song.spb, passes: 1, lens: false, spec, levels: o.levels || M.referenceLevels(song) });
       if (nSec && nSec < job.nSec) { const total = job.sections[nSec * D.PSTRIDE];
         let count = 0; while (count < job.count && job.events[count * D.STRIDE] < total) count++;
         Object.assign(job, { nSec, total, count, sections: job.sections.slice(0, nSec * D.PSTRIDE) }); }
       return job; };
     const heard = new Map();
     /** Pass A of a job, heard once. */
     globalThis.partsOf = (job) => { const k = M.keyOf(job); if (!heard.has(k)) heard.set(k, M.join(M.ranges(M.heardOf(job), 1)
       .map((r) => D.probeRange(M.probeJob(job, job.levels, M.neutral(job.nSec)), r.from, r.to, r.keep, 1)))); return heard.get(k); };
     /** The finished plan for a job under some settings (pass A reused, pass B listened to). */
     globalThis.planOf = (job, opts) => { const first = M.interim(M.solveA(partsOf(job), M.probeJob(job, job.levels), opts));
       const hearB = (at) => M.solveB(M.join(M.ranges(M.heardOf(job), 1).map((r) => D.probeRange(M.probeJob(job, job.levels, M.table(at)), r.from, r.to, r.keep, 2))), at);
       const plan = hearB(first); return M.settled(plan, first) ? plan : hearB(plan); };
     globalThis.finish = (job, plan, sr) => { const j = Object.assign({}, job, { sr: sr || job.sr, master: M.table(plan) });
       const r = D.renderRange(j, 0, M.heardOf(job), 0); return Object.assign(r, M.measure(r.L, r.R, j.sr)); };
     globalThis.bytes = (plan) => [plan.p, plan.trim, plan.sec].map((a) => Array.from(a).join(',')).join('|');
     globalThis.dbOf = (x) => 20 * Math.log10(x);
   `;
   
   /* ═══════════════════════════════════════════════════════════════════════
      2 · THE METER
      ═══════════════════════════════════════════════════════════════════════ */
   group('§2 · the meter is a meter (BS.1770, EBU Tech 3341 / 3342)', () => {
     const run = fresh(); run(HELPERS);
     for (const sr of [32000, 44100, 48000]) {
       near(run(`(() => { const t = tone(${sr}, 20, 997, -23); return M.measure(t.L, t.R, ${sr}).lufs; })()`), -23, 0.1, `a 997 Hz tone at −23 dBFS in both channels reads −23 LUFS at ${sr} Hz`);
     }
     near(run(`(() => { const t = tone(48000, 20, 997, -23); t.R.fill(0); return M.measure(t.L, t.R, 48000).lufs; })()`), -26.01, 0.1, 'in one channel only it reads 3 LU less');
     near(run(`(() => { const q = tone(48000, 10, 997, -36), t = join2(join2(q, tone(48000, 60, 997, -23)), q); return M.measure(t.L, t.R, 48000).lufs; })()`),
          -23, 0.1, 'quiet stretches 13 LU under the rest are gated out (Tech 3341, case 3)');
     near(run(`(() => { const t = join2(tone(48000, 20, 997, -20), tone(48000, 20, 997, -30)); return M.measure(t.L, t.R, 48000).range; })()`),
          10, 1, 'twenty seconds at −20 then twenty at −30 is a range of 10 LU (Tech 3342, case 1)');
     const tp = run(`(() => { const t = tone(48000, 1, 12000, 0, 0.125), m = M.measure(t.L, t.R, 48000); return [m.peak, m.truePeak]; })()`);
     near(tp[0], -3.01, 0.05, 'a tone at a quarter of the rate, sampled off its crests, has a sample peak of −3 dBFS');
     near(tp[1], 0, 0.35, '…and a true peak of 0 dBTP: the peak between the samples is found');
     near(run(`(() => { const e = new Float32Array(200).fill(3200 * Math.pow(10, (-20 + 0.691) / 10)); return M.lufs(e, 3200); })()`), -20, 0.001,
          'the probe’s hops are read the same way (energy per hop → LUFS)');
     eq(run(`M.lufs(new Float32Array(100), 3200)`), -Infinity, 'silence has no loudness, and says so');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      3 · THE LIMITER
      ═══════════════════════════════════════════════════════════════════════ */
   group('§3 · the limiter holds', () => {
     const run = fresh(); run(HELPERS);
     run(`globalThis.limit = (sr, L, R, ceil) => { const lim = new D.Limiter(sr), n = L.length, oL = new Float32Array(n), oR = new Float32Array(n), a = new Float32Array(128), b = new Float32Array(128);
         let lo = 1; for (let p = 0; p < n; p += 128) { const m = Math.min(128, n - p); a.set(L.subarray(p, p + m)); b.set(R.subarray(p, p + m)); lim.run(a, b, m, ceil);
           oL.set(a.subarray(0, m), p); oR.set(b.subarray(0, m), p); } return { L: oL, R: oR, look: lim.look, gr: lim.gr }; };
       globalThis.noise = (n, seed, amp) => { const R = stream(hashStr('master-spec'), 'noise:' + seed), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = R.range(-amp, amp); return x; };`);
     ok(run(`(() => { const L = noise(48000, 1, 0.5), R = noise(48000, 2, 0.5), o = limit(48000, L, R, 0.9);
         for (let i = o.look; i < L.length; i++) if (o.L[i] !== L[i - o.look] || o.R[i] !== R[i - o.look]) return false; return o.gr === 1; })()`),
        'under the ceiling it is a delay of its look-ahead and nothing else, sample for sample');
     for (const sr of [44100, 48000]) {
       const r = run(`(() => { const n = ${sr} * 5, L = noise(n, 3, 0.2), R = noise(n, 4, 0.2), ceil = Math.pow(10, -1 / 20);
           // bursts 12 dB over the ceiling, a tone whose crests fall between the samples, and single-sample spikes
           for (let i = ${sr} * 0.5; i < ${sr} * 0.8; i++) { L[i] *= 18; R[i] *= 17; }
           for (let i = ${sr} * 1.2; i < ${sr} * 1.6; i++) { const s = 1.6 * Math.sin(2 * Math.PI * (${sr} / 4 * i / ${sr} + 0.125)); L[i] += s; R[i] -= s; }
           for (let i = ${sr} * 2; i < ${sr} * 2.5; i += 4001) { L[i] = 3; R[i + 7] = -2.5; }
           const o = limit(${sr}, L, R, ceil); let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(o.L[i]), Math.abs(o.R[i]));
           return { pk: dbOf(pk), tp: dbOf(Math.max(D.truePeak(o.L), D.truePeak(o.R))), gr: dbOf(o.gr), tail: dbOf(Math.abs(o.L[n - 1] / (L[n - 1 - o.look] || 1))) }; })()`);
       ok(r.pk <= -1 + 1e-6, `${sr} Hz: no sample leaves above the ceiling, whatever arrives (${r.pk.toFixed(2)} dBFS)`, JSON.stringify(r));
       ok(r.tp <= -1 + 0.2, `${sr} Hz: nor does a peak between the samples (${r.tp.toFixed(2)} dBTP)`, JSON.stringify(r));
       ok(r.gr < -10, `${sr} Hz: and it says how far it reached (${r.gr.toFixed(1)} dB)`);
       ok(Math.abs(r.tail) < 0.1, `${sr} Hz: two and a half seconds after the last spike it has let go`, `still ${r.tail.toFixed(2)} dB`);
     }
     ok(run(`(() => { const n = 48000, L = new Float32Array(n), R = new Float32Array(n); L[1000] = 4; const o = limit(48000, L, R, 0.5);
         let first = -1; for (let i = 0; i < n; i++) if (o.L[i] !== 0) { first = i; break; } return first === 1000 + o.look && Math.abs(o.L[first]) <= 0.5 + 1e-9; })()`),
        'a lone spike comes out once, in its place, at the ceiling: the gain was there before the peak was');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      4 · THE CHAIN AT REST
      ═══════════════════════════════════════════════════════════════════════ */
   group('§4 · the chain at rest, and a plan arriving', () => {
     const run = fresh(); run(HELPERS);
     run(`globalThis.rest = () => { const p = Float64Array.from(D.MASTER_REST); p[MA.ON] = 1; p[MA.LO_R] = p[MA.MID_R] = p[MA.HI_R] = p[MA.GLUE_R] = 1; p[MA.CEIL] = -0.1; return p; };
       globalThis.through = (sr, x, p, ride = 0) => { const c = new D.MasterChain(sr); c.set(p, true); const n = x.L.length, L = Float32Array.from(x.L), R = Float32Array.from(x.R), a = new Float32Array(128), b = new Float32Array(128);
         for (let q = 0; q + 128 <= n; q += 128) { a.set(L.subarray(q, q + 128)); b.set(R.subarray(q, q + 128)); c.run(a, b, 128, ride, null); L.set(a, q); R.set(b, q); } return { L, R, chain: c }; };
       globalThis.levelOf = (x, from, to) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (to - from)); };`);
     const flat = run(`[60, 110, 160, 400, 1000, 3000, 4800, 9000, 14000].map((hz) => { const t = tone(48000, 1.5, hz, -20), o = through(48000, t, rest());
         return +(levelOf(o.L, 24000, 72000) - levelOf(t.L, 24000, 72000)).toFixed(3); })`);
     ok(flat.every((d) => Math.abs(d) < 0.25), 'at rest (no EQ, no compression, no drive) a tone leaves as loud as it came in, from 60 Hz to 14 kHz',
        `dB at 60 110 160 400 1k 3k 4.8k 9k 14k: ${flat.join(' ')}`);
     ok(run(`(() => { const t = tone(48000, 1.5, 12, -20), o = through(48000, t, rest()); return levelOf(o.L, 24000, 72000) - levelOf(t.L, 24000, 72000); })()`) < -9,
        'and what is below hearing is taken out (12 Hz is more than 9 dB down)');
     const eqd = run(`[3, 4, 5, 6].map((k, j) => { const p = rest(); p[k] = 3; const hz = [40, 320, 3000, 15000][j], t = tone(48000, 1.5, hz, -20), o = through(48000, t, p);
         return +(levelOf(o.L, 24000, 72000) - levelOf(t.L, 24000, 72000)).toFixed(2); })`);
     ok(eqd.every((d) => d > 2 && d < 3.4), 'each of the four EQ bands, asked for +3 dB, gives it where it lives', `low, low-mid, presence, air: ${eqd.join(' ')}`);
     near(run(`(() => { const p = rest(); p[MA.IN] = -6; p[MA.OUT] = 9; const t = tone(48000, 1.5, 1000, -20), o = through(48000, t, p); return levelOf(o.L, 24000, 72000) - levelOf(t.L, 24000, 72000); })()`),
          3, 0.1, 'the gain in and the make-up add up');
     near(run(`(() => { const t = tone(48000, 1.5, 1000, -20), a = through(48000, t, rest(), 0), b = through(48000, t, rest(), -2.5); return levelOf(b.L, 24000, 72000) - levelOf(a.L, 24000, 72000); })()`),
          -2.5, 0.05, 'a ride is a gain, in dB, on the way in');
     ok(run(`(() => { const side = (mono) => { const p = rest(); p[MA.MONO] = mono; const t = tone(48000, 1, 70, -20); t.R.fill(0); const o = through(48000, t, p);
           return levelOf(o.L, 24000, 48000) - levelOf(o.R, 24000, 48000); };
         globalThis.MONO = [side(0), side(1)]; return MONO[0] > 20 && Math.abs(MONO[1]) < 1; })()`), 'with Mono at full, a bass note on one side leaves in the middle', run(`JSON.stringify(MONO)`));
     ok(run(`(() => { const p = rest(); p[MA.GLUE_T] = -30; p[MA.GLUE_R] = 4; const t = tone(48000, 2, 1000, -10), o = through(48000, t, p);
         const d = levelOf(o.L, 48000, 96000) - levelOf(t.L, 48000, 96000); return d < -8 && d > -13 && o.chain.gr[3] < 0.5; })()`),
        'the glue compresses by its ratio above its threshold (−13 dB rms, 4:1 over −30: about 12.8 dB), and reports it');
     ok(run(`(() => { const sr = 48000, c = new D.MasterChain(sr), p = rest(); c.set(p, true); const a = new Float32Array(128), b = new Float32Array(128);
         const q = Float64Array.from(p); q[MA.IN] = 12; q[MA.LOW] = 6; let worst = 0, prev = 0, ph = 0;
         for (let blk = 0; blk < 400; blk++) { if (blk === 50) c.set(q, false);
           for (let i = 0; i < 128; i++) { a[i] = b[i] = 0.05 * Math.sin(ph); ph += 2 * Math.PI * 200 / sr; }
           c.run(a, b, 128, 0, null);
           for (let i = 0; i < 128; i++) { const d = Math.abs(a[i] - prev); if (blk > 40 && d > worst) worst = d; prev = a[i]; } }
         // a 200 Hz tone at its loudest here (0.2) moves 0.0052 a sample; a jump would be many times that
         return worst < 0.0075; })()`), 'a new plan is glided to: twelve decibels and an EQ move arrive without a step');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      5 · THE FINISH
      ═══════════════════════════════════════════════════════════════════════ */
   group('§5 · the finish follows the letters', () => {
     const run = fresh(); run(HELPERS);
     run(`globalThis.ch = (w, v) => M.character(buildSigil(w), v || 0);`);
     ok(run(`JSON.stringify(ch('KRSTVM')) === JSON.stringify(ch('KRSTVM')) && JSON.stringify(ch('KRSTVM', 7)) === JSON.stringify(ch('KRSTVM', 7))`), 'the same sigil is always given the same finish, and the same variation of it');
     ok(run(`ch('FSHVZXC').air > 0.3 && ch('MNJ').weight > 0.3 && ch('LRWY').warmth > 0.3 && ch('BPDGKTQ').punch > 0.3`),
        'fricatives ask for air, nasals for weight, liquids for warmth, plosives for punch', run(`JSON.stringify([ch('FSHVZXC'), ch('MNJ'), ch('LRWY'), ch('BPDGKTQ')])`));
     ok(run(`ch('BPDGKTQ').air < 0 && ch('FSHVZXC').punch < 0`), 'and a sigil with none of a family leans away from it');
     ok(run(`(() => { const R = stream(hashStr('master-spec'), 'words'); for (let i = 0; i < 80; i++) { const w = R.shuffle(CONSONANTS).slice(0, R.int(3, 21)).join('');
         for (const v of [0, 1, 50, 99]) { const c = ch(w, v); for (const k of ['air', 'weight', 'warmth', 'punch', 'glue', 'width']) if (!(c[k] >= -1 && c[k] <= 1)) return false; } } return true; })()`),
        'every lean is between −1 and 1, for any sigil and any variation');
     ok(run(`new Set([0, 1, 2, 3, 4, 5].map((v) => JSON.stringify(ch('THWLBDNS', v)))).size === 6 && new Set(['KRSTVM', 'THWLBDNS', 'BCD', 'FSHVZXC', 'MNJLRWY'].map((w) => M.describe(ch(w)))).size >= 4`),
        'each variation is another finish, and different sigils are finished differently');
     ok(run(`['KRSTVM', 'FSHVZXC', 'MNJLRWY', 'BPDGKTQ'].every((w) => /^[a-z]+( · [a-z]+){0,2}$/.test(M.describe(ch(w))))`), 'and each can be named in at most three words', run(`M.describe(ch('FSHVZXC'))`));
     ok(run(`(() => { const sig = buildSigil('KRSTVM'), song = composeSong(sig), spec = SigilPlan.defaultSpec(sig, song);
         const a = SigilPlan.mixInfo(song, sig, spec); spec.P.finish = 3; spec.P.fAmt = 0.4; spec.P.drums *= 2; const b = SigilPlan.mixInfo(song, sig, spec);
         return a.finish.variant === 0 && a.amount === 1 && Math.abs(a.kit - 1) < 1e-9 && b.finish.variant === 3 && b.amount === 0.4 && Math.abs(b.kit - 2) < 1e-9; })()`),
        'a job carries it: the patch’s finish and amount, and the kit level the patch asks for on purpose');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      6 · SOLVING, WITHOUT LISTENING (made-up measurements)
      ═══════════════════════════════════════════════════════════════════════ */
   group('§6 · the arithmetic of a plan', () => {
     const run = fresh(); run(HELPERS);
     const c = run(`M.capFor(1, 0.01, 0, -26)`);
     near(c.ratio, -20, 1e-6, 'grain a hundredth of the music’s energy sits 20 dB under it');
     near(c.cap, Math.pow(10, -6 / 20), 1e-6, '…and a budget of −26 keeps half of it (−6 dB)');
     eq(run(`M.capFor(1, 0.001, 0, -26).cap`), 1, 'grain already under the budget is kept whole');
     eq(run(`M.capFor(1, 1, 0, -80).cap`), run(`M.NOISE.floor`), 'no budget takes it all: a trace is always left');
     near(run(`M.capFor(1, 0.05, 0.2, -20).ratio`), -20 - 20 * Math.log10(1.2), 0.01, 'the part of the grain that is only "the signal again" (a sample-hold is a filter too) is not counted as noise');
     eq(run(`M.capFor(0, 0, 0, -26).cap`), 1, 'a crusher that never ran is left alone');
     ok(run(`(() => { const o = M.options({ target: -99, level: 7, noise: -3, dynamics: 'x', ceiling: 4 });
         return o.target === -24 && o.level === 1 && o.noise === -1 && o.dynamics === M.DEFAULTS.dynamics && o.ceiling === -0.1 && M.options().on === true && M.options({ on: false }).on === false; })()`),
        'settings are clamped, and anything unreadable falls back to the house’s');
     ok(run(`(() => { const rs = M.ranges(190.3, 3), hop = D.probeHop(M.RATE); const onGrid = (t) => Math.abs(t / hop - Math.round(t / hop)) < 1e-6;
         return rs.length === 3 && rs[0].keep === 0 && rs[0].from === 0 && rs.every((r, i) => onGrid(r.keep) && onGrid(r.to) && onGrid(r.from) && (i === 0 || (Math.abs(r.keep - rs[i - 1].to) < 1e-9 && r.keep - r.from >= M.PRE)))
           && rs[2].to >= 190.3 && M.ranges(20, 4).length === 1; })()`),
        'ranges tile the song on the probe’s hop grid, each with its pre-roll; a short song is one range');
     ok(run(`(() => { const job = jobOf('KRSTVM', 0), p = M.provisional(job, {}), t = M.table(p);
         return p.provisional && !p.final && t.p[MA.ON] === 1 && t.trim.every((x) => x === 1) && t.sec.length === 3 * job.nSec
           && Array.from(t.sec.subarray(0, job.nSec)).every((x) => x === 0.4) && Array.from(t.sec.subarray(2 * job.nSec)).every((x) => x === 0)
           && M.table(p, true).p[MA.STEM] === 1 && M.table(null) === null; })()`),
        'before anything is heard there is a provisional plan: no trims, no rides, the crushers’ grain held back');
     ok(run(`(() => { const job = jobOf('KRSTVM', 0), base = M.provisional(job, {}), like = { p: Float64Array.from(base.p), opts: M.options({ target: -14 }) };
         like.p[MA.IN] = -11; like.p[MA.OUT] = 9; const p = M.provisional(job, { target: -10 }, like);
         return p.p[MA.IN] === -11 && p.p[MA.OUT] === 13 && p.provisional && base.p[MA.IN] === -4; })()`),
        'and if the sigil was finished a moment ago (a mood was changed), the provisional plan starts from those gains');
     ok(run(`(() => { const a = jobOf('KRSTVM', 0), b = jobOf('KRSTVM', 0), c = jobOf('KRSTVM', 0, { patch: { bright: 0.31 } }), d = jobOf('THWLBDNS', 0), e = jobOf('KRSTVM', 0, { sr: 48000 });
         const f = jobOf('KRSTVM', 0, { patch: { finish: 4, fAmt: 0.2 } });
         return M.keyOf(a) === M.keyOf(b) && M.keyOf(a) !== M.keyOf(c) && M.keyOf(a) !== M.keyOf(d) && M.keyOf(a) === M.keyOf(e) && M.keyOf(a) === M.keyOf(f)
           && M.keyOf(a, { lead: 0.5 }) !== M.keyOf(a); })()`),
        'a job’s key is its sound: the same song has the same key at any rate and under any finish; a knob, a fader or another sigil changes it');
   });
   
   if (!QUICK || ONLY.length) {
     /* ═══════════════════════════════════════════════════════════════════════
        1 · OFF IS OFF
        ═══════════════════════════════════════════════════════════════════════ */
     group('§1 · without a plan, the engine is the engine before mastering', () => {
       const run = fresh(); run(HELPERS);
       run(`globalThis.around = (word, sr, master, then) => { const sig = buildSigil(word), song = composeSong(sig), spec = SigilPlan.defaultSpec(sig, song);
           Object.assign(spec.P, { motion: 0, evolve: 0 });
           const job = SigilPlan.renderJob(song, sig, { sr, spb: song.spb, passes: 1, lens: false, spec, levels: null, drums: { fx: false }, master });
           if (then) then(job);
           const s = song.sections[2].start, a = (s - 8) * song.spb, b = (s + 8) * song.spb;
           return SigilDSP.renderRange(job, a, b, a); };`);
       /* Recorded from the commit before the drum chain, motion or mastering existed (SigilDSP v2): same range, same hash. */
       eq(run(`hash(around('KRSTVM', 48000, null))`), '3e9ebb88', 'KRSTVM @ 48000: no plan = the v2 engine, bit for bit');
       eq(run(`hash(around('THWLBDNS', 44100, null))`), '83a0a5e', 'THWLBDNS @ 44100: the same');
       eq(run(`hash(around('KRSTVM', 48000, (() => { const t = M.neutral(7); t.p[MA.ON] = 0; t.trim.fill(0.5); t.sec.fill(0.1); return t; })()))`), '3e9ebb88',
          'a plan that is switched off is no plan: its trims, caps and rides are not laid on either');
       ok(run(`hash(around('KRSTVM', 48000, (() => { const t = M.neutral(7); t.p[MA.STEM] = 0; return t; })())) !== '3e9ebb88'`), 'and with the chain on, even at rest, the sound is another (it is limited, and delayed)');
       ok(run(`(() => { const c = new D.Core(48000, { warm: false }), t = M.neutral(7); t.trim.fill(0.5);
           c.command({ type: 'master', p: t.p, trim: t.trim, sec: t.sec, snap: true }); const on = c.lat;
           c.command({ type: 'master', p: null, snap: true });
           return on === 0 && c.lat === 0 && Array.from(c.trT).every((x) => x === 1) && Array.from(c.trG).every((x) => x === 1) && c.secT === null && !c.gate && !c.ms.on; })()`),
          'taking a plan away leaves nothing of it behind');
       ok(run(`(() => { const c = new D.Core(48000, { warm: false }), t = M.neutral(7); t.p[MA.STEM] = 0;
           c.command({ type: 'master', p: t.p, trim: t.trim, sec: t.sec, snap: true }); return c.lat === c.ms.lim.look && c.lat === Math.round(0.004 * 48000); })()`),
          'the chain’s delay is the limiter’s look-ahead (4 ms), and the core knows it (the transport reports it; a render takes it out)');
     });
   
     /* ═══════════════════════════════════════════════════════════════════════
        6 · THE PLAN, LISTENED FOR
        ═══════════════════════════════════════════════════════════════════════ */
     group('§6 · a plan lands where it is asked to', () => {
       const run = fresh(); run(HELPERS);
       run(`globalThis.J = jobOf('KRSTVM', 3); globalThis.P = planOf(J, {}); globalThis.F = finish(J, P);`);
       eq(run(`bytes(planOf(jobOf('KRSTVM', 3), {}))`), run(`bytes(P)`), 'the same job and settings give the same plan, number for number');
       ok(run(`bytes(planOf(jobOf('BPDGKTQ', 3), {})) !== bytes(P)`), 'and another sigil gives another');
       near(run(`F.lufs`), -14, 0.3, 'KRSTVM: the finished audio measures the loudness asked for (−14 LUFS)');
       ok(run(`F.truePeak`) <= -1 + 0.15, `and stays under its true-peak ceiling (${run(`F.truePeak`).toFixed(2)} dBTP)`);
       near(run(`P.report.lufs`), run(`F.lufs`), 0.25, 'the plan’s own report says what the audio will measure');
       near(run(`P.report.flat`), run(`P.report.measured`), 0.4, 'pass A forecast the trimmed mix that pass B then met');
       near(run(`finish(J, P, 48000).lufs`), -14, 0.35, 'heard at 32 kHz, it lands as well at 48 kHz');
       ok(run(`(() => { const L = [-16, -10].map((t) => { const p = planOf(J, { target: t }), f = finish(J, p); return [f.lufs - t, f.truePeak, bytes(p) === bytes(P)]; });
           globalThis.LOUD = L; return L.every(([d, tp]) => Math.abs(d) < 0.25 && tp <= -1 + 0.15); })()`),
          'asked for −16 or for −10, it lands there too, under the same ceiling', run(`JSON.stringify(LOUD)`));
       ok(run(`(() => { const p = planOf(J, { target: -10 }); return Array.from(p.trim).join() === Array.from(P.trim).join() && Array.from(p.sec).join() === Array.from(P.sec).join()
           && p.p[MA.IN] === P.p[MA.IN] && Math.abs((p.p[MA.OUT] - P.p[MA.OUT]) - 4) < 0.8; })()`), 'a louder target changes the make-up and nothing else');
       ok(run(`(() => { const r = P.report, lim = (x, a, b) => x >= a - 1e-9 && x <= b + 1e-9;
           return r.parts.every((q) => lim(q.trim, -6, 4.5)) && Array.from(P.sec.subarray(0, 6)).every((x) => lim(x, M.NOISE.floor, 1))
             && r.rides.every((x) => lim(x, -M.RIDE.down, M.RIDE.up)) && lim(P.p[MA.IN], -24, 24) && lim(P.p[MA.OUT], -24, 30)
             && [0, 1, 2, 3].every((j) => Math.abs(P.p[MA.LOW + j]) <= 5 + 2.2); })()`), 'nothing is moved further than its bounds');
       ok(run(`P.report.rides.some((x) => x < -0.3) && Math.max(...P.report.rides) === 0`), 'the loudest section is not ridden; quieter ones are set under it', run(`JSON.stringify(P.report.rides)`));
   
       /* each setting does what it says */
       ok(run(`(() => { const A = partsOf(J), ref = M.probeJob(J, J.levels), p = M.solveA(A, ref, { level: 0 });
           return Array.from(p.trim).every((x) => x === 1) && M.solveA(A, ref, { level: 1 }).report.parts.some((q) => Math.abs(q.trim) > 0.5); })()`),
          'Balance at zero moves no part; at full it does');
       ok(run(`(() => { const A = partsOf(J), ref = M.probeJob(J, J.levels), raw = M.solveA(A, ref, { noise: 1 }), clean = M.solveA(A, ref, { noise: -1 }), house = M.solveA(A, ref, {});
           const caps = (p) => Array.from(p.sec.subarray(0, 3));
           return caps(raw).every((x) => x === 1) && raw.p[MA.GATE] === 0 && house.p[MA.GATE] === 1
             && caps(clean).every((x, i) => x <= caps(house)[i]) && caps(house).some((x) => x < 0.9) && caps(clean).some((x, i) => x < caps(house)[i] * 0.5); })()`),
          'Noise at its top leaves the crusher exactly as composed; lower keeps less of its grain');
       ok(run(`(() => { const A = partsOf(J), ref = M.probeJob(J, J.levels), r = (d) => M.solveA(A, ref, { dynamics: d }).report.rides;
           return r(0).every((x) => x >= 0) && r(1).every((x, i) => x <= r(0.5)[i] + 1e-9) && r(1).some((x) => x < -1); })()`),
          'Dynamics at zero sets no section down; more sets the quiet ones further under');
       ok(run(`(() => { const A = partsOf(J), ref = M.probeJob(J, J.levels), at = (mix) => M.solveA(A, Object.assign({}, ref, { mix: Object.assign({}, ref.mix, mix) }), {});
           const kit = (p) => p.report.parts[6].trim, base = at({});
           return kit(at({ kit: 1.5 })) > kit(base) + 1 && kit(at({ kit: 0.6 })) < kit(base) - 1
             && Array.from(at({ mood: { noise: 12 } }).sec.subarray(0, 3)).every((x, i) => x >= base.sec[i]) && at({ mood: { noise: 12 } }).sec[2] > base.sec[2]
             && at({ amount: 0 }).p[MA.DRIVE] === 0.14 && at({ amount: 0 }).p[MA.WIDTH] === 1.05; })()`),
          'the kit level a patch asks for is kept, a mood may ask for more grain, and with no Character the chain is the house’s own');
       ok(run(`(() => { const A = partsOf(J), ref = M.probeJob(J, J.levels), at = (finish) => M.solveA(A, Object.assign({}, ref, { mix: Object.assign({}, ref.mix, { finish }) }), {});
           const z = { air: 0, weight: 0, warmth: 0, punch: 0, glue: 0, width: 0 }, base = at(z), bright = at(Object.assign({}, z, { air: 1 })), heavy = at(Object.assign({}, z, { weight: 1 }));
           const warm = at(Object.assign({}, z, { warmth: 1 })), struck = at(Object.assign({}, z, { punch: 1 })), wide = at(Object.assign({}, z, { width: 1 }));
           return bright.p[MA.AIR] > base.p[MA.AIR] + 1 && heavy.p[MA.LOW] > base.p[MA.LOW] + 1 && warm.p[MA.DRIVE] > base.p[MA.DRIVE]
             && struck.p[MA.GLUE_A] > base.p[MA.GLUE_A] * 1.5 && wide.p[MA.WIDTH] > base.p[MA.WIDTH]; })()`),
          'the finish reaches the chain: air opens the top, weight the bottom, warmth drives, punch slows the glue, width widens');
   
       /* a song without a kit, and one whose mood moves faders */
       run(`globalThis.JA = jobOf('KRSTVM', 3, { cfg: (c) => { c.levels = { drums: 0, pad: 1.2 }; } }); globalThis.PA2 = planOf(JA, {}); globalThis.FA = finish(JA, PA2);`);
       near(run(`FA.lufs`), -14, 0.3, 'a rite with its kit silenced lands on −14 as well');
       ok(run(`PA2.report.parts[6].heard === false && PA2.trim[6] === 1 && PA2.report.kitness < 0.05 && PA2.report.goal[3] < M.TONE[0][3] - 3`),
          '…its kit is not judged, and its tone is not asked to be as bright as a rite with cymbals');
     });
   
     /* ═══════════════════════════════════════════════════════════════════════
        7 · THE GRAIN
        ═══════════════════════════════════════════════════════════════════════ */
     group('§7 · the cap takes the grain and only the grain', () => {
       const run = fresh(); run(HELPERS);
       run(`globalThis.J = jobOf('KRSTVM', 3); globalThis.A = partsOf(J); globalThis.P = M.solveA(A, M.probeJob(J, J.levels), {});
         globalThis.relisten = (sec) => { const t = M.neutral(J.nSec); t.sec.set(sec);
           return M.join(M.ranges(M.heardOf(J), 1).map((r) => D.probeRange(M.probeJob(J, J.levels, t), r.from, r.to, r.keep, 1))); };
         globalThis.ratios = (X) => P.hops.map(([a, b]) => { let xx = 0, dd = 0, dx = 0; for (let h = a; h < b; h++) { xx += X.crX[h]; dd += X.crD[h]; dx += X.crDX[h]; }
           return M.capFor(xx, dd, dx, 0).ratio; });`);
       ok(run(`P.report.noise.some((z) => z.musicCap < 0.5) && P.report.noise.every((z) => z.music > -40)`), 'KRSTVM’s four-bit crusher is heard, and is capped', run(`JSON.stringify(P.report.noise.map((z) => [+z.music.toFixed(1), +z.musicCap.toFixed(2)]))`));
       ok(run(`(() => { const after = ratios(relisten(P.sec)), S = J.sections;
           globalThis.GR = after.map((r, s) => [+r.toFixed(1), +(M.NOISE.base + M.NOISE.perGrit * S[s * D.PSTRIDE + D.PA.GRIT]).toFixed(1), +P.sec[s].toFixed(2)]);
           return GR.every(([r, budget, cap]) => cap >= 0.999 ? r <= budget + 0.5 : Math.abs(r - budget) < 0.8); })()`),
          'listened to again with the caps on, each capped section’s grain sits at its budget', run(`JSON.stringify(GR)`));
       ok(run(`(() => { const sec = Float64Array.from(P.sec); sec.fill(0, 0, J.nSec); const X = relisten(sec); let dd = 0, xx = 0; for (let h = 0; h < X.n; h++) { dd += X.crD[h]; xx += X.crX[h]; }
           globalThis.Z = [dd, xx]; return dd === 0 && xx > 0; })()`), 'a cap of zero leaves no grain at all', run(`JSON.stringify(Z)`));
       ok(run(`(() => { const sec = Float64Array.from(P.sec); sec.fill(0, 0, J.nSec); const X = relisten(sec), lu = (Y) => M.lufs(Y.mus, Y.per);
           globalThis.MU = [lu(A), lu(X)]; return Math.abs(MU[0] - MU[1]) < 1.5; })()`), '…and the music is still there, driven and folded as the patch has it', run(`JSON.stringify(MU)`));
       ok(run(`(() => { const j = jobOf('BCD', 3), p = M.solveA(partsOf(j), M.probeJob(j, j.levels), {});
           return p.report.noise.every((z) => z.music === -Infinity && z.musicCap === 1); })()`), 'a sigil without a crusher has nothing to cap');
       ok(run(`(() => { const crush = (gate, x) => { const c = new D.Core(48000, { warm: false }); c.gritS = 0.6; c.bits = 4; c.hold = 2; c.gate = gate;
             const L = new Float32Array(128).fill(x), R = new Float32Array(128).fill(x); let e = 0;
             for (let k = 0; k < 60; k++) { L.fill(x); R.fill(x); c.crush(L, R, 128, 1, null, null); for (let i = 0; i < 128; i++) e += (L[i] - x * 0.4) * (L[i] - x * 0.4); } return e; };
           // 0.01 is a tail at −40 dBFS, a twelfth of one step of a four-bit quantiser; 0.3 is a note
           globalThis.GATE = [crush(false, 0.01), crush(true, 0.01), crush(false, 0.3), crush(true, 0.3)];
           return GATE[0] > 1e-2 && GATE[1] < 1e-9 && GATE[2] > 1e-3 && Math.abs(GATE[3] / GATE[2] - 1) < 0.2; })()`),
          'under a plan the dither rides the signal: a dying tail is no longer turned into crackle, and a note is crushed as it always was', run(`JSON.stringify(GATE)`));
     });
   
     /* ═══════════════════════════════════════════════════════════════════════
        8 · THE STAGE AND THE FILE
        ═══════════════════════════════════════════════════════════════════════ */
     group('§8 · the stage and the file', () => {
       const run = fresh(); run(HELPERS);
       run(`globalThis.J = jobOf('BPDGKTQ', 3); globalThis.P = planOf(J, {}); globalThis.T = M.table(P);
         globalThis.coreOf = (job) => { const c = new D.Core(job.sr, { voices: 80, warm: false });
           c.command({ type: 'cube', spectra: job.spectra, tilt: job.tilt, density: job.density });
           c.command({ type: 'plan', events: job.events, count: job.count, sections: job.sections, nSec: job.nSec, total: job.total, bpm: job.bpm, passes: 0, auto: job.auto });
           c.command({ type: 'levels', levels: job.levels, snap: true }); c.command(Object.assign({ type: 'params' }, job.params)); return c; };
         globalThis.play = (c, blocks) => { const L = new Float32Array(blocks * 128), R = new Float32Array(blocks * 128), a = new Float32Array(128), b = new Float32Array(128);
           for (let k = 0; k < blocks; k++) { c.blockTime = k * 128 / c.sr; c.process(a, b, 128); L.set(a, k * 128); R.set(b, k * 128); } return { L, R }; };`);
       ok(run(`(() => { const c = coreOf(J); c.command({ type: 'play', beat: 20, pass: 0, chase: true }); c.snapFx();
           const before = play(c, 250); c.command({ type: 'master', p: T.p, trim: T.trim, sec: T.sec, snap: false });
           const after = play(c, 400), look = c.ms.lim.look; let pk = 0, early = 0;
           for (let i = 0; i < look + 8; i++) early = Math.max(early, Math.abs(after.L[i]));
           for (let i = 0; i < after.L.length; i++) pk = Math.max(pk, Math.abs(after.L[i]), Math.abs(after.R[i]));
           const m = M.measure(after.L.subarray(32000), after.R.subarray(32000), J.sr);
           globalThis.LIVE = { early, pk: dbOf(pk), lufs: m.lufs, t: c.tickInfo(0, 0).master };
           return early < 0.02 && pk <= Math.pow(10, -1 / 20) + 1e-6 && LIVE.t && LIVE.t.n > 0 && LIVE.t.k > 0 && LIVE.t.lim <= 1; })()`),
          'a plan laid on a sounding core is faded in, held under the ceiling from its first block, and metered', run(`JSON.stringify(LIVE)`));
       ok(run(`(() => { const c = coreOf(J), seen = []; c.onTransport = (t, beat) => seen.push(t);
           c.command({ type: 'master', p: T.p, trim: T.trim, sec: T.sec, snap: true }); c.command({ type: 'play', beat: 0, pass: 0 }); c.blockTime = 10; play(c, 1);
           return seen.length > 0 && Math.abs(seen[seen.length - 1] - c.lat / c.sr) < 1e-9 && c.lat > 0; })()`),
          'the transport says when a beat is HEARD: the limiter’s look-ahead later than when it was made');
       ok(run(`(() => { const full = finish(J, P), T1 = M.heardOf(J), hop = D.probeHop(J.sr), cut = Math.round(30 / hop) * hop;
           const j = Object.assign({}, J, { master: T }), seg = D.renderRange(j, cut - 6, T1, cut), o = Math.round(cut * J.sr);
           const a = M.measure(full.L.subarray(o), full.R.subarray(o), J.sr), b = M.measure(seg.L, seg.R, J.sr);
           globalThis.SEG = [a.lufs, b.lufs, a.truePeak, b.truePeak, seg.L.length - (full.L.length - o)];
           return Math.abs(a.lufs - b.lufs) < 0.25 && b.truePeak <= -1 + 0.15 && SEG[4] === 0; })()`),
          'a range rendered on its own, as a parallel segment is, measures as it does inside the whole, and is as long', run(`JSON.stringify(SEG)`));
       ok(run(`(() => { const one = partsOf(J), rs = M.ranges(M.heardOf(J), 2);
           const two = M.join(rs.map((r) => D.probeRange(M.probeJob(J, J.levels, M.neutral(J.nSec)), r.from, r.to, r.keep, 1)));
           globalThis.JN = [rs.length, one.n, two.n, M.lufs(one.mix, one.per), M.lufs(two.mix, two.per), M.lufs(one.drm, one.per), M.lufs(two.drm, two.per)];
           return rs.length === 2 && one.n === two.n && one.bus.length === two.bus.length && Math.abs(JN[3] - JN[4]) < 0.25 && Math.abs(JN[5] - JN[6]) < 0.25; })()`),
          'listened to in two ranges or in one, the probe hears the same song', run(`JSON.stringify(JN)`));
       ok(run(`(() => { const a = finish(J, P), b = finish(J, P); return hash(a) === hash(b); })()`), 'a finished render is repeatable, bit for bit');
       ok(run(`(() => { const stem = M.neutral(J.nSec), rest = M.neutral(J.nSec); rest.p[MA.STEM] = 0; rest.p[MA.IN] = -12;
           rest.p[MA.LO_R] = rest.p[MA.MID_R] = rest.p[MA.HI_R] = rest.p[MA.GLUE_R] = 1;
           const a = D.renderRange(Object.assign({}, J, { master: stem }), 0, 30, 0).L, b = D.renderRange(Object.assign({}, J, { master: rest }), 0, 30, 0).L;
           // Compared by their treble (a second difference): the crossovers, like any, hold the bass back a millisecond or two.
           const hi = (x, i) => x[i] - 2 * x[i - 1] + x[i - 2];
           let best = -1e9, lag = 0; const o = 20 * J.sr, n = 16384;
           for (let d = -300; d <= 300; d++) { let c = 0; for (let i = 0; i < n; i++) c += hi(a, o + i) * hi(b, o + i + d); if (c > best) { best = c; lag = d; } }
           globalThis.LAG = lag; return Math.abs(lag) <= 4 && a.length === b.length; })()`),
          'a render takes the chain’s look-ahead back out: the finished file is in time with the unfinished one', `lag ${run('LAG')} samples`);
       ok(run(`(() => { const c = coreOf(J), t = M.neutral(J.nSec), S = J.sections, st = (s) => S[s * D.PSTRIDE];
           t.sec[2 * J.nSec] = -1; t.sec[2 * J.nSec + 1] = -2; t.sec[2 * J.nSec + 2] = -3;
           c.command({ type: 'master', p: t.p, trim: t.trim, sec: t.sec, snap: true });
           const at = [c.rideAt(0), c.rideAt(st(1) - 1), c.rideAt(st(1) + 1), c.rideAt(st(2) - 2), c.rideAt(st(2) + 4), c.rideAt(J.total - 1)];
           c.command({ type: 'master', p: null, snap: true });
           globalThis.RD = at; return at.join() === '-1,-2,-2,-2,-3,-1' && c.rideAt(st(2) + 4) === 0; })()`),
          'a section’s ride is read a beat and a half ahead (so it arrives with the downbeat), wraps with the rite, and goes with the plan', run(`JSON.stringify(RD)`));
     });
   
     /* ═══════════════════════════════════════════════════════════════════════
        9 · STEMS
        ═══════════════════════════════════════════════════════════════════════ */
     group('§9 · stems add up to the mix that entered the chain', () => {
       const run = fresh(); run(HELPERS);
       run(`globalThis.J = jobOf('BCD', 2); globalThis.P = planOf(J, {}); globalThis.T = M.table(P, true);
         globalThis.stem = (levels) => D.renderRange(Object.assign({}, J, { master: T, levels }), 0, M.secondsOf(J), 0);`);
       ok(run(`T.p[MA.STEM] === 1 && T.p[MA.OUT] <= 0 && Array.from(T.trim).join() === Array.from(P.trim).join() && Array.from(T.sec).join() === Array.from(P.sec).join()`),
          'a stem’s table is the plan’s trims and caps, the chain skipped, and at most a common gain down');
       const r = run(`(() => { const whole = stem(J.levels), n = whole.L.length, sum = new Float32Array(n); let pk = 0;
           for (const name of M.PARTS) { const lv = {}; for (const k of D.BUS_NAMES) lv[k] = k === name ? J.levels[k] : 0;
             const s = stem(lv); for (let i = 0; i < n; i++) { sum[i] += s.L[i]; pk = Math.max(pk, Math.abs(s.L[i]), Math.abs(s.R[i])); } }
           let d = 0, e = 0; for (let i = 0; i < n; i++) { const x = sum[i] - whole.L[i]; d += x * x; e += whole.L[i] * whole.L[i]; }
           return { rel: 10 * Math.log10(d / e + 1e-30), pk: dbOf(pk), lat: 0 }; })()`);
       ok(r.rel < -60, `eight stems, laid side by side, are the mix to within ${r.rel.toFixed(0)} dB (BCD: no crusher on the music, so nothing non-linear is shared)`, JSON.stringify(r));
       ok(r.pk < -1, `and none of them clips a file (${r.pk.toFixed(1)} dBFS at most)`);
       const tr = run(`['lead', 'drums'].map((name) => { const lv = {}; for (const k of D.BUS_NAMES) lv[k] = k === name ? J.levels[k] : 0;
           const rms = (x) => { let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return 10 * Math.log10(e); };
           const a = rms(stem(lv).L), keep = T.trim[D.BUS[name]]; T.trim[D.BUS[name]] = keep * 0.5; const b = rms(stem(lv).L); T.trim[D.BUS[name]] = keep; return b - a; })`);
       ok(tr.every((d) => Math.abs(d + 6.02) < 0.05), 'a trim is a plain gain on its part: halve it and the part is 6 dB down (the kit’s too, after its own chain)', JSON.stringify(tr));
       ok(run(`(() => { const a = stem(J.levels), j = Object.assign({}, J, { master: null }), t = M.neutral(J.nSec); t.trim.set(P.trim); t.sec.set(P.sec); t.p[MA.OUT] = T.p[MA.OUT];
           const b = D.renderRange(Object.assign({}, J, { master: t }), 0, M.secondsOf(J), 0); return hash(a) === hash(b); })()`), 'a stem does not pass through the chain: no EQ, no compression, no limiter, no delay');
     });
   }
   
   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
   