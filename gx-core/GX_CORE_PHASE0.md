# GX Command Center — Phase 0: Foundation

Status: **bootstrapped — sheet live, tabs + seed created.** Phase 0 foundation complete. This
folder is the GX Core library + docs; a **separate Apps Script project** from the Inventory proxy,
excluded from Inventory's `clasp push` (see `.claspignore`).

**GX Core script id:** `1sfa3quXRgk6JiDzsHgzG7DgMaxN9XJv2LnNapAT2gCss0ghblufvOTjP`
[open editor](https://script.google.com/d/1sfa3quXRgk6JiDzsHgzG7DgMaxN9XJv2LnNapAT2gCss0ghblufvOTjP/edit).
Managed via clasp from `gx-core/` (its own `.clasp.json`).

**GX Core sheet id:** `1csXotT42aP-rdd91eY2aXhb_uqAHU3_W08os2L5RfM0`
([open](https://docs.google.com/spreadsheets/d/1csXotT42aP-rdd91eY2aXhb_uqAHU3_W08os2L5RfM0/edit)),
stored in the script property `GX_CORE_SS_ID`. Share read-only with app owners (Tawny/Shawn/Mike).

## Objective & mental model (aligned with Sky)

Turn five separate island apps (Inventory, Price Tags, SPIFF, Sales, Performance) into **one
connected system**. GX Core is the **hub**; the apps are **spokes** that read shared truth and
authenticate against it. The goal: same facts everywhere, access managed in one place, clean
app-to-app handoffs, and eventual retirement of the legacy "2026 GX2 Dashboard".

- **Master Control** = Sky's own admin cockpit (the `core-admin` app): app-launcher tiles **plus**
  the global settings every app inherits — store name mapping, color coding, shared variables.
  Those settings live in GX Core (`stores`, `kv`); Master Control is where Sky edits them.
- **Access management = Sky only, for now.** No delegated granting. Managers run apps; Sky runs managers.
- **Data-ownership model (important):** GX Core owns each person's/thing's **shared identity**;
  each app owns its **own slice** of extra attributes, keyed by the shared id.
  - Central roster holds employment `status` (active|terminated). Terminated ⇒ gone from ALL apps.
  - Leaderboard-only "hide from board" + "Employee of the Month" are **Leaderboard-app-local**
    (live in Mike's app, keyed by `employee_id`) — NOT in GX Core.
  - Tawny's SPIFF **reads** employee data; it doesn't write the roster.
- **Future connectors (not built):** SwipeClock (time tracking) → Leaderboard incentive; a later
  payroll migration, possibly a Payroll child app. `employees` carries stable ids now so these map
  in cleanly later (add `swipeclock_id` / `payroll_id` columns when the time comes).

Locked decisions (Phase 0):
1. Password hashes live in **GX Core ScriptProperties only** (salted, upgraded on next login). The
   shared sheet holds identity + grants, never secrets.
2. SSO uses **Apps Script library binding** — apps call `GXCore.login()` / `GXCore.requireAuth()`.
3. GX Core owns the **master product/SKU dictionary**; Inventory reads from it (migrate in Phase 1).

## GX Core sheet schema ("Green Cross — GX Core")

| Tab | Purpose | Columns |
|---|---|---|
| `users` | login identities (no password) | user_id, display_name, email, status, employee_id, default_store, is_superadmin, created_at, updated_at, notes |
| `app_access` | per-app grants — "the shared user list" | user_id, app, role, status, granted_by, granted_at |
| `stores` | canonical stores (supersedes `Config - Stores`) | store_id, display_name (internal), dutchie_name, region, short_code, sort_order, color, timezone, is_dc, dutchie_key_prop, active |
| `employees` | staff roster (SPIFF / leaderboard / attribution) | employee_id, full_name, home_store, dutchie_employee_id, role_title, status, hire_date, user_id, updated_at |
| `products` | master SKU dictionary (grows from `Product SKU Dict`) | sku, product_name, brand, category, subcategory, size, uom, dutchie_product_id, upc, status, source, updated_at |
| `pricetag_config` | shared price-tag config (queue stays in the Price Tags engine) | config_key, scope, template, fields_json, value, active, updated_at |
| `audit_log` | single-writer trail (ring buffer, 5,000 rows) | ts, actor, tab, row_key, action, detail |
| `kv` | misc shared flags/constants | key, value, notes, updated_at |

- `app` ∈ inventory · pricetags · spiff · sales · performance · core-admin
- per-app `role` ∈ admin · editor · viewer
- `is_dc` = TRUE for River Rd (distribution hub)
- **Provisional:** `pricetag_config` columns finalize once we review the `PRICETAGS_ENGINE`
  project (it has its own `/exec` + print queue).

## Single-writer rule (with designated-writer exception)
Every physical write to GX Core happens inside the GX Core library via `gxWrite_()` (LockService
lock + `audit_log` append) — nothing races. On top of that:
- **Most tables are admin-write** (Sky via Master Control): `users`, `app_access`, `stores`,
  `products`, `pricetag_config`, global settings.
- **A few tables have one designated writer app** that calls a specific `GXCore.*` function the
  library authorizes (e.g. SPIFF → the payout figures Performance later reads; a controlled
  employment-status setter). The write still runs inside GX Core.
- **App-specific attributes are NOT in GX Core** — they live in the owning app's own sheet, keyed
  by the shared id (e.g. Leaderboard's hide-flag + Employee of the Month).
- Everyone else is a reader (`GXCore.getStores()`, `.getProducts()`, `.getEmployees()`, …).
- Column changes to any shared/contract tab update both sides in one change.

## Retention
- Dictionaries/rosters overwrite in place → bounded; prune long-dead rows yearly; honor the
  10M-cell cap.
- `audit_log` is a 5,000-row ring buffer, swept by `gxRetentionSweep()` (weekly trigger).

## Build & deploy checklist
1. Create a new standalone Apps Script project (name it **GX Core**) — separate from Inventory.
2. Add `gx_core.gs` to it (`clasp` in this folder with its own `.clasp.json`, or paste in editor).
3. Run **`gxBootstrap()`** from the editor → creates the sheet, tabs, seeds stores + `sky` superadmin.
   Log prints the sheet URL. Share the sheet read-only with the app owners.
4. **Migrate the session secret** so live sessions survive: copy the Inventory proxy's
   `GC_SESSION_SECRET` script-property value into GX Core's script properties (same key).
5. **Seed users:** in the Inventory proxy editor, log the `gc_users` value; then in GX Core run
   `gxImportInventoryUsers_(<that JSON>)`. Hashes import as legacy and salt-upgrade on first login.
6. **Seed grants:** for each current user run `gxGrantAccess('<user>','inventory','editor','sky')`
   (and `admin` for Tawny/Sky as appropriate).
7. Deploy GX Core as a library version; note the Script ID.

## Shared sign-on plan — lifting Inventory's login

Goal: Inventory authenticates through GX Core with **zero frontend changes and no forced
re-login**. Enabled by identical token format + the migrated secret.

Current Inventory auth (to be replaced by delegation):
- `loginUser()` (dutchie_proxy.gs:4606) — SHA-256 compare against ScriptProps `gc_users`, issues token
- `requireAuth_()` (:4602) — validates `token` on every action
- Token: `issueSessionToken_()` (:4584), format `user:exp:HMAC(...)`, secret `GC_SESSION_SECRET`
- Frontend: `attemptLogin()` (index.html:9459), localStorage `gc_inv_auth`, JSONP fallback — **unchanged**

Delegation edit in `dutchie_proxy.gs` (Phase 1, after adding GX Core as library `GXCore`):
```js
// Router: replace the login branch
if (params.action === 'login') return jsonOut(GXCore.login(params.user, params.pass, 'inventory'), params.callback);

// requireAuth_ becomes a one-line delegate
function requireAuth_(params) { return GXCore.requireAuth(params, 'inventory'); }
```
The old `loginUser` / `hashPass` / `issueSessionToken_` / `validateSessionToken_` / `sessionSecret_`
in the proxy become dead code once delegation is verified — remove them in the same Phase 1 change.
Response shape (`{ok, user, token, expiresAt}`) and error strings are preserved, so
`attemptLogin()` and `proxyFetch()`'s "Session expired → reload" path keep working as-is.

Then (Phase 1 proper) point Inventory's `stores` and SKU reads at `GXCore.getStores()` /
`GXCore.getProducts()`. Sales & Performance repeat the same delegation in Phase 2.

## What's NOT done here (later phases)
- Creating the actual Apps Script project + running bootstrap (needs your Google account).
- Migrating the secret / importing users / seeding grants (steps 4–6 above).
- Editing `dutchie_proxy.gs` to delegate (that's **Phase 1** — don't jump ahead).
