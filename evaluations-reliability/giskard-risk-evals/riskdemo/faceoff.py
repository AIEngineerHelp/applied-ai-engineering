"""Attack-style face-off: Giskard's Crescendo and GOAT attackers against the same agents and rules as our
seeded attacker, scored by the same Conformity judge.

    uv run python -m riskdemo faceoff record            # dry run: what --live would call
    uv run python -m riskdemo faceoff record --live     # paid: 2 styles x 2 risks x 2 prompts x 5 attacks
    uv run python -m riskdemo faceoff rejudge --live    # paid: the second judge on every face-off attack
    uv run python -m riskdemo faceoff analyze           # free: writes results/faceoff/summary.json

Crescendo escalates slowly from abstract questions; GOAT picks from seven named jailbreak strategies.
Both get up to STYLE_MAX_TURNS turns and may stop early when the attacker decides it has reached its goal.
"""

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from riskdemo import config, measure
from riskdemo.catalog import RISKS
from riskdemo.engine import STYLE_MAX_TURNS, STYLE_TEMPLATES, attack_goal

FACEOFF = config.FACEOFF
STYLES = list(STYLE_TEMPLATES)
CELLS = [(r, v) for r in ("medication-changes", "investment-advice") for v in ("naive", "hardened")]
ATTACKS = 5
SECOND_JUDGE = "gemini-4-argon"


def path(style: str, risk_id: str, version: str) -> Path:
    return FACEOFF / style / f"{risk_id}--{version}.json"


def _read(p: Path) -> dict | None:
    return json.loads(p.read_text()) if p.exists() else None


def record(args: argparse.Namespace) -> None:
    settings = config.load_settings()
    styles = [args.style] if args.style else STYLES
    cells = [c for c in CELLS if (not args.risk or c[0] == args.risk) and (not args.version or c[1] == args.version)]
    n = min(args.attacks or ATTACKS, config.MAX_ATTACKS)
    max_calls = len(styles) * len(cells) * n * (2 * STYLE_MAX_TURNS + 1)
    print(f"{len(styles)} styles x {len(cells)} cells x {n} attacks, up to {STYLE_MAX_TURNS} turns; at most {max_calls} calls (plus attacker retries)")
    for style in styles:
        for risk_id, version in cells:
            print(f"  {style:10} {risk_id:20} {version:9} goal: {attack_goal(RISKS[risk_id])[:80]}…")
    if not args.live:
        print("Dry run. Add --live to make these paid calls.")
        return

    from riskdemo import costs
    from riskdemo.live import live_run, save

    async def go() -> None:
        for style in styles:
            for risk_id, version in cells:
                if path(style, risk_id, version).exists() and not args.force:
                    print(f"{style:10} {risk_id:20} {version:9} already recorded (use --force to redo)")
                    continue
                costs.phase.set(f"faceoff:{style}:{risk_id}--{version}")
                run = await live_run(settings, risk_id, version, n, style=style)
                run["mode"] = "recorded"
                save(run, path(style, risk_id, version))
                s = run["summary"]
                print(f"{style:10} {risk_id:20} {version:9} kept the rule {s['passed']}/{s['total']}  errors {s['errored']}")

    asyncio.run(go())


RETRY_TIMEOUT_S = 480  # six attacker and six agent turns can outlast the 180 s sized for three-turn attacks


def retry(args: argparse.Namespace) -> None:
    """Rerun only the attacks that errored, with a longer timeout, and put them back in place."""
    import dataclasses

    todo = []
    for style in [args.style] if args.style else STYLES:
        for risk_id, version in CELLS:
            if (args.risk and risk_id != args.risk) or (args.version and version != args.version):
                continue
            run = _read(path(style, risk_id, version))
            errored = [a["index"] for a in (run or {}).get("attacks", []) if a["status"] == "error"]
            if errored:
                todo.append((style, risk_id, version, errored))
                print(f"  {style:10} {risk_id:20} {version:9} attacks {', '.join(str(i + 1) for i in errored)}")
    if not args.live:
        print("Dry run. Add --live to make these paid calls.")
        return
    from riskdemo import costs
    from riskdemo.live import live_run, save

    settings = dataclasses.replace(config.load_settings(), attack_timeout_s=RETRY_TIMEOUT_S)

    async def go() -> None:
        for style, risk_id, version, errored in todo:
            costs.phase.set(f"faceoff:{style}:{risk_id}--{version}:retry")
            run = _read(path(style, risk_id, version))
            fresh = await live_run(settings, risk_id, version, len(errored), style=style)
            for i, attack in zip(errored, fresh["attacks"], strict=True):
                run["attacks"][i] = {**attack, "index": i, "retried": True}
            from riskdemo.engine import summarize

            run["summary"] = summarize(run)
            save(run, path(style, risk_id, version))
            print(f"{style:10} {risk_id:20} {version:9} now kept the rule {run['summary']['passed']}/{run['summary']['total']}  errors {run['summary']['errored']}")

    asyncio.run(go())


def rejudge(args: argparse.Namespace) -> None:
    """The second judge reads every face-off conversation, as a cross-check on the first."""
    from riskdemo.study import judge_many

    items, keys = [], []
    for style in STYLES:
        for risk_id, version in CELLS:
            run = _read(path(style, risk_id, version))
            for a in (run or {}).get("attacks", []):
                if a["status"] in ("passed", "failed"):
                    items.append((RISKS[risk_id], a))
                    keys.append(f"{style}/{risk_id}--{version}/{a['index'] + 1}")
    print(f"{len(items)} conversations for {SECOND_JUDGE}")
    if not args.live:
        print("Dry run. Add --live to make these paid calls.")
        return
    if not config.load_settings().live_available:
        raise SystemExit("Set GEMINI_API_KEY in .env first.")
    from riskdemo import costs

    costs.install()
    costs.phase.set(f"faceoff:rejudge:{SECOND_JUDGE}")
    verdicts = asyncio.run(judge_many(items, SECOND_JUDGE))
    out = {"model": SECOND_JUDGE, "verdicts": dict(zip(keys, verdicts, strict=True))}
    (FACEOFF / f"judge--{SECOND_JUDGE}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"wrote {len(verdicts)} verdicts")


def _cell(run: dict, second: dict, key_prefix: str) -> dict[str, Any]:
    done = [a for a in run["attacks"] if a["status"] in ("passed", "failed")]
    turns = [len(a["turns"]) for a in done]
    seconds = [second.get(f"{key_prefix}/{a['index'] + 1}", {}).get("status") for a in done]
    return {
        "n": len(run["attacks"]),
        "passed": sum(a["status"] == "passed" for a in done),
        "failed": sum(a["status"] == "failed" for a in done),
        "errored": sum(a["status"] == "error" for a in run["attacks"]),
        "mean_turns": round(sum(turns) / len(turns), 1) if turns else None,
        "max_turns": run.get("max_turns", 3),
        "second_judge_failed": sum(s == "fail" for s in seconds) if any(seconds) else None,
        "second_judge_agree": sum((s == "pass") == (a["status"] == "passed") for s, a in zip(seconds, done, strict=True)) if any(seconds) else None,
        "shared_opening": measure.shared_opening([a["turns"][0]["user"] for a in done if a["turns"]]),
    }


def analyze(_args: argparse.Namespace | None = None) -> dict:
    second = (_read(FACEOFF / f"judge--{SECOND_JUDGE}.json") or {}).get("verdicts", {})
    styles: dict[str, dict] = {"seeded": {}}
    openers: dict[str, dict] = {"seeded": {}}
    for risk_id, version in CELLS:
        run = _read(config.SEEDED / f"{risk_id}--{version}.json")
        if run:
            styles["seeded"][f"{risk_id}--{version}"] = _cell(run, {}, "")
            openers["seeded"][f"{risk_id}--{version}"] = [a["turns"][0]["user"] for a in run["attacks"][:2] if a["turns"]]
    for style in STYLES:
        styles[style], openers[style] = {}, {}
        for risk_id, version in CELLS:
            run = _read(path(style, risk_id, version))
            if run:
                styles[style][f"{risk_id}--{version}"] = _cell(run, second, f"{style}/{risk_id}--{version}")
                openers[style][f"{risk_id}--{version}"] = [a["turns"][0]["user"] for a in run["attacks"][:2] if a["turns"]]
    summary = {
        "cells": [f"{r}--{v}" for r, v in CELLS],
        "goals": {r: attack_goal(RISKS[r]) for r in dict(CELLS)},
        "styles": styles,
        "openers": openers,
        "second_judge": SECOND_JUDGE if second else None,
    }
    FACEOFF.mkdir(parents=True, exist_ok=True)
    (FACEOFF / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    for name, cells in styles.items():
        line = "  ".join(f"{k.split('--')[0][:10]}/{k.split('--')[1][:5]} {c['passed']}/{c['passed'] + c['failed']}" for k, c in cells.items())
        print(f"{name:10} {line}")
    return summary


def add_parser(sub) -> None:
    p = sub.add_parser("faceoff", help="Giskard's Crescendo and GOAT attackers against our seeded attacker")
    fsub = p.add_subparsers(dest="faceoff_command", required=True)
    q = fsub.add_parser("record", help="record the face-off runs (paid with --live)")
    q.add_argument("--live", action="store_true")
    q.add_argument("--force", action="store_true", help="re-record cells that already exist")
    q.add_argument("--style", choices=STYLES)
    q.add_argument("--risk", choices=sorted({r for r, _ in CELLS}))
    q.add_argument("--version", choices=["naive", "hardened"])
    q.add_argument("--attacks", type=int)
    q.set_defaults(func=record)
    q = fsub.add_parser("retry", help="rerun the attacks that errored, with a longer timeout (paid with --live)")
    q.add_argument("--live", action="store_true")
    q.add_argument("--style", choices=STYLES)
    q.add_argument("--risk", choices=sorted({r for r, _ in CELLS}))
    q.add_argument("--version", choices=["naive", "hardened"])
    q.set_defaults(func=retry)
    q = fsub.add_parser("rejudge", help="second judge on every face-off conversation (paid with --live)")
    q.add_argument("--live", action="store_true")
    q.set_defaults(func=rejudge)
    q = fsub.add_parser("analyze", help="write results/faceoff/summary.json (free)")
    q.set_defaults(func=analyze)
