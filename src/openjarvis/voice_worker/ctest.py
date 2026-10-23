"""The voice C-test for the long-form lane (hq 0019 D5): candidate character
voices for the operator to pick from, one set per channel.

For every candidate Kokoro voice it writes the Kokoro reference clip and the
same neutral passage spoken by Chatterbox conditioned on that reference, plus
an ``index.html`` to listen side by side. The labels come from the command
line, so no channel or persona name lives in the repo. Every reference is
synthetic (0009). Run it from the worker venv, with ``src`` as the working
directory::

    python -m openjarvis.voice_worker.ctest --out <folder> \\
        --set "Label one=am_onyx,bm_lewis,am_fenrir,am_eric" \\
        --set "Label two=am_michael,am_adam,am_echo,am_liam"

It takes the GPU lease under its own holder name (so the running worker sees
a foreign lease and waits), and gives up after ``--wait-minutes``."""

from __future__ import annotations

import argparse
import html
import logging
import sys
import time
from pathlib import Path

from . import paths
from .core import GpuLease, chunk_text, silence
from .longform import ASSISTANT_VOICE, KOKORO_VOICE

logger = logging.getLogger("openjarvis.voice_worker")

HOLDER = "openjarvis-voice-ctest"

# About 30 seconds, neutral, no persona or brand in it.
PASSAGE = (
    "Before we begin, a short note on method. Every figure you will hear tonight "
    "comes from a public record, and every record has a date on it. Where the "
    "record is thin, I will say so. Where two sources disagree, you will hear "
    "both. The aim is not to persuade you of anything. The aim is to lay the "
    "pieces out in order, so that by the end of the hour you can see the shape "
    "of the thing for yourself, and decide what it is worth."
)


def parse_sets(raw: list[str]) -> list[tuple[str, list[str]]]:
    sets: list[tuple[str, list[str]]] = []
    seen: set[str] = set()
    for item in raw:
        label, _, voices = item.partition("=")
        names = [v.strip() for v in voices.split(",") if v.strip()]
        if not label.strip() or not names:
            raise SystemExit(f"--set needs 'Label=voice,voice,...': {item!r}")
        for v in names:
            if not KOKORO_VOICE.match(v):
                raise SystemExit(f"not a Kokoro voice id: {v}")
            if v == ASSISTANT_VOICE:
                raise SystemExit(f"{v} is the assistant's own voice")
            if v in seen:
                raise SystemExit(f"{v} is in two sets; the voices must differ")
            seen.add(v)
        sets.append((label.strip(), names))
    return sets


def write_index(out: Path, sets: list[tuple[str, list[str]]], pace: float) -> None:
    rows = []
    for label, voices in sets:
        rows.append(f"<h2>{html.escape(label)}</h2><table>")
        rows.append(
            "<tr><th>Voice</th><th>Kokoro reference</th><th>Chatterbox</th></tr>"
        )
        for v in voices:
            cells = "".join(
                f'<td><audio controls preload="none" src="{v}-{kind}.wav"></audio></td>'
                for kind in ("reference", "chatterbox")
            )
            rows.append(f"<tr><td><code>{v}</code></td>{cells}</tr>")
        rows.append("</table>")
    page = (
        "<!doctype html><meta charset=utf-8><title>Voice C-test</title>"
        "<style>body{font:15px system-ui;margin:24px;max-width:900px}"
        "td,th{padding:6px 12px;text-align:left}audio{width:260px}</style>"
        "<h1>Voice C-test</h1>"
        f"<p>Pick one voice per set. Pace {pace:.2f}; every reference is synthetic "
        "Kokoro. The Chatterbox column is what an episode would sound like.</p>"
        f"<p><b>Passage:</b> {html.escape(PASSAGE)}</p>" + "".join(rows)
    )
    (out / "index.html").write_text(page, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="openjarvis.voice_worker.ctest")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--set", action="append", required=True, dest="sets")
    ap.add_argument("--pace", type=float, default=1.0)
    ap.add_argument("--exaggeration", type=float, default=0.5)
    ap.add_argument("--wait-minutes", type=float, default=60.0)
    ap.add_argument("--device", default="cuda")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    sets = parse_sets(args.sets)
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    from .engines import (
        ChatterboxExpressive,
        KokoroFast,
        _save_wav,
        character_reference,
    )
    from .service import gpu_free_mib, ollama_loaded

    fast = KokoroFast()
    refs: dict[str, Path] = {}
    for _, voices in sets:
        for v in voices:
            refs[v] = character_reference(fast, out / "refs", v, args.pace)
            (out / f"{v}-reference.wav").write_bytes(refs[v].read_bytes())
    logger.info("References ready: %s", ", ".join(refs))

    lease = GpuLease(paths.lease_path(), ollama_loaded, gpu_free_mib, holder=HOLDER)
    deadline = time.monotonic() + args.wait_minutes * 60
    while not lease.acquire("voice-ctest"):
        if time.monotonic() > deadline:
            logger.error("GPU lease not available: %s", lease.availability()[1])
            return 2
        time.sleep(30)
    engine = ChatterboxExpressive(
        next(iter(refs.values())), device=args.device, exaggeration=args.exaggeration
    )
    try:
        engine.load()
        for v, ref in refs.items():
            engine.use_reference(ref)
            parts: list[bytes] = []
            sr = 24000
            for chunk in chunk_text(PASSAGE):
                lease.renew("voice-ctest")
                pcm, sr = engine.render_chunk(chunk, args.exaggeration)
                if parts:
                    parts.append(silence(sr))
                parts.append(pcm)
            _save_wav(out / f"{v}-chatterbox.wav", b"".join(parts), sr)
            logger.info("Rendered %s (%.1f s)", v, len(b"".join(parts)) / 2 / sr)
    finally:
        try:
            engine.unload()
        finally:
            lease.release()
    write_index(out, sets, args.pace)
    logger.info("Done: %s", out / "index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
