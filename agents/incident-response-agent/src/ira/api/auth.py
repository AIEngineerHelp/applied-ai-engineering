import asyncio
import hmac
import logging
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

import httpx
import jwt
from fastapi import Depends, HTTPException, Request, status

from src.ira.config import Settings, settings
from src.ira.observability.metrics import AUTH_FAILURES

logger = logging.getLogger(__name__)

Role = Literal["viewer", "responder", "approver", "admin"]
ROLE_ORDER: tuple[Role, ...] = ("viewer", "responder", "approver", "admin")
_ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256"]


@dataclass(frozen=True)
class Principal:
    sub: str
    name: str | None = None
    email: str | None = None
    roles: frozenset[Role] = field(default_factory=frozenset)
    kind: Literal["user", "intake", "dev"] = "user"

    @property
    def actor(self) -> str:
        """Stable identity recorded in the audit log and approvals."""
        return self.email or self.sub

    def has(self, role: Role) -> bool:
        needed = ROLE_ORDER.index(role)
        return any(ROLE_ORDER.index(r) >= needed for r in self.roles)

    def effective_roles(self) -> list[Role]:
        if not self.roles:
            return []
        top = max(ROLE_ORDER.index(r) for r in self.roles)
        return list(ROLE_ORDER[: top + 1])


DEV_PRINCIPAL = Principal(sub="dev", name="Local developer", roles=frozenset({"admin"}),
                          kind="dev")
INTAKE_PRINCIPAL_NAME = "intake-webhook"


def _unauthorized(reason: str) -> HTTPException:
    AUTH_FAILURES.labels(reason=reason).inc()
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


class OIDCVerifier:
    """Validates OIDC access tokens (JWT) against the issuer's JWKS."""

    def __init__(self, config: Settings):
        self.config = config
        self._jwks: jwt.PyJWKClient | None = None
        self._lock = asyncio.Lock()

    async def _client(self) -> jwt.PyJWKClient:
        if self._jwks is None:
            async with self._lock:
                if self._jwks is None:
                    issuer = (self.config.oidc_issuer or "").rstrip("/")
                    async with httpx.AsyncClient(timeout=10) as http:
                        resp = await http.get(f"{issuer}/.well-known/openid-configuration")
                        resp.raise_for_status()
                        jwks_uri = resp.json()["jwks_uri"]
                    self._jwks = jwt.PyJWKClient(
                        jwks_uri, cache_keys=True, lifespan=self.config.oidc_jwks_cache_s
                    )
        return self._jwks

    def roles_from_claims(self, claims: dict[str, Any]) -> frozenset[Role]:
        raw = claims.get(self.config.oidc_roles_claim, [])
        groups = [raw] if isinstance(raw, str) else list(raw or [])
        mapping = self.config.oidc_role_mapping
        roles: set[Role] = set()
        for g in groups:
            role = mapping.get(str(g), str(g))
            if role in ROLE_ORDER:
                roles.add(role)
        return frozenset(roles)

    async def verify(self, token: str) -> Principal:
        client = await self._client()
        signing_key = await asyncio.to_thread(client.get_signing_key_from_jwt, token)
        claims: dict[str, Any] = jwt.decode(
            token,
            signing_key.key,
            algorithms=_ALGORITHMS,
            audience=self.config.oidc_audience,
            issuer=self.config.oidc_issuer,
            options={"require": ["exp", "iat", "sub"]},
            leeway=30,
        )
        return Principal(
            sub=str(claims["sub"]),
            name=claims.get("name") or claims.get("preferred_username"),
            email=claims.get("email"),
            roles=self.roles_from_claims(claims),
        )


class Authenticator:
    def __init__(self, config: Settings = settings):
        self.config = config
        self.verifier = OIDCVerifier(config) if config.auth_mode == "oidc" else None

    def _intake_token(self, token: str) -> bool:
        return any(hmac.compare_digest(token, t) for t in self.config.intake_tokens)

    async def authenticate(self, request: Request) -> Principal:
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        token = token.strip()
        if token and scheme.lower() == "bearer" and self._intake_token(token):
            return Principal(sub=INTAKE_PRINCIPAL_NAME, kind="intake")
        if self.verifier is None:
            return DEV_PRINCIPAL
        if not token or scheme.lower() != "bearer":
            raise _unauthorized("missing_token")
        try:
            return await self.verifier.verify(token)
        except jwt.PyJWTError as e:
            logger.info("Rejected token: %s", e)
            raise _unauthorized("invalid_token") from None
        except httpx.HTTPError as e:
            logger.error("OIDC discovery/JWKS unavailable: %s", e)
            raise HTTPException(status_code=503, detail="Identity provider unavailable") from None


def get_authenticator(request: Request) -> Authenticator:
    auth: Authenticator = request.app.state.authenticator
    return auth


async def current_principal(
    request: Request, auth: Annotated[Authenticator, Depends(get_authenticator)]
) -> Principal:
    principal = await auth.authenticate(request)
    request.state.principal = principal
    return principal


def require(role: Role, *, allow_intake: bool = False) -> Any:
    async def dependency(
        principal: Annotated[Principal, Depends(current_principal)],
    ) -> Principal:
        if principal.kind == "intake":
            if allow_intake:
                return principal
            AUTH_FAILURES.labels(reason="intake_token_scope").inc()
            raise HTTPException(status_code=403, detail="Intake tokens may only create incidents")
        if not principal.has(role):
            AUTH_FAILURES.labels(reason="forbidden").inc()
            raise HTTPException(status_code=403, detail=f"Requires role '{role}'")
        return principal

    return Depends(dependency)
