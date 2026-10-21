/* ══════════════════════════════════════════════════════════════════════════
   MOTION SPEC — the movers (05d), their table (06b) and the core that reads it
   (DSP §2b/§5c). No browser, no dependencies.

     node tests/motion.spec.mjs            everything
     node tests/motion.spec.mjs --quick    skip the audio renders

   What it defends
     1. The deal is deterministic, differs from sigil to sigil, and follows the
        letters: what a letter moves is decided by what kind of consonant it is.
     2. Every gesture is a function of the beat, and is where it says it is.
     3. AT REST, THE ENGINE IS THE ENGINE BEFORE MOTION: with Motion and Evolve
        at zero (or with no table at all) the output is, bit for bit, what the
        last commit without any of this produced.
     4. THE STAGE AND THE FILE AGREE: a core left to loop, as on the stage, and
        a fresh core started in the middle of any pass, as a render segment is,
        hand every note the same patch. A stem's job carries the same table and
        the same amounts as the full mix's.
     5. Passes evolve when asked to, only when asked to, and never run away.
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/core/06b-compiler.js'];
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
   const eq = (a, b, label) => ok(Object.is(a, b), label, `expected ${JSON.stringify(b)}  got ${JSON.stringify(a)}`);
   function group(name, fn) {
     console.log(`\n${name}`);
     try { fn(); } catch (e) { ok(false, `${name}: threw`, String((e && e.stack) || e)); }
   }
   
   /* ═══════════════════════════════════════════════════════════════════════
      1 · THE DEAL
      ═══════════════════════════════════════════════════════════════════════ */
   group('§1 · which letter moves what', () => {
     const run = fresh();
     run(`globalThis.WORDS = (() => { const R = stream(hashStr('motion-spec'), 'words'), out = ['KRSTVM', 'THWLBDNS', 'BCD', 'PLMNKJHGFDSTRVWXYZBC', 'TSMYWLFNHBK', 'FSHVZXC', 'MNJLRWY', 'BPDGKTQ'];
         for (let i = 0; i < 60; i++) out.push(R.shuffle(CONSONANTS).slice(0, R.int(3, 21)).join('')); return out; })();
       globalThis.str = (L) => JSON.stringify(L);`);
   
     ok(run(`(() => { const s = buildSigil('KRSTVM'); return str(Motion.deal(s, 0)) === str(Motion.deal(buildSigil('KRSTVM'), 0)); })()`),
        'the same sigil is always dealt the same movers');
     ok(run(`(() => { const names = (w) => Motion.deal(buildSigil(w), 0).map((l) => l.name).join();
         return new Set(['KRSTVM', 'THWLBDNS', 'MNJLRWY', 'BPDGKTQ', 'FSHVZXC', 'TSMYWLFNHBK'].map(names)).size >= 5; })()`),
        'different sigils move different parameters');
     ok(run(`(() => { const s = buildSigil('THWLBDNS'), a = str(Motion.deal(s, 0)); return [1, 2, 3, 7].every((v) => str(Motion.deal(s, v)) !== a) && str(Motion.deal(s, 3)) === str(Motion.deal(s, 3)); })()`),
        'each variation is another deal, and is itself always the same');
     ok(run(`WORDS.every((w) => { const s = buildSigil(w), L = Motion.deal(s, 0); return L[0].node === 0 && L[0].letter === s.reduced[0]; })`),
        'variation 0 begins with the sigil’s first letter');
   
     const bad = run(`(() => { const bad = [];
       for (const w of WORDS) for (const v of [0, 5]) {
         const s = buildSigil(w), L = Motion.deal(s, v), n = s.nodes.length, act = L.filter((l) => !l.latent), lat = L.filter((l) => l.latent);
         const want = Math.max(3, Math.min(6, Math.round(2.5 + n / 4)));
         if (act.length !== want || lat.length !== 2 || L.length > SigilDSP.LANES) bad.push(w + ': ' + act.length + '+' + lat.length + ' movers');
         if (new Set(L.map((l) => l.name)).size !== L.length) bad.push(w + ': a parameter moved twice');
         if (L.some((l) => !(l.name in Motion.PARAMS) || !Motion.PARAMS[l.name].src.includes(l.src) || !Motion.PARAMS[l.name].src.includes(l.srcB))) bad.push(w + ': a gesture that does not suit its parameter');
         const P0 = Motion.PARAMS[L[0].name];
         if (P0.kit || P0.gate || L[0].name === 'drums') bad.push(w + ': the first letter moves the kit, not the voice');
         const fam = {}; act.forEach((l) => (fam[l.fam] = (fam[l.fam] || 0) + 1));
         if (Math.max(...Object.values(fam)) > Math.ceil(act.length / 2) + 1) bad.push(w + ': one family holds ' + JSON.stringify(fam));
         if (L.some((l) => s.nodes[l.node].letter !== l.letter || s.nodes[l.node].slot !== l.slot)) bad.push(w + ': a mover that is not one of its letters');
         if (n >= act.length + 2 && new Set(L.map((l) => l.node)).size !== L.length) bad.push(w + ': a sleeper shares a letter although there are letters to spare');
         if (L.some((l) => !(l.depth > 0) || l.lo >= l.hi || !(l.gain > 0) || !(l.morph > 0) || l.shift === 0)) bad.push(w + ': a mover with nothing to do');
         if (L.some((l) => (Motion.UNIPOLAR.has(l.src) && l.sign !== 1) || Math.abs(l.sign) !== 1)) bad.push(w + ': a gathering or a throw that pulls');
       }
       return bad; })()`);
     ok(!bad.length, '136 deals: 3 to 6 movers and 2 sleepers, each one letter and one parameter, the first on the voice, no family over half', bad.slice(0, 5).join('\n      '));
   
     ok(run(`(() => { let own = 0, all = 0;
         for (const w of WORDS) for (const l of Motion.deal(buildSigil(w), 0)) { all++; if (l.own) own++; }
         return own / all > 0.6; })()`), 'most movers move something of their own letter’s family (liquids flow, plosives strike…)');
     ok(run(`(() => { const fam = (w) => Motion.deal(buildSigil(w), 0).filter((l) => !l.latent).map((l) => l.fam);
         return fam('MNJLRWY').every((f) => f === 'body' || f === 'flow') && fam('BPDGKTQ').filter((f) => f === 'strike').length >= 2; })()`),
        'a sigil of nasals and liquids moves body and flow; a sigil of plosives works its kit');
     ok(run(`WORDS.every((w) => { const s = buildSigil(w), gritty = SoundDesign.derive(s.hash, 0).grit > 0;
         return gritty || Motion.deal(s, 0).every((l) => !l.gate); })`), 'a crusher is only moved for a sigil whose own patch has one on');
     ok(run(`(() => { const d = [0, 0, 0], c = [0, 0, 0];
         for (const w of WORDS) for (const l of Motion.deal(buildSigil(w), 0)) { d[l.ring] += l.depth / Motion.PARAMS[l.name].d; c[l.ring]++; }
         return d[0] / c[0] < d[1] / c[1] && d[1] / c[1] < d[2] / c[2]; })()`), 'outer letters reach further than inner ones');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      2 · THE GESTURES
      ═══════════════════════════════════════════════════════════════════════ */
   group('§2 · every gesture is a function of the beat', () => {
     const run = fresh();
     run(`globalThis.sig = buildSigil('THWLBDNS'); globalThis.song = composeSong(sig);
       globalThis.len = Math.ceil(song.total / Motion.STEP) + 2; globalThis.G = Motion.gestures(song, sig, len);
       globalThis.at = (name, beat) => G[name][Math.round(beat / Motion.STEP)];`);
     ok(run(`Motion.SOURCES.every((k) => { for (let g = 0; g < len; g++) { const v = G[k][g]; if (!Number.isFinite(v) || v > 1.0001 || v < (Motion.UNIPOLAR.has(k) ? -0.0001 : -1.0001)) return false; } return true; })`),
        'all nine are finite and in range (−1…1, or 0…1 for a gathering and a throw)');
     ok(run(`Math.abs(at('breath', 0) + 1) < 1e-6 && Math.abs(at('breath', 4) - 1) < 1e-6 && Math.abs(at('breath', 8) + 1) < 1e-6 && Math.abs(at('breath', 50) - at('breath', 58)) < 1e-6`),
        'breath: eight beats in and out, the Charge ring’s own cycle');
     ok(run(`song.phrases.every((ph) => Math.abs(at('phrase', ph.start) + 1) < 1e-6 && Math.abs(at('phrase', ph.start + 8) - 1) < 1e-6)`),
        'phrase: low where a phrase begins, high at its middle');
     ok(run(`song.sections.every((s, i) => Math.abs(at('section', s.start) + 1) < 1e-6 && at('section', s.end - (s.tail || 0) - 0.25) > 0.97 && at('section', (s.start + s.end - (s.tail || 0)) / 2) > -0.1)`),
        'section: climbs from the start of each section to its end, and begins again at the next');
     ok(run(`Math.abs(at('rite', 0) + 1) < 1e-6 && at('rite', song.total / 2) > 0.99`), 'rite: up to the middle of the rite and away again');
     ok(run(`(() => { for (const s of song.sections.slice(0, -1)) {
           if (at('swell', s.end - 8) !== 0 || !(at('swell', s.end - 2) > 0.2) || !(at('swell', s.end - 0.25) > 0.85) || !(at('swell', s.end + 3) === 0)) return false; }
         const last = song.sections[song.sections.length - 1];
         return at('swell', last.end - 1) === 0 && at('swell', song.sections[0].start + 1) === 0; })()`),
        'swell: gathers through the last bar of a section, lets go in the next; the rite’s own end and beginning are left alone');
     ok(run(`song.phrases.every((ph, i) => at('throw', ph.start + 8) === 0 && at('throw', ph.end - 1) > 0.99 && at('throw', ph.end - 0.25) > 0.99 && at('throw', ph.end - 1.5) < 0.01)`),
        'throw: nothing until the last beat of a phrase, then all of it');
     ok(run(`(() => { const n = sig.nodes.length; for (let bar = 1; bar < 30; bar++) { if (Math.abs(at('rings', bar * 4 + 2) - (sig.nodes[bar % n].ring - 1)) > 1e-6) return false; } return true; })()`),
        'rings: each bar takes the ring of the next letter in turn');
     ok(run(`(() => { const rim = RINGS[2];
         for (const ph of song.phrases) for (const nd of ph.path.slice(0, -1)) {
           const want = clamp((RINGS[nd.ring] / rim) * 2 - 1, -1, 1);
           if (Math.abs(nd.beat / Motion.STEP - Math.round(nd.beat / Motion.STEP)) > 1e-9) continue;
           if (Math.abs(at('pen', nd.beat) - want) > 0.02) return false; }
         return true; })()`), 'pen: when the pen arrives at a letter, the gesture is at that letter’s ring');
     ok(run(`(() => { const F = { cx: 0, cy: 0, R: 1, base: sig.baseAngle }, rim = RINGS[2];
         for (const ph of song.phrases.slice(0, 6)) for (const nd of ph.path.slice(0, -1)) {
           if (Math.abs(nd.beat / Motion.STEP - Math.round(nd.beat / Motion.STEP)) > 1e-9) continue;
           const [x] = nodeXY(nd, song.sections[ph.si].Tdisp, F);
           if (Math.abs(at('sway', nd.beat) - clamp(x / rim, -1, 1)) > 0.02) return false; }
         return true; })()`), 'sway: the pen’s place left to right, under each section’s own turn of the wheel');
     ok(run(`(() => { const a = Motion.gestures(song, sig, len), b = Motion.gestures(composeSong(buildSigil('THWLBDNS')), buildSigil('THWLBDNS'), len);
         return Motion.SOURCES.every((k) => a[k].join() === b[k].join()); })()`), 'the same song always yields the same gestures');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      3 · THE TABLE
      ═══════════════════════════════════════════════════════════════════════ */
   group('§3 · the table, and what the compiler makes of it', () => {
     const run = fresh();
     run(`globalThis.D = SigilDSP; globalThis.sig = buildSigil('KRSTVM'); globalThis.song = composeSong(sig); globalThis.spec = () => SigilPlan.defaultSpec(sig, song);`);
     ok(run(`Motion.NAMES.every((n) => SigilPlan.LANE_COL[n] && D.PA[SigilPlan.LANE_COL[n]] > 0 && n in SoundDesign.FIELDS)`),
        'everything that can be moved has a column in the core and a field in the patch');
     ok(run(`(() => { const a = Motion.bake(song, sig, {}), b = Motion.bake(song, sig, {}); return a === b && a.len === Math.ceil(song.total / 0.25) + 2 && a.curves.length === a.n * 2 * a.len; })()`),
        'a table is baked once per song and deal, on a sixteenth-note grid');
     ok(run(`(() => { const t = Motion.bake(song, sig, { mute: 0b101 });
         const flat = (j) => { for (let g = 0; g < 2 * t.len; g++) if (t.curves[2 * j * t.len + g] !== 0) return false; return true; };
         return t.lanes[0].resting && !t.lanes[1].resting && t.lanes[2].resting && flat(0) && !flat(1) && flat(2); })()`),
        'a mover held still is a flat line');
     ok(run(`(() => { const t = Motion.bake(song, sig, { kit: false }); return t.lanes.every((l) => l.resting === l.kit) && t.lanes.some((l) => l.kit); })()`),
        'with the kit’s FX bypassed, the kit’s movers rest and the others do not');
     ok(run(`(() => { const p = SigilPlan.compile(song, sig, { spec: spec(), events: false }), a = p.auto, L = a.lanes, A = D.AU;
         return a.n === a.meta.length && L.length === a.n * D.ASTRIDE && a.meta.every((ln, j) => { const o = j * D.ASTRIDE;
           return L[o + A.COL] === D.PA[SigilPlan.LANE_COL[ln.name]] && L[o + A.LO] === ln.lo && L[o + A.HI] === ln.hi && L[o + A.DEPTH] === ln.depth
               && L[o + A.LATENT] === (ln.latent ? 1 : 0) && L[o + A.GATE] === (ln.gate ? 1 : 0) && L[o + A.SEED] === ln.seed; }); })()`),
        'the compiler packs each mover into the core’s lane layout');
     ok(run(`(() => { const s = spec(); s.P.mMute = 0b10;
         const p = SigilPlan.compile(song, sig, { spec: s, events: false }), o = D.ASTRIDE;
         return p.auto.lanes[o + D.AU.DEPTH] === 0 && p.auto.lanes[o + D.AU.SHIFT] === 0 && p.auto.lanes[D.AU.DEPTH] > 0; })()`),
        'a mover at rest is packed with no depth and no drift: it cannot evolve either');
     ok(run(`(() => { const s = spec(); s.P.motion = 1.4; s.P.evolve = 0.8; s.P.mVar = 3;
         const full = SigilPlan.renderJob(song, sig, { sr: 44100, spb: song.spb, passes: 2, lens: false, spec: s, levels: null });
         const lv = {}; D.BUS_NAMES.forEach((b) => (lv[b] = b === 'lead' ? 0.9 : 0));
         const stem = SigilPlan.renderJob(song, sig, { sr: 44100, spb: song.spb, passes: 2, lens: false, spec: s, levels: lv });
         const same = (x, y) => x.length === y.length && Array.prototype.every.call(x, (v, i) => v === y[i]);
         return full.params.motion === 1.4 && full.params.evolve === 0.8 && full.params.pass0 === 0
             && same(full.auto.curves, stem.auto.curves) && same(full.auto.lanes, stem.auto.lanes) && JSON.stringify(full.params) === JSON.stringify(stem.params)
             && same(full.sections, stem.sections) && same(full.events, stem.events) && stem.levels.lead === 0.9 && stem.levels.drums === 0; })()`),
        'a stem’s job is the full mix’s job, lane for lane and amount for amount: only the levels differ');
     ok(run(`SigilPlan.renderJob(song, sig, { sr: 44100, spb: song.spb, passes: 1, lens: false, spec: spec(), levels: null, pass0: 2 }).params.pass0 === 2`),
        'a render can be told which pass it begins on');
     ok(run(`(() => { const o = { motion: 1.5, evolve: 0.25, mVar: 7, mMute: 5, wave: 2.5 };
         const d = SoundDesign.decodePatch(SoundDesign.encodePatch(o, 0));
         return JSON.stringify(d.o) === JSON.stringify({ wave: 2.5, motion: 1.5, evolve: 0.25, mVar: 7, mMute: 5 }); })()`),
        'the four motion fields survive the patch codec (a shared link moves as it did)');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      4 · THE CORE
      ═══════════════════════════════════════════════════════════════════════ */
   group('§4 · what a pass does', () => {
     const run = fresh();
     run(`globalThis.D = SigilDSP; globalThis.sig = buildSigil('TSMYWLFNHBK'); globalThis.song = composeSong(sig);
       globalThis.a = SigilPlan.compile(song, sig, { spec: SigilPlan.defaultSpec(sig, song), events: false }).auto;
       globalThis.P = (j, pass, motion, evolve) => Array.from(D.autoPass(a.lanes, j, pass, motion, evolve, new Float64Array(3)));`);
     ok(run(`a.meta.every((ln, j) => { const [d, m, s] = P(j, 0, 1, 1); return m === 0 && s === 0 && d === (ln.latent ? 0 : ln.depth); })`),
        'pass 1 is the rite as written, whatever Evolution is: no morph, no drift, the sleepers asleep');
     ok(run(`a.meta.every((ln, j) => [1, 2, 5, 40].every((p) => JSON.stringify(P(j, p, 1, 0)) === JSON.stringify(P(j, 0, 1, 0))))`),
        'with Evolution at zero every pass is the first');
     ok(run(`a.meta.every((ln, j) => { const x = P(j, 3, 1, 0.7); return x[1] > 0 && x[2] !== 0 && x[0] > 0 && JSON.stringify(x) !== JSON.stringify(P(j, 2, 1, 0.7)); })`),
        'with Evolution up, later passes morph, drift, differ from each other, and the sleepers wake');
     ok(run(`a.meta.every((ln, j) => P(j, 4, 0, 1)[0] === 0 && P(j, 4, 0, 1)[2] !== 0 && P(j, 4, 0, 0).every((v) => v === 0))`),
        'Motion at zero stops the moving but not the drift between passes; both at zero is perfect rest');
     ok(run(`a.meta.every((ln, j) => { for (let p = 0; p < 400; p++) { const [d, m, s] = P(j, p, 2, 1);
           if (!(d >= 0 && d <= ln.depth * 2 * 2.5) || !(m >= 0 && m <= 1) || !(Math.abs(s) <= ln.depth * 2.3) || !Number.isFinite(d + m + s)) return false; } return true; })`),
        'four hundred passes on, nothing has run away: depth, morph and drift stay bounded');
     ok(run(`(() => { const x = P(0, 7, 1, 1), y = P(0, 7, 1, 1), z = P(0, 8, 1, 1); return JSON.stringify(x) === JSON.stringify(y) && JSON.stringify(x) !== JSON.stringify(z); })()`),
        'a pass is a pure function of its number: pass 8 is pass 8 however it was reached');
     ok(run(`(() => { const f = D.autoApply;
         return f(0.5, 0.2, 0, 1) === 0.7 && f(0.5, 0, 0, 1) === 0.5 && Math.abs(f(0.9, 0.3, 0, 1) - 0.8) < 1e-12 && Math.abs(f(0.1, -0.3, 0, 1) - 0.2) < 1e-12
             && f(0.98, 0.29, 0, 1) < 1 && f(0.98, 0.29, 0, 1) > 0.7 && f(0.5, 9, 0, 1) >= 0 && f(0.5, 9, 0, 1) <= 1 && f(-0.2, 0.1, -1, 1) === -0.1; })()`),
        'at a limit a mover turns back rather than going flat: a knob near the top of its travel still moves, downward');
     ok(run(`(() => { for (let j = 0; j < a.n; j++) for (const b of [0, 0.125, 17.3, 64, song.total - 0.1, song.total + 5, -3]) for (const m of [0, 0.4, 1]) {
           const v = D.autoCurve(a.curves, a.len, a.step, j, b, m); if (!(v >= -1.0001 && v <= 1.0001)) return false; }
         const g = 100, j = 2, at = a.curves[2 * j * a.len + g];
         return D.autoCurve(a.curves, a.len, a.step, j, g * a.step, 0) === at
             && Math.abs(D.autoCurve(a.curves, a.len, a.step, j, (g + 0.5) * a.step, 0) - (at + a.curves[2 * j * a.len + g + 1]) / 2) < 1e-6; })()`),
        'a curve is read on its grid exactly, between grid points in a straight line, and safely off either end');
   });
   
   group('§4 · the stage and the file agree', () => {
     const run = fresh();
     run(`globalThis.D = SigilDSP; globalThis.sig = buildSigil('TSMYWLFNHBK'); globalThis.song = Groove.apply(composeSong(sig), sig, {});
       globalThis.job = (over) => { const spec = SigilPlan.defaultSpec(sig, song); Object.assign(spec.P, over || {});
         return SigilPlan.renderJob(song, sig, { sr: 32000, spb: song.spb, passes: 4, lens: false, spec, levels: null }); };
       globalThis.core = (j) => { const c = new D.Core(32000, { warm: false });
         c.command({ type: 'plan', events: j.events, count: j.count, sections: j.sections, nSec: j.nSec, total: j.total, bpm: j.bpm, passes: 0, auto: j.auto });
         c.command(Object.assign({ type: 'params' }, j.params)); return c; };
       globalThis.PROBES = [0, 3.25, 40.5, 77.125, 120.75, song.total - 9.5];
       globalThis.rows = (c) => PROBES.map((q) => { const pb = c.rowAt(q); return Array.from(c.rowS.subarray(pb, pb + D.PSTRIDE)); });`);
   
     const r = run(`(() => { const j = job(), live = core(j); live.command({ type: 'play', beat: 0, pass: 0 });
         const bl = new Float32Array(128), br = new Float32Array(128), seen = [], per = Math.ceil(song.total * song.spb * 32000 / 128);
         let last = -1;
         for (let b = 0; b < per * 3 + 40; b++) { live.blockTime = b * 128 / 32000; live.process(bl, br, 128); if (live.pass !== last) { last = live.pass; seen.push([last, JSON.stringify(rows(live))]); } }
         const agree = seen.map(([p, live]) => { const seg = core(j); seg.command({ type: 'play', beat: 50, pass: p, chase: true }); return JSON.stringify(rows(seg)) === live; });
         const moved = seen[0][1] !== JSON.stringify(PROBES.map((q) => { const c = core(job({ motion: 0, evolve: 0 })); const pb = c.rowAt(q); return Array.from(c.rowS.subarray(pb, pb + D.PSTRIDE)); }));
         return { passes: seen.map((s) => s[0]), agree, differ: seen[0][1] !== seen[1][1] && seen[1][1] !== seen[2][1], moved }; })()`);
     ok(r.passes.join() === '0,1,2,3' && r.agree.every(Boolean),
        'a core left to loop (the stage) and a core started mid-song in each pass (a render segment) read the same row at every beat, on passes 1 to 4', JSON.stringify(r));
     ok(r.differ && r.moved, 'and those rows do move, and do differ from pass to pass');
   
     /* A note must be handed the row of ITS OWN beat. If it were handed the block's, its sound would depend
        on where the 128-sample blocks happened to fall, and those fall differently on a stage, in a render,
        and in each of a render's segments. So: every question the core asks while playing is either the
        one-per-block question of the FX, or is asked at exactly the beat of an event in the plan. */
     ok(run(`(() => { const j = job(), c = core(j), asked = [], orig = c.rowAt.bind(c);
         c.command({ type: 'play', beat: 40.3, pass: 1, chase: true });
         c.rowAt = (b) => { asked.push(b); return orig(b); };
         const bl = new Float32Array(128), br = new Float32Array(128), blocks = 3000;          // twelve seconds
         for (let b = 0; b < blocks; b++) { c.blockTime = b * 128 / 32000; c.process(bl, br, 128); }
         const ev = new Set(); for (let i = 0; i < j.count; i++) ev.add(j.events[i * D.STRIDE]);
         const notes = asked.filter((b) => ev.has(b)).length;
         return notes > 40 && asked.length - notes === blocks; })()`),
        'every note is handed the row of its own beat, not of the block it happened to start in');
   
     ok(run(`(() => { const j = job(), c = core(j); c.command({ type: 'play', beat: 0, pass: 0 });
         const one = JSON.stringify(rows(c));
         c.command({ type: 'params', pass0: 2 });
         const off = JSON.stringify(rows(c)), d = core(j); d.command({ type: 'play', beat: 0, pass: 2 });
         return off !== one && off === JSON.stringify(rows(d)); })()`),
        'a render told to begin on pass 3 (pass0) reads what a loop reads on its third time round');
     ok(run(`(() => { const c = core(job({ motion: 2, evolve: 1 })); c.command({ type: 'play', beat: 0, pass: 6 });
         const L = c.au.lanes;
         for (let b = 0; b < song.total; b += 0.37) { const pb = c.rowAt(b);
           for (let j = 0; j < c.au.n; j++) { const o = j * D.ASTRIDE, v = c.rowS[pb + L[o + D.AU.COL]]; if (v < L[o + D.AU.LO] - 1e-9 || v > L[o + D.AU.HI] + 1e-9) return false; } }
         return true; })()`), 'with everything turned up, no column is ever pushed outside its own limits');
     ok(run(`(() => { const k = buildSigil('KRSTVM'), s2 = composeSong(k), spec = SigilPlan.defaultSpec(k, s2);
         const lanes = Motion.deal(k, 0), gi = lanes.findIndex((l) => l.name === 'grit');
         if (gi < 0) return 'no grit mover';
         spec.P.grit = 0; spec.P.motion = 2;
         const j = SigilPlan.renderJob(s2, k, { sr: 32000, spb: s2.spb, passes: 1, lens: false, spec, levels: null }), c = core(j);
         c.command({ type: 'play', beat: 0, pass: 0 });
         for (let b = 0; b < s2.total; b += 0.5) { const pb = c.rowAt(b); if (c.rowS[pb + D.PA.GRIT] !== 0) return false; }
         return true; })()`) === true, 'a gated mover leaves alone what the patch has off: Grit at zero stays at zero');
     ok(run(`(() => { const j = job(), c = core(j); c.command({ type: 'play', beat: 0, pass: 1 });
         const moving = c.auOn; c.command({ type: 'auto', auto: null });
         const pb = c.rowAt(40.5); return moving && !c.auOn && c.rowS === c.sec && pb === c.secBase(40.5); })()`),
        'with no table the core hands every note the plan’s own row, untouched');
   });
   
   if (QUICK) console.log('\n(--quick: audio renders skipped)');
   else {
     const HASH = `(r) => { let h = 2166136261; for (let i = 0; i < r.L.length; i++) {
         h = Math.imul(h ^ (Math.round(r.L[i] * 32767) & 0xffff), 16777619); h = Math.imul(h ^ (Math.round(r.R[i] * 32767) & 0xffff), 16777619); }
         return (h >>> 0).toString(16); }`;
   
     group('§5 · at rest, the engine is the engine before motion', () => {
       const run = fresh();
       run(`globalThis.hash = ${HASH};
         globalThis.around = (word, sr, over) => { const sig = buildSigil(word), song = composeSong(sig), spec = SigilPlan.defaultSpec(sig, song);
           Object.assign(spec.P, over);
           const job = SigilPlan.renderJob(song, sig, { sr, spb: song.spb, passes: 1, lens: false, spec, levels: null, drums: { fx: false } });
           const s = song.sections[2].start, a = (s - 8) * song.spb, b = (s + 8) * song.spb;
           return SigilDSP.renderRange(job, a, b, a); };`);
       /* Recorded from the commit before the drum chain or motion existed (SigilDSP v2): same range, same hash. */
       eq(run(`hash(around('KRSTVM', 48000, { motion: 0, evolve: 0 }))`), '3e9ebb88', 'KRSTVM @ 48000: Motion and Evolution at zero = the v2 engine, bit for bit');
       eq(run(`hash(around('THWLBDNS', 44100, { motion: 0, evolve: 0 }))`), '83a0a5e', 'THWLBDNS @ 44100: the same');
       eq(run(`hash(around('KRSTVM', 48000, { motion: 0, evolve: 1 }))`), '3e9ebb88', 'Evolution alone changes nothing on the first pass');
       eq(run(`hash(around('KRSTVM', 48000, { mMute: 255 }))`), '3e9ebb88', 'every mover held still is the same as no motion at all');
       ok(run(`hash(around('KRSTVM', 48000, {})) !== '3e9ebb88'`), 'and with the movers moving, the sound is audibly another');
     });
   
     group('§5 · motion in sound: finite, repeatable, and evolving only when asked', () => {
       const run = fresh();
       run(`globalThis.hash = ${HASH};
         globalThis.render = (over, from, to, pass0 = 0, passes = 3) => { const sig = buildSigil('TSMYWLFNHBK'), song = Groove.apply(composeSong(sig), sig, {}), spec = SigilPlan.defaultSpec(sig, song);
           Object.assign(spec.P, over);
           const job = SigilPlan.renderJob(song, sig, { sr: 32000, spb: song.spb, passes, lens: false, spec, levels: null, pass0 });
           const T = song.total * song.spb, s = song.sections[2].start * song.spb;
           return SigilDSP.renderRange(job, from(T, s), to(T, s), from(T, s)); };
         globalThis.stat = (r) => { let bad = 0, pk = 0; for (let i = 0; i < r.L.length; i++) { if (!Number.isFinite(r.L[i]) || !Number.isFinite(r.R[i])) bad++; pk = Math.max(pk, Math.abs(r.L[i]), Math.abs(r.R[i])); } return { bad, pk }; };`);
       ok(run(`(() => { const a = render({ motion: 2, evolve: 1 }, (T, s) => T + s - 4, (T, s) => T + s + 8), b = render({ motion: 2, evolve: 1 }, (T, s) => T + s - 4, (T, s) => T + s + 8), st = stat(a);
           return st.bad === 0 && st.pk > 0.1 && st.pk <= 1 && hash(a) === hash(b); })()`),
          'Motion and Evolution at full, on the second pass: finite, inside full scale, bit-identical twice');
       /* The same twelve seconds of the Exaltation, heard on pass 1 and on pass 2 (a render that starts there). */
       ok(run(`(() => { const w = [(T, s) => s + 2, (T, s) => s + 10];
           const p1 = hash(render({ evolve: 0 }, w[0], w[1], 0, 1)), p2 = hash(render({ evolve: 0 }, w[0], w[1], 1, 1));
           const e1 = hash(render({ evolve: 1 }, w[0], w[1], 0, 1)), e2 = hash(render({ evolve: 1 }, w[0], w[1], 1, 1));
           return p1 === p2 && e1 === p1 && e2 !== e1; })()`),
          'with Evolution at zero the second pass is the first, sample for sample; with it up, the second pass is a different performance');
     });
   }
   
   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
   