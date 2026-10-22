import chromadb
from openai import OpenAI

client = OpenAI()
collection = chromadb.Client().get_or_create_collection("help_docs")
collection.add(
    ids=["refund-1", "refund-2", "acct-1"],
    documents=["Refunds go back to the original card within 5-7 business days.",
               "You can request a refund within 30 days of purchase from Orders > Refund.",
               "To reset your password, use the Forgot password link on the sign-in page."],
)

def answer(question: str) -> str:
    hits = collection.query(query_texts=[question], n_results=2)   # retrieval: nearest chunks
    context = "\n".join(hits["documents"][0])
    messages = [{"role": "system", "content": "Answer only from the context. If it isn't there, say you don't know."},
                {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {question}"}]
    return client.chat.completions.create(model="gpt-5-mini", messages=messages).choices[0].message.content
