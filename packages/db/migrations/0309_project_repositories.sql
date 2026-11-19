CREATE TABLE "issue_project_repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_project_repositories" ADD CONSTRAINT "issue_project_repositories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_project_repositories" ADD CONSTRAINT "issue_project_repositories_project_id_issue_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."issue_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_project_repositories_repo" ON "issue_project_repositories" USING btree ("project_id",lower("repo"));--> statement-breakpoint
CREATE INDEX "issue_project_repositories_org_repo" ON "issue_project_repositories" USING btree ("org_id",lower("repo"));