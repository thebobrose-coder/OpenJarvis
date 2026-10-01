"""Voice conversation logic (hq decision 0010, phase 1). Stdlib only.

A conversation starts from the hotkey and keeps listening turn after turn
until it's dismissed ("that's all", "thanks, <name>", the hotkey, mute) or
60 s pass in silence. Each turn: an utterance -> transcript -> a local
command, or a streamed Hermes reply spoken sentence by sentence on the fast
lane. The audio, VAD, STT, Hermes and TTS pieces are injected (see
voice_io.py), so this module is testable without them.

The persona's display name is configuration (config.json ``voice_name``):
the "thanks, <name>" phrases are built from it at runtime.
"""

from __future__ import annotations

import logging
import queue
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Iterator, Protocol

logger = logging.getLogger("openjarvis.voice_worker")

SILENCE_TIMEOUT_S = 60.0
MAX_COMMAND_WORDS = 5

# ---------- the local command grammar (one table) ----------

# intent -> phrases (normalized). "{name}" is replaced by the configured name.
COMMANDS: dict[str, tuple[str, ...]] = {
    "stop": ("stop", "pause", "quiet", "be quiet"),
    "resume": ("go on", "continue", "resume", "keep going"),
    "repeat": ("repeat", "say that again", "repeat that"),
    "end": (
        "thats all",
        "that is all",
        "thanks {name}",
        "thank you {name}",
        "stop listening",
        "goodbye",
        "bye",
    ),
    "briefing": (
        "read me the morning",
        "morning briefing",
        "play the briefing",
        "read the morning",
    ),
    "next": ("next", "skip"),
}


def normalize(text: str) -> str:
    text = text.lower().replace("’", "'")
    text = re.sub(r"[^\w\s]", " ", text.replace("'", ""))
    return re.sub(r"\s+", " ", text).strip()


def match_command(text: str, voice_name: str = "") -> str | None:
    """The intent for a short utterance (5 words or fewer) that matches the
    grammar, else None: longer utterances always go to Hermes."""
    said = normalize(text)
    if not said or len(said.split()) > MAX_COMMAND_WORDS:
        return None
    name = normalize(voice_name)
    for intent, phrases in COMMANDS.items():
        for phrase in phrases:
            if "{name}" in phrase:
                if not name:
                    continue
                phrase = phrase.replace("{name}", name)
            if said == phrase:
                return intent
    # "thanks" / "thank you" alone also ends (the name is often misheard).
    if said in ("thanks", "thank you"):
        return "end"
    return None


# ---------- text for speech ----------

_URL = re.compile(r"(https?://\S+|www\.\S+)", re.IGNORECASE)
_MD_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def clean_for_speech(text: str) -> str:
    """Strip markdown that slipped through and never read URLs aloud."""
    text = _MD_LINK.sub(r"\1", text)
    text = _URL.sub("link on screen", text)
    text = re.sub(r"`{1,3}", "", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*•]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"(\*\*|__|\*|_)(\S[^*_]*?\S|\S)\1", r"\2", text)
    text = text.replace("*", "")
    return re.sub(r"[ \t]+", " ", text).strip()


_SENTENCE_END = re.compile(r"(?<=[.!?…])[\"')\]]*\s+|\n{2,}")


class SentenceSplitter:
    """Turns a stream of text chunks into complete sentences as they finish,
    so the first sentence can be spoken before the reply is complete."""

    def __init__(self) -> None:
        self._buf = ""

    def feed(self, chunk: str) -> list[str]:
        self._buf += chunk
        out: list[str] = []
        while True:
            m = _SENTENCE_END.search(self._buf)
            if not m:
                break
            sentence = self._buf[: m.end()].strip()
            self._buf = self._buf[m.end() :]
            if sentence:
                out.append(sentence)
        return out

    def flush(self) -> list[str]:
        rest, self._buf = self._buf.strip(), ""
        return [rest] if rest else []


def sentences_from_stream(chunks: Iterable[str]) -> Iterator[str]:
    splitter = SentenceSplitter()
    for chunk in chunks:
        yield from splitter.feed(chunk)
    yield from splitter.flush()


# ---------- duplex ----------

HEADSET = re.compile(
    r"headset|headphone|earbud|earphone|\bbuds\b|airpods|hands[- ]?free|\bhfp\b",
    re.IGNORECASE,
)


def resolve_duplex(setting: str, output_device_name: str) -> str:
    """'full' (barge-in) for a headset, else 'half'; a config override wins."""
    setting = (setting or "auto").lower()
    if setting in ("full", "half"):
        return setting
    return "full" if HEADSET.search(output_device_name or "") else "half"


# ---------- injected pieces ----------


class Utterance(Protocol):
    """What the listener returns: captured audio and when speech ended."""

    audio: Any
    ended_at: float


class Listener(Protocol):
    def next_utterance(self, timeout: float) -> Utterance | None: ...
    def set_playing(self, playing: bool) -> None: ...
    def close(self) -> None: ...


class Player(Protocol):
    def play(
        self, audio: Any, interrupt: threading.Event
    ) -> bool: ...  # True = finished


class HermesStream(Protocol):
    def __iter__(self) -> Iterator[str]: ...
    def close(self) -> None: ...


@dataclass
class Deps:
    open_listener: Callable[[threading.Event, str], Listener]  # (barge_event, duplex)
    transcribe: Callable[[Any], str]
    hermes: Callable[[str, str], HermesStream]  # (text, session_id)
    tts: Callable[[str], Any]
    player: Player
    chime: Callable[[str], None]  # "start" | "end"
    queue_audio: Callable[[], list[tuple[str, Any]]]  # (title, audio) for voice_queue
    voice_name: Callable[[], str]
    clock: Callable[[], float] = time.monotonic


@dataclass
class Turn:
    role: str
    text: str
    at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )

    def as_dict(self) -> dict[str, str]:
        return {"role": self.role, "text": self.text, "at": self.at}


class Conversation:
    """One voice conversation. ``run()`` blocks until it ends; call it on a
    thread. ``stop()`` and ``interrupt()`` are safe from any thread."""

    def __init__(
        self,
        deps: Deps,
        duplex: str,
        on_change: Callable[[], None] = lambda: None,
        silence_timeout: float = SILENCE_TIMEOUT_S,
    ) -> None:
        self.deps = deps
        self.duplex = duplex
        self.id = str(uuid.uuid4())  # X-Hermes-Session-Id, one per conversation
        self.state = "idle"
        self.turns: list[Turn] = []
        self.metrics: list[dict[str, Any]] = []
        self.barge_ins = 0
        self.ended_reason: str | None = None
        self._on_change = on_change
        self._silence_timeout = silence_timeout
        self._stop = threading.Event()
        self._interrupt = threading.Event()  # set by barge-in (VAD) or the hotkey
        self._pending: list[str] = []  # sentences not yet spoken (for "go on")
        self._last_reply: list[str] = []

    # -- control (any thread) --
    def stop(self, reason: str = "stopped") -> None:
        self.ended_reason = self.ended_reason or reason
        self._stop.set()
        self._interrupt.set()

    def interrupt(self) -> None:
        self._interrupt.set()

    def _set(self, state: str) -> None:
        self.state = state
        self._on_change()

    # -- the loop --
    def run(self) -> None:
        listener = self.deps.open_listener(self._interrupt, self.duplex)
        try:
            self.deps.chime("start")
            while not self._stop.is_set():
                self._set("listening")
                self._interrupt.clear()
                utt = listener.next_utterance(self._silence_timeout)
                if self._stop.is_set():
                    break
                if utt is None:
                    self.ended_reason = "silence"
                    break
                self._turn(utt, listener)
        finally:
            listener.close()  # the mic closes with the conversation
            self._set("idle")
            self.deps.chime("end")
            logger.info(
                "Voice conversation ended (%s): %d turns, %d barge-ins",
                self.ended_reason or "stopped",
                len(self.turns) // 2,
                self.barge_ins,
            )

    def _turn(self, utt: Utterance, listener: Listener) -> None:
        self._set("transcribing")
        text = (self.deps.transcribe(utt.audio) or "").strip()
        t_transcript = self.deps.clock()
        if not text:
            return
        self.turns.append(Turn("user", text))
        command = match_command(text, self.deps.voice_name())
        metric: dict[str, Any] = {
            "stt_s": round(t_transcript - utt.ended_at, 2),
            "command": command or "",
        }
        if command:
            self.metrics.append(metric)
            logger.info("Voice turn: %s", metric)
            self._command(command, listener)
            return
        self._set("thinking")
        stream = self.deps.hermes(text, self.id)
        ready: "queue.Queue[tuple[str, Any] | None]" = queue.Queue()
        cancel = threading.Event()
        marks: dict[str, float] = {}

        def produce() -> None:
            # Stream -> sentences -> speech, running ahead of playback, so the
            # next sentence is synthesized while the current one plays.
            try:

                def timed() -> Iterator[str]:
                    for c in stream:
                        if c and "first_token" not in marks:
                            marks["first_token"] = self.deps.clock()
                        yield c
                        if cancel.is_set():
                            return

                for sentence in sentences_from_stream(timed()):
                    spoken = clean_for_speech(sentence)
                    if spoken and not cancel.is_set():
                        ready.put((spoken, self.deps.tts(spoken)))
            except Exception:  # noqa: BLE001 -- a broken stream ends the reply
                if not cancel.is_set():
                    logger.warning("Hermes stream failed", exc_info=True)
            finally:
                ready.put(None)

        producer = threading.Thread(target=produce, daemon=True)
        producer.start()
        reply: list[str] = []
        played = 0  # sentences played, the interrupted one included
        barged = False
        try:
            while True:
                item = ready.get()
                if item is None:
                    break
                spoken, audio = item
                reply.append(spoken)
                if barged:
                    continue
                marks.setdefault("first_audio", self.deps.clock())
                played += 1
                if not self._speak(audio, listener):
                    barged = True
                    cancel.set()
                    stream.close()  # cancel the in-flight Hermes stream
        finally:
            cancel.set()
            stream.close()
            producer.join(timeout=5)
        if barged:
            # What was received but not played is what "go on" resumes.
            self._pending = reply[played:]
        self.turns.append(Turn("assistant", " ".join(reply)))
        self._last_reply = reply
        metric.update(
            {
                "first_token_s": round(marks["first_token"] - utt.ended_at, 2)
                if "first_token" in marks
                else None,
                "first_audio_s": round(marks["first_audio"] - utt.ended_at, 2)
                if "first_audio" in marks
                else None,
                "barged": barged,
            }
        )
        self.metrics.append(metric)
        logger.info("Voice turn: %s", metric)

    def _speak(self, audio: Any, listener: Listener) -> bool:
        """Play one clip. False if a barge-in (or the hotkey) cut it off."""
        self._set("speaking")
        self._interrupt.clear()
        listener.set_playing(True)
        try:
            finished = self.deps.player.play(audio, self._interrupt)
        finally:
            listener.set_playing(False)
        if not finished and not self._stop.is_set():
            self.barge_ins += 1
        return finished

    def _speak_all(self, sentences: list[str], listener: Listener) -> None:
        for i, s in enumerate(sentences):
            if not self._speak(self.deps.tts(s), listener):
                self._pending = sentences[i + 1 :]
                return
        self._pending = []

    def _command(self, command: str, listener: Listener) -> None:
        if command == "end":
            self.stop("dismissed")
        elif command == "stop":
            pass  # playback already stopped; stay in the conversation
        elif command == "resume":
            pending, self._pending = self._pending, []
            self._speak_all(pending, listener)
        elif command == "repeat":
            self._speak_all(list(self._last_reply), listener)
        elif command == "briefing":
            self._play_queue(listener)
        # "next"/"skip" outside the queue: nothing to skip.

    def _play_queue(self, listener: Listener) -> None:
        """voice_queue in order through the shared cache; a spoken "next" or
        "skip" moves on, anything else ends the playlist."""
        items = self.deps.queue_audio()
        i = 0
        while i < len(items) and not self._stop.is_set():
            _title, audio = items[i]
            if self._speak(audio, listener):
                i += 1
                continue
            utt = listener.next_utterance(5.0)
            said = self.deps.transcribe(utt.audio) if utt else ""
            if said:
                self.turns.append(Turn("user", said))
            if match_command(said or "", self.deps.voice_name()) == "next":
                i += 1
            elif match_command(said or "", self.deps.voice_name()) == "end":
                self.stop("dismissed")
            else:
                return
