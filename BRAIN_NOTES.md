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

### ✅ DONE (brain, 2026-08-08) — Backfill GX Core with 50 Inventory version_history entries

**Result:** imported all 50 → inventory `version_history` now **98 entries** (v2.54 → v1),
sorted newest-first by `deployed_at` (2025 dev entries at the bottom). Temp importer removed.
The app reads these automatically — no further action.

<details><summary>original request</summary>

**Context:** doing the "centralize the changelog" task, the app's Version History had **97** entries but
GX Core's `version_history?app=inventory` returns only **48**. GX Core is missing **50** — and not just
ancient ones: **v2.38–v2.51** are recent, meaningful releases (OOS visibility, scanner UPC fixes, Phase
3/4 perf) that only ever lived in the app's static Version History, plus pre-public-launch dev history
**v1–v36**. (GX Core also has one entry the app never had: `v2.22` — fine, leave it.)

Sky's decision: **move the deep history into GX Core so it isn't lost.** The app now reads everything from
GX Core, so once these are imported they appear in the app automatically — no app change needed.

**Ready-to-import payload (this repo):**
`greencross-inventory/brain-handoff/inventory-version-history-backfill.json`
— 50 records already in GX Core's `version_history` schema: `{version, deployed_at, deployed_by:"import",
git_sha:"", notes}`. Dates are noon-UTC ISO derived from the app's displayed dates.

**Please:** import these into GX Core's inventory `version_history` (skip any already present by version),
and ensure the cockpit sorts **newest-first by `deployed_at`** so the 2025 dev entries land at the bottom.
For v2.38–v2.51 the `notes` is a single prose string (one bullet), not multi-line — reformat into bullets
if you like; not required.

</details>

---

## Archive

- **2026-08-08 — Centralize the changelog (app side).** index.html now JSONP-fetches GX Core's
  `version_history?app=inventory` on load and renders BOTH the What's New popup and the Version History
  list from it (`loadChangelog` → `fetchVersionHistory` → `renderVersionHistory` + `checkWhatsNew`).
  Deleted the hardcoded `const CHANGELOG` array and the static `.ver-row` block (97 rows). Kept the header
  version constant. Graceful fallback: fetch fail/empty → skip What's New, show a "loading from the Command
  Center" line in Version History, never blocks the app. Verified live: 48 fetched → 48 rendered
  (v2.54→v1.36), What's New shows correct unseen versions. Follow-up handed back to the brain above
  (backfill the 50 missing entries).
