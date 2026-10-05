'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §3  SIGIL GEOMETRY
   --------------------------------------------------------------------------
   Based on the traditional "Rose Cross lamen" wheel method: letters sit around
   a circle and the word is drawn as a path between them, starting with a small
   circle and ending with a crossbar.

   Cryptographic extensions:
     - The order of the 21 consonants around the wheel is a Fisher-Yates
       shuffle seeded by SHA-256 of the reduced string, so every desire gets
       its own wheel.
     - Each letter sits on one of three concentric rings (its octave).
     - Each stroke is either a straight chord or a quadratic Bezier whose
       bulge is hash-derived.

   TRANSFORM MODEL - shared by the visuals AND the music:

       T = { k: rotation in slots, m: +1 or -1 mirror, reverse: bool }
       displayed slot = m * slot + k   (mod 21)

   Continuous display transforms use a separate shape, { phi, s }, where phi is
   radians and s is a continuous mirror factor, so a flip can animate like a
   coin turning over.

   DEPENDS ON: 00-utils.js (TAU, mod), 01-crypto.js (hashStr, stream, toHex)
   PROVIDES:   SLOTS, CONSONANTS, RINGS, ID_T, UNIT_F, PALETTES, buildSigil,
               polar, nodeXY, segmentPoints, tracePoints, polyLength
   ══════════════════════════════════════════════════════════════════════════ */

/** Number of positions on the wheel. 21 = 3 rings x 7 scale degrees. */
const SLOTS = 21;

/** The 21 consonants, Y included. Alphabetical here; the WHEEL order is shuffled. */
const CONSONANTS = [...'BCDFGHJKLMNPQRSTVWXYZ'];

/** Ring radii as fractions of the frame radius R. Index = octave register. */
const RINGS = [0.34, 0.6, 0.86];

/** Identity continuous display transform. */
const ID_T = { phi: 0, s: 1 };

/** Abstract unit frame, for measuring stroke lengths independent of screen size. */
const UNIT_F = { cx: 0, cy: 0, R: 1, base: 0 };

/**
 * Curated palettes: [background, line "ink", ember accent].
 *
 * APPEND ONLY. The palette is chosen by index from a hash-derived stream;
 * inserting or reordering entries re-skins every existing sigil. Modules that
 * want new colours should override via the 'palette' filter (see M5, M10).
 */
const PALETTES = [
  { name: 'Aurum',     bg: '#0a0807', line: [236, 206, 140], accent: [255, 146, 76] },
  { name: 'Cinnabar',  bg: '#0b0706', line: [242, 230, 214], accent: [228, 74, 50] },
  { name: 'Verdigris', bg: '#060f0d', line: [166, 230, 208], accent: [236, 214, 158] },
  { name: 'Nocturne',  bg: '#08070f', line: [206, 192, 255], accent: [120, 232, 255] },
  { name: 'Ossuary',   bg: '#0a0a09', line: [232, 226, 212], accent: [196, 38, 58] },
  { name: 'Saffron',   bg: '#0c0905', line: [255, 216, 154], accent: [255, 108, 64] },
];

/**
 * Build the complete geometric description of a sigil.
 *
 * The hash prefix 'SIGIL/v1::' is the ALGORITHM VERSION. If the geometry
 * algorithm ever changes in a way that alters output, bump it to v2 rather
 * than silently mutating every sigil ever cast.
 *
 * @param   {string} reduced non-repeating consonants, length >= 3
 * @returns {object} sigil
 */
function buildSigil(reduced) {
  const hash = hashStr('SIGIL/v1::' + reduced);
  const g = stream(hash, 'geometry');

  const wheel = g.shuffle(CONSONANTS);
  const slotOf = {};
  wheel.forEach((L, i) => { slotOf[L] = i; });

  const ringOf = {};
  CONSONANTS.forEach((L) => { ringOf[L] = g.int(0, 2); });

  // Collision repair. Y must not share a ring with a slot-adjacent letter: its
  // descender makes the label and node visually overlap the neighbour's. The
  // draw order above is unchanged, so determinism holds for every sigil that
  // had no collision. Only a colliding Y is moved, to the lowest ring index not
  // used by either neighbour - one always exists, since there are 3 rings and
  // at most 2 neighbours.
  const ys = slotOf['Y'];
  const nbRings = [wheel[mod(ys - 1, SLOTS)], wheel[mod(ys + 1, SLOTS)]].map((L) => ringOf[L]);
  if (nbRings.includes(ringOf['Y'])) {
    ringOf['Y'] = [0, 1, 2].find((r) => !nbRings.includes(r));
  }

  const baseAngle = g.float() * TAU;

  const nodes = [...reduced].map((L) => ({ letter: L, slot: slotOf[L], ring: ringOf[L] }));

  // One curve factor per STROKE (nodes.length - 1 of them):
  //   0            straight chord
  //   +/-0.28..62  control point pulled toward (+) or away from (-) the centre
  const curves = nodes.slice(1).map(() => {
    if (!g.chance(0.42)) return 0;
    return g.range(0.28, 0.62) * (g.chance(0.5) ? 1 : -1);
  });

  return {
    reduced: reduced,
    hash: hash,
    hex: toHex(hash),
    wheel: wheel,
    baseAngle: baseAngle,
    nodes: nodes,
    curves: curves,
    letterSet: new Set(reduced),
    palette: PALETTES[stream(hash, 'palette').int(0, PALETTES.length - 1)],
  };
}

/**
 * Polar -> screen coordinates.
 *
 * Mirror is applied first (x *= s), then rotation by base + phi. Positive
 * angles run CLOCKWISE on screen, matching increasing slot numbers. `s` is
 * continuous, so a mirror flip animates like a coin turning over.
 *
 * @param {number} slot fractional slot index (0..SLOTS)
 * @param {number} rf   radius as a fraction of F.R
 * @param {object} T    continuous display transform { phi, s }
 * @param {object} F    frame { cx, cy, R, base }
 * @returns {number[]}  [x, y]
 */
function polar(slot, rf, T, F) {
  const th = (TAU * slot) / SLOTS;
  const r = rf * F.R;
  const x = r * Math.sin(th) * T.s;
  const y = -r * Math.cos(th);
  const A = F.base + T.phi;
  const ca = Math.cos(A);
  const sa = Math.sin(A);
  return [F.cx + x * ca - y * sa, F.cy + x * sa + y * ca];
}

/** Screen position of a node (slot + ring). */
function nodeXY(nd, T, F) {
  return polar(nd.slot, RINGS[nd.ring], T, F);
}

/**
 * Sample one stroke (quadratic Bezier) from t = 0 to t = tEnd.
 * @returns {number[]} flat [x,y,x,y,...] with N+1 points
 */
function segmentPoints(a, b, k, T, F, tEnd, N) {
  if (tEnd === undefined) tEnd = 1;
  if (N === undefined) N = 24;

  const p0 = nodeXY(a, T, F);
  const p1 = nodeXY(b, T, F);
  const x0 = p0[0], y0 = p0[1], x1 = p1[0], y1 = p1[1];

  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  // Control point: the chord midpoint pulled toward/away from the frame centre.
  const qx = mx + (F.cx - mx) * k;
  const qy = my + (F.cy - my) * k;

  const pts = [];
  for (let j = 0; j <= N; j++) {
    const t = (tEnd * j) / N;
    const u = 1 - t;
    pts.push(u * u * x0 + 2 * u * t * qx + t * t * x1);
    pts.push(u * u * y0 + 2 * u * t * qy + t * t * y1);
  }
  return pts;
}

/**
 * The whole path drawn up to progress `prog`.
 * @param {number} prog 0 .. n-1; the fractional part is a position mid-stroke
 * @returns {number[]} flat point list (always at least one point)
 */
function tracePoints(seq, curves, T, F, prog) {
  const out = [];
  const whole = Math.floor(prog);
  const frac = prog - whole;

  for (let i = 0; i < seq.length - 1 && i <= whole; i++) {
    const tEnd = i < whole ? 1 : frac;
    if (tEnd <= 0) break;
    const pts = segmentPoints(seq[i], seq[i + 1], curves[i] || 0, T, F, tEnd);
    if (out.length) pts.splice(0, 2); // drop the duplicated join point
    for (let v = 0; v < pts.length; v++) out.push(pts[v]);
  }

  if (!out.length) {
    const p = nodeXY(seq[0], T, F);
    out.push(p[0], p[1]);
  }
  return out;
}

/** Total length of a flat polyline. Turns stroke length into note duration. */
function polyLength(pts) {
  let L = 0;
  for (let i = 2; i < pts.length; i += 2) {
    L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  }
  return L;
}