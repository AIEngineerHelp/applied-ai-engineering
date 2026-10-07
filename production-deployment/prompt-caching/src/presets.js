// Example prompts for the playground. Each one shows a common caching mistake,
// except the last, which shows the fix.

import { INSTRUCTIONS, HANDBOOK, EXAMPLES, toolsJson, TOOLS } from "./fixture.js";

const SYSTEM = `${INSTRUCTIONS}\n\n${HANDBOOK}`;

export const PRESETS = [
  {
    id: "timestamp",
    title: "Timestamp at the top",
    summary: "The current time is the first line of the system prompt, so the prefix changes every second.",
    blocks: [
      { id: "tools", kind: "tools", text: toolsJson() },
      { id: "system", kind: "system", text: `Current time: 2026-10-07T14:32:09Z\n\n${SYSTEM}` },
      { id: "examples", kind: "examples", text: EXAMPLES },
      { id: "user", kind: "user", text: "Can I return a tent I set up once in my garden?" },
    ],
  },
  {
    id: "personalized",
    title: "Personalized system prompt",
    summary: "The customer's name and account details open the system prompt, so every customer gets a separate cache.",
    blocks: [
      { id: "tools", kind: "tools", text: toolsJson() },
      {
        id: "system",
        kind: "system",
        text: `You are helping Alex Rivera.\nCustomer email: alex.rivera@example.com\nCustomer tier: Trail Club member since 2023\n\n${SYSTEM}`,
      },
      { id: "examples", kind: "examples", text: EXAMPLES },
      { id: "user", kind: "user", text: "How many points do I need for a $20 credit?" },
    ],
  },
  {
    id: "question-first",
    title: "Question before the documents",
    summary: "A retrieval app pastes the user's question first and the handbook after it, so the handbook is never cached.",
    blocks: [
      { id: "system", kind: "system", text: INSTRUCTIONS },
      { id: "user", kind: "user", text: "Question: Do you ship fuel canisters to Canada?" },
      { id: "docs", kind: "documents", label: "Policy handbook", text: HANDBOOK },
    ],
  },
  {
    id: "agent-state",
    title: "Agent state in the system prompt",
    summary: "An agent loop writes a request ID, the turn number and a token budget into the system prompt on every call.",
    blocks: [
      { id: "tools", kind: "tools", text: toolsJson() },
      {
        id: "system",
        kind: "system",
        text: `${INSTRUCTIONS}\n\nrequest_id: 9f3c2a71-5b4e-4d0a-9c1e-7a2b8d6f0e13\nTurn 4 of 20\nTokens remaining: 18,240\n\n${HANDBOOK}`,
      },
      { id: "history", kind: "history", text: "Customer: My boots are too small.\nAssistant: I can help with that. What's your order number?" },
      { id: "user", kind: "user", text: "It's NW-104233. I need a 10.5." },
    ],
  },
  {
    id: "dynamic-tools",
    title: "Tools that change per user",
    summary: "The app hides tools the user isn't allowed to use, so the tool list differs per user. Tools render first, so nothing is shared.",
    blocks: [
      { id: "tools", kind: "tools", text: toolsJson([...TOOLS].reverse().filter((t) => t.name !== "cancel_order")), change: "session" },
      { id: "system", kind: "system", text: SYSTEM },
      { id: "examples", kind: "examples", text: EXAMPLES },
      { id: "user", kind: "user", text: "Where is my order NW-104233?" },
    ],
  },
  {
    id: "optimized",
    title: "Cache-friendly layout",
    summary: "Stable content first, then per-user context, then the question. The date and the customer's details sit near the end.",
    blocks: [
      { id: "tools", kind: "tools", text: toolsJson() },
      { id: "system", kind: "system", text: SYSTEM },
      { id: "examples", kind: "examples", text: EXAMPLES },
      { id: "context", kind: "documents", label: "Customer context", text: "Customer: Alex Rivera, Trail Club member", change: "session" },
      { id: "history", kind: "history", text: "Customer: My boots are too small.\nAssistant: I can help with that. What's your order number?" },
      { id: "user", kind: "user", text: "Today's date: 7 October 2026\n\nIt's NW-104233. I need a 10.5." },
    ],
  },
];
