#!/usr/bin/env node
/* ─── Sign-in lifetime — tests ────────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/auth_ttl_test.js     (from the repo root; no deps, no network, no credentials)
 *
 * WHY
 * Sky, 2026-11-23: "my computers are private, 30 days is okay." A saved sign-in now lasts 30 days
 * instead of 7. This pins three things that would each quietly undo that:
 *
 *   1. GC_AUTH_TTL is 30 days.
 *   2. _authValid() actually honors it: a session saved 29 days ago is still signed in, one saved
 *      31 days ago is not, and a session with no token is never valid.
 *   3. The session lives in localStorage. Moving it to sessionStorage would sign everyone out every
 *      time they close the tab, whatever the TTL says.
 *
 * The constant and the function are lifted out of the shipped index.html by text match and run
 * against a stub localStorage. If extraction stops matching, the test exits 2 rather than passing
 * vacuously.
 */
'use strict';
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');

function lift(pattern, what) {
  const m = html.match(pattern);
  if (!m) {
    console.error('EXTRACTION FAILED: could not find ' + what + ' in index.html.');
    process.exit(2);
  }
  return m[0];
}

const ttlSrc   = lift(/const GC_AUTH_TTL = [^;]+;/, 'GC_AUTH_TTL');
const bypassSrc = lift(/function _isLocalDevAuthBypass\(\) \{[\s\S]*?\n\}/, '_isLocalDevAuthBypass');
const validSrc = lift(/function _authValid\(\) \{[\s\S]*?\n\}/, '_authValid');

const store = {};
const localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const GC_AUTH_KEY = 'gc_inv_auth';
// eslint-disable-next-line no-new-func
const mod = new Function('localStorage', 'GC_AUTH_KEY',
  ttlSrc + '\n' + bypassSrc + '\n' + validSrc + '\nreturn { GC_AUTH_TTL, _authValid };')(localStorage, GC_AUTH_KEY);

let failed = 0;
function check(name, cond) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
  if (!cond) failed++;
}

const DAY = 24 * 60 * 60 * 1000;
check('GC_AUTH_TTL is 30 days', mod.GC_AUTH_TTL === 30 * DAY);

function saveAgo(days, token) {
  localStorage.setItem(GC_AUTH_KEY, JSON.stringify({ user: 'x', token: token, ts: Date.now() - days * DAY }));
}
saveAgo(0, 't');   check('fresh session is valid', mod._authValid() === true);
saveAgo(8, 't');   check('8-day-old session is still valid (old 7-day cap gone)', mod._authValid() === true);
saveAgo(29, 't');  check('29-day-old session is valid', mod._authValid() === true);
saveAgo(31, 't');  check('31-day-old session is expired', mod._authValid() === false);
saveAgo(0, '');    check('session without a token is never valid', mod._authValid() === false);
localStorage.removeItem(GC_AUTH_KEY);
check('no saved session is not valid', mod._authValid() === false);

check('dev auth bypass is off', /return false;/.test(bypassSrc));
check('the session is read from localStorage', /localStorage\.getItem\(GC_AUTH_KEY\)/.test(validSrc));
check('nothing stores the session in sessionStorage', !/sessionStorage\.(get|set)Item\((GC_AUTH_KEY|LS\.AUTH)/.test(html));

if (failed) { console.error('\n' + failed + ' check(s) failed.'); process.exit(1); }
console.log('\nall sign-in lifetime checks passed.');
