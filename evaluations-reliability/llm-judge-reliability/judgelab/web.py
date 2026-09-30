"""Local dashboard for exploring each dataset and the judges' verdicts. Read-only."""

from collections import Counter

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from judgelab import analyze, config, pipeline, prompts, store

STATIC = config.ROOT / "judgelab" / "static"

LABELS = {
    "synthetic": ("Synthetic mistakes", "Fictional passages; each wrong answer has one mistake written for the test."),
    "ragtruth": ("RAGTruth", "Real answers from six LLMs to MS MARCO questions, with mistakes marked by people."),
}


def create_app(datasets=None, runs_root=None, settings=None, reviews=None):
    """datasets maps a name to its cases file; runs_root holds one runs folder per dataset."""
    app = FastAPI(title="Judge Lab", docs_url=None, redoc_url=None)
    datasets = datasets or config.DATASETS
    runs_root = runs_root or config.RUNS
    settings = settings or config.load_settings()
    reviews = config.REVIEWS if reviews is None else reviews

    def resolve(dataset):
        if dataset not in datasets:
            raise HTTPException(404, "Unknown dataset.")
        if not datasets[dataset].exists():
            raise HTTPException(409, "Dataset not downloaded. Run: uv run python -m judgelab fetch-ragtruth")
        return store.load_items(datasets[dataset], reviews.get(dataset)), runs_root / dataset

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/datasets")
    def list_datasets():
        return {
            "datasets": [
                {"id": name, "label": LABELS.get(name, (name, ""))[0], "about": LABELS.get(name, ("", ""))[1],
                 "ready": path.exists()}
                for name, path in datasets.items()
            ],
            "models": {"gemini": settings.gemini_judge_model, "jev": settings.jev_model},
        }

    @app.get("/api/judges")
    def judges():
        """The exact instructions each judge variant receives."""
        out = {}
        for name, v in prompts.VARIANTS.items():
            if v["provider"] == "gemini":
                out[name] = {"provider": "gemini", "model": settings.gemini_judge_model, "prompt": v["system"],
                             "explains": "reasoning" in v["schema"]["properties"]}
            else:
                criteria = "\n".join(f"{k}: {text}" for k, text in v["criteria"].items())
                out[name] = {"provider": "jev", "model": settings.jev_model, "explains": False,
                             "prompt": f"{v['instructions']}\n\nOptions\n{criteria}"}
        return {"judges": out, "pad": {"prefix": prompts.PAD_PREFIX, "suffix": prompts.PAD_SUFFIX}}

    @app.get("/api/overview")
    def overview(dataset: str = "synthetic"):
        items, runs = resolve(dataset)
        jobs = pipeline.experiment(dataset)
        return {
            "dataset": dataset,
            "items": len(items),
            "questions": len({i["question"] for i in items}),
            "expected": {k: sum(i["expected"] == k for i in items) for k in ("pass", "fail")},
            "splits": {s: sum(i["split"] == s for i in items) for s in ("dev", "holdout")},
            "errors": Counter(i["error"] for i in items if i["error"]),
            "world_true": sum(i["world_true"] for i in items),
            "sources": Counter(i["source"] for i in items),
            "calls_done": sum(len(store.load_judgments(v, i, r, runs)) for v, i, r, _ in jobs),
            "calls_planned": len(jobs) * len(items),
            "variants": {
                name: {"provider": v["provider"], "graded": len(store.load_judgments(name, "original", 1, runs))}
                for name, v in prompts.VARIANTS.items()
            },
            "rubric": prompts.RUBRIC,
        }

    @app.get("/api/items")
    def items(dataset: str = "synthetic"):
        """Every answer with its known verdict and each judge's first-run verdict."""
        all_items, runs = resolve(dataset)
        verdicts = {name: store.load_judgments(name, "original", 1, runs) for name in prompts.VARIANTS}
        return {
            "variants": [name for name, v in verdicts.items() if v],
            "items": [
                {**item, "verdicts": {
                    name: {k: v[item["id"]].get(k) for k in ("verdict", "reasoning", "p_pass")}
                    for name, v in verdicts.items() if item["id"] in v
                }}
                for item in all_items
            ],
        }

    cache = {}

    def signature(dataset, runs):
        """Changes whenever a run, the cases file or the review file changes."""
        files = [datasets[dataset], *sorted(runs.glob("judgments/*/*.jsonl"))]
        if reviews.get(dataset):
            files.append(reviews[dataset])
        return tuple((str(f), f.stat().st_mtime_ns) for f in files if f.exists())

    @app.get("/api/report")
    def report(dataset: str = "synthetic"):
        all_items, runs = resolve(dataset)
        key = signature(dataset, runs)
        if cache.get(dataset, (None,))[0] != key:
            result = analyze.analyze(all_items, runs)
            cache[dataset] = (key, {"report": result, "markdown": analyze.markdown(result)})
        return cache[dataset][1]

    return app
