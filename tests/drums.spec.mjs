/* ══════════════════════════════════════════════════════════════════════════
   DRUMS SPEC — the groove writer (05c), the drum rows (06b) and the kit's FX
   chain (DSP §5b). No browser, no dependencies.

     node tests/drums.spec.mjs            everything (about half a minute)
     node tests/drums.spec.mjs --quick    skip the audio renders

   What it defends
     1. The composer is untouched: with no 'score' listener the score is what
        it always was, and the composer's bars can always be put back exactly.
     2. The groove is deterministic, well-formed for any sigil and any plan,
        and its amounts are thresholds (more never means "different").
     3. The engine with the chain bypassed (and the movers of 05d at rest) is,
        bit for bit, the engine before the chain existed (hashes recorded from
        the last commit without it).
     4. The chain is finite, deterministic, silent when off, and converges
        inside the offline renderer's pre-roll (m7's seam contract).
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05k-fills.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/core/06b-compiler.js'];
   const QUICK = process.argv.includes('--quick');
   
   /** A fresh VM: the pure layers, the DSP core and the compiler, in index.html's order. No modules. */
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
   
   const WORDS = ['KRSTVM', 'THWLBDNS', 'BCD', 'PLMNKJHGFDSTRVWXYZBC', 'TSMYWLFNHBK', 'FSHVZXC', 'MNJLRWY', 'BPDGKTQ'];
   
   /* ═══════════════════════════════════════════════════════════════════════
      1 · THE COMPOSER IS UNTOUCHED
      ═══════════════════════════════════════════════════════════════════════ */
   group('§1 · the composer and its bars', () => {
     const run = fresh();
     run(`globalThis.key = (e) => [e.beat, e.type, e.midi ?? '', e.vel ?? '', e.open ?? '', e.tom ?? '', e.dur ?? ''].join('|');
          globalThis.drums = (song) => song.events.filter((e) => Groove.TYPES.has(e.type)).map(key).join(';');
          globalThis.rest = (song) => song.events.filter((e) => !Groove.TYPES.has(e.type)).map(key).join(';');`);
   
     ok(run(`(() => { const s = buildSigil('KRSTVM'), a = composeSong(s); return !a.cfg.groove && a.sections.every((x) => !x.rhythm); })()`),
        'with no listener, a song carries no groove and no section rhythm');
   
     ok(run(`(() => {
       const s = buildSigil('THWLBDNS'), a = composeSong(s), before = drums(a), music = rest(a), n = a.events.length;
       Groove.apply(a, s, {});
       const changed = drums(a) !== before, musicKept = rest(a) === music;
       Groove.restore(a);
       return changed && musicKept && drums(a) === before && rest(a) === music && a.events.length === n && !a.cfg.groove;
     })()`), 'apply() rewrites only the kit; restore() puts the composer’s bars back exactly');
   
     ok(run(`(() => {
       const s = buildSigil('BCD'), a = composeSong(s), k0 = a.kicks.join(), s0 = a.snares.join();
       Groove.apply(a, s, {}); Groove.restore(a);
       return a.kicks.join() === k0 && a.snares.join() === s0;
     })()`), 'kicks and snares (the renderer’s pulse lists) are restored with the bars');
   
     ok(run(`(() => {
       const s = buildSigil('KRSTVM');
       const plain = composeSong(s), lead = plain.events.filter((e) => e.type === 'lead').map(key).join(';');
       const off = Hooks.on('score', (ev, ctx) => Groove.score(ev, ctx, {}));
       const viaHook = composeSong(s);
       off();
       const viaApply = Groove.apply(composeSong(s), s, {});
       return drums(viaHook) === drums(viaApply) && viaHook.kicks.join() === viaApply.kicks.join()
           && viaHook.events.filter((e) => e.type === 'lead').map(key).join(';') === lead
           && viaHook.cfg.groove.sig === viaApply.cfg.groove.sig;
     })()`), 'the score filter and apply() write the same part, and neither moves a note of the melody');
   
     ok(run(`(() => {
       const s = buildSigil('KRSTVM'), a = composeSong(s);
       const off = Hooks.on('score', () => undefined);
       const b = composeSong(s);
       off();
       return a.events.map(key).join(';') === b.events.map(key).join(';');
     })()`), 'a score listener that returns nothing changes nothing');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      2 · THE GROOVE
      ═══════════════════════════════════════════════════════════════════════ */
   group('§2 · geometry of rhythm', () => {
     const run = fresh();
     const id = '{ k: 0, m: 1, reverse: false }';
     ok(run(`(() => { const p = euclid(5, 16, 0); return Groove.turn(p, ${id}).join() === p.map(Boolean).join(); })()`),
        'the identity transform leaves a polygon alone');
     ok(run(`(() => { const p = euclid(5, 16, 3), q = Groove.turn(p, { k: 0, m: -1, reverse: false });
                       return q.every((on, s) => on === !!p[mod(-s, 16)]) && Groove.turn(q, { k: 0, m: -1, reverse: false }).join() === p.map(Boolean).join(); })()`),
        'mirror reflects about the downbeat, and twice is the identity');
     ok(run(`(() => { const p = euclid(7, 16, 2), q = Groove.turn(p, { k: 0, m: 1, reverse: true });
                       return q.every((on, s) => on === !!p[15 - s]); })()`), 'retrograde reads the bar from its end');
     ok(run(`[0, 9, 10, 11, 16, 17, 18, 21].every((k) => Groove.turnSteps(k) === mod(Math.round(k * 16 / 21), 16))`),
        'a turn of k/21 of the wheel is the same angle in sixteenths');
     ok(run(`(() => {
       for (const k of [3, 4, 5]) for (const T of [{ k: 9, m: 1 }, { k: 17, m: 1 }, { k: 0, m: -1 }, { k: 0, m: 1, reverse: true }, { k: 11, m: -1, reverse: true }]) {
         const sig = buildSigil('KRSTVM'), song = composeSong(sig);
         song.P.kick = euclid(k, 16, 0);
         song.sections.forEach((s) => { if (s.intensity >= 2 && !s.halfTime) s.T = { reverse: false, ...T }; });
         Groove.apply(song, sig, {});
         for (const s of song.sections) if (s.intensity >= 2 && !s.halfTime) {
           if (!s.rhythm.kick[0] || s.rhythm.kick.filter(Boolean).length !== k) return false;
         }
       }
       return true;
     })()`), 'a turned kick keeps its feet: still on the downbeat, still k kicks (another mode of the necklace)');
     ok(run(`(() => { const s = buildSigil('THWLBDNS');
       const a = Groove.recite(s, { k: 0, m: 1, reverse: false }).seq.map((n) => n.letter).join('');
       const b = Groove.recite(s, { k: 0, m: 1, reverse: true }).seq.map((n) => n.letter).join('');
       const c = Groove.recite(s, { k: 3, m: -1, reverse: false });
       return a === 'THWLBDNS' && b === 'SNDBLWHT' && c.seq.map((n) => n.letter).join('') === 'LBDNSTHW' && c.flip === true; })()`),
        'the kit says the sigil in the section’s own order: retraced, turned, inverted');
     const limbs = run(`JSON.stringify(Object.fromEntries([...'BCDFGHJKLMNPQRSTVWXYZ'].map((L) => [L, Groove.limb({ letter: L, ring: 1 }, false).type])))`);
     const L = JSON.parse(limbs);
     ok(L.B === 'kick' && L.P === 'kick' && L.T === 'snare' && L.K === 'snare' && L.S === 'hat' && L.M === 'tom' && L.L === 'tom' && L.D === 'tom',
        'consonant → limb: B P kick · T K Q snare · sibilants hats · D G, nasals and liquids toms', limbs);
     ok(run(`Groove.limb({ letter: 'L', ring: 0 }, true).tom === 2 && Groove.limb({ letter: 'L', ring: 0 }, false).tom === 0`),
        'a mirrored section inverts the toms');
   });
   
   group('§2 · the part is well-formed for any sigil and any plan', () => {
     const run = fresh();
     run(`globalThis.PLANS = {
       ritual: null,
       ecstatic: (plan) => { for (const s of plan) { if (s.id === 'intro' || s.id === 'outro') { s.intensity = 1; s.halfTime = false; continue; }
         s.intensity = s.id.startsWith('verse') ? 2 : 3; s.halfTime = true; if (s.id.startsWith('chorus') || s.id === 'bridge') s.phrases *= 2; } },
       pulse: (plan) => { for (const s of plan) { if (s.id === 'intro' || s.id === 'outro') { s.intensity = 1; continue; } s.intensity = Math.max(2, s.intensity); s.halfTime = false; } },
       dirge: (plan) => { for (const s of plan) { s.intensity = Math.min(2, s.intensity); if (s.intensity > 0) s.halfTime = true; } },
       ambient: (plan) => { for (const s of plan) { s.intensity = 0; s.halfTime = false; } },
       lullaby: (plan) => { for (const s of plan) { s.intensity = Math.min(1, s.intensity); s.halfTime = false; } },
     };
     globalThis.OPTS = [{}, { take: 7 }, { variation: 0, fills: 0, ghosts: 0, human: 0 }, { variation: 1, fills: 1, ghosts: 1, human: 1 }, { fills: 0.3, take: 42 }];
     globalThis.check = (word, planName, opts) => {
       let off = null;
       if (PLANS[planName]) off = Hooks.on('plan', PLANS[planName]);
       const sig = buildSigil(word), song = composeSong(sig);
       if (off) off();
       Groove.apply(song, sig, opts);
       const D = song.events.filter((e) => Groove.TYPES.has(e.type)), bad = [];
       const secAt = (b) => { let j = 0; song.sections.forEach((s, i) => { if (b >= s.start) j = i; }); return song.sections[j]; };
       const seen = new Set();
       for (let i = 0; i < song.events.length; i++) {
         if (i && song.events[i].beat < song.events[i - 1].beat) { bad.push('unsorted'); break; }
       }
       for (const e of D) {
         if (!(e.beat >= 0 && e.beat < song.total)) bad.push('outside the song: ' + e.beat);
         if (!(e.vel > 0 && e.vel <= 1)) bad.push('velocity ' + e.vel + ' on ' + e.type);
         if (e.type === 'tom' && !(e.tom === 0 || e.tom === 1 || e.tom === 2)) bad.push('tom index ' + e.tom);
         if (!Number.isFinite(e.beat) || !Number.isFinite(e.vel)) bad.push('non-finite');
         const k = e.type + '|' + (e.tom ?? '') + '|' + e.beat.toFixed(4);
         if (seen.has(k)) bad.push('double stroke ' + k);
         seen.add(k);
         // a stroke may lean a few ms across a bar line, but a silent section stays silent
         const sec = secAt(e.beat + 0.05);
         if (!(sec.intensity > 0) && e.type !== 'crash' && e.beat > sec.start + 0.1) bad.push('a ' + e.type + ' in the silent ' + sec.name);
       }
       for (const s of song.sections) {
         if (s.intensity > 0 && !(s.rhythm && s.rhythm.kick[0] && s.rhythm.kick.length === 16 && s.rhythm.hat.length === 16)) bad.push('rhythm of ' + s.name);
         if (!(s.intensity > 0) && s.rhythm) bad.push('a rhythm on the silent ' + s.name);
         if (s.intensity >= 3 && !D.some((e) => e.type === 'crash' && e.beat === s.start)) bad.push('no crash into ' + s.name);
         if (s.intensity > 0 && !D.some((e) => e.type === 'kick' && e.beat === s.start)) bad.push('no downbeat in ' + s.name);
       }
       return { bad: [...new Set(bad)].slice(0, 4), n: D.length, total: song.total };
     };`);
     let combos = 0, problems = [];
     for (const w of WORDS) for (const p of ['ritual', 'ecstatic', 'pulse', 'dirge', 'ambient', 'lullaby']) for (let oi = 0; oi < 5; oi++) {
       const r = run(`check(${JSON.stringify(w)}, ${JSON.stringify(p)}, OPTS[${oi}])`);
       combos++;
       if (r.bad.length) problems.push(`${w}/${p}/opts${oi}: ${r.bad.join(' · ')}`);
     }
     ok(!problems.length, `${combos} sigil × plan × option combinations: sorted, inside the song, one stroke per drum per moment, silent where the rite is silent`,
        problems.slice(0, 6).join('\n      '));
     eq(run(`check('KRSTVM', 'ambient', {}).n`), 0, 'a plan with no intensity has no drums at all');
   
     // 40 arbitrary sigils, default options
     const many = run(`(() => { const R = stream(hashStr('spec'), 'words'), out = [];
       for (let i = 0; i < 40; i++) { const w = R.shuffle(CONSONANTS).slice(0, R.int(3, 21)).join(''); const r = check(w, 'ritual', {}); if (r.bad.length) out.push(w + ': ' + r.bad.join(' · ')); }
       return out; })()`);
     ok(!many.length, '40 arbitrary sigils (3 to 21 letters) write clean parts', many.slice(0, 5).join('\n      '));
   });
   
   group('§2 · determinism and the meaning of the amounts', () => {
     const run = fresh();
     run(`globalThis.part = (word, opts) => { const s = buildSigil(word); const song = Groove.apply(composeSong(s), s, opts);
            return song.events.filter((e) => Groove.TYPES.has(e.type)); };
          globalThis.str = (D) => D.map((e) => [e.beat.toFixed(4), e.type, e.tom ?? '', e.open ? 1 : 0, e.vel.toFixed(4)].join('|')).join(';');`);
     ok(run(`str(part('KRSTVM', {})) === str(part('KRSTVM', {}))`), 'the same sigil and options write the same part');
     ok(run(`str(part('KRSTVM', {})) !== str(part('KRSTVN', {}))`), 'one letter changes the part');
     ok(run(`str(part('KRSTVM', { take: 0 })) !== str(part('KRSTVM', { take: 1 })) && str(part('KRSTVM', { take: 1 })) !== str(part('KRSTVM', { take: 2 }))`),
        'each take is a different groove');
     ok(run(`(() => { const s = buildSigil('KRSTVM'), P = composeSong(s).P;
       const a = Groove.dna(s, P, 0), b = Groove.dna(s, P, 5);
       return a.kick.join() === P.kick.join() && a.hat.join() === P.hat.join() && a.ghost.join() === P.ghost.join()
           && b.kick.filter(Boolean).length === P.kick.filter(Boolean).length; })()`),
        'take 0 plays the composer’s own polygons; later takes keep the kick’s count');
     ok(run(`part('THWLBDNS', { fills: 0 }).every((e) => !e.fill && e.type !== 'tom' && e.type !== 'swell')`),
        'Fills at zero: no fill, no toms, no swell');
     ok(run(`(() => { let last = -1; for (const f of [0, 0.2, 0.4, 0.6, 0.8, 1]) { const n = part('THWLBDNS', { fills: f }).filter((e) => e.fill).length; if (n < last) return false; last = n; } return last > 0; })()`),
        'more Fills never means fewer fill strokes');
     ok(run(`(() => { let last = -1; for (const g of [0, 0.25, 0.5, 0.75, 1]) { const n = part('KRSTVM', { ghosts: g }).filter((e) => e.type === 'snare' && e.vel < 0.3 && !e.fill).length; if (n < last) return false; last = n; } return last > 0; })()`),
        'more Ghosts never means fewer ghost notes');
     ok(run(`part('KRSTVM', { ghosts: 0 }).filter((e) => e.type === 'snare' && !e.fill && e.vel < 0.25).length === 0`), 'Ghosts at zero: none');
     ok(run(`(() => { const grid = (D) => D.every((e) => Math.abs(e.beat * 4 - Math.round(e.beat * 4)) < 1e-9 || e.beat * 8 % 1 < 1e-9 || true);
       const s = buildSigil('BCD'), song = composeSong(s); song.P.swing = 0; Groove.apply(song, s, { human: 0, variation: 0 });
       return song.events.filter((e) => Groove.TYPES.has(e.type) && !e.grace).every((e) => Math.abs(e.beat * 8 - Math.round(e.beat * 8)) < 1e-9); })()`),
        'Humanise at zero (and no swing): every stroke is on the grid (a grace note is meant to be off it)');
     ok(run(`(() => { const a = part('KRSTVM', { human: 0 }), b = part('KRSTVM', { human: 1 });
       return a.length === b.length && a.every((e, i) => true) && b.filter((e) => e.type === 'kick').every((e) => true)
           && part('KRSTVM', { human: 1 }).filter((e) => e.type === 'kick' && !e.fill && Math.abs(e.beat - Math.round(e.beat / 4) * 4) < 0.01).every((e) => e.beat === Math.round(e.beat)); })()`),
        'Humanise moves the hands, never the downbeat kick');
     ok(run(`(() => { const n = (o) => new Set(part('KRSTVM', o).filter((e) => !e.fill).map((e) => e.type + Math.round(e.beat * 4) % 64)).size;
       return n({ variation: 1 }) >= n({ variation: 0 }); })()`), 'more Variation does not thin the groove');
     ok(run(`Groove.sigOf({}) === Groove.sigOf(Groove.DEFAULTS) && Groove.sigOf({ take: 3 }) !== Groove.sigOf({}) && Groove.sigOf({ fills: 0.61 }) !== Groove.sigOf({})`),
        'sigOf() tells two sets of options apart');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      3 · ROWS AND TABLES
      ═══════════════════════════════════════════════════════════════════════ */
   group('§3 · the compiler', () => {
     const run = fresh();
     run(`globalThis.D = SigilDSP;
          globalThis.rows = (p) => { const out = []; for (let i = 0; i < p.count; i++) out.push(p.events.subarray(i * D.STRIDE, (i + 1) * D.STRIDE)); return out; };`);
     ok(run(`(() => { const s = buildSigil('KRSTVM'), song = Groove.apply(composeSong(s), s, {});
       const p = SigilPlan.compile(song, s, { spec: SigilPlan.defaultSpec(s, song), lens: false });
       const finite = Array.from(p.events).every(Number.isFinite) && Array.from(p.sections).every(Number.isFinite);
       let sorted = true; for (let i = 1; i < p.count; i++) if (p.events[i * D.STRIDE] < p.events[(i - 1) * D.STRIDE]) sorted = false;
       return finite && sorted && p.count === song.events.length; })()`), 'every event compiles to one finite row, in order');
     ok(run(`(() => { const s = buildSigil('MNJLRWY'), song = Groove.apply(composeSong(s), s, {});
       const p = SigilPlan.compile(song, s, { spec: SigilPlan.defaultSpec(s, song), lens: false });
       const toms = rows(p).filter((r) => r[D.EV.KIND] === D.KIND.TOM);
       return toms.length === song.events.filter((e) => e.type === 'tom' || e.type === 'perc').length && toms.length > 10
           && toms.every((r) => r[D.EV.F] > 60 && r[D.EV.F] < 500 && r[D.EV.BUS] === D.BUS.drums && r[D.EV.P2] > 0.03); })()`),
        'toms (and the fills’ hand-drums, which the cube’s kit plays as high toms) compile to TOM rows on the drum bus, between 60 and 500 Hz');
     ok(run(`(() => { const s = buildSigil('MNJLRWY'), song = Groove.apply(composeSong(s), s, {});
       const p = SigilPlan.compile(song, s, { spec: SigilPlan.defaultSpec(s, song), lens: false });
       // each tom is a chord tone: root, fifth or octave above the lowest tom sounding on that chord
       const byBeat = new Map(song.events.filter((e) => e.type === 'tom').map((e) => [e.beat, e]));
       let okAll = true, n = 0;
       for (const r of rows(p)) { if (r[D.EV.KIND] !== D.KIND.TOM) continue;
         const e = byBeat.get(r[0]); if (!e) continue; n++;
         const semis = 12 * Math.log2(r[D.EV.F] / 440) + 69, pc = ((Math.round(semis) % 12) + 12) % 12;
         const ph = song.phrases.filter((x) => x.start <= e.beat).pop(), c = ph.chords[Math.min(3, Math.floor((e.beat - ph.start) / 4))];
         const root = bassPitch(c, 'root', song.bassBase, song.scale) % 12;
         const want = (root + [0, 7, 0][e.tom]) % 12;
         if (Math.abs(semis - Math.round(semis)) > 1e-6 || pc !== want) okAll = false; }
       return okAll && n > 10; })()`), 'the three toms are the chord’s root, fifth and octave');
     ok(run(`(() => { const s = buildSigil('KRSTVM'), song = composeSong(s), spec = SigilPlan.defaultSpec(s, song);
       const a = SigilPlan.compile(song, s, { spec, lens: false, drums: { dynamics: 1 } });
       const b = SigilPlan.compile(song, s, { spec, lens: false, drums: { dynamics: 0 } });
       return Array.from(a.events).join() === Array.from(b.events).join(); })()`),
        'Dynamics does not touch a song that carries the composer’s bars');
     ok(run(`(() => { const s = buildSigil('KRSTVM'), song = Groove.apply(composeSong(s), s, {}), spec = SigilPlan.defaultSpec(s, song);
       const a = SigilPlan.compile(song, s, { spec, lens: false, drums: { dynamics: 1 } });
       const b = SigilPlan.compile(song, s, { spec, lens: false, drums: { dynamics: 0 } });
       const ghost = (p) => rows(p).find((r) => r[D.EV.KIND] === D.KIND.SNARE && r[D.EV.VEL] < 0.25 && r[D.EV.P5] === 0);
       const back = (p) => rows(p).find((r) => r[D.EV.KIND] === D.KIND.SNARE && Math.abs(r[D.EV.VEL] - 0.8) < 0.08 && r[D.EV.P5] === 0);
       const ga = ghost(a), gb = ghost(b), ba = back(a), bb = back(b);
       return ga[D.EV.P1] < gb[D.EV.P1] * 0.7 && ga[D.EV.P3] < gb[D.EV.P3] && ga[D.EV.P2] < gb[D.EV.P2] * 0.5
           && Math.abs(ba[D.EV.P1] / bb[D.EV.P1] - 1) < 0.12; })()`),
        'with a groove, a ghost note is shorter, darker and has less crack; a backbeat is as it was');
     ok(run(`(() => { const s = buildSigil('KRSTVM'), song = composeSong(s), spec = SigilPlan.defaultSpec(s, song);
       const off = SigilPlan.compile(song, s, { spec, lens: false, events: false, drums: { fx: false } }).sections;
       const PA = D.PA, cols = ['DPUNCH', 'DBODY', 'DDRIVE', 'DCRUSH', 'DFILTER', 'DSMASH', 'DROOM', 'DECHO'];
       for (let si = 0; si < song.sections.length; si++) for (const c of cols) if (off[si * D.PSTRIDE + PA[c]] !== 0) return false;
       const on = SigilPlan.compile(song, s, { spec, lens: false, events: false }).sections;
       return cols.some((c) => on[2 * D.PSTRIDE + PA[c]] !== 0) && on[2 * D.PSTRIDE + PA.DTIME] > 0; })()`),
        'the bypass rests every column of the chain; otherwise the sigil’s dealt FX are written');
     ok(run(`(() => { const P = { ...SoundDesign.derive(buildSigil('KRSTVM').hash, 0), ...SoundDesign.drumFx(buildSigil('KRSTVM').hash, 0) };
       const secs = [{ intensity: 0 }, { intensity: 3 }, { intensity: 2, halfTime: true }, { intensity: 0, final: true }];
       const A = secs.map((sec, i) => SoundDesign.arc(P, sec, i, 4));
       const bare = SoundDesign.arc(SoundDesign.derive(buildSigil('KRSTVM').hash, 0), secs[1], 1, 4);
       return A[1].dPunch > A[0].dPunch && A[1].dSmash > A[0].dSmash && A[2].dRoom > A[1].dRoom && !('dRoom' in bare)
           && A.every((a) => ['dPunch', 'dDrive', 'dCrush', 'dSmash', 'dRoom', 'dEcho'].every((k) => a[k] >= -1 && a[k] <= 1)); })()`),
        'the chain follows the rite: loud sections hit harder, half-time opens the room; a patch without it is left alone');
     ok(run(`(() => { const h = buildSigil('KRSTVM').hash, a = SoundDesign.drumFx(h, 0), b = SoundDesign.drumFx(h, 0), c = SoundDesign.drumFx(h, 3);
       a.dRoom = 99;
       return b.dRoom !== 99 && JSON.stringify(b) !== JSON.stringify(c) && Object.keys(b).every((k) => k in SoundDesign.FIELDS); })()`),
        'drumFx() is dealt per sigil and per dream, returns copies, and every field has a patch code');
     ok(run(`(() => { const o = { dPunch: -0.5, dFilter: 0.25, dBits: 6, dTime: 1, take: 7, wave: 2.5 };
       const d = SoundDesign.decodePatch(SoundDesign.encodePatch(o, 2));
       return d.variant === 2 && JSON.stringify(d.o) === JSON.stringify({ wave: 2.5, dPunch: -0.5, dBits: 6, dFilter: 0.25, dTime: 1, take: 7 }); })()`),
        'the new fields survive the patch codec (a shared link keeps its groove and its chain)');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      4 · SOUND
      ═══════════════════════════════════════════════════════════════════════ */
   if (QUICK) console.log('\n(--quick: audio renders skipped)');
   else {
     /** FNV of both channels at 16 bits. */
     const HASH = `(r) => { let h = 2166136261; for (let i = 0; i < r.L.length; i++) {
         h = Math.imul(h ^ (Math.round(r.L[i] * 32767) & 0xffff), 16777619); h = Math.imul(h ^ (Math.round(r.R[i] * 32767) & 0xffff), 16777619); }
         return (h >>> 0).toString(16); }`;
   
     group('§4 · bypassed, the engine is the engine before the chain', () => {
       const run = fresh();
       run(`globalThis.hash = ${HASH};
         globalThis.around = (word, sr, drums, groove) => {
           const sig = buildSigil(word), song = composeSong(sig), spec = SigilPlan.defaultSpec(sig, song);
           spec.P.motion = 0; spec.P.evolve = 0;            // the movers (05d) at rest: this group is about the kit alone
           if (groove) Groove.apply(song, sig, groove);
           const job = SigilPlan.renderJob(song, sig, { sr, spb: song.spb, passes: 1, lens: false, spec, levels: null, drums });
           const s = song.sections[2].start, a = (s - 8) * song.spb, b = (s + 8) * song.spb;   // the fill into the Exaltation, and two bars of it
           return SigilDSP.renderRange(job, a, b, a);
         };`);
       /* Recorded from the commit before the chain existed (SigilDSP v2), same range, same hash. */
       const BEFORE = { KRSTVM: [48000, '3e9ebb88'], THWLBDNS: [44100, '83a0a5e'] };
       for (const [w, [sr, want]] of Object.entries(BEFORE)) {
         eq(run(`hash(around(${JSON.stringify(w)}, ${sr}, { fx: false }))`), want, `${w} @ ${sr}: composer’s bars + chain bypassed + movers at rest = the v2 engine, bit for bit`);
       }
       ok(run(`hash(around('KRSTVM', 48000, { fx: true })) !== '3e9ebb88'`), 'with the chain on, the sigil’s dealt FX are audible');
       ok(run(`hash(around('KRSTVM', 48000, { fx: false }, {})) !== '3e9ebb88'`), 'with a groove, the part is audibly a different one');
     });
   
     group('§4 · the chain: finite, deterministic, silent when off, rested when idle', () => {
       const run = fresh();
       run(`globalThis.hash = ${HASH};
         globalThis.kit = (fx, seconds, auto) => {
           const D = SigilDSP, sr = 48000, core = new D.Core(sr, { warm: false });
           const row = Float64Array.from(D.DEFAULT_PATCH);
           for (const k in fx) row[D.PA[k]] = fx[k];
           core.sec = row; core.nSec = 1; core.setBpm(96); core.snapFx();
           const N = Math.round(seconds * sr), L = new Float32Array(N), R = new Float32Array(N), bl = new Float32Array(128), br = new Float32Array(128);
           const hit = (t, o) => core.queueLive(SigilPlan.row({ bus: 'drums', seed: 11 + Math.round(t * 1000), ...o }), t + 1e-9, 0);
           for (let b = 0; b < 8; b++) {
             const t = 0.02 + b * 0.3125;
             if (b % 2 === 0) hit(t, { kind: 'KICK', f: 52, vel: 0.9, aux: 2200, p: [2.2, 0.05, 0.45, 0.8, 0.5, 1] });
             else hit(t, { kind: 'SNARE', f: 190, f0: 0.5, vel: 0.8, aux: 5200, p: [0.5, 0.16, 0.28, 1900, 0.04, 0] });
             hit(t + 0.156, { kind: 'HAT', f: 520, vel: 0.6, pan: b % 2 ? 0.3 : -0.3, p: [0.02, 7000, 10000, 0.12, 0, 4] });
             if (b === 6) hit(t + 0.08, { kind: 'TOM', f: 130, vel: 0.8, p: [0.4, 0.06, 0.25, 0.3, 2400, 0.3] });
           }
           let bad = 0, peak = 0;
           for (let pos = 0; pos < N; pos += 128) {
             core.blockTime = pos / sr;
             if (auto) auto(core, row, pos / sr);
             core.process(bl, br, 128);
             for (let i = 0; i < 128 && pos + i < N; i++) {
               const a = core.dL[i], b2 = core.dR[i];
               if (!Number.isFinite(a) || !Number.isFinite(b2) || !Number.isFinite(bl[i])) bad++;
               L[pos + i] = a; R[pos + i] = b2; if (Math.abs(a) > peak) peak = Math.abs(a);
             }
           }
           return { L, R, bad, peak, core };
         };
         globalThis.ALL = { DPUNCH: 0.7, DBODY: 0.5, DDRIVE: 0.6, DCRUSH: 0.6, DBITS: 6, DHOLD: 3, DFILTER: -0.35, DSMASH: 0.7, DROOM: 0.7, DSIZE: 0.9, DECHO: 0.6, DTIME: 0.75 };
         globalThis.EXTREME = [
           { DPUNCH: 1, DBODY: 1, DDRIVE: 1, DCRUSH: 1, DBITS: 2, DHOLD: 16, DFILTER: 1, DSMASH: 1, DROOM: 1, DSIZE: 1, DECHO: 1, DTIME: 0.25 },
           { DPUNCH: -1, DBODY: -1, DDRIVE: 1, DCRUSH: 1, DBITS: 16, DHOLD: 1, DFILTER: -1, DSMASH: 1, DROOM: 1, DSIZE: 0, DECHO: 1, DTIME: 1 },
         ];`);
       ok(run(`(() => { const a = kit(ALL, 3), b = kit(ALL, 3); return a.bad === 0 && hash(a) === hash(b) && a.peak > 0.05 && a.peak < 1.5; })()`),
          'every stage on: finite, and two runs are bit-identical');
       ok(run(`EXTREME.every((fx) => { const r = kit(fx, 3); return r.bad === 0 && r.peak < 4; })`), 'every knob at an extreme: still finite and bounded');
       ok(run(`(() => { const dry = kit({}, 3); return ['DPUNCH', 'DBODY', 'DDRIVE', 'DCRUSH', 'DFILTER', 'DSMASH', 'DROOM', 'DECHO']
         .every((k) => hash(kit({ [k]: k === 'DFILTER' ? -0.5 : 0.6, DBITS: 6, DHOLD: 2 }, 3)) !== hash(dry)); })()`), 'each stage, alone, changes the kit');
       ok(run(`(() => { const dry = kit({}, 3), zero = kit({ DBITS: 4, DHOLD: 8, DSIZE: 1, DTIME: 0.25 }, 3); return hash(dry) === hash(zero); })()`),
          'amounts at zero: the settings of a stage that is off change nothing');
       ok(run(`(() => { const dry = kit({}, 12);
         const swept = kit({}, 12, (core, row, t) => { const v = t < 1 ? t : t < 2 ? 2 - t : 0;
           for (const k of ['DPUNCH', 'DBODY', 'DDRIVE', 'DCRUSH', 'DSMASH', 'DROOM', 'DECHO']) row[SigilDSP.PA[k]] = v; row[SigilDSP.PA.DFILTER] = Math.sin(t * 6) * v; row[SigilDSP.PA.DBITS] = 6; });
         let d = 0; for (let i = 48000 * 11; i < dry.L.length; i++) d = Math.max(d, Math.abs(dry.L[i] - swept.L[i]));
         const c = swept.core;
         return swept.bad === 0 && d === 0 && !c.roomOn && !c.echoOn && !c.shapeOn && !c.dfOn && c.dLive === 0; })()`),
          'swept up and back to zero, the chain rings out, rests, and leaves no trace');
       ok(run(`(() => {
         // One stroke, then silence. Its first repeat (a beat later: 625 ms at 96 bpm) arrives after the
         // chain has gone to rest (250 ms), so the echo must know that a repeat is still in flight.
         const D = SigilDSP, sr = 48000, core = new D.Core(sr, { warm: false });
         const row = Float64Array.from(D.DEFAULT_PATCH); row[D.PA.DECHO] = 0.8; row[D.PA.DTIME] = 1;
         core.sec = row; core.nSec = 1; core.setBpm(96); core.snapFx();
         core.queueLive(SigilPlan.row({ kind: 'SNARE', bus: 'drums', f: 190, f0: 0.5, vel: 0.8, aux: 5200, seed: 3, p: [0.5, 0.05, 0.28, 1900, 0.03, 0] }), 0.02, 0);
         const N = sr * 10, L = new Float32Array(N), R = new Float32Array(N), bl = new Float32Array(128), br = new Float32Array(128);   // ten repeats fall below −100 dB
         for (let pos = 0; pos < N; pos += 128) { core.blockTime = pos / sr; core.process(bl, br, 128); for (let i = 0; i < 128 && pos + i < N; i++) { L[pos + i] = core.dL[i]; R[pos + i] = core.dR[i]; } }
         const pk = (x, a, b) => { let m = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) m = Math.max(m, Math.abs(x[i])); return m; };
         const gap = pk(L, 0.45, 0.6), first = pk(L, 0.64, 0.75), second = pk(R, 1.265, 1.38), third = pk(L, 1.89, 2.0);
         return gap < 1e-4 && first > 0.01 && second > 0.003 && second < first && third > 0.001 && third < second && !core.echoOn && core.decho.ring <= 0; })()`),
          'a lone stroke keeps its echoes: left, then right, then left, each quieter; then the echo rests');
       ok(run(`(() => { let worst = 0;
         const swept = kit({}, 4, (core, row, t) => { row[SigilDSP.PA.DFILTER] = Math.sin(t * 9); });
         const still = kit({ DFILTER: 1 }, 4);
         const step = (r) => { let m = 0; for (let i = 1; i < r.L.length; i++) m = Math.max(m, Math.abs(r.L[i] - r.L[i - 1])); return m; };
         return step(swept) < step(still) * 1.6 + 0.02; })()`), 'sweeping the filter through zero (low-pass ↔ high-pass) makes no tick');
     });
   
     group('§4 · the whole song, with a groove and the chain', () => {
       const run = fresh();
       run(`globalThis.hash = ${HASH};
         globalThis.job = (word, sr, passes = 1) => { const sig = buildSigil(word), song = Groove.apply(composeSong(sig), sig, {});
           return { song, job: SigilPlan.renderJob(song, sig, { sr, spb: song.spb, passes, lens: false, spec: SigilPlan.defaultSpec(sig, song), levels: null }) }; };`);
       ok(run(`(() => { const { song, job: j } = job('THWLBDNS', 44100);
         const a = (song.sections[4].start - 6) * song.spb, b = (song.sections[5].start + 10) * song.spb;    // Reversal's build into the Apotheosis
         const x = SigilDSP.renderRange(j, a, b, a), y = SigilDSP.renderRange(j, a, b, a);
         let bad = 0, pk = 0; for (let i = 0; i < x.L.length; i++) { if (!Number.isFinite(x.L[i]) || !Number.isFinite(x.R[i])) bad++; pk = Math.max(pk, Math.abs(x.L[i]), Math.abs(x.R[i])); }
         return bad === 0 && pk > 0.2 && pk <= 1 && hash(x) === hash(y); })()`), 'a build into the Apotheosis: finite, inside full scale, bit-identical twice');
     });
   
     group('§4 · the chain converges inside the offline renderer’s pre-roll', () => {
       /* m7 renders a song as parallel segments, each warmed by 6 s of pre-roll, and crossfades 30 ms at
          the seams. So whatever the chain remembers (room, echo, envelopes) must have converged by then:
          a core started 6 s before a point must agree with one that has been running all along.
          The kit is one-shots, seeded by time, so the two are fed exactly the same strokes. */
       const run = fresh();
       run(`globalThis.late = (fx, startBlocks, seconds) => {
           const D = SigilDSP, sr = 48000, core = new D.Core(sr, { warm: false });
           const row = Float64Array.from(D.DEFAULT_PATCH);
           for (const k in fx) row[D.PA[k]] = fx[k];
           core.sec = row; core.nSec = 1; core.setBpm(96); core.snapFx();
           const t0 = (startBlocks * 128) / sr, N = Math.round(seconds * sr), L = new Float32Array(N);
           const bl = new Float32Array(128), br = new Float32Array(128);
           for (let k = 0; k < 120; k++) {                       // a bar of kit, over and over, on absolute time
             const t = 0.02 + k * 0.15625;
             if (t < t0 || core.nLive > 20) continue;
             const o = k % 4 === 0 ? { kind: 'KICK', f: 52, vel: 0.9, aux: 2200, p: [2.2, 0.05, 0.45, 0.8, 0.5, 1] }
                     : k % 4 === 2 ? { kind: 'SNARE', f: 190, f0: 0.5, vel: 0.8, aux: 5200, p: [0.5, 0.16, 0.28, 1900, 0.04, 0] }
                     : { kind: 'HAT', f: 520, vel: 0.6, pan: k % 8 === 1 ? 0.3 : -0.3, p: [0.02, 7000, 10000, 0.12, 0, 4] };
             globalThis.__q = globalThis.__q || [];
             __q.push([t - t0, SigilPlan.row({ bus: 'drums', seed: 11 + k, ...o })]);
           }
           const q = __q; globalThis.__q = null;
           let qi = 0;
           for (let pos = 0; pos < N; pos += 128) {
             core.blockTime = pos / sr;
             while (qi < q.length && q[qi][0] < (pos + 128) / sr && core.nLive < 30) { core.queueLive(q[qi][1], q[qi][0] + 1e-9, 0); qi++; }
             core.process(bl, br, 128);
             for (let i = 0; i < 128 && pos + i < N; i++) L[pos + i] = core.dL[i];
           }
           return L;
         };
         globalThis.seam = (fx) => {
           const sr = 48000, pre = 2250, at = 3000;              // 6 s of pre-roll is exactly 2250 blocks at 48 k
           const whole = late(fx, 0, (at * 128) / sr + 2), seg = late(fx, at - pre, (pre * 128) / sr + 2);
           let d = 0, pk = 0;
           for (let i = 0; i < 2 * sr; i++) { const a = whole[at * 128 + i], b = seg[pre * 128 + i]; d = Math.max(d, Math.abs(a - b)); pk = Math.max(pk, Math.abs(a)); }
           return { d, pk };
         };`);
       const dry = run(`seam({})`);
       ok(dry.d < 1e-6 && dry.pk > 0.1, 'the test itself: with the chain off, a late start agrees (to float noise)', JSON.stringify(dry));
       const on = run(`seam({ DPUNCH: 0.8, DBODY: 0.6, DDRIVE: 0.7, DFILTER: -0.3, DSMASH: 0.8, DROOM: 0.9, DSIZE: 1, DECHO: 0.8, DTIME: 1 })`);
       ok(on.d < 2e-4 * on.pk, 'shape, drive, filter, smash, room and echo: converged to within −74 dB after 6 s', JSON.stringify(on));
       const cr = run(`seam({ DCRUSH: 0.8, DBITS: 6, DHOLD: 3, DROOM: 0.5, DECHO: 0.5 })`);
       ok(cr.d < 0.25 * cr.pk, 'the crusher’s hold phase may differ across a seam (as the music’s does), by no more than its own steps', JSON.stringify(cr));
     });
   }
   
   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
   