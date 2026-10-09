"""The tuner screen with a known signal as its microphone: a synthesized plucked
A string (harmonics, the 2nd louder than the fundamental, decay, re-plucked
every 3 s, a little noise), in tune and then 30 cents sharp. The note must
read A2, the needle must sit still (the quarter-second low-pass), and the hint
must say which way to turn the peg.

    python tests/e2e_tuner.py
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

from util import ROOT, start_server

OUT = os.path.join(ROOT, 'tests', 'out')

# getUserMedia replaced by a Web Audio stream playing the synthesized string
FAKE_MIC = """(freq) => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext();
    const sr = ac.sampleRate, n = Math.round(sr * 12);
    const buf = ac.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, tp = t % 3;
      const env = Math.exp(-tp * 1.1) * Math.min(1, tp * 200);
      // a slight vibrato (about ±1 cent), with the phase accumulated so it stays slight
      phase += 2 * Math.PI * freq * (1 + 0.0006 * Math.sin(2 * Math.PI * 5 * t)) / sr;
      let x = 0;
      for (const [k, a] of [[1, 0.55], [2, 0.9], [3, 0.45], [4, 0.3], [5, 0.15]]) x += a * Math.sin(k * phase + k);
      d[i] = x * env * 0.3 + rnd() * 0.02;
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    return dest.stream;
  };
}"""

NEEDLE = """() => {
  const n = document.querySelector('.meter .needle');
  const m = /rotate[(]([-0-9.e]+)/.exec(n.getAttribute('transform') || '');
  return { angle: m ? +m[1] : 0, note: document.querySelector('.tuner-note').textContent, cents: document.querySelector('.tuner-cents').textContent, hint: document.querySelector('.tuner-hint').textContent, inTune: document.querySelector('.tuner').classList.contains('in-tune') };
}"""


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ✓', msg)


def run(base, freq, label):
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', args=['--autoplay-policy=no-user-gesture-required'])
        page = b.new_context(viewport={'width': 400, 'height': 860}).new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base + '/#/tuner')
        page.evaluate(FAKE_MIC, freq)
        page.get_by_role('button', name='Start tuner').click()
        page.wait_for_function("document.querySelector('.tuner-note').textContent !== '–'", timeout=15000)
        time.sleep(0.8)
        samples = []
        for _ in range(60):
            samples.append(page.evaluate(NEEDLE))
            time.sleep(1 / 30)
        print(f'[{label}] {samples[-1]}')
        os.makedirs(OUT, exist_ok=True)
        page.screenshot(path=os.path.join(OUT, f'tuner-{label}.png'))
        b.close()
        if errors:
            raise AssertionError(errors)
        notes = {s['note'] for s in samples}
        check(notes == {'A2'}, f'reads A2 the whole time ({notes})')
        angles = [s['angle'] for s in samples]
        mean = sum(angles) / len(angles)
        sd = (sum((a - mean) ** 2 for a in angles) / len(angles)) ** 0.5
        check(sd < 1.2, f'the needle holds still: ±{sd:.2f}° over 2 s (the dial spans ±60°)')
        return samples, mean


def main():
    base = start_server()
    s, mean = run(base, 110.0, 'in-tune')
    check(abs(mean) < 4, f'in tune: needle in the middle ({mean:.1f}°)')
    check(any(x['inTune'] for x in s[-20:]), 'shows the green "in tune" state')
    s, mean = run(base, 110.0 * 2 ** (30 / 1200), 'sharp')
    check(30 <= mean <= 42, f'30 cents sharp: needle at {mean:.1f}° (36° expected)')
    check(s[-1]['hint'] == 'Tune down a little', f'says to tune down ({s[-1]["hint"]})')
    print('The tuner reads steady.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
