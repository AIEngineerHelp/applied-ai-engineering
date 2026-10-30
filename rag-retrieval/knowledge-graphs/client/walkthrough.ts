// The walkthrough: six documents, the merge, and the question, side by side.
// Each scene is rendered once when it starts; everything that moves is a CSS
// animation with a start time (--d, script ms). One clock (clock.ts) drives them
// all through playbackRate, so the speed control scales every delay, and ?t=<ms>
// freezes any moment for review.
//
// The reader always wins: Previous, Next and the scene list pause autoplay, and
// any wheel, touch, key or pointer press in a pane stops auto-scrolling for the
// rest of the scene. Auto-scrolls happen only at scheduled reveal times, never
// per frame, and never from hover.

import { graphSvg, glyph, pathSvg } from "./graph-svg.ts";
import { SceneClock, parseSpeed, SPEEDS } from "./clock.ts";
import { answers, docById, esc, graph, layout, longDate, MAIN, methodOf, nodeByName, plural, questionById, resolution, review, run1 } from "./data.ts";
import type { Triple } from "../src/schema.ts";

const SCENE_DOCS = ["atlas-3-brief", "supplier-register", "key-accounts", "brightwater-order", "meridian-launch", "battery-switch"];
const LEDES: Record<string, string> = {
  "atlas-3-brief": "A product brief arrives. Gemini reads it and lists the parts inside the Atlas-3, where it is built and how it uploads.",
  "supplier-register": "The supplier register arrives. It names the company that makes the QX-7, but as “Varnell Semi”.",
  "key-accounts": "The February account list arrives. It says which customers run which product, and how many units.",
  "brightwater-order": "An order email arrives. The product is written “A3”, a name no rule can match to “Atlas-3”.",
  "meridian-launch": "The Meridian launch note arrives. It uses the same chip, written “QX7 modem”, and calls the gateway “TGW”.",
  "battery-switch": "An engineering note arrives. The Atlas-3 changes battery cell, and here the model makes a real mistake.",
};
const MERGE_SCENE = SCENE_DOCS.length + 1;
const ASK_SCENE = SCENE_DOCS.length + 2;
const SCENES = ASK_SCENE + 1;

const params = new URLSearchParams(location.search);
const FROZEN = params.has("t") ? Math.max(0, Number(params.get("t")) || 0) : null;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;
if (FROZEN !== null) {
  root.classList.add("frozen");
  root.style.setProperty("--t", String(FROZEN));
}
const $ = (id: string) => document.getElementById(id)!;

function initialSpeed(): number {
  const fromUrl = parseSpeed(params.get("speed"));
  if (fromUrl) return fromUrl;
  try {
    return parseSpeed(localStorage.getItem("kg-speed")) ?? 1;
  } catch {
    return 1;
  }
}
const clock = new SceneClock(() => performance.now(), initialSpeed());
let scene = 0;
let playing = false;
let started = false;
let len = Infinity;
const sceneTime = () => (FROZEN !== null ? FROZEN : REDUCED ? 1e7 : clock.time());

// ---------------------------------------------------------------- marking a document

interface Mark {
  start: number;
  end: number;
  kind: "quote" | "ent";
  n?: number[]; // relation numbers for a quote
  at: number; // script time it appears
  glyph?: string;
}

/** The document's paragraphs with quotes highlighted (numbered) and entity names underlined. */
function markedDoc(docId: string, triples: (Triple & { n: number; at: number })[], entities: { name: string; type: string }[], entAt: number): string {
  const d = docById(docId);
  return d.paragraphs
    .map((p) => {
      const marks: Mark[] = [];
      const byQuote = new Map<string, (Triple & { n: number; at: number })[]>();
      for (const t of triples) byQuote.set(t.quote, [...(byQuote.get(t.quote) ?? []), t]);
      for (const [q, ts] of byQuote) {
        const i = p.indexOf(q);
        if (i >= 0) marks.push({ start: i, end: i + q.length, kind: "quote", n: ts.map((t) => t.n), at: Math.min(...ts.map((t) => t.at)) });
      }
      for (const e of entities) {
        let i = p.indexOf(e.name);
        while (i >= 0) {
          const end = i + e.name.length;
          const word = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
          if (!word(p[i - 1]) && !word(p[end]) && !marks.some((m) => m.kind === "ent" && i < m.end && end > m.start)) marks.push({ start: i, end, kind: "ent", at: entAt, glyph: glyph(e.type) });
          i = p.indexOf(e.name, i + 1);
        }
      }
      // Cut the paragraph at every mark boundary; each piece knows which marks cover it.
      const cuts = [...new Set([0, p.length, ...marks.flatMap((m) => [m.start, m.end])])].sort((a, b) => a - b);
      let html = "";
      for (let k = 0; k < cuts.length - 1; k++) {
        const [a, b] = [cuts[k], cuts[k + 1]];
        let piece = esc(p.slice(a, b));
        const ent = marks.find((m) => m.kind === "ent" && m.start <= a && b <= m.end);
        if (ent) piece = `<span class="ent-m" data-glyph="${ent.start === a ? ent.glyph : ""}">${piece}</span>`;
        const quotes = marks.filter((m) => m.kind === "quote" && m.start <= a && b <= m.end);
        for (const q of quotes) {
          const badge = q.start === a ? q.n!.map((n) => `<span class="lnum">${n}</span>`).join("") : "";
          piece = `<span class="src-hl" style="--d:${q.at}" data-link="${q.n!.join(" ")}">${badge}${piece}</span>`;
        }
        html += piece;
      }
      return `<p class="b-p">${html}</p>`;
    })
    .join("");
}

// ---------------------------------------------------------------- scenes

interface Rendered {
  caption: { kicker: string; line: string };
  did: string[];
  didLabel: string;
  len: number;
}

const seenUpTo = (k: number) => SCENE_DOCS.slice(0, k);

function marginGraph(docsSeen: string[], newDoc: string | null, at: number): string {
  const inSeen = (doc: string) => docsSeen.includes(doc);
  const edges = graph.edges.filter((e) => e.mentions.some((m) => inSeen(m.doc)));
  const nodes = new Set(edges.flatMap((e) => [e.source, e.target]));
  const freshEdges = newDoc ? edges.filter((e) => e.mentions.every((m) => !inSeen(m.doc) || m.doc === newDoc) && e.mentions.some((m) => m.doc === newDoc)) : [];
  const earlier = new Set(graph.edges.filter((e) => e.mentions.some((m) => inSeen(m.doc) && m.doc !== newDoc)).flatMap((e) => [e.source, e.target]));
  const freshNodes = [...nodes].filter((id) => !earlier.has(id));
  const svg = graphSvg(graph, layout, {
    nodes,
    edges: edges.map((e) => e.id),
    label: freshNodes.length ? freshNodes : [...nodes],
    size: 36,
    r: 12,
    accent: new Set(freshNodes),
    nodeAt: new Map(freshNodes.map((id, i) => [id, at + i * 120])),
    edgeAt: new Map(freshEdges.map((e, i) => [e.id, at + 300 + i * 150])),
    ghosts: graph.nodes.map((n) => n.id).filter((id) => !nodes.has(id)),
    title: "The graph so far",
  });
  return `${svg}<div class="gkey">${["Person", "Team", "Customer", "Product", "Service", "Site", "Component", "Incident", "Company"].map((t) => `<span><b>${glyph(t)}</b>${t}</span>`).join("")}</div>
    <p class="caption mt-3">${plural(nodes.size, "entity", "entities")} and ${plural(edges.length, "edge")} from the documents so far. New ones are blue; faint dots are entities later documents will add.</p>`;
}

function renderExtract(k: number): Rendered {
  const docId = SCENE_DOCS[k - 1];
  const d = docById(docId);
  const x = run1.docs.find((r) => r.doc === docId)!;
  const entAt = 300;
  const triples = x.triples.map((t, i) => ({ ...t, n: i + 1, at: 900 + i * 1000 }));
  $("src").innerHTML = `<article class="page seq" style="--d:0"><div class="page-path">${esc(d.kind)} · ${longDate(d.date)}</div><h1>${esc(d.title)}</h1>${markedDoc(docId, triples, x.entities, entAt)}</article>`;
  const wrong = review.wrong.filter((w) => w.doc === docId);
  const unsupported = review.unsupported.filter((w) => w.doc === docId);
  const typeErr = review.typeErrors.filter((w) => w.doc === docId);
  const spurious = review.spurious.filter((w) => w.doc === docId);
  const flag = (t: Triple) => wrong.find((w) => w.source === t.source && w.relation === t.relation && w.target === t.target) ?? unsupported.find((w) => w.source === t.source && w.relation === t.relation && w.target === t.target);
  const clusterOf = (name: string, type: string) => resolution.reviewed.clusters.find((c) => c.type === type && c.members.some((m) => m.name === name));
  const ents = x.entities
    .map((e) => {
      const bad = typeErr.find((t) => t.name === e.name) ?? spurious.find((s) => s.name === e.name);
      return `<span data-glyph="${glyph(e.type)}" class="${bad ? "bad" : ""}" title="${esc(e.type)}">${esc(e.name)} <span class="caption">${e.type}</span></span>`;
    })
    .join("");
  const rows = triples
    .map((t) => {
      const f = flag(t);
      const props = Object.entries(t.properties).map(([k, v]) => `${k}: ${v}`).join(", ");
      return `<div class="triple chg${f ? " bad" : ""}" style="--d:${t.at + 500}" data-link="${t.n}"><span class="gutter"><span class="lnum">${t.n}</span></span>
        <span class="t-ent" data-glyph="${glyph(t.sourceType)}">${esc(t.source)}</span><span class="t-rel">${t.relation}</span><span class="t-ent" data-glyph="${glyph(t.targetType)}">${esc(t.target)}</span>${props ? `<span class="t-props">{${esc(props)}}</span>` : ""}
        ${f ? `<span class="t-note">${wrong.includes(f as never) ? "Wrong" : "Not stated"}: ${esc(f.why)}</span>` : ""}</div>`;
    })
    .join("");
  const last = triples.length ? triples[triples.length - 1].at + 1000 : 1200;
  $("out").innerHTML = `<article class="page seq" style="--d:150"><div class="page-path">results/extraction/run-1.json · ${esc(run1.model)}</div><h1>Extracted facts</h1>
    <div class="b-h2">Entities <span class="tag-measured">measured</span></div><div class="entity-list seq" style="--d:${entAt}">${ents}</div>
    <div class="b-h2">Relations, each with its quote</div>${rows || '<p class="b-p caption">No relations.</p>'}
    ${typeErr.length || spurious.length ? `<div class="b-h2">Review</div>${[...typeErr.map((t) => `“${t.name}” typed as ${t.extractedAs}, should be ${t.should}. ${t.why}`), ...spurious.map((s) => `“${s.name}” is not a real ${s.type.toLowerCase()}. ${s.why}`)].map((n) => `<p class="b-p chg" style="--d:${last}">${esc(n)}</p>`).join("")}` : ""}
  </article>`;
  setLabels("Document", `corpus/${docId}.md`, "Extracted by Gemini", `${plural(x.entities.length, "entity", "entities")} · ${plural(x.triples.length, "relation")}`);
  const mapAt = last + 200;
  $("margin-body").innerHTML = marginGraph(seenUpTo(k), docId, mapAt);
  $("margin-title").textContent = "The graph so far";
  $("doc-note").innerHTML = `<span class="tag-measured">measured</span> The facts are Gemini's recorded output (run 1 of 3), not written by hand. Mistakes are marked from the author's review.`;
  const aliases = x.entities.map((e) => ({ e, c: clusterOf(e.name, e.type) })).filter(({ e, c }) => c && c.name !== e.name);
  const did = [
    `Extracted ${plural(x.entities.length, "entity", "entities")} and ${plural(x.triples.length, "relation")}; code checked each quote is in the document (${plural(x.rejects.length, "reject")}).`,
    ...aliases.map(({ e, c }) => `“${e.name}” later merges into ${c!.name} (${c!.members.find((m) => m.name === e.name)!.how.replace(/^rule: /, "rule, ").replace(/^llm: confirmed/, "LLM confirmed").replace(/^person: approved/, "a person approved")}).`),
    ...wrong.map(() => "One relation is wrong: the model kept a replaced part as a current part."),
  ];
  return { caption: { kicker: `Document ${k} of ${SCENE_DOCS.length} · ${longDate(d.date)}`, line: LEDES[docId] }, did, didLabel: "What happened", len: mapAt + 2500 + 3500 };
}

function renderMerge(): Rendered {
  const before = resolution.evaluation;
  const after = resolution.reviewed.evaluation;
  const merged = resolution.reviewed.clusters.filter((c) => c.members.length > 1);
  const howLabel = (h: string) => (h.startsWith("rule") ? "rule" : h.startsWith("llm") ? "LLM" : h.startsWith("person") ? "person" : "");
  let at = 300;
  const items = merged.map((c, i) => {
    const t = at;
    at += 450;
    return { c, n: i + 1, at: t };
  });
  $("src").innerHTML = `<article class="page seq" style="--d:0"><div class="page-path">results/resolution.json</div><h1>Names that became one entity</h1>
    ${items
      .map(
        ({ c, n, at: t }) => `<div class="triple chg" style="--d:${t}" data-link="${n}"><span class="gutter"><span class="lnum">${n}</span></span><span class="t-ent" data-glyph="${glyph(c.type)}">${esc(c.name)}</span>
      <span class="t-props">${c.members
        .filter((m) => m.name !== c.name)
        .map((m) => `“${esc(m.name)}” · ${howLabel(m.how)}`)
        .join(" &nbsp; ")}</span></div>`,
      )
      .join("")}</article>`;
  const checked = resolution.pairs.filter((p) => p.decision !== "not checked");
  const same = checked.filter((p) => p.decision === "same");
  const approved = resolution.review.filter((r) => r.decision === "same");
  $("out").innerHTML = `<article class="page seq" style="--d:150"><h1>How each merge was decided</h1>
    <div class="b-h2">1 · Rules (code)</div><p class="b-p chg" style="--d:${at}">Same type, and the names match after normalising case and punctuation, or one is an abbreviation or initials of the other: “Varnell Semi” → Varnell Semiconductor, “T. Berg” → Tomas Berg. A name that fits two entities is refused.</p>
    <div class="b-h2">2 · Embeddings, then the LLM <span class="tag-measured">measured</span></div><p class="b-p chg" style="--d:${at + 700}">${plural(checked.length, "pair")} of same-type names were similar enough to check. Gemini said “same” for ${same.map((p) => `“${esc(p.b)}” = ${esc(p.a)}`).join(" and ")}, “unsure” for ${resolution.queue.length}, and “different” for the rest.</p>
    <div class="b-h2">3 · A person <span class="tag-scripted">by hand</span></div><p class="b-p chg" style="--d:${at + 1400}">The author decided the ${resolution.queue.length} unsure pairs: ${approved.map((r) => `“${esc(r.b)}” = ${esc(r.a)}`).join(" and ")} merged; the rest stayed apart.</p>
    <div class="b-h2">Checked against the gold list <span class="tag-measured">measured</span></div><p class="b-p chg" style="--d:${at + 2100}">Before the person's review: ${plural(before.falseSplits.length, "false split")} (${before.falseSplits.map((s) => s.gold).join(", ")}), ${plural(before.falseMerges.length, "false merge")}. After: ${plural(after.falseSplits.length, "false split")}, ${plural(after.falseMerges.length, "false merge")}, ${plural(after.clusters, "entity", "entities")} from ${after.surfaces} names. Without the type rule, the same name rules would have merged ${resolution.withoutTypeGuard.map((w) => w.members.map((m) => `“${esc(m.name)}”`).join(" and ")).join("; ")}.</p>
  </article>`;
  setLabels("Entity resolution", `${after.surfaces} names → ${after.clusters} entities`, "Decisions", "rules, LLM, person");
  const ringAt = new Map(items.map(({ c, at: t }) => [c.id, t + 200]));
  $("margin-body").innerHTML = `${graphSvg(graph, layout, { nodes: graph.nodes.map((n) => n.id), edges: graph.edges.map((e) => e.id), label: [], size: 44, r: 12, accent: new Set(items.map((i) => i.c.id)), ringAt, title: "The merged graph" })}
    <p class="caption mt-3">The whole graph: ${plural(graph.nodes.length, "entity", "entities")}, ${plural(graph.edges.length, "edge")}. Ringed: entities merged from several names.</p>`;
  $("margin-title").textContent = "The merged graph";
  $("doc-note").innerHTML = `<span class="tag-measured">measured</span> Embeddings and the LLM's decisions are recorded runs; the person's decisions were written by the author (data/review.json).`;
  return {
    caption: { kicker: "Merge · all 25 documents", line: `Twenty-five documents gave ${after.surfaces} names. Different names for the same thing are merged in three stages: rules, then the LLM, then a person.` },
    did: [`${merged.length} entities were merged from several names.`, `The LLM checked ${checked.length} pairs and merged ${same.length}; a person settled ${resolution.queue.length} it was unsure about.`, `Without the person, “A3” would have stayed apart from the Atlas-3, cutting Brightwater out of every Atlas-3 question.`],
    didLabel: "What happened",
    len: at + 2100 + 6000,
  };
}

function renderAsk(): Rendered {
  const q = questionById(MAIN);
  const vec = methodOf(MAIN, "vector");
  const cy = methodOf(MAIN, "cypher");
  const att = cy.attempts![cy.attempts!.length - 1];
  const rows = cy.rows ?? [];
  $("src").innerHTML = `<article class="page seq" style="--d:0"><h1>Chunk search</h1><div class="page-sub">The three paragraphs closest to the question (${esc(answers.embeddingModel)}).</div>
    ${vec.passages!.map((p, i) => `<div class="b-claim chg" style="--d:${300 + i * 500}"><span class="ck">${i + 1} · ${esc(p.title)} · similarity ${p.score}</span><span class="cv">${esc(p.text)}</span></div>`).join("")}
    <p class="b-p chg" style="--d:1900"><strong>${vec.context.found} of ${vec.context.of}</strong> facts the answer needs. None of these paragraphs names a customer.</p></article>`;
  const hopAt = [2600, 3300];
  const svg = pathSvg("QX-7 radio chip", rows as { customer: string; product: string }[], { partOf: hopAt[0], uses: hopAt[1] });
  $("out").innerHTML = `<article class="page seq" style="--d:150"><h1>Graph traversal</h1><div class="page-sub">Gemini wrote this Cypher; the guard checked it; Neo4j ran it read-only.</div>
    <pre class="cypher chg" style="--d:700">${esc(att.cypher)}</pre>
    <div class="chg" style="--d:1600">${svg}</div>
    <p class="b-p chg" style="--d:${(hopAt[hopAt.length - 1] ?? 2600) + 800}"><strong>${cy.context.found} of ${cy.context.of}</strong> facts: ${rows.map((r) => esc(String(r.customer ?? Object.values(r)[0]))).join(", ")}.</p></article>`;
  setLabels("Chunk search", "embeddings, top 3", "Knowledge graph", "Neo4j, read-only");
  const done = (hopAt[hopAt.length - 1] ?? 2600) + 1400;
  $("margin-body").innerHTML = `<div class="seq" style="--d:${done}"><p class="label">The answer, written from the rows</p><p class="answer">${esc(cy.answer ?? "")}</p>
    <table class="rtable mt-6"><tr><td>Knowledge graph</td><td class="num full">${cy.context.found} / ${cy.context.of}</td></tr><tr><td>Chunk search</td><td class="num none">${vec.context.found} / ${vec.context.of}</td></tr></table></div>`;
  $("margin-title").textContent = "Result";
  $("doc-note").innerHTML = `<span class="tag-measured">measured</span> The query, its rows, the passages and both scores are recorded runs. The path is drawn from the rows.`;
  return {
    caption: { kicker: "Ask · the question again", line: esc(q.question) },
    did: [`The graph starts at the QX-7 radio chip, follows PART_OF to two products and USES back to their customers.`, `Chunk search returns paragraphs about the chip's suppliers and the delay: similar words, no customers.`],
    didLabel: "What happened",
    len: done + 6000,
  };
}

function renderIntro(): Rendered {
  $("src").innerHTML = `<article class="page seq" style="--d:0"><h1>Six of the 25 documents</h1><div class="page-sub">Never edited. The model only reads them.</div>
    <ol class="src-index mt-4">${SCENE_DOCS.map((id, i) => `<li><button type="button" data-scene="${i + 1}">${esc(docById(id).title)}<span class="d">${docById(id).date} · corpus/${id}.md</span></button></li>`).join("")}</ol></article>`;
  $("out").innerHTML = `<article class="page seq" style="--d:150"><h1>An empty graph</h1>
    <div class="b-p">Press Play. Each document opens on the left, and the facts Gemini extracted from it appear on the right, one at a time.</div>
    <div class="b-p">A number such as <span class="lnum">1</span> joins a highlighted sentence in the document to the fact it produced. Hover or tap either one to see both.</div></article>`;
  setLabels("Documents", "corpus/", "Extracted facts", "");
  $("margin-body").innerHTML = `<p class="caption">The graph appears with the first document.</p>`;
  $("margin-title").textContent = "The graph so far";
  $("doc-note").textContent = "";
  return { caption: { kicker: "Before the first document", line: "The graph is empty. Six documents are waiting to be read." }, did: [], didLabel: "", len: Infinity };
}

function setLabels(a: string, ap: string, b: string, bp: string) {
  $("src-label").textContent = a;
  $("src-path").textContent = ap;
  $("out-label").textContent = b;
  $("out-path").textContent = bp;
}

// ---------------------------------------------------------------- playback

function enter(i: number) {
  scene = Math.max(0, Math.min(SCENES - 1, i));
  clock.restart();
  const r = scene === 0 ? renderIntro() : scene === MERGE_SCENE ? renderMerge() : scene === ASK_SCENE ? renderAsk() : renderExtract(scene);
  len = r.len;
  $("caption").innerHTML = `<div class="beat-kicker">${esc(r.caption.kicker)}</div><div class="beat-line">${r.caption.line}</div>`;
  $("did").innerHTML = r.did.length ? `<span class="did-label">${r.didLabel}</span><ul>${r.did.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : "";
  $("src").scrollTop = 0;
  $("out").scrollTop = 0;
  renderChrome();
  applyRate();
  scheduleFollow();
  tick();
}

const CHAPTERS = ["Product brief", "Suppliers", "Accounts", "Order email", "Meridian", "Battery note"];
function renderChrome() {
  const act = scene === MERGE_SCENE ? ["Step two", "Merge"] : scene === ASK_SCENE ? ["Step three", "Ask"] : ["Step one", "Extract"];
  $("act-num").textContent = act[0];
  $("act-title").textContent = act[1];
  const chap = (i: number, label: string) => {
    const state = i < scene ? "done" : i === scene ? "now" : "todo";
    return `<li><button type="button" class="chap" data-scene="${i}" data-state="${state}" ${i === scene ? 'aria-current="step"' : ""}>${label}</button></li>`;
  };
  $("chapters").innerHTML = [...CHAPTERS.map((l, k) => chap(k + 1, l)), `<li class="chap-sep" aria-hidden="true">/</li>`, chap(MERGE_SCENE, "Merge"), chap(ASK_SCENE, "Ask"), `<li class="chap-sep" aria-hidden="true">/</li>`, `<li><a class="chap" href="#payoff">Results</a></li>`].join("");
  ($("prev") as HTMLButtonElement).disabled = scene === 0;
  $("next").textContent = scene === ASK_SCENE ? "See all results →" : "Next →";
  renderPlay();
}

function applyRate() {
  if (FROZEN !== null || REDUCED || !document.getAnimations) return;
  for (const a of document.getAnimations()) a.playbackRate = clock.speed;
}

function renderPlay() {
  const btn = $("play");
  btn.setAttribute("aria-pressed", String(playing));
  btn.innerHTML = playing
    ? `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg><span>Pause</span>`
    : `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg><span>${REDUCED ? "Step through" : "Play"}</span>`;
}

function renderSpeed() {
  $("speed").innerHTML = SPEEDS.map((s) => `<button type="button" class="speed-opt" data-speed="${s}" aria-pressed="${s === clock.speed}" aria-label="${s}× speed">${s}×</button>`).join("");
}

function setSpeed(s: number) {
  if (s === clock.speed) return;
  clock.setSpeed(s);
  applyRate();
  rescheduleFollow();
  renderSpeed();
  try {
    localStorage.setItem("kg-speed", String(s));
  } catch {
    // Storage may be unavailable; the speed still applies for this visit.
  }
}

function tick() {
  const t = sceneTime();
  $("progress").style.width = Number.isFinite(len) ? `${Math.min(1, t / len) * 100}%` : "0%";
  if (playing && FROZEN === null && t > len) {
    if (scene >= ASK_SCENE) {
      playing = false;
      renderPlay();
    } else enter(scene + 1);
  }
}

function next() {
  if (scene >= ASK_SCENE) {
    playing = false;
    renderPlay();
    $("payoff").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
  } else enter(scene + 1);
}

function togglePlay() {
  if (REDUCED) {
    started = true;
    next();
    return;
  }
  playing = !playing;
  started = true;
  if (playing) autoScroll = true;
  if (playing && (scene === 0 || (scene === ASK_SCENE && sceneTime() > len))) enter(1);
  renderPlay();
}

// ---------------------------------------------------------------- auto-scroll at discrete moments

let autoScroll = true;
let followTimers: number[] = [];
const revealAt = (el: HTMLElement) => Number(el.style.getPropertyValue("--d") || 0);

function scheduleFollow() {
  autoScroll = true;
  if (FROZEN !== null || REDUCED) {
    clearFollow();
    for (const pane of [$("src"), $("out")]) followOnce(pane, sceneTime(), false);
    return;
  }
  rescheduleFollow();
}
function clearFollow() {
  followTimers.forEach((h) => clearTimeout(h));
  followTimers = [];
}
function rescheduleFollow() {
  clearFollow();
  if (!autoScroll || FROZEN !== null || REDUCED) return;
  const now = sceneTime();
  for (const pane of [$("src"), $("out")]) {
    const times = [...new Set([...pane.querySelectorAll<HTMLElement>(".chg, .src-hl")].map(revealAt))].filter((x) => x >= now - 1).sort((a, b) => a - b);
    for (const t of times) followTimers.push(window.setTimeout(() => followOnce(pane, t, true), clock.wallUntil(t) + 60));
  }
}
/** Brings the newest item revealed by time t into view, starting at a block boundary. One call, never per frame. */
function followOnce(pane: HTMLElement, t: number, smooth: boolean) {
  if (!autoScroll) return;
  const items = [...pane.querySelectorAll<HTMLElement>(".chg, .src-hl")].filter((el) => revealAt(el) <= t);
  const el = items.reduce<HTMLElement | undefined>((best, x) => (!best || revealAt(x) >= revealAt(best) ? x : best), undefined);
  if (!el) return;
  const pr = pane.getBoundingClientRect();
  const blocks = [...pane.querySelectorAll<HTMLElement>(".page > *")];
  const block = blocks.find((b) => b.contains(el)) ?? el;
  const top = block.getBoundingClientRect().top - pr.top + pane.scrollTop;
  const bottom = top + block.offsetHeight + 8;
  if (top >= pane.scrollTop && bottom <= pane.scrollTop + pane.clientHeight) return;
  const target = Math.max(0, Math.min(top - 14, bottom - pane.clientHeight));
  if (Math.abs(pane.scrollTop - target) > 2) pane.scrollTo({ top: target, behavior: smooth && !REDUCED ? "smooth" : "auto" });
}
function takeControl() {
  autoScroll = false;
  clearFollow();
}

// ---------------------------------------------------------------- wiring

export function initWalkthrough() {
  for (const id of ["src", "out"]) {
    const pane = $(id);
    pane.tabIndex = 0;
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) pane.addEventListener(type, takeControl, { passive: true });
  }
  document.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-scene], [data-speed], #play, #next, #prev");
    if (!el) return;
    if (el.dataset.speed) return setSpeed(Number(el.dataset.speed));
    if (el.id === "play") return togglePlay();
    playing = false;
    started = true;
    if (el.id === "next") next();
    else if (el.id === "prev") enter(scene - 1);
    else enter(Number(el.dataset.scene));
    renderPlay();
  });
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const r = $("theatre").getBoundingClientRect();
    if (r.bottom < innerHeight * 0.3 || r.top > innerHeight * 0.7) return;
    if ((e.target as HTMLElement).closest(".doc, textarea, input")) return;
    if (e.key === "ArrowRight") {
      playing = false;
      next();
    } else if (e.key === "ArrowLeft") {
      playing = false;
      enter(scene - 1);
    } else if (e.key === " " && !(e.target as HTMLElement).closest("button, a")) {
      e.preventDefault();
      togglePlay();
    }
  });
  // Hover or tap a number to highlight both ends. Hover never scrolls.
  let hot: string | null = null;
  const linkOf = (el: EventTarget | null) => (el as HTMLElement | null)?.closest?.<HTMLElement>("[data-link]")?.dataset.link?.split(" ")[0] ?? null;
  const highlight = (n: string | null) => {
    if (n === hot) return;
    hot = n;
    document.querySelectorAll("#theatre .hot").forEach((el) => el.classList.remove("hot"));
    if (n) document.querySelectorAll(`#theatre [data-link~="${n}"]`).forEach((el) => el.classList.add("hot"));
  };
  $("theatre").addEventListener("pointerover", (e) => highlight(linkOf(e.target)));
  $("theatre").addEventListener("click", (e) => {
    const n = linkOf(e.target);
    if (!n) return;
    highlight(n);
    // A tap is reader input: bring the other end into view once, then stop auto-scrolling.
    takeControl();
    const from = (e.target as HTMLElement).closest(".doc");
    for (const pane of [$("src"), $("out")]) {
      if (pane === from) continue;
      const el = pane.querySelector<HTMLElement>(`[data-link~="${n}"]`);
      if (el) pane.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 40), behavior: REDUCED ? "auto" : "smooth" });
    }
  });
  renderSpeed();
  // Autoplay starts once, when the walkthrough is half in view; never with reduced motion.
  new IntersectionObserver(
    (entries) => {
      for (const en of entries)
        if (en.intersectionRatio >= 0.5 && !started && FROZEN === null) {
          started = true;
          if (!REDUCED) playing = true;
          enter(1);
        }
    },
    { threshold: [0, 0.5] },
  ).observe($("theatre"));
  if (params.has("scene")) started = true;
  enter(params.has("scene") ? Number(params.get("scene")) || 0 : 0);
  if (params.get("play") === "1" && !REDUCED) {
    started = true;
    playing = true;
    renderPlay();
  }
  applyRate();
  if (FROZEN === null && !REDUCED) setInterval(tick, 100);
}

void nodeByName;
