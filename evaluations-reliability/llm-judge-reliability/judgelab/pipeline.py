"""Run judges over the dataset. Every call is appended to runs/ so a run can resume."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime

from judgelab import prompts, store
from judgelab.providers import ProviderError

INPUTS = ("original", "padded")
REPEATS = 3


def _now():
    return datetime.now(UTC).isoformat(timespec="seconds")


def _cost(usage, rates):
    if None in rates or usage.get("input_tokens") is None or usage.get("output_tokens") is None:
        return None
    return round((usage["input_tokens"] * rates[0] + usage["output_tokens"] * rates[1]) / 1e6, 8)


def select(items, split):
    return [i for i in items if split == "all" or i["split"] == split]


def judge_item(variant_name, item, answer, clients, settings):
    variant = prompts.VARIANTS[variant_name]
    if variant["provider"] == "gemini":
        result, usage = clients["gemini"].generate(
            settings.gemini_judge_model,
            variant["system"],
            prompts.case_text(item, answer),
            variant["schema"],
            temperature=settings.judge_temperature,
        )
        if result.get("verdict") not in ("pass", "fail"):
            raise ProviderError("Gemini returned an invalid verdict.")
        return {"verdict": result["verdict"], "reasoning": result.get("reasoning")}, usage
    result, usage = clients["jev"].choose(
        settings.jev_model,
        {"passage": item["passage"], "question": item["question"], "answer": answer},
        variant["instructions"],
        variant["criteria"],
    )
    probabilities = result.get("probabilities") or {}
    return {
        "verdict": result["choice"],
        "p_pass": probabilities.get("pass"),
        "confidence": result.get("confidence"),
    }, usage


def judge(variant, input_kind, repeat, items, clients, settings, runs):
    """Grade every item not yet graded for this variant, input and repeat. Returns (to_run, counts)."""
    if variant not in prompts.VARIANTS:
        raise ValueError(f"Unknown variant {variant}. Choose from: {', '.join(prompts.VARIANTS)}")
    if input_kind not in INPUTS:
        raise ValueError(f"Input must be one of {INPUTS}.")
    existing = store.load_judgments(variant, input_kind, repeat, runs)
    todo = [i for i in items if i["id"] not in existing]
    provider = prompts.VARIANTS[variant]["provider"]

    def work(item):
        answer = prompts.pad(item["answer"]) if input_kind == "padded" else item["answer"]
        record = {"item_id": item["id"], "variant": variant, "input": input_kind, "repeat": repeat, "at": _now()}
        try:
            verdict, usage = judge_item(variant, item, answer, clients, settings)
            record.update(**verdict, **usage, usd=_cost(usage, settings.rates[provider]))
        except ProviderError as error:
            record["error"] = str(error)
        return record

    counts = {"ok": 0, "error": 0}
    path = store.judgments_path(variant, input_kind, repeat, runs)
    with ThreadPoolExecutor(max_workers=settings.max_workers) as pool:
        for future in as_completed([pool.submit(work, item) for item in todo]):
            record = future.result()
            store.append_jsonl(path, record)
            counts["error" if record.get("error") else "ok"] += 1
    return len(todo), counts


def experiment(dataset="synthetic"):
    """Every (variant, input, repeat) job in the full experiment, grouped by what it measures."""
    jobs = []
    for variant in ("gemini-rubric", "jev-rubric"):
        jobs += [(variant, "original", r, "agreement and reliability") for r in range(1, REPEATS + 1)]
        jobs.append((variant, "padded", 1, "length bias"))
    for variant in ("gemini-basic", "gemini-reasoning", "gemini-examples", "jev-basic"):
        jobs.append((variant, "original", 1, "prompt variants"))
    if dataset == "ragtruth":
        # RAGTruth labels only unsupported content, so also grade with a rubric that matches that definition.
        jobs += [(v, "original", 1, "label definition") for v in ("gemini-faithfulness", "jev-faithfulness")]
    return jobs
