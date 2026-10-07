// Input cost of 1,000 requests with and without caching.
//
// A deliberately simple model so readers can check it by hand:
//
// - The shared prefix is written once and read by every later request, as long
//   as requests arrive closer together than the cache lifetime. If they don't,
//   every request writes it again and nothing is read.
// - The session prefix (the part only one user or conversation reuses) is
//   written on the first turn of each conversation and read on later turns.
// - Everything after the session prefix is billed at the full input price.
// - A prefix shorter than the model's minimum is not cached.
//
// Output tokens cost the same with or without caching, so they are left out.

export const REQUESTS = 1000;

export function estimateCost(analysis, model, traffic = {}) {
  const requestsPerHour = traffic.requestsPerHour ?? 600;
  const turns = Math.max(1, traffic.turnsPerConversation ?? 5);
  const total = analysis.totalTokens;
  let shared = analysis.sharedPrefixTokens;
  let session = Math.max(shared, analysis.sessionPrefixTokens);

  const perM = (tokens, price) => (tokens * price) / 1e6;
  const noCache = perM(total * REQUESTS, model.input);

  // Prefixes below the minimum aren't cached on their own.
  if (session < model.minTokens) session = 0;
  if (shared < model.minTokens) shared = 0;

  const gapMinutes = 60 / requestsPerHour;
  const warm = gapMinutes < model.ttlMinutes;
  const conversations = Math.ceil(REQUESTS / turns);

  const tokens = { sharedRead: 0, sharedWrite: 0, sessionRead: 0, sessionWrite: 0, full: 0 };

  if (shared) {
    const writes = warm ? 1 : REQUESTS;
    tokens.sharedWrite = shared * writes;
    tokens.sharedRead = shared * (REQUESTS - writes);
  }
  const sessionOnly = session - shared;
  if (session && sessionOnly > 0) {
    // Turns of one conversation are assumed to arrive within the cache lifetime.
    tokens.sessionWrite = sessionOnly * conversations;
    tokens.sessionRead = sessionOnly * (REQUESTS - conversations);
  }
  tokens.full = total * REQUESTS - tokens.sharedRead - tokens.sharedWrite - tokens.sessionRead - tokens.sessionWrite;

  const withCache =
    perM(tokens.sharedRead + tokens.sessionRead, model.read) +
    perM(tokens.sharedWrite + tokens.sessionWrite, model.write) +
    perM(tokens.full, model.input);

  const read = tokens.sharedRead + tokens.sessionRead;
  return {
    requests: REQUESTS,
    noCache,
    withCache,
    saved: noCache - withCache,
    savedPct: noCache ? ((noCache - withCache) / noCache) * 100 : 0,
    cachedShare: total ? read / (total * REQUESTS) : 0,
    warm,
    gapMinutes,
    tokens,
  };
}
