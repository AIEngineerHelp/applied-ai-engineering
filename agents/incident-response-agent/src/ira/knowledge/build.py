"""Build the knowledge graph from the Loghub files and load it into Neo4j.

    uv run python -m src.ira.knowledge.build              # all datasets
    uv run python -m src.ira.knowledge.build --datasets BGL OpenSSH
    uv run python -m src.ira.knowledge.build --dry-run    # extract and print stats only

Uses NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD from .env. Safe to re-run: each dataset's
log-derived entities are rebuilt; incident nodes are kept.
"""
import argparse
import asyncio
import logging
from collections import Counter
from typing import Any

from src.ira.config import Settings, settings
from src.ira.knowledge.extract import Graph, build_graph
from src.ira.knowledge.store import GraphStore
from src.ira.tools.log_explorer.catalog import DatasetCatalog

logger = logging.getLogger(__name__)


def stats(graph: Graph) -> dict[str, Any]:
    return {
        "nodes": len(graph.nodes),
        "edges": len(graph.edges),
        "kinds": dict(Counter(n.kind for n in graph.nodes.values())),
        "relationships": dict(Counter(rel for _, rel, _ in graph.edges)),
    }


async def build_and_load(
    datasets: list[str] | None = None, config: Settings = settings, driver: Any = None,
) -> dict[str, Any]:
    names = datasets or DatasetCatalog().names()
    graph = await asyncio.to_thread(build_graph, names)
    own_driver = driver is None
    if own_driver:
        from neo4j import AsyncGraphDatabase

        driver = AsyncGraphDatabase.driver(
            config.neo4j_uri, auth=(config.neo4j_user, config.neo4j_password),
            notifications_min_severity="OFF")
    try:
        loaded = await GraphStore(driver).load(graph)
    finally:
        if own_driver:
            await driver.close()
    return {**stats(graph), **loaded}


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the log knowledge graph into Neo4j")
    parser.add_argument("--datasets", nargs="*", help="dataset names (default: all)")
    parser.add_argument("--dry-run", action="store_true", help="extract only; don't load")
    args = parser.parse_args()
    if args.dry_run:
        print(stats(build_graph(args.datasets or DatasetCatalog().names())))
        return
    print(asyncio.run(build_and_load(args.datasets)))


if __name__ == "__main__":
    main()
