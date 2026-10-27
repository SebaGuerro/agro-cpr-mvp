import type { Crop, Season } from "./types.js";

export interface PlantingWindow {
  crop: Crop;
  season: Season;
  uf: string;
  municipalityIbge: string | null;
  startMonthDay: string; // MM-DD
  endMonthDay: string; // MM-DD; may be earlier than start (window crosses the year end)
  source: string;
  isSample: boolean;
}

export function seasonOf(seasonCode: string): Season {
  return seasonCode.split("-")[1] as Season;
}

/** Municipality-specific window first, then the state-wide one. */
export function findWindow(
  windows: PlantingWindow[],
  crop: Crop,
  seasonCode: string,
  uf: string,
  municipalityIbge: string,
): PlantingWindow | null {
  const season = seasonOf(seasonCode);
  const candidates = windows.filter((w) => w.crop === crop && w.season === season && w.uf === uf);
  return (
    candidates.find((w) => w.municipalityIbge === municipalityIbge) ??
    candidates.find((w) => w.municipalityIbge === null) ??
    null
  );
}

/**
 * Calendar dates of a window in a season. "2026/27-SAFRA" starts in 2026: windows
 * opening July-December fall in 2026, windows opening January-June in 2027.
 */
export function windowDates(w: PlantingWindow, seasonCode: string): { start: string; end: string } {
  const firstYear = Number(seasonCode.slice(0, 4));
  const startYear = Number(w.startMonthDay.slice(0, 2)) >= 7 ? firstYear : firstYear + 1;
  const endYear = w.startMonthDay <= w.endMonthDay ? startYear : startYear + 1;
  return { start: `${startYear}-${w.startMonthDay}`, end: `${endYear}-${w.endMonthDay}` };
}

export type PlantingCheck = "WITHIN" | "OUTSIDE" | "NO_WINDOW";

/** Planting is inside the window only if it both starts and finishes inside it. */
export function checkPlanting(
  planting: { startedOn: string; finishedOn: string },
  window: PlantingWindow | null,
  seasonCode: string,
): PlantingCheck {
  if (!window) return "NO_WINDOW";
  const { start, end } = windowDates(window, seasonCode);
  const inside = (d: string) => d >= start && d <= end;
  return inside(planting.startedOn) && inside(planting.finishedOn) ? "WITHIN" : "OUTSIDE";
}
