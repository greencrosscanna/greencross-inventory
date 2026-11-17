#!/usr/bin/env node
/* ─── Shake-by-harvest-year (FATTY tab) — tests ────────────────────────────────────────────────
 *
 *   RUN:  node tests/fatty_shake_test.js     (from the repo root; no deps, no network)
 *
 * Shake is work-in-progress pre-rolls, so the FATTY tab shows it by harvest year. This RUNS the
 * functions lifted out of dutchie_proxy.gs and index.html. If extraction stops matching, it exits 2
 * rather than passing vacuously.
 *
 * Pinned:
 *   - isShakeItem_ takes the "Cannabis Bulk Shake" category and "… | SHAKE" names filed as flower,
 *     and NOT a strain merely named Shake ("Shake Shack")
 *   - the harvest-date cache round-trips through several Script Properties, each under 9 KB,
 *     and still reads a map written by the old single-property code
 *   - the card sums grams/cost across stores, filters to one store, and renders nothing for an
 *     old payload without d.shake
 */
'use strict';
const fs = require('fs');
const gs = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');

function lift(src, re, what) {
  const m = src.match(re);
  if (!m) { console.error('EXTRACTION FAILED: ' + what + ' moved or changed shape. Update the pattern -- do not delete the test.'); process.exit(2); }
  return m[0];
}
const shakeSrc = lift(gs, /function isShakeItem_\(it\) \{[\s\S]*?\n\}/, 'isShakeItem_');
const mapSrc = lift(gs, /const HARVEST_SHARD_CHARS[\s\S]*?\nfunction _setHarvestMap\(map\) \{[\s\S]*?\n\}/, '_getHarvestMap/_setHarvestMap');
const cardSrc = lift(html, /function fattyShakeCard\(d, sel\) \{[\s\S]*?\n\}/, 'fattyShakeCard');

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok   ' + label);
  else { fails++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}

// ── isShakeItem_
const isShakeItem_ = new Function(shakeSrc + '\nreturn isShakeItem_;')();
check('bulk shake category matches', isShakeItem_({ productName: 'Blue Dream | Shake', category: 'Cannabis Bulk Shake' }));
check('"| SHAKE" name under flower matches', isShakeItem_({ productName: 'Lemonchello | SHAKE', category: 'Bulk Cannabis Flower' }));
check('"Shake Shack" flower does not match', !isShakeItem_({ productName: 'Shake Shack', category: 'Bulk Cannabis Flower', masterCategory: 'Flower' }));
check('FATTY pre-roll does not match', !isShakeItem_({ productName: 'Animal Cookies FATTY | 1g', category: 'Infused Pre-Rolls' }));

// ── harvest map sharding against a fake PropertiesService
const store = {};
const PropertiesService = { getScriptProperties: () => ({
  getProperty: k => (k in store ? store[k] : null),
  setProperty: (k, v) => { if (v.length > 9000) throw new Error('Argument too large: value'); store[k] = v; },
  deleteProperty: k => { delete store[k]; },
}) };
const _logGasError = (w, m) => { throw new Error(w + ': ' + m); };
const api = new Function('PropertiesService', '_logGasError',
  "const HARVEST_BY_BATCH_KEY = 'gc_harvest_by_batch';\n" + mapSrc + '\nreturn { get: _getHarvestMap, set: _setHarvestMap };')(PropertiesService, _logGasError);

store.gc_harvest_by_batch = JSON.stringify({ '1A4OLD0000000000000001': '2024-09-30' });
check('reads a map written by the old single-property code', api.get()['1A4OLD0000000000000001'] === '2024-09-30');

const big = {};
for (let i = 0; i < 700; i++) big['1A4' + String(i).padStart(21, '0')] = (2024 + (i % 3)) + '-10-01';
api.set(big);
const keys = Object.keys(store).filter(k => k.startsWith('gc_harvest_by_batch'));
check('700 batches spread over several properties', keys.length >= 3, 'got ' + keys.length);
check('every property under 9 KB', keys.every(k => store[k].length <= 9000));
const back = api.get();
check('round-trips all 700 batches', Object.keys(back).length === 700 && back['1A4' + '0'.padStart(21, '0')] === '2024-10-01');

// ── fattyShakeCard
const fattyShakeCard = new Function('fattyColor', 'fattyFmt', 'storeDisplay', 'escapeHtml', cardSrc + '\nreturn fattyShakeCard;')(
  v => '#000', n => Math.round(n).toLocaleString('en-US'), s => s, s => String(s));
const d = { shake: {
  vintages: ['2024', '2025', 'Unknown'],
  current: { Bend: { '2024': 1000, '2025': 500 }, Hillsboro: { '2024': 200, 'Unknown': 50 } },
  cost: { Bend: { '2024': 1200, '2025': 700 }, Hillsboro: { '2024': 250, 'Unknown': 40 } },
} };
const all = fattyShakeCard(d, 'All stores');
check('all stores: 2024 = 1,200 g', all.includes('1,200 g'));
check('all stores: total 1,750 g', all.includes('1,750 g'));
check('oldest dated vintage tagged USE FIRST', /2024 harvest[\s\S]*?USE FIRST/.test(all));
check('missing harvest date shown', all.includes('Harvest date missing'));
const hb = fattyShakeCard(d, 'Hillsboro');
check('one store: Hillsboro total 250 g', hb.includes('250 g') && !hb.includes('1,750 g'));
check('old payload without shake renders nothing', fattyShakeCard({}, 'All stores') === '');

d.shake.vintages = ['2024', '2025', '2029', 'Unknown'];
d.shake.current.Hillsboro['2029'] = 35; d.shake.cost.Hillsboro['2029'] = 19;
d.shake.fix = [
  { store: 'Hillsboro', product: 'Goofiez | Shake', batch: '1A4TESTBATCH2029', harvestDate: '2029-10-01', grams: 35 },
  { store: 'Bend', product: 'MAC | Shake', batch: '', harvestDate: '', grams: 12 },
];
const fx = fattyShakeCard(d, 'All stores');
check('future harvest year tagged BAD DATE', /2029 harvest[\s\S]*?BAD DATE/.test(fx));
check('bad-date batch named with its Metrc tag', fx.includes('1A4TESTBATCH2029') && fx.includes('Goofiez | Shake') && fx.includes('2029-10-01'));
check('missing-date batch listed as missing', fx.includes('MAC | Shake') && fx.includes('missing'));
const fxB = fattyShakeCard(d, 'Bend');
check('fix list follows the store pick', fxB.includes('MAC | Shake') && !fxB.includes('1A4TESTBATCH2029'));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
