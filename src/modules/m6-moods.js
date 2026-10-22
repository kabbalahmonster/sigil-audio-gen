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
        cfg.drums = { steady: true };          // m15: the four-on-the-floor is the point, so the kick takes no liberties
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
        cfg.drums = { fills: 0.2, variation: 0.4 };   // m15: a hush does not fill
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
    glacier: {
      label: 'Glacier', blurb: 'Vast and slow. Sub-heavy pads, deep chorus, no drums, nothing in a hurry.',
      compose(cfg) {
        cfg.bpm = Math.round(cfg.bpm * 0.55);
        cfg.modeName = cfg.modeName === 'Phrygian' ? 'Aeolian' : cfg.modeName;
        cfg.voicing = { seventh: true, ninth: true };
        cfg.P.swing = 0;
        cfg.levels = { drums: 0, bass: 0.9, pad: 1.3, drone: 1.35, arp: 0.4 };
        cfg.sound = { sub: 0.9, chorus: 0.8, grit: 0, bright: 0.35, sweep: 0.25, drift: 0.15, echo: 0.7 };
        cfg.master = { tone: 0.6 };                   // 05e: vast and dark on purpose
      },
      plan(plan) {
        for (const s of plan) { s.intensity = 0; s.drone = true; s.halfTime = false; s.density = 0; if (s.arp) s.arp = 'light'; }
      },
    },

    swarm: {
      label: 'Swarm', blurb: 'Rolling arpeggios everywhere, metallic and restless, like something counting.',
      compose(cfg, R) {
        cfg.modeName = R.pick(['Dorian', 'Phrygian']);
        cfg.bpm = Math.round(cfg.bpm * 1.18);
        cfg.P.arp = 'broken';
        cfg.P.swing = 0;
        cfg.levels = { arp: 1.25, pad: 0.8, drums: 0.95 };
        cfg.sound = { layer: 3, drift: 0.7, sweep: 0.8, grit: 0.45, bits: 6, hold: 2, chorus: 0.5, sub: 0.2 };
      },
      plan(plan) {
        for (const s of plan) {
          if (s.id === 'intro' || s.id === 'outro') { s.intensity = 1; s.arp = 'light'; continue; }
          s.intensity = Math.max(2, s.intensity); s.arp = 'full'; s.density = 1; s.halfTime = false;
        }
      },
    },

    abyss: {
      label: 'Abyss', blurb: 'Down in the dark. Harmonic minor, half-time, a folded sub that will not let go.',
      compose(cfg, R) {
        cfg.modeName = R.pick(['Phrygian', 'Harmonic minor']);
        cfg.bpm = Math.round(cfg.bpm * 0.65);
        cfg.leadTimbre = 'reed';
        cfg.levels = { bass: 1.3, drone: 1.4, drums: 0.85, bell: 0.7 };
        cfg.sound = { layer: 4, sub: 1, fold: 0.45, drive: 0.5, grit: 0.55, bits: 8, bright: 0.25, throat: -0.45 };
      },
      plan(plan) {
        for (const s of plan) {
          s.drone = true; s.intensity = Math.min(2, s.intensity);
          if (s.intensity > 0) s.halfTime = true;
        }
      },
    },

    aurora: {
      label: 'Aurora', blurb: 'Lydian and luminous. Wide chorus, bright bells, drums far away.',
      compose(cfg) {
        const LIFT = { Aeolian: 'Lydian', Phrygian: 'Lydian', Dorian: 'Mixolydian', 'Harmonic minor': 'Ionian' };
        cfg.modeName = LIFT[cfg.modeName] || 'Lydian';
        cfg.bpm = Math.round(cfg.bpm * 0.88);
        cfg.leadTimbre = 'glass';
        cfg.voicing = { seventh: false, ninth: true };
        cfg.levels = { drums: 0.5, arp: 1.1, pad: 1.15, bell: 1.1 };
        cfg.sound = { chorus: 0.85, bright: 0.95, layer: 2, sweep: 0.6, drift: 0.45, grit: 0, echo: 0.65, sub: 0.25 };
      },
      plan(plan) {
        for (const s of plan) {
          s.intensity = Math.min(2, s.intensity); s.halfTime = false;
          if (s.intensity >= 2) s.arp = 'light';
        }
      },
    },

    procession: {
      label: 'Procession', blurb: 'Something is being carried. Heavy half-time drums, a drone beneath it all.',
      compose(cfg) {
        cfg.bpm = Math.round(cfg.bpm * 0.78);
        cfg.P.kick = euclid(3, 16, 0);
        cfg.P.swing = Math.max(cfg.P.swing, 0.12);
        cfg.levels = { drums: 1.15, drone: 1.25, bass: 1.1, arp: 0.6 };
        cfg.sound = { drums: 1.3, sub: 0.6, drive: 0.35, grit: 0.3, bits: 10, chorus: 0.3, bright: 0.5 };
      },
      plan(plan) {
        for (const s of plan) {
          if (s.id === 'intro' || s.id === 'outro') { s.intensity = 1; continue; }
          s.intensity = Math.max(2, s.intensity); s.halfTime = true; s.drone = true;
        }
      },
    },    clockwork: {
      label: 'Clockwork', blurb: 'Precise and mechanical. Tight kit, bit-crushed arpeggios, nothing human.',
      compose(cfg) {
        cfg.P.swing = 0;
        cfg.P.arp = 'up';
        cfg.bpm = Math.round(cfg.bpm * 1.08);
        cfg.levels = { arp: 1.2, drums: 1.05, pad: 0.7 };
        cfg.sound = { grit: 0.6, bits: 6, hold: 3, chorus: 0.1, sweep: 0.15, drift: 0, layer: 7, sub: 0.3, drums: 1.1, kPunch: 1.5, sSnap: 1.4, hDecay: 0.5 };
        cfg.drums = { human: 0, steady: true };   // the drum engine (m15): no drummer's hand, no liberties with the kick
        cfg.master = { noise: 5 };                // the master (05e): the crushed grain IS this mood, so more of it is let through
      },
      plan(plan) {
        for (const s of plan) { s.halfTime = false; if (s.intensity > 0) s.intensity = 2; if (s.arp) s.arp = 'full'; }
      },
    },

    fathom: {
      label: 'Fathom', blurb: 'Far under. Everything filtered, the kick felt more than heard.',
      compose(cfg) {
        cfg.bpm = Math.round(cfg.bpm * 0.7);
        cfg.levels = { bass: 1.25, drone: 1.3, bell: 0.5, arp: 0.4, drums: 0.8 };
        cfg.sound = { bright: 0.16, layer: 4, sub: 1, tilt: 0.5, chorus: 0.5, echo: 0.7, grit: 0.2, bits: 10, drumX: 1, drumY: 0.2, kSub: 1.6, kDecay: 1.6, hTone: 0.4 };
        cfg.drums = { fills: 0.25 };                  // m15: felt more than heard
        cfg.master = { tone: 0.5 };                   // 05e: it is meant to be dark; the master opens it only half as far as it would
      },
      plan(plan) { for (const s of plan) { s.drone = true; s.intensity = Math.min(1, s.intensity); s.density = 0; } },
    },

    gilded: {
      label: 'Gilded', blurb: 'Ceremonial and bright. Bells, wide chorus, a processional kit.',
      compose(cfg) {
        cfg.modeName = cfg.modeName === 'Phrygian' ? 'Lydian' : cfg.modeName;
        cfg.leadTimbre = 'glass';
        cfg.voicing = { seventh: true, ninth: true };
        cfg.levels = { bell: 1.3, pad: 1.15, harm: 1.2 };
        cfg.sound = { voice: 'bell', bright: 0.95, chorus: 0.8, layer: 2, density: 1.6, tilt: -0.3, grit: 0, sub: 0.35, drums: 0.95, sTone: 1.4 };
        cfg.master = { tone: 0.5 };                   // 05e: it is meant to be bright; the master tames it only half as far
      },
      plan(plan) { for (const s of plan) { if (s.intensity >= 2) s.harm = true; s.halfTime = false; } },
    },

    static: {
      label: 'Static', blurb: 'A transmission breaking up. Heavy crushing, folded voices, hats like interference.',
      compose(cfg, R) {
        cfg.bpm = Math.round(cfg.bpm * (R.chance(0.5) ? 0.9 : 1.15));
        cfg.levels = { drums: 1.1, pad: 0.75, lead: 1.05 };
        cfg.sound = { grit: 0.9, bits: R.pick([3, 4, 5]), hold: R.pick([3, 5, 7]), fold: 0.6, drive: 0.7, layer: 3, density: 1.8, breath: 0.6, hTone: 1.8, hDecay: 0.5, drumY: 0.9 };
        cfg.master = { noise: 8 };                    // 05e: a transmission breaking up is mostly grain; the master lets it be
      },
      plan(plan) { for (const s of plan) { if (s.intensity > 0) s.intensity = Math.max(2, s.intensity); s.density = 1; } },
    },

    vigil: {
      label: 'Vigil', blurb: 'Held and watchful. Bowed voices, almost no percussion, one long breath.',
      compose(cfg) {
        cfg.bpm = Math.round(cfg.bpm * 0.82);
        cfg.levels = { drums: 0.25, pad: 1.2, harm: 1.25, drone: 1.2 };
        cfg.sound = { voice: 'bow', bright: 0.45, chorus: 0.7, sweep: 0.3, drift: 0.25, sub: 0.5, grit: 0, echo: 0.6, drums: 0.4, hDecay: 1.4 };
        cfg.drums = { fills: 0, variation: 0.3 };     // m15: almost no percussion means no fills either
      },
      plan(plan) {
        for (const s of plan) { s.intensity = Math.min(1, s.intensity); s.drone = true; s.halfTime = false; }
      },
    },nocturne: {
      label: 'Nocturne', blurb: 'Dorian and unhurried: reed lead, sparse drums, a long bridge.',
      compose(cfg) {
        cfg.modeName = 'Dorian'; cfg.bpm = Math.round(cfg.bpm * 0.85); cfg.leadTimbre = 'reed';
        cfg.levels = { drums: 0.6, pad: 1.1 };
      },
      plan(plan) {
        for (const s of plan) { if (s.id === 'bridge') s.halfTime = true; if (s.intensity > 2) s.intensity = 2; }
      },
    },
    ember: {
      label: 'Ember', blurb: 'Phrygian heat: plucked strings, pendulum arpeggios, a rising drone.',
      compose(cfg) {
        cfg.modeName = 'Phrygian'; cfg.bpm = Math.round(cfg.bpm * 1.05); cfg.leadTimbre = 'koto';
        cfg.P.arp = 'pendulum'; cfg.levels = { drone: 1.2, arp: 1.1 };
      },
      plan(plan) { for (const s of plan) { s.drone = true; if (s.arp) s.arp = 'light'; } },
    },
    tidewater: {
      label: 'Tidewater', blurb: 'Lydian and wide: glass bells, a swelling sub-bass, constant drone.',
      compose(cfg) {
        cfg.modeName = 'Lydian'; cfg.bpm = Math.round(cfg.bpm * 0.8); cfg.leadTimbre = 'glass';
        cfg.levels = { bass: 1.1, drone: 1.3, drums: 0.5 };
      },
      plan(plan) { for (const s of plan) { s.drone = true; s.halfTime = s.intensity > 0; } },
    },
    sanctum: {
      label: 'Sanctum', blurb: 'Aeolian stillness: bells and breath, no arpeggios, almost no drums.',
      compose(cfg) {
        cfg.modeName = 'Aeolian'; cfg.bpm = Math.round(cfg.bpm * 0.65); cfg.leadTimbre = 'glass';
        cfg.levels = { drums: 0, arp: 0, bass: 0.6 };
      },
      plan(plan) { for (const s of plan) { s.intensity = Math.min(1, s.intensity); s.arp = null; s.density = 0; } },
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

window.Moods = Moods;