#!/usr/bin/env node
/* ─── computeReceivedNoBrand — tests ──────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/received_no_brand_test.js     (from the repo root; no deps, no network)
 *
 * The Flags tab's "Received this week without a brand" section joins Dutchie's receiving history (which
 * has no brand) to the inventory rows (which have no receive date) on SKU. The join is the whole
 * feature, so this RUNS the function lifted out of index.html against synthetic rows, the same way
 * name_typo_test.js does. If the extraction stops matching, it exits 2 rather than passing vacuously.
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
const SKUKEY_SRC  = lift(/function dqSkuKey\(sku\)[^\n]*/, 'function dqSkuKey');
const RECV_SRC    = lift(/\/\/ == Received this week without a brand =+[\s\S]*?\/\/ == end received without a brand =+/,
                         'the received-without-a-brand block');

function run(inventory, received, ok = {}) {
  const state = { inventoryData: inventory, receivedRecent: { rows: received } };
  return new Function('state', 'getDqOkObj',
    TRACKED_SRC + '\n' + SKUKEY_SRC + '\n' + RECV_SRC + '\nreturn computeReceivedNoBrand();')(state, () => ok);
}
const inv = (sku, name, brand, store = 'Bend', qty = 5) => ({ sku, name, brand, store, qty, qty28: 2, category: 'Vape' });
const rcv = (sku, product, store = 'Bend', receivedOn = '2026-09-12', vendor = 'Acme Distro') =>
  ({ sku, product, store, receivedOn, vendor, packageId: 'PKG' + sku });

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok   ' + label);
  else { fails++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}

console.log('computeReceivedNoBrand');
{
  const out = run(
    [inv('1', 'Blue Dream Cart | 1g', ''), inv('2', 'Gelato Cart | 1g', 'Mule Extracts')],
    [rcv('1', 'Blue Dream Cart | 1g'), rcv('2', 'Gelato Cart | 1g')]);
  check('flags a received product with no brand, and only that one',
        out.rows.length === 1 && out.rows[0].sku === '1', JSON.stringify(out.rows));
  check('carries the receipt vendor and date', out.rows[0].vendors[0] === 'Acme Distro' && out.rows[0].receivedOn === '2026-09-12');
}
{
  const out = run([inv('1', 'Cart', '', 'Bend'), inv('1', 'Cart', 'Mule Extracts', 'Center')], [rcv('1', 'Cart')]);
  check('a SKU branded at any store is not flagged (another section covers partial gaps)', out.rows.length === 0);
}
{
  const out = run([inv('1', 'Cart', '', 'Bend'), inv('1', 'Cart', '', 'Center')],
                  [rcv('1', 'Cart', 'Bend', '2026-09-10'), rcv('1', 'Cart', 'Center', '2026-09-13', 'Other Co')]);
  check('one row per SKU, with every receiving store, the latest date and every vendor',
        out.rows.length === 1 && out.rows[0].stores.length === 2 && out.rows[0].receivedOn === '2026-09-13'
        && out.rows[0].vendors.length === 2, JSON.stringify(out.rows));
}
{
  const out = run([inv('1', 'Cart', '')], [rcv('1', 'Cart'), rcv('9', 'Brand New Thing'), rcv('8', 'Another')]);
  check('SKUs not in the product data yet are counted, not silently dropped', out.notYetInData === 2 && out.rows.length === 1);
}
{
  const out = run([inv('1', 'Cart SAMPLE | 1g', '')], [rcv('1', 'Cart SAMPLE | 1g')]);
  check('samples are excluded', out.rows.length === 0);
}
{
  const out = run([inv('1', 'Cart', '')], [rcv('1', 'Cart')], { 'sku:1': { ts: 1, by: 'x' } });
  check('"skip" on a brand section skips it here too', out.rows.length === 0);
}
{
  const out = run([inv('1', 'Cart', '', 'Bend', 0)], [rcv('1', 'Cart')]);
  check('a sold-out delivery is still flagged: the catalog record is what gets fixed', out.rows.length === 1);
}

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log('\nall passed');
