import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createIssue,
  createIssueProject,
  createIssueToolSource,
  createOrganization,
  deleteIssueProject,
  ForbiddenError,
  grantScopes,
  issueWorkBrief,
  listIssueProjects,
  NotFoundError,
  openTasksBrief,
  PROJECT_REPOSITORIES_MAX,
  projectRepositories,
  setProjectRepositories,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error,
  );

describe("a project's GitHub repositories (ADR 0202)", () => {
  test("an administrator links them in order, cleaned, and the projects list carries them", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const project = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Clínica Teo" });
    expect(project.repositories).toEqual([]);

    const saved = await setProjectRepositories(deps, f.owner.id, f.org.id, project.id, [
      "https://github.com/acme/api.git",
      "acme/web",
      "ACME/API",
    ]);
    // A GitHub address becomes owner/name, and a repeat in other capitals is dropped: the first stays the main one.
    expect(saved).toEqual(["acme/api", "acme/web"]);
    expect(await projectRepositories(f.db, f.org.id, project.id)).toEqual(["acme/api", "acme/web"]);

    const listed = await listIssueProjects(f.db, f.owner.id, f.org.id);
    expect(listed.projects.find((p) => p.id === project.id)?.repositories).toEqual(["acme/api", "acme/web"]);

    // Reordering makes another one the main one.
    await setProjectRepositories(deps, f.owner.id, f.org.id, project.id, ["acme/web", "acme/api"]);
    expect(await projectRepositories(f.db, f.org.id, project.id)).toEqual(["acme/web", "acme/api"]);

    const audit = await f.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "issue.project_repositories_changed")),
      );
    expect(audit).toHaveLength(2);
    expect(audit.at(-1)?.details).toEqual({ repositories: ["acme/web", "acme/api"], before: ["acme/api", "acme/web"] });

    // The same list again changes nothing and writes no entry.
    await setProjectRepositories(deps, f.owner.id, f.org.id, project.id, ["acme/web", "acme/api"]);
    const again = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "issue.project_repositories_changed"));
    expect(again).toHaveLength(2);
  });

  test("only an administrator links them: they point agents at code, so a poster can't", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const project = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Padaria" });
    const member = await addMember(f.db, f.org.id, "member", "Bruno");
    const admin = await addMember(f.db, f.org.id, "admin", "Carla");

    const refused = await rejection(setProjectRepositories(deps, member.id, f.org.id, project.id, ["acme/api"]));
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as ForbiddenError).code).toBe("issue_project.admin_only");
    expect(await projectRepositories(f.db, f.org.id, project.id)).toEqual([]);

    expect(await setProjectRepositories(deps, admin.id, f.org.id, project.id, ["acme/api"])).toEqual(["acme/api"]);
  });

  test("a whole account, a bad name or too many are refused, and nothing changes", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const project = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Loja" });
    await setProjectRepositories(deps, f.owner.id, f.org.id, project.id, ["acme/api"]);

    for (const bad of [["acme/*"], ["not a repo"], ["acme/api/extra"]]) {
      const e = await rejection(setProjectRepositories(deps, f.owner.id, f.org.id, project.id, bad));
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).code).toBe("issue_project.invalid_repository");
    }
    const many = Array.from({ length: PROJECT_REPOSITORIES_MAX + 1 }, (_, i) => `acme/r${i}`);
    const tooMany = await rejection(setProjectRepositories(deps, f.owner.id, f.org.id, project.id, many));
    expect((tooMany as ValidationError).code).toBe("issue_project.too_many_repositories");
    expect(await projectRepositories(f.db, f.org.id, project.id)).toEqual(["acme/api"]);
  });

  test("another workspace's project is not found, and deleting a project takes its repositories with it", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const project = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Agência" });
    await setProjectRepositories(deps, f.owner.id, f.org.id, project.id, ["acme/api"]);

    // Its owner runs another workspace too: the project's id there finds nothing.
    const { organization: elsewhere } = await createOrganization(f.db, f.owner.id, { name: "Outra" });
    const lost = await rejection(setProjectRepositories(deps, f.owner.id, elsewhere.id, project.id, ["acme/web"]));
    expect(lost).toBeInstanceOf(NotFoundError);

    await deleteIssueProject(deps, f.owner.id, f.org.id, project.id);
    const left = await f.db
      .select()
      .from(schema.issueProjectRepositories)
      .where(eq(schema.issueProjectRepositories.projectId, project.id));
    expect(left).toEqual([]);
  });
});

describe("what an agent is told of a task's project's repositories (ADR 0202 §4)", () => {
  test("the task's brief names them, its main one first; its open tasks say them too", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const owner = { type: "person" as const, userId: f.owner.id };
    const assignees = [{ type: "agent" as const, id: f.agent.id }];
    const shop = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Loja" });
    const bare = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Sem código" });
    await setProjectRepositories(deps, f.owner.id, f.org.id, shop.id, [
      "acme/web",
      "acme/api",
      "acme/infra",
      "acme/docs",
    ]);
    const task = await createIssue(deps, owner, f.org.id, { title: "Checkout novo", projectId: shop.id, assignees });
    const other = await createIssue(deps, owner, f.org.id, { title: "Planilha", projectId: bare.id, assignees });

    const brief = await issueWorkBrief(f.db, f.org.id, task.id);
    expect(brief).toContain(
      [
        "## Repositories",
        "This task is in the project Loja, which works on these GitHub repositories, its main one first:",
        "- acme/web (main)",
        "- acme/api",
        "- acme/infra",
        "- acme/docs",
        "Work in acme/web unless the task or the person names another of them. `git_clone` with no repo clones acme/web.",
      ].join("\n"),
    );
    // A project with no repositories says nothing of them.
    expect(await issueWorkBrief(f.db, f.org.id, other.id)).not.toContain("## Repositories");

    const open = await openTasksBrief(f.db, f.org.id, f.agent.id, f.general.id, false);
    expect(open).toContain("Checkout novo (todo, project Loja, repos acme/web, acme/api, acme/infra +1)");
    expect(open).toContain("Planilha (todo, project Sem código)");

    // list_issues says each project's repositories once, under its tasks.
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
    const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
    const listed = await tools.find((t) => t.name === "list_issues")?.execute({}, ctx);
    expect(String(listed?.content)).toContain(
      "Projects' GitHub repositories:\n- Loja: acme/web (main), acme/api, acme/infra, acme/docs",
    );
    expect(String(listed?.content)).not.toContain("- Sem código:");
  });
});
