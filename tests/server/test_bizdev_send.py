"""Tests for Business Development Send (hq 0018, contract v0.10 BD, Parts
A-C): the send route, the template routes, the Forward Email client and the
delivery-status poll. Forward Email and the bridge are stubbed. Invented
fixtures only (example.edu / example.org): this repo is public."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import bizdev_routes as br
from openjarvis.server import bizdev_send as bs
from openjarvis.server.forwardemail import ForwardEmail, ForwardEmailError

TO = "a.person@example.edu"
SENDER = "sender@example.org"


def _card(**over) -> dict:
    return {
        "id": 42,
        "name": "Example College",
        "stage": "drafted",
        "contacts": [
            {"name": "A Person", "title": "SID", "email": TO},
            {"name": "B Person", "email": "b.person@example.edu"},
        ],
        "touches": [],
        **over,
    }


# A line's published footer (contract v0.10 `screen.footer`), placeholders
# unfilled, as Hermes's drafts carry it.
FOOTER = (
    "\n\n--\n[Your name]\nSample Org LLC · [postal address]\n"
    "If this isn't useful, reply \"no thanks\" and I won't follow up."
)


def _pipeline(card: dict, line: dict | None = None) -> dict:
    return {
        "feed": "bd_pipeline",
        "generated_at": "2026-10-20T12:00:00Z",
        "data": {
            "lines": [
                {
                    "line": "sample",
                    "stages": {"drafted": [card], "sent": []},
                    "follow_ups_due": [],
                    **(line or {}),
                }
            ]
        },
    }


class FakeFE:
    def __init__(self, *, count=0, limit=300, fail=None, status="queued"):
        self.count, self.lim, self.fail, self.st = count, limit, fail, status
        self.rejected: list[dict] = []
        self.sent: list[dict] = []
        self.status_calls: list[str] = []

    async def limit(self):
        return {"count": self.count, "limit": self.lim}

    async def send(self, payload):
        if self.fail:
            raise self.fail
        self.sent.append(payload)
        return {"id": "fe0001", "message_id": None, "status": "queued"}

    async def status(self, email_id):
        self.status_calls.append(email_id)
        return {"status": self.st, "rejectedErrors": self.rejected}


@pytest.fixture
def env(tmp_path, monkeypatch):
    key = tmp_path / "fe.key"
    key.write_text("test-token-not-real\n", encoding="utf-8")
    cfg = {
        bs.KEY_FILE: str(key),
        "BD_SENDER_NAME": "Sample Sender",
        "BD_SENDER_ADDRESS": SENDER,
        "BD_SENDER_ORG": "Sample Org LLC",
        "BD_POSTAL_ADDRESS": "1 Example St, Sample City",
    }
    monkeypatch.setattr(bs, "get_tool_credential", lambda tool, k: cfg.get(k))
    monkeypatch.setenv("OPENJARVIS_HOME", str(tmp_path / "home"))
    fe = FakeFE()
    monkeypatch.setattr(bs, "_client", lambda c: fe)
    return {"cfg": cfg, "fe": fe, "key": key}


def _bridge(card: dict, *, flag_status=202, seen=None, line=None):
    def handler(req: httpx.Request):
        if seen is not None:
            seen.append(req)
        if req.method == "GET" and req.url.path == "/panels/bd_pipeline":
            return httpx.Response(200, json=_pipeline(card, line))
        if req.method == "POST" and req.url.path.startswith("/bd/"):
            return httpx.Response(flag_status, json={"queued": True})
        return httpx.Response(404)

    real = httpx.AsyncClient

    def fake(*a, **kw):
        kw["transport"] = httpx.MockTransport(handler)
        return real(*a, **kw)

    return patch.object(bs.httpx, "AsyncClient", side_effect=fake)


def _client(host="127.0.0.1"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(br.bizdev_router)
    return TestClient(app, client=(host, 50000))


def _body(**over) -> dict:
    return {
        "to_email": TO,
        "subject": "A sample subject",
        "body": "Hello,\n\nA sample paragraph.\nSecond line.",
        "touch": 1,
        "draft_source": "hermes",
        **over,
    }


def _flags(seen, kind):
    return [
        json.loads(r.content)
        for r in seen
        if r.method == "POST" and r.url.path.endswith(f"/{kind}")
    ]


# -- send -------------------------------------------------------------------


def test_send_posts_the_mail_and_the_exact_v010_flag(env):
    seen: list = []
    with _bridge(_card(), seen=seen):
        resp = _client().post(
            "/api/bizdev/prospects/42/send", json=_body(from_name="S. Sender")
        )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["fe_id"] == "fe0001" and out["fe_status"] == "queued" and out["recorded"]
    mail = env["fe"].sent[0]
    assert mail["from"] == f"S. Sender <{SENDER}>"
    assert mail["replyTo"] == SENDER and mail["to"] == TO
    assert "list" not in mail  # 0018 Phase 0: List-Unsubscribe reads as a newsletter
    assert mail["messageId"].startswith("<bd-42-1-") and mail["messageId"].endswith(
        "@example.org>"
    )
    assert "inReplyTo" not in mail
    assert mail["text"].endswith(
        "--\nSample Sender\nSample Org LLC · 1 Example St, Sample City\n"
        'To stop these emails, reply "unsubscribe".'
    )
    assert "<p>Hello,</p>" in mail["html"] and "A sample paragraph.<br>" in mail["html"]
    (flag,) = _flags(seen, "sent")
    assert set(flag) == {
        "touch",
        "fe_id",
        "message_id",
        "token",
        "to_email",
        "draft_source",
        "subject",
        "body",
        "from",
        "reply_to",
    }
    assert flag["touch"] == 1 and flag["fe_id"] == "fe0001" and flag["token"] == ""
    assert flag["message_id"] == mail["messageId"] and flag["body"] == mail["text"]
    assert flag["from"] == mail["from"] and flag["reply_to"] == SENDER
    # The log keeps ids and status, not the prospect's text, once recorded.
    (entry,) = bs.load_log()
    assert entry["flag"] is None and entry["fe_status"] == "pending"
    assert entry["fe_raw"] == "queued"


FILLED = (
    "--\nS. Sender\nSample Org LLC · 1 Example St, Sample City\n"
    "If this isn't useful, reply \"no thanks\" and I won't follow up."
)


@pytest.mark.parametrize(
    "body",
    [
        "Hello,\n\nA sample paragraph." + FOOTER,  # a Hermes draft
        "Hello,\n\nA sample paragraph.",  # a template saved on the page
        "Hello,\n\nA sample paragraph.\n\n" + FOOTER.strip()[:-1] + ".\n",
    ],
)
def test_the_published_footer_is_sent_once_and_filled(env, body):
    line = {"screen": {"patterns": [], "footer": FOOTER}}
    with _bridge(_card(), line=line):
        resp = _client().post(
            "/api/bizdev/prospects/42/send",
            json=_body(body=body, from_name="S. Sender"),
        )
    assert resp.status_code == 200, resp.text
    text = env["fe"].sent[0]["text"]
    assert text.endswith(FILLED) and text.count("\n--\n") == 1
    assert "[Your name]" not in text and "[postal address]" not in text
    assert text.startswith("Hello,\n\nA sample paragraph.\n\n--\n")


def test_a_placeholder_left_in_the_body_is_filled(env):
    line = {"screen": {"patterns": [], "footer": FOOTER}}
    with _bridge(_card(), line=line):
        _client().post(
            "/api/bizdev/prospects/42/send",
            json=_body(body="Hello,\n\nBest,\n[Your name]"),
        )
    text = env["fe"].sent[0]["text"]
    assert text.startswith("Hello,\n\nBest,\nSample Sender\n\n--\nSample Sender\n")
    assert "[Your name]" not in text


@pytest.mark.parametrize("value", ["1", "true", "on"])
def test_list_unsubscribe_only_when_turned_on(env, value):
    env["cfg"]["BD_LIST_UNSUBSCRIBE"] = value
    with _bridge(_card()):
        assert (
            _client().post("/api/bizdev/prospects/42/send", json=_body()).status_code
            == 200
        )
    assert env["fe"].sent[0]["list"] == {
        "unsubscribe": {"url": f"mailto:{SENDER}?subject=unsubscribe"}
    }


def test_forward_email_4xx_is_502_with_no_flag(env):
    env["fe"].fail = ForwardEmailError(400, "Invalid recipient")
    seen: list = []
    with _bridge(_card(), seen=seen):
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body())
    assert resp.status_code == 502 and resp.json()["detail"] == "Invalid recipient"
    assert _flags(seen, "sent") == [] and bs.load_log() == []


def test_a_second_send_of_the_same_touch_is_409(env):
    with _bridge(_card()):
        assert (
            _client().post("/api/bizdev/prospects/42/send", json=_body()).status_code
            == 200
        )
        again = _client().post("/api/bizdev/prospects/42/send", json=_body())
    assert again.status_code == 409 and len(env["fe"].sent) == 1


def test_a_sent_touch_on_the_card_is_409_unless_rejected(env):
    sent = _card(
        touches=[{"n": 1, "sent_at": "x", "fe_id": "fe9", "fe_status": "sent"}]
    )
    with _bridge(sent):
        assert (
            _client().post("/api/bizdev/prospects/42/send", json=_body()).status_code
            == 409
        )
    rejected = _card(
        touches=[{"n": 1, "sent_at": "x", "fe_id": "fe9", "fe_status": "rejected"}]
    )
    with _bridge(rejected):
        assert (
            _client().post("/api/bizdev/prospects/42/send", json=_body()).status_code
            == 200
        )


def test_the_touch_must_be_the_cards_next(env):
    with _bridge(_card()):
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body(touch=2))
    assert resp.status_code == 409
    assert "next touch to this address is 1" in resp.json()["detail"]


def test_a_follow_up_threads_on_touch_one(env):
    first = "<bd-42-1-abcdef01@example.org>"
    card = _card(
        touches=[
            {
                "n": 1,
                "sent_at": "x",
                "fe_id": "fe1",
                "fe_status": "sent",
                "message_id": first,
            }
        ]
    )
    with _bridge(card):
        resp = _client().post(
            "/api/bizdev/prospects/42/send",
            json=_body(touch=2, in_reply_to_message_id=first),
        )
    assert resp.status_code == 200
    mail = env["fe"].sent[0]
    assert mail["inReplyTo"] == first and mail["references"] == first


def test_the_limit_reached_is_429_and_nothing_sends(env):
    env["fe"].count = 300
    with _bridge(_card()):
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body())
    assert resp.status_code == 429 and "300 of 300" in resp.json()["detail"]
    assert env["fe"].sent == []


def test_an_unresolved_merge_field_is_422(env):
    with _bridge(_card()):
        resp = _client().post(
            "/api/bizdev/prospects/42/send", json=_body(body="Hi {{first_name}},")
        )
    assert resp.status_code == 422 and "{{first_name}}" in resp.json()["detail"]
    assert env["fe"].sent == []


@pytest.mark.parametrize(
    "over,status",
    [
        ({"to_email": "someone@example.org"}, 422),  # not a contact
        ({"body": "   "}, 422),
        ({"touch": 4}, 400),
        ({"from_name": "Evil\r\nBcc: x"}, 400),
        ({"draft_source": "other"}, 400),
        ({"draft_source": "template:abc"}, 400),  # Hermes takes digits only
    ],
)
def test_bad_requests_never_send(env, over, status):
    with _bridge(_card()):
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body(**over))
    assert resp.status_code == status and env["fe"].sent == []


def test_non_loopback_is_403(env):
    remote = _client("192.168.1.20")
    with _bridge(_card()):
        assert (
            remote.post("/api/bizdev/prospects/42/send", json=_body()).status_code
            == 403
        )
        assert remote.get("/api/bizdev/send-config").status_code == 403
    assert env["fe"].sent == []


def test_unconfigured_send_is_503_and_config_says_disabled(env, monkeypatch):
    monkeypatch.setattr(bs, "get_tool_credential", lambda tool, k: None)
    with _bridge(_card()):
        assert (
            _client().post("/api/bizdev/prospects/42/send", json=_body()).status_code
            == 503
        )
        cfg = _client().get("/api/bizdev/send-config").json()
    assert cfg == {
        "enabled": False,
        "sender_name": None,
        "sender_address": None,
        "reply_to": None,
        "sender_title": None,
        "tracking": False,
        "missing": [],
    }


def test_send_config_never_returns_the_key_or_its_path(env):
    with _bridge(_card()):
        resp = _client().get("/api/bizdev/send-config")
    assert resp.json()["enabled"] is True
    assert "test-token" not in resp.text and str(env["key"]) not in resp.text
    assert resp.json()["reply_to"] == SENDER


def test_bridge_down_refuses_before_sending(env):
    def refuse(req):
        raise httpx.ConnectError("refused", request=req)

    real = httpx.AsyncClient

    def down(*a, **kw):
        kw["transport"] = httpx.MockTransport(refuse)
        return real(*a, **kw)

    with patch.object(bs.httpx, "AsyncClient", side_effect=down):
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body())
    assert resp.status_code == 503 and env["fe"].sent == []


def test_an_unrecorded_flag_is_kept_and_retried_by_the_poll(env):
    seen: list = []
    with _bridge(_card(), flag_status=500, seen=seen):
        out = _client().post("/api/bizdev/prospects/42/send", json=_body()).json()
    assert out["recorded"] is False
    assert bs.load_log()[0]["flag"]["to_email"] == TO
    seen.clear()
    with _bridge(_card(), seen=seen):
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert len(_flags(seen, "sent")) == 1
    assert bs.load_log()[0]["flag"] is None


# -- the poll ---------------------------------------------------------------------


def _log(env, **over):
    entry = {
        "prospect_id": 42,
        "touch": 1,
        "fe_id": "fe0001",
        "message_id": "<m@example.org>",
        "fe_status": "queued",
        "sent_at": bs._iso(datetime.now(timezone.utc)),
        "flag": None,
        **over,
    }
    bs.save_log([entry])


def test_poll_relays_a_status_change_once(env):
    _log(env)
    env["fe"].st = "deferred"
    seen: list = []
    with _bridge(_card(), seen=seen):
        asyncio.run(bs.poll_once(client=env["fe"]))
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert _flags(seen, "status") == [
        {"touch": 1, "fe_id": "fe0001", "fe_status": "deferred"}
    ]


def test_poll_maps_delivered_to_sent_and_stops_at_a_terminal_status(env):
    _log(env)
    env["fe"].st = "sent"
    seen: list = []
    with _bridge(_card(), seen=seen):
        asyncio.run(bs.poll_once(client=env["fe"]))
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert _flags(seen, "status") == [
        {"touch": 1, "fe_id": "fe0001", "fe_status": "sent"}
    ]
    assert env["fe"].status_calls == ["fe0001"]  # not polled again once sent


def test_poll_relays_why_a_mail_was_deferred(env):
    _log(env)
    env["fe"].st = "deferred"
    env["fe"].rejected = [
        {
            "recipient": "a.person@example.edu",
            "responseCode": 421,
            "message": "Newsletter usage is not yet approved\nmore detail",
        }
    ]
    seen: list = []
    with _bridge(_card(), seen=seen):
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert _flags(seen, "status") == [
        {
            "touch": 1,
            "fe_id": "fe0001",
            "fe_status": "deferred",
            "fe_error": "Newsletter usage is not yet approved",
        }
    ]


def test_poll_relays_the_first_answer_after_a_send(env):
    with _bridge(_card()):
        _client().post("/api/bizdev/prospects/42/send", json=_body())
    seen: list = []
    with _bridge(_card(), seen=seen):
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert _flags(seen, "status") == [
        {"touch": 1, "fe_id": "fe0001", "fe_status": "queued"}
    ]


def test_poll_relays_a_bounced_mail_as_rejected(env):
    _log(env)
    env["fe"].st = "bounced"
    env["fe"].rejected = [{"message": "550-5.1.1 The email account does not exist"}]
    seen: list = []
    with _bridge(_card(), seen=seen):
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert _flags(seen, "status") == [
        {
            "touch": 1,
            "fe_id": "fe0001",
            "fe_status": "rejected",
            "fe_error": "550-5.1.1 The email account does not exist",
        }
    ]
    entry = bs.load_log()[0]
    assert entry["fe_raw"] == "bounced" and entry["fe_status"] == "rejected"


@pytest.mark.parametrize("raw", ["mystery", "delivered"])
def test_poll_keeps_an_unknown_value_raw_and_relays_nothing(env, raw):
    _log(env)
    env["fe"].st = raw
    seen: list = []
    with _bridge(_card(), seen=seen):
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert _flags(seen, "status") == []
    entry = bs.load_log()[0]
    assert entry["fe_raw"] == raw and entry["fe_status"] == "queued"


def test_poll_stops_after_seven_days_and_drops_the_entry(env):
    old = datetime.now(timezone.utc) - timedelta(days=8)
    _log(env, sent_at=bs._iso(old))
    with _bridge(_card()):
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert env["fe"].status_calls == [] and bs.load_log() == []


def test_poll_retries_a_status_flag_the_bridge_refused(env):
    _log(env)
    env["fe"].st = "rejected"
    with _bridge(_card(), flag_status=500):
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert bs.load_log()[0]["status_flag"]["fe_status"] == "rejected"
    seen: list = []
    with _bridge(_card(), seen=seen):
        asyncio.run(bs.poll_once(client=env["fe"]))
    assert len(_flags(seen, "status")) == 1 and bs.load_log()[0]["status_flag"] is None


# -- the client ---------------------------------------------------------------------


def test_client_retries_once_on_5xx_never_on_4xx_and_hides_the_token():
    calls: list[httpx.Request] = []

    def run(statuses):
        calls.clear()
        replies = iter(statuses)

        def handler(req):
            calls.append(req)
            code = next(replies)
            return httpx.Response(code, json={"message": f"code {code}\nmore"})

        real = httpx.AsyncClient

        def fake(*a, **kw):
            kw["transport"] = httpx.MockTransport(handler)
            return real(*a, **kw)

        with patch(
            "openjarvis.server.forwardemail.httpx.AsyncClient", side_effect=fake
        ):
            try:
                return asyncio.run(ForwardEmail("tok-secret").limit())
            except ForwardEmailError as exc:
                return exc

    err = run([400])
    assert (
        isinstance(err, ForwardEmailError)
        and err.message == "code 400"
        and len(calls) == 1
    )
    err = run([502, 503])
    assert isinstance(err, ForwardEmailError) and len(calls) == 2
    assert "tok-secret" not in err.message
    assert calls[0].headers["authorization"].startswith("Basic ")


# -- Part B: the open pixel ----------------------------------------------------


def test_the_pixel_is_in_html_only_and_its_token_in_the_flag(env):
    env["cfg"]["BD_TRACK_BASE_URL"] = "https://t.example.org"
    seen: list = []
    with _bridge(_card(), seen=seen):
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body())
    assert resp.status_code == 200, resp.text
    mail = env["fe"].sent[0]
    (flag,) = _flags(seen, "sent")
    token = flag["token"]
    assert len(token) == 32 and all(c in "0123456789abcdef" for c in token)
    assert mail["html"].endswith(
        f'<img src="https://t.example.org/o/{token}.gif" width="1" height="1" alt="">'
    )
    assert token not in mail["text"] and "<img" not in mail["text"]
    assert "href" not in mail["html"]  # D4: no link rewriting


def test_no_pixel_and_an_empty_token_without_a_track_url(env):
    seen: list = []
    with _bridge(_card(), seen=seen):
        _client().post("/api/bizdev/prospects/42/send", json=_body())
    assert "<img" not in env["fe"].sent[0]["html"]
    assert _flags(seen, "sent")[0]["token"] == ""


@pytest.mark.parametrize(
    "url", ["http://t.example.org", "https://t.example.org/o?x=1", "javascript:x"]
)
def test_a_track_url_that_isnt_plain_https_turns_send_off(env, url):
    env["cfg"]["BD_TRACK_BASE_URL"] = url
    with _bridge(_card()):
        cfg = _client().get("/api/bizdev/send-config").json()
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body())
    assert not cfg["enabled"] and cfg["missing"] == ["BD_TRACK_BASE_URL"]
    assert resp.status_code == 503 and env["fe"].sent == []


# -- Part C: the line's screen, templates, draft_edited ---------------------------

SCREEN = {
    "patterns": [
        {"regex": r"(?i)\btrusted by\b", "reason": "reference claim (rule 1)"},
        {"regex": r"(?i)no thanks", "reason": "never matches the body here"},
    ],
    "footer": FOOTER,
}


def test_a_forbidden_pattern_refuses_with_its_reason_and_sends_nothing(env):
    line = {"screen": SCREEN}
    with _bridge(_card(), line=line):
        resp = _client().post(
            "/api/bizdev/prospects/42/send",
            json=_body(body="Hello,\n\nTrusted by many." + FOOTER),
        )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Withheld by the screen: reference claim (rule 1)"
    assert env["fe"].sent == []


@pytest.mark.parametrize(
    "over,status",
    [
        ({"body": "Hello." + FOOTER}, 200),  # the footer says "no thanks"
        ({"subject": "Trusted by schools"}, 422),
    ],
)
def test_the_screen_reads_the_subject_too_but_never_the_footer(env, over, status):
    with _bridge(_card(), line={"screen": SCREEN}):
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body(**over))
    assert resp.status_code == status, resp.text


def test_a_pattern_that_doesnt_compile_refuses_the_send(env):
    line = {"screen": {"patterns": [{"regex": "(", "reason": "x"}], "footer": FOOTER}}
    with _bridge(_card(), line=line):
        resp = _client().post("/api/bizdev/prospects/42/send", json=_body())
    assert resp.status_code == 503 and env["fe"].sent == []


def _templates(**over):
    return [
        {"id": 7, "name": "Short", "touch": 1, "archived_at": None, **over},
        {"id": 8, "name": "Old", "touch": 1, "archived_at": "2026-10-19T00:00:00Z"},
    ]


@pytest.mark.parametrize(
    "source,status", [("template:7", 200), ("template:8", 422), ("template:9", 422)]
)
def test_a_template_source_must_be_a_current_template(env, source, status):
    line = {"screen": SCREEN, "templates": _templates()}
    with _bridge(_card(), line=line):
        resp = _client().post(
            "/api/bizdev/prospects/42/send", json=_body(draft_source=source)
        )
    assert resp.status_code == status, resp.text
    assert len(env["fe"].sent) == (1 if status == 200 else 0)


def test_draft_edited_travels_in_the_flags_meta(env):
    seen: list = []
    with _bridge(_card(), seen=seen):
        resp = _client().post(
            "/api/bizdev/prospects/42/send", json=_body(draft_edited=14)
        )
    assert resp.status_code == 200
    assert _flags(seen, "sent")[0]["meta"] == {"draft_edited": 14}


@pytest.mark.parametrize("value", [-1, True, "3", 1.5])
def test_a_bad_draft_edited_is_400(env, value):
    with _bridge(_card()):
        resp = _client().post(
            "/api/bizdev/prospects/42/send", json=_body(draft_edited=value)
        )
    assert resp.status_code == 400 and env["fe"].sent == []


def _template(**over) -> dict:
    return {
        "line": "sample",
        "name": "Short intro",
        "touch": 1,
        "subject": "A note for {{institution}}",
        "body": "Hi {{first_name}},\n\nA line.\n\n{{sender_name}}",
        **over,
    }


def test_a_template_save_posts_the_checked_body_to_the_bridge(env):
    seen: list = []
    with _bridge(_card(), seen=seen):
        resp = _client().post(
            "/api/bizdev/templates",
            json=_template(name=" Short\nintro ", default_for_touch=1),
        )
    assert resp.status_code == 202, resp.text
    (req,) = [r for r in seen if r.url.path == "/bd/templates"]
    assert json.loads(req.content) == {
        "line": "sample",
        "touch": 1,
        "name": "Short intro",
        "subject": "A note for {{institution}}",
        "body": "Hi {{first_name}},\n\nA line.\n\n{{sender_name}}",
        "default_for_touch": 1,
    }


@pytest.mark.parametrize(
    "over,status",
    [
        ({"touch": 4}, 400),
        ({"touch": "1"}, 400),
        ({"line": "../x"}, 400),
        ({"name": "  "}, 422),
        ({"name": "x" * 81}, 422),
        ({"body": "x" * 6001}, 422),
        ({"default_for_touch": 2}, 422),  # touch 1 template
        ({"body": "Hi {{nickname}}"}, 422),
        ({"subject": "Re: {{first_subject}}", "default_for_touch": 1}, 422),
        ({"id": 0}, 400),
    ],
)
def test_a_bad_template_is_refused_before_the_bridge(env, over, status):
    seen: list = []
    with _bridge(_card(), seen=seen):
        resp = _client().post("/api/bizdev/templates", json=_template(**over))
    assert resp.status_code == status, resp.text
    assert not [r for r in seen if r.url.path.startswith("/bd/")]


def test_an_any_touch_template_may_default_for_any_touch(env):
    with _bridge(_card()):
        resp = _client().post(
            "/api/bizdev/templates",
            json=_template(touch="any", default_for_touch=3),
        )
    assert resp.status_code == 202


def test_archive_posts_to_the_bridge_and_templates_are_local_only(env):
    seen: list = []
    with _bridge(_card(), seen=seen):
        assert _client().post("/api/bizdev/templates/7/archive").status_code == 202
        assert _client().post("/api/bizdev/templates/x/archive").status_code == 400
        remote = _client("192.168.1.20")
        assert remote.post("/api/bizdev/templates", json=_template()).status_code == 403
        assert remote.post("/api/bizdev/templates/7/archive").status_code == 403
    assert [r.url.path for r in seen] == ["/bd/templates/7/archive"]


# -- A2: several recipients on one card (contract v0.10.7) ----------------------

B = "b.person@example.edu"


def _sent(n, to, status="sent", fe_id="fe9", message_id=None) -> dict:
    t = {"n": n, "sent_at": f"2026-10-2{n}T10:00:00Z", "fe_id": fe_id}
    t.update(fe_status=status, to_email=to)
    if message_id:
        t["message_id"] = message_id
    return t


def _post(card, **over):
    with _bridge(card):
        return _client().post("/api/bizdev/prospects/42/send", json=_body(**over))


def test_touch_numbers_count_per_recipient(env):
    card = _card(stage="sent", touches=[_sent(1, TO)])
    assert bs.next_touch(card, TO) == 2
    assert bs.next_touch(card, B.upper()) == 1
    assert _post(card, to_email=B, touch=1).status_code == 200
    assert _post(card, to_email=TO, touch=1).status_code == 409


def test_a_bare_touch_counts_for_the_first_recipient(env):
    # An old stage move has no to_email: it is the first recipient's.
    card = _card(stage="sent", touches=[{"n": 1, "sent_at": "x"}])
    assert bs.next_touch(card, TO) == 2
    assert bs.next_touch(card, B) == 1


def test_a_rejected_touch_is_replaced_for_that_pair_only(env):
    card = _card(
        stage="sent", touches=[_sent(1, TO, "rejected"), _sent(1, B, "sent", "fe8")]
    )
    assert bs.next_touch(card, TO) == 1
    assert bs.next_touch(card, B) == 2
    assert _post(card, to_email=TO, touch=1).status_code == 200


def test_a_hard_bounced_contact_is_refused(env):
    card = _card(
        contacts=[
            {"name": "A Person", "email": TO, "bounce_hard_at": "2026-10-21T00:00:00Z"},
            {"name": "B Person", "email": B},
        ]
    )
    resp = _post(card, to_email=TO)
    assert resp.status_code == 422 and "hard-bounced" in resp.json()["detail"]
    assert env["fe"].sent == []


def test_a_fourth_recipient_is_refused(env):
    others = ["c@example.edu", "d@example.edu", "e@example.edu"]
    card = _card(
        stage="sent",
        contacts=[{"name": "X", "email": a} for a in [*others, TO]],
        touches=[_sent(1, a, fe_id=f"fe{i}") for i, a in enumerate(others)],
    )
    resp = _post(card, to_email=TO)
    assert resp.status_code == 409 and "3 recipients" in resp.json()["detail"]
    assert _post(card, to_email=others[0], touch=2).status_code == 200


def test_the_log_blocks_a_repeat_per_address_and_never_stores_one(env):
    card = _card()
    assert _post(card, to_email=TO).status_code == 200
    # Hermes hasn't applied the flag yet: the log alone holds the touch.
    assert _post(card, to_email=TO).status_code == 409
    assert _post(card, to_email=B).status_code == 200
    raw = bs._log_path().read_text(encoding="utf-8")
    assert TO not in raw and B not in raw
    keys = [s["to_key"] for s in bs.load_log()]
    assert keys == [bs.to_key(TO), bs.to_key(B.upper())]


def test_a_log_entry_from_before_v0107_counts_for_the_first_recipient(env):
    bs.save_log(
        [
            {
                "prospect_id": 42,
                "touch": 1,
                "fe_id": "fe0",
                "message_id": "<m>",
                "fe_status": "sent",
                "sent_at": bs._iso(bs._now()),
                "flag": None,
            }
        ]
    )
    card = _card(stage="sent", touches=[_sent(1, TO, fe_id="fe0")])
    assert _post(card, to_email=B).status_code == 200
    assert _post(card, to_email=TO, touch=1).status_code == 409


def test_a_follow_up_threads_on_its_own_recipients_touch_one(env):
    a_first, b_first = (
        "<bd-42-1-aaaaaaaa@example.org>",
        "<bd-42-1-bbbbbbbb@example.org>",
    )
    card = _card(
        stage="sent",
        touches=[
            _sent(1, TO, fe_id="fe1", message_id=a_first),
            _sent(1, B, fe_id="fe2", message_id=b_first),
        ],
    )
    assert _post(card, to_email=B, touch=2).status_code == 200
    mail = env["fe"].sent[0]
    assert mail["to"] == B and mail["inReplyTo"] == b_first
    assert mail["messageId"].startswith("<bd-42-2-")


def test_the_status_poll_keys_by_fe_id_with_two_recipients(env):
    card = _card()
    assert _post(card, to_email=TO).status_code == 200
    log = bs.load_log()
    log.append({**log[0], "fe_id": "fe0002", "to_key": bs.to_key(B)})
    bs.save_log(log)
    env["fe"].st = "sent"
    seen: list[httpx.Request] = []
    with _bridge(card, seen=seen):
        asyncio.run(bs.poll_once(env["fe"]))
    bodies = [json.loads(r.content) for r in seen if r.url.path.endswith("/status")]
    assert sorted(b["fe_id"] for b in bodies) == ["fe0001", "fe0002"]
    assert all(b["fe_status"] == "sent" and b["touch"] == 1 for b in bodies)


# -- 2026-11-03 follow-up: a timeout never sends twice ---------------------------
# The real client over a mocked Forward Email (httpx.MockTransport); the bridge
# shares the same transport, told apart by host.

FE_HOST = "api.forwardemail.net"
MID = "<bd-42-1-abcd1234@example.org>"


class MockFE:
    """Forward Email for the real client: records every call."""

    def __init__(self):
        self.limit = "ok"  # ok | timeout
        self.post = "ok"  # ok | timeout | connect | 503 | noid | garbage
        self.rows: list = []  # the `GET /v1/emails` listing, newest first
        self.list_fail = False
        self.calls: list[httpx.Request] = []

    def count(self, method, path):
        return sum(1 for r in self.calls if r.method == method and r.url.path == path)

    def __call__(self, req: httpx.Request):
        self.calls.append(req)
        path = req.url.path
        if path == "/v1/emails/limit":
            if self.limit == "timeout":
                raise httpx.ReadTimeout("slow", request=req)
            return httpx.Response(200, json={"count": 3, "limit": 300})
        if req.method == "POST" and path == "/v1/emails":
            if self.post == "timeout":
                raise httpx.ReadTimeout("slow", request=req)
            if self.post == "connect":
                raise httpx.ConnectError("refused", request=req)
            if self.post == "503":
                return httpx.Response(503, json={"message": "busy"})
            if self.post == "noid":
                return httpx.Response(200, json={"status": "queued"})
            if self.post == "garbage":
                return httpx.Response(200, content=b"<html>oops</html>")
            return httpx.Response(200, json={"id": "fe0001", "status": "queued"})
        if req.method == "GET" and path == "/v1/emails":
            if self.list_fail:
                return httpx.Response(503, json={"message": "busy"})
            page = int(req.url.params.get("page", "1"))
            size = int(req.url.params.get("limit", "50"))
            return httpx.Response(200, json=self.rows[(page - 1) * size : page * size])
        return httpx.Response(404)


@pytest.fixture
def mfe(env, monkeypatch):
    fe = MockFE()
    monkeypatch.setattr(bs, "_client", lambda c: ForwardEmail("tok-secret"))
    return fe


def _wire(card, fe, seen=None, flag_status=202):
    def handler(req: httpx.Request):
        if req.url.host == FE_HOST:
            return fe(req)
        if seen is not None:
            seen.append(req)
        if req.method == "GET" and req.url.path == "/panels/bd_pipeline":
            return httpx.Response(200, json=_pipeline(card))
        if req.method == "POST" and req.url.path.startswith("/bd/"):
            return httpx.Response(flag_status, json={"queued": True})
        return httpx.Response(404)

    real = httpx.AsyncClient

    def fake(*a, **kw):
        kw["transport"] = httpx.MockTransport(handler)
        return real(*a, **kw)

    return patch.object(bs.httpx, "AsyncClient", side_effect=fake)


def _send(card, fe, seen=None, **over):
    with _wire(card, fe, seen):
        return _client().post("/api/bizdev/prospects/42/send", json=_body(**over))


def _row(message_id, *, minutes_ago=0, status="queued", fe_id="fe7"):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return {
        "id": fe_id,
        "messageId": message_id,
        "status": status,
        "created_at": t.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    }


def _unconfirmed(*, minutes_ago=0, message_id=MID):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    entry = {
        "prospect_id": 42,
        "touch": 1,
        "to_key": bs.to_key(TO),
        "fe_id": None,
        "message_id": message_id,
        "fe_status": "unconfirmed",
        "fe_raw": None,
        "sent_at": bs._iso(t),
        "flag": {"touch": 1, "fe_id": None, "message_id": message_id, "to_email": TO},
    }
    bs.save_log([entry])
    return entry


def _polls(fe, now, *minutes):
    for m in minutes:
        with _wire(_card(), fe):
            asyncio.run(bs.poll_once(now=now + timedelta(minutes=m)))


def test_a_post_timeout_is_never_retried_and_is_held_unconfirmed(mfe):
    mfe.post = "timeout"
    seen: list = []
    resp = _send(_card(), mfe, seen)
    # Test 1: exactly one POST /v1/emails.
    assert mfe.count("POST", "/v1/emails") == 1
    # Test 3: 202, logged unconfirmed, its flag kept and not posted.
    assert resp.status_code == 202, resp.text
    out = resp.json()
    assert out["fe_status"] == "unconfirmed" and out["fe_id"] is None
    assert out["message_id"].startswith("<bd-42-1-")
    assert _flags(seen, "sent") == []
    (entry,) = bs.load_log()
    assert entry["fe_status"] == "unconfirmed" and entry["fe_id"] is None
    assert entry["message_id"] == out["message_id"]
    assert entry["to_key"] == bs.to_key(TO)
    assert entry["flag"]["fe_id"] is None and entry["flag"]["to_email"] == TO
    # The same touch to the same address is refused while it is checked.
    again = _send(_card(), mfe)
    assert again.status_code == 409
    assert again.json()["detail"] == (
        "Touch 1 to this address is being checked with Forward Email"
    )
    assert mfe.count("POST", "/v1/emails") == 1
    # The poll never posts the kept flag while the send is unconfirmed.
    mfe.list_fail = True
    seen.clear()
    with _wire(_card(), mfe, seen):
        asyncio.run(bs.poll_once())
    assert _flags(seen, "sent") == [] and mfe.count("POST", "/v1/emails") == 1


@pytest.mark.parametrize("mode", ["503", "connect"])
def test_a_post_5xx_or_refused_connection_is_502_once_and_records_nothing(mfe, mode):
    mfe.post = mode
    resp = _send(_card(), mfe)
    assert resp.status_code == 502
    assert mfe.count("POST", "/v1/emails") == 1 and bs.load_log() == []
    if mode == "connect":
        assert resp.json()["detail"] == "Forward Email unreachable"


def test_a_limit_timeout_is_502_logs_nothing_and_the_touch_can_go_right_after(mfe):
    mfe.limit = "timeout"
    resp = _send(_card(), mfe)
    assert resp.status_code == 502
    assert resp.json()["detail"] == bs.SLOW and "nothing was sent" in bs.SLOW
    assert mfe.count("GET", "/v1/emails/limit") == 2  # a read retries once
    assert mfe.count("POST", "/v1/emails") == 0 and bs.load_log() == []
    mfe.limit = "ok"
    assert _send(_card(), mfe).status_code == 200
    assert mfe.count("POST", "/v1/emails") == 1


def test_the_poll_finds_the_message_id_and_posts_the_flag_once(mfe):
    _unconfirmed(minutes_ago=2)
    # Forward Email's row has no angle brackets: matching ignores them.
    mfe.rows = [
        _row("<bd-42-2-ffff0000@example.org>", minutes_ago=1, fe_id="fe8"),
        _row(MID.strip("<>"), minutes_ago=2, status="sent"),
    ]
    seen: list = []
    with _wire(_card(), mfe, seen):
        asyncio.run(bs.poll_once())
        asyncio.run(bs.poll_once())
    (got,) = bs.load_log()
    assert got["fe_id"] == "fe7" and got["fe_status"] == "sent"
    assert got["flag"] is None
    (flag,) = _flags(seen, "sent")
    assert flag["fe_id"] == "fe7" and flag["message_id"] == MID
    assert _flags(seen, "status") == [{"touch": 1, "fe_id": "fe7", "fe_status": "sent"}]
    listing = next(r for r in mfe.calls if r.url.path == "/v1/emails")
    assert listing.url.params["domain"] == "example.org"
    assert listing.url.params["sort"] == "-created_at"
    assert mfe.count("POST", "/v1/emails") == 0


def test_a_found_send_still_pending_relays_no_status(mfe):
    _unconfirmed(minutes_ago=1)
    mfe.rows = [_row(MID, status="pending")]
    seen: list = []
    with _wire(_card(), mfe, seen):
        out = asyncio.run(bs.reconcile())
    assert out[0]["fe_status"] == "pending"
    assert len(_flags(seen, "sent")) == 1 and _flags(seen, "status") == []
    assert bs.load_log()[0]["fe_id"] == "fe7"


def test_not_found_after_15_min_and_two_polls_is_not_sent_and_the_touch_reopens(mfe):
    _unconfirmed(minutes_ago=20)
    mfe.rows = [_row("<other@example.org>", minutes_ago=60)]  # older than the send
    now = datetime.now(timezone.utc)
    _polls(mfe, now, 0, 0.5)  # the second is too soon to count
    assert bs.load_log()[0]["fe_status"] == "unconfirmed"
    _polls(mfe, now, 5)
    (got,) = bs.load_log()
    assert got["fe_status"] == "not_sent" and got["flag"] is None
    card = _card()
    assert bs.next_touch(card, TO) == 1
    assert bs.local_states()[0]["fe_status"] == "not_sent"
    resp = _send(card, mfe)
    assert resp.status_code == 200 and mfe.count("POST", "/v1/emails") == 1
    assert resp.json()["message_id"] != MID
    assert bs.local_states() == []  # sent again since


def test_never_not_sent_within_15_minutes(mfe):
    _unconfirmed(minutes_ago=5)
    _polls(mfe, datetime.now(timezone.utc), 0, 3, 6)
    assert bs.load_log()[0]["fe_status"] == "unconfirmed"


def test_a_failing_listing_leaves_it_unconfirmed(mfe):
    _unconfirmed(minutes_ago=30)
    mfe.list_fail = True
    _polls(mfe, datetime.now(timezone.utc), 0, 5, 10)
    (got,) = bs.load_log()
    assert got["fe_status"] == "unconfirmed" and got["flag"] is not None
    assert "misses" not in got


def test_paging_stops_at_the_time_bound_and_the_cap_is_inconclusive(mfe):
    from openjarvis.server.forwardemail import ForwardEmailInconclusive

    newer = [_row(f"<n{i}@example.org>", minutes_ago=1) for i in range(50)]
    mfe.rows = newer + [_row("<old@example.org>", minutes_ago=90)] + newer
    since = datetime.now(timezone.utc) - timedelta(minutes=30)
    client = ForwardEmail("tok-secret")
    with _wire(_card(), mfe):
        found = asyncio.run(client.find_by_message_id(MID, "example.org", since=since))
    assert found is None
    pages = [int(r.url.params["page"]) for r in mfe.calls if r.url.path == "/v1/emails"]
    assert pages == [1, 2]  # stopped at the older row
    mfe.calls.clear()
    mfe.rows = [_row(f"<n{i}@example.org>", minutes_ago=1) for i in range(200)]
    with _wire(_card(), mfe), pytest.raises(ForwardEmailInconclusive):
        asyncio.run(client.find_by_message_id(MID, "example.org", since=since))
    assert len([r for r in mfe.calls if r.url.path == "/v1/emails"]) == 3
    # An inconclusive lookup never counts toward not_sent.
    _unconfirmed(minutes_ago=30)
    _polls(mfe, datetime.now(timezone.utc), 0, 5, 10)
    assert bs.load_log()[0]["fe_status"] == "unconfirmed"


def test_check_is_local_only_settles_the_card_and_never_sends(mfe):
    _unconfirmed(minutes_ago=1)
    mfe.rows = [_row(MID, status="sent")]
    with _wire(_card(), mfe):
        assert (
            _client("10.0.0.5").post("/api/bizdev/prospects/42/check").status_code
            == 403
        )
        assert _client("10.0.0.5").get("/api/bizdev/send-status").status_code == 403
        status = _client().get("/api/bizdev/send-status").json()
        assert [s["fe_status"] for s in status["sends"]] == ["unconfirmed"]
        resp = _client().post("/api/bizdev/prospects/42/check")
    assert resp.status_code == 200, resp.text
    assert resp.json()["entries"] == [
        {"touch": 1, "fe_status": "sent", "to_key": bs.to_key(TO), "message_id": MID}
    ]
    assert mfe.count("POST", "/v1/emails") == 0
    with _wire(_card(), mfe):
        again = _client().post("/api/bizdev/prospects/42/check").json()
        assert again == {"entries": []}
        assert _client().get("/api/bizdev/send-status").json() == {"sends": []}


def test_a_log_from_before_this_change_behaves_as_before(mfe):
    bs.save_log(
        [
            {
                "prospect_id": 42,
                "touch": 1,
                "fe_id": "fe0",
                "message_id": "<m@example.org>",
                "fe_status": "queued",
                "sent_at": bs._iso(bs._now()),
                "flag": None,
            }
        ]
    )
    assert bs.local_states() == []
    with _wire(_card(), mfe):
        assert asyncio.run(bs.reconcile()) == []
    assert _send(_card(), mfe).status_code == 409  # the touch is still taken
    assert mfe.count("GET", "/v1/emails") == 0


@pytest.mark.parametrize("mode", ["noid", "garbage"])
def test_an_accepted_send_with_no_id_or_an_unreadable_reply_is_held_unconfirmed(
    mfe, mode
):
    mfe.post = mode
    seen: list = []
    resp = _send(_card(), mfe, seen)
    assert resp.status_code == 202, resp.text
    assert resp.json()["fe_status"] == "unconfirmed"
    assert mfe.count("POST", "/v1/emails") == 1 and _flags(seen, "sent") == []
    (entry,) = bs.load_log()
    assert entry["fe_status"] == "unconfirmed" and entry["flag"]["fe_id"] is None
    assert _send(_card(), mfe).status_code == 409
    # The lookup settles it like a timed-out send.
    mfe.rows = [_row(entry["message_id"], status="queued")]
    with _wire(_card(), mfe, seen):
        asyncio.run(bs.reconcile())
    assert bs.load_log()[0]["fe_id"] == "fe7" and len(_flags(seen, "sent")) == 1
    assert mfe.count("POST", "/v1/emails") == 1
