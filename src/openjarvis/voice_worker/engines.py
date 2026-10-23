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
    """Fast lane: Kokoro 82M, bm_george, CPU. Kept loaded (CPU memory only).
    ``render_voice`` speaks in any Kokoro voice (for the long-form references);
    the pipelines per accent share one model."""

    name = f"kokoro:{VOICE}"

    def __init__(self) -> None:
        self._model = None
        self._pipelines: dict[str, object] = {}
        self._lock = threading.Lock()

    def _ensure(self, lang: str = "b"):
        if lang not in self._pipelines:
            from kokoro import KModel, KPipeline

            if self._model is None:
                self._model = KModel().to("cpu").eval()
            self._pipelines[lang] = KPipeline(lang_code=lang, model=self._model)
        return self._pipelines[lang]

    def render(self, text: str, speed: float = 1.0) -> tuple[bytes, int]:
        return self.render_voice(text, VOICE, speed)

    def render_voice(
        self, text: str, voice: str, speed: float = 1.0
    ) -> tuple[bytes, int]:
        """``voice`` is a Kokoro id; its first letter is the accent (a or b)."""
        import numpy as np

        with self._lock:
            pipe = self._ensure(voice[0])
            parts = [
                a.numpy()
                for _, _, a in pipe(text, voice=voice, speed=speed)
                if a is not None
            ]
        if not parts:
            raise RuntimeError("Kokoro produced no audio")
        return to_pcm16(np.concatenate(parts)), SAMPLE_RATE


def _save_wav(path: Path, pcm: bytes, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    tmp.replace(path)


def ensure_reference(fast: KokoroFast, path: Path) -> bool:
    """Render the reference clip if it's missing. True if rendered."""
    if path.exists():
        return False
    pcm, sr = fast.render(REFERENCE_TEXT)
    _save_wav(path, pcm, sr)
    logger.info("Rendered the reference clip (%.1f s)", len(pcm) / 2 / sr)
    return True


# A character's reference (the long-form lane, hq 0019): a neutral passage with
# no persona in it, spoken by the Kokoro voice the operator picked. Synthetic
# only; never a real person's voice (0009).
CHARACTER_REFERENCE_TEXT = (
    "The report came in shortly after midnight. Three of the four readings were "
    "within the expected range, and the fourth was not. That is usually where the "
    "interesting part begins. We will go through it slowly, one line at a time, "
    "and then decide what it means."
)


def character_reference(fast: KokoroFast, root: Path, voice: str, pace: float) -> Path:
    """The cached reference clip for one Kokoro voice at one pace."""
    path = root / f"{voice}@{pace:.2f}.wav"
    if not path.exists():
        pcm, sr = fast.render_voice(CHARACTER_REFERENCE_TEXT, voice, pace)
        _save_wav(path, pcm, sr)
        logger.info("Rendered the %s reference (%.1f s)", voice, len(pcm) / 2 / sr)
    return path


class ChatterboxExpressive:
    """Expressive lane: Chatterbox conditioned on the reference clip.

    Loaded per render batch and released afterwards. The reference conditionals
    are prepared once per load and restored before every chunk: Chatterbox's
    generate() mutates ``model.conds`` (and ``audio_prompt_path`` would
    overwrite it), so one render's settings never leak into the next.
    GPU memory is freed on unload and after a failed load."""

    name = "chatterbox:expressive"

    def __init__(
        self, reference: Path, device: str = "cuda", exaggeration: float = 0.5
    ) -> None:
        self.reference = reference
        self.device = device
        self.exaggeration = exaggeration
        self._model = None
        self._conds = None

    def load(self) -> None:
        if self._model is not None:
            return
        from chatterbox.tts import ChatterboxTTS

        model = None
        try:
            model = ChatterboxTTS.from_pretrained(device=self.device)
            self._model = model
            self.use_reference(self.reference)
        except BaseException:
            model = self._model = self._conds = None
            self._free()
            raise

    def use_reference(self, reference: Path) -> None:
        """Condition the loaded model on another reference clip."""
        model = self._model
        if model is None:
            raise RuntimeError("Chatterbox is not loaded")
        model.prepare_conditionals(str(reference), exaggeration=self.exaggeration)
        # Keep the parts, not a deepcopy: prepare_conditionals yields
        # non-leaf tensors, and generate() only ever swaps conds.t3 on
        # the wrapper (it never edits tensors in place).
        self._conds = (model.conds.t3, dict(model.conds.gen))
        self.reference = reference

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
