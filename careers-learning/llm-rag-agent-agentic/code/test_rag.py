import json
import math
import re

import chromadb
import httpx

DOCS = [
    "Refunds go back to the original card within 5-7 business days.",
    "You can request a refund within 30 days of purchase from Orders > Refund.",
    "To reset your password, use the Forgot password link on the sign-in page.",
]

# A tiny, fixed embedding so the retrieval check never depends on a downloaded
# model or a Chroma release. Each dimension is a topic; a text's vector counts
# how many of that topic's words it contains. Same input, same vector, always.
TOPICS = [
    {"refund", "refunds", "money", "back", "card", "purchase"},
    {"days", "long", "within", "business", "time"},
    {"password", "reset", "forgot", "sign", "account"},
]


class FixedTopicEmbedding(chromadb.EmbeddingFunction):
    def __init__(self):
        pass

    def __call__(self, input):
        vectors = []
        for text in input:
            words = re.findall(r"[a-z]+", text.lower())
            vec = [float(sum(w in topic for w in words)) for topic in TOPICS]
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            vectors.append([v / norm for v in vec])
        return vectors

    @staticmethod
    def name():
        return "fixed-topic-test"


def test_rag_retrieval(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        return httpx.Response(200, json={"id": "c", "object": "chat.completion", "created": 0, "model": body["model"],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Within 30 days, from Orders > Refund."}}]})

    # Route the OpenAI client through a mock transport: no network, no charges.
    from openai import OpenAI
    original_init = OpenAI.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["http_client"] = httpx.Client(transport=httpx.MockTransport(handler))
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(OpenAI, "__init__", patched_init)

    # Real Chroma retrieval, but with the fixed embedding above (no model download).
    collection = chromadb.Client().get_or_create_collection(
        "help_docs_test", embedding_function=FixedTopicEmbedding(), metadata={"hnsw:space": "cosine"})
    collection.add(ids=["refund-1", "refund-2", "acct-1"], documents=DOCS)

    question = "How long do I have to ask for my money back?"
    context = "\n".join(collection.query(query_texts=[question], n_results=2)["documents"][0])
    assert "30 days" in context, context
    assert "password" not in context, context

    import rag
    monkeypatch.setattr(rag, "_get_collection", lambda: collection)
    rag.answer(question)

    prompt = seen[0]["messages"][1]["content"]
    assert "30 days" in prompt and "password" not in prompt, prompt