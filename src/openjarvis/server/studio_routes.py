"""FastAPI routes for the Content page's Episodes surface (hq 0019, Part B).

Foundry's local studio makes long-form episodes in files on this disk
(hq/contracts/foundry-studio.md): it rewrites ``status.json`` every run and
keeps one folder per episode, ``<propertyId>/<episodeId>/``, holding the
manifest, the script, the claims, the plan and the media. These routes read
those files and write only the ones the contract gives OpenJarvis:

- ``script.md`` and ``claims.json``, the operator's edit, only while the stage
  is ``awaiting-g0``;
- ``g0.json``, the operator's G0 decision, only while the stage is
  ``awaiting-g0``;
- ``publish.json`` (title, description, tags, thumbnail), only before the
  episode is submitted to G1;
- ``action.json`` (v0.4.5), the operator's retry, reject or requeue, by the
  contract's stage rules, one at a time;
- the ``pause/<propertyId>`` flag file.

Every write is atomic (a temp file, then rename). No route serves or writes
outside the studio folder, which is ``<WORKSPACE_DATA_DIR>/studio`` (the same
local setting the desks routes use). ``POST /api/studio/run`` starts the
studio's scheduled task, at most once every 2 minutes. There is no publish
button: publishing is G1's approval. Every route answers only requests from
this machine.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from openjarvis.server.stack_routes import _local_only
from openjarvis.server.waiting_routes import _data_dir

studio_router = APIRouter(prefix="/api/studio", tags=["studio"])

STUDIO_TASK = r"\Foundry\Studio"
RUN_COOLDOWN_S = 120
_run_last: float | None = None

# The contract's stage-time freshness rule for stack-health: WARN after 30 min.
STALE_AFTER_S = 30 * 60
_PROPERTY = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_EPISODE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_MEDIA_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_IMAGE_EXT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}
_VIDEO_EXT = {".mp4": "video/mp4"}

# G0 (foundry-studio.md `g0.json`).
DECISIONS = ("approve", "rewrite", "reject")
G0_NOTE_MAX = 1000
MAX_REWRITES = 2
SCRIPT_MAX = 200_000
CLAIM_TEXT_MAX = 1000
CLAIM_SOURCE_MAX = 500
CLAIM_KINDS = ("fact", "lore")
UNSOURCED = "unsourced"

# publish.json, as Foundry's submit checks it (Postiz's YouTube settings).
TITLE_MIN, TITLE_MAX = 2, 100
DESCRIPTION_MAX = 5000
TAGS_MAX_CHARS = 500
TAG_MAX = 100
# From this stage on the episode is with the pipeline: publish.json is spent.
SUBMITTED_STAGES = frozenset(
    {"scanning", "at-g1", "publishing", "published", "rejected"}
)
# action.json (foundry-studio.md v0.4.5): the operator's episode actions.
ACTIONS = ("retry", "reject", "requeue")
ACTION_NOTE_MAX = 1000
# Reject ends an episode at any stage before the pipeline (and a stopped one);
# from scanning on it is G1's call, and an ended one stays ended.
PRE_PIPELINE_STAGES = frozenset(
    {
        "queued",
        "scripting",
        "scripted",
        "awaiting-g0",
        "rewrite-requested",
        "narrating",
        "visualizing",
        "assembling",
    }
)
ENDED_STAGES = frozenset({"published", "rejected"})
# The bundle's studio keys the page shows; the rest of the bundle stays unread.
_STUDIO_KEYS = (
    "channelName",
    "lanePerWeek",
    "cloudCapUsdPerEpisode",
    "cloudCapUsdPerMonth",
    "gpuMinutesCap",
    "firstUnlisted",
)


def _iso(dt: datetime) -> str:
    return (
        dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _root() -> Path:
    data = _data_dir()
    if data is None:
        raise HTTPException(
            status_code=404, detail="Workspace data folder not configured"
        )
    return (data / "studio").resolve()


def _read_json(path: Path) -> Any:
    """The file's JSON, or None when it is missing or broken."""
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _write_json(path: Path, doc: Any) -> None:
    _write_atomic(path, (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode())


def _channels(root: Path) -> dict[str, dict[str, Any]]:
    """Each studio property's channel settings from Foundry's bundle."""
    bundle = _read_json(root.parent / "foundry" / "foundry-bundle.json")
    out: dict[str, dict[str, Any]] = {}
    for prop in (bundle or {}).get("properties") or []:
        studio = prop.get("studio") if isinstance(prop, dict) else None
        if not isinstance(studio, dict) or not isinstance(prop.get("id"), str):
            continue
        row = {k: studio.get(k) for k in _STUDIO_KEYS}
        row["episodeClasses"] = [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "operatorOnly": bool(c.get("operatorOnly")),
            }
            for c in studio.get("episodeClasses") or []
            if isinstance(c, dict)
        ]
        out[prop["id"]] = row
    return out


def _published_count(root: Path, property_id: str) -> int:
    ids = _read_json(root / property_id / "published.json")
    return len(ids) if isinstance(ids, list) else 0


def _paused(root: Path, property_id: str) -> bool:
    return (root / "pause" / property_id).is_file()


def _episode_dir(root: Path, episode_id: str) -> Path:
    if not _EPISODE.fullmatch(episode_id):
        raise HTTPException(status_code=400, detail="Invalid episode id")
    for manifest in root.glob(f"*/{episode_id}/manifest.json"):
        folder = manifest.parent.resolve()
        if folder.is_relative_to(root) and _PROPERTY.fullmatch(folder.parent.name):
            return folder
    raise HTTPException(status_code=404, detail="No such episode")


def _manifest(folder: Path) -> dict[str, Any]:
    doc = _read_json(folder / "manifest.json")
    if not isinstance(doc, dict):
        raise HTTPException(status_code=503, detail="manifest.json could not be read")
    return doc


def _stages(m: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for s in m.get("stages") or [] if isinstance(s, dict)]


def _since(m: dict[str, Any]) -> str | None:
    """When the episode entered its current stage."""
    for s in reversed(_stages(m)):
        if s.get("stage") == m.get("stage"):
            return s.get("at")
    return None


def _version(folder: Path) -> str:
    """One hash over the two files the G0 edit may rewrite."""
    h = hashlib.sha256()
    for name in ("script.md", "claims.json"):
        try:
            h.update((folder / name).read_bytes())
        except OSError:
            pass
        h.update(b"\0")
    return h.hexdigest()


def _edited(folder: Path, m: dict[str, Any]) -> bool:
    """Did script.md or claims.json change after the studio put it at G0?"""
    at = _parse_time(_since(m)) if m.get("stage") == "awaiting-g0" else None
    if at is None:
        return False
    for name in ("script.md", "claims.json"):
        try:
            mtime = (folder / name).stat().st_mtime
        except OSError:
            continue
        # The studio writes the files a moment before the stage entry.
        if mtime > at.timestamp() + 2:
            return True
    return False


def _media(folder: Path) -> dict[str, Any]:
    def size(name: str) -> int | None:
        try:
            return (folder / name).stat().st_size
        except OSError:
            return None

    thumbs = folder / "thumbs"
    return {
        "cut": size("cut.mp4"),
        "short": size("short.mp4"),
        "thumbs": sorted(
            p.name
            for p in (thumbs.iterdir() if thumbs.is_dir() else [])
            if p.is_file() and p.suffix.lower() in _IMAGE_EXT
        ),
    }


def _stage_note(m: dict[str, Any]) -> str | None:
    """The latest note the studio left in the current stage: a wait (visuals
    waiting for the operator's fixed text), a refusal, or a stop."""
    for s in reversed(_stages(m)):
        if s.get("stage") != m.get("stage"):
            return None
        if s.get("note"):
            return str(s["note"])
    return None


def _source_index(folder: Path) -> list[dict[str, Any]] | None:
    """The studio's source snapshot (v0.1.4), as {n, url}: names the source a
    `sourceCopy` hit came from. None before the snapshot exists."""
    index = _read_json(folder / "sources" / "index.json")
    if not isinstance(index, list):
        return None
    return [
        {"n": e.get("n"), "url": e.get("url")}
        for e in index
        if isinstance(e, dict) and isinstance(e.get("n"), int)
    ]


def _held_seeds(root: Path) -> set[str]:
    """The episodes whose seed is still claimed although they ended or
    stopped: `lanes[].heldSeeds[].episodeId` in status.json (v0.4.5), as of
    the studio's last run."""
    status = _read_json(root / "status.json")
    lanes = status.get("lanes") if isinstance(status, dict) else None
    out: set[str] = set()
    for lane in lanes or []:
        seeds = lane.get("heldSeeds") if isinstance(lane, dict) else None
        for seed in seeds or []:
            if isinstance(seed, dict) and isinstance(seed.get("episodeId"), str):
                out.add(seed["episodeId"])
    return out


def _action_pending(folder: Path) -> dict[str, Any] | None:
    """The action.json the studio has not consumed yet, or None."""
    doc = _read_json(folder / "action.json")
    return doc if isinstance(doc, dict) and doc.get("action") in ACTIONS else None


def _summary(
    folder: Path, m: dict[str, Any], held: set[str] | None = None
) -> dict[str, Any]:
    cloud = m.get("cloud") if isinstance(m.get("cloud"), dict) else {}
    stages = _stages(m)
    episode_id = m.get("episodeId") or folder.name
    if held is None:
        held = _held_seeds(folder.parent.parent)
    return {
        "episodeId": episode_id,
        "propertyId": m.get("propertyId") or folder.parent.name,
        "stage": m.get("stage"),
        "since": _since(m),
        "updatedAt": stages[-1].get("at") if stages else None,
        "title": m.get("title"),
        "topic": m.get("topic"),
        "episodeClass": m.get("episodeClass"),
        "targetMinutes": m.get("targetMinutes"),
        "gpuMinutes": m.get("gpuMinutes"),
        "spentUsd": cloud.get("spentUsd"),
        "durationSeconds": m.get("durationSeconds"),
        "youtubeVisibility": m.get("youtubeVisibility"),
        "postId": m.get("postId"),
        "stoppedReason": m.get("stoppedReason"),
        "stageNote": _stage_note(m),
        "rewrites": m.get("rewrites") or 0,
        "g0Pending": (folder / "g0.json").is_file(),
        # v0.4.5: an action.json waiting for the studio, and whether this
        # ended or stopped episode still holds its seed (Requeue seed).
        "actionPending": _action_pending(folder),
        "seedHeld": episode_id in held and not m.get("seedReleasedAt"),
    }


def _visibility(root: Path, m: dict[str, Any], channel: dict | None) -> dict | None:
    """0019 D9: the channel's first `firstUnlisted` episodes publish unlisted."""
    first = (channel or {}).get("firstUnlisted")
    if not isinstance(first, int):
        return None
    pid = str(m.get("propertyId") or "")
    if m.get("youtubeVisibility") in ("unlisted", "public"):
        return {"visibility": m["youtubeVisibility"], "number": None, "first": first}
    ledger = _read_json(root / pid / "published.json")
    ids = ledger if isinstance(ledger, list) else []
    eid = m.get("episodeId")
    number = ids.index(eid) + 1 if eid in ids else len(ids) + 1
    return {
        "visibility": "unlisted" if number <= first else "public",
        "number": number,
        "first": first,
    }


# ---------- reads ----------


def status_doc() -> dict[str, Any]:
    """The status the page shows (also the Content desk's ``studio_status``)."""
    root = _root()
    status = _read_json(root / "status.json")
    if not isinstance(status, dict):
        raise HTTPException(status_code=404, detail="No studio run yet")
    now = datetime.now(timezone.utc)
    at = _parse_time(status.get("generatedAt"))
    age = None if at is None else max(0, int((now - at).total_seconds()))
    channels = _channels(root)
    ids = sorted(
        {
            *channels,
            *(
                lane.get("propertyId")
                for lane in status.get("lanes") or []
                if isinstance(lane, dict) and isinstance(lane.get("propertyId"), str)
            ),
        }
    )
    return {
        **status,
        # The flag files are the truth; status.json shows them as of its run.
        "paused": {pid: _paused(root, pid) for pid in ids},
        "published": {pid: _published_count(root, pid) for pid in ids},
        "channels": channels,
        "age_seconds": age,
        "stale": age is None or age > STALE_AFTER_S,
    }


@studio_router.get("/status")
def get_status(request: Request):
    _local_only(request)
    return status_doc()


@studio_router.get("/episodes")
def list_episodes(request: Request, property: str = ""):
    _local_only(request)
    root = _root()
    if property and not _PROPERTY.fullmatch(property):
        raise HTTPException(status_code=400, detail="Invalid property")
    rows = []
    held = _held_seeds(root)
    pattern = f"{property}/*/manifest.json" if property else "*/*/manifest.json"
    for manifest in root.glob(pattern):
        folder = manifest.parent
        if not _EPISODE.fullmatch(folder.name):
            continue
        m = _read_json(manifest)
        if isinstance(m, dict):
            rows.append(_summary(folder, m, held))
    rows.sort(key=lambda r: r.get("updatedAt") or "", reverse=True)
    return {"episodes": rows}


def episode_doc(episode_id: str) -> dict[str, Any]:
    """One episode's files (also the Content desk's ``episode`` tool)."""
    root = _root()
    folder = _episode_dir(root, episode_id)
    m = _manifest(folder)
    try:
        script = (folder / "script.md").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        script = None
    history = []
    for path in sorted(folder.glob("g0.*.json")):
        doc = _read_json(path)
        if isinstance(doc, dict):
            history.append(doc)
    actions = []
    for path in sorted(folder.glob("action.*.json")):
        doc = _read_json(path)
        if isinstance(doc, dict):
            actions.append(doc)
    pid = str(m.get("propertyId") or folder.parent.name)
    channel = _channels(root).get(pid)
    return {
        "summary": _summary(folder, m, _held_seeds(root)),
        "manifest": m,
        "script": script,
        "claims": _read_json(folder / "claims.json"),
        "plan": _read_json(folder / "plan.json"),
        "chapters": _read_json(folder / "chapters.json"),
        "publish": _read_json(folder / "publish.json"),
        "narration": _read_json(folder / "narration.result.json"),
        "g0Pending": _read_json(folder / "g0.json"),
        "g0History": history,
        # v0.4.5: the consumed actions, oldest first (`action.<at>.json`).
        "actionHistory": actions,
        "media": _media(folder),
        "version": _version(folder),
        "edited": _edited(folder, m),
        "channel": channel,
        "visibility": _visibility(root, m, channel),
        "paused": _paused(root, pid),
        "sourceIndex": _source_index(folder),
    }


@studio_router.get("/episodes/{episode_id}")
def get_episode(episode_id: str, request: Request):
    _local_only(request)
    return episode_doc(episode_id)


@studio_router.get("/episodes/{episode_id}/media/{name:path}")
def get_media(episode_id: str, name: str, request: Request):
    """One media file from the episode's folder: the cut, the short, a
    thumbnail or a rendered visual. Nothing else, and never outside it."""
    _local_only(request)
    root = _root()
    folder = _episode_dir(root, episode_id)
    parts = name.split("/")
    allowed = (
        (len(parts) == 1 and parts[0] in ("cut.mp4", "short.mp4"))
        or (len(parts) == 2 and parts[0] in ("thumbs", "visuals"))
    ) and all(_MEDIA_FILE.fullmatch(p) for p in parts)
    suffix = Path(parts[-1]).suffix.lower()
    kinds = {**_IMAGE_EXT, **_VIDEO_EXT}
    if not allowed or suffix not in kinds:
        raise HTTPException(status_code=400, detail="Not a studio media file")
    path = (folder / Path(*parts)).resolve()
    if not path.is_relative_to(folder) or not path.is_file():
        raise HTTPException(status_code=404, detail="No such file")
    return FileResponse(path, media_type=kinds[suffix])


# ---------- G0 ----------


class ScriptBody(BaseModel):
    version: str
    script: str | None = None
    claims: list[dict[str, Any]] | None = None


def _check_claims(new: list[dict[str, Any]], old: Any) -> list[dict[str, Any]]:
    """The operator's claim edits: the same claims, with text, source and kind
    edited. A claim keeps its id, its beat and every other key the studio set."""
    if not isinstance(old, list):
        raise HTTPException(status_code=409, detail="claims.json could not be read")
    by_id = {c.get("id"): c for c in old if isinstance(c, dict)}
    if len(new) != len(by_id) or {c.get("id") for c in new} != set(by_id):
        raise HTTPException(
            status_code=400, detail="Edit the claims; don't add or remove them"
        )
    out = []
    for claim in new:
        text = claim.get("text")
        source = claim.get("source")
        kind = claim.get("kind")
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= CLAIM_TEXT_MAX:
            raise HTTPException(
                status_code=400,
                detail=f"Claim {claim.get('id')}: text is 1-{CLAIM_TEXT_MAX} chars",
            )
        if kind not in CLAIM_KINDS:
            raise HTTPException(
                status_code=400, detail=f"Claim {claim.get('id')}: kind is fact or lore"
            )
        if not isinstance(source, str) or not (
            source in ("", UNSOURCED)
            or (source.startswith("https://") and len(source) <= CLAIM_SOURCE_MAX)
        ):
            raise HTTPException(
                status_code=400,
                detail=f"Claim {claim.get('id')}: source is an https link or unsourced",
            )
        out.append(
            {**by_id[claim["id"]], "text": text.strip(), "source": source, "kind": kind}
        )
    return out


def _at_g0(folder: Path) -> dict[str, Any]:
    m = _manifest(folder)
    if m.get("stage") != "awaiting-g0":
        raise HTTPException(
            status_code=409,
            detail=f"The episode is {m.get('stage')}, not awaiting G0",
        )
    return m


@studio_router.put("/episodes/{episode_id}/script")
def put_script(episode_id: str, body: ScriptBody, request: Request):
    """The operator's edit of script.md and/or claims.json at G0. `version` is
    the hash the page loaded; a newer draft from the studio answers 409."""
    _local_only(request)
    folder = _episode_dir(_root(), episode_id)
    _at_g0(folder)
    if body.script is None and body.claims is None:
        raise HTTPException(status_code=400, detail="Nothing to save")
    if body.version != _version(folder):
        raise HTTPException(
            status_code=409, detail="The script changed since it was loaded; reload"
        )
    if (folder / "g0.json").is_file():
        raise HTTPException(
            status_code=409, detail="A G0 decision is already waiting for the studio"
        )
    claims = None
    if body.claims is not None:
        claims = _check_claims(body.claims, _read_json(folder / "claims.json"))
    if body.script is not None:
        if not body.script.strip() or len(body.script) > SCRIPT_MAX:
            raise HTTPException(
                status_code=400, detail=f"The script is 1-{SCRIPT_MAX} characters"
            )
        text = body.script.replace("\r\n", "\n")
        _write_atomic(folder / "script.md", text.encode("utf-8"))
    if claims is not None:
        _write_json(folder / "claims.json", claims)
    return {"version": _version(folder), "edited": True}


class G0Body(BaseModel):
    decision: str
    note: str = ""
    # v0.4: "off" turns the episode's motion shots off, "on" turns them on;
    # None is the channel default (on). Before v0.4 this was `omni`, which the
    # studio now reads only when true, so it is never written here.
    motion: str | None = None
    claimsChecked: list[str] = []
    edited: bool = False


MOTIONS = frozenset({"on", "off"})


@studio_router.post("/episodes/{episode_id}/g0")
def post_g0(episode_id: str, body: G0Body, request: Request):
    """Write g0.json, the operator's decision. The studio reads it on its next
    run (every 10 minutes, or now with Run studio now) and renames it."""
    _local_only(request)
    folder = _episode_dir(_root(), episode_id)
    m = _at_g0(folder)
    if body.decision not in DECISIONS:
        raise HTTPException(status_code=400, detail="approve, rewrite or reject")
    if body.motion is not None and body.motion not in MOTIONS:
        raise HTTPException(status_code=400, detail='motion: "on", "off" or absent')
    note = body.note.strip()
    if len(note) > G0_NOTE_MAX:
        raise HTTPException(
            status_code=400, detail=f"The note is at most {G0_NOTE_MAX} characters"
        )
    if (folder / "g0.json").is_file():
        raise HTTPException(
            status_code=409, detail="A G0 decision is already waiting for the studio"
        )
    claims = _read_json(folder / "claims.json")
    ids = (
        [c.get("id") for c in claims if isinstance(c, dict)]
        if isinstance(claims, list)
        else []
    )
    checked = [c for c in dict.fromkeys(body.claimsChecked) if c in ids]
    if body.decision == "approve" and set(checked) != set(ids):
        raise HTTPException(status_code=400, detail="Approve needs every claim checked")
    if body.decision == "rewrite":
        if not note:
            raise HTTPException(
                status_code=400, detail="Say what the rewrite should change"
            )
        if int(m.get("rewrites") or 0) >= MAX_REWRITES:
            raise HTTPException(
                status_code=409,
                detail=f"{MAX_REWRITES} rewrites already: approve, edit or reject",
            )
    g0: dict[str, Any] = {
        "decision": body.decision,
        "at": _iso(datetime.now(timezone.utc)),
    }
    if note:
        g0["note"] = note
    if body.decision == "approve" and body.motion is not None:
        g0["motion"] = body.motion
    g0["claimsChecked"] = checked
    g0["edited"] = body.edited or _edited(folder, m)
    _write_json(folder / "g0.json", g0)
    return g0


# ---------- publish.json ----------


class PublishBody(BaseModel):
    title: str
    description: str
    tags: list[str] = []
    thumbnail: str


def _no_angles(field: str, text: str) -> None:
    if "<" in text or ">" in text:
        raise HTTPException(status_code=400, detail=f"The {field} may not hold < or >")


@studio_router.put("/episodes/{episode_id}/publish")
def put_publish(episode_id: str, body: PublishBody, request: Request):
    """The episode's YouTube title, description, tags and thumbnail, read by
    the studio's submit step. Only before the episode goes to G1."""
    _local_only(request)
    folder = _episode_dir(_root(), episode_id)
    m = _manifest(folder)
    if m.get("stage") in SUBMITTED_STAGES or m.get("executionArn"):
        raise HTTPException(
            status_code=409,
            detail=f"The episode is {m.get('stage')}: it was already submitted",
        )
    title = " ".join(body.title.split())
    if not TITLE_MIN <= len(title) <= TITLE_MAX:
        raise HTTPException(
            status_code=400, detail=f"The title is {TITLE_MIN}-{TITLE_MAX} characters"
        )
    _no_angles("title", title)
    description = body.description.replace("\r\n", "\n").strip()
    if len(description) > DESCRIPTION_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"The description is at most {DESCRIPTION_MAX} characters",
        )
    _no_angles("description", description)
    tags = [t.strip() for t in body.tags if t.strip()]
    if any(len(t) > TAG_MAX for t in tags) or len(",".join(tags)) > TAGS_MAX_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"Tags are at most {TAGS_MAX_CHARS} characters together",
        )
    for tag in tags:
        _no_angles("tags", tag)
    thumbs = _media(folder)["thumbs"]
    if not thumbs:
        raise HTTPException(
            status_code=409, detail="No thumbnails yet: the cut isn't assembled"
        )
    if body.thumbnail not in thumbs:
        raise HTTPException(
            status_code=400, detail=f"Pick a thumbnail: {', '.join(thumbs)}"
        )
    doc = {
        "title": title,
        "description": description,
        "tags": tags,
        "thumbnail": body.thumbnail,
    }
    _write_json(folder / "publish.json", doc)
    return doc


# ---------- action.json (v0.4.5) ----------


class ActionBody(BaseModel):
    action: str
    note: str = ""


def action_refusal(action: str, m: dict[str, Any], held: bool) -> str | None:
    """Why the stage rules forbid this action now, or None. The same rules
    the studio applies, so a stale page cannot send one it would refuse."""
    stage = str(m.get("stage") or "")
    if action == "retry":
        return (
            None
            if stage == "stopped"
            else f"Retry needs a stopped episode, not {stage}"
        )
    if action == "reject":
        if stage in PRE_PIPELINE_STAGES or stage == "stopped":
            return None
        if stage in ENDED_STAGES:
            return f"The episode is already {stage}"
        return f"The episode is {stage}: reject it at G1"
    if action == "requeue":
        if stage not in ("rejected", "stopped"):
            return f"Requeue needs a rejected or stopped episode, not {stage}"
        if m.get("seedReleasedAt"):
            return "The seed is already back in its lane"
        if not held:
            return "This episode no longer holds its seed"
        return None
    return "retry, reject or requeue"


@studio_router.post("/episodes/{episode_id}/action")
def post_action(episode_id: str, body: ActionBody, request: Request):
    """Write action.json: retry a stopped episode, reject one before the
    pipeline, or requeue an ended one's seed. The studio consumes it on its
    next run (every 10 minutes, or Run studio now) and renames it; the
    outcome is the manifest's last stage note."""
    _local_only(request)
    root = _root()
    folder = _episode_dir(root, episode_id)
    m = _manifest(folder)
    if body.action not in ACTIONS:
        raise HTTPException(status_code=400, detail="retry, reject or requeue")
    note = " ".join(body.note.split())
    if len(note) > ACTION_NOTE_MAX:
        raise HTTPException(
            status_code=400, detail=f"The note is at most {ACTION_NOTE_MAX} characters"
        )
    why = action_refusal(body.action, m, episode_id in _held_seeds(root))
    if why:
        raise HTTPException(status_code=400, detail=why)
    if (folder / "action.json").is_file():
        raise HTTPException(
            status_code=409,
            detail="an action is already waiting for the studio's next run",
        )
    doc: dict[str, Any] = {"action": body.action}
    if note:
        doc["note"] = note
    doc["at"] = _iso(datetime.now(timezone.utc))
    _write_json(folder / "action.json", doc)
    return doc


# ---------- controls ----------


def _studio_property(root: Path, property_id: str) -> None:
    if not _PROPERTY.fullmatch(property_id):
        raise HTTPException(status_code=400, detail="Invalid property")
    status = _read_json(root / "status.json")
    lanes = (status or {}).get("lanes") if isinstance(status, dict) else None
    known = set(_channels(root)) | {
        lane.get("propertyId") for lane in lanes or [] if isinstance(lane, dict)
    }
    if property_id not in known:
        raise HTTPException(status_code=404, detail="Not a studio channel")


@studio_router.post("/pause/{property_id}")
def pause(property_id: str, request: Request):
    """Hold the channel's episodes where they are (always allowed)."""
    _local_only(request)
    root = _root()
    _studio_property(root, property_id)
    folder = root / "pause"
    folder.mkdir(parents=True, exist_ok=True)
    flag = folder / property_id
    if not flag.is_file():
        _write_atomic(flag, f"{_iso(datetime.now(timezone.utc))} (app)\n".encode())
    return {"propertyId": property_id, "paused": True}


@studio_router.delete("/pause/{property_id}")
def resume(property_id: str, request: Request):
    _local_only(request)
    root = _root()
    _studio_property(root, property_id)
    (root / "pause" / property_id).unlink(missing_ok=True)
    return {"propertyId": property_id, "paused": False}


@studio_router.post("/run", status_code=202)
def run_studio(request: Request):
    """Start the studio's task now (every 10 minutes otherwise); at most once
    every 2 minutes. Each run advances every episode in flight by one stage."""
    global _run_last
    _local_only(request)
    if sys.platform != "win32":
        raise HTTPException(status_code=501, detail="Only on Windows")
    now = time.monotonic()
    if _run_last is not None and now - _run_last < RUN_COOLDOWN_S:
        wait = int(RUN_COOLDOWN_S - (now - _run_last)) + 1
        return JSONResponse(
            status_code=429,
            content={
                "detail": "The studio ran under 2 minutes ago",
                "retry_after": wait,
            },
            headers={"Retry-After": str(wait)},
        )
    try:
        proc = subprocess.run(
            ["schtasks", "/Run", "/TN", STUDIO_TASK],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(
            status_code=503, detail=f"schtasks failed: {type(exc).__name__}"
        ) from None
    if proc.returncode != 0:
        lines = (proc.stderr or proc.stdout or "").strip().splitlines()
        detail = lines[0].strip() if lines else ""
        raise HTTPException(status_code=503, detail=detail[:200] or "schtasks failed")
    _run_last = now
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return JSONResponse(status_code=202, content={"started_at": started})
