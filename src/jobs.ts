import PQueue from "p-queue";
import { config } from "./config.js";
import { buildDiagnostics, CommandError, ctgOrThrow, firstRustcError, hasRustcError, LogBuffer } from "./ctg.js";
import {
  createJob,
  finishJob,
  getActiveJob,
  getJob,
  jobPublicId,
  markJobRunning,
  setJobLogs,
  setJobStep,
  type JobRow,
  type JobStep,
  type JobType,
  type ProjectRow,
} from "./db.js";
import { contractDirs, deployedContracts, workspaceDir } from "./workspace.js";

export type DeployOptions = { upgrade: boolean; generate: boolean };

export const queue = new PQueue({ concurrency: config.jobConcurrency });

export class ProjectBusyError extends Error {
  constructor(public readonly job: JobRow) {
    super(`project already has an active job: ${jobPublicId(job.id)}`);
  }
}

/** Enqueue a build/deploy job. Throws ProjectBusyError if the project already has a queued/running job. */
export function enqueueJob(project: ProjectRow, type: JobType, opts: DeployOptions): JobRow {
  // better-sqlite3 is synchronous and Node is single-threaded, so check+insert is atomic per tick.
  const active = getActiveJob(project.id);
  if (active) throw new ProjectBusyError(active);
  const job = createJob(project.id, type);
  void queue.add(() => runJob(job.id, project, type, opts));
  return job;
}

async function runJob(jobId: number, project: ProjectRow, type: JobType, opts: DeployOptions): Promise<void> {
  const ws = workspaceDir(project.id);
  const deadline = Date.now() + config.jobTimeoutMs;
  const remaining = (): number => Math.max(1_000, deadline - Date.now());

  // Combined log of all steps, bounded. `prefix` holds finished steps; the live step is appended on top.
  const combined = new LogBuffer(config.logMaxBytes);
  let step: JobStep | null = null;
  let lastFlush = 0;
  let pendingFlush: NodeJS.Timeout | null = null;
  const currentLogs = (live: string): string => {
    const b = new LogBuffer(config.logMaxBytes);
    b.append(Buffer.from(combined.toString() + live, "utf8"));
    return b.toString();
  };
  const flush = (live: string, force = false): void => {
    const snapshot = currentLogs(live);
    const write = (): void => {
      lastFlush = Date.now();
      pendingFlush = null;
      setJobLogs(jobId, snapshot);
    };
    if (force || Date.now() - lastFlush > 500) {
      if (pendingFlush) clearTimeout(pendingFlush);
      write();
    } else if (!pendingFlush) {
      pendingFlush = setTimeout(write, 500);
    }
  };

  const runStep = async (s: JobStep, args: string[]): Promise<void> => {
    step = s;
    setJobStep(jobId, s);
    combined.append(Buffer.from(`\n$ ctg ${args.join(" ")}\n`, "utf8"));
    flush("", true);
    try {
      const res = await ctgOrThrow(args, { cwd: ws, timeoutMs: remaining(), onLog: (l) => flush(l) });
      combined.append(Buffer.from(res.logs, "utf8"));
    } catch (err) {
      if (err instanceof CommandError) {
        combined.append(Buffer.from(err.result.logs, "utf8"));
        if (s === "build" && !err.result.timedOut && !hasRustcError(err.result.logs)) {
          // ctg swallowed the compiler output (see buildDiagnostics): recover it so the client can fix the code.
          const diag = await buildDiagnostics(ws, contractDirs(ws), remaining());
          if (diag) {
            combined.append(Buffer.from(`\n$ stellar contract build  # diagnostics for ${diag.dir}\n${diag.logs}`, "utf8"));
            const rust = firstRustcError(diag.logs.split(/\r?\n/));
            if (rust) throw new CommandError(rust, err.result);
          }
        }
      }
      throw err;
    }
  };

  markJobRunning(jobId);
  try {
    await runStep("build", ["build"]);
    if (type === "deploy") {
      await runStep("deploy", [
        "deploy",
        "--network", project.network,
        "--source", project.source, // identity alias, never a key
        "--no-generate", "--no-wire", "--no-sync-env",
        opts.upgrade ? "--upgrade" : "--if-changed",
      ]);
      if (opts.generate) await runStep("generate", ["generate", "--network", project.network]);
    }
    if (pendingFlush) clearTimeout(pendingFlush);
    const result = type === "deploy" ? { contracts: deployedContracts(ws, project.network) } : { built: true };
    finishJob(jobId, "succeeded", combined.toString(), result, null);
  } catch (err) {
    if (pendingFlush) clearTimeout(pendingFlush);
    const message = err instanceof Error ? err.message : String(err);
    finishJob(jobId, "failed", combined.toString(), null, { step, message });
  }
}

export function queueStats(): { running: number; pending: number } {
  return { running: queue.pending, pending: queue.size };
}

export function jobView(job: JobRow): Record<string, unknown> {
  return {
    jobId: jobPublicId(job.id),
    projectId: job.project_id,
    type: job.type,
    status: job.status,
    step: job.step,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    logs: job.logs,
    result: job.result ? (JSON.parse(job.result) as unknown) : null,
    error: job.error ? (JSON.parse(job.error) as unknown) : null,
  };
}

export { getJob };
