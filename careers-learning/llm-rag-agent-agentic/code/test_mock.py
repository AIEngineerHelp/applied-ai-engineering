# Runs agent_loop.run_agent against a fake HTTP transport: the model first asks for get_order, then answers.
import json, os, httpx
os.environ["OPENAI_API_KEY"] = "sk-test"
seen = []
def handler(req):
    body = json.loads(req.content); seen.append(body)
    base = {"id": "c", "object": "chat.completion", "created": 0, "model": body["model"], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
    if len(seen) == 1:
        msg = {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "get_order", "arguments": '{"order_id": "A-1042"}'}}]}
        return httpx.Response(200, json={**base, "choices": [{"index": 0, "finish_reason": "tool_calls", "message": msg}]})
    tool_msg = body["messages"][-1]
    assert tool_msg["role"] == "tool" and tool_msg["tool_call_id"] == "call_1" and "shipped" in tool_msg["content"], tool_msg
    assert body["messages"][-2]["tool_calls"][0]["function"]["name"] == "get_order"
    return httpx.Response(200, json={**base, "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Order A-1042 shipped with DHL and should arrive on 16 October."}}]})
from openai import OpenAI
orig = OpenAI.__init__
def patched(self, *a, **kw):
    kw["http_client"] = httpx.Client(transport=httpx.MockTransport(handler)); orig(self, *a, **kw)
OpenAI.__init__ = patched
import agent_loop
out = agent_loop.run_agent("Where is my order A-1042?")
print(out); assert len(seen) == 2 and "DHL" in out
print("mock agent test passed")
