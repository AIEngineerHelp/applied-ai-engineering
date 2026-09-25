"""RCA accuracy eval on Loghub BGL (the only 2k sample with ground-truth anomaly labels).

One case per BGL node with anomalous lines: the alert names the node, the agent investigates
the (label-stripped) logs, and its top hypothesis is scored against the node's BGL alert
label mapped to our fault taxonomy (evals/loghub/taxonomy.yaml).

    uv run python -m evals.loghub.evaluate --n 28 --concurrency 4

Costs real LLM usage (~$0.05 per case with the default Gemini models).
"""
import argparse
import asyncio
import json
import random
import subprocess
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from langgraph.checkpoint.memory import InMemorySaver

from evals.loghub.builders.base import IncidentCase
from evals.loghub.builders.bgl import BGLBuilder
from src.ira.config import ROOT_DIR, settings
from src.ira.orchestrator.checkpoint import checkpoint_serde
from src.ira.orchestrator.graph import OrchestratorDeps, build_graph
from src.ira.orchestrator.state import initial_state

TARGET_FAULT_ACCURACY = 0.70  # project success target
RESULTS_DIR = ROOT_DIR / "evals" / "results"


def _git_commit() -> str | None:
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT_DIR,
                             capture_output=True, text=True, timeout=5, check=False)
        return out.stdout.strip() or None
    except OSError:
        return None


def stratified_sample(cases: list[IncidentCase], n: int, seed: int) -> list[IncidentCase]:
    """Round-robin over labels so rare failure types are represented, not just KERNSTOR."""
    rng = random.Random(seed)
    by_label: dict[str, list[IncidentCase]] = defaultdict(list)
    for c in cases:
        by_label[c.ground_truth.label].append(c)
    for group in by_label.values():
        rng.shuffle(group)
    picked: list[IncidentCase] = []
    while len(picked) < n and any(by_label.values()):
        for label in sorted(by_label):
            if by_label[label] and len(picked) < n:
                picked.append(by_label[label].pop())
    return picked


def node_matches(predicted: str, node: str) -> bool:
    """Full node id (R02-M1-N0-C:J12-U11) or its node-card location (R02-M1-N0-C)."""
    pred = predicted.upper()
    return node.upper() in pred or node.split(":")[0].upper() in pred


async def run_case(graph: Any, case: IncidentCase, sem: asyncio.Semaphore) -> dict[str, Any]:
    gt = case.ground_truth
    row: dict[str, Any] = {
        "case_id": case.case_id, "node": gt.affected_nodes[0], "label": gt.label,
        "expected": gt.fault_type, "accepted": gt.accepted_fault_types,
    }
    async with sem:
        started = time.monotonic()
        try:
            state = await graph.ainvoke(
                initial_state(case.incident), {"configurable": {"thread_id": case.case_id}}
            )
            row["error"] = None
        except Exception as e:  # noqa: BLE001 - a failed run scores as a miss
            state, row["error"] = {}, f"{type(e).__name__}: {e}"
        row["seconds"] = round(time.monotonic() - started, 1)

    hyps = state.get("hypotheses") or []
    top = hyps[0] if hyps else None
    row.update({
        "predicted": top.fault_type if top else None,
        "component": top.root_cause_component if top else None,
        "confidence": top.confidence if top else None,
        "top3": [h.fault_type for h in hyps[:3]],
        "iterations": state.get("iterations", 0),
        "cost_usd": round(state.get("budget_used_usd", 0.0), 4),
        "description": top.description[:300] if top else None,
    })
    accepted = set(gt.accepted_fault_types)
    row["fault_strict"] = bool(top and top.fault_type == gt.fault_type)
    row["fault_lenient"] = bool(top and top.fault_type in accepted)
    row["fault_top3_lenient"] = any(f in accepted for f in row["top3"])
    row["node_top1"] = bool(top and node_matches(top.root_cause_component, row["node"]))
    print(f"  {case.case_id:32} {gt.label:9} expected={gt.fault_type:13} "
          f"got={row['predicted']!s:15} conf={row['confidence']!s:5} "
          f"{'OK ' if row['fault_lenient'] else 'MISS'} {row['seconds']}s ${row['cost_usd']}"
          + (f" ERROR {row['error'][:80]}" if row["error"] else ""))
    return row


def summarise(rows: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(rows)

    def rate(key: str) -> float:
        return round(sum(r[key] for r in rows) / n, 3) if n else 0.0

    # Baseline: always answer the most common primary fault type in this sample.
    majority, _ = Counter(r["expected"] for r in rows).most_common(1)[0]
    per_label: dict[str, dict[str, int]] = defaultdict(lambda: {"n": 0, "lenient": 0,
                                                                "strict": 0})
    for r in rows:
        per_label[r["label"]]["n"] += 1
        per_label[r["label"]]["lenient"] += r["fault_lenient"]
        per_label[r["label"]]["strict"] += r["fault_strict"]
    confident = [r for r in rows if (r["confidence"] or 0) >= settings.min_confidence]
    right = [r["confidence"] for r in rows if r["fault_lenient"] and r["confidence"] is not None]
    wrong = [r["confidence"] for r in rows if not r["fault_lenient"] and r["confidence"] is not None]
    return {
        "cases": n,
        "fault_top1_strict": rate("fault_strict"),
        "fault_top1_lenient": rate("fault_lenient"),
        "fault_top3_lenient": rate("fault_top3_lenient"),
        "node_top1": rate("node_top1"),
        "no_hypothesis": sum(r["predicted"] is None for r in rows),
        "errors": sum(bool(r["error"]) for r in rows),
        "baseline_majority_class": majority,
        "baseline_strict": round(sum(r["expected"] == majority for r in rows) / n, 3),
        "baseline_lenient": round(sum(majority in r["accepted"] for r in rows) / n, 3),
        "precision_when_confident": round(
            sum(r["fault_lenient"] for r in confident) / len(confident), 3) if confident else None,
        "confident_cases": len(confident),
        "mean_confidence_correct": round(sum(right) / len(right), 3) if right else None,
        "mean_confidence_wrong": round(sum(wrong) / len(wrong), 3) if wrong else None,
        "mean_seconds": round(sum(r["seconds"] for r in rows) / n, 1),
        "total_cost_usd": round(sum(r["cost_usd"] for r in rows), 3),
        "mean_iterations": round(sum(r["iterations"] for r in rows) / n, 2),
        "per_label": dict(per_label),
        "target_fault_accuracy": TARGET_FAULT_ACCURACY,
        "models": settings.role_models,
    }


def markdown(summary: dict[str, Any], rows: list[dict[str, Any]], started: str) -> str:
    s = summary
    pct = lambda x: f"{x * 100:.0f}%"  # noqa: E731
    lines = [
        f"# RCA eval: Loghub BGL ({started})", "",
        f"{s['cases']} cases, models: planner/analyst `{s['models']['planner']}`, "
        f"gatherer/reporter `{s['models']['gatherer']}`.", "",
        "| Metric | Agent | Majority-class baseline |", "|---|---|---|",
        f"| Fault type, top-1 (strict) | **{pct(s['fault_top1_strict'])}** | "
        f"{pct(s['baseline_strict'])} (always `{s['baseline_majority_class']}`) |",
        f"| Fault type, top-1 (lenient) | **{pct(s['fault_top1_lenient'])}** | "
        f"{pct(s['baseline_lenient'])} |",
        f"| Fault type, top-3 (lenient) | {pct(s['fault_top3_lenient'])} | |",
        f"| Node localisation, top-1 | {pct(s['node_top1'])} | (node is named in the alert) |",
        f"| Precision when confidence ≥ {settings.min_confidence} | "
        f"{pct(s['precision_when_confident']) if s['precision_when_confident'] is not None else '-'}"
        f" ({s['confident_cases']} cases) | |",
        f"| Mean confidence: correct / wrong | {s['mean_confidence_correct']} / "
        f"{s['mean_confidence_wrong']} | |",
        "", f"Target: fault-type accuracy ≥ {pct(s['target_fault_accuracy'])}. "
        f"No hypothesis: {s['no_hypothesis']}; errors: {s['errors']}; "
        f"mean {s['mean_seconds']}s and {s['mean_iterations']} iterations per case; "
        f"total cost ${s['total_cost_usd']}.", "",
        "## Per label", "", "| Label | Cases | Lenient | Strict |", "|---|---|---|---|",
        *[f"| {k} | {v['n']} | {v['lenient']} | {v['strict']} |"
          for k, v in sorted(s["per_label"].items())],
        "", "## Cases", "",
        "| Case | Label | Expected | Predicted | Conf | Lenient | Node |", "|---|---|---|---|---|---|---|",
        *[f"| {r['case_id']} | {r['label']} | {r['expected']} | {r['predicted']} | "
          f"{r['confidence']} | {'✓' if r['fault_lenient'] else '✗'} | "
          f"{'✓' if r['node_top1'] else '✗'} |" for r in rows],
    ]
    return "\n".join(lines) + "\n"


async def evaluate_bgl(
    n: int, seed: int, concurrency: int, exclude_seed: int | None = None, exclude_n: int = 28,
    use_graph: bool = False,
) -> dict[str, Any]:
    cases = BGLBuilder().build_cases(
        str(settings.loghub_dir / "BGL" / "BGL_2k.log_structured.csv"))
    if exclude_seed is not None:
        # Hold-out run: drop the cases another seed's sample used (e.g. while tuning prompts).
        seen = {c.case_id for c in stratified_sample(cases, exclude_n, exclude_seed)}
        cases = [c for c in cases if c.case_id not in seen]
    sample = stratified_sample(cases, n, seed)
    print(f"BGL: {len(cases)} labelled cases, evaluating {len(sample)} "
          f"(labels: {dict(Counter(c.ground_truth.label for c in sample))})")
    # interrupt() needs a checkpointer; runs that reach an approval simply stop there.
    driver = None
    store = None
    if use_graph:
        # Read-only knowledge-graph context; past incidents are excluded so earlier
        # answers can't leak into cases, and eval runs never write to the graph.
        from neo4j import AsyncGraphDatabase

        from src.ira.knowledge.store import GraphStore

        driver = AsyncGraphDatabase.driver(
            settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password),
            notifications_min_severity="OFF")
        store = GraphStore(driver)
        if await store.count() == 0:
            raise SystemExit("Knowledge graph is empty: run `uv run python -m "
                             "src.ira.knowledge.build` first")
    graph = build_graph(OrchestratorDeps.default(graph=store, graph_history=False),
                        checkpointer=InMemorySaver(serde=checkpoint_serde()))
    started = (datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ") + f"-seed{seed}"
               + ("-graph" if use_graph else ""))
    sem = asyncio.Semaphore(concurrency)
    try:
        rows = await asyncio.gather(*(run_case(graph, c, sem) for c in sample))
    finally:
        if driver is not None:
            await driver.close()
    summary = summarise(list(rows))
    summary["meta"] = {
        "run_id": f"bgl-{started}", "dataset": "BGL", "seed": seed, "n": n,
        "exclude_seed": exclude_seed, "holdout": exclude_seed is not None,
        "knowledge_graph": use_graph,
        "started_at": started, "finished_at": datetime.now(UTC).isoformat(),
        "git_commit": _git_commit(),
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stem = RESULTS_DIR / f"bgl-{started}"
    Path(f"{stem}.json").write_text(json.dumps({"summary": summary, "cases": rows}, indent=2,
                                               default=str))
    Path(f"{stem}.md").write_text(markdown(summary, list(rows), started))
    print("\n" + json.dumps({k: v for k, v in summary.items()
                             if k not in ("per_label", "models")}, indent=2))
    print(f"\nWrote {stem}.md and .json")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="RCA accuracy eval on Loghub BGL")
    parser.add_argument("--n", type=int, default=28, help="cases to run (max 84)")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--exclude-seed", type=int, default=None,
                        help="exclude the cases sampled with this seed (hold-out evaluation)")
    parser.add_argument("--graph", action="store_true",
                        help="give the agent knowledge-graph context (needs Neo4j with the "
                             "graph loaded; past incidents are excluded)")
    args = parser.parse_args()
    asyncio.run(evaluate_bgl(args.n, args.seed, args.concurrency, args.exclude_seed,
                             use_graph=args.graph))


if __name__ == "__main__":
    main()
