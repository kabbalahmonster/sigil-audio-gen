/* sigil-render.worker.js: renders, or listens to, one time range of a job with the same core.
     { type: 'render', job, from, to, keep }        → { type: 'done', L, R }
     { type: 'probe',  job, from, to, keep, mode }  → { type: 'heard', r }   the Probe's measurements (for a master plan) */
     importScripts('sigil-dsp.js');

     self.onmessage = (e) => {
       const d = e.data;
       if (!d || (d.type !== 'render' && d.type !== 'probe')) return;
       const progress = (f) => self.postMessage({ type: 'progress', f });
       try {
         if (d.type === 'probe') {
           const r = self.SigilDSP.probeRange(d.job, d.from, d.to, d.keep, d.mode, progress);
           self.postMessage({ type: 'heard', r }, Object.values(r).filter((x) => x instanceof Float32Array).map((x) => x.buffer));
           return;
         }
         const r = self.SigilDSP.renderRange(d.job, d.from, d.to, d.keep, progress);
         self.postMessage({ type: 'done', L: r.L, R: r.R }, [r.L.buffer, r.R.buffer]);
       } catch (err) {
         self.postMessage({ type: 'error', msg: String((err && err.stack) || err) });
       }
     };
     