"""Tests for intent-based agent routing in JarvisSystem."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


class TestDetectAgentIntent:
    """Test _detect_agent_intent pattern matching."""

    @pytest.fixture()
    def system(self):
        """Create a minimal JarvisSystem instance for testing _detect_agent_intent."""
        from openjarvis.system import JarvisSystem

        mock_engine = MagicMock()
        mock_engine.engine_name = "mock"
        sys = JarvisSystem.__new__(JarvisSystem)
        sys.engine = mock_engine
        sys.model = "test-model"
        sys.agent_name = "simple"
        sys.tools = []
        sys.bus = MagicMock()
        yield sys

    def test_good_morning_triggers_digest(self, system):
        with patch("openjarvis.core.registry.AgentRegistry") as reg:
            reg.contains.return_value = True
            assert system._detect_agent_intent("Good morning!") == "morning_digest"

    def test_good_morning_jarvis_triggers_digest(self, system):
        with patch("openjarvis.core.registry.AgentRegistry") as reg:
            reg.contains.return_value = True
            result = system._detect_agent_intent("Good morning Jarvis")
            assert result == "morning_digest"

    def test_morning_digest_triggers(self, system):
        with patch("openjarvis.core.registry.AgentRegistry") as reg:
            reg.contains.return_value = True
            query = "Show me my morning digest"
            assert system._detect_agent_intent(query) == "morning_digest"

    def test_daily_briefing_triggers(self, system):
        with patch("openjarvis.core.registry.AgentRegistry") as reg:
            reg.contains.return_value = True
            query = "Give me my daily briefing"
            assert system._detect_agent_intent(query) == "morning_digest"

    def test_morning_briefing_triggers(self, system):
        with patch("openjarvis.core.registry.AgentRegistry") as reg:
            reg.contains.return_value = True
            query = "morning briefing please"
            assert system._detect_agent_intent(query) == "morning_digest"

    def test_regular_question_no_trigger(self, system):
        assert system._detect_agent_intent("What is the weather?") is None

    def test_good_afternoon_no_trigger(self, system):
        assert system._detect_agent_intent("Good afternoon") is None

    def test_no_agent_registered_returns_none(self, system):
        with patch("openjarvis.core.registry.AgentRegistry") as reg:
            reg.contains.return_value = False
            assert system._detect_agent_intent("Good morning!") is None


class TestGeneralDigestFromHermes:
    """The general-digest intent answers from Hermes, never generates locally."""

    @pytest.fixture()
    def orchestrator(self):
        from openjarvis.system.orchestrator import QueryOrchestrator

        system = MagicMock()
        system.agent_name = "simple"
        system.config.agent.context_from_memory = False
        return QueryOrchestrator(system)

    def test_good_morning_returns_hermes_text(self, orchestrator):
        with (
            patch("openjarvis.core.registry.AgentRegistry") as reg,
            patch(
                "openjarvis.agents.hermes_digest.fetch_today_text",
                return_value="Good morning, sir.",
            ) as fetch,
            patch.object(orchestrator, "_run_agent") as run_agent,
        ):
            reg.contains.return_value = True
            result = orchestrator.ask("Good morning!")

        assert result["content"] == "Good morning, sir."
        assert result["engine"] == "hermes"
        fetch.assert_called_once_with("general")
        run_agent.assert_not_called()

    def test_no_digest_today(self, orchestrator):
        with (
            patch("openjarvis.core.registry.AgentRegistry") as reg,
            patch(
                "openjarvis.agents.hermes_digest.fetch_today_text", return_value=None
            ),
        ):
            reg.contains.return_value = True
            result = orchestrator.ask("morning digest please")

        assert result["content"] == "Hermes has no digest for today yet."

    def test_bridge_down(self, orchestrator):
        import httpx

        with (
            patch("openjarvis.core.registry.AgentRegistry") as reg,
            patch(
                "openjarvis.agents.hermes_digest.fetch_today_text",
                side_effect=httpx.ConnectError("refused"),
            ),
        ):
            reg.contains.return_value = True
            result = orchestrator.ask("daily briefing")

        assert "unavailable" in result["content"]
