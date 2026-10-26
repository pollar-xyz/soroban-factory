# Plan de construcción (orden estricto)

- [x] 1. `npm init`, TypeScript, Hono, better-sqlite3, p-queue, zod. `GET /health` funcionando.
- [x] 2. Dockerfile con Node 22 + Rust + wasm32v1-none + Stellar CLI + @caatinga/cli. Verificar `npx ctg doctor` dentro del contenedor.
- [x] 3. DB SQLite: tablas `projects(id,name,token_hash,network,source,address,created_at)` y `jobs(id,project_id,type,status,step,logs,result,error,created_at,started_at,finished_at)`.
- [x] 4. Módulo `ctg.ts`: ejecuta `npx ctg <args>` en el workspace con timeout y captura de logs.
- [x] 5. `POST /projects`: `ctg init --minimal`, `stellar keys generate p_<id> --network testnet --fund`, guardar token (hash).
- [x] 6. Auth middleware: maestro vs proyecto.
- [x] 7. `PUT/GET /projects/:id/files` con validación de rutas (sin `..`, solo `contracts/` y `caatinga.config.ts`).
- [x] 8. Cola de jobs: `build` y `deploy` (+`generate`), concurrencia 2, un job activo por proyecto, logs en DB.
- [x] 9. `GET /jobs/:id`, `GET /projects/:id`, `/artifacts`, `/bindings`.
- [x] 10. Prueba end-to-end local con Docker: crear proyecto → subir contrato hello-world → build → deploy → leer contract ID.
- [ ] 11. Dokploy: app desde el repo (Dockerfile), volumen en /data, `MASTER_TOKEN`, 4 GB RAM, dominio. Probar con la URL pública (`scripts/e2e.sh`).
- [ ] 12. Entregar docs/API.md a Pollar Studio.

Después (no ahora): webhooks, `/generate` con IA, mainnet con firma de wallet.
