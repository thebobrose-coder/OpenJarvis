"""The long-form lane: episode narration for the local studio
(foundry-studio.md "Narration", hq 0019). Stdlib only, like core.py; the
engines and the Kokoro reference builder are injected.

The studio writes ``<root>/<propertyId>/<episodeId>/narration.request.json``.
This lane renders it in the character's own voice (Chatterbox conditioned on
a Kokoro reference built from ``voice.referenceVoice``), beat by beat, under
the GPU lease, and writes ``narration.wav``, ``timing.json`` and, last,
``narration.result.json``. Finished beats live in the worker's own folder
until the episode is done, so a request resumes from the next unrendered beat
after the 15-minute hold. Kokoro is never the voice of a long-form render."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from .core import (
    ExpressiveEngine,
    GpuLease,
    _iso,
    _parse,
    chunk_text,
    silence,
    utcnow,
)

logger = logging.getLogger("openjarvis.voice_worker")

REQUEST = "narration.request.json"
RESULT = "narration.result.json"
NARRATION = "narration.wav"
TIMING = "timing.json"

SAMPLE_RATE = 24000
MAX_HOLD = timedelta(minutes=15)
CHUNK_ALLOWANCE = timedelta(minutes=1)  # no new chunk this close to the hold limit
GIVE_UP = timedelta(hours=6)
BEAT_GAP_SECONDS = 0.6

# The assistant's own voice is Chatterbox on a Kokoro bm_george
# reference; a character never speaks with it (0019).
ASSISTANT_VOICE = "bm_george"
KOKORO_VOICE = re.compile(r"^[ab][fm]_[a-z]+$")


class RequestError(Exception):
    """A request the lane can never render; it gets ``ok: false``."""


# ---------- the script ----------

_HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_DIRECTION = re.compile(r"\[[^\]]*\]")
_URL = re.compile(r"https?://\S+")
_MARKUP = re.compile(r"[*_`~]+")
_LIST = re.compile(r"^\s*(?:[-+>]|\d+[.)])\s+")


def speakable(text: str) -> str:
    """Markdown to the words to say: links keep their text; comments, URLs,
    bracketed directions and emphasis marks go."""
    text = _COMMENT.sub(" ", text)
    text = _LINK.sub(r"\1", text)
    text = _DIRECTION.sub(" ", text)
    text = _URL.sub(" ", text)
    lines = []
    for line in text.splitlines():
        line = _MARKUP.sub("", _LIST.sub("", line))
        lines.append(re.sub(r"[ \t]+", " ", line).strip())
    return "\n".join(lines).strip()


def split_beats(markdown: str) -> list[str]:
    """One beat per section: a markdown heading starts the next one, and text
    before the first heading is a beat of its own. Beat ``n`` in timing.json
    is the n-th non-empty section, counting from 1."""
    sections: list[list[str]] = [[]]
    for line in markdown.splitlines():
        if _HEADING.match(line):
            sections.append([])
        else:
            sections[-1].append(line)
    beats = (speakable("\n".join(s)) for s in sections)
    return [b for b in beats if b]


def _pairs(pronunciations: Any) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for p in pronunciations or []:
        if isinstance(p, dict):
            word = next(
                (p[k] for k in ("word", "from", "text", "term") if k in p), None
            )
            say = next((p[k] for k in ("say", "to", "as", "spoken") if k in p), None)
        elif isinstance(p, (list, tuple)) and len(p) == 2:
            word, say = p
        else:
            continue
        if isinstance(word, str) and word.strip() and isinstance(say, str):
            out.append((word.strip(), say))
    return out


def apply_pronunciations(text: str, pronunciations: Any) -> str:
    """``voice.pronunciations`` before chunking: whole words, any case.
    An entry is ``{word, say}`` (``from``/``to`` also read) or a pair."""
    for word, say in sorted(_pairs(pronunciations), key=lambda p: -len(p[0])):
        left = r"\b" if re.match(r"\w", word) else ""
        right = r"\b" if re.search(r"\w$", word) else ""
        text = re.sub(
            f"{left}{re.escape(word)}{right}",
            lambda _m, s=say: s,
            text,
            flags=re.IGNORECASE,
        )
    return text


# ---------- the request ----------


@dataclass
class Voice:
    reference: str
    exaggeration: float
    pace: float
    pronunciations: list[Any]


def parse_voice(raw: Any) -> Voice:
    if not isinstance(raw, dict):
        raise RequestError("bad-request: voice missing")
    ref = raw.get("referenceVoice")
    if ref is None:
        raise RequestError("voice-not-picked")
    if not isinstance(ref, str) or not KOKORO_VOICE.match(ref):
        raise RequestError("bad-request: referenceVoice is not a Kokoro voice id")
    if ref == ASSISTANT_VOICE:
        raise RequestError("bad-request: referenceVoice is the assistant's voice")

    def num(key: str, default: float, lo: float, hi: float) -> float:
        v = raw.get(key, default)
        if v is None:
            v = default
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise RequestError(f"bad-request: {key} is not a number")
        return min(hi, max(lo, float(v)))

    prons = raw.get("pronunciations") or []
    if not isinstance(prons, list):
        raise RequestError("bad-request: pronunciations is not a list")
    return Voice(
        ref,
        num("exaggeration", 0.5, 0.0, 2.0),
        num("pace", 1.0, 0.5, 2.0),
        prons,
    )


@dataclass
class Job:
    folder: Path
    episode_id: str
    voice: Voice
    beats: list[str]
    requested_at: datetime | None

    @property
    def key(self) -> str:
        """Changes when the words or the voice do; old partial beats then go."""
        doc = json.dumps(
            {
                "beats": self.beats,
                "ref": self.voice.reference,
                "ex": self.voice.exaggeration,
                "pace": self.voice.pace,
            },
            sort_keys=True,
        )
        return hashlib.sha256(doc.encode()).hexdigest()[:16]


def load_job(request: Path) -> Job:
    folder = request.parent
    try:
        raw = json.loads(request.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RequestError(f"bad-request: {exc}") from exc
    if not isinstance(raw, dict):
        raise RequestError("bad-request: not an object")
    episode = raw.get("episodeId")
    if not isinstance(episode, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]{1,64}", episode
    ):
        raise RequestError("bad-request: episodeId")
    voice = parse_voice(raw.get("voice"))
    script_raw = raw.get("scriptPath") or "script.md"
    if not isinstance(script_raw, str):
        raise RequestError("bad-request: scriptPath")
    script = Path(script_raw)
    script = (script if script.is_absolute() else folder / script).resolve()
    if not script.is_relative_to(folder.resolve()):
        raise RequestError("bad-request: scriptPath outside the episode folder")
    try:
        markdown = script.read_text(encoding="utf-8")
    except OSError as exc:
        raise RequestError(f"script-unreadable: {exc}") from exc
    beats = [
        apply_pronunciations(b, voice.pronunciations) for b in split_beats(markdown)
    ]
    if not beats:
        raise RequestError("empty-script")
    return Job(folder, episode, voice, beats, _parse(raw.get("requestedAt")))


# ---------- files ----------


def _write_json(path: Path, doc: Any) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _write_wav(path: Path, pcm: bytes, sr: int) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    os.replace(tmp, path)


def _read_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        return w.readframes(w.getnframes())


# ---------- the lane ----------


@dataclass
class LongForm:
    """One request per tick, oldest first. ``reference_for(voice, pace)``
    returns the cached Kokoro reference clip; ``make_engine(reference,
    exaggeration)`` returns an unloaded Chatterbox engine conditioned on it."""

    root: Path
    work: Path
    lease: GpuLease
    reference_for: Callable[[str, float], Path]
    make_engine: Callable[[Path, float], ExpressiveEngine]
    clock: Callable[[], datetime] = utcnow
    max_hold: timedelta = MAX_HOLD
    give_up: timedelta = GIVE_UP
    last: dict[str, Any] = field(default_factory=dict)

    def pending(self) -> list[Path]:
        """Requests with no result yet, oldest ``requestedAt`` first."""
        found = []
        for req in self.root.glob(f"*/*/{REQUEST}"):
            if (req.parent / RESULT).exists():
                continue
            try:
                raw = json.loads(req.read_text(encoding="utf-8"))
                at = _parse(raw.get("requestedAt")) if isinstance(raw, dict) else None
            except (OSError, ValueError):
                at = None
            stamp = at.timestamp() if at else req.stat().st_mtime
            found.append((stamp, str(req), req))
        return [r for _, _, r in sorted(found)]

    # partial beats, in the worker's own folder (never the studio's)
    def _parts(self, job: Job) -> Path:
        d = self.work / job.episode_id
        state = self._state(d)
        if state.get("key") != job.key:
            shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True, exist_ok=True)
            started = job.requested_at or self.clock()
            _write_json(
                d / "state.json",
                {"key": job.key, "gpu_s": 0.0, "progress_at": _iso(started)},
            )
        return d

    @staticmethod
    def _state(d: Path) -> dict[str, Any]:
        try:
            data = json.loads((d / "state.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _bump(self, d: Path, gpu_s: float = 0.0, progress: bool = False) -> None:
        state = self._state(d)
        state["gpu_s"] = round(float(state.get("gpu_s", 0.0)) + gpu_s, 1)
        if progress:
            state["progress_at"] = _iso(self.clock())
        _write_json(d / "state.json", state)

    @staticmethod
    def _beat(d: Path, n: int) -> Path:
        return d / f"beat-{n:02d}.wav"

    def _finish(self, folder: Path, doc: dict[str, Any]) -> dict[str, Any]:
        result = {"ok": False, "at": _iso(self.clock()), "engine": "chatterbox", **doc}
        _write_json(folder / RESULT, result)
        return result

    def _assemble(self, job: Job, d: Path) -> dict[str, Any]:
        pcm: list[bytes] = []
        timing = []
        t = 0.0
        for n in range(1, len(job.beats) + 1):
            if n > 1:
                gap = silence(SAMPLE_RATE, BEAT_GAP_SECONDS)
                pcm.append(gap)
                t += len(gap) / 2 / SAMPLE_RATE
            beat = _read_pcm(self._beat(d, n))
            pcm.append(beat)
            end = t + len(beat) / 2 / SAMPLE_RATE
            timing.append({"beat": n, "startSec": round(t, 3), "endSec": round(end, 3)})
            t = end
        _write_wav(job.folder / NARRATION, b"".join(pcm), SAMPLE_RATE)
        _write_json(job.folder / TIMING, timing)
        result = self._finish(
            job.folder,
            {
                "ok": True,
                "seconds": round(t, 2),
                "gpuMinutes": round(float(self._state(d).get("gpu_s", 0.0)) / 60, 2),
            },
        )
        shutil.rmtree(d, ignore_errors=True)
        logger.info("Long-form %s narrated: %s", job.episode_id, result)
        return result

    def _render(self, job: Job, d: Path, todo: list[int]) -> list[int]:
        """Beats rendered under one hold of the lease (already taken)."""
        started = self.clock()
        t0 = time.perf_counter()
        purpose = f"long-form:{job.episode_id}"
        done: list[int] = []
        engine = self.make_engine(
            self.reference_for(job.voice.reference, job.voice.pace),
            job.voice.exaggeration,
        )
        try:
            engine.load()
            for n in todo:
                parts: list[bytes] = []
                for chunk in chunk_text(job.beats[n - 1]):
                    if self.clock() - started >= self.max_hold - CHUNK_ALLOWANCE:
                        logger.info(
                            "Long-form %s: hold limit, resuming at beat %d",
                            job.episode_id,
                            n,
                        )
                        return done
                    self.lease.renew(purpose)
                    pcm, sr = engine.render_chunk(chunk, job.voice.exaggeration)
                    if sr != SAMPLE_RATE:
                        raise RuntimeError(
                            f"engine rate {sr} Hz, expected {SAMPLE_RATE}"
                        )
                    if parts:
                        parts.append(silence(sr))
                    parts.append(pcm)
                _write_wav(self._beat(d, n), b"".join(parts), SAMPLE_RATE)
                self._bump(d, progress=True)
                done.append(n)
            return done
        finally:
            try:
                engine.unload()
            finally:
                self.lease.release()
                self._bump(d, gpu_s=time.perf_counter() - t0)

    def tick(self) -> dict[str, Any]:
        now = self.clock()
        queue = self.pending()
        if not queue:
            self.last = {"at": _iso(now), "pending": 0}
            return self.last
        request = queue[0]
        try:
            job = load_job(request)
        except RequestError as exc:
            self._finish(request.parent, {"error": str(exc)})
            logger.warning(
                "Long-form request refused (%s): %s", request.parent.name, exc
            )
            self.last = {"at": _iso(now), "pending": len(queue), "refused": str(exc)}
            return self.last
        d = self._parts(job)
        todo = [
            n for n in range(1, len(job.beats) + 1) if not self._beat(d, n).exists()
        ]
        status: dict[str, Any] = {
            "at": _iso(now),
            "pending": len(queue),
            "episode": job.episode_id,
            "beats": len(job.beats),
        }
        if todo:
            if not self.lease.acquire(f"long-form:{job.episode_id}"):
                status["gpu_wait"] = self.lease.availability()[1]
                since = _parse(self._state(d).get("progress_at")) or now
                if now - since >= self.give_up:
                    self._finish(job.folder, {"error": "lease-unavailable"})
                    shutil.rmtree(d, ignore_errors=True)
                    status["result"] = "lease-unavailable"
                self.last = status
                return self.last
            try:
                status["rendered"] = self._render(job, d, todo)
            except Exception as exc:  # noqa: BLE001 -- the lease is released; retry next tick
                logger.exception("Long-form %s render failed", job.episode_id)
                status["error"] = str(exc)
                self.last = status
                return self.last
            todo = [n for n in todo if n not in status["rendered"]]
        if not todo:
            status["result"] = "ok"
            self._assemble(job, d)
        self.last = status
        return self.last
