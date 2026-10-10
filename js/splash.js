// The loading screen: the logo, a pick strumming six strings, and a pun. It's
// in index.html already, so it shows before any code has loaded; this fills in
// the pun (another every couple of seconds on a slow start) and fades it all
// away once the app is ready underneath, but not before there was time to
// read it.
//
// Settings → Look turns the pun off (then it goes as soon as the app is ready),
// and so does testing locally, unless the page asks with ?splash.

import { pun } from './puns.js';

const READ_MS = 1300; // from the moment the page started loading
const NEXT_MS = 2400;

const root = document.getElementById('root');
const text = root?.querySelector('.splash-pun');
const local = ['localhost', '127.0.0.1'].includes(location.hostname) && !new URLSearchParams(location.search).has('splash');
let wanted = true;
try { wanted = (JSON.parse(localStorage.getItem('tabit.prefs')) || {}).splash !== false; } catch { /* default */ }
const minMs = wanted && !local ? READ_MS : 0;

let timer = null;
function say(words) {
  if (!text) return;
  text.classList.remove('in');
  void text.offsetWidth; // restart the fade
  text.textContent = words;
  text.classList.add('in');
}
if (root && wanted) {
  say(pun());
  timer = setInterval(() => say(pun()), NEXT_MS);
}

// The app is drawn: let the screen go (after the reading time).
export function hideSplash() {
  if (!root?.classList.contains('splash')) return;
  const wait = Math.max(0, minMs - performance.now());
  setTimeout(() => {
    clearInterval(timer);
    root.classList.add('out');
    root.setAttribute('aria-busy', 'false');
    const done = () => root.remove();
    root.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 600); // (no transition with reduced motion)
  }, wait);
}

// TabIt couldn't start: the screen stays, to show why.
export function stopSplash() {
  clearInterval(timer);
  root?.classList.add('stopped');
}
