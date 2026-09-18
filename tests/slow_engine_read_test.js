#!/usr/bin/env node
/* A slow engine read that WORKS must still work — the 43-second loadingquotes answer.
 *
 *   RUN:  node tests/slow_engine_read_test.js   (no deps, no network; needs ../greencross-gx-theme)
 *
 * EXECUTES the real engineGet (sliced from index.html at `@test-slice engineGet`) on top of the REAL
 * shared gx-client.js, on a virtual clock, against a fake engine. Neither half is a stub of the other:
 * the regression lived exactly in the seam between them. gx-client's getJSON aborts each attempt at
 * 20s unless told otherwise; engineGet allowed 45s but never said so, so a 43s answer was aborted at
 * 20s, re-sent, aborted again, and could never arrive.
 *
 * §2 re-runs the 43s case with the fix stripped out and REQUIRES it to fail. Without that, a green
 * §1 could be the fixture being too easy rather than the code being right.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const clientPath = path.resolve(__dirname, '../../greencross-gx-theme/gx-client.js');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}

const m = src.match(/@test-slice engineGet[\s\S]*?\*\/\s*([\s\S]*?)\/\* @test-slice end \*\//);
if (!m) { console.error('LOAD FAILED: the `@test-slice engineGet` sentinels are gone from index.html.'); process.exit(2); }
const FIX = ', { timeoutMs: ceilingMs }';
if (!m[1].includes(FIX)) {
  console.log('  FAIL engineGet no longer passes its ceiling to getJSON as timeoutMs');
  process.exit(1);
}
if (!fs.existsSync(clientPath)) {
  console.log('SKIP greencross-gx-theme not checked out beside this repo — the real client cannot be exercised');
  process.exit(0);
}
const clientSrc = fs.readFileSync(clientPath, 'utf8');

/* Virtual clock: timers run in time order, microtasks drain between them, so 45 "seconds" take ~0ms. */
function run(slice, engine) {
  let now = 0, seq = 0;
  const timers = new Map();
  const setT = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; };
  const clrT = (id) => { timers.delete(id); };
  const calls = [];
  const fetchImpl = (url, init) => {
    const call = { at: now };
    calls.push(call);
    return new Promise((resolve, reject) => {
      const signal = init && init.signal;
      const answer = engine(calls.length);
      if (answer.hang !== true) {
        setT(() => { call.answeredAt = now; resolve({ ok: true, status: 200, text: async () => answer.body }); }, answer.afterMs);
      }
      if (signal) signal.addEventListener('abort', () => {
        call.abortedAt = now;
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    });
  };
  const box = { setTimeout: setT, clearTimeout: clrT, fetch: fetchImpl, AbortController, console, Math, Date,
                encodeURIComponent, URL, URLSearchParams, JSON, Error, Promise };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(clientSrc, box);
  vm.runInContext(
    'const PROXY_URL = "https://engine.test/exec";\n' +
    'const _ENGINE = GXClient(PROXY_URL, { retries: 2, backoffMs: 400 });\n' +   // index.html's own options
    'function addAuthParams(p) { return { ...p, token: "t" }; }\n' +
    'function proxyUrl(p) { return PROXY_URL; }\n' + slice + '\nthis.engineGet = engineGet;', box);

  let settled = null;
  box.engineGet({ action: 'loadingquotes' })
    .then(v => { settled = { value: v, at: now }; }, e => { settled = { error: e, at: now }; });

  return (async () => {
    for (let i = 0; i < 500 && !settled; i++) {
      for (let k = 0; k < 20; k++) await new Promise(r => setImmediate(r));
      if (settled || !timers.size) break;
      const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id); now = t.at; t.fn();
    }
    for (let k = 0; k < 20; k++) await new Promise(r => setImmediate(r));
    return { settled, calls };
  })();
}

const GOOD = '{"ok":true,"quotes":[["a","b"]]}';

(async () => {
  console.log('\n1. with the fix');
  {
    const { settled, calls } = await run(m[1], () => ({ afterMs: 43000, body: GOOD }));
    ok(settled && settled.value && settled.value.ok === true,
       'a 43-second answer is RETURNED, not timed out', settled && (settled.error ? settled.error.message : 'at ' + settled.at + 'ms'));
    ok(calls.length === 1, 'and the server ran it ONCE — no abort-and-resend (' + calls.length + ' sends)');
  }
  {
    const { settled, calls } = await run(m[1], () => ({ hang: true }));
    ok(settled && settled.error && /Engine request \(loadingquotes\) timed out/.test(settled.error.message) && settled.at === 45000,
       'a call that NEVER answers still fails, at the 45s ceiling', settled && ((settled.error || {}).message + ' at ' + settled.at + 'ms'));
    ok(calls.length === 1 && calls[0].abortedAt === 45000, 'and its request is actually aborted, not left open');
  }
  {
    const { settled, calls } = await run(m[1], (n) => n === 1
      ? { afterMs: 2000, body: '<!DOCTYPE html><html>Drive</html>' } : { afterMs: 3000, body: GOOD });
    ok(settled && settled.value && settled.value.ok === true && calls.length === 2,
       'a fast Drive-HTML bounce is still retried inside the budget (' + calls.length + ' sends)');
  }

  console.log('\n2. the fixture catches the bug (fix stripped — this MUST fail)');
  {
    const { settled, calls } = await run(m[1].replace(FIX, ''), () => ({ afterMs: 43000, body: GOOD }));
    ok(settled && settled.error && calls.length >= 2 && calls[0].abortedAt === 20000,
       'without timeoutMs the 43s answer is aborted at 20s and re-sent — the regression, reproduced',
       settled && (settled.error ? settled.error.message : 'unexpectedly succeeded') + ', ' + calls.length + ' sends');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
