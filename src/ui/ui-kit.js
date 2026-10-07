'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   M0 · UI KIT — shared infrastructure for all feature modules
   --------------------------------------------------------------------------
   This is the SECOND of the two coupling points (the first is Hooks). Modules
   must not touch each other's DOM; they register panels here instead.

     UI.h(tag, attrs, ...kids)            tiny DOM builder (on* attrs → listeners)
     UI.css(text)                         inject a module's stylesheet
     UI.section({id,title,order,build})   register a collapsible Tools panel
     UI.open(id?) / UI.close()            open the Tools drawer (optionally at a panel)
     UI.slider / check / select / button / note   consistent form controls
     UI.key(keys, label, run, {group})    keyboard shortcut registry (+ "?" sheet)
     UI.announce(text)                    polite screen-reader announcement
     UI.parseKey / formatKey / validMember  link format:  #KRSTV+MNLP~ambient
     UI.recompose()                       rebuild the current song in place
     UI.refreshPalette()                  re-run palette filters
     UI.whenReady(fn)                     run after ALL module scripts have loaded
     UI.fmt(seconds) / UI.fileKey()       formatting helpers

   Styles live in styles/ui-kit.css. UI.css() remains available for modules
   that ship a handful of their own rules.
   ══════════════════════════════════════════════════════════════════════════ */

const UI = (() => {
  'use strict';

  /* ── §M0.1 DOM builder ─────────────────────────────────────────────────
     Attribute conventions:
       class / style / text  → the obvious thing
       on*  + function       → addEventListener(name.slice(2), fn)
       value / checked / disabled → set as PROPERTIES, not attributes
       true                  → a bare boolean attribute
       null | false          → skipped entirely
     ─────────────────────────────────────────────────────────────────────── */
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) {
      if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    }
    return el;
  };

  const css = (text) => document.head.append(h('style', {}, text));

  /* ── §M0.2 The drawer ──────────────────────────────────────────────────
     `inert` keeps the closed drawer out of the tab order and away from
     screen readers, which is cheaper and more correct than display:none
     (the CSS transition still works).
     ─────────────────────────────────────────────────────────────────────── */
  const top = document.querySelector('header#top');
  const toolsBtn = h('button', {
    class: 'ghost', id: 'toolsBtn',
    'aria-expanded': 'false', 'aria-controls': 'drawer', title: 'Tools (T)',
  }, 'Tools');

  // Re-parent the About button so both sit in one flex group.
  top.append(h('div', { class: 'top-right' }, toolsBtn, document.querySelector('#aboutBtn')));

  const body = h('div', { id: 'drawerBody' });
  const closeBtn = h('button', { class: 'ghost sm', 'aria-label': 'Close tools' }, 'Close');
  const drawer = h('aside', { id: 'drawer', 'aria-label': 'Tools', tabindex: '-1' },
    h('header', {}, h('span', {}, 'Tools'), closeBtn), body);
  drawer.inert = true;
  document.querySelector('#ui').append(drawer);

  const isOpen = () => drawer.classList.contains('open');

  function open(id) {
    drawer.classList.add('open');
    drawer.inert = false;
    toolsBtn.setAttribute('aria-expanded', 'true');
    const d = id && document.getElementById('tool-' + id);
    if (d) { d.open = true; setTimeout(() => d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60); }
    drawer.focus({ preventScroll: true });
  }

  function close() {
    const hadFocus = drawer.contains(document.activeElement);
    drawer.classList.remove('open');
    drawer.inert = true;
    toolsBtn.setAttribute('aria-expanded', 'false');
    if (hadFocus) toolsBtn.focus();   // never strand focus on an inert subtree
  }

  toolsBtn.addEventListener('click', () => (isOpen() ? close() : open()));
  closeBtn.addEventListener('click', close);

  /**
   * Register a collapsible panel.
   * `order` sorts panels within the drawer (lower = higher up); the open/closed
   * state is remembered per panel. A throwing build() degrades to a note rather
   * than taking the drawer down.
   */
  function section({ id, title, order = 50, open: openDefault = false, build }) {
    const content = h('div', { class: 'tool-body' });
    const det = h('details', { class: 'tool', id: 'tool-' + id, 'data-order': order },
      h('summary', {}, title), content);

    det.open = Prefs.get('tool.' + id, openDefault);
    det.addEventListener('toggle', () => Prefs.set('tool.' + id, det.open));

    const next = [...body.children].find((c) => +c.dataset.order > order);
    body.insertBefore(det, next || null);

    try { build(content, det); }
    catch (e) { console.error('[UI.section]', id, e); content.append(note('This tool failed to load; see the console.')); }

    return det;
  }

  /* ── §M0.3 Controls ────────────────────────────────────────────────────
     Each returns an element with a `.input` property (the focusable control)
     and, for sliders, a `.set(v)` method so callers can sync it from elsewhere
     without firing the change handler.
     ─────────────────────────────────────────────────────────────────────── */

  function slider({ label, min, max, step = 1, value, format = String, onInput, title }) {
    const out = h('output', {}, format(value));
    const inp = h('input', { type: 'range', class: 'sg', min, max, step, value, 'aria-label': label, title });
    inp.addEventListener('input', () => { out.textContent = format(+inp.value); onInput(+inp.value, row); });
    const row = h('div', { class: 'ctl' }, h('label', {}, label), inp, out);
    row.set = (v) => { inp.value = v; out.textContent = format(+v); };
    row.input = inp;
    return row;
  }

  function check({ label, checked, onChange, title }) {
    const inp = h('input', { type: 'checkbox', checked: !!checked });
    inp.addEventListener('change', () => onChange(inp.checked));
    const el = h('label', { class: 'sgtoggle', title }, inp, h('span', {}, label));
    el.input = inp;
    return el;
  }

  function select({ label, options, value, onChange, title }) {
    const sel = h('select', { class: 'sg', 'aria-label': label, title },
      options.map(([v, t]) => h('option', { value: v }, t)));
    sel.value = String(value);
    sel.addEventListener('change', () => onChange(sel.value));
    const row = h('div', { class: 'ctl' }, h('label', {}, label), sel, h('span'));
    row.input = sel;
    return row;
  }

  const button = (text, onClick, attrs = {}) =>
    h('button', { class: 'sm', type: 'button', ...attrs, onclick: onClick }, text);

  const note = (text) => h('p', { class: 'tool-note' }, text);

  /* ── §M0.4 Keyboard registry ───────────────────────────────────────────
     Shortcuts are ignored while typing in a form field or contenteditable, and
     while any modifier is held. Arrow keys are exempt from the auto-repeat
     guard so the Live Lens can be spun.
     ─────────────────────────────────────────────────────────────────────── */
  const keymap = [];

  function key(keys, label, run, { group = 'General', display } = {}) {
    const list = [].concat(keys);
    keymap.push({ keys: list, label, run, group, display: display || list.join(' / ') });
  }

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey || (e.repeat && !/^Arrow/.test(e.key))) return;

    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const hit = keymap.find((x) => x.run && x.keys.includes(k));
    if (hit) { e.preventDefault(); hit.run(e); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); help.classList.remove('open'); }
  });

  // Core shortcuts are handled by 08-app.js; they are listed here with run=null
  // purely so they appear in the help sheet.
  key(' ', 'Pause / resume', null, { group: 'Performance', display: 'Space' });
  key('c', 'Charge mode (fullscreen gnosis)', null, { group: 'Performance', display: 'C' });
  key('Escape', 'Leave charge · close panels', null, { display: 'Esc' });
  key('t', 'Open / close Tools', () => (isOpen() ? close() : open()), { display: 'T' });
  key('?', 'Show this help', () => toggleHelp(), { display: '?' });

  const help = h('div', {
    id: 'help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts',
    onclick: (e) => { if (e.target.id === 'help') toggleHelp(false); },
  });
  document.querySelector('#ui').append(help);

  /** The help sheet is rebuilt on each open, so late-registered keys appear. */
  function toggleHelp(force) {
    const on = force ?? !help.classList.contains('open');
    if (on) {
      const groups = {};
      for (const k of keymap) (groups[k.group] = groups[k.group] || []).push(k);
      help.innerHTML = '';
      help.append(h('div', { class: 'panel' },
        h('h2', { style: 'font-weight:normal;font-style:italic;margin:0' }, 'Shortcuts'),
        Object.entries(groups).map(([g, list]) => [
          h('h3', {}, g),
          h('table', {}, list.map((k) => h('tr', {},
            h('td', {}, h('kbd', {}, k.display)),
            h('td', {}, k.label)))),
        ]),
        h('button', { class: 'sm', style: 'margin-top:18px', onclick: () => toggleHelp(false) }, 'Close')));
    }
    help.classList.toggle('open', on);
  }

  /* ── §M0.5 Screen-reader live region ───────────────────────────────────
     Clearing then setting after a tick forces re-announcement even when the
     text is identical to the previous message.
     ─────────────────────────────────────────────────────────────────────── */
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
  document.body.append(live);
  function announce(text) { live.textContent = ''; setTimeout(() => (live.textContent = text), 60); }

  /* ── §M0.6 Link format ─────────────────────────────────────────────────
     Members joined by '+', optional '~mood'. ONLY consonants are ever encoded;
     the original words never leave the page.
       #KRSTV            one sigil
       #KRSTV+MNLP       a fusion of two
       #KRSTV~ambient    a sigil in the Ambient mood
     ─────────────────────────────────────────────────────────────────────── */
  const MEMBER = /^[BCDFGHJKLMNPQRSTVWXYZ]{3,21}$/;
  const validMember = (s) => MEMBER.test(s) && new Set(s).size === s.length;

  /* Link format: members joined by '+', optional '~mood', optional '!patch'.
     Only consonants and synthesis numbers are ever encoded. Example:
        #KRSTV+MNLP~ambient!PAQk2…                                          */
        function parseKey(str) {
          let raw = String(str || '').replace(/^#/, '');
          try { raw = decodeURIComponent(raw); } catch { return null; }
          const [head, patch] = raw.split('!');
          const [bodyPart, preset] = (head || '').split('~');
          const members = (bodyPart || '').toUpperCase().split('+').filter(Boolean);
          if (!members.length || members.length > 3 || !members.every(validMember)) return null;
          return { members, preset: preset ? preset.toLowerCase() : null, patch: patch || null };
        }
      
        const formatKey = ({ members, preset, patch }) =>
          members.join('+') +
          (preset && preset !== 'ritual' ? '~' + preset : '') +
          (patch ? '!' + patch : '');

  /* ── §M0.7 Live re-composition ─────────────────────────────────────────
     Rebuild the current song in place (after a mood or attunement change),
     resuming at the section you were in. The SIGIL, melody and form are
     unchanged; only the arrangement differs.
     ─────────────────────────────────────────────────────────────────────── */
  function recompose() {
    if (app.mode !== 'playing' || !app.sigil || app.busy) return;

    const si = renderer.info ? renderer.info.si : 0;
    const song = composeSong(app.sigil);

    app.engine.stop(0.9);
    app.song = song;
    app.engine.load(song);
    app.engine.start(0.1);
    app.engine.seek(song.sections[Math.min(si, song.sections.length - 1)].start);

    applyPalette(app.sigil.palette);
    buildHUD();
    history.replaceState(null, '', '#' + shareKey());
    Hooks.emit('song', app.sigil, song, { recompose: true });
  }

  const refreshPalette = () => { applyPalette(app.basePalette || PALETTES[0]); renderMeta(); };

  /* ── §M0.8 Deferred init ───────────────────────────────────────────────
     whenReady() runs on DOMContentLoaded, i.e. after EVERY module script has
     evaluated. Use it for anything that depends on another module existing.
     ─────────────────────────────────────────────────────────────────────── */
  const ready = [];
  const whenReady = (fn) => ready.push(fn);
  document.addEventListener('DOMContentLoaded', () =>
    ready.forEach((f) => { try { f(); } catch (e) { console.error('[whenReady]', e); } }));

  /* ── §M0.9 Formatting ──────────────────────────────────────────────────── */
  const fmt = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fileKey = () => (app.sigil ? (app.sigil.fusionKey || app.sigil.reduced).replace(/\+/g, '_') : 'sigil');

  /* Extended links (#A+B~mood): prefill the invocation and let modules react.
     This supersedes the simple boot handler in 08-app.js. */
  whenReady(() => {
    const link = parseKey(location.hash);
    if (!link) return;
    document.querySelector('#desire').value = link.members[0];
    document.querySelector('#desireLabel').textContent = link.members.length > 1
      ? 'A joined sigil has been shared with you. Cast it to hear the voices together.'
      : 'A sigil has been shared with you. Cast it to hear it sing.';
    Hooks.emit('link', link);
  });

  return {
    h, css, section, open, close,
    slider, check, select, button, note,
    key, announce,
    parseKey, formatKey, validMember,
    recompose, refreshPalette, whenReady,
    fmt, fileKey,
  };
})();