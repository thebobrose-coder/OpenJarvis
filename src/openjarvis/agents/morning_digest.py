"""Morning Digest Agent — synthesizes a daily briefing from multiple sources.

Thin orchestrator that delegates to digest_collect (data fetching),
the LLM (narrative synthesis), and text_to_speech (audio generation).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

from openjarvis.agents._stubs import AgentContext, AgentResult, ToolUsingAgent
from openjarvis.agents.digest_store import DigestArtifact, DigestStore
from openjarvis.core.paths import get_config_dir
from openjarvis.core.registry import AgentRegistry
from openjarvis.core.types import Message, Role, ToolCall

_SECTION_PROMPTS = {
    "messages": "MESSAGES — Prioritize provided messages or tasks needing action.",
    "calendar": "CALENDAR — Cover only provided upcoming events.",
    "health": "HEALTH — Describe only supported trends; omit raw measurements.",
    "world": "WORLD — Summarize only provided world items.",
    "music": "MUSIC — Summarize only provided listening information.",
    "weather": (
        "WEATHER — Summarize only the provided current conditions and forecast. "
        "Keep it brief and practical, not a full narrative."
    ),
}

# Config overrides for a MorningDigestAgent run outside the original
# single global [digest] section -- e.g. a 15-minute weather pipeline
# running independently of the once-daily general digest. "general"
# (the original digest) needs no entry: it keeps reading straight from
# config.toml's [digest] section, as it always has. Voice/TTS backend
# and honorific are intentionally NOT overridden here -- every category
# shares the same configured voice, so the whole dashboard reads as one
# consistent narrator, not a different voice per panel.
DIGEST_CATEGORY_PRESETS = {
    "weather": {
        "persona": "weather",
        "sections": ["weather"],
        "section_sources": {"weather": ["weather"]},
    },
}


def _load_persona(persona_name: str) -> str:
    """Load a persona prompt file by name."""
    search_paths = [
        Path("configs/openjarvis/prompts/personas") / f"{persona_name}.md",
        get_config_dir() / "prompts" / "personas" / f"{persona_name}.md",
    ]
    for p in search_paths:
        if p.exists():
            return p.read_text(encoding="utf-8")
    return ""


@AgentRegistry.register("morning_digest")
class MorningDigestAgent(ToolUsingAgent):
    """Pre-compute a daily digest from configured data sources."""

    agent_id = "morning_digest"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # Extract digest-specific kwargs before passing to parent
        self._persona = kwargs.pop("persona", "jarvis")
        self._sections = kwargs.pop(
            "sections", ["messages", "calendar", "health", "world"]
        )
        self._section_sources = kwargs.pop("section_sources", {})
        self._timezone = kwargs.pop("timezone", "America/Los_Angeles")
        self._voice_id = kwargs.pop("voice_id", "")
        self._voice_speed = kwargs.pop("voice_speed", 1.0)
        self._tts_backend = kwargs.pop("tts_backend", "cartesia")
        self._digest_store_path = kwargs.pop("digest_store_path", "")
        self._honorific = kwargs.pop("honorific", "sir")
        # "general" is the original world/market digest. A distinct category
        # (e.g. "weather") shares the same DigestStore table/TTS backend but
        # gets its own row filter and its own audio subdirectory so two
        # categories running on independent schedules never overwrite each
        # other's digest.wav.
        self._category = kwargs.pop("category", "general")
        super().__init__(*args, **kwargs)

    def _build_system_prompt(self) -> str:
        """Assemble the system prompt from persona + briefing structure."""
        persona_text = _load_persona(self._persona)
        now = datetime.now()
        honorific = getattr(self, "_honorific", "sir")
        sections = dict.fromkeys(
            str(section).strip().casefold()
            for section in self._sections
            if str(section).strip()
        )
        section_block = "\n".join(
            f"- {_SECTION_PROMPTS.get(section, section.upper())}"
            for section in sections
        )

        return (
            f"{persona_text}\n\n"
            f"Today is {now.strftime('%A, %B %d, %Y')}. "
            f"The time is {now.strftime('%I:%M %p')} in {self._timezone}.\n"
            f"The user's preferred honorific is: {honorific}\n\n"
            "You receive structured data from the user's connected services. "
            "The data has ALREADY been collected — it appears in the user "
            "message. You do NOT fetch anything yourself.\n\n"
            "Produce a concise spoken briefing in decreasing order of importance. "
            "Cover only the configured sections below and only when the collected "
            "data supports them. Silently omit absent data and sources.\n\n"
            f"CONFIGURED SECTIONS:\n{section_block or '- None'}\n\n"
            "Open briefly with the honorific and end after the last supported item. "
            "Do not add conversational offers or personal asides.\n\n"
            "ABSOLUTE RULES (violations are unacceptable):\n"
            "- ONLY facts from the data. Zero hallucination.\n"
            "- NEVER mention disconnected or unavailable sources.\n"
            "- NEVER invent personal context or claim, offer, or suggest actions.\n"
            "- Acknowledge every source that returned data, even briefly.\n"
            "- Email items that are account/service administrivia -- subscription "
            "confirmations, \"welcome to X\" or \"confirm your registration\" "
            "messages, unsubscribe notices -- are NOT news content. Skip them "
            "entirely; do not report that they exist.\n"
            "- No markdown, emojis, bullets, or headers.\n"
            "- Separate distinct topics or sources with a blank line (a plain "
            "double line break) so the briefing reads as short paragraphs, not "
            "one unbroken block. Do not use any other paragraph marker.\n"
            "- STRICT LIMIT: 275 words. Be concise -- more room than before, not license to pad."
        )

    def _resolve_sources(self) -> List[str]:
        """Get the list of connector IDs to query."""
        default_source_map = {
            "messages": [
                "gmail",
                "slack",
                "google_tasks",
                "imessage",
                "github_notifications",
            ],
            "calendar": ["gcalendar"],
            "health": ["oura", "apple_health"],
            "world": ["weather", "hackernews", "news_rss", "fmp_news"],
            "music": ["spotify", "apple_music"],
        }
        sources = set()
        for section in self._sections:
            section_sources = self._section_sources.get(
                section, default_source_map.get(section, [])
            )
            sources.update(section_sources)
        return list(sources)

    def run(
        self,
        input: str,
        context: Optional[AgentContext] = None,
        **kwargs: Any,
    ) -> AgentResult:
        self._emit_turn_start(input)

        # Step 1: Collect data from connectors
        sources = self._resolve_sources()
        collect_call = ToolCall(
            id="digest-collect-1",
            name="digest_collect",
            arguments=json.dumps({"sources": sources, "hours_back": 24}),
        )
        collect_result = self._executor.execute(collect_call)
        collected_data = collect_result.content

        # Step 2: Synthesize narrative via LLM
        system_prompt = self._build_system_prompt()
        messages = [
            Message(role=Role.SYSTEM, content=system_prompt),
            Message(
                role=Role.USER,
                content=(
                    "The following collected data is the only factual evidence for "
                    f"the briefing:\n\n<collected_data>\n{collected_data}\n"
                    "</collected_data>\n\nUse configured sections only. Omit missing "
                    "data and sources. Do not add personal context or activities. "
                    "Use the honorific no more than three times, separate distinct "
                    "topics with a blank line, and keep the briefing under 275 words."
                ),
            ),
        ]

        result = self._generate(messages)
        narrative = self._strip_think_tags(result.get("content", ""))

        # Step 2b: Self-evaluate and optionally regenerate
        quality_score = 0.0
        evaluator_feedback = ""
        try:
            from openjarvis.agents.digest_evaluator import DigestEvaluator

            evaluator = DigestEvaluator(self._engine, self._model)
            quality_score, evaluator_feedback = evaluator.evaluate(
                collected_data, narrative
            )

            if quality_score < 7.0 and evaluator_feedback:
                # Regenerate with feedback
                messages.append(
                    Message(
                        role=Role.USER,
                        content=(
                            f"Your briefing scored {quality_score:.1f}/10. "
                            f"Feedback: {evaluator_feedback}\n"
                            f"Please revise the briefing addressing this feedback."
                        ),
                    )
                )
                result = self._generate(messages)
                narrative = self._strip_think_tags(result.get("content", ""))
        except Exception:  # noqa: BLE001
            pass  # Evaluator failure shouldn't block digest delivery

        # Step 3: Generate audio via TTS
        # Strip any markdown that slipped through (##, *, -, etc.)
        import re

        tts_text = re.sub(r"^#{1,6}\s+", "", narrative, flags=re.MULTILINE)
        tts_text = re.sub(r"^\s*[-*•]\s+", "", tts_text, flags=re.MULTILINE)
        tts_text = re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", tts_text)
        tts_text = tts_text.strip()

        output_dir = str(get_config_dir() / "digests")
        if self._category != "general":
            output_dir = str(get_config_dir() / "digests" / self._category)
        tts_call = ToolCall(
            id="digest-tts-1",
            name="text_to_speech",
            arguments=json.dumps(
                {
                    "text": tts_text,
                    "voice_id": self._voice_id,
                    "backend": self._tts_backend,
                    "speed": self._voice_speed,
                    "output_dir": output_dir,
                }
            ),
        )
        tts_result = self._executor.execute(tts_call)
        audio_path = (
            tts_result.metadata.get("audio_path", "") if tts_result.success else ""
        )

        # Step 4: Store the artifact
        artifact = DigestArtifact(
            text=narrative,
            audio_path=Path(audio_path) if audio_path else Path(""),
            sections={},
            sources_used=sources,
            generated_at=datetime.now(),
            model_used=self._model,
            voice_used=self._voice_id,
            quality_score=quality_score,
            evaluator_feedback=evaluator_feedback,
            category=self._category,
        )

        store = DigestStore(db_path=self._digest_store_path)
        store.save(artifact)
        store.close()

        # Also write to the shared memory pool so other agents (operators,
        # managed agents) can draw on today's digest via memory_retrieve --
        # DigestStore is separate storage and nothing else can see into it
        # otherwise. Best-effort: must never block digest delivery.
        try:
            from openjarvis.tools.storage.sqlite import SQLiteMemory

            memory_source = (
                "daily_briefing"
                if self._category == "general"
                else f"daily_briefing:{self._category}"
            )
            SQLiteMemory().store(narrative, source=memory_source)
        except Exception:  # noqa: BLE001
            pass

        self._emit_turn_end(turns=1)
        return AgentResult(
            content=narrative,
            tool_results=[collect_result, tts_result],
            turns=1,
            metadata={
                "audio_path": audio_path,
                "sources_used": sources,
            },
        )
