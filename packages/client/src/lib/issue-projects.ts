import { AGENT_COLORS } from "@agenteschat/tokens/look";
import type { Actor, Issue, IssueProject, IssueProjectRef } from "../api/types";
import { isUuid } from "./format";
import { isOpen } from "./issues";

/** A project's name holds at most this (mirror of `PROJECT_NAME_MAX`, packages/engine/src/issue-projects.ts). */
export const PROJECT_NAME_MAX = 80;

/** The colors a project can take: the roles' (mirror of `ROLE_COLORS`, packages/engine/src/permissions.ts). */
export const PROJECT_COLORS = AGENT_COLORS.filter((c) => c !== "sky");

/** In a project filter and its URL: the tasks with no project. */
export const NO_PROJECT = "none";

/** A project filter from a URL or a stored value: a project's id, `none`, or nothing. */
export const projectFilterOf = (value: unknown): string | undefined =>
  typeof value === "string" && (value === NO_PROJECT || isUuid(value)) ? value : undefined;

/**
 * The projects a task can take: the ones in use, plus the one it already has when that one is archived (so the
 * picker still names it).
 */
export function pickableProjects<P extends IssueProjectRef>(projects: P[], current?: IssueProjectRef | null) {
  const live = projects.filter((p) => !p.archived);
  if (!current?.archived || live.some((p) => p.id === current.id)) return live;
  return [...live, ...projects.filter((p) => p.id === current.id)];
}

/** A project filter's rows in order: the projects in use, the tasks with none (`null`), then the archived ones. */
export const projectFilterRows = <P extends IssueProjectRef>(projects: P[]): (P | null)[] => [
  ...projects.filter((p) => !p.archived),
  null,
  ...projects.filter((p) => p.archived),
];

/** A picked filter while it still means something: `none`, or a project that exists. Else every task (""). */
export const liveProjectFilter = (projects: IssueProjectRef[], picked: string) =>
  picked === NO_PROJECT || projects.some((p) => p.id === picked) ? picked : "";

/** The project a filter names, when it is one that still exists. */
export const projectOfFilter = (projects: IssueProject[] | undefined, filter: string | undefined) =>
  filter && filter !== NO_PROJECT ? (projects?.find((p) => p.id === filter) ?? null) : null;

/** Who works on a project now: the people and agents on its open tasks, and the agent at work on one of them. */
export interface ProjectCrew {
  /** Each once, in the order the tasks list them; the agent at work first. */
  assignees: Actor[];
  /** One agent at work (running or waiting on someone first), else one whose work stalled. */
  working?: { agentId: string; work: "running" | "stalled" };
}

/**
 * The crew of every project, by its id, from the tasks the reader sees (`useIssues`, every project's): only open tasks
 * count, so a project whose tasks are all done has none. A project missing from the map has no open task with anyone.
 */
export function projectCrews(issues: Pick<Issue, "status" | "project" | "assignees" | "work">[]) {
  const crews = new Map<string, ProjectCrew>();
  for (const issue of issues) {
    const projectId = issue.project?.id;
    if (!projectId || !isOpen(issue)) continue;
    const crew = crews.get(projectId) ?? { assignees: [] };
    for (const a of issue.assignees)
      if (!crew.assignees.some((b) => b.type === a.type && b.id === a.id)) crew.assignees.push(a);
    const work = issue.work;
    if (work && issue.assignees.some((a) => a.type === "agent" && a.id === work.agentId)) {
      const state = work.state === "stalled" ? "stalled" : "running";
      if (!crew.working || (crew.working.work === "stalled" && state === "running"))
        crew.working = { agentId: work.agentId, work: state };
    }
    crews.set(projectId, crew);
  }
  for (const crew of crews.values()) {
    const at = crew.working
      ? crew.assignees.findIndex((a) => a.type === "agent" && a.id === crew.working?.agentId)
      : -1;
    if (at > 0) crew.assignees.unshift(...crew.assignees.splice(at, 1));
  }
  return crews;
}
