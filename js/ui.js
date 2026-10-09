// DOM helpers, icons, drawers, toasts. Text always goes through text nodes;
// innerHTML is only used for the constant SVG icon strings below.

export function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') throw new Error('no html');
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  append(e, children);
  return e;
}

// Replaces an element's contents. Like replaceChildren(), but skips null,
// false and undefined (replaceChildren would write "null") and flattens arrays.
export function fill(e, ...children) {
  e.replaceChildren();
  append(e, children);
  return e;
}

function append(e, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(e, c);
    else if (c instanceof Node) e.append(c);
    else e.append(String(c));
  }
}

const S = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

// A small, consistent stroke icon set drawn for this app.
const ICONS = {
  image: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4.5 18 5-5 3.5 3.5 3-3 3.5 3.5"/>'),
  library: S('<path d="M5 4.5h3.2v15H5zM10.4 4.5h3.2v15h-3.2z"/><path d="m15.8 5.3 3-.8 3.4 14.6-3 .8z"/>'),
  chords: S('<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9.7 3.5v17M14.3 3.5v17M5 8.3h14M5 13h14"/><circle cx="9.7" cy="10.7" r="1.3" fill="currentColor"/><circle cx="14.3" cy="15.5" r="1.3" fill="currentColor"/>'),
  tuner: S('<path d="M4 15a8 8 0 0 1 16 0"/><path d="m12 15 3.5-5.5"/><circle cx="12" cy="15" r="1.4" fill="currentColor"/><path d="M4 19h16"/>'),
  settings: S('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>'),
  search: S('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  minus: S('<path d="M5 12h14"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  back: S('<path d="M15 5l-7 7 7 7"/>'),
  forward: S('<path d="M9 5l7 7-7 7"/>'),
  down: S('<path d="m6 9 6 6 6-6"/>'),
  more: S('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
  heart: S('<path d="M12 20s-7.5-4.6-7.5-10.1A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z"/>'),
  heartFill: S('<path d="M12 20s-7.5-4.6-7.5-10.1A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" fill="currentColor"/>'),
  play: S('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke-width="1.5"/>'),
  pause: S('<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>'),
  stop: S('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/>'),
  text: S('<path d="M3.5 18 8 6l4.5 12M5.2 13.5h5.6"/><path d="M14.5 18l3-7.5 3 7.5M15.6 15.5h3.8"/>'),
  transpose: S('<path d="M7 4v16M7 4 4 7M7 4l3 3"/><path d="M17 20V4M17 20l-3-3M17 20l3-3"/>'),
  capo: S('<rect x="3.5" y="9" width="17" height="6" rx="1.5"/><path d="M6.5 9V6.5M12 9V5.5M17.5 9V6.5"/><path d="M12 15v3.5"/>'),
  video: S('<rect x="3" y="5.5" width="18" height="13" rx="3.5"/><path d="M10.2 9.2v5.6l4.8-2.8z" fill="currentColor"/>'),
  edit: S('<path d="m14.5 5.5 4 4L8.5 19.5H4.5v-4z"/><path d="m12.5 7.5 4 4"/>'),
  trash: S('<path d="M5 7h14M10 7V4.8h4V7M6.5 7l.9 12.2h9.2L17.5 7"/>'),
  check: S('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  share: S('<path d="M12 3.5v12M7.5 8 12 3.5 16.5 8"/><path d="M5 12.5v6.5h14v-6.5"/>'),
  download: S('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>'),
  upload: S('<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 19.5h14"/>'),
  cloud: S('<path d="M7.5 18.5h9.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 11a3.75 3.75 0 0 0 .5 7.5Z"/>'),
  cloudOff: S('<path d="M7.5 18.5h9.5M18.9 17.4A4 4 0 0 0 17.6 10.55 5.5 5.5 0 0 0 9.2 7M6.3 9.5A3.75 3.75 0 0 0 7.5 18.5"/><path d="m4 4 16 16"/>'),
  sync: S('<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3.5v3.6h-3.6M6.5 20.5v-3.6h3.6"/>'),
  list: S('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1.1" fill="currentColor"/><circle cx="4.8" cy="12" r="1.1" fill="currentColor"/><circle cx="4.8" cy="17.5" r="1.1" fill="currentColor"/>'),
  sort: S('<path d="M7 5v14M4 16l3 3 3-3"/><path d="M13 7h7M13 12h5M13 17h3"/>'),
  key: S('<circle cx="8" cy="15" r="3.8"/><path d="m10.8 12.2 8-8M16 7l2.5 2.5M14 9l1.8 1.8"/>'),
  lock: S('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  user: S('<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
  info: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>'),
  mic: S('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>'),
  volume: S('<path d="M4.5 9.5h3.5L13 5v14l-5-4.5H4.5z"/><path d="M16.5 9a4.2 4.2 0 0 1 0 6M19 6.5a7.7 7.7 0 0 1 0 11"/>'),
  link: S('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>'),
  eye: S('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: S('<path d="M10 5.7A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.6M6.4 7.3C3.8 9 2.5 12 2.5 12S6 18.5 12 18.5a8.7 8.7 0 0 0 4-1M3.5 3.5l17 17"/>'),
  fullscreen: S('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  moon: S('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/>'),
  sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
  wand: S('<path d="m5 19 9.5-9.5M13 6l1-2.5L15 6l2.5 1-2.5 1-1 2.5-1-2.5-2.5-1zM18.5 12.5l.6-1.5.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6z"/>'),
  guitar: S('<path d="m14 10 6.5-6.5M18.2 3.6l2.2 2.2"/><path d="M13.5 10.5a3 3 0 0 0-4.6.7 2.6 2.6 0 0 1-2.4 1.2A3.5 3.5 0 0 0 4 18.2 3.6 3.6 0 0 0 5.8 20a3.5 3.5 0 0 0 5.8-2.5 2.6 2.6 0 0 1 1.2-2.4 3 3 0 0 0 .7-4.6Z"/><circle cx="9.3" cy="14.7" r="1.2"/>'),
  note: S('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
  import: S('<path d="M4 13.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-5.5"/><path d="M12 3.5v11M7.5 10 12 14.5 16.5 10"/>'),
  clock: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  repeat: S('<path d="M17 3.5 20 6.5l-3 3"/><path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20M7 20.5 4 17.5l3-3"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/>'),
  hand: S('<path d="M8 11.5V5.8a1.6 1.6 0 0 1 3.2 0V11M11.2 10.5V4.6a1.6 1.6 0 0 1 3.2 0V11M14.4 10.5V6a1.6 1.6 0 0 1 3.2 0v8.5a6 6 0 0 1-6 6h-.8a6 6 0 0 1-4.9-2.6l-2.4-3.6a1.6 1.6 0 0 1 2.6-1.8L8 14.5"/>'),
};

export function icon(name, { size, cls } = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = ICONS[name] || ICONS.info;
  const svg = tpl.content.firstChild;
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); svg.style.width = svg.style.height = `${size}px`; }
  svg.setAttribute('class', cls ? `ic ${cls}` : 'ic');
  return svg;
}

export function iconButton(name, label, onClick, { cls = '', pressed } = {}) {
  const b = h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), 'aria-label': label, title: label, onClick }, icon(name));
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(!!pressed));
  return b;
}

export function button(label, onClick, { cls = '', iconName, type = 'button', disabled } = {}) {
  return h('button', { type, class: `btn ${cls}`.trim(), onClick, disabled }, iconName ? icon(iconName) : null, label);
}

// ---------- drawers (bottom sheets on phones, dialogs on wide screens) ----------

const stack = [];

export function drawer({ title, body, cls = '', onClose, actions } = {}) {
  const prevFocus = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const panel = h('div', { class: `drawer ${cls}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog', tabindex: '-1' });
  const close = () => {
    if (!panel.isConnected) return;
    scrim.remove();
    panel.remove();
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
  };
  const onKey = e => {
    if (e.key === 'Escape' && stack.at(-1) === api) { e.stopPropagation(); e.preventDefault(); close(); }
  };
  const head = title !== undefined ? h('div', { class: 'drawer-head' }, h('h2', {}, title), actions || null, iconButton('close', 'Close', close)) : null;
  fill(panel, h('div', { class: 'drawer-grip' }), head, body);
  scrim.addEventListener('click', close);
  dragToClose(panel, close);
  document.body.append(scrim, panel);
  document.addEventListener('keydown', onKey, true);
  const api = { panel, close, set(...nodes) { fill(panel, h('div', { class: 'drawer-grip' }), head, nodes); } };
  stack.push(api);
  requestAnimationFrame(() => { if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true }); });
  return api;
}

export const closeAllDrawers = () => [...stack].reverse().forEach(d => d.close());
export const drawerOpen = () => stack.length > 0;

// Pull a bottom sheet down by its grip or header to close it.
function dragToClose(panel, close) {
  let y0 = null, dy = 0;
  panel.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || innerWidth >= 700) return;
    if (!e.target.closest('.drawer-grip, .drawer-head') || e.target.closest('button, input, select')) return;
    y0 = e.clientY;
    dy = 0;
    panel.setPointerCapture(e.pointerId);
  });
  panel.addEventListener('pointermove', e => {
    if (y0 === null) return;
    dy = Math.max(0, e.clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 === null) return;
    y0 = null;
    if (dy > 90) close();
    else panel.style.transform = '';
  };
  panel.addEventListener('pointerup', end);
  panel.addEventListener('pointercancel', end);
}

export function confirmSheet(title, message, { confirm = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); d.close(); } };
    const d = drawer({
      title,
      body: [
        h('p', { style: { margin: '0 0 18px', color: 'var(--ink-2)' } }, message),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
          button(cancel, () => finish(false), { cls: 'btn-ghost' }),
          button(confirm, () => finish(true), { cls: danger ? 'btn-danger' : 'btn-primary' })),
      ],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}

export function promptSheet(title, { label = '', value = '', placeholder = '', confirm = 'Save', type = 'text', hint } = {}) {
  return new Promise(resolve => {
    let done = false;
    const input = h('input', { class: 'input', type, value, placeholder, 'aria-label': label || title, autocapitalize: 'sentences' });
    const finish = v => { if (!done) { done = true; resolve(v); d.close(); } };
    const form = h('form', { onSubmit: e => { e.preventDefault(); finish(input.value); } },
      label ? h('label', { class: 'field' }, h('span', {}, label), input) : input,
      hint ? h('p', { class: 'hint' }, hint) : null,
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' } },
        button('Cancel', () => finish(null), { cls: 'btn-ghost' }),
        button(confirm, null, { cls: 'btn-primary', type: 'submit' })));
    const d = drawer({ title, body: form, onClose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

// ---------- toasts ----------

let toastRoot = null;
export function toast(message, { action, onAction, ms = 3800 } = {}) {
  toastRoot ||= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: 'toast' }, h('span', {}, message));
  let timer;
  const close = () => { clearTimeout(timer); t.remove(); };
  if (action) t.append(h('button', { type: 'button', onClick: () => { close(); onAction && onAction(); } }, action));
  toastRoot.append(t);
  while (toastRoot.children.length > 3) toastRoot.firstChild.remove();
  timer = setTimeout(close, ms);
  return close;
}

// ---------- swipe a row left to delete ----------

export function swipeToDelete(row, { label = 'Delete', onDelete }) {
  const wrap = h('div', { class: 'swipe' }, h('div', { class: 'swipe-under', 'aria-hidden': 'true' }, label), row);
  let x0 = null, y0 = 0, dx = 0, locked = null;
  row.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; locked = null;
  });
  row.addEventListener('pointermove', e => {
    if (x0 === null) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (locked === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) locked = Math.abs(mx) > Math.abs(my) * 1.3 && mx < 0 ? 'x' : 'y';
    if (locked !== 'x') return;
    dx = Math.min(0, mx);
    wrap.classList.add('dragging');
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null;
    wrap.classList.remove('dragging');
    if (locked === 'x' && -dx > row.offsetWidth * 0.38) {
      row.style.transform = 'translateX(-100%)';
      row.dataset.swiped = '1';
      setTimeout(() => onDelete(), 180);
    } else {
      row.style.transform = '';
    }
    if (locked === 'x') {
      // swallow the click that follows a swipe
      row.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
    }
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
  return wrap;
}

// ---------- small things ----------

export function toggle(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('span', { class: 'toggle' }, input, h('span'));
}

export function seg(options, value, onChange, { label } = {}) {
  const root = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const draw = v => {
    root.replaceChildren(...options.map(([id, text]) => h('button', {
      type: 'button', 'aria-pressed': String(id === v), onClick: () => { draw(id); onChange(id); },
    }, text)));
  };
  draw(value);
  return root;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function parseTime(s) {
  const m = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(String(s || ''));
  if (!m) return null;
  return m[2] === undefined ? +m[1] * 60 : +m[1] * 60 + +m[2];
}

export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const d = Math.round((now - t) / 1000);
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function initials(s) {
  const w = String(s || '').replace(/^the\s+/i, '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase() || '♪';
}
