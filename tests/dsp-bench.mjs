/* ══════════════════════════════════════════════════════════════════════════
   DSP BENCH: how fast is the core on THIS machine, and is it deterministic?
     node tests/dsp-bench.mjs [CONSONANTS] [sampleRate]
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/dsp/sigil-dsp.js', 'src/core/06b-compiler.js'];
   const sandbox = { TextEncoder, btoa, atob, console, performance };
   sandbox.window = sandbox; sandbox.globalThis = sandbox;
   const ctx = createContext(sandbox);
   for (const f of FILES) runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
   
   const word = process.argv[2] || 'KRSTVM', sr = +(process.argv[3] || 48000);
   const run = () => runInContext(`(() => {
     const sig = buildSigil(${JSON.stringify(word)}), song = composeSong(sig);
     const spec = SigilPlan.defaultSpec(sig, song);
     const job = SigilPlan.renderJob(song, sig, { sr: ${sr}, spb: song.spb, passes: 1, lens: false, spec, levels: null });
     const secs = song.total * song.spb + 6, t0 = performance.now();
     const r = SigilDSP.renderRange(job, 0, secs, 0);
     const ms = performance.now() - t0;
     let peak = 0, bad = 0, h = 2166136261;
     for (let i = 0; i < r.L.length; i++) {
       const a = r.L[i], b = r.R[i];
       if (!Number.isFinite(a) || !Number.isFinite(b)) bad++;
       peak = Math.max(peak, Math.abs(a), Math.abs(b));
       h = Math.imul(h ^ (Math.round(a * 32767) & 0xffff), 16777619);
     }
     return { secs, ms, peak, bad, hash: (h >>> 0).toString(16), events: job.count };
   })()`, ctx);
   
   const a = run(), b = run();
   const x = (a.secs * 1000) / a.ms;
   console.log(`${word}: ${a.events} events · ${a.secs.toFixed(1)} s of audio in ${(a.ms / 1000).toFixed(2)} s`);
   console.log(`→ ${x.toFixed(1)}× real time · the live engine needs ≈ ${(100 / x).toFixed(1)} % of one core`);
   console.log(`peak ${a.peak.toFixed(3)} · non-finite samples ${a.bad} · hash ${a.hash}`);
   console.log(a.hash === b.hash ? '✓ deterministic (two renders are bit-identical)' : '✗ NOT deterministic');
   process.exit(a.bad || a.hash !== b.hash ? 1 : 0);