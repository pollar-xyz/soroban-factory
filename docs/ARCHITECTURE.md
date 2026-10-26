# Arquitectura

```
Pollar Studio (IA externa)
   │  HTTPS + token
   ▼
soroban-factory (Docker)
   ├─ API HTTP (Hono)
   ├─ Auth: token maestro + token por proyecto
   ├─ Cola de jobs (p-queue, concurrencia 2)
   ├─ Caatinga (ctg) + Rust + Stellar CLI
   └─ /data (volumen)
        ├─ db.sqlite          proyectos, tokens, jobs
        ├─ projects/<id>/     workspace Caatinga (ctg init)
        └─ cargo-cache/       caché de compilación
   │  ctg deploy --network testnet --source <alias>
   ▼
Stellar testnet
```

## Flujo
1. `POST /projects` → crea workspace con `ctg init`, crea identidad `p_<id>` y la fondea (Friendbot).
2. `PUT /projects/:id/files` → escribe los archivos Rust del contrato en el workspace.
3. `POST /projects/:id/build` → job: `ctg build`.
4. `POST /projects/:id/deploy` → job: `ctg deploy` + `ctg generate`.
5. `GET /jobs/:jobId` → estado, logs, error o resultado.
6. `GET /projects/:id/artifacts` y `/bindings` → lo que la IA necesita para el frontend.

## Decisiones
- Un contenedor, un volumen, SQLite. Sin Postgres/Redis hasta >20 usuarios activos.
- Solo testnet. Mainnet requiere firma del usuario con wallet (fuera de alcance ahora).
- Timeout de job: 10 min. Logs truncados a últimos 50 KB.
- Workspaces aislados por carpeta; nunca rutas fuera de /data/projects/<id>.
- Identidades Stellar en `/data/stellar-config/stellar/identity/<p_id>.toml` (vía `XDG_CONFIG_HOME`), así persisten en el volumen. Alias = id del proyecto.
- `CARGO_HOME=/data/cargo-cache` compartido (registro y crates descargados); el `target/` es por contrato dentro del workspace.
- Workspaces sin `npm install`: `node_modules` es un symlink al del servicio, que ya incluye `@caatinga/core`.
- `caatinga.config.ts` nunca se evalúa dentro del proceso del servicio (es código del cliente); la lista de contratos sale de `contracts/*/Cargo.toml` + artifacts.
- Excepción documentada a "nunca `stellar` crudo": si `ctg build` falla sin mostrar el error de rustc (bug de Caatinga 3.12: errores con "not found in this scope" se reportan como `CAATINGA_RUST_TARGET_NOT_FOUND`), el job re-ejecuta `stellar contract build` solo para capturar el diagnóstico. Nunca para desplegar.
