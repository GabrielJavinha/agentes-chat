import { and, asc, type Database, eq, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { cutText } from "../format";
import { createIssue, type IssueDeps, type IssueStatus, updateIssue } from "../issues";
import { enqueue } from "../outbox";
import { closedRefusal, orgStanding } from "../standing";
import { neutralizeUntrusted } from "../untrusted";
import { parseRepo } from "./repos";

const { githubAppInstallations, issueProjectRepositories, issueProjects, issues } = schema;

/**
 * A project's GitHub issues and pull requests (ADR 0219 §6). Where an administrator turned the import on, an issue
 * opened in one of the project's repositories becomes a task in it (`issues.github_url`, source `github`), its edits,
 * closing and reopening follow, and a pull request that closes such an issue ("Fixes #12", as GitHub reads it) joins
 * the task's pull requests. Its own job (`github_app.project_sync`), apart from the events agents hear
 * (`github-events.ts`): the same delivery may be both.
 */

export const GITHUB_PROJECT_SYNC_JOB = "github_app.project_sync";

/** A task's title from GitHub: one line, nothing hidden in it, cut. */
const TITLE_MAX = 200;
/** What a description from GitHub keeps; agents read it inside an `untrustedBlock`. */
const BODY_MAX = 20_000;

export interface GitHubSyncEvent {
  installationId: number;
  item: "issue" | "pull_request";
  action: "opened" | "edited" | "closed" | "reopened";
  /** `owner/name`, as GitHub spells it. */
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  /** An issue closed as not planned: its task is canceled, not done. */
  notPlanned: boolean;
  /** The sender is a bot (an issue a bot opens is never imported; its pull requests still join their tasks). */
  bot: boolean;
  delivery?: string;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const ACTIONS = new Set(["opened", "edited", "closed", "reopened"]);

/** What a project's import reads in what GitHub sent: an issue or a pull request opened, edited, closed or reopened. */
export function githubSyncEventOf(event: string | null, payload: Record<string, unknown>): GitHubSyncEvent | null {
  if (event !== "issues" && event !== "pull_request") return null;
  const action = str(payload.action);
  const installationId = obj(payload.installation).id;
  const repo = str(obj(payload.repository).full_name);
  if (!ACTIONS.has(action) || typeof installationId !== "number" || !parseRepo(repo)) return null;
  const target = event === "issues" ? obj(payload.issue) : obj(payload.pull_request);
  // GitHub sends `issues` for issues alone, but a payload that says it is a pull request is read as one.
  if (event === "issues" && target.pull_request) return null;
  const number = Number(target.number);
  const url = str(target.html_url);
  if (!Number.isInteger(number) || number <= 0 || !url.startsWith("https://github.com/")) return null;
  return {
    installationId,
    item: event === "issues" ? "issue" : "pull_request",
    action: action as GitHubSyncEvent["action"],
    repo,
    number,
    url,
    title: str(target.title),
    body: str(target.body),
    notPlanned: str(target.state_reason) === "not_planned",
    bot: obj(payload.sender).type === "Bot",
  };
}

/** The projects of the org that import from `repo`, oldest first, with who turned the import on. */
async function importingProjects(db: Database, orgId: string, repo: string) {
  return db
    .select({ id: issueProjects.id, by: issueProjects.githubImportBy })
    .from(issueProjects)
    .innerJoin(issueProjectRepositories, eq(issueProjectRepositories.projectId, issueProjects.id))
    .where(
      and(
        eq(issueProjects.orgId, orgId),
        eq(issueProjects.githubImport, true),
        isNotNull(issueProjects.githubImportBy),
        isNull(issueProjects.archivedAt),
        sql`lower(${issueProjectRepositories.repo}) = lower(${repo})`,
      ),
    )
    .orderBy(asc(issueProjects.createdAt));
}

/**
 * Queues what GitHub sent for a project's import (true), once per delivery, when the installation is bound to a
 * workspace and one of its projects imports from that repository. False otherwise: nothing is kept.
 */
export async function queueGitHubProjectSync(
  db: Database,
  input: { event: string | null; delivery: string | null; payload: Record<string, unknown> },
): Promise<boolean> {
  const event = githubSyncEventOf(input.event, input.payload);
  if (!event) return false;
  const [bound] = await db
    .select({ orgId: githubAppInstallations.orgId })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, event.installationId));
  if (!bound || (await importingProjects(db, bound.orgId, event.repo)).length === 0) return false;
  const delivery = input.delivery?.trim().slice(0, 100);
  await enqueue(db, {
    orgId: bound.orgId,
    kind: GITHUB_PROJECT_SYNC_JOB,
    payload: { event: { ...event, ...(delivery ? { delivery } : {}) } },
    ...(delivery ? { dedupeKey: `${GITHUB_PROJECT_SYNC_JOB}:${delivery}` } : {}),
    maxAttempts: 4,
  });
  return true;
}

/**
 * A task's title from GitHub: it is read in many prompts outside any envelope (lists, briefs), so it keeps no control
 * or format character at all (zero-width, bidi, tags), no envelope marker, one line, cut.
 */
const cleanTitle = (title: string, number: number) =>
  cutText(
    neutralizeUntrusted(title.replace(/[\p{Cc}\p{Cf}]/gu, ""))
      .replace(/\s+/g, " ")
      .trim(),
    TITLE_MAX,
  ) || `GitHub issue #${number}`;

/** The task an issue was imported as, by its address (GitHub's own case or not). */
async function taskOfIssue(db: Database, orgId: string, url: string) {
  const [task] = await db
    .select({ id: issues.id, status: issues.status, title: issues.title, description: issues.description })
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        sql`lower(${issues.githubUrl}) = lower(${url})`,
        sql`${issues.source}->>'type' = 'github'`,
      ),
    )
    .limit(1);
  return task ?? null;
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;
const CLOSING_URL =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b/gi;

/** The issues a pull request closes as GitHub reads its words ("Fixes #12", "closes acme/web#3", a full address). */
export function closedIssuesOf(repo: string, text: string): { repo: string; number: number }[] {
  const out = new Map<string, { repo: string; number: number }>();
  for (const m of [...text.matchAll(CLOSING), ...text.matchAll(CLOSING_URL)]) {
    const where = m[1] ?? repo;
    const number = Number(m[2]);
    if (!parseRepo(where) || !Number.isInteger(number) || number <= 0) continue;
    out.set(`${where.toLowerCase()}#${number}`, { repo: where, number });
  }
  return [...out.values()];
}

/** The quiet refusals of a task made in someone's name who can no longer: the import stops, nothing retries it. */
const settled = (error: unknown) =>
  error instanceof ForbiddenError || error instanceof NotFoundError || error instanceof ValidationError;

/**
 * One event of a project's import (job `github_app.project_sync`): an issue opened becomes a task in the oldest
 * project that imports from its repository, once; edited, its title and description follow; closed, its task is done
 * (canceled when not planned); reopened, to do again. A pull request opened, edited or reopened joins each imported
 * task whose issue it closes. Everything is done in the name of whoever turned the import on, with their permissions.
 * A workspace closed to changes takes none.
 */
export async function handleGitHubProjectSync(
  deps: IssueDeps,
  orgId: string,
  e: GitHubSyncEvent,
): Promise<"created" | "updated" | "linked" | "ignored"> {
  const { db } = deps;
  if (closedRefusal(await orgStanding(db, orgId))) return "ignored";
  const projects = await importingProjects(db, orgId, e.repo);
  const project = projects[0];
  if (!project?.by) return "ignored";
  const actor = { type: "person" as const, userId: project.by };
  try {
    if (e.item === "pull_request") {
      if (e.action === "closed") return "ignored";
      let linked = false;
      for (const closed of closedIssuesOf(e.repo, `${e.title}\n${e.body}`)) {
        const task = await taskOfIssue(db, orgId, `https://github.com/${closed.repo}/issues/${closed.number}`);
        if (!task) continue;
        // Its address is enough: a pull request already linked is replaced by itself.
        await updateIssue(deps, actor, orgId, task.id, { addPullRequest: { number: e.number, url: e.url } });
        linked = true;
      }
      return linked ? "linked" : "ignored";
    }
    const task = await taskOfIssue(db, orgId, e.url);
    if (e.action === "opened") {
      if (task || e.bot) return "ignored";
      await createIssue(deps, actor, orgId, {
        title: cleanTitle(e.title, e.number),
        description: cutText(e.body, BODY_MAX),
        githubUrl: e.url,
        projectId: project.id,
        source: { type: "github", repo: e.repo, number: e.number },
      });
      return "created";
    }
    if (!task) return "ignored";
    if (e.action === "edited") {
      const title = cleanTitle(e.title, e.number);
      const description = cutText(e.body, BODY_MAX);
      if (title === task.title && description === task.description) return "ignored";
      await updateIssue(deps, actor, orgId, task.id, { title, description });
      return "updated";
    }
    const to: IssueStatus = e.action === "reopened" ? "todo" : e.notPlanned ? "canceled" : "done";
    if (task.status === to) return "ignored";
    await updateIssue(deps, actor, orgId, task.id, { status: to });
    return "updated";
  } catch (error) {
    if (settled(error)) return "ignored";
    throw error;
  }
}
