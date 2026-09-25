import pytest

from src.ira.guardrails.pii import PIIScrubber


@pytest.fixture(scope="module")
def scrubber() -> PIIScrubber:
    return PIIScrubber()


@pytest.mark.parametrize("text", [
    "Multiple RAS KERNEL alerts on node R02-M1-N0-C; jobs failing",
    "R63-M0-NC-I:J18-U01 instruction cache parity error corrected",
    "attempt_1445144423722_0020_m_000000_0 task failed",
    "Invalid user webmaster from 173.234.31.186",
    "reverse mapping checking getaddrinfo for host [112.95.230.3] failed",
    "PAM service(sshd) ignoring max retries; 6 > 3",
    "Received block blk_-1608999687919862906 of size 91178 from /10.250.10.6",
    "JVM with ID: jvm_1445144423722_0020_m_000005 given task",
    "Linkerror event interval expired on NIFF boot",
    "Failed password for invalid user chen from 5.36.59.76 port 42393 ssh2",
    "Token for container_1445144423722_0020 renewed; 4096 KB free",
    "Server environment:os.name=Linux",
    "IOPMPowerSource Information: onSleep, SleepType: Normal Sleep, 'ExternalConnected': Yes",
])
def test_infrastructure_ids_survive(scrubber: PIIScrubber, text: str) -> None:
    assert scrubber.scrub(text) == text


@pytest.mark.parametrize(("text", "name"), [
    ("Escalated to on-call Priya Raman at 02:00", "Priya Raman"),
    ("Please contact Ingrid about the rollback", "Ingrid"),
    ("Reported by Dr Chen after the outage", "Chen"),
    ("Linux agpgart interface v0.100 (c) Dave Jones", "Dave Jones"),
])
def test_human_names_are_removed(scrubber: PIIScrubber, text: str, name: str) -> None:
    assert name not in scrubber.scrub(text)


def test_real_pii_is_removed(scrubber: PIIScrubber) -> None:
    out = scrubber.scrub("On-call jane.doe@example.com, 555-123-4567, card 4111 1111 1111 1111,"
                         " user John Smith")
    for leaked in ("jane.doe@example.com", "555-123-4567", "4111 1111 1111 1111", "John Smith"):
        assert leaked not in out
