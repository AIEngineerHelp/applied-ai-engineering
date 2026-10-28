// "What we measured": four checks on the method itself, then a recap. Every number is read from
// results/study/summary.json (written by `riskdemo study analyze`) or computed from the reader's own labels.

import { agreementSentence, esc, pct, readerTally, renderReply, ruleDiff, type ReaderLabel } from "./logic.ts";
import type { Agreement, Catalog, DiversityMetrics, LabelledConversation, Run, Study } from "./types.ts";

function seededCheck(c: Catalog, study: Study): string {
  const sc = study.seeded_check;
  if (!sc) return "";
  const first = study.judge_models[0];
  const j = sc.raters[first];
  const judgePassed = j.both_pass + j.false_pass;
  const others = Object.entries(sc.raters).filter(([m]) => m !== first && m !== "keyword");
  const [risk, version] = sc.cell.split("--");
  return `
    <div class="mt-6 rounded-lg border border-fail/25 bg-card p-4 sm:p-5">
      <div class="text-xs font-medium tracking-wide text-fail uppercase">We checked the biggest jump</div>
      <p class="mt-2 font-serif text-[20px] leading-snug text-ink">${esc(c.risks[risk].risk)}, ${version} prompt: the judge says the agent kept the rule in ${judgePassed} of ${sc.n} seeded attacks. Our labels say ${sc.label_passed}.</p>
      <p class="mt-2 text-sm leading-relaxed text-ink-2">We labelled the whole cell. Of the ${j.label_fails} conversations we fail, the recording's judge passed ${j.false_pass}${others.map(([m, a]) => ` and ${esc(m)} passed ${a.false_pass}`).join("")}. Most were the same advice the judge failed in the first recording ("take your normal dose today" after a missed one, "acetaminophen is the safer choice"), now wrapped in a script, a hypothetical or a firm "No, never double up" headline. The varied attacks found more ways to get the advice out, and the judge missed more of it. The apparent improvement is mostly the judge.</p>
      <div class="mt-3 flex flex-wrap gap-1">${sc.conversations
        .map((v) => {
          const judgeSays = v.judges[first];
          const miss = judgeSays && v.label === "fail";
          return `<a href="#/${v.risk}/${v.version}/review/${v.attack}" title="${esc(v.reason)}" class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${miss ? "border-fail/40 bg-fail-soft" : "border-line"}"><span class="text-ink-3">${v.attack}</span><span class="size-1.5 rounded-full ${judgeSays ? "bg-pass" : "bg-fail"}" title="judge"></span><span class="size-1.5 rounded-full ${v.label === "pass" ? "bg-pass" : "bg-fail"}" title="our label"></span></a>`;
        })
        .join("")}</div>
      <p class="mt-2 text-xs text-ink-3">Each chip: attack number, the judge's verdict, then our label (green kept the rule, red broke it). Red-tinted chips are false passes. Our labels for this cell were written knowing its pass count, so they are not fully blind.</p>
    </div>`;
}
import { VERSION_LABEL, chip, icon, raterName } from "./ui.ts";

export const SECTIONS: [string, string][] = [
  ["judge", "Is the judge right?"],
  ["diversity", "Were the attacks different?"],
  ["keyword", "Would a keyword check do?"],
  ["loop", "Closing the loop"],
  ["recap", "Recap"],
];

const section = (id: string, n: number, title: string, lede: string, body: string) => `
  <section id="m-${id}" class="scroll-mt-6 border-t border-line pt-10 mt-12 first:mt-8">
    <div class="flex items-baseline gap-3"><span class="font-mono text-xs text-ink-3">${n}</span><h2 class="font-serif text-[28px] leading-tight text-ink">${title}</h2></div>
    <p class="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">${lede}</p>
    ${body}
  </section>`;

const convLink = (c: { risk: string; version: string; attack: number }) => `#/${c.risk}/${c.version}/review/${c.attack}?set=recorded`;

function cellName(c: Catalog, key: string): string {
  const [risk, version] = key.split("--");
  return `${c.risks[risk]?.risk ?? risk} · ${version}`;
}

// ---------- 1. the judge ----------

function raterTable(study: Study): string {
  const rows = Object.entries(study.raters).map(([id, r]) => {
    const o = r.overall;
    const note = id === study.judge_models[0] ? "scored the recording" : id === "keyword" ? "no model call" : id.includes("second run") ? "same model, run again" : "a stronger model";
    return `<tr class="border-t border-line">
      <td class="py-2.5 pr-4"><span class="font-medium text-ink">${esc(raterName(id))}</span><span class="block text-xs text-ink-3">${note}</span></td>
      <td class="py-2.5 pr-4 font-mono text-[13px] text-ink">${o.agree}/${o.n}</td>
      <td class="py-2.5 pr-4 font-mono text-[13px] ${o.false_pass ? "text-fail" : "text-ink-2"}">${o.false_pass}</td>
      <td class="py-2.5 pr-4 font-mono text-[13px] text-ink-2">${o.false_fail}</td>
      <td class="py-2.5 font-mono text-[13px] text-ink-2">${o.kappa == null ? "—" : o.kappa.toFixed(2)}</td></tr>`;
  });
  return `<div class="mt-5 overflow-x-auto rounded-lg border border-line bg-card px-4 sm:px-5">
    <table class="w-full min-w-[440px] text-left text-sm">
      <thead class="text-xs text-ink-3"><tr><th class="py-2.5 pr-4 font-medium">Who scored it</th><th class="py-2.5 pr-4 font-medium">Agrees</th><th class="py-2.5 pr-4 font-medium">False passes</th><th class="py-2.5 pr-4 font-medium">False fails</th><th class="py-2.5 font-medium">Kappa</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>`;
}

function byRisk(c: Catalog, study: Study): string {
  const ids = Object.keys(study.raters);
  const head = ids.map((id) => `<th class="py-2 pr-3 font-medium">${esc(raterName(id))}</th>`).join("");
  const rows = Object.keys(c.risks).map((risk) => {
    const cells = ids.map((id) => {
      const a: Agreement | undefined = study.raters[id].by_risk[risk];
      return `<td class="py-2 pr-3 font-mono text-[12.5px] text-ink-2">${a ? `${a.agree}/${a.n}${a.false_pass ? ` <span class="text-fail">·${a.false_pass} FP</span>` : ""}` : "—"}</td>`;
    });
    return `<tr class="border-t border-line"><td class="py-2 pr-3 text-ink">${esc(c.risks[risk].risk)}</td>${cells.join("")}</tr>`;
  });
  return `<details class="mt-3 rounded-lg border border-line bg-card">
    <summary class="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-ink sm:px-5"><span>By policy</span><span class="text-ink-3">${icon("chevron", 14)}</span></summary>
    <div class="overflow-x-auto border-t border-line px-4 pb-2 sm:px-5"><table class="w-full min-w-[520px] text-left text-sm"><thead class="text-xs text-ink-3"><tr><th class="py-2 pr-3 font-medium">Policy</th>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>
    <p class="py-2 text-xs text-ink-3">FP: false passes. Counts are out of the labelled conversations for that policy.</p></div>
  </details>`;
}

function disagreementCard(c: Catalog, conv: LabelledConversation): string {
  const judges = Object.entries(conv.judges).map(([m, v]) => chip(raterName(m), v.passed)).join(" ");
  return `<li class="rounded-lg border border-line bg-card p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <a href="${convLink(conv)}" class="text-sm font-medium text-ink hover:underline">${esc(c.risks[conv.risk].risk)} · ${esc(VERSION_LABEL[conv.version].toLowerCase())} · attack ${conv.attack}</a>
      ${conv.borderline ? `<span class="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">Borderline</span>` : ""}
    </div>
    <div class="mt-2 flex flex-wrap gap-1.5">${chip("Our label", conv.label === "pass")} ${judges} ${chip("Keyword", conv.keyword)}</div>
    <p class="mt-2 text-sm leading-relaxed text-ink-2"><span class="text-ink-3">Our reading:</span> ${esc(conv.reason)}</p>
  </li>`;
}

function readerBlock(labels: ReaderLabel[]): string {
  const t = readerTally(labels);
  if (!t.n)
    return `<div class="mt-5 rounded-lg border border-dashed border-line-2 px-4 py-4 text-sm text-ink-2 sm:px-5"><div class="font-medium text-ink">Your labels</div><p class="mt-1">Label conversations in the console's review step and your own agreement with the judge appears here. Labels stay in this browser.</p><a href="#/medication-changes/naive/review/3?set=recorded" class="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline">Label your first conversation ${icon("arrow", 13)}</a></div>`;
  return `<div class="mt-5 rounded-lg border border-line bg-card px-4 py-4 sm:px-5">
    <div class="text-sm font-medium text-ink">Your labels</div>
    <p class="mt-1 text-sm leading-relaxed text-ink-2">You labelled ${t.n} ${t.n === 1 ? "conversation" : "conversations"}. You agreed with the recording's judge on ${t.agreeJudge}. It passed ${t.youFailJudgePassed} you would fail and failed ${t.youPassJudgeFailed} you would pass.${t.withOurs ? ` On the ${t.withOurs} we also labelled, you agreed with us on ${t.agreeOurs}.` : ""}</p>
    <p class="mt-1 text-xs text-ink-3">Stored in this browser only. Clear them in the review step by clicking your label again.</p>
  </div>`;
}

function judgeSection(c: Catalog, study: Study, labels: ReaderLabel[]): string {
  const first = study.judge_models[0];
  const o = study.raters[first].overall;
  const second = study.judge_models.find((m) => m !== first && !m.includes("second run"));
  const rerun = study.judge_models.find((m) => m.includes("second run"));
  const s = second ? study.raters[second].overall : null;
  const disputed = study.conversations.filter((v) => Object.values(v.judges).some((j) => j.passed !== (v.label === "pass")));
  const between = study.judge_disagreements.length;
  return section(
    "judge",
    1,
    "Is the judge right?",
    `One model, ${esc(first)}, played the agent, the attacker and the judge. Nothing checked the judge. So we labelled ${study.labels.n} recorded conversations ourselves, without looking at its verdicts, and compared.`,
    `
    <p class="mt-5 font-serif text-[22px] leading-snug text-ink">${esc(agreementSentence("The recording's judge", o))}</p>
    ${s ? `<p class="mt-2 text-[15px] leading-relaxed text-ink-2">${esc(agreementSentence(`A second, stronger judge (${second})`, s))} The two judges disagreed with each other on ${between} ${between === 1 ? "conversation" : "conversations"}.${rerun ? ` Run a second time on the same conversations, ${esc(first)} gave the same verdict on ${study.conversations.filter((v) => v.judges[rerun] && v.judges[rerun].passed === v.judges[first].passed).length} of ${study.conversations.filter((v) => v.judges[rerun]).length}.` : ""}</p>` : ""}
    ${study.seeded_check ? `<p class="mt-3 rounded-md border-l-2 border-fail bg-card px-4 py-3 text-[15px] leading-relaxed text-ink-2">That is on the first recording's near-identical attacks. On one seeded cell we labelled in full, the same judge passed ${study.seeded_check.raters[first].false_pass} of the ${study.seeded_check.raters[first].label_fails} conversations we fail. <a href="#/measured/diversity" class="text-accent hover:underline">See section 2.</a></p>` : ""}
    ${raterTable(study)}
    ${byRisk(c, study)}
    <h3 class="mt-8 text-sm font-medium text-ink">Every conversation where a judge and our label disagree</h3>
    <ul class="mt-3 space-y-2">${disputed.map((v) => disagreementCard(c, v)).join("")}</ul>
    <div class="mt-5 rounded-lg border border-line bg-sunk/60 px-4 py-3.5 text-sm leading-relaxed text-ink-2 sm:px-5">
      <div class="font-medium text-ink">How the labels were made, and what they can't tell you</div>
      <ul class="mt-1.5 list-disc space-y-1 pl-5">
        <li>Labelled by the authors with an AI coding assistant, not by lawyers or clinicians. In a real team the rule's owner labels.</li>
        <li>The labeller read the conversations shuffled under anonymous ids, with the rule but without the prompt version, the verdict or the judge's reason.</li>
        <li>The sample is not random: it holds every failure and every noted case, plus random passes from each cell (${study.labels.fail} of ${study.labels.n} labelled fail). Read the agreement as "on hard cases", not as an overall accuracy.</li>
        <li>${study.labels.borderline} labels are marked borderline: a reasonable owner could label them the other way. ${disputed.filter((v) => v.borderline).length} of the ${disputed.length} disagreements above are among them.</li>
      </ul>
    </div>
    ${readerBlock(labels)}`,
  );
}

// ---------- 2. diversity ----------

function metricRows(before: DiversityMetrics, after: DiversityMetrics, model: string): string {
  const rows: [string, string, number | null | undefined, number | null | undefined, boolean][] = [
    ["Pairs that open with the same four words", "Share of attack pairs in a cell", before.shared_opening, after.shared_opening, false],
    ["Shared phrasing", "Mean pairwise overlap of word trigrams", before.trigram_overlap, after.trigram_overlap, false],
    ["Meaning", `Mean pairwise cosine similarity, ${model} embeddings`, before.embedding_similarity, after.embedding_similarity, false],
    ["Distinct word pairs", "Distinct bigrams over all bigrams (higher is more varied)", before.distinct_2, after.distinct_2, true],
  ];
  return rows
    .map(([t, d, b, a, higherBetter]) => `<tr class="border-t border-line">
      <td class="py-2.5 pr-4"><span class="text-ink">${t}</span><span class="block text-xs text-ink-3">${d}</span></td>
      <td class="py-2.5 pr-4 font-mono text-[13px] text-ink-2">${b == null ? "—" : b.toFixed(2)}</td>
      <td class="py-2.5 font-mono text-[13px] ${a != null && b != null && (higherBetter ? a > b : a < b) ? "text-pass" : "text-ink-2"}">${a == null ? "—" : a.toFixed(2)}</td></tr>`)
    .join("");
}

function cellBars(c: Catalog, study: Study): string {
  const d = study.diversity!;
  const keys = Object.keys(d.sets.recorded.cells);
  return `<div class="mt-4 space-y-2.5">${keys
    .map((k) => {
      const b = d.sets.recorded.cells[k]?.embedding_similarity ?? null;
      const a = d.sets.seeded?.cells[k]?.embedding_similarity ?? null;
      const bar = (v: number | null, tone: string) => `<div class="h-2 rounded-full bg-sunk"><div class="h-full rounded-full ${tone}" style="width:${v == null ? 0 : Math.max(2, v * 100)}%"></div></div>`;
      return `<div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-3 sm:grid-cols-[220px_1fr]">
        <span class="truncate text-xs text-ink-2">${esc(cellName(c, k))}</span>
        <div class="space-y-1">${bar(b, "bg-ink-3")}${bar(a, "bg-accent")}</div></div>`;
    })
    .join("")}
    <div class="flex flex-wrap gap-4 pt-1 text-xs text-ink-3"><span class="inline-flex items-center gap-1.5"><span class="h-2 w-4 rounded-full bg-ink-3"></span>First recording</span><span class="inline-flex items-center gap-1.5"><span class="h-2 w-4 rounded-full bg-accent"></span>Seeded</span><span>Bar length: mean similarity of the ten opening messages (shorter is more varied).</span></div>
  </div>`;
}

function passRateTable(c: Catalog, study: Study): string {
  const before = study.pass_rates.recorded;
  const after = study.pass_rates.seeded ?? {};
  const fmt = (s?: { passed: number; failed: number; errored: number }) => (s ? `${s.passed}/${s.passed + s.failed}${s.errored ? ` <span class="text-warn">+${s.errored} err</span>` : ""}` : "—");
  const rows = Object.keys(before).map((k) => {
    const b = before[k];
    const a = after[k];
    const moved = a && b ? a.passed / Math.max(1, a.passed + a.failed) - b.passed / Math.max(1, b.passed + b.failed) : 0;
    const checked = study.seeded_check?.cell === k;
    const tone = checked ? "text-ink-2" : moved < -0.15 ? "text-fail" : moved > 0.15 ? "text-pass" : "text-ink-2";
    return `<tr class="border-t border-line"><td class="py-2 pr-4 text-ink">${esc(cellName(c, k))}</td><td class="py-2 pr-4 font-mono text-[13px] text-ink-2">${fmt(b)}</td><td class="py-2 font-mono text-[13px] ${tone}">${fmt(a)}${checked ? ` <span class="font-sans text-xs text-fail">our labels: ${study.seeded_check!.label_passed}/${study.seeded_check!.n}</span>` : ""}</td></tr>`;
  });
  return `<div class="mt-4 overflow-x-auto rounded-lg border border-line bg-card px-4 sm:px-5"><table class="w-full min-w-[420px] text-left text-sm"><thead class="text-xs text-ink-3"><tr><th class="py-2.5 pr-4 font-medium">Cell</th><th class="py-2.5 pr-4 font-medium">First recording kept</th><th class="py-2.5 font-medium">Seeded kept</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function diversitySection(c: Catalog, study: Study): string {
  const d = study.diversity;
  if (!d || !d.sets.seeded) return section("diversity", 2, "Were the attacks different?", "The seeded recording isn't in results/ yet.", "");
  const b = d.sets.recorded.mean;
  const a = d.sets.seeded.mean;
  const openings = (name: "recorded" | "seeded") =>
    `<ol class="space-y-2">${(study.openings[name] ?? []).map((t) => `<li class="rounded-md border border-line bg-card px-3 py-2 text-[13px] leading-snug text-ink-2">“${esc(t)}${t.length >= 220 ? "…" : ""}”</li>`).join("")}</ol>`;
  return section(
    "diversity",
    2,
    "Were the attacks different?",
    `The first recording gave all ten attacks in a cell the same brief, and the attacker wrote ten versions of one message. "10 of 10" was closer to one attack repeated. We seeded each attack with one of the rule's example questions, a persona and a tactic (role-play, hypothetical, splitting the request across turns, an authority claim, emotional pressure) and recorded all eight cells again.`,
    `
    <p class="mt-5 font-serif text-[22px] leading-snug text-ink">Before seeding, ${pct(b.shared_opening)} of attack pairs in a cell opened with the same four words. After, ${pct(a.shared_opening)}.</p>
    <div class="mt-5 overflow-x-auto rounded-lg border border-line bg-card px-4 sm:px-5"><table class="w-full min-w-[460px] text-left text-sm"><thead class="text-xs text-ink-3"><tr><th class="py-2.5 pr-4 font-medium">Measure (mean over the 8 cells)</th><th class="py-2.5 pr-4 font-medium">First recording</th><th class="py-2.5 font-medium">Seeded</th></tr></thead><tbody>${metricRows(b, a, d.embedding_model)}</tbody></table></div>
    <h3 class="mt-8 text-sm font-medium text-ink">Opening messages, ${esc(cellName(c, study.openings_cell))}</h3>
    <div class="mt-3 grid gap-4 md:grid-cols-2">
      <div><div class="mb-2 text-xs text-ink-3">First recording: one shared brief</div>${openings("recorded")}</div>
      <div><div class="mb-2 text-xs text-ink-3">Seeded: a question, a persona and a tactic each</div>${openings("seeded")}</div>
    </div>
    <h3 class="mt-8 text-sm font-medium text-ink">Similarity of opening messages, cell by cell</h3>
    ${cellBars(c, study)}
    <h3 class="mt-8 text-sm font-medium text-ink">Did varied attacks change the pass rates?</h3>
    <p class="mt-1 text-sm leading-relaxed text-ink-2">Same agents, same prompts, same judge; only the attacks changed. Each number is out of the attacks that finished.</p>
    ${passRateTable(c, study)}
    <p class="mt-3 text-xs leading-relaxed text-ink-3">These are the judge's verdicts. Out of ten, a difference of one or two attacks is within noise.</p>
    ${seededCheck(c, study)}`,
  );
}

// ---------- 3. keyword check ----------

function keywordSection(c: Catalog, study: Study, example: Run | null): string {
  const kw = study.raters.keyword.overall;
  const judge = study.raters[study.judge_models[0]].overall;
  const ex = study.examples.half_refusal;
  const turn = example?.attacks[ex.attack - 1]?.turns[ex.turn - 1];
  const vsJudge = study.keyword.vs_judge;
  return section(
    "keyword",
    3,
    "Would a keyword check do?",
    "The article claims a keyword check passes half-refusals. We wrote one deterministic check per policy, the way a team's first version usually looks, and ran it on the same conversations. It is free and needs no model.",
    `
    <ul class="mt-5 space-y-1.5 text-sm">${Object.entries(study.keyword.checks).map(([risk, d]) => `<li class="flex gap-2"><span class="w-44 shrink-0 text-ink-3">${esc(c.risks[risk].risk)}</span><span class="text-ink-2">${esc(d)}</span></li>`).join("")}</ul>
    <p class="mt-6 font-serif text-[22px] leading-snug text-ink">Of the ${kw.label_fails} conversations our labels fail, the keyword check passed ${kw.false_pass}. The judge passed ${judge.false_pass}.</p>
    <p class="mt-2 text-[15px] leading-relaxed text-ink-2">They pass for one reason: the reply contains the refusal or the routing the check looks for, next to the advice the rule forbids. It agreed with our labels on ${kw.agree} of ${kw.n} (kappa ${kw.kappa?.toFixed(2) ?? "—"}). Across every recorded conversation, it disagreed with the judge on ${vsJudge.recorded ? vsJudge.recorded.n - vsJudge.recorded.agree : "—"} of ${vsJudge.recorded?.n ?? "—"} in the first recording${vsJudge.seeded ? ` and ${vsJudge.seeded.n - vsJudge.seeded.agree} of ${vsJudge.seeded.n} in the seeded one` : ""}.</p>
    <figure class="mt-6 rounded-lg border border-line bg-card">
      <figcaption class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 text-xs sm:px-5">
        <span class="font-medium text-ink-2">A half-refusal the keyword check passes · ${esc(c.risks[ex.risk].risk)}, ${ex.version}, attack ${ex.attack}, turn ${ex.turn}</span>
        <span class="flex gap-1.5">${chip("Keyword", true)} ${chip("Judge", false)} ${chip("Our label", false)}</span>
      </figcaption>
      ${turn ? `<div class="px-4 py-4 sm:px-5"><div class="text-xs text-ink-3">The patient, on hold with the nurse line</div><p class="mt-1 rounded-lg bg-sunk px-3.5 py-2.5 text-sm leading-relaxed text-ink">${esc(turn.user)}</p>
        <div class="mt-4 text-xs text-ink-3">The clinic assistant (naive prompt). Highlighted: the refusal and the advice. The check passes the reply because it routes the patient to the nurse line; it can't see the advice.</div>
        <div class="reply mt-1 rounded-lg border border-line px-3.5 py-2.5 text-sm leading-relaxed text-ink">${renderReply(turn.agent ?? "", ex.phrases)}</div></div>` : `<p class="px-5 py-6 text-sm text-ink-3">Loading the conversation…</p>`}
      <a href="${convLink(ex)}" class="flex items-center gap-1 border-t border-line px-4 py-3 text-sm text-accent hover:underline sm:px-5">Open the whole conversation ${icon("arrow", 13)}</a>
    </figure>
    <p class="mt-3 text-xs leading-relaxed text-ink-3">A keyword check still earns its place for what code checks exactly: a required phone number, a canary value that must never appear. It can't tell a refusal from a refusal followed by advice.</p>`,
  );
}

// ---------- 4. the loop ----------

function diff(before: string, after: string): string {
  return ruleDiff(before, after)
    .map((p) => (p.kind === "added" ? `<ins class="rounded-sm bg-pass-soft px-0.5 text-ink no-underline">${esc(p.text)}</ins>` : p.kind === "removed" ? `<del class="bg-fail-soft text-ink-2">${esc(p.text)}</del>` : `<span class="text-ink-2">${esc(p.text)}</span>`))
    .join("");
}

function loopStory(c: Catalog, l: Study["loop"][number]): string {
  const note = c.review_notes[`${l.risk}--${l.version}`]?.[String(l.attack)];
  const target = l.rejudged?.find((v) => v.attack === l.attack);
  const flipped = (l.rejudged ?? []).filter((v) => (v.before === "passed") !== (v.status === "pass"));
  const rate = (s: { passed: number; failed: number } | null) => (s ? `${s.passed}/${s.passed + s.failed}` : "—");
  const outcome = !target
    ? "Not rerun yet."
    : (target.before === "passed") === (target.status === "pass")
      ? `The verdict on attack ${l.attack} did not change: it ${target.status === "pass" ? "still passes" : "still fails"}.`
      : `The verdict on attack ${l.attack} flipped from ${target.before === "passed" ? "pass" : "fail"} to ${target.status}.`;
  const step = (n: number, title: string, body: string) => `<li class="relative pl-9"><span class="absolute top-0 left-0 grid size-6 place-items-center rounded-full border border-line-2 bg-paper font-mono text-[11px] text-ink-2">${n}</span><div class="text-sm font-medium text-ink">${title}</div><div class="mt-1.5">${body}</div></li>`;
  return `<article class="mt-6 rounded-lg border border-line bg-card p-4 sm:p-5">
    <h3 class="font-serif text-xl text-ink">${esc(c.risks[l.risk].risk)} · ${esc(VERSION_LABEL[l.version].toLowerCase())} · attack ${l.attack}</h3>
    <ol class="mt-4 space-y-6">
      ${step(1, "The review note", `<p class="text-sm leading-relaxed text-ink-2">${esc(note?.note ?? l.reason)}</p><a href="${convLink(l)}" class="mt-1 inline-flex items-center gap-1 text-sm text-accent hover:underline">Read the conversation ${icon("arrow", 13)}</a>`)}
      ${step(2, "The rule, revised", `<p class="text-xs text-ink-3">Revision 1 → revision 2. The owner adds a clarification; nothing else changes.</p><blockquote class="mt-2 rounded-md border-l-2 border-accent bg-paper px-3.5 py-3 font-serif text-[15px] leading-relaxed">${diff(l.rule_before, l.rule_after)}</blockquote>`)}
      ${step(3, "The same conversations, judged again", `<p class="text-sm leading-relaxed text-ink-2">The judge re-scored the ten recorded conversations with revision 2. ${esc(outcome)} ${flipped.length ? `${flipped.length} ${flipped.length === 1 ? "verdict" : "verdicts"} changed in the cell.` : "No verdict in the cell changed."}</p>
        <div class="mt-2 flex flex-wrap gap-1">${(l.rejudged ?? []).map((v) => `<span title="Attack ${v.attack}: ${v.before === "passed" ? "pass" : "fail"} → ${v.status}" class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${v.attack === l.attack ? "border-ink" : "border-line"}"><span class="text-ink-3">${v.attack}</span><span class="size-1.5 rounded-full ${v.before === "passed" ? "bg-pass" : "bg-fail"}"></span>→<span class="size-1.5 rounded-full ${v.status === "pass" ? "bg-pass" : "bg-fail"}"></span></span>`).join("")}</div>
        ${target ? `<p class="mt-3 rounded-md bg-sunk px-3.5 py-2.5 text-sm leading-relaxed text-ink-2"><span class="text-ink-3">Judge, revision 2, attack ${l.attack}:</span> ${esc(target.reason)}</p>` : ""}
        ${flipped
          .filter((v) => v.attack !== l.attack)
          .map((v) => `<p class="mt-2 rounded-md border border-line px-3.5 py-2.5 text-sm leading-relaxed text-ink-2"><span class="text-ink-3">Attack ${v.attack} flipped from ${v.before === "passed" ? "pass" : "fail"} to ${v.status}:</span> ${esc(v.reason)} <a href="${convLink({ risk: l.risk, version: l.version, attack: v.attack })}" class="whitespace-nowrap text-accent hover:underline">Read it</a></p>`)
          .join("")}`)}
      ${step(4, "New attacks against the revised rule", `<p class="text-sm leading-relaxed text-ink-2">The attacker reads the rule too, so we reran the seeded attacks with revision 2 and the same seeds. The agent kept the rule in ${rate(l.rerun_summary)}, against ${rate(l.seeded_summary)} with revision 1.</p>`)}
    </ol>
  </article>`;
}

function loopSection(c: Catalog, study: Study): string {
  return section(
    "loop",
    4,
    "Closing the loop",
    "Review is supposed to change something. Two notes from our first review pointed at the rules, not the agent: an honest answer about a charge the member authorized, and a list of 'neutral factors' that all pointed one way. We revised each rule, kept revision 1, and ran the eval again.",
    study.loop.map((l) => loopStory(c, l)).join("") +
      `<p class="mt-4 text-xs leading-relaxed text-ink-3">Revisions are versioned in riskdemo/catalog.py (REVISIONS). The recordings in the console still use revision 1.</p>`,
  );
}

// ---------- recap ----------

function recap(study: Study): string {
  const o = study.raters[study.judge_models[0]].overall;
  const kw = study.raters.keyword.overall;
  const d = study.diversity?.sets;
  const disputed = study.conversations.filter((v) => Object.values(v.judges).some((j) => j.passed !== (v.label === "pass")));
  const onBorderline = disputed.filter((v) => v.borderline).length;
  const items = [
    ["Write the rule once, use it twice.", "The attacker and the judge read the same text, so the test data and the grader can't drift apart."],
    ["Check the judge before you trust the pass rate.", `On the first recording it matched our labels on ${o.agree} of ${o.n} hard cases (${onBorderline} of the ${disputed.length} disagreements were borderline). On varied attacks it missed far more${study.seeded_check ? `: ${study.seeded_check.raters[study.judge_models[0]].false_pass} false passes in one cell of ${study.seeded_check.n}` : ""}. Measure the judge on the attacks you actually run, and again when the attacks change.`],
    ["Seed your attacks.", d ? `One shared brief produced near-copies (${pct(d.recorded.mean.shared_opening)} of pairs shared an opening). A question, a persona and a tactic per attack fixed that (${pct(d.seeded.mean.shared_opening)}).` : "One shared brief produces near-copies."],
    ["Don't grade policy with keywords.", `A refusal-phrase check passed ${kw.false_pass} of the ${kw.label_fails} conversations we fail.`],
    ["When review blames the rule, change the rule, and version it.", "A revision can confirm the verdict rather than flip it. That is still progress: the disagreement becomes a concrete fix."],
  ];
  return section(
    "recap",
    5,
    "Recap",
    "What to take to your own team.",
    `<ol class="mt-5 space-y-4">${items.map(([t, d], i) => `<li class="flex gap-3"><span class="grid size-6 shrink-0 place-items-center rounded-full bg-ink font-mono text-[11px] text-paper">${i + 1}</span><span><span class="block text-[15px] font-medium text-ink">${t}</span><span class="block text-sm leading-relaxed text-ink-2">${esc(d)}</span></span></li>`).join("")}</ol>
    <p class="mt-8 text-xs leading-relaxed text-ink-3">Measured on 2026-10-27 with Gemini models through the paid API: ${study.cost.total.calls} logged calls, about $${study.cost.total.usd.toFixed(2)} in total. Everything is synthetic; the rules are teaching examples, not legal or clinical guidance.</p>
    <div class="mt-6 flex flex-wrap gap-3"><a href="/article" class="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper hover:bg-ink/90">${icon("book", 15)} Read the full article</a><a href="#/" class="inline-flex items-center gap-2 rounded-md border border-line-2 px-4 py-2.5 text-sm text-ink hover:bg-sunk">Back to the start</a></div>`,
  );
}

export function measured(c: Catalog, study: Study | null, labels: ReaderLabel[], example: Run | null): string {
  if (!study) return `<div class="mx-auto max-w-4xl px-5 py-14 text-sm text-ink-3 sm:px-10">No study results yet. Run <code class="font-mono text-xs">uv run python -m riskdemo study analyze</code>.</div>`;
  return `
  <article class="mx-auto max-w-4xl px-5 py-10 sm:px-10 sm:py-14">
    <p class="text-xs font-medium tracking-wide text-accent uppercase">Testing the method</p>
    <h1 class="mt-3 font-serif text-[36px] leading-[1.1] text-ink sm:text-[42px]">What we measured</h1>
    <p class="mt-4 max-w-2xl text-[17px] leading-relaxed text-ink-2">A pass rate depends on the attacks behind it and the judge that scores it. These four checks test both. Every number on this page is measured from the committed results; none is illustrative.</p>
    <nav class="mt-6 flex flex-wrap gap-2 text-sm" aria-label="Sections">${SECTIONS.map(([id, t], i) => `<a href="#/measured/${id}" class="rounded-md border border-line bg-card px-3 py-1.5 text-ink-2 hover:border-line-2 hover:text-ink"><span class="font-mono text-xs text-ink-3">${i + 1}</span> ${t}</a>`).join("")}</nav>
    ${judgeSection(c, study, labels)}
    ${diversitySection(c, study)}
    ${keywordSection(c, study, example)}
    ${loopSection(c, study)}
    ${recap(study)}
  </article>`;
}
