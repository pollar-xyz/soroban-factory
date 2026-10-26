#!/usr/bin/env bash
# End-to-end smoke test: create project -> upload hello-world contract -> build -> deploy -> read contract ID.
# Usage: BASE=http://localhost:3000 MASTER_TOKEN=... scripts/e2e.sh
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
: "${MASTER_TOKEN:?set MASTER_TOKEN}"
need() { command -v "$1" >/dev/null || { echo "missing $1"; exit 1; }; }
need curl; need node

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],j);console.log(typeof v==="object"?JSON.stringify(v):v??"")})' "$1"; }

echo "== health"; curl -sfS "$BASE/health"; echo

echo "== create project"
CREATE=$(curl -sfS -X POST "$BASE/projects" -H "Authorization: Bearer $MASTER_TOKEN" -H 'content-type: application/json' -d '{"name":"hello-e2e"}')
echo "$CREATE"
PID=$(echo "$CREATE" | json id); TOKEN=$(echo "$CREATE" | json token)
AUTH=(-H "Authorization: Bearer $TOKEN")

echo "== upload hello-world contract"
LIB='#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, vec, Env, Symbol, Vec};

#[contract]
pub struct HelloContract;

#[contractimpl]
impl HelloContract {
    pub fn hello(env: Env, to: Symbol) -> Vec<Symbol> {
        vec![&env, symbol_short!("Hello"), to]
    }
}'
CARGO='[package]
name = "hello"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = "27.0.6"

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true'
CONFIG='import { defineConfig } from "@caatinga/core";
export default defineConfig({
  project: "hello-e2e",
  defaultNetwork: "testnet",
  frontend: { bindingsOutput: "./bindings" },
  contracts: {
    hello: { path: "./contracts/hello", wasm: "./contracts/hello/target/wasm32v1-none/release/hello.wasm" }
  },
  networks: {
    testnet: { rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015" }
  }
});'
BODY=$(node -e 'console.log(JSON.stringify({files:[{path:"contracts/hello/src/lib.rs",content:process.argv[1]},{path:"contracts/hello/Cargo.toml",content:process.argv[2]},{path:"caatinga.config.ts",content:process.argv[3]}]}))' "$LIB" "$CARGO" "$CONFIG")
curl -sfS -X PUT "$BASE/projects/$PID/files" "${AUTH[@]}" -H 'content-type: application/json' -d "$BODY"; echo

echo "== path traversal must be rejected (expect 422)"
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$BASE/projects/$PID/files" "${AUTH[@]}" -H 'content-type: application/json' -d '{"files":[{"path":"../../etc/passwd","content":"x"}]}'

wait_job() {
  local jid="$1"
  while true; do
    J=$(curl -sfS "$BASE/jobs/$jid" "${AUTH[@]}")
    S=$(echo "$J" | json status); ST=$(echo "$J" | json step)
    echo "  $jid status=$S step=$ST"
    case "$S" in succeeded) echo "$J" | json result; return 0;; failed) echo "$J" | json error; echo "$J" | json logs | tail -c 3000; return 1;; esac
    sleep 3
  done
}

echo "== build"
B=$(curl -sfS -X POST "$BASE/projects/$PID/build" "${AUTH[@]}"); echo "$B"
echo "== second build while busy (expect 409)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/projects/$PID/build" "${AUTH[@]}"
wait_job "$(echo "$B" | json jobId)"

echo "== deploy"
D=$(curl -sfS -X POST "$BASE/projects/$PID/deploy" "${AUTH[@]}" -H 'content-type: application/json' -d '{}'); echo "$D"
wait_job "$(echo "$D" | json jobId)"

echo "== project"; curl -sfS "$BASE/projects/$PID" "${AUTH[@]}" | json contracts; echo
echo "== artifacts"; curl -sfS "$BASE/projects/$PID/artifacts" "${AUTH[@]}" | json networks.testnet.contracts.hello.contractId
echo "== bindings"; curl -sfS "$BASE/projects/$PID/bindings" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.files.map(f=>f.path).join("\n"))})'
echo "== compile error must surface the rustc diagnostic"
BROKEN=$(node -e 'console.log(JSON.stringify({files:[{path:"contracts/hello/src/lib.rs",content:"#![no_std]\nuse soroban_sdk::{contract, contractimpl, Env};\n#[contract]\npub struct H;\n#[contractimpl]\nimpl H { pub fn hello(env: Env) -> u32 { undefined_fn(&env) } }\n"}]}))')
curl -sfS -X PUT "$BASE/projects/$PID/files" "${AUTH[@]}" -H 'content-type: application/json' -d "$BROKEN" >/dev/null
F=$(curl -sfS -X POST "$BASE/projects/$PID/build" "${AUTH[@]}")
if wait_job "$(echo "$F" | json jobId)" >/dev/null 2>&1; then echo "expected build to fail"; exit 1; fi
MSG=$(curl -sfS "$BASE/jobs/$(echo "$F" | json jobId)" "${AUTH[@]}" | json error.message); echo "  error.message: $MSG"
case "$MSG" in *"error[E0425]"*"src/lib.rs:6"*) ;; *) echo "unexpected error message"; exit 1;; esac

echo "== wrong token (expect 401)"; curl -s -o /dev/null -w '%{http_code}\n' "$BASE/projects/$PID" -H "Authorization: Bearer pt_nope"
echo "== E2E OK project=$PID"
