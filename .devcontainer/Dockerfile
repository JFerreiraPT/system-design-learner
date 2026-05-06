FROM mcr.microsoft.com/devcontainers/typescript-node:22

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  libpq-dev \
  postgresql-client \
  libssl-dev \
  pkg-config \
  ripgrep \
  fd-find \
  gh \
  jq \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9 turbo@2 tsx @devcontainers/cli

RUN curl -sSL https://aka.ms/apm-unix | sh || echo "APM CLI install failed; install manually after container starts"

RUN rm -f /usr/local/lib/apm/_internal/libssl.so.3 \
         /usr/local/lib/apm/_internal/libcrypto.so.3 2>/dev/null || true

WORKDIR /workspace
