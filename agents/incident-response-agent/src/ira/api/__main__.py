import uvicorn

from src.ira.config import settings
from src.ira.observability.logging import configure_logging

if __name__ == "__main__":
    configure_logging(settings)
    uvicorn.run(
        "src.ira.api.main:app",
        host="0.0.0.0",
        port=8000,
        proxy_headers=True,
        forwarded_allow_ips="*",
        log_config=None,
        access_log=False,
        timeout_graceful_shutdown=20,
    )
