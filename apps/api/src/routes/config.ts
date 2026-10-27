import type { FastifyPluginAsync } from "fastify";
import type { z } from "zod";
import { actorOf, parse, type AppDeps } from "../app.js";
import { auditLog } from "../db/schema.js";
import { fail } from "../domain/errors.js";
import { syncCycleAlerts } from "../services/alerts.js";
import {
  ChecklistsInput,
  DiscountTablesInput,
  HaircutsInput,
  loadConfigs,
  PlantingWindowsInput,
  replaceChecklists,
  replaceDiscountTables,
  replaceHaircuts,
  replacePlantingWindows,
  type Configs,
} from "../services/configs.js";
import type { Db } from "../db/client.js";

export const configRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    // Readable by every role: the front-end shows window feedback before submit.
    function section<S extends z.ZodType>(
      path: string,
      pick: (c: Configs) => unknown,
      schema: S,
      replace: (db: Db, rows: z.infer<S>) => Promise<void>,
    ) {
      app.get(`/v1/config/${path}`, async (req) => {
        actorOf(req);
        return pick(await loadConfigs(db));
      });
      app.put(`/v1/config/${path}`, async (req) => {
        const actor = actorOf(req);
        if (actor.role !== "ADMIN") fail("FORBIDDEN_ROLE", "Only admins can change configuration");
        const rows = parse(schema, req.body);
        await replace(db, rows);
        await db.insert(auditLog).values({ userId: actor.userId, action: "REPLACE", entity: `config/${path}`, data: rows, at: deps.now() });
        // Windows, checklists and discount tables change findings for every cycle.
        await syncCycleAlerts(db, "all", { now: deps.now(), toleranceBps: deps.toleranceBps });
        return pick(await loadConfigs(db));
      });
    }

    section("planting-windows", (c) => c.windows, PlantingWindowsInput, replacePlantingWindows);
    section("haircuts", (c) => c.haircuts, HaircutsInput, replaceHaircuts);
    section("discount-tables", (c) => c.discountTables, DiscountTablesInput, replaceDiscountTables);
    section("checklists", (c) => c.templates, ChecklistsInput, replaceChecklists);
  };
