"""The desks' local loopback tools (hq 0020 A4, P2): all read-only.

A local desk turn may call only its own desk's tools from this module, never
the agent harness's shell, file or memory tools. Nothing here writes, and no
tool reads ``trading_*`` or ``catalog_fixes``, on any desk.

- ``brand_context(propertyId, sections?)``: verbatim slices of Foundry's
  bundle, ``kernelContent`` and ``compliance.sections`` only. The rest of the
  bundle (which holds secrets) is never returned.
- ``episode(episodeId)``: one studio episode's files.
- ``studio_status()``: the studio's last run.
- ``panel_feed(feed)``: one of the desk's panel feeds, through the page's
  own proxy (its last good copy when the bridge is down).
- Ops (P3, local only): ``stack_health()``, ``health_events()``, ``briefs()``
  and ``runbook(name?)``, read from local config paths; they never run
  stack-health, archive a brief or touch a repo.
- Compliance (P3, local only): ``precheck(propertyId, text, judge?)`` runs
  Foundry's pre-check CLI (foundry-studio.md v0.2) as an argv list with the
  text on stdin. :func:`run_precheck` also serves the paste-and-check route,
  so the widget and the desk share one implementation. A timeout or a
  non-zero exit is "pre-check unavailable", never a pass.
"""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

from openjarvis.server.desks import BD_FEEDS, COMMERCE_FEEDS, CONTENT_FEEDS, Desk
from openjarvis.server.waiting_routes import _data_dir

#: A tool result is cut here so a local turn keeps room to answer.
RESULT_MAX = 12000
KERNEL_KEYS = ("brand", "characters", "lore", "hooks", "negatives", "video", "voice")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
#: Never readable from a desk, whatever a registry says.
FORBIDDEN_FEEDS = ("trading_status", "trading_day", "catalog_fixes")


def _dump(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, default=str)
    if len(text) > RESULT_MAX:
        text = text[:RESULT_MAX] + f" … (cut at {RESULT_MAX:,} characters)"
    return text


def _error(message: str) -> str:
    return json.dumps({"error": message})


def _bundle_property(property_id: str) -> tuple[dict | None, list[str]]:
    data = _data_dir()
    if data is None:
        return None, []
    try:
        bundle = json.loads(
            (data / "foundry" / "foundry-bundle.json").read_text(encoding="utf-8-sig")
        )
    except (OSError, ValueError):
        return None, []
    props = [p for p in bundle.get("properties") or [] if isinstance(p, dict)]
    ids = [str(p.get("id")) for p in props if p.get("id")]
    for p in props:
        if p.get("id") == property_id:
            return p, ids
    return None, ids


def property_ids() -> list[str]:
    """The property ids in Foundry's bundle (empty when it isn't readable)."""
    return _bundle_property("")[1]


def brand_context(propertyId: str = "", sections: list | None = None) -> str:  # noqa: N803
    if not isinstance(propertyId, str) or not _ID.fullmatch(propertyId):
        ids = property_ids()
        if ids:
            return _error(f"propertyId is required. Properties: {', '.join(ids)}")
        return _error("propertyId is required")
    prop, ids = _bundle_property(propertyId)
    if prop is None:
        if not ids:
            return _error("Foundry's bundle isn't readable on this machine")
        return _error(f"No property {propertyId!r}. Properties: {', '.join(ids)}")
    kernel = prop.get("kernelContent") or {}
    compliance = (prop.get("compliance") or {}).get("sections") or []
    index = [
        {"id": s.get("id"), "heading": s.get("heading")}
        for s in compliance
        if isinstance(s, dict)
    ]
    wanted = [str(s) for s in sections or [] if isinstance(s, (str, int))][:20]
    if not wanted:
        return _dump(
            {
                "propertyId": propertyId,
                "kernel": {k: kernel.get(k) for k in ("brand", "voice")},
                "kernelKeys": [k for k in KERNEL_KEYS if kernel.get(k)],
                "complianceSections": index,
                "note": "Ask again with sections (compliance ids or kernel keys) "
                "for their text, verbatim.",
            }
        )
    out: dict[str, Any] = {"propertyId": propertyId, "kernel": {}, "compliance": []}
    unknown = []
    for name in wanted:
        if name in KERNEL_KEYS:
            out["kernel"][name] = kernel.get(name)
            continue
        match = next(
            (s for s in compliance if isinstance(s, dict) and str(s.get("id")) == name),
            None,
        )
        if match is None:
            unknown.append(name)
        else:
            out["compliance"].append(
                {k: match.get(k) for k in ("id", "heading", "text")}
            )
    if unknown:
        out["unknown"] = unknown
        out["complianceSections"] = index
    return _dump(out)


def episode(episodeId: str = "") -> str:  # noqa: N803
    from openjarvis.server import studio_routes

    if not isinstance(episodeId, str) or not _ID.fullmatch(episodeId):
        return _error("episodeId is required")
    if _studio_missing():
        return _error("No studio yet")
    try:
        doc = studio_routes.episode_doc(episodeId)
    except HTTPException as exc:
        return _error(str(exc.detail))
    keep = (
        "summary",
        "manifest",
        "script",
        "claims",
        "g0Pending",
        "g0History",
        "publish",
    )
    return _dump({k: doc.get(k) for k in keep})


def _studio_missing() -> bool:
    data = _data_dir()
    return data is None or not (data / "studio").is_dir()


def studio_status() -> str:
    from openjarvis.server import studio_routes

    try:
        return _dump(studio_routes.status_doc())
    except HTTPException as exc:
        return _error("No studio yet" if exc.status_code == 404 else str(exc.detail))


# ---------- the Ops desk (v1.19: local only, all read-only) ----------


def stack_health() -> str:
    """The Stack drawer's summary: counts, the FAIL and WARN rows, the speech."""
    from openjarvis.server import stack_routes

    try:
        return _dump(stack_routes.read_summary())
    except HTTPException as exc:
        return _error(str(exc.detail))


def health_events() -> str:
    """The cloud Health relay's events file, as written."""
    from openjarvis.server import stack_routes

    path = stack_routes._configured(stack_routes.EVENTS_KEY)
    if path is None or not path.is_file():
        return _error("No cloud health events file")
    try:
        return _dump(stack_routes._read_json(path))
    except HTTPException as exc:
        return _error(str(exc.detail))


def briefs() -> str:
    """The Decisions drawer's listing: open boxes, briefs waiting on a Result,
    recently decided."""
    from openjarvis.server import waiting_routes

    data = _data_dir()
    if data is None:
        return _error("The workspace data folder isn't set")
    doc = waiting_routes.read_decisions(data)

    def clip(value: Any, n: int) -> Any:
        text = value if isinstance(value, str) else None
        return text if text is None or len(text) <= n else text[: n - 1] + "…"

    def box(b: dict, keys: tuple[str, ...]) -> dict:
        out = {"file": b.get("file"), "box": f"D{b.get('number')}"}
        for k in keys:
            if b.get(k) not in (None, ""):
                out[k] = clip(b[k], 400)
        return out

    # Compact: the drawer's own listing carries whole paragraphs and hashes.
    recent = doc.get("recently_decided") or []
    return _dump(
        {
            "open": [
                box(b, ("title", "decision", "default", "alternative", "modified_at"))
                for b in doc.get("open") or []
            ],
            "waiting_briefs": doc.get("waiting_briefs") or [],
            "recently_decided": [
                box(b, ("title", "decision", "decided_note", "modified_at"))
                for b in recent[:10]
            ],
            "recently_decided_total": len(recent),
        }
    )


def _runbooks_dir() -> Any:
    from pathlib import Path

    from openjarvis.core.credentials import get_tool_credential

    value = get_tool_credential("desks", "RUNBOOKS_DIR")
    path = Path(value).expanduser() if value else None
    return path if path is not None and path.is_dir() else None


def runbook(name: str = "") -> str:
    """With no name, the runbooks and their titles; with one, its text."""
    root = _runbooks_dir()
    if root is None:
        return _error("No runbooks folder configured")
    books = {p.stem: p for p in sorted(root.glob("*.md")) if p.is_file()}
    if not name:
        listing = []
        for stem, p in books.items():
            try:
                first = p.read_text(encoding="utf-8-sig").lstrip().splitlines()
            except OSError:
                first = []
            title = first[0].lstrip("# ").strip() if first else stem
            listing.append({"name": stem, "title": title})
        return _dump({"runbooks": listing})
    stem = name[:-3] if isinstance(name, str) and name.endswith(".md") else name
    if not isinstance(stem, str) or stem not in books:
        return _error(f"No runbook {name!r}. Runbooks: {', '.join(books)}")
    try:
        return _dump(
            {"name": stem, "text": books[stem].read_text(encoding="utf-8-sig")}
        )
    except OSError:
        return _error(f"{stem}.md could not be read")


# ---------- the Compliance desk: Foundry's pre-check CLI ----------

PRECHECK_TIMEOUT_S = 30.0
PRECHECK_JUDGE_TIMEOUT_S = 180.0
PRECHECK_TEXT_MAX = 20000
UNAVAILABLE = "pre-check unavailable"
#: The CLI inside the Foundry repo (foundry-studio.md v0.2), run with node and
#: tsx directly: an argv list, never a shell or a .cmd shim.
_TSX_CLI = ("node_modules", "tsx", "dist", "cli.mjs")
_PRECHECK_SCRIPT = "studio/precheck.ts"


def precheck_command(property_id: str, judge: bool) -> tuple[list[str], str] | None:
    """The fixed argv and working directory, from credentials.toml ``[desks]``
    ``PRECHECK_DIR`` (the Foundry repo) and optional ``PRECHECK_NODE``."""
    import shutil
    from pathlib import Path

    from openjarvis.core.credentials import get_tool_credential

    repo = get_tool_credential("desks", "PRECHECK_DIR")
    if not repo or not Path(repo).is_dir():
        return None
    node = get_tool_credential("desks", "PRECHECK_NODE") or shutil.which("node")
    if not node:
        return None
    argv = [
        node,
        str(Path(repo, *_TSX_CLI)),
        _PRECHECK_SCRIPT,
        "--property",
        property_id,
    ]
    if judge:
        argv.append("--judge")
    return argv, repo


def _kill_tree(proc: Any) -> None:
    import subprocess
    import sys

    if sys.platform == "win32":
        # tsx starts a child node: take the whole tree down, not just the parent.
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )
    proc.kill()


def _run_cli(argv: list[str], cwd: str, text: str, timeout: float) -> tuple[int, str]:
    """Run the CLI with the text on stdin. Returns (exit code, stdout); a
    timeout is exit code -1."""
    import subprocess

    proc = subprocess.Popen(
        argv,
        cwd=cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
    )
    try:
        out, _ = proc.communicate(text.encode("utf-8"), timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        proc.communicate()
        return -1, ""
    return proc.returncode, out.decode("utf-8", errors="replace")


def _unavailable(property_id: str, why: str) -> dict[str, Any]:
    return {
        "propertyId": property_id,
        "ok": False,
        "unavailable": True,
        "error": f"{UNAVAILABLE}: {why}",
        "hits": [],
    }


async def run_precheck(property_id: str, text: str, judge: bool = False) -> dict:
    """One pre-check, for the widget's route and the desk's tool alike. Never
    a pass unless the CLI ran, exited 0 and returned ``ok: true`` with no hits."""
    if not isinstance(property_id, str) or not _ID.fullmatch(property_id):
        return {"propertyId": property_id, "ok": False, "error": "Pick a property"}
    if not isinstance(text, str) or not text.strip():
        return {"propertyId": property_id, "ok": False, "error": "Paste some text"}
    if len(text) > PRECHECK_TEXT_MAX:
        return {
            "propertyId": property_id,
            "ok": False,
            "error": f"Text over {PRECHECK_TEXT_MAX:,} characters",
        }
    command = precheck_command(property_id, bool(judge))
    if command is None:
        return _unavailable(property_id, "the Foundry repo isn't configured")
    argv, cwd = command
    timeout = PRECHECK_JUDGE_TIMEOUT_S if judge else PRECHECK_TIMEOUT_S
    import asyncio

    try:
        code, out = await asyncio.to_thread(_run_cli, argv, cwd, text, timeout)
    except OSError as exc:
        return _unavailable(property_id, type(exc).__name__)
    if code == -1:
        return _unavailable(property_id, f"no answer in {int(timeout)} s")
    try:
        doc = json.loads(out.strip() or "null")
    except ValueError:
        doc = None
    if code == 2 and isinstance(doc, dict) and doc.get("error"):
        return {"propertyId": property_id, "ok": False, "error": str(doc["error"])}
    if code != 0 or not isinstance(doc, dict) or not isinstance(doc.get("hits"), list):
        return _unavailable(property_id, f"exit {code}")
    hits = [h for h in doc["hits"] if isinstance(h, dict)]
    return {
        "propertyId": doc.get("propertyId", property_id),
        "ok": bool(doc.get("ok")) and not hits,
        "judged": bool(doc.get("judged")),
        "hits": hits,
        "bundle": doc.get("bundle"),
    }


async def precheck(propertyId: str = "", text: str = "", judge: bool = False) -> str:  # noqa: N803
    return _dump(await run_precheck(propertyId, text, bool(judge)))


async def _feed(feed: str) -> Any:
    if feed == "store_performance":
        from openjarvis.server.store_performance_routes import get_store_performance

        return await get_store_performance()
    if feed in CONTENT_FEEDS:
        from openjarvis.server.content_routes import get_feed
    elif feed in BD_FEEDS:
        from openjarvis.server.bizdev_routes import get_feed
    elif feed in COMMERCE_FEEDS:
        from openjarvis.server.commerce_routes import get_feed
    else:  # pragma: no cover - checked by the caller
        raise HTTPException(status_code=400, detail="Not a desk feed")
    return await get_feed(feed)


#: The commerce feeds run to 20-280 KB, far past RESULT_MAX, so a desk reads
#: them compact: a list of up to LIST_MAX short items, or one item in full.
LIST_MAX = 25
_COMPACT_FEEDS = frozenset(COMMERCE_FEEDS)


def _clip(value: Any, n: int = 240) -> Any:
    if isinstance(value, str) and len(value) > n:
        return value[: n - 1] + "…"
    return value


def _pick(item: dict, keys: tuple[str, ...]) -> dict:
    return {k: _clip(item[k]) for k in keys if item.get(k) not in (None, "", [])}


def _matches(item: dict, wanted: str, keys: tuple[str, ...]) -> bool:
    return not wanted or any(str(item.get(k) or "") == wanted for k in keys)


_FINDING_KEYS = (
    "id",
    "property",
    "kind",
    "location",
    "field",
    "quote",
    "rule",
    "reason",
    "first_seen",
)
_REC_KEYS = ("id", "store", "category", "priority", "title", "created_at")


def _compact(feed: str, doc: Any, wanted: str, item_id: str) -> Any:
    """A commerce feed as a desk reads it: filtered by store or property,
    short items, and one item in full when ``item_id`` names it."""
    if not isinstance(doc, dict):
        return doc
    meta = {k: doc.get(k) for k in ("run_at", "generated_at", "stale") if k in doc}
    if feed == "compliance_findings":
        lists = ("open_findings", "advisory_findings", "resolved_since_last_run")
        if item_id:
            for name in lists:
                for f in doc.get(name) or []:
                    if isinstance(f, dict) and f.get("id") == item_id:
                        return {**meta, "finding": f, "list": name}
            return {"error": f"No finding {item_id!r}"}
        found = [
            f
            for f in doc.get("open_findings") or []
            if isinstance(f, dict) and _matches(f, wanted, ("property",))
        ]
        return {
            **meta,
            "counts": doc.get("counts"),
            "new_finding_ids": doc.get("new_finding_ids"),
            "open_findings_total": len(found),
            "open_findings": [_pick(f, _FINDING_KEYS) for f in found[:LIST_MAX]],
            "advisory_findings": [
                _pick(f, (*_FINDING_KEYS, "advisory_reason"))
                for f in doc.get("advisory_findings") or []
                if isinstance(f, dict) and _matches(f, wanted, ("property",))
            ][:LIST_MAX],
        }
    if feed == "ecom_recommendations":
        if item_id:
            for name in ("open", "recent_decided"):
                for r in doc.get(name) or []:
                    if isinstance(r, dict) and r.get("id") == item_id:
                        return {**meta, "recommendation": r, "list": name}
            return {"error": f"No recommendation {item_id!r}"}
        recs = [
            r
            for r in doc.get("open") or []
            if isinstance(r, dict) and _matches(r, wanted, ("store",))
        ]
        recs.sort(key=lambda r: (r.get("priority") or 3, str(r.get("created_at"))))
        return {
            **meta,
            "counts": doc.get("counts"),
            "acceptance_rate": doc.get("acceptance_rate"),
            "open_total": len(recs),
            "open": [
                {
                    **_pick(r, _REC_KEYS),
                    **_pick(r.get("detail") or {}, ("action", "expected_impact")),
                }
                for r in recs[:LIST_MAX]
            ],
            "note": "Ask again with id for one recommendation in full.",
        }
    # Per-store feeds: the stores asked for; the long page lists only counted.
    stores = []
    for s in doc.get("stores") or []:
        if not isinstance(s, dict) or not _matches(s, wanted, ("slug", "display_name")):
            continue
        slim = {}
        for k, v in s.items():
            if isinstance(v, list) and len(json.dumps(v, default=str)) > 2000:
                slim[k] = {"count": len(v), "first": v[:3]}
            else:
                slim[k] = v
        stores.append(slim)
    return {**meta, "stores": stores}


def _size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, default=str))


def _fit(doc: Any, budget: int = RESULT_MAX - 300) -> Any:
    """Shrink a compact view until it fits whole: halve the longest list (at
    any depth) and note it, so the desk gets valid JSON, never a cut string."""
    trimmed: list[str] = []

    def lists(node: Any, path: str, depth: int, out: list) -> list:
        if isinstance(node, list) and len(node) > 1:
            out.append((_size(node), depth, node, path))
        children = (
            node.items()
            if isinstance(node, dict)
            else enumerate(node)
            if isinstance(node, list)
            else ()
        )
        for key, child in children:
            lists(child, f"{path}.{key}" if path else str(key), depth + 1, out)
        return out

    while _size(doc) > budget:
        found = lists(doc, "", 0, [])
        if not found:
            break
        # Nested lists (a store's pages) go first; the top-level list (the
        # stores themselves, or the items) only when nothing nested is big.
        nested = [f for f in found if f[1] > 1 and f[0] > 300]
        _, _, target, path = max(nested or found, key=lambda f: f[0])
        del target[max(1, len(target) // 2) :]
        if path not in trimmed:
            trimmed.append(path)
    if trimmed and isinstance(doc, dict):
        doc["_trimmed"] = (
            "Shortened to fit: " + ", ".join(trimmed) + ". Use filter or id for more."
        )
    return doc


def _panel_feed(desk: Desk) -> Callable[..., Awaitable[str]]:
    allowed = tuple(f for f in desk.panel_feeds if f not in FORBIDDEN_FEEDS)

    async def panel_feed(feed: str = "", filter: str = "", id: str = "") -> str:  # noqa: A002
        if feed not in allowed:
            return _error(f"feed must be one of: {', '.join(allowed)}")
        try:
            doc = await _feed(feed)
        except HTTPException as exc:
            return _error(str(exc.detail))
        if feed in _COMPACT_FEEDS:
            doc = _fit(_compact(feed, doc, str(filter or ""), str(id or "")))
        return _dump(doc)

    return panel_feed


_SCHEMAS: dict[str, dict[str, Any]] = {
    "brand_context": {
        "description": (
            "A property's brand kernel and compliance rules from Foundry's bundle, "
            "verbatim. Call with only propertyId for the brand, voice and the list "
            "of compliance sections; then with sections (compliance ids like '2', "
            "or kernel keys like 'negatives', 'hooks') for their exact text. Quote "
            "rules from this, never from memory."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "propertyId": {"type": "string", "description": "The property id"},
                "sections": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Compliance section ids or kernel keys",
                },
            },
            "required": ["propertyId"],
        },
    },
    "episode": {
        "description": (
            "One studio episode: manifest, script, claims, G0 notes and publish fields."
        ),
        "parameters": {
            "type": "object",
            "properties": {"episodeId": {"type": "string"}},
            "required": ["episodeId"],
        },
    },
    "studio_status": {
        "description": "The video studio's last run: lanes, stages and what waits.",
        "parameters": {"type": "object", "properties": {}},
    },
    "stack_health": {
        "description": (
            "The Stack drawer's latest stack-health run: counts, every FAIL and "
            "WARN line with its detail, open cloud events and the spoken summary."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    "health_events": {
        "description": "The cloud Health relay's open AWS and Google events.",
        "parameters": {"type": "object", "properties": {}},
    },
    "briefs": {
        "description": (
            "The inbox briefs: open decision boxes, briefs still waiting on a "
            "Result, and recently decided boxes."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    "runbook": {
        "description": (
            "The hq runbooks. With no name, the list; with a name, that runbook's text."
        ),
        "parameters": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
        },
    },
    "precheck": {
        "description": (
            "Check pasted copy against a property's rules with Foundry's "
            "pre-check: each hit has its kind, the rule verbatim, the sentence "
            "and the match. judge adds the qwen judgment (slower). An "
            "'unavailable' answer is never a pass."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "propertyId": {"type": "string", "description": "The property id"},
                "text": {"type": "string", "description": "The copy to check"},
                "judge": {"type": "boolean"},
            },
            "required": ["propertyId", "text"],
        },
    },
    "panel_feed": {
        "description": "One of this desk's dashboard feeds, as the page shows it.",
        "parameters": {
            "type": "object",
            "properties": {"feed": {"type": "string"}},
            "required": ["feed"],
        },
    },
}


def tools_for(desk: Desk) -> dict[str, Callable[..., Any]]:
    """The callables a local turn on ``desk`` may run, by name."""
    available: dict[str, Callable[..., Any]] = {
        "brand_context": brand_context,
        "episode": episode,
        "studio_status": studio_status,
        "panel_feed": _panel_feed(desk),
        "stack_health": stack_health,
        "health_events": health_events,
        "briefs": briefs,
        "runbook": runbook,
        "precheck": precheck,
    }
    return {name: available[name] for name in desk.local_tools if name in available}


def schemas_for(desk: Desk) -> list[dict[str, Any]]:
    """Ollama/OpenAI tool definitions for the desk's local tools."""
    out = []
    for name in tools_for(desk):
        schema = json.loads(json.dumps(_SCHEMAS[name]))
        if name == "panel_feed":
            feeds = [f for f in desk.panel_feeds if f not in FORBIDDEN_FEEDS]
            schema["parameters"]["properties"]["feed"]["enum"] = feeds
            if _COMPACT_FEEDS & set(feeds):
                schema["description"] += (
                    " The commerce feeds come compact: up to 25 short items and the "
                    "total. filter narrows to one store slug or property id; id "
                    "returns one recommendation or finding in full."
                )
                schema["parameters"]["properties"]["filter"] = {
                    "type": "string",
                    "description": "A store slug or a property id",
                }
                schema["parameters"]["properties"]["id"] = {
                    "type": "string",
                    "description": "A recommendation or finding id",
                }
        out.append({"type": "function", "function": {"name": name, **schema}})
    return out
