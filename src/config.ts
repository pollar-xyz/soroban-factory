import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");

export const config = {
  port: int("PORT", 3000),
  dataDir,
  projectsDir: path.join(dataDir, "projects"),
  cargoCacheDir: path.join(dataDir, "cargo-cache"),
  stellarConfigHome: path.join(dataDir, "stellar-config"),
  dbPath: path.join(dataDir, "db.sqlite"),
  masterToken: process.env.MASTER_TOKEN ?? "",
  network: process.env.NETWORK ?? "testnet",
  jobConcurrency: int("JOB_CONCURRENCY", 2),
  jobTimeoutMs: int("JOB_TIMEOUT_MS", 10 * 60 * 1000),
  logMaxBytes: int("LOG_MAX_BYTES", 50 * 1024),
} as const;

export function assertConfig(): void {
  if (!config.masterToken || config.masterToken.length < 16) {
    throw new Error("MASTER_TOKEN must be set and at least 16 characters long");
  }
  if (config.network !== "testnet") {
    throw new Error(`Only testnet is supported (NETWORK=${config.network})`);
  }
}
