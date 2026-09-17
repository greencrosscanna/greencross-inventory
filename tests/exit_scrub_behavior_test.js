#!/usr/bin/env node
/* THE THREE EXITS, EXECUTED — not grepped (2026-09-17).
 *
 * tests/exit_scrub_test.js (shared, from gx-theme) answers a different question: is there an exit
 * nobody has looked at? It reads source text, and it says so itself — it cannot prove the scrub is
 * applied to the right argument, or that what comes out is actually redacted. That is this file.
 *
 * WHAT WAS WRONG. v3.058 scrubbed the router's catch, correctly, and that was the only exit anybody
 * had gone looking at. Three others were carrying raw caught text:
 *
 *   mail     testEmail() and bugNotify_() called MailApp.sendEmail directly. bugNotify_'s last line
 *            is `Diagnostics: <whatever the browser captured>`, and on the UNFILED path that email
 *            is the only copy of the report. An email is the worse exit of the two — a screen shows
 *            an error to one person and is gone; a mailbox is forwarded and searchable for years.
 *   reply    jsonOut is where EVERY route's payload leaves, and it did not scrub. The router's catch
 *            scrubs what IT returns, but about ten handlers return `{ error: e.message }` of their
 *            own without going anywhere near that catch — getGasErrors, snapshotWorkbooks,
 *            getLeafLinkOrders, velBackfillStatus replaying a STORED `error:<message>` status, the
 *            write-grant check. Any of them can be holding a UrlFetchApp failure, which on Apps
 *            Script carries the whole url, `connector_secret=` included.
 *   store    _logGasError writes to the gc_error_log Script Property, which ?action=gaserrors
 *            replays to any signed-in user. Only the router's catch passed scrubbed text; the other
 *            ~30 call sites handed over a raw e.message. The file's own comment claimed "the LOG is
 *            scrubbed too" — true of the one caller somebody had looked at, false of the buffer.
 *
 * Crew had the identical shape the same day: a correct, derived, tested scrub, and six unscrubbed
 * sends beside the one that had been audited. A scrub at ONE exit says nothing about a SECOND.
 *
 * MUTATION LOG — every count below was MEASURED, on a SCRATCH COPY of the file and never the
 * shipped one, on 2026-09-17. A clean run against already-correct code proves nothing:
 *
 *   · scrubSecrets_ removed from all three fields of sendMail_ → 4 fail, 17 pass (subject, body,
 *     htmlBody, and the "still says which parameter" assertion)
 *   · sendMail_ scrubbing `body` ONLY                          → 3 fail, 18 pass — subject and
 *     htmlBody. This is the mutation that matters most: a subject line is what shows in a mailbox
 *     list and in every forward, and scrubbing the body alone reads as a fix.
 *   · scrubSecrets_ removed from jsonOut                       → 4 fail, 17 pass, JSONP included
 *   · scrubSecrets_ removed from _logGasError                  → 2 fail, 19 pass
 *   · sendMail_ editing the caller's object instead of a copy  → 1 fail, 20 pass
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(REPO, 'dutchie_proxy.gs'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}

/* Lift by NAME off the shipped file, never a copy. A rename or a deletion fails loudly here rather
   than leaving a green test describing code that no longer exists. */
function slice(startMarker, endRe, what) {
  const at = SRC.indexOf(startMarker);
  if (at < 0) throw new Error(what + ' not found in dutchie_proxy.gs (looked for: ' + startMarker + ')');
  const m = SRC.slice(at).match(endRe);
  if (!m) throw new Error(what + ' has no findable end');
  return SRC.slice(at, at + m.index + m[0].length);
}

const SENT = [];
const PROPS = {};
const sandbox = {
  MailApp: { sendEmail: function (msg) { SENT.push(msg); } },
  PropertiesService: {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return Object.prototype.hasOwnProperty.call(PROPS, k) ? PROPS[k] : null; },
        setProperty: function (k, v) { PROPS[k] = String(v); },
        deleteProperty: function (k) { delete PROPS[k]; },
      };
    },
  },
  ContentService: {
    MimeType: { JSON: 'JSON', JAVASCRIPT: 'JAVASCRIPT' },
    createTextOutput: function (s) { return { _body: s, setMimeType: function () { return this; } }; },
  },
  console: console,
};
vm.createContext(sandbox);
vm.runInContext(
  slice('const GAS_ERROR_LOG_KEY', /function _logGasError\(fn, msg\) \{[\s\S]*?\n\}/, 'the error-log buffer') +
  '\n' + slice('const AUTH_PARAM_NAMES_ =', /function sendMail_\(msg\) \{[\s\S]*?\n\}/, 'the scrub unit and mail exit') +
  '\n' + slice('function jsonOut(obj, callback) {', /\n\}/, 'jsonOut'),
  sandbox, { filename: 'dutchie_proxy.gs' });

/* The needle is ASSEMBLED at runtime and never written down as a literal — gx-preflight scans every
   tracked file for credential-shaped strings, and a test fixture is the classic place a real key
   hides. It is one unbroken token by the time the scrub sees it, so the assertions are as strict as
   a hardcoded one would be. This is the convention router_catch_scrub_test.js already uses. */
const SECRET = ['NOT', 'A', 'REAL', 'CREDENTIAL'].join('-') + '-' + 'w'.repeat(12) + '-003';
const GOOGLE_MSG = 'Address unavailable: https://script.google.com/macros/s/AKfycbx9mjeCB/exec' +
                   '?action=dutchie_keys&connector_secret=' + SECRET;
ok('the fixture carries the needle before any scrub runs (guards the assembly above)',
   SECRET.length >= 24 && GOOGLE_MSG.indexOf(SECRET) !== -1);

console.log('\n1. the mail exit — an email is forwarded and searchable for years');
{
  SENT.length = 0;
  sandbox.sendMail_({
    to: 'sky@greencrosscanna.com',
    subject: 'bug from ' + GOOGLE_MSG,
    body: 'Diagnostics: ' + GOOGLE_MSG,
    htmlBody: '<pre>' + GOOGLE_MSG + '</pre>',
    cc: 'mike@greencrosscanna.com',
  });
  ok('the send actually happens — a scrub that swallows the mail is not a fix', SENT.length === 1);
  const m = SENT[0] || {};
  ok('the subject is scrubbed',  String(m.subject).indexOf(SECRET) === -1);
  ok('the body is scrubbed',     String(m.body).indexOf(SECRET) === -1);
  ok('the htmlBody is scrubbed', String(m.htmlBody).indexOf(SECRET) === -1);
  ok('...and each still says WHICH parameter was redacted, so the email is still diagnostic',
     /connector_secret=\[redacted\]/.test(String(m.subject)) &&
     /connector_secret=\[redacted\]/.test(String(m.body)));
  ok('fields that are not message text pass through untouched — to and cc are not scrubbed shut',
     m.to === 'sky@greencrosscanna.com' && m.cc === 'mike@greencrosscanna.com');

  /* The caller's own object must not be mutated: bugNotify_ builds its message once, and a scrub
     that edited it in place would be invisible here but would change what a caller reads back. */
  const original = { to: 'x@y.z', subject: GOOGLE_MSG, body: GOOGLE_MSG };
  sandbox.sendMail_(original);
  ok('the caller\'s message object is copied, not edited in place',
     original.subject === GOOGLE_MSG && original.body === GOOGLE_MSG);

  /* Idempotent, because the router's catch and getDutchieStoreKeys_ already scrub before this
     point. If a second pass mangled the text, the fix at one exit would corrupt the other. */
  SENT.length = 0;
  sandbox.sendMail_({ to: 'x@y.z', body: sandbox.scrubSecrets_(GOOGLE_MSG) });
  ok('scrubbing an already-scrubbed body changes nothing (the catch scrubs first)',
     SENT[0].body === sandbox.scrubSecrets_(GOOGLE_MSG));

  ok('no field is required — a send with only a body does not throw',
     (function () { try { sandbox.sendMail_({ to: 'x@y.z', body: 'plain' }); return true; }
                    catch (e) { return false; } })());
}

console.log('\n2. the reply exit — every route payload leaves through jsonOut');
{
  /* The shape that matters: a handler returning its OWN caught error, nowhere near doGet's catch.
     velBackfillStatus is the live one — it replays a STORED `error:<message>` off a Script
     Property, so the leak outlives the request that caused it. */
  const out = sandbox.jsonOut({ status: 'error:2026-09-01:' + GOOGLE_MSG, from: '2026-09-01' });
  ok('a stored error status replayed by a poll route comes back redacted',
     out._body.indexOf(SECRET) === -1);
  ok('...and still names the parameter, so the status is still readable',
     /connector_secret=\[redacted\]/.test(out._body));

  const errOut = sandbox.jsonOut({ ok: false, error: GOOGLE_MSG });
  ok('a handler returning { error: e.message } directly is redacted too',
     errOut._body.indexOf(SECRET) === -1);

  /* JSONP is the path index.html actually uses through GXClient, and it is a SECOND exit inside
     this one function — scrubbing after the callback wrap, or only on the JSON branch, would leave
     the real one open. */
  const jsonp = sandbox.jsonOut({ error: GOOGLE_MSG }, 'gxcb17');
  ok('the JSONP branch is scrubbed as well as the JSON one', jsonp._body.indexOf(SECRET) === -1);
  ok('...and is still a valid JSONP call the browser can run',
     /^gxcb17\(\{/.test(jsonp._body) && /\);$/.test(jsonp._body));

  /* THE OTHER HALF OF THE TRADE. Scrubbing the serialized body is only acceptable if ordinary
     payloads survive it — a scrub that eats real data gets switched off within a week. */
  const data = { ok: true, stores: [{ store_id: 'river-rd', name: 'River Rd', doh: 7.5 }],
                 token: 'gx-dev:1789527229961:D21icfZhXhog2rD=' };
  const clean = sandbox.jsonOut(data);
  ok('an ordinary payload round-trips byte for byte', clean._body === JSON.stringify(data));
  ok('a session token returned as a JSON FIELD is not redacted — the pattern needs a ? or & first',
     JSON.parse(clean._body).token === data.token);
}

console.log('\n3. the store — gc_error_log is replayed to any signed-in caller by ?action=gaserrors');
{
  for (const k in PROPS) delete PROPS[k];
  /* A raw e.message, the way ~30 call sites hand it over. Only doGet's catch ever scrubbed first. */
  sandbox._logGasError('syncStoreNames_', GOOGLE_MSG);
  const stored = PROPS['gc_error_log'] || '';
  ok('the buffer holds no credential, whatever the caller passed', stored.indexOf(SECRET) === -1);
  ok('...and still records which parameter and which function, so it is still a useful log',
     /connector_secret=\[redacted\]/.test(stored) && /syncStoreNames_/.test(stored));

  /* Idempotent for the one caller that already scrubbed — doGet's catch passes safeMsg. */
  for (const k in PROPS) delete PROPS[k];
  sandbox._logGasError('doGet:stores', sandbox.scrubSecrets_(GOOGLE_MSG));
  ok('an already-scrubbed message is stored unchanged (the router catch scrubs first)',
     (PROPS['gc_error_log'] || '').indexOf('[redacted][redacted]') === -1 &&
     /connector_secret=\[redacted\]/.test(PROPS['gc_error_log'] || ''));

  ok('the 300-char cap still applies after scrubbing, so the buffer cannot be flooded',
     (function () {
       for (const k in PROPS) delete PROPS[k];
       sandbox._logGasError('flood', 'x'.repeat(5000));
       return JSON.parse(PROPS['gc_error_log'])[0].msg.length === 300;
     })());
}

console.log('\n' + (fail ? 'FAIL ' + fail + ' failed, ' : 'ok   ') + pass + ' passed');
process.exit(fail ? 1 : 0);
