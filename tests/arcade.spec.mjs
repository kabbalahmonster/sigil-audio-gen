/* ══════════════════════════════════════════════════════════════════════════
   ARCADE SPEC — the second sound engine: 05l (the macros, the arrangement), 06b (every part as one of four
   channels) and sigil-arcade.js (the channels). No browser, no dependencies.

     node tests/arcade.spec.mjs            everything (about half a minute)
     node tests/arcade.spec.mjs --quick    skip the song renders

   What it defends
     1. The cube is untouched: with the cube chosen, a song compiles to exactly the rows it did before the arcade existed.
     2. In the arcade every part, the kit included, is played by one of the machine's four channels, on the bus it always had.
     3. Every macro does what it says: scale density, complexity, swing, lead brightness, FM depth, pulse width, bass drive,
        drum density, noise decay, arpeggio rate and space.
     4. The patch carries the engine and the macros (a link, a library entry); Mutate never switches the engine.
     5. Every channel is finite, bounded, sounding, ends, is the same twice, and does not depend on where the blocks fall;
        a whole song in the arcade renders, deterministically.
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';

   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const BASE = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05k-fills.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/dsp/sigil-voices.js'];
   const REST = ['src/core/05e-master.js', 'src/core/05f-style.js', 'src/core/05g-rite.js', 'src/core/05i-flow.js', 'src/core/05j-palette.js'];
   const WITH = [...BASE, 'src/dsp/sigil-arcade.js', ...REST, 'src/core/05l-arcade.js', 'src/core/06b-compiler.js'];
   const WITHOUT = [...BASE, ...REST, 'src/core/06b-compiler.js'];
   const QUICK = process.argv.includes('--quick');

   function fresh(files) {
     const sandbox = { TextEncoder, btoa, atob, console, performance };
     sandbox.window = sandbox; sandbox.globalThis = sandbox;
     const ctx = createContext(sandbox);
     for (const f of files) runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
     return (code) => runInContext(code, ctx);
   }
   let pass = 0, fail = 0;
   const ok = (cond, label, detail) => {
     if (cond) { pass++; console.log(`  ✓ ${label}`); }
     else { fail++; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
   };
   function group(name, fn) { console.log(`\n${name}`); try { fn(); } catch (e) { ok(false, `${name}: threw`, String((e && e.stack) || e)); } }

   const run = fresh(WITH);
   const WORDS = ['KRSTVM', 'TSMYWLFNHBK', 'PLNGR', 'BRKDWN'];
   run(`globalThis.songOf = (w) => { const sig = buildSigil(w), song = composeSong(sig); Groove.apply(song, sig, {}); return { sig, song }; };
        globalThis.rowsOf = (w, over, opts) => { const { sig, song } = songOf(w); const spec = SigilPlan.defaultSpec(sig, song); Object.assign(spec.P, over || {});
          const p = SigilPlan.compile(song, sig, { spec, lens: false, flow: false, ...(opts || {}) }); const D = SigilDSP, out = [];
          for (let i = 0; i < p.count; i++) { const o = i * D.STRIDE; out.push(Array.from(p.events.subarray(o, o + D.STRIDE))); }
          return { rows: out, sections: Array.from(p.sections), song, sig, p }; };
        globalThis.K = SigilDSP.KIND; globalThis.B = SigilDSP.BUS; globalThis.E = SigilDSP.EV;`);
   const J = (c) => JSON.parse(run(`JSON.stringify(${c})`));

   /* ═══════════════════════════════════════════════════════════════════════
      1 · THE CUBE IS THE CUBE
      ═══════════════════════════════════════════════════════════════════════ */
   group('§1 · with the cube chosen, nothing has changed', () => {
     const without = fresh(WITHOUT);
     for (const w of WORDS) {
       const code = `(() => { const sig = buildSigil(${JSON.stringify(w)}), song = composeSong(sig); Groove.apply(song, sig, {});
         const spec = SigilPlan.defaultSpec(sig, song); const p = SigilPlan.compile(song, sig, { spec, lens: false, flow: false });
         let h = 2166136261; for (let i = 0; i < p.count * SigilDSP.STRIDE; i++) h = Math.imul(h ^ (Math.round(p.events[i] * 1000) | 0), 16777619);
         for (let i = 0; i < p.sections.length; i++) h = Math.imul(h ^ (Math.round(p.sections[i] * 1000) | 0), 16777619);
         return p.count + ':' + (h >>> 0); })()`;
       ok(run(code) === without(code), `${w}: the same rows and sections as a build without the arcade`);
     }
     ok(run(`SigilPlan.defaultSpec(buildSigil('KRSTVM'), composeSong(buildSigil('KRSTVM'))).P.engine`) === 0, 'a sigil is the cube’s unless its patch says otherwise');
     const asked = J(`(() => { const a = rowsOf('KRSTVM', { engine: 1 }, { arcade: false }), b = rowsOf('KRSTVM'); return [a.rows.length, b.rows.length, JSON.stringify(a.rows) === JSON.stringify(b.rows)]; })()`);
     ok(asked[2], 'and a compile told not to (arcade: false) is the cube’s, whatever the patch says');
   });

   /* ═══════════════════════════════════════════════════════════════════════
      2 · EVERY PART IS THE MACHINE'S
      ═══════════════════════════════════════════════════════════════════════ */
   group('§2 · in the arcade every part, the kit included, is one of four channels', () => {
     const kinds = J('[K.ARC_FM, K.ARC_PULSE, K.ARC_NOISE, K.ARC_ARP]');
     for (const w of WORDS) {
       const r = J(`(() => { const { rows } = rowsOf(${JSON.stringify(w)}, { engine: 1 }); const by = {}; for (const x of rows) { const k = x[E.KIND] & 255, b = x[E.BUS]; (by[k] = by[k] || new Set()).add(b); }
         return { n: rows.length, kinds: Object.keys(by).map(Number), buses: Object.fromEntries(Object.entries(by).map(([k, s]) => [k, [...s]])) }; })()`);
       ok(r.kinds.every((k) => kinds.includes(k)) && r.kinds.length === 4, `${w}: ${r.n} rows, every one of them an arcade channel`, JSON.stringify(r.kinds));
       const B = J('B');
       ok(r.buses[kinds[2]].includes(B.drums) && !r.buses[kinds[2]].some((b) => ![B.drums, B.bell].includes(b)), '   the noise channel plays the kit (and the crash and swell, on the bells’ bus as the cube’s do)');
       ok(r.buses[kinds[1]].every((b) => b === B.bass || b === B.drone), '   the pulse plays the bass and the drone');
       ok(r.buses[kinds[0]].every((b) => [B.lead, B.harm, B.bell].includes(b)), '   the FM plays the lead, the choir and the bells');
       ok(r.buses[kinds[3]].every((b) => [B.arp, B.pad, B.harm, B.lead, B.bell, B.drums].includes(b)) && r.buses[kinds[3]].includes(B.pad), '   and the chord channel the chords and the arpeggio');
     }
     const order = J(`(() => { const { rows } = rowsOf('KRSTVM', { engine: 1, aSwing: 0.8, aComplex: 1, aDrums: 1 }); return rows.every((x, i) => i === 0 || x[0] >= rows[i - 1][0]); })()`);
     ok(order, 'the rows are in order, however the macros move them');
     const chords = J(`(() => { const { rows } = rowsOf('KRSTVM', { engine: 1 }); const pads = rows.filter((x) => (x[E.KIND] & 255) === K.ARC_ARP && x[E.BUS] === B.pad); return pads.length ? pads.every((x) => x[E.P0] > 0 && x[E.P1] > 0) : false; })()`);
     ok(chords, 'a chord is one row: its notes are stepped through by the channel, not written as notes');
     const noPal = J(`(() => { const { p } = rowsOf('KRSTVM', { engine: 1 }); return [p.pal, p.inst, !!p.arcade]; })()`);
     ok(noPal[0] === null && noPal[1] === null && noPal[2], 'no palette is dealt and no instrument table sent: the machine needs neither');
     const turn = J(`(() => { const s = songOf('KRSTVM'); const spec = SigilPlan.defaultSpec(s.sig, s.song); spec.P.engine = 1; const p = SigilPlan.compile(s.song, s.sig, { spec, lens: false, flow: true });
       let w = 0; for (let i = 0; i < p.count; i++) if (p.events[i * SigilDSP.STRIDE + E.KIND] >= 256) w++; return [w, !!p.loop]; })()`);
     ok(!turn[1] || turn[0] > 0, 'the turnaround’s strokes keep their flag, so each pass plays the right ones', JSON.stringify(turn));
   });

   /* ═══════════════════════════════════════════════════════════════════════
      3 · THE MACROS
      ═══════════════════════════════════════════════════════════════════════ */
   group('§3 · every macro does what it says', () => {
     // scale density
     const pcs = (over) => J(`(() => { const { rows, song } = rowsOf('TSMYWLFNHBK', { engine: 1, ...${JSON.stringify(over)} }); const t = song.leadBase, set = new Set();
       for (const x of rows) if ((x[E.KIND] & 255) === K.ARC_FM && x[E.BUS] === B.lead) set.add(((Math.round(69 + 12 * Math.log2(x[E.F] / 440)) - t) % 12 + 12) % 12);
       return [...set].sort((a, b) => a - b); })()`);
     const scale = J(`songOf('TSMYWLFNHBK').song.scale`);
     const two = pcs({ aDensity: 0 }), five = pcs({ aDensity: 0.6 }), all = pcs({ aDensity: 1 });
     ok(two.every((p) => p === 0 || p === scale[4]), `scale density 0: the lead uses the tonic and the fifth only (${two})`);
     const pent = J(`Arcade.allowed(${JSON.stringify(scale)}, 0.6)`);
     ok(pent.length === 5 && five.every((p) => pent.includes(p)), `scale density at five: the mode’s pentatonic (${pent.sort((a, b) => a - b)}), the lead inside it (${five})`);
     ok(all.length > five.length && all.every((p) => scale.includes(p)), `full density: the mode as written (${all})`);
     ok(J(`Arcade.allowed([0, 2, 4, 5, 7, 9, 11], 0.6).sort((a, b) => a - b)`).join() === '0,2,4,7,9' && J(`Arcade.allowed([0, 2, 3, 5, 7, 8, 10], 0.6).sort((a, b) => a - b)`).join() === '0,3,5,7,10',
       'major’s five are the major pentatonic, minor’s the minor pentatonic');

     // complexity
     const count = (over, fn) => J(`(() => { const { rows } = rowsOf('KRSTVM', { engine: 1, ...${JSON.stringify(over)} }); return rows.filter((x) => ${fn}).length; })()`);
     const leadLo = count({ aComplex: 0 }, '(x[E.KIND] & 255) === K.ARC_FM'), leadMid = count({ aComplex: 0.5 }, '(x[E.KIND] & 255) === K.ARC_FM'), leadHi = count({ aComplex: 1 }, '(x[E.KIND] & 255) === K.ARC_FM');
     ok(leadLo < leadMid && leadMid < leadHi, `complexity: fewer ornaments at the left, the machine’s echo at the right (FM rows ${leadLo} · ${leadMid} · ${leadHi})`);
     const bassMid = count({ aComplex: 0.5 }, 'x[E.BUS] === B.bass'), bassHi = count({ aComplex: 1 }, 'x[E.BUS] === B.bass');
     ok(bassHi > bassMid, `and the bass bounces in octaves (${bassMid} → ${bassHi} notes)`);
     const same = J(`(() => { const a = rowsOf('KRSTVM', { engine: 1, aComplex: 0.5 }).rows, b = rowsOf('KRSTVM', { engine: 1 }).rows; return a.length === b.length; })()`);
     ok(same, 'at its middle it is the song as written');

     // swing
     const sw = J(`(() => { const s = songOf('KRSTVM').song; const ev = s.events.filter((e) => e.type === 'hat' || e.type === 'kick');
       const a = Arcade.arrange(ev, s, buildSigil('KRSTVM'), { aSwing: 1 }), m = new Map(); a.forEach((e, i) => m.set(i, e.beat));
       let beats = 0, offs = 0, moved = 0; ev.forEach((e, i) => { const x = e.beat % 1; if (x === 0) beats += a[i].beat === e.beat ? 1 : -1000; if (Math.abs(x - 0.5) < 1e-9) { offs++; if (Math.abs(a[i].beat - e.beat - 1 / 6) < 1e-9) moved++; } });
       return { beats: beats > 0, offs, moved, mono: [0, 0.1, 0.25, 0.49, 0.5, 0.75, 0.99].map((x) => Arcade.swingAt(x, 0.7)).every((v, i, arr) => i === 0 || v > arr[i - 1]) }; })()`);
     ok(sw.beats && sw.offs > 0 && sw.moved === sw.offs, `swing: the beats stay, every off-beat eighth falls a sixth of a beat late at full swing (${sw.moved}/${sw.offs})`);
     ok(sw.mono, 'and it never puts two notes out of order');

     // lead brightness → the section's BRIGHT; FM depth → the index
     const br = J(`(() => { const a = rowsOf('KRSTVM', { engine: 1, aBright: 0.1 }), b = rowsOf('KRSTVM', { engine: 1, aBright: 0.9 }), P = SigilDSP.PA, S = SigilDSP.PSTRIDE;
       return [a.sections[P.BRIGHT], b.sections[P.BRIGHT], a.sections[P.CHORUS], a.sections[P.GRIT]]; })()`);
     ok(br[0] < br[1] && br[2] === 0 && br[3] === 0, `lead brightness is the section’s BRIGHT (${br[0].toFixed(2)} → ${br[1].toFixed(2)}), with none of the cube’s chorus or crusher`);
     const fmd = (v) => J(`rowsOf('KRSTVM', { engine: 1, aFm: ${v} }).rows.find((x) => (x[E.KIND] & 255) === K.ARC_FM && x[E.BUS] === B.lead)[E.P1]`);
     ok(fmd(0) < fmd(1), `FM depth is the modulator’s index (${fmd(0).toFixed(2)} → ${fmd(1).toFixed(2)})`);
     const pw = J(`[0.1, 0.5].map((v) => rowsOf('KRSTVM', { engine: 1, aPw: v }).rows.find((x) => x[E.BUS] === B.bass)[E.P0])`);
     ok(pw[0] === 0.1 && pw[1] === 0.5, 'pulse width is the bass’s width');
     const pwArp = J(`rowsOf('KRSTVM', { engine: 1, aPw: 0.125 }).rows.find((x) => (x[E.KIND] & 255) === K.ARC_ARP)[E.P4]`);
     ok(pwArp === 0.125, 'and the chord channel’s');
     const drv = J(`[0, 1].map((v) => rowsOf('KRSTVM', { engine: 1, aDrive: v }).rows.find((x) => x[E.BUS] === B.bass)[E.P1])`);
     ok(drv[0] === 0 && drv[1] === 1, 'bass drive is the bass’s drive');

     // drum density
     const drums = (v) => count({ aDrums: v }, '(x[E.KIND] & 255) === K.ARC_NOISE && x[E.BUS] === B.drums');
     const d0 = drums(0), d7 = drums(0.7), d1 = drums(1), written = J(`songOf('KRSTVM').song.events.filter((e) => ['kick','snare','hat','shaker','tom','perc','rim','clap','ride'].includes(e.type)).length`);
     ok(d0 < d7 && d7 < d1, `drum density: the backbone at the left, the sixteenths filled at the right (${d0} · ${d7} · ${d1} strokes)`);
     ok(d7 >= written, `as written at its resting point (${d7} rows for ${written} strokes; a clap is three)`);
     const back = J(`(() => { const s = songOf('KRSTVM').song, sig = buildSigil('KRSTVM'); const a = Arcade.arrange(s.events, s, sig, { aDrums: 0 });
       const keep = s.events.filter((e) => e.type === 'kick' && e.beat % 4 === 0).length; return [keep, a.filter((e) => e.type === 'kick' && e.beat % 4 === 0).length]; })()`);
     ok(back[0] === back[1], 'and even at none, every downbeat kick is kept');

     // noise decay
     const nd = J(`[0.5, 2].map((v) => rowsOf('KRSTVM', { engine: 1, aDecay: v }).rows.find((x) => (x[E.KIND] & 255) === K.ARC_NOISE && x[E.BUS] === B.drums)[E.P1])`);
     ok(Math.abs(nd[1] / nd[0] - 4) < 1e-9, 'noise decay scales every stroke of the noise channel');

     // arpeggio rate
     const ar = J(`[0, 6].map((v) => rowsOf('KRSTVM', { engine: 1, aArp: v }).rows.find((x) => (x[E.KIND] & 255) === K.ARC_ARP && x[E.BUS] === B.pad)[E.P3])`);
     ok(ar[0] === 2 && ar[1] === 16, `arpeggio rate: steps per beat (${ar[0]} → ${ar[1]})`);

     // space
     const sp = J(`(() => { const { sig, song } = songOf('KRSTVM'); const f = (v) => { const spec = SigilPlan.defaultSpec(sig, song); spec.P.engine = 1; spec.P.aSpace = v;
       const p = SigilPlan.compile(song, sig, { spec, events: false }); return [SigilPlan.hallWith(song, null, spec).size, p.sections[SigilDSP.PA.ECHO]]; }; return [f(0), f(1)]; })()`);
     ok(sp[0][0] < sp[1][0] && sp[0][1] < sp[1][1], `space: a bigger hall (${sp[0][0].toFixed(2)} → ${sp[1][0].toFixed(2)}) and more echo (${sp[0][1].toFixed(2)} → ${sp[1][1].toFixed(2)})`);

     // tempo: the transport's (a render takes the job's bpm)
     const job = J(`(() => { const { sig, song } = songOf('KRSTVM'); const spec = SigilPlan.defaultSpec(sig, song); spec.P.engine = 1; return SigilPlan.renderJob(song, sig, { sr: 8000, spb: 0.4, passes: 1, spec }).bpm; })()`);
     ok(job === 150, 'tempo is the transport’s, and a render plays at it');

     // determinism of the arrangement
     const twice = J(`(() => { const a = rowsOf('PLNGR', { engine: 1, aComplex: 0.9, aDrums: 0.95, aDensity: 0.3, aSwing: 0.4 }).rows, b = rowsOf('PLNGR', { engine: 1, aComplex: 0.9, aDrums: 0.95, aDensity: 0.3, aSwing: 0.4 }).rows; return JSON.stringify(a) === JSON.stringify(b); })()`);
     ok(twice, 'the same macros make the same rows');
     const field = J(`(() => { const s = songOf('PLNGR'), sig = s.sig; const lo = Arcade.arrange(s.song.events, s.song, sig, { aDrums: 0.8 }).filter((e) => e.tick).map((e) => e.beat), hi = new Set(Arcade.arrange(s.song.events, s.song, sig, { aDrums: 1 }).filter((e) => e.tick).map((e) => e.beat)); return lo.every((b) => hi.has(b)) && hi.size > lo.length; })()`);
     ok(field, 'more drum density adds strokes and never re-deals the ones that were there');
   });

   /* ═══════════════════════════════════════════════════════════════════════
      4 · THE PATCH
      ═══════════════════════════════════════════════════════════════════════ */
   group('§4 · the patch carries the engine and its macros', () => {
     const o = { engine: 1, aDensity: 0.4, aComplex: 0.8, aSwing: 0.25, aBright: 0.7, aFm: 0.6, aPw: 0.125, aDrive: 0.5, aDrums: 0.9, aDecay: 1.5, aArp: 4, aSpace: 0.3 };
     const back = J(`SoundDesign.decodePatch(SoundDesign.encodePatch(${JSON.stringify(o)}, 0)).o`);
     ok(Object.keys(o).every((k) => back[k] === o[k]), 'a patch code (a link, a library entry) carries the engine and every macro', JSON.stringify(back));
     const clampd = J(`SoundDesign.decodePatch(SoundDesign.encodePatch({ engine: 7, aArp: 2.6, aPw: 3 }, 0)).o`);
     ok(clampd.engine === 1 && clampd.aArp === 3 && clampd.aPw === 0.5, 'and holds each to its range');
     const mut = J(`(() => { const sig = buildSigil('KRSTVM'); let same = true; for (let n = 1; n < 40; n++) { const m = SoundDesign.mutate(sig.hash, n, { engine: 1, aArp: 2, wave: 3 }, { engine: 1 }); if (m.engine !== 1) same = false; } return same; })()`);
     ok(mut, 'Mutate never switches the engine');
     const own = J(`[Arcade.derive(buildSigil('KRSTVM').hash), Arcade.derive(buildSigil('KRSTVM').hash), Arcade.derive(buildSigil('PLNGR').hash)]`);
     ok(JSON.stringify(own[0]) === JSON.stringify(own[1]) && JSON.stringify(own[0]) !== JSON.stringify(own[2]), 'each sigil is dealt its own arcade sound, the same every time');
   });

   /* ═══════════════════════════════════════════════════════════════════════
      5 · HEARD
      ═══════════════════════════════════════════════════════════════════════ */
   group('§5 · every channel, alone', () => {
     run(`globalThis.note = (o) => {
       const D = SigilDSP, sr = 44100, E = new Float64Array(D.STRIDE), r = o.row;
       E[0] = 0; E[E_.KIND] = r.kind; E[E_.BUS] = r.bus; E[E_.F] = r.f; E[E_.F0] = r.f0 || 0; E[E_.DUR] = r.dur; E[E_.VEL] = r.vel ?? 0.8; E[E_.AUX] = r.aux || 0; E[E_.SEED] = 12345;
       (r.p || []).forEach((x, i) => { E[E_.P0 + i] = x; });
       const sections = new Float64Array(D.PSTRIDE); sections.set(D.DEFAULT_PATCH);
       const c = new D.Core(sr, { warm: false, voices: 8 });
       c.command({ type: 'plan', events: E, count: 1, sections, nSec: 1, total: 64, bpm: 120, passes: 1 });
       c.command({ type: 'levels', levels: {}, snap: true }); c.command({ type: 'params', reverb: 0 }); c.command({ type: 'play', beat: 0, pass: 0 }); c.snapFx();
       const n = Math.round(sr * (o.secs || 2)), blk = o.block || 128, L = new Float32Array(n), bl = new Float32Array(blk), br = new Float32Array(blk);
       for (let p = 0; p < n; p += blk) { bl.fill(0); br.fill(0); c.blockTime = p / sr; c.process(bl, br, blk); L.set(bl.subarray(0, Math.min(blk, n - p)), p); }
       // (quiet enough that the core's own protection, which listens a block at a time, is never reached: this is the voice alone)
       return { L, active: c.voices.filter((v) => v.active).length };
     }; globalThis.E_ = SigilDSP.EV;`);
     const CH = {
       'FM lead': `{ kind: K.ARC_FM, bus: B.lead, f: 440, dur: 1, aux: 20, p: [1, 0.6, 0.28, 0.45, 0.82, 0.4] }`,
       'FM bell': `{ kind: K.ARC_FM, bus: B.bell, f: 1320, dur: 1, p: [3.5, 0.5, 0.12, 0.35, 0, 0.1] }`,
       'FM, a high note, bright and deep': `{ kind: K.ARC_FM, bus: B.lead, f: 3500, dur: 1, p: [2, 2, 0.28, 0.45, 0.82, 1] }`,
       'pulse bass': `{ kind: K.ARC_PULSE, bus: B.bass, f: 55, f0: 49, dur: 1, p: [0.25, 0.3, 0.22, 0.72, 0.04, 0.035] }`,
       'pulse bass, driven into its crusher': `{ kind: K.ARC_PULSE, bus: B.bass, f: 82, dur: 1, vel: 0.3, p: [0.125, 1, 0.22, 0.72, 0.04, 0.035] }`,
       'drone': `{ kind: K.ARC_PULSE, bus: B.drone, f: 65, dur: 3, aux: 1, p: [0.5, 0, 1.5, 0.85, 0.12, 0.6] }`,
       'noise kick': `{ kind: K.ARC_NOISE, bus: B.drums, f: 3000, dur: 0.25, vel: 0.1, p: [0, 0.012, 0, 1.3, 240, 55], aux: 0.32 }`,
       'noise snare': `{ kind: K.ARC_NOISE, bus: B.drums, f: 9500, dur: 0.25, vel: 0.1, p: [0, 0.17, 0.7, 0.8, 240, 170], aux: 0.07 }`,
       'noise hat': `{ kind: K.ARC_NOISE, bus: B.drums, f: 38000, dur: 0.25, vel: 0.1, p: [0, 0.03, 0, 0, 0, 0] }`,
       'noise, metallic': `{ kind: K.ARC_NOISE, bus: B.drums, f: 26000, dur: 0.25, vel: 0.1, p: [1, 0.3, 0, 0, 0, 0] }`,
       'noise swell': `{ kind: K.ARC_NOISE, bus: B.bell, f: 2500, f0: 1.5, dur: 4, p: [0, 0.25, 12, 0, 0, 0], vel: 0.15 }`,
       'chord, stepped': `{ kind: K.ARC_ARP, bus: B.pad, f: 220, dur: 2, vel: 0.3, p: [277.2, 329.6, 440, 8, 0.25, 1] }`,
       'arpeggio note': `{ kind: K.ARC_ARP, bus: B.arp, f: 660, f0: 0.18, dur: 0.25, p: [0, 0, 0, 4, 0.25, 2] }`,
     };
     for (const [name, row] of Object.entries(CH)) {
       const r = J(`(() => { const a = note({ row: ${row}, secs: 3.5 }), b = note({ row: ${row}, secs: 3.5 }), c = note({ row: ${row}, secs: 3.5, block: 32 });
         let pk = 0, fin = true, same = true, blocks = 0, s = 0, dc = 0, jump = 0;
         for (let i = 0; i < a.L.length; i++) { const x = a.L[i]; if (!Number.isFinite(x)) fin = false; pk = Math.max(pk, Math.abs(x)); s += x * x; dc += x; if (x !== b.L[i]) same = false; blocks = Math.max(blocks, Math.abs(x - c.L[i])); }
         for (let i = 1; i < 64; i++) jump = Math.max(jump, Math.abs(a.L[i] - a.L[i - 1]));
         return { fin, pk, rms: Math.sqrt(s / a.L.length), same, blocks: blocks / (pk || 1), ended: a.active === 0, start: Math.abs(a.L[0]), dc: Math.abs(dc / a.L.length) / (pk || 1) }; })()`);
       // (a stroke of the noise channel is struck: it begins at once, as the cube's kit does; every other channel fades in)
       const struck = name.startsWith('noise') && name !== 'noise swell';
       ok(r.fin && r.pk > 0.002 && r.pk < 1.5 && r.same && r.ended && r.blocks < 1e-3 && (struck || r.start < 0.02) && r.dc < 0.05,
         `${name}: sounding (peak ${r.pk.toFixed(3)}), bounded, ends, no offset, the same twice, the same in any block size`, JSON.stringify(r));
     }
     const seek = J(`(() => { const D = SigilDSP, E = new Float64Array(D.STRIDE); E[0] = 0; E[E_.KIND] = K.ARC_ARP; E[E_.BUS] = B.pad; E[E_.F] = 220; E[E_.DUR] = 16; E[E_.VEL] = 0.8; E[E_.AUX] = 1; E[E_.P0] = 330; E[E_.P3] = 4; E[E_.P4] = 0.25; E[E_.SEED] = 5;
       const sections = new Float64Array(D.PSTRIDE); sections.set(D.DEFAULT_PATCH); const c = new D.Core(8000, { warm: false });
       c.command({ type: 'plan', events: E, count: 1, sections, nSec: 1, total: 32, bpm: 120, passes: 1 }); c.command({ type: 'play', beat: 6, pass: 0, chase: true });
       const bl = new Float32Array(128), br = new Float32Array(128); c.blockTime = 0; c.process(bl, br, 128); return c.voices.filter((v) => v.active && v.kind === K.ARC_ARP).length; })()`);
     ok(seek === 1, 'a held chord is picked up again when the playhead lands inside it');
     const live = J(`(() => { const r = SigilPlan.liveNote(64, 0, 0.8, 'glass', null, Arcade.params({})); return [r[E.KIND], r[E.DUR]]; })()`);
     ok(live[0] === J('K.ARC_FM') && live[1] === 0, 'a note played by hand is the FM lead’s, held until it is let go');
   });

   if (!QUICK) {
     group('§6 · a whole song, in the arcade', () => {
       for (const w of ['KRSTVM', 'TSMYWLFNHBK']) {
         const r = J(`(() => { const { sig, song } = songOf(${JSON.stringify(w)}); const spec = SigilPlan.defaultSpec(sig, song); spec.P.engine = 1;
           const render = () => { const job = SigilPlan.renderJob(song, sig, { sr: 22050, spb: song.spb, passes: 1, spec, flow: false }); return SigilDSP.renderRange(job, 0, Math.min(70, song.total * song.spb), 0); };
           const a = render(), b = render(); let pk = 0, fin = true, same = true, s = 0;
           for (let i = 0; i < a.L.length; i++) { const x = a.L[i]; if (!Number.isFinite(x) || !Number.isFinite(a.R[i])) fin = false; pk = Math.max(pk, Math.abs(x), Math.abs(a.R[i])); s += x * x; if (x !== b.L[i] || a.R[i] !== b.R[i]) same = false; }
           return { fin, pk, rms: 20 * Math.log10(Math.sqrt(s / a.L.length) + 1e-12), same }; })()`);
         ok(r.fin && r.pk > 0.05 && r.pk < 4 && r.rms > -40 && r.same, `${w}: ${r.rms.toFixed(1)} dBFS RMS, peak ${r.pk.toFixed(2)}, every sample a number, the same twice`, JSON.stringify(r));
       }
     });
   }

   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
