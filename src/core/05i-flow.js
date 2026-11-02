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

   THE TURNAROUND. A pass that is followed by another does not END at the body's end, it turns: the kit's last bar
   is a fill INTO the body's start (the figures of 05k), and if the body comes round to something bigger, a crash lands on it.
   Those strokes are in the score as events that are played only on a pass that turns (`when: 'wrap'`, or, for the landing,
   'after'), and the strokes the bar had for the ending are played only where there IS an ending ('end'): the compiler
   marks the rows, and the core plays the right ones on each pass. The song itself is not changed.

   This file only says where the body is ({ lo, hi }, in beats), and what turns it. What each pass then plays is the DSP
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

  /* ── the turnaround ──────────────────────────────────────────────────── */

  const SERIAL = new WeakMap();

  /**
   * The events a song's body needs to turn round: { add: the fill into the body's start and the crash it lands on, end: the
   * kit's own strokes in the bar it replaces } or null where there is no kit to fill (or the listener has turned Fills off).
   */
  function turn(song, sigil, L) {
    const cfg = song && song.cfg, gr = cfg && cfg.groove;
    if (!L || !gr || typeof Fills === 'undefined' || typeof Groove === 'undefined' || !(gr.fills >= 0.12)) return null;
    const S = song.sections, a = S.find((x) => x.end === L.hi), b = S.find((x) => x.start === L.lo);
    if (!a || !b) return null;
    const I = a.intensity | 0;
    if (I <= 0) return null;
    const kind = !(b.intensity > 0) ? 'dissolve' : b.intensity > I ? 'rise' : b.intensity < I ? 'fall' : 'turn';
    const G = Groove, st = typeof Style !== 'undefined' && cfg.feel ? Style.STYLES[cfg.feel.id] : null;
    const F = st ? Style.FILLS[st.fill || 'rock'] : null;
    const D = G.dna(sigil, song.P, gr.take | 0), seed = (D.seed ^ (cfg.feel ? cfg.feel.seed : 0)) >>> 0;
    const t0 = L.hi - 4, ab = Math.round(t0 / 4) + 100000;          // (its own noise: not the bar's own)
    const N = (step, ch) => G.noise(seed, ab, step, ch);
    let W = G.fillWidth(I, kind, true, gr.fills, N(0, G.CH.turn));
    if (F) W = Math.min(W, F.max);
    if (!W) return null;
    const from = 16 - W, bpm = song.bpm || 90;
    const ctx = { W, from, I, kind, sectionEnd: true, f: gr.fills, fast: bpm * ((st && st.felt) || 1) > (st ? 150 : 112), half: !!a.halfTime, N,
      idiom: (st && st.fill) || 'rock', style: st ? st.id : null, map: F && F.map, soft: F && F.soft, noRecite: true };
    const fig = Fills.choose(ctx);
    const hits = Fills.write(fig, ctx);
    const sw = (song.P && song.P.swing || 0) * 0.25, flam = (0.03 * bpm) / 60;
    const add = [];
    for (const h of hits) {
      let t = t0 + h.s * 0.25;
      if (st && cfg.feel) t = t0 + Style.warp(h.s * 0.25, cfg.feel.swing, cfg.feel.shuffle);
      else if (sw && (Math.floor(h.s) & 1)) t += sw;
      if (h.grace) t -= flam;
      const e = { beat: t, type: h.type, vel: h.vel, fill: true, when: 'wrap' };
      if (h.tom != null) e.tom = h.tom;
      if (h.pi != null) e.pi = h.pi;
      if (h.type === 'hat') { e.open = !!h.open; e.pan = h.pan || 0; }
      if (h.grace) e.grace = true;
      add.push(e);
    }
    if (kind === 'rise' && b.intensity >= 3) add.push({ beat: t0, type: 'swell', dur: 4, vel: 0.8, when: 'wrap' });
    // where it lands: a crash, unless the body's own start has one
    if (b.intensity >= 2 && kind !== 'fall' && !song.events.some((e) => e.type === 'crash' && e.beat > L.lo - 0.1 && e.beat < L.lo + 0.5)) {
      add.push({ beat: L.lo, type: 'crash', vel: 0.66, when: 'after' });
    }
    return { add, from: t0 + from * 0.25, to: L.hi, figure: fig, width: W, kind };
  }

  /**
   * The song as its passes play it: the same, with the turnaround in it. A copy (the song's own events are not touched), or the song
   * itself where there is nothing to turn. The copy is kept, by its events, while they stand.
   */
  function turnSong(song, sigil, L) {
    if (!L) return song;
    const hit = SERIAL.get(song.events);
    if (hit && hit.L.lo === L.lo && hit.L.hi === L.hi && hit.sigil === sigil && hit.cfg === song.cfg.groove) return hit.out;
    const T = turn(song, sigil, L);
    let out = song;
    if (T) {
      const kit = typeof Groove !== 'undefined' ? Groove.TYPES : new Set();
      const events = song.events.map((e) => (kit.has(e.type) && e.type !== 'swell' && e.beat >= T.from - 1e-6 && e.beat < T.to ? { ...e, when: 'end' } : e)).concat(T.add);
      events.sort((x, y) => x.beat - y.beat);
      out = Object.assign(Object.create(Object.getPrototypeOf(song)), song, { events, turned: { figure: T.figure, kind: T.kind, width: T.width } });
    }
    SERIAL.set(song.events, { L, sigil, cfg: song.cfg.groove, out });
    return out;
  }

  return { enabled, set, loop, describe, turn, turnSong, MIN_BODY };
})();

if (typeof window !== 'undefined') window.Flow = Flow;
