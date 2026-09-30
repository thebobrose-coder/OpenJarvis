"""Voice worker logic with the engines, GPU probes and clock faked."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from openjarvis.voice_worker.core import (
    HOLDER,
    AudioCache,
    GpuLease,
    Walker,
    chunk_text,
    exaggeration_for,
    silence,
)

T0 = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self, now: datetime = T0) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kw) -> None:
        self.now += timedelta(**kw)


class FakeFast:
    name = "fake-fast"

    def __init__(self) -> None:
        self.calls: list[str] = []

    def render(self, text: str):
        self.calls.append(text)
        return b"\x01\x00" * 2400, 24000  # 0.1 s


class FakeExpressive:
    name = "fake-expressive"

    def __init__(self, fail_on: str | None = None) -> None:
        self.loaded = False
        self.loads = 0
        self.chunks: list[tuple[str, float]] = []
        self.fail_on = fail_on

    def load(self) -> None:
        self.loaded = True
        self.loads += 1

    def render_chunk(self, text: str, exaggeration: float):
        assert self.loaded, "render before load"
        if self.fail_on and self.fail_on in text:
            raise RuntimeError("boom")
        self.chunks.append((text, exaggeration))
        return b"\x02\x00" * 4800, 24000  # 0.2 s

    def unload(self) -> None:
        self.loaded = False


class Gpu:
    def __init__(self) -> None:
        self.loaded: list[str] = []
        self.free = 9000

    def ollama(self) -> list[str]:
        return list(self.loaded)

    def free_mib(self) -> int:
        return self.free


def block(
    i: int,
    lane: str = "expressive",
    mood: str = "neutral",
    text: str | None = None,
    created: datetime = T0,
):
    return {
        "id": f"{i:016x}",
        "title": f"Sample block {i}",
        "text": text or f"Sample sentence {i}. Another sample sentence.",
        "mood": mood,
        "priority": "briefing",
        "lane": lane,
        "created_at": created.isoformat().replace("+00:00", "Z"),
        "source_feed": "sample_feed",
        "order": i,
    }


@pytest.fixture
def rig(tmp_path: Path):
    clock, gpu = Clock(), Gpu()
    lease = GpuLease(
        tmp_path / "gpu" / "lease.json", gpu.ollama, gpu.free_mib, clock=clock
    )
    cache = AudioCache(tmp_path / "cache", clock=clock)
    queue: list[dict] = []
    fast, expr = FakeFast(), FakeExpressive()
    walker = Walker(lambda: list(queue), cache, lease, fast, expr, clock=clock)
    return {
        "clock": clock,
        "gpu": gpu,
        "lease": lease,
        "cache": cache,
        "queue": queue,
        "fast": fast,
        "expr": expr,
        "walker": walker,
    }


# ---------- chunking and moods ----------


def test_chunks_stay_under_280_on_sentence_boundaries():
    sentence = "This is a sample sentence of moderate length for chunking. "
    text = (sentence * 12).strip()
    chunks = chunk_text(text)
    assert len(chunks) > 1
    assert all(len(c) <= 280 for c in chunks)
    assert all(c.endswith(".") for c in chunks)
    assert " ".join(chunks) == text


def test_paragraph_breaks_end_a_chunk_and_long_sentences_split_at_spaces():
    assert chunk_text("First topic.\n\nSecond topic.") == [
        "First topic.",
        "Second topic.",
    ]
    long = "word " * 100
    chunks = chunk_text(long.strip())
    assert all(len(c) <= 280 for c in chunks)
    assert " ".join(chunks).split() == long.split()


def test_mood_map():
    assert exaggeration_for("neutral") == 0.5
    assert exaggeration_for("upbeat") == 0.6
    assert exaggeration_for("grave") == 0.45
    assert exaggeration_for("dry") == 0.4
    assert exaggeration_for("unknown") == 0.5
    assert exaggeration_for(None) == 0.5


# ---------- lease ----------


def test_lease_only_when_ollama_idle_and_memory_free(rig):
    lease, gpu = rig["lease"], rig["gpu"]
    gpu.loaded = ["sample-model"]
    assert not lease.acquire("x") and not lease.path.exists()
    gpu.loaded, gpu.free = [], 5000
    assert not lease.acquire("x") and not lease.path.exists()
    gpu.free = 6144
    assert lease.acquire("x")
    doc = json.loads(lease.path.read_text())
    assert doc["holder"] == HOLDER and doc["purpose"] == "x"
    assert doc["acquired_at"] == "2026-09-30T12:00:00Z"
    assert doc["expires_at"] == "2026-09-30T12:10:00Z"
    lease.release()
    assert not lease.path.exists()


def test_lease_write_is_atomic(rig, monkeypatch):
    lease = rig["lease"]
    replaced: list[tuple[str, str]] = []
    real = os.replace
    monkeypatch.setattr(
        os, "replace", lambda a, b: (replaced.append((str(a), str(b))), real(a, b))
    )
    assert lease.acquire("x")
    src, dst = replaced[-1]
    assert dst == str(lease.path) and src != dst and src.endswith(".tmp")
    assert not list(lease.path.parent.glob("*.tmp"))


def test_lease_renewal_moves_expiry_not_acquired(rig):
    lease, clock = rig["lease"], rig["clock"]
    assert lease.acquire("x")
    clock.advance(minutes=4)
    lease.renew("y")
    doc = json.loads(lease.path.read_text())
    assert doc["acquired_at"] == "2026-09-30T12:00:00Z"
    assert doc["expires_at"] == "2026-09-30T12:14:00Z"
    assert doc["purpose"] == "y"


def test_foreign_fresh_lease_is_respected_and_stale_one_is_not(rig):
    lease, clock = rig["lease"], rig["clock"]
    lease.path.parent.mkdir(parents=True)
    foreign = {
        "holder": "someone-else",
        "purpose": "p",
        "acquired_at": "2026-09-30T11:55:00Z",
        "expires_at": "2026-09-30T12:05:00Z",
    }
    lease.path.write_text(json.dumps(foreign))
    assert not lease.acquire("x")
    assert json.loads(lease.path.read_text())["holder"] == "someone-else"
    clock.advance(minutes=6)  # past expires_at
    assert lease.acquire("x")
    lease.release()
    # Older than 15 minutes counts as stale even if expires_at is later.
    lease.path.write_text(
        json.dumps(
            {
                **foreign,
                "acquired_at": "2026-09-30T11:40:00Z",
                "expires_at": "2026-09-30T13:00:00Z",
            }
        )
    )
    assert lease.acquire("x")


def test_our_own_leftover_lease_is_taken_over(rig):
    lease = rig["lease"]
    lease.path.parent.mkdir(parents=True)
    lease.path.write_text(
        json.dumps(
            {
                "holder": HOLDER,
                "purpose": "old",
                "acquired_at": "2026-09-30T11:59:00Z",
                "expires_at": "2026-09-30T12:09:00Z",
            }
        )
    )
    assert lease.acquire("x")


def test_release_never_deletes_a_foreign_lease(rig):
    lease = rig["lease"]
    assert lease.acquire("x")
    lease.path.write_text(json.dumps({"holder": "someone-else"}))
    lease.release()
    assert lease.path.exists()


# ---------- queue walk ----------


def test_expressive_render_holds_and_releases_the_lease(rig):
    rig["queue"] += [block(1, mood="dry"), block(2, lane="fast")]
    seen: list[bool] = []
    real = rig["expr"].render_chunk
    rig["expr"].render_chunk = lambda t, e: (
        seen.append(rig["lease"].path.exists()),
        real(t, e),
    )[1]
    out = rig["walker"].tick()
    assert out["rendered"] == [f"{2:016x}:fast", f"{1:016x}:expressive"]
    assert seen and all(seen)
    assert not rig["lease"].path.exists() and not rig["expr"].loaded
    assert {e for _, e in rig["expr"].chunks} == {0.4}
    assert rig["cache"].lane(f"{1:016x}") == "expressive"
    assert rig["cache"].lane(f"{2:016x}") == "fast"
    # Nothing left to do: no new renders, no lease.
    assert rig["walker"].tick()["rendered"] == []
    assert rig["expr"].loads == 1


def test_expressive_audio_has_gaps_between_chunks(rig):
    rig["queue"].append(block(1, text="One.\n\nTwo."))
    rig["walker"].tick()
    entry = rig["cache"].index()[f"{1:016x}"]
    # two 0.2 s chunks + two 0.25 s gaps
    assert entry["duration"] == pytest.approx(0.9, abs=0.01)
    assert len(silence(24000)) == 12000


def test_lease_deleted_when_a_render_fails(rig):
    rig["expr"].fail_on = "boom-text"
    rig["queue"].append(block(1, text="boom-text here."))
    with pytest.raises(RuntimeError):
        rig["walker"].tick()
    assert not rig["lease"].path.exists() and not rig["expr"].loaded
    assert rig["cache"].lane(f"{1:016x}") is None


def test_busy_gpu_falls_back_to_fast_after_20_minutes_then_upgrades(rig):
    clock, gpu = rig["clock"], rig["gpu"]
    gpu.loaded = ["sample-model"]
    rig["queue"].append(block(1, created=T0))
    out = rig["walker"].tick()
    assert out["rendered"] == [] and "loaded" in out["gpu_wait"]
    clock.advance(minutes=19)
    assert rig["walker"].tick()["rendered"] == []
    clock.advance(minutes=1)
    assert rig["walker"].tick()["rendered"] == [f"{1:016x}:fast-fallback"]
    assert rig["cache"].lane(f"{1:016x}") == "fast"
    clock.advance(minutes=5)
    assert rig["walker"].tick()["rendered"] == []  # still busy: no re-render
    gpu.loaded = []
    assert rig["walker"].tick()["rendered"] == [f"{1:016x}:expressive"]
    entry = rig["cache"].index()[f"{1:016x}"]
    assert entry["lane"] == "expressive" and entry["upgraded"] is True
    assert len(rig["fast"].calls) == 1


def test_fallback_deadline_counts_from_created_at(rig):
    """The deadline counts from the earlier of created_at and first sight, so
    an old item seen after a worker restart falls back at once."""
    rig["gpu"].loaded = ["sample-model"]
    rig["queue"].append(block(1, created=T0 - timedelta(hours=2)))
    assert rig["walker"].tick()["rendered"] == [f"{1:016x}:fast-fallback"]


def test_fake_busy_flag_blocks_the_lease(rig, tmp_path):
    flag = {"on": True}
    lease = GpuLease(
        tmp_path / "l.json",
        rig["gpu"].ollama,
        rig["gpu"].free_mib,
        clock=rig["clock"],
        fake_busy=lambda: flag["on"],
    )
    assert not lease.acquire("x") and lease.availability()[1] == "fake-busy flag"
    flag["on"] = False
    assert lease.acquire("x")


def test_queue_errors_are_reported_not_raised(rig):
    def broken():
        raise OSError("bridge down")

    rig["walker"].fetch_queue = broken
    assert "bridge down" in rig["walker"].tick()["error"]


# ---------- cache ----------


def test_cache_prune_after_14_days(rig, tmp_path):
    cache, clock = rig["cache"], rig["clock"]
    cache.save(f"{1:016x}", b"\x00\x00" * 10, 24000, "fast", "fake")
    clock.advance(days=10)
    cache.save(f"{2:016x}", b"\x00\x00" * 10, 24000, "fast", "fake")
    clock.advance(days=4, minutes=1)
    assert cache.prune() == [f"{1:016x}"]
    assert not cache.wav_path(f"{1:016x}").exists()
    assert cache.lane(f"{2:016x}") == "fast"
    assert set(cache.index()) == {f"{2:016x}"}
