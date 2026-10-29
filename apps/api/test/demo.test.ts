import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LedgerKeys } from "../src/chain/ledger.js";
import { createMockChain } from "../src/chain/mock.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { events, memberships, orgs, plots } from "../src/db/schema.js";
import { resetDemo } from "../src/demo/resetDemo.js";
import { anchorPending, reconcileAnchors } from "../src/jobs/anchor.js";
import { SEED, seedScenario } from "../src/seed/scenario.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const keys = new LedgerKeys("test-secret-test-secret-test-secret-00");
let handle: DbHandle;

async function anchorAll(chain: ReturnType<typeof createMockChain>) {
  for (let r = { anchored: 1, failed: 0 }; r.anchored > 0; ) {
    r = await anchorPending(handle.db, chain, keys, { now: () => NOW, limit: 200 });
    expect(r.failed).toBe(0);
  }
}

beforeAll(async () => {
  handle = createDb("pglite:memory");
  await handle.migrate();
  await seedScenario(handle.db, { now: NOW, toleranceBps: 200 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe("demo reset", () => {
  it("reseeds on the same chain without colliding with what the previous run anchored", async () => {
    // One chain for both runs, like Base Sepolia across rehearsals.
    const chain = createMockChain();
    await anchorAll(chain);

    await resetDemo(handle.db, { now: NOW, toleranceBps: 200, run: "rehearsal-2" });
    const plotIds = (await handle.db.select().from(plots)).map((p) => p.id);
    expect(plotIds).toHaveLength(3);
    expect(plotIds).not.toContain(SEED.plots.pr1);

    // Orgs and logins survive; nothing is duplicated.
    expect(await handle.db.select().from(orgs)).toHaveLength(7);
    expect(await handle.db.select().from(memberships)).toHaveLength(7);

    await anchorAll(chain);
    expect((await handle.db.select().from(events)).every((e) => e.anchorStatus === "ANCHORED")).toBe(true);
    const result = await reconcileAnchors(handle.db, chain, keys, { now: () => NOW });
    expect(result.mismatches).toEqual([]);
  });
});
