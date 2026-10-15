// Prompt injection, found by pattern: text that tries to give the model new
// instructions. Used on the question (direct injection) and on everything the
// tools retrieve (indirect injection: a web page or abstract that talks to the
// model). Patterns are a fast first layer; the input screen's model call is the second.

const PATTERNS: RegExp[] = [
  // "ignore all previous instructions", "disregard the above prompt" — but not "ignore previous medical instructions".
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:(?:of\s+)?(?:the|these|those|my)\s+)?(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules|guidelines|directions|messages)\b/i,
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?your\s+(?:instructions?|prompts?|rules|guidelines|programming|guardrails)\b/i,
  /\b(?:reveal|print|show|repeat|output|leak)\b[^.\n]{0,30}\b(?:system prompt|hidden prompt|your (?:instructions|prompt|rules))\b/i,
  /\byou are now\b[^.\n]{0,40}\b(?:assistant|ai|model|bot|mode|dan|unrestricted|jailbroken)\b/i,
  /\b(?:developer|dan|jailbreak|god)\s*mode\b/i,
  /<\/?\s*(?:system|assistant|instructions?|im_start|im_end)\s*>/i,
  /\b(?:BEGIN|END)\s+(?:SYSTEM|INSTRUCTIONS|PROMPT)\b/,
  /\b(?:new|updated)\s+(?:system\s+)?instructions?\s*:/i,
  /\b(?:assistant|ai|model|llm)s?\b[^.\n]{0,30}\b(?:must|should)\b[^.\n]{0,20}\b(?:now|instead)\b[^.\n]{0,40}\b(?:say|write|reply|answer|output)\b/i,
];

/** The first phrase that looks like an instruction to the model, if any. */
export function findInjection(text: string): string | undefined {
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return undefined;
}

export const NEUTRALISED = "[removed: text that looked like instructions to an AI]";

/** Retrieved text with every sentence that looks like an instruction replaced, and how many were. */
export function neutralise(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text
    .split(/(?<=[.!?\n])\s+/)
    .map((sentence) => (findInjection(sentence) ? (removed++, NEUTRALISED) : sentence))
    .join(" ");
  return { text: removed ? out : text, removed };
}
