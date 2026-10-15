-- Reports become turns of a conversation. Existing reports each start their own thread.
ALTER TABLE "reports" ADD COLUMN "thread_id" text;--> statement-breakpoint
UPDATE "reports" SET "thread_id" = "id" WHERE "thread_id" IS NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "reports_thread_idx" ON "reports" USING btree ("thread_id","position");
