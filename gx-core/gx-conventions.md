# GX Shared Conventions

Reusable rules for every Green Cross app (Inventory, Price Tags, SPIFF, Sales, Performance).
Paste-ready patterns behind the `/gxbrain` hard rules. If a request conflicts with anything
here, surface it before proceeding.

## Data layout
- **One Google Sheet per app.** Never read/write the legacy "2026 GX2 Dashboard" sheet.
- **GX Core** ("Green Cross — GX Core") is the single source of truth for cross-app data:
  `users`, `app_access`, `stores`, `employees`, `products`, `pricetag_config`, `audit_log`, `kv`.
  One writer (the GX Core library), many readers.
- Cross-app hand-offs go through a **written column contract** in GX Core (e.g. SPIFF writes
  `spiff_payouts`, Performance reads it). Don't change a shared tab's columns without updating
  both sides in the same change.

## Cell rules (learned the hard way)
- **Dates are TEXT** (`YYYY-MM-DD`), never Date objects — a sheet/script timezone mismatch
  shifts coerced dates by a day and corrupts velocity/day-alignment. GX Core forces tabs to the
  `@` (plain-text) number format on creation.
- **Booleans are text** — `TRUE`/`FALSE`, `active`/`enabled`. Read with a truthy helper, never `=== true`.
- **Slugs**: `store_id` and `user_id` are lowercase, hyphenated (`portland-rd`, `sky`).

## Identifiers
| Thing | Format | Example |
|---|---|---|
| store_id | lowercase, hyphen | `river-rd` |
| user_id | lowercase slug | `tawny` |
| app | fixed enum | `inventory` `pricetags` `spiff` `sales` `performance` `core-admin` |
| per-app role | enum | `admin` `editor` `viewer` |

## Secrets
- **Never put a secret in a shared sheet.** API keys, password hashes, session secrets live in
  the owning project's `PropertiesService` script properties.
- The sheet may store the *name* of a ScriptProperty (e.g. `stores.dutchie_key_prop`), never its value.

## Sign-on (use GX Core, don't re-implement)
Bind GX Core as a library (identifier `GXCore`) and delegate:

```js
// Login action — check credentials AND this app's access grant in one call
if (params.action === 'login') return jsonOut(GXCore.login(params.user, params.pass, 'inventory'), params.callback);

// Guard every other action
const auth = GXCore.requireAuth(params, 'inventory');
if (!auth.ok) return jsonOut(auth);        // 'Auth required' | 'Session expired' | 'Invalid session' | 'Access revoked'
// auth.user, auth.role are now available
```

- Token format is `user:exp:HMAC(user:exp, secret)`, 7-day TTL. The signing secret
  (`GC_SESSION_SECRET`) is shared across projects so a token issued by GX Core validates everywhere.
- Access is granted by adding an `active` row to GX Core `app_access` — **no code change** to add a user to an app.
- Frontend keeps its existing localStorage session (`gc_<app>_auth`) and JSONP-fallback login;
  the response shape is unchanged.

## Reading shared reference data
```js
GXCore.getStores();          // active stores, sorted
GXCore.getProducts();        // master SKU dictionary
GXCore.getEmployees();       // staff roster
GXCore.getPricetagConfig();  // active price-tag config
GXCore.getGrantsForUser(u);  // [{app, role}, ...]
```

## Writing (single-writer rule)
- Only the GX Core library writes to GX Core, always through `gxWrite_()` which takes a
  `LockService` script lock and appends an `audit_log` row. **App backends are readers only.**
- Serialize any write to a shared cursor/table — concurrent runs race and skip data.

## Retention
- **Dictionaries/rosters** (`users`, `app_access`, `stores`, `employees`, `products`,
  `pricetag_config`): current-state, overwrite in place. Prune long-dead rows yearly.
- **Append-only** (`audit_log`, contract history): hard ring-buffer cap, monthly archive.
  Never unbounded — a Google Sheet dies at 10,000,000 cells.

## GAS + deploy limits
- 6-min execution — chunk heavy jobs.
- 200 immutable versions per script, deletable only in the editor UI — only cut a version when
  backend `.gs`/`appsscript.json` actually changed (frontend ships via GitHub Pages).
- Run a node syntax/execute check before deploy to catch runtime errors a syntax check misses.
- After deploying, clear the preview's `localStorage` and hard-reload so changes show.
