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
const SKU_OVERRIDES_SHEET_NAME     = 'Config - SKU Overrides';
const REORDER_RULES_SHEET_NAME     = 'Config - Reorder Rules';
const VENDOR_LEAD_TIMES_SHEET_NAME = 'Config - Vendor Lead Times';
const DECISION_FEED_SHEET_NAME     = 'Decision Feed';
const SHARED_STATE_SHEET_NAME      = 'Shared State';
const DUTCHIE_BASE                 = 'https://api.pos.dutchie.com';

const STORES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River Rd'];
const DUTCHIE_STORE_KEYS_PROP = 'DUTCHIE_STORE_KEYS_JSON';

const SHEET_GIDS = {
  income: 1548231883,
  budget: 1092240858,
  atm:    1349619595,
  sublet: 1274502465,
};

// Reorder defaults — override per-category in a future Config Sheet
const LEAD_TIME_DAYS    = 5;
const SAFETY_STOCK_DAYS = 7;
const REORDER_BUFFER    = LEAD_TIME_DAYS + SAFETY_STOCK_DAYS; // 12 days
const GC_USERS_KEY      = 'gc_users';
const GC_SESSION_SECRET_KEY = 'GC_SESSION_SECRET';
const GC_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getDataMode() {
  return (PropertiesService.getScriptProperties().getProperty('GC_DATA_MODE') || 'live').toLowerCase();
}

function getDataSpreadsheetId() {
  return getDataMode() === 'beta' ? BETA_SPREADSHEET_ID : LIVE_SPREADSHEET_ID;
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
    const auth = requireAuth_(params);
    if (!auth.ok) return jsonOut(auth);
    // Inventory
    if (params.action === 'inventory')      return jsonOut(getInventory(params));
    if (params.action === 'inventorylive')  return jsonOut(getLiveInventory(params));
    if (params.action === 'velocity')       return jsonOut(getVelocityEndpoint(params));
    if (params.action === 'velsync')        return jsonOut(syncVelocityCache());
    if (params.action === 'installtrigger') return jsonOut(installVelocityTrigger());
    if (params.action === 'triggerstatus')  return jsonOut(getTriggerStatus());
    if (params.action === 'velreset')       return jsonOut(resetVelSyncDate());
    if (params.action === 'velclear')       return jsonOut(clearVelCache());
    if (params.action === 'velbackfill')       return jsonOut(velBackfillChunk(params));
    if (params.action === 'velbackfillstatus') return jsonOut(velBackfillStatus());
    if (params.action === 'getstate')          return jsonOut(getSharedState(params));
    if (params.action === 'sharedkill')        return jsonOut(sharedKill(params));
    if (params.action === 'sharedunkill')      return jsonOut(sharedUnkill(params));
    if (params.action === 'sharedflag')        return jsonOut(sharedFlag(params));
    if (params.action === 'salesdiag')      return jsonOut(getSalesHistoryDiagnostics());
    if (params.action === 'apiexplore')     return jsonOut(exploreApi(params));
    if (params.action === 'skuprobe')       return jsonOut(skuRoomProbe(params));
    if (params.action === 'txprobe')        return jsonOut(txProbe(params));
    if (params.action === 'salestxprobe')   return jsonOut(salesTxProbe(params));
    if (params.action === 'skusales')       return jsonOut(skuSalesSearch(params));
    if (params.action === 'txtypeprobe')    return jsonOut(txTypeProbe(params));
    if (params.action === 'invfieldprobe')  return jsonOut(invFieldProbe(params));
    if (params.action === 'snapshotprobe')  return jsonOut(snapshotProbe(params));
    if (params.action === 'invrooms')       return jsonOut(invRoomsProbe(params));
    if (params.action === 'invtxlookup')    return jsonOut(invTxLookup(params));
    if (params.action === 'prodcatalog')    return jsonOut(buildProductIdDict());
    if (params.action === 'prodcatclear')   return jsonOut(clearProductCatalogCache());
    if (params.action === 'roomcacheclear') return jsonOut(clearRoomCache());
    if (params.action === 'roomidprobe')    return jsonOut(roomIdProbe(params));
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
    if (params.action === 'cogs')           return jsonOut(getCOGS(params));
    if (params.action === 'sales')          return jsonOut(getSales(params));
    if (params.action === 'storetxhistory') return jsonOut(getStoreTxHistory(params));
    if (params.action === 'budget')         return jsonOut(getBudget());
    if (params.action === 'schema')         return jsonOut(getSchema());
    if (params.action === 'datamode')       return jsonOut({ mode: getDataMode(), spreadsheetId: getDataSpreadsheetId() });
    if (params.action === 'betadecisionfeed') return jsonOut(generateBetaDecisionFeed(params));
    if (params.action === 'decisionfeed')   return jsonOut(readBetaDecisionFeed(params));
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
  // Use a separate spreadsheet to avoid hitting the main sheet's 10M cell limit.
  // ID is stored in PropertiesService on first use.
  const props   = PropertiesService.getScriptProperties();
  let   bugSsId = props.getProperty('BUG_REPORTS_SS_ID');
  let   bugSs;

  if (!bugSsId) {
    bugSs   = SpreadsheetApp.create('GC Bug Reports');
    bugSsId = bugSs.getId();
    props.setProperty('BUG_REPORTS_SS_ID', bugSsId);
  } else {
    bugSs = SpreadsheetApp.openById(bugSsId);
  }

  let sheet = bugSs.getSheetByName('Bugs');
  if (!sheet) {
    sheet = bugSs.getSheets()[0];
    sheet.setName('Bugs');
    sheet.getRange(1, 1, 1, 8).setValues([[
      'Timestamp', 'Reporter', 'Priority', 'Title', 'Description', 'Tab', 'Store', 'Version'
    ]]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }

  const ts = new Date();
  sheet.appendRow([
    ts,
    b.reporter  || '',
    b.priority  || 'medium',
    b.title     || '',
    b.desc      || '',
    b.appTab    || '',
    b.appStore  || '',
    b.appVer    || '',
  ]);

  // Email notification
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

  return { ok: true };
}

// ─── Store helpers ────────────────────────────────────────────────────────────
function normalizeStoreName(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\s*-\s*Green Cross Cannabis Emporium\s*/i, '').trim();
  if (/^Center\s*St/i.test(s))      return 'Center';
  if (/^Portland\s*Road/i.test(s))  return 'Portland Rd';
  if (/^Portland\s*Rd/i.test(s))    return 'Portland Rd';
  return s;
}

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
function buildRoomData(store) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'roomdata4_' + store;
  const cached   = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  // Fetch rooms + three inventory transaction windows + recent register transactions in parallel.
  // Register transactions (last 90 days) are used to detect customer returns → quarantine.
  const date90  = new Date(Date.now() - 90  * 86400000).toISOString().slice(0, 10);
  const date150 = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10);
  const now14ISO  = new Date(Date.now() - 14 * 86400000).toISOString();
  const nowISO    = new Date().toISOString();
  const [roomsResp, txBase, txRecent90, txRecent150, regResp] = UrlFetchApp.fetchAll([
    { url: DUTCHIE_BASE + '/room/rooms',                                                    headers: hdrs, muteHttpExceptions: true },
    { url: DUTCHIE_BASE + '/inventory/inventorytransaction',                                headers: hdrs, muteHttpExceptions: true },
    { url: DUTCHIE_BASE + '/inventory/inventorytransaction?startDate=' + date90,            headers: hdrs, muteHttpExceptions: true },
    { url: DUTCHIE_BASE + '/inventory/inventorytransaction?startDate=' + date150,           headers: hdrs, muteHttpExceptions: true },
    { url: DUTCHIE_BASE + '/reporting/transactions?FromDateUTC=' + encodeURIComponent(now14ISO) + '&ToDateUTC=' + encodeURIComponent(nowISO) + '&IncludeDetail=true', headers: hdrs, muteHttpExceptions: true },
  ]);

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

  // Merge all transaction responses; keep latest move per inventoryId.
  // Recent responses override base (newer date wins by ISO string comparison).
  const invRoomMap = {};
  const latestMove = {};
  for (const resp of [txBase, txRecent90, txRecent150]) {
    if (resp.getResponseCode() !== 200) continue;
    const txs = JSON.parse(resp.getContentText());
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

  const result = { roomNameType, roomIdType, invRoomMap, returnedPackageIds: [...returnedPackageIds] };
  try { cache.put(cacheKey, JSON.stringify(result), 300); } catch(e) {} // 5 min — match inventory cache
  return result;
}

// Keep old name as alias so getQuarantine still works
function buildInventoryRoomMap(store) {
  return buildRoomData(store).invRoomMap;
}

// ─── LIVE INVENTORY (Dutchie API) ─────────────────────────────────────────────
// Returns on-hand grouped by productName, split by room (floor vs back).
// Room is determined by the latest "Move" transaction per inventoryId.
// River Rd is the distribution hub: packages received but never moved default to 'distro'
// (staged for distribution to other stores). At all other stores they default to 'back'.
const INV_CACHE_TTL = 300; // seconds — 5 min server-side cache per store

function getInventory(params) {
  const store = params.store;
  if (!store || !isKnownStore(store)) return { error: 'Unknown store: ' + store };

  // Serve from GAS cache if fresh — prevents redundant Dutchie calls across users
  const scriptCache = CacheService.getScriptCache();
  const cacheKey    = 'inv5_' + store;
  const cached      = scriptCache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }

  const hdrs = { Authorization: dutchieAuth(store), Accept: 'application/json' };

  // Fetch inventory + room map in parallel
  const [invResp] = UrlFetchApp.fetchAll([
    { url: DUTCHIE_BASE + '/reporting/inventory', headers: hdrs, muteHttpExceptions: true },
  ]);
  if (invResp.getResponseCode() !== 200) {
    return { error: 'Dutchie HTTP ' + invResp.getResponseCode(), store };
  }

  const raw      = JSON.parse(invResp.getContentText());
  const items    = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  const { roomNameType, roomIdType, invRoomMap, returnedPackageIds: returnedPkgArr } = buildRoomData(store);
  const returnedPackageIds = new Set(returnedPkgArr || []);

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
        lastMod:      '',
        img:          item.imageUrl || item.productImageUrl || item.photo || '',
      };
    }
    const p = productMap[name];
    const itemPrice = Number(item.unitPrice || item.price || item.retailPrice || item.defaultUnitPrice || item.medPrice || item.recPrice || 0);
    if (itemPrice > 0) p.unitPrice = itemPrice;

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
        : (store === 'River Rd' ? 'distro' : 'back'); // River Rd: unreceived/unmoved packages default to distro (staged for distribution)

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

function loadBetaDecisionConfig() {
  const skuOverrides = {};
  for (const row of sheetToObjects_(SKU_OVERRIDES_SHEET_NAME, BETA_SPREADSHEET_ID)) {
    const sku = String(row.sku || '').trim();
    if (!sku || String(row.enabled).toLowerCase() === 'false') continue;
    skuOverrides[sku] = {
      sku,
      overrideType: String(row.overrideType || '').trim(),
      leadTimeDays: Number(row.leadTimeDays) || null,
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
      leadTimeDays: Number(r.leadTimeDays) || LEAD_TIME_DAYS,
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
    .map(r => ({
      vendor: String(r.vendor || ''),
      brand: String(r.brand || ''),
      category: String(r.category || ''),
      leadTimeDays: Number(r.leadTimeDays) || null,
      buyerNotes: String(r.buyerNotes || ''),
    }));

  return { skuOverrides, reorderRules, vendorLeadTimes };
}

function patternMatches_(pattern, value) {
  const p = String(pattern || '').trim();
  if (!p || p === '*') return true;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i').test(String(value || ''));
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
  return config.vendorLeadTimes.find(r =>
    patternMatches_(r.vendor || '*', p.vendor || '') &&
    patternMatches_(r.brand || '*', p.brand || '') &&
    patternMatches_(r.category || '*', p.category || '')
  ) || null;
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
    const ss = SpreadsheetApp.openById(getDataSpreadsheetId());
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

function transferDays_(a, b) {
  const salem = { 'Center': true, 'Commercial': true, 'Portland Rd': true, 'River Rd': true };
  const aS = !!salem[a], bS = !!salem[b];
  if (aS && bS) return 3;
  if (aS || bS) return 7;
  return 10;
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
  const velMap = buildVelocityMap();
  const config = loadBetaDecisionConfig();
  const shared = getSharedState({ beta: '1' });
  const killed = shared.killed || {};
  const flagged = new Set(shared.flagged || []);
  const oosLastSeen = buildOosLastSeenMap_();
  const byKey = {};
  const rows = [];
  const targetSet = new Set((targetStores && targetStores.length ? targetStores : STORES));

  if (targetSet.size < STORES.length) {
    for (const donor of loadExistingDecisionDonors_(targetSet)) {
      const key = productKey_(donor);
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(donor);
    }
  }

  for (const store of targetSet) {
    const inv = getInventory({ store });
    if (inv.error) continue;
    for (const p of inv.products || []) {
      const vel = (velMap[store] || {})[p.name] || {};
      const v14 = vel.vel14 || 0;
      const v30 = vel.vel30 || 0;
      const v7 = vel.vel7 || 0;
      const primaryVel = v14 > 0 ? v14 : (v30 > 0 ? v30 : v7);
      const doh = p.qty === 0 ? 0 : (primaryVel > 0 ? Math.round((p.qty / primaryVel) * 10) / 10 : null);
      const status = p.qty === 0 ? 'oos' : (doh == null ? 'slow' : (doh < 3 ? 'critical' : doh < 7 ? 'low' : doh < 14 ? 'watch' : 'ok'));
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
    const leadTimeDays = (override && override.leadTimeDays) || (vendorLead && vendorLead.leadTimeDays) || rule.leadTimeDays;
    const safetyStockDays = rule.safetyStockDays || SAFETY_STOCK_DAYS;
    const targetDays = leadTimeDays + safetyStockDays;
    const minOrderQty = (override && override.minOrderQty) || rule.minOrderQty || 1;
    const orderMultiple = (override && override.orderMultiple) || rule.orderMultiple || 1;
    const transferFirst = (override && override.transferFirst) || rule.ruleName.toLowerCase().indexOf('transfer first') >= 0;
    const overstock = override && override.overstock;
    const reasonCodes = [];
    const flagKey = sku + '|' + p.store;

    if (p.status === 'oos') reasonCodes.push('OOS');
    if (p.status === 'critical') reasonCodes.push('LOW_DOH');
    if (p.status === 'low') reasonCodes.push('LOW_STOCK');
    if (transferFirst) reasonCodes.push('TRANSFER_FIRST');
    if (overstock || rule.ruleName.toLowerCase().indexOf('green cross') >= 0) reasonCodes.push('GREEN_CROSS_OVERSTOCK');
    if (override && override.leadTimeDays) reasonCodes.push('LONG_LEAD_SKU');
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
  const targetStores = requestedStore && requestedStore !== 'all' ? [requestedStore] : STORES;
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

function getVelSheet() {
  const ss = SpreadsheetApp.openById(getDataSpreadsheetId());
  let sheet = ss.getSheetByName(VEL_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(VEL_SHEET_NAME);
    sheet.getRange(1, 1, 1, VEL_COLS.length).setValues([VEL_COLS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Fetch productId → {name, brand, category, sku} from all stores in parallel
// Product catalog cache TTL — /products changes infrequently, 120/min rate limit
const PROD_CATALOG_CACHE_TTL = 3600; // 1 hour

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

// Main sync — call from trigger or manually. Fetches delta, writes to sheet.
// For large date ranges (initial backfill), chunks into 14-day windows to stay
// within Apps Script URL fetch response size limits.
function syncVelocityCache() {
  const props      = PropertiesService.getScriptProperties();
  const lastSync   = props.getProperty('velSyncDate');
  const now        = new Date();
  const cutoff90   = new Date(now.getTime() - VEL_WINDOW_DAYS * 86400000);
  const fromDate   = lastSync ? new Date(lastSync) : cutoff90;
  const fetchFrom  = fromDate < cutoff90 ? cutoff90 : fromDate;

  const CHUNK_DAYS = 14;
  const chunkMs    = CHUNK_DAYS * 86400000;
  const chunkEnd   = new Date(Math.min(fetchFrom.getTime() + chunkMs, now.getTime()));
  const remaining  = Math.max(0, Math.ceil((now.getTime() - chunkEnd.getTime()) / 86400000));

  const result = _syncChunk(props, fetchFrom, chunkEnd, true);
  return { ...result, remaining, backfillComplete: remaining === 0 };
}

// Internal: fetch one time window for all stores, upsert into sheet.
// If `updateProp` is true, also saves velSyncDate to PropertiesService.
function _syncChunk(props, fromDate, toDate, updateProp) {
  const fromISO = fromDate.toISOString();
  const toISO   = toDate.toISOString();
  const now     = Date.now();
  const cutoff90Str = new Date(now - VEL_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

  const productDict = buildProductIdDict();

  const requests = STORES.map(store => ({
    url: DUTCHIE_BASE + '/reporting/transactions'
      + '?FromDateUTC=' + encodeURIComponent(fromISO)
      + '&ToDateUTC='   + encodeURIComponent(toISO)
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
      if (!dateStr || dateStr < cutoff90Str) continue; // skip rows outside the retention window

      for (const item of tx.items) {
        if (item.isReturned) continue;
        const qty = item.quantity || 0;
        if (qty <= 0) continue;
        const pid = item.productId;
        if (!pid) continue;
        const product = productDict[pid];
        if (!product) continue; // skip products absent from full product catalog
        const key = store + '|' + dateStr + '|' + pid;
        if (!agg[key]) agg[key] = { date: dateStr, store, productId: pid, name: product.name, brand: product.brand, category: product.category, sku: product.sku, qty: 0 };
        agg[key].qty += qty;
      }
    }
  }

  const sheet   = getVelSheet();
  const newRows = Object.values(agg);

  if (newRows.length > 0) {
    const existingData = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, VEL_COLS.length).getValues() : [];
    const newKeys = new Set(newRows.map(r => r.store + '|' + r.date + '|' + r.productId));
    const kept = existingData.filter(row => !newKeys.has(row[1] + '|' + row[0] + '|' + row[2]));
    const pruned = kept.filter(row => String(row[0]) >= cutoff90Str);
    const allRows = pruned.concat(newRows.map(r => [r.date, r.store, r.productId, r.name, r.brand, r.category, r.sku, r.qty]));
    sheet.clearContents();
    sheet.getRange(1, 1, 1, VEL_COLS.length).setValues([VEL_COLS]);
    if (allRows.length > 0) sheet.getRange(2, 1, allRows.length, VEL_COLS.length).setValues(allRows);
  }

  if (updateProp) {
    props.setProperty('velSyncDate', toISO);
  }
  Logger.log('_syncChunk ' + fromISO.slice(0,10) + ' → ' + toISO.slice(0,10) + ': ' + newRows.length + ' rows');
  return { synced: newRows.length, upTo: toISO };
}

// Read the Vel Cache sheet and compute velocity map.
// Rows from 91–180 days are retained in the sheet solely for hasSalesHistory detection.
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
    const dateStr = String(row[0] || '');
    if (!dateStr) continue;
    const ts = new Date(dateStr).getTime();

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
  if (sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }
  PropertiesService.getScriptProperties().deleteProperty('velSyncDate');
  return { ok: true, message: 'Vel Cache sheet cleared and sync date reset. Run velsync to backfill.' };
}

// velBackfillChunk: HTTP entry point — just schedules the trigger and returns immediately.
// The actual data fetch runs in a background trigger (6-min limit vs 30-sec HTTP limit).
function velBackfillChunk(params) {
  const props   = PropertiesService.getScriptProperties();
  const now     = new Date();
  const cutoff  = new Date(now.getTime() - VEL_WINDOW_DAYS * 86400000);
  const fromStr = params.from || cutoff.toISOString().slice(0, 10);
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
  if (!fromStr) return;

  const now      = new Date();
  const fromDate = new Date(fromStr + 'T00:00:00Z');
  const CHUNK    = 7 * 86400000;
  const toDate   = new Date(Math.min(fromDate.getTime() + CHUNK, now.getTime()));

  _syncChunk(props, fromDate, toDate, false); // don't touch velSyncDate

  const nextFrom = toDate.toISOString().slice(0, 10);
  const done = toDate >= now;
  if (done) {
    props.deleteProperty('backfillFrom');
    props.setProperty('backfillStatus', 'complete:' + nextFrom);
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

function clearProductCatalogCache() {
  const sc = CacheService.getScriptCache();
  sc.removeAll(['prodcat_v2', 'prodcat_v2_a', 'prodcat_v2_b', 'prodcat_v2_split']);
  return { ok: true, message: 'Product catalog cache cleared. Next velsync will re-fetch /products.' };
}

function resetVelSyncDate() {
  PropertiesService.getScriptProperties().deleteProperty('velSyncDate');
  return { ok: true, message: 'velSyncDate cleared — next velsync will backfill 90 days.' };
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

function installVelocityTrigger() {
  // Remove any existing velocity sync triggers first
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncVelocityCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncVelocityCache')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('Hourly syncVelocityCache trigger installed.');
  return { ok: true, message: 'Hourly syncVelocityCache trigger installed.' };
}

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
    const ss    = SpreadsheetApp.openById(getDataSpreadsheetId());
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
  const velMap    = buildVelocityMap();
  const nameToSku = buildNameSkuFromSnapshot();
  const lastSynced = PropertiesService.getScriptProperties().getProperty('velSyncDate') || null;
  // Attach snapshot-sourced SKUs to velocity entries
  for (const store of Object.keys(velMap)) {
    for (const name of Object.keys(velMap[store])) {
      if (!velMap[store][name].sku && nameToSku[name]) {
        velMap[store][name].sku = nameToSku[name];
      }
    }
  }
  if (params.store && params.store !== 'all') {
    return { store: params.store, products: velMap[params.store] || {}, lastSynced };
  }
  return { stores: velMap, lastSynced };
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
  const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  if (!items.length) return { httpStatus: code, error: 'empty response' };
  // Return first item in full + a list of all keys with their value types
  const first = items[0];
  const fields = Object.entries(first).map(([k, v]) => ({ key: k, type: typeof v, sample: JSON.stringify(v).slice(0, 80) }));
  return { store, httpStatus: code, totalItems: items.length, fields, firstItem: first };
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
  const velMap = buildVelocityMap();

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
        status = doh < 3 ? 'critical' : doh < 7 ? 'low' : doh < 14 ? 'watch' : 'ok';
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

  const ss = SpreadsheetApp.openById(getDataSpreadsheetId());
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
function snapshotInventory() {
  const ss    = SpreadsheetApp.openById(getDataSpreadsheetId());
  const sheet = getOrCreateSnapshotSheet(ss);
  const today = new Date().toISOString().slice(0, 10);

  for (const store of STORES) {
    let invResult;
    try {
      invResult = getInventory({ store });
    } catch (err) {
      Logger.log('Snapshot error for ' + store + ': ' + err.message);
      continue;
    }
    if (invResult.error || !invResult.products) continue;

    const inStock = invResult.products.filter(p => p.qty > 0);
    const rows = inStock.map(p => [today, store, p.name, p.brand, p.category, p.sku, p.qty, p.value]);

    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
    }
    updateSkuDict(ss, invResult.products); // persist name→sku for all products, including zero-qty
  }

  purgeOldSnapshots(sheet);
}

function getOrCreateSnapshotSheet(ss) {
  let sheet = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SNAPSHOT_SHEET_NAME);
    sheet.getRange(1, 1, 1, 8).setValues([[
      'date', 'store', 'productName', 'brand', 'category', 'sku', 'qty', 'value'
    ]]);
    sheet.setFrozenRows(1);
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

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────
function getSheetByGid(gid) {
  const ss = SpreadsheetApp.openById(getDataSpreadsheetId());
  for (const s of ss.getSheets()) {
    if (s.getSheetId() === gid) return s;
  }
  throw new Error('Sheet GID not found: ' + gid);
}

// ─── COGS ─────────────────────────────────────────────────────────────────────
function getCOGS(params) {
  const from = params.from || '';
  const to   = params.to   || '';
  const sheet = getSheetByGid(SHEET_GIDS.income);
  const data  = sheet.getRange(1, 1, sheet.getLastRow(), 4).getValues();
  const results = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const raw = row[0];
    if (!raw) continue;
    let dateStr;
    if (raw instanceof Date) {
      dateStr = raw.toISOString().slice(0, 10);
    } else if (typeof raw === 'string' && raw.match(/\d{4}-\d{2}-\d{2}/)) {
      dateStr = raw.slice(0, 10);
    } else continue;
    if (from && dateStr < from) continue;
    if (to   && dateStr > to)   continue;
    results.push({ date: dateStr, store: normalizeStoreName(row[1]), cogs: parseFloat(row[3]) || 0 });
  }
  return { data: results };
}

// ─── SALES ────────────────────────────────────────────────────────────────────
function getSales(params) {
  const from = params.from || '';
  const to   = params.to   || '';
  const sheet = getSheetByGid(SHEET_GIDS.income);
  const data  = sheet.getRange(1, 1, sheet.getLastRow(), 3).getValues();
  const results = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const raw = row[0];
    if (!raw) continue;
    let dateStr;
    if (raw instanceof Date) {
      dateStr = raw.toISOString().slice(0, 10);
    } else if (typeof raw === 'string' && raw.match(/\d{4}-\d{2}-\d{2}/)) {
      dateStr = raw.slice(0, 10);
    } else continue;
    if (from && dateStr < from) continue;
    if (to   && dateStr > to)   continue;
    results.push({ date: dateStr, store: normalizeStoreName(row[1]), sales: parseFloat(row[2]) || 0 });
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

// ─── SCHEMA (debug) ───────────────────────────────────────────────────────────
function getSchema() {
  const sheet = getSheetByGid(SHEET_GIDS.income);
  return { rows: sheet.getRange(1, 1, 5, 20).getValues() };
}

// ─── ONE-TIME BACKFILL ─────────────────────────────────────────────────────────
// Run once from the Apps Script editor to seed the SKU Dict from existing snapshot data.
function backfillSkuDict() {
  const ss       = SpreadsheetApp.openById(getDataSpreadsheetId());
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
  if (sheet.getLastRow() < 2) return { killed: {}, flagged: [] };
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  const killed = {};
  const flagged = [];
  for (const row of values) {
    const type = String(row[0] || '').trim();
    const key = String(row[1] || '').trim();
    const valueJson = String(row[2] || '').trim();
    if (!type || !key) continue;
    if (type === 'killed') {
      let ts = 0;
      try { ts = Number(JSON.parse(valueJson).ts || 0); } catch(e) { ts = Number(valueJson || 0); }
      killed[key] = ts || 0;
    } else if (type === 'flagged') {
      flagged.push(key);
    }
  }
  return { killed, flagged };
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
  return {
    killed:  JSON.parse(props.getProperty(SHARED_KILLED_KEY)  || '{}'),
    flagged: JSON.parse(props.getProperty(SHARED_FLAGGED_KEY) || '[]'),
  };
}

function sharedKill(params) {
  const key = params.key;
  const ts = params.ts;
  if (!key) return { ok: false, error: 'missing key' };
  if (isBetaRequest_(params)) {
    upsertBetaSharedState_('killed', key, { ts: parseInt(ts) || Date.now() }, 'hidden from beta inventory');
    return { ok: true, mode: 'beta' };
  }
  const props = PropertiesService.getScriptProperties();
  const obj = JSON.parse(props.getProperty(SHARED_KILLED_KEY) || '{}');
  obj[key] = parseInt(ts) || Date.now();
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

function sharedFlag(params) {
  const key = params.key;
  if (!key) return { ok: false, error: 'missing key' };
  if (isBetaRequest_(params)) {
    const state = readBetaSharedState_();
    if (state.flagged.includes(key)) deleteBetaSharedState_('flagged', key);
    else upsertBetaSharedState_('flagged', key, { active: true }, 'flagged for beta buyer review');
    return { ok: true, mode: 'beta' };
  }
  const props = PropertiesService.getScriptProperties();
  const arr = JSON.parse(props.getProperty(SHARED_FLAGGED_KEY) || '[]');
  const s = new Set(arr);
  if (s.has(key)) s.delete(key); else s.add(key);
  props.setProperty(SHARED_FLAGGED_KEY, JSON.stringify([...s]));
  return { ok: true, flagged: s.size };
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

function requireAuth_(params) {
  return validateSessionToken_(params.token || params.session || params.auth || '');
}

function loginUser(params) {
  if (!params.user || !params.pass) return { ok: false, error: 'Missing credentials' };
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const key   = String(params.user).toLowerCase().trim();
  const hash  = hashPass(String(params.pass));
  if (users[key] && users[key] === hash) {
    return { ok: true, user: key, token: issueSessionToken_(key), expiresAt: new Date(Date.now() + GC_SESSION_TTL_MS).toISOString() };
  }
  return { ok: false, error: 'Invalid username or password' };
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

// Run once from GAS editor to seed users (never exposed as HTTP action)
function setupUsers_() {
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  // Add users here — run from the GAS script editor, not via HTTP
  // users['username'] = hashPass('temporary-password');
  props.setProperty(GC_USERS_KEY, JSON.stringify(users));
  Logger.log('Users: ' + JSON.stringify(Object.keys(users)));
}

// Run from clasp/GAS editor only. This is intentionally not routed through doGet.
function setUserPassword_(user, pass) {
  if (!user || !pass) throw new Error('Usage: setUserPassword_(user, pass)');
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const key = String(user).toLowerCase().trim();
  users[key] = hashPass(String(pass));
  props.setProperty(GC_USERS_KEY, JSON.stringify(users));
  Logger.log('Saved user: ' + key);
  return { ok: true, user: key };
}
