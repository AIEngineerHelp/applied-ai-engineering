// Caching rules and prices per model, from each provider's official docs.
// Checked on 2026-10-07. Prices are USD per million input tokens, standard tier.
// Prices change: check the linked pages before relying on them.

export const CHECKED_ON = "2026-10-07";

export const PROVIDERS = {
  anthropic: {
    name: "Anthropic Claude",
    how: "Explicit: mark breakpoints with cache_control (up to 4), or set it once at the top level for automatic placement.",
    report: "usage.cache_read_input_tokens and usage.cache_creation_input_tokens",
    docs: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    pricing: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
  gemini: {
    name: "Google Gemini",
    how: "Implicit caching is on by default, with no guaranteed saving. Explicit caching (cachedContents) guarantees the discount and adds an hourly storage fee.",
    report: "usageMetadata.cachedContentTokenCount (generateContent) or usage.total_cached_tokens (Interactions API)",
    docs: "https://ai.google.dev/gemini-api/docs/caching",
    pricing: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  openai: {
    name: "OpenAI",
    how: "Automatic on supported models. GPT-5.6 and later also accept explicit breakpoints and charge for cache writes.",
    report: "usage.input_tokens_details.cached_tokens and cache_write_tokens",
    docs: "https://developers.openai.com/api/docs/guides/prompt-caching",
    pricing: "https://developers.openai.com/api/docs/pricing",
  },
};

// input: full price. read: cached-token price. write: price for tokens written to
// the cache (equal to `input` when the provider charges no write premium).
// ttlMinutes: how long an entry lives without traffic (best effort where noted).
export const MODELS = [
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    input: 4.0,
    read: 0.2,
    write: 5.0,
    minTokens: 512,
    ttlMinutes: 5,
    ttlNote: "5 minutes, refreshed on every hit (1 hour available at 2× the input price for writes)",
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    input: 2.0,
    read: 0.2,
    write: 2.5,
    minTokens: 512,
    ttlMinutes: 5,
    ttlNote: "5 minutes, refreshed on every hit (1 hour available at 2× the input price for writes)",
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    input: 1.0,
    read: 0.1,
    write: 1.25,
    minTokens: 4096,
    ttlMinutes: 5,
    ttlNote: "5 minutes, refreshed on every hit (1 hour available at 2× the input price for writes)",
  },
  {
    id: "gemini-3.8-flash",
    provider: "gemini",
    label: "Gemini 3.8 Flash",
    input: 0.75,
    read: 0.075,
    write: 0.75,
    minTokens: 4096,
    ttlMinutes: 5,
    ttlNote: "Implicit caching: lifetime not documented, best effort. Explicit caches default to 1 hour, plus $0.50 per million tokens per hour of storage.",
    priceNote: "Promotional price through 2026-12-31; it doubles on 2027-01-01.",
  },
  {
    id: "gemini-3.1-pro-preview",
    provider: "gemini",
    label: "Gemini 3.1 Pro Preview",
    input: 2.0,
    read: 0.2,
    write: 2.0,
    minTokens: 4096,
    ttlMinutes: 5,
    ttlNote: "Implicit caching: lifetime not documented, best effort. Explicit caches add $4.50 per million tokens per hour of storage.",
  },
  {
    id: "gpt-6.1-sol",
    provider: "openai",
    label: "GPT-6.1 Sol",
    input: 2.0,
    read: 0.1,
    write: 2.5,
    minTokens: 1024,
    ttlMinutes: 30,
    ttlNote: "30 minutes",
  },
  {
    id: "gpt-6-luna",
    provider: "openai",
    label: "GPT-6 Luna",
    input: 0.1,
    read: 0.01,
    write: 0.125,
    minTokens: 1024,
    ttlMinutes: 30,
    ttlNote: "30 minutes",
  },
];

export function getModel(id) {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}
