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
    assert resp.status_code == 409 and "next touch is 1" in resp.json()["detail"]


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
