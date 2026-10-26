import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import { config } from "./config.js";

export const CONTRACTS_DIR = "contracts";
export const CONFIG_FILE = "caatinga.config.ts";
export const ARTIFACTS_FILE = "caatinga.artifacts.json";
export const BINDINGS_DIR = "bindings";

export function workspaceDir(projectId: string): string {
  return path.join(config.projectsDir, projectId);
}

/**
 * Validate a client-supplied relative path. Allowed: `caatinga.config.ts` and anything under
 * `contracts/` except build output (`target/`). Rejects absolute paths, `..`, backslashes, NULs.
 */
export function validateRelPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) bad(raw);
  if (raw.includes("\0") || raw.includes("\\")) bad(raw);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) bad(raw);
  const segments = raw.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) bad(raw);
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw) bad(raw);
  if (normalized === CONFIG_FILE) return normalized;
  if (segments[0] !== CONTRACTS_DIR || segments.length < 2) bad(raw);
  if (segments.includes("target") || segments.includes("node_modules")) bad(raw);
  if (segments.some((s) => s.startsWith(".") )) bad(raw);
  return normalized;
}

function bad(p: unknown): never {
  throw new HTTPException(422, { message: `path not allowed: ${String(p).slice(0, 200)}` });
}

/** Absolute path inside the workspace; double-checks containment after resolution. */
export function resolveInside(ws: string, rel: string): string {
  const abs = path.resolve(ws, rel);
  const root = path.resolve(ws) + path.sep;
  if (!abs.startsWith(root)) bad(rel);
  return abs;
}

export async function writeFiles(ws: string, files: { path: string; content: string }[]): Promise<number> {
  const planned = files.map((f) => ({ rel: validateRelPath(f.path), content: f.content }));
  const realRoot = await fsp.realpath(ws);
  for (const f of planned) {
    const abs = resolveInside(ws, f.rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // Guard against symlinked directories escaping the workspace.
    const realDir = await fsp.realpath(path.dirname(abs));
    if (!(realDir + path.sep).startsWith(realRoot + path.sep)) bad(f.rel);
    const tmp = `${abs}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, f.content, "utf8");
    await fsp.rename(tmp, abs);
  }
  return planned.length;
}

export async function readFile(ws: string, rawPath: string): Promise<string> {
  const rel = validateRelPath(rawPath);
  const abs = resolveInside(ws, rel);
  try {
    const st = await fsp.lstat(abs);
    if (!st.isFile()) throw new HTTPException(404, { message: "file not found" });
    return await fsp.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HTTPException(404, { message: "file not found" });
    }
    throw err;
  }
}

export type ArtifactsFile = {
  project?: string;
  version?: number;
  networks?: Record<string, { contracts?: Record<string, { contractId?: string; wasmHash?: string }> }>;
};

export function readArtifacts(ws: string): ArtifactsFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(ws, ARTIFACTS_FILE), "utf8")) as ArtifactsFile;
  } catch {
    return null;
  }
}

export function deployedContracts(ws: string, network: string): Record<string, { contractId: string; wasmHash: string }> {
  const out: Record<string, { contractId: string; wasmHash: string }> = {};
  const contracts = readArtifacts(ws)?.networks?.[network]?.contracts ?? {};
  for (const [name, c] of Object.entries(contracts)) {
    if (c?.contractId) out[name] = { contractId: c.contractId, wasmHash: c.wasmHash ?? "" };
  }
  return out;
}

export type ContractStatus = "pending" | "built" | "deployed";

/**
 * Contracts known to the workspace. We deliberately do not evaluate `caatinga.config.ts`
 * in-process (it is client-supplied code); instead we list `contracts/<name>/Cargo.toml`
 * directories and merge in what the artifacts file says was deployed.
 */
export function listContracts(ws: string, network: string): { name: string; status: ContractStatus; contractId?: string; wasmHash?: string }[] {
  const names = new Set<string>();
  const contractsRoot = path.join(ws, CONTRACTS_DIR);
  if (fs.existsSync(contractsRoot)) {
    for (const entry of fs.readdirSync(contractsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(contractsRoot, entry.name, "Cargo.toml"))) {
        names.add(entry.name);
      }
    }
  }
  const deployed = deployedContracts(ws, network);
  for (const n of Object.keys(deployed)) names.add(n);
  return [...names].sort().map((name) => {
    const d = deployed[name];
    if (d) return { name, status: "deployed" as const, contractId: d.contractId, wasmHash: d.wasmHash };
    const wasmDir = path.join(contractsRoot, name, "target", "wasm32v1-none", "release");
    const built = fs.existsSync(wasmDir) && fs.readdirSync(wasmDir).some((f) => f.endsWith(".wasm"));
    return { name, status: built ? ("built" as const) : ("pending" as const) };
  });
}

/** Relative paths of every `contracts/<name>` directory that has a Cargo.toml. */
export function contractDirs(ws: string): string[] {
  const root = path.join(ws, CONTRACTS_DIR);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "Cargo.toml")))
    .map((e) => path.posix.join(CONTRACTS_DIR, e.name))
    .sort();
}

/** All text files under bindings/, relative paths, skipping dotfiles and node_modules. */
export async function readBindings(ws: string): Promise<{ path: string; content: string }[]> {
  const root = path.join(ws, BINDINGS_DIR);
  if (!fs.existsSync(root)) return [];
  const out: { path: string; content: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) {
        out.push({ path: path.relative(ws, abs).split(path.sep).join("/"), content: await fsp.readFile(abs, "utf8") });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
