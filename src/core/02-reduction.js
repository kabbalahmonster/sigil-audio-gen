'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §2  REDUCTION — the Spare / Morrison method
   --------------------------------------------------------------------------
   Uppercase, strip diacritics, strike vowels (A E I O U), strike repeats,
   keep the rest in order.

   Y is kept as a CONSONANT. This is not an arbitrary orthographic choice: it
   makes the alphabet split cleanly into 21 consonants, and 21 = 3 × 7, which
   §3 uses as three octaves (rings) of a seven-note scale (slots mod 7).

   The returned `chars` array preserves every original character along with its
   fate, so §8 can animate the striking-out faithfully, including spaces and
   punctuation.
   ══════════════════════════════════════════════════════════════════════════ */

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

/**
 * @typedef {'kept'|'vowel'|'repeat'|'space'|'mark'} Fate
 *   kept   — a consonant seen for the first time; it becomes a node
 *   vowel  — struck out (with a quill tick)
 *   repeat — a consonant already taken; struck out (with a quill tick)
 *   space  — whitespace; rendered as a non-breaking space, no strike line
 *   mark   — punctuation/digits/anything non-A–Z; struck silently
 *
 * @param   {string} text raw user input
 * @returns {{ chars: {ch: string, fate: Fate}[], reduced: string }}
 */
function reduceDesire(text) {
  // NFD + combining-mark removal folds "café" → "CAFE" so accents do not
  // silently become 'mark' and disappear from the rite.
  const clean = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

  const seen = new Set();
  const chars = [];
  let reduced = '';

  for (const ch of clean) {
    let fate;
    if (!/[A-Z]/.test(ch))       fate = /\s/.test(ch) ? 'space' : 'mark';
    else if (VOWELS.has(ch))     fate = 'vowel';
    else if (seen.has(ch))       fate = 'repeat';
    else { fate = 'kept'; seen.add(ch); reduced += ch; }
    chars.push({ ch, fate });
  }

  return { chars, reduced };
}