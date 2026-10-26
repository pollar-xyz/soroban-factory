# soroban-factory

HTTP service that compiles and deploys Soroban (Stellar) contracts with Caatinga (`ctg`).
A client (Pollar Studio) sends Rust sources; this service builds them, deploys to **testnet**
and returns contract IDs plus TypeScript bindings. No AI inside.

Production: https://soroban-factory.pollar.dev (Dokploy, auto-deploys from `main`)

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

## Deploy on Dokploy

1. Push this repo to GitHub.
2. In Dokploy: **Create Application** → provider GitHub → pick the repo and branch. Build type: **Dockerfile** (path `Dockerfile`).
3. **Environment**: `MASTER_TOKEN=<secret, 16+ chars>`. `PORT` stays 3000. Optional: `JOB_CONCURRENCY`, `JOB_TIMEOUT_MS`.
4. **Advanced → Volumes**: add a *Volume Mount* with mount path `/data` (name e.g. `soroban-factory-data`). Without it the DB, workspaces and identities are lost on every deploy.
5. **Advanced → Resources**: at least 4 GB RAM (two concurrent Rust builds). Keep **1 replica**: queue and SQLite are in-process.
6. **Domains**: add a host, container port `3000`, HTTPS on. Health check path `/health`.
7. Deploy, then verify: `curl https://<host>/health` and run `scripts/e2e.sh` against the public URL.

The first image build takes ~10 min (Rust + Stellar CLI). Builds run on the Dokploy server, so give it disk for the image (~2 GB) and for `/data`.

## Hard rules

- Deploys always go through `ctg deploy`; never `stellar contract deploy` directly.
- `caatinga.artifacts.json` is never edited by hand.
- `--source` is always an identity alias (the project id); private keys never cross the API.
- Every long operation is an async job (`POST .../build|deploy` → `GET /jobs/:id`).

## Handoff to Pollar Studio

Give the client three things:
- Base URL: `https://soroban-factory.pollar.dev`
- `MASTER_TOKEN` (from the Dokploy environment / local `.env`), used only for `POST /projects`.
- [docs/API.md](docs/API.md), which matches the deployed implementation.

## Operational notes and known gaps

1. **Backups of `/data`.** The SQLite DB, project workspaces and the testnet identity keys live on the volume. Losing it loses every project. Schedule volume backups in Dokploy (S3 destination).
2. **Project tokens cannot be rotated.** They are stored hashed and there is no rotate endpoint. A lost token means creating a new project. Candidate: `POST /projects/:id/rotate-token` guarded by the master token.
3. **No cleanup.** Projects are never deleted or expired. Each compiled project uses ~100 MB (`target/`). With dozens of projects add `DELETE /projects/:id` or a periodic cleanup job.
4. **Monitoring.** Dokploy restarts the container on failure but does not alert. Point an external uptime check at `/health`.
5. **Repository visibility.** The repo is public. It holds no secrets (`.env` and `data/` are ignored); make it private on GitHub if preferred, Dokploy keeps working.
6. **Caatinga bug.** ctg 3.12 hides rustc output when it contains "not found" and reports a missing wasm target instead. The service works around it by re-running `stellar contract build` for diagnostics only (see docs/ARCHITECTURE.md). Worth reporting upstream.
7. **Single tenant, single replica.** Rust build scripts run with the service's privileges inside the container, and the queue plus SQLite are in-process. Do not scale to multiple replicas without moving state out.

Out of scope for now (see docs/PLAN.md): webhooks, AI-assisted `/generate`, mainnet with wallet signing.
