# syntax=docker/dockerfile:1.7
# ---------- Stage 1: compile TypeScript ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* \
 && npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- Stage 2: runtime with Rust + Stellar CLI + ctg ----------
FROM node:22-bookworm-slim AS runtime

ARG STELLAR_CLI_VERSION=28.0.0
ARG RUST_TOOLCHAIN=stable
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config libssl-dev libdbus-1-3 libudev1 \
 && rm -rf /var/lib/apt/lists/*

# Rust toolchain + wasm32v1-none target (Soroban SDK >= 22)
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
      --default-toolchain "${RUST_TOOLCHAIN}" --target wasm32v1-none \
 && rustc --version && cargo --version \
 && rustup target list --installed

# Stellar CLI (official prebuilt binary, pinned to the version last tested by Caatinga)
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) STELLAR_ARCH=x86_64-unknown-linux-gnu ;; \
      arm64) STELLAR_ARCH=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported arch: ${TARGETARCH}" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${STELLAR_ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin stellar; \
    chmod +x /usr/local/bin/stellar; \
    stellar --version

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Runtime data: SQLite DB, project workspaces, cargo cache (mount a volume here)
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CARGO_NET_RETRY=5
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
