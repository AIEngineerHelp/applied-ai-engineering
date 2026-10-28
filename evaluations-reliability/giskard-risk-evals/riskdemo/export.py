"""A static, read-only copy of the app for public hosting: `uv run python -m riskdemo export site`.

Every GET endpoint the page reads is written as a JSON file under data/, and the page (marked data-static) reads
those files instead of the API (client/logic.ts staticURL). There is no server, so live runs are off and no
Gemini key or call is involved. Deploy with `cd site && vercel deploy --prod`.
"""

import json
import shutil
from pathlib import Path

from riskdemo import config, web
from riskdemo.catalog import RISKS, VERSIONS

SITE = config.ROOT / "site"


def _write(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))


def export_site(out: Path = SITE) -> int:
    out.mkdir(parents=True, exist_ok=True)
    for old in out.iterdir():  # keep .vercel/, the link to the Vercel project
        if old.name != ".vercel":
            shutil.rmtree(old) if old.is_dir() else old.unlink()
    shutil.copytree(web.STATIC, out / "static", ignore=shutil.ignore_patterns("index.html", "article.html"))
    index = (web.STATIC / "index.html").read_text().replace('<html lang="en">', '<html lang="en" data-static>', 1)
    (out / "index.html").write_text(index)
    shutil.copy(web.STATIC / "article.html", out / "article.html")

    data = out / "data"
    catalog = web.catalog()
    catalog["live"] = {**catalog["live"], "available": False, "busy": False, "hosted": True}
    _write(data / "catalog.json", catalog)
    _write(data / "study.json", web.study())
    _write(data / "runs.json", [])
    files = 3
    for set_name in config.SETS:
        for risk_id in RISKS:
            for version in VERSIONS:
                if web.recorded_path(risk_id, version, set_name).exists():
                    _write(data / "recorded" / set_name / risk_id / f"{version}.json", web.recorded(risk_id, version, set_name))
                    files += 1
    for style in ("crescendo", "goat"):
        for path in sorted((config.FACEOFF / style).glob("*--*.json")):
            risk_id, version = path.stem.split("--")
            _write(data / "faceoff" / style / risk_id / f"{version}.json", json.loads(path.read_text()))
            files += 1
    for path in sorted(config.LOOP.glob("*.json")):
        _write(data / "loop" / path.name, json.loads(path.read_text()))
        files += 1
    (out / "vercel.json").write_text(json.dumps({"cleanUrls": True}, indent=2) + "\n")
    return files


def add_parser(sub) -> None:
    p = sub.add_parser("export", help="write a static, read-only copy of the app for hosting")
    p.add_argument("what", choices=["site"])
    p.add_argument("--out", type=Path, default=SITE)
    p.set_defaults(func=lambda args: print(f"wrote {export_site(args.out)} data files to {args.out}"))
