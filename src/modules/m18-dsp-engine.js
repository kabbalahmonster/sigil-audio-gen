'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m18 · DSP ENGINE HOST (v1, experimental)
   --------------------------------------------------------------------------
   Turns the score into a PLAN the DSP core can play, loads the core into an
   AudioWorklet, and takes the scheduler off the main thread.

   WHAT THE HOST DOES   all the musical thinking: per-event pitch, duration,
     velocity, vowel and consonant for the voice, chord root for the drums, the
     per-section patch overlay, and the band-limited wavetables (built here, in
     idle slices, never on the audio thread).

   WHAT IT DOES NOT DO YET  MIDI export, stems and the offline renderer still
     use the node engine. Switch the engine back to Nodes for those, or wait for
     the render Worker, which reuses this same core.

   SAFETY  it is a toggle. If anything misbehaves, switch to Nodes and
     everything returns to the previous behaviour.
   ══════════════════════════════════════════════════════════════════════════ */

const DspEngine = (() => {
  'use strict';
  const { h } = UI;
  const SD = SoundDesign;
  const CORE_URL = 'src/dsp/sigil-dsp.js';
  const WORKLET_URL = 'src/dsp/sigil-voice.worklet.js';

  const S = { on: Prefs.get('dsp.on', false) };
  let node = null, ready = false, coreSrc = null, planKey = '', building = false;
  let statusEl, toggleEl;

  /* ── Wavetables, built here in slices ────────────────────────────────── */

  /** Every cube cell the plan can reach, plus the glottal pulse. */
  function tablesFor(sigil, sections) {
    const tb = SD.tables(sigil, Sound.state().variant);
    const want = new Set();
    for (const s of sections) {
      const P = s.P;
      const add = (x, y) => want.add(`${clamp(Math.round(x), 0, SD.FX - 1)},${clamp(Math.round(y), 0, SD.FY - 1)}`);
      add(P.wave, P.layer);
      add(P.wave + P.sweep * 4, P.layer + P.drift * 2.5);
      add(P.wave + P.sweep * 4, P.layer - P.drift * 2.5);
    }
    const out = {};
    for (const key of want) {
      const [x, y] = key.split(',').map(Number);
      const c = tb.grid[y][x];
      // Tilt and density are applied before the table is built, so the audio
      // thread never has to reshape a spectrum.
      const P = sections[0].P;
      const tilt = P.tilt ?? 0, dm = P.density ?? 1;
      const re = new Float32Array(c.re.length), im = new Float32Array(c.im.length);
      for (let hh = 1; hh < c.re.length; hh++) {
        const g = Math.pow(hh, -tilt) * (hh >= SD.UPPER ? dm : 1);
        re[hh] = c.re[hh] * g; im[hh] = c.im[hh] * g;
      }
      out[key] = SigilDSP.buildTables(re, im);
    }
    const gl = SD.glottal();
    out.glottal = SigilDSP.buildTables(gl.re, gl.im);
    out.fallback = out.glottal;
    return out;
  }

  /* ── Plan ────────────────────────────────────────────────────────────── */

  const VOW = SD.VOWELS;
  const CONS_CODE = { plosive: 1, fricative: 2, nasal: 3, liquid: 0 };

  function cellKeys(P, deg) {
    const x0 = clamp(Math.round(P.wave), 0, SD.FX - 1);
    const y0 = clamp(Math.round(P.layer), 0, SD.FY - 1);
    const dir = (deg % 2 === 0) ? 1 : -1;
    const x1 = clamp(Math.round(P.wave + P.sweep * 4), 0, SD.FX - 1);
    const y1 = clamp(Math.round(P.layer + dir * P.drift * 2.5), 0, SD.FY - 1);
    return [`${x0},${y0}`, `${x1},${y1}`];
  }

  function pickKind(P, ev) {
    if (P.voice && P.voice !== 'auto') return P.voice;
    if (ev.timbre === 'reed') return 'vox';
    if (ev.timbre === 'koto') return 'bell';
    return 'wave';
  }

  /** Build the whole plan: sections, events, tables. */
  function buildPlan() {
    const song = app.song, sigil = app.sigil;
    if (!song || !sigil) return null;
    const spb = app.engine ? app.engine.spb : song.spb;
    const st = Sound.state();
    const n = song.sections.length;
    const sections = song.sections.map((sec, si) => ({
      start: sec.start,
      P: Sound.arcOn ? { ...st.P, ...SD.arc(st.P, sec, si, n) } : { ...st.P },
    }));

    const useLens = typeof LiveLens !== 'undefined' && LiveLens.active();
    const events = [];
    const secAt = (beat) => sections[Math.max(0, sectionIndexAt(song, beat))].P;

    for (const raw of song.events) {
      const ev = useLens ? LiveLens.map(raw, song) : raw;
      const t = ev.beat * spb;
      const P = secAt(ev.beat);
      const vel = ev.vel ?? 0.8;

      const pitched = (kind, bus, f, dur, extra) => {
        const [c0, c1] = cellKeys(P, ev.deg ?? 0);
        events.push(Object.assign({
          t, kind, bus, f, f0: ev.from != null ? mtof(ev.from) : 0,
          dur: Math.max(0.05, dur), vel, pan: ev.pan || 0,
          cell0: kind === 'vox' ? 'glottal' : c0, cell1: kind === 'vox' ? 'glottal' : c1,
        }, extra || {}));
      };

      switch (ev.type) {
        case 'lead': case 'harm': {
          const kind = ev.type === 'harm' ? 'vox' : pickKind(P, ev);
          const extra = {};
          if (kind === 'vox') {
            const letter = sigil.reduced[mod(Math.round(ev.beat * 2), sigil.reduced.length)];
            const cls = SD.CONSONANT_CLASS[letter] || 'fricative';
            const i0 = mod((ev.deg ?? 0) + P.vowel, 5), i1 = mod(i0 + 1, 5);
            const tk = Math.pow(2, (P.throat ?? 0) * 0.35);
            extra.vow = [VOW[i0].f.map((x) => x * tk), VOW[i0].g];
            extra.vowTo = [VOW[i1].f.map((x) => x * tk), VOW[i1].g];
            extra.cons = CONS_CODE[cls] ?? 2;
          }
          pitched(kind, ev.type === 'harm' ? 'harm' : 'lead', mtof(ev.midi), ev.dur * spb, extra);
          break;
        }
        case 'bell':
          pitched('bell', 'bell', mtof(ev.midi), ev.dur * spb);
          break;
        case 'bass':
          pitched('wave', 'bass', mtof(ev.midi), ev.dur * spb);
          break;
        case 'arp':
          pitched('wave', 'arp', mtof(ev.midi), ev.dur * spb);
          break;
        case 'pad':
          // The host expands a chord into voices, so the core stays simple.
          for (const m of ev.midis) {
            for (const dt of [-6, 6]) {
              const [c0, c1] = cellKeys(P, 0);
              events.push({ t, kind: 'wave', bus: 'pad', f: mtof(m) * Math.pow(2, dt / 1200),
                f0: 0, dur: ev.dur * spb, vel: vel * 0.25, pan: dt / 12, cell0: c0, cell1: c1 });
            }
          }
          break;
        case 'drone':
          pitched('drone', 'drone', mtof(ev.midi), ev.dur * spb);
          break;
        case 'kick': case 'snare': case 'hat': case 'shaker': case 'crash': {
          const kit = SD.drumKit(sigil.hash, P.drumX, P.drumY);
          const root = typeof DrumEngine !== 'undefined' && song ? DrumEngine.rootAt(song, ev.beat) : 40;
          const letter = sigil.reduced[mod(Math.round(ev.beat * 4), sigil.reduced.length)];
          const tone = SD.CLASS_TONE[SD.CONSONANT_CLASS[letter] || 'fricative'];
          if (ev.type === 'kick') {
            events.push({ t, kind: 'kick', bus: 'drums', vel: vel * P.drums,
              f: mtof(root + kit.kickSemi) * Math.pow(2, (P.kTone ?? 0) / 12) * (kit.kickStyle === 2 ? 0.5 : 1),
              glide: [1.7, 2.6, 1.3, 3.2][kit.kickStyle], pitchT: [0.09, 0.03, 0.06, 0.02][kit.kickStyle],
              decay: (0.2 + 0.55 * kit.kickDecay) * [1, 0.5, 1.4, 0.65][kit.kickStyle] * (P.kDecay ?? 1),
              sub: kit.kickSub * (P.kSub ?? 1), click: 0.5 * (P.kPunch ?? 1), punch: P.kPunch ?? 1,
              nDecay: 0.004, pan: 0 });
          } else if (ev.type === 'snare') {
            events.push({ t, kind: 'snare', bus: 'drums', vel: vel * P.drums,
              f: mtof(root + kit.snareBody), pitchT: 0.03,
              decay: 0.05 + 0.1 * (P.sSnap ?? 1), nDecay: (0.05 + 0.17 * (P.sSnap ?? 1)) * tone[1],
              body: P.sBody ?? 1, noise: 1, snap: P.sSnap ?? 1, bpF: (1200 + 1000 * (P.sTone ?? 1)) * tone[0], pan: 0 });
          } else if (ev.type === 'hat') {
            events.push({ t, kind: 'hat', bus: 'drums', vel: vel * P.drums * 0.9,
              decay: (ev.open ? 0.18 : 0.035) * kit.hatDecay * (P.hDecay ?? 1),
              hp: (6500 + 2500 * (P.hTone ?? 1)) * tone[0], bp2: 9000 + 3000 * (P.hTone ?? 1),
              lvl: tone[2], pan: ev.pan || 0 });
          } else {
            events.push({ t, kind: 'hat', bus: ev.type === 'crash' ? 'bell' : 'drums',
              vel: vel * P.drums * (ev.type === 'crash' ? 0.9 : 0.7),
              decay: ev.type === 'crash' ? kit.crashLen : 0.03,
              hp: ev.type === 'crash' ? 3600 : 5200, bp2: 9000, lvl: 1, pan: ev.pan || 0 });
          }
          break;
        }
      }
    }

    events.sort((a, b) => a.t - b.t);
    return {
      sr: app.engine.ctx.sampleRate, spb, total: song.total, loop: true,
      room: 0.6, damp: 0.5, sections, events, tables: tablesFor(sigil, sections),
    };
  }

  /* ── Worklet lifecycle ───────────────────────────────────────────────── */

  async function ensure(ctx) {
    if (node && node.context === ctx) return node;
    if (!coreSrc) coreSrc = await fetch(CORE_URL).then((r) => r.text());
    await ctx.audioWorklet.addModule(WORKLET_URL);
    node = new AudioWorkletNode(ctx, 'sigil-voice', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e) => {
      if (e.data.ready) { ready = true; status('core loaded'); }
      if (e.data.error) { console.error('[dsp]', e.data.error); status('error, see console'); }
    };
    node.port.postMessage({ cmd: 'init', src: coreSrc });
    node.connect(app.engine.tone);
    return node;
  }

  function status(t) { if (statusEl) statusEl.textContent = t; }

  /** Build the plan and hand it over. Also silences the node scheduler. */
  async function engage() {
    if (!S.on || !app.engine || !app.song || building) return;
    building = true;
    try {
      await ensure(app.engine.ctx);
      status('building plan…');
      const plan = buildPlan();
      if (!plan) return;
      planKey = `${app.sigil.hex}:${Sound.state().variant}:${JSON.stringify(Sound.state().o)}`;
      node.port.postMessage({ cmd: 'plan', plan });
      node.port.postMessage({ cmd: 'levels', levels: levelMap() });
      node.port.postMessage({ cmd: 'duck', depth: 0.5 });
      // The node engine keeps the buses (for the ritual sounds) but stops scheduling.
      app.engine.running = false;
      clearInterval(app.engine.timer);
      const beat = app.engine.beatNow();
      node.port.postMessage({ cmd: 'play', beat });
      status(`playing · ${plan.events.length} events · ${Object.keys(plan.tables).length} tables`);
    } catch (e) {
      console.error('[dsp]', e);
      status('failed: ' + e.message);
    } finally {
      building = false;
    }
  }

  function disengage() {
    if (node) node.port.postMessage({ cmd: 'stop' });
    if (app.engine && app.mode === 'playing') {
      // Hand the score back to the node scheduler.
      app.engine.running = true;
      clearInterval(app.engine.timer);
      app.engine.timer = setInterval(() => app.engine.pump(), 16);
      app.engine.seek(app.engine.beatNow());
    }
    status('nodes');
  }

  const levelMap = () => {
    const m = {};
    if (typeof Mixer !== 'undefined') {
      const st = Mixer.state;
      const anySolo = Object.values(st.solo || {}).some(Boolean);
      for (const k of ['lead', 'harm', 'bell', 'pad', 'bass', 'arp', 'drums', 'drone']) {
        m[k] = (st.level[k] ?? 1) * (st.mute[k] ? 0 : 1) * (anySolo && !st.solo[k] ? 0 : 1);
      }
    }
    return m;
  };

  /* ── Keep the core in step with the page ─────────────────────────────── */

  Hooks.on('song', () => { if (S.on) setTimeout(engage, 60); });
  Hooks.on('stop', () => { if (node) node.port.postMessage({ cmd: 'stop' }); });

  const origSeek = Engine.prototype.seek;
  Engine.prototype.seek = function (beat) {
    origSeek.call(this, beat);
    if (S.on && node && ready) node.port.postMessage({ cmd: 'seek', beat });
  };

  // Patch, tempo, lens and mixer changes are picked up by a cheap poll, so no
  // other module has to know this engine exists.
  let lastSig = '';
  setInterval(() => {
    if (!S.on || !ready || !node || app.mode !== 'playing') return;
    const st = Sound.state();
    const sig = `${st.variant}|${JSON.stringify(st.o)}|${app.engine.spb}|${typeof LiveLens !== 'undefined' && LiveLens.active() ? LiveLens.shift : 0}`;
    if (sig !== lastSig) { lastSig = sig; engage(); }
    node.port.postMessage({ cmd: 'levels', levels: levelMap() });
  }, 400);

  /* ── Panel ───────────────────────────────────────────────────────────── */

  UI.section({ id: 'dsp', title: 'Engine (DSP preview)', order: 11, build(el) {
    statusEl = UI.note(S.on ? 'waiting for a sigil' : 'nodes');
    toggleEl = UI.check({
      label: 'Run the DSP engine (scheduler on the audio thread)', checked: S.on,
      onChange: (v) => {
        S.on = v; Prefs.set('dsp.on', v);
        if (v) engage(); else disengage();
      },
    });
    el.append(
      UI.note('The DSP engine moves the scheduler and every voice onto the audio thread, where nothing the interface does can interrupt them. This is the cure for stalls. It is a preview: MIDI, stems and offline rendering still use the node engine, so switch back to Nodes for those.'),
      toggleEl, statusEl,
      h('div', { class: 'sgrow' }, UI.button('Rebuild plan', engage)));
  } });

  return { engage, disengage, buildPlan, get on() { return S.on; } };
})();

if (typeof window !== 'undefined') window.DspEngine = DspEngine;