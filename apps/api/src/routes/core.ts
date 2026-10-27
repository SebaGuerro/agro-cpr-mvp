import { Uf } from "@agro-cpr/spec";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { actorOf, parse, type AppDeps } from "../app.js";
import { farms, orgs } from "../db/schema.js";
import { fail } from "../domain/errors.js";
import { getVisiblePlot, plotViews, subjectEventViews, visibleFarms, visiblePlots } from "../services/views.js";

const FarmInput = z.object({
  name: z.string().min(1).max(120),
  uf: Uf,
  municipalityIbge: z.string().regex(/^\d{7}$/),
  producerOrgId: z.uuid().optional(),
});
const PlotParams = z.object({ plotId: z.uuid() });

export const coreRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.get("/v1/me", async (req) => {
      const actor = actorOf(req);
      const [org] = await db.select().from(orgs).where(eq(orgs.id, actor.orgId));
      return { userId: actor.userId, orgId: actor.orgId, orgName: org?.name ?? "", role: actor.role };
    });

    app.get("/v1/farms", async (req) => {
      const items = await visibleFarms(db, actorOf(req));
      return { items, nextCursor: null };
    });

    app.post("/v1/farms", async (req, reply) => {
      const actor = actorOf(req);
      const input = parse(FarmInput, req.body);
      let producerOrgId = actor.orgId;
      if (actor.role === "ADMIN") {
        if (!input.producerOrgId) fail("VALIDATION_FAILED", "producerOrgId is required when an admin creates a farm");
        const [org] = await db.select().from(orgs).where(eq(orgs.id, input.producerOrgId));
        if (org?.kind !== "PRODUCER") fail("VALIDATION_FAILED", "producerOrgId is not a producer");
        producerOrgId = input.producerOrgId;
      } else if (actor.role !== "PRODUCER") {
        fail("FORBIDDEN_ROLE", "Only producers can create farms");
      }
      const [farm] = await db
        .insert(farms)
        .values({ name: input.name, uf: input.uf, municipalityIbge: input.municipalityIbge, producerOrgId, createdAt: deps.now() })
        .returning();
      return reply.code(201).send(farm);
    });

    app.get("/v1/plots", async (req) => {
      const { farmId } = parse(z.object({ farmId: z.uuid().optional() }), req.query);
      const rows = (await visiblePlots(db, actorOf(req))).filter((p) => !farmId || p.farmId === farmId);
      return { items: await plotViews(db, rows), nextCursor: null };
    });

    app.get("/v1/plots/:plotId", async (req) => {
      const { plotId } = parse(PlotParams, req.params);
      const plot = await getVisiblePlot(db, actorOf(req), plotId);
      return (await plotViews(db, [plot]))[0];
    });

    app.get("/v1/plots/:plotId/timeline", async (req) => {
      const { plotId } = parse(PlotParams, req.params);
      await getVisiblePlot(db, actorOf(req), plotId);
      return { subjectType: "PLOT", subjectId: plotId, events: await subjectEventViews(db, plotId), planned: {} };
    });
  };
