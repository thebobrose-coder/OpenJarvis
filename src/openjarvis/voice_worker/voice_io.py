"""Real audio, VAD, STT, Hermes and chime pieces for the voice conversation.
Needs the worker venv: sounddevice (PortAudio), silero-vad (torch), and
faster-whisper (CPU, int8)."""

from __future__ import annotations

import collections
import json
import logging
import queue
import threading
import time
import urllib.request
from dataclasses import dataclass
from typing import Iterator

import numpy as np

logger = logging.getLogger("openjarvis.voice_worker")

MIC_RATE = 16000
FRAME = 512  # 32 ms at 16 kHz: Silero VAD's frame size
SPEECH_PROB = 0.5
PRE_ROLL_S = 0.3
END_SILENCE_S = 0.7  # end of speech after this much trailing silence...
SHORT_PAUSE_S = 1.2  # ...but allow up to this for a pause in a short utterance
SHORT_UTTERANCE_S = 2.0
BARGE_MIN_S = 0.4  # speech this long during playback is a barge-in
BARGE_GUARD_S = 0.3  # ignore VAD this long after each clip starts (click/bleed)
MAX_UTTERANCE_S = 30.0


def find_device(name_part: str | None, kind: str) -> int | None:
    """A device index whose name contains ``name_part`` (case-insensitive),
    preferring WASAPI; None means the system default."""
    if not name_part:
        return None
    import sounddevice as sd

    want = name_part.lower()
    apis = sd.query_hostapis()
    best = None
    for i, d in enumerate(sd.query_devices()):
        channels = (
            d["max_input_channels"] if kind == "input" else d["max_output_channels"]
        )
        if channels and want in d["name"].lower():
            if apis[d["hostapi"]]["name"] == "Windows WASAPI":
                return i
            best = i if best is None else best
    return best


def device_name(index: int | None, kind: str) -> str:
    import sounddevice as sd

    if index is None:
        index = sd.default.device[0 if kind == "input" else 1]
    try:
        return str(sd.query_devices(index)["name"])
    except Exception:  # noqa: BLE001
        return ""


class Vad:
    def __init__(self) -> None:
        from silero_vad import load_silero_vad

        self.model = load_silero_vad()

    def prob(self, frame: np.ndarray) -> float:
        import torch

        return float(self.model(torch.from_numpy(frame), MIC_RATE).item())

    def reset(self) -> None:
        self.model.reset_states()


@dataclass
class Utterance:
    audio: np.ndarray
    ended_at: float


class MicListener:
    """The microphone, open only for the life of one conversation.

    Frames flow through Silero VAD. ``next_utterance`` returns once speech
    ends (with a 300 ms pre-roll so the first syllable isn't clipped). While
    a clip plays: in full duplex, 400 ms of speech sets ``barge`` (after a
    300 ms guard per clip) and the speech becomes the next utterance; in half
    duplex the mic is ignored and only the hotkey interrupts."""

    def __init__(
        self, vad: Vad, barge: threading.Event, duplex: str, device: int | None
    ) -> None:
        import sounddevice as sd

        self.vad = vad
        self.vad.reset()
        self.barge = barge
        self.duplex = duplex
        self.frames: "queue.Queue[np.ndarray]" = queue.Queue()
        self.playing = False
        self.play_started = 0.0
        self.stream = sd.InputStream(
            samplerate=MIC_RATE,
            channels=1,
            dtype="float32",
            blocksize=FRAME,
            device=device,
            callback=lambda data, *_: self.frames.put(data[:, 0].copy()),
        )
        self.stream.start()
        self._carry: list[np.ndarray] = []  # speech already heard during playback

    def set_playing(self, playing: bool) -> None:
        self.playing = playing
        if playing:
            self.play_started = time.monotonic()
            self._carry = []

    def next_utterance(self, timeout: float) -> Utterance | None:
        pre: collections.deque[np.ndarray] = collections.deque(
            maxlen=int(PRE_ROLL_S * MIC_RATE / FRAME)
        )
        speech: list[np.ndarray] = list(self._carry)
        self._carry = []
        voiced = len(speech) * FRAME / MIC_RATE
        silence = 0.0
        deadline = time.monotonic() + timeout
        while True:
            try:
                frame = self.frames.get(timeout=0.5)
            except queue.Empty:
                if not speech and time.monotonic() > deadline:
                    return None
                continue
            p = self.vad.prob(frame)
            if speech:
                speech.append(frame)
                if p >= SPEECH_PROB:
                    voiced += FRAME / MIC_RATE
                    silence = 0.0
                else:
                    silence += FRAME / MIC_RATE
                limit = END_SILENCE_S if voiced >= SHORT_UTTERANCE_S else SHORT_PAUSE_S
                if silence >= limit or len(speech) * FRAME / MIC_RATE > MAX_UTTERANCE_S:
                    return Utterance(np.concatenate(speech), time.monotonic())
            elif p >= SPEECH_PROB:
                speech = [*pre, frame]
                voiced = FRAME / MIC_RATE
                silence = 0.0
            else:
                pre.append(frame)
                if time.monotonic() > deadline:
                    return None

    def watch_playback(self, stop: threading.Event) -> None:
        """Runs while a clip plays (full duplex): detect a barge-in."""
        heard: list[np.ndarray] = []
        voiced = 0.0
        while not stop.is_set():
            try:
                frame = self.frames.get(timeout=0.05)
            except queue.Empty:
                continue
            if (
                self.duplex != "full"
                or time.monotonic() - self.play_started < BARGE_GUARD_S
            ):
                continue
            if self.vad.prob(frame) >= SPEECH_PROB:
                heard.append(frame)
                voiced += FRAME / MIC_RATE
                if voiced >= BARGE_MIN_S:
                    self._carry = heard  # the start of the next utterance
                    self.barge.set()
                    return
            else:
                heard, voiced = [], 0.0

    def close(self) -> None:
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:  # noqa: BLE001
            logger.debug("mic close failed", exc_info=True)


class SpeakerPlayer:
    """Plays 16-bit mono PCM in small blocks so an interrupt stops it within
    ~50 ms. While it plays, the listener watches for a barge-in."""

    def __init__(self, device: int | None) -> None:
        self.device = device
        self.listener: MicListener | None = None

    def play(self, audio: tuple[bytes, int], interrupt: threading.Event) -> bool:
        import sounddevice as sd

        pcm, sr = audio
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        block = int(sr * 0.05)
        watch_stop = threading.Event()
        watcher = None
        if self.listener is not None:
            watcher = threading.Thread(
                target=self.listener.watch_playback, args=(watch_stop,), daemon=True
            )
            watcher.start()
        finished = True
        try:
            with sd.OutputStream(
                samplerate=sr, channels=1, dtype="float32", device=self.device
            ) as out:
                for i in range(0, len(samples), block):
                    if interrupt.is_set():
                        finished = False
                        break
                    out.write(samples[i : i + block].reshape(-1, 1))
        finally:
            watch_stop.set()
            if watcher:
                watcher.join(timeout=1)
        return finished


class Transcriber:
    """faster-whisper small.en, int8, on the CPU (the GPU belongs to qwen and
    the expressive renders)."""

    def __init__(self) -> None:
        from faster_whisper import WhisperModel

        self.model = WhisperModel("small.en", device="cpu", compute_type="int8")

    def __call__(self, audio: np.ndarray) -> str:
        segments, _ = self.model.transcribe(
            audio,
            beam_size=1,
            language="en",
            vad_filter=False,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()


class HermesVoiceStream:
    """One streamed reply from Hermes's voice endpoint (read-only tools).
    ``close()`` from another thread drops the connection (barge-in)."""

    def __init__(self, url: str, key: str, text: str, session_id: str) -> None:
        body = json.dumps(
            {
                "model": "voice",
                "stream": True,
                "messages": [{"role": "user", "content": text}],
            }
        ).encode()
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "X-Hermes-Session-Id": session_id,
            },
        )
        self._resp = urllib.request.urlopen(req, timeout=120)  # noqa: S310 -- localhost only
        self._closed = False

    def __iter__(self) -> Iterator[str]:
        try:
            for raw in self._resp:
                if self._closed:
                    return
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    delta = json.loads(data)["choices"][0].get("delta", {})
                except (ValueError, KeyError, IndexError):
                    continue
                if delta.get("content"):
                    yield delta["content"]
        except Exception:  # noqa: BLE001 -- closed under us (barge-in) or dropped
            if not self._closed:
                raise

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            try:
                self._resp.close()
            except Exception:  # noqa: BLE001
                pass


def hermes_key() -> str:
    """OpenJarvis's existing Hermes credential (credentials.toml [hermes]),
    read at runtime; never logged."""
    import os
    from pathlib import Path

    import tomllib

    if os.environ.get("HERMES_API_KEY"):
        return os.environ["HERMES_API_KEY"]
    path = (
        Path(os.environ.get("OPENJARVIS_HOME", Path.home() / ".openjarvis"))
        / "credentials.toml"
    )
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str((data.get("hermes") or {}).get("HERMES_API_KEY", ""))


def chime_pcm(kind: str, sr: int = 24000) -> tuple[bytes, int]:
    """Two short, soft synthesized tones: rising for start, falling for end."""
    notes = (660.0, 880.0) if kind == "start" else (880.0, 660.0)
    parts = []
    for f in notes:
        t = np.arange(int(sr * 0.11)) / sr
        tone = 0.12 * np.sin(2 * np.pi * f * t)
        fade = np.minimum(1.0, np.minimum(t, t[::-1]) / 0.02)
        parts += [tone * fade, np.zeros(int(sr * 0.02))]
    audio = np.concatenate(parts)
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes(), sr
