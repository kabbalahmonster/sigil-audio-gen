'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M3 · GRIMOIRE — a local gallery of cast sigils (consonants only)
   --------------------------------------------------------------------------
   Storage: localStorage 'sigil.grimoire' = { v:1, keep, burnDays, entries[] }
     entry = { key:'KRST+MNL', mood, created, played, plays, burnAt|null }
     `mood` is the whole working the sigil was last cast in: "mood.style.element"
     (m21; an older entry holds the mood alone, which is the same word, shorter).

   The desire text is NEVER stored. Only the reduced consonants, which is the
   sigil itself. Forget() removes the entry: forgetting means forgetting.

   Soft dependency: M8 Fusion (for multi-member thumbnails).
   ══════════════════════════════════════════════════════════════════════════ */

const Grimoire = (() => {
  'use strict';
  const { h } = UI;

  const LIMIT = 60, DAY = 864e5;

  let db = Prefs.get('grimoire', null);
  if (!db || db.v !== 1 || !Array.isArray(db.entries)) db = { v: 1, keep: true, burnDays: 0, entries: [] };
  db.entries = db.entries.filter((e) => e && UI.parseKey(e.key));   // drop anything corrupt

  const save = () => Prefs.set('grimoire', db);

  let grid, empty, currentKey = null;
  const keyOf = (sig) => sig.fusionKey || sig.reduced;
  /** The working a song was composed in: mood, style and element as one word (m21), or the mood alone. */
  const working = (cfg) => (typeof Styles !== 'undefined' ? Styles.tag(cfg) : cfg.mood) || 'ritual';
  const wordsOf = (w) => (typeof Styles !== 'undefined' ? Styles.words(w) : w && w !== 'ritual' ? w : '');

  /** Remove entries whose burnAt has passed. @returns how many faded. */
  function purge() {
    const now = Date.now(), before = db.entries.length;
    db.entries = db.entries.filter((e) => !e.burnAt || e.burnAt > now);
    if (db.entries.length !== before) save();
    return before - db.entries.length;
  }

  function upsert(key, mood) {
    const now = Date.now();
    let e = db.entries.find((x) => x.key === key);
    if (!e) {
      e = { key, created: now, plays: 0, burnAt: db.burnDays > 0 ? now + db.burnDays * DAY : null };
      db.entries.push(e);
    }
    e.mood = mood || 'ritual';
    e.played = now;
    e.plays++;
    db.entries.sort((a, b) => b.played - a.played);
    if (db.entries.length > LIMIT) db.entries.length = LIMIT;
    save(); render();
  }

  function remove(key) { db.entries = db.entries.filter((e) => e.key !== key); save(); render(); }

  /**
   * A small static seal: circle, path(s), start circle.
   * Built entirely from the key, so thumbnails survive a cleared session.
   */
  function drawThumb(cv, key) {
    const members = key.split('+');
    const sig = members.length > 1 && typeof Fusion !== 'undefined'
      ? Fusion.build(members) : buildSigil(members[0]);

    const s = cv.width, g = cv.getContext('2d'), p = sig.palette;
    g.fillStyle = p.bg; g.fillRect(0, 0, s, s);

    const F = { cx: s / 2, cy: s / 2, R: s * 0.4, base: sig.baseAngle };
    g.strokeStyle = rgba(p.line, 0.32);
    g.lineWidth = Math.max(1, s / 140);
    g.beginPath(); g.arc(F.cx, F.cy, F.R, 0, TAU); g.stroke();

    const line = (nodes, curves, col) => {
      const pts = tracePoints(nodes, curves, ID_T, F, nodes.length - 1);
      g.strokeStyle = rgba(col, 0.95);
      g.lineWidth = Math.max(1, s / 70);
      g.lineJoin = g.lineCap = 'round';
      g.beginPath(); g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.stroke();
      g.beginPath(); g.arc(pts[0], pts[1], s * 0.025, 0, TAU); g.stroke();
    };

    line(sig.nodes, sig.curves, p.line);
    (sig.partners || []).forEach((pt, i) =>
      line(pt.nodes, pt.curves, i ? p.line.map((v, j) => (v + p.accent[j]) >> 1) : p.accent));
  }

  function ago(t) {
    const d = (Date.now() - t) / 1000;
    if (d < 90) return 'just now';
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    return `${Math.round(d / 86400)} d ago`;
  }

  function replay(e) {
    const link = UI.parseKey(e.key);
    if (!link || app.busy) return;
    cast({ text: link.members[0], partners: link.members.slice(1), preset: e.mood || 'ritual', quick: true });
  }

  function render() {
    if (!grid) return;
    grid.innerHTML = '';
    empty.hidden = db.entries.length > 0;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const e of db.entries) {
      const cv = h('canvas', { width: Math.round(96 * dpr), height: Math.round(96 * dpr), 'aria-hidden': 'true' });
      try { drawThumb(cv, e.key); } catch (err) { console.warn('[grimoire thumb]', err); }

      const dress = wordsOf(e.mood);
      const sub = `${dress ? dress.toLowerCase() + ' · ' : ''}${ago(e.played)}${e.burnAt ? ' · fades' : ''}`;

      grid.append(h('div', { class: 'g-card' + (e.key === currentKey ? ' current' : '') },
        h('button', {
          class: 'g-play', title: `${e.key} — played ${e.plays}×`,
          'aria-label': `Play sigil ${e.key.split('').join(' ')}, ${sub}`,
          onclick: () => replay(e),
        }, cv, h('span', { class: 'g-key' }, e.key), h('span', { class: 'g-sub' }, sub)),
        h('button', {
          class: 'g-burn ghost sm', title: 'Burn from the grimoire',
          'aria-label': `Burn ${e.key}`,
          onclick: () => { remove(e.key); UI.announce('Burned.'); },
        }, '×')));
    }
  }

  UI.section({ id: 'grimoire', title: 'Grimoire', order: 5, open: true, build(el) {
    UI.css(`.g-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0}
      .g-card{position:relative}
      .g-play{display:flex;flex-direction:column;align-items:center;gap:3px;width:100%;padding:6px 4px 8px;border-color:rgba(var(--line),.1);text-transform:none;letter-spacing:.1em}
      .g-play canvas{width:100%;height:auto;aspect-ratio:1;display:block}
      .g-key{font-size:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .g-sub{font-size:9.5px;opacity:.5;font-style:italic;letter-spacing:.03em}
      .g-card.current .g-play{border-color:rgba(var(--accent),.65)}
      .g-burn{position:absolute;top:3px;right:3px;padding:1px 7px;font-size:13px;opacity:0;transition:opacity .2s}
      .g-card:hover .g-burn,.g-burn:focus-visible{opacity:.85}
      @media (hover:none){.g-burn{opacity:.6}}`);

    grid = h('div', { class: 'g-grid' });
    empty = UI.note('Your grimoire is empty. Each sigil you cast is kept here as consonants only, never as words.');
    const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none',
                              onchange: () => importFile(file) });

    el.append(empty, grid,
      UI.check({ label: 'Keep new sigils in the grimoire', checked: db.keep, onChange: (v) => { db.keep = v; save(); } }),
      UI.select({
        label: 'Let new sigils fade', value: String(db.burnDays),
        options: [['0', 'Never'], ['1', 'After a day'], ['7', 'After a week'],
                  ['29.53', 'After a lunar month'], ['365', 'After a year']],
        onChange: (v) => { db.burnDays = +v; save(); },
      }),
      h('div', { class: 'sgrow' },
        UI.button('Export', () => download(new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' }), 'grimoire.json')),
        UI.button('Import', () => file.click()),
        UI.button('Burn all', () => {
          if (confirm('Burn every sigil in the grimoire? This cannot be undone.')) { db.entries = []; save(); render(); }
        })),
      file);

  } });

  async function importFile(input) {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : data.entries;
      let n = 0;
      for (const e of list || []) {
        if (!e || !UI.parseKey(e.key) || db.entries.some((x) => x.key === e.key)) continue;
        db.entries.push({
          key: e.key, mood: e.mood || 'ritual',
          created: +e.created || Date.now(), played: +e.played || Date.now(),
          plays: +e.plays || 0, burnAt: +e.burnAt || null,
        });
        n++;
      }
      db.entries.sort((a, b) => b.played - a.played);
      db.entries.length = Math.min(db.entries.length, LIMIT);
      save(); render();
      toast(`${n} sigil${n === 1 ? '' : 's'} added to the grimoire`, true);
    } catch { toast('That file is not a grimoire', true); }
  }

  Hooks.on('cast', (sig, song) => {
    currentKey = keyOf(sig);
    if (db.keep) upsert(currentKey, working(song.cfg)); else render();
  });

  Hooks.on('song', (sig, song, info) => {
    if (info && info.recompose && db.keep) {
      const e = db.entries.find((x) => x.key === keyOf(sig));
      if (e) { e.mood = working(song.cfg); save(); render(); }
    }
  });

  Hooks.on('forget', (sig) => { if (sig) remove(keyOf(sig)); });   // forgetting means forgetting
  Hooks.on('stop', () => { currentKey = null; render(); });

  UI.key('g', 'Open the grimoire', () => UI.open('grimoire'), { group: 'Library', display: 'G' });

  UI.whenReady(() => {
    const n = purge();
    render();
    if (n) setTimeout(() => toast(`${n} sigil${n === 1 ? ' has' : 's have'} faded from your grimoire.`, true, 4000), 1500);
  });

  return { upsert, remove, list: () => db.entries.slice() };
})();