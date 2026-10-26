# soroban-factory

Servicio HTTP que compila y despliega contratos Soroban (Stellar) usando Caatinga (`ctg`).
No tiene IA dentro. Un cliente externo (Pollar Studio) manda el código Rust; este servicio lo
compila, despliega en testnet y devuelve contract IDs + bindings TypeScript.

Lee en orden: docs/ARCHITECTURE.md → docs/API.md → docs/PLAN.md → docs/RULES.md

## Stack
- Node 22 + TypeScript, Hono (HTTP), better-sqlite3 (DB), p-queue (cola)
- Rust + target wasm32v1-none, Stellar CLI, @caatinga/cli
- Docker, volumen en /data

## Comandos
- `npm run dev` — servidor local
- `npm run build && npm start` — producción
- `docker build -t soroban-factory .` — imagen
- `docker run -p 3000:3000 -v $(pwd)/data:/data --env-file .env soroban-factory`

## Reglas duras
- Nunca ejecutar `stellar contract deploy` directo: siempre `ctg deploy`.
- Nunca editar `caatinga.artifacts.json` a mano.
- `--source` siempre es un alias de identidad, nunca una clave.
- Nunca aceptar claves privadas por la API.
- Toda operación larga es un job asíncrono.
