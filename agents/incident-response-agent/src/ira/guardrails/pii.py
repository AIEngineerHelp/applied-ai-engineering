import re
import threading
from typing import Any

from src.ira.config import settings

_IPV4 = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
# A human name: capitalised alphabetic words ("John", "O'Brien", "Anne-Marie").
_NAME_WORD = re.compile(r"[A-Z][a-z]+(?:['\u2019-][A-Za-z]+)*")
# Words right before a single capitalised word that make it a person reference.
_PERSON_CUE = re.compile(
    r"(?i)\b(?:contact|on[- ]?call|owner|assignee|engineer|reported by|paged|mr|mrs|ms|dr)"
    r"\W{0,3}$"
)


def _looks_like_person(text: str, start: int, end: int) -> bool:
    """spaCy's PERSON entity fires on log identifiers (block/JVM ids, hostnames, "KB",
    "boot", "Token"). Keep it only for things shaped like human names: two or more
    capitalised words, or one capitalised word introduced by a person cue. Lowercase
    login usernames (e.g. "root", "chen") are operational signal, like IPs, and are kept."""
    words = text[start:end].split()
    if not words or not all(_NAME_WORD.fullmatch(w) for w in words):
        return False
    # The value of a key=value / key: value pair (os.name=Linux, SleepType: Normal Sleep).
    if re.search(r"[A-Za-z0-9_.]\s?[=:]\s?$", text[max(0, start - 3): start]):
        return False
    if len(words) >= 2:
        return True
    return bool(_PERSON_CUE.search(text[max(0, start - 24): start]))


class PIIScrubber:
    """Presidio-backed PII redaction. Engines load lazily (spaCy model load is slow)
    and are shared process-wide via `get_scrubber()`."""

    def __init__(self, entities: list[str] | None = None, score_threshold: float | None = None):
        self.entities = entities or settings.pii_entities
        self.score_threshold = (settings.pii_score_threshold if score_threshold is None
                                else score_threshold)
        self._lock = threading.Lock()
        self._analyzer: Any = None
        self._anonymizer: Any = None

    def _engines(self) -> tuple[Any, Any]:
        with self._lock:
            if self._analyzer is None:
                from presidio_analyzer import AnalyzerEngine
                from presidio_anonymizer import AnonymizerEngine

                self._analyzer = AnalyzerEngine()
                self._anonymizer = AnonymizerEngine()  # type: ignore[no-untyped-call]
        return self._analyzer, self._anonymizer

    def scrub(self, text: str) -> str:
        if not text:
            return ""
        analyzer, anonymizer = self._engines()
        results = analyzer.analyze(text=text, language="en", entities=self.entities,
                                   score_threshold=self.score_threshold)
        # Presidio's phone recognizer also matches IPv4 addresses (e.g. 173.234.31.186).
        # IPs are operational signal, not personal data here, so keep them.
        results = [r for r in results
                   if not (r.entity_type == "PHONE_NUMBER"
                           and _IPV4.search(text[max(0, r.start - 4): r.end + 4]))
                   and not (r.entity_type == "PERSON"
                            and not _looks_like_person(text, r.start, r.end))]
        if not results:
            return text
        return str(anonymizer.anonymize(text=text, analyzer_results=results).text)

    def scrub_obj(self, obj: Any) -> Any:
        """Recursively scrub every string inside dicts/lists."""
        if isinstance(obj, str):
            return self.scrub(obj)
        if isinstance(obj, dict):
            return {k: self.scrub_obj(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self.scrub_obj(v) for v in obj]
        return obj


_scrubber: PIIScrubber | None = None


def get_scrubber() -> PIIScrubber:
    global _scrubber
    if _scrubber is None:
        _scrubber = PIIScrubber()
    return _scrubber
