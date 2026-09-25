import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from src.ira.models.incident import Incident
from src.ira.observability.metrics import TOOL_CALLS
from src.ira.observability.tracing import tracer
from src.ira.registry.tools import ToolRegistry
from src.ira.tools.log_explorer.service import LogExplorerService
from src.ira.tools.sandbox.executor import SandboxedExecutor

ToolFn = Callable[[dict[str, Any], Incident], Awaitable[str]]


class ToolNotImplementedError(RuntimeError):
    pass


class ToolExecutor:
    """Dispatches registry tools to implementations. Tools listed in the registry but
    without an implementation fail loudly instead of returning fake output."""

    def __init__(
        self,
        registry: ToolRegistry,
        log_explorer: LogExplorerService | None = None,
        sandbox: SandboxedExecutor | None = None,
    ):
        self.registry = registry
        self.log_explorer = log_explorer or LogExplorerService()
        self._sandbox = sandbox
        self.impls: dict[str, ToolFn] = {
            "log_explorer": self._log_explorer,
            "sandbox.run": self._sandbox_run,
        }

    @property
    def sandbox(self) -> SandboxedExecutor:
        if self._sandbox is None:
            self._sandbox = SandboxedExecutor()
        return self._sandbox

    def register(self, name: str, fn: ToolFn) -> None:
        self.impls[name] = fn

    def is_implemented(self, name: str) -> bool:
        return name in self.impls

    async def run(self, name: str, args: dict[str, Any], incident: Incident) -> str:
        manifest = self.registry.get_tool(name)
        if manifest is None:
            raise PermissionError(f"Tool {name!r} is not in the registry")
        if incident.environment not in manifest.allowed_envs:
            raise PermissionError(f"Tool {name!r} is not allowed in {incident.environment}")
        missing = manifest.missing_args(args)
        if missing:
            raise ValueError(f"Tool {name!r} missing required args: {missing}")
        impl = self.impls.get(name)
        if impl is None:
            TOOL_CALLS.labels(tool=name, result="not_implemented").inc()
            raise ToolNotImplementedError(f"No executor is registered for tool {name!r}")
        with tracer.start_as_current_span(
            f"tool.{name}",
            attributes={"tool": name, "risk": manifest.risk, "incident_id": str(incident.id)},
        ):
            try:
                result = await asyncio.wait_for(impl(args, incident), timeout=manifest.timeout_s)
            except Exception:
                TOOL_CALLS.labels(tool=name, result="error").inc()
                raise
        TOOL_CALLS.labels(tool=name, result="ok").inc()
        return result

    async def _log_explorer(self, args: dict[str, Any], incident: Incident) -> str:
        dataset = args.get("dataset") or incident.labels.get("dataset")
        if not dataset:
            raise ValueError(
                "No dataset: pass args.dataset or set the incident's 'dataset' label"
            )
        operation = args.get("operation", "distribution")
        if operation == "drill_down":
            event_id = args.get("event_id")
            if not event_id:
                raise ValueError("drill_down requires args.event_id")
            result: Any = await asyncio.to_thread(
                self.log_explorer.drill_down_event, dataset, str(event_id)
            )
        elif operation == "distribution":
            filters = args.get("filters") or {}
            if not isinstance(filters, dict):
                raise TypeError("args.filters must be an object")
            result = await asyncio.to_thread(
                self.log_explorer.get_event_distribution,
                dataset,
                filters,
                int(args.get("limit", 15)),
            )
        else:
            raise ValueError(f"Unknown log_explorer operation {operation!r}")
        return json.dumps(result, indent=2, default=str)

    async def _sandbox_run(self, args: dict[str, Any], incident: Incident) -> str:
        argv = args.get("argv")
        if not isinstance(argv, list):
            raise TypeError("args.argv must be a list of strings")
        code, out, err = await self.sandbox.execute_command([str(a) for a in argv])
        return json.dumps({"exit_code": code, "stdout": out, "stderr": err})
