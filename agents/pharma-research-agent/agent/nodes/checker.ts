// The checker node: the deterministic checks, then the groundedness judge. A
// failed judge does not lose the report; the checks still stand.

import { checks } from "../evals/checks.ts";
import { groundedness } from "../evals/judge.ts";
import { judgeModel } from "../model.ts";
import type { RunState } from "../state.ts";
import { isLimit, type RunBudget } from "../limits.ts";
import type { RunStore } from "../store.ts";
import { nodeContext } from "./context.ts";

export const checkerNode = (store: RunStore, budget?: RunBudget) => async (s: RunState): Promise<Partial<RunState>> => {
  const { sink, tracer, vfs, done } = await nodeContext(store, s.reportId, "evals", budget);
  const registry = new Map((await store.sources(s.reportId)).map((x) => [x.id, x] as const));
  const evals = await tracer.wrap("eval", "evals", "run", async (span) => {
    const list = checks(s.report!, s.plan!, s.findings, registry);
    try {
      const g = await groundedness(judgeModel(budget), tracer, s.report!, registry, span.id);
      vfs.write("/evals/groundedness.md", g.verdicts.map((v) => `- **${v.verdict}** — ${v.text}\n  ${v.reason}`).join("\n"), "judge");
      list.push({ name: g.name, score: g.score, detail: g.detail, method: g.method, items: g.verdicts });
    } catch (err) {
      if (isLimit(err)) throw err;
      list.push({ name: "Groundedness", score: 0, detail: `Not judged: ${(err as Error).message}`, method: "judge" });
    }
    return list;
  });
  sink.emit({ type: "evals", evals });
  await done();
  await store.save(s.reportId, { evals });
  return { evals };
};
