import { closeDatabase } from "../config/database";
import { marketDataService } from "../services/marketDataService";

async function main(): Promise<void> {
  const result = await marketDataService.refreshMarketData();
  console.log(`Price refresh complete. Updated ${result.updated} symbols.`);
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
