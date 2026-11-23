"""FastAPI routes for the Outreach page (hq 0031 Part C, contract v1.31 §6.9).

The operator does the daily hand outreach on Instagram; this page brings the
target accounts: who to visit today, a link to each, something to say, and a
record of what was done. **Nothing here posts, likes, follows, messages or
logs in to Instagram, and no Instagram credential is read or held.** The
profile link opens in the operator's own browser, from the page.

- **The store** is two files under ``<workspace data>/social/``, and this
  module is their only writer: ``targets.json`` (rewritten through a temp file
  and one rename) and ``outreach-log.jsonl`` (one whole line per append).
  Hermes reads ``targets.json`` through a read-only mount.
- **Today's round** is picked by code on every read, never stored: the
  accounts already marked today, then active accounts least recently engaged
  first, with one from each tier that has any, up to five. A day is a Central
  calendar day.
- **Angles** come from the local model with the brand's kernel from Foundry's
  bundle, and each is screened by code against the bundle's compliance phrase
  list before it is shown. No kernel or no rules: no angles.
- **The feeds** ``ig_reach`` and ``ig_target_candidates`` pass through the
  panel proxy; a 404 is "not yet".

The brands come from local config (credentials.toml ``[desks]``
``OUTREACH_BRANDS``, comma-separated property ids). Every route answers only
requests from this machine.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from openjarvis.agents.hermes_digest import HERMES_TZ
from openjarvis.core.credentials import get_tool_credential
from openjarvis.server.hermes_panel import FeedProxy
from openjarvis.server.stack_routes import _local_only

outreach_router = APIRouter(
    prefix="/api/outreach", tags=["outreach"], dependencies=[Depends(_local_only)]
)

TOOL = "desks"
DATA_KEY = "WORKSPACE_DATA_DIR"
BRANDS_KEY = "OUTREACH_BRANDS"
FOLDER = "social"
TARGETS_FILE = "targets.json"
LOG_FILE = "outreach-log.jsonl"
VERSION = 1

FEEDS = frozenset({"ig_reach", "ig_target_candidates"})
ROUND_SIZE = 5  # 0031 D3
TIERS = ("peer", "large", "creator")
STATUSES = ("active", "paused", "dropped")
COLLAB = ("none", "asked", "agreed", "posted")
SOURCES = ("operator", "hermes")
CHECK_ITEMS = ("comments_answered", "reel_to_stories")
ROUND_ACTIONS = ("done", "skip", "undo")
LIMITS = {"niche": 80, "why": 280, "notes": 1000}
PASTE_MAX = 20_000
ADD_MAX = 200
ANGLE_MAX = 200
ABOUT_MAX = 500
LOG_TAIL = 40

_BRAND = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_HANDLE = re.compile(r"^[a-z0-9._]{1,30}$")
_IG_URL = re.compile(
    r"^(?:https?://)?(?:www\.|m\.)?instagram\.com/([^/?#\s]+)/?(?:[?#]\S*)?$", re.I
)
# Instagram paths that are not a profile.
_RESERVED = frozenset(
    {"p", "reel", "reels", "explore", "stories", "tv", "accounts", "direct", "about"}
)
_SPLIT = re.compile(r"[\s,;]+")

_lock = threading.Lock()
_feeds = FeedProxy("outreach", FEEDS)
_cache = _feeds.cache


class StoreError(Exception):
    """The store is there but not readable as the store. Never overwritten."""


# ---------- config, time ----------


def store_dir() -> Path | None:
    value = get_tool_credential(TOOL, DATA_KEY)
    return Path(value).expanduser() / FOLDER if value else None


def brand_ids() -> list[str]:
    raw = get_tool_credential(TOOL, BRANDS_KEY) or ""
    out: list[str] = []
    for part in str(raw).split(","):
        part = part.strip()
        if _BRAND.fullmatch(part) and part not in out:
            out.append(part)
    return out


def _iso(dt: datetime) -> str:
    return (
        dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def central_day(now: datetime | None = None) -> str:
    """The Central calendar day, the one Hermes's jobs and the contract use."""
    return (
        (now or datetime.now(timezone.utc)).astimezone(HERMES_TZ).strftime("%Y-%m-%d")
    )


def _day_of(iso: Any) -> str | None:
    try:
        at = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return central_day(at)


# ---------- handles ----------


def normalize_handle(text: str) -> str | None:
    """A handle or a profile URL as the store keeps it: lowercase, no ``@``.
    ``None`` for anything that is not one account (a post link, a word with
    other characters)."""
    token = (text or "").strip().strip("<>\"'()[]")
    if not token:
        return None
    m = _IG_URL.match(token)
    if m:
        token = m.group(1)
        if token.lower() in _RESERVED:
            return None
    elif "/" in token or ":" in token:
        return None
    token = token.lstrip("@").rstrip(".,").lower()
    return token if _HANDLE.fullmatch(token) else None


def parse_paste(text: str) -> tuple[list[str], list[str]]:
    """Handles (in order, once each) and the tokens that are not one."""
    handles: list[str] = []
    invalid: list[str] = []
    for token in _SPLIT.split(text or ""):
        if not token:
            continue
        handle = normalize_handle(token)
        if handle is None:
            if token[:60] not in invalid:
                invalid.append(token[:60])
        elif handle not in handles:
            handles.append(handle)
    return handles, invalid


def profile_url(handle: str) -> str:
    return f"https://www.instagram.com/{handle}/"


# ---------- the store ----------


def read_targets(root: Path) -> dict[str, Any]:
    """``{version: 1, brands: {<id>: {accounts, dismissed}}}``. A missing file
    is an empty store; a file that does not read as the store is an error."""
    path = root / TARGETS_FILE
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return {"version": VERSION, "brands": {}}
    except OSError as exc:
        raise StoreError(type(exc).__name__) from None
    try:
        doc = json.loads(raw)
    except ValueError:
        raise StoreError("targets.json is not JSON") from None
    if (
        not isinstance(doc, dict)
        or doc.get("version") != VERSION
        or not isinstance(doc.get("brands"), dict)
    ):
        raise StoreError("targets.json is not a version 1 store")
    for brand in doc["brands"].values():
        if (
            not isinstance(brand, dict)
            or not isinstance(brand.get("accounts"), list)
            or not isinstance(brand.get("dismissed"), list)
        ):
            raise StoreError("targets.json has a brand without accounts or dismissed")
    return doc


def write_targets(root: Path, doc: dict[str, Any]) -> None:
    """Atomic: a temp file beside it, then one rename. A reader that holds the
    file open for a moment (Windows) gets a few retries."""
    root.mkdir(parents=True, exist_ok=True)
    path = root / TARGETS_FILE
    tmp = root / f".{TARGETS_FILE}.{os.getpid()}.tmp"
    tmp.write_text(
        json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    try:
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        if tmp.exists():
            tmp.unlink()


def append_log(root: Path, line: dict[str, Any]) -> None:
    """One whole line in one write on a file opened for append."""
    root.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(line, ensure_ascii=False) + "\n").encode("utf-8")
    with open(root / LOG_FILE, "ab") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def read_log(root: Path) -> list[dict[str, Any]]:
    try:
        raw = (root / LOG_FILE).read_text(encoding="utf-8")
    except OSError:
        return []
    lines = []
    for text in raw.splitlines():
        try:
            doc = json.loads(text)
        except ValueError:
            continue
        if isinstance(doc, dict) and doc.get("kind") and doc.get("brand"):
            lines.append(doc)
    return lines


def _brand(doc: dict[str, Any], brand: str) -> dict[str, Any]:
    return doc["brands"].setdefault(brand, {"accounts": [], "dismissed": []})


def _account(doc: dict[str, Any], brand: str, handle: str) -> dict[str, Any] | None:
    for a in (doc["brands"].get(brand) or {}).get("accounts") or []:
        if isinstance(a, dict) and a.get("handle") == handle:
            return a
    return None


def new_account(handle: str, source: str, now: datetime, **fields: Any) -> dict:
    at = _iso(now)
    return {
        "handle": handle,
        "profile_url": profile_url(handle),
        "niche": "",
        "tier": "peer",
        "why": "",
        "source": source,
        "status": "active",
        "last_engaged_at": None,
        "collab_state": "none",
        "notes": "",
        "added_at": at,
        "updated_at": at,
        **fields,
    }


def add_accounts(
    root: Path, brand: str, text: str, now: datetime
) -> dict[str, list[str]]:
    """The operator's paste: every new handle becomes an active account; one
    already on the list (any status) is refused as a duplicate. Pasting a
    handle that was dismissed as a candidate adds it and lifts the dismissal."""
    handles, invalid = parse_paste(text)
    if len(handles) > ADD_MAX:
        raise HTTPException(
            status_code=400, detail=f"At most {ADD_MAX} accounts in one paste"
        )
    doc = read_targets(root)
    entry = _brand(doc, brand)
    known = {a.get("handle") for a in entry["accounts"] if isinstance(a, dict)}
    added, duplicates = [], []
    for handle in handles:
        if handle in known:
            duplicates.append(handle)
            continue
        entry["accounts"].append(new_account(handle, "operator", now))
        known.add(handle)
        added.append(handle)
    if added:
        entry["dismissed"] = [h for h in entry["dismissed"] if h not in added]
        write_targets(root, doc)
    return {"added": added, "duplicates": duplicates, "invalid": invalid}


def edit_account(
    root: Path, brand: str, handle: str, edits: dict[str, Any], now: datetime
) -> dict[str, Any]:
    doc = read_targets(root)
    account = _account(doc, brand, handle)
    if account is None:
        raise HTTPException(status_code=404, detail="No such account on this list")
    for key, value in edits.items():
        if key in LIMITS:
            if not isinstance(value, str) or len(value.strip()) > LIMITS[key]:
                raise HTTPException(
                    status_code=400,
                    detail=f"{key}: text of at most {LIMITS[key]} characters",
                )
            account[key] = value.strip()
        elif key == "tier" and value in TIERS:
            account[key] = value
        elif key == "status" and value in STATUSES:
            account[key] = value
        elif key == "collab_state" and value in COLLAB:
            account[key] = value
        else:
            raise HTTPException(status_code=400, detail=f"Invalid {key}")
    account["updated_at"] = _iso(now)
    write_targets(root, doc)
    return account


# ---------- the log, read ----------


def day_states(log: list[dict[str, Any]], brand: str) -> dict[tuple[str, str], dict]:
    """The last word on each account for each day: ``(handle, day)`` to its
    ``done`` or ``skip`` line. An ``undo`` takes the day's mark away."""
    out: dict[tuple[str, str], dict] = {}
    for line in log:
        if line.get("brand") != brand or line.get("kind") not in ROUND_ACTIONS:
            continue
        key = (str(line.get("handle")), str(line.get("day")))
        if line["kind"] == "undo":
            out.pop(key, None)
        else:
            out[key] = line
    return out


def _last(states: dict[tuple[str, str], dict], kind: str) -> dict[str, str]:
    """Each handle's latest ``at`` among its days that ended as ``kind``."""
    out: dict[str, str] = {}
    for (handle, _day), line in states.items():
        at = str(line.get("at") or "")
        if line.get("kind") == kind and at > out.get(handle, ""):
            out[handle] = at
    return out


def build_round(
    accounts: list[dict[str, Any]],
    log: list[dict[str, Any]],
    brand: str,
    day: str,
    size: int = ROUND_SIZE,
) -> dict[str, Any]:
    """Today's round (0031 C3). The accounts marked today stay in it; the
    open places go to active accounts not engaged today, least recently
    engaged first (never engaged before anyone; among equals the one skipped
    longest ago, then the one higher on the list), with one from each tier that has
    any. An account engaged today is never offered again that day."""
    by = {a["handle"]: a for a in accounts if isinstance(a, dict) and a.get("handle")}
    states = day_states(log, brand)
    today = {h: line for (h, d), line in states.items() if d == day and h in by}
    skipped = _last(states, "skip")

    place = {handle: i for i, handle in enumerate(by)}

    def order(a: dict[str, Any]) -> tuple[str, str, int]:
        return (
            str(a.get("last_engaged_at") or ""),
            skipped.get(a["handle"], ""),
            place[a["handle"]],  # the list's own order: one paste keeps its order
        )

    eligible = sorted(
        (
            a
            for a in by.values()
            if a.get("status") == "active"
            and a["handle"] not in today
            and _day_of(a.get("last_engaged_at")) != day
        ),
        key=order,
    )
    places = max(0, size - len(today))
    picked: list[dict[str, Any]] = []
    covered = {by[h].get("tier") for h in today}
    for tier in TIERS:
        if len(picked) >= places:
            break
        if tier in covered:
            continue
        first = next((a for a in eligible if a.get("tier") == tier), None)
        if first is not None:
            picked.append(first)
            covered.add(tier)
    for a in eligible:
        if len(picked) >= places:
            break
        if a not in picked:
            picked.append(a)
    picked.sort(key=order)
    rows = [{**a, "state": "open", "at": None, "angle": None} for a in picked]
    for handle, line in sorted(today.items(), key=lambda kv: str(kv[1].get("at"))):
        rows.append(
            {
                **by[handle],
                "state": line["kind"],
                "at": line.get("at"),
                "angle": line.get("angle") or None,
            }
        )
    left = sum(1 for r in rows if r["state"] == "open")
    return {
        "day": day,
        "size": size,
        "rows": rows,
        "open": left,
        "done": sum(1 for r in rows if r["state"] == "done"),
        "skipped": sum(1 for r in rows if r["state"] == "skip"),
        "complete": bool(rows) and left == 0,
    }


def checklist(
    log: list[dict[str, Any]], brand: str, day: str, round_done: bool
) -> dict[str, Any]:
    """The day's checklist (0031 C4) and the days kept: a day is kept when
    both boxes ended ticked and the round ended complete."""
    checks: dict[str, dict[str, bool]] = {}
    rounds: dict[str, bool] = {}
    for line in log:
        if line.get("brand") != brand:
            continue
        d = str(line.get("day"))
        if line.get("kind") == "check" and line.get("item") in CHECK_ITEMS:
            checks.setdefault(d, {})[line["item"]] = bool(line.get("checked"))
        elif line.get("kind") == "round":
            rounds[d] = bool(line.get("complete"))
    rounds[day] = round_done
    kept = sorted(
        d
        for d, done in rounds.items()
        if done and all(checks.get(d, {}).get(i) for i in CHECK_ITEMS)
    )
    streak = 0
    try:
        cursor = date.fromisoformat(day)
    except ValueError:
        cursor = None
    if cursor is not None:
        if day not in kept:  # today can still be kept: count up to yesterday
            cursor -= timedelta(days=1)
        while cursor.isoformat() in kept:
            streak += 1
            cursor -= timedelta(days=1)
    mine = checks.get(day, {})
    return {
        "day": day,
        **{item: bool(mine.get(item)) for item in CHECK_ITEMS},
        "round_done": round_done,
        "days_kept": len(kept),
        "streak": streak,
    }


# ---------- the log, written ----------


def _mark_round(
    root: Path, brand: str, day: str, before: dict, after: dict, at: str
) -> None:
    """Record the round's turn to complete, or back, so a past day can be read."""
    if before["complete"] == after["complete"]:
        return
    line: dict[str, Any] = {
        "at": at,
        "day": day,
        "brand": brand,
        "kind": "round",
        "complete": after["complete"],
    }
    if after["complete"]:
        line["handles"] = [r["handle"] for r in after["rows"]]
        line["done"] = after["done"]
        line["skipped"] = after["skipped"]
    append_log(root, line)


def mark_round(
    root: Path,
    brand: str,
    handle: str,
    action: str,
    angle: str | None,
    now: datetime,
) -> dict[str, Any]:
    """Done, Skip or Undo on one account of today's round (0031 C3). Done
    sets the account's last engaged time and keeps the angle used, if any;
    Undo takes today's mark away and puts the earlier time back."""
    if action not in ROUND_ACTIONS:
        raise HTTPException(status_code=400, detail="action is done, skip or undo")
    angle = " ".join((angle or "").split())
    if len(angle) > ANGLE_MAX:
        raise HTTPException(
            status_code=400, detail=f"The angle is at most {ANGLE_MAX} characters"
        )
    day, at = central_day(now), _iso(now)
    doc = read_targets(root)
    account = _account(doc, brand, handle)
    if account is None:
        raise HTTPException(status_code=404, detail="No such account on this list")
    accounts = doc["brands"][brand]["accounts"]
    log = read_log(root)
    before = build_round(accounts, log, brand, day)
    row = next((r for r in before["rows"] if r["handle"] == handle), None)
    if action == "undo":
        if row is None or row["state"] == "open":
            raise HTTPException(status_code=409, detail="Nothing to undo today")
    elif row is None:
        raise HTTPException(status_code=409, detail="Not in today's round; reload")
    elif row["state"] != "open":
        raise HTTPException(status_code=409, detail=f"Already marked {row['state']}")
    line: dict[str, Any] = {
        "at": at,
        "day": day,
        "brand": brand,
        "kind": action,
        "handle": handle,
    }
    if action == "done" and angle:
        line["angle"] = angle
    append_log(root, line)
    log.append(line)
    if action == "done":
        account["last_engaged_at"] = at
    elif action == "undo":
        account["last_engaged_at"] = _last(day_states(log, brand), "done").get(handle)
    if action != "skip":
        account["updated_at"] = at
        write_targets(root, doc)
    after = build_round(accounts, log, brand, day)
    _mark_round(root, brand, day, before, after, at)
    return after


def set_check(
    root: Path, brand: str, item: str, checked: bool, now: datetime
) -> dict[str, Any]:
    if item not in CHECK_ITEMS:
        raise HTTPException(status_code=400, detail="Unknown checklist item")
    line = {
        "at": _iso(now),
        "day": central_day(now),
        "brand": brand,
        "kind": "check",
        "item": item,
        "checked": bool(checked),
    }
    append_log(root, line)
    return line


# ---------- candidates (Hermes's ig_target_candidates) ----------


def _candidate(feed: dict[str, Any], brand: str, handle: str) -> dict[str, Any] | None:
    for prop in feed.get("properties") or []:
        if not isinstance(prop, dict) or prop.get("id") != brand:
            continue
        for c in prop.get("candidates") or []:
            if isinstance(c, dict) and normalize_handle(str(c.get("handle"))) == handle:
                return c
    return None


def accept_candidate(
    root: Path, brand: str, handle: str, candidate: dict[str, Any], now: datetime
) -> dict[str, Any]:
    doc = read_targets(root)
    if _account(doc, brand, handle) is not None:
        raise HTTPException(status_code=409, detail="Already on the list")
    entry = _brand(doc, brand)
    found_on = str(candidate.get("found_on") or "")
    account = new_account(
        handle,
        "hermes",
        now,
        why=" ".join(str(candidate.get("why") or "").split())[: LIMITS["why"]],
        found_on=found_on[:500] if found_on.startswith("https://") else None,
    )
    entry["accounts"].append(account)
    entry["dismissed"] = [h for h in entry["dismissed"] if h != handle]
    write_targets(root, doc)
    return account


def dismiss_candidate(root: Path, brand: str, handle: str) -> list[str]:
    """Into ``dismissed``, so Hermes does not offer it again (contract §6.9)."""
    doc = read_targets(root)
    if _account(doc, brand, handle) is not None:
        raise HTTPException(status_code=409, detail="Already on the list")
    entry = _brand(doc, brand)
    if handle not in entry["dismissed"]:
        entry["dismissed"].append(handle)
        write_targets(root, doc)
    return entry["dismissed"]


# ---------- the page's one read ----------


def read_state(
    root: Path | None, brands: list[str], now: datetime | None = None
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    day = central_day(now)
    out: dict[str, Any] = {
        "configured": root is not None and bool(brands),
        "day": day,
        "round_size": ROUND_SIZE,
        "brands": [],
    }
    if root is None or not brands:
        return out
    doc = read_targets(root)
    log = read_log(root)
    for brand in brands:
        entry = doc["brands"].get(brand) or {"accounts": [], "dismissed": []}
        accounts = [a for a in entry["accounts"] if isinstance(a, dict)]
        rnd = build_round(accounts, log, brand, day)
        mine = [line for line in log if line.get("brand") == brand]
        out["brands"].append(
            {
                "id": brand,
                "accounts": accounts,
                "dismissed": entry["dismissed"],
                "round": rnd,
                "checklist": checklist(log, brand, day, rnd["complete"]),
                "log": mine[-LOG_TAIL:][::-1],
            }
        )
    return out


def waiting_items(root: Path, brands: list[str], now: datetime) -> list[dict[str, Any]]:
    """One ``outreach`` row per brand whose round for today has an account
    left (contract §10.3). No active account, or the round done: no row."""
    day = central_day(now)
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=HERMES_TZ)
    doc = read_targets(root)
    log = read_log(root)
    items = []
    for brand in brands:
        accounts = (doc["brands"].get(brand) or {}).get("accounts") or []
        rnd = build_round(accounts, log, brand, day)
        if not rnd["open"]:
            continue
        total = len(rnd["rows"])
        items.append(
            {
                "kind": "outreach",
                "id": f"outreach:{brand}:{day}",
                "source_feed": FOLDER,
                "scope": brand,
                "title": f"Outreach round: {brand}",
                "detail": f"{rnd['open']} of {total} accounts left today",
                "created_at": _iso(start),
                "due": None,
                "priority": None,
                "link": {"page": "/outreach", "focus": brand},
            }
        )
    return items


# ---------- angles: the local model, then the screen ----------

ANGLE_COUNT = 3
ANGLE_ASK = 6
ANGLE_TIMEOUT_S = 120.0
KERNEL_CLIP = {"voice": 1200, "character": 900, "negatives": 1200}
RULE_SOURCE = (
    "foundry-bundle.json: compliance.prohibitedPhrases (matched as "
    "phraseMatching says) and kernelContent.brand.bannedWords"
)
KERNEL_SOURCE = (
    "foundry-bundle.json: kernelContent.brand.voice, characters[0] and negatives"
)
_GAPS = r"[\s\-‐-—]+"
_LINK = re.compile(r"https?://|www\.|\.com\b|\.co\b|\.net\b|\.org\b", re.I)
_GENERIC = (
    (_LINK, "a link"),
    (re.compile(r"[@#]\w"), "a mention or hashtag"),
    (re.compile(r"[$€£]|\d\s*%|\bpercent\b", re.I), "a price or a percentage"),
)


def _bundle_property(data: Path, brand: str) -> dict[str, Any] | None:
    try:
        bundle = json.loads(
            (data / "foundry" / "foundry-bundle.json").read_text(encoding="utf-8-sig")
        )
    except (OSError, ValueError):
        return None
    for p in bundle.get("properties") or []:
        if isinstance(p, dict) and p.get("id") == brand:
            return p
    return None


def phrase_pattern(entry: dict[str, Any]) -> re.Pattern[str] | None:
    """One prohibited phrase as the bundle's ``phraseMatching`` reads it:
    ``word`` (the default) takes the words in order with spaces, hyphens or
    dashes between and no letter or digit on either side; ``substring`` is
    plain containment. Case-insensitive unless ``caseSensitive``."""
    phrase = entry.get("phrase")
    if not isinstance(phrase, str) or not phrase.strip():
        return None
    match = entry.get("match") if isinstance(entry.get("match"), dict) else {}
    flags = 0 if match.get("caseSensitive") else re.I
    if match.get("mode") == "substring":
        return re.compile(re.escape(phrase), flags)
    words = [w for w in re.split(_GAPS, phrase.strip()) if w]
    if not words:
        return None
    body = _GAPS.join(re.escape(w) for w in words)
    return re.compile(rf"(?<![^\W_]){body}(?![^\W_])", flags)


def brand_rules(prop: dict[str, Any]) -> list[tuple[re.Pattern[str], str]] | None:
    """The brand's screen: every prohibited phrase (a ``verify`` phrase too:
    a comment has no backing to show) and every banned word. ``None`` when the
    bundle carries no phrase list for the brand, which is never a pass."""
    compliance = prop.get("compliance") if isinstance(prop, dict) else None
    phrases = (compliance or {}).get("prohibitedPhrases")
    if not isinstance(phrases, list):
        return None
    rules: list[tuple[re.Pattern[str], str]] = []
    for entry in phrases:
        pattern = phrase_pattern(entry) if isinstance(entry, dict) else None
        if pattern is not None:
            rules.append((pattern, str(entry.get("rule") or "prohibited phrase")))
    kernel = prop.get("kernelContent") if isinstance(prop, dict) else None
    brand = (kernel or {}).get("brand") or {}
    for word in brand.get("bannedWords") or []:
        pattern = phrase_pattern({"phrase": word}) if isinstance(word, str) else None
        if pattern is not None:
            rules.append((pattern, "banned word"))
    return rules


def screen_angle(text: str, rules: list[tuple[re.Pattern[str], str]]) -> str | None:
    """Why this angle is not shown, or ``None`` when it may be."""
    if not text or len(text) > ANGLE_MAX:
        return f"over {ANGLE_MAX} characters" if text else "empty"
    for pattern, why in _GENERIC:
        if pattern.search(text):
            return why
    for pattern, why in rules:
        if pattern.search(text):
            return why
    return None


def _clip(value: Any, n: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def angle_prompt(prop: dict[str, Any], account: dict[str, Any], about: str) -> list:
    kernel = prop.get("kernelContent") or {}
    brand = kernel.get("brand") or {}
    character = next(
        (c for c in kernel.get("characters") or [] if isinstance(c, dict)), {}
    )
    who = "; ".join(
        _clip(character.get(k), 400)
        for k in ("name", "description", "voiceNotes")
        if character.get(k)
    )
    system = "\n".join(
        [
            "You draft short comment ideas. A person will read them, pick one, "
            "and type it by hand under another account's Instagram post. You "
            "never post anything.",
            f"Write in this brand's voice: {_clip(brand.get('voice'), 1200)}",
            f"The character speaking: {_clip(who, KERNEL_CLIP['character'])}"
            if who
            else "",
            f"Never do this: {_clip(kernel.get('negatives'), 1200)}"
            if kernel.get("negatives")
            else "",
            "Rules for every comment:",
            f"- At most {ANGLE_MAX - 20} characters, one or two sentences.",
            "- It is about THEIR post or their work, as a peer. It does not sell.",
            "- No links, no @mentions, no hashtags, no prices, no discounts, "
            "no giveaways, no asking for a follow or a message.",
            "- No claim about health, safety, performance or results.",
            "- Do not name a product. Do not invent facts about the account.",
            f'Answer with JSON only: {{"angles": [{ANGLE_ASK} different comments]}}.',
        ]
    )
    facts = [f"The account: @{account['handle']}"]
    for label, key in (("Niche", "niche"), ("Why it is on the list", "why")):
        if account.get(key):
            facts.append(f"{label}: {_clip(account[key], 280)}")
    if account.get("notes"):
        facts.append(f"Notes: {_clip(account['notes'], 300)}")
    if about:
        facts.append(f"What their post is about: {_clip(about, ABOUT_MAX)}")
    else:
        facts.append("The post is not described: keep to their niche in general.")
    return [
        {
            "role": "system",
            "content": "\n".join(line for line in system.split("\n") if line),
        },
        {"role": "user", "content": "\n".join(facts)},
    ]


def parse_angles(content: str) -> list[str]:
    """The model's comments, cleaned: one line each, no wrapping quotes."""
    try:
        doc = json.loads(content)
    except ValueError:
        m = re.search(r"\{.*\}", content or "", re.S)
        try:
            doc = json.loads(m.group(0)) if m else None
        except ValueError:
            doc = None
    raw = doc.get("angles") if isinstance(doc, dict) else doc
    out: list[str] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict):
            item = item.get("text") or item.get("comment") or item.get("angle")
        if not isinstance(item, str):
            continue
        text = " ".join(item.split()).strip("\"'“”‘’ ")
        if text and text not in out:
            out.append(text)
    return out


async def draft_angles(
    prop: dict[str, Any],
    account: dict[str, Any],
    about: str,
    *,
    host: str,
    model: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Up to three screened angles. The model is asked for six; a second ask
    follows only when fewer than three pass. Fails closed: with no phrase list
    for the brand there is no screen, so nothing is drafted."""
    rules = brand_rules(prop)
    voice = ((prop.get("kernelContent") or {}).get("brand") or {}).get("voice")
    if rules is None or not voice:
        raise HTTPException(
            status_code=503,
            detail="Foundry's bundle has no kernel or no compliance phrases for "
            "this brand, so no angle can be drafted or screened",
        )
    messages = angle_prompt(prop, account, about)
    kept: list[str] = []
    refused = 0
    async with httpx.AsyncClient(
        timeout=ANGLE_TIMEOUT_S, transport=transport
    ) as client:
        for _attempt in range(2):
            payload = {
                "model": model,
                "messages": messages,
                "stream": False,
                "think": False,
                "format": "json",
                "options": {"temperature": 0.8},
            }
            try:
                resp = await client.post(f"{host}/api/chat", json=payload)
                resp.raise_for_status()
                content = (resp.json().get("message") or {}).get("content") or ""
            except (httpx.HTTPError, ValueError):
                raise HTTPException(
                    status_code=503, detail="The local model did not answer"
                ) from None
            for text in parse_angles(content):
                if text in kept:
                    continue
                if screen_angle(text, rules) is None:
                    kept.append(text)
                else:
                    refused += 1
            if len(kept) >= ANGLE_COUNT:
                break
    if not kept:
        raise HTTPException(
            status_code=502,
            detail="No drafted angle passed the screen; ask again",
        )
    return {
        "angles": kept[:ANGLE_COUNT],
        "screened_out": refused,
        "model": model,
        "rule_source": RULE_SOURCE,
        "kernel_source": KERNEL_SOURCE,
    }


# ---------- routes ----------


def _root() -> Path:
    root = store_dir()
    if root is None:
        raise HTTPException(
            status_code=404, detail="Workspace data folder not configured"
        )
    return root


def _check_brand(brand: str) -> str:
    if brand not in brand_ids():
        raise HTTPException(status_code=404, detail="Not an outreach brand")
    return brand


def _check_handle(handle: str) -> str:
    if not _HANDLE.fullmatch(handle or ""):
        raise HTTPException(status_code=400, detail="Invalid handle")
    return handle


def _store(fn, *args):
    """One store change at a time; an unreadable store is 503, never rewritten."""
    with _lock:
        try:
            return fn(*args)
        except StoreError as exc:
            raise HTTPException(
                status_code=503, detail=f"The outreach store is unreadable: {exc}"
            ) from None


def _now() -> datetime:
    return datetime.now(timezone.utc)


@outreach_router.get("/state")
def get_state():
    """The lists, today's rounds, the checklists and the log's tail."""
    return _store(read_state, store_dir(), brand_ids(), _now())


class AddBody(BaseModel):
    brand: str
    text: str


@outreach_router.post("/accounts")
def post_accounts(body: AddBody):
    """Paste handles or profile URLs, one or many (0031 C2)."""
    _check_brand(body.brand)
    if len(body.text) > PASTE_MAX:
        raise HTTPException(status_code=413, detail="Paste too long")
    return _store(add_accounts, _root(), body.brand, body.text, _now())


@outreach_router.patch("/accounts/{brand}/{handle}")
async def patch_account(brand: str, handle: str, request: Request):
    """The drawer's edits: niche, tier, why, status, collab state, notes."""
    _check_brand(brand)
    _check_handle(handle)
    raw = await request.body()
    if len(raw) > 8192:
        raise HTTPException(status_code=413, detail="Body too long")
    try:
        edits = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="Body is not JSON") from None
    if not isinstance(edits, dict) or not edits:
        raise HTTPException(status_code=400, detail="Nothing to change")
    return _store(edit_account, _root(), brand, handle, edits, _now())


class RoundBody(BaseModel):
    action: str
    angle: str | None = None


@outreach_router.post("/round/{brand}/{handle}")
def post_round(brand: str, handle: str, body: RoundBody):
    """Done, Skip or Undo: one line in the log (0031 C3)."""
    _check_brand(brand)
    _check_handle(handle)
    return _store(mark_round, _root(), brand, handle, body.action, body.angle, _now())


class CheckBody(BaseModel):
    item: str
    checked: bool


@outreach_router.post("/checklist/{brand}")
def post_check(brand: str, body: CheckBody):
    _check_brand(brand)
    return _store(set_check, _root(), brand, body.item, body.checked, _now())


class AnglesBody(BaseModel):
    brand: str
    handle: str
    about: str = ""


@outreach_router.post("/angles")
async def post_angles(body: AnglesBody, request: Request):
    """Three comment angles for one account, drafted on this machine and
    screened (0031 C3, D7). Nothing is stored until Done keeps the one used."""
    from openjarvis.server.desk_chat import _wait_for_gpu
    from openjarvis.server.hermes_router import _ollama_host, local_model

    _check_brand(body.brand)
    _check_handle(body.handle)
    about = " ".join(body.about.split())
    if len(about) > ABOUT_MAX:
        raise HTTPException(
            status_code=400, detail=f"At most {ABOUT_MAX} characters about the post"
        )
    root = _root()
    doc = _store(read_targets, root)
    account = _account(doc, body.brand, body.handle)
    if account is None:
        raise HTTPException(status_code=404, detail="No such account on this list")
    prop = _bundle_property(root.parent, body.brand)
    if prop is None:
        raise HTTPException(
            status_code=503, detail="Foundry's bundle isn't readable for this brand"
        )
    model = local_model(request)
    if not model:
        raise HTTPException(status_code=503, detail="No local model is configured")
    holder = await _wait_for_gpu()
    if holder:
        raise HTTPException(
            status_code=503,
            detail=f"The GPU is lent out right now ({holder}); try again shortly",
        )
    host = _ollama_host(getattr(request.app.state, "config", None))
    return await draft_angles(prop, account, about, host=host, model=model)


@outreach_router.post("/candidates/{brand}/{handle}/{action}")
async def post_candidate(brand: str, handle: str, action: str):
    """Accept (onto the list, source ``hermes``, with Hermes's why and page)
    or Dismiss (into ``dismissed``) one of Hermes's candidates (0031 C2)."""
    _check_brand(brand)
    _check_handle(handle)
    if action not in ("accept", "dismiss"):
        raise HTTPException(status_code=400, detail="Invalid action")
    root = _root()
    if action == "dismiss":
        return {"dismissed": _store(dismiss_candidate, root, brand, handle)}
    feed = await _feeds.get_feed("ig_target_candidates")
    candidate = _candidate(feed, brand, handle)
    if candidate is None:
        raise HTTPException(
            status_code=409, detail="Not among Hermes's candidates; reload"
        )
    return _store(accept_candidate, root, brand, handle, candidate, _now())


# Last: `/state` above would otherwise read as a feed name.
get_feed = outreach_router.get("/{feed}")(_feeds.get_feed)
