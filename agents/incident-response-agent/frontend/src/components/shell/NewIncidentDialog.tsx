'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import useSWR, { useSWRConfig } from 'swr';
import { createIncident, fetcher, keys, type ApiError } from '@/lib/api';
import { logsHref } from '@/lib/route';
import type { DatasetIndex } from '@/lib/types';
import { severityMeta } from '@/lib/meta';
import type { Environment, Incident, Severity } from '@/lib/types';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Dialog } from '../ui/Dialog';
import { useToast } from '../ui/Toast';

const inputClass =
  'w-full rounded-md border border-border-strong bg-bg px-2.5 text-[13px] text-fg placeholder:text-fg-subtle transition-colors duration-150 focus-visible:border-link focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-link max-md:text-[16px]';

interface FormState {
  title: string;
  description: string;
  service: string;
  environment: Environment;
  severity: Severity;
  source: string;
  labels: string;
  /** Loghub dataset the agent should investigate; sent as labels.dataset. */
  dataset: string;
}

const initial: FormState = {
  title: '',
  description: '',
  service: '',
  environment: 'prod',
  severity: 'sev3',
  source: 'manual',
  labels: '',
  dataset: '',
};

function parseLabels(text: string): { labels: Record<string, string>; error: string | null } {
  const labels: Record<string, string> = {};
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { labels, error: `Line ${n + 1}: expected key=value` };
    labels[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { labels, error: null };
}

export function NewIncidentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (incident: Incident) => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { mutate } = useSWRConfig();
  // Only fetched while the dialog is open.
  const datasets = useDatasetsWhen(open);
  const { toast } = useToast();

  const { error: labelError } = parseLabels(form.labels);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function close() {
    if (submitting) return;
    setError(null);
    onClose();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { labels, error: parseError } = parseLabels(form.labels);
    if (parseError) {
      setError(new Error(parseError));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const incident = await createIncident({
        source: form.source.trim() || 'manual',
        title: form.title.trim(),
        description: form.description.trim(),
        service: form.service.trim() || undefined,
        environment: form.environment,
        severity: form.severity,
        labels: form.dataset ? { ...labels, dataset: form.dataset } : labels,
      });
      await mutate(keys.incidentList);
      toast({ kind: 'success', title: 'Incident created', description: incident.title });
      setForm(initial);
      onCreated(incident);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title="New incident">
      <form onSubmit={onSubmit} className="flex min-h-0 flex-col" noValidate={false}>
        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <Field label="Title" htmlFor="ni-title">
            <input
              id="ni-title"
              required
              data-autofocus
              value={form.title}
              onChange={(e) => update('title', e.target.value)}
              placeholder="Checkout latency above SLO"
              className={`${inputClass} h-8 max-md:h-11`}
            />
          </Field>
          <Field label="Description" htmlFor="ni-desc">
            <textarea
              id="ni-desc"
              rows={3}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="What is happening, and what have you observed so far?"
              className={`${inputClass} resize-y py-2 leading-relaxed`}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Service" htmlFor="ni-service" hint="Optional">
              <input
                id="ni-service"
                value={form.service}
                onChange={(e) => update('service', e.target.value)}
                placeholder="checkout-api"
                className={`${inputClass} h-8 max-md:h-11 font-mono`}
              />
            </Field>
            <Field label="Source" htmlFor="ni-source">
              <input
                id="ni-source"
                value={form.source}
                onChange={(e) => update('source', e.target.value)}
                className={`${inputClass} h-8 max-md:h-11 font-mono`}
              />
            </Field>
            <Field label="Environment" htmlFor="ni-env">
              <select
                id="ni-env"
                value={form.environment}
                onChange={(e) => update('environment', e.target.value as Environment)}
                className={`${inputClass} h-8 max-md:h-11 cursor-pointer`}
              >
                <option value="prod">Production</option>
                <option value="staging">Staging</option>
                <option value="dev">Development</option>
              </select>
            </Field>
            <Field label="Severity" htmlFor="ni-sev">
              <select
                id="ni-sev"
                value={form.severity}
                onChange={(e) => update('severity', e.target.value as Severity)}
                className={`${inputClass} h-8 max-md:h-11 cursor-pointer`}
              >
                {(Object.keys(severityMeta) as Severity[]).map((s) => (
                  <option key={s} value={s}>
                    {severityMeta[s].label} · {severityMeta[s].name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="Dataset"
            htmlFor="ni-dataset"
            hint={
              <Link
                href={form.dataset ? logsHref(form.dataset) : logsHref()}
                onClick={close}
                className="rounded text-link hover:underline"
              >
                Browse logs
              </Link>
            }
          >
            <select
              id="ni-dataset"
              value={form.dataset}
              onChange={(e) => update('dataset', e.target.value)}
              className={`${inputClass} h-8 max-md:h-11 cursor-pointer`}
            >
              <option value="">None</option>
              {datasets.data?.datasets.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.title} ({d.name})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Labels" htmlFor="ni-labels" hint="One key=value per line">
            <textarea
              id="ni-labels"
              rows={3}
              value={form.labels}
              onChange={(e) => update('labels', e.target.value)}
              placeholder={'region=us-east-1\nteam=payments'}
              aria-invalid={Boolean(labelError)}
              aria-describedby={labelError ? 'ni-labels-error' : undefined}
              className={`${inputClass} resize-y py-2 font-mono text-[12px] leading-relaxed`}
            />
            {labelError && (
              <p id="ni-labels-error" className="mt-1 text-[13px] text-danger-fg">
                {labelError}
              </p>
            )}
          </Field>
          {error != null && <ErrorNotice error={error} />}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting} disabled={!form.title.trim() || Boolean(labelError)}>
            {submitting ? 'Creating…' : 'Create incident'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg">
          {label}
        </label>
        {hint && <span className="text-[12px] text-fg-subtle">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function useDatasetsWhen(enabled: boolean) {
  return useSWR<DatasetIndex, ApiError>(enabled ? keys.datasets : null, fetcher, { revalidateOnFocus: false, revalidateIfStale: false });
}
