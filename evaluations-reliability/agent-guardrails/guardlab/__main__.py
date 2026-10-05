"""Command line: plan, classify, agent, analyze, show.

Anything that calls a model is a dry run unless you pass --live.
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor

import httpx

from guardlab import agent, classifiers, config, evaluate, report, rules
from guardlab.providers import Gemini, Jev, ProviderError

PROVIDERS = ("jev", "gemini")


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def append_jsonl(path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def make_clients(settings):
    http = httpx.Client(timeout=httpx.Timeout(settings.timeout_s, connect=10), trust_env=False)
    made = {}
    if settings.gemini_key:
        made["gemini"] = Gemini(settings.gemini_key, http, settings.max_retries)
    if settings.typesafe_key:
        made["jev"] = Jev(settings.typesafe_key, http, settings.max_retries)
    return made


def message_classifier(provider, clients, settings):
    if provider == "gemini":
        return lambda text: classifiers.gemini_message(clients["gemini"], settings.gemini_model, text)
    return lambda text: classifiers.jev_message(clients["jev"], settings.jev_model, text)


def document_classifier(provider, clients, settings):
    if provider == "gemini":
        return lambda text: classifiers.gemini_document(clients["gemini"], settings.gemini_model, text)
    return lambda text: classifiers.jev_document(clients["jev"], settings.jev_model, text)


def require(clients, names):
    missing = [n for n in names if n not in clients]
    if missing:
        keys = {"gemini": "GEMINI_API_KEY", "jev": "TYPESAFE_API_KEY"}
        raise ProviderError("Set " + " and ".join(keys[n] for n in missing) + " in .env for live calls.")


def cmd_classify(args, settings):
    messages = read_jsonl(config.MESSAGES)[: args.limit]
    providers = PROVIDERS if args.provider == "all" else (args.provider,)
    for provider in providers:
        path = config.RUNS / "classify" / f"{provider}.jsonl"
        done = {r["id"] for r in read_jsonl(path) if "error" not in r}
        todo = [m for m in messages if m["id"] not in done]
        if not args.live:
            print(f"  {provider:<7} {len(todo)} of {len(messages)} messages to classify")
            continue
        clients = make_clients(settings)
        require(clients, [provider])
        classify = message_classifier(provider, clients, settings)

        def one(m):
            try:
                verdict, usage = classify(m["text"])
                return {"id": m["id"], "verdict": verdict, "usage": usage}
            except ProviderError as error:
                return {"id": m["id"], "error": str(error)}

        with ThreadPoolExecutor(max_workers=settings.max_workers) as pool:
            rows = list(pool.map(one, todo))
        for row in rows:
            append_jsonl(path, row)
        errors = sum("error" in r for r in rows)
        print(f"{provider}: classified {len(rows) - errors}, failed {errors}. Failed messages retry on the next run.")
    if not args.live:
        print("Dry run: one call per message per provider. Add --live to make them.")
    return 0


def agent_runs(model, classifier):
    return config.RUNS / "agent" / f"{model}+{classifier}"


def cmd_agent(args, settings):
    scenarios = [s for s in read_jsonl(config.SCENARIOS) if not args.only or s["id"] in args.only]
    store_data = json.loads(config.STORE.read_text())
    configs = list(agent.CONFIGS) if args.config == "all" else [args.config]
    needs_model_layers = args.classifier != "none"
    live = args.model == "gemini" or needs_model_layers
    if live and not args.live:
        layers_calls = len(scenarios) * len(configs)
        print(f"Dry run: {len(scenarios)} scenarios x {len(configs)} configurations = {layers_calls} runs "
              f"(model {args.model}, classifier {args.classifier}). Gemini agent runs take several calls each. "
              "Add --live to run them.")
        return 0
    clients = make_clients(settings) if live else {}
    if live:
        require(clients, ([] if args.model == "scripted" else ["gemini"]) + ([args.classifier] if needs_model_layers else []))
    out = agent_runs(args.model, args.classifier)
    for name in configs:
        layers = agent.CONFIGS[name]
        if not needs_model_layers:
            # Without a classifier the detection layers are rules only.
            layers = tuple(layer for layer in layers if layer not in ("input_model", "doc_scan"))
        path = out / f"{name}.jsonl"
        done = {r["id"] for r in read_jsonl(path) if "error" not in r} if live else set()
        if not live and path.exists():
            path.unlink()  # scripted runs are free and deterministic; always recompute
        for s in scenarios:
            if s["id"] in done:
                continue
            model = (agent.ScriptedModel(s["script"]) if args.model == "scripted"
                     else agent.GeminiModel(clients["gemini"], settings.gemini_model))
            try:
                trace = agent.run(
                    s, store_data, layers, model,
                    input_classifier=message_classifier(args.classifier, clients, settings) if needs_model_layers else None,
                    doc_classifier=document_classifier(args.classifier, clients, settings) if needs_model_layers else None,
                )
            except ProviderError as error:
                append_jsonl(path, {"id": s["id"], "error": str(error)})
                print(f"  {name} {s['id']}: failed ({error})")
                continue
            append_jsonl(path, {"id": s["id"], "layers": list(layers), "trace": trace,
                                "score": evaluate.score(s, trace, store_data)})
        rows = [r for r in read_jsonl(path) if "score" in r]
        summary = evaluate.agent_summary([r["score"] for r in rows])
        a = summary["attack_success"]
        print(f"  {name:<10} layers={','.join(layers) or '-':<55} attacks succeeded {a['hits']}/{a['n']}  "
              f"benign {summary['benign_outcomes']}")
    return 0


def cmd_show(args):
    """Print one scenario's full trace: what the user said, each call and decision, and the reply."""
    scenario = next((s for s in read_jsonl(config.SCENARIOS) if s["id"] == args.id), None)
    if scenario is None:
        print(f"No scenario {args.id}")
        return 1
    path = agent_runs(args.model, args.classifier) / f"{args.config}.jsonl"
    row = next((r for r in read_jsonl(path) if r["id"] == args.id and "trace" in r), None)
    if row is None:
        print(f"No run yet. Try: uv run python -m guardlab agent --model {args.model} --classifier {args.classifier}")
        return 1
    print(report.trace_markdown(scenario, row))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="guardlab")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan", help="Show every run and API call the full experiment makes")
    cls = sub.add_parser("classify", help="Experiment 1: input classifiers on the labeled messages")
    cls.add_argument("--provider", default="all", choices=["all", *PROVIDERS])
    cls.add_argument("--limit", type=int, help="Only the first N messages (for a cost check)")
    cls.add_argument("--live", action="store_true", help="Make paid API calls")
    agt = sub.add_parser("agent", help="Experiment 2: the agent under each guardrail configuration")
    agt.add_argument("--model", default="scripted", choices=["scripted", "gemini"],
                     help="scripted plays a fully hijacked model (free); gemini is a real model (paid)")
    agt.add_argument("--classifier", default="none", choices=["none", *PROVIDERS],
                     help="Classifier for the input and document-scan layers; none keeps only the rules")
    agt.add_argument("--config", default="all", choices=["all", *agent.CONFIGS])
    agt.add_argument("--only", nargs="*", help="Scenario IDs to run")
    agt.add_argument("--live", action="store_true", help="Make paid API calls")
    sub.add_parser("analyze", help="Write results/report.md and the JSON summaries")
    shw = sub.add_parser("show", help="Print one scenario's trace")
    shw.add_argument("id")
    shw.add_argument("--model", default="scripted", choices=["scripted", "gemini"])
    shw.add_argument("--classifier", default="none", choices=["none", *PROVIDERS])
    shw.add_argument("--config", default="full", choices=list(agent.CONFIGS))
    args = parser.parse_args(argv)
    settings = config.load_settings()

    if args.command == "plan":
        messages, scenarios = read_jsonl(config.MESSAGES), read_jsonl(config.SCENARIOS)
        n, s, c = len(messages), len(scenarios), len(agent.CONFIGS)
        print(f"Gemini {settings.gemini_model} · Jev {settings.jev_model}\n")
        print("Experiment 1: input classifiers")
        print(f"  rules     {n} messages, offline")
        print(f"  jev       {n} calls (three choice questions per call)")
        print(f"  gemini    {n} calls (one structured call per message)")
        print("Experiment 2: agent scenarios")
        print(f"  scripted + none     {s} x {c} runs, offline")
        print(f"  scripted + jev      {s} x {c} runs, classifier calls only (about {s * 2 + 6})")
        print(f"  gemini   + jev      {s} x {c} runs, about 2-4 Gemini calls per run plus classifier calls")
        print("\nRun the offline parts now: uv run python -m guardlab agent && uv run python -m guardlab analyze")
        return 0
    if args.command == "classify":
        return cmd_classify(args, settings)
    if args.command == "agent":
        return cmd_agent(args, settings)
    if args.command == "show":
        return cmd_show(args)
    if args.command == "analyze":
        messages = read_jsonl(config.MESSAGES)
        rule_verdicts = {m["id"]: rules.check(m["text"]) for m in messages}
        model_runs = {p: {r["id"]: r for r in read_jsonl(config.RUNS / "classify" / f"{p}.jsonl") if "verdict" in r}
                      for p in PROVIDERS}
        scenarios, store_data = read_jsonl(config.SCENARIOS), json.loads(config.STORE.read_text())
        by_id = {s["id"]: s for s in scenarios}
        agent_rows = {d.name: {p.stem: read_jsonl(p) for p in sorted(d.glob("*.jsonl"))}
                      for d in sorted((config.RUNS / "agent").glob("*")) if d.is_dir()}
        # Score again from the stored traces, so scoring changes never need new paid runs.
        for configs in agent_rows.values():
            for rows in configs.values():
                for row in rows:
                    if "trace" in row:
                        row["score"] = evaluate.score(by_id[row["id"]], row["trace"], store_data)
        written = report.write(messages, rule_verdicts, model_runs, agent_rows, settings, scenarios, store_data)
        print(f"Wrote {', '.join(str(p.relative_to(config.ROOT)) for p in written)}")
        return 0
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProviderError, httpx.HTTPError) as error:
        print(f"Error: {error}")
        sys.exit(1)
