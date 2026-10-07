// Turn a raw run (runs/<run id>.jsonl) into the committed results:
//
//   results/requests.jsonl   one row per request, with the model's answer
//   results/summary.json     per-layout aggregates used by the article
//   results/report.md        the same aggregates as Markdown tables
//
//   node experiment/analyze.js              uses the newest run
//   node experiment/analyze.js r20261007ab12

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LAYOUTS, EXPLICIT } from "./layouts.js";
import { getModel } from "../src/providers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, "runs");
const RESULTS = join(ROOT, "results");
// Gemini 3.8 Flash output price, USD per million tokens (thinking tokens are billed as output).
const OUTPUT_PRICE = 3.75;
const STORAGE_PRICE = 0.5; // per million tokens per hour, explicit caches

function newestRun() {
  const files = readdirSync(RUNS).filter((f) => f.endsWith(".jsonl"));
  if (!files.length) throw new Error("No runs found in runs/. Run `npm run experiment -- --live` first.");
  return files.sort((a, b) => statSync(join(RUNS, b)).mtimeMs - statSync(join(RUNS, a)).mtimeMs)[0].replace(".jsonl", "");
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (x, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

// Rebuild a layout's first request to learn the length of the rendered prefix in
// characters. Builds are deterministic apart from timestamps, which keep their length.
function promptChars(layout, runId) {
  const ctx = { runId, layout: layout.id, now: () => new Date().toISOString() };
  const req = layout.id === "explicit" ? { ...layout.cache(ctx), ...layout.build(ctx, 0) } : layout.build(ctx, 0);
  return JSON.stringify({ tools: [{ functionDeclarations: req.tools }], system: { parts: [{ text: req.system }] } }).length + req.user.length;
}

function main() {
  const runId = process.argv[2] || newestRun();
  const rows = readFileSync(join(RUNS, `${runId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const meta = rows.find((r) => r.type === "run");
  const requests = rows.filter((r) => r.type === "request");
  const errors = rows.filter((r) => r.type === "error");
  const cacheRow = rows.find((r) => r.type === "cache");
  const cacheDeleted = rows.find((r) => r.type === "cache-deleted");
  const model = getModel(meta.settings.model);

  const layouts = [...LAYOUTS, EXPLICIT].filter((l) => meta.layouts.includes(l.id)).map((layout) => {
    const rs = requests.filter((r) => r.layout === layout.id);
    const prompt = sum(rs.map((r) => r.promptTokens));
    const cached = sum(rs.map((r) => r.cachedTokens));
    const output = sum(rs.map((r) => r.outputTokens + r.thoughtTokens));
    const cost = ((prompt - cached) * model.input + cached * model.read + output * OUTPUT_PRICE) / 1e6;
    const chars = promptChars(layout, runId);
    const tokensPerChar = median(rs.map((r) => r.promptTokens)) / chars;
    // Where request n first differs from request n-1, in characters of the rendered prompt.
    const diffs = rs.filter((r) => r.i > 0).map((r) => r.firstDiffChars);
    const reusableChars = median(diffs);
    const out = {
      id: layout.id,
      title: layout.title,
      description: layout.description,
      requests: rs.length,
      errors: errors.filter((e) => e.layout === layout.id).length,
      hits: rs.filter((r) => r.cachedTokens > 0).length,
      promptTokensMedian: median(rs.map((r) => r.promptTokens)),
      cachedTokensMedian: median(rs.map((r) => r.cachedTokens)),
      cachedShare: prompt ? round(cached / prompt, 4) : 0,
      // The longest prefix two consecutive requests share: the most any prefix cache could reuse.
      reusablePrefixChars: reusableChars,
      reusablePrefixTokens: reusableChars === null ? null : Math.round(reusableChars * tokensPerChar),
      reusableShare: reusableChars === null ? null : round(reusableChars / chars, 4),
      firstTokenMsMedian: median(rs.map((r) => r.firstTokenMs)),
      firstTokenMsMin: Math.min(...rs.map((r) => r.firstTokenMs ?? Infinity)),
      firstTokenMsMax: Math.max(...rs.map((r) => r.firstTokenMs ?? 0)),
      totalMsMedian: median(rs.map((r) => r.totalMs)),
      costUsd: round(cost, 6),
      costPerRequestUsd: rs.length ? round(cost / rs.length, 6) : null,
    };
    if (layout.id === "explicit" && cacheRow) {
      const hours = (new Date(cacheDeleted?.at ?? rs.at(-1)?.at).getTime() - new Date(cacheRow.createdAt).getTime()) / 3.6e6;
      const tokens = cacheRow.usage?.totalTokenCount ?? out.cachedTokensMedian;
      out.cache = {
        tokens,
        createMs: cacheRow.createMs,
        aliveMinutes: round(hours * 60, 1),
        storageUsd: round((tokens * hours * STORAGE_PRICE) / 1e6, 6),
      };
      out.costUsd = round(out.costUsd + out.cache.storageUsd, 6);
      // Requests only send the question; the reusable part is the stored cache.
      out.reusablePrefixTokens = tokens;
      out.reusablePrefixChars = null;
      out.reusableShare = out.cachedShare;
      out.costPerRequestUsd = round(out.costUsd / rs.length, 6);
    }
    return out;
  });

  // What one request's input would cost at each layout's reusable prefix, if the
  // provider cached it every time. A projection from the measured prefix, not a measurement.
  for (const l of layouts) {
    const p = l.promptTokensMedian;
    const r = l.reusablePrefixTokens ?? 0;
    const reusable = r >= model.minTokens ? r : 0;
    l.projectedInputUsdPer1k = round(((p - reusable) * model.input + reusable * model.read) * 1000 / 1e6, 4);
    l.fullInputUsdPer1k = round((p * model.input * 1000) / 1e6, 4);
  }

  const summary = {
    runId,
    date: meta.startedAt.slice(0, 10),
    startedAt: meta.startedAt,
    finishedAt: rows.find((r) => r.type === "done")?.at ?? null,
    model: meta.settings.model,
    settings: meta.settings,
    prices: { input: model.input, cachedInput: model.read, output: OUTPUT_PRICE, storagePerHour: STORAGE_PRICE, minTokens: model.minTokens },
    totals: {
      requests: requests.length,
      errors: errors.length,
      implicitEligible: requests.filter((r) => r.layout !== "explicit" && r.promptTokens >= model.minTokens).length,
      implicitHits: requests.filter((r) => r.layout !== "explicit" && r.cachedTokens > 0).length,
      costUsd: round(sum(layouts.map((l) => l.costUsd)), 4),
    },
    layouts,
  };

  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    join(RESULTS, "requests.jsonl"),
    requests.map((r) => JSON.stringify({ ...r, i: r.i + 1 })).join("\n") + "\n",
  );
  writeFileSync(join(RESULTS, "report.md"), report(summary));
  console.log(`Wrote results for ${runId}: ${requests.length} requests, ${errors.length} errors, $${summary.totals.costUsd}.`);
}

function report(s) {
  const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const lines = [
    `# Prompt caching experiment: ${s.model}, ${s.date}`,
    "",
    `Run \`${s.runId}\`: ${s.totals.requests} requests (${s.settings.requests} per layout, ${s.settings.pauseMs} ms apart, one at a time), ${s.totals.errors} errors, total cost about $${s.totals.costUsd}.`,
    `Prices used (USD per million tokens): input $${s.prices.input}, cached input $${s.prices.cachedInput}, output $${s.prices.output}, explicit cache storage $${s.prices.storagePerHour} per hour. Minimum cacheable prompt: ${s.prices.minTokens.toLocaleString()} tokens.`,
    "",
    `Implicit caching: ${s.totals.implicitHits} hits in ${s.totals.implicitEligible} eligible requests.`,
    "",
    "| Layout | Requests | Prompt tokens (median) | Requests with a cache hit | Cached share of prompt | Reusable prefix (tokens) | Reusable share | First token, median (ms) | Cost per request |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...s.layouts.map(
      (l) =>
        `| ${l.title} | ${l.requests} | ${l.promptTokensMedian} | ${l.hits} | ${pct(l.cachedShare)} | ${l.reusablePrefixTokens ?? "n/a"} | ${pct(l.reusableShare)} | ${l.firstTokenMsMedian} | $${l.costPerRequestUsd?.toFixed(5)} |`,
    ),
    "",
    "Reusable prefix: the median length, in tokens, of the prefix that consecutive requests shared byte for byte, with the request rendered as tools, then system instruction, then user message. It's the most a prefix cache could reuse, whatever the provider does. For the explicit cache, it's the size of the stored cache.",
    "",
    "Projected input cost per 1,000 requests if the reusable prefix were always served from cache (a projection, not a measurement):",
    "",
    "| Layout | Without cache | Reusable prefix cached |",
    "|---|---:|---:|",
    ...s.layouts.map((l) => `| ${l.title} | $${l.fullInputUsdPer1k} | $${l.projectedInputUsdPer1k} |`),
    "",
  ];
  const ex = s.layouts.find((l) => l.cache);
  if (ex) {
    lines.push(
      `Explicit cache: ${ex.cache.tokens} tokens, created in ${ex.cache.createMs} ms, alive ${ex.cache.aliveMinutes} minutes, storage about $${ex.cache.storageUsd}.`,
      "",
    );
  }
  return lines.join("\n");
}

main();
