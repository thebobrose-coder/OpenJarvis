"""Data-driven registration of OpenAI-compatible inference engines."""

from __future__ import annotations

from openjarvis.core.registry import EngineRegistry
from openjarvis.engine._openai_compat import _OpenAICompatibleEngine

_ENGINES = {
    "vllm": ("VLLMEngine", "http://localhost:8000", "/v1"),
    "sglang": ("SGLangEngine", "http://localhost:30000", "/v1"),
    "llamacpp": ("LlamaCppEngine", "http://localhost:8080", "/v1"),
    "mlx": ("MLXEngine", "http://localhost:8080", "/v1"),
    "lmstudio": ("LMStudioEngine", "http://localhost:1234", "/v1"),
    "exo": ("ExoEngine", "http://localhost:52415", "/v1"),
    "nexa": ("NexaEngine", "http://localhost:18181", "/v1"),
    "uzu": ("UzuEngine", "http://localhost:8000", ""),
    "apple_fm": ("AppleFmEngine", "http://localhost:8079", "/v1"),
    "lemonade": ("LemonadeEngine", "http://localhost:13305", "/v1"),
    "hermes": ("HermesEngine", "http://127.0.0.1:8642", "/v1"),
}

# Engines that may only be reached through an explicit pass-through path,
# never through discovery, MultiEngine, or default-engine fallback. Hermes is
# a remote agent with its own tools: if it became the server engine, its
# replies would drive OpenJarvis's agent tools (shell_exec, file_read, ...),
# handing it system access sideways (hq decision 0002). The chat router in
# ``server/hermes_router.py`` is the only caller.
PASSTHROUGH_ONLY_ENGINES = frozenset({"hermes"})

for _key, (_cls_name, _default_host, _api_prefix) in _ENGINES.items():
    _cls = type(
        _cls_name,
        (_OpenAICompatibleEngine,),
        {
            "engine_id": _key,
            "_default_host": _default_host,
            "_api_prefix": _api_prefix,
            "passthrough_only": _key in PASSTHROUGH_ONLY_ENGINES,
        },
    )
    EngineRegistry.register(_key)(_cls)
    globals()[_cls_name] = _cls


def normalize_openai_base_url(url: str) -> str:
    """Strip a single trailing ``/v1`` segment from a user-supplied base URL.

    Users habitually pass ``http://host:8000/v1`` (the full OpenAI-compatible
    prefix); the engine's ``_api_prefix`` re-appends ``/v1`` to every request
    path, so a trailing copy would double up as ``/v1/v1``. Only a literal
    trailing ``/v1`` is stripped — proxy/gateway path prefixes are preserved.
    """
    base = url.rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base


class OpenAICompatEngine(_OpenAICompatibleEngine):
    """Generic engine for an explicitly-provided OpenAI-compatible endpoint.

    Deliberately NOT registered in ``EngineRegistry``: it is only ever
    constructed with an explicit host (e.g. ``jarvis eval --base-url``), so
    registering it would just add a useless localhost discovery probe and
    interact with the per-test registry wipe.
    """

    engine_id = "openai-compat"
    _api_prefix = "/v1"


__all__ = [name for name, _, _ in _ENGINES.values()] + [
    "OpenAICompatEngine",
    "PASSTHROUGH_ONLY_ENGINES",
    "normalize_openai_base_url",
]
