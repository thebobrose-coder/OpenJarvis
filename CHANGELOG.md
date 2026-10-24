# Changelog

All notable changes to OpenJarvis are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

**Apple Foundation Models (AFM 3)** — a new in-process `afm` engine drives
Apple's `apple-fm-sdk` directly, with no HTTP hop and no second process whose
CPU draw would land inside the same energy measurement window. Install with
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer uv sync --extra afm`
(the SDK compiles Swift bindings, so a full Xcode is required), then
`jarvis ask --engine afm --model afm-3-core "..."`. Requires an Apple Silicon
Mac on macOS 26+ with Apple Intelligence enabled.

Token counts are real, via `SystemLanguageModel.token_count` (added in SDK
0.2.1, hence the floor). Because `token_count` rejects a value and
instructions together, both ends are measured against the session transcript:
`prompt_tokens = <transcript before> + <prompt alone>` and
`completion_tokens = <transcript after> - prompt_tokens`.

Two caveats worth reading before comparing AFM numbers to other backends:
`stream_response` yields cumulative snapshots batching roughly 8-10 tokens, so
`ttft` is time-to-first-*chunk* (~450 ms on an M1 Pro) and derived
inter-token latencies are inter-chunk; and the SDK exposes no variant
selector, so `afm-3` / `afm-3-core` / `afm-3-core-advanced` are run labels
only — the framework's dynamic profile chooses what actually executes.
Bench results record `metadata["engine_info"]` (SDK version, context size,
host chip) so a run can be attributed after the fact.

**Eval results record which rail did the work.** Result rows and summaries
previously carried only `energy_joules` and `power_watts`, so nothing in an
eval artifact distinguished a Neural Engine run from an idle GPU, or a
hardware measurement from a modelled estimate. Rows now include the per-rail
breakdown (`cpu`/`gpu`/`dram`/`ane`/`soc`), `energy_basis`, and
`energy_method`; summaries add `energy_joules_by_rail` alongside both. On a
ToolCall-15 run against AFM the ANE rail is the largest single component —
91.7 J of 223.7 J, against 3.0 J on the GPU — which is now visible in the
file rather than only through live instrumentation.

**ANE and whole-SoC energy** — `EnergySample.ane_energy_joules` existed but
died at the monitor boundary. Apple Neural Engine and a whole-SoC total now
flow through `TelemetryRecord`, the SQLite schema (with an `ADD COLUMN`
migration), the aggregator, `TelemetrySession`, eval `TurnTrace`/`QueryTrace`,
and bench metadata, alongside an `energy_basis` marker (`"soc"` on Apple
Silicon, `"gpu"` elsewhere) so downstream repeats the monitor's choice instead
of guessing. This matters because AFM runs predominantly on the ANE: measured
on an M1 Pro, one generation drew 0.98 J on the ANE against 0.014 J on the
GPU rail — 70x — where an MLX matmul on the same machine drew 8.99 J on the
GPU and nothing on the ANE.

**Vision input for `jarvis ask`** — attach images to a query with
`-i`/`--image` (repeatable) or capture the current screen with
`-S`/`--screen`, for vision-capable models such as `gemma3:4b`. Images flow
through `Message.images` into Ollama's `/api/chat` `images` field; text-only
requests are unaffected. A privacy guard warns before any image is sent to a
non-local engine, and the security guardrail now preserves images when it
sanitizes a flagged prompt. Screen capture uses the built-in Windows .NET
stack with `mss`/`Pillow` fallbacks on other platforms. Adds the
`JARVIS_NUM_CTX` environment variable to tune the Ollama context window
(default `16384`).

**Dedicated Briefing page for the morning digest.** The digest previously
surfaced only by piggybacking on whatever chat message happened to be
current -- `InputArea.tsx` polled `/api/digest` after every response and
attached audio to it when available. A new sidebar entry and `/briefing`
route give it its own page: narrative text, the existing `AudioPlayer`,
a Regenerate button, and digest history, all against the existing
`/api/digest` REST endpoints (no backend changes required). The
chat-hijack in `InputArea.tsx` stays in place for now, pending removal
once the new page is proven out.

**Dashboard panel hub.** The Dashboard is now a 12-column grid of briefing
panels on one shared shell (`components/Dashboard/DashboardPanel.tsx`:
icon, title, tag, regenerate button, loading and error states), so every
panel reads as one system:
- Day Ahead: live, uncached next-24 h calendar events and open tasks.
- Weather: a live graphical read (`GET /api/weather`) beside a short
  narrated digest.
- Daily Brief and Culture & Sports: they share one Layout-level `<audio>`
  element per digest (`lib/sharedDigestAudio.tsx`), because two elements
  on one file broke decoding in WebView2.
- Store Performance, and a Latest News item in the sidebar.
The existing energy, cost and trace panels sit below a "System telemetry"
divider.

**Hermes as a backend: local-first chat router and read-through panel
feeds.** OpenJarvis can act as the front end for a locally running
[Hermes Agent](https://github.com/NousResearch/hermes-agent). Configure it
with `HERMES_API_KEY` (Settings → Hermes), `engine.hermes.host`, and the
panel bridge (`HERMES_BRIDGE_URL`, default `http://127.0.0.1:8643`).
- **Chat.** A new default model, "Auto (local first)", classifies each
  turn with the local model. Turns about the operator's own business go
  to Hermes as a strict pass-through: no OpenJarvis agent, tools, system
  prompt or memory are involved. Everything else stays local.
  - A `Hermes,` or `local,` prefix forces the route.
  - Auto-routed Hermes turns are capped per day
    (`engine.hermes.daily_turn_cap`, default 100).
  - The `hermes` engine is pass-through only: it is never discovered,
    never the default, and never a fallback.
- **Panels.** Store Performance, the sidebar's breaking-news item, and
  the Daily Brief and Culture & Sports digests read Hermes panel feeds.
  They are unwrapped in the shape the panels already used, tagged with
  `generated_at` / `age_seconds`, and serve the last good copy flagged
  `stale` when the bridge is unreachable.
  - Digest Generate queues a Hermes refresh and polls for the new
    document.
  - OpenJarvis still speaks digests and alerts with its own TTS, once per
    new document.
  - `jarvis serve` pre-synthesizes digest audio at startup and shortly
    after the morning runs, so the first panel load doesn't wait on TTS.
- **Morning greeting.** In Auto chat and `jarvis ask`, a message that is
  only a morning greeting or briefing request ("good morning", "morning
  briefing", "what's my briefing") returns today's Hermes digest with no
  model call, and the desktop app plays its cached audio. The matcher is
  anchored, so "I had a good morning run" is a normal turn.
- **Feed freshness.** Hermes-backed panels show "Updated N ago", in amber
  when a feed is older than its schedule or served stale
  (`components/Dashboard/FeedFreshness.tsx`).

**Commerce page** (`/commerce`). One view of the Hermes e-commerce feeds
(`GET /api/commerce/{feed}`):
- a store switcher and each feed's age;
- per-store or summed KPIs (sales windows with week-over-week change,
  stock, alerts, and GA4 sessions, ad cost and ROAS when connected);
- a daily briefing in three tabs, each refreshable on its own;
- a recommendations queue with Accept / Reject / Done and an optional
  note, applied optimistically and reconciled with the decision ledger,
  beside ledger stats and recently decided items;
- a sortable, filterable products table; Google Ads campaigns; per-store
  SEO health; and compliance counts.
The proxy forwards only allowlisted refresh flags and decisions on
12-hex recommendation ids.

**Commerce: the Fixes tab** (Overview | Fixes (N)). The operator's review
seat for Hermes's catalog fixes, i.e. proposed corrections to product copy
(the `catalog_fixes` feed, contract v1.3–v1.3.3). Once a Hermes writer is
live, it applies the fixes the operator approves.
- **Cards:** grouped by fix class, with filters for status and class. Each
  card shows the validator checks, the judge's verdict, the rationale, and
  a per-field word diff of the visible text, with an HTML-source toggle.
  The store's HTML is never rendered: it's turned into text with string
  operations. Dropped figures are boxed, and the structured `drops` field
  (falling back to the specs check's text) says why each figure was let go,
  whether a linked finding or a judge flag.
- **Decisions:** Approve (sends the hash of the patch as displayed), Edit
  then approve, Reject (final, inline confirm), and "Approve these N" per
  class (inline confirm; it leaves review-only fixes out and doesn't count
  toward auto-apply). "Approve over judge" is offered only on fixes whose
  sole failed check is the judge, and shows the flag beside the button.
- **After the writer goes live:** P1 approvals wait in a `confirm` status.
  The operator re-confirms each one (Confirm, key `c`), or uses "Confirm
  these N", which stays disabled until the class's spot-check passes.
  Revert asks before restoring the old copy. History shows the writer's
  refusals and failures, and an invalid card that no failed check explains
  shows why.
- **Header:** the writer's state ("Writer live since … · n/cap today"), a
  pause switch (reverts still run while paused), and the feed's age.
- **Class panel:** read-only. It shows streak, bulk approvals, edits,
  rejects, the writer's applied / verified / failed / reverted counts, the
  spot-check, and the four conditions for suggesting auto-apply. There is
  no tier control.
- **Keys:** `j`/`k` move, `a` approve, `e` edit, `r` reject, `c` confirm.

Decisions go through `/api/commerce/fixes/*`. The backend adds the
operator token from a file named by `HERMES_FIX_TOKEN_FILE` in
`credentials.toml`. The token never reaches the frontend, and it is never
logged or returned.

**Commerce Fixes tab: contract v1.3.4 and the v1.4 tiers.**
- **Writer header:** a store whose writer credentials fail shows its reason
  in amber; so does a pause the writer hasn't caught up with, and a writer
  status more than 10 minutes old.
- **History:** the writer's machine `reason` code is read before the note
  and shown in words (`checks_failed:specs,html` reads "checks failed:
  specs, HTML"); an unknown code shows as is. "Why invalid" uses it.
- **Spot-check blockers:** the class confirm names the P1 approvals still to
  confirm singly ("Confirm these singly first: …", each a link to its card),
  and those cards sort first. The panel's own figure-dropper guess is kept
  only for feeds without `spot_check.blockers`.
- **Reject on `confirm` cards** withdraws a P1 approval ("Withdraw this
  approval? It won't be applied."); `r` opens it.
- **Compliance:** advisory findings (a spec carried over unchanged onto the
  writer's copy) in a collapsed "Advisory (N)" list with a link to the fix;
  they never count as open. Findings opened by majority show "2 of 3
  readings".
- **Tier control:** the class panel gains Tier, Policy tier, Auto applied, a
  "Demoted: …" note, "streak since …", and the A14 eligibility sentence.
  "Allow auto-apply" (enabled only while the class is eligible, behind an
  inline confirm naming the caps) and "Turn off auto-apply" (always) write
  the operator-only auto-fix policy file through `GET|POST
  /api/commerce/fixes/policy`. That route is OpenJarvis's own: it never
  calls a Hermes write route, answers only over loopback, writes the file
  atomically (temp + rename), refuses a raise unless the latest
  `catalog_fixes` shows the class eligible with the same rules hash, and
  refuses rather than overwrites an unreadable file. The file's path is
  `HERMES_AUTOFIX_POLICY_FILE` in `credentials.toml`.
- **Auto-applied fixes:** the Daily Brief lists the general digest's
  `auto_fixes` with Revert (the existing revert route, inline confirm) while
  the fix is applied, verified, or failed-verify. Cards carry "auto" and
  "auto candidate" chips, and "read-back differs" when the writer's
  read-back didn't match.

**Commerce Fixes tab: contract v1.5, the SEO meta patches** (0011 A16).
Hermes's fixer now proposes `seo.title` / `seo.description` patches, most
of them Foundry copy, which the tab used to show as HTML copy patches.
- **Cards:** a `seo.*` change is shown as plain text, never HTML: Before and
  After each with a character count against the seo profile's range (title
  30 to 65, description 70 to 160; amber when outside it), an empty Before
  reading "empty (Shopify shows the default)", and an inline word diff only
  when Before has text. The editor counts characters live for these fields.
- **Chips:** `source` (sentinel | rec | seo; inferred for older patches from
  the linked findings), `checks: seo`, "Foundry copy <date>, <commit>" from
  `copy_source`, and the audit codes the patch addresses, in words.
- **Verification:** applied, verified and failed-verify seo patches show the
  SEO audit's reading (`seo_verify`): verified; failed; "still applied, not
  verified" when the page shows the copy but the audit still reports
  `title_length` because the theme adds a suffix to the page title; or the
  page not caught up yet.
- **Reject on a Foundry-copy patch** says the product is then left skipped
  by the fixer and offers "Edit instead" first; the final reject stays.
- **Tier sentence:** the class panel reads each class's `suggest_at` (5 for
  `seo:foundry`, 20 otherwise) instead of a literal 20, names a lower
  threshold by rule when classes differ, and gains a "Toward auto-apply"
  column ("1 of 5 in a row · 1 of 5 verified"). The tier control itself is
  unchanged.
- **Run line:** the header gains the fixer's last run, with the SEO pass
  (items per store and class, in and out of stock, items held behind a
  compliance finding, the copy files with their date and commit, and each
  store's title suffix) in an expandable detail.
- **Filters:** a Source filter beside Status and Class, so the seo queue can
  be reviewed on its own.

No backend change: the routes pass the feed through.

**Business Development: Send through Forward Email** (hq decision 0018,
contract v0.10 BD, Part A). With an API key configured, the prospect drawer
and the follow-ups strip get a **Send** button. The server sends the mail
through Forward Email's API and records the touch with the bridge's `sent`
flag, so "Mark as sent" goes away. Without the key, the page behaves exactly
as before: the mail link, the copy buttons and "Mark as sent".
- **UI:** Send is the primary button, with a From name (prefilled from config)
  and the To choice; the mail link and copy buttons move under **More**.
  A sent touch shows its delivery status (`queued`, `sent`, `deferred`,
  `rejected`), and `rejected` enables Send again. The drawer lists the sent
  touches.
- **Route:** `POST /api/bizdev/prospects/<id>/send` (loopback-only, 16 KB)
  checks the request against the live `bd_pipeline` card. The address must be
  one of the card's contacts, the touch must be the card's next one, and a
  touch already sent is refused unless it was rejected. Once checked, the
  route:
  - screens for an empty body or an unresolved `{{field}}`;
  - checks Forward Email's daily limit (429 at the cap);
  - renders the mail with the line's published footer exactly once, its
    `[Your name]` and `[postal address]` placeholders filled from config
    (Hermes drafts already end with the unfilled footer; it is taken off and
    re-added filled; a line with no published footer gets a fallback footer
    whose reply-"unsubscribe" line is the opt-out), `Reply-To`, its own
    `Message-ID`, and `In-Reply-To` /
    `References` on follow-ups. `List-Unsubscribe` is added only with
    `BD_LIST_UNSUBSCRIBE` on: Forward Email defers mail carrying it as a
    newsletter (421) until the account is approved for newsletters;
  - sends it, then posts the v0.10 flag body.

  A Forward Email error answers 502 and records nothing. When the bridge is
  down, nothing is sent.
- **Status poll:** a background task (only under `jarvis serve`) polls each
  send's delivery status every 5 minutes for up to 7 days. It relays changes
  with the `status` flag (with `fe_error`, the first line of Forward Email's
  rejection message, when a mail is deferred or rejected) and retries any flag the bridge did not take. A
  small send log under the config dir (`bizdev/sends.json`) keeps the ids;
  a prospect's text is kept there only until the bridge has accepted it.
- **Config:** a `[bizdev]` section in `credentials.toml`, all machine-local
  and empty by default: `FORWARDEMAIL_API_KEY_FILE`, `BD_SENDER_NAME`,
  `BD_SENDER_ADDRESS`, `BD_SENDER_ORG`, `BD_REPLY_TO`, `BD_POSTAL_ADDRESS`,
  `BD_TRACK_BASE_URL` (Part B) and `BD_LIST_UNSUBSCRIBE` (off). The key is
  read per call by the server only and is never logged or returned;
  `GET /api/bizdev/send-config` reports only whether Send is on and the
  sender to show. A deferred or rejected touch shows Forward Email's reason
  (`fe_error`) on its status chip.

**Business Development: engagement and templates** (hq decision 0018,
contract v0.10.2, Parts B and C).
- **Open pixel (Part B):** with `BD_TRACK_BASE_URL` set (an https origin;
  anything else turns Send off and is named in `missing`), each mail's `html`
  ends with the engagement stack's 1×1 pixel, and the `sent` flag carries its
  32-hex token. The `text` part never has it, and links stay as written.
- **Engagement on the card:** the drawer's Engagement timeline shows each
  touch's delivery status, then opens (proxy prefetches marked), auto-replies,
  replies (a reply from another address is "referred"), bounces and
  unsubscribes, in time order. Board cards and the drawer get Opened (only
  for a non-proxy open), Replied, Referred, Auto-reply, Bounced and
  Unsubscribed chips. Insights adds `bd_stats.engagement`: sends, delivery,
  non-proxy opens, median time to reply, reply rate by touch and by draft
  source (by template name), the week's bounce rate, and the send-slot table
  once Hermes publishes it.
- **Templates (Part C):**
  - The drawer and the follow-ups strip share one composer. Its **Template**
    choice lists "Hermes draft" first, then the line's current templates for
    that touch and for any touch. A template fills in with its merge fields
    resolved from the card, as Hermes resolves them; a field the card can't
    fill stays as `{{field}}` and blocks Send with its name.
  - The line's footer is out of the editable text and shown read-only, as
    it will be sent.
  - To starts at the contact Hermes wrote the draft for.
  - **Save as template…** saves the current text without its footer.
  - A **Templates** tab lists the line's templates with uses and replies;
    each can be edited or archived, and new ones made there.
  - `POST /api/bizdev/templates` and `/templates/<id>/archive` (local only)
    check Hermes's save rules before the bridge: touch, default-for-touch,
    caps, known merge fields only.
- **Send's server-side checks (Part C):**
  - The line's published `screen.patterns` run on the final subject and body
    minus the footer, and a match refuses with its reason. A pattern that
    doesn't compile refuses the send.
  - A `template:<id>` source must be a current template.
  - The page's `draft_edited` count travels in the flag's `meta`.
- **New setting:** `BD_SENDER_TITLE` fills `{{sender_title}}`.

**Business Development: Add recipient and several recipients per card**
(hq decision 0018 A3 + A2, contract v0.10.7).
- **Add recipient:** the drawer's form (name, title, email) saves an
  address as a contact on any card that isn't suppressed. It is open on a
  card with no contacts, behind a link otherwise, and off at 3 contacts.
  `POST /api/bizdev/prospects/<id>/contact` (local only) checks one valid
  address of at most 254 characters and that the card is on the board, then
  forwards it to the bridge. Hermes decides the rest (free-mail, duplicates,
  the cap) and publishes the contact within about 2 minutes. The drawer says
  so when an address hasn't appeared after two refreshes. Contacts show
  "added by you" and "bounced" tags.
- **One address per send, up to three per card:** Send's To lists the
  card's contacts, with a hard-bounced one listed but disabled. A touch is
  now a (number, address) pair: the touch number, the reply thread and the
  merge fields follow the chosen recipient, and sending to one address
  leaves Send open for the others. The server refuses a 4th address, a
  hard-bounced one, and a touch already sent to that address unless it was
  rejected. Its send log stores a hash of each address, never the address.
  A follow-up goes to the recipient Hermes proposed it for.
- **Engagement by recipient:** with more than one recipient, the timeline
  groups each address's touches and bounce, and every touch shows when it
  went out (Central), the time from draft to send and the characters
  edited. The card's Bounced chip follows the stage, since one address can
  hard-bounce while the card stays Sent. Replied names who replied, and a
  card sent to several addresses shows "N recipients".
- **Meeting on the calendar?** A replied card that Hermes matches to an
  upcoming calendar event shows the chip with the event's day and domain.
  The drawer's Confirm posts the existing move to Meeting.
- **Insights:** cards with more than one recipient, reply rate for edited
  vs unedited drafts ("n/a" until 30 sends), and median draft-to-send.
- A one-contact card from an older feed renders exactly as before.

**Breaking list: cloud notices move to Stack health** (hq decision 0017
A3.1). Quiet `aws` / `google` rows (below severity 9) no longer show in the
sidebar's breaking list; they are dropped before the three-row cap, and the
list now asks `/recent` for 10 rows so notices don't use up the slots. Their
home is the Stack health drawer, whose cloud rows now carry an `aws` /
`google` chip (Google types are `GOOGLE_*`). A 9+ cloud row (an outage)
still lists and rings, and quiet rows of other kinds keep the "quiet"
marker. `/recent` itself is unchanged.

**Breaking alerts: severity gate** (hq decision 0017 A3). Only rows with
severity 9 or above become the latest alert (`/api/breaking-news`) and get
TTS audio (`BREAKING_VOICE_MIN_SEVERITY = 9` in `breaking_news_routes.py`).
A missing or non-numeric severity counts as 9, so no older row goes quiet.
- **Quieter rows** (an AWS maintenance notice at 6, an official release at
  7) stay in `/recent` and in the sidebar list, marked "quiet", but never
  displace the latest alert and are never spoken.
- **Newest row below the bar:** the latest is the newest passing row in the
  last 72 h of `/recent`, else the last passing alert the server saw.
- **Player:** when a quiet row leads the list, the play button stays on the
  spoken alert's own row, which stays visible on short windows.
- **Kinds:** `AlertKind` adds `aws` and `google`.

**Stack-health dock in the sidebar** (hq decision 0017 A2). The operator's
stack-health check writes a local result file every 6 h, and the cloud
Health relay exports open AWS and Google events. A dock on top of Latest
News reads both. When everything is fine it is one muted line:
"All systems operating nominally." plus the run time and its age. When
something is wrong it becomes a tinted two-line strip:
`N FAIL · M WARN — area/check` / `Stack health is <age> old`.
- **Colours:** the strip is red for a FAIL or an open cloud `issue`, and
  amber for a WARN or a run older than 7 h. Cloud notices alone keep the
  green line and add an amber "N cloud notice(s)".
- **Drawer:** clicking the strip opens the drawer. It shows the counts, every
  FAIL then WARN row with its full evidence and a copy button, and the open
  cloud events (newest first, capped at 10). Its footer shows the last run,
  its duration and the next scheduled run, with **Run now** and **Speak**.
- **Chime:** a run that turns red chimes once (a Web Audio tone, stored per
  `ran_at`) and pulses for 10 s.
- **No data:** with no file the dock reads "No stack-health run yet". Any
  other error reads "Stack health unavailable"; neither blocks the sidebar.

Backend: `server/stack_routes.py`, loopback-only. `GET /api/stack/health`
reads the files per request, with no cache. A missing file answers 404; an
unreadable one answers 503 naming the file, never its content. The response
carries a `speech` block that `/api/voice/prepare` serves as the local
`stack_health` feed, never asking the bridge. `POST /api/stack/health/run`
runs `schtasks /Run` for the configured task: 202, 503 on failure, 501 off
Windows. The server never runs the check itself.

Config: a new `[stack]` section in `~/.openjarvis/credentials.toml`. No path
or task name ships with the repo; all three values are machine-local:
- `STACK_HEALTH_FILE`: the check's result JSON (required for the dock).
- `HEALTH_EVENTS_FILE`: the cloud relay's export (optional).
- `STACK_HEALTH_TASK`: the scheduled task's full name, for Run now
  (optional).

**Commerce Fixes tab: image alt patches** (0011 A17, class `seo:image_alt`).
An `image.alt` patch's one change holds the product's whole alt map as JSON;
the card renders the patch's `images [{media_id, url, before, after}]` instead.
- **Cards:** one row per image: a small lazy-loaded thumbnail (`width=160`,
  https URLs only), then the alt before ("— none —" when empty) and after, as
  plain text, never HTML. The class reads "Image alt", and the `checks: alt`
  chip explains the alt profile.
- **Edit:** one field per image with a live count against 125 (amber past it,
  and a note that an emptied image drops out of the fix). Saving sends only
  the changed images: `changes: [{field: "image.alt", images: [{media_id,
  after}]}]`. The backend edit route accepts that shape for `image.alt` only
  and refuses a mismatched one locally; copy fields keep `{field, after}`.
- **Tier and outcomes:** `suggest_at` falls back to 10 for `seo:image_alt`
  when the feed lacks it; `media_not_on_product` reads in words.
- **CSP:** the server's and the desktop app's `img-src` add
  `https://cdn.shopify.com`, and only that host, so the thumbnails load.
  Before this, `default-src 'self'` (server) and `'self' data: blob:`
  (desktop) blocked them.

Copy patches and unknown fields render as before.

**The G1 mirror in "Waiting on you"** (hq 0020 D4; Foundry's approval
mirror). Open content approvals now show in the bell and the Dashboard panel
as "Posts to approve (G1)", right after Trading, and open a G1 drawer.
- **G1 drawer:** the still, or the clip with sound (an episode's 60 s cut),
  then the headline, caption, disclosures, targets (an episode's tags) and
  the motion beat, as on the Telegram card, with the time left in the 24 h
  window. Approve or Reject takes an optional note (≤ 500) and a confirm
  step; it runs the same decision code as Telegram's buttons. A 409 reads
  "Already decided (Telegram or app)" and refreshes the list. **G2** rows
  show everything with no buttons: "Decide in Telegram".
- **Server:** `server/g1_routes.py` signs `GET /approvals` and
  `POST /approvals/<id>` with SigV4 for service `lambda`
  (`server/sigv4.py`, standard library, checked against the AWS SDK's
  signer) from a named AWS profile. The mirror URL and the profile name are
  local config (credentials.toml `[g1]` `G1_MIRROR_URL`, `G1_AWS_PROFILE`).
  With no config the G1 kind is absent and nothing errors. The presigned
  links never reach the page and are never cached or logged: the drawer asks
  `/api/g1/approvals/<id>/media/<still|clip>`, and the server lists again
  and streams the file, so the CSP is unchanged. All routes are loopback only.

**Content page: the studio's Episodes and G0** (hq 0019 Part B; the local
studio's files, plus contract v1.17's episode lane). The long-form YouTube
studio writes its status and one folder per episode on this disk; the page
reads them and writes only the operator's files.
- **Episodes panel:** one card per studio channel (the channel name comes
  from the content bundle at runtime) with queued, in production, published
  and runway, this month's spend and GPU minutes against the caps, the
  channel's pause, and each episode with a stage chip. **Run studio now**
  starts the studio's task, at most once every 2 minutes. There is no publish
  button: publishing is G1's approval.
- **G0 drawer** (`awaiting-g0`): the script with inline edit, the claims
  table with a check box per claim (`unsourced` claims flagged as needing a
  ruling; Approve stays disabled until every claim is checked and the script
  keeps one heading per planned beat), the studio's notes for G0, the visual
  plan per beat, Omni (off by default), and Approve, Request rewrite (with a
  note, at most two) or Reject, each with a confirm step. The decision is
  `g0.json`, applied on the studio's next run. "Waiting on you" G0 rows open
  the drawer through `?focus=`.
- **Episode detail:** the 60 s cut and the full cut, loaded on demand, the
  checks and spend, the stage history, and the publish fields (title,
  description, tags, thumbnail pick) written to `publish.json` until the
  episode goes to G1, with the visibility it will get (the channel's first
  episodes unlisted) and the AI-label reminder. Media loads as blobs through
  the API, so no CSP change was needed.
- **Composer:** the `episode` lane takes the class (with the operator-only
  badge), 1–10 sources and the target minutes (4–12, default 8), and never
  target queries, a URL or the Video control. A thesis prompt whose property
  has an operator-only episode class offers "Seed as a …" beside Seed this.
- **Server:** `server/studio_routes.py`, all loopback only and never outside
  the studio folder (`<WORKSPACE_DATA_DIR>/studio`): status, the episode
  list and detail, media by name, `PUT …/script` and `POST …/g0` only at
  `awaiting-g0` (with a version hash, so a newer draft answers 409),
  `PUT …/publish` only before G1, `POST /run`, and pause or resume. Every
  write is atomic. `POST /api/content/seeds` takes the three episode fields,
  required on that lane and refused on any other.

**Content page: the operator's own seeds** (contract v1.16, hq 0008 A1).
A seed for any active property and any seedable or operator-only lane goes
through the same outbox and intake as an approved Hermes proposal, with no
seed editor, saved file or command line.
- **New seed** in the header opens the composer empty; **Seed this** on a
  thesis prompt opens it pre-filled (the prompt's property and thesis lane,
  signal plus why it matters, the first link). The prompt is marked used
  once the seed reaches the outbox.
- **Fields:** property; lane (never a feed lane, with an operator-only
  badge); text up to 6000 characters with a counter, and for long-form the
  title from line 1 shown back; pillar from the seedbank's list; product
  handle with **Verify** (found, not found, which blocks Queue, or "couldn't
  check", which doesn't); url; target queries (long-form only, never an
  operator-only thesis); priority; and a read-only preview of the JSON sent.
- **Queue** sends only the bridge's keys and shows the proposal id, then
  follows the item: approved, submitted, queued with its thesis-lane
  position, intake rejected with reasons, or "seed refused" with Hermes's
  note. Proposals show an `operator` origin chip.
- **Run intake now** starts the content pipeline's intake task instead of
  waiting for :20, at most once every 2 minutes.
- **Server:** `POST /api/content/seeds` (16 KB, the bridge's field caps) and
  `GET /api/content/verify-product` proxy the bridge;
  `POST /api/content/intake/run` runs the scheduled task (`429` inside the
  cooldown). All three answer only this machine.

**Business Development cards** show the date a card entered its stage beside
its day counter, on the board and in the List view, and a short meeting chip.

**Trading view: a third sleeve and easier reading.** Still read-only.
- **Any number of sleeves:** one card fills the row, three share it, and two
  or four go two by two, so no card sits alone on a row. Cards lay out by
  their own width. The futures sleeve has its label, icon and place after
  crypto.
- **Equity curve in % from start** by default, each sleeve from its own
  first night so sleeves of different sizes compare on one axis, with a
  zero line. "$" shows the amounts, and the hover gives both.
- **Today's change** on each sleeve's Equity tile (equity against the day's
  start equity, colored by sign), and each position's **distance from mark
  to stop** under the stop price (amber under 2%, "past" once through it).
- **The kill switch, x402 spend and nightly fold to one line** while all is
  fine (both kill indicators clear, spend under 80% of the cap, a report
  and an off-VHD copy), keeping the approval link and a Details toggle.
  Anything off shows the full cards.
- **One color per sleeve** across the header, the card icons, the curve and
  the events.
- **Events without repeats:** a SIGNAL shows as the reason under the
  PROPOSAL it led to, an ALERT already in the Alerts panel isn't listed
  twice, and back-to-back repeats are one row with a count. Columns align,
  and a filter shows one sleeve.
- **Local time throughout:** ticks, the UTC entry window, the nightly run
  and the timestamps inside the trader's own text show in local time, with
  the original on hover. "Next due" is relative ("in 2 h 10 min").

**Trading view** (`/trading`, hq decision 0014, contract v1.6). A read-only
view of the x402 paper trader from two Hermes feeds, `trading_status` (the
trader's own status export, every 5 minutes) and `trading_day` (the nightly
report). **It shows and never acts:** there are no action buttons and no
POST routes under `/api/trading`; the only outbound control is a link that
opens the AWS approval page in the system browser.
- **Header strip:** mode, per-sleeve halt-state pills (NORMAL, DEGRADED,
  KILL with the cause and when; icon plus word, never color alone), the
  heartbeat and its alarm, when the trader wrote its status, the feed age,
  and the installed commit. A stale banner appears when Hermes flags the
  status stale, when the feed is over 15 minutes old, or when the trader's
  own `written_at` is.
- **Kill switch:** the AWS flag and the local file as two indicators, each
  with its clearing rule in one sentence (the flag on the approval page with
  MFA; the file by the operator in WSL), the last cause, and "Open approval
  page", disabled with a hint when no URL is configured.
- **Sleeve cards:** equity, cash, realized equity and high-water mark;
  drawdown against the 8% limit as a thin meter; positions; open orders;
  today's ticks (equities: the fixed times, done or due; crypto: the
  interval and the entry window); the last tick.
- **x402 spend** against the daily cap, entry pool and exit reserve;
  **Nightly:** last report, next run, last off-VHD copy.
- **Equity curve:** one line per sleeve from the nightly reports, shown from
  day one, realized equity as a dashed lighter line, with a legend and a
  table view. History travels inside each `trading_day` document (`curve`);
  without it the curve has the latest day only.
- **Events** (the last 20 non-TICK, with type chips) and **alerts** of the
  last 24 hours.

Backend: `server/trading_routes.py`, `GET /api/trading/{trading_status |
trading_day}` as the Business Development proxy (last-good cache, the
stale flag merged with Hermes's own), and `GET /api/trading/config`
reporting whether `[trading] page_url` is set in the machine-local
`config.toml` and the URL for the link (https only). Nothing else.

**Business Development page** (`/bizdev`), generic by business line. A
pipeline board for a Hermes prospect-research role
(`GET /api/bizdev/{bd_pipeline|bd_stats|bd_prospects}`):
- a line switcher, research coverage, and month cost by engine;
- follow-ups due;
- seven stage columns with drag-and-drop and filters; columns with cards
  get a real card width and empty stages collapse to narrow rails that stay
  drop targets (wider while a card is dragged), with horizontal scroll past
  the screen width;
- cards with the name clamped to two lines (full name on hover), the rank
  chip on the name row, and one chip row;
- a Board | List toggle: a compact table of the filtered prospects by rank
  that opens the same drawer;
- a rank chip on every card (Hermes sends each stage sorted by rank; the
  tooltip spells out base fit × division factor × platform factor), an
  affiliation chip, and Rank ≥ / Affiliation filters; columns keep
  Hermes's order, with any unranked cards last;
- a prospect drawer with fit, rank, signals, official-directory contacts, and a
  draft that is editable locally only (never saved or forwarded);
- `mailto:` hand-off to the operator's own mail client, falling back to
  copy past 2,000 characters, then a "Mark as sent?" prompt;
- outcomes, where the three suppression outcomes require an explicit
  "permanent" confirmation; re-check with its daily cap; stage history,
  and a note when a re-check came back worse and the earlier research
  was kept;
- a conversion funnel and the week's research log.
Actions are validated like the bridge (integer ids, the stage list, 2 KB
bodies). Neither OpenJarvis nor Hermes sends email.

**Content page** (`/content`), generic by property. The operator's seat in
a content loop where Hermes proposes seed topics and measures what was
posted, and only approved proposals reach the content pipeline's intake
(`GET /api/content/{content_seedbank|content_proposals|content_performance|content_health}`):
- a property switcher, snapshot and bundle ages, month cost by engine, and
  "Research more" (one extra ideation run a day; the button locks for
  24 hours after use);
- health alerts, warnings first;
- the seedbank: one card per lane with cadence, queued, in flight,
  pending, runway days and a status (including operator-only lanes,
  automatic feed lanes, and "unknown" before the pipeline's snapshot);
- a proposals queue, newest first, with evidence: Approve, Edit & approve
  (topic, pillar, product and a note; only changed fields are sent), and
  Reject behind a "final" confirmation; decisions are optimistic and
  reconciled with the next feed; a Recently decided tab shows intake
  outcomes and their reasons;
- thesis prompts, only when there are any, marked Used or Dismissed
  (Hermes offers prompts; it never writes theses);
- performance: approval rate per property, rollups by pillar, origin and
  content type, and recent posts with engagement, clicks and sessions.
The proxy forwards only uuid-addressed approve/reject and used/dismissed
actions and the ideation refresh, with the bridge's 2 KB body cap and
per-field limits.

**Voice: a local voice worker speaks Hermes's `speech` blocks.** Feeds that
may be heard carry `data.speech` (a spoken script with a mood, priority and
lane), and a `voice_queue` feed collects them. The worker
(`openjarvis.voice_worker`) is a separate local process in its own
environment (`src/openjarvis/voice_worker/requirements.txt`; torch and the
TTS engines are not core dependencies):
- **expressive lane:** Chatterbox conditioned on a Kokoro `bm_george`
  reference clip that it renders at first start (nothing voice-related is
  committed), on the GPU, pre-rendered from the queue; the block's mood sets
  the exaggeration;
- **fast lane:** Kokoro `bm_george` on the CPU, for `lane: fast` blocks,
  ad-hoc read-outs and the fallback;
- a GPU lease file shared with the agent that owns the local model: the
  worker takes it only when Ollama has no model loaded and at least 6 GB is
  free, writes it atomically, renews it per chunk and deletes it when done
  or on error, and never stops Ollama; a block that can't get the GPU within
  20 minutes is spoken on the fast lane and upgraded later;
- audio cached by block id for 14 days; a localhost API on `:8650`; and
  `install_task.ps1` to run it as a per-user scheduled task at logon (it
  writes the machine-local `config.json`: the lease path and the voice's
  display name).
The backend adds `/api/voice/queue`, `/api/voice/audio/<id>`,
`/api/voice/prepare` and `/api/voice/speak`. The dashboard gains a Listen
panel (the queue in order with the expressive voice's name or "fast" as a
badge, per-item play,
Play all, played state, nothing auto-plays), and the Commerce briefing,
Compliance, Business Development and Content panels gain a speaker button
when their feed has a block.


**Voice input: talk to the assistant (phase 1).** A global hotkey (Win32
`RegisterHotKey`; default Ctrl+Alt+Space, mute Ctrl+Alt+M, both configurable)
starts a voice conversation from the voice worker, so it works with the app
closed. The conversation keeps listening turn after turn until a dismissal
("that's all", "thanks, <name>" with the name from the worker's local config,
"stop listening", "goodbye"), the hotkey, mute, or 60 s of silence; soft
synthesized chimes mark start and end (a low tone if the mic can't open), and
the mic is open only while a conversation is active.
- Pipeline: Silero VAD endpointing → faster-whisper on the CPU (`small.en` by
  default, `stt_model` configurable) → a local command grammar (stop, go on,
  repeat, the morning briefing from the voice queue, next, end) or the agent's
  voice endpoint, streamed with one session id per conversation → sentences
  spoken on the fast lane as they arrive (the first sentence clause by clause).
- Barge-in on a headset: talking over a reply (400 ms), or a short spoken
  command, stops playback and cancels the stream; "go on" resumes what had
  arrived. Other output devices fall back to half duplex.
- Robust on Windows audio: devices by name (WASAPI, else MME) re-resolved per
  conversation, native-rate capture and playback with resampling, and a
  callback player with a large buffer.
- Turns stay in memory; the per-turn latency log has no transcript text. The
  backend proxies `/api/voice/{state,events,start,stop,mute,unmute}`; the
  header gains a voice indicator and a conversation drawer with "That's all"
  and "Open in chat" (text only, on click).

### Changed

**Day Ahead and Weather read Hermes's feeds (wave 4).** `/api/day-ahead` and
`/api/weather` proxy the agent's `day_ahead` and `weather` panel feeds in the
panels' original shape plus `generated_at`, `age_seconds` and `stale` (the
last good copy when the bridge is down), with `POST /refresh` on both. The
panels queue a refresh when opened and show the feed's age; Weather labels
units from the feed (°F/mph or °C/m/s) and its Regenerate became Refresh. No
live calendar, task or weather calls remain in these routes.

**Digest audio comes from the voice worker.** `/api/digest/audio` keeps its
shape but serves the worker's render of the digest's `speech[0]` (the
expressive voice once rendered, the fast lane until then, rendered on demand
if missing); without a block it falls back to a local render. The digest
response adds `audio_version`, and `voice_used` reports the voice actually
used. The digest voice default is `bm_george`.

**The general and culture digests are generated by Hermes when it is
configured.** `/api/digest` and `/api/digest/culture` proxy Hermes's
feeds.
- `/api/digest/schedule` reports Hermes's schedule read-only, and `POST`
  returns 409.
- `jarvis digest --fresh` and the "good morning" intent route answer with
  today's Hermes digest instead of generating locally.
- Weather is now the only locally generated digest category.

**Chat no longer attaches the digest's audio to every reply.** The
Briefing-page entry above noted that `InputArea.tsx` still polled
`/api/digest` after each response. That hack is removed: only a
morning-briefing turn plays the digest, through the shared Daily Brief
player, which also fixes a player that couldn't load in the desktop
webview.

**`openExternal` and the dashboard UI primitives are shared.**
`lib/open-external.ts` and `components/shared/` (chips, tiles, selects,
segmented controls, number and date formatting) are used by the Commerce
Business Development and Content pages, including the cost-by-engine
label (`engineLabel`).

### Removed

**The local digest pipeline in the dashboard and API.** With weather on the
agent's feed, no digest category is generated locally: `/api/digest/weather`
and the spoken weather narration are gone, `create_digest_router` only builds
the proxied general and culture routers, and the fork's edits that served the
local pipeline (`morning_digest`'s categories and presets, the SDK's and
scheduler's `digest_category`, the weather connector's `stored_location`, the
weather tool's icon field) are reverted to upstream. The upstream modules
themselves stay; upstream code still uses them.

**Local pipelines now served by Hermes.** Removed from this fork:
- the Shopify and Search Console connectors, the multi-store registry and
  "Add Store" flow, Shopify OAuth routes and the snapshot store;
- the `fmp_news` connector, `market_data/`, digest ticker scoring and the
  `watchlist_check` tool;
- the local breaking-news monitor (alert store and record tool);
- the culture digest engine;
- the soccer, motorsport and entertainment digest routes and presets, and
  their RSS connector subclasses.
`digest_collect.py` and `news_rss.py` are back to upstream.

### Fixed

**Business Development delivery status reaches the card.** A send logged
Forward Email's first answer (`queued`) while Hermes recorded the touch as
`pending`, so that answer was never relayed; the log now starts at `pending`.
A mail the recipient's server refused comes back as `bounced`, which the poll
kept raw and never relayed; it now relays as `rejected`.

**A sleeve with one night on the equity curve was invisible.** Dots were
drawn only when the whole curve had a single day, so a new sleeve's first
point drew nothing. A lone point is now dotted.

**Unknown `/api/...` paths return 404.** The SPA catch-all answered any
unmatched GET, API paths included, with `index.html` and a 200; retired or
mistyped API routes now 404, while app routes still fall back to the SPA.

**Backend console window killed the server when closed** (Windows
desktop). Every `uv.exe`/`git.exe` child spawned from the GUI-subsystem
desktop app got its own console window -- `CreateProcess`'s default when
no console-suppression flag is set. Closing that window sent
`CTRL_CLOSE_EVENT` to the console host, killing `jarvis serve` along
with it, so a production build appeared to require a terminal window
left open to stay running. Fixed by setting `CREATE_NO_WINDOW` on every
backend subprocess spawn: the Ollama sidecar, git clone, `uv sync`, the
Rust-extension verification, and `jarvis serve` itself on both the boot
path and the manual `run_jarvis_command` path.

**`tauri build` hard-failed on drifted plugin versions.**
`tauri-plugin-notification`/`tauri-plugin-updater`'s npm packages and
Rust crates had drifted to different minor versions over time (both
manifests pin loosely, `"2"` / `"^2"`). `tauri dev` tolerates the
mismatch; `tauri build` does not -- it exits immediately with "Found
version mismatched Tauri packages" before compiling anything. Realigned
both sides to matching versions (notification 2.4.0, updater 2.12.0).

**Desktop pinned a stale model from first-run onboarding.** The desktop
app resolves its Ollama model from `~/.openjarvis/inference.json`
(written once during setup), not from `config.toml`, and passes it as an
explicit `--model` flag to `jarvis serve` -- which wins over
`config.toml`'s `default_model`. A model changed later via `config.toml`
or the CLI silently had no effect on desktop-app launches.

**`jarvis start` crashed on its own PID registration** (Windows).
`Popen.pid` for a `DETACHED_PROCESS` child can disagree with that same
process's own `os.getpid()`, so the daemon's pending-placeholder check
(PID equality) treated a server as conflicting with itself. Fixed with a
shared launch token, handed to the child via an env var, to prove
placeholder ownership instead.

**Desktop health probe misread a slow-starting server as an empty
port.** A single 2s `/health` timeout tripping on a slow-but-healthy
first response fell through to spawning a duplicate server, which then
collided with the real one on the raw TCP bind. Now retries up to 3
times before concluding the port is genuinely empty -- a truly empty
port still fails near-instantly on every attempt.

**Boot-time `uv sync` silently pruned the `voice` extra.** Every backend
boot re-runs `uv sync` reconciled to a hardcoded extras list; anything
installed outside that list (e.g. `voice`, for Kokoro TTS) was
uninstalled on the very next app restart. Added `voice` to the boot
sync list.

**`OperatorManager.activate()` duplicated scheduler tasks.**
`create_task()` always persists a task under a fresh random uuid4-hex
id; `activate()` renamed it to a deterministic `operator:<id>` by
resaving a mutated copy under that id, but never removed the original
row -- leaving it active, so it fired its own tick alongside the renamed
one every cycle. Now deletes the original row once the deterministic-id
row is saved.

**Morning digest wrote only to its own store, invisible to every other
agent.** `MorningDigestAgent` wrote exclusively to `DigestStore`;
operators and managed agents had no way to draw on the daily digest via
`memory_retrieve`. Now also writes a best-effort copy to the shared
`memory_store` pool, tagged `source="daily_briefing"`. The agent is also
now instructed to skip email administrivia (subscription confirmations,
"welcome to X" messages) rather than report it as briefing content. Its
strict word limit was widened from 200 to 275 words for more narrative
room without added TTS risk.

**`jarvis digest --fresh --text-only` played audio anyway.** The
cached-digest display path gated playback on `not text_only`; the
`--fresh` generation path didn't, so `--text-only` never actually
suppressed audio playback for a freshly generated digest.

**Apple Silicon energy was never measured, only modelled.**
`telemetry/energy_apple.py` imported `AppleSiliconMonitor` from
`zeus.device.soc.apple`; no such class has ever existed there. The import
raised on every machine, so the CPU-time fallback -- `wall_clock x TDP x 0.60`
split by four hardcoded ratios -- was the only path that ever ran. It read no
counters and no utilization, so a ten-second sleep and a ten-second generation
produced identical joules, and every Apple Silicon figure in the telemetry DB,
eval traces and `jarvis bench` came from it. Renaming the import would not
have helped: `zeus.device.soc` landed on zeus master after the last zeus
release, so no published `zeus-ml` contains it, and `zeus-ml` has no `apple`
extra either. `energy-apple` now installs `zeus-apple-silicon`, the IOReport
extension zeus itself wraps, which needs no root. Measured on an M1 Pro:
8.24 W under load against 3.72 W idle, where the previous code could not tell
the two windows apart.

`AppleEnergyMonitor.available()` now reports `False` when nothing is
measurable, instead of `True` on any Apple Silicon host, so the factory falls
through rather than letting a model masquerade as a measurement. The estimate
remains reachable through the new `telemetry.allow_energy_estimates` setting
and still reports `energy_method = "tdp_estimate"`.

`snapshot()` is implemented for the first time, so `TelemetrySession`'s
background sampler -- the path agentic evals use -- records real readings
rather than the ABC's empty default. Relatedly, `TelemetrySample` hardcoded
`cpu_power_w = 0.0`, which zeroed CPU power in every eval trace on every
platform.

**`apple_fm` shim reported zero token counts.** It hardcoded zeros with a note
that the SDK did not expose counts; SDK 0.2.1 added `token_count`. Zeroed
`completion_tokens` zeroes throughput, `energy_per_output_token_joules` and
`tokens_per_joule` for everything served through the shim. Streaming responses
now also carry `usage` on the final chunk. The install hint no longer tells
users to clone from GitHub -- `apple-fm-sdk` is on PyPI. System messages become
the session's `instructions` rather than being prefixed onto the prompt as
`[System] ...`, which discarded a distinction the SDK draws and inflated the
prompt-token count.

**`scripts/setup-energy-monitor.sh` did not exist**, though
`jarvis bench --setup-energy` built a path to it and offered to run it -- so
the offer silently did nothing.

**Digest audio failed silently in the desktop app.** Four separate
causes, fixed in turn:
- `/api/digest/audio` served Kokoro's WAV labelled `audio/mpeg`, so
  browsers never decoded it. It now uses the file's real type.
- The Tauri CSP had no `media-src`.
- WebView2 blocks both `http:` and `blob:` media in packaged apps with a
  "URL safety check" error. The desktop build now loads the file through
  Tauri's asset protocol (`convertFileSrc`).
- Every regeneration overwrote the same file under the same URL, so the
  shared `<audio>` element never reloaded. The src is now versioned
  (`?v=<generated_at>`), and playback errors are shown instead of
  swallowed.

**Stale PWA service worker served 503s after rebuilds.** Workbox's
precache pinned hashed filenames that `emptyOutDir` deleted on the next
build, so a leftover worker broke live API calls (including digest
audio) in both the desktop and browser builds. The service worker is
removed; the app only ever serves localhost.

**`DigestStore.get_today()` used the wrong clock.** It defaulted to UTC
while digests are stored in naive local time, so every digest generated
in the local evening vanished ("No digest for today") once UTC had rolled
over. It now defaults to the local clock.

**Day Ahead froze the server.** Calendar and task sync ran synchronously
inside the async route, blocking the single-worker server for 30+
seconds per load. It now runs in a worker thread.

**Desktop app orphaned its backend and could loop on exit** (Windows).
Quitting now kills the whole backend process tree (`taskkill /T`), and a
re-entrancy guard stops `RunEvent::ExitRequested` from looping forever.

**Category digest personas were overridden by the base prompt.** The
shared system prompt always injected the honorific opening, overriding
each category persona's own rule. It now applies only to the general
digest.

### Security

**WebSocket API keys no longer appear in request URLs.** Browser clients now
send a marked, base64url-encoded credential through
`Sec-WebSocket-Protocol`; programmatic clients can continue to use an
`Authorization: Bearer <key>` handshake header. The encoding only makes the
credential safe for WebSocket protocol syntax and does not encrypt it, so use
`wss://` for remote connections.

The former `?token=<key>` WebSocket authentication path is no longer accepted.
Custom browser clients must migrate to the `openjarvis.auth.v1` subprotocol
format documented in the API server guide.

## [1.0.2] - 2026-05-24

A patch release that fixes a packaging bug which broke the v1.0.1
wheel on PyPI, silences a noisy startup warning, restores a working
install path while `openjarvis.ai` is down, improves desktop
first-boot diagnostics on Windows, and ships the RAM-detection fix
for Windows that missed the v1.0.1 cutoff.

### Fixed

**`openjarvis/traces/` missing from the v1.0.1 PyPI wheel** (#372).
The `.gitignore` carried an unanchored `traces/` pattern, which
hatchling honored at wheel-build time and matched the runtime module
`src/openjarvis/traces/` — silently dropping the whole package. Every
fresh `pip install openjarvis==1.0.1` then failed at import with
`ModuleNotFoundError: No module named 'openjarvis.traces'` on the
first `jarvis ask`, learning, or server call. Anchored the pattern to
`/traces/`. Verified: a clean `uv build` now produces a wheel
containing all four `traces/` files.

**`pynvml` deprecation `FutureWarning` on every command** (#389).
Switched the dependency from the legacy `pynvml` package to NVIDIA's
official `nvidia-ml-py` (same `pynvml` module name, no warning shim),
and added defensive `warnings.filterwarnings` at every `import pynvml`
site to suppress the warning even when `pynvml` is pulled in
transitively.

**Windows RAM detection returning `0.0 GB`** (#373). The Windows
branch of `_total_ram_gb()` (via `GlobalMemoryStatusEx`) landed after
the v1.0.1 cutoff, so v1.0.1 users still saw `0.0 GB` from `jarvis
init`. Now shipping in the wheel. A new `windows-latest` CI job runs
the real `GlobalMemoryStatusEx` path on every PR as a regression
guard.

**Desktop first-boot hung on "did not become healthy in time"**
(#331). The Tauri boot path ran `uv sync` with stderr discarded and
the exit code ignored, so a failed dependency install surfaced only
as a generic 600-second health-check timeout. Now captures stderr,
checks the exit status, and surfaces the actual `uv sync` error
(with the diagnostic tail) before the long wait. The error-formatting
logic is covered by unit tests.

### Changed

**Install URL moved to GitHub Pages** (#337, #352). The documented
`openjarvis.ai/install.sh` URL was failing with `sslv3 alert
handshake failure` (the domain is community-operated and had a broken
TLS config). The canonical installer is now served from the
project-controlled GitHub Pages site at
`https://open-jarvis.github.io/OpenJarvis/install.sh`, generated from
the same `scripts/install/install.sh` at docs-build time. The README
also documents the WSL2 path for Windows and the `uv` prerequisite
for the desktop binary, and the installer bails early with a clear
message when run under Git Bash / MSYS2 / Cygwin.

## [1.0.1] - 2026-05-17

A patch release that closes the auto-update gap so the analytics
module added in #351 actually reaches users on the desktop, adds
runtime opt-out for that analytics, fixes the misleading upgrade
hint the CLI was printing, and lands the ACE optimizer alongside
DSPy and GEPA.

### Added

**ACE agent optimizer** (`learning/agents/ace_optimizer.py`). Adds
[ACE](https://github.com/ace-agent/ace) as a third agent-learning
policy alongside DSPy and GEPA. Where DSPy bootstraps few-shot
examples and GEPA evolves prompt populations, ACE evolves a textual
*playbook* of strategies the agent reads at inference time, updated
by a Generator / Reflector / Curator triad. Pick via
`[learning.agent] policy = "ace"`. Setup is manual (ACE isn't on
PyPI and isn't a properly-packaged Python project as of v1.0.1) —
see `docs/learning/ace.md` for the install path and trace-adapter
behavior.

**`jarvis self-update`** subcommand. Detects how OpenJarvis was
installed (pip, uv tool, editable git checkout) by inspecting
`openjarvis.__file__`, then runs the right upgrade command. Supports
`--check` (print the command without running) and `-y` (skip the
confirmation prompt). The post-command "new version available" hint
now points users at this command instead of guessing at the right
flow.

**Desktop auto-update endpoint wired to the rolling
`desktop-latest` GitHub release.** The Tauri updater plugin was
configured on the build side (`createUpdaterArtifacts: true`,
`includeUpdaterJson: true`, signing key in `TAURI_SIGNING_PRIVATE_KEY`)
but inert on the runtime side (`active: false`, `endpoints: []`). The
installed desktop app would never check. Both are now fixed; the app
polls `releases/download/desktop-latest/latest.json` every 30 minutes
and signature-verifies downloads against the minisign pubkey baked
into the app. Full flow, key-rotation runbook, and dev escape hatch
(`OPENJARVIS_NO_UPDATER=1`) documented in `docs/desktop-auto-update.md`.

**Analytics env-var opt-out** (`DO_NOT_TRACK`, `OPENJARVIS_NO_ANALYTICS`).
Tanvir's analytics module (#351) only respected the
`[analytics] enabled` config-file setting. Both env vars are now
honored in `is_analytics_enabled()` and in the install.sh beacon
script. Any truthy value (`1`, `true`, `yes`, `on`) disables for
that process; env opt-out takes precedence over the config file.
Documented under a new "Opting out" section in `docs/telemetry.md`.

### Changed

**Version-check trigger widened.** The "new version available" hint
in `_version_check.py` used to fire only on `{ask, chat, serve}` and
hardcoded the wrong upgrade command (`git pull && uv sync` — only
correct for editable installs). Now fires on every interactive
command (`doctor`, `init`, `quickstart`, `model`, `agents`, `skill`,
`memory`, `bench`, `telemetry`, `config`, `eval`, `optimize`, plus
the original three) and uses install-detection to print the right
upgrade command. Honors `JARVIS_NO_UPDATE_CHECK=1` and `CI=true` to
stay silent in automation.

**Desktop app version bumped 0.1.0 → 1.0.1** across
`tauri.conf.json`, `frontend/package.json`, and
`frontend/src-tauri/Cargo.toml` so the Python and desktop release
streams are aligned and the auto-updater has a real version to
compare against.

### Migration from 1.0.0

- **Importing `is_analytics_enabled`?** Same signature; behavior now
  short-circuits on env opt-out before checking the config. Callers
  that want the raw "is the config flag set" semantic should read
  `cfg.enabled` directly.
- **Editable-git users running `jarvis self-update`** get the
  detected `git pull && uv sync` command pointed at their actual
  checkout, not `~/OpenJarvis`. If you'd come to rely on the
  hardcoded path, update your muscle memory.

## [1.0.0] - 2026-05-15

The five-primitive architecture (Intelligence, Engine, Agents,
Tools & Memory, Learning) is now stable, with efficiency and
on-device learning as first-class capabilities alongside accuracy.
Companion blog post:
[From Minions to OpenJarvis: A Retrospective on Two Years in Local AI](https://hazyresearch.stanford.edu/blog/2026-05-19-minions-to-openjarvis-retrospective).

### Highlights

**Five composable primitives.** Intelligence, Engine, Agents, Tools & Memory,
and Learning each sit behind a single typed interface — any slot is
substitutable without touching the rest. The composition layer is
`JarvisSystem` in `src/openjarvis/system.py`, driven by a TOML config.

**Built-in agents across three execution modes.** Eight agents spanning a
single-turn chat baseline, a deep-research agent with inline citations,
a CodeAct-style coder, and a continuous monitor with memory compression
for long-horizon workflows. Execution modes cover on-demand, scheduled,
and continuous.

**Starter presets.** Eight preset configs installable via
`jarvis init --preset <name>` bundle an agent with a hardware-appropriate
engine, connectors, and tools. Variants cover Apple Silicon, Linux GPU
servers, and CPU-only laptops, plus a quickstart for LLM-guided spec search.

**Inference engines.** Four first-class local engines (Ollama, vLLM, SGLang,
llama.cpp) and five cloud providers (OpenAI, Anthropic, Google Gemini,
OpenRouter, MiniMax) sit behind a single `Engine` interface. Discovery
in `engine/_discovery.py` picks a sensible default per host.

### Added — hybrid local-cloud capabilities

**Per-query routing via a query-complexity analyzer**
(`src/openjarvis/learning/routing/complexity.py`). Produces a 0.0–1.0
complexity score with code/math/reasoning signals and a suggested token
budget, populating `RoutingContext` so easy queries stay local and only
queries that need frontier capability escalate.

**LLM-guided spec search** (`src/openjarvis/learning/spec_search/`).
`SpecSearchOrchestrator` wires diagnose → plan → execute → gate into a
single learning session: a frontier model reads traces, proposes
coordinated edits across all five primitives, and a held-out benchmark
gate (`gate/benchmark_gate.py`, `gate/regression.py`, `gate/cold_start.py`)
accepts only non-regressing edits. Ships with the `spec-search-quickstart`
preset and a runnable tutorial at `examples/openjarvis/spec_search_quickstart.py`.

**Six hybrid coordination paradigms** in `src/openjarvis/agents/hybrid/`.
Each paradigm pairs a local student with a frontier cloud teacher under
a different orchestration shape, as `LocalCloudAgent` subclasses:

- `minions` — reactive single-local + single-cloud loop
- `conductor` — static DAG planner
- `advisors` — executor ↔ advisor loop
- `archon` — generate → rank → fuse
- `skillorchestra` — per-query router across local skills
- `toolorchestra` — RL'd local model with a tool pool

A runner CLI (`python -m openjarvis.agents.hybrid.runner --cell <name>`)
and a 35-cell experiment registry (one TOML per method × benchmark ×
model triple) let researchers run, score, and compare these on equal
footing. Includes a Modal-backed SWE-bench-Verified harness scorer
(`evals/scorers/swebench_harness.py`).

### Added — efficiency as a first-class constraint

**Hardware-agnostic energy telemetry at 50ms resolution** across NVIDIA
(`telemetry/energy_nvidia.py`), AMD (`telemetry/energy_amd.py`), Apple
Silicon (`telemetry/energy_apple.py`), and Intel RAPL
(`telemetry/energy_rapl.py`). Energy, dollar cost, FLOPs, and latency
are treated as evaluation targets alongside accuracy.

**Instrumentation for FLOPs, batch, steady-state, ITL, phase energy, and
vLLM-specific metrics.** Joined per-query by the aggregator
(`telemetry/aggregator.py`) so traces carry accuracy + efficiency together.

### Added — local learning loop

**Closed-loop optimization across the stack** — model weights via SFT
(`learning/intelligence/sft_trainer.py`) and GRPO
(`learning/intelligence/grpo_trainer.py` plus an orchestrator-specific
variant under `learning/intelligence/orchestrator/`), prompts via DSPy
(`learning/agents/dspy_optimizer.py`), agent logic via GEPA
(`learning/agents/gepa_optimizer.py`), and engine + stack configuration
via LLM-guided spec search. `LearningOrchestrator` coordinates triggers
and applies optimizer overlays at discovery time so improvements compound
across primitives.

### Added — cross-framework evaluation

**External agentic-framework evaluation via subprocess.** The
`evals/backends/external/` subpackage wraps Hermes Agent and OpenClaw as
one-shot subprocess backends behind the existing `InferenceBackend` ABC.
The `evals/comparison/` toolkit provides path + commit-pin enforcement
(`third_party.py`), config templating (`make_configs.py`), and LaTeX
table generation (`table_gen.py`).

Ships with a new optional extra `framework-comparison` (depends on
`polars`), a `live_external` pytest marker for integration tests
requiring real foreign-framework installations, and a `ToolOrchestra`
evaluation dataset (`evals/datasets/toolorchestra.py`) alongside the
existing 30+ benchmark suite.

### Added — Skills System (Plans 1, 2A, 2B)

- **Skills core** — every skill is a tool. Skills appear in a system prompt catalog, agents invoke them on demand, content (pipeline results, markdown instructions, or both) gets injected into context.
  - `SkillManifest` + `SkillStep` types with tags, depends, invocation flags, markdown content
  - `SkillManager` — discovery, precedence resolution, catalog XML generation, tool wrapping
  - `SkillTool(BaseTool)` — auto-extracts parameters from step argument templates
  - `SkillExecutor` — sequential pipeline execution with sub-skill delegation
  - Dependency graph with cycle detection, max depth enforcement, capability unions
  - Security: four trust tiers (bundled/indexed/unreviewed/workspace), capability-gated enforcement
  - Skill index module for git-backed registry search

- **agentskills.io spec adoption** — canonical `SKILL.md` format with YAML frontmatter following the [agentskills.io](https://agentskills.io/specification) open standard.
  - `SkillParser` with strict spec validation + tolerant field mapping via `FIELD_MAPPING` table
  - `ToolTranslator` for external tool name translation (Bash -> shell_exec, Read -> file_read, etc.)
  - Source resolvers: `HermesResolver`, `OpenClawResolver`, `GitHubResolver`
  - `SkillImporter` with provenance tracking (`.source` metadata files), optional script import
  - Sourced subdirectory layout (`~/.openjarvis/skills/<source>/<name>/`)

- **Skills learning loop** — trace tagging, pattern discovery, DSPy/GEPA optimization.
  - Trace metadata tagging: `skill`, `skill_source`, `skill_kind` flow through ToolExecutor -> TraceCollector -> TraceStep
  - `SkillDiscovery` wired into `SkillManager.discover_from_traces()` with kebab name normalization
  - `SkillOptimizer` — per-skill DSPy/GEPA wrapper that buckets traces and writes sidecar overlays
  - `SkillOverlay` — sidecar storage at `~/.openjarvis/learning/skills/<name>/optimized.toml`
  - `SkillManager._load_overlays()` applies optimized descriptions + few-shot examples at discovery time
  - `LearningOrchestrator._maybe_optimize_skills()` — opt-in auto-trigger

- **Skills benchmark harness** — 4-condition PinchBench evaluation.
  - I3 fix: `skill_few_shot_examples` wired through SystemBuilder -> `_run_agent` -> `ToolUsingAgent` -> `native_react.REACT_SYSTEM_PROMPT`
  - `SkillBenchmarkRunner` — 4-condition x N-seed x M-task sweep with markdown report
  - `JarvisAgentBackend` accepts `skills_enabled` and `overlay_dir` kwargs
  - Conditions: `no_skills`, `skills_on`, `skills_optimized_dspy`, `skills_optimized_gepa`

- **CLI commands:**
  - `jarvis skill list` / `info` / `run` / `install` / `sync` / `sources` / `update` / `remove` / `search`
  - `jarvis skill discover` — mine traces for recurring tool patterns
  - `jarvis skill show-overlay` — inspect optimization output
  - `jarvis optimize skills` — run DSPy/GEPA per-skill optimization
  - `jarvis bench skills` — run the PinchBench skills benchmark

- **Agent prompt improvement:**
  - `native_react.REACT_SYSTEM_PROMPT` now includes "Using Skills" guidance that teaches agents to distinguish executable vs. instructional skill responses
  - `{skill_examples}` placeholder for optimized few-shot example injection

- **Configuration:**
  - `[skills]` section: `enabled`, `skills_dir`, `active`, `auto_discover`, `auto_sync`, `max_depth`, `sandbox_dangerous`
  - `[[skills.sources]]` section: `source`, `url`, `filter`, `auto_update`
  - `[learning.skills]` section: `auto_optimize`, `optimizer`, `min_traces_per_skill`, `optimization_interval_seconds`, `overlay_dir`
  - `SkillSourceConfig` and `SkillsLearningConfig` dataclasses

- **Documentation:**
  - `docs/user-guide/skills.md` — comprehensive user guide
  - `docs/architecture/skills.md` — technical deep-dive
  - `docs/tutorials/skills-workflow.md` — end-to-end tutorial
  - `docs/getting-started/configuration.md` — expanded with skills config sections
  - `CLAUDE.md` — updated architecture section

### Examples & Tutorials

- `examples/openjarvis/spec_search_quickstart.py` — runnable end-to-end
  LLM-guided spec search session.
- `docs/user-guide/llm-guided-spec-search.md` — paper-aligned user guide.
- `docs/architecture/learning.md` — Learning primitive deep-dive covering
  routing, spec search, optimizers, and the orchestrator.
- `docs/tutorials/` — code-companion, deep-research, messaging-hub,
  scheduled-ops, and skills-workflow walkthroughs.
- `src/openjarvis/agents/hybrid/registry/*.toml` — 35-cell registry of
  paradigm × benchmark × model experiments.

### Migration from 0.x

- **`learning/distillation/` is now `learning/spec_search/`.** The
  subsystem was renamed to match the LLM-guided spec search semantics
  documented in the companion paper. Update any imports
  (`from openjarvis.learning.distillation.*` →
  `from openjarvis.learning.spec_search.*`). The `jarvis distillation`
  CLI command is removed; use `spec_search`-prefixed config keys instead.
- **`_third_party.toml` no longer ships default paths.** Set
  `HERMES_AGENT_PATH` and `OPENCLAW_PATH` env vars to point at your
  local checkouts before running the framework-comparison harness;
  missing or empty paths now raise `ThirdPartyNotFoundError` with an
  actionable hint.
- **Engine `generate_full` return shape extended.**
  `JarvisAgentBackend.generate_full` and `JarvisDirectBackend.generate_full`
  now return the spec §6.2 extended fields (`energy_joules`,
  `peak_power_w`, `tool_calls`, `turn_count`, `framework`,
  `framework_commit`, `error`). Existing callers that didn't read these
  fields are unaffected; new callers can rely on cross-framework parity.

### Fixed

- **Trace metadata flow** — `ToolResult.metadata` now propagates through `TOOL_CALL_END` event to `TraceStep.metadata` (was silently dropped at the event-bus boundary).
- **TaintSet JSON serialization** — `ToolExecutor._json_safe_metadata()` filters non-JSON-serializable values (like `TaintSet`) from event payloads before they reach `TraceStore`.
- **Non-dict YAML frontmatter** — source resolvers handle `yaml.safe_load()` returning a string instead of a dict (discovered on real OpenClaw imports).
- **OpenClaw category/name queries** — `jarvis skill install openclaw:owner/slug` now correctly splits into category + name match.
- **SkillDiscovery trace compatibility** — `_extract_tool_sequence` reads from `step.input["tool"]` (the actual `TraceStep` format), not the nonexistent `step.tool_name` attribute.
- **LearningOrchestrator skill trigger** — `_maybe_optimize_skills` runs BEFORE the SFT-data short-circuit (skills are tagged via trace metadata, not mined as SFT pairs).
- **PinchBenchScorer constructor** — `SkillBenchmarkRunner` constructs `PinchBenchScorer(judge_backend, model)` instead of no-args.
- **EvalRunner results access** — reads per-task data from `eval_runner.results` property, not nonexistent `summary.results`.
