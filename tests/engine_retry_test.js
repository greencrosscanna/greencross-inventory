#!/usr/bin/env node
/* Engine reads go through the shared retry client; engine WRITES do not.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Every GX Core call in this app has been routed
 * through gx-client.js for months, while calls to THIS app's own engine were bare fetches
 * hitting the identical Apps Script second hop. Nobody decided that; the two just drifted,
 * because a bare `fetch(proxyUrl(...))` reads as perfectly normal at the call site and
 * nothing anywhere said otherwise. Adding one more is a two-second mistake to make and an
 * invisible one to review, so the invariant is pinned here rather than argued in a comment.
 *
 * The WRITE half matters as much as the read half and is easier to get wrong in the helpful
 * direction: the second-hop miss happens AFTER the request reached Apps Script, so a write
 * that looks failed may already have run, and a retry re-runs it. A future session tidying up
 * "the last unconverted fetch" would be introducing a duplicate-write bug while making the
 * file look more consistent. That is exactly the change this test exists to fail.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const src  = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}

// ── The helper exists and is built on the shared client, not a private reimplementation ──
ok(/function\s+engineGet\s*\(/.test(src), 'engineGet() exists');
ok(/GXClient\(PROXY_URL/.test(src), 'engineGet builds its client from PROXY_URL via GXClient');
ok(/_ENGINE\.getJSON\(/.test(src), 'engineGet delegates to GXClient.getJSON (transport-only retry)');

/* Gentler than the GX Core ladder, deliberately. This app's engine answers steadily at rest
   and bounces only under rapid calls; GX Core genuinely stalls for tens of seconds. Copying
   Core's patient 45s final attempt here would buy nothing but a longer spinner. */
const opts = (src.match(/GXClient\(PROXY_URL,\s*\{([^}]*)\}/) || [, ''])[1];
const retries = (opts.match(/retries:\s*(\d+)/) || [, null])[1];
ok(retries !== null && Number(retries) <= 2,
   'engine ladder is short (retries <= 2)', 'got retries: ' + retries);
ok(!/lastTimeoutMs/.test(opts),
   'engine client does NOT take the 45s patient final attempt',
   'lastTimeoutMs must stay a GX Core concern');

/* ── The ceiling. The single most important assertion in this file. ──────────────────────
   getJSON has no per-attempt timeout and no AbortController, so retrying through it turns
   one unbounded request into three in series. Against an endpoint that accepts and never
   answers there is no error and nothing to retry — the row just shimmers, which is how
   "Portland is stalling" was reported. Without a bound, adding retries makes that three
   times longer while reading as a robustness improvement. */
ok(/ENGINE_CEILING_MS\s*=\s*(\d+)/.test(src), 'a whole-ladder ceiling is defined');
const ceiling = Number((src.match(/ENGINE_CEILING_MS\s*=\s*(\d+)/) || [, 0])[1]);
/* The upper bound is 60s, not 30s: a live call to this engine was measured at 43.0s on
   2026-09-03 and returned valid JSON, so a tighter ceiling fails calls that would have worked.
   The lower bound is the one that matters — 30s guards against someone "tightening" it back to
   a number below a legitimately slow answer, which is the mistake this test recorded. */
ok(ceiling >= 30000 && ceiling <= 60000,
   'ceiling is a real bound, above a measured-slow answer (30000 <= ms <= 60000)', 'got ' + ceiling);
ok(/withTimeout\(_ENGINE\.getJSON\(/.test(src),
   'the retry ladder itself is wrapped in the ceiling, not just one attempt');
ok(/withTimeout\(fetch\(proxyUrl\(params\)\), ceilingMs/.test(src),
   'the no-GXClient fallback is bounded too');

// ── Reads route through the helper ───────────────────────────────────────────────────────
ok(/const json = await engineGet\(params\)/.test(src),
   'proxyFetch() — and so all 28 of its call sites — routes through engineGet');

/* The only two `fetch(proxyUrl(` occurrences allowed in this file:
     1. inside engineGet, the degradation path when the remote gx-client script fails to load
     2. the setupcentry WRITE, which must never be retried
   Anything else is a new bare read that skipped the retry. */
const bare = (src.match(/fetch\(proxyUrl\(/g) || []).length;
ok(bare === 2, 'exactly two bare fetch(proxyUrl( remain — the fallback and the write',
   'found ' + bare + '; a new one is a read that bypassed engineGet');

ok(/DELIBERATELY NOT engineGet[\s\S]{0,600}?fetch\(proxyUrl\(\{ action: 'setupcentry'/.test(src),
   'the setupcentry write is still a single un-retried attempt, and says why');

ok(!/engineGet\(\{ action: 'setupcentry'/.test(src),
   'setupcentry has NOT been converted to the read path (would risk duplicate writes)');

// ── The fallback stays a degradation, never an upgrade ───────────────────────────────────
ok(/if \(_ENGINE\) return withTimeout\(_ENGINE\.getJSON/.test(src),
   'the shared client is preferred; the plain fetch is only reached when it is absent');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
