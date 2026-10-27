import { randomUUID } from "node:crypto";
import { canonicalJson } from "@agro-cpr/spec/keys";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditLog, cropCycles, discountTables, events, importBatches, plantingWindows, plots, type ImportRowError } from "../db/schema.js";
import { replayCycle } from "../domain/cycleState.js";
import { ApiError, fail, type ProblemCode } from "../domain/errors.js";
import type { Actor } from "../domain/types.js";
import { KINDS, UNCHANGED, type ConfigKind, type EventKind, type ImportKind, type KindSpec } from "../ingestion/kinds.js";
import { readSheet, type Sheet } from "../ingestion/parse.js";
import { loadRefData } from "../ingestion/reference.js";
import { RowReader, spreadsheetSource, type IngestionSource } from "../ingestion/source.js";
import { syncCycleAlerts } from "./alerts.js";
import { loadConfigs, replaceDiscountTables, replacePlantingWindows } from "./configs.js";
import { cycleFacts, loadStream, parseEvent, recordEventTx } from "./events.js";

export type BatchRow = typeof importBatches.$inferSelect;

export interface ImportDeps {
  now: Date;
  toleranceBps: number;
  /** Imported events wait this long before anchoring, which is the window for a rollback. */
  importHoldMs: number;
}

/** Rollback closes a minute before anchoring may start, so the two never race. */
const ROLLBACK_MARGIN_MS = 60_000;

const PT: Partial<Record<ProblemCode, string>> = {
  FORBIDDEN_ROLE: "Seu perfil não pode registrar esta etapa",
  FORBIDDEN_ORG: "Sua organização não pode registrar isto",
  WRONG_WAREHOUSE: "Armazém diferente do designado na CPR",
  INVALID_TRANSITION: "Fora de ordem para a situação atual do ciclo",
  EVENT_ID_CONFLICT: "Linha já importada com outros valores; corrija pelo app",
  LAND_ALREADY_REGISTERED: "Este CAR já está cadastrado por outro produtor",
  EVIDENCE_REQUIRED: "Evidência não encontrada",
  DELIVERY_NOT_FOUND: "Caminhão não encontrado",
  QUANTITY_EXCEEDS_AVAILABLE: "Quantidade acima do disponível",
  CPR_ALREADY_EXISTS: "O ciclo já tem CPR",
  VALIDATION_FAILED: "Dados inválidos",
  NOT_FOUND: "Não encontrado",
};

function rowErrorFrom(err: ApiError, row: number): ImportRowError {
  const details = err.errors?.map((e) => `${e.path}: ${e.message}`).join("; ");
  return { row, code: err.code, message: `${PT[err.code] ?? err.code} (${err.message}${details ? `: ${details}` : ""})` };
}

export function specFor(kind: string, actor: Actor): KindSpec {
  const spec = KINDS[kind as ImportKind];
  if (!spec) fail("VALIDATION_FAILED", `Unknown import kind ${kind}. Use one of: ${Object.keys(KINDS).join(", ")}`);
  if (!spec.roles.includes(actor.role)) fail("FORBIDDEN_ROLE", `${actor.role} cannot import ${kind}`);
  return spec;
}

interface RunResult {
  errors: ImportRowError[];
  accepted: number;
  unchanged: number;
  rejected: number;
  eventCount: number;
  cycleIds: Set<string>;
  configSnapshot: BatchRow["configSnapshot"];
}

class Discard extends Error {}
class RowFailed extends Error {}

/**
 * Runs every row inside one transaction, each row in its own savepoint so one bad
 * row doesn't hide the others' errors. Nothing is kept unless this is not a dry
 * run and every row passed: a batch applies whole or not at all.
 */
async function runRows(db: Db, actor: Actor, spec: KindSpec, source: IngestionSource, batchId: string, dryRun: boolean, deps: ImportDeps): Promise<RunResult> {
  const out: RunResult = { errors: [], accepted: 0, unchanged: 0, rejected: 0, eventCount: 0, cycleIds: new Set(), configSnapshot: null };
  try {
    await db.transaction(async (tx) => {
      if (spec.mode === "events") await runEventRows(tx, actor, spec, source, batchId, deps, out);
      else await runConfigRows(tx, spec, source, out);
      if (dryRun || out.errors.length) throw new Discard();
    });
  } catch (err) {
    if (!(err instanceof Discard)) throw err;
  }
  return out;
}

async function runEventRows(tx: Db, actor: Actor, spec: EventKind, source: IngestionSource, batchId: string, deps: ImportDeps, out: RunResult) {
  const ctxBase = { actor, now: deps.now, ref: await loadRefData(tx, actor), configs: await loadConfigs(tx) };
  for (const row of source.rows()) {
    const reader = new RowReader(row, spec.columns);
    try {
      const created = await tx.transaction(async (sp) => {
        const mapped = await spec.map(reader, { ...ctxBase, tx: sp });
        if (mapped === null || !reader.ok) throw new RowFailed();
        if (mapped === UNCHANGED) return [];
        const ids: { cycleId: string | null }[] = [];
        for (const input of mapped) {
          const res = await recordEventTx(sp, actor, parseEvent(input), { now: deps.now, toleranceBps: deps.toleranceBps, importBatchId: batchId });
          if (res.created) ids.push({ cycleId: res.cycleId });
        }
        return ids;
      });
      if (created.length) out.accepted += 1;
      else out.unchanged += 1;
      out.eventCount += created.length;
      for (const c of created) if (c.cycleId) out.cycleIds.add(c.cycleId);
    } catch (err) {
      out.rejected += 1;
      if (err instanceof RowFailed) out.errors.push(...(reader.errors.length ? reader.errors : [{ row: row.n, message: "Linha inválida" }]));
      else if (err instanceof ApiError) out.errors.push(rowErrorFrom(err, row.n));
      else throw err;
    }
  }
}

async function runConfigRows(tx: Db, spec: ConfigKind, source: IngestionSource, out: RunResult) {
  const rows: Record<string, unknown>[] = [];
  const seen = new Map<string, number>();
  for (const row of source.rows()) {
    const reader = new RowReader(row, spec.columns);
    const value = spec.map(reader);
    if (value) {
      const key = spec.keyOf(value);
      const first = seen.get(key);
      if (first !== undefined) reader.error(undefined, `Repete a linha ${first} (${key})`);
      else seen.set(key, row.n);
    }
    if (!value || !reader.ok) {
      out.rejected += 1;
      out.errors.push(...reader.errors);
      continue;
    }
    rows.push(value);
    out.accepted += 1;
  }
  if (out.errors.length) return;
  if (rows.length === 0) {
    out.errors.push({ row: 1, message: "Nenhuma linha: o arquivo apagaria a tabela inteira" });
    return;
  }
  const previous = await currentConfig(tx, spec.kind);
  await replaceConfig(tx, spec.kind, rows);
  out.configSnapshot = { previous, applied: rows };
}

async function currentConfig(db: Db, kind: ImportKind): Promise<Record<string, unknown>[]> {
  if (kind === "PLANTING_WINDOWS") {
    return (await db.select().from(plantingWindows).orderBy(asc(plantingWindows.crop), asc(plantingWindows.uf))).map(({ id: _id, ...w }) => w);
  }
  if (kind === "DISCOUNT_TABLES") return db.select().from(discountTables);
  throw new Error(`${kind} is not a config kind`);
}

async function replaceConfig(db: Db, kind: ImportKind, rows: unknown[]) {
  if (kind === "PLANTING_WINDOWS") await replacePlantingWindows(db, rows as Parameters<typeof replacePlantingWindows>[1]);
  else if (kind === "DISCOUNT_TABLES") await replaceDiscountTables(db, rows as Parameters<typeof replaceDiscountTables>[1]);
  else throw new Error(`${kind} is not a config kind`);
}

/** Same rows regardless of order or key order, for comparing a table with a snapshot. */
function sameTable(spec: ConfigKind, a: unknown[], b: unknown[]): boolean {
  const norm = (rows: unknown[]) => rows.map((r) => canonicalJson(r)).sort();
  return spec.mode === "config" && canonicalJson(norm(a)) === canonicalJson(norm(b));
}

// ---------- public operations ----------

export async function createImport(
  db: Db,
  actor: Actor,
  input: { kind: string; dryRun: boolean; fileName: string | null; fileSha256: string; data: Buffer },
  deps: ImportDeps,
): Promise<BatchRow> {
  const spec = specFor(input.kind, actor);
  const sheet = await readSheet(input.data);
  const source = spreadsheetSource(sheet, spec.columns);
  const id = randomUUID();
  const result = await runRows(db, actor, spec, source, id, input.dryRun, deps);
  const applied = !input.dryRun && result.errors.length === 0;
  const [row] = await db
    .insert(importBatches)
    .values({
      id,
      kind: spec.kind,
      dryRun: input.dryRun,
      status: result.errors.length ? "FAILED" : applied ? "APPLIED" : "VALIDATED",
      source: source.name,
      provenance: source.provenance,
      fileName: input.fileName,
      fileSha256: input.fileSha256,
      format: sheet.format,
      totalRows: sheet.rows.length,
      acceptedRows: result.accepted,
      unchangedRows: result.unchanged,
      rejectedRows: result.rejected,
      eventCount: applied ? result.eventCount : 0,
      errors: result.errors,
      headers: sheet.headers,
      rows: sheet.rows,
      configSnapshot: applied ? result.configSnapshot : null,
      createdBy: actor.userId,
      actorOrgId: actor.orgId,
      createdAt: deps.now,
      appliedAt: applied ? deps.now : null,
    })
    .returning();
  if (applied) await afterChange(db, actor, spec, row!, "IMPORT", result.cycleIds, deps);
  return row!;
}

/** Alerts follow the new data; config changes also go to the audit log, like PUT /v1/config/*. */
async function afterChange(db: Db, actor: Actor, spec: KindSpec, batch: BatchRow, action: "IMPORT" | "ROLLBACK", cycleIds: Set<string>, deps: ImportDeps) {
  if (spec.mode === "config") {
    await db.insert(auditLog).values({ userId: actor.userId, action, entity: `config/${spec.kind.toLowerCase()}`, entityId: batch.id, data: batch.configSnapshot, at: deps.now });
    await syncCycleAlerts(db, "all", deps);
  } else if (cycleIds.size) {
    await syncCycleAlerts(db, [...cycleIds], deps);
  }
}

/** Applies a validated dry run from its stored rows, so the user doesn't upload the file again. */
export async function applyImport(db: Db, actor: Actor, batchId: string, deps: ImportDeps): Promise<BatchRow> {
  const batch = await getBatch(db, actor, batchId);
  if (batch.createdBy !== actor.userId) fail("FORBIDDEN_ORG", "Only the person who uploaded the file can apply it");
  if (!batch.dryRun || batch.status !== "VALIDATED") fail("INVALID_TRANSITION", `Only a validated dry run can be applied (this batch is ${batch.status})`);
  const spec = specFor(batch.kind, actor);
  const sheet: Sheet = { format: batch.format, headers: batch.headers, rows: batch.rows };
  const result = await runRows(db, actor, spec, spreadsheetSource(sheet, spec.columns), batch.id, false, deps);
  const applied = result.errors.length === 0;
  const [row] = await db
    .update(importBatches)
    .set({
      dryRun: false,
      status: applied ? "APPLIED" : "FAILED",
      acceptedRows: result.accepted,
      unchangedRows: result.unchanged,
      rejectedRows: result.rejected,
      eventCount: applied ? result.eventCount : 0,
      errors: result.errors,
      configSnapshot: applied ? result.configSnapshot : null,
      appliedAt: applied ? deps.now : null,
    })
    .where(eq(importBatches.id, batch.id))
    .returning();
  if (applied) await afterChange(db, actor, spec, row!, "IMPORT", result.cycleIds, deps);
  return row!;
}

export async function getBatch(db: Db, actor: Actor, batchId: string): Promise<BatchRow> {
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch || (actor.role !== "ADMIN" && batch.actorOrgId !== actor.orgId)) fail("NOT_FOUND", "Import batch not found");
  return batch;
}

export async function listBatches(db: Db, actor: Actor): Promise<BatchRow[]> {
  const q = db.select().from(importBatches);
  const rows = actor.role === "ADMIN" ? await q.orderBy(desc(importBatches.createdAt)).limit(100) : await q.where(eq(importBatches.actorOrgId, actor.orgId)).orderBy(desc(importBatches.createdAt)).limit(100);
  return rows;
}

/**
 * Undoes an applied batch. Event batches: only while none of its events was sent
 * to the chain (inside the hold window) and nothing recorded later builds on them.
 * Config batches: only while the table still holds exactly what the batch wrote.
 */
export async function rollbackImport(db: Db, actor: Actor, batchId: string, deps: ImportDeps): Promise<BatchRow> {
  const batch = await getBatch(db, actor, batchId);
  if (actor.role !== "ADMIN" && batch.createdBy !== actor.userId) fail("FORBIDDEN_ORG", "Only the person who applied the batch (or an admin) can roll it back");
  if (batch.status !== "APPLIED") fail("INVALID_TRANSITION", `Only an applied batch can be rolled back (this batch is ${batch.status})`);
  const spec = KINDS[batch.kind];
  const touchedCycles = new Set<string>();

  await db.transaction(async (tx) => {
    await tx.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.id, batch.id)).for("update");
    if (spec.mode === "config") {
      const snapshot = batch.configSnapshot;
      if (!snapshot) throw new Error("Applied config batch without a snapshot");
      if (!sameTable(spec, await currentConfig(tx, spec.kind), snapshot.applied)) {
        fail("BATCH_HAS_DEPENDENTS", "The table changed after this import; edit it in the app instead");
      }
      await replaceConfig(tx, spec.kind, snapshot.previous);
    } else {
      await rollbackEvents(tx, batch, deps, touchedCycles);
    }
    await tx
      .update(importBatches)
      .set({ status: "ROLLED_BACK", rolledBackAt: deps.now, rolledBackBy: actor.userId })
      .where(eq(importBatches.id, batch.id));
  });

  const rolledBack = await getBatch(db, actor, batchId);
  await afterChange(db, actor, spec, rolledBack, "ROLLBACK", touchedCycles, deps);
  return rolledBack;
}

async function rollbackEvents(tx: Db, batch: BatchRow, deps: ImportDeps, touchedCycles: Set<string>) {
  const mine = await tx.select().from(events).where(eq(events.importBatchId, batch.id)).orderBy(asc(events.seq)).for("update");
  if (mine.some((e) => e.anchorStatus !== "PENDING" || e.anchorAttempts > 0)) {
    fail("BATCH_ALREADY_ANCHORED", "Some events of this batch were already sent to the chain; fix them with corrections instead");
  }
  const until = rollbackDeadline(batch, deps.importHoldMs);
  if (until && deps.now.getTime() >= until.getTime()) {
    fail("BATCH_ALREADY_ANCHORED", "The review window for this batch has closed; fix its events with corrections instead");
  }
  if (!mine.length) return;

  const ids = new Set(mine.map((e) => e.id));
  const firstSeq = new Map<string, number>();
  for (const e of mine) if (!firstSeq.has(e.subjectId)) firstSeq.set(e.subjectId, e.seq);
  const subjectIds = [...firstSeq.keys()];

  const others = await tx.select({ id: events.id, subjectId: events.subjectId, seq: events.seq }).from(events).where(inArray(events.subjectId, subjectIds));
  const later = others.filter((e) => !ids.has(e.id) && e.seq > firstSeq.get(e.subjectId)!);
  const refs = await tx.select({ id: events.id }).from(events).where(inArray(events.refEventId, [...ids]));
  if (later.length || refs.some((r) => !ids.has(r.id))) {
    fail("BATCH_HAS_DEPENDENTS", `${later.length || refs.length} event(s) recorded after this import build on it; roll those back or correct them first`);
  }
  const newPlots = mine.filter((e) => e.eventType === "PLOT_REGISTERED").map((e) => e.subjectId);
  if (newPlots.length) {
    const cycles = await tx.select({ id: cropCycles.id }).from(cropCycles).where(inArray(cropCycles.plotId, newPlots));
    if (cycles.length) fail("BATCH_HAS_DEPENDENTS", `${cycles.length} crop cycle(s) were created on plots from this import`);
  }

  await tx.delete(events).where(eq(events.importBatchId, batch.id));
  if (newPlots.length) await tx.delete(plots).where(inArray(plots.id, newPlots));

  const cycleIds = [...new Set(mine.filter((e) => e.subjectType === "CROP_CYCLE").map((e) => e.subjectId))];
  for (const cycleId of cycleIds) {
    const [cycle] = await tx.select().from(cropCycles).where(eq(cropCycles.id, cycleId)).for("update");
    if (!cycle) continue;
    const state = replayCycle(await loadStream(tx, cycleId), { cycle: cycleFacts(cycle), toleranceBps: deps.toleranceBps });
    await tx
      .update(cropCycles)
      .set({ state, stage: state.stage, cprStatus: state.cprStatus, updatedAt: deps.now })
      .where(eq(cropCycles.id, cycleId));
    touchedCycles.add(cycleId);
  }
}

export function rollbackDeadline(batch: BatchRow, holdMs: number): Date | null {
  if (batch.status !== "APPLIED" || !batch.appliedAt) return null;
  if (KINDS[batch.kind].mode === "config") return null; // no anchoring: no deadline
  return new Date(batch.appliedAt.getTime() + holdMs - ROLLBACK_MARGIN_MS);
}

export function batchView(b: BatchRow, holdMs: number) {
  return {
    id: b.id,
    kind: b.kind,
    dryRun: b.dryRun,
    status: b.status,
    source: b.source,
    provenance: b.provenance,
    fileName: b.fileName,
    format: b.format,
    totalRows: b.totalRows,
    acceptedRows: b.acceptedRows,
    unchangedRows: b.unchangedRows,
    rejectedRows: b.rejectedRows,
    eventCount: b.eventCount,
    errors: b.errors,
    createdBy: b.createdBy,
    createdAt: b.createdAt.toISOString(),
    appliedAt: b.appliedAt?.toISOString() ?? null,
    rollbackAvailableUntil: rollbackDeadline(b, holdMs)?.toISOString() ?? null,
    rolledBackAt: b.rolledBackAt?.toISOString() ?? null,
  };
}
