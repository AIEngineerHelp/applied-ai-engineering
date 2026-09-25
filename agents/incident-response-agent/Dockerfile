# syntax=docker/dockerfile:1.7
#
# Shared image for the Incident Response Agent api, worker and migrate processes.
# Only the command differs (see docs/production-contract.md):
#   api      python -m src.ira.api      (port 8000, default CMD)
#   worker   python -m src.ira.worker   (port 9100: /metrics, /health/*)
#   migrate  alembic upgrade head
#
# Build:  docker build -t ira:local .

ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.10

# --------------------------------------------------------------------------- uv binary
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# --------------------------------------------------------------------------- builder
FROM python:${PYTHON_VERSION}-slim-bookworm AS builder

COPY --from=uv /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

# Dependencies only (cached until pyproject.toml / uv.lock change). The project itself
# is not installed: the code runs from /app as `src.ira.*` (namespace packages).
# The spaCy model en_core_web_lg (Presidio) is a pinned dependency and comes in here.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-project

# --------------------------------------------------------------------------- runtime
FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

ARG APP_UID=10001
ARG APP_GID=10001
ARG VERSION=dev
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="incident-response-agent" \
      org.opencontainers.image.description="Incident Response Agent api/worker" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV PATH="/app/.venv/bin:${PATH}" \
    VIRTUAL_ENV=/app/.venv \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONFAULTHANDLER=1 \
    # Writable locations under a read-only root filesystem (/tmp is an emptyDir/tmpfs).
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    # Use LiteLLM's bundled model price map instead of fetching it from GitHub at import.
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    LITELLM_MODE=PRODUCTION \
    ARTIFACTS_DIR=/var/lib/ira/artifacts \
    # Port the image HEALTHCHECK probes: 8000 for the api, set 9100 for the worker.
    HEALTH_PORT=8000

RUN groupadd --system --gid ${APP_GID} ira \
 && useradd --system --uid ${APP_UID} --gid ${APP_GID} --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin ira \
 && mkdir -p /var/lib/ira/artifacts \
 && chown -R ${APP_UID}:${APP_GID} /var/lib/ira \
 && chmod 0750 /var/lib/ira/artifacts

WORKDIR /app

# Code and read-only assets are owned by root: the app user can read but not modify them.
COPY --from=builder /app/.venv /app/.venv
COPY alembic.ini ./alembic.ini
COPY alembic/ ./alembic/
COPY registry/ ./registry/
COPY data/loghub/2k/ ./data/loghub/2k/
COPY src/ ./src/
# Evals tab: methodology + result snapshot (compose mounts ./evals/results live on top).
COPY docs/evals.md ./docs/evals.md
COPY evals/results/ ./evals/results/

# Pre-compile application bytecode so a read-only filesystem costs nothing at startup.
RUN python -m compileall -q src alembic

USER ${APP_UID}:${APP_GID}

EXPOSE 8000 9100

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health/live' % os.environ.get('HEALTH_PORT', '8000'), timeout=4)"]

CMD ["python", "-m", "src.ira.api"]
