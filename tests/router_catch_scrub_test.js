#!/usr/bin/env node
/* The ROUTER'S catch must not print a secret to the screen (2026-09-15).
 *
 * doGet's top-level catch used to return `{ error: err.message, stack: err.stack }`. That is only a
 * formatting choice until a handler THROWS a UrlFetchApp failure rather than catching it: Google's
 * message for one is "Address unavailable: <the whole url>", query string and all. This app fetches
 * GX Core with `connector_secret=` in the query string (getDutchieStoreKeys_, which does not catch),
 * and that secret is the one that trades for every store's live Dutchie key. One DNS blip put it in
 * an error banner. Reported by core-admin after SPIFF fixed the same shape in its own router.
 *
 * WHY THIS TEST IS SHAPED THE WAY IT IS. SPIFF's first attempt at this test passed while the bug was
 * live: it grepped the WHOLE FILE for the scrub and matched a call inside a different function — a
 * green gate that never opened the catch it was named for. So every assertion here is scoped to the
 * text of doGet's own catch block, extracted by brace matching, and the scrub itself is EXECUTED
 * against a real Google failure message rather than merely being present.
 *
 * Proven red both ways before being committed: restoring `stack: err.stack` fails §1, and removing
 * the scrubSecrets_ wrapper fails §1 and §3.
 */
'use strict';
const fs = require('fs'), path = require('path');
const REPO = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(REPO, 'dutchie_proxy.gs'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  ✗   ' + label); }
}

/* Pull out the catch that belongs to doGet, and nothing else. Brace-matched from the `catch` that
   closes doGet's top-level try, so a scrub living in some other function cannot satisfy §1. */
function routerCatchBody() {
  const start = code.indexOf('function doGet(e) {');
  if (start < 0) throw new Error('doGet not found');
  const at = code.indexOf('\n  } catch (err) {', start);
  if (at < 0) throw new Error("doGet's top-level catch not found");
  const open = code.indexOf('{', at + 3);
  let depth = 0, i = open;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) break; }
  }
  return code.slice(open + 1, i);
}
const CATCH = routerCatchBody();

console.log('1. the router catch does not hand raw exception text to the caller');
{
  ok('the catch returns no stack at all',
     !/stack/.test(CATCH.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/_logGasError\([\s\S]*?\);/, '')));
  ok('nothing reaches jsonOut without passing through scrubSecrets_',
     /jsonOut\(\s*\{\s*error:\s*safeMsg\b/.test(CATCH) &&
     /const\s+safeMsg\s*=\s*scrubSecrets_\(/.test(CATCH));
  ok('err.message is never returned unscrubbed',
     !/error:\s*err\.message/.test(CATCH));
}

console.log('\n2. the log is scrubbed too — ?action=gaserrors replays it to any signed-in caller');
{
  ok('the catch logs through _logGasError', /_logGasError\(/.test(CATCH));
  ok('...and every argument it logs is scrubbed',
     !/_logGasError\([^)]*\berr\.(message|stack)\b(?![^)]*scrubSecrets_)/.test(
        CATCH.replace(/scrubSecrets_\(\s*err\s*&&\s*err\.stack\s*\)/g, 'SCRUBBED')));
}

console.log('\n3. the scrub actually redacts — running the real helper, not grepping for it');
{
  // Lift the helper and its regex out of the source and run them. If the implementation stops
  // redacting, this fails even though the call site still reads correctly.
  const reSrc = code.match(/const SECRET_PARAM_RE_ = [^\n]+/);
  const fnSrc = code.match(/function scrubSecrets_\(s\) \{[\s\S]*?\n\}/);
  ok('scrubSecrets_ and its pattern are defined', !!reSrc && !!fnSrc);
  const scrub = new Function(reSrc[0] + '\n' + fnSrc[0] + '\nreturn scrubSecrets_;')();

  const SECRET = 'S3cr3t-connector-value_ABCdef123';
  const googleMsg = 'Address unavailable: https://script.google.com/macros/s/AKfycbx9mjeCB/exec' +
                    '?action=dutchie_keys&connector_secret=' + SECRET;
  const scrubbed = scrub(googleMsg);
  ok('the connector secret is gone from Google\'s "Address unavailable" message',
     scrubbed.indexOf(SECRET) === -1);
  ok('...and the parameter name survives, so the message still says what failed',
     /connector_secret=\[redacted\]/.test(scrubbed) && /action=dutchie_keys/.test(scrubbed));

  ok('a session token in a url is redacted',
     scrub('boom ?action=stores&token=gx-dev:1789527229961:D21icfZhXhog2rD=').indexOf('D21icfZ') === -1);
  ok('a deploy secret is redacted', scrub('x?deploy_secret=abc123def456').indexOf('abc123def456') === -1);
  ok('an Authorization header value is redacted',
     scrub('failed with Basic YWJjZGVmZ2hpams6').indexOf('YWJjZGVmZ2hpams6') === -1);
  ok('ordinary text is left alone',
     scrub('No Dutchie key resolved for any store after mapping store_id to name') ===
     'No Dutchie key resolved for any store after mapping store_id to name');
  ok('a non-secret param that merely ends in the word key is not mangled',
     scrub('?monkey=1&storeKey=Bend') === '?monkey=1&storeKey=Bend');
  ok('null and undefined do not throw', scrub(null) === '' && scrub(undefined) === '');

  // The pattern is a shared /g regex. .replace() resets lastIndex; .test() would not, so a second
  // call would silently skip. Prove repeated calls stay correct.
  ok('repeated calls scrub identically (global-regex lastIndex)',
     scrub(googleMsg) === scrubbed && scrub(googleMsg) === scrubbed);
}

console.log('\n4. the one url that carries a credential is scrubbed at the throw site too');
{
  const fn = code.match(/function getDutchieStoreKeys_\(\)[\s\S]*?\n\}/)[0];
  ok('the key fetch is wrapped rather than left to throw the raw url',
     /try\s*\{[\s\S]{0,200}UrlFetchApp\.fetch\(url/.test(fn));
  ok('...and what it rethrows is scrubbed',
     /catch\s*\(fetchErr\)[\s\S]{0,300}scrubSecrets_\(/.test(fn));
}

console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' : '✓ ') + pass + ' passed');
process.exit(fail ? 1 : 0);
