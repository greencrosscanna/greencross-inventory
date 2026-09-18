#!/usr/bin/env node
/* No fetch in this app can wait forever, and no write to the engine is ever re-sent.
 *
 *   RUN:  node tests/bounded_fetch_test.js   (no deps, no network, no DOM)
 *
 * A browser fetch has no deadline. When /exec stalls it does not fail — it never answers — so
 * the hide/retire/flag syncs, the barcode save, the shared-state poll and the Price Tags badge
 * could all hang silently. Sales fixed the same class in v2.608; this is Inventory's half.
 *
 * §1 EXECUTES the real helpers, sliced from index.html at `@test-slice boundedFetch`, against a
 * fetch that settles only when ABORTED — so it proves the deadline ends a hung request rather than
 * asserting that a comment says so. §2 counts call sites: a new bare fetch anywhere fails here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}

const m = src.match(/@test-slice boundedFetch[\s\S]*?\*\/\s*([\s\S]*?)\/\* @test-slice end \*\//);
if (!m) {
  console.error('LOAD FAILED: the `@test-slice boundedFetch` sentinels are gone from index.html.');
  process.exit(2);
}

// setTimeout fires at once, so every deadline expires immediately. A fetch that ignores its signal
// would then still hang; one that honors it rejects — which is exactly the property under test.
function build(fetchImpl, warn) {
  return new Function('fetch', 'setTimeout', 'clearTimeout', 'console', 'ENGINE_CEILING_MS',
    m[1] + '\n; return { boundedFetch_, engineWriteOnce_ };')(
    fetchImpl, (fn) => { fn(); return 0; }, () => {}, { warn: warn || (() => {}) }, 45000);
}
function hangsUntilAborted(counter) {
  return (url, init) => { counter.n++; return new Promise((_, rej) => {
    const die = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
    if (init && init.signal) { if (init.signal.aborted) die(); else init.signal.addEventListener('abort', die); }
  }); };
}

/* If a deadline stops working, the stub below never settles, node runs out of work and exits 0 with
   nothing printed — a green run on exactly the bug this file exists for. This turns that into a FAIL. */
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) { console.log('  FAIL a request never settled — a deadline did not fire'); process.exitCode = 1; }
});

(async () => {
  console.log('\n1. the deadline ends a request that never answers');
  {
    const c = { n: 0 };
    const { boundedFetch_ } = build(hangsUntilAborted(c));
    let err = null;
    try { await boundedFetch_('https://e/exec?action=queueCount', 20000); } catch (e) { err = e; }
    ok(err && /timed out after 20000ms/.test(err.message), 'a hung read rejects with a named timeout', err && err.message);
  }
  {
    const c = { n: 0 }, warned = [];
    const { engineWriteOnce_ } = build(hangsUntilAborted(c), (...a) => warned.push(a.join(' ')));
    engineWriteOnce_('https://e/exec?action=sharedflag&key=k', 'sharedflag');
    await new Promise(r => setImmediate(r));
    ok(c.n === 1, 'a hung WRITE is sent exactly once — sharedflag is a toggle, a re-send un-flags it (' + c.n + ')');
    ok(warned.some(w => /sharedflag not confirmed/.test(w)), 'and the lost answer is logged, not swallowed', JSON.stringify(warned));
  }
  {
    const warned = [];
    const { engineWriteOnce_ } = build(() => { throw new Error('GXDev: write blocked'); }, (...a) => warned.push(a.join(' ')));
    let threw = false;
    try { engineWriteOnce_('https://e/exec?action=sharedkill', 'sharedkill'); } catch { threw = true; }
    ok(!threw && warned.length === 1, "a SYNCHRONOUS throw (gx-dev.js's write block) is contained, so the caller still re-renders");
  }
  {
    const { boundedFetch_ } = build(async () => ({ ok: true, text: async () => '{"ok":true,"count":3}' }));
    const r = await boundedFetch_('u', 20000);
    ok(r.res.ok === true && JSON.parse(r.text).count === 3, 'a healthy answer passes through untouched');
  }

  console.log('\n2. no bare fetch remains');
  /* Exactly two fetch( calls: the one inside boundedFetch_, and engineGet's no-GXClient fallback,
     which is wrapped in withTimeout. A third is a call site that skipped both. */
  const calls = (src.match(/\bfetch\(/g) || []).length;
  ok(calls === 2, 'index.html has exactly two fetch( calls, both inside a deadline', 'found ' + calls);
  ok(/withTimeout\(fetch\(proxyUrl\(params\)\)/.test(src), "and the second is engineGet's bounded fallback");
  ok(!/\.catch\(\(\) => \{\}\);/.test(src.slice(src.indexOf('function killItem'), src.indexOf('function killItem') + 400)),
     'the hide sync no longer swallows its failure');
  ok(/await engineGet\(state\.betaEnabled \? \{ action: 'getstate'/.test(src),
     'the shared-state poll is a read on the bounded read path');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  finished = true;
  process.exit(fail ? 1 : 0);
})();
