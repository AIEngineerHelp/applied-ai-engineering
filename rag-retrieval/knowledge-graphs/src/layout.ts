// A deterministic layout for drawing the graph, computed once at export.
// Columns follow the chain the questions walk along:
//   people → teams and customers → products, services, sites → components, incidents → companies
// Within a column, nodes are ordered by the average height of their neighbours
// (a few barycentre passes), which removes most edge crossings.

import type { Graph } from "./graph.ts";

export const LAYOUT_SIZE = { w: 1000, h: 720 };

const COLUMNS: string[][] = [["Person"], ["Team", "Customer"], ["Product", "Service", "Site"], ["Component", "Incident"], ["Company"]];

export function layoutGraph(graph: Graph): Record<string, [number, number]> {
  const colOf = (type: string) => COLUMNS.findIndex((c) => c.includes(type));
  const cols = COLUMNS.map((types) =>
    graph.nodes
      .filter((n) => types.includes(n.type))
      .sort((a, b) => types.indexOf(a.type) - types.indexOf(b.type) || a.name.localeCompare(b.name))
      .map((n) => n.id),
  );
  const nbrs = new Map(graph.nodes.map((n) => [n.id, [] as string[]]));
  for (const e of graph.edges) {
    nbrs.get(e.source)?.push(e.target);
    nbrs.get(e.target)?.push(e.source);
  }
  const y = new Map<string, number>();
  const place = () =>
    cols.forEach((ids) => {
      const step = (LAYOUT_SIZE.h - 60) / Math.max(1, ids.length - 1 || 1);
      ids.forEach((id, i) => y.set(id, ids.length === 1 ? LAYOUT_SIZE.h / 2 : 30 + i * step));
    });
  place();
  for (let pass = 0; pass < 6; pass++) {
    cols.forEach((ids, ci) => {
      const typeOrder = COLUMNS[ci];
      const key = (id: string) => {
        const ns = nbrs.get(id)!.filter((m) => colOf(graph.nodes.find((n) => n.id === m)!.type) !== ci);
        return ns.length ? ns.reduce((s, m) => s + y.get(m)!, 0) / ns.length : y.get(id)!;
      };
      const type = (id: string) => typeOrder.indexOf(graph.nodes.find((n) => n.id === id)!.type);
      // Keep the types of a column in separate blocks; order within a block by barycentre.
      ids.sort((a, b) => type(a) - type(b) || key(a) - key(b) || a.localeCompare(b));
    });
    place();
  }
  const xs = [70, 290, 520, 740, 930];
  return Object.fromEntries(graph.nodes.map((n) => [n.id, [xs[colOf(n.type)], Math.round(y.get(n.id)!)] as [number, number]]));
}
