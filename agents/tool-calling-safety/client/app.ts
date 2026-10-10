// Pick a tool and an example call, and see the naive and safe implementations
// run side by side: the exact steps, where harm happens, and where a safeguard
// refuses. All simulated in the browser; nothing runs for real.

import { TOOLS } from "../src/tools.ts";
import type { ExampleCall, Run, Step, Tool } from "../src/types.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let toolId = TOOLS[0].id;
let exampleId = TOOLS[0].examples[0].id;

const current = (): Tool => TOOLS.find((t) => t.id === toolId)!;
const currentExample = (): ExampleCall => current().examples.find((e) => e.id === exampleId) ?? current().examples[0];

// ── The tool-calling loop diagram (static, explains the round-trip) ──────────
function renderLoop() {
  const nodes = [
    { t: "1. Model", d: "writes a tool call", s: "<span class='font-mono text-teal-300'>{ name, arguments }</span>", tone: "model" },
    { t: "2. Your code", d: "validates, then runs the tool", s: "the only place anything executes", tone: "code" },
    { t: "3. Tool result", d: "goes back to the model", s: "<span class='font-mono text-teal-300'>{ result }</span>", tone: "code" },
    { t: "4. Model", d: "reads it, answers or calls again", s: "loop until done, with a call limit", tone: "model" },
  ];
  $("loop").innerHTML = `
    <div class="grid gap-3 sm:grid-cols-[repeat(4,minmax(0,1fr))]">
      ${nodes
        .map(
          (n, i) => `
        <div class="relative rounded-xl border px-3 py-2.5 text-[13px] ${
          n.tone === "model"
            ? "border-teal-200 bg-teal-50/60 dark:border-teal-900/60 dark:bg-teal-950/30"
            : "border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50"
        }">
          <div class="font-semibold">${n.t}</div>
          <div class="text-zinc-600 dark:text-zinc-400">${n.d}</div>
          <div class="mt-1 text-[12px] text-zinc-500">${n.s}</div>
          ${i < nodes.length - 1 ? `<span class="absolute top-1/2 -right-2.5 z-10 hidden -translate-y-1/2 text-zinc-400 sm:block">→</span>` : ""}
        </div>`,
        )
        .join("")}
    </div>
    <p class="mt-3 text-[13px] text-zinc-500">Step 2 is the whole ballgame. The model’s <b>arguments</b> are untrusted — this app shows what step 2 does with a malicious one, naively and safely.</p>`;
}

// ── Tool rail ────────────────────────────────────────────────────────────────
function renderTools() {
  $("tools").innerHTML = TOOLS.map(
    (t) => `
    <button role="tab" type="button" class="tool" data-id="${t.id}" aria-selected="${t.id === toolId}">
      <span class="mt-0.5 font-mono text-[11px] font-semibold text-zinc-400">${esc(t.kind)}</span>
      <span class="min-w-0">
        <span class="block font-mono text-[13px] font-semibold">${esc(t.definition.name)}</span>
      </span>
    </button>`,
  ).join("");
  for (const b of $("tools").querySelectorAll<HTMLElement>("[data-id]")) {
    b.onclick = () => {
      toolId = b.dataset.id!;
      exampleId = current().examples[0].id;
      renderAll();
    };
  }
}

function stepHtml(s: Step): string {
  const icon: Record<Step["kind"], string> = { info: "·", ok: "✓", bad: "✗", stop: "⛔", ask: "⏸" };
  return `<div class="step step-${s.kind}">
    <span class="mt-px shrink-0 font-bold">${icon[s.kind]}</span>
    <span class="min-w-0">
      <span class="font-medium">${esc(s.label)}</span>
      ${s.detail ? `<span class="mt-0.5 block text-zinc-600 dark:text-zinc-400">${esc(s.detail)}</span>` : ""}
      ${s.code ? `<code>${esc(s.code)}</code>` : ""}
    </span>
  </div>`;
}

function outcomeBadge(run: Run): string {
  const map = {
    done: ["bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", "Completed"],
    harm: ["bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300", "Harm done"],
    blocked: ["bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300", "Refused"],
    ask: ["bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300", "Waiting for a person"],
  } as const;
  const [cls, label] = map[run.outcome];
  return `<span class="pill ${cls}">${label}</span>`;
}

function verdictClass(run: Run): string {
  if (run.outcome === "harm") return "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200";
  if (run.outcome === "blocked") return "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
  return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300";
}

// ── Detail panel ─────────────────────────────────────────────────────────────
function renderDetail() {
  const t = current();
  $("kind").textContent = t.kind;
  $("risk").textContent = t.risk.name;
  ($("risk") as HTMLElement).onclick = () => window.open(t.risk.url, "_blank");
  $("risk").classList.add("cursor-pointer");
  $("headline").textContent = t.headline;
  $("lede").textContent = t.lede;
  $("def").textContent = JSON.stringify(t.definition, null, 2);
  $("permission").textContent = t.permission;
  $("fixes").innerHTML = t.fixes
    .map((f) => `<li class="flex gap-2"><span class="mt-px text-teal-600">→</span><span>${esc(f)}</span></li>`)
    .join("");

  if (t.incident) {
    $("incident").classList.remove("hidden");
    $("incident").innerHTML = `
      <h3 class="mb-1.5 flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5 1 14h14z"/><path d="M8 6v4M8 12h.01"/></svg>
        This happened in the wild
      </h3>
      <p class="text-[13.5px] leading-relaxed text-amber-900/90 dark:text-amber-200/90">${esc(t.incident.text)}
        <a class="underline underline-offset-2" href="${t.incident.url}">Details →</a></p>`;
  } else {
    $("incident").classList.add("hidden");
  }

  // Examples.
  $("examples").innerHTML = t.examples
    .map(
      (e) => `<button role="tab" type="button" class="ex" data-ex="${e.id}" aria-selected="${e.id === exampleId}">
        ${e.benign ? "" : "<span class='mr-1'>⚠</span>"}${esc(e.label)}</button>`,
    )
    .join("");
  for (const b of $("examples").querySelectorAll<HTMLElement>("[data-ex]")) {
    b.onclick = () => {
      exampleId = b.dataset.ex!;
      renderCall();
    };
  }
  renderCall();
}

// ── The selected call: run both implementations ─────────────────────────────
function renderCall() {
  const t = current();
  const ex = currentExample();
  $("exsource").innerHTML = `<b class="text-zinc-700 dark:text-zinc-300">Where the argument came from:</b> ${esc(ex.source)} <span class="mx-1 text-zinc-300 dark:text-zinc-600">·</span> ${esc(ex.lesson)}`;

  $("naive-code").textContent = t.naiveCode;
  $("safe-code").textContent = t.safeCode;

  const naive = t.naive(ex.args);
  const safe = t.safe(ex.args);

  $("naive-badge").innerHTML = outcomeBadge(naive);
  $("safe-badge").innerHTML = outcomeBadge(safe);
  $("naive-steps").innerHTML = naive.steps.map(stepHtml).join("");
  $("safe-steps").innerHTML = safe.steps.map(stepHtml).join("");

  const nv = $("naive-verdict");
  nv.className = `mx-4 mb-4 rounded-lg px-3 py-2 text-[13px] leading-snug ${verdictClass(naive)}`;
  nv.textContent = naive.verdict;
  const sv = $("safe-verdict");
  sv.className = `mx-4 mb-4 rounded-lg px-3 py-2 text-[13px] leading-snug ${verdictClass(safe)}`;
  sv.textContent = safe.verdict;
}

function renderAll() {
  renderTools();
  renderDetail();
  // Keep the deep-link in sync.
  const url = new URL(location.href);
  url.searchParams.set("tool", toolId);
  url.searchParams.set("call", exampleId);
  history.replaceState(null, "", url);
}

// Theme toggle.
$("theme").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("tcs-theme", next);
  } catch {
    // Ignore private-mode storage errors.
  }
};

// Deep link on load.
const params = new URLSearchParams(location.search);
if (params.get("tool") && TOOLS.some((t) => t.id === params.get("tool"))) {
  toolId = params.get("tool")!;
  const call = params.get("call");
  if (call && current().examples.some((e) => e.id === call)) exampleId = call;
  else exampleId = current().examples[0].id;
}

renderLoop();
renderAll();
