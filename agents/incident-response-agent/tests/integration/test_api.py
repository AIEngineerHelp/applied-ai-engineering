import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from src.ira.api.auth import OIDCVerifier
from src.ira.api.main import create_app
from src.ira.api.services import Services, build_services
from src.ira.guardrails.intake import IntakeGuardrail
from src.ira.orchestrator.dispatch import LocalDispatcher
from tests.fakes import FakeLLM, FakeScrubber, base_responses, make_deps, make_settings

ISSUER = "https://idp.test"
AUDIENCE = "ira-api"
INTAKE_TOKEN = "t" * 40
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class StaticJWKS:
    def get_signing_key_from_jwt(self, token: str) -> Any:
        return jwt.PyJWK.from_dict(json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key())))


def token(sub: str, groups: list[str], **claims: Any) -> str:
    now = int(time.time())
    payload = {"sub": sub, "email": f"{sub}@corp", "groups": groups, "iss": ISSUER,
               "aud": AUDIENCE, "iat": now, "exp": now + 300, **claims}
    return jwt.encode(payload, KEY, algorithm="RS256")


def auth(sub: str, *groups: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token(sub, list(groups))}"}


async def make_client(**config: Any) -> AsyncIterator[tuple[httpx.AsyncClient, Services]]:
    settings = make_settings(intake_tokens=[INTAKE_TOKEN], **config)
    llm = FakeLLM(base_responses())
    holder: dict[str, Services] = {}

    async def factory() -> Services:
        holder["s"] = await build_services(
            settings, deps=make_deps(llm),
            intake_guardrail=IntakeGuardrail(FakeScrubber()),  # type: ignore[arg-type]
        )
        return holder["s"]

    app = create_app(factory, config=settings)
    verifier = app.state.authenticator.verifier
    if isinstance(verifier, OIDCVerifier):
        verifier._jwks = StaticJWKS()  # type: ignore[assignment]
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c, holder["s"]


@pytest.fixture
async def dev() -> AsyncIterator[tuple[httpx.AsyncClient, Services]]:
    async for pair in make_client():
        yield pair


@pytest.fixture
async def oidc() -> AsyncIterator[tuple[httpx.AsyncClient, Services]]:
    async for pair in make_client(
        auth_mode="oidc", oidc_issuer=ISSUER, oidc_audience=AUDIENCE, oidc_client_id="ui",
        oidc_role_mapping={"sre": "responder", "sre-leads": "approver", "ira-admins": "admin"},
    ):
        yield pair


async def idle(services: Services) -> None:
    assert isinstance(services.dispatcher, LocalDispatcher)
    await services.dispatcher.idle()


INCIDENT = {"source": "manual", "title": "BGL node errors", "description": "mail ops@corp.com",
            "severity": "sev2", "labels": {"dataset": "BGL"}}


async def test_incident_lifecycle(dev: tuple[httpx.AsyncClient, Services]) -> None:
    client, services = dev
    resp = await client.post("/v1/incidents", json=INCIDENT)
    assert resp.status_code == 201
    incident = resp.json()
    assert "ops@corp.com" not in incident["description"]
    await idle(services)

    detail = (await client.get(f"/v1/incidents/{incident['id']}")).json()
    assert detail["run"]["status"] == "awaiting_approval"
    [pending] = (await client.get("/v1/approvals/pending")).json()
    ok = await client.post(f"/v1/approvals/{pending['action_id']}/decision",
                           json={"decision": "approved"})
    assert ok.status_code == 200 and ok.json()["status"] == "accepted"
    again = await client.post(f"/v1/approvals/{pending['action_id']}/decision",
                              json={"decision": "approved"})
    assert again.status_code == 409
    await idle(services)

    detail = (await client.get(f"/v1/incidents/{incident['id']}")).json()
    assert detail["run"]["status"] == "completed"
    assert detail["actions"][0]["status"] == "executed"
    assert detail["actions"][0]["approval"]["by"] == "dev"


async def test_client_supplied_identity_rejected(dev: tuple[httpx.AsyncClient, Services]) -> None:
    client, _ = dev
    resp = await client.post("/v1/approvals/x/decision",
                             json={"decision": "approved", "by": "someone-else"})
    assert resp.status_code == 422


async def test_idempotency_and_dedup(dev: tuple[httpx.AsyncClient, Services]) -> None:
    client, services = dev
    body = {**INCIDENT, "source": "pagerduty", "external_id": "PD-1"}
    first = await client.post("/v1/incidents", json=body)
    repeat = await client.post("/v1/incidents", json=body)
    assert first.status_code == 201 and repeat.status_code == 200
    assert first.json()["id"] == repeat.json()["id"]
    # Same signature while the first is still active -> attached, not duplicated.
    other = await client.post("/v1/incidents", json={**body, "external_id": "PD-2"})
    assert other.status_code == 200 and other.json()["id"] == first.json()["id"]
    await idle(services)
    assert len((await client.get("/v1/incidents")).json()) == 1


async def test_unknown_ids(dev: tuple[httpx.AsyncClient, Services]) -> None:
    client, _ = dev
    assert (await client.get("/v1/incidents/nope")).status_code == 404
    resp = await client.post("/v1/approvals/nope/decision", json={"decision": "approved"})
    assert resp.status_code == 404


async def test_health_metrics_and_headers(dev: tuple[httpx.AsyncClient, Services]) -> None:
    client, _ = dev
    assert (await client.get("/health/live")).status_code == 200
    ready = await client.get("/health/ready")
    assert ready.status_code == 200 and ready.json()["checks"]["store"] == "ok"
    metrics = await client.get("/metrics")
    assert "ira_incidents_total" in metrics.text
    assert ready.headers["x-content-type-options"] == "nosniff"
    assert "x-request-id" in ready.headers
    big = await client.post("/v1/incidents", content=b"x" * 2_000_000,
                            headers={"content-type": "application/json"})
    assert big.status_code == 413


async def test_oidc_rbac(oidc: tuple[httpx.AsyncClient, Services]) -> None:
    client, services = oidc
    config = (await client.get("/v1/auth/config")).json()
    assert config == {"mode": "oidc", "issuer": ISSUER, "client_id": "ui",
                      "scopes": "openid profile email", "audience": AUDIENCE}

    assert (await client.get("/v1/incidents")).status_code == 401
    bad = {"Authorization": f"Bearer {token('eve', ['ira-admins'], aud='other')}"}
    assert (await client.get("/v1/incidents", headers=bad)).status_code == 401
    expired = {"Authorization": f"Bearer {token('eve', ['ira-admins'], exp=1)}"}
    assert (await client.get("/v1/incidents", headers=expired)).status_code == 401

    me = (await client.get("/v1/me", headers=auth("amy", "sre-leads"))).json()
    assert me["roles"] == ["viewer", "responder", "approver"]

    nobody = auth("nora", "marketing")
    assert (await client.get("/v1/incidents", headers=nobody)).status_code == 403
    viewer = auth("vic", "viewer")
    assert (await client.get("/v1/incidents", headers=viewer)).status_code == 200
    assert (await client.post("/v1/incidents", json=INCIDENT, headers=viewer)).status_code == 403

    created = await client.post("/v1/incidents", json=INCIDENT, headers=auth("sam", "sre"))
    assert created.status_code == 201
    await idle(services)
    [pending] = (await client.get("/v1/approvals/pending", headers=viewer)).json()
    url = f"/v1/approvals/{pending['action_id']}/decision"
    denied = await client.post(url, json={"decision": "approved"}, headers=auth("sam", "sre"))
    assert denied.status_code == 403
    ok = await client.post(url, json={"decision": "approved"}, headers=auth("amy", "sre-leads"))
    assert ok.status_code == 200
    await idle(services)
    detail = (await client.get(f"/v1/incidents/{created.json()['id']}", headers=viewer)).json()
    assert detail["actions"][0]["approval"]["by"] == "amy@corp"

    assert (await client.get("/v1/audit", headers=auth("amy", "sre-leads"))).status_code == 403
    events = (await client.get("/v1/audit", headers=auth("root", "ira-admins"))).json()
    actors = {(e["action"], e["actor"]) for e in events}
    assert ("incident.created", "sam@corp") in actors
    assert ("approval.approved", "amy@corp") in actors


async def test_intake_token_scope(oidc: tuple[httpx.AsyncClient, Services]) -> None:
    client, _ = oidc
    hdr = {"Authorization": f"Bearer {INTAKE_TOKEN}"}
    assert (await client.post("/v1/incidents", json=INCIDENT, headers=hdr)).status_code == 201
    assert (await client.get("/v1/incidents", headers=hdr)).status_code == 403
    wrong = {"Authorization": "Bearer " + "x" * 40}
    assert (await client.post("/v1/incidents", json=INCIDENT, headers=wrong)).status_code == 401
    await asyncio.sleep(0)


async def test_datasets_endpoints(dev: tuple[httpx.AsyncClient, Services]) -> None:
    client, _ = dev
    body = (await client.get("/v1/datasets")).json()
    assert body["citation"]["url"].startswith("https://arxiv.org/")
    assert {d["name"] for d in body["datasets"]} >= {"BGL", "Hadoop", "OpenSSH"}
    logs = (await client.get("/v1/datasets/OpenSSH/logs", params={"limit": 3})).json()
    assert logs["pii_redacted"] and len(logs["lines"]) == 3
    assert (await client.get("/v1/datasets/Nope")).status_code == 404
    assert (await client.get("/v1/datasets/BGL/logs", params={"limit": 999})).status_code == 422


async def test_datasets_require_viewer(oidc: tuple[httpx.AsyncClient, Services]) -> None:
    client, _ = oidc
    assert (await client.get("/v1/datasets")).status_code == 401
    ok = await client.get("/v1/datasets/BGL/templates", headers=auth("vic", "viewer"))
    assert ok.status_code == 200 and ok.json()[0]["count"] > 0


async def test_evals_endpoints(dev: tuple[httpx.AsyncClient, Services]) -> None:
    client, _ = dev
    body = (await client.get("/v1/evals")).json()
    assert "Evaluating the agent" in body["methodology"]
    assert body["runs"], "committed baseline results should be listed"
    run_id = body["runs"][-1]["run_id"]
    detail = (await client.get(f"/v1/evals/{run_id}")).json()
    assert detail["cases"] and detail["metrics"]["cases"] == len(detail["cases"])
    assert (await client.get("/v1/evals/..%2F..%2Fetc")).status_code == 404


async def test_graph_off_returns_503(dev: tuple[httpx.AsyncClient, Services]) -> None:
    client, _ = dev
    resp = await client.get("/v1/graph/overview")
    assert resp.status_code == 503 and "NEO4J_ENABLED" in resp.json()["detail"]
