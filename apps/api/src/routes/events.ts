import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { actorOf, parse, type AppDeps } from "../app.js";
import { events, files } from "../db/schema.js";
import { fail } from "../domain/errors.js";
import { syncCycleAlerts } from "../services/alerts.js";
import { recordEvent } from "../services/events.js";
import { eventView, getVisibleCycle, getVisiblePlot } from "../services/views.js";

export const eventRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.post("/v1/events", async (req, reply) => {
      const now = deps.now();
      const result = await recordEvent(db, actorOf(req), req.body, { now, toleranceBps: deps.toleranceBps });
      if (result.created) {
        if (result.cycleId) await syncCycleAlerts(db, [result.cycleId], { now, toleranceBps: deps.toleranceBps });
        deps.onEventRecorded?.();
      }
      return reply.code(result.created ? 201 : 200).send(await eventView(db, result.row));
    });

    app.get("/v1/events/:eventId", async (req) => {
      const actor = actorOf(req);
      const { eventId } = parse(z.object({ eventId: z.uuid() }), req.params);
      const [row] = await db.select().from(events).where(eq(events.id, eventId));
      if (!row) fail("NOT_FOUND", "Event not found");
      if (row.subjectType === "CROP_CYCLE") await getVisibleCycle(db, actor, row.subjectId);
      else await getVisiblePlot(db, actor, row.subjectId);
      return eventView(db, row);
    });

    app.post("/v1/files", async (req, reply) => {
      const actor = actorOf(req);
      const part = await req.file();
      if (!part) fail("VALIDATION_FAILED", "Send the file as multipart/form-data field 'file'");
      const data = await part.toBuffer();
      const sha256 = createHash("sha256").update(data).digest("hex");

      const [existing] = await db.select().from(files).where(eq(files.sha256, sha256));
      const row =
        existing ??
        (await (async () => {
          const storagePath = `evidence/${sha256}`;
          await deps.storage.put(storagePath, data, part.mimetype);
          const [inserted] = await db
            .insert(files)
            .values({ sha256, contentType: part.mimetype, sizeBytes: data.length, storagePath, fileName: part.filename || null, uploadedBy: actor.userId, createdAt: deps.now() })
            .returning();
          return inserted!;
        })());

      return reply.code(existing ? 200 : 201).send({
        fileId: row.id,
        sha256: row.sha256,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        url: await deps.storage.url(row.storagePath),
      });
    });
  };
