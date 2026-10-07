// Prompt cache analysis: where does the reusable prefix end, and why?
//
// A prompt is an ordered list of blocks, in the order the provider renders them
// (for Claude: tools, then system, then messages). Each block says how often it
// changes. The analyzer walks the blocks in order and finds:
//
//   shared prefix   identical for every user and request: cached once, reused by all
//   session prefix  identical for later requests from the same user or conversation
//   the rest        different on every request, always billed at the full input price
//
// It also explains what ended each prefix and suggests a better order.

import { detect, RULES, SCOPE_RANK } from "./detectors.js";
import { estimateTokens, charsToTokens } from "./tokens.js";

export const BLOCK_KINDS = {
  tools: { label: "Tool definitions", defaultChange: "static" },
  system: { label: "System prompt", defaultChange: "static" },
  examples: { label: "Few-shot examples", defaultChange: "static" },
  documents: { label: "Documents", defaultChange: "static" },
  history: { label: "Conversation history", defaultChange: "session" },
  user: { label: "User message", defaultChange: "request" },
};

export const CHANGE_LABELS = {
  static: "Same for everyone",
  session: "Different per user",
  request: "Different every request",
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

function blockChange(block) {
  if (block.change && block.change !== "auto") return block.change;
  return BLOCK_KINDS[block.kind]?.defaultChange ?? "static";
}

function maxScope(a, b) {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

// Treat "user" and "session" as one level: stable for one user, not across users.
function level(scope) {
  return scope === "user" ? "session" : scope;
}

/**
 * Analyze a prompt.
 * @param {Array<{id:string, kind:string, label?:string, text:string, change?:string}>} blocks
 * @param {{minTokens?: number, dismissed?: string[]}} options
 */
export function analyze(blocks, options = {}) {
  const minTokens = options.minTokens ?? 1024;
  const dismissed = new Set(options.dismissed ?? []);

  let cursor = 0;
  const rendered = blocks.map((block) => {
    const tokens = estimateTokens(block.text);
    const change = blockChange(block);
    // Matches are grouped per block and rule, and dismissed as a group.
    const matches = detect(block.text).map((m) => ({ ...m, key: matchKey(block.id, m) }));
    const active = matches.filter((m) => !dismissed.has(m.key) && m.scope !== "static");
    const startToken = cursor;
    cursor += tokens;
    return { ...block, label: block.label || BLOCK_KINDS[block.kind]?.label || block.kind, tokens, startToken, change, matches, active };
  });
  const totalTokens = cursor;

  // Walk the prompt and find the first point that breaks each prefix.
  // `day` values are cacheable within the day, so they don't end the shared prefix,
  // but they are reported.
  function firstBreak(levels) {
    for (const b of rendered) {
      if (levels.includes(level(b.change))) {
        return { blockId: b.id, token: b.startToken, reason: "block", scope: b.change };
      }
      const hit = b.active.find((m) => levels.includes(level(m.scope)));
      if (hit) {
        return { blockId: b.id, token: b.startToken + charsToTokens(hit.start), reason: "match", match: hit, scope: hit.scope };
      }
    }
    return null;
  }

  const sharedBreak = firstBreak(["session", "request"]);
  const sessionBreak = firstBreak(["request"]);
  const sharedPrefixTokens = sharedBreak ? sharedBreak.token : totalTokens;
  const sessionPrefixTokens = sessionBreak ? sessionBreak.token : totalTokens;

  const findings = [];

  // 1. Values inside blocks that are supposed to be stable, one finding per block and rule.
  for (const b of rendered) {
    if (level(b.change) === "request") continue;
    const groups = new Map();
    for (const m of b.matches) {
      if (m.scope === "static") continue;
      if (SCOPE_RANK[level(m.scope)] <= SCOPE_RANK[level(b.change)]) continue;
      if (!groups.has(m.key)) groups.set(m.key, []);
      groups.get(m.key).push(m);
    }
    for (const [key, group] of groups) {
      const m = group[0];
      const at = b.startToken + charsToTokens(m.start);
      // Stable tokens from this point on, which are paid again whenever the value changes.
      const lostTokens = Math.max(0, totalTokens - at - tokensAfterNotCacheable(rendered, at));
      const rule = RULES[m.kind ?? m.rule] ?? RULES[m.rule];
      const title = m.rule === "template" ? `Template variable {${m.variable}}` : rule.title;
      let severity = lostTokens >= 1024 || lostTokens >= totalTokens * 0.3 ? "high" : lostTokens >= 200 ? "medium" : "low";
      if (level(m.scope) === "day") severity = severity === "high" ? "medium" : "low";
      const where = b.kind === "tools" ? " Tool definitions render first, so a change here invalidates the whole prompt." : "";
      const values = group.map((x) => `"${truncate(x.text)}"`).join(", ");
      findings.push({
        id: key,
        rule: m.rule,
        severity,
        title: `${title} in ${b.label}`,
        detail: `${values}. ${rule.why}${where}`,
        fix: m.unknown ? `If {${m.variable}} is the same for every request, it is fine. Otherwise: ${lower(rule.fix)}` : rule.fix,
        blockId: b.id,
        ranges: group.map((x) => [x.start, x.end]),
        scope: m.scope,
        lostTokens,
        dismissible: true,
      });
    }
  }

  // 2. Block order: a block that changes more often sits before one that changes less
  // often. Tool definitions are excluded: providers always render them first.
  for (let i = 0; i < rendered.length; i++) {
    const b = rendered[i];
    if (b.kind === "tools") continue;
    const later = rendered.slice(i + 1).filter((x) => SCOPE_RANK[level(x.change)] < SCOPE_RANK[level(b.change)]);
    const stuck = later.reduce((sum, x) => sum + x.tokens, 0);
    if (!later.length || stuck < 50) continue;
    const names = later.map((x) => x.label).join(", ");
    findings.push({
      id: `order:${b.id}`,
      rule: "order",
      severity: stuck >= 1024 || stuck >= totalTokens * 0.3 ? "high" : "medium",
      title: `${b.label}: placed before more stable content`,
      detail: `${b.label} changes ${b.change === "request" ? "on every request" : "per user"}, but ${names} (≈${stuck.toLocaleString("en-US")} tokens) ${later.length > 1 ? "come" : "comes"} after it. A cache only reuses the prefix up to the first change, so those tokens are paid in full each time.`,
      fix: `Move ${names} above ${b.label}. Order blocks from most stable to least stable.`,
      blockId: b.id,
      lostTokens: stuck,
    });
  }

  // 3. Tool lists should be serialized deterministically.
  for (const b of rendered.filter((x) => x.kind === "tools")) {
    const names = toolNames(b.text);
    if (names && names.length > 1 && !isSorted(names)) {
      findings.push({
        id: `tools-order:${b.id}`,
        rule: "tools-order",
        severity: "info",
        title: "Tool order isn't sorted",
        detail: `Tools: ${names.join(", ")}. This is fine if your code always emits them in this order. If the list is built from a dict, set or registry, the order can change between processes, and every change misses the whole cache.`,
        fix: "Sort tools by name (and JSON keys) before sending, and keep the same tool set for the whole conversation.",
        blockId: b.id,
        dismissible: true,
      });
    }
    if (b.change !== "static") {
      findings.push({
        id: `tools-dynamic:${b.id}`,
        rule: "tools-dynamic",
        severity: "high",
        title: "Tool definitions change",
        detail: "Tools are rendered at the very start of the prompt. If the tool set differs per user or request, nothing after it can be shared.",
        fix: "Send the same tool set to everyone and enforce permissions when a tool is called, not by hiding tools.",
        blockId: b.id,
        lostTokens: totalTokens - b.startToken,
      });
    }
  }

  // 4. A reusable prefix shorter than the provider's minimum is not cached at all.
  const best = Math.max(sharedPrefixTokens, sessionPrefixTokens);
  if (best > 0 && best < minTokens) {
    findings.push({
      id: "below-minimum",
      rule: "below-minimum",
      severity: "info",
      title: "Reusable prefix is below the minimum",
      detail: `The longest reusable prefix is ≈${best.toLocaleString("en-US")} tokens, and this model caches only prefixes of at least ${minTokens.toLocaleString("en-US")} tokens. Shorter prefixes are processed in full, with no error.`,
      fix: "No action needed for a short prompt. When the prompt grows, keep the stable part together at the front so it crosses the minimum.",
    });
  }

  const visible = findings.filter((f) => !dismissed.has(f.id));
  visible.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.lostTokens ?? 0) - (a.lostTokens ?? 0));

  return {
    blocks: rendered,
    totalTokens,
    sharedPrefixTokens,
    sessionPrefixTokens,
    sharedBreak,
    sessionBreak,
    minTokens,
    findings: visible,
    dismissedCount: findings.length - visible.length,
    score: score(totalTokens, sharedPrefixTokens, sessionPrefixTokens, rendered),
  };
}

// Tokens after `at` that can't be cached anyway (request-level blocks).
function tokensAfterNotCacheable(rendered, at) {
  return rendered
    .filter((b) => b.startToken >= at && level(b.change) === "request")
    .reduce((s, b) => s + b.tokens, 0);
}

// Share of the content that could be cached (everything not rebuilt per request)
// that actually sits inside a reusable prefix.
// Half the score is cross-user reuse (shared prefix against content marked
// "never changes"), half is reuse within a conversation.
function score(total, shared, session, rendered) {
  const sum = (pred) => rendered.filter(pred).reduce((s, b) => s + b.tokens, 0);
  const staticTokens = sum((b) => b.change === "static");
  const cacheable = sum((b) => level(b.change) !== "request");
  if (!cacheable) return 100;
  const cross = staticTokens ? Math.min(1, shared / staticTokens) : 1;
  const within = Math.min(1, session / cacheable);
  return Math.round(50 * cross + 50 * within);
}

export function matchKey(blockId, match) {
  return `${blockId}:${match.rule}`;
}

/**
 * Suggest a cache-friendly layout: pull volatile lines out of stable blocks into a
 * dynamic-context block, then order blocks from most to least stable.
 * Returns the new blocks and a list of human-readable changes.
 */
export function optimize(blocks, options = {}) {
  const dismissed = new Set(options.dismissed ?? []);
  const changes = [];
  const moved = { session: [], request: [] };
  const out = [];

  for (const block of blocks) {
    const change = blockChange(block);
    if (SCOPE_RANK[change] >= SCOPE_RANK.request) {
      out.push({ ...block, change });
      continue;
    }
    const matches = detect(block.text).filter(
      (m) =>
        m.scope !== "static" &&
        !dismissed.has(matchKey(block.id, m)) &&
        SCOPE_RANK[m.scope] > SCOPE_RANK[level(change)],
    );
    if (!matches.length) {
      out.push({ ...block, change });
      continue;
    }
    // Move whole lines that contain a volatile value.
    const lines = block.text.split("\n");
    const keep = [];
    let offset = 0;
    for (const line of lines) {
      const end = offset + line.length;
      const hits = matches.filter((m) => m.start < end + 1 && m.end > offset);
      if (hits.length) {
        const worst = hits.reduce((s, m) => maxScope(s, m.scope), "static");
        const bucket = level(worst) === "request" ? "request" : "session";
        moved[bucket].push(line.trim());
        changes.push(`Moved "${truncate(line.trim(), 60)}" out of ${block.label || BLOCK_KINDS[block.kind]?.label} into the dynamic context near the end.`);
      } else {
        keep.push(line);
      }
      offset = end + 1;
    }
    out.push({ ...block, text: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), change });
  }

  if (moved.session.length) {
    out.push({ id: "moved-session", kind: "documents", label: "User context", text: moved.session.join("\n"), change: "session" });
  }
  if (moved.request.length) {
    out.push({ id: "moved-request", kind: "documents", label: "Request context", text: moved.request.join("\n"), change: "request" });
  }

  // Stable sort by how often a block changes. Tools stay first (providers render
  // them first anyway), and the user's message stays last within its level.
  const before = out.map((b) => b.id).join(",");
  const ordered = out
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      const t = (y.b.kind === "tools") - (x.b.kind === "tools");
      if (t) return t;
      const r = SCOPE_RANK[level(x.b.change)] - SCOPE_RANK[level(y.b.change)];
      if (r) return r;
      const u = (x.b.kind === "user") - (y.b.kind === "user");
      return u || x.i - y.i;
    })
    .map(({ b }) => b);
  if (ordered.map((b) => b.id).join(",") !== before) {
    changes.push("Reordered blocks from most stable to least stable: shared content first, per-user content next, per-request content last.");
  }
  for (const b of ordered.filter((x) => x.kind === "tools")) {
    const names = toolNames(b.text);
    if (names && names.length > 1 && !isSorted(names)) {
      b.text = sortTools(b.text) ?? b.text;
      changes.push("Sorted tool definitions by name so the order is the same in every process.");
    }
  }
  return { blocks: ordered.filter((b) => b.text.trim()), changes };
}

function toolNames(text) {
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.tools ?? parsed.functionDeclarations ?? parsed.function_declarations;
    if (!Array.isArray(list)) return null;
    const names = list.map((t) => t.name ?? t.function?.name).filter(Boolean);
    return names.length === list.length ? names : null;
  } catch {
    return null;
  }
}

function sortTools(text) {
  try {
    const parsed = JSON.parse(text);
    const name = (t) => t.name ?? t.function?.name;
    const sort = (list) => [...list].sort((a, b) => name(a).localeCompare(name(b)));
    if (Array.isArray(parsed)) return JSON.stringify(sort(parsed), null, 2);
    for (const key of ["tools", "functionDeclarations", "function_declarations"]) {
      if (Array.isArray(parsed[key])) return JSON.stringify({ ...parsed, [key]: sort(parsed[key]) }, null, 2);
    }
  } catch {
    // Not JSON: leave it alone.
  }
  return null;
}

function isSorted(names) {
  return names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0);
}

function truncate(s, n = 48) {
  const t = s.replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function lower(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
