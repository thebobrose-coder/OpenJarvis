"""Deterministic news scoring: blends watchlist relevance with event impact.

Replaces the LLM's own freeform prioritization with an auditable, testable
scoring pass over collected news, applied both to the morning digest
(``digest_collect``) and to ad-hoc breaking-news candidates (``watchlist_check``).
No LLM or network calls happen here except through the injected
``MarketCapClient`` -- ticker matching and event-impact scoring are pure,
deterministic text analysis.

Formula: ``final_score = market_cap_factor * 0.4 + event_impact_score * 0.6``.
A confirmed, high-impact event on a micro-cap ticker (low market_cap_factor,
high event_impact_score) still scores materially, rather than being drowned
out by routine news on a mega-cap.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Protocol, Tuple

from openjarvis.connectors._stubs import Document
from openjarvis.core.paths import get_config_dir

_DEFAULT_WATCHLIST_PATH = str(get_config_dir() / "watchlist.json")

_MARKET_CAP_WEIGHT = 0.4
_EVENT_IMPACT_WEIGHT = 0.6

# Deterministic keyword -> impact score table. Matched as whole words,
# case-insensitively, against title + content. The highest matching keyword
# wins per document (scores are not summed) so one alarming word doesn't
# stack over another.
_EVENT_KEYWORDS: Dict[str, float] = {
    # Structural / regulatory / existential
    "bankruptcy": 1.0,
    "fraud": 1.0,
    "sec investigation": 1.0,
    "sanctions": 0.95,
    "sanction": 0.95,
    "fda approval": 0.95,
    "fda rejection": 0.95,
    "recall": 0.9,
    "breakthrough": 0.9,
    "antitrust": 0.85,
    "merger": 0.85,
    "acquisition": 0.85,
    "hack": 0.85,
    "breach": 0.85,
    "acquire": 0.8,
    "contract award": 0.8,
    "fined": 0.8,
    "regulatory": 0.75,
    "lawsuit": 0.7,
    "partnership": 0.6,
    # Market-moving but routine
    "earnings": 0.6,
    "outage": 0.65,
    "supply chain": 0.6,
    "downgrade": 0.6,
    "upgrade": 0.6,
    "guidance": 0.55,
    "shortage": 0.55,
    "delay": 0.4,
    # Soft / noise signals
    "rumor": 0.2,
    "speculation": 0.15,
}

# Market-cap tiers, in dollars, mapped to a 0-1 factor. Deliberately coarse --
# this only needs to distinguish "mega/large" from "small/micro", not price
# a company precisely.
_CAP_TIERS: Tuple[Tuple[float, float], ...] = (
    (200_000_000_000, 1.0),
    (10_000_000_000, 0.8),
    (2_000_000_000, 0.55),
    (300_000_000, 0.3),
)
_MICRO_CAP_FACTOR = 0.1
# Used when a matched ticker's market cap can't be determined at all (no
# client configured, no API key, lookup failed with nothing cached) --
# neutral rather than zero, so a real match isn't unfairly zeroed out just
# because live market data wasn't available.
_UNKNOWN_CAP_FACTOR = 0.5


class MarketCapClient(Protocol):
    """Anything with this method can back market_cap_factor lookups."""

    def get_market_cap(self, ticker: str) -> Optional[float]: ...


@dataclass(frozen=True)
class WatchlistEntry:
    ticker: str
    aliases: Tuple[str, ...] = ()
    category: str = ""

    def match_terms(self) -> Tuple[str, ...]:
        return (self.ticker, *self.aliases)


@dataclass
class ScoreResult:
    matched_tickers: List[str] = field(default_factory=list)
    market_cap_factor: float = 0.0
    event_impact_score: float = 0.0
    final_score: float = 0.0

    @property
    def bucket(self) -> str:
        if self.matched_tickers:
            return "market_movers" if self.market_cap_factor >= 0.6 else "niche_breakthroughs"
        if self.event_impact_score >= 0.6:
            return "strategic_risks"
        return "general"


@dataclass
class ScoredDocument:
    """A Document paired with its ScoreResult -- used by digest_collect."""

    document: Document
    result: ScoreResult

    @property
    def matched_tickers(self) -> List[str]:
        return self.result.matched_tickers

    @property
    def market_cap_factor(self) -> float:
        return self.result.market_cap_factor

    @property
    def event_impact_score(self) -> float:
        return self.result.event_impact_score

    @property
    def final_score(self) -> float:
        return self.result.final_score

    @property
    def bucket(self) -> str:
        return self.result.bucket


def _configured_watchlist_path() -> str:
    """[digest] watchlist_path from config.toml, if set, else the default path."""
    try:
        from openjarvis.core.config import load_config

        configured = load_config().digest.watchlist_path
        if configured:
            return configured
    except Exception:  # noqa: BLE001 -- config load failure must not break loading
        pass
    return _DEFAULT_WATCHLIST_PATH


def load_watchlist(path: str = "") -> List[WatchlistEntry]:
    """Load the ticker watchlist. Returns [] if unconfigured or unreadable --
    every caller treats an empty watchlist as "scoring is off", so a missing
    or malformed file degrades to today's unfiltered behavior, not an error.
    """
    p = Path(path or _configured_watchlist_path())
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []

    entries: List[WatchlistEntry] = []
    for raw in data.get("entries", []):
        if not isinstance(raw, dict):
            continue
        ticker = str(raw.get("ticker", "")).strip()
        if not ticker:
            continue
        aliases = tuple(
            str(a).strip() for a in raw.get("aliases", []) if str(a).strip()
        )
        entries.append(
            WatchlistEntry(
                ticker=ticker,
                aliases=aliases,
                category=str(raw.get("category", "")),
            )
        )
    return entries


def match_watchlist(text: str, watchlist: List[WatchlistEntry]) -> List[WatchlistEntry]:
    """Return watchlist entries whose ticker or any alias appears in *text*.

    Whole-word, case-insensitive match. Note: single-letter tickers (e.g.
    "F") can still false-positive on isolated letters in prose; acceptable
    for a v1 heuristic filter, not a hard limiter.
    """
    if not watchlist or not text:
        return []
    text_cf = text.casefold()
    matches: List[WatchlistEntry] = []
    for entry in watchlist:
        for term in entry.match_terms():
            term_cf = term.casefold().strip()
            if not term_cf:
                continue
            if re.search(rf"\b{re.escape(term_cf)}\b", text_cf):
                matches.append(entry)
                break
    return matches


def compute_event_impact_score(text: str) -> float:
    """Deterministic keyword-weighted event significance, 0-1."""
    if not text:
        return 0.0
    text_cf = text.casefold()
    best = 0.0
    for keyword, score in _EVENT_KEYWORDS.items():
        if keyword in text_cf:
            best = max(best, score)
    return best


def _tier_factor(market_cap: float) -> float:
    for threshold, factor in _CAP_TIERS:
        if market_cap >= threshold:
            return factor
    return _MICRO_CAP_FACTOR


def compute_market_cap_factor(
    matches: List[WatchlistEntry],
    market_cap_client: Optional[MarketCapClient],
) -> float:
    """Highest tier factor among matched tickers, 0-1.

    Uses the max (not average) across matches so a story mentioning both a
    mega-cap and a micro-cap still gets credit for the higher-profile name.
    No watchlist match at all scores 0.0; a match with no resolvable market
    cap scores the neutral _UNKNOWN_CAP_FACTOR, not 0.0.
    """
    if not matches:
        return 0.0
    if market_cap_client is None:
        return _UNKNOWN_CAP_FACTOR
    factors = []
    for entry in matches:
        cap = market_cap_client.get_market_cap(entry.ticker)
        factors.append(_tier_factor(cap) if cap is not None else _UNKNOWN_CAP_FACTOR)
    return max(factors) if factors else _UNKNOWN_CAP_FACTOR


def score_text(
    text: str,
    watchlist: List[WatchlistEntry],
    market_cap_client: Optional[MarketCapClient] = None,
) -> ScoreResult:
    """Score arbitrary text (a headline, a story summary) against the watchlist."""
    matches = match_watchlist(text, watchlist)
    event_score = compute_event_impact_score(text)
    cap_factor = compute_market_cap_factor(matches, market_cap_client)
    final = cap_factor * _MARKET_CAP_WEIGHT + event_score * _EVENT_IMPACT_WEIGHT
    return ScoreResult(
        matched_tickers=[m.ticker for m in matches],
        market_cap_factor=cap_factor,
        event_impact_score=event_score,
        final_score=final,
    )


def score_document(
    doc: Document,
    watchlist: List[WatchlistEntry],
    market_cap_client: Optional[MarketCapClient] = None,
) -> ScoredDocument:
    """Score a collected Document (title + content) against the watchlist."""
    text = f"{doc.title} {doc.content}"
    return ScoredDocument(document=doc, result=score_text(text, watchlist, market_cap_client))


def filter_and_bucket(
    scored_docs: List[ScoredDocument],
    top_n: int = 8,
) -> Dict[str, List[ScoredDocument]]:
    """Keep every watchlist-matched document, plus the top-N highest-scoring
    unmatched ones; drop the rest. Groups survivors into buckets, each sorted
    by final_score descending.
    """
    matched = [sd for sd in scored_docs if sd.matched_tickers]
    unmatched = [sd for sd in scored_docs if not sd.matched_tickers]
    unmatched.sort(key=lambda sd: sd.final_score, reverse=True)
    kept = matched + unmatched[:top_n]

    buckets: Dict[str, List[ScoredDocument]] = {
        "market_movers": [],
        "strategic_risks": [],
        "niche_breakthroughs": [],
        "general": [],
    }
    for sd in kept:
        buckets[sd.bucket].append(sd)
    for items in buckets.values():
        items.sort(key=lambda sd: sd.final_score, reverse=True)
    return buckets
