'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m15 · DRUM ENGINE — settings
   --------------------------------------------------------------------------
   The kit is synthesised in the kernel (kick, snare, hat, noise) and voiced by
   Score, which reads these settings when it compiles. This module is the panel:
   how hard the kick ducks the music, whether the duck follows the rite, and
   whether the kit is tuned to the chord it lands on.
   ══════════════════════════════════════════════════════════════════════════ */
const DrumEngine = (() => {
  'use strict';

  const S = { ...Score.DRUM_DEFAULTS, ...Prefs.get('drums', {}) };
  const change = () => { Prefs.set('drums', S); if (app.engine && app.engine.song) app.engine.refresh(); };

  const pct = (v) => `${Math.round(v * 100)}%`;
  let duckRow, scRow, secRow, tuneRow, octRow;

  function refresh() {
    if (!duckRow) return;
    duckRow.set(S.duck);
    scRow.input.checked = S.sidechain;
    secRow.input.checked = S.sectionAware;
    tuneRow.input.checked = S.tuneToKey;
    octRow.input.value = S.kickOct;
  }

  UI.section({ id: 'drums', title: 'Drum Engine', order: 14, build(el) {
    duckRow = UI.slider({ label: 'Duck', min: 0, max: 1, step: 0.01, value: S.duck, format: pct,
      onInput: (v) => { S.duck = v; change(); } });
    scRow = UI.check({ label: 'Sidechain the music to the kick', checked: S.sidechain,
      onChange: (v) => { S.sidechain = v; change(); } });
    secRow = UI.check({ label: 'Section-aware ducking (follows the rite)', checked: S.sectionAware,
      onChange: (v) => { S.sectionAware = v; change(); } });
    tuneRow = UI.check({ label: 'Tune kick and drums to the chord', checked: S.tuneToKey,
      onChange: (v) => { S.tuneToKey = v; change(); } });
    octRow = UI.select({ label: 'Kick octave', value: S.kickOct,
      options: [['auto', 'Auto'], ['low', 'Low'], ['high', 'High']],
      onChange: (v) => { S.kickOct = v; change(); } });
    el.append(
      UI.note('The kit is chosen by Size and Colour in the Sound panel, and shaped there too. This panel sets how the drums move the music: how hard the kick ducks, and whether the duck follows the rite. The kick’s pitch follows the chord it lands on.'),
      duckRow, scRow, secRow, tuneRow, octRow);
    refresh();
  } });

  Hooks.on('song', refresh);
  UI.whenReady(refresh);

  return {
    get settings() { return S; },
    chordAt: Score.chordAt,
    rootAt: (song, beat) => Score.rootAt(song, beat, S.tuneToKey),
  };
})();
if (typeof window !== 'undefined') window.DrumEngine = DrumEngine;