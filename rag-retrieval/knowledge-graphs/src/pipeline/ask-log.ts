// Rate-limit counts for "Ask your own question", kept in Neo4j as (:AskLog {ipHash, at})
// nodes so they hold across serverless instances. Only this server code writes them, in
// its own write transaction; model-written Cypher can't reach them (the guard refuses any
// query that mentions AskLog, and rows holding an AskLog's fields are dropped). Loading
// the graph replaces :Entity nodes only, so the log survives a reload.

import neo4j from "neo4j-driver";
import { DAY, HOUR, overLimit, type AskLimitStore } from "../ask-endpoint.ts";
import { db } from "./neo4j.ts";

let indexed = false;

export function neo4jLimitStore(): AskLimitStore {
  return {
    async take(ipHash, now, limits) {
      const session = db().session({ defaultAccessMode: neo4j.session.WRITE });
      try {
        if (!indexed) {
          await session.run("CREATE INDEX ask_log_at IF NOT EXISTS FOR (a:AskLog) ON (a.at)");
          indexed = true;
        }
        return await session.executeWrite(
          async (tx) => {
            // Forget entries older than a day, then count, then record if allowed: one transaction.
            await tx.run("MATCH (a:AskLog) WHERE a.at < $old DELETE a", { old: now - DAY });
            const res = await tx.run(
              "OPTIONAL MATCH (a:AskLog) WHERE a.at >= $day RETURN count(a) AS day, count(CASE WHEN a.ipHash = $ip AND a.at >= $hour THEN 1 END) AS ipHour",
              { day: now - DAY, hour: now - HOUR, ip: ipHash },
            );
            const r = res.records[0];
            const msg = overLimit({ day: Number(r.get("day")), ipHour: Number(r.get("ipHour")) }, limits);
            if (!msg) await tx.run("CREATE (:AskLog {ipHash: $ip, at: $now})", { ip: ipHash, now });
            return msg;
          },
          { timeout: 5000 },
        );
      } finally {
        await session.close();
      }
    },
  };
}
