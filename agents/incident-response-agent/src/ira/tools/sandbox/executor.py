import asyncio
import os
import resource
import shutil
import sys
from pathlib import Path

from src.ira.config import settings
from src.ira.guardrails.pii import PIIScrubber, get_scrubber

_SAFE_PATH = "/usr/bin:/bin"


class SandboxedExecutor:
    """Runs a single allow-listed, read-only command without a shell.

    This is process-level restriction (allowlist, no shell, confined paths, minimal env,
    CPU/memory rlimits, timeout), NOT isolation. Anything beyond read-only diagnostics
    must run in a real sandbox (e.g. gVisor or Firecracker).
    """

    def __init__(
        self,
        timeout_s: int | None = None,
        max_memory_mb: int | None = None,
        allowed_commands: list[str] | None = None,
        read_roots: list[Path] | None = None,
        scrubber: PIIScrubber | None = None,
    ):
        self.timeout_s = timeout_s or settings.sandbox_timeout_s
        self.max_memory_bytes = (max_memory_mb or settings.sandbox_max_memory_mb) * 1024 * 1024
        self.allowed_commands = set(allowed_commands or settings.sandbox_allowed_commands)
        self.read_roots = [p.resolve() for p in (read_roots or [settings.data_dir])]
        self.scrubber = scrubber or get_scrubber()

    def _limit_resources(self) -> None:
        """Set CPU and memory limits. Unix only."""
        resource.setrlimit(resource.RLIMIT_CPU, (self.timeout_s, self.timeout_s))
        # RLIMIT_DATA breaks basic binaries on macOS, so it is Linux-only.
        if sys.platform != "darwin":
            resource.setrlimit(
                resource.RLIMIT_DATA, (self.max_memory_bytes, self.max_memory_bytes)
            )

    def scrub_pii(self, text: str) -> str:
        return self.scrubber.scrub(text)

    def validate(self, cmd: list[str]) -> str:
        """Return the resolved binary path, or raise PermissionError."""
        if not cmd or not all(isinstance(a, str) for a in cmd):
            raise PermissionError("Command must be a non-empty list of strings.")
        program = cmd[0]
        # Bare names only: "/bin/rm" or "./x" would sidestep the allowlist.
        if os.sep in program or program not in self.allowed_commands:
            raise PermissionError(f"Command '{program}' is not in the sandbox allowlist.")
        binary = shutil.which(program, path=_SAFE_PATH)
        if binary is None:
            raise PermissionError(f"Command '{program}' is not available.")
        for arg in cmd[1:]:
            if "\x00" in arg:
                raise PermissionError("NUL bytes are not allowed in arguments.")
            path_part = arg
            if arg.startswith("-"):
                # Options can smuggle paths too: --file=/x, -f/x
                if "=" in arg:
                    path_part = arg.split("=", 1)[1]
                elif os.sep in arg:
                    path_part = arg[arg.index(os.sep):]
                else:
                    continue
            if os.sep in path_part or path_part.startswith("~") or path_part == "..":
                candidate = Path(os.path.expanduser(path_part))
                if not candidate.is_absolute():
                    # The subprocess runs with cwd = first read root.
                    candidate = self.read_roots[0] / candidate
                resolved = candidate.resolve()
                if not any(resolved.is_relative_to(root) for root in self.read_roots):
                    raise PermissionError(f"Path '{arg}' is outside the sandbox read roots.")
        return binary

    async def execute_command(self, cmd: list[str]) -> tuple[int, str, str]:
        """Execute a validated read-only command; stdout/stderr are PII-scrubbed."""
        binary = self.validate(cmd)
        try:
            process = await asyncio.create_subprocess_exec(
                binary,
                *cmd[1:],
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.read_roots[0]),
                env={"PATH": _SAFE_PATH, "LANG": "C.UTF-8"},
                preexec_fn=self._limit_resources,
            )
        except OSError as e:
            return -2, "", f"Failed to spawn subprocess: {e}"

        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=self.timeout_s)
        except TimeoutError:
            process.kill()
            await process.communicate()
            return -1, "", "Execution timed out."

        exit_code = process.returncode if process.returncode is not None else -1
        return (
            exit_code,
            self.scrub_pii(stdout.decode("utf-8", errors="replace")),
            self.scrub_pii(stderr.decode("utf-8", errors="replace")),
        )
