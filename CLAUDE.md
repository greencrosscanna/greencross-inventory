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
| ship | commit → push (Pages) → `./deploy.sh` records the release to GX Core's `app_versions` |
| tests | `tests/*_test.js`, run by the pre-push hook via `gx-preflight.sh`; a failure blocks the push. Run one with `node tests/<name>_test.js`. Still verify against the live app — see below |

The dev server talks to the **live** backend; `gx-dev.js` paints a banner saying so and **blocks writes
until you arm them**. `gx-preflight.sh` is installed as a **pre-push hook** and refuses to ship dev
leftovers — fixtures on, writes armed, localhost URLs, or anything tagged `@devonly`.

**A green suite is not a verified app here.** Every suite in this repo reads the source as TEXT — they
assert that a call site is bounded, that a helper exists, that a pattern is absent. None of them runs
the page, so a screen stuck on "Loading inventory…" passes every test. **Open the app signed in before
calling anything done** — `python3 serve.py`, or the deployed page with a `?cb=` cache-buster.

**Sub-apps:** Price Cards and SPIFF embed here as tabs. A bug filed from the Price Cards tab goes to
`app=pricecards, tab=pricetags` (`TAB_TO_APP` in `dutchie_proxy.gs`); everything else, the SPIFF tab
included, files as `app=inventory`. Add a sub-app to that map when it gets its own key.

**GX Core reads one of our tabs.** Since GX Core v377 (hub PRs 113/114, 2026-11-16) Core reads the
`Product SKU Dict` tab in the "Green Cross — Inventory Data" spreadsheet, read-only and by name, to name
sales of retired products it can't name any other way. Don't rename or move that tab, reorder its
`productName, sku` columns, or prune its rows without telling core-admin first: nothing would error, and
those sales would silently drop out of every app's name-matched counts (Inventory's FATTY supply card
undercounted by ~40 a week before this existed).

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
(`gxIngestBug` + `tab`), changelog read from the `version_history` route (tab `app_versions`), and auto-record on deploy (central
`deploy_version` endpoint + shared untracked `.gx_deploy_secret`); binds the `GXCore` library. **The pinned version is deliberately not written here** — ask the running app (`?action=libversion`) or run `./gxpins.sh --live` from the hub; a written version goes stale.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) when you need its id for the `curl` — but **refer to it by its `title`, never its id**. `job_mtg9vyxs_ewd9` means nothing to Sky; every job carries the to-do text in the same response the id came from, so say that instead, summarized if it's long ("the employee email column"). Same for `bug_…` and note ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** — re-fetch `action=whats_next` (the board moved while you worked) and let Sky pick by number rather than from memory.


## The HUB is core-admin's — send a note, don't edit (rule from Sky, 2026-09-02 · applied here 2026-09-06)

**Never edit `greencross-command-center` or `greencross-gx-theme` from this chat.** Both belong to
core-admin. It is here because it was broken: two sessions sharing one Dropbox checkout once shipped an
unreviewed GX Core change as library v284, with nothing failing and nothing warning.

Two sessions cannot share a git checkout. Neither can see the other, `git checkout -b` is not atomic
against a second process, and the loser finds out afterwards by reading the log.

**So from Inventory: `add_note` to `core-admin` with what you need and why, and stop.** Requests are welcome
and quick, and the hub session holds the repo alone while it works.

**Where the line is, because over-applying this is its own failure:**

- **Reading the hub is fine and often necessary** — `gx_core.gs` is the source of truth for every
  route Inventory calls, and guessing a payload shape instead of reading it is how this suite invented a
  `spiff_payouts` tab that never existed. Read freely; run `./gxpins.sh`; diff against it.
- **Calling GX Core's HTTP routes is not editing it.** `deploy.sh`, `gxengine.sh`, `set_config`,
  `bug_update`, `resolve_note`, `add_note` and the rest are the documented interface, secret-gated and
  designed for exactly this. Changing a *setting* through `set_config` is a config change Inventory owns;
  changing *code* is not.
- **Do not restyle a shared component from inside Inventory either.** A local rule that beats `.gx-btn-green`
  wins here and silently diverges from the other five — that is how the suite ended up with six
  different login screens. The test is *"should all six get this?"*
- **Inventory's own engine and repo are still yours.** `clasp push` / `./deploy.sh` here touch only this app.
