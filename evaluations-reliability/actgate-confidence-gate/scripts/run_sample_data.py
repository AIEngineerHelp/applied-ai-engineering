"""
Run sample tickets against a live ActGate server (or in-process pipeline).

Examples:
  python scripts/run_sample_data.py
  python scripts/run_sample_data.py --base-url http://127.0.0.1:8787
  python scripts/run_sample_data.py --ids refund_calm,bug_android --skip-draft
  python scripts/run_sample_data.py --local   # uses DB + pipeline in-process
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "sample_tickets.json"
REPORT = ROOT / "data" / "last_sample_run.json"


def load_samples(ids: list[str] | None) -> list[dict]:
    rows = json.loads(DATA.read_text(encoding="utf-8"))
    if ids:
        wanted = set(ids)
        rows = [r for r in rows if r["id"] in wanted]
    return rows


def run_via_http(base_url: str, samples: list[dict], skip_draft: bool | None) -> list[dict]:
    out = []
    with httpx.Client(base_url=base_url.rstrip("/"), timeout=180.0) as client:
        health = client.get("/api/health")
        health.raise_for_status()
        print("health:", health.json())
        for s in samples:
            payload = {
                "subject": s["subject"],
                "body": s["body"],
                "source": "sample_data",
                "force_jev": bool(s.get("force_jev")),
                "skip_draft": bool(s.get("skip_draft")) if skip_draft is None else skip_draft,
            }
            print(f"\n=== {s['id']} ===")
            print("hint:", s.get("expect_hint"))
            r = client.post("/api/pipeline", json=payload)
            r.raise_for_status()
            data = r.json()
            timing = data.get("timing") or {}
            print(
                f"gate={data.get('gate_decision')} intent={data.get('intent')} "
                f"conf={data.get('confidence')} goal={timing.get('goal_reached')} "
                f"total_ms={timing.get('total_ms')}"
            )
            for step in timing.get("steps") or []:
                print(f"  {step['step']}: {step.get('duration_ms')} ms ok={step.get('ok')}")
            out.append({"sample_id": s["id"], **data})
    return out


def run_local(samples: list[dict], skip_draft: bool | None) -> list[dict]:
    sys.path.insert(0, str(ROOT))
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    from app.db import SessionLocal, init_db
    from app.services.pipeline import run_pipeline

    init_db()
    out = []
    db = SessionLocal()
    try:
        for s in samples:
            print(f"\n=== {s['id']} ===")
            data = run_pipeline(
                db,
                subject=s["subject"],
                body=s["body"],
                source="sample_data",
                force_jev=bool(s.get("force_jev")),
                skip_draft=bool(s.get("skip_draft")) if skip_draft is None else skip_draft,
            )
            timing = data.get("timing") or {}
            print(
                f"gate={data.get('gate_decision')} intent={data.get('intent')} "
                f"goal={timing.get('goal_reached')} total_ms={timing.get('total_ms')}"
            )
            out.append({"sample_id": s["id"], **data})
    finally:
        db.close()
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Run ActGate sample tickets")
    parser.add_argument("--base-url", default="http://127.0.0.1:8787")
    parser.add_argument("--local", action="store_true", help="Run in-process (no HTTP)")
    parser.add_argument("--ids", default="", help="Comma-separated sample ids")
    parser.add_argument(
        "--skip-draft",
        action="store_true",
        help="Force skip Gemini for all samples (faster/cheaper)",
    )
    args = parser.parse_args()
    ids = [x.strip() for x in args.ids.split(",") if x.strip()] or None
    samples = load_samples(ids)
    if not samples:
        print("No samples matched.")
        return 1

    skip = True if args.skip_draft else None
    results = run_local(samples, skip) if args.local else run_via_http(args.base_url, samples, skip)
    REPORT.write_text(json.dumps(results, indent=2, default=str), encoding="utf-8")
    print(f"\nWrote {REPORT}")
    errors = sum(1 for r in results if r.get("gate_decision") == "error")
    return 1 if errors == len(results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
