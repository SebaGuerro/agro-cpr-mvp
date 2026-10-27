import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { alerts, cropCycles } from "../db/schema.js";
import { DERIVED_ALERT_TYPES, type Severity } from "../domain/findings.js";
import { analyzeCycles, type RiskDeps } from "./views.js";

/**
 * Makes the open derived alerts of these cycles match their current findings:
 * opens new ones, refreshes existing ones (reopening if they had resolved) and
 * resolves the ones whose condition cleared. Acknowledgements are kept.
 */
export async function syncCycleAlerts(db: Db, cycleIds: string[] | "all", deps: RiskDeps): Promise<void> {
  const cycles =
    cycleIds === "all"
      ? await db.select().from(cropCycles)
      : cycleIds.length
        ? await db.select().from(cropCycles).where(inArray(cropCycles.id, cycleIds))
        : [];
  if (!cycles.length) return;

  const analyses = await analyzeCycles(db, cycles, deps);
  const desired = [...analyses.entries()].flatMap(([cycleId, a]) =>
    a.findings.flatMap((f) =>
      f.alert
        ? [{ dedupeKey: f.alert.key, type: f.alert.type, severity: f.alert.severity, cropCycleId: cycleId, subjectId: cycleId, eventId: f.eventId, message: f.message }]
        : [],
    ),
  );

  await db.transaction(async (tx) => {
    for (const a of desired) {
      await tx
        .insert(alerts)
        .values({ ...a, createdAt: deps.now })
        .onConflictDoUpdate({
          target: alerts.dedupeKey,
          set: { severity: a.severity, message: a.message, resolvedAt: null },
        });
    }
    const keep = new Set(desired.map((a) => a.dedupeKey));
    const open = await tx
      .select({ id: alerts.id, dedupeKey: alerts.dedupeKey })
      .from(alerts)
      .where(
        and(
          inArray(alerts.cropCycleId, cycles.map((c) => c.id)),
          inArray(alerts.type, [...DERIVED_ALERT_TYPES]),
          isNull(alerts.resolvedAt),
        ),
      );
    const stale = open.filter((a) => !keep.has(a.dedupeKey)).map((a) => a.id);
    if (stale.length) await tx.update(alerts).set({ resolvedAt: deps.now }).where(inArray(alerts.id, stale));
  });
}

/** Alerts raised outside the cycle sync (e.g. anchoring problems). Idempotent per dedupeKey. */
export async function raiseAlert(
  db: Db,
  a: { type: string; severity: Severity; dedupeKey: string; cropCycleId: string | null; subjectId: string | null; eventId: string | null; message: string },
  now: Date,
): Promise<void> {
  await db
    .insert(alerts)
    .values({ ...a, createdAt: now })
    .onConflictDoUpdate({ target: alerts.dedupeKey, set: { message: a.message, resolvedAt: null } });
}

export async function resolveAlert(db: Db, dedupeKey: string, now: Date): Promise<void> {
  await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(and(eq(alerts.dedupeKey, dedupeKey), isNull(alerts.resolvedAt)));
}
