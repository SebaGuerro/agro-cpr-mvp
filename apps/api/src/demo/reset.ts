import { loadEnv } from "../config.js";
import { createDb } from "../db/client.js";
import { SEED } from "../seed/scenario.js";
import { resetDemo } from "./resetDemo.js";

// Puts the database back to the demo story (see resetDemo).
//
//   npm run demo:reset -w @agro-cpr/api -- --yes
//
// On Base Sepolia the previous run is already anchored, so the new run gets fresh ids for
// plots, events and claims (new CPR tokens on the explorer). Give the relayer a few minutes
// to anchor the ~40 seeded events before the demo.

if (!process.argv.includes("--yes")) {
  console.error("This deletes all farms, plots, cycles, events, alerts and imports. Re-run with --yes to confirm.");
  process.exit(1);
}

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
const target = env.DATABASE_URL.startsWith("pglite:") ? env.DATABASE_URL : new URL(env.DATABASE_URL).hostname;
console.log(`Resetting the demo data in ${target} (chain: ${env.CHAIN_MODE})`);

await handle.migrate();
// Fixed ids with the in-memory mock chain; fresh ids whenever a real chain holds the previous run.
const run = env.CHAIN_MODE === "mock" ? "" : new Date().toISOString();
const result = await resetDemo(handle.db, { now: new Date(), toleranceBps: env.DELIVERY_TOLERANCE_BPS, run });
console.log("Demo data restored.", { run: run || "fixed ids", ...result });
if (env.AUTH_MODE === "dev") {
  console.log("\nDev users (sign in with these on the login screen):");
  for (const [name, userId] of Object.entries(SEED.users)) console.log(`  ${name.padEnd(12)} ${userId}`);
}
await handle.close();
