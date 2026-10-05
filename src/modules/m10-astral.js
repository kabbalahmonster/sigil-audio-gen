'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M10 · HOURS & MOON — planetary hours, moon phase, timed sessions
   --------------------------------------------------------------------------
   SUNRISE / SUNSET use the standard "sunrise equation" (accurate to ~1–2 min).
   Without a location, equal hours from 06:00 to 18:00 are used instead.

   PLANETARY HOURS: 12 unequal day hours (sunrise→sunset) and 12 night hours.
   The FIRST hour of a day belongs to that day's ruler, and rulers then follow
   the Chaldean order Saturn → Jupiter → Mars → Sun → Venus → Mercury → Moon.

   ⚠ Planet palettes are kept SEPARATE from PALETTES on purpose. Adding to
   PALETTES would shift the palette index of every existing sigil.

   Runs at priority −10 on 'compose', i.e. BEFORE Moods, so an explicit mood
   can still override the planetary mode.
   ══════════════════════════════════════════════════════════════════════════ */

const Astral = (() => {
  'use strict';
  const { h } = UI;

  const RAD = Math.PI / 180;
  const CHALDEAN = ['saturn', 'jupiter', 'mars', 'sun', 'venus', 'mercury', 'moon'];
  const WEEK = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn'];   // by Date.getDay()

  const PLANETS = {
    saturn:  { glyph: '♄', name: 'Saturn',  mode: 'Harmonic minor', timbre: 'reed',  tempo: 0.9,  virtue: 'boundaries, endings, patience' },
    jupiter: { glyph: '♃', name: 'Jupiter', mode: 'Lydian',         timbre: 'glass', tempo: 1.0,  virtue: 'expansion, fortune, generosity' },
    mars:    { glyph: '♂', name: 'Mars',    mode: 'Phrygian',       timbre: 'koto',  tempo: 1.12, virtue: 'courage, force, protection' },
    sun:     { glyph: '☉', name: 'Sun',     mode: 'Ionian',         timbre: 'glass', tempo: 1.05, virtue: 'success, vitality, clarity' },
    venus:   { glyph: '♀', name: 'Venus',   mode: 'Dorian',         timbre: 'reed',  tempo: 0.95, virtue: 'love, beauty, harmony' },
    mercury: { glyph: '☿', name: 'Mercury', mode: 'Mixolydian',     timbre: 'koto',  tempo: 1.1,  virtue: 'speech, study, travel' },
    moon:    { glyph: '☽', name: 'Moon',    mode: 'Aeolian',        timbre: 'glass', tempo: 0.88, virtue: 'dreams, intuition, the tides' },
  };

  const ASTRAL_PALETTES = {
    saturn:  { name: 'Saturnine',   bg: '#09090a', line: [214, 210, 200], accent: [140, 126, 190] },
    jupiter: { name: 'Jovian',      bg: '#0a0810', line: [236, 214, 160], accent: [120, 150, 255] },
    mars:    { name: 'Martial',     bg: '#0d0605', line: [246, 224, 210], accent: [235,  60,  40] },
    sun:     { name: 'Solar',       bg: '#0c0905', line: [255, 222, 150], accent: [255, 160,  40] },
    venus:   { name: 'Venusian',    bg: '#070d0b', line: [190, 240, 214], accent: [255, 150, 180] },
    mercury: { name: 'Quicksilver', bg: '#09090b', line: [214, 222, 232], accent: [150, 200, 255] },
    moon:    { name: 'Lunar',       bg: '#07080d', line: [220, 224, 255], accent: [180, 200, 255] },
  };

  const S = { attune: false, loc: null, minutes: '7', endAction: 'forget', charge: true, ...Prefs.get('astral', {}) };
  const save = () => Prefs.set('astral', S);

  /* ── Astronomy ─────────────────────────────────────────────────────── */

  /** Sunrise/sunset for a date and location, or null at polar day/night. */
  function sunTimes(date, lat, lon) {
    const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    const jd = noon.getTime() / 864e5 + 2440587.5;

    const n = Math.round(jd - 2451545.0 + lon / 360);       // julian day number since J2000
    const Js = n - lon / 360;                               // mean solar noon
    const M = mod(357.5291 + 0.98560028 * Js, 360);         // solar mean anomaly
    const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
    const lam = mod(M + C + 180 + 102.9372, 360);           // ecliptic longitude
    const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lam * RAD);

    const sinD = Math.sin(lam * RAD) * Math.sin(23.4397 * RAD), cosD = Math.cos(Math.asin(sinD));
    const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinD) / (Math.cos(lat * RAD) * cosD);
    if (cosW < -1 || cosW > 1) return null;                 // the sun never sets / never rises

    const w = Math.acos(cosW) / RAD;
    const toDate = (j) => new Date((j - 2440587.5) * 864e5);
    return { rise: toDate(Jt - w / 360), set: toDate(Jt + w / 360) };
  }

  function dayTimes(d) {
    if (S.loc) { const t = sunTimes(d, S.loc.lat, S.loc.lon); if (t) return t; }
    const rise = new Date(d); rise.setHours(6, 0, 0, 0);
    const set = new Date(d); set.setHours(18, 0, 0, 0);
    return { rise, set };
  }

  /** The planetary hour containing `now`, with its bounds and index. */
  function planetaryHour(now = new Date()) {
    const day = (off) => { const d = new Date(now); d.setDate(d.getDate() + off); return { d, ...dayTimes(d) }; };
    const today = day(0);

    let start, end, rulerDate, base;
    if (now < today.rise)      { const y = day(-1); start = y.set;     end = today.rise; rulerDate = y.d;     base = 12; }
    else if (now < today.set)  {                   start = today.rise; end = today.set;  rulerDate = today.d; base = 0;  }
    else                       { const t = day(1); start = today.set;  end = t.rise;     rulerDate = today.d; base = 12; }

    const len = (end - start) / 12;
    const idx = clamp(Math.floor((now - start) / len), 0, 11);
    const dayRuler = WEEK[rulerDate.getDay()];

    return {
      planet: CHALDEAN[(CHALDEAN.indexOf(dayRuler) + base + idx) % 7],
      dayRuler, isDay: base === 0, hourNumber: idx + 1,
      start: new Date(+start + idx * len),
      end: new Date(+start + (idx + 1) * len),
    };
  }

  /** Search forward (up to 8 days) for the next hour ruled by `planet`. */
  function nextHourOf(planet, from = new Date()) {
    let t = from;
    for (let i = 0; i < 24 * 8; i++) {
      const hr = planetaryHour(t);
      if (hr.planet === planet) return hr;
      t = new Date(+hr.end + 1000);
    }
    return null;
  }

  /** Moon phase as a fraction of the synodic month, plus illumination and a name. */
  function moonPhase(date = new Date()) {
    const f = mod((date.getTime() / 864e5 + 2440587.5 - 2451550.26) / 29.530588853, 1);
    const names = [[0.03, 'New moon'], [0.22, 'Waxing crescent'], [0.28, 'First quarter'],
                   [0.47, 'Waxing gibbous'], [0.53, 'Full moon'], [0.72, 'Waning gibbous'],
                   [0.78, 'Last quarter'], [0.97, 'Waning crescent'], [1.01, 'New moon']];
    return { f, illum: (1 - Math.cos(TAU * f)) / 2, name: names.find(([x]) => f < x)[1] };
  }

  /** Draw the moon: a lit limb (half circle) plus a terminator (half ellipse). */
  function drawMoon(cv, f, col) {
    const g = cv.getContext('2d'), s = cv.width;
    const r = s * 0.42, c = s / 2, k = Math.cos(TAU * f), waxing = f < 0.5;

    g.clearRect(0, 0, s, s);
    g.fillStyle = rgba(col, 0.1);
    g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill();

    g.fillStyle = rgba(col, 0.9);
    g.beginPath();
    g.arc(c, c, r, -Math.PI / 2, Math.PI / 2, !waxing);
    g.ellipse(c, c, r * Math.abs(k), r, 0, Math.PI / 2, -Math.PI / 2, waxing ? k > 0 : k < 0);
    g.fill();
  }

  /* ── Composition integration ───────────────────────────────────────── */

  Hooks.on('compose', (cfg) => {
    if (!S.attune) return;
    const hr = planetaryHour(), pl = PLANETS[hr.planet], moon = moonPhase();
    cfg.modeName = pl.mode;
    cfg.leadTimbre = pl.timbre;
    // The moon breathes ±6% of tempo across the month: fastest at the full.
    cfg.bpm = Math.round(cfg.bpm * pl.tempo * (1 + 0.06 * Math.cos(TAU * (moon.f - 0.5))));
    cfg.astral = { planet: hr.planet, moon: moon.name };
  }, -10);

  Hooks.on('palette', () => {
    const a = app.song && app.song.cfg && app.song.cfg.astral;
    return a ? ASTRAL_PALETTES[a.planet] : undefined;
  }, 10);

  Hooks.on('meta', (parts) => {
    const a = app.song && app.song.cfg.astral;
    if (a) parts.push(`${PLANETS[a.planet].glyph} hour of ${PLANETS[a.planet].name}`);
  });

  /* ── Sessions ──────────────────────────────────────────────────────── */

  const sess = { total: 0, left: 0, warned: false, timer: null, last: 0 };

  function startSession() {
    if (app.mode !== 'playing') { toast('Cast a sigil first', true); return; }

    const sec = S.minutes === 'hour'
      ? Math.max(60, (planetaryHour().end - Date.now()) / 1000)
      : +S.minutes * 60;

    Object.assign(sess, { total: sec, left: sec, warned: sec <= 75, last: performance.now() });
    clearInterval(sess.timer);
    sess.timer = setInterval(tick, 250);

    if (S.charge) toggleCharge(true);
    app.engine.chime(app.song.leadBase + 24);
    UI.announce(`Session begun: ${UI.fmt(sec)}.`);
    syncSession();
  }

  function stopSession(silent) {
    clearInterval(sess.timer);
    sess.timer = null;
    sess.total = 0;
    if (!silent) UI.announce('Session ended.');
    syncSession();
  }

  function tick() {
    const t = performance.now(), dt = (t - sess.last) / 1000;
    sess.last = t;

    if (app.mode !== 'playing') return stopSession(true);
    if (app.engine.ctx.state !== 'running') return;   // paused: the session waits too

    sess.left -= dt;
    if (!sess.warned && sess.left <= 60) { sess.warned = true; app.engine.chime(app.song.leadBase + 19); }
    if (sess.left <= 0) return finish();
    syncSession();
  }

  function finish() {
    stopSession(true);
    app.engine.chime(app.song.leadBase + 24);
    setTimeout(() => app.engine.chime(app.song.leadBase + 31), 420);

    if (S.endAction === 'forget') setTimeout(() => forget(), 1400);
    else if (S.endAction === 'return') setTimeout(() => { toggleCharge(false); newDesire(); }, 1400);
    else toast('The session is complete.', false, 3000);
  }

  Hooks.on('stop', () => { if (sess.timer) stopSession(true); });

  // The countdown ring. Drawn through the hook so it is visible in Charge mode.
  Hooks.on('drawPlaying', ({ r, g, F }) => {
    if (!sess.timer || !sess.total) return;
    const f = clamp(sess.left / sess.total, 0, 1);
    g.beginPath();
    g.arc(F.cx, F.cy, F.R * 1.36, -Math.PI / 2, -Math.PI / 2 + TAU * f);
    g.strokeStyle = rgba(r.pal.accent, 0.3);
    g.lineWidth = 1.2;
    g.stroke();
  });

  /* ── Panel ─────────────────────────────────────────────────────────── */

  const fmtT = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (d) => d.toLocaleDateString([], { weekday: 'short' });
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10 < 4 ? n % 10 : 0] || 'th');

  let nowLine, moonLine, moonCv, attuneNote, nextOut, nextSel, locNote, sessBtn, sessOut;

  function refresh() {
    if (!nowLine) return;

    const hr = planetaryHour(), pl = PLANETS[hr.planet], day = PLANETS[hr.dayRuler], moon = moonPhase();

    nowLine.innerHTML = '';
    nowLine.append(
      h('em', {}, `${pl.glyph} Hour of ${pl.name}`), h('br'),
      `${ord(hr.hourNumber)} hour of ${hr.isDay ? 'day' : 'night'} · until ${fmtT(hr.end)}`, h('br'),
      `Day of ${day.name} ${day.glyph}`);

    moonLine.textContent = `${moon.name} · ${Math.round(moon.illum * 100)}% lit`;
    drawMoon(moonCv, moon.f, renderer.pal.line);

    attuneNote.textContent = `Now: ${pl.name}, ${pl.virtue}. ${pl.mode}, ${TIMBRE_NAMES[pl.timbre]}.`;

    const nx = nextHourOf(nextSel.input.value);
    if (nx) {
      const inMin = Math.round((nx.start - Date.now()) / 60000);
      nextOut.textContent = nx.start <= new Date()
        ? `Now, until ${fmtT(nx.end)}`
        : `${fmtDay(nx.start)} ${fmtT(nx.start)} · in ${inMin >= 60 ? Math.floor(inMin / 60) + ' h ' : ''}${inMin % 60} min`;
    }

    locNote.textContent = S.loc
      ? `Using sunrise and sunset near ${S.loc.lat}°, ${S.loc.lon}° (rounded, stored only here).`
      : 'No location set: using equal hours from 06:00 to 18:00.';
  }

  function syncSession() {
    if (!sessBtn) return;
    sessBtn.textContent = sess.timer ? 'End session' : 'Begin session';
    sessOut.textContent = sess.timer
      ? `${UI.fmt(sess.left)} remaining${app.engine && app.engine.ctx.state !== 'running' ? ' (paused)' : ''}`
      : '';
  }

  function locate() {
    if (!navigator.geolocation) { toast('Location is unavailable here', true); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        // Rounded to 0.1° (~11 km): enough for sunrise, useless for tracking.
        S.loc = { lat: +p.coords.latitude.toFixed(1), lon: +p.coords.longitude.toFixed(1) };
        save(); refresh();
      },
      () => toast('Location was not shared. Using equal hours.', true),
      { maximumAge: 864e5, timeout: 10000 });
  }

  UI.section({ id: 'astral', title: 'Hours & Moon', order: 30, build(el) {
    UI.css(`.as-now{display:flex;gap:14px;align-items:center;margin:6px 0 4px}.as-now canvas{width:44px;height:44px;flex:none}
      .as-line{font-size:14px;line-height:1.55}.as-line em{color:rgb(var(--accent));font-style:normal}
      .as-h{font-size:10.5px;letter-spacing:.3em;text-transform:uppercase;opacity:.6;margin:16px 0 4px}`);

    moonCv = h('canvas', { width: 88, height: 88, 'aria-hidden': 'true' });
    nowLine = h('div', { class: 'as-line' });
    moonLine = h('div', { class: 'as-line', style: 'opacity:.7' });
    attuneNote = UI.note(''); nextOut = UI.note(''); locNote = UI.note('');

    nextSel = UI.select({ label: 'Next hour of', value: 'venus',
      options: CHALDEAN.map((p) => [p, `${PLANETS[p].glyph} ${PLANETS[p].name}`]),
      onChange: refresh });

    sessBtn = UI.button('Begin session', () => (sess.timer ? stopSession() : startSession()));
    sessOut = UI.note('');

    el.append(
      h('div', { class: 'as-now' }, moonCv, h('div', {}, nowLine, moonLine)),
      UI.check({ label: 'Attune new castings to the hour', checked: S.attune,
                 onChange: (v) => { S.attune = v; save(); } }),
      attuneNote,
      h('div', { class: 'sgrow' }, UI.button('Re-attune now', () => {
        if (!S.attune) { toast('Turn on attunement first', true); return; }
        UI.recompose();
      })),
      nextSel, nextOut,
      h('div', { class: 'sgrow' },
        UI.button('Use my location', locate),
        UI.button('Forget location', () => { S.loc = null; save(); refresh(); })),
      locNote,
      h('div', { class: 'as-h' }, 'Session'),
      UI.select({ label: 'Length', value: S.minutes,
        options: [['3', '3 minutes'], ['7', '7 minutes'], ['11', '11 minutes'],
                  ['21', '21 minutes'], ['hour', 'Until this hour ends']],
        onChange: (v) => { S.minutes = v; save(); } }),
      UI.select({ label: 'At the end', value: S.endAction,
        options: [['forget', 'Forget (banish)'], ['return', 'Return quietly'], ['chime', 'Chime only']],
        onChange: (v) => { S.endAction = v; save(); } }),
      UI.check({ label: 'Enter Charge mode when it begins', checked: S.charge,
                 onChange: (v) => { S.charge = v; save(); } }),
      h('div', { class: 'sgrow' }, sessBtn), sessOut);

        // Refresh once the page is ready, then every 20 s while visible.
  // Hidden tabs skip the work; returning to the tab refreshes immediately.
  UI.whenReady(refresh);
  setInterval(() => { if (!document.hidden) refresh(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  } });

  setInterval(refresh, 20000);   // TODO (Tier 3 #16): pause this when document.hidden
  Hooks.on('song', refresh);

  return { planetaryHour, moonPhase, nextHourOf, sunTimes, startSession, stopSession };
})();