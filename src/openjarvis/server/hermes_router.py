"""Local-first chat router with Hermes as a pass-through backend.

Contract: hq/contracts/openjarvis-hermes.md §1; authority model: hq decision
0002. Two model ids are handled here, ahead of the normal chat path:

- ``auto`` ("Auto (local first)"): each turn is routed to local qwen or to
  Hermes. Order: explicit prefix -> sticky conversation -> local classifier
  (low confidence goes local) -> daily Hermes cap.
- ``hermes-agent``: always Hermes, no routing.

Any turn that goes to Hermes is a strict pass-through: OpenJarvis's server
agent is never invoked, client ``tools`` are dropped, and no OpenJarvis
system prompt or memory context is added. Only user/assistant text is
forwarded. The server agent on this install has shell_exec/file_read/
code_interpreter; Hermes's replies must never be able to drive those.

Local turns fall through to the existing chat path unchanged; this module
only picks the local model and strips a ``local,`` prefix.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from openjarvis.core.paths import get_config_dir
from openjarvis.core.types import Message, Role

logger = logging.getLogger("openjarvis.server.hermes_router")

AUTO_MODEL_ID = "auto"
HERMES_MODEL_ID = "hermes-agent"
ROUTED_MODEL_IDS = frozenset({AUTO_MODEL_ID, HERMES_MODEL_ID})

CONFIDENCE_THRESHOLD = 0.6
LOW_CONFIDENCE_HINT = "Answered locally. Start with 'Hermes,' to ask Hermes."
# Tool-using Hermes replies take 10-30 s; leave generous headroom.
HERMES_TIMEOUT_S = 300.0
CLASSIFIER_TIMEOUT_S = 30.0

_HERMES_PREFIX = re.compile(r"^\s*(?:hermes\s*[,:]|@hermes\b[,:]?)\s*", re.IGNORECASE)
_LOCAL_PREFIX = re.compile(r"^\s*(?:local\s*[,:]|@local\b[,:]?)\s*", re.IGNORECASE)

# Store names are filled in at runtime by build_classifier_rubric(), from the
# operator's own store registry. This repo is public: never write them here.
_STORES_MARKER = "__SHOPIFY_STORES__"
_CLASSIFIER_RUBRIC_TEMPLATE = """You route one chat message for a business owner. \
Decide whether it needs HERMES (their business agent, which has their private data \
and tools) or LOCAL (a general assistant with no business data).

HERMES: anything about the owner's own business or projects: \
__SHOPIFY_STORES__, their products, orders, inventory, prices, SEO, Search \
Console; their watchlist, \
portfolio, markets, breaking alerts; Foundry (brands, content pipeline); x402 \
trading; work orders or changes to their projects; plans, tasks, or decisions \
Hermes has been involved in.

LOCAL: everything else: general knowledge, chit-chat, jokes, how-to questions, \
public web lookups, the time, the weather, the device, or reading back what \
the dashboard already shows.

Words like "my stores", "my watchlist", "my portfolio", "work order" point to \
HERMES. If unsure, lower your confidence.

Reply with JSON only: {"route": "hermes" or "local", "confidence": 0.0 to 1.0}"""


def _configured_store_names() -> list[str]:
    """Display names (slug if unnamed) from ``~/.openjarvis/shopify_stores.json``."""
    try:
        from openjarvis.connectors.shopify_stores import load_stores

        stores = load_stores()
    except Exception:  # noqa: BLE001 -- a bad registry must not break routing
        logger.warning("Could not read the Shopify store registry", exc_info=True)
        return []
    names: list[str] = []
    for slug, meta in stores.items():
        name = str((meta.get("display_name") if isinstance(meta, dict) else "") or slug)
        name = name.strip()
        if name and name not in names:
            names.append(name)
    return names


def build_classifier_rubric(store_names: list[str] | None = None) -> str:
    """The classifier's system prompt, naming the operator's configured stores."""
    names = _configured_store_names() if store_names is None else store_names
    stores = "their Shopify stores"
    if names:
        stores += f" ({', '.join(names)})"
    return _CLASSIFIER_RUBRIC_TEMPLATE.replace(_STORES_MARKER, stores)


# ---------------------------------------------------------------------------
# Decision
# ---------------------------------------------------------------------------


@dataclass
class RouteDecision:
    target: str  # "hermes" | "local"
    reason: str  # prefix | explicit_model | sticky | classifier | low_confidence
    #              | cap | no_key | classifier_error
    confidence: float | None = None
    hint: str | None = None
    notice: str | None = None

    def as_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


def parse_prefix(text: str) -> tuple[str | None, str]:
    """Return (``"hermes"``/``"local"``/None, text with the prefix stripped)."""
    m = _HERMES_PREFIX.match(text)
    if m:
        return "hermes", text[m.end() :]
    m = _LOCAL_PREFIX.match(text)
    if m:
        return "local", text[m.end() :]
    return None, text


ClassifyFn = Callable[[str], Awaitable[tuple[str, float]]]


async def decide_route(
    text: str,
    *,
    last_route: str | None,
    classify: ClassifyFn,
    usage: "HermesUsage",
    cap: int,
    key_available: bool,
) -> tuple[RouteDecision, str]:
    """Route one Auto-mode user message. Returns (decision, forwarded text)."""
    forced, stripped = parse_prefix(text)
    if forced == "hermes":
        return RouteDecision("hermes", "prefix"), stripped
    if forced == "local":
        return RouteDecision("local", "prefix"), stripped

    if not key_available:
        # Hermes can't be reached anyway; don't spend a classifier call.
        return RouteDecision("local", "no_key"), text

    try:
        route, confidence = await classify(text)
    except Exception:
        logger.warning("Route classifier failed; answering locally", exc_info=True)
        route, confidence = "local", 0.0
        classifier_failed = True
    else:
        classifier_failed = False

    confident = confidence >= CONFIDENCE_THRESHOLD
    if last_route == "hermes" and not (route == "local" and confident):
        decision = RouteDecision("hermes", "sticky", confidence)
    elif route == "hermes" and confident:
        decision = RouteDecision("hermes", "classifier", confidence)
    elif classifier_failed:
        decision = RouteDecision("local", "classifier_error", confidence)
    elif not confident:
        decision = RouteDecision(
            "local", "low_confidence", confidence, hint=LOW_CONFIDENCE_HINT
        )
    else:
        decision = RouteDecision("local", "classifier", confidence)

    if decision.target == "hermes" and usage.count_today() >= cap:
        notice = None
        if usage.take_cap_notice():
            notice = (
                f"Hermes daily cap reached ({cap} turns), so Auto answered "
                "locally. Start with 'Hermes,' to ask Hermes anyway."
            )
        decision = RouteDecision("local", "cap", confidence, notice=notice)
    return decision, text


# ---------------------------------------------------------------------------
# Classifier (local qwen via Ollama /api/chat)
# ---------------------------------------------------------------------------


def _ollama_host(app_config: Any) -> str:
    host = ""
    if app_config is not None:
        host = getattr(getattr(app_config.engine, "ollama", None), "host", "") or ""
    return (
        host or os.environ.get("OLLAMA_HOST") or "http://localhost:11434"
    ).rstrip("/")


def make_classifier(
    host: str,
    model: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ClassifyFn:
    async def classify(text: str) -> tuple[str, float]:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": build_classifier_rubric()},
                {"role": "user", "content": text},
            ],
            "format": "json",
            "think": False,
            "stream": False,
            "options": {"temperature": 0},
        }
        async with httpx.AsyncClient(
            timeout=CLASSIFIER_TIMEOUT_S, transport=transport
        ) as client:
            resp = await client.post(f"{host}/api/chat", json=payload)
            resp.raise_for_status()
        content = resp.json().get("message", {}).get("content", "")
        return parse_classification(content)

    return classify


def parse_classification(content: str) -> tuple[str, float]:
    """Parse the classifier's JSON reply; anything malformed is (local, 0)."""
    try:
        data = json.loads(content)
        route = str(data.get("route", "")).strip().lower()
        confidence = float(data.get("confidence", 0))
    except (ValueError, TypeError, AttributeError):
        return "local", 0.0
    if route not in ("hermes", "local"):
        return "local", 0.0
    return route, max(0.0, min(1.0, confidence))


# ---------------------------------------------------------------------------
# Daily Hermes turn counter
# ---------------------------------------------------------------------------


class HermesUsage:
    """Per-day Hermes turn count, persisted so restarts don't reset the cap."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (get_config_dir() / "hermes_usage.json")
        self._lock = threading.Lock()

    def _load(self) -> dict:
        today = date.today().isoformat()
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if data.get("date") != today:
            data = {"date": today, "count": 0, "cap_notice": False}
        return data

    def _save(self, data: dict) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(data), encoding="utf-8")
        except OSError:
            logger.warning("Could not persist Hermes usage", exc_info=True)

    def count_today(self) -> int:
        with self._lock:
            return int(self._load().get("count", 0))

    def record_turn(self) -> int:
        with self._lock:
            data = self._load()
            data["count"] = int(data.get("count", 0)) + 1
            self._save(data)
            return data["count"]

    def take_cap_notice(self) -> bool:
        """True the first time per day the cap blocks an Auto turn."""
        with self._lock:
            data = self._load()
            if data.get("cap_notice"):
                return False
            data["cap_notice"] = True
            self._save(data)
            return True


_usage: HermesUsage | None = None


def get_usage() -> HermesUsage:
    global _usage
    if _usage is None:
        _usage = HermesUsage()
    return _usage


# ---------------------------------------------------------------------------
# Hermes pass-through
# ---------------------------------------------------------------------------


def hermes_api_key() -> str | None:
    """Bearer from the credential store (falls back to the environment)."""
    from openjarvis.core.credentials import get_tool_credential

    return get_tool_credential("hermes", "HERMES_API_KEY")


def _hermes_cap(app_config: Any) -> int:
    hermes_cfg = getattr(getattr(app_config, "engine", None), "hermes", None)
    return int(getattr(hermes_cfg, "daily_turn_cap", 100))


def make_hermes_engine(app_config: Any, api_key: str) -> Any:
    from openjarvis.engine.openai_compat_engines import HermesEngine

    hermes_cfg = getattr(getattr(app_config, "engine", None), "hermes", None)
    host = os.environ.get("HERMES_HOST") or getattr(hermes_cfg, "host", "") or None
    return HermesEngine(host=host, api_key=api_key, timeout=HERMES_TIMEOUT_S)


def passthrough_messages(chat_messages: list, last_user_text: str) -> list[Message]:
    """Only user/assistant text; the last user turn gets its prefix stripped.

    System messages (OpenJarvis identity, memory context), tool messages and
    tool calls are all dropped.
    """
    out: list[Message] = []
    for m in chat_messages:
        if m.role not in ("user", "assistant") or not m.content:
            continue
        role = Role.USER if m.role == "user" else Role.ASSISTANT
        out.append(Message(role=role, content=m.content))
    for i in range(len(out) - 1, -1, -1):
        if out[i].role == Role.USER:
            out[i] = Message(role=Role.USER, content=last_user_text)
            break
    return out


def _sse(data: dict, event: str | None = None) -> str:
    prefix = f"event: {event}\n" if event else ""
    return f"{prefix}data: {json.dumps(data)}\n\n"


def _chunk(chunk_id: str, content: str | None, finish: str | None = None) -> dict:
    delta = {"content": content} if content is not None else {}
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": HERMES_MODEL_ID,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _no_key_message() -> str:
    return (
        "Hermes isn't set up yet: add the Hermes API key in Settings "
        "(credential HERMES_API_KEY)."
    )


async def hermes_response(
    request_body: Any,
    app_config: Any,
    decision: RouteDecision,
    last_user_text: str,
    *,
    engine_factory: Callable[[Any, str], Any] = make_hermes_engine,
) -> Any:
    """Serve one turn from Hermes. No agent, no tools, no OpenJarvis context."""
    api_key = hermes_api_key()
    messages = passthrough_messages(request_body.messages, last_user_text)
    route = decision.as_dict()
    # Hermes manages its own output length; don't clip tool-heavy answers.
    max_tokens = max(int(request_body.max_tokens or 0), 4096)

    if request_body.stream:

        async def generate():
            chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
            yield _sse(route, event="route")
            if not api_key:
                yield _sse(_chunk(chunk_id, _no_key_message(), "stop"))
                yield "data: [DONE]\n\n"
                return
            get_usage().record_turn()
            engine = engine_factory(app_config, api_key)
            try:
                async for token in engine.stream(
                    messages,
                    model=HERMES_MODEL_ID,
                    temperature=request_body.temperature,
                    max_tokens=max_tokens,
                ):
                    yield _sse(_chunk(chunk_id, token))
            except Exception as exc:
                logger.error("Hermes stream error: %s", exc)
                yield _sse(_chunk(chunk_id, f"\n\nHermes error: {exc}", "stop"))
                yield "data: [DONE]\n\n"
                return
            finally:
                await asyncio.to_thread(engine.close)
            finish = _chunk(chunk_id, None, "stop")
            finish["telemetry"] = {"engine": "hermes"}
            finish["route"] = route
            yield _sse(finish)
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    return await _hermes_nonstream(
        messages, request_body, app_config, route, api_key, max_tokens, engine_factory
    )


async def _hermes_nonstream(
    messages, request_body, app_config, route, api_key, max_tokens, engine_factory
) -> dict:
    content = _no_key_message()
    usage: dict = {}
    if api_key:
        get_usage().record_turn()
        engine = engine_factory(app_config, api_key)
        try:
            result = await asyncio.to_thread(
                engine.generate,
                messages,
                model=HERMES_MODEL_ID,
                temperature=request_body.temperature,
                max_tokens=max_tokens,
            )
            content = result.get("content", "")
            usage = result.get("usage", {})
        except Exception as exc:
            logger.error("Hermes request error: %s", exc)
            content = f"Hermes error: {exc}"
        finally:
            await asyncio.to_thread(engine.close)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": HERMES_MODEL_ID,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
        },
        "telemetry": {"engine": "hermes"},
        "route": route,
    }


# ---------------------------------------------------------------------------
# Entry point from /v1/chat/completions
# ---------------------------------------------------------------------------


def _last_user_text(chat_messages: list) -> str:
    for m in reversed(chat_messages):
        if m.role == "user" and m.content:
            return m.content
    return ""


def _set_last_user_text(chat_messages: list, text: str) -> None:
    for m in reversed(chat_messages):
        if m.role == "user" and m.content:
            m.content = text
            return


def local_model(request: Request) -> str:
    model = getattr(request.app.state, "model", "") or ""
    if not model:
        cfg = getattr(request.app.state, "config", None)
        model = getattr(getattr(cfg, "intelligence", None), "default_model", "") or ""
    return model


async def route_chat(
    request_body: Any,
    request: Request,
    *,
    classify: ClassifyFn | None = None,
    engine_factory: Callable[[Any, str], Any] = make_hermes_engine,
) -> tuple[Any | None, RouteDecision | None]:
    """Handle ``auto``/``hermes-agent`` requests.

    Returns ``(response, None)`` when Hermes served the turn, or
    ``(None, decision)`` when the turn should continue down the normal local
    chat path; ``request_body.model`` and the last user message have then
    already been rewritten for the local model.
    """
    app_config = getattr(request.app.state, "config", None)
    text = _last_user_text(request_body.messages)

    if request_body.model == HERMES_MODEL_ID:
        _, stripped = parse_prefix(text)
        decision = RouteDecision("hermes", "explicit_model")
        return await hermes_response(
            request_body, app_config, decision, stripped, engine_factory=engine_factory
        ), None

    model = local_model(request)
    decision, forwarded = await decide_route(
        text,
        last_route=getattr(request_body, "last_route", None),
        classify=classify or make_classifier(_ollama_host(app_config), model),
        usage=get_usage(),
        cap=_hermes_cap(app_config),
        key_available=bool(hermes_api_key()),
    )
    if decision.target == "hermes":
        return await hermes_response(
            request_body, app_config, decision, forwarded, engine_factory=engine_factory
        ), None

    request_body.model = model
    if forwarded != text:
        _set_last_user_text(request_body.messages, forwarded)
    return None, decision


def attach_route(response: Any, decision: RouteDecision) -> Any:
    """Tag a local-path response with the route decision for the UI badge."""
    route = decision.as_dict()
    if isinstance(response, StreamingResponse):
        inner = response.body_iterator

        async def with_route():
            yield _sse(route, event="route")
            async for part in inner:
                yield part

        response.body_iterator = with_route()
        return response
    if hasattr(response, "model_dump"):
        payload = response.model_dump()
        payload["route"] = route
        return payload
    if isinstance(response, dict):
        response["route"] = route
    return response


# ---------------------------------------------------------------------------
# Settings: today's Hermes turn count
# ---------------------------------------------------------------------------

hermes_usage_router = APIRouter(tags=["hermes"])


@hermes_usage_router.get("/v1/hermes/usage")
async def hermes_usage(request: Request) -> dict:
    app_config = getattr(request.app.state, "config", None)
    return {
        "date": date.today().isoformat(),
        "count": get_usage().count_today(),
        "cap": _hermes_cap(app_config),
        "key_configured": bool(hermes_api_key()),
    }
