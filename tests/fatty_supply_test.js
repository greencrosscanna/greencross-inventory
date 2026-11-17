#!/usr/bin/env node
/* ─── computeFattySupply — tests ───────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/fatty_supply_test.js     (from the repo root; no deps, no network)
 *
 * The FATTY tab's supply card tells Tawny how many FATTYs we can sell in one week before something
 * runs out (door-buster planning). Dutchie does not record end-of-jar flower or rolling, so output is
 * IMPLIED: made = sold + change in on-hand between weekly snapshots. This RUNS the function lifted out
 * of index.html against synthetic data. If the extraction stops matching, it exits 2 rather than
 * passing vacuously.
 *
 * Pinned:
 *   - a snapshot dated D is close of D-1, so the sales that belong between snapshots a and b are a <= day < b
 *   - a transfer between stores nets to zero at chain level
 *   - short hops (a snapshot gap, or the partial current week) are not counted as a week
 *   - the ceiling is limited by the thinnest store, and the first top line out is named
 */
'use strict';
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const m = html.match(/\/\/ == FATTY supply math =[\s\S]*?\/\/ == end FATTY supply math =/);
if (!m) {
  console.error('EXTRACTION FAILED: could not find the FATTY supply math block in index.html.');
  console.error('The source moved or changed shape. Update the pattern here -- do not delete the test.');
  process.exit(2);
}
const computeFattySupply = new Function(m[0] + '\nreturn computeFattySupply;')();

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok   ' + label);
  else { fails++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}
const near = (a, b) => Math.abs(a - b) < 1e-6;

// Days: snapshots on Mondays 2026-10-26, 11-02, 11-09, 11-16 (Mondays are week starts).
function days(from, to, qty) { // every day from..to inclusive at qty
  const out = {}; let d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out[d.toISOString().slice(0, 10)] = qty; d = new Date(d.getTime() + 86400000); } // @utc-ok test fixture, calendar-only
  return out;
}

console.log('implied output');
{
  // Bend sells 10/day. On-hand 500 → 480 → 470 → 450. Made per week = 70 + delta.
  const sup = {
    lines: [{ store: 'Bend', name: 'A FATTY', qty: 450, cost: 954 }],
    sales: { from: '2026-10-01', daily: { Bend: Object.assign(days('2026-10-01', '2026-11-15', 10), { '2026-11-16': 999 }) },
             line28: { Bend: { 'A FATTY': 280 } } },
    snapTotals: { Bend: {
      '2026-10-26': { date: '2026-10-26', qty: 500 }, '2026-11-02': { date: '2026-11-02', qty: 480 },
      '2026-11-09': { date: '2026-11-09', qty: 470 }, '2026-11-16': { date: '2026-11-16', qty: 450 } } },
  };
  const s = computeFattySupply(sup, ['Bend']);
  check('three full weeks', s.chainWeeks.length === 3, JSON.stringify(s.chainWeeks));
  check('sales window a <= day < b (today\'s partial 999 not counted)', near(s.chainWeeks[2].sold, 70), String(s.chainWeeks[2].sold));
  check('made = sold + change on hand', near(s.chainWeeks[0].made, 50) && near(s.chainWeeks[1].made, 60) && near(s.chainWeeks[2].made, 50));
  check('chain made/wk is the average', near(s.chain.madePerWk, 160 / 3), String(s.chain.madePerWk));
  check('selling/wk from 28 days', near(s.chain.perWk, 70));
  check('weeks of cover = on hand / weekly sales', near(s.chain.coverWeeks, 450 / 70));
  check('cost carried', s.chain.cost === 954);
}

console.log('transfers net out at chain');
{
  // River makes 100 and ships 60 to Bend. Neither sells.
  const snap = (a, b) => ({ '2026-11-09': { date: '2026-11-09', qty: a }, '2026-11-16': { date: '2026-11-16', qty: b } });
  const sup = {
    lines: [{ store: 'Bend', name: 'X FATTY', qty: 160 }, { store: 'River Rd', name: 'X FATTY', qty: 140 }],
    sales: { from: '2026-10-01', daily: {}, line28: {} },
    snapTotals: { Bend: snap(100, 160), 'River Rd': snap(100, 140) },
  };
  const s = computeFattySupply(sup, ['Bend', 'River Rd']);
  const bend = s.storeRows.find(r => r.store === 'Bend'), river = s.storeRows.find(r => r.store === 'River Rd');
  check('per store shows the transfer as made/lost', near(bend.madePerWk, 60) && near(river.madePerWk, 40));
  check('chain shows only real output', near(s.chain.madePerWk, 100), String(s.chain.madePerWk));
}

console.log('short hops and gaps');
{
  const sup = {
    lines: [], sales: { from: '2026-10-01', daily: {}, line28: {} },
    snapTotals: { Bend: {
      '2026-10-19': { date: '2026-10-19', qty: 100 },   // 21-day gap to the next point: not a week
      '2026-11-09': { date: '2026-11-09', qty: 90 },
      '2026-11-16': { date: '2026-11-16', qty: 80 } } },
  };
  const s = computeFattySupply(sup, ['Bend']);
  check('a three-week gap is skipped, the real week counted', s.chainWeeks.length === 1 && s.chainWeeks[0].end === '2026-11-16');
  const s2 = computeFattySupply({ lines: [], sales: { from: '2026-11-12', daily: {}, line28: {} }, snapTotals: sup.snapTotals }, ['Bend']);
  check('a week older than the sales history is skipped', s2.chainWeeks.length === 0);
}

console.log('partial chain week');
{
  const sup = {
    lines: [], sales: { from: '2026-10-01', daily: {}, line28: {} },
    snapTotals: {
      Bend: { a: { date: '2026-11-02', qty: 10 }, b: { date: '2026-11-09', qty: 10 }, c: { date: '2026-11-16', qty: 10 } },
      Center: { b: { date: '2026-11-09', qty: 10 }, c: { date: '2026-11-16', qty: 10 } } },
  };
  const s = computeFattySupply(sup, ['Bend', 'Center']);
  check('week with a missing store marked partial', s.chainWeeks[0].complete === false && s.chainWeeks[1].complete === true);
  check('headline only averages complete weeks', s.chain.weeksAveraged === 1);
}

console.log('door-buster ceiling and flags');
{
  // Bend: 70 on hand, sells 35/wk (2 wks). Center: 400 on hand, sells 50/wk (8 wks).
  const sup = {
    lines: [
      { store: 'Bend', name: 'Chicken FATTY', qty: 60 }, { store: 'Bend', name: 'Marker FATTY', qty: 10 },
      { store: 'Center', name: 'Chicken FATTY', qty: 395 }, { store: 'Center', name: 'Dud FATTY', qty: 5 },
      { store: 'Center', name: 'Gone FATTY', qty: 0 } ],
    sales: { from: '2026-10-01', daily: {}, line28: {
      Bend: { 'Chicken FATTY': 100, 'Marker FATTY': 40 },
      Center: { 'Chicken FATTY': 196, 'Gone FATTY': 4 } } },
    snapTotals: {},
  };
  const s = computeFattySupply(sup, ['Bend', 'Center']);
  check('sold-out line still counts toward store demand', near(s.storeRows[1].perWk, 50));
  check('thinnest store limits the ceiling', s.ceiling.limitStore === 'Bend' && near(s.ceiling.storeLift, 2));
  check('ceiling = chain weekly sales x thinnest cover', s.ceiling.byStore === 170, String(s.ceiling.byStore));
  check('first top line out named', s.ceiling.limitLine.name === 'Marker FATTY' && s.ceiling.limitLine.store === 'Bend');
  check('Marker: 10 on hand at 10/wk = 7 days, flagged', s.flagged.length === 1 && Math.floor(s.flagged[0].coverDays) === 7, JSON.stringify(s.flagged));
  check('lines with no sales are never flagged', !s.flagged.some(l => l.name === 'Dud FATTY'));
  check('zero-qty lines dropped', !s.flagged.concat(s.storeRows).some(l => l.name === 'Gone FATTY'));
}

console.log('missing payload');
check('no supply → null (card shows "arrives on next refresh")', computeFattySupply(undefined, []) === null);

if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
console.log('\nall passed');
