"""Tests for digest_scoring -- deterministic watchlist/event scoring."""

from __future__ import annotations

from datetime import datetime

from openjarvis.agents.digest_scoring import (
    ScoredDocument,
    ScoreResult,
    WatchlistEntry,
    compute_event_impact_score,
    compute_market_cap_factor,
    filter_and_bucket,
    load_watchlist,
    match_watchlist,
    score_document,
    score_text,
)
from openjarvis.connectors._stubs import Document


def _doc(doc_id: str, title: str, content: str = "", metadata: dict | None = None) -> Document:
    return Document(
        doc_id=doc_id,
        source="news_rss",
        doc_type="article",
        content=content,
        title=title,
        timestamp=datetime(2026, 9, 21, 12, 0),
        metadata=metadata or {},
    )


def test_load_watchlist_missing_file_returns_empty(tmp_path):
    result = load_watchlist(str(tmp_path / "nonexistent.json"))
    assert result == []


def test_load_watchlist_malformed_json_returns_empty(tmp_path):
    p = tmp_path / "watchlist.json"
    p.write_text("not valid json{", encoding="utf-8")
    assert load_watchlist(str(p)) == []


def test_load_watchlist_parses_entries(tmp_path):
    p = tmp_path / "watchlist.json"
    p.write_text(
        '{"entries": [{"ticker": "NVDA", "aliases": ["Nvidia"], "category": "defense_ai"}]}',
        encoding="utf-8",
    )
    entries = load_watchlist(str(p))
    assert len(entries) == 1
    assert entries[0].ticker == "NVDA"
    assert entries[0].aliases == ("Nvidia",)
    assert entries[0].category == "defense_ai"


def test_match_watchlist_matches_ticker():
    watchlist = [WatchlistEntry(ticker="NVDA", aliases=("Nvidia",))]
    matches = match_watchlist("NVDA shares surged after earnings", watchlist)
    assert len(matches) == 1
    assert matches[0].ticker == "NVDA"


def test_match_watchlist_matches_alias_not_just_ticker():
    watchlist = [WatchlistEntry(ticker="NVDA", aliases=("Nvidia",))]
    matches = match_watchlist("Nvidia announced a new chip today", watchlist)
    assert len(matches) == 1


def test_match_watchlist_no_match_returns_empty():
    watchlist = [WatchlistEntry(ticker="NVDA", aliases=("Nvidia",))]
    matches = match_watchlist("Completely unrelated headline about weather", watchlist)
    assert matches == []


def test_match_watchlist_word_boundary_avoids_substring_false_positive():
    # "IONQ" should not match inside an unrelated longer token.
    watchlist = [WatchlistEntry(ticker="ION")]
    matches = match_watchlist("IONQ announced quantum milestone", watchlist)
    assert matches == []


def test_match_watchlist_empty_watchlist_or_text():
    assert match_watchlist("NVDA news", []) == []
    assert match_watchlist("", [WatchlistEntry(ticker="NVDA")]) == []


def test_compute_event_impact_score_matches_keyword():
    assert compute_event_impact_score("Company announces bankruptcy filing") == 1.0
    assert compute_event_impact_score("Quarterly earnings beat expectations") == 0.6


def test_compute_event_impact_score_no_keyword_is_zero():
    assert compute_event_impact_score("A perfectly ordinary headline") == 0.0


def test_compute_event_impact_score_empty_text():
    assert compute_event_impact_score("") == 0.0


def test_compute_event_impact_score_takes_highest_not_sum():
    # Contains both "earnings" (0.6) and "bankruptcy" (1.0) -- should be 1.0, not 1.6.
    score = compute_event_impact_score("Earnings call reveals looming bankruptcy risk")
    assert score == 1.0


def test_compute_market_cap_factor_no_matches_is_zero():
    assert compute_market_cap_factor([], None) == 0.0


def test_compute_market_cap_factor_no_client_is_neutral():
    matches = [WatchlistEntry(ticker="NVDA")]
    assert compute_market_cap_factor(matches, None) == 0.5


def test_compute_market_cap_factor_uses_max_tier_among_matches():
    class FakeClient:
        def get_market_cap(self, ticker):
            return {"MEGA": 3_000_000_000_000, "MICRO": 50_000_000}.get(ticker)

    matches = [WatchlistEntry(ticker="MEGA"), WatchlistEntry(ticker="MICRO")]
    factor = compute_market_cap_factor(matches, FakeClient())
    assert factor == 1.0  # mega-cap tier wins, not averaged down


def test_compute_market_cap_factor_unresolvable_ticker_is_neutral():
    class FailingClient:
        def get_market_cap(self, ticker):
            return None

    matches = [WatchlistEntry(ticker="NVDA")]
    assert compute_market_cap_factor(matches, FailingClient()) == 0.5


def test_score_text_formula():
    class FakeClient:
        def get_market_cap(self, ticker):
            return 3_000_000_000_000  # mega cap -> factor 1.0

    watchlist = [WatchlistEntry(ticker="NVDA", aliases=("Nvidia",))]
    result = score_text("Nvidia announces breakthrough partnership", watchlist, FakeClient())
    assert result.matched_tickers == ["NVDA"]
    assert result.market_cap_factor == 1.0
    assert result.event_impact_score == 0.9  # "breakthrough"
    assert result.final_score == 1.0 * 0.4 + 0.9 * 0.6


def test_score_result_bucket_market_movers():
    result = ScoreResult(matched_tickers=["NVDA"], market_cap_factor=0.8, event_impact_score=0.9)
    assert result.bucket == "market_movers"


def test_score_result_bucket_niche_breakthroughs():
    result = ScoreResult(matched_tickers=["IONQ"], market_cap_factor=0.3, event_impact_score=0.9)
    assert result.bucket == "niche_breakthroughs"


def test_score_result_bucket_strategic_risks():
    result = ScoreResult(matched_tickers=[], market_cap_factor=0.0, event_impact_score=0.85)
    assert result.bucket == "strategic_risks"


def test_score_result_bucket_general_fallback():
    result = ScoreResult(matched_tickers=[], market_cap_factor=0.0, event_impact_score=0.1)
    assert result.bucket == "general"


def test_score_document_wraps_title_and_content():
    watchlist = [WatchlistEntry(ticker="NVDA", aliases=("Nvidia",))]
    doc = _doc("d1", "Nvidia surges", "The company announced a merger today.")
    scored = score_document(doc, watchlist, None)
    assert isinstance(scored, ScoredDocument)
    assert scored.document is doc
    assert scored.matched_tickers == ["NVDA"]
    assert scored.event_impact_score == 0.85  # "merger"


def test_score_document_prefers_authoritative_symbol_metadata():
    # Title/content mention nothing matchable by text, but metadata carries
    # an authoritative ticker tag (as fmp_news documents do) -- should still match.
    watchlist = [WatchlistEntry(ticker="IONQ")]
    doc = _doc("d2", "Quantum computing milestone reported", metadata={"symbol": "IONQ"})
    scored = score_document(doc, watchlist, None)
    assert scored.matched_tickers == ["IONQ"]


def test_score_document_symbol_metadata_not_in_watchlist_falls_back_to_text():
    # symbol metadata present but doesn't match any watchlist entry --
    # should still fall back to text matching rather than giving up.
    watchlist = [WatchlistEntry(ticker="NVDA", aliases=("Nvidia",))]
    doc = _doc("d3", "Nvidia news", "Nvidia announced something.", metadata={"symbol": "UNRELATED"})
    scored = score_document(doc, watchlist, None)
    assert scored.matched_tickers == ["NVDA"]


def test_filter_and_bucket_keeps_all_ticker_matches_regardless_of_score():
    watchlist = [WatchlistEntry(ticker="NVDA")]
    matched_low_score = score_document(_doc("m1", "NVDA mentioned in passing"), watchlist, None)
    scored = [matched_low_score]
    buckets = filter_and_bucket(scored, top_n=0)
    all_kept = [sd for items in buckets.values() for sd in items]
    assert matched_low_score in all_kept


def test_filter_and_bucket_drops_low_scoring_unmatched_beyond_top_n():
    watchlist: list[WatchlistEntry] = []  # nothing will match
    docs = [
        score_document(_doc(f"u{i}", f"Generic headline {i}"), watchlist, None)
        for i in range(5)
    ]
    buckets = filter_and_bucket(docs, top_n=2)
    total_kept = sum(len(items) for items in buckets.values())
    assert total_kept == 2


def test_filter_and_bucket_sorts_each_bucket_by_score_descending():
    watchlist = [WatchlistEntry(ticker="NVDA")]
    high = score_document(_doc("h1", "NVDA bankruptcy fears"), watchlist, None)
    low = score_document(_doc("l1", "NVDA routine mention"), watchlist, None)
    buckets = filter_and_bucket([low, high], top_n=10)
    matched_bucket = buckets["niche_breakthroughs"] + buckets["market_movers"]
    scores = [sd.final_score for sd in matched_bucket]
    assert scores == sorted(scores, reverse=True)
