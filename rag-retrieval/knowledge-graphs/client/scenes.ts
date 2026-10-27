// The four scenes. Each is a timeline (beats with captions) and a function
// from time t to a Frame for the engine, plus optional DOM updates. Nothing
// here computes results: resolution, the graph, traversal and retrieval come
// from src/ and are only staged here.

import { DOCUMENTS, EXTRACTIONS } from "../src/data.ts";
import { sentence, type Graph } from "../src/graph.ts";
import { lookup } from "../src/resolve.ts";
import type { Comparison } from "../src/compare.ts";
import { Engine, HOME, type EdgeTarget, type Flash, type FlyLabel, type Frame, type HeroWord, type NodeTarget } from "./engine.ts";
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
    ghost: ghost * 0.55,
    labels: [],
    flashes: [],
    camera: { ...HOME },
  };
}

// --- Hero: words rise, lock into entities, snap into a constellation ----------

export function heroScene(graph: Graph, engine: Engine, layout: Record<string, number[]>, frozen: number | null): Scene {
  const beats: Beat[] = [
    { at: 0, caption: "Six documents from a fictional sensor maker." },
    { at: 1.4, caption: "An LLM picks out the entities: people, teams, products, parts, suppliers and customers." },
    { at: 2.6, caption: "Different names for the same thing fuse into one node." },
    { at: 4.0, caption: "The relations between them become a knowledge graph." },
  ];
  const rnd = seeded(11);
  const words: (HeroWord & { x0: number; y0: number; id: string | null; delay: number; arrive: number })[] = [];
  // Every entity mention, as written.
  EXTRACTIONS.forEach((x) =>
    x.entities.forEach((e) => {
      const id = lookup(graph.resolution, e.type, e.name)!;
      words.push({ text: e.name, type: e.type, id, x: 0, y: 0, x0: 40 + rnd() * 880, y0: 30 + rnd() * 600, alpha: 0, glow: 0, size: 15, delay: 0, arrive: 0 });
    }),
  );
  // Plain words from the documents that are not entities.
  const names = new Set(EXTRACTIONS.flatMap((x) => x.entities.map((e) => e.name.toLowerCase())));
  const filler = [...new Set(DOCUMENTS.flatMap((d) => d.paragraphs.join(" ").split(/[^A-Za-z]+/)).filter((w) => w.length > 4 && !names.has(w.toLowerCase())))];
  for (let i = 0; i < 46 && filler.length; i++) {
    const w = filler.splice(Math.floor(rnd() * filler.length), 1)[0];
    words.push({ text: w.toLowerCase(), type: null, id: null, x: 0, y: 0, x0: 20 + rnd() * 920, y0: 20 + rnd() * 620, alpha: 0, glow: 0, size: 13, delay: 0, arrive: 0 });
  }
  // Spread the words over a jittered grid so they don't pile on top of each other.
  const cols = 6;
  const rows = Math.ceil(words.length / cols);
  const cells = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  words.forEach((w, i) => {
    const c = cells[i];
    w.x0 = 80 + (c % cols) * (800 / (cols - 1)) + (rnd() - 0.5) * 40 + (Math.floor(c / cols) % 2 ? 40 : -40);
    w.y0 = 20 + Math.floor(c / cols) * (620 / (rows - 1)) + (rnd() - 0.5) * 12;
    w.delay = rnd() * 0.6;
    w.arrive = 2.6 + (i % 33) * 0.018 + 1.0;
  });
  const firstArrival = new Map<string, number>();
  for (const w of words) if (w.id) firstArrival.set(w.id, Math.min(firstArrival.get(w.id) ?? 99, w.arrive));
  const edgeOrder = graph.edges.map((e) => e.id);

  return {
    seq: new Sequence(5.4, beats, frozen),
    frame(t) {
      const f: Frame = { nodes: new Map(), edges: new Map(), ghost: 0, labels: [], flashes: [], worldFlashes: [], words: [], camera: { ...HOME } };
      for (const w of words) {
        const rise = ease.out(span(t, w.delay, 1.1));
        let x = w.x0;
        let y = w.y0 + 70 * (1 - rise);
        let alpha = rise * (w.type ? 0.95 : 0.6);
        let glow = 0;
        let size = w.size;
        if (w.type) {
          glow = ease.out(span(t, 1.4 + w.delay * 0.8, 0.6));
          const p = ease.inOut(span(t, w.arrive - 1.0, 1.0));
          const [nx, ny] = layout[graph.nodes.get(w.id!)!.name];
          x = lerp(x, nx, p);
          y = lerp(y, ny, p);
          size = lerp(15, 9, p);
          alpha *= 1 - span(p, 0.82, 0.18);
        } else {
          alpha *= 1 - 0.9 * span(t, 1.5, 0.9);
          alpha *= 1 - span(t, 2.6, 0.6);
        }
        f.words!.push({ ...w, x, y, alpha, glow, size });
      }
      for (const [id, at] of firstArrival) {
        f.nodes.set(id, { lit: span(t, at - 0.1, 0.35), flare: t >= at ? 1 - span(t, at, 0.6) : 0 });
      }
      // A ring where a second name lands on an existing node: the fusion.
      for (const w of words) {
        if (!w.id || w.arrive === firstArrival.get(w.id) || t < w.arrive || t > w.arrive + 0.6) continue;
        const k = span(t, w.arrive, 0.6);
        f.worldFlashes!.push({ id: w.id, r: 10 + 38 * k, alpha: 1 - k });
      }
      edgeOrder.forEach((id, j) => f.edges.set(id, { draw: ease.out(span(t, 4.0 + j * 0.05, 0.6)) }));
      return f;
    },
  };
}

// --- Extract: one document ignites, its entities fly into the graph -------------

export interface ExtractDom {
  spanRect(name: string): DOMRect | null; // first mention of a name in the shown document
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
  const step = Math.min(0.12, 0.9 / n);
  const ign = names.map((_, i) => 0.6 + i * step);
  const E1 = 0.6 + n * step + 0.25;
  const lift = names.map((_, i) => E1 + i * 0.09);
  const FLY = 0.85;
  const arrive = lift.map((l) => l + FLY);
  const E2 = Math.max(...arrive) + 0.15;
  const aliases = names.filter((nm) => graph.nodes.get(idOf(nm))!.name !== nm);
  const fusions = aliases.map((a) => {
    const e = graph.nodes.get(idOf(a))!;
    return { alias: a, canonical: e.name, reason: e.merges.find((m) => m.alias === a)!.reason };
  });
  const F = E2;
  const E3 = aliases.length ? F + 1.3 : E2;
  const relEdges = x.relations.map((r) => `${idOf(r.source)}|${r.type}|${idOf(r.target)}`);
  const E4 = E3 + relEdges.length * 0.12 + 0.7;
  const docIds = [...new Set(names.map(idOf))];

  const fuseText = fusions.map((f) => `“${f.alias}” is ${f.canonical}`).join("; ");
  const beats: Beat[] = [
    { at: 0, caption: `Reading “${doc.title}”.` },
    { at: 0.6, caption: "The extractor marks every entity it finds. Colour shows the type." },
    { at: E1, caption: "Each entity lifts off the page and becomes a node in the graph." },
    ...(aliases.length ? [{ at: F, caption: `Entity resolution: ${fuseText}. The names fuse into one node.` }] : []),
    { at: E3, caption: `The relations stated in the text become edges: ${relEdges.length} from this document.` },
  ];
  const camera = engine.fit([...docIds], 1.25);

  return {
    fusions,
    seq: new Sequence(E4 + 0.2, beats, frozen),
    frame(t) {
      const f = baseFrame(graph, prior);
      f.camera = camera;
      names.forEach((nm, i) => {
        const id = idOf(nm);
        const isAlias = aliases.includes(nm);
        const known = before.nodes.has(id);
        const fuseAt = F + 0.7;
        const litAt = isAlias && !known && !names.some((o) => o !== nm && idOf(o) === id && !aliases.includes(o)) ? fuseAt : arrive[i];
        const cur = f.nodes.get(id) ?? { lit: 0 };
        const lit = Math.max(cur.lit, span(t, litAt - 0.05, 0.3));
        const flare = Math.max(cur.flare ?? 0, t >= arrive[i] && !isAlias ? 1 - span(t, arrive[i], 0.6) : 0, isAlias && t >= fuseAt ? 1 - span(t, fuseAt, 0.7) : 0);
        f.nodes.set(id, { lit, flare });

        // The flying label.
        if (t < lift[i]) return;
        const rect = dom.spanRect(nm);
        const [ex, ey] = engine.nodeScreen(id);
        const [sx, sy] = rect ? [rect.left + rect.width / 2, rect.top + rect.height / 2] : [ex, ey + 80];
        const p = ease.inOut(span(t, lift[i], FLY));
        const hold = isAlias ? [ex, ey - 34] : [ex, ey];
        const cx = (sx + hold[0]) / 2;
        const cy = Math.min(sy, hold[1]) - 90;
        let lx = (1 - p) * (1 - p) * sx + 2 * (1 - p) * p * cx + p * p * hold[0];
        let ly = (1 - p) * (1 - p) * sy + 2 * (1 - p) * p * cy + p * p * hold[1];
        let alpha = 1;
        let size = lerp(14, 12, p);
        if (!isAlias) alpha = 1 - span(t, arrive[i], 0.25);
        else {
          const q = ease.inOut(span(t, F, 0.7));
          lx = lerp(lx, ex, q);
          ly = lerp(ly, ey, q);
          size = lerp(12, 9, q);
          alpha = 1 - span(t, F + 0.6, 0.2);
          if (t >= fuseAt) {
            const k = span(t, fuseAt, 0.7);
            f.flashes.push({ x: ex, y: ey, r: 12 + 60 * ease.out(k), alpha: 1 - k, type: typeOf.get(nm)! } as Flash);
          }
        }
        if (alpha > 0.01) f.labels.push({ text: nm, type: typeOf.get(nm)!, x: lx, y: ly, alpha, size, glow: 1 - span(p, 0.6, 0.4) * 0.5 } as FlyLabel);
      });
      relEdges.forEach((id, j) => {
        const d = ease.out(span(t, E3 + j * 0.12, 0.6));
        const cur = f.edges.get(id);
        f.edges.set(id, { draw: Math.max(cur?.draw ?? 0, d), pulse: d > 0 && d < 1 ? d : undefined });
      });
      return f;
    },
    dom(t) {
      dom.setParagraphs(Math.floor(span(t, 0, 0.6) * doc.paragraphs.length + (t >= 0.6 ? 1 : 0.0001)));
      names.forEach((nm, i) => dom.setSpanState(nm, t >= lift[i] ? "lifted" : t >= ign[i] ? "lit" : "idle"));
      dom.setRelations(relEdges.filter((_, j) => t >= E3 + j * 0.12).length);
    },
  };
}

// --- Merge: every name in the corpus resolves into the graph ----------------------

export function mergeScene(graph: Graph, engine: Engine, layout: Record<string, number[]>, frozen: number | null): Scene {
  const rnd = seeded(29);
  const mentions = EXTRACTIONS.flatMap((x) =>
    x.entities.map((e) => {
      const id = lookup(graph.resolution, e.type, e.name)!;
      const a = rnd() * 6.283;
      const r = 70 + rnd() * 60;
      return { name: e.name, type: e.type, id, ox: Math.cos(a) * r, oy: Math.sin(a) * r * 0.7, alias: graph.nodes.get(id)!.name !== e.name, delay: rnd() * 0.5 };
    }),
  );
  const groups = [...graph.nodes.values()].filter((e) => e.aliases.length);
  const G0 = 2.6;
  const GL = 1.25;
  const Ge = G0 + groups.length * GL;
  const beats: Beat[] = [
    { at: 0, caption: `${mentions.length} names came out of six documents. Many are the same thing written differently.` },
    { at: 1.1, caption: "Identical names merge at once: “Telemetry Gateway” appears in three documents and becomes one node." },
    ...groups.map((g, i) => ({
      at: G0 + i * GL,
      caption: `${g.aliases.map((a) => `“${a}”`).join(" and ")} → ${g.name} · ${g.merges[0].reason}.`,
    })),
    { at: Ge, caption: `${mentions.length} names became ${graph.nodes.size} entities. ${EXTRACTIONS.reduce((s, x) => s + x.relations.length, 0)} relations became ${graph.edges.length} edges, because two were stated twice.` },
  ];
  return {
    seq: new Sequence(Ge + 1.5, beats, frozen),
    frame(t) {
      const f: Frame = { nodes: new Map(), edges: new Map(), ghost: 0.55, labels: [], flashes: [], camera: { ...HOME }, clipLabels: true };
      const gi = Math.floor((t - G0) / GL);
      if (t >= G0 && gi < groups.length) f.camera = { ...engine.fit([groups[gi].id], 1.7) };
      for (const m of mentions) {
        const [nx, ny] = layout[graph.nodes.get(m.id)!.name];
        const appear = ease.out(span(t, m.delay, 0.6));
        const g = groups.findIndex((e) => e.id === m.id);
        const start = m.alias ? G0 + g * GL : 1.1 + m.delay;
        const p = ease.inOut(span(t, start, m.alias ? 0.75 : 0.9));
        const wx = nx + m.ox * (1 - p);
        const wy = ny + m.oy * (1 - p);
        const [sx, sy] = engine.toScreen(wx, wy);
        const alpha = appear * (1 - span(p, 0.8, 0.2));
        if (alpha > 0.01) f.labels.push({ text: m.name, type: m.type, x: sx, y: sy, alpha, size: 12, glow: m.alias ? 1 : 0.5 });
        const arrive = start + (m.alias ? 0.75 : 0.9);
        const node = f.nodes.get(m.id) ?? { lit: 0, flare: 0 };
        node.lit = Math.max(node.lit, span(t, arrive - 0.1, 0.3));
        if (t >= arrive) node.flare = Math.max(node.flare ?? 0, 1 - span(t, arrive, 0.7));
        f.nodes.set(m.id, node);
        if (m.alias && t >= arrive && t < arrive + 0.8) {
          const k = span(t, arrive, 0.8);
          const [ex, ey] = engine.nodeScreen(m.id);
          f.flashes.push({ x: ex, y: ey, r: 14 + 70 * ease.out(k), alpha: 1 - k, type: m.type });
        }
      }
      graph.edges.forEach((e, j) => f.edges.set(e.id, { draw: ease.out(span(t, Ge + j * 0.04, 0.6)) }));
      return f;
    },
  };
}

// --- Ask: the traversal, hop by hop, against chunk search -------------------------

export interface AskDom {
  apply(t: number, times: { hops: number[]; verdict: number }): void;
}

export function askScene(graph: Graph, engine: Engine, r: Comparison, dom: AskDom, frozen: number | null): Scene {
  const H0 = 1.0;
  const HL = 1.15;
  const hopAt = r.hops.map((_, i) => H0 + i * HL);
  const V = H0 + r.hops.length * HL;
  const start = r.hops[0]?.from;
  const name = (id: string) => graph.nodes.get(id)!.name;
  const beats: Beat[] = [
    { at: 0, caption: start ? `The graph starts at the entity the question names: ${name(start)}.` : "No entity in the question." },
    ...r.hops.map((h, i) => ({ at: hopAt[i], caption: `Hop ${i + 1}: ${sentence(graph, h.edge)}.` })),
    { at: V, caption: r.verdict.headline + "." },
  ];
  const path = [...new Set(r.hops.flatMap((h) => [h.from, h.to]))];
  // When the verdict lands it covers the lower part of the graph, so frame the path above it.
  const fitted = engine.fit(path, 1.4);
  const finalCam = { ...fitted, y: fitted.y + 115 / fitted.z };
  return {
    seq: new Sequence(V + 1.4, beats, frozen),
    frame(t) {
      const f = baseFrame(graph, DOCUMENTS.map((d) => d.id), 0);
      if (start) f.nodes.set(start, { lit: 1, hot: span(t, 0.2, 0.4), flare: t < 1 ? 1 - span(t, 0.4, 0.6) : 0 });
      f.camera = start ? { ...engine.fit([start], 1.6) } : { ...HOME };
      r.hops.forEach((h, i) => {
        const s = hopAt[i];
        const pulse = span(t, s, 0.75);
        const edge = f.edges.get(h.edge.id)!;
        edge.hot = Math.max(edge.hot ?? 0, span(t, s + 0.55, 0.3));
        edge.label = t >= s + 0.4;
        if (t >= s && pulse < 1) {
          edge.pulse = pulse;
          edge.reverse = h.from !== h.edge.source;
        }
        const arrived = s + 0.75;
        const node = f.nodes.get(h.to)!;
        node.hot = Math.max(node.hot ?? 0, span(t, arrived - 0.1, 0.3));
        if (t >= arrived) node.flare = Math.max(node.flare ?? 0, 1 - span(t, arrived, 0.6));
        if (t >= s && t < V) {
          const [ax, ay] = engine.pos(h.from);
          const [bx, by] = engine.pos(h.to);
          const k = ease.inOut(span(t, s, 1.0));
          f.camera = { x: lerp(ax, bx, k), y: lerp(ay, by, k), z: 1.55 };
        }
      });
      if (t >= V) f.camera = finalCam;
      return f;
    },
    dom(t) {
      dom.apply(t, { hops: hopAt, verdict: V });
    },
  };
}
