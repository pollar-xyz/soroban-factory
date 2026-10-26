# Reglas de Caatinga (resumen del caatinga-skill)

- Caatinga orquesta el toolchain oficial de Stellar. No reemplazarlo con comandos `stellar` crudos.
- `caatinga.artifacts.json` es la fuente de la verdad por red. Nunca editarlo a mano; se regenera con `ctg deploy`.
- No copiar contract IDs a `.env` a mano: leerlos de artifacts o usar `${contracts.<name>.contractId}`.
- `--source` es un alias de identidad del Stellar CLI. Nunca una dirección G... ni seed S....
- Redes se definen en `caatinga.config.ts` (RPC + passphrase). Solo `testnet` habilitada en este servicio.
- Flujo: `ctg doctor` → `ctg build` → `ctg deploy` → `ctg generate` → `ctg status`.
- Subcomandos disponibles: init, doctor, build, deploy, upgrade, wire, sync-env, generate, status, smoke, regression, ci, identity, invoke, read.
