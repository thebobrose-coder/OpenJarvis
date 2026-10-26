"""Tests for desks P3 (hq 0020 P3, contract v1.19): the Commerce, Ops and
Compliance desks, the Ops tools, Foundry's pre-check and the paste-and-check
route, and Hermes's multi-message replies.

Invented values only: this repo is public. Ollama, Hermes and the pre-check
CLI are faked; nothing leaves the machine and no live write runs."""

# ruff: noqa: F811 -- the imported `data` fixture is used by name
from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess

import httpx
import pytest

from openjarvis.core import credentials as creds
from openjarvis.server import desk_tools, desks, stack_routes
from openjarvis.server import hermes_router as hr
from tests.server.test_desks import (  # noqa: F401 -- `data` is a fixture
    ScriptedOllama,
    _body,
    _call,
    _client,
    _drain,
    _local,
    _request,
    _text,
    data,
)


@pytest.fixture
def config(tmp_path, monkeypatch):
    """Local config for the P3 tools, pointing into tmp_path."""
    values: dict[tuple[str, str], str] = {}

    def fake(tool, key):
        return values.get((tool, key))

    monkeypatch.setattr(creds, "get_tool_credential", fake)
    monkeypatch.setattr(stack_routes, "get_tool_credential", fake)
    return values


# -- the registry ---------------------------------------------------------------


def test_registry_has_the_three_p3_desks():
    commerce, ops, compliance = (
        desks.DESKS[d] for d in ("commerce", "ops", "compliance")
    )
    assert (commerce.default_route, commerce.hermes) == ("hermes", True)
    assert (ops.default_route, ops.hermes) == ("local", False)
    assert (compliance.default_route, compliance.hermes) == ("local", False)
    assert commerce.pages == ("/commerce", "/commerce#fixes")
    assert ops.pages == ("/stack", "/logs")
    assert compliance.pages == ("/commerce",)
    assert ops.hermes_tools == () and compliance.hermes_tools == ()
    for desk in (commerce, ops, compliance):
        assert set(desk.card_kinds) == {"open", "ruling"}
    assert "trading" not in desks.DESKS
    assert {"bd_due", "bd_templates"} <= set(desks.DESKS["bd"].hermes_tools)


def test_panel_feed_limits_per_desk_and_no_forbidden_feed_anywhere():
    def feeds(desk_id):
        for schema in desk_tools.schemas_for(desks.DESKS[desk_id]):
            fn = schema["function"]
            if fn["name"] == "panel_feed":
                return fn["parameters"]["properties"]["feed"]["enum"]
        return None

    assert feeds("commerce") == [
        "ecom_daily",
        "store_performance",
        "ecom_recommendations",
        "ecom_seo_health",
        "compliance_findings",
    ]
    assert feeds("compliance") == ["compliance_findings"]
    assert feeds("ops") is None
    for desk in desks.DESKS.values():
        names = set(desk.panel_feeds) | set(desk.local_tools) | set(desk.hermes_tools)
        assert not names & set(desk_tools.FORBIDDEN_FEEDS)
        assert not any(n.startswith("trading") for n in names)
        assert "catalog_fixes" not in names


def test_panel_feed_refuses_a_feed_outside_the_desk(data):
    panel_feed = desk_tools.tools_for(desks.DESKS["compliance"])["panel_feed"]
    for feed in ("ecom_daily", "catalog_fixes", "trading_status"):
        assert "feed must be one of" in asyncio.run(panel_feed(feed))


def test_the_local_tools_per_desk():
    tools = {d: set(desk_tools.tools_for(desks.DESKS[d])) for d in desks.DESKS}
    assert tools["ops"] == {"stack_health", "health_events", "briefs", "runbook"}
    assert tools["compliance"] == {"precheck", "brand_context", "panel_feed"}
    assert tools["commerce"] == {"panel_feed"}


# -- local only -----------------------------------------------------------------


@pytest.mark.parametrize("desk_id", ["ops", "compliance"])
def test_a_forced_hermes_turn_on_a_local_only_desk_is_refused(
    data, monkeypatch, desk_id
):
    monkeypatch.setattr(hr, "hermes_api_key", lambda: "sample-key")

    def boom(request):  # pragma: no cover - must not be called
        raise AssertionError("a model was called")

    events = asyncio.run(
        _drain(
            asyncio.run(
                hr.route_desk(
                    _body(desk_id, "Hermes, what's red?"),
                    _request(),
                    local_transport=httpx.MockTransport(boom),
                    hermes_transport=httpx.MockTransport(boom),
                )
            )
        )
    )
    route = events[0][1]
    assert (route["target"], route["reason"]) == ("local", "local_only")
    assert "local only" in _text(events)
    assert hr.get_usage().count_today() == 0


def test_local_only_desks_answer_locally_by_default(data, monkeypatch):
    monkeypatch.setattr(hr, "hermes_api_key", lambda: "sample-key")
    fake = ScriptedOllama({"role": "assistant", "content": "All green."})
    events = _local("ops", fake, "what's red?")
    assert events[0][1]["target"] == "local"
    assert _text(events) == "All green."
    names = {t["function"]["name"] for t in fake.requests[0]["tools"]}
    assert {"stack_health", "health_events", "briefs", "runbook"} <= names
    assert "/stack" in fake.requests[0]["messages"][0]["content"]


# -- the Ops tools --------------------------------------------------------------


def _snapshot(root):
    return {
        str(p): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_the_ops_tools_read_and_never_write(data, config, tmp_path):
    health = data / "health"
    health.mkdir()
    (health / "stack-health.json").write_text(
        json.dumps(
            {
                "ran_at": "2026-01-01T00:00:00Z",
                "results": [
                    {"check": "sample check", "status": "FAIL", "evidence": "down"},
                    {"check": "other check", "status": "WARN", "evidence": "slow"},
                    {"check": "fine", "status": "OK"},
                ],
            }
        )
    )
    (health / "events.json").write_text(json.dumps({"events": []}))
    inbox = data / "inbox" / "sample"
    inbox.mkdir(parents=True)
    (inbox / "2026-01-01-sample.md").write_text(
        "# Sample brief\n\n- [ ] **D1. A box.** Default.\n\n## Result\n"
    )
    books = tmp_path / "runbooks"
    books.mkdir()
    (books / "sample-runbook.md").write_text("# Sample runbook\n\nStep one.\n")
    config[("stack", "STACK_HEALTH_FILE")] = str(health / "stack-health.json")
    config[("stack", "HEALTH_EVENTS_FILE")] = str(health / "events.json")
    config[("desks", "RUNBOOKS_DIR")] = str(books)

    before = _snapshot(tmp_path)
    summary = json.loads(desk_tools.stack_health())
    assert summary["counts"]["FAIL"] == 1 and summary["counts"]["WARN"] == 1
    assert "sample check" in json.dumps(summary["failing"])
    assert json.loads(desk_tools.health_events()) == {"events": []}
    listing = json.loads(desk_tools.briefs())
    assert listing["open"][0]["file"] == "sample/2026-01-01-sample.md"
    assert listing["open"][0]["box"] == "D1"
    assert "hash" not in listing["open"][0]  # compact: no hashes or paragraphs
    assert listing["waiting_briefs"][0]["file"] == "sample/2026-01-01-sample.md"
    assert json.loads(desk_tools.runbook()) == {
        "runbooks": [{"name": "sample-runbook", "title": "Sample runbook"}]
    }
    assert "Step one." in json.loads(desk_tools.runbook("sample-runbook"))["text"]
    assert _snapshot(tmp_path) == before  # nothing written, nothing added


def test_runbook_refuses_names_outside_the_folder(config, tmp_path):
    books = tmp_path / "runbooks"
    books.mkdir()
    (books / "a.md").write_text("# A\n")
    (tmp_path / "secret.md").write_text("not a runbook")
    config[("desks", "RUNBOOKS_DIR")] = str(books)
    for name in ("../secret", "..\\secret", "secret", "a/../../secret"):
        assert "No runbook" in desk_tools.runbook(name)


def test_the_ops_tools_say_when_nothing_is_configured(data, config):
    assert "error" in json.loads(desk_tools.stack_health())
    assert "error" in json.loads(desk_tools.health_events())
    assert "error" in json.loads(desk_tools.runbook())


# -- the pre-check --------------------------------------------------------------


class FakePopen:
    """Stands in for subprocess.Popen: records the call, answers as scripted."""

    calls: list[dict] = []
    answer: tuple[int, str] = (0, "")
    hang = False

    def __init__(self, argv, **kwargs):
        FakePopen.calls.append({"argv": argv, **kwargs})
        self.pid = 4242
        self.returncode = None
        self._timed_out = False

    def communicate(self, data=None, timeout=None):
        if data is not None:
            FakePopen.calls[-1]["stdin"] = data
        if FakePopen.hang and not self._timed_out:
            self._timed_out = True
            raise subprocess.TimeoutExpired("precheck", timeout)
        self.returncode = FakePopen.answer[0]
        return FakePopen.answer[1].encode(), b""

    def kill(self):
        FakePopen.calls[-1]["killed"] = True


@pytest.fixture
def cli(config, tmp_path, monkeypatch):
    repo = tmp_path / "foundry"
    repo.mkdir()
    config[("desks", "PRECHECK_DIR")] = str(repo)
    config[("desks", "PRECHECK_NODE")] = "node-sample"
    FakePopen.calls, FakePopen.answer, FakePopen.hang = [], (0, ""), False
    monkeypatch.setattr(subprocess, "Popen", FakePopen)
    monkeypatch.setattr(desk_tools, "_kill_tree", lambda proc: proc.kill())
    return repo


def _hits(*hits):
    return json.dumps(
        {
            "propertyId": "sample-prop",
            "ok": not hits,
            "judged": False,
            "hits": list(hits),
            "bundle": {"generatedAt": "2026-01-01T00:00:00Z"},
        }
    )


HIT = {
    "kind": "banned-word",
    "rule": "kernel/brand.json bannedWords",
    "sentence": "A sample-bad-word here.",
    "match": "sample-bad-word",
}


def test_precheck_runs_an_argv_list_with_the_text_on_stdin(cli):
    FakePopen.answer = (0, _hits(HIT))
    text = 'A sample-bad-word here. "; rm -rf / & del *'
    out = asyncio.run(desk_tools.run_precheck("sample-prop", text))
    call = FakePopen.calls[0]
    assert call["shell"] is False
    assert isinstance(call["argv"], list)
    assert call["argv"][0] == "node-sample"
    assert call["argv"][2:] == ["studio/precheck.ts", "--property", "sample-prop"]
    assert call["cwd"] == str(cli)
    assert call["stdin"] == text.encode("utf-8")
    assert all(text not in a for a in call["argv"])  # the text is never an argument
    assert out["ok"] is False and out["hits"] == [HIT]


def test_precheck_judge_adds_the_flag(cli):
    FakePopen.answer = (0, _hits())
    out = asyncio.run(desk_tools.run_precheck("sample-prop", "Clean text.", judge=True))
    assert FakePopen.calls[0]["argv"][-1] == "--judge"
    assert out["ok"] is True and out["hits"] == []


def test_precheck_timeout_is_unavailable_and_kills_the_process(cli):
    FakePopen.hang = True
    out = asyncio.run(desk_tools.run_precheck("sample-prop", "Some text."))
    assert out["ok"] is False and out["unavailable"] is True
    assert desk_tools.UNAVAILABLE in out["error"]
    assert FakePopen.calls[0].get("killed") is True


@pytest.mark.parametrize("code", [1, 3, 137])
def test_a_non_zero_exit_is_never_a_pass(cli, code):
    FakePopen.answer = (code, _hits())  # even a stdout that claims ok
    out = asyncio.run(desk_tools.run_precheck("sample-prop", "Some text."))
    assert out["ok"] is False and out["unavailable"] is True


def test_exit_2_shows_the_cli_error(cli):
    FakePopen.answer = (2, json.dumps({"error": 'unknown property "nope"'}))
    out = asyncio.run(desk_tools.run_precheck("nope", "Some text."))
    assert out == {
        "propertyId": "nope",
        "ok": False,
        "error": 'unknown property "nope"',
        "hits": [],
    }


def test_a_non_zero_exit_with_an_error_says_why_and_is_not_a_pass(cli):
    FakePopen.answer = (1, json.dumps({"error": "ENOENT: no brand file"}))
    out = asyncio.run(desk_tools.run_precheck("sample-prop", "Some text."))
    assert out["ok"] is False and out["unavailable"] is True
    assert out["error"].endswith("exit 1: ENOENT: no brand file")


def test_garbage_or_a_hit_with_ok_true_is_not_a_pass(cli):
    FakePopen.answer = (0, "not json")
    assert asyncio.run(desk_tools.run_precheck("sample-prop", "x"))["ok"] is False
    FakePopen.answer = (0, json.dumps({"ok": True, "hits": [HIT]}))
    assert asyncio.run(desk_tools.run_precheck("sample-prop", "x"))["ok"] is False


def test_precheck_input_is_checked_before_anything_runs(cli):
    for pid, text in (
        ("", "x"),
        ("bad id!", "x"),
        ("sample-prop", "  "),
        ("sample-prop", "x" * 20001),
    ):
        out = asyncio.run(desk_tools.run_precheck(pid, text))
        assert out["ok"] is False and out["error"] and out["hits"] == []
    assert FakePopen.calls == []


def test_precheck_unconfigured_is_unavailable(config):
    out = asyncio.run(desk_tools.run_precheck("sample-prop", "Some text."))
    assert out["unavailable"] is True and out["ok"] is False


def test_the_widget_and_the_desk_share_one_implementation(data, monkeypatch):
    seen = []

    async def spy(property_id, text, judge=False):
        seen.append((property_id, text, judge))
        return {"propertyId": property_id, "ok": False, "hits": [HIT]}

    monkeypatch.setattr(desk_tools, "run_precheck", spy)
    resp = _client().post(
        "/api/desks/compliance/precheck",
        json={"propertyId": "sample-prop", "text": "From the widget.", "judge": True},
    )
    assert resp.status_code == 200 and resp.json()["hits"] == [HIT]

    fake = ScriptedOllama(
        _call("precheck", {"propertyId": "sample-prop", "text": "From the desk."}),
        {"role": "assistant", "content": "One hit: banned word."},
    )
    events = _local("compliance", fake, "check this")
    assert seen == [
        ("sample-prop", "From the widget.", True),
        ("sample-prop", "From the desk.", False),
    ]
    end = next(d for e, d in events if e == "tool_call_end")
    assert end["tool"] == "precheck" and "banned-word" in end["result"]


def test_the_precheck_routes_are_loopback_only(data):
    remote = _client("10.0.0.9")
    assert remote.get("/api/desks/compliance/properties").status_code == 403
    assert (
        remote.post(
            "/api/desks/compliance/precheck", json={"propertyId": "a", "text": "b"}
        ).status_code
        == 403
    )
    assert _client().get("/api/desks/compliance/properties").json() == {
        "properties": ["sample-prop"]
    }


# -- Hermes: several assistant messages in one turn ------------------------------


class MultiMessageHermes:
    def __call__(self, request: httpx.Request) -> httpx.Response:
        def chunk(text):
            delta = {"choices": [{"index": 0, "delta": {"content": text}}]}
            return f"data: {json.dumps(delta)}\n\n"

        target = {"page": "/bizdev", "focus": "7"}
        card = (
            "```card\n"
            + json.dumps({"kind": "open", "label": "Open it", "target": target})
            + "\n```"
        )
        body = (
            chunk("Two are due.")
            + "event: hermes.tool.progress\n"
            + 'data: {"tool": "bd_due", "label": "reading"}\n\n'
            + chunk(card)
            + "data: [DONE]\n\n"
        )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.parametrize("stream", [True, False])
def test_every_message_of_a_multi_message_reply_is_shown(data, monkeypatch, stream):
    monkeypatch.setattr(hr, "hermes_api_key", lambda: "sample-key")
    response = asyncio.run(
        hr.route_desk(
            _body("bd", "who is due?", stream=stream),
            _request(),
            hermes_transport=httpx.MockTransport(MultiMessageHermes()),
        )
    )
    if stream:
        text = _text(asyncio.run(_drain(response)))
    else:
        text = response["choices"][0]["message"]["content"]
    assert text.startswith("Two are due.\n\n```card\n")
    assert '"focus": "7"' in text


# -- compact commerce feeds -----------------------------------------------------


def _big_feeds(monkeypatch):
    recs = [
        {
            "id": f"{i:012x}",
            "store": "store-a" if i % 2 else "store-b",
            "category": "content",
            "priority": 1 + i % 3,
            "title": f"Sample rec {i}",
            "created_at": "2026-01-01T00:00:00Z",
            "detail": {"action": "Do a sample thing. " * 40, "rationale": "x" * 900},
        }
        for i in range(120)
    ]
    findings = [
        {"id": f"f{i:07d}", "property": "prop-a" if i < 70 else "prop-b",
         "kind": "rule", "quote": "q" * 500, "rule": "Sample rule"}
        for i in range(100)
    ]  # fmt: skip
    stores = [
        {"slug": s, "display_name": s.upper(), "pages": [{"url": "p" * 80}] * 400}
        for s in ("store-a", "store-b", "store-c")
    ]
    docs = {
        "ecom_recommendations": {"counts": {"open": 120}, "open": recs},
        "compliance_findings": {"counts": {"open": 100}, "open_findings": findings},
        "ecom_seo_health": {"stores": stores},
    }

    async def fake(feed):
        return json.loads(json.dumps(docs[feed]))

    monkeypatch.setattr(desk_tools, "_feed", fake)


def test_commerce_feeds_come_compact_and_whole(monkeypatch):
    _big_feeds(monkeypatch)
    pf = desk_tools.tools_for(desks.DESKS["commerce"])["panel_feed"]
    for feed in ("ecom_recommendations", "compliance_findings", "ecom_seo_health"):
        out = asyncio.run(pf(feed))
        assert len(out) <= desk_tools.RESULT_MAX
        doc = json.loads(out)  # valid JSON, never a cut string
        assert isinstance(doc, dict)
    seo = json.loads(asyncio.run(pf("ecom_seo_health")))
    assert [s["slug"] for s in seo["stores"]] == ["store-a", "store-b", "store-c"]
    recs = json.loads(asyncio.run(pf("ecom_recommendations")))
    assert recs["open_total"] == 120
    assert all("rationale" not in r for r in recs["open"])
    assert [r["priority"] for r in recs["open"]] == sorted(
        r["priority"] for r in recs["open"]
    )


def test_commerce_feeds_filter_and_one_item_in_full(monkeypatch):
    _big_feeds(monkeypatch)
    pf = desk_tools.tools_for(desks.DESKS["commerce"])["panel_feed"]
    only_a = json.loads(asyncio.run(pf("ecom_recommendations", filter="store-a")))
    assert only_a["open_total"] == 60
    assert {r["store"] for r in only_a["open"]} == {"store-a"}
    one = json.loads(asyncio.run(pf("ecom_recommendations", id=f"{7:012x}")))
    assert one["recommendation"]["detail"]["rationale"] == "x" * 900
    assert (
        "No recommendation"
        in json.loads(asyncio.run(pf("ecom_recommendations", id="nope")))["error"]
    )
    comp = desk_tools.tools_for(desks.DESKS["compliance"])["panel_feed"]
    b = json.loads(asyncio.run(comp("compliance_findings", filter="prop-b")))
    assert b["open_findings_total"] == 30
    assert {f["property"] for f in b["open_findings"]} == {"prop-b"}
    full = json.loads(asyncio.run(comp("compliance_findings", id="f0000003")))
    assert full["finding"]["quote"] == "q" * 500


def test_the_filter_arguments_are_offered_only_on_commerce_feeds():
    def props(desk_id):
        for s in desk_tools.schemas_for(desks.DESKS[desk_id]):
            if s["function"]["name"] == "panel_feed":
                return set(s["function"]["parameters"]["properties"])

    assert props("commerce") == {"feed", "filter", "id"}
    assert props("compliance") == {"feed", "filter", "id"}
    assert props("content") == {"feed"} and props("bd") == {"feed"}


def test_fit_trims_nested_lists_first_and_says_so():
    doc = {
        "stores": [
            {"slug": f"s{i}", "pages": [{"url": "p" * 100} for _ in range(60)]}
            for i in range(3)
        ]
    }
    out = desk_tools._fit(doc)
    assert len(json.dumps(out)) <= desk_tools.RESULT_MAX
    assert [s["slug"] for s in out["stores"]] == ["s0", "s1", "s2"]  # every store kept
    assert all(len(s["pages"]) < 60 for s in out["stores"])
    assert out["_trimmed"].startswith("Shortened to fit: stores.")
    small = {"a": [1, 2, 3]}
    assert desk_tools._fit(small) == {"a": [1, 2, 3]}  # nothing to do, no note
