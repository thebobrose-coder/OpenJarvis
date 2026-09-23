"""breaking_alert_record tool -- lets the breaking_news_monitor operator
persist an alert for the dashboard/sidebar to read, alongside its existing
channel_send(Telegram) delivery. Synthesizes a short audio summary the same
way agents/culture_digest.py does, so the sidebar's "Breaking" item has
something to play without a separate TTS pipeline."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from openjarvis.core.registry import ToolRegistry
from openjarvis.core.types import ToolResult
from openjarvis.tools._stubs import BaseTool, ToolSpec


@ToolRegistry.register("breaking_alert_record")
class BreakingAlertRecordTool(BaseTool):
    """Record a breaking-news alert (headline/summary/url) for the dashboard."""

    tool_id = "breaking_alert_record"
    is_local = False

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="breaking_alert_record",
            description=(
                "Record a breaking-news alert that cleared the alert bar, so "
                "it shows up on the dashboard/sidebar (in addition to the "
                "Telegram channel_send). Call this once per alert, right "
                "alongside channel_send, not instead of it. Synthesizes a "
                "short spoken audio summary automatically."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "headline": {
                        "type": "string",
                        "description": "Short headline for the alert.",
                    },
                    "summary": {
                        "type": "string",
                        "description": "The 2-3 sentence explanation of what happened and why it matters (same content sent to Telegram).",
                    },
                    "url": {
                        "type": "string",
                        "description": "Direct source URL, if available.",
                    },
                },
                "required": ["headline", "summary"],
            },
            category="data",
            timeout_seconds=60.0,
        )

    def execute(self, **params: Any) -> ToolResult:
        from openjarvis.agents.breaking_alert_store import BreakingAlert, BreakingAlertStore
        from openjarvis.core.config import load_config
        from openjarvis.core.paths import get_config_dir
        from openjarvis.tools.text_to_speech import TextToSpeechTool

        headline = str(params.get("headline", "")).strip()
        summary = str(params.get("summary", "")).strip()
        url = str(params.get("url", "")).strip()

        if not headline or not summary:
            return ToolResult(
                tool_name="breaking_alert_record",
                content="headline and summary are required.",
                success=False,
            )

        dc = load_config().digest
        output_dir = str(get_config_dir() / "digests" / "breaking")
        tts_result = TextToSpeechTool().execute(
            text=f"{headline}. {summary}",
            voice_id=dc.voice_id,
            backend=dc.tts_backend,
            speed=dc.voice_speed,
            output_dir=output_dir,
        )
        audio_path = tts_result.metadata.get("audio_path", "") if tts_result.success else ""

        store = BreakingAlertStore()
        store.save(
            BreakingAlert(
                headline=headline,
                summary=summary,
                url=url,
                audio_path=Path(audio_path) if audio_path else Path(""),
                alerted_at=datetime.now(),
            )
        )
        store.close()

        return ToolResult(
            tool_name="breaking_alert_record",
            content=f"Recorded: {headline}",
            success=True,
        )
