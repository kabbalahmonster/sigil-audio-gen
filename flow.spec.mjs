/* ══════════════════════════════════════════════════════════════════════════
   FLOW SPEC — the passes of a rite are one piece: 05i (where the body is) and the DSP core (what each
   pass plays, and how the layers gather over the passes). No browser, no dependencies.

     node tests/flow.spec.mjs            everything (about half a minute)
     node tests/flow.spec.mjs --quick    skip the audio render

   What it defends
     1. The body of every rite is found: its opener heard once at the start, its ending once at the end,
        and nothing between them fades. A rite too short to have a body is left as it is.
     2. The core plays what it is told: pass 1 from the start to the end of the body, the middle passes the
        body alone, the last pass to the ending; the stage (which never finishes) goes round the body; a
        listener who walks into the ending hears it. Every beat is played exactly once where it should be.
     3. With no body (or Flow off) the core is the core it was: every pass the whole rite.
     4. The layers gather: the arpeggio and the choir are held back at first by what Evolution asks for,
        come up over the passes, and are all there on the last; at Evolution zero, or for one pass, nothing
        is held back at all.
     5. Rendered, the seam between two passes has no hole in it (the old seam did).
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/core/05e-master.js', 'src/core/05f-style.js', 'src/core/05g-rite.js', 'src/core/05i-flow.js', 'src/core/06b-compiler.js'];
   const QUICK = process.argv.includes('--quick');
   
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
   function group(name, fn) { console.log(`\n${name}`); try { fn(); } catch (e) { ok(false, `${name}: threw`, String((e && e.stack) || e)); } }
   
   const run = fresh();
   
   /* ═══════════════════════════════════════════════════════════════════════
      1 · THE BODY OF A RITE
      ═══════════════════════════════════════════════════════════════════════ */
   group('§1 · where the body is', () => {
     run(`Hooks.on('plan', (plan, cfg) => Rite.open(cfg), -30);
          Hooks.on('plan', (plan, cfg) => { Style.plan(plan, cfg); }, 20);
          Hooks.on('plan', (plan, cfg) => { Rite.seal(plan, cfg); }, 60);
          globalThis.songOf = (rite, word) => { const off = Hooks.on('compose', (cfg) => { cfg.rite = rite; }, -50); const s = composeSong(buildSigil(word || 'TSMYWLFNHBK')); off(); return s; };`);
     const sev = run(`(() => { const s = songOf('sevenfold'); const L = Flow.loop(s); return { L, total: s.total, secs: s.sections.map((x) => [x.id, x.start, x.end]) }; })()`);
     ok(sev.L.lo === 16 && sev.L.hi === 176 && sev.total === 200, 'the Sevenfold: the Invocation is the opening, the Banishing the ending, and the five between are the body', JSON.stringify(sev.L));
     const all = run(`Object.keys(Rite.RITES).map((r) => { const s = songOf(r), L = Flow.loop(s), S = s.sections; return { r, L, total: s.total, n: S.length, first: S[0].role || S[0].id, firstI: S[0].intensity, firstEnd: S[0].end, lastStart: S[S.length - 1].start, ends: S[S.length - 1].ends || '' }; })`);
     for (const x of all) {
       const opener = x.first === 'intro' && !(x.firstI > 0);
       const want = x.L ? { lo: opener ? x.firstEnd : 0, hi: x.lastStart } : null;
       ok(x.L && x.L.lo === want.lo && x.L.hi === want.hi && x.L.hi - x.L.lo >= 32 && x.L.hi < x.total,
         `${x.r}: ${x.L ? `the body is beats ${x.L.lo}–${x.L.hi} of ${x.total}${opener ? ' (its opening heard once)' : ''}${x.ends === 'struck' ? ' (its crown is the ending)' : ''}` : 'no body'}`, JSON.stringify(x));
     }
     ok(run(`Flow.loop({ sections: [{ id: 'a', start: 0, end: 16 }, { id: 'b', start: 16, end: 40, final: true }], total: 40 })`) === null, 'a rite of two sections has no body');
     ok(run(`Flow.loop({ sections: [{ id: 'intro', start: 0, end: 16, intensity: 0 }, { id: 'a', start: 16, end: 32 }, { id: 'z', start: 32, end: 56, final: true }], total: 56 })`) === null, 'and one whose body is under two phrases is left whole');
     ok(run(`Flow.loop({ sections: [{ id: 'a', start: 0, end: 32 }, { id: 'b', start: 32, end: 64 }, { id: 'z', start: 64, end: 88 }], total: 88 })`) === null, 'a rite that marks no ending is left whole');
     ok(run(`Flow.loop({ sections: [{ id: 'a', start: 0, end: 32, intensity: 1, role: 'verse1' }, { id: 'b', start: 32, end: 64 }, { id: 'z', start: 64, end: 88, final: true }], total: 88 })`).lo === 0, 'a first section that is not an opener is part of the body');
     ok(run(`Flow.loop({ sections: [{ id: 'intro', start: 0, end: 16, intensity: 2 }, { id: 'b', start: 16, end: 64 }, { id: 'z', start: 64, end: 88, final: true }], total: 88 })`).lo === 0, 'and neither is an “intro” that is loud');
     ok(run(`Flow.enabled()`) === true, 'flow is on unless it has been turned off');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      2 · WHAT THE CORE PLAYS
      ═══════════════════════════════════════════════════════════════════════ */
   group('§2 · what each pass plays', () => {
     const r = (c) => run(c);
     ok(r(`JSON.stringify([0, 1, 2].map((p) => SigilDSP.passSpan(200, { lo: 16, hi: 176 }, 3, p)))`) === '[[0,176],[16,176],[16,200]]', 'three passes: [0, body end), the body, [body start, the ending’s end)');
     ok(r(`JSON.stringify([0, 1].map((p) => SigilDSP.passSpan(200, { lo: 16, hi: 176 }, 2, p)))`) === '[[0,176],[16,200]]', 'two passes: the opening and the body, then the body and the ending');
     ok(r(`JSON.stringify(SigilDSP.passSpan(200, { lo: 16, hi: 176 }, 1, 0))`) === '[0,200]', 'one pass is the whole rite');
     ok(r(`JSON.stringify([0, 1, 5].map((p) => SigilDSP.passSpan(200, { lo: 16, hi: 176 }, 0, p)))`) === '[[0,176],[16,176],[16,176]]', 'the stage (no last pass) goes round the body for ever');
     ok(r(`JSON.stringify([0, 1].map((p) => SigilDSP.passSpan(200, null, 2, p)))`) === '[[0,200],[0,200]]', 'with no body every pass is the whole rite, as it was');
     ok(r(`SigilDSP.beatsOf(200, { lo: 16, hi: 176 }, 3)`) === 176 + 160 + 184 && r(`SigilDSP.beatsOf(200, null, 3)`) === 600 && r(`SigilDSP.beatsOf(200, { lo: 16, hi: 176 }, 1)`) === 200, 'how long passes last, in beats');
     const at = (s) => r(`JSON.stringify(SigilDSP.locate({ bpm: 60, total: 200, passes: 3, loop: { lo: 16, hi: 176 } }, ${s}))`);
     ok(at(0) === '{"pass":0,"beat":0}' && at(175) === '{"pass":0,"beat":175}' && at(176) === '{"pass":1,"beat":16}' && at(176 + 159) === '{"pass":1,"beat":175}' && at(176 + 160) === '{"pass":2,"beat":16}' && at(176 + 160 + 183) === '{"pass":2,"beat":199}' && JSON.parse(at(520)).pass === 3, 'a time in a render is a pass and a beat');
     ok(r(`JSON.stringify(SigilDSP.locate({ bpm: 60, total: 200, passes: 2, loop: null }, 250))`) === '{"pass":1,"beat":50}', 'and without a body, as before');
   
     // a core, and a marker at every beat
     run(`globalThis.play = (o) => {
       const n = 200, E = new Float64Array(n * SigilDSP.STRIDE);
       for (let i = 0; i < n; i++) { const q = i * SigilDSP.STRIDE; E[q] = i; E[q + SigilDSP.EV.KIND] = SigilDSP.KIND.BELL; E[q + SigilDSP.EV.BUS] = SigilDSP.BUS.bell; E[q + SigilDSP.EV.F] = 440; E[q + SigilDSP.EV.DUR] = 0.5; E[q + SigilDSP.EV.VEL] = 0.01; E[q + SigilDSP.EV.SEED] = i + 1; }
       const c = new SigilDSP.Core(8000, { warm: false }), log = [], segs = [];
       c.spawn = (src, q) => { log.push([c.pass, src[q]]); };
       c.onTransport = (t, beat, bps, lo, hi, pass, reg) => segs.push([+beat.toFixed(2), lo, hi, pass]);
       c.command({ type: 'plan', events: E, count: n, total: n, bpm: 60 * 8, passes: o.passes, nSec: 0, loop: o.loop });
       c.command({ type: 'play', beat: o.from || 0, pass: o.pass || 0 });
       const bl = new Float32Array(128), br = new Float32Array(128);
       for (let b = 0; b < (o.blocks || 20000) && c.playing; b++) {
         if (o.at && b === o.at[0]) o.at[1](c);
         c.blockTime = (b * 128) / 8000; c.process(bl, br, 128);
       }
       return { log, segs, playing: c.playing, pass: c.pass, beat: c.beat };
     };`);
     // bpm 480 = 8 beats a second = one beat per 1000 samples at 8 kHz; 200 beats is 25 s: 1563 blocks a pass
     const L3 = `{ lo: 16, hi: 176 }`;
     const three = run(`(() => { const r = play({ passes: 3, loop: ${L3}, blocks: 6000 }); const by = [[], [], []]; for (const [p, b] of r.log) by[p].push(b); return { playing: r.playing, n: by.map((a) => a.length), first: by.map((a) => a[0]), last: by.map((a) => a[a.length - 1]), once: by.map((a) => a.every((b, i) => i === 0 || b === a[i - 1] + 1)), segs: r.segs.map((s) => s.slice(1)) }; })()`);
     ok(three.n.join() === '176,160,184' && three.first.join() === '0,16,16' && three.last.join() === '175,175,199', 'three passes: 176 beats from the start, the 160 of the body, the body and the ending: 184', JSON.stringify(three));
     ok(three.once.every(Boolean), 'and every beat of them is played exactly once, in order, with no beat twice at a seam');
     ok(three.playing === false, 'the last pass ends the performance');
     ok(JSON.stringify(three.segs.filter((s, i, a) => i === 0 || a[i - 1].join() !== s.join()).slice(0, 3)) === '[[0,176,0],[16,176,1],[16,200,2]]', 'and the transport tells the page the span of each pass as it begins', JSON.stringify(three.segs));
     const stage = run(`(() => { const r = play({ passes: 0, loop: ${L3}, blocks: 5200 }); const by = {}; for (const [p, b] of r.log) (by[p] = by[p] || []).push(b); return { playing: r.playing, passes: Object.keys(by).length, lens: Object.values(by).map((a) => a.length + ':' + a[0] + '-' + a[a.length - 1]) }; })()`);
     ok(stage.playing && stage.lens.slice(0, 3).join() === '176:0-175,160:16-175,160:16-175', 'the stage goes on for ever: the opening and the body once, then the body, round and round (the ending is never reached)', JSON.stringify(stage));
     const walked = run(`(() => { const r = play({ passes: 0, loop: ${L3}, blocks: 4200, from: 100, at: [200, (c) => c.command({ type: 'seek', beat: 180 })] }); const p0 = r.log.filter(([p]) => p === 0).map(([, b]) => b), p1 = r.log.filter(([p]) => p === 1).map(([, b]) => b);
       return { ending: p0.filter((b) => b >= 176).join() === Array.from({ length: 24 }, (_, i) => 176 + i).join() || p0.filter((b) => b >= 180).join() === Array.from({ length: 20 }, (_, i) => 180 + i).join(), next: p1[0] + '-' + p1[p1.length - 1] }; })()`);
     ok(walked.ending && walked.next === '16-175', 'a listener who walks into the ending (a click on the form list) is played the ending, and then the rite goes on round, into the body', JSON.stringify(walked));
     const whole = run(`(() => { const r = play({ passes: 2, loop: null, blocks: 4000 }); const by = [[], []]; for (const [p, b] of r.log) by[p].push(b); return by.map((a) => a.length + ':' + a[0] + '-' + a[a.length - 1]); })()`);
     ok(whole.join() === '200:0-199,200:0-199', 'with no body the passes are the whole rite, as they always were', JSON.stringify(whole));
     const bad = run(`(() => { const r = play({ passes: 2, loop: { lo: 150, hi: 120 }, blocks: 4000 }); return r.log.length; })()`);
     ok(bad === 400, 'a body that makes no sense is ignored');
     const reg = run(`(() => { const c = new SigilDSP.Core(8000, { warm: false }); c.command({ type: 'plan', events: new Float64Array(0), count: 0, total: 200, bpm: 480, passes: 0, nSec: 0, loop: ${L3} }); c.command({ type: 'region', start: 48, end: 80 }); c.command({ type: 'play', beat: 50, pass: 0 });
       const bl = new Float32Array(128), br = new Float32Array(128); let wraps = 0, last = c.beat; for (let b = 0; b < 3000; b++) { c.blockTime = b * 128 / 8000; c.process(bl, br, 128); if (c.beat < last) wraps++; last = c.beat; } return { wraps, pass: c.pass, inside: c.beat >= 48 && c.beat < 80 }; })()`);
     ok(reg.wraps >= 1 && reg.pass === 0 && reg.inside, 'a looped section (Form & Loop) is still a loop, and not a new pass');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      3 · THE LAYERS GATHER
      ═══════════════════════════════════════════════════════════════════════ */
   group('§3 · gathering', () => {
     run(`globalThis.held = (o) => { const c = new SigilDSP.Core(8000, { warm: false }); c.command({ type: 'plan', events: new Float64Array(0), count: 0, total: 200, bpm: 120, passes: o.passes, nSec: 0 });
       c.command({ type: 'params', evolve: o.evolve, pass0: o.pass0 || 0 }); c.command({ type: 'play', beat: 0, pass: o.pass }); return Array.from(c.pgT, (x) => +x.toFixed(4)); }`);
     const at = (passes, pass, evolve, pass0) => run(`held({ passes: ${passes}, pass: ${pass}, evolve: ${evolve}, pass0: ${pass0 || 0} })`);
     const arp = 5, harm = 1, drone = 7, lead = 0;
     const seq = [0, 1, 2, 3].map((p) => at(0, p, 0.5));
     ok(seq[0][arp] < 0.7 && seq[0][harm] < 0.75 && seq[0][drone] < 0.9, 'the arpeggio, the choir and the drone are held back on the first pass by what Evolution asks for', JSON.stringify(seq[0]));
     ok(seq[0][lead] === 1 && seq[0][3] === 1 && seq[0][4] === 1 && seq[0][6] === 1 && seq[0][2] === 1, 'and the lead, the pad, the bass, the kit and the bells are not');
     ok(seq[1][arp] > seq[0][arp] && seq[2][arp] > seq[1][arp] && seq[3][arp] > seq[2][arp] && seq[3][arp] > 0.95 && seq[3][harm] > 0.95, 'they come up over the passes, and are nearly all there by the fourth');
     const fin = at(3, 2, 0.5);
     ok(fin.every((x) => x === 1), 'and on the last pass of a render every part is all there');
     ok(at(3, 0, 0.5)[arp] < 0.7 && at(3, 1, 0.5)[arp] > at(3, 0, 0.5)[arp] && at(3, 1, 0.5)[arp] < 1, 'the passes before it gather');
     ok(at(1, 0, 0.5).every((x) => x === 1), 'one pass alone is never held back: it is the rite as written');
     ok(at(0, 0, 0).every((x) => x === 1) && at(4, 0, 0).every((x) => x === 1), 'at Evolution zero nothing is held back, on the stage or in a render: every pass is the first');
     ok(at(0, 0, 1)[arp] < at(0, 0, 0.5)[arp] && Math.abs(at(0, 0, 1)[arp] - 0.3) < 1e-3, 'more Evolution holds more back, to a third of the arpeggio at the most');
     ok(at(0, 1, 0.5, 0)[arp] === at(0, 0, 0.5, 1)[arp], 'a render that begins further on (pass0) is as far on as the stage would be');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      4 · THE SEAM, RENDERED
      ═══════════════════════════════════════════════════════════════════════ */
   if (!QUICK) group('§4 · the seam, rendered', () => {
     run(`globalThis.render = (flow, passes) => {
       const sig = buildSigil('TSMYWLFNHBK'), song = Groove.apply(composeSong(sig), sig, {}), spec = SigilPlan.defaultSpec(sig, song);
       const job = SigilPlan.renderJob(song, sig, { sr: 8000, spb: song.spb, passes, lens: false, spec, flow });
       const secs = (SigilDSP.beatsOf(job.total, job.loop, passes)) * 60 / job.bpm;
       const r = SigilDSP.renderRange(job, 0, secs, 0);
       return { L: r.L, sr: 8000, job, secs, song };
     };
     globalThis.level = (L, sr, t0, t1) => { let e = 0, n = 0; for (let i = Math.round(t0 * sr); i < Math.round(t1 * sr) && i < L.length; i++) { e += L[i] * L[i]; n++; } return 10 * Math.log10(e / Math.max(1, n) + 1e-12); };`);
     const info = run(`(() => { const a = render(true, 2), b = render(false, 2); return { flowLoop: a.job.loop, len: a.secs, wholeLen: b.secs, total: a.job.total, spb: a.song.spb,
       // the level in the half-minute before the end of a pass and the half-minute after it, in 3 s slices: the lowest of them, and the typical one
       seam: (r, at) => 0 }; })()`);
     const out = run(`(() => {
       const slices = (r, at) => { const v = []; for (let t = at - 30; t < at + 30; t += 3) v.push(level(r.L, r.sr, t, t + 3)); return v; };
       const a = render(true, 2), b = render(false, 2), spb = a.song.spb;
       const sa = slices(a, a.job.loop.hi * spb), sb = slices(b, a.song.total * spb), spread = (v) => Math.max(...v) - Math.min(...v);
       return { flowLen: a.secs, wholeLen: b.secs, flow: spread(sa), whole: spread(sb) };
     })()`);
     ok(out.flowLen < out.wholeLen - 10, 'two passes that flow are shorter than two that do not: the opening and the ending are not sung twice', `${out.flowLen.toFixed(1)} s against ${out.wholeLen.toFixed(1)} s`);
     ok(out.flow + 1.5 < out.whole, 'and in the half-minute either side of the seam the level moves less than it did: the Banishing, the air and the Invocation are not there to dip into', `flow ${out.flow.toFixed(1)} dB, whole ${out.whole.toFixed(1)} dB between the loudest 3 s and the quietest`);
     ok(out.flow < 6, 'and never by much: a verse after a chorus, not nothing', `${out.flow.toFixed(1)} dB`);
   });
   
   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
   