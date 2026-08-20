# Handoff: FATTY joint tracker — dynamic redesign

## Overview

The Inventory app (GX 2.0, `greencross-inventory/index.html`) has a **FATTY** tab that tracks
FATTY pre-roll units on hand by harvest vintage. Today it renders: a store pill row, a row of
"Total on hand" + per-vintage count tiles, and one static stacked-area SVG with a 1M/3M/6M/1Y/All
range switch. It answers "how many do we have" but not the question the team actually asks, which is
**FIFO**: is old stock draining, is new stock building, and how fast.

This handoff redesigns that section in place — same tab, same data sources, same visual language —
adding interaction, sell-through math, and a store comparison. Nothing outside the FATTY panel changes.

## About the Design Files

The files in this bundle are **design references created in HTML** — a prototype of the intended look
and behavior, not production code to lift. `FATTY Tracker.dc.html` is a streaming "Design Component"
(a template + a small logic class, rendered by a `support.js` runtime that is NOT included and NOT
needed). Read it as a spec.

The target codebase is `greencross-inventory/index.html`: a single-file, no-build, vanilla-JS Google
Apps Script app that renders with template strings into `innerHTML`, styles with a `<style>` block of
CSS classes, and reads CSS custom properties aliased to the shared GX theme
(`https://greencrosscanna.github.io/greencross-gx-theme/gx-theme.css`).

**Implement this in that existing environment and its patterns** — extend `renderFatty()` and the
`fatty-*` CSS classes, use `var(--green)` / `var(--muted)` / `var(--border)` etc. rather than the
literal hexes the prototype inlines (the prototype inlines them only because it has no stylesheet).
Do not introduce a framework, a build step, or a chart library.

## Fidelity

**High fidelity.** Colors, type sizes, spacing, radii, and interaction behavior are final and should
be matched. The one deliberate exception is noted under *Data* below (per-store split is synthetic in
the prototype).

## Screens / Views

One view: the **FATTY panel** (`#panel-fatty` / `#fattyContent`), rendered by `renderFatty()`.
The page shell around it (sticky header, logo, Refresh/⚙ buttons, tab bar with FATTY active) is
reproduced in the prototype only for context — it already exists and needs no change.

Panel width: inside `.app` (`max-width:1400px`), panel padding `16px 20px 0`. Desktop-first; the
grids below should collapse to one column under ~900px but that is not the primary target.

### 1. Panel header row

`display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:14px`

- **Title** — 16px/700: `FATTY joint tracker` + a 12px/400 `#8a958f` suffix `· by harvest vintage · FIFO`
- **Subline** — 11px `#8a958f`, `margin-top:3px`:
  `Old stock draining, new stock building. Trend from snapshot history; updates hourly.`
- **Store pills** (right) — existing `.pill` / `.pill.store-active` styling: `padding:4px 12px`,
  `border-radius:20px`, 12px, `1px solid var(--border)`, muted text; active pill takes the store's
  own color for border + text and `color-mix(in srgb, <storeColor> 14%, transparent)` as background.
  Order: `All stores` (uses `--green`), then the six stores in `STORES` order using
  `storeDisplay()` labels and `storeColor()` colors.
- **⊞ Compare** button — same pill geometry, `margin-left:4px`; toggles the store comparison row.
  Active: green border/text, `rgba(74,222,128,.12)` background.

### 2. Hero + FIFO queue row

`display:grid; grid-template-columns:1.25fr 2.75fr; gap:12px; margin-bottom:12px; align-items:stretch`

**2a. Hero card** — `background:var(--card)`, `1px solid var(--green)`, `border-radius:12px`,
`padding:16px 18px`, flex column, `justify-content:space-between`.

- Label: 11px `#8a958f`, uppercase, `letter-spacing:.4px` — `Total on hand · all stores` (or the
  selected store's display name)
- Value: **44px/700**, `line-height:1.05`, `font-variant-numeric:tabular-nums`, `margin-top:4px`.
  Animated count-up (see Interactions).
- Row (`gap:10px`, `margin-top:6px`): WoW chip 12px/600 — `▲ +N wk` in `--green` / `▼ −N wk` in
  `--red`; then 12px `#8a958f` sell-through label: `selling 1,234/wk (4-wk sell-through)`, or
  `no depletion in window`.
- Footer, separated by `padding-top:12px; border-top:1px solid var(--border); margin-top:14px`,
  two stats `gap:18px`: **Weeks of supply** and **Est. run-out**, each an 11px `#8a958f` label over a
  20px/700 tabular value. `—` when sell-through is 0.

**2b. FIFO queue card** — `background:var(--card)`, `1px solid var(--border)`, radius 12,
`padding:14px 16px`.

- Header row: 11px uppercase `.4px` muted `FIFO queue · oldest first`; right side 11px muted
  `click a vintage to isolate it in the chart`
- `display:grid; grid-template-columns:repeat(3,1fr); gap:10px` — one tile per vintage, oldest left.
  Tile: `background:rgba(255,255,255,.03)`, `1px solid var(--border)` (→ the vintage color when that
  vintage is isolated), radius 10, `padding:12px 14px`, `cursor:pointer`,
  `transition:border-color .15s, background .15s, opacity .2s`; hover
  `background:rgba(255,255,255,.06)`; dimmed to `opacity:.45` when another vintage is isolated.
  Tile contents, top to bottom:
  1. 12px muted row: 9×9px `border-radius:2px` swatch in the vintage color + `2024 harvest`, then
     `margin-left:auto` a 10px/700 `letter-spacing:.4px` tag —
     `SELL FIRST` (green) for the oldest vintage still in stock, `BEHIND` (muted) for any vintage
     that still has older stock ahead of it, `CLEARED` (muted) at 0 units.
  2. Count: 26px/700, `line-height:1.1`, tabular, `margin:6px 0 4px`
  3. Share bar: 3px tall, `border-radius:2px`, track `rgba(255,255,255,.07)`, fill in the vintage
     color at `width = units / totalUnits`, `transition:width .4s ease`, `margin-bottom:8px`
  4. 11px row, space-between: WoW chip (green/red as above) and sell-through `−N/wk` or `flat`
  5. 11px muted, `margin-top:3px`: `clears in ~2.4 wk` / `no depletion` / `cleared`

### 3. Chart card

`background:var(--card)`, `1px solid var(--border)`, radius 12, `padding:14px 16px 10px`.

**Toolbar** (`space-between`, `flex-wrap`, `margin-bottom:8px`):
- Left: 12px muted `On hand by week`; a segmented control (`1px solid var(--border)`,
  `border-radius:999px`, `padding:2px`, two 11px buttons `padding:3px 10px` radius 999) with
  **Stacked** / **Lines** — active button `background:rgba(74,222,128,.14)`, text `--green`;
  then the existing `.fatty-range-btn` group `1M 3M 6M 1Y All` (11px, `padding:3px 9px`, radius 999,
  active: green border/text + `rgba(29,158,117,.1)`).
- Right: legend — one button per vintage, `1px solid var(--border)` (vintage color when isolated),
  radius 999, `padding:3px 9px`, 12px, 10×10 swatch + year; non-isolated vintages drop to
  `opacity:.45` and muted text, `transition:opacity .15s`.

**SVG** — `viewBox="0 0 1000 320"`, `width:100%`, `height:auto`, `display:block`.
Geometry: `padL=52`, `padR=16`, `padT=12`, plot height `216` (so plot bottom = 228).
- X domain: first visible week → the "now" point (the live current counts). No future padding —
  the plotted weeks span the full chart width.
- Y domain: `0 → max(visible weekly totals) × 1.12`.
- Gridlines at 0/25/50/75/100% of the Y max: `stroke:var(--border)`, 1px, with right-aligned 10px
  muted value labels at `x=46`.
- **Stacked mode**: one polygon per vintage, `fill-opacity:.55`, `stroke` = vintage color 1px;
  dimmed vintages go to `fill-opacity:.08`, `stroke-opacity:.25`.
  **Lines mode**: one 2px polyline per vintage (`stroke-linejoin:round`), dimmed to
  `stroke-opacity:.18`. Cross-fade both sets with `transition:fill-opacity .25s, stroke-opacity .25s`.
- **X tick labels** at `y=243`, 9px muted, `text-anchor:middle`; show every `ceil(visibleCount/9)`-th
  week as `Aug 14`, and always label the last point `now` in `--green`.
- **Weekly-change bars** — a strip under the plot: zero line at `y=272`
  (`stroke:var(--border)`), `+` / `−` 9px muted markers at `x=46`, `y=262` / `y=292`, and a 9px muted
  caption `weekly change in units on hand` at `(52, 312)`.
  One bar per visible week after the first: width `clamp(3, plotW/visibleCount × 0.55, 16)` centered
  on that week's x, height `abs(delta) / maxAbsDelta × 26`, drawn up from 272 when the change is
  positive (`--green`) and down when negative (`--red`), `rx:1`, `transform-origin` at the bar's own
  baseline with `animation: fattyGrow .45s ease both` (`@keyframes fattyGrow { from { transform: scaleY(0) } to { transform: scaleY(1) } }`).
- **Crosshair**: a 1px `#e6ece9` vertical line from `y=12` to `y=300` at the hovered week, plus dots
  (r 3.5, `stroke:#0a0e0d` 1.5) — one per vintage on its own line in Lines mode, one on the stack
  total in Stacked mode. Hidden via `stroke-opacity:0` when not hovering.

**Tooltip** — absolutely positioned inside a `position:relative` wrapper, `top:8px`,
`left` = hovered week's x as a % clamped to 12–88%, `transform:translateX(-50%)`,
`pointer-events:none`, `background:var(--bg)`, `1px solid var(--border)`, radius 8,
`padding:8px 10px`, `min-width:150px`, `box-shadow:0 6px 18px rgba(0,0,0,.5)`, opacity 0/1.
Contents: 11px muted date (`now · Aug 14` on the last point); one 12px row per vintage
(8×8 swatch, muted year, right-aligned tabular count); a 12px/700 `Total` row above a
`border-top:1px solid var(--border)` with `margin-top:5px; padding-top:5px`; then 11px muted
`+123 vs prior week` / `first week with data`.

### 4. Store comparison row (only when ⊞ Compare is on)

`margin-top:12px`, card styling as above, `padding:14px 16px`.
Header: 11px uppercase muted `Store comparison · last 12 weeks`; right 11px muted
`click a store to filter the chart above`.
`display:grid; grid-template-columns:repeat(6,1fr); gap:10px` — one card per store:
`rgba(255,255,255,.03)`, `1px solid var(--border)` (store color when that store is selected),
radius 10, `padding:11px 12px`, pointer, hover `rgba(255,255,255,.06)`. Contents: 12px/600 store
display name in the store color; 22px/700 tabular total; 11px/600 WoW chip; a
`viewBox="0 0 100 30"` sparkline of the last 12 weekly totals (1.6px stroke in the store color plus
the same path closed to the baseline at `fill-opacity:.14`); 11px muted
`oldest 2024 · 32` (or `clear`), `margin-top:4px`.

### 5. Footnote

11px muted, `margin-top:10px`:
`FIFO: oldest remaining is 2024 — 160 units, clearing in ~2.1 weeks. Weekly history reconstructed
from the tracking sheet; live counts take over at the "now" point.`
(The prototype appends a note that the per-store split is illustrative; drop that once wired to real
per-store history.)

## Interactions & Behavior

- **Store pill click** → filter every number and the chart to that store; clicking a store card in
  the comparison row does the same, and clicking the selected one returns to All stores.
- **⊞ Compare** → show/hide section 4.
- **Vintage click** (tile or legend pill) → isolate that vintage: it keeps full opacity, the others
  dim; clicking it again clears the isolation. Tile and legend must stay in sync — one shared state.
- **Stacked / Lines** → cross-fade between the two chart forms via opacity transitions on both sets
  of paths (both are always in the DOM), 250ms.
- **Range 1M/3M/6M/1Y/All** → time-based window, `days back from now`; if fewer than 2 points fall in
  the window, fall back to the last two points. Same behavior as today's `fattyChartSvg`.
- **Chart hover** → `mousemove` on the SVG: convert `clientX` to viewBox units against
  `getBoundingClientRect()`, pick the nearest visible week by x distance, show crosshair + dots +
  tooltip. `mouseleave` clears it. (No hover tracking on the bar strip; the crosshair covers it.)
- **Hero count-up** → on mount and whenever the displayed total changes (store switch), animate from
  the previous number to the new one over **550ms** with cubic ease-out
  (`1 - (1-t)³`) via `requestAnimationFrame`; cancel any in-flight animation first and on unmount.
- **Bars** → replay the `fattyGrow` scale-up on each render of a new data window.
- Everything else keeps the existing panel behavior: 30-minute cached `proxyFetch({action:'fattytracker'})`,
  the spinner state, and the retry message on failure.

## State Management

All local to the panel; today's `state.fattyStore` / `state.fattyRange` extend to:

| state | values | default | effect |
|---|---|---|---|
| `fattyStore` | `'All stores'` \| store name | `'All stores'` | filters all figures + chart |
| `fattyRange` | `1m 3m 6m 1y all` | `all` | chart x window |
| `fattyMode` | `stack` \| `lines` | `stack` | chart form |
| `fattyIsolate` | `null` \| `'2024'…` | `null` | dims other vintages |
| `fattyCompare` | boolean | `false` | store comparison row |
| `fattyHover` | `null` \| visible-week index | `null` | crosshair + tooltip |
| (internal) | animated hero number | — | count-up only, not persisted |

Persist `fattyMode` and `fattyCompare` to `localStorage` alongside the existing `LS.*` keys if you
want them sticky; `fattyHover` and the animated number must not be persisted.

### Data & math

Source is unchanged: `proxyFetch({action:'fattytracker'})` → `{stores, vintages, current, weekly:{weeks, byStore}, skuMapped, unresolvedUnits}`,
plus the `FATTY_SEED` weekly all-stores history and the live "now" point appended by
`fattyBuildSeries()`. Vintages exclude `'Unknown'`; colors from `FATTY_VCOLOR`.

- **Sell-through (per vintage)** — mean of the *declines* only, over the last `N` weeks
  (default `N=4`): `sum(max(0, prev − cur)) / N`. Endpoint differencing is wrong here: total units are
  near-flat because new harvest lands while old stock drains, so an endpoint diff reports zero
  movement. Total sell-through = sum of the per-vintage values.
- **Weeks of supply** = `total / totalSellThrough`; **Est. run-out** = `now + weeksOfSupply × 7d`,
  shown only when under ~60 weeks. `—` when sell-through is 0.
- **Clears in ~X wk** (per tile) = `units / thatVintageSellThrough`.
- **WoW** = current minus the previous weekly snapshot, for the selected store.
- **Per-store history**: the prototype fakes it by splitting the all-stores seed with fixed per-store
  weights, because `FATTY_SEED` is all-stores only. In the app, read `weekly.byStore[store]`
  (already available) for the store cards, sparklines and store-filtered chart. Treat every number in
  the store comparison row of the prototype as placeholder.

## Design Tokens

Use the app's aliases (`:root` in `index.html`), not raw hexes. Values shown are the shared GX theme.

| token | value | use |
|---|---|---|
| `--bg` / `--gx-bg` | `#0a0e0d` | page, tooltip background |
| `--card` / `--gx-surface` | `#121715` | card backgrounds |
| `--border` / `--gx-border` | `#232a27` | borders, gridlines, zero line |
| `--text` / `--gx-text` | `#e6ece9` | primary text, crosshair |
| `--muted` / `--gx-text-dim` | `#8a958f` | labels, axis text |
| `--green` / `--gx-green` | `#4ade80` | positive, active, hero border, `now` |
| `--red` / `--gx-red` | `#ef4444` | negative deltas |
| tile surface | `rgba(255,255,255,.03)` | inner tiles/cards |
| tile hover | `rgba(255,255,255,.06)` | inner tile hover |
| share-bar track | `rgba(255,255,255,.07)` | |
| active pill tint | `color-mix(in srgb, <color> 14%, transparent)` | store pills |
| segmented active | `rgba(74,222,128,.14)` | Stacked/Lines |
| range active | `rgba(29,158,117,.1)` | existing `.fatty-range-btn.on` |

Vintage colors (`FATTY_VCOLOR`, unchanged): 2022 `#9b6dff`, 2023 `#8a5cf6`, **2024 `#2a78d6`**,
**2025 `#1d9e75`**, **2026 `#eb6834`**, 2027 `#e2b13c`, 2028 `#d4537e`.

Store colors (`STORES`, unchanged): Bend/Century `#22D3EE`, Center `#3B82F6`,
Commercial `#A855F7`, Hillsboro/Baseline `#6366F1`, Portland Rd/Portland `#D946EF`,
River Rd/River `#EC4899`.

Type scale in use: 44/700 hero · 26/700 tile · 22/700 store card · 20/700 hero footer stat ·
16/700 title · 12 body & controls · 11 labels & captions · 10 uppercase tags & axis values ·
9 axis ticks. Font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`.
Radii: 12 cards · 10 inner tiles · 999/20 pills · 8 tooltip · 6 header buttons · 2 swatches & bars.
Spacing: 20 panel x-padding · 16/18 card padding · 14/12 gaps · 10 grid gap · 6/4/3 micro.
Transitions: 150ms controls · 200–250ms opacity/color · 400ms share bar · 450ms bar grow ·
550ms count-up.

## Assets

- `assets/greencross-logo.png` — copied from `greencross-inventory/GreenCross_Logo_Secondary_Simple_Green.png`
  (the app inlines it as base64 in the header; unchanged, included only so the prototype renders).
- No icons: the ↺, ⚙, ⊞, ▲, ▼, · glyphs are text, exactly as the app already does it.

## Files

- `FATTY Tracker.dc.html` — the design reference. The panel markup lives in the template; all layout
  math, sell-through math, and interaction state live in the `Component` class at the bottom of the
  file (`velocityOf`, `burn`, `series`, `onMove`, `renderVals`).
- `assets/greencross-logo.png`

Target files in the app: `index.html` → `renderFatty()`, `fattyBuildSeries()`, `fattyChartSvg()`
(~lines 8823–8990), the `.fatty-*` CSS block (~lines 807–813), and the `state.fatty*` fields
(~lines 2344–2346).
