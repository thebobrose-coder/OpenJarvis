"""Tests for the local-first chat router and the Hermes pass-through."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx
from fastapi.testclient import TestClient

from openjarvis.core.types import Role
from openjarvis.server import hermes_router as hr
from openjarvis.server.app import create_app

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_state(tmp_path, monkeypatch):
    """Per-test usage file, credential store, and (empty) Shopify store
    registry; no ambient Hermes env."""
    from openjarvis.connectors import shopify_stores
    from openjarvis.core import credentials

    monkeypatch.delenv("HERMES_API_KEY", raising=False)
    monkeypatch.delenv("HERMES_HOST", raising=False)
    monkeypatch.setattr(
        credentials, "_default_path", lambda: tmp_path / "credentials.toml"
    )
    monkeypatch.setattr(shopify_stores, "load_stores", lambda: {})
    monkeypatch.setattr(hr, "_usage", hr.HermesUsage(tmp_path / "usage.json"))
    yield
    # save_credential() also sets os.environ; don't leak it to other tests.
    monkeypatch.delenv("HERMES_API_KEY", raising=False)


def _store_key(value: str = "sk-hermes-test") -> None:
    from openjarvis.core.credentials import save_credential

    save_credential("hermes", "HERMES_API_KEY", value)


def _classifier(route: str, confidence: float):
    calls: list[str] = []

    async def classify(text: str):
        calls.append(text)
        return route, confidence

    classify.calls = calls
    return classify


def _decide(text, *, route="local", confidence=0.9, last_route=None, cap=100,
            key=True, usage=None):
    return asyncio.run(
        hr.decide_route(
            text,
            last_route=last_route,
            classify=_classifier(route, confidence),
            usage=usage or hr.get_usage(),
            cap=cap,
            key_available=key,
        )
    )


class _FakeHermesEngine:
    """Records exactly what would be sent to Hermes."""

    def __init__(self, reply: str = "Hermes reply") -> None:
        self.reply = reply
        self.calls: list[dict] = []
        self.closed = False

    async def stream(self, messages, *, model, **kwargs):
        self.calls.append({"messages": list(messages), "model": model, **kwargs})
        for part in self.reply.split(" "):
            yield part + " "

    def generate(self, messages, *, model, **kwargs):
        self.calls.append({"messages": list(messages), "model": model, **kwargs})
        return {"content": self.reply, "usage": {"total_tokens": 3}}

    def close(self):
        self.closed = True


def _app(monkeypatch, fake_engine, *, classify=None):
    from openjarvis.core.config import JarvisConfig

    cfg = JarvisConfig()
    cfg.analytics.enabled = False
    cfg.traces.enabled = False
    cfg.security.enabled = False
    cfg.agent.context_from_memory = True

    server_engine = MagicMock()
    server_engine.engine_id = "mock"
    server_engine.list_models.return_value = ["qwen3.5:9b"]
    agent = MagicMock()
    agent.agent_id = "orchestrator"
    agent._tools = ["shell_exec", "file_read"]
    memory_backend = MagicMock()

    app = create_app(
        server_engine,
        "qwen3.5:9b",
        agent=agent,
        config=cfg,
        memory_backend=memory_backend,
    )
    captured: dict = {}

    def factory(app_config, api_key):
        captured["api_key"] = api_key
        return fake_engine

    real_route_chat = hr.route_chat

    async def route_chat(request_body, request, **kwargs):
        return await real_route_chat(
            request_body, request, classify=classify, engine_factory=factory
        )

    monkeypatch.setattr(hr, "route_chat", route_chat)
    return TestClient(app), server_engine, agent, memory_backend, captured


def _sse_events(text: str) -> list[tuple[str | None, str]]:
    events, event = [], None
    for line in text.splitlines():
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            events.append((event, line[6:]))
            event = None
    return events


# ---------------------------------------------------------------------------
# Router decisions
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, target, rest",
    [
        ("Hermes, how are my stores?", "hermes", "how are my stores?"),
        ("hermes: status", "hermes", "status"),
        ("@hermes what's new", "hermes", "what's new"),
        ("local, tell me a joke", "local", "tell me a joke"),
        ("@local joke please", "local", "joke please"),
        ("Hermes is a Greek god", None, "Hermes is a Greek god"),
        ("locally sourced food?", None, "locally sourced food?"),
    ],
)
def test_parse_prefix(text, target, rest):
    assert hr.parse_prefix(text) == (target, rest)


def test_hermes_prefix_routes_to_hermes_without_classifying():
    classify = _classifier("local", 1.0)
    decision, text = asyncio.run(
        hr.decide_route(
            "Hermes, which stores do I have?",
            last_route=None,
            classify=classify,
            usage=hr.get_usage(),
            cap=100,
            key_available=True,
        )
    )
    assert (decision.target, decision.reason) == ("hermes", "prefix")
    assert text == "which stores do I have?"
    assert classify.calls == []


def test_local_prefix_routes_local():
    decision, text = _decide("@local how are my stores doing?", route="hermes")
    assert (decision.target, decision.reason) == ("local", "prefix")
    assert text == "how are my stores doing?"


def test_confident_hermes_classification():
    decision, _ = _decide("how are my stores doing today?", route="hermes", confidence=0.9)
    assert (decision.target, decision.reason) == ("hermes", "classifier")


def test_confident_local_classification():
    decision, _ = _decide("capital of Australia?", route="local", confidence=0.95)
    assert (decision.target, decision.reason, decision.hint) == (
        "local", "classifier", None
    )


@pytest.mark.parametrize("route", ["hermes", "local"])
def test_low_confidence_goes_local_with_hint(route):
    decision, _ = _decide("hmm, what about that?", route=route, confidence=0.4)
    assert decision.target == "local"
    assert decision.reason == "low_confidence"
    assert decision.hint == hr.LOW_CONFIDENCE_HINT


def test_sticky_stays_with_hermes_unless_confident_local():
    decision, _ = _decide("and the second one?", route="local", confidence=0.5,
                          last_route="hermes")
    assert (decision.target, decision.reason) == ("hermes", "sticky")

    decision, _ = _decide("tell me a joke", route="local", confidence=0.9,
                          last_route="hermes")
    assert (decision.target, decision.reason) == ("local", "classifier")


def test_classifier_failure_goes_local():
    async def broken(text):
        raise httpx.ConnectError("ollama down")

    decision, _ = asyncio.run(
        hr.decide_route("how are my stores?", last_route=None, classify=broken,
                        usage=hr.get_usage(), cap=100, key_available=True)
    )
    assert (decision.target, decision.reason) == ("local", "classifier_error")


def test_no_key_answers_locally_without_classifying():
    decision, _ = _decide("how are my stores?", route="hermes", key=False)
    assert (decision.target, decision.reason) == ("local", "no_key")


def test_cap_blocks_auto_and_notices_once(tmp_path):
    usage = hr.HermesUsage(tmp_path / "capped.json")
    for _ in range(3):
        usage.record_turn()

    first, _ = _decide("how are my stores?", route="hermes", cap=3, usage=usage)
    assert (first.target, first.reason) == ("local", "cap")
    assert first.notice and "cap" in first.notice

    second, _ = _decide("and my watchlist?", route="hermes", cap=3, usage=usage)
    assert (second.target, second.reason, second.notice) == ("local", "cap", None)

    sticky, _ = _decide("and?", route="local", confidence=0.3, last_route="hermes",
                        cap=3, usage=usage)
    assert sticky.target == "local"

    # Explicit prefix still reaches Hermes past the cap.
    forced, _ = _decide("Hermes, how are my stores?", cap=3, usage=usage)
    assert forced.target == "hermes"


@pytest.mark.parametrize(
    "content, expected",
    [
        ('{"route": "hermes", "confidence": 0.92}', ("hermes", 0.92)),
        ('{"route": "LOCAL", "confidence": 1.5}', ("local", 1.0)),
        ('{"route": "maybe", "confidence": 0.9}', ("local", 0.0)),
        ("not json", ("local", 0.0)),
    ],
)
def test_parse_classification(content, expected):
    assert hr.parse_classification(content) == expected


def test_classifier_request_shape():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"message": {"content": '{"route":"hermes","confidence":0.8}'}}
        )

    classify = hr.make_classifier(
        "http://ollama:11434", "qwen3.5:9b", transport=httpx.MockTransport(handler)
    )
    assert asyncio.run(classify("how are my stores?")) == ("hermes", 0.8)
    body = seen["body"]
    assert seen["url"] == "http://ollama:11434/api/chat"
    assert body["format"] == "json"
    assert body["think"] is False
    assert body["options"]["temperature"] == 0
    assert body["model"] == "qwen3.5:9b"
    assert body["messages"][0]["content"] == hr.build_classifier_rubric()


_EXAMPLE_STORES = {
    "example-outdoor-co": {"display_name": "Example Outdoor Co", "gsc_site_url": ""},
    "sample-parts": {"display_name": "", "gsc_site_url": ""},
}


def test_rubric_names_configured_stores(monkeypatch):
    from openjarvis.connectors import shopify_stores

    monkeypatch.setattr(shopify_stores, "load_stores", lambda: _EXAMPLE_STORES)
    rubric = hr.build_classifier_rubric()
    expected = "their Shopify stores (Example Outdoor Co, sample-parts), their products"
    assert expected in rubric
    assert hr._STORES_MARKER not in rubric


def test_rubric_without_stores_names_none():
    rubric = hr.build_classifier_rubric()
    assert "their Shopify stores, their products" in rubric
    assert hr._STORES_MARKER not in rubric


def test_rubric_survives_unreadable_registry(monkeypatch):
    from openjarvis.connectors import shopify_stores

    def broken():
        raise OSError("unreadable")

    monkeypatch.setattr(shopify_stores, "load_stores", broken)
    assert "their Shopify stores, their products" in hr.build_classifier_rubric()


def test_no_store_names_hardcoded_in_router():
    """This repo is public: store names come only from the runtime registry."""
    from pathlib import Path

    source = Path(hr.__file__).read_text(encoding="utf-8")
    assert "Shopify stores (" not in source
    assert "__SHOPIFY_STORES__, their" in hr._CLASSIFIER_RUBRIC_TEMPLATE


# ---------------------------------------------------------------------------
# Pass-through through the real /v1/chat/completions endpoint
# ---------------------------------------------------------------------------


_CONVERSATION = [
    {"role": "system", "content": "You are OpenJarvis. SECRET SYSTEM PROMPT"},
    {"role": "user", "content": "hi"},
    {"role": "assistant", "content": "hello",
     "tool_calls": [{"id": "t1", "type": "function",
                     "function": {"name": "shell_exec", "arguments": "{}"}}]},
    {"role": "tool", "content": "tool output", "tool_call_id": "t1"},
    {"role": "user", "content": "Hermes, which stores do I have?"},
]
_TOOLS = [{"type": "function", "function": {"name": "shell_exec", "parameters": {}}}]


def _assert_pure_passthrough(fake, server_engine, agent, memory_backend):
    assert len(fake.calls) == 1
    call = fake.calls[0]
    msgs = call["messages"]
    assert [m.role for m in msgs] == [Role.USER, Role.ASSISTANT, Role.USER]
    assert [m.content for m in msgs] == ["hi", "hello", "which stores do I have?"]
    assert all(not m.tool_calls for m in msgs)
    assert "tools" not in call and "tool_choice" not in call
    assert call["model"] == hr.HERMES_MODEL_ID
    # Nothing on the OpenJarvis side ran.
    agent.run.assert_not_called()
    server_engine.generate.assert_not_called()
    server_engine.stream.assert_not_called()
    memory_backend.retrieve.assert_not_called()
    memory_backend.search.assert_not_called()


@pytest.mark.parametrize("model", [hr.HERMES_MODEL_ID, hr.AUTO_MODEL_ID])
def test_hermes_stream_is_pure_passthrough(monkeypatch, model):
    _store_key("sk-from-store")
    fake = _FakeHermesEngine("two stores")
    client, server_engine, agent, memory_backend, captured = _app(
        monkeypatch, fake, classify=_classifier("local", 1.0)
    )

    resp = client.post(
        "/v1/chat/completions",
        json={"model": model, "messages": _CONVERSATION, "tools": _TOOLS,
              "stream": True},
    )
    assert resp.status_code == 200
    events = _sse_events(resp.text)
    assert events[0][0] == "route"
    assert json.loads(events[0][1])["target"] == "hermes"
    content = "".join(
        json.loads(d)["choices"][0]["delta"].get("content") or ""
        for e, d in events
        if e is None and d != "[DONE]"
    )
    assert content.strip() == "two stores"
    finish = json.loads(events[-2][1])
    assert finish["telemetry"]["engine"] == "hermes"

    _assert_pure_passthrough(fake, server_engine, agent, memory_backend)
    assert captured["api_key"] == "sk-from-store"
    assert fake.closed
    assert hr.get_usage().count_today() == 1


def test_hermes_nonstream_is_pure_passthrough(monkeypatch):
    _store_key()
    fake = _FakeHermesEngine("two stores")
    client, server_engine, agent, memory_backend, _ = _app(monkeypatch, fake)

    resp = client.post(
        "/v1/chat/completions",
        json={"model": hr.HERMES_MODEL_ID, "messages": _CONVERSATION,
              "tools": _TOOLS},
    )
    body = resp.json()
    assert body["choices"][0]["message"]["content"] == "two stores"
    assert body["route"]["target"] == "hermes"
    _assert_pure_passthrough(fake, server_engine, agent, memory_backend)


def test_hermes_without_key_explains_and_sends_nothing(monkeypatch):
    fake = _FakeHermesEngine()
    client, *_ = _app(monkeypatch, fake)
    resp = client.post(
        "/v1/chat/completions",
        json={"model": hr.HERMES_MODEL_ID,
              "messages": [{"role": "user", "content": "hi"}]},
    )
    assert "HERMES_API_KEY" in resp.json()["choices"][0]["message"]["content"]
    assert fake.calls == []


def test_auto_local_turn_uses_normal_path_with_local_model(monkeypatch):
    _store_key()
    fake = _FakeHermesEngine()
    client, server_engine, agent, _, _ = _app(
        monkeypatch, fake, classify=_classifier("local", 0.3)
    )
    from openjarvis.agents._stubs import AgentResult

    agent.run.return_value = AgentResult(content="Canberra", turns=1)

    resp = client.post(
        "/v1/chat/completions",
        json={"model": hr.AUTO_MODEL_ID,
              "messages": [{"role": "user", "content": "local, capital of Australia?"}]},
    )
    body = resp.json()
    assert body["choices"][0]["message"]["content"] == "Canberra"
    assert body["route"] == {"target": "local", "reason": "prefix"}
    assert fake.calls == []
    agent.run.assert_called_once()
    assert "local," not in str(agent.run.call_args)


def test_models_lists_router_entries_first(monkeypatch):
    client, *_ = _app(monkeypatch, _FakeHermesEngine())
    ids = [m["id"] for m in client.get("/v1/models").json()["data"]]
    assert ids[:2] == [hr.AUTO_MODEL_ID, hr.HERMES_MODEL_ID]
    assert "qwen3.5:9b" in ids


def test_usage_endpoint(monkeypatch):
    _store_key()
    hr.get_usage().record_turn()
    client, *_ = _app(monkeypatch, _FakeHermesEngine())
    body = client.get("/v1/hermes/usage").json()
    assert body["count"] == 1
    assert body["cap"] == 100
    assert body["key_configured"] is True


# ---------------------------------------------------------------------------
# HermesEngine: bearer from the store, Hermes SSE events tolerated
# ---------------------------------------------------------------------------


def test_hermes_engine_bearer_and_progress_events():
    from openjarvis.engine.openai_compat_engines import HermesEngine

    _store_key("sk-bearer")
    sse = (
        'data: {"choices":[{"delta":{"content":"Example "}}]}\n\n'
        "event: hermes.tool.progress\n"
        'data: {"tool":"shopify.list_stores","status":"running"}\n\n'
        'data: {"type":"hermes.tool.progress","tool":"x"}\n\n'
        'data: {"choices":[]}\n\n'
        'data: {"choices":[{"delta":{"content":"Outdoor Co"}}]}\n\n'
        "data: [DONE]\n\n"
    )
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, text=sse,
                              headers={"content-type": "text/event-stream"})

    engine = hr.make_hermes_engine(None, hr.hermes_api_key())
    assert isinstance(engine, HermesEngine)
    engine._async_transport = httpx.MockTransport(handler)

    async def collect():
        return [t async for t in engine.stream([], model=hr.HERMES_MODEL_ID)]

    assert "".join(asyncio.run(collect())) == "Example Outdoor Co"
    assert seen["auth"] == "Bearer sk-bearer"
    assert "tools" not in seen["body"]
    engine.close()


def test_hermes_is_never_discovered_or_used_as_engine():
    from openjarvis.core.config import JarvisConfig
    from openjarvis.core.registry import EngineRegistry
    from openjarvis.engine import _discovery
    from openjarvis.engine.openai_compat_engines import HermesEngine

    # The root conftest wipes the registry per test; re-register the real class.
    EngineRegistry.register_value("hermes", HermesEngine)
    assert HermesEngine.passthrough_only is True
    assert _discovery._is_passthrough_only("hermes")
    assert not _discovery._is_passthrough_only("ollama")

    cfg = JarvisConfig()
    assert _discovery.get_engine(cfg, engine_key="hermes") is None
    assert all(key != "hermes" for key, _ in _discovery.discover_engines(cfg))
