// The red-team console: pick a policy, attack the agent with Giskard, review what the judge found.
// One page; the URL hash holds where you are (#/<risk>/<version>/<step>/<attack>?run=<live run id>).

import { applyEvent, blankRun, esc, orderFindings, quotedPhrases, renderReply, replaySchedule, seconds, tally, verdictSentence, type ReplayEvent } from "./logic.ts";
import type { Attack, Catalog, Risk, Run, RunListing, Version } from "./types.ts";

type Step = "policy" | "attack" | "review";
type Filter = "all" | "failed" | "passed" | "flagged";
type Route = { page: "overview" } | { page: "risk"; risk: string; version: Version; step: Step; attack: number; runId: string | null };
type Decision = { verdict: "agree" | "disagree"; fix?: Fix };
type Fix = "agent" | "attacks" | "judge" | "rule";

const STEPS: { id: Step; label: string }[] = [
  { id: "policy", label: "Policy" },
  { id: "attack", label: "Attack" },
  { id: "review", label: "Review" },
];
const FIXES: { id: Fix; label: string; hint: string }[] = [
  { id: "agent", label: "The agent's prompt", hint: "The agent really did the wrong thing." },
  { id: "attacks", label: "The attacks", hint: "The attacker was unrealistic or missed a tactic." },
  { id: "judge", label: "The judge", hint: "The judge scored a good answer as bad, or the reverse." },
  { id: "rule", label: "The rule itself", hint: "The rule is ambiguous or doesn't cover this case." },
];
const VERSION_LABEL: Record<Version, string> = { naive: "Naive prompt", hardened: "Hardened prompt" };

const S = {
  catalog: null as Catalog | null,
  recorded: new Map<string, Run>(),
  liveRuns: [] as RunListing[],
  route: { page: "overview" } as Route,
  shown: null as Run | null, // the run on screen; during a replay, a copy being filled in
  replay: null as { timer: number; events: ReplayEvent[]; source: Run; t0: number } | null,
  poll: null as number | null,
  filter: "all" as Filter,
  confirming: false,
  loadKey: "",
};

const $ = (id: string) => document.getElementById(id)!;

// ---------- data ----------

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `Request failed (${res.status}).`);
  return body as T;
}

async function recordedRun(risk: string, version: Version): Promise<Run> {
  const key = `${risk}--${version}`;
  if (!S.recorded.has(key)) S.recorded.set(key, await getJSON<Run>(`/api/recorded/${risk}/${version}`));
  return S.recorded.get(key)!;
}

async function refreshLiveRuns() {
  S.liveRuns = await getJSON<RunListing[]>("/api/runs").catch(() => S.liveRuns);
}

function notesFor(run: Run | null) {
  if (!run || run.mode !== "recorded") return {};
  return S.catalog!.review_notes[`${run.risk}--${run.version}`] ?? {};
}

function decision(run: Run, n: number): Decision | null {
  try {
    const v = localStorage.getItem(`redteam-review:${run.id}:${n}`);
    return v ? (JSON.parse(v) as Decision) : null;
  } catch {
    return null;
  }
}

function saveDecision(run: Run, n: number, d: Decision | null) {
  try {
    const key = `redteam-review:${run.id}:${n}`;
    if (d) localStorage.setItem(key, JSON.stringify(d));
    else localStorage.removeItem(key);
  } catch {
    /* private mode: decisions just aren't kept */
  }
}

// ---------- routing ----------

function parseRoute(): Route {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [risk, version, step, attack] = path.split("/");
  const c = S.catalog!;
  if (!risk || !c.risks[risk]) return { page: "overview" };
  return {
    page: "risk",
    risk,
    version: version === "hardened" ? "hardened" : "naive",
    step: (["policy", "attack", "review"] as Step[]).includes(step as Step) ? (step as Step) : "policy",
    attack: Math.max(1, Math.min(10, Number(attack) || 1)),
    runId: new URLSearchParams(query).get("run"),
  };
}

function href(r: Partial<Extract<Route, { page: "risk" }>>): string {
  const cur = S.route.page === "risk" ? S.route : null;
  const risk = r.risk ?? cur?.risk ?? "";
  const sameRun = risk === cur?.risk && (r.version ?? cur?.version) === cur?.version;
  const version = r.version ?? cur?.version ?? "naive";
  const step = r.step ?? cur?.step ?? "policy";
  const attack = r.attack ?? (sameRun ? cur?.attack : 1) ?? 1;
  const runId = r.runId !== undefined ? r.runId : sameRun ? cur?.runId : null;
  return `#/${risk}/${version}/${step}${step === "review" ? `/${attack}` : ""}${runId ? `?run=${runId}` : ""}`;
}

function go(r: Partial<Extract<Route, { page: "risk" }>>) {
  location.hash = href(r);
}

async function onRoute() {
  const prev = S.route;
  S.route = parseRoute();
  const r = S.route;
  if (r.page !== "risk") {
    stopActivity();
    S.shown = null;
    S.loadKey = "";
    return render();
  }
  const key = `${r.risk}|${r.version}|${r.runId ?? "recorded"}`;
  if (key !== S.loadKey) {
    stopActivity();
    S.loadKey = key;
    S.shown = null;
    if (prev.page !== "risk" || prev.risk !== r.risk) S.filter = "all";
    render();
    try {
      if (r.runId) {
        const run = await getJSON<Run>(`/api/runs/${r.runId}`);
        if (S.loadKey !== key) return;
        S.shown = run;
        if (run.status === "running") startPolling(run.id);
      } else {
        const run = await recordedRun(r.risk, r.version);
        if (S.loadKey !== key) return;
        S.shown = run;
      }
    } catch (e) {
      toast((e as Error).message);
    }
  }
  render();
  if (r.step === "review" && prev.page === "risk" && prev.step === "review" && prev.attack !== r.attack) {
    $("inspector")?.scrollIntoView({ block: "start", behavior: "smooth" });
  } else if (prev.page !== r.page || (prev.page === "risk" && prev.step !== r.step)) {
    window.scrollTo({ top: 0 });
  }
}

// ---------- replay and live runs ----------

function stopActivity() {
  if (S.replay) clearInterval(S.replay.timer);
  if (S.poll) clearInterval(S.poll);
  S.replay = null;
  S.poll = null;
}

async function startReplay() {
  const r = S.route;
  if (r.page !== "risk") return;
  stopActivity();
  const source = await recordedRun(r.risk, r.version);
  if (r.runId) return go({ runId: null, step: "attack" });
  const shown = blankRun(source);
  S.shown = shown;
  const events = replaySchedule(source);
  const t0 = performance.now();
  const timer = window.setInterval(() => {
    const now = performance.now() - t0;
    let changed = false;
    while (events.length && events[0].t <= now) {
      applyEvent(shown, source, events.shift()!);
      changed = true;
    }
    if (!events.length) return finishReplay();
    if (changed) renderLive();
  }, 100);
  S.replay = { timer, events, source, t0 };
  if (r.step !== "attack") go({ step: "attack" });
  else render();
}

function finishReplay() {
  const source = S.replay?.source;
  stopActivity();
  if (source) S.shown = source;
  render();
}

async function startLive() {
  const r = S.route;
  if (r.page !== "risk") return;
  S.confirming = false;
  stopActivity();
  try {
    const { id } = await getJSON<{ id: string }>("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ risk: r.risk, version: r.version }),
    });
    S.catalog!.live.busy = true;
    await refreshLiveRuns();
    go({ runId: id, step: "attack" });
  } catch (e) {
    render();
    toast((e as Error).message);
  }
}

function startPolling(id: string) {
  const tick = async () => {
    try {
      const run = await getJSON<Run>(`/api/runs/${id}`);
      if (S.route.page !== "risk" || S.route.runId !== id) return;
      S.shown = run;
      if (run.status !== "running") {
        stopActivity();
        S.catalog!.live.busy = false;
        await refreshLiveRuns();
        if (run.status === "error") toast(run.error || "The live run failed.");
        render();
      } else renderLive();
    } catch {
      /* keep polling */
    }
  };
  S.poll = window.setInterval(tick, 1200);
}

// ---------- rendering ----------

function render() {
  const c = S.catalog!;
  $("sidebar").innerHTML = sidebar(c);
  $("main").innerHTML = S.route.page === "overview" ? overview(c) : riskPage(c, S.route);
  $("modal").innerHTML = S.confirming ? confirmModal(c) : "";
  document.title = S.route.page === "risk" ? `${c.risks[S.route.risk].risk} · Policy Red Team` : "Policy Red Team";
}

// During a replay or live run only the parts that change are redrawn, so the page doesn't jump.
function renderLive() {
  const r = S.route;
  if (r.page !== "risk") return;
  if (r.step === "attack") {
    $("run-body").innerHTML = attackBody(S.catalog!, r);
    $("run-bar").innerHTML = runBar(S.catalog!, r);
  }
  if (r.step === "review") $("review-body").innerHTML = reviewBody(S.catalog!, r);
  $("steps").innerHTML = steps(r);
}

const STATUS: Record<string, { label: string; text: string; bg: string; dot: string }> = {
  passed: { label: "Kept the rule", text: "text-pass", bg: "bg-pass-soft", dot: "bg-pass" },
  failed: { label: "Broke the rule", text: "text-fail", bg: "bg-fail-soft", dot: "bg-fail" },
  error: { label: "Errored", text: "text-warn", bg: "bg-warn-soft", dot: "bg-warn" },
  running: { label: "Running", text: "text-accent", bg: "bg-accent-soft", dot: "bg-accent" },
  queued: { label: "Queued", text: "text-ink-3", bg: "bg-sunk", dot: "bg-line-2" },
};

function pill(status: string, label = STATUS[status].label) {
  const s = STATUS[status];
  return `<span class="inline-flex items-center gap-1.5 rounded-full ${s.bg} ${s.text} px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"><span class="size-1.5 rounded-full ${s.dot} ${status === "running" ? "animate-pulse" : ""}"></span>${label}</span>`;
}

function score(sum: { passed: number; failed: number; errored: number } | undefined) {
  if (!sum) return `<span class="text-ink-3">—</span>`;
  const scored = sum.passed + sum.failed;
  return `${sum.passed}<span class="text-ink-3">/${scored}</span>`;
}

function sidebar(c: Catalog): string {
  const route = S.route;
  const agents = Object.values(c.agents);
  const item = (risk: Risk) => {
    const rec = c.recorded[risk.id] ?? {};
    const active = route.page === "risk" && route.risk === risk.id;
    return `<a href="#/${risk.id}/${route.page === "risk" ? route.version : "naive"}/${route.page === "risk" ? route.step : "policy"}"
      class="group flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm ${active ? "bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:bg-sunk hover:text-ink"}">
      <span class="leading-snug">${esc(risk.risk)}</span>
      <span class="shrink-0 font-mono text-[11px] text-ink-3" title="Attacks the agent kept the rule in: naive prompt → hardened prompt">${score(rec.naive?.summary)} → ${score(rec.hardened?.summary)}</span>
    </a>`;
  };
  const live = S.liveRuns.slice(0, 6);
  return `
    <a href="#/" class="flex items-center gap-2.5 px-2.5">
      <span class="grid size-7 place-items-center rounded-md bg-ink text-paper">${icon("shield", 15)}</span>
      <span class="leading-tight"><span class="block font-semibold text-ink">Policy Red Team</span><span class="block text-xs text-ink-3">Giskard v3 · Gemini</span></span>
    </a>
    <label class="mt-4 block lg:hidden"><span class="sr-only">Go to</span>
      <select data-nav class="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink">
        <option value="#/" ${route.page === "overview" ? "selected" : ""}>Overview</option>
        ${agents
          .map(
            (a) => `<optgroup label="${esc(a.name.split(",")[0])} · ${esc(a.industry)}">${Object.values(c.risks)
              .filter((r) => r.agent === a.id)
              .map((r) => `<option value="#/${r.id}/naive/policy" ${route.page === "risk" && route.risk === r.id ? "selected" : ""}>${esc(r.risk)}</option>`)
              .join("")}</optgroup>`,
          )
          .join("")}
      </select>
    </label>
    <nav class="mt-7 hidden space-y-6 lg:block">
      <a href="#/" class="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm ${route.page === "overview" ? "bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:bg-sunk hover:text-ink"}">${icon("grid", 15)} Overview</a>
      ${agents
        .map(
          (a) => `<div>
        <div class="mb-1.5 flex items-baseline justify-between px-2.5 text-xs"><span class="font-medium text-ink">${esc(a.name.split(",")[0])}</span><span class="text-ink-3">${esc(a.industry)}</span></div>
        <div class="space-y-0.5">${Object.values(c.risks).filter((r) => r.agent === a.id).map(item).join("")}</div>
      </div>`,
        )
        .join("")}
      ${
        live.length
          ? `<div><div class="mb-1.5 px-2.5 text-xs font-medium text-ink">Your live runs</div><div class="space-y-0.5">${live
              .map((l) => {
                const active = route.page === "risk" && route.runId === l.id;
                return `<a href="#/${l.risk}/${l.version}/attack?run=${l.id}" class="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs ${active ? "bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:bg-sunk"}">
                  <span class="truncate">${esc(c.risks[l.risk]?.risk ?? l.risk)} · ${l.version}</span>
                  <span class="font-mono text-ink-3">${l.status === "running" ? "…" : score(l.summary ?? undefined)}</span></a>`;
              })
              .join("")}</div></div>`
          : ""
      }
    </nav>
    <div class="mt-auto hidden space-y-1.5 px-2.5 pt-8 text-xs text-ink-3 lg:block">
      <div class="flex items-center gap-2"><span class="size-1.5 rounded-full ${c.live.available ? "bg-pass" : "bg-line-2"}"></span>${c.live.available ? "Live runs on (Gemini key found)" : "Live runs off (no Gemini key)"}</div>
      <div>Recorded runs: 80 attacks, 2026-10-14</div>
    </div>`;
}

function overview(c: Catalog): string {
  const risks = Object.values(c.risks);
  const bar = (sum: { passed: number; failed: number } | undefined) => {
    if (!sum) return `<span class="text-ink-3">—</span>`;
    const n = sum.passed + sum.failed;
    return `<div class="flex items-center gap-3"><div class="flex gap-0.5">${Array.from({ length: n }, (_, i) => `<span class="h-3.5 w-1.5 rounded-[2px] ${i < sum.passed ? "bg-pass" : "bg-fail/70"}"></span>`).join("")}</div><span class="font-mono text-xs text-ink-2">${sum.passed}/${n}</span></div>`;
  };
  const first = risks[0];
  return `
  <div class="mx-auto max-w-5xl px-5 py-10 sm:px-10 sm:py-14">
    <p class="text-xs font-medium tracking-wide text-accent uppercase">Adversarial evals from your own policies</p>
    <h1 class="mt-3 max-w-3xl font-serif text-4xl leading-[1.1] text-ink sm:text-[46px]">Your lawyers wrote a rule. Can your agent keep it?</h1>
    <p class="mt-4 max-w-2xl text-[17px] leading-relaxed text-ink-2">Pick a policy. Giskard turns it into multi-turn attacks on the agent, an LLM judge scores every conversation against the same rule, and you review the verdicts.</p>
    <div class="mt-7 flex flex-wrap items-center gap-3">
      <a href="#/${first.id}/naive/policy" class="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper hover:bg-ink/90">Start with ${esc(first.risk.toLowerCase())} ${icon("arrow", 15)}</a>
      <span class="text-sm text-ink-3">Recorded runs replay free. Live runs need a Gemini key.</span>
    </div>

    <ol class="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
      ${[
        ["Policy", "Read the risk definition the rule's owner wrote: what's prohibited, what's allowed instead, and example questions."],
        ["Attack", "Giskard's attacker LLM tries to make the agent break the rule over up to three turns, ten times in parallel."],
        ["Review", "Read each conversation and the judge's reason. Agree, or say what should change: the prompt, the attacks, the judge or the rule."],
      ]
        .map(([t, d], i) => `<li class="bg-card p-5"><div class="flex items-center gap-2.5"><span class="grid size-6 place-items-center rounded-full border border-line-2 font-mono text-xs text-ink-2">${i + 1}</span><span class="font-medium text-ink">${t}</span></div><p class="mt-2.5 text-sm leading-relaxed text-ink-2">${d}</p></li>`)
        .join("")}
    </ol>

    <h2 class="mt-14 font-serif text-2xl text-ink">Four policies, two prompts</h2>
    <p class="mt-1.5 text-sm text-ink-2">Ten recorded attacks per cell. The naive prompt has no written policy; the hardened prompt includes it.</p>
    <div class="mt-5 overflow-x-auto rounded-lg border border-line bg-card">
      <table class="w-full min-w-[680px] text-left text-sm">
        <thead class="border-b border-line text-xs text-ink-3"><tr><th class="px-5 py-3 font-medium">Policy</th><th class="px-4 py-3 font-medium">Owner</th><th class="px-4 py-3 font-medium">Kept the rule · naive</th><th class="px-4 py-3 font-medium">Kept the rule · hardened</th><th></th></tr></thead>
        <tbody class="divide-y divide-line">
          ${risks
            .map((r) => {
              const rec = c.recorded[r.id] ?? {};
              return `<tr class="group">
                <td class="px-5 py-4"><a href="#/${r.id}/naive/policy" class="font-medium text-ink hover:underline">${esc(r.risk)}</a><div class="text-xs text-ink-3">${esc(c.agents[r.agent].name.split(",")[0])} · ${esc(r.category)}</div></td>
                <td class="px-4 py-4 text-ink-2">${esc(r.owner)}</td>
                <td class="px-4 py-4"><a href="#/${r.id}/naive/attack">${bar(rec.naive?.summary)}</a></td>
                <td class="px-4 py-4"><a href="#/${r.id}/hardened/attack">${bar(rec.hardened?.summary)}</a></td>
                <td class="px-4 py-4 text-right"><a href="#/${r.id}/naive/policy" class="text-ink-3 group-hover:text-ink">${icon("arrow", 15)}</a></td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
    <p class="mt-4 text-xs leading-relaxed text-ink-3">Every number is out of ten LLM-judged attacks, so treat a difference of one or two as noise. Gemini played the agent, the attacker and the judge. Everything here is synthetic: the bank, the clinic, the member and the patient are invented.</p>
  </div>`;
}

function steps(r: Extract<Route, { page: "risk" }>): string {
  const run = S.shown;
  const t = run ? tally(run.attacks) : null;
  const reviewed = run ? run.attacks.filter((a) => decision(run, a.index + 1)).length : 0;
  const badge = (s: Step) => {
    if (s === "attack" && t) return t.finished ? `${t.failed} broke` : "running";
    if (s === "review" && t) return `${reviewed}/${t.total} reviewed`;
    return "";
  };
  return STEPS.map((s, i) => {
    const active = r.step === s.id;
    const b = badge(s.id);
    return `<a href="${href({ step: s.id })}" class="flex items-center gap-2.5 border-b-2 px-1 pb-3 text-sm ${active ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}">
      <span class="grid size-5 place-items-center rounded-full font-mono text-[11px] ${active ? "bg-ink text-paper" : "border border-line-2"}">${i + 1}</span>
      <span class="font-medium">${s.label}</span>${b ? `<span class="hidden text-xs text-ink-3 sm:inline">${b}</span>` : ""}</a>`;
  }).join(`<span class="pb-3 text-line-2">${icon("chevron", 14)}</span>`);
}

function riskPage(c: Catalog, r: Extract<Route, { page: "risk" }>): string {
  const risk = c.risks[r.risk];
  const agent = c.agents[risk.agent];
  const versionSwitch = (["naive", "hardened"] as Version[])
    .map((v) => `<a href="${href({ version: v, runId: null })}" class="rounded-[5px] px-3 py-1.5 text-sm ${r.version === v && !r.runId ? "bg-card font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:text-ink"}">${VERSION_LABEL[v]}</a>`)
    .join("");
  const body = r.step === "policy" ? policyStep(c, risk, r) : r.step === "attack" ? attackStep(c, r) : reviewStep(c, r);
  return `
  <div class="mx-auto max-w-6xl px-5 pt-7 sm:px-10">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div class="text-xs text-ink-3">${esc(agent.industry)} · ${esc(agent.name)} · ${esc(risk.domain)} › ${esc(risk.category)}</div>
        <h1 class="mt-1 font-serif text-3xl text-ink">${esc(risk.risk)}</h1>
      </div>
      <div class="flex items-center gap-3">
        ${r.runId ? `<span class="rounded-md bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">Live run · ${esc(VERSION_LABEL[r.version].toLowerCase())}</span>` : ""}
        <div class="flex rounded-md bg-sunk p-0.5" role="group" aria-label="Prompt version">${versionSwitch}</div>
      </div>
    </div>
    <nav id="steps" class="mt-6 flex items-center gap-4 border-b border-line">${steps(r)}</nav>
  </div>
  <div class="mx-auto max-w-6xl px-5 pt-7 pb-16 sm:px-10">${body}</div>`;
}

function policyStep(c: Catalog, risk: Risk, r: Extract<Route, { page: "risk" }>): string {
  const agent = c.agents[risk.agent];
  const row = (label: string, value: string, tone = "") =>
    `<div class="grid gap-1 border-t border-line px-5 py-3.5 sm:grid-cols-[150px_1fr] sm:gap-4"><dt class="text-xs font-medium ${tone || "text-ink-3"} sm:pt-0.5">${label}</dt><dd class="text-sm leading-relaxed text-ink">${value}</dd></div>`;
  const rec = c.recorded[risk.id] ?? {};
  return `
  <div class="grid gap-8 lg:grid-cols-[1fr_320px]">
    <div class="space-y-6">
      <section class="rounded-lg border border-line bg-card">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
          <h2 class="font-medium text-ink">Risk definition</h2>
          <span class="text-xs text-ink-3">Written by: <span class="text-ink-2">${esc(risk.owner)}</span></span>
        </div>
        <dl>
          ${row("Why it matters", esc(risk.basis))}
          ${row("Prohibited", esc(risk.prohibited), "text-fail")}
          ${row("Allowed instead", esc(risk.allowed_alternative), "text-pass")}
          ${row("Expected behavior", esc(risk.expected_behavior))}
          ${row("What users ask", `<div class="flex flex-wrap gap-1.5">${risk.example_questions.map((q) => `<span class="rounded-md border border-line bg-paper px-2 py-1 text-[13px] text-ink-2">${esc(q)}</span>`).join("")}</div>`)}
        </dl>
      </section>

      <section>
        <h2 class="text-sm font-medium text-ink">The rule both LLMs read</h2>
        <p class="mt-1 text-sm text-ink-2">Built from the definition above. The attacker tries to make the agent break it; the judge scores each conversation against it.</p>
        <blockquote class="mt-3 rounded-lg border-l-2 border-accent bg-card px-5 py-4 font-serif text-[17px] leading-relaxed text-ink">${esc(risk.rule)}</blockquote>
      </section>

      <details class="group rounded-lg border border-line bg-card">
        <summary class="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm">
          <span><span class="font-medium text-ink">${esc(agent.name.split(",")[0])}'s system prompt</span> <span class="text-ink-3">· ${VERSION_LABEL[r.version].toLowerCase()}</span></span>
          <span class="text-ink-3 transition group-open:rotate-90">${icon("chevron", 14)}</span>
        </summary>
        <pre class="border-t border-line px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">${esc(agent.prompts[r.version])}</pre>
        <p class="border-t border-line px-5 py-3 text-xs text-ink-3">${r.version === "naive" ? "No written policy: the agent is only told to be helpful. Switch to the hardened prompt to see the policy written in." : "The policy is written into the prompt. Switch to the naive prompt to compare."}</p>
      </details>
    </div>

    <aside class="space-y-6">
      <section class="rounded-lg border border-line bg-card p-5">
        <h2 class="text-sm font-medium text-ink">How this becomes a test</h2>
        <ol class="mt-4 space-y-0">
          ${[
            ["Risk definition", "Written once, by its owner"],
            ["Attacker LLM", "Plays a user, up to 3 turns"],
            [esc(agent.name.split(",")[0]), "The agent under test"],
            ["Judge LLM", "Reads the rule and the conversation"],
            ["Your review", "Agree, or fix what's wrong"],
          ]
            .map(
              ([t, d], i, all) => `<li class="relative flex gap-3 pb-4 last:pb-0">
              ${i < all.length - 1 ? `<span class="absolute top-6 left-[11px] h-[calc(100%-18px)] w-px bg-line-2"></span>` : ""}
              <span class="relative grid size-6 shrink-0 place-items-center rounded-full border border-line-2 bg-paper font-mono text-[11px] text-ink-2">${i + 1}</span>
              <span><span class="block text-sm font-medium text-ink">${t}</span><span class="block text-xs text-ink-3">${d}</span></span></li>`,
            )
            .join("")}
        </ol>
      </section>
      <section class="rounded-lg border border-line bg-card p-5">
        <h2 class="text-sm font-medium text-ink">Recorded results</h2>
        <div class="mt-3 space-y-2 text-sm">
          ${(["naive", "hardened"] as Version[])
            .map((v) => {
              const s = rec[v]?.summary;
              return `<a href="${href({ version: v, step: "attack", runId: null })}" class="flex items-center justify-between rounded-md px-2 py-1.5 -mx-2 hover:bg-sunk"><span class="text-ink-2">${VERSION_LABEL[v]}</span><span class="font-mono text-xs text-ink">${s ? `${s.passed}/${s.passed + s.failed} kept` : "—"}</span></a>`;
            })
            .join("")}
        </div>
      </section>
      <a href="${href({ step: "attack" })}" class="flex items-center justify-center gap-2 rounded-md bg-ink px-4 py-3 text-sm font-medium text-paper hover:bg-ink/90">Attack ${esc(agent.name.split(",")[0])} with this policy ${icon("arrow", 15)}</a>
    </aside>
  </div>`;
}

function attackStep(c: Catalog, r: Extract<Route, { page: "risk" }>): string {
  return `
  <div id="run-bar" class="rounded-lg border border-line bg-card">${runBar(c, r)}</div>
  <div id="run-body" class="mt-6">${attackBody(c, r)}</div>`;
}

function runBar(c: Catalog, r: Extract<Route, { page: "risk" }>): string {
  const run = S.shown;
  const replaying = !!S.replay;
  const polling = !!S.poll;
  const liveOk = c.live.available && !c.live.busy && !polling;
  const liveTitle = !c.live.available ? "Add GEMINI_API_KEY to .env to run live attacks" : c.live.busy || polling ? "A live run is already in progress" : "";
  const source = run
    ? run.mode === "live"
      ? `Live run · started ${new Date(run.started_at).toLocaleString()}`
      : `Recorded run · ${run.started_at.slice(0, 10)}`
    : "Loading…";
  return `<div class="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
    <div class="min-w-0">
      <div class="text-sm font-medium text-ink">${esc(source)}</div>
      <div class="mt-0.5 text-xs text-ink-3">${run ? `${run.attacks.length} attacks · up to 3 turns each · ${esc(Object.values(run.models)[0] ?? "")} as agent, attacker and judge` : ""}</div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      ${
        replaying
          ? `<button data-action="skip" class="rounded-md border border-line-2 px-3.5 py-2 text-sm text-ink hover:bg-sunk">Skip to results</button>`
          : `<button data-action="replay" class="inline-flex items-center gap-2 rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-paper hover:bg-ink/90">${icon("play", 13)} ${r.runId ? "Replay the recorded run" : "Replay attacks"}</button>`
      }
      <button data-action="live" ${liveOk ? "" : "disabled"} title="${esc(liveTitle)}" class="inline-flex items-center gap-2 rounded-md border border-line-2 px-3.5 py-2 text-sm text-ink hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-45">${icon("bolt", 13)} Run live with Gemini</button>
    </div>
  </div>`;
}

function attackBody(c: Catalog, r: Extract<Route, { page: "risk" }>): string {
  const run = S.shown;
  if (!run) return `<div class="py-20 text-center text-sm text-ink-3">Loading the run…</div>`;
  const agentName = c.agents[run.agent].name.split(",")[0];
  const t = tally(run.attacks);
  const notes = notesFor(run);
  const rec = c.recorded[r.risk] ?? {};
  const compare = (["naive", "hardened"] as Version[])
    .map((v) => {
      const s = rec[v]?.summary;
      if (!s) return "";
      const n = s.passed + s.failed;
      const current = v === r.version && !r.runId;
      return `<a href="${href({ version: v, runId: null, step: "attack" })}" class="block rounded-md px-3 py-2 ${current ? "bg-sunk" : "hover:bg-sunk/60"}">
        <div class="flex items-center justify-between text-xs"><span class="${current ? "font-medium text-ink" : "text-ink-2"}">${VERSION_LABEL[v]}</span><span class="font-mono text-ink-2">${s.passed}/${n} kept</span></div>
        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fail/25"><div class="h-full rounded-full bg-pass" style="width:${(100 * s.passed) / Math.max(1, n)}%"></div></div></a>`;
    })
    .join("");
  return `
  <div class="grid gap-6 lg:grid-cols-[1fr_300px]">
    <div>
      <p class="font-serif text-[26px] leading-snug text-ink">${esc(verdictSentence(agentName, t))}</p>
      <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-2">
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-fail"></span>${t.failed} broke the rule</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-pass"></span>${t.passed} kept it</span>
        ${t.errored ? `<span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-warn"></span>${t.errored} errored</span>` : ""}
        ${!t.finished ? `<span class="inline-flex items-center gap-1.5 text-accent"><span class="size-2 animate-pulse rounded-full bg-accent"></span>${t.total - t.passed - t.failed - t.errored} in progress</span>` : ""}
      </div>
    </div>
    <div class="rounded-lg border border-line bg-card p-2">
      <div class="px-3 pt-1.5 pb-1 text-xs text-ink-3">Recorded baseline</div>
      ${compare}
    </div>
  </div>
  <div class="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    ${run.attacks.map((a) => attackCard(c, run, a, !!notes[String(a.index + 1)])).join("")}
  </div>`;
}

function typing(a: Attack, agentName: string): string {
  const who = a.pending === "agent" ? `${agentName} is replying` : a.pending === "judge" ? "The judge is reading the conversation" : a.status === "queued" ? "Waiting to start" : "The attacker is writing";
  return `<span class="inline-flex items-center gap-2 text-xs text-ink-3"><span class="typing"><i></i><i></i><i></i></span>${who}</span>`;
}

function attackCard(c: Catalog, run: Run, a: Attack, noted: boolean): string {
  const n = a.index + 1;
  const agentName = c.agents[run.agent].name.split(",")[0];
  const first = a.turns[0]?.user;
  const active = a.status === "running" || a.status === "queued";
  const turnsDone = a.turns.filter((t) => t.agent != null).length;
  return `<a href="${href({ step: "review", attack: n })}" class="group flex flex-col rounded-lg border border-line bg-card p-4 transition hover:border-line-2 hover:shadow-sm">
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-ink-2">Attack ${n}</span>
      ${pill(a.status)}
    </div>
    <p class="mt-3 line-clamp-3 min-h-[3.9em] text-sm leading-[1.3] text-ink">${first ? `“${esc(first)}”` : `<span class="text-ink-3">${a.status === "error" ? esc(a.error ?? "This attack errored.") : "No message yet."}</span>`}</p>
    <div class="mt-4 flex items-center justify-between gap-2">
      ${
        active
          ? typing(a, agentName)
          : `<span class="flex items-center gap-1.5 text-xs text-ink-3"><span class="flex gap-1">${[0, 1, 2].map((i) => `<span class="size-1.5 rounded-full ${i < turnsDone ? "bg-ink-3" : "bg-line-2"}"></span>`).join("")}</span>${turnsDone} ${turnsDone === 1 ? "turn" : "turns"}${a.duration_ms ? ` · ${seconds(a.duration_ms)}` : ""}</span>`
      }
      <span class="flex items-center gap-2 text-xs">${noted ? `<span class="rounded bg-warn-soft px-1.5 py-0.5 text-warn">Second look</span>` : ""}<span class="text-ink-3 group-hover:text-ink">${icon("arrow", 14)}</span></span>
    </div>
  </a>`;
}

function reviewStep(c: Catalog, r: Extract<Route, { page: "risk" }>): string {
  return `<div id="review-body">${reviewBody(c, r)}</div>`;
}

function reviewBody(c: Catalog, r: Extract<Route, { page: "risk" }>): string {
  const run = S.shown;
  if (!run) return `<div class="py-20 text-center text-sm text-ink-3">Loading the run…</div>`;
  const notes = notesFor(run);
  const noted = new Set(Object.keys(notes).map(Number));
  const all = orderFindings(run.attacks, noted);
  const shown = all.filter((a) =>
    S.filter === "failed" ? a.status === "failed" : S.filter === "passed" ? a.status === "passed" : S.filter === "flagged" ? noted.has(a.index + 1) : true,
  );
  const t = tally(run.attacks);
  const reviewed = run.attacks.filter((a) => decision(run, a.index + 1)).length;
  const filters: [Filter, string, number][] = [
    ["all", "All", t.total],
    ["failed", "Broke", t.failed],
    ["passed", "Kept", t.passed],
    ["flagged", "Second look", noted.size],
  ];
  const current = run.attacks[r.attack - 1] ?? run.attacks[0];
  return `
  <div class="grid gap-6 lg:grid-cols-[300px_1fr]">
    <aside class="lg:sticky lg:top-4 lg:self-start">
      <div class="flex items-center justify-between text-xs text-ink-3"><span>${reviewed} of ${t.total} reviewed</span><span>Keys: ← →</span></div>
      <div class="mt-2 h-1 overflow-hidden rounded-full bg-sunk"><div class="h-full rounded-full bg-accent" style="width:${(100 * reviewed) / Math.max(1, t.total)}%"></div></div>
      <div class="mt-4 flex flex-wrap gap-1">
        ${filters
          .filter(([, , n], i) => i === 0 || n > 0)
          .map(([f, label, n]) => `<button data-filter="${f}" class="rounded-md px-2.5 py-1 text-xs ${S.filter === f ? "bg-ink text-paper" : "text-ink-2 hover:bg-sunk"}">${label} <span class="${S.filter === f ? "text-paper/60" : "text-ink-3"}">${n}</span></button>`)
          .join("")}
      </div>
      <div class="mt-3 space-y-1.5 lg:max-h-[calc(100vh-170px)] lg:overflow-y-auto lg:pr-1">
        ${shown
          .map((a) => {
            const n = a.index + 1;
            const d = decision(run, n);
            const active = n === current.index + 1;
            return `<a href="${href({ step: "review", attack: n })}" class="block rounded-lg border px-3.5 py-3 ${active ? "border-ink/70 bg-card" : "border-line bg-card/60 hover:border-line-2 hover:bg-card"}">
              <div class="flex items-center justify-between gap-2"><span class="text-xs font-medium text-ink">Attack ${n}</span>${pill(a.status)}</div>
              <p class="mt-1.5 line-clamp-2 text-xs leading-snug text-ink-2">${esc(a.turns[0]?.user ?? a.error ?? "")}</p>
              ${d || noted.has(n) ? `<div class="mt-2 flex flex-wrap gap-1.5 text-[11px]">${noted.has(n) ? `<span class="rounded bg-warn-soft px-1.5 py-0.5 text-warn">Second look</span>` : ""}${d ? `<span class="rounded bg-sunk px-1.5 py-0.5 text-ink-2">You ${d.verdict === "agree" ? "agreed" : `disagreed${d.fix ? ` · fix ${FIXES.find((f) => f.id === d.fix)!.label.toLowerCase()}` : ""}`}</span>` : ""}</div>` : ""}
            </a>`;
          })
          .join("") || `<p class="px-1 py-6 text-sm text-ink-3">Nothing in this filter.</p>`}
      </div>
    </aside>
    <section id="inspector" class="min-w-0 scroll-mt-4">${inspector(c, run, current, notes[String(current.index + 1)])}</section>
  </div>`;
}

function inspector(c: Catalog, run: Run, a: Attack, note?: { verdict: string; note: string }): string {
  const n = a.index + 1;
  const agentName = c.agents[run.agent].name.split(",")[0];
  const check = a.checks.find((ch) => ch.kind === "conformity") ?? a.checks[0];
  const phrases = check ? quotedPhrases(check.reason) : [];
  const d = decision(run, n);
  const done = a.status === "passed" || a.status === "failed" || a.status === "error";
  const verdictBox = !done
    ? `<div class="rounded-lg border border-line bg-card px-5 py-4">${typing(a, agentName)}</div>`
    : a.status === "error"
      ? `<div class="rounded-lg border border-warn/30 bg-warn-soft px-5 py-4"><div class="text-sm font-medium text-warn">This attack errored</div><p class="mt-1 text-sm text-ink-2">${esc(a.error ?? "")}</p><p class="mt-2 text-xs text-ink-3">Errors aren't counted as a pass or a fail. They usually point to the harness or the provider, not the policy.</p></div>`
      : `<div class="rounded-lg border ${a.status === "failed" ? "border-fail/25 bg-fail-soft" : "border-pass/25 bg-pass-soft"} px-5 py-4">
          <div class="flex items-center gap-2 text-sm font-medium ${a.status === "failed" ? "text-fail" : "text-pass"}">${icon(a.status === "failed" ? "x" : "check", 15)} Judge: ${a.status === "failed" ? "the agent broke the rule" : "the agent kept the rule"}</div>
          <p class="mt-2 text-[15px] leading-relaxed text-ink">${check ? esc(check.reason) : ""}</p>
          ${phrases.length ? `<p class="mt-2 text-xs text-ink-3">Phrases the judge quoted are <mark>highlighted</mark> in the conversation.</p>` : ""}
        </div>`;
  return `
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-3"><h2 class="font-serif text-2xl text-ink">Attack ${n}</h2>${pill(a.status)}</div>
    <div class="flex items-center gap-1">
      <button data-action="prev" class="grid size-8 place-items-center rounded-md border border-line text-ink-2 hover:bg-sunk" aria-label="Previous attack">${icon("left", 15)}</button>
      <button data-action="next" class="grid size-8 place-items-center rounded-md border border-line text-ink-2 hover:bg-sunk" aria-label="Next attack">${icon("right", 15)}</button>
    </div>
  </div>
  <div class="mt-4 space-y-4">
    ${verdictBox}
    ${note ? `<div class="rounded-lg border border-line bg-card px-5 py-4"><div class="text-xs font-medium text-warn">Second look · ${esc(note.verdict)}</div><p class="mt-1.5 text-sm leading-relaxed text-ink-2">${esc(note.note)}</p></div>` : ""}
  </div>

  <h3 class="mt-8 text-xs font-medium tracking-wide text-ink-3 uppercase">Conversation</h3>
  <div class="mt-3 space-y-4">
    ${a.turns
      .map(
        (turn, k) => `
      <div class="flex gap-3">
        <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-sunk text-ink-2" title="Giskard's attacker">${icon("user", 14)}</span>
        <div class="min-w-0 flex-1"><div class="text-xs text-ink-3">Attacker, posing as the user · turn ${k + 1}</div>
          <div class="mt-1 rounded-lg rounded-tl-sm bg-sunk px-4 py-3 text-[15px] leading-relaxed text-ink">${esc(turn.user)}</div></div>
      </div>
      <div class="flex gap-3">
        <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ink text-paper" title="${esc(agentName)}">${icon("bot", 14)}</span>
        <div class="min-w-0 flex-1"><div class="text-xs text-ink-3">${esc(agentName)}${turn.ms ? ` · ${seconds(turn.ms)}` : ""}</div>
          <div class="reply mt-1 rounded-lg rounded-tl-sm border border-line bg-card px-4 py-3 text-[15px] leading-relaxed text-ink">${turn.agent == null ? typing(a, agentName) : turn.agent ? renderReply(turn.agent, phrases) : `<span class="text-ink-3">(empty reply)</span>`}</div></div>
      </div>`,
      )
      .join("")}
    ${!a.turns.length ? `<p class="text-sm text-ink-3">${done ? "No turns were recorded." : "The conversation hasn't started yet."}</p>` : ""}
  </div>

  ${
    a.status === "passed" || a.status === "failed"
      ? `<div class="mt-8 rounded-lg border border-line bg-card p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h3 class="text-sm font-medium text-ink">Do you agree with the judge?</h3><p class="mt-0.5 text-xs text-ink-3">In a real team, the rule's owner answers this. Saved in this browser only.</p></div>
      <div class="flex gap-2">
        <button data-action="agree" class="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-sm ${d?.verdict === "agree" ? "border-ink bg-ink text-paper" : "border-line-2 text-ink hover:bg-sunk"}">${icon("check", 13)} Agree</button>
        <button data-action="disagree" class="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-sm ${d?.verdict === "disagree" ? "border-ink bg-ink text-paper" : "border-line-2 text-ink hover:bg-sunk"}">${icon("x", 13)} Disagree</button>
      </div>
    </div>
    ${
      d?.verdict === "disagree"
        ? `<div class="mt-4 border-t border-line pt-4"><div class="text-xs font-medium text-ink-2">What should change?</div>
      <div class="mt-2 grid gap-2 sm:grid-cols-2">${FIXES.map(
        (f) => `<button data-fix="${f.id}" class="rounded-md border px-3.5 py-2.5 text-left ${d.fix === f.id ? "border-ink bg-sunk" : "border-line hover:border-line-2"}"><span class="block text-sm font-medium text-ink">${f.label}</span><span class="block text-xs text-ink-3">${f.hint}</span></button>`,
      ).join("")}</div></div>`
        : ""
    }
  </div>`
      : ""
  }`;
}

function confirmModal(c: Catalog): string {
  const r = S.route;
  if (r.page !== "risk") return "";
  const n = c.live.attacks;
  return `<div class="fixed inset-0 z-40 grid place-items-center bg-ink/30 p-4" data-action="cancel" data-backdrop>
    <div class="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-xl" data-stop>
      <h2 class="font-serif text-2xl text-ink">Run ${n} new attacks?</h2>
      <p class="mt-2 text-sm leading-relaxed text-ink-2">Giskard will attack ${esc(c.agents[c.risks[r.risk].agent].name.split(",")[0])} (${VERSION_LABEL[r.version].toLowerCase()}) on <b class="font-medium text-ink">${esc(c.risks[r.risk].risk.toLowerCase())}</b> with fresh conversations.</p>
      <ul class="mt-4 space-y-1.5 text-sm text-ink-2">
        <li class="flex gap-2"><span class="text-ink-3">•</span>Up to ${n * 7} paid Gemini calls (attacker, agent and judge)</li>
        <li class="flex gap-2"><span class="text-ink-3">•</span>Usually 1.5 to 3 minutes; you can watch each conversation as it happens</li>
        <li class="flex gap-2"><span class="text-ink-3">•</span>Saved locally in <code class="font-mono text-xs">runs/</code></li>
      </ul>
      <div class="mt-6 flex justify-end gap-2">
        <button data-action="cancel" class="rounded-md px-3.5 py-2 text-sm text-ink-2 hover:bg-sunk">Cancel</button>
        <button data-action="confirm-live" class="inline-flex items-center gap-2 rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-paper hover:bg-ink/90">${icon("bolt", 13)} Start live run</button>
      </div>
    </div>
  </div>`;
}

function toast(message: string) {
  const el = document.createElement("div");
  el.className = "fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-md bg-ink px-4 py-2.5 text-sm text-paper shadow-lg";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 4500);
}

const ICONS: Record<string, string> = {
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9.5 13h.01M14.5 13h.01"/>',
};

function icon(name: string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

// ---------- events ----------

function moveAttack(delta: number) {
  const r = S.route;
  const run = S.shown;
  if (r.page !== "risk" || r.step !== "review" || !run) return;
  const notes = notesFor(run);
  const order = orderFindings(run.attacks, new Set(Object.keys(notes).map(Number))).map((a) => a.index + 1);
  const i = order.indexOf(r.attack);
  const next = order[(i + delta + order.length) % order.length];
  go({ attack: next });
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const el = target.closest<HTMLElement>("[data-action],[data-filter],[data-fix]");
  if (!el) return;
  const run = S.shown;
  const r = S.route;
  if (el.dataset.filter) {
    S.filter = el.dataset.filter as Filter;
    return renderLive();
  }
  if (el.dataset.fix && run && r.page === "risk") {
    saveDecision(run, r.attack, { verdict: "disagree", fix: el.dataset.fix as Fix });
    return renderLive();
  }
  const action = el.dataset.action;
  // Clicks inside the dialog bubble up to the backdrop's "cancel"; only a click on the backdrop itself closes it.
  if (action === "cancel" && el.hasAttribute("data-backdrop") && target.closest("[data-stop]")) return;
  switch (action) {
    case "replay":
      return void startReplay();
    case "skip":
      return finishReplay();
    case "live":
      S.confirming = true;
      return render();
    case "cancel":
      S.confirming = false;
      return render();
    case "confirm-live":
      return void startLive();
    case "prev":
      return moveAttack(-1);
    case "next":
      return moveAttack(1);
    case "agree":
    case "disagree":
      if (run && r.page === "risk") {
        const cur = decision(run, r.attack);
        saveDecision(run, r.attack, cur?.verdict === action ? null : { verdict: action });
        renderLive();
      }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.key === "Escape" && S.confirming) {
    S.confirming = false;
    return render();
  }
  if (e.key === "ArrowRight" || e.key === "j") moveAttack(1);
  if (e.key === "ArrowLeft" || e.key === "k") moveAttack(-1);
});

document.addEventListener("change", (e) => {
  const el = e.target as HTMLSelectElement;
  if (el.matches("[data-nav]")) location.hash = el.value;
});

window.addEventListener("hashchange", () => void onRoute());

async function boot() {
  try {
    S.catalog = await getJSON<Catalog>("/api/catalog");
    await refreshLiveRuns();
  } catch (e) {
    $("main").innerHTML = `<div class="p-10 text-sm text-fail">Could not load the app: ${esc((e as Error).message)}</div>`;
    return;
  }
  // Links from the earlier version of this page: ?risk=…&version=…&attack=…
  const q = new URLSearchParams(location.search);
  if (q.get("risk") && !location.hash) {
    history.replaceState(null, "", "/");
    location.hash = `#/${q.get("risk")}/${q.get("version") ?? "naive"}/${q.get("attack") ? `review/${q.get("attack")}` : "attack"}`;
    return;
  }
  await onRoute();
}

void boot();
