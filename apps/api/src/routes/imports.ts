import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { actorOf, parse, type AppDeps } from "../app.js";
import { fail } from "../domain/errors.js";
import { loadRefData } from "../ingestion/reference.js";
import { annotatedWorkbook, buildTemplate, XLSX_TYPE } from "../ingestion/workbook.js";
import { applyImport, batchView, createImport, getBatch, listBatches, rollbackImport, specFor, type ImportDeps } from "../services/imports.js";
import { IMPORT_HOLD_MS } from "../jobs/anchor.js";

const BatchParams = z.object({ batchId: z.uuid() });

export const importRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;
    const holdMs = deps.importHoldMs ?? IMPORT_HOLD_MS;
    const importDeps = (): ImportDeps => ({ now: deps.now(), toleranceBps: deps.toleranceBps, importHoldMs: holdMs });
    const view = (b: Parameters<typeof batchView>[0]) => batchView(b, holdMs);

    app.get("/v1/imports/templates/:kind", async (req, reply) => {
      const actor = actorOf(req);
      const { kind } = parse(z.object({ kind: z.string() }), req.params);
      const spec = specFor(kind.toUpperCase(), actor);
      const file = await buildTemplate(spec, await loadRefData(db, actor));
      return reply
        .type(XLSX_TYPE)
        .header("content-disposition", `attachment; filename="modelo-${spec.kind.toLowerCase()}.xlsx"`)
        .send(file);
    });

    app.post("/v1/imports", async (req, reply) => {
      const actor = actorOf(req);
      const fields: Record<string, string> = {};
      let file: { data: Buffer; name: string | null } | null = null;
      for await (const part of req.parts()) {
        if (part.type === "file") file = { data: await part.toBuffer(), name: part.filename || null };
        else fields[part.fieldname] = String(part.value);
      }
      if (!file) fail("VALIDATION_FAILED", "Send the spreadsheet as multipart/form-data field 'file'");
      const { kind, dryRun } = parse(
        z.object({
          kind: z.string().transform((s) => s.toUpperCase()),
          dryRun: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
        }),
        fields,
      );
      const batch = await createImport(
        db,
        actor,
        { kind, dryRun, fileName: file.name, fileSha256: createHash("sha256").update(file.data).digest("hex"), data: file.data },
        importDeps(),
      );
      if (batch.status === "APPLIED" && batch.eventCount > 0) deps.onEventRecorded?.();
      return reply.code(201).send(view(batch));
    });

    app.get("/v1/imports", async (req) => (await listBatches(db, actorOf(req))).map(view));

    app.get("/v1/imports/:batchId", async (req) => {
      const { batchId } = parse(BatchParams, req.params);
      return view(await getBatch(db, actorOf(req), batchId));
    });

    app.get("/v1/imports/:batchId/annotated", async (req, reply) => {
      const { batchId } = parse(BatchParams, req.params);
      const batch = await getBatch(db, actorOf(req), batchId);
      const base = (batch.fileName ?? "importacao").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
      return reply
        .type(XLSX_TYPE)
        .header("content-disposition", `attachment; filename="${base}-erros.xlsx"`)
        .send(await annotatedWorkbook(batch, batch.errors));
    });

    app.post("/v1/imports/:batchId/apply", async (req) => {
      const { batchId } = parse(BatchParams, req.params);
      const batch = await applyImport(db, actorOf(req), batchId, importDeps());
      if (batch.status === "APPLIED" && batch.eventCount > 0) deps.onEventRecorded?.();
      return view(batch);
    });

    app.post("/v1/imports/:batchId/rollback", async (req) => {
      const { batchId } = parse(BatchParams, req.params);
      return view(await rollbackImport(db, actorOf(req), batchId, importDeps()));
    });
  };
