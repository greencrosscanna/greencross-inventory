#!/usr/bin/env node
/* One bug report must produce ONE email (dutchie_proxy.gs → handleBugReport / bugMailOnce_).
 *   RUN:  node tests/bug_mail_dedupe_test.js   (also run by the pre-push hook via gx-preflight.sh)
 *
 * Sky, 2026-09-09, on a report Mike filed once: "i got 3 emails for this same bug, is that a bug in
 * itself, or did Mike hit the send button 3 times."  Neither — and that is the whole reason this
 * suite exists. It was ONE click and ONE row on the bug board; the pipeline ran three times.
 *
 * Apps Script's /exec has a second hop that sometimes refuses the content key it just issued and
 * 302s the caller back, re-executing doGet from the top. GX Core measured a five-redirect chain that
 * was three complete executions of a single request, and neither the browser nor the reporter can
 * see it happen. GX Core defends the bug ROW against exactly this (gxIngestBug's three-minute
 * dedupe), which is why the board showed the report once while Sky's inbox showed it three times:
 * the email was the one link in the chain with no guard on it.
 *
 * What these assertions protect, in the order they can regress:
 *
 *   1. A REPEAT EXECUTION MUST BE SILENT. gxIngestBug says so itself — it returns `deduped: true`
 *      when it merged into an existing row. Ignoring that return value is the original bug, and it
 *      is a one-character regression away at all times.
 *   2. THE FALLBACK PATH NEEDS ITS OWN GUARD. When GX Core is unreachable there is no `deduped` to
 *      read, and the redirect chain would send three copies of the very email that exists because
 *      the report did NOT reach the board. The script-cache mark covers that case, and it is the
 *      one a future edit is most likely to drop as redundant.
 *   3. NEITHER GUARD MAY EVER EAT A FIRST REPORT. A dead cache, a busy lock, a thrown digest — every
 *      one of those must fall through to SENDING. A duplicate email is an annoyance; a swallowed bug
 *      report is a person telling us something is broken and nobody hearing it. If this suite has to
 *      fail in one direction, it fails toward the inbox.
 *   4. A DIFFERENT REPORT IS NOT A DUPLICATE. Two people, or two problems, inside the same three
 *      minutes are two emails.
 *   5. THE TAB AND STORE COME OUT OF `context`. The shared reporter packs them into one JSON
 *      string; reading b.appTab instead meant every email said "Tab : undefined" and no Price Cards
 *      bug ever reached the pricecards board. Found while verifying the mail fix, 2026-09-09.
 *   6. THE TWO BOARDS STAY SEPARATE. This app is the only spoke that files to two app keys
 *      (pricetags → pricecards, everything else → inventory), so the cache key carries the app.
 *      Leaderboard's version of this fix has no such case and no such assertion.
 *
 * WHY THIS ONE RUNS THE CODE while the other five suites in this repo read source as text: the bug
 * was an ignored RETURN VALUE. Every text pattern that would have caught it — "gxIngestBug appears",
 * "MailApp.sendEmail appears" — was already true of the broken file. The only assertion that
 * distinguishes the two versions is how many emails come out the far end, so the file is evaluated
 * off disk with the Apps Script globals stubbed. It never reimplements what it tests.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}

// ── Fakes we can inspect ──────────────────────────────────────────────────────
let SENT, INGESTED, CACHE, CACHE_MODE, LOCK_MODE, CORE_MODE, DIGEST_MODE;

function reset() {
  SENT = []; INGESTED = []; CACHE = {};
  CACHE_MODE = 'ok';    // 'ok' | 'dead'
  LOCK_MODE  = 'ok';    // 'ok' | 'busy'
  CORE_MODE  = 'new';   // 'new' | 'dup' | 'down'
  DIGEST_MODE = 'ok';   // 'ok' | 'throw'
}

/* Only the two functions under test are evaluated, not the whole 5k-line file: the rest of
 * dutchie_proxy.gs is top-level statements and constants that would need a far larger stub surface
 * to even parse, and none of it is on this path. The slice is taken by NAME off the real file, so a
 * rename or a deletion fails loudly here rather than quietly passing. */
function loadBugFns() {
  const start = SRC.indexOf('function handleBugReport(b) {');
  if (start < 0) throw new Error('handleBugReport(b) not found in dutchie_proxy.gs');
  if (SRC.indexOf('function bugContext_(', start) < 0) {
    throw new Error('bugContext_ not found in dutchie_proxy.gs — the tab/store unpacking is gone');
  }
  const bStart = SRC.indexOf('function bugMailOnce_(', start);
  if (bStart < 0) throw new Error('bugMailOnce_ not found in dutchie_proxy.gs — the fallback guard is gone');
  const endMarker = '\n// ─── Store helpers ';
  const end = SRC.indexOf(endMarker, bStart);
  if (end < 0) throw new Error('could not find the end of the bug-report block');
  const code = SRC.slice(start, end);

  const sandbox = {
    MailApp: { sendEmail: function (msg) { SENT.push(msg); } },
    GXCore: {
      gxIngestBug: function (app, reporter, payload) {
        INGESTED.push({ app: app, reporter: reporter, payload: payload });
        if (CORE_MODE === 'down') throw new Error('central unavailable');
        if (CORE_MODE === 'dup')  return { ok: true, id: 'bug_existing', deduped: true };
        return { ok: true, id: 'bug_fresh' };
      },
    },
    CacheService: {
      getScriptCache: function () {
        if (CACHE_MODE === 'dead') throw new Error('cache unavailable');
        return {
          get: function (k) { return Object.prototype.hasOwnProperty.call(CACHE, k) ? CACHE[k] : null; },
          put: function (k, v) { CACHE[k] = v; },
        };
      },
    },
    LockService: {
      getScriptLock: function () {
        return {
          waitLock: function () { if (LOCK_MODE === 'busy') throw new Error('lock busy'); },
          releaseLock: function () {},
        };
      },
    },
    Utilities: {
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
      // Not a real MD5 — an injective stand-in. The guard only needs "same input, same key";
      // faking it keeps the test honest about the guard and silent about the hash.
      computeDigest: function (algo, s) {
        if (DIGEST_MODE === 'throw') throw new Error('digest unavailable');
        return 'D:' + s;
      },
      base64EncodeWebSafe: function (s) { return Buffer.from(String(s), 'utf8').toString('base64url'); },
      formatDate: function (d, tz, pat) { return 'FORMATTED(' + tz + '|' + pat + ')'; },
    },
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'dutchie_proxy.gs' });
  return sandbox;
}

const M = loadBugFns.bind(null);

const REPORT = {
  title: 'Stock on hand is blank', desc: 'every row shows 0 at river-rd',
  reporter: 'mike', priority: 'high', appTab: 'inventory', appStore: 'river-rd', appVer: 'v3.038',
};

// ── 1. The reported symptom: three executions of one request ──────────────────
reset();
{
  const m = M();
  m.handleBugReport(REPORT);           // first execution — Core mints a fresh row
  CORE_MODE = 'dup';                   // Core now merges, as it does inside its 3-min window
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'a triple-executed report sends ONE email', 'sent ' + SENT.length);
  ok(INGESTED.length === 3, 'all three still reach GX Core (its own dedupe owns the row)',
     'ingested ' + INGESTED.length);
}

// ── 2. `deduped` is actually read, not just received ──────────────────────────
reset();
{
  const m = M();
  CORE_MODE = 'dup';
  m.handleBugReport(REPORT);
  ok(SENT.length === 0, 'a report Core says it merged sends NO email', 'sent ' + SENT.length);
}

// ── 3. Fallback: Core unreachable, so there is no `deduped` to read ───────────
reset();
{
  const m = M();
  CORE_MODE = 'down';
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'with GX Core down, three executions still send ONE email',
     'sent ' + SENT.length);
  ok(/NOT ON THE BUG BOARD/.test(SENT[0].body),
     'that email says plainly the report never reached the board');
}

// ── 4. Fail open — every guard failure falls through to SENDING ───────────────
reset();
{
  const m = M();
  CACHE_MODE = 'dead';
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'a dead cache still sends (fail open)', 'sent ' + SENT.length);
}
reset();
{
  const m = M();
  LOCK_MODE = 'busy';
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'a busy lock still sends (fail open)', 'sent ' + SENT.length);
}
reset();
{
  const m = M();
  DIGEST_MODE = 'throw';
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'a thrown digest still sends (fail open)', 'sent ' + SENT.length);
}

// ── 5. A different report is not a duplicate ──────────────────────────────────
reset();
{
  const m = M();
  m.handleBugReport(REPORT);
  m.handleBugReport(Object.assign({}, REPORT, { reporter: 'tawny' }));
  m.handleBugReport(Object.assign({}, REPORT, { title: 'Velocity is doubled' }));
  m.handleBugReport(Object.assign({}, REPORT, { desc: 'only at hwy-99' }));
  ok(SENT.length === 4, 'a different reporter, title or description each send',
     'sent ' + SENT.length);
}

// ── 6. Inventory's two boards do not silence each other ───────────────────────
reset();
{
  const m = M();
  m.handleBugReport(Object.assign({}, REPORT, { appTab: 'pricetags' }));
  m.handleBugReport(Object.assign({}, REPORT, { appTab: 'inventory' }));
  ok(SENT.length === 2, 'the same words filed from the Price Cards tab and the Inventory tab send twice',
     'sent ' + SENT.length);
  ok(INGESTED[0].app === 'pricecards' && INGESTED[1].app === 'inventory',
     'and they route to the two different boards',
     INGESTED.map(function (i) { return i.app; }).join(', '));
}
// ...while a re-execution of the pricecards one is still silenced.
reset();
{
  const m = M();
  CORE_MODE = 'down';   // force the cache path, where the app key lives
  m.handleBugReport(Object.assign({}, REPORT, { appTab: 'pricetags' }));
  m.handleBugReport(Object.assign({}, REPORT, { appTab: 'pricetags' }));
  ok(SENT.length === 1, 'a re-executed Price Cards report is still silenced', 'sent ' + SENT.length);
}

// ── 7. A usable email: the board id is in it ──────────────────────────────────
reset();
{
  const m = M();
  m.handleBugReport(REPORT);
  ok(/bug_fresh/.test(SENT[0].body), 'the email carries the bug id it was filed under');
  ok(/mike/.test(SENT[0].body) && /Stock on hand is blank/.test(SENT[0].subject),
     'and still carries reporter and title');
}

// ── 8. The house date rule holds on this path too ─────────────────────────────
ok(!/ts\.toLocaleString/.test(SRC.slice(SRC.indexOf('function handleBugReport(b) {'))),
   'the timestamp is not derived from toLocaleString (LA zone comes from Utilities.formatDate)');

/* ── 9. THE TAB AND STORE ARRIVE INSIDE `context`, NOT AS THEIR OWN PARAMETERS ──────────────────
 *
 * gx-bugreport.js (gx-theme) sends ONE JSON string called `context` carrying everything the app
 * knows about its own state. This file read b.appTab/b.appStore, which no real report has ever
 * carried, so every email said "Tab : undefined" and — the part that actually cost something —
 * TAB_TO_APP[undefined] fell through to 'inventory', meaning a bug filed from the Price Cards tab
 * never once reached the pricecards board.
 *
 * These assertions are written the way the SHARED REPORTER builds the payload, deliberately not the
 * way a hand-built curl does. A curl with appTab= set passes both the broken and the fixed version;
 * that is exactly why filing a test report by hand did not catch this and reading the sender did.
 */
function uiReport(tab, store, over) {
  // Shaped like gx-bugreport.js's payload: no appTab, no appStore, state inside `context`.
  return Object.assign({
    title: 'Stock on hand is blank', desc: 'every row shows 0',
    reporter: 'mike', priority: 'high', appVer: 'v3.039',
    context: JSON.stringify({ url: 'https://x/y', ua: 'test', tab: tab, store: store }),
  }, over || {});
}

reset();
{
  const m = M();
  m.handleBugReport(uiReport('pricetags', 'river-rd'));
  ok(INGESTED[0].app === 'pricecards',
     'a report filed from the Price Cards tab routes to the pricecards board',
     'routed to ' + INGESTED[0].app);
  ok(INGESTED[0].payload.tab === 'pricetags' && INGESTED[0].payload.store === 'river-rd',
     'and carries the tab and store up to the board');
  ok(!/undefined/.test(SENT[0].body), 'the email has no "undefined" field in it', SENT[0].body);
  ok(/Tab      : pricetags/.test(SENT[0].body) && /Store    : river-rd/.test(SENT[0].body),
     'the email names the real tab and store');
}

reset();
{
  const m = M();
  const raw = JSON.stringify({ url: 'https://x/y', ua: 'test', tab: 'inventory', store: 'bend',
                               errors: ['TypeError: x is not a function'] });
  m.handleBugReport(uiReport('inventory', 'bend', { context: raw }));
  ok(INGESTED[0].payload.context === raw,
     'the diagnostic snapshot is forwarded to the board verbatim, errors and all',
     'got ' + JSON.stringify(INGESTED[0].payload.context));
}

reset();
{
  const m = M();
  m.handleBugReport(uiReport('inventory', 'hwy-99'));
  ok(INGESTED[0].app === 'inventory', 'every other tab still routes to the inventory board',
     'routed to ' + INGESTED[0].app);
}

// An explicit parameter still wins, so an operator curl and any future direct submit keep working.
reset();
{
  const m = M();
  m.handleBugReport(uiReport('inventory', 'hwy-99', { appTab: 'pricetags', appStore: 'bend' }));
  ok(INGESTED[0].app === 'pricecards' && INGESTED[0].payload.store === 'bend',
     'an explicit appTab/appStore parameter overrides context');
}

// A report must survive its own metadata: malformed, missing, or non-object context must not throw.
[undefined, '', 'not json at all', '[1,2,3]', '"a string"', 'null'].forEach(function (ctx) {
  reset();
  const m = M();
  let threw = null;
  try { m.handleBugReport(uiReport(null, null, { context: ctx })); } catch (e) { threw = e; }
  ok(!threw && SENT.length === 1 && INGESTED[0].app === 'inventory',
     'context ' + JSON.stringify(ctx) + ' still files and still mails',
     threw ? String(threw.message) : 'sent ' + SENT.length);
});

reset();
{
  const m = M();
  m.handleBugReport(uiReport(null, null, { context: undefined }));
  ok(/Tab      : \(unknown\)/.test(SENT[0].body),
     'a genuinely unknown tab reads "(unknown)", not "undefined"');
}

/* The two boards keep their own three-minute windows even when the tab comes from context —
   the assertion from section 6, re-run through the real payload shape. */
reset();
{
  const m = M();
  CORE_MODE = 'down';                       // force the cache path, where the app key lives
  m.handleBugReport(uiReport('pricetags', 'river-rd'));
  m.handleBugReport(uiReport('inventory', 'river-rd'));
  ok(SENT.length === 2, 'the same words from the two tabs still send twice via context',
     'sent ' + SENT.length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
