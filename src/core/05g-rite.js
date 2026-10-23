'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5g  RITES — the forms a sigil can be performed in
   --------------------------------------------------------------------------
   The composer (§5.1) has one form: the Sevenfold rite, invocation to
   banishing. It stays the default and is not touched here. This file holds
   the others. Each is a different ANSWER TO THE SAME QUESTION: in what order,
   and at what weight, are the sigil's own symmetries performed?

     turning the wheel  → diatonic transposition
     mirroring it       → inversion
     retracing the path → retrograde

   Those three, and their pairings, are all a rite has to work with, which is
   why every rite is the same sigil and the same music, differently unfolded.

   WHERE THEY COME FROM. The forms are taken from ritual formulae that are
   themselves sequences: the chaos magicians' sigil workings (Spare, Carroll,
   Hine), the Golden Dawn's pentagram ritual, Crowley's I·A·O and Liber Resh,
   the alchemists' four colours, the Goetia's three conjurations, the witches'
   cone of power, the seven gates of Inanna's descent, the Discordian seasons,
   the Bornless Ritual of the Greek papyri.
   Each is read for its SHAPE (what repeats, what returns, where the height
   is, how it ends), and the shape is what is composed. `from` says which
   source; nothing here claims to be the rite itself.

   HOW A RITE STAYS ONE PIECE OF MUSIC WITH ANY MOOD AND STYLE
   Every section of every rite stands for one of the seven sections of the
   Sevenfold (its ROLE): an opening, a plain statement, a lift, a turn, the
   dark half-time one, the crown, a close. Moods (M6) and styles (05f) already
   know what to do with those seven, by name. So:

     1. open()   before the moods: the rite's sections are laid out, each a
                 copy of its role's section with the rite's own transform,
                 length and words, and each ANSWERING TO ITS ROLE'S NAME
                 (id 'verse1', 'bridge' …) for as long as it is being dressed.
                 Any of the seven the rite has no use for stands at the end
                 as a SHADOW: it is dressed with the rest, so that what a
                 style reads off the whole plan (how quiet and how loud this
                 mood goes, whether it left an arpeggio anywhere) is the
                 mood's range, not an accident of which sections a rite has.
     2. the mood, the style and the mixer dress the plan as they always have.
     3. seal()   after them: the shadows go; the rite takes away what its
                 shape cannot have (a `hold`: Vacuity stays empty in any
                 mood), keeps a falling rite falling and a rising one rising,
                 keeps the whole inside CAP phrases, and gives every section
                 its own id back (its role stays on it, as `role`).

   open() and seal() are a pair: a plan that was opened must be sealed (M22
   registers both, as do the tests), or the shadows would be performed.

   A rite may only TAKE AWAY after the mood has spoken (cap a level, silence a
   voice); it never adds above what the mood allowed. A Lullaby stays hushed
   in every rite, an Ambient rite drumless.

   PURE: no DOM, no audio, no randomness except own() (labelled streams).
   The Sevenfold never enters this file's functions: open() returns undefined
   for it, and the composer's own plan goes through untouched.
   ══════════════════════════════════════════════════════════════════════════ */

const Rite = (() => {
  'use strict';

  const DEFAULT = 'sevenfold';
  /** No rite is lengthened (by a fast mood, by the mixer's long form) past this many phrases. */
  const CAP = 32;

  /* ── §5g.1 THE VOCABULARY ──────────────────────────────────────────────── */

  /** The seven roles: the sections of the Sevenfold, by what they are for. */
  const OPEN = 'intro', SAY = 'verse1', LIFT = 'chorus1', TURN = 'verse2', UNDER = 'bridge', CROWN = 'chorus2', CLOSE = 'outro';

  /** A transform: the wheel turned k places, mirrored (m = −1), the path retraced. */
  const T = (k = 0, m = 1, reverse = false) => ({ k: mod(k, SLOTS), m, reverse });
  const ID = () => T(), MIRROR = () => T(0, -1), BACK = () => T(0, 1, true), BOTH = () => T(0, -1, true);
  /** One seventh of the wheel (three places of twenty-one): the melody moves on a fourth. Seven of them are one whole turn. */
  const SEVENTH = 3;

  /**
   * One section of a rite.
   * @param role    which of the seven it stands for (what the mood and the style will make of it)
   * @param id      its own id, unique within the rite
   * @param phrases its length in four-bar phrases
   * @param own     fields laid over the role's before the mood speaks (the mood may still change them)
   * @param hold    what the rite insists on after the mood and the style have spoken; only ever less:
   *                  cap n          the level is at most n
   *                  voice          who sings ('bell', 'none': traced but not sung)
   *                  arp            null = none; 'light' = at most light
   *                  harm / octave / bass / drone / halfTime: false = not here
   */
  const part = (role, id, name, desc, phrases, t, own, hold) => ({ role, id, name, desc, phrases, T: t, own: own || null, hold: hold || null });

  const ORDINAL = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh'];

  /* ── §5g.2 THE RITES ───────────────────────────────────────────────────────
     ⚠ An id, once given, is for ever: links and the Grimoire name rites by id. Add, do not
       rename or remove. (The order here is the order of the pills. own() does not depend on it.)
     x = { r, up }: the sigil's own turn (cfg.rotK) and what it does to the melody ('a fourth higher').
     ─────────────────────────────────────────────────────────────────────────── */
  const RITES = {
    sevenfold: {
      label: 'Sevenfold', from: 'SIGIL’s own rite',
      blurb: 'The full rite, as it has always been: invocation, inscription, exaltation, reflection, reversal, apotheosis, banishing.',
    },

    charge: {
      label: 'Charge', from: 'the barest sigil working of chaos magick, after Austin Osman Spare',
      blurb: 'Three acts and nothing else. The desire is stated, held in a mind emptied of everything but the sign, and let go.',
      parts: (x) => [
        part(SAY, 'statement', 'Statement', 'the desire, once, as written', 1, ID()),
        part(LIFT, 'gnosis', 'Gnosis', `turned ${x.r}⁄21 · nothing in the mind but the sign`, 2, T(x.r)),
        part(CLOSE, 'release', 'Release', 'let go · it is not thought of again', 1, ID()),
      ],
    },

    seasons: {
      label: 'Five Seasons', from: 'the Discordian year: Principia Discordia (1965)',
      blurb: 'A rite of five, by the Law of Fives: Chaos, Discord, Confusion, Bureaucracy and the Aftermath, one phrase each.',
      parts: (x) => [
        part(SAY, 'chaos', 'Chaos', 'in the beginning · the sigil as written', 1, ID()),
        part(TURN, 'discord', 'Discord', 'mirrored · a second voice that does not agree', 1, MIRROR(), { harm: true }),
        part(LIFT, 'confusion', 'Confusion', `turned ${x.r}⁄21, mirrored and retraced · everything at once`, 1, T(x.r, -1, true)),
        part(TURN, 'bureaucracy', 'Bureaucracy', 'as written, in triplicate · order is imposed', 1, ID(), { arp: 'full', density: 0 }, { harm: false }),
        part(CLOSE, 'aftermath', 'The Aftermath', 'retraced · what is left when it is over', 1, BACK()),
      ],
    },

    iao: {
      label: 'I·A·O', from: 'the formula of Isis, Apophis and Osiris: the Golden Dawn’s, and Crowley’s Magick in Theory and Practice (1929)',
      blurb: 'Life, death, and rising. The sigil as it is, the sigil undone, the sigil exalted: the rite ends at its height, struck once and left to ring.',
      ends: 'struck',
      parts: (x) => [
        part(SAY, 'isis', 'Isis', 'nature, as she is · the sigil as written', 2, ID(), { arp: 'light' }),
        part(UNDER, 'apophis', 'Apophis', 'the destroyer · mirrored and retraced: nothing as it was', 2, BOTH()),
        part(CROWN, 'osiris', 'Osiris', `risen · turned ${x.r}⁄21, ${x.up}, every voice at once`, 2, T(x.r)),
      ],
    },

    posture: {
      label: 'Death Posture', from: 'Austin Osman Spare, The Book of Pleasure (1913)',
      blurb: 'The body is stilled until the mind is empty. Into that emptiness the sigil is flashed, and then it is forgotten. A rite with silence at its centre.',
      parts: (x) => [
        part(TURN, 'sigil', 'The Sigil', 'held before the eye · as written', 2, ID()),
        part(SAY, 'posture', 'The Posture', 'mirrored · the body is stilled, the breath let go', 1, MIRROR(), null, { arp: null }),
        part(OPEN, 'vacuity', 'Vacuity', 'neither-neither · the path is traced in silence', 1, ID(), { voice: 'none', pad: 0.4 },
          { voice: 'none', cap: 0, arp: null, harm: false, octave: false, bass: false }),
        part(CROWN, 'flash', 'The Flash', `turned ${x.r}⁄21 · the sigil, all at once`, 1, T(x.r)),
        part(CLOSE, 'forgetting', 'Forgetting', 'retraced · does not matter, need not be', 1, BACK()),
      ],
    },

    resh: {
      label: 'Four Adorations', from: 'Aleister Crowley, Liber Resh vel Helios (1911)',
      blurb: 'The sun is greeted at its four stations: dawn, noon, sunset, midnight. The height comes early; the rest is a long going-down, to where it began.',
      parts: (x) => [
        part(SAY, 'dawn', 'Dawn', 'Ra in his rising · the sigil as written', 2, ID()),
        part(LIFT, 'noon', 'Noon', `Ahathoor in her triumphing · turned ${x.r}⁄21, ${x.up}`, 2, T(x.r)),
        part(UNDER, 'sunset', 'Sunset', 'Tum in his setting · mirrored: what rose now falls', 2, MIRROR()),
        part(CLOSE, 'midnight', 'Midnight', 'Khephra in his hiding · retraced: the sun under the earth', 1, BACK()),
      ],
    },

    spliff: {
      label: 'S.P.L.I.F.F.', from: 'Phil Hine, Condensed Chaos (1995)',
      blurb: 'The six letters of a sigil working: Statement of intent, Pathways, Link, Intense gnosis, Fire, Forget.',
      parts: (x) => [
        part(SAY, 'statement', 'Statement of Intent', 'the desire, as written', 1, ID(), null, { arp: null }),
        part(TURN, 'pathways', 'Pathways', 'mirrored · every road the desire could take', 2, MIRROR()),
        part(UNDER, 'link', 'Link', 'retraced · the desire is bound to its sign', 1, BACK()),
        part(LIFT, 'gnosis', 'Intense Gnosis', `turned ${x.r}⁄21 · nothing in the mind but the sign`, 2, T(x.r)),
        part(CROWN, 'fire', 'Fire', 'every voice at once · it is sent', 1, T(x.r)),
        part(CLOSE, 'forget', 'Forget', 'the line returns to silence · it is not thought of again', 1, ID()),
      ],
    },

    pentagram: {
      label: 'Lesser Pentagram', from: 'the Lesser Ritual of the Pentagram of the Hermetic Order of the Golden Dawn',
      blurb: 'A banishing. The cross of light; a pentagram at each quarter, which are the four forms a melody can take; the archangels; the cross again.',
      parts: (x) => [
        part(OPEN, 'cross', 'The Cross', 'above, below, right, left · the letters are named', 1, ID()),
        part(SAY, 'east', 'East', 'air · the sigil as written', 1, ID(), { cadence: 'half' }),
        part(TURN, 'south', 'South', 'fire · mirrored: the melody inverted', 1, MIRROR()),
        part(UNDER, 'west', 'West', 'water · retraced: the melody in retrograde', 1, BACK(), { cadence: 'half' }),
        part(TURN, 'north', 'North', 'earth · mirrored and retraced', 1, BOTH()),
        part(LIFT, 'archangels', 'The Archangels', `before, behind, right, left · turned ${x.r}⁄21, with the choir`, 2, T(x.r)),
        part(CLOSE, 'seal', 'The Cross Again', 'the circle is sealed · the line returns to silence', 1, ID()),
      ],
    },

    cone: {
      label: 'Cone of Power', from: 'the witches’ circle: power raised by the round dance, and released at its height',
      blurb: 'The circle is cast and danced, sunwise. Each round the wheel turns a seventh and the melody moves on a fourth, fuller each time, until it is let go. There is no banishing: the last stroke is the sending.',
      ends: 'struck', mono: 'rise',
      parts: () => [
        part(OPEN, 'circle', 'Casting the Circle', 'the wheel is drawn · the letters are named', 1, ID()),
        part(SAY, 'round', 'The Round', 'hand to hand, sunwise · the sigil as written', 2, ID()),
        part(TURN, 'quickens', 'The Round Quickens', 'turned a seventh · the melody moves on a fourth', 2, T(SEVENTH), { density: 1 }),
        part(LIFT, 'whirl', 'The Whirl', 'turned a seventh again · every foot off the ground', 2, T(2 * SEVENTH)),
        part(CROWN, 'release', 'The Release', 'turned once more · the cone is sent', 1, T(3 * SEVENTH)),
      ],
    },

    gates: {
      label: 'Seven Gates', from: 'the Descent of Inanna (Sumer, c. 1900 BCE), kept in the witches’ Legend of the Descent of the Goddess',
      blurb: 'A rite that begins at its height. At each of seven gates the wheel turns a seventh and something is taken away, until only the drone is left. By then the wheel has turned exactly once.',
      mono: 'fall',
      parts: () => {
        const gate = (i, role, desc, hold) => part(role, `gate${i + 1}`, `The ${ORDINAL[i]} Gate`, desc, 1, T(i * SEVENTH), i % 2 ? null : { cadence: 'half' }, hold);
        return [
          gate(0, CROWN, 'the crown is taken · as written, every voice'),
          gate(1, LIFT, 'the beads of lapis · turned a seventh, the bells are gone', { octave: false }),
          gate(2, LIFT, 'the double strand · turned again, the choir is gone', { octave: false, harm: false }),
          gate(3, TURN, 'the breastplate · turned again, the kit falls back', { octave: false, harm: false }),
          gate(4, SAY, 'the ring of gold · turned again, the wheel stops ringing', { octave: false, harm: false, arp: null }),
          gate(5, SAY, 'the rod and line · turned again, the ground is gone', { octave: false, harm: false, arp: null, bass: false, cap: 1 }),
          gate(6, OPEN, 'the robe · turned again, only bells', { octave: false, harm: false, arp: null, bass: false, cap: 0 }),
          part(CLOSE, 'underworld', 'The Underworld', 'the wheel has turned once · bare, and silent', 1, ID(), { voice: 'none', pad: 0.45 },
            { voice: 'none', cap: 0, arp: null, harm: false, octave: false, bass: false }),
        ];
      },
    },

    mantra: {
      label: 'Mantra', from: 'japa, a mantra told on beads; the “sound concentration” of Peter J. Carroll’s Liber Null (1978)',
      blurb: 'One phrase, told round and round and never transformed. Each round another voice takes it up, until every voice has it; then it goes on in silence.',
      mono: 'rise',
      parts: () => {
        const round = (i, role, desc, own, hold) => part(role, `round${i + 1}`, `${ORDINAL[i]} Round`, desc, 1, ID(), { ...(i % 2 ? null : { cadence: 'half' }), ...(own || null) }, hold);
        return [
          round(0, OPEN, 'bells alone · the sigil as written'),
          round(1, SAY, 'a voice takes it up, alone', { drone: true }, { cap: 0, bass: false, arp: null, harm: false }),
          round(2, SAY, 'the ground comes in under it', null, { arp: null, harm: false }),
          round(3, TURN, 'the wheel begins to ring', null, { harm: false }),
          round(4, TURN, 'a second voice, a third below', { harm: true }),
          round(5, LIFT, 'faster · the kit in full', null, { octave: false }),
          round(6, CROWN, 'every voice has it'),
          part(CLOSE, 'silence', 'Silence', 'bells alone again · it goes on, unspoken', 1, ID()),
        ];
      },
    },

    opus: {
      label: 'Great Work', from: 'the alchemists’ magnum opus and its four colours',
      blurb: 'Solve et coagula. The sigil is first heard broken down, in the dark; then washed; it appears as written only at the yellow dawn, and is exalted in the red.',
      parts: (x) => [
        part(UNDER, 'nigredo', 'Nigredo', 'the blackening · retraced: the matter is broken down', 2, BACK(), null, { cap: 1 }),
        part(SAY, 'albedo', 'Albedo', 'the whitening · mirrored: washed, and seen in the water', 2, MIRROR(), { voice: 'bell', arp: 'light' }),
        part(TURN, 'citrinitas', 'Citrinitas', 'the yellowing · the sigil as written, at last', 2, ID()),
        part(CROWN, 'rubedo', 'Rubedo', `the reddening · turned ${x.r}⁄21, ${x.up}: exalted`, 2, T(x.r)),
        part(CLOSE, 'stone', 'The Stone', 'what remains when the fire is out', 1, ID()),
      ],
    },

    goetia: {
      label: 'Conjuration', from: 'the Goetia of the Lemegeton (17th century): circle, conjurations, constraint, charge, licence to depart',
      blurb: 'A spirit is called three times, each call a step higher and harder than the last. It answers in its own voice, is given its charge, and is sent away the way it came.',
      parts: (x) => [
        part(OPEN, 'circle', 'The Circle', 'the circle is drawn · the letters are named', 1, ID()),
        part(SAY, 'first', 'First Conjuration', 'the name is called · the sigil as written', 1, ID(), { cadence: 'half' }),
        part(TURN, 'second', 'Second Conjuration', 'called again · turned one place, a step higher', 1, T(1), { cadence: 'half' }),
        part(LIFT, 'constraint', 'The Constraint', 'a third time · another place, every voice', 1, T(2)),
        part(UNDER, 'appearance', 'The Appearance', 'mirrored · it answers, in its own voice', 2, MIRROR()),
        part(CROWN, 'charge', 'The Charge', `turned ${x.r}⁄21 · the command is given`, 2, T(x.r)),
        part(CLOSE, 'licence', 'Licence to Depart', 'retraced · go in peace, the way you came', 1, BACK()),
      ],
    },

    chaosphere: {
      label: 'Eight Rays', from: 'the eight colours of magic: Peter J. Carroll, Liber Kaos (1992)',
      blurb: 'The chaos star has eight arrows, and a melody has eight forms: as written, turned, mirrored, retraced, and every pairing of those. One phrase for each colour of magic.',
      parts: (x) => [
        part(TURN, 'octarine', 'Octarine', 'pure magic · the sigil as written', 1, ID()),
        part(UNDER, 'black', 'Black', 'death · mirrored and retraced', 1, BOTH()),
        part(TURN, 'blue', 'Blue', `wealth · turned ${x.r}⁄21, ${x.up}`, 1, T(x.r), { arp: 'full' }),
        part(LIFT, 'red', 'Red', 'war · turned and mirrored', 1, T(x.r, -1)),
        part(SAY, 'yellow', 'Yellow', 'the self · retraced: one voice', 1, BACK(), null, { arp: null, harm: false }),
        part(TURN, 'green', 'Green', 'love · mirrored: two voices, a third apart', 1, MIRROR(), { harm: true }),
        part(TURN, 'orange', 'Orange', 'wit · turned and retraced, quick', 1, T(x.r, 1, true), { arp: 'full', density: 1 }),
        part(CROWN, 'purple', 'Purple', 'sex · turned, mirrored and retraced: every voice at once', 1, T(x.r, -1, true)),
        part(CLOSE, 'octarine2', 'Octarine', 'the eight are one colour · as written', 1, ID()),
      ],
    },

    servitor: {
      label: 'Servitor', from: 'the servitors of chaos magick: Phil Hine, Chaos Servitors: A User Guide (1991)',
      blurb: 'A thought-form is made, named, and sent to its task. Its name comes back between every stage, each time with more voices: a rondo. At the end it is taken back into its maker.',
      parts: (x) => [
        part(OPEN, 'intent', 'Intent', 'what it is for · the letters are named', 1, ID()),
        part(SAY, 'naming', 'The Naming', 'its name · the sigil as written', 1, ID()),
        part(TURN, 'shaping', 'The Shaping', 'mirrored · it is given a form', 2, MIRROR()),
        part(TURN, 'naming2', 'The Naming', 'its name again · two voices now', 1, ID(), { harm: true }),
        part(LIFT, 'birth', 'The Birth', `turned ${x.r}⁄21 · it draws breath`, 2, T(x.r)),
        part(CROWN, 'sending', 'The Sending', 'its name, from every voice · go', 2, ID()),
        part(CLOSE, 'return', 'The Return', 'retraced · taken back into its maker', 1, BACK()),
      ],
    },

    gnostic: {
      label: 'Gnostic Pentagram', from: 'the Gnostic Pentagram Ritual: Peter J. Carroll, Liber Kaos (1992)',
      blurb: 'Five vowels are sung down the body, crown to root, the melody a step lower and heavier each time; the pentagrams at the centre; then the vowels again, root to crown, each one traced backwards. A palindrome.',
      parts: (x) => [
        part(OPEN, 'i', 'I, the Crown', 'the first vowel · the sigil as written', 1, ID()),
        part(SAY, 'e', 'E, the Throat', 'turned back one place · a step lower', 1, T(-1), { cadence: 'half' }),
        part(TURN, 'a', 'A, the Heart', 'another place · lower', 1, T(-2)),
        part(TURN, 'o', 'O, the Belly', 'another · lower, and heavier', 1, T(-3), { cadence: 'half' }),
        part(UNDER, 'u', 'U, the Root', 'the lowest place · slow', 1, T(-4)),
        part(LIFT, 'pentagrams', 'The Pentagrams', `all five vowels at each quarter · turned ${x.r}⁄21`, 2, T(x.r)),
        part(UNDER, 'u2', 'U, the Root', 'retraced · the way back begins', 1, T(-4, 1, true), { cadence: 'half' }),
        part(TURN, 'o2', 'O, the Belly', 'retraced · a step higher', 1, T(-3, 1, true)),
        part(TURN, 'a2', 'A, the Heart', 'retraced · higher', 1, T(-2, 1, true), { cadence: 'half' }),
        part(SAY, 'e2', 'E, the Throat', 'retraced · higher', 1, T(-1, 1, true)),
        part(CLOSE, 'i2', 'I, the Crown', 'retraced · it ends where it began', 1, BACK()),
      ],
    },

    mass: {
      label: 'Mass', from: 'Aleister Crowley, Liber XV: the Gnostic Mass (1913)',
      blurb: 'The long ceremony: introit and creed, the veil opened, a litany of versicle and response, the consecration, the anthem, the consummation, the blessing.',
      parts: (x) => [
        part(OPEN, 'introit', 'The Introit', 'the temple is entered · the letters are named', 1, ID()),
        part(SAY, 'creed', 'The Creed', 'what is believed · the sigil as written', 2, ID()),
        part(LIFT, 'veil', 'The Veil', `the veil is opened · turned ${x.r}⁄21, ${x.up}`, 2, T(x.r)),
        part(SAY, 'versicle', 'Versicle', 'the priest · as written', 1, ID(), { cadence: 'half' }),
        part(TURN, 'response', 'Response', 'the people · mirrored: so mote it be', 1, MIRROR(), { harm: true }),
        part(SAY, 'versicle2', 'Versicle', 'the priest · a seventh of the wheel on', 1, T(SEVENTH), { cadence: 'half' }),
        part(TURN, 'response2', 'Response', 'the people · mirrored again', 1, T(SEVENTH, -1), { harm: true }),
        part(UNDER, 'consecration', 'The Consecration', 'retraced · the elements are made holy', 2, BACK()),
        part(LIFT, 'anthem', 'The Anthem', `turned ${x.r}⁄21 · the choir`, 2, T(x.r)),
        part(CROWN, 'consummation', 'The Consummation', 'the sigil as written · every voice at once', 2, ID()),
        part(CLOSE, 'blessing', 'The Blessing', 'the line returns to silence', 1, ID()),
      ],
    },

    abramelin: {
      label: 'Abramelin', from: 'The Book of the Sacred Magic of Abramelin the Mage (15th century), in Mathers’ translation',
      blurb: 'The long operation. Six moons of prayer, each more withdrawn than the last; a vigil; then the Angel, once; then the princes of the dark are called and bound; then silence.',
      parts: (x) => [
        part(OPEN, 'oath', 'The Oath', 'the work is sworn · the letters are named', 1, ID()),
        part(SAY, 'moons', 'The First Moons', 'prayer at dawn and at dusk · the sigil as written', 3, ID(), null, { arp: null }),
        part(SAY, 'moons2', 'The Second Moons', 'more fervently · mirrored', 2, MIRROR(), { arp: 'light' }),
        part(TURN, 'moons3', 'The Last Moons', 'withdrawn from the world · retraced', 2, BACK()),
        part(OPEN, 'vigil', 'The Vigil', 'the lamp is lit · one place on, and waiting', 1, T(1), { cadence: 'half' }, { cap: 0 }),
        part(CROWN, 'angel', 'The Angel', `knowledge and conversation · turned ${x.r}⁄21, every voice`, 3, T(x.r)),
        part(UNDER, 'princes', 'The Princes', 'mirrored and retraced · the dark is called by name', 2, BOTH()),
        part(LIFT, 'binding', 'The Binding', `turned ${x.r}⁄21 and mirrored · they are sworn to the wand`, 2, T(x.r, -1)),
        part(CLOSE, 'silence', 'The Silence', 'the work is kept, and not spoken of', 1, ID()),
      ],
    },

    bornless: {
      label: 'Bornless One', from: 'the Bornless Ritual: the Stele of Jeu (Greek Magical Papyri, PGM V), as the Golden Dawn and Crowley’s Liber Samekh (1921) have it',
      blurb: 'A rite with a refrain. An oath; then air, fire, water, earth and spirit are each invoked in a form of their own, and after each the same charge comes back: hear me. Then the attainment, as written, in every voice.',
      parts: (x) => {
        const charge = (i) => part(LIFT, `charge${i}`, 'The Charge', i === 1 ? `hear me · turned ${x.r}⁄21, ${x.up}` : 'hear me · the same charge, turned as before', 1, T(x.r));
        return [
          part(OPEN, 'oath', 'The Oath', 'thee I invoke, the Bornless One · the letters are named', 1, ID()),
          part(SAY, 'air', 'Air', 'the east · the sigil as written', 2, ID(), { cadence: 'half' }),
          charge(1),
          part(TURN, 'fire', 'Fire', 'the south · mirrored', 2, MIRROR(), { cadence: 'half' }),
          charge(2),
          part(UNDER, 'water', 'Water', 'the west · retraced', 2, BACK(), { cadence: 'half' }),
          charge(3),
          part(TURN, 'earth', 'Earth', 'the north · mirrored and retraced', 2, BOTH(), { cadence: 'half' }),
          charge(4),
          part(TURN, 'spirit', 'Spirit', 'above and below · a seventh of the wheel on, in two voices', 2, T(SEVENTH), { harm: true, cadence: 'half' }),
          charge(5),
          part(CROWN, 'attainment', 'The Attainment', 'I am the Bornless Spirit · as written, every voice', 2, ID()),
          part(CLOSE, 'silence', 'Silence', 'the line returns to silence', 1, ID()),
        ];
      },
    },
  };
  Object.keys(RITES).forEach((id) => { RITES[id].id = id; });

  const riteOf = (id) => (RITES[id] && RITES[id].parts ? RITES[id] : null);

  /* ── §5g.3 OPEN: the rite's sections, answering to their roles ─────────── */

  /** What a turn of the wheel by the sigil's own interval does to the melody, in words. */
  const UP = { 2: 'a third higher', 3: 'a fourth higher', 4: 'a fifth higher' };

  const NUMERALS = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  /** 1 → I, 14 → XIV. A rite has at most a few dozen sections. */
  function roman(n) {
    let out = '';
    for (const [v, s] of NUMERALS) while (n >= v) { out += s; n -= v; }
    return out;
  }

  /**
   * The plan of a rite, before the mood speaks. Undefined for the Sevenfold (and for an unknown
   * id): the composer's own plan is then the plan.
   * Every section is the Sevenfold's section of its role, with the rite's transform, length and
   * words; until seal() its `id` IS its role, so that moods and styles dress it by name.
   */
  function open(cfg) {
    const rite = riteOf(cfg && cfg.rite);
    if (!rite) return undefined;
    const arch = {};
    for (const s of makePlan(cfg.rotK, cfg.shift)) arch[s.id] = s;
    const parts = rite.parts({ r: cfg.rotK, up: UP[cfg.shift] || 'higher' });
    const plan = parts.map((p, i) => {
      const { tail, final, ...body } = arch[p.role];                 // where the rite ends is the rite's to say
      const s = { ...body, ...(p.own || {}), id: p.role, roman: roman(i + 1), name: p.name, desc: p.desc,
        phrases: p.phrases, T: { ...p.T }, rite: { id: p.id, phrases: p.phrases, hold: p.hold } };
      if (i === parts.length - 1) {
        s.final = true; s.tail = 8;
        if (rite.ends) s.ends = rite.ends;
      }
      return s;
    });
    // The roles this rite does not use, to be dressed with the rest and dropped by seal().
    const used = new Set(parts.map((p) => p.role));
    for (const role of Object.keys(arch)) {
      if (used.has(role)) continue;
      const { tail, final, ...body } = arch[role];
      plan.push({ ...body, T: { ...body.T }, shadow: true });
    }
    return plan;
  }

  /* ── §5g.4 SEAL: after the mood and the style ──────────────────────────── */

  function keep(s, h) {
    if (h.cap != null) s.intensity = Math.min(s.intensity | 0, h.cap);
    if (h.voice) s.voice = h.voice;
    if ('arp' in h) { if (!h.arp) s.arp = null; else if (s.arp) s.arp = h.arp; }
    for (const k of ['harm', 'octave', 'bass', 'drone', 'halfTime']) if (h[k] === false) s[k] = false;
    if (!(s.intensity > 0)) s.halfTime = false;
  }

  /**
   * Close the dressing. Applies each section's hold; keeps a falling rite falling and a rising
   * one rising (by lowering, never by raising); brings a rite that was lengthened past CAP back
   * under it; then every section takes its own id back and keeps its role as `role`.
   * A plan that is not a rite's (the Sevenfold) is returned as it came.
   */
  function seal(plan, cfg) {
    const rite = riteOf(cfg && cfg.rite);
    if (!rite || !plan.some((s) => s.rite)) return plan;
    for (let i = plan.length - 1; i >= 0; i--) if (plan[i].shadow) plan.splice(i, 1);
    const mine = plan.filter((s) => s.rite);

    for (const s of mine) if (s.rite.hold) keep(s, s.rite.hold);

    if (rite.mono === 'fall') {
      let lo = Infinity;
      for (const s of mine) { lo = Math.min(lo, s.intensity | 0); s.intensity = lo; }
    } else if (rite.mono === 'rise') {
      let hi = Infinity;
      for (let i = mine.length - 1; i >= 0; i--) {
        const s = mine[i];
        if (s.final && s.ends !== 'struck') continue;                // a quiet close is not part of the climb
        hi = Math.min(hi, s.intensity | 0); s.intensity = hi;
      }
    }
    for (const s of mine) if (!(s.intensity > 0)) s.halfTime = false;

    // Length: undo the latest, largest lengthening first, until the rite fits.
    let total = mine.reduce((a, s) => a + s.phrases, 0);
    while (total > CAP) {
      let j = -1, most = 1;
      mine.forEach((s, i) => { const q = s.phrases / s.rite.phrases; if (q > 1 && q >= most) { most = q; j = i; } });
      if (j < 0) break;
      const s = mine[j], was = s.phrases;
      s.phrases = Math.max(s.rite.phrases, Math.ceil(was / 2));
      total -= was - s.phrases;
    }

    plan.forEach((s, i) => {
      if (!s.rite) return;
      s.role = s.id; s.id = s.rite.id; s.roman = roman(i + 1);
      delete s.rite;
    });
    return plan;
  }

  /* ── §5g.5 FOR THE PAGE ────────────────────────────────────────────────── */

  /**
   * The rite a sigil would choose for itself. Every rite draws one number against the sigil
   * (stream(hash, 'rite:<id>')) and the highest takes it, so a rite added later changes the
   * answer only for the sigils that new rite wins; every other sigil keeps the rite it had.
   * A link names the rite drawn all the same, never "the sigil's own".
   */
  const OWN = new WeakMap();
  function own(sigil) {
    if (OWN.has(sigil)) return OWN.get(sigil);
    let best = DEFAULT, top = -1;
    for (const id of Object.keys(RITES)) {
      const v = stream(sigil.hash, `rite:${id}`).float();
      if (v > top) { top = v; best = id; }
    }
    OWN.set(sigil, best);
    return best;
  }

  const SEVENFOLD = { sections: 7, phrases: 12 };
  /** How long a rite is before any mood lengthens it: { sections, phrases, bars }. */
  function measure(id) {
    const rite = riteOf(id);
    const m = rite ? (() => { const p = rite.parts({ r: 10, up: UP[3] }); return { sections: p.length, phrases: p.reduce((a, s) => a + s.phrases, 0) }; })() : SEVENFOLD;
    return { ...m, bars: m.phrases * 4 + 2 };
  }

  /** For the HUD: the rite's name, or '' for the Sevenfold. */
  function describe(cfg) {
    const rite = riteOf(cfg && cfg.rite);
    return rite ? rite.label : '';
  }

  return { RITES, DEFAULT, CAP, SEVENTH, open, seal, own, measure, describe, roman };
})();

if (typeof window !== 'undefined') window.Rite = Rite;
