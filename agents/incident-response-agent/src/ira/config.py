import os
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# LiteLLM's default "DEV" mode loads the whole .env into os.environ at import time. Our
# settings read .env themselves; the side effect leaks secrets and overrides into anything
# that reads the environment (including isolated test settings), so switch it off.
os.environ.setdefault("LITELLM_MODE", "PRODUCTION")

# Repository root (src/ira/config.py -> parents[2]). All relative resource paths
# resolve against this, so the app works regardless of the process cwd.
ROOT_DIR = Path(__file__).resolve().parents[2]


_DEFAULT_SECRETS = {"ira_password", "sk-litellm-master-key", ""}


class Settings(BaseSettings):
    environment: str = "dev"
    log_level: str = "INFO"
    log_format: Literal["text", "json"] = "text"

    # Auth (see docs/production-contract.md)
    auth_mode: Literal["oidc", "disabled"] = "disabled"
    oidc_issuer: str | None = None
    oidc_audience: str | None = None
    oidc_client_id: str | None = None
    oidc_scopes: str = "openid profile email"
    oidc_roles_claim: str = "groups"
    oidc_role_mapping: dict[str, str] = {}
    oidc_jwks_cache_s: int = 300
    # Static bearer tokens for alert webhooks; they may only create incidents.
    intake_tokens: list[str] = []
    max_request_bytes: int = 1_000_000

    # Worker
    worker_concurrency: int = 4
    worker_metrics_port: int = 9100
    approval_sweep_interval_s: int = 30
    worker_shutdown_grace_s: float = 25.0
    # Window in which an identical signature attaches to the still-active incident.
    dedup_active_incidents: bool = True

    # Paths
    registry_dir: Path = ROOT_DIR / "registry"
    data_dir: Path = ROOT_DIR / "data"
    # Scrubbed raw tool outputs, referenced by Evidence.artifact_uri.
    artifacts_dir: Path = ROOT_DIR / "data" / "artifacts"
    # Ground-truth labelled sample logs used by the log explorer tool.
    loghub_dir: Path = ROOT_DIR / "data" / "loghub" / "2k"
    # Eval result files (evals/loghub/evaluate.py) and the methodology doc, for the Evals tab.
    evals_results_dir: Path = ROOT_DIR / "evals" / "results"
    evals_doc: Path = ROOT_DIR / "docs" / "evals.md"

    # API
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    frontend_url: str = "http://localhost:3000"

    # Infrastructure toggles. Off by default so the app runs without docker-compose;
    # when off, the corresponding cache/queue/memory layer is skipped (and logged).
    redis_enabled: bool = False
    postgres_enabled: bool = False
    neo4j_enabled: bool = False
    queue_enabled: bool = False

    # Postgres
    postgres_user: str = "ira"
    postgres_password: str = "ira_password"
    postgres_db: str = "ira_db"
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    # libpq sslmode: disable | require | verify-ca | verify-full (managed Postgres: verify-full)
    postgres_sslmode: str = "prefer"
    postgres_sslrootcert: str | None = None

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    queue_max_attempts: int = 3

    # Neo4j
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "ira_password"

    # LiteLLM
    litellm_api_base: str = "http://localhost:4000"
    litellm_master_key: str = "sk-litellm-master-key"
    llm_timeout_s: float = 120.0

    # Gemini (direct provider calls when set, otherwise the LiteLLM proxy is used)
    gemini_api_key: str | None = None

    # Model routing per agent role
    model_planner: str = "gemini/gemini-2.5-pro"
    model_gatherer: str = "gemini/gemini-2.5-flash"
    model_analyst: str = "gemini/gemini-2.5-pro"
    model_reporter: str = "gemini/gemini-2.5-flash"
    model_utility: str = "gemini/gemini-2.5-flash"
    # Used only on transient provider errors, never for pinned-model calls.
    model_fallback: str = "gemini/gemini-2.5-flash"

    # Dual-intent guardrail: two *different* models must both judge an action SAFE.
    guardrail_model_a: str = "gemini/gemini-2.5-pro"
    guardrail_model_b: str = "gemini/gemini-2.5-flash"

    # Orchestration limits
    max_iterations: int = 3
    min_confidence: float = 0.6
    max_budget_usd: float = 2.0
    approval_timeout_s: int = 3600
    max_tool_output_chars: int = 12_000

    # Semantic cache
    # Same provider as the default chat models, so one API key is enough. Requested at
    # EMBEDDING_DIM dimensions (Gemini supports 768/1536/3072).
    embedding_model: str = "gemini/gemini-embedding-001"
    embedding_timeout_s: float = 15.0
    embedding_dim: int = 1536
    semantic_threshold: float = 0.92
    exact_cache_ttl_s: int = 7 * 24 * 3600

    # PII: entities scrubbed before anything reaches an LLM, a report, or storage.
    # DATE_TIME / URL / LOCATION are deliberately excluded: they destroy log signal.
    pii_entities: list[str] = [
        "EMAIL_ADDRESS",
        "PHONE_NUMBER",
        "CREDIT_CARD",
        "US_SSN",
        "IBAN_CODE",
        "CRYPTO",
        "US_BANK_NUMBER",
        "US_PASSPORT",
        "PERSON",
    ]
    # Presidio confidence floor. Its weak pattern recognizers (e.g. US_DRIVER_LICENSE at
    # 0.3) match infrastructure ids like BGL node "R02-M1-N0-C" and destroy log signal;
    # real PII (email, card, phone, names) scores >= 0.4.
    pii_score_threshold: float = 0.4

    # Sandbox: read-only diagnostic commands only.
    sandbox_allowed_commands: list[str] = [
        "echo", "cat", "head", "tail", "grep", "wc", "ls", "date", "uname", "uptime", "df",
    ]
    sandbox_timeout_s: int = 10
    sandbox_max_memory_mb: int = 256

    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    @field_validator("registry_dir", "data_dir", "artifacts_dir", "loghub_dir",
                     "evals_results_dir", "evals_doc", mode="after")
    @classmethod
    def _anchor_relative_paths(cls, value: Path) -> Path:
        """Relative paths (e.g. ARTIFACTS_DIR=data/artifacts in .env) are relative to the
        repository root, not the process cwd."""
        return value if value.is_absolute() else (ROOT_DIR / value).resolve()

    @property
    def is_prod(self) -> bool:
        return self.environment == "prod"

    def production_errors(self) -> list[str]:
        """Misconfigurations that must stop a prod process from starting."""
        errors: list[str] = []
        if self.auth_mode != "oidc":
            errors.append("AUTH_MODE must be 'oidc'")
        elif not (self.oidc_issuer and self.oidc_audience):
            errors.append("OIDC_ISSUER and OIDC_AUDIENCE are required")
        if not (self.redis_enabled and self.postgres_enabled and self.queue_enabled):
            errors.append("REDIS_ENABLED, POSTGRES_ENABLED and QUEUE_ENABLED must all be true")
        secrets = ["postgres_password", "litellm_master_key"]
        if self.neo4j_enabled:
            secrets.append("neo4j_password")
        for name in secrets:
            if getattr(self, name) in _DEFAULT_SECRETS:
                errors.append(f"{name.upper()} is unset or the shipped default")
        if any("*" in o for o in self.cors_origins):
            errors.append("CORS_ORIGINS must not contain '*'")
        if any(len(t) < 32 for t in self.intake_tokens):
            errors.append("INTAKE_TOKENS entries must be at least 32 characters")
        return errors

    def validate_for_startup(self) -> None:
        if self.is_prod:
            errors = self.production_errors()
            if errors:
                raise RuntimeError("Refusing to start in prod: " + "; ".join(errors))

    @property
    def _pg_credentials(self) -> str:
        # URL-encode so passwords containing @ : / % work.
        return f"{quote(self.postgres_user, safe='')}:{quote(self.postgres_password, safe='')}"

    @property
    def postgres_dsn_sync(self) -> str:
        """libpq-style DSN for psycopg (LangGraph checkpointer) and Alembic."""
        return (
            f"postgresql://{self._pg_credentials}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
            f"?{self._libpq_ssl_query}"
        )

    @property
    def _libpq_ssl_query(self) -> str:
        query = f"sslmode={quote(self.postgres_sslmode)}"
        if self.postgres_sslrootcert:
            query += f"&sslrootcert={quote(self.postgres_sslrootcert)}"
        return query

    def asyncpg_connect_args(self) -> dict[str, object]:
        """asyncpg takes TLS settings as connect args rather than libpq URL params."""
        mode = self.postgres_sslmode
        if mode in ("disable", "allow", "prefer"):
            return {"ssl": mode if mode != "allow" else "prefer"}
        if mode == "require" and not self.postgres_sslrootcert:
            return {"ssl": "require"}
        import ssl

        ctx = ssl.create_default_context(cafile=self.postgres_sslrootcert)
        ctx.check_hostname = mode == "verify-full"
        if mode == "require":
            ctx.verify_mode = ssl.CERT_NONE
        return {"ssl": ctx}

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql+asyncpg://{self._pg_credentials}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def role_models(self) -> dict[str, str]:
        return {
            "planner": self.model_planner,
            "gatherer": self.model_gatherer,
            "analyst": self.model_analyst,
            "reporter": self.model_reporter,
            "utility": self.model_utility,
        }


settings = Settings()
