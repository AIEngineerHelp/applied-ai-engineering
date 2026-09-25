from fastapi import APIRouter
from fastapi.responses import RedirectResponse

from src.ira.config import settings

router = APIRouter()


@router.get("/", include_in_schema=False)
async def serve_dashboard() -> RedirectResponse:
    # The operator UI is the Next.js app in frontend/.
    return RedirectResponse(settings.frontend_url)
