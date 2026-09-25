from typing import Annotated, Any

from fastapi import APIRouter, Depends

from src.ira.api.auth import Authenticator, Principal, current_principal, get_authenticator

router = APIRouter()


@router.get("/auth/config")
async def auth_config(
    auth: Annotated[Authenticator, Depends(get_authenticator)],
) -> dict[str, Any]:
    """Public: tells the UI how to sign in."""
    settings = auth.config
    oidc = settings.auth_mode == "oidc"
    return {
        "mode": settings.auth_mode,
        "issuer": settings.oidc_issuer if oidc else None,
        "client_id": settings.oidc_client_id if oidc else None,
        "scopes": settings.oidc_scopes,
        "audience": settings.oidc_audience if oidc else None,
    }


@router.get("/me")
async def me(principal: Annotated[Principal, Depends(current_principal)]) -> dict[str, Any]:
    return {
        "sub": principal.sub,
        "name": principal.name,
        "email": principal.email,
        "roles": principal.effective_roles(),
    }
