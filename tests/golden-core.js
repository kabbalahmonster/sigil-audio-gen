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

/** Sound fingerprint: the whole cube (quantised to 1e-4) plus the derived patch. */
function soundFingerprint(reduced, variant) {
  const sig = buildSigil(reduced);
  const tb = SoundDesign.tables(sig, variant);
  const q = (x) => Math.round(x * 1e4);
  const parts = [JSON.stringify(SoundDesign.derive(sig.hash, variant))];
  for (const row of tb.grid) {
    for (const fr of row) parts.push(Array.from(fr.re, q).join(','), Array.from(fr.im, q).join(','));
  }
  const mid = SoundDesign.waveSamples(tb.grid[0][0], tb.grid[tb.grid.length >> 1][tb.grid[0].length - 1], 0.5, 64);
  parts.push(Array.from(mid, q).join(','));
  return toHex(hashStr(parts.join('#'))).slice(0, 32);
}

/**
 * Drum-part fingerprint (05c): every stroke the groove writes, and the polygons each section
 * shows. `take` 0 is the sigil's own groove. The composer's score is fingerprinted above and
 * is NOT affected by this file; these pin the part that replaces its drum bars.
 */
function grooveFingerprint(reduced, take) {
  const s = buildSigil(reduced);
  const song = Groove.apply(composeSong(s), s, { take });
  const parts = song.events.filter((e) => Groove.TYPES.has(e.type)).map((e) =>
    `${e.beat.toFixed(3)}|${e.type}|${e.tom ?? ''}${e.open ? 'o' : ''}|${e.vel.toFixed(3)}`);
  parts.push(song.sections.map((x) =>
    (x.rhythm ? x.rhythm.kick.map(Number).join('') + '/' + x.rhythm.hat.map(Number).join('') : '-')).join(','));
  return toHex(hashStr(parts.join(';'))).slice(0, 32);
}

/** The kit's dealt FX (05b drumFx): its own labelled stream, pinned like derive(). */
function drumFxFingerprint(reduced, variant) {
  return toHex(hashStr(JSON.stringify(SoundDesign.drumFx(buildSigil(reduced).hash, variant)))).slice(0, 32);
}

/**
 * Motion fingerprint (05d): who moves what (the deal), and the baked curves of the whole song,
 * quantised to 1e-4. `variant` 0 is the sigil's own deal.
 */
function motionFingerprint(reduced, variant) {
  const s = buildSigil(reduced), t = Motion.bake(composeSong(s), s, { variant });
  const parts = [JSON.stringify(t.lanes), t.len, Array.from(t.curves, (x) => Math.round(x * 1e4)).join(',')];
  return toHex(hashStr(parts.join('#'))).slice(0, 32);
}

/** Everything the CI compares, as a flat object of name → value. */
function computeAll() {
  const out = {};
  for (const w of GOLDEN_INPUTS) out[`music:${w}`] = fingerprint(w);
  for (const w of GOLDEN_INPUTS) {
    for (const v of GOLDEN_VARIANTS) out[`sound:${w}:dream${v}`] = soundFingerprint(w, v);
  }
  for (const w of GOLDEN_INPUTS) {
    for (const take of [0, 3]) out[`groove:${w}:take${take}`] = grooveFingerprint(w, take);
    for (const v of GOLDEN_VARIANTS) out[`drumfx:${w}:dream${v}`] = drumFxFingerprint(w, v);
    for (const v of GOLDEN_VARIANTS) out[`motion:${w}:deal${v}`] = motionFingerprint(w, v);
  }
  const patch = { wave: 2.5, voice: 'vox', grit: 0.4 };
  out['codec:encode'] = SoundDesign.encodePatch(patch, 3);
  out['codec:roundtrip'] = JSON.stringify(SoundDesign.decodePatch(SoundDesign.encodePatch(patch, 3)));
  return out;
}