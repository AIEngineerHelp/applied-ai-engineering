import { useEffect, useState } from "react";
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
      <header className="sticky top-0 z-10 border-b border-rule bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3 sm:px-6">
          <a href="#/talk" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-[13px] font-semibold text-paper">R</span>
            <span className="text-[15px] font-medium text-ink">{config?.clinic.name ?? "Clinic voice agent"}</span>
          </a>
          <nav className="-mx-1 flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <a
                key={t.path}
                href={`#/${t.path}`}
                className={`rounded-md px-3 py-1.5 text-[14px] whitespace-nowrap transition-colors ${
                  page === t.path ? "bg-card text-ink shadow-[inset_0_0_0_1px_var(--color-rule-2)]" : "text-ink-3 hover:text-ink"
                }`}
              >
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {error && (
          <div className="mb-6 rounded-lg bg-bad-soft px-4 py-3 text-[14px] text-bad">
            Could not reach the API ({error}). Start it with <code className="font-mono">uv run python -m voiceagent serve</code>.
          </div>
        )}
        {page === "talk" && <TalkPage config={config} />}
        {page === "workflow" && <WorkflowPage />}
        {page === "simulation" && <SimulationPage />}
        {page === "calls" && !route[1] && <CallsPage />}
        {page === "calls" && route[1] && <CallDetailPage id={route[1]} />}
        {page === "webhooks" && <WebhooksPage />}
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-[13px] text-ink-3 sm:px-6">
        A fictional clinic with synthetic patients, built for the AI Engineer Help community. Not for real medical use.
      </footer>
    </div>
  );
}
