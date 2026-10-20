"""Business Development Send (hq decision 0018, contract v0.10 BD, Part A).

The operator clicks Send on a prospect; this module renders the mail, sends
it through Forward Email (`forwardemail.py`), and records the touch with the
bridge flag `POST /bd/prospects/<id>/sent`. A background poll relays each
mail's delivery status to Hermes as `POST /bd/prospects/<id>/status` (D2:
Hermes holds no Forward Email token).

Invariants (0018): Send only on a click and only from this machine; a second
send of a touch is refused unless the earlier one was `rejected`; a failed
call never records a send or moves a stage; every mail carries the footer
with the machine-local postal address and the reply-"unsubscribe" line. The
sender identity and the key file are local config (`[bizdev]` in
credentials.toml); with the key file unset the page behaves as before.
List-Unsubscribe is off unless `BD_LIST_UNSUBSCRIBE` is set: Forward Email
treats a mail carrying it as a newsletter and defers it (421, "Newsletter
usage is not yet approved") until the account is approved for that (0018
Phase 0); the footer's reply-"unsubscribe" line is the opt-out.

A small send log (`<config dir>/bizdev/sends.json`, never in the repo) keeps
each send's ids and status for the poll and for the duplicate check while
Hermes has not yet applied the flag. A flag the bridge did not accept is
kept there with its body and retried by the poll, then the body is dropped.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException

from openjarvis.core.credentials import get_tool_credential
from openjarvis.server.forwardemail import ForwardEmail, ForwardEmailError, read_token

logger = logging.getLogger(__name__)

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip(
    "/"
)
_TIMEOUT_S = 10.0

TOOL = "bizdev"
KEY_FILE = "FORWARDEMAIL_API_KEY_FILE"
CONFIG_KEYS = (
    "BD_SENDER_NAME",
    "BD_SENDER_ADDRESS",
    "BD_SENDER_ORG",
    "BD_REPLY_TO",
    "BD_POSTAL_ADDRESS",
    "BD_TRACK_BASE_URL",
    "BD_LIST_UNSUBSCRIBE",
)

# Contract v0.10 `fe_status`: pending | queued | deferred | rejected | sent.
TRANSIENT = frozenset({"pending", "queued", "deferred"})
# Forward Email's delivered value, as 0018's Phase 0 read it back. Any value
# outside the contract's set is kept raw in the send log (`fe_raw`) and never
# relayed.
DELIVERED = frozenset({"sent"})
_ON = frozenset({"1", "true", "yes", "on"})
RETENTION = timedelta(days=7)  # Forward Email keeps a mail 7 days
POLL_S = 300

_EMAIL = re.compile(r"^[^@\s<>,;\"]+@[^@\s<>,;\"]+\.[^@\s<>,;\"]+$")
_MERGE = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")
_SOURCE = re.compile(r"^(hermes|template:[A-Za-z0-9_-]{1,64})$")
_MSGID = re.compile(r"^<[^<>\s]{3,250}>$")
_SUBJECT_MAX = 300
_BODY_MAX = 10_000
_NAME_MAX = 100
REQUEST_MAX = 16 * 1024

_lock = asyncio.Lock()


# -- config ---------------------------------------------------------------


def config() -> dict[str, str]:
    values = {k: (get_tool_credential(TOOL, k) or "").strip() for k in CONFIG_KEYS}
    values[KEY_FILE] = (get_tool_credential(TOOL, KEY_FILE) or "").strip()
    return values


def missing(cfg: dict[str, str]) -> list[str]:
    """Keys Send needs that are unset (names only, never values)."""
    need = [KEY_FILE, "BD_SENDER_NAME", "BD_SENDER_ADDRESS", "BD_POSTAL_ADDRESS"]
    out = [k for k in need if not cfg.get(k)]
    if cfg.get(KEY_FILE) and not Path(cfg[KEY_FILE]).expanduser().is_file():
        out.append(KEY_FILE)
    if cfg.get("BD_SENDER_ADDRESS") and not _EMAIL.match(cfg["BD_SENDER_ADDRESS"]):
        out.append("BD_SENDER_ADDRESS")
    return sorted(set(out))


def public_config() -> dict[str, Any]:
    """What the page needs to show Send: never the key or its path."""
    cfg = config()
    gaps = missing(cfg)
    return {
        "enabled": not gaps,
        "sender_name": cfg["BD_SENDER_NAME"] or None,
        "sender_address": cfg["BD_SENDER_ADDRESS"] or None,
        "reply_to": cfg["BD_REPLY_TO"] or cfg["BD_SENDER_ADDRESS"] or None,
        # Only the key file being unset means "not configured"; any other gap
        # is a misconfiguration worth naming.
        "missing": gaps if cfg.get(KEY_FILE) else [],
    }


# -- the send log -------------------------------------------------------------


def _log_path() -> Path:
    from openjarvis.core.paths import get_config_dir

    return get_config_dir() / "bizdev" / "sends.json"


def load_log() -> list[dict]:
    try:
        doc = json.loads(_log_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    sends = doc.get("sends") if isinstance(doc, dict) else None
    return [s for s in sends or [] if isinstance(s, dict)]


def save_log(sends: list[dict]) -> None:
    path = _log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"sends": sends}, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _age(s: dict, now: datetime) -> timedelta:
    try:
        t = datetime.fromisoformat(str(s.get("sent_at")).replace("Z", "+00:00"))
    except ValueError:
        return RETENTION * 2
    return now - (t if t.tzinfo else t.replace(tzinfo=timezone.utc))


def fe_error(rejected: Any) -> str | None:
    """The first line of the first rejection's message: why a mail was
    deferred or rejected, for the card (contract v0.10.1 `fe_error`)."""
    first = rejected[0] if isinstance(rejected, list) and rejected else None
    message = first.get("message") if isinstance(first, dict) else None
    lines = str(message or "").strip().splitlines()
    return lines[0].strip()[:300] if lines else None


def normalise(raw: Any) -> str | None:
    v = str(raw or "").strip().lower()
    if v in TRANSIENT or v == "rejected":
        return v
    if v in DELIVERED:
        return "sent"
    return None


# -- the card -------------------------------------------------------------------


def find_card(pipeline: dict, prospect_id: int) -> dict | None:
    for line in pipeline.get("lines") or []:
        for cards in (line.get("stages") or {}).values():
            for card in cards or []:
                if isinstance(card, dict) and card.get("id") == prospect_id:
                    return card
    return None


def next_touch(card: dict) -> int:
    """1 for a card never sent; the same touch again when its last send was
    rejected; otherwise the touch after the last."""
    touches = [t for t in card.get("touches") or [] if isinstance(t, dict)]
    if not touches:
        return 1
    last = max(touches, key=lambda t: int(t.get("n") or 0))
    n = int(last.get("n") or 0)
    return n if last.get("fe_status") == "rejected" else n + 1


def _touch_taken(card: dict, sends: list[dict], pid: int, touch: int) -> bool:
    for t in card.get("touches") or []:
        if isinstance(t, dict) and int(t.get("n") or 0) == touch:
            if t.get("fe_id") and t.get("fe_status") != "rejected":
                return True
    return any(
        s.get("prospect_id") == pid
        and s.get("touch") == touch
        and s.get("fe_status") != "rejected"
        for s in sends
    )


def _first_message_id(card: dict, sends: list[dict], pid: int) -> str | None:
    for t in card.get("touches") or []:
        if isinstance(t, dict) and int(t.get("n") or 0) == 1 and t.get("message_id"):
            return str(t["message_id"])
    for s in sends:
        if s.get("prospect_id") == pid and s.get("touch") == 1:
            return s.get("message_id")
    return None


# -- rendering -------------------------------------------------------------


def footer(cfg: dict[str, str]) -> str:
    who = " · ".join(v for v in (cfg["BD_SENDER_ORG"], cfg["BD_POSTAL_ADDRESS"]) if v)
    return (
        f"\n\n--\n{cfg['BD_SENDER_NAME']}\n{who}\n"
        'To stop these emails, reply "unsubscribe".'
    )


def to_html(text: str) -> str:
    paragraphs = re.split(r"\n\s*\n", text.strip())
    return "".join(
        "<p>" + html.escape(p).replace("\n", "<br>\n") + "</p>\n" for p in paragraphs
    )


def unresolved(*texts: str) -> list[str]:
    return sorted({m.group(1) or "?" for t in texts for m in _MERGE.finditer(t)})


def render(
    cfg: dict[str, str],
    *,
    prospect_id: int,
    touch: int,
    to_email: str,
    subject: str,
    body: str,
    from_name: str | None,
    reply_to: str | None,
    in_reply_to: str | None,
) -> dict:
    sender = cfg["BD_SENDER_ADDRESS"]
    domain = sender.rsplit("@", 1)[1]
    text = body.rstrip() + footer(cfg)
    message_id = f"<bd-{prospect_id}-{touch}-{secrets.token_hex(4)}@{domain}>"
    payload = {
        "from": f"{from_name or cfg['BD_SENDER_NAME']} <{sender}>",
        "to": to_email,
        "replyTo": reply_to or cfg["BD_REPLY_TO"] or sender,
        "subject": subject,
        "text": text,
        "html": to_html(text),
        "messageId": message_id,
    }
    if cfg.get("BD_LIST_UNSUBSCRIBE", "").lower() in _ON:
        payload["list"] = {
            "unsubscribe": {"url": f"mailto:{sender}?subject=unsubscribe"}
        }
    if touch > 1 and in_reply_to:
        payload["inReplyTo"] = in_reply_to
        payload["references"] = in_reply_to
    return payload


# -- validation ------------------------------------------------------------


def _text(body: dict, key: str, limit: int, *, required: bool) -> str | None:
    value = body.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise HTTPException(status_code=400, detail=f"Invalid {key}")
    if required and not value.strip():
        raise HTTPException(status_code=422, detail=f"Empty {key}")
    return value


def validate(body: dict) -> dict:
    to_email = _text(body, "to_email", 254, required=True).strip()
    if not _EMAIL.match(to_email):
        raise HTTPException(status_code=400, detail="Invalid to_email")
    touch = body.get("touch")
    if isinstance(touch, bool) or touch not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="touch must be 1, 2 or 3")
    from_name = _text(body, "from_name", _NAME_MAX, required=False)
    if from_name is not None:
        from_name = from_name.strip() or None
        if from_name and re.search(r'[\r\n<>"]', from_name):
            raise HTTPException(status_code=400, detail="Invalid from_name")
    reply_to = _text(body, "reply_to", 254, required=False)
    if reply_to is not None:
        reply_to = reply_to.strip() or None
        if reply_to and not _EMAIL.match(reply_to):
            raise HTTPException(status_code=400, detail="Invalid reply_to")
    source = body.get("draft_source", "hermes")
    if not isinstance(source, str) or not _SOURCE.match(source):
        raise HTTPException(status_code=400, detail="Invalid draft_source")
    in_reply_to = _text(body, "in_reply_to_message_id", 254, required=False)
    if in_reply_to is not None:
        in_reply_to = in_reply_to.strip() or None
        if in_reply_to and not _MSGID.match(in_reply_to):
            raise HTTPException(
                status_code=400, detail="Invalid in_reply_to_message_id"
            )
    return {
        "to_email": to_email,
        "subject": _text(body, "subject", _SUBJECT_MAX, required=True).strip(),
        "body": _text(body, "body", _BODY_MAX, required=True),
        "touch": touch,
        "from_name": from_name,
        "reply_to": reply_to,
        "draft_source": source,
        "in_reply_to": in_reply_to,
    }


def screen(req: dict) -> None:
    """Part A's screen: a non-empty body (validate) and no unresolved merge
    field. The line's published patterns arrive with Part C."""
    fields = unresolved(req["subject"], req["body"])
    if fields:
        names = ", ".join("{{" + f + "}}" for f in fields)
        raise HTTPException(status_code=422, detail=f"Unresolved merge field: {names}")


# -- bridge ---------------------------------------------------------------------


async def _pipeline() -> dict:
    """The current `bd_pipeline`, fresh: no send against a cached card, and no
    send when the bridge could not record it."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.get(f"{HERMES_BRIDGE_URL}/panels/bd_pipeline")
        resp.raise_for_status()
        data = resp.json()["data"]
        if not isinstance(data, dict):
            raise ValueError
        return data
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HTTPException(
            status_code=503, detail="Hermes bridge unavailable"
        ) from None


async def _post_flag(path: str, body: dict) -> bool:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.post(f"{HERMES_BRIDGE_URL}{path}", json=body)
        return 200 <= resp.status_code < 300
    except httpx.HTTPError:
        return False


def _client(cfg: dict[str, str]) -> ForwardEmail:
    return ForwardEmail(read_token(cfg[KEY_FILE]))


# -- send -----------------------------------------------------------------------


async def send(prospect_id: int, raw: dict) -> dict:
    cfg = config()
    if missing(cfg):
        raise HTTPException(status_code=503, detail="Send is not configured")
    req = validate(raw)
    screen(req)

    async with _lock:  # one send at a time: a double click can't send twice
        card = find_card(await _pipeline(), prospect_id)
        if card is None:
            raise HTTPException(status_code=404, detail="Prospect not in the pipeline")
        emails = {
            str(c.get("email")).strip().lower()
            for c in card.get("contacts") or []
            if isinstance(c, dict) and c.get("email")
        }
        if req["to_email"].lower() not in emails:
            raise HTTPException(
                status_code=422, detail="to_email is not a contact of this prospect"
            )
        sends = load_log()
        touch = req["touch"]
        if _touch_taken(card, sends, prospect_id, touch):
            raise HTTPException(
                status_code=409, detail=f"Touch {touch} was already sent"
            )
        expected = next_touch(card)
        if touch != expected:
            raise HTTPException(
                status_code=409, detail=f"The next touch is {expected}, not {touch}"
            )
        in_reply_to = req["in_reply_to"]
        if touch > 1 and not in_reply_to:
            in_reply_to = _first_message_id(card, sends, prospect_id)

        try:
            client = _client(cfg)
            lim = await client.limit()
            if lim["limit"] and lim["count"] >= lim["limit"]:
                raise HTTPException(
                    status_code=429,
                    detail="Forward Email's daily limit is reached "
                    f"({lim['count']} of {lim['limit']})",
                )
            payload = render(
                cfg,
                prospect_id=prospect_id,
                touch=touch,
                to_email=req["to_email"],
                subject=req["subject"],
                body=req["body"],
                from_name=req["from_name"],
                reply_to=req["reply_to"],
                in_reply_to=in_reply_to,
            )
            result = await client.send(payload)
        except ForwardEmailError as exc:
            raise HTTPException(status_code=502, detail=exc.message) from None
        if not result["id"]:
            raise HTTPException(status_code=502, detail="Forward Email returned no id")

        fe_status = normalise(result["status"]) or "pending"
        flag = {
            "touch": touch,
            "fe_id": result["id"],
            "message_id": payload["messageId"],
            "token": "",  # Part B: the open pixel's token
            "to_email": req["to_email"],
            "draft_source": req["draft_source"],
            "subject": req["subject"],
            "body": payload["text"],
            "from": payload["from"],
            "reply_to": payload["replyTo"],
        }
        entry = {
            "prospect_id": prospect_id,
            "touch": touch,
            "fe_id": result["id"],
            "message_id": payload["messageId"],
            "fe_status": fe_status,
            "fe_raw": result["status"],
            "sent_at": _iso(_now()),
            "flag": flag,
        }
        recorded = await _post_flag(f"/bd/prospects/{prospect_id}/sent", flag)
        if recorded:
            entry["flag"] = None  # Hermes has it; keep no prospect text here
        sends.append(entry)
        save_log(sends)
    return {
        "fe_id": result["id"],
        "message_id": payload["messageId"],
        "fe_status": fe_status,
        "recorded": recorded,
    }


# -- delivery-status poll (D2) ---------------------------------------------------


async def poll_once(
    client: ForwardEmail | None = None, now: datetime | None = None
) -> None:
    """Retry unrecorded flags; relay status changes for recent, unsettled sends;
    drop sends past Forward Email's retention once nothing is pending."""
    now = now or _now()
    async with _lock:
        sends = load_log()
        if not sends:
            return
        no_client = False
        for s in sends:
            pid = s.get("prospect_id")
            if s.get("flag") and await _post_flag(
                f"/bd/prospects/{pid}/sent", s["flag"]
            ):
                s["flag"] = None
            pending_status = s.get("status_flag")
            if pending_status and await _post_flag(
                f"/bd/prospects/{pid}/status", pending_status
            ):
                s["status_flag"] = None
            if s.get("fe_status") not in TRANSIENT or _age(s, now) > RETENTION:
                continue
            if client is None and not no_client:
                cfg = config()
                try:
                    client = None if missing(cfg) else _client(cfg)
                except ForwardEmailError:
                    client = None
                no_client = client is None
            if client is None:
                continue  # flags above still retry; status waits for the key
            try:
                st = await client.status(s["fe_id"])
            except ForwardEmailError as exc:
                logger.warning("Delivery status for a send failed: %s", exc.message)
                continue
            s["fe_raw"] = st["status"]
            fe_status = normalise(st["status"])
            if fe_status and fe_status != s.get("fe_status"):
                s["fe_status"] = fe_status
                body = {
                    "touch": s["touch"],
                    "fe_id": s["fe_id"],
                    "fe_status": fe_status,
                }
                error = fe_error(st.get("rejectedErrors"))
                if fe_status in ("deferred", "rejected") and error:
                    body["fe_error"] = error
                if not await _post_flag(f"/bd/prospects/{pid}/status", body):
                    s["status_flag"] = body
        kept = [
            s
            for s in sends
            if s.get("flag") or s.get("status_flag") or _age(s, now) <= RETENTION
        ]
        save_log(kept)


async def poll_loop() -> None:
    while True:
        try:
            await poll_once()
        except Exception:  # noqa: BLE001 -- the poll must outlive one bad cycle
            logger.warning("BD delivery-status poll failed", exc_info=True)
        await asyncio.sleep(POLL_S)
