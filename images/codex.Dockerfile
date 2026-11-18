# Development image for the local self-hosted executor.
# Pin the base image digest and Codex package version before using untrusted projects.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && npm install -g @openai/codex@alpha \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
