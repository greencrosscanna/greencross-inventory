# gx-core/

The **GX Core** shared library + docs for the Green Cross Command Center. This is a **separate
Apps Script project** from the Inventory proxy — it is intentionally excluded from Inventory's
`clasp push` (`gx-core/` is in `.claspignore`) so its `.gs` never deploys into the Inventory script.

| File | What it is |
|---|---|
| `gx_core.gs` | The GX Core library: schema bootstrap, salted credentials, sessions, grants, single-writer helper, reference readers. Bind into apps as `GXCore`. |
| `GX_CORE_PHASE0.md` | Phase 0 record: schema, single-writer/retention rules, and the shared sign-on migration plan for Inventory. **Start here.** |
| `gx-conventions.md` | Reusable conventions doc for every app chat. |

## To stand this up
See the build & deploy checklist in `GX_CORE_PHASE0.md`. Short version: create a standalone
Apps Script project named "GX Core", add `gx_core.gs`, run `gxBootstrap()`, migrate
`GC_SESSION_SECRET`, import users, seed grants.

To manage it with clasp, give this folder its own `.clasp.json` pointing at the GX Core script id
(do **not** reuse the Inventory script id in the repo root).
