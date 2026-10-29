import type { components } from "./schema";

type S = components["schemas"];

export type Me = S["Me"];
export type Role = Me["role"];
export type OrgRef = S["OrgRef"];
export type Farm = S["FarmPage"]["items"][number];
export type Plot = S["Plot"];
export type CropCycle = S["CropCycle"];
export type RiskAssessment = S["RiskAssessment"];
export type Timeline = S["Timeline"];
export type CprRequest = S["CprRequest"];
export type Alert = S["Alert"];
export type Portfolio = S["Portfolio"];
export type ExpectedArrival = S["ExpectedArrival"];
export type PlantingWindow = S["PlantingWindow"];
export type Haircut = S["Haircut"];
export type DiscountTable = S["DiscountTable"];
export type ChecklistTemplate = S["ChecklistTemplate"];
export type ImportBatch = S["ImportBatch"];
export type AdminOrg = S["AdminOrg"];
export type AdminUser = S["AdminUser"];
export type FileRef = S["FileRef"];

/** A stored event as the API returns it. Payloads are read loosely for display. */
export interface EventRecord {
  id: string;
  subjectType: "PLOT" | "CROP_CYCLE";
  subjectId: string;
  eventType: string;
  actorRole: Role;
  actorOrgId: string;
  occurredAt: string;
  recordedAt: string;
  recordedBy: string;
  quantity: number | null;
  unit: string | null;
  evidenceHash: string | null;
  refEventId: string | null;
  payload: Record<string, unknown>;
  anchor: { status: "PENDING" | "ANCHORED" | "FAILED"; recordHash: string; chainId: number | null; txHash: string | null; blockNumber: number | null; anchoredAt: string | null };
  voided: boolean;
  correctedBy: string[];
  provenance: "MANUAL" | "IMPORTED" | "VERIFIED";
  importBatchId: string | null;
}
