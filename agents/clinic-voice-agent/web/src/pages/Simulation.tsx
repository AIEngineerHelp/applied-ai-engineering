import { useEffect, useState } from "react";
import { api, type Scenario, type SimulationReport } from "../api";
import { Badge, Button, Card, Empty, Mono, PageHeader } from "../components/ui";

export function SimulationPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [reports, setReports] = useState<Partial<Record<"scripted" | "live", SimulationReport>>>({});
  const [mode, setMode] = useState<"scripted" | "live">("scripted");
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

  const report = reports[mode];
  const byName = new Map(report?.results.map((r) => [r.scenario, r]));

  return (
    <>
      <PageHeader
        title="Simulation"
        lede="Simulated callers, played as text through the same agent, tools, guards and CRM client as a voice call. Each sets the CRM's fault switch and checks what must hold whatever the model says: which tools ran, whether a guard fired, how many bookings the CRM received, how the call ended."
        aside={
          <Button onClick={run} disabled={running}>
            {running ? "Running…" : "Run offline"}
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-rule bg-card p-1">
          {(["scripted", "live"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`cursor-pointer rounded-md px-3 py-1 text-[13px] ${mode === m ? "bg-ink text-paper" : "text-ink-3 hover:text-ink"}`}
            >
              {m === "scripted" ? "Scripted model (free)" : "Gemini (live)"}
            </button>
          ))}
        </div>
        {report && (
          <div className="text-[14px] text-ink-2">
            <b className="font-medium text-ink">
              {report.passed}/{report.total}
            </b>{" "}
            passed · {report.model} · {new Date(report.ran_at).toLocaleString()}
          </div>
        )}
      </div>

      {mode === "scripted" && (
        <p className="mb-6 max-w-3xl text-[14px] leading-relaxed text-ink-3">
          The scripted model is keyword rules, not an LLM. It tests the workflow around the model: retries, idempotency, guards, refusals,
          transfers. It says nothing about how a real model behaves; the live run does.
        </p>
      )}
      {mode === "live" && !report && (
        <Empty>
          No live run yet. Run <Mono>uv run python -m voiceagent simulate --live</Mono> with a Gemini key; it makes paid calls, about 30 short
          requests.
        </Empty>
      )}

      <div className="space-y-3">
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
