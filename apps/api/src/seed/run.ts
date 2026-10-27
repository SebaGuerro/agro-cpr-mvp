import { loadEnv } from "../config.js";
import { createDb } from "../db/client.js";
import { orgs } from "../db/schema.js";
import { SEED, seedScenario } from "./scenario.js";

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);

const existing = await handle.db.select({ id: orgs.id }).from(orgs).limit(1);
if (existing.length) {
  console.log("Database already has data; seed skipped.");
} else {
  const result = await seedScenario(handle.db, { now: new Date(), toleranceBps: env.DELIVERY_TOLERANCE_BPS });
  console.log("Seeded.", result);
  if (env.AUTH_MODE === "dev") {
    console.log("\nDev tokens (Authorization: Bearer <token>):");
    for (const [name, userId] of Object.entries(SEED.users)) console.log(`  ${name.padEnd(12)} dev:${userId}`);
  }
}
await handle.close();
