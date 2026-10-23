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

/** The finish (05e): what the letters ask of the master chain. `variant` 0 is the sigil's own. */
function finishFingerprint(reduced, variant) {
  return toHex(hashStr(JSON.stringify(Mastering.character(buildSigil(reduced), variant)))).slice(0, 32);
}

/**
 * A styled song (05f), in the Ritual mood: every event of the score, with the style's kit (through
 * Groove's feel), bass, chords and feel, and the element's lean on the tempo. The hooks are the ones
 * m15 and m21 register in the app, put on for the length of one composition.
 */
function styleFingerprint(reduced, style, element) {
  const s = buildSigil(reduced);
  const off = [
    Hooks.on('compose', (cfg) => { Style.before(cfg); }, -20),
    Hooks.on('compose', (cfg, sigil) => { Style.compose(cfg, sigil, style, element); }, 20),
    Hooks.on('plan', (plan, cfg) => { Style.plan(plan, cfg); }, 20),
    Hooks.on('score', (events, c) => Groove.score(events, c, { ...((c.cfg && c.cfg.drums) || {}) })),
    Hooks.on('score', (events, c) => Style.parts(events, c), 10),
  ];
  let song;
  try { song = composeSong(s); } finally { off.forEach((f) => f()); }
  const rows = song.events.map((e) => [e.type, Math.round(e.beat * 960), e.midi ?? (e.midis || []).join('/'), Math.round((e.vel ?? 0) * 1000),
    Math.round((e.dur ?? 0) * 960), e.tom ?? '', e.open ? 1 : 0].join(':'));
  const set = (song.cfg.styleSound && song.cfg.styleSound.set) || {};
  return toHex(hashStr([song.bpm, song.sections.map((x) => `${x.intensity}${x.halfTime ? 'h' : ''}${x.arp || ''}`).join(','), set.voice, set.layer, rows.join(';')].join('#'))).slice(0, 32);
}

/**
 * A rite other than the Sevenfold (05g), in the Ritual mood with the groove's kit: its form (each
 * section's id, role, transform, length, level, layers and cadence) and every event of its score.
 * The hooks are the ones m22 and m15 register in the app, put on for the length of one composition.
 */
function riteSong(reduced, rite) {
  const s = buildSigil(reduced);
  const off = [
    Hooks.on('compose', (cfg) => { cfg.rite = rite; }, -30),
    Hooks.on('plan', (plan, cfg) => Rite.open(cfg), -30),
    Hooks.on('plan', (plan, cfg) => { Rite.seal(plan, cfg); }, 60),
    Hooks.on('score', (events, c) => Groove.score(events, c, { ...((c.cfg && c.cfg.drums) || {}) })),
  ];
  try { return composeSong(s); } finally { off.forEach((f) => f()); }
}
const riteForm = (song) => song.sections.map((x) => [x.id, x.role, `${x.T.k}${x.T.m < 0 ? 'm' : ''}${x.T.reverse ? 'r' : ''}`, x.phrases,
  `${x.intensity}${x.halfTime ? 'h' : ''}`, x.voice, x.harm ? 'H' : '', x.arp || '', x.octave ? 'O' : '', x.bass ? 'b' : '', x.drone ? 'd' : '',
  x.cadence || '', x.final ? `final${x.ends || ''}` : '', x.name, x.desc].join('|')).join(';');
function riteFingerprint(reduced, rite) {
  const song = riteSong(reduced, rite);
  const rows = song.events.map((e) => [e.type, Math.round(e.beat * 960), e.midi ?? (e.midis || []).join('/'), Math.round((e.vel ?? 0) * 1000),
    Math.round((e.dur ?? 0) * 960), e.tom ?? '', e.open ? 1 : 0].join(':'));
  return toHex(hashStr([song.total, riteForm(song), rows.join(';')].join('#'))).slice(0, 32);
}
/** The form of every rite, for one sigil: a rite that is changed, added out of order or removed shows here. */
function ritesFingerprint(reduced) {
  return toHex(hashStr(Object.keys(Rite.RITES).filter((id) => id !== Rite.DEFAULT).map((id) => `${id}=${riteForm(riteSong(reduced, id))}`).join('#'))).slice(0, 32);
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
    for (const v of GOLDEN_VARIANTS) out[`finish:${w}:deal${v}`] = finishFingerprint(w, v);
  }
  // One working per sigil is enough to pin the layer; tests/style.spec.mjs walks the rest.
  [['punk', 'fire'], ['trap', 'water'], ['edm', 'air'], ['jazz', 'earth']].forEach(([st, el], i) => {
    out[`style:${GOLDEN_INPUTS[i]}:${st}.${el}`] = styleFingerprint(GOLDEN_INPUTS[i], st, el);
  });
  // One rite per sigil, event for event, and the forms of all of them; tests/rite.spec.mjs walks the rest.
  ['iao', 'gates', 'posture', 'gnostic'].forEach((rite, i) => {
    out[`rite:${GOLDEN_INPUTS[i]}:${rite}`] = riteFingerprint(GOLDEN_INPUTS[i], rite);
  });
  out['rites:forms'] = ritesFingerprint(GOLDEN_INPUTS[0]);
  out['rites:own'] = GOLDEN_INPUTS.map((w) => Rite.own(buildSigil(w))).join(',');   // the rite each sigil draws for itself
  const patch = { wave: 2.5, voice: 'vox', grit: 0.4 };
  out['codec:encode'] = SoundDesign.encodePatch(patch, 3);
  out['codec:roundtrip'] = JSON.stringify(SoundDesign.decodePatch(SoundDesign.encodePatch(patch, 3)));
  return out;
}