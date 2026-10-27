import { createHash } from "node:crypto";
import type { CanonicalEvent } from "@agro-cpr/spec";
import type { Db } from "../db/client.js";
import { farms, files, memberships, orgs } from "../db/schema.js";
import type { Actor } from "../domain/types.js";
import { syncCycleAlerts } from "../services/alerts.js";
import {
  replaceChecklists,
  replaceDiscountTables,
  replaceHaircuts,
  replacePlantingWindows,
} from "../services/configs.js";
import { approveCprRequest, createCprRequest, createCropCycle } from "../services/cycles.js";
import { recordEvent } from "../services/events.js";

/** Deterministic UUIDs so tests, docs and dev tokens can refer to seed data. */
export const seedId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SEED = {
  orgs: {
    platform: seedId(101),
    producerMT: seedId(102), // Fazenda Boa Vista, Sorriso (MT)
    producerPR: seedId(103), // Sítio Santa Rita, Cascavel (PR)
    warehouse: seedId(104),
    buyer: seedId(105),
    financier: seedId(106),
  },
  users: {
    admin: seedId(201),
    producerMT: seedId(202),
    producerPR: seedId(203),
    warehouse: seedId(204),
    buyer: seedId(205),
    financier: seedId(206),
  },
  farms: { boaVista: seedId(301), santaRita: seedId(302) },
  plots: { mt1: seedId(401), mt2: seedId(402), pr1: seedId(403) },
  checklistItems: {
    seedTreatment: seedId(911),
    preEmergence: seedId(912),
    insecticide: seedId(913),
    fungicide: seedId(914),
  },
} as const;

export interface SeedResult {
  /** 2025/26 soybean in PR: delivered short over 3 trucks, one corrected application, one ticket mismatch. Not settled. */
  shortfallCycleId: string;
  /** 2026/27 soybean in MT: planted before the window opened, one application missing, info requested. */
  outsideWindowCycleId: string;
  eventIds: { fungicideOriginal: string; fungicideCorrection: string };
}

const actor = (key: keyof typeof SEED.users, role: Actor["role"], org: keyof typeof SEED.orgs): Actor => ({
  userId: SEED.users[key],
  orgId: SEED.orgs[org],
  role,
});
const PRODUCER_MT = actor("producerMT", "PRODUCER", "producerMT");
const PRODUCER_PR = actor("producerPR", "PRODUCER", "producerPR");
const WAREHOUSE = actor("warehouse", "WAREHOUSE", "warehouse");
const BUYER = actor("buyer", "BUYER", "buyer");
const FINANCIER = actor("financier", "FINANCIER", "financier");

export async function seedScenario(db: Db, opts: { now: Date; toleranceBps: number }): Promise<SeedResult> {
  let nextEvent = 1001;
  const eventId = () => seedId(nextEvent++);
  // Loosely typed on purpose: recordEvent validates every seed event against the canonical schema.
  const record = async (who: Actor, event: { eventType: CanonicalEvent["eventType"]; subjectType: "PLOT" | "CROP_CYCLE"; subjectId: string; [field: string]: unknown }) => {
    const id = eventId();
    await recordEvent(
      db,
      who,
      { evidenceHash: null, refEventId: null, ...event, id, actorRole: who.role, actorOrgId: who.orgId },
      opts,
    );
    return id;
  };

  // ---- organizations and users ----
  await db.insert(orgs).values([
    { id: SEED.orgs.platform, name: "Plataforma (admin)", kind: "PLATFORM" },
    { id: SEED.orgs.producerMT, name: "Fazenda Boa Vista", kind: "PRODUCER" },
    { id: SEED.orgs.producerPR, name: "Sítio Santa Rita", kind: "PRODUCER" },
    { id: SEED.orgs.warehouse, name: "Armazém Central", kind: "WAREHOUSE" },
    { id: SEED.orgs.buyer, name: "Trading Grão Forte", kind: "BUYER" },
    { id: SEED.orgs.financier, name: "Securitizadora Campo", kind: "FINANCIER" },
  ]);
  await db.insert(memberships).values([
    { userId: SEED.users.admin, orgId: SEED.orgs.platform, role: "ADMIN", email: "admin@example.com", name: "Admin" },
    { userId: SEED.users.producerMT, orgId: SEED.orgs.producerMT, role: "PRODUCER", email: "boavista@example.com", name: "Produtor MT" },
    { userId: SEED.users.producerPR, orgId: SEED.orgs.producerPR, role: "PRODUCER", email: "santarita@example.com", name: "Produtor PR" },
    { userId: SEED.users.warehouse, orgId: SEED.orgs.warehouse, role: "WAREHOUSE", email: "armazem@example.com", name: "Armazém" },
    { userId: SEED.users.buyer, orgId: SEED.orgs.buyer, role: "BUYER", email: "trading@example.com", name: "Comprador" },
    { userId: SEED.users.financier, orgId: SEED.orgs.financier, role: "FINANCIER", email: "securitizadora@example.com", name: "Financiador" },
  ]);

  // ---- configuration (all values are SAMPLES, not official ZARC or classification tables) ----
  await replacePlantingWindows(db, [
    { crop: "SOJA", season: "SAFRA", uf: "MT", municipalityIbge: null, startMonthDay: "09-16", endMonthDay: "12-31", source: "sample", isSample: true },
    { crop: "SOJA", season: "SAFRA", uf: "PR", municipalityIbge: null, startMonthDay: "09-21", endMonthDay: "12-31", source: "sample", isSample: true },
    { crop: "MILHO", season: "SAFRINHA", uf: "MT", municipalityIbge: null, startMonthDay: "01-01", endMonthDay: "03-10", source: "sample", isSample: true },
  ]);
  await replaceHaircuts(db, [
    { crop: "SOJA", haircutBps: 8_000 },
    { crop: "MILHO", haircutBps: 7_500 },
  ]);
  await replaceDiscountTables(db, [
    { crop: "SOJA", moistureBasePct: 14, moistureDiscountPerPointPct: 1.5, impurityBasePct: 1, impurityDiscountPerPointPct: 1, damagedBasePct: 8, damagedDiscountPerPointPct: 1, isSample: true },
    { crop: "MILHO", moistureBasePct: 14, moistureDiscountPerPointPct: 1.5, impurityBasePct: 1, impurityDiscountPerPointPct: 1, damagedBasePct: 6, damagedDiscountPerPointPct: 1, isSample: true },
  ]);
  const item = SEED.checklistItems;
  await replaceChecklists(db, [
    {
      id: seedId(901),
      crop: "SOJA",
      items: [
        { id: item.seedTreatment, category: "SEED", description: "Tratamento de sementes", fromDay: -10, toDay: 0 },
        { id: item.preEmergence, category: "HERBICIDE", description: "Herbicida pré-emergente / dessecação", fromDay: -15, toDay: 5 },
        { id: item.insecticide, category: "INSECTICIDE", description: "Inseticida (pragas iniciais)", fromDay: 20, toDay: 70 },
        { id: item.fungicide, category: "FUNGICIDE", description: "Fungicida 1ª aplicação (ferrugem)", fromDay: 35, toDay: 55 },
      ],
    },
  ]);

  // ---- evidence files (metadata only; the bytes are not uploaded) ----
  const evidence = (label: string) => createHash("sha256").update(`seed-evidence:${label}`).digest("hex");
  const evidenceLabels = ["nf-tratamento", "nf-herbicida", "nf-inseticida", "nf-fungicida", "laudo-solo", "nf-tratamento-mt"];
  await db.insert(files).values(
    evidenceLabels.map((label) => ({
      sha256: evidence(label),
      contentType: "application/pdf",
      sizeBytes: 1024,
      storagePath: `seed/${label}.pdf`,
      uploadedBy: SEED.users.admin,
    })),
  );

  // ---- farms and plots ----
  await db.insert(farms).values([
    { id: SEED.farms.boaVista, producerOrgId: SEED.orgs.producerMT, name: "Fazenda Boa Vista", uf: "MT", municipalityIbge: "5107925" },
    { id: SEED.farms.santaRita, producerOrgId: SEED.orgs.producerPR, name: "Sítio Santa Rita", uf: "PR", municipalityIbge: "4104808" },
  ]);
  const plot = (who: Actor, plotId: string, farmId: string, name: string, areaM2: number, uf: "MT" | "PR", ibge: string, car: string) =>
    record(who, {
      eventType: "PLOT_REGISTERED",
      subjectType: "PLOT",
      subjectId: plotId,
      occurredAt: "2025-07-01T09:00:00-03:00",
      quantity: areaM2,
      unit: "M2",
      payload: { farmId, name, carCode: car, municipalityIbge: ibge, uf, geometry: null, digitalTwinRef: null },
    });
  await plot(PRODUCER_MT, SEED.plots.mt1, SEED.farms.boaVista, "Talhão 1", 5_000_000, "MT", "5107925", "MT-5107925-SAMPLE-0001");
  await plot(PRODUCER_MT, SEED.plots.mt2, SEED.farms.boaVista, "Talhão 2", 3_000_000, "MT", "5107925", "MT-5107925-SAMPLE-0001");
  await plot(PRODUCER_PR, SEED.plots.pr1, SEED.farms.santaRita, "Talhão Norte", 1_200_000, "PR", "4104808", "PR-4104808-SAMPLE-0002");
  await record(PRODUCER_MT, {
    eventType: "SOIL_ANALYSIS_ATTACHED",
    subjectType: "PLOT",
    subjectId: SEED.plots.mt1,
    occurredAt: "2026-07-15T10:00:00-03:00",
    quantity: null,
    unit: null,
    evidenceHash: evidence("laudo-solo"),
    payload: { labName: "Laboratório Exemplo", sampledOn: "2026-07-10", digitalTwinRef: null, ph: 5.6, organicMatterPct: 3.1, clayPct: 42 },
  });

  // ---- cycle 1: PR soybean 2025/26, short delivery ----
  const c1 = await createCropCycle(db, PRODUCER_PR, { plotId: SEED.plots.pr1, crop: "SOJA", seasonCode: "2025/26-SAFRA", expectedYieldKgPerHa: 3_600 }, opts.now);
  const req1 = await createCprRequest(
    db,
    PRODUCER_PR,
    { cropCycleId: c1.id, requestedKg: 108_000, warehouseOrgId: SEED.orgs.warehouse, financierOrgId: SEED.orgs.financier, dueDate: "2026-04-30" },
    opts.now,
  );
  await approveCprRequest(
    db,
    FINANCIER,
    req1.id,
    { eventId: eventId(), cprNumber: "CPR-2025-0001", issuedKg: 108_000, deliveryWindowStart: "2026-02-01", deliveryWindowEnd: "2026-03-31" },
    { ...opts, occurredAt: "2025-09-05T10:00:00-03:00" },
  );
  const cyc1 = { subjectType: "CROP_CYCLE" as const, subjectId: c1.id };
  await record(FINANCIER, { ...cyc1, eventType: "FUNDING_DISBURSED", occurredAt: "2025-09-10T11:00:00-03:00", quantity: 15_000_000, unit: "BRL_CENTS", payload: { financierOrgId: SEED.orgs.financier, purpose: "INPUTS", reference: "TED-0001" } });
  const application = (who: Actor, cycle: typeof cyc1, on: string, itemId: string, category: string, product: string, qty: number, unit: "KG" | "ML", file: string) =>
    record(who, {
      ...cycle,
      eventType: "INPUT_APPLICATION_RECORDED",
      occurredAt: `${on}T16:00:00-03:00`,
      quantity: qty,
      unit,
      evidenceHash: evidence(file),
      payload: { checklistItemId: itemId, category, productName: product, activeIngredient: null, appliedAreaM2: 1_200_000, appliedOn: on, nfeKey: null, agronomistRecipeNumber: null },
    });
  await application(PRODUCER_PR, cyc1, "2025-10-05", item.seedTreatment, "SEED", "Tratamento de sementes (exemplo)", 60_000, "ML", "nf-tratamento");
  await application(PRODUCER_PR, cyc1, "2025-10-08", item.preEmergence, "HERBICIDE", "Herbicida (exemplo)", 240_000, "ML", "nf-herbicida");
  await record(PRODUCER_PR, { ...cyc1, eventType: "PLANTING_RECORDED", occurredAt: "2025-10-15T18:00:00-03:00", quantity: 1_200_000, unit: "M2", payload: { crop: "SOJA", cultivar: "Cultivar exemplo 62", cycleDays: 115, startedOn: "2025-10-10", finishedOn: "2025-10-15" } });
  await application(PRODUCER_PR, cyc1, "2025-11-14", item.insecticide, "INSECTICIDE", "Inseticida (exemplo)", 60_000, "ML", "nf-inseticida");
  // Typed with the wrong date (Dec 24), then corrected to the invoice date (Nov 30).
  const fungicideOriginal = await application(PRODUCER_PR, cyc1, "2025-12-24", item.fungicide, "FUNGICIDE", "Fungicida (exemplo)", 72_000, "ML", "nf-fungicida");
  const fungicideCorrection = await record(PRODUCER_PR, {
    ...cyc1,
    eventType: "EVENT_CORRECTED",
    occurredAt: "2025-12-26T09:00:00-03:00",
    quantity: null,
    unit: null,
    refEventId: fungicideOriginal,
    payload: { reason: "Data digitada errada; a nota fiscal mostra 30/11", corrected: { payload: { appliedOn: "2025-11-30" } } },
  });
  await record(PRODUCER_PR, { ...cyc1, eventType: "HARVEST_PLANNED", occurredAt: "2026-01-15T10:00:00-03:00", quantity: 420_000, unit: "KG", payload: { plannedStart: "2026-02-01", plannedEnd: "2026-02-20" } });
  await record(PRODUCER_PR, { ...cyc1, eventType: "HARVEST_STARTED", occurredAt: "2026-02-03T08:00:00-03:00", quantity: null, unit: null, payload: { startedOn: "2026-02-03" } });

  const trucks = [
    { delivery: seedId(701), plate: "ABC1D23", day: "2026-02-04", gross: 37_000, moisture: 15.0, impurity: 1.0, damaged: 2.0, discount: 555, ticket: "T-1001" },
    { delivery: seedId(702), plate: "QRT4E56", day: "2026-02-06", gross: 36_500, moisture: 14.0, impurity: 1.5, damaged: 1.0, discount: 183, ticket: "T-1002" },
    // The table gives 1,056 kg; the ticket discounts 1,200 kg, which raises QUALITY_TICKET_MISMATCH.
    { delivery: seedId(703), plate: "MNO7P89", day: "2026-02-09", gross: 33_000, moisture: 16.0, impurity: 1.2, damaged: 3.0, discount: 1_200, ticket: "T-1003" },
  ];
  for (const t of trucks) {
    await record(PRODUCER_PR, { ...cyc1, eventType: "TRUCK_DISPATCHED", occurredAt: `${t.day}T07:00:00-03:00`, quantity: t.gross, unit: "KG", payload: { deliveryId: t.delivery, truckPlate: t.plate, warehouseOrgId: SEED.orgs.warehouse, expectedArrivalAt: `${t.day}T13:00:00-03:00` } });
    await record(WAREHOUSE, { ...cyc1, eventType: "TRUCK_ARRIVED", occurredAt: `${t.day}T12:40:00-03:00`, quantity: null, unit: null, payload: { deliveryId: t.delivery, truckPlate: t.plate } });
    await record(WAREHOUSE, { ...cyc1, eventType: "GRAIN_RECEIVED", occurredAt: `${t.day}T13:30:00-03:00`, quantity: t.gross - t.discount, unit: "KG", payload: { deliveryId: t.delivery, ticketNumber: t.ticket, grossKg: t.gross, moisturePct: t.moisture, impurityPct: t.impurity, damagedPct: t.damaged, discountKg: t.discount, netKg: t.gross - t.discount } });
  }
  const receivedNet = trucks.reduce((sum, t) => sum + t.gross - t.discount, 0);
  await record(WAREHOUSE, { ...cyc1, eventType: "CDA_ISSUED", occurredAt: "2026-02-12T10:00:00-03:00", quantity: receivedNet, unit: "KG", payload: { cdaNumber: "CDA-2026-0001", waNumber: "WA-2026-0001", issuedOn: "2026-02-12" } });
  await record(BUYER, { ...cyc1, eventType: "SALE_RECORDED", occurredAt: "2026-03-10T15:00:00-03:00", quantity: 60_000, unit: "KG", payload: { buyerOrgId: SEED.orgs.buyer, contractNumber: "CT-2026-033", priceBrlCentsPerSaca: 12_000 } });
  await record(WAREHOUSE, { ...cyc1, eventType: "GRAIN_RELEASED", occurredAt: "2026-03-15T09:00:00-03:00", quantity: 60_000, unit: "KG", payload: { cdaNumber: "CDA-2026-0001", releasedToOrgId: SEED.orgs.buyer, releaseOrderNumber: "OR-2026-010" } });

  // ---- cycle 2: MT soybean 2026/27, planted before the window ----
  const c2 = await createCropCycle(db, PRODUCER_MT, { plotId: SEED.plots.mt1, crop: "SOJA", seasonCode: "2026/27-SAFRA", expectedYieldKgPerHa: 3_600 }, opts.now);
  const req2 = await createCprRequest(
    db,
    PRODUCER_MT,
    { cropCycleId: c2.id, requestedKg: 1_000_000, warehouseOrgId: SEED.orgs.warehouse, financierOrgId: SEED.orgs.financier, dueDate: "2027-04-30" },
    opts.now,
  );
  await approveCprRequest(
    db,
    FINANCIER,
    req2.id,
    { eventId: eventId(), cprNumber: "CPR-2026-0002", issuedKg: 1_000_000, deliveryWindowStart: "2027-02-01", deliveryWindowEnd: "2027-03-31" },
    { ...opts, occurredAt: "2026-08-20T10:00:00-03:00" },
  );
  const cyc2 = { subjectType: "CROP_CYCLE" as const, subjectId: c2.id };
  await record(FINANCIER, { ...cyc2, eventType: "FUNDING_DISBURSED", occurredAt: "2026-08-25T11:00:00-03:00", quantity: 100_000_000, unit: "BRL_CENTS", payload: { financierOrgId: SEED.orgs.financier, purpose: "INPUTS", reference: "TED-0002" } });
  await record(PRODUCER_MT, {
    ...cyc2,
    eventType: "INPUT_APPLICATION_RECORDED",
    occurredAt: "2026-09-01T16:00:00-03:00",
    quantity: 250_000,
    unit: "ML",
    evidenceHash: evidence("nf-tratamento-mt"),
    payload: { checklistItemId: item.seedTreatment, category: "SEED", productName: "Tratamento de sementes (exemplo)", activeIngredient: null, appliedAreaM2: 5_000_000, appliedOn: "2026-09-01", nfeKey: null, agronomistRecipeNumber: null },
  });
  await record(PRODUCER_MT, { ...cyc2, eventType: "PLANTING_RECORDED", occurredAt: "2026-09-12T18:00:00-03:00", quantity: 5_000_000, unit: "M2", payload: { crop: "SOJA", cultivar: "Cultivar exemplo 75", cycleDays: 120, startedOn: "2026-09-05", finishedOn: "2026-09-12" } });
  await record(FINANCIER, { ...cyc2, eventType: "INFO_REQUESTED", occurredAt: "2026-10-20T09:00:00-03:00", quantity: null, unit: null, payload: { requestedFromOrgId: SEED.orgs.producerMT, topic: "PLANTING", message: "Envie a nota do plantio e fotos georreferenciadas do talhão.", dueDate: "2026-11-05" } });

  await syncCycleAlerts(db, "all", opts);
  return { shortfallCycleId: c1.id, outsideWindowCycleId: c2.id, eventIds: { fungicideOriginal, fungicideCorrection } };
}
