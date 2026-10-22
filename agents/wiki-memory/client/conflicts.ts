// The "How conflicts are resolved" section: the facts, the ranking rule, the resolver's output and the
// review card. A pure function of run.conflicts (computed by src/resolve.ts), so tests can check it.

import type { Conflicts } from "../src/build.ts";
import type { Fact, Resolution } from "../src/resolve.ts";
import { esc } from "./render.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
const scopeLabel = (s: string) => (s === "all" ? "all plans" : s === "standard" ? "other plans" : `${s.charAt(0).toUpperCase()}${s.slice(1)}`);
const srcName = (f: Fact) => f.source.replace(/^(raw|review)\/\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "").replace(/-/g, " ");

export function renderConflictsHtml(c: Conflicts): string {
  const keys = Object.keys(c.keys);
  const factRows = keys
    .map((key) => {
      const rows = c.facts
        .filter((f) => f.key === key)
        .map(
          (f) => `<tr><td class="v">${esc(f.value)}</td><td>${esc(scopeLabel(f.scope))}</td><td>${esc(srcName(f))}<span class="q">“${esc(f.quote)}”</span></td><td>${esc(f.sourceType)}</td><td class="d">${shortDate(f.date)}</td></tr>`,
        )
        .join("");
      return `<tbody><tr class="kh"><th colspan="5">${esc(c.keys[key].label)} <code>${esc(key)}</code></th></tr>${rows}</tbody>`;
    })
    .join("");

  const ranking = c.ranking
    .slice()
    .sort((a, b) => b.rank - a.rank)
    .map((t) => `<li><strong>${t.types.map(esc).join(", ")}</strong><span>${esc(t.note)}</span></li>`)
    .join("");

  const result = (r: Resolution) => {
    const head = `${esc(c.keys[r.key].label)}, ${esc(scopeLabel(r.scope))}`;
    const lost = r.lost
      .map((l) => `<li>${l.kind === "agrees" ? esc(l.fact.value) : `<s>${esc(l.fact.value)}</s>`} <span class="src">${esc(srcName(l.fact))}</span> <span class="why">${esc(l.reason)}</span></li>`)
      .join("");
    if (r.status === "current") {
      const f = r.current!;
      return `<div class="res" data-status="current"><p class="res-h">${head}</p><p class="res-v">${esc(f.value)} <span class="tag-ok">current</span></p>
        <p class="res-src">From ${esc(srcName(f))} (${esc(f.sourceType)}, ${shortDate(f.date)})</p>${lost ? `<ul class="lost">${lost}</ul>` : ""}</div>`;
    }
    return `<div class="res" data-status="disputed"><p class="res-h">${head}</p><p class="res-v">${r.contenders.map((x) => esc(x.value)).join(" or ")} <span class="tag-bad">disputed</span></p>
      <p class="res-src">Same rank (${esc(r.contenders[0].sourceType)}), same date (${shortDate(r.contenders[0].date)}), different values. The rule can't decide.</p>${lost ? `<ul class="lost">${lost}</ul>` : ""}</div>`;
  };

  const disputed = c.results.filter((r) => r.status === "disputed");
  const cards = disputed
    .map(
      (r) => `<div class="review"><p class="label">Needs a person · review queue</p>
      <p class="review-q">Is the longest date range in one export ${r.contenders.map((x) => esc(x.value)).join(" or ")}?</p>
      <div class="review-sides">${r.contenders
        .map((x) => `<div><p class="review-v">${esc(x.value)}</p><p class="review-s">${esc(srcName(x))} · ${shortDate(x.date)}</p><p class="review-quote">“${esc(x.quote)}”</p></div>`)
        .join("")}</div>
      <p class="review-note">Until someone decides, the wiki page keeps both values marked <em>disputed</em>, and any answer about the date range says so and names both sources. A good reviewer here is Amara, who owns Ledger Export and wrote the on-call runbook's reason (the 06:00 UTC deadline).</p></div>`,
    )
    .join("");

  return `<div class="cf-grid">
      <div>
        <h3 class="sub">The facts, as the agent extracted them</h3>
        <div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Value</th><th>Scope</th><th>Source and quote</th><th>Type</th><th>Date</th></tr></thead>${factRows}</table></div>
      </div>
      <div>
        <h3 class="sub">The rule, applied by code</h3>
        <ol class="rank">${ranking}</ol>
        <p class="caption mt-3">First match scope (a fact for all plans also applies to each plan). Then the higher-ranked source wins. At the same rank, the newer document wins. Same rank, same date and different values: disputed.</p>
      </div>
    </div>
    <h3 class="sub mt-12">What the resolver returns</h3>
    <div class="res-grid">${c.results.map(result).join("")}</div>
    ${cards}`;
}
