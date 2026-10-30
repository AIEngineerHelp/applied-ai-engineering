// The app: a start page (the concept), the red-team console, and "what we measured".
// One page; the URL hash holds where you are:
//   #/                                  start page
//   #/measured/<section>                what we measured
//   #/<risk>/<version>/<step>/<attack>?set=<seeded|recorded>&run=<live run id>   the console

import { home } from "./home.ts";
import { applyEvent, blankRun, esc, orderFindings, quotedPhrases, renderReply, replaySchedule, seconds, staticURL, tally, verdictSentence, type ReaderLabel, type ReplayEvent } from "./logic.ts";
import { SECTIONS, measured, type FaceoffRuns } from "./measured.ts";
import type { Attack, Catalog, LabelledConversation, Risk, Run, RunListing, SetName, StackId, Study, Version } from "./types.ts";
import { SET_HINT, SET_LABEL, VERSION_LABEL, agentShort, chip, icon, pill, raterName } from "./ui.ts";

type Step = "policy" | "attack" | "review";
type Filter = "all" | "failed" | "passed" | "flagged";
type RiskRoute = { page: "risk"; risk: string; version: Version; step: Step; attack: number; runId: string | null; set: SetName };
type Route = { page: "home"; set: SetName } | { page: "measured"; section: string | null } | RiskRoute;
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

const S = {
  catalog: null as Catalog | null,
  study: null as Study | null,
  example: null as Run | null,
  stack: "judge_and_regex" as StackId, // the stack shown in "Stack the checks"
  faceoff: {} as FaceoffRuns,
  faceoffLoading: false,
  recorded: new Map<string, Run>(),
  liveRuns: [] as RunListing[],
  route: { page: "home", set: "seeded" } as Route,
  shown: null as Run | null, // the run on screen; during a replay, a copy being filled in
  replay: null as { timer: number; events: ReplayEvent[]; source: Run; t0: number } | null,
  poll: null as number | null,
  filter: "all" as Filter,
  confirming: false,
  loadKey: "",
};

const $ = (id: string) => document.getElementById(id)!;

// ---------- data ----------

const STATIC = document.documentElement.hasAttribute("data-static");

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(STATIC ? staticURL(url) : url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `Request failed (${res.status}).`);
  return body as T;
}

async function recordedRun(risk: string, version: Version, set: SetName): Promise<Run> {
  const key = `${set}:${risk}--${version}`;
  if (!S.recorded.has(key)) S.recorded.set(key, await getJSON<Run>(`/api/recorded/${risk}/${version}?set=${set}`));
  return S.recorded.get(key)!;
}

async function refreshLiveRuns() {
  S.liveRuns = await getJSON<RunListing[]>("/api/runs").catch(() => S.liveRuns);
}

function setOf(run: Run | null): SetName | "live" {
  if (!run || run.mode === "live") return "live";
  return run.seeded ? "seeded" : "recorded";
}

function notesFor(run: Run | null) {
  if (!run || setOf(run) !== "recorded") return {};
  return S.catalog!.review_notes[`${run.risk}--${run.version}`] ?? {};
}

function ourLabel(run: Run | null, n: number): LabelledConversation | undefined {
  if (!run || setOf(run) !== "recorded") return undefined;
  return S.study?.conversations.find((c) => c.risk === run.risk && c.version === run.version && c.attack === n);
}

// The reader's labels live in localStorage only, one key per conversation.
const LABEL_PREFIX = "redteam-label:";

function readerLabel(run: Run, n: number): ReaderLabel | null {
  try {
    const v = localStorage.getItem(`${LABEL_PREFIX}${run.id}:${n}`);
    return v ? (JSON.parse(v) as ReaderLabel) : null;
  } catch {
    return null;
  }
}

function saveReaderLabel(run: Run, n: number, l: ReaderLabel | null) {
  try {
    const key = `${LABEL_PREFIX}${run.id}:${n}`;
    if (l) localStorage.setItem(key, JSON.stringify(l));
    else localStorage.removeItem(key);
  } catch {
    /* private mode: labels just aren't kept */
  }
}

function allReaderLabels(): ReaderLabel[] {
  const out: ReaderLabel[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LABEL_PREFIX)) out.push(JSON.parse(localStorage.getItem(k)!) as ReaderLabel);
    }
  } catch {
    /* unavailable storage: no labels */
  }
  return out;
}

// ---------- routing ----------

function parseRoute(): Route {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const q = new URLSearchParams(query);
  const set: SetName = q.get("set") === "recorded" ? "recorded" : "seeded";
  const [first, version, step, attack] = path.split("/");
  const c = S.catalog!;
  if (first === "measured") return { page: "measured", section: version || null };
  if (!first || !c.risks[first]) return { page: "home", set };
  return {
    page: "risk",
    risk: first,
    version: version === "hardened" ? "hardened" : "naive",
    step: (["policy", "attack", "review"] as Step[]).includes(step as Step) ? (step as Step) : "policy",
    attack: Math.max(1, Math.min(10, Number(attack) || 1)),
    runId: q.get("run"),
    set,
  };
}

function href(r: Partial<RiskRoute>): string {
  const cur = S.route.page === "risk" ? S.route : null;
  const risk = r.risk ?? cur?.risk ?? "";
  const version = r.version ?? cur?.version ?? "naive";
  const set = r.set ?? cur?.set ?? "seeded";
  const sameRun = risk === cur?.risk && version === cur?.version && set === cur?.set;
  const step = r.step ?? cur?.step ?? "policy";
  const attack = r.attack ?? (sameRun ? cur?.attack : 1) ?? 1;
  const runId = r.runId !== undefined ? r.runId : sameRun ? cur?.runId : null;
  const query = new URLSearchParams();
  if (set !== "seeded") query.set("set", set);
  if (runId) query.set("run", runId);
  const qs = query.toString();
  return `#/${risk}/${version}/${step}${step === "review" ? `/${attack}` : ""}${qs ? `?${qs}` : ""}`;
}

function go(r: Partial<RiskRoute>) {
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
    render();
    if (r.page === "measured") {
      void loadExample();
      void loadFaceoff();
      // Scroll to the section once; the page is laid out in one pass, so nothing moves afterwards.
      const target = r.section ? document.getElementById(`m-${r.section}`) : null;
      if (target) target.scrollIntoView({ block: "start" });
      else if (prev.page !== "measured") window.scrollTo({ top: 0 });
    } else if (prev.page !== "home") window.scrollTo({ top: 0 });
    return;
  }
  const key = `${r.risk}|${r.version}|${r.set}|${r.runId ?? "recorded"}`;
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
        const run = await recordedRun(r.risk, r.version, r.set);
        if (S.loadKey !== key) return;
        S.shown = run;
      }
    } catch (e) {
      toast((e as Error).message);
    }
  }
  render();
  if (r.step === "review" && prev.page === "risk" && prev.step === "review" && prev.attack !== r.attack) {
    const el = $("inspector");
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  } else if (prev.page !== r.page || (prev.page === "risk" && prev.step !== r.step)) {
    window.scrollTo({ top: 0 });
  }
}

/** The half-refusal on the measured page comes from a recorded run; fetch it once. */
async function loadExample() {
  const ex = S.study?.examples.half_refusal;
  if (!ex || S.example) return;
  try {
    S.example = await recordedRun(ex.risk, ex.version, "recorded");
    if (S.route.page === "measured") {
      const y = window.scrollY;
      render();
      window.scrollTo({ top: y }); // the figure keeps its place; the reader's scroll position wins
    }
  } catch {
    /* the figure keeps its link to the conversation */
  }
}

/** The face-off conversations are only needed on the measured page; fetch them once, together. */
async function loadFaceoff() {
  const f = S.study?.faceoff;
  if (!f || S.faceoffLoading || Object.keys(S.faceoff).length) return;
  S.faceoffLoading = true;
  const keys = (["crescendo", "goat"] as const).flatMap((st) => f.cells.filter((k) => f.styles[st]?.[k]).map((k) => `${st}/${k}`));
  const runs = await Promise.all(keys.map((k) => getJSON<Run>(`/api/faceoff/${k.replace("--", "/")}`).catch(() => null)));
  keys.forEach((k, i) => runs[i] && (S.faceoff[k] = runs[i]!));
  if (S.route.page === "measured") {
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y }); // the reader's scroll position wins
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
  const source = await recordedRun(r.risk, r.version, r.set);
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
  renderLive();
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
  const r = S.route;
  $("sidebar").innerHTML = sidebar(c);
  $("main").innerHTML =
    r.page === "home" ? home(c, S.study, r.set) : r.page === "measured" ? measured(c, S.study, allReaderLabels(), S.example, S.stack, S.faceoff) : riskPage(c, r);
  $("modal").innerHTML = S.confirming ? confirmModal(c) : "";
  document.title = r.page === "risk" ? `${c.risks[r.risk].risk} · Policy Red Team` : r.page === "measured" ? "What we measured · Policy Red Team" : "Policy Red Team";
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

function score(sum: { passed: number; failed: number; errored: number } | null | undefined) {
  if (!sum) return `<span class="text-ink-3">—</span>`;
  return `${sum.passed}<span class="text-ink-3">/${sum.passed + sum.failed}</span>`;
}

function navLink(target: string, label: string, iconName: string, active: boolean) {
  return `<a href="${target}" class="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm ${active ? "bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:bg-sunk hover:text-ink"}">${icon(iconName, 15)} ${label}</a>`;
}

function liveRunRow(c: Catalog, l: RunListing, route: Route): string {
  const active = route.page === "risk" && route.runId === l.id;
  const when = new Date(l.started_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const state =
    l.status === "running" ? `<span class="text-accent">running</span>` : l.status === "interrupted" ? `<span class="text-warn" title="The server stopped before this run finished">unfinished</span>` : l.status === "error" ? `<span class="text-warn">errored</span>` : "";
  return `<a href="#/${l.risk}/${l.version}/attack?run=${l.id}" class="block rounded-md px-2.5 py-1.5 text-xs ${active ? "bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:bg-sunk"}">
    <span class="flex items-center justify-between gap-2"><span class="truncate">${esc(c.risks[l.risk]?.risk ?? l.risk)} · ${l.version}</span><span class="shrink-0 font-mono text-ink-3" title="Attacks the agent kept the rule in, of those scored">${l.status === "running" ? "…" : `kept ${score(l.summary)}`}</span></span>
    <span class="mt-0.5 flex gap-2 text-[11px] text-ink-3">${when}${state ? ` · ${state}` : ""}</span></a>`;
}

function sidebar(c: Catalog): string {
  const route = S.route;
  const set = route.page === "risk" ? route.set : route.page === "home" ? route.set : "seeded";
  const agents = Object.values(c.agents);
  const item = (risk: Risk) => {
    const rec = c.sets[set]?.[risk.id] ?? {};
    const active = route.page === "risk" && route.risk === risk.id;
    const target = route.page === "risk" ? href({ risk: risk.id, attack: 1, runId: null }) : `#/${risk.id}/naive/policy${set === "recorded" ? "?set=recorded" : ""}`;
    return `<a href="${target}"
      class="flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm ${active ? "bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:bg-sunk hover:text-ink"}">
      <span class="leading-snug">${esc(risk.risk)}</span>
      <span class="shrink-0 font-mono text-[11px] text-ink-3" title="Attacks the agent kept the rule in: naive prompt → hardened prompt (${SET_LABEL[set].toLowerCase()})">${score(rec.naive?.summary)} → ${score(rec.hardened?.summary)}</span>
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
        <option value="#/" ${route.page === "home" ? "selected" : ""}>Start here</option>
        ${agents
          .map(
            (a) => `<optgroup label="Console · ${esc(agentShort(a.name))}">${Object.values(c.risks)
              .filter((r) => r.agent === a.id)
              .map((r) => `<option value="#/${r.id}/naive/policy" ${route.page === "risk" && route.risk === r.id ? "selected" : ""}>${esc(r.risk)}</option>`)
              .join("")}</optgroup>`,
          )
          .join("")}
        <optgroup label="What we measured">${SECTIONS.map(([id, t]) => `<option value="#/measured/${id}" ${route.page === "measured" && route.section === id ? "selected" : ""}>${t}</option>`).join("")}</optgroup>
      </select>
    </label>
    <nav class="mt-7 hidden space-y-6 lg:block">
      <div class="space-y-0.5">
        ${navLink("#/", "Start here", "home", route.page === "home")}
        ${navLink("#/measured", "What we measured", "chart", route.page === "measured")}
        ${navLink("/article", "The article", "book", false)}
      </div>
      ${
        route.page === "measured"
          ? `<div><div class="mb-1.5 px-2.5 text-xs font-medium text-ink">On this page</div><div class="space-y-0.5">${SECTIONS.map(([id, t], i) => `<a href="#/measured/${id}" class="flex gap-2 rounded-md px-2.5 py-1.5 text-sm ${route.section === id ? "text-ink" : "text-ink-2 hover:bg-sunk hover:text-ink"}"><span class="font-mono text-xs text-ink-3">${i + 1}</span>${t}</a>`).join("")}</div></div>`
          : ""
      }
      <div class="space-y-5">
        <div class="px-2.5 text-xs font-medium tracking-wide text-ink-3 uppercase">Console</div>
        ${agents
          .map(
            (a) => `<div>
          <div class="mb-1.5 flex items-baseline justify-between px-2.5 text-xs"><span class="font-medium text-ink">${esc(agentShort(a.name))}</span><span class="text-ink-3">${esc(a.industry)}</span></div>
          <div class="space-y-0.5">${Object.values(c.risks).filter((r) => r.agent === a.id).map(item).join("")}</div>
        </div>`,
          )
          .join("")}
      </div>
      ${live.length ? `<div><div class="mb-1.5 px-2.5 text-xs font-medium text-ink">Your live runs</div><div class="space-y-0.5">${live.map((l) => liveRunRow(c, l, route)).join("")}</div></div>` : ""}
    </nav>
    <div class="mt-auto hidden space-y-1.5 px-2.5 pt-8 text-xs text-ink-3 lg:block">
      <div class="flex items-center gap-2"><span class="size-1.5 rounded-full ${c.live.available ? "bg-pass" : "bg-line-2"}"></span>${c.live.available ? "Live runs on (Gemini key found)" : c.live.hosted ? "Live runs off (run it locally)" : "Live runs off (no Gemini key)"}</div>
      <div>Scores: ${SET_LABEL[set].toLowerCase()}</div>
    </div>`;
}

function steps(r: RiskRoute): string {
  const run = S.shown;
  const t = run ? tally(run.attacks) : null;
  const labelled = run ? run.attacks.filter((a) => readerLabel(run, a.index + 1)).length : 0;
  const badge = (s: Step) => {
    if (s === "attack" && t) return t.finished ? `${t.failed} broke` : "running";
    if (s === "review" && t) return `${labelled}/${t.total} labelled`;
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

function riskPage(c: Catalog, r: RiskRoute): string {
  const risk = c.risks[r.risk];
  const agent = c.agents[risk.agent];
  const versionSwitch = (["naive", "hardened"] as Version[])
    .map((v) => `<a href="${href({ version: v, runId: null })}" class="rounded-[5px] px-3 py-1.5 text-sm ${r.version === v && !r.runId ? "bg-card font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:text-ink"}">${VERSION_LABEL[v]}</a>`)
    .join("");
  const setSwitch = (["seeded", "recorded"] as SetName[])
    .map((s) => `<a href="${href({ set: s, runId: null })}" title="${esc(SET_HINT[s])}" class="rounded-[5px] px-3 py-1.5 text-sm ${r.set === s && !r.runId ? "bg-card font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:text-ink"}">${SET_LABEL[s]}</a>`)
    .join("");
  const body = r.step === "policy" ? policyStep(c, risk, r) : r.step === "attack" ? attackStep(c, r) : reviewStep(c, r);
  return `
  <div class="mx-auto max-w-6xl px-5 pt-7 sm:px-10">
    <div class="text-xs text-ink-3">${esc(agent.industry)} · ${esc(agent.name)} · ${esc(risk.domain)} › ${esc(risk.category)}</div>
    <div class="mt-1 flex flex-wrap items-end justify-between gap-3">
      <h1 class="font-serif text-3xl text-ink">${esc(risk.risk)}</h1>
      <div class="flex flex-wrap items-center gap-2">
        ${r.runId ? `<span class="rounded-md bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">Live run · ${esc(VERSION_LABEL[r.version].toLowerCase())}</span>` : ""}
        <div class="flex rounded-md bg-sunk p-0.5" role="group" aria-label="Prompt version">${versionSwitch}</div>
        <div class="flex rounded-md bg-sunk p-0.5" role="group" aria-label="Attack set">${setSwitch}</div>
      </div>
    </div>
    <nav id="steps" class="mt-6 flex items-center gap-4 overflow-x-auto border-b border-line">${steps(r)}</nav>
  </div>
  <div class="mx-auto max-w-6xl px-5 pt-7 pb-16 sm:px-10">${body}</div>`;
}

function policyStep(c: Catalog, risk: Risk, r: RiskRoute): string {
  const agent = c.agents[risk.agent];
  const row = (label: string, value: string, tone = "") =>
    `<div class="grid gap-1 border-t border-line px-5 py-3.5 sm:grid-cols-[150px_1fr] sm:gap-4"><dt class="text-xs font-medium ${tone || "text-ink-3"} sm:pt-0.5">${label}</dt><dd class="text-sm leading-relaxed text-ink">${value}</dd></div>`;
  const rec = c.sets[r.set]?.[risk.id] ?? {};
  const revisions = c.revisions[risk.id];
  return `
  <div class="grid gap-8 lg:grid-cols-[1fr_320px]">
    <div class="min-w-0 space-y-6">
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
          ${row("What users ask", `<div class="flex flex-wrap gap-1.5">${risk.example_questions.map((q) => `<span class="rounded-md border border-line bg-paper px-2 py-1 text-[13px] text-ink-2">${esc(q)}</span>`).join("")}</div><p class="mt-2 text-xs text-ink-3">${r.set === "seeded" ? "In the seeded set, each attack starts from one of these questions, with its own persona and tactic." : "In the first recording, the attacker saw these only as one shared list."}</p>`)}
        </dl>
      </section>

      <section>
        <h2 class="text-sm font-medium text-ink">The rule both LLMs read</h2>
        <p class="mt-1 text-sm text-ink-2">Built from the definition above. The attacker tries to make the agent break it; the judge scores each conversation against it.</p>
        <blockquote class="mt-3 rounded-lg border-l-2 border-accent bg-card px-5 py-4 font-serif text-[17px] leading-relaxed text-ink">${esc(risk.rule)}</blockquote>
        ${revisions ? `<p class="mt-2 text-xs text-ink-3">This is revision 1, which every recording uses. After review, the owner added a clarification: <a href="#/measured/loop" class="text-accent hover:underline">see revision 2 and what it changed</a>.</p>` : ""}
      </section>

      <details class="group rounded-lg border border-line bg-card">
        <summary class="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm">
          <span><span class="font-medium text-ink">${esc(agentShort(agent.name))}'s system prompt</span> <span class="text-ink-3">· ${VERSION_LABEL[r.version].toLowerCase()}</span></span>
          <span class="text-ink-3 transition group-open:rotate-90">${icon("chevron", 14)}</span>
        </summary>
        <pre class="border-t border-line px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">${esc(agent.prompts[r.version])}</pre>
        <p class="border-t border-line px-5 py-3 text-xs text-ink-3">${r.version === "naive" ? "No written policy: the agent is only told to be helpful. Switch to the hardened prompt to see the policy written in." : "The policy is written into the prompt. Switch to the naive prompt to compare."}</p>
      </details>
    </div>

    <aside class="space-y-6">
      <section class="rounded-lg border border-line bg-card p-5">
        <h2 class="text-sm font-medium text-ink">How this becomes a test</h2>
        <ol class="mt-4">
          ${[
            ["Risk definition", "Written once, by its owner"],
            ["Attacker LLM", r.set === "seeded" ? "Plays a seeded user, up to 3 turns" : "Plays a user, up to 3 turns"],
            [esc(agentShort(agent.name)), "The agent under test"],
            ["Judge LLM", "Reads the rule and the conversation"],
            ["Your review", "Label it; say what should change"],
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
        <h2 class="text-sm font-medium text-ink">Recorded results · ${SET_LABEL[r.set].toLowerCase()}</h2>
        <div class="mt-3 space-y-2 text-sm">
          ${(["naive", "hardened"] as Version[])
            .map((v) => {
              const s = rec[v]?.summary;
              return `<a href="${href({ version: v, step: "attack", runId: null })}" class="-mx-2 flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-sunk"><span class="text-ink-2">${VERSION_LABEL[v]}</span><span class="font-mono text-xs text-ink">${s ? `${s.passed}/${s.passed + s.failed} kept` : "—"}</span></a>`;
            })
            .join("")}
        </div>
      </section>
      <a href="${href({ step: "attack" })}" class="flex items-center justify-center gap-2 rounded-md bg-ink px-4 py-3 text-sm font-medium text-paper hover:bg-ink/90">Attack ${esc(agentShort(agent.name))} with this policy ${icon("arrow", 15)}</a>
    </aside>
  </div>`;
}

function attackStep(c: Catalog, r: RiskRoute): string {
  return `
  <div id="run-bar" class="rounded-lg border border-line bg-card">${runBar(c, r)}</div>
  <div id="run-body" class="mt-6">${attackBody(c, r)}</div>`;
}

function runBar(c: Catalog, r: RiskRoute): string {
  const run = S.shown;
  const replaying = !!S.replay;
  const polling = !!S.poll;
  const liveOk = c.live.available && !c.live.busy && !polling;
  const liveTitle = c.live.hosted ? "Live runs need a local copy with GEMINI_API_KEY in .env" : !c.live.available ? "Add GEMINI_API_KEY to .env to run live attacks" : c.live.busy || polling ? "A live run is already in progress" : "";
  const source = run ? (run.mode === "live" ? `Live run · started ${new Date(run.started_at).toLocaleString()}` : `${SET_LABEL[r.set]} · ${run.started_at.slice(0, 10)}`) : "Loading…";
  const models = run ? [...new Set(Object.values(run.models))] : [];
  return `<div class="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
    <div class="min-w-0">
      <div class="text-sm font-medium text-ink">${esc(source)}</div>
      <div class="mt-0.5 text-xs text-ink-3">${run ? `${run.attacks.length} attacks · up to 3 turns each · ${run.seeded ? "each seeded with a question, persona and tactic" : "one shared brief"} · ${esc(models.join(", "))}` : ""}</div>
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

function attackBody(c: Catalog, r: RiskRoute): string {
  const run = S.shown;
  if (!run) return `<div class="py-20 text-center text-sm text-ink-3">Loading the run…</div>`;
  const agentName = agentShort(c.agents[run.agent].name);
  const t = tally(run.attacks);
  const notes = notesFor(run);
  const compare = (["seeded", "recorded"] as SetName[])
    .flatMap((set) =>
      (["naive", "hardened"] as Version[]).map((v) => {
        const s = c.sets[set]?.[r.risk]?.[v]?.summary;
        if (!s) return "";
        const n = s.passed + s.failed;
        const current = v === r.version && set === r.set && !r.runId;
        return `<a href="${href({ version: v, set, runId: null, step: "attack" })}" class="block rounded-md px-3 py-1.5 ${current ? "bg-sunk" : "hover:bg-sunk/60"}">
          <div class="flex items-center justify-between text-xs"><span class="${current ? "font-medium text-ink" : "text-ink-2"}">${VERSION_LABEL[v]}</span><span class="font-mono text-ink-2">${s.passed}/${n} kept</span></div>
          <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-fail/25"><div class="h-full rounded-full bg-pass" style="width:${(100 * s.passed) / Math.max(1, n)}%"></div></div></a>`;
      }),
    )
    .reduce<string[]>((acc, html, i) => (i % 2 === 0 ? [...acc, `<div class="px-3 pt-2 pb-0.5 text-[11px] text-ink-3">${SET_LABEL[i === 0 ? "seeded" : "recorded"]}</div>${html}`] : [...acc, html]), [])
    .join("");
  return `
  <div class="grid gap-6 lg:grid-cols-[1fr_300px]">
    <div class="min-w-0">
      <p class="font-serif text-[26px] leading-snug text-ink">${esc(verdictSentence(agentName, t))}</p>
      <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-2">
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-fail"></span>${t.failed} broke the rule</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-pass"></span>${t.passed} kept it</span>
        ${t.errored ? `<span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-warn"></span>${t.errored} errored</span>` : ""}
        ${!t.finished ? `<span class="inline-flex items-center gap-1.5 text-accent"><span class="size-2 animate-pulse rounded-full bg-accent"></span>${t.total - t.passed - t.failed - t.errored} in progress</span>` : ""}
      </div>
      <p class="mt-3 max-w-xl text-sm leading-relaxed text-ink-3">The verdicts are the judge's. Open any attack to read the conversation and label it yourself.</p>
    </div>
    <div class="rounded-lg border border-line bg-card p-1.5 pb-2">${compare}</div>
  </div>
  <div class="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    ${run.attacks.map((a) => attackCard(c, run, a, !!notes[String(a.index + 1)])).join("")}
  </div>`;
}

function typing(a: Attack, agentName: string): string {
  const who = a.pending === "agent" ? `${agentName} is replying` : a.pending === "judge" ? "The judge is reading the conversation" : a.status === "queued" ? "Waiting to start" : "The attacker is writing";
  return `<span class="inline-flex items-center gap-2 text-xs text-ink-3"><span class="typing"><i></i><i></i><i></i></span>${who}</span>`;
}

function seedLine(a: Attack): string {
  if (!a.seed) return "";
  return `<div class="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-3"><span class="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-accent">${esc(a.seed.tactic)}</span><span class="truncate" title="${esc(a.seed.persona)}">${esc(a.seed.persona)}</span></div>`;
}

function attackCard(c: Catalog, run: Run, a: Attack, noted: boolean): string {
  const n = a.index + 1;
  const agentName = agentShort(c.agents[run.agent].name);
  const first = a.turns[0]?.user;
  const active = a.status === "running" || a.status === "queued";
  const turnsDone = a.turns.filter((t) => t.agent != null).length;
  const mine = readerLabel(run, n);
  return `<a href="${href({ step: "review", attack: n })}" class="group flex min-w-0 flex-col rounded-lg border border-line bg-card p-4 transition hover:border-line-2 hover:shadow-sm">
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-ink-2">Attack ${n}</span>
      ${pill(a.status)}
    </div>
    ${seedLine(a)}
    <p class="mt-3 line-clamp-3 min-h-[3.9em] text-sm leading-[1.3] text-ink">${first ? `“${esc(first)}”` : `<span class="text-ink-3">${a.status === "error" ? esc(a.error ?? "This attack errored.") : "No message yet."}</span>`}</p>
    <div class="mt-4 flex items-center justify-between gap-2">
      ${
        active
          ? typing(a, agentName)
          : `<span class="flex items-center gap-1.5 text-xs text-ink-3"><span class="flex gap-1">${[0, 1, 2].map((i) => `<span class="size-1.5 rounded-full ${i < turnsDone ? "bg-ink-3" : "bg-line-2"}"></span>`).join("")}</span>${turnsDone} ${turnsDone === 1 ? "turn" : "turns"}${a.duration_ms ? ` · ${seconds(a.duration_ms)}` : ""}</span>`
      }
      <span class="flex items-center gap-2 text-xs">${mine ? `<span class="rounded bg-sunk px-1.5 py-0.5 text-ink-2">You: ${mine.label === "pass" ? "kept" : "broke"}</span>` : ""}${noted ? `<span class="rounded bg-warn-soft px-1.5 py-0.5 text-warn">Second look</span>` : ""}<span class="text-ink-3 group-hover:text-ink">${icon("arrow", 14)}</span></span>
    </div>
  </a>`;
}

function reviewStep(c: Catalog, r: RiskRoute): string {
  return `<div id="review-body">${reviewBody(c, r)}</div>`;
}

function reviewBody(c: Catalog, r: RiskRoute): string {
  const run = S.shown;
  if (!run) return `<div class="py-20 text-center text-sm text-ink-3">Loading the run…</div>`;
  const notes = notesFor(run);
  const noted = new Set(Object.keys(notes).map(Number));
  const all = orderFindings(run.attacks, noted);
  const shown = all.filter((a) =>
    S.filter === "failed" ? a.status === "failed" : S.filter === "passed" ? a.status === "passed" : S.filter === "flagged" ? noted.has(a.index + 1) : true,
  );
  const t = tally(run.attacks);
  const labelled = run.attacks.filter((a) => readerLabel(run, a.index + 1)).length;
  const filters: [Filter, string, number][] = [
    ["all", "All", t.total],
    ["failed", "Broke", t.failed],
    ["passed", "Kept", t.passed],
    ["flagged", "Second look", noted.size],
  ];
  const current = run.attacks[r.attack - 1] ?? run.attacks[0];
  return `
  <div class="grid gap-6 lg:grid-cols-[300px_1fr]">
    <aside class="min-w-0 lg:sticky lg:top-4 lg:self-start">
      <div class="flex items-center justify-between text-xs text-ink-3"><span>You labelled ${labelled} of ${t.total}</span><span class="hidden sm:inline">Keys: ← →</span></div>
      <div class="mt-2 h-1 overflow-hidden rounded-full bg-sunk"><div class="h-full rounded-full bg-accent" style="width:${(100 * labelled) / Math.max(1, t.total)}%"></div></div>
      <div class="mt-4 flex flex-wrap gap-1">
        ${filters
          .filter(([, , n], i) => i === 0 || n > 0)
          .map(([f, label, n]) => `<button data-filter="${f}" class="rounded-md px-2.5 py-1 text-xs ${S.filter === f ? "bg-ink text-paper" : "text-ink-2 hover:bg-sunk"}">${label} <span class="${S.filter === f ? "text-paper/60" : "text-ink-3"}">${n}</span></button>`)
          .join("")}
      </div>
      <div class="mt-3 max-h-60 space-y-1.5 overflow-y-auto pr-1 lg:max-h-[calc(100vh-170px)]">
        ${shown
          .map((a) => {
            const n = a.index + 1;
            const mine = readerLabel(run, n);
            const active = n === current.index + 1;
            return `<a href="${href({ step: "review", attack: n })}" class="block rounded-lg border px-3.5 py-3 ${active ? "border-ink/70 bg-card" : "border-line bg-card/60 hover:border-line-2 hover:bg-card"}">
              <div class="flex items-center justify-between gap-2"><span class="text-xs font-medium text-ink">Attack ${n}</span>${pill(a.status)}</div>
              <p class="mt-1.5 line-clamp-2 text-xs leading-snug text-ink-2">${esc(a.turns[0]?.user ?? a.error ?? "")}</p>
              ${mine || noted.has(n) ? `<div class="mt-2 flex flex-wrap gap-1.5 text-[11px]">${noted.has(n) ? `<span class="rounded bg-warn-soft px-1.5 py-0.5 text-warn">Second look</span>` : ""}${mine ? `<span class="rounded bg-sunk px-1.5 py-0.5 text-ink-2">You: ${mine.label === "pass" ? "kept the rule" : "broke the rule"}${mine.fix ? ` · fix ${FIXES.find((f) => f.id === mine.fix)!.label.toLowerCase()}` : ""}</span>` : ""}</div>` : ""}
            </a>`;
          })
          .join("") || `<p class="px-1 py-6 text-sm text-ink-3">Nothing in this filter.</p>`}
      </div>
    </aside>
    <section id="inspector" class="min-w-0 scroll-mt-4">${inspector(c, run, current, notes[String(current.index + 1)])}</section>
  </div>`;
}

function labelPanel(run: Run, a: Attack): string {
  const n = a.index + 1;
  const mine = readerLabel(run, n);
  const ours = ourLabel(run, n);
  const judgePassed = a.status === "passed";
  const btn = (value: "pass" | "fail", text: string, ic: string) =>
    `<button data-label="${value}" aria-pressed="${mine?.label === value}" class="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-sm ${mine?.label === value ? "border-ink bg-ink text-paper" : "border-line-2 text-ink hover:bg-sunk"}">${icon(ic, 13)} ${text}</button>`;
  const disagree = mine && (mine.label === "pass") !== judgePassed;
  const compare = mine
    ? `<div class="mt-4 border-t border-line pt-4">
        <div class="text-xs font-medium text-ink-2">How others scored it</div>
        <div class="mt-2 flex flex-wrap gap-1.5">${chip("You", mine.label === "pass")} ${chip(`Judge (${run.models.judge})`, judgePassed)}${
          ours ? ` ${Object.entries(ours.judges).filter(([m]) => m !== run.models.judge).map(([m, v]) => chip(raterName(m), v.passed)).join(" ")} ${chip("Our label", ours.label === "pass")} ${chip("Keyword check", ours.keyword)}` : ""
        }</div>
        ${ours ? `<p class="mt-2 text-sm leading-relaxed text-ink-2"><span class="text-ink-3">Our reading${ours.borderline ? " (borderline)" : ""}:</span> ${esc(ours.reason)}</p>` : `<p class="mt-2 text-xs text-ink-3">${setOf(run) === "recorded" ? "We didn't label this one." : "Our labels and the second judge cover the first recording only."}</p>`}
        ${
          disagree
            ? `<div class="mt-4"><div class="text-xs font-medium text-ink-2">You disagree with the judge. What should change?</div>
          <div class="mt-2 grid gap-2 sm:grid-cols-2">${FIXES.map((f) => `<button data-fix="${f.id}" class="rounded-md border px-3.5 py-2.5 text-left ${mine.fix === f.id ? "border-ink bg-sunk" : "border-line hover:border-line-2"}"><span class="block text-sm font-medium text-ink">${f.label}</span><span class="block text-xs text-ink-3">${f.hint}</span></button>`).join("")}</div></div>`
            : ""
        }
      </div>`
    : `<p class="mt-3 text-xs text-ink-3">Label it first; then you'll see how the judges${ours ? ", our label and the keyword check" : ""} scored it.</p>`;
  return `<div class="mt-8 rounded-lg border border-line bg-card p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h3 class="text-sm font-medium text-ink">Your label: did the agent keep the rule?</h3><p class="mt-0.5 text-xs text-ink-3">Read the whole conversation against the rule. In a real team, the rule's owner answers this. Saved in this browser only.</p></div>
      <div class="flex gap-2">${btn("pass", "Kept the rule", "check")}${btn("fail", "Broke the rule", "x")}</div>
    </div>
    ${compare}
  </div>`;
}

function inspector(c: Catalog, run: Run, a: Attack, note?: { verdict: string; note: string }): string {
  const n = a.index + 1;
  const agentName = agentShort(c.agents[run.agent].name);
  const check = a.checks.find((ch) => ch.kind === "conformity") ?? a.checks[0];
  const phrases = check ? quotedPhrases(check.reason) : [];
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
  const seed = a.seed
    ? `<div class="rounded-lg border border-line bg-card px-5 py-3.5 text-sm"><div class="text-xs font-medium text-ink-3">This attack's seed</div>
        <div class="mt-1.5 grid gap-1 text-ink-2 sm:grid-cols-[90px_1fr]"><span class="text-ink-3">Question</span><span>“${esc(a.seed.question)}”</span><span class="text-ink-3">Persona</span><span>${esc(a.seed.persona)}</span><span class="text-ink-3">Tactic</span><span>${esc(a.seed.tactic)}: ${esc(a.seed.tactic_hint)}</span></div></div>`
    : "";
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
    ${seed}
  </div>

  <h3 class="mt-8 text-xs font-medium tracking-wide text-ink-3 uppercase">Conversation</h3>
  <div class="mt-3 space-y-4">
    ${a.turns
      .map(
        (turn, k) => `
      <div class="flex gap-3">
        <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-sunk text-ink-2" title="Giskard's attacker">${icon("user", 14)}</span>
        <div class="min-w-0 flex-1"><div class="text-xs text-ink-3">Attacker, posing as the user · turn ${k + 1}</div>
          <div class="mt-1 rounded-lg rounded-tl-sm bg-sunk px-4 py-3 text-[15px] leading-relaxed break-words text-ink">${esc(turn.user)}</div></div>
      </div>
      <div class="flex gap-3">
        <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ink text-paper" title="${esc(agentName)}">${icon("bot", 14)}</span>
        <div class="min-w-0 flex-1"><div class="text-xs text-ink-3">${esc(agentName)}${turn.ms ? ` · ${seconds(turn.ms)}` : ""}</div>
          <div class="reply mt-1 overflow-x-auto rounded-lg rounded-tl-sm border border-line bg-card px-4 py-3 text-[15px] leading-relaxed break-words text-ink">${turn.agent == null ? typing(a, agentName) : turn.agent ? renderReply(turn.agent, phrases) : `<span class="text-ink-3">(empty reply)</span>`}</div></div>
      </div>`,
      )
      .join("")}
    ${!a.turns.length ? `<p class="text-sm text-ink-3">${done ? "No turns were recorded." : "The conversation hasn't started yet."}</p>` : ""}
  </div>
  ${a.status === "passed" || a.status === "failed" ? labelPanel(run, a) : ""}`;
}

function confirmModal(c: Catalog): string {
  const r = S.route;
  if (r.page !== "risk") return "";
  const n = c.live.attacks;
  return `<div class="fixed inset-0 z-40 grid place-items-center bg-ink/30 p-4" data-action="cancel" data-backdrop>
    <div class="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-xl" data-stop>
      <h2 class="font-serif text-2xl text-ink">Run ${n} new attacks?</h2>
      <p class="mt-2 text-sm leading-relaxed text-ink-2">Giskard will attack ${esc(agentShort(c.agents[c.risks[r.risk].agent].name))} (${VERSION_LABEL[r.version].toLowerCase()}) on <b class="font-medium text-ink">${esc(c.risks[r.risk].risk.toLowerCase())}</b> with fresh conversations.</p>
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

function setLabel(value: "pass" | "fail") {
  const r = S.route;
  const run = S.shown;
  if (r.page !== "risk" || !run) return;
  const a = run.attacks[r.attack - 1];
  const cur = readerLabel(run, r.attack);
  const ours = ourLabel(run, r.attack);
  saveReaderLabel(
    run,
    r.attack,
    cur?.label === value
      ? null
      : { label: value, judge: a.status === "passed" ? "passed" : "failed", ours: ours?.label, risk: run.risk, version: run.version, set: setOf(run), attack: r.attack },
  );
  renderLive();
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const el = target.closest<HTMLElement>("[data-action],[data-filter],[data-fix],[data-label]");
  if (!el) return;
  const run = S.shown;
  const r = S.route;
  if (el.dataset.filter) {
    S.filter = el.dataset.filter as Filter;
    return renderLive();
  }
  if (el.dataset.label) return setLabel(el.dataset.label as "pass" | "fail");
  if (el.dataset.fix && run && r.page === "risk") {
    const cur = readerLabel(run, r.attack);
    if (cur) saveReaderLabel(run, r.attack, { ...cur, fix: cur.fix === el.dataset.fix ? undefined : el.dataset.fix });
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
    case "stack": {
      S.stack = el.dataset.stack as StackId;
      const y = window.scrollY;
      render();
      window.scrollTo({ top: y }); // switching stacks never moves the page
      return;
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
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
    [S.catalog, S.study] = await Promise.all([getJSON<Catalog>("/api/catalog"), getJSON<Study>("/api/study").catch(() => null)]);
    await refreshLiveRuns();
  } catch (e) {
    $("main").innerHTML = `<div class="p-10 text-sm text-fail">Could not load the app: ${esc((e as Error).message)}</div>`;
    return;
  }
  // Links from the first version of this page: ?risk=…&version=…&attack=…
  const q = new URLSearchParams(location.search);
  if (q.get("risk") && !location.hash) {
    history.replaceState(null, "", "/");
    location.hash = `#/${q.get("risk")}/${q.get("version") ?? "naive"}/${q.get("attack") ? `review/${q.get("attack")}` : "attack"}?set=recorded`;
    return;
  }
  await onRoute();
}

void boot();
