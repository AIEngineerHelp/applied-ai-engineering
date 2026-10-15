// The output guard node: runs on the finished report, before the checks.
// Citations to unretrieved sources and personal data are removed; sentences
// that break the risk catalogue are removed and noted. If the policy check
// itself fails, the report is kept and the failure is recorded: the evals that
// follow still run, and the trace shows the report was not policy-checked.

import { enforceCitations, policyCheck, redactReport, removeSentences } from "../guardrails/output.ts";
import { guardModel } from "../model.ts";
import { renderReport } from "../report-format.ts";
import type { RunState } from "../state.ts";
import { isLimit, type RunBudget } from "../limits.ts";
import type { RunStore } from "../store.ts";
import type { GuardDecision, Report } from "../types.ts";
import { nodeContext } from "./context.ts";

/** Added to a redirected personal question's report, so exports carry it too. */
export const REDIRECT_NOTE = "This answer describes general evidence, not advice for any individual. Decisions about your own treatment or dose need a clinician who knows your health history.";

export const outputGuardNode = (store: RunStore, budget?: RunBudget) => async (s: RunState): Promise<Partial<RunState>> => {
  const { sink, tracer, vfs, done } = await nodeContext(store, s.reportId, "guard-out", budget);
  const decide = (d: GuardDecision) => sink.emit({ type: "guardrail", decision: d });
  const registry = new Map((await store.sources(s.reportId)).map((x) => [x.id, x] as const));
  const before = s.report!;
  let report: Report = before;

  await tracer.wrap("agent", "output guard", "run", async (span) => {
    const c = enforceCitations(report, registry);
    report = c.report;
    decide({ stage: "output", check: "citations", outcome: c.removed.length ? "remove" : "pass", detail: c.removed.length ? `Removed ${c.removed.length} citation${c.removed.length === 1 ? "" : "s"} to sources no agent retrieved: ${[...new Set(c.removed)].join(", ")}.` : "Every citation points to a retrieved source." });

    const p = redactReport(report);
    report = p.report;
    decide({ stage: "output", check: "personal-data", outcome: p.found.length ? "redact" : "pass", detail: p.found.length ? `Redacted from the report: ${p.found.join(", ")}.` : "No personal data found.", risks: p.found.length ? ["personal-data"] : undefined });

    try {
      const v = await tracer.wrap("llm", "check report against risks", span.id, async (sp) => {
        const r = await policyCheck(guardModel(budget), report);
        tracer.addUsage(r.usage);
        tracer.close(sp, { checked: r.checked, violations: r.violations.length, input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cost: r.usage.cost });
        return r;
      });
      report = removeSentences(report, v.violations);
      decide({
        stage: "output",
        check: "policy",
        outcome: v.violations.length ? "remove" : "pass",
        detail: v.violations.length ? v.violations.map((x) => `Removed "${x.text.slice(0, 140)}${x.text.length > 140 ? "…" : ""}" (${x.risk}): ${x.why}`).join(" ") : `Checked ${v.checked} sentences against the risk catalogue; none broke a risk.`,
        risks: v.violations.length ? [...new Set(v.violations.map((x) => x.risk))] : undefined,
      });
    } catch (err) {
      if (isLimit(err)) throw err;
      decide({ stage: "output", check: "policy", outcome: "flag", detail: `The policy check could not run (${(err as Error).message.slice(0, 160)}); the report was not checked against the risk catalogue.` });
    }
  });

  if (s.screen?.redirected) report = { ...report, limitations: [REDIRECT_NOTE, ...report.limitations] };
  if (report !== before) {
    sink.emit({ type: "report", report, markdown: renderReport(report) });
    vfs.write("/report.md", renderReport(report), "output-guard");
  }
  await done();
  if (report !== before) await store.save(s.reportId, { report });
  return { report };
};
