# The agent worker for LiveKit Cloud (`lk agent create` / `lk agent deploy` from this
# directory). Hosted mode: each call gets its own in-process mock CRM, calls end after
# 3 minutes, and no webhooks go out. LiveKit Cloud injects LIVEKIT_URL, LIVEKIT_API_KEY and
# LIVEKIT_API_SECRET; GEMINI_API_KEY comes from the agent's secrets (see the README).
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 HF_HOME=/app/.cache
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project
COPY voiceagent ./voiceagent
COPY workflow ./workflow
COPY knowledge ./knowledge
RUN uv sync --locked --no-dev
# Model files (VAD, turn detector) go into the image, not a download at the first call.
RUN uv run --no-sync python -m voiceagent.worker download-files

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
ENV PYTHONUNBUFFERED=1 HF_HOME=/app/.cache \
    CRM_MODE=embedded DELIVER_WEBHOOKS=false MAX_CALL_SECONDS=180
RUN useradd --uid 10001 --create-home appuser
WORKDIR /app
COPY --from=build --chown=appuser:appuser /app /app
USER appuser
CMD ["uv", "run", "--no-sync", "python", "-m", "voiceagent.worker", "start"]
