import type { Db } from "../db/client.js";
import { alerts, auditLog, cprRequests, cropCycles, cycleInsurers, events, farms, importBatches, plots } from "../db/schema.js";
import { seedScenario, type SeedResult } from "../seed/scenario.js";

/**
 * Removes every farm, plot, crop cycle, event, alert and import, then seeds the demo story
 * again. Organizations, users (memberships) and uploaded files are kept, so people stay
 * logged in and linked to their organization. Pass a new `run` whenever a real chain
 * already holds the previous run's anchors.
 */
export async function resetDemo(db: Db, opts: { now: Date; toleranceBps: number; run: string }): Promise<SeedResult> {
  await db.transaction(async (tx) => {
    // Children before parents (foreign keys).
    for (const table of [alerts, events, cycleInsurers, cprRequests, importBatches, auditLog, cropCycles, plots, farms]) {
      await tx.delete(table);
    }
  });
  return seedScenario(db, opts);
}
