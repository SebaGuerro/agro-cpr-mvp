import type { Crop } from "./types.js";

export const DEFAULT_HAIRCUT_BPS = 8_000;

/** Potential production: hectares x expected yield. 1 ha = 10,000 m2. */
export function potentialKg(areaM2: number, yieldKgPerHa: number): number {
  return Math.floor((areaM2 * yieldKgPerHa) / 10_000);
}

/** Volume a CPR may pledge: the potential after the haircut. */
export function eligibleKg(potential: number, haircutBps: number): number {
  return Math.floor((potential * haircutBps) / 10_000);
}

export interface DiscountTable {
  crop: Crop;
  moistureBasePct: number;
  moistureDiscountPerPointPct: number;
  impurityBasePct: number;
  impurityDiscountPerPointPct: number;
  damagedBasePct: number | null;
  damagedDiscountPerPointPct: number | null;
  isSample: boolean;
}

export interface QualityReading {
  moisturePct: number;
  impurityPct: number;
  damagedPct: number;
}

/** Discount the table implies: each point above a base removes a % of gross weight. */
export function expectedDiscountKg(grossKg: number, q: QualityReading, t: DiscountTable): number {
  const over = (value: number, base: number) => Math.max(0, value - base);
  let pct =
    over(q.moisturePct, t.moistureBasePct) * t.moistureDiscountPerPointPct +
    over(q.impurityPct, t.impurityBasePct) * t.impurityDiscountPerPointPct;
  if (t.damagedBasePct !== null && t.damagedDiscountPerPointPct !== null) {
    pct += over(q.damagedPct, t.damagedBasePct) * t.damagedDiscountPerPointPct;
  }
  return Math.round((grossKg * pct) / 100);
}

/** A ticket's discount differs from the table by more than 0.2% of gross (at least 1 kg). */
export function isTicketMismatch(grossKg: number, ticketDiscountKg: number, expectedKg: number): boolean {
  return Math.abs(ticketDiscountKg - expectedKg) > Math.max(1, Math.round(grossKg * 0.002));
}

export function isFulfilled(deliveredNetKg: number, pledgedKg: number, toleranceBps: number): boolean {
  return pledgedKg > 0 && deliveredNetKg * 10_000 >= pledgedKg * (10_000 - toleranceBps);
}
