// Telemetry sidebar and decision log: headline numbers, latency-vs-budget
// chart, the last Jev call, and a per-decision table. Pure DOM/SVG.
import type { Action, Kind } from "../src/game.js";
import { obstacleState } from "../src/players.js";

export interface Decision {
  index: number;
  kind: Kind;
  label: string;
  startedAt: number;
  action?: Action;
  confidence?: number;
  probabilities?: Record<string, number> | null;
  /** Browser → server → Jev → browser, which is what the game experiences. */
  roundTripMs?: number;
  /** Time the server measured around the Jev API call alone. */
  apiMs?: number;
  /** Time between the request and the last moment the chosen move could start. */
  budgetMs?: number | null;
  safe?: boolean;
  late?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string;
  error?: string;
}

export interface Meta {
  player: "human" | "rule" | "jev";
  mode: "realtime" | "paused";
  model: string;
  live: boolean;
}

const $ = (id: string) => document.getElementById(id);
const fmt = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : `${Math.round(ms)}`);
const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

export function createTelemetry() {
  let signature = "";

  function stats(decisions: Decision[], meta: Meta) {
    const answered = decisions.filter((d) => d.action);
    const rtt = answered.map((d) => d.roundTripMs);
    const api = answered.map((d) => d.apiMs).filter((ms) => ms !== undefined);
    const ai = meta.player !== "human";
    const jev = meta.player === "jev";
    const late = answered.filter((d) => d.late).length;
    const unsafe = answered.filter((d) => d.safe === false).length;
    const values: Record<string, string> = {
      "kpi-decisions": ai ? String(answered.length) : "—",
      "kpi-median": jev ? fmt(percentile(rtt, 50)) : "—",
      "kpi-p90": jev ? fmt(percentile(rtt, 90)) : "—",
      "kpi-api": jev ? fmt(percentile(api, 50)) : "—",
      "kpi-late": ai ? String(late) : "—",
      "kpi-unsafe": ai ? String(unsafe) : "—",
    };
    for (const [id, value] of Object.entries(values)) $(id).textContent = value;
    $("kpi-late").closest(".stat").classList.toggle("bad", ai && late > 0);
    $("kpi-unsafe").closest(".stat").classList.toggle("bad", ai && unsafe > 0);
  }

  /** Bars: round-trip latency. Ticks: the time budget the chosen move allowed. */
  function chart(decisions: Decision[], meta: Meta, now: number) {
    const root = $("chart") as unknown as SVGSVGElement;
    root.replaceChildren();
    // Draw in real pixels so text and bars never stretch.
    const W = Math.max(240, root.clientWidth || 360);
    const H = Math.max(120, root.clientHeight || 180);
    const L = 34, R = 4, T = 8, B = 20;
    root.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const shown = decisions.slice(-30);
    const slots = Math.max(20, shown.length);
    const latency = (d: Decision) => d.roundTripMs ?? (d.action || d.error ? 0 : now - d.startedAt);
    const peak = Math.max(400, ...shown.map(latency), ...shown.map((d) => d.budgetMs ?? 0));
    // Four round, evenly spaced ticks that just cover the data.
    const tickStep = [100, 150, 200, 250, 300, 400, 500, 750, 1000].find((s) => s * 4 >= peak) ?? Math.ceil(peak / 4000) * 1000;
    const max = tickStep * 4;
    const y = (ms: number) => T + (H - T - B) * (1 - Math.min(ms, max) / max);
    const step = (W - L - R) / slots;
    for (let tick = 0; tick <= max; tick += tickStep) {
      root.append(svg("line", { x1: L, x2: W - R, y1: y(tick), y2: y(tick), class: tick ? "grid" : "base" }));
      const text = svg("text", { x: L - 6, y: y(tick) + 3, class: "axis", "text-anchor": "end" });
      text.textContent = tick >= 1000 ? `${tick / 1000}s` : `${tick}`;
      root.append(text);
    }
    shown.forEach((d, i) => {
      const w = Math.max(2, Math.min(14, step * 0.56));
      const x = L + i * step + (step - w) / 2;
      const ms = latency(d);
      const state = d.error ? "bad" : !d.action ? "pending" : d.late || d.safe === false ? "bad" : "ok";
      root.append(svg("rect", { x, y: y(ms), width: w, height: Math.max(1, y(0) - y(ms)), rx: 2, class: `bar ${state}` }));
      if (d.budgetMs !== null && d.budgetMs !== undefined)
        root.append(svg("rect", { x: x - 3, y: y(d.budgetMs) - 2, width: w + 6, height: 4, rx: 2, class: "budget" }));
      if (i === 0 || i === shown.length - 1 || (shown.length > 10 ? d.index % 5 === 0 : true)) {
        const label = svg("text", { x: x + w / 2, y: H - 5, class: "axis", "text-anchor": "middle" });
        label.textContent = String(d.index);
        root.append(label);
      }
    });
    const empty = $("chart-empty");
    empty.hidden = meta.player !== "human" && decisions.length > 0;
    empty.textContent = meta.player === "human" ? "Switch to Jev or the rule bot to record decisions." : "Waiting for the first obstacle.";
  }

  function lastCall(decisions: Decision[], meta: Meta) {
    const d = [...decisions].reverse().find((x) => x.action || x.error);
    $("call").dataset.empty = String(meta.player !== "jev" || !d);
    if (meta.player !== "jev" || !d) {
      $("call-empty").textContent = meta.player === "jev" ? "No calls yet." : "Only Jev makes API calls.";
      return;
    }
    const state = obstacleState(d.kind).obstacle;
    $("call-index").textContent = `#${d.index}`;
    $("call-state").textContent = `${state.type} · ${state.size} · ${state.position}`;
    $("call-answer").textContent = d.error ? "error" : `${d.action} · confidence ${d.confidence.toFixed(2)}`;
    $("call-timing").textContent = d.error ? d.error : `${fmt(d.apiMs)} ms API · ${fmt(d.roundTripMs)} ms round trip`;
    $("call-model").textContent = d.model ?? meta.model;
    const tokensIn = decisions.reduce((sum, x) => sum + (x.inputTokens ?? 0), 0);
    const tokensOut = decisions.reduce((sum, x) => sum + (x.outputTokens ?? 0), 0);
    $("call-tokens").textContent = `${tokensIn.toLocaleString()} in · ${tokensOut.toLocaleString()} out`;
    // Rows are built once and updated in place, so each bar can transition
    // (transform only) from the previous answer to the new one.
    const dist = $("call-dist");
    if (!dist.childElementCount)
      for (const move of ["jump", "duck", "run"]) {
        const row = document.createElement("div");
        row.className = "dist-row";
        row.dataset.move = move;
        const name = document.createElement("span");
        name.textContent = move;
        const track = document.createElement("span");
        track.className = "dist-track";
        track.append(document.createElement("span"));
        row.append(name, track, document.createElement("span"));
        dist.append(row);
      }
    for (const row of dist.children as HTMLCollectionOf<HTMLElement>) {
      const p = d.probabilities?.[row.dataset.move] ?? 0;
      row.classList.toggle("chosen", row.dataset.move === d.action);
      // CSSOM, not a style attribute, so the page's CSP (style-src 'self') allows it.
      (row.querySelector(".dist-track span") as HTMLElement).style.transform = `scaleX(${p})`;
      row.lastElementChild.textContent = `${(p * 100).toFixed(0)}%`;
    }
  }

  function log(decisions: Decision[], meta: Meta) {
    const body = $("log-body");
    body.replaceChildren(
      ...decisions
        .slice(-50)
        .reverse()
        .map((d) => {
          const tr = document.createElement("tr");
          const margin = d.budgetMs !== null && d.budgetMs !== undefined && d.roundTripMs !== undefined ? d.budgetMs - d.roundTripMs : null;
          const [result, tone] = d.error
            ? ["error", "bad"]
            : !d.action
              ? ["waiting", "pending"]
              : d.safe === false
                ? ["unsafe move", "bad"]
                : d.late
                  ? ["late", "bad"]
                  : ["cleared", "ok"];
          const cells: [string, string?][] = [
            [String(d.index), "num dim"],
            [d.label],
            [d.action ?? "…", "mono"],
            [d.confidence === undefined ? "—" : d.confidence.toFixed(2), "num"],
            [meta.player === "jev" ? fmt(d.apiMs) : "—", "num"],
            [meta.player === "jev" ? fmt(d.roundTripMs) : "0", "num"],
            [d.budgetMs === null ? "none" : fmt(d.budgetMs), "num dim"],
            [margin === null ? "—" : `${margin >= 0 ? "+" : "−"}${Math.abs(Math.round(margin))}`, `num ${margin !== null && margin < 0 ? "neg" : ""}`],
          ];
          for (const [text, cls] of cells) {
            const td = document.createElement("td");
            td.textContent = text;
            if (cls) td.className = cls;
            tr.append(td);
          }
          const td = document.createElement("td");
          const tag = document.createElement("span");
          tag.className = `tag ${tone}`;
          tag.textContent = result;
          td.append(tag);
          tr.append(td);
          return tr;
        }),
    );
    $("log-empty").hidden = decisions.length > 0;
    $("log-count").textContent = decisions.length ? String(decisions.length) : "";
  }

  function update(decisions: Decision[], meta: Meta, now: number) {
    const pending = decisions.some((d) => !d.action && !d.error);
    const next = JSON.stringify([meta, decisions.length, decisions.map((d) => [d.action, d.late, d.error, d.roundTripMs])]);
    // Rebuild on change; while a call is in flight, redraw the chart so its
    // bar grows in real time.
    if (next !== signature) {
      signature = next;
      stats(decisions, meta);
      lastCall(decisions, meta);
      log(decisions, meta);
      chart(decisions, meta, now);
      $("mode-note").textContent =
        meta.player === "jev"
          ? meta.mode === "paused"
            ? "Paused: the game waits for each answer. Ticks show what real time would allow."
            : "Real time: a bar above its tick arrived after the move had to start."
          : meta.player === "rule"
            ? "Rule bot: instant lookup, no API calls."
            : "Human play: no decisions recorded.";
    } else if (pending) chart(decisions, meta, now);
  }

  return { update, reset: () => (signature = "") };
}
