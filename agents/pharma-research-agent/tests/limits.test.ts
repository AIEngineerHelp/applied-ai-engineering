// Runtime limits: the per-run budget, the deadline, and the rate limits on
// starting research, against an in-memory Postgres and the scripted model.
process.env.PGLITE_DIR = "memory";
process.env.RESEARCH_OFFLINE = "1";

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { runResearchGraph } from "../agent/graph.ts";
import { LimitReached, RunBudget, isLimit, type Limits } from "../agent/limits.ts";
import { ScriptedChatModel, type Agent } from "../agent/offline/model.ts";
import { db, schema } from "../lib/db/index.ts";
import { rateLimited } from "../lib/rate-limit.ts";
import { DrizzleSaver } from "../lib/storage/checkpointer.ts";
import { postgresRunStore } from "../lib/storage/run-store.ts";

const { reports } = schema;
const roomy: Limits = { maxCostUsd: 5, maxModelCalls: 100, maxSeconds: 600, attemptSeconds: 270 };
const run = (id: string, limits: Limits) => runResearchGraph(id, { store: postgresRunStore, checkpointer: new DrizzleSaver(), limits });

afterEach(() => {
  ScriptedChatModel.script = undefined;
  delete process.env.RESEARCH_OFFLINE_DELAY_MS;
});

async function newReport(id: string, extra: Partial<typeof reports.$inferInsert> = {}) {
  const d = await db();
  await d.insert(reports).values({ id, threadId: id, workspaceId: "l".repeat(32), query: "What is the evidence on GLP-1 receptor agonists and pancreatitis?", model: "offline (scripted)", ...extra });
}

test("the budget stops at its call limit and its cost limit, and ignores cost when calls are unpriced", () => {
  const b = new RunBudget({ ...roomy, maxModelCalls: 2 });
  b.begin();
  b.begin();
  assert.throws(() => b.begin(), (e) => isLimit(e) && /2 model calls/.test((e as Error).message));
  const c = new RunBudget({ ...roomy, maxCostUsd: 0.05 }, { cost: 0.04, calls: 3 });
  c.add({ input: 1, output: 1, thinking: 0, cost: 0.02 });
  assert.throws(() => c.check(), /cost limit of \$0\.05/);
  const unpriced = new RunBudget({ ...roomy, maxCostUsd: 0.01 }, { cost: null, calls: 3 });
  unpriced.add({ input: 1, output: 1, thinking: 0 });
  unpriced.check();
});

test("a run that reaches its model-call limit stops, and nothing calls a model past it", async () => {
  await newReport("l1");
  const calls: Record<string, number> = {};
  ScriptedChatModel.script = (agent: Agent) => {
    calls[agent] = (calls[agent] ?? 0) + 1;
    return undefined;
  };
  await assert.rejects(run("l1", { ...roomy, maxModelCalls: 4 }), (e) => isLimit(e) && /4 model calls/.test((e as Error).message));
  const total = Object.values(calls).reduce((a, b) => a + b, 0);
  assert.ok(total <= 4, `made ${total} model calls`);
  assert.equal(calls.synthesis, undefined, "the writer never ran");
});

test("a resumed run counts what earlier attempts spent", async () => {
  await newReport("l2", { modelCalls: 44, costUsd: "0.10" });
  await assert.rejects(run("l2", { ...roomy, maxModelCalls: 45 }), (e) => isLimit(e));
});

test("a run past its total deadline is not started again", async () => {
  await newReport("l3", { startedAt: new Date(Date.now() - 11 * 60_000) });
  await assert.rejects(run("l3", roomy), (e) => e instanceof LimitReached && /longer than 10 minutes/.test(e.message));
});

test("an attempt that runs out of time stops with a retryable error, and the next attempt resumes and finishes", async () => {
  await newReport("l4");
  process.env.RESEARCH_OFFLINE_DELAY_MS = "1500";
  const err = await run("l4", { ...roomy, attemptSeconds: 1 }).catch((e: Error) => e);
  assert.ok(err instanceof Error && !isLimit(err), "an attempt timeout is retryable, not a run limit");
  delete process.env.RESEARCH_OFFLINE_DELAY_MS;
  const state = await run("l4", roomy);
  assert.ok(state.report && state.evals);
});

test("rate limits: runs in progress, runs per hour per browser, and runs per hour per network", async () => {
  const d = await db();
  const ws = "r".repeat(32);
  const limits = { perWorkspaceHour: 3, perClientHour: 4, concurrent: 2 };
  assert.equal(await rateLimited(ws, "client-a", limits), null);
  await d.insert(reports).values([
    { id: "rl1", threadId: "rl1", workspaceId: ws, query: "q", model: "m", status: "running", clientHash: "client-a" },
    { id: "rl2", threadId: "rl2", workspaceId: ws, query: "q", model: "m", status: "queued", clientHash: "client-a" },
  ]);
  assert.match((await rateLimited(ws, "client-a", limits))!, /2 research runs in progress/);
  await d.update(reports).set({ status: "completed" }).where(eq(reports.workspaceId, ws));
  await d.insert(reports).values({ id: "rl3", threadId: "rl3", workspaceId: ws, query: "q", model: "m", status: "completed", clientHash: "client-a" });
  assert.match((await rateLimited(ws, "client-a", limits))!, /3 research runs in the last hour/);
  // A new browser on the same network is still limited by the network's count.
  await d.insert(reports).values({ id: "rl4", threadId: "rl4", workspaceId: "s".repeat(32), query: "q", model: "m", status: "completed", clientHash: "client-a" });
  assert.match((await rateLimited("t".repeat(32), "client-a", limits))!, /from your network/);
  assert.equal(await rateLimited("t".repeat(32), "client-b", limits), null);
});
