let samples = [];
let selectedId = null;
let demoMode = false;

async function refreshHealth() {
  try {
    const r = await fetch("/api/health");
    const h = await r.json();
    demoMode = !!h.demo_mode;
    const el = document.getElementById("healthBadge");
    el.textContent = `db:${h.database} · laya:${h.laya} · jev:${h.jev} · gemini:${h.gemini}`;
    const note = document.getElementById("demoNote");
    if (demoMode) {
      note.hidden = false;
      document.getElementById("tagline").textContent =
        "Pick a test ticket. Jev decides. Gemini writes only if the gate opens.";
      document.getElementById("subject").readOnly = true;
      document.getElementById("body").readOnly = true;
      document.getElementById("forceJev").disabled = true;
      document.getElementById("skipDraft").disabled = true;
    }
  } catch (e) {
    document.getElementById("healthBadge").textContent = "health unavailable";
  }
}

async function refreshCases() {
  const r = await fetch("/api/cases?limit=12");
  const rows = await r.json();
  const body = document.getElementById("casesBody");
  body.innerHTML = "";
  for (const c of rows) {
    const tr = document.createElement("tr");
    const total = c.timing_json?.total_ms ?? "—";
    tr.innerHTML = `<td>${c.id}</td><td>${escapeHtml(c.subject || "")}</td><td>${c.intent || "—"}</td><td>${c.gate_decision || "—"}</td><td>${c.goal_reached ? "yes" : "no"}</td><td>${total}</td>`;
    body.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function setPill(id, used) {
  const el = document.getElementById(id);
  const name = id.replace("p", "");
  el.className = "pill " + (used ? "ok" : "");
  el.textContent = name + (used ? " used" : " idle");
}

function selectSample(sample) {
  selectedId = sample.id;
  document.getElementById("subject").value = sample.subject;
  document.getElementById("body").value = sample.body;
  document.getElementById("forceJev").checked = !!sample.force_jev;
  document.getElementById("skipDraft").checked = !!sample.skip_draft;
  document.querySelectorAll("#samples button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.id === sample.id);
  });
}

async function loadSamples() {
  const r = await fetch("/api/samples");
  samples = await r.json();
  const box = document.getElementById("samples");
  box.innerHTML = "";
  for (const sample of samples) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.id = sample.id;
    btn.textContent = sample.subject;
    btn.title = sample.expect_hint || "";
    btn.addEventListener("click", () => selectSample(sample));
    box.appendChild(btn);
  }
  if (samples.length) selectSample(samples[0]);
}

function renderResult(data) {
  document.getElementById("mGate").textContent = data.gate_decision;
  document.getElementById("mGoal").textContent = data.timing.goal_reached ? "reached" : "not reached";
  document.getElementById("mTotal").textContent = `${data.timing.total_ms} ms`;
  document.getElementById("mConf").textContent = data.confidence != null ? Number(data.confidence).toFixed(3) : "—";
  document.getElementById("message").textContent = data.message;
  document.getElementById("draft").textContent = data.draft || "No draft (gate did not open or draft skipped).";

  const tl = document.getElementById("timeline");
  tl.innerHTML = "";
  for (const s of data.timing.steps || []) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="${s.ok ? "" : "fail"}">${escapeHtml(s.step)}${s.detail ? " · " + escapeHtml(s.detail) : ""}</span><span class="ms">${s.duration_ms ?? "—"} ms</span>`;
    tl.appendChild(li);
  }

  setPill("pLaya", data.used_laya);
  setPill("pJev", data.used_jev);
  setPill("pGemini", data.used_gemini);
}

document.getElementById("runBtn").addEventListener("click", async () => {
  const btn = document.getElementById("runBtn");
  btn.disabled = true;
  document.getElementById("statusText").textContent = "Running… this can take 10–20 seconds";
  try {
    const payload = {
      subject: document.getElementById("subject").value,
      body: document.getElementById("body").value,
      force_jev: document.getElementById("forceJev").checked,
      skip_draft: document.getElementById("skipDraft").checked,
      sample_id: selectedId,
      source: demoMode ? "public_demo" : "inbox",
    };
    const r = await fetch("/api/pipeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      document.getElementById("statusText").textContent = data.detail || "Request failed";
      return;
    }
    renderResult(data);
    await refreshCases();
    document.getElementById("statusText").textContent = `Case #${data.case_id}`;
  } catch (e) {
    document.getElementById("statusText").textContent = String(e);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("sampleBtn").addEventListener("click", () => {
  const next = samples.find((s) => s.id === "bug_android") || samples[1] || samples[0];
  if (next) selectSample(next);
});

loadSamples();
refreshHealth();
refreshCases();
setInterval(refreshHealth, 15000);
