'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5h  DELIVER — what happens to a finished mix on its way into a file · pure, no audio context
   --------------------------------------------------------------------------
   The master (05e, DSP §5d) finishes the SOUND: balance, tone, glue, loudness, a
   true-peak ceiling. This is the last stretch, the one a mastering engineer calls
   delivery: everything that decides whether the FILE is ready to be handed over.

     DESTINATIONS   where the file is going (a streaming upload, a PA, a club, a
                    broadcaster, an archive, a friend), as the loudness, the
                    ceiling, the format and the rate that place asks for.
     LOSSY MARGIN   a lossy codec rings around a peak and can overshoot it; a
                    file that is to be encoded is mastered a little further
                    under its ceiling, so that what a listener decodes is still
                    under it.
     THE END        a render ends with the ring-out of the hall. The dead air
                    after it is trimmed, and the last breath glides to zero, so a
                    file never ends on a step or on seconds of nothing.
     LANDING        the master was solved on a listening at 32 kHz; a file is
                    measured as a meter would measure it, at its own rate, and
                    brought the last fraction of a decibel to the loudness asked
                    for, never past the ceiling.
     THE BITS       16-bit files are dithered (flat, or shaped out of the ears'
                    most sensitive band), with a generator that is SEEDED: the
                    same render is the same file, byte for byte.
     THE REPORT     what the file measures (loudness, range, true peak), and how
                    it will fold down to mono on a system that sums the channels.

   Every function here takes and gives plain arrays and numbers. The encoders that
   turn the result into bytes are in src/export/codecs.js.
   ══════════════════════════════════════════════════════════════════════════ */

const Deliver = (() => {
  'use strict';
  const D = SigilDSP, M = Mastering;

  const clampN = (x, a, b) => (x < a ? a : x > b ? b : x);
  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

  /* ── Formats ─────────────────────────────────────────────────────────── */

  /**
   * What each format can be. `rates`: the sample rates it takes (the first of them the default);
   * `bits`: the bit depths; `kbps`: the bitrates (CBR) and the usual one.
   * Bit depth 32 is IEEE float: it cannot clip, and it is not dithered.
   */
  const FORMATS = {
    wav:  { label: 'WAV',  ext: 'wav',  mime: 'audio/wav',  lossless: true,  rates: [44100, 48000, 88200, 96000], bits: [16, 24, 32],
            note: 'Uncompressed. What distributors, DAWs and sound desks all take.' },
    flac: { label: 'FLAC', ext: 'flac', mime: 'audio/flac', lossless: true,  rates: [44100, 48000, 88200, 96000], bits: [16, 24],
            note: 'Lossless and about half the size of WAV. Tags travel with it.' },
    mp3:  { label: 'MP3',  ext: 'mp3',  mime: 'audio/mpeg', lossless: false, rates: [44100, 48000], kbps: [128, 192, 256, 320], def: 256,
            note: 'Plays on anything. 256 kbps and up is transparent for most listeners.' },
    aac:  { label: 'AAC',  ext: 'm4a',  mime: 'audio/mp4',  lossless: false, rates: [44100, 48000], kbps: [128, 192, 256], def: 192,
            note: 'In an M4A file, with tags. Better than MP3 at the same rate.' },
    opus: { label: 'Opus', ext: 'opus', mime: 'audio/ogg',  lossless: false, rates: [48000], kbps: [96, 128, 160, 192], def: 160,
            note: 'The best of the lossy codecs at low rates. Always 48 kHz.' },
  };
  const FORMAT_IDS = Object.keys(FORMATS);

  /** Lossy codecs overshoot a peak: a file to be encoded is mastered this far (dB) under its ceiling. */
  const LOSSY_MARGIN = 1;

  /**
   * Where a file is going. Each is a loudness (LUFS, integrated) and a true-peak ceiling (dBTP) that place
   * asks for or plays best at, and the format and rate that suit it. Choosing one sets all of them; any of
   * them can then be moved.
   */
  const DESTINATIONS = [
    { id: 'streaming', label: 'Streaming', target: -14, ceiling: -1,  format: 'wav',  bits: 24, rate: 44100,
      note: 'A distributor or a platform (Spotify, Apple Music, YouTube, Bandcamp). Lands at the level they play everything at, so nothing is turned down.' },
    { id: 'pa',        label: 'PA · Live', target: -12, ceiling: -1,  format: 'wav',  bits: 24, rate: 48000,
      note: 'Played through a sound system. Strong, with a full-scale peak held a decibel under the desk’s, and the low end folded to mono.' },
    { id: 'club',      label: 'Club · Loud', target: -9, ceiling: -1, format: 'wav',  bits: 24, rate: 48000,
      note: 'As loud as it goes without breaking: for a DJ set or a dancefloor. Costs dynamics.' },
    { id: 'broadcast', label: 'Broadcast', target: -23, ceiling: -1, format: 'wav',  bits: 24, rate: 48000,
      note: 'Radio, television and film (EBU R128: −23 LUFS). Quiet on purpose: the broadcaster will not turn it down.' },
    { id: 'archive',   label: 'Archive',   target: -18, ceiling: -3, format: 'flac', bits: 24, rate: 48000,
      note: 'For mastering elsewhere, or keeping: lots of headroom, lossless and tagged.' },
    { id: 'share',     label: 'Quick share', target: -14, ceiling: -1, format: 'mp3', kbps: 256, rate: 44100,
      note: 'Small enough to send to anyone. Streaming loudness, as an MP3.' },
  ];
  const destination = (id) => DESTINATIONS.find((d) => d.id === id) || null;

  /** LUFS worth a word, for the loudness control. */
  const LOUDNESS_WORDS = [[-23, 'Broadcast'], [-18, 'Headroom'], [-16, 'Dynamic'], [-14, 'Streaming'], [-12, 'Forward'], [-9, 'Loud']];
  function loudnessWord(t) {
    let best = null, d = 1e9;
    for (const [v, w] of LOUDNESS_WORDS) if (Math.abs(v - t) < d) { d = Math.abs(v - t); best = w; }
    return d <= 0.5 ? best : '';
  }

  /**
   * A render's settings, made sound: a known format, a bit depth and rate it takes, a bitrate from its list,
   * the ceiling it is actually mastered to (lossy: under by the margin), everything in range.
   */
  function resolve(s) {
    s = s || {};
    const format = FORMATS[s.format] ? s.format : 'wav', F = FORMATS[format];
    const bits = F.bits ? (F.bits.includes(s.bits) ? s.bits : F.bits.includes(24) ? 24 : F.bits[0]) : 0;
    const rate = F.rates.includes(s.rate) ? s.rate
      : F.rates.reduce((b, r) => (Math.abs(r - num(s.rate, 44100)) < Math.abs(b - num(s.rate, 44100)) ? r : b), F.rates[0]);
    const kbps = F.kbps ? (F.kbps.includes(s.kbps) ? s.kbps : F.def) : 0;
    const target = clampN(num(s.target, -14), -24, -8), ceiling = clampN(num(s.ceiling, -1), -6, -0.1);
    const effective = F.lossless ? ceiling : Math.max(-6, ceiling - LOSSY_MARGIN);
    return { format, bits, rate, kbps, target, ceiling, effective, lossless: F.lossless, ext: F.ext,
      dither: s.dither === 'off' || s.dither === 'shaped' ? s.dither : 'tpdf' };
  }

  /** Bytes a file of `seconds` will be, to within a tenth or so (FLAC at about 0.6 of WAV: music). */
  function estimate(seconds, r) {
    const F = FORMATS[r.format];
    if (F.kbps) return (r.kbps * 1000 * seconds) / 8;
    const wav = seconds * r.rate * 2 * (r.bits === 32 ? 4 : r.bits / 8);
    return r.format === 'flac' ? wav * 0.62 : wav;
  }

  /**
   * The memory a render of `seconds` wants at rate `sr`: the left and right of the mix as floats, the parts the
   * workers hand back while it is stitched, and the integers it is quantised to. Said in frames, because that is
   * what a browser runs out of.
   */
  const frames = (seconds, sr) => Math.ceil(seconds * sr);
  /** The most frames one render is allowed to hold (about 14 minutes at 48 kHz; 7 at 96). */
  const MAX_FRAMES = 40e6;

  /* ── The end of a render ─────────────────────────────────────────────── */

  /**
   * Where the sound ends: the last 20 ms that is louder than `floorDb` (dBFS, of the louder channel), and a
   * breath after it. Returns a frame count (never more than the file has). A silent file is not shortened.
   */
  function soundEnd(L, R, sr, floorDb = -72, breath = 0.35) {
    const w = Math.max(16, Math.round(sr * 0.02)), thr = Math.pow(10, floorDb / 10), n = L.length;
    for (let e = n; e > 0; e -= w) {
      const a = Math.max(0, e - w);
      let sl = 0, sr2 = 0;
      for (let i = a; i < e; i++) { sl += L[i] * L[i]; sr2 += R[i] * R[i]; }
      if (Math.max(sl, sr2) / (e - a) > thr) return Math.min(n, e + Math.round(breath * sr));
    }
    return n;
  }
  /** A raised-cosine fade over the last `seconds` of [0, n), in place. */
  function fadeOut(L, R, n, sr, seconds) {
    const m = Math.min(n, Math.max(2, Math.round(seconds * sr)));
    for (let i = 0; i < m; i++) {
      const g = 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / m), j = n - m + i;
      L[j] *= g; R[j] *= g;
    }
  }
  /**
   * How long the last breath should take to reach zero, by how loud the file still is where it ends (dB, the mean
   * square of its last 0.2 s). A tail that has rung down to nothing needs only a moment; one still sounding (a drone, a
   * bell left ringing) is glided out over seconds, as a hand would turn it down, not cut.
   */
  function fadeFor(L, R, n, sr) {
    const w = Math.min(n, Math.round(sr * 0.2));
    if (w < 1) return 0.01;
    let e = 0;
    for (let i = n - w; i < n; i++) e += L[i] * L[i] + R[i] * R[i];
    const db = 10 * Math.log10(e / (2 * w) + 1e-20);
    return db > -50 ? 4 : db > -62 ? 1.5 : 0.3;
  }
  /**
   * The end of a mix, made clean. Trims the dead air (`trim`), and glides the end to zero (`fade` seconds, or as long as
   * what is still sounding there asks: fadeFor). Returns the mix as views, and how many frames were dropped.
   * Stems are NOT trimmed by what they hold: they are cut to the length of the render (`frames`), so that a DAW lays them all
   * from zero and they end together.
   */
  function tidy(L, R, sr, o = {}) {
    const n = o.frames > 0 ? Math.min(o.frames, L.length) : o.trim === false ? L.length : soundEnd(L, R, sr, num(o.floor, -72));
    const out = { L: L.subarray(0, n), R: R.subarray(0, n), frames: n, dropped: L.length - n };
    if (n > 0 && o.fade !== 0) fadeOut(out.L, out.R, n, sr, o.fade > 0 ? o.fade : fadeFor(L, R, n, sr));
    return out;
  }

  /* ── Measurement ─────────────────────────────────────────────────────── */

  /**
   * What a file measures, as a loudness meter and a PA's engineer would read it:
   *   lufs range short momentary peak truePeak seconds   (05e measure)
   *   corr     the correlation of the two channels, −1 … 1 (a mono signal is 1)
   *   mono     how much quieter it gets if a system sums it to mono, in dB (0 is none; a little under −3 is a wide mix;
   *            much more means something in it cancels)
   *   dc       the offset of the signal, as a fraction of full scale
   */
  function analyse(L, R, sr) {
    const m = M.measure(L, R, sr);
    let ll = 0, rr = 0, lr = 0, sum = 0;
    for (let i = 0; i < L.length; i++) { const a = L[i], b = R[i]; ll += a * a; rr += b * b; lr += a * b; sum += a + b; }
    const den = Math.sqrt(ll * rr);
    const mono = ll + rr > 0 ? 10 * Math.log10(Math.max(1e-12, (ll + rr + 2 * lr) / (2 * (ll + rr)))) : 0;
    return Object.assign(m, { corr: den > 0 ? lr / den : 1, mono, dc: L.length ? sum / (2 * L.length) : 0 });
  }

  /** `x` dB as text, with a proper minus. */
  const db = (x, d = 1) => (Number.isFinite(x) ? `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}` : '—');

  /**
   * Says how a measured file did against what was asked: an array of { key, ok, text }.
   *   loudness  within 0.5 LU of the target, or short of it because the ceiling would not let it go further
   *   peak      at or under the ceiling
   *   mono      not losing more than 4 dB on a fold-down
   */
  function judge(m, ask) {
    const out = [], tgt = num(ask.target, NaN), ceil = num(ask.ceiling, NaN);
    if (Number.isFinite(tgt) && Number.isFinite(m.lufs)) {
      const d = m.lufs - tgt;
      out.push({ key: 'lufs', ok: Math.abs(d) <= 0.5,
        text: `${db(m.lufs)} LUFS`, hint: Math.abs(d) <= 0.5 ? `on the ${db(tgt, 0)} asked for` : `${d < 0 ? 'under' : 'over'} the ${db(tgt, 0)} asked for by ${Math.abs(d).toFixed(1)} LU` });
    } else if (Number.isFinite(m.lufs)) out.push({ key: 'lufs', ok: true, text: `${db(m.lufs)} LUFS`, hint: 'integrated loudness' });
    if (Number.isFinite(m.truePeak)) {
      out.push({ key: 'peak', ok: !Number.isFinite(ceil) || m.truePeak <= ceil + 0.05,
        text: `${db(m.truePeak)} dBTP`, hint: Number.isFinite(ceil) ? `true peak, under the ${db(ceil)} ceiling` : 'true peak' });
    }
    if (Number.isFinite(m.range)) out.push({ key: 'range', ok: true, text: `${m.range.toFixed(1)} LU`, hint: 'loudness range' });
    if (Number.isFinite(m.mono)) out.push({ key: 'mono', ok: m.mono > -4, text: `mono ${db(m.mono)} dB`, hint: m.mono > -4 ? 'folds to mono cleanly' : 'loses a lot when summed to mono' });
    return out;
  }

  /**
   * Bring a mix the last fraction of a decibel to the loudness asked for, with one linear gain, never past the ceiling.
   * The master's plan was worked out from a listening at 32 kHz; this is the file, measured at its own rate.
   * `maxUp` / `maxDown`: how far it is allowed to move (dB): a plan that missed by more than that has something else wrong,
   * and is told, not covered up. Returns { gain (dB), before, after, limited } and scales L and R in place.
   */
  function land(L, R, sr, o) {
    const before = analyse(L, R, sr), target = num(o.target, NaN), ceiling = num(o.ceiling, -1);
    const out = { gain: 0, before, after: before, limited: false };
    if (!Number.isFinite(before.lufs) || !Number.isFinite(target)) return out;
    let g = clampN(target - before.lufs, -num(o.maxDown, 3), num(o.maxUp, 1.5));
    const room = ceiling - before.truePeak;                    // the most it can be turned up without passing the ceiling
    if (g > room) { g = Math.min(g, room); out.limited = true; }
    if (Math.abs(g) < 0.02) return out;
    const k = Math.pow(10, g / 20);
    for (let i = 0; i < L.length; i++) { L[i] *= k; R[i] *= k; }
    // Gain is linear, so loudness and peaks move by exactly g (the gates of a loudness meter aside).
    out.gain = g;
    out.after = Object.assign({}, before, { lufs: before.lufs + g, short: before.short + g, momentary: before.momentary + g,
      peak: before.peak + g, truePeak: before.truePeak + g });
    return out;
  }

  /** Scale two channels together. */
  function gain(L, R, db) { const k = Math.pow(10, db / 20); for (let i = 0; i < L.length; i++) { L[i] *= k; R[i] *= k; } }

  /** The highest sample of either channel, as a fraction of full scale. */
  function peakOf(L, R) {
    let pk = 0;
    for (let i = 0; i < L.length; i++) { const a = L[i] < 0 ? -L[i] : L[i], b = R[i] < 0 ? -R[i] : R[i]; if (a > pk) pk = a; if (b > pk) pk = b; }
    return pk;
  }

  /* ── The bits ────────────────────────────────────────────────────────── */

  /** A seeded xorshift32 in [0, 1): so the same render is the same file. */
  function prng(seed) {
    let s = (seed | 0) || 0x9e3779b9;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }

  /**
   * Quantise one channel to `bits` (integers, −2^(bits−1) … 2^(bits−1)−1).
   *   off     plain rounding
   *   tpdf    triangular dither of ±1 LSB: the error is noise, never distortion (the usual choice)
   *   shaped  the same, with the error fed back through 1 − c·z⁻¹ + z⁻², which has its zeros at 3.2 kHz, where the ear is
   *           most sensitive, and puts the noise above about 10 kHz. A little more noise in all, and far less of it heard
   * Dither is for a word shorter than the signal: it is only done for 16 bits or fewer, and not at all for 24.
   */
  function quantise(x, bits, o = {}) {
    const n = x.length, full = Math.pow(2, bits - 1), hi = full - 1, out = new Int32Array(n);
    const mode = bits > 16 ? 'off' : o.dither || 'tpdf', rnd = prng(o.seed || 1);
    if (mode === 'off') {
      for (let i = 0; i < n; i++) { const v = Math.round(x[i] * full); out[i] = v > hi ? hi : v < -full ? -full : v; }
      return out;
    }
    // (Digital silence is left silent: dither is for a signal, and a file should not hiss where nothing is playing.)
    if (mode === 'tpdf') {
      for (let i = 0; i < n; i++) {
        if (x[i] === 0) continue;
        const v = Math.round(x[i] * full + rnd() - rnd());
        out[i] = v > hi ? hi : v < -full ? -full : v;
      }
      return out;
    }
    const c = 2 * Math.cos((2 * Math.PI * 3200) / num(o.rate, 44100));
    let e1 = 0, e2 = 0;
    for (let i = 0; i < n; i++) {
      if (x[i] === 0) { e1 = e2 = 0; continue; }
      const w = x[i] * full - c * e1 + e2;                       // the error of the last two words is fed back: y = x + e − c·e₁ + e₂
      let v = Math.round(w + rnd() - rnd());
      v = v > hi ? hi : v < -full ? -full : v;
      let e = v - w;
      e = e > 2 ? 2 : e < -2 ? -2 : e;                           // a clipped word must not be fed back
      e2 = e1; e1 = e;
      out[i] = v;
    }
    return out;
  }

  /* ── Naming ──────────────────────────────────────────────────────────── */

  /**
   * The name a file is given, without its extension: the sigil, the tempo and the key, in that order, so that a folder
   * of renders sorts by sigil and a DAW (or a DJ) knows the tempo and key without opening anything.
   *   sigil-KRSTVM-83bpm-Eb-Dorian
   */
  function fileBase(key, bpm, keyName) {
    const k = String(keyName || '').replace(/♭/g, 'b').replace(/♯/g, 's').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return ['sigil', String(key || 'sigil').replace(/[^A-Za-z0-9_+-]/g, ''), bpm > 0 ? `${Math.round(bpm)}bpm` : '', k].filter(Boolean).join('-');
  }

  /** Seconds as m:ss, or h:mm:ss. */
  function clock(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  /** Bytes as a size a person reads. */
  function size(b) { return b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1e9 ? `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB` : `${(b / 1073741824).toFixed(2)} GB`; }

  /**
   * How long the ring-out after the last pass is left to be: the hall's decay twice over, and five seconds for what is left
   * ringing (a drone, a bell). The same for every part of one render, so that stems end together.
   */
  const tailOf = (job) => clampN(num(job && job.reverb && job.reverb.rt60, 2.6) * 2 + 5, 8, 14);

  /** How evolved each pass is, 0…1, by the Evolution asked for (the core's own reading: see DSP autoTrend). */
  const evolved = (passes, evolve) => Array.from({ length: passes }, (_, p) => clampN(num(evolve, 0.5), 0, 1) * D.autoTrend(p));

  return {
    FORMATS, FORMAT_IDS, DESTINATIONS, LOSSY_MARGIN, MAX_FRAMES, LOUDNESS_WORDS,
    destination, loudnessWord, resolve, estimate, frames,
    soundEnd, fadeOut, fadeFor, tidy, analyse, judge, land, gain, peakOf,
    prng, quantise, fileBase, clock, size, tailOf, evolved, db,
  };
})();

if (typeof window !== 'undefined') window.Deliver = Deliver;
