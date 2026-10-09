// The strumming pattern at the top of a song, the way Ultimate Guitar shows
// it: arrows with the count under them, the author's patterns to choose from,
// and Play, which strums the pattern in time on the song's first chord.

import { h, icon, fill } from '../ui.js';
import { bars, slotsPerBeat, strokeOf } from '../strum.js';
import { strum, unlockAudio, audioTime, hasAudio } from '../audio.js';

const svg = markup => {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstChild;
};
const ARROWS = {
  down: '<svg viewBox="0 0 12 24" aria-hidden="true"><path d="M6 2.5v18M1.8 16.3 6 20.5l4.2-4.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 12 24" aria-hidden="true"><path d="M6 21.5v-18M1.8 7.7 6 3.5l4.2 4.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hit: '<svg viewBox="0 0 12 24" aria-hidden="true"><path d="M1.5 7.5l9 9M10.5 7.5l-9 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};

const WORDS = { down: 'down', up: 'up', hit: 'muted hit', rest: 'rest' };
const describe = p => p.m.map(c => {
  const s = strokeOf(c);
  return WORDS[s.dir] + (s.mark === 'mute' ? ' (muted)' : s.mark === 'accent' ? ' (accent)' : '');
}).join(', ');

// patterns: song.strum. chord(): { frets } to strum (or null), tuning(): MIDI notes.
export function strumCard(patterns, { chord, tuning }) {
  const card = h('section', { class: 'strum', 'aria-label': 'Strumming pattern' });
  let current = 0;
  let player = null;

  function draw() {
    const p = patterns[current];
    const pick = patterns.length > 1
      ? h('select', { class: 'strum-pick', 'aria-label': 'Which pattern', onChange: e => { stop(); current = +e.target.value; draw(); } },
        ...patterns.map((x, i) => h('option', { value: String(i), selected: i === current }, x.part || `Pattern ${i + 1}`)))
      : p.part ? h('span', { class: 'strum-part' }, p.part) : null;
    const stroke = s => h('span', { class: `stroke ${s.dir}${s.mark ? ` ${s.mark}` : ''}`, 'data-i': String(s.i) },
      h('span', { class: 'mk' }, s.mark === 'mute' ? '×' : s.mark === 'accent' ? '>' : ''),
      ARROWS[s.dir] ? svg(ARROWS[s.dir]) : h('i', { class: 'rest-dot' }),
      h('small', {}, s.count));
    const beat = b => h('div', { class: 'strum-beat' }, ...b.map(stroke));
    // a bar of four beats breaks in the middle, if it has to break
    const halves = bar => (bar.length === 4 ? [bar.slice(0, 2), bar.slice(2)] : [bar]);
    const row = h('div', { class: 'strum-row', role: 'img', 'aria-label': describe(p) },
      ...bars(p).map(bar => h('div', { class: 'strum-bar' },
        ...halves(bar).map(half => h('div', { class: 'strum-half' }, ...half.map(beat))))));
    fill(card,
      h('div', { class: 'strum-head' },
        h('span', { class: 'strum-title' }, 'Strumming'), pick,
        h('span', { class: 'strum-bpm' }, p.bpm ? `${p.bpm} bpm` : ''),
        h('button', { type: 'button', class: 'strum-play', 'aria-label': player ? 'Stop the strumming pattern' : 'Play the strumming pattern', 'aria-pressed': String(!!player), onClick: toggle }, icon(player ? 'pause' : 'play'))),
      row);
  }

  function light(i) {
    for (const e of card.querySelectorAll('.stroke.on')) e.classList.remove('on');
    if (i >= 0) card.querySelector(`.stroke[data-i="${i}"]`)?.classList.add('on');
  }

  function toggle() {
    if (player) { stop(); return; }
    unlockAudio();
    player = play(patterns[current]);
    draw();
  }

  function stop() {
    if (!player) return;
    player.stop();
    player = null;
    light(-1);
    draw();
  }

  // Strokes are scheduled a moment ahead on the audio clock, so the timing
  // holds even when the page is busy; the highlight follows on a timer.
  function play(p) {
    const clock = hasAudio() ? audioTime : () => performance.now() / 1000;
    const slot = 60 / (p.bpm || 90) / slotsPerBeat(p);
    let next = clock() + 0.1;
    let i = 0;
    const timers = new Set();
    const tick = () => {
      const now = clock();
      while (next < now + 0.12) {
        const k = i % p.m.length;
        const s = strokeOf(p.m[k]);
        const v = chord();
        if (v && s.dir !== 'rest') {
          strum(v, {
            tuning: tuning(), at: next, direction: s.dir === 'up' ? 'up' : 'down',
            short: s.mark === 'mute' || s.dir === 'hit', spread: s.dir === 'hit' ? 0.004 : s.dir === 'up' ? 0.016 : 0.022,
            volume: s.mark === 'accent' ? 0.85 : s.dir === 'hit' ? 0.45 : 0.55,
          });
        }
        const t = setTimeout(() => { timers.delete(t); light(k); }, Math.max(0, (next - now) * 1000));
        timers.add(t);
        next += slot;
        i++;
      }
    };
    tick();
    const iv = setInterval(tick, 25);
    return { stop() { clearInterval(iv); timers.forEach(clearTimeout); } };
  }

  const onHide = () => { if (document.visibilityState === 'hidden') stop(); };
  document.addEventListener('visibilitychange', onHide);
  draw();
  card.destroy = () => { stop(); document.removeEventListener('visibilitychange', onHide); };
  return card;
}
