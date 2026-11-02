import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Card, Empty, Mono, PageHeader } from "../components/ui";
import { when } from "../format";

type Data = Awaited<ReturnType<typeof api.webhooks>>;

export function WebhooksPage() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    const load = () => api.webhooks().then(setData).catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <PageHeader
        title="Webhooks"
        lede="After each voice call the agent posts its record to the customer's system. Here that system is a demo receiver in this app: it verifies the HMAC signature and timestamp, and treats a repeated idempotency key as a duplicate, so retries are safe."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Sent (outbox)">
          {!data?.outbox.length && <Empty>Nothing sent yet. Simulations do not send webhooks; voice calls do.</Empty>}
          <ul className="divide-y divide-rule">
            {data?.outbox.map((o) => (
              <li key={o.call_id} className="flex flex-wrap items-center gap-2 py-2.5 text-[14px]">
                <a href={`#/calls/${o.call_id}`} className="hover:underline">
                  <Mono>{o.call_id}</Mono>
                </a>
                <Badge tone={o.status === "delivered" ? "good" : o.status === "failed" ? "bad" : "warn"}>{o.status}</Badge>
                <span className="text-ink-3">
                  {o.attempts} attempt{o.attempts === 1 ? "" : "s"}
                </span>
                {o.last_error && <span className="text-bad">{o.last_error}</span>}
                <span className="ml-auto text-[13px] text-ink-3">{when(o.updated_at)}</span>
              </li>
            ))}
          </ul>
          {data?.outbox.some((o) => o.status !== "delivered") && (
            <div className="mt-3 text-[13px] text-ink-3">
              Redeliver with <Mono>uv run python -m voiceagent retry-webhooks</Mono>.
            </div>
          )}
        </Card>
        <Card title="Received (demo receiver)">
          {!data?.received.length && <Empty>No deliveries received yet.</Empty>}
          <ul className="divide-y divide-rule">
            {data?.received.map((r) => (
              <li key={r.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-[14px]">
                  <Mono>{r.idempotency_key ?? "no key"}</Mono>
                  <Badge tone={r.signature_ok ? "good" : "bad"}>{r.signature_ok ? "signature ok" : "bad signature"}</Badge>
                  {r.duplicate ? <Badge tone="warn">duplicate, ignored</Badge> : null}
                  <span className="ml-auto text-[13px] text-ink-3">{when(r.received_at)}</span>
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-[13px] text-ink-3">payload</summary>
                  <pre className="mt-1 overflow-x-auto rounded-lg bg-paper p-3 font-mono text-[12px] text-ink-2">
                    {pretty(r.body)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
