'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   §0  UTILITIES · HOOKS · PREFS
   --------------------------------------------------------------------------
   Small pure helpers used everywhere, plus the two pieces of shared
   infrastructure that every feature module is allowed to touch:

     Hooks  — an event + filter bus (the ONLY coupling point between the
              core and the feature modules)
     Prefs  — namespaced, never-throwing localStorage

   TAU is a full turn (2π) because this project thinks in circles.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── §0.0 PRIMITIVES ───────────────────────────────────────────────────── */

/** `document.querySelector`, shortened. Used pervasively; never for lists. */
const $ = (s) => document.querySelector(s);

/** Promise-based sleep. The reduction ceremony is written as async/await. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One full turn in radians. */
const TAU = Math.PI * 2;

/** True modulo: always returns a value in [0, m). JS `%` keeps the sign. */
const mod = (n, m) => ((n % m) + m) % m;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

/** Cosine ease-in-out: gentle start and end, like a hand lifting a pen. */
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));

/**
 * Build a CSS rgba() string from a [r,g,b] triple and an alpha.
 * Alpha is clamped and fixed to 3 dp so the string stays stable (cheap for
 * the canvas fillStyle/strokeStyle cache).
 */
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;

/** Shared UTF-8 encoder (hashing, MIDI text events, Ogg comments). */
const te = new TextEncoder();

/** The canvas font stack. Mirrors --serif in core.css. */
const SERIF = '"Cormorant Garamond","EB Garamond","Iowan Old Style",' +
              '"Palatino Linotype",Palatino,Georgia,serif';

/* ── §0.1 HOOKS ────────────────────────────────────────────────────────────
   A tiny event + filter bus.

     Hooks.on(name, fn, priority = 0)  → returns an unsubscribe function
     Hooks.emit(name, ...args)           notify every listener
     Hooks.filter(name, value, ...a)     pipe a value through listeners; a
                                         listener returns a replacement, or
                                         undefined to keep the current value
                                         (it may also mutate objects in place)

   Listeners run in ASCENDING priority. Errors are caught per listener, so one
   faulty module can never stop the performance — it only logs.

   See README § "Extending SIGIL" for the catalogue of hook names and the
   shape of each payload. Adding a new hook is cheap; removing one is a
   breaking change for every module.
   ─────────────────────────────────────────────────────────────────────────── */
const Hooks = {
  /** @type {Map<string, {fn: Function, priority: number}[]>} */
  _m: new Map(),

  on(name, fn, priority = 0) {
    const list = (this._m.get(name) || []).concat({ fn, priority });
    list.sort((a, b) => a.priority - b.priority);
    this._m.set(name, list);
    return () => this.off(name, fn);
  },

  off(name, fn) {
    const l = this._m.get(name);
    if (l) this._m.set(name, l.filter((x) => x.fn !== fn));
  },

  emit(name, ...args) {
    for (const { fn } of this._m.get(name) || []) {
      try { fn(...args); } catch (e) { console.error(`[hook:${name}]`, e); }
    }
  },

  filter(name, value, ...args) {
    for (const { fn } of this._m.get(name) || []) {
      try {
        const r = fn(value, ...args);
        if (r !== undefined) value = r;
      } catch (e) { console.error(`[filter:${name}]`, e); }
    }
    return value;
  },
};

/* ── §0.2 PREFS ────────────────────────────────────────────────────────────
   Namespaced JSON localStorage under the `sigil.` prefix.

   It NEVER throws: private-browsing modes and full quotas simply fall back to
   defaults (get) or silently no-op (set). Nothing in the app may depend on a
   write having succeeded.
   ─────────────────────────────────────────────────────────────────────────── */
const Prefs = {
  get(k, d) {
    try {
      const v = localStorage.getItem('sigil.' + k);
      return v == null ? d : JSON.parse(v);
    } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('sigil.' + k, JSON.stringify(v)); }
    catch { /* quota exceeded or storage disabled — intentionally ignored */ }
  },
};