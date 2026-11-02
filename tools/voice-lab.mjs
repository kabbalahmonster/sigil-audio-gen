/* ══════════════════════════════════════════════════════════════════════════
   VOICE LAB — the palette's instruments, heard by a program.
   --------------------------------------------------------------------------
   Shared by tools/calibrate-voices.mjs (which measures how loud each instrument is, in each part, against the cube's
   own voice of that part) and tests/voices.spec.mjs (which defends them). No browser.

     compile  a song is composed and compiled in a vm sandbox (where the core's Math is slow, and it does not matter:
              compiling is not rendering);
     render   the core runs in THIS context, where Math is as fast as a browser's, so that what is measured (and how
              long it takes) is a fair account of the real thing.
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext, runInThisContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const SCORE = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05k-fills.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/dsp/sigil-voices.js', 'src/core/05e-master.js', 'src/core/05f-style.js', 'src/core/05g-rite.js',
     'src/core/05i-flow.js', 'src/core/05j-palette.js', 'src/core/05h-deliver.js', 'src/core/06b-compiler.js'];
   const SCORE_EXTRA = [];
   
   /** The sandbox that composes and compiles (slow Math, and that is all right). */
   export function scoreSandbox(extra = []) {
     const sb = { TextEncoder, btoa, atob, console, performance, setTimeout, clearTimeout };
     sb.window = sb; sb.globalThis = sb;
     const ctx = createContext(sb);
     for (const f of [...SCORE, ...extra]) runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
     const run = (c) => runInContext(c, ctx);
     run.sb = sb;
     run(`Hooks.on('plan', (plan, cfg) => Rite.open(cfg), -30); Hooks.on('plan', (plan, cfg) => { Style.plan(plan, cfg); }, 20); Hooks.on('plan', (plan, cfg) => { Rite.seal(plan, cfg); }, 60);`);
     return run;
   }
   
   /** The core, in this context: fast Math. */
   export function bootCore() {
     if (!globalThis.SigilDSP) for (const f of ['src/dsp/sigil-dsp.js', 'src/dsp/sigil-voices.js']) runInThisContext(readFileSync(join(root, f), 'utf8'), { filename: f });
     return globalThis.SigilDSP;
   }
   
   /** Copy a plain-data object out of the sandbox into this realm. */
   export const realm = (x) => (x == null ? x : ArrayBuffer.isView(x) ? new x.constructor(x) : Array.isArray(x) ? x.map(realm)
     : typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, realm(v)])) : x);
   
   /** Words that compose into songs of different keys, speeds and shapes. */
   export const WORDS = ['TSMYWLFNHBK', 'PCNDQTVRMZ', 'BRKCHNSLGD', 'HMTRKLSPWQ', 'GFDVBNZXJC', 'MQWRTYPLKS'];
   
   export function meanLU(m) { return m.lufs; }
   
   /**
    * The notes of a part in a song: what the part plays in a real song, or, for the parts a song has no notes for in every
    * idiom (a second voice, the chords, the percussion), a figure the song's own pad and beat make for it.
    */
   export const PART_JS = `
   globalThis.__partEvents = function (song, role) {
     const ev = song.events, out = [];
     const chords = ev.filter((e) => e.type === 'pad'), N = song.total;
     switch (role) {
       case 'lead': return ev.filter((e) => e.type === 'lead' && !e.part);
       case 'alt': return ev.filter((e) => e.type === 'lead' && !e.part).map((e) => ({ ...e, part: 1 }));
       case 'harm': case 'bell': case 'bass': case 'arp': case 'pad': case 'drone': return ev.filter((e) => e.type === role);
       case 'comp':
         for (const p of chords) p.midis.forEach((m, j) => out.push({ beat: p.beat + j * 0.25, type: 'comp', midi: m + 12, dur: Math.min(p.dur, 1.5), vel: 0.6, voice: 'bell', bus: 'arp' }));
         return out;
       case 'tom': case 'perc': {
         for (let b = 0; b < N; b += 0.5) { const k = Math.round(b * 2); if (k % 8 === 0 || k % 8 === 3 || k % 8 === 5) out.push({ beat: b, type: role, [role === 'tom' ? 'tom' : 'pi']: (k >> 1) % 3, vel: 0.7 + 0.15 * ((k >> 2) & 1) }); }
         return out;
       }
       case 'rim': for (let b = 1; b < N; b += 2) out.push({ beat: b, type: 'rim', vel: 0.6 }); return out;
       case 'shaker': for (let b = 0; b < N; b += 0.5) out.push({ beat: b + (Math.round(b * 2) % 2 ? 0.02 : 0), type: 'shaker', vel: Math.round(b * 2) % 2 ? 0.4 : 0.62 }); return out;
     }
     return [];
   };`;
   
   /**
    * A job that plays one part of a song, as `id` plays it (id 0: as the cube does, the original voice), with no hall.
    * `opts`: { sr, spb, P (patch overrides) }
    */
   export function partJob(run, word, role, id, opts = {}) {
     const sr = opts.sr || 44100;
     return realm(run(`(() => {
       const sg = buildSigil(${JSON.stringify(word)}), song0 = composeSong(sg);
       const song = Object.assign({}, song0, { events: __partEvents(song0, ${JSON.stringify(role)}) });
       const spec = SigilPlan.defaultSpec(sg, song);
       ${id ? `spec.P = Object.assign({}, spec.P, { roles: { ${JSON.stringify(role)}: ${id | 0} } });` : ''}
       const j = SigilPlan.renderJob(song, sg, { sr: ${sr}, spb: song.spb, passes: 1, spec, palette: ${id ? 'true' : 'false'}, flow: false });
       j.params.reverb = 0; j.stride = SigilDSP.STRIDE;
       return j;
     })()`));
   }
   export function loadPartJs(run) { run(PART_JS); }
   
   /** Render [from, from+secs) of a job and measure it (in the sandbox, by the mastering module): { lufs, peak, L, R }. */
   export function listen(run, job, from, secs) {
     const D = bootCore();
     const r = D.renderRange(job, from, from + secs, from);
     let pk = 0;
     for (let i = 0; i < r.L.length; i++) { const a = Math.max(Math.abs(r.L[i]), Math.abs(r.R[i])); if (a > pk) pk = a; }
     run.sb.__L = r.L; run.sb.__R = r.R;
     const m = run(`Mastering.measure(__L, __R, ${job.sr})`);
     return { lufs: m.lufs, peak: pk, L: r.L, R: r.R, sr: job.sr };
   }
   
   /* ══ one note ═══════════════════════════════════════════════════════════════ */
   
   /** The instrument table an instrument has in a part, as the palette packs it for a sigil (and its engine's kind). */
   export function packed(run, id, role, word = WORDS[0]) {
     return realm(run(`(() => { const sg = buildSigil(${JSON.stringify(word)}), d = Palette.instrument(${id | 0}), t = new Float64Array(16 * 24);
       t.set(Palette.pack(d, sg, ${JSON.stringify(role)}, 0), Palette.SLOT[${JSON.stringify(role)}] * 24); return { table: t, kind: Palette.KIND_OF[d.engine], slot: Palette.SLOT[${JSON.stringify(role)}], engine: d.engine }; })()`));
   }
   
   /**
    * One note, through the real core (no master, no hall): the part's instrument in its slot.
    * o: { table, kind, slot, midi, vel, beats (its length), bpm, sr, secs, bus, damp (seconds to damp it once let go, as the part asks), row: {accent, vary, seed, pan}, sec: {section column: value} }
    */
   export function note(o) {
     const D = bootCore(), sr = o.sr || 44100, bpm = o.bpm || 120, secs = o.secs || 3;
     const c = new D.Core(sr, { warm: false });
     c.command({ type: 'inst', inst: o.table });
     const E = new Float64Array(D.STRIDE), row = o.row || {};
     E[D.EV.KIND] = o.kind; E[D.EV.BUS] = D.BUS[o.bus || 'lead']; E[D.EV.F] = 440 * Math.pow(2, ((o.midi ?? 60) - 69) / 12);
     E[D.EV.DUR] = o.beats ?? 2; E[D.EV.VEL] = o.vel ?? 0.8; E[D.EV.P0] = o.slot; E[D.EV.P1] = row.accent ?? 0.6; E[D.EV.P2] = row.vary ?? 0.3;
     E[D.EV.SEED] = row.seed ?? 12345; E[D.EV.PAN] = row.pan ?? 0; E[D.EV.P3] = o.damp || 0;
     const sections = new Float64Array(D.PSTRIDE); sections.set(D.DEFAULT_PATCH);
     for (const [k, v] of Object.entries(o.sec || {})) sections[D.PA[k]] = v;
     c.command({ type: 'plan', events: E, count: 1, sections, nSec: 1, total: 64, bpm, passes: 1 });
     c.command({ type: 'levels', levels: {}, snap: true });
     c.command({ type: 'params', reverb: 0 });
     c.command({ type: 'play', beat: 0, pass: 0 });
     c.snapFx();
     const blk = o.block || 128;
     const n = Math.round(secs * sr), L = new Float32Array(n), R = new Float32Array(n), dry = new Float32Array(n), bl = new Float32Array(128), br = new Float32Array(128);
     const bus = D.BUS[o.bus || 'lead'];
     let activeAt = -1;
     for (let p = 0; p < n; p += blk) {
       c.blockTime = p / sr; c.process(bl, br, blk);
       const B = c.bL[bus];
       for (let i = 0; i < blk && p + i < n; i++) { L[p + i] = bl[i]; R[p + i] = br[i]; dry[p + i] = B[i]; }
       if (c.act > 0) activeAt = p + blk;
     }
     // `dry`: the voice as the bus receives it, before any effect (which is what a click in the voice itself is heard in)
     return { L, R, dry, sr, endedAt: activeAt < 0 ? 0 : activeAt / sr, ended: c.act === 0 };
   }
   export function stats(x) {
     let pk = 0, e = 0, nan = 0, dc = 0;
     for (let i = 0; i < x.length; i++) { const a = x[i]; if (!Number.isFinite(a)) { nan++; continue; } pk = Math.max(pk, Math.abs(a)); e += a * a; dc += a; }
     return { peak: pk, rms: Math.sqrt(e / Math.max(1, x.length)), nan, dc: dc / Math.max(1, x.length) };
   }
   /** Fundamental by autocorrelation over a window (Hz), or 0. */
   export function pitch(x, sr, t0 = 0.2, t1 = 0.6, fmin = 40, fmax = 2200) {
     const a = Math.round(t0 * sr), n = Math.round((t1 - t0) * sr), lo = Math.floor(sr / fmax), hi = Math.ceil(sr / fmin);
     let r0 = 0; for (let i = 0; i < n; i++) r0 += x[a + i] * x[a + i];
     if (r0 < 1e-14) return 0;
     const r = new Float64Array(hi + 2); let mx = 0;
     for (let l = lo; l <= hi; l++) { let s = 0; for (let i = 0; i < n; i++) s += x[a + i] * x[a + i + l]; r[l] = s / r0; if (r[l] > mx) mx = r[l]; }
     let best = 0;
     for (let l = lo + 1; l < hi; l++) if (r[l] > r[l - 1] && r[l] >= r[l + 1] && r[l] > 0.8 * mx) { best = l; break; }
     if (!best) return 0;
     const y0 = r[best - 1], y1 = r[best], y2 = r[best + 1], d = (y0 - 2 * y1 + y2) ? 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) : 0;
     return sr / (best + d);
   }
   