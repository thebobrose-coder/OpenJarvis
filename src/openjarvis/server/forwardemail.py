"""A thin client for Forward Email's outbound email API (hq decision 0018).

The Business Development page sends outreach on the operator's click through
`POST /v1/emails`, reads a mail's delivery status with `GET /v1/emails/:id`,
checks the daily cap with `GET /v1/emails/limit`, and settles a send that got
no answer by its Message-ID in `GET /v1/emails`. Auth is Basic with the API
token as the username and an empty password.

The token is read from the file named by `FORWARDEMAIL_API_KEY_FILE`
(credentials.toml, `[bizdev]`) on each call, by this server process only. It
is never logged, never returned, and never sent anywhere but the API; nor is
a payload (it carries a prospect's address and the mail's text) ever logged.

A send is never retried (2026-11-03 follow-up): a `POST` that timed out may
still have been queued, so it raises `ForwardEmailTimeout` and the caller
holds the mail as unconfirmed until its Message-ID settles it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

API_URL = "https://api.forwardemail.net/v1"
# Per call: a read gets one retry, a send none.
LIMIT_TIMEOUT_S = 20.0
STATUS_TIMEOUT_S = 20.0
LIST_TIMEOUT_S = 20.0
SEND_TIMEOUT_S = 45.0
# `GET /v1/emails` paging for the Message-ID lookup (the default sort is
# oldest first, so it asks for newest first).
LIST_PAGE_SIZE = 50
LIST_MAX_PAGES = 3


class ForwardEmailError(Exception):
    """A refused or failed call. `message` is safe to show: the API's own
    first line, never the payload or the token."""

    def __init__(self, status: int | None, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class ForwardEmailTimeout(ForwardEmailError):
    """No answer in time. For a `POST /v1/emails` the mail may still have been
    queued: the caller holds it as unconfirmed and never sends it again."""

    def __init__(self) -> None:
        super().__init__(None, "Forward Email didn't answer in time")


class ForwardEmailInconclusive(ForwardEmailError):
    """The Message-ID lookup used up its page cap before reaching the send's
    time: missing from those pages is no proof the mail never went out."""

    def __init__(self) -> None:
        super().__init__(None, "The lookup didn't reach the send's time")


def read_token(path: str | Path) -> str:
    try:
        token = Path(path).expanduser().read_text(encoding="utf-8-sig").strip()
    except OSError:
        raise ForwardEmailError(None, "API key file could not be read") from None
    if not token:
        raise ForwardEmailError(None, "API key file is empty")
    return token


def _first_line(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        text = (
            (body.get("message") or body.get("error")) if isinstance(body, dict) else ""
        )
    except ValueError:
        text = resp.text
    lines = str(text or "").strip().splitlines()
    return (lines[0].strip() if lines else f"HTTP {resp.status_code}")[:200]


def bare_message_id(value: Any) -> str:
    """A Message-ID without its angle brackets, for comparing."""
    return str(value or "").strip().strip("<>").strip()


def parse_time(value: Any) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


class ForwardEmail:
    def __init__(self, token: str, *, base_url: str = API_URL) -> None:
        self._auth = httpx.BasicAuth(token, "")
        self._base = base_url.rstrip("/")

    async def _call(
        self,
        method: str,
        path: str,
        json: Any = None,
        *,
        timeout: float,
        params: dict | None = None,
    ) -> Any:
        """One call. A `GET` retries once on a 5xx or a timeout. A `POST`
        never retries: one that timed out (or lost its connection after
        writing) may have been queued, so it raises `ForwardEmailTimeout`. A
        connection that never opened did not reach them: "unreachable"
        either way. No retry on a 4xx."""
        attempts = 2 if method == "GET" else 1
        last: ForwardEmailError | None = None
        for _attempt in range(attempts):
            try:
                async with httpx.AsyncClient(timeout=timeout, auth=self._auth) as c:
                    resp = await c.request(
                        method, f"{self._base}{path}", json=json, params=params
                    )
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
                # Nothing was written to them: nothing went out.
                raise ForwardEmailError(None, "Forward Email unreachable") from None
            except httpx.TimeoutException:
                last = ForwardEmailTimeout()
                continue
            except httpx.HTTPError:
                if method != "GET":
                    raise ForwardEmailTimeout() from None
                raise ForwardEmailError(None, "Forward Email unreachable") from None
            if resp.status_code >= 500:
                last = ForwardEmailError(resp.status_code, _first_line(resp))
                continue
            if resp.status_code >= 400:
                raise ForwardEmailError(resp.status_code, _first_line(resp))
            try:
                return resp.json()
            except ValueError:
                raise ForwardEmailError(resp.status_code, "Unreadable reply") from None
        assert last is not None
        raise last

    async def send(self, payload: dict) -> dict:
        """`{id, message_id, status}` for a queued mail."""
        body = await self._call("POST", "/emails", payload, timeout=SEND_TIMEOUT_S)
        body = body if isinstance(body, dict) else {}
        return {
            "id": str(body.get("id") or body.get("_id") or ""),
            "message_id": body.get("messageId") or body.get("message_id"),
            "status": body.get("status"),
        }

    async def status(self, email_id: str) -> dict:
        body = await self._call("GET", f"/emails/{email_id}", timeout=STATUS_TIMEOUT_S)
        body = body if isinstance(body, dict) else {}
        return {
            "status": body.get("status"),
            "rejectedErrors": body.get("rejectedErrors") or [],
        }

    async def limit(self) -> dict:
        body = await self._call("GET", "/emails/limit", timeout=LIMIT_TIMEOUT_S)
        body = body if isinstance(body, dict) else {}
        return {
            "count": int(body.get("count") or 0),
            "limit": int(body.get("limit") or 0),
        }

    async def find_by_message_id(
        self, message_id: str, domain: str, *, since: datetime
    ) -> dict | None:
        """The `GET /v1/emails` row with this `messageId` (angle brackets
        ignored), read newest first, at most `LIST_MAX_PAGES` pages, stopping
        at a row created before `since`.

        None when the listing reached `since` (or its end) without it;
        `ForwardEmailInconclusive` when the page cap came first. Read only.
        """
        want = bare_message_id(message_id)
        for page in range(1, LIST_MAX_PAGES + 1):
            rows = await self._call(
                "GET",
                "/emails",
                timeout=LIST_TIMEOUT_S,
                params={
                    "domain": domain,
                    "sort": "-created_at",
                    "page": page,
                    "limit": LIST_PAGE_SIZE,
                },
            )
            if not isinstance(rows, list):
                raise ForwardEmailError(None, "Unreadable reply")
            for row in rows:
                if not isinstance(row, dict):
                    continue
                if bare_message_id(row.get("messageId")) == want:
                    return row
                created = parse_time(row.get("created_at"))
                if created is not None and created < since:
                    return None  # older than the send: it isn't further down
            if len(rows) < LIST_PAGE_SIZE:
                return None  # the end of the listing
        raise ForwardEmailInconclusive()
