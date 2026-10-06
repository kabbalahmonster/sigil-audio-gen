'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   GOLDEN CORE — the fingerprints that define "this sigil sounds the same".
   Shared by the Node CI runner (tests/golden.mjs) and any browser page.
   Pure functions only. No DOM, no audio context.
   ══════════════════════════════════════════════════════════════════════════ */

const GOLDEN_INPUTS = ['KRSTVM', 'THWLBDNS', 'BCD', 'PLMNKJHGFDSTRVWXYZBC'];
const GOLDEN_VARIANTS = [0, 3];   // a base sound and one dream variant

/** Music fingerprint. Algorithm is unchanged from the browser spec, so old baselines remain valid. */
function fingerprint(reduced) {
  const s = buildSigil(reduced);
  const song = composeSong(s);
  const parts = [
    s.hex.slice(0, 16),
    s.wheel.join(''),
    s.nodes.map((n) => n.slot + ':' + n.ring).join(','),
    s.curves.map((c) => c.toFixed(4)).join(','),
    s.palette.name,
    song.keyName, song.bpm, song.leadTimbre, song.rotK, song.shift, song.total,
    song.events.length,
    song.events.map((e) =>
      `${e.beat.toFixed(3)}|${e.type}|${e.midi ?? (e.midis ? e.midis.join('.') : '')}|${(e.vel ?? 0).toFixed(3)}`
    ).join(';'),
  ].join('#');
  return toHex(hashStr(parts)).slice(0, 32);
}

/** Sound fingerprint: wavetable coefficients (quantised to 1e-4) plus the derived patch. */
function soundFingerprint(reduced, variant) {
  const sig = buildSigil(reduced);
  const tb = SoundDesign.tables(sig, variant);
  const q = (x) => Math.round(x * 1e4);
  const parts = [JSON.stringify(SoundDesign.derive(sig.hash, variant))];
  for (const fr of tb.frames) {
    parts.push(Array.from(fr.re, q).join(','), Array.from(fr.im, q).join(','));
  }
  const mid = SoundDesign.waveSamples(tb.frames[0], tb.frames[tb.frames.length - 1], 0.5, 64);
  parts.push(Array.from(mid, q).join(','));
  return toHex(hashStr(parts.join('#'))).slice(0, 32);
}

/** Everything the CI compares, as a flat object of name → value. */
function computeAll() {
  const out = {};
  for (const w of GOLDEN_INPUTS) out[`music:${w}`] = fingerprint(w);
  for (const w of GOLDEN_INPUTS) {
    for (const v of GOLDEN_VARIANTS) out[`sound:${w}:dream${v}`] = soundFingerprint(w, v);
  }
  const patch = { wave: 2.5, voice: 'vox', grit: 0.4 };
  out['codec:encode'] = SoundDesign.encodePatch(patch, 3);
  out['codec:roundtrip'] = JSON.stringify(SoundDesign.decodePatch(SoundDesign.encodePatch(patch, 3)));
  return out;
}