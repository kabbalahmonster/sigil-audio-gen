/* ══════════════════════════════════════════════════════════════════════════
   CALIBRATE VOICES — how loud each instrument is, in each part it can play, against the cube's own voice of that part.
   --------------------------------------------------------------------------
     node tools/calibrate-voices.mjs              measure, and print the table (changes nothing)
     node tools/calibrate-voices.mjs --write      and write it into src/core/05j-palette.js, between the GAINS markers
     node tools/calibrate-voices.mjs --verify     measure again WITH the written gains, and say how far each is from its reference
     --only=harp,koto     only these instruments (keys)        --words=3   how many songs to average (default 3)
     --from=out.txt       (with --write) write the gains from the output of an earlier run, instead of measuring again
     --refine             (with --from, of a --verify run) multiply the gains that are there by what that run found off by
     --mult=1.8           (with --refine) by this much more: the core's mix compresses a little, and a gain is heard for about half of what it is

   Method. A part is rendered as a song plays it (the same notes, the same beats), once in the cube's voice and once in
   the instrument's, with no hall; each is measured by the mastering module's K-weighted integrated loudness over the
   same twenty-odd seconds; the gain is the difference, in dB, averaged (by the median) over the songs. An instrument is
   thereby "as loud as the voice it replaces", and the bus levels and the listener's mixer keep meaning what they meant.
   Nothing else is changed: not a note, not a timbre. The gain is clamped to ±18 dB: an instrument needing more than that
   is a mistake in the instrument.
   ══════════════════════════════════════════════════════════════════════════ */
   import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
   import { readFileSync, writeFileSync } from 'node:fs';
   import { join } from 'node:path';
   import { scoreSandbox, loadPartJs, partJob, listen, WORDS, root } from './voice-lab.mjs';
   
   const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
   /** Where to listen: from a little before the part's thirtieth-percentile note, where it has got going. */
   const fromOf = (j) => {
     const b = []; for (let i = 0; i < j.count; i++) b.push(j.events[i * j.stride]);
     b.sort((x, y) => x - y);
     return Math.max(0, Math.floor(b[Math.floor(b.length * 0.3)] / 4) * 4) * (60 / j.bpm);
   };
   const NW = +args.words || 3, SECS = 18, FROM_BEAT = 16;
   
   async function measureTasks(tasks, verify) {
     const run = scoreSandbox();
     loadPartJs(run);
     run(`Palette.useMeasured(${verify ? 'true' : 'false'})`);
     const ref = new Map();
     const out = [];
     for (const [id, role] of tasks) {
       const db = [];
       for (const word of WORDS.slice(0, NW)) {
         const k = `${word}:${role}`;
         let r = ref.get(k);
         if (!r) {
           const j = partJob(run, word, role, 0);
           r = j.count ? listen(run, j, fromOf(j), SECS) : null;
           ref.set(k, r || { lufs: NaN });
           r = ref.get(k);
         }
         const j = partJob(run, word, role, id);
         if (!j.count) continue;
         const m = listen(run, j, fromOf(j), SECS);
         if (Number.isFinite(m.lufs) && Number.isFinite(r.lufs)) db.push({ d: r.lufs - m.lufs, peak: m.peak });
       }
       out.push([id, role, db]);
     }
     return out;
   }
   
   /**
    * Write gains into the palette's source, between its markers. What is there is kept, and what is given replaces it
    * (so that a run for some instruments changes only those). `lines` are "    'id:role': 0.5,"
    */
   function writeGains(lines) {
     const f = join(root, 'src/core/05j-palette.js'), src = readFileSync(f, 'utf8');
     const a = src.indexOf('/*GAINS*/'), b = src.indexOf('/*ENDGAINS*/');
     const table = new Map();
     for (const l of src.slice(a, b).split('\n').concat(lines)) { const m = /'(\d+:\w+)':\s*([\d.]+)/.exec(l); if (m) table.set(m[1], m[2]); }
     const keys = [...table.keys()].sort((x, y) => parseInt(x) - parseInt(y) || x.localeCompare(y));
     writeFileSync(f, src.slice(0, a) + `/*GAINS*/\n  const GAINS = {\n${keys.map((k) => `    '${k}': ${table.get(k)},`).join('\n')}\n  };\n  ` + src.slice(b));
     console.log(`written: ${lines.length} gains (${keys.length} in the table)`);
   }
   
   if (isMainThread && args.from) {
     const run = scoreSandbox();
     // what each pair is now multiplied by (its own gain, or the measured one already there)
     const now = JSON.parse(run(`JSON.stringify(Object.fromEntries([...Palette.INST.values()].flatMap((d) => d.roles.map((r) => [d.id + ':' + r, Palette.gainOf(d, r)]))))`));
     const base = JSON.parse(run(`JSON.stringify(Object.fromEntries([...Palette.INST.values()].map((d) => [d.id, d.gain])))`));
     const lines = [];
     for (const l of readFileSync(args.from, 'utf8').split('\n')) {
       const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(?:needs|off by)\s+(-?[\d.]+) dB/.exec(l);
       if (!m) continue;
       const db = Math.max(-18, Math.min(18, +m[4] * (args.refine ? +(args.mult || 1) : 1))), from = args.refine ? now[`${m[1]}:${m[3]}`] : base[m[1]];
       lines.push(`    '${m[1]}:${m[3]}': ${+(from * Math.pow(10, db / 20)).toFixed(3)},`);
     }
     writeGains(lines);
   } else if (isMainThread) {
     const { Palette } = await (async () => {
       const run = scoreSandbox();
       return { Palette: JSON.parse(run(`JSON.stringify([...Palette.INST.values()].filter((d) => d.engine !== 'cube').map((d) => ({ id: d.id, key: d.key, roles: d.roles, gain: d.gain })))`)) };
     })();
     const only = args.only ? new Set(String(args.only).split(',')) : null;
     const tasks = [];
     for (const d of Palette) if (!only || only.has(d.key)) for (const r of d.roles) tasks.push([d.id, r]);
     const nWorkers = Math.min(4, tasks.length), parts = Array.from({ length: nWorkers }, () => []);
     tasks.forEach((t, i) => parts[i % nWorkers].push(t));
     const t0 = Date.now();
     const results = (await Promise.all(parts.map((tk) => new Promise((res, rej) => {
       const w = new Worker(new URL(import.meta.url), { workerData: { tasks: tk, verify: !!args.verify } });
       w.on('message', res); w.on('error', rej);
     })))).flat();
     const byId = new Map(Palette.map((d) => [d.id, d]));
     const rows = [];
     for (const [id, role, db] of results) {
       const d = byId.get(id);
       if (!db.length) { rows.push({ id, key: d.key, role, db: NaN, n: 0 }); continue; }
       const s = db.map((x) => x.d).sort((a, b) => a - b), med = s[s.length >> 1];
       rows.push({ id, key: d.key, role, db: med, spread: s[s.length - 1] - s[0], n: s.length, peak: Math.max(...db.map((x) => x.peak)), gain: d.gain });
     }
     rows.sort((a, b) => a.id - b.id || a.role.localeCompare(b.role));
     console.log(`${rows.length} (instrument, part) pairs in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
     for (const r of rows) console.log(`${String(r.id).padStart(4)} ${r.key.padEnd(16)} ${r.role.padEnd(7)} ${Number.isFinite(r.db) ? (args.verify ? 'off by ' : 'needs ') + r.db.toFixed(1).padStart(6) + ' dB' : '  (no notes)'}${r.spread > 4 ? `   ⚠ songs differ by ${r.spread.toFixed(1)} dB` : ''}`);
     if (args.write && !args.verify) {
       writeGains(rows.filter((r) => Number.isFinite(r.db)).map((r) => {
         const db = Math.max(-18, Math.min(18, r.db));
         return `    '${r.id}:${r.role}': ${+(r.gain * Math.pow(10, db / 20)).toFixed(3)},`;
       }));
     }
   } else {
     parentPort.postMessage(await measureTasks(workerData.tasks, workerData.verify));
   }
   