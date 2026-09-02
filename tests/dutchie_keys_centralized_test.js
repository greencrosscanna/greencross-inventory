#!/usr/bin/env node
/* Inventory stores NO Dutchie credentials (2026-08-31).
 *
 * The six POS keys used to live in this project's own DUTCHIE_STORE_KEYS_JSON — one of five copies
 * across the suite, in two different spellings. Rotating them meant five paste jobs, and the May
 * leak survived a cleanup pass precisely because a copy nobody remembered was left behind. GX Core
 * is now the only holder; this app asks for them over ?action=dutchie_keys.
 *
 * Modeled on gx2_severance_test.js, and for the same reason: this is an INVARIANT, not a one-time
 * edit, and it is unusually easy to undo by accident. Reading a script property is a one-liner, the
 * property still exists in the live project, and a future session debugging a Core outage will be
 * sorely tempted to "just add a fallback". A fallback IS the fifth copy — unread and unrotated
 * until the day something reads it, and then serving a dead key. So this asserts the ABSENCE.
 *
 * Source-text assertions rather than a loaded harness, matching this repo's existing style.
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

console.log('1. the local key store is gone as a SOURCE of credentials');
{
  // The property name may still appear (the constant is referenced in comments/diagnostics); what
  // must not exist is a read of it feeding the auth path.
  ok('getDutchieStoreKeys_ does not read the local property',
     !/function\s+getDutchieStoreKeys_\(\)[\s\S]{0,900}getProperty\(\s*DUTCHIE_STORE_KEYS_PROP/.test(code));
  ok('...and does not read DUTCHIE_STORE_KEYS_JSON by literal either',
     !/function\s+getDutchieStoreKeys_\(\)[\s\S]{0,900}getProperty\(\s*['"]DUTCHIE_STORE_KEYS_JSON/.test(code));
  ok('no Dutchie key literal anywhere in the file',
     !/\b[0-9a-f]{32}\b/.test(code));
}

console.log('\n2. keys come from GX Core, over the key route');
{
  ok('getDutchieStoreKeys_ calls action=dutchie_keys',
     /function\s+getDutchieStoreKeys_\(\)[\s\S]{0,1200}action=dutchie_keys/.test(code));
  ok('...against the GX Core exec URL constant, not a pasted URL',
     /function\s+getDutchieStoreKeys_\(\)[\s\S]{0,1200}GX_CORE_EXEC_URL\s*\+\s*['"]\?action=dutchie_keys/.test(code));
  ok('...and retries the /exec second hop',
     /function\s+getDutchieStoreKeys_\(\)[\s\S]{0,1600}for\s*\(let\s+i\s*=\s*0;\s*i\s*<\s*5/.test(code));
}

console.log('\n3. the connector secret, and NOT the deploy secret');
{
  // If someone "fixes" a missing connector secret by reaching for the deploy secret, any spoke
  // holding it can trade it for live POS credentials. That escalation is the whole reason the two
  // gates are separate, so the substitution must not be possible to make quietly.
  ok('reads GX_CONNECTOR_SECRET',
     /getProperty\(\s*['"]GX_CONNECTOR_SECRET['"]\s*\)/.test(code));
  ok('never sends GX_DEPLOY_SECRET to the key route',
     !/action=dutchie_keys[\s\S]{0,300}GX_DEPLOY_SECRET/.test(code));
  ok('...and sends it as connector_secret=, the parameter GX Core gates on',
     /connector_secret=/.test(code));
}

console.log('\n4. it fails CLOSED');
{
  ok('a missing connector secret throws rather than continuing',
     /GX_CONNECTOR_SECRET[\s\S]{0,200}throw new Error/.test(code));
  ok('an unreachable GX Core throws rather than returning an empty map',
     /dutchie_keys unreachable[\s\S]{0,40}\)/.test(code) &&
     !/function\s+getDutchieStoreKeys_\(\)[\s\S]{0,1600}return\s*\{\s*\}\s*;/.test(code));
  ok('an empty mapping result throws rather than serving nothing silently',
     /No Dutchie key resolved for any store/.test(code));
}

console.log('\n5. the store_id -> Dutchie name translation stays at this one door');
{
  // GX Core answers in store_id — the suite's one vocabulary, and the reason the transposed
  // Bend/Hillsboro labels cannot come back. This app is name-keyed throughout, so the translation
  // belongs at the single boundary, never scattered.
  ok('maps through the GX Core store registry',
     /GXCore\.getStores\(\)[\s\S]{0,300}dutchie_name/.test(code));
  ok('...and throws if the registry cannot be read, rather than guessing',
     /store registry unreachable[\s\S]{0,80}map keys/.test(code));
  ok('the translation appears once, not per call site',
     (code.match(/byStoreId\[/g) || []).length <= 3);
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
