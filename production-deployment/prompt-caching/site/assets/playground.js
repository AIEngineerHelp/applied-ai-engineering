import { analyze, optimize, BLOCK_KINDS, CHANGE_LABELS, matchKey } from "../engine/analyzer.js";
import { detect } from "../engine/detectors.js";
import { estimateCost } from "../engine/cost.js";
import { MODELS, PROVIDERS, getModel } from "../engine/providers.js";
import { PRESETS } from "../engine/presets.js";

const STORE_KEY = "pcp-state-v2";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
// Round down, so "100%" only appears when all of it is reused.
const pct = (x) => `${Math.floor(x * 100)}%`;
const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (s, n = 60) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const ICONS = {
  tools: '<path d="M10.5 2.5a3 3 0 0 0-2.9 3.8L2.5 11.4V13.5h2.1l5.1-5.1a3 3 0 0 0 3.8-2.9l-1.7 1.7-1.6-.4-.4-1.6z"/>',
  system: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/>',
  examples: '<path d="M3 4h10M3 8h10M3 12h6"/>',
  documents: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 9h4M6 11.5h4"/>',
  history: '<path d="M3 4h7v5H6l-3 2.5z"/><path d="M10 6.5h3v5l-2.2-1.6H7.5"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.6-2.4 2.3-3.5 4.5-3.5s3.9 1.1 4.5 3.5"/>',
};
const icon = (kind) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] ?? ICONS.documents}</svg>`;

// One line per example, for the example cards.
const TEASERS = {
  timestamp: "The current time on line 1",
  personalized: "The customer's name in the system prompt",
  "question-first": "Retrieval: question before the documents",
  "agent-state": "A request ID and turn counter",
  "dynamic-tools": "A different tool list per user",
  optimized: "Stable first, changing parts last",
};

// Why a detected value ends the cache, in a few words.
const BECAUSE = {
  timestamp: "This time changes on every request",
  date: "Today's date changes every day",
  identifier: "This ID is unique to each request",
  sessionId: "This ID is different for each conversation",
  personal: "This is different for each user",
  counter: "This number changes on every request",
  template: "This slot gets a new value on each request",
};

const IMPACT = { high: "Big impact", medium: "Medium impact", low: "Small impact", info: "Note" };

const BLANK = {
  id: "blank",
  blocks: [
    { id: "system", kind: "system", text: "", change: "auto" },
    { id: "user", kind: "user", text: "", change: "auto" },
  ],
};
const PLACEHOLDERS = {
  tools: "Paste your tool or function definitions (JSON) here.",
  system: "Paste your system prompt or instructions here.",
  examples: "Paste example conversations here.",
  documents: "Paste documents or context here.",
  history: "Paste earlier messages of the conversation here.",
  user: "Paste the user's message here.",
};

// ---------- State ----------

function freshBlocks(preset) {
  return structuredClone(preset.blocks).map((b) => ({ change: "auto", ...b }));
}

function load() {
  const params = new URLSearchParams(location.search);
  const fromUrl = PRESETS.find((p) => p.id === params.get("preset"));
  if (!fromUrl) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
      if (saved?.blocks?.length) return saved;
    } catch {
      // Storage unavailable: start from the first example.
    }
  }
  const preset = fromUrl ?? PRESETS[0];
  return { presetId: preset.id, blocks: freshBlocks(preset), modelId: "claude-sonnet-5-5", rph: 600, turns: 5, dismissed: [] };
}

let state = load();
let undoState = null;
let nextId = 1;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or blocked storage: works, but won't be remembered.
  }
}

const uid = (kind) => `${kind}-${Date.now().toString(36)}-${nextId++}`;
const labelOf = (b) => b.label || BLOCK_KINDS[b.kind]?.label || b.kind;
const effectiveChange = (b) => (b.change && b.change !== "auto" ? b.change : BLOCK_KINDS[b.kind]?.defaultChange ?? "static");

function markCustom() {
  if (state.presetId && state.presetId !== "blank") {
    state.presetId = null;
    history.replaceState(null, "", location.pathname);
  }
}

// ---------- Examples ----------

function renderPresets() {
  $("presets").innerHTML = PRESETS.map((p) => {
    const good = p.id === "optimized";
    return `<button type="button" class="example" role="listitem" data-id="${p.id}" aria-pressed="${p.id === state.presetId}">
      <span class="badge ${good ? "good" : "bad"}">${good ? "Good layout" : "Breaks the cache"}</span>
      <span class="ex-title">${esc(p.title)}</span>
      <span class="ex-sub">${esc(TEASERS[p.id] ?? p.summary)}</span>
    </button>`;
  }).join("");
}

$("presets").addEventListener("click", (e) => {
  const btn = e.target.closest(".example");
  if (!btn) return;
  const preset = PRESETS.find((p) => p.id === btn.dataset.id);
  state = { ...state, presetId: preset.id, blocks: freshBlocks(preset), dismissed: [] };
  history.replaceState(null, "", `?preset=${preset.id}`);
  renderAll();
});

$("blank").addEventListener("click", () => {
  snapshot("Started an empty prompt.");
  state = { ...state, presetId: "blank", blocks: freshBlocks(BLANK), dismissed: [] };
  history.replaceState(null, "", location.pathname);
  renderAll();
  document.querySelector("#blocks textarea")?.focus();
});

$("add-buttons").innerHTML = Object.entries(BLOCK_KINDS)
  .map(([kind, k]) => `<button type="button" class="btn" data-kind="${kind}">${icon(kind)}${esc(k.label)}</button>`)
  .join("");
$("add-buttons").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-kind]");
  if (!btn) return;
  const kind = btn.dataset.kind;
  const block = { id: uid(kind), kind, text: "", change: "auto" };
  // Tools go first, the user's message stays last, everything else goes before it.
  const lastUser = state.blocks.findLastIndex((b) => b.kind === "user");
  if (kind === "tools") state.blocks.unshift(block);
  else if (kind !== "user" && lastUser >= 0) state.blocks.splice(lastUser, 0, block);
  else state.blocks.push(block);
  markCustom();
  renderAll();
  document.querySelector(`[data-block="${block.id}"] textarea`)?.focus();
});

// ---------- Blocks ----------

function renderBlocks() {
  const n = state.blocks.length;
  $("blocks").innerHTML = state.blocks
    .map((b, i) => {
      const change = effectiveChange(b);
      const options = Object.entries(CHANGE_LABELS)
        .map(([v, label]) => `<option value="${v}" ${v === change ? "selected" : ""}>${label}</option>`)
        .join("");
      return `${i ? '<div class="connector" aria-hidden="true"></div>' : ""}<article class="block" data-block="${b.id}">
        <div class="block-head">
          <span class="block-name">${icon(b.kind)}<input aria-label="Part name" size="${Math.max(8, labelOf(b).length + 1)}" value="${esc(labelOf(b))}"></span>
          <label class="change">Changes? <select aria-label="How often ${esc(labelOf(b))} changes">${options}</select></label>
          <span class="block-actions">
            <button type="button" data-act="up" aria-label="Move up" title="Move up" ${i === 0 ? "disabled" : ""}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg></button>
            <button type="button" data-act="down" aria-label="Move down" title="Move down" ${i === n - 1 ? "disabled" : ""}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg></button>
            <button type="button" data-act="delete" aria-label="Remove" title="Remove"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/></svg></button>
          </span>
        </div>
        <div class="code"><div class="hl" aria-hidden="true"></div><textarea spellcheck="false" aria-label="${esc(labelOf(b))} text" placeholder="${esc(PLACEHOLDERS[b.kind] ?? "Paste text here.")}">${esc(b.text)}</textarea></div>
        <div class="block-foot"></div>
      </article>`;
    })
    .join("");
}

const blockById = (id) => state.blocks.find((b) => b.id === id);

$("blocks").addEventListener("input", (e) => {
  const el = e.target.closest("[data-block]");
  if (!el) return;
  const block = blockById(el.dataset.block);
  if (e.target.tagName === "TEXTAREA") block.text = e.target.value;
  if (e.target.tagName === "INPUT") block.label = e.target.value;
  markCustom();
  scheduleUpdate();
});

$("blocks").addEventListener("change", (e) => {
  if (e.target.tagName !== "SELECT") return;
  const el = e.target.closest("[data-block]");
  blockById(el.dataset.block).change = e.target.value;
  markCustom();
  update();
});

$("blocks").addEventListener(
  "scroll",
  (e) => {
    if (e.target.tagName === "TEXTAREA") e.target.previousElementSibling.scrollTop = e.target.scrollTop;
  },
  true,
);

$("blocks").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  const el = e.target.closest("[data-block]");
  const i = state.blocks.findIndex((b) => b.id === el.dataset.block);
  if (act === "delete") {
    snapshot(`Removed ${labelOf(state.blocks[i])}.`);
    state.blocks.splice(i, 1);
  } else {
    const j = act === "up" ? i - 1 : i + 1;
    [state.blocks[i], state.blocks[j]] = [state.blocks[j], state.blocks[i]];
  }
  markCustom();
  renderAll();
});

// ---------- Analysis ----------

let timer = null;
function scheduleUpdate() {
  clearTimeout(timer);
  timer = setTimeout(update, 120);
}

const currentModel = () => getModel(state.modelId);
const run = (blocks = state.blocks) => analyze(blocks, { minTokens: currentModel().minTokens, dismissed: state.dismissed });

// Character position (block id + offset) where a prefix ends.
function breakPoint(brk) {
  if (!brk) return null;
  return { blockId: brk.blockId, at: brk.reason === "match" ? brk.match.start : 0 };
}

// Per block: [start, end, status] character ranges, status = shared | session | paid.
function statusRanges(a) {
  const cuts = [
    [breakPoint(a.sharedBreak), "session"],
    [breakPoint(a.sessionBreak), "paid"],
  ];
  let status = "shared";
  const out = new Map();
  for (const b of a.blocks) {
    const ranges = [];
    let from = 0;
    for (const [cut, next] of cuts) {
      if (cut?.blockId !== b.id) continue;
      if (cut.at > from) ranges.push([from, cut.at, status]);
      from = Math.max(from, cut.at);
      status = next;
    }
    if (b.text.length > from || !ranges.length) ranges.push([from, b.text.length, status]);
    out.set(b.id, ranges);
  }
  return out;
}

function highlight(b, ranges, brkAt) {
  const dismissed = new Set(state.dismissed);
  const marks = detect(b.text).filter((m) => m.scope !== "static" && !dismissed.has(matchKey(b.id, m)));
  const points = new Set([0, b.text.length, ...ranges.flatMap(([s, e]) => [s, e]), ...marks.flatMap((m) => [m.start, m.end])]);
  if (brkAt !== null) points.add(brkAt);
  const sorted = [...points].sort((x, y) => x - y);
  let html = "";
  for (let i = 0; i < sorted.length - 1; i++) {
    const [s, e] = [sorted[i], sorted[i + 1]];
    if (e <= s) continue;
    const st = ranges.find(([rs, re]) => s >= rs && s < re)?.[2] ?? "paid";
    const m = marks.find((x) => s >= x.start && s < x.end);
    const cls = [`st-${st}`];
    if (m) cls.push("v", m.scope === "session" ? "user" : m.scope);
    if (s === brkAt) cls.push("brk");
    html += `<span class="${cls.join(" ")}">${esc(b.text.slice(s, e))}</span>`;
  }
  // A trailing newline needs a character after it to keep the layers aligned.
  return `${html}\n`;
}

const lineOf = (text, at) => text.slice(0, at).split("\n").length;

function footFor(b, ranges, a) {
  if (!b.text.trim()) return `<span class="muted">Empty. Paste some text above.</span>`;
  const statuses = ranges.filter(([s, e]) => e > s).map((r) => r[2]);
  const first = statuses[0];
  const brk = [a.sharedBreak, a.sessionBreak].find((x) => x?.blockId === b.id);
  const reason = (x) => {
    if (!x) return "";
    if (x.reason === "match") {
      return ` <code>${esc(short(x.match.text, 40))}</code> on line ${lineOf(b.text, x.match.start)}: ${(BECAUSE[x.match.rule] ?? "this changes between requests").toLowerCase()}.`;
    }
    return x.scope === "request" ? " This part is different on every request." : " This part is different for each user.";
  };
  if (statuses.length === 1 && !brk) {
    if (first === "shared") return `<span class="ico ok">✓</span><span><b>Reused for everyone.</b> Identical on every request.</span>`;
    if (first === "session") return `<span class="ico mid">✓</span><span><b>Reused within one user's conversation.</b> Something above is different for each user.</span>`;
    return `<span class="ico bad">✕</span><span><b>Paid in full every time.</b> Something above it changes on every request, so the cache already stopped.</span>`;
  }
  if (statuses.length === 1 && brk) {
    const own = effectiveChange(b);
    if (first === "paid" && own === "request") return `<span class="ico mid">i</span><span><b>Paid every time, as expected.</b> This part is new on every request, and it comes after everything that stays the same.</span>`;
    if (first === "session" && own === "session") return `<span class="ico mid">✓</span><span><b>Reused within one user's conversation, as expected.</b> It's different for each user, and it comes after the shared parts.</span>`;
    return `<span class="ico ${first === "paid" ? "bad" : "mid"}">✕</span><span><b>Cache stops at the start of this part.</b>${reason(brk)}</span>`;
  }
  return `<span class="ico bad">✕</span><span><b>Cache stops here.</b>${reason(brk)} Everything after it is paid again.</span>`;
}

function update() {
  const a = run();
  const ranges = statusRanges(a);
  const brkFor = (id) => {
    const p = breakPoint(a.sharedBreak);
    if (p?.blockId === id) return p.at;
    const q = breakPoint(a.sessionBreak);
    return q?.blockId === id ? q.at : null;
  };
  for (const b of a.blocks) {
    const el = document.querySelector(`[data-block="${b.id}"]`);
    if (!el) continue;
    const r = ranges.get(b.id);
    el.querySelector(".hl").innerHTML = highlight(b, r, brkFor(b.id));
    el.querySelector(".block-foot").innerHTML = footFor(b, r, a);
    el.querySelector("select").value = effectiveChange(b);
  }
  renderVerdict(a);
  renderFixes(a);
  renderCompare(a);
  renderCost(a, currentModel());
  save();
}

// ---------- Verdict ----------

function renderVerdict(a) {
  const total = a.totalTokens;
  const shared = total ? a.sharedPrefixTokens / total : 0;
  const session = total ? Math.max(a.sharedPrefixTokens, a.sessionPrefixTokens) / total : 0;
  const big = $("big");
  big.textContent = total ? pct(shared) : "–";
  big.className = `big ${shared >= 0.8 ? "good" : shared >= 0.5 ? "mid" : "bad"}`;
  $("verdict-text").textContent = total
    ? `reused for every user${session - shared > 0.05 ? `, ${pct(session)} within one user's conversation` : ""}`
    : "";
  $("meter").innerHTML = total
    ? `<span class="shared" style="flex-grow:${a.sharedPrefixTokens}"></span><span class="session" style="flex-grow:${Math.max(0, a.sessionPrefixTokens - a.sharedPrefixTokens)}"></span><span class="paid" style="flex-grow:${total - Math.max(a.sharedPrefixTokens, a.sessionPrefixTokens)}"></span>`
    : "";

  if (!total) {
    $("why").innerHTML = "Pick an example above, or paste your prompt into the parts of step 2.";
    return;
  }
  const brk = a.sharedBreak;
  const b = brk && a.blocks.find((x) => x.id === brk.blockId);
  const serious = a.findings.some((f) => f.severity === "high" || f.severity === "medium");
  const after = total - (brk?.token ?? total);
  const who = brk?.scope === "request" ? "on every request" : "for every new user";
  let html;
  if (!brk) {
    html = "Nothing in this prompt changes between requests, so all of it can be reused.";
  } else if (!serious) {
    html = `The cache stops at the <b>${esc(b.label)}</b>, which ${brk.scope === "request" ? "is new on every request" : "is different for each user"}. That's expected: only the parts that really change are paid in full.`;
  } else if (brk.reason === "match") {
    html = `The cache stops at <code>${esc(short(brk.match.text, 48))}</code> on line ${lineOf(b.text, brk.match.start)} of the <b>${esc(b.label)}</b>. ${BECAUSE[brk.match.rule] ?? "This changes between requests"}, so the <b>${fmt(after)} tokens</b> after it are paid in full ${who}.`;
  } else {
    const stableAfter = a.blocks.filter((x) => x.startToken > brk.token && effectiveChange(x) === "static").map((x) => x.label);
    html = `The cache stops at the start of the <b>${esc(b.label)}</b>, because it is ${brk.scope === "request" ? "different on every request" : "different for each user"}. The <b>${fmt(after)} tokens</b> after it are paid in full ${who}${stableAfter.length ? `, including the ${esc(stableAfter.join(" and "))}, which ${stableAfter.length > 1 ? "never change" : "never changes"}` : ""}.`;
  }
  const model = currentModel();
  const reusable = Math.max(a.sharedPrefixTokens, a.sessionPrefixTokens);
  if (reusable > 0 && reusable < model.minTokens) {
    html += `<span class="warnline">${esc(model.label)} only caches prompts that start with at least ${fmt(model.minTokens)} identical tokens. This one reuses ≈${fmt(reusable)}, so in practice nothing is cached.</span>`;
  }
  $("why").innerHTML = html;
}

// ---------- Fixes ----------

function renderFixes(a) {
  const list = $("findings");
  const proposal = optimize(state.blocks, { dismissed: state.dismissed });
  const fixBtn = $("fix");
  fixBtn.disabled = !proposal.changes.length;
  if (!a.findings.length) {
    list.innerHTML = `<li class="empty"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg><span><b>Nothing to fix.</b> The parts that stay the same come first, and nothing in them changes between requests.</span></li>`;
  } else {
    list.innerHTML = a.findings
      .map((f) => {
        const affected = f.lostTokens ? ` · affects ≈${fmt(f.lostTokens)} tokens` : "";
        const range = f.ranges ? f.ranges[0].join(",") : "";
        return `<li class="fix">
          <div class="fix-top"><span class="fix-n ${f.severity}" aria-hidden="true"></span><div><span class="fix-title">${esc(f.title)}</span><span class="impact">${IMPACT[f.severity]}${affected}</span></div></div>
          <p class="todo"><b>Do this:</b> ${esc(f.fix)}</p>
          <div class="fix-actions">
            ${f.blockId ? `<button type="button" data-show="${esc(f.blockId)}" data-range="${range}">Show me</button>` : ""}
            ${f.dismissible ? `<button type="button" data-dismiss="${esc(f.id)}" title="Use this when the value is really fixed, such as a policy date">It never changes</button>` : ""}
          </div>
        </li>`;
      })
      .join("");
  }
  const manual = a.findings.some((f) => f.rule === "tools-dynamic" || f.rule === "below-minimum");
  list.insertAdjacentHTML(
    "beforeend",
    !proposal.changes.length && a.findings.length
      ? `<li class="manual">“Apply all fixes” has nothing left to move. ${manual ? "The remaining items need a change in your code or a longer prompt." : ""}</li>`
      : "",
  );
  const restore = $("restore");
  restore.hidden = !state.dismissed.length;
  restore.innerHTML = `${state.dismissed.length} marked as never changing. <button type="button" id="restore-btn">Undo that</button>`;
}

$("findings").addEventListener("click", (e) => {
  const dismiss = e.target.closest("[data-dismiss]");
  if (dismiss) {
    state.dismissed = [...new Set([...state.dismissed, dismiss.dataset.dismiss])];
    update();
    return;
  }
  const show = e.target.closest("[data-show]");
  if (show) reveal(show.dataset.show, show.dataset.range);
});

$("restore").addEventListener("click", (e) => {
  if (e.target.id !== "restore-btn") return;
  state.dismissed = [];
  update();
});

$("fix").addEventListener("click", () => {
  const before = run();
  const proposal = optimize(state.blocks, { dismissed: state.dismissed });
  if (!proposal.changes.length) return;
  const share = (x) => (x.totalTokens ? x.sharedPrefixTokens / x.totalTokens : 0);
  const prev = structuredClone(state);
  state.blocks = proposal.blocks.map((b) => ({ ...b }));
  markCustom();
  renderAll();
  const after = run();
  snapshot(`Reused for every user: ${pct(share(before))} → ${pct(share(after))}.`, prev);
  // Bring the result into view on small screens.
  if (matchMedia("(max-width: 900px)").matches) $("verdict").scrollIntoView({ behavior: "smooth", block: "start" });
});

function reveal(blockId, range) {
  const el = document.querySelector(`[data-block="${blockId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1400);
  if (range) {
    const [start, end] = range.split(",").map(Number);
    const ta = el.querySelector("textarea");
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
    ta.scrollTop = Math.max(0, (lineOf(ta.value, start) - 3) * 20);
    el.querySelector(".hl").scrollTop = ta.scrollTop;
  }
}

// ---------- Request 1 vs request 2 ----------

const OTHER = [["Alex Rivera", "Jordan Lee"], ["alex.rivera@example.com", "jordan.lee@example.com"]];

function nextValue(m) {
  const t = m.text;
  if (m.rule === "timestamp") {
    const d = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (d) {
      const sec = d[3] !== undefined ? String((Number(d[3]) + 7) % 60).padStart(2, "0") : null;
      const min = sec === null ? String((Number(d[2]) + 1) % 60).padStart(2, "0") : d[2];
      return t.replace(d[0], `${d[1]}:${min}${sec !== null ? `:${sec}` : ""}`);
    }
    return t.replace(/\d(?=\D*$)/, (x) => String((Number(x) + 3) % 10));
  }
  if (m.rule === "date") return t.replace(/\d+/, (x) => String(Number(x) + 1).padStart(x.length, "0"));
  if (m.rule === "identifier" || m.rule === "sessionId") {
    return t.replace(/[0-9a-f]{4,}/gi, (x) => [...x].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""));
  }
  if (m.rule === "counter") return t.replace(/\d[\d,]*/, (x) => fmt(Number(x.replace(/,/g, "")) + 1));
  if (m.rule === "personal") {
    let out = t;
    for (const [x, y] of OTHER) out = out.replace(x, y);
    return out === t ? t.replace(/[A-Z][a-z]+/, "Jordan") : out;
  }
  if (m.rule === "template") return `(new value of ${m.variable})`;
  return "(different)";
}

function renderCompare(a) {
  const brk = a.sharedBreak;
  if (!brk || !a.totalTokens) {
    $("next-caption").textContent = "Every request sends exactly the same prompt, so the provider can reuse all of it.";
    $("next-lines").innerHTML = "";
    return;
  }
  const b = a.blocks.find((x) => x.id === brk.blockId);
  const second = brk.scope === "request" ? "Request 2" : "Next user";
  const oneLine = (t) => t.replace(/\s*\n\s*/g, " ↵ ");
  if (brk.reason === "match") {
    const m = brk.match;
    const before = oneLine(b.text.slice(Math.max(0, m.start - 50), m.start).replace(/^\S*\s/, ""));
    const after = oneLine(b.text.slice(m.end, m.end + 40));
    const line = (label, value) =>
      `<div class="next-line"><span class="n">${label}</span><code>…<span class="same">${esc(before)}</span><span class="diff">${esc(value)}</span><span class="rest">${esc(after)}…</span></code></div>`;
    $("next-caption").innerHTML = `The provider compares each new request with the ones it has seen, character by character from the start. The two requests below are identical up to the <span class="key shared">green</span> part, then differ at the <span class="key paid">red</span> part. Only the identical start can be reused.`;
    $("next-lines").innerHTML = line("Request 1", m.text) + line(second, nextValue(m));
  } else {
    const first = oneLine(b.text.split("\n").find((l) => l.trim()) ?? "");
    $("next-caption").innerHTML = `Both requests are identical until the <b>${esc(b.label)}</b>, which ${brk.scope === "request" ? "is different on every request" : "is different for each user"}. Only the identical start can be reused.`;
    $("next-lines").innerHTML = `<div class="next-line"><span class="n">Request 1</span><code><span class="diff">${esc(short(first, 80))}</span></code></div><div class="next-line"><span class="n">${second}</span><code><span class="diff">(a different ${esc(b.label.toLowerCase())})</span></code></div>`;
  }
}

// ---------- Cost ----------

function renderModelSelect() {
  $("model").innerHTML = Object.entries(PROVIDERS)
    .map(
      ([pid, p]) =>
        `<optgroup label="${esc(p.name)}">${MODELS.filter((m) => m.provider === pid)
          .map((m) => `<option value="${m.id}" ${m.id === state.modelId ? "selected" : ""}>${esc(m.label)}</option>`)
          .join("")}</optgroup>`,
    )
    .join("");
  $("rph").value = state.rph;
  $("turns").value = state.turns;
}

function renderCost(a, model) {
  const c = estimateCost(a, model, { requestsPerHour: state.rph, turnsPerConversation: state.turns });
  $("c-none").textContent = money(c.noCache);
  $("c-with").textContent = money(c.withCache);
  const p = Math.round(c.savedPct);
  const line = $("c-save");
  line.className = `save-line ${p > 0 ? "good" : p < 0 ? "worse" : "none"}`;
  line.textContent =
    p > 0 ? `Caching saves ${p}% of the input cost.` : p < 0 ? `Caching costs ${-p}% more here: cache writes are never read back.` : "No saving: nothing in this prompt is cached.";
  const prov = PROVIDERS[model.provider];
  const notes = [
    prov.how,
    `Prices per million input tokens: $${model.input} normal, $${model.read} from cache${model.write > model.input ? `, $${model.write} to write to the cache` : ""}. Caches only prompts of at least ${fmt(model.minTokens)} tokens. Cache lifetime: ${model.ttlNote}.`,
  ];
  if (!c.warm) notes.push(`At ${fmt(state.rph)} requests per hour, requests are ${c.gapMinutes.toFixed(0)} minutes apart, longer than the cache lasts.`);
  if (model.provider === "gemini") notes.push("Gemini's automatic caching is best effort: this assumes it hits, which it didn't in our live test.");
  if (model.priceNote) notes.push(model.priceNote);
  $("cost-note").innerHTML = `${notes.map(esc).join(" ")} <a href="${prov.pricing}" target="_blank" rel="noopener">Pricing</a> · <a href="${prov.docs}" target="_blank" rel="noopener">Docs</a>`;
}

$("model").addEventListener("change", (e) => {
  state.modelId = e.target.value;
  update();
});
for (const id of ["rph", "turns"]) {
  $(id).addEventListener("input", (e) => {
    const v = Number.parseInt(e.target.value, 10);
    if (Number.isFinite(v) && v > 0) {
      state[id] = v;
      update();
    }
  });
}

// ---------- Undo toast ----------

let toastTimer = null;
function snapshot(message, prev = structuredClone(state)) {
  undoState = prev;
  const t = $("toast");
  t.innerHTML = `<span>${esc(message)}</span><button type="button" id="undo">Undo</button>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 7000);
}
$("toast").addEventListener("click", (e) => {
  if (e.target.id !== "undo" || !undoState) return;
  state = undoState;
  undoState = null;
  $("toast").hidden = true;
  renderAll();
});

// ---------- Theme ----------

$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("pcp-theme", root.dataset.theme);
  } catch {
    // Not remembered; fine.
  }
});

function renderAll() {
  renderPresets();
  renderBlocks();
  renderModelSelect();
  update();
}

renderAll();
