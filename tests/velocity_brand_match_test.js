// Tawny's bug (2026-11-16): Green Cross "Sour Apple Sativa Gummies 10pk" at River showed 18 sold in
// 28 days when it had sold none. It had no sales row of its own, so the loose name fallback matched
// Wyld's "Sour Apple Sativa Gummies 10pc | 100mg" (both normalize to "sour apple sativa gummies")
// and borrowed Wyld's sales. This runs the REAL lookup functions from index.html, not a text match.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
const fns = ['inventoryNormName', 'inventoryBrandKey', 'sameBrandOrUnknown', 'inventoryDoseMg', 'sameDoseOrUnknown', 'inventoryNormBrandKey',
  'requiresStrictVelocityMatch', 'velocityEntryForProduct'];
const lib = new Function(fns.map(extract).join('\n') + '\nreturn {' + fns.join(',') + '};')();

const wyld = { vel7: 0.86, qty28: 18, brand: 'Wyld', sku: 'CF065E5F5E', category: 'Edible (Solid)' };
const velMap = { River: { 'Sour Apple Sativa Gummies 10pc | 100mg': wyld } };

// 1. The reported case: different brand, same loose name -> no sales borrowed.
const gc = { name: 'Sour Apple Sativa Gummies 10pk', brand: 'Green Cross', sku: '67100200', category: 'Edible (Solid)' };
assert.deepStrictEqual(lib.velocityEntryForProduct(gc, 'River', velMap), {},
  'Green Cross product must not inherit Wyld sales');

// 2. The loose match still works within one brand (what it exists for: 10pack vs 10pk).
const wyldVariant = { name: 'Sour Apple Sativa Gummies 10 pack', brand: 'Wyld', sku: '', category: 'Edible (Solid)' };
assert.strictEqual(lib.velocityEntryForProduct(wyldVariant, 'River', velMap), wyld,
  'same-brand loose match must still find sales');

// 3. Unknown brand on one side still matches (cannot disagree).
const noBrand = { name: 'Sour Apple Sativa Gummies 10pk', brand: '', sku: '', category: 'Edible (Solid)' };
assert.strictEqual(lib.velocityEntryForProduct(noBrand, 'River', velMap), wyld);

// 4. Exact SKU still wins regardless of brand spelling.
const exactSku = { name: 'Something else', brand: 'WYLD OREGON', sku: 'CF065E5F5E', category: 'Edible (Solid)' };
assert.strictEqual(lib.velocityEntryForProduct(exactSku, 'River', velMap), wyld);

// 5. Brand-keyed lookups used by the cost backfill and OOS SKU guess keep brands apart.
assert.notStrictEqual(lib.inventoryNormBrandKey(gc.name, gc.brand),
  lib.inventoryNormBrandKey('Sour Apple Sativa Gummies 10pc | 100mg', 'Wyld'));

// 7. Accessories: the "$5.00 | " price prefix is not the product name.
const accVel = { River: { '$5.00 | Glass Bowl 14mm | BOWLGOGCPK': { qty28: 9, brand: 'High Mountain Imports', sku: 'BOWLGOGCPK' } } };
const downstem = { name: '$5.00 | Downstem 4.5" 14mm | DSTEM1814-4.5', brand: 'High Mountain Imports', sku: 'DSTEM1814-4.5', category: 'Accessories' };
assert.deepStrictEqual(lib.velocityEntryForProduct(downstem, 'River', accVel), {}, 'a $5 downstem is not a $5 bowl');
const bowlRenamed = { name: 'Glass Bowl 14mm', brand: 'High Mountain Imports', sku: '', category: 'Accessories' };
assert.strictEqual(lib.velocityEntryForProduct(bowlRenamed, 'River', accVel), accVel.River['$5.00 | Glass Bowl 14mm | BOWLGOGCPK']);

// 8. Shake is not the flower of the same strain.
assert.notStrictEqual(lib.inventoryNormName('MAC | Shake'), lib.inventoryNormName('MAC | Meraki Gardens'));

// 9. Different strengths do not share sales; an undosed name still matches.
const doseVel = { River: { 'Lime Seltzer | 25mg': { qty28: 4, brand: 'Magic Number', sku: '' } } };
assert.deepStrictEqual(lib.velocityEntryForProduct({ name: 'Lime Seltzer | 100mg', brand: 'Magic Number', sku: '' }, 'River', doseVel), {});
assert.strictEqual(lib.velocityEntryForProduct({ name: 'Lime Seltzer', brand: 'Magic Number', sku: '' }, 'River', doseVel), doseVel.River['Lime Seltzer | 25mg']);

// 6. The OOS-injection and cost-backfill call sites must not use the brand-blind key.
assert(!/inInventoryNorm/.test(src), 'OOS injection must not use a brand-blind normalized-name set');
assert(!/costByName\[inventoryNormName\(/.test(src), 'cost backfill must key by brand + name');
assert(!/nameToSkuNorm\[inventoryNormName\(/.test(src), 'OOS SKU guess must key by brand + name');

console.log('velocity_brand_match_test: ok');
