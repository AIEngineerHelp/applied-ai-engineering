// What the agent needs from storage, and nothing more. The agent never imports
// the app's database: the app passes in a RunStore (lib/storage/run-store.ts
// is the Postgres one), so the agent can be tested, reused or moved to its own
// service without the web app.

import type { VfsFile } from "./vfs.ts";
import type { EvalResult, Plan, Report, RunEvent, Source } from "./types.ts";

export interface RunInfo {
  id: string;
  query: string;
  /** When the run started; span times are relative to it. */
  startedAt: Date;
  /** What the run has spent so far (cost is null when a call was unpriced), so a resumed run keeps counting. */
  spent: { cost: number | null; calls: number };
}

/** One earlier, completed turn of the run's conversation. */
export interface PriorTurn {
  query: string;
  report?: Report;
  /** Only loaded when asked for (answer mode needs them, planning does not). */
  sources: Source[];
}

/** Totals one node adds to the run. */
export interface UsageTotals {
  input: number;
  output: number;
  thinking: number;
  cost?: number;
  calls: number;
  toolCalls: number;
  /** False as soon as one call had no price, so the cost is unknown. */
  priced: boolean;
}

/** Writes events in order without blocking the agent; `flush` waits for them and throws if one failed. */
export interface EventWriter {
  emit(e: RunEvent): void;
  flush(): Promise<void>;
}

export interface RunStore {
  /** Marks the run as running (once) and returns it. */
  start(runId: string): Promise<RunInfo>;
  get(runId: string): Promise<RunInfo>;
  events(runId: string): EventWriter;
  addUsage(runId: string, usage: UsageTotals): Promise<void>;
  /** Saves the plan, the report or the evals as each is produced. */
  save(runId: string, fields: { plan?: Plan; report?: Report; evals?: EvalResult[] }): Promise<void>;
  /** The run's virtual file system, as written so far. */
  files(runId: string): Promise<VfsFile[]>;
  /** Every source the run's agents retrieved. */
  sources(runId: string): Promise<Source[]>;
  /** Earlier completed turns of the run's conversation, oldest first. */
  earlierTurns(runId: string, opts?: { withSources?: boolean }): Promise<PriorTurn[]>;
}
