/* sigil-render.worker.js: renders one time range of a job with the same core. */
importScripts('sigil-dsp.js');

self.onmessage = (e) => {
  const d = e.data;
  if (!d || d.type !== 'render') return;
  try {
    const r = self.SigilDSP.renderRange(d.job, d.from, d.to, d.keep, (f) => self.postMessage({ type: 'progress', f }));
    self.postMessage({ type: 'done', L: r.L, R: r.R }, [r.L.buffer, r.R.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', msg: String((err && err.stack) || err) });
  }
};