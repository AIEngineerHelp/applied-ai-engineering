import asyncio
import json
import logging
import threading
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from app import config
from app.llm import generate_answer, selected_context
from app.retrieval import SearchEngine, read_jsonl

logger = logging.getLogger("helix")
log_lock = threading.Lock()
searches = OrderedDict()
search_lock = threading.Lock()
engine = None
startup_error = None


def write_event(event):
    config.EXPERIMENTS.mkdir(exist_ok=True)
    with log_lock, (config.EXPERIMENTS / "searches.jsonl").open("a") as output:
        output.write(json.dumps({"timestamp": datetime.now(UTC).isoformat(), **event}) + "\n")


async def load_engine():
    global engine, startup_error
    try:
        while (
            not (config.INDEX / "manifest.json").exists()
            and (config.INDEX / "embedding-progress.json").exists()
        ):
            await asyncio.sleep(3)
        engine = await asyncio.to_thread(SearchEngine)
    except Exception as exc:
        startup_error = str(exc)
        logger.exception("Could not load retrieval indexes")


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(load_engine())
    yield
    if not task.done():
        task.cancel()


app = FastAPI(title="Helix Biomedical Search", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=config.ROOT / "app" / "static"), name="static")


class SearchRequest(BaseModel):
    query: str = Field(min_length=3, max_length=500)
    mode: str = Field(default="hybrid", pattern="^(lexical|dense|hybrid|best)$")
    expand: bool = True
    top_k: int = Field(default=10, ge=5, le=20)

    @field_validator("query")
    @classmethod
    def nonblank(cls, value):
        value = value.strip()
        if len(value) < 3:
            raise ValueError("Enter a biomedical question of at least 3 characters.")
        return value


class AnswerRequest(BaseModel):
    search_id: str
    passage_ids: list[str] | None = Field(default=None, min_length=1, max_length=5)


@app.get("/")
def home():
    return FileResponse(config.ROOT / "app" / "static" / "index.html")


@app.get("/api/status")
async def status():
    available = False
    models = []
    try:
        if config.PROVIDER == "ollama":
            async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
                response = await client.get(f"{config.BASE_URL}/api/tags")
                response.raise_for_status()
                models = [m["name"] for m in response.json().get("models", [])]
                available = config.ANSWER_MODEL in models
        else:
            available = bool(config.API_KEY)
    except httpx.HTTPError:
        pass
    manifest = engine.manifest if engine else None
    progress_path = config.INDEX / "embedding-progress.json"
    preparation = None
    if progress_path.exists():
        try:
            preparation = json.loads(progress_path.read_text())
        except (ValueError, OSError):
            pass  # a batch checkpoint may be concurrently replaced
    best_ready = False
    best_path = config.EXPERIMENTS / "best-config.json"
    if engine and engine.dense_ready and best_path.exists():
        try:
            signature = json.loads(best_path.read_text()).get("index_signature", {})
            best_ready = bool(signature) and all(
                engine.manifest.get(key) == value for key, value in signature.items()
            )
        except (ValueError, OSError):
            pass
    return {
        "best_ready": best_ready,
        "ready": engine is not None,
        "dense_ready": bool(engine and engine.dense_ready),
        "error": startup_error,
        "dataset": config.DATASET,
        "manifest": manifest,
        "preparation": preparation,
        "llm": {
            "available": available,
            "provider": config.PROVIDER,
            "model": config.ANSWER_MODEL,
            "models": models,
        },
    }


@app.get("/api/questions")
def examples():
    path = config.EXPERIMENTS / "queries-100.jsonl"
    if not path.exists():
        return []
    # Display real questions without exposing gold answers to the online pipeline.
    return [
        {"id": q["id"], "question": q["question"], "category": q["category"]} for q in read_jsonl(path)[:12]
    ]


@app.post("/api/search")
def search(request: SearchRequest):
    if engine is None:
        raise HTTPException(503, "Indexes are loading. Run uv run python -m scripts.prepare if needed.")
    settings = {"mode": request.mode, "expand": request.expand, "top_k": request.top_k}
    variant = None
    if request.mode == "best":
        best_path = config.EXPERIMENTS / "best-config.json"
        if not best_path.exists():
            raise HTTPException(409, "No measured best hybrid yet. Run the benchmark or choose Hybrid.")
        selected = json.loads(best_path.read_text())
        signature = selected.get("index_signature", {})
        if any(engine.manifest.get(key) != value for key, value in signature.items()):
            raise HTTPException(409, "The index changed since evaluation. Run the benchmark again.")
        variant = selected["variant"]
        settings = {**selected["configuration"], "top_k": request.top_k}
    try:
        result = engine.search(request.query, **settings)
    except (RuntimeError, httpx.HTTPError, ValueError, KeyError) as exc:
        raise HTTPException(
            503,
            "Search is unavailable. Check the Gemini connection and embedding index. Try disabling query expansion to search without the expansion call.",
        ) from exc
    result["search_id"] = str(uuid4())
    result["variant"] = variant
    context_ids = {p["id"] for p in selected_context(result["evidence"])}
    for passage in result["evidence"]:
        passage["selected"] = passage["id"] in context_ids
    with search_lock:
        searches[result["search_id"]] = result
        while len(searches) > 100:
            searches.popitem(last=False)
    write_event(
        {
            "event": "retrieval",
            "search_id": result["search_id"],
            "query": request.query,
            "queries": result["queries"],
            "expansion_usage": result.get("expansion_usage"),
            "configuration": result["configuration"],
            "retrieved": [{"id": p["id"], "score": p["score"]} for p in result["evidence"]],
            "retrieval_ms": result["retrieval_ms"],
        }
    )
    return result


@app.post("/api/answer")
def answer(request: AnswerRequest):
    with search_lock:
        result = searches.get(request.search_id)
    if result is None:
        raise HTTPException(404, "This search expired. Search again to generate an answer.")
    evidence = result["evidence"]
    if request.passage_ids is not None:
        ids = set(request.passage_ids)
        if len(ids) != len(request.passage_ids) or not ids <= {p["id"] for p in evidence}:
            raise HTTPException(422, "Select distinct passage IDs from this search's evidence.")
        evidence = [p for p in evidence if p["id"] in ids]
    try:
        generated = generate_answer(result["query"], evidence)
    except (httpx.HTTPError, RuntimeError, ValueError, KeyError) as exc:
        logger.warning("Answer generation failed: %s", exc)
        write_event({"event": "answer_error", "search_id": request.search_id, "error": str(exc)})
        raise HTTPException(
            503,
            "Answer generation is unavailable. Check your model connection; the retrieved evidence remains available.",
        ) from exc
    write_event({"event": "answer", "search_id": request.search_id, "answer": generated})
    return generated


@app.get("/api/experiments")
def experiments():
    summary_path = config.EXPERIMENTS / "summary.json"
    return (
        json.loads(summary_path.read_text())
        if summary_path.exists()
        else {
            "status": "not_run",
            "configurations": [],
            "message": "Run uv run python -m scripts.evaluate to compare retrieval on the fixed 100 queries.",
        }
    )


@app.get("/api/experiments/report")
def report():
    path = config.EXPERIMENTS / "report.md"
    if not path.exists():
        raise HTTPException(404, "No evaluation report yet.")
    return FileResponse(path, media_type="text/markdown", filename="helix-evaluation-report.md")
