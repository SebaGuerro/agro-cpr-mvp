import { asc } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { checklistTemplates, CROPS, discountTables, haircuts, plantingWindows } from "../db/schema.js";
import type { ChecklistTemplate } from "../domain/checklist.js";
import type { PlantingWindow } from "../domain/plantingWindow.js";
import { DEFAULT_HAIRCUT_BPS, type DiscountTable } from "../domain/quantities.js";
import type { Crop } from "../domain/types.js";

export interface Configs {
  windows: PlantingWindow[];
  haircuts: { crop: Crop; haircutBps: number }[];
  discountTables: DiscountTable[];
  templates: ChecklistTemplate[];
}

export async function loadConfigs(db: Db): Promise<Configs> {
  const [windows, cuts, tables, templates] = await Promise.all([
    db.select().from(plantingWindows).orderBy(asc(plantingWindows.crop), asc(plantingWindows.uf)),
    db.select().from(haircuts),
    db.select().from(discountTables),
    db.select().from(checklistTemplates),
  ]);
  return {
    windows: windows.map(({ id: _id, ...w }) => w),
    haircuts: cuts,
    discountTables: tables,
    templates,
  };
}

export function haircutFor(configs: Pick<Configs, "haircuts">, crop: Crop): number {
  return configs.haircuts.find((h) => h.crop === crop)?.haircutBps ?? DEFAULT_HAIRCUT_BPS;
}

// ---- PUT /v1/config/* bodies ----

const Crop = z.enum(CROPS);
const MonthDay = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "MM-DD");

export const PlantingWindowsInput = z.array(
  z.object({
    crop: Crop,
    season: z.enum(["SAFRA", "SAFRINHA", "UNICA"]),
    uf: z.string().length(2),
    municipalityIbge: z
      .string()
      .regex(/^\d{7}$/)
      .nullable(),
    startMonthDay: MonthDay,
    endMonthDay: MonthDay,
    source: z.string().min(1).max(200),
    isSample: z.boolean(),
  }),
);

export const HaircutsInput = z.array(z.object({ crop: Crop, haircutBps: z.number().int().min(0).max(10_000) }));

const Pct = z.number().min(0).max(100);
export const DiscountTablesInput = z.array(
  z.object({
    crop: Crop,
    moistureBasePct: Pct,
    moistureDiscountPerPointPct: Pct,
    impurityBasePct: Pct,
    impurityDiscountPerPointPct: Pct,
    damagedBasePct: Pct.nullable(),
    damagedDiscountPerPointPct: Pct.nullable(),
    isSample: z.boolean(),
  }),
);

export const ChecklistsInput = z.array(
  z.object({
    id: z.uuid(),
    crop: Crop,
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            category: z.enum(["SEED", "FERTILIZER", "HERBICIDE", "INSECTICIDE", "FUNGICIDE", "OTHER"]),
            description: z.string().min(1).max(200),
            fromDay: z.number().int().min(-120).max(240),
            toDay: z.number().int().min(-120).max(240),
          })
          .refine((i) => i.toDay >= i.fromDay, "toDay must be >= fromDay"),
      )
      .min(1),
  }),
);

export async function replacePlantingWindows(db: Db, rows: z.infer<typeof PlantingWindowsInput>) {
  await db.transaction(async (tx) => {
    await tx.delete(plantingWindows);
    if (rows.length) await tx.insert(plantingWindows).values(rows);
  });
}

export async function replaceHaircuts(db: Db, rows: z.infer<typeof HaircutsInput>) {
  await db.transaction(async (tx) => {
    await tx.delete(haircuts);
    if (rows.length) await tx.insert(haircuts).values(rows);
  });
}

export async function replaceDiscountTables(db: Db, rows: z.infer<typeof DiscountTablesInput>) {
  await db.transaction(async (tx) => {
    await tx.delete(discountTables);
    if (rows.length) await tx.insert(discountTables).values(rows);
  });
}

export async function replaceChecklists(db: Db, rows: z.infer<typeof ChecklistsInput>) {
  await db.transaction(async (tx) => {
    await tx.delete(checklistTemplates);
    if (rows.length) await tx.insert(checklistTemplates).values(rows);
  });
}
