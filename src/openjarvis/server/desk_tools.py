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
"""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

from openjarvis.server.desks import BD_FEEDS, CONTENT_FEEDS, Desk
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


def brand_context(propertyId: str = "", sections: list | None = None) -> str:  # noqa: N803
    if not isinstance(propertyId, str) or not _ID.fullmatch(propertyId):
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


async def _feed(feed: str) -> Any:
    if feed in CONTENT_FEEDS:
        from openjarvis.server.content_routes import get_feed
    elif feed in BD_FEEDS:
        from openjarvis.server.bizdev_routes import get_feed
    else:  # pragma: no cover - checked by the caller
        raise HTTPException(status_code=400, detail="Not a desk feed")
    return await get_feed(feed)


def _panel_feed(desk: Desk) -> Callable[..., Awaitable[str]]:
    allowed = tuple(f for f in desk.panel_feeds if f not in FORBIDDEN_FEEDS)

    async def panel_feed(feed: str = "") -> str:
        if feed not in allowed:
            return _error(f"feed must be one of: {', '.join(allowed)}")
        try:
            return _dump(await _feed(feed))
        except HTTPException as exc:
            return _error(str(exc.detail))

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
        out.append({"type": "function", "function": {"name": name, **schema}})
    return out
