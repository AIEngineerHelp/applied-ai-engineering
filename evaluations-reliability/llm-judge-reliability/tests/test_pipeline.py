from judgelab import pipeline, prompts, store
from judgelab.providers import ProviderError


class FakeGemini:
    """Passes padded answers and fails short ones: a maximally length-biased judge."""

    def __init__(self, fail_on=()):
        self.calls = []
        self.fail_on = set(fail_on)

    def generate(self, model, system, user, schema, temperature=0.0, max_tokens=1024):
        self.calls.append(user)
        if any(text in user for text in self.fail_on):
            raise ProviderError("boom")
        verdict = "pass" if prompts.PAD_PREFIX in user else "fail"
        return {"verdict": verdict, "reasoning": "r"}, {"model": model, "input_tokens": 10, "output_tokens": 2, "ms": 5}


class FakeJev:
    def choose(self, model, state, instructions, criteria):
        return {"choice": "pass", "probabilities": {"pass": 0.7, "fail": 0.3}, "confidence": 0.4}, {
            "model": "jev-1.13.0", "input_tokens": 50, "output_tokens": 3, "ms": 4}


def test_items_flatten_cases(workspace):
    items = store.load_items(workspace["cases"])
    assert [i["id"] for i in items] == ["c1-a", "c1-b", "c2-a", "c2-b", "c3-a", "c3-b"]
    assert items[1]["expected"] == "fail" and items[1]["passage"] == "Passage 1."
    assert items[5]["split"] == "holdout"


def test_judge_records_errors_and_resumes(workspace, settings):
    items, runs = store.load_items(workspace["cases"]), workspace["runs"]
    todo, counts = pipeline.judge("gemini-rubric", "original", 1, items, {"gemini": FakeGemini({"Right 2."})}, settings, runs)
    assert (todo, counts) == (6, {"ok": 5, "error": 1})
    retry = FakeGemini()
    todo, _ = pipeline.judge("gemini-rubric", "original", 1, items, {"gemini": retry}, settings, runs)
    assert todo == 1 and len(retry.calls) == 1
    record = store.load_judgments("gemini-rubric", "original", 1, runs)["c1-a"]
    assert record["usd"] == round((10 * 0.3 + 2 * 2.5) / 1e6, 8) and record["reasoning"] == "r"


def test_padded_input_and_jev(workspace, settings):
    items, runs = store.load_items(workspace["cases"]), workspace["runs"]
    clients = {"gemini": FakeGemini(), "jev": FakeJev()}
    pipeline.judge("gemini-rubric", "padded", 1, items, clients, settings, runs)
    assert {r["verdict"] for r in store.load_judgments("gemini-rubric", "padded", 1, runs).values()} == {"pass"}
    pipeline.judge("jev-rubric", "original", 1, items, clients, settings, runs)
    jev = store.load_judgments("jev-rubric", "original", 1, runs)
    assert jev["c1-a"]["p_pass"] == 0.7 and jev["c1-a"]["usd"] is None


def test_pad_is_identical_for_every_answer():
    assert prompts.pad(" Paris. ").startswith(prompts.PAD_PREFIX)
    assert prompts.pad("A").replace("A", "B", 1) == prompts.pad("B")


def test_experiment_jobs():
    jobs = pipeline.experiment()
    assert len(jobs) == 2 * (pipeline.REPEATS + 1) + 4
    assert ("jev-rubric", "padded", 1, "length bias") in jobs
    assert len(pipeline.experiment("ragtruth")) == len(jobs) + 2


def test_verdicts_export_and_fallback(tmp_path):
    runs = tmp_path / "runs" / "demo"
    store.append_jsonl(store.judgments_path("jev-rubric", "original", 1, runs),
                       {"item_id": "a", "variant": "jev-rubric", "input": "original", "repeat": 1, "error": "HTTP 520"})
    store.append_jsonl(store.judgments_path("jev-rubric", "original", 1, runs),
                       {"item_id": "a", "variant": "jev-rubric", "input": "original", "repeat": 1, "verdict": "pass",
                        "p_pass": 0.9, "at": "x", "confidence": 0.8})
    out, n = store.export_verdicts(runs)
    assert n == 1 and out == tmp_path / "results" / "demo" / "verdicts.jsonl"
    row = store.read_jsonl(out)[0]
    assert row["verdict"] == "pass" and "at" not in row and "confidence" not in row
    # Without local runs, the committed verdicts are used.
    import shutil
    shutil.rmtree(tmp_path / "runs")
    assert store.load_judgments("jev-rubric", "original", 1, runs)["a"]["p_pass"] == 0.9
    assert store.load_judgments("jev-rubric", "padded", 1, runs) == {}
