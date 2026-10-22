from __future__ import annotations

import time
from collections import defaultdict, deque

# Public demo guard so visitors can try samples without draining API keys.
IP_LIMIT = 8
IP_WINDOW_SEC = 60 * 60
GLOBAL_LIMIT = 40
GLOBAL_WINDOW_SEC = 60 * 60

_ip_hits: dict[str, deque[float]] = defaultdict(deque)
_global_hits: deque[float] = deque()


def _prune(bucket: deque[float], now: float, window: float) -> None:
    while bucket and now - bucket[0] > window:
        bucket.popleft()


def check_rate_limit(client_ip: str) -> str | None:
    now = time.time()
    _prune(_global_hits, now, GLOBAL_WINDOW_SEC)
    if len(_global_hits) >= GLOBAL_LIMIT:
        return "This public demo is busy. Try again in a little while."

    bucket = _ip_hits[client_ip or "unknown"]
    _prune(bucket, now, IP_WINDOW_SEC)
    if len(bucket) >= IP_LIMIT:
        return "You have used the sample runs for this hour. Try again later."

    bucket.append(now)
    _global_hits.append(now)
    return None
