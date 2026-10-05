'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §8  APPLICATION — ritual flow, HUD, controls, export, boot
   --------------------------------------------------------------------------
   STATE MACHINE

     idle ──cast──► reducing ──► playing ⇄ (charging)
                                   │
                                   ├─ new    ──► idle   (no ceremony)
                                   └─ forget ──► burning ──► idle

   `app` is the single mutable state object. Modules read it freely and are
   expected NOT to write to it, except through the documented entry points
   (cast, forget, newDesire, toggleCharge, UI.recompose).
   ══════════════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════════════════════════
   §8.-1  PREFLIGHT
   --------------------------------------------------------------------------
   Classic scripts fail silently. If a core file does not load or does not
   parse, its top-level declarations simply never exist, and the FIRST thing
   that touches one of them throws - usually deep inside a constructor, three
   files later, producing a cascade of misleading errors.

   This check runs before anything else in the application and reports the
   truth: which file is missing, by name. It then halts, so the console is not
   flooded with downstream noise.

   MAINTENANCE: when you add a core file, add it to REQUIRED. When you add a
   major exported symbol to an existing file, add it here too. The cost is one
   line; the benefit is never debugging a phantom again.
   ══════════════════════════════════════════════════════════════════════════ */
   (function preflight() {
    const REQUIRED = {
      'src/core/00-utils.js':     ['$', 'wait', 'TAU', 'mod', 'clamp', 'lerp', 'ease', 'rgba', 'te', 'SERIF', 'Hooks', 'Prefs'],
      'src/core/01-crypto.js':    ['SHA256', 'toHex', 'hashStr', 'sfc32', 'mulberry32', 'Rng', 'stream'],
      'src/core/02-reduction.js': ['VOWELS', 'reduceDesire'],
      'src/core/03-geometry.js':  ['SLOTS', 'CONSONANTS', 'RINGS', 'ID_T', 'UNIT_F', 'PALETTES',
                                   'buildSigil', 'polar', 'nodeXY', 'segmentPoints', 'tracePoints', 'polyLength'],
      'src/core/04-theory.js':    ['MODES', 'MODE_NAMES', 'MODE_WEIGHTS', 'NOTE_NAMES', 'mtof', 'degToMidi', 'fold', 'euclid'],
      'src/core/05-composer.js':  ['makePlan', 'allocate', 'buildPhrase', 'addPassing', 'harmonize',
                                   'validChords', 'bassPitch', 'arpTones', 'padVoicing', 'ARP_PATTERNS',
                                   'composeSong', 'sectionIndexAt', 'phraseIndexAt', 'penProgress',
                                   'pulse', 'displayTransform'],
      'src/core/06-engine.js':    ['Engine'],
      'src/core/07-renderer.js':  ['Renderer'],
    };
  
    /* `typeof X` on an UNDECLARED identifier is safe and yields "undefined".
       `typeof X` on a DECLARED-but-uninitialised (TDZ) identifier throws. Both
       mean "not usable", so we treat a throw as missing. The Function
       constructor evaluates in global scope, where the global lexical bindings
       created by earlier classic scripts are visible. */
    const probe = (name) => {
      try { return new Function('return typeof ' + name)() !== 'undefined'; }
      catch (e) { return false; }
    };
  
    const broken = [];
    for (const file of Object.keys(REQUIRED)) {
      const missing = REQUIRED[file].filter((s) => !probe(s));
      if (missing.length) broken.push({ file, missing });
    }
    if (!broken.length) return;
  
    /* Report loudly: console, document title, and a full-screen overlay that
       cannot be missed or scrolled past. */
    const lines = broken.map((b) =>
      `  ${b.file}\n      missing: ${b.missing.join(', ')}`).join('\n');
  
    console.error(
      '%cSIGIL BOOT FAILURE', 'color:#ff5a4a;font-size:16px;font-weight:bold',
      `\n\n${broken.length} core file(s) did not load or did not parse:\n\n${lines}\n\n` +
      'Every other error in this console is a consequence of the above. Fix these first.\n' +
      'Most common causes:\n' +
      '  1. The page is opened with file:// - some browsers refuse to load sibling\n' +
      '     scripts from an opaque file origin. Serve over HTTP instead.\n' +
      '  2. The file is missing, misnamed, or saved to the wrong directory.\n' +
      '  3. The file has a syntax error. Open it directly in the browser\n' +
      '     (e.g. http://localhost:8080/src/core/03-geometry.js) to confirm it\n' +
      '     exists, then check the Sources panel for a parse error.');
  
    document.title = 'SIGIL — boot failure';
  
    const pre = document.createElement('pre');
    pre.textContent =
      'SIGIL — BOOT FAILURE\n\n' +
      broken.length + ' core file(s) did not load or did not parse:\n\n' + lines + '\n\n' +
      'Every other error in the console is a consequence of this one.\n\n' +
      'Checklist:\n' +
      '  1. Are you opening the page with file:// ?  Serve over HTTP:\n' +
      '       python3 -m http.server 8080\n' +
      '     then open http://localhost:8080/\n' +
      '  2. Does the file exist at exactly that path, with that exact name?\n' +
      '  3. Open the file directly in the browser to check it is complete\n' +
      '     and free of syntax errors.\n';
    pre.setAttribute('style',
      'position:fixed;inset:0;z-index:99999;margin:0;padding:6vh 6vw;' +
      'background:#0a0807;color:#ff9650;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'white-space:pre-wrap;overflow:auto');
    (document.body || document.documentElement).appendChild(pre);
  
    // Halt this file. Later module scripts may still throw; the overlay above is
    // the only message that matters.
    throw new Error('SIGIL preflight failed: ' + broken.map((b) => b.file).join(', '));
  })();




/* ── §8.0 STATE ────────────────────────────────────────────────────────── */

const app = {
  mode: 'idle',        // 'idle' | 'reducing' | 'playing' | 'burning'
  sigil: null,
  song: null,
  engine: null,        // created lazily, inside a user gesture (autoplay policy)
  charging: false,
  lit: 0,              // how many letters have been named during reduction
  busy: false,         // re-entrancy guard for cast() and forget()
  reduceStart: 0,      // performance time at which the reduction began
  rec: null,           // active MediaRecorder, if any
  basePalette: null,   // the palette before 'palette' filters were applied
};

const renderer = new Renderer($('#stage'));

/** HUD memo, so we only touch the DOM when something actually changes. */
const hud = { si: -1, letter: null, spans: [] };

/** Human-readable names for the three lead timbres. Used by the HUD and M5. */
const TIMBRE_NAMES = { glass: 'glass bell', reed: 'reed', koto: 'plucked string' };

/* ── §8.1 PRESENTATION HELPERS ─────────────────────────────────────────── */

/**
 * Apply a palette to both the renderer and the CSS custom properties.
 * The 'palette' filter lets High Contrast (M5, priority 100) and Hours & Moon
 * (M10, priority 10) override it. The UNFILTERED palette is remembered, so
 * UI.refreshPalette() can re-run the filters later without losing the original.
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
 * Rebuild the HUD meta line. Built as an ARRAY so modules can edit individual
 * parts through the 'meta' filter rather than string-munging.
 */
function renderMeta() {
  const { sigil, song } = app;
  if (!song || !sigil) return;
  const parts = [song.keyName, `${song.bpm} bpm`, TIMBRE_NAMES[song.leadTimbre],
                 renderer.pal.name, sigil.hex.slice(0, 8)];
  $('#meta').textContent = Hooks.filter('meta', parts, app).join(' · ');
}

/** The URL fragment for the current sigil. Fusion and Moods extend it (#KRST+MNL~ambient). */
function shareKey() {
  return app.sigil ? Hooks.filter('shareKey', app.sigil.reduced, app.sigil) : '';
}

/** Oracle text. `small` places it low and quiet; otherwise it is centred and large. */
function toast(text, small = false, ms = 2200) {
  const t = $('#toast');
  t.textContent = text;
  t.className = small ? 'small show' : 'show';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = small ? 'small' : ''), ms);
}

function flashErr(msg) {
  $('#err').textContent = msg;
  clearTimeout(flashErr.t);
  flashErr.t = setTimeout(() => ($('#err').textContent = ''), 4000);
}

/* ── §8.2 CAST — the whole rite, from text to performance ──────────────── */

/**
 * Cast a desire.
 *
 * @param {object} [opts]
 *   text      {string}   desire text (defaults to the input field)
 *   partners  {string[]} extra desires or consonant strings (M8 Fusion)
 *   preset    {string}   mood id (M6 Moods)
 *   quick     {boolean}  short reduction animation (M3 Grimoire replays)
 */
async function cast(opts = {}) {
  if (app.busy) return;
  if (!opts || opts instanceof Event) opts = {};   // tolerate being used as a click handler

  const text = String(opts.text ?? $('#desire').value).trim();
  if (!text) { flashErr('Speak a desire first.'); return; }

  const { chars, reduced } = reduceDesire(text);
  if (reduced.length < 3) { flashErr('Too little remains after reduction. Say more.'); return; }

  const ctx = { text, reduced, opts };
  Hooks.emit('beforeCast', ctx);

  // M8 Fusion may take over construction entirely.
  const sigil = Hooks.filter('buildSigil', null, ctx) || buildSigil(reduced);
  if (sigil.error) { flashErr(sigil.error); return; }

  app.busy = true;
  try {
    // The AudioContext must be created/resumed inside the user gesture.
    if (!app.engine) app.engine = new Engine();
    try { await app.engine.ctx.resume(); } catch { /* already running, or blocked */ }

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
 * The striking-out, shown letter by letter, with quill ticks and chimes.
 *
 * This is deliberately an async script rather than a CSS timeline: the pacing
 * adapts to the length of the text (longer desires strike faster), and each
 * beat of the ceremony triggers audio.
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

  // Replays from the Grimoire arrive already reduced, so only name the letters.
  if (quick) {
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

  const struck = spans.filter((s) => s.dataset.fate !== 'kept');
  const step = clamp(1500 / Math.max(1, struck.length), 14, 55);  // ~1.5 s total, within limits
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

/* ── §8.3 HUD ──────────────────────────────────────────────────────────── */

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
  hud.si = -1; hud.letter = null;   // force a refresh on the next frame
}

/** Called every frame from the boot loop. Writes to the DOM only on change. */
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

/* ── §8.4 TRANSPORT CONTROLS ───────────────────────────────────────────── */

function setPauseLabel() {
  const b = document.querySelector('[data-act="pause"]');
  if (b && app.engine) b.textContent = app.engine.ctx.state === 'running' ? 'Pause' : 'Resume';
}

/** Pause by suspending the AudioContext: the renderer stops with it, for free. */
async function togglePause() {
  if (app.mode !== 'playing') return;
  const c = app.engine.ctx;
  if (c.state === 'running') await c.suspend(); else await c.resume();
  setPauseLabel();
}

function toggleCharge(on = !app.charging) {
  if (on && app.mode !== 'playing') return;
  app.charging = on;
  document.body.classList.toggle('charging', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Leaving fullscreen by any means (Esc, browser UI) leaves charge mode too.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && app.charging) toggleCharge(false);
});

function stopRecording() {
  if (app.rec && app.rec.state !== 'inactive') app.rec.stop();
}

/** New: leave this sigil without ceremony. It is NOT banished; the Grimoire keeps it. */
function newDesire() {
  if (app.mode !== 'playing') return;
  Hooks.emit('stop', 'new');
  stopRecording();
  toggleCharge(false);

  app.engine.ctx.resume();    // if paused, let the fade-out actually be heard
  app.engine.stop(1.2);
  app.mode = 'idle';

  $('#hud').classList.remove('on');
  $('#invoke').classList.remove('away');
  setTimeout(() => $('#desire').focus(), 500);
}

/** Forget: the banishing. Burn, silence, erase the words, the URL and the record. */
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
  app.sigil = null; app.song = null; app.mode = 'idle'; app.busy = false;
  $('#desireLabel').textContent = 'State your desire in the present tense, as though it were already so.';
  $('#invoke').classList.remove('away');
}

/* ── §8.5 EXPORT ───────────────────────────────────────────────────────── */

/**
 * Seal: a 2048² PNG of the sigil in its ORIGINAL orientation (no section
 * transform, no lens), as a permanent talisman.
 *
 * Implementation note: rather than duplicate the drawing code, we temporarily
 * point the live renderer at an offscreen context. Ugly but honest — and it
 * guarantees the seal always matches what the renderer draws.
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

  const saved = { g: renderer.g, pal: renderer.pal };
  renderer.g = g; renderer.pal = p;
  g.globalCompositeOperation = 'lighter';

  renderer.circle(F.cx, F.cy, F.R, p.line, 0.5, false, 3);
  renderer.circle(F.cx, F.cy, F.R * 1.045, p.line, 0.25, false, 2);
  for (let s = 0; s < SLOTS; s++) {
    const a = polar(s, 1, ID_T, F), b = polar(s, 1.045, ID_T, F);
    renderer.strokeGlow([...a, ...b], p.line, 0.45, 2);
  }

  const pts = tracePoints(sigil.nodes, sigil.curves, ID_T, F, sigil.nodes.length - 1);
  renderer.strokeGlow(pts, p.line, 1, 6);

  const sF = { ...F, R: F.R * 1.6 };   // bolder terminals at print scale
  renderer.circle(pts[0], pts[1], F.R * 0.03, p.line, 0.95, false, 5);
  renderer.drawTerminals(pts, sF, 1, true);

  renderer.g = saved.g; renderer.pal = saved.pal;

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

/** Trigger a browser download for a Blob. Revokes the object URL afterwards. */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Record: canvas video + master audio → WebM. The HUD is excluded, so the film is clean. */
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
    download(new Blob(chunks, { type: rec.mimeType || 'video/webm' }),
             `${name}.${(rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm'}`);
  };

  rec.start(1000);
  app.rec = rec;
  btn.classList.add('rec-on');
  btn.textContent = 'Stop rec';
  toast('Recording. The song loops, so stop whenever you wish', true);
}

/** Share: only the consonants travel, which is the sigil and not the desire. */
function share() {
  const url = location.href.split('#')[0] + '#' + shareKey();
  const ok = () => toast('Link copied. Only the consonants travel', true);
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok).catch(() => prompt('Copy this link', url));
  else prompt('Copy this link', url);
}

/* ── §8.6 WIRING ───────────────────────────────────────────────────────── */

$('#castBtn').addEventListener('click', () => cast());
$('#desire').addEventListener('keydown', (e) => { if (e.key === 'Enter') cast(); });

$('#controls').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  ({ pause: togglePause, charge: () => toggleCharge(), seal: exportSeal,
     record: toggleRecord, share, new: newDesire, forget })[act]?.();
});

// Click the progress bar to seek to the section under the cursor.
// (M4 Form intercepts Shift-click in the capture phase to loop instead.)
$('#progress').addEventListener('click', (e) => {
  if (app.mode !== 'playing') return;
  const r = e.currentTarget.getBoundingClientRect();
  const beat = clamp((e.clientX - r.left) / r.width, 0, 0.999) * app.song.total;
  app.engine.seek(app.song.sections[sectionIndexAt(app.song, beat)].start);
});

$('#aboutBtn').addEventListener('click', () => $('#about').classList.add('open'));
$('#aboutClose').addEventListener('click', () => $('#about').classList.remove('open'));
$('#about').addEventListener('click', (e) => { if (e.target.id === 'about') $('#about').classList.remove('open'); });

// Core shortcuts. The module keymap (UI.key) has its own, separate listener.
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { $('#about').classList.remove('open'); toggleCharge(false); }
  else if (e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key.toLowerCase() === 'c') toggleCharge();
});

/* ── §8.7 SigilCore FACADE ─────────────────────────────────────────────────
   A single named surface for modules, so new code stops reaching for bare
   globals. The globals above remain valid for the existing modules; new
   modules should prefer SigilCore.*.
   ─────────────────────────────────────────────────────────────────────────── */
const SigilCore = {
  // state
  app, renderer, hud, TIMBRE_NAMES,
  // lifecycle
  cast, forget, newDesire, togglePause, toggleCharge,
  // presentation
  applyPalette, renderMeta, buildHUD, updateHUD, toast, flashErr, shareKey, setPauseLabel,
  // export
  exportSeal, toggleRecord, share, download,
  // construction
  buildSigil, composeSong, reduceDesire,
  // classes
  Engine, Renderer,
  // infrastructure
  Hooks, Prefs,
  version: 'SIGIL/v1',
};

/* ── §8.8 BOOT ─────────────────────────────────────────────────────────────
   Accepts a plain shared sigil from the URL fragment. (UI.whenReady in the UI
   kit handles the EXTENDED link format #A+B~mood, which supersedes this when
   the modules are present.)
   ─────────────────────────────────────────────────────────────────────────── */
   (function boot() {
    /* Shared-link prefill.
       The UI kit's parser (UI.parseKey) understands the EXTENDED format
       (#A+B~mood) and is the single source of truth once it has loaded. This
       core handler exists only as a fallback for the degenerate case where the
       UI kit is absent — so it marks what it did, and the UI kit skips if the
       work is already done and nothing richer is on offer. */
    const h = decodeURIComponent(location.hash.slice(1)).toUpperCase();
    if (/^[BCDFGHJKLMNPQRSTVWXYZ]{3,21}$/.test(h) && new Set(h).size === h.length) {
      $('#desire').value = h;
      $('#desireLabel').textContent = 'A sigil has been shared with you. Cast it to hear it sing.';
      app.linkPrefilled = h;
    }
  
    setTimeout(() => $('#desire').focus({ preventScroll: true }), 900);

  // The single render loop. Everything visual is driven from here.
  (function loop() {
    renderer.draw(app);
    updateHUD();
    requestAnimationFrame(loop);
  })();
})();