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
