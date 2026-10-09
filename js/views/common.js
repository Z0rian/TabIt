// Bits shared by several screens.

import { h, icon, relTime, fill } from '../ui.js';
import { store, subscribe, syncNow, signedIn, pendingCount } from '../store.js';

// The little sync indicator in page headers. Tapping it syncs now (or opens
// Settings when sync isn't set up).
export function syncPill() {
  const pill = h('button', { type: 'button', class: 'pill', 'aria-live': 'polite' });
  const draw = () => {
    const s = store.sync;
    let dot = '', text = '', title = '';
    if (!signedIn()) { dot = ''; text = 'This device'; title = 'Songs are saved on this device. Sign in to sync them.'; }
    else if (s.state === 'saving') { dot = 'busy'; text = 'Syncing'; }
    else if (s.state === 'pending') { dot = 'busy'; text = `${pendingCount()} to sync`; }
    else if (s.state === 'offline') { dot = ''; text = 'Offline'; title = s.message; }
    else if (s.state === 'error') { dot = 'err'; text = 'Sync problem'; title = s.message; }
    else { dot = 'ok'; text = 'Synced'; title = s.at ? `Last synced ${relTime(s.at)}` : ''; }
    fill(pill, h('span', { class: `status-dot ${dot}` }), text);
    pill.title = title;
    pill.setAttribute('aria-label', `${text}. ${title}`);
  };
  pill.addEventListener('click', () => {
    if (!signedIn()) location.hash = '#/settings';
    else if (store.sync.state === 'error') location.hash = '#/settings';
    else syncNow();
  });
  // a pill that has left the page stops listening at the next update
  let seen = false;
  const unsub = subscribe(() => {
    if (pill.isConnected) seen = true;
    else if (seen) { unsub(); return; }
    draw();
  });
  draw();
  return pill;
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function offlineNote() {
  return navigator.onLine === false ? h('p', { class: 'offline-badge' }, icon('cloudOff', { size: 16 }), 'Offline: your library still works') : null;
}
