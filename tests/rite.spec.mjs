/* ══════════════════════════════════════════════════════════════════════════
   RITE SPEC — the rites (05g): forms other than the Sevenfold, dressed by the
   moods (m6) and the styles (05f), written by the kit (05c), compiled (06b)
   and heard (DSP). No browser, no dependencies.

     node tests/rite.spec.mjs            everything (a minute or two)
     node tests/rite.spec.mjs --quick    skip the audio renders
     node tests/rite.spec.mjs §4         only the groups whose names contain this

   What it defends
     1. THE SEVENFOLD IS UNTOUCHED: with this layer present and the Sevenfold
        chosen, the song is, event for event, the song before rites existed.
     2. ANY RITE, ANY WORKING, ONE PIECE: every rite × mood, every rite ×
        style, composes into a well-formed score that ends on the tonic.
     3. A RITE IS THE SAME SIGIL: the key, the tempo and the sound are not the
        rite's to change; what is sung in a section is the sigil's path under
        that section's transform, and nothing else.
     4. EACH RITE IS THE SHAPE IT SAYS: what returns, what turns, where the
        height is, how it ends.
     5. THE MOOD'S WORD HOLDS IN EVERY RITE, and the rite's holds in every
        mood: a rite only ever takes away.
     6. ENDINGS AND CADENCES: a rite that ends at its height is struck by
        every writer of the kit, and is not dimmed; an open cadence is open.
     7. THE WORDS: every rite says where it is from; every section has a name.
     8. IT SOUNDS: rites compile, render finite and the same twice, and their
        shapes are in the sound (the silence is the quietest thing; the last
        stroke is struck, and rings).
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05k-fills.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/core/05e-master.js', 'src/core/05f-style.js', 'src/core/05g-rite.js', 'src/core/06b-compiler.js'];
   const QUICK = process.argv.includes('--quick');
   const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('--'));
   
   /**
    * A fresh VM: the pure layers, the DSP core and the compiler, in index.html's order; then the
    * moods (m6, behind a stub of the page) and the same hooks m15, m21, m2 and m22 register in the app.
    * RITES = false takes this layer's hooks out, to compare against a song composed without it.
    */
   function fresh() {
     const sandbox = { TextEncoder, btoa, atob, console, performance };
     sandbox.window = sandbox; sandbox.globalThis = sandbox;
     const ctx = createContext(sandbox);
     const run = (code, filename) => runInContext(code, ctx, filename ? { filename } : undefined);
     for (const f of FILES) run(readFileSync(join(root, f), 'utf8'), f);
     run(`var __el = () => ({ before() {}, append() {}, querySelectorAll: () => [], querySelector: () => null, setAttribute() {} });
       var UI = { h: __el, button: __el, css() {}, section() {}, note: __el, recompose() {}, announce() {} };
       var document = { querySelector: () => __el() }, app = { mode: 'idle' };`);
     run(readFileSync(join(root, 'src/modules/m6-moods.js'), 'utf8').replace('const Moods =', 'var Moods ='), 'm6-moods.js');
     run(`var STYLE = 'none', ELEMENT = 'aether', RITE = 'sevenfold', RITES = true, PATTERN = 'sigil', LONG = false,
         DRUMS = { take: 0, variation: 0.6, fills: 0.6, ghosts: 0.5, human: 0.4 };
       Hooks.on('compose', (cfg, sigil) => { if (RITES && RITE !== Rite.DEFAULT) cfg.rite = RITE === 'own' ? Rite.own(sigil) : RITE; }, -30);
       Hooks.on('compose', (cfg) => { Style.before(cfg); }, -20);
       Hooks.on('compose', (cfg, sigil) => { Style.compose(cfg, sigil, STYLE, ELEMENT); }, 20);
       Hooks.on('plan', (plan, cfg) => (RITES ? Rite.open(cfg) : undefined), -30);
       Hooks.on('plan', (plan, cfg) => { Style.plan(plan, cfg); }, 20);
       Hooks.on('plan', (plan, cfg) => { if ((cfg.bpm < 132 && !LONG) || cfg.formExtended) return;      // m2's long form
         for (const s of plan) if (/^(verse|chorus)/.test(s.id)) s.phrases *= 2; cfg.formExtended = true; }, 50);
       Hooks.on('plan', (plan, cfg) => { if (RITES) Rite.seal(plan, cfg); }, 60);
       Hooks.on('score', (events, c) => (PATTERN === 'sigil' || (c.cfg.drums && c.cfg.drums.feel) ? Groove.score(events, c, { ...DRUMS, ...((c.cfg && c.cfg.drums) || {}) }) : undefined));
       Hooks.on('score', (events, c) => Style.parts(events, c), 10);
       globalThis.cast = (word, rite, mood, style, element) => { Moods.set(mood || 'ritual', { persist: false }); STYLE = style || 'none'; ELEMENT = element || 'aether'; RITE = rite || 'sevenfold';
         const sig = buildSigil(word); return { sig, song: composeSong(sig) }; };
       globalThis.ALL = Object.keys(Rite.RITES); globalThis.OTHERS = ALL.filter((r) => r !== Rite.DEFAULT);
       globalThis.MOODS = Object.keys(Moods.MOODS); globalThis.STYLES = Object.keys(Style.STYLES);
       globalThis.KIT = new Set(['kick', 'snare', 'hat', 'shaker', 'rim', 'tom', 'clap', 'ride', 'crash', 'swell']);
       globalThis.print = (song) => JSON.stringify(song.events.map((e) => [e.type, +e.beat.toFixed(4), e.midi ?? (e.midis || []).join('/'), +(e.vel ?? 0).toFixed(4), +(e.dur ?? 0).toFixed(4), e.tom ?? '', e.open ? 1 : 0]));
       globalThis.sec = (song, id) => song.sections.find((s) => s.id === id);
       /** The events of one section, by kind; the bar-line itself belongs to the section that begins there. */
       globalThis.inSec = (song, id, pred) => { const s = sec(song, id), end = s.end - (s.final ? 0 : 0.02);
         return song.events.filter((e) => e.beat >= s.start - 0.02 && e.beat < end && (!pred || pred(e))); };
       globalThis.levels = (song) => song.sections.map((s) => s.intensity | 0);
       globalThis.form = (song) => song.sections.map((s) => s.T.k + (s.T.m < 0 ? 'm' : '') + (s.T.reverse ? 'r' : '')).join(' ');
       /** The degrees sung in the first phrase of a section (the melody, without its passing tones). */
       globalThis.sung = (song, id) => { const s = sec(song, id), v = s.voice === 'bell' ? 'bell' : 'lead';
         return song.events.filter((e) => e.type === v && e.part === 0 && e.beat >= s.start - 1e-6 && e.beat < s.start + 16 - 1e-6 && e.off === 0 && (v === 'lead' || e.add === 12)).map((e) => e.deg); };`);
     return run;
   }
   
   let pass = 0, fail = 0;
   const ok = (cond, label, detail) => {
     if (cond) { pass++; console.log(`  ✓ ${label}`); }
     else { fail++; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
   };
   const eq = (a, b, label) => ok(Object.is(a, b), label, `expected ${JSON.stringify(b)}  got ${JSON.stringify(a)}`);
   function group(name, fn) {
     if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
     console.log(`\n${name}`);
     try { fn(); } catch (e) { ok(false, `${name}: threw`, String((e && e.stack) || e)); }
   }
   
   /* ═══════════════════════════════════════════════════════════════════════ */
   group('§1 · the Sevenfold is untouched', () => {
     const run = fresh();
     ok(run(`['KRSTVM', 'THWLBDNS', 'BCD'].every((w) => [['ritual', 'none'], ['dirge', 'none'], ['ecstatic', 'none'], ['pulse', 'edm'], ['ritual', 'jazz']].every(([m, s]) => {
         RITES = true; const a = cast(w, 'sevenfold', m, s).song; RITES = false; const b = cast(w, 'sevenfold', m, s).song; RITES = true;
         return print(a) === print(b) && a.total === b.total && a.cfg.rite === undefined && a.sections.every((x) => x.role === undefined && x.ends === undefined && x.cadence === undefined); }))`),
        'with the layer present and the Sevenfold chosen, the song is the song composed without the layer: same events, same length, nothing added to its plan');
     ok(run(`(() => { PATTERN = 'classic'; RITES = true; const a = cast('KRSTVM').song; RITES = false; const b = cast('KRSTVM').song; RITES = true; PATTERN = 'sigil'; return print(a) === print(b); })()`),
        'and so is the composer’s own kit (Pattern: Classic)');
     eq(run(`cast('KRSTVM').song.sections.map((s) => s.id).join()`), 'intro,verse1,chorus1,verse2,bridge,chorus2,outro', 'its seven sections answer to the names they always had');
     eq(run(`ALL.length`), 19, 'there are eighteen other rites, and the Sevenfold');
     eq(run(`ALL[0]`), 'sevenfold', 'the Sevenfold is the first, and the default');
     ok(run(`Rite.open({ rite: 'sevenfold', rotK: 10, shift: 3 }) === undefined && Rite.open({ rotK: 10, shift: 3 }) === undefined && Rite.open({ rite: 'no-such-rite', rotK: 10, shift: 3 }) === undefined`),
        'open() leaves the composer’s plan alone for the Sevenfold, for no rite, and for a rite it does not know');
   });
   
   group('§2 · any rite, any working, one piece', () => {
     const run = fresh();
     const out = JSON.parse(run(`(() => { const bad = []; let n = 0; const ROLES = new Set(['intro', 'verse1', 'chorus1', 'verse2', 'bridge', 'chorus2', 'outro']);
       const check = (w, r, m, s, e) => { n++; const tag = [w, r, m, s, e].join('/');
         try { const { song } = cast(w, r, m, s, e), S = song.sections;
           for (const ev of song.events) {
             if (!(ev.beat >= 0 && ev.beat < song.total + 1e-6)) { bad.push([tag, 'beat', ev.type, ev.beat]); break; }
             if (ev.midi != null && !(ev.midi >= 12 && ev.midi <= 120)) { bad.push([tag, 'midi', ev.type, ev.midi]); break; }
             if (ev.midis && !ev.midis.every((x) => x >= 12 && x <= 120)) { bad.push([tag, 'midis']); break; }
             if (ev.dur != null && !(ev.dur > 0)) { bad.push([tag, 'dur', ev.type]); break; }
             if (ev.vel != null && !(ev.vel > 0 && ev.vel <= 1.25)) { bad.push([tag, 'vel', ev.type, ev.vel]); break; }
           }
           if (new Set(S.map((x) => x.id)).size !== S.length) bad.push([tag, 'ids are not unique']);
           if (!S.every((x) => ROLES.has(x.role) && !x.rite)) bad.push([tag, 'a section has no role, or was not sealed']);
           if (S.some((x, i) => x.start !== (i ? S[i - 1].end : 0) || x.roman !== Rite.roman(i + 1))) bad.push([tag, 'sections are not contiguous, or not numbered']);
           if (!S[S.length - 1].final || S.slice(0, -1).some((x) => x.final || x.tail)) bad.push([tag, 'only the last section ends the rite']);
           const ph = S.reduce((a, x) => a + x.phrases, 0);
           if (song.total !== ph * 16 + 8 || song.phrases.length !== ph) bad.push([tag, 'length', song.total, ph]);
           if (ph > Rite.CAP) bad.push([tag, 'over the cap', ph]);
           if (song.phrases[song.phrases.length - 1].chords[3] !== 0) bad.push([tag, 'does not end on the tonic']);
           if (S.some((x) => !(x.intensity >= 0 && x.intensity <= 3) || (x.halfTime && !(x.intensity > 0)))) bad.push([tag, 'level']);
         } catch (err) { bad.push([tag, 'threw', String((err && err.stack) || err).slice(0, 240)]); } };
       for (const r of OTHERS) {
         for (const m of MOODS) check('KRSTVM', r, m, 'none', 'aether');
         for (const s of STYLES) check('THWLBDNS', r, 'ritual', s, 'aether');
         for (const m of ['ecstatic', 'lullaby', 'ambient', 'pulse', 'dirge', 'storm']) for (const s of ['edm', 'punk', 'jazz', 'trap']) check('BCD', r, m, s, 'fire');
         for (const w of ['PLMNKJHGFDSTRVWXYZBC', 'LVNGHT', 'FSHVZXC']) check(w, r, 'ritual', 'none', 'aether');
       }
       LONG = true; for (const r of OTHERS) for (const m of ['ritual', 'ecstatic', 'wrath']) check('KRSTVM', r, m, 'dnb', 'aether'); LONG = false;
       return JSON.stringify({ n, bad: bad.slice(0, 6), nbad: bad.length }); })()`));
     ok(out.nbad === 0, `${out.n} workings (every rite × mood, every rite × style, moods × styles, long and short sigils, the mixer’s long form): every score is well formed, numbered, under the cap, and ends on the tonic`,
        JSON.stringify(out.bad));
     ok(run(`OTHERS.every((r) => print(cast('THWLBDNS', r, 'dirge', 'trap', 'water').song) === print(cast('THWLBDNS', r, 'dirge', 'trap', 'water').song))`),
        'the same sigil in the same rite and working is the same song, event for event');
     ok(run(`(() => { LONG = true; const a = cast('KRSTVM', 'abramelin', 'ritual', 'dnb').song, n = a.sections.reduce((x, s) => x + s.phrases, 0); LONG = false;
         const b = cast('KRSTVM', 'abramelin').song.sections.reduce((x, s) => x + s.phrases, 0); return n > b && n <= Rite.CAP; })()`),
        'a fast working lengthens a rite as it does the Sevenfold, and never past the cap');
   });
   
   group('§3 · a rite is the same sigil', () => {
     const run = fresh();
     ok(run(`OTHERS.every((r) => [['ritual', 'none'], ['dirge', 'trap'], ['aurora', 'bossa']].every(([m, s]) => { const a = cast('KRSTVM', r, m, s, 'water').song, b = cast('KRSTVM', 'sevenfold', m, s, 'water').song;
         return a.keyName === b.keyName && a.bpm === b.bpm && a.leadTimbre === b.leadTimbre && JSON.stringify(a.levels) === JSON.stringify(b.levels)
           && JSON.stringify(a.cfg.sound) === JSON.stringify(b.cfg.sound) && JSON.stringify(a.cfg.styleSound) === JSON.stringify(b.cfg.styleSound) && JSON.stringify(a.P) === JSON.stringify(b.P); }))`),
        'the key, the tempo, the lead, the faders, the sound and the polygons are the sigil’s (and the working’s) in every rite');
     ok(run(`(() => { const sig = buildSigil('THWLBDNS'); return OTHERS.every((r) => { const song = cast('THWLBDNS', r).song;
         return song.sections.every((s) => { if (s.voice === 'none') return sung(song, s.id).length === 0;
           const want = buildPhrase(sig, s.T, s.density).notes.filter((n) => s.voice !== 'bell' || !n.passing).map((n) => n.deg);
           return JSON.stringify(sung(song, s.id)) === JSON.stringify(want); }); }); })()`),
        'what is sung in every section of every rite is the sigil’s own path under that section’s transform, note for note');
     ok(run(`OTHERS.every((r) => cast('KRSTVM', r).song.sections.every((s) => Number.isInteger(s.T.k) && s.T.k >= 0 && s.T.k < SLOTS && (s.T.m === 1 || s.T.m === -1) && typeof s.T.reverse === 'boolean'))`),
        'a rite has three things to work with: the wheel turned, mirrored, the path retraced');
     ok(run(`(() => { const a = cast('KRSTVM', 'sevenfold').song, b = cast('KRSTVM', 'mantra').song; return JSON.stringify(sung(a, 'verse1')) === JSON.stringify(sung(b, 'round3')); })()`),
        'the sigil as written is the same melody in the Sevenfold’s Inscription and in any rite');
     ok(run(`['KRSTVM', 'THWLBDNS', 'BCD', 'LVNGHT', 'FSHVZXC', 'MNJLRWY'].every((w) => { const s = buildSigil(w), a = Rite.own(s); return ALL.includes(a) && a === Rite.own(buildSigil(w)); })
         && new Set(['KRSTVM', 'THWLBDNS', 'BCD', 'LVNGHT', 'FSHVZXC', 'MNJLRWY', 'QXZ', 'DRKWTR', 'SLVRKY', 'PTHFNDR'].map((w) => Rite.own(buildSigil(w)))).size >= 4`),
        'a sigil draws its own rite from its own streams: always the same one, and not the same for every sigil');
     ok(run(`(() => { const words = ['KRSTVM', 'THWLBDNS', 'BCD', 'LVNGHT', 'FSHVZXC', 'MNJLRWY', 'QXZ', 'DRKWTR', 'SLVRKY', 'PTHFNDR', 'WLFNDTHSVRKY', 'THRVKNWSMY', 'GLDNDWN', 'CHSMGCK', 'NTHRNTHR'];
         const before = words.map((w) => Rite.own(buildSigil(w)));
         Rite.RITES.zzz_test_rite = { id: 'zzz_test_rite', label: 'x', from: 'x', blurb: 'x', parts: () => [] };
         const after = words.map((w) => Rite.own(buildSigil(w))); delete Rite.RITES.zzz_test_rite;
         return after.every((r, i) => r === before[i] || r === 'zzz_test_rite') && words.map((w) => Rite.own(buildSigil(w))).join() === before.join(); })()`),
        'and a rite added later takes only the sigils it wins: every other sigil keeps the rite it drew');
   });
   
   group('§4 · each rite is the shape it says (in the Ritual mood)', () => {
     const run = fresh();
     run(`globalThis.S = (r, w) => cast(w || 'KRSTVM', r).song; globalThis.lv = (r) => levels(S(r)).join('');
       globalThis.layers = (s) => (s.voice !== 'none') + !!s.harm + !!s.octave + !!s.bass + (s.arp === 'full' ? 2 : s.arp ? 1 : 0) + (s.intensity | 0);`);
     ok(run(`lv('charge') === '130' && S('charge').sections.reduce((a, s) => a + s.phrases, 0) === 4`), 'Charge: stated, held, let go. Three sections, four phrases');
     ok(run(`lv('seasons') === '12320' && S('seasons').sections.every((s) => s.phrases === 1)`), 'Five Seasons: five sections of one phrase, the height in the middle');
     ok(run(`(() => { const s = S('iao'), o = s.sections[2]; return lv('iao') === '123' && s.sections[1].halfTime && o.final && o.ends === 'struck' && form(s) === '0 0mr ' + s.rotK; })()`),
        'I·A·O: as written, then mirrored and retraced in half-time, then turned; it ends at its height');
     ok(run(`(() => { const s = S('posture'), v = inSec(s, 'vacuity'), kinds = [...new Set(v.map((e) => e.type))].sort().join();
         return lv('posture') === '21030' && kinds === 'drone,pad' && inSec(s, 'flash', (e) => e.type === 'crash').length >= 1 && inSec(s, 'flash', (e) => e.type === 'lead').length > 0; })()`),
        'Death Posture: Vacuity is a pad and a drone and nothing else (the path is traced, not sung); the Flash follows it at full force');
     ok(run(`lv('resh') === '1320' && S('resh').sections[2].halfTime`), 'Four Adorations: the height is the second station, and the rest goes down');
     ok(run(`lv('spliff') === '122330' && S('spliff').sections.map((s) => s.name[0]).join('') === 'SPLIFF'`), 'S.P.L.I.F.F.: six sections, whose names spell it');
     ok(run(`(() => { const s = S('pentagram'); return form(s).split(' ').slice(1, 5).join(' ') === '0 0m 0r 0mr' && lv('pentagram') === '0122230' && sec(s, 'archangels').harm; })()`),
        'Lesser Pentagram: the four quarters are the four forms of the melody (as written, mirrored, retraced, both); the archangels are the choir');
     ok(run(`(() => { const s = S('cone'), L = levels(s); return L.every((x, i) => !i || x >= L[i - 1]) && form(s) === '0 0 3 6 9' && s.sections.at(-1).ends === 'struck' && L.at(-1) === 3; })()`),
        'Cone of Power: it never falls; each round the wheel turns a seventh; it ends on its highest level, struck');
     ok(run(`(() => { const s = S('gates'), L = levels(s), g = s.sections.slice(0, 7), ly = s.sections.map(layers);
         return L.every((x, i) => !i || x <= L[i - 1]) && g.every((x, i) => x.T.k === (i * Rite.SEVENTH) % SLOTS) && 7 * Rite.SEVENTH === SLOTS && s.sections[7].T.k === 0
           && ly.every((x, i) => !i || x < ly[i - 1]) && L[0] === 3 && sung(s, 'underworld').length === 0 && inSec(s, 'underworld', (e) => KIT.has(e.type) || e.type === 'bass' || e.type === 'arp').length === 0; })()`),
        'Seven Gates: it begins at its height and never rises; something is taken at every gate; seven sevenths are one whole turn; the Underworld is not sung');
     ok(run(`(() => { const s = S('mantra'), body = s.sections.slice(0, 7), L = levels(s).slice(0, 7), ly = body.map(layers), first = JSON.stringify(sung(s, 'round2'));
         return s.sections.every((x) => x.T.k === 0 && x.T.m === 1 && !x.T.reverse) && L.every((x, i) => !i || x >= L[i - 1]) && ly.every((x, i) => i < 2 || x > ly[i - 1])
           && body[0].voice === 'bell' && body[1].voice === 'lead' && ['round3', 'round4', 'round5'].every((id) => JSON.stringify(sung(s, id)) === first); })()`),
        'Mantra: never transformed; bells, then a voice, then every round the same notes with something more than the last');
     ok(run(`(() => { const s = S('opus'); return form(s) === '0r 0m 0 ' + s.rotK + ' 0' && lv('opus') === '11230' && s.sections[0].halfTime && s.sections[1].voice === 'bell'; })()`),
        'Great Work: retraced in the dark, mirrored on bells, and only third as written; then exalted');
     ok(run(`(() => { const s = S('goetia'); return form(s).split(' ').slice(1, 4).join(' ') === '0 1 2' && lv('goetia') === '0123230' && sec(s, 'licence').T.reverse; })()`),
        'Conjuration: three calls, each one place on and one level up; the licence to depart is the way it came, retraced');
     ok(run(`(() => { const s = S('chaosphere'), eight = s.sections.slice(0, 8).map((x) => [x.T.k > 0, x.T.m < 0, x.T.reverse].map(Number).join('')); return new Set(eight).size === 8; })()`),
        'Eight Rays: the eight forms of a melody (turned or not, mirrored or not, retraced or not), each exactly once');
     ok(run(`(() => { const s = S('servitor'), names = ['naming', 'naming2', 'sending'].map((id) => sec(s, id));
         return names.every((x) => x.T.k === 0 && x.T.m === 1 && !x.T.reverse) && layers(names[0]) < layers(names[1]) && layers(names[1]) < layers(names[2])
           && JSON.stringify(sung(s, 'naming')) === JSON.stringify(sung(s, 'naming2')); })()`),
        'Servitor: a rondo. The Naming returns three times as written, each time with more voices');
     ok(run(`(() => { const s = S('gnostic'), n = s.sections.length, k = s.sections.map((x) => x.T.k), L = levels(s);
         return n === 11 && k.every((x, i) => x === k[n - 1 - i]) && L.every((x, i) => x === L[n - 1 - i]) && s.sections.slice(0, 5).every((x) => !x.T.reverse) && s.sections.slice(6).every((x) => x.T.reverse)
           && [1, 2, 3, 4].every((i) => k[i] === mod(-i, SLOTS)); })()`),
        'Gnostic Pentagram: a palindrome. Down a place at a time, the pentagrams, then the same places back, each retraced');
     ok(run(`(() => { const s = S('mass'), v = ['versicle', 'response', 'versicle2', 'response2'].map((id) => sec(s, id));
         return v.map((x) => x.intensity).join('') === '1212' && v[1].T.m === -1 && v[3].T.m === -1 && v[1].harm && v[2].T.k === Rite.SEVENTH && s.sections.reduce((a, x) => a + x.phrases, 0) === 16; })()`),
        'Mass: a litany of versicle and response (the response mirrored, with the choir) between the veil and the consecration');
     ok(run(`(() => { const s = S('abramelin'), i = s.sections.findIndex((x) => x.intensity >= 3), before = s.sections.slice(0, i);
         return s.sections[i].id === 'angel' && before.reduce((a, x) => a + x.phrases, 0) >= 8 && before.at(-1).id === 'vigil' && before.at(-1).intensity === 0 && s.sections.reduce((a, x) => a + x.phrases, 0) === 17; })()`),
        'Abramelin: the longest. Eight phrases of prayer and a vigil before anything is loud; then the Angel');
     ok(run(`(() => { const s = S('bornless'), ch = s.sections.filter((x) => x.name === 'The Charge'), vs = ['air', 'fire', 'water', 'earth'].map((id) => sec(s, id));
         return ch.length === 5 && ch.every((x) => x.T.k === s.rotK && x.T.m === 1 && !x.T.reverse && x.intensity === 3 && x.phrases === 1)
           && JSON.stringify(sung(s, 'charge1')) === JSON.stringify(sung(s, 'charge5'))
           && vs.map((x) => (x.T.m < 0 ? 'm' : '') + (x.T.reverse ? 'r' : '')).join() === ',m,r,mr' && vs.every((x) => x.intensity < 3 && s.sections[s.sections.indexOf(x) + 1].name === 'The Charge')
           && sec(s, 'attainment').T.k === 0 && sec(s, 'attainment').octave && s.sections.reduce((a, x) => a + x.phrases, 0) === 19; })()`),
        'Bornless One: verse and refrain. Five invocations, each in its own form, each answered by the same charge; then the attainment as written');
     ok(run(`(() => { const n = ALL.map((r) => Rite.measure(r).phrases), m = OTHERS.every((r) => { const a = Rite.measure(r), s = S(r); return a.sections === s.sections.length && a.phrases * 16 + 8 === s.total; });
         return m && Math.min(...n) === 4 && Math.max(...n) === 19 && new Set(n).size >= 9; })()`),
        'they are of different lengths, from four phrases to nineteen, and measure() says how long each is');
     ok(run(`new Set(ALL.map((r) => levels(S(r)).join('') + '|' + form(S(r)))).size === ALL.length`), 'no two rites are the same form');
   });
   
   group('§5 · the mood’s word holds in every rite, and the rite’s in every mood', () => {
     const run = fresh();
     ok(run(`OTHERS.every((r) => levels(cast('KRSTVM', r, 'lullaby').song).every((x) => x <= 1))`), 'a Lullaby stays hushed in every rite (no section above level 1)');
     ok(run(`OTHERS.every((r) => ['ambient', 'glacier'].every((m) => { const s = cast('KRSTVM', r, m).song; return levels(s).every((x) => x === 0) && !s.events.some((e) => KIT.has(e.type)); }))`),
        'an Ambient or a Glacier rite stays drumless, its struck ending included (the bell alone)');
     ok(run(`OTHERS.every((r) => cast('KRSTVM', r, 'dirge').song.sections.every((s) => s.intensity <= 2 && (s.intensity === 0 || s.halfTime)))`), 'a Dirge keeps its ceiling and its half-time in every rite');
     ok(run(`OTHERS.every((r) => !cast('KRSTVM', r, 'hymn').song.events.some((e) => e.type === 'arp'))`), 'a Hymn has no arpeggio in any rite');
     ok(run(`MOODS.every((m) => STYLES.slice(0, 8).concat('jazz').every((st) => { const s = cast('KRSTVM', 'posture', m, st).song, v = sec(s, 'vacuity');
         return v.intensity === 0 && v.voice === 'none' && !v.arp && !v.harm && !v.bass
           && inSec(s, 'vacuity', (e) => ['lead', 'bell', 'harm', 'bass', 'arp', 'comp', 'kick', 'hat'].includes(e.type)).length === 0; }))`),
        'Vacuity is empty in every mood and style: no voice, no bass, no chords struck, no time kept');
     ok(run(`(() => { const s = cast('KRSTVM', 'posture', 'ritual', 'edm').song, v = sec(s, 'vacuity'), roll = inSec(s, 'vacuity', (e) => e.type === 'snare');
         return roll.length >= 8 && roll.every((e) => e.beat >= v.end - 4 - 0.02); })()`),
        '(an idiom that builds into a drop still may, over the silence’s last bar: the roll belongs to the Flash)');
     ok(run(`MOODS.every((m) => ['none', 'edm', 'grunge', 'jazz'].every((st) => { const L = levels(cast('KRSTVM', 'gates', m, st).song); return L.every((x, i) => !i || x <= L[i - 1]); }))`),
        'Seven Gates never rises, in any mood or style');
     ok(run(`MOODS.every((m) => ['none', 'edm', 'grunge', 'jazz'].every((st) => ['cone', 'mantra'].every((r) => { const s = cast('KRSTVM', r, m, st).song, L = levels(s).slice(0, r === 'mantra' ? -1 : undefined);
         return L.every((x, i) => !i || x >= L[i - 1]); })))`),
        'Cone of Power and Mantra never fall before their end, in any mood or style');
     ok(run(`MOODS.every((m) => OTHERS.every((r) => { const a = cast('KRSTVM', r, m).song, b = cast('KRSTVM', 'sevenfold', m).song;
         const top = Math.max(...levels(b)); return levels(a).every((x) => x <= top); }))`),
        'no rite is louder anywhere than the mood allows the Sevenfold to be: a rite only ever takes away');
     ok(run(`(() => { const want = { intro: 'intro', verse1: 'verse1', chorus1: 'chorus1', verse2: 'verse2', bridge: 'bridge', chorus2: 'chorus2', outro: 'outro' };
         return ['storm', 'longing', 'ecstatic', 'pulse'].every((m) => { const b = Object.fromEntries(cast('KRSTVM', 'sevenfold', m).song.sections.map((s) => [s.id, s]));
           return ['servitor', 'goetia', 'resh'].every((r) => cast('KRSTVM', r, m).song.sections.every((s) => s.intensity === b[want[s.role]].intensity && !!s.halfTime === !!b[want[s.role]].halfTime)); }); })()`),
        'where a rite holds nothing, each section is dressed exactly as the Sevenfold’s section of its role is');
     ok(run(`(() => { const s = cast('THWLBDNS', 'iao', 'ritual', 'edm').song; return sec(s, 'apophis').intensity === 0 && sec(s, 'osiris').intensity === 3; })()`),
        'and by the style too: in EDM, Apophis is the breakdown and Osiris the drop');
   });
   
   group('§6 · endings and cadences', () => {
     const run = fresh();
     run(`globalThis.endOf = (song) => { const l = song.sections.at(-1), t = l.end - l.tail; return { t, at: song.events.filter((e) => Math.abs(e.beat - t) < 1e-6).map((e) => e.type).sort().join() }; };`);
     ok(run(`['iao', 'cone'].every((r) => endOf(cast('KRSTVM', r).song).at === 'bass,bell,crash,kick,pad')`), 'a rite that ends at its height is struck on its last bar-line by the whole band: the kick, a crash, the bass, the chord, and the last bell');
     ok(run(`(() => { PATTERN = 'classic'; const a = endOf(cast('KRSTVM', 'iao').song).at; PATTERN = 'sigil'; return a === 'bass,bell,crash,kick,pad'; })()`), 'by the composer’s own kit as well (Pattern: Classic)');
     ok(run(`endOf(cast('KRSTVM', 'iao', 'ritual', 'edm').song).at === 'bass,bell,crash,kick,pad' && endOf(cast('KRSTVM', 'iao', 'ritual', 'jazz').song).at === 'bass,bell,kick,pad'`),
        'and by a style’s kit, in its own weight: EDM has a crash, jazz only the foot; the style’s bass leaves the last note where it is');
     ok(run(`(() => { const s = cast('KRSTVM', 'iao', 'ritual', 'trap').song, x = endOf(s), b = s.events.find((q) => q.type === 'bass' && Math.abs(q.beat - x.t) < 1e-6);
         const pad = s.events.find((q) => q.type === 'pad' && Math.abs(q.beat - x.t) < 1e-6);
         return !!b && b.midi === bassPitch(0, 'root', s.bassBase, s.scale) && b.dur === 3 && pad.chord === 0 && pad.dur === 3; })()`), 'the note and the chord are the tonic, held three beats and let go');
     ok(run(`(() => { const e = (m) => { const s = cast('KRSTVM', 'cone', m).song, x = endOf(s); return [x.at, s.events.filter((q) => q.type === 'kick' && Math.abs(q.beat - x.t) < 1e-6).map((q) => q.vel)[0]]; };
         const hush = e('lullaby'), full = e('ritual'); return hush[0] === 'bass,bell,kick,pad' && hush[1] < full[1] && e('ambient')[0] === 'bass,bell,pad'; })()`),
        'the stroke is sized by the level the mood left: a soft foot in a Lullaby, and in an Ambient rite no kit at all (the chord, the bass, the bell)');
     ok(run(`(() => { const s = cast('KRSTVM', 'iao').song, l = s.sections.at(-1), bar = s.events.filter((e) => e.beat >= l.end - l.tail - 4 && e.beat < l.end - l.tail);
         return bar.some((e) => e.type === 'swell') && bar.filter((e) => e.type === 'snare' && e.beat >= l.end - l.tail - 1).length >= 4; })()`),
        'the kit builds into it: a roll through the last beat, over a swell');
     ok(run(`(() => { const s = cast('KRSTVM', 'iao').song, l = s.sections.at(-1), t = l.end - l.tail, after = s.events.filter((e) => e.beat > t + 1e-6);
         const held = cast('KRSTVM', 'sevenfold').song, hl = held.sections.at(-1), hp = held.events.filter((e) => e.type === 'pad').at(-1);
         return after.length === 0 && s.events.filter((e) => e.beat >= t - 1e-6 && e.type !== 'bell').every((e) => e.dur == null || e.beat + e.dur <= t + 3 + 1e-6)
           && s.events.some((e) => e.type === 'bell' && e.beat === t && e.dur === 8) && hp.beat + hp.dur >= hl.end; })()`),
        'and it is left to ring: nothing is played after it and only the bell is held (the Sevenfold’s last chord is held to the end, as it always was)');
     ok(run(`(() => { const D = SoundDesign.derive(buildSigil('KRSTVM').hash, 0), struck = { intensity: 3, final: true, ends: 'struck', role: 'chorus2' }, faded = { intensity: 3, final: true };
         const a = SoundDesign.arc(D, struck, 2, 3), b = SoundDesign.arc(D, faded, 2, 3), c = SoundDesign.arc(D, { intensity: 3 }, 2, 3);
         return a.bright === c.bright && a.drums === c.drums && b.bright < a.bright && b.drums < a.drums; })()`),
        'its last section is not dimmed as a Banishing is: the sound stays what a height sounds like');
     ok(run(`(() => { const D = SoundDesign.derive(buildSigil('KRSTVM').hash, 0); const loud = SoundDesign.arc(D, { intensity: 3, role: 'chorus2' }, 0, 8), plain = SoundDesign.arc(D, { intensity: 3 }, 0, 8), mid = SoundDesign.arc(D, { intensity: 3 }, 1, 8);
         return loud.grit >= plain.grit && loud.bright > plain.bright && SoundDesign.arc(D, { intensity: 0, role: 'intro' }, 0, 8).bright === SoundDesign.arc(D, { intensity: 0 }, 0, 8).bright; })()`),
        'and a rite that begins in force (Seven Gates) is not softened at its opening, as a quiet opening still is');
     ok(run(`(() => { let n = 0, open = 0, diff = 0, asHalf = 0;
         for (const w of ['KRSTVM', 'THWLBDNS', 'BCD', 'LVNGHT']) for (const r of ['pentagram', 'goetia', 'gates', 'mantra', 'gnostic', 'mass']) { const s = cast(w, r).song;
           s.sections.forEach((x, i) => { if (x.cadence !== 'half') return; const ph = s.phrases.filter((p) => p.si === i).at(-1); n++;
             if (JSON.stringify(ph.chords) === JSON.stringify(harmonize(ph.notes, s.scale, s.cfg.bias, 'half'))) asHalf++;
             if (JSON.stringify(ph.chords) !== JSON.stringify(harmonize(ph.notes, s.scale, s.cfg.bias, 'full'))) diff++;
             if (ph.chords[3] !== 0) open++; }); }
         return n >= 40 && asHalf === n && open >= n * 0.75 && diff >= n * 0.25; })()`),
        'a section left open (cadence half) is harmonised as an open phrase: most end away from home, many differently than a closed one would');
     ok(run(`OTHERS.every((r) => { const s = cast('KRSTVM', r).song; return displayTransform(s, 0).phi === s.sections[0].Tdisp.phi && displayTransform(s, 0).s === s.sections[0].Tdisp.s; })`),
        'the wheel begins in the first section’s form, whatever form the rite ends in');
   });
   
   group('§7 · the words', () => {
     const run = fresh();
     ok(run(`ALL.every((r) => { const R = Rite.RITES[r]; return R.id === r && R.label && R.label.length <= 18 && R.from && R.blurb && R.blurb.length <= 260; })`), 'every rite has a name short enough for a pill, says where it is from, and what it is');
     ok(run(`OTHERS.every((r) => cast('KRSTVM', r).song.sections.every((s) => s.name && s.desc && s.desc.length <= 76 && /^[IVX]+$/.test(s.roman)))`), 'every section has a numeral, a name, and a line that fits the HUD');
     ok(run(`OTHERS.every((r) => ['KRSTVM', 'BCD', 'LVNGHT'].every((w) => cast(w, r).song.sections.every((s) => !/undefined|NaN|\\$\\{/.test(s.name + s.desc))))`), 'and none of them has a hole in it, for any sigil’s own turn');
     ok(run(`(() => { const s = cast('KRSTVM', 'iao').song, o = sec(s, 'osiris'); return o.desc.includes(s.rotK + '⁄21') && /third|fourth|fifth/.test(o.desc); })()`), 'a turn is described by the sigil’s own numbers: how far the wheel turns, and what interval that is');
     eq(run(`[1, 4, 9, 11, 14, 19].map(Rite.roman).join()`), 'I,IV,IX,XI,XIV,XIX', 'numerals');
     ok(run(`Rite.describe({ rite: 'gates' }) === 'Seven Gates' && Rite.describe({}) === '' && Rite.describe({ rite: 'sevenfold' }) === ''`), 'the HUD names a rite, and leaves the Sevenfold unsaid');
   });
   
   if (!QUICK) {
     group('§8 · it sounds', () => {
       const run = fresh();
       run(`globalThis.D = SigilDSP; globalThis.SR = 24000;
         globalThis.jobOf = (w, r, m, s) => { const x = cast(w, r, m, s), spec = SigilPlan.defaultSpec(x.sig, x.song);
           x.job = SigilPlan.renderJob(x.song, x.sig, { sr: SR, spb: x.song.spb, passes: 1, lens: false, spec, levels: Mastering.referenceLevels(x.song) }); x.job.master = null; return x; };
         /** Render beats [b0, b1) of a job, the chain bypassed; returns { L, R }. */
         globalThis.cut = (x, b0, b1) => { const spb = x.song.spb; return D.renderRange(x.job, b0 * spb, b1 * spb, b0 * spb); };
         globalThis.rms = (o, t0, t1) => { let s = 0; const i0 = Math.max(0, Math.round(t0 * SR)), i1 = Math.min(o.L.length, Math.round(t1 * SR)); for (let i = i0; i < i1; i++) s += o.L[i] * o.L[i] + o.R[i] * o.R[i]; return 10 * Math.log10(s / Math.max(1, 2 * (i1 - i0)) + 1e-12); };
         globalThis.stats = (o) => { let peak = 0, bad = 0; for (let i = 0; i < o.L.length; i++) { const a = Math.abs(o.L[i]), b = Math.abs(o.R[i]); if (!(a < 1e9) || !(b < 1e9)) bad++; if (a > peak) peak = a; if (b > peak) peak = b; } return { peak, bad }; };`);
       const probe = run(`typeof D.renderRange`);
       if (probe !== 'function') { ok(false, 'the DSP core can render a range of a job', `SigilDSP.renderRange is ${probe}`); return; }
   
       run(`/** K-weighted loudness of beats [b0, b1) of a render that began at beat 'from'. */
         globalThis.loud = (x, o, b0, b1, from) => { const spb = x.song.spb, i0 = Math.max(0, Math.round((b0 - (from || 0)) * spb * SR)), i1 = Math.min(o.L.length, Math.round((b1 - (from || 0)) * spb * SR));
           return +Mastering.measure(o.L.subarray(i0, i1), o.R.subarray(i0, i1), SR).lufs.toFixed(1); };`);
       const posture = JSON.parse(run(`(() => { const x = jobOf('KRSTVM', 'posture'), s = x.song, o = cut(x, 0, s.total), again = cut(jobOf('KRSTVM', 'posture'), 0, s.total), st = stats(o);
         let same = o.L.length === again.L.length; for (let i = 0; same && i < o.L.length; i += 7) if (o.L[i] !== again.L[i] || o.R[i] !== again.R[i]) same = false;
         const lv = s.sections.map((q) => loud(x, o, q.start, q.end - (q.tail || 0)));
         return JSON.stringify({ peak: st.peak, bad: st.bad, same, lv, ids: s.sections.map((q) => q.id) }); })()`));
       ok(posture.bad === 0 && posture.peak > 0.05 && posture.peak < 1.6, 'Death Posture renders finite and audible, the chain bypassed', JSON.stringify(posture));
       ok(posture.same, 'and the same twice, sample for sample');
       const pv = Object.fromEntries(posture.ids.map((id, i) => [id, posture.lv[i]]));
       ok(Object.keys(pv).every((id) => id === 'vacuity' || pv.vacuity < pv[id] - 2) && pv.vacuity < pv.sigil - 5 && pv.vacuity > -50,
          `its Vacuity is the quietest thing in it, and is not nothing (${pv.vacuity} LUFS; the sections around it ${pv.posture} and ${pv.flash})`, JSON.stringify(pv));
       ok(pv.flash > pv.vacuity + 5 && pv.flash >= pv.posture, `and the Flash comes out of it at force (${pv.flash} after ${pv.vacuity})`, JSON.stringify(pv));
   
       const iao = JSON.parse(run(`(() => { const x = jobOf('KRSTVM', 'iao'), s = x.song, l = s.sections.at(-1), o = cut(x, l.end - l.tail - 8, s.total), t0 = 8 * s.spb, st = stats(o);
         return JSON.stringify({ bad: st.bad, before: +rms(o, t0 - 1, t0).toFixed(1), stroke: +rms(o, t0, t0 + 0.25).toFixed(1), ring2: +rms(o, t0 + 1.5, t0 + 2).toFixed(1), ring4: +rms(o, t0 + 4, t0 + 4.5).toFixed(1) }); })()`));
       ok(iao.bad === 0 && iao.stroke >= iao.before - 1.5 && iao.ring4 < iao.stroke - 4 && iao.ring4 < iao.ring2 - 2 && iao.ring4 > -70,
          `I·A·O ends struck: the last stroke is as loud as the bar before it (${iao.stroke} after ${iao.before} dB), and then it rings down (${iao.ring2}, then ${iao.ring4}) without being cut`, JSON.stringify(iao));
   
       const gates = JSON.parse(run(`(() => { const x = jobOf('THWLBDNS', 'gates'), s = x.song, o = cut(x, 0, s.total), st = stats(o);
         return JSON.stringify({ bad: st.bad, peak: st.peak, lv: s.sections.map((q) => loud(x, o, q.start, q.end - (q.tail || 0))) }); })()`));
       ok(gates.bad === 0 && gates.lv[0] === Math.max(...gates.lv) && gates.lv[0] > gates.lv[6] + 4 && Math.min(...gates.lv.slice(0, 4)) > Math.max(...gates.lv.slice(5)) && gates.lv[7] <= gates.lv[6],
          `Seven Gates goes down in the sound as it does on the page (${gates.lv.join(', ')} LUFS)`, JSON.stringify(gates));
   
       const cone = JSON.parse(run(`(() => { const x = jobOf('KRSTVM', 'cone'), s = x.song, o = cut(x, 0, s.total), st = stats(o);
         return JSON.stringify({ bad: st.bad, lv: s.sections.map((q) => loud(x, o, q.start, q.end - (q.tail || 0))) }); })()`));
       ok(cone.bad === 0 && cone.lv[4] === Math.max(...cone.lv) && cone.lv[0] === Math.min(...cone.lv) && cone.lv[4] > cone.lv[0] + 3,
          `Cone of Power comes up: its circle is its quietest section and its release its loudest (${cone.lv.join(', ')} LUFS)`, JSON.stringify(cone));
   
       const styled = JSON.parse(run(`(() => { const x = jobOf('BCD', 'cone', 'wrath', 'metal'), s = x.song, o = cut(x, 0, Math.min(s.total, 64)), st = stats(o), y = jobOf('LVNGHT', 'mantra', 'reverie', 'bossa'), o2 = cut(y, 16, 64), st2 = stats(o2);
         return JSON.stringify({ a: st, b: st2 }); })()`));
       ok(styled.a.bad === 0 && styled.b.bad === 0 && styled.a.peak > 0.05 && styled.b.peak > 0.02 && styled.a.peak < 1.8 && styled.b.peak < 1.8, 'a rite in a mood and a style renders finite and audible too', JSON.stringify(styled));
     });
   }
   
   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
   