// The agents, one at a time, on the scripted LangChain model: the planner,
// a sub-agent's LangGraph tool loop, the model helper, and the pure parts
// (citation checks, file system, skills, source parsers).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { plan } from "../agent/nodes/planner.ts";
import { MAX_TURNS, research } from "../agent/subgraphs/researcher-loop.ts";
import { checks, citedSentences } from "../agent/evals/checks.ts";
import { callModel } from "../agent/model.ts";
import { ScriptedChatModel, type ScriptedCallOptions } from "../agent/offline/model.ts";
import { fixtureToolsets } from "../agent/offline/toolsets.ts";
import { loadSkills, parseSkill, skillIndex } from "../agent/skills/index.ts";
import { parsePubmedXml } from "../agent/tools/pubmed.ts";
import { studyToSource } from "../agent/tools/trials.ts";
import { labelToSource } from "../agent/tools/fda.ts";
import { Tracer } from "../agent/trace.ts";
import type { Report, RunEvent, Source, Subtask } from "../agent/types.ts";
import { VirtualFS } from "../agent/vfs.ts";

afterEach(() => {
  ScriptedChatModel.script = undefined;
});

const task: Subtask = { id: "agent-1", question: "What do trials report about pancreatitis?", source: "pubmed", skills: ["literature-review"], why: "Pooled evidence." };

/** A sub-agent's context, collecting its events. */
function context() {
  const events: RunEvent[] = [];
  const tracer = new Tracer((e) => events.push(e));
  const vfs = new VirtualFS();
  const registry = new Map<string, Source>();
  return { events, tracer, vfs, registry, ctx: { model: new ScriptedChatModel({}), tracer, vfs, registry, onSources: () => {} } };
}

test("the orchestrator's plan is bounded and only uses real skills", async () => {
  ScriptedChatModel.script = (agent) =>
    agent === "orchestrator"
      ? { text: JSON.stringify({ focus: "f", subtasks: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, source: i === 0 ? "nowhere" : "pubmed", skills: ["literature-review", "made-up-skill"], why: "w" })) }) }
      : undefined;
  const p = await plan(new ScriptedChatModel({}), "A question long enough", loadSkills(), 3);
  assert.equal(p.subtasks.length, 3);
  assert.ok(p.subtasks.every((t) => t.source === "pubmed" && t.skills.join() === "literature-review"));
  assert.deepEqual(p.subtasks.map((t) => t.id), ["agent-1", "agent-2", "agent-3"]);
});

test("a sub-agent's graph searches, then finishes with claims citing only what it retrieved", async () => {
  const { events, vfs, registry, ctx } = context();
  const finding = await research(ctx, task, fixtureToolsets().pubmed, loadSkills(), "run");
  assert.ok(finding.claims.length > 0);
  assert.ok(finding.claims.every((c) => c.sources.length && c.sources.every((id) => registry.has(id))));
  assert.ok(vfs.read("/findings/agent-1.md").includes("## Claims"));
  assert.ok(vfs.list("/sources/pubmed").length > 0);
  const spans = events.filter((e) => e.type === "span").map((e) => (e as { span: { kind: string; end?: number } }).span);
  assert.equal(spans.filter((s) => s.kind === "tool" && s.end !== undefined).length, 1);
  assert.equal(spans.filter((s) => s.kind === "llm" && s.end !== undefined).length, 2, "one search turn, one finish turn");
});

test("a sub-agent that never calls a tool stops at its turn limit, forced to finish on the last turn", async () => {
  const seen: ScriptedCallOptions[] = [];
  ScriptedChatModel.script = (agent, _m, o) => {
    if (agent !== "researcher") return undefined;
    seen.push(o);
    return { text: "thinking…" };
  };
  const { ctx } = context();
  const finding = await research(ctx, task, fixtureToolsets().pubmed, loadSkills(), "run");
  assert.equal(seen.length, MAX_TURNS);
  assert.equal(seen.at(-1)!.tool_choice, "finish");
  assert.ok(seen.slice(0, -1).every((o) => o.tool_choice === undefined));
  assert.equal(finding.claims.length, 0);
  assert.match(finding.summary, /ran out of turns/);
});

test("callModel streams thought summaries and text, and counts thinking apart from output", async () => {
  const thoughts: string[] = [];
  const texts: string[] = [];
  const r = await callModel(new ScriptedChatModel({}), [new SystemMessage("You are the synthesis agent."), new HumanMessage("[PMID:1] A study")], {
    onThought: (t) => thoughts.push(t),
    onText: (t) => texts.push(t),
  });
  assert.ok(thoughts.length > 1 && thoughts.at(-1)!.startsWith("**Organising the findings**"));
  assert.ok(texts.length > 1 && texts.at(-1) === r.text);
  assert.match(r.text, /^# Offline run/);
  assert.equal(r.usage.input, 1200);
  assert.equal(r.usage.cost, 0);
  const judged = await callModel(new ScriptedChatModel({}), [new SystemMessage("You check claims."), new HumanMessage("1. CLAIM: x")], { schema: { type: "object" } });
  assert.deepEqual((judged.json as { verdicts: unknown[] }).verdicts.length, 1);
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


test("the judge sees the passages relevant to a claim, not just the start of a long source", async () => {
  const { relevant } = await import("../agent/evals/judge.ts");
  const label = `${"Indications and usage text. ".repeat(80)}Warnings 5.1 Ketoacidosis: consider ketone monitoring and discontinue if ketoacidosis is suspected. ${"Adverse reactions text. ".repeat(80)}`;
  const view = relevant(label, "The label advises ketone monitoring and to discontinue if ketoacidosis is suspected.");
  assert.ok(view.length <= 1600);
  assert.match(view, /Ketoacidosis: consider ketone monitoring/);
});
