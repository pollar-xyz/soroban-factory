import fs from "node:fs";
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { assertConfig, config } from "./config.js";
import { failInterruptedJobs } from "./db.js";
import { ctgVersion } from "./ctg.js";

assertConfig();
for (const dir of [config.projectsDir, config.cargoCacheDir, config.stellarConfigHome]) {
  fs.mkdirSync(dir, { recursive: true });
}

const interrupted = failInterruptedJobs();
if (interrupted > 0) console.warn(`[boot] marked ${interrupted} interrupted job(s) as failed`);

const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, async (info) => {
  console.log(`soroban-factory listening on :${info.port} (data: ${config.dataDir}, ctg: ${await ctgVersion()})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[boot] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
