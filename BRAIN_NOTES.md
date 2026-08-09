# Brain Notes — from the GX Command Center

Coordination notes the **GX Command Center** (the "brain" — GX Core) chat left for this app's chat.
Items under **Pending** surface automatically at session start (via the SessionStart hook). Handle
one, then move it to **Archive** with the date + commit hash. This app owns the app-local UI/verify/
deploy; the brain owns the shared GX Core seam.

---

## Pending

### Auto-record deploys — use the CENTRAL endpoint (no backend action needed)

**STATUS (2026-08-08 — app side wired in `d46bccf`):** Built `deploy.sh` — it ships Inventory and records
the release to GX Core's `deploy_version` endpoint (deployed_by:"app"), reading the shared secret from
`.gx_deploy_secret` (now gitignored). VERSION comes from a new `APP_VERSION` constant in index.html.
**BLOCKED on Sky:** create `.gx_deploy_secret` (untracked) with the shared `GC_DEPLOY_SECRET` value, then
run one `bash deploy.sh` and confirm a `deployed_by:"app"` row appears via
`…?action=version_history&app=inventory`. Archive once verified. Brain's original snippet below.
When you wire auto-record on deploy (so releases post to GX Core's single release-note log without a
Command Center popup), **do NOT build your own `recordversion` backend action** — the brain hosts one
shared, secret-gated endpoint for the whole suite. Just curl it from `deploy.sh` after your clasp deploy:
```
GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
curl -sL -G "$GXCORE" \
  --data-urlencode "action=deploy_version" \
  --data-urlencode "secret=$(cat .gx_deploy_secret)" \
  --data-urlencode "app=inventory" \
  --data-urlencode "version=$VERSION" \
  --data-urlencode "sha=$(git rev-parse --short HEAD)" \
  --data-urlencode "notes=$GX_NOTES"
```
`.gx_deploy_secret` (untracked, never committed) holds the shared deploy secret = GX Core's
`GC_DEPLOY_SECRET` — ask Sky for the value. Records version-only when `GX_NOTES` is empty; pass
`GX_NOTES=$'Line 1\nLine 2'` for a notable release. Verify a deploy appears via
`…?action=version_history&app=inventory` with `deployed_by:"app"`, then archive. (This is deliberately
simpler than the old per-app pattern — one central brain endpoint, apps just call it.)

**When done:** move to ## Archive with date + commit.

---

## Notes back to the brain (action needed in GX Core / Command Center)

_(nothing outstanding)_

---

## Archive

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
