import pytest

from src.ira.config import settings
from src.ira.guardrails.pii import PIIScrubber
from src.ira.tools.sandbox.executor import SandboxedExecutor


@pytest.fixture
def executor() -> SandboxedExecutor:
    return SandboxedExecutor()


async def test_sandbox_execution_success(executor: SandboxedExecutor) -> None:
    exit_code, stdout, stderr = await executor.execute_command(["echo", "Hello World"])
    assert exit_code == 0
    assert stdout.strip() == "Hello World"
    assert stderr.strip() == ""


@pytest.mark.parametrize("cmd", [
    ["rm", "-rf", "/"],
    ["sh", "-c", "rm -rf /tmp/x && echo bypassed"],
    ["bash", "-c", "echo hi"],
    ["/bin/rm", "-rf", "/tmp/x"],
    ["./rm"],
    ["python3", "-c", "print(1)"],
    ["kubectl", "delete", "pod", "x"],
    [],
])
async def test_sandbox_rejects_non_allowlisted(executor: SandboxedExecutor, cmd: list[str]) -> None:
    with pytest.raises(PermissionError):
        await executor.execute_command(cmd)


@pytest.mark.parametrize("cmd", [
    ["cat", "/etc/passwd"],
    ["cat", "../../../../etc/passwd"],
    ["head", "~/.ssh/id_rsa"],
    ["grep", "-f/etc/passwd", "x"],
    ["grep", "--file=/etc/passwd", "x"],
    ["ls", ".."],
])
async def test_sandbox_confines_paths(executor: SandboxedExecutor, cmd: list[str]) -> None:
    with pytest.raises(PermissionError):
        await executor.execute_command(cmd)


async def test_sandbox_allows_paths_inside_data_dir(executor: SandboxedExecutor) -> None:
    path = settings.data_dir / "loghub" / "2k" / "BGL" / "BGL_2k.log_structured.csv"
    code, stdout, _ = await executor.execute_command(["head", "-n", "1", str(path)])
    assert code == 0
    assert stdout.startswith("LineId")


async def test_sandbox_pii_scrubbing() -> None:
    executor = SandboxedExecutor(scrubber=PIIScrubber())
    exit_code, stdout, _ = await executor.execute_command(
        ["echo", "My email is test@example.com and phone is 555-123-4567."]
    )
    assert exit_code == 0
    assert "test@example.com" not in stdout
    assert "555-123-4567" not in stdout
