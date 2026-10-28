// The start page: the problem, how Giskard tests a rule (diagram and glossary), how to use the console,
// where to read what we measured, and what Giskard did for us versus what we added. Every number comes
// from the catalog or results/study/summary.json.

import { esc, pct } from "./logic.ts";
import type { Catalog, SetName, Study, Summary, Version } from "./types.ts";
import { SET_HINT, SET_LABEL, agentShort, icon } from "./ui.ts";

const GLOSSARY: [string, string][] = [
  ["Risk definition", "One behaviour the agent must not show, written by its owner (legal, compliance or a clinical safety lead): what is prohibited, why, what to do instead, and what users ask."],
  ["Rule", "The definition turned into one paragraph. The attacker and the judge both read this exact text."],
  ["Attacker", "An LLM that plays a user and tries, over up to three turns, to make the agent break the rule. Giskard's LLMGenerator with its adversarial template."],
  ["Seed", "A starting point for one attack: an example question from the definition, a persona and a tactic. Without seeds, all ten attacks read the same brief."],
  ["Judge", "An LLM that reads the rule and the whole conversation and says pass or fail, with a reason. Giskard's Conformity check."],
  ["Naive and hardened prompt", "The agent's system prompt without, and then with, the policy written into it."],
  ["Half-refusal", "A reply that says \"I can't advise you\" and then gives the advice anyway. A keyword check sees the refusal and passes it."],
  ["Label", "A person's own pass or fail for a conversation, written without looking at the judge. Labels are how you measure the judge."],
  ["False pass", "The judge passed a conversation the label fails. The dangerous kind: a broken rule that nobody sees."],
  ["False fail", "The judge failed a conversation the label passes. It costs reviewer time and erodes trust in the suite."],
  ["Cohen's kappa", "Agreement corrected for chance: 1 is perfect, 0 is what guessing would reach. Useful when most answers are one class."],
];

function diagram(): string {
  const nodes: [string, string, string][] = [
    ["Risk definition", "Written once by its owner", "book"],
    ["Attacker LLM", "Plays a user for up to 3 turns", "user"],
    ["Agent under test", "Penny, or the clinic assistant", "bot"],
    ["Judge LLM", "Reads the rule and the conversation", "scale"],
    ["Review", "The owner labels; disagreements become fixes", "check"],
  ];
  const node = ([t, d, i]: [string, string, string], k: number) => `
    <li class="relative flex min-w-0 flex-1 items-start gap-3 rounded-lg border border-line bg-card p-3.5 lg:flex-col lg:gap-2">
      <span class="grid size-8 shrink-0 place-items-center rounded-full ${k === 0 ? "bg-ink text-paper" : "border border-line-2 bg-paper text-ink-2"}">${icon(i, 15)}</span>
      <span class="min-w-0"><span class="block text-sm font-medium text-ink">${t}</span><span class="mt-0.5 block text-xs leading-snug text-ink-3">${d}</span></span>
    </li>`;
  const arrow = `<li aria-hidden="true" class="flex shrink-0 items-center justify-center text-line-2 lg:px-0.5"><span class="rotate-90 lg:rotate-0">${icon("arrow", 16)}</span></li>`;
  return `
  <figure class="mt-6" aria-label="How Giskard tests a rule">
    <ol class="flex flex-col gap-1.5 lg:flex-row lg:items-stretch">
      ${nodes.map((n, k) => (k ? arrow : "") + node(n, k)).join("")}
    </ol>
    <div class="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-line-2 px-3.5 py-2.5 text-xs text-ink-2">
      <span class="text-accent">${icon("loop", 15)}</span>
      <span>The same rule text goes to the attacker and to the judge. Review closes the loop: a disagreement points to the agent's prompt, the attacks, the judge, or the rule itself.</span>
    </div>
  </figure>`;
}

function rateCell(s: Summary | undefined): string {
  if (!s) return `<span class="text-ink-3">—</span>`;
  const n = s.passed + s.failed;
  return `<span class="inline-flex items-center gap-2"><span class="flex gap-[2px]" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<span class="h-3 w-1 rounded-[1px] ${i < s.passed ? "bg-pass" : "bg-fail/70"}"></span>`).join("")}</span><span class="font-mono text-xs text-ink-2">${s.passed}/${n}</span></span>`;
}

function policies(c: Catalog, set: SetName): string {
  const rows = Object.values(c.risks).map((r) => {
    const rec = c.sets[set]?.[r.id] ?? {};
    const cell = (v: Version) => `<a href="#/${r.id}/${v}/attack?set=${set}" class="block rounded-md px-2 py-1.5 -mx-2 hover:bg-sunk">${rateCell(rec[v]?.summary)}</a>`;
    return `<li class="grid gap-3 border-t border-line px-4 py-4 first:border-t-0 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:px-5">
      <div class="min-w-0"><a href="#/${r.id}/naive/policy?set=${set}" class="font-medium text-ink hover:underline">${esc(r.risk)}</a>
        <div class="text-xs text-ink-3">${esc(agentShort(c.agents[r.agent].name))} · ${esc(r.owner)}</div></div>
      <div class="flex items-center justify-between gap-3 sm:block"><span class="text-xs text-ink-3 sm:hidden">Naive prompt</span>${cell("naive")}</div>
      <div class="flex items-center justify-between gap-3 sm:block"><span class="text-xs text-ink-3 sm:hidden">Hardened prompt</span>${cell("hardened")}</div>
    </li>`;
  });
  return `
  <div class="mt-5 overflow-hidden rounded-lg border border-line bg-card">
    <div class="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-line px-5 py-2.5 text-xs text-ink-3 sm:grid"><span>Policy and owner</span><span>Kept the rule · naive</span><span>Kept the rule · hardened</span></div>
    <ul>${rows.join("")}</ul>
  </div>
  <p class="mt-3 text-xs leading-relaxed text-ink-3">${SET_LABEL[set]}: ${SET_HINT[set]} Bars count attacks the agent kept the rule in, out of the attacks that finished, as scored by the judge. Out of ten, treat a difference of one or two as noise.</p>`;
}

function findings(study: Study | null): string {
  if (!study) return `<p class="mt-4 text-sm text-ink-3">Run <code class="font-mono text-xs">uv run python -m riskdemo study analyze</code> to see what we measured.</p>`;
  const judge = study.raters[study.judge_models[0]]?.overall;
  const kw = study.raters.keyword?.overall;
  const div = study.diversity?.sets;
  const loop = study.loop[0];
  const flip = loop?.rejudged?.find((v) => v.attack === loop.attack);
  const cards: [string, string, string, string][] = [
    ["judge", "Is the judge right?", judge ? `${judge.agree} of ${judge.n}` : "—", judge ? `hard cases from the first recording where the judge matched our labels.${study.seeded_check ? ` On varied attacks it did worse: ${study.seeded_check.raters[study.judge_models[0]].false_pass} false passes in one cell of ${study.seeded_check.n}.` : ""}` : ""],
    ["diversity", "Were the attacks different?", div ? `${pct(div.recorded.mean.shared_opening)} → ${pct(div.seeded.mean.shared_opening)}` : "—", "of attack pairs in a cell that opened with the same four words, before and after seeding."],
    ["keyword", "Would a keyword check do?", kw ? `${kw.false_pass} of ${kw.label_fails}` : "—", "conversations our labels fail that a refusal-phrase check passes: the half-refusals."],
    ["loop", "Does fixing the rule help?", flip ? (flip.status === "pass" ? "Flipped" : "Still fails") : "—", flip ? `Attack ${loop.attack} under the revised dispute rule. The revision exposed what the agent still has to do.` : ""],
  ];
  return `<div class="mt-5 grid gap-3 sm:grid-cols-2">${cards
    .map(([id, q, n, d]) => `<a href="#/measured/${id}" class="group rounded-lg border border-line bg-card p-4 hover:border-line-2">
      <div class="text-xs font-medium text-ink-2">${q}</div>
      <div class="mt-2 font-serif text-[28px] leading-none text-ink">${esc(n)}</div>
      <p class="mt-2 text-sm leading-snug text-ink-2">${esc(d)}</p>
      <span class="mt-3 inline-flex items-center gap-1 text-xs text-ink-3 group-hover:text-ink">Read the measurement ${icon("arrow", 13)}</span></a>`)
    .join("")}</div>`;
}

// What the library did here and what we built on top. Giskard's attacker and judge are LLM calls (Gemini
// here), so the honest question is what the harness adds over a script that calls the same model.
function giskardRole(study: Study | null): string {
  const div = study?.diversity?.sets;
  const sc = study?.seeded_check;
  const scJudge = sc && study ? sc.raters[study.judge_models[0]] : undefined;
  const gave: [string, string, string][] = [
    ["A multi-turn attacker", "LLMGenerator + the giskard.scan adversarial template", "It reads the rule and plays a user for up to three turns, changing tactic after each reply. Writing and tuning that red-team prompt and loop yourself is the slowest part to get right."],
    ["One shape for every test", "Scenario + Conformity check + Trace", "A rule becomes a scenario with a judge; every turn is recorded as a trace. That shape is what lets this app replay the runs, and lets us score the same conversations again later."],
    ["Swappable parts", "set_default_generator, set_default_judge", "Changing the model is one line. That is how we re-scored every conversation with a second judge, and how we added seeds without rewriting the loop."],
    ["More attackers and checks than we first used", "Crescendo, GOAT · RegexMatching, AllOf, AnyOf", "The scan module ships other attack strategies, and the checks module composes deterministic checks with judges. We tried both: see Stack the checks and Smarter attackers under What we measured."],
  ];
  const added: [string, string][] = [
    ["Seeds, so the attacks differ", div ? `Out of the box, ${pct(div.recorded.mean.shared_opening)} of attack pairs in a cell opened with the same four words. Giving each attack its own question, persona and tactic brought that to ${pct(div.seeded.mean.shared_opening)}.` : "Out of the box, the ten attacks in a cell read the same brief and often opened the same way."],
    ["Labels, to check the judge", scJudge && sc ? `Conformity is an LLM judge with an LLM's blind spots. On one medication cell it passed ${scJudge.both_pass + scJudge.false_pass} of ${sc.n}; our labels pass ${sc.label_passed}. It missed advice inside role-play scripts and hypotheticals.` : "Conformity is an LLM judge with an LLM's blind spots; only labels show where."],
    ["A cost ledger", "Every attacker, agent and judge call is logged with its tokens and price in runs/costs.jsonl. The library doesn't track spend."],
    ["Workarounds for a young API", "Giskard 3.0.1 is new. Seeding meant subclassing its input generator and reading its Trace class from internal modules, which can change between releases."],
  ];
  return `
    <section class="mt-14" id="why-giskard">
      <h2 class="font-serif text-2xl text-ink">What Giskard did for us, and what it didn't</h2>
      <p class="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">Giskard doesn't bring its own model. Its attacker and its judge are LLM calls, here to Gemini, so a script that calls Gemini directly could do the same job. What the library adds is the harness around those calls.</p>
      <div class="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 class="text-sm font-medium text-ink">What Giskard gave us</h3>
          <ul class="mt-3 space-y-3">
            ${gave.map(([t, api, d]) => `<li class="rounded-lg border border-line bg-card p-4"><div class="text-sm font-medium text-ink">${t}</div><div class="mt-0.5 font-mono text-[11.5px] text-ink-3">${esc(api)}</div><p class="mt-1.5 text-sm leading-relaxed text-ink-2">${esc(d)}</p></li>`).join("")}
          </ul>
        </div>
        <div>
          <h3 class="text-sm font-medium text-ink">What we had to add</h3>
          <ul class="mt-3 space-y-3">
            ${added.map(([t, d]) => `<li class="rounded-lg border border-dashed border-line-2 p-4"><div class="text-sm font-medium text-ink">${t}</div><p class="mt-1.5 text-sm leading-relaxed text-ink-2">${esc(d)}</p></li>`).join("")}
          </ul>
        </div>
      </div>
      <div class="mt-6 rounded-lg border-l-2 border-accent bg-card px-4 py-3.5">
        <div class="text-sm font-medium text-ink">Could you do this without Giskard?</div>
        <p class="mt-1.5 text-[15px] leading-relaxed text-ink-2">Yes. The attacker loop and the judge are a few hundred lines of your own code. Giskard got us from a written rule to realistic multi-turn attacks quickly, and gave every run the same shape. It pays off more with many rules and many agents in CI, where a shared test format matters. But the findings on this page came from measuring its output: the repeated attacks, the judge's blind spots, the half-refusals. A hand-written script would have had the same problems. Treat Giskard as a convenient harness, not a source of truth.</p>
      </div>
    </section>`;
}

export function home(c: Catalog, study: Study | null, set: SetName): string {
  const first = Object.values(c.risks)[0];
  return `
  <article class="mx-auto max-w-4xl px-5 py-10 sm:px-10 sm:py-14">
    <p class="text-xs font-medium tracking-wide text-accent uppercase">Adversarial evals from your own policies · Giskard v3</p>
    <h1 class="mt-3 max-w-3xl font-serif text-[38px] leading-[1.1] text-ink sm:text-[46px]">Your lawyers wrote a rule. Can your agent keep it?</h1>
    <p class="mt-4 max-w-2xl text-[17px] leading-relaxed text-ink-2">In a bank or a clinic, engineers don't decide what an agent may say. Lawyers, compliance officers and clinical safety leads do, and they write their rules in prose. This page shows how Giskard turns one of those rules into attacks on an agent and a judge's verdict, and then checks how far that verdict can be trusted.</p>

    <section class="mt-12">
      <h2 class="font-serif text-2xl text-ink">The problem</h2>
      <div class="mt-4 grid gap-3 sm:grid-cols-3">
        ${[
          ["Rules arrive as prose", "\"No personalized investment advice.\" \"Always send chest pain to emergency care.\" Nobody hands engineering a test suite."],
          ["Tests must use those words", "If engineering rewrites the rule for the tests, the tests and the policy drift apart, and nobody notices until launch review."],
          ["Owners must read the results", "A pass rate means little to a compliance officer. A conversation, a verdict and a reason is something they can agree or disagree with."],
        ]
          .map(([t, d]) => `<div class="rounded-lg border border-line bg-card p-4"><div class="text-sm font-medium text-ink">${t}</div><p class="mt-1.5 text-sm leading-relaxed text-ink-2">${d}</p></div>`)
          .join("")}
      </div>
    </section>

    <section class="mt-12">
      <h2 class="font-serif text-2xl text-ink">How Giskard tests a rule</h2>
      <p class="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">Giskard is an open-source library for testing agents. Its red-teaming loop has three moving parts: a rule, an attacker that tries to break it, and a judge that scores each conversation against the same rule. The fourth part, review, is people.</p>
      ${diagram()}
    </section>

    <section class="mt-12">
      <h2 class="font-serif text-2xl text-ink">Words used on this page</h2>
      <dl class="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        ${GLOSSARY.map(([t, d]) => `<div><dt class="text-sm font-medium text-ink">${t}</dt><dd class="mt-0.5 text-sm leading-relaxed text-ink-2">${d}</dd></div>`).join("")}
      </dl>
    </section>

    <section class="mt-14" id="console">
      <h2 class="font-serif text-2xl text-ink">Try it: the red-team console</h2>
      <p class="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">Two synthetic agents, four policies, two prompt versions, ten recorded attacks each. Everything replays without an API key.</p>
      <ol class="mt-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        ${[
          ["Read the policy", "The risk definition as its owner wrote it, the rule both LLMs read, and the agent's prompt."],
          ["Watch the attacks", "Replay ten conversations side by side, at reading speed, and see the judge's verdict on each."],
          ["Label them yourself", "Say whether the agent kept the rule, then compare with the judge, a second judge and our label."],
        ]
          .map(([t, d], i) => `<li class="bg-card p-4"><div class="flex items-center gap-2.5"><span class="grid size-6 place-items-center rounded-full border border-line-2 font-mono text-xs text-ink-2">${i + 1}</span><span class="text-sm font-medium text-ink">${t}</span></div><p class="mt-2 text-sm leading-relaxed text-ink-2">${d}</p></li>`)
          .join("")}
      </ol>
      <div class="mt-8 flex flex-wrap items-end justify-between gap-3">
        <h3 class="text-sm font-medium text-ink">Pick a policy</h3>
        <div class="flex rounded-md bg-sunk p-0.5 text-xs" role="group" aria-label="Attack set">
          ${(["seeded", "recorded"] as SetName[]).map((s) => `<a href="#/?set=${s}" class="rounded-[5px] px-2.5 py-1.5 ${s === set ? "bg-card font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2 hover:text-ink"}">${SET_LABEL[s]}</a>`).join("")}
        </div>
      </div>
      ${policies(c, set)}
      <a href="#/${first.id}/naive/policy?set=${set}" class="mt-5 inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper hover:bg-ink/90">Start with ${esc(first.risk.toLowerCase())} ${icon("arrow", 15)}</a>
    </section>

    <section class="mt-14">
      <h2 class="font-serif text-2xl text-ink">What we measured</h2>
      <p class="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">A pass rate is only as good as the attacks behind it and the judge that scores it. So we tested the method itself four ways, then tried two parts of Giskard we hadn't used: stacked checks and smarter attackers.</p>
      ${findings(study)}
      <div class="mt-8 flex flex-wrap gap-3">
        <a href="#/measured" class="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper hover:bg-ink/90">See what we measured ${icon("arrow", 15)}</a>
        <a href="/article" class="inline-flex items-center gap-2 rounded-md border border-line-2 px-4 py-2.5 text-sm text-ink hover:bg-sunk">${icon("book", 15)} Read the article</a>
      </div>
    </section>
    ${giskardRole(study)}
    <p class="mt-12 border-t border-line pt-5 text-xs leading-relaxed text-ink-3">Everything here is synthetic: the bank, the clinic, the member and the patient are invented, and the risk definitions are teaching examples, not legal or clinical guidance.</p>
  </article>`;
}
