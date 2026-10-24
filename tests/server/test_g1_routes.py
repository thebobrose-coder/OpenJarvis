"""Tests for the G1 mirror routes and SigV4 signer (hq 0020 D4).

Invented values only: this repo is public. The mirror and S3 are mocked with
httpx's MockTransport; nothing leaves the machine. The signer's vectors were
computed with the official AWS SDK signer (`@smithy/signature-v4`) on the
same inputs."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import g1_routes as g1
from openjarvis.server import sigv4
from openjarvis.server import waiting_routes as wr

KEY = "AKIDEXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
MIRROR = "https://abc123.lambda-url.us-east-2.on.aws"
STILL = "https://bucket.s3.amazonaws.com/still.jpg?X-Amz-Signature=sample-still"
CLIP = "https://bucket.s3.amazonaws.com/clip.mp4?X-Amz-Signature=sample-clip"


# -- the signer ----------------------------------------------------------------


@pytest.mark.parametrize(
    "method,url,service,region,date,headers,body,token,signature",
    [
        (
            "GET",
            "https://example.amazon.com/",
            "service",
            "us-east-1",
            "2015-08-30T12:36:00+00:00",
            None,
            b"",
            None,
            "7ab4567ae243ee168f6bf18206b2b40b61ce08277323168138fa113ed23c538e",
        ),
        (
            "GET",
            f"{MIRROR}/approvals",
            "lambda",
            "us-east-2",
            "2026-10-24T07:00:00+00:00",
            None,
            b"",
            None,
            "688f99d69f02ec8c8c5f7335bc87085bd0f7a8ae3438905ce46d4fd20d763dab",
        ),
        (
            "POST",
            f"{MIRROR}/approvals/abc-1",
            "lambda",
            "us-east-2",
            "2026-10-24T07:00:00+00:00",
            {"content-type": "application/json"},
            b'{"decision":"approve"}',
            "TOKEN123",
            "db19211b64024180fbfe2ccef23d50ad1a3cc13ec741f83bdc01dea5837ebb47",
        ),
    ],
)
def test_signature_matches_the_aws_sdk(
    method, url, service, region, date, headers, body, token, signature
):
    out = sigv4.sign(
        method,
        url,
        region=region,
        service=service,
        credentials=sigv4.Credentials(KEY, SECRET, token),
        body=body,
        headers=headers,
        now=datetime.fromisoformat(date),
    )
    assert out["Authorization"].endswith(f"Signature={signature}")
    assert out["X-Amz-Date"] == datetime.fromisoformat(date).strftime("%Y%m%dT%H%M%SZ")
    if token:
        assert out["X-Amz-Security-Token"] == token


def test_region_from_a_function_url():
    assert sigv4.lambda_url_region(MIRROR + "/") == "us-east-2"
    assert sigv4.lambda_url_region("https://example.com/") is None


def test_profile_from_the_credentials_file_then_config(tmp_path, monkeypatch):
    creds = tmp_path / "credentials"
    creds.write_text(
        f"[sample-g1]\naws_access_key_id = {KEY}\naws_secret_access_key = {SECRET}\n"
    )
    conf = tmp_path / "config"
    conf.write_text(
        "[profile other]\naws_access_key_id = AKIDOTHER\n"
        "aws_secret_access_key = s\naws_session_token = t\n"
        "[profile sso-only]\nsso_session = x\n"
    )
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(creds))
    monkeypatch.setenv("AWS_CONFIG_FILE", str(conf))
    found = sigv4.load_profile("sample-g1")
    assert found == sigv4.Credentials(KEY, SECRET, None)
    assert sigv4.load_profile("other") == sigv4.Credentials("AKIDOTHER", "s", "t")
    assert sigv4.load_profile("sso-only") is None
    assert sigv4.load_profile("missing") is None
    assert SECRET not in repr(found)


# -- a configured mirror -------------------------------------------------------


def _item(**over) -> dict:
    item = {
        "approvalId": "ap-1",
        "gate": "G1",
        "propertyId": "alpha",
        "contentType": "short",
        "executionName": "alpha-run-1",
        "createdAt": "2026-10-24T06:00:00Z",
        "expiresAt": "2026-10-25T06:00:00Z",
        "headline": "A sample headline",
        "caption": "A sample caption",
        "disclosures": ["A sample disclosure"],
        "escalation": None,
        "targets": ["instagram"],
        "motion": {"release": "instagram", "beat": "A sample beat"},
        "stillUrl": STILL,
        "clipUrl": CLIP,
        "decidable": True,
    }
    return {**item, **over}


@pytest.fixture
def mirror(tmp_path, monkeypatch):
    creds = tmp_path / "credentials"
    creds.write_text(
        f"[sample-g1]\naws_access_key_id = {KEY}\naws_secret_access_key = {SECRET}\n"
    )
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(creds))
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "none"))
    values = {"G1_MIRROR_URL": MIRROR + "/", "G1_AWS_PROFILE": "sample-g1"}
    monkeypatch.setattr(
        g1,
        "get_tool_credential",
        lambda tool, key: values.get(key) if tool == "g1" else None,
    )
    return values


def _patched(handler):
    real = httpx.AsyncClient
    seen: list[httpx.Request] = []

    def recording(req):
        seen.append(req)
        return handler(req)

    def fake(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(recording)
        return real(*args, **kwargs)

    return patch.object(g1.httpx, "AsyncClient", side_effect=fake), seen


def _client(host="127.0.0.1"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(g1.g1_router)
    return TestClient(app, client=(host, 50000))


def _listing(*items):
    def handler(req: httpx.Request):
        if req.url.host == "bucket.s3.amazonaws.com":
            body = b"sample-clip-bytes" if "clip" in req.url.path else b"\xff\xd8sample"
            kind = "video/mp4" if "clip" in req.url.path else "image/jpeg"
            return httpx.Response(200, content=body, headers={"content-type": kind})
        return httpx.Response(
            200, json={"generatedAt": "2026-10-24T06:30:00Z", "items": list(items)}
        )

    return handler


def test_no_config_means_404_and_no_g1_kind(monkeypatch):
    monkeypatch.setattr(g1, "get_tool_credential", lambda tool, key: None)
    assert _client().get("/api/g1/approvals").status_code == 404
    assert asyncio.run(g1.listing()) is None


def test_bad_config_is_a_plain_503(mirror):
    mirror["G1_MIRROR_URL"] = "https://example.com/"
    resp = _client().get("/api/g1/approvals")
    assert resp.status_code == 503 and "Function URL" in resp.json()["detail"]
    mirror["G1_MIRROR_URL"] = MIRROR
    mirror["G1_AWS_PROFILE"] = "missing"
    resp = _client().get("/api/g1/approvals")
    assert resp.status_code == 503 and "no access key" in resp.json()["detail"]


def test_listing_is_signed_and_never_carries_the_links(mirror):
    patcher, seen = _patched(_listing(_item()))
    with patcher:
        resp = _client().get("/api/g1/approvals")
    assert resp.status_code == 200
    req = seen[0]
    assert req.method == "GET" and str(req.url) == f"{MIRROR}/approvals"
    auth = req.headers["authorization"]
    assert auth.startswith(f"AWS4-HMAC-SHA256 Credential={KEY}/")
    assert "/us-east-2/lambda/aws4_request" in auth
    assert "x-amz-date" in req.headers
    body = resp.json()
    assert "X-Amz" not in resp.text and "stillUrl" not in resp.text
    assert body["items"][0]["hasStill"] is True and body["items"][0]["hasClip"] is True
    assert body["items"][0]["headline"] == "A sample headline"


def test_every_route_refuses_other_hosts(mirror):
    client = _client("10.0.0.5")
    assert client.get("/api/g1/approvals").status_code == 403
    assert client.get("/api/g1/approvals/ap-1/media/still").status_code == 403
    assert (
        client.post("/api/g1/approvals/ap-1", json={"decision": "approve"}).status_code
        == 403
    )


def test_media_streams_a_fresh_link_without_storing_or_logging_it(mirror, caplog):
    patcher, seen = _patched(_listing(_item()))
    caplog.set_level(logging.DEBUG)
    with patcher:
        resp = _client().get("/api/g1/approvals/ap-1/media/clip")
    assert resp.status_code == 200
    assert resp.content == b"sample-clip-bytes"
    assert resp.headers["content-type"] == "video/mp4"
    assert resp.headers["cache-control"] == "no-store"
    assert [r.url.host for r in seen] == [
        "abc123.lambda-url.us-east-2.on.aws",
        "bucket.s3.amazonaws.com",
    ]
    assert "X-Amz-Signature" not in caplog.text
    assert not hasattr(g1, "_cache")


@pytest.mark.parametrize(
    "path,status",
    [
        ("/api/g1/approvals/ap-9/media/still", 404),
        ("/api/g1/approvals/ap-1/media/thumbnail", 400),
        ("/api/g1/approvals/ap%2F..%2Fx/media/still", 400),
    ],
)
def test_media_refusals(mirror, path, status):
    patcher, _ = _patched(_listing(_item()))
    with patcher:
        assert _client().get(path).status_code in (status, 404)


def test_a_row_without_a_still_has_none(mirror):
    patcher, _ = _patched(_listing(_item(stillUrl=None)))
    with patcher:
        resp = _client().get("/api/g1/approvals/ap-1/media/still")
    assert resp.status_code == 404


# -- decisions -----------------------------------------------------------------


def _answer(status, body):
    return lambda req: httpx.Response(status, json=body)


def test_approve_is_signed_and_passes_through(mirror):
    patcher, seen = _patched(_answer(200, {"status": "APPROVED"}))
    with patcher:
        resp = _client().post(
            "/api/g1/approvals/ap-1", json={"decision": "approve", "note": " ok "}
        )
    assert resp.status_code == 200 and resp.json() == {"status": "APPROVED"}
    req = seen[0]
    assert req.method == "POST" and str(req.url) == f"{MIRROR}/approvals/ap-1"
    assert json.loads(req.content) == {"decision": "approve", "note": "ok"}
    assert "content-type;host;x-amz-date" in req.headers["authorization"]


@pytest.mark.parametrize(
    "status,body",
    [
        (409, {"status": "APPROVED"}),
        (409, {"status": "EXPIRED"}),
        (403, {"error": "g2-decide-in-telegram"}),
        (404, {"error": "not-found"}),
        (400, {"error": "invalid-note"}),
    ],
)
def test_mirror_answers_pass_through(mirror, status, body):
    patcher, _ = _patched(_answer(status, body))
    with patcher:
        resp = _client().post("/api/g1/approvals/ap-1", json={"decision": "reject"})
    assert resp.status_code == status and resp.json() == body


def test_a_mirror_failure_is_502(mirror):
    patcher, _ = _patched(_answer(500, {"message": "Internal Server Error"}))
    with patcher:
        resp = _client().post("/api/g1/approvals/ap-1", json={"decision": "reject"})
    assert resp.status_code == 502


@pytest.mark.parametrize(
    "body",
    [{"decision": "publish"}, {"decision": "approve", "note": "x" * 501}],
)
def test_bad_bodies_never_reach_the_mirror(mirror, body):
    patcher, seen = _patched(_answer(200, {"status": "APPROVED"}))
    with patcher:
        resp = _client().post("/api/g1/approvals/ap-1", json=body)
    assert resp.status_code == 400
    assert seen == []


def test_unreachable_mirror_hides_the_url(mirror):
    def down(req):
        raise httpx.ConnectError("refused", request=req)

    patcher, _ = _patched(down)
    with patcher:
        resp = _client().get("/api/g1/approvals")
    assert resp.status_code == 503
    assert "lambda-url" not in resp.text


# -- "Waiting on you" ----------------------------------------------------------


def test_g1_rows_join_the_waiting_list_without_links(mirror, monkeypatch):
    async def none():
        return None, "off"

    monkeypatch.setattr(wr, "_hermes", none)
    monkeypatch.setattr(wr, "_trading", none)
    monkeypatch.setattr(wr, "_data_dir", lambda: None)
    episode = _item(
        approvalId="ap-2", contentType="episode", headline="SAMPLE EPISODE", motion=None
    )
    flagged = _item(approvalId="ap-3", gate="G2", decidable=False)
    patcher, _ = _patched(_listing(_item(), episode, flagged))
    with patcher:
        out = asyncio.run(wr.build_waiting())
    rows = [i for i in out["items"] if i["kind"] == "g1"]
    assert out["counts"]["g1"] == 3 and out["counts"]["total"] == 3
    assert [r["opens"] for r in rows] == ["g1", "g1", "g1"]
    assert rows[1]["title"] == "Episode: SAMPLE EPISODE"
    assert rows[2]["detail"].startswith("G2") and rows[2]["priority"] is None
    assert rows[0]["due"] == "2026-10-25T06:00:00Z" and rows[0]["link"] is None
    assert "X-Amz" not in json.dumps(out)
    assert out["sources"]["g1_mirror"]["generated_at"] == "2026-10-24T06:30:00Z"


def test_waiting_without_g1_config_has_no_g1_source(monkeypatch):
    async def none():
        return None, "off"

    monkeypatch.setattr(wr, "_hermes", none)
    monkeypatch.setattr(wr, "_trading", none)
    monkeypatch.setattr(wr, "_data_dir", lambda: None)
    monkeypatch.setattr(g1, "get_tool_credential", lambda tool, key: None)
    out = asyncio.run(wr.build_waiting())
    assert out["counts"]["g1"] == 0 and "g1_mirror" not in out["sources"]


def test_a_failing_mirror_never_fails_the_list(mirror, monkeypatch):
    async def none():
        return None, "off"

    monkeypatch.setattr(wr, "_hermes", none)
    monkeypatch.setattr(wr, "_trading", none)
    monkeypatch.setattr(wr, "_data_dir", lambda: None)
    patcher, _ = _patched(_answer(403, {"message": "Forbidden"}))
    with patcher:
        out = asyncio.run(wr.build_waiting())
    assert out["counts"]["g1"] == 0
    assert out["sources"]["g1_mirror"]["error"] == "G1 mirror answered 403"
