# Brain Notes — from the GX Command Center

Coordination notes the **GX Command Center** (the "brain" — GX Core) chat left for this app's chat.
Items under **Pending** surface automatically at session start (via the SessionStart hook). Handle
one, then move it to **Archive** with the date + commit hash. This app owns the app-local UI/verify/
deploy; the brain owns the shared GX Core seam.

---

## Pending

### Centralize the changelog — read it from GX Core, delete the local copies

**Why:** release notes must live in ONE place. GX Core is now the single source (authored in the
Command Center's version popup → "+ Add release note"). This app currently keeps **two** hardcoded
copies of the same info — remove both and read from GX Core instead.

**Source (public, no auth, no library binding needed):**
```
https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec?action=version_history&app=inventory&callback=FN
```
Returns JSONP: `{ ok:true, app:"inventory", history:[ {version, deployed_at, deployed_by, git_sha, notes}, ... ] }`
(newest first). `notes` is a string of newline-separated bullets (split on `\n`).

**The two local copies to remove (both in index.html):**
1. `const CHANGELOG = [ {v, date, items:[]} ... ]` (~line 7428) — powers the **"What's New"** popup.
2. The static `<div class="ver-row">…</div>` block (~line 1690) — the **"Version History"** list.

**Steps:**
1. On load, JSONP-fetch the route above (cross-origin from github.io; use the script-tag + `callback`
   pattern). Adapt each entry → the shapes the two render sites expect: `version`→`v`,
   `deployed_at`→a `Mon D, YYYY` date, `notes.split('\n')`→`items` bullets.
2. Point the **"What's New"** popup at the fetched data (keep the existing "new since last login"
   logic against `gc_wn_seen` — it now runs after the fetch resolves).
3. Render **"Version History"** from the fetched data (convert the static `.ver-row` HTML to
   JS-rendered rows).
4. **Delete** the `CHANGELOG` array and the static `.ver-row` block — that's the duplication.
5. **Keep** the app's own version-NUMBER constant (the header's "v2.54") — that's the running
   version identifying itself, not changelog data.
6. **Graceful fallback:** if the fetch fails/returns empty, skip the What's New popup and don't block
   the app.
7. **Verify in the running app:** the What's New popup + Version History show the same entries as the
   Command Center cockpit for Inventory (click the Inventory version pill there to compare). Then deploy.

**Going forward:** when you ship a version, bump the header version constant here, and add that
version's note ONCE in the Command Center version popup. This app only reads notes now.

---

## Archive

_(move completed items here with date + commit)_
