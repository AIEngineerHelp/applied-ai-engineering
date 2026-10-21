// Shared by the lesson and the lab: catalog loading and text rendering.
"use strict";

const $ = (id) => document.getElementById(id);
const catalogPromise = fetch("/api/catalog").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const recordedCache = {};
function loadRecorded(risk, version) {
  const key = `${risk}--${version}`;
  recordedCache[key] ||= fetch(`/api/recorded/${risk}/${version}`).then((r) => r.json());
  return recordedCache[key];
}

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

