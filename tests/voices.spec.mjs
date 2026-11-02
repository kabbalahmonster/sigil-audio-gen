/* ══════════════════════════════════════════════════════════════════════════
   VOICES SPEC — the palette, its instruments and the fills. No browser, no dependencies.

     node tests/voices.spec.mjs            everything (a few minutes)
     node tests/voices.spec.mjs --quick    skip the audio (every instrument, note by note, and the render)

   What it defends
     1. The palette is dealt well: every world has someone for every part it casts; a sigil is dealt the same palette
        for ever; different sigils, moods and styles are dealt different ones, and the asks of a song are heard (a
        Dirge is not in the Toybox); the listener's word (another deal, the cube's own voices, an instrument by id) is
        the last.
     2. Instruments are numbers in the core's table: packed in a frozen order, nudged by the sigil within what each can
        bear, the same every time. The ids are pinned (tests/golden.json pins a deal; this pins the rest).
     3. Compiled, a song is rows the core can play: finite, in order, the right kind for the part, a pad one row per
        note. With the palette off, or asked not to, it is the rows it always was.
     4. Fills: a dozen figures, chosen by where the bar falls, the same every time; every one of them is played; none
        leaves its bar; the sigil's name still gets said; and a pass that turns round the body turns on a fill, the
        pass that ends it does not.
     5. Heard (unless --quick): every instrument in every part it can play, at the ends and the middle of the part's
        own range: finite, bounded, not silent, ended, not a click or a DC offset, the same twice; tonal ones in tune;
        and, in a real song, each about as loud as the cube's own voice of that part (the gains are measured, in
        tools/calibrate-voices.mjs).
   ══════════════════════════════════════════════════════════════════════════ */
   import { scoreSandbox, loadPartJs, partJob, listen, packed, note, stats, pitch, realm, WORDS, bootCore } from '../tools/voice-lab.mjs';

   const QUICK = process.argv.includes('--quick');
   const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);   // --only=harp,koto: just these instruments (keys) in §5
   let pass = 0, fail = 0;
   const ok = (cond, label, detail) => {
     if (cond) { pass++; console.log(`  ✓ ${label}`); }
     else { fail++; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
   };
   const group = (name, fn) => { console.log(`\n${name}`); try { fn(); } catch (e) { ok(false, `${name}: threw`, String((e && e.stack) || e)); } };
   
   const run = scoreSandbox();
   loadPartJs(run);
   const J = (code) => JSON.parse(run(`JSON.stringify(${code})`));
   
   /* ═══════════════════════════════════════════════════════════════════════
      1 · THE PALETTE
      ═══════════════════════════════════════════════════════════════════════ */
   group('§1 · the palette is dealt', () => {
     const info = J(`(() => {
       const I = [...Palette.INST.values()], W = Palette.WORLDS, bad = [], empty = [];
       for (const w of W) for (const r of Palette.ROLES) {
         const l = w.cast[r] || [];
         if (!l.length) { if (w.id !== 'cube') empty.push(w.id + ':' + r); continue; }
         for (const k of l) { const d = Palette.BY_KEY.get(k); if (!d) bad.push(w.id + ':' + r + ':' + k + ' (unknown)'); else if (!d.roles.includes(r)) bad.push(w.id + ':' + r + ':' + k + ' (cannot play it)'); }
       }
       const params = [];
       for (const d of I) if (d.engine !== 'cube') for (const k of Object.keys(d.params)) if (!Palette.PARAMS[d.engine].includes(k)) params.push(d.key + '.' + k);
       const engines = {}; for (const d of I) engines[d.engine] = (engines[d.engine] || 0) + 1;
       return { n: I.length, worlds: W.length, bad, empty, params, engines, ids: new Set(I.map((d) => d.id)).size, keys: new Set(I.map((d) => d.key)).size, max: Math.max(...I.map((d) => d.id)) };
     })()`);
     ok(info.n >= 90 && info.ids === info.n && info.keys === info.n, `${info.n} instruments, each with its own id and name`);
     ok(info.worlds >= 20, `${info.worlds} worlds`);
     ok(info.bad.length === 0, 'every instrument a world casts exists and can play the part it is cast in', info.bad.join(', '));
     ok(info.empty.length === 0, 'every world has someone for every part (the cube’s own world leaves the kit to the cube)', info.empty.join(', '));
     ok(info.params.length === 0, 'every number an instrument sets is one its engine has', info.params.join(', '));
     ok(Object.keys(info.engines).filter((e) => e !== 'cube').length === 8 && Object.entries(info.engines).every(([e, n]) => e === 'cube' || n >= 4), `eight engines, each with at least four instruments (${JSON.stringify(info.engines)})`);
   
     // dealing
     // sigils: eight different consonants, by a small generator of our own
     let seed = 0x9e3779b9;
     const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
     const sigilWord = () => { const c = [...'BCDFGHJKLMNPQRSTVWXYZ']; let w = ''; for (let i = 0; i < 8; i++) w += c.splice(Math.floor(rnd() * c.length), 1)[0]; return w; };
     const words = Array.from({ length: 240 }, sigilWord);
     const deals = J(`(() => { const out = []; const moods = ['ritual', 'ambient', 'dirge', 'ecstatic', 'mischief', 'hymn', 'wrath', 'lullaby'], els = ['fire', 'water', 'air', 'earth'];
       for (const w of ${JSON.stringify(words)}) { const sg = buildSigil(w), d = Palette.deal(sg, { mood: moods[out.length % 8], element: els[out.length % 4] }, 0); out.push([d.world, d.roles.lead, d.roles.bass, d.roles.pad]); }
       return out; })()`);
     const byWorld = {};
     for (const [w] of deals) byWorld[w] = (byWorld[w] || 0) + 1;
     ok(Object.keys(byWorld).length >= 17, `240 sigils are dealt ${Object.keys(byWorld).length} of the ${info.worlds} worlds`, JSON.stringify(byWorld));
     ok(Math.max(...Object.values(byWorld)) < 240 * 0.2, 'no world is dealt to more than a fifth of them');
     ok(new Set(deals.map((d) => d[1])).size >= 30, `${new Set(deals.map((d) => d[1])).size} different instruments play the lead`);
     ok(new Set(deals.map((d) => d[2])).size >= 10 && new Set(deals.map((d) => d[3])).size >= 10, `and ${new Set(deals.map((d) => d[2])).size} the bass, ${new Set(deals.map((d) => d[3])).size} the pad`);
   
     const again = J(`(() => { const sg = buildSigil('KRSTVM'); return [Palette.deal(sg, { mood: 'dirge' }, 0), Palette.deal(sg, { mood: 'dirge' }, 0), Palette.deal(sg, { mood: 'dirge' }, 1), Palette.deal(sg, { mood: 'dirge' }, 2)]; })()`);
     ok(JSON.stringify(again[0]) === JSON.stringify(again[1]), 'a sigil is dealt the same palette each time');
     ok(JSON.stringify(again[0]) !== JSON.stringify(again[2]) || JSON.stringify(again[0]) !== JSON.stringify(again[3]), 'and another deal is another palette');
   
     // what the song asks for
     const lean = J(`(() => { const POOL = ${JSON.stringify(words.slice(0, 200))}; const tally = (cfg) => { const t = {}; for (const x of ${JSON.stringify(words.slice(0, 1))}) void x; for (const w of POOL) { const k = Palette.deal(buildSigil(w), cfg, 0).world; t[k] = (t[k] || 0) + 1; } return t; };
       return { dirge: tally({ mood: 'dirge' }), mischief: tally({ mood: 'mischief' }), metal: tally({ style: 'metal' }), lofi: tally({ style: 'lofi' }), folk: tally({ style: 'folk' }), chip: tally({ style: 'chiptune' }), none: tally({}) }; })()`);
     const sum = (t, ...ws) => ws.reduce((a, w) => a + (t[w] || 0), 0);
     ok(sum(lean.dirge, 'toybox', 'circuit', 'neon') < sum(lean.mischief, 'toybox', 'circuit', 'neon'), 'a Dirge is cast in the Toybox less than Mischief is', `${JSON.stringify(lean.dirge)} / ${JSON.stringify(lean.mischief)}`);
     ok(sum(lean.metal, 'storm', 'foundry') > sum(lean.none, 'storm', 'foundry') * 1.5, 'Metal leans on the Storm and the Foundry');
     ok(sum(lean.lofi, 'smoke', 'velvet', 'dream') > sum(lean.none, 'smoke', 'velvet', 'dream') * 1.4, 'Lo-fi on Smoke, Velvet and Dream');
     ok(sum(lean.folk, 'meadow', 'hollow') > sum(lean.none, 'meadow', 'hollow') * 1.5, 'Folk on the Meadow and the Hollow');
     ok(sum(lean.chip, 'circuit', 'toybox') > sum(lean.none, 'circuit', 'toybox') * 1.8, 'Chiptune on the Circuit and the Toybox');
     ok(Object.keys(lean.none).length >= 15, 'and with nothing asked for the whole of the palette is in play');
   
     // the listener's word
     const cast = J(`(() => { const sg = buildSigil('KRSTVM'), cfg = { mood: 'ritual' }, d = Palette.cast(sg, cfg, {});
       return { d: d.roles, off: Palette.cast(sg, cfg, { palOff: 1 }), one: Palette.cast(sg, cfg, { iLead: 10, iBass: 16 }).roles, bad: Palette.cast(sg, cfg, { iLead: 9999, iBass: 10 }).roles,
                other: Palette.cast(sg, cfg, { pal: 3 }).roles, ch: Palette.cast(sg, cfg, { pal: 3 }).world, w0: d.world }; })()`);
     ok(cast.off.classic && Object.values(cast.off.roles).every((id) => id === 0 || id <= 8), 'the cube’s own voices: every part is the cube’s (or the kit’s)');
     ok(cast.one.lead === 10 && cast.one.bass === 16 && cast.one.pad === cast.d.pad, 'an instrument named for a part is that part’s, and the others are as dealt');
     ok(cast.bad.lead === cast.d.lead, 'an id that is no instrument is ignored');
     ok(cast.other.lead !== undefined, 'another deal is a palette too');
   
     // the room
     const rooms = J(`(() => { const sg = buildSigil('KRSTVM'); return Palette.WORLDS.map((w) => { const r = Palette.resolve(sg, {}, { roles: Object.fromEntries(Palette.ROLES.filter((x) => w.cast[x] && w.cast[x][0]).map((x) => [x, Palette.BY_KEY.get(w.cast[x][0]).id])) }); return [w.id, w.hall, w.space, r.table.length, Palette.ROLES.every((x) => !w.cast[x] || !w.cast[x].length || r.roles[x]) ]; }); })()`);
     ok(rooms.every((r) => r[3] === 16 * 24 && r[4]), 'every world packs into the core’s table');
     ok(new Set(rooms.map((r) => JSON.stringify([r[1], r[2]]))).size >= 12, 'and has its own room (size, damping, how much of it)');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      2 · THE TABLE
      ═══════════════════════════════════════════════════════════════════════ */
   group('§2 · packing', () => {
     const t = J(`(() => {
       const out = { sizes: [], within: true, differ: 0, same: true, finite: true, kinds: new Set() };
       const a = buildSigil('KRSTVM'), b = buildSigil('PCNDQTVRMZ');
       for (const d of Palette.INST.values()) {
         if (d.engine === 'cube') continue;
         for (const role of d.roles) {
           const pa = Palette.pack(d, a, role, 0), pb = Palette.pack(d, b, role, 0), pa2 = Palette.pack(d, a, role, 0);
           if (pa.some((x, i) => x !== pa2[i])) out.same = false;
           if (pa.some((x) => !Number.isFinite(x))) out.finite = false;
           if (pa.some((x, i) => x !== pb[i])) out.differ++;
           out.kinds.add(pa[0]);
           // nudged, but never out of what the instrument can bear
           const names = Palette.PARAMS[d.engine];
           names.forEach((nm, i) => { const base = d.params[nm] ?? 0, x = pa[2 + i]; if (base !== 0 && Math.abs(x - base) > Math.max(Math.abs(base) * 0.6, 0.16) + 1e-9) out.within = false; });
         }
       }
       out.kinds = [...out.kinds];
       return out; })()`);
     ok(t.same && t.finite, 'packing an instrument for a sigil is the same every time, and finite');
     ok(t.within, 'the sigil’s nudge never takes an instrument out of what it can bear');
     ok(t.differ > 100, 'and two sigils are two players: the same instrument has different numbers');
     ok(JSON.stringify(t.kinds.sort((x, y) => x - y)) === JSON.stringify([15, 16, 17, 18, 19, 20, 21, 22]), 'the eight engines’ kinds, 15 to 22');
     // a pinned instrument: ids and numbers are for ever
     const pin = J(`(() => { const sg = buildSigil('KRSTVM'), d = Palette.instrument(10), v = Palette.pack(d, sg, 'lead', 0); return [d.key, d.engine, v[0], v.slice(2, 8).map((x) => +x.toFixed(4))]; })()`);
     ok(pin[0] === 'harp' && pin[1] === 'pluck' && pin[2] === 15, 'id 10 is the harp, for ever');
     ok(J(`[1, 10, 30, 50, 70, 90, 100, 110, 120, 130].map((i) => Palette.instrument(i).key)`).join() === 'cube-wave,harp,marimba,conga,supersaw,tonewheel,epiano,flute,ping,shimmer', 'and the first of each engine is where it was');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      3 · COMPILED
      ═══════════════════════════════════════════════════════════════════════ */
   group('§3 · rows', () => {
     const r = J(`(() => {
       const out = [];
       for (const w of ${JSON.stringify(WORDS)}) {
         const sg = buildSigil(w), song = composeSong(sg);
         const on = SigilPlan.compile(song, sg, {}), off = SigilPlan.compile(song, sg, { palette: false });
         const D = SigilDSP, S = D.STRIDE;
         let sorted = true, finite = true, kinds = new Set(), slots = 0, bad = 0;
         for (let i = 0; i < on.count; i++) {
           const o = i * S, k = on.events[o + 1] & 255;
           if (i && on.events[o] < on.events[o - S]) sorted = false;
           for (let j = 0; j < S; j++) if (!Number.isFinite(on.events[o + j])) finite = false;
           kinds.add(k);
           if (k >= 15) { const sl = on.events[o + D.EV.P0]; if (!(sl >= 0 && sl < 13 && sl === Math.floor(sl))) bad++; else slots++; }
         }
         const pal = on.pal, roles = Object.fromEntries(Object.entries(pal.roles).map(([r, d]) => [r, d && d.engine]));
         // the rows of the cube's own voices, with the palette off: exactly as many as there are notes
         let offKinds = 0; for (let i = 0; i < off.count; i++) if ((off.events[i * S + 1] & 255) >= 15) offKinds++;
         const padN = song.events.filter((e) => e.type === 'pad').reduce((a, e) => a + e.midis.length, 0), padE = song.events.filter((e) => e.type === 'pad').length;
         out.push({ w, world: pal.world, count: on.count, off: off.count, n: song.events.length, sorted, finite, kinds: [...kinds], slots, bad, offKinds, inst: on.inst ? on.inst.length : 0, roles, padN, padE });
       }
       return out; })()`);
     for (const x of r) {
       ok(x.sorted && x.finite && x.bad === 0, `${x.w} (${x.world}): every row finite, in order, and a palette row names a slot of the table`);
       ok(x.offKinds === 0 && x.off === x.n, `  with the palette off: ${x.off} rows for ${x.n} notes, and none of them is an instrument’s`);
     }
     ok(r.some((x) => x.slots > 100), 'the palette’s rows are there (an instrument per row of the part that is dealt one)');
     ok(r.every((x) => x.inst === 384 || x.world === 'cube'), 'the table is sent with the plan');
   
     // a pad dealt an instrument is one row a note; a drone is a root and its fifth
     const pads = J(`(() => { const sg = buildSigil('${WORDS[0]}'), song = composeSong(sg), spec = SigilPlan.defaultSpec(sg, song);
       const mk = (roles) => { spec.P = { ...spec.P, roles }; const p = SigilPlan.compile(song, sg, { spec }); const rows = []; for (let i = 0; i < p.count; i++) rows.push(Array.from(p.events.subarray(i * 16, i * 16 + 16))); return rows; };
       const a = mk({ pad: 79, drone: 80 }), pd = song.events.filter((e) => e.type === 'pad'), dr = song.events.filter((e) => e.type === 'drone');
       return { padRows: a.filter((r) => r[9] === 6 && (r[1] & 255) === 17).length, padNotes: pd.reduce((s, e) => s + Math.min(5, e.midis.length), 0), droneRows: a.filter((r) => r[9] === 7 && (r[1] & 255) === 17).length, drones: dr.length,
         velOk: a.filter((r) => r[9] === 6).every((r) => r[6] > 0 && r[6] <= 1) }; })()`);
     ok(pads.padRows === pads.padNotes && pads.padRows > 0, `a pad dealt an instrument is one row a note (${pads.padRows})`);
     ok(pads.droneRows === pads.drones * 2, 'and a drone a root and its fifth');
     ok(pads.velOk, 'at a velocity that is a share of the chord’s, not the whole of it');
   
     // the patch is the listener's: the same rows for the same patch; another patch, other rows
     const det = J(`(() => { const sg = buildSigil('${WORDS[1]}'), song = composeSong(sg), spec = SigilPlan.defaultSpec(sg, song);
       const h = (p) => { let x = 2166136261; for (let i = 0; i < p.count * 16; i++) x = Math.imul(x ^ Math.round(p.events[i] * 1e4), 16777619); return x >>> 0; };
       const a = h(SigilPlan.compile(song, sg, {})), b = h(SigilPlan.compile(song, sg, {}));
       spec.P = { ...spec.P, pal: 5 }; const c = h(SigilPlan.compile(song, sg, { spec }));
       spec.P = { ...spec.P, pal: 0, palOff: 1 }; const d = h(SigilPlan.compile(song, sg, { spec })), e = h(SigilPlan.compile(song, sg, { palette: false }));
       return { same: a === b, deal: a !== c, off: d === e }; })()`);
     ok(det.same && det.deal, 'a song compiles to the same rows each time; another deal, other rows');
     ok(det.off, 'the cube’s own voices, asked for in the patch, are the rows of a compile that was not given a palette');
   
     // the room
     const room = J(`(() => { const sg = buildSigil('${WORDS[0]}'), song = composeSong(sg), spec = SigilPlan.defaultSpec(sg, song);
       spec.P = { ...spec.P, palOff: 1 }; const a = SigilPlan.renderJob(song, sg, { sr: 44100, spb: song.spb, passes: 1, spec }), b = SigilPlan.renderJob(song, sg, { sr: 44100, spb: song.spb, passes: 1 });
       return { off: a.reverb.rt60, on: b.reverb.rt60, world: SigilPlan.paletteOf(song, sg, SigilPlan.defaultSpec(sg, song)).world, inst: !!b.inst, noInst: !a.inst }; })()`);
     ok(room.inst && room.noInst, 'a render job carries the instrument table, unless the cube is asked for');
     ok(room.on > 0 && room.off > 0, 'and the world’s room (its own size and damping) is in the hall');
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      4 · FILLS
      ═══════════════════════════════════════════════════════════════════════ */
   group('§4 · fills', () => {
     run(`globalThis.songWith = (w, style, rite) => { const sg = buildSigil(w), offs = [];
         if (rite) offs.push(Hooks.on('compose', (cfg) => { cfg.rite = rite; }, -30));
         if (style) offs.push(Hooks.on('compose', (cfg) => { Style.before(cfg); }, -20), Hooks.on('compose', (cfg, sigil) => { Style.compose(cfg, sigil, style, null); }, 20), Hooks.on('plan', (plan, cfg) => { Style.plan(plan, cfg); }, 20));
         offs.push(Hooks.on('score', (events, c) => Groove.score(events, c, { ...((c.cfg && c.cfg.drums) || {}) })));
         if (style) offs.push(Hooks.on('score', (events, c) => Style.parts(events, c), 10));
         try { return composeSong(sg); } finally { offs.forEach((f) => f()); } };`);
     // which figure is chosen, over many places
     const fig = J(`(() => { const c = {}; const I = [1, 2, 3], kinds = ['rise', 'fall', 'turn', 'dissolve'], Ws = [2, 4, 8, 16], idioms = ['rock', 'dry', 'sticks', 'drop', 'machine', 'brushes'];
       let n = 0;
       for (let bar = 0; bar < 40; bar++) for (const i of I) for (const k of kinds) for (const W of Ws) for (const idiom of idioms) {
         const N = (s, ch) => Groove.noise(12345, bar, s, ch); const f = Fills.choose({ W, from: 16 - W, I: i, kind: k, N, idiom, style: null });
         c[f] = (c[f] || 0) + 1; n++; }
       return { c, n }; })()`);
     const named = new Set([...J('Fills.FIGURES'), ...J('Fills.TAGS')]);
     ok(J('Fills.FIGURES').every((f) => f === 'recite' || (fig.c[f] || 0) > 0), 'every figure is chosen somewhere', JSON.stringify(fig.c));
     ok(J('Fills.TAGS').every((f) => (fig.c[f] || 0) > 0), 'and every two-step turn', JSON.stringify(fig.c));
     ok((fig.c.recite || 0) / fig.n > 0.15 && (fig.c.recite || 0) / fig.n < 0.5, `the sigil’s name is still said, in about ${Math.round(100 * (fig.c.recite || 0) / fig.n)}% of fills`);
     ok(Object.keys(fig.c).every((k) => named.has(k)), 'nothing else is chosen');
   
     // in songs
     const S = J(`(() => { const out = []; for (const [w, style] of [['${WORDS[0]}', null], ['${WORDS[1]}', null], ['${WORDS[2]}', 'metal'], ['${WORDS[3]}', 'jazz'], ['${WORDS[4]}', 'trap'], ['${WORDS[5]}', 'lofi'], ['${WORDS[0]}', 'reggae'], ['${WORDS[1]}', 'edm']]) {
         const song = songWith(w, style), fills = song.events.filter((e) => e.fill), bars = {};
         for (const e of fills) (bars[Math.floor(e.beat / 4 + 1e-6)] ||= []).push(e);
         const again = songWith(w, style);
         out.push({ w, style, n: fills.length, bars: Object.keys(bars).length, types: [...new Set(fills.map((e) => e.type))],
           perc: fills.filter((e) => e.type === 'perc').every((e) => e.pi >= 0 && e.pi <= 2 && e.pi === Math.floor(e.pi)),
           vel: fills.every((e) => e.vel > 0 && e.vel <= 1 && Number.isFinite(e.beat)),
           // a fill stays in its bar, at its end
           late: Object.entries(bars).every(([b, l]) => l.every((e) => e.beat - b * 4 >= 1.9 - 1e-6 && e.beat - b * 4 < 4.0 + 0.13) || Number(b) === 0),
           same: JSON.stringify(song.events.filter((e) => e.fill)) === JSON.stringify(again.events.filter((e) => e.fill)) }); }
       return out; })()`);
     for (const x of S) ok(x.n > 5 && x.bars >= 4 && x.vel && x.perc && x.same, `${x.w}${x.style ? ' · ' + x.style : ''}: ${x.bars} bars filled, with ${x.types.join(', ')}; the same every time`);
     ok(new Set(S.flatMap((x) => x.types)).size >= 9, `across these songs the fills use ${new Set(S.flatMap((x) => x.types)).size} different drums`);
     ok(S.some((x) => x.types.includes('perc')) && S.some((x) => x.types.includes('clap')) && S.some((x) => x.types.includes('rim')), 'including the hand-drums, the claps and the side-stick');
   
     // variety: over a song's fills there is more than one way of filling
     const variety = J(`(() => { const song = songWith('${WORDS[1]}', null), bars = {}; for (const e of song.events.filter((e) => e.fill)) (bars[Math.floor(e.beat / 4 + 1e-6)] ||= []).push(e);
       const shapes = new Set(Object.values(bars).map((l) => l.map((e) => e.type + (e.tom ?? e.pi ?? '')).sort().join(',')));
       return { bars: Object.keys(bars).length, shapes: shapes.size }; })()`);
     ok(variety.shapes >= Math.min(5, variety.bars - 1), `a song’s ${variety.bars} fills are ${variety.shapes} different fills`);
   
     // a clap is four rows a hundredth of a beat apart: the table the core walks must be in order all the same
     const ordered = J(`(() => { const out = []; for (const [w, st] of [['${WORDS[1]}', 'edm'], ['${WORDS[4]}', 'trap'], ['${WORDS[0]}', 'house']]) { const song = songWith(w, st), sg = buildSigil(w), p = SigilPlan.compile(song, sg, {}); let ok = true; for (let i = 1; i < p.count; i++) if (p.events[i * 16] < p.events[(i - 1) * 16]) ok = false; out.push([st, ok, song.events.filter((e) => e.type === 'clap').length]); } return out; })()`);
     ok(ordered.every((x) => x[1]) && ordered.some((x) => x[2] > 0), 'the rows of a song with claps in it (four rows each) are in order, so that none is skipped', JSON.stringify(ordered));
   
     // Fills at zero: none, and only the figures at the end
     const zero = J(`(() => { const sg = buildSigil('${WORDS[2]}'), song = composeSong(sg); Groove.apply(song, sg, { fills: 0 }); return song.events.filter((e) => e.fill || e.type === 'perc').length; })()`);
     ok(zero === 0, 'Fills at zero: none');
   
     // the turnaround
     const tn = J(`(() => { const off = Hooks.on('compose', (cfg) => { cfg.rite = 'sevenfold'; }, -30), off2 = Hooks.on('score', (events, c) => Groove.score(events, c, { ...((c.cfg && c.cfg.drums) || {}) }));
       const out = []; try { for (const w of ${JSON.stringify(WORDS)}) { const sg = buildSigil(w), song = composeSong(sg), L = Flow.loop(song), T = Flow.turn(song, sg, L), p = SigilPlan.compile(song, sg, { flow: true }), q = SigilPlan.compile(song, sg, { flow: false }), n = SigilPlan.compile(song, sg, { flow: true, turn: false });
         const fl = { 1: 0, 2: 0, 4: 0 }; for (let i = 0; i < p.count; i++) { const k = p.events[i * 16 + 1] >> 8; if (k) fl[k]++; }
         let plain = true; for (let i = 0; i < q.count; i++) if (q.events[i * 16 + 1] >= 256) plain = false;
         out.push({ w, has: !!T, fig: T && T.figure, kind: T && T.kind, add: T ? T.add.length : 0, fl, plain, noTurn: n.count <= p.count && (() => { for (let i = 0; i < n.count; i++) if (n.events[i * 16 + 1] >= 256) return false; return true; })(), inLast: T ? T.add.every((e) => e.beat >= L.hi - 4 - 0.1 && e.beat <= L.hi + 0.5 || e.when === 'after') : true }); } } finally { off(); off2(); }
       return out; })()`);
     ok(tn.every((x) => x.has && x.add > 0), 'a rite with a body turns on a fill', JSON.stringify(tn.map((x) => [x.w, x.has, x.add])));
     ok(tn.every((x) => x.fl[1] > 0 && x.fl[4] > 0 && x.inLast), 'its rows are marked: the fill is played only on a pass that turns, the bar it replaces only where the pass ends', JSON.stringify(tn.map((x) => x.fl)));
     ok(tn.every((x) => x.plain && x.noTurn), 'with no body (Flow off), or asked not to, there is no turnaround and no marked row');
     ok(new Set(tn.map((x) => x.fig)).size >= 2, `and it is not always the same fill (${tn.map((x) => x.fig).join(', ')})`);
   
     // the core plays the right rows on each pass
     const core = J(`(() => { const E = new Float64Array(3 * SigilDSP.STRIDE), K = SigilDSP.KIND.BELL;
       // beat 30: only on a pass that turns · beat 31: only where the pass ends · beat 16: only after a turn
       const row = (i, beat, flag) => { const q = i * SigilDSP.STRIDE; E[q] = beat; E[q + 1] = K + flag; E[q + 2] = SigilDSP.BUS.bell; E[q + 3] = 440; E[q + 5] = 0.5; E[q + 6] = 0.01; E[q + 15] = i + 1; };
       row(0, 16, 512); row(1, 30, 256); row(2, 31, 1024);
       const c = new SigilDSP.Core(8000, { warm: false }), log = []; c.spawn = (src, q) => log.push([c.pass, src[q]]);
       c.command({ type: 'plan', events: E, count: 3, total: 40, bpm: 480, passes: 3, nSec: 0, loop: { lo: 8, hi: 32 } });
       c.command({ type: 'play', beat: 0, pass: 0 });
       const bl = new Float32Array(128), br = new Float32Array(128);
       for (let b = 0; b < 20000 && c.playing; b++) { c.blockTime = b * 128 / 8000; c.process(bl, br, 128); }
       return log; })()`);
     // passes: 0 = [0,32) turns · 1 = [8,32) turns · 2 = [8,40) ends
     ok(JSON.stringify(core) === JSON.stringify([[0, 30], [1, 16], [1, 30], [2, 16], [2, 31]]), 'the core plays the fill on the passes that turn (not the last), the landing after a turn (not the first), and the old ending only on the last', JSON.stringify(core));
   });
   
   /* ═══════════════════════════════════════════════════════════════════════
      5 · HEARD
      ═══════════════════════════════════════════════════════════════════════ */
   if (!QUICK) {
     const ROLE_RANGE = { lead: [54, 82], alt: [54, 82], harm: [51, 77], bell: [66, 93], bass: [34, 63], arp: [56, 89], pad: [39, 70], drone: [36, 46], comp: [52, 80], tom: [41, 64], perc: [52, 76], rim: [67, 79], shaker: [96, 96] };
     const BUS_OF = { lead: 'lead', alt: 'lead', harm: 'harm', bell: 'bell', bass: 'bass', arp: 'arp', pad: 'pad', drone: 'drone', comp: 'arp', tom: 'drums', perc: 'drums', rim: 'drums', shaker: 'drums' };
     const HELD = new Set(['pad', 'drone']);
     const DAMP = { lead: 1.1, alt: 1.1, harm: 1.4, arp: 0.5, comp: 1.0 };       // what the compiler asks of a melodic part (06b DAMP)
     const BENDS = new Set(['conga', 'taiko', 'frame-drum', 'timpani', 'tabla', 'log-drum', 'djembe', 'bongo', 'udu']);      // skins whose pitch bends, re-aimed once a block: the size of the block is in their sound
     const RINGS = new Set(['bell', 'drone', 'pad', 'perc']);                 // parts that may ring for a long time; the others are stopped when they are let go
     group('§5 · every instrument, in every part it can play', () => {
       const D = bootCore();
       const list = J(`[...Palette.INST.values()].filter((d) => d.engine !== 'cube').map((d) => ({ id: d.id, key: d.key, engine: d.engine, roles: d.roles, range: d.range, oct: d.oct }))`).filter((d) => !ONLY.length || ONLY.includes(d.key));
       const problems = { finite: [], bounded: [], silent: [], endless: [], click: [], dc: [], nondet: [], pitch: [], blocks: [], gain: [] };
       let n = 0;
       const t0 = Date.now();
       for (const d of list) {
         for (const role of d.roles) {
           const [lo, hi] = ROLE_RANGE[role], pk = packed(run, d.id, role);
           const tuned = (m) => { m += 12 * ((d.oct && d.oct[role]) || 0); if (d.range) { while (m < d.range[0]) m += 12; while (m > d.range[1]) m -= 12; } return m; };
           const mids = role === 'shaker' ? [96] : [lo, Math.round((lo + hi) / 2), hi];
           for (const [j, m] of mids.entries()) {
             n++;
             const held = HELD.has(role), o = { table: pk.table, kind: pk.kind, slot: pk.slot, midi: m, vel: 0.85, beats: held ? 4 : 1, bpm: 120, secs: RINGS.has(role) ? 32 : 9, bus: BUS_OF[role], damp: DAMP[role] || 0, row: { accent: 0.9, vary: 0.4, seed: 777 + j } };
             const r = note(o), sl = stats(r.L), sr_ = stats(r.R), tag = `${d.key}/${role}@${m}`;
             if (sl.nan || sr_.nan) problems.finite.push(tag);
             if (Math.max(sl.peak, sr_.peak) > 6) problems.bounded.push(`${tag} (${Math.max(sl.peak, sr_.peak).toFixed(1)})`);
             if (Math.max(sl.rms, sr_.rms) < 1e-4) problems.silent.push(tag);
             if (!r.ended) problems.endless.push(tag);
             if (Math.abs(sl.dc) > 0.3 * Math.max(sl.rms, 1e-4) + 0.003) problems.dc.push(tag);
             // no click: in the voice itself (before any effect), the last thing it does is not a step down from something loud
             // (a voice that is cut off while it still sounds). Nothing is asked of its attack: a brush, a reed or a bell is meant to be sharp.
             const dry = r.dry; let pkd = 0, last = -1;
             for (let i = 0; i < dry.length; i++) { const a = Math.abs(dry[i]); if (a > pkd) pkd = a; if (a > 0) last = i; }
             if (last >= 0 && last < dry.length - 1 && Math.abs(dry[last]) > 0.004 * Math.max(pkd, 1e-3) + 1e-5) problems.click.push(`${tag} (stops at ${Math.abs(dry[last]).toFixed(4)} of ${pkd.toFixed(2)})`);
             if (j === 1 && n % 3 === 0) { const r2 = note(o); if (r2.L.some((x, i) => x !== r.L[i])) problems.nondet.push(tag); }
             // a voice keeps every bit of its state from one block to the next (a local that is not kept is a click, or a hiss, at each 128 samples);
             // and the slot's gain is the voice's level (it is what calibration turns)
             if (j === 1 && d.roles[0] === role) {
               const a2 = note({ ...o, block: 32, secs: 3 }), a1 = note({ ...o, secs: 3 });
               // (the buses' own level smoothing is per block, and a vibrato voice is steady enough to show it: a tenth of a decibel is allowed; a voice that loses its state is far more)
               let pkd = 1e-9, df = 0; for (let i = 0; i < a1.dry.length; i++) { pkd = Math.max(pkd, Math.abs(a1.dry[i])); df = Math.max(df, Math.abs(a1.dry[i] - a2.dry[i])); }
               if (df / pkd > (BENDS.has(d.key) ? 0.3 : 1.5e-2)) problems.blocks.push(`${tag} (${(df / pkd).toExponential(1)})`);
               const half = Float64Array.from(pk.table); half[pk.slot * 24 + 1] *= 0.5;
               const h = note({ ...o, table: half, secs: 3 }), ra = stats(a1.dry).rms, rh = stats(h.dry).rms;
               if (!(rh / ra > 0.4 && rh / ra < 0.6)) problems.gain.push(`${tag} (x${(rh / ra).toFixed(2)})`);
             }
             // a tonal instrument plays the note it is asked for (to a quarter-tone, or an octave off where it carries a sub-octave)
             if (['pluck', 'analog', 'organ', 'dx'].includes(d.engine) && j === 1 && ['lead', 'arp', 'bass', 'comp', 'alt', 'harm'].includes(role) && d.key !== 'sitar' && d.key !== 'tanpura') {
               const want = 440 * Math.pow(2, (tuned(m) - 69) / 12), f = pitch(r.L, r.sr, 0.25, 0.65, want / 2.3, want * 2.3);
               const cents = f > 0 ? 1200 * Math.log2(f / want) : 9999, off = ((cents % 1200) + 1800) % 1200 - 600;
               if (f > 0 && Math.abs(off) > 50) problems.pitch.push(`${tag} (${f.toFixed(1)} Hz for ${want.toFixed(1)}: ${Math.round(off)}¢)`);
             }
           }
         }
       }
       const took = (Date.now() - t0) / 1000;
       ok(ONLY.length || n > 700, `${n} notes heard: ${list.length} instruments in every part they can play, at both ends and the middle of it (${took.toFixed(0)} s)`);
       for (const [k, what] of [['finite', 'every sample a number'], ['bounded', 'bounded (never past six times full scale, before the master)'], ['silent', 'never silent'], ['endless', 'every note ends'], ['dc', 'no offset'], ['click', 'no click'], ['nondet', 'the same note twice is the same note'], ['blocks', 'the sound does not depend on where the blocks fall (every voice keeps its state)'], ['gain', 'an instrument’s gain is its level']]) {
         ok(problems[k].length === 0, what, problems[k].slice(0, ONLY.length ? 99 : 8).join('; ') + (problems[k].length > 8 && !ONLY.length ? ` … ${problems[k].length} in all` : ''));
       }
       ok(problems.pitch.length <= 3, 'the tonal engines play the note asked of them (to a quarter-tone)', problems.pitch.slice(0, 10).join('; '));
     });
   
     group('§5b · heard in a song: as loud as the voice that would have played the part', () => {
       // a few instruments in the parts they are cast in, against the cube, by the same measure the gains were found by
       const pairs = [['harp', 'lead'], ['marimba', 'arp'], ['supersaw-pad', 'pad'], ['upright', 'bass'], ['tubular', 'bell'], ['flute', 'lead'], ['epiano', 'comp'], ['dark-drone', 'drone'], ['brass', 'harm'], ['conga', 'perc']];
       const ids = J(`Object.fromEntries(${JSON.stringify(pairs.map((p) => p[0]))}.map((k) => [k, Palette.BY_KEY.get(k).id]))`);
       const from = (j) => { const b = []; for (let i = 0; i < j.count; i++) b.push(j.events[i * j.stride]); b.sort((x, y) => x - y); return Math.max(0, Math.floor(b[Math.floor(b.length * 0.3)] / 4) * 4) * (60 / j.bpm); };
       const off = [];
       for (const [key, role] of pairs) {
         const db = [];
         for (const w of WORDS.slice(0, 2)) {
           const rj = partJob(run, w, role, 0), ij = partJob(run, w, role, ids[key]);
           if (!rj.count || !ij.count) continue;
           const a = listen(run, rj, from(rj), 14), b = listen(run, ij, from(ij), 14);
           if (Number.isFinite(a.lufs) && Number.isFinite(b.lufs)) db.push(b.lufs - a.lufs);
         }
         const m = db.length ? db.reduce((x, y) => x + y, 0) / db.length : NaN;
         ok(Number.isFinite(m) && Math.abs(m) <= 4, `${key} as ${role}: ${Number.isFinite(m) ? (m >= 0 ? '+' : '') + m.toFixed(1) : '—'} dB against the cube’s voice`, db.map((x) => x.toFixed(1)).join(', '));
       }
     });
   
     group('§5c · a whole song, rendered with the palette', () => {
       const D = bootCore();
       for (const w of WORDS.slice(0, 3)) {
         const rj = realm(run(`(() => { const sg = buildSigil(${JSON.stringify(w)}), song = composeSong(sg); return SigilPlan.renderJob(song, sg, { sr: 44100, spb: song.spb, passes: 1, flow: false }); })()`));
         const t0 = Date.now(), a = D.renderRange(rj, 20, 44, 20), took = (Date.now() - t0) / 1000, b = D.renderRange(rj, 20, 44, 20);
         const sa = stats(a.L), sb = stats(a.R);
         let same = true; for (let i = 0; i < a.L.length; i += 97) if (a.L[i] !== b.L[i] || a.R[i] !== b.R[i]) { same = false; break; }
         ok(!sa.nan && !sb.nan && Math.max(sa.peak, sb.peak) <= 1.0001, `${w}: 24 s rendered, finite, under full scale (peak ${Math.max(sa.peak, sb.peak).toFixed(2)})`);
         ok(same, `  rendered twice, the same`);
         ok(took < 24 * 1.2, `  in ${took.toFixed(1)} s: faster than real time`);
       }
     });
   }
   
   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
   