#!/usr/bin/env node
/* Inventory is DISCONNECTED from the legacy "2026 GX2 Dashboard" workbook (Sky's call, 2026-08-30).
 * Everything it used to keep there — Vel Cache, Inv Snapshot, ProductCatalog, Product SKU Dict,
 * Operational Snapshot, Loading Quotes — now lives in "Green Cross — Inventory Data"
 * (INV_DATA_SS_ID); Decision Feed, Shared State and the "Config - *" tabs live in
 * BETA_SPREADSHEET_ID, which is production despite its name.
 *
 * Modelled on greencross-sales/tests/sheet_severance_test.js, and for the same reason: a severance
 * is an invariant, not a one-time edit, and it is unusually easy to undo by accident because
 * reaching for a spreadsheet is a one-liner and the workbook still exists. So this asserts the
 * ABSENCE — no workbook id, no constant holding it, no function handing it out, and no path that
 * can reach a spreadsheet this app has not named.
 *
 * Where it differs from Sales, deliberately:
 *
 *  - Sales can assert "no SpreadsheetApp call anywhere". Inventory cannot: it legitimately opens
 *    two workbooks it owns plus one it reads. So the invariant here is narrower but sharper —
 *    every openById() argument must resolve through the WORKBOOKS allowlist or the two named
 *    constants, and the only long bare id literals in the file must be those two constants. That
 *    is what makes "reaching for a spreadsheet" visible again: an inline id fails section 2.
 *
 *  - The dangerous leftovers here were not readers. They were the completed migration routes
 *    (migrateinvdata, copyinvsnap, deletemigrated) which opened the legacy workbook as their
 *    SOURCE — and deletemigrated deleted sheets inside it. A finished migration that still holds
 *    write access to what it migrated away from is the worst version of this, so section 4 keeps
 *    them gone at the function, the router and the write gate.
 *
 * Scopes are NOT asserted, same as Sales: the manifest still needs `spreadsheets`, both for the
 * workbooks above and because GXCore runs under this project's authorization.
 */
'use strict';
const fs = require('fs'), path = require('path');
const REPO = path.join(__dirname, '..');
const GS = fs.readFileSync(path.join(REPO, 'dutchie_proxy.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const GX2_ID = '1OBNzkBrJtLIlf8xknVlGd6Jb8nlkg4_KG-Gq6BD7HHY';
const INV_DATA_LABEL = 'INV_DATA_SS_ID';

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// Strip comments so the prose above (and the explanatory comments in the source, which name the
// thing they removed on purpose) cannot satisfy or trip these checks. Only executable code counts.
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = strip(GS);

// Argument text for every call to `name(`, with balanced parens — so getInvDataSpreadsheetId() is
// read whole rather than truncated at its own closing paren, which a plain /[^)]*/ does.
// `defs` is the argument list of the declaration itself, returned separately so a caller check
// isn't satisfied (or broken) by the function's own signature.
function callArgs(src, name) {
  const out = [], defs = [];
  const needle = name + '(';
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    let j = i + needle.length, depth = 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      if (depth > 0) j++;
    }
    const args = src.slice(i + needle.length, j).trim();
    const isDef = /function\s+$/.test(src.slice(Math.max(0, i - 12), i));
    (isDef ? defs : out).push(args);
    i = j;
  }
  return { calls: out, defs };
}

console.log('\n1. the legacy workbook is not named anywhere that runs');
{
  ok('the GX2 workbook id is gone from executable code', !code.includes(GX2_ID));
  ok('...and from index.html entirely', !HTML.includes(GX2_ID));
  ok('LIVE_SPREADSHEET_ID is no longer a constant', !/const\s+LIVE_SPREADSHEET_ID/.test(code));
  ok('the unused SPREADSHEET_ID alias is gone', !/const\s+SPREADSHEET_ID\b/.test(code));
  ok('getDataSpreadsheetId is gone, not merely unused', !/function\s+getDataSpreadsheetId\s*\(/.test(code));
  ok('...and nothing calls it', !/getDataSpreadsheetId\s*\(/.test(code));
}

console.log('\n2. no path can reach a workbook this app has not named');
{
  const allowed = new Set([
    'BETA_SPREADSHEET_ID',            // production: Decision Feed, Shared State, Config - *
    'SALES_HISTORY_SPREADSHEET_ID',   // read-only, owned elsewhere
    'getInvDataSpreadsheetId()',      // throws if INV_DATA_SS_ID is unset — never falls back
    'target.id',                      // resolved by workbookTarget_ from the WORKBOOKS allowlist
    'spreadsheetId',                  // sheetToObjects_' required parameter, guarded below
  ]);
  const args = callArgs(code, 'SpreadsheetApp.openById').calls;
  ok('there is at least one openById to check (the scan actually found the calls)', args.length > 0);
  const rogue = args.filter(a => !allowed.has(a));
  ok('every openById argument comes from a named workbook' + (rogue.length ? ' — rogue: ' + rogue.join(', ') : ''),
     rogue.length === 0);

  // An inline id would sail past the check above. The only long bare id literals in the file must
  // be the two workbook constants; anything else is a workbook someone pasted in.
  const lits = [...code.matchAll(/['"]([A-Za-z0-9_-]{30,})['"]/g)].map(m => m[1]);
  const knownIds = new Set(['1expq2qh9uRU51BdBKq_GmYgyHLrRhmryPtWjDJsWdxg',
                            '18f8iwnnMucXog5fMsLN2VwEoC6kFu3h-b8MDpZlc7ks']);
  const strayIds = lits.filter(l => !knownIds.has(l));
  ok('no stray spreadsheet-id literals' + (strayIds.length ? ' — found: ' + strayIds.join(', ') : ''),
     strayIds.length === 0);

  ok('the WORKBOOKS allowlist exists', /const\s+WORKBOOKS\s*=/.test(code));
  ok('...and is prototype-less, since it is indexed by user input',
     /const\s+WORKBOOKS\s*=\s*Object\.assign\(\s*Object\.create\(null\)/.test(code));
  ok('...and holds exactly invdata, beta, saleshistory',
     /const\s+WORKBOOKS[\s\S]{0,700}invdata:[\s\S]{0,400}beta:[\s\S]{0,400}saleshistory:/.test(code));
  ok('workbookTarget_ refuses an unknown target rather than defaulting to one',
     /function\s+workbookTarget_[\s\S]{0,600}throw new Error\('Unknown workbook target/.test(code));
  ok('no route accepts a raw spreadsheet id as a parameter',
     !/params\.(spreadsheetId|ssid|sheetId)\b/.test(code));
}

console.log('\n3. the fallback that made a default workbook possible is gone');
{
  ok('sheetToObjects_ still exists', /function\s+sheetToObjects_\s*\(sheetName,\s*spreadsheetId\)/.test(code));
  ok('...and its spreadsheetId is required, not defaulted',
     /function\s+sheetToObjects_[\s\S]{0,500}if\s*\(!spreadsheetId\)\s*\{[\s\S]{0,400}throw new Error/.test(code));
  ok('...with no `||` fallback left on the openById line',
     !/SpreadsheetApp\.openById\(spreadsheetId\s*\|\|/.test(code));
  {
    // Real call sites only: not the declaration, and not the occurrence inside the throw message.
    const sites = callArgs(code, 'sheetToObjects_').calls.filter(a => !/^["']/.test(a));
    const bare = sites.filter(a => a.split(',').length < 2 || !a.split(',')[1].trim());
    ok('there are sheetToObjects_ call sites to check', sites.length > 0);
    ok('every sheetToObjects_ caller passes an id explicitly' + (bare.length ? ' — bare: ' + bare.join(' | ') : ''),
       bare.length === 0);
  }
  ok(INV_DATA_LABEL + ' still refuses to fall back to the financial workbook',
     /function\s+getInvDataSpreadsheetId[\s\S]{0,700}throw new Error\('INV_DATA_SS_ID/.test(code));
}

console.log('\n4. the completed migration routes are gone at every layer');
{
  for (const fn of ['migrateInventoryData', 'copyInvSnapshotRecent', 'deleteMigratedFromFinancial']) {
    ok(`${fn} is removed`, !new RegExp('function\\s+' + fn + '\\s*\\(').test(code));
  }
  ok('INV_DATA_MOVE_SHEETS is gone with them', !/INV_DATA_MOVE_SHEETS/.test(code));
  ok('INV_DATA_SS_PENDING is gone — nothing stages a migration any more', !/INV_DATA_SS_PENDING/.test(code));
  for (const action of ['migrateinvdata', 'copyinvsnap', 'deletemigrated']) {
    ok(`the ${action} route is gone with its handler`, !new RegExp("action === '" + action + "'").test(code));
    ok(`...and its WRITE_ACTIONS entry`, !new RegExp('\\b' + action + ':\\s*1').test(code));
  }
}

console.log('\n5. the diagnostics survive, aimed at workbooks we actually own');
{
  ok('sheetsinfo survives', /action === 'sheetsinfo'/.test(code));
  ok('...targeted by name, defaulting through workbookTarget_',
     /function\s+sheetsInfo\(params\)[\s\S]{0,800}workbookTarget_\(params\.target\)/.test(code));
  ok('...and can report every workbook at once, since a cell cap is per-workbook',
     /function\s+sheetsInfo\(params\)[\s\S]{0,800}'all'/.test(code));

  ok('trimempty survives', /action === 'trimempty'/.test(code));
  ok('...and is still write-gated', /\btrimempty:\s*1/.test(code));
  ok('...and refuses a workbook this app does not own',
     /function\s+trimEmptySheetSpace[\s\S]{0,600}if\s*\(!target\.trimmable\)/.test(code));
  ok('...aimed by name, never at a default workbook',
     /function\s+trimEmptySheetSpace[\s\S]{0,400}workbookTarget_\(params\.target\)/.test(code));
}

console.log('\n6. datamode reports what is true now, not a workbook nothing reads');
{
  ok('the datamode route survives', /action === 'datamode'/.test(code));
  ok('...and no longer hands back a single "the spreadsheet" id',
     !/action === 'datamode'[\s\S]{0,200}spreadsheetId:\s*getData/.test(code));
  ok('...it reports the full set of workbooks',
     /function\s+getDataModeReport[\s\S]{0,600}workbooks/.test(code));
  ok('...and reports a resolution failure in place rather than throwing',
     /function\s+getDataModeReport[\s\S]{0,600}catch\s*\(e\)[\s\S]{0,200}error:\s*e\.message/.test(code));
}

console.log('\n7. what must NOT have been collateral damage');
{
  // getDataSpreadsheetId died; getDataMode is a different thing and live features depend on it.
  ok('getDataMode survives', /function\s+getDataMode\(\)/.test(code));
  ok('...and still gates the beta decision feed', /getDataMode\(\)\s*!==\s*'beta'/.test(code));
  ok('BETA_SPREADSHEET_ID survives — it is production, not scratch',
     /const\s+BETA_SPREADSHEET_ID\s*=/.test(code));
  ok('...and still backs the Config - * tabs',
     /sheetToObjects_\(STORE_CONFIG_SHEET_NAME,[\s\S]{0,80}BETA_SPREADSHEET_ID\)/.test(code));
  ok('...and Shared State / Decision Feed still open it',
     (code.match(/SpreadsheetApp\.openById\(BETA_SPREADSHEET_ID\)/g) || []).length >= 4);
  ok('the inventory data workbook is still how Loading Quotes is read',
     /sheetToObjects_\(LOADING_QUOTES_SHEET_NAME,\s*getInvDataSpreadsheetId\(\)\)/.test(code));
  ok('the sales-history workbook is untouched', /const\s+SALES_HISTORY_SPREADSHEET_ID\s*=/.test(code));
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
