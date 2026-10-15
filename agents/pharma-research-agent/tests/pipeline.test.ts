import { test } from "node:test";
import assert from "node:assert/strict";

import { checks, citedSentences } from "../lib/research/evals.ts";
import { createGemini } from "../lib/research/gemini.ts";
import type { LLM } from "../lib/research/llm.ts";
import { fixtureToolsets, offlineLLM } from "../lib/research/offline.ts";
import { runResearch } from "../lib/research/run.ts";
import { loadSkills, parseSkill, skillIndex } from "../lib/research/skills.ts";
import { parsePubmedXml } from "../lib/research/sources/pubmed.ts";
import { studyToSource } from "../lib/research/sources/trials.ts";
import { labelToSource } from "../lib/research/sources/fda.ts";
import type { Report } from "../lib/research/types.ts";
import { VirtualFS } from "../lib/research/vfs.ts";

test("an offline run goes through every stage and writes the expected files", async () => {
  const r = await runResearch("What is the evidence on GLP-1 receptor agonists and pancreatitis?", { llm: offlineLLM(), toolsets: fixtureToolsets() });
  const types = new Set(r.events.map((e) => e.type));
  for (const t of ["run", "skills", "plan", "sources", "finding", "report", "evals", "done"]) assert.ok(types.has(t as never), `event ${t}`);
  assert.ok(!types.has("error"));
  const paths = r.files.map((f) => f.path);
  for (const p of ["/plan.md", "/findings/agent-1.md", "/findings/agent-2.md", "/findings/agent-3.md", "/sources/CATALOGUE.md", "/report.md"]) assert.ok(paths.includes(p), p);
  assert.ok(paths.some((p) => p.startsWith("/sources/pubmed/PMID_")));
  const validity = r.evals.find((e) => e.name === "Citation validity")!;
  assert.equal(validity.score, 1);
  // Sub-agents ran in parallel: their agent spans overlap in time.
  const spans = r.events.filter((e) => e.type === "span").map((e) => (e as { span: { name: string; start: number; end?: number } }).span);
  const agentSpans = spans.filter((s) => s.name.startsWith("agent-") && s.end !== undefined);
  const a = agentSpans.find((s) => s.name.startsWith("agent-1"))!, b = agentSpans.find((s) => s.name.startsWith("agent-2"))!;
  assert.ok(a.start < b.end! && b.start < a.end!, "agent-1 and agent-2 overlap");
});

test("the orchestrator's plan is bounded and only uses real skills", async () => {
  const llm: LLM = {
    ...offlineLLM(),
    async generate(req) {
      if (req.agent !== "orchestrator") return offlineLLM().generate(req);
      const json = { focus: "f", subtasks: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, source: i === 0 ? "nowhere" : "pubmed", skills: ["literature-review", "made-up-skill"], why: "w" })) };
      return { text: "", json, calls: [], usage: { input: 0, output: 0, thinking: 0 }, model: "t" };
    },
  };
  const r = await runResearch("A question long enough", { llm, toolsets: fixtureToolsets(), maxSubtasks: 3, judge: false });
  const plan = r.events.find((e) => e.type === "plan");
  assert.ok(plan && plan.type === "plan");
  assert.equal(plan.plan.subtasks.length, 3);
  assert.ok(plan.plan.subtasks.every((t) => t.source === "pubmed" && t.skills.join() === "literature-review"));
});

test("a sub-agent that never finishes stops after its turn limit, and the run still completes", async () => {
  let researcherCalls = 0;
  const base = offlineLLM();
  const llm: LLM = {
    ...base,
    async generate(req) {
      if (req.agent.startsWith("researcher:")) {
        researcherCalls++;
        return { text: "thinking…", calls: [], usage: { input: 0, output: 0, thinking: 0 }, model: "t" };
      }
      return base.generate(req);
    },
  };
  const r = await runResearch("A question long enough", { llm, toolsets: fixtureToolsets(), judge: false });
  assert.equal(researcherCalls, 3 * 6);
  assert.ok(r.report);
  const answered = r.evals.find((e) => e.name === "Subtasks answered")!;
  assert.equal(answered.score, 0);
});

test("citation checks catch ids the agents never retrieved", () => {
  const report: Report = { title: "t", answer: "Risk was not increased in pooled trials [PMID:1]. It was doubled in one cohort [PMID:999].", sections: [], limitations: [], confidence: "low" };
  const registry = new Map([["PMID:1", { id: "PMID:1", kind: "pubmed" as const, title: "x", url: "", text: "", meta: {} }]]);
  const plan = { focus: "", subtasks: [{ id: "agent-1", question: "", source: "pubmed" as const, skills: [], why: "" }] };
  const [validity, coverage] = checks(report, plan, [], registry);
  assert.equal(validity.score, 0.5);
  assert.equal(coverage.score, 1);
  assert.deepEqual(citedSentences(report).map((s) => s.ids), [["PMID:1"], ["PMID:999"]]);
});

test("the virtual file system refuses paths that escape it", () => {
  const vfs = new VirtualFS();
  vfs.write("findings//a.md", "x", "t");
  assert.equal(vfs.read("/findings/a.md"), "x");
  assert.throws(() => vfs.write("/findings/../../etc/passwd", "x", "t"));
  assert.equal(vfs.list("/findings").length, 1);
});

test("skills load from markdown, and the index shows only one line per skill", () => {
  const skills = loadSkills();
  assert.ok(skills.length >= 5);
  const index = skillIndex(skills);
  assert.equal(index.split("\n").length, skills.length);
  assert.ok(!index.includes("## "), "no playbook bodies in the index");
  assert.throws(() => parseSkill("no front matter"));
});

test("source parsers normalise PubMed XML, trial records and FDA labels", () => {
  const [a] = parsePubmedXml(`<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">123</PMID><Article><Journal><Title>Lancet</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal><ArticleTitle>GLP-1 &amp; risk</ArticleTitle><Abstract><AbstractText Label="RESULTS">RR <i>1.05</i></AbstractText></Abstract><PublicationTypeList><PublicationType>Meta-Analysis</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`);
  assert.equal(a.id, "PMID:123");
  assert.equal(a.title, "GLP-1 & risk");
  assert.equal(a.text, "RESULTS: RR 1.05");
  assert.equal(a.meta.year, 2024);
  const t = studyToSource({ hasResults: true, protocolSection: { identificationModule: { nctId: "NCT01", briefTitle: "T" }, statusModule: { overallStatus: "COMPLETED" }, designModule: { phases: ["PHASE3"], enrollmentInfo: { count: 500 } } } });
  assert.equal(t.meta.phase, "Phase 3");
  assert.equal(t.meta.results, true);
  const l = labelToSource({ set_id: "abc", boxed_warning: ["WARNING: X"], openfda: { generic_name: ["SEMAGLUTIDE"] }, effective_time: "20260130" });
  assert.equal(l.id, "FDA:abc");
  assert.equal(l.meta.effective, "2026-01-30");
  assert.match(l.text, /^Boxed warning: WARNING: X/);
});

test("the Gemini client echoes the model's content back unchanged, so thought signatures survive", async () => {
  const sent: { contents: { role: string; parts: Record<string, unknown>[] }[]; tools: { functionDeclarations: { parametersJsonSchema?: unknown }[] }[]; toolConfig?: unknown }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const content = { role: "model", parts: [{ functionCall: { name: "search_pubmed", args: { query: "x" } }, thoughtSignature: "SIG123" }] };
    return new Response(JSON.stringify({ candidates: [{ content }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 5 } }));
  }) as typeof fetch;
  try {
    const llm = createGemini({ apiKey: "k", inputPrice: 1, outputPrice: 2 });
    const first = await llm.generate({ agent: "a", system: "s", turns: [{ role: "user", text: "hi" }], tools: [{ name: "search_pubmed", description: "d", parameters: { type: "object" } }] });
    assert.equal(first.calls[0].name, "search_pubmed");
    assert.equal(first.usage.cost, (10 * 1 + 7 * 2) / 1e6);
    await llm.generate({ agent: "a", system: "s", turns: [{ role: "user", text: "hi" }, { role: "model", text: "", calls: first.calls, raw: first.raw }, { role: "tool", results: [{ name: "search_pubmed", response: [1, 2] }] }] });
    const contents = sent[1].contents;
    assert.equal(contents[1].parts[0].thoughtSignature, "SIG123");
    assert.equal(contents[2].role, "user");
    assert.deepEqual(contents[2].parts[0].functionResponse, { name: "search_pubmed", response: { result: [1, 2] } });
    assert.ok(sent[0].tools[0].functionDeclarations[0].parametersJsonSchema);
    await llm.generate({ agent: "a", system: "s", turns: [{ role: "user", text: "hi" }], tools: [{ name: "finish", description: "d", parameters: { type: "object" } }], force: "finish" });
    assert.deepEqual(sent[2].toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["finish"] } });
  } finally {
    globalThis.fetch = real;
  }
});

test("the judge sees the passages relevant to a claim, not just the start of a long source", async () => {
  const { relevant } = await import("../lib/research/evals.ts");
  const label = `${"Indications and usage text. ".repeat(80)}Warnings 5.1 Ketoacidosis: consider ketone monitoring and discontinue if ketoacidosis is suspected. ${"Adverse reactions text. ".repeat(80)}`;
  const view = relevant(label, "The label advises ketone monitoring and to discontinue if ketoacidosis is suspected.");
  assert.ok(view.length <= 1600);
  assert.match(view, /Ketoacidosis: consider ketone monitoring/);
});
