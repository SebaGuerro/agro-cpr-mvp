// America/Sao_Paulo has had a fixed UTC-3 offset since daylight saving ended in 2019.
const OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Local (São Paulo) calendar date of an instant, as YYYY-MM-DD. */
export function localDate(instant: Date | string): string {
  const t = typeof instant === "string" ? Date.parse(instant) : instant.getTime();
  return new Date(t - OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Unix seconds of 00:00 São Paulo time on a local date. */
export function localMidnightUnix(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00-03:00`) / 1000);
}
