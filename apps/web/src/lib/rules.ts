import type { PlantingWindow } from "../api/types";

// Mirrors apps/api/src/domain/plantingWindow.ts so forms can warn before submitting.
// The backend stays the authority: it recomputes the check and raises the alert.

export function findWindow(windows: PlantingWindow[], crop: string, seasonCode: string, uf: string, municipalityIbge: string): PlantingWindow | null {
  const season = seasonCode.split("-")[1];
  const candidates = windows.filter((w) => w.crop === crop && w.season === season && w.uf === uf);
  return candidates.find((w) => w.municipalityIbge === municipalityIbge) ?? candidates.find((w) => w.municipalityIbge === null) ?? null;
}

export function windowDates(w: PlantingWindow, seasonCode: string): { start: string; end: string } {
  const firstYear = Number(seasonCode.slice(0, 4));
  const startYear = Number(w.startMonthDay.slice(0, 2)) >= 7 ? firstYear : firstYear + 1;
  const endYear = w.startMonthDay <= w.endMonthDay ? startYear : startYear + 1;
  return { start: `${startYear}-${w.startMonthDay}`, end: `${endYear}-${w.endMonthDay}` };
}

/** Potential = hectares × yield; eligible = potential × haircut. Mirrors apps/api/src/domain/quantities.ts. */
export function cprVolumes(areaM2: number, yieldKgPerHa: number, haircutBps: number) {
  const potentialKg = Math.floor((areaM2 * yieldKgPerHa) / 10_000);
  return { potentialKg, eligibleKg: Math.floor((potentialKg * haircutBps) / 10_000) };
}

/** Discount the table implies for a ticket. Mirrors expectedDiscountKg in apps/api/src/domain/quantities.ts. */
export function expectedDiscountKg(
  grossKg: number,
  q: { moisturePct: number; impurityPct: number; damagedPct: number },
  t: { moistureBasePct: number; moistureDiscountPerPointPct: number; impurityBasePct: number; impurityDiscountPerPointPct: number; damagedBasePct?: number | null; damagedDiscountPerPointPct?: number | null },
): number {
  const over = (v: number, base: number) => Math.max(0, v - base);
  let pct = over(q.moisturePct, t.moistureBasePct) * t.moistureDiscountPerPointPct + over(q.impurityPct, t.impurityBasePct) * t.impurityDiscountPerPointPct;
  if (t.damagedBasePct != null && t.damagedDiscountPerPointPct != null) pct += over(q.damagedPct, t.damagedBasePct) * t.damagedDiscountPerPointPct;
  return Math.round((grossKg * pct) / 100);
}

/** Old (ABC1234) and Mercosul (ABC1D23) plates, typed with or without the dash. */
export const normalizePlate = (s: string) => s.toUpperCase().replace(/[\s-]/g, "");
export const isPlate = (s: string) => /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(s);
