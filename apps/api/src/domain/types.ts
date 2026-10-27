import type { CPR_STATUSES, CYCLE_STAGES, CanonicalEvent, Role } from "@agro-cpr/spec";

export type CycleStage = (typeof CYCLE_STAGES)[number];
export type CprStatus = (typeof CPR_STATUSES)[number];
export type Crop = Extract<CanonicalEvent, { eventType: "PLANTING_RECORDED" }>["payload"]["crop"];
export type Season = "SAFRA" | "SAFRINHA" | "UNICA";

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
}

/** Crop-cycle facts the rules need, independent of the database row shape. */
export interface CycleFacts {
  id: string;
  plotId: string;
  producerOrgId: string;
  crop: Crop;
  seasonCode: string;
  areaM2: number;
  potentialKg: number;
  haircutBps: number;
  eligibleKg: number;
}
