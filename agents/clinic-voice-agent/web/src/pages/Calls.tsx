import { useEffect, useState } from "react";
import { api, type Call, type Stats } from "../api";
import { Badge, Card, Empty, Mono, PageHeader, Stat, outcomeTone, statusTone } from "../components/ui";
import { duration, ms, pipelineLabel, statusLabel, usd, when } from "../format";

const SOURCES = [
  { key: "", label: "All" },
  { key: "browser", label: "Voice" },
  { key: "sip", label: "Phone" },
  { key: "simulation", label: "Simulated" },
];

export function CallsPage() {
  const [source, setSource] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);

  useEffect(() => {
    const load = () => {
      api.stats(source || undefined).then(setStats).catch(() => undefined);
      api.calls().then(setCalls).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [source]);

  const shown = calls.filter((c) => !source || c.source === source);
  const pipelines = Object.entries(stats?.pipelines ?? {});

  return (
    <>
      <PageHeader
        title="Calls"
        lede="Every call, voice or simulated, writes an event trace: pre-call lookup, each turn's latency by component, tool calls, CRM attempts, guards, transfers and the post-call record."
        aside={
          <div className="flex gap-1 rounded-lg border border-rule bg-card p-1">
            {SOURCES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSource(s.key)}
                className={`cursor-pointer rounded-md px-3 py-1 text-[13px] ${source === s.key ? "bg-ink text-paper" : "text-ink-3 hover:text-ink"}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        }
      />

      {pipelines.length === 0 && <Empty>No calls yet. Make one from “Talk to the agent”, or run the simulation.</Empty>}

      <div className="space-y-6">
        {pipelines.map(([pipeline, p]) => {
          const resolved = p.end_status.resolved ?? 0;
          const transferred = p.end_status.transferred ?? 0;
          const e2e = p.latency.e2e_latency;
          const scripted = pipeline === "scripted";
          return (
            <Card key={pipeline} title={pipelineLabel(pipeline)} aside={`${p.calls} calls · ${p.minutes.toFixed(1)} min`}>
              <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
                <Stat label="Resolved" value={`${Math.round((resolved / p.calls) * 100)}%`} note={`${resolved} of ${p.calls}`} />
                <Stat label="Transferred" value={`${Math.round((transferred / p.calls) * 100)}%`} note={`${transferred} to a person`} />
                <Stat
                  label="Reply latency p50"
                  value={scripted ? "–" : ms(e2e?.p50)}
                  note={scripted ? "no audio in simulation" : e2e ? `p95 ${ms(e2e.p95)} · ${e2e.n} turns` : "no voice turns yet"}
                />
                <Stat label="Cost per minute" value={scripted ? "$0" : usd(p.cost_per_minute, 3)} note={scripted ? "no model calls" : `${usd(p.cost_usd, 3)} total`} />
              </div>
              {!scripted && stats && <LatencyBreakdown latency={p.latency} parts={stats.latency_parts} />}
              <div className="mt-5 flex flex-wrap gap-1.5">
                {Object.entries(p.end_status).map(([status, n]) => (
                  <Badge key={status} tone={statusTone(status)}>
                    {statusLabel(status)} · {n}
                  </Badge>
                ))}
              </div>
            </Card>
          );
        })}

        {stats && Object.keys(stats.tools).length > 0 && (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Card title="Tools">
              <div className="-mx-5 overflow-x-auto px-5">
              <table className="w-full min-w-[420px] text-[14px]">
                <thead>
                  <tr className="text-left text-[12px] tracking-wide text-ink-3 uppercase">
                    <th className="pb-2 font-medium">Tool</th>
                    <th className="pb-2 font-medium">Outcomes</th>
                    <th className="pb-2 text-right font-medium">p50</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(stats.tools).map(([name, t]) => (
                    <tr key={name} className="border-t border-rule align-top">
                      <td className="py-2 pr-3">
                        <Mono>{name}</Mono>
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(t.outcomes).map(([o, n]) => (
                            <Badge key={o} tone={outcomeTone(o)}>
                              {o} · {n}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 text-right whitespace-nowrap text-ink-2 tabular-nums">{ms(t.p50_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Card>
            <Card title="CRM requests and guards">
              <div className="text-[13px] text-ink-3">Every attempt the CRM client made, including retries.</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(stats.crm_attempts).map(([o, n]) => (
                  <Badge key={o} tone={outcomeTone(o)}>
                    {o} · {n}
                  </Badge>
                ))}
              </div>
              <div className="mt-5 text-[13px] text-ink-3">Guards that took a turn away from the model.</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.keys(stats.guards).length === 0 && <span className="text-[14px] text-ink-3">None fired.</span>}
                {Object.entries(stats.guards).map(([g, n]) => (
                  <Badge key={g} tone="warn">
                    {g} · {n}
                  </Badge>
                ))}
              </div>
            </Card>
          </div>
        )}

        {shown.length > 0 && (
          <Card title="Call log" aside={`${shown.length} calls`}>
            <div className="-mx-5 -my-5 overflow-x-auto">
              <table className="w-full min-w-[720px] text-[14px]">
                <thead>
                  <tr className="text-left text-[12px] tracking-wide text-ink-3 uppercase">
                    <th className="px-5 py-3 font-medium">Started</th>
                    <th className="py-3 font-medium">Caller</th>
                    <th className="py-3 font-medium">Pipeline</th>
                    <th className="py-3 font-medium">Outcome</th>
                    <th className="py-3 font-medium">Length</th>
                    <th className="px-5 py-3 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <tr key={c.id} className="cursor-pointer border-t border-rule hover:bg-paper" onClick={() => (window.location.hash = `#/calls/${c.id}`)}>
                      <td className="px-5 py-2.5 whitespace-nowrap text-ink-2">{when(c.started_at)}</td>
                      <td className="py-2.5">
                        <div className="text-ink">{c.scenario ?? c.patient_id ?? "Unknown caller"}</div>
                        <Mono>{c.caller_phone ?? "no caller id"}</Mono>
                      </td>
                      <td className="py-2.5 text-ink-2">{pipelineLabel(c.pipeline)}</td>
                      <td className="py-2.5">
                        <Badge tone={statusTone(c.end_status)}>{statusLabel(c.end_status)}</Badge>
                        {c.summary?.intent && <span className="ml-2 text-[13px] text-ink-3">{c.summary.intent}</span>}
                      </td>
                      <td className="py-2.5 text-ink-2 tabular-nums">{c.ended_at ? duration(c.ended_at - c.started_at) : "–"}</td>
                      <td className="px-5 py-2.5 text-right text-ink-2 tabular-nums">{usd(c.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

const PART_COLOURS = ["#c9c3b5", "#a39d8f", "#3f6b5a", "#7e9e90", "#1c1b19"];

function LatencyBreakdown({ latency, parts }: { latency: Stats["pipelines"][string]["latency"]; parts: Stats["latency_parts"] }) {
  const stages = parts.filter((p) => p.key !== "e2e_latency" && latency[p.key]);
  const max = Math.max(1, ...parts.map((p) => latency[p.key]?.p95 ?? 0));
  if (!Object.keys(latency).length) return null;
  return (
    <div className="mt-6 border-t border-rule pt-5">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[13px] font-medium text-ink-2">Where a reply's time goes</div>
        <div className="text-[12px] text-ink-3">bar = p50, tick = p95</div>
      </div>
      <div className="space-y-2.5">
        {[...stages, ...parts.filter((p) => p.key === "e2e_latency" && latency[p.key])].map((p, i) => {
          const v = latency[p.key];
          const isTotal = p.key === "e2e_latency";
          return (
            <div key={p.key} className="grid grid-cols-[110px_minmax(0,1fr)_96px] items-center gap-3 text-[13px] sm:grid-cols-[150px_minmax(0,1fr)_120px]">
              <div className={isTotal ? "font-medium text-ink" : "text-ink-2"}>{p.label}</div>
              <div className="relative h-3 rounded-sm bg-paper">
                <div
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{ width: `${((v.p50 ?? 0) / max) * 100}%`, background: isTotal ? PART_COLOURS[4] : PART_COLOURS[i % 4] }}
                />
                <div className="absolute inset-y-[-3px] w-px bg-ink-2" style={{ left: `${((v.p95 ?? 0) / max) * 100}%` }} />
              </div>
              <div className="text-right text-ink-2 tabular-nums">
                {ms(v.p50)} <span className="text-ink-3">/ {ms(v.p95)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
