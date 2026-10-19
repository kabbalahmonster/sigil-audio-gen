'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M1 · SCORE · MIDI — Standard MIDI File export + chord chart
   --------------------------------------------------------------------------
   Format 1, 480 PPQ. Track 0 holds tempo, time and key signature, section
   markers and chord text. Then one track per instrument.

   Channels: lead 1, choir 2, bells 3, pad 4, bass 5, arp 6, drone 7,
             voice 2 → 8, voice 3 → 9, drums → 10 (GM percussion)

   Soft dependency: M9 LiveLens (optional "apply the live lens" toggle).
   ══════════════════════════════════════════════════════════════════════════ */

const MidiExport = (() => {
  'use strict';
  const { h } = UI;

  const PPQ = 480;

  /* General MIDI programs (0-based): Celesta, Oboe, Koto, Tubular Bells,
     Choir Aahs, Warm Pad, Synth Bass 1, Vibraphone, Sweep Pad. */
  const GM = { glass: 8, reed: 68, koto: 107, bell: 14, choir: 52, pad: 89, bass: 38, arp: 11, drone: 95 };
  const DRUM = { kick: 36, snare: 38, hat: 42, open: 46, shaker: 70, crash: 49, rim: 37 };
  /** The three toms of the drum engine's fills (m15 / 05c): floor, low, high-mid. */
  const TOMS = [41, 45, 48];

  /** [internal id, track name, channel]. Channel 9 is GM percussion. */
  const TRACKS = [
    ['lead', 'Lead', 0], ['harm', 'Choir', 1], ['bell', 'Bells', 2], ['pad', 'Pad', 3],
    ['bass', 'Bass', 4], ['arp', 'Arpeggio', 5], ['drone', 'Drone', 6],
    ['v2', 'Voice 2', 7], ['v3', 'Voice 3', 8], ['drums', 'Drums', 9],
  ];

  /** Semitones from the mode's tonic down to its parent major tonic. */
  const MODE_OFFSET = { Ionian: 0, Dorian: 2, Phrygian: 4, Lydian: 5, Mixolydian: 7, Aeolian: 9, 'Harmonic minor': 9 };
  /** Sharps (+) / flats (−) in the key signature, by pitch class of the major tonic. */
  const SHARPS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
  const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];

  /** MIDI meta text must be ASCII; fold our typographic sharps/flats. */
  const ascii = (s) => s.replace(/♯/g, '#').replace(/♭/g, 'b').replace(/[^\x20-\x7e]/g, '');

  const lensOn = (want) => want && typeof LiveLens !== 'undefined' && LiveLens.active();

  /** Chord symbol and roman numeral for the scale-degree chord `c`. */
  function chordName(song, c) {
    const s = song.scale;
    const pc = mod(song.tonicPc + s[c], 12);
    const minor = mod(s[(c + 2) % 7] - s[c], 12) === 3;
    return { sym: NOTE_NAMES[pc] + (minor ? 'm' : ''), roman: minor ? ROMAN[c] : ROMAN[c].toUpperCase() };
  }

  /** MIDI key signature: accidentals of the PARENT major scale, plus a minor flag. */
  function keySig(song) {
    const minor = song.modeName === 'Aeolian' || song.modeName === 'Harmonic minor';
    return [SHARPS[mod(song.tonicPc - MODE_OFFSET[song.modeName], 12)] & 0xff, minor ? 1 : 0];
  }

  /* ── Byte helpers ──────────────────────────────────────────────────── */

  /** Variable-length quantity, big-endian, 7 bits per byte. */
  function vlq(n) { const out = [n & 0x7f]; while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80); return out; }
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const text = (s) => Array.from(te.encode(ascii(s)));
  const meta = (t, type, bytes) => ({ t, pri: 0, d: [0xff, type, ...vlq(bytes.length), ...bytes] });

  /**
   * Serialize one track chunk.
   * Events are sorted by tick, then by priority: meta(0) → note-off(1) →
   * program change(2) → note-on(3). This ordering matters: a note-off for the
   * previous note must precede a note-on at the same tick, or sequencers eat it.
   */
  function serialize(evs) {
    evs.sort((a, b) => a.t - b.t || a.pri - b.pri);
    const out = [];
    let last = 0;
    for (const e of evs) {
      for (const b of vlq(e.t - last)) out.push(b);
      for (const b of e.d) out.push(b);
      last = e.t;
    }
    out.push(0x00, 0xff, 0x2f, 0x00);   // end of track
    return [0x4d, 0x54, 0x72, 0x6b, ...u32(out.length)].concat(out);
  }

  /**
   * Build the complete MIDI file.
   * @returns {Uint8Array}
   */
  function build(song, sigil, { loops = 1, bpm = song.bpm, lens = false } = {}) {
    const tick = (b) => Math.max(0, Math.round(b * PPQ));
    const tracks = Object.fromEntries(TRACKS.map(([id, name, ch]) => [id, { name, ch, notes: [], extra: [] }]));

    const useLens = lensOn(lens);
    const mapEv = useLens ? (e) => LiveLens.map(e, song) : (e) => e;
    const vel = (x) => clamp(Math.round(x * 100), 1, 127);

    const note = (trk, midi, b, dur, v, prog) => {
      if (midi < 0 || midi > 127) return;
      const s = tick(b);
      tracks[trk].notes.push({ s, e: Math.max(s + 1, tick(b + dur)), midi, vel: v, prog });
    };
    const vTrack = (p) => (p === 1 ? 'v2' : 'v3');

    const cond = [];   // the conductor track (track 0)

    for (let L = 0; L < loops; L++) {
      const o = L * song.total;

      for (const raw of song.events) {
        const ev = mapEv(raw), b = o + ev.beat;
        switch (ev.type) {
          case 'lead':  note(ev.part ? vTrack(ev.part) : 'lead', ev.midi, b, ev.dur, vel(ev.vel), GM[ev.timbre]); break;
          case 'bell':  note(ev.part ? vTrack(ev.part) : 'bell', ev.midi, b, Math.max(ev.dur, 1), vel(ev.vel), GM.bell); break;
          case 'harm':  note('harm', ev.midi, b, ev.dur, vel(ev.vel), GM.choir); break;
          case 'pad':   for (const m of ev.midis) note('pad', m, b, ev.dur, vel(ev.vel * 0.7), GM.pad); break;
          case 'bass':  note('bass', ev.midi, b, ev.dur, vel(ev.vel), GM.bass); break;
          case 'arp':   note('arp', ev.midi, b, ev.dur, vel(ev.vel * 0.8), GM.arp); break;
          case 'drone': note('drone', ev.midi, b, ev.dur, 60, GM.drone);
                        note('drone', ev.midi + 7, b, ev.dur, 50, GM.drone); break;
          case 'kick': case 'snare': case 'shaker': case 'crash': case 'rim':
                        note('drums', DRUM[ev.type], b, 0.25, vel(ev.vel * 1.1), null); break;
          case 'tom':   note('drums', TOMS[clamp(ev.tom | 0, 0, 2)], b, 0.25, vel(ev.vel * 1.1), null); break;
          case 'hat':   note('drums', ev.open ? DRUM.open : DRUM.hat, b, 0.25, vel(ev.vel), null); break;
        }
      }

      for (const sec of song.sections) cond.push(meta(tick(o + sec.start), 0x06, text(`${sec.roman}. ${sec.name}`)));

      for (const ph of song.phrases) {
        ph.chords.forEach((c, i) => {
          const n = chordName(song, useLens ? LiveLens.mapChord(c, song) : c);
          cond.push(meta(tick(o + ph.start + i * 4), 0x01, text(`${n.sym} (${n.roman})`)));
        });
        // The sigil's letters ride along as lyrics, aligned to the pen.
        for (const nd of ph.path) tracks.lead.extra.push(meta(tick(o + nd.beat), 0x05, text(nd.letter)));
      }
    }

    const us = Math.round(60e6 / bpm);
    cond.push(
      meta(0, 0x03, text(`SIGIL ${sigil.fusionKey || sigil.reduced}`)),
      meta(0, 0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]),
      meta(0, 0x58, [4, 2, 24, 8]),             // 4/4
      meta(0, 0x59, keySig(song)),
      meta(0, 0x01, text(`${song.keyName} - ${Math.round(bpm)} bpm - made with SIGIL`)));

    const chunks = [serialize(cond)];

    for (const [id] of TRACKS) {
      const t = tracks[id];
      if (!t.notes.length) continue;
      const evs = [meta(0, 0x03, text(t.name)), ...t.extra];

      /* Overlap repair. MIDI has no polyphonic note identity, so two
         simultaneous notes of the same pitch on the same channel would produce
         a stuck note. Identical onsets MERGE; a retrigger ends the earlier note
         exactly at the new onset. */
      t.notes.sort((a, b) => a.s - b.s);
      const open = new Map();
      for (const n of t.notes) {
        const prev = open.get(n.midi);
        if (prev && prev.s === n.s) { prev.vel = Math.max(prev.vel, n.vel); prev.e = Math.max(prev.e, n.e); n.skip = true; continue; }
        if (prev && prev.e > n.s) prev.e = n.s;
        open.set(n.midi, n);
      }

      let prog = -1;
      for (const n of t.notes) {
        if (n.skip) continue;
        if (t.ch !== 9 && n.prog != null && n.prog !== prog) { evs.push({ t: n.s, pri: 2, d: [0xc0 | t.ch, n.prog] }); prog = n.prog; }
        evs.push({ t: n.s, pri: 3, d: [0x90 | t.ch, n.midi, n.vel] });
        evs.push({ t: n.e, pri: 1, d: [0x80 | t.ch, n.midi, 0] });
      }
      chunks.push(serialize(evs));
    }

    const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, chunks.length, (PPQ >> 8) & 255, PPQ & 255];
    return new Uint8Array(header.concat(...chunks));
  }

  /** Plain-text lead sheet: one line of four bars per phrase. */
  function chordChart(song, sigil, lens) {
    const useLens = lensOn(lens);
    const bpm = Math.round(app.engine && app.engine.song === song ? 60 / app.engine.spb : song.bpm);
    const out = [`SIGIL ${sigil.fusionKey || sigil.reduced} — ${song.keyName} — ${bpm} bpm`, ''];

    song.sections.forEach((sec, si) => {
      out.push(`${sec.roman}. ${sec.name} — ${sec.desc}`);
      for (const ph of song.phrases.filter((p) => p.si === si)) {
        out.push('| ' + ph.chords.map((c) => {
          const n = chordName(song, useLens ? LiveLens.mapChord(c, song) : c);
          return `${n.sym} (${n.roman})`.padEnd(11);
        }).join('| ') + '|');
      }
      out.push('');
    });
    return out.join('\n');
  }

  /* ── Panel ─────────────────────────────────────────────────────────── */
  const state = { loops: 1, tempo: true, lens: true };
  let dlBtn, copyBtn;

  UI.section({ id: 'midi', title: 'Score · MIDI', order: 40, build(el) {
    dlBtn = UI.button('Download .mid', exportMidi, { disabled: true });
    copyBtn = UI.button('Copy chord chart', copyChart, { disabled: true });
    el.append(
      UI.note('A multitrack General MIDI score for your DAW: every instrument on its own track, section markers, chord names, and the sigil’s letters as lyrics.'),
      UI.select({ label: 'Length', value: 1, options: [['1', 'One pass'], ['2', 'Two passes'], ['4', 'Four passes']], onChange: (v) => (state.loops = +v) }),
      UI.check({ label: 'Use the current tempo', checked: true, onChange: (v) => (state.tempo = v) }),
      UI.check({ label: 'Apply the live lens', checked: true, onChange: (v) => (state.lens = v) }),
      h('div', { class: 'sgrow' }, dlBtn, copyBtn));
  } });

  const enable = (on) => { if (dlBtn) { dlBtn.disabled = !on; copyBtn.disabled = !on; } };
  Hooks.on('song', () => enable(true));
  Hooks.on('forget', () => enable(false));

  function exportMidi() {
    const { song, sigil } = app;
    if (!song) return;
    const bpm = state.tempo && app.engine && app.engine.song === song ? 60 / app.engine.spb : song.bpm;
    const bytes = build(song, sigil, { loops: state.loops, bpm, lens: state.lens });
    download(new Blob([bytes], { type: 'audio/midi' }), `sigil-${UI.fileKey()}.mid`);
    UI.announce('MIDI file saved.');
  }

  function copyChart() {
    const t = chordChart(app.song, app.sigil, state.lens);
    const ok = () => toast('Chord chart copied', true);
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(ok).catch(() => prompt('Copy the chart', t));
    else prompt('Copy the chart', t);
  }

  return { build, chordChart, chordName };
})();