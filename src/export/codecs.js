'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   EXPORT · CODECS — from a finished mix to the bytes of a file
   --------------------------------------------------------------------------
   Every encoder here takes the mix as two Float32Arrays (left, right) at the rate it
   was rendered at, and hands back a Blob. Nothing here decides what the mix should
   be (the master and 05h do); this only writes it down, and writes down with it what
   a file ought to say about itself: a title, the tempo, the key.

     wav    16 / 24-bit PCM, or 32-bit float; tags in a LIST/INFO chunk
     flac   16 / 24-bit, written here (fixed predictors, Rice-coded, the stereo pair
            decorrelated when that is shorter); tags as Vorbis comments; MD5 signed
     mp3    LAME (lamejs) in a worker; an ID3v2.3 tag in front
     aac    the browser's AAC encoder (WebCodecs), in an M4A (MP4) file, with tags
     opus   the browser's Opus encoder (WebCodecs), in an Ogg file (RFC 7845), with tags
     zip    several files as one (stored, not compressed: audio does not compress)

   All of it is deterministic: the dither is seeded (05h), and no encoder is given
   a clock or a random number. The same render is the same file.

   WHAT IS PURE (and tested in Node, tests/deliver.spec.mjs): wav, flac, zip, mp4, id3,
   the Ogg muxer, md5, crc. WHAT IS NOT (it needs a Worker or WebCodecs): mp3, aac, opus.
   ══════════════════════════════════════════════════════════════════════════ */

const Codecs = (() => {
  'use strict';

  const LAME_LOCAL = 'src/vendor/lame.min.js';
  const LAME_CDN = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';

  const utf8 = (s) => new TextEncoder().encode(String(s));
  const frame = () => new Promise((r) => setTimeout(r, 0));   // (not requestAnimationFrame: an export must carry on in a tab that is not in front)
  const cancelled = () => new Error('cancelled');

  /* ── Tags ────────────────────────────────────────────────────────────── */

  /**
   * What a file says about itself. `meta`: { title, artist, album, comment, bpm, software }: every field optional.
   * Empty ones are not written.
   */
  const clean = (m) => {
    m = m || {};
    const o = {};
    for (const k of ['title', 'artist', 'album', 'comment', 'software']) if (m[k]) o[k] = String(m[k]).slice(0, 500);
    if (m.bpm > 0) o.bpm = Math.round(m.bpm);
    return o;
  };

  /* ── CRCs and MD5 ────────────────────────────────────────────────────── */

  const CRC32 = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
    return t;
  })();
  function crc32(u8, crc = 0) {
    let c = ~crc >>> 0;
    for (let i = 0; i < u8.length; i++) c = CRC32[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  }
  const CRC8 = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; t[i] = c; }
    return t;
  })();
  const CRC16 = (() => {
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; t[i] = c; }
    return t;
  })();

  /** MD5 (RFC 1321), streamed: update() with any number of byte arrays, then digest(). FLAC signs the PCM with it. */
  function Md5() {
    const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
    const buf = new Uint8Array(64), w = new Int32Array(16);
    let fill = 0, total = 0;
    const block = (u8, o) => {
      for (let i = 0; i < 16; i++) w[i] = u8[o + 4 * i] | (u8[o + 4 * i + 1] << 8) | (u8[o + 4 * i + 2] << 16) | (u8[o + 4 * i + 3] << 24);
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        const sh = S[(i >> 4) * 4 + (i & 3)], x = (a + f + K[i] + w[g]) | 0;
        a = d; d = c; c = b; b = (b + ((x << sh) | (x >>> (32 - sh)))) | 0;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    };
    return {
      update(u8) {
        total += u8.length;
        let i = 0;
        if (fill) {
          while (fill < 64 && i < u8.length) buf[fill++] = u8[i++];
          if (fill < 64) return;
          block(buf, 0); fill = 0;
        }
        for (; i + 64 <= u8.length; i += 64) block(u8, i);
        while (i < u8.length) buf[fill++] = u8[i++];
      },
      digest() {
        const bits = total * 8, pad = new Uint8Array(((fill < 56 ? 56 : 120) - fill) + 8);
        pad[0] = 0x80;
        const dv = new DataView(pad.buffer);
        dv.setUint32(pad.length - 8, bits >>> 0, true); dv.setUint32(pad.length - 4, Math.floor(bits / 4294967296), true);
        const keep = total; this.update(pad); total = keep;
        const out = new Uint8Array(16), ov = new DataView(out.buffer);
        ov.setInt32(0, a0, true); ov.setInt32(4, b0, true); ov.setInt32(8, c0, true); ov.setInt32(12, d0, true);
        return out;
      },
    };
  }

  /* ═════════ WAV ═════════ */

  /**
   * PCM WAV. `ch`: the two channels, already quantised: Int32Array for 16 or 24 bits (see Deliver.quantise), Float32Array for 32 (IEEE float).
   * Tags go in a LIST/INFO chunk after the audio, which is where every reader that wants them looks.
   */
  function wav(ch, sr, bits, meta) {
    const n = ch[0].length, B = bits >> 3, float = bits === 32, data = n * 2 * B;
    const m = clean(meta), info = [];
    const tag = (id, text) => { if (text) { const b = utf8(text), len = b.length + 1; info.push([id, b, len + (len & 1)]); } };
    tag('INAM', m.title); tag('IART', m.artist); tag('IPRD', m.album); tag('ICMT', m.comment); tag('ISFT', m.software);
    const infoSize = info.length ? 12 + info.reduce((s, [, , l]) => s + 8 + l, 0) : 0;
    const head = 12 + (float ? 8 + 18 + 12 + 10 : 8 + 16) + 8;                // RIFF, fmt (+ fact, + a JUNK chunk to put the samples on a 4-byte boundary), data header
    const total = head + data + infoSize;
    if (total >= 4294967296) throw new Error('this render is too long for a WAV file (4 GB): choose FLAC, or fewer passes');
    const ab = new ArrayBuffer(total), dv = new DataView(ab), u8 = new Uint8Array(ab);
    const str = (o, s) => { for (let k = 0; k < s.length; k++) u8[o + k] = s.charCodeAt(k); };
    let o = 0;
    str(0, 'RIFF'); dv.setUint32(4, total - 8, true); str(8, 'WAVE'); o = 12;
    str(o, 'fmt '); dv.setUint32(o + 4, float ? 18 : 16, true); o += 8;
    dv.setUint16(o, float ? 3 : 1, true); dv.setUint16(o + 2, 2, true); dv.setUint32(o + 4, sr, true);
    dv.setUint32(o + 8, sr * 2 * B, true); dv.setUint16(o + 12, 2 * B, true); dv.setUint16(o + 14, bits, true);
    o += 16;
    if (float) { dv.setUint16(o, 0, true); o += 2; str(o, 'fact'); dv.setUint32(o + 4, 4, true); dv.setUint32(o + 8, n, true); o += 12; str(o, 'JUNK'); dv.setUint32(o + 4, 2, true); o += 10; }
    str(o, 'data'); dv.setUint32(o + 4, data, true); o += 8;
    const [L, R] = ch;
    // (Typed-array views, not a DataView: five minutes of audio is tens of millions of samples. Every browser runs little-endian.)
    if (float) { const f = new Float32Array(ab, o, n * 2); for (let i = 0, k = 0; i < n; i++) { f[k++] = L[i]; f[k++] = R[i]; } o += n * 8; }
    else if (B === 2) { const w = new Int16Array(ab, o, n * 2); for (let i = 0, k = 0; i < n; i++) { w[k++] = L[i]; w[k++] = R[i]; } o += n * 4; }
    else for (let i = 0; i < n; i++, o += 6) {
      const a = L[i], b = R[i];
      u8[o] = a & 255; u8[o + 1] = (a >> 8) & 255; u8[o + 2] = (a >> 16) & 255;
      u8[o + 3] = b & 255; u8[o + 4] = (b >> 8) & 255; u8[o + 5] = (b >> 16) & 255;
    }
    if (info.length) {
      str(o, 'LIST'); dv.setUint32(o + 4, infoSize - 8, true); str(o + 8, 'INFO'); o += 12;
      for (const [id, b, l] of info) { str(o, id); dv.setUint32(o + 4, l, true); u8.set(b, o + 8); o += 8 + l; }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /* ═════════ FLAC ═════════ */

  /** A bit writer over a fixed scratch buffer (zero-filled before each frame). */
  class Bits {
    constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; }
    reset() { this.buf.fill(0, 0, (this.pos + 7) >> 3); this.pos = 0; }
    /** v: an unsigned integer of n ≤ 32 bits. */
    put(v, n) {
      while (n > 0) {
        const free = 8 - (this.pos & 7), take = n < free ? n : free;
        this.buf[this.pos >> 3] |= ((v >>> (n - take)) & ((1 << take) - 1)) << (free - take);
        this.pos += take; n -= take;
      }
    }
    putS(v, n) { this.put(n >= 32 ? v >>> 0 : v & (n === 32 ? -1 : (1 << n) - 1), n); }
    unary(q) { this.pos += q; this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7); this.pos++; }   // q zeros, then a one
    align() { this.pos = (this.pos + 7) & ~7; }
    bytes() { return this.buf.subarray(0, this.pos >> 3); }
  }

  const FLAC_BLOCK = 4096, FLAC_MAXP = 6, FLAC_MAXO = 4;

  /**
   * What coding one channel block with a fixed predictor of order `o` would cost, in bits, and the partition order and
   * Rice parameters that cost it. Estimated from sums (as libFLAC does), then written exactly by `flacSub`.
   */
  function flacCost(x, n, bps, out) {
    let constant = true;
    for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
    if (constant) { out.bits = 8 + bps; out.type = 'const'; return; }
    let best = 8 + n * bps, bo = -1, bp = 0;                                           // verbatim
    const d = [x.subarray(0, n)];
    for (let o = 1; o <= FLAC_MAXO; o++) {                                            // successive differences
      const prev = d[o - 1], cur = new Int32Array(n);
      for (let i = o; i < n; i++) cur[i] = prev[i] - prev[i - 1];
      d.push(cur);
    }
    for (let o = 0; o <= FLAC_MAXO && o < n; o++) {
      const r = d[o];
      let maxP = 0;
      while (maxP < FLAC_MAXP && n % (1 << (maxP + 1)) === 0 && (n >> (maxP + 1)) > o) maxP++;
      const fine = 1 << maxP, w = n >> maxP, sums = new Float64Array(fine);
      for (let j = 0, i = 0; j < fine; j++) {
        let s = 0;
        for (let e = (j + 1) * w; i < e; i++) { if (i < o) continue; const v = r[i]; s += v < 0 ? -2 * v - 1 : 2 * v; }
        sums[j] = s;
      }
      for (let p = maxP, cur = sums; p >= 0; p--) {
        let bits = 8 + o * bps + 2 + 4;
        const parts = 1 << p, size = n >> p;
        for (let j = 0; j < parts; j++) {
          const c = size - (j === 0 ? o : 0), s = cur[j];
          let k = c > 0 && s > c ? Math.max(0, Math.floor(Math.log2(s / c))) : 0, kb = Infinity;
          for (let q = Math.max(0, k - 1); q <= k + 1 && q < 31; q++) { const b = c * (q + 1) + Math.floor(s / Math.pow(2, q)); if (b < kb) kb = b; }
          bits += 5 + kb;
        }
        if (bits < best) { best = bits; bo = o; bp = p; }
        if (p > 0) { const nx = new Float64Array(parts >> 1); for (let j = 0; j < nx.length; j++) nx[j] = cur[2 * j] + cur[2 * j + 1]; cur = nx; }
      }
    }
    out.bits = best; out.type = bo < 0 ? 'verbatim' : 'fixed'; out.order = bo; out.part = bp;
  }

  /** Write one subframe: `x` of `n` samples at `bps` bits, coded as `c` (from flacCost). */
  function flacSub(bw, x, n, bps, c) {
    if (c.type === 'const') { bw.put(0, 8); bw.putS(x[0], bps); return; }
    if (c.type === 'verbatim') { bw.put(1 << 1, 8); for (let i = 0; i < n; i++) bw.putS(x[i], bps); return; }
    const o = c.order;
    bw.put(0x10 | (o << 1), 8);                                                       // 0 · 001 ooo · 0 (no wasted bits)
    for (let i = 0; i < o; i++) bw.putS(x[i], bps);
    const r = new Int32Array(n);
    for (let i = o; i < n; i++) {
      r[i] = o === 0 ? x[i] : o === 1 ? x[i] - x[i - 1] : o === 2 ? x[i] - 2 * x[i - 1] + x[i - 2]
        : o === 3 ? x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3] : x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    bw.put(1, 2); bw.put(c.part, 4);                                                  // Rice, 5-bit parameters
    const parts = 1 << c.part, size = n >> c.part;
    for (let j = 0, i = o; j < parts; j++) {
      const end = (j + 1) * size, start = i;
      let s = 0;
      for (let q = start; q < end; q++) { const v = r[q]; s += v < 0 ? -2 * v - 1 : 2 * v; }
      const cnt = end - start;
      let k = cnt > 0 && s > cnt ? Math.max(0, Math.floor(Math.log2(s / cnt))) : 0, kb = Infinity, kk = k;
      for (let t = Math.max(0, k - 1); t <= k + 1 && t < 31; t++) { const b = cnt * (t + 1) + Math.floor(s / Math.pow(2, t)); if (b < kb) { kb = b; kk = t; } }
      bw.put(kk, 5);
      const mask = kk >= 32 ? -1 : (1 << kk) - 1;
      for (let q = start; q < end; q++) {
        const v = r[q], u = v < 0 ? -2 * v - 1 : 2 * v;
        bw.unary(u >>> kk);
        if (kk) bw.put(u & mask, kk);
      }
      i = end;
    }
  }

  /**
   * FLAC, 16 or 24 bits. `ch`: the two channels, already quantised (Int32Array). `meta`: see clean().
   * Frames are 4096 samples; per frame the stereo pair is coded as left/right, left/side, side/right or mid/side, whichever is
   * shortest. (No LPC: a fixed predictor costs a few percent against flac -8 and runs at a hundred times realtime in a browser.)
   */
  function* flacFrames(ch, sr, bits, meta) {
    const [L, R] = ch, N = L.length, m = clean(meta), chunks = [];
    const cap = FLAC_BLOCK * 2 * 4 + 256, bw = new Bits(cap);
    const md5 = Md5(), bytesPer = (bits + 7) >> 3, pcm = new Uint8Array(FLAC_BLOCK * 2 * bytesPer);
    const side = new Int32Array(FLAC_BLOCK), mid = new Int32Array(FLAC_BLOCK);
    const cl = {}, cr = {}, cm = {}, cs = {};
    let minF = Infinity, maxF = 0, frameNo = 0;

    for (let at = 0; at < N; at += FLAC_BLOCK, frameNo++) {
      const n = Math.min(FLAC_BLOCK, N - at), l = L.subarray(at, at + n), r = R.subarray(at, at + n);
      for (let i = 0; i < n; i++) { side[i] = l[i] - r[i]; mid[i] = (l[i] + r[i]) >> 1; }
      flacCost(l, n, bits, cl); flacCost(r, n, bits, cr); flacCost(mid, n, bits, cm); flacCost(side, n, bits + 1, cs);
      const opts = [[cl.bits + cr.bits, 1], [cl.bits + cs.bits, 8], [cs.bits + cr.bits, 9], [cm.bits + cs.bits, 10]];
      opts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const assign = opts[0][1] === 1 ? 1 : opts[0][1];
      // header
      bw.reset();
      bw.put(0x3ffe, 14); bw.put(0, 2);
      const bsCode = n === FLAC_BLOCK ? 12 : 7;
      bw.put(bsCode, 4); bw.put(0, 4);                                                // sample rate: from STREAMINFO
      bw.put(assign === 1 ? 1 : assign, 4);
      bw.put(bits === 16 ? 4 : bits === 24 ? 6 : 0, 3); bw.put(0, 1);
      // the frame number, UTF-8 coded
      if (frameNo < 0x80) bw.put(frameNo, 8);
      else if (frameNo < 0x800) { bw.put(0xc0 | (frameNo >> 6), 8); bw.put(0x80 | (frameNo & 63), 8); }
      else if (frameNo < 0x10000) { bw.put(0xe0 | (frameNo >> 12), 8); bw.put(0x80 | ((frameNo >> 6) & 63), 8); bw.put(0x80 | (frameNo & 63), 8); }
      else if (frameNo < 0x200000) { bw.put(0xf0 | (frameNo >> 18), 8); bw.put(0x80 | ((frameNo >> 12) & 63), 8); bw.put(0x80 | ((frameNo >> 6) & 63), 8); bw.put(0x80 | (frameNo & 63), 8); }
      else { bw.put(0xf8 | (frameNo >> 24), 8); bw.put(0x80 | ((frameNo >> 18) & 63), 8); bw.put(0x80 | ((frameNo >> 12) & 63), 8); bw.put(0x80 | ((frameNo >> 6) & 63), 8); bw.put(0x80 | (frameNo & 63), 8); }
      if (bsCode === 7) bw.put(n - 1, 16);
      bw.put(crc8(bw.buf, bw.pos >> 3), 8);
      // subframes
      if (assign === 1) { flacSub(bw, l, n, bits, cl); flacSub(bw, r, n, bits, cr); }
      else if (assign === 8) { flacSub(bw, l, n, bits, cl); flacSub(bw, side, n, bits + 1, cs); }
      else if (assign === 9) { flacSub(bw, side, n, bits + 1, cs); flacSub(bw, r, n, bits, cr); }
      else { flacSub(bw, mid, n, bits, cm); flacSub(bw, side, n, bits + 1, cs); }
      bw.align();
      const body = bw.bytes(), len = body.length;
      let c = 0;
      for (let i = 0; i < len; i++) c = ((c << 8) & 0xffff) ^ CRC16[((c >> 8) ^ body[i]) & 255];
      const out = new Uint8Array(len + 2);
      out.set(body); out[len] = c >> 8; out[len + 1] = c & 255;
      chunks.push(out);
      if (out.length < minF) minF = out.length;
      if (out.length > maxF) maxF = out.length;
      // MD5 of the PCM as the decoder will give it back
      let o = 0;
      for (let i = 0; i < n; i++) for (let k = 0; k < 2; k++) { const v = k ? r[i] : l[i]; for (let b = 0; b < bytesPer; b++) pcm[o++] = (v >> (8 * b)) & 255; }
      md5.update(pcm.subarray(0, o));
      if (frameNo % 32 === 0) yield at / N;                                            // about 30 ms of work between yields
    }

    // metadata
    const vendor = utf8('SIGIL'), comments = [];
    const put = (k, v) => { if (v) comments.push(utf8(`${k}=${v}`)); };
    put('TITLE', m.title); put('ARTIST', m.artist); put('ALBUM', m.album); put('COMMENT', m.comment); put('BPM', m.bpm); put('ENCODER', m.software);
    const vc = new Uint8Array(8 + vendor.length + comments.reduce((s, c2) => s + 4 + c2.length, 0)), vv = new DataView(vc.buffer);
    vv.setUint32(0, vendor.length, true); vc.set(vendor, 4);
    let o = 4 + vendor.length;
    vv.setUint32(o, comments.length, true); o += 4;
    for (const c2 of comments) { vv.setUint32(o, c2.length, true); vc.set(c2, o + 4); o += 4 + c2.length; }

    const si = new Uint8Array(34), sv = new DataView(si.buffer);
    sv.setUint16(0, FLAC_BLOCK); sv.setUint16(2, FLAC_BLOCK);
    si[4] = minF >> 16; si[5] = (minF >> 8) & 255; si[6] = minF & 255; si[7] = maxF >> 16; si[8] = (maxF >> 8) & 255; si[9] = maxF & 255;
    // 20 bits of rate · 3 of channels−1 · 5 of bits−1 · 36 of samples
    sv.setUint32(10, ((sr << 12) | (1 << 9) | ((bits - 1) << 4) | (Math.floor(N / 4294967296) & 15)) >>> 0);
    sv.setUint32(14, N >>> 0);
    si.set(md5.digest(), 18);
    const hdr = (type, last, len) => new Uint8Array([(last ? 0x80 : 0) | type, len >> 16, (len >> 8) & 255, len & 255]);
    const parts = [utf8('fLaC'), hdr(0, false, 34), si, hdr(4, true, vc.length), vc, ...chunks];
    return new Blob(parts, { type: 'audio/flac' });
  }
  /** All at once (tests, and anything that may block). */
  function flac(ch, sr, bits, meta) {
    const g = flacFrames(ch, sr, bits, meta);
    for (let r = g.next(); ; r = g.next()) if (r.done) return r.value;
  }
  /** In slices, giving the page back between them: a five-minute file is a few seconds of work, and the page must not stand still for it. */
  async function flacAsync(ch, sr, bits, meta, onProgress, stop) {
    const g = flacFrames(ch, sr, bits, meta);
    for (let r = g.next(); ; r = g.next()) {
      if (r.done) return r.value;
      if (onProgress) onProgress(r.value);
      if (stop && stop()) throw cancelled();
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  function crc8(buf, n) { let c = 0; for (let i = 0; i < n; i++) c = CRC8[c ^ buf[i]]; return c; }

  /* ═════════ ZIP ═════════ */

  /**
   * One file out of several. Stored, not deflated: audio does not shrink, and a stored archive can be written with nothing but
   * the bytes already in hand. `files`: [{ name, data: Blob | Uint8Array | string, date? }]. Names are UTF-8.
   */
  async function zip(files, onProgress) {
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (d) => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = (d) => ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (let f = 0; f < files.length; f++) {
      const file = files[f], name = utf8(file.name), d = file.date || now;
      const data = file.data instanceof Blob ? file.data : new Blob([typeof file.data === 'string' ? utf8(file.data) : file.data]);
      const bytes = new Uint8Array(await data.arrayBuffer()), crc = crc32(bytes), size = bytes.length;
      if (size >= 0xffffffff || offset >= 0xffffffff) throw new Error('a ZIP of this size is not supported (4 GB): render fewer files at a time');
      const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime(d), true); lv.setUint16(12, dosDate(d), true); lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      lh.set(name, 30);
      const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime(d), true); cv.setUint16(14, dosDate(d), true); cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true); ch.set(name, 46);
      central.push(ch);
      parts.push(lh, data);
      offset += lh.length + size;
      if (onProgress) onProgress((f + 1) / files.length);
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  /* ═════════ MP3 ═════════ */

  /** ID3v2.3: UTF-16 text frames for title, artist, album, comment, tempo and encoder. */
  function id3(meta) {
    const m = clean(meta), frames = [];
    const u16 = (s) => { const b = new Uint8Array(2 + s.length * 2 + 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) & 255; b[3 + 2 * i] = s.charCodeAt(i) >> 8; } return b; };
    const frame3 = (id, payload) => {
      const f = new Uint8Array(10 + payload.length), fv = new DataView(f.buffer);
      for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
      fv.setUint32(4, payload.length); f.set(payload, 10);
      frames.push(f);
    };
    const text = (id, s) => { if (s) { const t = u16(String(s)), p = new Uint8Array(1 + t.length); p[0] = 1; p.set(t, 1); frame3(id, p); } };
    text('TIT2', m.title); text('TPE1', m.artist); text('TALB', m.album); text('TBPM', m.bpm); text('TSSE', m.software);
    if (m.comment) {
      const d = u16(''), t = u16(m.comment), p = new Uint8Array(1 + 3 + d.length + t.length);
      p[0] = 1; p.set([101, 110, 103], 1); p.set(d, 4); p.set(t, 4 + d.length);
      frame3('COMM', p);
    }
    if (!frames.length) return new Uint8Array(0);
    const size = frames.reduce((s, f) => s + f.length, 0), out = new Uint8Array(10 + size);
    out.set([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
    let o = 10;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  }

  /* The same function runs in the worker and in the main-thread fallback: it is stringified into the worker source below. */
  function mp3Core(lame, left, right, sr, kbps, progress) {
    const enc = new lame.Mp3Encoder(2, sr, kbps);
    const N = left.length, BLOCK = 1152 * 64, parts = [];
    const l16 = new Int16Array(BLOCK), r16 = new Int16Array(BLOCK);
    const q = (x) => { x = x < -1 ? -1 : x > 1 ? 1 : x; return Math.round(x < 0 ? x * 32768 : x * 32767); };   // rounded, not dithered: a lossy codec would only encode the noise
    for (let i = 0; i < N; i += BLOCK) {
      const n = Math.min(BLOCK, N - i);
      for (let k = 0; k < n; k++) { l16[k] = q(left[i + k]); r16[k] = q(right[i + k]); }
      const b = enc.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n));
      if (b.length) parts.push(b);
      progress(Math.min(1, (i + n) / N));
    }
    const end = enc.flush();
    if (end.length) parts.push(end);
    return parts;
  }

  /* No 'use strict' inside the worker source on purpose: lamejs relies on sloppy-mode globals. */
  const WORKER_SRC = `var mp3Core = ${mp3Core.toString()};
self.onmessage = function (e) {
  var d = e.data;
  try {
    if (d.cmd === 'load') { if (d.src) (0, eval)(d.src); else importScripts(d.url); self.postMessage({ loaded: typeof lamejs !== 'undefined' }); return; }
    if (d.cmd === 'encode') { var parts = mp3Core(lamejs, d.left, d.right, d.sr, d.kbps, function (p) { self.postMessage({ progress: p }); }); self.postMessage({ parts: parts }); }
  } catch (err) { self.postMessage({ error: String((err && err.message) || err) }); }
};`;

  /** The vendored LAME source: an inline `<script type="text/plain" id="lamejs-src">`, or the file at src/vendor/lame.min.js. */
  let lameSrcPromise = null;
  function lameSource() {
    if (lameSrcPromise) return lameSrcPromise;
    const el = typeof document !== 'undefined' && document.getElementById('lamejs-src');
    if (el && el.textContent.trim().length > 1000) return (lameSrcPromise = Promise.resolve(el.textContent));
    lameSrcPromise = fetch(LAME_LOCAL).then((r) => (r.ok ? r.text() : null)).then((t) => (t && t.length > 1000 ? t : null)).catch(() => null);
    return lameSrcPromise;
  }

  let mp3Worker = null;
  async function getMp3Worker() {
    if (mp3Worker) return mp3Worker;
    let w;
    try { w = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))); } catch { return null; }
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

  async function mp3(L, R, sr, kbps, meta, progress, stop) {
    const w = await getMp3Worker();
    let parts;
    if (w) {
      parts = await new Promise((res, rej) => {
        w.onmessage = (e) => {
          const d = e.data;
          if (stop && stop()) { w.terminate(); if (mp3Worker === w) mp3Worker = null; rej(cancelled()); return; }
          if (d.progress != null) progress(d.progress);
          else if (d.parts) res(d.parts);
          else if (d.error) rej(new Error(d.error));
        };
        // Copies: L and R are the caller's, and a transfer would detach them.
        const left = L.slice(), right = R.slice();
        w.postMessage({ cmd: 'encode', left, right, sr, kbps }, [left.buffer, right.buffer]);
      });
    } else {
      const lame = await loadLameMain();   // fallback: main thread (blocks briefly)
      await frame();
      parts = mp3Core(lame, L, R, sr, kbps, progress);
    }
    return new Blob([id3(meta), ...parts], { type: 'audio/mpeg' });
  }

  /* ═════════ WebCodecs: AAC and Opus ═════════ */

  async function webcodecs(codec, L, R, sr, kbps, progress, stop) {
    const config = { codec, sampleRate: sr, numberOfChannels: 2, bitrate: kbps * 1000 };
    if (codec.startsWith('mp4a')) config.aac = { format: 'aac' };                        // raw access units + a description, not ADTS
    if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error(`${codec} encoding is not supported in this browser`);

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
      if (stop && stop()) { enc.close(); throw cancelled(); }
      const n = Math.min(F, L.length - i), planar = new Float32Array(n * 2);
      planar.set(L.subarray(i, i + n), 0);
      planar.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / sr) * 1e6), data: planar });
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

  /* ═════════ M4A (AAC in MP4) ═════════ */

  const SRI = { 96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7 };

  /** The two bytes that say how an AAC-LC stream is to be decoded, for when the encoder did not hand them over. */
  const audioSpecificConfig = (sr, ch = 2) => new Uint8Array([(2 << 3) | (SRI[sr] >> 1), ((SRI[sr] & 1) << 7) | (ch << 3)]);

  /**
   * AAC access units in an MP4 file (`.m4a`): the moov in front of the audio (a player can begin at once), the sample tables,
   * and tags in iTunes' own atoms. `asc`: the AudioSpecificConfig the encoder gave.
   */
  function mp4(packets, asc, sr, meta) {
    const m = clean(meta), N = packets.length;
    const u32 = (v) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
    const u16 = (v) => new Uint8Array([(v >> 8) & 255, v & 255]);
    const cat = (...a) => { const list = a.flat(), n = list.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of list) { o.set(x, p); p += x.length; } return o; };
    const zeros = (n) => new Uint8Array(n);
    const fourcc = (t) => new Uint8Array([0, 1, 2, 3].map((i) => t.charCodeAt(i)));           // one byte a letter: the © of a tag is 0xA9, not UTF-8
    const box = (type, ...body) => { const b = cat(...body); return cat(u32(8 + b.length), fourcc(type), b); };
    const MATRIX = cat(u32(0x00010000), zeros(12), u32(0x00010000), zeros(12), u32(0x40000000));
    const full = (type, ver, flags, ...body) => box(type, new Uint8Array([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...body);
    const n = packets.reduce((s, p) => s + (p.samples || 1024), 0);
    const sizes = cat(packets.map((p) => u32(p.data.length)));
    // stts: runs of equal duration
    const runs = [];
    for (const p of packets) { const d = p.samples || 1024; if (runs.length && runs[runs.length - 1][1] === d) runs[runs.length - 1][0]++; else runs.push([1, d]); }
    const esds = (() => {
      const dsi = cat(new Uint8Array([0x05, asc.length]), asc);
      const dcd = cat(new Uint8Array([0x04, 13 + dsi.length, 0x40, 0x15]), zeros(3), u32(0), u32(0), dsi);
      const sl = new Uint8Array([0x06, 1, 2]);
      const es = cat(new Uint8Array([0x03, 3 + dcd.length + sl.length, 0, 0, 0]), dcd, sl);
      return full('esds', 0, 0, es);
    })();
    const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(2), u16(16), u16(0), u16(0), u16(sr > 65535 ? 0 : sr), u16(0), esds);
    const text = (tag, s) => box(tag, box('data', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), utf8(s)));   // (tag: four letters)
    const ilst = [];
    if (m.title) ilst.push(text('\u00a9nam', m.title));
    if (m.artist) ilst.push(text('\u00a9ART', m.artist));
    if (m.album) ilst.push(text('\u00a9alb', m.album));
    if (m.comment) ilst.push(text('\u00a9cmt', m.comment));
    if (m.software) ilst.push(text('\u00a9too', m.software));
    if (m.bpm) ilst.push(box('tmpo', box('data', new Uint8Array([0, 0, 0, 21, 0, 0, 0, 0]), u16(m.bpm))));
    const udta = ilst.length ? box('udta', full('meta', 0, 0, full('hdlr', 0, 0, zeros(4), utf8('mdir'), utf8('appl'), zeros(9)), box('ilst', ...ilst))) : new Uint8Array(0);

    const moov = (offset) => box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(sr), u32(n), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2)),
      box('trak',
        full('tkhd', 0, 7, u32(0), u32(0), u32(1), u32(0), u32(n), zeros(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(sr), u32(n), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), utf8('soun'), zeros(12), utf8('SoundHandler'), zeros(1)),
          box('minf',
            full('smhd', 0, 0, u16(0), u16(0)),
            box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
            box('stbl',
              full('stsd', 0, 0, u32(1), mp4a),
              full('stts', 0, 0, u32(runs.length), cat(runs.map(([c, d]) => cat(u32(c), u32(d))))),
              full('stsc', 0, 0, u32(1), u32(1), u32(N), u32(1)),
              full('stsz', 0, 0, u32(0), u32(N), sizes),
              full('stco', 0, 0, u32(1), u32(offset)))))),
      udta);
    const ftyp = box('ftyp', utf8('M4A '), u32(0), utf8('M4A '), utf8('mp42'), utf8('isom'), zeros(0));
    const audio = packets.reduce((s, p) => s + p.data.length, 0);
    const head = ftyp.length + moov(0).length;                                              // moov's size does not depend on the offset
    const mdat = cat(u32(8 + audio), utf8('mdat'));
    return new Blob([ftyp, moov(head + mdat.length), mdat, ...packets.map((p) => p.data)], { type: 'audio/mp4' });
  }

  /**
   * Some encoders hand back ADTS-framed units even when asked for raw ones: the 7- or 9-byte header of each is taken off
   * (an MP4 holds access units, not a stream), and the AudioSpecificConfig is read out of the first.
   */
  function unadts(packets) {
    const d = packets[0] && packets[0].data;
    if (!d || d[0] !== 0xff || (d[1] & 0xf0) !== 0xf0) return null;
    const aot = ((d[2] >> 6) & 3) + 1, sfi = (d[2] >> 2) & 15, ch = ((d[2] & 1) << 2) | (d[3] >> 6);
    const asc = new Uint8Array([(aot << 3) | (sfi >> 1), ((sfi & 1) << 7) | (ch << 3)]);
    return { asc, packets: packets.map((p) => ({ data: p.data.subarray((p.data[1] & 1) ? 7 : 9), samples: p.samples })) };
  }

  async function aac(L, R, sr, kbps, meta, progress, stop) {
    let { packets, desc } = await webcodecs('mp4a.40.2', L, R, sr, kbps, progress, stop);
    let asc = desc && desc.length >= 2 ? desc : null;
    const framed = unadts(packets);
    if (framed) { packets = framed.packets; asc = asc || framed.asc; }
    return mp4(packets, asc || audioSpecificConfig(sr, 2), sr, meta);
  }

  /* ═════════ Ogg Opus (RFC 7845) ═════════ */

  const OGG_CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; }
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
    for (let i = 0; i < page.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ page[i]) & 0xff]) >>> 0;
    dv.setUint32(22, c, true);
    return page;
  }

  /** Opus packets in an Ogg stream. The serial number is a function of the audio's length: the same render, the same bytes. */
  function muxOggOpus(packets, desc, inputFrames, meta) {
    const m = clean(meta), serial = (0x5349474c ^ Math.imul(inputFrames | 0, 2654435761)) >>> 0;
    let head = desc && desc.length >= 19 && String.fromCharCode(...desc.subarray(0, 8)) === 'OpusHead' ? desc : null;
    if (!head) {   // build OpusHead ourselves (libopus look-ahead = 312 samples at 48 kHz)
      head = new Uint8Array(19);
      const hv = new DataView(head.buffer);
      head.set(utf8('OpusHead'));
      head[8] = 1; head[9] = 2;
      hv.setUint16(10, 312, true);
      hv.setUint32(12, 48000, true);
    }
    const preSkip = head[10] | (head[11] << 8);

    const vendor = utf8('SIGIL'), comments = [];
    const put = (k, v) => { if (v) comments.push(utf8(`${k}=${v}`)); };
    put('TITLE', m.title); put('ARTIST', m.artist); put('ALBUM', m.album); put('COMMENT', m.comment); put('BPM', m.bpm);
    comments.push(utf8('ENCODER=' + (m.software || 'SIGIL') + ' (WebCodecs Opus)'));
    const tags = new Uint8Array(16 + vendor.length + comments.reduce((s, c) => s + 4 + c.length, 0));
    const tv = new DataView(tags.buffer);
    let o = 0;
    tags.set(utf8('OpusTags'), 0); o = 8;
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

  async function opus(L, R, sr, kbps, meta, progress, stop) {
    const { packets, desc } = await webcodecs('opus', L, R, sr, kbps, progress, stop);
    return muxOggOpus(packets, desc, L.length, meta);
  }

  /* ═════════ Which can this browser write? ═════════ */

  /**
   * { wav, flac, mp3, aac, opus }: true, or a reason it cannot be written here. WAV and FLAC are written by this file and always can
   * be. MP3 needs a Worker (or the main thread) and the LAME source. AAC and Opus need WebCodecs' AudioEncoder to take them.
   */
  async function support() {
    const out = { wav: true, flac: true, mp3: true, aac: 'this browser has no AAC encoder', opus: 'this browser has no Opus encoder' };
    if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
      const ok = async (c) => { try { return (await AudioEncoder.isConfigSupported(c)).supported; } catch { return false; } };
      if (await ok({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 192000 })) out.aac = true;
      if (await ok({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })) out.opus = true;
    }
    return out;
  }

  /**
   * Write a finished mix as a file.
   *   r: a resolved setting (Deliver.resolve): { format, bits, rate, kbps, dither }
   *   mix: { L, R, sr }         meta: see clean()           progress(0…1)         stop(): true to leave
   * Returns a Blob.
   */
  async function encode(r, mix, meta, progress = () => {}, stop) {
    const { L, R, sr } = mix;
    switch (r.format) {
      case 'wav': case 'flac': {
        if (r.format === 'wav' && r.bits === 32) return wav([L, R], sr, 32, meta);
        const q = (x, c) => Deliver.quantise(x, r.bits, { dither: r.dither, seed: 0x5161 + c, rate: sr });
        const pcm = [q(L, 0), q(R, 1)];
        progress(0.15);
        await frame();
        if (stop && stop()) throw cancelled();
        const blob = r.format === 'wav' ? wav(pcm, sr, r.bits, meta) : await flacAsync(pcm, sr, r.bits, meta, (f) => progress(0.15 + f * 0.85), stop);
        progress(1);
        return blob;
      }
      case 'mp3': return mp3(L, R, sr, r.kbps, meta, progress, stop);
      case 'aac': return aac(L, R, sr, r.kbps, meta, progress, stop);
      case 'opus': return opus(L, R, sr, r.kbps, meta, progress, stop);
    }
    throw new Error('Unknown format ' + r.format);
  }

  return { encode, support, wav, flac, flacAsync, zip, mp4, unadts, id3, muxOggOpus, audioSpecificConfig, crc32, Md5, clean };
})();

if (typeof window !== 'undefined') window.Codecs = Codecs;
