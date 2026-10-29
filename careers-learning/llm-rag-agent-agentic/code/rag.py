import chromadb
from openai import OpenAI
from config import OPENAI_MODEL

_client = None
_collection = None

def _get_client():
    global _client
    if _client is None:
        _client = OpenAI()
    return _client

def _get_collection():
    global _collection
    if _collection is None:
        _collection = chromadb.Client().get_or_create_collection("help_docs")
        _collection.add(
            ids=["refund-1", "refund-2", "acct-1"],
            documents=["Refunds go back to the original card within 5-7 business days.",
                       "You can request a refund within 30 days of purchase from Orders > Refund.",
                       "To reset your password, use the Forgot password link on the sign-in page."],
        )
    return _collection

def answer(question: str) -> str:
    client = _get_client()
    collection = _get_collection()
    hits = collection.query(query_texts=[question], n_results=2)   # retrieval: nearest chunks
    context = "\n".join(hits["documents"][0])
    messages = [{"role": "system", "content": "Answer only from the context. If it isn't there, say you don't know."},
                {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {question}"}]
    return client.chat.completions.create(model=OPENAI_MODEL, messages=messages).choices[0].message.content
