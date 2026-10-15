// Runtime limits for one run: a budget (cost and model calls) and a deadline.
// A runaway run — a model that keeps calling tools, a judge that thinks for
// minutes, a retry loop overnight — stops at a limit instead of spending
// without bound. Limits come from the environment; the defaults are generous
// for a normal run (about $0.10–0.20 and 15–25 model calls).

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Usage } from "./types.ts";

const num = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

export interface Limits {
  /** Most a run may spend on model calls, in USD (only enforced when prices are configured). */
  maxCostUsd: number;
  /** Most model calls a run may make. */
  maxModelCalls: number;
  /** Most time a run may take from its start, across retries, in seconds. */
  maxSeconds: number;
  /** Longest one attempt may run before it stops and resumes from its checkpoint, in seconds (below the platform's function limit). */
  attemptSeconds: number;
}

export function limitsFromEnv(): Limits {
  return {
    maxCostUsd: num(process.env.RUN_MAX_COST_USD, 0.75),
    maxModelCalls: num(process.env.RUN_MAX_MODEL_CALLS, 45),
    maxSeconds: num(process.env.RUN_MAX_SECONDS, 600),
    attemptSeconds: num(process.env.RUN_ATTEMPT_SECONDS, 270),
  };
}

/** A limit was reached. The run stops and is not retried; the message is shown to the user. */
export class LimitReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitReached";
  }
}

export const isLimit = (e: unknown): e is LimitReached => e instanceof LimitReached || (e as Error | undefined)?.name === "LimitReached";

/** What a run has spent, checked before every model call. */
export class RunBudget {
  private cost: number;
  private calls: number;
  private priced: boolean;

  constructor(
    readonly limits: Limits,
    /** What earlier attempts of this run already spent (a resumed run keeps counting). */
    spent: { cost?: number | null; calls: number } = { calls: 0 },
  ) {
    this.cost = spent.cost ?? 0;
    this.calls = spent.calls;
    this.priced = spent.cost !== null;
  }

  /** Adds a finished call's cost. (Calls are counted when they start, in `begin`.) */
  add(u: Usage) {
    if (u.cost === undefined) this.priced = false;
    else this.cost += u.cost;
  }

  /**
   * Checks the limits and reserves one call. Calls are counted when they start,
   * so parallel researchers cannot all pass the check before any of them finishes.
   */
  begin() {
    this.check();
    this.calls += 1;
  }

  /** Throws when the next model call would go past a limit. */
  check() {
    if (this.calls >= this.limits.maxModelCalls) throw new LimitReached(`This research stopped because it reached its limit of ${this.limits.maxModelCalls} model calls.`);
    if (this.priced && this.cost >= this.limits.maxCostUsd) throw new LimitReached(`This research stopped because it reached its cost limit of $${this.limits.maxCostUsd.toFixed(2)}.`);
  }

  get spent() {
    return { cost: this.priced ? this.cost : undefined, calls: this.calls };
  }
}

/**
 * Checks the budget before every model call. Attached to each chat model as a
 * LangChain callback; `raiseError` makes the throw stop the call itself.
 */
export class BudgetCallback extends BaseCallbackHandler {
  name = "run-budget";
  raiseError = true;
  awaitHandlers = true;

  constructor(private budget: RunBudget) {
    super();
  }

  handleChatModelStart() {
    this.budget.begin();
  }
}
