from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path

import httpx
import pytest

from voiceagent.crm.client import CRMClient, RetryPolicy
from voiceagent.crm.server import CRMState, create_app
from voiceagent.store import CallStore

TODAY = date(2026, 10, 26)  # a Monday, so the next days have weekday slots


@pytest.fixture
def crm_state() -> CRMState:
    return CRMState(today=TODAY)


@pytest.fixture
def make_client(crm_state: CRMState):  # type: ignore[no-untyped-def]
    clients: list[CRMClient] = []

    def factory(**policy: float) -> CRMClient:
        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        client = CRMClient(
            "http://crm.test", "dev-crm-key",
            transport=httpx.ASGITransport(app=create_app(crm_state)),
            policy=RetryPolicy(**policy), sleep=fake_sleep)  # type: ignore[arg-type]
        client.sleeps = sleeps  # type: ignore[attr-defined]
        clients.append(client)
        return client

    return factory


@pytest.fixture
def store(tmp_path: Path) -> Iterator[CallStore]:
    yield CallStore(tmp_path / "calls.db")
