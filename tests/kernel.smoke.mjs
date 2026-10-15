/* Kernel smoke test: no browser, no dependencies.   node tests/kernel.smoke.mjs
   Loads the kernel exactly as the page does, plays every instrument through every
   effect offline, and checks the output is finite, audible, bounded and repeatable. */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const ctx = createContext({ console });
   runInContext(readFileSync(join(root, 'src/engine/sigil-kernel.js'), 'utf8'), ctx, { filename: 'sigil-kernel.js' });
   const K = runInContext('SigilKernel', ctx);
   
   let bad = 0;
   const ok = (cond, label, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ' + detail}`); if (!cond) bad++; };
   
   const sr = 44100, spb = 0.5, DRUMS = { kick: 1, snare: 1, hat: 1, noise: 1 };
   function job() {
     const plan = new K.Plan();
     let beat = 0;
     for (let rep = 0; rep < 3; rep++) {
       for (const kind of Object.keys(K.KIND)) {
         plan.add(kind, { beat, bus: DRUMS[kind] ? 'drums' : 'lead', freq: 110 * (1 + (rep + beat) % 4), from: rep ? 165 : 0,
                          dur: 1.5, vel: 0.8, pan: rep - 1, ta: rep % 2, tb: 1, duck: kind === 'kick' ? 0.5 : 0 });
         beat += 0.5;
       }
     }
     const { events, count } = plan.finish();
     const total = Math.ceil(beat) + 4;
     const scenes = new Float64Array([0, 0.6, 0.5, 0.4, 6, 2, 0.2, 0.3]);   // chorus, echo and crusher all on
     return {
       sr, frames: Math.round((total * spb * 2 + 4) * sr),
       setup: [{ cmd: 'tempo', spb }, { cmd: 'reverb', rt60: 2.5, bright: 0.6, pre: 0.014, taps: [[0.03, 0.5, -0.5], [0.07, 0.3, 0.6]] },
               { cmd: 'score', events, count, total, scenes, passes: 2 }, { cmd: 'play', beat: 0, lead: 0 }],
       count, total,
     };
   }
   
   function render(j) {
     const r = K.createRender(j);
     const t0 = performance.now();
     while (r.step(sr) < 1);
     return { r, ms: performance.now() - t0 };
   }
   const check = (a) => { let peak = 0, finite = true; for (let i = 0; i < a.length; i++) { const v = a[i]; if (!(v - v === 0)) finite = false; if (Math.abs(v) > peak) peak = Math.abs(v); } return { peak, finite }; };
   
   const j = job();
   const A = render(j), B = render(job());
   const cl = check(A.r.L), cr = check(A.r.R);
   ok(cl.finite && cr.finite, 'output is finite');
   ok(cl.peak > 0.02 && cr.peak > 0.02, 'output is audible', `peak ${cl.peak}`);
   ok(cl.peak <= 1.0001 && cr.peak <= 1.0001, 'output never exceeds full scale', `peak ${cl.peak}`);
   ok(A.r.kernel.faults === 0, 'no kernel faults', `faults ${A.r.kernel.faults}`);
   let same = true;
   for (let i = 0; i < A.r.L.length; i += 7) if (A.r.L[i] !== B.r.L[i]) { same = false; break; }
   ok(same, 'two renders of the same plan are identical');
   const tail = A.r.L.subarray(A.r.L.length - sr / 10);
   ok(check(tail).peak < 0.05, 'the tail decays');
   console.log(`  ${j.count} events · ${(j.frames / sr).toFixed(1)} s rendered in ${A.ms.toFixed(0)} ms (${(j.frames / sr / (A.ms / 1000)).toFixed(0)}× real time) · peak ${cl.peak.toFixed(3)}`);
   
   /* Live-style commands must never throw or corrupt the stream. */
   const k = new K.Kernel(sr), L = new Float32Array(128), R = new Float32Array(128);
   for (const m of job().setup) k.handle(m);
   k.handle({ cmd: 'score', events: job().setup[2].events, count: j.count, total: j.total, scenes: null });
   const e = new Float64Array(K.EV.STRIDE);
   K.writeEvent(e, 0, 'fm', { bus: 'ritual', freq: 880, vel: 0.7, s: 0, d: 0.9, r: 0.9 });
   let fine = true;
   try {
     for (let b = 0; b < 3000; b++) {
       if (b === 200) k.handle({ cmd: 'seek', beat: 6 });
       if (b === 400) k.handle({ cmd: 'region', start: 4, end: 8 });
       if (b === 900) k.handle({ cmd: 'tempo', spb: 0.3 });
       if (b === 1200) k.handle({ cmd: 'note', e, id: 7 });
       if (b === 1300) k.handle({ cmd: 'off', id: 7 });
       if (b === 1400) k.handle({ cmd: 'param', name: 'tone', value: 200, time: 0.5, mode: 'exp' });
       if (b === 1500) k.handle({ cmd: 'region', start: 0, end: 0 });
       if (b === 2000) k.handle({ cmd: 'stop', fade: 0.5 });
       k.process(L, R, 128);
       if (!check(L).finite) { fine = false; break; }
     }
   } catch (err) { fine = false; console.error(err); }
   ok(fine && k.faults === 0, 'seek, loop, tempo, notes, ramps and stop run cleanly');
   ok(k.state().beat >= 0, 'state() reports');
   
   if (bad) { console.error(`\n${bad} check(s) failed.`); process.exit(1); }
   console.log('\nKernel smoke test passed.');