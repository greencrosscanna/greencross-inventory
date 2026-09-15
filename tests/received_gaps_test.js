#!/usr/bin/env node
/* ─── computeReceivedGaps — tests ──────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/received_gaps_test.js     (from the repo root; no deps, no network)
 *
 * The Flags tab's "Received this week" section joins Dutchie's receiving history (which carries neither
 * brand nor vendor) to the inventory rows (which have no receive date) on SKU. The join is the whole
 * feature, so this RUNS the function lifted out of index.html against synthetic rows, the same way
 * name_typo_test.js does. If the extraction stops matching, it exits 2 rather than passing vacuously.
 *
 * The asymmetry between the two gaps is the part worth pinning: brand lives on the PRODUCT, so it is
 * judged across every store; vendor lives on the PACKAGE, so it is judged only at the stores this
 * delivery went to. Getting that backwards would flag a store that never received the thing.
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
const RECV_SRC    = lift(/\/\/ == Received this week with a gap =[\s\S]*?\/\/ == end received with a gap =/,
                         'the received-with-a-gap block');

function run(inventory, received, ok = {}) {
  const state = { inventoryData: inventory, receivedRecent: { rows: received } };
  return new Function('state', 'getDqOkObj',
    TRACKED_SRC + '\n' + SKUKEY_SRC + '\n' + RECV_SRC + '\nreturn computeReceivedGaps();')(state, () => ok);
}
const inv = (sku, name, brand, store = 'Bend', qty = 5, vendor = 'Acme Distro') =>
  ({ sku, name, brand, vendor, store, qty, qty28: 2, category: 'Vape' });
const rcv = (sku, product, store = 'Bend', receivedOn = '2026-09-12', vendor = 'Acme Distro') =>
  ({ sku, product, store, receivedOn, vendor, packageId: 'PKG' + sku });

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok   ' + label);
  else { fails++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}

console.log('computeReceivedGaps');
{
  const out = run(
    [inv('1', 'Blue Dream Cart | 1g', ''), inv('2', 'Gelato Cart | 1g', 'Mule Extracts')],
    [rcv('1', 'Blue Dream Cart | 1g'), rcv('2', 'Gelato Cart | 1g')]);
  check('flags a received product with no brand, and only that one',
        out.rows.length === 1 && out.rows[0].sku === '1' && out.rows[0].missing === 'no brand', JSON.stringify(out.rows));
  check('carries the receipt vendor and date', out.rows[0].vendors[0] === 'Acme Distro' && out.rows[0].receivedOn === '2026-09-12');
}
// ── vendor, which is a property of the package ───────────────────────────────
{
  const out = run([inv('1', 'Cart', 'Mule Extracts', 'Bend', 5, '')], [rcv('1', 'Cart')]);
  check('flags a delivery whose store row has no vendor', out.rows.length === 1 && out.rows[0].missing === 'no vendor');
}
{
  const out = run([inv('1', 'Cart', '', 'Bend', 5, '')], [rcv('1', 'Cart')]);
  check('names both gaps when both are blank', out.rows.length === 1 && out.rows[0].missing === 'no brand and no vendor');
}
{
  // Bend has the vendor, Center does not -- but the week's delivery went to Bend.
  const out = run([inv('1', 'Cart', 'Mule Extracts', 'Bend'), inv('1', 'Cart', 'Mule Extracts', 'Center', 5, '')],
                  [rcv('1', 'Cart', 'Bend')]);
  check('a blank vendor at a store that did NOT receive it is not this section\'s business',
        out.rows.length === 0, JSON.stringify(out.rows));
}
{
  const out = run([inv('1', 'Cart', 'Mule Extracts', 'Bend', 5, ''), inv('1', 'Cart', 'Mule Extracts', 'Center')],
                  [rcv('1', 'Cart', 'Bend')]);
  check('...but a blank vendor at the store that DID receive it is flagged, even though another store has one',
        out.rows.length === 1 && out.rows[0].missing === 'no vendor');
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
