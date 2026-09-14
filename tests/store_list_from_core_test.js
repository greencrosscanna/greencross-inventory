#!/usr/bin/env node
/* A store added or closed in the Command Center has to reach this app without a code change.
 *
 * Three places hardcoded the store list until v3.053: the server's STORES array (about twenty loops,
 * including the nightly snapshot), the filter buttons in index.html (relabeled from GX Core, never
 * added or removed), and a Salem-only set that drove transfer-time estimates.
 *
 * Like the rest of this repo's suites, the functions are lifted out of the source as text and run.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const GS = fs.readFileSync(path.join(ROOT, 'dutchie_proxy.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name); } }
function lift(src, re, label) { const m = src.match(re); if (!m) { console.log('  FAIL could not find ' + label); process.exit(1); } return m[0]; }

// ── server: STORES is read, not written down ─────────────────────────────────────────────────
console.log('1. server store list');
check('STORES is not a hardcoded array literal', !/const STORES\s*=\s*\[/.test(GS));
check('STORES comes from loadStoreNames_()', /const STORES\s*=\s*loadStoreNames_\(\)/.test(GS));

const FALLBACK_SRC = lift(GS, /const STORES_FALLBACK_ = \[[^\]]*\];/, 'STORES_FALLBACK_');
const PROP_SRC = lift(GS, /const GX_STORE_NAMES_PROP_ = '[^']+';/, 'GX_STORE_NAMES_PROP_');
const LOAD_SRC = lift(GS, /function loadStoreNames_\(\) \{[\s\S]*?\n\}/, 'loadStoreNames_');
const SYNC_SRC = lift(GS, /function syncStoreNames_\(ordered\) \{[\s\S]*?\n\}/, 'syncStoreNames_');

function makeProps(initial) {
  const store = Object.assign({}, initial), writes = [];
  return { store, writes, api: { getScriptProperties: () => ({
    getProperty: k => (k in store ? store[k] : null),
    setProperty: (k, v) => { writes.push([k, v]); store[k] = v; },
  }) } };
}
function build(props) {
  const logs = [];
  const fns = new Function('PropertiesService', '_logGasError',
    FALLBACK_SRC + PROP_SRC + LOAD_SRC + SYNC_SRC + '\nreturn { loadStoreNames_, syncStoreNames_ };')(props.api, (f, m) => logs.push(f + ': ' + m));
  return Object.assign(fns, { logs });
}

let p = makeProps({});
check('never written → the six-store fallback', JSON.stringify(build(p).loadStoreNames_()) === JSON.stringify(['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River Rd']));

p = makeProps({ GX_STORE_NAMES_JSON: JSON.stringify(['Bend', 'Center', 'Salem North']) });
check('a written list is used as-is, including a new store', build(p).loadStoreNames_().includes('Salem North'));

p = makeProps({ GX_STORE_NAMES_JSON: '[]' });
check('an empty list is ignored, never blanking every loop', build(p).loadStoreNames_().length === 6);
p = makeProps({ GX_STORE_NAMES_JSON: '{not json' });
check('an unreadable list falls back rather than throwing', build(p).loadStoreNames_().length === 6);

p = makeProps({});
let f = build(p);
f.syncStoreNames_([{ dn: 'River Rd', order: 6 }, { dn: 'Bend', order: 1 }, { dn: 'New Store', order: 7 }]);
check('sync writes names in sort_order', p.store.GX_STORE_NAMES_JSON === JSON.stringify(['Bend', 'River Rd', 'New Store']));
f.syncStoreNames_([{ dn: 'Bend', order: 1 }, { dn: 'River Rd', order: 6 }, { dn: 'New Store', order: 7 }]);
check('an unchanged list is not rewritten', p.writes.length === 1);
f.syncStoreNames_([{ dn: 'Bend', order: 1 }]);
check('a closed store drops out', p.store.GX_STORE_NAMES_JSON === JSON.stringify(['Bend']));
f.syncStoreNames_([]);
check('an empty result never overwrites the list', p.store.GX_STORE_NAMES_JSON === JSON.stringify(['Bend']));

const throwing = { api: { getScriptProperties: () => { throw new Error('quota'); } } };
f = build(throwing);
let threw = false;
try { f.syncStoreNames_([{ dn: 'Bend', order: 1 }]); } catch (e) { threw = true; }
check('a property failure is logged, never thrown into the key lookup', !threw && f.logs.length === 1);

const KEYS_SRC = lift(GS, /function getDutchieStoreKeys_\(\) \{[\s\S]*?\n\}/, 'getDutchieStoreKeys_');
check('only stores with a Dutchie key are recorded', /if \(dn && byStoreId\[id\]\) \{[^}]*ordered\.push/.test(KEYS_SRC) && /syncStoreNames_\(ordered\)/.test(KEYS_SRC));

// ── page: filter buttons and transfer days ───────────────────────────────────────────────────
console.log('\n2. filter buttons');
check('the live store list rebuilds the buttons', /STORE_BY_NAME = Object\.fromEntries\(STORES\.map\(s => \[s\.name, s\]\)\);\s*renderStorePills\(\);/.test(HTML));
check('button clicks are delegated, so rebuilt buttons still work', /getElementById\('storePills'\)\.addEventListener\('click'/.test(HTML));

console.log('\n3. transfer days');
const REGION_SRC = lift(HTML, /const STORE_REGION_FALLBACK = \{[^}]*\};/, 'STORE_REGION_FALLBACK');
const DAYS_SRC = lift(HTML, /function storeRegion\(name\)[^\n]*\nfunction transferDays\(a, b\) \{[\s\S]*?\n\}/, 'transferDays');
const mk = (byName) => new Function('STORE_BY_NAME', REGION_SRC + DAYS_SRC + '\nreturn transferDays;')(byName);

const OLD_SALEM = new Set(['Center', 'Commercial', 'Portland Rd', 'River Rd']);
const SIX = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River Rd'];
const live = { Bend: { region: 'Bend' }, Center: { region: 'Salem' }, Commercial: { region: 'Salem' }, Hillsboro: { region: 'Hillsboro' }, 'Portland Rd': { region: 'Salem' }, 'River Rd': { region: 'Salem' } };
for (const [label, byName] of [['before GX Core answers', {}], ['with the live registry', live]]) {
  const td = mk(byName);
  let same = true;
  for (const a of SIX) for (const b of SIX) if (a !== b && td(a, b) !== ((OLD_SALEM.has(a) && OLD_SALEM.has(b)) ? 3 : 7)) same = false;
  check('today\'s six stores get the same estimates as the old Salem list, ' + label, same);
}
const td = mk(Object.assign({}, live, { 'Keizer Station': { region: 'Salem' }, Hillsboro: { region: 'Salem' } }));
check('a new Salem store gets 3 days', td('Keizer Station', 'River Rd') === 3);
check('a re-regioned store follows the registry', td('Hillsboro', 'Center') === 3);
check('an unknown store gets the long estimate', td('Nowhere', 'Center') === 7);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
