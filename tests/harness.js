// A tiny test framework for the browser. Test files call test(); tests/unit.html
// imports every file listed in tests/all.js, runs them and publishes the result
// on window.__results for tests/run_unit.py (Playwright, Edge + WebKit).

const tests = [];
let currentFile = '';

export function setFile(name) { currentFile = name; }

export function test(name, fn) {
  tests.push({ name, fn, file: currentFile });
}

export class AssertionError extends Error {}

const show = v => {
  try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (x instanceof Set ? [...x] : x)); } catch { return String(v); }
};

export function ok(v, msg = 'expected a truthy value') {
  if (!v) throw new AssertionError(msg);
}

export function eq(actual, expected, msg = '') {
  if (!Object.is(actual, expected)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`);
}

export function near(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${expected} ± ${tol}, got ${actual}`);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every(x => b.has(x));
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

export function deepEq(actual, expected, msg = '') {
  if (!deepEqual(actual, expected)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`);
}

export async function throws(fn, msg = 'expected an error') {
  try { await fn(); } catch { return; }
  throw new AssertionError(msg);
}

export async function run({ filter = '' } = {}) {
  const results = { passed: 0, failed: 0, failures: [], durationMs: 0, count: 0 };
  const t0 = performance.now();
  for (const t of tests) {
    if (filter && !`${t.file} ${t.name}`.toLowerCase().includes(filter.toLowerCase())) continue;
    results.count++;
    try {
      await t.fn();
      results.passed++;
    } catch (e) {
      results.failed++;
      results.failures.push({ file: t.file, name: t.name, error: String(e && e.message || e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : '' });
    }
  }
  results.durationMs = Math.round(performance.now() - t0);
  return results;
}
