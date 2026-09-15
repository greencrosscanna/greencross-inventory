#!/usr/bin/env node
/* ─── computeNameTypos — tests ────────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/name_typo_test.js     (from the repo root; no deps, no network, no credentials)
 *
 * The Flags tab lists product-name typos because names are the one piece of catalog data a customer
 * sees. The detector is tuned hard AGAINST false positives: the first, looser version flagged 191 words
 * on live data and nearly all were strain names being creative on purpose. So this file pins both
 * directions -- the real typos found live on 2026-09-08/09 must be caught, and the real strain names
 * that fooled the loose version must not be.
 *
 * Unlike most suites here, this one RUNS the function rather than reading it as text: the block between
 * the "Product-name typos" markers is lifted out of index.html and executed against synthetic rows. If
 * the extraction stops matching, the test exits 2 rather than passing vacuously.
 */
'use strict';
const fs = require('fs');
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
const TRACKED_SRC = lift(/function dqIsTracked_\(p\) \{[\s\S]*?\n\}/, 'function dqIsTracked_');
const TYPO_SRC    = lift(/\/\/ == Product-name typos =+[\s\S]*?\/\/ == end product-name typos =+/, 'the product-name typo block');

function run(rows, ok = {}, asOfMs = Date.now()) {
  const state = { inventoryData: rows, inventoryAsOfMs: asOfMs };
  return new Function('state', 'getDqOkObj',
    TRACKED_SRC + '\n' + TYPO_SRC + '\nreturn computeNameTypos();')(state, () => ok);
}

// Filler so the right spellings are COMMON, the way they are in the real catalog.
const STORES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River Rd'];
let skuN = 0;
function rowsFor(name, { qty = 5, stores = ['Bend'] } = {}) {
  const sku = 'SKU' + (++skuN);
  return stores.map(store => ({ name, sku, store, qty, qty28: 3, category: 'Pre-Roll' }));
}
const filler = [];
const STRAINS = ['Blue Dream', 'Gelato', 'Wedding Cake', 'Zkittlez', 'Sour Diesel', 'Lemon Haze',
                 'Mango Kush', 'Grape Ape', 'Cherry Pie', 'Tangie', 'Durban', 'Jack Herer'];
for (const s of STRAINS) {
  filler.push(...rowsFor(`${s} Live Resin Disposable AIO | 1g`));
  filler.push(...rowsFor(`Animal ${s} FATTY | 1g`));
  filler.push(...rowsFor(`${s} Runtz Live Rosin | 1g`));
}

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok   ' + label);
  else { fails++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}
const names = out => out.map(x => x.name);

console.log('computeNameTypos');

// ── the real typos ───────────────────────────────────────────────────────────
{
  const out = run(filler.concat(
    rowsFor('Anmal Cookies FATTY | 1g'),                               // 2026-09-08, the task's example
    rowsFor('Supreme Lee Hi Live Resin Disposabale AIO | 1g'),         // 2026-09-09, extra letter
    rowsFor('Strawnana Live Resin Disosable AIO | 2g'),                // 2026-09-09, dropped letter
    rowsFor('Blue Dream Live Resin Dipsosable AIO | 1g'),              // swapped neighbors
  ));
  const by = n => out.find(x => x.name === n) || {};
  check('catches "Anmal" and suggests Animal', by('Anmal Cookies FATTY | 1g').suggested === 'Animal Cookies FATTY | 1g',
        JSON.stringify(by('Anmal Cookies FATTY | 1g')));
  check('catches an extra letter (Disposabale)', by('Supreme Lee Hi Live Resin Disposabale AIO | 1g').good === 'Disposable');
  check('catches a dropped letter (Disosable)', by('Strawnana Live Resin Disosable AIO | 2g').good === 'Disposable');
  check('catches swapped letters (Dipsosable)', by('Blue Dream Live Resin Dipsosable AIO | 1g').good === 'Disposable');
  check('flags nothing else', out.length === 4, names(out).join(' / '));
}

// ── a misspelled strain, caught by its sibling ───────────────────────────────
{
  const out = run(filler.concat(
    rowsFor('Mega Runtz Live Rosin | 1g'),
    rowsFor('Mega Rntz #1 Live Rosin | 1g'),
  ));
  const x = out.find(r => r.name === 'Mega Rntz #1 Live Rosin | 1g');
  check('sibling: Rntz next to Runtz is flagged', x && x.suggested === 'Mega Runtz #1 Live Rosin | 1g', JSON.stringify(out));
  check('sibling: the correct one is not', !names(out).includes('Mega Runtz Live Rosin | 1g'));
}

// ── same name, two spellings ─────────────────────────────────────────────────
{
  const out = run(filler.concat(
    rowsFor('Smash Burger Live Resin | 1g', { stores: ['Bend', 'Center', 'Hillsboro'] }),
    rowsFor('Smashburger Live Resin | 1g'),
  ));
  const x = out.find(r => r.name === 'Smashburger Live Resin | 1g');
  check('spelling: minority variant flagged, majority suggested', x && x.suggested === 'Smash Burger Live Resin | 1g', JSON.stringify(out));
  check('spelling: majority variant not flagged', !names(out).includes('Smash Burger Live Resin | 1g'));
}

// ── what the loose version got wrong — must stay quiet ───────────────────────
{
  const out = run(filler.concat(
    rowsFor('Zour Pie Hybrid Crumble | 1g'),            // substitution, not a slip
    rowsFor('Gruntz x Cherry Joint | 1g'),              // extra FIRST letter
    rowsFor('Kushy Mintz Live Resin | 1g'),             // extra LAST letter
    rowsFor("Randys Classics (wired papers)"),          // apostrophe only
    rowsFor('$1.00 | Brass Screens 3/4" | 7570'),
    rowsFor('$12.00 | Silicone Leaf Hand Pipe | 4PSILLWAF'),  // item code, one letter off its sibling
    rowsFor('$12.00 | Silicone Leaf Hand Pipe | 4PSILLEAF'),
    rowsFor('$30.00 | Ash Catcher 90 Degrees | GA1824-90'),   // differs only in the code
    rowsFor('$30.00 | Ash Catcher 90 Degrees | GA182490'),
    rowsFor('$3.00 | Pulsar Chillum | PP1315'),                            // live 2026-09-09: told to drop
    rowsFor('3.00 | Pulsar Chillum | PP1315', { stores: ['Bend', 'Center'] }),  //   the "$" -- punctuation only
    rowsFor('Mint Tropics  Live Resin Dank Tank | 2g'),                    // doubled space: invisible on a menu
    rowsFor('Mint Tropics Live Resin Dank Tank | 2g', { stores: ['Bend', 'Center'] }),
  ));
  check('creative strain names and item codes are not flagged', out.length === 0, names(out).join(' / '));
}

// ── scope ────────────────────────────────────────────────────────────────────
{
  const out = run(filler.concat(rowsFor('Anmal Cookies FATTY | 1g', { qty: 0 })));
  check('a sold-out typo is not flagged (not on the menu)', out.length === 0, names(out).join(' / '));
}
{
  const out = run(filler.concat(rowsFor('Anmal Cookies FATTY | 1g')), { 'typo:anmal': { ts: 1, by: 'x' } });
  check('"spelled right" silences the word everywhere', out.length === 0, names(out).join(' / '));
}
{
  const out = run(filler.concat(rowsFor('Mega Runtz Live Rosin | 1g'), rowsFor('Mega Rntz #1 Live Rosin | 1g')),
                  { 'typoname:mega rntz #1 live rosin | 1g': { ts: 1, by: 'x' } });
  check('"not a typo" silences that one product', out.length === 0, names(out).join(' / '));
}
{
  const out = run(filler.concat(rowsFor('Anmal Cookies SAMPLE | 1g')));
  check('samples are excluded, as everywhere else in the app', out.length === 0, names(out).join(' / '));
}
{
  const out = run(filler.concat(rowsFor('Anmal Cookies FATTY | 1g', { stores: STORES })));
  check('one row per product, listing every store it is on', out.length === 1 && out[0].stores.length === 6);
}

// ── "fixed ✓" ────────────────────────────────────────────────────────────────
// Hides a row only until data newer than the fix arrives. The failure it must never have is the quiet
// one: a typo still on the menu staying hidden forever because someone pressed a button once.
{
  const FIX = Date.parse('2026-09-15T14:00:00Z'), H = 3600 * 1000;
  const anmal = filler.concat(rowsFor('Anmal Cookies FATTY | 1g'));
  const mark = { ['typofixed:anmal cookies fatty | 1g@' + FIX]: { ts: FIX, by: 'x' } };
  const older = run(anmal, mark, FIX - 10 * H);        // this morning's snapshot, fixed this afternoon
  check('"fixed" hides the row while the data predates the fix', older.length === 0, names(older).join(' / '));
  check('...and counts it, so the screen can say so', older.fixedPending === 1, String(older.fixedPending));
  const soon = run(anmal, mark, FIX + 5 * 60 * 1000);   // live Refresh 5 minutes later: Dutchie may lag
  check('"fixed" still hides it inside the grace period', soon.length === 0);
  const later = run(anmal, mark, FIX + 12 * H);         // next snapshot, name still wrong
  check('a "fixed" typo still misspelled in newer data comes back', later.length === 1 && later.fixedPending === 0,
        names(later).join(' / '));
  const other = run(filler.concat(rowsFor('Anmal Cookies FATTY | 1g'), rowsFor('Blue Dream Live Resin Dipsosable AIO | 1g')),
                    mark, FIX - H);
  check('"fixed" hides only that product', other.length === 1 && other[0].name.indexOf('Dipsosable') >= 0,
        names(other).join(' / '));
  const two = run(anmal, Object.assign({ ['typofixed:anmal cookies fatty | 1g@' + (FIX - 48 * H)]: { ts: 1, by: 'x' } }, mark),
                  FIX - H);
  check('a spent older mark does not stop a newer one hiding it', two.length === 0);
}

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log('\nall passed');
