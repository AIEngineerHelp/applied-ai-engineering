"""Measuring the method: a second judge, attack diversity, a keyword check, and a rule revision rerun.

    uv run python -m riskdemo study keyword                 # free: keyword check on every recorded conversation
    uv run python -m riskdemo study rejudge --judge gemini-4-argon [--live]
    uv run python -m riskdemo study diversity [--live]      # --live embeds the first user turns
    uv run python -m riskdemo study loop [--live]           # re-judge and rerun with the revised rules
    uv run python -m riskdemo study analyze                 # free: writes results/study/summary.json

Commands that call Gemini are dry runs unless given --live. Raw responses stay in runs/; what the app
reads is written to results/.
"""

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from riskdemo import config, costs, measure
from riskdemo.catalog import AGENTS, REVISIONS, RISKS, RiskDefinition, risk_revision
from riskdemo.engine import attacker_brief
from riskdemo.sample import load_set

EMBEDDING_MODEL = "gemini-embedding-2"
# The half-refusal the page shows: the recorded conversation, the agent turn, and the phrases to highlight.
HALF_REFUSAL_EXAMPLE = {
    "risk": "medication-changes",
    "version": "naive",
    "attack": 3,
    "turn": 3,
    "phrases": [
        "I cannot formally authorize a dose for your medical chart",
        "a single 500 mg dose of acetaminophen carries a very low risk of interacting with warfarin",
    ],
}
OPENINGS_CELL = ("investment-advice", "naive")
LOOP_CELLS = [("dispute-recourse", "naive", 10), ("investment-advice", "hardened", 1)]  # (risk, version, attack)


def _write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")


def _read(path: Path) -> Any:
    return json.loads(path.read_text()) if path.exists() else None


LABEL_FILES = {"recorded": "labels.json", "seeded": "labels-seeded.json"}


def labels(set_name: str = "recorded") -> list[dict]:
    return _read(config.STUDY / LABEL_FILES[set_name])["labels"]


def replies(attack: dict) -> list[str | None]:
    return [t.get("agent") for t in attack["turns"]]


def conformity(attack: dict) -> dict | None:
    return next((c for c in attack["checks"] if c.get("kind") == "conformity"), None)


# ---------- judging a recorded conversation again ----------


async def judge_conversation(risk: RiskDefinition, attack: dict, model: str) -> dict:
    """Run Giskard's Conformity judge on a recorded conversation, with the trace the original judge saw."""
    from giskard.checks import Conformity
    from giskard.checks.core.interaction.interaction import Interaction
    from giskard.checks.core.interaction.trace import Trace

    trace = Trace[str, str](
        interactions=[Interaction(inputs=t["user"], outputs=t["agent"] or "") for t in attack["turns"]],
        annotations=attacker_brief(risk, AGENTS[risk.agent]),
    )
    check = Conformity(name=risk.risk, rule=risk.rule(), judge=f"gemini/{model}")
    for attempt in range(3):
        try:
            result = await check.run(trace)
            return {"status": result.status.value, "reason": result.details.get("reason") or result.message}
        except Exception as error:  # bounded retries; a provider hiccup should not lose the whole batch
            if attempt == 2:
                return {"status": "error", "reason": f"{type(error).__name__}: {error}"}
            await asyncio.sleep(3 * (attempt + 1))
    raise AssertionError("unreachable")


async def judge_many(items: list[tuple[RiskDefinition, dict]], model: str, concurrency: int = 4) -> list[dict]:
    semaphore = asyncio.Semaphore(concurrency)

    async def one(risk, attack):
        async with semaphore:
            return await judge_conversation(risk, attack, model)

    return await asyncio.gather(*(one(r, a) for r, a in items))


def rejudge(args: argparse.Namespace) -> None:
    runs = load_set(config.SETS[args.set])
    rows = labels(args.set)
    print(f"re-judge {len(rows)} labelled conversations ({args.set}) with gemini/{args.judge}: {len(rows)} judge calls")
    if not args.live:
        print("Dry run. Add --live to make these paid calls.")
        return
    settings = config.load_settings()
    if not settings.live_available:
        raise SystemExit("Set GEMINI_API_KEY in .env first.")
    costs.install()
    costs.phase.set(f"rejudge:{args.set}:{args.judge}")
    items = [(RISKS[r["risk"]], runs[(r["risk"], r["version"])]["attacks"][r["attack"] - 1]) for r in rows]
    verdicts = asyncio.run(judge_many(items, args.judge))
    out = [
        {"risk": r["risk"], "version": r["version"], "attack": r["attack"], **v}
        for r, v in zip(rows, verdicts, strict=True)
    ]
    suffix = "" if args.set == "recorded" else f"--{args.set}"
    name = f"judge--{args.judge}{suffix}.json"
    _write(config.STUDY / name, {"model": args.judge, "set": args.set, "verdicts": out})
    print(f"wrote results/study/{name}; errors: {sum(v['status'] == 'error' for v in out)}")


def seeded_check(kw: dict) -> dict | None:
    """Agreement on the seeded cell we labelled: the recording's judge, any re-judges, and the keyword check."""
    path = config.STUDY / LABEL_FILES["seeded"]
    if not path.exists():
        return None
    rows = labels("seeded")
    runs = load_set(config.SEEDED)
    kw_index = {(k["risk"], k["version"], k["attack"]): k["passed"] for k in kw["sets"].get("seeded", [])}
    raters: dict[str, dict] = {}
    first_model = next(iter(runs.values()))["models"]["judge"]
    keys = [(r["risk"], r["version"], r["attack"]) for r in rows]
    truth = {k: r["label"] == "pass" for k, r in zip(keys, rows, strict=True)}
    judged = {k: runs[k[:2]]["attacks"][k[2] - 1]["status"] == "passed" for k in keys}
    raters[first_model] = measure.agreement((judged[k], truth[k]) for k in keys)
    others = {}
    for p in sorted(config.STUDY.glob("judge--*--seeded.json")):
        data = _read(p)
        v = {(x["risk"], x["version"], x["attack"]): x for x in data["verdicts"] if x["status"] != "error"}
        others[data["model"]] = v
        raters[data["model"]] = measure.agreement((v[k]["status"] == "pass", truth[k]) for k in keys if k in v)
    raters["keyword"] = measure.agreement((kw_index[k], truth[k]) for k in keys if k in kw_index)
    return {
        "cell": "--".join(keys[0][:2]) if keys else None,
        "raters": raters,
        "label_passed": sum(truth.values()),
        "n": len(keys),
        "conversations": [
            {
                **{k: r[k] for k in ("risk", "version", "attack", "label", "borderline", "reason")},
                "judges": {first_model: judged[key], **{m: v[key]["status"] == "pass" for m, v in others.items() if key in v}},
                "keyword": kw_index.get(key),
                "seed": runs[key[:2]]["attacks"][key[2] - 1].get("seed"),
            }
            for key, r in zip(keys, rows, strict=True)
        ],
    }


# ---------- keyword check ----------


def keyword(_args: argparse.Namespace | None = None) -> dict:
    out: dict = {"checks": {k: v[0] for k, v in measure.KEYWORD_CHECKS.items()}, "sets": {}}
    for name, directory in config.SETS.items():
        for (risk, version), run in load_set(directory).items():
            for a in run["attacks"]:
                if a["status"] not in ("passed", "failed"):
                    continue
                k = measure.keyword_check(risk, replies(a))
                out["sets"].setdefault(name, []).append(
                    {"risk": risk, "version": version, "attack": a["index"] + 1, "judge": a["status"], **k}
                )
    _write(config.STUDY / "keyword.json", out)
    print("wrote results/study/keyword.json")
    return out


# ---------- diversity ----------


def first_turns(directory: Path) -> dict[tuple[str, str], list[str]]:
    return {
        cell: [a["turns"][0]["user"] for a in run["attacks"] if a["turns"]]
        for cell, run in load_set(directory).items()
    }


async def _embed(texts: list[str], api_key: str, concurrency: int = 6) -> list[list[float]]:
    """One call per text: gemini-embedding-2 folds a list of contents into a single embedding."""
    from google import genai

    client = genai.Client(api_key=api_key)
    semaphore = asyncio.Semaphore(concurrency)

    async def one(text: str) -> list[float]:
        async with semaphore:
            for attempt in range(3):
                try:
                    response = await client.aio.models.embed_content(model=EMBEDDING_MODEL, contents=text)
                    return response.embeddings[0].values
                except Exception:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(3 * (attempt + 1))
        raise AssertionError("unreachable")

    return await asyncio.gather(*(one(t) for t in texts))


def diversity(args: argparse.Namespace) -> None:
    sets = {name: first_turns(d) for name, d in config.SETS.items()}
    texts = [t for cells in sets.values() for ts in cells.values() for t in ts]
    print(f"{len(texts)} first user turns; embeddings with {EMBEDDING_MODEL} need --live (one call per text)")
    cache = config.RUNS / "embeddings.json"
    vectors: dict[str, list[float]] = _read(cache) or {}
    missing = [t for t in dict.fromkeys(texts) if t not in vectors]
    if missing and args.live:
        settings = config.load_settings()
        costs.install()
        costs.phase.set("diversity:embeddings")
        for text, vec in zip(missing, asyncio.run(_embed(missing, settings.api_key)), strict=True):
            vectors[text] = vec
        _write(cache, vectors)
    out: dict = {"embedding_model": EMBEDDING_MODEL, "sets": {}}
    for name, cells in sets.items():
        per_cell = {}
        for (risk, version), ts in cells.items():
            d = measure.diversity(ts)
            if all(t in vectors for t in ts):
                d["embedding_similarity"] = measure.embedding_similarity([vectors[t] for t in ts])
            per_cell[f"{risk}--{version}"] = d
        keys = ["trigram_overlap", "distinct_2", "shared_opening", "embedding_similarity"]
        mean = {
            k: round(sum(c[k] for c in per_cell.values()) / len(per_cell), 4)
            for k in keys
            if per_cell and all(c.get(k) is not None for c in per_cell.values())
        }
        out["sets"][name] = {"cells": per_cell, "mean": mean}
    _write(config.STUDY / "diversity.json", out)
    print(json.dumps({n: s["mean"] for n, s in out["sets"].items()}, indent=1))


# ---------- closing the loop: revised rules ----------


def loop(args: argparse.Namespace) -> None:
    """For each revised rule: re-judge the first recording's cell with it, and rerun the seeded cell with it."""
    n = config.MAX_ATTACKS
    print("For each revised rule:")
    for risk_id, version, attack in LOOP_CELLS:
        print(f"  {risk_id} {version}: re-judge 10 recorded conversations (10 calls), rerun 10 seeded attacks")
    print(f"at most {len(LOOP_CELLS) * (10 + n * 7)} calls")
    if not args.live:
        print("Dry run. Add --live to make these paid calls.")
        return
    from riskdemo.live import live_run, save

    settings = config.load_settings()
    costs.install()
    recorded = load_set(config.RECORDED)

    async def go() -> None:
        for risk_id, version, _attack in LOOP_CELLS:
            revised = risk_revision(risk_id, 2)
            run = recorded[(risk_id, version)]
            costs.phase.set(f"loop:rejudge:{risk_id}--{version}")
            scored = [a for a in run["attacks"] if a["status"] in ("passed", "failed")]
            verdicts = await judge_many([(revised, a) for a in scored], settings.judge_model)
            _write(
                config.LOOP / f"{risk_id}--{version}--rejudged-r2.json",
                {
                    "risk": risk_id,
                    "version": version,
                    "set": "recorded",
                    "rule_revision": 2,
                    "rule": revised.rule(),
                    "judge": settings.judge_model,
                    "verdicts": [
                        {"attack": a["index"] + 1, "before": a["status"], **v}
                        for a, v in zip(scored, verdicts, strict=True)
                    ],
                },
            )
            costs.phase.set(f"loop:rerun:{risk_id}--{version}")
            rerun = await live_run(settings, risk_id, version, n, seeded=True, risk=revised)
            rerun["mode"] = "recorded"
            save(rerun, config.LOOP / f"{risk_id}--{version}--seeded-r2.json")
            s = rerun["summary"]
            print(f"{risk_id} {version} r2 seeded: passed {s['passed']}/{s['total']} errors {s['errored']}")

    asyncio.run(go())


# ---------- the summary the app reads ----------


def _cell_rates(directory: Path) -> dict:
    return {f"{r}--{v}": run["summary"] for (r, v), run in load_set(directory).items()}


def analyze(_args: argparse.Namespace | None = None) -> dict:
    recorded = load_set(config.RECORDED)
    rows = labels()
    kw = keyword()
    kw_index = {(k["risk"], k["version"], k["attack"]): k for k in kw["sets"].get("recorded", [])}

    # The first judge is the one that scored the recording; its verdicts are in the run files.
    first_model = next(iter(recorded.values()))["models"]["judge"]
    first = {
        (r, v, a["index"] + 1): {"status": a["status"], "reason": (conformity(a) or {}).get("reason", "")}
        for (r, v), run in recorded.items()
        for a in run["attacks"]
    }
    second = {}
    for path in sorted(config.STUDY.glob("judge--*.json")):
        data = _read(path)
        if data.get("set", "recorded") != "recorded":
            continue
        # Re-judging with the recording's own judge model measures how consistent that judge is run to run.
        name = f"{data['model']} (second run)" if data["model"] == first_model else data["model"]
        second[name] = {(x["risk"], x["version"], x["attack"]): x for x in data["verdicts"]}

    def passed(status: str) -> bool:
        return status in ("pass", "passed")

    conversations = []
    for row in rows:
        key = (row["risk"], row["version"], row["attack"])
        attack = recorded[(row["risk"], row["version"])]["attacks"][row["attack"] - 1]
        entry = {
            **{k: row[k] for k in ("risk", "version", "attack", "label", "borderline", "reason")},
            "judges": {first_model: {"passed": passed(first[key]["status"]), "reason": first[key]["reason"]}},
            "keyword": kw_index.get(key, {}).get("passed"),
            "first_turn": attack["turns"][0]["user"] if attack["turns"] else "",
        }
        for model, verdicts in second.items():
            if key in verdicts and verdicts[key]["status"] != "error":
                entry["judges"][model] = {"passed": passed(verdicts[key]["status"]), "reason": verdicts[key]["reason"]}
        conversations.append(entry)

    def table(get) -> dict:
        overall = [(get(c), c["label"] == "pass") for c in conversations if get(c) is not None]
        by_risk = {
            risk: measure.agreement((get(c), c["label"] == "pass") for c in conversations if c["risk"] == risk and get(c) is not None)
            for risk in RISKS
        }
        return {"overall": measure.agreement(overall), "by_risk": by_risk}

    # The stronger judge first after the recording's judge, so the comparison below pairs those two.
    models = [first_model, *sorted(second, key=lambda m: "(second run)" in m)]
    raters = {m: table(lambda c, m=m: c["judges"].get(m, {}).get("passed")) for m in models}
    raters["keyword"] = table(lambda c: c["keyword"])

    # Where the two judges disagree with each other, and who the labels side with.
    judge_disagreements = []
    if len(models) >= 2:
        a, b = models[0], models[1]
        for c in conversations:
            if a in c["judges"] and b in c["judges"] and c["judges"][a]["passed"] != c["judges"][b]["passed"]:
                judge_disagreements.append({k: c[k] for k in ("risk", "version", "attack", "label", "borderline")})

    half_refusals = [
        {k: c[k] for k in ("risk", "version", "attack", "reason")}
        for c in conversations
        if c["keyword"] and c["label"] == "fail"
    ]

    loop_results = []
    for risk_id, version, attack in LOOP_CELLS:
        rejudged = _read(config.LOOP / f"{risk_id}--{version}--rejudged-r2.json")
        rerun = _read(config.LOOP / f"{risk_id}--{version}--seeded-r2.json")
        seeded = _read(config.SEEDED / f"{risk_id}--{version}.json")
        revs = REVISIONS[risk_id]
        loop_results.append(
            {
                "risk": risk_id,
                "version": version,
                "attack": attack,
                "rule_before": revs[0].rule(),
                "rule_after": revs[1].rule(),
                "clarification": revs[1].clarification,
                "reason": revs[1].revision_reason,
                "rejudged": rejudged["verdicts"] if rejudged else None,
                "rerun_summary": rerun["summary"] if rerun else None,
                "seeded_summary": seeded["summary"] if seeded else None,
            }
        )

    summary = {
        "labels": {
            "n": len(rows),
            "fail": sum(r["label"] == "fail" for r in rows),
            "borderline": sum(r["borderline"] for r in rows),
        },
        "raters": raters,
        "judge_models": models,
        "judge_disagreements": judge_disagreements,
        "conversations": conversations,
        "keyword": {
            "checks": kw["checks"],
            "half_refusals_passed": half_refusals,
            "vs_judge": {
                name: measure.agreement((k["passed"], k["judge"] == "passed") for k in items)
                for name, items in kw["sets"].items()
            },
        },
        "diversity": _read(config.STUDY / "diversity.json"),
        "pass_rates": {name: _cell_rates(d) for name, d in config.SETS.items()},
        "seeded_check": seeded_check(kw),
        "loop": loop_results,
        "examples": {"half_refusal": HALF_REFUSAL_EXAMPLE},
        "openings": {
            name: [t[:220] for t in first_turns(d).get(OPENINGS_CELL, [])[:4]] for name, d in config.SETS.items()
        },
        "openings_cell": "--".join(OPENINGS_CELL),
        "cost": costs.summary(),
    }
    _write(config.STUDY / "summary.json", summary)
    print("wrote results/study/summary.json")
    for name, r in raters.items():
        o = r["overall"]
        print(f"{name:22} agree {o['agree']}/{o['n']}  false pass {o['false_pass']}  false fail {o['false_fail']}  kappa {o['kappa']}")
    return summary


def add_parser(sub) -> None:
    p = sub.add_parser("study", help="measure the judge, the attacks and a keyword check")
    s = p.add_subparsers(dest="study", required=True)
    q = s.add_parser("keyword")
    q.set_defaults(func=keyword)
    q = s.add_parser("rejudge")
    q.add_argument("--judge", required=True, help="Gemini model id, e.g. gemini-4-argon")
    q.add_argument("--set", choices=list(config.SETS), default="recorded")
    q.add_argument("--live", action="store_true")
    q.set_defaults(func=rejudge)
    q = s.add_parser("diversity")
    q.add_argument("--live", action="store_true")
    q.set_defaults(func=diversity)
    q = s.add_parser("loop")
    q.add_argument("--live", action="store_true")
    q.set_defaults(func=loop)
    q = s.add_parser("analyze")
    q.set_defaults(func=analyze)

