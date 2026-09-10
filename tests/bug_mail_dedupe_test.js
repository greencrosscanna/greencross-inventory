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
let SENT, INGESTED, CACHE, CACHE_MODE, LOCK_MODE, CORE_MODE, DIGEST_MODE, CORE_LITERAL;

/* Read a sent email defensively. When a regression stops a send happening at all, the count
 * assertion above already FAILS — and every assertion after it would then crash on SENT[0].body,
 * ending the run and hiding the rest of the damage. A test suite's job on a bad day is to say how
 * much is broken, not to stop at the first thing it trips over. */
function sent(i) { return SENT[i] || { subject: '(no email sent)', body: '(no email sent)' }; }

function reset() {
  SENT = []; INGESTED = []; CACHE = {};
  CACHE_MODE = 'ok';    // 'ok' | 'dead'
  LOCK_MODE  = 'ok';    // 'ok' | 'busy'
  CORE_MODE  = 'new';   // 'new' | 'dup' | 'down' | 'refuse' | 'noid' | 'mailerr' | 'mailskip' | 'literal'
  CORE_LITERAL = undefined;   // used only by CORE_MODE 'literal'
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
  if (SRC.indexOf('function bugNotify_(', start) < 0) {
    throw new Error('bugNotify_ not found in dutchie_proxy.gs — the shared notice body is gone');
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
        /* Hand back EXACTLY what the table specifies, including null/undefined — the point of that
           block is the shapes Core's contract does not describe. */
        if (CORE_MODE === 'literal') return CORE_LITERAL;
        /* THE FOUR SHAPES gxIngestBug ACTUALLY RETURNS, from GX Core v312 on. Three of them mean
           something has to happen here, and only one of the three arrives as an exception — which
           is the entire reason these modes exist rather than a boolean "core up/down". */
        if (CORE_MODE === 'refuse')  return { ok: false, error: 'title or detail required' };
        if (CORE_MODE === 'noid')    return { ok: true };
        /* A DE-DUPED ANSWER CARRIES NO MAIL FIELD AT ALL — gxIngestBug returns at `priorBug` above
           its own send. Mirrored exactly, because the unannounced notice must not read that absence
           as a failure; doing so would fire three false alarms per redirect chain. */
        if (CORE_MODE === 'dup')     return { ok: true, id: 'bug_existing', deduped: true };
        if (CORE_MODE === 'mailerr') return { ok: true, id: 'bug_fresh', mail_error: 'MailApp quota exceeded' };
        if (CORE_MODE === 'mailskip')return { ok: true, id: 'bug_fresh', mail_skipped: 'no recipient on file' };
        return { ok: true, id: 'bug_fresh', mailed: 'sky@greencrosscanna.com' };
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

// ── 1. The reported symptom, under the v310 arrangement ───────────────────────
/* GX Core mails on every row it creates (library v310, PR #50), so a report that LANDS must be
   silent here or Sky gets two. The original three-email symptom is now impossible in two independent
   ways, and this asserts both: the send is gated on the row not landing, AND bugMailOnce_ still
   guards the outage path underneath it. */
reset();
{
  const m = M();
  m.handleBugReport(REPORT);           // first execution — Core mints a fresh row and mails
  CORE_MODE = 'dup';                   // Core merges, as it does inside its 3-min window
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  ok(SENT.length === 0, 'a triple-executed report that LANDS sends no local email — Core mailed',
     'sent ' + SENT.length);
  ok(INGESTED.length === 3, 'all three still reach GX Core (its own dedupe owns the row)',
     'ingested ' + INGESTED.length);
}

// ── 2. A merged re-execution is silent, and for the right reason ──────────────
reset();
{
  const m = M();
  CORE_MODE = 'dup';
  m.handleBugReport(REPORT);
  ok(SENT.length === 0, 'a report Core says it merged sends NO email', 'sent ' + SENT.length);
  ok(INGESTED.length === 1, 'and it was still offered to the board',
     'ingested ' + INGESTED.length);
}

// ── 2b. A successful first filing is silent here too ──────────────────────────
reset();
{
  const m = M();
  m.handleBugReport(REPORT);
  ok(SENT.length === 0, 'a report that files cleanly sends no local email at all',
     'sent ' + SENT.length + ' — that would be a second copy of GX Core\'s');
}

// ── 3. The fallback: Core unreachable, so NOBODY has been told ────────────────
reset();
{
  const m = M();
  CORE_MODE = 'down';
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'with GX Core down, three executions still send ONE email',
     'sent ' + SENT.length);
  ok(/NOT ON THE BUG BOARD/.test(sent(0).body),
     'that email says plainly the report never reached the board', sent(0).body);
  ok(/could not be reached/.test(sent(0).body),
     'and names WHICH failure put it there — unreachable, not refused', sent(0).body);
  ok(/^⚠️ UNFILED/.test(sent(0).subject),
     'and the subject says so before Sky opens it', sent(0).subject);
  ok(/re-file/i.test(sent(0).body),
     'and tells him the one thing to do about it');
  ok(/no receipt/.test(sent(0).body),
     'and warns that the reporter was not acknowledged either');
}

/* ── 3b. A REFUSAL IS NOT AN EXCEPTION, and this is the case the old contract missed ───────────
 *
 * gxIngestBug returns {ok:false, error} without throwing when it will not take a report — an empty
 * one, a missing app key (gx_core.gs:5375: "It does not throw here, by design"). core-admin's v310
 * and v312 re-pin notes nonetheless told every spoke to mail "only when gxIngestBug THROWS", and a
 * spoke that believed them would go silent on exactly the report that reached no board: no row, no
 * Core email, no local email, and nothing anywhere recording that a person had reported something.
 *
 * THIS APP WAS NEVER WRITTEN THAT WAY — the gate has always been "did an id come back" — so these
 * assertions are pinning behavior that already worked, not fixing a live bug. They are here because
 * the wrong instruction is written down in two shipped release notes that cannot now be edited, and
 * the obvious "simplification" of this function is to collapse it into the catch.
 */
reset();
{
  const m = M();
  CORE_MODE = 'refuse';
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'a report GX Core REFUSES (ok:false, no throw) still emails', 'sent ' + SENT.length);
  ok(/NOT ON THE BUG BOARD/.test(sent(0).body),
     'and is described as unfiled, because it is');
  ok(/refused the report/.test(sent(0).body) && /title or detail required/.test(sent(0).body),
     'and carries the reason Core gave, so it can be re-filed correctly', sent(0).body);
}

// A well-formed ok with no id is not in Core's contract; it mails anyway rather than assume.
reset();
{
  const m = M();
  CORE_MODE = 'noid';
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'an ok answer carrying no bug id is treated as unfiled', 'sent ' + SENT.length);
}

/* ── 3c. FILED, BUT NOBODY WAS TOLD ────────────────────────────────────────────────────────────
 *
 * The row is down and Core's own send died. Core swallows that on purpose — a report that reached
 * the sheet has succeeded, and mail must never be what stops it — so before v312 this was a bug
 * filed, nobody notified, and NOTHING recording the fact. The absence of an email is not an event
 * anyone observes; it is only visible by opening the board and finding a row you never heard about.
 *
 * The instruction here is the OPPOSITE of the unfiled one, which is why they cannot share a body,
 * a subject, or a cache key: the report is safe and re-filing it would duplicate it.
 */
[['mailerr', 'MailApp quota exceeded', 'failed'],
 ['mailskip', 'no recipient on file', 'skipped']].forEach(function (row) {
  reset();
  const m = M();
  CORE_MODE = row[0];
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'a bug whose Core email ' + row[2] + ' notifies ONCE across three executions',
     'sent ' + SENT.length);
  ok(/do NOT re-file/.test(sent(0).body),
     'and says do not re-file — unlike the unfiled notice, the report is safe', sent(0).body);
  ok(/bug_fresh/.test(sent(0).body),
     'and hands over the id, because the useful action is to go and look at it');
  ok(/UNANNOUNCED/.test(sent(0).subject), 'the subject distinguishes it at a glance', sent(0).subject);
  ok(sent(0).body.indexOf(row[1]) >= 0, 'and it names why nobody was mailed', sent(0).body);
});

/* mail_skipped is the one that reads as fine and is not: nothing failed, and nobody was told. */
reset();
{
  const m = M();
  CORE_MODE = 'mailskip';
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, 'a SKIPPED send is a silent report too, not a non-event', 'sent ' + SENT.length);
}

/* ── 3d. THE REDIRECT CHAIN MUST NOT TRIP THE NEW NOTICE ───────────────────────────────────────
 *
 * This is the assertion that stops the fix re-creating the bug it was built on top of. A de-duped
 * answer carries NO mail field at all, because gxIngestBug returns at `priorBug` ABOVE its send. So
 * the gate has to be the PRESENCE of mail_error/mail_skipped, never the ABSENCE of `mailed` —
 * reading absence as failure would fire one false alarm per re-execution, which is three emails per
 * click, which is precisely the original symptom wearing the fix as a disguise.
 */
reset();
{
  const m = M();
  m.handleBugReport(REPORT);        // fresh: Core mails, we stay quiet
  CORE_MODE = 'dup';                // the /exec chain re-executes; Core merges and returns early
  m.handleBugReport(REPORT);
  m.handleBugReport(REPORT);
  ok(SENT.length === 0, 'a de-duped answer with NO mail field is silence, not a mail failure',
     'sent ' + SENT.length + ' — the absence of `mailed` was read as a failure');
}

/* ── 3e. THE TWO NOTICES DO NOT SILENCE EACH OTHER ─────────────────────────────────────────────
 *
 * One report can raise both, in this order: a submit that never reaches Core, then the person's
 * retry, which files and cannot mail. They carry contradictory instructions, so a shared cache mark
 * would drop the second and leave "please re-file this" standing as the only word on a report that
 * is now ON the board — sending Sky to file a duplicate of something he was told was lost.
 */
reset();
{
  const m = M();
  CORE_MODE = 'down';
  m.handleBugReport(REPORT);
  CORE_MODE = 'mailerr';
  m.handleBugReport(REPORT);
  ok(SENT.length === 2, 'the same report can raise UNFILED and then UNANNOUNCED', 'sent ' + SENT.length);
  ok(/NOT ON THE BUG BOARD/.test(sent(0).body) && /do NOT re-file/.test(sent(1).body),
     'and they say opposite things, in the right order');
}

// ...and the unannounced mark is per-board too, like the unfiled one.
reset();
{
  const m = M();
  CORE_MODE = 'mailerr';
  m.handleBugReport(Object.assign({}, REPORT, { appTab: 'pricetags' }));
  m.handleBugReport(Object.assign({}, REPORT, { appTab: 'inventory' }));
  ok(SENT.length === 2, 'an unannounced Price Cards bug does not silence an Inventory one',
     'sent ' + SENT.length);
}

/* ── 3f. EVERY SHAPE gxIngestBug CAN HAND BACK, INCLUDING THE ONES IT SHOULDN'T ────────────────
 *
 * Leaderboard named the failure shape that produced three separate bugs across the suite tonight:
 * A VALUE WHOSE ABSENCE IS INDISTINGUISHABLE FROM A VALUE. A de-duped repeat carries no mail field
 * and "no mailed" gets read as "mail failed"; an unreadable config key gets read as "key unset"; a
 * quota read that threw gets read as "cannot send". Each has an obvious one-liner that is wrong and
 * looks right.
 *
 * This table is that test applied to every return this app can receive — including three that are
 * not in Core's contract at all (a bare {}, null, undefined). Those matter because the honest answer
 * to "what does Core return if something goes wrong upstream of its own error handling" is that we
 * do not know, and the safe behavior for an unrecognized shape is to MAIL: the cost of a spurious
 * notice is a duplicate email, and the cost of guessing "filed" is a report nobody ever reads.
 *
 * Reading down the `want` column is the whole contract: silence on the four shapes that mean the
 * board has it and someone was told, an email on everything else. */
[['{ok:true,id,mailed}       normal filing',         { ok: true, id: 'b1', mailed: 'sky@' },          0],
 ['{ok:true,id,deduped}      redirect re-execution', { ok: true, id: 'b1', deduped: true },           0],
 ['{ok:true,id}              ok, NO mail field',     { ok: true, id: 'b1' },                          0],
 ['{ok:true,id,mail_error}   filed, mail died',      { ok: true, id: 'b1', mail_error: 'quota' },     1],
 ['{ok:true,id,mail_skipped} filed, nobody to mail', { ok: true, id: 'b1', mail_skipped: 'none' },    1],
 ['{ok:false,error}          refused, no throw',     { ok: false, error: 'title required' },          1],
 ['{}                        bare empty object',     {},                                              1],
 ['{ok:true}                 ok with no id',         { ok: true },                                    1],
 ['null                      null return',           null,                                            1],
 ['undefined                 undefined return',      undefined,                                       1],
].forEach(function (row) {
  reset();
  const m = M();
  CORE_MODE = 'literal';
  CORE_LITERAL = row[1];
  m.handleBugReport(REPORT);
  ok(SENT.length === row[2], 'shape ' + row[0] + ' -> ' + (row[2] ? 'emails' : 'silent'),
     'sent ' + SENT.length + ', wanted ' + row[2]);
});

// ── 4. Fail open — every guard failure falls through to SENDING ───────────────
/* All three run with Core DOWN, because that is now the only path that reaches the mail at all —
   and it is the path where failing closed would be worst: the board does not have the report. */
[['CACHE_MODE', 'dead', 'a dead cache'],
 ['LOCK_MODE',  'busy', 'a busy lock'],
 ['DIGEST_MODE','throw','a thrown digest']].forEach(function (row) {
  reset();
  const m = M();
  CORE_MODE = 'down';
  if (row[0] === 'CACHE_MODE') CACHE_MODE = row[1];
  if (row[0] === 'LOCK_MODE')  LOCK_MODE  = row[1];
  if (row[0] === 'DIGEST_MODE') DIGEST_MODE = row[1];
  m.handleBugReport(REPORT);
  ok(SENT.length === 1, row[2] + ' still sends (fail open)', 'sent ' + SENT.length);
});

// ── 5. A different report is not a duplicate ──────────────────────────────────
reset();
{
  const m = M();
  CORE_MODE = 'down';                       // the only path that mails now
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
  CORE_MODE = 'down';
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

// ── 7. The fallback email is usable on its own, because it is the only record ─
reset();
{
  const m = M();
  CORE_MODE = 'down';
  m.handleBugReport(REPORT);
  ok(/mike/.test(SENT[0].body) && /Stock on hand is blank/.test(SENT[0].subject),
     'it carries reporter and title');
  ok(/every row shows 0 at river-rd/.test(SENT[0].body), 'and the full description');
  ok(SENT[0].body.indexOf('Diagnostics') >= 0,
     'and the captured diagnostics, which nothing else will hold if the board never got the report');
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
  CORE_MODE = 'down';
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
  CORE_MODE = 'down';
  let threw = null;
  try { m.handleBugReport(uiReport(null, null, { context: ctx })); } catch (e) { threw = e; }
  ok(!threw && SENT.length === 1 && INGESTED[0].app === 'inventory',
     'context ' + JSON.stringify(ctx) + ' still files and still mails',
     threw ? String(threw.message) : 'sent ' + SENT.length);
});

reset();
{
  const m = M();
  CORE_MODE = 'down';
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
