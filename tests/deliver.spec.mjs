/* ══════════════════════════════════════════════════════════════════════════
   DELIVER SPEC — the last stretch of a render: 05h (what is done to a finished mix)
   and src/export/codecs.js (how it is written down). No browser, no dependencies
   (ffmpeg, if it is installed, is asked to agree: it is skipped if not).

     node tests/deliver.spec.mjs            everything
     node tests/deliver.spec.mjs --quick    skip the checks that call ffmpeg

   What it defends
     1. Settings are made sound: a format the browser can write, a rate and a bit depth it
        takes, a lossy file mastered a margin under its ceiling.
     2. The end of a file: dead air trimmed, the last breath glided to zero, never a step.
     3. Measurement and landing: the meter agrees with BS.1770 (and with ffmpeg's), and a
        file is brought to the loudness asked for without ever passing the ceiling.
     4. The bits: dither is seeded (the same render is the same file), flat or shaped as
        asked, silent where the signal is, and a word never overflows.
     5. Every writer writes what a reader reads: WAV, FLAC (decoded here, frame CRCs and the
        MD5 checked), ZIP, MP4/M4A, Ogg Opus, ID3 — each parsed back, byte for byte.
     6. The stems' common gain, and the master's listening over all the passes of a render.
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   import { execSync, spawnSync } from 'node:child_process';
   import { tmpdir } from 'node:os';
   import { createHash } from 'node:crypto';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05k-fills.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/core/05e-master.js', 'src/core/05h-deliver.js', 'src/export/codecs.js'];
   const QUICK = process.argv.includes('--quick');
   const HAVE_FFMPEG = !QUICK && spawnSync('ffmpeg', ['-version']).status === 0;
   
   function fresh() {
     const sandbox = { TextEncoder, TextDecoder, btoa, atob, console, performance, Blob, setTimeout, clearTimeout, queueMicrotask };
     sandbox.window = sandbox; sandbox.globalThis = sandbox;
     const ctx = createContext(sandbox);
     for (const f of FILES) runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
     const run = (code) => runInContext(code, ctx);
     run.sandbox = sandbox;
     return run;
   }
   
   let pass = 0, fail = 0;
   const ok = (cond, label, detail) => {
     if (cond) { pass++; console.log(`  ✓ ${label}`); }
     else { fail++; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
   };
   const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, label, `expected ${b} ± ${tol}, got ${a}`);
   async function group(name, fn) {
     console.log(`\n${name}`);
     try { await fn(); } catch (e) { ok(false, `${name}: threw`, String((e && e.stack) || e)); }
   }
   const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
   
   const run = fresh();
   const G = run.sandbox;   // what the VM sees as its globals
   /** A stereo test signal: a chord with a slow envelope, a little noise, and a decaying tail. */
   function music(sr, seconds, { tail = 0, level = 0.3, seed = 7 } = {}) {
     const n = Math.round(sr * seconds), L = new Float32Array(n), R = new Float32Array(n);
     let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
     for (let i = 0; i < n; i++) {
       const t = i / sr, env = (0.6 + 0.4 * Math.sin(2 * Math.PI * t / 3)) * (t < seconds - tail ? 1 : Math.pow(10, -(t - (seconds - tail)) * 3));
       const m = Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t) + 0.25 * Math.sin(2 * Math.PI * 1320 * t) + 0.05 * rnd();
       L[i] = level * env * (m + 0.3 * Math.sin(2 * Math.PI * 440 * t)); R[i] = level * env * (m - 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.02 * rnd());
     }
     return { L, R };
   }
   const dbOf = (x) => 20 * Math.log10(x);
   
   /* ═══════════════════════════════════════════════════════════════════════
      1 · SETTINGS ARE MADE SOUND
      ═══════════════════════════════════════════════════════════════════════ */
   await group('§1 · a delivery is made sound', () => {
     const r = (o) => run(`Deliver.resolve(${JSON.stringify(o)})`);
     ok(r({ format: 'nonsense' }).format === 'wav', 'an unknown format is WAV');
     ok(r({ format: 'opus', rate: 44100 }).rate === 48000, 'Opus is always 48 kHz');
     ok(r({ format: 'mp3', rate: 96000 }).rate === 48000, 'MP3 takes no more than 48 kHz: the nearest it takes');
     ok(r({ format: 'wav', rate: 96000 }).rate === 96000 && r({ format: 'flac', rate: 88200 }).rate === 88200, 'WAV and FLAC take the high rates');
     ok(r({ format: 'flac', bits: 32 }).bits === 24, 'FLAC has no 32-bit float: it is given 24');
     ok(r({ format: 'wav', bits: 32 }).bits === 32, 'WAV does');
     ok(r({ format: 'mp3', kbps: 999 }).kbps === 256 && r({ format: 'aac', kbps: 999 }).kbps === 192 && r({ format: 'opus' }).kbps === 160, 'a bitrate outside the list is the format’s usual');
     ok(r({ format: 'wav' }).kbps === 0, 'a lossless format has no bitrate');
     const lossless = r({ format: 'wav', ceiling: -1 }), lossy = r({ format: 'mp3', ceiling: -1 });
     ok(lossless.effective === -1 && lossy.effective === -2, 'a lossy file is mastered a decibel under its ceiling, a lossless one to it');
     ok(r({ target: -40, ceiling: 3 }).target === -24 && r({ target: 0, ceiling: -50 }).ceiling === -6, 'the loudness and the ceiling are kept in range');
     ok(r({ format: 'wav', bits: 16 }).dither === 'tpdf' && r({ dither: 'shaped' }).dither === 'shaped', 'dither is flat unless shaped is asked for');
     const d = run(`Deliver.DESTINATIONS`);
     ok(d.length >= 5 && d.every((x) => x.target >= -24 && x.target <= -8 && x.ceiling <= -0.5 && x.id && x.note), 'every destination is a loudness, a ceiling and a sentence');
     ok(run(`Deliver.DESTINATIONS.every((d) => { const r = Deliver.resolve(d); return r.format === d.format && r.rate === d.rate && (!d.bits || r.bits === d.bits) && (!d.kbps || r.kbps === d.kbps); })`),
       'every destination is a delivery its own format can actually make');
     ok(run(`Deliver.destination('streaming').target`) === -14 && run(`Deliver.destination('broadcast').target`) === -23, 'streaming is −14 LUFS and broadcast is EBU R128’s −23');
     ok(run(`Deliver.loudnessWord(-14)`) === 'Streaming' && run(`Deliver.loudnessWord(-13)`) === '', 'a loudness worth a word is named; one between is not');
     const wav = run(`Deliver.estimate(100, Deliver.resolve({ format: 'wav', bits: 24, rate: 48000 }))`), flac = run(`Deliver.estimate(100, Deliver.resolve({ format: 'flac', bits: 24, rate: 48000 }))`);
     near(wav, 100 * 48000 * 6, 1, 'a 24-bit stereo WAV is 6 bytes a frame');
     ok(flac < wav && flac > wav * 0.4, 'a FLAC is estimated as smaller');
     near(run(`Deliver.estimate(100, Deliver.resolve({ format: 'mp3', kbps: 256 }))`), 256000 * 100 / 8, 1, 'an MP3 is its bitrate');
     ok(run(`Deliver.fileBase('KRSTVM', 83.4, 'E♭ Dorian')`) === 'sigil-KRSTVM-83bpm-Eb-Dorian', 'a file is named for the sigil, the tempo and the key');
     ok(run(`Deliver.fileBase('A+B', 0, '')`) === 'sigil-A+B', 'a name without a tempo or a key has neither');
     ok(run(`Deliver.clock(298.4)`) === '4:58' && run(`Deliver.clock(3725)`) === '1:02:05', 'times read as m:ss');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      2 · THE END OF A FILE
      ═══════════════════════════════════════════════════════════════════════ */
   await group('§2 · the end of a render', () => {
     const sr = 44100;
     const m = music(sr, 12, { tail: 3 });                     // 9 s of sound, then a decay at 60 dB a second
     G.m = m;
     const end = run(`Deliver.soundEnd(m.L, m.R, ${sr})`);
     ok(end < m.L.length && end > 9 * sr, 'the sound ends where the decay goes under −72 dBFS: the dead air after it is dropped', `${end / sr} s of 12`);
     const silent = { L: new Float32Array(sr), R: new Float32Array(sr) };
     G.silent = silent;
     ok(run(`Deliver.soundEnd(silent.L, silent.R, ${sr})`) === sr, 'a silent file is not shortened');
     const t = run(`Deliver.tidy(m.L, m.R, ${sr}, {})`);
     ok(t.frames === end && t.L.length === end && t.dropped === m.L.length - end, 'tidy hands back views of the kept frames, and says how many it dropped');
     ok(t.L[t.L.length - 1] === 0 && t.R[t.R.length - 1] === 0, 'and the last sample is exactly zero: a file never ends on a step');
     let mx = 0;
     for (let i = 1; i < t.L.length; i++) mx = Math.max(mx, Math.abs(t.L[i] - t.L[i - 1]));
     ok(mx < 0.1, 'with no jump anywhere in it', `largest step ${mx}`);
     const m2 = music(sr, 6, { tail: 0 });                       // still sounding at the end
     G.m2 = m2;
     ok(run(`Deliver.fadeFor(m2.L, m2.R, m2.L.length, ${sr})`) === 4, 'a tail still sounding at its end is glided out over seconds');
     ok(run(`Deliver.fadeFor(silent.L, silent.R, silent.L.length, ${sr})`) === 0.3, 'one that has rung down to nothing needs a moment');
     const loud = Float32Array.from(m2.L);
     G.c2 = { L: Float32Array.from(loud), R: Float32Array.from(m2.R) };
     const t2 = run(`Deliver.tidy(c2.L, c2.R, ${sr}, { trim: false })`);
     near(t2.frames, m2.L.length, 0, 'with trimming off every frame is kept');
     ok(Math.abs(t2.L[t2.L.length - 1]) === 0 && Math.abs(t2.L[t2.L.length - 4 * sr]) > 0.001 && Math.abs(t2.L[t2.L.length - 2 * sr]) < Math.abs(m2.L[t2.L.length - 2 * sr]), 'and a tail that is still sounding is faded over its last four seconds');
     G.c3 = { L: Float32Array.from(m2.L), R: Float32Array.from(m2.R) };
     const t3 = run(`Deliver.tidy(c3.L, c3.R, ${sr}, { frames: 2 * ${sr} })`);
     ok(t3.frames === 2 * sr, 'a stem is cut to the length it is told, whatever it holds');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      3 · MEASUREMENT AND LANDING
      ═══════════════════════════════════════════════════════════════════════ */
   await group('§3 · the meter, and landing on a loudness', async () => {
     const sr = 48000;
     // BS.1770: a 997 Hz sine at −20 dBFS in both channels reads −20.0 LUFS (the K-weighting is +0.7 dB up there, and two channels add 3 dB, less the 0.691 offset)
     const n = sr * 10, sine = (db) => { const L = new Float32Array(n), a = Math.pow(10, db / 20); for (let i = 0; i < n; i++) L[i] = a * Math.sin(2 * Math.PI * 997 * i / sr); return { L, R: Float32Array.from(L) }; };
     const s20 = G.s20 = sine(-20);
     const a = run(`Deliver.analyse(s20.L, s20.R, ${sr})`);
     near(a.lufs, -20, 0.1, 'a 997 Hz sine at −20 dBFS, in both channels, reads −20 LUFS');
     near(a.peak, -20, 0.05, 'its sample peak is −20 dBFS');
     near(a.truePeak, -20, 0.1, 'and its true peak');
     near(a.corr, 1, 1e-6, 'identical channels correlate fully');
     near(a.mono, 0, 0.01, 'and lose nothing in a mono fold-down');
     near(a.range, 0, 0.05, 'a steady tone has no loudness range');
     G.anti = { L: s20.L, R: Float32Array.from(s20.L, (x) => -x) };
     const b = run(`Deliver.analyse(anti.L, anti.R, ${sr})`);
     ok(b.corr < -0.999 && b.mono < -60, 'opposite channels correlate at −1 and vanish when summed to mono');
     G.wide = (() => { const L = new Float32Array(n), R = new Float32Array(n); let s = 3; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; for (let i = 0; i < n; i++) { L[i] = 0.1 * r(); R[i] = 0.1 * r(); } return { L, R }; })();
     const w = run(`Deliver.analyse(wide.L, wide.R, ${sr})`);
     near(w.mono, -3.01, 0.15, 'two unrelated channels lose 3 dB in a mono fold-down');
     near(w.corr, 0, 0.02, 'and do not correlate');
     // independent meter
     if (HAVE_FFMPEG) {
       const dir = mkdtempSync(join(tmpdir(), 'sigil-')), m = music(sr, 20, { level: 0.2 });
       G.mm = m;
       const blob = await run(`Codecs.encode(Deliver.resolve({ format: 'wav', bits: 32, rate: ${sr} }), { L: mm.L, R: mm.R, sr: ${sr} }, {})`);
       writeFileSync(join(dir, 'm.wav'), await bytesOf(blob));
       const out = spawnSync('ffmpeg', ['-nostats', '-i', join(dir, 'm.wav'), '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
       const I = +/I:\s+(-?[\d.]+) LUFS/.exec(out.split('Summary:')[1])[1], P = +/Peak:\s+(-?[\d.]+) dBFS/.exec(out.split('Summary:')[1])[1];
       const mine = run(`Deliver.analyse(mm.L, mm.R, ${sr})`);
       near(mine.lufs, I, 0.1, `the meter agrees with ffmpeg’s EBU R128 meter (${I} LUFS)`);
       near(mine.truePeak, P, 0.15, `and so does the true peak (${P} dBTP)`);
     }
   
     // landing
     const land = (db, target, ceiling, o = {}) => {
       G.x = sine(db); G.o = { target, ceiling, ...o };
       return run(`(() => { const r = Deliver.land(x.L, x.R, ${sr}, o); return { r, after: Deliver.analyse(x.L, x.R, ${sr}) }; })()`);
     };
     let l = land(-15.2, -14, -1);
     near(l.after.lufs, -14, 0.05, 'a file a decibel under is brought to the loudness asked for, measured again');
     near(l.r.gain, 1.2, 0.06, 'by one linear gain');
     l = land(-13.3, -14, -1);
     near(l.after.lufs, -14, 0.05, 'and one over is brought down');
     l = land(-14.01, -14, -1);
     ok(l.r.gain === 0, 'a file already there is left exactly as it is');
     // the ceiling: asked for more than the peaks allow, it goes as far as they do
     const c1 = (() => { G.x = sine(-2.2); G.o = { target: 0, ceiling: -1 }; return run(`(() => { const r = Deliver.land(x.L, x.R, ${sr}, o); return { r, tp: Deliver.analyse(x.L, x.R, ${sr}).truePeak }; })()`); })();
     ok(c1.tp <= -1 + 0.05 && c1.r.limited, 'it is never turned up past the ceiling; and it says so', JSON.stringify(c1.r.gain) + ' ' + c1.tp);
     const c2 = (() => { G.x = sine(0.5); G.o = { target: -14, ceiling: -1 }; return run(`(() => { const r = Deliver.land(x.L, x.R, ${sr}, o); return Deliver.analyse(x.L, x.R, ${sr}).truePeak; })()`); })();
     ok(c2 <= -1 + 0.05, 'a file over the ceiling is brought under it');
     l = land(-40, -14, -1, { maxUp: 1.5 });
     near(l.r.gain, 1.5, 1e-9, 'it moves no more than it is allowed: a plan that missed by that much has something wrong, and is told, not covered up');
     const z = run(`(() => { const L = new Float32Array(1000), R = new Float32Array(1000); return Deliver.land(L, R, ${sr}, { target: -14, ceiling: -1 }).gain; })()`);
     ok(z === 0, 'silence is left alone');
     const j = run(`Deliver.judge({ lufs: -14.2, truePeak: -1.3, range: 4, mono: -0.3 }, { target: -14, ceiling: -1 })`);
     ok(j.length === 4 && j.every((x) => x.ok), 'a file on target is judged well on all four counts');
     const bad = run(`Deliver.judge({ lufs: -12.9, truePeak: -0.2, range: 4, mono: -9 }, { target: -14, ceiling: -1 })`);
     ok(bad.filter((x) => !x.ok).map((x) => x.key).join() === 'lufs,peak,mono', 'one too loud, over its ceiling and losing in mono is judged badly on those three');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      4 · THE BITS
      ═══════════════════════════════════════════════════════════════════════ */
   await group('§4 · quantising', () => {
     const sr = 44100, n = sr * 4;
     const x = new Float32Array(n);
     for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin(2 * Math.PI * 1000 * i / sr);
     G.x = x;
     const q = (bits, o) => run(`Deliver.quantise(x, ${bits}, ${JSON.stringify(o)})`);
     const a = q(16, { dither: 'tpdf', seed: 1 }), b = q(16, { dither: 'tpdf', seed: 1 }), c = q(16, { dither: 'tpdf', seed: 2 });
     ok(a.every((v, i) => v === b[i]), 'dither is seeded: the same render is the same file');
     ok(a.some((v, i) => v !== c[i]), 'and another seed is another noise');
     // the error: rounding alone is ±½ LSB; TPDF is a triangle of ±1 plus the rounding: variance 1/6 + 1/12 = 1/4 LSB²
     const err = (bits, y) => { let s = 0, mx = 0, mean = 0; for (let i = 0; i < n; i++) { const e = y[i] - x[i] * Math.pow(2, bits - 1); s += e * e; mean += e; mx = Math.max(mx, Math.abs(e)); } return { ms: s / n, mean: mean / n, mx }; };
     const off = err(16, q(16, { dither: 'off' })), tp = err(16, a);
     ok(off.mx <= 0.5 + 1e-9 && Math.abs(off.ms - 1 / 12) < 0.01, 'no dither: the error is within half a step, a twelfth of a step squared', JSON.stringify(off));
     ok(tp.mx <= 1.5 + 1e-9 && Math.abs(tp.ms - 0.25) < 0.02 && Math.abs(tp.mean) < 0.02, 'TPDF: the error is a quarter of a step squared, and has no mean', JSON.stringify(tp));
     // the noise has no relation to the signal: correlation of the error with the signal is nil
     let cs = 0, ss = 0, ee = 0; { const y = a; for (let i = 0; i < n; i++) { const e = y[i] - x[i] * 32768; cs += e * x[i]; ss += x[i] * x[i]; ee += e * e; } }
     ok(Math.abs(cs / Math.sqrt(ss * ee)) < 0.01, 'and the error is not related to the signal: noise, not distortion');
     // shaped: the noise under 6 kHz is lower than flat, above 12 kHz higher
     const band = (y, f0, f1) => {
       const N = 4096; let e = 0, frames = 0;
       for (let at = 0; at + N <= n; at += N * 4) {
         const seg = new Float64Array(N); for (let i = 0; i < N; i++) seg[i] = (y[at + i] - x[at + i] * 32768) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
         for (let k = Math.floor(f0 * N / sr); k < Math.floor(f1 * N / sr); k++) { let re = 0, im = 0; for (let i = 0; i < N; i += 1) { const ph = 2 * Math.PI * k * i / N; re += seg[i] * Math.cos(ph); im -= seg[i] * Math.sin(ph); } e += re * re + im * im; }
         frames++; if (frames >= 3) break;
       }
       return 10 * Math.log10(e / frames / (f1 - f0));
     };
     const sh = q(16, { dither: 'shaped', seed: 1, rate: sr });
     ok(band(sh, 2000, 5000) < band(a, 2000, 5000) - 8, 'shaped dither: the noise where the ear is most sensitive (2–5 kHz) is far lower than flat');
     ok(band(sh, 16000, 20000) > band(a, 16000, 20000) + 6, 'and it is higher up where the ear hardly hears it');
     // silence stays silent, and clipping does not overflow
     G.z = new Float32Array(1000);
     ok(run(`Deliver.quantise(z, 16, { dither: 'tpdf' })`).every((v) => v === 0) && run(`Deliver.quantise(z, 16, { dither: 'shaped' })`).every((v) => v === 0), 'digital silence is left silent: a file does not hiss where nothing plays');
     G.h = Float32Array.from([2, -2, 1, -1, 0.5]);
     const hot = run(`Deliver.quantise(h, 16, { dither: 'tpdf', seed: 5 })`), hot24 = run(`Deliver.quantise(h, 24, {})`);
     ok(hot[0] === 32767 && hot[1] === -32768 && hot24[0] === 8388607 && hot24[1] === -8388608, 'a sample over full scale is held at it, in 16 and in 24 bits');
     ok(run(`Deliver.quantise(h, 24, { dither: 'tpdf' })`).every((v, i) => v === hot24[i]), 'a 24-bit word is never dithered');
     ok(run(`Deliver.quantise(h, 16, { dither: 'shaped', seed: 1, rate: 44100 })`).every((v) => v >= -32768 && v <= 32767), 'shaped dither, fed full scale, cannot overflow a word');
     ok(a.constructor.name === 'Int32Array' && q(24, {})[5] === Math.round(x[5] * 8388608), 'quantising a channel gives its integers');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      5 · EVERY WRITER WRITES WHAT A READER READS
      ═══════════════════════════════════════════════════════════════════════ */
   /** A FLAC decoder for what the writer writes (constant, verbatim and fixed subframes), checking each frame's CRCs. */
   function decodeFlac(u8) {
     const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
     const txt = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
     if (txt(0, 4) !== 'fLaC') throw new Error('no fLaC');
     let o = 4, last = false, info = null; const tags = [];
     while (!last) {
       const h = u8[o]; last = !!(h & 0x80); const type = h & 127, len = (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]; o += 4;
       if (type === 0) {
         const hi = dv.getUint32(o + 10);
         info = { min: dv.getUint16(o), max: dv.getUint16(o + 2), rate: hi >>> 12, ch: ((hi >> 9) & 7) + 1, bits: ((hi >> 4) & 31) + 1, total: (hi & 15) * 4294967296 + dv.getUint32(o + 14), md5: Buffer.from(u8.subarray(o + 18, o + 34)).toString('hex') };
       } else if (type === 4) {
         let p = o; const vl = dv.getUint32(p, true); p += 4 + vl; const cnt = dv.getUint32(p, true); p += 4;
         for (let i = 0; i < cnt; i++) { const l = dv.getUint32(p, true); tags.push(new TextDecoder().decode(u8.subarray(p + 4, p + 4 + l))); p += 4 + l; }
       }
       o += len;
     }
     const out = [new Int32Array(info.total), new Int32Array(info.total)];
     let at = 0, frames = 0;
     const crc8 = (b) => { let c = 0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 7) & 255 : (c << 1) & 255; } return c; };
     const crc16 = (b) => { let c = 0; for (const x of b) { c ^= x << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; } return c; };
     while (o < u8.length) {
       const f0 = o;
       let bp = o * 8;
       const rd = (n) => { let v = 0; while (n > 0) { const free = 8 - (bp & 7), take = Math.min(n, free); v = v * (1 << take) + ((u8[bp >> 3] >> (free - take)) & ((1 << take) - 1)); bp += take; n -= take; } return v; };
       const rs = (n) => { const v = rd(n); return v >= Math.pow(2, n - 1) ? v - Math.pow(2, n) : v; };
       if (rd(14) !== 0x3ffe) throw new Error('lost sync at ' + o);
       rd(2); const bsc = rd(4), src = rd(4), asg = rd(4), szc = rd(3); rd(1);
       let first = rd(8); if (first >= 0xc0) { const extra = first >= 0xfc ? 5 : first >= 0xf8 ? 4 : first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : 1; for (let i = 0; i < extra; i++) rd(8); }
       const n = bsc === 12 ? 4096 : bsc === 7 ? rd(16) + 1 : bsc === 6 ? rd(8) + 1 : NaN;
       if (!Number.isFinite(n)) throw new Error('block size code ' + bsc);
       const h8 = rd(8);
       if (crc8(u8.subarray(f0, (bp >> 3) - 1)) !== h8) throw new Error('header CRC at frame ' + frames);
       const bps = szc === 4 ? 16 : szc === 6 ? 24 : info.bits, chs = [];
       for (let c = 0; c < 2; c++) {
         const b = bps + ((asg === 8 && c === 1) || (asg === 9 && c === 0) || (asg === 10 && c === 1) ? 1 : 0);
         rd(1); const type = rd(6); rd(1);
         const x = new Int32Array(n);
         if (type === 0) { const v = rs(b); x.fill(v); }
         else if (type === 1) { for (let i = 0; i < n; i++) x[i] = rs(b); }
         else if (type >= 8 && type <= 12) {
           const ord = type - 8; for (let i = 0; i < ord; i++) x[i] = rs(b);
           const method = rd(2), po = rd(4), pbits = method === 0 ? 4 : 5, parts = 1 << po;
           for (let p = 0, i = ord; p < parts; p++) {
             const end = (p + 1) * (n >> po), k = rd(pbits);
             for (; i < end; i++) {
               let q = 0; while (rd(1) === 0) q++;
               const u = q * Math.pow(2, k) + (k ? rd(k) : 0), r = u % 2 ? -(u + 1) / 2 : u / 2;
               x[i] = ord === 0 ? r : ord === 1 ? r + x[i - 1] : ord === 2 ? r + 2 * x[i - 1] - x[i - 2]
                 : ord === 3 ? r + 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3] : r + 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
             }
           }
         } else throw new Error('subframe type ' + type);
         chs.push(x);
       }
       if (bp & 7) bp += 8 - (bp & 7);
       const end = bp >> 3, c16 = (u8[end] << 8) | u8[end + 1];
       if (crc16(u8.subarray(f0, end)) !== c16) throw new Error('frame CRC at frame ' + frames);
       o = end + 2;
       for (let i = 0; i < n; i++) {
         let l, r;
         if (asg === 1) { l = chs[0][i]; r = chs[1][i]; }
         else if (asg === 8) { l = chs[0][i]; r = l - chs[1][i]; }
         else if (asg === 9) { r = chs[1][i]; l = chs[0][i] + r; }
         else { const s = chs[1][i], m = (chs[0][i] * 2) | (s & 1); l = (m + s) >> 1; r = (m - s) >> 1; }
         out[0][at + i] = l; out[1][at + i] = r;
       }
       at += n; frames++;
     }
     return { info, tags, pcm: out, frames, samples: at };
   }
   const md5of = (pcm, bits) => {
     const B = (bits + 7) >> 3, n = pcm[0].length, buf = Buffer.alloc(n * 2 * B);
     let o = 0; for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) { const v = pcm[c][i]; for (let b = 0; b < B; b++) buf[o++] = (v >> (8 * b)) & 255; }
     return createHash('md5').update(buf).digest('hex');
   };
   
   await group('§5 · the writers, read back', async () => {
     const sr = 44100, m = music(sr, 3, { tail: 0.5 });
     G.m = m; G.meta = { title: 'Tést · ‹1›', artist: 'Me', album: 'A', comment: 'a comment', bpm: 83, software: 'SIGIL' };
     const enc = async (o) => bytesOf(await run(`Codecs.encode(Deliver.resolve(${JSON.stringify(o)}), { L: m.L, R: m.R, sr: ${sr} }, meta)`));
   
     // WAV
     for (const bits of [16, 24, 32]) {
       const u = await enc({ format: 'wav', bits, rate: sr }), dv = new DataView(u.buffer), txt = (o, n) => String.fromCharCode(...u.subarray(o, o + n));
       ok(txt(0, 4) === 'RIFF' && txt(8, 4) === 'WAVE' && dv.getUint32(4, true) === u.length - 8, `WAV ${bits}: RIFF sizes add up`);
       let o = 12, fmt = null, data = null, info = null;
       while (o + 8 <= u.length) { const id = txt(o, 4), len = dv.getUint32(o + 4, true); if (id === 'fmt ') fmt = o + 8; if (id === 'data') data = [o + 8, len]; if (id === 'LIST') info = txt(o + 8, 4) === 'INFO' ? [o + 12, o + 8 + len] : null; o += 8 + len + (len & 1); }
       ok(dv.getUint16(fmt, true) === (bits === 32 ? 3 : 1) && dv.getUint16(fmt + 2, true) === 2 && dv.getUint32(fmt + 4, true) === sr && dv.getUint16(fmt + 14, true) === bits, `WAV ${bits}: the format chunk says ${bits === 32 ? 'float' : 'PCM'}, stereo, ${sr} Hz, ${bits} bits`);
       ok(data[1] === m.L.length * 2 * (bits / 8), `WAV ${bits}: a frame is ${bits / 4} bytes`);
       // samples: what is read is what was quantised
       const at = 44100, Bb = bits / 8, p = data[0] + at * 2 * Bb;
       const want = bits === 32 ? m.L[at] : Math.round(m.L[at] * Math.pow(2, bits - 1));
       const got = bits === 16 ? dv.getInt16(p, true) : bits === 24 ? ((u[p] | (u[p + 1] << 8) | (u[p + 2] << 16)) << 8) >> 8 : dv.getFloat32(p, true);
       ok(bits === 32 ? got === want : Math.abs(got - want) <= 1, `WAV ${bits}: the samples are the mix (to a dither step)`, `${got} vs ${want}`);
       const tags = new TextDecoder().decode(u.subarray(info[0], info[1]));
       ok(tags.includes('INAM') && tags.includes('Tést') && tags.includes('IART') && tags.includes('SIGIL'), `WAV ${bits}: the tags are in a LIST/INFO chunk`);
     }
     // the same render is the same file
     const w1 = await enc({ format: 'wav', bits: 16, rate: sr }), w2 = await enc({ format: 'wav', bits: 16, rate: sr });
     ok(Buffer.from(w1).equals(Buffer.from(w2)), 'WAV 16: the same render is the same file, byte for byte');
   
     // FLAC
     for (const bits of [16, 24]) {
       const u = await enc({ format: 'flac', bits, rate: sr }), d = decodeFlac(u);
       ok(d.info.rate === sr && d.info.ch === 2 && d.info.bits === bits && d.info.total === m.L.length, `FLAC ${bits}: the stream info says ${sr} Hz, stereo, ${bits} bits, ${m.L.length} samples`);
       ok(d.samples === m.L.length && d.frames === Math.ceil(m.L.length / 4096), `FLAC ${bits}: ${d.frames} frames, every header and frame CRC right`);
       const q = run(`Deliver.quantise(m.L, ${bits}, { dither: 'tpdf', seed: 0x5161, rate: ${sr} })`);
       ok(q.every((v, i) => v === d.pcm[0][i]), `FLAC ${bits}: it decodes to exactly the integers that were quantised`);
       ok(d.info.md5 === md5of(d.pcm, bits), `FLAC ${bits}: the MD5 of the audio is right`);
       ok(d.info.min > 0 && d.info.max >= d.info.min, `FLAC ${bits}: the frame sizes are in the stream info`);
       ok(d.tags.includes('TITLE=Tést · ‹1›') && d.tags.includes('BPM=83') && d.tags.includes('ARTIST=Me'), `FLAC ${bits}: the tags are Vorbis comments`);
     }
     const wav24 = await enc({ format: 'wav', bits: 24, rate: sr }), fl24 = await enc({ format: 'flac', bits: 24, rate: sr });
     G.pcm24 = [run(`Deliver.quantise(m.L, 24, {})`), run(`Deliver.quantise(m.R, 24, {})`)];
     ok(Buffer.from(await bytesOf(run(`Codecs.flac(pcm24, ${sr}, 24, meta)`))).equals(Buffer.from(await bytesOf(await run(`Codecs.flacAsync(pcm24, ${sr}, 24, meta, () => {})`)))), 'FLAC in slices (the page is given back between them) is the same file as FLAC at once');
     let stopped = false;
     try { await run(`Codecs.flacAsync(pcm24, ${sr}, 24, meta, () => {}, () => true)`); } catch (e) { stopped = e.message === 'cancelled'; }
     ok(stopped, 'and it leaves when asked to');
     ok(fl24.length < wav24.length * 0.8, 'FLAC is a good deal smaller than WAV', `${fl24.length} vs ${wav24.length}`);
     // hard cases: one sample, odd lengths, full scale noise, silence, an anti-phase pair, a constant
     const cases = { one: [1, () => 0.3], short: [17, (i) => Math.sin(i)], odd: [4097, (i) => Math.sin(i * 0.3) * 0.8], noise: [9000, () => Math.random() * 2 - 1], silence: [5000, () => 0], square: [9000, (i) => (i % 50 < 25 ? 1 : -1)] };
     for (const [name, [len, f]] of Object.entries(cases)) {
       const L = new Float32Array(len), R = new Float32Array(len);
       for (let i = 0; i < len; i++) { L[i] = f(i); R[i] = name === 'noise' ? Math.random() * 2 - 1 : name === 'square' ? -L[i] : f(i + 2); }
       G.L = L; G.R = R;
       for (const bits of [16, 24]) {
         const u = await bytesOf(await run(`Codecs.encode(Deliver.resolve({ format: 'flac', bits: ${bits}, rate: 48000 }), { L, R, sr: 48000 }, {})`)), d = decodeFlac(u);
         const qq = run(`Deliver.quantise(R, ${bits}, { dither: 'tpdf', seed: 0x5162, rate: 48000 })`);
         ok(d.samples === len && qq.every((v, i) => v === d.pcm[1][i]) && d.info.md5 === md5of(d.pcm, bits), `FLAC ${bits}, ${name} (${len} samples): decodes exactly`);
       }
     }
   
     // ZIP
     const zip = await bytesOf(await run(`Codecs.zip([{ name: 'a/é.txt', data: 'hello' }, { name: 'b.bin', data: new Uint8Array([1, 2, 3, 4, 5]) }, { name: 'c.wav', data: new Blob([new Uint8Array(1000).fill(7)]) }])`));
     const zv = new DataView(zip.buffer), eocd = zip.length - 22;
     ok(zv.getUint32(eocd, true) === 0x06054b50 && zv.getUint16(eocd + 10, true) === 3, 'ZIP: three entries, and the end record where it should be');
     let cd = zv.getUint32(eocd + 16, true); const crcOf = (b) => { let c = ~0 >>> 0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
     const names = []; let goodCrc = true, stored = true;
     for (let i = 0; i < 3; i++) {
       const nl = zv.getUint16(cd + 28, true), off = zv.getUint32(cd + 42, true), size = zv.getUint32(cd + 24, true), crc = zv.getUint32(cd + 16, true);
       names.push(new TextDecoder().decode(zip.subarray(cd + 46, cd + 46 + nl)));
       const lnl = zv.getUint16(off + 26, true), body = zip.subarray(off + 30 + lnl, off + 30 + lnl + size);
       goodCrc = goodCrc && crcOf(body) === crc && zv.getUint32(off, true) === 0x04034b50; stored = stored && zv.getUint16(off + 8, true) === 0;
       cd += 46 + nl;
     }
     ok(names.join() === 'a/é.txt,b.bin,c.wav' && goodCrc && stored, 'ZIP: names in UTF-8, stored, every CRC-32 right');
     if (HAVE_FFMPEG || spawnSync('unzip', ['-v']).status === 0) {
       const dir = mkdtempSync(join(tmpdir(), 'sigil-')); writeFileSync(join(dir, 'x.zip'), zip);
       const t = spawnSync('unzip', ['-t', join(dir, 'x.zip')], { encoding: 'utf8' });
       if (t.status !== null && !t.error) ok(t.status === 0, 'ZIP: unzip -t is satisfied', t.stdout);
     }
   
     // ID3
     const id3 = await bytesOf(new Blob([run(`Codecs.id3(meta)`)]));
     const size = (id3[6] << 21) | (id3[7] << 14) | (id3[8] << 7) | id3[9];
     ok(String.fromCharCode(...id3.subarray(0, 3)) === 'ID3' && id3[3] === 3 && size === id3.length - 10, 'ID3v2.3: the header and its syncsafe size');
     const frames = []; for (let o = 10; o < id3.length;) { const id = String.fromCharCode(...id3.subarray(o, o + 4)), len = new DataView(id3.buffer).getUint32(o + 4); frames.push(id); o += 10 + len; }
     ok(frames.join() === 'TIT2,TPE1,TALB,TBPM,TSSE,COMM', 'ID3: title, artist, album, tempo, encoder and comment frames', frames.join());
     ok(run(`Codecs.id3({}).length`) === 0, 'ID3: no tags, no header');
   
     // M4A: parse the boxes of an MP4 built from synthetic access units
     const packets = Array.from({ length: 50 }, (_, i) => ({ data: new Uint8Array(100 + i).fill(i + 1), samples: 1024 }));
     G.packets = packets;
     const mp4 = await bytesOf(run(`Codecs.mp4(packets, Codecs.audioSpecificConfig(44100, 2), 44100, meta)`));
     const box = (u, o) => { const dv = new DataView(u.buffer, u.byteOffset); return { type: String.fromCharCode(...u.subarray(o + 4, o + 8)), size: dv.getUint32(o), at: o }; };
     const top = []; for (let o = 0; o < mp4.length;) { const b = box(mp4, o); top.push(b); o += b.size; }
     ok(top.map((b) => b.type).join() === 'ftyp,moov,mdat', 'M4A: ftyp, moov, then mdat: a player can begin at once');
     const find = (u, from, to, path) => { for (let o = from; o < to;) { const b = box(u, o); if (b.type === path[0]) return path.length === 1 ? b : find(u, b.at + (b.type === 'meta' ? 12 : b.type === 'stsd' ? 16 : 8), b.at + b.size, path.slice(1)); o += b.size; if (b.size === 0) break; } return null; };
     const moov = top[1], stsz = find(mp4, moov.at + 8, moov.at + moov.size, ['trak', 'mdia', 'minf', 'stbl', 'stsz']), stco = find(mp4, moov.at + 8, moov.at + moov.size, ['trak', 'mdia', 'minf', 'stbl', 'stco']);
     const mv = new DataView(mp4.buffer);
     ok(mv.getUint32(stsz.at + 16) === 50, 'M4A: the sample table counts every access unit');
     let tot = 0; for (let i = 0; i < 50; i++) tot += mv.getUint32(stsz.at + 20 + 4 * i);
     ok(tot === top[2].size - 8 && mv.getUint32(stco.at + 16) === top[2].at + 8, 'M4A: the sizes add up to the mdat, and the chunk offset is where the audio is');
     ok(find(mp4, moov.at + 8, moov.at + moov.size, ['udta', 'meta', 'ilst']) !== null, 'M4A: tags in an ilst');
     ok(new TextDecoder('latin1').decode(mp4).includes('\u00a9nam'), 'M4A: the title atom is ©nam, one byte for the ©');
     ok(Buffer.from(run(`Codecs.audioSpecificConfig(44100, 2)`)).toString('hex') === '1210' && Buffer.from(run(`Codecs.audioSpecificConfig(48000, 2)`)).toString('hex') === '1190', 'M4A: AAC-LC, stereo, at 44.1 and 48 kHz');
   
     // Ogg Opus
     const opk = Array.from({ length: 120 }, (_, i) => ({ data: new Uint8Array(40 + (i % 7) * 60).fill(i + 1), samples: 960 }));
     G.opk = opk;
     const og = await bytesOf(run(`Codecs.muxOggOpus(opk, null, 960 * 120, meta)`)), og2 = await bytesOf(run(`Codecs.muxOggOpus(opk, null, 960 * 120, meta)`));
     ok(Buffer.from(og).equals(Buffer.from(og2)), 'Opus: the same packets are the same file (the stream serial is not random)');
     let pages = 0, crcOk = true, lastGran = 0, packetsRead = 0, cur = 0;
     const oggCrc = (b) => { let c = 0; for (const x of b) { c ^= x << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0; } return c >>> 0; };
     for (let o = 0; o < og.length;) {
       const nseg = og[o + 26], body = og.subarray(o + 27, o + 27 + nseg).reduce((s, x) => s + x, 0), len = 27 + nseg + body;
       const page = Uint8Array.from(og.subarray(o, o + len)), stored = new DataView(page.buffer).getUint32(22, true); page.fill(0, 22, 26);
       crcOk = crcOk && oggCrc(page) === stored && String.fromCharCode(...page.subarray(0, 4)) === 'OggS';
       lastGran = new DataView(page.buffer).getUint32(6, true);
       for (let s = 0; s < nseg; s++) { cur += og[o + 27 + s]; if (og[o + 27 + s] < 255) { packetsRead++; cur = 0; } }
       pages++; o += len;
     }
     ok(crcOk && pages > 3, 'Opus: every page has its capture pattern and a right CRC');
     ok(packetsRead === 122, 'Opus: a header, the tags, and every packet', String(packetsRead));
     near(lastGran, 312 + 960 * 120, 0, 'Opus: the last granule position trims the encoder’s padding (the file is as long as what went in)');
     ok(new TextDecoder().decode(og).includes('TITLE=Tést') && new TextDecoder().decode(og).includes('BPM=83'), 'Opus: the tags are Vorbis comments');
   
     // an independent reader, for all of them
     if (HAVE_FFMPEG) {
       const dir = mkdtempSync(join(tmpdir(), 'sigil-'));
       const probe = (fn, extra = '') => JSON.parse(execSync(`ffprobe -v error -print_format json -show_streams -show_format ${extra} "${fn}"`).toString());
       for (const [name, u] of [['wav16.wav', await enc({ format: 'wav', bits: 16, rate: sr })], ['wav24.wav', wav24], ['wav32.wav', await enc({ format: 'wav', bits: 32, rate: sr })], ['x.flac', fl24]]) {
         writeFileSync(join(dir, name), u);
         const t = spawnSync('ffmpeg', ['-v', 'error', '-err_detect', '+crccheck+explode', '-i', join(dir, name), '-f', 'null', '-'], { encoding: 'utf8' });
         ok(t.status === 0 && !t.stderr.trim(), `ffmpeg decodes ${name} without complaint`, t.stderr.slice(0, 200));
       }
       const pw = probe(join(dir, 'wav24.wav')), pf = probe(join(dir, 'x.flac'));
       ok(pw.format.tags.title === 'Tést · ‹1›' && pw.format.tags.artist === 'Me', 'ffprobe reads the WAV’s tags');
       ok(pf.format.tags.TITLE === 'Tést · ‹1›' && pf.format.tags.BPM === '83', 'and the FLAC’s');
       // the decoded FLAC is the decoded WAV
       const a = execSync(`ffmpeg -v error -i "${join(dir, 'wav24.wav')}" -f s32le -`, { maxBuffer: 1 << 28 }), b = execSync(`ffmpeg -v error -i "${join(dir, 'x.flac')}" -f s32le -`, { maxBuffer: 1 << 28 });
       ok(a.equals(b), 'ffmpeg decodes the FLAC to exactly the samples of the WAV');
   
       // the browser's encoders are not here, but ffmpeg's are: real AAC and Opus packets, through the writers, and back
       const parts = (fn) => { const b = readFileSync(fn); return b; };
       const aacFile = join(dir, 'src.aac'), opusFile = join(dir, 'src.opus'), mono = '-f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" -f lavfi -i "sine=frequency=660:duration=3:sample_rate=44100" -filter_complex "[0][1]amerge=inputs=2"';
       execSync(`ffmpeg -y -v error ${mono} -c:a aac -b:a 192k -f adts "${aacFile}"`);
       execSync(`ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=3:sample_rate=48000" -ac 2 -c:a libopus -b:a 160k "${opusFile}"`);
       const adts = readFileSync(aacFile), aacPackets = []; let asc = null;
       for (let o = 0; o + 7 <= adts.length;) {
         const hl = (adts[o + 1] & 1) ? 7 : 9, len = ((adts[o + 3] & 3) << 11) | (adts[o + 4] << 3) | (adts[o + 5] >> 5);
         if (!asc) { const aot = ((adts[o + 2] >> 6) & 3) + 1, sfi = (adts[o + 2] >> 2) & 15, ch = ((adts[o + 2] & 1) << 2) | (adts[o + 3] >> 6); asc = Uint8Array.from([(aot << 3) | (sfi >> 1), ((sfi & 1) << 7) | (ch << 3)]); }
         aacPackets.push({ data: new Uint8Array(adts.subarray(o + hl, o + len)), samples: 1024 }); o += len;
       }
       G.rp = aacPackets; G.rasc = asc;
       ok(Buffer.from(asc).equals(Buffer.from(run(`Codecs.audioSpecificConfig(44100, 2)`))), 'the AudioSpecificConfig we would write is the one ffmpeg’s encoder wrote');
       // an encoder that hands back ADTS-framed units: the headers come off, and the config is read from the first
       G.framed = []; for (let o = 0; o + 7 <= adts.length;) { const len = ((adts[o + 3] & 3) << 11) | (adts[o + 4] << 3) | (adts[o + 5] >> 5); G.framed.push({ data: new Uint8Array(adts.subarray(o, o + len)), samples: 1024 }); o += len; }
       const un = run(`Codecs.unadts(framed)`);
       ok(un && Buffer.from(un.asc).equals(Buffer.from(asc)) && un.packets.length === aacPackets.length && un.packets.every((p, i) => Buffer.from(p.data).equals(Buffer.from(aacPackets[i].data))), 'ADTS-framed units are stripped to the access units, and the AudioSpecificConfig read from their header');
       ok(run(`Codecs.unadts([{ data: new Uint8Array([1, 2, 3]) }])`) === null, 'and raw units are left as they are');
       writeFileSync(join(dir, 'real.m4a'), await bytesOf(run(`Codecs.mp4(rp, rasc, 44100, meta)`)));
       const t1 = spawnSync('ffmpeg', ['-v', 'error', '-err_detect', '+crccheck+explode', '-i', join(dir, 'real.m4a'), '-f', 's16le', join(dir, 'm4a.raw')], { encoding: 'utf8' });
       execSync(`ffmpeg -y -v error -i "${aacFile}" -f s16le "${join(dir, 'adts.raw')}"`);
       ok(t1.status === 0 && !t1.stderr.trim() && readFileSync(join(dir, 'm4a.raw')).equals(readFileSync(join(dir, 'adts.raw'))), 'real AAC access units in our M4A decode to exactly what the ADTS stream decodes to');
       const pm = probe(join(dir, 'real.m4a'));
       ok(pm.streams[0].codec_name === 'aac' && pm.streams[0].profile === 'LC' && pm.format.tags.title === 'Tést · ‹1›' && pm.format.tags.artist === 'Me' && Math.abs(pm.format.duration - 3.04) < 0.05, 'and ffprobe sees AAC-LC, the tags and the length');
       const oggIn = readFileSync(opusFile), opk2 = []; let cur2 = [];
       for (let o = 0; o < oggIn.length;) {
         const nseg = oggIn[o + 26]; let p = o + 27 + nseg;
         for (let s = 0; s < nseg; s++) { const l = oggIn[o + 27 + s]; cur2.push(oggIn.subarray(p, p + l)); p += l; if (l < 255) { opk2.push(Buffer.concat(cur2)); cur2 = []; } }
         o = p;
       }
       G.op = opk2.slice(2).map((d) => ({ data: new Uint8Array(d), samples: 960 })); G.odesc = new Uint8Array(opk2[0]);
       writeFileSync(join(dir, 'real.opus'), await bytesOf(run(`Codecs.muxOggOpus(op, odesc, 48000 * 3, meta)`)));
       const t2 = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'real.opus'), '-f', 's16le', join(dir, 'opus.raw')], { encoding: 'utf8' });
       execSync(`ffmpeg -y -v error -i "${opusFile}" -f s16le "${join(dir, 'opus0.raw')}"`);
       const po = probe(join(dir, 'real.opus'), '-show_entries stream_tags');
       ok(t2.status === 0 && !t2.stderr.trim() && Math.abs(readFileSync(join(dir, 'opus.raw')).length - readFileSync(join(dir, 'opus0.raw')).length) <= 4 * 960, 'real Opus packets in our Ogg decode, to the length of the original');
       ok(po.streams[0].tags.TITLE === 'Tést · ‹1›' && po.streams[0].tags.BPM === '83', 'with their tags');
     }
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      6 · STEMS, AND THE LISTENING OVER ALL THE PASSES
      ═══════════════════════════════════════════════════════════════════════ */
   await group('§6 · stems and passes', () => {
     const plan = `{ on: true, p: Float64Array.from(SigilDSP.MASTER_REST), trim: new Float64Array(10).fill(1), sec: new Float64Array(9).fill(1), report: { mixPeak: -7.5 } }`;
     const MA = run(`SigilDSP.MA`);
     const down = run(`(() => { const pl = ${plan}; pl.report.mixPeak = 2; return Mastering.table(pl, true).p[SigilDSP.MA.OUT]; })()`);
     near(down, -3.5, 1e-9, 'stems of a mix that peaks over full scale are all turned down to fit, by one gain (1.5 dB of room)');
     const quiet = run(`Mastering.table(${plan}, true).p[SigilDSP.MA.OUT]`);
     ok(quiet === 0, 'as mixed, stems of a quiet mix are left where they are: a stem is never turned up unasked');
     near(run(`Mastering.table(${plan}, { lift: true, room: 1.5 }).p[SigilDSP.MA.OUT]`), 6, 1e-9, 'raised together, they are all turned up by the room the mix has (−7.5 peak → −1.5: +6 dB)');
     ok(run(`(() => { const pl = ${plan}; pl.report.mixPeak = -60; return Mastering.table(pl, { lift: true }).p[SigilDSP.MA.OUT]; })()`) === 18, 'but never by more than 18 dB, for a mix that is nearly nothing');
     ok(run(`Mastering.table(${plan}, false).p[SigilDSP.MA.STEM]`) === 0 && run(`Mastering.table(${plan}, { lift: true }).p[SigilDSP.MA.STEM]`) === 1, 'a track is not a stem; a stem leaves before the chain');
     ok(run(`Mastering.table(null, true)`) === null, 'no plan, no table: the mix leaves as the engine made it');
     // the core honours a gain up as well as down
     const gain = (out) => run(`(() => { const c = new SigilDSP.Core(48000, { warm: false }), p = Float64Array.from(SigilDSP.MASTER_REST); p[SigilDSP.MA.ON] = 1; p[SigilDSP.MA.STEM] = 1; p[SigilDSP.MA.OUT] = ${out};
       c.command({ type: 'master', p, trim: new Float64Array(10).fill(1), sec: new Float64Array(3).fill(1), snap: true }); return c.ms.stemG; })()`);
     near(gain(6), Math.pow(10, 0.3), 1e-9, 'the core lifts a stem by the gain it is given');
     near(gain(-6), Math.pow(10, -0.3), 1e-9, 'and lowers it');
     near(gain(40), Math.pow(10, 24 / 20), 1e-9, 'within ±24 dB');
   
     // pass B hears every pass
     const job = `{ total: 200, bpm: 83, passes: PASSES, nSec: 7, sections: new Float64Array(7 * SigilDSP.PSTRIDE), events: new Float64Array(0), count: 0, levels: {}, params: { reverb: 0.85 } }`;
     const heard = (p) => run(`Mastering.heardOf(Object.assign(${job.replace('PASSES', p)}, {}))`);
     near(heard(1), 200 * 60 / 83 + run('Mastering.TAIL'), 1e-9, 'the listening of one pass is the pass and its ring-out');
     near(heard(3), 3 * 200 * 60 / 83 + run('Mastering.TAIL'), 1e-9, 'a render of three passes is listened to through all three');
     const pj = (p) => run(`(() => { const j = ${job.replace('PASSES', 4)}; const k = Mastering.probeJob(j, {}, null, ${p}); return [k.passes, k.sr, +k.params.holdK.toFixed(4)]; })()`);
     ok(pj(3).join() === '3,32000,0.7256' && pj(0)[0] === 1, 'the probe job has the passes it is given (one, if none), at the listening rate, with the crushers’ hold kept in time');
     ok(run(`Mastering.keyOf(${job.replace('PASSES', 1)}, {})`) === run(`Mastering.keyOf(${job.replace('PASSES', 4)}, {})`), 'the parts (pass A) are the same whatever the number of passes: heard once');
     // how evolved each pass is, as the core reads it
     const ev = run(`Deliver.evolved(4, 0.5)`);
     ok(ev[0] === 0 && ev[1] > 0.28 && ev[1] < 0.3 && ev[1] < ev[2] && ev[2] < ev[3] && ev[3] < 0.5, 'each pass is further evolved than the last, none more than the Evolution asked for; the first is the rite as written');
     ok(run(`Deliver.evolved(3, 0).every((x) => x === 0)`), 'with Evolution at zero every pass is the first again');
     near(run(`Deliver.tailOf({ reverb: { rt60: 2.27 } })`), 9.54, 0.01, 'the tail is the hall twice over and five seconds for what is left ringing');
     ok(run(`Deliver.tailOf({ reverb: { rt60: 0.1 } })`) === 8 && run(`Deliver.tailOf({ reverb: { rt60: 9 } })`) === 14, 'between 8 and 14 seconds');
   });
   
   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
   