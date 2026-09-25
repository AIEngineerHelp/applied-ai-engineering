import asyncio
from functools import lru_cache
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query

from src.ira.api.auth import Principal, require
from src.ira.tools.log_explorer.catalog import DatasetCatalog, DatasetNotFoundError

router = APIRouter()
Viewer = Annotated[Principal, require("viewer")]


@lru_cache(maxsize=1)
def catalog() -> DatasetCatalog:
    return DatasetCatalog()


def _not_found(name: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"Unknown dataset {name!r}")


@router.get("/datasets")
async def list_datasets(_: Viewer) -> dict[str, Any]:
    items = await asyncio.to_thread(catalog().all)
    return {"citation": catalog().citation, "datasets": items}


@router.get("/datasets/{name}")
async def get_dataset(name: str, _: Viewer) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(catalog().summary, name)
    except DatasetNotFoundError:
        raise _not_found(name) from None


@router.get("/datasets/{name}/logs")
async def get_logs(
    name: str,
    _: Viewer,
    q: Annotated[str | None, Query(max_length=200)] = None,
    event_id: Annotated[str | None, Query(max_length=32)] = None,
    level: Annotated[str | None, Query(max_length=32)] = None,
    component: Annotated[str | None, Query(max_length=128)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            catalog().logs, name, q, event_id, level, component, offset, limit)
    except DatasetNotFoundError:
        raise _not_found(name) from None


@router.get("/datasets/{name}/templates")
async def get_templates(
    name: str, _: Viewer, q: Annotated[str | None, Query(max_length=200)] = None,
) -> list[dict[str, Any]]:
    try:
        return await asyncio.to_thread(catalog().templates, name, q)
    except DatasetNotFoundError:
        raise _not_found(name) from None
