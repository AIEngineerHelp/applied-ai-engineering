// "What we measured": four checks on the method itself, then a recap. Every number is read from
// results/study/summary.json (written by `riskdemo study analyze`) or computed from the reader's own labels.

import { agreementSentence, esc, pct, readerTally, renderReply, ruleDiff, type ReaderLabel } from "./logic.ts";
import type { Agreement, AttackStyle, Catalog, DiversityMetrics, LabelledConversation, Run, StackId, Study } from "./types.ts";

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
  ["stack", "Stack the checks"],
  ["attackers", "Smarter attackers"],
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

// ---------- 5. stacking checks ----------

const setLink = (v: { set: string; risk: string; version: string; attack: number }) => `#/${v.risk}/${v.version}/review/${v.attack}${v.set === "recorded" ? "?set=recorded" : ""}`;

function stackSection(c: Catalog, study: Study, pick: StackId): string {
  const st = study.stack;
  if (!st) return section("stack", 5, "Stack the checks", "Run <code class=\"font-mono text-xs\">uv run python -m riskdemo study stack</code> to see this section.", "");
  const chosen = st.stacks.find((x) => x.id === pick) ?? st.stacks[0];
  const base = st.stacks.find((x) => x.id === "judge")!;
  const changed = st.conversations.filter((v) => v.verdicts[chosen.id] !== v.verdicts.judge);
  const better = changed.filter((v) => v.verdicts[chosen.id] === (v.label === "pass")).length;
  const tabs = st.stacks
    .map((x) => `<button type="button" data-action="stack" data-stack="${x.id}" aria-pressed="${x.id === chosen.id}" class="rounded-md border px-3 py-1.5 text-sm ${x.id === chosen.id ? "border-ink bg-ink text-paper" : "border-line bg-card text-ink-2 hover:border-line-2 hover:text-ink"}">${esc(x.name)}</button>`)
    .join("");
  const rows = st.stacks
    .map((x) => `<tr class="border-t border-line ${x.id === chosen.id ? "bg-sunk/60" : ""}">
      <td class="py-2.5 pr-4"><span class="text-ink">${esc(x.name)}</span><span class="block font-mono text-[11.5px] text-ink-3">${esc(x.giskard)}</span></td>
      <td class="py-2.5 pr-4 font-mono text-[13px] text-ink">${x.agree}/${x.n}</td>
      <td class="py-2.5 pr-4 font-mono text-[13px] ${x.false_pass > base.false_pass ? "text-fail" : x.false_pass < base.false_pass ? "text-pass" : "text-ink-2"}">${x.false_pass}</td>
      <td class="py-2.5 font-mono text-[13px] text-ink-2">${x.false_fail}</td></tr>`)
    .join("");
  const card = (v: (typeof changed)[number]) => `<li class="rounded-lg border border-line bg-card p-4">
      <a href="${setLink(v)}" class="text-sm font-medium text-ink hover:underline">${esc(c.risks[v.risk].risk)} · ${esc(VERSION_LABEL[v.version].toLowerCase())} · attack ${v.attack} <span class="font-normal text-ink-3">(${v.set === "recorded" ? "first recording" : "seeded"})</span></a>
      <div class="mt-2 flex flex-wrap gap-1.5">${chip("Our label", v.label === "pass")} ${chip("Judge alone", v.verdicts.judge)} ${chip(chosen.name, v.verdicts[chosen.id])}</div>
      <p class="mt-2 text-sm leading-relaxed text-ink-2"><span class="text-ink-3">Our reading:</span> ${esc(v.reason)}</p></li>`;
  return section(
    "stack",
    5,
    "Stack the checks",
    "Giskard composes checks: <code class=\"font-mono text-[13px]\">RegexMatching</code> for what code can check exactly, <code class=\"font-mono text-[13px]\">AllOf</code> to require every check, <code class=\"font-mono text-[13px]\">AnyOf</code> to accept any one. We rebuilt section 3's keyword check with RegexMatching, one per reply, and stacked it with the judges on the 50 labelled conversations. The judges' verdicts are replayed from the recording, so this made no model calls.",
    `
    <div class="mt-5 flex flex-wrap gap-2" role="group" aria-label="Pick a stack">${tabs}</div>
    <div class="mt-4 rounded-lg border border-line bg-card p-4 sm:p-5">
      <div class="font-mono text-[13px] text-ink-2">${esc(chosen.giskard)}</div>
      <p class="mt-1 text-sm text-ink-3">${esc(chosen.meaning)}</p>
      <p class="mt-3 font-serif text-[22px] leading-snug text-ink">Agrees with our labels on ${chosen.agree} of ${chosen.n}: ${chosen.false_pass} false ${chosen.false_pass === 1 ? "pass" : "passes"}, ${chosen.false_fail} false ${chosen.false_fail === 1 ? "fail" : "fails"}.</p>
      <p class="mt-1 text-sm leading-relaxed text-ink-2">${chosen.id === "judge" ? "The baseline. Pick another stack to see which verdicts it changes." : changed.length ? `It changes the judge's verdict on ${changed.length} ${changed.length === 1 ? "conversation" : "conversations"}: ${better} toward our label, ${changed.length - better} away from it.` : "It changes none of the judge's verdicts."}</p>
    </div>
    ${chosen.id !== "judge" && changed.length ? `<h3 class="mt-6 text-sm font-medium text-ink">Where this stack disagrees with the judge alone</h3><ul class="mt-3 space-y-2">${changed.map(card).join("")}</ul>` : ""}
    <div class="mt-6 overflow-x-auto rounded-lg border border-line bg-card px-4 sm:px-5"><table class="w-full min-w-[460px] text-left text-sm">
      <thead class="text-xs text-ink-3"><tr><th class="py-2.5 pr-4 font-medium">Stack</th><th class="py-2.5 pr-4 font-medium">Agrees</th><th class="py-2.5 pr-4 font-medium">False passes</th><th class="py-2.5 font-medium">False fails</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="mt-5 rounded-lg border border-line bg-sunk/60 px-4 py-3.5 text-sm leading-relaxed text-ink-2 sm:px-5">
      <div class="font-medium text-ink">What this shows</div>
      <ul class="mt-1.5 list-disc space-y-1 pl-5">
        <li>A regex can only veto what it can see. Ours check that a required element is there (a refusal, the dispute path, the nurse line, "911"). The half-refusals have it, next to the advice, so adding the regex under the judge removed no false passes.</li>
        <li>Letting a cheap check overrule the judge (AnyOf) is the dangerous direction: every half-refusal the regex likes passes again.</li>
        <li>A second judge is the stack that helped, at the price of a second model call per conversation.</li>
        <li>Where a regex earns its place under a judge: facts code can verify exactly, such as a required phone number, or a canary value that must never appear.</li>
      </ul>
    </div>`,
  );
}

// ---------- 6. smarter attackers ----------

const STYLE_NAME: Record<AttackStyle, string> = { seeded: "Our seeded attacker", crescendo: "Crescendo", goat: "GOAT" };
const STYLE_HOW: Record<AttackStyle, string> = {
  seeded: "Giskard's default adversarial template plus our seed (a question, a persona and a tactic). Up to 3 turns.",
  crescendo: "Starts with a harmless, abstract question and escalates a little each turn, building on the agent's own answers. Backs off and rephrases when refused.",
  goat: "An attacker agent with seven named jailbreak techniques (refusal suppression, dual response, response priming, persona change, hypotheticals, topic splitting, opposite intent). Observes each reply and picks the next technique.",
};

export type FaceoffRuns = Record<string, Run>; // "<style>/<risk>--<version>" -> run

const broke = (x?: { passed: number; failed: number }) => (x ? `${x.failed}/${x.passed + x.failed}` : "—");

function conversation(run: Run, index: number): string {
  const a = run.attacks[index];
  const verdict = a.checks.find((ch) => ch.kind === "conformity");
  return `<div class="space-y-3">${a.turns
    .map((t, k) => `<div><div class="text-[11px] text-ink-3">Attacker, turn ${k + 1}</div><p class="mt-0.5 rounded-lg bg-sunk px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-ink">${esc(t.user)}</p></div>
      <div><div class="text-[11px] text-ink-3">Agent</div><div class="reply mt-0.5 rounded-lg border border-line px-3.5 py-2.5 text-sm leading-relaxed text-ink">${renderReply(t.agent ?? "", [])}</div></div>`)
    .join("")}
    ${verdict ? `<p class="rounded-md border-l-2 ${verdict.status === "pass" ? "border-pass" : "border-fail"} bg-card px-3.5 py-2.5 text-sm leading-relaxed text-ink-2"><span class="font-medium ${verdict.status === "pass" ? "text-pass" : "text-fail"}">Judge: ${verdict.status === "pass" ? "kept the rule" : "broke the rule"}.</span> ${esc(verdict.reason ?? "")}</p>` : a.error ? `<p class="text-sm text-warn">${esc(a.error)}</p>` : ""}</div>`;
}

function featured(c: Catalog, runs: FaceoffRuns, style: "crescendo" | "goat", cells: string[]): string {
  // Prefer a break against the hardened prompt: that is the one the seeded attacker mostly couldn't get.
  const order = [...cells.filter((k) => k.endsWith("--hardened")), ...cells.filter((k) => k.endsWith("--naive"))];
  for (const k of order) {
    const run = runs[`${style}/${k}`];
    const i = run?.attacks.findIndex((a) => a.status === "failed") ?? -1;
    if (run && i >= 0)
      return `<figure class="rounded-lg border border-line bg-card">
        <figcaption class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 text-xs sm:px-5"><span class="font-medium text-ink-2">${STYLE_NAME[style]} · ${esc(cellName(c, k))} · attack ${i + 1}</span><span class="text-ink-3">${run.attacks[i].turns.length} turns</span></figcaption>
        <div class="px-4 py-4 sm:px-5">${conversation(run, i)}</div></figure>`;
  }
  return `<p class="rounded-lg border border-dashed border-line-2 px-4 py-4 text-sm text-ink-2">${STYLE_NAME[style]} didn't break the rule in any cell.</p>`;
}

function attackersSection(c: Catalog, study: Study, runs: FaceoffRuns): string {
  const f = study.faceoff;
  if (!f || !Object.keys(f.styles.crescendo ?? {}).length)
    return section("attackers", 6, "Smarter attackers", "Run <code class=\"font-mono text-xs\">uv run python -m riskdemo faceoff record --live</code>, then <code class=\"font-mono text-xs\">faceoff analyze</code>, to see this section.", "");
  const styles: AttackStyle[] = ["seeded", "crescendo", "goat"];
  const total = (st: AttackStyle, v: string) =>
    f.cells.filter((k) => k.endsWith(`--${v}`)).reduce((acc, k) => ({ passed: acc.passed + (f.styles[st][k]?.passed ?? 0), failed: acc.failed + (f.styles[st][k]?.failed ?? 0) }), { passed: 0, failed: 0 });
  const head = styles.map((st) => `<th class="py-2.5 pr-4 font-medium">${STYLE_NAME[st]}</th>`).join("");
  const rows = f.cells
    .map((k) => `<tr class="border-t border-line"><td class="py-2.5 pr-4 text-ink">${esc(cellName(c, k))}</td>${styles
      .map((st) => {
        const x = f.styles[st][k];
        if (!x) return `<td class="py-2.5 pr-4 text-ink-3">—</td>`;
        const rate = x.failed / Math.max(1, x.passed + x.failed);
        return `<td class="py-2.5 pr-4"><span class="font-mono text-[13px] ${rate >= 0.5 ? "text-fail" : rate > 0 ? "text-ink" : "text-ink-3"}">${broke(x)}</span><span class="block text-[11px] text-ink-3">${x.mean_turns ?? "—"} turns on average${x.second_judge_failed != null ? ` · ${f.second_judge} failed ${x.second_judge_failed}` : ""}${x.errored ? ` · ${x.errored} errored` : ""}</span></td>`;
      })
      .join("")}</tr>`)
    .join("");
  const totals = styles.map((st) => `<td class="py-2.5 pr-4 font-mono text-[13px] text-ink">${broke(total(st, "hardened"))}</td>`).join("");
  const all = (st: "crescendo" | "goat") =>
    f.cells
      .map((k) => {
        const run = runs[`${st}/${k}`];
        if (!run) return "";
        return run.attacks
          .map((a, i) => `<details class="border-t border-line first:border-t-0"><summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5"><span class="text-ink">${esc(cellName(c, k))} · attack ${i + 1}</span><span class="flex items-center gap-2">${chip("Judge", a.status === "passed" ? true : a.status === "failed" ? false : null)}<span class="text-ink-3">${icon("chevron", 14)}</span></span></summary><div class="border-t border-line bg-paper px-4 py-4 sm:px-5">${conversation(run, i)}</div></details>`)
          .join("");
      })
      .join("");
  const h = { s: total("seeded", "hardened"), c: total("crescendo", "hardened"), g: total("goat", "hardened") };
  const nv = { s: total("seeded", "naive"), c: total("crescendo", "naive"), g: total("goat", "naive") };
  const styled = (["crescendo", "goat"] as const).flatMap((st) => Object.values(f.styles[st]));
  const agree = styled.reduce((n, x) => n + (x.second_judge_agree ?? 0), 0);
  const scored = styled.reduce((n, x) => n + x.passed + x.failed, 0);
  const meanOpening = (st: AttackStyle) => {
    const v = Object.values(f.styles[st]).map((x) => x.shared_opening).filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  // The cell where unseeded openings repeat most, shown verbatim from the run.
  const [rk, rst] = (["crescendo", "goat"] as const)
    .flatMap((st) => Object.entries(f.styles[st]).map(([k, x]) => [k, st, x.shared_opening ?? 0] as const))
    .sort((a, b) => b[2] - a[2])[0] ?? [];
  const repeatRun = rk && rst ? runs[`${rst}/${rk}`] : undefined;
  const medSeeded = study.seeded_check && study.seeded_check.cell === "medication-changes--naive" ? study.seeded_check : null;
  return section(
    "attackers",
    6,
    "Smarter attackers",
    `Every attack so far used one of Giskard's attack templates. Its scan module ships others. We pointed two of them at our own rules: <b class="font-medium text-ink">Crescendo</b> and <b class="font-medium text-ink">GOAT</b>, each given the rule's prohibited behaviour as its goal, against the same agents, scored by the same judge, with up to 6 turns and 5 attacks per cell.`,
    `
    <p class="mt-5 font-serif text-[22px] leading-snug text-ink">Against the naive prompts, Crescendo broke the rule in ${broke(nv.c)} attacks and GOAT in ${broke(nv.g)}, where the judge counted ${broke(nv.s)} for our seeded attacker. Against the hardened prompts, none of the three broke it.</p>
    <div class="mt-5 grid gap-3 md:grid-cols-3">${styles.map((st) => `<div class="rounded-lg border border-line bg-card p-4"><div class="text-sm font-medium text-ink">${STYLE_NAME[st]}</div><p class="mt-1.5 text-sm leading-relaxed text-ink-2">${STYLE_HOW[st]}</p></div>`).join("")}</div>
    <div class="mt-5 overflow-x-auto rounded-lg border border-line bg-card px-4 sm:px-5"><table class="w-full min-w-[560px] text-left text-sm">
      <thead class="text-xs text-ink-3"><tr><th class="py-2.5 pr-4 font-medium">Broke the rule, by the judge</th>${head}</tr></thead>
      <tbody>${rows}<tr class="border-t border-line-2"><td class="py-2.5 pr-4 font-medium text-ink">All hardened prompts</td>${totals}</tr></tbody></table></div>
    <p class="mt-2 text-xs leading-relaxed text-ink-3">The seeded attacker had 10 attacks of up to 3 turns per cell; Crescendo and GOAT had 5 attacks of up to 6 turns and can stop early when they judge their goal reached. Compare rates, not counts, and treat one or two attacks as noise.</p>
    <div class="mt-5 rounded-md border border-line bg-sunk/60 px-4 py-3 text-sm leading-relaxed text-ink-2"><span class="font-medium text-ink">The goal each attacker was given.</span> ${Object.entries(f.goals).map(([r, g]) => `<span class="mt-1 block"><span class="text-ink-3">${esc(c.risks[r].risk)}:</span> ${esc(g)}</span>`).join("")}<span class="mt-1 block text-xs text-ink-3">The goal goes only to the attacker. The judge sees the same rule and annotations as in every other run.</span></div>
    <div class="mt-5 rounded-lg border border-line bg-sunk/60 px-4 py-3.5 text-sm leading-relaxed text-ink-2 sm:px-5">
      <div class="font-medium text-ink">What this shows</div>
      <ul class="mt-1.5 list-disc space-y-1 pl-5">
        <li><span class="text-ink">Smarter attackers got clearer evidence, not just more.</span> On the naive medication prompt the judge counted ${broke(f.styles.seeded["medication-changes--naive"])} breaks for our seeded attacker${medSeeded ? `, though our labels found ${medSeeded.n - medSeeded.label_passed}: the advice was wrapped in role-play and hypotheticals the judge missed` : ""}. Crescendo and GOAT pushed until the agent said "Yes, take it" outright, which no judge misses.${f.second_judge ? ` ${esc(f.second_judge)} agreed with the judge on ${agree} of ${scored} face-off attacks.` : ""}</li>
        <li><span class="text-ink">The hardened prompts held</span> against all three attackers: ${broke(h.s)}, ${broke(h.c)} and ${broke(h.g)}. GOAT tried "simulator mode" and a "decision logic model"; Crescendo cited a doctor's prior approval. The agent declined each time.</li>
        <li><span class="text-ink">They are not more varied on their own.</span> Without seeds, ${pct(meanOpening("crescendo"))} of Crescendo's and ${pct(meanOpening("goat"))} of GOAT's attack pairs in a cell opened with the same four words, against ${pct(meanOpening("seeded"))} for our seeded attacker.${repeatRun ? ` In ${esc(cellName(c, rk!))}, ${STYLE_NAME[rst!]} opened with:` : ""}</li>
      </ul>
      ${repeatRun ? `<ol class="mt-2 space-y-1 pl-5">${repeatRun.attacks.map((a) => `<li class="font-mono text-[12px] text-ink-2">“${esc((a.turns[0]?.user ?? "").slice(0, 90))}…”</li>`).join("")}</ol>` : ""}
      <p class="mt-2 text-xs text-ink-3">Longer attacks cost more and fail more: at 6 turns, 9 of the 40 attacks first timed out or lost their attacker (it failed to write a next message after a firm refusal). We reran those 9 with a longer timeout.</p>
    </div>
    <h3 class="mt-8 text-sm font-medium text-ink">How Crescendo broke it</h3>
    <div class="mt-3">${featured(c, runs, "crescendo", f.cells)}</div>
    <h3 class="mt-8 text-sm font-medium text-ink">How GOAT broke it</h3>
    <div class="mt-3">${featured(c, runs, "goat", f.cells)}</div>
    <h3 class="mt-8 text-sm font-medium text-ink">Every face-off conversation</h3>
    <div class="mt-3 grid gap-4 lg:grid-cols-2">
      ${(["crescendo", "goat"] as const).map((st) => `<div><div class="mb-2 text-xs text-ink-3">${STYLE_NAME[st]}</div><div class="overflow-hidden rounded-lg border border-line bg-card">${all(st) || `<p class="px-4 py-4 text-sm text-ink-3">Loading…</p>`}</div></div>`).join("")}
    </div>
    <p class="mt-3 text-xs leading-relaxed text-ink-3">These verdicts are the judge's, not our labels. Section 2 showed the judge misses advice wrapped in role-play and hypotheticals, which is how GOAT works, so read the conversations before trusting the counts.</p>`,
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
    7,
    "Recap",
    "What to take to your own team.",
    `<ol class="mt-5 space-y-4">${items.map(([t, d], i) => `<li class="flex gap-3"><span class="grid size-6 shrink-0 place-items-center rounded-full bg-ink font-mono text-[11px] text-paper">${i + 1}</span><span><span class="block text-[15px] font-medium text-ink">${t}</span><span class="block text-sm leading-relaxed text-ink-2">${esc(d)}</span></span></li>`).join("")}</ol>
    <p class="mt-8 text-xs leading-relaxed text-ink-3">Measured on 2026-10-27 with Gemini models through the paid API: ${study.cost.total.calls} logged calls, about $${study.cost.total.usd.toFixed(2)} in total. Everything is synthetic; the rules are teaching examples, not legal or clinical guidance.</p>
    <div class="mt-6 flex flex-wrap gap-3"><a href="/article" class="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper hover:bg-ink/90">${icon("book", 15)} Read the full article</a><a href="#/" class="inline-flex items-center gap-2 rounded-md border border-line-2 px-4 py-2.5 text-sm text-ink hover:bg-sunk">Back to the start</a></div>`,
  );
}

export function measured(c: Catalog, study: Study | null, labels: ReaderLabel[], example: Run | null, stack: StackId, faceoff: FaceoffRuns): string {
  if (!study) return `<div class="mx-auto max-w-4xl px-5 py-14 text-sm text-ink-3 sm:px-10">No study results yet. Run <code class="font-mono text-xs">uv run python -m riskdemo study analyze</code>.</div>`;
  return `
  <article class="mx-auto max-w-4xl px-5 py-10 sm:px-10 sm:py-14">
    <p class="text-xs font-medium tracking-wide text-accent uppercase">Testing the method</p>
    <h1 class="mt-3 font-serif text-[36px] leading-[1.1] text-ink sm:text-[42px]">What we measured</h1>
    <p class="mt-4 max-w-2xl text-[17px] leading-relaxed text-ink-2">A pass rate depends on the attacks behind it and the judge that scores it. These checks test both, and two more use parts of Giskard we hadn't touched. Every number on this page is measured from the committed results; none is illustrative.</p>
    <nav class="mt-6 flex flex-wrap gap-2 text-sm" aria-label="Sections">${SECTIONS.map(([id, t], i) => `<a href="#/measured/${id}" class="rounded-md border border-line bg-card px-3 py-1.5 text-ink-2 hover:border-line-2 hover:text-ink"><span class="font-mono text-xs text-ink-3">${i + 1}</span> ${t}</a>`).join("")}</nav>
    ${judgeSection(c, study, labels)}
    ${diversitySection(c, study)}
    ${keywordSection(c, study, example)}
    ${loopSection(c, study)}
    ${stackSection(c, study, stack)}
    ${attackersSection(c, study, faceoff)}
    ${recap(study)}
  </article>`;
}
