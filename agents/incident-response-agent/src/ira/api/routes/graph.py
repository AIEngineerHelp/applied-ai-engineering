from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query

from src.ira.api.auth import Principal, require
from src.ira.api.services import ServicesDep
from src.ira.knowledge.store import GraphStore

router = APIRouter()
Viewer = Annotated[Principal, require("viewer")]


def _graph(services: Any) -> GraphStore:
    graph: GraphStore | None = services.infra.graph
    if graph is None:
        raise HTTPException(
            status_code=503,
            detail="Knowledge graph is off. Set NEO4J_ENABLED=true and start Neo4j "
                   "(docker compose up -d neo4j).")
    return graph


async def _call(coro: Any) -> Any:
    try:
        return await coro
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - Neo4j down/unreachable
        raise HTTPException(status_code=503,
                            detail=f"Knowledge graph unavailable: {type(e).__name__}") from None


@router.get("/graph/overview")
async def overview(services: ServicesDep, _: Viewer) -> dict[str, Any]:
    graph = _graph(services)
    return {"datasets": await _call(graph.overview())}


@router.get("/graph")
async def dataset_graph(
    services: ServicesDep, _: Viewer, dataset: Annotated[str, Query(max_length=64)],
    limit: Annotated[int, Query(ge=10, le=400)] = 150,
) -> dict[str, Any]:
    result: dict[str, Any] = await _call(_graph(services).dataset_view(dataset, limit))
    if not result["nodes"]:
        raise HTTPException(status_code=404, detail=f"No graph for dataset {dataset!r}")
    return result


@router.get("/graph/node")
async def node_neighborhood(
    services: ServicesDep, _: Viewer, key: Annotated[str, Query(max_length=300)],
    limit: Annotated[int, Query(ge=10, le=300)] = 120,
) -> dict[str, Any]:
    result = await _call(_graph(services).neighborhood(key, limit))
    if result is None:
        raise HTTPException(status_code=404, detail="Unknown graph node")
    return dict(result)


@router.get("/graph/search")
async def search(
    services: ServicesDep, _: Viewer, q: Annotated[str, Query(min_length=2, max_length=100)],
) -> list[dict[str, Any]]:
    return list(await _call(_graph(services).search(q)))
