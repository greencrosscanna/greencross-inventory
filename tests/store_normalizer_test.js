#!/usr/bin/env node
/* ─── normalizeStore — tests ──────────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/store_normalizer_test.js     (from the repo root; no deps, no network, no credentials)
 *
 * WHY THIS FUNCTION
 * Every row of live Dutchie data is filtered through normalizeStore before it reaches a view. If it
 * fails to fold a POS spelling onto our store name the row does not appear under that store, and the
 * number on screen is quietly low -- no error, no empty state, just a wrong total. That failure mode is
 * why it gets tests before anything prettier does.
 *
 * WHAT IT PINS
 * Half of these cases assert behaviour that is CORRECT, and half assert behaviour that is merely
 * CURRENT. The second group is labelled "gap" and is the point of the file: alias coverage here is
 * hand-written and partial, while GX Core's `stores` registry publishes an `aliases` column that is
 * meant to be the one list. Anyone consolidating the two should expect these to change, and will see
 * exactly which strings are affected instead of finding out from a wrong total.
 *
 * HOW IT LOADS THE REAL CODE
 * index.html is a monolith with inline JS and no module boundary, so the function and the STORES table
 * it closes over are lifted out of the shipped file by text match and evaluated together. It therefore
 * tests the real source, but it IS coupled to that source's shape: if the extraction below stops
 * matching, the test fails loudly rather than silently testing nothing.
 *
 * This file cannot reach Apps Script: .claspignore excludes tests/. Inventory pushes with rootDir "."
 * and does not exclude JS by extension, so that rule is doing real work -- keep it.
 */
'use strict';
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');

function lift(pattern, what) {
  const m = html.match(pattern);
  if (!m) {
    console.error('EXTRACTION FAILED: could not find ' + what + ' in index.html.');
    console.error('The source moved or changed shape. Update the pattern in this file -- do not delete the test.');
    process.exit(2);
  }
  return m[0];
}

const STORES_SRC = lift(/let STORES = \[[\s\S]*?\];/, 'the STORES table');
const FN_SRC     = lift(/function normalizeStore\(raw\) \{[\s\S]*?\n\}/, 'function normalizeStore');

const normalizeStore = new Function(STORES_SRC + '\n' + FN_SRC + '\nreturn normalizeStore;')();

let pass = 0, fail = 0;
const is = (input, want, label) => {
  const got = normalizeStore(input);
  if (got === want) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + `  (${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
};

// ── 1. the suffix Dutchie puts on every store name ───────────────────────────
console.log('\n1. strips the " - Green Cross Cannabis Emporium" suffix');
is('Portland Rd - Green Cross Cannabis Emporium', 'Portland Rd', 'Portland Rd with suffix');
is('River Rd - Green Cross Cannabis Emporium',    'River Rd',    'River Rd with suffix');
is('Bend - green cross cannabis emporium',        'Bend',        'suffix match is case-insensitive');
is('Bend  -  Green Cross Cannabis Emporium',      'Bend',        'tolerates padding around the dash');

// ── 2. the hand-written aliases ──────────────────────────────────────────────
console.log('\n2. folds known POS spellings onto our store names');
is('Center St',     'Center',      '"Center St" -> Center');
is('Portland Road', 'Portland Rd', '"Portland Road" -> Portland Rd');
is('Portland Rd',   'Portland Rd', '"Portland Rd" passes through unchanged');
is('River Rd',      'River Rd',    '"River Rd" passes through unchanged');

// These rules are PREFIX matches (/^Center\s*St/i), not exact ones, which is easy to misread as a
// bug and is in fact the useful behaviour -- it absorbs "Center Street" and any trailing detail the
// POS appends without needing a rule per spelling. The cost is that it also absorbs anything that
// merely STARTS that way, so a genuinely different store named "Center Stage" would be folded onto
// Center. No such store exists; if one is ever opened, this is the line that breaks.
is('center street',        'Center', 'prefix match absorbs "Center Street" for free');
is('Center St Suite 200',  'Center', 'and any trailing detail after the match');
is('Portland Roadhouse',   'Portland Rd', 'the same looseness applied to Portland -- documented, not endorsed');

// ── 3. exact match against the STORES table, case-insensitively ──────────────
console.log('\n3. matches the STORES table regardless of case');
is('bend',        'Bend',        'lowercase folds to the canonical name');
is('HILLSBORO',   'Hillsboro',   'uppercase folds to the canonical name');
is('Commercial',  'Commercial',  'exact name passes through');

// ── 4. what it does NOT know — the real remainder of the store-alias story ───
console.log('\n4. gaps: strings GX Core knows as aliases and this function does not');
is('Commercial St', 'Commercial St',
   'gap: "Commercial St" does NOT fold to Commercial -- there is no rule and no exact match');
is('South', 'South',
   'gap: "South" is the old name for the Commercial store and is not handled here');
is('Century', 'Century',
   'gap: "Century" is the DISPLAY name of the Bend store; this function keys on the Dutchie name only');
console.log('       ^ these three are recorded as current behaviour, not endorsed. GX Core publishes an');
console.log('         `aliases` column that covers them; folding this function onto it is the fix.');

// ── 5. degenerate input ──────────────────────────────────────────────────────
console.log('\n5. empty and unknown input');
is('',        '',        'empty string stays empty');
is(null,      '',        'null becomes empty rather than throwing');
is(undefined, '',        'undefined becomes empty rather than throwing');
is('  Bend  ', 'Bend',   'surrounding whitespace is trimmed');
is('Nowhere', 'Nowhere', 'an unknown store passes through unchanged rather than being dropped');

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
