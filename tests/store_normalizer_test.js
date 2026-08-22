#!/usr/bin/env node
/* ─── normalizeStore — tests ──────────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/store_normalizer_test.js     (from the repo root; no deps, no network, no credentials)
 *
 * WHY THIS FUNCTION
 * Every row of live Dutchie data is filtered through normalizeStore before it reaches a view. If it
 * fails to fold a POS spelling onto our store name the row does not appear under that store, and the
 * number on screen is quietly low -- no error, no empty state, just a wrong total.
 *
 * WHAT CHANGED 2026-08-22
 * It now asks GX Core's `stores` registry first and only falls back to the hand-written rules. So this
 * file tests TWO paths and both matter:
 *
 *   REGISTRY LOADED   the normal case. Aliases come from the one list, so "South", "Commercial St",
 *                     "Century" and "Century Dr" fold correctly -- all of which this function used to
 *                     drop on the floor.
 *   REGISTRY ABSENT   first paint, or GX Core unreachable. The hand-written rules must still behave
 *                     exactly as they did before, because that is the whole point of keeping them.
 *
 * The registry path is exercised against the REAL gx-theme/gx-stores.js, seeded with the REAL rows
 * from ?action=stores (captured 2026-08-22), not a stand-in -- so this also catches a change in the
 * shared client, not just in this app.
 *
 * index.html is a monolith with no module boundary, so the function and the STORES table are lifted
 * out of the shipped file by text match. If that extraction stops matching, the test exits 2 and says
 * so rather than passing vacuously.
 *
 * Cannot reach Apps Script: .claspignore excludes tests/. rootDir is "." here and the list does not
 * exclude JS by extension, so that rule is doing real work -- keep it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');

function lift(pattern, what) {
  const m = html.match(pattern);
  if (!m) {
    console.error('EXTRACTION FAILED: could not find ' + what + ' in index.html.');
    console.error('The source moved or changed shape. Update the pattern here -- do not delete the test.');
    process.exit(2);
  }
  return m[0];
}
const STORES_SRC = lift(/let STORES = \[[\s\S]*?\];/, 'the STORES table');
const FN_SRC     = lift(/function normalizeStore\(raw\) \{[\s\S]*?\n\}/, 'function normalizeStore');

// Build normalizeStore with GXStores either injected or absent.
function build(GXStores) {
  return new Function('GXStores', STORES_SRC + '\n' + FN_SRC + '\nreturn normalizeStore;')(GXStores);
}

// ── the real shared client, seeded with the real registry ────────────────────
const ROWS = [
  { store_id:'bend',        display_name:'Century',    dutchie_name:'Bend',        short_code:'CEN', color:'#22D3EE', sort_order:1, aliases:['Bend','Century','Century Dr'] },
  { store_id:'center',      display_name:'Center',     dutchie_name:'Center',      short_code:'CTR', color:'#3B82F6', sort_order:2, aliases:['Center'] },
  { store_id:'commercial',  display_name:'Commercial', dutchie_name:'Commercial',  short_code:'COM', color:'#A855F7', sort_order:3, aliases:['South','Commercial','Commercial St'] },
  { store_id:'hillsboro',   display_name:'Baseline',   dutchie_name:'Hillsboro',   short_code:'BAS', color:'#6366F1', sort_order:4, aliases:['Baseline','Hillsboro'] },
  { store_id:'portland-rd', display_name:'Portland',   dutchie_name:'Portland Rd', short_code:'POR', color:'#D946EF', sort_order:5, aliases:['Portland','Portland Rd'] },
  { store_id:'river-rd',    display_name:'River',      dutchie_name:'River Rd',    short_code:'RIV', color:'#EC4899', sort_order:6, aliases:['River','River Rd'] },
];

// gx-stores.js ends with `})(typeof window !== 'undefined' ? window : this)`, so it binds to `window`
// if that name resolves -- NOT to whatever you pass in. Handing it a `global` param therefore attaches
// GXStores to the sandbox's `this` and the loader silently returns undefined, which is exactly the
// vacuous pass this file is supposed to make impossible. Name the parameter `window`.
// No `document` on purpose: paintVars() returns early without one, so no DOM stub is needed.
function loadRealGXStores() {
  const p = path.resolve(__dirname, '../../greencross-gx-theme/gx-stores.js');
  if (!fs.existsSync(p)) return null;                       // sibling repo genuinely not checked out
  const store = {};
  const win = {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    GXClient: () => ({ jsonp: async () => ({ ok: true, stores: ROWS }) }),
  };
  const got = new Function('window', fs.readFileSync(p, 'utf8') + '\nreturn window.GXStores;')(win);
  if (!got) {
    console.error('LOAD FAILED: gx-stores.js is present but did not attach GXStores.');
    console.error('Its IIFE binding changed, or it threw. Fix the loader -- do not let this skip.');
    process.exit(2);
  }
  return got;
}

let pass = 0, fail = 0, skip = 0;
const mk = fn => (input, want, label) => {
  const got = fn(input);
  if (got === want) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + `  (${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
};

(async () => {

// ══ PART 1 — registry ABSENT: the offline path must be byte-for-byte what it was ══
console.log('\n═══ registry ABSENT (first paint / GX Core unreachable) ═══');
const off = mk(build(undefined));

console.log('\n1. strips the " - Green Cross Cannabis Emporium" suffix');
off('Portland Rd - Green Cross Cannabis Emporium', 'Portland Rd', 'Portland Rd with suffix');
off('River Rd - Green Cross Cannabis Emporium',    'River Rd',    'River Rd with suffix');
off('Bend - green cross cannabis emporium',        'Bend',        'suffix match is case-insensitive');
off('Bend  -  Green Cross Cannabis Emporium',      'Bend',        'tolerates padding around the dash');

console.log('\n2. the hand-written rules still fold what they always did');
off('Center St',            'Center',      '"Center St" -> Center');
off('Portland Road',        'Portland Rd', '"Portland Road" -> Portland Rd');
off('River Rd',             'River Rd',    '"River Rd" unchanged');
off('center street',        'Center',      'prefix match absorbs "Center Street"');
off('Center St Suite 200',  'Center',      'and any trailing detail after the match');
off('Portland Roadhouse',   'Portland Rd', 'same looseness on Portland — documented, not endorsed');

console.log('\n3. exact STORES match, case-insensitively');
off('bend',       'Bend',       'lowercase folds to the canonical name');
off('HILLSBORO',  'Hillsboro',  'uppercase folds to the canonical name');
off('Commercial', 'Commercial', 'exact name passes through');

console.log('\n4. offline, the alias gaps are still gaps — unchanged by design');
off('Commercial St', 'Commercial St', '"Commercial St" does not fold without the registry');
off('South',         'South',         '"South" does not fold without the registry');
off('Century',       'Century',       '"Century" does not fold without the registry');

console.log('\n5. degenerate input');
off('',         '',        'empty string stays empty');
off(null,       '',        'null becomes empty rather than throwing');
off(undefined,  '',        'undefined becomes empty rather than throwing');
off('  Bend  ', 'Bend',    'surrounding whitespace is trimmed');
off('Nowhere',  'Nowhere', 'unknown store passes through rather than being dropped');

// ══ PART 2 — registry LOADED: the gaps close ══
console.log('\n═══ registry LOADED (the normal case) ═══');
const GXStores = loadRealGXStores();
if (!GXStores) {
  skip++;
  console.log('  SKIP  greencross-gx-theme not checked out beside this repo — registry path not exercised');
} else {
  await GXStores.load('https://example.invalid/exec');
  const on = mk(build(GXStores));

  console.log('\n6. the three gaps this change exists to close');
  on('South',         'Commercial', '"South" -> Commercial (the old name for that store)');
  on('Commercial St', 'Commercial', '"Commercial St" -> Commercial');
  on('Century',       'Bend',       '"Century" -> Bend (display name -> Dutchie name)');
  on('Century Dr',    'Bend',       '"Century Dr" -> Bend');

  console.log('\n7. display names now fold too, not just Dutchie names');
  on('Baseline', 'Hillsboro',   '"Baseline" -> Hillsboro');
  on('Portland', 'Portland Rd', '"Portland" -> Portland Rd');
  on('River',    'River Rd',    '"River" -> River Rd');

  console.log('\n8. everything from PART 1 still holds with the registry loaded');
  on('Portland Rd - Green Cross Cannabis Emporium', 'Portland Rd', 'suffix strip still applies first');
  on('bend',              'Bend',        'case-insensitive exact match');
  on('Center St Suite 200','Center',     'registry misses, hand-written prefix rule still catches it');
  on('Portland Roadhouse','Portland Rd', 'and the Portland prefix rule');
  on('Nowhere',           'Nowhere',     'unknown store still passes through');
  on('',                  '',            'empty stays empty');
  on(null,                '',            'null stays empty');

  console.log('\n9. short codes resolve, and the client refuses to guess');
  on('CEN', 'Bend',   'short_code resolves via the registry');
  const amb = GXStores.resolve('nonsense-not-a-store');
  if (amb === null) { pass++; console.log('  PASS  an unknown string resolves to null rather than a wrong store'); }
  else { fail++; console.log('  FAIL  expected null, got ' + JSON.stringify(amb)); }
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exit(fail ? 1 : 0);

})();
