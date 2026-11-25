#!/usr/bin/env node
/* ─── computeFattySupply — tests ───────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/fatty_supply_test.js     (from the repo root; no deps, no network)
 *
 * The FATTY tab's supply card tells Tawny how many FATTYs we can sell in one week before something
 * runs out (door-buster planning). Dutchie does not record end-of-jar flower or rolling, so output is
 * IMPLIED: made = sold + change in on-hand. Sales arrive as trailing 7/14/21/28-day totals per product
 * (GX Core velocity), on-hand as daily snapshot totals. This RUNS the function lifted out of
 * index.html against synthetic data. If the extraction stops matching, it exits 2 rather than
 * passing vacuously.
 *
 * Pinned:
 *   - trailing totals are differenced into weekly buckets (week 1 = most recent)
 *   - snapshots are read at today - 7k, falling back up to 2 days earlier; a missing one skips that week
 *   - a transfer between stores nets to zero at chain level
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
const { computeFattySupply, fattyHeadlineRates } = new Function(m[0] + '\nreturn { computeFattySupply, fattyHeadlineRates };')();

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok   ' + label);
  else { fails++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}
const near = (a, b) => Math.abs(a - b) < 1e-6;
const TODAY = '2026-11-16';
// snapshot points: today, -7, -14, -21, -28
const D = ['2026-11-16', '2026-11-09', '2026-11-02', '2026-10-26', '2026-10-19'];
const snapsOf = qtys => { const o = {}; qtys.forEach((q, i) => { if (q != null) o[D[i]] = q; }); return o; };

console.log('implied output');
{
  // Bend sells 70, 60, 50, 40 per week (most recent first). On hand (newest first): 450, 470, 480, 500, 520.
  const sup = {
    today: TODAY,
    lines: [{ store: 'Bend', name: 'A FATTY', qty: 450, cost: 954 }],
    sales: { lineQ: { Bend: { 'A FATTY': [70, 130, 180, 220] } } },
    snapDaily: { Bend: snapsOf([450, 470, 480, 500, 520]) },
  };
  const s = computeFattySupply(sup, ['Bend']);
  check('four weeks, oldest first', s.chainWeeks.length === 4 && s.chainWeeks[3].end === TODAY, JSON.stringify(s.chainWeeks.map(w => w.end)));
  check('trailing totals differenced into weekly sold', [40, 50, 60, 70].every((v, i) => near(s.chainWeeks[i].sold, v)), JSON.stringify(s.chainWeeks.map(w => w.sold)));
  check('made = sold + change on hand', [20, 30, 50, 50].every((v, i) => near(s.chainWeeks[i].made, v)), JSON.stringify(s.chainWeeks.map(w => w.made)));
  check('chain made/wk is the average', near(s.chain.madePerWk, 37.5), String(s.chain.madePerWk));
  check('selling/wk from 28 days', near(s.chain.perWk, 55));
  check('weeks of cover = on hand / weekly sales', near(s.chain.coverWeeks, 450 / 55));
  check('cost carried', s.chain.cost === 954);
}

console.log('missing snapshots');
{
  const sup = {
    today: TODAY, lines: [], sales: { lineQ: { Bend: { X: [7, 14, 21, 28] } } },
    // -7 missed, but -8 exists (fallback); -14 and its two fallbacks missing
    snapDaily: { Bend: { '2026-11-16': 100, '2026-11-08': 100, '2026-10-26': 100, '2026-10-19': 100 } },
  };
  const s = computeFattySupply(sup, ['Bend']);
  const ends = s.chainWeeks.map(w => w.end);
  check('falls back up to 2 days earlier', ends.includes('2026-11-16'), JSON.stringify(ends));
  check('a week with no snapshot in reach is skipped', s.chainWeeks.length === 2, JSON.stringify(ends));
  check('8-day interval normalized to a week', near(s.chainWeeks.find(w => w.end === '2026-11-16').delta, 0));
}

console.log('transfers net out at chain');
{
  // River makes 100 and ships 60 to Bend. Neither sells.
  const sup = {
    today: TODAY,
    lines: [{ store: 'Bend', name: 'X FATTY', qty: 160 }, { store: 'River Rd', name: 'X FATTY', qty: 140 }],
    sales: { lineQ: {} },
    snapDaily: { Bend: snapsOf([160, 100]), 'River Rd': snapsOf([140, 100]) },
  };
  const s = computeFattySupply(sup, ['Bend', 'River Rd']);
  const bend = s.storeRows.find(r => r.store === 'Bend'), river = s.storeRows.find(r => r.store === 'River Rd');
  check('per store shows the transfer as made/lost', near(bend.madePerWk, 60) && near(river.madePerWk, 40));
  check('chain shows only real output', near(s.chain.madePerWk, 100), String(s.chain.madePerWk));
}

console.log('partial chain week');
{
  const sup = {
    today: TODAY, lines: [], sales: { lineQ: {} },
    snapDaily: { Bend: snapsOf([10, 10, 10]), Center: snapsOf([10, 10, null]) },
  };
  const s = computeFattySupply(sup, ['Bend', 'Center']);
  check('week with a missing store marked partial', s.chainWeeks[0].complete === false && s.chainWeeks[1].complete === true);
  check('headline only averages complete weeks', s.chain.weeksAveraged === 1);
}

console.log('door-buster ceiling and flags');
{
  // Bend: 70 on hand, sells 35/wk (2 wks). Center: 400 on hand, sells 50/wk (8 wks).
  const q = n => [n / 4, n / 2, n * 3 / 4, n];
  const sup = {
    today: TODAY,
    lines: [
      { store: 'Bend', name: 'Chicken FATTY', qty: 60 }, { store: 'Bend', name: 'Marker FATTY', qty: 10 },
      { store: 'Center', name: 'Chicken FATTY', qty: 395 }, { store: 'Center', name: 'Dud FATTY', qty: 5 },
      { store: 'Center', name: 'Gone FATTY', qty: 0 } ],
    sales: { lineQ: {
      Bend: { 'Chicken FATTY': q(100), 'Marker FATTY': q(40) },
      Center: { 'Chicken FATTY': q(196), 'Gone FATTY': q(4) } } },
    snapDaily: {},
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

console.log('hero tile rates (2026-11-24: hero said 322 sold / 248 added, real was 585 / 562)');
{
  const s = { chain: { perWk: 585, madePerWk: 562 }, storeRows: [{ store: 'Bend', perWk: 167, madePerWk: 228 }, { store: 'Quiet', perWk: 0, madePerWk: null }] };
  const all = fattyHeadlineRates(s, 'All stores', 322, 248);
  check('All stores uses real chain sales and implied output', all.real && all.sold === 585 && all.made === 562, JSON.stringify(all));
  const bend = fattyHeadlineRates(s, 'Bend', 50, 40);
  check('a store uses its own row', bend.real && bend.sold === 167 && bend.made === 228, JSON.stringify(bend));
  const quiet = fattyHeadlineRates(s, 'Quiet', 5, 3);
  check('a store with no sales keeps the chart fallback', !quiet.real && quiet.sold === 5 && quiet.made === 3, JSON.stringify(quiet));
  const none = fattyHeadlineRates(null, 'All stores', 322, 248);
  check('older payload (no supply) keeps the chart fallback', !none.real && none.sold === 322 && none.made === 248);
  const noMade = fattyHeadlineRates({ chain: { perWk: 585, madePerWk: null }, storeRows: [] }, 'All stores', 322, 248);
  check('real sales with no implied output keeps fallback made', noMade.sold === 585 && noMade.made === 248, JSON.stringify(noMade));
  const neg = fattyHeadlineRates({ chain: { perWk: 100, madePerWk: -30 }, storeRows: [] }, 'All stores', 0, 0);
  check('negative implied output (write-offs) reads as 0, not "adding −30"', neg.made === 0);
}

if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
console.log('\nall passed');
