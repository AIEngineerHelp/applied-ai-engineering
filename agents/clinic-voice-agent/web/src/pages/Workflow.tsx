import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Badge, Card, Mono, PageHeader } from "../components/ui";

const TOOL_NOTES: Record<string, string> = {
  find_open_slots: "Pages through the CRM's calendar; remembers what it offered.",
  book_appointment: "Needs a matched patient and a slot offered on this call. Idempotent.",
  reschedule_appointment: "Only the caller's own appointments. Idempotent.",
  cancel_appointment: "Only the caller's own appointments. Idempotent.",
  search_clinic_info: "BM25 over the clinic's policy pages; answers carry their source.",
  transfer_call: "SIP REFER on a phone call; recorded and ended in the browser.",
  end_call: "Hangs up after the goodbye has played.",
};

export function WorkflowPage() {
  const [data, setData] = useState<{ workflow: any; knowledge: string[]; yaml: string } | null>(null);
  useEffect(() => {
    api.workflow().then(setData).catch(() => undefined);
  }, []);
  if (!data) return <div className="text-ink-3">Loading…</div>;
  const wf = data.workflow;

  return (
    <>
      <PageHeader
        title="Workflow"
        lede={
          <>
            One customer's call, as configuration. The model decides what to say; the steps around it are fixed and run in code, so the same
            call goes the same way every time. Edit <Mono>workflow/clinic.yaml</Mono> to change it.
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Stage n="1" title="Before the call" lede="Runs while the phone is ringing.">
          <Step title="Look up the caller">
            Find the patient by phone number and load their upcoming appointments, within{" "}
            <b className="font-medium">{wf.pre_call.patient_lookup.timeout_seconds} s</b>. If the CRM is slow or down, answer anyway with a
            generic greeting and mark the call as degraded.
          </Step>
          <Step title="Greet">
            <Quote>{wf.greeting.known_caller}</Quote>
            <div className="mt-2 text-[13px] text-ink-3">Unknown or unreachable: a variant without the name.</div>
          </Step>
          <Step title="Build the instructions">The patient's name and appointments go into the model's instructions, so it never has to ask.</Step>
        </Stage>

        <Stage n="2" title="During the call" lede="The model talks; code checks every turn first.">
          <Step title="Guards, before the model">
            {wf.guards.map((g: any) => (
              <div key={g.name} className="mt-2 first:mt-0">
                <div className="flex items-center gap-2">
                  <Badge tone="warn">{g.name}</Badge>
                  <span className="text-[13px] text-ink-3">→ {wf.transfers[g.destination].label}</span>
                </div>
                <div className="mt-1 text-[13px] leading-snug text-ink-3">{g.phrases.slice(0, 5).join(", ")}…</div>
              </div>
            ))}
          </Step>
          <Step title="Tools the model may call">
            <ul className="space-y-2">
              {wf.in_call.tools.map((t: string) => (
                <li key={t}>
                  <Mono>{t}</Mono>
                  <div className="text-[13px] leading-snug text-ink-3">{TOOL_NOTES[t]}</div>
                </li>
              ))}
            </ul>
          </Step>
          <Step title="Knowledge base">
            <div className="flex flex-wrap gap-1.5">
              {data.knowledge.map((k) => (
                <Badge key={k}>{k}</Badge>
              ))}
            </div>
          </Step>
          <Step title="Limits">Calls end after {Math.round(wf.in_call.max_call_seconds / 60)} minutes.</Step>
        </Stage>

        <Stage n="3" title="After the call" lede="Runs once the caller hangs up.">
          <Step title="Extract the record">
            Facts (bookings, cancellations, transfers) come from the tool calls that succeeded. A model adds only the intent (
            {wf.post_call.extract.intents.join(", ")}) and a two-sentence summary.
          </Step>
          <Step title="Deliver the webhook">
            Stored in an outbox first, signed with HMAC-SHA256, retried up to {wf.post_call.webhook.max_attempts} times, with the call id as
            the idempotency key.
          </Step>
          <Step title="Transfers">
            {Object.entries(wf.transfers).map(([k, t]: [string, any]) => (
              <div key={k} className="flex justify-between gap-2 text-[13.5px]">
                <span className="text-ink-2">{t.label}</span>
                <Mono>{t.phone}</Mono>
              </div>
            ))}
          </Step>
        </Stage>
      </div>

      <details className="mt-8 rounded-xl border border-rule bg-card">
        <summary className="cursor-pointer px-5 py-3.5 text-[13px] font-medium tracking-wide text-ink-2 uppercase">workflow/clinic.yaml</summary>
        <pre className="overflow-x-auto border-t border-rule p-5 font-mono text-[12.5px] leading-relaxed text-ink-2">{data.yaml}</pre>
      </details>
    </>
  );
}

function Stage({ n, title, lede, children }: { n: string; title: string; lede: string; children: ReactNode }) {
  return (
    <Card>
      <div className="mb-5 flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent font-serif text-[16px] text-paper">{n}</span>
        <div>
          <h2 className="font-serif text-[22px] leading-tight text-ink">{title}</h2>
          <div className="text-[13px] text-ink-3">{lede}</div>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-l-2 border-rule pl-4">
      <div className="text-[14px] font-medium text-ink">{title}</div>
      <div className="mt-1 text-[14px] leading-relaxed text-ink-2">{children}</div>
    </div>
  );
}

function Quote({ children }: { children: ReactNode }) {
  return <div className="font-serif text-[16px] leading-snug text-ink">“{children}”</div>;
}
