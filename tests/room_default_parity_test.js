#!/usr/bin/env node
/* Room classification: the debug tool must answer what the app answers (2026-09-11).
 *
 * Dutchie reports NO room on River Rd's inventory rows, so every package's room is inferred. Two
 * places do that inference: getInventory (what staff see) and skuDebug (?action=skudebug — what you
 * open when staff say the numbers are wrong). They were written separately and drifted: skuDebug
 * hardcoded 'back' for the unknown case while getInventory defaulted to 'distro' at a DC. Asked
 * about River's 645 lighters, the app said "645 in Distro" and the debug tool said "645 in Back
 * Stock". A diagnostic that contradicts production on the one question it exists to answer costs
 * whoever is debugging more than having no tool at all.
 *
 * So this asserts the two chains stay identical in SHAPE — same gate, same precedence, same
 * default expression. It cannot prove they compute the same thing at runtime (that needs live
 * Dutchie), but every drift so far has been a visible difference in these few lines.
 *
 * Source-text assertions rather than a loaded harness, matching this repo's existing style.
 */
'use strict';
const fs = require('fs'), path = require('path');
const REPO = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(REPO, 'dutchie_proxy.gs'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  ✗   ' + label); }
}

// One function's source: from its declaration to the next top-level `function` after it.
// A fixed char window silently truncated getInventory mid-chain and turned a real assertion
// into a false failure, so slice on the actual boundary instead.
const body = (fnName) => {
  const start = code.indexOf('function ' + fnName + '(');
  if (start < 0) return '';
  const next = code.indexOf('\nfunction ', start + 1);
  return code.slice(start, next < 0 ? code.length : next);
};
const getInv   = body('getInventory');
const skuDbg   = body('skuDebug');

console.log('1. both chains compute the unknown-room default the same way');
{
  const gate = /hasDistroRoom\s*&&\s*floorSignalSeen\s*\)\s*\?\s*'distro'\s*:\s*'back'/;
  ok('getInventory derives unknownRoomType from the distro+floor-signal gate', gate.test(getInv));
  ok('skuDebug derives unknownRoomType from the SAME gate',                    gate.test(skuDbg));
  ok('skuDebug no longer hardcodes a bare back default',
     !/safeTxRoom\s*\?\s*safeTxRoom\s*:\s*'back'/.test(skuDbg));
  ok('skuDebug falls through to unknownRoomType',
     /safeTxRoom\s*\?\s*safeTxRoom\s*:\s*unknownRoomType/.test(skuDbg));
}

console.log('\n2. a retail sale outranks a Move in BOTH chains');
{
  for (const [name, src] of [['getInventory', getInv], ['skuDebug', skuDbg]]) {
    ok(name + ' reads the floorEvidence set',   /floorEvidence\.has\(String\(item\.inventoryId\)\)/.test(src));
    ok(name + ' puts the sale ABOVE the Move tx',
       /soldFromFloor[\s\S]{0,40}\?\s*'floor'[\s\S]{0,60}safeTxRoom/.test(src));
  }
}

console.log('\n3. the evidence itself stays honest');
{
  const proc = body('_processRoomData_');
  ok('only Retail register transactions count as floor evidence',
     /transactionType\s*\|\|\s*''\)\s*===\s*'Retail'/.test(proc));
  ok('...and voided sales are excluded',      /!tx\.isVoid/.test(proc));
  ok('...and returned line items are excluded', /isRetail\s*&&\s*!item\.isReturned/.test(proc));
  ok('a sale only wins when it is NEWER than the last Move',
     /!mv\s*\|\|\s*saleDate\s*>\s*mv\.date/.test(proc));
  ok('floorEvidenceIds is returned to callers', /return\s*\{[^}]*floorEvidenceIds/.test(proc));
}

console.log('\n4. the room-data cache cannot serve pre-fix entries');
{
  ok('cache prefix was bumped past roomdata4_',
     /ROOM_DATA_CACHE_PREFIX\s*=\s*'roomdata(?!4_)/.test(code));
}

console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
