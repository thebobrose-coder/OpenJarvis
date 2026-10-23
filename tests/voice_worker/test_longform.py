"""The long-form lane (foundry-studio.md "Narration") with the engine, GPU
probes and clock faked."""

from __future__ import annotations

import json
import wave
from datetime import timedelta
from pathlib import Path

import pytest

from openjarvis.voice_worker.core import GpuLease
from openjarvis.voice_worker.longform import (
    BEAT_GAP_SECONDS,
    LongForm,
    RequestError,
    apply_pronunciations,
    load_job,
    parse_voice,
    speakable,
    split_beats,
)

from .test_core import T0, Clock, Gpu

SR = 24000
CHUNK_SECONDS = 0.2

SCRIPT = """\
## Cold open

The first sample line. A second sample line.

## Beat one

Sample beat text with [a link](https://example.com) and **emphasis**. [pause]

## Beat two

<!-- a note for the editor -->
The last sample line.
"""

VOICE = {
    "referenceVoice": "am_sample",
    "exaggeration": 0.6,
    "pace": 1.0,
    "pronunciations": [],
}


class Engine:
    """Each chunk takes ``minutes`` on the fake clock."""

    def __init__(self, clock: Clock, minutes: float = 0.5, fail: bool = False):
        self.clock, self.minutes, self.fail = clock, minutes, fail
        self.loaded = False
        self.chunks: list[tuple[str, float]] = []

    def load(self) -> None:
        self.loaded = True

    def render_chunk(self, text: str, exaggeration: float):
        assert self.loaded
        if self.fail:
            raise RuntimeError("boom")
        self.clock.advance(minutes=self.minutes)
        self.chunks.append((text, exaggeration))
        return b"\x03\x00" * int(SR * CHUNK_SECONDS), SR

    def unload(self) -> None:
        self.loaded = False


def episode(root: Path, eid: str = "EP1", voice=VOICE, script=SCRIPT, at=T0) -> Path:
    folder = root / "prop-a" / eid
    folder.mkdir(parents=True)
    (folder / "script.md").write_text(script, encoding="utf-8")
    (folder / "narration.request.json").write_text(
        json.dumps(
            {
                "episodeId": eid,
                "propertyId": "prop-a",
                "voice": voice,
                "scriptPath": "script.md",
                "requestedAt": at.isoformat().replace("+00:00", "Z"),
            }
        ),
        encoding="utf-8",
    )
    return folder


@pytest.fixture
def rig(tmp_path: Path):
    clock, gpu = Clock(), Gpu()
    lease = GpuLease(
        tmp_path / "gpu" / "lease.json", gpu.ollama, gpu.free_mib, clock=clock
    )
    engines: list[Engine] = []
    refs: list[tuple[str, float]] = []
    state = {"minutes": 0.5, "fail": False}

    def make_engine(ref: Path, ex: float) -> Engine:
        assert ref.name.startswith("am_sample")
        e = Engine(clock, state["minutes"], state["fail"])
        engines.append(e)
        return e

    def reference_for(voice: str, pace: float) -> Path:
        refs.append((voice, pace))
        return tmp_path / "refs" / f"{voice}@{pace:.2f}.wav"

    root = tmp_path / "studio"
    root.mkdir()
    lane = LongForm(
        root, tmp_path / "parts", lease, reference_for, make_engine, clock=clock
    )
    return {
        "clock": clock,
        "gpu": gpu,
        "lease": lease,
        "lane": lane,
        "root": root,
        "engines": engines,
        "refs": refs,
        "state": state,
        "parts": tmp_path / "parts",
    }


def result(folder: Path) -> dict:
    return json.loads((folder / "narration.result.json").read_text(encoding="utf-8"))


# ---------- the script ----------


def test_split_beats_one_per_section_and_markup_stripped():
    beats = split_beats(SCRIPT)
    assert beats == [
        "The first sample line. A second sample line.",
        "Sample beat text with a link and emphasis.",
        "The last sample line.",
    ]


def test_text_before_the_first_heading_is_a_beat():
    assert split_beats("Intro line.\n\n# One\nBody.") == ["Intro line.", "Body."]


def test_speakable_drops_urls_and_list_marks():
    assert speakable("- see https://example.com now\n> quoted") == "see now\nquoted"


def test_pronunciations_whole_word_any_case():
    prons = [{"word": "ZORP", "say": "zorp-ee"}, ["Qx", "queue ex"]]
    out = apply_pronunciations("Zorp met zorpish Qx. qx!", prons)
    assert out == "zorp-ee met zorpish queue ex. queue ex!"


def test_pronunciations_applied_before_chunking(rig):
    voice = {**VOICE, "pronunciations": [{"from": "sample", "to": "SAMPEL"}]}
    folder = episode(rig["root"], voice=voice)
    job = load_job(folder / "narration.request.json")
    assert all("sample" not in b for b in job.beats)
    assert "SAMPEL" in job.beats[0]


# ---------- the voice ----------


def test_null_voice_is_an_error_never_a_fallback(rig):
    folder = episode(rig["root"], voice={**VOICE, "referenceVoice": None})
    rig["lane"].tick()
    r = result(folder)
    assert r == {**r, "ok": False, "error": "voice-not-picked"}
    assert rig["engines"] == [] and not (folder / "narration.wav").exists()


@pytest.mark.parametrize("ref", ["bm_george", "not a voice", 3])
def test_assistant_and_bad_voices_refused(ref):
    with pytest.raises(RequestError):
        parse_voice({**VOICE, "referenceVoice": ref})


def test_script_outside_the_episode_folder_refused(rig):
    folder = episode(rig["root"])
    req = folder / "narration.request.json"
    doc = json.loads(req.read_text())
    doc["scriptPath"] = "../../../secret.md"
    req.write_text(json.dumps(doc))
    rig["lane"].tick()
    assert "outside" in result(folder)["error"]


# ---------- rendering ----------


def test_request_renders_wav_timing_and_result(rig):
    folder = episode(rig["root"])
    status = rig["lane"].tick()
    assert status["result"] == "ok" and status["rendered"] == [1, 2, 3]
    engine = rig["engines"][0]
    assert {ex for _, ex in engine.chunks} == {0.6}
    assert rig["refs"] == [("am_sample", 1.0)]

    timing = json.loads((folder / "timing.json").read_text())
    assert [t["beat"] for t in timing] == [1, 2, 3]
    # one chunk per beat here: 0.2 s each, 0.6 s between beats
    assert timing[0] == {"beat": 1, "startSec": 0.0, "endSec": 0.2}
    assert timing[1]["startSec"] == pytest.approx(0.2 + BEAT_GAP_SECONDS)
    assert timing[2]["endSec"] == pytest.approx(3 * 0.2 + 2 * BEAT_GAP_SECONDS)

    with wave.open(str(folder / "narration.wav"), "rb") as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (SR, 1, 2)
        assert w.getnframes() / SR == pytest.approx(timing[-1]["endSec"])

    r = result(folder)
    assert r["ok"] is True and r["engine"] == "chatterbox"
    assert r["seconds"] == pytest.approx(timing[-1]["endSec"], abs=0.01)
    assert "gpuMinutes" in r and "error" not in r
    assert not rig["lease"].path.exists()  # released
    assert not (rig["parts"] / "EP1").exists()  # partials cleaned up
    assert rig["lane"].pending() == []


def test_chunks_within_a_beat_join_with_short_gaps(rig):
    long_beat = " ".join(f"Sample sentence number {i} goes here." for i in range(20))
    folder = episode(rig["root"], script=f"# Only\n{long_beat}\n")
    rig["lane"].tick()
    n = len(rig["engines"][0].chunks)
    assert n > 1
    timing = json.loads((folder / "timing.json").read_text())
    assert timing[0]["endSec"] == pytest.approx(n * 0.2 + (n - 1) * 0.25, abs=0.001)


def test_lease_held_at_most_15_minutes_then_resumes_by_beat(rig):
    rig["state"]["minutes"] = 7  # each chunk takes 7 minutes on the clock
    folder = episode(rig["root"])
    first = rig["lane"].tick()
    # chunks start at 0 and 7 minutes; at 14 the next one would cross the 15-minute hold
    assert first["rendered"] == [1, 2] and "result" not in first
    assert not rig["lease"].path.exists()
    assert not (folder / "narration.result.json").exists()
    assert (rig["parts"] / "EP1" / "beat-01.wav").exists()

    second = rig["lane"].tick()
    assert second["rendered"] == [3] and second["result"] == "ok"
    assert len(rig["engines"][1].chunks) == 1  # beats 1-2 were not rendered again
    assert result(folder)["ok"] is True


def test_lease_renewed_before_every_chunk(rig, monkeypatch):
    renewed = []
    real = rig["lease"].renew
    monkeypatch.setattr(rig["lease"], "renew", lambda p: (renewed.append(p), real(p)))
    episode(rig["root"])
    rig["lane"].tick()
    assert renewed == ["long-form:EP1"] * 3


def test_waits_for_the_lease_then_gives_up_after_6_hours(rig):
    rig["gpu"].loaded = ["some-model"]
    folder = episode(rig["root"])
    status = rig["lane"].tick()
    assert "ollama" in status["gpu_wait"]
    assert rig["engines"] == []
    rig["clock"].advance(hours=5, minutes=59)
    rig["lane"].tick()
    assert not (folder / "narration.result.json").exists()
    rig["clock"].advance(minutes=1)
    rig["lane"].tick()
    assert result(folder) == {
        **result(folder),
        "ok": False,
        "error": "lease-unavailable",
    }
    assert rig["engines"] == []  # no Kokoro, no render of any kind


def test_six_hours_count_from_the_last_progress(rig):
    rig["state"]["minutes"] = 7
    folder = episode(rig["root"])
    rig["clock"].advance(hours=5)
    rig["lane"].tick()  # two beats at T0+5h..
    rig["gpu"].loaded = ["some-model"]
    rig["clock"].advance(hours=3)
    rig["lane"].tick()
    assert not (folder / "narration.result.json").exists()


def test_failed_render_releases_the_lease_and_retries(rig):
    rig["state"]["fail"] = True
    folder = episode(rig["root"])
    status = rig["lane"].tick()
    assert status["error"] == "boom"
    assert not rig["lease"].path.exists()
    assert not (folder / "narration.result.json").exists()
    rig["state"]["fail"] = False
    assert rig["lane"].tick()["result"] == "ok"


def test_oldest_request_first_and_finished_ones_skipped(rig):
    late = episode(rig["root"], "EP2", at=T0 + timedelta(minutes=5))
    early = episode(rig["root"], "EP1", at=T0)
    assert rig["lane"].pending() == [
        early / "narration.request.json",
        late / "narration.request.json",
    ]
    rig["lane"].tick()
    assert rig["lane"].pending() == [late / "narration.request.json"]


def test_edited_script_drops_old_partials(rig):
    rig["state"]["minutes"] = 7
    folder = episode(rig["root"])
    rig["lane"].tick()  # beats 1-2
    (folder / "script.md").write_text(SCRIPT.replace("last", "final"), encoding="utf-8")
    rig["state"]["minutes"] = 0.5
    rig["lane"].tick()
    assert len(rig["engines"][1].chunks) == 3  # all three again


def test_no_requests_no_lease(rig):
    assert rig["lane"].tick()["pending"] == 0
    assert not rig["lease"].path.exists()


def test_lease_holder_name_is_configurable(tmp_path):
    gpu = Gpu()
    mine = GpuLease(tmp_path / "l.json", gpu.ollama, gpu.free_mib, clock=Clock())
    other = GpuLease(
        tmp_path / "l.json", gpu.ollama, gpu.free_mib, clock=Clock(), holder="x"
    )
    assert other.acquire("ctest")
    assert mine.foreign_fresh() and not mine.acquire("blocks")
    other.release()
    assert mine.acquire("blocks")
