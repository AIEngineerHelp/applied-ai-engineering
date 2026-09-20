const $ = (s: string): any => document.querySelector(s);
const money = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const pretty = (s) => String(s).replaceAll("_", " ");
let config: any,
  controller: AbortController,
  report: any = null,
  running = false;
let teams: Record<string, any> = {};
let currentRunId = null,
  viewedCatalog = null;
let publishedBenchmark: any = null;
let challengeBenchmark: any = null;
const expandedEvents = new Set();
let inspectionOpen = false;
const labels = { baseline: "Gemini", hybrid: "Gemini + Typesafe" };
function sourcePlaces(team) {
  return team.events.filter((event) => event.type === "tool")
    .flatMap((event) => event.response ?? []);
}
function qualityHtml(team, plan, review) {
  if (!plan || !review) return "";
  const checks = review.checks ?? [];
  const check = (label) => checks.find((item) => item.label === label);
  const ids = [...new Set(plan.days.flatMap((day) => [...day.activities, day.meal]))];
  const known = sourcePlaces(team);
  const sourced = ids.filter((id) => known.find((place) => place.id === id)?.source?.uri).length;
  const budget = check("Within day-plan budget");
  const diet = check("Dietary preference");
  const item = (name, value, passed) => `<div class="quality-item ${passed === false ? "quality-fail" : ""}"><span>${escape(name)}</span><strong>${escape(value)}</strong></div>`;
  return `<section class="quality-strip" aria-label="Trip quality checks">${item("Budget", budget ? budget.passed ? "Within budget" : "Over budget" : "Not checked", budget?.passed)}${item("Diet", diet ? diet.passed ? "Matches brief" : "Needs attention" : "Not checked", diet?.passed)}${item("Source links", sourced ? `${sourced}/${ids.length} linked` : "Not recorded", null)}${item("Checks", `${checks.filter((c) => c.passed).length}/${checks.length} passed`, review.passed)}</section><p class="quality-note">Venue details and prices are research estimates, not verified bookings or availability.</p>`;
}
function initTeams() {
  teams = {
    baseline: { events: [], status: "ready", logOpen: false },
    hybrid: { events: [], status: "ready", logOpen: false },
  };
  render();
}
function activityLabel(event, team) {
  if (event.type === "decision") return event.kind === "agent" ? `Handed off to ${pretty(event.choice)}` : `Selected ${pretty(event.choice)}`;
  if (event.type === "model_start") {
    if (event.stage === "coordination")
      return `${event.provider === "jev" ? "Jev" : "Gemini"} is choosing the next action`;
    if (team.agent === "researcher") return "Finding places that match the trip";
    if (team.agent === "planner") return "Building the day-by-day itinerary";
    if (team.agent === "reviewer") return "Checking the itinerary against every requirement";
    return `${event.provider === "jev" ? "Jev" : "Gemini"} is working on the trip`;
  }
  if (event.type === "call") return `${event.call.provider === "jev" ? "Jev" : "Gemini"} responded in ${(event.call.ms / 1000).toFixed(1)}s`;
  if (event.type === "tool_start") return `Running ${pretty(event.tool)}`;
  if (event.type === "tool") return `${pretty(event.tool)} returned ${event.count} options`;
  if (event.type === "plan") return "Drafted the itinerary";
  if (event.type === "review") return event.review.passed ? "Trip checks passed" : "Review found changes";
  if (event.type === "validation_error") return event.message;
  return null;
}
function liveEventSummary(event) {
  if (event.type === "call")
    return {
      provider: event.call.provider,
      title: `${event.call.provider === "jev" ? "Jev" : "Gemini"} · ${event.call.stage}`,
      detail: `${event.call.ms} ms · ${event.call.inputTokens ?? "?"} input / ${event.call.outputTokens ?? "?"} output tokens · ${event.call.model}`,
    };
  if (event.type === "decision")
    return {
      provider: event.confidence !== undefined ? "jev" : null,
      title: `${event.kind === "agent" ? "Agent" : "Tool"} → ${pretty(event.choice)}`,
      detail:
        event.confidence !== undefined
          ? `Jev confidence ${(event.confidence * 100).toFixed(1)}% · distribution concentration, not accuracy`
          : event.source ?? "Structured selection",
    };
  if (event.type === "tool_start")
    return {
      provider: null,
      title: `Start ${pretty(event.tool)}`,
      detail: `Step ${event.step} · ${event.agent}`,
    };
  if (event.type === "tool")
    return {
      provider: null,
      title: pretty(event.tool),
      detail: `${event.count} places found · Search ID: ${event.searchId ?? "unavailable"}`,
    };
  if (event.type === "tool_end")
    return {
      provider: null,
      title: `${pretty(event.tool)} · ${event.error ? "failed" : "finished"}`,
      detail: `${event.ms} ms · step ${event.step}${event.error ? ` · ${event.error}` : ""}`,
    };
  if (event.type === "plan")
    return { provider: null, title: "Planner produced an itinerary", detail: event.plan.title };
  if (event.type === "review")
    return {
      provider: null,
      title: "Reviewer checked the itinerary",
      detail: event.review.passed ? "All deterministic checks passed" : event.review.issues.join(" "),
    };
  if (event.type === "validation_error")
    return { provider: null, title: "Validation error", detail: event.message };
  return null;
}
function activityHtml(team) {
  const activity = team.events
    .map((event) => activityLabel(event, team))
    .filter(Boolean)
    .slice(-3);
  if (team.status !== "running") return "";
  const current = activity.at(-1) ?? "Starting the run";
  const selectedPhase = { researcher: 0, planner: 1, reviewer: 2 }[team.agent];
  const activePhase = selectedPhase ??
    (team.events.some((event) => event.type === "review")
      ? 2
      : team.events.some((event) => event.type === "plan")
        ? 1
        : 0);
  const phaseStatus = ["Researching the trip", "Building the itinerary", "Reviewing the result"][activePhase];
  const phases = ["Research", "Plan", "Review"]
    .map((phase, index) => `<span class="phase ${index < activePhase ? "done" : index === activePhase ? "active" : ""}"><i>${index < activePhase ? "✓" : ""}</i><b>${phase}</b></span>`)
    .join("");
  const liveEvents = team.events
    .map((event) => ({ event, summary: liveEventSummary(event) }))
    .filter(({ summary }) => summary)
    .slice(-6)
    .reverse();
  const feed = liveEvents.length
    ? liveEvents
        .map(({ event, summary }, index) => `<div class="live-event ${index === 0 ? "latest" : ""}"><time>+${(event.atMs / 1000).toFixed(2)}s</time><span class="live-event-copy">${summary.provider ? `<b class="provider-badge ${summary.provider}">${summary.provider === "jev" ? "Jev" : "Gemini"}</b>` : ""}<strong>${escape(summary.title)}</strong><small>${escape(summary.detail)}</small></span></div>`)
        .join("")
    : `<div class="live-event latest"><time>+0.00s</time><span class="live-event-copy"><strong>${escape(current)}</strong><small>Waiting for the first model response</small></span></div>`;
  return `<section class="agent-working is-running" aria-label="Live agent activity"><div class="working-heading"><span class="working-status"><i></i>${escape(phaseStatus)}</span><span class="event-count">${team.events.length} recorded · latest ${liveEvents.length} shown</span></div><div class="phase-track">${phases}</div><div class="live-feed" role="log" aria-live="polite" aria-label="Latest execution events">${feed}</div></section>`;
}
function render() {
  $("#teams").innerHTML = Object.entries(teams)
    .map(([id, t]) => {
      const r = t.result,
        plan = r?.plan ?? t.plan,
        review = r?.review ?? t.review;
      const providerCalls = t.events
        .filter((event) => event.type === "call")
        .reduce(
          (counts, event) => {
            const provider = event.call?.provider;
            if (provider === "gemini" || provider === "jev") counts[provider]++;
            return counts;
          },
          { gemini: 0, jev: 0 },
        );
      const callBreakdown = [
        providerCalls.gemini ? `${providerCalls.gemini} Gemini` : "",
        providerCalls.jev ? `${providerCalls.jev} Jev` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const resultStats = r
        ? `<div class="result-stats"><div class="result-stat result-stat-primary"><span>Coordination time</span><strong>${r.metrics.decisionMs == null ? "—" : (r.metrics.decisionMs / 1000).toFixed(1)}${r.metrics.decisionMs == null ? "" : "<small>s</small>"}</strong><p>Time spent choosing agents and tools</p></div><div class="result-stat"><span>Total time</span><strong>${(r.metrics.wallMs / 1000).toFixed(1)}<small>s</small></strong><p>End-to-end run</p></div><div class="result-stat"><span>Model calls</span><strong>${r.metrics.modelCalls}</strong><p>${escape(callBreakdown || "Provider calls")}</p></div></div>`
        : "";
      const planHtml = plan
        ? `<div class="result-heading"><span>${t.status === "completed" ? "Final itinerary" : "Draft itinerary"}</span>${review ? `<span>${review.checks.filter((check) => check.passed).length}/${review.checks.length} checks passed</span>` : ""}</div>${qualityHtml(t, plan, review)}<div class="trip-total">${review ? money(review.total) : "Draft itinerary"}<span>${review ? "estimated for your group" : "Cost checked after review"}</span></div><h4 class="plan-title">${escape(plan.title)}</h4><p class="plan-summary">${escape(plan.summary)}</p>${plan.days
            .map((day) => {
              const checked = review?.days?.find((d) => d.day === day.day);
              return `<section class="day"><div class="day-heading"><span>DAY ${day.day.toString().padStart(2, "0")}</span><span>${checked ? money(checked.cost) : "Draft"}</span></div>${[
                ...day.activities,
                day.meal,
              ]
                .map((placeId, i) => {
                  const p = t.events.filter((event) => event.type === "tool")
                    .flatMap((event) => event.response ?? [])
                    .find((place) => place.id === placeId) ??
                    (viewedCatalog ?? config?.catalogs?.[$("#destination").value])?.places.find((place) => place.id === placeId);
                  return `<div class="stop-item"><span class="stop-order">${i === 2 ? "↳" : String(i + 1).padStart(2, "0")}</span><div><span class="stop-name">${escape(p?.name ?? placeId)}</span><span class="stop-meta">${p ? `${escape(p.area)} · ${p.indoor ? "Indoor" : "Outdoor"} · ${money(p.price)} / person${p.source ? " estimated" : ""}` : "Unresolved place ID"}</span>${p?.source?.uri ? `<a href="${escape(p.source.uri)}" target="_blank" rel="noopener noreferrer">Research source ↗</a>` : ""}</div></div>`;
                })
                .join(
                  "",
                )}<p class="day-note">${escape(day.note)}</p></section>`;
            })
            .join(
              "",
            )}${review ? `<details class="checks"><summary>Trip checks · ${review.checks.filter((c) => c.passed).length}/${review.checks.length} passed</summary>${review.checks.map((c) => `<div class="check ${c.passed ? "pass" : "fail"}"><span>${c.passed ? "✓" : "×"}</span>${escape(c.label)}</div>`).join("")}${review.issues.map((i) => `<p class="review-note fail">${escape(i)}</p>`).join("")}<p class="review-note">${escape(review.specialist?.feedback)}</p></details>` : ""}`
        : t.status === "running"
          ? `<div class="output-waiting"><span>ITINERARY OUTPUT</span><h4>Building the first draft</h4><p>The day-by-day plan will appear here as soon as the planner has enough evidence.</p><div class="output-lines" aria-hidden="true"><i></i><i></i><i></i></div></div>`
          : `<div class="empty"><div class="empty-icon"><svg aria-hidden="true" viewBox="0 0 64 64" fill="none"><path d="M17 45c8-4 18 4 27-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 5"/><path d="M44 43c0-8 7-12 7-19a7 7 0 0 0-14 0c0 7 7 11 7 19Z" stroke="currentColor" stroke-width="2"/><circle cx="44" cy="24" r="2.5" fill="currentColor"/><circle cx="15" cy="45" r="3" fill="currentColor"/></svg></div><h4>Your itinerary starts here</h4><p>Choose a destination and run the comparison to see what this team plans.</p></div>`;
      return `<article class="team ${id}" aria-label="${labels[id]} planner"><div class="team-top"><div class="team-id"><span class="pill ${t.status}">${escape(pretty(t.status))}</span></div><h3>${labels[id]}</h3><p>${id === "baseline" ? "Gemini coordinates and builds the trip." : "Jev coordinates. Gemini builds the trip."}</p></div><div class="team-body">${activityHtml(t)}${t.status !== "running" && t.message ? `<p class="run-message">${escape(t.message)}</p>` : ""}${resultStats}${planHtml}</div></article>`;
    })
    .join("");
  renderMetrics();
}
function timelineHtml(events, team) {
  const groups=new Map();let inferred=1;
  const completedCalls=new Set(events.filter(e=>e.type==='call'&&e.call.callId).map(e=>e.call.callId));
  for(let index=0;index<events.length;index++){
    const e=events[index];
    if(e.type==='start')continue;
    if(e.step)inferred=e.step;
    const step=e.step??inferred;
    // Completed model calls already contain request and response; show one row per call.
    if(e.type==='model_start'&&completedCalls.has(e.callId))continue;
    if(!groups.has(step))groups.set(step,[]);
    groups.get(step).push({event:e,index});
    if(!e.step&&e.type==='tool_end')inferred++;
  }
  const counts={gemini:0,jev:0};events.filter(e=>e.type==='call').forEach(e=>{if(e.call.provider in counts)counts[e.call.provider]++;});
  return `<div class="timeline-legend"><span class="provider-badge gemini">Gemini · ${counts.gemini} calls</span><span class="provider-badge jev">Jev · ${counts.jev} calls</span><span>Expand a step to inspect calls and results</span></div>`+[...groups].map(([step,items])=>{
    const agent=items.find(x=>x.event.kind==='agent')?.event.choice;
    const tool=items.find(x=>x.event.kind==='tool')?.event.choice??items.find(x=>x.event.tool)?.event.tool;
    const calls=items.filter(x=>x.event.type==='call');
    const first=items[0].event.atMs,last=items.at(-1).event.atMs;
    const failed=items.some(x=>x.event.error||x.event.call?.error||x.event.type==='validation_error');
    const key=`${team}-step-${step}`;
    const providers=[...new Set(calls.map(x=>x.event.call.provider))];
    return `<details class="step-record" data-event="${key}" ${expandedEvents.has(key)?'open':''}><summary><span class="step-number">${String(step).padStart(2,'0')}</span><span class="step-description"><strong>${escape(tool?pretty(tool):agent?pretty(agent):'Coordination')}</strong><small>${escape(agent??'Agent selection')} · ${calls.length} model calls · +${(first/1000).toFixed(1)}s–${(last/1000).toFixed(1)}s</small></span><span class="step-meta">${providers.map(p=>`<i class="provider-dot ${p==='jev'?'jev':'gemini'}" aria-label="${escape(p)}"></i>`).join('')}<span>${failed?'Needs attention':((last-first)/1000).toFixed(2)+' s'}</span><span class="step-chevron">⌄</span></span></summary><div class="step-events">${items.map(({event,index})=>eventHtml(event,`${team}-${index}`)).join('')}</div></details>`;
  }).join('');
}
function eventHtml(e, key) {
  let title = e.type,
    detail = "";
  if (e.type === "decision") {
    title = `${e.kind === "agent" ? "Agent" : "Tool"} → ${pretty(e.choice)}`;
    detail =
      e.source ??
      (e.confidence !== undefined
        ? `Jev confidence ${(e.confidence * 100).toFixed(1)}% · distribution concentration, not accuracy`
        : "Structured selection");
  }
  if (e.type === "tool") {
    title = pretty(e.tool);
    detail = `${e.count} places found · ${e.queries?.length ? `${e.queries.length} web queries · ` : ""}Search ID: ${e.searchId ?? "unavailable"}`;
  }
  if (e.type === "plan") {
    title = "Planner produced an itinerary";
    detail = e.plan.title;
  }
  if (e.type === "review") {
    title = "Reviewer checked the draft";
    detail = e.review.passed
      ? "Deterministic checks passed"
      : e.review.issues.join(" ");
  }
  if (e.type === "call") {
    title = `${e.call.provider} · ${e.call.stage}`;
    detail = `${e.call.ms} ms · ${e.call.inputTokens ?? "?"} input / ${e.call.outputTokens ?? "?"} output tokens · ${e.call.model}${e.call.error ? " · " + e.call.error : ""}`;
  }
  if (e.message) {
    title = pretty(e.type);
    detail = e.message;
  }
  if (e.type === "tool_start") {
    title = `Start ${pretty(e.tool)}`;
    detail = `Step ${e.step} · ${e.agent}`;
  }
  if (e.type === "tool_end") {
    title = `${pretty(e.tool)} · ${e.error ? "failed" : "finished"}`;
    detail = `${e.ms} ms · step ${e.step}${e.error ? " · " + e.error : ""}`;
  }
  if (e.type === "model_start") {
    title = `${e.provider} request · ${e.stage}`;
    detail = e.model;
  }
  const provider=e.call?.provider??e.provider;
  const badge=provider=== "gemini" || provider=== "jev" ? `<b class="provider-badge ${provider}">${provider=== "jev" ? "Jev" : "Gemini"}</b>` : "";
  return `<details class="event-record ${provider=== "gemini" || provider=== "jev" ? `provider-${provider}` : ""}" data-event="${key}" ${expandedEvents.has(key) ? "open" : ""}><summary><time>+${(e.atMs / 1000).toFixed(2)}s</time><span>${badge}${escape(title)}<small>${escape(detail)}</small></span></summary><div class="event-payload"><p>${escape(e.timestamp ?? "")} · Elapsed time is relative to this team's start.</p><pre>${escape(JSON.stringify(e, null, 2))}</pre></div></details>`;
}
function decisionSteps(team) {
  const groups = new Map<number, any>();
  for (const event of team.events) {
    const step = Number(event.step);
    if (!Number.isFinite(step) || step < 1) continue;
    if (!groups.has(step)) groups.set(step, { step, agent: null, tool: null, decisionMs: 0, issue: false, source: null, concentrations: [] });
    const row = groups.get(step);
    if (event.type === "decision") {
      if (event.kind === "agent") row.agent = event.choice;
      if (event.kind === "tool") row.tool = event.choice;
      if (event.source !== "prerequisite rule") row.source = "model";
      if (typeof event.confidence === "number") row.concentrations.push(`${event.kind} ${(event.confidence * 100).toFixed(0)}%`);
    }
    if (event.type === "call" && event.call?.stage === "coordination") row.decisionMs += event.call.ms ?? 0;
    if (event.type === "validation_error" || event.type === "tool_end" && event.error || event.type === "review" && !event.review?.passed) row.issue = true;
  }
  return [...groups.values()].filter((row) => row.agent || row.tool).sort((a, b) => a.step - b.step);
}
function renderDecisionPaths() {
  const left = decisionSteps(teams.baseline);
  const right = decisionSteps(teams.hybrid);
  const compared = Boolean(teams.baseline.result && teams.hybrid.result);
  const size = Math.min(left.length, right.length);
  let firstSplit = -1;
  if (compared) {
    firstSplit = Array.from({ length: size }, (_, i) => i).find((i) => left[i].agent !== right[i].agent || left[i].tool !== right[i].tool) ?? -1;
    if (firstSplit < 0 && left.length !== right.length) firstSplit = size;
  }
  const intro = compared
    ? firstSplit < 0 ? "Both teams followed the same action path. Their model calls and research responses can still differ."
      : `The paths first differ at step ${firstSplit + 1}. Later steps are shown in order, not treated as matched decisions.`
    : "The paths update as each team chooses its next action.";
  $("#decision-paths").innerHTML = `<p class="path-intro">${intro}</p><div class="path-columns">${["baseline", "hybrid"].map((id, column) => {
    const rows = column === 0 ? left : right;
    return `<article class="path-column ${id}"><h5>${escape(labels[id])}</h5>${rows.length ? `<ol>${rows.map((row, index) => `<li class="path-step ${firstSplit >= 0 && index >= firstSplit ? "path-split" : ""} ${row.issue ? "path-issue" : ""}"><span class="path-number">${String(row.step).padStart(2, "0")}</span><div><strong>${escape(pretty(row.agent ?? "Choosing agent"))}</strong><span>${row.tool ? `→ ${escape(pretty(row.tool))}` : "No tool needed"}</span><small>${row.source === "model" ? `${id === "hybrid" ? "Jev" : "Gemini"} decision` : "Prerequisite rule"}${row.decisionMs ? ` · ${(row.decisionMs / 1000).toFixed(2)}s` : ""}${row.issue ? " · Needs attention" : ""}</small>${row.concentrations.length ? `<small>Jev concentration: ${escape(row.concentrations.join(" · "))} · not measured accuracy</small>` : ""}</div></li>`).join("")}</ol>` : '<p class="hint">No decisions yet.</p>'}</article>`;
  }).join("")}</div>`;
  $("#run-inspection").innerHTML = `<details class="run-inspection" ${inspectionOpen ? "open" : ""}><summary>Inspect every step and model call <span>Full execution log</span></summary><div class="inspection-columns">${["baseline", "hybrid"].map((id) => `<section><h5>${escape(labels[id])} · ${teams[id].events.length} events</h5>${teams[id].events.length ? timelineHtml(teams[id].events, id) : '<p class="hint">No events yet.</p>'}</section>`).join("")}</div></details>`;
  $(".run-inspection").addEventListener("toggle", (event) => { inspectionOpen = (event.currentTarget as HTMLDetailsElement).open; });
  document.querySelectorAll<HTMLDetailsElement>(".event-record, .step-record").forEach((detail) => detail.addEventListener("toggle", () => {
    if (detail.open) expandedEvents.add(detail.dataset.event);
    else expandedEvents.delete(detail.dataset.event);
  }));
}
function renderBenchmark() {
  const target = $("#benchmark-summary");
  if (!publishedBenchmark) return;
  const block = (artifact, title, explanation, scoreLabel) => {
    const { summary, caseCount, repetitions, createdAt, datasetHash } = artifact;
    const count = caseCount * repetitions;
    return `<section class="benchmark-block"><div class="benchmark-block-title"><h5>${escape(title)}</h5><span>${caseCount} states × ${repetitions} repeats · ${new Date(createdAt).toLocaleDateString("en-IN")}</span></div><div class="benchmark-grid">${["gemini", "jev"].map((id) => `<div class="benchmark-provider ${id}"><span>${id === "jev" ? "Jev" : "Gemini"}</span><strong>${summary[id].medianMs.toLocaleString("en-IN")}<small>ms</small></strong><p>median routing call</p><b>${summary[id].correct}/${count} ${escape(scoreLabel)}</b><small class="benchmark-version">${escape(summary[id].modelVersions.join(", "))}</small></div>`).join("")}</div><p class="benchmark-caveat">${escape(explanation)} Dataset SHA-256: <code>${escape(datasetHash.slice(0, 12))}…</code></p></section>`;
  };
  const challenge = challengeBenchmark;
  const differingCases = challenge?.cases?.filter((item) =>
    JSON.stringify(challenge.caseChoices[item.id]?.gemini) !== JSON.stringify(challenge.caseChoices[item.id]?.jev)) ?? [];
  target.innerHTML = `<p class="benchmark-caption">Published local measurements. Both suites use frozen states and legal actions, alternate provider order, and count errors as misses.</p>${block(publishedBenchmark, "Foundational routing", "Both coordinators matched all preset actions. This establishes a latency difference on straightforward choices, not an accuracy or cost advantage.", "expected choices")}${challenge ? block(challenge, "Recovery and ambiguity", "These are hand-authored policy matches, not independent trip-quality scores. Some recovery labels are debatable; do not infer a general accuracy winner.", "policy matches") : '<p class="benchmark-caption">Loading challenge results…</p>'}${differingCases.length ? `<div class="benchmark-disagreements"><h5>Where their actions differed</h5>${differingCases.map((item) => `<p><strong>${escape(pretty(item.id))}</strong><span>Gemini: ${escape(challenge.caseChoices[item.id].gemini.map(pretty).join(", "))} · Jev: ${escape(challenge.caseChoices[item.id].jev.map(pretty).join(", "))}</span></p>`).join("")}</div>` : ""}`;
}
function renderMetrics() {
  const available = Boolean(
    report && teams.baseline?.result && teams.hybrid?.result,
  );
  $("#analysis-tab").disabled = !available && !Object.values(teams).some((team: any) => team.events.length);
  const summary = $("#comparison-summary");
  summary.hidden = !available;
  if (available) {
    const baseline = teams.baseline.result.metrics;
    const hybrid = teams.hybrid.result.metrics;
    const time = (ms: number | null) => ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`;
    const difference = baseline.decisionMs != null && hybrid.decisionMs != null
      ? Math.abs(baseline.decisionMs - hybrid.decisionMs) / 1000
      : null;
    const faster = baseline.decisionMs < hybrid.decisionMs ? "Gemini" : "Gemini + Typesafe";
    const takeaway = difference == null
      ? "Coordination timing was not recorded for this run."
      : difference < 0.05
        ? "Both teams spent about the same time on coordination in this run."
        : `${faster} spent ${difference.toFixed(1)}s less choosing agents and tools in this run.`;
    summary.innerHTML = `<div class="comparison-copy"><p class="eyebrow">THIS TRIP / COMPLETE</p><h3>At a glance</h3><p>${escape(takeaway)}</p><small>One run is a demonstration, not a controlled benchmark. The teams may have found different travel evidence.</small></div><div class="comparison-times"><div class="comparison-time baseline"><span>Gemini</span><strong>${time(baseline.decisionMs)}</strong><small>coordination time</small></div><div class="comparison-time hybrid"><span>Gemini + Typesafe</span><strong>${time(hybrid.decisionMs)}</strong><small>coordination time</small></div></div><div class="comparison-support"><span>End-to-end <b>Gemini ${time(baseline.wallMs)} · Typesafe ${time(hybrid.wallMs)}</b></span><span>Model calls <b>Gemini ${baseline.modelCalls} · Typesafe ${hybrid.modelCalls}</b></span></div>`;
  } else summary.innerHTML = "";
  const coordination = $("#coordination-overview");
  coordination.innerHTML = available
    ? ["baseline", "hybrid"].map((id) => {
      const ms = teams[id].result.metrics.decisionMs;
      return `<div class="coordination-card ${id}"><span>${labels[id]}</span><strong>${ms == null ? "—" : (ms / 1000).toFixed(2)}${ms == null ? "" : "<small>s</small>"}</strong><p>Agent and tool decisions</p></div>`;
    }).join("")
    : "";
  const rows: Array<[string, (result: any) => string | number]> = [
    [
      "Constraint checks",
      (r) =>
        r.review
          ? `${r.review.checks.filter((c) => c.passed).length} / ${r.review.checks.length}`
          : "Not reviewed",
    ],
    [
      "Day-plan estimate",
      (r) => (r.review?.total != null ? money(r.review.total) : "—"),
    ],
    [
      "End-to-end time",
      (r) =>
        r.mode === "demo"
          ? "Not benchmarked"
          : `${(r.metrics.wallMs / 1000).toFixed(2)} s`,
    ],
    ["Tool executions", (r) => r.metrics.toolCalls],
    [
      "Model calls",
      (r) => (r.mode === "demo" ? "0 · offline" : r.metrics.modelCalls),
    ],
    [
      "Input / output tokens",
      (r) =>
        r.mode === "demo"
          ? "No API calls"
          : `${r.metrics.inputTokens ?? "?"} / ${r.metrics.outputTokens ?? "?"}`,
    ],
    [
      "Estimated API cost",
      (r) =>
        r.mode === "demo"
          ? "₹0 · demo"
          : r.metrics.estimatedUsd == null
            ? "Not configured / unknown"
            : (report ? report.usdToInr : config.usdToInr)
              ? `₹${(r.metrics.estimatedUsd * (report ? report.usdToInr : config.usdToInr)).toFixed(4)}`
              : "INR rate not configured",
    ],
  ];
  $("#metrics").innerHTML = rows
    .map(
      ([name, f]) =>
        `<tr><td>${name}</td>${["baseline", "hybrid"].map((id) => `<td>${teams[id].result ? escape(f(teams[id].result)) : "—"}</td>`).join("")}</tr>`,
    )
    .join("");
  renderDecisionPaths();
  renderBenchmark();
}
function setPerformance(open) {
  if (open && $("#analysis-tab").disabled) return;
  const arena = $(".arena");
  const panel = $("#performance-panel");
  if (!arena || !panel) return;
  arena.classList.toggle("analysis-open", open);
  panel.hidden = !open;
  $("#plan-view").hidden = open;
  $("#plan-tab").setAttribute("aria-selected", String(!open));
  $("#analysis-tab").setAttribute("aria-selected", String(open));
}
function showError(message) {
  $("#error").textContent = message;
  $("#error").hidden = false;
}
function setBusy(value) {
  running = value;
  $("#run").disabled = value;
  $("#stop").hidden = !value;
  $("#download").disabled = value || !report;
  $("#trip-form")
    .querySelectorAll("input,select,textarea")
    .forEach((el) => (el.disabled = value));
  if (!value) $("#run").disabled = !config?.live;
}
function scrollToResults() {
  requestAnimationFrame(() => {
    const arena = $(".arena");
    window.scrollTo({ top: window.scrollY + arena.getBoundingClientRect().top, behavior: "auto" });
  });
}
function taskFromForm() {
  return {
    city: $("#destination").value,
    days: Number($("#days").value),
    people: Number($("#people").value),
    budget: Number($("#budget").value),
    vegetarian: $("#vegetarian").checked,
    interests: [
      ...document.querySelectorAll<HTMLInputElement>('input[name="interest"]:checked'),
    ].map((x) => x.value),
    rainDay: Number($("#rain").value),
    closed: $("#closure").value ? [$("#closure").value] : [],
    notes: $("#notes").value,
  };
}
function receive(e) {
  if (e.type === "error") throw new Error(e.message);
  if (e.type === "saved") {
    currentRunId = e.runId;
    history.replaceState(null,"",`?search=${encodeURIComponent(e.runId)}`);
    $("#saved-status").textContent = `Search ID: ${e.runId} · Saved`;
    return;
  }
  if (!e.team) return;
  const t = teams[e.team];
  if (e.type === "result") {
    t.result = e.result;
    t.status = e.result.status;
    t.agent = null;
  } else {
    t.events.push(e);
    if (e.type === "start") t.status = "running";
    if (e.type === "decision" && e.kind === "agent") {
      t.agent = e.choice;
      t.message = `${pretty(e.choice)} selected`;
    }
    if (e.type === "tool")
      t.message = `Found ${e.count} ${e.tool === "search_places" ? "activities" : "meal options"}.`;
    if (e.type === "plan") {
      t.plan = e.plan;
      t.review = null;
      t.message = "Draft ready for review.";
    }
    if (e.type === "review") {
      t.review = e.review;
      t.message = e.review.passed
        ? "Fixture checks passed."
        : "Checking changes needed.";
    }
    if (e.message) t.message = e.message;
  }
  if (e.type === "result" && e.result.status === "completed")
    t.message = "Itinerary ready.";
  render();
}
$("#trip-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (running) return;
  $("#error").hidden = true;
  const task = taskFromForm();
  if (!task.interests.length) {
    showError("Choose at least one interest.");
    return;
  }
  const mode = "live";
  report = null;
  currentRunId = null;
  viewedCatalog = null;
  expandedEvents.clear();
  inspectionOpen = false;
  document.body.classList.add("has-run");
  initTeams();
  setPerformance(false);
  setBusy(true);
  controller = new AbortController();
  $("#run-status").textContent = "Planning…";
  scrollToResults();
  let done = false;
  try {
    const response = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, mode }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error);
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          const event = JSON.parse(line);
          if (event.type === "done") done = true;
          receive(event);
        }
      }
    }
    if (!done)
      throw new Error("The connection closed before the comparison finished.");
    const results = Object.values(teams)
      .map((t) => t.result)
      .filter(Boolean);
    report = {
      id: currentRunId,
      createdAt: new Date().toISOString(),
      displayCurrency: "INR",
      usdToInr: config.usdToInr,
      mode,
      dataset: "gemini-google-search",
      task,
      results,
      notes: "Single run; venue prices and durations are estimates, and subjective review is not independent ground truth.",
    };
    if (currentRunId) {
      const saved = await fetch(`/api/runs/${currentRunId}`);
      if (saved.ok) report = await saved.json();
    }
    render();
    $("#run-status").textContent = results.every(
      (r) => r.status === "completed",
    )
      ? "Both planners finished."
      : "Some requirements could not be met. See each plan for details.";
  } catch (error) {
    if (error.name === "AbortError")
      $("#run-status").textContent =
        "Planning stopped. The partial run is saved in history.";
    else {
      $("#run-status").textContent = "The comparison could not finish.";
      showError(error.message);
    }
    Object.values(teams).forEach((t) => {
      if (t.status === "running")
        t.status = error.name === "AbortError" ? "cancelled" : "error";
    });
    render();
  } finally {
    controller = null;
    setBusy(false);
  }
});
$("#stop").addEventListener("click", () => controller?.abort());
$("#days").addEventListener("change", () => {
  const previous = Number($("#rain").value);
  $("#rain").innerHTML =
    '<option value="0">No rain constraint</option>' +
    Array.from(
      { length: Number($("#days").value) },
      (_, i) =>
        `<option value="${i + 1}">Day ${i + 1} · indoor stops only</option>`,
    ).join("");
  $("#rain").value =
    previous <= Number($("#days").value) ? String(previous) : "0";
});
$("#download").addEventListener("click", () => {
  if (!report) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `travel-lab-${report.mode}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
initTeams();
try {
  const searchId = new URLSearchParams(location.search).get("search");
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Could not load the server configuration.");
  config = await response.json();
  fetch("/api/benchmark/routing").then(async (result) => {
    if (!result.ok) throw new Error("Published benchmark unavailable");
    publishedBenchmark = await result.json();
    renderBenchmark();
  }).catch(() => {
    $("#benchmark-summary").innerHTML = '<p>The published benchmark could not be loaded.</p>';
  });
  fetch("/api/benchmark/challenge").then(async (result) => {
    if (!result.ok) throw new Error("Challenge benchmark unavailable");
    challengeBenchmark = await result.json();
    renderBenchmark();
  }).catch(() => {
    challengeBenchmark = null;
    renderBenchmark();
  });
  $("#run").disabled = !config.live;
  updateDestination();
  render();
  if (searchId) await openRun(searchId);
} catch (e) {
  showError(e.message);
  $("#run").disabled = true;
}

function updateDestination() {
  if (running) return;
  const destination = $("#destination").value.trim();
  if (currentRunId) {
    const previousCity = report?.task?.city ?? "the previous trip";
    $("#run-status").textContent =
      `Showing results for ${previousCity}. Run a new comparison to plan ${destination || "another destination"}.`;
    return;
  }
  $("#run-status").textContent =
    destination ? `Ready to plan ${$("#days").value} days in ${destination}.` : "Enter a destination to begin.";
}
$("#destination").addEventListener("change", updateDestination);
$("#analysis-tab").addEventListener("click", () => setPerformance(true));
$("#plan-tab").addEventListener("click", () => setPerformance(false));
document.querySelectorAll<HTMLElement>("[role=tab]").forEach((tab) => tab.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const next = tab.id === "plan-tab" ? $("#analysis-tab") : $("#plan-tab");
  if (!next.disabled) { next.focus(); next.click(); }
}));

async function openRun(id) {
  if (running) return;
  try {
    const response = await fetch(`/api/runs/${id}`);
    if (!response.ok) throw Error("Could not open this run.");
    const saved = await response.json();
    report = saved;
    currentRunId = id;
    document.body.classList.add("has-run");
    history.replaceState(null,"",`?search=${encodeURIComponent(id)}`);
    viewedCatalog = saved.catalog;
    syncForm(saved.task, saved.catalog);
    expandedEvents.clear();
    inspectionOpen = false;
    initTeams();
    setPerformance(false);
    for (const event of saved.events)
      if (event.team) {
        const t = teams[event.team];
        if (event.type === "result") {
          t.result = event.result;
          t.status = event.result.status;
        } else {
          t.events.push(event);
          if (event.type === "plan") t.plan = event.plan;
          if (event.type === "review") t.review = event.review;
        }
      }
    for (const t of Object.values(teams))
      if (!t.result) t.status = saved.status;
    $("#run-status").textContent =
      `${pretty(saved.status)} · ${new Date(saved.createdAt).toLocaleString()}`;
    $("#saved-status").textContent =
      `Search ID: ${id} · ${saved.events.length} events`;
    $("#download").disabled = false;
    render();
    scrollToResults();
  } catch (e) {
    showError(e.message);
  }
}

function syncForm(task, catalog) {
  $("#destination").value = task.city;
  $("#days").value = String(task.days);
  $("#people").value = String(task.people);
  $("#budget").value = String(task.budget);
  $("#vegetarian").checked = task.vegetarian;
  document.querySelectorAll<HTMLInputElement>('input[name="interest"]').forEach((input) => {
    input.checked = (task.interests ?? ["culture", "art"]).includes(input.value);
  });
  $("#rain").innerHTML =
    '<option value="0">No rain constraint</option>' +
    Array.from(
      { length: task.days },
      (_, i) => `<option value="${i + 1}">Day ${i + 1} · stay indoors</option>`,
    ).join("");
  $("#rain").value = String(task.rainDay ?? 0);
  $("#closure").value = task.closed?.[0] ?? "";
  $("#notes").value = task.notes ?? "";
}
