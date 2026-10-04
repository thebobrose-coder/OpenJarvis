# OpenJarvis fork: the human touchpoint

The operator's fork of [OpenJarvis](https://github.com/open-jarvis/OpenJarvis). It is the
**human touchpoint only** (voice, screen; hq decisions 0002 and 0004): it displays Hermes
state and relays operator commands. It holds no business logic, no schedules that think,
and no direct connectors to business data. Those live in Hermes (the private workspace
checkout, its own session). Build views over Hermes data, never pipelines.

## Data path

- Every Hermes feed goes through `src/openjarvis/server/hermes_panel.py`: a stale-copy
  proxy over the panels bridge (`HERMES_BRIDGE_URL`, default `http://127.0.0.1:8643`).
  Routes unwrap `data`, add `generated_at` / `age_seconds` / `stale`, keep a last-known
  copy, and treat 404 as "no data yet". Model a new feed on `commerce_routes.py`.
- Write routes only use the bridge's own patterns: flag files (refresh, decisions, stage
  moves) or the operator token (`HERMES_FIX_TOKEN_FILE`, `HERMES_AUTOFIX_POLICY_FILE`).
  The token file path is local config: never print it, never commit it.
- Never exercise a live write (decision, confirm, revert, refresh, re-check, tier flip)
  without the operator present. Test write routes against a mocked bridge only.
- Contract: `hq/contracts/openjarvis-hermes.md` in the private workspace. Never edit
  workspace files from here, except appending `## Result` to an inbox brief.

## Chat routing

`src/openjarvis/server/hermes_router.py` runs first in `/v1/chat/completions`: local-first
("Auto"), with Hermes registered as the `hermes-agent` model (contract §1, `:8642/v1`,
key `HERMES_API_KEY` in `~/.openjarvis/credentials.toml`). Hermes turns pass through with
no OpenJarvis agent, tools, system prompt, or memory. The `hermes` engine is
`passthrough_only`: discovery must never probe it, default to it, or fall back to it.

## Runtime on this machine

- The desktop app (`frontend/src-tauri`, `target/release/openjarvis-desktop.exe`) launches
  `uv run jarvis serve --port 8000 --engine ollama --model qwen3.5:9b --agent simple`
  from this tree's `.venv` (the model tag comes from the boot plan's RAM table).
- The voice worker is the Windows scheduled task `OpenJarvis Voice Worker` (logon trigger
  plus every 5 min, IgnoreNew): `python -m openjarvis.voice_worker` from `src/`, in its own
  venv at `%LocalAppData%\openjarvis\voice\.venv`, on `:8650`. Logs: `%LocalAppData%\openjarvis\logs\`.
- Both run from this working tree. **Do not switch branches or edit under `src/` while the
  app is open** without telling the operator. Never `taskkill /IM python.exe`.
- The PowerShell launcher is `jarvisdev`. `jarvis` is the OpenJarvis CLI itself.

## Commands

- Python tests: `uv run --inexact --extra dev pytest tests -p no:warnings`. Always pass
  `--inexact`: a plain `uv run` strips the dev and desktop extras the running app needs.
  The full suite has a known Windows FAILED baseline; diff the list, don't chase the count.
- Lint: `uvx ruff check`, `uvx ruff format`. No Prettier or ESLint: keep hand formatting.
- Frontend (`cd frontend`): `npx vitest run`, `npx tsc --noEmit -p .`, `npm run build`
  (writes `src/openjarvis/server/static/`, which the live server serves). Component tests
  use `renderToStaticMarkup`: keep pages as a pure `*View` plus a thin hook page.
- Desktop rebuild: `npx tauri build --no-bundle` in `frontend/`, then relaunch the exe.
  Never use the NSIS/MSI installer: it installs vanilla upstream.

## Git

- `origin` is thebobrose-coder/OpenJarvis (public). `upstream` is open-jarvis/OpenJarvis.
- Commits: `type(scope): summary`. Never force-push `main`.
- Upstream sync: merge `upstream/main` monthly per hq 0013. Procedure: `git fetch upstream`;
  branch `sync/upstream-<date>`;
  `git merge upstream/main`; keep `frontend/tsconfig.tsbuildinfo` deleted; regenerate
  lockfiles (`uv sync --inexact`, `npm install`); full tests and frontend build; stop.
  `main` fast-forwards only after the operator closes the desktop app; they reopen it after.
- Public fork: no store, persona, prospect, account, or key data in code, tests, fixtures,
  or commit messages. Scan the added lines and the whole tree before every push.

## Secrets

`.env` only (gitignored). Google OAuth tokens live in `~/.openjarvis/connectors/*.json`
(`google.json` shared, `g*.json` per connector); `credentials.toml` there holds the Hermes
key. Nothing under `~/.openjarvis/` or the private workspace's `_data\` is ever committed.

Session history belongs in Claude Code project memory, not in this file.
