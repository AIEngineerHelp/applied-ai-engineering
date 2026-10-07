// Detectors for content that changes between requests.
//
// A prompt cache is a prefix match: the provider reuses work only for the
// leading part of the prompt that is byte-for-byte identical to an earlier
// request. Each detector finds a value that is likely to differ from one
// request to the next, and says how often it changes:
//
//   request  changes on every call (a clock time, a request ID, a counter)
//   user     differs per user or session, stable within one (a name, an email)
//   day      changes once a day (today's date)
//
// Detection is heuristic. A date can be fixed ("policy effective 2024-01-01"),
// so the playground lets the reader dismiss any finding.

export const SCOPE_RANK = { static: 0, day: 1, user: 2, session: 2, request: 3 };

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

// Words near a date that say "this is the current date", not a fixed one.
const NOW_WORDS =
  /\b(?:today(?:'s date)?(?: is)?|current(?: date| time)?(?: is)?|(?:right )?now(?: is)?|as of|it is|the (?:date|time) is|date\s*:|time\s*:)\W*$/i;

export const RULES = {
  timestamp: {
    title: "Timestamp",
    scope: "request",
    why: "A clock time changes on every request, so the prompt stops matching the cache at this point.",
    fix: "Move the time to the end of the prompt (after the cached part), or drop the seconds and minutes if the model only needs the date.",
  },
  date: {
    title: "Date",
    scope: "day",
    why: "A current date changes once a day, so every day starts a new cache entry, and everything after the date is cached separately per day.",
    fix: "Put the date in the last message instead of the system prompt. If it is a fixed date, such as a policy's effective date, dismiss this.",
  },
  fixedDate: {
    title: "Date (probably fixed)",
    scope: "static",
    why: "This looks like a fixed date, which is fine. If your code fills it in with today's date, it changes daily and splits the cache.",
    fix: "Nothing to do if the date never changes.",
  },
  clock: {
    title: "Clock time",
    scope: "static",
    why: "A time of day that looks fixed.",
    fix: "Nothing to do if it never changes.",
  },
  identifier: {
    title: "Unique ID",
    scope: "request",
    why: "Request IDs, trace IDs and UUIDs are unique per call, so nothing after them can ever be reused.",
    fix: "Keep IDs out of the prompt. Send them as request metadata or log them on your side.",
  },
  sessionId: {
    title: "Session ID",
    scope: "user",
    why: "A session or conversation ID is different for every conversation, so the text after it can only be reused within that one conversation.",
    fix: "Keep it out of the prompt, or move it after the shared instructions.",
  },
  personal: {
    title: "Per-user detail",
    scope: "user",
    why: "Names, emails and account details differ per user. Placed early, they give every user a separate cache, and shared instructions after them are paid for again for each user.",
    fix: "Keep the system prompt identical for everyone. Pass user details in a later message, after the shared instructions.",
  },
  counter: {
    title: "Counter",
    scope: "request",
    why: "Turn counters and remaining-budget numbers change every request.",
    fix: "Move counters to the end of the prompt, or remove them if the model doesn't need them.",
  },
  template: {
    title: "Template variable",
    scope: "request",
    why: "A template slot is filled in at request time, so its value can change between requests.",
    fix: "Fill dynamic slots as late in the prompt as possible. Slots that are the same for every request are fine.",
  },
};

const PATTERNS = [
  // Order matters: earlier patterns win when matches overlap.
  { rule: "identifier", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  {
    rule: "identifier",
    re: /\b(?:request|req|trace|span|correlation|run|nonce|message)[ _-]?id\s*[:=]\s*["']?[A-Za-z0-9_\-]{4,}/gi,
  },
  { rule: "sessionId", re: /\b(?:session|conversation|thread|chat)[ _-]?id\s*[:=]\s*["']?[A-Za-z0-9_\-]{4,}/gi },
  { rule: "identifier", re: /\b[0-9a-f]{24,}\b/gi },
  {
    rule: "timestamp",
    re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  },
  { rule: "timestamp", re: /\b(?:datetime\.now|datetime\.utcnow|Date\.now|new Date|time\.time|now)\(\)/g },
  { rule: "timestamp", re: /\b1[6-9]\d{8}(?:\d{3})?\b/g },
  // Clock times with seconds are almost always "now". Without seconds they are
  // often fixed ("orders placed before 12:00"), so they need a "now" word nearby.
  { rule: "timestamp", re: /\b(?:[01]?\d|2[0-3]):[0-5]\d:[0-5]\d(?:\s?(?:[ap]\.?m\.?|UTC|GMT|[A-Z]{2,4}T))?(?![\w:])/gi },
  { rule: "clock", re: /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?(?:[ap]\.?m\.?|UTC|GMT|[A-Z]{2,4}T))?(?![\w:])/gi },
  { rule: "date", re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { rule: "date", re: new RegExp(`\\b(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\\s+)?${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`, "g") },
  { rule: "date", re: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTH},? \\d{4}\\b`, "g") },
  { rule: "date", re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  { rule: "personal", re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  {
    rule: "personal",
    re: /\b(?:user|customer|account|member|client|patient|employee)[ _-]?(?:name|id|number|no|email|tier|plan|locale|location|preferences)\s*[:=]\s*[^\n,;]{1,60}/gi,
  },
  { rule: "personal", re: /^[ \t-]*(?:name|full name|email|phone)\s*:\s*[^\n]{1,60}/gim },
  {
    rule: "personal",
    re: /\b(?:[Mm]y name is|[Yy]ou are (?:talking|speaking|chatting) (?:to|with)|[Tt]he (?:user|customer)(?:'s name)? is|[Yy]ou are helping)\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?/g,
  },
  { rule: "counter", re: /\b(?:turn|attempt|retry|iteration)\s*(?:#|no\.?|number)?\s*\d+(?:\s*(?:of|\/)\s*\d+)?\b/gi },
  { rule: "counter", re: /\b(?:tokens?|credits?|budget|quota|messages?)\s+(?:remaining|left|used)\s*[:=]?\s*\$?\d[\d,.]*/gi },
  { rule: "counter", re: /\b(?:remaining|used)\s+(?:tokens?|credits?|budget|quota)\s*[:=]?\s*\$?\d[\d,.]*/gi },
  { rule: "template", re: /\{\{\s*([\w.]+)\s*\}\}/g },
  { rule: "template", re: /\$\{\s*([\w.]+)\s*\}/g },
  { rule: "template", re: /(?<![\w"'{$])\{([a-zA-Z_][\w.]*)\}(?!["'}])/g },
];

// Template slots are classified by name, since their values aren't visible.
function templateScope(name) {
  const n = name.toLowerCase();
  if (/(date|time|now|today|timestamp|clock)/.test(n)) return { rule: "timestamp", scope: "request" };
  if (/(user|name|email|customer|account|profile|persona|session|locale|tenant|member)/.test(n)) {
    return { rule: "personal", scope: "user" };
  }
  if (/(question|query|input|message|request|prompt|docs|documents|context|results|retriev|chunks|history)/.test(n)) {
    return { rule: "template", scope: "request" };
  }
  return { rule: "template", scope: "request", unknown: true };
}

/** Find every value in `text` that is likely to change between requests. */
export function detect(text) {
  const found = [];
  for (const { rule, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      let match = { rule, scope: RULES[rule].scope, start, end, text: m[0] };
      if (rule === "template") {
        const t = templateScope(m[1]);
        match = { ...match, scope: t.scope, kind: t.rule, variable: m[1], unknown: Boolean(t.unknown) };
      } else if (rule === "date" || rule === "clock") {
        const before = text.slice(Math.max(0, start - 40), start);
        const now = NOW_WORDS.test(before);
        if (rule === "date" && !now) match = { ...match, rule: "fixedDate", scope: "static" };
        if (rule === "clock") match = now ? { ...match, rule: "timestamp", scope: "request" } : { ...match, rule: "fixedDate", scope: "static" };
      }
      found.push(match);
    }
  }
  // Keep the first pattern's match where two overlap.
  const kept = [];
  for (const m of found) {
    if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}
