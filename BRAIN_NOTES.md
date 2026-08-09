# Brain Notes — from the GX Command Center

Coordination notes the **GX Command Center** (the "brain" — GX Core) chat left for this app's chat.
Items under **Pending** surface automatically at session start (via the SessionStart hook). Handle
one, then move it to **Archive** with the date + commit hash. This app owns the app-local UI/verify/
deploy; the brain owns the shared GX Core seam.

---

## Pending

_(nothing for this app right now)_

---

## Notes back to the brain (action needed in GX Core / Command Center)

_(nothing outstanding)_

---

## Archive

- **2026-08-08 — Auto-record deploys via GX Core's central endpoint, commit `d46bccf` (verified).**
  `deploy.sh` ships Inventory and records each release to GX Core's shared `deploy_version` endpoint
  (no per-app `recordversion` action). VERSION from the `APP_VERSION` constant; secret read from
  `.gx_deploy_secret` (untracked/gitignored; it's the shared suite-wide `GC_DEPLOY_SECRET`). Verified
  end-to-end: ran `bash deploy.sh` → GX Core `version_history` shows **v2.54 as `deployed_by:"app"`,
  sha `9e658a1`**, upserted (1 row, total still 98 — the endpoint dedupes by version). Going forward:
  bump `APP_VERSION`, run `bash deploy.sh` (or `GX_NOTES=$'…' bash deploy.sh` for a notable release).
- **2026-08-08 — Namespace the What's New seen-key, commit `d46bccf`.** `gc_wn_seen` →
  `gc_wn_seen_inventory` (same-origin GX apps share localStorage; the bare key collided with
  Leaderboard). One-time migration seeds the namespaced key from a bare Inventory (v2.x) value; foreign
  versions and an already-set key are left alone. Verified all four cases in preview. (Also added the
  `APP_VERSION` constant and pointed bug-report `appVer` at it, since the version had only lived in the
  deleted static ver-rows.)
- **2026-08-08 — Deep history backfilled into GX Core (brain).** The 50 entries GX Core was missing
  (v2.38–v2.51 + pre-launch v1–v36) were imported by the Command Center. Inventory `version_history` now
  returns **98** entries (v2.54 → v1), sorted newest-first by `deployed_at`. Verified from the app's live
  fetch route (98 present, all previously-missing versions confirmed). The app renders them automatically.
  Handoff payload kept for provenance: `brain-handoff/inventory-version-history-backfill.json`.
- **2026-08-08 — Centralize the changelog (app side), commit `783b8f8`.** index.html now JSONP-fetches GX
  Core's `version_history?app=inventory` on load and renders BOTH the What's New popup and the Version
  History list from it (`loadChangelog` → `fetchVersionHistory` → `renderVersionHistory` + `checkWhatsNew`).
  Deleted the hardcoded `const CHANGELOG` array and the static `.ver-row` block (97 rows). Kept the header
  version constant. Graceful fallback: fetch fail/empty → skip What's New, show a "loading from the Command
  Center" line in Version History, never blocks the app. Verified live.
