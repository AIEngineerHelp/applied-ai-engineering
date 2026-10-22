// The cinematic app. Three acts over one recorded run (results/run.json, built by `npm run data`):
//   hero    - five documents drift in and dissolve into the finished web of pages
//   act 1-2 - each source plays as a scene: it flies into the web, pages ignite, links draw,
//             the agent's edits type themselves in; then lint finds the contradiction and the fix resolves it
//   act 3   - the face-off: wiki pages against chunk RAG, revealed in sequence, verdict last
// Every animated state is a function of a scene clock, so `?t=<ms>` freezes any frame for review.

import runJson from "../results/run.json" with { type: "json" };
import type { QuestionResult, Run, Step } from "../src/build.ts";
import type { DiffLine } from "../src/diff.ts";
import type { FactResult } from "../src/retrieve.ts";
import { esc, mdLine, type Highlight } from "./render.ts";
import { Web, type Camera } from "./web.ts";

const RUN = runJson as unknown as Run;
const INGESTS = RUN.steps.filter((s) => s.kind === "ingest");
const FIX = RUN.steps.find((s) => s.kind === "lint")!;
const LAST = INGESTS[INGESTS.length - 1];
const LINT_SCENE = INGESTS.length + 1;
const FIX_SCENE = INGESTS.length + 2;
const SCENES = FIX_SCENE + 1;

const params = new URLSearchParams(location.search);
const FROZEN = params.has("t") ? Math.max(0, Number(params.get("t")) || 0) : null;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;
if (FROZEN !== null) {
  root.classList.add("frozen");
  root.style.setProperty("--t", String(FROZEN));
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const edgeKey = (a: string, b: string) => [a, b].sort().join("|");
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const narrow = () => innerWidth < 760;

// ---------------------------------------------------------------- timing (ms, scene clock)

const T = {
  fly: 0,
  flyDur: 1100,
  ignite: 1000,
  cam: 650,
  camDur: 1400,
  panel: 1450,
  beats: [0, 1150, 2750],
  ingestLen: 8600,
  lintLen: 8200,
  fixLen: 8200,
};

// ---------------------------------------------------------------- clocks

let sceneStart = performance.now();
const heroStart = performance.now();
const sceneTime = () => (FROZEN !== null ? FROZEN : REDUCED ? 1e7 : performance.now() - sceneStart);
const heroTime = () => (FROZEN !== null ? FROZEN : REDUCED ? 1e7 : performance.now() - heroStart);
const wallTime = () => (FROZEN !== null || REDUCED ? 0 : performance.now());

// ---------------------------------------------------------------- hero

const heroCanvas = $<HTMLCanvasElement>("hero-canvas");
const hero = new Web(heroCanvas, RUN.layout);

function setupHero() {
  hero.view = narrow() ? { cx: 0.5, cy: 0.3, fill: 0.98 } : { cx: 0.66, cy: 0.46, fill: 0.74 };
  hero.resize();
  const graph = FIX.graph;
  const sources = graph.nodes.filter((n) => n.type === "source").map((n) => n.id);
  const others = graph.nodes.filter((n) => n.type !== "source").map((n) => n.id);
  const born = 1500;
  const stagger = 90;
  hero.setGraph(graph, {
    created: new Set(graph.nodes.map((n) => n.id)),
    newEdges: new Set(graph.edges.map((e) => edgeKey(e.from, e.to))),
    at: born,
    stagger,
    order: [...sources, ...others],
  });
  const h = heroCanvas.getBoundingClientRect().height || innerHeight;
  hero.setDocs(
    sources.map((id, i) => ({
      to: id,
      from: narrow() ? { x: (i + 0.5) * (innerWidth / sources.length), y: h + 80 } : { x: innerWidth + 90 + (i % 2) * 60, y: h * (0.12 + i * 0.19) },
      size: narrow() ? 0.9 : 1.25,
      label: RUN.sources[i]?.date ?? "",
      at: born + i * stagger - 1300,
      dur: 1300,
    })),
  );
}

// ---------------------------------------------------------------- theatre

const webCanvas = $<HTMLCanvasElement>("web");
const web = new Web(webCanvas, RUN.layout);
let scene = 0;
let playing = false;
let started = false;
let panelFile: string | null = null;

const sceneLen = (i: number) => (i === 0 ? Infinity : i === LINT_SCENE ? T.lintLen : i === FIX_SCENE ? T.fixLen : T.ingestLen);

function stepFor(i: number): Step | null {
  if (i >= 1 && i <= INGESTS.length) return INGESTS[i - 1];
  if (i === FIX_SCENE) return FIX;
  return null;
}

function enter(i: number) {
  const fromCam = web.cameraNow(sceneTime());
  scene = Math.max(0, Math.min(SCENES - 1, i));
  sceneStart = performance.now();
  panelFile = null;
  web.view = { cx: 0.5, cy: 0.5, fill: narrow() ? 0.96 : 0.86 };
  web.resize();
  web.highlight = new Set();
  const rest: Camera = { x: 0.5, y: 0.5, zoom: 1 };
  const startCam = FROZEN !== null ? rest : fromCam;

  if (scene === 0) {
    web.setGraph(null);
    web.setCamera(rest);
  } else if (scene === LINT_SCENE) {
    web.setGraph(LAST.graph);
    const { nodes, pairs } = lintFlags();
    web.setFlags({ nodes, pairs, at: 1500, resolve: Infinity });
    web.scan(150);
    web.moveCamera({ x: 0.5, y: 0.5, zoom: 0.96 }, 0, 1200, startCam);
  } else {
    const step = stepFor(scene)!;
    const prev = scene === FIX_SCENE ? LAST : scene > 1 ? INGESTS[scene - 2] : null;
    const created = new Set(step.changes.filter((c) => c.status === "created").map((c) => c.slug));
    const touched = new Set(step.changes.filter((c) => c.status === "updated").map((c) => c.slug));
    const before = new Set((prev?.graph.edges ?? []).map((e) => edgeKey(e.from, e.to)));
    const newEdges = new Set(step.graph.edges.map((e) => edgeKey(e.from, e.to)).filter((k) => !before.has(k)));
    web.setGraph(step.graph, { created, touched, newEdges, at: T.ignite });
    if (scene === FIX_SCENE) {
      const { nodes, pairs } = lintFlags();
      web.setFlags({ nodes, pairs, at: -5000, resolve: 400 });
    } else {
      const src = step.changes.find((c) => c.type === "source" && c.status === "created")!;
      web.setDocs([{ to: src.slug, from: queueOrigin(scene - 1), label: step.source?.slice(0, 10) ?? "", at: T.fly, dur: T.flyDur }]);
    }
    // On narrow screens the whole web barely fits, so the camera stays centred.
    const target = narrow() ? rest : web.frame([...created, ...touched], scene === FIX_SCENE ? 1 : 1.07);
    web.moveCamera(target, T.cam, T.camDur, startCam);
  }

  renderChrome();
  renderPanel();
  renderCaption();
  drawTheatre();
}

/** Pages to flag in lint: the pages holding conflicting claims, their sources, and the missing page. */
function lintFlags() {
  const nodes = new Set<string>();
  const pairs: [string, string][] = [];
  for (const f of RUN.lintBefore.findings) {
    if (f.kind === "contradiction") {
      f.claims.forEach((c) => {
        nodes.add(c.page);
        nodes.add(c.source);
      });
      const newest = [...f.claims].sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
      for (const c of f.claims) {
        if (c.source !== newest.source && !pairs.some((p) => p[0] === newest.source && p[1] === c.source)) pairs.push([newest.source, c.source]);
      }
    } else if (f.kind === "missing-page") {
      const target = /\[\[([a-z0-9-]+)\]\]/.exec(f.title)?.[1];
      if (target) nodes.add(target);
    }
  }
  return { nodes, pairs };
}

function queueOrigin(index: number): { x: number; y: number } {
  const card = document.querySelectorAll<HTMLElement>(".qcard")[index];
  const c = webCanvas.getBoundingClientRect();
  if (!card) return { x: -80, y: c.height / 2 };
  const r = card.getBoundingClientRect();
  return { x: r.left + r.width / 2 - c.left, y: r.top + r.height / 2 - c.top };
}

// ---------------------------------------------------------------- chrome: chapters, queue, stats, controls

const CHAPTERS = ["Kickoff", "Design doc", "Incident", "Chat thread", "Draft FAQ"];
const PLAY_ICON = `<svg viewBox="0 0 16 16" class="size-4" fill="currentColor"><path d="M4.5 2.8v10.4L13 8z"/></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 16 16" class="size-4" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>`;
const NEXT_ICON = `<svg viewBox="0 0 16 16" class="size-4" fill="currentColor"><path d="M5 3v10l6.5-5z"/></svg>`;

function renderChrome() {
  const actOne = scene <= INGESTS.length;
  $("act-num").textContent = actOne ? "one" : "two";
  $("act-title").textContent = actOne ? "Ingest" : scene === LINT_SCENE ? "Lint" : "Fix";

  const chap = (i: number, label: string, tone = "") => {
    const state = i < scene ? "done" : i === scene ? "now" : "todo";
    return `<li><button type="button" class="chap" data-scene="${i}" data-state="${state}" ${tone ? `data-tone="${tone}"` : ""} ${i === scene ? 'aria-current="step"' : ""}><i></i>${label}</button></li>`;
  };
  $("chapters").innerHTML = [
    ...CHAPTERS.map((l, k) => chap(k + 1, l)),
    `<li class="chap-sep" aria-hidden="true"></li>`,
    chap(LINT_SCENE, "Lint", "bad"),
    chap(FIX_SCENE, "Fix"),
    `<li class="chap-sep" aria-hidden="true"></li>`,
    `<li><a class="chap" href="#faceoff"><i></i>Face-off</a></li>`,
  ].join("");

  $("queue").innerHTML = RUN.sources
    .map((s, k) => {
      const n = k + 1;
      const state = scene > INGESTS.length || n < scene ? "done" : n === scene ? "now" : n === scene + 1 ? "next" : "todo";
      return `<li><button type="button" class="qcard" data-scene="${n}" data-state="${state}"><span class="qt">${esc(INGESTS[k].title)}</span><span class="qd">${s.date}</span></button></li>`;
    })
    .join("");

  const step = scene === LINT_SCENE ? LAST : stepFor(scene);
  const stats: [number, string][] = step
    ? [
        [step.pages.length, "pages"],
        [step.graph.edges.length, "links"],
        [step.claims.current, "claims"],
      ]
    : [
        [0, "pages"],
        [0, "links"],
        [0, "claims"],
      ];
  $("stats").innerHTML = stats.map(([n, l]) => `<div class="seq" style="--d:${scene ? T.ignite : 0}"><b>${n}</b><span>${l}</span></div>`).join("");

  ($("prev") as HTMLButtonElement).disabled = scene === 0;
  const nextBtn = $("next");
  if (scene === FIX_SCENE) {
    nextBtn.className = "ctl ctl-cta";
    nextBtn.innerHTML = `Face-off ${NEXT_ICON}`;
    nextBtn.setAttribute("aria-label", "Go to the face-off");
  } else {
    nextBtn.className = "ctl";
    nextBtn.innerHTML = NEXT_ICON;
    nextBtn.setAttribute("aria-label", "Next scene");
  }
  renderPlay();
}

function renderPlay() {
  const btn = $("play");
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
}

// ---------------------------------------------------------------- subtitles

interface Beat {
  kicker: string;
  line: string;
  at: number;
}

function beats(): Beat[] {
  if (scene === 0) {
    return [{ at: 0, kicker: "Before the first source", line: "The wiki is empty. <b>Five raw sources</b> are waiting to be filed." }];
  }
  if (scene === LINT_SCENE) {
    const c = RUN.lintBefore.checks.find((x) => x.kind === "contradiction")!.count;
    const m = RUN.lintBefore.checks.find((x) => x.kind === "missing-page")!.count;
    return [
      { at: 0, kicker: "Lint · reads every claim at once", line: `Lint compares all ${LAST.claims.current} current claims across ${LAST.pages.length} pages.` },
      { at: 1500, kicker: "Lint · computed", line: `<span class="bad">${plural(c, "contradiction")}</span> and ${plural(m, "link")} to a page that doesn't exist.` },
      { at: 3300, kicker: "Lint · why no ingest caught it", line: "Each ingest only saw the pages it opened. The draft FAQ disagrees with the approved design and Amara's decision." },
    ];
  }
  const step = stepFor(scene)!;
  const created = step.changes.filter((c) => c.status === "created").length;
  const updated = step.changes.length - created;
  const prev = scene === FIX_SCENE ? LAST : scene > 1 ? INGESTS[scene - 2] : null;
  const newLinks = step.graph.edges.length - (prev?.graph.edges.length ?? 0);
  if (scene === FIX_SCENE) {
    return [
      { at: 0, kicker: "Fix · approved by a person", line: "The proposed fixes are approved." },
      { at: T.beats[1], kicker: "Fix · scripted edits", line: esc(step.caption) },
      {
        at: T.beats[2] + 400,
        kicker: "Lint again · computed",
        line: `<span class="good">${plural(RUN.lintAfter.findings.length, "problem")}</span>. The draft's claims stay visible, marked disputed.`,
      },
    ];
  }
  return [
    { at: T.beats[0], kicker: `Source ${scene} of ${INGESTS.length} · ${RUN.sources[scene - 1].date}`, line: `<b>${esc(step.title)}</b> arrives.` },
    {
      at: T.beats[1],
      kicker: "Ingest · computed from the agent's edits",
      line: `${created ? `It creates ${plural(created, "page")}` : "No new pages"}${updated ? ` and rewrites ${updated}` : ""}. <b>${plural(newLinks, "new link")}</b>.`,
    },
    { at: T.beats[2], kicker: "Ingest · what changed", line: esc(step.caption) },
  ];
}

function renderCaption() {
  const list = beats();
  $("caption").innerHTML = list
    .map((b, i) => {
      const end = list[i + 1]?.at;
      return `<div class="beat" style="--d:${b.at};${end !== undefined ? `--e:${end - 250}` : ""}"><div class="beat-kicker">${b.kicker}</div><div class="beat-line">${b.line}</div></div>`;
    })
    .join("");
}

// ---------------------------------------------------------------- the panel: what the agent wrote

function renderPanel() {
  const panel = $("panel");
  if (scene === 0) {
    panel.innerHTML = `<div class="panel-head"><div class="panel-kicker">How to watch</div></div>
      <div class="panel-body px-4 py-3 text-[14px] leading-relaxed text-[var(--ink-2)]">
        <p>Press play. Each source flies into the web and the agent files it: it <span style="color:var(--new)">creates</span> pages for new people, systems and policies, <span style="color:var(--edit)">rewrites</span> the pages that already exist, and links them.</p>
        <p class="mt-3">Its edits appear here as they happen. Old values are <span class="md-struck">struck through</span>, never deleted.</p>
        <p class="mt-3 text-[13px] text-[var(--muted)]"><span class="tag tag-scripted">Scripted</span> pages, written by hand. <span class="tag tag-computed">Computed</span> diffs, links, lint and retrieval.</p>
      </div>`;
    return;
  }
  if (scene === LINT_SCENE) {
    panel.innerHTML = lintPanel();
    return;
  }
  const step = stepFor(scene)!;
  const special = `<button type="button" class="touch-chip" data-file="@index" aria-pressed="${panelFile === "@index"}"><i style="background:var(--accent)"></i>index.md</button><button type="button" class="touch-chip" data-file="@log" aria-pressed="${panelFile === "@log"}"><i style="background:var(--accent)"></i>log.md</button>`;
  const chips = step.changes
    .map(
      (c) =>
        `<button type="button" class="touch-chip" data-file="${c.slug}" aria-pressed="${c.slug === panelFile || (panelFile === null && c.slug === step.focus)}"><i style="background:${c.status === "created" ? "var(--new)" : "var(--edit)"}"></i>${esc(c.slug)}</button>`,
    )
    .join("");
  if (panelFile === "@index" || panelFile === "@log") {
    // index.md and log.md as they stand after this step, with the lines this step added typed in.
    const prevStep = scene === FIX_SCENE ? LAST : scene > 1 ? INGESTS[scene - 2] : null;
    const isIndex = panelFile === "@index";
    const text = isIndex ? step.index : step.log;
    const old = new Set(((isIndex ? prevStep?.index : prevStep?.log) ?? "").split("\n"));
    let d = 0;
    const rows = text
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => {
        const html = mdLine(line) || "&nbsp;";
        if (old.has(line) || !line.trim()) return `<div class="pl" data-op="same"><span class="pl-sign"> </span><span class="pl-text">${html}</span></div>`;
        const at = d;
        d += 90;
        return `<div class="pl seq-wipe" data-op="add" style="--d:${at};--dur:${Math.round(clamp(line.length * 6, 160, 420))}ms"><span class="pl-sign">+</span><span class="pl-text">${html}</span></div>`;
      })
      .join("");
    panel.innerHTML = `<div class="panel-head"><div class="flex items-center justify-between gap-3"><span class="panel-kicker">${isIndex ? "Rebuilt after every change" : "Append-only"}</span><span class="tag tag-computed">computed</span></div>
        <div class="panel-path"><span>wiki/${isIndex ? "index.md" : "log.md"}</span></div></div>
      <div class="panel-body code">${rows}</div>
      <div class="panel-foot">${special}${chips}</div>`;
    const body = panel.querySelector<HTMLElement>(".panel-body")!;
    const added = panel.querySelectorAll<HTMLElement>(".pl[data-op='add']");
    const lastAdded = added[added.length - 1];
    if (lastAdded) body.scrollTop = Math.max(0, lastAdded.offsetTop + lastAdded.offsetHeight - body.clientHeight + 24);
    return;
  }
  const change = step.changes.find((c) => c.slug === (panelFile ?? step.focus)) ?? step.changes[0];
  const animated = panelFile === null;
  const base = animated ? T.panel : 0;
  panel.innerHTML = `<div class="panel-head seq" style="--d:${animated ? T.panel - 300 : 0}">
      <div class="flex items-center justify-between gap-3"><span class="panel-kicker">${scene === FIX_SCENE ? "The fix rewrites" : "The agent writes"}</span><span class="tag ${change.status === "created" ? "tag-new" : "tag-edit"}">${change.status === "created" ? "new page" : "edited"}</span></div>
      <div class="panel-path"><span>wiki/${esc(change.path)}</span><span class="ml-auto shrink-0 text-[11px] text-[var(--muted)]"><span style="color:var(--new)">+${change.added}</span> <span style="color:var(--bad)">−${change.removed}</span></span></div>
    </div>
    <div class="panel-body code ${animated ? "seq" : ""}" style="--d:${T.panel - 300}">${diffRows(change.diff, base, change.status === "created")}</div>
    <div class="panel-foot seq" style="--d:${animated ? T.panel : 0}">${special}${chips}</div>`;
  // Keep the last edit in view: that is where the old value gets struck through.
  const body = panel.querySelector<HTMLElement>(".panel-body");
  const changedRows = panel.querySelectorAll<HTMLElement>(".pl[data-op='add'], .pl[data-op='del']");
  const last = changedRows[changedRows.length - 1];
  if (body && last) body.scrollTop = Math.max(0, last.offsetTop + last.offsetHeight - body.clientHeight + 24);
}

/** Diff rows with typed-in additions and struck-through removals, folding long unchanged runs. */
function diffRows(full: DiffLine[], base: number, created: boolean): string {
  // Front matter (between the first two "---" lines) is bookkeeping: fold it into one row.
  const fences = full.map((x, k) => (x.text === "---" && x.op !== "del" ? k : -1)).filter((k) => k >= 0);
  let diff = full;
  let front = "";
  if (fences.length >= 2) {
    const meta = full.slice(fences[0] + 1, fences[1]);
    const changedKeys = [...new Set(meta.filter((x) => x.op !== "same").map((x) => x.text.split(":")[0]))];
    front = `<div class="pl-fold">⋯ front matter${changedKeys.length ? ` ${created ? "written" : "updated"}: ${changedKeys.join(", ")}` : ""}</div>`;
    diff = full.slice(fences[1] + 1);
  }
  const rows: string[] = front ? [front] : [];
  let d = base;
  const ctx = 2;
  const changed = diff.filter((x) => x.op !== "same").length;
  const pace = created ? Math.min(90, 1300 / Math.max(changed, 1)) : Math.min(260, 1400 / Math.max(changed, 1));
  const row = (x: DiffLine) => {
    const html = mdLine(x.text) || "&nbsp;";
    if (x.op === "same") return `<div class="pl" data-op="same"><span class="pl-sign"> </span><span class="pl-text">${html}</span></div>`;
    const dur = Math.round(clamp(x.text.length * 8, 200, 560));
    const at = Math.round(d);
    d += pace;
    if (x.op === "add") return `<div class="pl seq-wipe" data-op="add" style="--d:${at};--dur:${dur}ms"><span class="pl-sign">+</span><span class="pl-text">${html}</span></div>`;
    return `<div class="pl strike" data-op="del" style="--d:${at}"><span class="pl-sign">−</span><span class="pl-text">${html}</span></div>`;
  };
  let i = 0;
  while (i < diff.length) {
    if (diff[i].op !== "same") {
      rows.push(row(diff[i++]));
      continue;
    }
    let j = i;
    while (j < diff.length && diff[j].op === "same") j++;
    const run = diff.slice(i, j);
    const head = i === 0 ? 0 : ctx;
    const tail = j === diff.length ? 0 : ctx;
    if (run.length > head + tail + 1) {
      run.slice(0, head).forEach((x) => rows.push(row(x)));
      rows.push(`<div class="pl-fold">⋯ ${run.length - head - tail} unchanged lines</div>`);
      run.slice(run.length - tail).forEach((x) => rows.push(row(x)));
    } else run.forEach((x) => rows.push(row(x)));
    i = j;
  }
  return rows.join("");
}

function lintPanel(): string {
  const cards: string[] = [];
  let d = 1700;
  for (const f of RUN.lintBefore.findings) {
    if (f.kind === "contradiction") {
      const key = f.claims.map((c) => c.key).sort((a, b) => a.length - b.length)[0];
      cards.push(`<div class="claim-card seq" data-tone="bad" style="--d:${d}">
        <div class="flex items-center justify-between gap-2"><span class="tag tag-bad">Contradiction</span><span class="font-mono text-[11px] text-[var(--muted)]">${esc(key)}</span></div>
        <div class="mt-2 grid gap-2" style="grid-template-columns:repeat(${f.claims.length},minmax(0,1fr))">${f.claims
          .map(
            (c) =>
              `<div><div class="claim-value" style="${c.source === "src-faq-draft" ? "color:var(--bad)" : ""}">${esc(c.value.replace(" at 02:00 UTC", ""))}</div><div class="claim-meta">${esc(c.source.replace("src-", ""))}</div></div>`,
          )
          .join("")}</div>
      </div>`);
    } else {
      cards.push(`<div class="claim-card seq" style="--d:${d}">
        <span class="tag tag-bad">Missing page</span>
        <div class="mt-2 text-[14px]">${esc(f.title.replace(/\[\[|\]\]/g, ""))}</div>
        <div class="claim-meta">${esc(f.detail)}</div>
      </div>`);
    }
    d += 260;
  }
  return `<div class="panel-head"><div class="panel-kicker">Lint · all pages, all claims</div>
      <div class="panel-path"><span>${RUN.lintBefore.findings.length} findings in ${LAST.pages.length} pages</span></div></div>
    <div class="panel-body">${cards.join("")}
      <p class="seq mx-4 mt-4 text-[13px] leading-relaxed text-[var(--ink-2)]" style="--d:${d + 200}">Lint doesn't keep the newest value: the newest here is the draft's, and it is wrong. It proposes fixes and a person decides.</p>
    </div>
    <div class="panel-foot seq" style="--d:${d + 200}"><span class="tag tag-computed">Computed by src/lint.ts</span></div>`;
}

// ---------------------------------------------------------------- playback

function goFaceoff() {
  playing = false;
  renderPlay();
  document.getElementById("faceoff")!.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
}

function next() {
  if (scene >= FIX_SCENE) goFaceoff();
  else enter(scene + 1);
}

function prev() {
  if (scene > 0) enter(scene - 1);
}

function togglePlay() {
  playing = !playing;
  started = true;
  if (playing && (scene === 0 || (scene === FIX_SCENE && sceneTime() > sceneLen(scene)))) enter(1);
  renderPlay();
}

function drawTheatre() {
  const t = sceneTime();
  web.render(t, wallTime(), FROZEN !== null || REDUCED);
  const len = sceneLen(scene);
  $("progress").style.width = Number.isFinite(len) ? `${clamp(t / len) * 100}%` : "0%";
  if (playing && FROZEN === null && t > len) {
    if (scene >= FIX_SCENE) {
      playing = false;
      renderPlay();
    } else enter(scene + 1);
  }
}

// ---------------------------------------------------------------- the face-off

let question = RUN.questions.some((q) => q.id === params.get("ask")) ? params.get("ask")! : RUN.questions[0].id;

function renderQuestions() {
  $("questions").innerHTML = RUN.questions
    .map((q) => `<button type="button" role="tab" class="qtab" data-q="${q.id}" aria-selected="${q.id === question}">${esc(q.text)}</button>`)
    .join("");
}

const highlights = (facts: FactResult[]): Highlight[] => facts.map((f) => ({ pattern: f.pattern, tone: f.kind === "needed" ? "good" : "bad" }));
const neededOf = (f: FactResult[]) => f.filter((x) => x.kind === "needed");
const wrongFound = (f: FactResult[]) => f.filter((x) => x.kind === "wrong" && x.found).length;

function renderFaceoff() {
  const q = RUN.questions.find((x) => x.id === question)!;
  $("arena").innerHTML = fighter(q, "wiki") + fighter(q, "rag");
  $("verdict").innerHTML = verdictHtml(q);
}

function fighter(q: QuestionResult, side: "wiki" | "rag"): string {
  const facts = side === "wiki" ? q.wikiFacts : q.ragFacts;
  const hl = highlights(facts);
  const need = neededOf(facts);
  const found = need.filter((f) => f.found).length;
  const bad = wrongFound(facts);
  const hitAt = (i: number) => 450 + i * 260;
  const hits =
    side === "wiki"
      ? q.wiki
          .map((p, i) => {
            const lines = p.lines.filter((l) => l.struck || hl.some((h) => new RegExp(h.pattern, "i").test(l.text)));
            const shown = (lines.length ? lines : p.lines.filter((l) => !l.text.startsWith("#")).slice(0, 3)).slice(0, 7);
            return `<div class="hit seq" style="--d:${hitAt(i)}">
              <div class="hit-head"><div><div class="hit-path">wiki/${esc(p.path)}</div><div class="hit-sub">${esc(p.lines.find((l) => l.text.startsWith("# "))?.text.slice(2) ?? "")}</div></div><span class="hit-score">BM25 ${p.score.toFixed(2)}</span></div>
              <div class="hit-body code">${shown.map((l) => `<div class="pl"><span class="pl-text">${mdLine(l.text, l.struck ? [] : hl)}</span></div>`).join("")}</div>
            </div>`;
          })
          .join("")
      : q.rag
          .map((c, i) => {
            const wrong = q.ragFacts.filter((f) => f.kind === "wrong" && f.where.includes(c.id));
            const title = RUN.sources.find((s) => s.file === c.file)?.title ?? "";
            return `<div class="hit seq" style="--d:${hitAt(i)}" ${wrong.length ? 'data-tone="bad"' : ""}>
              <div class="hit-head"><div><div class="hit-path">raw/${esc(c.file)}</div><div class="hit-sub">${esc(title)}${c.heading ? ` › ${esc(c.heading)}` : ""}</div></div><span class="flex flex-col items-end gap-1"><span class="hit-score">BM25 ${c.score.toFixed(2)}</span>${wrong.length ? '<span class="tag tag-bad">outdated</span>' : ""}</span></div>
              <div class="hit-body code">${c.text
                .split("\n")
                .map((l) => `<div class="pl"><span class="pl-text">${mdLine(l, hl)}</span></div>`)
                .join("")}</div>
              ${wrong.length ? `<div class="hit-note">${wrong.map((w) => esc(w.why ?? "")).join(" · ")}</div>` : ""}
            </div>`;
          })
          .join("");
  const factRows = facts
    .filter((f) => f.kind === "needed" || f.found)
    .map((f, i) => {
      const ok = f.kind === "needed" && f.found;
      return `<div class="fact seq" data-ok="${ok}" style="--d:${1350 + i * 140}"><i>${ok ? "✓" : "!"}</i><span>${esc(f.kind === "needed" && !f.found ? `${f.label} (missing)` : f.label)}${f.kind === "wrong" && f.why ? `<small>${esc(f.why)}</small>` : ""}</span></div>`;
    })
    .join("");
  const scores = `<div class="scores">
      <div class="score seq" data-tone="${found === need.length ? "good" : "bad"}" style="--d:2000"><b>${found}/${need.length}</b><span>facts the answer needs</span></div>
      <div class="score seq" data-tone="${bad ? "bad" : "good"}" style="--d:2150"><b>${bad}</b><span>outdated or wrong statements</span></div>
    </div>`;
  const answer =
    side === "wiki"
      ? `<div class="answer seq" style="--d:2400"><div class="mb-1 flex items-center gap-2"><span class="panel-kicker">Example answer</span><span class="tag tag-scripted">Scripted</span></div>${esc(q.wikiAnswer)}</div>`
      : "";
  return `<article class="fighter seq" data-side="${side}" style="--d:${side === "wiki" ? 0 : 120}">
    <div class="fighter-name">${side === "wiki" ? "Wiki memory" : "Chunk RAG"}</div>
    <div class="fighter-how">${side === "wiki" ? `Top ${RUN.k.pages} topic pages, ranked by BM25` : `Top ${RUN.k.chunks} of ${RUN.chunkCount} raw paragraph chunks, ranked by BM25`}</div>
    <div class="hit-list">${hits}</div>
    <div class="facts">${factRows}</div>
    ${scores}
    ${answer}
  </article>`;
}

function verdictHtml(q: QuestionResult): string {
  const total = neededOf(q.wikiFacts).length;
  const rNeed = neededOf(q.ragFacts).filter((f) => f.found).length;
  const rWrong = wrongFound(q.ragFacts);
  let line: string;
  let sub: string;
  if (rWrong > 0) {
    line = `Both found the answer. Only chunk RAG <em>also brought back ${plural(rWrong, "outdated statement")}</em>.`;
    sub = "Nothing in the chunks says which version is current, so the model has to work it out on every question. The wiki settled it once, when the sources were ingested.";
  } else if (rNeed < total) {
    line = `The wiki pages hold <em>all ${total} facts</em>; the top chunks hold ${rNeed}.`;
    sub = "A compiled page gathers facts that are spread across several sources.";
  } else {
    line = `A draw. When one source holds the whole answer, <em>chunk RAG is enough</em>.`;
    sub = "Wiki memory pays off when sources change or disagree. For a single-source lookup it adds upkeep without a better answer.";
  }
  return `<p class="eyebrow seq" style="--d:2700">Verdict · computed</p><p class="verdict-line seq mt-3" style="--d:2800">${line}</p><p class="verdict-sub seq" style="--d:3050">${sub}</p>`;
}

// ---------------------------------------------------------------- wiring

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-scene], [data-file], [data-q], #play, #next, #prev, #cta, #theme");
  if (!el) return;
  if (el.id === "play") togglePlay();
  else if (el.id === "next") next();
  else if (el.id === "prev") prev();
  else if (el.id === "cta") {
    document.getElementById("theatre")!.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
    started = true;
    playing = true;
    setTimeout(() => enter(1), REDUCED ? 0 : 450);
  } else if (el.id === "theme") toggleTheme();
  else if (el.dataset.scene) {
    playing = false;
    started = true;
    enter(Number(el.dataset.scene));
  } else if (el.dataset.file) {
    panelFile = el.dataset.file;
    renderPanel();
  } else if (el.dataset.q) {
    question = el.dataset.q;
    renderQuestions();
    renderFaceoff();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const r = document.getElementById("theatre")!.getBoundingClientRect();
  if (r.bottom < innerHeight * 0.3 || r.top > innerHeight * 0.7) return;
  if (e.key === "ArrowRight") {
    playing = false;
    next();
  } else if (e.key === "ArrowLeft") {
    playing = false;
    prev();
  } else if (e.key === " " && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    togglePlay();
  }
});

function toggleTheme() {
  const nextTheme = root.dataset.theme === "light" ? "dark" : "light";
  root.dataset.theme = nextTheme;
  try {
    localStorage.setItem("wiki-memory-theme", nextTheme);
  } catch {
    // Storage may be unavailable; the theme still applies for this visit.
  }
  hero.refreshPalette();
  web.refreshPalette();
  drawAll();
}

const visible = { hero: true, theatre: false, faceoff: false };
let faceoffShown = false;
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      const id = en.target.id as keyof typeof visible;
      visible[id] = en.isIntersecting;
      if (id === "theatre" && en.intersectionRatio >= 0.5 && !started && FROZEN === null) {
        started = true;
        playing = true;
        enter(1);
      }
      if (id === "faceoff" && en.isIntersecting && !faceoffShown) {
        faceoffShown = true;
        renderFaceoff();
      }
    }
  },
  { threshold: [0, 0.5] },
);
["hero", "theatre", "faceoff"].forEach((id) => io.observe(document.getElementById(id)!));

function drawAll() {
  hero.render(heroTime(), wallTime(), FROZEN !== null || REDUCED);
  drawTheatre();
}

function loop() {
  if (visible.hero) hero.render(heroTime(), wallTime());
  if (visible.theatre) drawTheatre();
  requestAnimationFrame(loop);
}

let resizeTimer = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    setupHero();
    web.view.fill = narrow() ? 0.96 : 0.86;
    web.resize();
    drawAll();
  }, 120);
});

// ---------------------------------------------------------------- start

$("about-chunks").textContent = String(RUN.chunkCount);
renderQuestions();
setupHero();
if (params.has("scene")) started = true;
enter(params.has("scene") ? Number(params.get("scene")) || 0 : 0);
if (params.has("file") && scene > 0) {
  panelFile = params.get("file");
  renderPanel();
}
if (params.has("ask")) {
  faceoffShown = true;
  renderFaceoff();
}
const jump = params.has("ask") ? "faceoff" : params.has("scene") ? "theatre" : null;
// Review hook: ?solo shows only the section being reviewed, so headless screenshots start at its top.
if (jump && params.has("solo")) {
  for (const id of ["hero", "theatre", "faceoff", "about"]) if (id !== jump) document.getElementById(id)!.hidden = true;
  if (jump === "theatre") {
    enter(scene);
    if (params.has("file")) {
      panelFile = params.get("file");
      renderPanel();
    }
  }
}
if (jump) {
  root.style.scrollBehavior = "auto";
  document.getElementById(jump)!.scrollIntoView();
  root.style.scrollBehavior = "";
}
document.fonts?.ready.then(() => {
  setupHero();
  web.resize();
  drawAll();
});
if (FROZEN !== null || REDUCED) drawAll();
else requestAnimationFrame(loop);
