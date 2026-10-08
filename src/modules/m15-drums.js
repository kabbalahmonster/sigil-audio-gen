'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m15 · DRUM ENGINE — a kit that belongs to this song
   --------------------------------------------------------------------------
   IN KEY    every drum is tuned to the chord sounding beneath it. The kick's
             body lands on the bass root, the snare's shell sings a twelfth
             above it, and the toms of the fills are chord tones.

   ROUTING   music → duck → crusher → tone
             drums → drumSum → roomSend → tone
             The kick ducks the music and never itself, which is what makes a
             loud kick sit in a dense mix without turning the whole thing down.

   KICK      body · second-harmonic snap · sub tail · beater click · saturation
   SNARE     tonal shell · bandpassed body · highpassed crack · ghost layer
   HAT       three inharmonic square partials plus noise, with a choke group
   RIDE      open hats become a ride-like wash at low intensity
   SHAKER · CRASH   noise, with a metallic partial cluster for the crash

   DRUM CUBE drumX is size (tight → cavernous), drumY is colour (round → hard).
             Both move per section, through the sound arc in m11.

   PRIORITY 10: runs after m11, which ignores drums, so this is the last word.
   ══════════════════════════════════════════════════════════════════════════ */

const DrumEngine = (() => {
  'use strict';
  const SD = SoundDesign;
  const DRUMS = new Set(['kick', 'snare', 'hat', 'shaker', 'crash']);
  const HAT_RATIOS = [1, 1.4471, 1.6170, 1.9265];     // 808-style inharmonic cluster
  const METAL_RATIOS = [1, 1.4, 1.67, 2.1, 2.66];

  /* ── Musical context ─────────────────────────────────────────────────── */

  /** The chord sounding at a beat. */
  function chordAt(song, beat) {
    let ph = song.phrases[0];
    for (const p of song.phrases) {
      if (beat >= p.start) ph = p; else break;
    }
    const bar = clamp(Math.floor((beat - ph.start) / 4), 0, 3);
    return ph.chords[bar];
  }

  /** The MIDI root of the current chord, in the bass register. */
  function rootAt(song, beat) {
    return bassPitch(chordAt(song, beat), 'root', song.bassBase, song.scale);
  }

  const letterAt = (beat) => {
    const s = app.sigil;
    return s ? s.reduced[mod(Math.round(beat * 4), s.reduced.length)] : 'T';
  };
  const toneAt = (beat) => SD.CLASS_TONE[SD.CONSONANT_CLASS[letterAt(beat)] || 'fricative'];

  /* ── Routing ─────────────────────────────────────────────────────────── */

  function route(eng) {
    const ctx = eng.ctx;

    if (!eng.duck) eng.duck = ctx.createGain();
    if (!eng.drumSum) {
      eng.drumSum = ctx.createGain();
      eng.drumRoom = ctx.createGain();          // the kit's own reverb send
      eng.drumRoom.gain.value = 0.1;
      eng.drumSum.connect(eng.tone);
      eng.drumSum.connect(eng.drumRoom);
      eng.drumRoom.connect(eng.reverb);
    }

    // music → duck → (crusher or tone)
    try { eng.mix.disconnect(); } catch { /* nothing attached yet */ }
    eng.mix.connect(eng.duck);
    try { eng.duck.disconnect(); } catch { /* ditto */ }
    eng.duck.connect(eng.sfx || eng.tone);

    // drums leave the mix and go straight to their own sum
    if (eng.buses && eng.buses.drums) {
      try { eng.buses.drums.disconnect(eng.mix); } catch { /* was not connected */ }
      eng.buses.drums.connect(eng.drumSum);
    }
    eng.duck.gain.cancelScheduledValues(ctx.currentTime);
    eng.duck.gain.setValueAtTime(1, ctx.currentTime);
  }
  Hooks.on('buses', (_b, eng) => route(eng), 10);

  /** Pull the music down by `depth` for `len` seconds, starting at t. */
  function duck(eng, t, depth, len) {
    if (!eng.duck || depth <= 0) return;
    const g = eng.duck.gain;
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(Math.max(0.15, 1 - depth), t + 0.006);
    g.linearRampToValueAtTime(1, t + len);
  }

  function toBus(eng, node, pan = 0, bus) {
    const dest = bus || eng.buses.drums;
    if (eng.ctx.createStereoPanner) {
      const p = eng.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      node.connect(p); p.connect(dest);
    } else node.connect(dest);
  }

  /* ── Kick ────────────────────────────────────────────────────────────── */

  function kick(eng, t, vel, P, root) {
    const ctx = eng.ctx, K = P.kit, lvl = P.drums;
    const size = (0.3 + 0.7 * P.drumX) * (0.5 + 0.5 * K.decay);
    const colour = P.drumY;
    const f = mtof(root) * (K.kickOct ? 2 : 1);

    // Chain: sum → pre-gain → saturation → level → drum bus.
    const out = ctx.createGain();
    const pre = ctx.createGain();
    pre.gain.value = 1 + 1.6 * K.punch;
    const shaper = ctx.createWaveShaper();
    shaper.curve = eng.satCurve;
    shaper.oversample = '2x';
    const post = ctx.createGain();
    post.gain.value = 0.8 * lvl;
    out.connect(pre); pre.connect(shaper); shaper.connect(post);
    post.connect(eng.buses.drums);

    // Body: a pitch drop into the chord root.
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(f * 2.6, t);
    body.frequency.exponentialRampToValueAtTime(f, t + 0.03 + 0.02 * size);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(vel * 0.9, t + 0.002);
    bg.gain.setTargetAtTime(0, t + 0.002, 0.05 + 0.16 * size);
    body.connect(bg); bg.connect(out);
    body.start(t); body.stop(t + 0.9 + size * 0.6);

    // Second-harmonic snap: the part you hear on a laptop speaker.
    const h2 = ctx.createOscillator();
    h2.type = 'triangle';
    h2.frequency.setValueAtTime(f * 3.1, t);
    h2.frequency.exponentialRampToValueAtTime(f * 2, t + 0.015);
    const h2g = ctx.createGain();
    h2g.gain.setValueAtTime(vel * (0.12 + 0.3 * colour), t);
    h2g.gain.setTargetAtTime(0, t + 0.002, 0.012 + 0.01 * colour);
    h2.connect(h2g); h2g.connect(out);
    h2.start(t); h2.stop(t + 0.25);

    // Sub tail: the root itself, long, carrying the room.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(vel * 0.6, t);
    sg.gain.setTargetAtTime(0, t + 0.03, 0.08 + 0.25 * size);
    sub.connect(sg); sg.connect(out);
    sub.start(t); sub.stop(t + 1.6);

    // Beater click.
    const n = eng.noise(t, 0.03);
    const bpf = eng.filt('bandpass', 1600 + 2400 * colour, 1.1);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * 0.35 * K.click, t);
    ng.gain.setTargetAtTime(0, t + 0.001, 0.0035);
    n.connect(bpf); bpf.connect(ng); ng.connect(out);

    duck(eng, t, 0.45 * lvl * (0.5 + 0.5 * K.punch) * vel, 0.08 + 0.18 * size);
  }

  /* ── Snare ───────────────────────────────────────────────────────────── */

  function snare(eng, t, vel, P, root, beat) {
    const ctx = eng.ctx, K = P.kit, lvl = P.drums, tone = toneAt(beat);
    const colour = P.drumY, size = 0.3 + 0.7 * P.drumX;
    const ghost = vel < 0.3;

    // Tonal shell, a twelfth above the root, so it sings with the chord.
    const shell = mtof(root + 19) * (0.92 + 0.2 * K.body);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(shell * 1.35, t);
    o.frequency.exponentialRampToValueAtTime(shell, t + 0.035);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vel * (ghost ? 0.2 : 0.42) * lvl, t);
    og.gain.setTargetAtTime(0, t + 0.002, (0.025 + 0.05 * K.snap) * size);
    o.connect(og); og.connect(eng.buses.drums);
    o.start(t); o.stop(t + 0.4);

    // Noise body.
    const n = eng.noise(t, 0.6);
    const bp = eng.filt('bandpass', (1100 + 1500 * K.noiseTone) * tone[0] * (0.8 + 0.4 * colour), 0.8);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * (ghost ? 0.3 : 0.55) * lvl * tone[2], t);
    ng.gain.setTargetAtTime(0, t + 0.002, (0.05 + 0.17 * K.snap) * tone[1] * size);
    n.connect(bp); bp.connect(ng);
    toBus(eng, ng, 0.05);

    // Crack.
    if (!ghost) {
      const n2 = eng.noise(t, 0.03);
      const hp = eng.filt('highpass', 4200 + 1400 * K.noiseTone, 0.6);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(vel * 0.22 * lvl * (0.5 + colour), t);
      cg.gain.setTargetAtTime(0, t + 0.001, 0.006);
      n2.connect(hp); hp.connect(cg);
      toBus(eng, cg, -0.05);
      duck(eng, t, 0.18 * lvl * vel, 0.12);
    }
  }

  /* ── Hats, with a choke group ────────────────────────────────────────── */

  function hat(eng, t, vel, P, open, beat, pan) {
    const ctx = eng.ctx, K = P.kit, lvl = P.drums, tone = toneAt(beat);
    const base = 300 * (1 + 0.15 * K.hatTone) * tone[0];
    const len = open ? (0.42 + 0.4 * K.hatDecay) * (0.6 + 0.8 * P.drumX) : 0.05 + 0.06 * K.hatDecay;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.1 * lvl * tone[2], t + 0.001);
    g.gain.setTargetAtTime(0, t + 0.001, len * 0.3);

    const hp = eng.filt('highpass', 6500 + 2500 * K.hatTone, 0.6);
    hp.connect(g);
    const partials = [];
    for (const r of HAT_RATIOS) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = base * r;
      const og = ctx.createGain();
      og.gain.value = 0.5 / HAT_RATIOS.length;
      o.connect(og); og.connect(hp);
      o.start(t); o.stop(t + len * 1.3 + 0.05);
      partials.push(o);
    }

    const n = eng.noise(t, 0.35);
    const bp = eng.filt('bandpass', 9000 + 3000 * K.hatTone, 1.1);
    const ng = ctx.createGain();
    ng.gain.value = 0.35 + 0.4 * P.drumY;
    n.connect(bp); bp.connect(ng); ng.connect(g);

    // Choke: a new hat cuts the previous open one, as a real hi-hat does.
    if (eng.openHat && eng.openHat.until > t) {
      const prev = eng.openHat;
      prev.gain.gain.cancelScheduledValues(t);
      prev.gain.gain.setTargetAtTime(0, t, 0.006);
    }
    if (open) eng.openHat = { gain: g, until: t + len * 1.3 };

    toBus(eng, g, pan * (K.width || 0.5));
  }

  /* ── Shaker and crash ────────────────────────────────────────────────── */

  function shaker(eng, t, vel, P, pan) {
    const n = eng.noise(t, 0.2);
    const bp = eng.filt('bandpass', 5200 + 2600 * P.kit.hatTone, 1.2);
    const g = eng.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.12 * P.drums, t + 0.014);
    g.gain.setTargetAtTime(0, t + 0.014, 0.024);
    n.connect(bp); bp.connect(g);
    toBus(eng, g, pan);
  }

  function crash(eng, t, vel, P) {
    const ctx = eng.ctx, K = P.kit;
    const bus = eng.buses.bell || eng.buses.drums;
    const len = (0.9 + 0.6 * K.hatDecay) * (0.7 + 0.7 * P.drumX);
    const n = eng.noise(t, 2.2);
    const hp = eng.filt('highpass', 3600, 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * 0.12 * P.drums, t);
    g.gain.setTargetAtTime(0, t + 0.01, len * 0.35);
    n.connect(hp); hp.connect(g); g.connect(bus);

    for (const r of METAL_RATIOS) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 410 * r * (0.9 + 0.25 * K.hatTone);
      const og = ctx.createGain();
      og.gain.setValueAtTime(vel * 0.02 * P.drums, t);
      og.gain.setTargetAtTime(0, t + 0.01, len * 0.3);
      const hp2 = eng.filt('highpass', 2800, 0.7);
      o.connect(og); og.connect(hp2); hp2.connect(bus);
      o.start(t); o.stop(t + len * 1.4);
    }
    duck(eng, t, 0.12 * P.drums, 0.2);
  }

  /* ── The hook ────────────────────────────────────────────────────────── */

  Hooks.on('voice', (_, ev, t, eng) => {
    if (Sound.mode !== 'sigil' || !eng.sig || !eng.buses || !DRUMS.has(ev.type)) return undefined;
    const P = Sound.paramsAt(eng, ev.beat);
    if (!P) return undefined;
    if (P.drums <= 0.001) return true;

    const song = app.song;
    const root = song ? rootAt(song, ev.beat) : 33;
    const vel = ev.vel, pan = ev.pan || 0;

    switch (ev.type) {
      case 'kick':   kick(eng, t, vel, P, root); break;
      case 'snare':  snare(eng, t, vel, P, root, ev.beat); break;
      case 'hat':    hat(eng, t, vel, P, !!ev.open, ev.beat, pan); break;
      case 'shaker': shaker(eng, t, vel, P, pan); break;
      case 'crash':  crash(eng, t, vel, P); break;
    }
    return true;
  }, 10);

  return { chordAt, rootAt };
})();

if (typeof window !== 'undefined') window.DrumEngine = DrumEngine;