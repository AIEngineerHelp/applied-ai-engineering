// The four scenes. Each is a timeline (beats with captions) and a function
// from time t to a Frame for the engine, plus optional DOM updates. One thing
// moves at a time; no beat runs longer than about 1.2 s. Nothing here
// computes results: resolution, the graph, traversal and retrieval come
// from src/ and are only staged here.

import { DOCUMENTS, EXTRACTIONS } from "../src/data.ts";
import { sentence, type Graph } from "../src/graph.ts";
import { lookup } from "../src/resolve.ts";
import type { Comparison } from "../src/compare.ts";
import { Engine, HOME, type EdgeTarget, type Frame, type HeroWord, type NodeTarget } from "./engine.ts";
import { ease, Sequence, span, type Beat } from "./timeline.ts";

export interface Scene {
  seq: Sequence;
  frame(t: number): Frame;
  dom?(t: number): void;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const seeded = (seed: number) => {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
};

/** Entities and edges extracted from a set of documents. */
export function litBy(graph: Graph, docs: string[]) {
  const nodes = new Set([...graph.nodes.values()].filter((e) => e.mentions.some((m) => docs.includes(m.document))).map((e) => e.id));
  const edges = new Set(graph.edges.filter((e) => e.evidence.some((v) => docs.includes(v.document))).map((e) => e.id));
  return { nodes, edges };
}

function baseFrame(graph: Graph, docs: string[], ghost = 1): Frame {
  const { nodes, edges } = litBy(graph, docs);
  return {
    nodes: new Map([...nodes].map((id) => [id, { lit: 1 } as NodeTarget])),
    edges: new Map([...edges].map((id) => [id, { draw: 1 } as EdgeTarget])),
    ghost,
    labels: [],
    camera: { ...HOME },
  };
}

// --- Opening: words from the documents settle into a graph ------------------------

export function heroScene(graph: Graph, layout: Record<string, number[]>, frozen: number | null): Scene {
  const beats: Beat[] = [
    { at: 0, caption: "Six short documents from a fictional sensor maker." },
    { at: 1.2, caption: "An extractor picks out the entities: people, teams, products, parts, suppliers, customers." },
    { at: 2.3, caption: "Names that mean the same thing become one node." },
    { at: 3.5, caption: "The relations between them become a knowledge graph." },
  ];
  const rnd = seeded(11);
  const words: (HeroWord & { x0: number; y0: number; id: string | null; delay: number })[] = [];
  EXTRACTIONS.forEach((x) =>
    x.entities.forEach((e) => {
      words.push({ text: e.name, type: e.type, id: lookup(graph.resolution, e.type, e.name)!, x: 0, y: 0, x0: 0, y0: 0, alpha: 0, ink: 0, delay: 0 });
    }),
  );
  const names = new Set(EXTRACTIONS.flatMap((x) => x.entities.map((e) => e.name.toLowerCase())));
  const filler = [...new Set(DOCUMENTS.flatMap((d) => d.paragraphs.join(" ").split(/[^A-Za-z]+/)).filter((w) => w.length > 4 && !names.has(w.toLowerCase())))];
  for (let i = 0; i < 27 && filler.length; i++) {
    const w = filler.splice(Math.floor(rnd() * filler.length), 1)[0];
    words.push({ text: w.toLowerCase(), type: null, id: null, x: 0, y: 0, x0: 0, y0: 0, alpha: 0, ink: 0, delay: 0 });
  }
  // A loose grid, so the words read as a page of text rather than a pile.
  const cols = 5;
  const rows = Math.ceil(words.length / cols);
  const cells = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  words.forEach((w, i) => {
    const c = cells[i];
    w.x0 = 110 + (c % cols) * (740 / (cols - 1)) + (Math.floor(c / cols) % 2 ? 36 : -36);
    w.y0 = 30 + Math.floor(c / cols) * (600 / (rows - 1));
    w.delay = rnd() * 0.5;
  });
  const edgeOrder = graph.edges.map((e) => e.id);
  return {
    seq: new Sequence(4.7, beats, frozen),
    frame(t) {
      const f: Frame = { nodes: new Map(), edges: new Map(), ghost: 0, labels: [], words: [], camera: { ...HOME } };
      for (const w of words) {
        const appear = ease.out(span(t, w.delay, 0.7));
        let x = w.x0;
        let y = w.y0 + 10 * (1 - appear);
        let alpha = appear;
        let ink = 0;
        if (w.type) {
          ink = span(t, 1.2 + w.delay * 0.6, 0.4);
          const p = ease.inOut(span(t, 2.3, 1.1));
          const [nx, ny] = layout[graph.nodes.get(w.id!)!.name];
          x = lerp(x, nx, p);
          y = lerp(y, ny, p);
          alpha *= 1 - span(p, 0.75, 0.25);
        } else {
          alpha *= 0.9 * (1 - span(t, 1.3, 0.8));
        }
        f.words!.push({ ...w, x, y, alpha, ink });
      }
      for (const id of graph.nodes.keys()) f.nodes.set(id, { lit: span(t, 3.2, 0.3) });
      edgeOrder.forEach((id, j) => f.edges.set(id, { draw: ease.out(span(t, 3.5 + j * 0.02, 0.8)) }));
      return f;
    },
  };
}

// --- Extract: one document; its entities move into the graph -----------------------

export interface ExtractDom {
  spanRect(name: string): DOMRect | null;
  setSpanState(name: string, state: "idle" | "lit" | "lifted"): void;
  setParagraphs(visible: number): void;
  setRelations(visible: number): void;
}

export function extractScene(graph: Graph, engine: Engine, docId: string, prior: string[], dom: ExtractDom, frozen: number | null): Scene & { fusions: { alias: string; canonical: string; reason: string }[] } {
  const x = EXTRACTIONS.find((e) => e.document === docId)!;
  const doc = DOCUMENTS.find((d) => d.id === docId)!;
  const before = litBy(graph, prior);
  const names = [...new Set(x.entities.map((e) => e.name))];
  const typeOf = new Map(x.entities.map((e) => [e.name, e.type]));
  const idOf = (n: string) => lookup(graph.resolution, typeOf.get(n)!, n)!;
  const n = names.length;
  // Beat 1: the text appears. Beat 2: entities are marked. Beat 3: they move to the graph.
  // Beat 4 (if any): aliases join their entity. Beat 5: edges draw.
  const step = Math.min(0.1, 0.8 / n);
  const ign = names.map((_, i) => 0.6 + i * step);
  const E1 = 0.6 + n * step + 0.2;
  const lift = names.map((_, i) => E1 + i * 0.05);
  const FLY = 0.8;
  const arrive = lift.map((l) => l + FLY);
  const E2 = Math.max(...arrive) + 0.1;
  const aliases = names.filter((nm) => graph.nodes.get(idOf(nm))!.name !== nm);
  const fusions = aliases.map((a) => {
    const e = graph.nodes.get(idOf(a))!;
    return { alias: a, canonical: e.name, reason: e.merges.find((m) => m.alias === a)!.reason };
  });
  const F = E2;
  const E3 = aliases.length ? F + 1.1 : E2;
  const relEdges = x.relations.map((r) => `${idOf(r.source)}|${r.type}|${idOf(r.target)}`);
  const E4 = E3 + Math.min(1.1, relEdges.length * 0.1 + 0.6);
  const after = litBy(graph, [...prior, docId]);

  const beats: Beat[] = [
    { at: 0, caption: `Reading “${doc.title}”.` },
    { at: 0.6, caption: "The extractor marks each entity it finds." },
    { at: E1, caption: "Each entity becomes a node in the graph." },
    ...(aliases.length ? [{ at: F, caption: `Entity resolution: ${fusions.map((f) => `“${f.alias}” is ${f.canonical}`).join("; ")}.` }] : []),
    { at: E3, caption: `The relations in the text become edges: ${relEdges.length} from this document.` },
    { at: E4, caption: `The graph now holds ${after.nodes.size} entities and ${after.edges.size} relations.` },
  ];
  // The camera holds the whole graph; the document's entities are what change.
  const camera = { ...HOME };

  return {
    fusions,
    seq: new Sequence(E4 + 0.5, beats, frozen),
    frame(t) {
      const f = baseFrame(graph, prior);
      f.camera = camera;
      names.forEach((nm, i) => {
        const id = idOf(nm);
        const isAlias = aliases.includes(nm);
        const known = before.nodes.has(id);
        const hasPlainMention = names.some((o) => o !== nm && idOf(o) === id && !aliases.includes(o));
        const litAt = isAlias && !known && !hasPlainMention ? F + 0.8 : arrive[i];
        const cur = f.nodes.get(id) ?? { lit: 0 };
        f.nodes.set(id, { lit: Math.max(cur.lit, span(t, litAt - 0.1, 0.3)) });
        if (t < lift[i]) return;
        // The moving label: from its place in the text to its node.
        const rect = dom.spanRect(nm);
        const [ex, ey] = engine.nodeScreen(id);
        const [sx, sy] = rect ? [rect.left + rect.width / 2, rect.top + rect.height / 2] : [ex, ey + 60];
        const p = ease.inOut(span(t, lift[i], FLY));
        const hold: [number, number] = isAlias ? [ex, ey - 28] : [ex, ey];
        let lx = lerp(sx, hold[0], p);
        let ly = lerp(sy, hold[1], p);
        let alpha = 1;
        if (!isAlias) alpha = 1 - span(t, arrive[i] - 0.1, 0.2);
        else {
          // The alias waits above its entity, then slides into it.
          const q = ease.inOut(span(t, F, 0.8));
          lx = lerp(lx, ex, q);
          ly = lerp(ly, ey, q);
          alpha = 1 - span(t, F + 0.6, 0.25);
        }
        if (alpha > 0.01) f.labels.push({ text: nm, type: typeOf.get(nm)!, x: lx, y: ly, alpha });
      });
      relEdges.forEach((id, j) => {
        const d = ease.inOut(span(t, E3 + j * 0.1, 0.6));
        const cur = f.edges.get(id);
        f.edges.set(id, { draw: Math.max(cur?.draw ?? 0, d) });
      });
      return f;
    },
    dom(t) {
      dom.setParagraphs(t >= 0.05 ? doc.paragraphs.length : 0);
      names.forEach((nm, i) => dom.setSpanState(nm, t >= lift[i] ? "lifted" : t >= ign[i] ? "lit" : "idle"));
      dom.setRelations(relEdges.filter((_, j) => t >= E3 + j * 0.1).length);
    },
  };
}

// --- Merge: every name in the corpus resolves into the graph -----------------------

export function mergeScene(graph: Graph, engine: Engine, layout: Record<string, number[]>, frozen: number | null): Scene {
  const rnd = seeded(29);
  const mentions = EXTRACTIONS.flatMap((x) =>
    x.entities.map((e) => {
      const id = lookup(graph.resolution, e.type, e.name)!;
      const a = rnd() * 6.283;
      const r = 60 + rnd() * 40;
      return { name: e.name, type: e.type, id, ox: Math.cos(a) * r, oy: Math.sin(a) * r * 0.6, alias: graph.nodes.get(id)!.name !== e.name, delay: rnd() * 0.4 };
    }),
  );
  const groups = [...graph.nodes.values()].filter((e) => e.aliases.length);
  const G0 = 2.1;
  const GL = 1.1;
  const Ge = G0 + groups.length * GL;
  const beats: Beat[] = [
    { at: 0, caption: `${mentions.length} names came out of six documents. Many are the same thing, written differently.` },
    { at: 0.9, caption: "Identical names merge at once: “Telemetry Gateway” appears three times and becomes one node." },
    ...groups.map((g, i) => ({ at: G0 + i * GL, caption: `${g.aliases.map((a) => `“${a}”`).join(" and ")} → ${g.name}. Rule: ${g.merges[0].reason}.` })),
    { at: Ge, caption: `${mentions.length} names became ${graph.nodes.size} entities; ${EXTRACTIONS.reduce((s, x) => s + x.relations.length, 0)} relations became ${graph.edges.length} edges.` },
  ];
  return {
    seq: new Sequence(Ge + 1.2, beats, frozen),
    frame(t) {
      const f: Frame = { nodes: new Map(), edges: new Map(), ghost: 1, labels: [], camera: { ...HOME }, clipLabels: true };
      const gi = Math.floor((t - G0) / GL);
      // The entity being resolved is marked in the accent; the camera stays still.
      const focus = t >= G0 && gi < groups.length ? groups[gi].id : null;
      for (const m of mentions) {
        const [nx, ny] = layout[graph.nodes.get(m.id)!.name];
        const appear = ease.out(span(t, m.delay, 0.5));
        const g = groups.findIndex((e) => e.id === m.id);
        const start = m.alias ? G0 + g * GL : 0.9 + m.delay * 0.5;
        const p = ease.inOut(span(t, start, 0.8));
        const [sx, sy] = engine.toScreen(nx + m.ox * (1 - p), ny + m.oy * (1 - p));
        const alpha = appear * (1 - span(p, 0.75, 0.25));
        if (alpha > 0.01) f.labels.push({ text: m.name, type: m.type, x: sx, y: sy, alpha });
        const node = f.nodes.get(m.id) ?? { lit: 0 };
        node.lit = Math.max(node.lit, span(t, start + 0.7, 0.3));
        if (m.id === focus) node.hot = 1;
        f.nodes.set(m.id, node);
      }
      graph.edges.forEach((e, j) => f.edges.set(e.id, { draw: ease.inOut(span(t, Ge + j * 0.02, 0.7)) }));
      return f;
    },
  };
}

// --- Ask: the traversal, hop by hop, against chunk search -----------------------------

export interface AskDom {
  apply(t: number, times: { hops: number[]; verdict: number }): void;
}

export function askScene(graph: Graph, engine: Engine, r: Comparison, dom: AskDom, frozen: number | null): Scene {
  const H0 = 0.8;
  const HL = 1.1;
  const hopAt = r.hops.map((_, i) => H0 + i * HL);
  const V = H0 + r.hops.length * HL;
  const start = r.hops[0]?.from;
  const name = (id: string) => graph.nodes.get(id)!.name;
  const beats: Beat[] = [
    { at: 0, caption: start ? `The graph starts at the entity the question names: ${name(start)}.` : "No entity in the question." },
    ...r.hops.map((h, i) => ({ at: hopAt[i], caption: `Hop ${i + 1}: ${sentence(graph, h.edge)}.` })),
    { at: V, caption: `${r.verdict.headline}.` },
  ];
  return {
    seq: new Sequence(V + 1.0, beats, frozen),
    frame(t) {
      const f = baseFrame(graph, DOCUMENTS.map((d) => d.id), 0);
      if (start) f.nodes.set(start, { lit: 1, hot: span(t, 0.2, 0.3) });
      // The camera holds the whole graph; the path draws itself in the accent.
      f.camera = { ...HOME };
      r.hops.forEach((h, i) => {
        const s = hopAt[i];
        const edge = f.edges.get(h.edge.id)!;
        edge.path = Math.max(edge.path ?? 0, ease.inOut(span(t, s, 0.8)));
        edge.reverse = h.from !== h.edge.source;
        edge.label = true;
        const node = f.nodes.get(h.to)!;
        node.hot = Math.max(node.hot ?? 0, span(t, s + 0.7, 0.2));
      });
      return f;
    },
    dom(t) {
      dom.apply(t, { hops: hopAt, verdict: V });
    },
  };
}
