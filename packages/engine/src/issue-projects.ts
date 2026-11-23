import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { normalizeRepoEntry } from "./git/repos";
import { can, requireActiveMembership } from "./organizations";
import { ROLE_COLORS } from "./permissions";
import { taskSeenSql } from "./task-access";

const { agentRuns, issueProjects, issueProjectRepositories: projectRepos, issues } = schema;

/** A project's name holds at most this (the dialogs mirror it: packages/client/src/lib/issue-projects.ts). */
export const PROJECT_NAME_MAX = 80;
/** More than a workspace runs at once: the menu and the pickers stay a list someone can read. */
export const PROJECTS_MAX = 200;

/** A task's project as its card shows it. */
export interface IssueProjectRef {
  id: string;
  name: string;
  color: string;
  archived: boolean;
}

/**
 * A project in the projects menu. `open`: the open tasks in it that the reader sees. `repositories`: the GitHub
 * repositories it works on (`owner/name`), its main one first (ADR 0218).
 */
export interface IssueProjectView extends IssueProjectRef {
  open: number;
  repositories: string[];
  /** Issues opened in its repositories become its tasks (ADR 0218 §6). */
  githubImport: boolean;
}

/** More repositories than one project works on: the picker and the agent's brief stay short. */
export const PROJECT_REPOSITORIES_MAX = 20;

type ProjectRow = typeof issueProjects.$inferSelect;

export const projectRef = (p: ProjectRow): IssueProjectRef => ({
  id: p.id,
  name: p.name,
  color: p.color,
  archived: p.archivedAt !== null,
});

export interface ProjectDeps {
  db: Database;
  pubsub?: PubSub;
}

function cleanName(name: string) {
  const n = name.trim().replace(/\s+/g, " ").slice(0, PROJECT_NAME_MAX).trim();
  if (!n) throw new ValidationError("name is required");
  return n;
}

function checkColor(color: string | undefined) {
  if (color === undefined) return undefined;
  if (!(ROLE_COLORS as readonly string[]).includes(color)) throw new ValidationError("invalid color");
  return color;
}

const nameTaken = (name: string) =>
  new ValidationError(`A project named "${name}" already exists`, "issue_project.name_taken", { name });

const byName = (orgId: string, name: string) =>
  and(eq(issueProjects.orgId, orgId), sql`lower(${issueProjects.name}) = lower(${name})`);

/** The org's projects by name, archived ones last. */
async function projectRows(db: Database, orgId: string) {
  return db
    .select()
    .from(issueProjects)
    .where(eq(issueProjects.orgId, orgId))
    .orderBy(sql`${issueProjects.archivedAt} is not null`, asc(sql`lower(${issueProjects.name})`));
}

/** The projects of these tasks, by project id. */
export async function projectsById(db: Database, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const rows = wanted.length ? await db.select().from(issueProjects).where(inArray(issueProjects.id, wanted)) : [];
  return new Map(rows.map((p) => [p.id, projectRef(p)]));
}

/**
 * The projects with how many open tasks the reader sees in each, and how many open tasks have none (`unfiled`).
 * The counts follow who sees each task, so a project never tells of work the reader can't open.
 */
export async function listIssueProjects(
  db: Database,
  userId: string,
  orgId: string,
): Promise<{ projects: IssueProjectView[]; unfiled: number }> {
  await requireActiveMembership(db, userId, orgId);
  const [rows, counts, repos] = await Promise.all([
    projectRows(db, orgId),
    db
      .select({ projectId: issues.projectId, open: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.orgId, orgId),
          sql`${issues.status} not in ('done', 'canceled')`,
          taskSeenSql("issues", sql`${userId}::text`),
        ),
      )
      .groupBy(issues.projectId),
    reposByProject(db, orgId),
  ]);
  const open = new Map(counts.map((c) => [c.projectId, c.open]));
  return {
    projects: rows.map((p) => ({
      ...projectRef(p),
      open: open.get(p.id) ?? 0,
      repositories: repos.get(p.id) ?? [],
      githubImport: p.githubImport,
    })),
    unfiled: open.get(null) ?? 0,
  };
}

async function announce(deps: ProjectDeps, orgId: string) {
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "issue.projects" } });
}

async function insertProject(db: Database, orgId: string, input: { name: string; color?: string }) {
  const name = cleanName(input.name);
  const color = checkColor(input.color) ?? "graphite";
  const existing = await db
    .select({ id: issueProjects.id, name: issueProjects.name })
    .from(issueProjects)
    .where(eq(issueProjects.orgId, orgId));
  if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw nameTaken(name);
  if (existing.length >= PROJECTS_MAX) {
    throw new ValidationError(`A workspace holds at most ${PROJECTS_MAX} projects`, "issue_project.too_many", {
      max: PROJECTS_MAX,
    });
  }
  // Two at once with one name: the unique index refuses the second.
  const [row] = await db.insert(issueProjects).values({ orgId, name, color }).onConflictDoNothing().returning();
  if (!row) throw nameTaken(name);
  return row;
}

async function requirePoster(db: Database, userId: string, orgId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!can(membership, "post")) throw new ForbiddenError();
}

/** Whoever may create tasks may create, change and delete projects, as with the board's columns. */
export async function createIssueProject(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  input: { name: string; color?: string },
): Promise<IssueProjectView> {
  await requirePoster(deps.db, userId, orgId);
  const row = await insertProject(deps.db, orgId, input);
  await announce(deps, orgId);
  return { ...projectRef(row), open: 0, repositories: [], githubImport: false };
}

/** Renames, recolours, archives or brings back a project. */
export async function updateIssueProject(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  projectId: string,
  patch: { name?: string; color?: string; archived?: boolean },
): Promise<IssueProjectRef> {
  await requirePoster(deps.db, userId, orgId);
  const [current] = await deps.db
    .select()
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!current) throw new NotFoundError("Project not found");
  const set: Partial<typeof issueProjects.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name !== current.name) {
      const [other] = await deps.db.select({ id: issueProjects.id }).from(issueProjects).where(byName(orgId, name));
      if (other && other.id !== current.id) throw nameTaken(name);
      set.name = name;
    }
  }
  const color = checkColor(patch.color);
  if (color !== undefined) set.color = color;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? (current.archivedAt ?? new Date()) : null;
  if (Object.keys(set).length === 0) return projectRef(current);
  const [row] = await deps.db
    .update(issueProjects)
    .set(set)
    .where(eq(issueProjects.id, current.id))
    .returning()
    // Two renames to one name at once: the unique index refuses the second.
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? nameTaken(set.name ?? current.name) : error;
    });
  await announce(deps, orgId);
  return projectRef(row ?? current);
}

/** Deletes a project. Its tasks stay, with no project (the column's foreign key clears it). */
export async function deleteIssueProject(deps: ProjectDeps, userId: string, orgId: string, projectId: string) {
  await requirePoster(deps.db, userId, orgId);
  const gone = await deps.db
    .delete(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)))
    .returning({ id: issueProjects.id });
  if (gone.length === 0) throw new NotFoundError("Project not found");
  await announce(deps, orgId);
}

/** A project of the org a task may take: an archived one takes no new tasks. */
export async function projectForTask(db: Database, orgId: string, projectId: string) {
  const [project] = await db
    .select()
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!project) throw new ValidationError("That project does not exist", "issue_project.not_found");
  if (project.archivedAt) throw new ValidationError("That project is archived", "issue_project.archived");
  return project;
}

/**
 * The project an agent named, in any capitals. An unknown name is refused with the names that exist, so a typo never
 * starts a second project. `new`: the person asked for a new one, so an unknown name is made on the spot. `list`: only
 * read, so an archived one will do. Otherwise an archived project is refused: it takes no new task.
 */
export async function projectByName(
  deps: ProjectDeps,
  orgId: string,
  name: string,
  mode: "task" | "new" | "list" = "task",
) {
  const wanted = cleanName(name);
  const [found] = await deps.db.select().from(issueProjects).where(byName(orgId, wanted));
  if (found?.archivedAt && mode !== "list") {
    throw new ValidationError(
      `The project "${found.name}" is archived and takes no new task. A person brings it back from its board.`,
      "issue_project.archived",
    );
  }
  if (found) return found;
  if (mode === "new") {
    const row = await insertProject(deps.db, orgId, { name: wanted });
    await announce(deps, orgId);
    return row;
  }
  const names = (await projectRows(deps.db, orgId)).filter((p) => !p.archivedAt).map((p) => `"${p.name}"`);
  const message = names.length
    ? `There is no project named "${wanted}". The projects are: ${names.join(", ")}. Use one of them, or set new_project only when the person asked for a new project.`
    : `There is no project named "${wanted}", and no projects yet. Set new_project only when the person asked for a new project.`;
  throw new ValidationError(message, "issue_project.unknown");
}

/** Every project's repositories in the org, in order, by project id. */
async function reposByProject(db: Executor, orgId: string) {
  const rows = await db
    .select({ projectId: projectRepos.projectId, repo: projectRepos.repo })
    .from(projectRepos)
    .where(eq(projectRepos.orgId, orgId))
    .orderBy(asc(projectRepos.projectId), asc(projectRepos.position));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.projectId, [...(out.get(r.projectId) ?? []), r.repo]);
  return out;
}

/** One project's repositories in order, its main one first (no permission check: for the agents' context). */
export async function projectRepositories(db: Executor, orgId: string, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ repo: projectRepos.repo })
    .from(projectRepos)
    .where(and(eq(projectRepos.orgId, orgId), eq(projectRepos.projectId, projectId)))
    .orderBy(asc(projectRepos.position));
  return rows.map((r) => r.repo);
}

/**
 * A project's repositories as they are saved: each one `owner/name` (a GitHub address or `.git` will do, a whole
 * account won't), no repeats whatever their capitals, the order kept.
 */
export function cleanProjectRepositories(input: readonly string[]): string[] {
  const out: string[] = [];
  const invalid: string[] = [];
  for (const raw of input) {
    const entry = normalizeRepoEntry(raw);
    if (!entry || entry.endsWith("/*")) {
      invalid.push(raw);
      continue;
    }
    if (!out.some((e) => e.toLowerCase() === entry.toLowerCase())) out.push(entry);
  }
  if (invalid.length > 0) {
    throw new ValidationError(
      `Not a repository (owner/name): ${invalid.join(", ")}`,
      "issue_project.invalid_repository",
      { invalid },
    );
  }
  if (out.length > PROJECT_REPOSITORIES_MAX) {
    throw new ValidationError(
      `A project works on at most ${PROJECT_REPOSITORIES_MAX} repositories`,
      "issue_project.too_many_repositories",
      { max: PROJECT_REPOSITORIES_MAX },
    );
  }
  return out;
}

/**
 * `PUT …/issue-projects/{id}/repositories`: replaces the project's repositories, its main one first. Only an
 * administrator (or the owner): the agents working on a project's tasks are pointed at these repositories, and ADR
 * 0202 lets them reach them, so linking one is a grant to agents and never a poster's call. Audited.
 */
export async function setProjectRepositories(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  projectId: string,
  repositories: readonly string[],
): Promise<string[]> {
  const membership = await requireActiveMembership(deps.db, userId, orgId);
  if (!can(membership, "administrator")) {
    throw new ForbiddenError("Only an administrator can link repositories to a project", "issue_project.admin_only");
  }
  const [project] = await deps.db
    .select({ id: issueProjects.id })
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!project) throw new NotFoundError("Project not found");
  const list = cleanProjectRepositories(repositories);
  const before = await projectRepositories(deps.db, orgId, projectId);
  if (before.length === list.length && before.every((r, i) => r === list[i])) return list;
  await deps.db.transaction(async (tx) => {
    await tx.delete(projectRepos).where(and(eq(projectRepos.orgId, orgId), eq(projectRepos.projectId, projectId)));
    if (list.length > 0) {
      await tx.insert(projectRepos).values(list.map((repo, position) => ({ orgId, projectId, repo, position })));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "issue.project_repositories_changed",
      target: { type: "issue_project", id: projectId },
      details: { repositories: list, before },
    });
  });
  await announce(deps, orgId);
  return list;
}

/** A task's project's name and repositories, its main one first; null when it has no project or none linked. */
export async function taskProjectRepositories(
  db: Executor,
  orgId: string,
  issueId: string,
): Promise<{ project: string; repositories: string[] } | null> {
  const [row] = await db
    .select({ projectId: issueProjects.id, project: issueProjects.name })
    .from(issues)
    .innerJoin(issueProjects, eq(issueProjects.id, issues.projectId))
    .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)));
  if (!row) return null;
  const repositories = await projectRepositories(db, orgId, row.projectId);
  return repositories.length ? { project: row.project, repositories } : null;
}

/**
 * The task a run works on, for what is read before its context is (a computer turn's checkouts, `git_clone`): the
 * task the run is tied to (`agent_runs.issue_id`), else the task whose own conversation the run is in (ADR 0145).
 */
export async function taskOfRun(db: Executor, orgId: string, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ issueId: agentRuns.issueId, channelId: agentRuns.channelId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!row) return null;
  if (row.issueId) return row.issueId;
  const [task] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.conversationChannelId, row.channelId)));
  return task?.id ?? null;
}

/** The main repository of the project of the task a run works on (ADR 0218 §4); null when there is none. */
export async function runProjectMainRepo(db: Executor, orgId: string, runId: string): Promise<string | null> {
  const issueId = await taskOfRun(db, orgId, runId);
  if (!issueId) return null;
  return (await taskProjectRepositories(db, orgId, issueId))?.repositories[0] ?? null;
}

/** The lines a task's brief says of its project's repositories (English, for the agent). */
export function projectReposLines(p: { project: string; repositories: string[] }) {
  const [main, ...rest] = p.repositories;
  return [
    "## Repositories",
    `This task is in the project ${p.project}, which works on ${p.repositories.length === 1 ? "this GitHub repository" : "these GitHub repositories, its main one first"}:`,
    `- ${main} (main)`,
    ...rest.map((r) => `- ${r}`),
    `Work in ${main} unless the task or the person names another of them. \`git_clone\` with no repo clones ${main}.`,
  ].join("\n");
}

/**
 * `PUT …/issue-projects/{id}/github-import`: issues opened in the project's repositories become its tasks, and pull
 * requests that close them join them (ADR 0218 §6). Only an administrator, as linking its repositories: the tasks are
 * made in their name and seen by the whole workspace, whatever the repository's own visibility. Audited.
 */
export async function setProjectGithubImport(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  projectId: string,
  on: boolean,
): Promise<boolean> {
  const membership = await requireActiveMembership(deps.db, userId, orgId);
  if (!can(membership, "administrator")) {
    throw new ForbiddenError("Only an administrator can import a project's GitHub issues", "issue_project.admin_only");
  }
  const [project] = await deps.db
    .select({ id: issueProjects.id, githubImport: issueProjects.githubImport })
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!project) throw new NotFoundError("Project not found");
  if (project.githubImport === on) return on;
  await deps.db.transaction(async (tx) => {
    await tx
      .update(issueProjects)
      .set({ githubImport: on, githubImportBy: on ? userId : null })
      .where(eq(issueProjects.id, projectId));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "issue.project_github_import_changed",
      target: { type: "issue_project", id: projectId },
      details: { on },
    });
  });
  await announce(deps, orgId);
  return on;
}
