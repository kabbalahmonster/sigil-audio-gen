'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M5 · ACCESS — motion, contrast, text size, screen-reader support
   --------------------------------------------------------------------------
   The 'palette' filter runs at priority 100, so high contrast ALWAYS wins
   over the sigil palette and over M10's planetary palettes.

   Every override here is reversible: the original motes array and spawn()
   are captured and restored rather than destroyed.
   ══════════════════════════════════════════════════════════════════════════ */

const Access = (() => {
  'use strict';

  const mm = (q) => (window.matchMedia ? matchMedia(q) : { matches: false, addEventListener() {} });
  const mqMotion = mm('(prefers-reduced-motion: reduce)');
  const mqContrast = mm('(prefers-contrast: more)');

  const S = { motion: 'auto', contrast: 'auto', large: false, announce: true, ...Prefs.get('a11y', {}) };

  const CONTRAST = { name: 'High contrast', bg: '#000000', line: [255, 255, 255], accent: [255, 214, 0] };

  const reduced  = () => S.motion === 'on'   || (S.motion === 'auto'   && mqMotion.matches);
  const contrast = () => S.contrast === 'on' || (S.contrast === 'auto' && mqContrast.matches);

  UI.css(`body.a11y-reduce *,body.a11y-reduce *::before,body.a11y-reduce *::after{animation-duration:.001ms!important;animation-delay:0ms!important;transition-duration:.001ms!important}
    body.a11y-large #secInfo .name{font-size:31px}body.a11y-large #secInfo .desc,body.a11y-large #meta{font-size:15px}
    body.a11y-large #letters{font-size:25px}body.a11y-large button{font-size:12.5px}
    body.a11y-large .tool-body,body.a11y-large .ctl{font-size:16px}body.a11y-large .tool-note{font-size:14.5px}
    body.a11y-large #desire{font-size:28px}body.a11y-large .hint,body.a11y-large #invoke label{font-size:17px}
    #progress:focus-visible{outline:1px dotted rgba(var(--accent),.8);outline-offset:4px}`);

  /* Renderer hooks. Motes are swapped out; sparks are gated at the source. */
  const motes = renderer.motes;
  const spawn = renderer.spawn.bind(renderer);
  renderer.spawn = (...a) => (reduced() ? undefined : spawn(...a));

  Hooks.on('palette', () => (contrast() ? CONTRAST : undefined), 100);

  function applyAll() {
    document.body.classList.toggle('a11y-reduce', reduced());
    document.body.classList.toggle('a11y-large', !!S.large);
    renderer.motes = reduced() ? [] : motes;
    UI.refreshPalette();
    Prefs.set('a11y', S);
  }

  mqMotion.addEventListener && mqMotion.addEventListener('change', applyAll);
  mqContrast.addEventListener && mqContrast.addEventListener('change', applyAll);

  /** A prose description of the current sigil, for the canvas aria-label and on demand. */
  function describe() {
    const { sigil, song } = app;
    if (!sigil || !song) return 'No sigil is active.';

    const curved = sigil.curves.filter((c) => c !== 0).length;
    const parts = [
      `Sigil of ${sigil.reduced.length} letters: ${[...sigil.reduced].join(' ')}.`,
      `A path of ${sigil.nodes.length - 1} strokes, ${curved} of them curved, across a wheel of twenty-one consonants.`,
      `Music in ${song.keyName.replace('♯', ' sharp').replace('♭', ' flat')}, ` +
      `${Math.round(60 / (app.engine ? app.engine.spb : song.spb))} beats per minute, ` +
      `sung by ${TIMBRE_NAMES[song.leadTimbre]}.`,
    ];
    if (sigil.partners && sigil.partners.length) {
      parts.push(`Joined by ${sigil.partners.map((p) => [...p.reduced].join(' ')).join(', and ')}.`);
    }
    const rite = typeof Rite !== 'undefined' && song.cfg ? Rite.RITES[song.cfg.rite || Rite.DEFAULT] : null;
    if (rite) parts.push(`The rite is ${rite.label}, in ${song.sections.length} sections.`);
    const si = renderer.info ? renderer.info.si : null;
    if (si != null && app.mode === 'playing' && song.sections[si]) {
      const s = song.sections[si];
      parts.push(`Now in section ${s.roman}, ${s.name}: ${s.desc}.`);
    }
    return parts.join(' ');
  }

  /* The progress bar becomes a keyboard slider over sections. */
  const prog = document.querySelector('#progress');
  Object.entries({
    tabindex: '0', role: 'slider',
    'aria-label': 'Song form. Use the arrow keys to move between sections.',
    'aria-valuemin': '1', 'aria-valuemax': '7', 'aria-valuenow': '1',
  }).forEach(([k, v]) => prog.setAttribute(k, v));

  prog.addEventListener('keydown', (e) => {
    if (app.mode !== 'playing') return;
    const S2 = app.song.sections, si = renderer.info ? renderer.info.si : 0;
    const t = { ArrowRight: si + 1, ArrowUp: si + 1, ArrowLeft: si - 1, ArrowDown: si - 1,
                Home: 0, End: S2.length - 1 }[e.key];
    if (t == null) return;
    e.preventDefault();
    e.stopPropagation();      // don't let the Live Lens arrow keys fire too
    app.engine.seek(S2[clamp(t, 0, S2.length - 1)].start);
  });

  Hooks.on('section', (s, si, song) => {
    prog.setAttribute('aria-valuemax', String(song.sections.length));
    prog.setAttribute('aria-valuenow', String(si + 1));
    prog.setAttribute('aria-valuetext', `${s.roman}, ${s.name}`);
    if (S.announce) UI.announce(`Section ${s.roman}: ${s.name}. ${s.desc}.`);
  });

  Hooks.on('song', () => {
    renderer.cv.setAttribute('role', 'img');
    renderer.cv.setAttribute('aria-label', describe());
  });

  UI.section({ id: 'access', title: 'Access', order: 90, build(el) {
    el.append(
      UI.select({ label: 'Motion', value: S.motion,
        options: [['auto', 'Follow system'], ['on', 'Reduced'], ['off', 'Full']],
        onChange: (v) => { S.motion = v; applyAll(); } }),
      UI.select({ label: 'Contrast', value: S.contrast,
        options: [['auto', 'Follow system'], ['on', 'High'], ['off', 'Palette']],
        onChange: (v) => { S.contrast = v; applyAll(); } }),
      UI.check({ label: 'Larger text', checked: S.large, onChange: (v) => { S.large = v; applyAll(); } }),
      UI.check({ label: 'Announce sections to screen readers', checked: S.announce,
                 onChange: (v) => { S.announce = v; Prefs.set('a11y', S); } }),
      UI.h('div', { class: 'sgrow' }, UI.button('Describe the sigil', () => UI.announce(describe()))));
  } });

  UI.whenReady(applyAll);

  return { describe, reduced };
})();