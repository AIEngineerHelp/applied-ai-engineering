"""GraphStore against a real Neo4j (testcontainers). Skipped without Docker."""
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest

from src.ira.knowledge.extract import build_graph
from src.ira.knowledge.store import GraphStore
from tests.integration.test_pg_store import _docker_available

pytestmark = pytest.mark.skipif(not _docker_available(), reason="Docker not available")


@pytest.fixture(scope="module")
def neo4j_url() -> Iterator[str]:
    from testcontainers.neo4j import Neo4jContainer

    with Neo4jContainer("neo4j:5.26-community", password="testpassword") as c:
        yield c.get_connection_url()


@pytest.fixture
async def store(neo4j_url: str) -> AsyncIterator[GraphStore]:
    from neo4j import AsyncGraphDatabase

    driver = AsyncGraphDatabase.driver(neo4j_url, auth=("neo4j", "testpassword"),
                                       notifications_min_severity="OFF")
    yield GraphStore(driver)
    await driver.close()


async def test_load_query_and_record_incident(store: Any) -> None:
    graph = build_graph(["BGL", "OpenSSH"])
    stats = await store.load(graph)
    assert stats["nodes"] == len(graph.nodes) and await store.count() == len(graph.nodes)
    await store.load(graph)  # idempotent re-load
    assert await store.count() == len(graph.nodes)

    view = await store.dataset_view("BGL", limit=60)
    keys = {n["key"] for n in view["nodes"]}
    assert "BGL:Host:R30-M0-N9-C:J16-U01" in keys and "BGL:Rack:R30" in keys  # + ancestors
    assert view["truncated"] and view["edges"]

    hood = await store.neighborhood("OpenSSH:User:root")
    assert hood is not None and "OpenSSH:IP:183.62.140.253" in {n["key"] for n in hood["nodes"]}
    assert next(n["key"] for n in await store.search("R30-M0-N9")).startswith("BGL:")

    await store.record_incident(
        incident_id="inc-1", title="Node R30 errors", dataset="BGL", severity="sev2",
        status="reported", alerted_node="R30-M0-N9-C:J16-U01",
        root_cause="R30-M0-N9-C:J16-U01 (kernel)", fault_type="kernel", confidence=0.9,
        verified=False)
    inc = await store.neighborhood("global:Incident:inc-1")
    assert inc is not None
    rels = {(e["type"], e["target"]) for e in inc["edges"]}
    assert ("ROOT_CAUSE", "BGL:Host:R30-M0-N9-C:J16-U01") in rels  # resolved to known host
    assert ("ALERTED_ON", "BGL:Host:R30-M0-N9-C:J16-U01") in rels
    assert ("HAS_FAULT", "global:FaultType:kernel") in rels
    await store.load(build_graph(["BGL"]))  # rebuilding logs keeps incidents
    assert await store.neighborhood("global:Incident:inc-1") is not None
    assert next(o for o in await store.overview() if o["dataset"] == "BGL")["incidents"] == 1


async def test_root_cause_never_resolves_to_an_attacker_username(store: Any) -> None:
    await store.load(build_graph(["OpenSSH"]))
    await store.record_incident(
        incident_id="inc-ssh", title="SSH brute force", dataset="OpenSSH", severity="sev2",
        status="reported", alerted_node=None, root_cause="sshd", fault_type="auth-failure",
        confidence=0.9, verified=False)
    hood = await store.neighborhood("global:Incident:inc-ssh")
    [cause] = [e["target"] for e in hood["edges"] if e["type"] == "ROOT_CAUSE"]
    assert cause == "OpenSSH:Component:sshd"  # not OpenSSH:User:sshd


async def test_investigation_context_for_alerted_node(store: Any) -> None:
    from src.ira.knowledge.store import investigation_context

    await store.load(build_graph(["BGL"]))
    await store.record_incident(
        incident_id="inc-ctx", title="R30 errors", dataset="BGL", severity="sev2",
        status="reported", alerted_node="R30-M0-N9-C:J16-U01", root_cause="R30-M0-N9-C:J16-U01",
        fault_type="kernel", confidence=0.9, verified=False)
    ctx = await investigation_context(store, "BGL", ["R30-M0-N9-C:J16-U01", "bgl-compute"],
                                      include_history=False)
    [node] = ctx["alerted_entities"]
    assert node["location"] == ["Rack R30", "Midplane R30-M0", "NodeCard R30-M0-N9"]
    assert node["error_lines"] == 60 and node["components"][0]["component"] == "KERNEL"
    assert "past_incidents" not in node  # evals must not see earlier answers
    assert ctx["dataset_hosts"]["hosts_with_errors"] > 0
    with_history = await investigation_context(store, "BGL", ["R30-M0-N9-C:J16-U01"])
    assert with_history["alerted_entities"][0]["past_incidents"][0]["fault"] == "kernel"
    assert await investigation_context(store, None, ["x"]) is None
