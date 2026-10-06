#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   GOLDEN SNAPSHOT CHECK
   --------------------------------------------------------------------------
   Runs the PURE core layers (00–05, 09) inside a vm context and fingerprints
   geometry + score + DSP for a fixed set of inputs. A mismatch means an
   existing sigil has changed: either a bug, or a deliberate change that needs
   the 'SIGIL/v1::' version bumped.

     npm test            verify against tests/golden.json
     npm run test:update re-record (only after a DELIBERATE, versioned change)
   ══════════════════════════════════════════════════════════════════════════ */
   import fs from 'node:fs';
   import path from 'node:path';
   import vm from 'node:vm';
   import { fileURLToPath } from 'node:url';
   
   const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = ['00-utils', '01-crypto', '02-reduction', '03-geometry',
                  '04-theory', '05-composer', '09-dsp'];
   const INPUTS = ['KRSTVM', 'THWLBDNS', 'BCD', 'PLMNKJHGFDSTRVWXYZBC'];
   const SNAP = path.join(ROOT, 'tests', 'golden.json');
   const update = process.argv.includes('--update');
   
   /* A bare context. The core never touches the DOM at load time; Prefs' use of
      localStorage throws a ReferenceError that its own try/catch swallows. */
   const ctx = vm.createContext({ console, TextEncoder, TextDecoder, Math, JSON, Date });
   ctx.window = ctx;
   ctx.globalThis = ctx;
   
   for (const f of FILES) {
     const file = path.join(ROOT, 'src', 'core', `${f}.js`);
     if (!fs.existsSync(file)) { console.error(`✗ missing ${file}`); process.exit(2); }
     try { vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: f + '.js' }); }
     catch (e) { console.error(`✗ ${f}.js failed to run:\n  ${e.message}`); process.exit(2); }
   }
   
   /* The fingerprint must live INSIDE the context: top-level const/let in a vm
      script are lexical and are not exposed as context properties. */
   vm.runInContext(`
   function __fp(word) {
     const s = buildSigil(word);
     const song = composeSong(s);
     const wt = DSP.wavetable(s, 'lead');
     const parts = [
       s.hex.slice(0, 16),
       s.wheel.join(''),
       s.nodes.map(n => n.slot + ':' + n.ring).join(','),
       s.curves.map(c => c.toFixed(4)).join(','),
       CONSONANTS.map(L => s.ringOf[L]).join(''),
       s.palette.name,
       song.keyName, song.bpm, song.leadTimbre, song.rotK, song.shift, song.total, song.events.length,
       song.events.map(e =>
         e.beat.toFixed(3) + '|' + e.type + '|' +
         (e.midi != null ? e.midi : (e.midis ? e.midis.join('.') : '')) + '|' +
         (e.vel != null ? e.vel : 0).toFixed(3)).join(';'),
       Array.from(wt.real, v => v.toFixed(5)).join(','),
       Array.from(wt.imag, v => v.toFixed(5)).join(','),
       DSP.encodePatch(DSP.defaultPatch(s)),
       DSP.vowelsOf(s, null).join(''),
     ].join('#');
     return toHex(hashStr(parts)).slice(0, 32);
   }`, ctx);
   
   const fp = (w) => vm.runInContext(`__fp(${JSON.stringify(w)})`, ctx);
   const current = Object.fromEntries(INPUTS.map((w) => [w, fp(w)]));
   
   if (update || !fs.existsSync(SNAP)) {
     fs.writeFileSync(SNAP, JSON.stringify(current, null, 2) + '\n');
     console.log(`${update ? '↻ re-recorded' : '✓ recorded baseline'} → tests/golden.json`);
     for (const [k, v] of Object.entries(current)) console.log(`   ${k.padEnd(24)} ${v}`);
     console.log('   Commit this file.');
     process.exit(0);
   }
   
   const golden = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
   let bad = 0;
   for (const w of INPUTS) {
     const ok = golden[w] === current[w];
     if (!ok) bad++;
     console.log(`${ok ? '✓' : '✗'} ${w.padEnd(24)} ${current[w]}${ok ? '' : `  (expected ${golden[w]})`}`);
   }
   for (const w of Object.keys(golden)) if (!INPUTS.includes(w)) console.log(`· ${w} is in the snapshot but not in INPUTS`);
   
   if (bad) {
     console.error(`\n✗ ${bad} sigil(s) changed. This is a determinism regression.`);
     console.error('  If the change was deliberate, bump the hash prefix in 03-geometry.js,');
     console.error('  then run: npm run test:update');
     process.exit(1);
   }
   console.log(`\n✓ ${INPUTS.length} sigils unchanged.`);