'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M8 · FUSION — up to three desires on one wheel, as counterpoint
   --------------------------------------------------------------------------
   The returned sigil object is COMPATIBLE with everything in the core:
   `nodes` and `curves` belong to the primary voice, and `partners[]` hold the
   others. Anything that does not know about Fusion simply plays voice one.

   The wheel hash is order-independent (members are sorted before hashing), so
   "A joined with B" and "B joined with A" share a wheel — but the MELODY is
   the first member's, so the two are different songs on the same geometry.
   ══════════════════════════════════════════════════════════════════════════ */

const Fusion = (() => {
  'use strict';
  const { h } = UI;

  const MAX_EXTRA = 2;   // three voices total

  /** Build a fused sigil from reduced consonant strings (the first one leads). */
  function build(members) {
    const hash = hashStr('SIGIL/fusion::' + [...members].sort().join('+'));
    const g = stream(hash, 'geometry');

    const wheel = g.shuffle(CONSONANTS);
    const slotOf = {}; wheel.forEach((L, i) => (slotOf[L] = i));
    const ringOf = {}; CONSONANTS.forEach((L) => (ringOf[L] = g.int(0, 2)));
    const baseAngle = g.float() * TAU;

    // Each voice draws its curves from its OWN labelled stream, so adding a
    // third voice never changes the shape of the first two.
    const voice = (r) => {
      const c = stream(hash, 'curves:' + r);
      const nodes = [...r].map((L) => ({ letter: L, slot: slotOf[L], ring: ringOf[L] }));
      const curves = nodes.slice(1).map(() => (c.chance(0.42) ? c.range(0.28, 0.62) * (c.chance(0.5) ? 1 : -1) : 0));
      return { reduced: r, nodes, curves };
    };

    const [first, ...rest] = members.map(voice);

    return {
      reduced: first.reduced,
      fusionKey: members.join('+'),
      label: members.join(' + '),
      hash, hex: toHex(hash),
      wheel, baseAngle,
      nodes: first.nodes, curves: first.curves,
      letterSet: new Set(members.join('')),
      palette: PALETTES[stream(hash, 'palette').int(0, PALETTES.length - 1)],
      partners: rest,
    };
  }

  /* ── Invocation UI: extra voice inputs ─────────────────────────────── */

  UI.css(`.voices{display:flex;flex-direction:column;gap:6px;margin-top:6px}
    .voice-row{display:flex;gap:8px;align-items:flex-end}
    .voice-in{flex:1;min-width:0;background:transparent;border:0;border-bottom:1px solid rgba(var(--line),.2);color:rgb(var(--line));font-family:inherit;font-size:17px;font-style:italic;padding:6px 4px;text-align:center;outline:none;border-radius:0;pointer-events:auto}
    .voice-in:focus{border-bottom-color:rgba(var(--accent),.7)}
    .add-voice{margin-top:10px}
    #letters.fused{font-size:16px;letter-spacing:.26em;white-space:normal;max-width:min(520px,80vw);margin-left:auto;margin-right:auto}
    #letters .sep{opacity:.35;padding:0 .25em}#letters .p1{color:rgba(var(--accent),.9)}#letters .p2{opacity:.8;font-style:italic}`);

  const voices = h('div', { class: 'voices' });
  const addBtn = h('button', {
    class: 'ghost sm add-voice', type: 'button',
    title: 'Join another desire to this one (up to three voices)',
    onclick: () => addVoice(),
  }, '+ join another desire');

  document.querySelector('#invoke .field').after(voices, addBtn);

  function addVoice(value = '') {
    if (voices.children.length >= MAX_EXTRA) return;
    const inp = h('input', {
      class: 'voice-in', maxlength: '180', autocomplete: 'off', spellcheck: 'false',
      placeholder: voices.children.length ? 'and a third…' : 'and another desire…',
      'aria-label': 'Additional desire', value,
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') cast(); });

    const row = h('div', { class: 'voice-row' }, inp,
      h('button', { class: 'ghost sm', type: 'button', 'aria-label': 'Remove this voice',
                    onclick: () => { row.remove(); syncAdd(); } }, '×'));

    voices.append(row);
    syncAdd();
    if (!value) inp.focus();
  }

  const syncAdd = () => (addBtn.hidden = voices.children.length >= MAX_EXTRA);
  const clearVoices = () => { voices.innerHTML = ''; syncAdd(); };

  /* ── Core integration ──────────────────────────────────────────────── */

  Hooks.on('buildSigil', (sig, ctx) => {
    // Explicit partners (grimoire replays, shared links) win over the input
    // fields — even when the explicit list is empty.
    const raw = ctx.opts.partners ?? [...voices.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    if (!raw.length) return;

    const members = [ctx.reduced];
    for (const r of raw) {
      const red = reduceDesire(r).reduced;
      if (red.length < 3) return { error: `“${r.slice(0, 24)}” leaves too little after reduction.` };
      if (!members.includes(red)) members.push(red);   // silently drop exact duplicates
    }
    return members.length > 1 ? build(members.slice(0, 3)) : undefined;
  });

  Hooks.on('shareKey', (key, sig) => (sig && sig.fusionKey ? sig.fusionKey : undefined));
  Hooks.on('link', (link) => { clearVoices(); link.members.slice(1).forEach((m) => addVoice(m)); });
  Hooks.on('forget', clearVoices);

  Hooks.on('cast', (sig) => {
    if (sig.partners && sig.partners.length) {
      setTimeout(() => toast(`joined by ${sig.partners.map((p) => p.reduced).join(' · ')}`, true, 3200), 600);
    }
  });

  Hooks.on('song', (sig) => {
    const L = document.querySelector('#letters');
    const fused = !!(sig.partners && sig.partners.length);
    L.classList.toggle('fused', fused);
    if (!fused) return;
    sig.partners.forEach((p, i) => {
      L.append(h('span', { class: 'sep', 'aria-hidden': 'true' }, '+'));
      for (const ch of p.reduced) L.append(h('span', { class: 'p' + (i + 1) }, ch));
    });
  });

  /* ── Drawing: partner paths with their own pens ────────────────────── */

  const mix = (a, b) => a.map((v, i) => (v + b[i]) >> 1);

  Hooks.on('drawPlaying', ({ r, F, T, beat, ph, lines }) => {
    if (!ph.partners || !ph.partners.length) return;

    ph.partners.forEach((pp, i) => {
      const col = i === 0 ? r.pal.accent : mix(r.pal.line, r.pal.accent);

      r.strokeGlow(tracePoints(pp.seq, pp.curves, T, F, pp.seq.length - 1), col, 0.05, 0.8);   // template

      const pts = tracePoints(pp.seq, pp.curves, T, F, penProgress(pp, beat));
      r.strokeGlow(pts, col, 0.75, 1.1);
      lines.push(pts);                                   // so Forget burns it too

      r.circle(pts[0], pts[1], F.R * 0.022, col, 0.8, false, 1.1);                  // start circle
      r.circle(pts[pts.length - 2], pts[pts.length - 1], 2, col, 0.9, true);        // the pen

      for (const nd of pp.path) {
        const age = beat - nd.beat;
        if (age >= 0 && age < 1.5) {
          const [x, y] = nodeXY(nd, T, F), q = age / 1.5;
          r.circle(x, y, 2 + F.R * 0.05 * q, col, 0.6 * (1 - q), false, 1);
        }
      }
    });
  });

  return { build, addVoice };
})();