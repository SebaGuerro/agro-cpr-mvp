import { CanonicalEvent, SeasonCode } from "@agro-cpr/spec";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { cprRequests, cropCycles, CROPS, cycleInsurers, orgs, plots } from "../db/schema.js";
import { initialCycleState } from "../domain/cycleState.js";
import { fail } from "../domain/errors.js";
import { eligibleKg, potentialKg } from "../domain/quantities.js";
import type { Actor } from "../domain/types.js";
import { haircutFor, loadConfigs } from "./configs.js";
import { recordEventTx, type EventOptions } from "./events.js";

export const CropCycleInput = z.object({
  plotId: z.uuid(),
  crop: z.enum(CROPS),
  seasonCode: SeasonCode,
  expectedYieldKgPerHa: z.number().int().min(1).max(20_000),
});

export const CprRequestInput = z.object({
  cropCycleId: z.uuid(),
  requestedKg: z.number().int().min(1),
  warehouseOrgId: z.uuid(),
  financierOrgId: z.uuid(),
  dueDate: z.iso.date(),
});

export const CprApproval = z.object({
  eventId: z.uuid(),
  cprNumber: z.string().min(1).max(60),
  issuedKg: z.number().int().min(1),
  deliveryWindowStart: z.iso.date(),
  deliveryWindowEnd: z.iso.date(),
});

function requireProducerOf(actor: Actor, producerOrgId: string): void {
  if (actor.role === "ADMIN") return;
  if (actor.role !== "PRODUCER") fail("FORBIDDEN_ROLE", "Only producers can do this");
  if (actor.orgId !== producerOrgId) fail("FORBIDDEN_ORG", "This belongs to another producer");
}

export async function createCropCycle(db: Db, actor: Actor, input: z.infer<typeof CropCycleInput>, now: Date) {
  const [plot] = await db.select().from(plots).where(eq(plots.id, input.plotId));
  if (!plot) fail("NOT_FOUND", "Plot not found");
  requireProducerOf(actor, plot.producerOrgId);

  const [existing] = await db
    .select({ id: cropCycles.id })
    .from(cropCycles)
    .where(and(eq(cropCycles.plotId, plot.id), eq(cropCycles.seasonCode, input.seasonCode)));
  if (existing) fail("CYCLE_ALREADY_EXISTS", "This plot already has a crop cycle for that season");

  const haircutBps = haircutFor(await loadConfigs(db), input.crop);
  const potential = potentialKg(plot.areaM2, input.expectedYieldKgPerHa);
  const state = initialCycleState();
  const [row] = await db
    .insert(cropCycles)
    .values({
      plotId: plot.id,
      producerOrgId: plot.producerOrgId,
      crop: input.crop,
      seasonCode: input.seasonCode,
      expectedYieldKgPerHa: input.expectedYieldKgPerHa,
      areaM2: plot.areaM2,
      potentialKg: potential,
      haircutBps,
      eligibleKg: eligibleKg(potential, haircutBps),
      state,
      stage: state.stage,
      cprStatus: state.cprStatus,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("Crop cycle insert returned no row");
  return row;
}

async function requireOrgKind(db: Db, orgId: string, kind: "WAREHOUSE" | "FINANCIER"): Promise<void> {
  const [org] = await db.select({ kind: orgs.kind }).from(orgs).where(eq(orgs.id, orgId));
  if (!org || org.kind !== kind) fail("VALIDATION_FAILED", `${orgId} is not a ${kind.toLowerCase()}`);
}

export async function createCprRequest(db: Db, actor: Actor, input: z.infer<typeof CprRequestInput>, now: Date) {
  const [cycle] = await db.select().from(cropCycles).where(eq(cropCycles.id, input.cropCycleId));
  if (!cycle) fail("NOT_FOUND", "Crop cycle not found");
  requireProducerOf(actor, cycle.producerOrgId);
  if (cycle.cprStatus !== "NONE") fail("CPR_ALREADY_EXISTS", "This crop cycle already has a CPR");
  const [pending] = await db
    .select({ id: cprRequests.id })
    .from(cprRequests)
    .where(and(eq(cprRequests.cropCycleId, cycle.id), eq(cprRequests.status, "PENDING")));
  if (pending) fail("CPR_ALREADY_EXISTS", "A CPR request for this crop cycle is already pending");
  if (input.requestedKg > cycle.eligibleKg) {
    fail("ISSUED_ABOVE_ELIGIBLE", `Requested ${input.requestedKg} kg exceeds eligible ${cycle.eligibleKg} kg`);
  }
  await requireOrgKind(db, input.warehouseOrgId, "WAREHOUSE");
  await requireOrgKind(db, input.financierOrgId, "FINANCIER");

  const [row] = await db
    .insert(cprRequests)
    .values({ ...input, status: "PENDING", createdBy: actor.userId, createdAt: now })
    .returning();
  if (!row) throw new Error("CPR request insert returned no row");
  return row;
}

async function lockPendingRequest(tx: Db, actor: Actor, requestId: string) {
  const [request] = await tx.select().from(cprRequests).where(eq(cprRequests.id, requestId)).for("update");
  if (!request) fail("NOT_FOUND", "CPR request not found");
  if (actor.role !== "ADMIN") {
    if (actor.role !== "FINANCIER") fail("FORBIDDEN_ROLE", "Only the financier can decide on a CPR request");
    if (actor.orgId !== request.financierOrgId) fail("FORBIDDEN_ORG", "This request is addressed to another financier");
  }
  if (request.status !== "PENDING") fail("INVALID_TRANSITION", `Request is already ${request.status}`);
  return request;
}

/** Approving a request emits CPR_ISSUED, attributed to the request's financier. */
export async function approveCprRequest(
  db: Db,
  actor: Actor,
  requestId: string,
  approval: z.infer<typeof CprApproval>,
  opts: EventOptions & { occurredAt?: string },
) {
  return db.transaction(async (tx) => {
    const request = await lockPendingRequest(tx, actor, requestId);
    if (approval.issuedKg > request.requestedKg) fail("VALIDATION_FAILED", "issuedKg exceeds the requested volume");
    const [cycle] = await tx.select().from(cropCycles).where(eq(cropCycles.id, request.cropCycleId));
    if (!cycle) fail("NOT_FOUND", "Crop cycle not found");

    const event = CanonicalEvent.parse({
      id: approval.eventId,
      subjectType: "CROP_CYCLE",
      subjectId: cycle.id,
      actorRole: "FINANCIER",
      actorOrgId: request.financierOrgId,
      occurredAt: opts.occurredAt ?? opts.now.toISOString(),
      eventType: "CPR_ISSUED",
      quantity: approval.issuedKg,
      unit: "KG",
      evidenceHash: null,
      refEventId: null,
      payload: {
        cprRequestId: request.id,
        cprNumber: approval.cprNumber,
        crop: cycle.crop,
        seasonCode: cycle.seasonCode,
        potentialKg: cycle.potentialKg,
        haircutBps: cycle.haircutBps,
        eligibleKg: cycle.eligibleKg,
        warehouseOrgId: request.warehouseOrgId,
        financierOrgId: request.financierOrgId,
        dueDate: request.dueDate,
        deliveryWindowStart: approval.deliveryWindowStart,
        deliveryWindowEnd: approval.deliveryWindowEnd,
      },
    });
    const result = await recordEventTx(tx, actor, event, { ...opts, allowCprIssued: true });
    const [updated] = await tx
      .update(cprRequests)
      .set({ status: "APPROVED", issuedEventId: event.id, decidedAt: opts.now })
      .where(eq(cprRequests.id, request.id))
      .returning();
    return { request: updated!, event: result };
  });
}

export async function rejectCprRequest(db: Db, actor: Actor, requestId: string, reason: string, now: Date) {
  return db.transaction(async (tx) => {
    const request = await lockPendingRequest(tx, actor, requestId);
    const [updated] = await tx
      .update(cprRequests)
      .set({ status: "REJECTED", decisionReason: reason, decidedAt: now })
      .where(eq(cprRequests.id, request.id))
      .returning();
    return updated!;
  });
}

export async function linkedInsurers(db: Db, cycleId: string) {
  return db
    .select({ id: orgs.id, name: orgs.name, kind: orgs.kind })
    .from(cycleInsurers)
    .innerJoin(orgs, eq(orgs.id, cycleInsurers.insurerOrgId))
    .where(eq(cycleInsurers.cropCycleId, cycleId));
}

/** The producer lets an insurer see the cycle and issue a policy on it. Idempotent. */
export async function linkInsurer(db: Db, actor: Actor, cycleId: string, insurerOrgId: string, now: Date) {
  const [cycle] = await db.select().from(cropCycles).where(eq(cropCycles.id, cycleId));
  if (!cycle) fail("NOT_FOUND", "Crop cycle not found");
  requireProducerOf(actor, cycle.producerOrgId);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, insurerOrgId));
  if (org?.kind !== "INSURER") fail("VALIDATION_FAILED", "insurerOrgId is not an insurer");
  const inserted = await db
    .insert(cycleInsurers)
    .values({ cropCycleId: cycleId, insurerOrgId, linkedBy: actor.userId, createdAt: now })
    .onConflictDoNothing()
    .returning();
  return { created: inserted.length > 0, insurers: await linkedInsurers(db, cycleId) };
}
