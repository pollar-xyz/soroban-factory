import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import { hashToken, newProjectToken } from "./auth.js";
import { config } from "./config.js";
import { ctgOrThrow, SERVICE_NODE_MODULES, stellar, stellarOrThrow, CommandError } from "./ctg.js";
import { insertProject, now, type ProjectRow } from "./db.js";
import { CONFIG_FILE, workspaceDir } from "./workspace.js";

function newProjectId(): string {
  return `p_${randomBytes(4).toString("hex")}`;
}

/** Testnet-only Caatinga config with bindings output enabled. Contracts map starts with the scaffold's `app`. */
function configTemplate(projectName: string): string {
  return `import { defineConfig } from "@caatinga/core";

// Managed by soroban-factory. You may edit this file via PUT /projects/:id/files.
// Register every contract you upload under "contracts" (path + wasm output).
export default defineConfig({
  project: ${JSON.stringify(projectName)},
  defaultNetwork: "testnet",
  frontend: {
    bindingsOutput: "./bindings"
  },
  contracts: {
    app: {
      path: "./contracts/app",
      wasm: "./contracts/app/target/wasm32v1-none/release/app.wasm"
    }
  },
  networks: {
    testnet: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015"
    }
  }
});
`;
}

export type CreatedProject = { project: ProjectRow; token: string };

/**
 * POST /projects: `ctg init --minimal`, create + fund a Stellar identity named after the
 * project id, persist the project with a hashed token.
 */
export async function createProject(name: string): Promise<CreatedProject> {
  await fsp.mkdir(config.projectsDir, { recursive: true });
  await fsp.mkdir(config.stellarConfigHome, { recursive: true });

  let id = newProjectId();
  while (fs.existsSync(workspaceDir(id))) id = newProjectId();
  const ws = workspaceDir(id);
  const network = config.network;
  const timeoutMs = 120_000;

  try {
    // 1. Workspace scaffold (creates <projectsDir>/<id>).
    await ctgOrThrow(["init", id, "--minimal"], { cwd: config.projectsDir, timeoutMs });

    // 2. Make @caatinga/* resolvable from the workspace without a per-project npm install.
    await fsp.symlink(SERVICE_NODE_MODULES, path.join(ws, "node_modules"), "dir");

    // 3. Replace config: testnet only, bindings enabled, project name.
    await fsp.writeFile(path.join(ws, CONFIG_FILE), configTemplate(name), "utf8");

    // 4. Identity alias == project id. Never a raw key: ctg deploy will use `--source <id>`.
    await stellarOrThrow(["keys", "generate", id, "--network", network], { cwd: ws, timeoutMs });
    await fundWithRetry(id, ws, network);
    const addr = await stellarOrThrow(["keys", "address", id], { cwd: ws, timeoutMs: 30_000 });
    const address = /\b(G[A-Z2-7]{55})\b/.exec(addr.logs)?.[1];
    if (!address) throw new Error(`could not read address for identity ${id}`);

    // 5. Persist (token stored hashed).
    const token = newProjectToken();
    const project: ProjectRow = {
      id,
      name,
      token_hash: hashToken(token),
      network,
      source: id,
      address,
      created_at: now(),
    };
    insertProject(project);
    return { project, token };
  } catch (err) {
    await fsp.rm(ws, { recursive: true, force: true }).catch(() => {});
    await removeIdentity(id).catch(() => {});
    const message = err instanceof CommandError ? err.message : (err as Error).message;
    console.error(`[projects] create failed for ${id}: ${message}`);
    throw new HTTPException(502, { message: `project setup failed: ${message}` });
  }
}

async function fundWithRetry(alias: string, cwd: string, network: string): Promise<void> {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await stellar(["keys", "fund", alias, "--network", network], { cwd, timeoutMs: 60_000 });
    if (res.code === 0) return;
    last = res.logs.trim().split("\n").pop() ?? "";
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw new Error(`friendbot funding failed: ${last}`);
}

async function removeIdentity(alias: string): Promise<void> {
  const file = path.join(config.stellarConfigHome, "stellar", "identity", `${alias}.toml`);
  await fsp.rm(file, { force: true });
}
