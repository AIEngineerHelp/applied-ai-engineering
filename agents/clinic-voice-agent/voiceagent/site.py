"""The deployable demo: a static snapshot of the dashboard plus one function for live calls.

`uv run python -m voiceagent export-site` writes `site/`, ready for `vercel deploy`:

  index.html, assets/      the built dashboard (web/dist)
  data/                    every API response the dashboard reads, saved as files
  api/session.js           the token function for live calls (web/server, bundled)
  vercel.json              rewrites /api/... to data/...

The snapshot is taken by asking the real API (`create_api`) for each response, so it cannot
drift from what `serve` returns. Only simulated calls are included: browser and phone calls
in the local log belong to whoever made them and stay local.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from .api import create_api
from .store import CallStore
from .workflow import ROOT

SITE = ROOT / "site"
WEB_DIST = ROOT / "web" / "dist"
FUNCTION = ROOT / "web" / "dist-api" / "session.js"

# Most specific first: Vercel uses the first rewrite that matches.
REWRITES = [
    ("/api/config", "/data/config.json"),
    ("/api/workflow", "/data/workflow.json"),
    ("/api/simulations", "/data/simulations.json"),
    ("/api/stats", "/data/stats.json"),
    ("/api/webhooks", "/data/webhooks.json"),
    ("/api/faults", "/data/faults.json"),
    ("/api/calls.csv", "/data/calls.csv"),
    ("/api/calls/:id/export", "/data/export/:id.json"),
    ("/api/calls/:id", "/data/calls/:id.json"),
    ("/api/calls", "/data/calls.json"),
]


def _write(path: Path, body: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = body if isinstance(body, str) else json.dumps(body, separators=(",", ":"))
    path.write_text(text)


def export_site(out: Path = SITE, store: CallStore | None = None) -> dict[str, int]:
    missing = [p for p in (WEB_DIST / "index.html", FUNCTION) if not p.exists()]
    if missing:
        raise SystemExit("Build the dashboard and the function first: "
                         "(cd web && npm run build && npm run build:api)")
    client = TestClient(create_api(store or CallStore()))

    def get(path: str, **params: str) -> Any:
        r = client.get(path, params=params)
        r.raise_for_status()
        return r.json() if "json" in r.headers.get("content-type", "") else r.text

    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(WEB_DIST, out)
    data = out / "data"

    config = get("/api/config")
    config.update(hosted=True, gemini_key=True, livekit_url="", livekit_cloud=True,
                  default_pipeline="realtime",
                  tracing={"enabled": False, "content": False, "ui_url": ""})
    _write(data / "config.json", config)
    _write(data / "workflow.json", get("/api/workflow"))
    _write(data / "simulations.json", get("/api/simulations"))
    _write(data / "stats.json", get("/api/stats", source="simulation"))
    _write(data / "calls.csv", get("/api/calls.csv", source="simulation"))
    _write(data / "webhooks.json", {"received": [], "outbox": []})
    _write(data / "faults.json", {"fault": {"mode": "none", "count": 0, "probability": 1,
                                            "path_prefix": "", "latency_ms": 0},
                                  "remaining": 0, "recent": []})

    calls = [c for c in get("/api/calls")["data"] if c["source"] == "simulation"]
    _write(data / "calls.json", {"data": calls})
    for call in calls:
        _write(data / "calls" / f"{call['id']}.json", get(f"/api/calls/{call['id']}"))
        _write(data / "export" / f"{call['id']}.json", get(f"/api/calls/{call['id']}/export"))

    (out / "api").mkdir(exist_ok=True)
    shutil.copy(FUNCTION, out / "api" / "session.js")
    _write(out / "package.json", json.dumps({"private": True, "type": "module"}, indent=2) + "\n")
    _write(out / "vercel.json", json.dumps({
        "rewrites": [{"source": s, "destination": d} for s, d in REWRITES],
        "headers": [
            {"source": "/data/calls.csv", "headers": [
                {"key": "Content-Disposition",
                 "value": 'attachment; filename="calls-simulation.csv"'}]},
            {"source": "/data/export/(.*)", "headers": [
                {"key": "Content-Disposition", "value": "attachment"}]},
        ],
    }, indent=2) + "\n")
    return {"calls": len(calls), "files": sum(1 for p in out.rglob("*") if p.is_file())}
