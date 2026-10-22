from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.clients import gemini_client, jev_client, laya_client
from app.config import get_settings
from app.db import get_db, init_db
from app.models import CaseRun
from app.ratelimit import check_rate_limit
from app.samples import get_sample, public_samples
from app.schemas import CaseOut, HealthResponse, PipelineRequest, PipelineResponse
from app.services.pipeline import run_pipeline

BASE = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE / "templates"))

app = FastAPI(title="ActGate", version="1.0.0", description="Laya + Jev decide, Gemini drafts")
app.mount("/static", StaticFiles(directory=str(BASE / "static")), name="static")


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    settings = get_settings()
    if settings.laya_enabled and settings.laya_preload:
        try:
            laya_client.get_laya_agent()
        except Exception as exc:  # noqa: BLE001
            # Health will show the error; app still serves Jev/Gemini.
            print(f"Laya preload failed: {exc}")


@app.post("/api/laya/load")
def load_laya() -> dict:
    """Force-load Laya into this server process."""
    settings = get_settings()
    if not settings.laya_enabled:
        raise HTTPException(status_code=400, detail="LAYA_ENABLED=false")
    try:
        laya_client.get_laya_agent()
        return {"status": "ready", "laya": laya_client.laya_status()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/", response_class=HTMLResponse)
def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/health", response_model=HealthResponse)
def health(db: Session = Depends(get_db)) -> HealthResponse:
    db_status = "ok"
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        db_status = f"error: {exc}"
    return HealthResponse(
        status="ok" if db_status == "ok" else "degraded",
        database=db_status,
        laya=laya_client.laya_status(),
        jev=jev_client.jev_status(),
        gemini=gemini_client.gemini_status(),
        demo_mode=get_settings().demo_mode,
    )


@app.get("/api/samples")
def samples() -> list[dict]:
    return public_samples()


@app.post("/api/pipeline", response_model=PipelineResponse)
def pipeline(
    payload: PipelineRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> PipelineResponse:
    settings = get_settings()
    subject = payload.subject
    body = payload.body
    force_jev = payload.force_jev
    skip_draft = payload.skip_draft
    source = payload.source

    if settings.demo_mode:
        limited = check_rate_limit(request.client.host if request.client else "unknown")
        if limited:
            raise HTTPException(status_code=429, detail=limited)
        sample = get_sample(payload.sample_id or "")
        if sample is None:
            raise HTTPException(
                status_code=400,
                detail="Pick one of the sample tickets. This public demo does not accept custom messages.",
            )
        subject = sample["subject"]
        body = sample["body"]
        force_jev = bool(sample.get("force_jev"))
        skip_draft = bool(sample.get("skip_draft"))
        source = "public_demo"
    elif not (body or "").strip():
        raise HTTPException(status_code=400, detail="Message body is required.")

    result = run_pipeline(
        db,
        subject=subject,
        body=body,
        source=source,
        force_jev=force_jev,
        skip_draft=skip_draft,
    )
    return PipelineResponse(**result)


@app.get("/api/cases", response_model=list[CaseOut])
def list_cases(limit: int = 20, db: Session = Depends(get_db)) -> list[CaseOut]:
    rows = db.query(CaseRun).order_by(CaseRun.id.desc()).limit(min(limit, 100)).all()
    out: list[CaseOut] = []
    for r in rows:
        out.append(
            CaseOut(
                id=r.id,
                created_at=r.created_at.isoformat() if r.created_at else None,
                subject=r.subject,
                intent=r.intent,
                gate_decision=r.gate_decision,
                goal_reached=r.goal_reached,
                timing_json=r.timing_json,
                draft=r.draft,
            )
        )
    return out


@app.get("/api/cases/{case_id}")
def get_case(case_id: int, db: Session = Depends(get_db)) -> dict:
    row = db.get(CaseRun, case_id)
    if not row:
        raise HTTPException(status_code=404, detail="Case not found")
    return {
        "id": row.id,
        "subject": row.subject,
        "body": row.body,
        "intent": row.intent,
        "urgency": row.urgency,
        "risk": row.risk,
        "confidence": row.confidence,
        "gate_decision": row.gate_decision,
        "goal_reached": row.goal_reached,
        "draft": row.draft,
        "timing": row.timing_json,
        "answers": row.answers_json,
        "error": row.error,
        "used_laya": row.used_laya,
        "used_jev": row.used_jev,
        "used_gemini": row.used_gemini,
    }


def run() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.app_host,
        port=settings.app_port,
        reload=False,
    )


if __name__ == "__main__":
    run()
