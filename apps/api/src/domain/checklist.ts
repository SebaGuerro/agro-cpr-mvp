import { addDays } from "./dates.js";
import type { Crop } from "./types.js";

export interface ChecklistItem {
  id: string;
  category: "SEED" | "FERTILIZER" | "HERBICIDE" | "INSECTICIDE" | "FUNGICIDE" | "OTHER";
  description: string;
  fromDay: number; // relative to planting start; negative = before planting
  toDay: number;
}

export interface ChecklistTemplate {
  id: string;
  crop: Crop;
  items: ChecklistItem[];
}

export interface Application {
  eventId: string;
  checklistItemId: string | null;
  appliedOn: string;
}

export interface ItemStatus {
  item: ChecklistItem;
  status: "DONE" | "LATE" | "MISSING" | "PENDING";
  dueBy: string | null;
  eventId: string | null;
}

export function checklistStatus(
  template: ChecklistTemplate,
  plantingStartedOn: string | null,
  applications: Application[],
  today: string,
): ItemStatus[] {
  return template.items.map((item) => {
    const apps = applications.filter((a) => a.checklistItemId === item.id);
    if (!plantingStartedOn) {
      // Without a planting date the timing can't be judged yet.
      const first = apps[0];
      return first
        ? { item, status: "DONE", dueBy: null, eventId: first.eventId }
        : { item, status: "PENDING", dueBy: null, eventId: null };
    }
    const from = addDays(plantingStartedOn, item.fromDay);
    const to = addDays(plantingStartedOn, item.toDay);
    const onTime = apps.find((a) => a.appliedOn >= from && a.appliedOn <= to);
    if (onTime) return { item, status: "DONE", dueBy: to, eventId: onTime.eventId };
    const late = apps[0];
    if (late) return { item, status: "LATE", dueBy: to, eventId: late.eventId };
    return { item, status: today > to ? "MISSING" : "PENDING", dueBy: to, eventId: null };
  });
}
