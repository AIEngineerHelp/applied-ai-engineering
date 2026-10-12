// The model behind the figure: one agent task, run step by step through a
// harness whose parts can be removed. Every number the page shows (context
// used, tokens billed, what went wrong) comes from `run()`.
//
// Token sizes are illustrative, chosen to match common orders of magnitude for
// a coding agent. They are not measurements of any product.

export type GroupId = "context" | "execution" | "delegation" | "steering";

export type PartId =
  | "skills"
  | "memory"
  | "summarization"
  | "offloading"
  | "repl"
  | "sandbox"
  | "filesystem"
  | "code"
  | "planning"
  | "subagents"
  | "hitl";

export interface Group {
  id: GroupId;
  name: string;
  /** What the group is for, in one sentence. */
  job: string;
}

export interface Part {
  id: PartId;
  group: GroupId;
  name: string;
  /** The machine part it is drawn as. */
  object: string;
  /** What it does, in one or two sentences. */
  does: string;
  /** What goes wrong in the run when it is removed. */
  without: string;
  /** Parts this one cannot work without. */
  needs: PartId[];
}

export const GROUPS: Group[] = [
  { id: "context", name: "Context management", job: "Decide what the model sees on each call, inside a fixed window." },
  { id: "execution", name: "Execution environment", job: "Give the model a computer: somewhere to run code and keep files." },
  { id: "delegation", name: "Delegation", job: "Split work that is too big for one window, and keep track of it." },
  { id: "steering", name: "Steering", job: "Put a person at the decisions that should not be automatic." },
];

export const PARTS: Part[] = [
  {
    id: "skills",
    group: "context",
    name: "Skills",
    object: "Card rack",
    does: "Playbooks the agent can load on demand. Only each card’s name and one-line description sit in the window; the full card is pulled when a task matches.",
    without: "Every playbook has to be pasted into the system prompt up front, so all eight cost tokens on every call.",
    needs: [],
  },
  {
    id: "memory",
    group: "context",
    name: "Memory",
    object: "Filing cabinet",
    does: "Notes that outlive a session, such as an AGENTS.md file and learned facts, loaded at the start of each run.",
    without: "The agent does not know the repository’s conventions, so its first fix is wrong and has to be redone.",
    needs: ["filesystem"],
  },
  {
    id: "summarization",
    group: "context",
    name: "Summarization",
    object: "Press",
    does: "When the window passes a threshold, older turns are pressed into one short summary so the run can continue.",
    without: "Nothing makes room. If the window fills, the next call does not fit and the run stops.",
    needs: [],
  },
  {
    id: "offloading",
    group: "context",
    name: "Context offloading",
    object: "Chute",
    does: "Large tool outputs go to a file instead of the window. The model keeps a short head and tail plus the path, and can read more if it needs to.",
    without: "Every test log lands in the window in full and is re-read on every later call.",
    needs: ["filesystem"],
  },
  {
    id: "repl",
    group: "execution",
    name: "REPL",
    object: "Terminal",
    does: "Read, execute, print, loop: the agent’s command runs and the output comes back as the next input. It is how the agent checks its own work.",
    without: "The agent cannot run anything. It reads code and guesses, and nothing it changes is tested.",
    needs: [],
  },
  {
    id: "sandbox",
    group: "execution",
    name: "Sandbox",
    object: "Glass case",
    does: "An isolated, disposable machine with only the repository mounted, no personal credentials and a network allowlist.",
    without: "Commands run on your own machine, as you, with your keys and cloud credentials in reach.",
    needs: [],
  },
  {
    id: "filesystem",
    group: "execution",
    name: "File system",
    object: "Shelves",
    does: "A workspace the agent can read and write across turns: scratch files for work in progress, persistent files for what should last.",
    without: "There is nowhere to put anything, so offloading, scratch scripts and saved memories all stop working.",
    needs: [],
  },
  {
    id: "code",
    group: "execution",
    name: "Write & run code",
    object: "Workbench",
    does: "The agent writes its own small scripts to a scratch file and runs them, instead of only calling fixed tools.",
    without: "To narrow the bug down, the agent can only re-run the whole suite with more output.",
    needs: ["repl", "filesystem"],
  },
  {
    id: "planning",
    group: "delegation",
    name: "Planning",
    object: "Peg board",
    does: "A to-do list the agent writes first and ticks off as it goes, so a long run keeps its shape.",
    without: "With no list to check against, the agent declares success after the one failing test passes and skips the full suite.",
    needs: [],
  },
  {
    id: "subagents",
    group: "delegation",
    name: "Subagents",
    object: "Small engines",
    does: "Separate agents, each with its own clean window, that take a self-contained job and return only a short report.",
    without: "The main agent reads all fourteen files itself, and they stay in its window for the rest of the run.",
    needs: [],
  },
  {
    id: "hitl",
    group: "steering",
    name: "Human in the loop",
    object: "Gate and lever",
    does: "The run pauses at a high-impact action. A person approves, edits or rejects it, and the run continues.",
    without: "The agent pushes straight to the main branch with no one looking.",
    needs: [],
  },
];

export const ALL_PARTS: PartId[] = PARTS.map((p) => p.id);

export const partById = (id: PartId): Part => {
  const part = PARTS.find((p) => p.id === id);
  if (!part) throw new Error(`Unknown part: ${id}`);
  return part;
};

/** The context window and the point at which the press compacts it. */
export const WINDOW = 200_000;
export const COMPACT_AT = 160_000;

export type BlockKind = "system" | "memory" | "skill" | "task" | "plan" | "file" | "output" | "tag" | "report" | "edit" | "summary";

export interface Block {
  id: string;
  kind: BlockKind;
  label: string;
  tokens: number;
  /** Pinned blocks are re-sent after a compaction; the rest are summarized. */
  pinned?: boolean;
}

export type Tone = "info" | "good" | "bad" | "pause";

export type Problem = "overflow" | "host" | "unreviewed" | "unverified" | "stopped-early" | "rework" | "forgets";

export const PROBLEMS: Record<Problem, string> = {
  overflow: "Ran out of context window and stopped",
  host: "Ran package install scripts on your own machine",
  unreviewed: "Pushed to main with no review",
  unverified: "Changed code it never ran",
  "stopped-early": "Skipped the full test suite",
  rework: "Redid the fix after missing a convention",
  forgets: "Saved nothing for the next session",
};

export interface Todo {
  text: string;
  done: boolean;
}

export type Gate = "idle" | "waiting" | "approved" | "open";

export interface Step {
  /** A short heading, e.g. "Reproduce the failure". */
  title: string;
  /** What happened, in a sentence or two. */
  text: string;
  /** The command or call, when there is one. */
  call?: string;
  tone: Tone;
  /** Parts that moved in this step. */
  active: PartId[];
  /** The window after this step. */
  blocks: Block[];
  used: number;
  /** Tokens sent to the model so far: each call re-sends the whole window. */
  billed: number;
  calls: number;
  scratch: string[];
  persistent: string[];
  todos: Todo[];
  /** Tokens in each subagent's own window; 0 when idle. */
  subagents: number[];
  gate: Gate;
  pressing: boolean;
  /** A skill card pulled out of the rack, by index. */
  skillOut: number | null;
  /** True when this step's output went down the chute. */
  chute: boolean;
  problems: Problem[];
}

export interface Run {
  steps: Step[];
  peak: number;
  billed: number;
  calls: number;
  problems: Problem[];
  finished: boolean;
}

/** A part works only if it is installed and everything it needs works. */
export function effective(installed: Iterable<PartId>): Set<PartId> {
  const on = new Set(installed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...on]) {
      if (partById(id).needs.some((n) => !on.has(n))) {
        on.delete(id);
        changed = true;
      }
    }
  }
  return on;
}

const SKILLS = ["debugging-tests", "git-workflow", "code-review", "release-notes", "database-migrations", "frontend-style", "api-design", "incident-runbook"];
const SKILL_INDEX_TOKENS = 120;
const SKILL_FULL_TOKENS = 5_400;
const TEST_LOG = 38_000;
const SUITE_LOG = 41_000;
const EXPLORE_TOKENS = 110_000;
const REPORT_TOKENS = 1_800;
/** A subagent's own system prompt, tools and brief. */
const SUBAGENT_BASE = 3_000;
const OFFLOAD_TAG = 900;
const SUMMARY_TOKENS = 7_000;

export const TASK = "The checkout test has failed since Tuesday. Fix it and open a pull request.";

export const PLAN = ["Reproduce the failure", "Find the cause", "Fix it", "Run the full test suite", "Open a pull request for review"];

const sum = (blocks: Block[]) => blocks.reduce((n, b) => n + b.tokens, 0);

/** Runs the task once, through a harness with only `installed` parts. */
export function run(installed: Iterable<PartId>): Run {
  const on = effective(installed);
  const has = (id: PartId) => on.has(id);

  const steps: Step[] = [];
  let blocks: Block[] = [];
  let billed = 0;
  let calls = 0;
  let peak = 0;
  let n = 0;
  const scratch: string[] = [];
  const persistent: string[] = has("memory") ? ["AGENTS.md", "memory/notes.md"] : has("filesystem") ? ["AGENTS.md"] : [];
  const todos: Todo[] = [];
  const problems: Problem[] = [];
  let finished = true;

  const add = (kind: BlockKind, label: string, tokens: number, pinned = false) => {
    blocks = [...blocks, { id: `b${n++}`, kind, label, tokens, pinned }];
  };
  const tick = (text: string) => {
    const t = todos.find((x) => x.text === text);
    if (t) t.done = true;
  };
  const flag = (p: Problem) => {
    if (!problems.includes(p)) problems.push(p);
  };

  interface Draft {
    title: string;
    text: string;
    call?: string;
    tone?: Tone;
    active?: PartId[];
    subagents?: number[];
    gate?: Gate;
    pressing?: boolean;
    skillOut?: number | null;
    chute?: boolean;
    /** False for steps that are not a model call (the harness acting alone). */
    call_model?: boolean;
    /** Calls made by a subagent in its own window, billed on top. */
    side?: number[];
  }

  const push = (d: Draft) => {
    const used = sum(blocks);
    if (d.call_model !== false) {
      calls += 1;
      billed += used;
    }
    for (const window of d.side ?? []) {
      calls += 1;
      billed += window;
    }
    peak = Math.max(peak, used);
    steps.push({
      title: d.title,
      text: d.text,
      call: d.call,
      tone: d.tone ?? "info",
      active: d.active ?? [],
      blocks: blocks.map((b) => ({ ...b })),
      used,
      billed,
      calls,
      scratch: [...scratch],
      persistent: [...persistent],
      todos: todos.map((t) => ({ ...t })),
      subagents: d.subagents ?? [0, 0],
      gate: d.gate ?? (has("hitl") ? "idle" : "open"),
      pressing: d.pressing ?? false,
      skillOut: d.skillOut ?? null,
      chute: d.chute ?? false,
      problems: [...problems],
    });
  };

  /**
   * The harness checks the window after every step. With the press it
   * compacts at the threshold; without it, a window over the limit ends the run.
   */
  const fits = (): boolean => {
    const used = sum(blocks);
    if (has("summarization") && used > COMPACT_AT) {
      const before = used;
      blocks = [...blocks.filter((b) => b.pinned), { id: `b${n++}`, kind: "summary", label: "Summary of the run so far", tokens: SUMMARY_TOKENS }];
      push({
        title: "Compact the window",
        text: `The window reached ${fmt(before)} of ${fmt(WINDOW)}. The press keeps the instructions and replaces everything else with a ${fmt(SUMMARY_TOKENS)} summary.`,
        tone: "good",
        active: ["summarization"],
        pressing: true,
      });
      return true;
    }
    if (used > WINDOW) {
      flag("overflow");
      finished = false;
      push({
        title: "Out of context",
        text: `The window needs ${fmt(used)}, more than the ${fmt(WINDOW)} limit. Nothing makes room, so the next call cannot be sent and the run stops here.`,
        tone: "bad",
        call_model: false,
      });
      return false;
    }
    return true;
  };

  /** A tool output: down the chute to a file, or into the window in full. */
  const output = (file: string, label: string, tokens: number): boolean => {
    if (has("offloading")) {
      scratch.push(file);
      add("tag", `${label} → ${file}`, OFFLOAD_TAG);
      return true;
    }
    add("output", label, tokens);
    return false;
  };

  // 1. Start: the harness assembles the first window.
  add("system", "System prompt and tool definitions", 4_000, true);
  if (has("memory")) add("memory", "AGENTS.md and saved notes", 1_500, true);
  if (has("skills")) add("skill", `Skill index: ${SKILLS.length} names and descriptions`, SKILLS.length * SKILL_INDEX_TOKENS, true);
  else add("skill", `All ${SKILLS.length} playbooks, in full`, SKILLS.length * SKILL_FULL_TOKENS, true);
  push({
    title: "Assemble the first window",
    text: [
      "The harness writes the system prompt and the tool definitions.",
      has("memory") ? "Memory loads AGENTS.md and the notes saved last time, including “tests run in UTC”." : "There is no memory, so the agent starts without the team’s conventions.",
      has("skills")
        ? `The skill rack adds only ${SKILLS.length} one-line descriptions, ${fmt(SKILLS.length * SKILL_INDEX_TOKENS)} in all.`
        : `Without a skill rack, all ${SKILLS.length} playbooks go in up front: ${fmt(SKILLS.length * SKILL_FULL_TOKENS)} on every call.`,
    ].join(" "),
    active: ["memory", "skills"].filter((p) => has(p as PartId)) as PartId[],
    call_model: false,
  });

  // 2. The task arrives.
  add("task", "The task", 200, true);
  if (has("planning")) {
    for (const text of PLAN) todos.push({ text, done: false });
    add("plan", "To-do list", 400, true);
  }
  push({
    title: "Read the task and plan",
    text: has("planning")
      ? `“${TASK}” The agent writes a five-item to-do list and pins it to the board.`
      : `“${TASK}” There is no planning tool, so the agent starts straight in.`,
    call: has("planning") ? "write_todos([…5 items])" : undefined,
    active: has("planning") ? ["planning"] : [],
  });
  if (!fits()) return finish();

  // 3. Explore the codebase.
  if (has("subagents")) {
    push({
      title: "Send an explorer",
      text: `A subagent starts with a clean window and reads the 14 files around checkout: ${fmt(EXPLORE_TOKENS)}, none of it in the main window. Its own two calls are billed too, once.`,
      call: "task(explorer, “map how checkout computes delivery dates”)",
      active: ["subagents"],
      subagents: [EXPLORE_TOKENS + SUBAGENT_BASE, 0],
      side: [SUBAGENT_BASE, SUBAGENT_BASE + EXPLORE_TOKENS],
    });
    add("report", "Explorer’s report", REPORT_TOKENS);
    push({
      title: "Read the report",
      text: `The explorer returns a ${fmt(REPORT_TOKENS)} report: the date is built in src/checkout/date.ts and formatted with the server’s local time zone.`,
      active: ["subagents"],
      subagents: [0, 0],
    });
  } else {
    add("file", "14 source files", EXPLORE_TOKENS);
    push({
      title: "Read the codebase",
      text: `With no one to delegate to, the main agent reads the 14 files itself. All ${fmt(EXPLORE_TOKENS)} stay in its window and are re-sent on every later call.`,
      call: "read_file × 14",
    });
  }
  if (!fits()) return finish();

  // 4. Load the matching skill.
  if (has("skills")) {
    add("skill", "debugging-tests playbook", SKILL_FULL_TOKENS);
    push({
      title: "Pull a skill card",
      text: `The task matches “debugging-tests”, so its full ${fmt(SKILL_FULL_TOKENS)} playbook is loaded now, and only now.`,
      call: "read_skill(debugging-tests)",
      active: ["skills"],
      skillOut: 0,
    });
    if (!fits()) return finish();
  }

  // 5. Install dependencies: the first command, and where it runs.
  if (has("repl")) {
    if (!has("sandbox")) flag("host");
    push({
      title: "Install dependencies",
      text: has("sandbox")
        ? "npm ci runs the install scripts of about 900 packages. It runs inside the sandbox: a disposable machine with the repository mounted, no personal credentials and an allowlisted network."
        : "npm ci runs the install scripts of about 900 packages, on your own machine, as you. Nothing here was malicious, but nothing would have stopped it if it were.",
      call: "npm ci",
      tone: has("sandbox") ? "good" : "bad",
      active: has("sandbox") ? ["repl", "sandbox"] : ["repl"],
    });
  }

  // 6. Reproduce the failure.
  if (has("repl")) {
    const off = output("scratch/test-run-1.log", "Checkout test log", TEST_LOG);
    tick("Reproduce the failure");
    push({
      title: "Reproduce the failure",
      text: off
        ? `The test log is ${fmt(TEST_LOG)} of stack traces. The chute saves it to scratch/test-run-1.log; the window keeps a ${fmt(OFFLOAD_TAG)} head, tail and path.`
        : `The test log is ${fmt(TEST_LOG)} of stack traces, and all of it goes into the window.`,
      call: "npm test -- checkout",
      active: off ? ["repl", "offloading", "filesystem"] : ["repl"],
      chute: off,
    });
  } else {
    flag("unverified");
    add("file", "Test file, read instead of run", 3_000);
    push({
      title: "Read the test instead",
      text: "There is no way to run code, so the agent reads the failing test and reasons about what it would print.",
      call: "read_file(checkout.test.ts)",
      tone: "bad",
    });
  }
  if (!fits()) return finish();

  // 7. Narrow it down.
  if (has("code")) {
    scratch.push("scratch/repro.ts");
    add("output", "repro.ts output", 500);
    tick("Find the cause");
    push({
      title: "Write a repro script",
      text: "The agent writes a 12-line script to scratch/repro.ts that builds one order at 23:30 UTC and prints the delivery date. It prints the wrong day: a time zone bug.",
      call: "write_file(scratch/repro.ts) && npx tsx scratch/repro.ts",
      active: ["code", "repl", "filesystem"],
    });
  } else if (has("repl")) {
    const off = output("scratch/test-run-2.log", "Verbose test log", TEST_LOG);
    tick("Find the cause");
    push({
      title: "Re-run with more output",
      text: off
        ? `With no scratch scripts, the agent re-runs the tests verbosely. Another ${fmt(TEST_LOG)} log goes down the chute.`
        : `With no scratch scripts, the agent re-runs the tests verbosely. Another ${fmt(TEST_LOG)} goes into the window.`,
      call: "npm test -- checkout --verbose",
      active: off ? ["repl", "offloading"] : ["repl"],
      chute: off,
    });
  } else {
    push({ title: "Find the cause", text: "The agent guesses from the code that the date is computed in local time.", tone: "info" });
  }
  if (!fits()) return finish();

  // 8. Fix it.
  const fix = () => {
    add("edit", "Edit to src/checkout/date.ts", 2_100);
    tick("Fix it");
  };
  fix();
  push({
    title: "Fix it",
    text: has("memory")
      ? "The agent changes date.ts to compute the date in UTC, following the note in memory that all tests run with TZ=UTC."
      : "The agent changes date.ts to use the customer’s local time zone. Nothing told it that this repository computes everything in UTC.",
    call: "edit_file(src/checkout/date.ts)",
    active: has("memory") ? ["memory"] : [],
  });
  if (!fits()) return finish();

  if (!has("memory") && has("repl")) {
    flag("rework");
    const off = output("scratch/test-run-3.log", "Failing test log", TEST_LOG);
    push({
      title: "The fix fails",
      text: off
        ? "The checkout test still fails, now in a different case. Another log goes down the chute."
        : `The checkout test still fails, now in a different case. Another ${fmt(TEST_LOG)} log enters the window.`,
      call: "npm test -- checkout",
      tone: "bad",
      active: off ? ["repl", "offloading"] : ["repl"],
      chute: off,
    });
    if (!fits()) return finish();
    fix();
    push({
      title: "Fix it again",
      text: "The agent reads the CI config, finds TZ=UTC, and rewrites the change to compute the date in UTC.",
      call: "edit_file(src/checkout/date.ts)",
    });
    if (!fits()) return finish();
  }

  // 9. Verify.
  if (!has("repl")) {
    push({
      title: "Declare it fixed",
      text: "The agent cannot run the tests, so it reports the change as a likely fix that no one has run.",
      tone: "bad",
    });
  } else if (has("planning")) {
    const off = output("scratch/suite.log", "Full suite log", SUITE_LOG);
    tick("Run the full test suite");
    push({
      title: "Run the full suite",
      text: off
        ? `Item four on the board. All 1,240 tests pass. The ${fmt(SUITE_LOG)} log goes down the chute.`
        : `Item four on the board. All 1,240 tests pass, and the ${fmt(SUITE_LOG)} log goes into the window.`,
      call: "npm test",
      tone: "good",
      active: off ? ["planning", "repl", "offloading"] : ["planning", "repl"],
      chute: off,
    });
  } else {
    flag("stopped-early");
    push({
      title: "Stop at the first green",
      text: "The checkout test passes and the agent calls it done. With no list to check, the full suite never runs.",
      tone: "bad",
    });
  }
  if (!fits()) return finish();

  // 10. Save what it learned.
  if (has("memory")) {
    persistent.push("memory/checkout.md");
    add("edit", "Note for next time", 200);
    push({
      title: "Save a note",
      text: "The agent adds a line to memory: delivery dates are computed in UTC in src/checkout/date.ts. The next session starts knowing it.",
      call: "write_file(memory/checkout.md)",
      tone: "good",
      active: ["memory", "filesystem"],
    });
  } else {
    flag("forgets");
  }
  if (!fits()) return finish();

  // 11. Ship it.
  if (has("hitl")) {
    push({
      title: "Ask before pushing",
      text: "The agent wants to push and open a pull request. The gate closes and the run waits for a person.",
      call: "git push && gh pr create",
      tone: "pause",
      active: ["hitl"],
      gate: "waiting",
      call_model: false,
    });
    tick("Open a pull request for review");
    push({
      title: "Approved, with an edit",
      text: "A person reads the diff, changes the target from main to a branch, and approves. The pull request opens for review.",
      call: "git push origin fix/checkout-utc && gh pr create",
      tone: "good",
      active: ["hitl"],
      gate: "approved",
    });
  } else {
    flag("unreviewed");
    tick("Open a pull request for review");
    push({
      title: "Push to main",
      text: "There is no gate. The agent pushes straight to main, and the change ships with no one having read it.",
      call: "git push origin main",
      tone: "bad",
    });
  }

  return finish();

  function finish(): Run {
    return { steps, peak, billed, calls, problems: [...problems], finished };
  }
}

/** 38000 → "38k tokens"; 900 → "900 tokens". */
export function fmt(tokens: number, unit = true): string {
  const s = tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k`.replace(".0k", "k") : `${tokens}`;
  return unit ? `${s} tokens` : s;
}
