import json

import pytest

from guardlab import config


@pytest.fixture
def store_data():
    return json.loads(config.STORE.read_text())


@pytest.fixture
def scenarios():
    return {s["id"]: s for s in map(json.loads, config.SCENARIOS.read_text().splitlines())}


@pytest.fixture
def messages():
    return [json.loads(line) for line in config.MESSAGES.read_text().splitlines()]
