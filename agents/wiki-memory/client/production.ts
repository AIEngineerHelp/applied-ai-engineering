// "Taking it to production": design guidance, shortened from the README section of the same name.
// The demo does not test any of it. Static content; tests check that all eight areas are covered and
// that every in-page link resolves.

import { esc } from "./render.ts";

export interface ProductionRow {
  problem: string;
  wrong: string;
  handle: string;
  /** Where the demo shows a piece of this, as an in-page link. */
  demo?: { href: string; label: string };
}

export const PRODUCTION: ProductionRow[] = [
  {
    problem: "Big documents",
    wrong: "A whole document plus the whole wiki doesn't fit in one prompt, and edits get vague.",
    handle: "Route first: use the index and a search over wiki pages to find the pages a document affects. Process it section by section: extract facts, then merge them into pages. Split pages that grow past a size limit, behind a short hub page.",
  },
  {
    problem: "A wiki too big to read",
    wrong: "The index stops fitting in the model's context, so the agent can't find the right pages.",
    handle: "An index file works at moderate scale (about 100 sources and hundreds of pages, by Karpathy's account). Beyond that, add hub pages per area and search the wiki pages, with hybrid keyword and vector search, at question time.",
  },
  {
    problem: "Conflicting facts",
    wrong: "Documents disagree, and the newest or loudest value wins by accident.",
    handle: "Store facts as value, scope, source, date and status. Let scope settle what it can (90 days for Enterprise, 30 for other plans). Apply an explicit source ranking in code: approved decision > design doc > incident report or runbook > meeting notes or chat > draft, newer winning within a rank. Never overwrite silently; mark ties disputed and send them to a person.",
    demo: { href: "#conflicts", label: "See it resolved" },
  },
  {
    problem: "Mistakes and drift",
    wrong: "A wrong sentence in a page is read back on every question and copied into other pages.",
    handle: "Treat raw documents as the truth and the wiki as a cache you can rebuild. Cite a source for every fact and check by code that the quoted sentence exists verbatim. Keep a set of regression questions and run them with lint on a schedule.",
    demo: { href: "#theatre", label: "See numbered citations" },
  },
  {
    problem: "Many documents at once",
    wrong: "Two ingests rewrite the same page and one overwrites the other.",
    handle: "Put ingests on a queue. Use a single writer or per-page locks. Make one Git commit per ingest so any change can be reviewed or reverted. Skip documents whose content hash was already ingested.",
  },
  {
    problem: "Cost",
    wrong: "Every document touches several pages, so ingest cost grows with documents × pages touched.",
    handle: "Use a cheap model to route and a strong one to edit. Reprocess only documents that changed. Run maintenance in the background, between conversations.",
  },
  {
    problem: "Deleted documents and permissions",
    wrong: "A page mixes facts from documents with different readers, or keeps facts from a deleted document.",
    handle: "Keep provenance on every fact so deleting a source retracts exactly what it supported. Let a page inherit the access rules of its most restricted source, or keep separate wikis per audience. Strip personal data before it reaches a page.",
  },
  {
    problem: "Combining with RAG and knowledge graphs",
    wrong: "Some questions aren't covered by the wiki yet, or need exact quotes or typed relationships.",
    handle: "Keep plain retrieval over the raw documents as a fallback. Use a knowledge graph alongside the pages where code must traverse typed relationships.",
    demo: { href: "#roles", label: "Who does what" },
  },
];

const step = (s: string) => `<span class="pbox">${s}</span>`;
const arr = '<span class="arr" aria-hidden="true">→</span>';

export function renderProductionHtml(): string {
  const ingest = [
    "New document",
    "Queue (skip if its hash was seen)",
    "Route to affected pages",
    "Extract facts per section",
    "Resolve conflicts: rule, then a person",
    "Edit pages under a lock",
    "Verify citations and lint",
    "Commit to Git",
  ];
  const query = ["Question", "Search the wiki", "Read 1–5 pages", "Answer, citing pages"];
  const rows = PRODUCTION.map(
    (r) => `<div class="prow" role="row">
      <div role="cell" class="p-problem">${esc(r.problem)}</div>
      <div role="cell"><span class="p-k">What goes wrong</span>${esc(r.wrong)}</div>
      <div role="cell"><span class="p-k">How to handle it</span>${esc(r.handle)}${r.demo ? ` <a class="p-demo" href="${r.demo.href}">${esc(r.demo.label)} ↑</a>` : ""}</div>
    </div>`,
  ).join("");
  return `<figure class="diagram" aria-label="The production pipeline">
      <div class="lane"><div class="lane-name">When a document arrives</div><div class="flow">${ingest.map(step).join(arr)}</div></div>
      <div class="lane"><div class="lane-name">When a question arrives</div><div class="flow">${query.map(step).join(arr)}${arr}<span class="pbox muted">Not covered yet: fall back to the raw documents</span></div></div>
    </figure>
    <div class="ptable" role="table" aria-label="Problems at scale and how to handle them">
      <div class="prow phead" role="row"><div role="columnheader">Problem</div><div role="columnheader">What goes wrong</div><div role="columnheader">How to handle it</div></div>
      ${rows}
    </div>`;
}
