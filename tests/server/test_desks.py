"""Tests for the desks (hq 0020 P2): the router's desk id, the local and Hermes
desk routes, the loopback tools, the souls and the rulings export.

Invented values only: this repo is public. Ollama and Hermes are mocked with
httpx's MockTransport; nothing leaves the machine and no live write runs."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx
from fastapi import HTTPException

from openjarvis.server import desk_chat, desk_tools, desks, studio_routes
from openjarvis.server import hermes_router as hr
from openjarvis.server.models import ChatCompletionRequest

BUNDLE = {
    "schemaVersion": 1,
    "companies": [{"id": "co", "token": "sample-secret-token"}],
    "properties": [
        {
            "id": "sample-prop",
            "studio": {"channelName": "sample channel"},
            "kernelContent": {
                "brand": {"name": "Sample Brand"},
                "voice": {"tone": "dry"},
                "negatives": "Never say sample-bad-word.",
                "hooks": ["hook one"],
            },
            "compliance": {
                "rules": "the whole rules text",
                "sections": [
                    {"id": "1", "heading": "Rule one", "text": "Rule one text."},
                    {"id": "2", "heading": "Rule two", "text": "Rule two, verbatim."},
                ],
            },
        }
    ],
}


@pytest.fixture
def data(tmp_path, monkeypatch):
    root = tmp_path / "_data"
    (root / "foundry").mkdir(parents=True)
    (root / "foundry" / "foundry-bundle.json").write_text(json.dumps(BUNDLE))
    for mod in (desks, desk_tools, studio_routes):
        monkeypatch.setattr(mod, "_data_dir", lambda: root)
    monkeypatch.setattr(desks, "_store", desks.RulingsStore(tmp_path / "memory.db"))
    monkeypatch.setattr(hr, "_usage", hr.HermesUsage(tmp_path / "usage.json"))
    monkeypatch.setattr(desk_chat, "lease_holder", lambda now=None: None)
    return root


def _client(host: str = "127.0.0.1"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(desks.desks_router)
    return TestClient(app, client=(host, 50000))


def _request(model: str = "qwen-test"):
    state = SimpleNamespace(config=None, model=model)
    return SimpleNamespace(app=SimpleNamespace(state=state))


def _body(desk: str, *texts: str, session: str | None = None, stream: bool = True):
    msgs = []
    for i, t in enumerate(texts):
        msgs.append({"role": "user" if i % 2 == 0 else "assistant", "content": t})
    return ChatCompletionRequest(
        model="auto", messages=msgs, stream=stream, desk=desk, desk_session=session
    )


async def _drain(response) -> list[tuple[str | None, object]]:
    """The SSE events of a StreamingResponse, as (event, data)."""
    out = []
    raw = ""
    async for part in response.body_iterator:
        raw += part if isinstance(part, str) else part.decode()
    for block in raw.split("\n\n"):
        if not block.strip():
            continue
        event = None
        data = None
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        out.append((event, data if data == "[DONE]" else json.loads(data)))
    return out


def _text(events) -> str:
    return "".join(
        d["choices"][0]["delta"].get("content", "")
        for e, d in events
        if e is None and isinstance(d, dict) and d.get("choices")
    )


# -- the registry ---------------------------------------------------------------


def test_registry_defaults():
    assert desks.DESKS["content"].default_route == "local"
    assert desks.DESKS["bd"].default_route == "hermes"
    assert desks.DESKS["content"].pages == ("/content",)
    assert desks.DESKS["bd"].pages == ("/bizdev",)
    assert set(desks.DESKS["bd"].card_kinds) == {"open", "ruling"}
    for desk in desks.DESKS.values():
        assert not set(desk.panel_feeds) & set(desk_tools.FORBIDDEN_FEEDS)
        assert not any(f.startswith("trading") for f in desk.panel_feeds)


# -- the route decision ---------------------------------------------------------


def _decide(text, default, *, count=0, cap=100, key=True, tmp_path=None):
    usage = hr.HermesUsage(tmp_path / "u.json")
    for _ in range(count):
        usage.record_turn()
    return hr.decide_desk_route(
        text, default_route=default, usage=usage, cap=cap, key_available=key
    )


def test_default_route_per_desk(tmp_path):
    d, text = _decide("who is due?", "hermes", tmp_path=tmp_path)
    assert (d.target, d.reason, text) == ("hermes", "desk_default", "who is due?")
    d, _ = _decide("quote rule 2", "local", tmp_path=tmp_path)
    assert (d.target, d.reason) == ("local", "desk_default")


def test_prefixes_override_the_default(tmp_path):
    d, text = _decide("Hermes, quote rule 2", "local", tmp_path=tmp_path)
    assert (d.target, d.reason, text) == ("hermes", "prefix", "quote rule 2")
    d, text = _decide("local, who is due?", "hermes", tmp_path=tmp_path)
    assert (d.target, d.reason, text) == ("local", "prefix", "who is due?")


def test_cap_and_no_key_fall_back_locally_but_a_prefix_still_wins(tmp_path):
    d, _ = _decide("who is due?", "hermes", count=2, cap=2, tmp_path=tmp_path)
    assert (d.target, d.reason) == ("local", "cap") and "cap reached" in d.notice
    d, _ = _decide("Hermes, who is due?", "hermes", count=2, cap=2, tmp_path=tmp_path)
    assert d.target == "hermes"
    d, _ = _decide("who is due?", "hermes", key=False, tmp_path=tmp_path)
    assert (d.target, d.reason) == ("local", "no_key")


# -- the local route ------------------------------------------------------------


class FakeOllama:
    """Answers /api/chat: first a brand_context call, then the reply."""

    def __init__(self, calls=None):
        self.requests: list[dict] = []
        self.calls = (
            calls
            if calls is not None
            else [
                {
                    "function": {
                        "name": "brand_context",
                        "arguments": {"propertyId": "sample-prop", "sections": ["2"]},
                    }
                }
            ]
        )

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/chat"
        body = json.loads(request.content)
        self.requests.append(body)
        if len(self.requests) == 1 and self.calls:
            msg = {"role": "assistant", "content": "", "tool_calls": self.calls}
        else:
            msg = {"role": "assistant", "content": "Rule 2 says: Rule two, verbatim."}
        return httpx.Response(200, json={"message": msg})


def test_local_desk_turn_gets_soul_rulings_and_only_its_tools(data, monkeypatch):
    desks.seed_soul("content", "You advise on sample content.")
    desks.add_ruling("content", "Prefer short hooks.")
    fake = FakeOllama()
    monkeypatch.setattr(hr, "hermes_api_key", lambda: "sample-key")
    response = asyncio.run(
        hr.route_desk(
            _body("content", "Quote rule 2"),
            _request(),
            local_transport=httpx.MockTransport(fake),
        )
    )
    events = asyncio.run(_drain(response))
    route = events[0]
    assert route[0] == "route" and route[1]["target"] == "local"
    assert route[1]["desk"] == "content"

    first = fake.requests[0]
    assert first["model"] == "qwen-test"
    system = first["messages"][0]
    assert system["role"] == "system"
    assert "You advise on sample content." in system["content"]
    assert "Prefer short hooks." in system["content"]
    assert "```" not in system["content"] or "card" in system["content"]
    names = {t["function"]["name"] for t in first["tools"]}
    # The desk's loopback tools, plus its card kinds (a call only adds a card).
    assert names == {"brand_context", "episode", "studio_status", "panel_feed"} | {
        "open",
        "tick",
        "proposal_decision",
        "ruling",
    }
    for forbidden in (
        "shell_exec",
        "file_read",
        "file_write",
        "memory_manage",
        "code_interpreter",
    ):
        assert forbidden not in names

    # The tool ran, its result went back to the model, and the trace shows it.
    kinds = [e for e, _ in events]
    assert "tool_call_start" in kinds and "tool_call_end" in kinds
    tool_msg = fake.requests[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and "Rule two, verbatim." in tool_msg["content"]
    assert "Rule two, verbatim." in _text(events)
    assert events[-1] == (None, "[DONE]")
    assert hr.get_usage().count_today() == 0  # local turns aren't Hermes turns


def test_bd_local_turn_has_only_panel_feed_over_bd_feeds(data):
    fake = FakeOllama(calls=[])
    asyncio.run(
        _drain(
            asyncio.run(
                hr.route_desk(
                    _body("bd", "local, who is due?"),
                    _request(),
                    local_transport=httpx.MockTransport(fake),
                )
            )
        )
    )
    tools = fake.requests[0]["tools"]
    assert [t["function"]["name"] for t in tools] == ["panel_feed", "open", "ruling"]
    enum = tools[0]["function"]["parameters"]["properties"]["feed"]["enum"]
    assert enum == ["bd_pipeline", "bd_stats"]
    # The prefix is stripped before the model sees the turn.
    assert fake.requests[0]["messages"][-1]["content"] == "who is due?"


def test_a_tool_outside_the_desk_is_refused(data):
    fake = FakeOllama(calls=[{"function": {"name": "shell_exec", "arguments": {}}}])
    events = asyncio.run(
        _drain(
            asyncio.run(
                hr.route_desk(
                    _body("bd", "local, run ls"),
                    _request(),
                    local_transport=httpx.MockTransport(fake),
                )
            )
        )
    )
    end = next(d for e, d in events if e == "tool_call_end")
    assert end["success"] is False and "isn't a tool on this desk" in end["result"]


class ScriptedOllama:
    """Answers /api/chat from a list of messages, the last one repeating."""

    def __init__(self, *messages):
        self.messages = list(messages)
        self.requests: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        i = min(len(self.requests) - 1, len(self.messages) - 1)
        return httpx.Response(200, json={"message": self.messages[i]})


def _call(name, arguments):
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"function": {"name": name, "arguments": arguments}}],
    }


def _local(desk, fake, text="hi"):
    return asyncio.run(
        _drain(
            asyncio.run(
                hr.route_desk(
                    _body(desk, text),
                    _request(),
                    local_transport=httpx.MockTransport(fake),
                )
            )
        )
    )


def test_a_repeated_tool_call_is_not_rerun_and_the_turn_still_answers(data):
    same = _call("panel_feed", {"feed": "content_proposals"})
    fake = ScriptedOllama(same, same, {"role": "assistant", "content": "Two waiting."})
    events = _local("content", fake)
    assert [e for e, _ in events].count("tool_call_end") == 1
    # After the repeat, tools are withdrawn so the model has to answer.
    assert "tools" not in fake.requests[2]
    assert _text(events) == "Two waiting."


def test_an_empty_final_reply_gets_one_nudge_then_a_plain_notice(data):
    same = _call("panel_feed", {"feed": "content_proposals"})
    empty = {"role": "assistant", "content": ""}
    fake = ScriptedOllama(same, same, empty)
    events = _local("content", fake)
    nudge = fake.requests[-1]["messages"][-1]
    assert nudge["role"] == "user" and "Answer the operator now" in nudge["content"]
    assert "tools" not in fake.requests[-1]
    assert _text(events) == desk_chat.NO_TEXT


def test_a_card_kind_called_as_a_tool_becomes_a_card_block(data):
    body = json.dumps({"text": "Quote the rule number with the rule."})
    fake = ScriptedOllama(
        _call("ruling", {"label": "Quote numbers", "body": body}),
        {"role": "assistant", "content": "The ruling card is there to click."},
    )
    events = _local("content", fake, "make that a ruling")
    text = _text(events)
    assert text.startswith("The ruling card is there to click.")
    block = text.split("```card\n", 1)[1].split("\n```", 1)[0]
    assert json.loads(block) == {
        "kind": "ruling",
        "body": {"text": "Quote the rule number with the rule."},
        "label": "Quote numbers",
    }
    # Nothing was recorded: proposing a card writes no ruling.
    assert desks.rulings_store().list("content") == []
    assert "tool_call_end" not in [e for e, _ in events]


def test_a_card_kind_outside_the_desk_is_refused_as_a_tool(data):
    fake = ScriptedOllama(
        _call("tick", {"label": "x", "target": {"file": "a/b.md", "box": "D1"}}),
        {"role": "assistant", "content": "ok"},
    )
    events = _local("bd", fake, "local, tick it")
    end = next(d for e, d in events if e == "tool_call_end")
    assert end["success"] is False
    assert "```card" not in _text(events)


def test_a_held_gpu_lease_answers_without_calling_ollama(data, monkeypatch):
    monkeypatch.setattr(desk_chat, "lease_holder", lambda now=None: "openjarvis-voice")
    monkeypatch.setattr(desk_chat, "LEASE_WAIT_S", 0)

    def boom(request):  # pragma: no cover - must not be called
        raise AssertionError("Ollama was called under a held lease")

    events = asyncio.run(
        _drain(
            asyncio.run(
                hr.route_desk(
                    _body("content", "hi"),
                    _request(),
                    local_transport=httpx.MockTransport(boom),
                )
            )
        )
    )
    assert "GPU is lent out" in _text(events)


def test_lease_freshness(tmp_path, monkeypatch):
    from openjarvis.voice_worker import paths

    lease = tmp_path / "lease.json"
    monkeypatch.setattr(paths, "lease_path", lambda: lease)
    now = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)

    def write(acquired, expires):
        lease.write_text(
            json.dumps(
                {
                    "holder": "openjarvis-voice",
                    "acquired_at": acquired.isoformat(),
                    "expires_at": expires.isoformat(),
                }
            )
        )

    assert desk_chat.lease_holder(now) is None
    write(now - timedelta(minutes=2), now + timedelta(minutes=5))
    assert desk_chat.lease_holder(now) == "openjarvis-voice"
    write(now - timedelta(minutes=2), now - timedelta(seconds=1))
    assert desk_chat.lease_holder(now) is None
    write(now - timedelta(minutes=16), now + timedelta(minutes=5))
    assert desk_chat.lease_holder(now) is None


# -- the Hermes route -----------------------------------------------------------


class FakeHermes:
    def __init__(self, status: int = 200):
        self.status = status
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "nope"})
        delta = {"choices": [{"index": 0, "delta": {"content": "Two are due."}}]}
        body = (
            'event: hermes.tool.progress\ndata: {"tool": "bd_prospects", '
            '"label": "reading the pipeline"}\n\n'
            f"data: {json.dumps(delta)}\n\n"
            "data: [DONE]\n\n"
        )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


def _hermes_turn(data, monkeypatch, fake, *texts, desk="bd", session=None):
    monkeypatch.setattr(hr, "hermes_api_key", lambda: "sample-key")
    response = asyncio.run(
        hr.route_desk(
            _body(desk, *texts, session=session),
            _request(),
            hermes_transport=httpx.MockTransport(fake),
        )
    )
    return asyncio.run(_drain(response))


def test_hermes_desk_turn_goes_to_the_profile_with_no_system_message(data, monkeypatch):
    fake = FakeHermes()
    session = "11111111-2222-3333-4444-555555555555"
    events = _hermes_turn(data, monkeypatch, fake, "who is due?", session=session)
    req = fake.requests[0]
    assert req.url.path == "/p/desk-bd/v1/chat/completions"
    assert req.headers["X-Hermes-Session-Id"] == session
    assert req.headers["Authorization"] == "Bearer sample-key"
    body = json.loads(req.content)
    assert [m["role"] for m in body["messages"]] == ["user"]
    assert all(m["role"] != "system" for m in body["messages"])
    assert "tools" not in body
    assert events[0][1]["target"] == "hermes"
    assert "Two are due." in _text(events)
    start = next(d for e, d in events if e == "tool_call_start")
    assert start["tool"] == "bd_prospects"
    assert hr.get_usage().count_today() == 1  # desk turns count under the cap


def test_one_session_id_per_thread(data, monkeypatch):
    fake = FakeHermes()
    session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    _hermes_turn(data, monkeypatch, fake, "who is due?", session=session)
    _hermes_turn(
        data, monkeypatch, fake, "who is due?", "Two.", "and tomorrow?", session=session
    )
    assert {r.headers["X-Hermes-Session-Id"] for r in fake.requests} == {session}
    second = json.loads(fake.requests[1].content)["messages"]
    assert [m["role"] for m in second] == ["user", "assistant", "user"]


def test_a_forced_hermes_turn_on_an_unserved_desk_says_so(data, monkeypatch):
    events = _hermes_turn(
        data, monkeypatch, FakeHermes(404), "Hermes, quote rule 2", desk="content"
    )
    assert "Desk not served yet: run sync-config.sh" in _text(events)


def test_unknown_desk_is_refused(data):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(hr.route_desk(_body("trading", "hi"), _request()))
    assert exc.value.status_code == 400


# -- the loopback tools ---------------------------------------------------------


def test_brand_context_returns_only_kernel_and_compliance(data):
    index = json.loads(desk_tools.brand_context("sample-prop"))
    assert index["kernel"]["brand"] == {"name": "Sample Brand"}
    assert [s["id"] for s in index["complianceSections"]] == ["1", "2"]
    out = desk_tools.brand_context("sample-prop", ["2", "negatives", "nope"])
    doc = json.loads(out)
    assert doc["compliance"] == [
        {"id": "2", "heading": "Rule two", "text": "Rule two, verbatim."}
    ]
    assert doc["kernel"]["negatives"] == "Never say sample-bad-word."
    assert doc["unknown"] == ["nope"]
    for text in (out, json.dumps(index)):
        assert "sample-secret-token" not in text and "sample channel" not in text
    assert "error" in json.loads(desk_tools.brand_context("other-prop"))


def test_episode_and_status_say_no_studio_yet(data):
    assert json.loads(desk_tools.studio_status()) == {"error": "No studio yet"}
    assert json.loads(desk_tools.episode("01ABCDEF")) == {"error": "No studio yet"}


def test_panel_feed_refuses_feeds_outside_the_desk(data, monkeypatch):
    seen = []

    async def fake_feed(feed):
        seen.append(feed)
        return {"items": [1]}

    monkeypatch.setattr(desk_tools, "_feed", fake_feed)
    bd = desk_tools.tools_for(desks.DESKS["bd"])["panel_feed"]
    for feed in ("content_proposals", "trading_status", "catalog_fixes"):
        assert "error" in json.loads(asyncio.run(bd(feed)))
    assert json.loads(asyncio.run(bd("bd_stats"))) == {"items": [1]}
    assert seen == ["bd_stats"]


# -- souls ----------------------------------------------------------------------


def test_seed_runs_only_if_absent(data):
    assert desks.seed_soul("content", "first seed") is True
    assert desks.seed_soul("content", "second seed") is False
    assert (data / "desks" / "content" / "soul.md").read_text() == "first seed"


def test_soul_edit_checks_hash_cap_and_writes_atomically(data):
    client = _client()
    desks.seed_soul("bd", "seed text")
    soul = client.get("/api/desks/bd/soul").json()
    assert soul["exists"] and soul["chars"] == 9 and soul["max"] == 8000

    stale = client.put("/api/desks/bd/soul", json={"text": "x", "hash": "0" * 64})
    assert stale.status_code == 409
    big = client.put(
        "/api/desks/bd/soul", json={"text": "x" * 8001, "hash": soul["hash"]}
    )
    assert big.status_code == 400
    ok = client.put(
        "/api/desks/bd/soul", json={"text": "new soul", "hash": soul["hash"]}
    )
    assert ok.status_code == 200 and ok.json()["text"] == "new soul"
    assert (data / "desks" / "bd" / "soul.md").read_text() == "new soul"
    assert not list((data / "desks" / "bd").glob(".*.tmp"))
    # The old hash no longer matches.
    again = client.put("/api/desks/bd/soul", json={"text": "y", "hash": soul["hash"]})
    assert again.status_code == 409


def test_soul_edits_stay_inside_the_desks_folder(data):
    client = _client()
    assert client.get("/api/desks/..%2Finbox/soul").status_code == 404
    assert client.put("/api/desks/trading/soul", json={"text": "x"}).status_code == 404
    created = client.put(
        "/api/desks/content/soul", json={"text": "fresh", "hash": None}
    )
    assert created.status_code == 200
    files = sorted(
        p.relative_to(data).as_posix() for p in data.rglob("*") if p.is_file()
    )
    assert files == ["desks/content/soul.md", "foundry/foundry-bundle.json"]


def test_writes_are_loopback_only(data):
    remote = _client("10.0.0.5")
    assert remote.get("/api/desks").status_code == 403
    assert remote.post("/api/desks/bd/rulings", json={"text": "x"}).status_code == 403
    assert remote.put("/api/desks/bd/soul", json={"text": "x"}).status_code == 403


# -- rulings --------------------------------------------------------------------


def test_rulings_add_edit_delete_export(data):
    client = _client()
    export = data / "desks" / "content" / "rulings.md"
    a = client.post("/api/desks/content/rulings", json={"text": "First  ruling\nhere"})
    assert a.status_code == 201 and a.json()["text"] == "First ruling here"
    b = client.post(
        "/api/desks/content/rulings",
        json={"text": "Second ruling", "thread": "thread-1"},
    )
    text = export.read_text()
    assert text.index("Second ruling") < text.index("First ruling here")  # newest first

    rid = a.json()["id"]
    assert (
        client.put(
            f"/api/desks/content/rulings/{rid}", json={"text": "First, edited"}
        ).status_code
        == 200
    )
    assert "First, edited" in export.read_text()
    assert (
        client.delete(f"/api/desks/content/rulings/{b.json()['id']}").status_code == 200
    )
    assert "Second ruling" not in export.read_text()
    rows = client.get("/api/desks/content/rulings").json()["rulings"]
    assert [r["text"] for r in rows] == ["First, edited"]
    assert client.delete("/api/desks/content/rulings/9999").status_code == 404
    assert (
        client.post("/api/desks/content/rulings", json={"text": "x" * 501}).status_code
        == 400
    )
    assert (
        client.post("/api/desks/content/rulings", json={"text": "  "}).status_code
        == 400
    )
    # Rulings are per desk.
    assert client.get("/api/desks/bd/rulings").json()["rulings"] == []
    assert not list(export.parent.glob(".*.tmp"))


def test_export_cap_drops_the_oldest(data):
    store = desks.rulings_store()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for i in range(40):
        store.add("bd", f"ruling {i:02d} " + "x" * 280, None, base + timedelta(hours=i))
    count = desks.export_rulings("bd")
    text = (data / "desks" / "bd" / "rulings.md").read_text(encoding="utf-8")
    assert len(text) <= desks.RULINGS_MAX
    assert 0 < count < 40
    assert "ruling 39" in text and "ruling 00" not in text
    assert text.index("ruling 39") < text.index("ruling 38")
    assert len(store.list("bd")) == 40  # the store keeps them all


def test_desk_list(data):
    desks.seed_soul("content", "seed")
    body = _client().get("/api/desks").json()
    assert body["data_configured"] is True
    rows = {d["id"]: d for d in body["desks"]}
    assert rows["content"]["soul"]["exists"] and not rows["bd"]["soul"]["exists"]
    assert "text" not in rows["content"]["soul"]
    assert rows["bd"]["default_route"] == "hermes" and rows["bd"]["cost_note"]
