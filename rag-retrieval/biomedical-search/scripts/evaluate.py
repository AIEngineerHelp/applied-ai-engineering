"""Reproducible retrieval and fixed-prompt LLM-judge evaluation over the frozen query IDs."""

import argparse
import hashlib
import json
import platform
import statistics
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from app import config
from app.llm import (
    ANSWER_PROMPT,
    EXPANSION_PROMPT,
    JUDGE_PROMPT,
    generate_answer,
    generation_settings,
    judge_answer,
)
from app.retrieval import SearchEngine, read_jsonl


def retrieval_metrics(retrieved_ids, gold_ids):
    gold = set(str(i) for i in gold_ids)
    retrieved = list(dict.fromkeys(str(i) for i in retrieved_ids))
    if not gold:
        raise ValueError("A query must have at least one relevant passage.")
    recall5 = len(set(retrieved[:5]) & gold) / len(gold)
    recall10 = len(set(retrieved[:10]) & gold) / len(gold)
    relevant_ranks = [i + 1 for i, p in enumerate(retrieved[:10]) if p in gold]
    mrr = 1 / relevant_ranks[0] if relevant_ranks else 0
    dcg = sum(1 / np.log2(rank + 1) for rank in relevant_ranks)
    ideal = sum(1 / np.log2(rank + 1) for rank in range(1, min(10, len(gold)) + 1))
    return {
        "recall_at_5": recall5,
        "recall_at_10": recall10,
        "mrr_at_10": mrr,
        "ndcg_at_10": float(dcg / ideal),
    }


def summarize(rows):
    result = {
        metric: statistics.mean(row["metrics"][metric] for row in rows)
        for metric in ("recall_at_5", "recall_at_10", "mrr_at_10", "ndcg_at_10")
    }
    latencies = [row["retrieval_ms"] for row in rows]
    result.update(
        {
            "queries": len(rows),
            "latency_mean_ms": statistics.mean(latencies),
            "latency_p95_ms": float(np.percentile(latencies, 95)),
        }
    )
    expansion_usages = [row["expansion_usage"] for row in rows if row.get("expansion_usage")]
    remote_embeddings = config.EMBEDDING_BACKEND == "gemini" and any(
        row["configuration"]["mode"] != "lexical" for row in rows
    )
    result["retrieval_api_cost_usd"] = (
        None
        if remote_embeddings or any(u.get("cost_usd") is None for u in expansion_usages)
        else sum(u["cost_usd"] for u in expansion_usages)
    )
    evaluated = [row for row in rows if "judge" in row]
    result["judge_queries"] = len(evaluated)
    for metric in ("correctness", "groundedness", "context_relevance"):
        result[metric] = statistics.mean(row["judge"][metric] for row in evaluated) if evaluated else None
    answers = [row["answer"] for row in rows if "answer" in row]
    result["answer_queries"] = len(answers)
    result["citation_validity"] = statistics.mean(a["citation_valid"] for a in answers) if answers else None
    result["abstention_rate"] = (
        statistics.mean(a["status"] == "insufficient_evidence" for a in answers) if answers else None
    )
    result["answer_latency_mean_ms"] = (
        statistics.mean(a["usage"]["latency_ms"] for a in answers if a.get("usage"))
        if any(a.get("usage") for a in answers)
        else None
    )
    usages = [
        row[stage]["usage"]
        for row in rows
        for stage in ("answer", "judge")
        if stage in row and row[stage].get("usage")
    ]
    result["llm_api_cost_usd"] = (
        sum(u["cost_usd"] for u in usages)
        if usages and all(u["cost_usd"] is not None for u in usages)
        else None
    )
    result["errors"] = sum("error" in row for row in rows)
    return result


def write_report(summary, results):
    lines = [
        "# Biomedical hybrid search evaluation",
        "",
        f"Run: {summary['run_id']}",
        "",
        f"Dataset: `{config.DATASET}`. {summary['passages']:,} indexed passages. "
        f"The same {summary['queries']} fixed query IDs were used for all five configurations.",
        "",
        "## Comparison",
        "",
        "| Configuration | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | Mean ms | p95 ms | Judge n | Correctness | Groundedness | Context relevance |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]

    def fmt(value):
        return "pending" if value is None else f"{value:.3f}"

    for row in summary["configurations"]:
        lines.append(
            f"| {row['name']} | {row['recall_at_5']:.3f} | {row['recall_at_10']:.3f} | "
            f"{row['mrr_at_10']:.3f} | {row['ndcg_at_10']:.3f} | {row['latency_mean_ms']:.1f} | "
            f"{row['latency_p95_ms']:.1f} | {row['judge_queries']} | {fmt(row['correctness'])} | "
            f"{fmt(row['groundedness'])} | {fmt(row['context_relevance'])} |"
        )
    best = next(r for r in summary["configurations"] if r["name"] == summary["best_hybrid"])
    lexical = next(r for r in summary["configurations"] if r["name"] == "lexical")
    overall = max(summary["configurations"], key=lambda r: (r["ndcg_at_10"], r["recall_at_10"]))
    if best["name"] == "hybrid":
        explanation = (
            "Expansion did not improve the selection criterion in this comparison. "
            "The original-query hybrid also avoids retrieving and embedding alternate queries."
        )
    elif best["name"] == "hybrid_expanded":
        baseline = next(r for r in summary["configurations"] if r["name"] == "hybrid")
        explanation = (
            f"Expansion changed nDCG@10 by {best['ndcg_at_10'] - baseline['ndcg_at_10']:+.3f} "
            "relative to the original-query hybrid, at the cost of extra query embedding and scoring."
        )
    else:
        explanation = (
            "The result is consistent with stronger exact-term matching and more conservative "
            "expansion contributions (an interpretation, not an isolated causal finding). "
            "Separate ablations would be needed to attribute the gain to each weight or RRF setting."
        )
    lines += [
        "",
        "## Selected configuration",
        "",
        f"**{best['name']}** is the best hybrid by nDCG@10 ({best['ndcg_at_10']:.3f}); "
        "Recall@10 breaks ties. Selection uses retrieval relevance labels, not LLM-judge scores.",
        "",
        explanation,
        "",
        f"Its mean retrieval latency is {best['latency_mean_ms']:.1f} ms, compared with "
        f"{lexical['latency_mean_ms']:.1f} ms for lexical retrieval. "
        "Gemini query embeddings and LLM expansion may incur API charges; retrieval cost is unknown "
        "unless all applicable rates are configured. Index preparation and hardware costs are excluded.",
        "",
        f"The overall retrieval winner is **{overall['name']}**. "
        "Hybrid fusion is an empirical choice; it is not assumed to beat lexical retrieval.",
        "",
        "## Method and limitations",
        "",
        "- The 100-query set is seeded (42) and approximately balanced by rule-based question categories. "
        "Only questions whose entire gold passage set survives missing-text filtering are eligible.",
        "- Configurations were specified before measurement. This is a comparison set used for selection, "
        "not an independent held-out estimate after selecting the winner.",
        "- BM25 uses k1=1.5, b=0.75, English stop words, and retains gene symbols and hyphenated terms. "
        "Neural embeddings use the model and dimensions recorded in the run manifest.",
        f"- Expansion uses `{config.EXPANSION_MODEL}` with a fixed prompt at temperature 0 and retains the original query. Generated alternatives and usage are logged per search.",
        "- Hybrid uses weighted reciprocal rank fusion over the top 50 from each signal/query. "
        "The expanded baseline weights original queries at 1.0 and expansions at 0.6; "
        "the weighted candidate uses lexical weight 0.65, RRF k=20, and expansion weight 0.35.",
        "- Latency includes expansion, query embedding, scoring, and fusion; it excludes initial model/index load. "
        "Queries are not embedding-cached between variants. Gemini network latency and quota may affect timings.",
        "- Answer generation uses at most five selected passages, truncated to 1,800 characters each. "
        "The UI displays the exact selected context. Citation validation checks IDs and answer structure, "
        "not entailment; the judge separately assesses support.",
        f"- Answer model: `{config.ANSWER_MODEL}`. Judge model: `{config.JUDGE_MODEL}`. "
        "Both use temperature 0. Judge prompt and settings are fixed across variants.",
        "- LLM evaluation uses an equivalent fixed-rubric judge with correctness, groundedness, and "
        "context relevance scored in [0,1]. The LLM judge is a diagnostic, not a validated "
        "medical authority. Shared answer/judge models can have correlated errors.",
        f"- Judge coverage: {summary['judge_limit']} of {summary['queries']} queries per variant requested. "
        "Pending cells indicate unrun evaluation, never estimated scores. Errors are logged per query.",
        "- A separately inspected preflight example is documented in `docs/manual-review.md`; "
        "it exposed an overgenerous judge explanation despite valid citation IDs.",
        "",
        "## Successful searches and failure cases",
        "",
    ]
    selected_rows = results[best["name"]]
    ranked = sorted(selected_rows, key=lambda r: r["metrics"]["ndcg_at_10"])
    for label, examples in (("Successes", list(reversed(ranked[-3:]))), ("Failures", ranked[:3])):
        lines += [f"### {label}", ""]
        for row in examples:
            lines += [
                f"- Query {row['query_id']}: {row['question']}",
                f"  nDCG@10={row['metrics']['ndcg_at_10']:.3f}; "
                f"Recall@10={row['metrics']['recall_at_10']:.3f}; "
                f"retrieved IDs: {', '.join(row['retrieved_ids'])}.",
            ]
        lines.append("")
    disagreements = [
        row
        for row in selected_rows
        if "judge" in row and abs(row["metrics"]["ndcg_at_10"] - row["judge"]["correctness"]) > 0.35
    ]
    lines += [
        "## Manual review queue",
        "",
        "Examples with |nDCG@10 − judge correctness| > 0.35. "
        "These are candidates for manual inspection; automated annotations are not manual review.",
        "",
    ]
    for row in disagreements[:10]:
        lines += [
            f"- Query {row['query_id']}: {row['question']}",
            f"  Retrieval nDCG={row['metrics']['ndcg_at_10']:.3f}, judge correctness="
            f"{row['judge']['correctness']:.3f}. Judge: {row['judge']['explanation']}",
        ]
    if not disagreements:
        lines.append(
            "No flagged examples in completed judge results. Inspect raw run files for broader review."
        )
    (config.EXPERIMENTS / "report.md").write_text("\n".join(lines) + "\n")


def evaluate(answers=False, judge_limit=100, output=None):
    engine = SearchEngine()
    if not engine.dense_ready:
        raise RuntimeError("Rebuild the Gemini embedding index before comparing dense/hybrid retrieval.")
    query_path = config.EXPERIMENTS / "queries-100.jsonl"
    questions = read_jsonl(query_path)
    if len(questions) != 100 or len({q["id"] for q in questions}) != 100:
        raise ValueError("Evaluation requires exactly 100 distinct fixed query IDs.")
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_dir = Path(output) if output else config.EXPERIMENTS / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "answer-prompt.txt").write_text(ANSWER_PROMPT)
    (run_dir / "judge-prompt.txt").write_text(JUDGE_PROMPT)
    (run_dir / "expansion-prompt.txt").write_text(EXPANSION_PROMPT)
    (run_dir / "settings.json").write_text(
        json.dumps(
            {
                "variants": config.VARIANTS,
                "provider": config.PROVIDER,
                "answer_model": config.ANSWER_MODEL,
                "judge_model": config.JUDGE_MODEL,
                "expansion_model": config.EXPANSION_MODEL,
                "expansion_settings": generation_settings(config.EXPANSION_MODEL),
                "answer_settings": generation_settings(config.ANSWER_MODEL),
                "judge_settings": generation_settings(config.JUDGE_MODEL),
                "context_passages": 5,
                "context_characters": 1800,
                "embedding_model": config.EMBEDDING_MODEL,
                "embedding_threads": config.EMBEDDING_THREADS,
                "embedding_backend": config.EMBEDDING_BACKEND,
            },
            indent=2,
        )
    )
    results, comparisons = {}, []
    # A content-addressed cache makes full local LLM evaluation resumable without conflating settings.
    cache_dir = config.EXPERIMENTS / "answer-cache"
    cache_dir.mkdir(exist_ok=True)
    for variant, settings in config.VARIANTS.items():
        rows = []
        print(f"Running {variant} on the same 100 questions…", flush=True)
        with (run_dir / f"{variant}.jsonl").open("w") as stream:
            for i, question in enumerate(questions):
                search = engine.search(question["question"], top_k=10, **settings)
                ids = [p["id"] for p in search["evidence"]]
                row = {
                    "query_id": question["id"],
                    "question": question["question"],
                    "reference_answer": question["answer"],
                    "category": question["category"],
                    "gold_ids": question["relevant_passage_ids"],
                    "retrieved_ids": ids,
                    "retrieved_scores": [p["score"] for p in search["evidence"]],
                    "queries": search["queries"],
                    "expansion_usage": search.get("expansion_usage"),
                    "configuration": search["configuration"],
                    "retrieval_ms": search["retrieval_ms"],
                    "metrics": retrieval_metrics(ids, question["relevant_passage_ids"]),
                }
                if answers and i < judge_limit:
                    signature = {
                        "question": question,
                        "context": search["evidence"][:5],
                        "answer_prompt": ANSWER_PROMPT,
                        "judge_prompt": JUDGE_PROMPT,
                        "answer_model": config.ANSWER_MODEL,
                        "judge_model": config.JUDGE_MODEL,
                        "provider": config.PROVIDER,
                        "base_url": config.BASE_URL,
                        "answer_settings": generation_settings(config.ANSWER_MODEL),
                        "judge_settings": generation_settings(config.JUDGE_MODEL),
                    }
                    # Scores/rank don't affect LLM input. Remove them so equivalent contexts share a cache.
                    signature["context"] = [
                        {"id": p["id"], "text": p["text"][:1800]} for p in search["evidence"][:5]
                    ]
                    key = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
                    cached = cache_dir / f"{key}.json"
                    try:
                        if cached.exists():
                            row.update(json.loads(cached.read_text()))
                            row["llm_cached"] = True
                        else:
                            row["answer"] = generate_answer(question["question"], search["evidence"])
                            row["judge"] = judge_answer(
                                question["question"], question["answer"], row["answer"]
                            )
                            cached.write_text(json.dumps({"answer": row["answer"], "judge": row["judge"]}))
                            row["llm_cached"] = False
                    except Exception as exc:
                        row["error"] = str(exc)
                        print(f"  Query {question['id']} LLM error: {exc}", flush=True)
                stream.write(json.dumps(row) + "\n")
                stream.flush()
                rows.append(row)
                if (i + 1) % 20 == 0:
                    print(f"  {i + 1}/100", flush=True)
        results[variant] = rows
        comparisons.append({"name": variant, **summarize(rows)})
    hybrid_rows = [r for r in comparisons if config.VARIANTS[r["name"]]["mode"] == "hybrid"]
    winner = max(hybrid_rows, key=lambda r: (r["ndcg_at_10"], r["recall_at_10"]))
    best = {
        "variant": winner["name"],
        "index_signature": {
            key: engine.manifest[key] for key in ("corpus_sha256", "embedding_model", "embedding_backend")
        },
        "configuration": config.VARIANTS[winner["name"]],
        "criterion": "nDCG@10, then Recall@10",
        "run_id": run_id,
        "ndcg_at_10": winner["ndcg_at_10"],
    }
    summary = {
        "status": "complete",
        "run_id": run_id,
        "run_directory": str(run_dir.relative_to(config.ROOT))
        if run_dir.is_relative_to(config.ROOT)
        else str(run_dir),
        "queries": len(questions),
        "query_set_sha256": hashlib.sha256(query_path.read_bytes()).hexdigest(),
        "categories": dict(Counter(q["category"] for q in questions)),
        "passages": engine.manifest["passages"],
        "manifest": engine.manifest,
        "machine": {"system": platform.system(), "machine": platform.machine()},
        "answer_model": config.ANSWER_MODEL,
        "judge_model": config.JUDGE_MODEL,
        "judge_limit": judge_limit if answers else 0,
        "best_hybrid": winner["name"],
        "llm_evaluation_complete": answers
        and judge_limit == 100
        and all(r["judge_queries"] == 100 for r in comparisons),
        "configurations": comparisons,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    (config.EXPERIMENTS / "summary.json").write_text(json.dumps(summary, indent=2))
    (config.EXPERIMENTS / "best-config.json").write_text(json.dumps(best, indent=2))
    write_report(summary, results)
    print(f"Best hybrid: {winner['name']}; report: experiments/report.md", flush=True)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--answers", action="store_true", help="Generate answers and run the fixed LLM judge")
    parser.add_argument(
        "--judge-limit", type=int, default=100, help="Explicitly labeled smoke subset; default 100"
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.judge_limit <= 100:
        parser.error("--judge-limit must be between 1 and 100")
    evaluate(args.answers, args.judge_limit, args.output)
