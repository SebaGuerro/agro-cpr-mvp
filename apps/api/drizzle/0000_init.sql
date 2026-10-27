CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"crop_cycle_id" uuid,
	"subject_id" uuid,
	"event_id" uuid,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"acked_by" uuid,
	CONSTRAINT "alerts_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"crop" text NOT NULL,
	"items" jsonb NOT NULL,
	CONSTRAINT "checklist_templates_crop_unique" UNIQUE("crop")
);
--> statement-breakpoint
CREATE TABLE "cpr_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crop_cycle_id" uuid NOT NULL,
	"requested_kg" bigint NOT NULL,
	"warehouse_org_id" uuid NOT NULL,
	"financier_org_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"status" text NOT NULL,
	"decision_reason" text,
	"issued_event_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crop_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plot_id" uuid NOT NULL,
	"producer_org_id" uuid NOT NULL,
	"crop" text NOT NULL,
	"season_code" text NOT NULL,
	"expected_yield_kg_per_ha" integer NOT NULL,
	"area_m2" bigint NOT NULL,
	"potential_kg" bigint NOT NULL,
	"haircut_bps" integer NOT NULL,
	"eligible_kg" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"stage" text NOT NULL,
	"cpr_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_tables" (
	"crop" text PRIMARY KEY NOT NULL,
	"moisture_base_pct" double precision NOT NULL,
	"moisture_discount_per_point_pct" double precision NOT NULL,
	"impurity_base_pct" double precision NOT NULL,
	"impurity_discount_per_point_pct" double precision NOT NULL,
	"damaged_base_pct" double precision,
	"damaged_discount_per_point_pct" double precision,
	"is_sample" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_role" text NOT NULL,
	"actor_org_id" uuid NOT NULL,
	"quantity" bigint,
	"unit" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"evidence_hash" text,
	"ref_event_id" uuid,
	"body" jsonb NOT NULL,
	"record_hash" text NOT NULL,
	"anchor_status" text DEFAULT 'PENDING' NOT NULL,
	"anchor_attempts" integer DEFAULT 0 NOT NULL,
	"anchor_error" text,
	"chain_id" integer,
	"tx_hash" text,
	"block_number" bigint,
	"anchored_at" timestamp with time zone,
	"import_batch_id" uuid
);
--> statement-breakpoint
CREATE TABLE "farms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producer_org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"uf" text NOT NULL,
	"municipality_ibge" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "haircuts" (
	"crop" text PRIMARY KEY NOT NULL,
	"haircut_bps" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"role" text NOT NULL,
	"email" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"tax_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planting_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crop" text NOT NULL,
	"season" text NOT NULL,
	"uf" text NOT NULL,
	"municipality_ibge" text,
	"start_month_day" text NOT NULL,
	"end_month_day" text NOT NULL,
	"source" text NOT NULL,
	"is_sample" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"farm_id" uuid NOT NULL,
	"producer_org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"area_m2" bigint NOT NULL,
	"car_code" text,
	"uf" text NOT NULL,
	"municipality_ibge" text NOT NULL,
	"geometry" jsonb,
	"digital_twin_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cpr_requests" ADD CONSTRAINT "cpr_requests_crop_cycle_id_crop_cycles_id_fk" FOREIGN KEY ("crop_cycle_id") REFERENCES "public"."crop_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cpr_requests" ADD CONSTRAINT "cpr_requests_warehouse_org_id_orgs_id_fk" FOREIGN KEY ("warehouse_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cpr_requests" ADD CONSTRAINT "cpr_requests_financier_org_id_orgs_id_fk" FOREIGN KEY ("financier_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_cycles" ADD CONSTRAINT "crop_cycles_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crop_cycles" ADD CONSTRAINT "crop_cycles_producer_org_id_orgs_id_fk" FOREIGN KEY ("producer_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farms" ADD CONSTRAINT "farms_producer_org_id_orgs_id_fk" FOREIGN KEY ("producer_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_producer_org_id_orgs_id_fk" FOREIGN KEY ("producer_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_cycle_idx" ON "alerts" USING btree ("crop_cycle_id");--> statement-breakpoint
CREATE INDEX "cpr_requests_cycle_idx" ON "cpr_requests" USING btree ("crop_cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crop_cycles_plot_season_uq" ON "crop_cycles" USING btree ("plot_id","season_code");--> statement-breakpoint
CREATE INDEX "events_subject_seq_idx" ON "events" USING btree ("subject_id","seq");--> statement-breakpoint
CREATE INDEX "events_anchor_idx" ON "events" USING btree ("anchor_status","seq");--> statement-breakpoint
CREATE INDEX "events_ref_idx" ON "events" USING btree ("ref_event_id");--> statement-breakpoint
CREATE INDEX "plots_car_code_idx" ON "plots" USING btree ("car_code");