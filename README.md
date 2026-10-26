# soroban-factory

HTTP service that compiles and deploys Soroban (Stellar) contracts with Caatinga (`ctg`).
A client (Pollar Studio) sends Rust sources; this service builds them, deploys to **testnet**
and returns contract IDs plus TypeScript bindings. No AI inside.

Docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/API.md](docs/API.md) · [docs/PLAN.md](docs/PLAN.md) · [docs/RULES.md](docs/RULES.md)

## Run locally

```bash
cp .env.example .env            # set MASTER_TOKEN (>= 16 chars)
npm install
npm run dev                     # DATA_DIR defaults to ./data
```

Requires on the host: Node 22+, Rust with the `wasm32v1-none` target, Stellar CLI. The Docker image bundles all of it.

## Docker

```bash
docker build -t soroban-factory .
docker run -p 3000:3000 -v "$(pwd)/data:/data" --env-file .env soroban-factory
```

## End-to-end smoke test

```bash
BASE=http://localhost:3000 MASTER_TOKEN=... scripts/e2e.sh
```

Creates a project, uploads a hello-world contract, builds, deploys to testnet and prints the contract ID and bindings.

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `MASTER_TOKEN` | — | Required. Only used for `POST /projects`. |
| `PORT` | `3000` | |
| `DATA_DIR` | `/data` | SQLite DB, project workspaces, cargo cache, Stellar identities. Mount a volume. |
| `NETWORK` | `testnet` | Only `testnet` is accepted. |
| `JOB_CONCURRENCY` | `2` | Parallel build/deploy jobs. |
| `JOB_TIMEOUT_MS` | `600000` | Per job (all steps). |
| `LOG_MAX_BYTES` | `51200` | Log tail kept per job. |

## Layout of `/data`

```
db.sqlite                 projects, jobs
projects/<id>/            Caatinga workspace (ctg init --minimal), node_modules symlinked to the service
cargo-cache/              CARGO_HOME shared by all builds (crate registry + downloads)
stellar-config/stellar/   Stellar CLI identities (XDG_CONFIG_HOME), one alias per project id
```

## Deploy on Railway

1. Push this repo to GitHub and create a Railway service from it (Dockerfile is auto-detected; `railway.toml` sets the health check).
2. Add a **volume** mounted at `/data`.
3. Variables: `MASTER_TOKEN` (required). Optionally `JOB_CONCURRENCY`, `JOB_TIMEOUT_MS`.
4. Resources: 4 GB RAM recommended (two concurrent Rust builds). Keep **1 replica**: the queue and SQLite are in-process.
5. Verify: `curl https://<host>/health` then run `scripts/e2e.sh` against the public URL.

## Hard rules

- Deploys always go through `ctg deploy`; never `stellar contract deploy` directly.
- `caatinga.artifacts.json` is never edited by hand.
- `--source` is always an identity alias (the project id); private keys never cross the API.
- Every long operation is an async job (`POST .../build|deploy` → `GET /jobs/:id`).
