# API

Base: `https://<host>`. Header: `Authorization: Bearer <token>`. Bodies y respuestas en JSON.
- Token maestro (`MASTER_TOKEN`): solo para `POST /projects`.
- Token de proyecto (`pt_...`): devuelto al crear el proyecto; sirve para todo lo demás. Se guarda hasheado: si se pierde, hay que crear otro proyecto.

## Proyectos
### POST /projects
Body: `{ "name": "voting-app" }` (1–64 chars, `[A-Za-z0-9_-]`, empieza alfanumérico)
→ `201 { "id": "p_8f3a1c2d", "token": "pt_...", "network": "testnet", "source": "p_8f3a1c2d", "address": "G..." }`

Crea el workspace (`ctg init --minimal`, con un contrato de ejemplo `app`), genera la identidad `p_<id>` y la fondea con Friendbot. Tarda ~5–15 s. `502` si falla el setup (p. ej. Friendbot caído).

### GET /projects/:id
→ `{ id, name, network, source, address, createdAt, contracts: [{ name, status: "pending|built|deployed", contractId?, wasmHash? }], lastJob }`

`contracts` se deriva de los directorios `contracts/<name>/Cargo.toml` y de `caatinga.artifacts.json`. `lastJob` tiene la misma forma que `GET /jobs/:jobId` (o `null`).

### PUT /projects/:id/files
Escribe archivos en el workspace. Rutas permitidas: `caatinga.config.ts` y cualquier cosa bajo `contracts/` (sin `..`, sin `target/`, sin dotfiles). Máx. 200 archivos por request, 1 MB por archivo, 16 MB por body. Crea directorios intermedios.
Body: `{ "files": [ { "path": "contracts/voting/src/lib.rs", "content": "..." }, { "path": "contracts/voting/Cargo.toml", "content": "..." } ] }`
→ `200 { "written": 2 }`

Para que `ctg` vea un contrato nuevo hay que registrarlo en `caatinga.config.ts` (clave en `contracts` con `path` y `wasm`). El config inicial del proyecto es:
```ts
import { defineConfig } from "@caatinga/core";
export default defineConfig({
  project: "<name>",
  defaultNetwork: "testnet",
  frontend: { bindingsOutput: "./bindings" },
  contracts: {
    app: { path: "./contracts/app", wasm: "./contracts/app/target/wasm32v1-none/release/app.wasm" }
  },
  networks: {
    testnet: { rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015" }
  }
});
```
Mantener `frontend.bindingsOutput: "./bindings"` para que `GET /bindings` funcione. Solo `testnet`.

### GET /projects/:id/files?path=contracts/voting/src/lib.rs
→ `{ path, content }` (mismas reglas de ruta; `404` si no existe)

## Jobs
Un solo job activo por proyecto. Concurrencia global: 2. Timeout por job: 10 min.

### POST /projects/:id/build
→ `202 { "jobId": "j_1", "status": "queued" }` — ejecuta `ctg build`.

### POST /projects/:id/deploy
Body opcional: `{ "upgrade": false, "generate": true }`
→ `202 { "jobId": "j_2", "status": "queued" }`

Pasos: `build` → `deploy` (`ctg deploy --network testnet --source p_<id>`; con `upgrade: false` usa `--if-changed`, así un redeploy sin cambios de WASM conserva el contract ID; con `upgrade: true` usa `--upgrade`, que redespliega guardando historial) → `generate` (`ctg generate`, si `generate` es `true`).

### GET /jobs/:jobId
```json
{ "jobId": "j_2", "projectId": "p_8f3a1c2d", "type": "deploy", "status": "queued|running|succeeded|failed",
  "step": "build|deploy|generate", "createdAt": "...", "startedAt": "...", "finishedAt": "...",
  "logs": "últimos 50 KB de salida de ctg",
  "result": { "contracts": { "voting": { "contractId": "C...", "wasmHash": "..." } } },
  "error": { "step": "build", "message": "error[E0425]: ... (src/lib.rs:42)" } }
```
Para `build` el `result` es `{ "built": true }`. `result`/`error` son `null` mientras no termina. Sondear cada 2–5 s.

## Resultados
### GET /projects/:id/artifacts  → contenido de `caatinga.artifacts.json` (`networks.testnet.contracts.<name>.{contractId,wasmHash,deployedAt,...}`)
### GET /projects/:id/bindings    → `{ files: [ { path: "bindings/<name>/src/client.ts", content } ] }` bindings TS generados (un directorio por contrato; incluye `package.json`, `index.ts`, `src/*.ts`, `README.md`)
### GET /health                   → `{ ok: true, ctg: "3.12.0", queue: { running, pending } }` (sin auth)

## Errores
Formato: `{ "error": "<mensaje>" }`.
`400` body inválido · `401` token inválido · `404` proyecto/job/archivo no existe (también si el token es de otro proyecto) · `409` ya hay un job activo en el proyecto (`{ error: "project_busy", jobId, status }`) · `422` ruta de archivo no permitida · `502` fallo al crear el proyecto (ctg init / identidad / Friendbot)
