import { analyze, optimize, BLOCK_KINDS, CHANGE_LABELS, matchKey } from "../engine/analyzer.js";
import { detect } from "../engine/detectors.js";
import { estimateCost } from "../engine/cost.js";
import { MODELS, PROVIDERS, getModel } from "../engine/providers.js";
import { PRESETS } from "../engine/presets.js";

const STORE_KEY = "pcp-state-v1";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

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
      // Storage unavailable: start from the first preset.
    }
  }
  const preset = fromUrl ?? PRESETS[0];
  return { presetId: preset.id, blocks: freshBlocks(preset), modelId: "claude-sonnet-5-5", rph: 600, turns: 5, dismissed: [] };
}

let state = load();
let undoStack = null;
let nextId = 1;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or blocked storage: the playground still works, it just won't remember.
  }
}

function uid(kind) {
  return `${kind}-${Date.now().toString(36)}-${nextId++}`;
}

// ---------- Presets and add buttons ----------

function renderPresets() {
  $("presets").innerHTML = PRESETS.map(
    (p) =>
      `<button type="button" class="preset" role="listitem" data-id="${p.id}" aria-pressed="${p.id === state.presetId}">
        <span class="dot ${p.id === "optimized" ? "swatch-shared" : "swatch-uncached"}"></span>${esc(p.title)}</button>`,
  ).join("");
  const p = PRESETS.find((x) => x.id === state.presetId);
  $("preset-summary").textContent = p ? p.summary : "Your own prompt.";
}

$("presets").addEventListener("click", (e) => {
  const btn = e.target.closest(".preset");
  if (!btn) return;
  const preset = PRESETS.find((p) => p.id === btn.dataset.id);
  state = { ...state, presetId: preset.id, blocks: freshBlocks(preset), dismissed: [] };
  history.replaceState(null, "", `?preset=${preset.id}`);
  renderAll();
});

$("add-buttons").innerHTML = Object.entries(BLOCK_KINDS)
  .map(([kind, k]) => `<button type="button" class="btn" data-kind="${kind}">${icon(kind)}${esc(k.label)}</button>`)
  .join("");
$("add-buttons").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-kind]");
  if (!btn) return;
  const kind = btn.dataset.kind;
  const block = { id: uid(kind), kind, text: "", change: "auto" };
  // New blocks go before the user's message, which usually stays last.
  const lastUser = state.blocks.findLastIndex((b) => b.kind === "user");
  if (kind !== "user" && lastUser >= 0) state.blocks.splice(lastUser, 0, block);
  else state.blocks.push(block);
  markCustom();
  renderAll();
  document.querySelector(`[data-block="${block.id}"] textarea`)?.focus();
});

function markCustom() {
  if (state.presetId) {
    state.presetId = null;
    history.replaceState(null, "", location.pathname);
  }
}

// ---------- Blocks ----------

function effectiveChange(b) {
  return b.change && b.change !== "auto" ? b.change : BLOCK_KINDS[b.kind]?.defaultChange ?? "static";
}

function renderBlocks() {
  const root = $("blocks");
  root.innerHTML = state.blocks
    .map((b, i) => {
      const change = effectiveChange(b);
      const seg = Object.entries(CHANGE_LABELS)
        .map(([v, label]) => `<button type="button" role="radio" data-change="${v}" aria-checked="${v === change}">${label}</button>`)
        .join("");
      return `<article class="block" data-block="${b.id}">
        <div class="block-strip" aria-hidden="true"></div>
        <div class="block-head">
          <span class="block-index">${i + 1}</span>
          <span class="block-kind">${icon(b.kind)}<input aria-label="Block name" size="${Math.max(8, (b.label || BLOCK_KINDS[b.kind]?.label || b.kind).length + 1)}" value="${esc(b.label || BLOCK_KINDS[b.kind]?.label || b.kind)}"></span>
          <span class="seg" role="radiogroup" aria-label="How often this block changes">${seg}</span>
          <span class="block-tokens"></span>
          <span class="block-actions">
            <button type="button" data-act="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg></button>
            <button type="button" data-act="down" aria-label="Move down" ${i === state.blocks.length - 1 ? "disabled" : ""}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg></button>
            <button type="button" data-act="delete" aria-label="Delete block"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/></svg></button>
          </span>
        </div>
        <div class="code"><div class="hl" aria-hidden="true"></div><textarea spellcheck="false" aria-label="${esc(b.label || BLOCK_KINDS[b.kind]?.label || b.kind)} text" placeholder="Paste text here">${esc(b.text)}</textarea></div>
        <div class="block-foot"></div>
      </article>`;
    })
    .join("");
}

function blockById(id) {
  return state.blocks.find((b) => b.id === id);
}

$("blocks").addEventListener("input", (e) => {
  const el = e.target.closest("[data-block]");
  if (!el) return;
  const block = blockById(el.dataset.block);
  if (e.target.tagName === "TEXTAREA") block.text = e.target.value;
  if (e.target.tagName === "INPUT") block.label = e.target.value;
  markCustom();
  scheduleUpdate();
});

$("blocks").addEventListener("scroll", (e) => {
  if (e.target.tagName === "TEXTAREA") e.target.previousElementSibling.scrollTop = e.target.scrollTop;
}, true);

$("blocks").addEventListener("click", (e) => {
  const el = e.target.closest("[data-block]");
  if (!el) return;
  const i = state.blocks.findIndex((b) => b.id === el.dataset.block);
  const changeBtn = e.target.closest("[data-change]");
  if (changeBtn) {
    state.blocks[i].change = changeBtn.dataset.change;
    markCustom();
    el.querySelectorAll("[data-change]").forEach((b) => b.setAttribute("aria-checked", String(b === changeBtn)));
    update();
    return;
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  if (act === "delete") {
    snapshot("Block deleted.");
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

function currentModel() {
  return getModel(state.modelId);
}

function run(blocks = state.blocks) {
  return analyze(blocks, { minTokens: currentModel().minTokens, dismissed: state.dismissed });
}

// Status ranges for one block, in tokens relative to the block start.
function blockRanges(b, a) {
  const start = b.startToken;
  const end = start + b.tokens;
  const parts = [];
  const cut = (from, to, status) => {
    const s = Math.max(from, start);
    const t = Math.min(to, end);
    if (t > s) parts.push({ status, size: t - s });
  };
  cut(0, a.sharedPrefixTokens, "shared");
  cut(a.sharedPrefixTokens, Math.max(a.sharedPrefixTokens, a.sessionPrefixTokens), "session");
  cut(Math.max(a.sharedPrefixTokens, a.sessionPrefixTokens), Infinity, "uncached");
  return parts;
}

function barHtml(a, { interactive = true } = {}) {
  return a.blocks
    .map((b) => {
      const inner = blockRanges(b, a)
        .map((r) => `<span class="swatch-${r.status}" style="flex-grow:${r.size}"></span>`)
        .join("");
      const title = `${b.label}: ≈${fmt(b.tokens)} tokens`;
      return `<div class="seg-block" style="flex-grow:${Math.max(b.tokens, 1)}" title="${esc(title)}" ${interactive ? `data-goto="${b.id}"` : ""}>${inner}</div>`;
    })
    .join("");
}

function highlight(b) {
  const dismissed = new Set(state.dismissed);
  let html = "";
  let at = 0;
  for (const m of detect(b.text)) {
    if (m.scope === "static" || dismissed.has(matchKey(b.id, m))) continue;
    const scope = m.scope === "session" ? "user" : m.scope;
    html += esc(b.text.slice(at, m.start)) + `<mark class="${scope}" data-key="${matchKey(b.id, m)}">${esc(m.text)}</mark>`;
    at = m.end;
  }
  // A trailing newline needs a character after it to keep the layers aligned.
  return html + esc(b.text.slice(at)) + "\n";
}

const STATUS_TEXT = {
  shared: "Cached once, shared by every user",
  session: "Reused within one user's conversation",
  uncached: "Paid in full on every request",
};

function update() {
  const a = run();
  const model = currentModel();

  // Blocks
  for (const b of a.blocks) {
    const el = document.querySelector(`[data-block="${b.id}"]`);
    if (!el) continue;
    el.querySelector(".block-tokens").textContent = `≈${fmt(b.tokens)} tokens`;
    const ranges = blockRanges(b, a);
    el.querySelector(".block-strip").innerHTML = ranges
      .map((r) => `<span class="swatch-${r.status}" style="flex-grow:${r.size}"></span>`)
      .join("");
    el.querySelector(".hl").innerHTML = highlight(b);
    const foot = el.querySelector(".block-foot");
    if (!b.tokens) {
      foot.innerHTML = `<span class="muted">Empty</span>`;
    } else if (ranges.length === 1) {
      foot.innerHTML = `<span class="dot swatch-${ranges[0].status}"></span>${STATUS_TEXT[ranges[0].status]}`;
    } else {
      foot.innerHTML = ranges
        .map((r) => `<span class="dot swatch-${r.status}"></span>${STATUS_TEXT[r.status]} (≈${fmt(r.size)})`)
        .join('<span class="muted"> · </span>');
    }
  }

  // Summary
  const score = a.score;
  $("score").textContent = score;
  $("ring-fg").style.strokeDasharray = `${score} 100`;
  $("ring-fg").style.stroke = score >= 80 ? "var(--shared)" : score >= 50 ? "var(--warn)" : "var(--uncached)";
  $("ring").setAttribute("aria-label", `Cache score ${score} out of 100`);
  const high = a.findings.filter((f) => f.severity === "high").length;
  $("headline").textContent =
    score >= 90 ? "Cache-friendly" : score >= 60 ? "Partly cacheable" : a.totalTokens ? "Mostly uncacheable" : "Empty prompt";
  const reusable = Math.max(a.sharedPrefixTokens, a.sessionPrefixTokens);
  $("subline").textContent = a.totalTokens
    ? `≈${fmt(reusable)} of ${fmt(a.totalTokens)} tokens can come from cache.${high ? ` ${high} issue${high > 1 ? "s" : ""} to fix.` : ""}`
    : "Add some text to a block to start.";
  $("bar").innerHTML = barHtml(a);
  const minPct = a.totalTokens ? Math.min(100, (model.minTokens / a.totalTokens) * 100) : 0;
  const minEl = $("bar-min");
  minEl.hidden = minPct >= 100 || !a.totalTokens;
  minEl.style.left = `${minPct}%`;
  minEl.classList.toggle("flip", minPct > 70);
  minEl.querySelector("span").textContent = `Minimum to cache: ${fmt(model.minTokens)}`;
  $("bar-total").textContent = `≈${fmt(a.totalTokens)} tokens`;
  $("s-shared").textContent = fmt(a.sharedPrefixTokens);
  $("s-session").textContent = fmt(Math.max(0, a.sessionPrefixTokens - a.sharedPrefixTokens));
  $("s-full").textContent = fmt(a.totalTokens - Math.max(a.sharedPrefixTokens, a.sessionPrefixTokens));

  renderNext(a);
  renderFindings(a);
  renderCost(a, model);
  save();
}

// ---------- Request 1 vs request 2 ----------

const OTHER_NAMES = [["Alex Rivera", "Jordan Lee"], ["alex.rivera@example.com", "jordan.lee@example.com"]];

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
    for (const [a, b] of OTHER_NAMES) out = out.replace(a, b);
    if (out === t) out = t.replace(/[A-Z][a-z]+/, "Jordan");
    return out === t ? "(another user's details)" : out;
  }
  if (m.rule === "template") return `(next value of ${m.variable})`;
  return "(different)";
}

function renderNext(a) {
  const brk = a.sessionBreak && a.sharedBreak ? (a.sharedBreak.token <= a.sessionBreak.token ? a.sharedBreak : a.sessionBreak) : a.sharedBreak ?? a.sessionBreak;
  const card = $("next-card");
  if (!brk || !a.totalTokens) {
    $("next-caption").textContent = "Nothing in this prompt changes between requests, so the whole prompt is a reusable prefix.";
    $("next-lines").innerHTML = "";
    return;
  }
  const b = a.blocks.find((x) => x.id === brk.blockId);
  const who = brk.scope === "request" ? "the next request" : "the next user's request";
  if (brk.reason === "match") {
    const m = brk.match;
    const oneLine = (t) => t.replace(/\s*\n\s*/g, " ↵ ");
    const before = oneLine(b.text.slice(Math.max(0, m.start - 60), m.start).replace(/^\S*\s/, ""));
    const after = oneLine(b.text.slice(m.end, m.end + 30));
    const line = (n, value, cls) =>
      `<div class="next-line"><span class="n">#${n}</span><code><span class="same">…${esc(before)}</span><span class="diff ${cls}">${esc(value)}</span>${esc(after)}…</code></div>`;
    $("next-caption").innerHTML = `Both requests match up to here, ≈${fmt(brk.token)} tokens into the prompt (${esc(b.label)}). From this character on, ${who} misses the cache and is processed in full.`;
    $("next-lines").innerHTML = line(1, m.text, "") + line(2, nextValue(m), "");
  } else {
    $("next-caption").innerHTML = `Both requests match up to the start of <b>${esc(b.label)}</b>, ≈${fmt(brk.token)} tokens in. That block ${brk.scope === "request" ? "changes on every request" : "differs per user"}, so it and everything after it is processed in full for ${who}.`;
    const first = b.text.split("\n").find((l) => l.trim()) ?? "";
    $("next-lines").innerHTML = `<div class="next-line"><span class="n">#1</span><code><span class="diff">${esc(first.slice(0, 90))}</span>…</code></div><div class="next-line"><span class="n">#2</span><code><span class="diff">(different ${esc(b.label.toLowerCase())})</span></code></div>`;
  }
  card.hidden = false;
}

// ---------- Findings ----------

function renderFindings(a) {
  const list = $("findings");
  $("count").textContent = a.findings.length;
  $("fix").disabled = !optimize(state.blocks, { dismissed: state.dismissed }).changes.length;
  if (!a.findings.length) {
    list.innerHTML = `<li class="empty"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg><span>No problems found. Stable content comes first and nothing in it changes between requests.</span></li>`;
  } else {
    list.innerHTML = a.findings
      .map((f) => {
        const lost = f.lostTokens ? `<span class="lost">≈${fmt(f.lostTokens)} tokens affected</span>` : "";
        return `<li class="finding" data-finding="${esc(f.id)}">
          <div class="finding-top"><span class="sev ${f.severity}">${f.severity}</span><span class="finding-title">${esc(f.title)}</span></div>
          <p>${esc(f.detail)}</p>
          <p class="fix"><b>Fix:</b> ${esc(f.fix)}</p>
          <div class="finding-actions">
            ${f.blockId ? `<button type="button" data-show="${esc(f.blockId)}" data-range="${f.ranges ? f.ranges[0].join(",") : ""}">Show</button>` : ""}
            ${f.dismissible ? `<button type="button" data-dismiss="${esc(f.id)}">Not a problem</button>` : ""}
            ${lost}
          </div>
        </li>`;
      })
      .join("");
  }
  const restore = $("restore");
  restore.hidden = !state.dismissed.length;
  restore.innerHTML = `${state.dismissed.length} marked as not a problem. <button type="button" id="restore-btn">Restore</button>`;
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

$("bar").addEventListener("click", (e) => {
  const seg = e.target.closest("[data-goto]");
  if (seg) reveal(seg.dataset.goto);
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
    // Scroll the textarea so the selection is visible.
    const before = ta.value.slice(0, start).split("\n").length;
    ta.scrollTop = Math.max(0, (before - 3) * 20);
    el.querySelector(".hl").scrollTop = ta.scrollTop;
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
  const save = $("c-save");
  const pct = Math.round(c.savedPct);
  save.className = `save ${pct > 0 ? "" : pct < 0 ? "worse" : "none"}`;
  save.textContent = pct > 0 ? `${pct}% less` : pct < 0 ? `${-pct}% more` : "No saving";
  const p = PROVIDERS[model.provider];
  const notes = [
    `${p.how}`,
    `Cached input: $${model.read}/M tokens vs $${model.input}/M${model.write > model.input ? `; cache writes: $${model.write}/M` : ""}. Minimum: ${fmt(model.minTokens)} tokens. Lifetime: ${model.ttlNote}.`,
  ];
  if (!c.warm) notes.push(`At ${fmt(state.rph)} requests per hour, requests are ${c.gapMinutes.toFixed(0)} minutes apart, longer than the cache lifetime, so the shared prefix expires between requests.`);
  if (model.provider === "gemini") notes.push("Implicit caching on Gemini is best effort: this estimate assumes hits, which our live test didn't always get.");
  if (model.priceNote) notes.push(model.priceNote);
  $("cost-note").innerHTML = `${notes.map(esc).join(" ")} <a href="${p.pricing}" target="_blank" rel="noopener">Pricing</a> · <a href="${p.docs}" target="_blank" rel="noopener">Docs</a>`;
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

// ---------- Fix layout ----------

let proposal = null;

function openSheet() {
  proposal = optimize(state.blocks, { dismissed: state.dismissed });
  if (!proposal.changes.length) return;
  const before = run();
  const after = run(proposal.blocks);
  const row = (label, a) =>
    `<div class="compare-row"><span class="muted">${label}</span><div class="bar">${barHtml(a, { interactive: false })}</div><b>${a.score}</b></div>`;
  $("compare").innerHTML = row("Now", before) + row("Suggested", after);
  $("changes").innerHTML = proposal.changes.map((c) => `<li>${esc(c)}</li>`).join("");
  $("sheet").hidden = false;
  $("sheet-backdrop").hidden = false;
  $("sheet-apply").focus();
}

function closeSheet() {
  $("sheet").hidden = true;
  $("sheet-backdrop").hidden = true;
  $("fix").focus();
}

$("fix").addEventListener("click", openSheet);
$("sheet-close").addEventListener("click", closeSheet);
$("sheet-cancel").addEventListener("click", closeSheet);
$("sheet-backdrop").addEventListener("click", closeSheet);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("sheet").hidden) closeSheet();
});
$("sheet-apply").addEventListener("click", () => {
  snapshot("Layout updated.");
  state.blocks = proposal.blocks.map((b) => ({ ...b }));
  markCustom();
  closeSheet();
  renderAll();
});

// ---------- Undo toast ----------

let toastTimer = null;
function snapshot(message) {
  undoStack = structuredClone(state);
  const t = $("toast");
  t.innerHTML = `<span>${esc(message)}</span><button type="button" id="undo">Undo</button>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
$("toast").addEventListener("click", (e) => {
  if (e.target.id !== "undo" || !undoStack) return;
  state = undoStack;
  undoStack = null;
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
