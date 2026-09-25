import logging

import pytest

from src.ira.config import Settings
from src.ira.observability.logging import RedactingFilter, redact


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # Other tests (e.g. testcontainers) may leave settings in the process environment.
    import os

    for key in list(os.environ):
        if key.upper() in {f.upper() for f in Settings.model_fields}:
            monkeypatch.delenv(key)


def test_prod_refuses_insecure_defaults() -> None:
    s = Settings(_env_file=None, environment="prod")  # type: ignore[call-arg]
    errors = " ".join(s.production_errors())
    for expected in ("AUTH_MODE", "QUEUE_ENABLED", "POSTGRES_PASSWORD", "LITELLM_MASTER_KEY"):
        assert expected in errors
    with pytest.raises(RuntimeError):
        s.validate_for_startup()


def test_prod_accepts_hardened_config() -> None:
    s = Settings(  # type: ignore[call-arg]
        _env_file=None, environment="prod", auth_mode="oidc", oidc_issuer="https://idp",
        oidc_audience="ira", redis_enabled=True, postgres_enabled=True, queue_enabled=True,
        postgres_password="p@ss/w:rd%", neo4j_password="x" * 20, litellm_master_key="sk-" + "y" * 30,
        cors_origins=["https://ira.example.com"],
    )
    assert s.production_errors() == []
    assert "p%40ss%2Fw%3Ard%25@" in s.postgres_dsn_sync


@pytest.mark.parametrize("secret", [
    "Authorization: Bearer abc.def.ghi",
    "postgresql://ira:hunter2@db:5432/ira",
    "api_key=sk-live-1234567890",
    "token: 'supersecretvalue'",
    "AIzaSyFAKE0000000000000000000000000000",
])
def test_log_redaction(secret: str) -> None:
    out = redact(secret)
    for leaked in ("abc.def.ghi", "hunter2", "sk-live-1234567890", "supersecretvalue",
                   "SyFAKE0000000000000000000000000000"):
        assert leaked not in out


def test_filter_redacts_formatted_args() -> None:
    record = logging.LogRecord("x", logging.INFO, "f", 1, "dsn=%s", ("postgresql://u:pw123@h/d",),
                               None)
    RedactingFilter().filter(record)
    assert "pw123" not in record.getMessage()


def test_relative_paths_anchor_to_repo_root(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from src.ira.config import ROOT_DIR

    s = Settings(_env_file=None, artifacts_dir="data/artifacts")  # type: ignore[call-arg]
    assert s.artifacts_dir == ROOT_DIR / "data" / "artifacts"
    assert s.artifacts_dir.as_uri().startswith("file:///")
    assert Settings(_env_file=None, artifacts_dir=tmp_path).artifacts_dir == tmp_path  # type: ignore[call-arg]
