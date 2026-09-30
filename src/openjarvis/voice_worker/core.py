"""Voice worker logic: chunking, the mood map, the GPU lease, the audio cache
and the queue walk. Stdlib only; the engines are injected (see engines.py),
so all of this is testable without torch."""

from __future__ import annotations

import json
import logging
import os
import re
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Protocol

logger = logging.getLogger("openjarvis.voice_worker")

HOLDER = "openjarvis-voice"
CHUNK_LIMIT = 280
GAP_SECONDS = 0.25
SEED = 1234
MIN_FREE_MIB = 6144
LEASE_TTL = timedelta(minutes=10)
LEASE_STALE = timedelta(minutes=15)
FALLBACK_AFTER = timedelta(minutes=20)
CACHE_DAYS = 14
SPEAK_TEXT_MAX = 2000  # ad-hoc read-outs (POST /speak)
BLOCK_TEXT_MAX = 20000  # a Hermes speech block (a digest runs past 2,000)

# Chatterbox exaggeration per Hermes mood (hq 0009; neutral is the operator's pick).
MOOD_EXAGGERATION = {"neutral": 0.5, "upbeat": 0.6, "grave": 0.45, "dry": 0.4}


def exaggeration_for(mood: str | None) -> float:
    return MOOD_EXAGGERATION.get((mood or "").lower(), MOOD_EXAGGERATION["neutral"])


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return (
        dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def _parse(ts: Any) -> datetime | None:
    if not isinstance(ts, str) or not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---------- chunking ----------

_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")


def _split_long(sentence: str, limit: int) -> list[str]:
    """A single sentence over the limit: break at the last space before it."""
    out: list[str] = []
    rest = sentence
    while len(rest) > limit:
        cut = rest.rfind(" ", 0, limit + 1)
        if cut <= 0:
            cut = limit
        out.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        out.append(rest)
    return out


def chunk_text(text: str, limit: int = CHUNK_LIMIT) -> list[str]:
    """Sentence groups of at most ``limit`` characters. Paragraph breaks always
    end a chunk (Hermes puts blank lines between topics); Chatterbox degrades
    past about 40 s per call."""
    chunks: list[str] = []
    for para in (p.strip() for p in text.splitlines()):
        if not para:
            continue
        cur = ""
        for sentence in _SENTENCE_END.split(para):
            for piece in _split_long(sentence.strip(), limit):
                if cur and len(cur) + 1 + len(piece) > limit:
                    chunks.append(cur)
                    cur = piece
                else:
                    cur = f"{cur} {piece}".strip()
        if cur:
            chunks.append(cur)
    return chunks


# ---------- GPU lease ----------


class GpuLease:
    """The lease file Hermes reads before any local-model call (contract v1.1).

    Taken only when Ollama has no model loaded, at least 6 GB of GPU memory is
    free, and nobody else holds a fresh lease. Written atomically; deleted
    when done or on any error. Never touches Ollama itself."""

    def __init__(
        self,
        path: Path,
        ollama_loaded: Callable[[], list[str]],
        free_mib: Callable[[], int],
        clock: Callable[[], datetime] = utcnow,
        min_free_mib: int = MIN_FREE_MIB,
        fake_busy: Callable[[], bool] = lambda: False,
    ) -> None:
        self.path = Path(path)
        self._ollama_loaded = ollama_loaded
        self._free_mib = free_mib
        self._clock = clock
        self.min_free_mib = min_free_mib
        self._fake_busy = fake_busy
        self.held = False

    def _read(self) -> dict[str, Any] | None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            return {"unreadable": True}
        return data if isinstance(data, dict) else {"unreadable": True}

    def foreign_fresh(self) -> bool:
        """Someone else holds a lease that isn't stale (Hermes's own rule:
        stale after 15 minutes or past expires_at). An unreadable file counts
        as fresh until it is 15 minutes old."""
        data = self._read()
        if data is None:
            return False
        now = self._clock()
        if data.get("unreadable"):
            try:
                mtime = datetime.fromtimestamp(self.path.stat().st_mtime, timezone.utc)
            except OSError:
                return False
            return now - mtime < LEASE_STALE
        if data.get("holder") == HOLDER:
            return False  # ours, left by a crash: take it over
        acquired, expires = (
            _parse(data.get("acquired_at")),
            _parse(data.get("expires_at")),
        )
        if acquired is None or expires is None:
            return False
        return now - acquired < LEASE_STALE and now < expires

    def availability(self) -> tuple[bool, str]:
        if self._fake_busy():
            return False, "fake-busy flag"
        if self.foreign_fresh():
            return False, "another holder has a fresh lease"
        loaded = self._ollama_loaded()
        if loaded:
            return False, f"ollama has {len(loaded)} model(s) loaded"
        free = self._free_mib()
        if free < self.min_free_mib:
            return False, f"{free} MiB free < {self.min_free_mib}"
        return True, "ok"

    def _write(self, purpose: str, acquired: datetime) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        doc = {
            "holder": HOLDER,
            "purpose": purpose,
            "acquired_at": _iso(acquired),
            "expires_at": _iso(self._clock() + LEASE_TTL),
        }
        tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(doc), encoding="utf-8")
        os.replace(tmp, self.path)

    def acquire(self, purpose: str) -> bool:
        ok, why = self.availability()
        if not ok:
            logger.info("GPU lease not taken: %s", why)
            return False
        self._acquired = self._clock()
        self._write(purpose, self._acquired)
        self.held = True
        return True

    def renew(self, purpose: str) -> None:
        """Push expires_at out again; acquired_at stays (Hermes treats a lease
        older than 15 minutes as stale regardless)."""
        if self.held:
            self._write(purpose, self._acquired)

    def release(self) -> None:
        if not self.held:
            return
        self.held = False
        data = self._read()
        if data is not None and data.get("holder") == HOLDER:
            self.path.unlink(missing_ok=True)


# ---------- audio cache ----------


def silence(sr: int, seconds: float = GAP_SECONDS) -> bytes:
    return b"\x00\x00" * int(sr * seconds)


class AudioCache:
    """``<id>.wav`` (16-bit mono PCM) plus ``index.json``."""

    def __init__(self, root: Path, clock: Callable[[], datetime] = utcnow) -> None:
        self.root = Path(root)
        self._clock = clock

    @property
    def index_file(self) -> Path:
        return self.root / "index.json"

    def index(self) -> dict[str, dict[str, Any]]:
        try:
            data = json.loads(self.index_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write_index(self, idx: dict[str, dict[str, Any]]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.index_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(idx, indent=1), encoding="utf-8")
        os.replace(tmp, self.index_file)

    def wav_path(self, block_id: str) -> Path:
        return self.root / f"{block_id}.wav"

    def lane(self, block_id: str) -> str | None:
        entry = self.index().get(block_id)
        if entry and self.wav_path(block_id).exists():
            return entry.get("lane")
        return None

    def save(
        self, block_id: str, pcm: bytes, sr: int, lane: str, engine: str, **meta: Any
    ) -> dict[str, Any]:
        self.root.mkdir(parents=True, exist_ok=True)
        previous = self.lane(block_id)
        tmp = self.root / f".{block_id}.wav.tmp"
        with wave.open(str(tmp), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm)
        os.replace(tmp, self.wav_path(block_id))
        entry = {
            "lane": lane,
            "engine": engine,
            "duration": round(len(pcm) / 2 / sr, 2),
            "rendered_at": _iso(self._clock()),
            "upgraded": previous == "fast" and lane == "expressive",
            **meta,
        }
        idx = self.index()
        idx[block_id] = entry
        self._write_index(idx)
        return entry

    def prune(self, days: int = CACHE_DAYS) -> list[str]:
        """Drop audio rendered more than ``days`` ago (and orphaned WAVs)."""
        cutoff = self._clock() - timedelta(days=days)
        idx = self.index()
        gone = [
            k
            for k, v in idx.items()
            if (_parse(v.get("rendered_at")) or cutoff) <= cutoff
        ]
        for k in gone:
            self.wav_path(k).unlink(missing_ok=True)
            idx.pop(k, None)
        if gone:
            self._write_index(idx)
        for wav in self.root.glob("*.wav"):
            if wav.stem not in idx:
                mtime = datetime.fromtimestamp(wav.stat().st_mtime, timezone.utc)
                if mtime <= cutoff:
                    wav.unlink(missing_ok=True)
        return gone


# ---------- engines (protocols) and the queue walk ----------


class FastEngine(Protocol):
    name: str

    def render(self, text: str) -> tuple[bytes, int]: ...


class ExpressiveEngine(Protocol):
    name: str

    def load(self) -> None: ...

    def render_chunk(self, text: str, exaggeration: float) -> tuple[bytes, int]: ...

    def unload(self) -> None: ...


@dataclass
class Walker:
    """One pass over voice_queue per tick (the service calls it every minute)."""

    fetch_queue: Callable[[], list[dict[str, Any]]]
    cache: AudioCache
    lease: GpuLease
    fast: FastEngine
    expressive: ExpressiveEngine
    clock: Callable[[], datetime] = utcnow
    fallback_after: timedelta = FALLBACK_AFTER
    first_seen: dict[str, datetime] = field(default_factory=dict)
    last: dict[str, Any] = field(default_factory=dict)

    def _appeared(self, item: dict[str, Any]) -> datetime:
        seen = self.first_seen.setdefault(item["id"], self.clock())
        created = _parse(item.get("created_at"))
        return min(seen, created) if created else seen

    def _meta(self, item: dict[str, Any]) -> dict[str, Any]:
        return {k: item.get(k) for k in ("title", "source_feed", "mood", "priority")}

    def render_fast(self, item: dict[str, Any]) -> dict[str, Any]:
        t0 = time.perf_counter()
        pcm, sr = self.fast.render(item["text"])
        return self.cache.save(
            item["id"],
            pcm,
            sr,
            "fast",
            self.fast.name,
            render_s=round(time.perf_counter() - t0, 1),
            **self._meta(item),
        )

    def render_expressive(self, item: dict[str, Any]) -> dict[str, Any]:
        """Chunked, with the lease renewed before every chunk."""
        exaggeration = exaggeration_for(item.get("mood"))
        t0 = time.perf_counter()
        parts: list[bytes] = []
        sr = 24000
        for chunk in chunk_text(item["text"]):
            self.lease.renew(item["id"])
            pcm, sr = self.expressive.render_chunk(chunk, exaggeration)
            parts += [pcm, silence(sr)]
        return self.cache.save(
            item["id"],
            b"".join(parts),
            sr,
            "expressive",
            self.expressive.name,
            exaggeration=exaggeration,
            render_s=round(time.perf_counter() - t0, 1),
            **self._meta(item),
        )

    def tick(self) -> dict[str, Any]:
        try:
            items = [
                i
                for i in self.fetch_queue()
                if isinstance(i.get("id"), str) and i.get("text")
            ]
        except Exception as exc:  # noqa: BLE001 -- the bridge may be down; try next minute
            self.last = {"at": _iso(self.clock()), "error": f"queue: {exc}"}
            return self.last
        done: list[str] = []
        for item in (
            i for i in items if i.get("lane") == "fast" and not self.cache.lane(i["id"])
        ):
            self.render_fast(item)
            done.append(f"{item['id']}:fast")

        pending = sorted(
            (
                i
                for i in items
                if i.get("lane", "expressive") != "fast"
                and self.cache.lane(i["id"]) != "expressive"
            ),
            key=lambda i: i.get("order", 0),
        )
        waiting = ""
        if pending:
            if self.lease.acquire(pending[0]["id"]):
                try:
                    self.expressive.load()
                    for item in pending:
                        self.render_expressive(item)
                        done.append(f"{item['id']}:expressive")
                finally:
                    try:
                        self.expressive.unload()
                    finally:
                        self.lease.release()
            else:
                waiting = self.lease.availability()[1]
                now = self.clock()
                for item in pending:
                    if (
                        not self.cache.lane(item["id"])
                        and now - self._appeared(item) >= self.fallback_after
                    ):
                        self.render_fast(item)
                        done.append(f"{item['id']}:fast-fallback")
        self.cache.prune()
        live = {i["id"] for i in items}
        self.first_seen = {k: v for k, v in self.first_seen.items() if k in live}
        self.last = {
            "at": _iso(self.clock()),
            "items": len(items),
            "rendered": done,
            "gpu_wait": waiting,
        }
        return self.last
