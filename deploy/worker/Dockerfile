# syntax=docker/dockerfile:1
#
# Carbon worker image: Node 22 + git + Claude Code (+ Codex, opt-in) + dist/worker.mjs.
# Multi-arch (linux/amd64, linux/arm64): the build stage only produces plain JavaScript, so it
# runs on the build host's platform; the runtime stage installs the CLIs with npm, which picks
# the right native package for the target architecture.
#
#   docker build -f deploy/worker/Dockerfile -t carbon-worker .
#   docker buildx build -f deploy/worker/Dockerfile --platform linux/amd64,linux/arm64 -t <registry>/carbon-worker:<tag> --push .
#   docker build -f deploy/worker/Dockerfile --build-arg WITH_CODEX=true -t carbon-worker:codex .
#   docker run --rm carbon-worker --version

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY bin ./bin
COPY src ./src
RUN npm run build:worker

FROM node:22-bookworm-slim AS runtime
ARG CLAUDE_CODE_VERSION=2.1.319
ARG CODEX_VERSION=0.167.0
ARG WITH_CODEX=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && if [ "$WITH_CODEX" = "true" ]; then npm install -g --no-audit --no-fund "@openai/codex@${CODEX_VERSION}"; fi \
 && npm cache clean --force

# Fixed numeric UID/GID so Kubernetes `runAsNonRoot` can verify the user without a lookup.
RUN groupadd --gid 10001 carbon \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/carbon --shell /usr/sbin/nologin carbon \
 && mkdir -p /home/carbon/work \
 && chown -R 10001:10001 /home/carbon

COPY --from=build /src/dist/worker.mjs /app/worker.mjs

ENV NODE_ENV=production \
    CARBON_WORKER_DIR=/home/carbon/work \
    DISABLE_AUTOUPDATER=1

USER 10001:10001
WORKDIR /home/carbon
# tini forwards SIGTERM to node so the worker can stop claiming and finish running tasks.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/worker.mjs"]
