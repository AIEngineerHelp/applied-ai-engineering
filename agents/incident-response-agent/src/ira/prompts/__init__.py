from functools import cache

from src.ira.config import settings


@cache
def load_prompt(name: str) -> str:
    """Load a system prompt from the prompt registry (independent of cwd)."""
    return (settings.registry_dir / "prompts" / f"{name}.md").read_text(encoding="utf-8")
