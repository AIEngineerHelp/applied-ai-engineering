from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "sqlite:///./actgate.db"
    typesafe_api_key: str = ""
    gemini_api_key: str = ""

    laya_enabled: bool = True
    laya_preload: bool = True
    laya_model: str = "convaiinnovations/laya"
    laya_device: str = "cpu"

    confidence_auto: float = 0.82
    confidence_jev: float = 0.55
    urgency_high: float = 0.75
    risk_block: str = "high"

    gemini_model: str = "gemini-3.8-flash"

    app_host: str = "127.0.0.1"
    app_port: int = 8787
    log_level: str = "info"
    # Public demo: visitors can only run the bundled sample tickets.
    demo_mode: bool = False

    @field_validator("database_url", mode="before")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        if not isinstance(value, str):
            return value
        if value.startswith("postgres://"):
            return "postgresql+psycopg://" + value[len("postgres://") :]
        if value.startswith("postgresql://") and "+" not in value.split("://", 1)[0]:
            return "postgresql+psycopg://" + value[len("postgresql://") :]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
