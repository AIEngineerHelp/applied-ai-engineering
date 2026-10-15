// A LangGraph checkpointer on the app's own database (Drizzle: Neon in
// production, PGlite locally and in tests), so checkpoints live next to the
// reports they belong to and need no second connection.
//
// LangGraph saves a checkpoint after every step, plus the writes of each task
// within a step. A run that dies is resumed with `graph.invoke(null, config)`:
// it continues from the last checkpoint, and parallel branches that already
// finished are not run again.
//
// The logic mirrors LangGraph's MemorySaver; only the storage differs.

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  writesSortKey,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

const { graphCheckpoints: cp, graphWrites: wr } = schema;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export class DrizzleSaver extends BaseCheckpointSaver {
  private async dump(value: unknown): Promise<[string, string]> {
    const [type, data] = await this.serde.dumpsTyped(value);
    return [type, b64(data)];
  }

  private load(type: string, data: string): Promise<unknown> {
    return this.serde.loadsTyped(type, bytes(data));
  }

  /** A stored checkpoint row, with its pending writes, as LangGraph expects it. */
  private async tuple(row: typeof cp.$inferSelect): Promise<CheckpointTuple> {
    const d = await db();
    const writes = await d
      .select()
      .from(wr)
      .where(and(eq(wr.threadId, row.threadId), eq(wr.namespace, row.namespace), eq(wr.checkpointId, row.checkpointId)))
      .orderBy(asc(wr.taskId), asc(wr.idx));
    // Pending writes are returned in LangGraph's own order (by task path, task, index).
    const ordered = writes
      .map((w) => ({ key: writesSortKey(w.taskPath, w.taskId, w.idx), w }))
      .sort((a, b) => compareWritesSortKeys(a.key, b.key))
      .map((x) => x.w);
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(ordered.map(async (w) => [w.taskId, w.channel, await this.load(w.type, w.value)] as CheckpointPendingWrite));
    const configurable = { thread_id: row.threadId, checkpoint_ns: row.namespace, checkpoint_id: row.checkpointId };
    return {
      config: { configurable },
      checkpoint: (await this.load(row.type, row.checkpoint)) as Checkpoint,
      metadata: (await this.load(row.metadataType, row.metadata)) as CheckpointMetadata,
      pendingWrites,
      ...(row.parentId ? { parentConfig: { configurable: { ...configurable, checkpoint_id: row.parentId } } } : {}),
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) return undefined;
    const namespace = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const id = getCheckpointId(config);
    const d = await db();
    const where = and(eq(cp.threadId, threadId), eq(cp.namespace, namespace), ...(id ? [eq(cp.checkpointId, id)] : []));
    // Checkpoint ids are time-ordered (uuid6), so the newest sorts last.
    const [row] = await d.select().from(cp).where(where).orderBy(desc(cp.checkpointId)).limit(1);
    return row ? this.tuple(row) : undefined;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options ?? {};
    const threadId = config.configurable?.thread_id as string | undefined;
    const namespace = config.configurable?.checkpoint_ns as string | undefined;
    const id = config.configurable?.checkpoint_id as string | undefined;
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;
    const d = await db();
    const rows = await d
      .select()
      .from(cp)
      .where(
        and(
          ...(threadId ? [eq(cp.threadId, threadId)] : []),
          ...(namespace !== undefined ? [eq(cp.namespace, namespace)] : []),
          ...(id ? [eq(cp.checkpointId, id)] : []),
          ...(beforeId ? [lt(cp.checkpointId, beforeId)] : []),
        ),
      )
      .orderBy(desc(cp.checkpointId));
    let left = limit;
    for (const row of rows) {
      const t = await this.tuple(row);
      if (filter && !Object.entries(filter).every(([k, v]) => (t.metadata as Record<string, unknown> | undefined)?.[k] === v)) continue;
      if (left !== undefined && left-- <= 0) break;
      yield t;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) throw new Error("A checkpoint needs configurable.thread_id (the report id).");
    const namespace = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const [[type, data], [metadataType, meta]] = await Promise.all([this.dump(copyCheckpoint(checkpoint)), this.dump(metadata)]);
    const row = { threadId, namespace, checkpointId: checkpoint.id, parentId: (config.configurable?.checkpoint_id as string | undefined) ?? null, type, checkpoint: data, metadataType, metadata: meta };
    const d = await db();
    await d
      .insert(cp)
      .values(row)
      .onConflictDoUpdate({ target: [cp.threadId, cp.namespace, cp.checkpointId], set: { type, checkpoint: data, metadataType, metadata: meta, parentId: row.parentId } });
    return { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!threadId || !checkpointId) throw new Error("Pending writes need configurable.thread_id and checkpoint_id.");
    const namespace = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const rows = await Promise.all(
      writes.map(async ([channel, value], i) => {
        const [type, data] = await this.dump(value);
        // Special channels (errors, interrupts) have fixed negative indexes and are overwritten;
        // ordinary writes keep the first value saved, as in MemorySaver.
        return { threadId, namespace, checkpointId, taskId, idx: WRITES_IDX_MAP[channel] ?? i, channel, type, value: data, taskPath: taskPath ?? "" };
      }),
    );
    if (!rows.length) return;
    const d = await db();
    const normal = rows.filter((r) => r.idx >= 0);
    const special = rows.filter((r) => r.idx < 0);
    const target = [wr.threadId, wr.namespace, wr.checkpointId, wr.taskId, wr.idx];
    if (normal.length) await d.insert(wr).values(normal).onConflictDoNothing({ target });
    for (const r of special) await d.insert(wr).values(r).onConflictDoUpdate({ target, set: { channel: r.channel, type: r.type, value: r.value, taskPath: r.taskPath } });
  }

  async deleteThread(threadId: string): Promise<void> {
    const d = await db();
    await d.delete(wr).where(eq(wr.threadId, threadId));
    await d.delete(cp).where(eq(cp.threadId, threadId));
  }
}
