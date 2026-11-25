import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { join } from 'node:path';
import { scoreSandbox, bootCore, realm, WORDS } from '../tools/voice-lab.mjs';

const QUICK = process.argv.includes('--quick');
let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
};
const group = (name, fn) => {
  console.log(`\n${name}`);
  try { fn(); } catch (e) { ok(false, `${name}: threw`, String((e && e.stack) || e)); }
};

const run = scoreSandbox(['src/modules/m9-lens.js'].filter(() => false));
const J = (code) => JSON.parse(run(`JSON.stringify(${code})`));
const D = bootCore();

group('§1 · 4-channel retro composition & lossless switching', () => {
  const res = J(`(() => {
    const out = [];
    for (const w of ${JSON.stringify(WORDS)}) {
      const sg = buildSigil(w);
      const song = Groove.apply(composeSong(sg), sg, {});
      const cubeSnap = song.events.map((e) => [e.beat, e.type, e.midi || 0, +(e.vel || 0).toFixed(4)]).join(';');
      const cubeKicks = song.kicks.slice(), cubeSnares = song.snares.slice();

      Arcade.apply(song, sg, { eng: 1 });
      const types = [...new Set(song.events.map((e) => e.type))];
      const hasCubeOnly = types.some((t) => ['pad', 'drone', 'harm', 'bell', 'comp', 'swell'].includes(t));

      const spec = SigilPlan.defaultSpec(sg, song);
      spec.P = { ...spec.P, eng: 1, iLead: 10, iBass: 16, iPad: 79, iArp: 30, iPerc: 51 };
      const compiled = SigilPlan.compile(song, sg, { spec });
      const S = SigilDSP.STRIDE, kinds = new Set(), buses = new Set();
      let sorted = true, finite = true;
      for (let i = 0; i < compiled.count; i++) {
        const o = i * S;
        if (i && compiled.events[o] < compiled.events[o - S]) sorted = false;
        for (let j = 0; j < S; j++) if (!Number.isFinite(compiled.events[o + j])) finite = false;
        kinds.add(compiled.events[o + 1] & 255);
        buses.add(compiled.events[o + 2]);
      }

      Arcade.restore(song);
      const restoredSnap = song.events.map((e) => [e.beat, e.type, e.midi || 0, +(e.vel || 0).toFixed(4)]).join(';');

      out.push({
        w,
        hasCubeOnly,
        sorted,
        finite,
        noPaletteTable: compiled.inst === null && compiled.pal === null,
        noMotionTable: compiled.auto === null,
        kinds: [...kinds].sort((a, b) => a - b),
        buses: [...buses].sort((a, b) => a - b),
        restoredExact: cubeSnap === restoredSnap
          && JSON.stringify(cubeKicks) === JSON.stringify(song.kicks)
          && JSON.stringify(cubeSnares) === JSON.stringify(song.snares),
      });
    }
    return out;
  })()`);

  const ARC_KINDS = [D.KIND.ARC_LEAD, D.KIND.ARC_BASS, D.KIND.ARC_PERC, D.KIND.ARC_ARP];
  const ARC_BUSES = [D.BUS.lead, D.BUS.bass, D.BUS.arp, D.BUS.drums].sort((a, b) => a - b);

  for (const r of res) {
    ok(!r.hasCubeOnly && r.sorted && r.finite, `${r.w}: pure 4-channel retro score, sorted and finite`);
    ok(r.kinds.every((k) => ARC_KINDS.includes(k)) && r.kinds.length === 4,
      `${r.w}: all instrument parts including drums use the 4 Arcade DSP voices (${r.kinds.join(',')})`);
    ok(JSON.stringify(r.buses) === JSON.stringify(ARC_BUSES) && r.noPaletteTable && r.noMotionTable,
      `${r.w}: routed strictly to the 4 channels, ignoring Palette and Cube Motion`);
    ok(r.restoredExact, `${r.w}: switching back to Cube restores the exact original score, kicks, and snares`);
  }

  const rawFallback = J(`(() => {
    const sg = buildSigil('KRSTVM'), song = composeSong(sg);
    song.events.push(
      { beat: 2, type: 'tom', tom: 1, vel: 0.7 },
      { beat: 2.25, type: 'perc', pi: 2, vel: 0.7 },
      { beat: 2.5, type: 'rim', vel: 0.6 },
      { beat: 2.75, type: 'clap', vel: 0.7 },
      { beat: 3.0, type: 'ride', vel: 0.6 },
      { beat: 3.25, type: 'comp', midi: 64, dur: 0.5, vel: 0.6 }
    );
    song.events.sort((a, b) => a.beat - b.beat);
    const spec = SigilPlan.defaultSpec(sg, song);
    spec.P = { ...spec.P, eng: 1 };
    const p = SigilPlan.compile(song, sg, { spec, rawScore: true });
    const kinds = new Set();
    for (let i = 0; i < p.count; i++) kinds.add(p.events[i * 16 + 1] & 255);
    return [...kinds].sort((a, b) => a - b);
  })()`);
  ok(rawFallback.every((k) => ARC_KINDS.includes(k)), `even raw score event types (pad, drone, bell, harm, comp, tom, perc, rim, clap, ride, swell) compile 100% to Arcade voices (${rawFallback.join(',')})`);
});

group('§2 · the 12 shared macro parameter controls & codec', () => {
  const macros = J(`(() => {
    const want = [
      'Tempo', 'Scale density', 'Complexity', 'Swing',
      'Lead brightness', 'FM depth', 'Pulse width', 'Bass drive',
      'Drum density', 'Noise decay', 'Arpeggio rate', 'Space'
    ];
    const got = Arcade.MACROS.map((m) => m.label);
    const patch = {
      eng: 1, aTempo: 142, aScale: 0.72, aComplex: 0.64, aSwing: 0.18,
      aBright: 0.81, aFm: 0.67, aPw: 0.25, aDrive: 0.48,
      aDrum: 0.75, aDecay: 1.15, aArp: 0.62, aSpace: 0.44
    };
    const enc = SoundDesign.encodePatch(patch, 2);
    const dec = SoundDesign.decodePatch(enc);

    const sg = buildSigil('KRSTVM'), baseSong = composeSong(sg);
    const wr = (over) => Arcade.write({
      sections: baseSong.sections.map((s) => ({ ...s })),
      phrases: baseSong.phrases, P: baseSong.P, bpm: baseSong.bpm, total: baseSong.total, cfg: baseSong.cfg
    }, sg, over).events;

    const eSparse = wr({ aScale: 0.08, aComplex: 0.2 }), eDense = wr({ aScale: 0.95, aComplex: 0.2 });
    const eSimple = wr({ aComplex: 0.05, aScale: 0.5 }), eComplex = wr({ aComplex: 0.95, aScale: 0.5 });
    const eStraight = wr({ aSwing: 0, aDrum: 0.8, aArp: 0.5 }), eSwung = wr({ aSwing: 0.45, aDrum: 0.8, aArp: 0.5 });
    const eNoDrums = wr({ aDrum: 0 }), eBusyDrums = wr({ aDrum: 0.95, aComplex: 0.8 });
    const eSlowArp = wr({ aArp: 0.05 }), eFastArp = wr({ aArp: 0.75 }), eChipArp = wr({ aArp: 0.95 });

    const pcs = (evs) => new Set(evs.filter((e) => e.type === 'lead').map((e) => ((e.midi % 12) + 12) % 12)).size;
    const drumTypes = new Set(['kick', 'snare', 'hat', 'tom', 'crash']);
    const offGrid = (evs) => evs.filter((e) => Math.abs(e.beat * 4 - Math.round(e.beat * 4)) > 0.01).length;

    const checkMono = (evs, type) => {
      const list = evs.filter((e) => e.type === type);
      for (let i = 1; i < list.length; i++) {
        if (list[i].beat < list[i - 1].beat + list[i - 1].dur - 1e-3) return false;
      }
      return true;
    };

    const jFast = SigilPlan.renderJob(baseSong, sg, { sr: 44100, spec: { ...SigilPlan.defaultSpec(sg, baseSong), P: { ...SigilPlan.defaultSpec(sg, baseSong).P, eng: 1, aTempo: 160, aSpace: 0 } } });
    const jSlow = SigilPlan.renderJob(baseSong, sg, { sr: 44100, spec: { ...SigilPlan.defaultSpec(sg, baseSong), P: { ...SigilPlan.defaultSpec(sg, baseSong).P, eng: 1, aTempo: 90, aSpace: 0.9 } } });

    return {
      labelsMatch: JSON.stringify(got) === JSON.stringify(want),
      roundtrip: JSON.stringify(dec.o) === JSON.stringify(patch) && dec.variant === 2,
      scaleNotes: [eSparse.filter((e) => e.type === 'lead').length, eDense.filter((e) => e.type === 'lead').length],
      scalePcs: [pcs(eSparse), pcs(eDense)],
      complexCount: [eSimple.length, eComplex.length],
      monoLead: checkMono(eComplex, 'lead'),
      monoBass: checkMono(eComplex, 'bass'),
      swingOffGrid: [offGrid(eStraight), offGrid(eSwung)],
      drumCounts: [eNoDrums.filter((e) => drumTypes.has(e.type)).length, eBusyDrums.filter((e) => drumTypes.has(e.type)).length],
      arpCounts: [eSlowArp.filter((e) => e.type === 'arp').length, eFastArp.filter((e) => e.type === 'arp').length],
      chipFlag: eChipArp.some((e) => e.type === 'arp' && e.chip === 1 && e.midis && e.midis.length >= 3),
      tempoBpm: [jFast.bpm, jSlow.bpm],
      spaceRev: [jFast.params.reverb, jSlow.params.reverb],
    };
  })()`);

  ok(macros.labelsMatch, 'all 12 shared macro parameters exist with the exact requested labels');
  ok(macros.roundtrip, 'all 12 macro parameters + engine flag survive patch encode/decode roundtrip');
  ok(macros.scaleNotes[1] > macros.scaleNotes[0] && macros.scalePcs[1] >= macros.scalePcs[0],
    `Scale density shapes melodic/harmonic pitch density (${macros.scaleNotes[0]} → ${macros.scaleNotes[1]} lead notes)`);
  ok(macros.complexCount[1] > macros.complexCount[0] && macros.monoLead && macros.monoBass,
    `Complexity enriches all 4 channels (${macros.complexCount[0]} → ${macros.complexCount[1]} events) while keeping Lead and Bass monophonic`);
  ok(macros.swingOffGrid[0] === 0 && macros.swingOffGrid[1] > 100,
    `Swing shifts off-beat sixteenths across the 4 channels (${macros.swingOffGrid[0]} → ${macros.swingOffGrid[1]} swung events)`);
  ok(macros.drumCounts[0] === 0 && macros.drumCounts[1] > 200,
    `Drum density scales Channel 3 from silent (${macros.drumCounts[0]}) to full arcade groove + fills (${macros.drumCounts[1]})`);
  ok(macros.arpCounts[1] > macros.arpCounts[0] * 2 && macros.chipFlag,
    `Arpeggio rate scales Channel 4 from 1/8 (${macros.arpCounts[0]}) to 1/32 (${macros.arpCounts[1]}) and VBI chip-chords`);
  ok(macros.tempoBpm[0] === 160 && macros.tempoBpm[1] === 90, 'Tempo macro controls render/playback BPM directly');
  ok(macros.spaceRev[0] === 0 && macros.spaceRev[1] > 0.9, 'Space macro controls reverb/echo send from completely dry (0) to lush hall');
});

if (!QUICK) {
  group('§3 · DSP audio synthesis of the 4 Arcade voices & macro timbre controls', () => {
    function renderVoice(kind, bus, f, p, secPatch, secs = 1.2, durBeats = 1.0) {
      const sr = 44100;
      const core = new D.Core(sr, { warm: false });
      const sec = new Float64Array(D.PSTRIDE);
      sec[D.PA.ALEAD] = secPatch.aBright ?? 0.65;
      sec[D.PA.AFM] = secPatch.aFm ?? 0.5;
      sec[D.PA.APW] = secPatch.aPw ?? 0.25;
      sec[D.PA.ADRIVE] = secPatch.aDrive ?? 0.35;
      sec[D.PA.ADECAY] = secPatch.aDecay ?? 0.7;
      sec[D.PA.AARP] = secPatch.aArp ?? 0.5;
      sec[D.PA.ECHO] = secPatch.aSpace ?? 0;
      sec[D.PA.DRUMS] = 1;
      sec[D.PA.BITS] = 16; sec[D.PA.HOLD] = 1; sec[D.PA.DBITS] = 16; sec[D.PA.DHOLD] = 1;
      const ev = new Float64Array(D.STRIDE);
      ev[D.EV.BEAT] = 0; ev[D.EV.KIND] = kind; ev[D.EV.BUS] = bus;
      ev[D.EV.F] = f; ev[D.EV.DUR] = durBeats; ev[D.EV.VEL] = 0.85; ev[D.EV.SEED] = 12345;
      (p || []).forEach((v, i) => { ev[D.EV.P0 + i] = v; });
      core.command({ type: 'plan', events: ev, count: 1, sections: sec, nSec: 1, total: 8, bpm: 120, passes: 1 });
      core.command({ type: 'params', reverb: (secPatch.aSpace ?? 0) * 1.2 });
      core.command({ type: 'play', beat: 0, pass: 0, chase: false });
      core.snapFx();
      const N = Math.round(secs * sr), L = new Float32Array(N), R = new Float32Array(N);
      const bl = new Float32Array(D.BLOCK), br = new Float32Array(D.BLOCK);
      for (let pos = 0; pos < N; pos += D.BLOCK) {
        core.process(bl, br, D.BLOCK);
        const take = Math.min(D.BLOCK, N - pos);
        L.set(bl.subarray(0, take), pos);
        R.set(br.subarray(0, take), pos);
      }
      let energy = 0, tailEnergy = 0, peak = 0, hfDiff = 0, finite = true;
      const tailFrom = Math.floor(N * 0.75);
      for (let i = 0; i < N; i++) {
        if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) finite = false;
        const a = Math.abs(L[i]);
        if (a > peak) peak = a;
        energy += L[i] * L[i];
        if (i >= tailFrom) tailEnergy += L[i] * L[i];
        if (i > 0) { const d = L[i] - L[i - 1]; hfDiff += d * d; }
      }
      return { L, R, finite, nans: core.nans, peak, rms: Math.sqrt(energy / N), tailRms: Math.sqrt(tailEnergy / (N - tailFrom)), hfRatio: hfDiff / (energy + 1e-12) };
    }

    const leadDark = renderVoice(D.KIND.ARC_LEAD, D.BUS.lead, 440, [0, 2, 3], { aBright: 0.05, aFm: 0.5 });
    const leadBright = renderVoice(D.KIND.ARC_LEAD, D.BUS.lead, 440, [0, 2, 3], { aBright: 0.95, aFm: 0.5 });
    ok(leadDark.finite && leadBright.finite && leadBright.hfRatio > leadDark.hfRatio * 1.5,
      `Lead brightness opens high-frequency spectrum of ARC_LEAD (${leadDark.hfRatio.toFixed(3)} → ${leadBright.hfRatio.toFixed(3)})`);

    const leadPure = renderVoice(D.KIND.ARC_LEAD, D.BUS.lead, 330, [0, 2, 3], { aBright: 0.75, aFm: 0 });
    const leadFm = renderVoice(D.KIND.ARC_LEAD, D.BUS.lead, 330, [0, 2, 3], { aBright: 0.75, aFm: 0.95 });
    ok(leadPure.finite && leadFm.finite && leadFm.hfRatio > leadPure.hfRatio * 1.8,
      `FM depth drives FM sidebands on ARC_LEAD (${leadPure.hfRatio.toFixed(3)} → ${leadFm.hfRatio.toFixed(3)})`);

    const bassNarrow = renderVoice(D.KIND.ARC_BASS, D.BUS.bass, 110, [], { aPw: 0.12, aDrive: 0.2 });
    const bassSquare = renderVoice(D.KIND.ARC_BASS, D.BUS.bass, 110, [], { aPw: 0.5, aDrive: 0.2 });
    let diffPw = 0;
    for (let i = 0; i < 4000; i++) diffPw += Math.abs(bassNarrow.L[i] - bassSquare.L[i]);
    ok(bassNarrow.finite && bassSquare.finite && diffPw > 20,
      `Pulse width reshapes ARC_BASS duty cycle cleanly (waveform L1 diff ${diffPw.toFixed(1)})`);

    const bassClean = renderVoice(D.KIND.ARC_BASS, D.BUS.bass, 82.4, [], { aPw: 0.25, aDrive: 0 });
    const bassDriven = renderVoice(D.KIND.ARC_BASS, D.BUS.bass, 82.4, [], { aPw: 0.25, aDrive: 1 });
    ok(bassClean.finite && bassDriven.finite && bassDriven.hfRatio > bassClean.hfRatio * 1.4,
      `Bass drive saturates ARC_BASS with upper harmonics (${bassClean.hfRatio.toFixed(4)} → ${bassDriven.hfRatio.toFixed(4)})`);

    const snareShort = renderVoice(D.KIND.ARC_PERC, D.BUS.drums, 180, [1, 0, 1], { aDecay: 0.2 }, 0.8, 0.25);
    const snareLong = renderVoice(D.KIND.ARC_PERC, D.BUS.drums, 180, [1, 0, 1], { aDecay: 1.9 }, 0.8, 0.25);
    ok(snareShort.finite && snareLong.finite && snareLong.rms > snareShort.rms * 1.35,
      `Noise decay lengthens LFSR noise percussion envelope (${snareShort.rms.toFixed(4)} → ${snareLong.rms.toFixed(4)} rms)`);

    for (const [sub, name] of [[0, 'kick'], [1, 'snare'], [2, 'hat'], [3, 'tom'], [4, 'crash']]) {
      const h = renderVoice(D.KIND.ARC_PERC, D.BUS.drums, 120, [sub, sub % 2, 1], { aDecay: 0.7 }, 1.2, 0.25);
      ok(h.finite && h.nans === 0 && h.peak > 0.05 && h.peak <= 1.05, `ARC_PERC ${name}: finite, audible, bounded (peak ${h.peak.toFixed(2)})`);
    }

    const arpChip = renderVoice(D.KIND.ARC_ARP, D.BUS.arp, 261.63, [329.63, 392.0, 523.25, 0, 0, 1], { aArp: 0.9, aBright: 0.7 }, 1.0, 1.5);
    ok(arpChip.finite && arpChip.nans === 0 && arpChip.rms > 0.02 && arpChip.peak <= 1.05,
      `ARC_ARP VBI chip-chord: finite, audible, bounded (rms ${arpChip.rms.toFixed(3)})`);

    const drySpace = renderVoice(D.KIND.ARC_LEAD, D.BUS.lead, 440, [0, 2, 3], { aSpace: 0 }, 1.6, 0.4);
    const wetSpace = renderVoice(D.KIND.ARC_LEAD, D.BUS.lead, 440, [0, 2, 3], { aSpace: 0.95 }, 1.6, 0.4);
    ok(drySpace.tailRms < 1e-4 && wetSpace.tailRms > 0.003,
      `Space macro: dry tail is silent (${drySpace.tailRms.toExponential(1)}), wet tail rings with stereo echo & hall (${wetSpace.tailRms.toFixed(4)})`);

    const job = realm(run(`(() => {
      const sg = buildSigil('KRSTVM'), song = composeSong(sg);
      Arcade.apply(song, sg, { eng: 1 });
      const spec = SigilPlan.defaultSpec(sg, song);
      spec.P = { ...spec.P, eng: 1 };
      return SigilPlan.renderJob(song, sg, { sr: 44100, spb: 60 / 132, passes: 1, spec });
    })()`));
    const r1 = D.renderRange(job, 4, 12, 4);
    const r2 = D.renderRange(job, 4, 12, 4);
    let same = true, pk = 0, sumSq = 0;
    for (let i = 0; i < r1.L.length; i++) {
      if (r1.L[i] !== r2.L[i] || r1.R[i] !== r2.R[i]) same = false;
      const a = Math.max(Math.abs(r1.L[i]), Math.abs(r1.R[i]));
      if (a > pk) pk = a;
      sumSq += r1.L[i] * r1.L[i] + r1.R[i] * r1.R[i];
    }
    ok(same && pk > 0.1 && pk <= 1.05 && sumSq > 100, `full 4-channel Arcade song render is deterministic, lively and bounded (peak ${pk.toFixed(3)})`);
  });
}

group('§4 · UI engine switching & exclusive display of controls', () => {
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  ok(scriptSrcs.includes('src/core/05l-arcade.js'), 'index.html loads src/core/05l-arcade.js in script order');

  class FakeNode {
    constructor(tag, doc) {
      this.tagName = String(tag || 'DIV').toUpperCase();
      this.ownerDocument = doc;
      this.children = [];
      this.parentElement = null;
      this.className = '';
      this.id = '';
      this.hidden = false;
      this.open = false;
      this.inert = false;
      this.disabled = false;
      this.checked = false;
      this.value = '';
      this.textContent = '';
      this.title = '';
      this.tabIndex = 0;
      this.style = { setProperty() {}, cssText: '' };
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this._innerHTML = '';
      const self = this;
      this.classList = {
        _set() { return new Set(String(self.className || '').split(/\s+/).filter(Boolean)); },
        add(...cs) { const s = this._set(); cs.forEach((c) => c && s.add(c)); self.className = [...s].join(' '); },
        remove(...cs) { const s = this._set(); cs.forEach((c) => s.delete(c)); self.className = [...s].join(' '); },
        toggle(c, f) { const s = this._set(); const on = f !== undefined ? !!f : !s.has(c); if (on) s.add(c); else s.delete(c); self.className = [...s].join(' '); return on; },
        contains(c) { return this._set().has(c); },
      };
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) { this._innerHTML = v; if (v === '') this.children = []; }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = String(v);
      }
    }
    getAttribute(k) { return k === 'id' ? this.id : k === 'class' ? this.className : this.attributes[k] ?? null; }
    append(...nodes) {
      for (const n of nodes) {
        const child = typeof n === 'string' ? new FakeNode('#text', this.ownerDocument) : n;
        if (typeof n === 'string') child.textContent = n;
        if (child && child.parentElement) {
          const idx = child.parentElement.children.indexOf(child);
          if (idx >= 0) child.parentElement.children.splice(idx, 1);
        }
        if (child) { child.parentElement = this; this.children.push(child); }
      }
    }
    prepend(...nodes) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!n) continue;
        if (n.parentElement) {
          const idx = n.parentElement.children.indexOf(n);
          if (idx >= 0) n.parentElement.children.splice(idx, 1);
        }
        n.parentElement = this;
        this.children.unshift(n);
      }
    }
    appendChild(n) { this.append(n); return n; }
    insertBefore(n, ref) {
      if (!ref) { this.append(n); return n; }
      if (n.parentElement) {
        const i = n.parentElement.children.indexOf(n);
        if (i >= 0) n.parentElement.children.splice(i, 1);
      }
      n.parentElement = this;
      const at = this.children.indexOf(ref);
      if (at >= 0) this.children.splice(at, 0, n); else this.children.push(n);
      return n;
    }
    before(n) { if (this.parentElement) this.parentElement.insertBefore(n, this); }
    after(n) {
      if (!this.parentElement) return;
      const i = this.parentElement.children.indexOf(this);
      this.parentElement.insertBefore(n, this.parentElement.children[i + 1] || null);
    }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() {
      if (!this.parentElement) return;
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
    contains(other) {
      for (let p = other; p; p = p.parentElement) if (p === this) return true;
      return false;
    }
    closest(sel) {
      for (let p = this; p; p = p.parentElement) if (matches(p, sel)) return p;
      return null;
    }
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
    dispatchEvent(ev) {
      ev.target = ev.target || this;
      ev.currentTarget = this;
      for (const fn of this.listeners[ev.type] || []) fn(ev);
    }
    click() { this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} }); }
    focus() {}
    blur() {}
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 100 }; }
    get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
    get rows() { return this.children.filter((c) => c.tagName === 'TR'); }
    get cells() { return this.children.filter((c) => c.tagName === 'TD' || c.tagName === 'TH'); }
    getContext() {
      return {
        clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {}, fillText() {},
        setLineDash() {}, setTransform() {}, drawImage() {}, save() {}, restore() {}, scale() {},
        createRadialGradient() { return { addColorStop() {} }; },
        createLinearGradient() { return { addColorStop() {} }; },
      };
    }
    querySelector(sel) { return queryAll(this, sel)[0] || null; }
    querySelectorAll(sel) { return queryAll(this, sel); }
  }

  function matches(node, sel) {
    if (!node || node.tagName === '#TEXT') return false;
    sel = sel.trim();
    if (sel.includes(' ')) {
      const parts = sel.split(/\s+/);
      if (!matches(node, parts[parts.length - 1])) return false;
      let cur = node.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !matches(cur, parts[i])) cur = cur.parentElement;
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    }
    let m;
    if ((m = sel.match(/^([a-z0-9]+)?#([a-zA-Z0-9_-]+)$/))) {
      return (!m[1] || node.tagName === m[1].toUpperCase()) && node.id === m[2];
    }
    if ((m = sel.match(/^([a-z0-9]+)?\.([a-zA-Z0-9_-]+)$/))) {
      return (!m[1] || node.tagName === m[1].toUpperCase()) && node.classList.contains(m[2]);
    }
    if ((m = sel.match(/^([a-z0-9]+)?\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/))) {
      if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
      const v = node.getAttribute(m[2]);
      return m[3] !== undefined ? v === m[3] : v !== null;
    }
    return node.tagName === sel.toUpperCase();
  }

  function queryAll(root, sel) {
    const out = [];
    const groups = sel.split(',').map((s) => s.trim());
    const walk = (n) => {
      for (const c of n.children || []) {
        if (groups.some((g) => matches(c, g))) out.push(c);
        walk(c);
      }
    };
    walk(root);
    return out;
  }

  const doc = {
    head: null, body: null, documentElement: null, activeElement: null, hidden: false, fullscreenElement: null,
    createElement(t) { return new FakeNode(t, doc); },
    querySelector(s) { return queryAll(doc.documentElement, s)[0] || null; },
    querySelectorAll(s) { return queryAll(doc.documentElement, s); },
    getElementById(id) { return queryAll(doc.documentElement, '#' + id)[0] || null; },
    addEventListener() {},
  };
  doc.documentElement = new FakeNode('html', doc);
  doc.head = new FakeNode('head', doc);
  doc.body = new FakeNode('body', doc);
  doc.documentElement.append(doc.head, doc.body);

  const stage = new FakeNode('canvas', doc); stage.id = 'stage';
  const ui = new FakeNode('div', doc); ui.id = 'ui';
  const top = new FakeNode('header', doc); top.id = 'top';
  const aboutBtn = new FakeNode('button', doc); aboutBtn.id = 'aboutBtn';
  top.append(aboutBtn);
  const invoke = new FakeNode('section', doc); invoke.id = 'invoke';
  const desireLbl = new FakeNode('label', doc); desireLbl.id = 'desireLabel';
  const field = new FakeNode('div', doc); field.className = 'field';
  const desire = new FakeNode('input', doc); desire.id = 'desire';
  const castBtn = new FakeNode('button', doc); castBtn.id = 'castBtn';
  field.append(desire, castBtn);
  const hint = new FakeNode('p', doc); hint.className = 'hint';
  const err = new FakeNode('p', doc); err.id = 'err';
  invoke.append(desireLbl, field, hint, err);
  const reduction = new FakeNode('div', doc); reduction.id = 'reduction';
  const hud = new FakeNode('section', doc); hud.id = 'hud';
  const secInfo = new FakeNode('div', doc); secInfo.id = 'secInfo';
  ['roman', 'name', 'desc'].forEach((c) => { const sp = new FakeNode('span', doc); sp.className = c; secInfo.append(sp); });
  const center = new FakeNode('div', doc); center.id = 'center';
  const letters = new FakeNode('div', doc); letters.id = 'letters';
  const progress = new FakeNode('div', doc); progress.id = 'progress';
  const fill = new FakeNode('div', doc); fill.className = 'fill'; progress.append(fill);
  center.append(letters, progress);
  const right = new FakeNode('div', doc); right.id = 'right';
  const meta = new FakeNode('div', doc); meta.id = 'meta';
  const controls = new FakeNode('div', doc); controls.id = 'controls';
  right.append(meta, controls);
  hud.append(secInfo, center, right);
  const toastEl = new FakeNode('div', doc); toastEl.id = 'toast';
  const about = new FakeNode('div', doc); about.id = 'about';
  const aboutClose = new FakeNode('button', doc); aboutClose.id = 'aboutClose'; about.append(aboutClose);
  ui.append(top, invoke, reduction, hud, toastEl, about);
  doc.body.append(stage, ui);

  const storage = new Map();
  const rafQueue = [];
  const flushRaf = () => { const batch = rafQueue.splice(0); batch.forEach((fn) => fn(performance.now())); };
  const sb = {
    TextEncoder, btoa, atob, console, performance, Math,
    document: doc, Node: FakeNode, Event: class {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    location: { protocol: 'http:', hash: '', href: 'http://localhost/', pathname: '/', search: '' },
    history: { replaceState() {} },
    navigator: { hardwareConcurrency: 4 },
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    setTimeout: () => 1, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
  };
  sb.window = sb; sb.globalThis = sb; sb.self = sb;
  const ctx = createContext(sb);
  for (const f of scriptSrcs) runInContext(readFileSync(join(process.cwd(), f), 'utf8'), ctx, { filename: f });
  const preflightMatch = html.match(/<script>\s*(\(function preflight\(\)[\s\S]*?)<\/script>/);
  if (preflightMatch) runInContext(preflightMatch[1], ctx, { filename: 'index.html:preflight' });
  ok(doc.querySelectorAll('[role="alert"]').length === 0, 'index.html preflight passes with zero missing globals or load errors');
  flushRaf();

  const isVisible = (node) => {
    for (let p = node; p; p = p.parentElement) if (p.hidden) return false;
    return !!node;
  };

  const stateCube = runInContext(`Sound.engine`, ctx);
  const cubePane = doc.querySelector('.snd-cube-pane');
  const arcadePane = doc.querySelector('.snd-arcade-pane');
  const toolPalette = doc.getElementById('tool-palette');
  const toolDrums = doc.getElementById('tool-drums');
  const toolMotion = doc.getElementById('tool-motion');

  ok(stateCube === 'cube', 'default engine is "cube"');
  ok(isVisible(cubePane) && !isVisible(arcadePane), 'in Cube mode: Cube controls are displayed and Arcade controls are hidden');
  ok(!toolPalette.hidden && !toolDrums.hidden && !toolMotion.hidden, 'in Cube mode: Palette, Drum Engine, and Motion panels are displayed');

  const arcBtn = doc.querySelector('button[data-engine="arcade"]');
  arcBtn.click();
  flushRaf();

  const stateArcade = runInContext(`Sound.engine`, ctx);
  ok(stateArcade === 'arcade', 'clicking Arcade switches engine to "arcade"');
  ok(!isVisible(cubePane) && isVisible(arcadePane), 'in Arcade mode: ONLY Arcade controls are displayed and Cube controls are hidden');
  ok(toolPalette.hidden && toolDrums.hidden && toolMotion.hidden, 'in Arcade mode: Cube-only Palette, Drum Engine, and Motion panels are hidden');

  const visibleSliders = queryAll(doc.getElementById('tool-sound'), '[role="slider"]')
    .filter((el) => isVisible(el))
    .map((el) => el.getAttribute('aria-label'));
  const expectedLabels = [
    'Tempo', 'Scale density', 'Complexity', 'Swing',
    'Lead brightness', 'FM depth', 'Pulse width', 'Bass drive',
    'Drum density', 'Noise decay', 'Arpeggio rate', 'Space',
  ];
  ok(JSON.stringify(visibleSliders) === JSON.stringify(expectedLabels),
    `in Arcade mode: visible parameter controls are strictly the 12 Arcade macros (${visibleSliders.join(', ')})`);

  const cubeBtn = doc.querySelector('button[data-engine="cube"]');
  cubeBtn.click();
  flushRaf();
  ok(runInContext(`Sound.engine`, ctx) === 'cube' && isVisible(cubePane) && !isVisible(arcadePane) && !toolPalette.hidden && !toolDrums.hidden && !toolMotion.hidden,
    'clicking Cube switches back to "cube" and restores Cube controls while hiding Arcade controls');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
