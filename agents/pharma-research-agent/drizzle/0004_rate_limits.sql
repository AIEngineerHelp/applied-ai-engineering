ALTER TABLE "reports" ADD COLUMN "client_hash" text;--> statement-breakpoint
CREATE INDEX "reports_client_idx" ON "reports" USING btree ("client_hash","created_at");