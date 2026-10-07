import os
import platform
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
DATA = ROOT / "data"
INDEX = DATA / "index"
EXPERIMENTS = ROOT / "experiments"
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "gemini-embedding-001")
EMBEDDING_THREADS = int(os.getenv("EMBEDDING_THREADS", "4"))
EMBEDDING_BACKEND = os.getenv("EMBEDDING_BACKEND", "gemini")
if EMBEDDING_BACKEND == "auto":
    EMBEDDING_BACKEND = (
        "mlx"
        if platform.system() == "Darwin"
        and platform.machine() == "arm64"
        and EMBEDDING_MODEL == "BAAI/bge-small-en-v1.5"
        else "fastembed"
    )
PROVIDER = os.getenv("LLM_PROVIDER", "gemini")
BASE_URL = os.getenv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("LLM_API_KEY", "")
ANSWER_MODEL = os.getenv("ANSWER_MODEL", "gemini-2.5-flash")
JUDGE_MODEL = os.getenv("JUDGE_MODEL", ANSWER_MODEL)
EXPANSION_MODEL = os.getenv("EXPANSION_MODEL", ANSWER_MODEL)
DATASET = "rag-datasets/rag-mini-bioasq"

# Optional second-stage reranking. The search fetches RERANK_DEPTH candidates, grades them,
# and keeps the requested top_k. Pin a versioned Jev model when comparing runs.
RERANK_DEPTH = int(os.getenv("RERANK_DEPTH", "30"))
RERANK_GEMINI_MODEL = os.getenv("RERANK_GEMINI_MODEL", ANSWER_MODEL)
TYPESAFE_API_KEY = os.getenv("TYPESAFE_API_KEY", "")
TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"
RERANK_JEV_MODEL = os.getenv("RERANK_JEV_MODEL", "jev-1.13.0")
RERANK_WORKERS = int(os.getenv("RERANK_WORKERS", "8"))
RERANK_RETRIES = int(os.getenv("RERANK_RETRIES", "2"))
RERANK_TIMEOUT_S = float(os.getenv("RERANK_TIMEOUT_S", "30"))
_typesafe_rate = os.getenv("TYPESAFE_INPUT_USD_PER_MILLION")
TYPESAFE_INPUT_USD_PER_MILLION = float(_typesafe_rate) if _typesafe_rate else None

# Deliberately specified before the benchmark, rather than tuned on its labels.
VARIANTS = {
    "lexical": {"mode": "lexical", "expand": False},
    "dense": {"mode": "dense", "expand": False},
    "hybrid": {"mode": "hybrid", "expand": False, "lexical_weight": 0.5, "rrf_k": 60},
    "hybrid_expanded": {"mode": "hybrid", "expand": True, "lexical_weight": 0.5, "rrf_k": 60},
    "hybrid_weighted": {
        "mode": "hybrid",
        "expand": True,
        "lexical_weight": 0.65,
        "rrf_k": 20,
        "expansion_weight": 0.35,
    },
}
