"""Smoke-test the LLM client. Reads GEMINI_API_KEY from the environment / .env."""
import asyncio
import sys

from src.ira.config import settings
from src.ira.llm.client import LLMClient


async def smoke_gemini_call() -> None:
    if not settings.gemini_api_key:
        sys.exit("Set GEMINI_API_KEY in your environment or .env")
    client = LLMClient()
    messages = [{"role": "user", "content": "Give me a 1-sentence greeting for an incident "
                 "response system."}]
    print("Sending message to Gemini...")
    print(await client.text("utility", messages))


if __name__ == "__main__":
    asyncio.run(smoke_gemini_call())
