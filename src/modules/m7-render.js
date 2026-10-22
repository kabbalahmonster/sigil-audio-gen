'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M7 · RENDER & EXPORT — parallel offline rendering + WAV / MP3 / AAC / Opus
   --------------------------------------------------------------------------
   PIPELINE
     plan cuts → render segments in parallel → stitch with crossfades
              → normalise → encode (worker or native) → download

   WHY THIS WORKS AT ALL: the Engine is deterministic (per-event noise is
   seeded from the event's musical identity, and the reverb IR and noise buffer
   are seeded and shared across contexts). Two independently rendered segments
   therefore agree sample-for-sample inside their overlap, so a 30 ms
   crossfade at a section boundary is inaudible.

   CONSTANTS: PRE_FX covers the reverb tail + delay memory that must be "warmed
   up" before a segment's real start; RING is how long a voice may keep sounding
   past its nominal end; MIN_SEG keeps seams away from loop-boundary tails.

   Soft dependency: M9 LiveLens (optional "apply the live lens").
   ══════════════════════════════════════════════════════════════════════════ */

const Render = (() => {
  'use strict';
  const { h } = UI;

  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  const PRE_FX = 6;   // s pre-roll: reverb IR (4.2 s) + delay feedback memory
  const RING = 6;     // s a voice may keep sounding after its nominal end
  const XF = 0.03;    // s crossfade at each seam
  const TAIL = 7;     // s decay after the final pass
  const MIN_SEG = 14; // s minimum segment length
  const CH = 5;       // s scheduling chunk inside each context (bounds live node count)

  const LAME_LOCAL = 'src/vendor/lame.min.js';
  const LAME_CDN = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';

  const FORMATS = {
    wav16: { label: 'WAV · 16-bit', ext: 'wav', sr: 44100 },
    wav24: { label: 'WAV · 24-bit', ext: 'wav', sr: 48000 },
    mp3:   { label: 'MP3',  ext: 'mp3', sr: 44100, kbps: [192, 256, 320], def: 256 },
    aac:   { label: 'AAC',  ext: 'aac', sr: 44100, kbps: [128, 192, 256], def: 192 },
    opus:  { label: 'Opus', ext: 'ogg', sr: 48000, kbps: [96, 128, 160, 192], def: 160 },
  };

  const S = { loops: 1, normalize: true, lens: true, tempo: true, fast: true,
              format: 'wav16', kbps: {}, ...Prefs.get('render', {}) };
  const save = () => Prefs.set('render', S);

  let available = ['wav16', 'wav24', 'mp3'];
  let busy = false, bar, status, btn, est, fmtRow, kbpsRow;

  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

  
    /* ═════════ 1. RENDERING ═════════ */





/**
 * Render song time [a, e) in its own OfflineAudioContext.
 * @returns {[Float32Array, Float32Array]} L and R, starting exactly at `a`
 */



/**
 * Render the whole export.
 * @param {object} [opts] { loops } · m14 (Evolve) renders one pass at a time.
 * @returns {{L: Float32Array, R: Float32Array, sr: number, segments: number}}
 */


/* ═════════ 1. RENDERING: the DSP core in parallel Web Workers ═════════
   Cut the song into K segments; each worker renders PRE_FX seconds of
   pre-roll (warming reverb/delay, chasing pads and drones) and returns only
   its own range; seams are 30 ms crossfades. Same core as the live engine. */
   const RENDER_WORKER = 'src/dsp/sigil-render.worker.js';
   const LISTEN = 0.14;   // the share of the progress bar given to listening, when a job has not been heard

   async function renderSong(song, sr, onProgress, opts) {
     opts = opts || {};
     const spb = S.tempo && app.engine && app.engine.song === song ? app.engine.spb : song.spb;
     const passes = opts.loops || S.loops;
     const lens = S.lens && typeof LiveLens !== 'undefined' && LiveLens.active();
     // opts.pass0: which pass of the rite this render begins at (m14 renders its passes one at a time),
     // so that the movers evolve across them exactly as they would in one long render or on the stage.
     const job = SigilPlan.renderJob(song, app.sigil, { sr, spb, passes, lens, levels: opts.levels, pass0: opts.pass0 });
     /* THE MASTER (m20). The file leaves through the same chain as the stage, by the same plan. If this
        job is the one the stage is playing, its plan is already worked out; if not (another tempo, the
        lens off, an evolved pass) it is listened to first, which is the first stretch of the bar.
        opts.stem: parts of one mix, which take the plan's trims and caps and leave before the chain. */
     let plan = null, listened = 0;
     const progress = onProgress;
     if (typeof Master !== 'undefined') {
       try {
         const m = await Master.prepare(job, song, { stem: !!opts.stem, onProgress: (f) => { listened = LISTEN; progress(f * LISTEN); } });
         if (m) { job.master = m.table; plan = m.plan; }
       } catch (e) {
         // The song could not be listened to. It is still rendered: unfinished, as the engine always left it.
         console.error('[render] the master could not listen; rendering without it', e);
       }
     }
     onProgress = (f) => progress(listened + f * (1 - listened));
     const music = passes * song.total * spb, total = music + TAIL;
     const lanes = S.fast ? clamp((navigator.hardwareConcurrency || 2) - 1, 1, 4) : 1;
     const K = Math.max(1, Math.min(lanes * 2, Math.floor(music / 20)));
     const q = (t) => (Math.round((t * sr) / 128) * 128) / sr;
     const cuts = [0];
     for (let k = 1; k < K; k++) cuts.push(q((music * k) / K));
     cuts.push(total);
     const segs = cuts.slice(0, -1).map((a, k) => ({
       id: k, keep: a, from: Math.max(0, a - PRE_FX), to: k < K - 1 ? cuts[k + 1] + XF : total, frac: 0,
     }));
     const weight = segs.reduce((s, g) => s + (g.to - g.from), 0);
     const report = () => onProgress(segs.reduce((s, g) => s + g.frac * (g.to - g.from), 0) / weight);
     const workers = [];
     let next = 0;
     try {
       await Promise.all(Array.from({ length: Math.min(lanes, K) }, () => new Promise((resolve, reject) => {
         const w = new Worker(RENDER_WORKER);
         workers.push(w);
         w.onerror = (e) => reject(new Error(e.message || 'render worker failed to load'));
         const take = () => {
           if (next >= segs.length) { resolve(); return; }
           const g = segs[next++];
           w.onmessage = (e) => {
             const d = e.data;
             if (d.type === 'progress') { g.frac = d.f; report(); }
             else if (d.type === 'done') { g.L = d.L; g.R = d.R; g.frac = 1; report(); take(); }
             else if (d.type === 'error') reject(new Error(d.msg));
           };
           w.postMessage({ type: 'render', job, from: g.from, to: g.to, keep: g.keep });
         };
         take();
       })));
     } finally {
       workers.forEach((w) => w.terminate());
     }
     onProgress(1);
     const N = Math.round(total * sr), xfN = Math.round(XF * sr);
     const L = new Float32Array(N), R = new Float32Array(N);
     for (const g of segs) {
       const pos = Math.round(g.keep * sr), n = Math.min(g.L.length, N - pos);
       for (let i = 0; i < n; i++) {
         if (g.id > 0 && i < xfN) {
           const w = i / xfN;
           L[pos + i] = L[pos + i] * (1 - w) + g.L[i] * w;
           R[pos + i] = R[pos + i] * (1 - w) + g.R[i] * w;
         } else { L[pos + i] = g.L[i]; R[pos + i] = g.R[i]; }
       }
       g.L = g.R = null;
     }
     return { L, R, sr, segments: segs.length, mastered: !!job.master && !opts.stem, plan };
   }

  /* ═════════ 2. MASTERING ═════════ */

  /**
   * Only for a render the master (m20) did NOT finish: one that was, already sits at the loudness
   * asked for under a true-peak ceiling, and is left exactly as it is.
   * Peak-normalise to −1 dBFS (lossless) or −1.5 dBFS (lossy, leaving headroom
   * for inter-sample peaks after decoding). When normalisation is OFF we still
   * apply a gain ≤ 1 to prevent clipping.
   */
  function normalize(L, R, fmt) {
    let peak = 0;
    for (let i = 0; i < L.length; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    if (!peak) return;

    const target = fmt.startsWith('wav') ? 0.891 : 0.841;
    const g = S.normalize ? target / peak : Math.min(1, target / peak);
    if (g !== 1) for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; }
  }

  /* ═════════ 3. ENCODERS ═════════ */

  /** PCM WAV, 16- or 24-bit, with TPDF dither. */
  function encodeWav(L, R, sr, bits) {
    const B = bits >> 3, n = L.length;
    const ab = new ArrayBuffer(44 + n * 2 * B), dv = new DataView(ab), u8 = new Uint8Array(ab);
    const str = (o, s) => { for (let k = 0; k < s.length; k++) u8[o + k] = s.charCodeAt(k); };

    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2 * B, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2 * B, true);
    dv.setUint16(32, 2 * B, true); dv.setUint16(34, bits, true);
    str(36, 'data'); dv.setUint32(40, n * 2 * B, true);

    const full = bits === 24 ? 8388608 : 32768, lsb = 1 / full;
    const q = (x) => {
      x += (Math.random() - Math.random()) * lsb;          // TPDF dither
      x = x < -1 ? -1 : x > 1 ? 1 : x;
      return Math.round(x < 0 ? x * full : x * (full - 1));
    };

    let o = 44;
    if (B === 2) {
      for (let i = 0; i < n; i++, o += 4) { dv.setInt16(o, q(L[i]), true); dv.setInt16(o + 2, q(R[i]), true); }
    } else {
      for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++, o += 3) {
        const v = q(c ? R[i] : L[i]);
        u8[o] = v & 255; u8[o + 1] = (v >> 8) & 255; u8[o + 2] = (v >> 16) & 255;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /* ── MP3 (LAME via lamejs). The SAME function runs in the worker and in the
        main-thread fallback: it is stringified into the worker source below. ── */
  function mp3Core(lame, left, right, sr, kbps, progress) {
    const enc = new lame.Mp3Encoder(2, sr, kbps);
    const N = left.length, BLOCK = 1152 * 64, parts = [];
    const l16 = new Int16Array(BLOCK), r16 = new Int16Array(BLOCK);
    const q = (x) => {
      x += (Math.random() - Math.random()) / 32768;
      x = x < -1 ? -1 : x > 1 ? 1 : x;
      return x < 0 ? x * 32768 : x * 32767;
    };

    for (let i = 0; i < N; i += BLOCK) {
      const n = Math.min(BLOCK, N - i);
      for (let k = 0; k < n; k++) { l16[k] = q(left[i + k]); r16[k] = q(right[i + k]); }
      const b = enc.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n));
      if (b.length) parts.push(b);
      progress(Math.min(1, (i + n) / N));
    }
    const end = enc.flush();
    if (end.length) parts.push(end);
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  /* No 'use strict' inside the worker source on purpose: lamejs relies on
     sloppy-mode globals. */
  const WORKER_SRC = `var mp3Core = ${mp3Core.toString()};
self.onmessage = function (e) {
  var d = e.data;
  try {
    if (d.cmd === 'load') { if (d.src) (0, eval)(d.src); else importScripts(d.url); self.postMessage({ loaded: typeof lamejs !== 'undefined' }); return; }
    if (d.cmd === 'encode') { var blob = mp3Core(lamejs, d.left, d.right, d.sr, d.kbps, function (p) { self.postMessage({ progress: p }); }); self.postMessage({ blob: blob }); }
  } catch (err) { self.postMessage({ error: String((err && err.message) || err) }); }
};`;

  /**
   * Fetch the vendored LAME source, if present.
   * Supports both the legacy inline `<script type="text/plain" id="lamejs-src">`
   * payload and a real file at src/vendor/lame.min.js.
   */
  let lameSrcPromise = null;
  function lameSource() {
    if (lameSrcPromise) return lameSrcPromise;
    const el = document.getElementById('lamejs-src');
    if (el && el.textContent.trim().length > 1000) return (lameSrcPromise = Promise.resolve(el.textContent));
    lameSrcPromise = fetch(LAME_LOCAL)
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => (t && t.length > 1000 ? t : null))
      .catch(() => null);
    return lameSrcPromise;
  }

  let mp3Worker = null;
  async function getMp3Worker() {
    if (mp3Worker) return mp3Worker;
    let w;
    try { w = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))); }
    catch { return null; }

    const src = await lameSource();
    const ok = await new Promise((res) => {
      const t = setTimeout(() => res(false), 15000);
      w.onmessage = (e) => { clearTimeout(t); res(!!e.data.loaded); };
      w.onerror = () => { clearTimeout(t); res(false); };
      w.postMessage(src ? { cmd: 'load', src } : { cmd: 'load', url: LAME_CDN });
    });

    if (!ok) { w.terminate(); return null; }
    return (mp3Worker = w);
  }

  async function loadLameMain() {
    if (window.lamejs) return window.lamejs;
    const src = await lameSource();
    if (src) { (0, eval)(src); return window.lamejs; }
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = LAME_CDN;
      s.onload = () => res(window.lamejs);
      s.onerror = () => rej(new Error('Could not load the MP3 encoder (offline?). Vendor src/vendor/lame.min.js to work offline.'));
      document.head.append(s);
    });
  }

  async function encodeMp3(L, R, sr, kbps, progress) {
    const w = await getMp3Worker();
    if (w) {
      return new Promise((res, rej) => {
        w.onmessage = (e) => {
          const d = e.data;
          if (d.progress != null) progress(d.progress);
          else if (d.blob) res(d.blob);
          else if (d.error) rej(new Error(d.error));
        };
        // Transferable copies — L/R may be views into an AudioBuffer.
        const left = L.slice(), right = R.slice();
        w.postMessage({ cmd: 'encode', left, right, sr, kbps }, [left.buffer, right.buffer]);
      });
    }
    const lame = await loadLameMain();   // fallback: main thread (blocks briefly)
    await frame();
    return mp3Core(lame, L, R, sr, kbps, progress);
  }

  /* ── WebCodecs (native AAC / Opus) ─────────────────────────────────── */

  async function webcodecs(codec, L, R, sr, kbps, progress) {
    const config = { codec, sampleRate: sr, numberOfChannels: 2, bitrate: kbps * 1000 };
    if (!(await AudioEncoder.isConfigSupported(config)).supported) {
      throw new Error(`${codec} encoding is not supported in this browser`);
    }

    const packets = [];
    let desc = null, failure = null;

    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        const d = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (d && !desc) {
          desc = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0))
               : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        packets.push({ data, samples: Math.round(((chunk.duration ?? 20000) * sr) / 1e6) });
      },
      error: (e) => (failure = e),
    });
    enc.configure(config);

    const F = 8192;
    for (let i = 0; i < L.length && !failure; i += F) {
      const n = Math.min(F, L.length - i), planar = new Float32Array(n * 2);
      planar.set(L.subarray(i, i + n), 0);
      planar.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n,
                                 numberOfChannels: 2, timestamp: Math.round((i / sr) * 1e6), data: planar });
      enc.encode(ad);
      ad.close();
      while (enc.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 0));   // backpressure
      if ((i / F) % 64 === 0) progress(i / L.length);
    }

    await enc.flush();
    enc.close();
    if (failure) throw failure;
    progress(1);
    return { packets, desc };
  }

  /** AAC: raw access units wrapped in 7-byte ADTS headers → a playable .aac stream. */
  function adts(len, sri, ch = 2) {
    const fl = len + 7;
    return new Uint8Array([
      0xff, 0xf1,
      (1 << 6) | (sri << 2) | (ch >> 2),
      ((ch & 3) << 6) | (fl >> 11),
      (fl >> 3) & 0xff,
      ((fl & 7) << 5) | 0x1f,
      0xfc,
    ]);
  }

  async function encodeAac(L, R, sr, kbps, progress) {
    const { packets } = await webcodecs('mp4a.40.2', L, R, sr, kbps, progress);
    const sri = { 96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7 }[sr];
    const parts = [];
    for (const p of packets) parts.push(adts(p.data.length, sri), p.data);
    return new Blob(parts, { type: 'audio/aac' });
  }

  /* ── Ogg container for Opus (RFC 7845) ─────────────────────────────── */

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      t[i] = r >>> 0;
    }
    return t;
  })();

  function oggPage(packets, granule, serial, seq, flags) {
    const lacing = [];
    for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }

    const body = packets.reduce((s, p) => s + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + body), dv = new DataView(page.buffer);

    page.set([0x4f, 0x67, 0x67, 0x53], 0);   // 'OggS'
    page[5] = flags;
    dv.setUint32(6, granule >>> 0, true);
    dv.setUint32(10, Math.floor(granule / 4294967296), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    page[26] = lacing.length;
    page.set(lacing, 27);

    let o = 27 + lacing.length;
    for (const p of packets) { page.set(p, o); o += p.length; }

    let c = 0;
    for (let i = 0; i < page.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ page[i]) & 0xff]) >>> 0;
    dv.setUint32(22, c, true);
    return page;
  }

  function muxOggOpus(packets, desc, inputFrames, title) {
    const serial = (Math.random() * 0xffffffff) >>> 0;

    let head = desc && desc.length >= 19 && String.fromCharCode(...desc.subarray(0, 8)) === 'OpusHead' ? desc : null;
    if (!head) {   // build OpusHead ourselves (libopus look-ahead = 312 samples at 48 kHz)
      head = new Uint8Array(19);
      const hv = new DataView(head.buffer);
      head.set(te.encode('OpusHead'));
      head[8] = 1; head[9] = 2;
      hv.setUint16(10, 312, true);
      hv.setUint32(12, 48000, true);
    }
    const preSkip = head[10] | (head[11] << 8);

    const vendor = te.encode('SIGIL');
    const comments = [te.encode('TITLE=' + title), te.encode('ENCODER=SIGIL (WebCodecs Opus)')];
    const tags = new Uint8Array(16 + vendor.length + comments.reduce((s, c) => s + 4 + c.length, 0));
    const tv = new DataView(tags.buffer);
    let o = 0;
    tags.set(te.encode('OpusTags'), 0); o = 8;
    tv.setUint32(o, vendor.length, true); o += 4; tags.set(vendor, o); o += vendor.length;
    tv.setUint32(o, comments.length, true); o += 4;
    for (const c of comments) { tv.setUint32(o, c.length, true); o += 4; tags.set(c, o); o += c.length; }

    const pages = [oggPage([head], 0, serial, 0, 0x02), oggPage([tags], 0, serial, 1, 0)];

    const finalGran = preSkip + inputFrames;   // end trimming: drops the encoder's padding
    let seq = 2, gran = preSkip, group = [], lacing = 0;
    const flush = (last) => { pages.push(oggPage(group, Math.min(gran, finalGran), serial, seq++, last ? 0x04 : 0)); group = []; lacing = 0; };

    packets.forEach((p, i) => {
      const segs = Math.floor(p.data.length / 255) + 1;
      if (group.length && (lacing + segs > 255 || group.length >= 50)) flush(false);   // ~1 s per page
      group.push(p.data); lacing += segs; gran += p.samples;
      if (i === packets.length - 1) flush(true);
    });

    return new Blob(pages, { type: 'audio/ogg' });
  }

  async function encodeOpus(L, R, sr, kbps, progress) {
    const { packets, desc } = await webcodecs('opus', L, R, sr, kbps, progress);
    return muxOggOpus(packets, desc, L.length, `SIGIL ${app.sigil ? app.sigil.fusionKey || app.sigil.reduced : ''}`);
  }

  function encode(fmt, r, kbps, progress) {
    switch (fmt) {
      case 'wav16': return encodeWav(r.L, r.R, r.sr, 16);
      case 'wav24': return encodeWav(r.L, r.R, r.sr, 24);
      case 'mp3':   return encodeMp3(r.L, r.R, r.sr, kbps, progress);
      case 'aac':   return encodeAac(r.L, r.R, r.sr, kbps, progress);
      case 'opus':  return encodeOpus(r.L, r.R, r.sr, kbps, progress);
    }
    throw new Error('Unknown format ' + fmt);
  }

  async function detectFormats() {
    const list = ['wav16', 'wav24', 'mp3'];
    if (window.AudioEncoder && window.AudioData) {
      const ok = async (c) => { try { return (await AudioEncoder.isConfigSupported(c)).supported; } catch { return false; } };
      if (await ok({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 192000 })) list.push('aac');
      if (await ok({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })) list.push('opus');
    }
    return list;
  }

  /* ═════════ 4. UI ═════════ */

  const setBar = (f) => (bar.firstChild.style.width = `${Math.round(clamp(f, 0, 1) * 100)}%`);
  const kbpsFor = (k) => S.kbps[k] || FORMATS[k].def;

  function rebuildKbps() {
    const f = FORMATS[S.format];
    kbpsRow.style.display = f.kbps ? '' : 'none';
    if (!f.kbps) return;
    kbpsRow.input.innerHTML = '';
    for (const k of f.kbps) kbpsRow.input.append(h('option', { value: k }, `${k} kbps`));
    kbpsRow.input.value = String(kbpsFor(S.format));
  }

  function refresh() {
    if (!btn) return;
    btn.disabled = busy || !app.song || !OAC;
    if (!OAC) { est.textContent = 'Offline rendering is not supported in this browser.'; return; }
    if (!app.song) { est.textContent = 'Cast a sigil to render it.'; return; }

    const spb = S.tempo && app.engine && app.engine.song === app.song ? app.engine.spb : app.song.spb;
    const d = S.loops * app.song.total * spb + TAIL, f = FORMATS[S.format];
    const bytes = f.kbps ? (kbpsFor(S.format) * 1000 * d) / 8 : d * f.sr * (S.format === 'wav24' ? 6 : 4);

    est.textContent = `≈ ${UI.fmt(d)} · ${(bytes / 1048576).toFixed(bytes < 1048576 * 10 ? 1 : 0)} MB · ` +
                      `${f.label}${f.kbps ? ' ' + kbpsFor(S.format) + ' kbps' : ''}`;
  }

  async function go() {
    if (busy || !app.song || !OAC) return;
    const song = app.song, f = FORMATS[S.format];

    busy = true; refresh();
    const wasLite = typeof Sound !== 'undefined' ? Sound.lite : false;
    if (typeof Sound !== 'undefined') Sound.setLite(true);   // thin the live voices while rendering
    btn.textContent = 'Rendering…';
    bar.classList.add('busy'); setBar(0);
    status.textContent = 'Performing the rite offline…';

    const t0 = performance.now();
    try {
      const r = await renderSong(song, f.sr, (p) => { bar.classList.remove('busy'); setBar(p * 0.8); });
      const t1 = performance.now();

      status.textContent = `Encoding ${f.label}…`;
      await frame();
      if (!r.mastered) normalize(r.L, r.R, S.format);
      // What the file measures, as a loudness meter would read it: said, not assumed.
      const heard = typeof Mastering !== 'undefined' ? Mastering.measure(r.L, r.R, r.sr) : null;

      const blob = await encode(S.format, r, kbpsFor(S.format), (p) => setBar(0.8 + p * 0.2));
      setBar(1);
      download(blob, `sigil-${UI.fileKey()}.${f.ext}`);

      status.textContent = `Rendered in ${secs(t1 - t0)} (${r.segments} segment${r.segments > 1 ? 's in parallel' : ''}) · ` +
                           `encoded in ${secs(performance.now() - t1)} · ${(blob.size / 1048576).toFixed(1)} MB` +
                           (heard && Number.isFinite(heard.lufs) ? ` · ${r.mastered ? 'mastered to' : 'measures'} ${heard.lufs.toFixed(1).replace('-', '−')} LUFS, ` +
                             `peak ${heard.truePeak.toFixed(1).replace('-', '−')} dBTP, range ${heard.range.toFixed(1)} LU` : '');
      UI.announce(`${f.label} file ready.`);
    } catch (e) {
      console.error('[render]', e);
      status.textContent = 'Export failed: ' + (e.message || e);
    } finally {
      if (typeof Sound !== 'undefined') Sound.setLite(wasLite);
      busy = false;
      btn.textContent = 'Render';
      bar.classList.remove('busy');
      refresh();
    }
  }

  UI.section({ id: 'render', title: 'Render & Export', order: 45, build(el) {
    btn = UI.button('Render', go);
    bar = h('div', { class: 'sgbar' }, h('i'));
    est = UI.note(''); status = UI.note('');

    fmtRow = UI.select({ label: 'Format', value: S.format,
      options: available.map((k) => [k, FORMATS[k].label]),
      onChange: (v) => { S.format = v; rebuildKbps(); save(); refresh(); } });

    kbpsRow = UI.select({ label: 'Bitrate', value: '', options: [],
      onChange: (v) => { S.kbps[S.format] = +v; save(); refresh(); } });

    el.append(
      UI.note('Renders the performance offline, faster than real time, including your mix, tempo and live lens, and every mover exactly as it moves on the stage. It leaves through the same master as the stage, by the same plan. Over more than one pass the rite evolves, by the amount set in Motion. Lossless WAV, or compressed MP3 / AAC / Opus.'),
      fmtRow, kbpsRow,
      UI.select({ label: 'Length', value: S.loops,
        options: [['1', 'One pass'], ['2', 'Two passes'], ['3', 'Three passes']],
        onChange: (v) => { S.loops = +v; save(); refresh(); } }),
      UI.check({ label: 'Normalise peaks (when the master is off)', checked: S.normalize,
        title: 'A render the master has finished already sits at its loudness, under a true-peak ceiling, and is not touched again',
        onChange: (v) => { S.normalize = v; save(); } }),
      UI.check({ label: 'Fast render (parallel, uses several CPU cores)', checked: S.fast, onChange: (v) => { S.fast = v; save(); } }),
      UI.check({ label: 'Use the current tempo', checked: S.tempo, onChange: (v) => { S.tempo = v; save(); refresh(); } }),
      UI.check({ label: 'Apply the live lens', checked: S.lens, onChange: (v) => { S.lens = v; save(); } }),
      est, h('div', { class: 'sgrow' }, btn), bar, status);

    rebuildKbps(); refresh();

    detectFormats().then((list) => {
      available = list;
      fmtRow.input.innerHTML = '';
      for (const k of list) fmtRow.input.append(h('option', { value: k }, FORMATS[k].label));
      if (!list.includes(S.format)) S.format = 'wav16';
      fmtRow.input.value = S.format;
      rebuildKbps(); refresh();
    });
  } });

  Hooks.on('song', refresh);
  Hooks.on('forget', () => setTimeout(refresh, 4000));

  return { renderSong, encode, encodeWav, muxOggOpus, normalize };   // renderSong → { L, R, sr, segments, mastered, plan }
})();

window.Render = Render; 