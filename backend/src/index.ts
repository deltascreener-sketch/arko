import cors from "cors";
import express from "express";

import { buildRouter } from "./api/routes";
import { closeDatabase } from "./config/database";
import { env } from "./config/env";
import { startScheduler } from "./jobs/scheduler";

async function main(): Promise<void> {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(buildRouter());

  const server = app.listen(env.PORT, () => {
    console.log(`Backend listening on port ${env.PORT}.`);
  });

  if (env.RUN_SCHEDULER) {
    startScheduler();
    console.log(`Scheduler enabled with timezone ${env.CRON_TIMEZONE}.`);
  }

  const shutdown = async (): Promise<void> => {
    server.close();
    await closeDatabase();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

void main().catch(async (error) => {
  console.error(error);
  await closeDatabase();
  process.exit(1);
});
