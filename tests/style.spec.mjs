/* ══════════════════════════════════════════════════════════════════════════
   STYLE SPEC — styles and elements (05f), laid over the moods (m6), compiled
   (06b) and heard (DSP). No browser, no dependencies.

     node tests/style.spec.mjs            everything (about a minute)
     node tests/style.spec.mjs --quick    skip the audio renders
     node tests/style.spec.mjs §5         only the groups whose names contain this

   What it defends
     1. WITHOUT A STYLE OR AN ELEMENT, NOTHING CHANGES: the song is, event for
        event, the song before this layer existed.
     2. ANY THREE MAKE ONE PIECE: every mood × style, every style × element,
        composes into a well-formed score.
     3. TEMPO: a style has its own span; the sigil's place in it and the mood's
        lean are both kept.
     4. THE MOOD'S CONTOUR HOLDS in every style: a hush stays hushed, a
        drumless rite drumless, four-on-the-floor four-on-the-floor.
     5. EACH IDIOM IS WHAT IT SAYS: the strokes that make a style that style
        are where they should be.
     6. THE SIGIL IS STILL READ: two sigils in one style are two grooves; the
        fills still speak the sigil; same inputs, same song.
     7. SOUND: a style pulls, a mood sets, an element leans (SoundDesign.shape).
     8. PITCH: every note a style wrote can be re-derived from its chord.
     9. IT SOUNDS: a styled song compiles, renders finite and the same twice,
        and its new strokes (clap, ride, chords) make sound.
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['src/core/00-utils.js', 'src/core/01-crypto.js', 'src/core/02-reduction.js', 'src/core/03-geometry.js',
     'src/core/04-theory.js', 'src/core/05-composer.js', 'src/core/05b-timbre.js', 'src/core/05c-groove.js', 'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js', 'src/core/05e-master.js', 'src/core/05f-style.js', 'src/core/06b-compiler.js'];
   const QUICK = process.argv.includes('--quick');
   const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('--'));
   
   /**
    * A fresh VM: the pure layers, the DSP core and the compiler, in index.html's order; then the
    * moods (m6, behind a stub of the page) and the same hooks m15 and m21 register in the app.
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
     run(`var STYLE = 'none', ELEMENT = 'aether', DRUMS = { take: 0, variation: 0.6, fills: 0.6, ghosts: 0.5, human: 0.4 }, LAYER = true;
       Hooks.on('compose', (cfg) => { if (LAYER) Style.before(cfg); }, -20);
       Hooks.on('compose', (cfg, sigil) => { if (LAYER) Style.compose(cfg, sigil, STYLE, ELEMENT); }, 20);
       Hooks.on('plan', (plan, cfg) => { if (LAYER) Style.plan(plan, cfg); }, 20);
       Hooks.on('score', (events, c) => Groove.score(events, c, { ...DRUMS, ...((c.cfg && c.cfg.drums) || {}) }));
       Hooks.on('score', (events, c) => (LAYER ? Style.parts(events, c) : undefined), 10);
       globalThis.cast = (word, mood, style, element) => { Moods.set(mood || 'ritual', { persist: false }); STYLE = style || 'none'; ELEMENT = element || 'aether';
         const sig = buildSigil(word); return { sig, song: composeSong(sig) }; };
       globalThis.MOODS = Object.keys(Moods.MOODS); globalThis.STYLES = Object.keys(Style.STYLES); globalThis.ELEMENTS = Object.keys(Style.ELEMENTS);
       globalThis.print = (song) => JSON.stringify(song.events.map((e) => [e.type, +e.beat.toFixed(4), e.midi ?? (e.midis || []).join('/'), +(e.vel ?? 0).toFixed(4), +(e.dur ?? 0).toFixed(4), e.tom ?? '', e.open ? 1 : 0]));
       /** The strokes of one kind in one bar of a section, as sixteenth steps (the swing taken back out by rounding). */
       globalThis.steps = (song, id, bar, type) => { const sec = song.sections.find((s) => s.id === id), t0 = sec.start + bar * 4;
         return [...new Set(song.events.filter((e) => e.type === type && e.beat >= t0 - 0.06 && e.beat < t0 + 3.94).map((e) => Math.min(15, Math.round((e.beat - t0 - 0.03) * 4))))].sort((a, b) => a - b); };
       globalThis.count = (song, id, bar, type) => { const sec = song.sections.find((s) => s.id === id), t0 = sec.start + bar * 4;
         return song.events.filter((e) => e.type === type && e.beat >= t0 - 0.06 && e.beat < t0 + 3.94).length; };
       globalThis.has = (a, list) => list.every((x) => a.includes(x));`);
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
   group('§1 · without a style or an element, nothing changes', () => {
     const run = fresh();
     ok(run(`['KRSTVM', 'THWLBDNS', 'BCD'].every((w) => ['ritual', 'dirge', 'pulse', 'ambient'].every((m) => {
         LAYER = true; const a = cast(w, m, 'none', 'aether').song; LAYER = false; const b = cast(w, m).song; LAYER = true;
         return print(a) === print(b) && a.bpm === b.bpm && JSON.stringify(a.levels) === JSON.stringify(b.levels) && a.cfg.feel === undefined && a.cfg.styleSound === undefined; }))`),
        'None and Aether: the score, the tempo and the faders are those of a song composed without this layer');
     ok(run(`(() => { const { sig, song } = cast('KRSTVM', 'abyss'); const a = SigilPlan.defaultSpec(sig, song).P, own = { ...SoundDesign.derive(sig.hash, 0), ...SoundDesign.drumFx(sig.hash, 0), ...song.cfg.sound };
         return Object.keys(own).every((k) => JSON.stringify(a[k]) === JSON.stringify(own[k])); })()`),
        'and the patch is the sigil’s own with the mood’s values over it, as it always was');
     eq(run(`STYLES.length`), 20, 'there are nineteen styles, and None');
     eq(run(`ELEMENTS.join()`), 'aether,fire,water,air,earth', 'and four elements, and Aether');
     ok(run(`MOODS.length === 28 && MOODS.slice(0, 20).join() === 'ritual,ambient,pulse,lullaby,dirge,ecstatic,glacier,swarm,abyss,aurora,procession,clockwork,fathom,gilded,static,vigil,nocturne,ember,tidewater,sanctum'`),
        'twenty-eight moods: the twenty there were, in their order, and eight more after them');
   });
   
   group('§2 · any three make one piece', () => {
     const run = fresh();
     const bad = run(`(() => { const bad = []; let n = 0;
       const check = (w, m, s, e) => { n++; try { const { song } = cast(w, m, s, e);
           for (const ev of song.events) {
             if (!(ev.beat >= 0 && ev.beat < song.total + 1e-6)) { bad.push([w, m, s, e, 'beat', ev.type, ev.beat]); break; }
             if (ev.midi != null && !(ev.midi >= 12 && ev.midi <= 120)) { bad.push([w, m, s, e, 'midi', ev.type, ev.midi]); break; }
             if (ev.midis && !ev.midis.every((x) => x >= 12 && x <= 120)) { bad.push([w, m, s, e, 'midis', ev.midis]); break; }
             if (ev.dur != null && !(ev.dur > 0)) { bad.push([w, m, s, e, 'dur', ev.type, ev.dur]); break; }
             if (ev.vel != null && !(ev.vel > 0 && ev.vel <= 1.25)) { bad.push([w, m, s, e, 'vel', ev.type, ev.vel]); break; }
           }
           if (!(song.bpm >= 40 && song.bpm <= 240)) bad.push([w, m, s, e, 'bpm', song.bpm]);
           if (!song.events.some((x) => x.type === 'lead') && !song.events.some((x) => x.type === 'bell')) bad.push([w, m, s, e, 'no melody']);
         } catch (err) { bad.push([w, m, s, e, String(err.stack).split('\\n').slice(0, 2).join(' | ')]); } };
       for (const m of MOODS) for (const s of STYLES) check('KRSTVM', m, s, 'aether');
       for (const s of STYLES) for (const e of ELEMENTS) check('THWLBDNS', 'ritual', s, e);
       for (const m of MOODS) for (const e of ELEMENTS) check('BCD', m, 'none', e);
       for (const w of ['PLMNKJHGFDSTRVWXYZBC', 'XZQ', 'MNJLRWY']) for (const s of STYLES) check(w, MOODS[(s.length * 7) % MOODS.length], s, ELEMENTS[s.length % 5]);
       globalThis.N2 = n; return bad; })()`);
     ok(bad.length === 0, `${run('N2')} workings (every mood × style, every style × element, every mood × element, long and short sigils): every score is well formed`, JSON.stringify(bad.slice(0, 4)));
     ok(run(`(() => { const a = cast('KRSTVM', 'dirge', 'trap', 'water').song, b = cast('KRSTVM', 'dirge', 'trap', 'water').song; return print(a) === print(b) && a.bpm === b.bpm; })()`),
        'the same sigil in the same working is the same song, event for event');
     ok(run(`(() => { const melody = (s) => JSON.stringify(s.events.filter((e) => e.type === 'lead').map((e) => [e.deg, e.midi - s.leadBase]));
         const chords = (s) => JSON.stringify(s.phrases.map((p) => p.chords));
         const base = cast('THWLBDNS', 'ritual').song;
         return STYLES.every((st) => { const s = cast('THWLBDNS', 'ritual', st, 'fire').song; return melody(s) === melody(base) && chords(s) === chords(base) && s.sections.length === base.sections.length; }); })()`),
        'no style or element touches the melody, the chords or the form: those are the sigil’s');
   });
   
   group('§3 · tempo: the style’s span, the sigil’s place in it, the mood’s lean', () => {
     const run = fresh();
     ok(run(`STYLES.filter((s) => s !== 'none').every((s) => { const T = Style.STYLES[s].tempo;
         return ['KRSTVM', 'THWLBDNS', 'BCD', 'FSHVZXC', 'MNJLRWY'].every((w) => { const b = cast(w, 'ritual', s).song.bpm; return b >= T[0] && b <= T[1]; }); })`),
        'in the Ritual mood every style sits inside its own span');
     ok(run(`(() => { const own = (w) => cast(w, 'ritual').song.bpm, ws = ['KRSTVM', 'THWLBDNS', 'BCD', 'FSHVZXC', 'MNJLRWY', 'BPDGKTQ', 'LVNGHT'].sort((a, b) => own(a) - own(b));
         return STYLES.filter((s) => s !== 'none').every((s) => ws.every((w, i) => i === 0 || cast(w, 'ritual', s).song.bpm >= cast(ws[i - 1], 'ritual', s).song.bpm)); })()`),
        'a faster sigil is a faster song in every style');
     ok(run(`STYLES.filter((s) => s !== 'none').every((s) => { const r = cast('THWLBDNS', 'ritual', s).song.bpm;
         return cast('THWLBDNS', 'glacier', s).song.bpm < r && cast('THWLBDNS', 'ecstatic', s).song.bpm > r && cast('THWLBDNS', 'glacier', s).song.bpm > r * 0.6; })`),
        'a slow mood slows it and a fast one quickens it, damped: Glacier never halves a style');
     ok(run(`['punk', 'metal', 'dnb', 'trap'].every((s) => cast('KRSTVM', 'ritual', s).song.cfg.felt === 2) && cast('KRSTVM', 'ritual', 'pop').song.cfg.felt === undefined
         && Style.felt(cast('KRSTVM', 'ritual', 'punk').song.cfg, 88) === 176`), 'the double-time styles say how fast they feel');
     ok(run(`cast('KRSTVM', 'ritual', 'none', 'fire').song.bpm > cast('KRSTVM', 'ritual').song.bpm && cast('KRSTVM', 'ritual', 'none', 'earth').song.bpm < cast('KRSTVM', 'ritual').song.bpm`),
        'Fire leans the tempo up and Earth down');
   });
   
   group('§4 · the mood’s contour holds in every style', () => {
     const run = fresh();
     run(`globalThis.KIT = new Set(['kick', 'snare', 'hat', 'clap', 'ride', 'rim', 'tom', 'shaker', 'crash']);`);
     ok(run(`STYLES.every((s) => cast('KRSTVM', 'lullaby', s).song.sections.every((x) => x.intensity <= 1))`), 'a Lullaby stays hushed (no section above level 1)');
     ok(run(`STYLES.every((s) => { const song = cast('KRSTVM', 'ambient', s).song; return song.sections.every((x) => x.intensity === 0) && !song.events.some((e) => KIT.has(e.type)); })`),
        'an Ambient rite stays drumless');
     ok(run(`STYLES.every((s) => { const song = cast('KRSTVM', 'pulse', s).song;
         return song.sections.filter((x) => x.intensity >= 2 && !x.halfTime).every((x) => has(steps(song, x.id, 1, 'kick'), [0, 4, 8, 12])); })`),
        'Pulse keeps its four on the floor');
     ok(run(`STYLES.every((s) => { const a = cast('THWLBDNS', 'ritual', s).song.sections, hi = 3; return a.every((x) => x.intensity >= 0 && x.intensity <= hi); })
         && ['punk', 'edm', 'grunge'].every((s) => { const x = cast('THWLBDNS', 'dirge', s).song.sections; return x.every((q) => q.intensity <= 2) && x.filter((q) => q.halfTime).length >= 4; })`),
        'a Dirge keeps its ceiling and its half-time in punk, EDM and grunge alike');
     ok(run(`cast('KRSTVM', 'ecstatic', 'hiphop').song.sections.filter((x) => x.halfTime).length <= 1 && cast('KRSTVM', 'ecstatic', 'none').song.sections.filter((x) => x.halfTime).length >= 4`),
        'half-time that was only there for speed (Ecstatic) is let go in a style that is not fast');
     ok(run(`(() => { const g = cast('KRSTVM', 'ritual', 'grunge').song.sections, byId = Object.fromEntries(g.map((s) => [s.id, s.intensity]));
         return byId.verse1 === 1 && byId.chorus1 === 3 && byId.verse2 === 1 && cast('KRSTVM', 'ritual', 'edm').song.sections.find((s) => s.id === 'bridge').intensity === 0; })()`),
        'inside the mood’s range a style has its own shape: grunge is quiet then loud, EDM breaks down before the last drop');
   });
   
   group('§5 · each idiom is what it says', () => {
     const run = fresh();
     run(`globalThis.S = (style, mood) => cast('THWLBDNS', mood || 'ritual', style).song;
       globalThis.bb = (song, id, bar) => [...new Set([...steps(song, id, bar, 'snare'), ...steps(song, id, bar, 'clap'), ...steps(song, id, bar, 'rim')])];`);
     ok(run(`['edm', 'house', 'techno', 'dembow'].every((s) => has(steps(S(s), 'chorus1', 1, 'kick'), [0, 4, 8, 12]))`), 'EDM, house, techno, dembow: four on the floor');
     ok(run(`['hiphop', 'pop', 'grunge', 'synthwave', 'funk', 'chiptune', 'metal', 'lofi', 'trap'].every((s) => has(bb(S(s), 'chorus1', 1), [4, 12]))`),
        'hip hop, pop, grunge, synthwave, funk, chiptune, metal, lo-fi, trap: the backbeat on two and four');
     ok(run(`['punk', 'dnb'].every((s) => has(steps(S(s), 'chorus1', 1, 'snare'), [2, 6, 10, 14]))`), 'punk and drum & bass: the snare on every felt off-beat (twice the tempo)');
     ok(run(`has(steps(S('punk'), 'chorus1', 1, 'kick'), [0, 4, 8, 12]) && count(S('punk'), 'chorus1', 1, 'comp') >= 40 && count(S('punk'), 'chorus1', 1, 'bass') === 16
         && S('punk').events.filter((e) => e.type === 'comp').every((e) => e.shape === 'power')`), 'punk: the fast two-beat, a root on every sixteenth, power chords on every stroke');
     ok(run(`(() => { const s = S('trap'); return has(steps(s, 'chorus1', 1, 'clap'), [4, 12]) && count(s, 'chorus1', 1, 'hat') >= 16 && s.events.some((e) => e.type === 'bass' && e.from != null) && s.bpm <= 76; })()`),
        'trap: slow underneath, claps on two and four, hats that roll, an 808 that slides');
     ok(run(`(() => { const s = S('reggae'), k = steps(s, 'verse1', 1, 'kick'); return !k.includes(0) && k.includes(8) && has(steps(s, 'verse1', 1, 'comp'), [2, 6, 10, 14]); })()`),
        'reggae: nothing on one, the drop on three, the chords on the off-beats');
     ok(run(`(() => { const s = S('jazz'), sec = s.sections.find((x) => x.id === 'verse1'), t0 = sec.start + 4;
         const ride = s.events.filter((e) => e.type === 'ride' && e.beat >= t0 && e.beat < t0 + 4).map((e) => +(e.beat - t0).toFixed(2));
         const bass = s.events.filter((e) => e.type === 'bass' && e.beat >= t0 - 0.01 && e.beat < t0 + 3.99);
         globalThis.JZ = [ride, bass.map((e) => e.srole)];
         return ride.some((b) => Math.abs(b % 1 - 0.64) < 0.03) && bass.length >= 4 && bass[3].srole === 'app' && count(s, 'verse1', 1, 'hat') === 2; })()`),
        'jazz: the ride swings in triplets, the hat closes on two and four, the bass walks into the next chord', run(`JSON.stringify(JZ)`));
     ok(run(`(() => { const s = S('bossa'); return count(s, 'verse1', 0, 'rim') === 5 && has(steps(s, 'verse1', 0, 'kick'), [0, 8]) && count(s, 'verse1', 0, 'shaker') === 16; })()`),
        'bossa: five strokes of clave on the rim, a heartbeat on the kick, a shaker that never stops');
     ok(run(`has(steps(S('dembow'), 'chorus1', 1, 'snare'), [3, 6, 11, 14])`), 'dembow: boom-ch-boom-chick');
     ok(run(`count(S('metal'), 'chorus1', 1, 'kick') >= 14 && count(S('metal'), 'verse1', 1, 'kick') === 12`), 'metal: the gallop in the verse, both feet in the chorus');
     ok(run(`(() => { const s = S('edm'), last = (id) => s.sections.find((x) => x.id === id).phrases * 4 - 1, br = s.sections.find((x) => x.id === 'bridge');
         const inBridge = (type) => s.events.filter((e) => e.type === type && e.beat >= br.start && e.beat < br.end).length;
         return count(s, 'verse1', last('verse1'), 'snare') >= 12 && count(s, 'verse1', last('verse1'), 'kick') === 0 && s.events.some((e) => e.type === 'swell' && e.dur >= 8)
           && has(steps(s, 'chorus1', 1, 'bass'), [2, 6, 10, 14]) && br.intensity === 0 && inBridge('kick') === 0 && count(s, 'bridge', last('bridge'), 'snare') >= 12; })()`),
        'EDM: the bass between the kicks; before each drop the kick lets go and the snare doubles over a long swell, even out of the breakdown');
     ok(run(`count(S('chiptune'), 'chorus1', 1, 'arp') === 32 && cast('THWLBDNS', 'ritual', 'chiptune').song.cfg.styleSound.set.bits === 5`), 'chiptune: chords as thirty-second arpeggios, five bits');
     ok(run(`(() => { const g = S('grunge'); return count(g, 'verse1', 1, 'comp') === 0 && count(g, 'verse1', 1, 'arp') === 8 && count(g, 'chorus1', 1, 'comp') >= 9 && count(g, 'chorus1', 1, 'arp') === 0; })()`),
        'grunge: a clean arpeggio in the verse, power chords in the chorus');
     ok(run(`['hiphop', 'lofi', 'funk', 'house'].every((s) => S(s).cfg.feel.swing > 0.05) && ['punk', 'edm', 'metal', 'trap', 'chiptune'].every((s) => S(s).cfg.feel.swing === 0) && S('jazz').cfg.feel.shuffle > 0.5`),
        'the styles that swing, swing; the ones that do not, do not; jazz shuffles');
     ok(run(`(() => { const s = S('hiphop'), sec = s.sections.find((x) => x.id === 'verse1'), t0 = sec.start + 4;
         const late = s.events.filter((e) => e.type === 'hat' && e.beat >= t0 && e.beat < t0 + 4).map((e) => e.beat - t0).filter((b) => Math.abs((b * 4) % 2 - 1) < 0.45);
         const lead = s.events.filter((e) => e.type === 'lead' && e.beat >= t0 && e.beat < t0 + 4).every((e) => Math.abs(e.beat * 2 - Math.round(e.beat * 2)) < 1e-6);
         return lead && s.P.swing === 0; })()`), 'swing is applied to the whole score as one (the composer itself writes straight)');
   });
   
   group('§6 · the sigil is still read', () => {
     const run = fresh();
     ok(run(`['hiphop', 'pop', 'grunge', 'funk', 'trap'].every((s) => new Set(['KRSTVM', 'THWLBDNS', 'BCD', 'FSHVZXC', 'MNJLRWY', 'LVNGHT'].map((w) => steps(cast(w, 'ritual', s).song, 'chorus1', 0, 'kick').join())).size >= 3)`),
        'in one style, different sigils kick in different places (the polygon chooses, the idiom allows)');
     ok(run(`(() => { const s = cast('KRSTVM', 'ritual', 'pop').song; return s.cfg.groove.style === 'pop' && s.cfg.groove.said.length > 8 && s.cfg.groove.nFills >= 4 && s.events.some((e) => e.fill); })()`),
        'the fills still speak the sigil');
     ok(run(`(() => { const a = cast('THWLBDNS', 'ritual', 'funk').song; DRUMS.take = 3; const b = cast('THWLBDNS', 'ritual', 'funk').song; DRUMS.take = 0;
         const kit = (s) => JSON.stringify(s.events.filter((e) => Groove.TYPES.has(e.type)).map((e) => [e.type, +e.beat.toFixed(3)]));
         return kit(a) !== kit(b); })()`), 'another groove of the same sigil is another part, in a style too');
     ok(run(`(() => { const { sig, song } = cast('THWLBDNS', 'ritual', 'hiphop'); const bag = (s) => JSON.parse(print(s)).map((r) => r.join('|')).sort().join(';'), before = bag(song);
         Groove.apply(song, sig, { ...DRUMS, ...song.cfg.drums, fills: 0 }); const none = song.events.filter((e) => e.fill).length;
         Groove.apply(song, sig, { ...DRUMS, ...song.cfg.drums }); return none === 0 && bag(song) === before; })()`),
        'the kit can be re-written in place (the Drum Engine’s sliders) and comes back the same');
     ok(run(`(() => { const s = cast('KRSTVM', 'ritual', 'synthwave').song, r = s.sections.find((x) => x.id === 'chorus1').rhythm; return r && r.kick.length === 16 && r.kick[0] && r.hat.some(Boolean); })()`),
        'each section still has a polygon to draw at the hub: the kick and hat that are actually played');
   });
   
   group('§7 · sound: a style pulls, a mood sets, an element leans', () => {
     const run = fresh();
     run(`globalThis.P = (w, m, s, e) => { const { sig, song } = cast(w, m, s, e); return SigilPlan.defaultSpec(sig, song).P; };
       globalThis.own = (w) => ({ ...SoundDesign.derive(buildSigil(w).hash, 0), ...SoundDesign.drumFx(buildSigil(w).hash, 0) });`);
     ok(run(`(() => { const a = P('KRSTVM', 'ritual', 'edm'), b = P('THWLBDNS', 'ritual', 'edm'), oa = own('KRSTVM'), ob = own('THWLBDNS');
         return Math.abs(a.bright - 0.85) < Math.abs(oa.bright - 0.85) + 1e-9 && a.bright !== b.bright && Math.sign(a.bright - b.bright) === Math.sign(oa.bright - ob.bright) && a.grit === 0 && b.grit === 0; })()`),
        'a style draws a sigil’s own numbers toward its signature without making two sigils one sound; what it sets, it sets');
     ok(run(`P('KRSTVM', 'abyss', 'edm').bright === 0.25 && P('KRSTVM', 'abyss', 'edm').grit === 0.55 && P('KRSTVM', 'gilded', 'trap').voice === 'bell'`), 'what a mood sets, it still sets: the mood bends the style');
     ok(run(`(() => { const n = P('KRSTVM', 'ritual', 'pop'), f = P('KRSTVM', 'ritual', 'pop', 'fire'), w = P('KRSTVM', 'ritual', 'pop', 'water'), a = P('KRSTVM', 'ritual', 'pop', 'air'), e = P('KRSTVM', 'ritual', 'pop', 'earth');
         return f.bright > n.bright && f.drive > n.drive && f.grit >= 0.4 && f.bits === 16 && w.chorus > n.chorus && w.echo > n.echo && a.sub < n.sub && a.bright > n.bright && e.sub > n.sub && e.bright < n.bright; })()`),
        'an element leans on whatever is there: Fire drives and brightens (waking the crusher without its grain), Water deepens, Air lightens, Earth weighs');
     ok(run(`STYLES.filter((s) => s !== 'none').every((s) => ELEMENTS.every((e) => ['KRSTVM', 'BCD', 'FSHVZXC'].every((w) => { const p = P(w, 'ritual', s, e); return Style.STYLES[s].voices.includes(p.voice) && Style.STYLES[s].layers.includes(p.layer); })))`),
        'the lead’s voice and the cube’s family are always among the style’s own, whichever element orders them');
     ok(run(`new Set(ELEMENTS.map((e) => P('KRSTVM', 'ritual', 'pop', e).voice)).size >= 2`), 'and the element changes who sings');
     ok(run(`(() => { const S = SoundDesign.shape, o = { bright: 0.5, grit: 0, bits: 4, hold: 3, voice: 'auto' };
         return S(o, null).bright === 0.5 && S(o, { sound: { bright: 0.9 } }).bright === 0.9 && Math.abs(S(o, { styleSound: { pull: { bright: [1, 0.5] } } }).bright - 0.75) < 1e-9
           && S(o, { styleSound: { pull: { bright: [1, 0.5] }, set: { voice: 'fm' } }, sound: { bright: 0.2 } }).bright === 0.2 && S(o, { styleSound: { set: { voice: 'fm' } } }).voice === 'fm'
           && Math.abs(S(o, { soundMod: { bright: { mul: 1.2, add: 0.1 } } }).bright - 0.7) < 1e-9 && S(o, { soundMod: { bright: { mul: 9 } } }).bright === 1
           && S(o, { soundMod: { grit: { min: 0.4 } } }).bits === 16 && S({ ...o, grit: 0.3 }, { soundMod: { grit: { min: 0.4 } } }).bits === 4; })()`),
        'SoundDesign.shape: own → pull → set → the mood’s → the element’s, clamped to each field’s range');
     ok(run(`(() => { const a = cast('KRSTVM', 'static', 'chiptune', 'fire').song.cfg; return a.master.noise === 17 && a.master.lean.air > 0.5 && a.master.house.arp === 4 && cast('KRSTVM', 'hymn', 'punk').song.cfg.levels.drums === 0
           && Math.abs(cast('KRSTVM', 'ritual', 'reggae', 'water').song.cfg.space - 1.2 * 1.35) < 1e-9; })()`),
        'the master’s hints add up across mood, style and element; faders multiply (a silenced kit stays silent); the hall is asked for by both');
     ok(run(`(() => { const { sig, song } = cast('KRSTVM', 'ritual', 'reggae', 'earth'); const j = SigilPlan.renderJob(song, sig, { sr: 32000, spb: song.spb, passes: 1, lens: false, spec: SigilPlan.defaultSpec(sig, song), levels: null });
         const { song: plain, sig: s2 } = cast('KRSTVM', 'ritual'); const k = SigilPlan.renderJob(plain, s2, { sr: 32000, spb: plain.spb, passes: 1, lens: false, spec: SigilPlan.defaultSpec(s2, plain), levels: null });
         return Math.abs(j.params.reverb - 0.85 * 1.2 * 0.7) < 1e-9 && k.params.reverb === 0.85 && j.reverb.rt60 < k.reverb.rt60 && j.mix.mood.lean.weight > 0.5; })()`),
        'and all of it reaches the render job: the hall’s return and size, the finish’s lean');
   });
   
   group('§8 · pitch: every note a style wrote can be re-derived from its chord', () => {
     const run = fresh();
     ok(run(`STYLES.filter((s) => s !== 'none').every((s) => { const { song } = cast('THWLBDNS', 'ritual', s);
         return song.events.filter((e) => e.st).every((e) => { const p = Style.pitch(e, e.chord, song, e.chord2);
           return e.type === 'pad' ? JSON.stringify(p) === JSON.stringify(e.midis) : p === e.midi; }); })`),
        'for its own chord, each styled note’s pitch is the one it was written with');
     ok(run(`(() => { const { song } = cast('THWLBDNS', 'ritual', 'punk'); const e = song.events.find((x) => x.type === 'comp' && x.k === 0), up = (e.chord + 3) % 7;
         const a = Style.pitch(e, e.chord, song), b = Style.pitch(e, up, song); const pc = (m) => ((m % 12) + 12) % 12;
         const want = pc(song.leadBase + song.scale[up]);
         return a !== b && pc(b) === want && Style.chordTones('power', up, song).map((m) => pc(m) === want || pc(m) === pc(want + 7)).every(Boolean); })()`),
        'for another chord it is that chord’s: a power chord stays a power chord (root, fifth, octave) wherever the Lens turns it');
     ok(run(`(() => { const { song } = cast('THWLBDNS', 'ritual', 'jazz'); const k = { scale: song.scale, leadBase: song.leadBase, bassBase: song.bassBase };
         return [0, 1, 2, 3, 4, 5, 6].every((c) => [0, 3, 4].every((c2) => { const a = Style.bassMidi(c, 'app', k, c2), r = bassPitch(c2, 'root', song.bassBase, song.scale); return a < r + 12 && (r - a === 1 || r - a === 2 || a - r >= 9); })); })()`),
        'a walking bass approaches the next root from the scale step under it');
     ok(run(`(() => { const w = Style.warp; return w(1.5, 0, 0) === 1.5 && Math.abs(w(0.5, 0, 1) - 2 / 3) < 1e-9 && w(3, 0.3, 0.8) === 3 && Math.abs(w(0.25, 0.3, 0) - 0.325) < 1e-9 && w(0.5, 0.3, 0) === 0.5
           && [0.1, 0.3, 0.5, 0.7, 0.9].every((x, i, a) => i === 0 || w(x, 0.3, 0.7) > w(a[i - 1], 0.3, 0.7)); })()`),
        'the feel moves the off-beats and never the beats, and never puts two notes out of order');
   });
   
   if (!QUICK || ONLY.length) {
     group('§9 · it sounds', () => {
       const run = fresh();
       run(`globalThis.D = SigilDSP;
         globalThis.jobOf = (w, m, s, e, sr) => { const { sig, song } = cast(w, m, s, e); const spec = SigilPlan.defaultSpec(sig, song);
           return { song, job: SigilPlan.renderJob(song, sig, { sr: sr || 24000, spb: song.spb, passes: 1, lens: false, spec, levels: null }) }; };
         globalThis.slice = (x, sec, bars) => { const a = x.song.sections.find((q) => q.id === sec).start * x.song.spb; return D.renderRange(x.job, Math.max(0, a - 2), a + bars * 4 * x.song.spb, a); };
         globalThis.stats = (r) => { let e = 0, bad = 0, pk = 0; for (let i = 0; i < r.L.length; i++) { const v = r.L[i]; if (!Number.isFinite(v)) bad++; e += v * v; pk = Math.max(pk, Math.abs(v)); } return { rms: 10 * Math.log10(e / r.L.length + 1e-20), bad, pk }; };
         globalThis.hash = (r) => { let h = 2166136261; for (let i = 0; i < r.L.length; i++) h = Math.imul(h ^ (Math.round(r.L[i] * 32767) & 0xffff), 16777619); return (h >>> 0).toString(16); };`);
       const r = run(`[['THWLBDNS', 'ritual', 'punk', 'fire'], ['KRSTVM', 'dirge', 'trap', 'water'], ['BCD', 'pulse', 'edm', 'air'], ['FSHVZXC', 'nocturne', 'jazz', 'earth']].map((a) => {
           const x = jobOf(...a), one = slice(x, 'chorus1', 2), two = slice(jobOf(...a), 'chorus1', 2), s = stats(one);
           return [a.slice(1).join('·'), s.bad, +s.rms.toFixed(1), +s.pk.toFixed(2), hash(one) === hash(two)]; })`);
       ok(r.every((x) => x[1] === 0 && x[2] > -40 && x[3] <= 1.0001), 'four workings render finite, audible, and inside full scale', JSON.stringify(r));
       ok(r.every((x) => x[4]), 'and the same twice, bit for bit');
       const only = run(`(() => { const x = jobOf('THWLBDNS', 'ritual', 'edm', 'aether'), E = D.EV, n = x.job.count, kinds = {};
           const keep = (pred) => { const j = Object.assign({}, x.job, { events: x.job.events.slice(), master: null }); for (let i = 0; i < n; i++) if (!pred(i)) j.events[i * D.STRIDE + E.VEL] = 0; return stats(slice({ song: x.song, job: j }, 'chorus1', 2)).rms; };
           const src = x.song.events, bus = (i) => x.job.events[i * D.STRIDE + E.BUS], kind = (i) => x.job.events[i * D.STRIDE + E.KIND];
           return { chords: keep((i) => bus(i) === D.BUS.pad && kind(i) === D.KIND.WAVE), none: keep(() => false),
             claps: x.song.events.filter((e) => e.type === 'clap').length, rows: n, events: src.length }; })()`);
       ok(only.chords > -60 && only.none < -100 && only.claps > 20 && only.rows > only.events, 'a style’s chords sound on their own, and a clap is several hands (more rows than events)', JSON.stringify(only));
       ok(run(`(() => { const x = jobOf('FSHVZXC', 'ritual', 'jazz', 'aether'), E = D.EV; let rides = 0, bells = 0;
           for (let i = 0; i < x.job.count; i++) { const o = i * D.STRIDE; if (x.job.events[o + E.KIND] === D.KIND.BELL && x.job.events[o + E.BUS] === D.BUS.arp) { bells++; if (!(x.job.events[o + E.P5] > 0)) return false; } }
           return bells > 50 && x.song.events.some((e) => e.type === 'ride'); })()`), 'chords stabbed on bells are damped (they ask for a short ring), and jazz has its ride');
       ok(run(`(() => { const x = jobOf('KRSTVM', 'ritual', 'trap', 'aether'), E = D.EV; let slides = 0;
           for (let i = 0; i < x.job.count; i++) { const o = i * D.STRIDE; if (x.job.events[o + E.BUS] === D.BUS.bass && x.job.events[o + E.F0] > 0) slides++; }
           const duck = (s) => { const x2 = jobOf('KRSTVM', 'ritual', s, 'aether'); return x2.job.sections[2 * D.PSTRIDE + D.PA.DUCK]; };
           return slides > 3 && duck('edm') > duck('pop') && duck('jazz') < duck('pop'); })()`), 'an 808 slides (its row carries where it glides from); EDM pumps harder than pop, jazz hardly at all');
     });
   }
   
   console.log(`\n${pass} passed, ${fail} failed`);
   process.exit(fail ? 1 : 0);
   