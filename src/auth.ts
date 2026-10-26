import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { config } from "./config.js";
import { getProjectByTokenHash, type ProjectRow } from "./db.js";

export type AuthEnv = { Variables: { project: ProjectRow } };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newProjectToken(): string {
  return `pt_${randomBytes(24).toString("base64url")}`;
}

function bearer(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new HTTPException(401, { message: "missing bearer token" });
  return m[1]!;
}

function safeEqual(a: string, b: string): boolean {
  const ha = hashToken(a);
  const hb = hashToken(b);
  return timingSafeEqual(Buffer.from(ha), Buffer.from(hb));
}

/** Only the master token may create projects. */
export const requireMaster: MiddlewareHandler = async (c, next) => {
  const token = bearer(c);
  if (!safeEqual(token, config.masterToken)) {
    throw new HTTPException(401, { message: "invalid token" });
  }
  await next();
};

/**
 * Project token auth. Sets `project` on the context. When the route carries an `:id`
 * param, the token must belong to that project (otherwise 404, to avoid leaking ids).
 */
export const requireProject: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token.startsWith("pt_")) throw new HTTPException(401, { message: "invalid token" });
  const project = getProjectByTokenHash(hashToken(token));
  if (!project) throw new HTTPException(401, { message: "invalid token" });
  const id = c.req.param("id");
  if (id !== undefined && id !== project.id) {
    throw new HTTPException(404, { message: "project not found" });
  }
  c.set("project", project);
  await next();
};
