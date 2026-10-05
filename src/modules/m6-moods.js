'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M6 · MOODS — arrangement presets, via the 'compose' and 'plan' filters
   --------------------------------------------------------------------------
   A mood changes the ARRANGEMENT only. The sigil, the melody and the form are
   untouched, which is why UI.recompose() can swap moods mid-performance and
   resume at the same section.

   Presets that need randomness draw from stream(hash, 'mood:<id>'), never from
   the composer's R, so they cannot disturb the melody or the rhythm jitter.

   Runs AFTER M10 Astral (priority −10), so an explicit mood overrides the
   planetary mode.
   ══════════════════════════════════════════════════════════════════════════ */

const Moods = (() => {
  'use strict';
  const { h } = UI;

  const MOODS = {
    ritual: { label: 'Ritual', blurb: 'The full rite, from invocation to banishing.' },

    ambient: {
      label: 'Ambient', blurb: 'No drums. Slow breath, long bells, open space.',
      compose(cfg) {
        cfg.bpm = Math.round(cfg.bpm * 0.72);
        if (cfg.leadTimbre === 'koto') cfg.leadTimbre = 'glass';
        cfg.P.swing = 0;
        cfg.levels = { drums: 0, bass: 0.55, pad: 1.15, drone: 1.2 };
      },
      plan(plan) {
        for (const s of plan) {
          s.intensity = 0; s.drone = true; s.halfTime = false; s.density = 0;
          if (s.arp) s.arp = 'light';
        }
      },
    },

    pulse: {
      label: 'Pulse', blurb: 'Brighter and driving: a steady four-on-the-floor pulse with arpeggios everywhere.',
      compose(cfg) {
        cfg.bpm = Math.min(160, Math.round(cfg.bpm * 1.25));
        cfg.P.kick = euclid(4, 16, 0);
        cfg.P.swing = Math.min(cfg.P.swing, 0.12);
        cfg.levels = { drums: 1.1, arp: 1.15 };
      },
      plan(plan) {
        for (const s of plan) {
          if (s.id === 'intro' || s.id === 'outro') { s.intensity = 1; continue; }
          s.intensity = Math.max(2, s.intensity);
          s.halfTime = false;
          s.arp = s.intensity >= 3 ? 'full' : 'light';
        }
      },
    },

    lullaby: {
      label: 'Lullaby', blurb: 'Major modes, music-box bells, a rocking hush.',
      compose(cfg) {
        const MAJ = { Aeolian: 'Ionian', Dorian: 'Mixolydian', Phrygian: 'Lydian', 'Harmonic minor': 'Ionian' };
        cfg.modeName = MAJ[cfg.modeName] || cfg.modeName;
        cfg.bpm = Math.round(cfg.bpm * 0.74);
        cfg.leadTimbre = 'glass';
        cfg.voicing = { seventh: false, ninth: true };
        cfg.P.arp = 'pendulum';
        cfg.levels = { drums: 0.45, bass: 0.7, arp: 0.9 };
      },
      plan(plan) {
        for (const s of plan) {
          s.intensity = Math.min(1, s.intensity);
          s.halfTime = false; s.density = 0;
          if (s.arp || s.harm) s.arp = 'light';
        }
      },
    },

    dirge: {
      label: 'Dirge', blurb: 'Slow processional: Phrygian or harmonic minor, half-time drums, constant drone.',
      compose(cfg, R) {
        cfg.modeName = R.pick(['Phrygian', 'Harmonic minor']);
        cfg.bpm = Math.round(cfg.bpm * 0.8);
        cfg.leadTimbre = 'reed';
        cfg.levels = { drone: 1.3, drums: 0.85 };
      },
      plan(plan) {
        for (const s of plan) {
          s.drone = true;
          s.intensity = Math.min(2, s.intensity);
          if (s.intensity > 0) s.halfTime = true;
        }
      },
    },

    ecstatic: {
      label: 'Ecstatic', blurb: 'Fast and trancelike: 136–172 bpm, breakbeat half-time drums, rolling arpeggios, doubled choruses.',
      compose(cfg) {
        // Map the hash's own tempo (74–98) linearly into 136–172, so the sigil
        // still determines where in the range it lands.
        cfg.bpm = Math.round(136 + ((clamp(cfg.bpm, 74, 98) - 74) / 24) * 36);
        cfg.P.swing = 0;
        if (cfg.P.arp === 'up') cfg.P.arp = 'broken';
        cfg.levels = { drums: 1.05, arp: 1.1, pad: 0.9 };
        cfg.formExtended = true;   // this mood lengthens its own form (below), so M2 stands down
      },
      plan(plan) {
        for (const s of plan) {
          if (s.id === 'intro' || s.id === 'outro') { s.intensity = 1; s.halfTime = false; continue; }
          s.intensity = s.id.startsWith('verse') ? 2 : 3;
          s.halfTime = true;         // half-time at 150+ reads as double-time energy
          s.arp = 'full'; s.bass = true;
          if (s.id.startsWith('chorus') || s.id === 'bridge') s.phrases *= 2;
        }
      },
    },
  };

  let current = MOODS[Prefs.get('mood', 'ritual')] ? Prefs.get('mood', 'ritual') : 'ritual';
  const groups = [];   // every rendered pill group, kept in sync

  function set(id, { persist = true } = {}) {
    if (!MOODS[id]) id = 'ritual';
    current = id;
    if (persist) Prefs.set('mood', id);
    for (const g of groups) {
      g.querySelectorAll('button[data-mood]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mood === id)));
      const bl = g.querySelector('.mood-blurb');
      if (bl) bl.textContent = MOODS[id].blurb;
    }
  }

  /** @param {boolean} live true on the Tools panel (recomposes), false on the invocation screen. */
  function pills(live) {
    const g = h('div', { class: 'moods', role: 'group', 'aria-label': 'Mood' },
      h('div', { class: 'mood-pills' }, Object.entries(MOODS).map(([id, m]) =>
        UI.button(m.label, () => {
          set(id);
          if (live && app.mode === 'playing') { UI.recompose(); UI.announce(`${m.label} mood`); }
        }, { 'data-mood': id, title: m.blurb, 'aria-pressed': String(id === current) }))),
      h('div', { class: 'mood-blurb' }, MOODS[current].blurb));
    groups.push(g);
    return g;
  }

  Hooks.on('compose', (cfg, sigil) => {
    cfg.mood = current;
    const m = MOODS[current];
    if (m.compose) m.compose(cfg, stream(sigil.hash, 'mood:' + current));
  });
  Hooks.on('plan', (plan, cfg) => { const m = MOODS[cfg.mood]; if (m && m.plan) m.plan(plan, cfg); });
  Hooks.on('shareKey', (key) => (current !== 'ritual' ? key + '~' + current : undefined), 10);
  Hooks.on('meta', (parts) => { const m = app.song && app.song.cfg.mood; if (m && m !== 'ritual') parts.push(MOODS[m].label); });
  Hooks.on('beforeCast', (ctx) => { if (ctx.opts.preset) set(ctx.opts.preset, { persist: false }); });
  Hooks.on('link', (link) => { if (link.preset) set(link.preset, { persist: false }); });

  UI.css(`.moods{margin-top:14px;text-align:center}.mood-pills{display:flex;flex-wrap:wrap;justify-content:center;gap:6px}
    .moods button{padding:5px 11px;font-size:9.5px}.mood-blurb{font-size:12.5px;opacity:.45;font-style:italic;margin-top:8px;min-height:1.2em}
    #tool-moods .moods{text-align:left}#tool-moods .mood-pills{justify-content:flex-start}`);

  document.querySelector('#invoke .hint').before(pills(false));

  UI.section({ id: 'moods', title: 'Mood', order: 10, build(el) {
    el.append(pills(true),
      UI.note('Changing the mood during a performance re-composes the song and resumes at the current section. The sigil, melody and form stay the same; only the arrangement changes.'));
  } });

  return { set, get: () => current, MOODS };
})();