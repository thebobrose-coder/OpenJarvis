"""Deterministic ranking for cultural/sports news: keyword impact blended
with recency. No LLM or network calls happen here -- pure, deterministic
text analysis, same posture as ``digest_scoring.py``.

Soccer/motorsport/entertainment have no ticker/market-cap equivalent, so
this mirrors digest_scoring's shape with ``recency_factor`` standing in for
``market_cap_factor`` as the second axis blended with keyword impact.

Formula: ``final_score = keyword_impact_score * 0.6 + recency_factor * 0.4``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional

from openjarvis.connectors._stubs import Document

_KEYWORD_IMPACT_WEIGHT = 0.6
_RECENCY_WEIGHT = 0.4

# Deterministic keyword -> impact score table, one merged set across all
# three categories since a single Culture & Sports panel ranks them
# together. Matched as a substring, case-insensitively, against title +
# content -- same convention as digest_scoring._EVENT_KEYWORDS. The highest
# matching keyword wins per document (scores are not summed).
_CULTURE_KEYWORDS: Dict[str, float] = {
    # Soccer
    "dies at": 0.95,
    "passes away": 0.95,
    "final": 0.85,
    "sacked": 0.85,
    "red card": 0.8,
    "champions league": 0.8,
    "injury": 0.75,
    "injured": 0.75,
    "relegat": 0.75,  # relegated / relegation
    "transfer": 0.7,
    "signs for": 0.7,
    "hat-trick": 0.7,
    "appointed manager": 0.65,
    # Motorsport
    "crash": 0.85,
    "disqualified": 0.85,
    "championship": 0.85,
    "pole position": 0.65,
    "penalty": 0.6,
    "podium": 0.6,
    "grid penalty": 0.6,
    "retires": 0.55,
    "fastest lap": 0.5,
    # Entertainment
    "box office": 0.75,
    "cancelled": 0.75,
    "canceled": 0.75,
    "award": 0.6,
    "nominat": 0.6,  # nominated / nomination
    "renewed": 0.6,
    "casting": 0.55,
    "premiere": 0.55,
    "engaged": 0.5,
    "split": 0.5,
}

_RECENCY_FULL_SCORE_HOURS = 6.0
_RECENCY_DECAY_HOURS = 48.0
_RECENCY_FLOOR = 0.1

# Set by the caller on Document.metadata before scoring -- the collection
# site knows which connector (soccer/motorsport/entertainment) produced
# each document; the connector's own Document.source field doesn't carry
# this (NewsRSSConnector hardcodes source="news_rss" across all three
# category subclasses), so it's threaded through metadata instead of
# changing that shared connector.
CATEGORY_METADATA_KEY = "culture_category"


@dataclass
class ScoredArticle:
    """A Document paired with its culture-news score and category tag."""

    document: Document
    category: str
    keyword_impact: float
    recency_factor: float
    final_score: float

    @property
    def title(self) -> str:
        return self.document.title

    @property
    def url(self) -> str:
        return self.document.url or ""


def compute_keyword_impact(text: str) -> float:
    """Deterministic keyword-weighted newsworthiness, 0-1. Same convention
    as digest_scoring.compute_event_impact_score: highest matching keyword
    wins, substring match, case-insensitive.
    """
    if not text:
        return 0.0
    text_cf = text.casefold()
    best = 0.0
    for keyword, score in _CULTURE_KEYWORDS.items():
        if keyword in text_cf:
            best = max(best, score)
    return best


def recency_factor(published_at: datetime, *, now: Optional[datetime] = None) -> float:
    """1.0 within the first _RECENCY_FULL_SCORE_HOURS, linear decay to
    _RECENCY_FLOOR by _RECENCY_DECAY_HOURS, floor thereafter.
    """
    now = now or datetime.now()
    # RSS pubDates parse to timezone-aware datetimes when the feed includes
    # an offset (email.utils.parsedate_to_datetime, news_rss.py); `now` is
    # naive. Strip tzinfo the same way news_rss.py already does for its own
    # `since` comparison (news_rss.py:358) rather than requiring every
    # caller to normalize before calling in.
    if published_at.tzinfo is not None:
        published_at = published_at.replace(tzinfo=None)
    age_hours = max(0.0, (now - published_at).total_seconds() / 3600.0)
    if age_hours <= _RECENCY_FULL_SCORE_HOURS:
        return 1.0
    if age_hours >= _RECENCY_DECAY_HOURS:
        return _RECENCY_FLOOR
    span = _RECENCY_DECAY_HOURS - _RECENCY_FULL_SCORE_HOURS
    decayed = 1.0 - (age_hours - _RECENCY_FULL_SCORE_HOURS) / span
    return max(_RECENCY_FLOOR, decayed)


def score_article(doc: Document, *, now: Optional[datetime] = None) -> ScoredArticle:
    """Score a single collected Document. Reads its category from
    ``doc.metadata[CATEGORY_METADATA_KEY]`` (empty string if unset).
    """
    text = f"{doc.title} {doc.content}"
    impact = compute_keyword_impact(text)
    recency = recency_factor(doc.timestamp, now=now)
    final = impact * _KEYWORD_IMPACT_WEIGHT + recency * _RECENCY_WEIGHT
    category = str(doc.metadata.get(CATEGORY_METADATA_KEY, ""))
    return ScoredArticle(
        document=doc,
        category=category,
        keyword_impact=impact,
        recency_factor=recency,
        final_score=final,
    )


def _normalize_title(title: str) -> str:
    """Loose normalization for near-duplicate detection across feeds
    covering the same story.
    """
    return "".join(ch for ch in title.casefold() if ch.isalnum() or ch.isspace()).strip()


def rank_top_n(
    docs: List[Document], n: int = 12, *, now: Optional[datetime] = None
) -> List[ScoredArticle]:
    """Score every document, drop near-duplicate titles (same story covered
    by multiple feeds -- keep the highest-scoring copy), and return the
    top-n by final_score descending.
    """
    scored = [score_article(d, now=now) for d in docs]
    scored.sort(key=lambda sa: sa.final_score, reverse=True)

    seen_titles: set = set()
    deduped: List[ScoredArticle] = []
    for sa in scored:
        key = _normalize_title(sa.title)
        if key and key in seen_titles:
            continue
        if key:
            seen_titles.add(key)
        deduped.append(sa)

    return deduped[:n]
