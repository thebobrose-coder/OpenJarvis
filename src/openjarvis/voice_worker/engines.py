"""The two voice engines. Needs the worker venv (requirements.txt):
torch 2.6.0+cu124, chatterbox-tts 0.1.7, kokoro 0.9.4."""

from __future__ import annotations

import gc
import logging
import threading
import wave
from pathlib import Path

from .core import SEED

logger = logging.getLogger("openjarvis.voice_worker")

VOICE = "bm_george"
SAMPLE_RATE = 24000
CFG_WEIGHT = 0.5

# The expressive voice's reference: a neutral, non-live passage in Kokoro bm_george
# (the same one the 2026-09-29 listening test used for render C4).
REFERENCE_TEXT = (
    "Good evening, sir. I have taken the liberty of reviewing the day's "
    "correspondence. Nothing requires your attention tonight, though I suspect "
    "tomorrow will be rather busier. Shall I leave the lamp on in the study?"
)


def to_pcm16(samples) -> bytes:
    import numpy as np

    a = np.asarray(samples, dtype=np.float32).reshape(-1)
    return (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class KokoroFast:
    """Fast lane: Kokoro 82M, bm_george, CPU. Kept loaded (CPU memory only)."""

    name = f"kokoro:{VOICE}"

    def __init__(self) -> None:
        self._pipeline = None
        self._lock = threading.Lock()

    def _ensure(self):
        if self._pipeline is None:
            from kokoro import KModel, KPipeline

            model = KModel().to("cpu").eval()
            self._pipeline = KPipeline(lang_code="b", model=model)
        return self._pipeline

    def render(self, text: str, speed: float = 1.0) -> tuple[bytes, int]:
        import numpy as np

        with self._lock:
            pipe = self._ensure()
            parts = [
                a.numpy()
                for _, _, a in pipe(text, voice=VOICE, speed=speed)
                if a is not None
            ]
        if not parts:
            raise RuntimeError("Kokoro produced no audio")
        return to_pcm16(np.concatenate(parts)), SAMPLE_RATE


def ensure_reference(fast: KokoroFast, path: Path) -> bool:
    """Render the reference clip if it's missing. True if rendered."""
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm, sr = fast.render(REFERENCE_TEXT)
    tmp = path.with_suffix(".tmp")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    tmp.replace(path)
    logger.info("Rendered the reference clip (%.1f s)", len(pcm) / 2 / sr)
    return True


class ChatterboxExpressive:
    """Expressive lane: Chatterbox conditioned on the reference clip.

    Loaded per render batch and released afterwards. The reference conditionals
    are prepared once per load and restored before every chunk: Chatterbox's
    generate() mutates ``model.conds`` (and ``audio_prompt_path`` would
    overwrite it), so one render's settings never leak into the next.
    GPU memory is freed on unload and after a failed load."""

    name = "chatterbox:expressive"

    def __init__(self, reference: Path, device: str = "cuda") -> None:
        self.reference = reference
        self.device = device
        self._model = None
        self._conds = None

    def load(self) -> None:
        if self._model is not None:
            return
        from chatterbox.tts import ChatterboxTTS

        model = None
        try:
            model = ChatterboxTTS.from_pretrained(device=self.device)
            model.prepare_conditionals(str(self.reference), exaggeration=0.5)
            # Keep the parts, not a deepcopy: prepare_conditionals yields
            # non-leaf tensors, and generate() only ever swaps conds.t3 on
            # the wrapper (it never edits tensors in place).
            self._conds = (model.conds.t3, dict(model.conds.gen))
            self._model = model
        except BaseException:
            model = None
            self._free()
            raise

    def render_chunk(self, text: str, exaggeration: float) -> tuple[bytes, int]:
        import torch
        from chatterbox.tts import Conditionals

        model = self._model
        if model is None or self._conds is None:
            raise RuntimeError("Chatterbox is not loaded")
        t3, gen = self._conds
        model.conds = Conditionals(t3, dict(gen))
        torch.manual_seed(SEED)
        wav = model.generate(text, exaggeration=exaggeration, cfg_weight=CFG_WEIGHT)
        return to_pcm16(wav.squeeze(0).cpu().numpy()), model.sr

    def unload(self) -> None:
        self._model = None
        self._conds = None
        self._free()

    @staticmethod
    def _free() -> None:
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            logger.debug("empty_cache failed", exc_info=True)
