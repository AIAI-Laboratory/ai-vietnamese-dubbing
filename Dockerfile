FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY server/ ./server/
COPY scripts/ ./scripts/

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /nonexistent \
        --shell /usr/sbin/nologin app \
    && mkdir -p /app/server/models \
    && chown -R app:app /app/server/models

USER app

EXPOSE 18765
CMD ["python", "server/main.py"]
