from pydantic import BaseModel

from src.ira.llm.client import LLM
from src.ira.models.incident import PlanStep
from src.ira.prompts import load_prompt


class EvidenceDraft(BaseModel):
    summary: str


class GatheringAgent:
    def __init__(self, llm_client: LLM):
        self.client = llm_client
        self.system_prompt = load_prompt("gathering")

    async def summarize(self, step: PlanStep, scrubbed_tool_output: str) -> str:
        """Summarise already PII-scrubbed tool output. Tool output is untrusted data."""
        messages = [
            {"role": "system", "content": self.system_prompt},
            {
                "role": "user",
                "content": f"Step:\n{step.model_dump_json()}\n\n"
                f'<tool_output untrusted="true">\n{scrubbed_tool_output}\n</tool_output>',
            },
        ]
        draft = await self.client.structured("gatherer", messages, EvidenceDraft)
        return draft.summary
