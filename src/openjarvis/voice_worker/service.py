"""The always-on voice worker: a minute loop over voice_queue plus a
localhost HTTP API (health, status, fast-lane speak). Run it with
``python -m openjarvis.voice_worker`` from the worker venv."""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from typing import Any

from . import paths
from .core import BLOCK_TEXT_MAX, SPEAK_TEXT_MAX, AudioCache, GpuLease, Walker, utcnow

logger = logging.getLogger("openjarvis.voice_worker")

BRIDGE = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip("/")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def ollama_loaded() -> list[str]:
    """Model names `ollama ps` reports as loaded. An error (Ollama down or
    upgrading) reads as nothing loaded."""
    try:
        out = subprocess.run(
            ["ollama", "ps"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=_NO_WINDOW,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    lines = [ln for ln in out.strip().splitlines() if ln.strip()]
    if not lines or not lines[0].startswith("NAME"):
        return []
    return [ln.split()[0] for ln in lines[1:]]


def gpu_free_mib() -> int:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=_NO_WINDOW,
        ).stdout
        return int(out.strip().splitlines()[0])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return 0


def gpu_used_mib() -> int:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=_NO_WINDOW,
        ).stdout
        return int(out.strip().splitlines()[0])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return 0


def fetch_queue() -> list[dict[str, Any]]:
    try:
        with urllib.request.urlopen(f"{BRIDGE}/panels/voice_queue", timeout=10) as r:
            payload = json.load(r)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return []  # no queue published yet
        raise
    return list((payload.get("data") or {}).get("items") or [])


def fake_busy() -> bool:
    """Test flag: an env var, or a ``fake_busy`` file in the data folder
    (toggle it without restarting)."""
    return (
        os.environ.get("OPENJARVIS_VOICE_FAKE_BUSY") == "1"
        or (paths.data_dir() / "fake_busy").exists()
    )


class GpuPeak:
    """Samples total GPU memory in use while an expressive batch runs."""

    def __init__(self) -> None:
        self.peak = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.peak, self._stop = gpu_used_mib(), threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(0.5):
            self.peak = max(self.peak, gpu_used_mib())

    def stop(self) -> int:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        return self.peak


class Instrumented:
    """Wraps the expressive engine to log load time, batch time and peak GPU."""

    def __init__(self, inner) -> None:
        self.inner, self.name = inner, inner.name
        self._peak = GpuPeak()
        self.last_batch: dict[str, Any] = {}

    def load(self) -> None:
        self._baseline = gpu_used_mib()
        self._t0 = time.perf_counter()
        self._peak.start()
        self.inner.load()
        self._loaded_s = round(time.perf_counter() - self._t0, 1)

    def render_chunk(self, text: str, exaggeration: float):
        return self.inner.render_chunk(text, exaggeration)

    def unload(self) -> None:
        self.inner.unload()
        peak = self._peak.stop()
        self.last_batch = {
            "load_s": getattr(self, "_loaded_s", None),
            "batch_s": round(
                time.perf_counter() - getattr(self, "_t0", time.perf_counter()), 1
            ),
            "peak_used_mib": peak,
            "peak_delta_mib": peak - getattr(self, "_baseline", 0),
        }
        logger.info("Expressive batch done: %s", self.last_batch)


class Worker:
    def __init__(self, fallback_minutes: float, device: str) -> None:
        from datetime import timedelta

        from .engines import ChatterboxExpressive, KokoroFast, ensure_reference

        self.fast = KokoroFast()
        self.reference_rendered = ensure_reference(self.fast, paths.reference_path())
        self.expressive = Instrumented(
            ChatterboxExpressive(paths.reference_path(), device=device)
        )
        self.lease = GpuLease(
            paths.lease_path(), ollama_loaded, gpu_free_mib, fake_busy=fake_busy
        )
        self.cache = AudioCache(paths.cache_dir())
        self.walker = Walker(
            fetch_queue,
            self.cache,
            self.lease,
            self.fast,
            self.expressive,
            fallback_after=timedelta(minutes=fallback_minutes),
        )
        self.lock = threading.Lock()  # one render at a time across the loop and the API
        self.started_at = utcnow()

    def loop(self, interval: float = 60.0) -> None:
        while True:
            try:
                with self.lock:
                    result = self.walker.tick()
                if result.get("rendered") or result.get("error"):
                    logger.info("Tick: %s", result)
            except Exception:  # noqa: BLE001 -- keep the worker alive; the lease is already released
                logger.exception("Tick failed")
            # Once the traceback is gone, return any GPU memory a failed render
            # left in torch's allocator.
            from .engines import ChatterboxExpressive

            ChatterboxExpressive._free()
            time.sleep(interval)

    def status(self) -> dict[str, Any]:
        idx = self.cache.index()
        return {
            "ok": True,
            "started_at": self.started_at.isoformat(timespec="seconds"),
            "last_tick": self.walker.last,
            "lease_held": self.lease.held,
            "gpu_available": self.lease.availability()[1],
            "cached": {
                "expressive": sum(
                    1 for v in idx.values() if v.get("lane") == "expressive"
                ),
                "fast": sum(1 for v in idx.values() if v.get("lane") == "fast"),
            },
            "last_expressive_batch": self.expressive.last_batch,
            "reference": str(paths.reference_path()),
        }

    def speak(self, text: str) -> tuple[bytes, int]:
        with self.lock:
            return self.fast.render(text)

    # ---------- voice input (hq 0010 phase 1) ----------
    def start_voice_input(self) -> None:
        """Load VAD + STT in the background, then register the hotkeys."""
        threading.Thread(
            target=self._init_voice, name="voice-init", daemon=True
        ).start()

    def _init_voice(self) -> None:
        from .conversation import resolve_duplex
        from .hotkeys import Hotkeys
        from .voice_input import VoiceInput
        from .voice_io import Transcriber, Vad, device_name

        cfg = paths.config()
        try:
            import torch

            # Leave CPU headroom for audio: synthesis and STT otherwise take
            # every core and the playback/VAD threads stutter.
            threads = max(2, (os.cpu_count() or 4) // 2)
            torch.set_num_threads(threads)
            self.vad = Vad()
            self.stt = Transcriber(
                str(cfg.get("stt_model", "small.en")), cpu_threads=min(8, threads)
            )
        except Exception:  # noqa: BLE001 -- voice input is optional; the renders keep going
            logger.exception("Voice input disabled: VAD/STT failed to load")
            return
        self._resolve_devices()
        out_name = device_name(self.out_dev, "output")
        duplex = resolve_duplex(str(cfg.get("duplex", "auto")), out_name)
        self.voice = VoiceInput(self._make_conversation, duplex, out_name)
        Hotkeys(
            {
                str(cfg.get("hotkey_talk", "ctrl+alt+space")): self.voice.toggle,
                str(cfg.get("hotkey_mute", "ctrl+alt+m")): self.voice.toggle_mute,
            }
        ).start()
        logger.info("Voice input ready (duplex=%s)", duplex)

    def _make_conversation(self, on_change):
        from .conversation import Conversation, Deps
        from .voice_io import (
            HermesVoiceStream,
            SpeakerPlayer,
            chime_pcm,
            hermes_key,
        )

        self._resolve_devices()
        player = SpeakerPlayer(self.out_dev, fallback=self._speaker_fallback)
        url = os.environ.get(
            "HERMES_VOICE_URL", "http://127.0.0.1:8642/p/voice/v1/chat/completions"
        )
        key = hermes_key()

        def open_listener(barge, duplex):
            listener = self._open_mic(barge, duplex)
            player.listener = listener
            return listener

        def chime(kind):
            listener, player.listener = player.listener, None  # a chime is never barged
            player.play(chime_pcm(kind), threading.Event())
            player.listener = listener

        deps = Deps(
            open_listener=open_listener,
            transcribe=self.stt,
            hermes=lambda text, sid: HermesVoiceStream(url, key, text, sid),
            tts=self.fast.render,
            player=player,
            chime=chime,
            queue_audio=self._queue_audio,
            voice_name=paths.voice_name,
        )
        return Conversation(deps, self.voice.duplex, on_change=on_change)

    def _resolve_devices(self) -> None:
        """Devices by name, at every conversation start: indexes from an
        earlier PortAudio scan can point at a different endpoint later."""
        from .voice_io import describe, find_device, refresh_devices

        refresh_devices()  # a fresh scan: the first open on a stale scan can fail
        cfg = paths.config()
        self.in_dev = find_device(cfg.get("input_device"), "input")
        self.out_dev = find_device(cfg.get("output_device"), "output")
        logger.info(
            "Voice devices: mic=%s, speaker=%s",
            describe(self.in_dev, "input"),
            describe(self.out_dev, "output"),
        )

    def _speaker_fallback(self) -> int | None:
        """The speaker failed to open: re-scan, then prefer the MME endpoint."""
        from .voice_io import describe, find_device, refresh_devices

        refresh_devices()
        name = paths.config().get("output_device")
        self.out_dev = find_device(name, "output", host_api="MME") if name else None
        logger.info("Voice speaker fallback: %s", describe(self.out_dev, "output"))
        return self.out_dev

    def _command_check(self, audio) -> str | None:
        """A short burst heard during playback: its transcript if it's a
        local command (so "stop" interrupts), else None."""
        from .conversation import match_command

        text = self.stt(audio)
        return text if match_command(text, paths.voice_name()) else None

    def _open_mic(self, barge, duplex):
        """WASAPI first; on failure re-scan devices and retry, then MME."""
        from .voice_io import MicListener, describe, find_device, refresh_devices

        try:
            return MicListener(
                self.vad, barge, duplex, self.in_dev, self._command_check
            )
        except Exception as first:  # noqa: BLE001
            logger.warning(
                "Mic failed on %s (%s); re-scanning",
                describe(self.in_dev, "input"),
                first,
            )
        refresh_devices()
        self._resolve_devices()
        try:
            return MicListener(
                self.vad, barge, duplex, self.in_dev, self._command_check
            )
        except Exception as second:  # noqa: BLE001
            logger.warning("Mic failed again (%s); trying MME", second)
        name = paths.config().get("input_device")
        self.in_dev = find_device(name, "input", host_api="MME") if name else None
        logger.info("Voice mic fallback: %s", describe(self.in_dev, "input"))
        return MicListener(self.vad, barge, duplex, self.in_dev, self._command_check)

    def _queue_audio(self) -> list[tuple[str, tuple[bytes, int]]]:
        """voice_queue in order, from the shared cache (expressive where rendered)."""
        import wave

        out = []
        try:
            items = sorted(fetch_queue(), key=lambda i: i.get("order", 0))
        except Exception:  # noqa: BLE001
            return out
        for item in items:
            wav = self.cache.wav_path(str(item.get("id", "")))
            if not wav.exists():
                continue
            with wave.open(str(wav), "rb") as w:
                out.append(
                    (
                        str(item.get("title", "")),
                        (w.readframes(w.getnframes()), w.getframerate()),
                    )
                )
        return out

    def block_fast(self, block: dict[str, Any]) -> dict[str, Any]:
        """Render one block on the fast lane into the cache, unless it's cached.
        The loop upgrades expressive-lane blocks later, as usual."""
        with self.lock:
            if not self.cache.lane(block["id"]):
                self.walker.render_fast(block)
        entry = self.cache.index().get(block["id"], {})
        return {
            **entry,
            "id": block["id"],
            "path": str(self.cache.wav_path(block["id"])),
        }


def wav_bytes(pcm: bytes, sr: int) -> bytes:
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


def make_handler(worker: Worker):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quiet access log
            logger.debug("http: " + fmt, *args)

        def _json(self, code: int, body: dict[str, Any]) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict[str, Any]:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 64_000:
                raise ValueError("body too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                return self._json(200, {"ok": True})
            if self.path == "/status":
                return self._json(200, worker.status())
            voice = getattr(worker, "voice", None)
            if self.path == "/voice/state":
                if voice is None:
                    return self._json(503, {"error": "voice input not ready"})
                return self._json(200, voice.state())
            if self.path == "/voice/events":
                if voice is None:
                    return self._json(503, {"error": "voice input not ready"})
                return self._events(voice)
            return self._json(404, {"error": "not found"})

        def _events(self, voice) -> None:
            q = voice.subscribe()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                while True:
                    try:
                        event = q.get(timeout=15)
                        self.wfile.write(f"data: {event}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                voice.unsubscribe(q)

        def do_POST(self):  # noqa: N802
            if self.path.startswith("/voice/"):
                voice = getattr(worker, "voice", None)
                if voice is None:
                    return self._json(503, {"error": "voice input not ready"})
                action = {
                    "/voice/start": voice.start,
                    "/voice/stop": lambda: voice.stop("ui"),
                    "/voice/mute": voice.mute,
                    "/voice/unmute": voice.unmute,
                }.get(self.path)
                if action is None:
                    return self._json(404, {"error": "not found"})
                action()
                return self._json(200, voice.state())
            try:
                body = self._body()
            except (ValueError, json.JSONDecodeError):
                return self._json(400, {"error": "bad body"})
            text = body.get("text")
            limit = SPEAK_TEXT_MAX if self.path == "/speak" else BLOCK_TEXT_MAX
            if not isinstance(text, str) or not text.strip() or len(text) > limit:
                return self._json(400, {"error": f"text must be 1-{limit} characters"})
            try:
                if self.path == "/speak":
                    data = wav_bytes(*worker.speak(text))
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return None
                if self.path == "/blocks/fast":
                    if not paths.BLOCK_ID.match(str(body.get("id", ""))):
                        return self._json(400, {"error": "bad id"})
                    return self._json(200, worker.block_fast(body))
            except Exception as exc:  # noqa: BLE001
                logger.exception("Request failed")
                return self._json(500, {"error": str(exc)})
            return self._json(404, {"error": "not found"})

    return Handler


def setup_logging() -> None:
    paths.logs_dir().mkdir(parents=True, exist_ok=True)
    if sys.stderr is None or sys.stdout is None:
        # Under pythonw (the scheduled task) there are no standard streams, and
        # kokoro adds a loguru sink on sys.stderr at import time, which raises.
        # Give the libraries a real file instead.
        stream = open(
            paths.logs_dir() / "voice-worker.stdio.log",
            "a",
            encoding="utf-8",
            buffering=1,
        )  # noqa: SIM115
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream
        stdio_is_file = True
    else:
        stdio_is_file = False
    handler = RotatingFileHandler(
        paths.logs_dir() / "voice-worker.log",
        maxBytes=2_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    if not stdio_is_file:
        root.addHandler(logging.StreamHandler())


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="openjarvis.voice_worker")
    ap.add_argument("--port", type=int, default=8650)
    ap.add_argument(
        "--interval", type=float, default=60.0, help="seconds between queue passes"
    )
    ap.add_argument("--fallback-minutes", type=float, default=20.0)
    ap.add_argument("--device", default="cuda")
    ap.add_argument(
        "--no-voice-input", action="store_true", help="renders only; no mic or hotkeys"
    )
    args = ap.parse_args(argv)
    setup_logging()
    logger.info("Voice worker starting (lease: %s)", paths.lease_path())
    worker = Worker(args.fallback_minutes, args.device)
    threading.Thread(target=worker.loop, args=(args.interval,), daemon=True).start()
    if not args.no_voice_input and paths.config().get("voice_input", True):
        worker.start_voice_input()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(worker))
    logger.info("Listening on 127.0.0.1:%d", args.port)
    server.serve_forever()
