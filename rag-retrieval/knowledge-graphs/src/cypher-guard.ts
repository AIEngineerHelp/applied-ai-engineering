// A guard for model-written Cypher, run before any query reaches the database.
// Neo4j's own read transactions are not a security boundary (the driver manual
// says there is "no security guarantee" that a write in read mode is rejected),
// and Community Edition and AuraDB Free have no read-only role, so the query
// text itself must be checked: one read-only statement, bounded path lengths,
// and a row limit. On Enterprise or AuraDB Professional, also connect as a
// user with the built-in `reader` role.

export const MAX_DEPTH = 5;
export const MAX_ROWS = 100;

export type GuardResult = { ok: true; cypher: string } | { ok: false; reason: string };

/** Remove string literals and comments, so keywords inside them are not mistaken for clauses. */
export function stripLiterals(q: string): string {
  return q
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, "``");
}

const WRITE_OR_ADMIN = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|FOREACH|LOAD|CALL|ALTER|GRANT|DENY|REVOKE|RENAME|START|STOP|TERMINATE|USE|SHOW|ENABLE|DISABLE)\b/i;

export function guardCypher(input: string): GuardResult {
  let q = input.trim().replace(/;\s*$/, "");
  if (!q) return { ok: false, reason: "The query is empty." };
  if (q.length > 2000) return { ok: false, reason: "The query is longer than 2,000 characters." };
  const bare = stripLiterals(q);
  if (bare.includes(";")) return { ok: false, reason: "Only one statement is allowed." };
  const kw = WRITE_OR_ADMIN.exec(bare);
  if (kw) return { ok: false, reason: `"${kw[1].toUpperCase()}" is not allowed: only read queries can run.` };
  if (/\b(apoc|dbms|gds|db)\s*\./i.test(bare)) return { ok: false, reason: "Procedures and system functions are not allowed." };
  if (!/^\s*(OPTIONAL\s+MATCH|MATCH|WITH|UNWIND|RETURN)\b/i.test(bare)) return { ok: false, reason: "The query must start with MATCH, OPTIONAL MATCH, WITH, UNWIND or RETURN." };
  if (!/\bRETURN\b/i.test(bare)) return { ok: false, reason: "The query must RETURN something." };
  // Variable-length relationships: [*], [*2..], [:R*1..9] need an upper bound of at most MAX_DEPTH.
  for (const m of bare.matchAll(/\[[^\]]*?\*\s*(\d*)\s*(\.\.)?\s*(\d*)[^\]]*\]/g)) {
    const [, a, dots, b] = m;
    const upper = dots ? b : a;
    if (!upper) return { ok: false, reason: `Variable-length paths need an upper bound (at most ${MAX_DEPTH} hops).` };
    if (Number(upper) > MAX_DEPTH) return { ok: false, reason: `Paths may be at most ${MAX_DEPTH} hops long.` };
  }
  // Quantified path patterns: ){1,3}, ]{2}, )+ or )* .
  if (/[)\]>-]\s*[+*]\s*[(<-]/.test(bare)) return { ok: false, reason: `Unbounded path quantifiers (+ or *) are not allowed; use {1,${MAX_DEPTH}}.` };
  for (const m of bare.matchAll(/[)\]>-]\s*\{\s*(\d*)\s*(,)?\s*(\d*)\s*\}/g)) {
    const [, a, comma, b] = m;
    const upper = comma ? b : a;
    if (!upper) return { ok: false, reason: `Path quantifiers need an upper bound (at most ${MAX_DEPTH}).` };
    if (Number(upper) > MAX_DEPTH) return { ok: false, reason: `Paths may be at most ${MAX_DEPTH} hops long.` };
  }
  // A row limit: append one if the final RETURN has none; refuse a larger one.
  const limit = /\bLIMIT\s+(\d+)\s*$/i.exec(bare);
  if (limit && Number(limit[1]) > MAX_ROWS) return { ok: false, reason: `LIMIT may be at most ${MAX_ROWS}.` };
  if (!limit) q = `${q}\nLIMIT ${MAX_ROWS}`;
  return { ok: true, cypher: q };
}
