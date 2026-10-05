FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

ARG DEBIAN_FRONTEND=noninteractive
ARG CA_REFRESH=unset
ARG FRONTEND_REFRESH=unset
RUN echo "ca-refresh: ${CA_REFRESH}" \
    && apt-get update \
    && apt-get install --no-install-recommends --no-install-suggests -y \
       git ca-certificates smartmontools \
    && update-ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend production dependencies before copying source files.
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

# Build the frontend in a temporary directory, then discard its build dependencies.
COPY frontend/package.json frontend/bun.lock* /tmp/frontend/
COPY frontend/scripts/postinstall-bindings.cjs /tmp/frontend/scripts/
RUN cd /tmp/frontend && bun install --frozen-lockfile
COPY frontend/ /tmp/frontend/
RUN echo "frontend-refresh: ${FRONTEND_REFRESH}" \
    && cd /tmp/frontend \
    && bun run build \
    && mkdir -p /app/frontend \
    && cp -R dist package.json /app/frontend/ \
    && rm -rf /tmp/frontend

COPY src/ ./src/
COPY user-docs/ ./user-docs/

RUN mkdir -p /app/data && chown -R bun:bun /app/data

LABEL org.opencontainers.image.title="Lumiverse" \
      org.opencontainers.image.description="AI chat application server" \
      org.opencontainers.image.source="https://github.com/prolix-oc/Lumiverse"

ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/app/data \
    FRONTEND_DIR=/app/frontend/dist \
    TRUST_ANY_ORIGIN=true

EXPOSE 7860
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD bun run src/healthcheck.ts

USER bun
CMD ["bun", "run", "src/index.ts"]
