'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §7  RENDERER (Canvas 2D)
   --------------------------------------------------------------------------
   The renderer OWNS NO CLOCK. Each frame it asks the engine what beat it is
   and draws the state of the score at that beat, so visuals cannot drift from
   the audio. If the audio pauses, the pen stops; on seek, the drawing jumps.

   LAYERS (back to front)
     ground & vignette → drifting motes → wheel (circles, ticks, letters,
     tonic triangle) → rhythm polygons → ghosts of past transformations →
     faint template → fading previous phrase → live stroke + pen →
     note flares → start circle / end bar → centre bindu & snare ripple
     → module overlays (Hooks 'drawPlaying') → charge breath ring → particles

   Lines use ADDITIVE blending with three stroke widths to suggest ink that
   glows like an ember, without the cost of a blur filter.

   MODULE SURFACE
     renderer.motes   swapped out by M5 Access (reduced motion)
     renderer.spawn   wrapped by M5 Access (spark suppression)
     renderer.pal     overwritten by applyPalette()
     renderer.info    { si, letter, beat } — read by the HUD and by M4/M9
     'drawPlaying'    the overlay hook; push into `lines` so Forget burns you
   ══════════════════════════════════════════════════════════════════════════ */

class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');

    /** The frame: centre, radius, and the seal's base orientation. */
    this.F = { cx: 0, cy: 0, R: 100, base: 0 };

    this.pal = PALETTES[0];
    this.parts = [];      // particles (sparks, embers)
    this.lastLines = [];  // every stroke drawn this frame, for burn()
    this.info = null;     // published state for the HUD

    // Dust in a shaft of light. Positions are normalized 0…1.
    this.motes = Array.from({ length: 70 }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.004,
      vy: -(0.002 + Math.random() * 0.006),
      ph: Math.random() * TAU,
      s: Math.random() * 1.3 + 0.3,
    }));

    this.last = performance.now() / 1000;
    this.resize(true);
    addEventListener('resize', () => this.resize(false));
  }

  resize(first) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);  // cap at 2: 3× costs more than it shows
    this.w = innerWidth; this.h = innerHeight;
    this.cv.width = Math.round(this.w * this.dpr);
    this.cv.height = Math.round(this.h * this.dpr);
    if (first) Object.assign(this.F, this.targetFrame(false));
  }

  /** Layout: the sigil sits above the UI normally; centred and enlarged when charging. */
  targetFrame(charging) {
    const w = this.w, h = this.h;
    return charging
      ? { cx: w / 2, cy: h / 2,     R: Math.min(w, h) * 0.36 }
      : { cx: w / 2, cy: h * 0.43,  R: Math.min(w * 0.33, h * 0.28) };
  }

  /* ── §7.1 Primitives ───────────────────────────────────────────────── */

  /**
   * Draw a polyline three times — wide and faint, medium, then hairline — under
   * 'lighter' compositing. The result reads as glowing ink at a fraction of the
   * cost of shadowBlur or a real blur filter.
   */
  strokeGlow(pts, col, alpha, width) {
    if (pts.length < 4) return;
    const g = this.g, p = new Path2D();
    p.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);

    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = rgba(col, alpha * 0.07); g.lineWidth = width * 7;   g.stroke(p);
    g.strokeStyle = rgba(col, alpha * 0.2);  g.lineWidth = width * 2.6; g.stroke(p);
    g.strokeStyle = rgba(col, alpha);        g.lineWidth = width;       g.stroke(p);
  }

  circle(x, y, r, col, a, fill = false, lw = 1) {
    const g = this.g;
    g.beginPath();
    g.arc(x, y, Math.max(0.1, r), 0, TAU);
    if (fill) { g.fillStyle = rgba(col, a); g.fill(); }
    else { g.strokeStyle = rgba(col, a); g.lineWidth = lw; g.stroke(); }
  }

  /** Emit a particle, with a hard cap so a long session cannot grind to a halt. */
  spawn(x, y, o) {
    if (this.parts.length > 2000) return;
    this.parts.push({ x, y, vx: o.vx, vy: o.vy, life: o.life, max: o.life, size: o.size, col: o.col });
  }

  /* ── §7.2 Composite elements ───────────────────────────────────────── */

  /**
   * The wheel: outer circles, 21 ticks, the letters, faint ring guides, and the
   * "tonic triangle" joining frame positions 0, 7 and 14 — the three places
   * where a melody degree is congruent to the tonic.
   */
  drawWheel(F, letters, T, o) {
    const g = this.g, L = this.pal.line, A = this.pal.accent, a = o.alpha ?? 1;

    this.circle(F.cx, F.cy, F.R, L, (0.3 + 0.35 * (o.kick || 0)) * a);  // pulses with the kick
    this.circle(F.cx, F.cy, F.R * 1.045, L, 0.14 * a);

    g.setLineDash([1.5, 7]);
    RINGS.forEach((r) => this.circle(F.cx, F.cy, F.R * r, L, 0.08 * a));
    g.setLineDash([]);

    g.beginPath();
    for (let j = 0; j < 3; j++) {
      const [x, y] = polar(j * 7, 1, ID_T, F);
      j ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
    g.strokeStyle = rgba(L, 0.055 * a); g.lineWidth = 1; g.stroke();

    const fs = Math.max(10, F.R * 0.062);
    g.font = `${fs}px ${SERIF}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';

    for (let s = 0; s < SLOTS; s++) {
      const [x0, y0] = polar(s, 1, T, F), [x1, y1] = polar(s, 1.045, T, F);
      g.strokeStyle = rgba(L, 0.28 * a); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();

      const letter = letters[s];
      const inS = o.set && o.set.has(letter);       // a letter of this sigil
      const cur = o.current === letter;             // the letter now sounding
      const [lx, ly] = polar(s, 1.15, T, F);

      if (cur) { g.shadowColor = rgba(A, 0.9); g.shadowBlur = 14; }
      g.fillStyle = cur ? rgba(A, a) : rgba(L, (inS ? 0.62 : 0.16) * a);
      g.fillText(letter, lx, ly);
      if (cur) g.shadowBlur = 0;
    }
  }

  /** Euclidean rhythms drawn as polygons at the hub, with a rotating step marker. */
  drawRhythm(F, P, beat, kp, alpha) {
    const g = this.g, L = this.pal.line, A = this.pal.accent;

    const poly = (pat, rf, al) => {
      const pts = [];
      for (let i = 0; i < 16; i++) if (pat[i]) {
        const th = (TAU * i) / 16;
        pts.push(F.cx + Math.sin(th) * rf * F.R, F.cy - Math.cos(th) * rf * F.R);
      }
      if (pts.length < 4) return;
      g.beginPath(); g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.closePath();
      g.strokeStyle = rgba(L, al); g.lineWidth = 1; g.stroke();
    };

    poly(P.hat, 0.2, 0.09 * alpha);
    poly(P.kick, 0.12, (0.08 + 0.3 * kp) * alpha);

    const th = (TAU * Math.floor(mod(beat, 4) * 4)) / 16;
    this.circle(F.cx + Math.sin(th) * 0.2 * F.R, F.cy - Math.cos(th) * 0.2 * F.R, 1.6, A, 0.7 * alpha, true);
  }

  /** Traditional sigil terminals: a small circle at the start, a crossbar at the end. */
  drawTerminals(pts, F, alpha, ended) {
    const L = this.pal.line;
    this.circle(pts[0], pts[1], F.R * 0.028, L, 0.85 * alpha, false, 1.3);

    if (ended && pts.length >= 4) {
      const n = pts.length, x = pts[n - 2], y = pts[n - 1];
      let dx = x - pts[n - 4], dy = y - pts[n - 3];
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const h = F.R * 0.045;
      this.strokeGlow([x - dy * h, y + dx * h, x + dy * h, y - dx * h], L, 0.9 * alpha, 1.4);
    }
  }

  /* ── §7.3 Main frame ───────────────────────────────────────────────── */

  draw(app) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, now - this.last);   // clamp so a stalled tab cannot leap
    this.last = now;

    const g = this.g, w = this.w, h = this.h, F = this.F;

    // Frame-rate independent easing toward the target layout.
    const tf = this.targetFrame(app.charging), k = 1 - Math.pow(0.03, dt);
    F.cx += (tf.cx - F.cx) * k;
    F.cy += (tf.cy - F.cy) * k;
    F.R  += (tf.R  - F.R)  * k;

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    g.fillStyle = this.pal.bg;
    g.fillRect(0, 0, w, h);

    const vg = g.createRadialGradient(F.cx, F.cy, F.R * 0.1, F.cx, F.cy, Math.max(w, h) * 0.75);
    vg.addColorStop(0, rgba(this.pal.accent, 0.045));
    vg.addColorStop(0.45, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.62)');
    g.fillStyle = vg; g.fillRect(0, 0, w, h);

    g.globalCompositeOperation = 'lighter';   // everything from here glows

    for (const m of this.motes) {
      m.x = mod(m.x + m.vx * dt, 1);
      m.y = mod(m.y + m.vy * dt, 1);
      m.ph += dt * 0.7;
      this.circle(m.x * w, m.y * h, m.s, this.pal.line, 0.05 + 0.05 * Math.sin(m.ph), true);
    }

    if (app.mode === 'idle') {
      F.base = 0;
      // The alphabetical wheel, turning slowly, waiting for a desire.
      this.drawWheel(F, CONSONANTS, { phi: now * 0.02, s: 1 },
                     { alpha: 0.55 + 0.1 * Math.sin(now * 0.6) });
    }
    else if (app.mode === 'reducing') this.drawReducing(app, now);
    else if (app.mode === 'playing')  this.drawPlaying(app, dt);
    else if (app.mode === 'burning')  this.drawBurning(app, now);

    /* Particles. Integrated last so sparks sit over everything.
       Swap-and-pop removal keeps this O(n) with no allocation. */
    g.globalCompositeOperation = 'lighter';
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) { this.parts[i] = this.parts[this.parts.length - 1]; this.parts.pop(); continue; }
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 - 8 * dt;    // negative gravity: embers rise
      p.x += p.vx * dt; p.y += p.vy * dt;
      g.fillStyle = rgba(p.col, (p.life / p.max) * 0.85);
      g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }

  /** Reduction: the seal's own wheel fades in and each chimed letter extends the path. */
  drawReducing(app, now) {
    const sig = app.sigil, F = this.F;
    F.base = sig.baseAngle;

    const a = clamp((now - app.reduceStart) / 2.5, 0, 1);
    this.drawWheel(F, sig.wheel, ID_T, {
      alpha: a * 0.75,
      set: new Set(sig.nodes.slice(0, app.lit).map((n) => n.letter)),
    });

    if (app.lit >= 1) {
      const pts = tracePoints(sig.nodes, sig.curves, ID_T, F, app.lit - 1);
      this.strokeGlow(pts, this.pal.line, 0.55, 1.2);
      this.drawTerminals(pts, F, 0.6, false);
      const n = nodeXY(sig.nodes[app.lit - 1], ID_T, F);
      this.circle(n[0], n[1], 4, this.pal.accent, 0.9, true);
    }
  }

  drawPlaying(app, dt) {
    const song = app.song, sig = app.sigil, F = this.F;
    const L = this.pal.line, A = this.pal.accent;
    F.base = sig.baseAngle;

    const beat = app.engine.beatNow();
    const si = sectionIndexAt(song, beat), sec = song.sections[si];

    /* Every transform passes through the 'viewT' filter, so modules (the Live
       Lens) can compose their own rotation or mirror on top of the section's. */
    const view = (T, ghost) => Hooks.filter('viewT', T, { beat, song, ghost });
    const T = view(displayTransform(song, beat), false);

    const pi = phraseIndexAt(song, beat), ph = song.phrases[pi];
    const prog = penProgress(ph, beat);
    const cur = ph.path[Math.min(ph.path.length - 1, Math.floor(prog + 1e-6))];

    const kp = pulse(song.kicks, beat, 5);     // fast decay: a thump
    const sp = pulse(song.snares, beat, 1.4);  // slow decay: an expanding ripple

    const outro = song.sections[song.sections.length - 1];
    const outroFade = si === song.sections.length - 1
      ? 1 - clamp((beat - outro.start) / 16, 0, 1) : 1;

    const lines = [];   // everything burnable, collected for burn()

    this.drawWheel(F, sig.wheel, T, { alpha: 1, kick: kp, set: sig.letterSet, current: cur.letter });
    if (sec.intensity >= 2) this.drawRhythm(F, song.P, beat, kp, 1);

    /* Ghosts: one faint copy of the path for every DISTINCT transformation
       already performed, so the seal accumulates its own history. */
    const seen = new Set([sec.key]);
    for (let i = 0; i < si; i++) {
      const s = song.sections[i];
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      const pts = tracePoints(sig.nodes, sig.curves, view(s.Tdisp, true), F, sig.nodes.length - 1);
      this.strokeGlow(pts, L, 0.12 * outroFade, 0.8);
      lines.push(pts);
    }

    // The template: where the pen is going.
    const full = tracePoints(ph.seq, ph.curves, T, F, ph.seq.length - 1);
    this.strokeGlow(full, L, 0.06, 0.8);
    lines.push(full);

    // The previous phrase, fading over 3 beats.
    if (pi > 0) {
      const fa = 1 - (beat - ph.start) / 3;
      if (fa > 0) {
        const prev = song.phrases[pi - 1];
        this.strokeGlow(tracePoints(prev.seq, prev.curves, T, F, prev.seq.length - 1), L, 0.5 * fa, 1.2);
      }
    }

    // The live stroke.
    const pts = tracePoints(ph.seq, ph.curves, T, F, prog);
    this.strokeGlow(pts, L, 0.95, 1.2 + 0.25 * sec.intensity);
    lines.push(pts);
    this.drawTerminals(pts, F, 1, prog >= ph.seq.length - 1);

    // Node dots, plus an expanding flare for 2 beats after each note sounds.
    ph.path.forEach((n) => {
      const [x, y] = nodeXY(n, T, F), age = beat - n.beat;
      this.circle(x, y, 1.7, L, 0.45, true);
      if (age >= 0 && age < 2) {
        const q = age / 2;
        this.circle(x, y, 3 + F.R * 0.07 * q, A, 0.7 * (1 - q), false, 1.2);
      }
    });

    // The pen: a radial glow, a white-hot tip, and a trail of sparks.
    const px = pts[pts.length - 2], py = pts[pts.length - 1];
    const frac = prog - Math.floor(prog);
    const gr = this.g.createRadialGradient(px, py, 0, px, py, 16);
    gr.addColorStop(0, rgba(A, 0.55));
    gr.addColorStop(1, rgba(A, 0));
    this.g.fillStyle = gr;
    this.g.fillRect(px - 16, py - 16, 32, 32);
    this.circle(px, py, 2.2, [255, 250, 240], 0.95, true);

    if (frac > 0.02 && frac < 0.98 && Math.random() < 0.8) {
      this.spawn(px, py, {
        vx: (Math.random() - 0.5) * 30,
        vy: (Math.random() - 0.5) * 30 - 8,
        life: 0.5 + Math.random() * 0.7,
        size: 1 + Math.random(),
        col: A,
      });
    }

    // Centre bindu (kick) and snare ripple.
    this.circle(F.cx, F.cy, 1.8 + kp * 3, A, 0.5 + kp * 0.5, true);
    if (sp > 0.02) this.circle(F.cx, F.cy, F.R * (0.1 + (1 - sp) * 0.95), L, 0.16 * sp, false, 1);

    /* Extension point: modules draw on top (fusion voices, session ring…).
       They may push into `lines` so that Forget burns their strokes too. */
    Hooks.emit('drawPlaying', { r: this, g: this.g, F, T, beat, song, sig, ph, pi, sec, si, kp, sp, lines, app });

    // Charge mode: a breath ring on an 8-beat cycle.
    if (app.charging) {
      const br = 0.5 - 0.5 * Math.cos((TAU * beat) / 8);
      this.circle(F.cx, F.cy, F.R * (1.2 + 0.09 * br), A, 0.1 + 0.15 * br, false, 1);
    }

    this.lastLines = lines;
    this.info = { si, letter: cur.letter, beat };
  }

  /* ── §7.4 The Banishing ────────────────────────────────────────────── */

  /** Forget: every line drawn in the last frame breaks into embers and rises. */
  burn() {
    this.burnLines = this.lastLines;
    this.burnStart = performance.now() / 1000;

    for (const pts of this.lastLines) {
      for (let i = 0; i < pts.length; i += 6) {
        this.spawn(pts[i], pts[i + 1], {
          vx: (Math.random() - 0.5) * 40,
          vy: -(10 + Math.random() * 55),
          life: 1.4 + Math.random() * 2.8,
          size: 1 + Math.random() * 1.8,
          col: Math.random() < 0.55 ? this.pal.accent : this.pal.line,
        });
      }
    }
  }

  drawBurning(app, now) {
    const e = now - (this.burnStart || now), F = this.F;
    if (app.sigil) this.drawWheel(F, app.sigil.wheel, ID_T, { alpha: clamp(1 - e / 2.5, 0, 1) * 0.8 });

    const a = clamp(1 - e / 1.3, 0, 1);
    if (a > 0 && this.burnLines) {
      for (const pts of this.burnLines) this.strokeGlow(pts, this.pal.accent, 0.7 * a, 1.2);
    }
  }
}