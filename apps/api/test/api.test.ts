import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { devVerifier } from "../src/auth.js";
import { LedgerKeys } from "../src/chain/ledger.js";
import { createMockChain } from "../src/chain/mock.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { anchorPending, reconcileAnchors } from "../src/jobs/anchor.js";
import { SEED, seedId, seedScenario, type SeedResult } from "../src/seed/scenario.js";
import { memoryStorage } from "../src/storage.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const now = () => NOW;
const keys = new LedgerKeys("test-secret-test-secret-test-secret-00");
const chain = createMockChain();

let handle: DbHandle;
let app: FastifyInstance;
let seed: SeedResult;

type Who = keyof typeof SEED.users;
const auth = (who: Who) => ({ authorization: `Bearer dev:${SEED.users[who]}` });
async function call(who: Who, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: auth(who), payload: payload as object | undefined });
  return { status: res.statusCode, body: res.json() as any };
}

beforeAll(async () => {
  handle = createDb("pglite:memory");
  await handle.migrate();
  seed = await seedScenario(handle.db, { now: NOW, toleranceBps: 200 });
  app = await buildApp({ db: handle.db, verify: devVerifier, storage: memoryStorage(), keys, now, toleranceBps: 200, corsOrigins: ["*"] });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

describe("auth", () => {
  it("rejects requests without a valid token or membership", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    const unknown = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer dev:${seedId(999)}` } });
    expect(unknown.statusCode).toBe(403);
  });

  it("returns the caller's org and role", async () => {
    const { body } = await call("producerPR", "GET", "/v1/me");
    expect(body).toMatchObject({ orgId: SEED.orgs.producerPR, orgName: "Sítio Santa Rita", role: "PRODUCER" });
  });
});

describe("seeded scenario", () => {
  it("shows the short delivery: 3 trucks, 96.8% fulfilled, still DELIVERING", async () => {
    const { status, body } = await call("financier", "GET", `/v1/crop-cycles/${seed.shortfallCycleId}`);
    expect(status).toBe(200);
    expect(body.stage).toBe("DELIVERING");
    expect(body.potentialKg).toBe(432_000);
    expect(body.eligibleKg).toBe(345_600);
    expect(body.fulfillment).toEqual({ pledgedKg: 108_000, deliveredNetKg: 104_562, fulfilledBps: 9_681, trucksInTransit: 0 });
    expect(body.cpr.tokenId).toBe(keys.tokenId(SEED.plots.pr1, "2025/26-SAFRA"));
  });

  it("grades planting before the window as D, with the reasons", async () => {
    const { body } = await call("financier", "GET", `/v1/crop-cycles/${seed.outsideWindowCycleId}/risk`);
    expect(body.grade).toBe("D");
    const codes = body.dimensions.flatMap((d: any) => d.reasons.map((r: any) => r.code));
    expect(codes).toEqual(expect.arrayContaining(["PLANTED_OUTSIDE_WINDOW", "APPLICATION_MISSING"]));
  });

  it("raises the expected alerts", async () => {
    const { body } = await call("financier", "GET", "/v1/alerts");
    const types = body.map((a: any) => a.type);
    expect(types).toEqual(
      expect.arrayContaining(["DELIVERY_SHORTFALL", "QUALITY_TICKET_MISMATCH", "CPR_DUE_SOON", "PLANTED_OUTSIDE_WINDOW", "APPLICATION_MISSING", "INFO_REQUEST_OPEN"]),
    );
    // The fungicide was corrected into its period, so it is not late.
    expect(types).not.toContain("APPLICATION_LATE");
  });

  it("links the correction in the timeline", async () => {
    const { body } = await call("producerPR", "GET", `/v1/crop-cycles/${seed.shortfallCycleId}/timeline`);
    const original = body.events.find((e: any) => e.id === seed.eventIds.fungicideOriginal);
    expect(original.correctedBy).toEqual([seed.eventIds.fungicideCorrection]);
    expect(body.planned.deliveryWindowEnd).toBe("2026-03-31");
  });

  it("scopes visibility by organization", async () => {
    expect((await call("producerMT", "GET", `/v1/crop-cycles/${seed.shortfallCycleId}`)).status).toBe(404);
    expect((await call("producerMT", "GET", "/v1/crop-cycles")).body.items).toHaveLength(1);
    expect((await call("financier", "GET", "/v1/crop-cycles")).body.items).toHaveLength(2);
    expect((await call("buyer", "GET", "/v1/crop-cycles")).body.items).toHaveLength(1);
    const arrivals = await call("warehouse", "GET", `/v1/warehouses/${SEED.orgs.warehouse}/expected-arrivals`);
    expect(arrivals.body).toEqual([]);
  });
});

describe("POST /v1/events", () => {
  const dispatch = (overrides: Record<string, unknown> = {}) => ({
    id: seedId(5001),
    subjectType: "CROP_CYCLE",
    subjectId: seed.shortfallCycleId,
    actorRole: "PRODUCER",
    actorOrgId: SEED.orgs.producerPR,
    occurredAt: "2026-10-27T08:00:00-03:00",
    eventType: "TRUCK_DISPATCHED",
    quantity: 3_000,
    unit: "KG",
    evidenceHash: null,
    refEventId: null,
    payload: { deliveryId: seedId(7001), truckPlate: "XYZ1A23", warehouseOrgId: SEED.orgs.warehouse, expectedArrivalAt: "2026-10-27T14:00:00-03:00" },
    ...overrides,
  });

  it("rejects a truck sent to a warehouse other than the CPR's", async () => {
    const res = await call("producerPR", "POST", "/v1/events", dispatch({ payload: { ...dispatch().payload, warehouseOrgId: SEED.orgs.buyer } }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("WRONG_WAREHOUSE");
  });

  it("rejects the wrong role and another producer's cycle", async () => {
    expect((await call("buyer", "POST", "/v1/events", dispatch())).body.code).toBe("FORBIDDEN_ROLE");
    const otherProducer = dispatch({ actorOrgId: SEED.orgs.producerMT });
    expect((await call("producerMT", "POST", "/v1/events", otherProducer)).body.code).toBe("FORBIDDEN_ORG");
  });

  it("is idempotent on the event id and rejects a changed resubmission", async () => {
    const first = await call("producerPR", "POST", "/v1/events", dispatch());
    expect(first.status).toBe(201);
    expect(first.body.anchor.status).toBe("PENDING");
    const again = await call("producerPR", "POST", "/v1/events", dispatch());
    expect(again.status).toBe(200);
    expect(again.body.anchor.recordHash).toBe(first.body.anchor.recordHash);
    const changed = await call("producerPR", "POST", "/v1/events", dispatch({ quantity: 4_000 }));
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("EVENT_ID_CONFLICT");
  });

  it("refuses CPR_ISSUED outside the approval flow and evidence that wasn't uploaded", async () => {
    const res = await call("producerPR", "POST", "/v1/events", dispatch({ id: seedId(5002), evidenceHash: "a".repeat(64), payload: { ...dispatch().payload, deliveryId: seedId(7002) } }));
    expect(res.body.code).toBe("EVIDENCE_REQUIRED");

    const timeline = await call("financier", "GET", `/v1/crop-cycles/${seed.outsideWindowCycleId}/timeline`);
    const issued = timeline.body.events.find((e: any) => e.eventType === "CPR_ISSUED");
    const { anchor: _a, voided: _v, correctedBy: _c, recordedAt: _r, recordedBy: _b, ...replay } = issued;
    const direct = await call("financier", "POST", "/v1/events", { ...replay, id: seedId(5005) });
    expect(direct.status).toBe(422);
    expect(direct.body.detail).toMatch(/approving a CPR request/);
  });

  it("lets the warehouse void the stray truck only through an admin", async () => {
    const voidIt = { id: seedId(5003), subjectType: "CROP_CYCLE", subjectId: seed.shortfallCycleId, actorRole: "ADMIN", actorOrgId: SEED.orgs.platform, occurredAt: "2026-10-27T09:00:00-03:00", eventType: "EVENT_VOIDED", quantity: null, unit: null, evidenceHash: null, refEventId: seedId(5001), payload: { reason: "Caminhão lançado por engano" } };
    expect((await call("warehouse", "POST", "/v1/events", { ...voidIt, actorRole: "WAREHOUSE", actorOrgId: SEED.orgs.warehouse })).body.code).toBe("FORBIDDEN_ROLE");
    const res = await call("admin", "POST", "/v1/events", voidIt);
    expect(res.status).toBe(201);
    const cycle = await call("financier", "GET", `/v1/crop-cycles/${seed.shortfallCycleId}`);
    expect(cycle.body.fulfillment.trucksInTransit).toBe(0);
  });

  it("settles the short CPR with cash and clears the shortfall alert", async () => {
    const settle = { id: seedId(5004), subjectType: "CROP_CYCLE", subjectId: seed.shortfallCycleId, actorRole: "FINANCIER", actorOrgId: SEED.orgs.financier, occurredAt: "2026-10-27T10:00:00-03:00", eventType: "CPR_SETTLED", quantity: 104_562, unit: "KG", evidenceHash: null, refEventId: null, payload: { outcome: "PARTIALLY_DELIVERED_CASH_SETTLED", settledOn: "2026-10-27", cashSettledBrlCents: 687_600 } };
    const res = await call("financier", "POST", "/v1/events", settle);
    expect(res.status).toBe(201);
    const cycle = await call("financier", "GET", `/v1/crop-cycles/${seed.shortfallCycleId}`);
    expect(cycle.body.stage).toBe("CLOSED");
    expect(cycle.body.cpr.status).toBe("SETTLED");
    const alerts = await call("financier", "GET", `/v1/alerts?cycleId=${seed.shortfallCycleId}`);
    expect(alerts.body.map((a: any) => a.type)).not.toContain("DELIVERY_SHORTFALL");
  });
});

describe("crop cycles and CPR requests", () => {
  let cycleId: string;

  it("computes potential and eligible volume for a new cycle", async () => {
    const res = await call("producerMT", "POST", "/v1/crop-cycles", { plotId: SEED.plots.mt2, crop: "SOJA", seasonCode: "2026/27-SAFRA", expectedYieldKgPerHa: 3_600 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ potentialKg: 1_080_000, eligibleKg: 864_000, stage: "CREATED", cpr: { status: "NONE" } });
    cycleId = res.body.id;
    const dup = await call("producerMT", "POST", "/v1/crop-cycles", { plotId: SEED.plots.mt2, crop: "SOJA", seasonCode: "2026/27-SAFRA", expectedYieldKgPerHa: 3_000 });
    expect(dup.body.code).toBe("CYCLE_ALREADY_EXISTS");
  });

  it("blocks requests above the eligible volume, then issues one CPR on approval", async () => {
    const request = { cropCycleId: cycleId, requestedKg: 900_000, warehouseOrgId: SEED.orgs.warehouse, financierOrgId: SEED.orgs.financier, dueDate: "2027-05-31" };
    expect((await call("producerMT", "POST", "/v1/cpr-requests", request)).body.code).toBe("ISSUED_ABOVE_ELIGIBLE");
    const created = await call("producerMT", "POST", "/v1/cpr-requests", { ...request, requestedKg: 800_000 });
    expect(created.status).toBe(201);

    const approval = { eventId: seedId(5100), cprNumber: "CPR-2026-0003", issuedKg: 800_000, deliveryWindowStart: "2027-02-01", deliveryWindowEnd: "2027-03-31" };
    expect((await call("producerMT", "POST", `/v1/cpr-requests/${created.body.id}/approve`, approval)).body.code).toBe("FORBIDDEN_ROLE");
    const approved = await call("financier", "POST", `/v1/cpr-requests/${created.body.id}/approve`, approval);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("APPROVED");
    expect(approved.body.issuedEvent.eventType).toBe("CPR_ISSUED");

    const again = await call("producerMT", "POST", "/v1/cpr-requests", { ...request, requestedKg: 100_000 });
    expect(again.body.code).toBe("CPR_ALREADY_EXISTS");
  });
});

describe("files", () => {
  it("stores evidence by SHA-256 and accepts events that reference it", async () => {
    const boundary = "----agro";
    const content = "nota fiscal de teste";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="nf.pdf"\r\nContent-Type: application/pdf\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...auth("producerMT"), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const file = res.json();
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.sizeBytes).toBe(content.length);
  });
});

describe("anchoring", () => {
  it("anchors every event in order and the on-chain hash chains match the database", async () => {
    let total = 0;
    for (;;) {
      const r = await anchorPending(handle.db, chain, keys, { now, limit: 50 });
      expect(r.failed).toBe(0);
      total += r.anchored;
      if (r.anchored === 0) break;
    }
    // 4 plot events + 22 (PR cycle) + 5 (MT cycle) + 4 recorded by the tests above.
    expect(total).toBe(35);
    const result = await reconcileAnchors(handle.db, chain, keys, { now });
    expect(result.mismatches).toEqual([]);
    expect(result.subjects).toBe(6); // 3 plots + 3 crop cycles

    const ev = await call("producerPR", "GET", `/v1/events/${seed.eventIds.fungicideCorrection}`);
    expect(ev.body.anchor.status).toBe("ANCHORED");
    expect(ev.body.anchor.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("detects history that differs from the chain", async () => {
    chain.reset();
    const result = await reconcileAnchors(handle.db, chain, keys, { now });
    expect(result.mismatches.length).toBe(6);
  });
});
