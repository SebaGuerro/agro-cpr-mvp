import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checklistTemplates, files } from "../db/schema.js";
import type { Actor, Crop } from "../domain/types.js";
import { visibleCycles, visibleFarms, visiblePlots } from "../services/views.js";
import { normalizeHeader } from "./parse.js";

/** What the caller may reference in a file; also written to the template's reference sheet. */
export interface RefData {
  farms: { id: string; name: string; uf: string; municipalityIbge: string; producerOrgId: string }[];
  plots: { id: string; label: string; name: string; farmId: string; areaM2: number }[];
  cycles: { id: string; plotId: string; seasonCode: string; crop: Crop }[];
  checklist: { crop: Crop; id: string; category: string; description: string }[];
  evidence: { name: string | null; sha256: string }[];
}

export const plotLabel = (farmName: string, plotName: string) => `${farmName} / ${plotName}`;

export async function loadRefData(db: Db, actor: Actor): Promise<RefData> {
  const [farmRows, plotRows, cycleRows, templates, fileRows] = await Promise.all([
    visibleFarms(db, actor),
    visiblePlots(db, actor),
    visibleCycles(db, actor),
    db.select().from(checklistTemplates),
    // Admins see every upload; others only their own.
    actor.role === "ADMIN"
      ? db.select().from(files).orderBy(desc(files.createdAt))
      : db.select().from(files).where(eq(files.uploadedBy, actor.userId)).orderBy(desc(files.createdAt)),
  ]);
  const farmName = new Map(farmRows.map((f) => [f.id, f.name]));
  return {
    farms: farmRows.map((f) => ({ id: f.id, name: f.name, uf: f.uf, municipalityIbge: f.municipalityIbge, producerOrgId: f.producerOrgId })),
    plots: plotRows.map((p) => ({ id: p.id, label: plotLabel(farmName.get(p.farmId) ?? "?", p.name), name: p.name, farmId: p.farmId, areaM2: p.areaM2 })),
    cycles: cycleRows.map((c) => ({ id: c.id, plotId: c.plotId, seasonCode: c.seasonCode, crop: c.crop })),
    checklist: templates.flatMap((t) => t.items.map((i) => ({ crop: t.crop, id: i.id, category: i.category, description: i.description }))),
    evidence: fileRows.map((f) => ({ name: f.fileName, sha256: f.sha256 })),
  };
}

type Found<T> = { ok: true; value: T } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** By id, by "Fazenda / Talhão", or by plot name when only one visible plot has it. */
export function findPlot(ref: RefData, value: string): Found<RefData["plots"][number]> {
  if (UUID.test(value)) {
    const p = ref.plots.find((x) => x.id === value.toLowerCase());
    return p ? { ok: true, value: p } : { ok: false, message: `Talhão não encontrado: ${value}` };
  }
  const k = normalizeHeader(value);
  const byLabel = ref.plots.filter((p) => normalizeHeader(p.label) === k);
  if (byLabel.length === 1) return { ok: true, value: byLabel[0]! };
  const byName = ref.plots.filter((p) => normalizeHeader(p.name) === k);
  if (byName.length === 1) return { ok: true, value: byName[0]! };
  if (byName.length > 1) return { ok: false, message: `Há ${byName.length} talhões chamados "${value}": use "Fazenda / Talhão" da aba Referência` };
  return { ok: false, message: `Talhão não encontrado: "${value}" (veja a aba Referência)` };
}

export function findFarm(ref: RefData, value: string): Found<RefData["farms"][number]> {
  const hits = UUID.test(value)
    ? ref.farms.filter((f) => f.id === value.toLowerCase())
    : ref.farms.filter((f) => normalizeHeader(f.name) === normalizeHeader(value));
  if (hits.length === 1) return { ok: true, value: hits[0]! };
  if (hits.length > 1) return { ok: false, message: `Há ${hits.length} fazendas chamadas "${value}": use o id da aba Referência` };
  return { ok: false, message: `Fazenda não encontrada: "${value}" (veja a aba Referência)` };
}

/** "2026/27-SAFRA", "2026/27 safra" and "2026/27 Safrinha" all work. */
export function normalizeSeason(value: string): string {
  return value.trim().toUpperCase().replace(/\s*[-\s]\s*/g, "-");
}

export function findCycle(ref: RefData, plotId: string, season: string): Found<RefData["cycles"][number]> {
  const code = normalizeSeason(season);
  const c = ref.cycles.find((x) => x.plotId === plotId && x.seasonCode === code);
  return c
    ? { ok: true, value: c }
    : { ok: false, message: `Não há ciclo ${code} neste talhão. Crie o ciclo no app antes de importar.` };
}

/** By SHA-256 or by the name the file had when it was uploaded. */
export function findEvidence(ref: RefData, value: string): Found<string> {
  if (/^[0-9a-f]{64}$/i.test(value)) return { ok: true, value: value.toLowerCase() };
  const hits = [...new Set(ref.evidence.filter((e) => e.name && normalizeHeader(e.name) === normalizeHeader(value)).map((e) => e.sha256))];
  if (hits.length === 1) return { ok: true, value: hits[0]! };
  if (hits.length > 1) return { ok: false, message: `Há ${hits.length} arquivos chamados "${value}": use o hash da aba Referência` };
  return { ok: false, message: `Evidência não encontrada: "${value}". Envie o arquivo antes (POST /v1/files) e use o nome ou o hash.` };
}
