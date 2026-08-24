// Green Cross Cannabis — Inventory Proxy
// Google Apps Script Web App
// Execute as: USER_DEPLOYING | Access: ANYONE_ANONYMOUS

// ─── Constants ────────────────────────────────────────────────────────────────
const LIVE_SPREADSHEET_ID         = '1OBNzkBrJtLIlf8xknVlGd6Jb8nlkg4_KG-Gq6BD7HHY';
const BETA_SPREADSHEET_ID         = '1expq2qh9uRU51BdBKq_GmYgyHLrRhmryPtWjDJsWdxg';
const SPREADSHEET_ID              = LIVE_SPREADSHEET_ID;
const SALES_HISTORY_SPREADSHEET_ID = '18f8iwnnMucXog5fMsLN2VwEoC6kFu3h-b8MDpZlc7ks';
const SALES_HISTORY_GID            = 1938453538;
const SNAPSHOT_SHEET_NAME          = 'Inv Snapshot';
const SKU_DICT_SHEET_NAME          = 'Product SKU Dict';
const STORE_CONFIG_SHEET_NAME      = 'Config - Stores';
const SKU_OVERRIDES_SHEET_NAME     = 'Config - SKU Overrides';
const REORDER_RULES_SHEET_NAME     = 'Config - Reorder Rules';
const VENDOR_LEAD_TIMES_SHEET_NAME = 'Config - Vendor Lead Times';
const DECISION_FEED_SHEET_NAME     = 'Decision Feed';
const OPERATIONAL_SNAPSHOT_SHEET_NAME = 'Operational Snapshot';
const SHARED_STATE_SHEET_NAME      = 'Shared State';
const LOADING_QUOTES_SHEET_NAME    = 'Loading Quotes';
const DUTCHIE_BASE                 = 'https://api.pos.dutchie.com';

const STORES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River Rd'];
const DUTCHIE_STORE_KEYS_PROP = 'DUTCHIE_STORE_KEYS_JSON';

const SHEET_GIDS = {
  budget: 1092240858,
  atm:    1349619595,
  sublet: 1274502465,
};

// ── GX Core business config (Phase C) — constants live in GX Core (?action=config); these hardcodes
// are the offline fallback. Fetched once per 6h via CacheService (no per-request endpoint hit).
const GX_CORE_EXEC_URL = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
function gxLoadConfig_() {
  try {
    const cache = CacheService.getScriptCache();
    const hit = cache.get('gx_cfg');
    if (hit) return JSON.parse(hit);
    const resp = UrlFetchApp.fetch(GX_CORE_EXEC_URL + '?action=config', { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      const j = JSON.parse(resp.getContentText());
      if (j && j.ok && j.config) {
        const cfg = {};
        Object.keys(j.config).forEach(k => { cfg[k.replace(/^cfg\./, '')] = j.config[k]; });
        cache.put('gx_cfg', JSON.stringify(cfg), 6 * 3600);
        return cfg;
      }
    }
  } catch (e) { /* offline → use hardcode fallbacks below */ }
  return {};
}
const _GX_CFG = gxLoadConfig_();
function gxCfgNum_(key, fallback) {
  const raw = _GX_CFG[key], v = Number(raw);
  return (raw !== '' && raw != null && isFinite(v)) ? v : fallback;
}

// Reorder defaults — sourced from GX Core config, hardcodes as fallback (team-confirmed 7-day window).
const LEAD_TIME_DAYS    = gxCfgNum_('invLeadDays', 7);
const SAFETY_STOCK_DAYS = gxCfgNum_('invSafetyDays', 7);
const REORDER_BUFFER    = gxCfgNum_('invReorderTargetDays', LEAD_TIME_DAYS + SAFETY_STOCK_DAYS); // 14 days
const STANDARD_VENDOR_LEAD_DAYS = gxCfgNum_('invLeadDays', 7);
// DOH status thresholds + bulk-flower MOQ — also from GX Core config (fallback = prior hardcodes).
const DOH_CRITICAL_DAYS = gxCfgNum_('invDohCriticalDays', 3);
const DOH_LOW_DAYS      = gxCfgNum_('invDohLowDays', 7);
const DOH_WATCH_DAYS    = gxCfgNum_('invDohWatchDays', 14);
const BULK_FLOWER_MOQ_G = gxCfgNum_('invBulkFlowerMoqG', 227);
const GC_USERS_KEY      = 'gc_users';
const GC_SESSION_SECRET_KEY = 'GC_SESSION_SECRET';
const GC_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OPERATIONAL_WARM_STATUS_KEY = 'gc_operational_warm_status';
const GAS_ERROR_LOG_KEY            = 'gc_error_log';          // PropertiesService ring buffer
const GAS_ERROR_LOG_MAX            = 20;                       // keep last N entries
const FEED_REFRESH_SCHEDULED_KEY   = 'feedRefreshScheduledAt'; // cooldown for _isFeedStale_

// ── GAS error log ─────────────────────────────────────────────────────────────
// Lightweight ring buffer stored in PropertiesService so overnight failures are
// visible in the Settings UI rather than dying silently in the GAS execution log.
function _logGasError(fn, msg) {
  try {
    const props = PropertiesService.getScriptProperties();
    const raw   = props.getProperty(GAS_ERROR_LOG_KEY);
    const log   = raw ? JSON.parse(raw) : [];
    log.push({ ts: new Date().toISOString(), fn: String(fn), msg: String(msg).slice(0, 300) });
    if (log.length > GAS_ERROR_LOG_MAX) log.splice(0, log.length - GAS_ERROR_LOG_MAX);
    props.setProperty(GAS_ERROR_LOG_KEY, JSON.stringify(log));
  } catch(e) { /* never let error logging itself crash anything */ }
}

function getGasErrors() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(GAS_ERROR_LOG_KEY);
    return { ok: true, errors: raw ? JSON.parse(raw) : [] };
  } catch(e) {
    return { ok: false, errors: [], error: e.message };
  }
}

function clearGasErrors() {
  PropertiesService.getScriptProperties().deleteProperty(GAS_ERROR_LOG_KEY);
  return { ok: true, message: 'Error log cleared.' };
}

// ── Loading Quotes ────────────────────────────────────────────────────────────
const DEFAULT_LOADING_QUOTES_ = [
  ["Marijuana is not a drug…", "but waiting on this inventory is a goddamn addiction."],
  ["It's giving… loading…", "and this inventory is not giving quickly."],
  ["It'd be a lot cooler if you did…", "load the inventory faster, dude."],
  ["This is the dopest inventory I ever waited on…", "if this motherfucker ever shows up."],
  ["Man, am I driving okay?…", "Nah, I think we're parked. Still waiting on the inventory."],
  ["I love weed, okay, I LOVE it…", "but not as much as I love this inventory finally dropping."],
  ["It's almost a shame to check this inventory…", "it's like killing a unicorn with a bomb."],
  ["Hold up…", "I just forgot what the fuck we were even waiting on."],
  ["The monkey's out of the bottle, man…", "Pandora doesn't go back in the box with this slow inventory."],
  ["Say man, you got some inventory?…", "Nah? Then this wait gonna take all day."],
  ["I can hear my hair growing…", "while this damn inventory spins forever."],
  ["Fuck it, dude. Let's go bowling…", "after the inventory finally shows up."],
  ["You ever see the back of a $20 bill…", "on weed? That's how slow this inventory feels."],
  ["If this takes any longer I'm lighting up in the back…", "fuck it."],
  ["Puff puff give…", "puff puff give… you're fuckin' up the whole inventory rotation!"],
  ["I don't do drugs…", "just weed. And waiting on this bullshit inventory."],
  ["I'll be back.", "Said the inventory. It wasn't."],
  ["To infinity and beyond!", "That's roughly how long this inventory is taking."],
  ["Life is like a box of chocolates.", "You never know what inventory you're gonna get."],
  ["You can't handle the truth!", "Especially not how slow this inventory loads."],
  ["Say hello to my little friend.", "He also has no idea where the inventory went."],
  ["I am your father.", "And I am STILL waiting on this inventory."],
  ["Houston, we have a problem.", "The inventory hasn't landed yet."],
  ["You talking to me?", "Because this inventory sure as hell isn't."],
  ["May the Force be with you.", "You're gonna need it waiting on this inventory."],
  ["Just keep swimming.", "Just keep loading, just keep loading."],
  ["Why so serious?", "Relax. The inventory is probably almost here."],
  ["Elementary, my dear Watson.", "The inventory is clearly loading. Slowly."],
  ["They may take our lives.", "But they'll never take our INVENTORY!"],
  ["Get busy living, or get busy dying.", "Or just get busy waiting on this inventory."],
  ["Hasta la vista, baby.", "Said the inventory data. Still hasn't come back."],
  ["I feel the need… the need for speed.", "This inventory did not get the memo."],
];

function ensureLoadingQuotesSheet_() {
  const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
  let sheet = ss.getSheetByName(LOADING_QUOTES_SHEET_NAME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(LOADING_QUOTES_SHEET_NAME);
  const rows = [['setup', 'punchline'], ...DEFAULT_LOADING_QUOTES_];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  return sheet;
}

function getLoadingQuotes() {
  try {
    ensureLoadingQuotesSheet_();
    const quotes = sheetToObjects_(LOADING_QUOTES_SHEET_NAME, getInvDataSpreadsheetId())
      .filter(r => r.setup && r.punchline)
      .map(r => [String(r.setup), String(r.punchline)]);
    return { ok: true, quotes };
  } catch(e) {
    _logGasError('getLoadingQuotes', e.message);
    return { ok: false, quotes: [], error: e.message };
  }
}

function getDataMode() {
  return (PropertiesService.getScriptProperties().getProperty('GC_DATA_MODE') || 'live').toLowerCase();
}

function getDataSpreadsheetId() {
  return getDataMode() === 'beta' ? BETA_SPREADSHEET_ID : LIVE_SPREADSHEET_ID;
}

// The inventory tool's own data sheets (Vel Cache, Inv Snapshot, ProductCatalog,
// Product SKU Dict, Operational Snapshot, Loading Quotes) live in a DEDICATED spreadsheet so
// they don't consume the financial workbook's 10,000,000-cell cap (they had filled it, which
// blocked velocity sync, snapshot builds and everything else). The id is stored in a script
// property after migration; until then this falls back to the financial workbook so behavior
// is unchanged. Financial reads (income/budget via getSheetByGid) and the BETA-spreadsheet
// sheets (Decision Feed, Shared State) are unaffected — they keep using their own ids.
function getInvDataSpreadsheetId() {
  return PropertiesService.getScriptProperties().getProperty('INV_DATA_SS_ID') || getDataSpreadsheetId();
}

// ─── Router ───────────────────────────────────────────────────────────────────
function testEmail() {
  MailApp.sendEmail('sky@greencrosscanna.com', '🐞 Bug Reporter Test', 'Mail scope is working — bug reports will now send emails.');
}

// Run once from the editor to store the LeafLink API key securely.
// Do not expose this as an HTTP route.
function setLeafLinkKeyFromValue_(apiKey) {
  if (!apiKey) throw new Error('Pass the LeafLink API key as the apiKey argument.');
  PropertiesService.getScriptProperties().setProperty('LL_API_KEY', String(apiKey).trim());
  Logger.log('LeafLink API key saved.');
}

function doGet(e) {
  const params = e.parameter;
  // Serve the frontend app when no action is specified
  if (!params.action) {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Green Cross — Inventory')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  try {
    if (params.action === 'login') return jsonOut(loginUser(params), params.callback);
    // Pre-auth diagnostic: which GXCore snapshot is this DEPLOYMENT actually running? A library
    // call executes the version pinned in the deployed manifest, not gx_core.gs as it reads today,
    // so re-pins can only be confirmed against the live url. Returns the version number and nothing else.
    if (params.action === 'libversion')     return jsonOut(getLibVersion_(), params.callback);
    if (params.action === 'writeauthprobe') return jsonOut(writeAuthProbe_(), params.callback);
    const auth = requireAuth_(params);
    if (!auth.ok) return jsonOut(auth);
    // Identity is established above. A mutation additionally has to clear the LIVE grant in GX Core
    // (see requireWriteAuth_) so a revoked user cannot keep writing until their token expires.
    if (WRITE_ACTIONS[params.action]) {
      const writeAuth = requireWriteAuth_(params);
      if (!writeAuth.ok) return jsonOut(writeAuth, params.callback);
    }
    // Inventory
    if (params.action === 'inventory')      return jsonOut(getInventory(params));
    if (params.action === 'inventorylive')  return jsonOut(getLiveInventory(params));
    if (params.action === 'velocity')       return jsonOut(getVelocityEndpoint(params));
    if (params.action === 'operationalbundle') return jsonOut(getOperationalBundle(params));
    if (params.action === 'operationalstatus') return jsonOut(getOperationalSnapshotStatus());
    if (params.action === 'velsync')        return jsonOut(syncVelocityCache());
    if (params.action === 'warmcaches')        return jsonOut(warmOperationalCaches());
    if (params.action === 'warmvelocity')      return jsonOut(warmVelocityOnly());
    if (params.action === 'warmbundle')        return jsonOut(warmBundleOnly());
    if (params.action === 'warmdecision')      return jsonOut(warmDecisionFeedOnly());
    if (params.action === 'gaserrors')         return jsonOut(getGasErrors());
    if (params.action === 'clearerrors')       return jsonOut(clearGasErrors());
    if (params.action === 'schedulewarmcaches') return jsonOut(scheduleOperationalWarmRun());
    if (params.action === 'installwarmtrigger') return jsonOut(setupOperationalCacheTrigger());
    if (params.action === 'triggerstatus')  return jsonOut(getTriggerStatus());
    if (params.action === 'velreset')       return jsonOut(resetVelSyncDate());
    if (params.action === 'velresyncfrom')  return jsonOut(velResyncFrom(params));
    if (params.action === 'veldedup')       return jsonOut(velDedup());
    if (params.action === 'velclearfrom')   return jsonOut(velClearFrom(params));
    if (params.action === 'velclear')       return jsonOut(clearVelCache());
    if (params.action === 'velbackfill')       return jsonOut(velBackfillChunk(params));
    if (params.action === 'velbackfillstatus') return jsonOut(velBackfillStatus());
    if (params.action === 'velproduct')        return jsonOut(velProductDiagnostic(params));
    if (params.action === 'velgapcheck')       return jsonOut(velGapCheck(params));
    if (params.action === 'velgapaudit')       return jsonOut(velGapAudit());
    if (params.action === 'getstate')          return jsonOut(getSharedState(params));
    if (params.action === 'leadtimes')         return jsonOut(getLeadTimes());
    if (params.action === 'setleadtimes')      return jsonOut(setLeadTimes(params));
    if (params.action === 'sharedkill')        return jsonOut(sharedKill(params));
    if (params.action === 'sharedunkill')      return jsonOut(sharedUnkill(params));
    if (params.action === 'sharedretire')      return jsonOut(sharedRetire(params));
    if (params.action === 'sharedunretire')    return jsonOut(sharedUnretire(params));
    if (params.action === 'sharedflag')        return jsonOut(sharedFlag(params));
    if (params.action === 'salesdiag')      return jsonOut(getSalesHistoryDiagnostics());
    if (params.action === 'apiexplore')     return jsonOut(exploreApi(params));
    if (params.action === 'skuprobe')       return jsonOut(skuRoomProbe(params));
    if (params.action === 'txprobe')        return jsonOut(txProbe(params));
    if (params.action === 'salestxprobe')   return jsonOut(salesTxProbe(params));
    if (params.action === 'skusales')       return jsonOut(skuSalesSearch(params));
    if (params.action === 'txtypeprobe')    return jsonOut(txTypeProbe(params));
    if (params.action === 'invfieldprobe')  return jsonOut(invFieldProbe(params));
    if (params.action === 'labresultsprobe') return jsonOut(labResultsProbe(params));
    if (params.action === 'fattytracker')    return jsonOut(getFattyTracker(params));
    if (params.action === 'snapshotprobe')  return jsonOut(snapshotProbe(params));
    if (params.action === 'invrooms')       return jsonOut(invRoomsProbe(params));
    if (params.action === 'invtxlookup')    return jsonOut(invTxLookup(params));
    if (params.action === 'prodcatalog')    return jsonOut(buildProductIdDict());
    if (params.action === 'prodcatclear')   return jsonOut(clearProductCatalogCache());
    if (params.action === 'roomcacheclear') return jsonOut(clearRoomCache());
    if (params.action === 'roomidprobe')    return jsonOut(roomIdProbe(params));
    if (params.action === 'roomendpointprobe') return jsonOut(roomEndpointProbe(params));
    if (params.action === 'txfullprobe')    return jsonOut(txFullProbe(params));
    if (params.action === 'skudebug')       return jsonOut(skuDebug(params));
    if (params.action === 'sheetsinfo')     return jsonOut(sheetsInfo(params));
    if (params.action === 'trimempty')      return jsonOut(trimEmptySheetSpace(params));
    if (params.action === 'migrateinvdata') return jsonOut(migrateInventoryData(params));
    if (params.action === 'copyinvsnap')    return jsonOut(copyInvSnapshotRecent(params));
    if (params.action === 'deletemigrated') return jsonOut(deleteMigratedFromFinancial(params));
    if (params.action === 'roomdata')       return jsonOut(buildRoomData(params.store || 'Hillsboro'));
    if (params.action === 'retiredprobe')   return jsonOut(retiredProbe(params));
    if (params.action === 'returnprobe')    return jsonOut(returnProbe(params));
    if (params.action === 'rooms')          return jsonOut(getRooms(params));
    if (params.action === 'quarantine')     return jsonOut(getQuarantine(params));
    if (params.action === 'oosmap')         return jsonOut(getOOSMap());
    if (params.action === 'bugreport')      return jsonOut(handleBugReport(params));
    if (params.action === 'llorders')       return jsonOut(getLeafLinkOrders());
    if (params.action === 'getupcmap')      return jsonOut(getUpcMap());
    if (params.action === 'setupcentry')    return jsonOut(setUpcEntry(params));
    // COGS / sales dashboard
    if (params.action === 'cogs_dutchie')   return jsonOut(getCogsDutchie(params));
    if (params.action === 'sales_dutchie')  return jsonOut(getSalesDutchie(params));
    if (params.action === 'lostsales')      return jsonOut(getLostSales(params));
    if (params.action === 'assortment')     return jsonOut(getAssortmentHealth(params));
    if (params.action === 'assortmentconfig') return jsonOut(getSubstitutionConfig_());
    if (params.action === 'storetxhistory') return jsonOut(getStoreTxHistory(params));
    if (params.action === 'budget')         return jsonOut(getBudget());
    if (params.action === 'schema')         return jsonOut(getSchema());
    if (params.action === 'datamode')       return jsonOut({ mode: getDataMode(), spreadsheetId: getDataSpreadsheetId() });
    if (params.action === 'stores')         return jsonOut(getStoresConfig());
    if (params.action === 'betadecisionfeed') return jsonOut(generateBetaDecisionFeed(params));
    if (params.action === 'decisionfeed')   return jsonOut(readBetaDecisionFeed(params));
    if (params.action === 'decisionqueue')  return jsonOut(readBetaDecisionQueue(params));
    if (params.action === 'loadingquotes')  return jsonOut(getLoadingQuotes());
    return jsonOut({ error: 'Unknown action' }, params.callback);
  } catch (err) {
    return jsonOut({ error: err.message, stack: err.stack }, params.callback);
  }
}

function jsonOut(obj, callback) {
  const body = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(String(callback))) {
    return ContentService
      .createTextOutput(String(callback) + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

function handleBugReport(b) {
  // GX Command Center is now the SINGLE bug log — this app no longer writes its own
  // "GC Bug Reports" sheet. The email below is both the alert and a no-lost-report
  // fallback if GX Core is ever unavailable. (BUG_REPORTS_SS_ID script property is left
  // in place, harmless; the old sheet is deleted separately once migration is verified.)
  const ts = new Date();

  // Email notification (alert + durability fallback)
  try {
    const priorityEmoji = { low: '🟢', medium: '🟡', high: '🔴' }[b.priority] || '🟡';
    MailApp.sendEmail({
      to:      'sky@greencrosscanna.com',
      subject: `${priorityEmoji} Bug [${b.priority || 'medium'}]: ${b.title}`,
      body: [
        `Reporter : ${b.reporter}`,
        `Priority : ${b.priority}`,
        `Tab      : ${b.appTab}`,
        `Store    : ${b.appStore}`,
        `Version  : ${b.appVer}`,
        `Time     : ${ts.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`,
        '',
        b.desc || '(no details provided)',
      ].join('\n'),
    });
  } catch(mailErr) { /* non-fatal */ }

  // Central bug log — write into GX Core's shared bug_reports table (Command Center cockpit).
  // NOTE: the library function is gxIngestBug(app, reporter, payload) — NOT ingestBug, which
  // does not exist in GX Core v12 and would throw, silently dropping every report.
  // Route to the right Command Center project. Price Cards is a sub-app of Inventory with its own project
  // key ('pricecards'), so a bug filed from its tab (state.tab === 'pricetags') goes there; everything else
  // is Inventory. Keep this map in sync as more Inventory sub-apps get their own project keys.
  var TAB_TO_APP = { pricetags: 'pricecards' };
  var bugApp = TAB_TO_APP[String(b.appTab || '').toLowerCase()] || 'inventory';
  try {
    GXCore.gxIngestBug(bugApp, b.reporter, {
      title: b.title, desc: b.desc, priority: b.priority,
      store: b.appStore, tab: b.appTab, appVer: b.appVer
    });
  } catch (e) { /* central unavailable — the email above is the fallback */ }

  return { ok: true };
}

// ─── Store helpers ────────────────────────────────────────────────────────────
function dutchieAuth(store) {
  const key = getDutchieStoreKeys_()[store];
  if (!key) throw new Error('Unknown store: ' + store);
  return 'Basic ' + Utilities.base64Encode(key + ':');
}

function getDutchieStoreKeys_() {
  const raw = PropertiesService.getScriptProperties().getProperty(DUTCHIE_STORE_KEYS_PROP);
  if (!raw) throw new Error('Dutchie store keys are not configured.');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('Dutchie store keys are invalid JSON.');
  }
}

function isKnownStore(store) {
  return !!getDutchieStoreKeys_()[store];
}

function parseSaleDate(raw) {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    // "1/1/26 0:00" → M/D/YY format
    const m = raw.match(/^(\d+)\/(\d+)\/(\d+)/);
    if (m) {
      const yr = parseInt(m[3]);
      return new Date(yr < 100 ? 2000 + yr : yr, parseInt(m[1]) - 1, parseInt(m[2]));
    }
  }
  return null;
}

// ─── ROOM METADATA (cached 1h per store) ──────────────────────────────────────
function getStoreRooms(store) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'rooms_' + store;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const resp = UrlFetchApp.fetch(DUTCHIE_BASE + '/room/rooms', { headers: hdrs, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;

  const rooms = JSON.parse(resp.getContentText());
  cache.put(cacheKey, JSON.stringify(rooms), 3600); // cache 1 hour
  return rooms;
}

// ─── ROOM CLASSIFIER ─────────────────────────────────────────────────────────
// Returns { roomNameType, invRoomMap }.
// roomNameType: room name → 'floor'|'quarantine'|'sample'|'distro'|'back'
// invRoomMap:   inventoryId → type (transaction-based fallback)
// Primary classification order in getInventory:
//   1. item.roomQuantities array (most accurate — per-package split)
//   2. item.roomName / item.roomId field
//   3. invRoomMap (latest Move transaction, last resort)
//   4. default 'back'
const ROOM_DATA_CACHE_PREFIX = 'roomdata4_';

// Dutchie's /inventory/inventorytransaction now REQUIRES both startDate and endDate and
// caps the range at 31 days (previously it accepted an unbounded startDate, or none). The
// old requests passed only startDate / no dates → HTTP 400 → zero Move rows → empty
// invRoomMap → no room designation (every package fell to the default, and River's default
// was 'distro', hiding its whole floor — the Tawny bug). Fix: query the endpoint in dated
// ≤31-day windows covering ROOM_TX_LOOKBACK_DAYS of history; the latest toRoom per
// inventoryId gives each package's current room. More windows = deeper history but more
// API calls; 6×30d = 180 days covers essentially all currently-held stock's last move.
// Widened from 4 windows (2026-08-24): the unknown-room DEFAULT below is now 'distro' at a
// DC, so a package whose last Move aged out of the window would be hidden as distro rather
// than counted as on-hand. Every extra window shrinks that tail — at River, stock untouched
// for >120d was ~1,700 units, >240d only ~500.
const ROOM_TX_WINDOW_DAYS   = 30;  // per-request span, must stay ≤ 31 (API cap)
const ROOM_TX_WINDOW_COUNT  = 6;   // → 180 days of move history

// Build the parallel requests for one store's room data.
// Layout: [ /room/rooms, ...N inventorytransaction windows, /reporting/transactions ].
// _processRoomData_ reads responses[0] as rooms, responses[last] as register, and
// everything between as Move-transaction windows — so the window count can change freely.
function _roomDataRequests_(store) {
  const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const now  = Date.now();
  const reqs = [
    { url: DUTCHIE_BASE + '/room/rooms', headers: hdrs, muteHttpExceptions: true },
  ];
  const spanMs = ROOM_TX_WINDOW_DAYS * 86400000;
  for (let w = 0; w < ROOM_TX_WINDOW_COUNT; w++) {
    // Window w covers [today - (w+1)*30d, today - w*30d]. w=0's end is tomorrow so today is included.
    const endMs   = now - (w * spanMs) + (w === 0 ? 86400000 : 0);
    const startMs = now - ((w + 1) * spanMs);
    const startD  = new Date(startMs).toISOString().slice(0, 10);
    const endD    = new Date(endMs).toISOString().slice(0, 10);
    reqs.push({ url: DUTCHIE_BASE + '/inventory/inventorytransaction?startDate=' + startD + '&endDate=' + endD, headers: hdrs, muteHttpExceptions: true });
  }
  // Register transactions (last 14 days) — used to detect customer returns → quarantine.
  const now14ISO = new Date(now - 14 * 86400000).toISOString();
  const nowISO   = new Date(now).toISOString();
  reqs.push({ url: DUTCHIE_BASE + '/reporting/transactions?FromDateUTC=' + encodeURIComponent(now14ISO) + '&ToDateUTC=' + encodeURIComponent(nowISO) + '&IncludeDetail=true', headers: hdrs, muteHttpExceptions: true });
  return reqs;
}

// Process the responses (in _roomDataRequests_ order) into the room-data result object.
// Pure — no fetching, no caching — so it works for both single-store and batch paths.
// responses[0] = /room/rooms, responses[last] = register txns, middle = Move-tx windows.
function _processRoomData_(responses) {
  const roomsResp = responses[0];
  const regResp   = responses[responses.length - 1];
  const txResps   = responses.slice(1, responses.length - 1);

  const roomNameType = {};  // name → type
  const roomIdType   = {};  // roomId → type (fallback when roomName absent)
  if (roomsResp.getResponseCode() === 200) {
    const rooms = JSON.parse(roomsResp.getContentText());
    for (const r of (Array.isArray(rooms) ? rooms : [])) {
      const rn = r.roomName || r.name || '';
      const isQuar   = r.isQuarantineRoom || /quarantine/i.test(rn);
      const isSample = /sample/i.test(rn);
      const isDistro = /distro/i.test(rn);
      let type;
      if (isQuar)              type = 'quarantine';
      else if (isSample)       type = 'sample';
      else if (isDistro)       type = 'distro';
      else if (r.isSalesFloor) type = 'floor';
      else                     type = 'back';
      if (rn)       roomNameType[rn]    = type;
      if (r.roomId) roomIdType[r.roomId] = type;
    }
  }

  // Merge all Move-transaction windows; keep the latest toRoom per inventoryId (newer date
  // wins by ISO string comparison). Any transactionType carrying a toRoom counts (Move,
  // Receive, Create Package, …) — the most recent one reflects the package's current room.
  const invRoomMap = {};
  const latestMove = {};
  for (const resp of txResps) {
    if (resp.getResponseCode() !== 200) continue;
    let txs; try { txs = JSON.parse(resp.getContentText()); } catch (e) { continue; }
    for (const tx of (Array.isArray(txs) ? txs : [])) {
      if (!tx.inventoryId || !tx.toRoom) continue;
      const id = tx.inventoryId;
      if (!latestMove[id] || tx.transactionDate > latestMove[id].date) {
        latestMove[id] = { date: tx.transactionDate, toRoom: tx.toRoom };
      }
    }
  }
  for (const [id, info] of Object.entries(latestMove)) {
    const type = roomNameType[info.toRoom];
    if (type) invRoomMap[id] = type;
  }

  // Customer returns → quarantine. Returns don't appear in inventory transactions.
  // They're in register transactions with item.isReturned=true. The inventoryId in the
  // register transaction differs from the current inventory record, so we match by packageId.
  const returnedPackageIds = new Set();
  if (regResp.getResponseCode() === 200) {
    const regTxs = JSON.parse(regResp.getContentText());
    for (const tx of (Array.isArray(regTxs) ? regTxs : [])) {
      if (!Array.isArray(tx.items)) continue;
      for (const item of tx.items) {
        if (item.isReturned && item.packageId) {
          returnedPackageIds.add(String(item.packageId));
        }
      }
    }
  }

  return { roomNameType, roomIdType, invRoomMap, returnedPackageIds: [...returnedPackageIds] };
}

// Single-store room data with 1h-ish cache. Unchanged contract for existing callers
// (getQuarantine, the roomdata diagnostic action, single-store getInventory).
// Delegates to the batch path so cache get/put + parse-resilience live in one place.
function buildRoomData(store, force) {
  return buildRoomDataBatch_([store], force)[store];
}

// Batch room data for many stores in ONE fetchAll round. Cache-hit stores are served
// from cache (no fetch); cold stores' requests are fired together. Because each store
// uses its own Dutchie API key, per-key concurrency is unchanged from the single-store
// path — while wall-clock collapses from N sequential rounds to 1.
// Returns { store → roomData }. Every requested store gets an entry.
//
// Slicing is self-describing: each cold store records the start index and length of its
// own response block, so the per-store split stays correct regardless of how many
// requests _roomDataRequests_ returns (no hand-synced count constant to drift out of date).
function buildRoomDataBatch_(stores, force) {
  const cache    = CacheService.getScriptCache();
  const result   = {};
  const cold     = []; // { store, start, count }
  const requests = [];

  for (const store of stores) {
    // force=true (a live Refresh) bypasses the cached room map so the floor/back/distro
    // designation reflects packages moved since the last cache write — essential at River
    // (the DC), where stock is constantly moved between rooms and staged for distribution.
    const cached = force ? null : cache.get(ROOM_DATA_CACHE_PREFIX + store);
    if (cached) {
      try { result[store] = JSON.parse(cached); continue; } catch(e) { /* corrupt entry → refetch */ }
    }
    const reqs = _roomDataRequests_(store);
    cold.push({ store, start: requests.length, count: reqs.length });
    requests.push(...reqs);
  }

  if (cold.length) {
    const responses = UrlFetchApp.fetchAll(requests);
    for (const { store, start, count } of cold) {
      const data = _processRoomData_(responses.slice(start, start + count));
      result[store] = data;
      try { cache.put(ROOM_DATA_CACHE_PREFIX + store, JSON.stringify(data), INV_CACHE_TTL); } catch(e) {}
    }
  }
  return result;
}

// Keep old name as alias so getQuarantine still works
function buildInventoryRoomMap(store) {
  return buildRoomData(store).invRoomMap;
}

// ─── LIVE INVENTORY (Dutchie API) ─────────────────────────────────────────────
// Returns on-hand grouped by productName, split by room (floor vs back).
// Room is determined by roomQuantities → roomName/roomId → latest "Move" transaction.
// When none of those are available (Dutchie currently returns no room data), packages
// default to 'back' (active) at EVERY store — including River Rd. Genuine Distro-room
// staging is only split out when Dutchie positively identifies it.
const OPERATIONAL_CACHE_TTL = 21600; // seconds — CacheService max, keeps same-day loads fast
const INV_CACHE_TTL = OPERATIONAL_CACHE_TTL;

// Optional params for buildOperationalBundle_'s parallel path:
//  - preloadedInvResp: a pre-fetched /reporting/inventory response
//  - preloadedRoomData: a pre-built room-data object (from buildRoomDataBatch_)
// Both let the bundle builder fire all stores' requests in one round instead of
// serially, cutting the cold-cache nightly build from ~18s to ~3s.
function getInventory(params, preloadedInvResp, preloadedRoomData) {
  const store = params.store;
  if (!store || !isKnownStore(store)) return { error: 'Unknown store: ' + store };

  // Serve from GAS cache if fresh — skip when caller already has a fresh response.
  const scriptCache = CacheService.getScriptCache();
  const cacheKey    = 'inv5_' + store;
  const cached      = scriptCache.get(cacheKey);
  if (params.force !== '1' && !preloadedInvResp && cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }

  const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  // Use pre-fetched response if provided, otherwise fetch now.
  const invResp = preloadedInvResp || UrlFetchApp.fetchAll([
    { url: DUTCHIE_BASE + '/reporting/inventory', headers: hdrs, muteHttpExceptions: true },
  ])[0];
  if (invResp.getResponseCode() !== 200) {
    return { error: 'Dutchie HTTP ' + invResp.getResponseCode(), store };
  }

  const raw      = JSON.parse(invResp.getContentText());
  const items    = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  const { roomNameType, roomIdType, invRoomMap, returnedPackageIds: returnedPkgArr } = preloadedRoomData || buildRoomData(store, params.force === '1');
  const returnedPackageIds = new Set(returnedPkgArr || []);

  // ── What room is a package in when Dutchie will not say? ──────────────────────────────────
  // Dutchie gives this app NO room data on the inventory payload: /reporting/inventory returns
  // roomQuantities:null with no roomName/roomId, ?roomId= is ignored (every room returns all rows),
  // and /room/<id>/inventory 404s. The ONLY room signal is toRoom on an inventory TRANSACTION, and
  // just Move rows carry one — Receive and "Create Package" carry none. So a package that was
  // created into a room and never moved is invisible, and the default decides where it lands.
  //
  // Both defaults have already been wrong in production, in opposite directions:
  //   v2.51  default 'distro' at River hid its ENTIRE floor, because the transaction endpoint was
  //          400ing at the time so NOTHING had a room signal (Tawny's bug).
  //   after  default 'back' merged River's DC stock into on-hand — 40 units of a cartridge showing
  //          as 48 in stock instead of 8 floor | 40 distro (Sky's bug, 2026-08-24).
  //
  // River is the DC: stock LANDS in Distro and is moved out to the floor (confirmed by Sky), so
  // "never moved" means "still in Distro" — but only if we can actually SEE moves. Hence the gate:
  // default to distro only where a Distro room exists AND this store's Move history has produced at
  // least one floor-classified package, which proves floor stock is detectable right now. If that
  // signal goes dark again (the v2.51 failure), this silently reverts to 'back' and can never hide
  // the floor a second time. Stores with no Distro room are unaffected.
  const hasDistroRoom  = Object.keys(roomNameType).some(function(n) { return roomNameType[n] === 'distro'; });
  const floorSignalSeen = Object.keys(invRoomMap).some(function(id) { return invRoomMap[id] === 'floor'; });
  const unknownRoomType = (hasDistroRoom && floorSignalSeen) ? 'distro' : 'back';

  const cutoff90   = new Date(Date.now() - 90 * 86400000).toISOString();
  const productMap = {};

  for (const item of items) {
    const qty     = Number(item.quantityAvailable || 0);
    const lastMod = item.lastModifiedDateUtc || '';
    if (qty <= 0 && lastMod < cutoff90) continue;

    const name = (item.productName || 'Unknown').trim();
    if (!productMap[name]) {
      productMap[name] = {
        name,
        sku:          item.sku || '',
        category:     item.masterCategory || item.category || 'Other',
        brand:        item.brandName || '',
        vendor:       item.vendor    || '',
        qty:          0,
        qtyFloor:     0,
        qtyBack:      0,
        qtyDistro:    0,
        qtyQuarantine:0,
        qtySample:    0,
        value:        0,
        unitCost:     0,
        unitPrice:    Number(item.unitPrice || item.price || item.retailPrice || item.defaultUnitPrice || item.medPrice || item.recPrice || 0),
        recUnitPrice: Number(item.recUnitPrice || 0),   // Dutchie's recreational OTD price (tax-incl) — the number on the shelf tag
        lastMod:      '',
        img:          item.imageUrl || item.productImageUrl || item.photo || '',
      };
    }
    const p = productMap[name];
    const itemPrice = Number(item.unitPrice || item.price || item.retailPrice || item.defaultUnitPrice || item.medPrice || item.recPrice || 0);
    if (itemPrice > 0) p.unitPrice = itemPrice;
    const recPrice = Number(item.recUnitPrice || 0);
    if (recPrice > 0) p.recUnitPrice = recPrice;

    // Classification priority:
    // 1. roomQuantities array — direct per-package room split from Dutchie (most accurate)
    // 2. item.roomName field — single room label on the package
    // 3. invRoomMap — latest transaction move (transaction API fallback)
    const rqs = Array.isArray(item.roomQuantities) ? item.roomQuantities : null;
    if (rqs && rqs.length > 0) {
      const unitCost = Number(item.unitCost || 0);
      if (unitCost > 0) p.unitCost = unitCost;
      for (const rq of rqs) {
        const rqQty = Number(rq.quantity ?? rq.qty ?? 0);
        if (rqQty <= 0) continue;
        const rqName = rq.roomName || rq.name || '';
        const rqType = (rqName && roomNameType[rqName])
          ? roomNameType[rqName]
          : (rq.roomId && roomIdType[rq.roomId])
          ? roomIdType[rq.roomId]
          : 'back';
        if (rqType === 'quarantine')    { p.qtyQuarantine += rqQty; }
        else if (rqType === 'sample')   { p.qtySample     += rqQty; }
        else if (rqType === 'distro')   { p.qtyDistro += rqQty; p.value += rqQty * unitCost; }
        else {
          p.qty   += rqQty;
          p.value += rqQty * unitCost;
          if (rqType === 'floor') p.qtyFloor += rqQty;
          else                    p.qtyBack  += rqQty;
        }
      }
    } else {
      // Fallback: single room classification for the whole package.
      // Priority: roomName → roomId → Move tx → returned package → back.
      // returnedPackageIds is last-resort only: it marks an ENTIRE package as quarantine
      // based on any return event, but Dutchie handles partial returns correctly at the
      // room level. Letting roomName/roomId/invRoomMap take precedence avoids
      // misclassifying packages that had a partial return (some units on floor, some quarantined).
      const itemRoom = item.roomName || item.room || '';
      // For the invRoomMap fallback, use floor/back/distro from Move transactions.
      // Quarantine and sample are excluded: a Move tx to quarantine followed by a partial
      // restocking leaves the tx pointing to quarantine even though most units are back on
      // the floor — defaulting to 'back' is safer and never hides available inventory.
      // Distro IS included: at River Rd, packages explicitly moved to the Distro room
      // are staged for inter-store distribution and should be classified as qtyDistro.
      const txRoom = invRoomMap[item.inventoryId];
      const safeTxRoom = (txRoom === 'floor' || txRoom === 'back' || txRoom === 'distro') ? txRoom : null;
      let roomType = (itemRoom && roomNameType[itemRoom])
        ? roomNameType[itemRoom]
        : (item.roomId && roomIdType[item.roomId])
        ? roomIdType[item.roomId]
        : safeTxRoom
        ? safeTxRoom
        : unknownRoomType; // no room signal at all → see the gate above (distro at a DC, else back)

      const itemCost = Number(item.unitCost || 0);
      if (itemCost > 0) p.unitCost = itemCost;

      if (roomType === 'quarantine')    { p.qtyQuarantine += qty; }
      else if (roomType === 'sample')   { p.qtySample     += qty; }
      else if (roomType === 'distro')   { p.qtyDistro += qty; p.value += qty * Number(item.unitCost || 0); }
      else {
        p.qty   += qty;
        p.value += qty * Number(item.unitCost || 0);
        if (roomType === 'floor') p.qtyFloor += qty;
        else                      p.qtyBack  += qty;
      }
    }
    if (lastMod > p.lastMod) p.lastMod = lastMod;
    if (!p.img) {
      const imgRaw = item.imageUrl || item.productImageUrl || item.imgUrl || item.photo || item.image || '';
      if (typeof imgRaw === 'string' && imgRaw.startsWith('http')) p.img = imgRaw;
      else if (typeof imgRaw === 'object' && imgRaw) p.img = imgRaw.url || imgRaw.src || '';
    }
    // Store productId on the product so we can look up the catalog for images
    if (!p._productId && item.productId) p._productId = item.productId;
  }

  // Fill missing images from the product catalog (/products has image URLs; inventory does not)
  const anyMissingImg = Object.values(productMap).some(p => !p.img);
  if (anyMissingImg) {
    try {
      const prodDict = buildProductIdDict();
      for (const p of Object.values(productMap)) {
        if (!p.img && p._productId && prodDict[p._productId]) {
          p.img = prodDict[p._productId].img || '';
        }
      }
    } catch(e) { /* non-fatal */ }
  }

  const products = Object.values(productMap).map(p => {
    const { _productId, ...rest } = p;
    return {
      ...rest,
      qty:           Math.round(p.qty           * 10) / 10,
      qtyFloor:      Math.round(p.qtyFloor      * 10) / 10,
      qtyBack:       Math.round(p.qtyBack       * 10) / 10,
      qtyDistro:     Math.round(p.qtyDistro     * 10) / 10,
      qtyQuarantine: Math.round(p.qtyQuarantine * 10) / 10,
      qtySample:     Math.round(p.qtySample     * 10) / 10,
      value:         Math.round(p.value        * 100) / 100,
      unitCost:      Math.round(p.unitCost     * 100) / 100,
      unitPrice:     Math.round(p.unitPrice    * 100) / 100,
      recUnitPrice:  Math.round((p.recUnitPrice || 0) * 100) / 100,
    };
  });

  const result = { store, products };
  try { scriptCache.put(cacheKey, JSON.stringify(result), INV_CACHE_TTL); } catch(e) {}
  return result;
}

// ─── BETA DECISION FEED ───────────────────────────────────────────────────────
const DECISION_FEED_COLS = [
  'generatedAt','store','productName','sku','brand','category','qty','sold7','sold14','sold28',
  'vel14','doh','status','recommendedOrderQty','recommendedTransferQty','donorStore',
  'reasonCodes','whyChips','confidence','openOrderQty','oosDays','lostUnits','missedRevenue',
  'imageUrl','lastSeen','notes'
];

function sheetToObjects_(sheetName, spreadsheetId) {
  const ss = SpreadsheetApp.openById(spreadsheetId || getDataSpreadsheetId());
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values[0].map(h => String(h || '').trim());
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    return obj;
  }).filter(obj => Object.values(obj).some(v => v !== '' && v !== null));
}

function loadStoreConfig_(spreadsheetId) {
  // Shared source of truth: GX Core. Falls back to the legacy "Config - Stores" sheet, then to
  // the hardcoded STORES list — so a GX Core hiccup can never blank the store list. storeKey stays
  // the Dutchie name (what auth + STORES key on); only the display/config metadata is centralized.
  try {
    if (typeof GXCore !== 'undefined' && GXCore && GXCore.getStores) {
      const gx = GXCore.getStores()
        .map(s => ({
          storeKey: String(s.dutchie_name || '').trim(),   // Dutchie/POS name — the auth + STORES key
          displayName: String(s.display_name || '').trim(), // internal name shown in the apps
          sortOrder: Number(s.sort_order) || 999,
          color: String(s.color || '').trim(),
          dutchieLocationKeyProperty: String(s.dutchie_key_prop || '').trim(),
        }))
        .filter(r => r.storeKey)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.storeKey.localeCompare(b.storeKey));
      if (gx.length) return gx;
    }
  } catch (e) {
    _logGasError('loadStoreConfig_/GXCore', e.message); // GX Core unreachable → fall through to legacy
  }
  const rows = sheetToObjects_(STORE_CONFIG_SHEET_NAME, spreadsheetId || BETA_SPREADSHEET_ID)
    .filter(r => String(r.active).toLowerCase() !== 'false')
    .map(r => ({
      storeKey: String(r.storeKey || '').trim(),
      displayName: String(r.displayName || '').trim(),
      sortOrder: Number(r.sortOrder) || 999,
      color: String(r.color || '').trim(),
      dutchieLocationKeyProperty: String(r.dutchieLocationKeyProperty || '').trim(),
    }))
    .filter(r => r.storeKey)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.storeKey.localeCompare(b.storeKey));
  return rows.length ? rows : STORES.map((storeKey, i) => ({ storeKey, displayName: storeKey, sortOrder: i + 1 }));
}

// ?action=stores — the shared store list + display mapping (storeKey=Dutchie name, displayName=
// internal name, color, sortOrder), read from GX Core with fallback. Lets the frontend source its
// pills/labels/colors from one place instead of hardcoding them (the follow-up frontend change).
function getStoresConfig() {
  return { ok: true, stores: loadStoreConfig_() };
}

function betaStoreKeys_() {
  return loadStoreConfig_(BETA_SPREADSHEET_ID).map(r => r.storeKey);
}

function loadBetaDecisionConfig() {
  const skuOverrides = {};
  for (const row of sheetToObjects_(SKU_OVERRIDES_SHEET_NAME, BETA_SPREADSHEET_ID)) {
    const sku = String(row.sku || '').trim();
    if (!sku || String(row.enabled).toLowerCase() === 'false') continue;
    skuOverrides[sku] = {
      sku,
      overrideType: String(row.overrideType || '').trim(),
      leadTimeDays: null,
      minOrderQty: Number(row.minOrderQty) || null,
      orderMultiple: Number(row.orderMultiple) || null,
      transferFirst: row.transferFirst === true || String(row.transferFirst).toLowerCase() === 'true',
      overstock: row.overstock === true || String(row.overstock).toLowerCase() === 'true',
      killCandidate: row.killCandidate === true || String(row.killCandidate).toLowerCase() === 'true',
      notes: String(row.notes || ''),
    };
  }

  const reorderRules = sheetToObjects_(REORDER_RULES_SHEET_NAME, BETA_SPREADSHEET_ID)
    .filter(r => String(r.enabled).toLowerCase() !== 'false')
    .map(r => ({
      ruleName: String(r.ruleName || ''),
      categoryPattern: String(r.categoryPattern || ''),
      brandPattern: String(r.brandPattern || ''),
      vendorPattern: String(r.vendorPattern || ''),
      leadTimeDays: STANDARD_VENDOR_LEAD_DAYS,
      safetyStockDays: Number(r.safetyStockDays) || SAFETY_STOCK_DAYS,
      minOrderQty: Number(r.minOrderQty) || 1,
      orderMultiple: Number(r.orderMultiple) || 1,
      transferMinQty: Number(r.transferMinQty) || 1,
      priority: Number(r.priority) || 999,
      notes: String(r.notes || ''),
    }))
    .sort((a, b) => a.priority - b.priority);

  const vendorLeadTimes = sheetToObjects_(VENDOR_LEAD_TIMES_SHEET_NAME, BETA_SPREADSHEET_ID)
    .filter(r => String(r.active).toLowerCase() !== 'false')
    .map((r, i) => ({
      vendor: String(r.vendor || ''),
      brand: String(r.brand || ''),
      category: String(r.category || ''),
      leadTimeDays: null,
      buyerNotes: String(r.buyerNotes || ''),
      order: i,
    }));

  return { skuOverrides, reorderRules, vendorLeadTimes };
}

function patternMatches_(pattern, value) {
  const p = String(pattern || '').trim();
  if (!p || p === '*') return true;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i').test(String(value || ''));
}

function patternSpecificity_(pattern) {
  const p = String(pattern || '').trim();
  if (!p || p === '*') return 0;
  return p.replace(/\*/g, '').length;
}

function pickReorderRule_(p, config) {
  return config.reorderRules.find(r =>
    ruleAppliesToProduct_(r, p) &&
    patternMatches_(r.categoryPattern, p.category) &&
    patternMatches_(r.brandPattern, p.brand) &&
    patternMatches_(r.vendorPattern, p.vendor)
  ) || {
    ruleName: 'Default',
    leadTimeDays: LEAD_TIME_DAYS,
    safetyStockDays: SAFETY_STOCK_DAYS,
    minOrderQty: 1,
    orderMultiple: 1,
    transferMinQty: 1,
  };
}

function ruleAppliesToProduct_(rule, p) {
  const name = String(rule.ruleName || '').toLowerCase();
  const category = String(p.category || '').toLowerCase();
  if (name.indexOf('slow') >= 0) {
    return p.status === 'slow' || (p.sold28 || 0) <= 3;
  }
  if (name.indexOf('green cross') >= 0) {
    return /apparel|accessor|paraphernalia|battery|lighter/i.test(category + ' ' + p.name);
  }
  return true;
}

function pickVendorLead_(p, config) {
  return config.vendorLeadTimes
    .filter(r =>
      patternMatches_(r.vendor || '*', p.vendor || '') &&
      patternMatches_(r.brand || '*', p.brand || '') &&
      patternMatches_(r.category || '*', p.category || '')
    )
    .map(r => ({
      ...r,
      specificity: patternSpecificity_(r.vendor) + patternSpecificity_(r.brand) + patternSpecificity_(r.category),
    }))
    .sort((a, b) =>
      b.specificity - a.specificity ||
      (b.leadTimeDays || 0) - (a.leadTimeDays || 0) ||
      a.order - b.order
    )[0] || null;
}

function roundToMultiple_(qty, multiple) {
  const m = Number(multiple) || 1;
  if (qty <= 0) return 0;
  return Math.ceil(qty / m) * m;
}

function fmtChipNum_(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 10 || v % 1 === 0) return String(Math.round(v));
  return v.toFixed(1);
}

function buildWhyChips_(p, ctx) {
  const chips = [];
  if (ctx.missedRevenue > 0) chips.push('$' + fmtChipNum_(ctx.missedRevenue) + ' missed');
  if (ctx.lostUnits > 0) chips.push('lost ' + fmtChipNum_(ctx.lostUnits) + 'u');
  if (p.sold28 > 0) chips.push('sold28 ' + fmtChipNum_(p.sold28));
  else if (p.sold14 > 0) chips.push('sold14 ' + fmtChipNum_(p.sold14));
  else if (p.sold7 > 0) chips.push('sold7 ' + fmtChipNum_(p.sold7));
  if (p.doh != null && p.doh !== '') chips.push((p.doh < 1 ? '<1' : fmtChipNum_(p.doh)) + ' DOH');
  if (ctx.leadTimeDays) chips.push('lead ' + ctx.leadTimeDays + 'd');
  if (ctx.safetyStockDays) chips.push('safety ' + ctx.safetyStockDays + 'd');
  if (ctx.minOrderQty && ctx.minOrderQty > 1) chips.push('MOQ ' + ctx.minOrderQty);
  if (ctx.orderMultiple && ctx.orderMultiple > 1) chips.push('mult ' + ctx.orderMultiple);
  if (ctx.recommendedTransferQty > 0) chips.push('transfer ' + fmtChipNum_(ctx.recommendedTransferQty));
  if (ctx.donorStore) chips.push('donor ' + ctx.donorStore);
  if (ctx.recommendedOrderQty > 0) chips.push('buy ' + fmtChipNum_(ctx.recommendedOrderQty));
  if (ctx.openOrderQty > 0) chips.push('open ' + fmtChipNum_(ctx.openOrderQty));
  return chips.slice(0, 8).join('|');
}

function buildOosLastSeenMap_() {
  try {
    const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
    const sheet = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return {};
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
    const lastSeen = {};
    for (const row of data) {
      const dateRaw = row[0], store = String(row[1] || '').trim();
      const name = String(row[2] || '').trim(), sku = String(row[5] || '').trim();
      if (!store || (!name && !sku)) continue;
      const dateStr = dateRaw instanceof Date
        ? dateRaw.toISOString().slice(0, 10)
        : String(dateRaw).slice(0, 10);
      const key = store + '::' + (sku || name);
      if (!lastSeen[key] || dateStr > lastSeen[key]) lastSeen[key] = dateStr;
      if (sku) {
        const skuKey = store + '::' + sku;
        if (!lastSeen[skuKey] || dateStr > lastSeen[skuKey]) lastSeen[skuKey] = dateStr;
      }
      if (name) {
        const nameKey = store + '::' + name;
        if (!lastSeen[nameKey] || dateStr > lastSeen[nameKey]) lastSeen[nameKey] = dateStr;
      }
    }
    return lastSeen;
  } catch (err) {
    Logger.log('buildOosLastSeenMap_ failed: ' + err.message);
    return {};
  }
}

function estimateLostSales_(p, lastSeenMap, velocity) {
  if (!p || p.status !== 'oos') return { oosDays: 0, lostUnits: 0, missedRevenue: 0 };
  if (Number(p.qty || 0) > 0) return { oosDays: 0, lostUnits: 0, missedRevenue: 0 };
  const lastSeen = lastSeenMap[p.store + '::' + (p.sku || '')] || lastSeenMap[p.store + '::' + (p.name || '')];
  if (!lastSeen) return { oosDays: 0, lostUnits: 0, missedRevenue: 0 };
  const oosStart = new Date(lastSeen + 'T12:00:00Z');
  oosStart.setUTCDate(oosStart.getUTCDate() + 1);
  const oosDays = Math.max(0, Math.floor((Date.now() - oosStart.getTime()) / 86400000));
  const lostUnits = Math.round(Math.max(0, oosDays * (velocity || 0)) * 10) / 10;
  const unitPrice = Number(p.unitPrice || 0);
  const missedRevenue = unitPrice > 0 ? Math.round(lostUnits * unitPrice * 100) / 100 : 0;
  return { oosDays, lostUnits, missedRevenue };
}

function productKey_(p) {
  return String(p.sku || p.name || '').trim();
}

// Single pass over the daily 'Inv Snapshot' history → per (store,key) the LATEST-dated record's
// { lastSeen (YYYY-MM-DD), unitCost (value/qty), unitPrice }. Keys: store::sku, store::name, and
// store::(sku||name). unitPrice is 0 for rows written before price-banking began (col 9). Powers the
// lost-sales estimate: unitCost is real; unitPrice becomes real once ~2 weeks of history accrues.
function buildOosLastSeenCostMap_() {
  const out = {};
  try {
    const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
    const sheet = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return out;
    const width = Math.max(8, sheet.getLastColumn());
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
    // Window cutoffs for days-in-stock counts (distinct snapshot dates the product was present) — used to
    // compute a decay-corrected velocity (units sold ÷ days actually in stock) in getLostSales.
    const put = (key, dateStr, cost, price) => {
      const cur = out[key];
      if (!cur || dateStr > cur.lastSeen) out[key] = { lastSeen: dateStr, unitCost: cost, unitPrice: price };
    };
    for (const row of data) {
      const store = String(row[1] || '').trim();
      const name = String(row[2] || '').trim(), sku = String(row[5] || '').trim();
      if (!store || (!name && !sku)) continue;
      const dateRaw = row[0];
      const dateStr = dateRaw instanceof Date ? dateRaw.toISOString().slice(0, 10) : String(dateRaw).slice(0, 10);
      const qty = Number(row[6] || 0), value = Number(row[7] || 0);
      const cost = qty > 0 ? Math.round((value / qty) * 100) / 100 : 0;
      const price = Number(row[8] || 0);
      if (sku) put(store + '::' + sku, dateStr, cost, price);
      if (name) put(store + '::' + name, dateStr, cost, price);
      put(store + '::' + (sku || name), dateStr, cost, price);
    }
  } catch (err) {
    _logGasError('buildOosLastSeenCostMap_', err.message);
  }
  return out;
}

// Gross margin % per store over the last `days` (default 28), from Dutchie (GXCore.getSalesDaily).
// Returns { byStore:{store:gm}, all:gm } with gm in [0,1).
function computeGmByStore_(days) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days || 28) * 86400000).toISOString().slice(0, 10);
  const acc = {}; let sAll = 0, cAll = 0;
  const bump = (store, s, c) => { const e = acc[store] || (acc[store] = { s: 0, c: 0 }); e.s += s; e.c += c; };
  try { (getSalesDutchie({ from, to }).data || []).forEach(r => { bump(r.store, Number(r.sales || 0), 0); sAll += Number(r.sales || 0); }); }
  catch (e) { _logGasError('computeGmByStore_/sales', e.message); }
  try { (getCogsDutchie({ from, to }).data || []).forEach(r => { bump(r.store, 0, Number(r.cogs || 0)); cAll += Number(r.cogs || 0); }); }
  catch (e) { _logGasError('computeGmByStore_/cogs', e.message); }
  const gm = (s, c) => (s > 0 ? Math.max(0, Math.min(0.95, (s - c) / s)) : 0);
  const byStore = {};
  Object.keys(acc).forEach(st => { byStore[st] = gm(acc[st].s, acc[st].c); });
  return { byStore: byStore, all: gm(sAll, cAll) };
}

// Green Cross encodes the shelf price in many product names ("$200 | Puffco…", "$2.00 | Raw…").
// When present it's the EXACT retail price — better than any estimate — so we prefer it over the
// margin fallback. Bulk flower (sold by weight) has no such prefix and falls through to the estimate.
function parseNamePrice_(name) {
  const m = String(name || '').match(/^\s*\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return 0;
  const v = Number(m[1].replace(/,/g, ''));
  return v > 0 && v < 100000 ? v : 0;
}

// Estimated lost SALES across every out-of-stock product (not just the handful in the persisted feed).
// For each product with recent sales + a last-seen date that is NOT currently in stock:
//   velocity  = 28-day average daily demand (units sold in 28d ÷ 28)   [robust vs unsustainable bursts]
//   oosDays   = min(today − (lastSeen+1), 28)     [projection capped at 28d — a month-old OOS is a
//               restock/discontinue decision, not ongoing lost sales]
//   lostUnits = oosDays × velocity
//   price     = banked last-known retail  OR  name-encoded shelf price  OR  cost ÷ (1 − storeGrossMargin)
//   missed$   = lostUnits × price
// Store-scoped totals + top contributors; the frontend pill indexes byStore.
function getLostSales(params) {
  const CAP_DAYS = Math.max(7, Math.min(180, Number((params && params.capDays) || 28)));
  const velMap = getVelocityMap();
  const lastMap = buildOosLastSeenCostMap_();
  const gm = computeGmByStore_(28);

  // In-stock exclusion set from the live operational snapshot (store::sku / store::name for qty>0).
  // In-stock set + substitutable-group breadth from the latest snapshot (reliable for all stores; the
  // operational bundle is sometimes only partially built). Breadth drives the substitution discount below.
  const cfg = getSubstitutionConfig_();
  const snap = readLatestSnapshotInventory_();
  const inStock = {};
  STORES.forEach(store => (snap.invByStore[store] || []).forEach(p => {
    if (!(Number(p.qty || 0) > 0)) return;
    if (p.sku) inStock[store + '::' + String(p.sku)] = true;
    if (p.name) inStock[store + '::' + String(p.name)] = true;
  }));
  if (!Object.keys(inStock).length) { // fallback for OOS detection only, if the snapshot was empty
    try {
      const bundle = readOperationalSnapshot_('inventory_bundle_v1');
      (bundle && bundle.inventory || []).forEach(st => (st.products || []).forEach(p => {
        if (!(Number(p.qty || 0) > 0)) return; const store = st.store || p.store;
        if (p.sku) inStock[store + '::' + String(p.sku)] = true;
        if (p.name) inStock[store + '::' + String(p.name)] = true;
      }));
    } catch (e) { _logGasError('getLostSales/inStock', e && e.message); }
  }
  const sets = assortmentActiveSets_(snap.invByStore, cfg);
  const catCnt = (catL, store) => Object.keys((sets.catSets[catL] && sets.catSets[catL][store]) || {}).length;
  const brandCnt = (catL, bl, store) => Object.keys((sets.brandSets[catL] && sets.brandSets[catL][bl] && sets.brandSets[catL][bl][store]) || {}).length;

  const todayMs = Date.now();
  let total = 0, grossTotal = 0, totalUnits = 0, bankedRev = 0, namedRev = 0, estRev = 0, counted = 0;
  const byStore = {}, byStoreUnits = {}, byProduct = {}, top = [];
  STORES.forEach(s => { byStore[s] = 0; byStoreUnits[s] = 0; });

  Object.keys(velMap).forEach(store => {
    const storeGm = (store in gm.byStore) ? gm.byStore[store] : gm.all;
    const products = velMap[store] || {};
    Object.keys(products).forEach(name => {
      const v = products[name];
      const sku = String(v.sku || '');
      if (isNonInventoryName_(name)) return;                                   // samples/testers/rounding/gift certs
      if (inStock[store + '::' + sku] || inStock[store + '::' + name]) return; // still in stock
      if (!(v.qty90 > 0)) return;                                              // never sold here
      const rec = lastMap[store + '::' + (sku || name)] || lastMap[store + '::' + sku] || lastMap[store + '::' + name];
      if (!rec || !rec.lastSeen) return;                                       // no last-seen → can't age it
      // Decay-corrected velocity: units sold ÷ days ACTUALLY in stock, using the shortest window with
      // enough in-stock appearances (MIN_DIS). This keeps out-of-stock days from diluting the rate (the
      // old qtyN/N windows undercounted the longer something sat OOS) while still favoring recent demand.
      // In-stock days are ESTIMATED as (appearances ÷ run-days) × windowLen, because the snapshot job runs
      // ~every other day — dividing raw appearances would double the velocity. Falls back to the window
      // average only when we lack the in-stock history to correct.
      // Velocity = 28-day average daily demand (units sold in 28d ÷ 28). Simple and robust: averaging over
      // the full window naturally dampens unsustainable in-stock bursts, which is the right basis for
      // projecting lost sales. (A days-in-stock "decay correction" was tried and rejected — it extrapolated
      // burst rates like 116 units/day for bulk flower that sold a batch in a few days then went OOS.)
      let vel = (v.qty28 || 0) / 28;
      if (!(vel > 0)) vel = v.vel14 > 0 ? v.vel14 : (v.vel28 || 0);
      if (!(vel > 0)) return;
      const oosStart = new Date(rec.lastSeen + 'T12:00:00Z');
      oosStart.setUTCDate(oosStart.getUTCDate() + 1);
      const rawDays = Math.floor((todayMs - oosStart.getTime()) / 86400000);
      const oosDays = Math.max(0, Math.min(CAP_DAYS, rawDays));
      if (oosDays <= 0) return;
      const lostUnits = Math.round(oosDays * vel * 10) / 10;
      const banked = Number(rec.unitPrice || 0);
      const named = parseNamePrice_(name);
      const cost = Number(rec.unitCost || 0);
      let price, src;
      if (banked > 0)      { price = banked; src = 'banked'; }
      else if (named > 0)  { price = named;  src = 'name'; }
      else if (cost > 0)   { price = cost / (1 - storeGm); src = 'margin'; }
      else                 { price = 0; src = 'none'; }
      const missedFull = Math.round(lostUnits * price * 100) / 100;
      grossTotal += missedFull;
      // Substitution discount: in a SUBSTITUTABLE group an OOS SKU only loses the fraction of demand that
      // can't substitute to an in-stock variety — keep = 1 − min(1, activeVarieties/target). Healthy group
      // (active ≥ target) → keep ≈ 0 → ~$0 lost. Continuity/unconfigured → keep 1 (full). Ignore → skipped.
      const catL = String(v.category || '').trim().toLowerCase();
      const c = cfg.categories[catL];
      let keep = 1;
      if (c) {
        if (c.mode === 'ignore') return;
        if (c.mode === 'substitutable') {
          if (c.groupBy === 'brand') {
            const bl = String(v.brand || '').trim().toLowerCase();
            const bt = (cfg.brandTargets[catL] || {})[bl];
            keep = bt ? (bt.target > 0 ? 1 - Math.min(1, brandCnt(catL, bl, store) / bt.target) : 0) : 0; // untracked brand → fully substitutable
          } else {
            keep = c.target > 0 ? 1 - Math.min(1, catCnt(catL, store) / c.target) : 0;
          }
        }
      }
      if (keep <= 0) return; // fully substituted → contributes nothing
      const missed = Math.round(missedFull * keep * 100) / 100;
      const unitsKept = Math.round(lostUnits * keep * 10) / 10;
      total += missed; totalUnits += unitsKept; counted++;
      if (src === 'banked') bankedRev += missed; else if (src === 'name') namedRev += missed; else estRev += missed;
      if (store in byStore) { byStore[store] += missed; byStoreUnits[store] += unitsKept; }
      if (missed > 0) { // per-product loss for the Value column (keyed by sku and name for robust FE lookup)
        const mr = Math.round(missed);
        if (sku) byProduct[store + '::' + sku] = mr;
        byProduct[store + '::' + name] = mr;
      }
      top.push({ store: store, name: name, sku: sku, oosDays: oosDays, vel: Math.round(vel * 100) / 100,
        lostUnits: unitsKept, price: Math.round(price * 100) / 100, priceSrc: src, keep: Math.round(keep * 100) / 100, missed: Math.round(missed) });
    });
  });

  Object.keys(byStore).forEach(s => { byStore[s] = Math.round(byStore[s]); byStoreUnits[s] = Math.round(byStoreUnits[s] * 10) / 10; });
  top.sort((a, b) => b.missed - a.missed);
  return {
    ok: true, generatedAt: new Date().toISOString(), capDays: CAP_DAYS,
    total: Math.round(total), totalUnits: Math.round(totalUnits * 10) / 10, oosCounted: counted,
    grossTotal: Math.round(grossTotal), substitutionSavings: Math.round(grossTotal - total), // before/after the substitution discount
    asOf: snap.asOf,
    byStore: byStore, byStoreUnits: byStoreUnits, byProduct: byProduct,
    gmByStore: gm.byStore, gmAll: Math.round(gm.all * 1000) / 1000,
    priceMix: total > 0 ? {
      exact: Math.round(((bankedRev + namedRev) / total) * 100),  // banked real price + name-encoded shelf price
      estimated: Math.round((estRev / total) * 100),               // cost ÷ (1 − gross margin)
    } : { exact: 0, estimated: 0 },
    top: top.slice(0, 25),
  };
}

// ─── SUBSTITUTION / ASSORTMENT MODEL ────────────────────────────────────────────
// Two kinds of out-of-stock (Wave 3): CONTINUITY SKUs (specific product customers want by name —
// Strawberry Kiwi Gummy) where an OOS = real lost revenue; and SUBSTITUTABLE categories (flower strains,
// Fatty/infused pre-rolls) where a single SKU OOS is just rotation — the customer swaps within the group,
// so what matters is BREADTH (enough active varieties), not any one SKU. Substitutable groups are managed
// either at the CATEGORY level (flower: N total strains, brand-agnostic) or the BRAND level (infused
// pre-rolls: 10 Mule, 5 Meraki — brand-concentrated). Config is Tawny-editable via two sheets; unconfigured
// categories default to CONTINUITY (the safe choice — never silently hides a real loss).
const SUBSTITUTION_CONFIG_SHEET = 'Substitution Config';
const SUBSTITUTION_BRAND_SHEET = 'Substitution Brand Targets';
// Products excluded from the whole model — not sellable varieties, never lost revenue. Room-based samples
// are already excluded upstream (separate qtySample; p.qty is floor+back only); this catches name-based
// tester/sample SKUs, rounding, and gift certificates (mirrors the frontend isNonInventory).
function isNonInventoryName_(name) {
  const n = String(name || '');
  return /^SAMPLE\s*\|/i.test(n) || /\bsample\b/i.test(n) || /\brounding\b/i.test(n) || /gift\s*cert/i.test(n);
}

const SUBSTITUTION_DEFAULTS = { // seed values — Tawny tunes the targets in the sheet
  'Bulk Cannabis Flower': { mode: 'substitutable', groupBy: 'category', target: 40 },
  'Cannabis Bulk Shake':  { mode: 'ignore',        groupBy: 'category', target: 0 }, // not an assortment we manage
  '1g Pre-Roll':          { mode: 'substitutable', groupBy: 'category', target: 20 },
  'Pre-Roll Pack':        { mode: 'substitutable', groupBy: 'category', target: 20 },
  'Extract (Solid)':      { mode: 'substitutable', groupBy: 'category', target: 25 },
  'Extract (Liquid)':     { mode: 'substitutable', groupBy: 'category', target: 25 },
  'Concentrate':          { mode: 'substitutable', groupBy: 'category', target: 15 },
  'Blunts':               { mode: 'substitutable', groupBy: 'category', target: 10 },
  'Infused Pre-roll':     { mode: 'substitutable', groupBy: 'brand',    target: 5 }, // default per-brand floor
};
const SUBSTITUTION_BRAND_DEFAULTS = {
  'Infused Pre-roll': { 'Mule Extracts': 10, 'Meraki Gardens': 5 },
};

// Read (and first-time seed) the substitution config. Returns { categories:{catLower:{category,mode,groupBy,
// target}}, brandTargets:{catLower:{brandLower:{brand,target}}} }. Sheets override code defaults.
function getSubstitutionConfig_() {
  const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
  let cs = ss.getSheetByName(SUBSTITUTION_CONFIG_SHEET);
  if (!cs) {
    cs = ss.insertSheet(SUBSTITUTION_CONFIG_SHEET);
    cs.getRange(1, 1, 1, 4).setValues([['category', 'mode', 'groupBy', 'target']]);
    const rows = Object.keys(SUBSTITUTION_DEFAULTS).map(cat => { const d = SUBSTITUTION_DEFAULTS[cat]; return [cat, d.mode, d.groupBy, d.target]; });
    if (rows.length) cs.getRange(2, 1, rows.length, 4).setValues(rows);
    cs.setFrozenRows(1);
  }
  let bs = ss.getSheetByName(SUBSTITUTION_BRAND_SHEET);
  if (!bs) {
    bs = ss.insertSheet(SUBSTITUTION_BRAND_SHEET);
    bs.getRange(1, 1, 1, 3).setValues([['category', 'brand', 'target']]);
    const rows = [];
    Object.keys(SUBSTITUTION_BRAND_DEFAULTS).forEach(cat => Object.keys(SUBSTITUTION_BRAND_DEFAULTS[cat]).forEach(brand => rows.push([cat, brand, SUBSTITUTION_BRAND_DEFAULTS[cat][brand]])));
    if (rows.length) bs.getRange(2, 1, rows.length, 3).setValues(rows);
    bs.setFrozenRows(1);
  }
  const categories = {};
  if (cs.getLastRow() >= 2) cs.getRange(2, 1, cs.getLastRow() - 1, 4).getValues().forEach(r => {
    const cat = String(r[0] || '').trim(); if (!cat) return;
    categories[cat.toLowerCase()] = { category: cat, mode: String(r[1] || 'continuity').trim().toLowerCase(), groupBy: String(r[2] || 'category').trim().toLowerCase(), target: Number(r[3] || 0) };
  });
  const brandTargets = {};
  if (bs.getLastRow() >= 2) bs.getRange(2, 1, bs.getLastRow() - 1, 3).getValues().forEach(r => {
    const cat = String(r[0] || '').trim(), brand = String(r[1] || '').trim(); if (!cat || !brand) return;
    (brandTargets[cat.toLowerCase()] || (brandTargets[cat.toLowerCase()] = {}))[brand.toLowerCase()] = { brand: brand, target: Number(r[2] || 0) };
  });
  return { categories: categories, brandTargets: brandTargets };
}

// Assortment health: per store, per substitutable group, active variety count (distinct in-stock SKUs) vs
// target, with a status. This is the breadth guardrail — the input for the grouping view and for
// reclassifying the Lost Revenue pill (a substitutable group at/above target contributes $0).
// Latest daily snapshot as in-stock products per store — complete for all 6 stores in one fast tail read
// (today's rows are appended at the end). The hardened snapshot foundation; we don't use the operational
// bundle here because it's sometimes only partially built. Returns { asOf, invByStore }.
function readLatestSnapshotInventory_() {
  const invByStore = {}; let latest = '';
  try {
    const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
    const sheet = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
    if (sheet && sheet.getLastRow() > 1) {
      const lastRow = sheet.getLastRow();
      const tail = Math.min(lastRow - 1, 15000);
      const rows = sheet.getRange(lastRow - tail + 1, 1, tail, 7).getValues(); // 7 cols → includes qty (col 7)
      rows.forEach(r => { const d = r[0] instanceof Date ? r[0].toISOString().slice(0, 10) : String(r[0]).slice(0, 10); if (d > latest) latest = d; });
      rows.forEach(r => {
        const d = r[0] instanceof Date ? r[0].toISOString().slice(0, 10) : String(r[0]).slice(0, 10);
        if (d !== latest) return;
        const store = String(r[1] || '').trim(); if (!store) return;
        (invByStore[store] || (invByStore[store] = [])).push({ name: String(r[2] || ''), brand: String(r[3] || ''), category: String(r[4] || ''), sku: String(r[5] || ''), qty: Number(r[6] || 0) });
      });
    }
  } catch (e) { _logGasError('readLatestSnapshotInventory_', e && e.message); }
  return { asOf: latest, invByStore: invByStore };
}

// Distinct in-stock SKUs per substitutable group. Returns { catSets:{catL:{store:{sku:1}}},
// brandSets:{catL:{brandL:{store:{sku:1}}}} } — samples/non-inventory excluded. Shared by the assortment
// health engine and the lost-revenue substitution discount so both see the same breadth.
function assortmentActiveSets_(invByStore, cfg) {
  const catSets = {}, brandSets = {};
  STORES.forEach(store => (invByStore[store] || []).forEach(p => {
    if (!(Number(p.qty) > 0)) return;
    if (isNonInventoryName_(p.name)) return;
    const catL = String(p.category || '').trim().toLowerCase();
    const sku = String(p.sku || p.name || '').trim();
    if (!catL || !sku) return;
    const c = cfg.categories[catL];
    if (!c || c.mode !== 'substitutable') return;
    if (c.groupBy === 'brand') {
      const bl = String(p.brand || '').trim().toLowerCase();
      (((brandSets[catL] || (brandSets[catL] = {}))[bl] || (brandSets[catL][bl] = {}))[store] || (brandSets[catL][bl][store] = {}))[sku] = 1;
    } else {
      ((catSets[catL] || (catSets[catL] = {}))[store] || (catSets[catL][store] = {}))[sku] = 1;
    }
  }));
  return { catSets: catSets, brandSets: brandSets };
}

function getAssortmentHealth(params) {
  const cfg = getSubstitutionConfig_();
  const snap = readLatestSnapshotInventory_();
  let invByStore = snap.invByStore, source = 'snapshot';
  const latest = snap.asOf;
  if (!Object.keys(invByStore).length) { // fallback: operational bundle
    source = 'bundle'; invByStore = {};
    try { const bundle = readOperationalSnapshot_('inventory_bundle_v1'); if (bundle && bundle.inventory) bundle.inventory.forEach(st => { if (st && st.store && st.products) invByStore[st.store] = st.products; }); } catch (e) {}
  }
  const sets = assortmentActiveSets_(invByStore, cfg);
  const catSets = sets.catSets, brandSets = sets.brandSets;
  const statusOf = (active, target) => target <= 0 ? 'ok' : (active >= target ? 'ok' : (active >= Math.ceil(target * 0.6) ? 'short' : 'critical'));
  const groups = [];
  Object.keys(cfg.categories).forEach(catL => {
    const c = cfg.categories[catL];
    if (c.mode !== 'substitutable') return;
    if (c.groupBy === 'brand') {
      const bt = cfg.brandTargets[catL] || {};
      Object.keys(bt).forEach(brandL => {
        const target = bt[brandL].target, byStore = {}, statusByStore = {};
        STORES.forEach(s => { const n = Object.keys((brandSets[catL] && brandSets[catL][brandL] && brandSets[catL][brandL][s]) || {}).length; byStore[s] = n; statusByStore[s] = statusOf(n, target); });
        groups.push({ category: c.category, groupBy: 'brand', group: bt[brandL].brand, label: c.category + ' — ' + bt[brandL].brand, target: target, byStore: byStore, statusByStore: statusByStore });
      });
    } else {
      const target = c.target, byStore = {}, statusByStore = {};
      STORES.forEach(s => { const n = Object.keys((catSets[catL] && catSets[catL][s]) || {}).length; byStore[s] = n; statusByStore[s] = statusOf(n, target); });
      groups.push({ category: c.category, groupBy: 'category', group: '', label: c.category, target: target, byStore: byStore, statusByStore: statusByStore });
    }
  });
  const summary = {};
  STORES.forEach(s => { summary[s] = { ok: 0, short: 0, critical: 0 }; });
  groups.forEach(g => STORES.forEach(s => { summary[s][g.statusByStore[s]]++; }));
  return { ok: true, generatedAt: new Date().toISOString(), source: source, asOf: latest, stores: STORES, groups: groups, summary: summary };
}

function transferDays_(a, b) {
  const salem = { 'Center': true, 'Commercial': true, 'Portland Rd': true, 'River Rd': true };
  const aS = !!salem[a], bS = !!salem[b];
  if (aS && bS) return 3;
  return 7;
}

function loadExistingDecisionDonors_(targetSet) {
  try {
    const ss = SpreadsheetApp.openById(BETA_SPREADSHEET_ID);
    const sheet = ss.getSheetByName(DECISION_FEED_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return [];
    const values = sheet.getDataRange().getValues();
    const headers = values.shift().map(h => String(h || ''));
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });
    return values
      .filter(r => !targetSet.has(String(r[idx.store] || '')))
      .map(r => ({
        store: String(r[idx.store] || ''),
        name: String(r[idx.productName] || ''),
        sku: String(r[idx.sku] || ''),
        brand: String(r[idx.brand] || ''),
        category: String(r[idx.category] || ''),
        qty: Number(r[idx.qty] || 0),
        vel7: 0,
        vel14: Number(r[idx.vel14] || 0),
        vel30: 0,
        sold7: Number(r[idx.sold7] || 0),
        sold14: Number(r[idx.sold14] || 0),
        sold28: Number(r[idx.sold28] || 0),
        doh: r[idx.doh] === '' ? null : Number(r[idx.doh] || 0),
        status: String(r[idx.status] || ''),
      }))
      .filter(r => r.store && r.name);
  } catch (err) {
    Logger.log('loadExistingDecisionDonors_ failed: ' + err.message);
    return [];
  }
}

function buildDecisionFeedRows(targetStores) {
  const generatedAt = new Date().toISOString();
  const velMap = getVelocityMap();
  const operationalSnapshot = readOperationalSnapshot_('inventory_bundle_v1');
  const operationalInventoryByStore = {};
  if (operationalSnapshot && operationalSnapshot.inventory) {
    for (const entry of operationalSnapshot.inventory || []) {
      if (!entry || !entry.store) continue;
      operationalInventoryByStore[entry.store] = entry.products || [];
    }
  }
  const config = loadBetaDecisionConfig();
  const betaStores = betaStoreKeys_();
  const shared = getSharedState({ beta: '1' });
  const killed = shared.killed || {};
  const flagged = new Set(shared.flagged || []);
  const oosLastSeen = buildOosLastSeenMap_();
  const byKey = {};
  const rows = [];
  const targetSet = new Set((targetStores && targetStores.length ? targetStores : betaStores));

  if (targetSet.size < betaStores.length) {
    for (const donor of loadExistingDecisionDonors_(targetSet)) {
      const key = productKey_(donor);
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(donor);
    }
  }

  for (const store of targetSet) {
    let products = operationalInventoryByStore[store] || null;
    if (!products) {
      const inv = getInventory({ store });
      if (inv.error) continue;
      products = inv.products || [];
    }
    for (const p of products) {
      const vel = (velMap[store] || {})[p.name] || {};
      const v14 = vel.vel14 || 0;
      const v30 = vel.vel30 || 0;
      const v7 = vel.vel7 || 0;
      const primaryVel = v14 > 0 ? v14 : (v30 > 0 ? v30 : v7);
      const doh = p.qty === 0 ? 0 : (primaryVel > 0 ? Math.round((p.qty / primaryVel) * 10) / 10 : null);
      const status = p.qty === 0 ? 'oos' : (doh == null ? 'slow' : (doh < DOH_CRITICAL_DAYS ? 'critical' : doh < DOH_LOW_DAYS ? 'low' : doh < DOH_WATCH_DAYS ? 'watch' : 'ok'));
      const full = {
        ...p,
        store,
        brand: p.brand || vel.brand || '',
        category: p.category || vel.category || 'Other',
        vel7: v7,
        vel14: v14,
        vel30: v30,
        sold7: vel.qty7 || Math.round(v7 * 7) || 0,
        sold14: vel.qty14 || Math.round(v14 * 14) || 0,
        sold28: vel.qty28 || Math.round((vel.vel28 || 0) * 28) || 0,
        unitPrice: p.unitPrice || 0,
        doh,
        status,
      };
      const key = productKey_(full);
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(full);
      if (targetSet.has(store)) rows.push(full);
    }
  }

  const priceByProductKey = {};
  for (const p of rows) {
    const key = productKey_(p);
    if (key && p.unitPrice > 0 && !priceByProductKey[key]) priceByProductKey[key] = p.unitPrice;
  }
  for (const p of rows) {
    if (!(p.unitPrice > 0)) p.unitPrice = priceByProductKey[productKey_(p)] || 0;
  }

  const statusRank = { oos: 0, critical: 1, low: 2, watch: 3, slow: 4, ok: 5 };
  const donorRemainingByKey = {};
  function donorRemainingFor_(productKey, donor) {
    const k = productKey + '|' + donor.store;
    if (donorRemainingByKey[k] == null) donorRemainingByKey[k] = donor.qty || 0;
    return donorRemainingByKey[k];
  }

  const decisionInputs = rows.slice().sort((a, b) =>
    (statusRank[a.status] == null ? 9 : statusRank[a.status]) - (statusRank[b.status] == null ? 9 : statusRank[b.status]) ||
    (a.doh == null ? 999 : a.doh) - (b.doh == null ? 999 : b.doh) ||
    (b.vel14 || b.vel30 || b.vel7 || 0) - (a.vel14 || a.vel30 || a.vel7 || 0)
  );

  return decisionInputs.map(p => {
    const sku = String(p.sku || '').trim();
    const override = config.skuOverrides[sku] || null;
    const rule = pickReorderRule_(p, config);
    const vendorLead = pickVendorLead_(p, config);
    const leadTimeDays = STANDARD_VENDOR_LEAD_DAYS;
    const safetyStockDays = rule.safetyStockDays || SAFETY_STOCK_DAYS;
    const targetDays = leadTimeDays + safetyStockDays;
    let minOrderQty = (override && override.minOrderQty) || rule.minOrderQty || 1;
    let orderMultiple = (override && override.orderMultiple) || rule.orderMultiple || 1;
    if (/bulk cannabis flower/i.test(String(p.category || ''))) {
      minOrderQty = Math.max(minOrderQty, BULK_FLOWER_MOQ_G);
      orderMultiple = Math.max(orderMultiple, BULK_FLOWER_MOQ_G);
    }
    const transferFirst = (override && override.transferFirst) || rule.ruleName.toLowerCase().indexOf('transfer first') >= 0;
    const overstock = override && override.overstock;
    const reasonCodes = [];
    const flagKey = sku + '|' + p.store;

    if (p.status === 'oos') reasonCodes.push('OOS');
    if (p.status === 'critical') reasonCodes.push('LOW_DOH');
    if (p.status === 'low') reasonCodes.push('LOW_STOCK');
    if (transferFirst) reasonCodes.push('TRANSFER_FIRST');
    if (overstock || rule.ruleName.toLowerCase().indexOf('green cross') >= 0) reasonCodes.push('GREEN_CROSS_OVERSTOCK');
    if (flagged.has(flagKey)) reasonCodes.push('FLAGGED_REVIEW');
    if (killed[flagKey]) reasonCodes.push('KILL_LIST');

    const needed = p.vel14 > 0 ? Math.max(0, p.vel14 * targetDays - p.qty) : 0;
    let recommendedOrderQty = needed > 0 ? Math.max(minOrderQty, roundToMultiple_(needed, orderMultiple)) : 0;
    let recommendedTransferQty = 0;
    let donorStore = '';
    const primaryVel = p.vel14 || p.vel30 || p.vel7 || 0;
    const lostSales = estimateLostSales_(p, oosLastSeen, primaryVel);
    if (lostSales.lostUnits > 0) reasonCodes.push('LOST_SALES_RISK');

    const needsReplenishment = recommendedOrderQty > 0 || p.status === 'oos' || p.status === 'critical' || p.status === 'low';
    if (needsReplenishment) {
      const minTransferQty = rule.transferMinQty || 1;
      const recipientVel = p.vel14 || p.vel30 || p.vel7 || 0;
      const productKey = productKey_(p);
      const bridgeDays = Math.min(targetDays, 7);
      const bridgeNeed = Math.max(0, Math.ceil(recipientVel * bridgeDays) - (p.qty || 0));
      const cycleNeed = Math.max(recommendedOrderQty || 0, Math.ceil(recipientVel * targetDays) || 0);
      const recipientNeed = Math.max(minTransferQty, bridgeNeed > 0 ? Math.min(cycleNeed || bridgeNeed, bridgeNeed) : cycleNeed);
      const donors = (byKey[productKey] || [])
        .filter(d => d.store !== p.store && (d.qty || 0) >= minTransferQty)
        .map(d => {
          const days = transferDays_(d.store, p.store);
          const donorVel = d.vel14 || d.vel30 || d.vel7 || 0;
          const reserveDays = days + safetyStockDays + targetDays;
          const reserveQty = donorVel > 0 ? Math.ceil(donorVel * reserveDays) : minTransferQty;
          const remainingQty = donorRemainingFor_(productKey, d);
          const safeQty = Math.floor(remainingQty - reserveQty);
          const postDoh = donorVel > 0 ? (remainingQty - Math.min(safeQty, recipientNeed)) / donorVel : 999;
          return { ...d, days, donorVel, safeQty, postDoh };
        })
        .filter(d => d.safeQty >= minTransferQty)
        .sort((a, b) =>
          a.days - b.days ||
          b.safeQty - a.safeQty ||
          (b.doh || 0) - (a.doh || 0) ||
          (b.qty || 0) - (a.qty || 0)
        );
      const donor = donors[0];
      if (donor) {
        donorStore = donor.store;
        recommendedTransferQty = Math.min(donor.safeQty, recipientNeed);
        if (recommendedTransferQty > 0) {
          reasonCodes.push('TRANSFER_AVAILABLE');
          donorRemainingByKey[productKey + '|' + donor.store] = Math.max(0, donorRemainingFor_(productKey, donor) - recommendedTransferQty);
          recommendedOrderQty = Math.max(0, recommendedOrderQty - recommendedTransferQty);
        }
      }
    }

    const confidence = reasonCodes.includes('KILL_LIST') ? 20
      : reasonCodes.includes('TRANSFER_AVAILABLE') ? 80
      : recommendedOrderQty > 0 ? 70
      : reasonCodes.length ? 60
      : 40;
    const openOrderQty = 0;
    const whyChips = buildWhyChips_(p, {
      leadTimeDays,
      safetyStockDays,
      minOrderQty,
      orderMultiple,
      recommendedOrderQty,
      recommendedTransferQty,
      donorStore,
      openOrderQty,
      lostUnits: lostSales.lostUnits,
      missedRevenue: lostSales.missedRevenue,
    });

    return [
      generatedAt,
      p.store,
      p.name,
      sku,
      p.brand || '',
      p.category || '',
      p.qty || 0,
      p.sold7 || 0,
      p.sold14 || 0,
      p.sold28 || 0,
      p.vel14 || 0,
      p.doh == null ? '' : p.doh,
      p.status,
      recommendedOrderQty,
      recommendedTransferQty,
      donorStore,
      reasonCodes.join(','),
      whyChips,
      confidence,
      openOrderQty,
      lostSales.oosDays,
      lostSales.lostUnits,
      lostSales.missedRevenue,
      p.img || '',
      p.lastMod || '',
      (override && override.notes) || (vendorLead && vendorLead.buyerNotes) || rule.notes || '',
    ];
  }).sort((a, b) => (b[18] - a[18]) || String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2])));
}

function generateBetaDecisionFeed(params) {
  if (getDataMode() !== 'beta' && params.force !== '1') {
    return { ok: false, error: 'Set GC_DATA_MODE=beta or pass force=1 to generate beta decision feed.' };
  }
  const requestedStore = params.store || '';
  const targetStores = requestedStore && requestedStore !== 'all' ? [requestedStore] : betaStoreKeys_();
  const rows = buildDecisionFeedRows(targetStores);
  const ss = SpreadsheetApp.openById(BETA_SPREADSHEET_ID);
  let sheet = ss.getSheetByName(DECISION_FEED_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(DECISION_FEED_SHEET_NAME);
  if (!params.append || sheet.getLastRow() === 0) {
    sheet.clearContents();
    sheet.getRange(1, 1, 1, DECISION_FEED_COLS.length).setValues([DECISION_FEED_COLS]);
  } else if (requestedStore) {
    const existingCols = sheet.getLastColumn();
    const headers = existingCols > 0 ? sheet.getRange(1, 1, 1, existingCols).getValues()[0].map(h => String(h || '')) : [];
    if (headers.join('|') !== DECISION_FEED_COLS.join('|')) {
      sheet.getRange(1, 1, 1, DECISION_FEED_COLS.length).setValues([DECISION_FEED_COLS]);
    }
    removeDecisionFeedStoreRows_(sheet, requestedStore);
  }
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, DECISION_FEED_COLS.length).setValues(rows);
  sheet.setFrozenRows(1);
  return { ok: true, store: requestedStore || 'all', rows: rows.length, spreadsheetId: BETA_SPREADSHEET_ID, generatedAt: rows[0] ? rows[0][0] : new Date().toISOString() };
}

function removeDecisionFeedStoreRows_(sheet, store) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const kept = values.filter(r => String(r[1] || '') !== store);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  if (kept.length) sheet.getRange(2, 1, kept.length, header.length).setValues(kept);
  sheet.setFrozenRows(1);
}

function readBetaDecisionFeed(params) {
  if (getDataMode() !== 'beta' && params.beta !== '1') {
    return { ok: false, error: 'Beta decision feed requires beta=1 or GC_DATA_MODE=beta.' };
  }
  const ss = SpreadsheetApp.openById(BETA_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(DECISION_FEED_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, rows: [], total: 0, spreadsheetId: BETA_SPREADSHEET_ID };
  }

  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(h => String(h || ''));
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const missingCols = DECISION_FEED_COLS.filter(col => idx[col] == null);
  const schemaStale = missingCols.length > 0 || headers.join('|') !== DECISION_FEED_COLS.join('|');
  const store = String(params.store || '').trim();
  const status = String(params.status || '').trim().toLowerCase();
  const reason = String(params.reason || '').trim().toUpperCase();
  const search = String(params.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(params.limit || '300', 10) || 300, 1), 10000);

  const rows = [];
  const summary = { orderLines: 0, transferLines: 0, killList: 0, orderUnits: 0, transferUnits: 0 };
  summary.lostUnits = 0;
  summary.missedRevenue = 0;
  let total = 0;
  for (const raw of values) {
    const rowStore = String(raw[idx.store] || '');
    const rowStatus = String(raw[idx.status] || '').toLowerCase();
    const rowReason = String(raw[idx.reasonCodes] || '').toUpperCase();
    const haystack = [
      raw[idx.productName], raw[idx.sku], raw[idx.brand], raw[idx.category], rowStore, rowReason,
    ].join(' ').toLowerCase();
    if (store && store !== 'All' && rowStore !== store) continue;
    if (status && rowStatus !== status) continue;
    if (reason && rowReason.indexOf(reason) === -1) continue;
    if (search && haystack.indexOf(search) === -1) continue;
    total++;
    const orderQty = Number(raw[idx.recommendedOrderQty] || 0);
    const transferQty = Number(raw[idx.recommendedTransferQty] || 0);
    if (orderQty > 0) { summary.orderLines++; summary.orderUnits += orderQty; }
    if (transferQty > 0) { summary.transferLines++; summary.transferUnits += transferQty; }
    if (rowReason.indexOf('KILL_LIST') !== -1) summary.killList++;
    summary.lostUnits += Number(idx.lostUnits == null ? 0 : raw[idx.lostUnits] || 0);
    summary.missedRevenue += Number(idx.missedRevenue == null ? 0 : raw[idx.missedRevenue] || 0);
    if (rows.length >= limit) continue;
    rows.push({
      generatedAt: raw[idx.generatedAt] || '',
      store: rowStore,
      productName: raw[idx.productName] || '',
      sku: raw[idx.sku] || '',
      brand: raw[idx.brand] || '',
      category: raw[idx.category] || '',
      qty: Number(raw[idx.qty] || 0),
      sold7: Number(raw[idx.sold7] || 0),
      sold14: Number(raw[idx.sold14] || 0),
      sold28: Number(raw[idx.sold28] || 0),
      vel14: Number(raw[idx.vel14] || 0),
      doh: raw[idx.doh] === '' ? null : Number(raw[idx.doh] || 0),
      status: raw[idx.status] || '',
      recommendedOrderQty: orderQty,
      recommendedTransferQty: transferQty,
      donorStore: raw[idx.donorStore] || '',
      reasonCodes: raw[idx.reasonCodes] || '',
      whyChips: idx.whyChips == null ? '' : (raw[idx.whyChips] || ''),
      confidence: Number(raw[idx.confidence] || 0),
      oosDays: idx.oosDays == null ? 0 : Number(raw[idx.oosDays] || 0),
      lostUnits: idx.lostUnits == null ? 0 : Number(raw[idx.lostUnits] || 0),
      missedRevenue: idx.missedRevenue == null ? 0 : Number(raw[idx.missedRevenue] || 0),
      imageUrl: raw[idx.imageUrl] || '',
      notes: raw[idx.notes] || '',
    });
  }

  return {
    ok: true,
    rows,
    total,
    summary,
    schemaStale,
    missingCols,
    expectedCols: DECISION_FEED_COLS,
    limited: total > rows.length,
    spreadsheetId: BETA_SPREADSHEET_ID,
    generatedAt: rows[0] ? rows[0].generatedAt : '',
    stale:       _isFeedStale_(rows[0] ? rows[0].generatedAt : ''),
  };
}

// Returns true if the feed is older than 26h (one nightly cycle + 2h slack).
// Also schedules a background refresh so the next read will be fresh.
function _isFeedStale_(generatedAt) {
  if (!generatedAt) return true;
  const age = Date.now() - new Date(generatedAt).getTime();
  const stale = age > 26 * 3600 * 1000;
  if (stale) {
    try {
      // Background-trigger a feed rebuild so the next read will be fresh.
      // Guard with a PropertiesService flag to avoid scheduling multiple triggers.
      const props = PropertiesService.getScriptProperties();
      const lastScheduled = props.getProperty(FEED_REFRESH_SCHEDULED_KEY) || '';
      const cooldownOk = !lastScheduled || (Date.now() - new Date(lastScheduled).getTime()) > 30 * 60 * 1000;
      if (cooldownOk) {
        // Create a one-shot trigger. Do NOT delete existing triggers first —
        // that would wipe the nightly everyDays(1).atHour(2) trigger installed
        // by setupOperationalCacheTrigger(). One-shot .after() triggers are
        // auto-deleted by GAS when they fire, so they don't accumulate.
        // The 30-min cooldown + 20-trigger project limit are the safety bounds.
        ScriptApp.newTrigger('warmDecisionFeedOnly').timeBased().after(60000).create();
        props.setProperty(FEED_REFRESH_SCHEDULED_KEY, new Date().toISOString());
        Logger.log('_isFeedStale_: feed is ' + Math.round(age / 3600000) + 'h old — scheduled refresh.');
      }
    } catch(e) { Logger.log('_isFeedStale_: could not schedule refresh: ' + e.message); }
  }
  return stale;
}

function decisionFeedRowObj_(raw, idx) {
  return {
    generatedAt: raw[idx.generatedAt] || '',
    store: String(raw[idx.store] || ''),
    productName: raw[idx.productName] || '',
    sku: raw[idx.sku] || '',
    brand: raw[idx.brand] || '',
    category: raw[idx.category] || '',
    qty: Number(raw[idx.qty] || 0),
    sold7: Number(raw[idx.sold7] || 0),
    sold14: Number(raw[idx.sold14] || 0),
    sold28: Number(raw[idx.sold28] || 0),
    vel14: Number(raw[idx.vel14] || 0),
    doh: raw[idx.doh] === '' ? null : Number(raw[idx.doh] || 0),
    status: raw[idx.status] || '',
    recommendedOrderQty: Number(raw[idx.recommendedOrderQty] || 0),
    recommendedTransferQty: Number(raw[idx.recommendedTransferQty] || 0),
    donorStore: raw[idx.donorStore] || '',
    reasonCodes: raw[idx.reasonCodes] || '',
    whyChips: idx.whyChips == null ? '' : (raw[idx.whyChips] || ''),
    confidence: Number(raw[idx.confidence] || 0),
    oosDays: idx.oosDays == null ? 0 : Number(raw[idx.oosDays] || 0),
    lostUnits: idx.lostUnits == null ? 0 : Number(raw[idx.lostUnits] || 0),
    missedRevenue: idx.missedRevenue == null ? 0 : Number(raw[idx.missedRevenue] || 0),
    imageUrl: idx.imageUrl == null ? '' : (raw[idx.imageUrl] || ''),
    notes: idx.notes == null ? '' : (raw[idx.notes] || ''),
  };
}

function decisionQueueIssues_(r) {
  const issues = [];
  const reasonText = String(r.reasonCodes || '');
  const whyText = String(r.whyChips || '');
  const cat = String(r.category || '').trim();
  const sku = String(r.sku || '').trim();

  if (!sku) issues.push({ type: 'Data', text: 'missing SKU' });
  if (!cat || /^other$/i.test(cat)) issues.push({ type: 'Data', text: 'generic category' });
  if (/\b(?:moq|mult)\s*227\b/i.test(whyText) && !/bulk cannabis flower/i.test(cat)) {
    issues.push({ type: 'Data', text: 'flower rule but category is not flower' });
  }
  if (Number(r.lostUnits || 0) > 0 && !(Number(r.missedRevenue || 0) > 0)) {
    issues.push({ type: 'Revenue', text: 'lost units missing price' });
  }
  if (/TRANSFER_FIRST/.test(reasonText) && !(Number(r.recommendedTransferQty || 0) > 0)) {
    issues.push({ type: 'Logic', text: 'transfer-first without transfer' });
  }
  if ((/OOS|LOW_DOH/.test(reasonText) || String(r.status || '').toLowerCase() === 'oos') &&
      !(Number(r.recommendedOrderQty || 0) > 0) &&
      !(Number(r.recommendedTransferQty || 0) > 0) &&
      !/KILL_LIST/.test(reasonText)) {
    issues.push({ type: 'Logic', text: 'needs action but no order/transfer' });
  }
  return issues;
}

function decisionQueueScore_(r, issues) {
  const status = String(r.status || '').toLowerCase();
  const statusScore = status === 'oos' ? 500
    : status === 'critical' ? 350
    : status === 'low' ? 160
    : status === 'watch' ? 60
    : status === 'slow' ? -30 : 0;
  return statusScore +
    Number(r.missedRevenue || 0) * 5 +
    Number(r.lostUnits || 0) * 35 +
    Number(r.recommendedOrderQty || 0) * 2 +
    Number(r.recommendedTransferQty || 0) * 2 +
    Number(r.confidence || 0) +
    (issues || []).length * 45;
}

function decisionQueueAction_(bucket, r, issues) {
  if (bucket === 'order') return 'Buy ' + Number(r.recommendedOrderQty || 0).toLocaleString('en-US') + ' · ' + String(r.status || '').toUpperCase();
  if (bucket === 'transfer') return 'Move ' + Number(r.recommendedTransferQty || 0).toLocaleString('en-US') + (r.donorStore ? ' from ' + r.donorStore : '');
  if (bucket === 'investigate') return ((issues && issues[0] && issues[0].type) || 'Review') + ' check';
  return String(r.reasonCodes || 'Slow mover').split(',')[0] || 'Review';
}

function readBetaDecisionQueue(params) {
  if (getDataMode() !== 'beta' && params.beta !== '1') {
    return { ok: false, error: 'Beta decision queue requires beta=1 or GC_DATA_MODE=beta.' };
  }
  const ss = SpreadsheetApp.openById(BETA_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(DECISION_FEED_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, buckets: {}, counts: {}, total: 0, spreadsheetId: BETA_SPREADSHEET_ID };
  }

  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(function(h) { return String(h || ''); });
  const idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });
  const missingCols = DECISION_FEED_COLS.filter(function(col) { return idx[col] == null; });
  const schemaStale = missingCols.length > 0 || headers.join('|') !== DECISION_FEED_COLS.join('|');
  const store = String(params.store || '').trim();
  const status = String(params.status || '').trim().toLowerCase();
  const reason = String(params.reason || '').trim().toUpperCase();
  const search = String(params.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(params.limit || '10', 10) || 10, 1), 30);

  const buckets = {
    order: { label: 'Order Today', count: 0, items: [] },
    transfer: { label: 'Transfer Today', count: 0, items: [] },
    investigate: { label: 'Investigate', count: 0, items: [] },
    dead: { label: 'Dead / Kill Review', count: 0, items: [] },
  };
  const allItems = { order: [], transfer: [], investigate: [], dead: [] };
  const summary = { orderLines: 0, transferLines: 0, killList: 0, orderUnits: 0, transferUnits: 0, missedRevenue: 0, lostUnits: 0 };
  let total = 0;
  let generatedAt = '';

  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    const rowStore = String(raw[idx.store] || '');
    const rowStatus = String(raw[idx.status] || '').toLowerCase();
    const rowReason = String(raw[idx.reasonCodes] || '').toUpperCase();
    const haystack = [
      raw[idx.productName], raw[idx.sku], raw[idx.brand], raw[idx.category], rowStore, rowReason,
    ].join(' ').toLowerCase();
    if (store && store !== 'All' && rowStore !== store) continue;
    if (status && rowStatus !== status) continue;
    if (reason && rowReason.indexOf(reason) === -1) continue;
    if (search && haystack.indexOf(search) === -1) continue;

    const r = decisionFeedRowObj_(raw, idx);
    if (!generatedAt && r.generatedAt) generatedAt = r.generatedAt;
    total++;
    summary.missedRevenue += Number(r.missedRevenue || 0);
    summary.lostUnits += Number(r.lostUnits || 0);
    if (r.recommendedOrderQty > 0) { summary.orderLines++; summary.orderUnits += r.recommendedOrderQty; }
    if (r.recommendedTransferQty > 0) { summary.transferLines++; summary.transferUnits += r.recommendedTransferQty; }
    if (rowReason.indexOf('KILL_LIST') !== -1) summary.killList++;

    const issues = decisionQueueIssues_(r);
    const score = decisionQueueScore_(r, issues);
    const base = {
      productName: r.productName,
      store: r.store,
      sku: r.sku,
      brand: r.brand,
      category: r.category,
      status: r.status,
      recommendedOrderQty: r.recommendedOrderQty,
      recommendedTransferQty: r.recommendedTransferQty,
      donorStore: r.donorStore,
      missedRevenue: r.missedRevenue,
      lostUnits: r.lostUnits,
      reasonCodes: r.reasonCodes,
      confidence: r.confidence,
      issues: issues,
      score: score,
    };
    if (issues.length) allItems.investigate.push(Object.assign({}, base, { action: decisionQueueAction_('investigate', r, issues) }));
    if (/KILL_LIST|DEAD|SLOW/.test(rowReason) || rowStatus === 'slow') allItems.dead.push(Object.assign({}, base, { action: decisionQueueAction_('dead', r, issues) }));
    if (r.recommendedTransferQty > 0 && rowReason.indexOf('KILL_LIST') === -1) allItems.transfer.push(Object.assign({}, base, { action: decisionQueueAction_('transfer', r, issues) }));
    if (r.recommendedOrderQty > 0 && rowReason.indexOf('KILL_LIST') === -1) allItems.order.push(Object.assign({}, base, { action: decisionQueueAction_('order', r, issues) }));
  }

  Object.keys(allItems).forEach(function(key) {
    allItems[key].sort(function(a, b) { return b.score - a.score; });
    buckets[key].count = allItems[key].length;
    buckets[key].items = allItems[key].slice(0, limit);
  });

  return {
    ok: true,
    buckets: buckets,
    counts: {
      order: buckets.order.count,
      transfer: buckets.transfer.count,
      investigate: buckets.investigate.count,
      dead: buckets.dead.count,
    },
    total: total,
    summary: summary,
    schemaStale: schemaStale,
    missingCols: missingCols,
    expectedCols: DECISION_FEED_COLS,
    spreadsheetId: BETA_SPREADSHEET_ID,
    generatedAt: generatedAt,
    limit: limit,
  };
}

// ─── VELOCITY — ROLLING WINDOW (180-day, incremental) ────────────────────────
// Architecture:
//   • "Vel Cache" sheet stores one row per (date, store, productId) with qty sold.
//   • PropertiesService['velSyncDate'] tracks the high-water mark of synced data.
//   • syncVelocityCache() fetches only new transactions since the last sync,
//     appends them, prunes rows older than 180 days, and updates the timestamp.
//   • buildVelocityMap() reads the sheet and computes vel7/14/30/90 from raw rows.
//     Rows from 91–180 days are retained for hasSalesHistory detection only.
//   • A time-based trigger calls syncVelocityCache() every hour automatically.

const VEL_SHEET_NAME  = 'Vel Cache';
const VEL_WINDOW_DAYS = 180;
// Sheet columns: date(0) store(1) productId(2) productName(3) brand(4) category(5) sku(6) qty(7)
const VEL_COLS = ['date','store','productId','productName','brand','category','sku','qty'];

// Convert a Vel Cache date cell to a canonical "YYYY-MM-DD" string.
// Google Sheets auto-converts "2026-05-20" strings to Date objects when stored,
// so getValues() returns Date objects, not strings. Using String(dateObj) gives
// "Wed May 20 2026..." which breaks string comparisons and key lookups.
// Fast Date → "YYYY-MM-DD" with NO GAS service calls. Utilities.formatDate and
// Session.getScriptTimeZone() are each a service round-trip; calling them per row
// over a 150K+ row sheet (buildVelocityMap) blows past the 6-min execution limit.
// GAS V8 Date getters already report in the script timezone, so this matches
// Utilities.formatDate(d, scriptTZ, 'yyyy-MM-dd') without the overhead.
function _dateToYMDFast_(d) {
  const m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

function _velDateToYMD(v) {
  if (!v) return '';
  if (v instanceof Date) return _dateToYMDFast_(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : _dateToYMDFast_(d);
}

// Module-level cache for the velSheetFormatted flag — avoids a PropertiesService
// round-trip on every getVelSheet() call (hot path: called inside every _syncChunk).
let _velSheetFormatted = false;

function getVelSheet() {
  const ss    = SpreadsheetApp.openById(getInvDataSpreadsheetId());
  let sheet   = ss.getSheetByName(VEL_SHEET_NAME);
  const isNew = !sheet;
  if (isNew) {
    sheet = ss.insertSheet(VEL_SHEET_NAME);
    sheet.getRange(1, 1, 1, VEL_COLS.length).setValues([VEL_COLS]);
    sheet.setFrozenRows(1);
  }
  // Force column A (date) to plain-text format so Sheets stops auto-converting
  // "2026-05-01" strings to Date objects on write. One-time migration per GAS
  // execution tracked via a module-level flag (no-op after first call) and a
  // ScriptProperties flag (persists across executions).
  if (!_velSheetFormatted) {
    // Format the ENTIRE column A as plain text (all rows, including future-appended ones),
    // so Sheets never coerces a "2026-06-05" date string into a Date object. That coercion
    // was the root cause of two bugs: (1) a sheet-vs-script timezone mismatch shifted stored
    // dates by one day on readback, and (2) that shift made _syncChunk's collision key miss
    // existing rows, appending duplicates. Text dates read back as the exact string written —
    // no TZ interpretation, no shift, no dup, and _velDateToYMD short-circuits (no service
    // call). Scope to the whole column via getMaxRows so appended rows inherit text format.
    // Re-applied once per execution (cheap: one setNumberFormat call), no longer gated on a
    // persistent flag, so a sheet that lost its formatting self-heals on the next sync.
    sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    _velSheetFormatted = true; // skip on all subsequent getVelSheet calls this execution
  }
  return sheet;
}

// Fetch productId → {name, brand, category, sku} from all stores in parallel
// Product catalog cache TTL — /products changes infrequently, 120/min rate limit
const PROD_CATALOG_CACHE_TTL = 3600; // 1 hour

// Persistent product catalog. Dutchie's /products response is intermittently
// incomplete (a product can be present on one fetch and absent the next). _syncChunk
// drops any sale whose productId isn't in the catalog, so an incomplete fetch silently
// erases that product's SALES from velocity. We persist the union of every productId
// ever seen here, so a momentary omission can never again drop a known product.
const PROD_CATALOG_SHEET_NAME = 'ProductCatalog';
const PROD_CATALOG_COLS = ['productId', 'name', 'brand', 'category', 'sku', 'img'];

function getProductCatalogSheet_() {
  const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
  let sheet = ss.getSheetByName(PROD_CATALOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PROD_CATALOG_SHEET_NAME);
    sheet.getRange(1, 1, 1, PROD_CATALOG_COLS.length).setValues([PROD_CATALOG_COLS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function _loadPersistedCatalog_() {
  try {
    const sheet = getProductCatalogSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return {};
    const data = sheet.getRange(2, 1, lastRow - 1, PROD_CATALOG_COLS.length).getValues();
    const dict = {};
    for (const r of data) {
      const pid = String(r[0] || '').trim();
      if (!pid) continue;
      dict[pid] = { name: String(r[1] || ''), brand: String(r[2] || ''), category: String(r[3] || 'Other'), sku: String(r[4] || ''), img: String(r[5] || '') };
    }
    return dict;
  } catch (e) { Logger.log('_loadPersistedCatalog_ failed: ' + e.message); return {}; }
}

function _savePersistedCatalog_(dict) {
  try {
    const sheet = getProductCatalogSheet_();
    const rows = Object.keys(dict).map(pid => {
      const d = dict[pid];
      return [pid, d.name || '', d.brand || '', d.category || '', d.sku || '', d.img || ''];
    });
    sheet.clearContents();
    sheet.getRange(1, 1, 1, PROD_CATALOG_COLS.length).setValues([PROD_CATALOG_COLS]);
    const BATCH = 5000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const b = rows.slice(i, i + BATCH);
      sheet.getRange(i + 2, 1, b.length, PROD_CATALOG_COLS.length).setValues(b);
    }
    sheet.setFrozenRows(1);
  } catch (e) { Logger.log('_savePersistedCatalog_ failed: ' + e.message); }
}

// Returns a productId → {name, brand, category, sku} dict covering ALL products,
// including OOS/discontinued. Uses GET /products (120/min, returns full catalog
// regardless of stock status) — eliminates OOS blind spots in vel sync.
function buildProductIdDict() {
  const scriptCache = CacheService.getScriptCache();
  const cacheKey    = 'prodcat_v2';
  const fromCache   = _readProductCatalogCache(scriptCache, cacheKey);
  if (fromCache) return fromCache;

  // Fetch product catalog from all stores in parallel.
  // /products includes active and inactive products, OOS included.
  const requests = STORES.map(store => ({
    url:     DUTCHIE_BASE + '/products',
    headers: { Authorization: dutchieAuth(store), Accept: 'application/json' },
    muteHttpExceptions: true,
  }));
  const responses = UrlFetchApp.fetchAll(requests);
  const dict = {};
  for (let i = 0; i < responses.length; i++) {
    const code = responses[i].getResponseCode();
    if (code === 429) { Logger.log('buildProductIdDict: 429 from store ' + STORES[i]); continue; }
    if (code !== 200) continue;
    try {
      const raw   = JSON.parse(responses[i].getContentText());
      const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
      for (const item of items) {
        const pid = item.productId;
        if (!pid || dict[pid]) continue;
        const name = (item.productName || '').trim();
        if (!name) continue;
        // Image priority per Dutchie /products schema:
        // 1. orderedImages (sorted by sortOrder) — may be empty even when images exist
        // 2. imageUrls[] array
        // 3. imageUrl string
        let imgUrl = '';
        if (Array.isArray(item.orderedImages) && item.orderedImages.length > 0) {
          const sorted = item.orderedImages.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
          imgUrl = sorted[0].imageUrl || '';
        }
        if (!imgUrl && Array.isArray(item.imageUrls) && item.imageUrls.length > 0) {
          imgUrl = item.imageUrls[0] || '';
        }
        if (!imgUrl) {
          const imgRaw = item.imageUrl || item.productImageUrl || item.imgUrl || item.photo || item.image || '';
          imgUrl = typeof imgRaw === 'string' && imgRaw.startsWith('http') ? imgRaw
            : typeof imgRaw === 'object' && imgRaw ? (imgRaw.url || imgRaw.src || '') : '';
        }
        dict[pid] = {
          name,
          brand:    item.brandName || '',
          category: item.masterCategory || item.category || 'Other',
          sku:      item.sku || '',
          img:      imgUrl,
        };
      }
    } catch (e) { /* skip bad JSON */ }
  }

  // Merge the PERSISTED catalog under the fresh fetch: fresh values win (so name/price
  // updates apply), but any product missing from this fetch is retained from the
  // persisted union. This is what stops an intermittently-incomplete /products response
  // from silently dropping a known product's sales in _syncChunk.
  const freshCount = Object.keys(dict).length;
  try {
    const persisted = _loadPersistedCatalog_();
    for (const pid of Object.keys(persisted)) {
      if (!dict[pid]) dict[pid] = persisted[pid];
    }
    // Persist the union back — but only if we got real fresh data this run, so a
    // fully-failed fetch (all 429/errors) doesn't needlessly rewrite the sheet.
    if (freshCount > 0) _savePersistedCatalog_(dict);
  } catch (e) { Logger.log('buildProductIdDict merge failed: ' + e.message); }

  // Cache result — split across two keys if needed (CacheService 100KB limit per key)
  try {
    const json = JSON.stringify(dict);
    if (json.length <= 100000) {
      scriptCache.put(cacheKey, json, PROD_CATALOG_CACHE_TTL);
    } else {
      // Store in halves
      const half = Math.ceil(json.length / 2);
      scriptCache.putAll({
        [cacheKey + '_a']: json.slice(0, half),
        [cacheKey + '_b']: json.slice(half),
        [cacheKey + '_split']: '1',
      }, PROD_CATALOG_CACHE_TTL);
    }
  } catch(e) { /* cache write failure is non-fatal */ }

  return dict;
}

// Read the product catalog cache, handling split storage if needed.
function _readProductCatalogCache(scriptCache, cacheKey) {
  if (scriptCache.get(cacheKey + '_split') === '1') {
    const a = scriptCache.get(cacheKey + '_a');
    const b = scriptCache.get(cacheKey + '_b');
    if (a && b) {
      try { return JSON.parse(a + b); } catch(e) {}
    }
    return null;
  }
  const v = scriptCache.get(cacheKey);
  if (!v) return null;
  try { return JSON.parse(v); } catch(e) { return null; }
}

function _putChunkedJsonCache(cache, key, obj, ttl) {
  try {
    const json = JSON.stringify(obj);
    const chunkSize = 90000;
    const chunks = [];
    for (let i = 0; i < json.length; i += chunkSize) chunks.push(json.slice(i, i + chunkSize));
    cache.remove(key);
    cache.remove(key + '_meta');
    for (let i = 0; i < 20; i++) cache.remove(key + '_' + i);
    if (chunks.length === 1) {
      cache.put(key, json, ttl);
    } else {
      const put = {};
      chunks.forEach((chunk, i) => { put[key + '_' + i] = chunk; });
      put[key + '_meta'] = JSON.stringify({ chunks: chunks.length });
      cache.putAll(put, ttl);
    }
  } catch(e) {
    Logger.log('Cache write failed for ' + key + ': ' + e.message);
  }
}

function _readChunkedJsonCache(cache, key) {
  const direct = cache.get(key);
  if (direct) {
    try { return JSON.parse(direct); } catch(e) { return null; }
  }
  const metaRaw = cache.get(key + '_meta');
  if (!metaRaw) return null;
  try {
    const meta = JSON.parse(metaRaw);
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) {
      const part = cache.get(key + '_' + i);
      if (!part) return null;
      parts.push(part);
    }
    return JSON.parse(parts.join(''));
  } catch(e) {
    return null;
  }
}

// Main sync — call from trigger or manually. Fetches delta, writes to sheet.
// For large date ranges (initial backfill), chunks into 14-day windows to stay
// within Apps Script URL fetch response size limits.
function syncVelocityCache() {
  const props      = PropertiesService.getScriptProperties();
  const lastSync   = props.getProperty('velSyncDate');
  const now        = new Date();
  const cutoff180  = new Date(now.getTime() - VEL_WINDOW_DAYS * 86400000); // renamed from cutoff90 (was misleading)
  const fromDate   = lastSync ? new Date(lastSync) : cutoff180;
  const fetchFrom  = fromDate < cutoff180 ? cutoff180 : fromDate;

  // Self-heal: if backfill was running but no trigger is active, restart it.
  const backfillStatus = props.getProperty('backfillStatus') || '';
  if (backfillStatus.startsWith('running:') || backfillStatus === 'pending') {
    const hasBackfillTrigger = ScriptApp.getProjectTriggers()
      .some(t => t.getHandlerFunction() === '_runBackfillTrigger');
    if (!hasBackfillTrigger) {
      Logger.log('syncVelocityCache: stalled backfill detected (' + backfillStatus + '), restarting');
      _installBackfillTrigger();
    }
  }

  const CHUNK_DAYS = 14;
  const chunkMs    = CHUNK_DAYS * 86400000;
  // GAS time limit is 6 min. Each _syncChunk call makes 6 Dutchie fetches (~20-30s).
  // We can safely run up to ~8 chunks (3.5 min) per trigger invocation, which means
  // a full 180-day backfill completes in 2 hourly trigger calls instead of 13.
  const MAX_CHUNKS  = 8;
  const DEADLINE_MS = 200 * 1000; // 3m20s safety margin
  const callStart   = Date.now();

  // Build product dict once — shared across all chunks to avoid a 6-store /products
  // blast on every iteration (buildProductIdDict is cached for 1h but a cold-cache hit
  // would fire 6 API calls × 8 chunks = 48 redundant requests per trigger invocation).
  const productDict = buildProductIdDict();

  let totalSynced = 0;
  let chunkStart  = fetchFrom;
  let lastResult  = { synced: 0, upTo: fetchFrom.toISOString() };
  let chunksRun   = 0;

  while (chunksRun < MAX_CHUNKS && Date.now() - callStart < DEADLINE_MS) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + chunkMs, now.getTime()));
    if (chunkEnd <= chunkStart) break; // caught up
    lastResult = _syncChunk(props, chunkStart, chunkEnd, true, productDict);
    totalSynced += lastResult.synced || 0;
    chunksRun++;
    chunkStart = chunkEnd;
    if (chunkEnd >= now) break; // fully caught up
  }

  const remaining = Math.max(0, Math.ceil((now.getTime() - chunkStart.getTime()) / 86400000));

  // Gap self-heal: if velLastWriteDate is more than 2 chunks (28 days) behind now,
  // the vel cache silently lost data during a rewrite (GAS timeout mid-setValues).
  // Roll velSyncDate back to the last confirmed write date so the next trigger re-fills the gap.
  // A 4-hour cooldown prevents thrashing if the API genuinely has no recent data.
  const velLastWriteDate  = props.getProperty('velLastWriteDate');
  const velSheetCorrupted = props.getProperty('velSheetCorrupted') || '';

  // If corruption flag is set but we've never successfully written any rows,
  // there's nothing to roll back to — clear the flag so the sync can proceed.
  if (velSheetCorrupted && !velLastWriteDate) {
    props.deleteProperty('velSheetCorrupted');
    Logger.log('syncVelocityCache: corruption flag cleared — no velLastWriteDate to roll back to; sync will proceed from current position.');
  }

  // Gap self-heal: fire when caught up (remaining===0) with a large gap, OR immediately
  // when a mid-write truncation was detected (corruption doesn't wait for catch-up).
  if (velLastWriteDate && (remaining === 0 || velSheetCorrupted)) {
    const gapDays = (now.getTime() - new Date(velLastWriteDate + 'T12:00:00').getTime()) / 86400000;
    const healedAt = props.getProperty('velGapHealedAt') || '';
    const cooldownOk = !healedAt || (now.getTime() - new Date(healedAt).getTime()) > 4 * 3600000;
    if ((gapDays > CHUNK_DAYS * 2 || velSheetCorrupted) && cooldownOk) {
      Logger.log('syncVelocityCache: GAP DETECTED — velLastWriteDate=' + velLastWriteDate
        + ' is ' + Math.round(gapDays) + ' days behind now. Rolling velSyncDate back to re-sync.');
      props.setProperty('velSyncDate', new Date(velLastWriteDate + 'T00:00:00Z').toISOString());
      props.setProperty('velGapHealedAt', now.toISOString());
      props.deleteProperty('velSheetCorrupted'); // clear flag — re-sync will write fresh data
      return { synced: totalSynced, upTo: lastResult.upTo, chunksRun, remaining, backfillComplete: false, gapHealed: true, gapFrom: velLastWriteDate };
    }
  }

  return { synced: totalSynced, upTo: lastResult.upTo, chunksRun, remaining, backfillComplete: remaining === 0 };
}

// Internal: fetch one time window for all stores, upsert into sheet.
// If `updateProp` is true, also saves velSyncDate to PropertiesService.
// Pass a pre-built `productDict` to avoid re-fetching /products on every chunk
// in a multi-chunk loop — callers that run multiple chunks should hoist the call.
function _syncChunk(props, fromDate, toDate, updateProp, productDict) {
  const fromISO = fromDate.toISOString();
  const toISO   = toDate.toISOString();
  const now     = Date.now();
  const cutoff180Str = new Date(now - VEL_WINDOW_DAYS * 86400000).toISOString().slice(0, 10); // 180-day retention cutoff

  if (!productDict) productDict = buildProductIdDict(); // fallback for single-call sites

  // Rows are bucketed by LOCAL date (transactionDateLocalTime) but the Dutchie query
  // filters by UTC. A local day spans up to ~31h of UTC (a 8 PM Pacific sale is next-day
  // UTC), so a naive UTC window splits a local day across two chunks — and the later
  // chunk's upsert REPLACES the earlier chunk's same store|date row, silently dropping
  // the earlier partial count (this clipped evening-near-seam sales). Fix: over-fetch the
  // UTC window by ±24h so each chunk sees every owned local day's FULL 24h, then only
  // aggregate rows whose local date this chunk OWNS ([fromYMD, toYMD] inclusive). Each
  // local date is thus fully counted by exactly one chunk. The ±24h pad (>max TZ offset
  // of 8h) makes this DST-safe without any timezone math.
  const ownFromYMD  = fromISO.slice(0, 10);
  const ownToYMD    = toISO.slice(0, 10);
  const queryFromISO = new Date(fromDate.getTime() - 86400000).toISOString();
  const queryToISO   = new Date(toDate.getTime()   + 86400000).toISOString();

  const requests = STORES.map(store => ({
    url: DUTCHIE_BASE + '/reporting/transactions'
      + '?FromDateUTC=' + encodeURIComponent(queryFromISO)
      + '&ToDateUTC='   + encodeURIComponent(queryToISO)
      + '&IncludeDetail=true',
    headers: { Authorization: dutchieAuth(store), Accept: 'application/json' },
    muteHttpExceptions: true,
  }));
  const responses = UrlFetchApp.fetchAll(requests);

  // Aggregate: (store, date, productId) → row
  const agg = {};
  for (let i = 0; i < STORES.length; i++) {
    const store = STORES[i];
    if (responses[i].getResponseCode() !== 200) continue;
    let txns;
    try {
      const raw = JSON.parse(responses[i].getContentText());
      txns = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
    } catch (e) { continue; }

    for (const tx of txns) {
      if (tx.transactionType !== 'Retail') continue; // exclude Transfers, adjustments, etc.
      if (tx.isVoid || tx.isReturn) continue;
      if (!Array.isArray(tx.items)) continue;
      const dateStr = (tx.transactionDateLocalTime || tx.transactionDate || '').slice(0, 10);
      if (!dateStr || dateStr < cutoff180Str) continue; // skip rows outside the retention window
      if (dateStr < ownFromYMD || dateStr > ownToYMD) continue; // only this chunk's owned local dates (the ±24h over-fetch pulls in neighbors we skip here)

      for (const item of tx.items) {
        if (item.isReturned) continue;
        const qty = item.quantity || 0;
        if (qty <= 0) continue;
        const pid = item.productId;
        if (!pid) continue;
        const product = productDict[pid];
        // Resolve product info from the (now persistent/union) catalog. If the productId
        // still isn't known, DON'T drop the sale — fall back to the transaction item's own
        // fields so a brand-new product (not yet in any catalog fetch) still counts. The
        // accumulating catalog will enrich it on the next sync. Only skip if there's truly
        // no name to key velocity by.
        let pName, pBrand, pCategory, pSku;
        if (product) {
          pName = product.name; pBrand = product.brand; pCategory = product.category; pSku = product.sku;
        } else {
          pName = String(item.productName || '').trim();
          pBrand = item.brandName || ''; pCategory = item.masterCategory || item.category || 'Other'; pSku = item.sku || '';
        }
        if (!pName) continue;
        const key = store + '|' + dateStr + '|' + pid;
        if (!agg[key]) agg[key] = { date: dateStr, store, productId: pid, name: pName, brand: pBrand, category: pCategory, sku: pSku, qty: 0 };
        agg[key].qty += qty;
      }
    }
  }

  const sheet   = getVelSheet();
  const newRows = Object.values(agg);

  if (newRows.length > 0) {
    const lastRow      = sheet.getLastRow();
    const existingData = lastRow > 1
      ? sheet.getRange(2, 1, lastRow - 1, VEL_COLS.length).getValues() : [];
    const newKeys = new Set(newRows.map(r => r.store + '|' + r.date + '|' + r.productId));

    // Check whether any existing row collides with the new batch (common case for
    // backfill of a never-synced period: zero collisions → append-only, no rewrite).
    // row[0] may be a Date object — use _velDateToYMD so keys are comparable strings.
    let hasCollision = false;
    for (const row of existingData) {
      if (newKeys.has(row[1] + '|' + _velDateToYMD(row[0]) + '|' + row[2])) { hasCollision = true; break; }
    }

    if (!hasCollision) {
      // Fast path: just append — no full-sheet rewrite needed.
      const appendData = newRows.map(r => [r.date, r.store, r.productId, r.name, r.brand, r.category, r.sku, r.qty]);
      // Force the appended date cells to text BEFORE writing, so Sheets keeps "2026-06-05"
      // as a string (no Date coercion → no timezone shift). Rows appended past the current
      // max-row don't inherit the column format set in getVelSheet, so set it explicitly here.
      sheet.getRange(lastRow + 1, 1, appendData.length, 1).setNumberFormat('@');
      sheet.getRange(lastRow + 1, 1, appendData.length, VEL_COLS.length).setValues(appendData);
    } else {
      // Slow path: dedup, prune, and rewrite the full sheet.
      // Uses batched writes (5K rows/batch) so a GAS timeout mid-write leaves the sheet
      // partially written from the top rather than completely empty. A post-write row count
      // check detects truncation and sets velSheetCorrupted so the gap self-heal recovers.
      const kept    = existingData.filter(row => !newKeys.has(row[1] + '|' + _velDateToYMD(row[0]) + '|' + row[2]));
      const pruned  = kept.filter(row => _velDateToYMD(row[0]) >= cutoff180Str);
      // Normalize every date cell to a YMD string so the rewritten sheet is uniformly text
      // (kept rows may be legacy Date objects; convert them) — keeps the date column free of
      // Date objects going forward.
      const allRows = pruned.map(row => [_velDateToYMD(row[0]), row[1], row[2], row[3], row[4], row[5], row[6], row[7]])
        .concat(newRows.map(r => [r.date, r.store, r.productId, r.name, r.brand, r.category, r.sku, r.qty]));
      sheet.clearContents();
      sheet.getRange(1, 1, 1, VEL_COLS.length).setValues([VEL_COLS]);
      if (allRows.length > 0) sheet.getRange(2, 1, allRows.length, 1).setNumberFormat('@'); // text date col
      const WRITE_BATCH = 5000;
      for (let i = 0; i < allRows.length; i += WRITE_BATCH) {
        const batch = allRows.slice(i, i + WRITE_BATCH);
        sheet.getRange(i + 2, 1, batch.length, VEL_COLS.length).setValues(batch);
      }
      // Verify: if GAS timed out mid-write the row count will be short.
      const writtenRows = sheet.getLastRow() - 1; // subtract header
      if (writtenRows !== allRows.length) {
        const msg = 'incomplete:' + writtenRows + '/' + allRows.length;
        props.setProperty('velSheetCorrupted', msg);
        Logger.log('_syncChunk WRITE INCOMPLETE — ' + msg + '. Gap self-heal will recover.');
      } else {
        props.deleteProperty('velSheetCorrupted'); // clear any prior corruption flag
      }
    }
  }

  if (updateProp) {
    props.setProperty('velSyncDate', toISO);
    // Track the most recent date for which rows were actually written to the sheet.
    // Used by syncVelocityCache gap self-heal to detect silent data loss.
    if (newRows.length > 0) {
      const maxWritten = newRows.map(r => r.date).sort().pop();
      const prevLast   = props.getProperty('velLastWriteDate') || '';
      if (maxWritten > prevLast) props.setProperty('velLastWriteDate', maxWritten);
    }
  }
  Logger.log('_syncChunk ' + fromISO.slice(0,10) + ' → ' + toISO.slice(0,10) + ': ' + newRows.length + ' rows');
  return { synced: newRows.length, upTo: toISO };
}

// Read the Vel Cache sheet and compute velocity map.
// Rows from 91–180 days are retained in the sheet solely for hasSalesHistory detection.
// Phase C: velocity now comes from GX Core's shared, self-maintaining velocity_summary cache
// (GXCore.getVelocity, v50 — reads a precomputed summary, ~3.4s all stores) instead of this app's
// local Vel Cache (which ran ~3 days stale). Returns the SAME shape as buildVelocityMap:
// velMap[appStoreName][productName] = { qty7..qty90, vel7..vel90, brand, category, sku, hasSalesHistory }.
// Falls back to the local build if the shared cache is empty/unreachable so DOH/reorder never break.
function getVelocityMap() {
  // GX store_id (slug, e.g. 'bend','portland-rd') → app store name (dutchie_name, == our STORES entries)
  const slugToName = {};
  try {
    (GXCore.getStores() || []).forEach(s => {
      const id = String(s.store_id || '').trim().toLowerCase();
      const nm = String(s.dutchie_name || '').trim();
      if (id && nm) slugToName[id] = nm;
    });
  } catch (e) { _logGasError('getVelocityMap/getStores', e.message); }

  const velMap = {};
  try {
    const rows = GXCore.getVelocity('') || [];   // all stores, one fast summary read
    for (const r of rows) {
      const store = slugToName[String(r.store || '').trim().toLowerCase()];
      if (!store) continue;
      const name = String(r.product_name || '').trim();
      if (!name || name === 'Unknown') continue;
      (velMap[store] || (velMap[store] = {}))[name] = {
        qty7: r.qty7 || 0, qty14: r.qty14 || 0, qty21: r.qty21 || 0, qty28: r.qty28 || 0, qty30: r.qty30 || 0, qty90: r.qty90 || 0,
        vel7: r.vel7 || 0, vel14: r.vel14 || 0, vel21: r.vel21 || 0, vel28: r.vel28 || 0, vel30: r.vel30 || 0, vel90: r.vel90 || 0,
        brand: String(r.brand || ''), category: String(r.category || ''), sku: String(r.sku || ''), hasSalesHistory: !!r.hasSalesHistory,
      };
    }
  } catch (e) { _logGasError('getVelocityMap/getVelocity', e.message); }

  // Total-failure fallback only: if the shared cache gave us nothing, use the local build so DOH/reorder
  // never break. (We do NOT auto-run the ~50s local build per missing store — a missing store degrades
  // gracefully; missing stores are logged so we'd notice a data gap.)
  if (!Object.keys(velMap).length) {
    _logGasError('getVelocityMap', 'shared velocity cache empty — falling back to local build');
    try { return buildVelocityMap(); } catch (e) { _logGasError('getVelocityMap/fallback', e.message); return {}; }
  }
  const missing = STORES.filter(s => !velMap[s]);
  if (missing.length) _logGasError('getVelocityMap', 'no shared velocity for: ' + missing.join(', '));
  return velMap;
}

function buildVelocityMap() {
  const sheet = getVelSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const data   = sheet.getRange(2, 1, lastRow - 1, VEL_COLS.length).getValues();
  const now    = Date.now();
  const MS_DAY = 86400000;
  const cut7   = now - 7  * MS_DAY;
  const cut14  = now - 14 * MS_DAY;
  const cut21  = now - 21 * MS_DAY;
  const cut28  = now - 28 * MS_DAY;
  const cut30  = now - 30 * MS_DAY;
  const cut90  = now - 90 * MS_DAY;

  const velMap = {};
  for (const row of data) {
    const dateStr = _velDateToYMD(row[0]);
    if (!dateStr) continue;
    const ts = new Date(dateStr + 'T12:00:00').getTime(); // noon local avoids midnight DST edge cases

    const store   = String(row[1] || '');
    const name    = String(row[3] || '').trim();
    const brand   = String(row[4] || '');
    const cat     = String(row[5] || '');
    const sku     = String(row[6] || '');
    const qty     = parseFloat(row[7]) || 0;
    if (!store || !name || name === 'Unknown' || qty <= 0) continue;

    if (!velMap[store])        velMap[store] = {};
    if (!velMap[store][name])  velMap[store][name] = { qty7: 0, qty14: 0, qty21: 0, qty28: 0, qty30: 0, qty90: 0, hasSalesHistory: false, brand, category: cat, sku };
    const e = velMap[store][name];
    e.hasSalesHistory = true; // any row (up to 180 days) = product has prior sales
    if (ts < cut90) continue; // older rows counted for history only, not velocity
    e.qty90 += qty;
    if (ts >= cut30) e.qty30 += qty;
    if (ts >= cut28) e.qty28 += qty;
    if (ts >= cut21) e.qty21 += qty;
    if (ts >= cut14) e.qty14 += qty;
    if (ts >= cut7)  e.qty7  += qty;
  }

  for (const store of Object.keys(velMap)) {
    for (const name of Object.keys(velMap[store])) {
      const e = velMap[store][name];
      e.vel7  = Math.round((e.qty7  / 7)  * 100) / 100;
      e.vel14 = Math.round((e.qty14 / 14) * 100) / 100;
      e.vel21 = Math.round((e.qty21 / 21) * 100) / 100;
      e.vel28 = Math.round((e.qty28 / 28) * 100) / 100;
      e.vel30 = Math.round((e.qty30 / 30) * 100) / 100;
      e.vel90 = Math.round((e.qty90 / 90) * 100) / 100;
    }
  }

  return velMap;
}

function clearVelCache() {
  const sheet = getVelSheet();
  // Use clearContents() + rewrite header, NOT deleteRows(): Sheets throws
  // "it is not possible to delete all non-frozen rows" when the header is frozen
  // and we'd remove every data row. clearContents has no such restriction.
  sheet.clearContents();
  sheet.getRange(1, 1, 1, VEL_COLS.length).setValues([VEL_COLS]);
  sheet.setFrozenRows(1);
  // Re-apply plain-text format to the date column so the rebuild stores dates as
  // strings, NOT Date objects (clearContents can drop the format). Date-object rows
  // force the slow conversion path in buildVelocityMap.
  sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@STRING@');
  // Full sync-state reset so the next velsync rebuilds cleanly from scratch and the
  // gap self-heal doesn't fire mid-rebuild on stale flags.
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('velSyncDate');
  props.deleteProperty('velLastWriteDate');
  props.deleteProperty('velSheetCorrupted');
  props.deleteProperty('velGapHealedAt');
  props.setProperty('velSheetFormatted', 'true'); // format just applied; skip re-apply in getVelSheet
  return { ok: true, message: 'Vel Cache sheet cleared and sync state reset. Run velsync to backfill.' };
}

// velBackfillChunk: HTTP entry point — just schedules the trigger and returns immediately.
// The actual data fetch runs in a background trigger (6-min limit vs 30-sec HTTP limit).
function velBackfillChunk(params) {
  const props   = PropertiesService.getScriptProperties();
  const now     = new Date();
  const cutoff  = new Date(now.getTime() - VEL_WINDOW_DAYS * 86400000);
  const fromStr = (params && params.from) || cutoff.toISOString().slice(0, 10);
  const fromDate = new Date(fromStr + 'T00:00:00Z');
  if (fromDate > now) return { ok: false, message: 'from date is in the future' };
  props.setProperty('backfillFrom', fromStr);
  props.setProperty('backfillStatus', 'pending');
  _installBackfillTrigger();
  return { ok: true, message: 'Backfill trigger scheduled from ' + fromStr, from: fromStr };
}

// Called by a one-minute trigger. Fetches one 7-day chunk then schedules itself again until done.
function _runBackfillTrigger() {
  // Delete this trigger first so it doesn't double-fire
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === '_runBackfillTrigger')
    .forEach(t => ScriptApp.deleteTrigger(t));

  const props    = PropertiesService.getScriptProperties();
  const fromStr  = props.getProperty('backfillFrom');
  if (!fromStr) {
    Logger.log('_runBackfillTrigger: backfillFrom missing, aborting');
    return;
  }

  const now        = new Date();
  const fromDate   = new Date(fromStr + 'T00:00:00Z');
  const CHUNK      = 7 * 86400000;
  const toDate     = new Date(Math.min(fromDate.getTime() + CHUNK, now.getTime()));
  const productDict = buildProductIdDict(); // hoist — avoids re-fetch inside _syncChunk

  try {
    const result = _syncChunk(props, fromDate, toDate, false, productDict); // don't touch velSyncDate
    Logger.log('_runBackfillTrigger: synced ' + fromStr + ' → ' + toDate.toISOString().slice(0,10) + ' (' + (result.synced || 0) + ' rows)');
    // Update velLastWriteDate so the gap self-heal in syncVelocityCache can see backfill progress.
    // We can't use updateProp=true (that would clobber velSyncDate), so update it explicitly here.
    if (result.synced > 0) {
      const prevLast = props.getProperty('velLastWriteDate') || '';
      const chunkMax = toDate.toISOString().slice(0, 10);
      if (chunkMax > prevLast) props.setProperty('velLastWriteDate', chunkMax);
    }
  } catch(e) {
    // Log the error and stamp it into status so velbackfillstatus exposes it;
    // do NOT reschedule — a broken trigger loop wastes quota silently.
    const errMsg = 'error:' + fromStr + ':' + e.message;
    props.setProperty('backfillStatus', errMsg);
    Logger.log('_runBackfillTrigger ERROR at ' + fromStr + ': ' + e.message + '\n' + e.stack);
    return;
  }

  const nextFrom = toDate.toISOString().slice(0, 10);
  const done = toDate >= now;
  if (done) {
    props.deleteProperty('backfillFrom');
    props.setProperty('backfillStatus', 'complete:' + nextFrom);
    Logger.log('_runBackfillTrigger: COMPLETE at ' + nextFrom);
  } else {
    props.setProperty('backfillFrom', nextFrom);
    props.setProperty('backfillStatus', 'running:' + nextFrom);
    _installBackfillTrigger();
  }
}

function _installBackfillTrigger() {
  // Only one backfill trigger at a time
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === '_runBackfillTrigger')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('_runBackfillTrigger').timeBased().after(60000).create();
}

// Poll endpoint — returns current backfill status without triggering anything.
function velBackfillStatus() {
  const props  = PropertiesService.getScriptProperties();
  const status = props.getProperty('backfillStatus') || 'idle';
  const from   = props.getProperty('backfillFrom')   || null;
  return { status, from };
}

// Diagnostic: look up all Vel Cache rows for a given productId or name fragment.
// Usage: ?action=velproduct&id=B665EB4F73  OR  ?action=velproduct&name=SomeProduct
function velProductDiagnostic(params) {
  const sheet   = getVelSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'Vel Cache is empty', rows: [] };

  const searchId   = String(params.id   || '').toLowerCase().trim();
  const searchName = String(params.name || '').toLowerCase().trim();
  if (!searchId && !searchName) return { error: 'Provide id or name param', rows: [] };

  // Read all 8 columns in one call. A two-pass "narrow then fetch" approach sounds
  // efficient but firing one getRange per matching row (N+1) costs ~30ms × N API calls
  // and easily exceeds the GAS execution limit for popular products. One bulk read wins.
  const filterData = sheet.getRange(2, 1, lastRow - 1, VEL_COLS.length).getValues();
  const matches = [];
  for (let i = 0; i < filterData.length; i++) {
    const pid   = String(filterData[i][2] || '').toLowerCase();
    const pname = String(filterData[i][3] || '').toLowerCase();
    if ((searchId && pid.includes(searchId)) || (searchName && pname.includes(searchName))) {
      matches.push(filterData[i]);
    }
  }
  if (!matches.length) return { found: false, searchId, searchName, totalRows: filterData.length };

  // Summarise by store: earliest date, latest date, total qty, row count
  const byStore = {};
  for (const r of matches) {
    const store = String(r[1]);
    const ymd   = _velDateToYMD(r[0]);
    const qty   = parseFloat(r[7]) || 0;
    if (!byStore[store]) byStore[store] = { store, minDate: ymd, maxDate: ymd, totalQty: 0, rows: 0 };
    const s = byStore[store];
    if (ymd < s.minDate) s.minDate = ymd;
    if (ymd > s.maxDate) s.maxDate = ymd;
    s.totalQty += qty;
    s.rows++;
  }

  const velSyncDate = PropertiesService.getScriptProperties().getProperty('velSyncDate') || null;

  // Optional per-date dump for one store (&dates=1&store=Bend). Surfaces duplicate or
  // TZ-shifted date rows: each entry shows the raw cell type, the normalized YMD, qty,
  // and how many physical rows share that (store,date) key. count>1 = duplicate rows.
  let dateDump = null;
  if (params.dates === '1' && params.store) {
    const wantStore = String(params.store);
    const perKey = {};
    for (const r of matches) {
      if (String(r[1]) !== wantStore) continue;
      const ymd = _velDateToYMD(r[0]);
      const isDateObj = (r[0] instanceof Date);
      const qty = parseFloat(r[7]) || 0;
      if (!perKey[ymd]) perKey[ymd] = { ymd, qty: 0, rows: 0, rawTypes: {} };
      perKey[ymd].qty += qty;
      perKey[ymd].rows++;
      const t = isDateObj ? 'Date' : (typeof r[0]);
      perKey[ymd].rawTypes[t] = (perKey[ymd].rawTypes[t] || 0) + 1;
    }
    const list = Object.values(perKey).sort((a, b) => a.ymd < b.ymd ? -1 : 1);
    const dupDates = list.filter(d => d.rows > 1);
    dateDump = { store: wantStore, distinctDates: list.length, dupDateCount: dupDates.length, dupDates, dates: list };
  }

  return {
    found: true,
    name:      String(matches[0][3]),
    brand:     String(matches[0][4]),
    category:  String(matches[0][5]),
    sku:       String(matches[0][6]),
    productId: String(matches[0][2]),
    totalMatchRows: matches.length,
    velSyncDate,
    byStore: Object.values(byStore),
    dateDump
  };
}

// Diagnostic: check which dates have ANY Vel Cache rows for a given store,
// and identify gaps in a date range.
// ?action=velgapcheck&store=Bend&from=2026-05-04&to=2026-05-18
function velGapCheck(params) {
  const store   = params.store || 'Bend';
  const fromStr = params.from  || new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  const toStr   = params.to    || new Date().toISOString().slice(0, 10);

  const sheet   = getVelSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'Vel Cache is empty' };

  // Read only columns 1-2 (date, store) — 140K cells instead of 560K for a 70K-row sheet.
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();

  // Build set of YYYY-MM-DD dates that have at least one row for this store
  const datesWithData = new Set();
  let totalRowsForStore = 0;
  for (const r of data) {
    if (String(r[1]) !== store) continue;
    const d = _velDateToYMD(r[0]);
    if (!d) continue;
    if (d >= fromStr && d <= toStr) { datesWithData.add(d); totalRowsForStore++; }
  }

  // Generate expected dates and find gaps
  const gaps = [];
  const present = [];
  const cur = new Date(fromStr + 'T12:00:00Z');
  const end = new Date(toStr   + 'T12:00:00Z');
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    if (datesWithData.has(d)) present.push(d); else gaps.push(d);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const velSyncDate = PropertiesService.getScriptProperties().getProperty('velSyncDate') || null;
  return { store, from: fromStr, to: toStr, totalRowsForStore, datesPresent: present.length, gaps, velSyncDate };
}

function clearRoomCache() {
  const sc = CacheService.getScriptCache();
  const keys = STORES.map(s => 'roomdata4_' + s).concat(STORES.map(s => 'inv5_' + s));
  sc.removeAll(keys);
  return { ok: true, message: 'Room and inventory caches cleared for all stores.' };
}

function roomIdProbe(params) {
  const store  = params.store  || 'River Rd';
  const roomId = params.roomId || '5258';
  const hdrs   = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const resp   = UrlFetchApp.fetch(DUTCHIE_BASE + '/inventory?roomId=' + roomId, { headers: hdrs, muteHttpExceptions: true });
  const code   = resp.getResponseCode();
  if (code !== 200) return { http: code, body: resp.getContentText().slice(0, 300) };
  const raw    = JSON.parse(resp.getContentText());
  const items  = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  return {
    http: code, count: items.length,
    fields: items.length ? Object.keys(items[0]) : [],
    sample: items.slice(0, 3).map(i => ({ inventoryId: i.inventoryId, sku: i.sku, qty: i.quantityAvailable, roomId: i.roomId, roomName: i.roomName })),
  };
}

// Diagnostic: probe every candidate endpoint that might expose per-package room
// designation for a store, across all of that store's rooms. ?action=roomendpointprobe&store=River Rd
// Goal: find a live source of room assignment now that /reporting/inventory's roomQuantities
// is empty. Returns a matrix of endpoint × room → package count, so we can see which
// endpoint actually partitions inventory by room.
function roomEndpointProbe(params) {
  const store = params.store || 'River Rd';
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  // 1) Get the room list for this store
  let rooms = [];
  try {
    const rr = UrlFetchApp.fetch(DUTCHIE_BASE + '/room/rooms', { headers: hdrs, muteHttpExceptions: true });
    if (rr.getResponseCode() === 200) rooms = JSON.parse(rr.getContentText()) || [];
  } catch (e) {}
  const roomList = (Array.isArray(rooms) ? rooms : []).map(r => ({ roomId: r.roomId, roomName: r.roomName || r.name, isSalesFloor: !!r.isSalesFloor }));

  const summarize = (resp) => {
    const code = resp.getResponseCode();
    if (code !== 200) return { http: code, err: resp.getContentText().slice(0, 120) };
    let items = [];
    try { const raw = JSON.parse(resp.getContentText()); items = Array.isArray(raw) ? raw : (raw.data || raw.items || []); } catch (e) { return { http: code, parseErr: true }; }
    const withRoomId   = items.filter(i => i.roomId != null).length;
    const withRoomName = items.filter(i => i.roomName).length;
    const withRQ       = items.filter(i => Array.isArray(i.roomQuantities) && i.roomQuantities.length > 0).length;
    return { http: code, count: items.length, withRoomId, withRoomName, withRoomQuantities: withRQ };
  };

  const out = { store, roomList, baseline: {}, perRoom: {} };

  // 2) Baseline unfiltered endpoints (batch)
  const baseReqs = [
    ['reporting_inventory',            DUTCHIE_BASE + '/reporting/inventory'],
    ['inventory_plain',               DUTCHIE_BASE + '/inventory'],
    ['inventory_includeRoomQty',      DUTCHIE_BASE + '/inventory?includeRoomQuantities=true'],
  ];
  const baseResp = UrlFetchApp.fetchAll(baseReqs.map(([, url]) => ({ url, headers: hdrs, muteHttpExceptions: true })));
  baseReqs.forEach(([name], i) => { out.baseline[name] = summarize(baseResp[i]); });

  // 3) Per-room filtered endpoints — test both /inventory?roomId and /reporting/inventory?roomId
  const roomReqs = [];
  const roomKeys = [];
  for (const r of roomList) {
    if (r.roomId == null) continue;
    roomReqs.push({ url: DUTCHIE_BASE + '/inventory?roomId=' + r.roomId,           headers: hdrs, muteHttpExceptions: true });
    roomKeys.push([r.roomName + ' (' + r.roomId + ')', 'inventory_roomId']);
    roomReqs.push({ url: DUTCHIE_BASE + '/reporting/inventory?roomId=' + r.roomId, headers: hdrs, muteHttpExceptions: true });
    roomKeys.push([r.roomName + ' (' + r.roomId + ')', 'reporting_roomId']);
  }
  if (roomReqs.length) {
    const roomResp = UrlFetchApp.fetchAll(roomReqs);
    roomKeys.forEach(([roomLabel, ep], i) => {
      if (!out.perRoom[roomLabel]) out.perRoom[roomLabel] = {};
      out.perRoom[roomLabel][ep] = summarize(roomResp[i]);
    });
  }

  // 4) Move-transaction endpoint (the code's invRoomMap fallback source). Report count and
  // whether rows carry toRoom/roomId, since an empty/roomless tx feed is why invRoomMap is 0.
  const date150 = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10);
  const txReqs = [
    ['inventorytransaction_all',        DUTCHIE_BASE + '/inventory/inventorytransaction'],
    ['inventorytransaction_150d',       DUTCHIE_BASE + '/inventory/inventorytransaction?startDate=' + date150],
  ];
  const txResp = UrlFetchApp.fetchAll(txReqs.map(([, url]) => ({ url, headers: hdrs, muteHttpExceptions: true })));
  out.moveTx = {};
  txReqs.forEach(([name], i) => {
    const resp = txResp[i]; const code = resp.getResponseCode();
    if (code !== 200) { out.moveTx[name] = { http: code, err: resp.getContentText().slice(0,120) }; return; }
    let items = []; try { const raw = JSON.parse(resp.getContentText()); items = Array.isArray(raw) ? raw : (raw.data || raw.items || []); } catch(e) { out.moveTx[name] = {http:code, parseErr:true}; return; }
    const withToRoom = items.filter(t => t.toRoom).length;
    const types = {}; items.forEach(t => { const ty = t.transactionType || t.type || '?'; types[ty] = (types[ty]||0)+1; });
    out.moveTx[name] = { http: code, count: items.length, withToRoom, fields: items.length ? Object.keys(items[0]) : [], txTypes: types, sample: items.slice(0,2).map(t => ({ type: t.transactionType||t.type, inventoryId: t.inventoryId, toRoom: t.toRoom, fromRoom: t.fromRoom, roomId: t.roomId, date: t.transactionDate })) };
  });

  return out;
}

// Diagnostic: test /inventory/inventorytransaction with BOTH startDate and endDate
// (the endpoint now requires both). ?action=txfullprobe&store=River Rd&days=30
// Reports whether Move rows carry toRoom/roomId so we can rebuild room designation.
function txFullProbe(params) {
  const store = params.store || 'River Rd';
  const days  = parseInt(params.days || '30', 10);
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const end   = new Date(Date.now() + 86400000).toISOString().slice(0, 10); // tomorrow, inclusive
  const variants = [
    ['date_only',      DUTCHIE_BASE + '/inventory/inventorytransaction?startDate=' + start + '&endDate=' + end],
    ['utc_iso',        DUTCHIE_BASE + '/inventory/inventorytransaction?startDate=' + encodeURIComponent(new Date(Date.now()-days*86400000).toISOString()) + '&endDate=' + encodeURIComponent(new Date().toISOString())],
  ];
  const resp = UrlFetchApp.fetchAll(variants.map(([, url]) => ({ url, headers: hdrs, muteHttpExceptions: true })));
  const out = { store, start, end, variants: {} };
  variants.forEach(([name], i) => {
    const r = resp[i]; const code = r.getResponseCode();
    if (code !== 200) { out.variants[name] = { http: code, err: r.getContentText().slice(0, 300) }; return; }
    let items = []; try { const raw = JSON.parse(r.getContentText()); items = Array.isArray(raw) ? raw : (raw.data || raw.items || []); } catch(e){ out.variants[name] = {http:code, parseErr:true}; return; }
    const withToRoom = items.filter(t => t.toRoom).length;
    const roomVals = {}; items.forEach(t => { if (t.toRoom) roomVals[t.toRoom] = (roomVals[t.toRoom]||0)+1; });
    const types = {}; items.forEach(t => { const ty = t.transactionType || t.type || '?'; types[ty]=(types[ty]||0)+1; });
    out.variants[name] = {
      http: code, count: items.length, withToRoom, toRoomValues: roomVals, txTypes: types,
      fields: items.length ? Object.keys(items[0]) : [],
      sample: items.slice(0, 3).map(t => ({ type: t.transactionType||t.type, inventoryId: t.inventoryId, packageId: t.packageId, toRoom: t.toRoom, fromRoom: t.fromRoom, roomId: t.roomId, roomName: t.roomName, date: t.transactionDate || t.date })),
    };
  });
  return out;
}

// Diagnostic: full trace of how one SKU at one store is classified into rooms.
// ?action=skudebug&store=River Rd&sku=62938162
// Shows each inventory package's quantity + how getInventory would classify it (roomQuantities
// → roomName/roomId → invRoomMap Move-tx → default), plus the raw Move-tx history per package.
function skuDebug(params) {
  const store = params.store || 'River Rd';
  const sku   = String(params.sku || '');
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  const invResp = UrlFetchApp.fetch(DUTCHIE_BASE + '/reporting/inventory', { headers: hdrs, muteHttpExceptions: true });
  if (invResp.getResponseCode() !== 200) return { error: 'inventory HTTP ' + invResp.getResponseCode() };
  const raw   = JSON.parse(invResp.getContentText());
  const items = (Array.isArray(raw) ? raw : (raw.data || raw.items || [])).filter(i => String(i.sku) === sku);

  const rd = buildRoomData(store); // uses the live (fixed) room-data path
  const { roomNameType, roomIdType, invRoomMap } = rd;

  // Latest Move-tx toRoom per inventoryId for THIS sku (last 30 days, one window)
  const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const end   = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const txResp = UrlFetchApp.fetch(DUTCHIE_BASE + '/inventory/inventorytransaction?startDate=' + start + '&endDate=' + end, { headers: hdrs, muteHttpExceptions: true });
  const txBySku = {};
  if (txResp.getResponseCode() === 200) {
    const txs = JSON.parse(txResp.getContentText());
    for (const tx of (Array.isArray(txs) ? txs : [])) {
      if (String(tx.sku) !== sku) continue;
      (txBySku[tx.inventoryId] = txBySku[tx.inventoryId] || []).push({ type: tx.transactionType, toRoom: tx.toRoom, fromRoom: tx.fromRoom, qty: tx.quantity, date: tx.transactionDate });
    }
  }

  const cutoff90 = new Date(Date.now() - 90 * 86400000).toISOString();
  const packages = items.map(item => {
    const qty = Number(item.quantityAvailable || 0);
    const included = !(qty <= 0 && (item.lastModifiedDateUtc || '') < cutoff90);
    const rqs = Array.isArray(item.roomQuantities) ? item.roomQuantities : null;
    const txRoom = invRoomMap[item.inventoryId];
    const safeTxRoom = (txRoom === 'floor' || txRoom === 'back' || txRoom === 'distro') ? txRoom : null;
    const resolved = (item.roomName && roomNameType[item.roomName]) ? roomNameType[item.roomName]
      : (item.roomId && roomIdType[item.roomId]) ? roomIdType[item.roomId]
      : safeTxRoom ? safeTxRoom : 'back';
    return {
      inventoryId: item.inventoryId,
      packageId: item.packageId,
      quantityAvailable: qty,
      allocatedQuantity: item.allocatedQuantity,
      lastModified: item.lastModifiedDateUtc,
      includedInApp: included,
      roomQuantities: rqs,
      itemRoomName: item.roomName || null,
      itemRoomId: item.roomId || null,
      invRoomMapType: txRoom || null,
      resolvedRoomType: resolved,
      moveTxHistory: (txBySku[item.inventoryId] || []).sort((a,b)=> (a.date<b.date?1:-1)),
    };
  });

  const totals = { active: 0, floor: 0, back: 0, distro: 0, quarantine: 0, sample: 0 };
  packages.forEach(pk => {
    if (!pk.includedInApp) return;
    const t = pk.resolvedRoomType, q = pk.quantityAvailable;
    if (t === 'quarantine') totals.quarantine += q;
    else if (t === 'sample') totals.sample += q;
    else if (t === 'distro') totals.distro += q;
    else { totals.active += q; if (t === 'floor') totals.floor += q; else totals.back += q; }
  });

  return { store, sku, packageCount: packages.length, appTotals: totals, packages };
}

// Diagnostic: report every sheet's grid size in the data spreadsheet, to find what is
// consuming the 10,000,000-cell workbook cap. ?action=sheetsinfo
// A sheet's cell cost is maxRows × maxColumns (the GRID, not the used range) — a sheet
// with millions of empty rows or hundreds of untrimmed columns is the usual culprit.
function sheetsInfo(params) {
  const ss = SpreadsheetApp.openById(getDataSpreadsheetId());
  const sheets = ss.getSheets();
  let totalCells = 0;
  const rows = sheets.map(sh => {
    const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
    const cells = maxR * maxC;
    totalCells += cells;
    return {
      name: sh.getName(),
      maxRows: maxR, maxCols: maxC, gridCells: cells,
      lastRow: sh.getLastRow(), lastCol: sh.getLastColumn(),
      wastedRows: maxR - sh.getLastRow(), wastedCols: maxC - sh.getLastColumn(),
    };
  });
  rows.sort((a, b) => b.gridCells - a.gridCells);
  return {
    spreadsheetId: ss.getId(),
    sheetCount: sheets.length,
    totalGridCells: totalCells,
    cellLimit: 10000000,
    pctOfLimit: Math.round(totalCells / 10000000 * 1000) / 10,
    sheets: rows,
  };
}

// Reclaim workbook cells by deleting empty trailing rows/columns beyond each sheet's used
// range (the grid cost is maxRows × maxColumns, not the used range, so untrimmed empty rows
// waste cells and can fill the 10,000,000-cell cap). Non-destructive: only removes space past
// getLastRow()/getLastColumn(), keeping a small buffer. ?action=trimempty (optionally &sheet=Name)
function trimEmptySheetSpace(params) {
  const ss = SpreadsheetApp.openById(getDataSpreadsheetId());
  const only = params.sheet || null;
  const ROW_BUFFER = 2, COL_BUFFER = 1;
  const results = [];
  let freedCells = 0;
  for (const sh of ss.getSheets()) {
    if (only && sh.getName() !== only) continue;
    const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
    const lastR = sh.getLastRow(), lastC = sh.getLastColumn();
    const keepR = Math.max(lastR + ROW_BUFFER, 1);
    const keepC = Math.max(lastC + COL_BUFFER, 1);
    let dRows = 0, dCols = 0;
    if (maxR > keepR) { sh.deleteRows(keepR + 1, maxR - keepR); dRows = maxR - keepR; }
    // Re-read maxColumns after row delete (unchanged) and trim columns.
    if (maxC > keepC) { sh.deleteColumns(keepC + 1, maxC - keepC); dCols = maxC - keepC; }
    if (dRows || dCols) {
      const before = maxR * maxC;
      const after = (maxR - dRows) * (maxC - dCols);
      freedCells += (before - after);
      results.push({ sheet: sh.getName(), deletedRows: dRows, deletedCols: dCols, newRows: maxR - dRows, newCols: maxC - dCols });
    }
  }
  return { ok: true, freedCells, trimmed: results };
}

// ─── INVENTORY-DATA SPREADSHEET MIGRATION ─────────────────────────────────────
// Sheets moved out of the financial workbook into their own dedicated spreadsheet.
const INV_DATA_MOVE_SHEETS = ['Vel Cache', 'Inv Snapshot', 'ProductCatalog', 'Product SKU Dict', 'Operational Snapshot'];

// Create the dedicated inventory-data spreadsheet (if needed) and copy the sheets over with
// sheet.copyTo (server-side, handles the 400k+ row sheets without loading them into memory).
// Idempotent + resumable: skips sheets already copied, so a 6-min timeout mid-run is safe to
// re-invoke. Pass &sheet=Name to copy just one (use for the biggest sheets). Pass &activate=1
// to flip getInvDataSpreadsheetId() over to the new spreadsheet once every sheet is present.
// Does NOT delete anything from the financial workbook — that's deletemigrated, run last.
function migrateInventoryData(params) {
  const props = PropertiesService.getScriptProperties();
  const oldSS = SpreadsheetApp.openById(getDataSpreadsheetId()); // financial workbook = source
  let newId = props.getProperty('INV_DATA_SS_ID') || props.getProperty('INV_DATA_SS_PENDING');
  let created = false;
  let newSS;
  if (newId) {
    newSS = SpreadsheetApp.openById(newId);
  } else {
    newSS = SpreadsheetApp.create('Green Cross — Inventory Data');
    newId = newSS.getId();
    props.setProperty('INV_DATA_SS_PENDING', newId);
    created = true;
  }
  const only = params.sheet || null;
  const copied = [], skipped = [], errors = [];
  for (const name of INV_DATA_MOVE_SHEETS) {
    if (only && name !== only) continue;
    if (newSS.getSheetByName(name)) { skipped.push(name + ' (already in new SS)'); continue; }
    const src = oldSS.getSheetByName(name);
    if (!src) { skipped.push(name + ' (not in financial workbook)'); continue; }
    try {
      const dest = src.copyTo(newSS);
      dest.setName(name);
      copied.push(name + ' (' + src.getLastRow() + ' rows)');
    } catch (e) { errors.push(name + ': ' + e.message); }
  }
  // Drop the default empty "Sheet1" once real sheets exist.
  const def = newSS.getSheetByName('Sheet1');
  if (def && newSS.getSheets().length > 1) { try { newSS.deleteSheet(def); } catch (e) {} }

  // A sheet is "handled" if it's now in the new SS, or it never existed in the old SS.
  const allPresent = INV_DATA_MOVE_SHEETS.every(n => newSS.getSheetByName(n) || !oldSS.getSheetByName(n));
  let activated = false;
  if (params.activate === '1' && allPresent && !errors.length) {
    props.setProperty('INV_DATA_SS_ID', newId);
    props.deleteProperty('INV_DATA_SS_PENDING');
    activated = true;
  }
  return {
    ok: true, created, newSpreadsheetId: newId,
    newUrl: 'https://docs.google.com/spreadsheets/d/' + newId + '/edit',
    copied, skipped, errors, allPresent, activated,
    activeSpreadsheetId: props.getProperty('INV_DATA_SS_ID') || null,
  };
}

// Copy only the RECENT tail of 'Inv Snapshot' into the new spreadsheet. The full sheet has
// grown to 400k+ rows, which (a) copyTo can't load from the maxed-out financial workbook and
// (b) is the growth we wanted to cap anyway. A range read of the last N rows is far lighter
// than copyTo, and keeping the recent tail preserves current OOS "last-seen" dates (older
// products are stale). ?action=copyinvsnap&rows=80000
function copyInvSnapshotRecent(params) {
  const props = PropertiesService.getScriptProperties();
  const keepRows = parseInt(params.rows || '80000', 10);
  const oldSS = SpreadsheetApp.openById(getDataSpreadsheetId());
  const src = oldSS.getSheetByName(SNAPSHOT_SHEET_NAME);
  if (!src) return { ok: false, error: 'Inv Snapshot not in financial workbook' };
  const newId = props.getProperty('INV_DATA_SS_ID') || props.getProperty('INV_DATA_SS_PENDING');
  if (!newId) return { ok: false, error: 'Run migrateinvdata first (no target spreadsheet yet).' };
  const newSS = SpreadsheetApp.openById(newId);
  if (newSS.getSheetByName(SNAPSHOT_SHEET_NAME)) return { ok: true, note: 'Inv Snapshot already in new SS', skipped: true };

  const lastRow = src.getLastRow(), lastCol = src.getLastColumn();
  const startRow = Math.max(2, lastRow - keepRows + 1); // keep header + last N data rows
  const nData = lastRow - startRow + 1;
  const dest = newSS.insertSheet(SNAPSHOT_SHEET_NAME);
  // header
  dest.getRange(1, 1, 1, lastCol).setValues(src.getRange(1, 1, 1, lastCol).getValues());
  // recent rows in batches (avoids a single oversized read)
  const BATCH = 20000; let copied = 0, cur = startRow;
  while (cur <= lastRow) {
    const n = Math.min(BATCH, lastRow - cur + 1);
    const vals = src.getRange(cur, 1, n, lastCol).getValues();
    dest.getRange(dest.getLastRow() + 1, 1, n, lastCol).setValues(vals);
    cur += n; copied += n;
  }
  return { ok: true, srcRows: lastRow, keptRows: copied, droppedOldRows: (startRow - 2), destRows: dest.getLastRow() };
}

// Final step: after the migration is activated AND verified, delete the moved sheets from the
// financial workbook to reclaim its cells. Refuses to delete any sheet unless a populated copy
// exists in the new SS. Requires &confirm=1.
function deleteMigratedFromFinancial(params) {
  if (params.confirm !== '1') return { ok: false, error: 'Pass confirm=1 to delete (guard).' };
  const props = PropertiesService.getScriptProperties();
  const activeId = props.getProperty('INV_DATA_SS_ID');
  if (!activeId) return { ok: false, error: 'Migration not activated yet (INV_DATA_SS_ID unset).' };
  const newSS = SpreadsheetApp.openById(activeId);
  const oldSS = SpreadsheetApp.openById(getDataSpreadsheetId());
  const deleted = [], skipped = [];
  for (const name of INV_DATA_MOVE_SHEETS) {
    const inOld = oldSS.getSheetByName(name);
    if (!inOld) { skipped.push(name + ' (not in financial workbook)'); continue; }
    const inNew = newSS.getSheetByName(name);
    if (!inNew || inNew.getLastRow() < Math.min(inOld.getLastRow(), 1)) {
      skipped.push(name + ' (NOT safely present in new SS — refused)'); continue;
    }
    try { oldSS.deleteSheet(inOld); deleted.push(name); } catch (e) { skipped.push(name + ': ' + e.message); }
  }
  return { ok: true, deleted, skipped };
}

function clearProductCatalogCache() {
  const sc = CacheService.getScriptCache();
  sc.removeAll(['prodcat_v2', 'prodcat_v2_a', 'prodcat_v2_b', 'prodcat_v2_split']);
  return { ok: true, message: 'Product catalog cache cleared. Next velsync will re-fetch /products.' };
}

// Remove duplicate rows from the Vel Cache sheet. A row is a duplicate if another row
// has the same (date, store, productId) key — keeps the last occurrence (most recent write).
// Also prunes rows older than 180 days. Run this once after the broken-dedup period.
function velDedup() {
  const sheet   = getVelSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, message: 'Sheet empty', removed: 0 };

  const data = sheet.getRange(2, 1, lastRow - 1, VEL_COLS.length).getValues();
  const cutoff = new Date(Date.now() - VEL_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

  // Walk in reverse so the LAST written row wins (most recent sync data kept).
  const seen    = new Set();
  const deduped = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const row  = data[i];
    const ymd  = _velDateToYMD(row[0]);
    if (!ymd || ymd < cutoff) continue; // prune old + invalid
    const key  = row[1] + '|' + ymd + '|' + row[2];
    if (seen.has(key)) continue; // duplicate — skip
    seen.add(key);
    // Normalize the date cell to its YMD string so the rewritten sheet is uniformly text
    // (no Date objects) — prevents the timezone-shift / duplicate-row cycle from recurring.
    row[0] = ymd;
    deduped.push(row);
  }
  deduped.reverse(); // restore chronological order

  const removed = data.length - deduped.length;
  sheet.clearContents();
  sheet.getRange(1, 1, 1, VEL_COLS.length).setValues([VEL_COLS]);
  if (deduped.length > 0) sheet.getRange(2, 1, deduped.length, 1).setNumberFormat('@'); // text date col
  // Batched write (5K rows/batch), NOT a single setValues. A single write of the full
  // deduped set (>100K rows) can hit the GAS 6-min limit mid-write and silently TRUNCATE
  // the sheet — which is exactly how the recent-tail data loss happened. Batching means a
  // timeout leaves the sheet written from the top, and the post-write count check below
  // flags any shortfall so the nightly gap self-heal recovers it.
  const WRITE_BATCH = 5000;
  for (let i = 0; i < deduped.length; i += WRITE_BATCH) {
    const batch = deduped.slice(i, i + WRITE_BATCH);
    sheet.getRange(i + 2, 1, batch.length, VEL_COLS.length).setValues(batch);
  }
  const writtenRows = sheet.getLastRow() - 1; // subtract header
  const props = PropertiesService.getScriptProperties();
  let truncated = false;
  if (writtenRows !== deduped.length) {
    truncated = true;
    props.setProperty('velSheetCorrupted', 'dedup-incomplete:' + writtenRows + '/' + deduped.length);
    Logger.log('velDedup WRITE INCOMPLETE — ' + writtenRows + '/' + deduped.length + '. Gap self-heal will recover.');
  } else {
    props.deleteProperty('velSheetCorrupted');
  }

  Logger.log('velDedup: ' + data.length + ' → ' + deduped.length + ' rows (' + removed + ' removed)');
  return { ok: true, before: data.length, after: deduped.length, removed, writtenRows, truncated };
}

// Delete all Vel Cache rows on/after a cutoff date (?action=velclearfrom&from=YYYY-MM-DD),
// keeping everything older. Used to wipe a window of legacy timezone-shifted rows so a
// subsequent re-sync rewrites it with correct text dates (a plain re-sync would leave the
// shifted rows behind as phantoms, since their date keys differ by a day). Also normalizes
// the kept rows' dates to text strings. Batched write + truncation guard, like velDedup.
function velClearFrom(params) {
  const from = params.from;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return { ok: false, error: 'Provide from=YYYY-MM-DD' };
  const sheet   = getVelSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, before: 0, after: 0, removed: 0 };

  const data = sheet.getRange(2, 1, lastRow - 1, VEL_COLS.length).getValues();
  const kept = [];
  for (const row of data) {
    const ymd = _velDateToYMD(row[0]);
    if (ymd && ymd >= from) continue; // drop rows in the cleared window
    row[0] = ymd; // normalize kept dates to text
    kept.push(row);
  }
  const removed = data.length - kept.length;
  sheet.clearContents();
  sheet.getRange(1, 1, 1, VEL_COLS.length).setValues([VEL_COLS]);
  if (kept.length > 0) sheet.getRange(2, 1, kept.length, 1).setNumberFormat('@'); // text date col
  const WRITE_BATCH = 5000;
  for (let i = 0; i < kept.length; i += WRITE_BATCH) {
    const batch = kept.slice(i, i + WRITE_BATCH);
    sheet.getRange(i + 2, 1, batch.length, VEL_COLS.length).setValues(batch);
  }
  const writtenRows = sheet.getLastRow() - 1;
  const props = PropertiesService.getScriptProperties();
  let truncated = false;
  if (writtenRows !== kept.length) {
    truncated = true;
    props.setProperty('velSheetCorrupted', 'clearfrom-incomplete:' + writtenRows + '/' + kept.length);
  } else {
    props.deleteProperty('velSheetCorrupted');
  }
  Logger.log('velClearFrom ' + from + ': ' + data.length + ' → ' + kept.length + ' rows (' + removed + ' removed)');
  return { ok: true, from, before: data.length, after: kept.length, removed, writtenRows, truncated };
}

function resetVelSyncDate() {
  PropertiesService.getScriptProperties().deleteProperty('velSyncDate');
  return { ok: true, message: 'velSyncDate cleared — next velsync will backfill 90 days.' };
}

// Targeted re-sync: temporarily sets velSyncDate to `from`, runs syncVelocityCache
// (up to 8×14-day chunks), then returns. Reliable alternative to the trigger chain
// for filling specific date-range gaps. velSyncDate ends up at wherever the sync reached.
// Usage: ?action=velresyncfrom&from=2026-04-17
function velResyncFrom(params) {
  const from = params.from;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return { ok: false, error: 'Provide from=YYYY-MM-DD' };
  }
  const props = PropertiesService.getScriptProperties();
  const prevSyncDate = props.getProperty('velSyncDate');
  // Temporarily set velSyncDate to the requested start date
  props.setProperty('velSyncDate', new Date(from + 'T00:00:00Z').toISOString());
  try {
    const result = syncVelocityCache();
    return { ok: true, from, prevSyncDate, newSyncDate: props.getProperty('velSyncDate'), ...result };
  } catch(e) {
    // Restore previous sync date on error so we don't lose progress
    if (prevSyncDate) props.setProperty('velSyncDate', prevSyncDate);
    else props.deleteProperty('velSyncDate');
    return { ok: false, error: e.message, from };
  }
}

// ─── TRIGGER SETUP ────────────────────────────────────────────────────────────
// Run this once manually from the Apps Script editor to install the hourly trigger.
function getTriggerStatus() {
  const triggers = ScriptApp.getProjectTriggers();
  const now = new Date();
  return {
    totalTriggers: triggers.length,
    triggers: triggers.map(t => ({
      handler:      t.getHandlerFunction(),
      type:         t.getEventType().toString(),
      triggerSource: t.getTriggerSource().toString(),
      uniqueId:     t.getUniqueId(),
    })),
    velSyncDate: PropertiesService.getScriptProperties().getProperty('velSyncDate') || 'not set',
    checkedAt:   now.toISOString(),
  };
}

// Phase C: local velocity sync retired — the hourly syncVelocityCache trigger was deleted and the
// installer removed (velocity is owned by GX Core's shared cache). syncVelocityCache remains only as
// a manual tool (?action=velsync) to refresh the local buildVelocityMap fallback if ever needed.

// ─── QUARANTINE / SAMPLE VIEWER ───────────────────────────────────────────────
// Returns items currently in quarantine or sample rooms across one or all stores.
function getQuarantine(params) {
  const filterStore = params.store && params.store !== 'All' ? params.store : null;
  const targetStores = filterStore ? [filterStore] : STORES;
  const results = [];

  for (const store of targetStores) {
    if (!isKnownStore(store)) continue;
    const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };
    const invRoomMap = buildInventoryRoomMap(store);

    const [invResp] = UrlFetchApp.fetchAll([
      { url: DUTCHIE_BASE + '/reporting/inventory', headers: hdrs, muteHttpExceptions: true },
    ]);
    if (invResp.getResponseCode() !== 200) continue;

    const raw   = JSON.parse(invResp.getContentText());
    const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);

    for (const item of items) {
      const qty = Number(item.quantityAvailable || 0);
      if (qty <= 0) continue;
      const roomType = invRoomMap[item.inventoryId];
      if (roomType !== 'quarantine') continue;
      results.push({
        store,
        name:     (item.productName || 'Unknown').trim(),
        category: item.masterCategory || item.category || 'Other',
        brand:    item.brandName || '',
        sku:      item.sku || '',
        room:     item.roomName || '(quarantine)',
        qty,
      });
    }
  }

  results.sort((a, b) => a.store.localeCompare(b.store) || a.name.localeCompare(b.name));
  return results;
}

// Read the persistent Product SKU Dict sheet → { productName: sku }
// This sheet is populated by snapshotInventory and never purged, so it covers
// products that have since gone OOS and been archived by Dutchie.
function buildNameSkuFromSnapshot() {
  const nameToSku = {};
  try {
    const ss    = SpreadsheetApp.openById(getInvDataSpreadsheetId());
    const sheet = ss.getSheetByName(SKU_DICT_SHEET_NAME);
    if (!sheet) return nameToSku;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return nameToSku;
    // Cols: productName(1) sku(2)
    const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (const row of data) {
      const name = String(row[0] || '').trim();
      const sku  = String(row[1] || '').trim();
      if (name && sku) nameToSku[name] = sku;
    }
  } catch(e) {
    Logger.log('buildNameSkuFromSnapshot error: ' + e.message);
  }
  return nameToSku;
}

// Update the persistent SKU dictionary with any new name→sku pairs from this snapshot run.
function updateSkuDict(ss, products) {
  let sheet = ss.getSheetByName(SKU_DICT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SKU_DICT_SHEET_NAME);
    sheet.getRange(1, 1, 1, 2).setValues([['productName', 'sku']]);
    sheet.setFrozenRows(1);
  }
  // Load existing entries
  const lastRow = sheet.getLastRow();
  const existing = new Set();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(r => {
      const n = String(r[0] || '').trim();
      if (n) existing.add(n);
    });
  }
  // Append any new name→sku pairs not already in the dict
  const newRows = [];
  for (const p of products) {
    if (p.name && p.sku && !existing.has(p.name)) {
      newRows.push([p.name, p.sku]);
      existing.add(p.name); // prevent dupes within this batch
    }
  }
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 2).setValues(newRows);
  }
}

// Velocity API endpoint — returns velocity map (or filtered to one store)
function getVelocityEndpoint(params) {
  // Phase C: velocity is sourced live from GX Core's shared cache (auto-refreshed ~6h). velSyncDate
  // is the RETIRED local sync's high-water mark — kept only as a stable cache-invalidation key, NOT a
  // freshness signal (the frontend reads velSource to label the indicator).
  const lastSynced = PropertiesService.getScriptProperties().getProperty('velSyncDate') || null;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'velmap_v4'; // bumped: drop cached maps that had numeric SKUs before stringify fix
  const cached = params.force === '1' ? null : _readChunkedJsonCache(cache, cacheKey);
  let payload = cached && cached.lastSynced === lastSynced ? cached : null;

  if (!payload) {
    const velMap    = getVelocityMap();
    const nameToSku = buildNameSkuFromSnapshot();
    // Attach snapshot-sourced SKUs to velocity entries
    for (const store of Object.keys(velMap)) {
      for (const name of Object.keys(velMap[store])) {
        if (!velMap[store][name].sku && nameToSku[name]) {
          velMap[store][name].sku = nameToSku[name];
        }
      }
    }
    payload = { stores: velMap, lastSynced, velSource: 'gxcore' };
    _putChunkedJsonCache(cache, cacheKey, payload, OPERATIONAL_CACHE_TTL);
  }

  if (params.store && params.store !== 'all') {
    // hasOwnProperty, not a bare index: params.store is user input, and payload.stores is a plain
    // object, so store='toString' would otherwise hand back an inherited function as 'products'.
    const own = Object.prototype.hasOwnProperty.call(payload.stores || {}, params.store);
    return { store: params.store, products: own ? payload.stores[params.store] : {}, lastSynced, velSource: payload.velSource || 'gxcore' };
  }
  return payload;
}

// Diagnostic: scan the sales history sheet for date coverage and gaps
function getSalesHistoryDiagnostics() {
  const ss = SpreadsheetApp.openById(SALES_HISTORY_SPREADSHEET_ID);
  const sheets = ss.getSheets();
  let sheet = null;
  for (const s of sheets) {
    if (s.getSheetId() === SALES_HISTORY_GID) { sheet = s; break; }
  }
  if (!sheet) return { error: 'Sheet not found' };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'No data' };

  // Read only date column (col 2) and product name column (col 3)
  const dates    = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const products = sheet.getRange(2, 3, lastRow - 1, 1).getValues();

  const dayCounts = {};  // YYYY-MM-DD → row count
  let minTs = Infinity, maxTs = -Infinity;
  let judasRows = 0;

  for (let i = 0; i < dates.length; i++) {
    const d = parseSaleDate(dates[i][0]);
    if (!d) continue;
    const key = d.toISOString().slice(0, 10);
    dayCounts[key] = (dayCounts[key] || 0) + 1;
    if (d.getTime() < minTs) minTs = d.getTime();
    if (d.getTime() > maxTs) maxTs = d.getTime();
    if (String(products[i][0]).toLowerCase().includes('judas')) judasRows++;
  }

  // Find gaps > 1 day
  const sortedDays = Object.keys(dayCounts).sort();
  const gaps = [];
  for (let i = 1; i < sortedDays.length; i++) {
    const prev = new Date(sortedDays[i - 1]);
    const curr = new Date(sortedDays[i]);
    const diff = Math.round((curr - prev) / 86400000);
    if (diff > 1) gaps.push({ from: sortedDays[i - 1], to: sortedDays[i], days: diff - 1 });
  }

  // Monthly row counts
  const monthlyCounts = {};
  for (const [day, cnt] of Object.entries(dayCounts)) {
    const month = day.slice(0, 7);
    monthlyCounts[month] = (monthlyCounts[month] || 0) + cnt;
  }

  return {
    totalRows:    lastRow - 1,
    firstDate:    minTs === Infinity ? null : new Date(minTs).toISOString().slice(0, 10),
    lastDate:     maxTs === -Infinity ? null : new Date(maxTs).toISOString().slice(0, 10),
    uniqueDays:   sortedDays.length,
    gaps,
    monthlyCounts,
    judasRows,
  };
}

// ─── ROOMS (Dutchie /room/rooms endpoint) ─────────────────────────────────────
function getRooms(params) {
  const store = params.store || 'Bend';
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  // Get rooms list
  const roomsResp = UrlFetchApp.fetch(DUTCHIE_BASE + '/room/rooms', { headers: hdrs, muteHttpExceptions: true });
  if (roomsResp.getResponseCode() !== 200) return { error: 'HTTP ' + roomsResp.getResponseCode() };
  const rooms = JSON.parse(roomsResp.getContentText());

  // Probe room-inventory endpoints using first room's ID
  const firstRoom = rooms[0];
  const probes = {};
  const roomId = firstRoom.roomId;
  const globalId = firstRoom.globalRoomId;
  const candidates = [
    `/room/${roomId}/inventory`,
    `/room/${roomId}/packages`,
    `/room/rooms/${roomId}/inventory`,
    `/room/rooms/${roomId}/packages`,
    `/reporting/inventory?roomId=${roomId}`,
    `/reporting/inventory?room=${roomId}`,
    `/reporting/inventory?globalRoomId=${globalId}`,
  ];
  for (const ep of candidates) {
    const r = UrlFetchApp.fetch(DUTCHIE_BASE + ep, { headers: hdrs, muteHttpExceptions: true });
    const code = r.getResponseCode();
    if (code === 200) {
      const body = JSON.parse(r.getContentText());
      const items = Array.isArray(body) ? body : (body.data || body.items || []);
      probes[ep] = { status: 200, count: items.length, sample: items[0] || null };
    } else {
      probes[ep] = { status: code };
    }
  }

  return { store, rooms, probes };
}

// ─── SKU ROOM PROBE (diagnostic) ──────────────────────────────────────────────
// Tests whether roomId filter affects per-item quantities for a given SKU.
// Usage: ?action=skuprobe&store=Bend&sku=350E284EBE
function skuRoomProbe(params) {
  const store = params.store || 'Bend';
  const sku   = (params.sku || '').toUpperCase();
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  // Get rooms first
  const roomsResp = UrlFetchApp.fetch(DUTCHIE_BASE + '/room/rooms', { headers: hdrs, muteHttpExceptions: true });
  if (roomsResp.getResponseCode() !== 200) return { error: 'rooms HTTP ' + roomsResp.getResponseCode() };
  const rooms = JSON.parse(roomsResp.getContentText());

  // Fetch inventory for each room in parallel
  const requests = [
    { url: DUTCHIE_BASE + '/reporting/inventory', headers: hdrs, muteHttpExceptions: true },
    ...rooms.map(r => ({ url: DUTCHIE_BASE + '/reporting/inventory?roomId=' + r.roomId, headers: hdrs, muteHttpExceptions: true })),
  ];
  const responses = UrlFetchApp.fetchAll(requests);

  const results = {};
  const labels  = ['unfiltered', ...rooms.map(r => (r.roomName || r.name || '?') + ' (' + r.roomId + ')')];
  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i];
    if (resp.getResponseCode() !== 200) { results[labels[i]] = { error: resp.getResponseCode() }; continue; }
    const raw   = JSON.parse(resp.getContentText());
    const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
    const matched = sku
      ? items.filter(it => (it.sku || '').toUpperCase() === sku)
      : items.slice(0, 3);
    results[labels[i]] = {
      totalItems: items.length,
      // Return full item object for matched SKUs so we can see every field
      skuMatches: matched.map(it => it),
    };
  }
  return { store, sku, rooms: rooms.map(r => ({ name: r.roomName || r.name || '(unnamed)', roomId: r.roomId, isSalesFloor: r.isSalesFloor, isQuarantineRoom: r.isQuarantineRoom, allKeys: Object.keys(r) })), results };
}

// ─── TRANSACTION PROBE (diagnostic) ──────────────────────────────────────────
// Fetches a sample of inventory transactions to understand fromRoom/toRoom structure
// and test date/type filter params. Usage: ?action=txprobe&store=Bend&sku=350E284EBE
function txProbe(params) {
  const store = params.store || 'Bend';
  const sku   = (params.sku || '').toUpperCase();
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  // Test inventoryId-specific filtering (what Dutchie's Package History UI uses)
  // Also test startDate filter which we confirmed works.
  const invId = params.inventoryId || '';
  const date90  = new Date(Date.now() - 90  * 86400000).toISOString().slice(0, 10);
  const date150 = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10);
  const variants = [
    '/inventory/inventorytransaction',
    '/inventory/inventorytransaction?startDate=' + date90,
    '/inventory/inventorytransaction?startDate=' + date150,
    ...(invId ? [
      '/inventory/inventorytransaction?inventoryId=' + invId,
      '/inventory/inventorytransaction?packageId=' + invId,
      '/inventory/packagehistory?inventoryId=' + invId,
    ] : []),
  ];
  const responses = UrlFetchApp.fetchAll(
    variants.map(ep => ({ url: DUTCHIE_BASE + ep, headers: hdrs, muteHttpExceptions: true }))
  );

  const results = {};
  for (let i = 0; i < variants.length; i++) {
    const r = responses[i];
    const code = r.getResponseCode();
    if (code === 200) {
      const raw = JSON.parse(r.getContentText());
      const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
      // Find SKU matches if provided, otherwise take first 3
      const sample = sku
        ? items.filter(t => (t.sku || '').toUpperCase() === sku).slice(0, 5)
        : items.slice(0, 3);
      results[variants[i]] = { count: items.length, sample };
    } else {
      results[variants[i]] = { status: code };
    }
  }
  return { store, sku, results };
}

// ─── SKU SALES SEARCH ────────────────────────────────────────────────────────
// Searches all transactions in a date window for a specific SKU
// Usage: ?action=skusales&store=River Rd&sku=89103871&days=60
function skuSalesSearch(params) {
  const store = params.store || 'River Rd';
  const sku   = (params.sku || '').trim();
  const days  = parseInt(params.days || '60');
  if (!sku) return { error: 'sku param required' };

  const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const to   = new Date().toISOString();
  const url  = DUTCHIE_BASE + '/reporting/transactions'
    + '?FromDateUTC=' + encodeURIComponent(from)
    + '&ToDateUTC='   + encodeURIComponent(to)
    + '&IncludeDetail=true';

  const resp = UrlFetchApp.fetch(url, { headers: hdrs, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { error: resp.getResponseCode() };
  const raw  = JSON.parse(resp.getContentText());
  const txns = Array.isArray(raw) ? raw : (raw.data || raw.items || []);

  // Build productId → sku map from all stores so we can match by productId
  const prodDict = buildProductIdDict();
  const skuToId  = {};
  for (const [pid, info] of Object.entries(prodDict)) {
    if (info.sku === sku) skuToId[pid] = info;
  }
  const targetIds = Object.keys(skuToId);

  const matches = [];
  const itemKeySample = [];
  for (const tx of txns) {
    if (!Array.isArray(tx.items)) continue;
    for (const item of tx.items) {
      if (itemKeySample.length === 0) itemKeySample.push(...Object.keys(item));
      const skuMatch  = (item.sku || '').toString().trim() === sku;
      const pidMatch  = targetIds.includes(String(item.productId || ''));
      const nameMatch = skuToId[item.productId] !== undefined;
      if (skuMatch || pidMatch || nameMatch) {
        matches.push({
          date:            (tx.transactionDateLocalTime || tx.transactionDate || '').slice(0, 10),
          transactionType: tx.transactionType,
          isVoid:          tx.isVoid,
          isReturn:        tx.isReturn,
          qty:             item.quantity,
          productName:     item.productName || item.name,
          productId:       item.productId,
          itemSku:         item.sku,
          matchedBy:       skuMatch ? 'sku' : pidMatch ? 'productId' : 'dict',
        });
      }
    }
  }
  return { store, sku, days, totalTxns: txns.length, targetProductIds: targetIds, matchCount: matches.length, matches, itemKeySample };
}

// ─── SALES TRANSACTION PROBE (diagnostic) ────────────────────────────────────
// Hits /reporting/transactions with IncludeDetail=true to inspect response shape.
// Usage: ?action=salestxprobe&store=River Rd&days=7
function salesTxProbe(params) {
  const store = params.store || 'River Rd';
  const days  = parseInt(params.days || '7');
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  const from = new Date(Date.now() - days * 86400000).toISOString();
  const to   = new Date().toISOString();

  const url = DUTCHIE_BASE + '/reporting/transactions'
    + '?FromDateUTC=' + encodeURIComponent(from)
    + '&ToDateUTC='   + encodeURIComponent(to)
    + '&IncludeDetail=true';

  const resp = UrlFetchApp.fetch(url, { headers: hdrs, muteHttpExceptions: true });
  const code = resp.getResponseCode();
  const text = resp.getContentText();

  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { parsed = { parseError: e.message, raw: text.slice(0, 2000) }; }

  // If it's an array, return the first 2 items so we can see full shape without flooding
  const sample = Array.isArray(parsed)
    ? { count: parsed.length, first2: parsed.slice(0, 2) }
    : (parsed && Array.isArray(parsed.data))
      ? { count: parsed.data.length, first2: parsed.data.slice(0, 2), meta: { ...parsed, data: '(truncated)' } }
      : parsed;

  return { store, days, url, httpStatus: code, sample };
}

// ─── TRANSACTION TYPE PROBE ──────────────────────────────────────────────────
// Usage: ?action=txtypeprobe&store=River Rd&days=14
function txTypeProbe(params) {
  const store = params.store || 'River Rd';
  const days  = parseInt(params.days || '14');
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const from  = new Date(Date.now() - days * 86400000).toISOString();
  const to    = new Date().toISOString();
  const url   = DUTCHIE_BASE + '/reporting/transactions'
    + '?FromDateUTC=' + encodeURIComponent(from)
    + '&ToDateUTC='   + encodeURIComponent(to)
    + '&IncludeDetail=true';
  const resp = UrlFetchApp.fetch(url, { headers: hdrs, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { error: resp.getResponseCode() };
  const raw  = JSON.parse(resp.getContentText());
  const txns = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  const typeCounts = {};
  const typeKeys = new Set();
  for (const tx of txns) {
    // Collect every top-level key that might indicate type
    ['transactionType','saleType','type','isTransfer','channel','source'].forEach(k => {
      if (k in tx) typeKeys.add(k);
    });
    const t = tx.transactionType || tx.saleType || tx.type || 'unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  return { store, days, total: txns.length, typeCounts, typeKeysFound: [...typeKeys], sampleKeys: txns.length ? Object.keys(txns[0]) : [] };
}

// ─── INVENTORY FIELD PROBE ────────────────────────────────────────────────────
// Dumps all keys + sample values from the first inventory item to find productId
// Usage: ?action=invfieldprobe&store=River Rd
function returnProbe(params) {
  const store = params.store || 'Hillsboro';
  const days  = parseInt(params.days || '7');
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const from  = new Date(Date.now() - days * 86400000).toISOString();
  const to    = new Date().toISOString();
  const url   = DUTCHIE_BASE + '/reporting/transactions?FromDateUTC=' + encodeURIComponent(from) + '&ToDateUTC=' + encodeURIComponent(to) + '&IncludeDetail=true';
  const resp  = UrlFetchApp.fetch(url, { headers: hdrs, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { http: resp.getResponseCode(), body: resp.getContentText().slice(0,300) };
  const txns  = JSON.parse(resp.getContentText());
  const arr   = Array.isArray(txns) ? txns : (txns.data || txns.items || []);
  const returnedItems = [];
  for (const tx of arr) {
    if (!Array.isArray(tx.items)) continue;
    for (const item of tx.items) {
      if (item.isReturned) {
        returnedItems.push({ txId: tx.transactionId, txType: tx.transactionType, isReturn: tx.isReturn, date: tx.transactionDateLocalTime, inventoryId: item.inventoryId, packageId: item.packageId, productId: item.productId, qty: item.quantity, isReturned: item.isReturned });
      }
    }
  }
  return { store, days, totalTxns: arr.length, returnedItemCount: returnedItems.length, returnedItems: returnedItems.slice(0, 20) };
}

function retiredProbe(params) {
  const store = params.store || 'River Rd';
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const resp  = UrlFetchApp.fetch(DUTCHIE_BASE + '/reporting/inventory', { headers: hdrs, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { error: resp.getResponseCode() };
  const raw   = JSON.parse(resp.getContentText());
  const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  // Find all keys that contain retire/discontinue/inactive/archive/active across all items
  const keywords = ['retire', 'discontinu', 'inactive', 'archiv', 'active', 'status', 'enabled', 'visible'];
  const matchingKeys = new Set();
  for (const item of items) {
    for (const k of Object.keys(item)) {
      if (keywords.some(kw => k.toLowerCase().includes(kw))) matchingKeys.add(k);
    }
  }
  // Sample values for each matching key
  const samples = {};
  for (const k of matchingKeys) {
    const vals = [...new Set(items.slice(0, 200).map(i => i[k]).filter(v => v !== undefined))];
    samples[k] = vals.slice(0, 10);
  }
  // Also check all keys on first item
  const allKeys = Object.keys(items[0] || {});
  return { store, totalItems: items.length, matchingKeys: [...matchingKeys], samples, allKeys };
}

function invFieldProbe(params) {
  const store = params.store || 'River Rd';
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const resp  = UrlFetchApp.fetch(DUTCHIE_BASE + '/reporting/inventory', { headers: hdrs, muteHttpExceptions: true });
  const code  = resp.getResponseCode();
  if (code !== 200) return { httpStatus: code, error: resp.getContentText().slice(0, 500) };
  const raw   = JSON.parse(resp.getContentText());
  let items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  if (!items.length) return { httpStatus: code, error: 'empty response' };
  // Optional ?sku=… — filter to one SKU to inspect its raw price fields (unitPrice vs any rec/med price).
  const sku = String(params.sku || '').trim();
  if (sku) {
    const match = items.filter(i => String(i.sku) === sku);
    if (!match.length) return { store, httpStatus: code, sku, matched: 0, totalItems: items.length, error: 'sku not found at ' + store + ' — try a different store' };
    items = match;
  }
  // Return first (matched) item in full + a list of all keys with their value types. Also surface any
  // price-ish fields explicitly so the raw unitPrice vs rec/med price question is answerable at a glance.
  const first = items[0];
  const fields = Object.entries(first).map(([k, v]) => ({ key: k, type: typeof v, sample: JSON.stringify(v).slice(0, 80) }));
  const priceFields = Object.entries(first)
    .filter(([k]) => /price|cost|msrp|tax|rec|med/i.test(k))
    .reduce((o, [k, v]) => { o[k] = v; return o; }, {});
  return { store, sku: sku || null, httpStatus: code, totalItems: items.length, matched: items.length, priceFields, fields, firstItem: first };
}

// Probe /inventory/labresults (lab results by batch) to find the harvest-date field for the FATTY joint
// tracker. ?batchId=… filters to one batch; returns the matched record in full + a keys/types list.
function labResultsProbe(params) {
  const store = params.store || 'River Rd';
  const batchId = String(params.batchId || '').trim();
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  // "Lab results by batch" — try batchId as a query param (several likely names) since a bare call is empty.
  const qp = batchId ? ('?' + (params.qp || 'batchId') + '=' + encodeURIComponent(batchId)) : '';
  const url   = DUTCHIE_BASE + '/inventory/labresults' + qp;
  const resp  = UrlFetchApp.fetch(url, { headers: hdrs, muteHttpExceptions: true });
  const code  = resp.getResponseCode();
  const body  = resp.getContentText();
  if (code !== 200) return { httpStatus: code, url: url.replace(DUTCHIE_BASE, ''), error: body.slice(0, 500) };
  let raw; try { raw = JSON.parse(body); } catch (e) { return { httpStatus: code, url: url.replace(DUTCHIE_BASE, ''), parseError: true, bodySample: body.slice(0, 300) }; }
  let recs = Array.isArray(raw) ? raw : (raw.data || raw.items || raw.labResults || raw.results || []);
  if (!recs.length) return { store, httpStatus: code, url: url.replace(DUTCHIE_BASE, ''), empty: true, totalRecords: 0, rawType: (Array.isArray(raw) ? 'array' : typeof raw), rawKeys: (raw && typeof raw === 'object' && !Array.isArray(raw)) ? Object.keys(raw) : null, bodySample: body.slice(0, 400) };
  if (batchId) {
    const match = recs.filter(r => String(r.batchId) === batchId || String(r.batchName) === batchId);
    if (match.length) recs = match;
  }
  const first = recs[0];
  const fields = Object.entries(first).map(([k, v]) => ({ key: k, type: typeof v, sample: JSON.stringify(v).slice(0, 80) }));
  const dateFields = Object.entries(first)
    .filter(([k]) => /date|harvest|packag|cultivat|sample|tested/i.test(k))
    .reduce((o, [k, v]) => { o[k] = v; return o; }, {});
  return { store, batchId: batchId || null, httpStatus: code, totalRecords: recs.length, dateFields, fields, firstRecord: first };
}

// ─── FATTY joint tracker ──────────────────────────────────────────────────────
// Tracks FATTY (infused pre-roll) inventory by HARVEST-YEAR vintage. Harvest date isn't in
// /reporting/inventory — it lives in /inventory/labresults (field HarvestDate), keyed by the package's
// batchName (Metrc tag). We resolve harvest per batch (cached permanently — it never changes), bucket
// current on-hand per store × vintage from RAW inventory (per-package, so mixed-batch products split
// correctly), and reconstruct weekly history from the Inv Snapshot via a sku→vintage map.
const HARVEST_BY_BATCH_KEY = 'gc_harvest_by_batch';
const FATTY_TRACKER_CACHE  = 'fatty_tracker_v1';

function _getHarvestMap() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(HARVEST_BY_BATCH_KEY) || '{}'); }
  catch (e) { return {}; }
}
// Resolve HarvestDate (YYYY-MM-DD) for batchNames at a store. Fetches uncached via /inventory/labresults
// (chunked fetchAll, rate-limit friendly) and caches only FOUND dates permanently (so a batch that gets a
// harvest date entered later still resolves on a future run).
function resolveHarvestDates_(store, batchNames) {
  const map = _getHarvestMap();
  const missing = batchNames.filter(function (b) { return b && !map[b]; });
  if (missing.length) {
    const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };
    var found = false;
    for (var i = 0; i < missing.length; i += 25) {
      const chunk = missing.slice(i, i + 25);
      const reqs = chunk.map(function (b) {
        return { url: DUTCHIE_BASE + '/inventory/labresults?batchName=' + encodeURIComponent(b), headers: hdrs, muteHttpExceptions: true };
      });
      const resps = UrlFetchApp.fetchAll(reqs);
      resps.forEach(function (r, j) {
        try {
          if (r.getResponseCode() === 200) {
            const arr = JSON.parse(r.getContentText());
            const hd = arr && arr[0] && arr[0].HarvestDate;
            if (hd) { map[chunk[j]] = String(hd).slice(0, 10); found = true; }
          }
        } catch (e) {}
      });
    }
    if (found) PropertiesService.getScriptProperties().setProperty(HARVEST_BY_BATCH_KEY, JSON.stringify(map));
  }
  return map;
}

function isoWeekStart_(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Weekly on-hand history for FATTY by store × vintage, from the Inv Snapshot. For each (store, week) we take
// the LATEST snapshot date in that week (point-in-time on-hand, not a sum of days). skuVintage maps sku→year.
function buildFattyWeekly_(skuVintage) {
  const out = { weeks: [], byStore: {} };
  try {
    const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
    const sheet = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return out;
    const width = Math.max(9, sheet.getLastColumn());
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
    const byKeyDate = {}; // store|week|date -> {vintage -> qty}
    for (var r = 0; r < data.length; r++) {
      const row = data[r];
      const name = String(row[2] || '');
      if (!/fatty/i.test(name)) continue;
      const sku = String(row[5] || '').trim();
      const v = skuVintage[sku];
      if (!v) continue;
      const store = String(row[1] || '').trim();
      const dateRaw = row[0];
      const dateStr = dateRaw instanceof Date ? dateRaw.toISOString().slice(0, 10) : String(dateRaw).slice(0, 10);
      const week = isoWeekStart_(dateStr);
      const k = store + '|' + week + '|' + dateStr;
      (byKeyDate[k] || (byKeyDate[k] = {}))[v] = (byKeyDate[k][v] || 0) + (Number(row[6] || 0) || 0);
    }
    const latestDate = {}; // store|week -> dateStr
    Object.keys(byKeyDate).forEach(function (k) {
      const parts = k.split('|'), sw = parts[0] + '|' + parts[1], date = parts[2];
      if (!latestDate[sw] || date > latestDate[sw]) latestDate[sw] = date;
    });
    const weeksSet = {};
    Object.keys(latestDate).forEach(function (sw) {
      const parts = sw.split('|'), store = parts[0], week = parts[1];
      weeksSet[week] = true;
      out.byStore[store] = out.byStore[store] || {};
      out.byStore[store][week] = byKeyDate[sw + '|' + latestDate[sw]] || {};
    });
    out.weeks = Object.keys(weeksSet).sort();
  } catch (e) { _logGasError('buildFattyWeekly_', e && e.message); }
  return out;
}

function buildFattyTracker_(force) {
  const scriptCache = CacheService.getScriptCache();
  if (!force) { const c = scriptCache.get(FATTY_TRACKER_CACHE); if (c) { try { return JSON.parse(c); } catch (e) {} } }
  const stores = STORES.slice();
  const reqs = stores.map(function (s) {
    return { url: DUTCHIE_BASE + '/reporting/inventory', headers: { Authorization: dutchieAuth(s), Accept: 'application/json' }, muteHttpExceptions: true };
  });
  const resps = UrlFetchApp.fetchAll(reqs);
  const skuVintage = {};            // sku -> 'YYYY'
  const current = {};               // store -> { vintage -> qty }
  const vintagesSet = {};
  var unresolved = 0;
  stores.forEach(function (store, i) {
    var items = [];
    try { if (resps[i].getResponseCode() === 200) { const raw = JSON.parse(resps[i].getContentText()); items = Array.isArray(raw) ? raw : (raw.data || raw.items || []); } } catch (e) {}
    const fatties = items.filter(function (it) { return /fatty/i.test(String(it.productName || it.name || '')); });
    const batchNames = [];
    const seenB = {};
    fatties.forEach(function (it) { const b = String(it.batchName || ''); if (b && !seenB[b]) { seenB[b] = 1; batchNames.push(b); } });
    const hmap = resolveHarvestDates_(store, batchNames);
    current[store] = {};
    fatties.forEach(function (it) {
      const qty = Number(it.quantityAvailable || it.quantity || 0) || 0;
      if (qty <= 0) return;
      const hd = hmap[String(it.batchName || '')] || '';
      const vintage = hd ? hd.slice(0, 4) : 'Unknown';
      if (vintage === 'Unknown') unresolved += qty;
      current[store][vintage] = (current[store][vintage] || 0) + qty;
      vintagesSet[vintage] = true;
      const sku = String(it.sku || '').trim();
      if (sku && hd) skuVintage[sku] = vintage;
    });
  });
  const weekly = buildFattyWeekly_(skuVintage);
  const vintages = Object.keys(vintagesSet).filter(function (v) { return v !== 'Unknown'; }).sort();
  if (vintagesSet['Unknown']) vintages.push('Unknown');
  const result = { ok: true, generatedAt: new Date().toISOString(), stores: stores, vintages: vintages, current: current, weekly: weekly, unresolvedUnits: unresolved, skuMapped: Object.keys(skuVintage).length };
  try { scriptCache.put(FATTY_TRACKER_CACHE, JSON.stringify(result), 60 * 60); } catch (e) {}
  return result;
}

function getFattyTracker(params) {
  return buildFattyTracker_(params && params.force === '1');
}

// Fetch all inventory transactions for a specific inventoryId to debug room classification
function invTxLookup(params) {
  const store   = params.store       || 'River Rd';
  const invId   = params.inventoryId || params.invId || '1591266';
  const hdrs    = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  const date30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [byInvId, allTx, recent30] = UrlFetchApp.fetchAll([
    { url: DUTCHIE_BASE + '/inventory/inventorytransaction?inventoryId=' + invId,      headers: hdrs, muteHttpExceptions: true },
    { url: DUTCHIE_BASE + '/inventory/inventorytransaction',                            headers: hdrs, muteHttpExceptions: true },
    { url: DUTCHIE_BASE + '/inventory/inventorytransaction?startDate=' + date30,        headers: hdrs, muteHttpExceptions: true },
  ]);

  const parseFiltered = resp => {
    if (resp.getResponseCode() !== 200) return { http: resp.getResponseCode() };
    const raw = JSON.parse(resp.getContentText());
    const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
    return { http: 200, count: items.length, transactions: items.slice(0, 20).map(t => ({
      inventoryId: t.inventoryId, type: t.transactionType, toRoom: t.toRoom, fromRoom: t.fromRoom,
      date: t.transactionDate, by: t.transactionBy
    }))};
  };

  const parseAll = resp => {
    if (resp.getResponseCode() !== 200) return { http: resp.getResponseCode() };
    const raw = JSON.parse(resp.getContentText());
    const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
    const matching = items.filter(t => String(t.inventoryId) === String(invId));
    const withRoom = items.filter(t => t.toRoom).slice(0, 5);
    return {
      http: 200, totalAll: items.length, matchingInvId: matching.length,
      matchingTx: matching.map(t => ({ type: t.transactionType, toRoom: t.toRoom, fromRoom: t.fromRoom, date: t.transactionDate })),
      sampleWithToRoom: withRoom.map(t => ({ inventoryId: t.inventoryId, type: t.transactionType, toRoom: t.toRoom, date: t.transactionDate })),
    };
  };

  return { store, invId, byInvIdFilter: parseFiltered(byInvId), fromAllTx: parseAll(allTx), fromRecent30: parseAll(recent30) };
}

function invRoomsProbe(params) {
  const store = params.store || 'River Rd';
  const sku   = params.sku   || null;
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  // Compare /reporting/inventory vs /inventory?includeRoomQuantities=true
  const [repResp, invResp] = UrlFetchApp.fetchAll([
    { url: DUTCHIE_BASE + '/reporting/inventory',                            headers: hdrs, muteHttpExceptions: true },
    { url: DUTCHIE_BASE + '/inventory?includeRoomQuantities=true',           headers: hdrs, muteHttpExceptions: true },
  ]);

  const parse = resp => {
    if (resp.getResponseCode() !== 200) return { http: resp.getResponseCode(), error: resp.getContentText().slice(0,200) };
    const raw   = JSON.parse(resp.getContentText());
    const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
    const withRQ = items.filter(i => i.roomQuantities != null && (Array.isArray(i.roomQuantities) ? i.roomQuantities.length > 0 : true));
    const skuItems = sku ? items.filter(i => i.sku === sku) : [];
    return {
      http: resp.getResponseCode(),
      total: items.length,
      withRoomQuantities: withRQ.length,
      skuMatches: skuItems.map(i => ({ name: i.productName, inventoryId: i.inventoryId, qty: i.quantityAvailable, roomQuantities: i.roomQuantities, roomName: i.roomName, roomId: i.roomId })),
      sampleWithRQ: withRQ.slice(0, 2).map(i => ({ name: i.productName, inventoryId: i.inventoryId, qty: i.quantityAvailable, roomQuantities: i.roomQuantities })),
      fields: items.length > 0 ? Object.keys(items[0]) : [],
    };
  };

  return {
    store,
    sku: sku || '(none — showing all)',
    reporting_inventory:            parse(repResp),
    inventory_includeRoomQuantities: parse(invResp),
  };
}

function snapshotProbe(params) {
  const store = params.store || 'River Rd';
  const date  = params.date  || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const url   = DUTCHIE_BASE + '/inventory/snapshot?fromDate=' + date;
  const resp  = UrlFetchApp.fetch(url, { headers: hdrs, muteHttpExceptions: true });
  const code  = resp.getResponseCode();
  if (code !== 200) return { httpStatus: code, url, error: resp.getContentText().slice(0, 500) };
  const raw   = JSON.parse(resp.getContentText());
  const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  if (!items.length) return { httpStatus: code, url, error: 'empty response', totalItems: 0 };
  const first  = items[0];
  const fields = Object.entries(first).map(([k, v]) => ({ key: k, type: typeof v, sample: JSON.stringify(v).slice(0, 80) }));
  return { store, date, httpStatus: code, url, totalItems: items.length, fields, firstItem: first };
}

// ─── API EXPLORER (diagnostic) ────────────────────────────────────────────────
// Probes Dutchie API endpoints to find room/location fields
function exploreApi(params) {
  const store = params.store || 'Bend';
  const hdrs  = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const results = {};

  // 1. Dump all keys from first item of /reporting/inventory
  try {
    const r = UrlFetchApp.fetch(DUTCHIE_BASE + '/reporting/inventory', { headers: hdrs, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      const raw = JSON.parse(r.getContentText());
      const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
      if (items.length > 0) {
        results.inventoryFields = Object.keys(items[0]);
        results.inventorySample = items[0];
      }
    } else {
      results.inventoryError = r.getResponseCode() + ' ' + r.getContentText().slice(0, 200);
    }
  } catch(e) { results.inventoryError = e.message; }

  // 1b. Check roomQuantities population across first 200 items
  try {
    const r = UrlFetchApp.fetch(DUTCHIE_BASE + '/reporting/inventory', { headers: hdrs, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      const items = JSON.parse(r.getContentText());
      const arr = Array.isArray(items) ? items : (items.data || items.items || []);
      const withRoom = arr.slice(0, 200).filter(i => i.roomQuantities != null);
      results.roomQuantitiesSamples = withRoom.slice(0, 5).map(i => ({
        name: i.productName, roomQuantities: i.roomQuantities
      }));
      results.roomQuantitiesPopulated = withRoom.length + ' of ' + Math.min(arr.length, 200) + ' items';
    }
  } catch(e) { results.roomCheckError = e.message; }

  // 2. Probe candidate endpoints for package/room data
  const probeEndpoints = [
    // From Dutchie docs Inventory section
    '/inventory',
    '/inventory/inventorytransaction',
    '/inventory/labresults',
    '/inventory/receivedinventory',
    '/inventory/snapshot',
    // Variants with roomId param
    '/inventory?roomId=3829',
    '/inventory/snapshot?roomId=3829',
    // Other guesses
    '/inventory/room',
    '/reporting/inventory-rooms',
    '/reporting/inventory-reconcile',
    '/reporting/room-inventory',
    '/transfer',
    '/package',
  ];
  results.probes = {};
  for (const ep of probeEndpoints) {
    try {
      const r = UrlFetchApp.fetch(DUTCHIE_BASE + ep, { headers: hdrs, muteHttpExceptions: true });
      const code = r.getResponseCode();
      if (code === 200) {
        const body = JSON.parse(r.getContentText());
        const items = Array.isArray(body) ? body : (body.data || body.items || []);
        results.probes[ep] = { status: 200, itemCount: items.length, fields: items.length > 0 ? Object.keys(items[0]) : [] };
      } else {
        results.probes[ep] = { status: code };
      }
    } catch(e) { results.probes[ep] = { error: e.message }; }
  }

  return results;
}

// ─── LIVE INVENTORY + VELOCITY → DOH + REORDER ────────────────────────────────
// params.store = store name OR 'all'
function getLiveInventory(params) {
  const requestedStore = params.store || 'all';
  const targetStores   = requestedStore === 'all' ? STORES : [requestedStore];

  // Load velocity map once (one sheet read)
  const velMap = getVelocityMap();

  const allProducts = [];

  for (const store of targetStores) {
    if (!isKnownStore(store)) continue;

    let invResult;
    try {
      invResult = getInventory({ store });
    } catch (err) {
      allProducts.push({ store, error: err.message });
      continue;
    }
    if (invResult.error) {
      allProducts.push({ store, error: invResult.error });
      continue;
    }

    const storeVel = velMap[store] || {};

    for (const p of invResult.products) {
      const vel = storeVel[p.name] || {};
      const v14 = vel.vel14 || 0;
      const v30 = vel.vel30 || 0;
      const v7  = vel.vel7  || 0;

      // Primary velocity: prefer 14-day, fall back to 30-day, then 7-day
      const primaryVel = v14 > 0 ? v14 : (v30 > 0 ? v30 : v7);
      const velWindow  = v14 > 0 ? 14  : (v30 > 0 ? 30  : (v7 > 0 ? 7 : null));

      let doh    = null;
      let status = 'ok';

      if (p.qty === 0) {
        doh    = 0;
        status = 'oos';
      } else if (primaryVel > 0) {
        doh    = Math.round((p.qty / primaryVel) * 10) / 10;
        status = doh < DOH_CRITICAL_DAYS ? 'critical' : doh < DOH_LOW_DAYS ? 'low' : doh < DOH_WATCH_DAYS ? 'watch' : 'ok';
      } else {
        status = 'slow'; // has stock, no recent sales
      }

      // Reorder quantity: units needed to cover buffer period, minus what's on hand
      const reorderQty = (primaryVel > 0 && (p.qty === 0 || doh < REORDER_BUFFER))
        ? Math.max(0, Math.ceil(primaryVel * REORDER_BUFFER - p.qty))
        : 0;

      // Use brand/category from sales history if inventory API left them blank
      const brand    = p.brand    || vel.brand    || '';
      const category = p.category || vel.category || 'Other';

      allProducts.push({
        store,
        name:       p.name,
        sku:        p.sku,
        category,
        brand,
        vendor:     p.vendor,
        qty:        p.qty,
        value:      p.value,
        vel7:       v7,
        vel14:      v14,
        vel30:      v30,
        velWindow,
        doh,
        status,
        reorderQty,
      });
    }
  }

  // Sort: oos → critical → low → watch → ok → slow (then by DOH asc within group)
  const ORDER = { oos: 0, critical: 1, low: 2, watch: 3, ok: 4, slow: 5 };
  allProducts.sort((a, b) => {
    const od = (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9);
    if (od !== 0) return od;
    if (a.doh === null && b.doh === null) return a.name.localeCompare(b.name);
    if (a.doh === null) return 1;
    if (b.doh === null) return -1;
    return a.doh - b.doh;
  });

  return { products: allProducts, generatedAt: new Date().toISOString() };
}

// ─── OOS DATE MAP ─────────────────────────────────────────────────────────────
// Returns { "Store::sku": "YYYY-MM-DD" } where the date is the last day that
// store+sku appeared in the snapshot with qty > 0.  OOS date = that date + 1 day.
// Cached for 4 hours since the snapshot only updates nightly.
function getOOSMap() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'oosmap_v1';
  const cached = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }

  const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
  const sheet = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return {};

  // Columns: date(1), store(2), productName(3), brand(4), category(5), sku(6)
  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();

  const lastSeen = {}; // "store::sku" → "YYYY-MM-DD"
  for (const row of data) {
    const dateRaw = row[0], store = String(row[1] || '').trim();
    const name = String(row[2] || '').trim(), sku = String(row[5] || '').trim();
    if (!store || (!name && !sku)) continue;
    const dateStr = dateRaw instanceof Date
      ? dateRaw.toISOString().slice(0, 10)
      : String(dateRaw).slice(0, 10);
    const key = store + '::' + (sku || name);
    if (!lastSeen[key] || dateStr > lastSeen[key]) lastSeen[key] = dateStr;
  }

  try { cache.put(cacheKey, JSON.stringify(lastSeen), 4 * 3600); } catch(e) {}
  return lastSeen;
}

// ─── LEAFLINK OPEN ORDERS ─────────────────────────────────────────────────────
// Returns all non-complete/cancelled orders with their line items.
// Cached 30 min. Used by the frontend to show "on order" status and suppress
// redundant reorder badges.
function getLeafLinkOrders() {
  const cache  = CacheService.getScriptCache();
  const cKey   = 'll_orders_v1';
  const hit    = cache.get(cKey);
  if (hit) { try { return JSON.parse(hit); } catch(e) {} }

  const apiKey = PropertiesService.getScriptProperties().getProperty('LL_API_KEY');
  if (!apiKey) return { error: 'LL_API_KEY not configured — run setLeafLinkKey() in the script editor' };

  // Fetch 200 most recent orders and filter open ones client-side.
  // LL's status filter is lowercase and single-value only, so it's simpler
  // to pull recent and discard Complete/Cancelled.
  const url = 'https://app.leaflink.com/api/v2/buyer/orders/?limit=200&ordering=-created_on';
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'App ' + apiKey },
      muteHttpExceptions: true
    });
  } catch(e) {
    return { error: 'LL fetch failed: ' + e.message };
  }

  if (resp.getResponseCode() !== 200) {
    return { error: 'LL API ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200) };
  }

  const CLOSED = new Set(['cancelled', 'rejected', 'received']);
  const data   = JSON.parse(resp.getContentText());
  const allRaw = data.results || [];

  // Build a lookup of SGO-generated Complete orders (these are the parent combined orders).
  // Key: sellerId → array of { shortId, createdMs }
  // When child orders are combined, LL creates a new SGO order within seconds.
  const sgoComplete = {};
  for (const o of allRaw) {
    if ((o.status || '').toLowerCase() === 'complete' && o.source === 'SGO') {
      const sid = (o.seller || {}).id;
      if (!sid) continue;
      if (!sgoComplete[sid]) sgoComplete[sid] = [];
      sgoComplete[sid].push({ shortId: o.short_id, createdMs: new Date(o.created_on).getTime() });
    }
  }

  const orders = allRaw
    .filter(o => {
      const s = (o.status || '').toLowerCase();
      return s !== 'complete' && !CLOSED.has(s);
    })
    .map(o => {
      // For Combined child orders, find the SGO parent created within 2 min of this order
      // being last edited (that's when LL stamps the "Combined" status).
      let displayId = o.short_id || o.id;
      if ((o.status || '').toLowerCase() === 'combined') {
        const sid      = (o.seller || {}).id;
        const editedMs = new Date(o.last_edited_on || o.created_on).getTime();
        const parents  = sgoComplete[sid] || [];
        const parent   = parents.find(p => Math.abs(p.createdMs - editedMs) < 2 * 60 * 1000);
        if (parent) displayId = parent.shortId;
      }
      return {
        id:      displayId,
        status:  o.status,
        seller:  (o.seller || {}).name || '',
        created: (o.created_on || '').slice(0, 10),
        items:   (o.line_items || []).map(li => ({
          name:  (li.product || {}).name  || '',
          brand: ((li.product || {}).brand || {}).name || '',
          sku:   (li.product || {}).sku   || '',
          qty:   li.quantity || 0,
        }))
      };
    });

  try { cache.put(cKey, JSON.stringify(orders), 30 * 60); } catch(e) {}
  return orders;
}

// ─── NIGHTLY SNAPSHOT ─────────────────────────────────────────────────────────
// Called by time-based trigger. Appends one row per product per store to the
// Inv Snapshot sheet, then purges entries older than 90 days.
// Nightly inventory snapshot — the source of truth for OOS/last-seen/price history and (going forward)
// the substitution-model breadth signal. HARDENED so it never throws: an unhandled exception on a
// time-based trigger makes GAS silently auto-DISABLE it, which is what caused the multi-week snapshot
// gaps (Jul 2026). Every step is now wrapped, it self-heals its own trigger, it's idempotent per day
// (safe to run twice), and it prefers the already-warmed operational bundle over 6 live Dutchie calls
// (fewer external calls = fewer timeouts). Records health to SNAPSHOT_STATUS for monitoring.
function snapshotInventory() {
  const status = { startedAt: new Date().toISOString(), date: '', source: '', stores: {}, rowsWritten: 0, errors: [] };
  try {
    ensureSnapshotTrigger_(); // keep our own nightly trigger alive on every healthy run
    const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
    const sheet = getOrCreateSnapshotSheet(ss);
    const today = new Date().toISOString().slice(0, 10);
    status.date = today;

    // Idempotency: skip stores already captured today, so a second run (trigger + manual) can't dup rows.
    const doneToday = {};
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const tail = Math.min(lastRow - 1, 15000); // recent rows only — today's rows are always near the end
      const recent = sheet.getRange(lastRow - tail + 1, 1, tail, 2).getValues();
      for (const r of recent) {
        const d = r[0] instanceof Date ? r[0].toISOString().slice(0, 10) : String(r[0]).slice(0, 10);
        if (d === today) doneToday[String(r[1] || '').trim()] = true;
      }
    }

    // Prefer the warmed operational bundle (refreshed ~hourly) to avoid 6 live Dutchie calls; the fresh
    // bundle is in-stock products with the fields we need. Fall back to live getInventory per store.
    const bundleByStore = {};
    try {
      const bundle = readOperationalSnapshot_('inventory_bundle_v1');
      if (bundle && bundle.generatedAt && (Date.now() - Date.parse(bundle.generatedAt)) < 25 * 3600 * 1000 && bundle.inventory) {
        bundle.inventory.forEach(st => { if (st && st.store && st.products) bundleByStore[st.store] = st.products; });
      }
    } catch (e) { status.errors.push('bundle: ' + (e && e.message)); }
    status.source = Object.keys(bundleByStore).length ? 'bundle' : 'live';

    for (const store of STORES) {
      if (doneToday[store]) { status.stores[store] = 'already'; continue; }
      try {
        let products = bundleByStore[store];
        if (!products) {
          const inv = getInventory({ store });
          products = (inv && !inv.error && inv.products) ? inv.products : null;
        }
        if (!products) { status.stores[store] = 'no data'; continue; }
        const inStock = products.filter(p => Number(p.qty) > 0);
        // Col 9 (unitPrice) banks the real last-known RETAIL price while in stock, so lost-sales revenue
        // can be computed once a product goes OOS.
        const rows = inStock.map(p => [today, store, p.name, p.brand, p.category, p.sku, p.qty,
          (p.value != null ? p.value : (Number(p.qty) || 0) * (Number(p.unitCost) || 0)), Number(p.unitPrice || 0)]);
        if (rows.length) { sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 9).setValues(rows); status.rowsWritten += rows.length; }
        status.stores[store] = rows.length;
        try { updateSkuDict(ss, products); } catch (e) { status.errors.push('skuDict ' + store + ': ' + (e && e.message)); }
      } catch (e) {
        status.stores[store] = 'error'; status.errors.push(store + ': ' + (e && e.message));
      }
    }
    try { purgeOldSnapshots(sheet); } catch (e) { status.errors.push('purge: ' + (e && e.message)); }
  } catch (e) {
    status.errors.push('fatal: ' + (e && e.message));
  }
  status.finishedAt = new Date().toISOString();
  try { PropertiesService.getScriptProperties().setProperty('SNAPSHOT_STATUS', JSON.stringify(status)); } catch (e) {}
  return status;
}

// Idempotent: (re)create the nightly snapshot trigger only if it's missing. Called from healthy snapshot
// runs AND from the warm triggers, so a snapshot trigger that GAS disables gets revived by an independent
// still-alive trigger within a day. Never throws.
function ensureSnapshotTrigger_() {
  try {
    const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'snapshotInventory');
    if (!has) ScriptApp.newTrigger('snapshotInventory').timeBased().everyDays(1).atHour(2).create();
    return has;
  } catch (e) { return false; }
}

// Snapshot pipeline health for monitoring (surfaced via getOperationalSnapshotStatus).
function snapshotHealth_() {
  const out = { triggerInstalled: false, lastRunDate: '', ageDays: null, source: '', rowsWritten: 0, errorCount: 0, finishedAt: '' };
  try { out.triggerInstalled = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'snapshotInventory'); } catch (e) {}
  try {
    const s = JSON.parse(PropertiesService.getScriptProperties().getProperty('SNAPSHOT_STATUS') || 'null');
    if (s) {
      out.lastRunDate = s.date || ''; out.source = s.source || ''; out.rowsWritten = s.rowsWritten || 0;
      out.errorCount = (s.errors || []).length; out.finishedAt = s.finishedAt || '';
      if (s.date) out.ageDays = Math.floor((Date.now() - Date.parse(s.date + 'T00:00:00Z')) / 86400000);
    }
  } catch (e) {}
  return out;
}

function getOrCreateSnapshotSheet(ss) {
  let sheet = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SNAPSHOT_SHEET_NAME);
    sheet.getRange(1, 1, 1, 9).setValues([[
      'date', 'store', 'productName', 'brand', 'category', 'sku', 'qty', 'value', 'unitPrice'
    ]]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < 9) {
    sheet.getRange(1, 9).setValue('unitPrice'); // label the newly-added price column on the pre-existing sheet
  }
  return sheet;
}

function purgeOldSnapshots(sheet) {
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let firstKeep = lastRow + 1;
  for (let i = 0; i < dates.length; i++) {
    if (String(dates[i][0]) >= cutoff) { firstKeep = i + 2; break; }
  }
  if (firstKeep > 2) {
    sheet.deleteRows(2, firstKeep - 2);
  }
}

// Run this ONCE manually from the Apps Script editor to install the nightly trigger.
function setupSnapshotTrigger() {
  // Remove any existing snapshot triggers to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'snapshotInventory')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('snapshotInventory')
    .timeBased()
    .everyDays(1)
    .atHour(2)  // 2 AM
    .create();

  Logger.log('Snapshot trigger created — will run nightly at 2 AM.');
}

function getOrCreateOperationalSnapshotSheet_() {
  const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
  let sheet = ss.getSheetByName(OPERATIONAL_SNAPSHOT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(OPERATIONAL_SNAPSHOT_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['key', 'generatedAt', 'chunkIndex', 'jsonChunk']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function writeOperationalSnapshot_(key, payload) {
  const sheet = getOrCreateOperationalSnapshotSheet_();
  const json = JSON.stringify(payload);
  const chunkSize = 45000; // keep safely under Google Sheets cell limits
  const generatedAt = payload.generatedAt || new Date().toISOString();
  const rows = [];
  for (let i = 0; i < json.length; i += chunkSize) {
    rows.push([key, generatedAt, rows.length, json.slice(i, i + chunkSize)]);
  }
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 4).setValues([['key', 'generatedAt', 'chunkIndex', 'jsonChunk']]);
  if (rows.length) sheet.getRange(2, 1, rows.length, 4).setValues(rows);
}

function readOperationalSnapshot_(key) {
  const sheet = getOrCreateOperationalSnapshotSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const rows = sheet.getRange(2, 1, lastRow - 1, 4).getValues()
    .filter(r => String(r[0] || '') === key)
    .sort((a, b) => Number(a[2] || 0) - Number(b[2] || 0));
  if (!rows.length) return null;
  try {
    const payload = JSON.parse(rows.map(r => String(r[3] || '')).join(''));
    payload.source = 'snapshot';
    return payload;
  } catch(e) {
    return null;
  }
}

function getOperationalSnapshotStatus() {
  const key = 'inventory_bundle_v1';
  const ss = SpreadsheetApp.openById(getInvDataSpreadsheetId());
  const sheet = ss.getSheetByName(OPERATIONAL_SNAPSHOT_SHEET_NAME);
  const triggers = ScriptApp.getProjectTriggers();
  const WARM_HANDLERS = ['warmOperationalCaches', 'warmVelocityOnly', 'warmBundleOnly', 'warmDecisionFeedOnly'];
  const warmTriggerInstalled = triggers.some(t => WARM_HANDLERS.includes(t.getHandlerFunction()));

  if (!sheet || sheet.getLastRow() < 2) {
    return {
      ok: true,
      ready: false,
      source: 'missing',
      generatedAt: '',
      chunkCount: 0,
      bytes: 0,
      warmTriggerInstalled,
      warmStatus: getOperationalWarmStatus_(),
      snapshotHealth: snapshotHealth_(),
      checkedAt: new Date().toISOString(),
    };
  }

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues()
    .filter(r => String(r[0] || '') === key);
  const bytes = rows.reduce((sum, r) => sum + String(r[3] || '').length, 0);
  return {
    ok: true,
    ready: rows.length > 0 && bytes > 0,
    source: rows.length ? 'snapshot' : 'missing',
    generatedAt: rows.length ? String(rows[0][1] || '') : '',
    chunkCount: rows.length,
    bytes,
    warmTriggerInstalled,
    warmStatus: getOperationalWarmStatus_(),
    snapshotHealth: snapshotHealth_(),
    checkedAt: new Date().toISOString(),
  };
}

function getOperationalWarmStatus_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(OPERATIONAL_WARM_STATUS_KEY) || '{}');
  } catch(e) {
    return {};
  }
}

function setOperationalWarmStatus_(status) {
  PropertiesService.getScriptProperties().setProperty(
    OPERATIONAL_WARM_STATUS_KEY,
    JSON.stringify(Object.assign({ updatedAt: new Date().toISOString() }, status || {}))
  );
}

function scheduleOperationalWarmRun() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === '_runOperationalWarmTrigger')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('_runOperationalWarmTrigger')
    .timeBased()
    .after(60 * 1000)
    .create();

  setOperationalWarmStatus_({
    state: 'scheduled',
    scheduledAt: new Date().toISOString(),
    message: 'Operational snapshot build scheduled.',
  });
  return { ok: true, scheduled: true, message: 'Operational snapshot build scheduled.' };
}

function _runOperationalWarmTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === '_runOperationalWarmTrigger')
    .forEach(t => ScriptApp.deleteTrigger(t));
  warmOperationalCaches();
}

function buildOperationalBundle_(force) {
  const generatedAt = new Date().toISOString();
  const velocity    = getVelocityEndpoint({ force: force ? '1' : '' });
  const inventory   = [];
  const errors      = [];

  // Fire all 6 store inventory requests in parallel — cuts serial ~9s HTTP wait to ~1.5s.
  // Each store gets its own auth header; responses are returned in the same order as STORES.
  const invRequests = STORES.map(store => ({
    url:     DUTCHIE_BASE + '/reporting/inventory',
    headers: { Authorization: dutchieAuth(store), Accept: 'application/json' },
    muteHttpExceptions: true,
  }));
  const invResponses = UrlFetchApp.fetchAll(invRequests);

  // Batch all stores' room data in one fetchAll round (cold-cache only).
  // Wrapped so a room-data failure degrades to per-store fetch inside getInventory
  // rather than aborting the whole bundle.
  let roomDataByStore = {};
  try {
    roomDataByStore = buildRoomDataBatch_(STORES);
  } catch (err) {
    errors.push('roomDataBatch: ' + err.message);
    _logGasError('buildRoomDataBatch_', err.message);
  }

  // GUARDRAIL (learned from Leaderboard's Dutchie hardening): a Dutchie glitch can make a store's inventory
  // fetch fail or come back empty. NEVER persist a partial bundle — that silently halves the app's totals
  // until someone manually refreshes. Instead, reuse that store's LAST-GOOD products from the previous
  // bundle so every store always has data, and flag it stale so the tripwire (warmBundleOnly) can alert.
  let prevByStore = {};
  try {
    const prev = readOperationalSnapshot_('inventory_bundle_v1');
    (prev && prev.inventory || []).forEach(st => { if (st && st.store) prevByStore[st.store] = st; });
  } catch (e) { _logGasError('buildOperationalBundle_/prev', e && e.message); }

  const staleStores = [];
  for (let i = 0; i < STORES.length; i++) {
    const store = STORES[i];
    let products = [], error = '';
    try {
      const inv = getInventory({ store, force: force ? '1' : '' }, invResponses[i], roomDataByStore[store]);
      products = inv.products || [];
      error = inv.error || '';
    } catch (err) { error = err && err.message; }

    const prev = prevByStore[store];
    if ((!products.length || error) && prev && (prev.products || []).length) {
      // fresh fetch failed/empty → keep last-good so the bundle stays complete
      inventory.push({ store: store, products: prev.products, error: '', stale: true });
      staleStores.push(store);
      errors.push(store + ' (kept last-good, fresh fetch ' + (error ? 'errored: ' + error : 'empty') + ')');
    } else {
      inventory.push({ store: store, products: products, error: error });
      if (error) errors.push(store + ': ' + error);
    }
  }
  return { ok: true, generatedAt, source: 'generated', velocity, inventory, errors, staleStores: staleStores };
}

function getOperationalBundle(params) {
  const key = 'inventory_bundle_v1';
  const snapshot = readOperationalSnapshot_(key);

  if (params.force === '1') {
    // Caller wants fresh data, but a synchronous rebuild costs 36+ Dutchie URL fetches
    // and may exhaust the daily quota. Instead, schedule an async background rebuild
    // (runs in ~60s via GAS trigger) and return the current snapshot for now.
    try { scheduleOperationalWarmRun(); } catch (e) { Logger.log('scheduleOperationalWarmRun failed: ' + e.message); }
    if (snapshot) {
      return Object.assign({}, snapshot, { refreshScheduled: true,
        message: 'Snapshot refresh has been scheduled (runs in ~60s). This response is the previous snapshot.' });
    }
    // No snapshot exists — schedule the build and tell the caller to try again
    return {
      ok: false,
      error: 'operational_snapshot_missing',
      source: 'missing',
      refreshScheduled: true,
      generatedAt: '',
      velocity: null,
      inventory: [],
      errors: ['Operational snapshot is being built now (scheduled). Try again in ~2 minutes.'],
    };
  }

  if (snapshot) return snapshot;

  // Snapshot missing — auto-schedule a rebuild once (self-healing). Uses a throttle key so
  // we don't pile up triggers if many users hit this simultaneously.
  const props = PropertiesService.getScriptProperties();
  const throttleKey = 'gc_snapshot_autoschedule_day';
  const today = new Date().toISOString().slice(0, 10);
  if (props.getProperty(throttleKey) !== today) {
    props.setProperty(throttleKey, today);
    try { scheduleOperationalWarmRun(); } catch (e) { Logger.log('Auto-schedule snapshot failed: ' + e.message); }
  }

  return {
    ok: false,
    error: 'operational_snapshot_missing',
    source: 'missing',
    generatedAt: '',
    velocity: null,
    inventory: [],
    errors: ['Operational snapshot is not ready yet — a rebuild has been scheduled automatically (~2 min). Please refresh after waiting.'],
  };
}

// ── Phase functions — each runs independently and can be triggered separately ──

// Phase 1: sync velocity cache + refresh the cached velocity endpoint.
// Can run hourly. Fast when already caught up (~2s); up to 3 min for a full backfill.
// Audit the Vel Cache for multi-day holes anywhere in the 180-day window and
// backfill the OLDEST one (capped per run). Why this is safe to auto-fill: all 6
// stores sell every day, so a contiguous block of days with ZERO rows across the
// whole cache is a sync gap, never legitimate "no-sale" days. The forward-only
// sync advances velSyncDate past holes and never revisits them, so without this a
// gap (like the Apr–Jun one we just repaired) persists silently until someone
// notices the velocity looks wrong. Runs nightly; large gaps fill over several nights.
const VEL_GAP_MIN_DAYS  = 3;   // ignore scattered 1-2 day holes (could be real low-volume days)
const VEL_GAP_FILL_CAP  = 28;  // max days to backfill per run (keeps within the 6-min budget)

function auditAndFillVelGaps_(props, productDict) {
  const sheet   = getVelSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { gapFilled: false, reason: 'empty' };

  // Cheap: read only the date column.
  const dateCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const present = new Set();
  for (let i = 0; i < dateCol.length; i++) {
    const ymd = _velDateToYMD(dateCol[i][0]);
    if (ymd) present.add(ymd);
  }

  const MS = 86400000, now = Date.now();
  // Calendar days from 179 days ago up to yesterday (skip today — may be partial),
  // oldest first, so the first qualifying run found is the OLDEST gap.
  const days = [];
  for (let d = 179; d >= 1; d--) days.push(_dateToYMDFast_(new Date(now - d * MS)));

  let runStart = -1, runLen = 0, gapStart = -1, gapLen = 0;
  for (let i = 0; i < days.length; i++) {
    if (!present.has(days[i])) {
      if (runLen === 0) runStart = i;
      runLen++;
    } else {
      if (runLen >= VEL_GAP_MIN_DAYS) { gapStart = runStart; gapLen = runLen; break; }
      runLen = 0;
    }
  }
  if (gapStart === -1 && runLen >= VEL_GAP_MIN_DAYS) { gapStart = runStart; gapLen = runLen; }
  if (gapStart === -1) return { gapFilled: false };

  // Backfill the oldest gap (capped). updateProp=false so velSyncDate (the forward
  // cursor) is untouched — we're patching history, not advancing the frontier.
  const fillLen  = Math.min(gapLen, VEL_GAP_FILL_CAP);
  const fromYMD  = days[gapStart];
  const fromDate = new Date(fromYMD + 'T00:00:00Z');
  const toDate   = new Date(fromDate.getTime() + fillLen * MS);
  _syncChunk(props, fromDate, toDate, false, productDict);
  Logger.log('auditAndFillVelGaps_: backfilled gap from ' + fromYMD + ' (' + gapLen + '-day gap, filled ' + fillLen + ')');
  return { gapFilled: true, from: fromYMD, gapDays: gapLen, filledDays: fillLen };
}

// Manual HTTP entry point for the gap audit (?action=velgapaudit) — fills one gap per call.
function velGapAudit() {
  return auditAndFillVelGaps_(PropertiesService.getScriptProperties(), buildProductIdDict());
}

function warmVelocityOnly() {
  const started = new Date();
  const result  = { ok: true, startedAt: started.toISOString(), errors: [] };
  try { ensureSnapshotTrigger_(); } catch (e) {} // cross-heal: revive the snapshot trigger if GAS disabled it
  // Phase C: local velocity sync is retired — velocity is sourced from GX Core's shared cache.
  // This warm just pre-populates the getVelocityEndpoint cache (which now reads GX Core) so page
  // loads stay fast. It no longer runs syncVelocityCache or the local gap audit.
  try {
    getVelocityEndpoint({ force: '1' });
  } catch (err) {
    result.errors.push('velocity warm: ' + err.message);
    result.ok = false;
    _logGasError('warmVelocityOnly', err.message);
  }
  result.finishedAt      = new Date().toISOString();
  result.durationSeconds = Math.round((new Date() - started) / 1000);
  return result;
}

// Phase 2: build the operational inventory bundle (fetches live Dutchie inventory
// for all stores + attaches cached velocity). Takes ~3-4 min for 6 stores.
// Run after warmVelocityOnly so the bundle gets fresh velocity data.
function warmBundleOnly() {
  const started = new Date();
  const result  = { ok: true, startedAt: started.toISOString(), errors: [] };
  try { ensureSnapshotTrigger_(); } catch (e) {} // cross-heal: revive the snapshot trigger if GAS disabled it
  try {
    const bundle = buildOperationalBundle_(true);
    writeOperationalSnapshot_('inventory_bundle_v1', bundle);
    // Tripwire (Leaderboard-style): if any store fell back to last-good, file ONE bug per distinct stale-set
    // and self-clear when the bundle is clean again — so a persistent Dutchie glitch is caught by the system.
    try {
      const props = PropertiesService.getScriptProperties();
      const stale = bundle.staleStores || [];
      const sig = stale.slice().sort().join(',');
      if (sig !== (props.getProperty('BUNDLE_STALE_SIG') || '')) {
        if (stale.length) {
          GXCore.gxIngestBug('inventory', 'app', {
            title: '⚠️ Inventory bundle: ' + stale.length + ' store(s) served from last-good (live Dutchie fetch failed)',
            desc: 'Automated tripwire: the operational-bundle build could not fetch live inventory for ' + stale.join(', ') +
              '. Those stores are served from their previous good snapshot so app TOTALS stay correct (no more silent-half-value), ' +
              'but their data is stale until Dutchie recovers. Repeated alerts = a persistent Dutchie/API-key issue for those stores.',
            priority: 'normal', tab: 'inventory', appVer: 'bundle-guard'
          });
        }
        props.setProperty('BUNDLE_STALE_SIG', sig);
      }
    } catch (e) { _logGasError('warmBundleOnly/tripwire', e && e.message); }
    result.staleStores = bundle.staleStores || [];
    result.inventory = bundle.inventory.map(inv => ({
      store:    inv.store,
      products: (inv.products || []).length,
      error:    inv.error || '',
      stale:    !!inv.stale,
    }));
    result.operationalBundle = {
      generatedAt: bundle.generatedAt,
      stores:      bundle.inventory.length,
      errors:      bundle.errors || [],
    };
  } catch (err) {
    result.errors.push('operational bundle: ' + err.message);
    result.ok = false;
    _logGasError('warmBundleOnly', err.message);
  }
  result.finishedAt      = new Date().toISOString();
  result.durationSeconds = Math.round((new Date() - started) / 1000);
  return result;
}

// Phase 3: generate the Beta Decision Feed. Takes ~1-2 min.
// Run after warmBundleOnly so decisions reflect the latest inventory snapshot.
function warmDecisionFeedOnly() {
  const started = new Date();
  const result  = { ok: true, startedAt: started.toISOString(), errors: [] };
  try {
    result.decisionFeed = generateBetaDecisionFeed({ beta: '1', force: '1' });
  } catch (err) {
    result.errors.push('decision feed: ' + err.message);
    result.ok = false;
    _logGasError('warmDecisionFeedOnly', err.message);
  }
  result.finishedAt      = new Date().toISOString();
  result.durationSeconds = Math.round((new Date() - started) / 1000);
  return result;
}

// Orchestrator — calls all three phases in order. Keeps the single nightly trigger
// working unchanged while each phase can also be invoked/debugged independently.
// If one phase fails its error is recorded but the remaining phases still run.
function warmOperationalCaches() {
  const started = new Date();
  setOperationalWarmStatus_({
    state:     'running',
    startedAt: started.toISOString(),
    message:   'Operational snapshot build running.',
  });

  const velResult    = warmVelocityOnly();
  const bundleResult = warmBundleOnly();
  const feedResult   = warmDecisionFeedOnly();
  // Rebuild the FATTY joint-tracker cache too (its cold build fetches lab results for every FATTY batch, ~25s)
  // so the first user load each day is instant. Non-fatal.
  const fattyErrors = [];
  try { buildFattyTracker_(true); } catch (e) { fattyErrors.push('fatty: ' + (e && e.message)); }

  // Phase functions already prefix their own errors ('velocity: ...', 'operational bundle: ...').
  // Spread them directly — don't re-prefix or the status panel shows 'velocity: velocity: msg'.
  const allErrors = [
    ...velResult.errors,
    ...bundleResult.errors,
    ...feedResult.errors,
    ...fattyErrors,
  ];

  const result = {
    ok:              allErrors.length === 0,
    startedAt:       started.toISOString(),
    finishedAt:      new Date().toISOString(),
    durationSeconds: Math.round((new Date() - started) / 1000),
    velocity:        velResult.velocity,
    inventory:       bundleResult.inventory || [],
    operationalBundle: bundleResult.operationalBundle || null,
    decisionFeed:    feedResult.decisionFeed,
    errors:          allErrors,
  };

  setOperationalWarmStatus_({
    state:            allErrors.length ? 'completed_with_warnings' : 'completed',
    startedAt:        result.startedAt,
    finishedAt:       result.finishedAt,
    durationSeconds:  result.durationSeconds,
    errors:           allErrors,
    operationalBundle: result.operationalBundle,
  });
  return result;
}

function setupOperationalCacheTrigger() {
  // Remove all existing warm triggers (old single trigger + any phase triggers).
  const WARM_HANDLERS = ['warmOperationalCaches', 'warmVelocityOnly', 'warmBundleOnly', 'warmDecisionFeedOnly'];
  ScriptApp.getProjectTriggers()
    .filter(t => WARM_HANDLERS.includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Install three staggered daily triggers — each phase gets a fresh 6-min GAS execution.
  // Velocity at midnight (fastest, ~2 min), bundle at 1am (~4 min), feed at 2am (~2 min).
  ScriptApp.newTrigger('warmVelocityOnly').timeBased().everyDays(1).atHour(0).create();
  ScriptApp.newTrigger('warmBundleOnly').timeBased().everyDays(1).atHour(1).create();
  ScriptApp.newTrigger('warmDecisionFeedOnly').timeBased().everyDays(1).atHour(2).create();

  Logger.log('Warm cache triggers installed: velocity at midnight, bundle at 1am, feed at 2am.');
  return { ok: true, message: 'Three nightly triggers installed: velocity at midnight, bundle at 1am, feed at 2am.' };
}

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────
function getSheetByGid(gid) {
  const ss = SpreadsheetApp.openById(getDataSpreadsheetId());
  for (const s of ss.getSheets()) {
    if (s.getSheetId() === gid) return s;
  }
  throw new Error('Sheet GID not found: ' + gid);
}

// ─── COGS (DUTCHIE) ───────────────────────────────────────────────────────────
// Returns daily COGS from GXCore (Dutchie-sourced, settled days only).
// Same response shape as getCOGS: {data:[{date,store,cogs}]}.
function getCogsDutchie(params) {
  const from = (params.from || '').slice(0, 10);
  const todayPT   = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), 'America/Los_Angeles', 'yyyy-MM-dd');
  const rawTo = (params.to || '').slice(0, 10);
  const to = (!rawTo || rawTo >= todayPT) ? yesterday : rawTo;

  const results = [];
  for (const store of STORES) {
    try {
      const rows = GXCore.getSalesDaily(store, from, to) || [];
      for (const r of rows) {
        if (!r.date) continue;
        results.push({ date: String(r.date).slice(0, 10), store: store, cogs: Number(r.cogs || 0) });
      }
    } catch(e) {
      Logger.log('getCogsDutchie: GXCore.getSalesDaily failed for ' + store + ': ' + e.message);
    }
  }
  return { data: results };
}

// ─── SALES (DUTCHIE) ──────────────────────────────────────────────────────────
// Returns daily net sales from GXCore (Dutchie-sourced, settled days only).
// Same response shape as getSales: {data:[{date,store,sales}]}.
// "to" is capped at yesterday — GXCore.getSalesDaily only has settled data.
function getSalesDutchie(params) {
  const from = (params.from || '').slice(0, 10);
  const todayPT   = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), 'America/Los_Angeles', 'yyyy-MM-dd');
  const rawTo = (params.to || '').slice(0, 10);
  const to = (!rawTo || rawTo >= todayPT) ? yesterday : rawTo;

  const results = [];
  for (const store of STORES) {
    try {
      const rows = GXCore.getSalesDaily(store, from, to) || [];
      for (const r of rows) {
        if (!r.date) continue;
        results.push({ date: String(r.date).slice(0, 10), store: store, sales: Number(r.net || 0) });
      }
    } catch(e) {
      Logger.log('getSalesDutchie: GXCore.getSalesDaily failed for ' + store + ': ' + e.message);
    }
  }
  return { data: results };
}

// ─── BUDGET ───────────────────────────────────────────────────────────────────
function getBudget() {
  const sheet = getSheetByGid(SHEET_GIDS.budget);
  const data  = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();

  let expensesSectionStart = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][1] || '').toUpperCase().includes('EXPENSES BUDGET')) {
      expensesSectionStart = i; break;
    }
  }

  let monthHeaderRow = -1;
  for (let i = 0; i < Math.min(5, data.length); i++) {
    if (data[i].filter(v => v !== '').length > 6) { monthHeaderRow = i; break; }
  }

  const months = monthHeaderRow >= 0
    ? data[monthHeaderRow].slice(2, 14)
    : Array.from({ length: 12 }, (_, i) => i + 1);

  const revenueRows = [];
  const limit = expensesSectionStart >= 0 ? expensesSectionStart : data.length;
  for (let i = monthHeaderRow + 1; i < limit; i++) {
    const storeName = String(data[i][1] || '').trim();
    if (!storeName || storeName.toUpperCase().includes('TOTAL')) continue;
    revenueRows.push({ store: storeName, monthlyGoals: data[i].slice(2, 14).map(v => parseFloat(v) || 0) });
  }

  const expenseRows = [];
  if (expensesSectionStart >= 0) {
    for (let i = expensesSectionStart + 1; i < data.length; i++) {
      const label = String(data[i][1] || '').trim();
      if (!label) continue;
      expenseRows.push({ label, monthlyValues: data[i].slice(2, 14).map(v => parseFloat(v) || 0) });
    }
  }

  return { months, revenueGoals: revenueRows, expenseBudget: expenseRows };
}

// ─── ONE-TIME BACKFILL ─────────────────────────────────────────────────────────
// Run once from the Apps Script editor to seed the SKU Dict from existing snapshot data.
function backfillSkuDict() {
  const ss       = SpreadsheetApp.openById(getInvDataSpreadsheetId());
  const snapshot = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
  if (!snapshot) { Logger.log('No snapshot sheet found'); return; }
  const lastRow = snapshot.getLastRow();
  if (lastRow < 2) { Logger.log('Snapshot sheet is empty'); return; }
  // Cols: date(1) store(2) productName(3) brand(4) category(5) sku(6)
  const data = snapshot.getRange(2, 3, lastRow - 1, 4).getValues();
  const products = data
    .map(r => ({ name: String(r[0] || '').trim(), sku: String(r[3] || '').trim() }))
    .filter(p => p.name && p.sku);
  updateSkuDict(ss, products);
  Logger.log('Backfill complete — processed ' + products.length + ' snapshot rows');
  return { ok: true, snapshotRows: products.length };
}

// ── Shared State (hidden items & flags synced across users) ───────────────────
const SHARED_KILLED_KEY  = 'gc_shared_killed';
const SHARED_FLAGGED_KEY = 'gc_shared_flagged';
const SHARED_RETIRED_KEY = 'gc_shared_retired'; // items queued for manual retirement in Dutchie
// Custom lead times: per SKU or per style target-coverage (days) overrides for the reorder engine. Shared
// server-side (all users + the smart-ordering job read the same list). Added via the Settings picker.
//   • type:'sku'   → key = SKU; matches that one product.
//   • type:'style' → key = style base name (product name minus size suffix), brand; matches every size SKU
//                     of that style (leverages grouping), so a tee run shares one lead time.
// SKU rule beats style rule beats the global buffer. Rule = {type, key, brand, label, days}.
const LEAD_TIMES_KEY = 'gc_lead_times';
const DEFAULT_LEAD_TIMES = [];  // start empty — Sky adds specific SKUs/styles via the picker

function isBetaRequest_(params) {
  return params && (params.beta === '1' || params.mode === 'beta' || getDataMode() === 'beta');
}

function getOrCreateSharedStateSheet_() {
  const ss = SpreadsheetApp.openById(BETA_SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHARED_STATE_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHARED_STATE_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 6).setValues([[
      'stateType', 'stateKey', 'valueJson', 'updatedAt', 'updatedBy', 'notes'
    ]]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readBetaSharedState_() {
  const sheet = getOrCreateSharedStateSheet_();
  if (sheet.getLastRow() < 2) return { killed: {}, flagged: {}, retired: {} };
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  const killed = {};
  const flagged = {};
  const retired = {};
  for (const row of values) {
    const type = String(row[0] || '').trim();
    const key = String(row[1] || '').trim();
    const valueJson = String(row[2] || '').trim();
    if (!type || !key) continue;
    let v = {}; try { v = JSON.parse(valueJson) || {}; } catch (e) { v = {}; }
    const rec = { ts: Number((v && v.ts) || valueJson || 0) || 0, by: String((v && v.by) || '') };
    if (type === 'killed') killed[key] = rec;          // { ts, by } — was a bare ts number before
    else if (type === 'flagged') flagged[key] = rec;   // { ts, by } — was a keys array before
    else if (type === 'retired') retired[key] = rec;   // { ts, by } — queued for Dutchie retirement
  }
  return { killed, flagged, retired };
}

function upsertBetaSharedState_(type, key, valueObj, notes) {
  const sheet = getOrCreateSharedStateSheet_();
  const now = new Date().toISOString();
  const valueJson = JSON.stringify(valueObj || {});
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === type && String(rows[i][1]) === key) {
        sheet.getRange(i + 2, 3, 1, 4).setValues([[valueJson, now, 'app', notes || '']]);
        return;
      }
    }
  }
  sheet.appendRow([type, key, valueJson, now, 'app', notes || '']);
}

function deleteBetaSharedState_(type, key) {
  const sheet = getOrCreateSharedStateSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]) === type && String(rows[i][1]) === key) sheet.deleteRow(i + 2);
  }
}

function getSharedState(params) {
  if (isBetaRequest_(params)) return readBetaSharedState_();
  const props = PropertiesService.getScriptProperties();
  const flaggedRaw = JSON.parse(props.getProperty(SHARED_FLAGGED_KEY) || '{}');
  const flagged = Array.isArray(flaggedRaw)
    ? flaggedRaw.reduce(function (a, k) { a[k] = { ts: 0, by: '' }; return a; }, {})
    : flaggedRaw;
  return {
    killed:  JSON.parse(props.getProperty(SHARED_KILLED_KEY) || '{}'),
    flagged: flagged,
    retired: JSON.parse(props.getProperty(SHARED_RETIRED_KEY) || '{}'),
  };
}

// Custom lead times (shared). Read returns the saved rules, or a default seed until Sky saves for the first
// time (seeded:true so the UI can hint it's a starting point). The smart-ordering job reads this too.
function getLeadTimes() {
  const raw = PropertiesService.getScriptProperties().getProperty(LEAD_TIMES_KEY);
  if (!raw) return { ok: true, rules: DEFAULT_LEAD_TIMES, seeded: true };
  let rules;
  try { rules = JSON.parse(raw); } catch (e) { rules = []; }
  if (!Array.isArray(rules)) rules = [];
  // Keep only well-formed sku/style rules; legacy brand/category rows (pre-picker) are dropped so the
  // picker model starts clean.
  rules = rules
    .filter(function (r) { return r && (r.type === 'sku' || r.type === 'style'); })
    .map(function (r) {
      return {
        type:  r.type,
        key:   String(r.key || '').trim(),
        brand: String(r.brand || '').trim(),
        label: String(r.label || '').trim(),
        days:  Math.max(1, Math.round(Number(r.days) || 0)),
      };
    })
    .filter(function (r) { return r.key && r.days >= 1; });
  return { ok: true, rules: rules, seeded: false };
}

function setLeadTimes(params) {
  let rules;
  try { rules = JSON.parse(params.rules || '[]'); } catch (e) { return { ok: false, error: 'bad rules JSON' }; }
  if (!Array.isArray(rules)) return { ok: false, error: 'rules must be an array' };
  const clean = rules.map(function (r) {
    return {
      type:  (String((r && r.type) || 'sku').toLowerCase() === 'style') ? 'style' : 'sku',
      key:   String((r && r.key) || '').trim(),
      brand: String((r && r.brand) || '').trim(),
      label: String((r && r.label) || '').trim(),
      days:  Math.max(1, Math.round(Number(r && r.days) || 0)),
    };
  }).filter(function (r) { return r.key && r.days >= 1; });
  PropertiesService.getScriptProperties().setProperty(LEAD_TIMES_KEY, JSON.stringify(clean));
  return { ok: true, rules: clean };
}

function sharedKill(params) {
  const key = params.key;
  const ts = params.ts;
  const by = String(params.by || '');
  if (!key) return { ok: false, error: 'missing key' };
  const val = { ts: parseInt(ts) || Date.now(), by: by };
  if (isBetaRequest_(params)) {
    upsertBetaSharedState_('killed', key, val, 'hidden from beta inventory' + (by ? ' by ' + by : ''));
    return { ok: true, mode: 'beta' };
  }
  const props = PropertiesService.getScriptProperties();
  const obj = JSON.parse(props.getProperty(SHARED_KILLED_KEY) || '{}');
  obj[key] = val;
  props.setProperty(SHARED_KILLED_KEY, JSON.stringify(obj));
  return { ok: true, killed: Object.keys(obj).length };
}

function sharedUnkill(params) {
  const key = params.key;
  if (!key) return { ok: false, error: 'missing key' };
  if (isBetaRequest_(params)) {
    deleteBetaSharedState_('killed', key);
    return { ok: true, mode: 'beta' };
  }
  const props = PropertiesService.getScriptProperties();
  const obj = JSON.parse(props.getProperty(SHARED_KILLED_KEY) || '{}');
  delete obj[key];
  props.setProperty(SHARED_KILLED_KEY, JSON.stringify(obj));
  return { ok: true, killed: Object.keys(obj).length };
}

// Retire = queued for manual retirement in Dutchie (a stronger Hide). Same { ts, by } shape as killed.
function sharedRetire(params) {
  const key = params.key;
  const ts = params.ts;
  const by = String(params.by || '');
  if (!key) return { ok: false, error: 'missing key' };
  const val = { ts: parseInt(ts) || Date.now(), by: by };
  if (isBetaRequest_(params)) {
    upsertBetaSharedState_('retired', key, val, 'queued for Dutchie retirement' + (by ? ' by ' + by : ''));
    return { ok: true, mode: 'beta' };
  }
  const props = PropertiesService.getScriptProperties();
  const obj = JSON.parse(props.getProperty(SHARED_RETIRED_KEY) || '{}');
  obj[key] = val;
  props.setProperty(SHARED_RETIRED_KEY, JSON.stringify(obj));
  return { ok: true, retired: Object.keys(obj).length };
}

function sharedUnretire(params) {
  const key = params.key;
  if (!key) return { ok: false, error: 'missing key' };
  if (isBetaRequest_(params)) {
    deleteBetaSharedState_('retired', key);
    return { ok: true, mode: 'beta' };
  }
  const props = PropertiesService.getScriptProperties();
  const obj = JSON.parse(props.getProperty(SHARED_RETIRED_KEY) || '{}');
  delete obj[key];
  props.setProperty(SHARED_RETIRED_KEY, JSON.stringify(obj));
  return { ok: true, retired: Object.keys(obj).length };
}

function sharedFlag(params) {
  const key = params.key;
  const by = String(params.by || '');
  if (!key) return { ok: false, error: 'missing key' };
  if (isBetaRequest_(params)) {
    const state = readBetaSharedState_();
    if (state.flagged[key]) deleteBetaSharedState_('flagged', key);
    else upsertBetaSharedState_('flagged', key, { ts: Date.now(), by: by }, 'flagged for beta buyer review' + (by ? ' by ' + by : ''));
    return { ok: true, mode: 'beta' };
  }
  const props = PropertiesService.getScriptProperties();
  const obj = JSON.parse(props.getProperty(SHARED_FLAGGED_KEY) || '{}');
  const norm = Array.isArray(obj) ? obj.reduce(function (a, k) { a[k] = { ts: 0, by: '' }; return a; }, {}) : obj;
  if (norm[key]) delete norm[key]; else norm[key] = { ts: Date.now(), by: by };
  props.setProperty(SHARED_FLAGGED_KEY, JSON.stringify(norm));
  return { ok: true, flagged: Object.keys(norm).length };
}

// ── UPC → Product Name map ────────────────────────────────────────────────────
// Two-layer map:
//   gc_upc_catalog — built from /products UPC field, cached 24 h
//   gc_upc_map     — user-learned overrides (from name-search linking)
const UPC_MAP_KEY      = 'gc_upc_map';
const UPC_CATALOG_KEY  = 'gc_upc_catalog';
const UPC_CATALOG_TS   = 'gc_upc_catalog_ts';
const UPC_CATALOG_TTL  = 24 * 3600 * 1000; // 24 hours

function getUpcMap() {
  const props  = PropertiesService.getScriptProperties();
  const userMap = (() => { try { return JSON.parse(props.getProperty(UPC_MAP_KEY) || '{}'); } catch(e) { return {}; } })();

  // Return cached catalog if fresh
  const cacheTs = parseInt(props.getProperty(UPC_CATALOG_TS) || '0');
  if (Date.now() - cacheTs < UPC_CATALOG_TTL) {
    const catalog = (() => { try { return JSON.parse(props.getProperty(UPC_CATALOG_KEY) || '{}'); } catch(e) { return {}; } })();
    return Object.assign({}, catalog, userMap); // user overrides win
  }

  // Rebuild from /products across all stores
  const requests = STORES.map(store => ({
    url:     DUTCHIE_BASE + '/products',
    headers: { Authorization: dutchieAuth(store), Accept: 'application/json' },
    muteHttpExceptions: true,
  }));
  const catalog = {};
  try {
    const responses = UrlFetchApp.fetchAll(requests);
    for (const resp of responses) {
      if (resp.getResponseCode() !== 200) continue;
      const raw   = JSON.parse(resp.getContentText());
      const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
      for (const item of items) {
        const upc  = (item.upc || '').trim();
        const name = (item.productName || '').trim();
        if (upc && name) catalog[upc] = name;
      }
    }
  } catch(e) { Logger.log('getUpcMap fetch error: ' + e); }

  // Cache result (split if > 90 KB to stay under PropertiesService 100 KB/key limit)
  const catalogJson = JSON.stringify(catalog);
  if (catalogJson.length <= 90000) {
    props.setProperty(UPC_CATALOG_KEY, catalogJson);
    props.setProperty(UPC_CATALOG_TS, String(Date.now()));
  }

  return Object.assign({}, catalog, userMap);
}

function setUpcEntry(params) {
  const upc  = (params.upc  || '').trim();
  const name = (params.name || '').trim();
  if (!upc || !name) return { ok: false, error: 'missing upc or name' };
  const props = PropertiesService.getScriptProperties();
  let map = {};
  try { map = JSON.parse(props.getProperty(UPC_MAP_KEY) || '{}'); } catch(e) {}
  map[upc] = name;
  props.setProperty(UPC_MAP_KEY, JSON.stringify(map));
  return { ok: true, upc, name, total: Object.keys(map).length };
}

// ── User Authentication ────────────────────────────────────────────────────────
function hashPass(pass) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pass));
  return bytes.map(function(b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function sessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(GC_SESSION_SECRET_KEY);
  if (!secret) {
    secret = Utilities.getUuid() + ':' + Utilities.getUuid();
    props.setProperty(GC_SESSION_SECRET_KEY, secret);
  }
  return secret;
}

function signSession_(payload) {
  const sig = Utilities.computeHmacSha256Signature(payload, sessionSecret_());
  return Utilities.base64EncodeWebSafe(sig);
}

function issueSessionToken_(user) {
  const exp = Date.now() + GC_SESSION_TTL_MS;
  const payload = [String(user).toLowerCase().trim(), exp].join(':');
  return payload + ':' + signSession_(payload);
}

function validateSessionToken_(token) {
  if (!token) return { ok: false, error: 'Auth required' };
  const parts = String(token).split(':');
  if (parts.length !== 3) return { ok: false, error: 'Invalid session' };
  const user = parts[0];
  const exp = Number(parts[1] || 0);
  const payload = user + ':' + exp;
  if (!user || !exp || Date.now() > exp) return { ok: false, error: 'Session expired' };
  if (parts[2] !== signSession_(payload)) return { ok: false, error: 'Invalid session' };
  return { ok: true, user: user };
}

// Reports the GXCore library version this deployment is bound to (GXCore.libVersion(), added in
// v153). An older pin has no libVersion(), which is itself the answer — the error is reported, not
// thrown, so the check never 500s.
function getLibVersion_() {
  try {
    if (typeof GXCore === 'undefined' || !GXCore) return { ok: false, error: 'GXCore not bound' };
    if (typeof GXCore.libVersion !== 'function') return { ok: false, error: 'pinned GXCore has no libVersion() — pre-v153' };
    return { ok: true, gxcore: GXCore.libVersion() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Write authorization — GX Core v161 verifySession
// ---------------------------------------------------------------------------
// requireAuth_ below proves WHO the caller is: it checks a signature and an expiry, both of which
// were fixed at the moment the token was issued. It cannot prove the caller STILL has access, so a
// revoked user keeps whatever rights they held until their TTL runs out. GXCore.verifySession
// (added in GX Core v161) re-checks the LIVE grant, which makes a revocation take effect at once.
//
// FAIL CLOSED HERE, AND ONLY HERE. Reads keep the local-only check on purpose: routing every board
// through GX Core would mean a Core hiccup blanks the whole app, which is the tradeoff this suite
// has deliberately declined everywhere else. A write is the one place where refusing costs less
// than guessing.
//
// bugreport is intentionally NOT in this list — filing a bug is a user-facing safety valve, and a
// read-only user must still be able to report that something is broken.
// Object.create(null) is deliberate, not style. A plain object literal INHERITS toString,
// constructor, valueOf, hasOwnProperty and __proto__, so WRITE_ACTIONS['toString'] is truthy and
// the map answers yes to actions nobody defined. Here that direction is harmless — it would add an
// auth check to a route that then 404s — but pricecards shipped the same shape on a READ allowlist
// and ?action=toString dumped their entire pricing sheet to an unauthenticated caller. A lookup
// table indexed by user input should not have a prototype at all; then the direction cannot matter.
const WRITE_ACTIONS = Object.assign(Object.create(null), {
  // shared state the app itself mutates
  setleadtimes: 1, setupcentry: 1,
  sharedkill: 1, sharedunkill: 1, sharedretire: 1, sharedunretire: 1, sharedflag: 1,
  // operator-only maintenance: no UI calls these, they are reached by URL
  velsync: 1, velreset: 1, velresyncfrom: 1, veldedup: 1, velclearfrom: 1, velclear: 1,
  velbackfill: 1, clearerrors: 1, prodcatclear: 1, roomcacheclear: 1,
  warmcaches: 1, warmvelocity: 1, warmbundle: 1, warmdecision: 1,
  schedulewarmcaches: 1, installwarmtrigger: 1, betadecisionfeed: 1,
  // destructive data moves
  trimempty: 1, migrateinvdata: 1, copyinvsnap: 1, deletemigrated: 1,
});

// The DECISION — what we do with whatever GX Core said — extracted so the probe below can exercise
// the shipped path instead of a copy of it. A probe that asserts its own reimplementation is
// precisely the check that cannot fail, so there is exactly one of these and both callers use it.
function writeAuthDecision_(res) {
  if (!res || res.ok !== true) {
    return { ok: false, error: (res && res.error) || 'Write blocked: access revoked or session no longer valid', via: 'gxcore' };
  }
  // canEdit is honoured only when GX Core states it OUTRIGHT. A missing field means Core expressed
  // no opinion, not that the answer is no. Treating undefined as false would lock out every user at
  // once the first time Core stopped populating it, and that outage would look exactly like a bug in
  // this deploy. The live grant re-check is the guarantee; this is the refinement on top.
  if (res.canEdit === false) {
    return { ok: false, error: 'Your Inventory access is read-only', via: 'gxcore' };
  }
  return { ok: true, user: res.user, role: res.role, via: 'gxcore' };
}

// Runs one verification end to end against an INJECTED verifier. Production passes the real library;
// the probe passes deliberate fakes. Injecting here rather than inside the decision means the probe
// also covers the throw path, which is the branch most likely to be wrong and least likely to run.
function verifyWrite_(verify, token) {
  let res;
  try {
    res = verify(token, 'inventory');
  } catch (e) {
    return { ok: false, error: 'Write blocked: grant check failed — ' + e.message, via: 'gxcore-error' };
  }
  return writeAuthDecision_(res);
}

function requireWriteAuth_(params) {
  const token = params.token || params.session || params.auth || '';
  if (typeof GXCore === 'undefined' || !GXCore || typeof GXCore.verifySession !== 'function') {
    return { ok: false, error: 'Write blocked: pinned GXCore has no verifySession() — needs v161+', via: 'unbound' };
  }
  // Wrapped rather than passed bare: a library method handed around as a value can lose its binding.
  return verifyWrite_(function (t, a) { return GXCore.verifySession(t, a); }, token);
}

// Proves the write gate is really wired, without needing a real session.
//
// The first version of this only ever checked the TRUE direction — real library, garbage token,
// "was it refused?" — which a hardcoded `true` would have passed just as happily. pricecards made
// the point that a probe must not lie in the comfortable direction, so it now also feeds the SAME
// shipped decision a verifier that ACCEPTS the garbage token and asserts it says yes. If
// inverseHolds is ever false, the probe is not reading its input and refusesGarbage above is
// worthless. Every invariant below has to hold for ok:true.
function writeAuthProbe_() {
  const BOGUS = 'nobody:0:not-a-signature';
  const out = {
    ok: true, pinned: null, hasVerifySession: false,
    refusesGarbage: null,     // real library + garbage token  -> must refuse
    inverseHolds: null,       // a verifier that ACCEPTS       -> must NOT refuse (the probe can report failure)
    honoursReadOnly: null,    // canEdit:false stated outright  -> must refuse
    failsClosedOnError: null, // verifier throws                -> must refuse
    protoSafe: null,          // WRITE_ACTIONS must not inherit from Object.prototype
    gatedActions: Object.keys(WRITE_ACTIONS).length,
  };
  try {
    if (typeof GXCore === 'undefined' || !GXCore) return { ok: false, error: 'GXCore not bound' };
    out.pinned = (typeof GXCore.libVersion === 'function') ? GXCore.libVersion() : 'pre-v153';
    out.hasVerifySession = (typeof GXCore.verifySession === 'function');

    if (out.hasVerifySession) {
      out.refusesGarbage = !verifyWrite_(function (t, a) { return GXCore.verifySession(t, a); }, BOGUS).ok;
    }
    out.inverseHolds       =  verifyWrite_(function () { return { ok: true, user: 'probe', role: 'manager', canEdit: true }; }, BOGUS).ok === true;
    out.honoursReadOnly    = !verifyWrite_(function () { return { ok: true, user: 'probe', role: 'viewer', canEdit: false }; }, BOGUS).ok;
    out.failsClosedOnError = !verifyWrite_(function () { throw new Error('simulated Core outage'); }, BOGUS).ok;
    out.protoSafe          = (WRITE_ACTIONS['toString'] === undefined && WRITE_ACTIONS['constructor'] === undefined);

    out.ok = (out.hasVerifySession && out.refusesGarbage === true && out.inverseHolds === true &&
              out.honoursReadOnly === true && out.failsClosedOnError === true && out.protoSafe === true);
  } catch (e) { out.ok = false; out.error = e.message; }
  return out;
}

function requireAuth_(params) {
  return validateSessionToken_(params.token || params.session || params.auth || '');
}

// Phase 1 shared sign-on: Inventory authenticates through GX Core (which also enforces the
// per-app access grant), with a local fallback so a GX Core hiccup or a not-yet-imported user
// can never lock anyone out. Tokens are signed with the shared GC_SESSION_SECRET, so a token
// issued by either path validates identically in requireAuth_/validateSessionToken_.
function loginUser(params) {
  // GX Core shared sign-on is the SOLE authority. The legacy local password fallback
  // (_loginUserLocal_ + the gc_users Script Property) was retired 2026-08-10 once every
  // Inventory user was provisioned in GX Core — a GX Core rejection is now final, and old
  // local passwords no longer work. Sessions still validate via requireAuth_/validateSessionToken_
  // (GX Core signs tokens with the shared GC_SESSION_SECRET).
  try {
    if (typeof GXCore !== 'undefined' && GXCore && GXCore.login) {
      return GXCore.login(params.user, params.pass, 'inventory');
    }
    return { ok: false, error: 'Login unavailable — shared sign-on not reachable.' };
  } catch (e) {
    _logGasError('loginUser/GXCore', e.message);
    return { ok: false, error: 'Login temporarily unavailable — please try again shortly.' };
  }
}

// ─── PER-STORE TRANSACTION HISTORY (scanner tap-to-expand) ────────────────────
// ?action=storetxhistory&store=Bend&name=Product+Name&days=30
// Strategy: look up productId from the product catalog, then fetch live
// Dutchie transactions and filter by productId (bulletproof matching).
function getStoreTxHistory(params) {
  const store = params.store || '';
  const name  = (params.name || params.sku || '').trim();
  const days  = Math.min(parseInt(params.days || '30'), 60);
  if (!store || !name) return { error: 'store and name params required' };
  if (!isKnownStore(store)) return { error: 'Unknown store: ' + store };

  // Step 1: find productId from the cached product catalog
  const prodDict  = buildProductIdDict();
  const nameLower = name.toLowerCase();
  let targetPid   = null;
  for (const [pid, prod] of Object.entries(prodDict)) {
    if ((prod.name || '').toLowerCase() === nameLower) { targetPid = pid; break; }
  }
  // Fuzzy fallback: catalog name contains or is contained by lookup name
  if (!targetPid) {
    for (const [pid, prod] of Object.entries(prodDict)) {
      const pn = (prod.name || '').toLowerCase();
      if (pn.includes(nameLower) || nameLower.includes(pn)) { targetPid = pid; break; }
    }
  }
  if (!targetPid) return { store, name, days, rows: [], _debug: 'productId not found in catalog' };

  // Step 2: fetch Retail transactions for this store over the date window
  const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const to   = new Date().toISOString();
  const url  = DUTCHIE_BASE + '/reporting/transactions'
    + '?FromDateUTC=' + encodeURIComponent(from)
    + '&ToDateUTC='   + encodeURIComponent(to)
    + '&IncludeDetail=true';

  const resp = UrlFetchApp.fetch(url, { headers: hdrs, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return { error: 'Dutchie HTTP ' + resp.getResponseCode() };

  const raw  = JSON.parse(resp.getContentText());
  const txns = Array.isArray(raw) ? raw : (raw.data || raw.items || []);

  const byDate = {};
  for (const tx of txns) {
    if (tx.transactionType && tx.transactionType !== 'Retail') continue;
    if (tx.isVoid) continue;
    if (!Array.isArray(tx.items)) continue;
    const dateStr = (tx.transactionDateLocalTime || tx.transactionDate || '').slice(0, 10);
    if (!dateStr) continue;
    for (const item of tx.items) {
      if (item.isReturned) continue;
      if (String(item.productId) !== String(targetPid)) continue;
      const qty = Number(item.quantity || 0);
      if (qty <= 0) continue;
      byDate[dateStr] = (byDate[dateStr] || 0) + qty;
    }
  }

  const rows = Object.entries(byDate)
    .map(([date, qty]) => ({ date, qty, by: '', isReturn: false }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return { store, name, days, rows };
}

// (Legacy local-user seeders setupUsers_/setUserPassword_ removed 2026-08-10 — GX Core is the
// sole sign-on authority; the gc_users Script Property is no longer read or written. The orphaned
// helpers hashPass/issueSessionToken_ remain defined but unused and can be cleaned up later.)
