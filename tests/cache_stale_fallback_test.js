#!/usr/bin/env node
/* ─── The cache keeps an expired copy, and only hands it over when asked ──────────────────────────
 *
 *   RUN:  node tests/cache_stale_fallback_test.js        (repo root; no deps, no network)
 *   Against the previous source:  node tests/cache_stale_fallback_test.js path/to/old/index.html
 *
 * THE BUG THIS PINS. cacheGet used to do this on the TTL-expired path:
 *
 *     if (Date.now() - ts < ttl) return data;
 *     localStorage.removeItem(CACHE_PREFIX + key);      // <-- destroys the only copy
 *
 * An expired read did not merely decline to serve the entry, it ERASED it — so the copy that could
 * have carried a buyer through an outage was gone at exactly the moment it became the only copy
 * left. OPERATIONAL_CACHE_TTL_MS is 12 hours, so that is most mornings: the overnight entry lapses,
 * the first read of the day deletes it, and if the engine is then unreachable the inventory tab has
 * nothing but a red error to show.
 *
 * TWO DIRECTIONS, AND BOTH ARE LOAD-BEARING. Inventory is a BUYING tool. Over-ordering because the
 * screen showed last night's depleted counts costs real money, so "always serve stale" would be a
 * worse bug than the one being fixed. The invariants are therefore:
 *   keep it   — an expired entry survives the read that declines it;
 *   decline   — cacheGet still returns null for it, so no existing call site drifts into staleness;
 *   opt in    — only cacheGetStale reaches it, only for allowlisted keys, and only when the engine
 *               could not be REACHED;
 *   and say so — the age shown comes from the entry's own timestamp, never from the failure time.
 *
 * That last one is not hypothetical: the equivalent Leaderboard work shipped labeling an hour-old
 * board "1 min ago" because it measured from when the failure was noticed. On a TV showing sales
 * totals that is embarrassing. On this screen it makes a stale number look live at the exact moment
 * someone is deciding what to buy.
 *
 * Like name_typo_test.js, this RUNS the real source rather than reading it as text: the cache block
 * and proxyFetch are lifted out of index.html and executed against a fake localStorage. Optional
 * lifts (the parts that did not exist before the fix) come back null and fail as ordinary
 * assertions, so running this against the old file names each missing piece instead of exiting.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const SRC  = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}
function lift(pattern, what) {
  const m = html.match(pattern);
  if (!m) {
    console.error('EXTRACTION FAILED: could not find ' + what + ' in ' + SRC);
    console.error('The source moved or changed shape. Update the pattern here — do not delete the test.');
    process.exit(2);
  }
  return m[0];
}
// Optional: absent in the pre-fix source. Missing shows up as a failed assertion, not an exit.
function liftMaybe(pattern) { const m = html.match(pattern); return m ? m[0] : ''; }

// The whole cache block, bounded by two comment headers that exist either side of the fix.
const CACHE_SRC = lift(/\/\/ ── Cache ─+[\s\S]*?(?=\n\/\/ Shared operationalstatus helper)/,
                       'the cache block');
const PROXY_SRC = lift(/async function proxyFetch\(params[\s\S]*?\n\}/, 'proxyFetch');
const NOTE_SRC  = liftMaybe(/function noteStaleServed\([\s\S]*?\n\}/);
// The real formatters the banner is built on — lifted rather than stubbed, so a change to how this
// app writes a date or escapes a string is a change this test sees.
const FMT_SRC = lift(/function fmtDateTimeShort\(value\)[\s\S]*?\n\}/, 'fmtDateTimeShort')
              + '\n' + lift(/function escapeHtml\([\s\S]*?\n\}/, 'escapeHtml')
              + '\n' + lift(/function storeDisplay\(name\)[^\n]*\n/, 'storeDisplay');
const BANNER_SRC = liftMaybe(/function staleKeyLabel_\([\s\S]*?\n\}\nfunction fmtAgeShort_\([\s\S]*?\n\}\nfunction inventoryStaleBannerHtml\(\)[\s\S]*?\n\}/);

const HOUR = 3600000;

// A localStorage good enough for this block: get/set/remove plus Object.keys over the backing map.
function newEnv() {
  const store = {};
  const ls = {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const state = { staleServed: [], inventoryGeneratedAt: '' };
  const STORE_BY_NAME = {                       // the app's live registry; never hardcoded in app code
    'Bend': { name: 'Bend', display: 'Century' },
    'River Rd': { name: 'River Rd', display: 'River' },
  };
  let engineImpl = async () => { throw new Error('no engine configured for this fixture'); };
  const api = new Function(
    'localStorage', 'STORE_BY_NAME', 'state', 'engineGet', 'LS', 'location', 'console',
    CACHE_SRC + '\n' + NOTE_SRC + '\n' + PROXY_SRC + '\n' + FMT_SRC + '\n' + BANNER_SRC + '\n' +
    'const has = n => typeof n === "function" ? n : null;\n' +
    'return {\n' +
    '  cacheGet, cacheSet, CACHE_PREFIX, CACHE_VERSION, proxyFetch,\n' +
    '  cacheGetStale:         typeof cacheGetStale         === "function" ? cacheGetStale         : null,\n' +
    '  cacheExpire:           typeof cacheExpire           === "function" ? cacheExpire           : null,\n' +
    '  cacheKeyMayServeStale: typeof cacheKeyMayServeStale === "function" ? cacheKeyMayServeStale : null,\n' +
    '  inventoryStaleBannerHtml: typeof inventoryStaleBannerHtml === "function" ? inventoryStaleBannerHtml : null,\n' +
    '  STALE_FALLBACK_MAX_MS: typeof STALE_FALLBACK_MAX_MS !== "undefined" ? STALE_FALLBACK_MAX_MS : null,\n' +
    '};'
  )(ls, STORE_BY_NAME, state, (...a) => engineImpl(...a),
    { AUTH: 'gc_auth' }, { reload() {} }, { warn() {}, log() {} });

  // Write an entry directly, with an age we choose — the only way to test a 12-hour-old copy.
  api.seed = (key, data, ttlMs, ageMs, v) =>
    ls.setItem(api.CACHE_PREFIX + key, JSON.stringify({
      ts: Date.now() - (ageMs || 0), ttl: ttlMs,
      v: v === undefined ? api.CACHE_VERSION : v, data,
    }));
  api.raw    = key => ls.getItem(api.CACHE_PREFIX + key);
  api.engine = fn => { engineImpl = fn; };
  api.state  = state;
  return api;
}

const BUNDLE = { ok: true, generatedAt: '2026-09-15T21:00:00-07:00', inventory: [{ store: 'Bend', products: [{ sku: 'A', qty: 4 }] }] };

console.log('\n1. an expired entry is DECLINED but not DESTROYED');
{
  // FIXTURE: a 13-hour-old operational bundle under the app's real 12h TTL. Pre-fix, the read that
  // declines it also deletes it, so `raw` comes back null and the outage has nothing to fall back on.
  const c = newEnv();
  c.seed('operational_bundle_all', BUNDLE, 12 * HOUR, 13 * HOUR);
  ok('cacheGet declines expired data (a buyer is never silently shown an old count)',
     c.cacheGet('operational_bundle_all') === null);
  ok('...and the expired entry SURVIVES that read — this is the bug',
     c.raw('operational_bundle_all') !== null,
     'cacheGet removed the entry on the TTL-expired path; the only copy is gone');
  ok('...a second read still declines it (declining is not a one-shot)',
     c.cacheGet('operational_bundle_all') === null && c.raw('operational_bundle_all') !== null);
}

console.log('\n2. a fresh entry is still served, and a wrong-schema entry is still destroyed');
{
  const c = newEnv();
  c.seed('vel_all', { stores: { Bend: {} } }, 12 * HOUR, 1 * HOUR);
  ok('a fresh entry reads back normally', !!c.cacheGet('vel_all'));

  // FIXTURE: CACHE_VERSION + 1. This data cannot be read by this build at ANY age, so keeping it
  // buys nothing — the deletion above the TTL branch was always correct and must stay.
  const d = newEnv();
  d.seed('operational_bundle_all', BUNDLE, 12 * HOUR, 1 * HOUR, 999);
  ok('a schema-version mismatch is declined', d.cacheGet('operational_bundle_all') === null);
  ok('...and IS deleted — over-correcting the fix must not preserve unreadable data',
     d.raw('operational_bundle_all') === null);
}

console.log('\n3. the stale copy is reachable only by asking for it, by key');
{
  const c = newEnv();
  c.seed('operational_bundle_all', BUNDLE, 12 * HOUR, 13 * HOUR);
  ok('cacheGetStale() exists', typeof c.cacheGetStale === 'function',
     'no opt-in stale reader in this source');
  if (c.cacheGetStale) {
    const s = c.cacheGetStale('operational_bundle_all');
    ok('cacheGetStale returns the expired data', !!s && s.data && s.data.ok === true);
    ok('...with the entry\'s own write time, not the moment it was asked for',
       !!s && Math.abs(s.ageMs - 13 * HOUR) < 60000,
       s ? 'ageMs=' + s.ageMs + ' expected ~' + 13 * HOUR : 'no entry returned');

    // FIXTURE: a FRESH entry. cacheGetStale must not double as a general reader — a caller holding
    // both must still take the fresh path, or the banner would fire on a perfectly good load.
    const d = newEnv();
    d.seed('vel_all', { stores: {} }, 12 * HOUR, 1 * HOUR);
    ok('cacheGetStale returns null for a FRESH entry (it is not a second cacheGet)',
       d.cacheGetStale('vel_all') === null);

    // FIXTURE: nine days old, past STALE_FALLBACK_MAX_MS. A week-old stock count is not evidence.
    const e = newEnv();
    e.seed('operational_bundle_all', BUNDLE, 12 * HOUR, 9 * 24 * HOUR);
    ok('a copy older than the hard floor is refused', e.cacheGetStale('operational_bundle_all') === null);
    ok('the hard floor is a real bound (1h .. 30d)',
       c.STALE_FALLBACK_MAX_MS > HOUR && c.STALE_FALLBACK_MAX_MS <= 30 * 24 * HOUR,
       'got ' + c.STALE_FALLBACK_MAX_MS);
  }
}

console.log('\n4. the allowlist — which keys may be served stale at all');
{
  const c = newEnv();
  ok('cacheKeyMayServeStale() exists', typeof c.cacheKeyMayServeStale === 'function');
  if (c.cacheKeyMayServeStale) {
    for (const k of ['operational_bundle_all', 'vel_all', 'inv_Bend', 'inv_River Rd'])
      ok('allowed: ' + k, c.cacheKeyMayServeStale(k) === true);
    // op_status is the app's own freshness oracle — a stale answer there would corrupt the age
    // label on everything else. ll_orders_v1 exists to stop a buyer ordering something already on
    // the way. The money keys read as reported results, not as working estimates.
    for (const k of ['op_status', 'll_orders_v1', 'inv_lostsales_v1', 'inv_subconfig_v1',
                     'oosmap_v1', 'fatty_tracker_v1', 'cogs2026-09-01_cogs', 'fin_x_s'])
      ok('refused: ' + k, c.cacheKeyMayServeStale(k) === false);
    // inv_lostsales_v1 and inv_subconfig_v1 share the inv_ prefix with the store keys. Matching on
    // the live store registry rather than the prefix is what keeps them out.
    ok('an unknown inv_<something> is refused, not assumed to be a store',
       c.cacheKeyMayServeStale('inv_Nowhere') === false);
  }
}

console.log('\n5. proxyFetch falls back only when asked, and only when the engine is UNREACHABLE');
{
  const unreachable = async () => { throw new Error('Engine request (operationalbundle) timed out'); };

  // FIXTURE: expired bundle + a throwing engine + staleFallback. Pre-fix this throws twice over —
  // the entry was already deleted by the read above, and proxyFetch had no fallback at all.
  (async () => {
    const c = newEnv();
    c.seed('operational_bundle_all', BUNDLE, 12 * HOUR, 12.5 * HOUR);
    c.engine(unreachable);
    let got = null, threw = null;
    try { got = await c.proxyFetch({ action: 'operationalbundle' }, 'operational_bundle_all', 12 * HOUR, { staleFallback: true }); }
    catch (e) { threw = e; }
    ok('an unreachable engine serves the saved copy instead of throwing',
       !threw && got && got.ok === true, threw ? 'threw: ' + threw.message : 'returned ' + JSON.stringify(got));
    ok('...and records it, so the screen can say so',
       (c.state.staleServed || []).length === 1);
    ok('...recording the ENTRY\'S age, not the time the failure was noticed',
       (c.state.staleServed[0] || {}).ageMs > 12 * HOUR,
       'ageMs=' + (c.state.staleServed[0] || {}).ageMs + '; near-zero means it measured from the failure');

    // FIXTURE: same expired entry, same dead engine, no opts. Every other call site in the app
    // looks like this and must keep failing loudly.
    const d = newEnv();
    d.seed('operational_bundle_all', BUNDLE, 12 * HOUR, 12.5 * HOUR);
    d.engine(unreachable);
    let dThrew = null;
    try { await d.proxyFetch({ action: 'operationalbundle' }, 'operational_bundle_all', 12 * HOUR); }
    catch (e) { dThrew = e; }
    ok('without staleFallback the failure still propagates', !!dThrew);
    ok('...and did not quietly record a stale serve', (d.state.staleServed || []).length === 0);

    // FIXTURE: a refused key (op_status) with a saved copy and a dead engine. Asking for the
    // fallback is not enough; the key has to be allowed.
    const e2 = newEnv();
    e2.seed('op_status', { ok: true, generatedAt: 'x' }, 5 * 60000, 3 * HOUR);
    e2.engine(unreachable);
    let eThrew = null;
    try { await e2.proxyFetch({ action: 'operationalstatus' }, 'op_status', 5 * 60000, { staleFallback: true }); }
    catch (err) { eThrew = err; }
    ok('a refused key does not fall back even when the caller asks', !!eThrew);

    // FIXTURE: the engine ANSWERS, with a structured error. It is telling us something actionable
    // ("snapshot is not ready — build it"); burying that under stale data hides the fix.
    const f = newEnv();
    f.seed('operational_bundle_all', BUNDLE, 12 * HOUR, 12.5 * HOUR);
    f.engine(async () => ({ error: 'Inventory snapshot is not ready yet.' }));
    let fThrew = null;
    try { await f.proxyFetch({ action: 'operationalbundle' }, 'operational_bundle_all', 12 * HOUR, { staleFallback: true }); }
    catch (err) { fThrew = err; }
    ok('a structured engine error still surfaces, rather than being hidden by a saved copy',
       !!fThrew && /not ready/.test(fThrew.message));

    // FIXTURE: a healthy engine. The fallback must be invisible on a good day.
    const g = newEnv();
    g.seed('operational_bundle_all', BUNDLE, 12 * HOUR, 12.5 * HOUR);
    g.engine(async () => ({ ok: true, fresh: true }));
    const gOut = await g.proxyFetch({ action: 'operationalbundle' }, 'operational_bundle_all', 12 * HOUR, { staleFallback: true });
    ok('a working engine still wins over the saved copy', gOut && gOut.fresh === true);
    ok('...and nothing is flagged stale on a healthy load', (g.state.staleServed || []).length === 0);

    banner();
    callSites();
    finish();
  })().catch(e => { console.error(e); process.exit(2); });
}

function banner() {
  console.log('\n6. the banner states an age the data supports');
  const c = newEnv();
  ok('inventoryStaleBannerHtml() exists', typeof c.inventoryStaleBannerHtml === 'function');
  if (!c.inventoryStaleBannerHtml) return;

  ok('renders nothing when nothing was served stale', c.inventoryStaleBannerHtml() === '');

  // FIXTURE: a copy saved 12 hours ago. THE Leaderboard BUG: measuring from when the fetch threw
  // would render "0 min old" / "1 min old" here.
  c.state.staleServed = [{ key: 'operational_bundle_all', ts: Date.now() - 12 * HOUR, ageMs: 12 * HOUR, error: 'timed out' }];
  const h = c.inventoryStaleBannerHtml();
  ok('says how old the data is, from its own timestamp', /12h old/.test(h), h);
  ok('does not report the age of the failure', !/\b[0-5] min old\b/.test(h), h);
  ok('says plainly that it is not current', /not current/i.test(h) && /Dutchie could not be reached/i.test(h));
  ok('warns before ordering against it', /before ordering/i.test(h));

  // FIXTURE: a 12h-old saved copy of a snapshot BUILT 20h ago. The oldest fact on screen is 20h
  // old, and that is what has to be stated — the saved-at time alone would understate it by 8h.
  c.state.inventoryGeneratedAt = new Date(Date.now() - 20 * HOUR).toISOString();
  const h2 = c.inventoryStaleBannerHtml();
  ok('takes the OLDEST of the saved-at time and the snapshot\'s own build time', /20h old/.test(h2), h2);

  // FIXTURE: one store only. The banner has to name what is stale, not blanket the whole screen.
  c.state.inventoryGeneratedAt = '';
  c.state.staleServed = [{ key: 'inv_Bend', ts: Date.now() - 3 * HOUR, ageMs: 3 * HOUR, error: 'timed out' }];
  const h3 = c.inventoryStaleBannerHtml();
  ok('names which data is stale, using the store\'s display name', /Century on-hand/.test(h3), h3);
}

function callSites() {
  console.log('\n7. the call sites — who opted in, and who deliberately did not');
  const loadFn = (html.match(/async function loadInventoryData\(\)[\s\S]*?\n\}\n\nfunction buildInvFilterOptions/) || [''])[0];
  ok('the all-store snapshot opts in',
     /'operational_bundle_all',[\s\S]{0,120}staleFallback: true/.test(loadFn));
  ok('velocity opts in', /'vel_all',[\s\S]{0,120}staleFallback: true/.test(loadFn));
  ok('per-store inventory opts in', /'inv_' \+ store,[\s\S]{0,160}staleFallback: !forceServerRefresh/.test(loadFn),
     'a manual Refresh must not be answered from a saved copy');
  ok('the ledger is reset each load, so a recovered load drops the banner',
     /state\.staleServed = \[\];/.test(loadFn));
  // The background check evicts when the SERVER has a newer snapshot. Superseding is right;
  // destroying puts us back where we started the next time the engine is unreachable.
  ok('the superseded-snapshot check expires rather than deletes',
     /cacheExpire\('operational_bundle_all'\)/.test(loadFn) && /cacheExpire\('vel_all'\)/.test(loadFn),
     'cacheDelete here would burn the fallback the fix just created');
  const opStatus = (html.match(/async function getOperationalStatus\(force\)[\s\S]*?\n\}/) || [''])[0];
  ok('the freshness oracle did NOT opt in', !/staleFallback/.test(opStatus));
}

function finish() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
