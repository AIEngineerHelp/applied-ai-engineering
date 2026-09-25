"""Prometheus metrics. Names are part of the deploy contract:
dashboards and alert rules in deploy/ depend on them."""
from prometheus_client import Counter, Gauge, Histogram

INCIDENTS = Counter("ira_incidents_total", "Incidents by terminal/entry status", ["status"])
CACHE_HITS = Counter("ira_cache_hits_total", "Intake cache hits", ["tier"])
TIME_TO_REPORT = Histogram(
    "ira_time_to_report_seconds", "Incident received -> RCA report",
    buckets=(15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200),
)
TOOL_CALLS = Counter("ira_tool_calls_total", "Tool invocations", ["tool", "result"])
LLM_COST = Counter("ira_llm_cost_usd_total", "LLM spend in USD", ["agent", "model"])
LLM_FALLBACKS = Counter("ira_llm_fallbacks_total", "Provider failovers", ["from_model", "to_model"])
LLM_ERRORS = Counter("ira_llm_errors_total", "Failed LLM calls", ["agent"])
HITL_WAIT = Histogram(
    "ira_hitl_wait_seconds", "Time an action waited for a human decision",
    buckets=(30, 60, 300, 900, 1800, 3600, 7200, 14400),
)
GUARDRAIL_DENIES = Counter("ira_guardrail_denies_total", "Actions blocked", ["rule"])
NODE_DURATION = Histogram("ira_node_duration_seconds", "Graph node latency", ["node", "result"])
DLQ_MESSAGES = Counter("ira_dlq_messages_total", "Messages dead-lettered")
QUEUE_RETRIES = Counter("ira_queue_retries_total", "Messages requeued after failure")
RUNS_IN_PROGRESS = Gauge("ira_runs_in_progress", "Graph runs executing in this process")
AUTH_FAILURES = Counter("ira_auth_failures_total", "Rejected requests", ["reason"])
