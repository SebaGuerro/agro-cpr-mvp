import { CanonicalEvent, EMITTERS, type StoredEvent } from "@agro-cpr/spec";
import { canonicalJson, recordHash } from "@agro-cpr/spec/keys";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cprRequests, cropCycles, cycleInsurers, events, farms, files, orgs, plots } from "../db/schema.js";
import { replayCycle, replayPlot, type CycleState } from "../domain/cycleState.js";
import { ApiError, fail } from "../domain/errors.js";
import type { Actor, CycleFacts } from "../domain/types.js";

export type EventRow = typeof events.$inferSelect;
export type CycleRow = typeof cropCycles.$inferSelect;
type PlotRow = typeof plots.$inferSelect;
type Correction = Extract<CanonicalEvent, { eventType: "EVENT_CORRECTED" | "EVENT_VOIDED" }>;

export interface EventOptions {
  now: Date;
  toleranceBps: number;
  /** CPR_ISSUED is only accepted from the CPR-request approval flow. */
  allowCprIssued?: boolean;
  importBatchId?: string | null;
}

export interface RecordResult {
  row: EventRow;
  created: boolean;
  cycleId: string | null;
}

const ROLE_OF_KIND = {
  PLATFORM: "ADMIN",
  PRODUCER: "PRODUCER",
  WAREHOUSE: "WAREHOUSE",
  BUYER: "BUYER",
  FINANCIER: "FINANCIER",
  INSURER: "INSURER",
} as const;

const MAX_FUTURE_MS = 5 * 60 * 1000;

export function parseEvent(input: unknown): CanonicalEvent {
  const parsed = CanonicalEvent.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "Event does not match the canonical schema",
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return parsed.data;
}

export function cycleFacts(c: CycleRow): CycleFacts {
  return {
    id: c.id,
    plotId: c.plotId,
    producerOrgId: c.producerOrgId,
    crop: c.crop,
    seasonCode: c.seasonCode,
    areaM2: c.areaM2,
    potentialKg: c.potentialKg,
    haircutBps: c.haircutBps,
    eligibleKg: c.eligibleKg,
  };
}

export async function loadStream(db: Db, subjectId: string): Promise<StoredEvent[]> {
  const rows = await db
    .select({ body: events.body })
    .from(events)
    .where(eq(events.subjectId, subjectId))
    .orderBy(asc(events.seq));
  return rows.map((r) => r.body);
}

export async function recordEvent(db: Db, actor: Actor, input: unknown, opts: EventOptions): Promise<RecordResult> {
  const event = parseEvent(input);
  return db.transaction((tx) => recordEventTx(tx, actor, event, opts));
}

/**
 * Validates and stores one canonical event inside an open transaction:
 * identity and role checks, org-level authorization, evidence, then a full replay
 * of the subject's events with the new one appended. The subject row is locked,
 * so concurrent events on the same plot or cycle are serialized.
 */
export async function recordEventTx(tx: Db, actor: Actor, event: CanonicalEvent, opts: EventOptions): Promise<RecordResult> {
  if (event.eventType === "CPR_ISSUED" && !opts.allowCprIssued) {
    fail("VALIDATION_FAILED", "CPR_ISSUED is created by approving a CPR request");
  }
  if (Date.parse(event.occurredAt) > opts.now.getTime() + MAX_FUTURE_MS) {
    fail("VALIDATION_FAILED", "occurredAt is in the future");
  }

  const [existing] = await tx.select().from(events).where(eq(events.id, event.id));
  if (existing) {
    const { recordedAt: _a, recordedBy: _b, ...prior } = existing.body;
    if (canonicalJson(prior) !== canonicalJson(event)) {
      fail("EVENT_ID_CONFLICT", "An event with this id already exists with different content");
    }
    return { row: existing, created: false, cycleId: existing.subjectType === "CROP_CYCLE" ? existing.subjectId : null };
  }

  await authorizeActor(tx, actor, event);
  if (!EMITTERS[event.eventType].includes(event.actorRole)) {
    fail("FORBIDDEN_ROLE", `${event.actorRole} cannot record ${event.eventType}`);
  }
  if (event.evidenceHash) {
    const [file] = await tx.select({ id: files.id }).from(files).where(eq(files.sha256, event.evidenceHash));
    if (!file) fail("EVIDENCE_REQUIRED", "Upload the evidence file (POST /v1/files) before referencing its hash");
  }

  const stored: StoredEvent = { ...event, recordedAt: opts.now.toISOString(), recordedBy: actor.userId };
  const stream = await loadStream(tx, event.subjectId);
  const isCorrection = event.eventType === "EVENT_CORRECTED" || event.eventType === "EVENT_VOIDED";
  if (isCorrection) authorizeCorrection(event, stream);

  let newPlot: { farm: typeof farms.$inferSelect } | null = null;
  let newCycleState: CycleState | null = null;

  if (event.subjectType === "PLOT") {
    if (event.eventType === "PLOT_REGISTERED") {
      newPlot = { farm: await checkNewPlot(tx, event) };
    } else {
      const [plot] = await tx.select().from(plots).where(eq(plots.id, event.subjectId)).for("update");
      if (!plot) fail("NOT_FOUND", "Plot not found");
      if (!isCorrection) authorizePlotEvent(event, plot);
    }
    validateReplay(isCorrection, () => replayPlot([...stream, stored]));
  } else {
    const [cycle] = await tx.select().from(cropCycles).where(eq(cropCycles.id, event.subjectId)).for("update");
    if (!cycle) fail("NOT_FOUND", "Crop cycle not found");
    if (!isCorrection) {
      const requests = await tx
        .select({ financierOrgId: cprRequests.financierOrgId })
        .from(cprRequests)
        .where(eq(cprRequests.cropCycleId, cycle.id));
      const insurers = await tx
        .select({ insurerOrgId: cycleInsurers.insurerOrgId })
        .from(cycleInsurers)
        .where(eq(cycleInsurers.cropCycleId, cycle.id));
      authorizeCycleEvent(event, cycle, requests.map((r) => r.financierOrgId), insurers.map((i) => i.insurerOrgId));
    }
    const ctx = { cycle: cycleFacts(cycle), toleranceBps: opts.toleranceBps };
    newCycleState = validateReplay(isCorrection, () => replayCycle([...stream, stored], ctx));
  }

  const [row] = await tx
    .insert(events)
    .values({
      id: event.id,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      eventType: event.eventType,
      actorRole: event.actorRole,
      actorOrgId: event.actorOrgId,
      quantity: event.quantity,
      unit: event.unit,
      occurredAt: new Date(event.occurredAt),
      recordedAt: opts.now,
      recordedBy: actor.userId,
      evidenceHash: event.evidenceHash,
      refEventId: event.refEventId,
      body: stored,
      recordHash: recordHash(stored),
      importBatchId: opts.importBatchId ?? null,
    })
    .returning();
  if (!row) throw new Error("Event insert returned no row");

  if (newPlot && event.eventType === "PLOT_REGISTERED") {
    const p = event.payload;
    await tx.insert(plots).values({
      id: event.subjectId,
      farmId: p.farmId,
      producerOrgId: newPlot.farm.producerOrgId,
      name: p.name,
      areaM2: event.quantity,
      carCode: p.carCode,
      uf: p.uf,
      municipalityIbge: p.municipalityIbge,
      geometry: p.geometry,
      digitalTwinRef: p.digitalTwinRef,
    });
  }
  if (newCycleState) {
    await tx
      .update(cropCycles)
      .set({ state: newCycleState, stage: newCycleState.stage, cprStatus: newCycleState.cprStatus, updatedAt: opts.now })
      .where(eq(cropCycles.id, event.subjectId));
  }

  return { row, created: true, cycleId: event.subjectType === "CROP_CYCLE" ? event.subjectId : null };
}

/** Rule errors caused by a correction or void are reported as CORRECTION_BREAKS_STREAM. */
function validateReplay<T>(isCorrection: boolean, replay: () => T): T {
  try {
    return replay();
  } catch (err) {
    if (isCorrection && err instanceof ApiError && err.code !== "CORRECTION_BREAKS_STREAM") {
      throw new ApiError("CORRECTION_BREAKS_STREAM", `${err.code}: ${err.message}`);
    }
    throw err;
  }
}

/** Non-admins act only as themselves; admins act on behalf of an org of the matching kind. */
async function authorizeActor(tx: Db, actor: Actor, event: CanonicalEvent): Promise<void> {
  if (actor.role !== "ADMIN") {
    if (event.actorRole !== actor.role) fail("FORBIDDEN_ROLE", "actorRole must be your own role");
    if (event.actorOrgId !== actor.orgId) fail("FORBIDDEN_ORG", "actorOrgId must be your own organization");
    return;
  }
  const [org] = await tx.select().from(orgs).where(eq(orgs.id, event.actorOrgId));
  if (!org) fail("NOT_FOUND", "actorOrgId not found");
  if (ROLE_OF_KIND[org.kind] !== event.actorRole) {
    fail("VALIDATION_FAILED", `actorRole ${event.actorRole} does not match the organization's kind (${org.kind})`);
  }
}

function authorizeCorrection(event: Correction, stream: StoredEvent[]): void {
  const target = stream.find((e) => e.id === event.refEventId);
  if (!target) fail("NOT_FOUND", "The referenced event is not on this subject");
  if (event.eventType === "EVENT_CORRECTED") {
    if (target.eventType === "EVENT_CORRECTED" || target.eventType === "EVENT_VOIDED") {
      fail("VALIDATION_FAILED", "Corrections and voids cannot be corrected; void them instead");
    }
    if (target.eventType === "CPR_ISSUED" && event.payload.corrected.quantity !== undefined) {
      fail("VALIDATION_FAILED", "The issued CPR quantity is fixed on-chain and cannot be corrected");
    }
    if (event.actorRole !== "ADMIN" && event.actorOrgId !== target.actorOrgId) {
      fail("FORBIDDEN_ORG", "Only the organization that recorded the event (or an admin) can correct it");
    }
  } else {
    if (target.eventType === "EVENT_VOIDED") fail("VALIDATION_FAILED", "A void cannot be voided");
    if (target.eventType === "CPR_ISSUED" || target.eventType === "CPR_SETTLED") {
      fail("VALIDATION_FAILED", `${target.eventType} is final on-chain and cannot be voided`);
    }
  }
}

async function checkNewPlot(tx: Db, event: Extract<CanonicalEvent, { eventType: "PLOT_REGISTERED" }>) {
  const [existing] = await tx.select({ id: plots.id }).from(plots).where(eq(plots.id, event.subjectId));
  if (existing) fail("INVALID_TRANSITION", "Plot is already registered");
  const [farm] = await tx.select().from(farms).where(eq(farms.id, event.payload.farmId));
  if (!farm) fail("NOT_FOUND", "Farm not found");
  if (event.actorRole !== "ADMIN" && event.actorOrgId !== farm.producerOrgId) {
    fail("FORBIDDEN_ORG", "Plots can only be registered on your own farm");
  }
  if (event.payload.uf !== farm.uf) fail("VALIDATION_FAILED", "Plot state (UF) must match the farm");
  if (event.payload.carCode) {
    // The same rural property (CAR) registered by two producers is a double-pledge risk.
    const [other] = await tx
      .select({ id: plots.id })
      .from(plots)
      .where(and(eq(plots.carCode, event.payload.carCode), ne(plots.producerOrgId, farm.producerOrgId)));
    if (other) fail("LAND_ALREADY_REGISTERED", "This CAR code is already registered by another producer");
  }
  return farm;
}

function authorizePlotEvent(event: CanonicalEvent, plot: PlotRow): void {
  if (event.actorRole !== "ADMIN" && event.actorOrgId !== plot.producerOrgId) {
    fail("FORBIDDEN_ORG", "Only the plot's producer can record this");
  }
}

function authorizeCycleEvent(event: CanonicalEvent, cycle: CycleRow, requestFinancierIds: string[], linkedInsurerIds: string[]): void {
  if (event.eventType === "POLICY_ISSUED" && !linkedInsurerIds.includes(event.payload.insurerOrgId)) {
    fail("FORBIDDEN_ORG", "The producer has not linked this insurer to the crop cycle");
  }
  if (event.actorRole === "ADMIN") return;
  const org = event.actorOrgId;
  const cpr = cycle.state.cpr;
  const must = (ok: boolean, message: string) => {
    if (!ok) fail("FORBIDDEN_ORG", message);
  };
  switch (event.eventType) {
    case "PLANTING_RECORDED":
    case "INPUT_APPLICATION_RECORDED":
    case "HARVEST_PLANNED":
    case "HARVEST_STARTED":
    case "TRUCK_DISPATCHED":
      return must(org === cycle.producerOrgId, "Only the crop cycle's producer can record this");
    case "TRUCK_ARRIVED":
    case "GRAIN_RECEIVED":
    case "CDA_ISSUED":
    case "GRAIN_RELEASED":
      return must(org === cpr?.warehouseOrgId, "Only the CPR's designated warehouse can record this");
    case "CLAIM_FILED":
      return must(org === cycle.producerOrgId, "Only the crop cycle's producer can file a claim");
    case "POLICY_ISSUED":
      return must(org === event.payload.insurerOrgId, "Insurers can only issue their own policies");
    case "CLAIM_SETTLED": {
      const claim = cycle.state.claims.find((c) => c.claimId === event.payload.claimId);
      return must(!claim || org === claim.insurerOrgId, "Only the policy's insurer can settle this claim");
    }
    case "CPR_ISSUED":
      return must(org === event.payload.financierOrgId, "Only the CPR's financier can issue it");
    case "FUNDING_DISBURSED":
    case "CPR_SETTLED":
      return must(org === cpr?.financierOrgId, "Only the CPR's financier can record this");
    case "INFO_REQUESTED":
      return must(
        org === cpr?.financierOrgId || requestFinancierIds.includes(org),
        "Only a financier involved with this crop cycle can request information",
      );
    case "SALE_RECORDED":
      return must(org === event.payload.buyerOrgId, "Buyers can only record their own purchases");
    default:
      return;
  }
}
