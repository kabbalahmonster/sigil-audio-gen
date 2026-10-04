'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §1  CRYPTOGRAPHY & DETERMINISTIC RANDOMNESS
   --------------------------------------------------------------------------
   Why a hand-written SHA-256 instead of crypto.subtle?

     • crypto.subtle only exists in "secure contexts". Opening this file from
       disk (file://) can disable it in some browsers, and "self-contained"
       should mean it works anywhere.
     • It is synchronous, so composition stays a simple pure function rather
       than an async pipeline.

   SHA-256 gives an avalanche effect: changing one letter of the desire changes
   the whole sigil and song. That makes each sigil an individual, which is what
   "determined cryptographically" should mean.

   The round constants are DERIVED from prime roots at startup (as in the spec)
   rather than pasted in, and a self-test verifies the implementation against
   the canonical SHA-256("abc") vector.

   ⚠ DETERMINISM CONTRACT — see README. Never change the bytes fed to
   hashStr() for an existing algorithm version; bump the version prefix in
   §3 buildSigil instead.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── §1.1 SHA-256 (FIPS 180-4) ─────────────────────────────────────────── */
const SHA256 = (() => {
  const K = new Uint32Array(64);   // round constants
  const H0 = new Uint32Array(8);   // initial hash values

  /** First 32 bits of the fractional part of x. */
  const frac = (x) => ((x - Math.floor(x)) * 0x100000000) >>> 0;

  // K  = frac(cbrt(p)) for the first 64 primes
  // H0 = frac(sqrt(p)) for the first 8 primes
  for (let n = 2, found = 0; found < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (found < 8) H0[found] = frac(Math.sqrt(n));
    K[found] = frac(Math.cbrt(n));
    found++;
  }

  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  /**
   * @param   {Uint8Array} msg
   * @returns {Uint8Array} 32-byte digest
   */
  return function sha256(msg) {
    const len = msg.length;

    // Pad to a multiple of 64 bytes: message ‖ 0x80 ‖ 0x00* ‖ bitLength(64-bit BE)
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(msg);
    padded[len] = 0x80;                                             // the single '1' bit
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));  // bit length, high word
    dv.setUint32(padded.length - 4, (len << 3) >>> 0);              // bit length, low word

    const H = H0.slice();
    const W = new Uint32Array(64);

    for (let off = 0; off < padded.length; off += 64) {
      // Message schedule
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        W[i] = (W[i - 16] +
                (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
                W[i - 7] +
                (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
      }

      // Compression
      let a = H[0], b = H[1], c = H[2], d = H[3],
          e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
                    ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
                    ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }

      // Uint32Array assignment wraps mod 2^32 for free
      H[0] += a; H[1] += b; H[2] += c; H[3] += d;
      H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }

    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  };
})();

/** Lowercase hex of a byte array. */
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** UTF-8 string → 32-byte digest. */
const hashStr = (s) => SHA256(te.encode(s));

// Self-test. If this ever fires, every sigil in existence is wrong.
console.assert(
  toHex(hashStr('abc')) ===
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'SHA-256 self-test failed');

/* ── §1.2 PRNGs ────────────────────────────────────────────────────────── */

/**
 * sfc32 — small, fast, statistically strong counter-based PRNG.
 * Seeded from 128 bits of hash. Used for all structural decisions.
 */
function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * mulberry32 — tiny 32-bit-seeded PRNG used on the audio side, where we want
 * determinism from a single integer (per-event noise offsets, reverb IR,
 * the shared white-noise buffer).
 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── §1.3 Rng — a deterministic stream with musical conveniences ───────── */
class Rng {
  /** @param {Uint8Array} bytes at least 16 bytes of seed material */
  constructor(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.next = sfc32(dv.getUint32(0), dv.getUint32(4), dv.getUint32(8), dv.getUint32(12));
    for (let i = 0; i < 16; i++) this.next(); // warm up (discard initial bias)
  }

  float() { return this.next(); }
  range(a, b) { return a + (b - a) * this.next(); }
  /** Inclusive on both ends. */
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }

  /** Weighted pick. `weights` must be the same length as `items`. */
  weighted(items, weights) {
    let r = this.next() * weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  }

  /** Fisher–Yates on a copy. */
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

/**
 * Independent labelled sub-streams:
 *   stream(hash, 'geometry'), stream(hash, 'music'), stream(hash, 'palette')…
 *
 * DESIGN CHOICE, AND A LOAD-BEARING ONE: each domain draws from its own
 * hash-derived stream. Editing how the music uses randomness can never shift
 * the geometry, and vice versa. A given sigil therefore stays stable across
 * future versions of any one subsystem.
 *
 * Feature modules MUST use this (e.g. stream(hash, 'mood:ambient')) rather
 * than drawing from the composer's `R`.
 */
function stream(hash, label) {
  const lab = te.encode('::' + label);
  const buf = new Uint8Array(hash.length + lab.length);
  buf.set(hash);
  buf.set(lab, hash.length);
  return new Rng(SHA256(buf));
}