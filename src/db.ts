import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type ProjectRow = {
  id: string;
  name: string;
  token_hash: string;
  network: string;
  source: string;
  address: string;
  created_at: string;
};

export type JobType = "build" | "deploy";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type JobStep = "build" | "deploy" | "generate";

export type JobRow = {
  id: number;
  project_id: string;
  type: JobType;
  status: JobStatus;
  step: JobStep | null;
  logs: string;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  network    TEXT NOT NULL,
  source     TEXT NOT NULL,
  address    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  type        TEXT NOT NULL,
  status      TEXT NOT NULL,
  step        TEXT,
  logs        TEXT NOT NULL DEFAULT '',
  result      TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`;

export function openDb(dbPath = config.dbPath): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export const db = openDb();

export const now = (): string => new Date().toISOString();

// ---------- projects ----------
const insertProjectStmt = db.prepare<ProjectRow>(
  `INSERT INTO projects (id, name, token_hash, network, source, address, created_at)
   VALUES (@id, @name, @token_hash, @network, @source, @address, @created_at)`,
);
const projectByIdStmt = db.prepare<[string], ProjectRow>(`SELECT * FROM projects WHERE id = ?`);
const projectByTokenHashStmt = db.prepare<[string], ProjectRow>(`SELECT * FROM projects WHERE token_hash = ?`);

export function insertProject(row: ProjectRow): void {
  insertProjectStmt.run(row);
}
export function getProject(id: string): ProjectRow | undefined {
  return projectByIdStmt.get(id);
}
export function getProjectByTokenHash(hash: string): ProjectRow | undefined {
  return projectByTokenHashStmt.get(hash);
}

// ---------- jobs ----------
const insertJobStmt = db.prepare<{ project_id: string; type: JobType; created_at: string }>(
  `INSERT INTO jobs (project_id, type, status, created_at) VALUES (@project_id, @type, 'queued', @created_at)`,
);
const jobByIdStmt = db.prepare<[number], JobRow>(`SELECT * FROM jobs WHERE id = ?`);
const activeJobForProjectStmt = db.prepare<[string], JobRow>(
  `SELECT * FROM jobs WHERE project_id = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`,
);
const lastJobForProjectStmt = db.prepare<[string], JobRow>(
  `SELECT * FROM jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1`,
);
const startJobStmt = db.prepare<[string, number]>(
  `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`,
);
const setStepStmt = db.prepare<[JobStep, number]>(`UPDATE jobs SET step = ? WHERE id = ?`);
const setLogsStmt = db.prepare<[string, number]>(`UPDATE jobs SET logs = ? WHERE id = ?`);
const finishJobStmt = db.prepare<[JobStatus, string, string | null, string | null, string, number]>(
  `UPDATE jobs SET status = ?, logs = ?, result = ?, error = ?, finished_at = ? WHERE id = ?`,
);
const failInterruptedStmt = db.prepare<[string, string]>(
  `UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('queued','running')`,
);

export function createJob(projectId: string, type: JobType): JobRow {
  const info = insertJobStmt.run({ project_id: projectId, type, created_at: now() });
  return jobByIdStmt.get(Number(info.lastInsertRowid))!;
}
export function getJob(id: number): JobRow | undefined {
  return jobByIdStmt.get(id);
}
export function getActiveJob(projectId: string): JobRow | undefined {
  return activeJobForProjectStmt.get(projectId);
}
export function getLastJob(projectId: string): JobRow | undefined {
  return lastJobForProjectStmt.get(projectId);
}
export function markJobRunning(id: number): void {
  startJobStmt.run(now(), id);
}
export function setJobStep(id: number, step: JobStep): void {
  setStepStmt.run(step, id);
}
export function setJobLogs(id: number, logs: string): void {
  setLogsStmt.run(logs, id);
}
export function finishJob(
  id: number,
  status: "succeeded" | "failed",
  logs: string,
  result: unknown | null,
  error: { step: JobStep | null; message: string } | null,
): void {
  finishJobStmt.run(
    status,
    logs,
    result === null ? null : JSON.stringify(result),
    error === null ? null : JSON.stringify(error),
    now(),
    id,
  );
}

/** Jobs are held in an in-memory queue; anything left queued/running at boot was interrupted. */
export function failInterruptedJobs(): number {
  const info = failInterruptedStmt.run(
    JSON.stringify({ step: null, message: "service restarted while the job was in progress" }),
    now(),
  );
  return info.changes;
}

export const jobPublicId = (id: number): string => `j_${id}`;
export function parseJobId(raw: string): number | null {
  const m = /^j_(\d{1,12})$/.exec(raw);
  return m ? Number(m[1]) : null;
}
