import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRelPath } from "../src/workspace.js";

const ok = ["caatinga.config.ts", "contracts/voting/src/lib.rs", "contracts/voting/Cargo.toml", "contracts/a/b/c/d.rs"];
const rejected = [
  "../x", "contracts/../caatinga.config.ts", "/etc/passwd", "contracts", "contracts/", "contracts//x.rs",
  "contracts/voting/target/wasm32v1-none/release/voting.wasm", "node_modules/x", "contracts/voting/node_modules/x",
  "caatinga.artifacts.json", "package.json", ".stellar/identity/p.toml", "contracts/.hidden/x", "contracts\\x.rs",
  "C:/x", "contracts/./x.rs", "contracts/x\0.rs", "", "a".repeat(600),
];

test("accepts contract sources and config", () => {
  for (const p of ok) assert.equal(validateRelPath(p), p);
});

test("rejects traversal, build output, secrets and anything outside contracts/", () => {
  for (const p of rejected) assert.throws(() => validateRelPath(p), { status: 422 }, `should reject ${JSON.stringify(p)}`);
});
