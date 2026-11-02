import { useEffect, useState, type ReactNode } from "react";
import { api, type CallDetail, type CallEvent } from "../api";
import { Badge, Card, Mono, Stat, outcomeTone, statusTone } from "../components/ui";
import { duration, ms, pipelineLabel, statusLabel, usd, when } from "../format";

const HIDDEN = new Set(["agent_say", "metric"]);

export function CallDetailPage({ id }: { id: string }) {
  const [call, setCall] = useState<CallDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [showCrm, setShowCrm] = useState(true);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api.call(id).then(
        (c) => {
          if (stop) return;
          setCall(c);
          if (!c.ended_at) setTimeout(load, 2000); // still live: keep following it
        },
        () => !stop && setMissing(true),
      );
    void load();
    return () => {
      stop = true;
    };
  }, [id]);

  if (missing && !call)
    return (
      <div className="text-[15px] text-ink-2">
        No trace for <Mono>{id}</Mono> yet. If the call just started, the agent may still be joining. <a className="text-accent underline" href="#/calls">Back to calls</a>
      </div>
    );
  if (!call) return <div className="text-ink-3">Loading…</div>;

  const s = call.summary;
  // A scripted simulation has no audio and no model, so its turn timings mean nothing.
  const scripted = call.pipeline === "scripted";
  const events = call.events.filter(
    (e) => !HIDDEN.has(e.kind) && (showCrm || e.kind !== "crm_attempt") && !(scripted && e.kind === "turn_metrics"),
  );
  const usage = Object.entries(call.usage?.models ?? {}).filter(([, counts]) => Object.keys(counts).length > 0);
  const length = call.ended_at ? call.ended_at - call.started_at : null;

  return (
    <>
      <a href="#/calls" className="text-[14px] text-ink-3 hover:text-ink">
        ← Calls
      </a>
      <div className="mt-3 mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-[32px] leading-tight text-ink">{call.scenario ?? call.caller_phone ?? "Unknown caller"}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[14px] text-ink-3">
            <Mono>{call.id}</Mono>
            <span>·</span>
            <span>{when(call.started_at)}</span>
            <span>·</span>
            <span>{pipelineLabel(call.pipeline)}</span>
          </div>
        </div>
        <Badge tone={statusTone(call.end_status)}>{statusLabel(call.end_status)}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card
          title="Trace"
          aside={
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="accent-[var(--color-accent)]" checked={showCrm} onChange={(e) => setShowCrm(e.target.checked)} />
              CRM attempts
            </label>
          }
        >
          <ol className="space-y-3">
            {events.map((e) => (
              <li key={e.seq} className="grid grid-cols-[52px_minmax(0,1fr)] gap-3">
                <div className="pt-0.5 text-right font-mono text-[12px] text-ink-3 tabular-nums">+{e.at.toFixed(1)}s</div>
                <div className="min-w-0">
                  <EventRow event={e} />
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <div className="space-y-6">
          <Card title="Call">
            <div className="grid grid-cols-2 gap-5">
              <Stat label="Length" value={duration(length)} />
              <Stat label="Cost" value={usd(call.cost_usd, 4)} note={call.usage ? `prices of ${call.usage.prices_checked}` : undefined} />
            </div>
            <dl className="mt-5 space-y-2 text-[14px]">
              <Row label="Caller">{call.caller_phone ?? "no caller id"}</Row>
              <Row label="Patient">{call.patient_id ?? "not matched"}</Row>
              <Row label="STT">{call.models.stt}</Row>
              <Row label="LLM">{call.models.llm}</Row>
              <Row label="TTS">{call.models.tts}</Row>
            </dl>
          </Card>
          {s && (
            <Card title="Post-call record" aside={s.summary_source === "rules" ? "rules" : s.summary_source}>
              <div className="flex flex-wrap gap-1.5">
                <Badge>{s.intent}</Badge>
                {s.follow_up_needed && <Badge tone="warn">follow-up needed</Badge>}
                {s.crm_degraded && <Badge tone="bad">CRM degraded</Badge>}
              </div>
              <p className="mt-3 font-serif text-[16px] leading-relaxed text-ink">{s.summary}</p>
              {s.actions.length > 0 && (
                <div className="mt-4">
                  <div className="text-[12px] tracking-wide text-ink-3 uppercase">Facts from tool calls</div>
                  <pre className="mt-1.5 overflow-x-auto rounded-lg bg-paper p-3 font-mono text-[12px] leading-relaxed text-ink-2">
                    {JSON.stringify(s.actions, null, 2)}
                  </pre>
                </div>
              )}
            </Card>
          )}
          {usage.length > 0 && (
            <Card title="Usage behind the cost">
              <pre className="overflow-x-auto font-mono text-[12px] leading-relaxed text-ink-2">{JSON.stringify(Object.fromEntries(usage), null, 2)}</pre>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-3">{label}</dt>
      <dd className="truncate text-right font-mono text-[12.5px] text-ink-2">{children}</dd>
    </div>
  );
}

function Note({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "bad" | "good" }) {
  const styles = {
    neutral: "border-rule text-ink-2",
    good: "border-accent/30 bg-accent-soft text-accent",
    warn: "border-transparent bg-warn-soft text-warn",
    bad: "border-transparent bg-bad-soft text-bad",
  }[tone];
  return <div className={`rounded-lg border px-3 py-2 text-[13.5px] ${styles}`}>{children}</div>;
}

function EventRow({ event: e }: { event: CallEvent }) {
  const d = e.data;
  switch (e.kind) {
    case "transcript":
      return (
        <div>
          <div className="text-[12px] tracking-wide text-ink-3 uppercase">{d.role === "user" ? "Caller" : "Agent"}</div>
          <div className={`mt-0.5 font-serif text-[17px] leading-relaxed ${d.role === "user" ? "text-ink" : "text-accent"}`}>
            {d.text}
            {d.interrupted && <span className="ml-2 font-sans text-[12px] text-warn">interrupted</span>}
          </div>
        </div>
      );
    case "turn_metrics": {
      const parts = [
        ["end of turn", d.end_of_turn_delay],
        ["transcript", d.transcription_delay],
        ["LLM first token", d.llm_node_ttft],
        ["TTS first audio", d.tts_node_ttfb],
        ["reply heard", d.e2e_latency],
      ].filter(([, v]) => v != null) as [string, number][];
      return (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
          {parts.map(([label, v]) => (
            <span key={label}>
              {label} <span className="text-ink-2 tabular-nums">{ms(v)}</span>
            </span>
          ))}
        </div>
      );
    }
    case "tool":
      return (
        <details className="group rounded-lg border border-rule bg-paper px-3 py-2">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-[13.5px]">
            <span className="text-ink-3">tool</span>
            <Mono>{d.name}</Mono>
            <Badge tone={outcomeTone(d.outcome)}>{d.outcome}</Badge>
            <span className="text-ink-3 tabular-nums">{ms(d.ms)}</span>
            <span className="ml-auto text-[12px] text-ink-3 group-open:hidden">details</span>
          </summary>
          <pre className="mt-2 overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">
            args {JSON.stringify(d.args)}
            {"\n"}→ {d.result}
          </pre>
        </details>
      );
    case "crm_attempt":
      return (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-ink-3">
          <span>CRM</span>
          <span className="text-ink-2">
            {d.method} {d.path}
          </span>
          <span>→ {d.status ?? "no response"}</span>
          <Badge tone={outcomeTone(d.outcome)}>{d.outcome}</Badge>
          <span className="tabular-nums">{ms(d.ms)}</span>
          {d.attempt > 1 && <span className="text-warn">retry {d.attempt - 1}</span>}
          {d.idempotency_key && <span title={d.idempotency_key}>key {String(d.idempotency_key).slice(0, 8)}</span>}
        </div>
      );
    case "pre_call":
      return (
        <Note tone={d.outcome === "matched" ? "good" : d.outcome.startsWith("crm_") ? "bad" : "neutral"}>
          Pre-call lookup: <b className="font-medium">{d.outcome.replaceAll("_", " ")}</b> in {ms(d.ms)}
          {d.patient_id && <> · {d.patient_id}</>}
          {d.appointments?.length > 0 && <> · {d.appointments.length} upcoming</>}
        </Note>
      );
    case "guard":
      return (
        <Note tone="warn">
          Guard <b className="font-medium">{d.name}</b> matched “{d.phrase}”: the model was skipped and the call goes to {d.destination.replaceAll("_", " ")}.
        </Note>
      );
    case "transfer":
      return (
        <Note>
          Transferred to <b className="font-medium">{d.destination.replaceAll("_", " ")}</b> ({d.mode === "sip_refer" ? "SIP REFER to the phone line" : d.mode})
        </Note>
      );
    case "post_call":
      return (
        <Note>
          Post-call: {statusLabel(d.end_status)}, intent <b className="font-medium">{d.intent}</b>, summary by {d.summary_source}
        </Note>
      );
    case "webhook":
      return (
        <div className="flex items-center gap-2 font-mono text-[12px] text-ink-3">
          <span>webhook attempt {d.attempt}</span>
          <span>→ {d.status ?? "no response"}</span>
          <Badge tone={d.ok ? "good" : "bad"}>{d.ok ? "delivered" : "failed"}</Badge>
          <span>{ms(d.ms)}</span>
        </div>
      );
    case "error":
      return (
        <Note tone="bad">
          Error in {d.where}: {d.error}
        </Note>
      );
    case "close":
      return <div className="text-[13px] text-ink-3">Session closed ({d.reason?.replaceAll("_", " ")})</div>;
    case "call_started":
      return <div className="text-[13px] text-ink-3">Caller joined room {d.room}</div>;
    default:
      return <Mono>{e.kind}</Mono>;
  }
}
