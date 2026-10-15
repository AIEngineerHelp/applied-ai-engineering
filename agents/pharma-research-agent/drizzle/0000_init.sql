CREATE SEQUENCE "public"."report_event_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "report_events" (
	"report_id" text NOT NULL,
	"key" text NOT NULL,
	"seq" bigint DEFAULT nextval('report_event_seq') NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_events_report_id_key_pk" PRIMARY KEY("report_id","key")
);
--> statement-breakpoint
CREATE TABLE "report_files" (
	"report_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"written_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_files_report_id_path_pk" PRIMARY KEY("report_id","path")
);
--> statement-breakpoint
CREATE TABLE "report_sources" (
	"report_id" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"text" text NOT NULL,
	"meta" jsonb NOT NULL,
	"subtask" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "report_sources_report_id_source_id_pk" PRIMARY KEY("report_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"query" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"plan" jsonb,
	"report" jsonb,
	"evals" jsonb,
	"confidence" text,
	"model" text NOT NULL,
	"error" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 5),
	"duration_ms" integer,
	"share_id" text,
	"workflow_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "report_events" ADD CONSTRAINT "report_events_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_files" ADD CONSTRAINT "report_files_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sources" ADD CONSTRAINT "report_sources_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_events_seq_idx" ON "report_events" USING btree ("report_id","seq");--> statement-breakpoint
CREATE INDEX "reports_workspace_idx" ON "reports" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_share_idx" ON "reports" USING btree ("share_id");