import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ROLES, type StoredEvent } from "@agro-cpr/spec";
import type { ChecklistItem } from "../domain/checklist.js";
import type { CycleState } from "../domain/cycleState.js";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const kg = (name: string) => bigint(name, { mode: "number" });

export const ORG_KINDS = ["PLATFORM", "PRODUCER", "WAREHOUSE", "BUYER", "FINANCIER", "INSURER"] as const;
export const CROPS = ["SOJA", "MILHO", "TRIGO", "SORGO", "FEIJAO"] as const;

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ORG_KINDS }).notNull(),
  taxId: text("tax_id"), // CPF/CNPJ: PII, never leaves Postgres
  createdAt: createdAt(),
});

// One membership per user in the pilot. userId is the Supabase Auth user id.
export const memberships = pgTable("memberships", {
  userId: uuid("user_id").primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  role: text("role", { enum: ROLES }).notNull(),
  email: text("email"),
  name: text("name"),
  createdAt: createdAt(),
});

export const farms = pgTable("farms", {
  id: uuid("id").primaryKey().defaultRandom(),
  producerOrgId: uuid("producer_org_id")
    .notNull()
    .references(() => orgs.id),
  name: text("name").notNull(),
  uf: text("uf").notNull(),
  municipalityIbge: text("municipality_ibge").notNull(),
  createdAt: createdAt(),
});

// Created by a PLOT_REGISTERED event; id is that event's subjectId.
export const plots = pgTable(
  "plots",
  {
    id: uuid("id").primaryKey(),
    farmId: uuid("farm_id")
      .notNull()
      .references(() => farms.id),
    producerOrgId: uuid("producer_org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    areaM2: kg("area_m2").notNull(),
    carCode: text("car_code"),
    uf: text("uf").notNull(),
    municipalityIbge: text("municipality_ibge").notNull(),
    geometry: jsonb("geometry"),
    digitalTwinRef: text("digital_twin_ref"),
    createdAt: createdAt(),
  },
  (t) => [index("plots_car_code_idx").on(t.carCode)],
);

export const cropCycles = pgTable(
  "crop_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plotId: uuid("plot_id")
      .notNull()
      .references(() => plots.id),
    producerOrgId: uuid("producer_org_id")
      .notNull()
      .references(() => orgs.id),
    crop: text("crop", { enum: CROPS }).notNull(),
    seasonCode: text("season_code").notNull(),
    expectedYieldKgPerHa: integer("expected_yield_kg_per_ha").notNull(),
    areaM2: kg("area_m2").notNull(),
    potentialKg: kg("potential_kg").notNull(),
    haircutBps: integer("haircut_bps").notNull(),
    eligibleKg: kg("eligible_kg").notNull(),
    // Cache of replaying the cycle's events; rebuilt on every accepted event.
    state: jsonb("state").$type<CycleState>().notNull(),
    stage: text("stage").notNull(),
    cprStatus: text("cpr_status").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("crop_cycles_plot_season_uq").on(t.plotId, t.seasonCode)],
);

export const cprRequests = pgTable(
  "cpr_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cropCycleId: uuid("crop_cycle_id")
      .notNull()
      .references(() => cropCycles.id),
    requestedKg: kg("requested_kg").notNull(),
    warehouseOrgId: uuid("warehouse_org_id")
      .notNull()
      .references(() => orgs.id),
    financierOrgId: uuid("financier_org_id")
      .notNull()
      .references(() => orgs.id),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    status: text("status", { enum: ["PENDING", "APPROVED", "REJECTED"] }).notNull(),
    decisionReason: text("decision_reason"),
    issuedEventId: uuid("issued_event_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("cpr_requests_cycle_idx").on(t.cropCycleId)],
);

// The producer links an insurer to a cycle; the insurer then sees it and can issue a policy.
export const cycleInsurers = pgTable(
  "cycle_insurers",
  {
    cropCycleId: uuid("crop_cycle_id")
      .notNull()
      .references(() => cropCycles.id),
    insurerOrgId: uuid("insurer_org_id")
      .notNull()
      .references(() => orgs.id),
    linkedBy: uuid("linked_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.cropCycleId, t.insurerOrgId] }), index("cycle_insurers_org_idx").on(t.insurerOrgId)],
);

export const ANCHOR_STATUSES = ["PENDING", "ANCHORED", "FAILED"] as const;

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey(),
    // Insertion order; replay and anchoring follow it.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    subjectType: text("subject_type", { enum: ["PLOT", "CROP_CYCLE"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    eventType: text("event_type").notNull(),
    actorRole: text("actor_role", { enum: ROLES }).notNull(),
    actorOrgId: uuid("actor_org_id").notNull(),
    quantity: kg("quantity"),
    unit: text("unit"),
    occurredAt: ts("occurred_at").notNull(),
    recordedAt: ts("recorded_at").notNull(),
    recordedBy: uuid("recorded_by").notNull(),
    evidenceHash: text("evidence_hash"),
    refEventId: uuid("ref_event_id"),
    // The exact stored event; recordHash is computed over it.
    body: jsonb("body").$type<StoredEvent>().notNull(),
    recordHash: text("record_hash").notNull(),
    anchorStatus: text("anchor_status", { enum: ANCHOR_STATUSES }).notNull().default("PENDING"),
    anchorAttempts: integer("anchor_attempts").notNull().default(0),
    anchorError: text("anchor_error"),
    chainId: integer("chain_id"),
    txHash: text("tx_hash"),
    blockNumber: bigint("block_number", { mode: "number" }),
    anchoredAt: ts("anchored_at"),
    importBatchId: uuid("import_batch_id"),
  },
  (t) => [
    index("events_subject_seq_idx").on(t.subjectId, t.seq),
    index("events_anchor_idx").on(t.anchorStatus, t.seq),
    index("events_ref_idx").on(t.refEventId),
  ],
);

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  sha256: text("sha256").notNull().unique(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storagePath: text("storage_path").notNull(),
  // Name of the first upload; imports can reference evidence by it.
  fileName: text("file_name"),
  uploadedBy: uuid("uploaded_by").notNull(),
  createdAt: createdAt(),
});

export const IMPORT_KINDS = ["PLOTS", "PLANTINGS", "INPUT_APPLICATIONS", "DELIVERIES", "PLANTING_WINDOWS", "DISCOUNT_TABLES"] as const;
export const IMPORT_STATUSES = ["VALIDATED", "APPLIED", "ROLLED_BACK", "FAILED"] as const;

export interface ImportRowError {
  row: number;
  column?: string;
  code?: string;
  message: string;
}

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind", { enum: IMPORT_KINDS }).notNull(),
    dryRun: boolean("dry_run").notNull(),
    status: text("status", { enum: IMPORT_STATUSES }).notNull(),
    source: text("source").notNull(), // SPREADSHEET today; integrations later
    provenance: text("provenance", { enum: ["MANUAL", "IMPORTED", "VERIFIED"] }).notNull(),
    fileName: text("file_name"),
    fileSha256: text("file_sha256").notNull(),
    format: text("format", { enum: ["CSV", "XLSX"] }).notNull(),
    totalRows: integer("total_rows").notNull(),
    acceptedRows: integer("accepted_rows").notNull(),
    unchangedRows: integer("unchanged_rows").notNull(),
    rejectedRows: integer("rejected_rows").notNull(),
    eventCount: integer("event_count").notNull(),
    errors: jsonb("errors").$type<ImportRowError[]>().notNull(),
    // The parsed sheet, kept to apply a dry run later and to build the annotated file.
    headers: jsonb("headers").$type<string[]>().notNull(),
    rows: jsonb("rows").$type<{ n: number; cells: (string | number | null)[] }[]>().notNull(),
    // Config kinds replace a whole table: what was there before, and what this batch wrote.
    configSnapshot: jsonb("config_snapshot").$type<{ previous: unknown[]; applied: unknown[] }>(),
    createdBy: uuid("created_by").notNull(),
    actorOrgId: uuid("actor_org_id").notNull(),
    createdAt: createdAt(),
    appliedAt: ts("applied_at"),
    rolledBackAt: ts("rolled_back_at"),
    rolledBackBy: uuid("rolled_back_by"),
  },
  (t) => [index("import_batches_org_idx").on(t.actorOrgId, t.createdAt)],
);

export const ALERT_SEVERITIES = ["INFO", "WARNING", "HIGH"] as const;

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    type: text("type").notNull(),
    severity: text("severity", { enum: ALERT_SEVERITIES }).notNull(),
    cropCycleId: uuid("crop_cycle_id"),
    subjectId: uuid("subject_id"),
    eventId: uuid("event_id"),
    message: text("message").notNull(),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
    ackedAt: ts("acked_at"),
    ackedBy: uuid("acked_by"),
  },
  (t) => [index("alerts_cycle_idx").on(t.cropCycleId)],
);

export const plantingWindows = pgTable("planting_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  crop: text("crop", { enum: CROPS }).notNull(),
  season: text("season", { enum: ["SAFRA", "SAFRINHA", "UNICA"] }).notNull(),
  uf: text("uf").notNull(),
  municipalityIbge: text("municipality_ibge"),
  startMonthDay: text("start_month_day").notNull(),
  endMonthDay: text("end_month_day").notNull(),
  source: text("source").notNull(),
  isSample: boolean("is_sample").notNull(),
});

export const haircuts = pgTable("haircuts", {
  crop: text("crop", { enum: CROPS }).primaryKey(),
  haircutBps: integer("haircut_bps").notNull(),
});

export const discountTables = pgTable("discount_tables", {
  crop: text("crop", { enum: CROPS }).primaryKey(),
  moistureBasePct: doublePrecision("moisture_base_pct").notNull(),
  moistureDiscountPerPointPct: doublePrecision("moisture_discount_per_point_pct").notNull(),
  impurityBasePct: doublePrecision("impurity_base_pct").notNull(),
  impurityDiscountPerPointPct: doublePrecision("impurity_discount_per_point_pct").notNull(),
  damagedBasePct: doublePrecision("damaged_base_pct"),
  damagedDiscountPerPointPct: doublePrecision("damaged_discount_per_point_pct"),
  isSample: boolean("is_sample").notNull(),
});

export const checklistTemplates = pgTable("checklist_templates", {
  id: uuid("id").primaryKey(),
  crop: text("crop", { enum: CROPS }).notNull().unique(),
  items: jsonb("items").$type<ChecklistItem[]>().notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  data: jsonb("data"),
  at: createdAt(),
});
