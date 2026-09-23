"""Culture & Sports digest -- deterministic collection + ranking, one short
LLM call for the spoken summary, then TTS.

Deliberately NOT routed through MorningDigestAgent's full Jarvis().ask()
tool-loop (see server/digest_routes.py's _generate_digest_sync): the
article ranking is already deterministic (culture_scoring), so the only
step that benefits from a model call is writing the short summary script.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import List

from openjarvis.agents import culture_scoring
from openjarvis.agents.digest_store import DigestArtifact, DigestStore
from openjarvis.connectors._stubs import Document
from openjarvis.core.config import load_config
from openjarvis.core.paths import get_config_dir
from openjarvis.core.registry import ConnectorRegistry
from openjarvis.core.types import Message, Role

# category -> connector registry id. Each connector is the same
# NewsRSSConnector pipeline pointed at a dedicated feed list (see
# connectors/news_rss.py); category is threaded through
# culture_scoring.CATEGORY_METADATA_KEY at collection time since the
# connectors themselves don't distinguish it on the yielded Document.
_SOURCE_CONNECTORS = {
    "soccer": "news_rss_soccer",
    "motorsport": "news_rss_motorsport",
    "entertainment": "news_rss_entertainment",
}

_HOURS_BACK = 24
_TOP_N = 12

_SUMMARY_SYSTEM_PROMPT = (
    "You write a short spoken-word summary of today's top cultural/sports "
    "headlines for an audio briefing. You will be given a ranked list of "
    "up to 12 headlines across soccer, motorsport, and entertainment. "
    "Write a single flowing spoken script, 150-200 words, covering the "
    "most notable items in ranked order. No markdown, no bullets, no "
    "headers, no honorific address -- a short utility read, not a "
    "greeting. Separate distinct topics with a blank line."
)


def _collect_articles() -> List[Document]:
    """Pull from each of the three RSS connectors, tagging category via
    metadata for culture_scoring. One bad feed/connector never drops the
    others -- same best-effort posture as DigestCollectTool.execute.
    """
    import openjarvis.connectors  # noqa: F401 -- registers ConnectorRegistry entries

    since = datetime.now() - timedelta(hours=_HOURS_BACK)
    docs: List[Document] = []
    for category, connector_id in _SOURCE_CONNECTORS.items():
        if not ConnectorRegistry.contains(connector_id):
            continue
        try:
            connector = ConnectorRegistry.get(connector_id)()
            if not connector.is_connected():
                continue
            for doc in connector.sync(since=since):
                doc.metadata[culture_scoring.CATEGORY_METADATA_KEY] = category
                docs.append(doc)
        except Exception:  # noqa: BLE001
            continue
    return docs


def _resolve_summary_model() -> str:
    intel = load_config().intelligence
    return intel.model_short or intel.default_model


def _write_summary(ranked: List[culture_scoring.ScoredArticle]) -> str:
    """One short LLM call: turn the ranked headline list into a spoken
    summary script. Falls back to a plain headline read if no engine is
    available, rather than failing the whole digest.
    """
    headline_block = "\n".join(
        f"{i + 1}. [{sa.category}] {sa.title}" for i, sa in enumerate(ranked)
    )
    if not headline_block:
        return "No cultural or sports headlines are available right now."

    try:
        from openjarvis.engine._discovery import get_engine

        config = load_config()
        resolved = get_engine(config, config.intelligence.preferred_engine or None)
        if resolved is None:
            raise RuntimeError("No inference engine available")
        _, engine = resolved

        messages = [
            Message(role=Role.SYSTEM, content=_SUMMARY_SYSTEM_PROMPT),
            Message(
                role=Role.USER,
                content=f"Today's ranked headlines:\n\n{headline_block}",
            ),
        ]
        result = engine.generate(
            messages, model=_resolve_summary_model(), temperature=0.5, max_tokens=400
        )
        text = (result.get("content") or "").strip()
        if text:
            return text
    except Exception:  # noqa: BLE001 -- summary is best-effort, never blocks the list
        pass

    return "Today's top headlines: " + "; ".join(sa.title for sa in ranked[:_TOP_N])


def generate_culture_digest(db_path: str = "") -> str:
    """Collect, rank, summarize, narrate, and persist today's Culture &
    Sports digest. Returns the summary text (same contract as
    _generate_digest_sync in server/digest_routes.py).
    """
    docs = _collect_articles()
    ranked = culture_scoring.rank_top_n(docs, n=_TOP_N)
    summary = _write_summary(ranked)

    # Reuse TextToSpeechTool directly (not the agent tool-executor) and the
    # same configured voice every other digest category uses, so the
    # dashboard reads as one consistent narrator.
    from openjarvis.tools.text_to_speech import TextToSpeechTool

    dc = load_config().digest
    output_dir = str(get_config_dir() / "digests" / "culture")
    tts_result = TextToSpeechTool().execute(
        text=summary,
        voice_id=dc.voice_id,
        backend=dc.tts_backend,
        speed=dc.voice_speed,
        output_dir=output_dir,
    )
    audio_path = tts_result.metadata.get("audio_path", "") if tts_result.success else ""

    articles = [
        {
            "title": sa.title,
            "url": sa.url,
            "source": sa.document.source,
            "category": sa.category,
            "score": round(sa.final_score, 3),
            "published_at": sa.document.timestamp.isoformat(),
        }
        for sa in ranked
    ]

    artifact = DigestArtifact(
        text=summary,
        audio_path=Path(audio_path) if audio_path else Path(""),
        sections={},
        sources_used=list(_SOURCE_CONNECTORS.values()),
        generated_at=datetime.now(),
        model_used=_resolve_summary_model(),
        voice_used=dc.voice_id,
        category="culture",
        articles=articles,
    )

    store = DigestStore(db_path=db_path)
    store.save(artifact)
    store.close()

    return summary
