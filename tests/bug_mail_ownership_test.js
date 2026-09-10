#!/usr/bin/env node
/* WHO SENDS THE BUG EMAIL — this app, or GX Core? Exactly one of them, never both, never neither.
 *   RUN:  node tests/bug_mail_ownership_test.js   (also run by the pre-push hook via gx-preflight.sh)
 *
 * GX Core PR #50 (merged 2026-09-09, commits e66324b + cf73577) moved the bug-filed email INTO
 * gxIngestBug, which now sends it itself on every newly created row (gx_core.gs:5124-5153). The
 * reasoning is good and not in dispute: only two of seven apps mailed at all, so five could file a
 * bug and tell nobody. Inventory was one of the two that did.
 *
 * THAT MAKES THIS APP'S PINNED LIBRARY VERSION AND ITS LOCAL MailApp CALL ONE DECISION, not two.
 * Get the pairing wrong in either direction and it is silent:
 *
 *   pinned BELOW the consolidation + the send narrowed to failures  ->  ZERO emails on every bug
 *       that files successfully. A person reports something is broken and nobody hears it. This is
 *       the worse direction by a wide margin.
 *   pinned AT OR ABOVE it + the send still unconditional            ->  TWO emails. A smaller
 *       version of the exact bug this app shipped v3.039 to fix.
 *
 * NOTE WHAT IS **NOT** THE ANSWER: deleting the local send. GX Core mails only when it wrote a row,
 * so during a Core outage there is no row and no Core email — the local send is the only thing that
 * speaks. It is narrowed to the failure path, never removed, and this test asserts that too.
 *
 * Neither shows up in a normal test run, because each half is correct on its own. Only the PAIR is
 * wrong, so the pair is what gets asserted — the manifest is read here, next to the source.
 *
 * THE SAFE TRANSITION IS BOTH IN ONE DEPLOY: bump appsscript.json and delete the local mail in the
 * SAME commit, shipped by one `bash clasp.sh deploy`. There is then no window in either direction.
 * This test fails the moment a commit does one without the other, which is the whole point.
 *
 * WHERE THE THRESHOLD COMES FROM. GX_LIB_VERSION 309 was stamped at 12:46 (dfa513c); the two mail
 * commits landed at 13:26 and 13:33. So 309 PREDATES the consolidation and the first version that
 * can contain it is 310. Whether 310 has actually been cut is not knowable from any repo — library
 * versions are immutable snapshots taken outside git, which is why the house rule is to ask the live
 * app (?action=libversion) and never the manifest. So the threshold is a floor, not a fact about
 * what exists: at 309 or below this app MUST mail, at 310 or above it MUST NOT.
 *
 * IF THIS TEST FAILS AND YOU ARE MID-RE-PIN, it is telling you the other half is missing. Do both.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(REPO, 'dutchie_proxy.gs'), 'utf8');
const MANI = JSON.parse(fs.readFileSync(path.join(REPO, 'appsscript.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}

const CONSOLIDATED_FROM = 310;   // first library version that can carry GX Core's own bug email

// ── The pin, read off the manifest this app actually deploys ──────────────────
const lib = ((MANI.dependencies || {}).libraries || [])
  .filter(function (l) { return l.userSymbol === 'GXCore'; })[0];
ok(!!lib, 'appsscript.json pins the GXCore library');
const pinned = lib ? Number(lib.version) : NaN;
ok(Number.isFinite(pinned), 'the GXCore pin is a version number', 'got ' + (lib && lib.version));

/* developmentMode would make the pin meaningless — the app would run Core's HEAD, so which side
   owns the email could change without a single commit in this repo. */
ok(lib && lib.developmentMode === false,
   'the GXCore pin is a fixed snapshot, not developmentMode',
   'developmentMode: ' + (lib && lib.developmentMode));

// ── Does handleBugReport still send its own email? ────────────────────────────
const start = SRC.indexOf('function handleBugReport(b) {');
ok(start >= 0, 'handleBugReport(b) exists');
const end = SRC.indexOf('\n// ─── Store helpers ', start);
ok(end > start, 'the bug-report block has a findable end');
const block = SRC.slice(start, end);

const mailsLocally = /MailApp\.sendEmail/.test(block);

// ── The pairing ───────────────────────────────────────────────────────────────
if (pinned >= CONSOLIDATED_FROM) {
  /* GX Core owns the send. This app must be SILENT on success — but NOT deleted: Core only mails
     when it wrote a row, so a Core outage means nobody is told unless this app speaks. The local
     send is therefore narrowed to the failure path, never removed. */
  ok(mailsLocally,
     'pinned at ' + pinned + ' — a local send still exists for the case GX Core never got the report',
     'no MailApp.sendEmail in handleBugReport: a bug filed during a GX Core outage reaches NOBODY. '
     + 'Narrow the send to the failure path, do not delete it.');
  ok(/if \(why && bugMailOnce_\(/.test(block),
     'and it is gated on the report NOT landing, so it is never a second copy of Core\'s email',
     'the UNFILED send is not gated on `why` — if it fires when the row landed, Sky gets TWO emails.');
  ok(/NOT ON THE BUG BOARD/.test(block),
     'and it says plainly that the report never reached the board');
  ok(/function\s+bugMailOnce_\s*\(/.test(SRC),
     'bugMailOnce_ survives — an /exec re-execution during an outage would otherwise send three copies');
} else {
  ok(mailsLocally,
     'pinned at ' + pinned + ' (below the consolidation) — this app is still the ONLY sender',
     'handleBugReport has no MailApp.sendEmail: a filed bug would reach NOBODY by email. If you '
     + 'meant to hand the email to GX Core, bump the pin to ' + CONSOLIDATED_FROM + '+ in the same commit.');
  ok(!/if \(why && bugMailOnce_\(/.test(block),
     'and it is NOT narrowed to the failure path, which on this pin would silence the app entirely',
     'the send is gated on `why`, but GX Core does not mail below v' + CONSOLIDATED_FROM
     + ' — every successfully filed bug would be silent. Bump the pin in the same commit.');
  ok(/function\s+bugMailOnce_\s*\(/.test(SRC),
     'and the local de-dupe that keeps it to one email is still in place',
     'without bugMailOnce_ an /exec re-execution sends three copies again — see '
     + 'tests/bug_mail_dedupe_test.js');
}

/* Independent of who mails: the ROW must always be filed, and its result read. This is the part that
   survives either arrangement, and the part a "simplification" during the transition would drop. */
ok(/GXCore\.gxIngestBug\(/.test(block), 'the report is filed to the central board either way');
ok(/res\.ok === false/.test(block) && /res\.id/.test(block),
   'and gxIngestBug\'s answer is still read, not discarded',
   'the return value is what tells this app whether the report landed — discarding it is the '
   + 'original 2026-09-09 bug in a new shape');

/* ── THE SECOND PAIRING: reading the mail fields requires a pin that HAS them ──────────────────
 *
 * `mail_error` / `mail_skipped` arrived in GX Core v312. Below that pin they are never present, so
 * the UNANNOUNCED branch cannot fire — it is not broken, it is DEAD, and dead code that looks like
 * coverage is worse than no coverage: it reads as "we handle the silent-report case" while the case
 * goes on being silent. Same failure the pairing above exists for, one version later.
 *
 * The asymmetry is deliberate. Reading the fields on too low a pin is a real defect; pinning high
 * without reading them is just an app that has not adopted the notice yet, which is every other
 * spoke as of 2026-09-09 and not this test's business. */
const ANNOUNCE_FROM = 312;   // first library version that reports whether Core's own email got out
const readsMailState = /res\.mail_error/.test(block) || /res\.mail_skipped/.test(block);
if (readsMailState) {
  ok(pinned >= ANNOUNCE_FROM,
     'the UNANNOUNCED notice is backed by a pin that actually reports mail state (v'
       + ANNOUNCE_FROM + '+)',
     'this app reads mail_error/mail_skipped but is pinned to v' + pinned + ', where GX Core never '
     + 'sends them — the branch can never fire and a bug filed with a dead email stays silent. '
     + 'Bump the pin or drop the branch; do not leave it looking handled.');
  ok(/do NOT re-file/.test(block),
     'and it tells Sky NOT to re-file, the opposite of the unfiled notice',
     'the two notices carry contradictory instructions; if this one reads like the other, he will '
     + 'file a duplicate of a report that is already on the board');
  ok(/bugMailOnce_\(b, bugApp, 'unannounced'\)/.test(block),
     'and it marks its own cache key, so it cannot be silenced by the unfiled notice',
     'a shared mark lets whichever notice fires first suppress the other');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
