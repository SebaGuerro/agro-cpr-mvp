import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { actorOf, parse, type AppDeps } from "../app.js";
import { alerts } from "../db/schema.js";
import { fail } from "../domain/errors.js";
import { visibleCycles } from "../services/views.js";

const AlertQuery = z.object({
  open: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  cycleId: z.uuid().optional(),
});

function alertView(a: typeof alerts.$inferSelect) {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    cropCycleId: a.cropCycleId,
    eventId: a.eventId,
    message: a.message,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    ackedAt: a.ackedAt?.toISOString() ?? null,
    ackedBy: a.ackedBy,
  };
}

export const alertRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.get("/v1/alerts", async (req) => {
      const actor = actorOf(req);
      const q = parse(AlertQuery, req.query);
      const ids = (await visibleCycles(db, actor)).map((c) => c.id).filter((id) => !q.cycleId || id === q.cycleId);
      if (!ids.length) return [];
      const rows = await db
        .select()
        .from(alerts)
        .where(and(inArray(alerts.cropCycleId, ids), q.open ? isNull(alerts.resolvedAt) : undefined))
        .orderBy(desc(alerts.createdAt));
      return rows.map(alertView);
    });

    app.post("/v1/alerts/:alertId/ack", async (req) => {
      const actor = actorOf(req);
      const { alertId } = parse(z.object({ alertId: z.uuid() }), req.params);
      const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId));
      const visible = new Set((await visibleCycles(db, actor)).map((c) => c.id));
      if (!alert || !alert.cropCycleId || !visible.has(alert.cropCycleId)) fail("NOT_FOUND", "Alert not found");
      const [updated] = await db
        .update(alerts)
        .set({ ackedAt: deps.now(), ackedBy: actor.userId })
        .where(eq(alerts.id, alertId))
        .returning();
      return alertView(updated!);
    });
  };
