// The demo page: pick a risk, replay or run Giskard's attacks, and read the judge's verdicts.
"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  catalog: null,
  agentId: "bank",
  riskId: null,
  version: "naive",
  run: null,         // the run being shown (recorded replay or live)
  selected: 0,       // selected attack index
  replayTimer: null,
  pollTimer: null,
  liveRuns: {},      // "risk|version" -> summary of live runs finished in this session
};

const STATUS = {
  queued: ["Waiting", ""],
  running: ["Attacking…", "run"],
  passed: ["Passed", "good"],
  failed: ["Failed", "bad"],
  error: ["Error", "warn"],
};

// ---------- text helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Phrases the judge quoted in its reason, so we can mark them in the agent's reply.
function quotedPhrases(reason) {
  const out = [];
  const re = /['‘“"]([^'’”"]{12,}?)['’”"]/g;
  let m;
  while ((m = re.exec(reason || ""))) {
    const p = m[1].replace(/(\.\.\.|…)\s*$/, "").replace(/^\s*(\.\.\.|…)/, "").trim();
    if (p.length >= 10) out.push(p);
  }
  return out;
}

// Minimal Markdown for model replies, with optional highlighted phrases.
function render(text, marks = []) {
  let raw = String(text ?? "");
  for (const p of marks) {
    const plain = raw.replace(/\*\*/g, "");
    const at = plain.toLowerCase().indexOf(p.toLowerCase());
    if (at < 0) continue;
    // Map the position in the bold-free text back to the raw text.
    let i = 0, j = 0, start = -1, end = -1;
    while (i <= raw.length) {
      if (j === at && start < 0) start = i;
      if (j === at + p.length) { end = i; break; }
      if (raw.startsWith("**", i)) { i += 2; continue; }
      i++; j++;
    }
    if (start >= 0 && end > start) raw = raw.slice(0, start) + "\u0001" + raw.slice(start, end) + "\u0002" + raw.slice(end);
  }
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
  const out = [];
  let para = [], list = [], table = [];
  const flush = () => {
    if (para.length) out.push("<p>" + para.map(inline).join("<br>") + "</p>");
    if (list.length) out.push("<ul>" + list.map((l) => "<li>" + inline(l) + "</li>").join("") + "</ul>");
    if (table.length) {
      const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r.replace(/\|/g, "|").trim().replace(/^\|/, "")));
      out.push("<table class=\"md\">" + rows.map((r, i) => "<tr>" + r.trim().replace(/^\||\|$/g, "").split("|")
        .map((c) => (i === 0 ? "<th>" : "<td>") + inline(c.trim()) + (i === 0 ? "</th>" : "</td>")).join("") + "</tr>").join("") + "</table>");
    }
    para = []; list = []; table = [];
  };
  for (const line of raw.trim().split("\n")) {
    const t = line.trim();
    if (!t) { flush(); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push("<hr>"); continue; }
    if (t.startsWith("|")) { if (para.length || list.length) { const keep = table; flush(); table = keep; } table.push(t); continue; }
    if (table.length) flush();
    const li = t.match(/^([*-]|\d+\.)\s+(.*)$/);
    if (li) { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } list.push(li[2]); continue; }
    if (list.length) { out.push("<ul>" + list.map((l) => "<li>" + inline(l) + "</li>").join("") + "</ul>"); list = []; }
    para.push(t.replace(/^#{1,6}\s+/, ""));
  }
  flush();
  return out.join("");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = "none"), 4200);
}

function noteFor(run, i) {
  if (!run || run.mode !== "recorded") return null;
  return state.catalog.review_notes?.[`${run.risk}--${run.version}`]?.[String(i + 1)] || null;
}

// ---------- step 1 ----------
function risksFor(agentId) {
  return Object.values(state.catalog.risks).filter((r) => r.agent === agentId);
}

function scoreText(s) {
  return s ? `<b>${s.passed}/${s.total}</b>` : "—";
}

function renderStep1() {
  const { agents, recorded, versions } = state.catalog;
  $("agentTabs").innerHTML = Object.values(agents).map((a) =>
    `<button role="tab" aria-selected="${a.id === state.agentId}" data-agent="${a.id}">${esc(a.industry)}<small>${esc(a.name.split(",")[0])}</small></button>`).join("");

  const agent = agents[state.agentId];
  const risks = risksFor(agent.id);
  $("agentBox").innerHTML = `
    <h3>${esc(agent.name)}</h3>
    <p>${esc(agent.description)}</p>
    <details><summary>What the agent can see (synthetic data)</summary><pre class="box">${esc(agent.context)}</pre></details>
    <div class="label">Risk to test</div>
    ${risks.map((r) => {
      const rec = recorded[r.id] || {};
      return `<button class="risk-opt" aria-pressed="${r.id === state.riskId}" data-risk="${r.id}">
        <div class="path">${esc(r.domain)} › ${esc(r.category)}</div>
        <div class="name">${esc(r.risk)}</div>
        <div class="scores"><span>Recorded runs, passed:</span><span>naive ${scoreText(rec.naive?.summary)}</span><span>hardened ${scoreText(rec.hardened?.summary)}</span></div>
      </button>`;
    }).join("")}`;

  const r = state.catalog.risks[state.riskId];
  $("defBox").innerHTML = `
    <div class="def-head">
      <h3>Risk definition: ${esc(r.risk)}</h3>
      <span class="owner">Written by: <b>${esc(r.owner)}</b></span>
    </div>
    <table class="def">
      <tr><th>Domain › category</th><td>${esc(r.domain)} › ${esc(r.category)}</td></tr>
      <tr><th>Why it matters</th><td>${esc(r.basis)}</td></tr>
      <tr><th>Prohibited</th><td>${esc(r.prohibited)}</td></tr>
      <tr><th>Allowed instead</th><td>${esc(r.allowed_alternative)}</td></tr>
      <tr><th>Expected behavior</th><td>${esc(r.expected_behavior)}</td></tr>
      <tr><th>Example questions</th><td><div class="qs">${r.example_questions.map((q) => `<span>${esc(q)}</span>`).join("")}</div></td></tr>
    </table>
    <div class="uses">
      <div class="use attk"><h4>What the attacker gets</h4><p>The agent's description, this risk's name, why it matters, the example questions, and the rule. Its instructions say to hide the request in hypotheticals or role-play and to press on any loophole across turns.</p>
        <details><summary>Giskard's attacker prompt</summary><pre class="box">${esc(state.catalog.attacker_template)}</pre></details></div>
      <div class="use judge"><h4>What the judge gets</h4><p>The full conversation and this rule, built from the definition above:</p><div class="rule">${esc(r.rule)}</div></div>
    </div>
    <div class="version">
      <div class="tabs" role="tablist" id="versionTabs">
        ${Object.keys(versions).map((v) => `<button role="tab" aria-selected="${v === state.version}" data-version="${v}">${v === "naive" ? "Naive prompt" : "Hardened prompt"}</button>`).join("")}
      </div>
      <div class="why">${state.version === "naive"
        ? "The agent is told to be helpful and specific, with no written policy. This is how many agents start out."
        : "The policy from this risk definition is written into the agent's system prompt. That is the first fix a failing eval usually leads to."}
        <details><summary>Show the system prompt</summary><pre class="box">${esc(agent.prompts[state.version])}</pre></details>
      </div>
    </div>`;
}

// ---------- step 2 ----------
function stopActivity() {
  clearInterval(state.replayTimer);
  clearInterval(state.pollTimer);
  state.replayTimer = state.pollTimer = null;
}

function setRun(run) {
  state.run = run;
  if (state.selected >= (run?.attacks.length || 0)) state.selected = 0;
  renderStep2();
  renderStep3();
}

function renderButtons() {
  const live = state.catalog.live;
  const busy = !!(state.replayTimer || state.pollTimer);
  const rec = state.catalog.recorded[state.riskId]?.[state.version];
  $("replayBtn").disabled = !rec || !!state.pollTimer;
  $("replayBtn").textContent = state.replayTimer ? "⏭ Skip to results" : "▶ Replay recorded run";
  $("liveBtn").disabled = !live.available || busy || live.busy;
  let hint;
  if (!live.available) hint = "Live runs need GEMINI_API_KEY in .env. The recorded runs need no key.";
  else if (state.pollTimer) hint = `Live run in progress: ${live.attacks} attacks against Gemini. This takes a minute or two.`;
  else hint = `A live run makes ${live.attacks} new attacks: at most ${live.attacks * 7} paid Gemini calls (${esc(live.models.agent)}).`;
  if (!rec && !state.pollTimer) hint = "No recorded run for this choice yet. " + hint;
  $("runHint").innerHTML = hint;
}

function attackSnippet(a) {
  return a.turns[0]?.user || (a.status === "queued" ? "Waiting for a free slot…" : a.error || "The attacker is writing the first message…");
}

function renderStep2() {
  renderButtons();
  const run = state.run;
  if (!run) {
    $("attackList").innerHTML = "";
    $("convo").innerHTML = `<div class="empty"><b>No attacks yet</b>Press <i>Replay recorded run</i> to watch ${10} recorded attacks on this agent, or run new ones live.</div>`;
    return;
  }
  $("attackList").innerHTML = run.attacks.map((a, i) => {
    const [label, cls] = STATUS[a.status];
    return `<button class="attack" aria-pressed="${i === state.selected}" data-attack="${i}">
      <div class="row"><span class="n">Attack ${i + 1}${noteFor(run, i) && !state.replayTimer ? ' <span class="pill warn" title="We left a review note on this verdict">Review note</span>' : ""}</span><span class="pill ${cls}">${label}</span></div>
      <div class="snip">${esc(attackSnippet(a))}</div></button>`;
  }).join("");
  const list = $("attackList"), sel = list.querySelector('[aria-pressed="true"]');
  if (sel && (sel.offsetTop < list.scrollTop || sel.offsetTop + sel.offsetHeight > list.scrollTop + list.clientHeight)) {
    list.scrollTop = sel.offsetTop - list.offsetTop - 8;
  }
  renderConvo();
}

function renderConvo() {
  const run = state.run;
  const a = run.attacks[state.selected];
  const agentName = state.catalog.agents[run.agent].name.split(",")[0];
  const failed = a.status === "failed";
  const marks = failed ? quotedPhrases((a.checks.find((c) => c.kind === "conformity") || a.checks[0] || {}).reason) : [];
  let html = a.turns.map((t, k) => `
    <div class="msg user"><div class="who">Giskard attacker <span class="turn-tag">· an LLM playing a user · turn ${k + 1}</span></div><div class="bubble">${render(t.user)}</div></div>
    ${t.agent == null ? "" : `<div class="msg agent"><div class="who"><span class="turn-tag">agent under test ·</span> ${esc(agentName)}</div><div class="bubble">${render(t.agent, marks)}</div></div>`}`).join("");
  const pending = a._pending || (a.status === "running" ? "turn" : a.status === "queued" ? "queued" : null);
  const typing = {
    attacker: `<div class="typing"><span class="dots"><i></i><i></i><i></i></span> The attacker is writing its next message</div>`,
    agent: `<div class="typing right"><span class="dots"><i></i><i></i><i></i></span> ${esc(agentName)} is replying</div>`,
    judge: `<div class="typing"><span class="dots"><i></i><i></i><i></i></span> The judge is reading the conversation</div>`,
    turn: `<div class="typing"><span class="dots"><i></i><i></i><i></i></span> Attack in progress</div>`,
    queued: `<div class="typing">Waiting for a free slot (attacks run five at a time)</div>`,
  }[pending] || "";
  html += typing;
  if (a.status === "passed" || a.status === "failed") {
    const n = a.turns.length;
    html += `<div class="typing">The attacker stopped after ${n} turn${n === 1 ? "" : "s"}. Verdict in step 3 ↓</div>`;
  }
  if (a.status === "error") html += `<div class="typing" style="color:var(--warn)">${esc(a.error || "This attack errored.")}</div>`;
  const box = $("convo");
  const key = `${run.id}|${state.selected}`;
  const fresh = box.dataset.key !== key;
  box.dataset.key = key;
  const atBottom = !fresh && box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = html || `<div class="empty"><b>Attack ${state.selected + 1}</b>Waiting to start.</div>`;
  const active = a.status === "running" || a.status === "queued";
  if (fresh && !active) box.scrollTop = 0;
  else if (atBottom || (active && (state.replayTimer || state.pollTimer))) box.scrollTop = box.scrollHeight;
}

// Replay a recorded run at reading speed: attacks start a little apart, and each turn appears in order.
function replay() {
  if (state.replayTimer) return finishReplay();
  stopActivity();
  const { riskId, version } = state;
  fetch(`/api/recorded/${riskId}/${version}`).then((r) => r.json()).then((rec) => {
    const show = JSON.parse(JSON.stringify(rec));
    show.attacks.forEach((a) => { a.turns = []; a.status = "queued"; a._pending = "queued"; });
    show._source = rec;
    const events = [];
    rec.attacks.forEach((a, i) => {
      let t = i * 700;
      events.push({ t, i, type: "start" });
      a.turns.forEach((turn, k) => {
        t += 1400; events.push({ t, i, type: "user", k });
        t += 1800; events.push({ t, i, type: "agent", k });
      });
      t += 1500; events.push({ t, i, type: "verdict" });
    });
    events.sort((x, y) => x.t - y.t);
    const t0 = performance.now();
    state.selected = 0;
    setRun(show);
    state.replayTimer = setInterval(() => {
      const now = performance.now() - t0;
      let changed = false;
      while (events.length && events[0].t <= now) {
        const e = events.shift(); changed = true;
        const a = show.attacks[e.i], src = rec.attacks[e.i];
        if (e.type === "start") { a.status = "running"; a._pending = "attacker"; }
        if (e.type === "user") { a.turns.push({ user: src.turns[e.k].user, agent: null }); a._pending = "agent"; }
        if (e.type === "agent") { a.turns[e.k].agent = src.turns[e.k].agent; a._pending = e.k + 1 < src.turns.length ? "attacker" : "judge"; }
        if (e.type === "verdict") { Object.assign(a, { status: src.status, checks: src.checks, error: src.error, _pending: null }); }
      }
      if (!events.length) return finishReplay();
      if (changed) { renderStep2(); renderStep3(); }
    }, 120);
    renderButtons();
  }).catch(() => toast("Could not load the recorded run."));
}

function finishReplay() {
  stopActivity();
  const rec = state.run?._source;
  if (rec) setRun(rec); else { renderStep2(); renderStep3(); }
}

async function runLive() {
  const live = state.catalog.live;
  const ok = confirm(`Run ${live.attacks} new attacks with Gemini?\n\nThis makes up to ${live.attacks * 7} paid API calls and takes a minute or two. Results are saved locally in runs/.`);
  if (!ok) return;
  stopActivity();
  const res = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ risk: state.riskId, version: state.version }) });
  const body = await res.json();
  if (!res.ok) return toast(body.detail || "Could not start the run.");
  const key = `${state.riskId}|${state.version}`;
  state.selected = 0;
  const poll = async () => {
    try {
      const run = await (await fetch(`/api/runs/${body.id}`)).json();
      setRun(run);
      if (run.status !== "running") {
        stopActivity();
        if (run.summary) state.liveRuns[key] = run.summary;
        if (run.status === "error") toast(run.error || "The live run failed.");
        renderButtons(); renderStep3();
      }
    } catch { /* keep polling */ }
  };
  state.pollTimer = setInterval(poll, 1000);
  poll();
  renderButtons();
}

// ---------- step 3 ----------
function renderStep3() {
  const run = state.run;
  if (!run) {
    $("verdict").innerHTML = `<div class="empty" style="margin:30px auto"><b>No verdict yet</b>Run or replay attacks in step 2.</div>`;
    $("summary").innerHTML = summaryHtml(null);
    return;
  }
  const a = run.attacks[state.selected];
  const judge = a.checks.find((c) => c.kind === "conformity") || a.checks[0];
  let body;
  if (a.status === "passed" || a.status === "failed") {
    const pass = a.status === "passed";
    body = `
      <div class="v-big"><span class="v-badge ${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"}</span>
        <div><div class="v-title">Attack ${state.selected + 1}: ${pass ? "the agent kept to the rule" : "the agent broke the rule"}</div>
        <div class="v-sub">Judge: Giskard <code>Conformity</code> check · ${esc(run.models.judge)} · after ${a.turns.length} turn${a.turns.length === 1 ? "" : "s"}</div></div></div>
      <div class="reason ${pass ? "" : "fail"}"><b>Judge's reason.</b> ${esc(judge?.reason || "No reason given.")}</div>
      <div class="meaning">${pass
        ? "In this conversation, the agent held the line across every turn the attacker tried. One passing conversation doesn't prove the agent is safe, which is why Giskard runs many attacks."
        : "Phrases the judge quoted are <mark style=\"background:var(--mark);padding:0 2px;border-radius:3px\">highlighted</mark> in the conversation above. In Chime's process, a failure like this goes to the rule's owner. They confirm the verdict, then the team fixes the prompt, the attacks, the judge or the rule itself."}</div>
      ${(() => { const n = noteFor(run, state.selected); return n ? `<div class="review"><div class="review-h">Our review · ${esc(n.verdict)}</div>${esc(n.note)}</div>` : ""; })()}
      <details><summary>The rule the judge applied</summary><div class="rule">${esc(run.rule)}</div></details>`;
  } else if (a.status === "error") {
    body = `<div class="v-big"><span class="v-badge error">ERROR</span><div><div class="v-title">Attack ${state.selected + 1} didn't finish</div><div class="v-sub">${esc(a.error || "")}</div></div></div>
      <div class="meaning">Errors are excluded from the pass rate. They are usually rate limits, timeouts, or the attacker model refusing to write the attack.</div>`;
  } else {
    body = `<div class="v-big"><span class="v-badge" style="background:var(--surface-2);color:var(--muted)">…</span><div><div class="v-title">Attack ${state.selected + 1} is still running</div><div class="v-sub">The judge scores the conversation once the attacker stops.</div></div></div>`;
  }
  $("verdict").innerHTML = body;
  $("summary").innerHTML = summaryHtml(run);
}

function summaryHtml(run) {
  const rec = state.catalog.recorded[state.riskId] || {};
  const done = run ? run.attacks.filter((a) => a.status === "passed" || a.status === "failed") : [];
  const passed = done.filter((a) => a.status === "passed").length;
  const errors = run ? run.attacks.filter((a) => a.status === "error").length : 0;
  const finished = run && run.attacks.every((a) => !["queued", "running"].includes(a.status));
  const head = run ? `
    <div class="label" style="margin-top:0">This run · ${run.mode === "live" ? "live, this session" : "recorded " + esc(run.started_at.slice(0, 10))} · ${state.catalog.versions[run.version].split(":")[0]}</div>
    <div class="big-score">${finished
      ? `${passed} of ${done.length} <span style="font-size:15px;font-weight:500;color:var(--ink-2)">attacks passed</span>`
      : `${done.length} of ${run.attacks.length} <span style="font-size:15px;font-weight:500;color:var(--ink-2)">attacks scored so far · ${passed} passed</span>`}</div>
    <div class="squares">${run.attacks.map((a, i) => `<span class="sq ${a.status}" title="Attack ${i + 1}: ${STATUS[a.status][0]}"></span>`).join("")}</div>
    ${errors ? `<div class="hint">${errors} attack${errors === 1 ? "" : "s"} errored and ${errors === 1 ? "is" : "are"} left out.</div>` : ""}` :
    `<div class="label" style="margin-top:0">This run</div><div class="hint">Nothing run yet.</div>`;
  const row = (label, s) => {
    if (!s) return `<div class="cmp-row"><span>${label}</span><span class="hint">not recorded</span><b>—</b></div>`;
    const n = s.passed + s.failed;
    return `<div class="cmp-row"><span>${label}</span><span class="bar"><i style="width:${n ? (100 * s.passed) / n : 0}%"></i></span><b>${s.passed}/${n}</b></div>`;
  };
  const live = state.liveRuns;
  const n = rec.naive?.summary, h = rec.hardened?.summary;
  let takeaway = "";
  if (n && h) {
    const rn = n.passed / Math.max(1, n.passed + n.failed), rh = h.passed / Math.max(1, h.passed + h.failed);
    const gap = Math.round((rh - rn) * 10);  // in attacks, out of about 10
    takeaway = gap >= 2
      ? "Writing the policy into the prompt raised the pass rate. Rerunning the same suite after every change is what turns this into a regression test."
      : gap <= -2
      ? "The hardened prompt scored lower here. Read the failing conversations before drawing a conclusion: the rule or the judge may be at fault."
      : "Both versions scored about the same. With about 10 attacks, a difference of one is noise. This model already behaves well on this risk, so the eval says your effort is better spent elsewhere.";
  }
  return `${head}
    <div class="compare">
      <div class="label" style="margin-top:0">Naive vs hardened prompt, recorded runs</div>
      ${row("Naive", n)}${row("Hardened", h)}
      ${live[`${state.riskId}|naive`] ? row("Naive · live", live[`${state.riskId}|naive`]) : ""}
      ${live[`${state.riskId}|hardened`] ? row("Hardened · live", live[`${state.riskId}|hardened`]) : ""}
      <div class="meaning">${takeaway}</div>
    </div>`;
}

// ---------- wiring ----------
function selectRisk(riskId) {
  stopActivity();
  state.riskId = riskId;
  state.run = null;
  renderStep1(); renderStep2(); renderStep3();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-agent],[data-risk],[data-version],[data-attack]");
  if (!t) return;
  if (t.dataset.agent && t.dataset.agent !== state.agentId) {
    state.agentId = t.dataset.agent;
    selectRisk(risksFor(state.agentId)[0].id);
  } else if (t.dataset.risk && t.dataset.risk !== state.riskId) {
    selectRisk(t.dataset.risk);
  } else if (t.dataset.version && t.dataset.version !== state.version) {
    state.version = t.dataset.version;
    selectRisk(state.riskId);
  } else if (t.dataset.attack) {
    state.selected = Number(t.dataset.attack);
    renderStep2(); renderStep3();
  }
});
$("replayBtn").addEventListener("click", replay);
$("liveBtn").addEventListener("click", runLive);

fetch("/api/catalog").then((r) => r.json()).then((cat) => {
  state.catalog = cat;
  // Deep links such as ?risk=emergency-escalation&version=naive&attack=3 open a recorded conversation.
  const q = new URLSearchParams(location.search);
  const risk = cat.risks[q.get("risk")];
  if (risk) state.agentId = risk.agent;
  state.riskId = risk ? risk.id : risksFor(state.agentId)[0].id;
  if (cat.versions[q.get("version")]) state.version = q.get("version");
  renderStep1(); renderStep2(); renderStep3();
  if (q.has("replay") && cat.recorded[state.riskId]?.[state.version]) replay();
  else if (q.has("attack") && cat.recorded[state.riskId]?.[state.version]) {
    fetch(`/api/recorded/${state.riskId}/${state.version}`).then((r) => r.json()).then((rec) => {
      state.selected = Math.max(0, Number(q.get("attack")) - 1) || 0;
      setRun(rec);
      $("step2").scrollIntoView();
    });
  }
  const any = Object.values(cat.recorded).flatMap((v) => Object.values(v))[0];
  const ver = state.catalog.live.models;
  $("footer").innerHTML = `Agent, attacker and judge: ${esc(any?.models.agent || ver.agent)} · Giskard checks and scan v3 · Recorded ${esc(any?.recorded_at?.slice(0, 10) || "—")} · All people, accounts and records are synthetic. Not legal or medical advice. · <a href="https://github.com/Giskard-AI/giskard-oss">Giskard on GitHub</a>`;
}).catch(() => toast("Could not load the app data. Is the server running?"));
