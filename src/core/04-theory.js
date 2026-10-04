'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §4  MUSIC THEORY PRIMITIVES
   --------------------------------------------------------------------------
   Pitch is stored as a scale DEGREE (an integer; 7 = one octave up) rather
   than a MIDI note. Diatonic transposition and inversion are then plain
   integer arithmetic — which is exactly what rotation and mirroring of the
   wheel produce. MIDI is only computed at the last possible moment, in the
   composer and in the Live Lens.
   ══════════════════════════════════════════════════════════════════════════ */

/** Semitone offsets from the tonic, one entry per scale degree. */
const MODES = {
  Aeolian:          [0, 2, 3, 5, 7, 8, 10],
  Dorian:           [0, 2, 3, 5, 7, 9, 10],
  Phrygian:         [0, 1, 3, 5, 7, 8, 10],
  Lydian:           [0, 2, 4, 6, 7, 9, 11],
  Mixolydian:       [0, 2, 4, 5, 7, 9, 10],
  Ionian:           [0, 2, 4, 5, 7, 9, 11],
  'Harmonic minor': [0, 2, 3, 5, 7, 8, 11],
};

const MODE_NAMES = Object.keys(MODES);

/**
 * Selection weights, parallel to MODE_NAMES.
 * Darker, modal colours are weighted up: they suit the occult mood without the
 * whole catalogue becoming one note.
 */
const MODE_WEIGHTS = [3, 3, 1.2, 1.6, 1.5, 1.4, 1.1];

/** Display spellings. Mixed sharps/flats chosen for readability, not theory. */
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** MIDI note number → frequency in Hz (A4 = 69 = 440 Hz). */
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Scale degree → MIDI note, relative to a tonic MIDI note.
 * Handles negative degrees and multi-octave spans correctly via floor/mod.
 */
const degToMidi = (deg, base, scale) => base + 12 * Math.floor(deg / 7) + scale[mod(deg, 7)];

/** Fold a MIDI note by octaves until it lies within [lo, hi]. */
const fold = (m, lo, hi) => { while (m < lo) m += 12; while (m > hi) m -= 12; return m; };

/**
 * Euclidean rhythm E(k, n): k onsets spread as evenly as possible over n steps.
 *
 * This is the rhythmic analogue of a regular polygon inscribed in a circle, so
 * the drums share the sigil's geometry — and §7 can literally draw them as
 * polygons at the hub.
 *
 * Ref: Toussaint, "The Euclidean Algorithm Generates Traditional Musical
 * Rhythms" (2005).
 *
 * @returns {boolean[]} length n
 */
const euclid = (k, n, rot = 0) =>
  Array.from({ length: n }, (_, i) => ((((i + rot) % n) * k) % n) < k);