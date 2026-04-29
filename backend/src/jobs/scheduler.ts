import cron from "node-cron";

import { env } from "../config/env";
import { fundamentalsService } from "../services/fundamentalsService";
import { marketDataService } from "../services/marketDataService";
import { universeService } from "../services/universeService";

function guardedJob(name: string, fn: () => Promise<unknown>): () => Promise<void> {
  let running = false;

  return async () => {
    if (running) {
      console.warn(`[scheduler] Skipping ${name}; previous run still in progress.`);
      return;
    }

    running = true;
    try {
      console.log(`[scheduler] Starting ${name}.`);
      await fn();
      console.log(`[scheduler] Finished ${name}.`);
    } catch (error) {
      console.error(`[scheduler] ${name} failed.`, error);
    } finally {
      running = false;
    }
  };
}

export function startScheduler(): void {
  cron.schedule("0 */6 * * *", guardedJob("batchPriceUpdate", () => marketDataService.refreshMarketData()), {
    timezone: env.CRON_TIMEZONE
  });

  cron.schedule("30 2 * * *", guardedJob("batchFundamentalUpdate", () => fundamentalsService.refreshOutdatedFundamentals()), {
    timezone: env.CRON_TIMEZONE
  });

  cron.schedule("0 1 * * *", guardedJob("syncUniverse", () => universeService.syncUniverse()), {
    timezone: env.CRON_TIMEZONE
  });
}

if (require.main === module) {
  startScheduler();
  console.log(`Scheduler started in timezone ${env.CRON_TIMEZONE}.`);
}
