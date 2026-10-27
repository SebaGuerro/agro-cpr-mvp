import { and, asc, eq, inArray } from "drizzle-orm";
import type { LedgerKeys } from "../chain/ledger.js";
import type { Db } from "../db/client.js";
import { cprRequests, cropCycles, events, farms, plots } from "../db/schema.js";
import { fulfillment, replayPlot } from "../domain/cycleState.js";
import { fail } from "../domain/errors.js";
import { assessRisk, cycleFindings, type Finding, type RiskAssessment } from "../domain/findings.js";
import type { Actor } from "../domain/types.js";
import { loadConfigs, type Configs } from "./configs.js";
import { cycleFacts, type CycleRow, type EventRow } from "./events.js";

type PlotRow = typeof plots.$inferSelect;

/**
 * Crop cycles the actor may read. The pilot loads all cycles and filters in memory;
 * move this into SQL once there are more than a few thousand.
 */
export async function visibleCycles(db: Db, actor: Actor): Promise<CycleRow[]> {
  const all = await db.select().from(cropCycles).orderBy(asc(cropCycles.createdAt));
  switch (actor.role) {
    case "ADMIN":
      return all;
    case "PRODUCER":
      return all.filter((c) => c.producerOrgId === actor.orgId);
    case "WAREHOUSE":
      return all.filter((c) => c.state.cpr?.warehouseOrgId === actor.orgId);
    case "BUYER":
      return all.filter((c) => c.state.buyerOrgIds.includes(actor.orgId));
    case "FINANCIER": {
      const requested = await db
        .select({ cycleId: cprRequests.cropCycleId })
        .from(cprRequests)
        .where(eq(cprRequests.financierOrgId, actor.orgId));
      const ids = new Set(requested.map((r) => r.cycleId));
      return all.filter((c) => ids.has(c.id) || c.state.cpr?.financierOrgId === actor.orgId);
    }
  }
}

export async function getVisibleCycle(db: Db, actor: Actor, cycleId: string): Promise<CycleRow> {
  const cycle = (await visibleCycles(db, actor)).find((c) => c.id === cycleId);
  // Not found and not visible look the same, so ids of other orgs' cycles don't leak.
  if (!cycle) fail("NOT_FOUND", "Crop cycle not found");
  return cycle;
}

export async function visiblePlots(db: Db, actor: Actor): Promise<PlotRow[]> {
  const all = await db.select().from(plots).orderBy(asc(plots.createdAt));
  if (actor.role === "ADMIN") return all;
  if (actor.role === "PRODUCER") return all.filter((p) => p.producerOrgId === actor.orgId);
  const ids = new Set((await visibleCycles(db, actor)).map((c) => c.plotId));
  return all.filter((p) => ids.has(p.id));
}

export async function getVisiblePlot(db: Db, actor: Actor, plotId: string): Promise<PlotRow> {
  const plot = (await visiblePlots(db, actor)).find((p) => p.id === plotId);
  if (!plot) fail("NOT_FOUND", "Plot not found");
  return plot;
}

export async function visibleFarms(db: Db, actor: Actor) {
  const all = await db.select().from(farms).orderBy(asc(farms.createdAt));
  if (actor.role === "ADMIN") return all;
  if (actor.role === "PRODUCER") return all.filter((f) => f.producerOrgId === actor.orgId);
  const ids = new Set((await visiblePlots(db, actor)).map((p) => p.farmId));
  return all.filter((f) => ids.has(f.id));
}

// ---------- risk ----------

export interface RiskDeps {
  now: Date;
  toleranceBps: number;
}

export interface CycleAnalysis {
  findings: Finding[];
  risk: RiskAssessment;
}

/** Findings and risk for many cycles, loading plots and configs once. */
export async function analyzeCycles(
  db: Db,
  cycles: CycleRow[],
  deps: RiskDeps,
  configs?: Configs,
): Promise<Map<string, CycleAnalysis>> {
  const cfg = configs ?? (await loadConfigs(db));
  const plotIds = [...new Set(cycles.map((c) => c.plotId))];
  const plotRows = plotIds.length ? await db.select().from(plots).where(inArray(plots.id, plotIds)) : [];
  const plotById = new Map(plotRows.map((p) => [p.id, p]));
  const result = new Map<string, CycleAnalysis>();
  for (const c of cycles) {
    const plot = plotById.get(c.plotId);
    if (!plot) continue;
    const findings = cycleFindings({
      cycle: cycleFacts(c),
      plot,
      state: c.state,
      windows: cfg.windows,
      templates: cfg.templates,
      discountTables: cfg.discountTables,
      toleranceBps: deps.toleranceBps,
      now: deps.now,
    });
    result.set(c.id, { findings, risk: assessRisk(findings, deps.now) });
  }
  return result;
}

// ---------- response shapes (see openapi.yaml) ----------

export function cropCycleView(c: CycleRow, risk: RiskAssessment, keys: LedgerKeys) {
  const s = c.state;
  return {
    id: c.id,
    plotId: c.plotId,
    producerOrgId: c.producerOrgId,
    crop: c.crop,
    seasonCode: c.seasonCode,
    areaM2: c.areaM2,
    expectedYieldKgPerHa: c.expectedYieldKgPerHa,
    potentialKg: c.potentialKg,
    haircutBps: c.haircutBps,
    eligibleKg: c.eligibleKg,
    stage: s.stage,
    cpr: {
      status: s.cprStatus,
      tokenId: s.cpr ? keys.tokenId(c.plotId, c.seasonCode) : null,
      cprNumber: s.cpr?.cprNumber ?? null,
      issuedKg: s.cpr?.issuedKg ?? null,
      dueDate: s.cpr?.dueDate ?? null,
      warehouseOrgId: s.cpr?.warehouseOrgId ?? null,
      financierOrgId: s.cpr?.financierOrgId ?? null,
      fundedBrlCents: s.fundedBrlCents,
    },
    fulfillment: fulfillment(s),
    risk: { grade: risk.grade, score: risk.score },
  };
}

export function eventRecordView(row: EventRow, voided: boolean, correctedBy: string[]) {
  return {
    ...row.body,
    anchor: {
      status: row.anchorStatus,
      recordHash: row.recordHash,
      chainId: row.chainId,
      txHash: row.txHash,
      blockNumber: row.blockNumber,
      anchoredAt: row.anchoredAt?.toISOString() ?? null,
    },
    voided,
    correctedBy,
    provenance: row.importBatchId ? "IMPORTED" : "MANUAL",
    importBatchId: row.importBatchId,
  };
}

/** All events of a subject, ordered by when they happened, with void/correction links. */
export async function subjectEventViews(db: Db, subjectId: string) {
  const rows = await db.select().from(events).where(eq(events.subjectId, subjectId)).orderBy(asc(events.seq));
  return eventViewsFor(rows).sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
  );
}

export function eventViewsFor(rows: EventRow[]) {
  const voided = new Set<string>();
  const correctedBy = new Map<string, string[]>();
  for (const r of rows) {
    if (r.eventType === "EVENT_VOIDED" && r.refEventId) voided.add(r.refEventId);
    if (r.eventType === "EVENT_CORRECTED" && r.refEventId) {
      correctedBy.set(r.refEventId, [...(correctedBy.get(r.refEventId) ?? []), r.id]);
    }
  }
  return rows.map((r) => eventRecordView(r, voided.has(r.id), correctedBy.get(r.id) ?? []));
}

export async function eventView(db: Db, row: EventRow) {
  const related = await db
    .select()
    .from(events)
    .where(and(eq(events.subjectId, row.subjectId), eq(events.refEventId, row.id)));
  return eventViewsFor([row, ...related])[0]!;
}

export async function plotViews(db: Db, rows: PlotRow[]) {
  const ids = rows.map((p) => p.id);
  const streamRows = ids.length
    ? await db.select({ subjectId: events.subjectId, body: events.body }).from(events).where(inArray(events.subjectId, ids)).orderBy(asc(events.seq))
    : [];
  return rows.map((p) => {
    const soil = replayPlot(streamRows.filter((r) => r.subjectId === p.id).map((r) => r.body)).soilAnalyses;
    const latest = soil.map((s) => s.sampledOn).sort().at(-1) ?? null;
    return {
      id: p.id,
      farmId: p.farmId,
      name: p.name,
      areaM2: p.areaM2,
      carCode: p.carCode,
      uf: p.uf,
      municipalityIbge: p.municipalityIbge,
      hasSoilAnalysis: soil.length > 0,
      latestSoilAnalysisOn: latest,
    };
  });
}
