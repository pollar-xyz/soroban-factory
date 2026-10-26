import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireMaster, requireProject, type AuthEnv } from "./auth.js";
import { ctgVersion } from "./ctg.js";
import { getJob, getLastJob, parseJobId } from "./db.js";
import { enqueueJob, jobView, ProjectBusyError, queueStats } from "./jobs.js";
import { createProject } from "./projects.js";
import { listContracts, readArtifacts, readBindings, readFile, workspaceDir, writeFiles } from "./workspace.js";

export const app = new Hono<AuthEnv>();

// ---------- schemas ----------
const ProjectName = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "name must be alphanumeric with - or _");
const CreateProjectBody = z.object({ name: ProjectName });
const FilesBody = z.object({
  files: z
    .array(z.object({ path: z.string().min(1).max(512), content: z.string().max(1_000_000) }))
    .min(1)
    .max(200),
});
const DeployBody = z.object({ upgrade: z.boolean().default(false), generate: z.boolean().default(true) });

async function parseBody<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>, optional = false): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    if (optional) raw = {};
    else throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, { message: `invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
  }
  return parsed.data;
}

// ---------- health ----------
app.get("/health", async (c) => {
  return c.json({ ok: true, ctg: await ctgVersion(), queue: queueStats() });
});

// ---------- projects ----------
app.post("/projects", requireMaster, async (c) => {
  const body = await parseBody(c, CreateProjectBody);
  const { project, token } = await createProject(body.name);
  return c.json(
    { id: project.id, token, network: project.network, source: project.source, address: project.address },
    201,
  );
});

app.use("/projects/:id", requireProject);
app.use("/projects/:id/*", requireProject);
app.use("/projects/:id/files", bodyLimit({ maxSize: 16 * 1024 * 1024 }));

app.get("/projects/:id", (c) => {
  const project = c.get("project");
  const ws = workspaceDir(project.id);
  const last = getLastJob(project.id);
  return c.json({
    id: project.id,
    name: project.name,
    network: project.network,
    source: project.source,
    address: project.address,
    createdAt: project.created_at,
    contracts: listContracts(ws, project.network),
    lastJob: last ? jobView(last) : null,
  });
});

app.put("/projects/:id/files", async (c) => {
  const project = c.get("project");
  const body = await parseBody(c, FilesBody);
  const written = await writeFiles(workspaceDir(project.id), body.files);
  return c.json({ written });
});

app.get("/projects/:id/files", async (c) => {
  const project = c.get("project");
  const p = c.req.query("path");
  if (!p) throw new HTTPException(400, { message: "missing ?path=" });
  const content = await readFile(workspaceDir(project.id), p);
  return c.json({ path: p, content });
});

// ---------- jobs ----------
function enqueueOr409(c: { get: (k: "project") => AuthEnv["Variables"]["project"]; json: (o: unknown, s: 202 | 409) => Response }, type: "build" | "deploy", opts: { upgrade: boolean; generate: boolean }): Response {
  const project = c.get("project");
  try {
    const job = enqueueJob(project, type, opts);
    return c.json({ jobId: `j_${job.id}`, status: job.status }, 202);
  } catch (err) {
    if (err instanceof ProjectBusyError) {
      return c.json({ error: "project_busy", jobId: `j_${err.job.id}`, status: err.job.status }, 409);
    }
    throw err;
  }
}

app.post("/projects/:id/build", (c) => enqueueOr409(c, "build", { upgrade: false, generate: false }));

app.post("/projects/:id/deploy", async (c) => {
  const body = await parseBody(c, DeployBody, true);
  return enqueueOr409(c, "deploy", body);
});

app.get("/jobs/:jobId", requireProject, (c) => {
  const project = c.get("project");
  const id = parseJobId(c.req.param("jobId"));
  const job = id === null ? undefined : getJob(id);
  if (!job || job.project_id !== project.id) throw new HTTPException(404, { message: "job not found" });
  return c.json(jobView(job));
});

// ---------- results ----------
app.get("/projects/:id/artifacts", (c) => {
  const project = c.get("project");
  const artifacts = readArtifacts(workspaceDir(project.id));
  if (!artifacts) throw new HTTPException(404, { message: "artifacts not found" });
  return c.json(artifacts);
});

app.get("/projects/:id/bindings", async (c) => {
  const project = c.get("project");
  return c.json({ files: await readBindings(workspaceDir(project.id)) });
});

// ---------- errors ----------
app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});
