'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §5j  PALETTE — who plays the sigil · pure, deterministic, no audio context
   --------------------------------------------------------------------------
   The sigil writes a song and deals a sound; but the sound it deals is one instrument, the wavetable
   cube, sung as a wave, a vowel, a bell, a pad. Every sigil therefore arrived with the same kind of
   voice in a different colour, and a listener heard it. A palette is the other half of the answer:
   WHICH instruments play, in what company, in what room.

     INSTRUMENTS   more than a hundred, each one of eight engines (sigil-voices.js) with its own numbers: a harp,
                   a kalimba, a reese bass, a shakuhachi, a tubular bell, a bowed singing bowl, a
                   tonewheel organ, an electric piano, a supersaw, a swarm of grains. And the cube's own
                   eight, kept: a sigil may still be sung as it always was.
     WORLDS        twenty places for them to be together. A world is a company of instruments that belong
                   in one room (the temple's bowls and bells and frame drums; the glasshouse's glockenspiel
                   and shimmer; the foundry's reese and anvil), and the room itself: how big, how dark,
                   how much of it. A song is in ONE world, so that it is one thing; and which, is the
                   sigil's, leaned on by its mood, its idiom and its element, so that a Dirge is not cast
                   in the Toybox by accident, nor a Hymn in the Foundry, unless the lots say so.
     ROLES         thirteen parts a song has: the lead, a second voice, the choir behind, the bell, the
                   bass, the arpeggio, the pad, the drone, the chords, and the kit's tom, its side-stick, its
                   shaker and the percussion the fills play. Each is dealt an instrument from the world.
     VARIATION     even two sigils in one world are two players: every instrument's numbers are nudged,
                   by the sigil, within what that instrument can bear (a harp a little brighter, a
                   bowl a little longer), so that no two are the same one twice.

   THE LISTENER keeps the last word. The patch (and so a shared link) may name another deal (`pal`), say
   "the original voices" (`palOff`), or name an instrument for a role (`iLead` … `iPerc`).

   DETERMINISM. deal() draws from stream(hash, 'palette') (or 'palette:<n>') in a FROZEN order;
   pack() from stream(hash, 'palette:<role>:<id>'). Nothing here touches the composer's R, or the cube's
   stream: with the palette off, a song is exactly the song it was. ⚠ INSTRUMENT IDS ARE FOR EVER: a link
   names them. Add instruments; never renumber or remove one. The same of the worlds' order and of each
   world's cast lists (deal() picks by position, and by how far down a list an instrument is): append.
   ══════════════════════════════════════════════════════════════════════════ */

const Palette = (() => {
  'use strict';

  /* ── §5j.1 THE ENGINES' NUMBERS ────────────────────────────────────────── */

  /** The slots a part of the song has in the core's instrument table. */
  const ROLES = ['lead', 'alt', 'harm', 'bell', 'bass', 'arp', 'pad', 'drone', 'comp', 'tom', 'rim', 'shaker', 'perc'];
  const SLOT = Object.fromEntries(ROLES.map((r, i) => [r, i]));
  const ROLE_LABEL = { lead: 'Lead', alt: 'Second voice', harm: 'Choir', bell: 'Bell', bass: 'Bass', arp: 'Arpeggio', pad: 'Pad',
    drone: 'Drone', comp: 'Chords', tom: 'Toms', rim: 'Side-stick', shaker: 'Shaker', perc: 'Percussion' };
  /** The patch field that names an instrument for each role (0 = the one dealt). */
  const ROLE_FIELD = { lead: 'iLead', alt: 'iAlt', harm: 'iHarm', bell: 'iBell', bass: 'iBass', arp: 'iArp', pad: 'iPad',
    drone: 'iDrone', comp: 'iComp', perc: 'iPerc' };

  /**
   * What each engine's numbers are, in order, from slot 2 on (0 is the engine, 1 the gain). The meaning of each is
   * written beside the engine in sigil-voices.js.
   */
  const PARAMS = {
    pluck: ['t60', 'damp', 'pick', 'stiff', 'exc', 'exb', 'body', 'bodyLo', 'bodyHi', 'pair', 'pairLvl', 'mute', 'buzz', 'vib', 'vibHz', 'tilt', 'click', 'width'],
    modal: ['set', 't60', 'tilt', 'colour', 'hard', 'exc', 'excLen', 'bend', 'bendT', 'spread', 'trem', 'tremD', 'noise', 'pos', 'upper', 'velSens', 'rel', 'drive'],
    analog: ['wave', 'voices', 'detune', 'spread', 'pw', 'pwm', 'pwmHz', 'cut', 'q', 'fenv', 'fdec', 'atk', 'dec', 'sus', 'rel', 'sub', 'noise', 'sync', 'drive', 'drift', 'vib', 'vibHz'],
    organ: ['d16', 'd513', 'd8', 'd4', 'd223', 'd2', 'd135', 'd113', 'd1', 'perc', 'percH', 'percDec', 'click', 'chiff', 'leslie', 'leslieHz', 'drive', 'reed', 'atk', 'rel', 'drift', 'vib'],
    dx: ['alg', 'fb', 'r1', 'r2', 'r3', 'r4', 'l1', 'l2', 'l3', 'l4', 'dec1', 'dec2', 'dec3', 'dec4', 'sus1', 'sus2', 'sus3', 'sus4', 'vel', 'atk', 'open', 'rel'],
    breath: ['air', 'band', 'tilt', 'even', 'vib', 'vibHz', 'vibDelay', 'atk', 'rel', 'chiff', 'scoop', 'scoopT', 'over', 'formant', 'formantQ', 'jitter', 'flutter', 'drive', 'edge'],
    fold: ['ratio', 'modR', 'index', 'fold', 'asym', 'lpg', 'base', 'amt', 'mode', 'atk', 'rel', 'sub', 'zap', 'second', 'lvl2', 'idxDec', 'drive'],
    cloud: ['src', 'rate', 'len', 'jitter', 'oct', 'fifth', 'spread', 'atk', 'rel', 'wander', 'rnd', 'soft'],
  };
  /** The core's kind numbers (SigilDSP.KIND), by engine. cube: the old voices, which need no table. */
  const KIND_OF = { pluck: 15, modal: 16, analog: 17, organ: 18, dx: 19, breath: 20, fold: 21, cloud: 22 };

  /**
   * How far each number may be moved by the sigil: [kind, amount]. mul: × a factor in [1/(1+a), 1+a]; add: ± a.
   * Enough that two harps are two players; not enough that a harp is a different thing.
   */
  const JIT = {
    pluck: { t60: ['mul', 0.3], damp: ['add', 0.08], pick: ['add', 0.03], body: ['add', 0.12], bodyLo: ['mul', 0.12], bodyHi: ['mul', 0.12], exb: ['add', 0.1], pair: ['mul', 0.3] },
    modal: { t60: ['mul', 0.3], hard: ['add', 0.08], pos: ['add', 0.04], colour: ['add', 0.15], bend: ['add', 0.03], spread: ['add', 0.15], tremD: ['add', 0.1] },
    analog: { detune: ['mul', 0.35], cut: ['mul', 0.25], q: ['mul', 0.2], fenv: ['mul', 0.25], fdec: ['mul', 0.3], pw: ['add', 0.05], pwmHz: ['mul', 0.4], atk: ['mul', 0.3], rel: ['mul', 0.3], drift: ['mul', 0.4] },
    organ: { d8: ['add', 0.1], d4: ['add', 0.12], d2: ['add', 0.1], leslieHz: ['mul', 0.3], chiff: ['add', 0.06], atk: ['mul', 0.3] },
    dx: { l2: ['mul', 0.15], l4: ['mul', 0.15], fb: ['add', 0.1], dec1: ['mul', 0.25], dec2: ['mul', 0.25], r4: ['mul', 0.02] },
    breath: { air: ['add', 0.08], vib: ['mul', 0.3], vibHz: ['mul', 0.12], atk: ['mul', 0.3], chiff: ['add', 0.1], formant: ['mul', 0.15], tilt: ['add', 0.2] },
    fold: { index: ['mul', 0.25], fold: ['mul', 0.25], lpg: ['mul', 0.3], amt: ['mul', 0.2] },
    cloud: { rate: ['mul', 0.3], len: ['mul', 0.3], jitter: ['mul', 0.4], oct: ['add', 0.06], wander: ['add', 0.1] },
  };

  /* ── §5j.2 THE INSTRUMENTS ─────────────────────────────────────────────── */

  /**
   * The tags an instrument, a world, a mood, an idiom or an element can carry, 0…1: how it FEELS. A song asks for
   * a feeling, and the worlds that have it are the likelier.
   */
  const TAGS = ['bright', 'warm', 'organic', 'fierce', 'dreamy', 'sacred', 'eerie', 'playful'];

  const INST = new Map();                 // id → definition
  const BY_KEY = new Map();
  /**
   * def(id, key, name, engine, params, o): o = { roles: [the parts it can play], tags, oct: { role: octaves }, gain }
   * ⚠ an id is for ever. Engine 'cube': params.cube is which of the cube's voices.
   */
  function def(id, key, name, engine, params, o = {}) {
    if (INST.has(id) || BY_KEY.has(key)) throw new Error(`Palette: instrument ${id}/${key} twice`);
    const d = { id, key, name, engine, params: params || {}, roles: o.roles || [], tags: o.tags || {}, oct: o.oct || {}, range: o.range || null, gain: o.gain ?? 1, blurb: o.blurb || '' };
    INST.set(id, d); BY_KEY.set(key, d);
    return d;
  }
  const L = 'lead', A = 'alt', H = 'harm', B = 'bell', BS = 'bass', AR = 'arp', PD = 'pad', DR = 'drone', CP = 'comp', TM = 'tom', RM = 'rim', SH = 'shaker', PC = 'perc';

  /* The cube's own voices. A sigil sung in them is sung as it always was. */
  def(1, 'cube-wave', 'Glass wave', 'cube', { cube: 'wave' }, { roles: [L, A, AR, BS, CP], tags: { bright: 0.5, warm: 0.3, dreamy: 0.4 } });
  def(2, 'cube-vox', 'Vowel', 'cube', { cube: 'vox' }, { roles: [L, A, H], tags: { warm: 0.6, organic: 0.5, sacred: 0.5 } });
  def(3, 'cube-fm', 'Cube FM', 'cube', { cube: 'fm' }, { roles: [L, A, AR], tags: { bright: 0.6, fierce: 0.3 } });
  def(4, 'cube-bow', 'Cube bow', 'cube', { cube: 'bow' }, { roles: [L, A, H, PD], tags: { warm: 0.5, eerie: 0.4, organic: 0.4 } });
  def(5, 'cube-bell', 'Cube bell', 'cube', { cube: 'bell' }, { roles: [B, L, AR, CP], tags: { bright: 0.6, sacred: 0.4, dreamy: 0.3 } });
  def(6, 'cube-pad', 'Cube pad', 'cube', { cube: 'pad' }, { roles: [PD], tags: { dreamy: 0.5, warm: 0.4 } });
  def(7, 'cube-drone', 'Cube drone', 'cube', { cube: 'drone' }, { roles: [DR], tags: { sacred: 0.4, eerie: 0.3 } });
  def(8, 'cube-bass', 'Cube bass', 'cube', { cube: 'bass' }, { roles: [BS], tags: { warm: 0.4 } });

  /* ── PLUCK: strings ── */
  def(10, 'harp', 'Harp', 'pluck', { t60: 3.6, damp: 0.62, pick: 0.16, stiff: 0.05, exc: 1, exb: 0.55, body: 0.5, bodyLo: 180, bodyHi: 420, mute: 0.25, tilt: 0.55, click: 0.12 },
    { roles: [L, A, AR, CP, B], tags: { warm: 0.7, organic: 0.8, dreamy: 0.7, sacred: 0.6 } });
  def(11, 'nylon', 'Nylon guitar', 'pluck', { t60: 2.3, damp: 0.42, pick: 0.12, stiff: 0.1, exc: 0, exb: 0.42, body: 0.85, bodyLo: 105, bodyHi: 240, mute: 0.5, tilt: 0.6, click: 0.32 },
    { roles: [L, A, AR, CP], tags: { warm: 0.9, organic: 0.95, playful: 0.3 } });
  def(12, 'steel', 'Steel-string', 'pluck', { t60: 2.8, damp: 0.72, pick: 0.12, stiff: 0.18, exc: 0, exb: 0.8, body: 0.6, bodyLo: 120, bodyHi: 320, pair: 5, pairLvl: 0.5, width: 0.4, mute: 0.4, tilt: 0.55, click: 0.4 },
    { roles: [L, A, AR, CP], tags: { bright: 0.6, organic: 0.9, fierce: 0.3, warm: 0.5 } });
  def(13, 'koto', 'Koto', 'pluck', { t60: 3.2, damp: 0.8, pick: 0.09, stiff: 0.04, exc: 1, exb: 0.78, body: 0.25, bodyLo: 200, bodyHi: 560, mute: 0.2, buzz: 0.07, tilt: 0.4, click: 0.26 },
    { roles: [L, A, AR, CP], tags: { organic: 0.9, bright: 0.5, sacred: 0.4, eerie: 0.3 } });
  def(14, 'sitar', 'Sitar', 'pluck', { t60: 4.5, damp: 0.85, pick: 0.08, stiff: 0.2, exc: 0, exb: 0.9, body: 0.3, bodyLo: 220, bodyHi: 640, pair: 7, pairLvl: 0.4, width: 0.3, mute: 0, buzz: 0.55, vib: 9, vibHz: 5.2, tilt: 0.3, click: 0.3 },
    { roles: [L, A, AR], tags: { organic: 0.8, eerie: 0.5, warm: 0.5, bright: 0.5 } });
  def(15, 'banjo', 'Banjo', 'pluck', { t60: 1.3, damp: 0.86, pick: 0.1, stiff: 0.3, exc: 0, exb: 0.95, body: 0.2, bodyLo: 300, bodyHi: 700, mute: 0.6, tilt: 0.8, click: 0.55 },
    { roles: [L, A, AR, CP], tags: { playful: 0.8, organic: 0.9, bright: 0.7 } });
  def(16, 'upright', 'Upright bass', 'pluck', { t60: 1.5, damp: 0.3, pick: 0.2, stiff: 0.05, exc: 3, exb: 0.35, body: 0.85, bodyLo: 80, bodyHi: 180, mute: 0.75, tilt: 0.5, click: 0.25 },
    { roles: [BS], tags: { warm: 0.9, organic: 0.95 } });
  def(17, 'fretless', 'Fretless bass', 'pluck', { t60: 2.0, damp: 0.38, pick: 0.15, stiff: 0.03, exc: 3, exb: 0.5, body: 0.3, bodyLo: 90, bodyHi: 200, mute: 0.55, vib: 6, vibHz: 4.6, tilt: 0.4, click: 0.2 },
    { roles: [BS], tags: { warm: 0.8, organic: 0.5, dreamy: 0.3 } });
  def(18, 'harpsichord', 'Harpsichord', 'pluck', { t60: 1.7, damp: 0.93, pick: 0.2, stiff: 0.06, exc: 0, exb: 1, body: 0.4, bodyLo: 150, bodyHi: 500, pair: 1200, pairLvl: 0.5, width: 0.4, mute: 0.9, tilt: 0.4, click: 0.5 },
    { roles: [L, A, AR, CP], tags: { bright: 0.8, organic: 0.7, sacred: 0.3, playful: 0.3 } });
  def(19, 'oud', 'Oud', 'pluck', { t60: 2.1, damp: 0.52, pick: 0.13, stiff: 0.12, exc: 0, exb: 0.6, body: 0.75, bodyLo: 140, bodyHi: 300, pair: 8, pairLvl: 0.6, width: 0.6, mute: 0.3, buzz: 0.05, tilt: 0.5, click: 0.3 },
    { roles: [L, A, AR, CP], tags: { warm: 0.8, organic: 0.9, eerie: 0.3 } });
  def(20, 'felt-piano', 'Felt piano', 'pluck', { t60: 5, damp: 0.68, pick: 0.12, stiff: 0.42, exc: 1, exb: 0.75, body: 0.6, bodyLo: 110, bodyHi: 360, pair: 3, pairLvl: 0.7, width: 0.5, mute: 0.65, tilt: 0.6, click: 0.18 },
    { roles: [L, A, AR, CP], tags: { warm: 0.8, organic: 0.8, dreamy: 0.6 } });
  def(21, 'tanpura', 'Tanpura', 'pluck', { t60: 9, damp: 0.9, pick: 0.08, stiff: 0.1, exc: 0, exb: 0.85, body: 0.5, bodyLo: 150, bodyHi: 420, pair: 2, pairLvl: 0.8, width: 0.7, buzz: 0.7, mute: 0, tilt: 0.2, click: 0.1 },
    { roles: [DR], tags: { sacred: 0.8, warm: 0.6, organic: 0.8, eerie: 0.3 } });
  def(22, 'glass-pluck', 'Glass pluck', 'pluck', { t60: 2.4, damp: 0.96, pick: 0.18, stiff: 0.55, exc: 1, exb: 0.7, body: 0, mute: 0.2, tilt: 0.4, click: 0.08, pair: 9, pairLvl: 0.5, width: 0.6 },
    { roles: [L, A, AR, B], tags: { bright: 0.9, dreamy: 0.7, playful: 0.4 } });
  def(23, 'mandolin', 'Mandolin', 'pluck', { t60: 1.2, damp: 0.82, pick: 0.12, stiff: 0.14, exc: 0, exb: 0.9, body: 0.4, bodyLo: 210, bodyHi: 620, pair: 9, pairLvl: 0.85, width: 0.5, mute: 0.5, tilt: 0.7, click: 0.5 },
    { roles: [L, A, AR, CP], tags: { bright: 0.7, organic: 0.9, playful: 0.6, warm: 0.4 } });
  def(24, 'dulcimer', 'Hammered dulcimer', 'pluck', { t60: 2.6, damp: 0.78, pick: 0.15, stiff: 0.3, exc: 1, exb: 0.6, body: 0.5, bodyLo: 170, bodyHi: 480, pair: 6, pairLvl: 0.9, width: 0.7, mute: 0.1, tilt: 0.5, click: 0.12 },
    { roles: [L, A, AR, CP, B], tags: { dreamy: 0.7, organic: 0.85, warm: 0.6, sacred: 0.4 } });
  def(25, 'pizzicato', 'Pizzicato strings', 'pluck', { t60: 0.55, damp: 0.5, pick: 0.1, stiff: 0.05, exc: 0, exb: 0.5, body: 0.9, bodyLo: 300, bodyHi: 820, mute: 0.8, tilt: 0.6, click: 0.35 },
    { roles: [AR, CP, L, A], tags: { playful: 0.7, organic: 0.8, warm: 0.6 } });
  def(26, 'lute', 'Lute', 'pluck', { t60: 1.9, damp: 0.4, pick: 0.14, stiff: 0.1, exc: 0, exb: 0.5, body: 0.8, bodyLo: 150, bodyHi: 360, pair: 5, pairLvl: 0.6, width: 0.4, mute: 0.4, tilt: 0.5, click: 0.25 },
    { roles: [L, A, AR, CP], tags: { warm: 0.85, organic: 0.9, sacred: 0.3, dreamy: 0.3 } });

  /* ── MODAL: bars, bowls, bells, skins ── */
  def(30, 'marimba', 'Marimba', 'modal', { set: 0, t60: 1.3, tilt: 0.6, colour: 0, hard: 0.5, exc: 0, spread: 0.3, noise: 0.12, pos: 0.25, velSens: 0.5 },
    { roles: [L, A, AR, B, CP], tags: { warm: 0.8, organic: 0.9, playful: 0.5 } });
  def(31, 'vibes', 'Vibraphone', 'modal', { set: 1, t60: 4.5, tilt: 0.4, colour: 0.2, hard: 0.45, exc: 0, spread: 0.4, trem: 5, tremD: 0.45, pos: 0.25, velSens: 0.5 },
    { roles: [L, A, AR, B, CP], tags: { warm: 0.7, dreamy: 0.8, organic: 0.5, bright: 0.4 } });
  def(32, 'glockenspiel', 'Glockenspiel', 'modal', { set: 2, t60: 3, tilt: 0.5, colour: 0.5, hard: 0.8, exc: 0, spread: 0.4, velSens: 0.4 },
    { roles: [B, L, A, AR], tags: { bright: 0.95, playful: 0.6, dreamy: 0.6 }, oct: { lead: 0 } });
  def(33, 'tubular', 'Tubular bells', 'modal', { set: 3, t60: 7, tilt: 0.3, colour: 0.2, hard: 0.6, exc: 0, spread: 0.5, velSens: 0.5 },
    { roles: [B, L], tags: { sacred: 0.9, bright: 0.5, eerie: 0.4 } });
  def(34, 'bowl', 'Singing bowl', 'modal', { set: 4, t60: 7, tilt: 0.2, colour: 0, hard: 0.4, exc: 2, excLen: 0.7, spread: 0.6, rel: 1.0, velSens: 0.3 },
    { roles: [PD, DR, L, H], tags: { sacred: 0.95, dreamy: 0.7, eerie: 0.4, warm: 0.5 } });
  def(35, 'gender', 'Gamelan gender', 'modal', { set: 5, t60: 3.2, tilt: 0.4, colour: 0.1, hard: 0.55, exc: 0, spread: 0.5, trem: 6.2, tremD: 0.2, velSens: 0.5 },
    { roles: [L, A, AR, B, CP], tags: { sacred: 0.6, organic: 0.7, eerie: 0.3, warm: 0.5 } });
  def(36, 'steelpan', 'Steel pan', 'modal', { set: 6, t60: 1.7, tilt: 0.5, colour: 0.2, hard: 0.6, exc: 0, spread: 0.35, velSens: 0.6 },
    { roles: [L, A, AR, CP], tags: { playful: 0.9, warm: 0.6, bright: 0.6, organic: 0.6 } });
  def(37, 'kalimba', 'Kalimba', 'modal', { set: 7, t60: 2.3, tilt: 0.5, colour: 0, hard: 0.55, exc: 0, spread: 0.3, noise: 0.16, velSens: 0.5 },
    { roles: [L, A, AR, B, CP], tags: { playful: 0.7, dreamy: 0.7, warm: 0.6, organic: 0.8 } });
  def(38, 'music-box', 'Music box', 'modal', { set: 19, t60: 1.7, tilt: 0.5, colour: 0.4, hard: 0.95, exc: 0, spread: 0.2, velSens: 0.3 },
    { roles: [B, L, AR], tags: { playful: 0.9, bright: 0.8, dreamy: 0.8, eerie: 0.3 } });
  def(39, 'crotales', 'Crotales', 'modal', { set: 16, t60: 5, tilt: 0.3, colour: 0.5, hard: 0.9, exc: 0, spread: 0.5, velSens: 0.4 },
    { roles: [B], tags: { bright: 0.95, sacred: 0.6, eerie: 0.4 }, oct: { bell: 0 } });
  def(40, 'glass-harmonica', 'Glass harmonica', 'modal', { set: 15, t60: 4, tilt: 0.2, colour: 0.1, hard: 0.5, exc: 2, excLen: 0.35, spread: 0.5, rel: 0.6, velSens: 0.3 },
    { roles: [PD, L, A, H, DR], tags: { dreamy: 0.95, eerie: 0.7, bright: 0.6, sacred: 0.5 } });
  def(41, 'tamtam', 'Tam-tam', 'modal', { set: 18, t60: 9, tilt: 0.2, colour: 0.2, hard: 0.3, exc: 0, spread: 0.8, velSens: 0.6 },
    { roles: [B, DR], tags: { eerie: 0.8, sacred: 0.6, fierce: 0.5 } });
  def(42, 'handpan', 'Handpan', 'modal', { set: 21, t60: 3, tilt: 0.5, colour: 0, hard: 0.55, exc: 0, spread: 0.4, velSens: 0.5, noise: 0.1 },
    { roles: [L, A, AR, CP], tags: { warm: 0.8, dreamy: 0.8, organic: 0.8, sacred: 0.5 } });
  def(43, 'chimes', 'Wind chimes', 'modal', { set: 20, t60: 4, tilt: 0.3, colour: 0.3, hard: 0.8, exc: 0, spread: 0.9, velSens: 0.4 },
    { roles: [B, AR], tags: { dreamy: 0.8, bright: 0.8, sacred: 0.4, organic: 0.6 } });
  def(44, 'bowl-struck', 'Struck bowl', 'modal', { set: 4, t60: 9, tilt: 0.2, colour: 0, hard: 0.4, exc: 0, spread: 0.6, velSens: 0.5 },
    { roles: [B, L, DR], tags: { sacred: 0.95, dreamy: 0.6, eerie: 0.3 } });
  def(45, 'xylophone', 'Xylophone', 'modal', { set: 0, t60: 0.6, tilt: 0.7, colour: 0.3, hard: 0.92, exc: 0, spread: 0.3, noise: 0.18, pos: 0.22, velSens: 0.6 },
    { roles: [L, A, AR, B, CP], tags: { playful: 0.9, bright: 0.8, organic: 0.7 } });
  def(46, 'celesta', 'Celesta', 'modal', { set: 7, t60: 2.8, tilt: 0.5, colour: 0.1, hard: 0.7, exc: 0, spread: 0.4, velSens: 0.4 },
    { roles: [B, L, A, AR], tags: { dreamy: 0.9, bright: 0.6, playful: 0.5, sacred: 0.3 } });
  def(47, 'handbell', 'Handbell', 'modal', { set: 16, t60: 4, tilt: 0.4, colour: 0.25, hard: 0.75, exc: 0, spread: 0.5, velSens: 0.5 },
    { roles: [B, L, A], tags: { sacred: 0.6, bright: 0.7, playful: 0.4 } });
  def(48, 'bass-marimba', 'Bass marimba', 'modal', { set: 0, t60: 1.1, tilt: 0.2, colour: -0.2, hard: 0.4, exc: 0, spread: 0.2, noise: 0.1, pos: 0.25, velSens: 0.5 },
    { roles: [BS], tags: { warm: 0.8, organic: 0.9, playful: 0.4 } });
  /* percussion */
  def(50, 'conga', 'Conga', 'modal', { set: 9, t60: 0.38, tilt: 0.2, colour: 0, hard: 0.6, exc: 0, bend: 1.22, bendT: 0.04, spread: 0.2, noise: 0.3, velSens: 0.7 },
    { roles: [TM, PC], tags: { organic: 0.9, warm: 0.7, playful: 0.5 } });
  def(51, 'taiko', 'Taiko', 'modal', { set: 10, t60: 0.95, tilt: 0.2, colour: 0, hard: 0.35, exc: 0, bend: 1.3, bendT: 0.09, spread: 0.3, noise: 0.15, velSens: 0.8, drive: 0.3 },
    { roles: [TM, PC], tags: { fierce: 0.8, organic: 0.8, sacred: 0.4, warm: 0.4 } });
  def(52, 'frame-drum', 'Frame drum', 'modal', { set: 10, t60: 0.5, tilt: 0.2, colour: -0.2, hard: 0.5, exc: 0, bend: 1.15, bendT: 0.05, spread: 0.3, noise: 0.2, velSens: 0.7 },
    { roles: [TM, PC], tags: { organic: 0.95, sacred: 0.6, warm: 0.6 } });
  def(53, 'timpani', 'Timpani', 'modal', { set: 11, t60: 1.7, tilt: 0.2, colour: 0, hard: 0.35, exc: 0, bend: 1.1, bendT: 0.11, spread: 0.3, velSens: 0.8 },
    { roles: [TM, PC], tags: { sacred: 0.6, fierce: 0.5, organic: 0.7 } });
  def(54, 'tabla', 'Tabla', 'modal', { set: 12, t60: 0.42, tilt: 0.2, colour: 0.2, hard: 0.8, exc: 0, bend: 1.06, bendT: 0.06, spread: 0.2, noise: 0.15, velSens: 0.7 },
    { roles: [TM, PC], tags: { organic: 0.9, playful: 0.4, warm: 0.5, bright: 0.4 } });
  def(55, 'woodblock', 'Wood block', 'modal', { set: 8, t60: 0.14, tilt: 0.1, colour: 0.2, hard: 0.85, exc: 0, velSens: 0.5 },
    { roles: [RM, PC], tags: { playful: 0.8, organic: 0.8, bright: 0.6 } });
  def(56, 'clave', 'Claves', 'modal', { set: 22, t60: 0.28, tilt: 0.1, colour: 0.3, hard: 0.95, exc: 0, velSens: 0.4 },
    { roles: [RM, PC], tags: { playful: 0.7, bright: 0.8, organic: 0.7 } });
  def(57, 'cowbell', 'Cowbell', 'modal', { set: 13, t60: 0.5, tilt: 0.1, colour: 0, hard: 0.9, exc: 0, velSens: 0.5 },
    { roles: [PC, RM], tags: { playful: 0.7, fierce: 0.4, bright: 0.5 } });
  def(58, 'tambourine', 'Tambourine', 'modal', { set: 14, t60: 0.6, tilt: 0, colour: 0.4, hard: 0.9, exc: 1, excLen: 0.1, spread: 0.5, noise: 0.5, velSens: 0.7 },
    { roles: [SH, PC], tags: { playful: 0.8, bright: 0.8, organic: 0.8 } });
  def(59, 'triangle', 'Triangle', 'modal', { set: 14, t60: 3, tilt: 0, colour: 0.3, hard: 0.97, exc: 0, spread: 0.5, velSens: 0.4 },
    { roles: [SH, PC, B], tags: { bright: 0.9, playful: 0.6, sacred: 0.3 } });
  def(60, 'cabasa', 'Cabasa', 'modal', { set: 8, t60: 0.2, tilt: 0, colour: 0.3, hard: 0.8, exc: 3, excLen: 0.25, trem: 30, spread: 0.4, velSens: 0.6 },
    { roles: [SH], tags: { organic: 0.9, playful: 0.5, warm: 0.4 } });
  def(61, 'log-drum', 'Log drum', 'modal', { set: 17, t60: 0.42, tilt: 0.2, colour: 0, hard: 0.6, exc: 0, bend: 1.08, bendT: 0.03, velSens: 0.6 },
    { roles: [TM, PC], tags: { organic: 0.9, warm: 0.7, sacred: 0.3, playful: 0.3 } });
  def(62, 'anvil', 'Anvil', 'modal', { set: 23, t60: 1.3, tilt: 0.1, colour: 0.3, hard: 0.92, exc: 0, spread: 0.3, velSens: 0.6 },
    { roles: [PC, B, RM], tags: { fierce: 0.9, eerie: 0.3, bright: 0.5 } });
  def(63, 'djembe', 'Djembe', 'modal', { set: 10, t60: 0.3, tilt: 0.2, colour: 0.2, hard: 0.72, exc: 0, bend: 1.12, bendT: 0.035, spread: 0.25, noise: 0.35, velSens: 0.75 },
    { roles: [TM, PC], tags: { organic: 0.95, fierce: 0.3, playful: 0.4, warm: 0.5 } });
  def(64, 'bongo', 'Bongos', 'modal', { set: 12, t60: 0.22, tilt: 0.2, colour: 0.3, hard: 0.92, exc: 0, bend: 1.05, bendT: 0.03, spread: 0.2, noise: 0.2, velSens: 0.7 },
    { roles: [TM, PC], tags: { organic: 0.8, playful: 0.7, bright: 0.6 } });
  def(65, 'snap', 'Finger snap', 'modal', { set: 8, t60: 0.09, tilt: 0, colour: 0.5, hard: 0.97, exc: 0, noise: 0.7, velSens: 0.4 },
    { roles: [RM, PC, SH], tags: { playful: 0.6, warm: 0.4, organic: 0.5 } });
  def(66, 'guiro', 'Guiro', 'modal', { set: 8, t60: 0.15, tilt: 0, colour: 0.4, hard: 0.85, exc: 3, excLen: 0.4, trem: 22, spread: 0.3, velSens: 0.6 },
    { roles: [SH, PC], tags: { playful: 0.8, organic: 0.8, warm: 0.3 } });
  def(67, 'rainstick', 'Rainstick', 'modal', { set: 14, t60: 0.9, tilt: 0, colour: 0.3, hard: 0.8, exc: 1, excLen: 0.9, spread: 0.8, noise: 0.4, velSens: 0.4 },
    { roles: [SH, PC], tags: { dreamy: 0.8, organic: 0.9, eerie: 0.2, sacred: 0.3 } });
  def(68, 'udu', 'Udu', 'modal', { set: 17, t60: 0.55, tilt: 0.2, colour: -0.2, hard: 0.55, exc: 0, bend: 1.2, bendT: 0.05, spread: 0.3, noise: 0.15, velSens: 0.7 },
    { roles: [TM, PC], tags: { organic: 0.9, eerie: 0.4, warm: 0.5, sacred: 0.3 } });

  /* ── ANALOG: oscillators and filters ── */
  def(70, 'supersaw', 'Supersaw', 'analog', { wave: 0, voices: 7, detune: 26, spread: 0.9, cut: 5, q: 1, fenv: 3, fdec: 0.6, atk: 0.01, dec: 0.3, sus: 0.85, rel: 0.3, sub: 0.1, drift: 4 },
    { roles: [L, A, H, AR, CP], tags: { bright: 0.8, fierce: 0.5, dreamy: 0.4 } });
  def(71, 'supersaw-pad', 'Supersaw pad', 'analog', { wave: 0, voices: 5, detune: 20, spread: 0.9, cut: 3, q: 0.9, fenv: 1.5, fdec: 2, atk: 1.1, dec: 0.5, sus: 0.9, rel: 0.8, sub: 0.1, drift: 5 },
    { roles: [PD, H], tags: { bright: 0.6, dreamy: 0.8, warm: 0.4 } });
  def(72, 'pwm-strings', 'PWM strings', 'analog', { wave: 1, voices: 3, detune: 9, spread: 0.6, pw: 0.36, pwm: 0.7, pwmHz: 0.5, cut: 4, q: 1, fenv: 1.2, fdec: 1.5, atk: 0.4, dec: 0.3, sus: 0.85, rel: 0.5, sub: 0, drift: 4 },
    { roles: [PD, L, A, H, AR], tags: { dreamy: 0.8, warm: 0.6, bright: 0.5 } });
  def(73, 'reese', 'Reese bass', 'analog', { wave: 0, voices: 3, detune: 22, spread: 0.3, cut: 2.3, q: 1.5, fenv: 1, fdec: 0.4, atk: 0.01, dec: 0.3, sus: 0.9, rel: 0.15, sub: 0.5, drive: 0.3, drift: 6 },
    { roles: [BS], tags: { fierce: 0.8, eerie: 0.5 } });
  def(74, 'acid', 'Acid bass', 'analog', { wave: 0, voices: 1, cut: 1.6, q: 7, fenv: 8, fdec: 0.2, atk: 0.002, dec: 0.2, sus: 0.25, rel: 0.09, sub: 0.2, drive: 0.6 },
    { roles: [BS, L, AR], tags: { fierce: 0.8, playful: 0.4, bright: 0.5 } });
  def(75, 'sync-lead', 'Sync lead', 'analog', { wave: 3, voices: 1, cut: 10, q: 1, fenv: 5, fdec: 0.4, atk: 0.005, dec: 0.3, sus: 0.7, rel: 0.2, sync: 3, drive: 0.2, vib: 12, vibHz: 5.4 },
    { roles: [L, A], tags: { fierce: 0.7, bright: 0.8 } });
  def(76, 'brass', 'Brass', 'analog', { wave: 0, voices: 3, detune: 10, spread: 0.5, cut: 1.6, q: 0.9, fenv: 5, fdec: 0.38, atk: 0.06, dec: 0.3, sus: 0.85, rel: 0.14, sub: 0, drift: 3, vib: 9, vibHz: 5 },
    { roles: [L, A, H, CP, PD], tags: { fierce: 0.7, warm: 0.6, bright: 0.6, sacred: 0.3 } });
  def(77, 'analog-pluck', 'Analog pluck', 'analog', { wave: 0, voices: 2, detune: 10, spread: 0.5, cut: 2, q: 1.2, fenv: 8, fdec: 0.22, atk: 0.002, dec: 0.2, sus: 0, rel: 0.15, sub: 0.1 },
    { roles: [AR, L, A, CP], tags: { bright: 0.6, playful: 0.5, fierce: 0.3 } });
  def(78, 'sub', 'Sub bass', 'analog', { wave: 2, voices: 1, cut: 2.2, q: 0.7, fenv: 0, fdec: 0.3, atk: 0.005, dec: 0.3, sus: 1, rel: 0.12, sub: 0.75, drive: 0.15 },
    { roles: [BS], tags: { fierce: 0.3, eerie: 0.4, warm: 0.4 } });
  def(79, 'warm-pad', 'Warm pad', 'analog', { wave: 0, voices: 3, detune: 11, spread: 0.7, cut: 2.2, q: 0.8, fenv: 0.8, fdec: 2.2, atk: 0.9, dec: 0.5, sus: 0.9, rel: 0.9, sub: 0.15, drift: 5 },
    { roles: [PD, H], tags: { warm: 0.9, dreamy: 0.7, organic: 0.3 } });
  def(80, 'dark-drone', 'Dark drone', 'analog', { wave: 0, voices: 5, detune: 14, spread: 0.8, cut: 1.5, q: 1, fenv: 0.5, fdec: 4, atk: 2, dec: 1, sus: 1, rel: 2, sub: 0.6, drift: 8 },
    { roles: [DR, PD], tags: { eerie: 0.8, warm: 0.3, fierce: 0.3, sacred: 0.3 } });
  def(81, 'square', 'Square lead', 'analog', { wave: 1, voices: 1, pw: 0.5, cut: 12, q: 0.7, fenv: 1, fdec: 0.3, atk: 0.003, dec: 0.3, sus: 0.9, rel: 0.1, vib: 8, vibHz: 5.5 },
    { roles: [L, A, AR, CP], tags: { playful: 0.8, bright: 0.8 } });
  def(82, 'bowed-strings', 'Bowed strings', 'analog', { wave: 0, voices: 4, detune: 9, spread: 0.7, cut: 2.8, q: 0.9, fenv: 1.5, fdec: 0.8, atk: 0.22, dec: 0.4, sus: 0.9, rel: 0.26, sub: 0, noise: 0.03, drift: 4, vib: 18, vibHz: 5.2 },
    { roles: [L, A, H, PD], tags: { warm: 0.8, organic: 0.7, sacred: 0.4, eerie: 0.3 } });
  def(83, 'saw-bass', 'Saw bass', 'analog', { wave: 0, voices: 2, detune: 8, spread: 0.2, cut: 2.6, q: 1.1, fenv: 3, fdec: 0.25, atk: 0.004, dec: 0.25, sus: 0.6, rel: 0.1, sub: 0.4, drive: 0.2 },
    { roles: [BS], tags: { bright: 0.4, fierce: 0.5, playful: 0.3 } });
  def(84, 'moog-bass', 'Moog bass', 'analog', { wave: 4, voices: 1, cut: 1.9, q: 3.2, fenv: 4, fdec: 0.26, atk: 0.003, dec: 0.25, sus: 0.55, rel: 0.1, sub: 0.3, drive: 0.25 },
    { roles: [BS], tags: { warm: 0.55, fierce: 0.4, playful: 0.5 } });
  def(85, 'bowed-bass', 'Bowed bass', 'analog', { wave: 0, voices: 2, detune: 6, spread: 0.3, cut: 1.4, q: 0.8, fenv: 1, fdec: 1, atk: 0.13, dec: 0.3, sus: 0.9, rel: 0.22, sub: 0.3, noise: 0.04, drift: 3, vib: 10, vibHz: 4.8 },
    { roles: [BS], tags: { warm: 0.8, organic: 0.7, eerie: 0.3, sacred: 0.3 } });
  def(86, 'theremin', 'Theremin', 'analog', { wave: 2, voices: 1, cut: 8, q: 0.5, fenv: 0, fdec: 0.3, atk: 0.1, dec: 0.3, sus: 1, rel: 0.25, vib: 45, vibHz: 5.6, drift: 6 },
    { roles: [L, A], tags: { eerie: 0.9, dreamy: 0.5, playful: 0.4 } });
  def(87, 'tape-strings', 'Tape strings', 'analog', { wave: 0, voices: 4, detune: 24, spread: 0.8, cut: 2.1, q: 0.7, fenv: 0.6, fdec: 2, atk: 0.6, dec: 0.5, sus: 0.9, rel: 0.7, sub: 0, noise: 0.05, drift: 16, vib: 6, vibHz: 0.6 },
    { roles: [PD, H, L], tags: { dreamy: 0.9, warm: 0.7, eerie: 0.3 } });
  def(88, 'pulse-lead', 'Pulse lead', 'analog', { wave: 1, voices: 2, detune: 12, spread: 0.5, pw: 0.3, pwm: 0.5, pwmHz: 3, cut: 6, q: 1, fenv: 2, fdec: 0.5, atk: 0.01, dec: 0.3, sus: 0.8, rel: 0.2, vib: 10, vibHz: 5.2 },
    { roles: [L, A, AR, CP], tags: { bright: 0.7, playful: 0.5, fierce: 0.3 } });

  /* ── ORGAN ── */
  def(90, 'tonewheel', 'Tonewheel organ', 'organ', { d16: 0.8, d513: 0.35, d8: 0.8, d4: 0.55, d223: 0, d2: 0.3, d135: 0, d113: 0, d1: 0.2, perc: 0.5, percH: 3, percDec: 0.22, click: 0.3, leslie: 0.5, leslieHz: 6, drive: 0.25, atk: 0.005, rel: 0.08, drift: 3 },
    { roles: [CP, L, A, PD, H], tags: { warm: 0.8, organic: 0.5, sacred: 0.4, playful: 0.3 } });
  def(91, 'jazz-organ', 'Jazz organ', 'organ', { d16: 0.9, d513: 0.1, d8: 0.9, d4: 0.3, d223: 0, d2: 0, d135: 0, d113: 0, d1: 0, perc: 0.7, percH: 3, percDec: 0.3, click: 0.25, leslie: 0.4, leslieHz: 0.9, drive: 0.2, atk: 0.005, rel: 0.09, drift: 2 },
    { roles: [L, A, CP, BS], tags: { warm: 0.9, playful: 0.4, organic: 0.4 } });
  def(92, 'gospel-organ', 'Full organ', 'organ', { d16: 0.9, d513: 0.8, d8: 1, d4: 0.9, d223: 0.7, d2: 0.7, d135: 0.5, d113: 0.5, d1: 0.6, perc: 0.4, percH: 2, percDec: 0.18, click: 0.3, leslie: 0.7, leslieHz: 6.5, drive: 0.4, atk: 0.006, rel: 0.1, drift: 3 },
    { roles: [CP, PD, L], tags: { sacred: 0.7, warm: 0.8, fierce: 0.3 } });
  def(93, 'pipe-organ', 'Pipe organ', 'organ', { d16: 0.3, d513: 0, d8: 0.95, d4: 0.55, d223: 0.1, d2: 0.3, d135: 0, d113: 0.1, d1: 0.1, perc: 0, click: 0, chiff: 0.35, leslie: 0, atk: 0.06, rel: 0.35, drift: 2, vib: 2 },
    { roles: [PD, CP, L, DR, A], tags: { sacred: 0.95, warm: 0.5, eerie: 0.3 } });
  def(94, 'harmonium', 'Harmonium', 'organ', { d16: 0.2, d513: 0, d8: 0.9, d4: 0.7, d223: 0, d2: 0.4, d135: 0, d113: 0, d1: 0, perc: 0, click: 0, chiff: 0.1, leslie: 0, drive: 0.18, reed: 0.8, atk: 0.04, rel: 0.12, drift: 4, vib: 4 },
    { roles: [PD, CP, L, A, H, DR], tags: { warm: 0.9, organic: 0.8, sacred: 0.6, eerie: 0.3 } });
  def(95, 'flute-stop', 'Flute stop', 'organ', { d16: 0, d513: 0, d8: 1, d4: 0.3, d223: 0, d2: 0, d135: 0, d113: 0, d1: 0, perc: 0, click: 0, chiff: 0.3, leslie: 0.2, leslieHz: 5, atk: 0.05, rel: 0.2, drift: 2, vib: 3 },
    { roles: [L, A, AR], tags: { sacred: 0.6, dreamy: 0.6, warm: 0.5 } });
  def(96, 'pedal-bass', 'Pedal bass', 'organ', { d16: 1, d513: 0.2, d8: 0.65, d4: 0.1, d223: 0, d2: 0, d135: 0, d113: 0, d1: 0, perc: 0, click: 0.2, chiff: 0.1, leslie: 0, atk: 0.02, rel: 0.25, drift: 1 },
    { roles: [BS], tags: { sacred: 0.7, warm: 0.5, fierce: 0.2 } });
  def(97, 'accordion', 'Accordion', 'organ', { d16: 0, d513: 0, d8: 0.9, d4: 0.8, d223: 0, d2: 0.3, d135: 0, d113: 0, d1: 0, perc: 0, click: 0, chiff: 0.05, leslie: 0, drive: 0.12, reed: 0.9, atk: 0.03, rel: 0.08, drift: 5, vib: 6 },
    { roles: [L, A, CP, PD, H], tags: { warm: 0.8, organic: 0.9, playful: 0.6, sacred: 0.2 } });
  def(98, 'farfisa', 'Combo organ', 'organ', { d16: 0, d513: 0, d8: 0.9, d4: 0.6, d223: 0, d2: 0.5, d135: 0, d113: 0, d1: 0.4, perc: 0.3, percH: 4, percDec: 0.12, click: 0.2, leslie: 0.3, leslieHz: 6, drive: 0.35, atk: 0.004, rel: 0.07, drift: 4, vib: 6 },
    { roles: [L, A, CP], tags: { playful: 0.8, bright: 0.6, warm: 0.4 } });

  /* ── DX: operators ── */
  def(100, 'epiano', 'Electric piano', 'dx', { alg: 2, fb: 0.05, r1: 1, r2: 1, r3: 1, r4: 14, l1: 0.85, l2: 0.9, l3: 0.32, l4: 0.5, dec1: 1.8, dec2: 1.2, dec3: 0.9, dec4: 0.06, sus1: 0.12, sus2: 0.15, sus3: 0.1, sus4: 0, vel: 0.75, atk: 0.002, open: 0.6, rel: 0.3 },
    { roles: [L, A, CP, AR, H], tags: { warm: 0.9, dreamy: 0.7, playful: 0.3 } });
  def(101, 'clav', 'Clavinet', 'dx', { alg: 3, fb: 0.3, r1: 1, r2: 1, r3: 3, r4: 7, l1: 0.9, l2: 0.4, l3: 0.3, l4: 0.25, dec1: 0.3, dec2: 0.08, dec3: 0.05, dec4: 0.03, sus1: 0, sus2: 0, sus3: 0, sus4: 0, vel: 0.85, atk: 0.002, open: 0.5, rel: 0.06 },
    { roles: [CP, AR, L, BS], tags: { playful: 0.7, fierce: 0.5, bright: 0.7 } });
  def(102, 'fm-bell', 'FM bell', 'dx', { alg: 4, fb: 0.1, r1: 1, r2: 3.5, r3: 1.41, r4: 7.07, l1: 0.8, l2: 0.45, l3: 0.2, l4: 0.15, dec1: 3.5, dec2: 1.5, dec3: 1.1, dec4: 0.5, sus1: 0, sus2: 0, sus3: 0, sus4: 0, vel: 0.6, atk: 0.002, open: 0.7, rel: 1.2 },
    { roles: [B, L, A, AR, CP], tags: { bright: 0.8, eerie: 0.4, dreamy: 0.5, sacred: 0.4 } });
  def(103, 'fm-bass', 'FM bass', 'dx', { alg: 0, fb: 0.2, r1: 1, r2: 1, r3: 0.5, r4: 1, l1: 0.9, l2: 0.7, l3: 0.25, l4: 0.12, dec1: 0.8, dec2: 0.2, dec3: 0.1, dec4: 0.1, sus1: 0.6, sus2: 0.15, sus3: 0.1, sus4: 0.1, vel: 0.6, atk: 0.002, open: 0.5, rel: 0.1 },
    { roles: [BS], tags: { bright: 0.4, fierce: 0.5, playful: 0.4 } });
  def(104, 'fm-marimba', 'FM marimba', 'dx', { alg: 2, fb: 0, r1: 1, r2: 4, r3: 1, r4: 10, l1: 0.75, l2: 0.5, l3: 0.22, l4: 0.25, dec1: 0.7, dec2: 0.1, dec3: 0.4, dec4: 0.04, sus1: 0, sus2: 0, sus3: 0, sus4: 0, vel: 0.7, atk: 0.002, open: 0.6, rel: 0.15 },
    { roles: [L, A, AR, CP], tags: { playful: 0.7, warm: 0.5, bright: 0.6 } });
  def(105, 'glass-pad-fm', 'Glass pad', 'dx', { alg: 6, fb: 0.1, r1: 1, r2: 2.01, r3: 3.005, r4: 1, l1: 0.45, l2: 0.3, l3: 0.3, l4: 0.6, dec1: 6, dec2: 6, dec3: 6, dec4: 6, sus1: 1, sus2: 0.9, sus3: 0.8, sus4: 0.8, vel: 0.3, atk: 0.9, open: 0.5, rel: 1.1 },
    { roles: [PD, H, DR], tags: { dreamy: 0.9, eerie: 0.5, bright: 0.6 } });
  def(106, 'tine', 'Tine bar', 'dx', { alg: 1, fb: 0, r1: 1, r2: 7, r3: 1, r4: 1, l1: 0.8, l2: 0.3, l3: 0.1, l4: 0.15, dec1: 2.5, dec2: 0.08, dec3: 1, dec4: 1, sus1: 0, sus2: 0, sus3: 0, sus4: 0, vel: 0.6, atk: 0.002, open: 0.5, rel: 0.5 },
    { roles: [B, AR, L, CP], tags: { bright: 0.7, dreamy: 0.7, playful: 0.4 } });
  def(107, 'dx-brass', 'FM brass', 'dx', { alg: 0, fb: 0.15, r1: 1, r2: 1, r3: 1, r4: 1, l1: 0.9, l2: 0.55, l3: 0.3, l4: 0.15, dec1: 2, dec2: 0.6, dec3: 0.6, dec4: 0.5, sus1: 0.9, sus2: 0.6, sus3: 0.5, sus4: 0.4, vel: 0.6, atk: 0.05, open: 0.8, rel: 0.14 },
    { roles: [L, A, H, CP], tags: { fierce: 0.6, bright: 0.6, warm: 0.4 } });
  def(108, 'dx-harp', 'FM harp', 'dx', { alg: 2, fb: 0, r1: 1, r2: 2, r3: 1, r4: 9, l1: 0.8, l2: 0.4, l3: 0.25, l4: 0.2, dec1: 2.2, dec2: 0.3, dec3: 0.9, dec4: 0.04, sus1: 0, sus2: 0, sus3: 0, sus4: 0, vel: 0.7, atk: 0.002, open: 0.6, rel: 0.4 },
    { roles: [L, A, AR, CP, B], tags: { dreamy: 0.7, bright: 0.5, warm: 0.5, playful: 0.4 } });

  /* ── BREATH: blown ── */
  def(110, 'flute', 'Flute', 'breath', { air: 0.5, band: 2, tilt: 1.6, even: 0.7, vib: 18, vibHz: 5, vibDelay: 0.25, atk: 0.06, rel: 0.12, chiff: 0.5, scoop: 1, scoopT: 0.07, over: 0.4, formant: 1200, formantQ: 0.3, jitter: 5, flutter: 0.3 },
    { roles: [L, A, AR, H], tags: { warm: 0.6, organic: 0.9, dreamy: 0.7, bright: 0.5, sacred: 0.4 } });
  def(111, 'shakuhachi', 'Shakuhachi', 'breath', { air: 1, band: 1.5, tilt: 2, even: 0.5, vib: 28, vibHz: 5, vibDelay: 0.15, atk: 0.12, rel: 0.25, chiff: 0.8, scoop: 2, scoopT: 0.12, over: 0.8, formant: 1500, formantQ: 0.4, jitter: 10, flutter: 0.5 },
    { roles: [L, A], tags: { sacred: 0.8, eerie: 0.6, organic: 0.9, dreamy: 0.5 } });
  def(112, 'clarinet', 'Clarinet', 'breath', { air: 0.25, band: 3, tilt: 1, even: 0, vib: 12, vibHz: 5, vibDelay: 0.3, atk: 0.04, rel: 0.08, chiff: 0.3, scoop: 0, scoopT: 0.02, over: 0.2, formant: 900, formantQ: 0.5, jitter: 3, flutter: 0.1 },
    { roles: [L, A, H, AR], tags: { warm: 0.8, organic: 0.9, playful: 0.4 } });
  def(113, 'pan-flute', 'Pan flute', 'breath', { air: 0.9, band: 2, tilt: 2.2, even: 0.4, vib: 10, vibHz: 4.8, vibDelay: 0.35, atk: 0.07, rel: 0.15, chiff: 0.7, scoop: 0.6, scoopT: 0.05, over: 0.2, formant: 1400, formantQ: 0.3, jitter: 8, flutter: 0.4 },
    { roles: [L, A, AR], tags: { organic: 0.95, dreamy: 0.7, warm: 0.6, eerie: 0.3 } });
  def(114, 'ocarina', 'Ocarina', 'breath', { air: 0.12, band: 2, tilt: 3.6, even: 0.3, vib: 8, vibHz: 5.2, vibDelay: 0.2, atk: 0.05, rel: 0.1, chiff: 0.1, scoop: 0.3, scoopT: 0.04, over: 0, formant: 0, formantQ: 0, jitter: 4, flutter: 0.1 },
    { roles: [L, A, AR, B], tags: { playful: 0.7, dreamy: 0.8, organic: 0.8, warm: 0.5 } });
  def(115, 'horn', 'Horn', 'breath', { air: 0.2, band: 2, tilt: 1.3, even: 0.8, vib: 10, vibHz: 5, vibDelay: 0.4, atk: 0.14, rel: 0.2, chiff: 0.1, scoop: 0.5, scoopT: 0.08, over: 0.3, formant: 700, formantQ: 0.6, jitter: 4, flutter: 0.1, edge: 0.25 },
    { roles: [H, L, A, PD], tags: { warm: 0.9, sacred: 0.7, organic: 0.7, fierce: 0.3 } });
  def(116, 'sax', 'Saxophone', 'breath', { air: 0.3, band: 2.5, tilt: 1, even: 0.85, vib: 22, vibHz: 5.5, vibDelay: 0.25, atk: 0.05, rel: 0.1, chiff: 0.25, scoop: 1.2, scoopT: 0.06, over: 0.5, formant: 1100, formantQ: 0.6, jitter: 6, flutter: 0.2, drive: 0.5, edge: 0.55 },
    { roles: [L, A], tags: { warm: 0.8, fierce: 0.5, organic: 0.8, playful: 0.3 } });
  def(117, 'whistle', 'Whistle', 'breath', { air: 0.1, band: 2, tilt: 4, even: 0.1, vib: 14, vibHz: 5.8, vibDelay: 0.3, atk: 0.04, rel: 0.08, chiff: 0.05, scoop: 1, scoopT: 0.06, over: 0, jitter: 6, flutter: 0.05 },
    { roles: [L, A, B], tags: { playful: 0.8, bright: 0.9, organic: 0.6 } });
  def(118, 'tuba', 'Tuba', 'breath', { air: 0.15, band: 1.5, tilt: 0.9, even: 0.8, vib: 6, vibHz: 4.6, vibDelay: 0.5, atk: 0.1, rel: 0.18, chiff: 0.1, scoop: 0.4, scoopT: 0.08, over: 0.1, formant: 350, formantQ: 0.6, jitter: 3, flutter: 0.05, edge: 0.3 },
    { roles: [BS, H], tags: { warm: 0.8, organic: 0.8, sacred: 0.4, playful: 0.3 } });
  def(119, 'oboe', 'Oboe', 'breath', { air: 0.2, band: 3.5, tilt: 0.7, even: 0.2, vib: 14, vibHz: 5.2, vibDelay: 0.3, atk: 0.05, rel: 0.1, chiff: 0.2, scoop: 0.3, scoopT: 0.04, over: 0.2, formant: 1400, formantQ: 0.8, jitter: 4, flutter: 0.1, edge: 0.3 },
    { roles: [L, A, H], tags: { organic: 0.9, eerie: 0.3, sacred: 0.3, dreamy: 0.4, warm: 0.5 } });
  def(140, 'trumpet', 'Trumpet', 'breath', { air: 0.12, band: 2.5, tilt: 0.55, even: 0.5, vib: 12, vibHz: 5.4, vibDelay: 0.4, atk: 0.035, rel: 0.08, chiff: 0.25, scoop: 0.8, scoopT: 0.05, over: 0.4, formant: 1200, formantQ: 0.7, jitter: 3, flutter: 0.05, edge: 0.75 },
    { roles: [L, A, H], tags: { bright: 0.7, fierce: 0.6, sacred: 0.4, warm: 0.3 } });
  def(141, 'recorder', 'Recorder', 'breath', { air: 0.35, band: 2, tilt: 3, even: 0.1, vib: 5, vibHz: 5, vibDelay: 0.5, atk: 0.05, rel: 0.1, chiff: 0.4, scoop: 0.4, scoopT: 0.05, over: 0.1, formant: 0, formantQ: 0, jitter: 5, flutter: 0.2 },
    { roles: [L, A, AR], tags: { playful: 0.7, organic: 0.9, bright: 0.6, warm: 0.4 } });
  def(142, 'ooh-choir', 'Choir · ooh', 'breath', { air: 0.08, band: 2, tilt: 2.2, even: 0.5, vib: 16, vibHz: 5.4, vibDelay: 0.5, atk: 0.3, rel: 0.45, chiff: 0, scoop: 0.3, scoopT: 0.12, over: 0, formant: 450, formantQ: 0.9, jitter: 7, flutter: 0.05, edge: 0.08 },
    { roles: [H, PD, L, A], tags: { sacred: 0.85, warm: 0.7, dreamy: 0.65, eerie: 0.3, organic: 0.6 } });
  def(143, 'aah-choir', 'Choir · aah', 'breath', { air: 0.12, band: 2, tilt: 1.5, even: 0.7, vib: 18, vibHz: 5.6, vibDelay: 0.45, atk: 0.22, rel: 0.4, chiff: 0.05, scoop: 0.4, scoopT: 0.1, over: 0, formant: 820, formantQ: 0.8, jitter: 7, flutter: 0.05, edge: 0.15 },
    { roles: [H, PD, L], tags: { sacred: 0.75, warm: 0.6, bright: 0.4, organic: 0.6 } });

  /* ── FOLD: west coast ── */
  def(120, 'ping', 'Fold ping', 'fold', { ratio: 1, modR: 2.01, index: 0.8, fold: 4, asym: 0.2, lpg: 0.6, base: 1.5, amt: 6, mode: 0, atk: 0.002, rel: 0.2, sub: 0.2, zap: 0.3, second: 0, lvl2: 0, idxDec: 0.3 },
    { roles: [AR, L, A, B], tags: { bright: 0.7, playful: 0.6, eerie: 0.3, dreamy: 0.4 } });
  def(121, 'buchla-lead', 'Buchla lead', 'fold', { ratio: 1, modR: 1, index: 0.4, fold: 3, asym: 0, lpg: 1, base: 2, amt: 4, mode: 1, atk: 0.02, rel: 0.3, sub: 0.1, zap: 0, second: 0, idxDec: 1 },
    { roles: [L, A], tags: { eerie: 0.6, bright: 0.6, fierce: 0.4, playful: 0.4 } });
  def(122, 'zap', 'Zap', 'fold', { ratio: 1, modR: 1.5, index: 1.5, fold: 5, asym: 0.3, lpg: 0.12, base: 4, amt: 8, mode: 0, atk: 0.001, rel: 0.1, sub: 0.3, zap: 0.6, second: 0, idxDec: 0.05 },
    { roles: [PC, TM, RM], tags: { fierce: 0.6, bright: 0.7, playful: 0.4 } });
  def(123, 'fold-bass', 'Fold bass', 'fold', { ratio: 1, modR: 1, index: 0.3, fold: 3, asym: 0.2, lpg: 0.5, base: 1, amt: 3, mode: 1, atk: 0.004, rel: 0.12, sub: 0.6, zap: 0, second: 0, idxDec: 0.5 },
    { roles: [BS], tags: { fierce: 0.5, eerie: 0.4 } });
  def(124, 'metal-bell', 'Metal bell', 'fold', { ratio: 1, modR: 1.414, index: 0.45, fold: 2.2, asym: 0, lpg: 0.9, base: 1.3, amt: 2.6, mode: 0, atk: 0.001, rel: 0.3, sub: 0, zap: 0.05, second: 2.76, lvl2: 0.35, idxDec: 0.35 },
    { roles: [B, L, AR], tags: { bright: 0.8, eerie: 0.6, fierce: 0.3, sacred: 0.3 } });

  /* ── CLOUD: grains ── */
  def(130, 'shimmer', 'Shimmer', 'cloud', { src: 0, rate: 45, len: 0.22, jitter: 6, oct: 0.3, fifth: 0.15, spread: 0.8, atk: 1, rel: 1.2, wander: 0.5, rnd: 0.3, soft: 0.2 },
    { roles: [PD, H, DR, L], tags: { dreamy: 0.95, bright: 0.6, sacred: 0.4, eerie: 0.3 } });
  def(131, 'swarm', 'Swarm', 'cloud', { src: 2, rate: 28, len: 0.12, jitter: 40, oct: 0.1, fifth: 0.05, spread: 1, atk: 0.15, rel: 0.4, wander: 0.3, rnd: 0.4, soft: 0 },
    { roles: [AR, L, A, PD], tags: { eerie: 0.7, fierce: 0.4, dreamy: 0.4, organic: 0.3 } });
  def(132, 'glass-rain', 'Glass rain', 'cloud', { src: 3, rate: 16, len: 0.09, jitter: 160, oct: 0.2, fifth: 0.1, spread: 1, atk: 0.03, rel: 0.3, wander: 0.3, rnd: 0.5, soft: 0 },
    { roles: [AR, B, PD, L], tags: { bright: 0.8, dreamy: 0.8, playful: 0.4, eerie: 0.3 } });
  def(133, 'fog', 'Fog', 'cloud', { src: 1, rate: 30, len: 0.42, jitter: 4, oct: 0.05, fifth: 0.05, spread: 1, atk: 1.6, rel: 2, wander: 0.6, rnd: 0.2, soft: 0.6 },
    { roles: [DR, PD, H], tags: { dreamy: 0.9, eerie: 0.7, warm: 0.4, sacred: 0.3 } });

  /** Some instruments play a part a second time, in a world that wants them there. */
  const also = (key, ...roles) => { const d = BY_KEY.get(key); for (const r of roles) if (!d.roles.includes(r)) d.roles.push(r); };
  also('crotales', A); also('acid', A); also('pipe-organ', H); also('tamtam', PC); also('woodblock', TM);
  also('gender', H); also('square', H);
  /**
   * The General MIDI program (0-based) nearest each instrument, for a score (M1): a MIDI file of a song played by a harp says Harp, not Celesta.
   * Instruments that have none here (the cube's own) use the exporter's own.
   */
  const GM = {
    harp: 46, nylon: 24, steel: 25, koto: 107, sitar: 104, banjo: 105, upright: 32, fretless: 35, harpsichord: 6, oud: 24, 'felt-piano': 1, tanpura: 104, 'glass-pluck': 98,
    mandolin: 25, dulcimer: 15, pizzicato: 45, lute: 24, marimba: 12, vibes: 11, glockenspiel: 9, tubular: 14, bowl: 108, gender: 14, steelpan: 114, kalimba: 108,
    'music-box': 10, crotales: 98, 'glass-harmonica': 92, tamtam: 47, handpan: 114, chimes: 112, 'bowl-struck': 14, xylophone: 13, celesta: 8, handbell: 14, 'bass-marimba': 12,
    supersaw: 81, 'supersaw-pad': 90, 'pwm-strings': 50, reese: 38, acid: 87, 'sync-lead': 84, brass: 61, 'analog-pluck': 84, sub: 39, 'warm-pad': 89, 'dark-drone': 95,
    square: 80, 'bowed-strings': 49, 'saw-bass': 38, 'moog-bass': 38, 'bowed-bass': 43, theremin: 54, 'tape-strings': 48, 'pulse-lead': 80,
    tonewheel: 16, 'jazz-organ': 17, 'gospel-organ': 18, 'pipe-organ': 19, harmonium: 20, 'flute-stop': 73, 'pedal-bass': 19, accordion: 21, farfisa: 16,
    epiano: 4, clav: 7, 'fm-bell': 98, 'fm-bass': 39, 'fm-marimba': 12, 'glass-pad-fm': 92, tine: 10, 'dx-brass': 62, 'dx-harp': 46,
    flute: 73, shakuhachi: 77, clarinet: 71, 'pan-flute': 75, ocarina: 79, horn: 60, sax: 65, whistle: 78, tuba: 58, oboe: 68, trumpet: 56, recorder: 74,
    ping: 98, 'buchla-lead': 85, 'fold-bass': 39, 'metal-bell': 14, 'ooh-choir': 53, 'aah-choir': 52, shimmer: 94, swarm: 99, 'glass-rain': 96, fog: 95,
  };
  /** The range an instrument can play (MIDI); a note outside it is put in it by octaves. */
  const range = (key, lo, hi) => { BY_KEY.get(key).range = [lo, hi]; };
  range('upright', 28, 55); range('fretless', 28, 62); range('pedal-bass', 24, 50); range('harpsichord', 40, 90);
  range('flute', 60, 96); range('shakuhachi', 55, 88); range('clarinet', 50, 90); range('pan-flute', 58, 96); range('ocarina', 60, 90);
  range('horn', 41, 77); range('sax', 47, 82); range('whistle', 72, 100); range('koto', 48, 88); range('sitar', 45, 84);
  range('banjo', 50, 86); range('ooh-choir', 48, 84); range('aah-choir', 48, 84); range('tuba', 28, 58); range('oboe', 58, 91); range('trumpet', 55, 86); range('recorder', 60, 93); range('theremin', 48, 96); range('bass-marimba', 28, 55); range('moog-bass', 28, 60); range('bowed-bass', 28, 55); range('mandolin', 55, 91); range('lute', 43, 84); range('dulcimer', 48, 91); range('xylophone', 58, 96); range('celesta', 60, 100); range('handbell', 60, 96); range('tubular', 55, 90); range('glass-harmonica', 55, 96); range('flute-stop', 60, 96);

  /* ── §5j.3 THE WORLDS ──────────────────────────────────────────────────── */

  /**
   * A world: who is in the room, and the room. Each role lists the instruments that may play it (by key; the first
   * is the likeliest). `hall`: { size ×, damp + } of the reverb the song is heard in; `space` how much of it; `finish`: how the world colours the
   * mix, as offsets on the patch's own knobs (chorus, echo, drive, grit: added; bits, hold: set): a tape's warmth, an 8-bit crunch, a dream's haze.
   * ⚠ APPEND ONLY: deal() picks a world by position.
   */
  const WORLDS = [];
  function world(id, name, blurb, tags, cast, room = {}) {
    const w = { id, name, blurb, tags, cast, hall: room.hall || null, space: room.space ?? 1, finish: room.finish || null, index: WORLDS.length };
    for (const [role, list] of Object.entries(cast)) for (const k of list) if (!BY_KEY.has(k)) throw new Error(`Palette: world ${id} casts unknown ${k} as ${role}`);
    WORLDS.push(w);
    return w;
  }

  world('cube', 'The Cube', 'The sigil’s own voices, sung as they always were: a wave, a vowel, a bell, a bowed pair.',
    { warm: 0.4, dreamy: 0.4, sacred: 0.4, bright: 0.4 },
    { lead: ['cube-wave', 'cube-vox', 'cube-fm'], alt: ['cube-vox', 'cube-wave'], harm: ['cube-vox'], bell: ['cube-bell'], bass: ['cube-bass'], arp: ['cube-wave', 'cube-bell'],
      pad: ['cube-pad'], drone: ['cube-drone'], comp: ['cube-bell', 'cube-wave'] });
  world('temple', 'Temple', 'Bowls and bells and frame drums in a stone room. Breath, and a long drone under it.',
    { sacred: 0.95, eerie: 0.35, warm: 0.5, organic: 0.65, dreamy: 0.45 },
    { lead: ['shakuhachi', 'bowl-struck', 'harmonium', 'tubular'], alt: ['glass-harmonica', 'shakuhachi', 'horn'], harm: ['ooh-choir', 'cube-vox', 'horn', 'glass-harmonica'], bell: ['bowl-struck', 'tubular', 'crotales', 'tamtam', 'handbell'],
      bass: ['upright', 'sub', 'pedal-bass', 'bowed-bass', 'tuba'], arp: ['handpan', 'kalimba', 'harp'], pad: ['bowl', 'glass-harmonica', 'pipe-organ', 'fog', 'ooh-choir'], drone: ['dark-drone', 'bowl', 'tanpura'],
      comp: ['harmonium', 'harp'], tom: ['frame-drum', 'taiko'], rim: ['woodblock'], shaker: ['rainstick', 'cabasa'], perc: ['frame-drum', 'taiko', 'tabla', 'djembe'] },
    { hall: { size: 1.7, damp: 0.05 }, space: 1.3, finish: { echo: 0.1 } });
  world('glasshouse', 'Glasshouse', 'Everything bright and struck and thin: glass, tines, a wash of shimmer above.',
    { bright: 0.95, dreamy: 0.7, organic: 0.3, sacred: 0.3, playful: 0.4 },
    { lead: ['glockenspiel', 'celesta', 'music-box', 'kalimba', 'flute', 'fm-bell'], alt: ['crotales', 'ocarina', 'vibes', 'theremin'], harm: ['glass-harmonica', 'shimmer'], bell: ['glockenspiel', 'handbell', 'celesta', 'crotales', 'chimes', 'music-box'],
      bass: ['sub', 'fm-bass', 'fretless'], arp: ['kalimba', 'music-box', 'celesta', 'glass-pluck', 'ping'], pad: ['shimmer', 'glass-harmonica', 'glass-pad-fm'], drone: ['fog', 'bowl'],
      comp: ['epiano', 'vibes', 'dx-harp'], tom: ['conga'], rim: ['woodblock', 'clave'], shaker: ['triangle'], perc: ['woodblock', 'tabla'] },
    { hall: { size: 1.3, damp: -0.06 }, space: 1.2, finish: { chorus: 0.15 } });
  world('foundry', 'Foundry', 'Iron and heat: a reese under a sync lead, an anvil for a snare’s echo, a hall that is a shed.',
    { fierce: 0.95, bright: 0.5, eerie: 0.4, organic: 0.1 },
    { lead: ['sync-lead', 'square', 'buchla-lead', 'sax', 'trumpet', 'pulse-lead'], alt: ['brass', 'acid', 'fm-bell'], harm: ['brass', 'bowed-strings', 'dx-brass', 'trumpet'], bell: ['anvil', 'fm-bell', 'metal-bell', 'tubular'],
      bass: ['reese', 'moog-bass', 'acid', 'saw-bass', 'fold-bass'], arp: ['analog-pluck', 'ping', 'clav'], pad: ['supersaw-pad', 'warm-pad', 'brass'], drone: ['dark-drone', 'tamtam'],
      comp: ['clav', 'brass', 'analog-pluck', 'dx-brass'], tom: ['taiko', 'timpani', 'djembe'], rim: ['woodblock', 'cowbell'], shaker: ['cabasa'], perc: ['anvil', 'taiko', 'cowbell', 'zap'] },
    { hall: { size: 0.7, damp: 0.2 }, space: 0.8, finish: { drive: 0.25 } });
  world('meadow', 'Meadow', 'Wood and gut and breath. A nylon string, a flute, a shaker in the grass.',
    { warm: 0.9, organic: 0.95, playful: 0.45, dreamy: 0.3 },
    { lead: ['flute', 'accordion', 'recorder', 'mandolin', 'nylon', 'harp', 'clarinet', 'banjo'], alt: ['clarinet', 'ocarina', 'pan-flute', 'oboe', 'recorder'], harm: ['horn', 'cube-vox', 'harmonium', 'aah-choir'], bell: ['glockenspiel', 'chimes', 'kalimba'],
      bass: ['upright', 'fretless', 'bowed-bass', 'bass-marimba'], arp: ['nylon', 'harp', 'banjo', 'kalimba', 'mandolin', 'pizzicato'], pad: ['harmonium', 'warm-pad', 'bowed-strings', 'accordion'], drone: ['tanpura', 'harmonium'],
      comp: ['nylon', 'steel', 'harp', 'lute', 'mandolin', 'accordion'], tom: ['frame-drum', 'conga'], rim: ['woodblock', 'clave', 'snap'], shaker: ['tambourine', 'guiro', 'cabasa'], perc: ['conga', 'tabla', 'frame-drum', 'djembe', 'bongo'] },
    { hall: { size: 0.9, damp: 0.1 }, space: 0.9 });
  world('neon', 'Neon', 'A supersaw over a gated room, a sync lead, an FM bell, the night city on a screen.',
    { bright: 0.75, warm: 0.4, dreamy: 0.6, fierce: 0.4, playful: 0.3 },
    { lead: ['supersaw', 'sync-lead', 'pulse-lead', 'square', 'pwm-strings'], alt: ['pwm-strings', 'fm-bell', 'brass'], harm: ['supersaw', 'pwm-strings', 'cube-vox', 'tape-strings'], bell: ['fm-bell', 'glockenspiel', 'ping'],
      bass: ['saw-bass', 'moog-bass', 'reese', 'sub', 'fm-bass'], arp: ['analog-pluck', 'ping', 'fm-marimba'], pad: ['supersaw-pad', 'warm-pad', 'glass-pad-fm'], drone: ['dark-drone'],
      comp: ['epiano', 'brass', 'analog-pluck', 'dx-brass'], tom: ['zap', 'timpani'], rim: ['clave', 'cowbell', 'snap'], shaker: ['tambourine'], perc: ['cowbell', 'zap', 'conga'] },
    { hall: { size: 1.2, damp: 0 }, space: 1.1, finish: { chorus: 0.2, echo: 0.12, drive: 0.1 } });
  world('tundra', 'Tundra', 'Cold and wide and nearly empty: a breath of flute, glass, a fog that does not lift.',
    { dreamy: 0.85, eerie: 0.6, bright: 0.45, organic: 0.2, sacred: 0.3 },
    { lead: ['ocarina', 'flute', 'glass-harmonica', 'ping', 'theremin', 'celesta'], alt: ['glockenspiel', 'whistle', 'vibes', 'recorder'], harm: ['glass-harmonica', 'shimmer', 'ooh-choir'], bell: ['crotales', 'glockenspiel', 'tubular', 'handbell', 'celesta'],
      bass: ['sub'], arp: ['glass-rain', 'music-box', 'kalimba'], pad: ['fog', 'shimmer', 'warm-pad', 'tape-strings'], drone: ['fog', 'dark-drone', 'bowl'],
      comp: ['vibes'], tom: ['frame-drum'], rim: ['woodblock'], shaker: ['triangle', 'rainstick'], perc: ['frame-drum', 'triangle'] },
    { hall: { size: 2.0, damp: -0.1 }, space: 1.5, finish: { echo: 0.18, chorus: 0.05 } });
  world('ember', 'Ember', 'Bowed strings and a low horn, a marimba, a taiko far off. Warm, and not safe.',
    { warm: 0.85, fierce: 0.4, sacred: 0.3, eerie: 0.35, organic: 0.7 },
    { lead: ['bowed-strings', 'sax', 'trumpet', 'oboe', 'horn', 'clarinet'], alt: ['shakuhachi', 'flute', 'oud'], harm: ['horn', 'bowed-strings', 'tuba', 'aah-choir'], bell: ['marimba', 'tubular', 'vibes', 'xylophone'],
      bass: ['upright', 'fretless', 'reese', 'bowed-bass', 'tuba'], arp: ['marimba', 'harp', 'nylon'], pad: ['warm-pad', 'bowed-strings', 'harmonium', 'ooh-choir'], drone: ['dark-drone', 'tanpura'],
      comp: ['nylon', 'epiano', 'tonewheel', 'lute', 'accordion'], tom: ['taiko', 'timpani'], rim: ['woodblock'], shaker: ['cabasa'], perc: ['taiko', 'conga', 'timpani', 'djembe', 'udu'] },
    { hall: { size: 1.0, damp: 0.15 }, space: 1, finish: { drive: 0.12 } });
  world('bazaar', 'Bazaar', 'A long-necked string and a reed, tabla under both, a drone that never stops.',
    { organic: 0.85, warm: 0.65, playful: 0.5, eerie: 0.3, sacred: 0.35 },
    { lead: ['sitar', 'koto', 'oud', 'shakuhachi', 'clarinet', 'oboe', 'mandolin'], alt: ['flute', 'sax', 'pan-flute'], harm: ['horn', 'cube-vox', 'aah-choir'], bell: ['gender', 'chimes', 'crotales'],
      bass: ['upright', 'fretless', 'pedal-bass', 'bowed-bass'], arp: ['oud', 'koto', 'sitar', 'kalimba', 'mandolin', 'dulcimer'], pad: ['harmonium', 'bowl', 'warm-pad', 'accordion'], drone: ['tanpura', 'harmonium'],
      comp: ['oud', 'nylon', 'harp', 'lute', 'dulcimer'], tom: ['tabla', 'conga', 'frame-drum'], rim: ['clave', 'woodblock'], shaker: ['tambourine', 'cabasa', 'guiro'], perc: ['tabla', 'conga', 'frame-drum', 'cowbell', 'djembe', 'bongo', 'udu'] },
    { hall: { size: 0.8, damp: 0.15 }, space: 0.85, finish: { chorus: 0.05 } });
  world('cathedral', 'Cathedral', 'Pipes and choir and tubular bells under a very high roof. Timpani for thunder.',
    { sacred: 0.98, warm: 0.5, bright: 0.5, organic: 0.5 },
    { lead: ['pipe-organ', 'flute-stop', 'horn', 'oboe', 'trumpet'], alt: ['brass', 'harmonium', 'oboe', 'trumpet'], harm: ['aah-choir', 'cube-vox', 'horn', 'pipe-organ', 'tape-strings'], bell: ['tubular', 'crotales', 'chimes', 'handbell'],
      bass: ['pedal-bass', 'sub', 'upright', 'tuba'], arp: ['harp', 'harpsichord', 'glockenspiel'], pad: ['pipe-organ', 'shimmer', 'warm-pad', 'aah-choir', 'ooh-choir'], drone: ['pipe-organ', 'dark-drone', 'bowl'],
      comp: ['pipe-organ', 'harpsichord'], tom: ['timpani', 'taiko'], rim: ['woodblock'], shaker: ['triangle'], perc: ['timpani', 'tamtam'] },
    { hall: { size: 2.3, damp: 0 }, space: 1.6, finish: { echo: 0.1 } });
  world('abyss', 'Abyss', 'Below the lowest note: a sub, a bowed thing in the dark, a gong a mile off.',
    { eerie: 0.9, fierce: 0.5, sacred: 0.3, dreamy: 0.3, organic: 0.2 },
    { lead: ['cube-bow', 'theremin', 'shakuhachi', 'buchla-lead', 'horn'], alt: ['horn', 'bowed-strings', 'theremin'], harm: ['ooh-choir', 'cube-vox', 'bowed-strings'], bell: ['tamtam', 'tubular', 'anvil'],
      bass: ['sub', 'reese', 'fold-bass', 'bowed-bass', 'tuba'], arp: ['ping', 'kalimba', 'swarm'], pad: ['fog', 'dark-drone', 'warm-pad', 'tape-strings'], drone: ['dark-drone', 'tamtam', 'fog'],
      comp: ['clav', 'tonewheel'], tom: ['taiko', 'timpani'], rim: ['clave'], shaker: ['cabasa', 'rainstick'], perc: ['taiko', 'anvil', 'udu'] },
    { hall: { size: 1.8, damp: 0.3 }, space: 1.25, finish: { drive: 0.1, echo: 0.1 } });
  world('toybox', 'Toybox', 'A music box, a kalimba, a pulse wave, wooden things that click. Somebody is being silly.',
    { playful: 0.95, bright: 0.8, organic: 0.4, dreamy: 0.4 },
    { lead: ['music-box', 'kalimba', 'square', 'whistle', 'marimba', 'xylophone', 'celesta', 'recorder', 'pulse-lead'], alt: ['glockenspiel', 'ocarina', 'banjo', 'xylophone', 'recorder'], harm: ['cube-vox', 'harmonium'], bell: ['music-box', 'glockenspiel', 'celesta', 'handbell'],
      bass: ['fretless', 'fm-bass', 'saw-bass', 'bass-marimba', 'moog-bass'], arp: ['kalimba', 'fm-marimba', 'banjo', 'ping', 'xylophone', 'pizzicato', 'mandolin'], pad: ['harmonium', 'warm-pad'], drone: ['harmonium'],
      comp: ['banjo', 'epiano', 'accordion', 'farfisa', 'pizzicato'], tom: ['conga', 'woodblock'], rim: ['woodblock', 'clave', 'cowbell', 'snap'], shaker: ['guiro', 'tambourine', 'triangle'], perc: ['cowbell', 'woodblock', 'triangle', 'bongo'] },
    { hall: { size: 0.6, damp: 0.1 }, space: 0.7 });
  world('gamelan', 'Gamelan', 'Bronze keys beating against one another, a gong under the hour, a bamboo flute.',
    { sacred: 0.55, organic: 0.75, eerie: 0.25, dreamy: 0.5, warm: 0.5 },
    { lead: ['gender', 'steelpan', 'marimba', 'flute', 'xylophone'], alt: ['kalimba', 'crotales', 'pan-flute'], harm: ['gender', 'glass-harmonica'], bell: ['gender', 'crotales', 'tamtam'],
      bass: ['bass-marimba', 'upright', 'sub'], arp: ['gender', 'marimba', 'kalimba', 'dulcimer'], pad: ['bowl', 'warm-pad', 'fog'], drone: ['tamtam', 'dark-drone'],
      comp: ['gender', 'steelpan'], tom: ['log-drum', 'frame-drum'], rim: ['woodblock', 'clave'], shaker: ['cabasa'], perc: ['log-drum', 'cowbell', 'frame-drum', 'djembe'] },
    { hall: { size: 1.0, damp: 0.2 }, space: 1, finish: { chorus: 0.1 } });
  world('velvet', 'Velvet', 'A Rhodes, a vibraphone, a walking upright, brushes: a room with the lights down.',
    { warm: 0.95, organic: 0.6, dreamy: 0.45, playful: 0.3 },
    { lead: ['vibes', 'epiano', 'sax', 'clarinet', 'oboe', 'trumpet'], alt: ['flute', 'horn', 'felt-piano'], harm: ['horn', 'tonewheel', 'aah-choir'], bell: ['vibes', 'glockenspiel'],
      bass: ['upright', 'fretless', 'moog-bass', 'bass-marimba'], arp: ['epiano', 'vibes', 'nylon', 'pizzicato', 'dx-harp'], pad: ['warm-pad', 'tonewheel', 'bowed-strings'], drone: ['dark-drone'],
      comp: ['epiano', 'tonewheel', 'felt-piano', 'farfisa', 'lute'], tom: ['conga', 'frame-drum'], rim: ['woodblock', 'clave', 'snap'], shaker: ['cabasa', 'tambourine'], perc: ['conga', 'tabla', 'bongo'] },
    { hall: { size: 0.8, damp: 0.2 }, space: 0.85, finish: { drive: 0.08 } });
  world('storm', 'Storm', 'Everything leaning into the wind: brass and sync and steel strings, a taiko that is thunder.',
    { fierce: 0.98, bright: 0.6, organic: 0.4, eerie: 0.3 },
    { lead: ['sync-lead', 'brass', 'trumpet', 'sax', 'buchla-lead', 'steel'], alt: ['square', 'bowed-strings', 'brass'], harm: ['brass', 'bowed-strings', 'trumpet', 'tuba', 'aah-choir'], bell: ['tubular', 'anvil', 'crotales'],
      bass: ['reese', 'acid', 'saw-bass', 'moog-bass', 'bowed-bass'], arp: ['analog-pluck', 'clav', 'steel'], pad: ['supersaw-pad', 'brass', 'dark-drone'], drone: ['dark-drone', 'tamtam'],
      comp: ['steel', 'brass', 'clav', 'dx-brass'], tom: ['taiko', 'timpani'], rim: ['cowbell', 'woodblock'], shaker: ['tambourine'], perc: ['taiko', 'anvil', 'timpani', 'djembe'] },
    { hall: { size: 0.9, damp: 0.1 }, space: 0.9, finish: { drive: 0.3 } });
  world('dream', 'Dream', 'Haze: an electric piano going out of tune, strings that are not quite strings, a shimmer over all.',
    { dreamy: 0.98, warm: 0.65, eerie: 0.3, bright: 0.5 },
    { lead: ['epiano', 'pwm-strings', 'ocarina', 'vibes', 'theremin', 'dulcimer', 'celesta'], alt: ['pwm-strings', 'flute', 'glass-harmonica'], harm: ['shimmer', 'ooh-choir', 'cube-vox', 'pwm-strings', 'tape-strings'], bell: ['music-box', 'glockenspiel', 'fm-bell', 'celesta', 'handbell'],
      bass: ['sub', 'fretless'], arp: ['kalimba', 'ping', 'fm-marimba', 'glass-rain'], pad: ['shimmer', 'tape-strings', 'warm-pad', 'pwm-strings', 'ooh-choir'], drone: ['fog', 'dark-drone'],
      comp: ['epiano', 'vibes', 'dx-harp', 'dulcimer'], tom: ['frame-drum'], rim: ['woodblock'], shaker: ['triangle', 'rainstick'], perc: ['frame-drum', 'conga'] },
    { hall: { size: 1.6, damp: -0.05 }, space: 1.4, finish: { chorus: 0.3, echo: 0.2 } });
  world('tide', 'Tide', 'A harp, a flute, a low bowl like a bell buoy, and the sound of the sea in the grain of the pad.',
    { dreamy: 0.6, organic: 0.65, sacred: 0.35, warm: 0.6, bright: 0.4 },
    { lead: ['flute', 'harp', 'handpan', 'ocarina', 'dulcimer', 'oboe'], alt: ['horn', 'clarinet'], harm: ['ooh-choir', 'horn', 'cube-vox'], bell: ['chimes', 'glockenspiel', 'bowl-struck', 'handbell'],
      bass: ['upright', 'sub', 'bowed-bass', 'bass-marimba'], arp: ['harp', 'handpan', 'kalimba', 'glass-rain', 'dulcimer', 'dx-harp'], pad: ['bowl', 'shimmer', 'warm-pad', 'ooh-choir'], drone: ['tanpura', 'fog'],
      comp: ['harp', 'nylon', 'lute', 'dulcimer'], tom: ['frame-drum'], rim: ['woodblock'], shaker: ['rainstick', 'cabasa'], perc: ['frame-drum', 'conga'] },
    { hall: { size: 1.5, damp: 0 }, space: 1.3, finish: { chorus: 0.15, echo: 0.1 } });
  world('circuit', 'Circuit', 'Four channels and a noise channel. Square waves, a pulse bass, a hard little bell.',
    { bright: 0.9, playful: 0.85, fierce: 0.35, organic: 0.05 },
    { lead: ['pulse-lead', 'square', 'sync-lead', 'ping'], alt: ['square', 'analog-pluck', 'pulse-lead'], harm: ['square', 'pwm-strings'], bell: ['ping', 'fm-bell', 'music-box'],
      bass: ['saw-bass', 'fm-bass', 'acid', 'moog-bass'], arp: ['analog-pluck', 'ping', 'fm-marimba', 'pulse-lead'], pad: ['pwm-strings', 'supersaw-pad'], drone: ['dark-drone'],
      comp: ['analog-pluck', 'clav', 'square'], tom: ['zap'], rim: ['clave', 'cowbell'], shaker: ['tambourine'], perc: ['zap', 'cowbell'] },
    { hall: { size: 0.4, damp: 0.3 }, space: 0.4, finish: { grit: 0.6, bits: 8, hold: 2 } });
  world('smoke', 'Smoke', 'An old upright piano, a dusty Rhodes, a cassette that has been left in the sun.',
    { warm: 0.9, dreamy: 0.65, organic: 0.55, eerie: 0.2, playful: 0.2 },
    { lead: ['epiano', 'felt-piano', 'clarinet', 'vibes', 'oboe', 'dx-harp'], alt: ['flute', 'nylon'], harm: ['warm-pad', 'tonewheel', 'ooh-choir'], bell: ['music-box', 'vibes', 'kalimba'],
      bass: ['fretless', 'upright', 'bass-marimba', 'moog-bass'], arp: ['nylon', 'kalimba', 'epiano', 'pizzicato', 'dulcimer'], pad: ['warm-pad', 'tape-strings', 'tonewheel', 'harmonium'], drone: ['dark-drone'],
      comp: ['felt-piano', 'epiano', 'tonewheel', 'lute', 'accordion'], tom: ['conga', 'frame-drum'], rim: ['snap', 'woodblock'], shaker: ['cabasa'], perc: ['conga', 'frame-drum', 'bongo'] },
    { hall: { size: 0.6, damp: 0.35 }, space: 0.7, finish: { drive: 0.15, grit: 0.18, bits: 12 } });
  world('hollow', 'Hollow', 'Old things: a koto, a breath of bone flute, a drum made of a skin and nothing else.',
    { organic: 0.95, eerie: 0.45, sacred: 0.4, warm: 0.55 },
    { lead: ['koto', 'shakuhachi', 'flute', 'banjo', 'oboe', 'mandolin', 'recorder'], alt: ['pan-flute', 'ocarina', 'horn'], harm: ['horn', 'harmonium', 'ooh-choir'], bell: ['tubular', 'bowl-struck', 'chimes'],
      bass: ['upright', 'pedal-bass', 'bowed-bass', 'tuba'], arp: ['koto', 'harp', 'kalimba', 'lute', 'dulcimer'], pad: ['bowed-strings', 'harmonium', 'bowl'], drone: ['tanpura', 'dark-drone'],
      comp: ['koto', 'oud', 'harp', 'lute', 'dulcimer'], tom: ['frame-drum', 'taiko'], rim: ['woodblock'], shaker: ['cabasa', 'rainstick'], perc: ['frame-drum', 'taiko', 'log-drum', 'udu', 'djembe'] },
    { hall: { size: 1.2, damp: 0.1 }, space: 1.1, finish: { echo: 0.08 } });

  /* ── §5j.4 WHAT A SONG ASKS FOR ────────────────────────────────────────── */

  /** What each mood, idiom and element asks of the room: tag → how much (0…1). Those not named ask for nothing in particular. */
  const MOOD = {
    ambient: { dreamy: 0.9, sacred: 0.4, warm: 0.3 }, pulse: { bright: 0.7, playful: 0.4, fierce: 0.3 }, lullaby: { warm: 0.8, dreamy: 0.8, playful: 0.4, organic: 0.5 },
    dirge: { eerie: 0.8, sacred: 0.7, warm: 0.2 }, ecstatic: { bright: 0.8, fierce: 0.5, playful: 0.5, sacred: 0.4 }, glacier: { dreamy: 0.7, eerie: 0.6, bright: 0.5 },
    swarm: { eerie: 0.6, fierce: 0.6, playful: 0.3 }, abyss: { eerie: 1, fierce: 0.4 }, aurora: { dreamy: 0.9, bright: 0.6, sacred: 0.3 },
    procession: { sacred: 0.8, fierce: 0.3, organic: 0.5 }, fathom: { eerie: 0.7, dreamy: 0.6, sacred: 0.4 }, gilded: { bright: 0.7, sacred: 0.6, warm: 0.5 },
    static: { fierce: 0.6, eerie: 0.6, bright: 0.4 }, vigil: { sacred: 0.8, warm: 0.5, eerie: 0.3 }, ember: { warm: 0.8, fierce: 0.4, organic: 0.5 },
    tidewater: { dreamy: 0.6, organic: 0.6, warm: 0.5 }, sanctum: { sacred: 1, dreamy: 0.4 }, triumph: { bright: 0.8, fierce: 0.5, sacred: 0.5, warm: 0.4 },
    reverie: { dreamy: 0.9, warm: 0.6 }, wrath: { fierce: 1, eerie: 0.3 }, longing: { warm: 0.7, dreamy: 0.6, organic: 0.6 },
    mischief: { playful: 1, bright: 0.6 }, hymn: { sacred: 0.95, warm: 0.6 }, dread: { eerie: 0.95, fierce: 0.4 }, storm: { fierce: 0.9, bright: 0.4, eerie: 0.3 },
  };
  const STYLE = {
    hiphop: { warm: 0.6, organic: 0.4 }, trap: { fierce: 0.6, eerie: 0.4, bright: 0.4 }, lofi: { warm: 0.9, dreamy: 0.7, organic: 0.4 }, pop: { bright: 0.6, playful: 0.4 },
    punk: { fierce: 0.9, bright: 0.4 }, grunge: { fierce: 0.7, warm: 0.4, eerie: 0.3 }, metal: { fierce: 1, eerie: 0.3 }, edm: { bright: 0.8, fierce: 0.5 },
    house: { warm: 0.5, bright: 0.5, playful: 0.3 }, techno: { fierce: 0.6, eerie: 0.5 }, dnb: { fierce: 0.6, bright: 0.5 }, synthwave: { dreamy: 0.7, bright: 0.6, warm: 0.3 },
    funk: { playful: 0.8, warm: 0.6, organic: 0.5 }, reggae: { warm: 0.8, organic: 0.6, playful: 0.4 }, jazz: { warm: 0.9, organic: 0.6, dreamy: 0.3 }, bossa: { warm: 0.8, organic: 0.8, dreamy: 0.4 },
    folk: { organic: 1, warm: 0.8 }, chiptune: { playful: 0.9, bright: 0.9 }, dembow: { organic: 0.5, playful: 0.5, fierce: 0.3 },
  };
  /** Worlds an idiom is at home in, by id, over and above its feelings: [world, weight]. */
  const STYLE_HOME = {
    trap: [['neon', 1], ['abyss', 1], ['foundry', 0.6]], lofi: [['smoke', 2], ['velvet', 1], ['dream', 1]], pop: [['neon', 1], ['glasshouse', 0.6]], punk: [['storm', 1], ['foundry', 1]],
    grunge: [['storm', 1], ['foundry', 0.6], ['ember', 0.6]], metal: [['storm', 1.5], ['foundry', 1.2]], edm: [['neon', 1.5], ['glasshouse', 0.6]], house: [['neon', 1], ['velvet', 0.6]],
    techno: [['foundry', 1.2], ['abyss', 1], ['circuit', 0.6]], dnb: [['foundry', 1], ['neon', 0.8]], synthwave: [['neon', 2], ['dream', 1]], funk: [['velvet', 1.2], ['toybox', 0.6]],
    reggae: [['meadow', 1], ['velvet', 0.8], ['smoke', 0.6]], jazz: [['velvet', 2], ['smoke', 1]], bossa: [['meadow', 1.2], ['velvet', 1]], folk: [['meadow', 2], ['hollow', 1], ['bazaar', 0.6]],
    chiptune: [['circuit', 2.5], ['toybox', 1]], dembow: [['bazaar', 1], ['meadow', 0.6], ['neon', 0.4]], hiphop: [['smoke', 1], ['velvet', 0.6], ['abyss', 0.5]],
  };
  const ELEMENT = {
    fire: { fierce: 0.7, bright: 0.5, warm: 0.4 }, water: { dreamy: 0.7, organic: 0.4, warm: 0.3 }, air: { bright: 0.7, dreamy: 0.5, sacred: 0.2 }, earth: { organic: 0.8, warm: 0.7, sacred: 0.3 },
  };
  /** How loud each ask is, against chance: the sigil's own lot is the rest. */
  const LEAN = { mood: 2.4, style: 2.0, element: 1.4, home: 1.6 };

  /* ── §5j.5 DEALING ─────────────────────────────────────────────────────── */

  const memo = new Map();
  const keyOf = (sigil, cfg, variant) => `${sigil.hex}|${cfg && cfg.mood || ''}|${cfg && cfg.style || ''}|${cfg && cfg.element || ''}|${variant | 0}`;

  /**
   * The world and the cast a sigil is dealt, for a song's mood, idiom and element.
   * ⚠ THE ORDER OF DRAWS IS FROZEN: one for the world, then one per role in ROLES order, then the octave's.
   * variant 0 is the sigil's own; others are dealt afresh, keeping the asks of the song.
   */
  function deal(sigil, cfg, variant = 0) {
    variant = variant | 0;
    const key = keyOf(sigil, cfg, variant);
    let out = memo.get(key);
    if (out) return out;
    const R = stream(sigil.hash, variant ? `palette:${variant}` : 'palette');
    // what the song asks for
    const want = {}, add = (t, k) => { if (t) for (const [tag, v] of Object.entries(t)) want[tag] = (want[tag] || 0) + v * k; };
    add(MOOD[cfg && cfg.mood], LEAN.mood); add(STYLE[cfg && cfg.style], LEAN.style); add(ELEMENT[cfg && cfg.element], LEAN.element);
    const home = {};
    for (const [w, k] of STYLE_HOME[cfg && cfg.style] || []) home[w] = k * LEAN.home;
    // how much each world answers: a dot product of feelings, and a place at home. The original voices are a world like the rest, a little rarer.
    const score = WORLDS.map((w) => {
      let s = 0;
      for (const t of TAGS) s += (w.tags[t] || 0) * (want[t] || 0);
      return s + (home[w.id] || 0) + (w.id === 'cube' ? 0.3 : 0.5);
    });
    const top = Math.max(...score), wts = score.map((s) => Math.exp(1.15 * (s - top)));
    const world = WORLDS[R.weighted(WORLDS.map((_, i) => i), wts)];
    const roles = {};
    for (const role of ROLES) {
      const list = world.cast[role] || [];
      if (!list.length) { roles[role] = 0; R.float(); continue; }
      // the first of a world's list is the likeliest, the last the rarest
      const k = R.weighted(list.map((_, i) => i), list.map((_, i) => list.length - i));
      roles[role] = BY_KEY.get(list[k]).id;
    }
    // two parts that are one engine are two voices that blend: the second voice, and the choir, take another engine if the world has one
    const engineOf = (r) => (INST.get(roles[r]) || {}).engine;
    for (const r of ['alt', 'harm']) {
      if (roles[r] && engineOf(r) === engineOf('lead') && INST.get(roles[r]).engine !== 'cube') {
        const other = (world.cast[r] || []).map((k) => BY_KEY.get(k)).find((d) => d.engine !== engineOf('lead'));
        if (other) roles[r] = other.id;
      }
    }
    out = Object.freeze({ world: world.id, worldIndex: world.index, roles: Object.freeze(roles), variant });
    if (memo.size > 96) memo.clear();
    memo.set(key, out);
    return out;
  }

  /**
   * What a patch makes of a deal: `P.palOff` puts every part back in the cube's voices; `P.pal` asks for another deal;
   * `P.iLead` … `P.iPerc` name an instrument (by id) for a part. Returns { world, roles: {role: id}, deal }.
   */
  function cast(sigil, cfg, P) {
    P = P || {};
    if (P.palOff) {
      const w = WORLDS[0], roles = {};
      for (const r of ROLES) roles[r] = (w.cast[r] && w.cast[r][0]) ? BY_KEY.get(w.cast[r][0]).id : 0;
      return { world: w.id, roles, deal: null, classic: true };
    }
    const d = deal(sigil, cfg, P.pal | 0), roles = { ...d.roles };
    for (const [role, field] of Object.entries(ROLE_FIELD)) {
      const id = P[field] | 0;
      if (id > 0 && INST.has(id)) roles[role] = id;
    }
    if (P.roles) for (const [role, id] of Object.entries(P.roles)) if (SLOT[role] !== undefined && INST.has(id)) roles[role] = id;   // (tools and tests: any part, any instrument)
    return { world: d.world, roles, deal: d, classic: false };
  }

  /* ── §5j.6 PACKING: the core's table ───────────────────────────────────── */

  /** Measured gains (see tools/calibrate-voices.mjs, tests/voices.spec.mjs): what each instrument is multiplied by to sit where the cube's voice of its part does. */
  /*GAINS*/
  const GAINS = {
    '10:alt': 0.274,
    '10:arp': 0.166,
    '10:bell': 0.789,
    '10:comp': 0.275,
    '10:lead': 0.311,
    '11:alt': 0.893,
    '11:arp': 0.526,
    '11:comp': 0.826,
    '11:lead': 0.836,
    '12:alt': 0.838,
    '12:arp': 0.459,
    '12:comp': 0.828,
    '12:lead': 1.035,
    '13:alt': 0.772,
    '13:arp': 0.458,
    '13:comp': 0.843,
    '13:lead': 0.738,
    '14:alt': 1.253,
    '14:arp': 0.753,
    '14:lead': 1.372,
    '15:alt': 1.193,
    '15:arp': 0.658,
    '15:comp': 0.705,
    '15:lead': 1.129,
    '16:bass': 0.279,
    '17:bass': 0.376,
    '18:alt': 0.836,
    '18:arp': 0.406,
    '18:comp': 0.848,
    '18:lead': 0.925,
    '19:alt': 0.883,
    '19:arp': 0.517,
    '19:comp': 0.955,
    '19:lead': 1.059,
    '20:alt': 0.349,
    '20:arp': 0.213,
    '20:comp': 0.344,
    '20:lead': 0.296,
    '21:drone': 1,
    '22:alt': 0.631,
    '22:arp': 0.299,
    '22:bell': 0.836,
    '22:lead': 0.552,
    '23:alt': 1.091,
    '23:arp': 0.572,
    '23:comp': 0.989,
    '23:lead': 1.154,
    '24:alt': 0.387,
    '24:arp': 0.207,
    '24:bell': 0.743,
    '24:comp': 0.345,
    '24:lead': 0.409,
    '25:alt': 0.88,
    '25:arp': 0.454,
    '25:comp': 0.989,
    '25:lead': 0.96,
    '26:alt': 0.83,
    '26:arp': 0.43,
    '26:comp': 0.989,
    '26:lead': 0.957,
    '30:alt': 0.836,
    '30:arp': 0.604,
    '30:bell': 2.169,
    '30:comp': 0.875,
    '30:lead': 1.197,
    '31:alt': 0.772,
    '31:arp': 0.553,
    '31:bell': 1.484,
    '31:comp': 0.773,
    '31:lead': 0.702,
    '32:alt': 0.608,
    '32:arp': 0.458,
    '32:bell': 1.585,
    '32:lead': 0.675,
    '33:bell': 0.813,
    '33:lead': 0.505,
    '34:drone': 0.065,
    '34:harm': 0.117,
    '34:lead': 0.18,
    '34:pad': 0.039,
    '35:alt': 0.817,
    '35:arp': 0.591,
    '35:bell': 1.523,
    '35:comp': 0.914,
    '35:harm': 0.459,
    '35:lead': 1,
    '36:alt': 1.107,
    '36:arp': 0.722,
    '36:comp': 1.175,
    '36:lead': 1.197,
    '37:alt': 0.746,
    '37:arp': 0.452,
    '37:bell': 1.479,
    '37:comp': 0.68,
    '37:lead': 0.746,
    '38:arp': 0.401,
    '38:bell': 1.347,
    '38:lead': 0.696,
    '39:alt': 0.496,
    '39:bell': 1.217,
    '40:alt': 0.172,
    '40:drone': 0.074,
    '40:harm': 0.101,
    '40:lead': 0.219,
    '40:pad': 0.044,
    '41:bell': 1.339,
    '41:drone': 0.608,
    '41:perc': 0.48,
    '42:alt': 0.707,
    '42:arp': 0.553,
    '42:comp': 0.817,
    '42:lead': 0.989,
    '43:arp': 0.349,
    '43:bell': 1.449,
    '44:bell': 0.881,
    '44:drone': 0.579,
    '44:lead': 0.502,
    '45:alt': 1.465,
    '45:arp': 0.636,
    '45:bell': 4.307,
    '45:comp': 1.536,
    '45:lead': 1.403,
    '46:alt': 0.609,
    '46:arp': 0.439,
    '46:bell': 1.247,
    '46:lead': 0.705,
    '47:alt': 0.717,
    '47:bell': 1.556,
    '47:lead': 0.887,
    '48:bass': 0.855,
    '50:perc': 4.978,
    '50:tom': 8.088,
    '51:perc': 4.09,
    '51:tom': 5.459,
    '52:perc': 4.799,
    '52:tom': 8.442,
    '53:perc': 1.207,
    '53:tom': 1.969,
    '54:perc': 2.98,
    '54:tom': 7.421,
    '55:perc': 5.819,
    '55:rim': 0.741,
    '55:tom': 14.873,
    '56:perc': 2.566,
    '56:rim': 0.315,
    '57:perc': 2.573,
    '57:rim': 0.315,
    '58:perc': 1.394,
    '58:shaker': 0.056,
    '59:bell': 1.413,
    '59:perc': 0.371,
    '59:shaker': 0.054,
    '60:shaker': 0.116,
    '61:perc': 3.148,
    '61:tom': 5.673,
    '62:bell': 2.355,
    '62:perc': 1.226,
    '62:rim': 0.325,
    '63:perc': 5.253,
    '63:tom': 9.074,
    '64:perc': 4.577,
    '64:tom': 13.74,
    '65:perc': 8.427,
    '65:rim': 0.969,
    '65:shaker': 0.215,
    '66:perc': 3.096,
    '66:shaker': 0.095,
    '67:perc': 0.189,
    '67:shaker': 0.016,
    '68:perc': 2.926,
    '68:tom': 5.901,
    '70:alt': 0.182,
    '70:arp': 0.185,
    '70:comp': 0.166,
    '70:harm': 0.089,
    '70:lead': 0.199,
    '71:harm': 0.199,
    '71:pad': 0.085,
    '72:alt': 0.094,
    '72:arp': 0.32,
    '72:harm': 0.054,
    '72:lead': 0.107,
    '72:pad': 0.056,
    '73:bass': 0.202,
    '74:alt': 0.096,
    '74:arp': 0.057,
    '74:bass': 0.087,
    '74:lead': 0.069,
    '75:alt': 0.208,
    '75:lead': 0.201,
    '76:alt': 0.203,
    '76:comp': 0.181,
    '76:harm': 0.091,
    '76:lead': 0.219,
    '76:pad': 0.074,
    '77:alt': 0.608,
    '77:arp': 0.274,
    '77:comp': 0.502,
    '77:lead': 0.613,
    '78:bass': 0.219,
    '79:harm': 0.138,
    '79:pad': 0.096,
    '80:drone': 0.151,
    '80:pad': 0.068,
    '81:alt': 0.088,
    '81:arp': 0.117,
    '81:comp': 0.115,
    '81:harm': 0.054,
    '81:lead': 0.086,
    '82:alt': 0.209,
    '82:harm': 0.102,
    '82:lead': 0.224,
    '82:pad': 0.07,
    '83:bass': 0.292,
    '84:bass': 0.19,
    '85:bass': 0.329,
    '86:alt': 0.186,
    '86:lead': 0.185,
    '87:harm': 0.135,
    '87:lead': 0.264,
    '87:pad': 0.092,
    '88:alt': 0.124,
    '88:arp': 0.106,
    '88:comp': 0.117,
    '88:lead': 0.141,
    '90:alt': 0.175,
    '90:comp': 0.185,
    '90:harm': 0.103,
    '90:lead': 0.185,
    '90:pad': 0.105,
    '91:alt': 0.144,
    '91:bass': 0.215,
    '91:comp': 0.179,
    '91:lead': 0.144,
    '92:comp': 0.195,
    '92:lead': 0.221,
    '92:pad': 0.12,
    '93:alt': 0.177,
    '93:comp': 0.194,
    '93:drone': 0.152,
    '93:harm': 0.089,
    '93:lead': 0.2,
    '93:pad': 0.085,
    '94:alt': 0.127,
    '94:comp': 0.162,
    '94:drone': 0.137,
    '94:harm': 0.084,
    '94:lead': 0.125,
    '94:pad': 0.074,
    '95:alt': 0.158,
    '95:arp': 0.181,
    '95:lead': 0.166,
    '96:bass': 0.287,
    '97:alt': 0.12,
    '97:comp': 0.162,
    '97:harm': 0.084,
    '97:lead': 0.123,
    '97:pad': 0.071,
    '98:alt': 0.121,
    '98:comp': 0.165,
    '98:lead': 0.121,
    '100:alt': 0.156,
    '100:arp': 0.165,
    '100:comp': 0.195,
    '100:harm': 0.096,
    '100:lead': 0.156,
    '101:arp': 0.227,
    '101:bass': 0.295,
    '101:comp': 0.358,
    '101:lead': 0.34,
    '102:alt': 0.13,
    '102:arp': 0.166,
    '102:bell': 0.279,
    '102:comp': 0.168,
    '102:lead': 0.13,
    '103:bass': 0.197,
    '104:alt': 0.333,
    '104:arp': 0.23,
    '104:comp': 0.294,
    '104:lead': 0.297,
    '105:drone': 0.213,
    '105:harm': 0.253,
    '105:pad': 0.119,
    '106:arp': 0.195,
    '106:bell': 0.362,
    '106:comp': 0.243,
    '106:lead': 0.173,
    '107:alt': 0.121,
    '107:comp': 0.17,
    '107:harm': 0.084,
    '107:lead': 0.125,
    '108:alt': 0.183,
    '108:arp': 0.187,
    '108:bell': 0.359,
    '108:comp': 0.217,
    '108:lead': 0.179,
    '110:alt': 0.182,
    '110:arp': 0.249,
    '110:harm': 0.117,
    '110:lead': 0.188,
    '111:alt': 0.182,
    '111:lead': 0.19,
    '112:alt': 0.152,
    '112:arp': 0.197,
    '112:harm': 0.098,
    '112:lead': 0.153,
    '113:alt': 0.164,
    '113:arp': 0.235,
    '113:lead': 0.162,
    '114:alt': 0.147,
    '114:arp': 0.218,
    '114:bell': 0.318,
    '114:lead': 0.148,
    '115:alt': 0.177,
    '115:harm': 0.115,
    '115:lead': 0.185,
    '115:pad': 0.088,
    '116:alt': 0.211,
    '116:lead': 0.185,
    '117:alt': 0.139,
    '117:bell': 0.307,
    '117:lead': 0.137,
    '118:bass': 0.339,
    '118:harm': 0.128,
    '119:alt': 0.182,
    '119:harm': 0.1,
    '119:lead': 0.189,
    '120:alt': 0.529,
    '120:arp': 0.287,
    '120:bell': 0.569,
    '120:lead': 0.446,
    '121:alt': 0.16,
    '121:lead': 0.144,
    '122:perc': 1.083,
    '122:rim': 0.195,
    '122:tom': 2.981,
    '123:bass': 0.252,
    '124:arp': 0.234,
    '124:bell': 0.439,
    '124:lead': 0.286,
    '130:drone': 0.212,
    '130:harm': 0.203,
    '130:lead': 0.369,
    '130:pad': 0.09,
    '131:alt': 0.464,
    '131:arp': 0.573,
    '131:lead': 0.485,
    '131:pad': 0.173,
    '132:arp': 0.333,
    '132:bell': 0.409,
    '132:lead': 0.296,
    '132:pad': 0.132,
    '133:drone': 0.262,
    '133:harm': 0.383,
    '133:pad': 0.138,
    '140:alt': 0.254,
    '140:harm': 0.136,
    '140:lead': 0.289,
    '141:alt': 0.15,
    '141:arp': 0.215,
    '141:lead': 0.149,
    '142:alt': 0.122,
    '142:harm': 0.079,
    '142:lead': 0.12,
    '142:pad': 0.076,
    '143:harm': 0.116,
    '143:lead': 0.212,
    '143:pad': 0.094,
  };
  /*ENDGAINS*/

  let measured = true;
  /** What an instrument is multiplied by in a part: its measured gain, or (calibrating) its own. */
  const gainOf = (d, role) => {
    if (!measured) return d.gain;
    const own = GAINS[`${d.id}:${role}`];
    if (own !== undefined) return own;
    // a part the instrument was not measured in (a link can name any instrument for any part): the mean of the parts it was
    let n = 0, lg = 0;
    for (const r of ROLES) { const g = GAINS[`${d.id}:${r}`]; if (g > 0) { lg += Math.log(g); n++; } }
    return n ? Math.exp(lg / n) : d.gain;
  };
  /** The calibration tool measures the instruments as they are, and so turns the measured gains off. */
  function useMeasured(on) { measured = !!on; rmemo.clear(); }

  /** An instrument as the core's slot: [engine's kind, gain, numbers…], the sigil's nudge laid on. */
  function pack(d, sigil, role, variant) {
    const v = new Float64Array(24);
    if (d.engine === 'cube') return v;
    const names = PARAMS[d.engine], jit = JIT[d.engine] || {};
    v[0] = KIND_OF[d.engine]; v[1] = gainOf(d, role);
    const R = stream(sigil.hash, `palette:${role}:${d.id}${variant ? ':' + variant : ''}`);
    names.forEach((name, i) => {
      let x = d.params[name] ?? 0;
      const j = jit[name], r = R.float() * 2 - 1;                     // ⚠ one draw per name, in order, whether it is used or not
      if (j && x !== 0) x = j[0] === 'mul' ? x * Math.pow(1 + j[1], r) : x + j[1] * r;
      v[2 + i] = x;
    });
    return v;
  }

  /**
   * The whole resolution for a song: which world, which instrument in each part, the core's table, the room.
   * @returns {{ world, name, roles: {role: def}, table: Float64Array(16·24), hall, space, classic, key }}
   */
  const rmemo = new Map();
  function resolve(sigil, cfg, P) {
    const c = cast(sigil, cfg, P), w = WORLDS.find((x) => x.id === c.world) || WORLDS[0];
    const key = `${sigil.hex}|${c.world}|${ROLES.map((r) => c.roles[r]).join(',')}|${c.deal ? c.deal.variant : 0}|${measured ? 1 : 0}`;
    let out = rmemo.get(key);
    if (out) return out;
    const table = new Float64Array(16 * 24), roles = {};
    for (const role of ROLES) {
      const d = INST.get(c.roles[role]);
      roles[role] = d || null;
      if (d && d.engine !== 'cube') table.set(pack(d, sigil, role, c.deal ? c.deal.variant : 0), SLOT[role] * 24);
    }
    out = Object.freeze({ world: w.id, name: w.name, blurb: w.blurb, roles, table, hall: w.hall, space: w.space, finish: c.classic ? null : w.finish, classic: c.classic, key });
    if (rmemo.size > 48) rmemo.clear();
    rmemo.set(key, out);
    return out;
  }

  /**
   * What the world does to the patch's own knobs, for the base patch a song is shaped from (the listener's own knobs are laid over it, and win):
   * { chorus, echo, drive, grit (added), bits, hold (set) } or null.
   */
  function finish(sigil, cfg, P) {
    const r = resolve(sigil, cfg, P);
    return r.finish || null;
  }
  /** The patch with a world's finish laid on it, each knob kept to its range. `fields` is SoundDesign.FIELDS. */
  function dress(base, fin, fields) {
    if (!fin) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(fin)) {
      const F = fields[k], lo = F ? F[1] : 0, hi = F ? F[2] : 1;
      out[k] = k === 'bits' || k === 'hold' ? v : Math.min(hi, Math.max(lo, (+base[k] || 0) + v));
    }
    return out;
  }

  /** A line for the HUD and for a screen reader: the world and its lead and bass. */
  function describe(res) {
    if (!res) return '';
    const nm = (r) => (res.roles[r] ? res.roles[r].name : '');
    if (res.classic || res.world === 'cube') return `${nm('lead') || 'the cube'}`;
    return `${res.name} · ${[nm('lead'), nm('pad') || nm('bass')].filter(Boolean).join(' · ')}`;
  }

  /** Instruments that can play a part, for a chooser: [{ id, name, engine }], the world's own first. */
  function forRole(role, worldId) {
    const w = WORLDS.find((x) => x.id === worldId), own = new Set(((w && w.cast[role]) || []).map((k) => BY_KEY.get(k).id));
    const all = [...INST.values()].filter((d) => d.roles.includes(role));
    return all.sort((a, b) => (own.has(b.id) ? 1 : 0) - (own.has(a.id) ? 1 : 0) || a.id - b.id);
  }

  return {
    ROLES, SLOT, ROLE_LABEL, ROLE_FIELD, PARAMS, KIND_OF, TAGS, INST, BY_KEY, WORLDS, GAINS,
    deal, cast, resolve, pack, describe, forRole, useMeasured, gainOf, GM, finish, dress,
    instrument: (id) => INST.get(id) || null,
  };
})();

if (typeof window !== 'undefined') window.Palette = Palette;
