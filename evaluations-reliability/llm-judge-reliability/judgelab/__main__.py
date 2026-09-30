"""Command line: fetch-ragtruth, plan, judge, run-all, analyze, serve.

Judge commands only call a model with --live; without it they print what would run.
"""

import argparse
import sys

import httpx

from judgelab import analyze, config, pipeline, prompts, ragtruth, store
from judgelab.providers import Gemini, Jev, ProviderError


def clients(settings, needed):
    http = httpx.Client(timeout=httpx.Timeout(settings.timeout_s, connect=10), trust_env=False)
    made = {}
    if "gemini" in needed:
        made["gemini"] = Gemini(settings.gemini_key, http, settings.max_retries)
    if "jev" in needed:
        made["jev"] = Jev(settings.typesafe_key, http, settings.max_retries)
    return made


def run_jobs(jobs, items, runs, settings, live):
    pending = [(v, i, r, sum(x["id"] not in store.load_judgments(v, i, r, runs) for x in items)) for v, i, r in jobs]
    if not live:
        for v, i, r, n in pending:
            print(f"  {v:<18} {i:<9} repeat {r}: {n} calls")
        print(f"Dry run: would make {sum(p[3] for p in pending)} calls. Add --live to run them.")
        return 0
    made = clients(settings, {prompts.VARIANTS[v]["provider"] for v, *_ in jobs})
    failed = False
    for v, i, r, _ in pending:
        todo, counts = pipeline.judge(v, i, r, items, made, settings, runs)
        print(f"{v} {i} repeat {r}: {todo} to run, {counts['ok']} succeeded, {counts['error']} failed")
        failed |= bool(counts["error"])
    if failed:
        print("Failed calls are recorded with an error and retried on the next run.")
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="judgelab")
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch-ragtruth", help="Download RAGTruth and build the 120-answer sample")
    fetch.add_argument("--resample", action="store_true", help="Draw a new sample instead of the committed IDs")
    for name, text in (("plan", "Show every call the full experiment makes"),
                       ("run-all", "Run every step of the experiment"),
                       ("analyze", "Write results/<dataset>/report.md and report.json")):
        cmd = sub.add_parser(name, help=text)
        cmd.add_argument("--dataset", default="synthetic", choices=list(config.DATASETS))
        if name == "run-all":
            cmd.add_argument("--live", action="store_true", help="Make paid API calls")
    jdg = sub.add_parser("judge", help="Run one judge variant")
    jdg.add_argument("--dataset", default="synthetic", choices=list(config.DATASETS))
    jdg.add_argument("--variant", required=True, choices=list(prompts.VARIANTS))
    jdg.add_argument("--input", default="original", choices=pipeline.INPUTS)
    jdg.add_argument("--repeats", type=int, default=1, help="Number of repeats (1-10)")
    jdg.add_argument("--split", default="all", choices=["all", "dev", "holdout"])
    jdg.add_argument("--limit", type=int, help="Only the first N answers (for a cost check)")
    jdg.add_argument("--live", action="store_true", help="Make paid API calls")
    srv = sub.add_parser("serve", help="Start the dashboard")
    srv.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)

    if args.command == "fetch-ragtruth":
        path, counts = ragtruth.build(resample=args.resample)
        print(f"Wrote {path} ({sum(counts.values())} answers): {dict(sorted(counts.items()))}")
        return 0

    if args.command == "serve":
        import uvicorn

        from judgelab.web import create_app

        print(f"Dashboard: http://127.0.0.1:{args.port}")
        uvicorn.run(create_app(), host="127.0.0.1", port=args.port, log_level="warning")
        return 0

    settings = config.load_settings()
    cases_path, runs, results = config.paths(args.dataset)
    if not cases_path.exists():
        print("RAGTruth is not downloaded yet. Run: uv run python -m judgelab fetch-ragtruth")
        return 1
    items = store.load_items(cases_path, config.REVIEWS.get(args.dataset))

    if args.command == "plan":
        print(f"{args.dataset}: {len(items)} answers · Gemini judge {settings.gemini_judge_model} · "
              f"Jev {settings.jev_model}\n")
        for v, i, r, purpose in pipeline.experiment(args.dataset):
            print(f"  {v:<18} {i:<9} repeat {r}  {purpose:<27} {len(items):>4} calls")
        print(f"\n  total {len(pipeline.experiment(args.dataset)) * len(items)} calls")
        return 0

    if args.command == "judge":
        if not 1 <= args.repeats <= 10:
            parser.error("--repeats must be between 1 and 10")
        selected = pipeline.select(items, args.split)[: args.limit]
        jobs = [(args.variant, args.input, r) for r in range(1, args.repeats + 1)]
        return run_jobs(jobs, selected, runs, settings, args.live)

    if args.command == "run-all":
        return run_jobs([(v, i, r) for v, i, r, _ in pipeline.experiment(args.dataset)], items, runs, settings, args.live)

    if args.command == "analyze":
        exported = store.export_verdicts(runs)
        if exported:
            print(f"Wrote {exported[1]} verdicts to {exported[0]}")
        result = analyze.analyze(items, runs)
        store.write_json(results / "report.json", result)
        text = analyze.markdown(result)
        (results / "report.md").write_text(text)
        print(text)
        print(f"Wrote {results / 'report.md'} and report.json")
        return 0
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProviderError, RuntimeError, httpx.HTTPError) as error:
        print(f"Error: {error}")
        sys.exit(1)
