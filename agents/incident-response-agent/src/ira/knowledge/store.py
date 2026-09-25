"""Neo4j storage for the knowledge graph.

Model: every node has the label `Entity` plus its kind (Dataset, Host, Component, ...) and a
unique `key` "<dataset>:<kind>:<name>". Relationships carry a `count` of supporting log lines.
"""
import logging
import re
from collections import defaultdict
from typing import Any

from src.ira.knowledge.extract import Graph

logger = logging.getLogger(__name__)

KINDS = {
    "Dataset", "Component", "EventType", "Host", "Rack", "Midplane", "NodeCard", "IP", "User",
    "Service", "Instance", "RemoteHost", "Incident", "FaultType",
}
RELATIONSHIPS = {
    "HAS_COMPONENT", "EMITS", "RUNS", "CONTAINS", "CONNECTS_TO", "MANAGES", "FAILED_LOGIN",
    "ACCEPTED_LOGIN", "SENDS_BLOCKS", "ABOUT", "ALERTED_ON", "ROOT_CAUSE", "HAS_FAULT",
}
_BATCH = 1000
# Kinds a root-cause component string can resolve to. Users and IPs are actors seen in the
# logs (e.g. an attacker trying the username "sshd"), not system components, so they're
# never matched from free text.
_ROOT_CAUSE_KINDS = ["Host", "NodeCard", "Midplane", "Rack", "Component", "Instance",
                     "RemoteHost", "Service"]


def _safe(name: str, allowed: set[str]) -> str:
    # Labels/relationship types can't be query parameters; only whitelisted names are used.
    if name not in allowed or not re.fullmatch(r"[A-Za-z_]+", name):
        raise ValueError(f"Unexpected graph identifier {name!r}")
    return name


def _node_row(record: Any) -> dict[str, Any]:
    n = record["n"]
    props = dict(n)
    return {
        "key": props.pop("key"), "kind": props.pop("kind", None), "name": props.pop("name", None),
        "dataset": props.pop("dataset", None), "degree": record.get("degree"), "props": props,
    }


class GraphStore:
    def __init__(self, driver: Any):
        self.driver = driver

    async def setup(self) -> None:
        async with self.driver.session() as s:
            await s.run("CREATE CONSTRAINT entity_key IF NOT EXISTS "
                        "FOR (n:Entity) REQUIRE n.key IS UNIQUE")
            await s.run("CREATE INDEX entity_dataset IF NOT EXISTS FOR (n:Entity) ON (n.dataset)")
            await s.run("CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n.name)")

    async def count(self) -> int:
        async with self.driver.session() as s:
            rec = await (await s.run("MATCH (n:Entity) WHERE NOT n:Incident "
                                     "RETURN count(n) AS c")).single()
            return int(rec["c"]) if rec else 0

    async def load(self, graph: Graph, replace: bool = True) -> dict[str, int]:
        """Upsert a graph. With replace=True, log-derived entities of the datasets in the
        graph are rebuilt from scratch (incident nodes are kept)."""
        await self.setup()
        datasets = sorted({n.name for n in graph.nodes.values() if n.kind == "Dataset"})
        async with self.driver.session() as s:
            if replace:
                await s.run("MATCH (n:Entity) WHERE (n.dataset IN $ds OR (n:Dataset AND "
                            "n.name IN $ds)) AND NOT n:Incident DETACH DELETE n", ds=datasets)
            by_kind: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for n in graph.nodes.values():
                by_kind[n.kind].append({"key": n.key, "name": n.name, "dataset": n.dataset,
                                        "props": n.props})
            for kind, rows in by_kind.items():
                label = _safe(kind, KINDS)
                for i in range(0, len(rows), _BATCH):
                    await s.run(
                        f"UNWIND $rows AS r MERGE (n:Entity {{key: r.key}}) SET n:{label}, "
                        "n += r.props, n.name = r.name, n.kind = $kind, n.dataset = r.dataset",
                        rows=rows[i:i + _BATCH], kind=kind)
            by_rel: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for (src, rel, dst), count in graph.edges.items():
                by_rel[rel].append({"s": src, "t": dst, "c": count})
            for rel, rows in by_rel.items():
                rtype = _safe(rel, RELATIONSHIPS)
                for i in range(0, len(rows), _BATCH):
                    await s.run(
                        "UNWIND $rows AS r MATCH (a:Entity {key: r.s}), (b:Entity {key: r.t}) "
                        f"MERGE (a)-[e:{rtype}]->(b) SET e.count = r.c",
                        rows=rows[i:i + _BATCH])
        return {"datasets": len(datasets), "nodes": len(graph.nodes), "edges": len(graph.edges)}

    async def record_incident(
        self, incident_id: str, title: str, dataset: str | None, severity: str, status: str,
        alerted_node: str | None, root_cause: str | None, fault_type: str | None,
        confidence: float | None, verified: bool,
    ) -> None:
        """Attach an investigated incident: what it was about, the entity it alerted on,
        the entity the agent blamed, and the fault type."""
        key = f"global:Incident:{incident_id}"
        async with self.driver.session() as s:
            await s.run(
                "MERGE (i:Entity {key: $key}) SET i:Incident, i.kind = 'Incident', "
                "i.name = $title, i.incident_id = $id, i.severity = $severity, "
                "i.status = $status, i.verified = $verified, i.dataset = $dataset",
                key=key, id=incident_id, title=title, severity=severity, status=status,
                verified=verified, dataset=dataset)
            if dataset:
                await s.run("MATCH (i:Entity {key: $key}), (d:Entity {key: $d}) "
                            "MERGE (i)-[:ABOUT]->(d)", key=key, d=f"global:Dataset:{dataset}")
            if dataset and alerted_node:
                await s.run("MATCH (i:Entity {key: $key}) MATCH (h:Entity {dataset: $ds}) "
                            "WHERE h.name = $node MERGE (i)-[:ALERTED_ON]->(h)",
                            key=key, ds=dataset, node=alerted_node)
            if root_cause:
                # Resolve the agent's free-text component to a known entity when possible,
                # preferring the most specific kind and the longest matching name.
                rec = await (await s.run(
                    "MATCH (e:Entity) WHERE e.dataset = $ds AND e.kind IN $kinds "
                    "AND (e.name = $rc OR $rc CONTAINS e.name) AND size(e.name) >= 3 "
                    "RETURN e.key AS key ORDER BY (e.name = $rc) DESC, size(e.name) DESC "
                    "LIMIT 1",
                    ds=dataset, kinds=_ROOT_CAUSE_KINDS, rc=root_cause)).single()
                target = rec["key"] if rec else f"{dataset or 'global'}:Component:{root_cause}"
                if not rec:
                    await s.run("MERGE (c:Entity {key: $k}) ON CREATE SET c:Component, "
                                "c.kind = 'Component', c.name = $name, c.dataset = $ds",
                                k=target, name=root_cause, ds=dataset)
                await s.run("MATCH (i:Entity {key: $key}), (c:Entity {key: $t}) "
                            "MERGE (i)-[r:ROOT_CAUSE]->(c) SET r.confidence = $conf",
                            key=key, t=target, conf=confidence)
            if fault_type:
                await s.run("MERGE (f:Entity {key: $fk}) ON CREATE SET f:FaultType, "
                            "f.kind = 'FaultType', f.name = $ft "
                            "WITH f MATCH (i:Entity {key: $key}) MERGE (i)-[:HAS_FAULT]->(f)",
                            fk=f"global:FaultType:{fault_type}", ft=fault_type, key=key)

    # ---------------------------------------------------------------- read side (UI)
    async def overview(self) -> list[dict[str, Any]]:
        async with self.driver.session() as s:
            result = await s.run(
                "MATCH (n:Entity) WHERE n.dataset IS NOT NULL AND NOT n:Incident "
                "RETURN n.dataset AS dataset, n.kind AS kind, count(*) AS c")
            counts: dict[str, dict[str, int]] = defaultdict(dict)
            async for r in result:
                counts[r["dataset"]][r["kind"]] = r["c"]
            inc = await s.run("MATCH (i:Incident) RETURN i.dataset AS dataset, count(*) AS c")
            incidents = {r["dataset"]: r["c"] async for r in inc}
            rels = await s.run("MATCH (a:Entity)-[r]->() WHERE a.dataset IS NOT NULL "
                               "RETURN a.dataset AS dataset, count(r) AS c")
            edges = {r["dataset"]: r["c"] async for r in rels}
        return [{"dataset": ds, "kinds": kinds, "nodes": sum(kinds.values()),
                 "edges": edges.get(ds, 0), "incidents": incidents.get(ds, 0)}
                for ds, kinds in sorted(counts.items())]

    async def _edges_among(self, s: Any, keys: list[str]) -> list[dict[str, Any]]:
        result = await s.run(
            "MATCH (a:Entity)-[r]->(b:Entity) WHERE a.key IN $keys AND b.key IN $keys "
            "RETURN a.key AS source, type(r) AS type, b.key AS target, r.count AS count, "
            "r.confidence AS confidence", keys=keys)
        return [dict(r) async for r in result]

    async def dataset_view(self, dataset: str, limit: int = 150) -> dict[str, Any]:
        """The most informative part of a dataset's graph: entities ranked by errors, then
        connectivity, plus their containment parents and the incidents about them."""
        async with self.driver.session() as s:
            result = await s.run(
                "MATCH (n:Entity {dataset: $ds}) WHERE NOT n:Incident "
                "OPTIONAL MATCH (n)-[r]-() WITH n, count(r) AS degree "
                "RETURN n, degree ORDER BY coalesce(n.errors, 0) DESC, degree DESC", ds=dataset)
            rows = [_node_row(r) async for r in result]
            if not rows:
                return {"dataset": dataset, "nodes": [], "edges": [], "truncated": False,
                        "total_nodes": 0}
            # Always keep structural kinds (few); rank the long tail.
            structural = {"Component", "EventType", "Service", "Rack"}
            chosen = [r for r in rows if r["kind"] in structural][: limit // 2]
            rest = [r for r in rows if r["kind"] not in structural]
            chosen += rest[: max(0, limit - len(chosen))]
            keys = {r["key"] for r in chosen} | {f"global:Dataset:{dataset}"}
            # Add containment ancestors so hierarchies (rack > midplane > card > node) connect.
            anc = await s.run(
                "MATCH p = (a:Entity)-[:CONTAINS*1..4]->(n:Entity) WHERE n.key IN $keys "
                "UNWIND nodes(p) AS x RETURN DISTINCT x.key AS key", keys=list(keys))
            keys |= {r["key"] async for r in anc}
            inc = await s.run(
                "MATCH (i:Incident)-[]->(n:Entity) WHERE n.key IN $keys "
                "RETURN DISTINCT i.key AS key", keys=list(keys))
            keys |= {r["key"] async for r in inc}
            nodes_res = await s.run(
                "MATCH (n:Entity) WHERE n.key IN $keys OPTIONAL MATCH (n)-[r]-() "
                "WITH n, count(r) AS degree RETURN n, degree", keys=list(keys))
            nodes = [_node_row(r) async for r in nodes_res]
            edges = await self._edges_among(s, list(keys))
        return {"dataset": dataset, "nodes": nodes, "edges": edges,
                "truncated": len(rows) > len(chosen), "total_nodes": len(rows)}

    async def neighborhood(self, key: str, limit: int = 120) -> dict[str, Any] | None:
        async with self.driver.session() as s:
            center = await (await s.run(
                "MATCH (n:Entity {key: $key}) OPTIONAL MATCH (n)-[r]-() "
                "WITH n, count(r) AS degree RETURN n, degree", key=key)).single()
            if center is None:
                return None
            result = await s.run(
                "MATCH (n:Entity {key: $key})-[r]-(m:Entity) "
                "WITH m, max(coalesce(r.count, 1)) AS w OPTIONAL MATCH (m)-[r2]-() "
                "WITH m, w, count(r2) AS degree RETURN m AS n, degree "
                "ORDER BY coalesce(m.errors, 0) DESC, w DESC LIMIT $limit", key=key, limit=limit)
            nodes = [_node_row(center)] + [_node_row(r) async for r in result]
            edges = await self._edges_among(s, [n["key"] for n in nodes])
        return {"center": key, "nodes": nodes, "edges": edges}

    async def search(self, q: str, limit: int = 20) -> list[dict[str, Any]]:
        async with self.driver.session() as s:
            result = await s.run(
                "MATCH (n:Entity) WHERE toLower(n.name) CONTAINS toLower($q) "
                "OPTIONAL MATCH (n)-[r]-() WITH n, count(r) AS degree "
                "RETURN n, degree ORDER BY degree DESC LIMIT $limit", q=q, limit=limit)
            return [_node_row(r) async for r in result]


async def investigation_context(
    store: GraphStore, dataset: str | None, entity_names: list[str],
    include_history: bool = True,
) -> dict[str, Any] | None:
    """What the knowledge graph knows about the alerted entity: where it sits, what runs on
    it, whether its neighbours also log errors, and (optionally) past incidents on it.
    Error counts come from log levels, never from ground-truth labels."""
    if not dataset:
        return None
    ctx: dict[str, Any] = {}
    async with store.driver.session() as s:
        hot = await s.run(
            "MATCH (c:Component {dataset: $ds}) WHERE coalesce(c.errors, 0) > 0 "
            "RETURN c.name AS component, c.errors AS error_lines, c.lines AS lines "
            "ORDER BY c.errors DESC LIMIT 5", ds=dataset)
        ctx["dataset_error_hotspots"] = [dict(r) async for r in hot]
        hosts = await (await s.run(
            "MATCH (h:Host {dataset: $ds}) RETURN count(h) AS hosts, "
            "sum(CASE WHEN coalesce(h.errors, 0) > 0 THEN 1 ELSE 0 END) AS hosts_with_errors",
            ds=dataset)).single()
        if hosts and hosts["hosts"]:
            ctx["dataset_hosts"] = dict(hosts)

        for name in entity_names:
            rec = await (await s.run(
                "MATCH (e:Entity {dataset: $ds}) WHERE e.name = $name "
                "AND e.kind IN ['Host', 'Component', 'Service', 'NodeCard', 'Instance'] "
                "RETURN e LIMIT 1", ds=dataset, name=name)).single()
            if rec is None:
                continue
            e = rec["e"]
            entity: dict[str, Any] = {
                "name": e["name"], "kind": e["kind"],
                "log_lines": e.get("lines"), "error_lines": e.get("errors", 0),
            }
            chain = await (await s.run(
                "MATCH p = (a:Entity)-[:CONTAINS*1..4]->(e:Entity {key: $key}) "
                "WHERE a.dataset = $ds RETURN [x IN nodes(p) | x.kind + ' ' + x.name] AS path "
                "ORDER BY length(p) DESC LIMIT 1", key=e["key"], ds=dataset)).single()
            if chain:
                entity["location"] = chain["path"][:-1]
            comps = await s.run(
                "MATCH (e:Entity {key: $key})-[r:RUNS]->(c:Component) "
                "RETURN c.name AS component, r.count AS lines_on_entity "
                "ORDER BY r.count DESC LIMIT 8", key=e["key"])
            entity["components"] = [dict(r) async for r in comps]
            # Neighbours in the containment hierarchy that also log errors: tells the agent
            # whether the failure is local to this entity or spreading around it.
            for level, hops in (("same_parent", 1), ("same_grandparent", 2)):
                peers = await s.run(
                    f"MATCH (p:Entity)-[:CONTAINS*{hops}]->(e:Entity {{key: $key}}) "
                    f"MATCH (p)-[:CONTAINS*{hops}]->(o:Host) "
                    "WHERE o.key <> $key AND coalesce(o.errors, 0) > 0 "
                    "RETURN p.name AS parent, o.name AS host, o.errors AS error_lines "
                    "ORDER BY o.errors DESC LIMIT 8", key=e["key"])
                rows = [dict(r) async for r in peers]
                if rows:
                    entity[f"other_failing_hosts_{level}"] = rows
            if include_history:
                past = await s.run(
                    "MATCH (i:Incident)-[:ALERTED_ON|ROOT_CAUSE]->(e:Entity {key: $key}) "
                    "OPTIONAL MATCH (i)-[:HAS_FAULT]->(f) "
                    "RETURN DISTINCT i.name AS incident, i.status AS status, f.name AS fault "
                    "LIMIT 5", key=e["key"])
                history = [dict(r) async for r in past]
                if history:
                    entity["past_incidents"] = history
            ctx.setdefault("alerted_entities", []).append(entity)
    return ctx
