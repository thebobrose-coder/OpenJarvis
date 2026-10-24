"""One desk turn, on the route ``hermes_router.route_desk`` picked (hq 0020 P2).

- **Local:** qwen through Ollama, under the GPU lease, with the desk's soul
  and rulings as the system prompt and **only** the desk's loopback tools
  (``desk_tools.py``). Never the agent harness's shell, file or
  ``memory_manage`` tools: the server agent isn't involved at all.
- **Hermes:** ``/p/desk-<id>/v1/chat/completions`` with one
  ``X-Hermes-Session-Id`` per thread and **no system message**: only the
  thread's user and assistant text (the page context travels as user text).
  ``hermes.tool.progress`` events become trace rows.

Both yield the same SSE shape as the normal chat path (a ``route`` event,
``tool_call_start`` / ``tool_call_end``, completion chunks), so Chat renders
a desk turn like any other.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable

import httpx

from openjarvis.server import desk_tools, desks

logger = logging.getLogger("openjarvis.server.desk_chat")

LOCAL_TIMEOUT_S = 180.0
HERMES_TIMEOUT_S = 300.0
MAX_TOOL_ROUNDS = 5
TRACE_RESULT_MAX = 600
# Wait this long for the voice worker's GPU lease before saying so.
LEASE_WAIT_S = 20.0
LEASE_POLL_S = 2.0
LEASE_STALE_S = 15 * 60

NOT_SERVED = (
    "Desk not served yet: run sync-config.sh in Hermes once (it serves a desk "
    "whose soul is in place). Start with 'local,' to ask on this machine."
)

Event = tuple[
    str, dict[str, Any]
]  # ("route" | "tool_start" | "tool_end" | "text", payload)


# ---------- the system prompt (local route only) ----------


def _card_shapes(desk: desks.Desk) -> str:
    draft = ', "body": {"draft": "..."}' if "/bizdev" in desk.pages else ""
    shapes = {
        "open": {
            "kind": "open",
            "label": "...",
            "target": {"page": desk.pages[0], "focus": "<id>"},
        },
        "tick": {
            "kind": "tick",
            "label": "...",
            "target": {"file": "<folder>/<name>.md", "box": "D1"},
            "body": {"note": "..."},
        },
        "proposal_decision": {
            "kind": "proposal_decision",
            "label": "...",
            "target": {"id": "<proposal id>"},
            "body": {"decision": "approve or reject", "topic": "...", "note": "..."},
        },
        "ruling": {
            "kind": "ruling",
            "label": "...",
            "body": {"text": "the ruling, at most 500 characters"},
        },
    }
    lines = []
    for kind in desk.card_kinds:
        if kind in shapes:
            text = json.dumps(shapes[kind])
            if kind == "open" and draft:
                text = text[:-1] + draft + "}"
            lines.append(f"- {text}")
    return "\n".join(lines)


def system_prompt(desk: desks.Desk) -> str:
    parts = [
        f"You are the {desk.name}, one desk in the operator's OpenJarvis app. You "
        "read, rank, explain, draft and propose. You never act: you can't approve, "
        "publish, post, send, tick or record anything yourself.\n"
        "Use your tools for facts and say when a tool has no data. Quote rules "
        "verbatim from the tool output, never from memory.\n"
        "To propose an action, end your reply with one or more fenced code blocks "
        "whose info string is card, each holding one JSON object. The operator "
        "clicks a card to act; nothing happens otherwise. Card kinds on this desk:\n"
        f"{_card_shapes(desk)}\n"
        "Propose a ruling card when the operator states a lasting preference.\n"
        "Keep replies short, in the stack's own vocabulary.",
    ]
    soul = desks.soul_text(desk.id)
    if soul.strip():
        parts.append(soul.strip())
    rulings = desks.rulings_text(desk.id)
    if rulings.strip():
        parts.append("## Operator rulings\n" + rulings.strip())
    return "\n\n".join(parts)


def thread_messages(chat_messages: list, last_user_text: str) -> list[dict[str, str]]:
    """Only user and assistant text; the last user turn gets its prefix stripped."""
    out = [
        {"role": m.role, "content": m.content}
        for m in chat_messages
        if m.role in ("user", "assistant") and m.content
    ]
    for i in range(len(out) - 1, -1, -1):
        if out[i]["role"] == "user":
            out[i] = {"role": "user", "content": last_user_text}
            break
    return out


# ---------- the GPU lease ----------


def _parse(value: Any) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def lease_holder(now: datetime | None = None) -> str | None:
    """Who holds a fresh GPU lease (contract v1.1), or None. A lease past
    ``expires_at`` or older than 15 minutes is ignored, as Hermes ignores it."""
    from openjarvis.voice_worker import paths

    try:
        doc = json.loads(paths.lease_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    now = now or datetime.now(timezone.utc)
    acquired, expires = _parse(doc.get("acquired_at")), _parse(doc.get("expires_at"))
    if acquired is None or expires is None:
        return None
    if (now - acquired).total_seconds() >= LEASE_STALE_S or now >= expires:
        return None
    return str(doc.get("holder") or "another holder")


async def _wait_for_gpu() -> str | None:
    deadline = time.monotonic() + LEASE_WAIT_S
    holder = lease_holder()
    while holder and time.monotonic() < deadline:
        await asyncio.sleep(LEASE_POLL_S)
        holder = lease_holder()
    return holder


# ---------- local route ----------


def _args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


async def _run_tool(fn: Callable[..., Any], args: dict[str, Any]) -> str:
    try:
        if inspect.iscoroutinefunction(fn):
            return await fn(**args)
        return await asyncio.to_thread(fn, **args)
    except TypeError as exc:
        return json.dumps({"error": f"bad arguments: {exc}"})
    except Exception as exc:  # noqa: BLE001 -- a tool failure is the model's to report
        logger.warning("Desk tool failed: %s", type(exc).__name__)
        return json.dumps({"error": type(exc).__name__})


async def local_turn(
    desk: desks.Desk,
    messages: list[dict[str, str]],
    *,
    host: str,
    model: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> AsyncIterator[Event]:
    holder = await _wait_for_gpu()
    if holder:
        yield (
            "text",
            {
                "content": f"The GPU is lent out right now ({holder} holds the lease). "
                "Try again in a few minutes, or start with 'Hermes,'."
            },
        )
        return
    tools = desk_tools.tools_for(desk)
    schemas = desk_tools.schemas_for(desk)
    convo: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(desk)},
        *messages,
    ]
    async with httpx.AsyncClient(
        timeout=LOCAL_TIMEOUT_S, transport=transport
    ) as client:
        for round_no in range(MAX_TOOL_ROUNDS + 1):
            payload: dict[str, Any] = {
                "model": model,
                "messages": convo,
                "stream": False,
                "think": False,
                "options": {"temperature": 0.3},
            }
            # The last round has no tools, so the model has to answer.
            if round_no < MAX_TOOL_ROUNDS:
                payload["tools"] = schemas
            resp = await client.post(f"{host}/api/chat", json=payload)
            resp.raise_for_status()
            msg = resp.json().get("message") or {}
            calls = msg.get("tool_calls") or []
            if not calls or round_no == MAX_TOOL_ROUNDS:
                yield ("text", {"content": msg.get("content") or ""})
                return
            convo.append(
                {
                    "role": "assistant",
                    "content": msg.get("content") or "",
                    "tool_calls": calls,
                }
            )
            for call in calls:
                fn_spec = call.get("function") or {}
                name = str(fn_spec.get("name") or "")
                args = _args(fn_spec.get("arguments"))
                yield ("tool_start", {"tool": name, "arguments": args})
                started = time.monotonic()
                fn = tools.get(name)
                if fn is None:
                    result = json.dumps({"error": f"{name} isn't a tool on this desk"})
                else:
                    result = await _run_tool(fn, args)
                ok = not result.startswith('{"error"')
                yield (
                    "tool_end",
                    {
                        "tool": name,
                        "success": ok,
                        "latency": round(time.monotonic() - started, 3),
                        "result": result[:TRACE_RESULT_MAX],
                    },
                )
                convo.append({"role": "tool", "content": result, "tool_name": name})


# ---------- Hermes route ----------


def _progress_label(data: Any) -> tuple[str, str]:
    """A trace row from a ``hermes.tool.progress`` payload, whatever its keys."""
    if not isinstance(data, dict):
        return "hermes", str(data)[:200]
    tool = data.get("tool") or data.get("tool_name") or data.get("name") or "hermes"
    label = data.get("label") or data.get("message") or data.get("status") or ""
    return str(tool)[:80], str(label)[:200]


async def hermes_turn(
    desk: desks.Desk,
    messages: list[dict[str, str]],
    *,
    host: str,
    api_key: str,
    session_id: str,
    max_tokens: int,
    transport: httpx.AsyncBaseTransport | None = None,
) -> AsyncIterator[Event]:
    url = f"{host.rstrip('/')}/p/desk-{desk.id}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-Hermes-Session-Id": session_id,
        "Accept": "text/event-stream",
    }
    body = {
        "model": "hermes-agent",
        "messages": messages,
        "stream": True,
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(
        timeout=HERMES_TIMEOUT_S, transport=transport
    ) as client:
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            if resp.status_code == 404:
                yield ("text", {"content": NOT_SERVED})
                return
            if resp.status_code >= 400:
                yield ("text", {"content": f"Hermes error: HTTP {resp.status_code}"})
                return
            event = None
            async for line in resp.aiter_lines():
                if not line:
                    event = None
                    continue
                if line.startswith("event:"):
                    event = line[6:].strip()
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    doc = json.loads(data)
                except ValueError:
                    continue
                if event == "hermes.tool.progress":
                    tool, label = _progress_label(doc)
                    yield ("tool_start", {"tool": tool, "arguments": label})
                    yield ("tool_end", {"tool": tool, "success": True, "result": label})
                    continue
                if event and event != "message":
                    continue
                choices = doc.get("choices") if isinstance(doc, dict) else None
                if (
                    isinstance(choices, list)
                    and choices
                    and isinstance(choices[0], dict)
                ):
                    piece = (choices[0].get("delta") or {}).get("content")
                    if piece:
                        yield ("text", {"content": piece})


# ---------- SSE ----------


def sse(data: dict, event: str | None = None) -> str:
    prefix = f"event: {event}\n" if event else ""
    return f"{prefix}data: {json.dumps(data)}\n\n"


def chunk(
    chunk_id: str, model: str, content: str | None, finish: str | None = None
) -> dict:
    delta = {"content": content} if content is not None else {}
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


async def stream_events(
    events: AsyncIterator[Event], route: dict[str, Any], model: str, engine: str
) -> AsyncIterator[str]:
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    yield sse(route, event="route")
    try:
        async for kind, payload in events:
            if kind == "tool_start":
                yield sse(payload, event="tool_call_start")
            elif kind == "tool_end":
                yield sse(payload, event="tool_call_end")
            elif kind == "text":
                yield sse(chunk(chunk_id, model, payload["content"]))
    except Exception as exc:  # noqa: BLE001 -- the thread shows the failure
        logger.error("Desk turn failed: %s", type(exc).__name__)
        yield sse(chunk(chunk_id, model, f"\n\nDesk error: {type(exc).__name__}"))
    finish = chunk(chunk_id, model, None, "stop")
    finish["telemetry"] = {"engine": engine}
    finish["route"] = route
    yield sse(finish)
    yield "data: [DONE]\n\n"


async def collect(events: AsyncIterator[Event]) -> tuple[str, list[dict[str, Any]]]:
    """A non-streamed turn: the reply text and the tool trace."""
    text, trace = "", []
    async for kind, payload in events:
        if kind == "text":
            text += payload["content"]
        elif kind == "tool_end":
            trace.append(payload)
    return text, trace
