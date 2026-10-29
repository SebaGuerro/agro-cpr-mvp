import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { actorOf, parse, type AppDeps } from "../app.js";
import { alerts, cprRequests, orgs } from "../db/schema.js";
import { fail } from "../domain/errors.js";
import { syncCycleAlerts } from "../services/alerts.js";
import {
  approveCprRequest,
  CprApproval,
  CprRequestInput,
  createCprRequest,
  createCropCycle,
  CropCycleInput,
  linkedInsurers,
  linkInsurer,
  rejectCprRequest,
} from "../services/cycles.js";
import {
  analyzeCycles,
  cropCycleView,
  eventRecordView,
  getVisibleCycle,
  subjectEventViews,
  visibleCycles,
} from "../services/views.js";

const CycleParams = z.object({ cycleId: z.uuid() });
const RequestParams = z.object({ requestId: z.uuid() });
const CycleFilters = z.object({
  stage: z.string().optional(),
  cprStatus: z.string().optional(),
  grade: z.enum(["A", "B", "C", "D"]).optional(),
});

export const cycleRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db, keys } = deps;
    const riskDeps = () => ({ now: deps.now(), toleranceBps: deps.toleranceBps });

    app.get("/v1/crop-cycles", async (req) => {
      const filters = parse(CycleFilters, req.query);
      const cycles = (await visibleCycles(db, actorOf(req))).filter(
        (c) => (!filters.stage || c.stage === filters.stage) && (!filters.cprStatus || c.cprStatus === filters.cprStatus),
      );
      const analyses = await analyzeCycles(db, cycles, riskDeps());
      const items = cycles
        .map((c) => cropCycleView(c, analyses.get(c.id)!.risk, keys))
        .filter((v) => !filters.grade || v.risk.grade === filters.grade);
      return { items, nextCursor: null };
    });

    app.post("/v1/crop-cycles", async (req, reply) => {
      const cycle = await createCropCycle(db, actorOf(req), parse(CropCycleInput, req.body), deps.now());
      const analyses = await analyzeCycles(db, [cycle], riskDeps());
      return reply.code(201).send(cropCycleView(cycle, analyses.get(cycle.id)!.risk, keys));
    });

    app.get("/v1/crop-cycles/:cycleId", async (req) => {
      const { cycleId } = parse(CycleParams, req.params);
      const cycle = await getVisibleCycle(db, actorOf(req), cycleId);
      const analyses = await analyzeCycles(db, [cycle], riskDeps());
      return cropCycleView(cycle, analyses.get(cycle.id)!.risk, keys);
    });

    app.get("/v1/crop-cycles/:cycleId/timeline", async (req) => {
      const { cycleId } = parse(CycleParams, req.params);
      const cycle = await getVisibleCycle(db, actorOf(req), cycleId);
      const s = cycle.state;
      return {
        subjectType: "CROP_CYCLE",
        subjectId: cycle.id,
        events: await subjectEventViews(db, cycle.id),
        planned: {
          harvestStart: s.harvestPlan?.plannedStart ?? null,
          harvestEnd: s.harvestPlan?.plannedEnd ?? null,
          deliveryWindowEnd: s.cpr?.deliveryWindowEnd ?? null,
          cprDueDate: s.cpr?.dueDate ?? null,
        },
      };
    });

    app.get("/v1/crop-cycles/:cycleId/risk", async (req) => {
      const { cycleId } = parse(CycleParams, req.params);
      const cycle = await getVisibleCycle(db, actorOf(req), cycleId);
      return (await analyzeCycles(db, [cycle], riskDeps())).get(cycle.id)!.risk;
    });

    app.get("/v1/crop-cycles/:cycleId/insurers", async (req) => {
      const { cycleId } = parse(CycleParams, req.params);
      await getVisibleCycle(db, actorOf(req), cycleId);
      return linkedInsurers(db, cycleId);
    });

    app.post("/v1/crop-cycles/:cycleId/insurers", async (req, reply) => {
      const actor = actorOf(req);
      const { cycleId } = parse(CycleParams, req.params);
      const { insurerOrgId } = parse(z.object({ insurerOrgId: z.uuid() }), req.body);
      await getVisibleCycle(db, actor, cycleId);
      const result = await linkInsurer(db, actor, cycleId, insurerOrgId, deps.now());
      return reply.code(result.created ? 201 : 200).send(result.insurers);
    });

    // ---------- CPR requests ----------

    app.get("/v1/cpr-requests", async (req) => {
      const actor = actorOf(req);
      const { status } = parse(z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional() }), req.query);
      const rows = await db.select().from(cprRequests).orderBy(desc(cprRequests.createdAt));
      const visible = new Set((await visibleCycles(db, actor)).map((c) => c.id));
      return rows.filter(
        (r) =>
          (!status || r.status === status) &&
          (actor.role === "ADMIN" ||
            (actor.role === "FINANCIER" && r.financierOrgId === actor.orgId) ||
            (actor.role === "PRODUCER" && visible.has(r.cropCycleId))),
      );
    });

    app.post("/v1/cpr-requests", async (req, reply) => {
      const row = await createCprRequest(db, actorOf(req), parse(CprRequestInput, req.body), deps.now());
      return reply.code(201).send(row);
    });

    app.post("/v1/cpr-requests/:requestId/approve", async (req) => {
      const { requestId } = parse(RequestParams, req.params);
      const result = await approveCprRequest(db, actorOf(req), requestId, parse(CprApproval, req.body), {
        now: deps.now(),
        toleranceBps: deps.toleranceBps,
      });
      await syncCycleAlerts(db, [result.request.cropCycleId], riskDeps());
      deps.onEventRecorded?.();
      return { ...result.request, issuedEvent: eventRecordView(result.event.row, false, []) };
    });

    app.post("/v1/cpr-requests/:requestId/reject", async (req) => {
      const { requestId } = parse(RequestParams, req.params);
      const { reason } = parse(z.object({ reason: z.string().min(5).max(500) }), req.body);
      return rejectCprRequest(db, actorOf(req), requestId, reason, deps.now());
    });

    // ---------- role dashboards ----------

    app.get("/v1/portfolio", async (req) => {
      const actor = actorOf(req);
      if (actor.role !== "FINANCIER" && actor.role !== "ADMIN") fail("FORBIDDEN_ROLE", "Financiers only");
      const cycles = (await visibleCycles(db, actor)).filter(
        (c) => c.state.cpr && (actor.role === "ADMIN" || c.state.cpr.financierOrgId === actor.orgId),
      );
      const analyses = await analyzeCycles(db, cycles, riskDeps());
      const byGrade = { A: 0, B: 0, C: 0, D: 0 };
      for (const c of cycles) byGrade[analyses.get(c.id)!.risk.grade] += 1;
      const openHigh = cycles.length
        ? await db
            .select({ id: alerts.id })
            .from(alerts)
            .where(
              and(
                inArray(alerts.cropCycleId, cycles.map((c) => c.id)),
                eq(alerts.severity, "HIGH"),
                isNull(alerts.resolvedAt),
              ),
            )
        : [];
      return {
        cprCount: cycles.length,
        issuedKg: cycles.reduce((sum, c) => sum + (c.state.cpr?.issuedKg ?? 0), 0),
        deliveredNetKg: cycles.reduce((sum, c) => sum + c.state.receivedNetKg, 0),
        fundedBrlCents: cycles.reduce((sum, c) => sum + c.state.fundedBrlCents, 0),
        byGrade,
        openHighAlerts: openHigh.length,
      };
    });

    app.get("/v1/warehouses/:warehouseOrgId/expected-arrivals", async (req) => {
      const actor = actorOf(req);
      const { warehouseOrgId } = parse(z.object({ warehouseOrgId: z.uuid() }), req.params);
      if (actor.role !== "ADMIN" && !(actor.role === "WAREHOUSE" && actor.orgId === warehouseOrgId)) {
        fail("FORBIDDEN_ORG", "You can only see arrivals for your own warehouse");
      }
      const cycles = (await visibleCycles(db, actor)).filter((c) => c.state.cpr?.warehouseOrgId === warehouseOrgId);
      const producerIds = [...new Set(cycles.map((c) => c.producerOrgId))];
      const producers = producerIds.length ? await db.select().from(orgs).where(inArray(orgs.id, producerIds)) : [];
      const nameOf = new Map(producers.map((o) => [o.id, o.name]));
      return cycles.flatMap((c) =>
        c.state.deliveries
          .filter((d) => !d.received)
          .map((d) => ({
            deliveryId: d.deliveryId,
            cropCycleId: c.id,
            producerName: nameOf.get(c.producerOrgId) ?? "",
            truckPlate: d.truckPlate,
            estimatedKg: d.estimatedKg,
            expectedArrivalAt: d.expectedArrivalAt,
            arrived: d.arrivedAt !== null,
          })),
      );
    });
  };
