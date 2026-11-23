import type { Issue, IssueProject } from "@agenteschat/client";
import { useIssueProjectAction, useIssueProjects, useIssues } from "@agenteschat/client";
import { dueLabel, timeAgo } from "@agenteschat/client/lib/format";
import { projectOverview } from "@agenteschat/client/lib/issue-projects";
import { STATUS_ICON } from "@agenteschat/client/lib/issues";
import { blockedText } from "@agenteschat/client/lib/long-work";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  ColorDot,
  codeAndBold,
  type Fact,
  FactLine,
  FactStrip,
  GroupHeading,
  Icon,
  type LineFact,
  Menu,
  MenuItem,
  PageHeader,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useStageName } from "@/lib/issues";
import { DeleteProjectDialog, ProjectDialog, ProjectRepositories } from "./IssueProjects";
import { StalledNow, StatusChip } from "./IssuesPage";
import "./issues.css";
import "./projects.css";

/**
 * One project's overview (ADR 0218 §8): how far it is (its tasks by stage), the stalled work, the late and blocked
 * tasks, who works on it, its repositories and the tasks changed last; "Abrir quadro" opens its board. A project that
 * is gone, deleted here or elsewhere, sends the reader back to the projects.
 */
export function ProjectPage({ projectId }: { projectId: string }) {
  const { org } = useOrg();
  const navigate = useNavigate();
  const list = useIssueProjects(org.id);
  const project = list.data?.projects.find((p) => p.id === projectId);
  const gone = list.isSuccess && !list.isFetching && !project;
  useEffect(() => {
    if (gone) void navigate({ to: "/org/$orgId/projects", params: { orgId: org.id }, replace: true });
  }, [gone, navigate, org.id]);
  return (
    <div className="page page--list project-overview">
      {list.isLoading && <LoadingCards count={3} />}
      {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {project && <Overview project={project} />}
    </div>
  );
}

function Overview({ project: p }: { project: IssueProject }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const action = useIssueProjectAction(org.id);
  const query = useIssues(org.id, "", p.id);
  // The list keeps the last one while a new one loads, another project's included: only this one's tasks count.
  const issues = useMemo(() => (query.data ?? []).filter((i) => i.project?.id === p.id), [query.data, p.id]);
  const o = useMemo(() => projectOverview(issues), [issues]);
  const stageName = useStageName();
  const posts = can(org, "post");
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const openTask = (n: number) =>
    void navigate({ to: "/org/$orgId/issues/$number", params: { orgId: org.id, number: String(n) } });
  const facts: Fact[] = o.stages.map((s) => ({
    key: s.stage,
    icon: STATUS_ICON[s.stage],
    label: stageName(s.stage),
    value: <span className="tabular">{s.count}</span>,
    tone: s.stage === "done" && s.count > 0 ? "done" : undefined,
  }));
  // Late first, then blocked; a task both late and blocked shows once, with both.
  const attention = [...new Set([...o.late, ...o.blocked])];
  const late = new Set(o.late);
  return (
    <>
      <PageHeader
        title={
          // Inside the title, so the dot stays on the first line of a name that wraps.
          <>
            <ColorDot color={p.color} />
            {p.name}
          </>
        }
        count={
          (o.total > 0 || p.archived) && (
            <>
              {o.total > 0 && <span>{t("issues.projects.overview.done", { done: o.done, count: o.total })}</span>}
              {o.total > 0 && p.archived && <span> · </span>}
              {p.archived && <span>{t("issues.projects.archivedMark")}</span>}
            </>
          )
        }
        actions={
          <span className="ac-acts">
            {posts && (
              <Menu
                align="end"
                label={t("issues.moreOptions")}
                trigger={<Button iconOnly icon="more" aria-label={t("issues.moreOptions")} />}
              >
                <MenuItem icon="edit" onSelect={() => setDialog("edit")}>
                  {t("issues.projects.edit")}
                </MenuItem>
                <MenuItem
                  icon="archive"
                  disabled={action.isPending}
                  onSelect={() => action.mutate({ type: "update", projectId: p.id, archived: !p.archived })}
                >
                  {t(p.archived ? "issues.projects.unarchive" : "issues.projects.archive")}
                </MenuItem>
                <MenuItem icon="trash" danger onSelect={() => setDialog("delete")}>
                  {t("issues.projects.delete")}
                </MenuItem>
              </Menu>
            )}
            <Button asChild variant="primary">
              <Link to="/org/$orgId/issues" params={{ orgId: org.id }} search={{ project: p.id }}>
                <Icon name="layers" />
                <span className="ac-btn__label">{t("issues.projects.overview.openBoard")}</span>
              </Link>
            </Button>
          </span>
        }
      />
      <div className="ac-groups">
        <ProjectRepositories project={p} />
        <StalledNow issues={issues} onOpen={openTask} />
        {query.isError && !query.data && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {/* No task yet: one line says so, no empty stages or people to read. */}
        {query.isSuccess && issues.length === 0 ? (
          <p className="project-overview__quiet">{t("issues.projects.empty")}</p>
        ) : (
          query.data && (
            <>
              <section className="project-overview__group" aria-label={t("issues.projects.overview.stages")}>
                <GroupHeading title={t("issues.projects.overview.stages")} />
                <FactStrip facts={facts} />
              </section>
              {attention.length > 0 && (
                <section className="project-overview__group" aria-label={t("issues.projects.overview.attention")}>
                  <GroupHeading title={t("issues.projects.overview.attention")} count={attention.length} />
                  <div className="ac-list">
                    {attention.map((i) => (
                      <TaskRow
                        key={i.id}
                        issue={i}
                        facts={[
                          ...(late.has(i) && i.dueDate
                            ? [
                                {
                                  key: "late",
                                  icon: "alert",
                                  tone: "warn",
                                  text: t("issues.projects.overview.late", {
                                    date: dueLabel(t, i18n.language, i.dueDate),
                                  }),
                                } satisfies LineFact,
                              ]
                            : []),
                          ...(i.blocked
                            ? [
                                {
                                  key: "blocked",
                                  icon: "pause",
                                  tone: "warn",
                                  text: blockedText(t, i.blocked),
                                } satisfies LineFact,
                              ]
                            : []),
                        ]}
                      />
                    ))}
                  </div>
                </section>
              )}
              <section className="project-overview__group" aria-label={t("issues.projects.overview.people")}>
                <GroupHeading title={t("issues.projects.overview.people")} count={o.members.length || undefined} />
                {o.members.length > 0 ? (
                  <div className="ac-list">
                    {o.members.map((m) => (
                      <MemberRow key={`${m.actor.type}:${m.actor.id}`} member={m} />
                    ))}
                  </div>
                ) : (
                  <p className="project-overview__quiet">{t("issues.projects.overview.nobody")}</p>
                )}
              </section>
              {o.recent.length > 0 && (
                <section className="project-overview__group" aria-label={t("issues.projects.overview.recent")}>
                  <GroupHeading title={t("issues.projects.overview.recent")} />
                  <div className="ac-list">
                    {o.recent.map((i) => (
                      <TaskRow
                        key={i.id}
                        issue={i}
                        status
                        facts={[{ key: "updated", icon: "clock", text: timeAgo(t, i.updatedAt) }]}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )
        )}
      </div>
      <ProjectDialog open={dialog === "edit"} project={p} onClose={() => setDialog(null)} />
      <DeleteProjectDialog
        open={dialog === "delete"}
        project={p}
        onClose={() => setDialog(null)}
        onDeleted={() => {}}
      />
    </>
  );
}

/** A task as a row that opens it: its number and title, then quiet facts (why it needs care, or when it changed). */
function TaskRow({ issue: i, facts, status }: { issue: Issue; facts: LineFact[]; status?: boolean }) {
  const { org } = useOrg();
  return (
    <Link
      to="/org/$orgId/issues/$number"
      params={{ orgId: org.id, number: String(i.number) }}
      className="ac-list__row project-task"
    >
      <span className="project-task__title">
        <span className="project-task__num tabular">#{i.number}</span> {codeAndBold(i.title)}
      </span>
      <span className="project-task__end">
        {status && <StatusChip status={i.status} />}
        <FactLine facts={facts} />
      </span>
    </Link>
  );
}

/** Someone on the project's open tasks: face and name, how many tasks, and an agent's work now. */
function MemberRow({ member: m }: { member: ReturnType<typeof projectOverview>["members"][number] }) {
  const { t } = useTranslation();
  const actors = useActors();
  const name = actors.name(m.actor);
  const face =
    m.actor.type === "agent" && m.work ? (
      <AgentAvatar
        agentId={m.actor.id}
        size="sm"
        name={name}
        running={m.work === "running"}
        state={m.work === "running" ? "writing" : undefined}
        expression={m.work === "stalled" ? "closed" : undefined}
      />
    ) : (
      actors.avatar(m.actor, "sm")
    );
  return (
    <div className="ac-list__row project-member">
      <span className="project-member__who">
        {face}
        <span className="project-member__name">{name}</span>
      </span>
      <span className="project-member__meta">
        {t("issues.projects.page.open", { count: m.open })}
        {m.work && (
          <span data-work={m.work}>
            {" · "}
            {t(m.work === "running" ? "issues.projects.overview.working" : "issues.projects.overview.stalled")}
          </span>
        )}
      </span>
    </div>
  );
}
