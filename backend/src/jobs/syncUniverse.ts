import { closeDatabase } from "../config/database";
import { universeService } from "../services/universeService";

async function main(): Promise<void> {
  const result = await universeService.syncUniverse();
  console.log(`Universe sync complete. Eligible symbols: ${result.eligible}.`);
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
