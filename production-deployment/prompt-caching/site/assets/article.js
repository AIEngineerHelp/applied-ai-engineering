// Charts and tables for the article, drawn from the committed results.

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const css = (name) => `var(--${name})`;

// ---------- Theme toggle ----------
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

// ---------- Tooltip ----------
function attachTips(container) {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  container.appendChild(tip);
  const show = (el, e) => {
    tip.innerHTML = el.dataset.tip;
    const box = container.getBoundingClientRect();
    const x = (e.clientX ?? box.left + box.width / 2) - box.left;
    const y = (e.clientY ?? box.top) - box.top;
    tip.style.left = `${Math.min(Math.max(8, x + 12), box.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 12)}px`;
    tip.classList.add("show");
  };
  container.addEventListener("pointermove", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) show(el, e);
    else tip.classList.remove("show");
  });
  container.addEventListener("pointerleave", () => tip.classList.remove("show"));
  container.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, { clientX: r.left + r.width / 2, clientY: r.top });
  });
  container.addEventListener("focusout", () => tip.classList.remove("show"));
}

// Short labels for chart rows.
const SHORT = {
  stable: "Stable prefix",
  "timestamp-top": "Timestamp at top",
  "timestamp-bottom": "Timestamp at bottom",
  "user-top": "Customer at top",
  "user-bottom": "Customer at bottom",
  "shuffled-tools": "Tools shuffled",
  "question-first": "Question first",
  explicit: "Explicit cache",
};

// ---------- Figure 3: reusable prefix ----------
function prefixChart(s) {
  const rows = s.layouts;
  const W = 760;
  const L = 150;
  const R = 160;
  const rowH = 30;
  const top = 24;
  const H = top + rows.length * rowH + 26;
  const x = (v) => L + v * (W - L - R);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of reusable prefix share by layout">`;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    svg += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 22}"/>`;
    svg += `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${t * 100}%</text>`;
  }
  rows.forEach((l, i) => {
    const y = top + i * rowH;
    const share = l.reusableShare ?? 0;
    const ok = (l.reusablePrefixTokens ?? 0) >= s.prices.minTokens;
    const w = Math.max(4, x(share) - L);
    const tip = `<b>${esc(l.title)}</b><br>${fmt(l.reusablePrefixTokens)} of ${fmt(l.promptTokensMedian)} tokens reusable (${fmt(share * 100, 1)}%)<br>${ok ? "Above" : "Below"} the ${fmt(s.prices.minTokens)}-token minimum`;
    svg += `<text class="label" x="${L - 12}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(SHORT[l.id] ?? l.title)}</text>`;
    svg += `<rect x="${L}" y="${y + 6}" width="${w}" height="${rowH - 12}" rx="4" fill="${ok ? css("shared") : css("uncached")}"/>`;
    svg += `<text class="value" x="${L + w + 8}" y="${y + rowH / 2 + 4}">${fmt(l.reusablePrefixTokens)} tokens · ${fmt(share * 100, 1)}%</text>`;
    svg += `<rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}" data-tip="${esc(tip)}" tabindex="0"/>`;
  });
  // Minimum line
  const minShare = s.prices.minTokens / median(rows.map((l) => l.promptTokensMedian));
  svg += `<line x1="${x(minShare)}" x2="${x(minShare)}" y1="${top - 4}" y2="${H - 22}" stroke="${css("text-2")}" stroke-dasharray="4 3" opacity=".6"/>`;
  svg += `<text class="axis" x="${x(minShare)}" y="12" text-anchor="middle">${fmt(s.prices.minTokens)}-token minimum</text>`;
  svg += "</svg>";
  $("chart-prefix").innerHTML = svg;
  attachTips($("chart-prefix"));
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- Figure 4: cached tokens per request ----------
function hitsChart(requests) {
  const series = [
    { id: "explicit", label: "Explicit cache", color: css("session") },
    { id: "stable", label: "Stable prefix (implicit)", color: css("uncached") },
  ];
  const W = 760;
  const L = 56;
  const R = 150;
  const top = 14;
  const H = 230;
  const maxY = 6000;
  const x = (i) => L + ((i - 1) / 11) * (W - L - R);
  const y = (v) => top + (1 - v / maxY) * (H - top - 30);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cached tokens per request for explicit and implicit caching">`;
  for (const t of [0, 2000, 4000, 6000]) {
    svg += `<line class="grid" x1="${L}" x2="${W - R + 10}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text class="axis" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`;
  }
  for (let i = 1; i <= 12; i++) svg += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${i}</text>`;
  for (const s of series) {
    const rs = requests.filter((r) => r.layout === s.id).sort((a, b) => a.i - b.i);
    svg += `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${rs.map((r) => `${x(r.i)},${y(r.cachedTokens)}`).join(" ")}"/>`;
    for (const r of rs) {
      const tip = `<b>${esc(s.label)}, request ${r.i}</b><br>${fmt(r.cachedTokens)} of ${fmt(r.promptTokens)} prompt tokens cached<br>“${esc(r.question)}”`;
      svg += `<circle cx="${x(r.i)}" cy="${y(r.cachedTokens)}" r="5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
      svg += `<circle class="hit" cx="${x(r.i)}" cy="${y(r.cachedTokens)}" r="12" data-tip="${esc(tip)}" tabindex="0"/>`;
    }
    const last = rs.at(-1);
    svg += `<text class="label" x="${x(12) + 14}" y="${y(last.cachedTokens) + 4}">${esc(s.label)}</text>`;
  }
  svg += `<text class="axis" x="${L}" y="${H - 8}" text-anchor="end" dx="-18">Request</text>`;
  svg += "</svg>";
  $("chart-hits").innerHTML = svg;
  attachTips($("chart-hits"));
}

// ---------- Figure 5: cost per request ----------
function costChart(s) {
  const rows = s.layouts;
  const W = 760;
  const L = 150;
  const R = 100;
  const rowH = 30;
  const top = 8;
  const H = top + rows.length * rowH + 26;
  const max = 0.005;
  const x = (v) => L + (v / max) * (W - L - R);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost per request by layout">`;
  for (const t of [0, 0.001, 0.002, 0.003, 0.004, 0.005]) {
    svg += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 22}"/>`;
    svg += `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">$${t.toFixed(3)}</text>`;
  }
  rows.forEach((l, i) => {
    const y = top + i * rowH;
    const w = Math.max(4, x(l.costPerRequestUsd) - L);
    const explicit = l.id === "explicit";
    const tip = `<b>${esc(l.title)}</b><br>$${l.costPerRequestUsd.toFixed(5)} per request (12 requests: $${l.costUsd.toFixed(4)})${explicit ? `<br>Includes $${l.cache.storageUsd.toFixed(6)} storage` : "<br>No cache hits: every token at full price"}`;
    svg += `<text class="label" x="${L - 12}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(SHORT[l.id] ?? l.title)}</text>`;
    svg += `<rect x="${L}" y="${y + 6}" width="${w}" height="${rowH - 12}" rx="4" fill="${explicit ? css("session") : css("text-2")}" opacity="${explicit ? 1 : 0.35}"/>`;
    svg += `<text class="value" x="${L + w + 8}" y="${y + rowH / 2 + 4}">$${l.costPerRequestUsd.toFixed(5)}</text>`;
    svg += `<rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}" data-tip="${esc(tip)}" tabindex="0"/>`;
  });
  svg += "</svg>";
  $("chart-cost").innerHTML = svg;
  attachTips($("chart-cost"));
}

// ---------- Figure 6: time to first token ----------
function latencyChart(s, requests) {
  const rows = s.layouts;
  const W = 760;
  const L = 150;
  const R = 70;
  const rowH = 30;
  const top = 8;
  const H = top + rows.length * rowH + 26;
  const max = 5000;
  const x = (v) => L + (Math.min(v, max) / max) * (W - L - R);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Time to first token per request, by layout">`;
  for (const t of [0, 1000, 2000, 3000, 4000, 5000]) {
    svg += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 22}"/>`;
    svg += `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${t / 1000} s${t === max ? "+" : ""}</text>`;
  }
  rows.forEach((l, i) => {
    const y = top + i * rowH + rowH / 2;
    const explicit = l.id === "explicit";
    const color = explicit ? css("session") : css("text-2");
    svg += `<text class="label" x="${L - 12}" y="${y + 4}" text-anchor="end">${esc(SHORT[l.id] ?? l.title)}</text>`;
    for (const r of requests.filter((q) => q.layout === l.id)) {
      const off = r.firstTokenMs > max;
      const tip = `<b>${esc(l.title)}, request ${r.i}</b><br>First token after ${fmt(r.firstTokenMs)} ms<br>${fmt(r.cachedTokens)} cached tokens`;
      svg += `<circle cx="${x(r.firstTokenMs)}" cy="${y}" r="4.5" fill="${color}" opacity="${explicit ? 0.85 : 0.5}" stroke="var(--surface)" stroke-width="1.5"/>`;
      if (off) svg += `<text class="value" x="${x(max) + 8}" y="${y + 4}">${fmt(r.firstTokenMs / 1000, 1)} s</text>`;
      svg += `<circle class="hit" cx="${x(r.firstTokenMs)}" cy="${y}" r="9" data-tip="${esc(tip)}" tabindex="0"/>`;
    }
    svg += `<line x1="${x(l.firstTokenMsMedian)}" x2="${x(l.firstTokenMsMedian)}" y1="${y - 10}" y2="${y + 10}" stroke="${css("text")}" stroke-width="2"/>`;
  });
  svg += "</svg>";
  $("chart-latency").innerHTML = svg;
  attachTips($("chart-latency"));
}

// ---------- Tables ----------
function tables(s) {
  $("layout-table").innerHTML = s.layouts.map((l) => `<tr><td><strong>${esc(l.title)}</strong></td><td>${esc(l.description)}</td></tr>`).join("");
  $("results-table").innerHTML = s.layouts
    .map(
      (l) => `<tr><td>${esc(l.title)}</td><td class="num">${fmt(l.promptTokensMedian)}</td><td class="num">${fmt(l.reusablePrefixTokens)} (${fmt(l.reusableShare * 100, 1)}%)</td><td class="num">${l.hits} / ${l.requests}</td><td class="num">${fmt(l.cachedShare * 100, 1)}%</td><td class="num">${fmt(l.firstTokenMsMedian / 1000, 2)} s</td><td class="num">$${l.costPerRequestUsd.toFixed(5)}</td></tr>`,
    )
    .join("");
  $("projection-table").innerHTML = s.layouts
    .map((l) => {
      const saving = 1 - l.projectedInputUsdPer1k / l.fullInputUsdPer1k;
      return `<tr><td>${esc(l.title)}</td><td class="num">$${l.fullInputUsdPer1k.toFixed(2)}</td><td class="num">$${l.projectedInputUsdPer1k.toFixed(2)}</td><td class="num">${saving > 0.001 ? `${fmt(saving * 100)}%` : "none"}</td></tr>`;
    })
    .join("");
}

async function main() {
  try {
    const [s, text] = await Promise.all([
      fetch("data/summary.json").then((r) => r.json()),
      fetch("data/requests.jsonl").then((r) => r.text()),
    ]);
    const requests = text.trim().split("\n").map((l) => JSON.parse(l));
    tables(s);
    prefixChart(s);
    hitsChart(requests);
    costChart(s);
    latencyChart(s, requests);
  } catch (error) {
    for (const id of ["chart-prefix", "chart-hits", "chart-cost", "chart-latency"]) {
      $(id).innerHTML = `<p class="caption">Couldn't load the results (${esc(error.message)}). They are in results/ in the repository.</p>`;
    }
  }
}

main();
