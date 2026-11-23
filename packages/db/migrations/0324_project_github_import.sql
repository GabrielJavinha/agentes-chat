ALTER TABLE "issue_projects" ADD COLUMN "github_import" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_projects" ADD COLUMN "github_import_by" text;