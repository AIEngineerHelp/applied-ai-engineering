# Runs agent_loop.run_agent against a fake HTTP transport: the model first asks for get_order, then answers.
import json
import os
import httpx
import pytest

def test_agent_loop(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    
    seen = []
    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        base = {"id": "c", "object": "chat.completion", "created": 0, "model": body["model"], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        if len(seen) == 1:
            msg = {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "get_order", "arguments": '{"order_id": "A-1042"}'}}]}
            return httpx.Response(200, json={**base, "choices": [{"index": 0, "finish_reason": "tool_calls", "message": msg}]})
        tool_msg = body["messages"][-1]
        assert tool_msg["role"] == "tool" and tool_msg["tool_call_id"] == "call_1" and "shipped" in tool_msg["content"], tool_msg
        assert body["messages"][-2]["tool_calls"][0]["function"]["name"] == "get_order"
        return httpx.Response(200, json={**base, "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Order A-1042 shipped with DHL and should arrive on 16 October."}}]})
    
    # Monkeypatch the OpenAI client to use mock transport
    from openai import OpenAI
    original_init = OpenAI.__init__
    def patched_init(self, *args, **kwargs):
        kwargs["http_client"] = httpx.Client(transport=httpx.MockTransport(handler))
        original_init(self, *args, **kwargs)
    
    monkeypatch.setattr(OpenAI, "__init__", patched_init)
    
    import agent_loop
    out = agent_loop.run_agent("Where is my order A-1042?")
    
    assert len(seen) == 2, f"Expected 2 API calls, got {len(seen)}"
    assert "DHL" in out, f"Expected 'DHL' in output, got: {out}"
    print(f"Agent output: {out}")
