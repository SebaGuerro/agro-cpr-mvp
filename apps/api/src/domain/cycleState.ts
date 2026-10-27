import { CanonicalEvent, type StoredEvent } from "@agro-cpr/spec";
import { ApiError, fail } from "./errors.js";
import { isFulfilled } from "./quantities.js";
import type { CprStatus, CycleFacts, CycleStage } from "./types.js";

export interface Delivery {
  deliveryId: string;
  dispatchedEventId: string;
  truckPlate: string;
  estimatedKg: number;
  expectedArrivalAt: string;
  warehouseOrgId: string;
  arrivedAt: string | null;
  received: null | {
    eventId: string;
    ticketNumber: string;
    grossKg: number;
    moisturePct: number;
    impurityPct: number;
    damagedPct: number;
    discountKg: number;
    netKg: number;
    receivedAt: string;
  };
}

/** Everything known about a crop cycle, derived by replaying its events. JSON-serializable. */
export interface CycleState {
  stage: CycleStage;
  cprStatus: CprStatus;
  cpr: null | {
    eventId: string;
    cprNumber: string;
    issuedKg: number;
    eligibleKg: number;
    potentialKg: number;
    haircutBps: number;
    warehouseOrgId: string;
    financierOrgId: string;
    dueDate: string;
    deliveryWindowStart: string;
    deliveryWindowEnd: string;
    issuedAt: string;
  };
  fundedBrlCents: number;
  planting: null | {
    eventId: string;
    cultivar: string;
    cycleDays: number;
    startedOn: string;
    finishedOn: string;
    plantedAreaM2: number;
  };
  applications: { eventId: string; checklistItemId: string | null; category: string; appliedOn: string }[];
  harvestPlan: null | { eventId: string; plannedStart: string; plannedEnd: string; expectedKg: number };
  harvest: null | { eventId: string; startedOn: string; withoutPlan: boolean };
  deliveries: Delivery[];
  receivedNetKg: number;
  cdas: { eventId: string; cdaNumber: string; waNumber: string; kg: number }[];
  cdaKg: number;
  releasedKg: number;
  soldKg: number;
  buyerOrgIds: string[];
  infoRequests: { eventId: string; requestedFromOrgId: string; topic: string; dueDate: string | null; requestedAt: string }[];
  settlement: null | {
    eventId: string;
    outcome: "FULLY_DELIVERED" | "PARTIALLY_DELIVERED_CASH_SETTLED";
    settledOn: string;
    deliveredKg: number;
    cashSettledBrlCents: number | null;
  };
}

export interface ReplayContext {
  cycle: CycleFacts;
  toleranceBps: number;
}

export function initialCycleState(): CycleState {
  return {
    stage: "CREATED",
    cprStatus: "NONE",
    cpr: null,
    fundedBrlCents: 0,
    planting: null,
    applications: [],
    harvestPlan: null,
    harvest: null,
    deliveries: [],
    receivedNetKg: 0,
    cdas: [],
    cdaKg: 0,
    releasedKg: 0,
    soldKg: 0,
    buyerOrgIds: [],
    infoRequests: [],
    settlement: null,
  };
}

function requireStage(s: CycleState, allowed: CycleStage[], eventType: string): void {
  if (!allowed.includes(s.stage)) {
    fail("INVALID_TRANSITION", `${eventType} is not allowed at stage ${s.stage}`);
  }
}

/** Applies one (non-correction) event to the state, or throws ApiError if the transition is invalid. */
export function applyCycleEvent(prev: CycleState, e: StoredEvent, ctx: ReplayContext): CycleState {
  const s = structuredClone(prev);
  if (s.stage === "CLOSED" && e.eventType !== "INFO_REQUESTED") {
    fail("INVALID_TRANSITION", `${e.eventType} is not allowed after the CPR is settled`);
  }

  switch (e.eventType) {
    case "CPR_ISSUED": {
      requireStage(s, ["CREATED", "PLANTED"], e.eventType);
      if (s.cprStatus !== "NONE") fail("CPR_ALREADY_EXISTS", "This crop cycle already has a CPR");
      const p = e.payload;
      if (p.crop !== ctx.cycle.crop || p.seasonCode !== ctx.cycle.seasonCode) {
        fail("VALIDATION_FAILED", "CPR crop and season must match the crop cycle");
      }
      if (p.eligibleKg !== ctx.cycle.eligibleKg) fail("VALIDATION_FAILED", "eligibleKg must match the crop cycle");
      if (e.quantity > ctx.cycle.eligibleKg) {
        fail("ISSUED_ABOVE_ELIGIBLE", `Issued ${e.quantity} kg exceeds eligible ${ctx.cycle.eligibleKg} kg`);
      }
      if (p.deliveryWindowEnd < p.deliveryWindowStart) fail("VALIDATION_FAILED", "Delivery window ends before it starts");
      s.cprStatus = "ISSUED";
      s.cpr = {
        eventId: e.id,
        cprNumber: p.cprNumber,
        issuedKg: e.quantity,
        eligibleKg: p.eligibleKg,
        potentialKg: p.potentialKg,
        haircutBps: p.haircutBps,
        warehouseOrgId: p.warehouseOrgId,
        financierOrgId: p.financierOrgId,
        dueDate: p.dueDate,
        deliveryWindowStart: p.deliveryWindowStart,
        deliveryWindowEnd: p.deliveryWindowEnd,
        issuedAt: e.occurredAt,
      };
      return s;
    }

    case "FUNDING_DISBURSED": {
      if (s.cprStatus !== "ISSUED" && s.cprStatus !== "FUNDED") {
        fail("INVALID_TRANSITION", "Funding needs an issued CPR");
      }
      if (e.payload.financierOrgId !== s.cpr?.financierOrgId) {
        fail("VALIDATION_FAILED", "Funding must come from the CPR's financier");
      }
      s.cprStatus = "FUNDED";
      s.fundedBrlCents += e.quantity;
      return s;
    }

    case "PLANTING_RECORDED": {
      requireStage(s, ["CREATED"], e.eventType);
      const p = e.payload;
      if (p.crop !== ctx.cycle.crop) fail("VALIDATION_FAILED", "Planted crop must match the crop cycle");
      if (p.finishedOn < p.startedOn) fail("VALIDATION_FAILED", "Planting finishes before it starts");
      if (e.quantity > ctx.cycle.areaM2) fail("VALIDATION_FAILED", "Planted area exceeds the plot area");
      s.planting = {
        eventId: e.id,
        cultivar: p.cultivar,
        cycleDays: p.cycleDays,
        startedOn: p.startedOn,
        finishedOn: p.finishedOn,
        plantedAreaM2: e.quantity,
      };
      s.stage = "PLANTED";
      return s;
    }

    case "INPUT_APPLICATION_RECORDED": {
      // Before planting too: seed treatment and burndown are applied ahead of it.
      requireStage(s, ["CREATED", "PLANTED", "HARVEST_PLANNED", "HARVESTING"], e.eventType);
      s.applications.push({
        eventId: e.id,
        checklistItemId: e.payload.checklistItemId,
        category: e.payload.category,
        appliedOn: e.payload.appliedOn,
      });
      return s;
    }

    case "HARVEST_PLANNED": {
      requireStage(s, ["PLANTED", "HARVEST_PLANNED"], e.eventType);
      if (e.payload.plannedEnd < e.payload.plannedStart) fail("VALIDATION_FAILED", "Harvest ends before it starts");
      s.harvestPlan = {
        eventId: e.id,
        plannedStart: e.payload.plannedStart,
        plannedEnd: e.payload.plannedEnd,
        expectedKg: e.quantity,
      };
      s.stage = "HARVEST_PLANNED";
      return s;
    }

    case "HARVEST_STARTED": {
      requireStage(s, ["PLANTED", "HARVEST_PLANNED"], e.eventType);
      s.harvest = { eventId: e.id, startedOn: e.payload.startedOn, withoutPlan: s.harvestPlan === null };
      s.stage = "HARVESTING";
      return s;
    }

    case "TRUCK_DISPATCHED": {
      requireStage(s, ["HARVESTING", "DELIVERING", "DELIVERED"], e.eventType);
      if (!s.cpr || s.cprStatus === "SETTLED") fail("INVALID_TRANSITION", "Trucks can only be dispatched against an open CPR");
      const p = e.payload;
      if (p.warehouseOrgId !== s.cpr.warehouseOrgId) {
        fail("WRONG_WAREHOUSE", "Grain must go to the CPR's designated warehouse");
      }
      if (s.deliveries.some((d) => d.deliveryId === p.deliveryId)) {
        fail("INVALID_TRANSITION", "This delivery was already dispatched");
      }
      s.deliveries.push({
        deliveryId: p.deliveryId,
        dispatchedEventId: e.id,
        truckPlate: p.truckPlate,
        estimatedKg: e.quantity,
        expectedArrivalAt: p.expectedArrivalAt,
        warehouseOrgId: p.warehouseOrgId,
        arrivedAt: null,
        received: null,
      });
      if (s.stage === "HARVESTING") s.stage = "DELIVERING";
      return s;
    }

    case "TRUCK_ARRIVED": {
      const d = s.deliveries.find((x) => x.deliveryId === e.payload.deliveryId);
      if (!d) fail("DELIVERY_NOT_FOUND", "No truck was dispatched with this deliveryId");
      if (d.arrivedAt) fail("INVALID_TRANSITION", "This truck already arrived");
      if (d.truckPlate !== e.payload.truckPlate) fail("VALIDATION_FAILED", "Truck plate differs from the dispatch");
      d.arrivedAt = e.occurredAt;
      return s;
    }

    case "GRAIN_RECEIVED": {
      const p = e.payload;
      const d = s.deliveries.find((x) => x.deliveryId === p.deliveryId);
      if (!d) fail("DELIVERY_NOT_FOUND", "No truck was dispatched with this deliveryId");
      if (!d.arrivedAt) fail("INVALID_TRANSITION", "Record the truck's arrival first");
      if (d.received) fail("INVALID_TRANSITION", "This truck was already received");
      if (p.netKg !== p.grossKg - p.discountKg || e.quantity !== p.netKg) {
        fail("VALIDATION_FAILED", "netKg must equal grossKg - discountKg and the event quantity");
      }
      d.received = {
        eventId: e.id,
        ticketNumber: p.ticketNumber,
        grossKg: p.grossKg,
        moisturePct: p.moisturePct,
        impurityPct: p.impurityPct,
        damagedPct: p.damagedPct,
        discountKg: p.discountKg,
        netKg: p.netKg,
        receivedAt: e.occurredAt,
      };
      s.receivedNetKg += p.netKg;
      if (s.stage === "DELIVERING" && s.cpr && isFulfilled(s.receivedNetKg, s.cpr.issuedKg, ctx.toleranceBps)) {
        s.stage = "DELIVERED";
      }
      return s;
    }

    case "CDA_ISSUED": {
      if (s.receivedNetKg === 0) fail("INVALID_TRANSITION", "A CDA needs received grain");
      if (s.cdaKg + e.quantity > s.receivedNetKg) {
        fail("QUANTITY_EXCEEDS_AVAILABLE", "CDA volume exceeds the net grain received");
      }
      s.cdas.push({ eventId: e.id, cdaNumber: e.payload.cdaNumber, waNumber: e.payload.waNumber, kg: e.quantity });
      s.cdaKg += e.quantity;
      return s;
    }

    case "GRAIN_RELEASED": {
      if (!s.cdas.some((c) => c.cdaNumber === e.payload.cdaNumber)) fail("VALIDATION_FAILED", "Unknown CDA number");
      if (s.releasedKg + e.quantity > s.cdaKg) fail("QUANTITY_EXCEEDS_AVAILABLE", "Release exceeds the CDA volume");
      s.releasedKg += e.quantity;
      if (!s.buyerOrgIds.includes(e.payload.releasedToOrgId)) s.buyerOrgIds.push(e.payload.releasedToOrgId);
      return s;
    }

    case "SALE_RECORDED": {
      if (s.receivedNetKg === 0) fail("INVALID_TRANSITION", "A sale needs received grain");
      if (s.soldKg + e.quantity > s.receivedNetKg) fail("QUANTITY_EXCEEDS_AVAILABLE", "Sale exceeds the net grain received");
      s.soldKg += e.quantity;
      if (!s.buyerOrgIds.includes(e.payload.buyerOrgId)) s.buyerOrgIds.push(e.payload.buyerOrgId);
      return s;
    }

    case "INFO_REQUESTED": {
      s.infoRequests.push({
        eventId: e.id,
        requestedFromOrgId: e.payload.requestedFromOrgId,
        topic: e.payload.topic,
        dueDate: e.payload.dueDate,
        requestedAt: e.occurredAt,
      });
      return s;
    }

    case "CPR_SETTLED": {
      if (s.cprStatus !== "ISSUED" && s.cprStatus !== "FUNDED") fail("INVALID_TRANSITION", "No open CPR to settle");
      const p = e.payload;
      if (p.outcome === "FULLY_DELIVERED") requireStage(s, ["DELIVERED"], `${e.eventType} (FULLY_DELIVERED)`);
      else requireStage(s, ["DELIVERING", "DELIVERED"], `${e.eventType} (partial)`);
      if (e.quantity !== s.receivedNetKg) fail("VALIDATION_FAILED", "Settled quantity must equal the net grain received");
      s.cprStatus = "SETTLED";
      s.stage = "CLOSED";
      s.settlement = {
        eventId: e.id,
        outcome: p.outcome,
        settledOn: p.settledOn,
        deliveredKg: e.quantity,
        cashSettledBrlCents: p.cashSettledBrlCents,
      };
      return s;
    }

    case "PLOT_REGISTERED":
    case "SOIL_ANALYSIS_ATTACHED":
    case "EVENT_CORRECTED":
    case "EVENT_VOIDED":
      return fail("VALIDATION_FAILED", `${e.eventType} cannot be applied to a crop cycle`);
  }
}

export interface PlotState {
  registered: boolean;
  soilAnalyses: { eventId: string; sampledOn: string }[];
}

export function applyPlotEvent(prev: PlotState, e: StoredEvent): PlotState {
  const s = structuredClone(prev);
  switch (e.eventType) {
    case "PLOT_REGISTERED":
      if (s.registered) fail("INVALID_TRANSITION", "Plot is already registered");
      s.registered = true;
      return s;
    case "SOIL_ANALYSIS_ATTACHED":
      if (!s.registered) fail("INVALID_TRANSITION", "Register the plot first");
      s.soilAnalyses.push({ eventId: e.id, sampledOn: e.payload.sampledOn });
      return s;
    default:
      return fail("VALIDATION_FAILED", `${e.eventType} cannot be applied to a plot`);
  }
}

function withoutMeta(e: StoredEvent): unknown {
  const { recordedAt: _a, recordedBy: _b, ...event } = e;
  return event;
}

/**
 * The events that count: voided ones removed, corrections merged into their target.
 * A corrected event must still satisfy its schema.
 */
export function effectiveEvents(stream: StoredEvent[]): StoredEvent[] {
  const voided = new Set<string>();
  for (const e of stream) if (e.eventType === "EVENT_VOIDED") voided.add(e.refEventId);

  const corrections = new Map<string, Extract<StoredEvent, { eventType: "EVENT_CORRECTED" }>[]>();
  for (const e of stream) {
    if (e.eventType !== "EVENT_CORRECTED" || voided.has(e.id)) continue;
    const list = corrections.get(e.refEventId) ?? [];
    list.push(e);
    corrections.set(e.refEventId, list);
  }

  const result: StoredEvent[] = [];
  for (const e of stream) {
    if (e.eventType === "EVENT_CORRECTED" || e.eventType === "EVENT_VOIDED" || voided.has(e.id)) continue;
    let merged: StoredEvent = e;
    for (const c of corrections.get(e.id) ?? []) {
      const fix = c.payload.corrected;
      const candidate = {
        ...(withoutMeta(merged) as Record<string, unknown>),
        ...(fix.quantity !== undefined && { quantity: fix.quantity }),
        ...(fix.occurredAt !== undefined && { occurredAt: fix.occurredAt }),
        ...(fix.evidenceHash !== undefined && { evidenceHash: fix.evidenceHash }),
        payload: { ...(merged.payload as Record<string, unknown>), ...fix.payload },
      };
      const parsed = CanonicalEvent.safeParse(candidate);
      if (!parsed.success) {
        throw new ApiError(
          "CORRECTION_BREAKS_STREAM",
          `Correction ${c.id} makes event ${e.id} invalid`,
          parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
        );
      }
      merged = { ...parsed.data, recordedAt: merged.recordedAt, recordedBy: merged.recordedBy };
    }
    result.push(merged);
  }
  return result;
}

export function replayCycle(stream: StoredEvent[], ctx: ReplayContext): CycleState {
  return effectiveEvents(stream).reduce((s, e) => applyCycleEvent(s, e, ctx), initialCycleState());
}

export function replayPlot(stream: StoredEvent[]): PlotState {
  return effectiveEvents(stream).reduce(applyPlotEvent, { registered: false, soilAnalyses: [] });
}

/** Total kg pledged and delivered, for display. */
export function fulfillment(s: CycleState) {
  const pledgedKg = s.cpr?.issuedKg ?? 0;
  return {
    pledgedKg,
    deliveredNetKg: s.receivedNetKg,
    fulfilledBps: pledgedKg > 0 ? Math.floor((s.receivedNetKg * 10_000) / pledgedKg) : 0,
    trucksInTransit: s.deliveries.filter((d) => !d.received).length,
  };
}
