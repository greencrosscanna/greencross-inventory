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
  for (const [name, src] of [['getInventory', getInv], ['skuDebug', skuDbg]])
    ok(name + ' ends its chain at unknownRoomType, not a literal',
       /:\s*unknownRoomType;/.test(src));
}

console.log('\n2. sale evidence sits on both sides of the Move, in both chains');
{
  for (const [name, src] of [['getInventory', getInv], ['skuDebug', skuDbg]]) {
    ok(name + ' reads the inventoryId evidence set', /floorEvidence\.has\(String\(item\.inventoryId\)\)/.test(src));
    ok(name + ' puts the dated sale ABOVE the Move tx',
       /soldFromFloor[\s\S]{0,40}\?\s*'floor'[\s\S]{0,60}safeTxRoom/.test(src));
    // The packageId set carries no date, so it must never outrank a Move — the !safeTxRoom guard
    // is what keeps it in the default slot. Dropping that guard is the easy mistake here.
    ok(name + ' gates packageId evidence behind !safeTxRoom',
       /soldPkg\s*=\s*!safeTxRoom\s*&&/.test(src));
    ok(name + ' puts packageId evidence BELOW the Move tx',
       /safeTxRoom[\s\S]{0,60}soldPkg[\s\S]{0,30}\?\s*'floor'/.test(src));
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
  ok('cache writes go through the compactor', /cache\.put\([^)]*_compactRoomData_\(data\)/.test(code));
  ok('cache reads go through the expander',   /_expandRoomData_\(JSON\.parse\(cached\)\)/.test(code));
}

console.log('\n5. the cache codec round-trips, and actually saves room');
{
  // Executed, not pattern-matched. This one is cheap to get subtly wrong (a dropped room type, an
  // empty-string id from a trailing comma) and the failure mode is packages quietly changing room
  // on a cache hit but not a cache miss — i.e. the app disagreeing with itself every hour.
  const grab = (fn) => {
    const i = code.indexOf('function ' + fn + '(');
    const j = code.indexOf('\nfunction ', i + 1);
    return code.slice(i, j < 0 ? code.length : j);
  };
  const sandbox = {};
  new Function('S', grab('_compactRoomData_') + grab('_expandRoomData_')
    + "\nconst _ROOM_CODE_ = { f:'floor', b:'back', d:'distro', q:'quarantine', s:'sample' };"
    + '\nS.c = _compactRoomData_; S.e = _expandRoomData_;')(sandbox);

  const sample = {
    roomNameType: { 'Sales Floor': 'floor', 'Distro': 'distro', 'Samples': 'sample' },
    roomIdType:   { '3833': 'floor', '5258': 'distro' },
    invRoomMap:   { '1': 'floor', '2': 'distro', '3': 'back', '4': 'quarantine', '5': 'sample' },
    floorEvidenceIds: ['1', '9'],
    floorEvidencePkgIds: ['070330600171', '1A401030006105B000009120'],
    returnedPackageIds: ['77'],
  };
  const back = sandbox.e(sandbox.c(sample));
  ok('invRoomMap survives every room type',
     JSON.stringify(back.invRoomMap) === JSON.stringify(sample.invRoomMap));
  ok('floorEvidenceIds survive',    JSON.stringify(back.floorEvidenceIds) === JSON.stringify(sample.floorEvidenceIds));
  ok('floorEvidencePkgIds survive', JSON.stringify(back.floorEvidencePkgIds) === JSON.stringify(sample.floorEvidencePkgIds));
  ok('returnedPackageIds survive',  JSON.stringify(back.returnedPackageIds) === JSON.stringify(sample.returnedPackageIds));
  ok('room name/id tables survive',
     JSON.stringify(back.roomNameType) === JSON.stringify(sample.roomNameType) &&
     JSON.stringify(back.roomIdType)   === JSON.stringify(sample.roomIdType));

  const empty = sandbox.e(sandbox.c({ invRoomMap: {}, roomNameType: {}, roomIdType: {} }));
  ok('an empty map round-trips to an empty map, not [""]',
     Object.keys(empty.invRoomMap).length === 0 && empty.floorEvidenceIds.length === 0);

  ok('a non-compact value is handed back untouched (old cache entry, foreign shape)',
     sandbox.e({ invRoomMap: { '1': 'floor' } }).invRoomMap['1'] === 'floor');

  // The size claim this codec exists for: River's real map was 4,896 entries at 89,363 bytes.
  const big = { invRoomMap: {}, roomNameType: {}, roomIdType: {}, floorEvidenceIds: [], floorEvidencePkgIds: [], returnedPackageIds: [] };
  for (let i = 0; i < 4896; i++) big.invRoomMap[String(1900000 + i)] = (i % 5 === 0) ? 'distro' : 'floor';
  const before = JSON.stringify(big.invRoomMap).length;
  const after  = JSON.stringify(sandbox.c(big)).length;
  ok('compaction at least halves a River-sized map (' + before + ' → ' + after + ')', after < before / 2);
}

console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
