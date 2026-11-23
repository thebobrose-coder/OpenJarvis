"""Tests for /api/outreach (the Outreach page, hq 0031 Part C) and the
``outreach`` row on Waiting on you.

Invented fixtures only (brands ``alpha`` and ``beta``, handles like
``sample.maker``): this repo is public. The store is a temp folder, the bridge
and the local model are mocked, and nothing here reaches Instagram: no code
under test can.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx
from fastapi import HTTPException

from openjarvis.server import outreach_routes as orr
from openjarvis.server import waiting_routes as wr

# 2026-03-10 18:00 UTC is 13:00 Central on the 10th.
NOW = datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc)
DAY = "2026-03-10"


@pytest.fixture
def root(tmp_path, monkeypatch):
    folder = tmp_path / "social"
    monkeypatch.setattr(orr, "store_dir", lambda: folder)
    monkeypatch.setattr(orr, "brand_ids", lambda: ["alpha", "beta"])
    monkeypatch.setattr(orr, "_now", lambda: NOW)
    orr._cache.clear()
    return folder


def _client(host: str = "127.0.0.1"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(orr.outreach_router)
    return TestClient(app, client=(host, 50000))


def _seed(root: Path, brand: str, handles: list[str], **fields) -> None:
    """Accounts added a minute apart, oldest first."""
    for i, handle in enumerate(handles):
        orr.add_accounts(root, brand, handle, NOW - timedelta(days=30, minutes=-i))
    if fields:
        for handle in handles:
            orr.edit_account(root, brand, handle, fields, NOW - timedelta(days=30))


# ---------- handles and the paste ----------


@pytest.mark.parametrize(
    "text,handle",
    [
        ("Sample.Maker", "sample.maker"),
        ("@sample_maker", "sample_maker"),
        ("https://www.instagram.com/Sample.Maker/", "sample.maker"),
        ("instagram.com/sample.maker?igsh=abc", "sample.maker"),
        ("http://m.instagram.com/sample.maker", "sample.maker"),
        ("https://www.instagram.com/p/Cabc123/", None),
        ("https://www.instagram.com/reel/Cabc123/", None),
        ("https://example.com/sample.maker", None),
        ("not a handle!", None),
        ("x" * 31, None),
        ("", None),
    ],
)
def test_normalize_handle(text, handle):
    assert orr.normalize_handle(text) == handle


def test_paste_adds_many_and_refuses_duplicates(root):
    c = _client()
    r = c.post(
        "/api/outreach/accounts",
        json={
            "brand": "alpha",
            "text": "@one.maker, https://www.instagram.com/Two_Maker/\n"
            "three.maker one.maker https://www.instagram.com/p/abc/",
        },
    )
    assert r.status_code == 200
    assert r.json() == {
        "added": ["one.maker", "two_maker", "three.maker"],
        "duplicates": [],
        "invalid": ["https://www.instagram.com/p/abc/"],
    }
    again = c.post(
        "/api/outreach/accounts",
        json={"brand": "alpha", "text": "ONE.maker four.maker"},
    ).json()
    assert again["added"] == ["four.maker"] and again["duplicates"] == ["one.maker"]
    # The same handle on the other brand is its own account.
    other = c.post(
        "/api/outreach/accounts", json={"brand": "beta", "text": "one.maker"}
    ).json()
    assert other["added"] == ["one.maker"]


def test_store_keeps_the_shape_hermes_reads(root):
    _seed(root, "alpha", ["one.maker"])
    orr.dismiss_candidate(root, "alpha", "noisy.account")
    doc = json.loads((root / "targets.json").read_text(encoding="utf-8"))
    assert doc["version"] == 1
    assert set(doc["brands"]["alpha"]) == {"accounts", "dismissed"}
    assert doc["brands"]["alpha"]["dismissed"] == ["noisy.account"]
    account = doc["brands"]["alpha"]["accounts"][0]
    assert account["handle"] == "one.maker"
    assert account["profile_url"] == "https://www.instagram.com/one.maker/"
    assert account["tier"] == "peer" and account["source"] == "operator"
    assert account["status"] == "active" and account["collab_state"] == "none"
    assert account["last_engaged_at"] is None
    # No temp file is left beside it.
    assert sorted(p.name for p in root.iterdir()) == ["targets.json"]


def test_edit_account_checks_every_field(root):
    _seed(root, "alpha", ["one.maker"])
    c = _client()
    ok = c.patch(
        "/api/outreach/accounts/alpha/one.maker",
        json={
            "niche": " field kits ",
            "tier": "creator",
            "status": "paused",
            "collab_state": "asked",
            "why": "posts weekly",
            "notes": "met at a show",
        },
    )
    assert ok.status_code == 200
    body = ok.json()
    assert body["niche"] == "field kits" and body["tier"] == "creator"
    assert body["status"] == "paused" and body["collab_state"] == "asked"
    for bad in (
        {"tier": "huge"},
        {"status": "gone"},
        {"collab_state": "maybe"},
        {"handle": "other"},
        {"last_engaged_at": "2026-01-01T00:00:00Z"},
        {"niche": "x" * 81},
        {},
    ):
        assert (
            c.patch("/api/outreach/accounts/alpha/one.maker", json=bad).status_code
            == 400
        )
    assert (
        c.patch(
            "/api/outreach/accounts/alpha/nobody", json={"tier": "peer"}
        ).status_code
        == 404
    )
    assert (
        c.patch(
            "/api/outreach/accounts/gamma/one.maker", json={"tier": "peer"}
        ).status_code
        == 404
    )


def test_an_unreadable_store_is_never_overwritten(root):
    root.mkdir()
    (root / "targets.json").write_text("{not json", encoding="utf-8")
    c = _client()
    assert c.get("/api/outreach/state").status_code == 503
    r = c.post("/api/outreach/accounts", json={"brand": "alpha", "text": "one.maker"})
    assert r.status_code == 503
    assert (root / "targets.json").read_text(encoding="utf-8") == "{not json"


# ---------- today's round ----------


def _handles(rnd) -> list[str]:
    return [r["handle"] for r in rnd["rows"]]


def test_round_is_five_least_recently_engaged_first(root):
    names = [f"maker{i}" for i in range(8)]
    _seed(root, "alpha", names)
    doc = orr.read_targets(root)
    accounts = doc["brands"]["alpha"]["accounts"]
    # maker0 and maker1 were engaged before; the rest never.
    accounts[0]["last_engaged_at"] = "2026-03-01T15:00:00Z"
    accounts[1]["last_engaged_at"] = "2026-02-01T15:00:00Z"
    rnd = orr.build_round(accounts, [], "alpha", DAY)
    assert _handles(rnd) == ["maker2", "maker3", "maker4", "maker5", "maker6"]
    assert rnd["open"] == 5 and not rnd["complete"]


def test_round_takes_one_from_each_tier_that_has_any(root):
    _seed(root, "alpha", [f"peer{i}" for i in range(6)])
    _seed(root, "alpha", ["big.one"], tier="large")
    _seed(root, "alpha", ["creator.one"], tier="creator")
    doc = orr.read_targets(root)
    accounts = doc["brands"]["alpha"]["accounts"]
    # The two other tiers were engaged yesterday: last in line, still offered.
    for a in accounts:
        if a["tier"] != "peer":
            a["last_engaged_at"] = "2026-03-09T15:00:00Z"
    rnd = orr.build_round(accounts, [], "alpha", DAY)
    got = _handles(rnd)
    assert len(got) == 5
    assert "big.one" in got and "creator.one" in got
    assert got[:3] == ["peer0", "peer1", "peer2"]


def test_round_never_offers_an_account_engaged_today_and_rotates(root):
    names = [f"maker{i}" for i in range(7)]
    _seed(root, "alpha", names)
    c = _client()
    first = c.get("/api/outreach/state").json()["brands"][0]["round"]
    assert _handles(first) == names[:5]
    for handle in names[:5]:
        r = c.post(f"/api/outreach/round/alpha/{handle}", json={"action": "done"})
        assert r.status_code == 200
    done = c.get("/api/outreach/state").json()["brands"][0]["round"]
    # The day's round is the same five, all done: nothing new is offered.
    assert sorted(_handles(done)) == names[:5]
    assert done["complete"] and done["open"] == 0 and done["done"] == 5

    tomorrow = NOW + timedelta(days=1)
    state = orr.read_state(root, ["alpha"], tomorrow)
    nxt = state["brands"][0]["round"]
    # The two never engaged come first, then the earliest engaged yesterday.
    assert _handles(nxt)[:2] == ["maker5", "maker6"]
    assert len(nxt["rows"]) == 5 and nxt["open"] == 5


def test_skip_rotates_without_counting_as_engaged(root):
    _seed(root, "alpha", [f"maker{i}" for i in range(7)])
    orr.mark_round(root, "alpha", "maker0", "skip", None, NOW)
    account = orr._account(orr.read_targets(root), "alpha", "maker0")
    assert account["last_engaged_at"] is None
    nxt = orr.read_state(root, ["alpha"], NOW + timedelta(days=1))["brands"][0]["round"]
    # Never engaged like the others, but skipped most recently: last in line.
    assert "maker0" not in _handles(nxt)
    assert _handles(nxt) == ["maker1", "maker2", "maker3", "maker4", "maker5"]


def test_done_keeps_the_angle_and_undo_puts_the_time_back(root):
    _seed(root, "alpha", ["one.maker", "two.maker"])
    earlier = NOW - timedelta(days=3)
    orr.mark_round(root, "alpha", "one.maker", "done", None, earlier)
    c = _client()
    r = c.post(
        "/api/outreach/round/alpha/one.maker",
        json={"action": "done", "angle": "  Clean  build on that rack.  "},
    )
    assert r.status_code == 200
    row = next(x for x in r.json()["rows"] if x["handle"] == "one.maker")
    assert row["state"] == "done" and row["angle"] == "Clean build on that rack."
    assert (
        c.post(
            "/api/outreach/round/alpha/one.maker", json={"action": "done"}
        ).status_code
        == 409
    )
    lines = orr.read_log(root)
    assert lines[-1]["kind"] == "done" and lines[-1]["day"] == DAY
    assert lines[-1]["angle"] == "Clean build on that rack."

    undone = c.post("/api/outreach/round/alpha/one.maker", json={"action": "undo"})
    assert undone.status_code == 200
    account = orr._account(orr.read_targets(root), "alpha", "one.maker")
    assert account["last_engaged_at"] == orr._iso(earlier)
    assert (
        c.post(
            "/api/outreach/round/alpha/one.maker", json={"action": "undo"}
        ).status_code
        == 409
    )
    too_long = c.post(
        "/api/outreach/round/alpha/one.maker",
        json={"action": "done", "angle": "x" * 201},
    )
    assert too_long.status_code == 400


def test_round_completion_is_logged_once_and_reopens_on_undo(root):
    _seed(root, "alpha", ["one.maker", "two.maker"])
    orr.mark_round(root, "alpha", "one.maker", "done", None, NOW)
    orr.mark_round(root, "alpha", "two.maker", "skip", None, NOW)
    rounds = [x for x in orr.read_log(root) if x["kind"] == "round"]
    assert len(rounds) == 1 and rounds[0]["complete"] is True
    assert rounds[0]["done"] == 1 and rounds[0]["skipped"] == 1
    assert sorted(rounds[0]["handles"]) == ["one.maker", "two.maker"]
    orr.mark_round(root, "alpha", "two.maker", "undo", None, NOW)
    rounds = [x for x in orr.read_log(root) if x["kind"] == "round"]
    assert [x["complete"] for x in rounds] == [True, False]


def test_a_paused_account_leaves_the_round(root):
    _seed(root, "alpha", ["one.maker", "two.maker"])
    orr.edit_account(root, "alpha", "one.maker", {"status": "paused"}, NOW)
    rnd = orr.read_state(root, ["alpha"], NOW)["brands"][0]["round"]
    assert _handles(rnd) == ["two.maker"]


# ---------- the checklist ----------


def test_checklist_and_days_kept(root):
    _seed(root, "alpha", ["one.maker"])
    for offset in (2, 1):  # two full days, then today half done
        at = NOW - timedelta(days=offset)
        orr.mark_round(root, "alpha", "one.maker", "done", None, at)
        for item in orr.CHECK_ITEMS:
            orr.set_check(root, "alpha", item, True, at)
    c = _client()
    r = c.post(
        "/api/outreach/checklist/alpha",
        json={"item": "comments_answered", "checked": True},
    )
    assert r.status_code == 200
    box = c.get("/api/outreach/state").json()["brands"][0]["checklist"]
    assert box["comments_answered"] is True and box["reel_to_stories"] is False
    assert box["round_done"] is False
    assert box["days_kept"] == 2 and box["streak"] == 2
    c.post(
        "/api/outreach/checklist/alpha",
        json={"item": "reel_to_stories", "checked": True},
    )
    c.post("/api/outreach/round/alpha/one.maker", json={"action": "done"})
    box = c.get("/api/outreach/state").json()["brands"][0]["checklist"]
    assert box["round_done"] is True and box["days_kept"] == 3 and box["streak"] == 3
    # Unticking today takes the day back.
    c.post(
        "/api/outreach/checklist/alpha",
        json={"item": "reel_to_stories", "checked": False},
    )
    box = c.get("/api/outreach/state").json()["brands"][0]["checklist"]
    assert box["days_kept"] == 2 and box["streak"] == 2
    bad = c.post(
        "/api/outreach/checklist/alpha", json={"item": "followers", "checked": True}
    )
    assert bad.status_code == 400


# ---------- Waiting on you ----------


def test_waiting_row_per_brand_until_the_round_is_done(root):
    _seed(root, "alpha", ["one.maker", "two.maker"])
    _seed(root, "beta", ["paused.maker"], status="paused")
    rows = orr.waiting_items(root, ["alpha", "beta"], NOW)
    # beta has no active account: no row.
    assert [r["id"] for r in rows] == [f"outreach:alpha:{DAY}"]
    row = rows[0]
    assert row["kind"] == "outreach" and row["scope"] == "alpha"
    assert row["link"] == {"page": "/outreach", "focus": "alpha"}
    assert row["detail"] == "2 of 2 accounts left today"
    orr.mark_round(root, "alpha", "one.maker", "done", None, NOW)
    assert orr.waiting_items(root, ["alpha"], NOW)[0]["detail"].startswith("1 of 2")
    orr.mark_round(root, "alpha", "two.maker", "skip", None, NOW)
    assert orr.waiting_items(root, ["alpha"], NOW) == []
    # The next Central day it is back.
    back = orr.waiting_items(root, ["alpha"], NOW + timedelta(days=1))
    assert [r["id"] for r in back] == ["outreach:alpha:2026-03-11"]


def test_the_day_is_central(root):
    # 03:00 UTC on the 11th is still the 10th in Central.
    assert orr.central_day(datetime(2026, 3, 11, 3, 0, tzinfo=timezone.utc)) == DAY
    assert (
        orr.central_day(datetime(2026, 3, 11, 6, 0, tzinfo=timezone.utc))
        == "2026-03-11"
    )


def test_build_waiting_lists_the_row_in_the_act_lane(root, tmp_path, monkeypatch):
    _seed(root, "alpha", ["one.maker"])

    async def none():
        return None, "down"

    async def nothing():
        return None

    monkeypatch.setattr(wr, "_hermes", none)
    monkeypatch.setattr(wr, "_trading", none)
    monkeypatch.setattr(wr, "_recs", nothing)

    async def no_g1():
        return None, None

    monkeypatch.setattr(wr, "_g1", no_g1)
    monkeypatch.setattr(wr, "_data_dir", lambda: tmp_path)
    body = asyncio.run(wr.build_waiting(NOW))
    rows = [i for i in body["items"] if i["kind"] == "outreach"]
    assert len(rows) == 1 and rows[0]["lane"] == "act" and rows[0]["delegate"] is None
    assert body["counts"]["outreach"] == 1 and body["counts"]["act"] == 1
    assert body["counts"]["total"] == 1
    assert "social" in body["sources"]
    assert "Outreach round: Outreach round: alpha" in wr.format_answer(body, NOW)


# ---------- candidates and the feeds ----------


def _feed(feed: str, data: dict) -> dict:
    return {
        "feed": feed,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "age_seconds": 5,
        "source_role": "content-strategist",
        "data": data,
    }


CANDIDATES = {
    "run_at": "2026-03-09T12:00:00Z",
    "week": "2026-W11",
    "properties": [
        {
            "id": "alpha",
            "candidates": [
                {
                    "handle": "found.maker",
                    "why": "Builds the same kind of kit",
                    "found_on": "https://example.org/list",
                }
            ],
            "skipped_known": 0,
        }
    ],
    "errors": [],
}


def _bridge(handler):
    real = httpx.AsyncClient

    def fake(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    return patch("openjarvis.server.hermes_panel.httpx.AsyncClient", side_effect=fake)


def test_feeds_pass_through_and_404_is_not_yet(root):
    def handler(req):
        if req.url.path == "/panels/ig_target_candidates":
            return httpx.Response(200, json=_feed("ig_target_candidates", CANDIDATES))
        return httpx.Response(404, json={"error": "no data"})

    c = _client()
    with _bridge(handler):
        got = c.get("/api/outreach/ig_target_candidates")
        assert got.status_code == 200 and got.json()["week"] == "2026-W11"
        assert c.get("/api/outreach/ig_reach").status_code == 404
        assert c.get("/api/outreach/anything_else").status_code == 404


def test_accept_takes_hermes_words_and_dismiss_fills_dismissed(root):
    def handler(req):
        return httpx.Response(200, json=_feed("ig_target_candidates", CANDIDATES))

    c = _client()
    with _bridge(handler):
        gone = c.post("/api/outreach/candidates/alpha/other.maker/accept")
        assert gone.status_code == 409
        r = c.post("/api/outreach/candidates/alpha/found.maker/accept")
        assert r.status_code == 200
        account = r.json()
        assert account["source"] == "hermes"
        assert account["why"] == "Builds the same kind of kit"
        assert account["found_on"] == "https://example.org/list"
        assert (
            c.post("/api/outreach/candidates/alpha/found.maker/accept").status_code
            == 409
        )
        d = c.post("/api/outreach/candidates/alpha/noisy.maker/dismiss")
        assert d.status_code == 200 and d.json() == {"dismissed": ["noisy.maker"]}
        assert (
            c.post("/api/outreach/candidates/alpha/found.maker/dismiss").status_code
            == 409
        )
        assert (
            c.post("/api/outreach/candidates/alpha/found.maker/follow").status_code
            == 400
        )
    # The operator pasting a dismissed handle lifts the dismissal.
    orr.add_accounts(root, "alpha", "noisy.maker", NOW)
    assert orr.read_targets(root)["brands"]["alpha"]["dismissed"] == []


# ---------- angles ----------

PROP = {
    "id": "alpha",
    "kernelContent": {
        "brand": {"voice": "Dry, plain, a little wry.", "bannedWords": ["synergy"]},
        "characters": [{"name": "The Clerk", "description": "Keeps the ledger."}],
        "negatives": "Never shout.",
    },
    "compliance": {
        "prohibitedPhrases": [
            {"phrase": "military grade", "rule": "1", "match": {"mode": "word"}},
            {"phrase": "cure", "rule": "2", "match": {"mode": "substring"}},
            {
                "phrase": "Proven",
                "rule": "3",
                "match": {"mode": "word", "caseSensitive": True},
            },
            {
                "phrase": "tested",
                "rule": "4",
                "match": {"mode": "word"},
                "verify": True,
            },
        ]
    },
}
ACCOUNT = {"handle": "one.maker", "niche": "field kits", "why": "", "notes": ""}

# The test set for acceptance 3: each of these breaks one rule.
BREAKS = [
    "That is military-grade stitching.",
    "MILITARY  GRADE all the way.",
    "This would cure a bad mood.",
    "A secure fit, nicely done.",  # substring: "cure" inside "secure"
    "Proven in the field.",
    "Tested hard, I can tell.",
    "Pure synergy between the two.",
    "See more at example.com",
    "Nice one @someone",
    "Love it #kit",
    "Worth every $ of it.",
    "Half off is 50% well spent.",
    "x" * 201,
]
PASSES = [
    "That stitching will outlast the strap it holds.",
    "proven is the word I would have used.",  # case-sensitive phrase, lower case
    "Unbreakableness is not a word, and yet.",
    "Clean layout. The ledger approves.",
]


def test_screen_refuses_every_break_and_passes_the_rest():
    rules = orr.brand_rules(PROP)
    assert rules is not None
    for text in BREAKS:
        assert orr.screen_angle(text, rules) is not None, text
    for text in PASSES:
        assert orr.screen_angle(text, rules) is None, text
    assert orr.brand_rules({"id": "alpha", "compliance": {}}) is None


def _model(replies: list[list[str]], seen: list | None = None):
    queue = list(replies)

    def handler(req):
        if seen is not None:
            seen.append(json.loads(req.content))
        angles = queue.pop(0) if queue else []
        return httpx.Response(
            200, json={"message": {"content": json.dumps({"angles": angles})}}
        )

    return httpx.MockTransport(handler)


def _draft(prop, replies, seen=None, about=""):
    return asyncio.run(
        orr.draft_angles(
            prop,
            ACCOUNT,
            about,
            host="http://model.invalid",
            model="local-test",
            transport=_model(replies, seen),
        )
    )


def test_angles_are_three_screened_and_none_breaks_a_rule():
    seen: list = []
    out = _draft(
        PROP, [BREAKS[:6] + PASSES[:2], PASSES[2:] + BREAKS[6:]], seen, "a rack"
    )
    assert out["angles"] == PASSES[:3]
    rules = orr.brand_rules(PROP)
    assert all(orr.screen_angle(a, rules) is None for a in out["angles"])
    assert all(len(a) <= 200 for a in out["angles"])
    assert out["screened_out"] >= 6 and out["model"] == "local-test"
    # Asked twice (the first answer had two passes), on this machine's model,
    # with the kernel and the account in the prompt.
    assert len(seen) == 2 and seen[0]["think"] is False
    system, user = (m["content"] for m in seen[0]["messages"])
    assert "Dry, plain, a little wry." in system and "The Clerk" in system
    assert "@one.maker" in user and "a rack" in user


def test_angles_stop_after_one_ask_when_three_pass():
    seen: list = []
    out = _draft(PROP, [PASSES], seen)
    assert len(out["angles"]) == 3 and len(seen) == 1 and out["screened_out"] == 0


def test_angles_fail_closed():
    with pytest.raises(HTTPException) as none_pass:
        _draft(PROP, [BREAKS[:3], BREAKS[3:6]])
    assert none_pass.value.status_code == 502
    with pytest.raises(HTTPException) as no_rules:
        _draft({"id": "alpha", "kernelContent": PROP["kernelContent"]}, [PASSES])
    assert no_rules.value.status_code == 503
    with pytest.raises(HTTPException) as no_kernel:
        _draft({"id": "alpha", "compliance": PROP["compliance"]}, [PASSES])
    assert no_kernel.value.status_code == 503


def test_angles_route_needs_the_account_and_the_bundle(root, tmp_path):
    _seed(root, "alpha", ["one.maker"])
    c = _client()
    missing = c.post(
        "/api/outreach/angles", json={"brand": "alpha", "handle": "nobody"}
    )
    assert missing.status_code == 404
    no_bundle = c.post(
        "/api/outreach/angles", json={"brand": "alpha", "handle": "one.maker"}
    )
    assert no_bundle.status_code == 503
    long = c.post(
        "/api/outreach/angles",
        json={"brand": "alpha", "handle": "one.maker", "about": "x" * 501},
    )
    assert long.status_code == 400


# ---------- loopback only ----------


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("get", "/api/outreach/state", None),
        ("get", "/api/outreach/ig_reach", None),
        ("get", "/api/outreach/ig_target_candidates", None),
        ("post", "/api/outreach/accounts", {"brand": "alpha", "text": "one.maker"}),
        ("patch", "/api/outreach/accounts/alpha/one.maker", {"tier": "peer"}),
        ("post", "/api/outreach/round/alpha/one.maker", {"action": "done"}),
        (
            "post",
            "/api/outreach/checklist/alpha",
            {"item": "comments_answered", "checked": True},
        ),
        ("post", "/api/outreach/angles", {"brand": "alpha", "handle": "one.maker"}),
        ("post", "/api/outreach/candidates/alpha/one.maker/accept", None),
        ("post", "/api/outreach/candidates/alpha/one.maker/dismiss", None),
    ],
)
def test_no_route_answers_off_loopback(root, method, path, body):
    c = _client(host="192.0.2.10")
    r = (
        getattr(c, method)(path, json=body)
        if body is not None
        else getattr(c, method)(path)
    )
    assert r.status_code == 403
    assert not root.exists()


def test_every_route_is_covered_by_the_loopback_test():
    paths = {r.path for r in orr.outreach_router.routes}
    assert paths == {
        "/api/outreach/state",
        "/api/outreach/accounts",
        "/api/outreach/accounts/{brand}/{handle}",
        "/api/outreach/round/{brand}/{handle}",
        "/api/outreach/checklist/{brand}",
        "/api/outreach/angles",
        "/api/outreach/candidates/{brand}/{handle}/{action}",
        "/api/outreach/{feed}",
    }


def test_unconfigured_is_an_empty_page_not_an_error(monkeypatch):
    monkeypatch.setattr(orr, "store_dir", lambda: None)
    monkeypatch.setattr(orr, "brand_ids", lambda: [])
    body = _client().get("/api/outreach/state").json()
    assert body["configured"] is False and body["brands"] == []
