import { readFileSync } from "node:fs";
export interface Place {
  id: string; name: string; area: string; kind: "activity" | "meal";
  tags: string[]; indoor: boolean; vegetarian?: boolean;
  price: number; minutes: number; source?: { title: string; uri: string };
}
export interface Catalog {
  version: string; city: string; currency: string; provenance: string;
  transitPerPersonPerDay: number; places: Place[];
}
export interface TripTask {
  city: string; days: number; people: number; budget: number;
  vegetarian: boolean; rainDay: number; interests: string[];
  closed: string[]; notes: string;
}
export interface TripPlan {
  title: string; summary: string;
  days: Array<{ day: number; activities: string[]; meal: string; note: string }>;
}
export const catalogs: Record<string, Catalog> = Object.fromEntries(
  ["tokyo", "jaipur", "goa", "bengaluru"].map((name) => {
    const data = JSON.parse(
      readFileSync(new URL(`../data/${name}.json`, import.meta.url), "utf8"),
    );
    return [data.city, data];
  }),
) as Record<string, Catalog>;
export const catalog = catalogs.Tokyo;
export function catalogFor(city) {
  if (!Object.hasOwn(catalogs, city))
    throw new Error("Choose a supported destination.");
  return catalogs[city];
}
export const interests = ["culture", "art", "nature", "photography", "food"];
export function parseTask(raw: any, live = false): TripTask {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Provide a trip request.");
  const t = {
    city: raw.city ?? "Tokyo",
    days: raw.days ?? 3,
    people: raw.people ?? 2,
    budget: raw.budget ?? 24000,
    vegetarian: raw.vegetarian ?? true,
    rainDay: raw.rainDay ?? 0,
    interests: raw.interests ?? ["culture", "art"],
    closed: raw.closed ?? [],
    notes: raw.notes ?? "",
  };
  if (typeof t.city !== "string" || !t.city.trim() || t.city.length > 100)
    throw new Error("Enter a destination of at most 100 characters.");
  t.city = t.city.trim();
  const catalog = live ? null : catalogFor(t.city);
  const byId = new Map(catalog?.places.map((p) => [p.id, p]) ?? []);
  for (const [k, min, max] of [
    ["days", 1, 5],
    ["people", 1, 6],
    ["budget", 1000, 300000],
    ["rainDay", 0, t.days],
  ]) {
    if (!Number.isInteger(t[k]) || t[k] < min || t[k] > max)
      throw new Error(
        `Invalid ${k}: expected an integer from ${min} to ${max}.`,
      );
  }
  if (typeof t.vegetarian !== "boolean")
    throw new Error("Vegetarian must be true or false.");
  if (
    !Array.isArray(t.interests) ||
    !t.interests.length ||
    t.interests.length > 5 ||
    t.interests.some((x) => !interests.includes(x))
  )
    throw new Error("Choose valid interests.");
  if (
    !Array.isArray(t.closed) ||
    t.closed.length > (live ? 5 : catalog.places.length) ||
    t.closed.some((x) => typeof x !== "string" || !x.trim() || x.length > 120 || (!live && !byId.has(x)))
  )
    throw new Error("Unknown closure.");
  if (typeof t.notes !== "string" || t.notes.length > 600)
    throw new Error("Additional preferences must be at most 600 characters.");
  return structuredClone(t) as TripTask;
}
export function searchCatalog(task: TripTask, kind: Place["kind"], args: { tags: string[]; indoorOnly: boolean }): Place[] {
  if (
    !args ||
    !Array.isArray(args.tags) ||
    args.tags.some((t) => !interests.includes(t)) ||
    typeof args.indoorOnly !== "boolean"
  )
    throw new Error("Invalid search arguments.");
  return catalogFor(task.city).places.filter(
    (p) =>
      p.kind === kind &&
      !task.closed.includes(p.id) &&
      (!args.indoorOnly || p.indoor) &&
      (!args.tags.length || p.tags.some((t) => args.tags.includes(t))) &&
      (kind !== "meal" || !task.vegetarian || p.vegetarian),
  );
}
export function validatePlanShape(plan: TripPlan, task: TripTask): TripPlan {
  if (
    !plan ||
    typeof plan.title !== "string" ||
    plan.title.length > 200 ||
    typeof plan.summary !== "string" ||
    plan.summary.length > 2000 ||
    !Array.isArray(plan.days) ||
    plan.days.length !== task.days
  )
    throw new Error("Invalid itinerary structure or day count.");
  for (let i = 0; i < plan.days.length; i++) {
    const d = plan.days[i];
    if (
      d.day !== i + 1 ||
      !Array.isArray(d.activities) ||
      d.activities.length !== 2 ||
      d.activities.some((id) => typeof id !== "string") ||
      typeof d.meal !== "string" ||
      typeof d.note !== "string" ||
      d.note.length > 800
    )
      throw new Error(
        "Each day needs two activity IDs, one meal ID, and a short note.",
      );
  }
  return plan;
}
export function evaluatePlan(plan: any, task: TripTask, evidenceIds?: string[], researchedPlaces: Place[] | null = null) {
  const catalog = researchedPlaces ? null : catalogFor(task.city);
  const candidates = researchedPlaces ?? catalog.places;
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const issues = [];
  let subtotal = 0;
  const seen = new Set();
  const days = [];
  try {
    validatePlanShape(plan, task);
  } catch (e) {
    return {
      passed: false,
      issues: [e.message],
      checks: [],
      total: null,
      days: [],
    };
  }
  const evidence = new Set(evidenceIds ?? candidates.map((p) => p.id));
  const closedNames = new Set([
    ...task.closed.map((name) => name.toLowerCase()),
    ...(catalog?.places.filter((p) => task.closed.includes(p.id)).map((p) => p.name.toLowerCase()) ?? []),
  ]);
  const flags = {
    grounded: true,
    availability: true,
    diet: true,
    weather: true,
    unique: true,
    pace: true,
  };
  for (const day of plan.days) {
    let cost = 0,
      minutes = 0;
    const stops = [];
    for (const [id, kind] of [
      ...day.activities.map((id) => [id, "activity"]),
      [day.meal, "meal"],
    ]) {
      const p = byId.get(id);
      if (!p || p.kind !== kind || !evidence.has(id)) {
        flags.grounded = false;
        issues.push(
          `Day ${day.day}: unknown, unresearched, or wrong-kind stop ${id}.`,
        );
        continue;
      }
      if (task.closed.includes(id) || closedNames.has(p.name.toLowerCase())) {
        flags.availability = false;
        issues.push(`${p.name} is closed.`);
      }
      if (kind === "meal" && task.vegetarian && !p.vegetarian) {
        flags.diet = false;
        issues.push(`${p.name} does not satisfy vegetarian dining.`);
      }
      if (day.day === task.rainDay && !p.indoor) {
        flags.weather = false;
        issues.push(`Day ${day.day}: ${p.name} is outdoors in rain.`);
      }
      if (kind === "activity" && seen.has(id)) {
        flags.unique = false;
        issues.push(`${p.name} is repeated.`);
      }
      if (kind === "activity") seen.add(id);
      cost += p.price * task.people;
      minutes += p.minutes;
      stops.push(p);
    }
    // A fixed synthetic allowance, not a real travel-time estimate.
    minutes += 60;
    if (minutes > 420) {
      flags.pace = false;
      issues.push(`Day ${day.day} exceeds the 7-hour fixture allowance.`);
    }
    if (catalog) cost += catalog.transitPerPersonPerDay * task.people;
    subtotal += cost;
    days.push({ ...day, stops, cost, minutes });
  }
  const budget = subtotal <= task.budget;
  if (!budget)
    issues.push(
      `Estimated day-plan cost exceeds budget by ₹${subtotal - task.budget}.`,
    );
  const checks = [
    ["grounded", "Researched catalog stops"],
    ["availability", "No closed venues"],
    ["diet", "Dietary preference"],
    ["weather", "Rain-day suitability"],
    ["unique", "No repeated activities"],
    ["pace", "Relaxed daily schedule"],
  ].map(([k, label]) => ({ label, passed: flags[k] }));
  checks.push({ label: "Within day-plan budget", passed: budget });
  return {
    passed: checks.every((c) => c.passed),
    checks,
    issues,
    total: subtotal,
    days,
    scope:
      researchedPlaces
        ? "Web-researched activities and one meal per day, with model-estimated prices and visit durations. Venue facts, availability, hours, and prices require independent verification. Flights, hotels, transport, and other meals are excluded."
        : "Activities, one meal per day, and a fixed local-transit allowance for the whole party. Flights, hotels, other meals, and real-time availability are excluded.",
  };
}
export function offlinePlan(task, evidence) {
  const used = new Set();
  const all = evidence.places ?? [];
  const food = evidence.food ?? [];
  const days = [];
  for (let day = 1; day <= task.days; day++) {
    const options = all
      .filter((p) => !used.has(p.id) && (day !== task.rainDay || p.indoor))
      .sort((a, b) => {
        // Deterministic demo policy shared by both teams. Not a model simulation.
        const affinity = (p) =>
          p.tags.filter((t) => task.interests.includes(t)).length;
        return (
          a.price - b.price ||
          affinity(b) - affinity(a) ||
          a.id.localeCompare(b.id)
        );
      });
    if (options.length < 2 || !food.length)
      throw new Error(
        "The catalog cannot satisfy this request. Adjust closures or duration.",
      );
    const selected = options.slice(0, 2);
    selected.forEach((p) => used.add(p.id));
    const meal = [...food].sort(
      (a, b) => a.price - b.price || a.id.localeCompare(b.id),
    )[0];
    days.push({
      day,
      activities: selected.map((p) => p.id),
      meal: meal.id,
      note:
        day === task.rainDay
          ? "An indoor day, with room to slow down."
          : "Two stops and a relaxed lunch. Allow extra time between neighborhoods.",
    });
  }
  return {
    title: `${task.days} days in ${task.city}`,
    summary:
      "Two activities and a relaxed meal each day. This is a sample itinerary.",
    days,
  };
}
export const searchSchema = {
  type: "object",
  properties: {
    tags: { type: "array", items: { type: "string", enum: interests } },
    indoorOnly: { type: "boolean" },
  },
  required: ["tags", "indoorOnly"],
  additionalProperties: false,
};
export const planSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "integer" },
          activities: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 2,
          },
          meal: { type: "string" },
          note: { type: "string" },
        },
        required: ["day", "activities", "meal", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "summary", "days"],
  additionalProperties: false,
};
export const reviewSchema = {
  type: "object",
  properties: { satisfied: { type: "boolean" }, feedback: { type: "string" } },
  required: ["satisfied", "feedback"],
  additionalProperties: false,
};
