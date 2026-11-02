"""The call log: one row per call and an ordered event stream per call.

A production platform writes these events to Kafka and ClickHouse; this example keeps
the same shape in SQLite so it runs anywhere. The dashboard reads only this file.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .workflow import ROOT

DEFAULT_DB = ROOT / "runs" / "calls.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  started_at REAL NOT NULL,
  ended_at REAL,
  source TEXT NOT NULL,          -- browser | sip | simulation
  pipeline TEXT NOT NULL,        -- realtime | cascade | scripted
  models TEXT NOT NULL,          -- JSON {stt, llm, tts}
  caller_phone TEXT,
  patient_id TEXT,
  scenario TEXT,
  end_status TEXT,               -- resolved | transferred | caller_hung_up | error | timed_out
  transfer_to TEXT,
  cost_usd REAL,
  usage TEXT,                    -- JSON usage counters behind cost_usd
  summary TEXT                   -- JSON post-call record (also sent to the webhook)
);
CREATE TABLE IF NOT EXISTS events (
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at REAL NOT NULL,              -- seconds since the call started
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (call_id, seq)
);
CREATE TABLE IF NOT EXISTS webhook_outbox (
  call_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,          -- pending | delivered | failed
  last_error TEXT,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_received (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at REAL NOT NULL,
  idempotency_key TEXT,
  signature_ok INTEGER NOT NULL,
  duplicate INTEGER NOT NULL,
  body TEXT NOT NULL
);
"""


class CallStore:
    def __init__(self, path: Path = DEFAULT_DB) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._seq: dict[str, int] = {}

    def _write(self, sql: str, args: tuple[Any, ...]) -> None:
        with self._lock:
            self._db.execute(sql, args)
            self._db.commit()

    def start_call(self, call_id: str, *, source: str, pipeline: str, models: dict[str, str],
                   caller_phone: str | None, scenario: str | None = None,
                   started_at: float | None = None) -> None:
        self._write(
            "INSERT OR REPLACE INTO calls (id, started_at, source, pipeline, models, caller_phone,"
            " scenario) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (call_id, started_at or time.time(), source, pipeline, json.dumps(models),
             caller_phone, scenario),
        )
        self._seq[call_id] = 0

    def add_event(self, call_id: str, at: float, kind: str, data: dict[str, Any]) -> None:
        seq = self._seq.get(call_id, 0)
        self._seq[call_id] = seq + 1
        self._write("INSERT INTO events VALUES (?, ?, ?, ?, ?)",
                    (call_id, seq, round(at, 3), kind, json.dumps(data, default=str)))

    def update_call(self, call_id: str, **fields: Any) -> None:
        cols = ", ".join(f"{k} = ?" for k in fields)
        values = tuple(json.dumps(v) if isinstance(v, (dict, list)) else v
                       for v in fields.values())
        self._write(f"UPDATE calls SET {cols} WHERE id = ?", (*values, call_id))

    # -- reads ---------------------------------------------------------------------

    def _call_row(self, row: sqlite3.Row) -> dict[str, Any]:
        call = dict(row)
        for key in ("models", "usage", "summary"):
            call[key] = json.loads(call[key]) if call.get(key) else None
        return call

    def list_calls(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM calls ORDER BY started_at DESC LIMIT ?", (limit,)).fetchall()
        return [self._call_row(r) for r in rows]

    def get_call(self, call_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            events = self._db.execute(
                "SELECT seq, at, kind, data FROM events WHERE call_id = ? ORDER BY seq",
                (call_id,)).fetchall()
        if row is None:
            return None
        call = self._call_row(row)
        call["events"] = [{**dict(e), "data": json.loads(e["data"])} for e in events]
        return call

    def events_of_kind(self, kind: str, limit: int = 5000) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT e.call_id, e.data, c.pipeline, c.source FROM events e JOIN calls c"
                " ON c.id = e.call_id WHERE e.kind = ? ORDER BY c.started_at DESC LIMIT ?",
                (kind, limit)).fetchall()
        return [{"call_id": r["call_id"], "pipeline": r["pipeline"], "source": r["source"],
                 **json.loads(r["data"])} for r in rows]

    def delete_source(self, source: str, pipeline: str | None = None) -> None:
        with self._lock:
            ids = [r[0] for r in self._db.execute(
                "SELECT id FROM calls WHERE source = ? AND (? IS NULL OR pipeline = ?)",
                (source, pipeline, pipeline))]
            self._db.executemany("DELETE FROM events WHERE call_id = ?", [(i,) for i in ids])
            self._db.executemany("DELETE FROM webhook_outbox WHERE call_id = ?",
                                 [(i,) for i in ids])
            self._db.executemany("DELETE FROM calls WHERE id = ?", [(i,) for i in ids])
            self._db.commit()

    # -- webhook outbox ----------------------------------------------------------------

    def outbox_put(self, call_id: str, payload: dict[str, Any]) -> None:
        self._write(
            "INSERT OR IGNORE INTO webhook_outbox (call_id, payload, status, updated_at)"
            " VALUES (?, ?, 'pending', ?)", (call_id, json.dumps(payload), time.time()))

    def outbox_mark(self, call_id: str, *, status: str, attempts: int,
                    error: str | None = None) -> None:
        self._write(
            "UPDATE webhook_outbox SET status = ?, attempts = ?, last_error = ?, updated_at = ?"
            " WHERE call_id = ?", (status, attempts, error, time.time(), call_id))

    def outbox_pending(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM webhook_outbox WHERE status != 'delivered'").fetchall()
        return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]

    def outbox(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT call_id, attempts, status, last_error, updated_at FROM webhook_outbox"
                " ORDER BY updated_at DESC LIMIT 100").fetchall()
        return [dict(r) for r in rows]

    def record_received(self, key: str | None, signature_ok: bool, body: str) -> bool:
        """Store an incoming webhook; returns True if this idempotency key was seen before."""
        with self._lock:
            duplicate = key is not None and self._db.execute(
                "SELECT 1 FROM webhook_received WHERE idempotency_key = ? AND signature_ok = 1",
                (key,)).fetchone() is not None
            self._db.execute(
                "INSERT INTO webhook_received (received_at, idempotency_key, signature_ok,"
                " duplicate, body) VALUES (?, ?, ?, ?, ?)",
                (time.time(), key, int(signature_ok), int(duplicate), body))
            self._db.commit()
        return duplicate

    def received(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM webhook_received ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]
