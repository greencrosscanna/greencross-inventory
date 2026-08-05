// Green Cross — GX Core
// Shared sign-on + reference-data library for every GX app (Inventory, Price Tags,
// SPIFF, Sales, Performance). This is its OWN Apps Script project — NOT part of the
// Inventory proxy. App backends bind it as a library (identifier `GXCore`) and call
// GXCore.login() / GXCore.requireAuth() / GXCore.getStores() etc.
//
// Source of truth split (Phase 0 decisions, locked):
//   • Identity + per-app grants + reference data  → the "Green Cross — GX Core" SHEET
//   • Password hashes (salted)                    → this project's ScriptProperties only
//     (the sheet is readable by app owners; secrets never go in it)
//   • Session tokens                              → HMAC-signed, format byte-identical to
//     the Inventory proxy so migrating GC_SESSION_SECRET keeps live sessions valid
//
// Single-writer rule: every mutation goes through gxWrite_(), which takes a script lock
// and appends an audit_log row. App backends are READERS only.

// ─── Constants ────────────────────────────────────────────────────────────────
const GX_CORE_SS_ID_PROP   = 'GX_CORE_SS_ID';        // script property → the GX Core spreadsheet id
const GX_USERS_KEY         = 'gc_users';             // ScriptProperties: { user_id: {hash,salt} | legacyHashString }
const GX_SESSION_SECRET_KEY = 'GC_SESSION_SECRET';   // MUST match the Inventory proxy's value (migrate it in)
const GX_SESSION_TTL_MS    = 7 * 24 * 60 * 60 * 1000; // 7 days — same as Inventory
const GX_AUDIT_MAX_ROWS    = 5000;                    // audit_log ring-buffer cap
const GX_GRANT_CACHE_TTL_S = 60;                      // CacheService TTL for the grants read

const GX_STORES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River Rd'];
const GX_DC_STORE = 'River Rd';                       // River Rd is also the distribution center
const GX_APPS = ['inventory', 'pricetags', 'spiff', 'sales', 'performance', 'core-admin'];

// Tab name → ordered header row. This object IS the schema; gxBootstrap() materializes it.
const GX_TABS = {
  users:           ['user_id', 'display_name', 'email', 'status', 'employee_id', 'default_store', 'is_superadmin', 'created_at', 'updated_at', 'notes'],
  app_access:      ['user_id', 'app', 'role', 'status', 'granted_by', 'granted_at'],
  stores:          ['store_id', 'display_name', 'dutchie_name', 'region', 'short_code', 'sort_order', 'color', 'timezone', 'is_dc', 'dutchie_key_prop', 'active'],
  employees:       ['employee_id', 'full_name', 'home_store', 'dutchie_employee_id', 'role_title', 'status', 'hire_date', 'user_id', 'updated_at'],
  products:        ['sku', 'product_name', 'brand', 'category', 'subcategory', 'size', 'uom', 'dutchie_product_id', 'upc', 'status', 'source', 'updated_at'],
  pricetag_config: ['config_key', 'scope', 'template', 'fields_json', 'value', 'active', 'updated_at'],
  audit_log:       ['ts', 'actor', 'tab', 'row_key', 'action', 'detail'],
  kv:              ['key', 'value', 'notes', 'updated_at'],
};

// ─── Small utilities ───────────────────────────────────────────────────────────
function gxNowIso_() { return new Date().toISOString(); }          // audit timestamps only
function gxToday_()  { return new Date().toISOString().slice(0, 10); } // TEXT date for sheet cells
function gxSlug_(s)  { return String(s || '').trim().toLowerCase(); }

function gxCoreSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(GX_CORE_SS_ID_PROP);
  if (!id) throw new Error('GX Core not bootstrapped — run gxBootstrap() from the editor first.');
  return SpreadsheetApp.openById(id);
}

// Read a tab into array-of-objects keyed by its header row. Dates come back as TEXT
// because we always write them as TEXT (the timezone-shift hard rule).
function gxRead_(tab) {
  const sheet = gxCoreSpreadsheet_().getSheetByName(tab);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values  = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values[0].map(h => String(h || '').trim());
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    return obj;
  }).filter(obj => Object.values(obj).some(v => v !== '' && v !== null));
}

function gxTruthy_(v) {
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'active';
}

// ─── Bootstrap (editor-run, idempotent) ─────────────────────────────────────────
// Creates the GX Core spreadsheet + every tab with headers, seeds stores and a
// superadmin, and pins the spreadsheet id. Safe to re-run: existing tabs/rows are left
// alone. NEVER exposed over HTTP.
function gxBootstrap() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty(GX_CORE_SS_ID_PROP);
  let ss;
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.create('Green Cross — GX Core');
    ssId = ss.getId();
    props.setProperty(GX_CORE_SS_ID_PROP, ssId);
    // Drop the default empty sheet once our tabs exist (handled below).
  }

  // Ensure every tab exists with the right header row.
  Object.keys(GX_TABS).forEach(tab => gxEnsureTab_(ss, tab, GX_TABS[tab]));

  // Remove the auto-created "Sheet1" if it's empty and not one of ours.
  const stray = ss.getSheetByName('Sheet1');
  if (stray && !GX_TABS['Sheet1'] && stray.getLastRow() === 0) ss.deleteSheet(stray);

  gxSeedStores_(ss);
  gxHealStores_();        // backfill region/short_code on rows seeded before those columns existed
  gxSeedSuperadmin_(ss);

  Logger.log('GX Core ready: ' + ss.getUrl());
  return { ok: true, spreadsheetId: ssId, url: ss.getUrl() };
}

function gxEnsureTab_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    // Force the whole sheet to plain text so dates never get coerced to Date objects.
    sheet.getRange(1, 1, sheet.getMaxRows(), Math.max(headers.length, sheet.getMaxColumns()))
      .setNumberFormat('@');
    return sheet;
  }
  // Tab exists — make sure the header row matches (append any missing columns at the end).
  const existing = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    .map(h => String(h || '').trim());
  const missing = headers.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function gxSeedStores_(ss) {
  const sheet = ss.getSheetByName('stores');
  if (sheet.getLastRow() > 1) return; // already seeded
  // Region: Bend and Hillsboro stand alone; the other four are Salem (Center, Commercial,
  // Portland Rd, River Rd) — grouping them disambiguates the four Salem locations.
  const REGION = { 'Bend': 'Bend', 'Hillsboro': 'Hillsboro' };
  const rows = GX_STORES.map((name, i) => ([
    gxSlug_(name).replace(/\s+/g, '-'),  // store_id: "portland-rd"
    name,                                 // display_name — INTERNAL name your team uses
    '',                                   // dutchie_name — what Dutchie calls it (fill in; differs from internal)
    REGION[name] || 'Salem',              // region
    name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(), // short_code
    String(i + 1),                        // sort_order
    '',                                   // color
    'America/Los_Angeles',                // timezone
    name === GX_DC_STORE ? 'TRUE' : 'FALSE', // is_dc
    '',                                   // dutchie_key_prop (name of the ScriptProperty, not the secret)
    'TRUE',                               // active
  ]));
  sheet.getRange(2, 1, rows.length, GX_TABS.stores.length).setValues(rows);
}

// Idempotent: fills empty region/short_code on existing store rows (deterministic from
// display_name) while preserving every other column, including any dutchie_name you've typed.
function gxHealStores_() {
  const rows = gxRead_('stores');
  if (!rows.length) return;
  const REGION = { 'Bend': 'Bend', 'Hillsboro': 'Hillsboro' };
  // Dutchie's store names, lifted from the Inventory app's existing mapping (SKU Probe selector).
  const DUTCHIE = { 'Bend': 'Century', 'Center': 'Center', 'Commercial': 'Commercial', 'Hillsboro': 'Baseline', 'Portland Rd': 'Portland', 'River Rd': 'River' };
  let touched = 0;
  const updates = rows.map(r => {
    const name = String(r.display_name || '').trim();
    const merged = Object.assign({}, r);           // keep the full existing row
    if (!String(r.region || '').trim())       { merged.region = REGION[name] || 'Salem'; touched++; }
    if (!String(r.short_code || '').trim())   { merged.short_code = name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(); touched++; }
    if (!String(r.dutchie_name || '').trim() && DUTCHIE[name]) { merged.dutchie_name = DUTCHIE[name]; touched++; }
    return merged;
  });
  if (touched) gxWrite_('stores', updates, ['store_id']);
}

function gxSeedSuperadmin_(ss) {
  const users = ss.getSheetByName('users');
  if (users.getLastRow() > 1) return;
  const now = gxToday_();
  users.getRange(2, 1, 1, GX_TABS.users.length).setValues([[
    'sky', 'Sky', 'sky@greencrosscanna.com', 'active', '', '', 'TRUE', now, now, 'Bootstrap superadmin',
  ]]);
  // Superadmin gets an explicit core-admin grant too (belt-and-suspenders with is_superadmin).
  const acc = ss.getSheetByName('app_access');
  if (acc.getLastRow() <= 1) {
    acc.getRange(2, 1, 1, GX_TABS.app_access.length).setValues([[
      'sky', 'core-admin', 'admin', 'active', 'bootstrap', now,
    ]]);
  }
}

// ─── Credentials (salted; hashes live ONLY in ScriptProperties) ─────────────────
function gxHashPass_(pass, salt) {
  const input = salt ? (salt + ':' + String(pass)) : String(pass); // no salt = legacy Inventory format
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function gxUsersMap_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(GX_USERS_KEY) || '{}'); }
  catch (e) { return {}; }
}

function gxSaveUsersMap_(map) {
  PropertiesService.getScriptProperties().setProperty(GX_USERS_KEY, JSON.stringify(map));
}

// Verify a password against a stored record. Supports both legacy (string hash, unsalted,
// imported from the Inventory proxy) and current ({hash,salt}) records. On a legacy match
// we transparently upgrade the record to a salted one — no password reset needed.
function gxVerifyPassword_(userId, pass) {
  const map = gxUsersMap_();
  const rec = map[userId];
  if (!rec) return false;
  if (typeof rec === 'string') {                 // legacy unsalted hash
    if (gxHashPass_(pass, '') !== rec) return false;
    gxSetPassword_(userId, pass);                // upgrade-on-login → salted
    return true;
  }
  return rec.hash === gxHashPass_(pass, rec.salt || '');
}

// Editor-only. Sets/updates a salted password for a user.
function gxSetPassword_(userId, pass) {
  const id = gxSlug_(userId);
  if (!id || !pass) throw new Error('Usage: gxSetPassword_(userId, pass)');
  const salt = Utilities.getUuid();
  const map = gxUsersMap_();
  map[id] = { hash: gxHashPass_(pass, salt), salt };
  gxSaveUsersMap_(map);
  Logger.log('Password set for ' + id);
  return { ok: true, user: id };
}

// Editor-only. One-time import of the Inventory proxy's `gc_users` map (a { user: sha256hex }
// object). Paste the exported JSON string. Existing GX Core records are preserved.
function gxImportInventoryUsers_(mapJson) {
  const incoming = typeof mapJson === 'string' ? JSON.parse(mapJson) : (mapJson || {});
  const map = gxUsersMap_();
  let added = 0;
  Object.keys(incoming).forEach(u => {
    const id = gxSlug_(u);
    if (!map[id]) { map[id] = incoming[u]; added++; } // store legacy string as-is; upgrades on first login
  });
  gxSaveUsersMap_(map);
  Logger.log('Imported ' + added + ' users (legacy hashes, will salt-upgrade on login).');
  return { ok: true, added, total: Object.keys(map).length };
}

// ─── Sessions (format identical to the Inventory proxy) ─────────────────────────
function gxSessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(GX_SESSION_SECRET_KEY);
  if (!secret) { secret = Utilities.getUuid() + ':' + Utilities.getUuid(); props.setProperty(GX_SESSION_SECRET_KEY, secret); }
  return secret;
}

function gxSignSession_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, gxSessionSecret_()));
}

function gxIssueToken_(userId) {
  const exp = Date.now() + GX_SESSION_TTL_MS;
  const payload = [gxSlug_(userId), exp].join(':');
  return payload + ':' + gxSignSession_(payload);
}

function gxValidateToken_(token) {
  if (!token) return { ok: false, error: 'Auth required' };
  const parts = String(token).split(':');
  if (parts.length !== 3) return { ok: false, error: 'Invalid session' };
  const user = parts[0], exp = Number(parts[1] || 0);
  if (!user || !exp || Date.now() > exp) return { ok: false, error: 'Session expired' };
  if (parts[2] !== gxSignSession_(user + ':' + exp)) return { ok: false, error: 'Invalid session' };
  return { ok: true, user };
}

// ─── Grants ─────────────────────────────────────────────────────────────────────
function gxIsSuperadmin_(userId) {
  const id = gxSlug_(userId);
  return gxRead_('users').some(u => gxSlug_(u.user_id) === id
    && gxTruthy_(u.status || 'active') !== false && gxTruthy_(u.is_superadmin));
}

// Returns the active per-app role for (user, app), or null. Superadmins get 'admin' on any app.
// Cached briefly so we don't read the sheet on every authenticated request.
function gxRoleForApp_(userId, app) {
  const id = gxSlug_(userId), a = gxSlug_(app);
  if (gxIsSuperadmin_(id)) return 'admin';
  const cache = CacheService.getScriptCache();
  const ckey = 'gxgrant:' + id;
  let grants;
  const cached = cache.get(ckey);
  if (cached) {
    grants = JSON.parse(cached);
  } else {
    grants = {};
    gxRead_('app_access').forEach(r => {
      if (gxSlug_(r.user_id) === id && gxTruthy_(r.status || 'active'))
        grants[gxSlug_(r.app)] = String(r.role || 'viewer').trim().toLowerCase();
    });
    cache.put(ckey, JSON.stringify(grants), GX_GRANT_CACHE_TTL_S);
  }
  return grants[a] || null;
}

function gxInvalidateGrantCache_(userId) {
  CacheService.getScriptCache().remove('gxgrant:' + gxSlug_(userId));
}

// ─── PUBLIC API — called by app backends via the bound library (GXCore.*) ────────

// Log a user into a specific app. Returns { ok, user, role, token, expiresAt } or { ok:false, error }.
function login(user, pass, app) {
  const id = gxSlug_(user);
  if (!id || !pass) return { ok: false, error: 'Missing credentials' };
  if (!gxVerifyPassword_(id, pass)) return { ok: false, error: 'Invalid username or password' };
  const role = gxRoleForApp_(id, app);
  if (!role) return { ok: false, error: 'No access to ' + app };
  return {
    ok: true, user: id, role,
    token: gxIssueToken_(id),
    expiresAt: new Date(Date.now() + GX_SESSION_TTL_MS).toISOString(),
  };
}

// Validate a request's token AND the user's access to `app`. Error strings match the
// Inventory proxy so existing frontend handling ('Session expired' → re-login) is unchanged.
function requireAuth(params, app) {
  const v = gxValidateToken_((params && (params.token || params.session || params.auth)) || '');
  if (!v.ok) return v;
  const role = gxRoleForApp_(v.user, app);
  if (!role) return { ok: false, error: 'Access revoked' };
  return { ok: true, user: v.user, role };
}

// Reference-data readers (many-reader side of the single-writer rule).
function getStores()            { return gxRead_('stores').filter(r => gxTruthy_(r.active || 'true')); }
function getProducts()          { return gxRead_('products'); }
function getEmployees()         { return gxRead_('employees'); }
function getPricetagConfig()    { return gxRead_('pricetag_config').filter(r => gxTruthy_(r.active || 'true')); }
function getGrantsForUser(user) {
  const id = gxSlug_(user);
  return gxRead_('app_access').filter(r => gxSlug_(r.user_id) === id && gxTruthy_(r.status || 'active'))
    .map(r => ({ app: gxSlug_(r.app), role: String(r.role || 'viewer').toLowerCase() }));
}
function getKv(key) {
  const row = gxRead_('kv').find(r => String(r.key).trim() === String(key).trim());
  return row ? row.value : null;
}

// ─── Single-writer: every mutation takes the lock and logs ──────────────────────
// Upsert rows into `tab` keyed by `keyCols` (array of column names forming the row key).
// `records` is an array of plain objects using the tab's header names.
function gxWrite_(tab, records, keyCols) {
  if (!GX_TABS[tab]) throw new Error('Unknown GX Core tab: ' + tab);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialize — concurrent runs must not race the shared cursor
  try {
    const ss = gxCoreSpreadsheet_();
    const sheet = ss.getSheetByName(tab);
    if (!sheet) throw new Error('Missing GX Core tab: ' + tab);
    // Map by the sheet's ACTUAL header row, not GX_TABS order — so appended columns never
    // misalign existing data.
    const width   = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(h => String(h || '').trim());
    const lastRow = sheet.getLastRow();
    const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];
    const keyOf = row => keyCols.map(k => String(row[headers.indexOf(k)] || '').trim().toLowerCase()).join('¦');
    const idxByKey = {};
    existing.forEach((row, i) => { idxByKey[keyOf(row)] = i; });

    const appends = [];
    records.forEach(rec => {
      const rowArr = headers.map(h => (rec[h] === undefined || rec[h] === null) ? '' : String(rec[h]));
      const k = keyCols.map(c => String(rec[c] || '').trim().toLowerCase()).join('¦');
      if (idxByKey[k] !== undefined) {
        sheet.getRange(2 + idxByKey[k], 1, 1, width).setValues([rowArr]);
      } else {
        appends.push(rowArr);
      }
    });
    if (appends.length) sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, width).setValues(appends);
    return { ok: true, upserted: records.length, appended: appends.length };
  } finally {
    lock.releaseLock();
  }
}

function gxAudit_(actor, tab, rowKey, action, detail) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = gxCoreSpreadsheet_().getSheetByName('audit_log');
    sheet.appendRow([gxNowIso_(), String(actor || ''), String(tab || ''), String(rowKey || ''), String(action || ''), String(detail || '').slice(0, 500)]);
    const n = sheet.getLastRow() - 1;
    if (n > GX_AUDIT_MAX_ROWS) sheet.deleteRows(2, n - GX_AUDIT_MAX_ROWS); // ring buffer
  } finally {
    lock.releaseLock();
  }
}

// ─── Admin mutations (editor or core-admin app) ─────────────────────────────────
function gxUpsertUser(user) {
  const id = gxSlug_(user.user_id);
  if (!id) throw new Error('user_id required');
  const now = gxToday_();
  gxWrite_('users', [Object.assign({ status: 'active', is_superadmin: 'FALSE', created_at: now }, user, { user_id: id, updated_at: now })], ['user_id']);
  gxAudit_('gxUpsertUser', 'users', id, 'upsert', JSON.stringify(user));
  return { ok: true, user_id: id };
}

function gxGrantAccess(userId, app, role, grantedBy) {
  const id = gxSlug_(userId), a = gxSlug_(app);
  if (GX_APPS.indexOf(a) === -1) throw new Error('Unknown app: ' + a);
  gxWrite_('app_access', [{ user_id: id, app: a, role: (role || 'viewer'), status: 'active', granted_by: gxSlug_(grantedBy || 'editor'), granted_at: gxToday_() }], ['user_id', 'app']);
  gxInvalidateGrantCache_(id);
  gxAudit_(grantedBy || 'editor', 'app_access', id + '¦' + a, 'grant', role || 'viewer');
  return { ok: true, user_id: id, app: a, role: role || 'viewer' };
}

function gxRevokeAccess(userId, app, revokedBy) {
  const id = gxSlug_(userId), a = gxSlug_(app);
  gxWrite_('app_access', [{ user_id: id, app: a, role: '', status: 'revoked', granted_by: gxSlug_(revokedBy || 'editor'), granted_at: gxToday_() }], ['user_id', 'app']);
  gxInvalidateGrantCache_(id);
  gxAudit_(revokedBy || 'editor', 'app_access', id + '¦' + a, 'revoke', '');
  return { ok: true, user_id: id, app: a };
}

// Editor-run, no args. After the Inventory `gc_users` map has been copied into GX Core's
// script properties, this grants every one of those users `inventory` access so their existing
// logins keep working once Inventory delegates to GX Core. Idempotent.
function gxSeedInventoryGrants() {
  const users = Object.keys(gxUsersMap_());
  if (!users.length) return { ok: false, error: 'No users found — copy the `gc_users` property from the Inventory project into GX Core first.' };
  users.forEach(u => gxGrantAccess(u, 'inventory', 'editor', 'sky'));
  Logger.log('Granted inventory/editor to ' + users.length + ' users: ' + users.join(', '));
  return { ok: true, granted: users };
}

// Editor-run, no args, no secrets. Prints a safe summary so we can confirm the Phase 1 seed
// (secret copied, users imported, grants created, store names filled) before Inventory cuts over.
function gxDiag() {
  const props  = PropertiesService.getScriptProperties();
  const users  = gxUsersMap_();
  const stores = gxRead_('stores');
  const grants = gxRead_('app_access').filter(r => gxSlug_(r.app) === 'inventory' && gxTruthy_(r.status || 'active'));
  const out = {
    usersInCredMap:           Object.keys(users).length,
    sessionSecretSet:         !!props.getProperty(GX_SESSION_SECRET_KEY),
    coreSpreadsheetSet:       !!props.getProperty(GX_CORE_SS_ID_PROP),
    inventoryGrantUsers:      grants.map(g => gxSlug_(g.user_id)),
    storesTotal:              stores.length,
    storesMissingDutchieName: stores.filter(s => !String(s.dutchie_name || '').trim()).map(s => s.display_name),
    superadmins:              gxRead_('users').filter(u => gxTruthy_(u.is_superadmin)).map(u => gxSlug_(u.user_id)),
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function gxUpsertProduct(p) {
  const sku = String(p.sku || '').trim();
  if (!sku) throw new Error('sku required');
  gxWrite_('products', [Object.assign({ status: 'active', source: 'manual' }, p, { sku, updated_at: gxToday_() })], ['sku']);
  return { ok: true, sku };
}

// ─── Retention sweep (time-driven trigger, e.g. weekly) ─────────────────────────
function gxRetentionSweep() {
  const sheet = gxCoreSpreadsheet_().getSheetByName('audit_log');
  const n = sheet.getLastRow() - 1;
  if (n > GX_AUDIT_MAX_ROWS) sheet.deleteRows(2, n - GX_AUDIT_MAX_ROWS);
  return { ok: true, audit_rows: Math.min(n, GX_AUDIT_MAX_ROWS) };
}

// ─── Optional HTTP surface (health + direct login/validate for JSONP callers) ────
// App backends use the bound library and don't need this. It exists so a future GX
// launcher page (or the JSONP fallback) can authenticate directly against GX Core.
function doGet(e) {
  const p = (e && e.parameter) || {};
  const out = (obj) => {
    const body = JSON.stringify(obj);
    if (p.callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(p.callback))
      return ContentService.createTextOutput(p.callback + '(' + body + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
  };
  try {
    if (p.action === 'health') return out({ ok: true, service: 'gx-core', bootstrapped: !!PropertiesService.getScriptProperties().getProperty(GX_CORE_SS_ID_PROP) });
    if (p.action === 'login')  return out(login(p.user, p.pass, p.app));
    if (p.action === 'validate') return out(requireAuth(p, p.app));
    if (p.action === 'grants') { const v = gxValidateToken_(p.token || ''); return out(v.ok ? { ok: true, user: v.user, grants: getGrantsForUser(v.user) } : v); }
    return out({ error: 'Unknown action' });
  } catch (err) {
    return out({ error: err.message });
  }
}
