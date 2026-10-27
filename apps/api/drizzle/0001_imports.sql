CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"dry_run" boolean NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"provenance" text NOT NULL,
	"file_name" text,
	"file_sha256" text NOT NULL,
	"format" text NOT NULL,
	"total_rows" integer NOT NULL,
	"accepted_rows" integer NOT NULL,
	"unchanged_rows" integer NOT NULL,
	"rejected_rows" integer NOT NULL,
	"event_count" integer NOT NULL,
	"errors" jsonb NOT NULL,
	"headers" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"config_snapshot" jsonb,
	"created_by" uuid NOT NULL,
	"actor_org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"rolled_back_by" uuid
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "file_name" text;--> statement-breakpoint
CREATE INDEX "import_batches_org_idx" ON "import_batches" USING btree ("actor_org_id","created_at");