import json
import os
import httpx
import pytest
import chromadb

def test_rag_retrieval(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    
    seen = []
    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        return httpx.Response(200, json={"id": "c", "object": "chat.completion", "created": 0, "model": body["model"], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Within 30 days, from Orders > Refund."}}]})
    
    # Monkeypatch the OpenAI client to use mock transport
    from openai import OpenAI
    original_init = OpenAI.__init__
    def patched_init(self, *args, **kwargs):
        kwargs["http_client"] = httpx.Client(transport=httpx.MockTransport(handler))
        original_init(self, *args, **kwargs)
    
    monkeypatch.setattr(OpenAI, "__init__", patched_init)
    
    # Create a fresh collection with default embedding - this will use Chroma's default
    # which is ONNX Runtime with all-MiniLM-L6-v2, deterministic once downloaded
    client = chromadb.Client()
    collection = client.get_or_create_collection("help_docs_test")
    collection.add(
        ids=["refund-1", "refund-2", "acct-1"],
        documents=["Refunds go back to the original card within 5-7 business days.",
                   "You can request a refund within 30 days of purchase from Orders > Refund.",
                   "To reset your password, use the Forgot password link on the sign-in page."],
    )
    
    # Manually test the retrieval to avoid import-time collection creation
    question = "How long do I have to ask for my money back?"
    hits = collection.query(query_texts=[question], n_results=2)
    context = "\n".join(hits["documents"][0])
    
    # Check that retrieval found the refund chunks and not the password one
    assert "30 days" in context, f"Expected '30 days' in context, got: {context}"
    assert "password" not in context, f"Did not expect 'password' in context, got: {context}"
    
    # Now test the full answer function with the mocked client
    import rag
    # Monkey-patch the collection getter to use our test collection
    monkeypatch.setattr(rag, "_get_collection", lambda: collection)
    
    answer = rag.answer(question)
    print(f"RAG answer: {answer}")
    
    # Verify the prompt sent to the model included the right context
    prompt = seen[0]["messages"][1]["content"]
    print(f"Prompt sent to model:\n{prompt}")
    assert "30 days" in prompt, f"Expected '30 days' in prompt, got: {prompt}"
    assert "password" not in prompt, f"Did not expect 'password' in prompt, got: {prompt}"
