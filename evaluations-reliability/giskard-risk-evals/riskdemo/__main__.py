"""Command line: `serve` the app, or `record` the example runs the app replays.

    uv run python -m riskdemo serve            # http://127.0.0.1:4330, no key needed for recorded runs
    uv run python -m riskdemo record           # dry run: prints what --live would call
    uv run python -m riskdemo record --live    # paid: runs every risk x prompt version with Gemini
"""

import argparse
import asyncio

from riskdemo import config
from riskdemo.catalog import RISKS, VERSIONS
from riskdemo.engine import ATTACKER_MAX_TURNS


def record(args: argparse.Namespace) -> None:
    settings = config.load_settings()
    risks = [args.risk] if args.risk else list(RISKS)
    versions = [args.version] if args.version else list(VERSIONS)
    n = min(args.attacks or settings.attacks_per_run, config.MAX_ATTACKS)
    combos = [(r, v) for r in risks for v in versions]
    max_calls = len(combos) * n * (2 * ATTACKER_MAX_TURNS + 1)
    print(f"{len(combos)} runs x {n} attacks; at most {max_calls} model calls")
    print(f"agent {settings.agent_model}, attacker {settings.attacker_model}, judge {settings.judge_model}")
    target = config.SETS[args.set]
    print(f"recording set: {args.set} -> {target.relative_to(config.ROOT)}")
    for risk_id, version in combos:
        print(f"  {risk_id:22} {version}")
    if not args.live:
        print("Dry run. Add --live to make these paid calls.")
        return

    from riskdemo import costs
    from riskdemo.live import live_run, save

    async def go() -> None:
        for risk_id, version in combos:
            costs.phase.set(f"record:{args.set}:{risk_id}--{version}")
            run = await live_run(settings, risk_id, version, n, seeded=args.set == "seeded")
            run["mode"] = "recorded"
            save(run, target / f"{risk_id}--{version}.json")
            s = run["summary"]
            print(f"{risk_id:22} {version:9} passed {s['passed']}/{s['total']}  errors {s['errored']}")

    asyncio.run(go())


def serve(args: argparse.Namespace) -> None:
    import uvicorn

    uvicorn.run("riskdemo.web:app", host=args.host, port=args.port, log_level="warning")


def main() -> None:
    parser = argparse.ArgumentParser(prog="riskdemo")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("serve", help="run the demo app")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=4330)
    p.set_defaults(func=serve)
    p = sub.add_parser("record", help="record the example runs the app replays")
    p.add_argument("--live", action="store_true", help="make paid Gemini calls")
    p.add_argument("--risk", choices=list(RISKS))
    p.add_argument("--version", choices=list(VERSIONS))
    p.add_argument("--attacks", type=int)
    p.add_argument("--set", choices=list(config.SETS), default="seeded", help="which recording set to write")
    p.set_defaults(func=record)
    from riskdemo import export, faceoff, study

    study.add_parser(sub)
    faceoff.add_parser(sub)
    export.add_parser(sub)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
