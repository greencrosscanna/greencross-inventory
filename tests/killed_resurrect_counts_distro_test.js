// A hidden ("killed") item must come back on its own when it is restocked — including at River Rd,
// where restocks land in Distro and p.qty (floor + back) stays 0. Before v3.084 the resurrect check
// read p.qty alone, so Tawny's restocked River Rd Blueberry Headband (2,497 g, all Distro) stayed
// hidden. This runs the real isKilled() pulled out of index.html against that exact shape.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function grab(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in index.html');
  let depth = 0, i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}

let saved = null;
const src = [grab('killedTs'), grab('isKilled')].join('\n');
const isKilled = new Function('saveKilledSet', src + '\nreturn isKilled;')(o => { saved = o; });

const killedAt = Date.parse('2026-10-19T12:00:00Z');
const key = 'A87920D71B|River Rd';

// Restocked into Distro only (floor 0) after the kill: must come back.
let obj = { [key]: { ts: killedAt, by: 'tawny' } };
assert.strictEqual(isKilled(obj, key, { qty: 0, qtyDistro: 2497, lastMod: '2026-11-24T05:00:05.5500000' }), false,
  'Distro-only restock after the kill must un-hide the item');
assert.ok(!(key in saved), 'resurrect must drop the key from the killed list');

// Still out of stock everywhere: stays hidden.
obj = { [key]: { ts: killedAt, by: 'tawny' } };
assert.strictEqual(isKilled(obj, key, { qty: 0, qtyDistro: 0, lastMod: '2026-11-24T05:00:05Z' }), true);

// Stock present but unchanged since the kill: stays hidden (the person hid it with stock on purpose).
obj = { [key]: { ts: killedAt, by: 'tawny' } };
assert.strictEqual(isKilled(obj, key, { qty: 0, qtyDistro: 500, lastMod: '2026-10-01T00:00:00Z' }), true);

// Floor restock still works as before.
obj = { [key]: { ts: killedAt, by: 'tawny' } };
assert.strictEqual(isKilled(obj, key, { qty: 12, lastMod: '2026-11-24T05:00:05Z' }), false);

console.log('killed_resurrect_counts_distro_test: ok');
