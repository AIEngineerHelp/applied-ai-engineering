// Conflict resolution by scope and source authority. Pure code, no model: given structured facts and a
// ranking of source types, decide for each key and scope which value is current, why every other value
// lost, and when the rule cannot decide (the result is "disputed" and goes to a person).
//
// The rule, in order:
//   1. Scope: a fact for "all" applies to every scope; a fact for one scope applies only there.
//      Many apparent conflicts (90 days vs 30 days) are really two scopes.
//   2. Authority: a higher-ranked source type wins.
//   3. Recency: at the same rank, the newer document wins.
//   4. Same rank, same date, different values: disputed. Never pick silently.

export interface Fact {
  key: string;
  value: string;
  /** "all", or one concrete scope such as "enterprise". */
  scope: string;
  source: string;
  sourceType: string;
  /** Document date, YYYY-MM-DD. */
  date: string;
  /** The sentence in the source that states the fact, verbatim. */
  quote: string;
}

export interface RankTier {
  rank: number;
  types: string[];
  note: string;
}

export interface Lost {
  fact: Fact;
  /** "agrees": same value as the current one, kept as support. */
  kind: "outranked" | "older" | "agrees";
  reason: string;
}

export interface Resolution {
  key: string;
  scope: string;
  status: "current" | "disputed";
  /** The winning fact when status is "current". */
  current: Fact | null;
  /** The facts that tie when status is "disputed". */
  contenders: Fact[];
  lost: Lost[];
}

export function rankOf(ranking: RankTier[], type: string): number {
  const tier = ranking.find((t) => t.types.includes(type));
  if (!tier) throw new Error(`Unknown source type "${type}": add it to the ranking`);
  return tier.rank;
}

const norm = (v: string) => v.trim().toLowerCase();

export function resolveScope(facts: Fact[], ranking: RankTier[], key: string, scope: string): Resolution {
  const candidates = facts.filter((f) => f.key === key && (f.scope === scope || f.scope === "all"));
  if (candidates.length === 0) throw new Error(`No facts for ${key} / ${scope}`);
  // Strongest first: higher rank, then newer date. Ties keep input order.
  const sorted = candidates
    .map((f, i) => ({ f, i, r: rankOf(ranking, f.sourceType) }))
    .sort((a, b) => b.r - a.r || b.f.date.localeCompare(a.f.date) || a.i - b.i);
  const top = sorted[0];
  const tied = sorted.filter((x) => x.r === top.r && x.f.date === top.f.date);
  const tiedValues = new Set(tied.map((x) => norm(x.f.value)));
  if (tiedValues.size > 1) {
    const contenders = tied.map((x) => x.f);
    return {
      key,
      scope,
      status: "disputed",
      current: null,
      contenders,
      lost: sorted
        .filter((x) => !contenders.includes(x.f))
        .map((x) => ({ fact: x.f, kind: "outranked" as const, reason: `Lower rank (${x.f.sourceType} < ${tied[0].f.sourceType}); it can't settle the tie` })),
    };
  }
  const winner = top.f;
  const lost: Lost[] = sorted.slice(1).map((x) => {
    if (norm(x.f.value) === norm(winner.value)) return { fact: x.f, kind: "agrees", reason: "Same value; kept as a supporting source" };
    if (x.r < top.r) return { fact: x.f, kind: "outranked", reason: `Lower rank (${x.f.sourceType} < ${winner.sourceType})` };
    return { fact: x.f, kind: "older", reason: `Older than ${winner.source} (${winner.date}), same rank` };
  });
  return { key, scope, status: "current", current: winner, contenders: [], lost };
}

/** Resolves every key over its scopes. */
export function resolveAll(facts: Fact[], ranking: RankTier[], keys: Record<string, { scopes: string[] }>): Resolution[] {
  return Object.entries(keys).flatMap(([key, { scopes }]) => scopes.map((scope) => resolveScope(facts, ranking, key, scope)));
}

