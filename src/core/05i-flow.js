'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5i  FLOW — the passes of a rite are one piece, not one piece sung again · pure
   --------------------------------------------------------------------------
   A rite has an opening (the Invocation: a few bells and a drone), a body, and an ending (the
   Banishing: the line returns to silence, a last bell is struck into it, and the hall is left to
   ring). Sung through again, whole, each time round, it opens and it ends every pass: a fade to
   nothing, a bell, eight beats of air, and then the beginning again. Played live that is a loop; in
   a render it is a seam, and the seam is the end of the track, repeated.

   So the passes go round the BODY. The first begins at the start, with its opening. The last plays
   through to the end, with its ending, and rings out. Every pass between them is the body alone,
   and the end of the body (the crown, by its own ringing chord) runs straight into the start of
   it: the way a verse follows a chorus. Nothing fades, because nothing has finished; and the end,
   when it comes, is an end, because it has been held back for.

     opening  the first section, if it is the rite's opener (role 'intro': quiet, nothing yet
              happening): heard once, at the start
     ending   the rite's last section (the one it marks `final`): heard once, at the end. If it is
              the crown of a rite that ends at its height (struck), the crown is what is held back
     body     everything between

   A rite too short to have a body of two phrases is left as it is.

   This file only says where the body is ({ lo, hi }, in beats). What each pass then plays is the DSP
   core's (SigilDSP.passSpan), the same on the stage and in a render. PURE, no randomness: the song is
   never changed, only the way round it.
   ══════════════════════════════════════════════════════════════════════════ */

const Flow = (() => {
  'use strict';

  /** The body must hold at least this many beats (two phrases), or there is no flow to be had. */
  const MIN_BODY = 32;

  /** Whether the passes flow (the listener's: Prefs 'flow'). On, unless it has been turned off. */
  const enabled = () => Prefs.get('flow', true) !== false;
  const set = (on) => Prefs.set('flow', !!on);

  /** Is this section the rite's opener: quiet, and standing for the Invocation? */
  const opener = (s) => (s.role || s.id) === 'intro' && !(s.intensity > 0);

  /**
   * The body of a song: { lo, hi } in beats, or null if its passes should simply go round the whole.
   */
  function loop(song) {
    const S = song && song.sections;
    if (!S || S.length < 3) return null;
    const end = S[S.length - 1];
    if (!end.final) return null;
    const lo = opener(S[0]) ? S[0].end : 0, hi = end.start;
    return hi - lo >= MIN_BODY && hi < song.total ? { lo, hi } : null;
  }

  /** What a pass plays, in words, for a panel: "the opening, then the body" / "the body" / "the body, then the ending". */
  function describe(song, passes) {
    const L = loop(song);
    if (!L || passes < 2) return 'the whole rite';
    return `the opening once, the body ${passes - 1 > 1 ? 'round' : 'again'}, the ending once`;
  }

  return { enabled, set, loop, describe, MIN_BODY };
})();

if (typeof window !== 'undefined') window.Flow = Flow;
