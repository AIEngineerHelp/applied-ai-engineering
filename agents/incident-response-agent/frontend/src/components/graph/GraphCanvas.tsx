'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';
import { hasErrors, kindLabel, kindStyle, nodeRadius } from '@/lib/graphStyle';
import { useTheme } from '@/lib/theme';
import type { GraphEdge, GraphNode } from '@/lib/types';

type N = NodeObject<{ id: string; data: GraphNode }>;
type L = LinkObject<{ id: string; data: GraphNode }, { data: GraphEdge }>;

interface Palette {
  kinds: Record<string, string>;
  fg: string;
  fgMuted: string;
  bg: string;
  edge: string;
  danger: string;
  link: string;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const kinds: Record<string, string> = {};
  for (const [kind, s] of Object.entries(kindStyle)) kinds[kind] = v(s.colorVar);
  return { kinds, fg: v('--fg'), fgMuted: v('--fg-muted'), bg: v('--bg'), edge: v('--graph-edge'), danger: v('--danger'), link: v('--link') };
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function endKey(end: L['source']): string {
  return typeof end === 'object' && end ? String((end as N).id) : String(end);
}

/**
 * Force-directed canvas (react-force-graph-2d). Rendering is custom so the
 * encoding matches the design system; tooltips are React (never HTML strings,
 * since names come from logs). The simulation cools and stops; under reduced
 * motion the layout is precomputed and shown static.
 */
export default function GraphCanvas({
  nodes,
  edges,
  width,
  height,
  selected,
  fitKey,
  onSelect,
  onExpand,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  selected: string | null;
  /** Changes when the view should re-fit (new dataset / reset). */
  fitKey: string;
  onSelect: (key: string | null) => void;
  onExpand: (key: string) => void;
}) {
  const fgRef = useRef<ForceGraphMethods<N, L> | undefined>(undefined);
  // Node objects keyed by graph key; reused so merged nodes keep their positions.
  const [cache] = useState(() => new Map<string, N>());
  const lastClick = useRef<{ key: string; at: number } | null>(null);
  const fitPending = useRef(true);
  const theme = useTheme();
  const [reduced] = useState(prefersReducedMotion);
  const [hover, setHover] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  // Palette follows the theme; read from CSS tokens so canvas matches the UI.
  const palette = useMemo(() => {
    void theme;
    return readPalette();
  }, [theme]);

  // Reuse node objects across merges so existing nodes keep their positions.
  const graphData = useMemo(() => {
    const keep = new Set(nodes.map((d) => d.key));
    for (const k of [...cache.keys()]) if (!keep.has(k)) cache.delete(k);
    const ns = nodes.map((d) => {
      const prev = cache.get(d.key);
      const obj: N = prev ? Object.assign(prev, { data: d }) : { id: d.key, data: d };
      cache.set(d.key, obj);
      return obj;
    });
    const links: L[] = edges.filter((e) => keep.has(e.source) && keep.has(e.target)).map((e) => ({ source: e.source, target: e.target, data: e }));
    return { nodes: ns, links };
  }, [nodes, edges, cache]);

  useEffect(() => {
    fitPending.current = true;
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force('charge')?.strength?.(-38);
    fg.d3Force('link')?.distance?.(28);
    // Gentle gravity so disconnected clusters stay close instead of drifting apart.
    let simNodes: N[] = [];
    const gravity = Object.assign(
      (alpha: number) => {
        for (const n of simNodes) {
          n.vx = (n.vx ?? 0) - (n.x ?? 0) * 0.1 * alpha;
          n.vy = (n.vy ?? 0) - (n.y ?? 0) * 0.1 * alpha;
        }
      },
      { initialize: (ns: N[]) => (simNodes = ns) },
    );
    fg.d3Force('gravity', gravity);
    if (!reduced) fg.d3ReheatSimulation();
    if (reduced) {
      // Layout is precomputed (warmupTicks) and static: fit right away.
      const t = window.setTimeout(() => fg.zoomToFit(0, 40), 50);
      return () => window.clearTimeout(t);
    }
  }, [fitKey, reduced]);

  // Bring the selected node into view.
  useEffect(() => {
    if (!selected) return;
    const n = cache.get(selected);
    if (n && typeof n.x === 'number' && typeof n.y === 'number') fgRef.current?.centerAt(n.x, n.y, reduced ? 0 : 400);
  }, [selected, reduced, cache]);

  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!selected) return set;
    for (const e of edges) {
      if (e.source === selected) set.add(e.target);
      if (e.target === selected) set.add(e.source);
    }
    return set;
  }, [edges, selected]);

  const draw = useCallback(
    (node: N, ctx: CanvasRenderingContext2D, scale: number) => {
      const d = node.data;
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = nodeRadius(d);
      const shape = kindStyle[d.kind]?.shape ?? 'circle';
      const isSel = d.key === selected;
      const dim = selected && !isSel && !neighbours.has(d.key);
      ctx.globalAlpha = dim ? 0.35 : 1;

      const path = () => {
        ctx.beginPath();
        if (shape === 'diamond') {
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
        } else if (shape === 'square') {
          ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
        } else {
          ctx.arc(x, y, r, 0, 2 * Math.PI);
        }
      };

      // Surface ring keeps overlapping marks legible.
      path();
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = palette.bg;
      ctx.stroke();
      ctx.fillStyle = palette.kinds[d.kind] ?? palette.fgMuted;
      ctx.fill();

      if (hasErrors(d)) {
        ctx.beginPath();
        ctx.arc(x, y, r + 1.6, 0, 2 * Math.PI);
        ctx.lineWidth = Math.max(0.8, 1.4 / Math.sqrt(scale));
        ctx.strokeStyle = palette.danger;
        ctx.stroke();
      }
      if (isSel) {
        ctx.beginPath();
        ctx.arc(x, y, r + (hasErrors(d) ? 4.4 : 3), 0, 2 * Math.PI);
        ctx.lineWidth = 2 / scale;
        ctx.strokeStyle = palette.fg;
        ctx.stroke();
      }

      const isHover = hover?.node.key === d.key;
      const showLabel =
        isSel || isHover || d.kind === 'Dataset' || (d.kind === 'Incident' && scale > 1.2) || (scale > 1.4 && r >= 7) || scale > 3;
      if (showLabel) {
        const size = Math.max(10 / scale, 1.8);
        ctx.font = `${isSel ? 600 : 400} ${size}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = d.name.length > 32 ? `${d.name.slice(0, 31)}…` : d.name;
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = palette.bg;
        ctx.strokeText(label, x, y + r + 2.5);
        ctx.fillStyle = isSel ? palette.fg : palette.fgMuted;
        ctx.fillText(label, x, y + r + 2.5);
      }
      ctx.globalAlpha = 1;
    },
    [palette, selected, neighbours, hover],
  );

  const paintHit = useCallback((node: N, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, nodeRadius(node.data) + 4, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  const linkColor = useCallback(
    (l: L) => {
      const e = l.data;
      if (e.type === 'ROOT_CAUSE') return palette.danger;
      if (selected && (endKey(l.source) === selected || endKey(l.target) === selected)) return palette.fgMuted;
      return palette.edge;
    },
    [palette, selected],
  );

  const linkWidth = useCallback((l: L) => {
    const e = l.data;
    if (e.type === 'ROOT_CAUSE') return 2;
    return 0.6 + 0.7 * Math.log10(1 + (e.count ?? 0));
  }, []);

  const linkDash = useCallback((l: L) => (l.data.type === 'ROOT_CAUSE' ? [4, 3] : null), []);

  const handleClick = useCallback(
    (node: N) => {
      const key = String(node.id);
      const now = performance.now();
      const last = lastClick.current;
      lastClick.current = { key, at: now };
      if (last && last.key === key && now - last.at < 350) {
        onExpand(key);
        return;
      }
      onSelect(key);
    },
    [onSelect, onExpand],
  );

  function handleHover(node: N | null) {
    if (!node) {
      setHover(null);
      return;
    }
    const fg = fgRef.current;
    const p = fg ? fg.graph2ScreenCoords(node.x ?? 0, node.y ?? 0) : { x: 0, y: 0 };
    setHover({ node: node.data, x: p.x, y: p.y });
  }

  return (
    <div className="relative" style={{ width, height }}>
      <ForceGraph2D<{ id: string; data: GraphNode }, { data: GraphEdge }>
        ref={fgRef}
        graphData={graphData}
        width={width}
        height={height}
        backgroundColor="rgba(0,0,0,0)"
        nodeRelSize={4}
        nodeCanvasObject={draw}
        nodePointerAreaPaint={paintHit}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkLineDash={linkDash}
        d3AlphaDecay={0.045}
        d3VelocityDecay={0.35}
        warmupTicks={reduced ? 300 : 30}
        cooldownTicks={reduced ? 0 : Infinity}
        cooldownTime={reduced ? 0 : 3500}
        onEngineStop={() => {
          if (fitPending.current) {
            fitPending.current = false;
            const fg = fgRef.current;
            fg?.zoomToFit(reduced ? 0 : 400, 40);
            // Small neighbourhoods shouldn't blow up to fill the canvas.
            window.setTimeout(() => {
              if (fg && fg.zoom() > 3) fg.zoom(3, reduced ? 0 : 200);
            }, reduced ? 0 : 450);
          }
        }}
        onNodeClick={handleClick}
        onNodeHover={handleHover}
        onBackgroundClick={() => onSelect(null)}
        minZoom={0.3}
        maxZoom={12}
      />
      {hover && (
        <div
          role="presentation"
          className="pointer-events-none absolute z-10 max-w-64 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] shadow-pop"
          style={{ left: Math.min(Math.max(8, hover.x + 12), width - 200), top: Math.min(Math.max(8, hover.y + 12), height - 80) }}
        >
          <p className="text-fg-muted">{kindLabel(hover.node.kind)}</p>
          <p className="truncate font-mono text-fg">{hover.node.name}</p>
          {(hover.node.props.lines != null || hover.node.props.errors != null) && (
            <p className="text-fg-muted tabular-nums">
              {hover.node.props.lines != null && `${hover.node.props.lines.toLocaleString()} lines`}
              {hover.node.props.errors ? ` · ${hover.node.props.errors.toLocaleString()} errors` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
