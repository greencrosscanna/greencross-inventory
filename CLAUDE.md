# Inventory — GX 2.0 app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app integrates with it (binds the `GXCore` Apps Script library; reads its changelog
and forwards bug reports to it).

## Stack & local loop

**No build step — the file on disk IS the app**, so edit + reload is the whole loop.

| | |
|---|---|
| frontend | `index.html` — a **monolith with inline JS** (~10k lines), served by GitHub Pages |
| backend | `dutchie_proxy.gs` at the repo root, deployed with clasp (`.clasp.json`) |
| version | the **`APP_VERSION = 'vN.NN'` constant** in `index.html` — no `?v=` cache-buster here (there's no external `.js` to hang one on); `deploy.sh` falls back to reading this constant |
| run | `python3 serve.py` → <http://localhost:3001> (`--lan` to bind 0.0.0.0 for a kiosk/phone) |
| ship | commit → push (Pages) → `./deploy.sh` records the release to `version_history` |
| tests | no automated suite in this repo — verify against the live app |

The dev server talks to the **live** backend; `gx-dev.js` paints a banner saying so and **blocks writes
until you arm them**. `gx-preflight.sh` is installed as a **pre-push hook** and refuses to ship dev
leftovers — fixtures on, writes armed, localhost URLs, or anything tagged `@devonly`.

**Sub-apps:** Price Cards and SPIFF embed here as tabs, and their bug reports bucket to **this** app
(`app=inventory`, `tab=pricecards` / `tab=spiff`) rather than to their own streams.

**Shared files** (`deploy.sh`, `serve.py`, `gx-preflight.sh`, `.claude/gx-brain-notes.sh`) come from
**gx-theme** via `./gx-sync.sh`, filled from `.gx_app`. Edit them **there**, not here, then re-sync — a
local edit is overwritten on the next sync. This CLAUDE.md is intentionally **not** synced.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command, not copied here. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is now the **central brain-notes inbox** in GX Core (this repo's `BRAIN_NOTES.md` was retired and has now been deleted): `/gxbrain` reads notes addressed to `to_app=inventory`, resolves done ones (`resolve_note`), and
writes note-backs to any app (`add_note`). The SessionStart hook surfaces the same inbox.

App-specific facts for the sync check: app key **`inventory`** in GX Core; integrated via bug forwarding
(`gxIngestBug` + `tab`), changelog read from `version_history`, and auto-record on deploy (central
`deploy_version` endpoint + shared untracked `.gx_deploy_secret`); binds `GXCore` library **v188** (verified live via `?action=libversion`).

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) if you need its id.
