# Build brief: widescreen UX redesign

Cut 2026-11-09 from `2026-11-09-widescreen-ux-redesign-plan.md` with the operator's
section 8 decisions. The plan holds the reasoning; this brief is the work order.

## Decisions (11-09-26)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Ads & flights | Commerce tab |
| 2 | Studio, Inbox | nav items (`/studio`, `/inbox`) |
| 3 | Ops page | build it; graphically compelling for the wide viewport |
| 4 | Chat | context rail replaces the upstream System panel on `/` |
| 5 | Type scale | larger text at `3xl` |

## Standing rules for every phase

- Branch per phase from `main` in a worktree (`sync/`-style naming: `ux/phase-N-<name>`);
  the app keeps running from the main tree. Unlink the node_modules junction before
  `git worktree remove`.
- Gate before merge: `npx vitest run`, `npx tsc --noEmit -p .`, `npm run build`,
  `uv run --inexact --extra dev ruff format --check src/ tests/` and `ruff check` if any
  Python moved (none is expected).
- Deploy: operator closes the app, `main` fast-forwards, `npx tauri build --no-bundle`,
  relaunch. A frontend change reaches the desktop only through the rebuild.
- Acceptance is in-app with the operator present. The agent never exercises a live write
  (decision, Fix it, Send, approve, pause, tier flip, refresh).
- Data path is untouched: every panel keeps its hook and feed. Moving a panel moves JSX,
  not fetches. No new bridge routes.
- Public fork: no store, persona, prospect or key data in code, tests, fixtures or
  commit messages. Scan added lines before each push.
- Visual cohesion bar: every new surface is built from `DashboardPanel`, `shared/ui`
  primitives, `PageFrame` and `Drawer`. No ad hoc panel chrome.
- Each phase ends with CHANGELOG entry, memory refresh, and the plan's section updated if
  the layout deviated.

## Phase 0: shell

Goal: the app opens at display size, uses the full width, scales its type, and every
drawer shares one shell. Pages look the same as today at 1280; at 2560 panels widen and
text grows but nothing moves yet.

Tasks

1. **Window.** Add `tauri-plugin-window-state` (Cargo.toml, `lib.rs` builder, capability
   JSON). Default to maximized on first launch. Verify the exit-lifecycle guard still
   runs (see `tauri_exit_lifecycle_bugs` in memory).
2. **Breakpoint.** `index.css`: `@theme { --breakpoint-3xl: 1920px; }`. Confirm Tailwind 4
   emits `3xl:` variants.
3. **Type tokens.** Add to `:root`: `--text-body: 12.5px; --text-cell: 12px;
   --text-tile: 15px; --text-chip: 10px; --text-title: 20px; --text-label: 10px`.
   Under `@media (min-width: 1920px)` redefine: 14 / 13.5 / 18 / 11.5 / 24 / 11.
   Replace the hard-coded `text-[12.5px]`, `text-[12px]`, `text-[15px]`, `text-[10px]`,
   `text-[20px]` in `DashboardPanel`, `shared/ui` (Chip, Tile, Quiet, Select, Segmented,
   SmallButton), the drawers and the page headers with `text-[length:var(--text-*)]`.
   Leave Chat prose and upstream pages on their own scale.
4. **PageFrame.** New `shared/PageFrame.tsx`: `flex-1 overflow-y-auto px-6 py-6` outer,
   `max-w-[2240px] mx-auto` inner, optional `narrow` (3xl max-w) for reading pages.
   Replace the per-page `px-6 py-10` + `max-w-*` wrappers in every routed page.
   Briefing and Logs pass `narrow`.
5. **DashboardPanel.** Extend `SIZE_CLASSES` with a `3xl:` span per size (hero 4) and add
   `sixth` (`col-span-6 lg:col-span-3 3xl:col-span-2`). Add `band?: 'short' | 'tall'`:
   short sets `h-[420px]`, tall `h-[860px]`, body `min-h-0 overflow-y-auto`. Add
   `headerExtra?: ReactNode` for a Segmented inside the header (tabs inside a panel).
6. **Drawer.** New `shared/Drawer.tsx` (portal to body, `fixed inset-0 z-[70]`, backdrop
   20%, Escape, `width: 'narrow' | 'wide'` = 36 / 64 rem, header with title + actions +
   close). Adopt in `DecisionsDrawer`, `G1Drawer`, `ReportsDrawer`, `StackHealthDrawer`,
   `ProspectDrawer`, `EpisodeDrawer` (Episode and Patch detail take `wide`).
7. **Freshness line.** New `Dashboard/FeedFreshnessLine.tsx`: takes the page's feed states,
   renders "Updated 3 min ago · oldest 2 h · 1 stale" with a hover list. Not yet mounted
   (pages mount it in their phase).
8. **Icons.** `RefreshCw` stays for Hermes regenerate flags; local re-fetches switch to
   `RotateCw`. Touch: `StorePerformancePanel` Regenerate.
9. **Sidebar.** Move `<nav>` above `StackHealthDock` and `LatestNewsPanel`; the docks sit
   under the nav so the nav never shifts. Add the three new nav rows (Inbox, Studio, Ops)
   behind a `ROUTES_READY` constant flipped per phase so dead routes never show.

Files: `tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`,
`src-tauri/capabilities/*.json`, `index.css`, `DashboardPanel.tsx`, `shared/ui.tsx`,
new `shared/PageFrame.tsx`, new `shared/Drawer.tsx`, six drawer files, eleven page
files, `Sidebar.tsx`.

Acceptance

- App opens maximized on the primary display and remembers a moved/resized window.
- At 2560 the Dashboard renders at 2240 content width; at 1280 it renders as today.
- Panel body text measures 14 px at 2560, 12.5 px at 1280 (devtools computed style).
- All six drawers open, close on Escape and backdrop, and portal above the Layout.
- `vitest` count unchanged or higher; two Trading tests may need the new class strings.

## Phase 1: Dashboard + Inbox

Goal: the act band is the whole Waiting view; the bell becomes a badge; read-only panels
fit in bands; no refresh flags fire on mount.

Tasks

1. `pages/InboxPage.tsx` at `/inbox`: `WaitingTabsView` full width, three lanes, two-column
   rows at 3xl, `Decisions` header button, Decisions/G1/Reports drawers open beside it.
2. `WaitingListView`: rows get a fixed height; arm/confirm controls replace the detail
   line instead of growing the row; Snooze select and Dismiss note render inline in that
   same line. Cap 16 visible + "Show all N" in place.
3. `ApprovalBell`: badge only; click navigates to `/inbox`. Delete the dropdown.
4. `DashboardPage` rows per plan 4.1: Waiting "For you" (full, short) / Daily Brief panel
   with `headerExtra` tabs Brief | Culture | Listen (half, tall) + Day Ahead (third, tall)
   + Trading summary (third, tall) / Weather (quarter, short) + Store performance (wide,
   short, per-store tabs, title link to `/commerce`) + Stack and sites (quarter, short,
   the dock's content as a panel) / telemetry row stays until Phase 5, `dim`.
5. `ListenPanel`, `CultureNewsPanel` become tab bodies of `DailyBriefPanel` (one panel,
   one speaker button). Culture caps at 8 in the band.
6. `TradingSummaryPanel`: drop positions and latest-order lines; keep warnings, meter,
   sleeve lines, "Trading view".
7. `DayAheadPanel`, `WeatherPanel`: remove the mount-time `refresh*()` calls.
8. Mount `FeedFreshnessLine` in the Dashboard header; drop the per-panel strings except
   the stale tag.

Files: new `pages/InboxPage.tsx`, `App.tsx`, `Sidebar.tsx`, `WaitingPanel.tsx`,
`WaitingListView.tsx`, `ApprovalBell.tsx`, `DashboardPage.tsx`, `DailyBriefPanel.tsx`,
`CultureNewsPanel.tsx`, `ListenPanel.tsx`, `TradingSummaryPanel.tsx`, `DayAheadPanel.tsx`,
`WeatherPanel.tsx`, `StorePerformancePanel.tsx`, `StackHealthDock.tsx`.

Acceptance

- Dashboard rows 1 to 3 fit in 1340 px at 2560 with no page scroll until the telemetry row.
- Inbox shows the three lanes; counts match the bell badge and the Dashboard act band.
- Bridge log shows no `day_ahead` / `weather` refresh flag on Dashboard mount
  (`wsl -d Ubuntu-24.04 -- docker logs --since <ts> hermes-panels`).
- Arming a Waiting row does not change the row's height or push neighbours.

## Phase 2: Commerce

Goal: Overview is KPI + Briefing + Recommendations + Ledger + Products above and at the
fold; Compliance and Ads & flights are tabs; Fixes gets class cards.

Tasks

1. `CommerceView` tabs: Overview (n open) | Fixes (n) | Compliance (n open) | Ads & flights.
   `?tab=` in the URL; `#fixes` and `#commerce-compliance` deep links map to tabs.
2. Overview rows per plan 4.2. Remove the Store `Select` in `RecommendationsQueue`.
   Recommendations: tall band, 18 visible, Show all. Ledger: third, stats + Needs you +
   In flight; "Recently decided" opens a `narrow` Drawer. Products: full, sticky header,
   all columns, 50/page. SEO health (half, short) + Merchant status (half, short,
   store-filtered, no flights).
3. New `Commerce/ComplianceTab.tsx`: `PrecheckWidget` as the first card (half, short) +
   counts card (half, short), then `CompliancePanel` findings (full). `finding <id>` chips
   in `PatchCard` link here and scroll to the rule group.
4. New `Commerce/AdsFlightsTab.tsx` per plan 5.1: flight cards (quarter each: verdict,
   scope, Merchant role, hold blockers from `MerchantPanel`'s `HoldItem`, spend vs cap
   from `spend_ledger` flight lines) / GA4 campaigns (`AdsPanel`, half, tall) + Spark
   picks (`SparkBlock` moved from `YouTubePanel`, half, tall) / top ads queries (full,
   short, dim). Reads `ecom_daily`, `merchant_status`, `content_health.ads_hold`,
   `spend_ledger`, `youtube_performance.sparks` through the existing hooks; `CommercePage`
   adds the `youtube_performance` fetch (same `fetchContentFeed` path as `ads_hold`).
5. `SpendLedgerPanel` leaves the Overview; it is mounted on `/ops` in Phase 5. Until then
   it renders at the bottom of Ads & flights under a `dim` "moves to Ops" tag.
6. `waiting-api.ts` `linkFor`: alias `spark-*` to `/commerce?tab=ads&focus=` and keep
   `spend-*` resolving on the Ads tab. `CommerceView` focus effect switches tab first.
7. Fixes per plan 4.3: header card (full, short) / patch list (wide, tall, 15 visible)
   + `ClassCards` (third, tall; one card per class with the tier toggle as primary
   action; "Table view" toggle shows the existing 19-column table full width). PatchCard
   diffs collapsed to two lines with "Expand diff" at 3xl; shortcut legend in the header.

Files: `CommerceView.tsx`, `CommerceHeader.tsx`, `CommercePage.tsx`,
`RecommendationsQueue.tsx`, `ProductsTable.tsx`, `AdsPanel.tsx`, `MerchantPanel.tsx`,
`SpendLedgerPanel.tsx`, `CompliancePanel.tsx`, `PrecheckWidget.tsx`, `FixesTab.tsx`,
`PatchCard.tsx`, `YouTubePanel.tsx` (export `SparkBlock`), new `ComplianceTab.tsx`, new
`AdsFlightsTab.tsx`, `waiting-api.ts`, `useCommerceData.ts` (add `youtube_performance`
if the hook owns it).

Acceptance

- Overview above the fold at 2560: KPI, Briefing, Recommendations, Ledger; Products starts
  at the fold.
- Products table shows every column with no horizontal scroll at 2240.
- Waiting rows for a spark swap, a spend cap and a patch each land on the right tab and
  scroll to the row (mock or already-filed rows only; no live decisions).
- Fixes tier control reachable without horizontal scroll.
- `#fixes?focus=<id>` from a Filed Waiting row still opens the patch.

## Phase 3: Content + Studio

Goal: Content is the seed/proposal loop with Approve/Reject in row 2; the studio is its
own page.

Tasks

1. `pages/StudioPage.tsx` at `/studio` per plan 5.2: header (Run studio now, last/next
   run, month spend vs cap) / channel lane cards (quarter, short; stats + Pause/Resume) /
   episode board by stage (full, tall; columns awaiting-G0, in production, rendering,
   publish, done; 8 per column, Show all; row actions on cards) / YouTube per channel
   (half + half, tall, tabbed long-form | Shorts, 10 per kind, Show all). `useStudioData`
   moves to the page; `EpisodeDrawer` (`wide`) mounts here.
2. `ContentView` per plan 4.4: Health strip + Seedbank strip (full, short, 6 to 8 lane
   cards across) / Proposals (wide, tall, 12 visible) + Thesis prompts (third, tall, 10
   visible) / Thesis lane (half, tall, per-property tabs, queue 12, Posted = count +
   link) + Performance (half, tall, tiles + long-form 15 visible) / Winners (full, short,
   8 per column, dim). `EpisodesPanel` and `YouTubePanel` unmount from Content; header
   gains a "Studio: n awaiting G0 · runway" chip linking to `/studio`.
3. `SeedComposer` opens in a `wide` Drawer. Separate notice slots for content and studio.
4. New `Content/SeedFields.tsx` shared by `ApproveEditor` and `SeedComposer` (topic,
   pillar, product, queries, priority, video, episode class, minutes, sources) with one
   validator; `episodeEditProblems` and `seedProblems` become thin wrappers.
5. `HealthStrip` gets loading and error states (`content_health` state passed in).
6. `PublishForm` title: counter and slice both 100.
7. `waiting-api.ts`: episode rows link to `/studio?focus=`; `/content?focus=<episodeId>`
   redirects (ContentPage detects `isEpisodeId` and navigates).
8. `desks-api` / `DeskCards`: content desk `pages` gains `/studio`; `contextBlock.page`
   for episode context is `/studio`. Note for the hq contract brief.

Files: new `pages/StudioPage.tsx`, `App.tsx`, `Sidebar.tsx`, `ContentPage.tsx`,
`ContentView.tsx`, `ContentHeader.tsx`, `ProposalsQueue.tsx`, `SeedComposer.tsx`, new
`SeedFields.tsx`, `HealthStrip.tsx`, `SeedbankStrip.tsx`, `ThesisLane.tsx`,
`PerformancePanel.tsx`, `WinnersPanel.tsx`, `EpisodesPanel.tsx`, `EpisodeDrawer.tsx`,
`YouTubePanel.tsx`, `useStudioData.ts`, `waiting-api.ts`, `desks-api.ts`, `DeskCards.tsx`.

Acceptance

- Content row 2 (Proposals + Prompts) is fully visible at 2560 without scrolling.
- `/studio` shows the same episodes and actions as today's panel; G0 review opens from a
  board card and from a Waiting G0 row.
- No 60 to 75 vh scroller remains in `components/Content`.
- `ApproveEditor` and `SeedComposer` render the same field set from `SeedFields`.

## Phase 4: BizDev, Trading, Desks

Tasks

1. BizDev per plan 4.5: Follow-ups (wide, short, 6 visible) + Insights funnel (third,
   short) / Pipeline board (full, tall; 10 columns at ~215 px, no horizontal overflow at
   2240; filters move into the panel header) / Research log + Engagement stats + Signal
   insights (three thirds, short, dim). Templates open in a `narrow` Drawer from the
   composer and from a header button; the Templates tab goes. `ProspectDrawer` (`narrow`
   36 rem): Outcome and Re-check directly under the header chips; Signals and History in
   `<details>`. List view adds contacts, last touch, next due columns.
2. Trading per plan 4.6: Status strip (full, short, expands in place) / three sleeve
   cards (third, tall) / Equity curve (wide, tall, chart height 420) + Events | Alerts
   (third, tall, tabbed). KILL cause appears once. Update the two Trading tests.
3. Desks per plan 4.7: Roster (six across) / Threads + Rulings (add box on top) + Tool
   trace (three thirds, tall, 20 rows) / "Configure" tab with Soul (wide) + Route and
   tools (third).

Files: `BizDevView.tsx`, `BizDevHeader.tsx`, `PipelineBoard.tsx`, `FollowUpsStrip.tsx`,
`InsightsPanel.tsx`, `Templates.tsx`, `ProspectDrawer.tsx`, `DraftComposer.tsx`,
`TradingView.tsx`, `TradingHeader.tsx`, `StatusStrip.tsx`, `SleeveCard.tsx`,
`EquityCurve.tsx`, `EventsPanel.tsx`, `TradingView.test.tsx`, `TradingReading.test.tsx`,
`DesksView.tsx`, `DesksPage.tsx`.

Acceptance

- Pipeline board shows all populated stages without horizontal scroll at 2560.
- Sleeve positions tables show seven columns without scroll at 735 px.
- Desks default view has no soul editor; Configure tab saves and reloads as today.

## Phase 5: Ops + Chat context rail

Goal: one page for operator-wide cost and machine state, built to read well at 2240; Chat
gains a context rail and loses the System panel.

Ops page (`/ops`) per plan 5.3. Decision 3: graphically compelling. Load the `dataviz`
skill before building; recharts is already a dependency. Layout:

```
Row 1 short  Stack health status band (full): FAIL / WARN / OK counts, last run, next run, Run now, sparkline of the last 30 runs
Row 2 tall   Spend burn (wide): one line per ledger period, actual vs cap as filled gauges + MTD burn curve with forecast; AWS/Bedrock MTD
             Cost by engine (third): stacked bars by engine for the month, from the Content and BizDev header cost blocks
Row 3 tall   Stack detail (half): failures, warnings, cloud events (10 + more), company sites
             Machine (half): Energy line chart, power/thermal tiles, voice worker state, trace debugger behind a tab
Row 4 short  Cost comparison (third, dim) | Listen queue state (third) | Connector status dots (third)
```

Tasks

1. New `pages/OpsPage.tsx`, new `components/Ops/*` (SpendBurn, EngineCost, StackBand,
   MachinePanel). `SpendLedgerPanel` content becomes `SpendBurn` data; the ledger tiles
   stay as a "Table" toggle. `StackHealthDrawer` content renders as the Stack detail panel
   (the drawer remains for the dock and Waiting `sites` rows, both pointing at the panel).
2. Dashboard telemetry row removed; `EnergyDashboard`, `CostComparison`, `TraceDebugger`
   mount on Ops wrapped in `DashboardPanel` (`dim`), dropping their `hud-panel` chrome.
   Energy poll 5 s only while `/ops` is mounted.
3. Chat per plan 4.8: `--chat-max-width` 880 at 3xl; new `Chat/ContextRail.tsx` (third)
   showing, for a desk thread, the context block, the desk's cards and the live tool
   trace (reuse `deskTrace` from `DesksPage`); for a plain chat the Waiting "For you"
   lane. `SystemPanel` unmounts from `ChatPage`; Ctrl/Cmd+I toggles the rail.
4. Sidebar: Stack health dock opens `/ops`; connector dots and the Daily Brief text row
   leave the dock (play button stays). `AutoFixes` stays on the Briefing page only; the
   Daily Brief panel links to it.

Files: new `pages/OpsPage.tsx`, new `components/Ops/*.tsx`, `SpendLedgerPanel.tsx`,
`StackHealthDrawer.tsx`, `StackHealthDock.tsx`, `EnergyDashboard.tsx`,
`CostComparison.tsx`, `TraceDebugger.tsx`, `DashboardPage.tsx`, `ChatPage.tsx`,
`SystemPanel.tsx`, new `Chat/ContextRail.tsx`, `index.css`, `LatestNewsPanel.tsx`,
`DailyBriefPanel.tsx`, `App.tsx`, `Sidebar.tsx`.

Acceptance

- `/ops` fills 2240 x 1340 with no page scroll until row 4.
- Spend gauges and burn curve match the ledger tiles' numbers (Table toggle).
- Dashboard has no telemetry row; Energy poll stops when leaving `/ops`.
- A desk thread shows its context and live trace in the rail; a plain chat shows the
  Waiting lane; the rail toggles with Ctrl/Cmd+I.

## Contract notes for a later hq brief (not this repo)

- Waiting feed `link.page` for spark, spend_cap and G0/episode rows: new targets
  `/commerce?tab=ads`, `/studio`. Client aliases carry the old values until then.
- Desk `pages` binding: content desk adds `/studio`; ops desk adds `/ops`.
- Nothing else in `openjarvis-hermes.md` changes; no new feeds, no new write patterns.

## Risks

- Tailwind 4 `3xl` variant generation: confirm in Phase 0 before any page work.
- `band` heights are fixed px; a feed with a long error string must truncate, not
  overflow. Add `line-clamp` to `DashboardPanel`'s error slot.
- Window-state plugin and the single-instance / tray show-hide path: test show, hide,
  quit, relaunch on both monitors.
- Moving `useStudioData` off Content changes which page polls the studio every 60 s; the
  Content header chip needs a lighter read (`fetchStudioStatus` only).
- Full-suite vitest baseline is 762 at `4f865e5d`; `renderToStaticMarkup` tests that
  match on panel class strings (two Trading files) are the only known breakage.
