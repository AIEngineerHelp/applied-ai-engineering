import json
from typing import Any

from pydantic import BaseModel


def parse_args_json(raw: str) -> dict[str, Any]:
    """Tool args travel as a JSON string in LLM schemas: free-form objects are not
    portable across providers' structured-output modes."""
    if not raw or not raw.strip():
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise TypeError(f"args_json must encode an object, got {type(value).__name__}")
    return value


def dump(model: BaseModel | list[Any] | dict[str, Any]) -> str:
    if isinstance(model, BaseModel):
        return model.model_dump_json()
    return json.dumps(
        [m.model_dump(mode="json") if isinstance(m, BaseModel) else m for m in model]
        if isinstance(model, list) else model,
        default=str,
    )
