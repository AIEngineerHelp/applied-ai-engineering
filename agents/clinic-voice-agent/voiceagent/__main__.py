"""Command line: `uv run python -m voiceagent <command>`.

  serve            dashboard, API, mock CRM and webhook receiver on one port
  crm              the mock CRM alone
  simulate         run the simulated callers (add --live to use Gemini; paid)
  retry-webhooks   redeliver post-call webhooks that failed

The voice agent itself runs separately: `uv run python -m voiceagent.worker dev`.
"""

from __future__ import annotations

import argparse
import asyncio
import sys


def main() -> None:
    parser = argparse.ArgumentParser(prog="voiceagent")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve")
    crm = sub.add_parser("crm")
    crm.add_argument("--port", type=int, default=4332)
    sim = sub.add_parser("simulate")
    sim.add_argument("--live", action="store_true", help="use Gemini as the model (paid)")
    sim.add_argument("--fixed-callers", action="store_true",
                     help="with --live, callers read fixed lines instead of a model playing them")
    sim.add_argument("--only", nargs="*", help="scenario names to run")
    sub.add_parser("retry-webhooks")
    args = parser.parse_args()

    if args.command == "serve":
        import uvicorn

        from .api import create_api
        from .config import settings

        cfg = settings()
        uvicorn.run(create_api(), host=cfg.host, port=cfg.port, log_level="info")
    elif args.command == "crm":
        import uvicorn

        from .crm.server import create_app

        uvicorn.run(create_app(), host="127.0.0.1", port=args.port)
    elif args.command == "simulate":
        sys.exit(asyncio.run(simulate(args.live, not args.fixed_callers, args.only)))
    elif args.command == "retry-webhooks":
        asyncio.run(retry_webhooks())


async def simulate(live: bool, model_callers: bool, only: list[str] | None) -> int:
    from .config import settings
    from .simulation import run_all

    if live and not settings().gemini_api_key:
        print("--live needs GEMINI_API_KEY in the environment or .env")
        return 2
    if live:
        who = f"; callers played by {settings().caller_model}" if model_callers else ""
        print(f"Live simulation: paid calls to {settings().cascade_llm}{who}.")
    report = await run_all(live=live, model_callers=model_callers, only=only)
    for r in report["results"]:
        mark = "PASS" if r["passed"] else "FAIL"
        print(f"{mark}  {r['scenario']:<34} {r['seconds']:>6.2f}s")
        for c in r["checks"]:
            if not c["passed"]:
                print(f"        x {c['check']}: {c['detail']}")
    print(f"\n{report['passed']}/{report['total']} scenarios passed ({report['mode']})")
    if live:
        print(f"Cost: agent ${report['agent_cost_usd']}, callers ${report['caller_cost_usd']}")
    return 0 if report["passed"] == report["total"] else 1


async def retry_webhooks() -> None:
    from .postcall import deliver_webhook
    from .store import CallStore

    store = CallStore()
    pending = store.outbox_pending()
    for row in pending:
        ok = await deliver_webhook(store, row["call_id"], row["payload"])
        print(f"{'delivered' if ok else 'failed   '}  {row['call_id']}")
    if not pending:
        print("No undelivered webhooks.")


if __name__ == "__main__":
    main()
