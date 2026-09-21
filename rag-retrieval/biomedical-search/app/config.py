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
