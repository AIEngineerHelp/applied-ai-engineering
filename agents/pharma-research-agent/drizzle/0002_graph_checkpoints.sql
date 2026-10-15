CREATE TABLE "graph_checkpoints" (
	"thread_id" text NOT NULL,
	"namespace" text DEFAULT '' NOT NULL,
	"checkpoint_id" text NOT NULL,
	"parent_id" text,
	"type" text NOT NULL,
	"checkpoint" text NOT NULL,
	"metadata_type" text NOT NULL,
	"metadata" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_checkpoints_thread_id_namespace_checkpoint_id_pk" PRIMARY KEY("thread_id","namespace","checkpoint_id")
);
--> statement-breakpoint
CREATE TABLE "graph_writes" (
	"thread_id" text NOT NULL,
	"namespace" text DEFAULT '' NOT NULL,
	"checkpoint_id" text NOT NULL,
	"task_id" text NOT NULL,
	"idx" integer NOT NULL,
	"channel" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"task_path" text DEFAULT '' NOT NULL,
	CONSTRAINT "graph_writes_thread_id_namespace_checkpoint_id_task_id_idx_pk" PRIMARY KEY("thread_id","namespace","checkpoint_id","task_id","idx")
);
--> statement-breakpoint
ALTER TABLE "graph_checkpoints" ADD CONSTRAINT "graph_checkpoints_thread_id_reports_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_writes" ADD CONSTRAINT "graph_writes_thread_id_reports_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;