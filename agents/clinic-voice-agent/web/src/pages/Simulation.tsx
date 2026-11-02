import { useEffect, useState } from "react";
import { api, type Mode, type Scenario, type SimulationReport } from "../api";
import { usd } from "../format";
import { useHosted } from "../hosted";

const MODES: { key: Mode; label: string }[] = [
  { key: "scripted", label: "Offline (free)" },
  { key: "live", label: "Gemini, model callers" },
  { key: "live-fixed-callers", label: "Gemini, fixed lines" },
];
import { Badge, Button, Card, Empty, Mono, PageHeader } from "../components/ui";

export function SimulationPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [reports, setReports] = useState<Partial<Record<Mode, SimulationReport>>>({});
  const [mode, setMode] = useState<Mode>("scripted");
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = () =>
    api.simulations().then((r) => {
      setScenarios(r.scenarios);
      setReports(r.reports);
    });
  useEffect(() => {
    void load();
  }, []);

  async function run() {
    setRunning(true);
    try {
      await api.runSimulation();
      await load();
      setMode("scripted");
    } finally {
      setRunning(false);
    }
  }

  const hosted = useHosted();
  const report = reports[mode];
  const byName = new Map(report?.results.map((r) => [r.scenario, r]));

  return (
    <>
      <PageHeader
        title="Simulation"
        lede="Simulated callers, played as text through the same agent, tools, guards and CRM client as a voice call. Each sets the CRM's fault switch and checks what must hold whatever the model says: which tools ran, whether a guard fired, how many bookings the CRM received, how the call ended. Offline, callers read fixed lines; live, a second model plays each caller towards a goal and answers what the agent actually asks."
        aside={
          hosted ? undefined : (
            <Button onClick={run} disabled={running}>
              {running ? "Running…" : "Run offline"}
            </Button>
          )
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-rule bg-card p-1">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={`cursor-pointer rounded-md px-3 py-1 text-[13px] whitespace-nowrap ${mode === m.key ? "bg-ink text-paper" : "text-ink-3 hover:text-ink"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {report && (
          <div className="text-[14px] text-ink-2">
            <b className="font-medium text-ink">
              {report.passed}/{report.total}
            </b>{" "}
            passed · agent {report.model} · callers {report.callers ?? "fixed lines"}
            {report.agent_cost_usd != null && <> · {usd((report.agent_cost_usd ?? 0) + (report.caller_cost_usd ?? 0), 2)}</>} ·{" "}
            {new Date(report.ran_at).toLocaleString()}
          </div>
        )}
      </div>

      {mode === "scripted" && (
        <p className="mb-6 max-w-3xl text-[14px] leading-relaxed text-ink-3">
          The scripted model is keyword rules, not an LLM. It tests the workflow around the model: retries, idempotency, guards, refusals,
          transfers. It says nothing about how a real model behaves; the live run does.
        </p>
      )}
      {mode === "live-fixed-callers" && report && (
        <p className="mb-6 max-w-3xl text-[14px] leading-relaxed text-ink-3">
          Gemini as the agent, but callers reading the offline lines. When the agent asked a sensible follow-up question, the caller's next
          fixed line no longer fit, which is why model callers exist.
        </p>
      )}
      {mode !== "scripted" && !report && (
        <Empty>
          No run yet. Run <Mono>uv run python -m voiceagent simulate --live{mode === "live-fixed-callers" ? " --fixed-callers" : ""}</Mono>{" "}
          with a Gemini key; it makes paid calls, a few cents per run.
        </Empty>
      )}

      <div className="stagger space-y-3">
        {scenarios.map((sc) => {
          const r = byName.get(sc.name);
          const isOpen = open === sc.name;
          return (
            <Card key={sc.name}>
              <button type="button" onClick={() => setOpen(isOpen ? null : sc.name)} className="flex w-full cursor-pointer flex-wrap items-center gap-3 text-left">
                {r ? <Badge tone={r.passed ? "good" : "bad"}>{r.passed ? "pass" : "fail"}</Badge> : <Badge>not run</Badge>}
                <span className="text-[15px] font-medium text-ink">{sc.title}</span>
                {sc.fault && <Badge tone="warn">CRM: {sc.fault.mode}{sc.fault.count ? ` ×${sc.fault.count}` : ""}</Badge>}
                <span className="ml-auto font-mono text-[12px] text-ink-3">{sc.name}</span>
              </button>
              {isOpen && (
                <div className="mt-4 grid grid-cols-1 gap-5 border-t border-rule pt-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <div className="text-[12px] tracking-wide text-ink-3 uppercase">Caller</div>
                    <div className="mt-1 text-[14px] text-ink-2">
                      {sc.persona} <span className="text-ink">Goal: {sc.goal}</span>
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-[12px] tracking-wide text-ink-3 uppercase">Conversation</div>
                    <div className="space-y-2">
                      {(r?.transcript ?? sc.turns.map((t) => ({ role: "user", text: t }))).map((t, i) => (
                        <div key={i} className="text-[14.5px] leading-relaxed">
                          <span className="mr-2 text-[12px] text-ink-3 uppercase">{t.role === "user" ? "Caller" : "Agent"}</span>
                          <span className={t.role === "user" ? "text-ink" : "font-serif text-[16px] text-accent"}>{t.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-[12px] tracking-wide text-ink-3 uppercase">Checks</div>
                    {r ? (
                      <ul className="space-y-1.5">
                        {r.checks.map((c) => (
                          <li key={c.check} className="flex gap-2 text-[14px]">
                            <span className={c.passed ? "text-accent" : "text-bad"}>{c.passed ? "✓" : "✗"}</span>
                            <span>
                              <span className="text-ink">{c.check}</span>
                              <span className="block text-[12.5px] text-ink-3">{c.detail}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <pre className="font-mono text-[12px] text-ink-2">{JSON.stringify(sc.expect, null, 2)}</pre>
                    )}
                    {r && (
                      <a href={`#/calls/${r.call_id}`} className="mt-4 inline-block text-[14px] text-accent underline underline-offset-2">
                        Open the trace
                      </a>
                    )}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
