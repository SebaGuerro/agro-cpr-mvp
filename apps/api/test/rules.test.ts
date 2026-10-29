import { CanonicalEvent, type StoredEvent } from "@agro-cpr/spec";
import { describe, expect, it } from "vitest";
import { checklistStatus, type ChecklistTemplate } from "../src/domain/checklist.js";
import { initialCycleState, replayCycle, type ReplayContext } from "../src/domain/cycleState.js";
import { ApiError } from "../src/domain/errors.js";
import { assessRisk, cycleFindings, type FindingInputs } from "../src/domain/findings.js";
import { checkPlanting, windowDates, type PlantingWindow } from "../src/domain/plantingWindow.js";
import { eligibleKg, expectedDiscountKg, isTicketMismatch, potentialKg, type DiscountTable } from "../src/domain/quantities.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CYCLE = uuid(1);
const PRODUCER = uuid(2);
const WAREHOUSE = uuid(3);
const FINANCIER = uuid(4);
const OTHER_WAREHOUSE = uuid(5);

const ctx: ReplayContext = {
  cycle: {
    id: CYCLE,
    plotId: uuid(6),
    producerOrgId: PRODUCER,
    crop: "SOJA",
    seasonCode: "2025/26-SAFRA",
    areaM2: 1_000_000,
    potentialKg: 360_000,
    haircutBps: 8_000,
    eligibleKg: 288_000,
  },
  toleranceBps: 200,
};

let n = 100;
/** Builds a valid stored cycle event; throws if the fields don't match the schema. */
function ev(fields: Record<string, unknown>): StoredEvent {
  const event = CanonicalEvent.parse({
    id: uuid(n++),
    subjectType: "CROP_CYCLE",
    subjectId: CYCLE,
    actorRole: "PRODUCER",
    actorOrgId: PRODUCER,
    occurredAt: "2026-01-10T10:00:00-03:00",
    evidenceHash: null,
    refEventId: null,
    quantity: null,
    unit: null,
    ...fields,
  });
  return { ...event, recordedAt: "2026-01-10T13:00:00Z", recordedBy: uuid(99) };
}

const cprIssued = (issuedKg = 100_000) =>
  ev({
    eventType: "CPR_ISSUED",
    actorRole: "FINANCIER",
    actorOrgId: FINANCIER,
    quantity: issuedKg,
    unit: "KG",
    payload: {
      cprRequestId: uuid(7),
      cprNumber: "CPR-1",
      crop: "SOJA",
      seasonCode: "2025/26-SAFRA",
      potentialKg: 360_000,
      haircutBps: 8_000,
      eligibleKg: 288_000,
      warehouseOrgId: WAREHOUSE,
      financierOrgId: FINANCIER,
      dueDate: "2026-04-30",
      deliveryWindowStart: "2026-02-01",
      deliveryWindowEnd: "2026-03-31",
    },
  });
const planting = (startedOn = "2025-10-10", finishedOn = "2025-10-15") =>
  ev({ eventType: "PLANTING_RECORDED", quantity: 1_000_000, unit: "M2", payload: { crop: "SOJA", cultivar: "X", cycleDays: 115, startedOn, finishedOn } });
const harvestStarted = () => ev({ eventType: "HARVEST_STARTED", payload: { startedOn: "2026-02-03" } });
const dispatched = (deliveryId: string, warehouseOrgId = WAREHOUSE) =>
  ev({ eventType: "TRUCK_DISPATCHED", quantity: 35_000, unit: "KG", payload: { deliveryId, truckPlate: "ABC1D23", warehouseOrgId, expectedArrivalAt: "2026-02-04T13:00:00-03:00" } });
const arrived = (deliveryId: string) =>
  ev({ eventType: "TRUCK_ARRIVED", actorRole: "WAREHOUSE", actorOrgId: WAREHOUSE, payload: { deliveryId, truckPlate: "ABC1D23" } });
const received = (deliveryId: string, grossKg: number, discountKg = 0) =>
  ev({
    eventType: "GRAIN_RECEIVED",
    actorRole: "WAREHOUSE",
    actorOrgId: WAREHOUSE,
    quantity: grossKg - discountKg,
    unit: "KG",
    payload: { deliveryId, ticketNumber: "T", grossKg, moisturePct: 14, impurityPct: 1, damagedPct: 0, discountKg, netKg: grossKg - discountKg },
  });
const truck = (id: string, gross: number) => [dispatched(id), arrived(id), received(id, gross)];

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

describe("quantities", () => {
  it("computes potential from hectares and the eligible volume after the haircut", () => {
    expect(potentialKg(5_000_000, 3_600)).toBe(1_800_000); // 500 ha x 60 sc/ha
    expect(eligibleKg(1_800_000, 8_000)).toBe(1_440_000);
  });

  it("applies the discount table above each base", () => {
    const table: DiscountTable = {
      crop: "SOJA",
      moistureBasePct: 14,
      moistureDiscountPerPointPct: 1.5,
      impurityBasePct: 1,
      impurityDiscountPerPointPct: 1,
      damagedBasePct: 8,
      damagedDiscountPerPointPct: 1,
      isSample: true,
    };
    expect(expectedDiscountKg(33_000, { moisturePct: 16, impurityPct: 1.2, damagedPct: 3 }, table)).toBe(1_056);
    expect(isTicketMismatch(33_000, 1_200, 1_056)).toBe(true);
    expect(isTicketMismatch(33_000, 1_100, 1_056)).toBe(false);
  });
});

describe("planting windows", () => {
  const w = (start: string, end: string): PlantingWindow => ({
    crop: "SOJA",
    season: "SAFRA",
    uf: "MT",
    municipalityIbge: null,
    startMonthDay: start,
    endMonthDay: end,
    source: "test",
    isSample: true,
  });

  it("places windows in the right calendar year of the season", () => {
    expect(windowDates(w("09-16", "12-31"), "2026/27-SAFRA")).toEqual({ start: "2026-09-16", end: "2026-12-31" });
    expect(windowDates(w("01-01", "03-10"), "2026/27-SAFRINHA")).toEqual({ start: "2027-01-01", end: "2027-03-10" });
    expect(windowDates(w("11-15", "02-15"), "2026/27-SAFRA")).toEqual({ start: "2026-11-15", end: "2027-02-15" });
  });

  it("flags planting that starts or finishes outside the window", () => {
    expect(checkPlanting({ startedOn: "2026-09-20", finishedOn: "2026-09-30" }, w("09-16", "12-31"), "2026/27-SAFRA")).toBe("WITHIN");
    expect(checkPlanting({ startedOn: "2026-09-05", finishedOn: "2026-09-20" }, w("09-16", "12-31"), "2026/27-SAFRA")).toBe("OUTSIDE");
    expect(checkPlanting({ startedOn: "2026-09-20", finishedOn: "2026-09-30" }, null, "2026/27-SAFRA")).toBe("NO_WINDOW");
  });
});

describe("input checklist", () => {
  const template: ChecklistTemplate = {
    id: uuid(50),
    crop: "SOJA",
    items: [
      { id: uuid(51), category: "SEED", description: "seed", fromDay: -10, toDay: 0 },
      { id: uuid(52), category: "FUNGICIDE", description: "fungicide", fromDay: 35, toDay: 55 },
      { id: uuid(53), category: "HERBICIDE", description: "herbicide", fromDay: -15, toDay: 5 },
      { id: uuid(54), category: "INSECTICIDE", description: "insecticide", fromDay: 60, toDay: 90 },
    ],
  };

  it("classifies each item as done, late, missing or pending", () => {
    const status = checklistStatus(
      template,
      "2025-10-10",
      [
        { eventId: uuid(60), checklistItemId: uuid(51), appliedOn: "2025-10-05" },
        { eventId: uuid(61), checklistItemId: uuid(52), appliedOn: "2025-12-24" },
      ],
      "2025-11-20",
    );
    expect(status.map((s) => s.status)).toEqual(["DONE", "LATE", "MISSING", "PENDING"]);
  });
});

describe("crop cycle state machine", () => {
  it("walks a CPR from issuance to full delivery", () => {
    const s = replayCycle([cprIssued(100_000), planting(), harvestStarted(), ...truck(uuid(70), 50_000), ...truck(uuid(71), 48_500)], ctx);
    expect(s.cprStatus).toBe("ISSUED");
    expect(s.receivedNetKg).toBe(98_500);
    expect(s.stage).toBe("DELIVERED"); // 98.5% >= 98% tolerance
  });

  it("stays DELIVERING below the tolerance", () => {
    const s = replayCycle([cprIssued(100_000), planting(), harvestStarted(), ...truck(uuid(70), 97_000)], ctx);
    expect(s.stage).toBe("DELIVERING");
  });

  it("rejects issuance above the eligible volume", () => {
    expectCode(() => replayCycle([cprIssued(300_000)], ctx), "ISSUED_ABOVE_ELIGIBLE");
  });

  it("rejects a truck sent to another warehouse", () => {
    expectCode(() => replayCycle([cprIssued(), planting(), harvestStarted(), dispatched(uuid(70), OTHER_WAREHOUSE)], ctx), "WRONG_WAREHOUSE");
  });

  it("rejects out-of-order steps", () => {
    expectCode(() => replayCycle([cprIssued(), planting(), dispatched(uuid(70))], ctx), "INVALID_TRANSITION");
    expectCode(() => replayCycle([cprIssued(), planting(), harvestStarted(), dispatched(uuid(70)), received(uuid(70), 30_000)], ctx), "INVALID_TRANSITION");
    expectCode(() => replayCycle([cprIssued(), planting(), harvestStarted(), arrived(uuid(70))], ctx), "DELIVERY_NOT_FOUND");
  });

  it("caps CDA volume at the net grain received", () => {
    const cda = ev({ eventType: "CDA_ISSUED", actorRole: "WAREHOUSE", actorOrgId: WAREHOUSE, quantity: 40_000, unit: "KG", payload: { cdaNumber: "C", waNumber: "W", issuedOn: "2026-02-12" } });
    expectCode(() => replayCycle([cprIssued(), planting(), harvestStarted(), ...truck(uuid(70), 30_000), cda], ctx), "QUANTITY_EXCEEDS_AVAILABLE");
  });

  it("only settles as fully delivered once DELIVERED", () => {
    const settle = (outcome: string, kg: number) =>
      ev({ eventType: "CPR_SETTLED", actorRole: "FINANCIER", actorOrgId: FINANCIER, quantity: kg, unit: "KG", payload: { outcome, settledOn: "2026-04-01", cashSettledBrlCents: null } });
    const base = [cprIssued(100_000), planting(), harvestStarted(), ...truck(uuid(70), 90_000)];
    expectCode(() => replayCycle([...base, settle("FULLY_DELIVERED", 90_000)], ctx), "INVALID_TRANSITION");
    const s = replayCycle([...base, settle("PARTIALLY_DELIVERED_CASH_SETTLED", 90_000)], ctx);
    expect(s.stage).toBe("CLOSED");
    expectCode(() => replayCycle([...base, settle("PARTIALLY_DELIVERED_CASH_SETTLED", 90_000), harvestStarted()], ctx), "INVALID_TRANSITION");
  });

  it("applies corrections and drops voided events on replay", () => {
    const p = planting("2025-10-10", "2025-10-15");
    const fix = ev({
      eventType: "EVENT_CORRECTED",
      refEventId: p.id,
      payload: { reason: "wrong date", corrected: { payload: { startedOn: "2025-10-11" } } },
    });
    expect(replayCycle([cprIssued(), p, fix], ctx).planting?.startedOn).toBe("2025-10-11");

    const t = truck(uuid(70), 30_000);
    const voidArrival = ev({ eventType: "EVENT_VOIDED", actorRole: "ADMIN", refEventId: t[1]!.id, payload: { reason: "duplicated entry" } });
    // Voiding the arrival leaves a receipt for a truck that never arrived.
    expectCode(() => replayCycle([cprIssued(), planting(), harvestStarted(), ...t, voidArrival], ctx), "INVALID_TRANSITION");
  });

  it("rejects a correction that breaks the schema", () => {
    const p = planting();
    const bad = ev({ eventType: "EVENT_CORRECTED", refEventId: p.id, payload: { reason: "typo in date", corrected: { payload: { startedOn: "not-a-date" } } } });
    expectCode(() => replayCycle([cprIssued(), p, bad], ctx), "CORRECTION_BREAKS_STREAM");
  });
});

describe("risk", () => {
  const inputs = (state = initialCycleState()): FindingInputs => ({
    cycle: { ...ctx.cycle, seasonCode: "2026/27-SAFRA" },
    plot: { uf: "MT", municipalityIbge: "5107925" },
    state,
    windows: [{ crop: "SOJA", season: "SAFRA", uf: "MT", municipalityIbge: null, startMonthDay: "09-16", endMonthDay: "12-31", source: "t", isSample: true }],
    templates: [],
    discountTables: [],
    toleranceBps: 200,
    now: new Date("2026-10-27T15:00:00Z"),
  });

  it("grades planting outside the window as D, whatever else is fine", () => {
    const state = { ...initialCycleState(), stage: "PLANTED" as const, planting: { eventId: uuid(80), cultivar: "X", cycleDays: 120, startedOn: "2026-09-05", finishedOn: "2026-09-12", plantedAreaM2: 1 } };
    const findings = cycleFindings(inputs(state));
    const risk = assessRisk(findings, new Date());
    expect(findings.map((f) => f.code)).toContain("PLANTED_OUTSIDE_WINDOW");
    expect(risk.grade).toBe("D");
    expect(risk.dimensions.find((d) => d.dimension === "PLANTING_WINDOW")?.score).toBe(100);
  });

  it("flags a missed window when nothing was planted", () => {
    const late = { ...inputs(), now: new Date("2027-01-15T15:00:00Z") };
    expect(cycleFindings(late).map((f) => f.code)).toContain("PLANTING_WINDOW_MISSED");
  });
});

describe("insurance", () => {
  const INSURER = uuid(8);
  const CLAIM = uuid(9);
  const policy = (policyNumber = "APL-1") =>
    ev({
      eventType: "POLICY_ISSUED",
      actorRole: "INSURER",
      actorOrgId: INSURER,
      quantity: 50_000_000,
      unit: "BRL_CENTS",
      payload: { insurerOrgId: INSURER, policyNumber, coverage: "PRODUTIVIDADE", insuredKg: 100_000, premiumBrlCents: 2_000_000, startsOn: "2025-10-01", endsOn: "2026-04-30" },
    });
  const claim = (lossOn = "2025-12-20", claimId = CLAIM) =>
    ev({ eventType: "CLAIM_FILED", occurredAt: "2025-12-22T10:00:00-03:00", quantity: 30_000, unit: "KG", payload: { claimId, policyNumber: "APL-1", cause: "GRANIZO", lossOn, description: "Granizo" } });
  const settled = (outcome: "PAID" | "DENIED", amount: number) =>
    ev({ eventType: "CLAIM_SETTLED", actorRole: "INSURER", actorOrgId: INSURER, quantity: amount, unit: "BRL_CENTS", payload: { claimId: CLAIM, outcome, assessedLossKg: 25_000, settledOn: "2026-01-20", reason: null } });

  it("files a claim against a policy and settles it once", () => {
    const s = replayCycle([cprIssued(), planting(), policy(), claim(), settled("PAID", 4_000_000)], ctx);
    expect(s.policies).toHaveLength(1);
    expect(s.claims[0]).toMatchObject({ insurerOrgId: INSURER, estimatedLossKg: 30_000, settlement: { outcome: "PAID", paidBrlCents: 4_000_000 } });
    expectCode(() => replayCycle([policy(), claim(), settled("PAID", 1), settled("PAID", 1)], ctx), "INVALID_TRANSITION");
  });

  it("rejects claims without a policy, outside its period, and inconsistent settlements", () => {
    expectCode(() => replayCycle([claim()], ctx), "VALIDATION_FAILED");
    expectCode(() => replayCycle([policy(), claim("2026-06-01")], ctx), "VALIDATION_FAILED");
    expectCode(() => replayCycle([policy(), policy()], ctx), "INVALID_TRANSITION");
    expectCode(() => replayCycle([policy(), claim(), settled("DENIED", 100)], ctx), "VALIDATION_FAILED");
    expectCode(() => replayCycle([policy(), claim(), settled("PAID", 0)], ctx), "VALIDATION_FAILED");
  });

  it("raises open and unanswered claim alerts without touching the risk grade", () => {
    const state = replayCycle([policy(), claim()], ctx);
    const base = { cycle: ctx.cycle, plot: { uf: "PR", municipalityIbge: "4104808" }, state, windows: [], templates: [], discountTables: [], toleranceBps: 200 };
    const soon = cycleFindings({ ...base, now: new Date("2026-01-05T15:00:00Z") });
    expect(soon.filter((f) => f.code.startsWith("CLAIM")).map((f) => f.code)).toEqual(["CLAIM_OPEN"]);
    const later = cycleFindings({ ...base, now: new Date("2026-02-01T15:00:00Z") });
    expect(later.filter((f) => f.code.startsWith("CLAIM")).map((f) => f.code)).toEqual(["CLAIM_OPEN", "CLAIM_UNANSWERED"]);
    expect(later.filter((f) => f.code.startsWith("CLAIM")).every((f) => f.risk === null)).toBe(true);
  });

  it("still accepts insurance events after the CPR is settled", () => {
    const deliveries = truck(uuid(60), 100_000);
    const settle = ev({ eventType: "CPR_SETTLED", actorRole: "FINANCIER", actorOrgId: FINANCIER, quantity: 100_000, unit: "KG", payload: { outcome: "FULLY_DELIVERED", settledOn: "2026-03-01", cashSettledBrlCents: null } });
    const s = replayCycle([cprIssued(), planting(), policy(), harvestStarted(), ...deliveries, settle, claim()], ctx);
    expect(s.stage).toBe("CLOSED");
    expect(s.claims).toHaveLength(1);
  });
});
