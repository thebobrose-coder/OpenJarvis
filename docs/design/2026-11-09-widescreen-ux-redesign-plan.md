# Widescreen UX redesign: analysis and plan (2026-11-09)

Status: analysis and plan; decisions recorded in section 8 on 2026-11-09. Build brief:
`2026-11-09-widescreen-ux-redesign-brief.md`. No code changed yet. Scope is the operator fork's
human-touchpoint pages (Dashboard, Commerce, Content, Business Development, Trading,
Desks, Chat, the sidebar docks and the Waiting drawers). Upstream pages (Settings,
Data Sources, Logs, Get Started) are noted only where they affect the shell.

## 1. Ground truth

**Viewport.** The operator's monitors are 3840x2160 panels at Windows 150% scale, so the
WebView sees exactly **2560x1440 CSS px** when maximized. Every number below is in CSS px.

| Item | Value | Source |
| --- | --- | --- |
| Viewport, maximized | 2560 x 1440 | per-monitor DPI query, 144 dpi |
| Sidebar | 260 fixed | `Sidebar.tsx:97` |
| Page padding | 24 each side, 40 top/bottom | every page: `px-6 py-10` |
| Usable content width | ~2250 | 2560 - 260 - 48 |
| Usable content height | ~1340 | 1440 - title bar - 80 padding |
| Dashboard / Commerce / Content cap | 1152 (`max-w-6xl`) | 51% of usable width |
| BizDev / Trading cap | 1800 | 80% |
| Desks cap | 1400 | 62% |
| Chat thread + composer | 720 (`--chat-max-width`) | `index.css:68` |
| Drawers | 32 / 34 / 36 / 52 rem | four separate shell copies |
| Desktop window at launch | 1280 x 800, not maximized, no size persistence | `tauri.conf.json`, no window-state plugin |
| Tailwind breakpoints used | `sm md lg` only; zero `2xl:` uses; no custom `3xl` | grep |

**Layout model today.** Every page is one `overflow-y-auto` column of stacked
`grid grid-cols-12 gap-4` rows. Almost every row holds one `full` panel; the grid exists
but is used in only six places (Dashboard halves, Ads+SEO, Recommendations+Ledger,
Proposals+Prompts, Insights+ResearchLog, Equity+Events). Panels have no height contract,
so a row is as tall as its tallest panel, and ten panels carry their own
`max-h-[60vh..75vh] overflow-y-auto` scroller inside the page scroller.

**Test coupling is low.** Only two test files assert grid classes (both Trading). The
`DashboardPanel` size enum and the pure `*View` + hook-page split mean layout can move
without touching data code.

## 2. Cross-cutting findings

1. **Half the screen is empty on the three busiest pages.** Dashboard, Commerce and
   Content render in 1152 px of 2250. BizDev and Trading allow 1800 but their lower rows
   put 4-column tables in 880 px cells.
2. **Vertical stacking of full-width panels** means the operator scrolls past read-only
   telemetry to reach write actions on Commerce (ledger Done, Precheck, tier control)
   and Content (Approve/Reject sits fourth, under Seedbank, Episodes and YouTube).
3. **Nested scrolling everywhere.** Recommendations 70vh, Proposals 75vh, Thesis prompts
   75vh, Thesis posted 60vh, Long-form table 60vh, Recent posts 60vh, G0 script 60vh,
   BizDev columns `max(60vh, 100vh-18rem)`, Waiting 26rem. On a 1340 px canvas a 75vh
   scroller is 1000 px tall inside a page that also scrolls.
4. **Uncapped lists next to capped ones** make row heights diverge: Decision ledger (no
   cap) beside Recommendations (70vh); Listen (no cap) beside Trading summary (6
   positions); Daily Brief (full digest, no clamp) beside Culture (12 articles).
5. **The same thing in two or three places.** Waiting panel = bell "For you" tab, same
   rows and same write actions. Daily Brief play control in panel and sidebar dock.
   GA4 ad cost/revenue/ROAS in KPI strip, Ads panel and Dashboard Store Performance (two
   sources). Post metrics in Performance table, Winners cards and Thesis-lane Posted.
   Thesis/episode queue counts in Seedbank strip, Thesis lane and Episodes panel.
   Trading warnings, meter, sleeves and positions on Dashboard and on Trading.
   Prospect chips on board card, drawer header and follow-up card.
6. **Spend is scattered.** Commerce Spend ledger (hq ledger, AWS/Bedrock MTD, studio
   pause), Content header "This month $X by engine", Episodes panel per-channel spend,
   Episode drawer "Checks and spend", BizDev header "This month $X", Dashboard Energy and
   Cost Comparison, Chat System panel cost comparison.
7. **The flight / ads family is split across pages.** Ads hold by flight (Commerce
   Merchant panel), Spark swap blocks (Content YouTube panel, ignores the property
   filter), spend_cap flight lines (Commerce Spend ledger), GA4 campaigns (Commerce Ads
   panel). Waiting labels the spark row "Spark swap (Google Ads)" and links into Content.
8. **Freshness is uneven and invisible.** Only recommendations (5 min), fixes (2 min),
   ads_hold (5 min), proposals (2 min), studio (60 s), pipeline (2 min), trading (60 s)
   poll. Products, SEO, briefing, compliance, merchant, spend, seedbank, health,
   performance, winners, YouTube, stats and research log are mount-time copies.
   HealthStrip has no loading or error state at all.
9. **Two Hermes refresh flags fire on every Dashboard mount** (Day Ahead, Weather)
   without operator intent. Three different "regenerate" semantics share one icon.
10. **Telemetry occupies prime or oversized position.** Weather and Day Ahead are
    `priority` in row 2. Energy polls every 5 s for the lowest-priority content. The Chat
    System panel (280 px, 3 s poll) is the only side panel in the app and shows upstream
    cost/leaderboard machinery.
11. **Four drawer shells** (Decisions, G1, Reports, Stack health) plus Prospect and
    Episode drawers duplicate the portal/backdrop/escape code at three widths.
12. **The window does not open at the display size.** 1280x800 with no persistence; the
    operator maximizes by hand every launch.

## 3. Design system for 2560x1440

### 3.1 Shell

- **Window.** Add `tauri-plugin-window-state` (or `maximized: true` in the window config).
  Remember size and monitor across launches.
- **Breakpoint.** Add a Tailwind `3xl` breakpoint at 1920 CSS px (`@theme { --breakpoint-3xl: 1920px }`).
  Everything below keeps today's `lg` behaviour, so a 1280 px dev window still works.
- **Content width.** Drop the `max-w-6xl` / `[1400px]` / `[1800px]` caps. One shared
  `PageFrame` component: `max-w-[2240px] mx-auto px-6 py-6` (padding 40 to 24 vertical;
  the 40 px top gap is dead space at this height).
- **Sidebar.** Keep 260. Move the bottom nav above the docks so it sits at a fixed
  vertical position regardless of whether Latest News renders (today the nav moves when
  the dock is data-dependent).
- **Type.** Decision 11-09-26: text scales up at `3xl`. Panel body 12.5 -> 14 px, table
  cells 12 -> 13.5 px, tile values 15 -> 18 px, chips 10 -> 11.5 px, page title 20 -> 24 px,
  via CSS variables redefined under the `3xl` media query (see the brief, Phase 0).

### 3.2 Grid and panel sizes

Keep the 12-column grid and the `PanelSize` enum, add a `3xl` tier so the same panel
declares its wide-screen span once:

| Size | today (`lg`) | proposed `3xl` | width at 2240 |
| --- | --- | --- | --- |
| full | 12 | 12 | 2240 |
| wide | 8 | 8 | ~1480 |
| half | 6 | 6 | ~1110 |
| hero | 5 | 4 | ~735 |
| third / trio / tall | 4 | 4 | ~735 |
| quarter | 3 | 3 | ~550 |
| **sixth** (new) | n/a | 2 | ~360 |

At 2240 a `third` is 735 px: wider than today's `half` (560). That is the key unlock:
most of today's `full` panels become `third` or `half` and sit three or two across.

### 3.3 Height contract (the scroll rules)

1. **One page scroll.** The page column scrolls; panels in a shared row do not exceed
   the row's declared height.
2. **Rows declare a height band.** Add a `band="short" | "tall"` prop to
   `DashboardPanel`: short = 420 px, tall = 860 px (two shorts plus gap). A panel's
   body gets `min-h-0 overflow-y-auto` only when the row declares a band. Content
   that does not fit shows a count and scrolls inside, never grows the row.
3. **Above the fold = act.** Everything with a write action on it lands in the first
   1340 px: a full-width "act band" row (short) and one tall row. Read-only panels go
   below the fold.
4. **Visible-row caps replace vh scrollers.** Lists cap at N rows (N sized to the
   band: ~8 rows in short, ~18 in tall) with "Show all N" that expands in place and
   the row re-flows; or opens a drawer for large sets (archive, recently decided).
5. **Tables wider than 8 columns are `full` only**, and get sticky headers. No table
   inside a `half` or narrower.
6. **No vh units inside panels.** Replace every `max-h-[..vh]` with the band contract.
7. **Drawers.** One `Drawer` primitive, two widths: `narrow` 36 rem (Decisions, G1,
   Reports, Stack health, Prospect) and `wide` 64 rem (Episode, Patch detail). At 2560 a
   64 rem drawer still leaves 1500 px of page visible, so drawers no longer need to feel
   modal; drop the backdrop from 40% to 20%.

### 3.4 Hierarchy rules

- Row 1 of every page is the **act band**: the page's open decisions / queue, with the
  write controls, filters and the Ask-the-desk entry. Never a header-only row.
- Row 2 is **work**: the tall panels the operator reads while deciding.
- Rows 3+ are **reference**: read-only telemetry, archives, history, with `dim`.
- Each page shows one freshness line in its header (newest and oldest feed age, stale
  count) instead of per-panel `FeedFreshness` strings everywhere; panels keep only the
  amber stale tag.
- "Regenerate" (Hermes write flag) and "Reload" (local re-fetch) get different icons.

## 4. Per-page design review

### 4.1 Dashboard

**Today.** Waiting (full) / Day Ahead + Weather / Trading + Listen / Daily Brief +
Culture / Store Performance (full) / telemetry (Energy, Cost, Trace). 1152 wide.

**Hierarchy problems.** The only write surface (Waiting) is capped at 10 rows in a
26 rem scroller whose rows expand on arm/confirm, pushing later rows out of view. The
Dispatch and Filed lanes exist only in the bell's 380 px dropdown. Store Performance is a
dense full-width read-only panel with no link to Commerce. Weather is `priority`.

**Proposed layout at 2240.**

```
Row 1 (short, act band)   Waiting: For you | Dispatch | Filed ................ full
Row 2 (tall)              Daily Brief + Culture + Listen (half, tabbed) | Day Ahead (third) | Trading summary (third)
Row 3 (short)             Weather (quarter) | Store performance (wide, per store as tabs) | Stack + sites (quarter)
Row 4 (reference, dim)    Energy (third) | Cost (third) | Trace (third)  -> leaves for Ops (5.3)
```

- Waiting becomes the full `WaitingTabsView` on the page (three lanes), two columns of
  rows at 3xl, arm/confirm controls inline without growing the row (fixed row height,
  controls replace the detail line). The bell keeps the badge and opens the Inbox page,
  not a dropdown.
- Listen folds into the Daily Brief panel as a tab; its row-per-item list is the
  aggregate of the other speakers.
- Trading summary trims to warnings + meter + sleeve lines; positions move to Trading
  (the panel already says "+N more on the Trading page").
- Day Ahead and Weather stop firing refresh flags on mount; the header Regenerate is the
  only trigger.
- Store Performance tabs per store when more than one, with a "Commerce" title link.

### 4.2 Commerce: Overview

**Today.** KPI / Briefing / Recommendations (wide) + Ledger (tall) / Products /
Ads + SEO / Merchant / Spend ledger / Compliance + Precheck. Writes: Fix it, Accept,
Reject, Done, Add note (row 3), ledger Done (row 3, 4/12), Refresh x3 (header, briefing),
Precheck Check (last row).

**Hierarchy problems.** Products (11 numeric columns + 18 rem title + 13 rem flags) scrolls
horizontally at 1152 and the only qualitative column is off-screen. Ads (half) hosts two
tables in 540 px. Merchant and Spend ledger are read-only, ignore the store switcher and
sit mid-page at full width. Compliance also ignores the store switcher and is last. Two
controls drive `selectedStore`. Two refresh paths for the briefing.

**Proposed layout at 2240.**

```
Header       store Segmented · one freshness line · Refresh menu (Data / SEO / Briefing)
Tabs         Overview (n) | Fixes (n) | Compliance (n) | Ads & flights
Row 1 short  KPI strip (wide, 6 tiles + GA4 row inline) | Briefing headline + section tabs (third)
Row 2 tall   Recommendations (wide, filters, ~18 visible, Show all) | Decision ledger (third: stats + Needs you + In flight; Recently decided -> drawer)
Row 3 tall   Products table (full, all columns fit at 2240, sticky header, 50/page)
Row 4 short  SEO health (half) | Merchant Center status (half, store-filtered, tiles + issues)
```

- The Store `Select` inside Recommendations goes; the header switcher is the one control.
- Compliance becomes a tab (it is property-wide, not store-wide) with Precheck as its own
  card at the top of that tab, not buried under the findings.
- Ads panel, Merchant "Ads hold by flight", Spend ledger flight lines and the Spark
  blocks from Content move to the new **Ads & flights** tab (section 5.1).
- Spend ledger (operator-wide ops) moves to Ops (section 5.3); Commerce keeps only the
  campaign_cap and flight alerts on the Ads tab.

### 4.3 Commerce: Fixes

**Today.** Catalog fixes (full) with Needs you / In progress / Archive, class groups with
"Approve these N" / "Confirm these N"; then Fix classes (full, 19-column table whose tier
WRITE controls live inside a horizontally scrolled cell).

**Proposed.**

```
Row 1 short  Fixes header: writer state / Pause · Resume / last run / freshness (full)
Row 2 tall   Patch list (wide, view tabs + filters, ~15 cards visible, Show all) | Fix classes (third): one card per class: store · rule · field · counts · tier toggle
Row 3        Archive stays paginated at 50, below the fold
```

- PatchCard body (diffs) collapses to two lines by default at 3xl with "Expand diff";
  the j/k/a/e/r/c hints move into the header as a visible legend.
- The 19-column class table becomes a card per class; the tier control is the card's
  primary action. The full table remains behind "Table view".
- `finding <id>` chips get a target (the Compliance tab, scrolled to the rule group).

### 4.4 Content

**Today.** Composer (when open) / Health strip / Seedbank (full) / Episodes (full) /
YouTube (full) / Proposals (wide) + Prompts (tall) / Thesis lane x N (full) / Performance
(full) / Winners (full). Nine full-width panels; writes (Approve, Edit & approve, Reject,
Used, Dismiss) sit fourth.

**Proposed layout at 2240.** Content keeps the loop; the studio leaves (section 5.2).

```
Header       property Segmented · freshness line · New seed · Run intake · Research more
Row 1 short  Health strip (as a band) | Seedbank lanes (full-width strip, 6-8 lane cards across)
Row 2 tall   Proposals: Pending | Recently decided (wide, ~12 cards visible) | Thesis prompts (third, ~10 visible)
Row 3 tall   Thesis lane (half: queue + posted, tabbed per property) | Performance (half: tiles + long-form table)
Row 4 short  Winners / Laggards (full, per property tabs)   [dim]
```

- SeedComposer opens as a wide drawer, not a row that pushes the page down; the notice
  bar gets its own slot so a studio notice is never masked by a content notice.
- `ApproveEditor` and `SeedComposer` share one `SeedFields` form component.
- HealthStrip gets loading and error states.
- YouTube channel tables go to Studio; Spark blocks go to Ads & flights.
- Post metrics appear once as a table (Performance) and once as ranked cards (Winners);
  Thesis lane "Posted" becomes a count + link to Performance filtered by lane.
- Publish form: title counter says 100, input slices at 120; align both.

### 4.5 Business Development

**Today.** Header / Pipeline | Templates tabs / Follow-ups strip (full) / Board (full,
`flex-[1_1_18rem]` columns, empties collapse to 6 rem rails) / Insights (half) +
Research log (half). Prospect drawer 34 rem.

**Proposed.** The board is the one component that already scales; let it.

```
Row 1 short  Follow-ups due (wide, cards 20-24 rem, horizontal) | Insights funnel + 3 rates (third)
Row 2 tall   Pipeline board (full): 10 stage columns at 2240 = ~215 px each with no overflow; filters in the header
Row 3 short  Research log (third) | Engagement stats (third) | Signal insights (third)   [dim]
```

- Templates become a drawer from the composer ("Manage templates") instead of replacing
  the board.
- Prospect drawer: 36 rem; Outcome buttons and Re-check move up under the header chips
  (they are the write actions), Draft and Contacts follow, Signals and History fold.
- List view adds the columns the card already has (contacts, last touch, next due).

### 4.6 Trading

**Today (1800).** Header / Status strip (folded row or three `third` cards) / Sleeve cards
(trio or half) / Equity curve (full, 220 px tall) + Events (half) + Alerts (half).

**Proposed (2240, read-only stays read-only).**

```
Row 1 short  Status strip (full, folded; expands in place)
Row 2 tall   Sleeve cards: 3 x third at 735 px each; positions table fits without scroll
Row 3 tall   Equity curve (wide, 420 px tall) | Events + Alerts (third, tabbed)
```

- Dashboard Trading summary drops the positions list; the page is one click away.
- KILL cause/time shows once (status strip), not three times.

### 4.7 Desks

**Today (1400).** Roster row / Soul (wide) + Route and tools (tall) / Rulings (half) +
Threads (half) / Tool trace (full, uncapped).

**Proposed (2240).** Threads and trace are what the operator uses; soul and tools are
configuration.

```
Row 1 short     Roster (6 cards across)
Row 2 tall      Threads (third, New thread) | Rulings (third, add box on top) | Tool trace (third, ~20 rows, live)
Tab "Configure" Soul editor (wide) | Route and tools (third)
```

### 4.8 Chat

**Today.** 720 px thread centred; System panel 280 px (3 s poll) on the right; desk
identity in the top bar.

**Proposed.** Chat stays narrow for reading, and the empty width becomes useful:

- `--chat-max-width` 720 to 880 at 3xl.
- A right **Context rail** (third, ~700 px) replaces the System panel on the Chat page:
  for a desk thread it shows the context block, the desk's cards and the live tool trace;
  for a plain chat it shows the Waiting "For you" lane. System telemetry moves to Ops.
- The System panel's cost/leaderboard content is upstream machinery and leaves the
  touchpoint pages.

### 4.9 Briefing, Logs, Settings, Data Sources

Keep their widths (reading pages). Briefing's `max-w-3xl` is right for prose. Apply the
`PageFrame` padding only.

## 5. New homes for functions outgrowing their panel

### 5.1 Ads & flights (new Commerce tab, candidate for its own nav item later)

Gathers: GA4 campaign table and top queries (AdsPanel), Ads hold by flight (MerchantPanel
lower half), Spark swap blocks (YouTubePanel), spend_cap / campaign_cap flight lines and
alerts (SpendLedgerPanel), Merchant disapproval counts that gate the hold.

```
Row 1 short  Flight cards: one per flight: verdict · scope · Merchant role · hold blockers · spend vs cap (quarter each)
Row 2 tall   GA4 campaigns (half) | Spark picks per flight (half, the operator's swap list)
Row 3 short  Top ads queries (full) [dim]
```

Waiting deep links: today `spark-<flight>` resolves on `/content` and `spend-<line>` on
`/commerce`. `link.page` comes from Hermes's waiting feed, so moving them needs either a
client-side alias (keep `/content?focus=spark-*` and `/commerce?focus=spend-*` resolving
by redirecting to the tab) or a contract note. Recommend the alias first; contract change
in a later hq brief.

### 5.2 Studio (new page, `/studio`)

EpisodesPanel + EpisodeDrawer + LaneQueue + HeldSeeds are 1,500 lines with their own hook,
60 s poll, run/pause controls and a six-section G0 review. They are a product, rendered as
one panel. YouTube channel tables (long-form, Shorts, visibility, Postiz) belong with it.

```
Header       Run studio now · last run · next run · month spend vs cap
Row 1 short  Channel lane cards: queued · in production · published 30 d · runway · paused toggle (quarter each)
Row 2 tall   Episode board by stage (full): awaiting-G0 · in production · rendering · publish · done; cards carry the row actions
Row 3 tall   YouTube: long-form (half) | Shorts (half) per channel, tabbed
Drawer       Episode (wide 64 rem): G0 review or episode info, content unchanged
```

Content keeps a one-line "Studio: n awaiting G0 · runway" chip in its header linking to
`/studio`. Waiting's G0 rows link to `/studio?focus=<id>` (alias `/content?focus=<episode>`
redirects). Desk binding: the content desk's `pages` list gains `/studio`
(`contextBlock.page` in desks-api).

### 5.3 Ops (new page, `/ops`, replaces the Dashboard telemetry row and the Chat System panel)

Operator-wide cost and machine state, none of it store- or property-scoped:

- Spend ledger (hq ledger periods, AWS/Bedrock MTD + forecast, studio pause alerts)
- Cost by engine (Content header, BizDev header "This month")
- Stack health (the drawer's content as a panel: failures, warnings, cloud events,
  company sites) with Run now
- Energy, Cost comparison, Trace debugger (local LLM telemetry), System panel stats
- Voice worker / Listen queue state

The sidebar Stack health dock stays as the one-line indicator and opens `/ops`.
Decision 11-09-26: build it, and make it graphically compelling for the wide viewport
(gauges, burn curves, timelines; recharts is already a dependency).

### 5.4 Inbox (Waiting as a page, `/inbox`)

The bell dropdown is the only place the Dispatch and Filed lanes are visible, in 380 px.
Make Waiting a page with the three lanes at full width and the Decisions, G1 and Reports
drawers opening beside it. The Dashboard keeps the "For you" lane as its act band; the bell
badge opens `/inbox`. This removes the panel/bell duplication (one `WaitingTabsView`, one
set of row actions).

### 5.5 Smaller moves

- Precheck widget to the top card of the Compliance tab (it is a tool, not a finding).
- Templates to a drawer from the composer (BizDev).
- Soul editor + Route and tools to a Desks "Configure" tab.
- Daily Brief "Latest" row in the sidebar dock: keep the play button, drop the duplicate
  text; connector dots go to Ops.
- AutoFixes (digest auto-applied patches with Revert) appears on the Dashboard Daily Brief
  and the Briefing page; keep one (Briefing page) and link from the digest panel.

## 6. Pagination and cap table (proposed)

| Surface | today | proposed |
| --- | --- | --- |
| Waiting on you | 10 rows, 26 rem scroller, "N more" opens the bell | lane tabs, 2-col rows at 3xl, 16 visible, Show all in place |
| Recommendations | all, 70vh scroller | 18 visible (tall band), Show all; filters in header |
| Decision ledger recent | all, no cap | 5 visible + "Recently decided" drawer |
| Products | 50 / Show more | 50 / Show more, sticky header, all columns visible at 2240 |
| Fixes Needs you / In progress | all | 15 visible, Show all; Archive 50/page unchanged |
| Proposals pending / decided | all, 75vh scroller | 12 visible, Show all |
| Thesis prompts | all, 75vh | 10 visible |
| Thesis lane queue / posted | queue uncapped, posted 60vh | queue 12, posted = count + link |
| Performance long-form / recent | 60vh / 30 | 15 visible, sort kept, Show all |
| Winners / Laggards | all | 8 per column, Show all |
| YouTube tables | all 28-day uploads | 10 per kind, Show all (on Studio) |
| Episodes | open all + 3 done | board columns, 8 per column, Show all |
| Pipeline board columns | `max(60vh,100vh-18rem)` | tall band; count in column header |
| Follow-ups strip | horizontal, uncapped | 6 visible, horizontal scroll with count |
| Trading events / alerts | last 20 / 24 h | unchanged, tabbed in one third |
| Desks trace | 30, no scroll | 20 visible in tall band |
| Culture articles | 12 | 8 in short band, tabbed with Brief |
| Sidebar breaking rows | 3 (1 under 900 px height) | unchanged |

## 7. Phasing

Each phase ships on its own branch via the worktree recipe, with `npx vitest run`,
`npx tsc --noEmit -p .`, `npm run build`, then the Tauri rebuild and relaunch. In-app
acceptance per phase with the operator present; no live writes exercised by the agent.

**Phase 0: shell (no visible page changes).**
`tauri-plugin-window-state`; `3xl` breakpoint; `PageFrame`; `DashboardPanel` gains the
`3xl` span tier, the `sixth` size and the band prop; one `Drawer` primitive adopted by the
six drawers; `FeedFreshness` header line component; separate Regenerate / Reload icons.
Files: `tauri.conf.json`, `Cargo.toml`, `lib.rs`, `index.css`, `DashboardPanel.tsx`, new
`shared/PageFrame.tsx`, new `shared/Drawer.tsx`, the six drawer files, all page wrappers.
Acceptance: every page renders as today at 1280 and uses the width at 2560.

**Phase 1: Dashboard + Inbox.** Section 4.1 layout; `/inbox` page; bell opens the page;
Listen folds into Daily Brief; mount-time refresh flags removed. Files: `DashboardPage`,
`WaitingPanel`, `WaitingListView`, `ApprovalBell`, `TradingSummaryPanel`, `ListenPanel`,
`DailyBriefPanel`, `DayAheadPanel`, `WeatherPanel`, new `pages/InboxPage.tsx`, `Sidebar` nav.

**Phase 2: Commerce.** Sections 4.2 and 4.3; Compliance and Ads & flights tabs; Spend
ledger moves out behind a flag until Ops exists. Files: `CommerceView`, `CommerceHeader`,
`RecommendationsQueue`, `ProductsTable`, `AdsPanel`, `MerchantPanel`, `SpendLedgerPanel`,
`CompliancePanel`, `PrecheckWidget`, `FixesTab`, `PatchCard`, new
`Commerce/AdsFlightsTab.tsx`; waiting-api alias for `spend-*`.

**Phase 3: Content + Studio.** Sections 4.4 and 5.2; `SeedFields` shared form; YouTube and
Spark relocate; `/studio` route; desk page binding; waiting-api aliases for episode and
spark focus. Files: `ContentView`, `ContentHeader`, `ProposalsQueue`, `SeedComposer`,
`HealthStrip`, `ThesisLane`, `PerformancePanel`, `WinnersPanel`, `EpisodesPanel`,
`EpisodeDrawer`, `YouTubePanel`, new `pages/StudioPage.tsx`, `hooks/useStudioData`,
`desks-api`, `Sidebar` nav.

**Phase 4: BizDev, Trading, Desks.** Sections 4.5 to 4.7. Files: `BizDevView`,
`PipelineBoard`, `FollowUpsStrip`, `ProspectDrawer`, `Templates`, `TradingView`,
`EquityCurve`, `EventsPanel`, `StatusStrip`, `DesksView`; two Trading tests update.

**Phase 5: Ops + Chat rail.** Sections 5.3 and 4.8. Files: new `pages/OpsPage.tsx`,
`SpendLedgerPanel` (moved), `StackHealthDrawer` content as a panel, `EnergyDashboard`,
`CostComparison`, `TraceDebugger`, `ChatPage`, `SystemPanel` (retired from Chat), new
`Chat/ContextRail.tsx`, `index.css` chat width.

**Contract touch points** (hq brief, not code here): `link.page` values in the waiting
feed for spark, spend and episode rows once aliases are in; desk `pages` binding for
`/studio`; nothing else changes in the data path. All new pages read existing feeds
through `hermes_panel.py`; no new bridge routes.

## 8. Decisions for the operator

1. Ads & flights: a Commerce tab (recommended first) or its own nav item. - **DECISION 11-09-26** make it in the tab
2. Studio and Inbox as nav items (recommended) versus tabs under Content and Dashboard.**DECISION 11-09-26** yes, nav items
3. Ops page: build it (recommended, it absorbs six scattered spend/telemetry surfaces) or
   keep telemetry on the Dashboard below the fold.**DECISION 11-09-26** build the ops page, make it graphically compelling to utilize the larger viewport
4. Chat context rail versus keeping the upstream System panel.**DECISION 11-09-26** agree
5. Type scale: hold 12.5/13 px (recommended) or bump table text at 3xl.**DECISION 11-09-26** yes, make the text larger to take advantage of the larger veiwport
