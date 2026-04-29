import { closeDatabase } from "../config/database";
import { fundamentalsService } from "../services/fundamentalsService";

async function main(): Promise<void> {
  const result = await fundamentalsService.refreshOutdatedFundamentals();
  console.log(`Fundamental refresh complete. Processed ${result.processed} symbols.`);
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
