import { createRunStore, redact } from "../src/run-store.js";
import { catalogFor } from "../src/domain.js";
import { compare } from "../src/engine.js";
import { configuration } from "../src/providers.js";
const live = process.argv.includes("--live");
if (live && !configuration().live)
  throw new Error(
    "Configure both API keys and ENABLE_LIVE=true before a paid evaluation.",
  );
const cases = [
  { name: "standard", budget: 24000 },
  { name: "rain", budget: 24000, rainDay: 2 },
  { name: "closure", budget: 24000, closed: [live ? "Tokyo National Museum" : "digital-gallery"] },
  { name: "infeasible budget", budget: 1000 },
];
const results = [];
const store = createRunStore(),
  config = configuration();
for (const test of cases) {
  const record = store.create({
    task: { city: "Tokyo", days: 3, people: 2, vegetarian: true, ...test },
    mode: live ? "live" : "demo",
    catalog: catalogFor("Tokyo"),
    source: "evaluation",
    models: { gemini: config.geminiModel, jev: config.jevModel },
  });
  const runs = await compare({
    emit: (event) =>
      store.append(record.id, redact(event, [config.geminiKey, config.jevKey])),
    task: { days: 3, people: 2, vegetarian: true, ...test },
    mode: live ? "live" : "demo",
    demoDelay: 0,
  });
  store.finish(
    record.id,
    runs.every((r) => r.status === "completed") ? "completed" : "unresolved",
  );
  results.push({ case: test.name, runId: record.id, runs });
  console.error(
    `${test.name}: ${runs.map((r) => `${r.team}=${r.status}`).join(", ")}`,
  );
}
console.log(
  JSON.stringify(
    {
      mode: live ? "live" : "demo",
      warning: live
        ? "Single sample per case; not a statistical benchmark."
        : "Offline integration evaluation, not a model benchmark.",
      results,
    },
    null,
    2,
  ),
);
