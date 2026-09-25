"""Build a knowledge graph from the Loghub log files.

Everything here is *observed* in the logs (who logged what, who talked to whom, the BGL
machine layout), not a hand-drawn service map. Ground-truth label columns are never read.

Node keys are "<dataset>:<kind>:<name>" so identical names in different datasets never
collide. Edge weights count the log lines that support them.
"""
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from src.ira.tools.log_explorer.service import LogExplorerService

ERROR_LEVELS = {"FATAL", "ERROR", "SEVERE", "CRITICAL", "FAILURE", "E", "F"}
_IP = r"(?:\d{1,3}\.){3}\d{1,3}"


@dataclass
class GraphNode:
    key: str
    kind: str
    name: str
    dataset: str | None
    props: dict[str, Any] = field(default_factory=dict)


@dataclass
class Graph:
    nodes: dict[str, GraphNode] = field(default_factory=dict)
    # (source key, relationship, target key) -> supporting line count
    edges: Counter[tuple[str, str, str]] = field(default_factory=Counter)

    def node(self, dataset: str | None, kind: str, name: str, **props: Any) -> str:
        key = f"{dataset or 'global'}:{kind}:{name}"
        existing = self.nodes.get(key)
        if existing is None:
            self.nodes[key] = GraphNode(key, kind, name, dataset, dict(props))
        else:
            for k, v in props.items():
                if isinstance(v, int) and isinstance(existing.props.get(k), int):
                    existing.props[k] += v
                else:
                    existing.props.setdefault(k, v)
        return key

    def edge(self, source: str, rel: str, target: str, count: int = 1) -> None:
        self.edges[(source, rel, target)] += count

    def link(self, source: str, rel: str, target: str) -> None:
        """A structural edge that exists or not (e.g. containment); never accumulates."""
        self.edges[(source, rel, target)] = 1

    def merge(self, other: "Graph") -> None:
        for key, n in other.nodes.items():
            if key in self.nodes:
                self.nodes[key].props.update(n.props)
            else:
                self.nodes[key] = n
        self.edges.update(other.edges)


def _is_error(level: Any) -> bool:
    return str(level).strip().upper() in ERROR_LEVELS


def _components_and_events(g: Graph, ds: str, dset: str, df: pd.DataFrame,
                           component_col: str | None, host_col: str | None) -> None:
    """Generic layer for every dataset: Dataset -> Component -> EventType, and
    Host -> Component when the dataset names hosts."""
    level_col = "Level" if "Level" in df.columns else None
    comp = df[component_col].astype(str) if component_col else pd.Series(ds, index=df.index)
    errors = df[level_col].map(_is_error) if level_col else pd.Series(False, index=df.index)

    comp_stats = pd.DataFrame({"c": comp, "e": errors}).groupby("c")["e"].agg(["size", "sum"])
    for name, row in comp_stats.iterrows():
        key = g.node(ds, "Component", str(name), lines=int(row["size"]),
                     errors=int(row["sum"]))
        g.edge(dset, "HAS_COMPONENT", key, int(row["size"]))

    # Event types: the most frequent per dataset plus every error-level one.
    ev = pd.DataFrame({"c": comp, "id": df["EventId"], "t": df["EventTemplate"], "e": errors})
    counts = ev.groupby(["id", "t"]).agg(n=("c", "size"), err=("e", "sum")).reset_index()
    keep = set(counts.nlargest(15, "n")["id"]) | set(counts[counts["err"] > 0]["id"])
    for r in counts[counts["id"].isin(keep)].itertuples(index=False):
        g.node(ds, "EventType", str(r.id), template=str(r.t)[:300], lines=int(r.n),
               errors=int(r.err))
    for (c, eid), n in ev[ev["id"].isin(keep)].groupby(["c", "id"]).size().items():
        g.edge(f"{ds}:Component:{c}", "EMITS", f"{ds}:EventType:{eid}", int(n))

    if host_col:
        hosts = df[host_col].astype(str)
        host_stats = pd.DataFrame({"h": hosts, "e": errors}).groupby("h")["e"].agg(
            ["size", "sum"])
        for name, row in host_stats.iterrows():
            g.node(ds, "Host", str(name), lines=int(row["size"]), errors=int(row["sum"]))
        for (h, c), n in pd.DataFrame({"h": hosts, "c": comp}).groupby(["h", "c"]).size().items():
            g.edge(f"{ds}:Host:{h}", "RUNS", f"{ds}:Component:{c}", int(n))


def _bgl_layout(g: Graph, df: pd.DataFrame) -> None:
    """Blue Gene/L location codes: R02-M1-N0-C:J12-U11 = rack R02, midplane M1,
    node card N0 (C = compute, I = I/O), card J12, unit U11."""
    pattern = re.compile(r"^(R\d+)-(M\d)-(N[0-9A-F])(?:-([CI]))?")
    for node in df["Node"].dropna().unique():
        node = str(node)
        m = pattern.match(node)
        if not m:
            continue
        rack, mid, card, kind = m.groups()
        r = g.node("BGL", "Rack", rack)
        mp = g.node("BGL", "Midplane", f"{rack}-{mid}")
        nc = g.node("BGL", "NodeCard", f"{rack}-{mid}-{card}",
                    card_type={"C": "compute", "I": "io"}.get(kind or "", "other"))
        g.link("global:Dataset:BGL", "CONTAINS", r)
        g.link(r, "CONTAINS", mp)
        g.link(mp, "CONTAINS", nc)
        g.link(nc, "CONTAINS", f"BGL:Host:{node}")


def _ssh_logins(g: Graph, ds: str, df: pd.DataFrame) -> None:
    """Attack graph: source IP -> user it tried, failed vs accepted."""
    # (relationship, pattern, user group, ip group)
    patterns = [
        ("FAILED_LOGIN",
         re.compile(rf"Failed password for (?:invalid user )?(\S+) from ({_IP})"), 1, 2),
        ("ACCEPTED_LOGIN", re.compile(rf"Accepted \w+ for (\S+) from ({_IP})"), 1, 2),
        ("FAILED_LOGIN", re.compile(rf"authentication failure;.*rhost=({_IP})\s+user=(\S+)"),
         2, 1),
    ]
    for content in df["Content"].fillna("").astype(str):
        for rel, pat, user_group, ip_group in patterns:
            m = pat.search(content)
            if m:
                g.edge(g.node(ds, "IP", m.group(ip_group)), rel,
                       g.node(ds, "User", m.group(user_group)))
                break


def _hdfs_transfers(g: Graph, df: pd.DataFrame) -> None:
    pat = re.compile(rf"src: /({_IP}):\d+ dest: /({_IP}):\d+")
    for content in df["Content"].fillna("").astype(str):
        m = pat.search(content)
        if m and m.group(1) != m.group(2):
            g.edge(g.node("HDFS", "IP", m.group(1)), "SENDS_BLOCKS",
                   g.node("HDFS", "IP", m.group(2)))
        elif m:
            g.node("HDFS", "IP", m.group(1))


def _zookeeper_peers(g: Graph, df: pd.DataFrame) -> None:
    ensemble = g.node("Zookeeper", "Service", "zookeeper-ensemble")
    g.link("global:Dataset:Zookeeper", "CONTAINS", ensemble)
    pat = re.compile(rf"(?:connection request|Accepted socket connection from|"
                     rf"Connection broken for).*?/({_IP})")
    for content in df["Content"].fillna("").astype(str):
        m = pat.search(content)
        if m:
            g.edge(g.node("Zookeeper", "IP", m.group(1)), "CONNECTS_TO", ensemble)


def _openstack_instances(g: Graph, df: pd.DataFrame) -> None:
    pat = re.compile(r"\[instance: ([0-9a-f-]{36})\]")
    for comp, content in zip(df["Component"].astype(str), df["Content"].fillna("").astype(str),
                             strict=True):
        m = pat.search(content)
        if m:
            g.edge(f"OpenStack:Component:{comp}", "MANAGES",
                   g.node("OpenStack", "Instance", m.group(1)[:8], instance_id=m.group(1)))


def _proxifier_targets(g: Graph, df: pd.DataFrame) -> None:
    pat = re.compile(r"^([\w.-]+):\d+ (?:open through proxy|close|error)")
    for prog, content in zip(df["Program"].astype(str), df["Content"].fillna("").astype(str),
                             strict=True):
        m = pat.search(content)
        if m:
            g.edge(f"Proxifier:Component:{prog}", "CONNECTS_TO",
                   g.node("Proxifier", "RemoteHost", m.group(1)))


# dataset -> (component column, host column)
_COLUMNS: dict[str, tuple[str | None, str | None]] = {
    "BGL": ("Component", "Node"), "HPC": ("Component", "Node"),
    "Thunderbird": ("Component", "Location"), "Mac": ("Component", "User"),
    "Zookeeper": ("Component", None), "Hadoop": ("Component", None),
    "HDFS": ("Component", None), "Spark": ("Component", None),
    "OpenStack": ("Component", None), "Linux": ("Component", None),
    "OpenSSH": ("Component", None), "HealthApp": ("Component", None),
    "Proxifier": ("Program", None), "Apache": (None, None),
}
_SPECIFIC: dict[str, Callable[[Graph, pd.DataFrame], None]] = {
    "BGL": _bgl_layout, "HDFS": _hdfs_transfers, "Zookeeper": _zookeeper_peers,
    "OpenStack": _openstack_instances, "Proxifier": _proxifier_targets,
    "OpenSSH": lambda g, df: _ssh_logins(g, "OpenSSH", df),
    "Linux": lambda g, df: _ssh_logins(g, "Linux", df),
}


def build_dataset_graph(name: str, explorer: LogExplorerService | None = None) -> Graph:
    explorer = explorer or LogExplorerService()
    df = explorer.load_logs(name)  # ground-truth labels already removed
    g = Graph()
    dset = g.node(None, "Dataset", name, lines=len(df))
    component_col, host_col = _COLUMNS.get(name, (None, None))
    _components_and_events(g, name, dset, df, component_col, host_col)
    specific = _SPECIFIC.get(name)
    if specific:
        specific(g, df)
    return g


def build_graph(datasets: list[str]) -> Graph:
    g = Graph()
    for name in datasets:
        g.merge(build_dataset_graph(name))
    return g
