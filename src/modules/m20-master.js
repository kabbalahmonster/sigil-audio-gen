'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   m20 · MASTER — the rite is listened to, then finished
   --------------------------------------------------------------------------
   WHERE THINGS LIVE
     what a plan is    src/core/05e-master.js   listen → solve: trims, caps, rides, tone, gain (pure)
     the chain         src/dsp/sigil-dsp.js     §5d: the core lays the plan on, the same on the
                                                stage and in a render; the Probe that listens
     THIS FILE         does the listening off the main thread, keeps what was heard, hands
                       the engine its plan, and shows what the plan does. Nothing here makes
                       a sound, and nothing here decides anything: 05e does.

   HOW A PLAN REACHES THE ENGINE
     'compiled' (06b) says the engine was sent something that changes what will be heard.
       a new song     a plan is laid on at once: the one already worked out for this very
                      job if there is one, otherwise a provisional one (the chain as the
                      letters ask for it, the crushers held back), and the listening starts.
                      On an ordinary machine the reduction ceremony outlasts the listening
                      and the finished plan is in place before the first note. On a slow
                      one the plan from the first pass (everything but the last gain) is,
                      and the finished one is glided to a few bars in.
       a knob, a lens  listened to again once the hand has been still for a moment; the
                      plan in force stays until the new one is ready, then is glided to.
     The listening is two passes of the song at 32 kHz in workers (Mastering.ranges cuts it
     into lanes), never on the main thread. What was heard is kept (by a key over the
     compiled job), so going back to a sound already heard costs nothing.
     The core reports a fingerprint of the plan it holds with every tick; it is checked
     against the plan that was sent (agree), so "the stage is finished by this plan" is
     something this file knows, not something it assumes.

   A RENDER IS FINISHED BY THE SAME PLAN. m7 asks prepare(job): if the job is the one on
   the stage its plan is already here; if not (another tempo, the lens off, an evolved
   pass) it is listened to first. Stems are given the plan's trims and caps and leave
   before the chain, so that laid side by side they are the mix that entered it.

   THE LISTENER'S SETTINGS (Prefs 'master': they are this listener's, like the drummer's
   amounts): on · loudness · balance · noise · dynamics. THE FINISH (which deal of the
   chain's character, and how strongly) is in the patch: it is the sigil's, is saved
   with it and travels in a shared link.
   ══════════════════════════════════════════════════════════════════════════ */

const Master = (() => {
  'use strict';
  const { h } = UI;
  const M = Mastering, hasSound = typeof Sound !== 'undefined';
  const WORKER = 'src/dsp/sigil-render.worker.js';

  const S = { ...M.DEFAULTS, ...Prefs.get('master', {}) };
  const save = () => Prefs.set('master', S);
  const opts = () => M.options(S);

  const live = () => {
    const e = app.engine;
    return e && e.isDSP && e.buses && app.song && e.song === app.song ? e : null;
  };
  const reduced = () => typeof Access !== 'undefined' && Access.reduced && Access.reduced();
  const lensOn = () => typeof LiveLens !== 'undefined' && LiveLens.active();

  /* ── What has been heard (kept by key; the newest few) ───────────────── */

  const keep = (map, max) => ({
    get(k) { const v = map.get(k); if (v !== undefined) { map.delete(k); map.set(k, v); } return v; },
    set(k, v) { map.delete(k); map.set(k, v); while (map.size > max) map.delete(map.keys().next().value); },
    clear() { map.clear(); },
  });
  const heardA = keep(new Map(), 8), heardB = keep(new Map(), 16), flying = new Map();

  /* ── Listening: one probe range per worker ───────────────────────────── */

  /** Workers to listen with. While the rite is sounding, a core is left for the audio thread and one for the page. */
  const lanes = () => {
    const cores = navigator.hardwareConcurrency || 2, e = app.engine;
    return clamp(cores - (e && e.running ? 2 : 1), 1, 4);
  };

  /**
   * Hear `job` through (mode 1: the parts, 2: the finished mix) in workers, one range each.
   * Returns { promise, cancel }. `onProgress(0…1)` follows it.
   */
  function listen(job, mode, onProgress) {
    const rs = M.ranges(M.heardOf(job), lanes()), workers = [], frac = rs.map(() => 0);
    const weight = rs.reduce((s, r) => s + (r.to - r.from), 0);
    const report = () => onProgress(rs.reduce((s, r, i) => s + frac[i] * (r.to - r.from), 0) / weight);
    let stop = null;
    const all = Promise.all(rs.map((r, i) => new Promise((resolve, reject) => {
      const w = new Worker(WORKER);
      workers.push(w);
      w.onerror = (e) => reject(new Error(e.message || 'the listening worker failed to load'));
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'progress') { frac[i] = d.f; report(); }
        else if (d.type === 'heard') { frac[i] = 1; report(); resolve(d.r); }
        else if (d.type === 'error') reject(new Error(d.msg));
      };
      w.postMessage({ type: 'probe', job, from: r.from, to: r.to, keep: r.keep, mode });
    })));
    const stopped = new Promise((_, reject) => { stop = () => reject(new Error('cancelled')); });
    const done = () => workers.forEach((w) => w.terminate());
    const promise = Promise.race([all, stopped]).then((parts) => M.join(parts));
    promise.then(done, done);
    return { promise, cancel: () => { done(); stop(); } };
  }

  /**
   * One listening per thing to hear, however many ask for it: the stage and a render of the same
   * song share it, and so does a stage that has only changed its settings. `ctl.cancel()` is the
   * asker leaving; the listening itself stops when the last asker has left.
   */
  function hear(key, job, mode, ctl) {
    let L = flying.get(key);
    if (!L) {
      const subs = new Set();
      L = Object.assign(listen(job, mode, (f) => subs.forEach((fn) => fn(f))), { subs, users: 0 });
      flying.set(key, L);
      const gone = () => { if (flying.get(key) === L) flying.delete(key); };
      L.promise.then(gone, gone);
    }
    const fn = ctl.onProgress;
    if (fn) L.subs.add(fn);
    L.users++;
    let left = false;
    ctl.cancel = () => {
      if (left) return;
      left = true;
      if (fn) L.subs.delete(fn);
      if (--L.users <= 0) { if (flying.get(key) === L) flying.delete(key); L.cancel(); }
    };
    return L.promise;
  }

  /**
   * The plan for a job. Listens only to what has not been heard: pass A by the job's key, pass B
   * by that and by what pass A's plan would change. `ctl.onInterim(plan)` is given pass A's plan
   * (its last gain still a guess) while pass B is being heard; `ctl.cancel()` leaves.
   */
  async function planFor(job, levels, o, ctl = {}) {
    const key = M.keyOf(job, levels), ref = M.probeJob(job, levels);
    ctl.key = key;
    let A = heardA.get(key);
    if (!A) {
      ctl.phase = 'parts';
      A = await hear(key, M.probeJob(job, levels, M.neutral(job.nSec)), 1, ctl);
      heardA.set(key, A);
    }
    // Pass B, and once more if the make-up it finds is far from the one it was heard at (a loud target:
    // the limiter must be heard working as hard as it will).
    let at = M.interim(M.solveA(A, ref, o)), plan = null;
    for (let turn = 0; turn < 2; turn++) {
      const kb = `${key}:${M.keyOfPlan(at)}`;
      let B = heardB.get(kb);
      if (!B) {
        if (ctl.onInterim) ctl.onInterim(at);
        ctl.phase = 'mix';
        B = await hear(kb, M.probeJob(job, levels, M.table(at)), 2, ctl);
        heardB.set(kb, B);
      }
      plan = M.solveB(B, at);
      if (M.settled(plan, at)) break;
      at = Object.assign({}, plan, { final: false });
    }
    ctl.cancel = null;
    return plan;
  }

  /* ── The stage ───────────────────────────────────────────────────────── */

  const st = { gen: 0, ctl: null, plan: null, sig: '', state: 'idle', frac: 0, err: '', timer: 0, who: '', last: null };

  /** The job the stage is playing, as a render would see it (one pass, reference levels, the live lens and tempo). */
  function stageJob(eng) {
    return SigilPlan.renderJob(app.song, app.sigil, { sr: M.RATE, spb: eng.spb, passes: 1, lens: lensOn(),
      levels: M.referenceLevels(app.song) });
  }

  function setState(state, frac = 0, err = '') { st.state = state; st.frac = frac; st.err = err; paintStatus(); }

  /**
   * Bring the engine's plan in line with what it is playing and with the settings.
   * kind: 'song' (a new song: lay a plan on now, listen at once) · anything else (listen when
   * the hand has been still) · 'now' (a setting of this panel: no wait).
   * Every plan is glided to (about a third of a second), never jumped to.
   */
  function sync(kind) {
    const eng = live();
    clearTimeout(st.timer);
    if (!eng) { cancel(); st.plan = null; st.sig = ''; setState('idle'); paintDone(); return; }
    if (!S.on) {
      cancel();
      if (eng.master || kind === 'song') eng.setMaster(null);
      st.plan = null; st.sig = ''; resetMeters(); setState('off'); paintDone(); paintMeters();
      return;
    }
    if (kind === 'song') {
      // Something must be in force from the first sample. If this very song has been heard, run() finds its plan at once.
      // (Glided to, like every plan: the ceremony's chimes, or the last rite's tail, may be sounding through it.)
      const job = stageJob(eng), who = app.sigil.fusionKey || app.sigil.reduced;
      eng.setMaster(M.provisional(job, opts(), st.who === who ? st.last : null));
      st.plan = null; st.sig = ''; st.who = who;
      run(job);
      return;
    }
    st.timer = setTimeout(() => run(), kind === 'now' ? 60 : kind === 'plan' ? 500 : 900);
  }

  function cancel() {
    st.gen++;
    if (st.ctl && st.ctl.cancel) st.ctl.cancel();
    st.ctl = null;
  }

  /** What a run is for: the compiled job, how it asks to be finished, and the listener's settings. */
  const sigOf = (job) => `${M.keyOf(job, job.levels)}|${JSON.stringify([job.mix, opts()])}`;

  async function run(job) {
    const eng = live();
    if (!eng || !S.on) return;
    job = job || stageJob(eng);
    const sig = sigOf(job);
    // Already listening for exactly this, or already holding its finished plan: there is nothing to do.
    // (Every cast re-plans once as the rite starts; that must not start the listening over.)
    if (sig === st.sig && (st.ctl || (st.plan && st.plan.final && eng.master === st.plan))) return;
    const gen = ++st.gen, song = app.song, old = st.ctl;
    const ctl = (st.ctl = {
      phase: '',
      onProgress: (f) => { if (gen === st.gen) setState('listening', ctl.phase === 'mix' ? 0.5 + f * 0.5 : f * 0.5); },
      onInterim: (p) => { if (gen === st.gen && live() === eng && app.song === song) { eng.setMaster(p); st.plan = p; paintDone(); } },
    });
    st.sig = sig;
    setState('listening', 0);
    // Join before the run this one replaces leaves: if both want the same listening, it carries on.
    const wanted = planFor(job, job.levels, opts(), ctl);
    if (old && old.cancel) old.cancel();
    try {
      const plan = await wanted;
      if (gen !== st.gen || live() !== eng || app.song !== song) return;
      eng.setMaster(plan);
      st.plan = st.last = plan; st.ctl = null;
      setState('heard');
      paintDone();
    } catch (e) {
      if (gen !== st.gen) return;
      st.ctl = null; st.sig = '';
      if (e && e.message === 'cancelled') return;
      console.error('[master]', e);
      setState('failed', 0, String((e && e.message) || e));
    }
  }

  /**
   * The plan's table for a render job (m7, m14), listening first if this job has not been heard.
   * Resolves null when the master is off: the job then leaves as the engine always left it.
   * o: { stem (parts of one mix: trims and caps, no chain), onProgress(0…1) }
   */
  async function prepare(job, song, o = {}) {
    if (!S.on) return null;
    const ctl = { phase: '', onProgress: (f) => { if (o.onProgress) o.onProgress(ctl.phase === 'mix' ? 0.5 + f * 0.5 : f * 0.5); } };
    const plan = await planFor(job, M.referenceLevels(song), opts(), ctl);
    return { table: M.table(plan, !!o.stem), plan };
  }

  /* ── Meters: what leaves the chain, as a loudness meter would show it ── */

  const HOP = 0.1;
  const mt = { e: 0, n: 0, hops: [], sr: 48000, tp: 0, lim: 0, glue: 0, band: 0, ceil: 0, at: 0, whole: -Infinity, wholeAt: 0 };
  const resetMeters = () => { mt.e = 0; mt.n = 0; mt.hops.length = 0; mt.tp = 0; mt.lim = 0; mt.glue = 0; mt.band = 0; mt.whole = -Infinity; mt.wholeAt = 0; };
  const db = (x) => 20 * Math.log10(x + 1e-30);

  /**
   * Every tick the core says which plan it holds (a fingerprint). It must be the one the page sent:
   * if it is not, for longer than a message takes to arrive, the stage is not being finished the way
   * this panel says, and a render would not match it. That is said, loudly, rather than assumed away.
   */
  let astray = 0;
  function agree(d) {
    const eng = app.engine;
    if (!eng || !eng.master || !d.master || d.master.sig === eng.masterSig) { if (astray >= 75) paintStatus(); astray = 0; return; }
    if (++astray === 75) {                                        // three seconds of ticks
      console.error('[master] the engine is not holding the plan it was sent (an old worklet may be cached: hard-reload).');
      paintStatus();
    }
  }

  function onTick(d) {
    const m = d.master;
    agree(d);
    if (!m) return;
    mt.e += m.k; mt.n += m.n;
    const per = Math.round(mt.sr * HOP);
    if (mt.n >= per) {                                            // the core's blocks do not land on tenths: scale the hop to one
      mt.hops.push((mt.e * per) / mt.n);
      if (mt.hops.length > 12000) mt.hops.splice(0, 2000);
      mt.e = 0; mt.n = 0;
    }
    // held a moment, so a peak can be read
    mt.tp = Math.max(m.tp, mt.tp * 0.93);
    mt.lim = Math.max(-db(m.lim), mt.lim * 0.9); mt.glue = Math.max(-db(m.glue), mt.glue * 0.9);
    mt.band = Math.max(-db(Math.min(m.lo, m.mid, m.hi)), mt.band * 0.9);
    mt.ceil = m.ceil;
    const now = performance.now();
    if (now - mt.at > (reduced() ? 500 : 66)) { mt.at = now; paintMeters(); }
  }
  const watched = new WeakSet();
  Hooks.on('buses', (_b, e) => {
    if (!e.isDSP || watched.has(e)) return;
    watched.add(e);
    mt.sr = e.ctx.sampleRate;
    e.onTick(onTick);
  });

  /* ── Panel ───────────────────────────────────────────────────────────── */

  let det = null, statusEl = null, bars = null, doneEl = null, finLbl = null, finInfo = null, secTable = null;
  let onBox = null, targetRow = null, levelRow = null, noiseRow = null, dynRow = null, amtRow = null, prevBtn = null, nextBtn = null;

  const panelOpen = () => {
    const dr = document.getElementById('drawer');
    return !!(det && det.open && dr && dr.classList.contains('open'));
  };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const sdb = (x, d = 1) => (Number.isFinite(x) ? `${x > 0.049 ? '+' : x < -0.049 ? '−' : ''}${Math.abs(x).toFixed(d)}` : '—');
  const lu = (x) => (Number.isFinite(x) ? x.toFixed(1).replace('-', '−') : '—');
  const LABEL = { lead: 'Lead', harm: 'Choir', bell: 'Bells', pad: 'Pad', bass: 'Bass', arp: 'Arpeggio', drums: 'Kit', drone: 'Drone' };

  function paintStatus() {
    if (!statusEl) return;
    const p = st.plan, r = p && p.report;
    statusEl.textContent =
      astray >= 75 ? 'The engine is not holding the plan shown here. Reload the page.'
      : st.state === 'idle' ? 'Cast a sigil: it is listened to, then finished.'
      : st.state === 'off' ? 'The master is off: the mix leaves as the engine made it.'
      : st.state === 'failed' ? `The listening failed (${st.err}). The provisional finish stays in force.`
      : st.state === 'listening' ? `listening… ${Math.round(st.frac * 100)}%${p ? ' · a first finish is in force' : ''}`
      : r ? `heard · set ${sdb(r.gainIn + r.gainOut)} dB to land at ${lu(r.lufs)} LUFS, under ${lu(p.opts.ceiling)} dBTP`
      : 'heard';
  }

  function paintMeters() {
    if (!bars || !panelOpen()) return;
    const H = mt.hops, per = Math.round(mt.sr * HOP), n = H.length, eng = live();
    const on = !!(eng && eng.master && n);
    const short = on ? M.loudest(H.slice(Math.max(0, n - 30)), per, HOP).short : -Infinity;
    if (on && n >= 8 && (n - mt.wholeAt >= 5 || n < mt.wholeAt)) { mt.whole = M.lufs(H, per); mt.wholeAt = n; }   // twice a second is plenty
    const whole = on && n >= 8 ? mt.whole : -Infinity;
    const target = opts().target;
    const f = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);
    bars.lufs.i.style.transform = `scaleX(${f(short, target - 24, target + 6)})`;
    bars.lufs.b.style.left = `${f(target, target - 24, target + 6) * 100}%`;
    const quiet = (x) => (x > -70 ? lu(x) : '—');                 // nothing is sounding: say nothing, not −300
    bars.lufs.v.textContent = on ? `${quiet(short)} · ${quiet(whole)} LUFS` : '—';
    const tp = db(mt.tp), ceil = db(mt.ceil || 0.891);
    bars.peak.i.style.transform = `scaleX(${f(on ? tp : -99, -24, 0)})`;
    bars.peak.b.style.left = `${f(ceil, -24, 0) * 100}%`;
    bars.peak.v.textContent = on ? `${lu(Math.min(tp, 20))} dB → ${lu(ceil)}` : '—';
    bars.held.i.style.transform = `scaleX(${f(on ? mt.glue + mt.band + mt.lim : 0, 0, 9)})`;
    bars.held.v.textContent = on ? `${(mt.glue + mt.band).toFixed(1)} + ${mt.lim.toFixed(1)} dB` : '—';
  }

  /** What the plan in force does, part by part and section by section. Rebuilt when the plan changes, not per frame. */
  function paintDone() {
    paintStatus();
    if (!doneEl) return;
    doneEl.innerHTML = '';
    const p = st.plan, r = p && p.report, song = app.song;
    secTable = null;
    if (!p || !r || !r.parts || p.provisional || !song) return;
    const strong = (t) => h('b', {}, t);
    const parts = h('div', { class: 'ms-parts', role: 'list', 'aria-label': 'How far each part was moved, in decibels' },
      r.parts.map((q) => {
        const x = clamp(q.trim / 6, -1, 1), bar = h('i', { style: `left:${x < 0 ? 50 + x * 50 : 50}%;width:${Math.abs(x) * 50}%` });
        return h('div', { class: 'ms-part' + (q.heard ? '' : ' ms-mute'), role: 'listitem',
          title: q.heard ? `${LABEL[q.name]}: ${lu(q.lufs)} LUFS as composed, moved ${sdb(q.trim)} dB` : `${LABEL[q.name]} is not heard in this rite` },
          h('span', {}, LABEL[q.name]), h('span', { class: 'ms-track', 'aria-hidden': 'true' }, bar),
          h('span', { class: 'ms-num' }, q.heard ? `${sdb(q.trim)} dB` : '—'));
      }));
    const n = Math.min(p.nSec, song.sections.length), secs = song.sections.slice(0, n);
    const grain = r.noise.map((z) => (Number.isFinite(z.music) ? (z.musicCap >= 0.995 ? 'all' : pct(z.musicCap)) : '·'));
    const anyGrain = r.noise.some((z) => Number.isFinite(z.music));
    const table = (secTable = h('table', { class: 'ms-secs' },
      h('tr', {}, h('th', {}, ''), secs.map((s) => h('th', { title: s.name, scope: 'col' }, s.roman))),
      h('tr', { title: 'The gain each section is given on its way in: the quiet ones are set further under the loud' },
        h('th', { scope: 'row' }, 'ride'), r.rides.slice(0, n).map((x) => h('td', {}, x ? sdb(x) : '0'))),
      anyGrain ? h('tr', { title: 'How much of the crusher’s grain each section keeps (its drive and fold are untouched)' },
        h('th', { scope: 'row' }, 'grain'), grain.slice(0, n).map((x) => h('td', {}, x))) : null));
    markSection(renderer.info ? renderer.info.si : -1);
    const eq = r.eq.map((x) => sdb(x));
    doneEl.append(
      h('div', { class: 'ms-h' }, 'the parts'), parts,
      h('div', { class: 'ms-h' }, 'the sections'), table,
      h('p', { class: 'tool-note ms-line' }, 'tone  ', strong(eq[0]), ' low · ', strong(eq[1]), ' low-mid · ', strong(eq[2]), ' presence · ', strong(eq[3]), ' air (dB)'),
      p.final ? h('p', { class: 'tool-note ms-line' }, 'the loudest peak asks ', strong(`${Math.max(0, r.peak - p.opts.ceiling).toFixed(1)} dB`),
        ' of the clip and limiter · range ', strong(`${r.range.toFixed(1)} LU`)) : null);
  }

  /** Show which section's numbers are in force (the column of the section now sounding). */
  function markSection(si) {
    if (!secTable) return;
    for (const row of secTable.rows) for (let c = 1; c < row.cells.length; c++) row.cells[c].classList.toggle('ms-now', c - 1 === si && !!live());
  }

  const setField = (name, v, rest) => {
    if (!hasSound || !app.sigil) return;
    if (v === rest) Sound.unset(name); else Sound.set(name, v);
  };
  const patch = () => (hasSound ? Sound.state().P : null);
  function step(d) {
    const P = patch();
    if (!P || !app.sigil) return;
    const n = mod((P.finish | 0) + d, 100);
    setField('finish', n, 0);
    UI.announce(`Finish ${n}: ${M.describe(M.character(app.sigil, n))}.`);
  }
  const setting = (k, v) => { S[k] = v; save(); sync('now'); };
  const noiseText = (v) => (v >= 1 ? 'as composed' : v <= -1 ? 'cleanest' : Math.abs(v) < 0.005 ? 'house' : `${sdb(v * M.NOISE.span, 0)} dB`);

  function refresh() {
    if (!onBox) return;
    const P = patch(), on = !!app.sigil;
    onBox.input.checked = S.on;
    targetRow.input.value = String(S.target);
    levelRow.set(S.level); noiseRow.set(S.noise); dynRow.set(S.dynamics);
    amtRow.set(P ? P.fAmt ?? 1 : 1);
    amtRow.input.disabled = prevBtn.disabled = nextBtn.disabled = !on || !P;
    const ch = on ? M.character(app.sigil, P ? P.finish | 0 : 0) : null;
    finLbl.textContent = ch ? M.describe(ch) : 'cast to finish';
    finInfo.textContent = ch ? `finish ${ch.variant}${ch.variant ? '' : ' · the sigil’s own'}` : '';
  }

  UI.section({ id: 'master', title: 'Master', order: 26, build(el, d) {
    det = d;
    UI.css(`.ms-status{text-align:center;font-style:italic;opacity:.7;font-size:12.5px;margin:2px 0 8px;min-height:1.3em}
      .ms-meters{display:grid;grid-template-columns:auto 1fr auto;gap:7px 9px;align-items:center;margin:6px 0 12px;font-size:12px}
      .ms-meters>span:first-child,.ms-meters>span:nth-child(3n+1){opacity:.6;letter-spacing:.04em}
      .ms-bar{position:relative;height:5px;background:rgba(var(--line),.1);border-radius:3px}
      .ms-bar i{position:absolute;inset:0;transform-origin:left center;transform:scaleX(0);background:rgb(var(--accent));border-radius:3px;will-change:transform}
      .ms-bar b{position:absolute;top:-3px;bottom:-3px;width:1px;background:rgba(var(--line),.55)}
      .ms-val{font-variant-numeric:tabular-nums;opacity:.75;white-space:nowrap;min-width:9.5em;text-align:right}
      .ms-fin{align-items:center}.ms-lbl{flex:1;min-width:6em;text-align:center;font-style:italic;opacity:.8;font-size:13px}
      .ms-info{text-align:center;margin-top:-2px}
      .ms-h{font-size:10px;letter-spacing:.16em;text-transform:uppercase;opacity:.45;margin:12px 0 5px}
      .ms-part{display:grid;grid-template-columns:62px 1fr 58px;gap:8px;align-items:center;font-size:12.5px;padding:2px 0}
      .ms-track{position:relative;height:9px}
      .ms-track::before{content:'';position:absolute;left:0;right:0;top:4px;height:1px;background:rgba(var(--line),.16)}
      .ms-track::after{content:'';position:absolute;left:50%;top:1px;bottom:1px;width:1px;background:rgba(var(--line),.4)}
      .ms-track i{position:absolute;top:3px;height:3px;background:rgb(var(--accent));border-radius:2px}
      .ms-num{font-variant-numeric:tabular-nums;text-align:right;opacity:.75}.ms-mute{opacity:.35}
      .ms-secs{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;text-align:center}
      .ms-secs th{font-weight:normal;opacity:.5;padding:2px 0}.ms-secs th[scope=row]{text-align:left;font-style:italic}
      .ms-secs td{padding:2px 0;opacity:.8}.ms-secs .ms-now{color:rgb(var(--accent));opacity:1}
      .ms-line{margin:8px 0 0}.ms-line b{font-weight:normal;color:rgb(var(--accent))}`);

    statusEl = h('div', { class: 'ms-status', role: 'status', 'aria-live': 'off' });
    const bar = (tick) => {
      const i = h('i'), b = tick ? h('b') : null, v = h('span', { class: 'ms-val' }, '—');
      return { i, b, v, el: h('div', { class: 'ms-bar', 'aria-hidden': 'true' }, i, b) };
    };
    bars = { lufs: bar(true), peak: bar(true), held: bar(false) };
    const meters = h('div', { class: 'ms-meters' },
      h('span', { title: 'Loudness leaving the chain: the last three seconds, then the rite so far. The mark is the loudness asked for' }, 'loudness'), bars.lufs.el, bars.lufs.v,
      h('span', { title: 'The highest true peak reaching the limiter, and the ceiling it is held under' }, 'peak'), bars.peak.el, bars.peak.v,
      h('span', { title: 'Gain taken back just now: by the compressors, then by the limiter' }, 'held'), bars.held.el, bars.held.v);

    onBox = UI.check({ label: 'Master the output', checked: S.on,
      title: 'Off, the mix leaves as the engine always left it: no trims, no caps, no chain. For comparing',
      onChange: (v) => { S.on = v; save(); sync('now'); UI.announce(v ? 'Master on.' : 'Master off.'); } });
    targetRow = UI.select({ label: 'Loudness', value: S.target,
      options: M.TARGETS.map(([v, name]) => [String(v), `${name} · ${String(v).replace('-', '−')} LUFS`]),
      title: 'Where the finished rite lands. Streaming services play everything at about −14; louder costs dynamics',
      onChange: (v) => setting('target', +v) });
    levelRow = UI.slider({ label: 'Balance', min: 0, max: 1, step: 0.01, value: S.level, format: pct,
      title: 'How far each part is drawn toward the house balance. At zero the parts stay exactly where the sigil put them',
      onInput: (v) => setting('level', v) });
    noiseRow = UI.slider({ label: 'Noise', min: -1, max: 1, step: 0.01, value: S.noise, format: noiseText,
      title: 'How much of the crusher’s grain is let through: left is cleaner, right is rawer, all the way right is exactly as composed',
      onInput: (v) => setting('noise', v) });
    dynRow = UI.slider({ label: 'Dynamics', min: 0, max: 1, step: 0.01, value: S.dynamics, format: pct,
      title: 'How far the quiet sections are set under the loud ones. At zero every section is left at the level the chain gives it',
      onInput: (v) => setting('dynamics', v) });

    finLbl = h('output', { class: 'ms-lbl', 'aria-live': 'off' });
    finInfo = UI.note(''); finInfo.classList.add('ms-info');
    prevBtn = UI.button('◀ finish', () => step(-1), { title: 'Another finish for this sigil', 'aria-label': 'Previous finish' });
    nextBtn = UI.button('finish ▶', () => step(1), { title: 'Another finish for this sigil', 'aria-label': 'Next finish' });
    amtRow = UI.slider({ label: 'Character', min: 0, max: 1.5, step: 0.01, value: 1, format: pct,
      title: 'How strongly the finish colours the chain. At zero the chain is the house’s own, the same for every sigil',
      onInput: (v) => setField('fAmt', v, 1) });
    doneEl = h('div', { class: 'ms-done' });

    el.append(
      UI.note('The rite is listened to before it is played, and finished to what was heard. Each part is drawn toward the house balance; the crusher’s grain is held under the music; the tone is nudged toward clear; the whole is set to the loudness asked for, under a true-peak ceiling. The letters choose the finish: fricatives ask for air, nasals for weight, liquids for warmth, plosives for punch. A render leaves through the same chain, by the same plan.'),
      statusEl, meters, onBox, targetRow, levelRow, noiseRow, dynRow,
      h('div', { class: 'sgrow ms-fin' }, prevBtn, finLbl, nextBtn), finInfo, amtRow, doneEl);
    refresh(); paintStatus(); paintDone();
  } });

  /* ── Keeping in step ─────────────────────────────────────────────────── */

  Hooks.on('compiled', (eng, kind) => { if (eng === app.engine && eng.song === app.song) sync(kind); });
  Hooks.on('song', () => { resetMeters(); refresh(); paintDone(); });
  Hooks.on('section', (_sec, si) => markSection(si));
  // The rite has stopped and nothing has been loaded in its place: the panel says so, and any listening is called off.
  const rest = () => { if (live()) return; cancel(); clearTimeout(st.timer); st.plan = null; st.sig = ''; resetMeters(); setState('idle'); paintDone(); refresh(); paintMeters(); };
  Hooks.on('stop', () => setTimeout(rest, 0));
  // A banished sigil is forgotten here too: what was heard of it (measurements only, never sound) is let go.
  Hooks.on('forget', () => setTimeout(() => { heardA.clear(); heardB.clear(); st.who = ''; st.last = null; rest(); }, 7200));
  if (hasSound) Sound.subscribe(refresh);
  UI.whenReady(refresh);

  return { prepare, planFor, sync, step, settings: S, state: () => st, meters: () => mt };
})();

if (typeof window !== 'undefined') window.Master = Master;
