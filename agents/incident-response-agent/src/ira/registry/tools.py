import logging
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field

from src.ira.config import settings

logger = logging.getLogger(__name__)


class ToolManifest(BaseModel):
    name: str
    kind: Literal["tool", "mcp"]
    description: str
    input_schema: dict[str, Any]
    risk: Literal["read", "write", "destructive"]
    approval: Literal["none", "required", "two_person"]
    allowed_envs: list[str] = Field(default=["dev", "staging", "prod"])
    timeout_s: int = 60
    enabled: bool = True

    def missing_args(self, args: dict[str, Any]) -> list[str]:
        return [k for k in self.input_schema.get("required", []) if k not in args]

    def brief(self) -> dict[str, Any]:
        """Compact description handed to LLM agents."""
        return {
            "name": self.name,
            "description": self.description,
            "risk": self.risk,
            "input_schema": self.input_schema,
        }


class ToolRegistry:
    def __init__(self, registry_dir: Path | None = None):
        self.registry_dir = registry_dir or settings.registry_dir / "tools"
        self.tools: dict[str, ToolManifest] = {}

    def load_registry(self) -> "ToolRegistry":
        if not self.registry_dir.exists():
            logger.warning("Tool registry %s does not exist", self.registry_dir)
            return self
        for path in sorted(self.registry_dir.glob("*.y*ml")):
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            try:
                manifest = ToolManifest(**data)
            except Exception as e:  # noqa: BLE001 - one bad manifest must not break the rest
                logger.error("Failed to load tool manifest %s: %s", path, e)
                continue
            if manifest.enabled:
                self.tools[manifest.name] = manifest
        return self

    def get_tool(self, name: str) -> ToolManifest | None:
        return self.tools.get(name)

    def list_tools(
        self, risk_level: str | None = None, environment: str | None = None
    ) -> list[ToolManifest]:
        return [
            t for t in self.tools.values()
            if (risk_level is None or t.risk == risk_level)
            and (environment is None or environment in t.allowed_envs)
        ]
