import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException

from src.ira.api.auth import Principal, require
from src.ira.evals_store import EvalRunNotFoundError, EvalStore

router = APIRouter()
Viewer = Annotated[Principal, require("viewer")]


@router.get("/evals")
async def list_evals(_: Viewer) -> dict[str, Any]:
    store = EvalStore()
    methodology, runs = await asyncio.gather(
        asyncio.to_thread(store.methodology), asyncio.to_thread(store.runs))
    return {"methodology": methodology, "runs": runs}


@router.get("/evals/{run_id}")
async def get_eval(run_id: str, _: Viewer) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(EvalStore().run, run_id)
    except EvalRunNotFoundError:
        raise HTTPException(status_code=404, detail="Eval run not found") from None
