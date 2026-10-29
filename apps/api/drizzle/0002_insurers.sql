CREATE TABLE "cycle_insurers" (
	"crop_cycle_id" uuid NOT NULL,
	"insurer_org_id" uuid NOT NULL,
	"linked_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_insurers_crop_cycle_id_insurer_org_id_pk" PRIMARY KEY("crop_cycle_id","insurer_org_id")
);
--> statement-breakpoint
ALTER TABLE "cycle_insurers" ADD CONSTRAINT "cycle_insurers_crop_cycle_id_crop_cycles_id_fk" FOREIGN KEY ("crop_cycle_id") REFERENCES "public"."crop_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_insurers" ADD CONSTRAINT "cycle_insurers_insurer_org_id_orgs_id_fk" FOREIGN KEY ("insurer_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cycle_insurers_org_idx" ON "cycle_insurers" USING btree ("insurer_org_id");--> statement-breakpoint
-- Cached cycle state gained insurance fields; existing rows get empty lists.
UPDATE "crop_cycles" SET "state" = jsonb_build_object('policies', '[]'::jsonb, 'claims', '[]'::jsonb) || "state";
