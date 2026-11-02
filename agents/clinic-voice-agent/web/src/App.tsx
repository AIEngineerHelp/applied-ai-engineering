import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Config } from "./api";
import { CallDetailPage } from "./pages/CallDetail";
import { CallsPage } from "./pages/Calls";
import { SimulationPage } from "./pages/Simulation";
import { TalkPage } from "./pages/Talk";
import { WebhooksPage } from "./pages/Webhooks";
import { WorkflowPage } from "./pages/Workflow";

const TABS = [
  { path: "talk", label: "Talk to the agent" },
  { path: "workflow", label: "Workflow" },
  { path: "simulation", label: "Simulation" },
  { path: "calls", label: "Calls" },
  { path: "webhooks", label: "Webhooks" },
] as const;

function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onHash = () => {
      setRoute(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.config().then(setConfig, (e: Error) => setError(e.message));
  }, []);
  const page = route[0] ?? "talk";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-rule bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3 sm:px-6">
          <a href="#/talk" className="group flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-accent font-serif text-[15px] text-paper transition-transform duration-300 group-hover:rotate-[-8deg]">
              {(config?.clinic.agent_name ?? "M").slice(0, 1)}
            </span>
            <span className="leading-tight">
              <span className="block text-[15px] font-medium text-ink">{config?.clinic.name ?? "Clinic voice agent"}</span>
              <span className="block text-[12px] text-ink-3">Voice front desk · {config?.clinic.agent_name ?? "…"}</span>
            </span>
          </a>
          <Nav page={page} />
          <SystemStatus config={config} error={error} />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {error && (
          <div className="mb-6 rounded-lg bg-bad-soft px-4 py-3 text-[14px] text-bad">
            Could not reach the API ({error}). Start it with <code className="font-mono">uv run python -m voiceagent serve</code>.
          </div>
        )}
        <div key={route.slice(0, 2).join("/")}>
        {page === "talk" && <TalkPage config={config} />}
        {page === "workflow" && <WorkflowPage />}
        {page === "simulation" && <SimulationPage />}
        {page === "calls" && !route[1] && <CallsPage />}
        {page === "calls" && route[1] && <CallDetailPage id={route[1]} />}
        {page === "webhooks" && <WebhooksPage />}
        </div>
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-[13px] text-ink-3 sm:px-6">
        A fictional clinic with synthetic patients, built for the AI Engineer Help community. Not for real medical use.
      </footer>
    </div>
  );
}

/** Tabs with one indicator that slides to the active tab instead of jumping. */
function Nav({ page }: { page: string }) {
  const navRef = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = navRef.current?.querySelector<HTMLElement>(`[data-tab="${page}"]`);
      if (el) setBox({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [page]);
  return (
    <nav ref={navRef} className="relative -mx-1 flex gap-1 overflow-x-auto">
      {box && (
        <span
          aria-hidden
          className="absolute top-0 bottom-0 rounded-md bg-card shadow-[inset_0_0_0_1px_var(--color-rule-2)] transition-[left,width] duration-300 ease-[var(--ease-out-soft)]"
          style={{ left: box.left, width: box.width }}
        />
      )}
      {TABS.map((t) => (
        <a
          key={t.path}
          data-tab={t.path}
          href={`#/${t.path}`}
          className={`relative rounded-md px-3 py-1.5 text-[14px] whitespace-nowrap transition-colors ${
            page === t.path ? "text-ink" : "text-ink-3 hover:text-ink"
          }`}
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}

function SystemStatus({ config, error }: { config: Config | null; error: string | null }) {
  const ok = !error && config?.gemini_key;
  const label = error ? "API offline" : !config ? "Connecting" : config.gemini_key ? "Agent ready" : "Offline mode";
  return (
    <div className="ml-auto hidden items-center gap-2 rounded-full border border-rule bg-card px-3 py-1 text-[12.5px] text-ink-2 md:flex">
      <span className={`h-2 w-2 rounded-full ${error ? "bg-bad" : ok ? "live-dot bg-accent" : "bg-warn"}`} />
      {label}
    </div>
  );
}
