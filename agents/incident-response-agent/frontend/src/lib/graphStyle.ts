import type { GraphEdgeType, GraphKind, GraphNode } from './types';

/**
 * Visual encoding for the knowledge graph. Neutral-first: only three hues
 * (validated all-pairs for colour-blind safety), used for the kinds that
 * matter most: incidents (accent), actors (users) and machines. Everything
 * structural is a gray step. Shape is a second channel: incidents are
 * diamonds, fault types squares, everything else circles.
 */
export type GraphShape = 'circle' | 'diamond' | 'square';

export const kindStyle: Record<GraphKind, { colorVar: string; shape: GraphShape; label: string }> = {
  Incident: { colorVar: '--graph-incident', shape: 'diamond', label: 'Incident' },
  FaultType: { colorVar: '--graph-n1', shape: 'square', label: 'Fault type' },
  Dataset: { colorVar: '--fg', shape: 'circle', label: 'Dataset' },
  Rack: { colorVar: '--graph-n1', shape: 'circle', label: 'Rack' },
  Midplane: { colorVar: '--graph-n2', shape: 'circle', label: 'Midplane' },
  NodeCard: { colorVar: '--graph-n3', shape: 'circle', label: 'Node card' },
  Host: { colorVar: '--graph-machine', shape: 'circle', label: 'Host' },
  IP: { colorVar: '--graph-machine', shape: 'circle', label: 'IP address' },
  RemoteHost: { colorVar: '--graph-machine', shape: 'circle', label: 'Remote host' },
  Instance: { colorVar: '--graph-machine', shape: 'circle', label: 'VM instance' },
  User: { colorVar: '--graph-actor', shape: 'circle', label: 'User' },
  Component: { colorVar: '--graph-n2', shape: 'circle', label: 'Component' },
  Service: { colorVar: '--graph-n2', shape: 'circle', label: 'Service' },
  EventType: { colorVar: '--graph-n4', shape: 'circle', label: 'Event type' },
};

export const KIND_ORDER: GraphKind[] = [
  'Incident', 'FaultType', 'Dataset', 'Rack', 'Midplane', 'NodeCard', 'Host', 'IP', 'RemoteHost', 'Instance', 'User',
  'Component', 'Service', 'EventType',
];

export const edgeLabel: Record<GraphEdgeType, string> = {
  CONTAINS: 'Contains',
  HAS_COMPONENT: 'Has component',
  RUNS: 'Runs',
  EMITS: 'Emits',
  CONNECTS_TO: 'Connects to',
  MANAGES: 'Manages',
  FAILED_LOGIN: 'Failed login',
  ACCEPTED_LOGIN: 'Accepted login',
  SENDS_BLOCKS: 'Sends blocks',
  ABOUT: 'About',
  ALERTED_ON: 'Alerted on',
  ROOT_CAUSE: 'Root cause',
  HAS_FAULT: 'Has fault',
};

export function kindLabel(kind: string): string {
  return kindStyle[kind as GraphKind]?.label ?? kind;
}

/** Node radius in graph units: log-scaled by log lines; fixed sizes for anchors. */
export function nodeRadius(n: GraphNode): number {
  if (n.kind === 'Dataset') return 9;
  if (n.kind === 'Incident') return 8;
  if (n.kind === 'FaultType') return 5;
  const lines = typeof n.props.lines === 'number' ? n.props.lines : 0;
  return Math.min(11, 3.5 + 1.9 * Math.log10(1 + lines));
}

export function hasErrors(n: GraphNode): boolean {
  return typeof n.props.errors === 'number' && n.props.errors > 0;
}
