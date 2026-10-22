/* ══════════════════════════════════════════════════════════════════════════
   GOLDEN CI RUNNER — no browser, no dependencies, runs in about a second.

   Usage:
     node tests/golden.mjs            compare against tests/golden.json (CI mode)
     node tests/golden.mjs --update   record a new baseline (after an INTENTIONAL change)

   It loads the pure source files into a sandboxed VM context, in the same order
   index.html uses, then runs computeAll() from golden-core.js.
   ══════════════════════════════════════════════════════════════════════════ */
   import { readFileSync, writeFileSync, existsSync } from 'node:fs';
   import { createContext, runInContext } from 'node:vm';
   import { dirname, join } from 'node:path';
   import { fileURLToPath } from 'node:url';
   
   const root = join(dirname(fileURLToPath(import.meta.url)), '..');
   const FILES = [
     'src/core/00-utils.js',
     'src/core/01-crypto.js',
     'src/core/02-reduction.js',
     'src/core/03-geometry.js',
     'src/core/04-theory.js',
     'src/core/05-composer.js',
     'src/core/05b-timbre.js',
     'src/core/05c-groove.js',
     'src/core/05d-motion.js',
     'src/dsp/sigil-dsp.js',
     'src/core/05e-master.js',
     'tests/golden-core.js',
   ];
   
   // The VM has no browser globals, so provide the few it needs.
   /* A minimal browser shim. `window` is self-referential so `window.X = X`
   publishes into the same global the next file reads from. */
const sandbox = { TextEncoder, btoa, atob, console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = createContext(sandbox);
   
   for (const f of FILES) {
     try {
       runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
     } catch (e) {
       console.error(`✗ failed to load ${f}: ${e.message}`);
       process.exit(1);
     }
   }
   
   const got = runInContext('computeAll()', ctx);
   const file = join(root, 'tests/golden.json');
   
   if (process.argv.includes('--update')) {
     writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
     console.log(`golden.json written (${Object.keys(got).length} snapshots). Commit it.`);
     process.exit(0);
   }
   
   if (!existsSync(file)) {
     console.error('No tests/golden.json yet. Record one with: node tests/golden.mjs --update');
     process.exit(1);
   }
   
   const want = JSON.parse(readFileSync(file, 'utf8'));
   let bad = 0;
   for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
     if (want[k] === got[k]) {
       console.log(`✓ ${k}`);
     } else {
       bad++;
       console.error(`✗ ${k}\n    want ${want[k]}\n    got  ${got[k]}`);
     }
   }
   
   if (bad) {
     console.error(`\n${bad} snapshot(s) changed. If the change is intentional, run --update and say why in the commit.`);
     process.exit(1);
   }
   console.log('\nAll golden snapshots match.');