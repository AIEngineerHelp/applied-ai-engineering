import json, os, httpx
os.environ["OPENAI_API_KEY"] = "sk-test"
seen = []
def handler(req):
    body = json.loads(req.content); seen.append(body)
    return httpx.Response(200, json={"id": "c", "object": "chat.completion", "created": 0, "model": body["model"], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Within 30 days, from Orders > Refund."}}]})
from openai import OpenAI
orig = OpenAI.__init__
def patched(self, *a, **kw):
    kw["http_client"] = httpx.Client(transport=httpx.MockTransport(handler)); orig(self, *a, **kw)
OpenAI.__init__ = patched
import rag
print(rag.answer("How long do I have to ask for my money back?"))
prompt = seen[0]["messages"][1]["content"]; print(prompt)
assert "30 days" in prompt and "password" not in prompt
print("mock rag test passed")
