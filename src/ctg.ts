import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

/** Absolute path to the ctg CLI entry point (dist/index.js) shipped with @caatinga/cli. */
export const CTG_BIN: string = fileURLToPath(import.meta.resolve("@caatinga/cli"));

/** Our own node_modules (…/node_modules/@caatinga/cli/dist → up 3), symlinked into every workspace so ctg resolves @caatinga/core there. */
export const SERVICE_NODE_MODULES: string = path.resolve(path.dirname(CTG_BIN), "..", "..", "..");

export type RunOptions = {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Called with the full (truncated) log buffer whenever new output arrives. */
  onLog?: (logs: string) => void;
};

export type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  logs: string;
  durationMs: number;
};

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly result: RunResult,
  ) {
    super(message);
  }
}

/** Keeps the tail of a byte stream, bounded to `max` bytes. */
export class LogBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
    }
    if (this.size > this.max && this.chunks.length === 1) {
      const only = this.chunks[0]!;
      this.chunks = [only.subarray(only.length - this.max)];
      this.size = this.max;
    }
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function toolchainEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const cargoBin = process.env.CARGO_HOME
    ? path.join(process.env.CARGO_HOME, "bin")
    : path.join(process.env.HOME ?? "/root", ".cargo", "bin");
  const basePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return {
    ...process.env,
    PATH: basePath.includes(cargoBin) ? basePath : `${cargoBin}:${basePath}`,
    // Shared crate registry/download cache across all project builds (persisted on the volume).
    CARGO_HOME: config.cargoCacheDir,
    // Stellar CLI identities live under $XDG_CONFIG_HOME/stellar — also on the volume.
    XDG_CONFIG_HOME: config.stellarConfigHome,
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
    ...extra,
  };
}

/** Spawn a process, stream its combined output into a bounded buffer, enforce a timeout. */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? config.jobTimeoutMs;
  const started = Date.now();
  const buf = new LogBuffer(config.logMaxBytes);

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: toolchainEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", // own process group so we can kill cargo & friends
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      buf.append(chunk);
      opts.onLog?.(buf.toString());
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, logs: buf.toString(), durationMs: Date.now() - started });
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Run `ctg <args>` inside a workspace. Resolves even on non-zero exit; inspect `code`. */
export function ctg(args: string[], opts: RunOptions): Promise<RunResult> {
  return run(process.execPath, [CTG_BIN, ...args], opts);
}

/** Run `ctg <args>` and throw a CommandError on failure/timeout. */
export async function ctgOrThrow(args: string[], opts: RunOptions): Promise<RunResult> {
  const res = await ctg(args, opts);
  if (res.timedOut) throw new CommandError(`ctg ${args[0]} timed out after ${opts.timeoutMs ?? config.jobTimeoutMs} ms`, res);
  if (res.code !== 0) throw new CommandError(summarizeFailure(`ctg ${args[0]}`, res.logs), res);
  return res;
}

/** Run the Stellar CLI (only used for identity management; deploys always go through ctg). */
export function stellar(args: string[], opts: RunOptions): Promise<RunResult> {
  return run("stellar", args, opts);
}

export async function stellarOrThrow(args: string[], opts: RunOptions): Promise<RunResult> {
  const res = await stellar(args, opts);
  if (res.timedOut) throw new CommandError(`stellar ${args.join(" ")} timed out`, res);
  if (res.code !== 0) throw new CommandError(summarizeFailure(`stellar ${args[0]} ${args[1] ?? ""}`, res.logs), res);
  return res;
}

let ctgVersionCache: string | null = null;
export async function ctgVersion(): Promise<string | null> {
  if (ctgVersionCache) return ctgVersionCache;
  try {
    const res = await ctg(["--version"], { cwd: config.dataDir, timeoutMs: 30_000 });
    const m = /(\d+\.\d+\.\d+)/.exec(res.logs);
    ctgVersionCache = m?.[1] ?? null;
  } catch {
    ctgVersionCache = null;
  }
  return ctgVersionCache;
}

/**
 * Build a short, actionable error message from a log tail.
 * Prefers rustc errors ("error[E0425]: ... (src/lib.rs:42)"), then ctg's boxed "✖ Error" message,
 * then any generic error line.
 */
export function summarizeFailure(what: string, logs: string): string {
  const lines = logs.split(/\r?\n/);
  const rust = firstRustcError(lines);
  if (rust) return rust;

  const box = lines.findIndex((l) => l.trim() === "✖ Error");
  if (box >= 0) {
    const msg: string[] = [];
    for (let i = box + 1; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (/^─+$/.test(t)) {
        if (msg.length > 0) break;
        continue;
      }
      if (/^(Code|Hint):/.test(t)) break;
      if (t.length === 0) {
        if (msg.length > 0) break;
        continue;
      }
      msg.push(t);
    }
    const code = lines.slice(box).map((l) => /^\s*Code:\s*(\S+)/.exec(l)?.[1]).find(Boolean);
    if (msg.length > 0) return `${msg.join(" ")}${code ? ` [${code}]` : ""}`.slice(0, 500);
  }

  const generic = lines
    .map((l) => l.trim())
    .filter((l) => /^(✖|✗|❌|error|Error|ERROR)(\s|:)/.test(l) && !/warning/i.test(l));
  if (generic.length > 0) return generic[generic.length - 1]!.slice(0, 500);
  const tail = lines.filter((l) => l.trim().length > 0).slice(-3).join(" | ");
  return `${what} failed${tail ? `: ${tail.slice(0, 400)}` : ""}`;
}

/** First rustc diagnostic in the log, with its source location when present. */
export function firstRustcError(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const m = /^(error(\[E\d+\])?: .+)$/.exec(t);
    if (!m || /^error: (could not compile|aborting|failed to|exit status)/i.test(t)) continue;
    let loc = "";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const l = /-->\s+(.+?):(\d+):(\d+)/.exec(lines[j]!);
      if (l) {
        loc = ` (${l[1]}:${l[2]})`;
        break;
      }
    }
    return `${m[1]}${loc}`;
  }
  return null;
}

export const hasRustcError = (logs: string): boolean => firstRustcError(logs.split(/\r?\n/)) !== null;

/**
 * Diagnostics-only fallback. `ctg build` wraps `stellar contract build`, but when rustc output contains
 * phrases like "not found in this scope" Caatinga 3.12 misclassifies the failure as a missing wasm
 * target (CAATINGA_RUST_TARGET_NOT_FOUND) and drops the compiler output. We re-run the exact same
 * command ctg uses, per contract directory, purely to capture the diagnostics. Never used to deploy.
 */
export async function buildDiagnostics(ws: string, contractDirs: string[], timeoutMs: number): Promise<{ dir: string; logs: string } | null> {
  const deadline = Date.now() + timeoutMs;
  for (const dir of contractDirs) {
    const remaining = deadline - Date.now();
    if (remaining < 5_000) return null;
    const res = await run("stellar", ["contract", "build"], { cwd: path.join(ws, dir), timeoutMs: remaining });
    if (res.code !== 0 || res.timedOut) return { dir, logs: res.logs };
  }
  return null;
}
