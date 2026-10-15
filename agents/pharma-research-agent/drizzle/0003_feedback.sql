CREATE TABLE "report_feedback" (
	"report_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"rating" text NOT NULL,
	"comment" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_feedback_report_id_workspace_id_pk" PRIMARY KEY("report_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "report_feedback" ADD CONSTRAINT "report_feedback_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;