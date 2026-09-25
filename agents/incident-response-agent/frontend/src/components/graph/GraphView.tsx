'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { ApiError, fetcher, keys } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useGraphNeighbourhood, useGraphOverview, useGraphSearch, useGraphSlice } from '@/lib/hooks';
import { KIND_ORDER, edgeLabel, hasErrors, kindLabel, kindStyle } from '@/lib/graphStyle';
import { incidentHref, logsHref, type GraphState } from '@/lib/route';
import type { GraphEdge, GraphEdgeType, GraphKind, GraphNeighbourhood, GraphNode, Severity } from '@/lib/types';
import { useElementWidth } from '@/lib/useElementWidth';
import { SeverityBadge, StatusLabel } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState, TextButton } from '../ui/Card';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Skeleton } from '../ui/Skeleton';

// Canvas library is client-only and only loaded on this page.
const GraphCanvas = dynamic(() => import('./GraphCanvas'), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-none" />,
});

const DEFAULT_DATASET = 'BGL';

function isOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}

function datasetOfKey(key: string): string | null {
  const ds = key.split(':')[0];
  return ds && ds !== 'global' ? ds : null;
}

/** Union of several node/edge lists, de-duplicated by key / (source,type,target). */
function mergeGraphs(parts: { nodes: GraphNode[]; edges: GraphEdge[] }[]) {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const p of parts) {
    for (const n of p.nodes) if (!nodes.has(n.key)) nodes.set(n.key, n);
    for (const e of p.edges) edges.set(`${e.source}|${e.type}|${e.target}`, e);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()].filter((e) => nodes.has(e.source) && nodes.has(e.target)) };
}

export function GraphView({ state, setState }: { state: GraphState; setState: (patch: Partial<GraphState>, push?: boolean) => void }) {
  const overview = useGraphOverview();
  // A deep link to a global node (e.g. an incident) without a dataset shows just its neighbourhood.
  const dataset = state.dataset ?? (state.node ? datasetOfKey(state.node) : DEFAULT_DATASET);
  const slice = useGraphSlice(dataset);
  // Neighbourhood fetched for deep links and search picks (the node may be outside the dataset slice).
  // Plain clicks only select; they never refetch or re-layout the graph.
  const [focusKey, setFocusKey] = useState<string | null>(state.node);
  const focus = useGraphNeighbourhood(focusKey);
  const [expanded, setExpanded] = useState<GraphNeighbourhood[]>([]);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [resetCount, setResetCount] = useState(0);

  const graph = useMemo(
    () => mergeGraphs([...(slice.data ? [slice.data] : []), ...(focus.data ? [focus.data] : []), ...expanded]),
    [slice.data, focus.data, expanded],
  );

  const selected = state.node ? graph.nodes.find((n) => n.key === state.node) ?? null : null;
  const off = isOff(overview.error) || isOff(slice.error);
  const loading = (dataset ? !slice.data && !slice.error : false) || (focusKey && !dataset ? !focus.data && !focus.error : false);

  async function expand(key: string) {
    setExpandError(null);
    try {
      const n = await fetcher<GraphNeighbourhood>(keys.graphNode(key));
      setExpanded((prev) => [...prev, n]);
      setState({ node: key });
    } catch (err) {
      setExpandError(err instanceof Error ? err.message : 'Could not expand this node');
    }
  }

  function selectDataset(ds: string) {
    setExpanded([]);
    setFocusKey(null);
    setState({ dataset: ds, node: null }, true);
  }

  function reset() {
    setExpanded([]);
    if (dataset) setFocusKey(null);
    setResetCount((c) => c + 1);
    setState({ node: null });
  }

  if (off) {
    return (
      <p className="text-[13px] text-fg-muted">
        The knowledge graph is off. Set <code className="rounded border border-border px-1 font-mono text-[12px] text-fg">NEO4J_ENABLED=true</code> and run{' '}
        <code className="rounded border border-border px-1 font-mono text-[12px] text-fg">docker compose up -d neo4j</code>.
      </p>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_280px]">
      {/* Left: dataset picker + search */}
      <aside aria-label="Graph navigation" className="min-w-0 space-y-4">
        <GraphSearch
          onPick={(n) => {
            setExpanded([]);
            setFocusKey(n.key);
            setState({ dataset: n.dataset ?? datasetOfKey(n.key), node: n.key }, true);
          }}
        />
        <DatasetPicker overview={overview} current={dataset} onPick={selectDataset} />
      </aside>

      {/* Centre: canvas or table */}
      <section aria-label="Knowledge graph" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-[13px] text-fg-muted">
            {dataset ? <span className="font-medium text-fg">{dataset}</span> : <span className="font-medium text-fg">Neighbourhood</span>}
            {graph.nodes.length > 0 && (
              <span className="tabular-nums">
                {' · '}
                {graph.nodes.length.toLocaleString()} nodes · {graph.edges.length.toLocaleString()} edges
              </span>
            )}
            {slice.data?.truncated && (
              <span className="text-fg-subtle tabular-nums">
                {' · '}showing {slice.data.nodes.length.toLocaleString()} of {slice.data.total_nodes.toLocaleString()}
              </span>
            )}
          </p>
          <div role="group" aria-label="View" className="flex">
            {(['graph', 'table'] as const).map((m, i) => (
              <button
                key={m}
                type="button"
                aria-pressed={state.mode === m}
                onClick={() => setState({ mode: m })}
                className={cn(
                  'h-8 cursor-pointer border border-border-strong px-3 text-[13px] transition-colors duration-150 max-md:h-11',
                  i === 0 ? 'rounded-l-md' : '-ml-px rounded-r-md',
                  state.mode === m ? 'bg-hover font-medium text-fg' : 'text-fg-muted hover:bg-hover',
                )}
              >
                {m === 'graph' ? 'Graph' : 'Table'}
              </button>
            ))}
          </div>
          <Button variant="secondary" onClick={reset} disabled={!expanded.length && !state.node}>
            Reset
          </Button>
        </div>

        {(slice.error || focus.error) && !off && (
          <ErrorNotice
            error={slice.error ?? focus.error}
            prefix="Could not load the graph"
            onRetry={() => {
              void slice.mutate();
              void focus.mutate();
            }}
          />
        )}
        {expandError && <ErrorNotice error={new Error(expandError)} prefix="Could not expand" />}

        {state.mode === 'table' ? (
          <GraphTable nodes={graph.nodes} edges={graph.edges} selected={state.node} onSelect={(key) => setState({ node: key })} />
        ) : (
          <CanvasBox
            loading={Boolean(loading)}
            nodes={graph.nodes}
            edges={graph.edges}
            selected={state.node}
            fitKey={`${dataset ?? ''}:${resetCount}:${!dataset ? state.node ?? '' : ''}`}
            onSelect={(key) => setState({ node: key })}
            onExpand={(key) => void expand(key)}
          />
        )}
        <Legend nodes={graph.nodes} edges={graph.edges} />
        {state.mode === 'graph' && (
          <p className="text-[12px] text-fg-subtle">Click a node to inspect it; double-click (or Expand) to load its neighbours. Drag to pan, scroll to zoom.</p>
        )}
      </section>

      {/* Right: details */}
      <aside aria-label="Node details" className="min-w-0 lg:col-span-2 xl:col-span-1">
        {selected ? (
          <NodeDetails
            node={selected}
            edges={graph.edges}
            nodes={graph.nodes}
            onSelect={(key) => setState({ node: key })}
            onExpand={(key) => void expand(key)}
          />
        ) : state.node && focusKey === state.node && focus.error ? (
          <EmptyState title="That node is not in the graph." className="px-0 text-left" />
        ) : (
          <p className="text-[13px] text-fg-muted">Select a node to see its details and relationships.</p>
        )}
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------- canvas box */

function CanvasBox({
  loading,
  nodes,
  edges,
  selected,
  fitKey,
  onSelect,
  onExpand,
}: {
  loading: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string | null;
  fitKey: string;
  onSelect: (key: string | null) => void;
  onExpand: (key: string) => void;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const height = width < 640 ? 420 : 600;
  return (
    <div
      ref={ref}
      className="relative overflow-hidden rounded-lg border border-border bg-bg"
      style={{ height }}
    >
      <p className="sr-only">Interactive graph canvas. For keyboard and screen reader access, use the search box or switch to the Table view.</p>
      {loading || !width ? (
        <Skeleton className="h-full w-full rounded-none" />
      ) : nodes.length === 0 ? (
        <EmptyState title="Nothing to show for this selection." className="pt-24" />
      ) : (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          width={width}
          height={height}
          selected={selected}
          fitKey={fitKey}
          onSelect={onSelect}
          onExpand={onExpand}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- legend */

function Swatch({ kind }: { kind: GraphKind }) {
  const s = kindStyle[kind];
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2.5 w-2.5 shrink-0', s.shape === 'circle' && 'rounded-full', s.shape === 'diamond' && 'h-2 w-2 rotate-45')}
      style={{ background: `var(${s.colorVar})` }}
    />
  );
}

function Legend({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const present = new Set(nodes.map((n) => n.kind));
  const anyErrors = nodes.some(hasErrors);
  const rootCause = edges.some((e) => e.type === 'ROOT_CAUSE');
  if (!nodes.length) return null;
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-fg-muted">
      {KIND_ORDER.filter((k) => present.has(k)).map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <Swatch kind={k} />
          {kindLabel(k)}
        </li>
      ))}
      {anyErrors && (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-3 rounded-full border-[1.5px] border-danger" />
          Has error lines
        </li>
      )}
      {rootCause && (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-danger" />
          Root cause
        </li>
      )}
      <li className="text-fg-subtle">Size = log lines</li>
    </ul>
  );
}

/* ---------------------------------------------------------------- search */

function GraphSearch({ onPick }: { onPick: (n: GraphNode) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useGraphSearch(debounced);
  const results = (data ?? []).slice(0, 12);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q), 200);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  function pick(n: GraphNode) {
    onPick(n);
    setOpen(false);
    setQ('');
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && results[active >= 0 ? active : 0]) {
      e.preventDefault();
      pick(results[active >= 0 ? active : 0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const showList = open && debounced.trim().length >= 2;
  return (
    <div ref={rootRef} className="relative">
      <label htmlFor="graph-search" className="mb-1.5 block text-[13px] font-medium text-fg">
        Find an entity
      </label>
      <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute bottom-2 left-2.5 h-4 w-4 text-fg-subtle max-md:bottom-3.5" />
      <input
        id="graph-search"
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Host, IP, user, event…"
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-full rounded-md border border-border-strong bg-bg pr-2.5 pl-8 text-[13px] text-fg placeholder:text-fg-subtle focus-visible:border-link focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-link max-md:h-11 max-md:text-[16px]"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching entities"
        className={cn('absolute top-full right-0 left-0 z-40 mt-1 max-h-80 overflow-auto rounded-lg border border-border bg-surface p-1 shadow-pop lg:w-80', !showList && 'hidden')}
      >
        {isLoading && !data ? (
          <li className="px-2 py-1.5 text-[13px] text-fg-muted">Searching…</li>
        ) : results.length === 0 ? (
          <li className="px-2 py-1.5 text-[13px] text-fg-muted">No matches.</li>
        ) : (
          results.map((n, i) => (
            <li
              key={n.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={active === i}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(n)}
              onPointerMove={() => setActive(i)}
              className={cn('flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] max-md:min-h-11', active === i && 'bg-hover')}
            >
              <Swatch kind={n.kind} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{n.name}</span>
              <span className="shrink-0 text-[12px] text-fg-subtle">
                {kindLabel(n.kind)}
                {n.dataset ? ` · ${n.dataset}` : ''}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- datasets */

function DatasetPicker({
  overview,
  current,
  onPick,
}: {
  overview: ReturnType<typeof useGraphOverview>;
  current: string | null;
  onPick: (ds: string) => void;
}) {
  const rows = overview.data?.datasets ?? [];
  return (
    <nav aria-label="Datasets">
      <h2 className="mb-1.5 text-[13px] font-medium text-fg">Datasets</h2>
      {overview.error && !overview.data ? (
        <ErrorNotice error={overview.error} onRetry={() => void overview.mutate()} />
      ) : !overview.data ? (
        <div className="space-y-2" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : (
        <>
          {/* Compact select on small screens, list on large. */}
          <label htmlFor="graph-dataset" className="sr-only">
            Dataset
          </label>
          <select
            id="graph-dataset"
            value={current ?? ''}
            onChange={(e) => e.target.value && onPick(e.target.value)}
            className="h-11 w-full cursor-pointer rounded-md border border-border-strong bg-bg px-2.5 text-[16px] text-fg lg:hidden"
          >
            {!current && <option value="">Choose a dataset</option>}
            {rows.map((d) => (
              <option key={d.dataset} value={d.dataset}>
                {d.dataset} · {d.nodes.toLocaleString()} nodes
              </option>
            ))}
          </select>
          <ul className="max-lg:hidden">
            {rows.map((d) => (
              <li key={d.dataset}>
                <button
                  type="button"
                  aria-current={d.dataset === current ? 'true' : undefined}
                  onClick={() => onPick(d.dataset)}
                  className={cn(
                    'flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150',
                    d.dataset === current ? 'bg-hover font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                  )}
                  title={`${d.nodes.toLocaleString()} nodes · ${d.edges.toLocaleString()} edges · ${d.incidents} incidents`}
                >
                  <span className="min-w-0 flex-1 truncate">{d.dataset}</span>
                  <span className="shrink-0 text-[12px] font-normal text-fg-subtle tabular-nums">
                    {compact(d.nodes)} · {compact(d.edges)}
                  </span>
                  {d.incidents > 0 && (
                    <span className="flex shrink-0 items-center gap-1 text-[12px] font-normal text-fg-muted tabular-nums" aria-label={`${d.incidents} incidents`}>
                      <Swatch kind="Incident" />
                      {d.incidents}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-fg-subtle max-lg:hidden">nodes · edges · incidents</p>
        </>
      )}
    </nav>
  );
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/* ---------------------------------------------------------------- details */

function logsLinkFor(n: GraphNode): string | null {
  const ds = n.dataset;
  if (!ds || n.kind === 'Incident' || n.kind === 'FaultType') return null;
  if (n.kind === 'Dataset') return logsHref(n.name);
  if (n.kind === 'EventType') return logsHref(ds, { event: n.name });
  // Hosts, IPs, users, components…: search the dataset's lines for the name.
  return logsHref(ds, { q: n.name });
}

function NodeDetails({
  node,
  nodes,
  edges,
  onSelect,
  onExpand,
}: {
  node: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelect: (key: string) => void;
  onExpand: (key: string) => void;
}) {
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);
  const groups = useMemo(() => {
    const g = new Map<string, { type: GraphEdgeType; dir: 'out' | 'in'; items: { node: GraphNode; edge: GraphEdge }[] }>();
    for (const e of edges) {
      const out = e.source === node.key;
      const inc = e.target === node.key;
      if (!out && !inc) continue;
      const other = byKey.get(out ? e.target : e.source);
      if (!other) continue;
      const id = `${e.type}:${out ? 'out' : 'in'}`;
      const entry = g.get(id) ?? { type: e.type, dir: out ? 'out' : 'in', items: [] };
      entry.items.push({ node: other, edge: e });
      g.set(id, entry);
    }
    for (const v of g.values()) v.items.sort((a, b) => (b.edge.count ?? 0) - (a.edge.count ?? 0) || a.node.name.localeCompare(b.node.name));
    return [...g.values()];
  }, [edges, node.key, byKey]);

  const logs = logsLinkFor(node);
  const p = node.props;

  return (
    <div className="space-y-4">
      <header>
        <p className="flex items-center gap-1.5 text-[12px] text-fg-muted">
          <Swatch kind={node.kind} />
          {kindLabel(node.kind)}
          {node.dataset && <span> · {node.dataset}</span>}
        </p>
        <h2 className={cn('mt-1 text-[15px] font-semibold text-fg', node.kind === 'Incident' ? 'break-words' : 'font-mono text-[14px] break-all')}>{node.name}</h2>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-border py-3 text-[13px]">
        {p.lines != null && <Fact label="Log lines">{p.lines.toLocaleString()}</Fact>}
        {p.errors != null && (
          <Fact label="Error lines">
            <span className={cn('inline-flex items-center gap-1.5', p.errors > 0 && 'font-medium')}>
              {p.errors > 0 && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />}
              {p.errors.toLocaleString()}
            </span>
          </Fact>
        )}
        <Fact label="Connections">{(node.degree ?? 0).toLocaleString()}</Fact>
        {p.card_type && <Fact label="Card type">{p.card_type}</Fact>}
        {p.instance_id && (
          <Fact label="Instance id" wide>
            <span className="font-mono text-[12px] break-all">{p.instance_id}</span>
          </Fact>
        )}
        {node.kind === 'Incident' && (
          <>
            {p.severity && (
              <Fact label="Severity">
                <SeverityBadge severity={p.severity as Severity} />
              </Fact>
            )}
            {p.status && (
              <Fact label="Status">
                <StatusLabel status={p.status} />
              </Fact>
            )}
            {p.verified != null && <Fact label="Verified">{p.verified ? 'Yes' : 'No'}</Fact>}
          </>
        )}
        {p.template && (
          <Fact label="Template" wide>
            <span className="font-mono text-[12px] break-words">{p.template}</span>
          </Fact>
        )}
      </dl>

      <div className="flex flex-wrap gap-2">
        {node.kind === 'Incident' && p.incident_id && (
          <Link href={incidentHref(p.incident_id)} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-fg hover:opacity-85 max-md:h-11">
            Open incident
          </Link>
        )}
        {logs && (
          <Link href={logs} className="inline-flex h-8 items-center rounded-md border border-border-strong px-3 text-[13px] font-medium text-fg hover:bg-hover max-md:h-11">
            Open logs
          </Link>
        )}
        <Button variant="secondary" onClick={() => onExpand(node.key)}>
          Expand neighbours
        </Button>
      </div>

      <section aria-labelledby="rel-heading">
        <h3 id="rel-heading" className="mb-2 text-[13px] font-medium text-fg">
          Relationships
        </h3>
        {groups.length === 0 ? (
          <p className="text-[13px] text-fg-muted">None loaded. Expand to fetch neighbours.</p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <details key={`${g.type}:${g.dir}`} open={g.items.length <= 12}>
                <summary className="cursor-pointer text-[12px] text-fg-muted select-none hover:text-fg max-md:min-h-11 max-md:content-center">
                  {g.dir === 'in' ? '← ' : ''}
                  {edgeLabel[g.type] ?? g.type}
                  {g.dir === 'out' ? ' →' : ''} <span className="tabular-nums">· {g.items.length}</span>
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {g.items.slice(0, 40).map(({ node: other, edge }) => (
                    <li key={other.key}>
                      <button
                        type="button"
                        onClick={() => onSelect(other.key)}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-hover max-md:min-h-11"
                      >
                        <Swatch kind={other.kind} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={other.name}>
                          {other.name}
                        </span>
                        {edge.count != null && <span className="shrink-0 text-[12px] text-fg-subtle tabular-nums">×{edge.count.toLocaleString()}</span>}
                        {edge.confidence != null && <span className="shrink-0 text-[12px] text-fg-subtle tabular-nums">{Math.round(edge.confidence * 100)}%</span>}
                      </button>
                    </li>
                  ))}
                  {g.items.length > 40 && <li className="px-1.5 text-[12px] text-fg-subtle">+{g.items.length - 40} more (see Table)</li>}
                </ul>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className="mt-0.5 text-fg tabular-nums">{children}</dd>
    </div>
  );
}

/* ---------------------------------------------------------------- table view */

const th = 'h-9 px-3 text-[12px] font-medium text-fg-muted whitespace-nowrap';

function GraphTable({
  nodes,
  edges,
  selected,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const [showEdges, setShowEdges] = useState(false);
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);
  const sorted = useMemo(
    () =>
      [...nodes].sort(
        (a, b) =>
          (b.props.errors ?? 0) - (a.props.errors ?? 0) ||
          (b.props.lines ?? 0) - (a.props.lines ?? 0) ||
          (b.degree ?? 0) - (a.degree ?? 0) ||
          a.name.localeCompare(b.name),
      ),
    [nodes],
  );
  if (!nodes.length) return <EmptyState title="Nothing to show for this selection." />;
  return (
    <div className="space-y-4">
      <div className="max-h-[600px] overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <caption className="sr-only">Nodes in the current graph, most errors first</caption>
          <thead className="sticky top-0 border-b border-border bg-subtle">
            <tr>
              <th scope="col" className={cn(th, 'pl-4')}>Kind</th>
              <th scope="col" className={th}>Name</th>
              <th scope="col" className={cn(th, 'text-right')}>Lines</th>
              <th scope="col" className={cn(th, 'text-right')}>Errors</th>
              <th scope="col" className={cn(th, 'pr-4 text-right')}>Degree</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((n) => (
              <tr key={n.key} className={cn('h-9 transition-colors duration-150 hover:bg-hover', n.key === selected && 'bg-hover')}>
                <td className="py-1.5 pr-3 pl-4 whitespace-nowrap text-fg-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <Swatch kind={n.kind} />
                    {kindLabel(n.kind)}
                  </span>
                </td>
                <td className="max-w-80 px-3 py-1.5">
                  <button
                    type="button"
                    onClick={() => onSelect(n.key)}
                    aria-pressed={n.key === selected}
                    className="block max-w-full cursor-pointer truncate rounded text-left font-mono text-[12px] text-fg hover:underline"
                    title={n.name}
                  >
                    {n.name}
                  </button>
                </td>
                <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">{n.props.lines?.toLocaleString() ?? '—'}</td>
                <td className={cn('px-3 py-1.5 text-right tabular-nums', (n.props.errors ?? 0) > 0 ? 'font-medium text-danger-fg' : 'text-fg-muted')}>
                  {n.props.errors?.toLocaleString() ?? '—'}
                </td>
                <td className="py-1.5 pr-4 pl-3 text-right text-fg-muted tabular-nums">{n.degree ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <TextButton onClick={() => setShowEdges((s) => !s)}>{showEdges ? 'Hide' : 'Show'} {edges.length.toLocaleString()} relationships</TextButton>
        {showEdges && (
          <div className="mt-2 max-h-[480px] overflow-auto rounded-lg border border-border">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <caption className="sr-only">Relationships in the current graph</caption>
              <thead className="sticky top-0 border-b border-border bg-subtle">
                <tr>
                  <th scope="col" className={cn(th, 'pl-4')}>From</th>
                  <th scope="col" className={th}>Relationship</th>
                  <th scope="col" className={th}>To</th>
                  <th scope="col" className={cn(th, 'pr-4 text-right')}>Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {edges.map((e) => (
                  <tr key={`${e.source}|${e.type}|${e.target}`} className="h-9">
                    <td className="max-w-64 truncate py-1.5 pr-3 pl-4 font-mono text-[12px] text-fg" title={e.source}>
                      {byKey.get(e.source)?.name ?? e.source}
                    </td>
                    <td className={cn('px-3 py-1.5 whitespace-nowrap', e.type === 'ROOT_CAUSE' ? 'font-medium text-danger-fg' : 'text-fg-muted')}>
                      {edgeLabel[e.type] ?? e.type}
                      {e.confidence != null && <span className="text-fg-subtle tabular-nums"> {Math.round(e.confidence * 100)}%</span>}
                    </td>
                    <td className="max-w-64 truncate px-3 py-1.5 font-mono text-[12px] text-fg" title={e.target}>
                      {byKey.get(e.target)?.name ?? e.target}
                    </td>
                    <td className="py-1.5 pr-4 pl-3 text-right text-fg-muted tabular-nums">{e.count?.toLocaleString() ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
