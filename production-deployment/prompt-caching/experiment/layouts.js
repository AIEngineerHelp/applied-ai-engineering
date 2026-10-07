// The prompt layouts we compare. Every layout sends the same instructions, policy
// handbook, tools and examples, and the same twelve customer questions. Only where
// the changing parts sit, and whether they change, differs.
//
// Each layout starts its system instruction with a tag that is fixed within one
// layout of one run. It keeps layouts and runs from reading each other's cache
// entries, the way two different applications wouldn't share a cache.

import { INSTRUCTIONS, HANDBOOK, EXAMPLES, TOOLS, QUESTIONS } from "../src/fixture.js";

const CUSTOMERS = [
  ["Alex Rivera", "alex.rivera@example.com"],
  ["Jordan Lee", "jordan.lee@example.com"],
  ["Sam Okafor", "sam.okafor@example.com"],
  ["Priya Nair", "priya.nair@example.com"],
  ["Mateo Silva", "mateo.silva@example.com"],
  ["Hana Sato", "hana.sato@example.com"],
  ["Lena Fischer", "lena.fischer@example.com"],
  ["Omar Haddad", "omar.haddad@example.com"],
  ["Grace Kim", "grace.kim@example.com"],
  ["Tomas Novak", "tomas.novak@example.com"],
  ["Ines Duarte", "ines.duarte@example.com"],
  ["Kwame Mensah", "kwame.mensah@example.com"],
];

const STABLE = `${INSTRUCTIONS}\n\n${HANDBOOK}\n\n${EXAMPLES}`;
const sortedTools = () => [...TOOLS].sort((a, b) => a.name.localeCompare(b.name));

function shuffled(list, seed) {
  // Deterministic shuffle, so a rerun sends the same orders.
  const out = [...list];
  let s = seed + 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const tag = (ctx) => `Northwind support assistant, deployment ${ctx.runId}-${ctx.layout}.`;
const customer = (i) => {
  const [name, email] = CUSTOMERS[i % CUSTOMERS.length];
  return `Customer: ${name} <${email}>, Trail Club member.`;
};

// Each layout builds one request from (ctx, i): ctx = { runId, layout, now }, i = request number.
export const LAYOUTS = [
  {
    id: "stable",
    title: "Stable prefix",
    description: "Instructions, handbook, examples and sorted tools are identical on every request. Only the question changes, at the end.",
    build: (ctx, i) => ({
      system: `${tag(ctx)}\n\n${STABLE}`,
      tools: sortedTools(),
      user: QUESTIONS[i],
    }),
  },
  {
    id: "timestamp-top",
    title: "Timestamp at the top",
    description: "The current time, to the millisecond, is the first line after the tag in the system instruction.",
    build: (ctx, i) => ({
      system: `${tag(ctx)}\nCurrent time: ${ctx.now()}\n\n${STABLE}`,
      tools: sortedTools(),
      user: QUESTIONS[i],
    }),
  },
  {
    id: "timestamp-bottom",
    title: "Timestamp at the bottom",
    description: "The same timestamp, moved into the user message after the question.",
    build: (ctx, i) => ({
      system: `${tag(ctx)}\n\n${STABLE}`,
      tools: sortedTools(),
      user: `${QUESTIONS[i]}\n\nCurrent time: ${ctx.now()}`,
    }),
  },
  {
    id: "user-top",
    title: "Customer details at the top",
    description: "Each request comes from a different customer, whose name and email open the system instruction.",
    build: (ctx, i) => ({
      system: `${tag(ctx)}\n${customer(i)}\n\n${STABLE}`,
      tools: sortedTools(),
      user: QUESTIONS[i],
    }),
  },
  {
    id: "user-bottom",
    title: "Customer details at the bottom",
    description: "The same customer details, sent in the user message before the question.",
    build: (ctx, i) => ({
      system: `${tag(ctx)}\n\n${STABLE}`,
      tools: sortedTools(),
      user: `${customer(i)}\n\n${QUESTIONS[i]}`,
    }),
  },
  {
    id: "shuffled-tools",
    title: "Tools in a different order",
    description: "The same seven tools in a different order on each request, as when a tool list is built from an unordered set.",
    build: (ctx, i) => ({
      system: `${tag(ctx)}\n\n${STABLE}`,
      tools: shuffled(TOOLS, i),
      user: QUESTIONS[i],
    }),
  },
  {
    id: "question-first",
    title: "Question before the handbook",
    description: "A retrieval-style prompt: short instructions, then a user message with the question first and the handbook and examples after it.",
    build: (ctx, i) => ({
      system: `${tag(ctx)}\n\n${INSTRUCTIONS}`,
      tools: sortedTools(),
      user: `Question: ${QUESTIONS[i]}\n\nReference material:\n\n${HANDBOOK}\n\n${EXAMPLES}`,
    }),
  },
];

// Explicit caching: the stable part is uploaded once as a cachedContents resource,
// and each request sends only the question plus a reference to it.
export const EXPLICIT = {
  id: "explicit",
  title: "Explicit cache",
  description: "The stable prefix is stored once with the cachedContents API (TTL 10 minutes). Each request sends only the question and the cache name.",
  cache: (ctx) => ({ system: `${tag(ctx)}\n\n${STABLE}`, tools: sortedTools() }),
  build: (ctx, i) => ({ user: QUESTIONS[i] }),
};

export const ALL_IDS = [...LAYOUTS.map((l) => l.id), EXPLICIT.id];
