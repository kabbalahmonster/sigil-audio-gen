'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §8  APPLICATION — ritual flow, HUD, controls, export, boot
   --------------------------------------------------------------------------
   STATE MACHINE
     idle ──cast──► reducing ──► playing ⇄ (charge)
        ▲                            │
        └──── new / forget ◄─────────┘ ──► burning ──► idle

   `app` is the single mutable state object. Modules read it; they should
   never replace it. Mutations go through the functions in this file, which
   keep the DOM, the engine and the renderer in agreement.

   FACADE. At the end of this file we publish `SigilCore`: one object naming
   the core's public surface. New modules should depend on SigilCore rather
   than on bare globals. The bare globals remain for back-compatibility.
   ══════════════════════════════════════════════════════════════════════════ */

/** Global application state. See the state machine above. */
const app = {
  mode: 'idle',         // 'idle' | 'reducing' | 'playing' | 'burning'
  sigil: null,          // current sigil object (§3)
  song: null,           // current song object (§5)
  engine: null,         // Engine instance, created on first cast (§6)
  charging: false,      // Charge mode flag
  lit: 0,               // how many consonants have been named during reduction
  busy: false,          // true while a cast or burn is in progress (blocks re-entry)
  reduceStart: 0,       // seconds; reference for the wheel's fade-in
  rec: null,            // MediaRecorder instance while recording
};

const renderer = new Renderer($('#stage'));

/** Per-HUD cache so we only touch the DOM when something changes. */
const hud = { si: -1, letter: null, spans: [] };

/** Names of the three lead timbres, for display. */
const TIMBRE_NAMES = { glass: 'glass bell', reed: 'reed', koto: 'plucked string' };

/**
 * Apply a palette to the CSS custom properties and the renderer.
 * The 'palette' filter lets High Contrast (M5) and Hours & Moon (M10) override
 * it. The UNFILTERED palette is remembered so UI.refreshPalette() can re-run
 * the filters later (for example when the user toggles contrast).
 */
function applyPalette(p) {
  app.basePalette = p;
  p = Hooks.filter('palette', p, app.sigil);
  renderer.pal = p;
  const s = document.documentElement.style;
  s.setProperty('--bg', p.bg);
  s.setProperty('--line', p.line.join(','));
  s.setProperty('--accent', p.accent.join(','));
}

/**
 * The HUD meta line, built as an array so modules can edit individual parts
 * through the 'meta' filter (M2 shows the tempo, M6 the mood, M10 the hour).
 */
function renderMeta() {
  const { sigil, song } = app;
  if (!song || !sigil) return;
  const parts = [song.keyName, `${song.bpm} bpm`, TIMBRE_NAMES[song.leadTimbre],
                 renderer.pal.name, sigil.hex.slice(0, 8)];
  $('#meta').textContent = Hooks.filter('meta', parts, app).join(' · ');
}

/**
 * The URL fragment for the current sigil. Fusion (M8) and Moods (M6) extend it,
 * for example to `#KRST+MNL~ambient`.
 */
function shareKey() {
  return app.sigil ? Hooks.filter('shareKey', app.sigil.reduced, app.sigil) : '';
}

/** Show a fleeting line of oracle text. `small` places it at the foot of the screen. */
function toast(text, small = false, ms = 2200) {
  const t = $('#toast');
  t.textContent = text;
  t.className = small ? 'small show' : 'show';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = small ? 'small' : ''), ms);
}

/** Show an error under the invocation field for four seconds. */
function flashErr(msg) {
  $('#err').textContent = msg;
  clearTimeout(flashErr.t);
  flashErr.t = setTimeout(() => ($('#err').textContent = ''), 4000);
}

/**
 * Cast a desire: reduce it, build the sigil, compose the song, perform the
 * reduction ceremony, then start the performance.
 *
 * @param {object} [opts]
 * @param {string}  [opts.text]      desire text (defaults to the input field)
 * @param {string[]} [opts.partners] extra desires or consonant strings (Fusion)
 * @param {string}  [opts.preset]    mood id (Moods)
 * @param {boolean} [opts.quick]     short reduction animation (Grimoire replays)
 */
async function cast(opts = {}) {
  if (app.busy) return;
  // Called directly as a click handler, `opts` is an Event: ignore it.
  if (!opts || opts instanceof Event) opts = {};

  const text = String(opts.text ?? $('#desire').value).trim();
  if (!text) { flashErr('Speak a desire first.'); return; }

  const { chars, reduced } = reduceDesire(text);
  if (reduced.length < 3) { flashErr('Too little remains after reduction. Say more.'); return; }

  const ctx = { text, reduced, opts };
  Hooks.emit('beforeCast', ctx);

  // M8 may return a fused sigil, or an { error } object to refuse the cast.
  const sigil = Hooks.filter('buildSigil', null, ctx) || buildSigil(reduced);
  if (sigil.error) { flashErr(sigil.error); return; }

  app.busy = true;
  try {
    // Created inside a user gesture (click or Enter), to satisfy autoplay policy.
    if (!app.engine) app.engine = new Engine();
    try { await app.engine.ctx.resume(); } catch { /* ignore: some browsers refuse silently */ }

    if (app.mode === 'playing') { app.engine.stop(0.6); Hooks.emit('stop', 'recast'); }

    const song = composeSong(sigil);
    Object.assign(app, { sigil, song, lit: 0, reduceStart: performance.now() / 1000 });
    applyPalette(sigil.palette);
    app.engine.load(song);

    $('#invoke').classList.add('away');
    $('#desire').blur();
    $('#hud').classList.remove('on');
    app.mode = 'reducing';

    await performReduction(chars, sigil, song, !!opts.quick);

    buildHUD();
    app.engine.start(0.15);
    app.mode = 'playing';
    $('#hud').classList.add('on');
    setPauseLabel();
    history.replaceState(null, '', '#' + shareKey());

    Hooks.emit('cast', sigil, song, opts);
    Hooks.emit('song', sigil, song, { cast: true });
  } catch (e) {
    console.error('[cast]', e);
    flashErr('Something went wrong while casting. Please try again.');
  } finally {
    app.busy = false;
  }
}

/**
 * The striking-out ceremony, shown letter by letter, with quill ticks and chimes.
 * @param {{ch:string, fate:string}[]} chars from reduceDesire
 * @param {boolean} quick skip the long animation (used for Grimoire replays)
 */
async function performReduction(chars, sigil, song, quick = false) {
  const box = $('#reduction');
  box.innerHTML = '';

  const line = document.createElement('div');
  line.className = 'line';
  const spans = chars.map((c) => {
    const s = document.createElement('span');
    s.className = 'ch';
    s.dataset.fate = c.fate;
    s.textContent = c.fate === 'space' ? '\u00A0' : c.ch;
    line.appendChild(s);
    return s;
  });

  const cap = document.createElement('div');
  cap.className = 'cap';
  box.append(line, cap);
  box.classList.add('show');

  const kept = spans.filter((s) => s.dataset.fate === 'kept');

  if (quick) { // replays: already reduced, so just name the letters
    for (let i = 0; i < kept.length; i++) {
      kept[i].classList.add('lit');
      app.engine.chime(song.chimes[i]);
      app.lit = i + 1;
      await wait(90);
    }
    await wait(450);
    box.classList.remove('show');
    await wait(400);
    return;
  }

  await wait(700);
  cap.textContent = 'the vowels and the repetitions are struck away';

  // The strike pace is spread across ~1.5 s regardless of desire length.
  const struck = spans.filter((s) => s.dataset.fate !== 'kept');
  const step = clamp(1500 / Math.max(1, struck.length), 14, 55);
  for (const s of struck) {
    s.classList.add('struck');
    if (s.dataset.fate === 'vowel' || s.dataset.fate === 'repeat') app.engine.tick(s.dataset.fate);
    if (s.dataset.fate !== 'space') await wait(step);
  }

  await wait(450);
  cap.textContent = 'what remains is named';

  for (let i = 0; i < kept.length; i++) {
    kept[i].classList.add('lit');
    app.engine.chime(song.chimes[i]);
    app.lit = i + 1;
    await wait(clamp(2400 / kept.length, 120, 220));
  }

  await wait(700);
  line.classList.add('fade');
  cap.classList.add('fade');
  await wait(650);

  // Replace the struck line with the final consonant sequence.
  line.remove();
  cap.textContent = '';
  cap.classList.remove('fade');
  const fin = document.createElement('div');
  fin.className = 'final';
  [...sigil.reduced].forEach((L, i) => {
    const s = document.createElement('span');
    s.textContent = L;
    s.style.animationDelay = i * 70 + 'ms';
    fin.appendChild(s);
  });
  box.insertBefore(fin, cap);

  await wait(1200 + sigil.reduced.length * 70);
  box.classList.remove('show');
  await wait(500);
}

/* ── HUD ──────────────────────────────────────────────────────────────── */

/**
 * Build the per-song HUD: the letter strip, and a tick on the progress bar at
 * each section boundary. Called once per cast or recompose.
 */
function buildHUD() {
  const { sigil, song } = app;

  const L = $('#letters');
  L.innerHTML = '';
  hud.spans = [...sigil.reduced].map((ch) => {
    const s = document.createElement('span');
    s.textContent = ch;
    L.appendChild(s);
    return s;
  });

  const prog = $('#progress');
  prog.querySelectorAll('.mark').forEach((m) => m.remove());
  song.sections.forEach((s) => {
    const m = document.createElement('div');
    m.className = 'mark';
    m.style.left = (s.start / song.total) * 100 + '%';
    prog.appendChild(m);
  });

  renderMeta();
  hud.si = -1;
  hud.letter = null;
}

/**
 * Per-frame HUD update. Compares to the cache, so it touches the DOM only when
 * the section, the current letter, or the progress changes.
 */
function updateHUD() {
  if (app.mode !== 'playing' || !renderer.info) return;
  const { si, letter, beat } = renderer.info, song = app.song;

  if (si !== hud.si) {
    hud.si = si;
    const s = song.sections[si];
    $('#secInfo .roman').textContent = s.roman;
    $('#secInfo .name').textContent = s.name;
    $('#secInfo .desc').textContent = s.desc;
    Hooks.emit('section', s, si, song);
  }

  if (letter !== hud.letter) {
    hud.letter = letter;
    hud.spans.forEach((sp) => sp.classList.toggle('cur', sp.textContent === letter));
  }

  $('#progress .fill').style.transform = `scaleX(${beat / song.total})`;
}

/* ── Controls ─────────────────────────────────────────────────────────── */

/** Keep the Pause button's label in step with the AudioContext state. */
function setPauseLabel() {
  const b = document.querySelector('[data-act="pause"]');
  if (b && app.engine) b.textContent = app.engine.ctx.state === 'running' ? 'Pause' : 'Resume';
}

/** Suspend or resume the AudioContext. The clock stops, so the pen stops. */
async function togglePause() {
  if (app.mode !== 'playing') return;
  const c = app.engine.ctx;
  if (c.state === 'running') await c.suspend(); else await c.resume();
  setPauseLabel();
}

/**
 * Enter or leave Charge mode. Entering requires a performance in progress.
 * Requests fullscreen where available; leaving exits it.
 */
function toggleCharge(on = !app.charging) {
  if (on && app.mode !== 'playing') return;
  app.charging = on;
  document.body.classList.toggle('charging', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// If the user exits fullscreen with Escape or the browser chrome, leave Charge too.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && app.charging) toggleCharge(false);
});

/** Stop any active recording. Safe to call when nothing is recording. */
function stopRecording() {
  if (app.rec && app.rec.state !== 'inactive') app.rec.stop();
}

/**
 * New: leave this sigil without ceremony. The sigil is NOT banished, so the
 * grimoire keeps it.
 */
function newDesire() {
  if (app.mode !== 'playing') return;
  Hooks.emit('stop', 'new');
  stopRecording();
  toggleCharge(false);
  app.engine.ctx.resume();
  app.engine.stop(1.2);
  app.mode = 'idle';
  $('#hud').classList.remove('on');
  $('#invoke').classList.remove('away');
  setTimeout(() => $('#desire').focus(), 500);
}

/**
 * Forget: the banishing. Burn the strokes, fall silent under a closing filter
 * sweep, erase the words and the URL, and return to the invocation.
 */
async function forget() {
  if (app.mode !== 'playing' || app.busy) return;
  app.busy = true;
  stopRecording();
  toggleCharge(false);
  Hooks.emit('forget', app.sigil);
  Hooks.emit('stop', 'forget');
  await app.engine.ctx.resume();
  setPauseLabel();
  app.mode = 'burning';
  $('#hud').classList.remove('on');
  renderer.burn();
  app.engine.banish(3.5);
  app.engine.stop(3.5);

  await wait(3600);
  $('#desire').value = '';
  history.replaceState(null, '', location.pathname + location.search);
  toast('It is forgotten.', false, 2600);
  await wait(3200);

  app.sigil = null;
  app.song = null;
  app.mode = 'idle';
  app.busy = false;
  $('#desireLabel').textContent = 'State your desire in the present tense, as though it were already so.';
  $('#invoke').classList.remove('away');
}

/**
 * Seal: a 2048² PNG of the sigil in its ORIGINAL orientation (no rotation
 * applied), as a permanent talisman. Draws with the live renderer's routines
 * on a temporary context, then restores them.
 */
function exportSeal() {
  const { sigil } = app;
  if (!sigil) return;

  const size = 2048;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const p = sigil.palette;
  const F = { cx: size / 2, cy: size * 0.46, R: size * 0.33, base: sigil.baseAngle };

  g.fillStyle = p.bg;
  g.fillRect(0, 0, size, size);
  const vg = g.createRadialGradient(F.cx, F.cy, 0, F.cx, F.cy, size * 0.7);
  vg.addColorStop(0, rgba(p.accent, 0.06));
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = vg;
  g.fillRect(0, 0, size, size);

  // Temporarily point the renderer at the seal canvas.
  const saved = { g: renderer.g, pal: renderer.pal };
  renderer.g = g;
  renderer.pal = p;
  g.globalCompositeOperation = 'lighter';

  renderer.circle(F.cx, F.cy, F.R, p.line, 0.5, false, 3);
  renderer.circle(F.cx, F.cy, F.R * 1.045, p.line, 0.25, false, 2);
  for (let s = 0; s < SLOTS; s++) {
    const a = polar(s, 1, ID_T, F), b = polar(s, 1.045, ID_T, F);
    renderer.strokeGlow([...a, ...b], p.line, 0.45, 2);
  }
  const pts = tracePoints(sigil.nodes, sigil.curves, ID_T, F, sigil.nodes.length - 1);
  renderer.strokeGlow(pts, p.line, 1, 6);
  const sF = { ...F, R: F.R * 1.6 }; // bolder terminals at print scale
  renderer.circle(pts[0], pts[1], F.R * 0.03, p.line, 0.95, false, 5);
  renderer.drawTerminals(pts, sF, 1, true);

  renderer.g = saved.g;
  renderer.pal = saved.pal;

  // Caption: the consonants spaced out, and a fragment of the hash.
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = rgba(p.line, 0.7);
  g.textAlign = 'center';
  g.font = `${size * 0.034}px ${SERIF}`;
  g.fillText([...sigil.reduced].join('  '), size / 2, size * 0.9);
  g.fillStyle = rgba(p.line, 0.3);
  g.font = `italic ${size * 0.014}px ${SERIF}`;
  g.fillText(sigil.hex.slice(0, 32), size / 2, size * 0.935);

  cv.toBlob((b) => download(b, `sigil-${sigil.reduced}.png`));
}

/** Trigger a browser download of a Blob. The object URL is revoked after 4 s. */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/**
 * Record: canvas video plus the master audio tap, to WebM (or MP4 where
 * supported). The HUD is part of the DOM, not the canvas, so the film is clean.
 */
function toggleRecord() {
  const btn = document.querySelector('[data-act="record"]');
  if (app.rec && app.rec.state !== 'inactive') { app.rec.stop(); return; }

  if (!window.MediaRecorder || !renderer.cv.captureStream || !app.engine.recDest) {
    toast('Recording is not supported in this browser', true);
    return;
  }

  const stream = new MediaStream([
    ...renderer.cv.captureStream(60).getVideoTracks(),
    ...app.engine.recDest.stream.getAudioTracks(),
  ]);
  const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8e6 } : {});
  const chunks = [], name = `sigil-${app.sigil.reduced}`;

  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    btn.classList.remove('rec-on');
    btn.textContent = 'Record';
    const ext = (rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    download(new Blob(chunks, { type: rec.mimeType || 'video/webm' }), `${name}.${ext}`);
  };
  rec.start(1000);   // a chunk per second, so memory stays bounded
  app.rec = rec;
  btn.classList.add('rec-on');
  btn.textContent = 'Stop rec';
  toast('Recording. The song loops, so stop whenever you wish', true);
}

/** Share: copies a link containing only the consonants (and any fusion/mood suffix). */
function share() {
  const url = location.href.split('#')[0] + '#' + shareKey();
  const ok = () => toast('Link copied. Only the consonants travel', true);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(ok).catch(() => prompt('Copy this link', url));
  } else prompt('Copy this link', url);
}

/* ── Wiring ───────────────────────────────────────────────────────────── */

$('#castBtn').addEventListener('click', () => cast());
$('#desire').addEventListener('keydown', (e) => { if (e.key === 'Enter') cast(); });

$('#controls').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  const table = {
    pause: togglePause, charge: () => toggleCharge(), seal: exportSeal,
    record: toggleRecord, share, new: newDesire, forget,
  };
  table[act]?.();
});

// Click the progress bar to seek to the section under the cursor.
$('#progress').addEventListener('click', (e) => {
  if (app.mode !== 'playing') return;
  const r = e.currentTarget.getBoundingClientRect();
  const beat = clamp((e.clientX - r.left) / r.width, 0, 0.999) * app.song.total;
  app.engine.seek(app.song.sections[sectionIndexAt(app.song, beat)].start);
});

$('#aboutBtn').addEventListener('click', () => $('#about').classList.add('open'));
$('#aboutClose').addEventListener('click', () => $('#about').classList.remove('open'));
$('#about').addEventListener('click', (e) => {
  if (e.target.id === 'about') $('#about').classList.remove('open');
});

// Global keys. Ignored while typing in any input.
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { $('#about').classList.remove('open'); toggleCharge(false); }
  else if (e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key.toLowerCase() === 'c') toggleCharge();
});

/* ── Boot ─────────────────────────────────────────────────────────────── */

/**
 * Accept a shared sigil from the URL fragment, then start the frame loop.
 * The loop runs for the life of the page: the renderer decides what to draw.
 */
(function boot() {
  const h = decodeURIComponent(location.hash.slice(1)).toUpperCase();
  if (/^[BCDFGHJKLMNPQRSTVWXYZ]{3,21}$/.test(h) && new Set(h).size === h.length) {
    $('#desire').value = h;
    $('#desireLabel').textContent = 'A sigil has been shared with you. Cast it to hear it sing.';
  }
  setTimeout(() => $('#desire').focus({ preventScroll: true }), 900);

  (function loop() {
    renderer.draw(app);
    updateHUD();
    requestAnimationFrame(loop);
  })();
})();

/* ══════════════════════════════════════════════════════════════════════════
   SigilCore — the public facade.
   New modules should depend on this object, not on bare globals. The names
   here are the contract. Changing a name is a breaking change.
   ══════════════════════════════════════════════════════════════════════════ */
const SigilCore = Object.freeze({
  // Pure layers
  reduceDesire, buildSigil, composeSong, makePlan, buildPhrase, harmonize,
  validChords, bassPitch, arpTones, padVoicing, euclid, degToMidi, fold, mtof,
  stream, hashStr, toHex, SHA256, Rng,
  // Geometry & constants
  SLOTS, CONSONANTS, RINGS, ID_T, UNIT_F, PALETTES, MODES, MODE_NAMES, NOTE_NAMES,
  TIMBRE_NAMES, ARP_PATTERNS,
  polar, nodeXY, segmentPoints, tracePoints, polyLength,
  // Time helpers
  sectionIndexAt, phraseIndexAt, penProgress, pulse, displayTransform,
  // Runtime objects
  app, renderer, Engine, Renderer,
  // Actions
  cast, forget, newDesire, toggleCharge, togglePause, download, toast, flashErr,
  applyPalette, renderMeta, shareKey, buildHUD, setPauseLabel,
});