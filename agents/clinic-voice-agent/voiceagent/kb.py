"""The clinic's knowledge base: markdown sections ranked with BM25.

A dozen short policy sections do not need embeddings or a vector store. BM25 is
deterministic, runs in microseconds inside the call, and returns the source of every
answer, which matters when a caller is told what the cancellation fee is.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .workflow import ROOT

KNOWLEDGE_DIR = ROOT / "knowledge"
STOPWORDS = set(
    "a an and are as at be by can do does for from how i in is it my of on or the to what when "
    "where which who will with you your we our me".split()
)


@dataclass(frozen=True)
class Passage:
    source: str
    heading: str
    text: str


def _tokens(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return [w.rstrip("s") if len(w) > 3 else w for w in words if w not in STOPWORDS]


def load_passages(directory: Path = KNOWLEDGE_DIR) -> list[Passage]:
    passages = []
    for path in sorted(directory.glob("*.md")):
        heading = ""
        for block in re.split(r"\n(?=## )", path.read_text()):
            lines = block.strip().splitlines()
            if not lines:
                continue
            if lines[0].startswith("## "):
                heading = lines[0][3:].strip()
                body = " ".join(lines[1:]).strip()
            else:
                body = " ".join(line for line in lines if not line.startswith("#")).strip()
            if body:
                passages.append(Passage(path.name, heading, body))
    return passages


class KnowledgeBase:
    def __init__(self, passages: list[Passage] | None = None, k1: float = 1.4, b: float = 0.75):
        self.passages = passages if passages is not None else load_passages()
        self.k1, self.b = k1, b
        self.docs = [Counter(_tokens(f"{p.heading} {p.heading} {p.text}")) for p in self.passages]
        self.avg_len = sum(sum(d.values()) for d in self.docs) / max(len(self.docs), 1)
        df: Counter[str] = Counter()
        for doc in self.docs:
            df.update(doc.keys())
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def search(self, query: str, limit: int = 2, min_score: float = 1.0) -> list[Passage]:
        terms = _tokens(query)
        scored = []
        for passage, doc in zip(self.passages, self.docs, strict=True):
            length = sum(doc.values())
            score = 0.0
            for term in terms:
                tf = doc.get(term, 0)
                if tf:
                    norm = tf + self.k1 * (1 - self.b + self.b * length / self.avg_len)
                    score += self.idf[term] * tf * (self.k1 + 1) / norm
            if score >= min_score:
                scored.append((score, passage))
        scored.sort(key=lambda pair: -pair[0])
        return [p for _, p in scored[:limit]]
