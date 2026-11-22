import type { IssueProject } from "@agenteschat/client";
import { useIssueProjects, useIssues } from "@agenteschat/client";
import { type ProjectCrew, projectCrews } from "@agenteschat/client/lib/issue-projects";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Chip, ColorDot, EmptyState, GroupHeading, Icon, PageHeader } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { AssigneeFaces } from "./IssueAssignees";
import { ProjectDialog } from "./IssueProjects";
import "./issues.css";
import "./projects.css";

/**
 * Projects (ADR 0202 §7): a card per project in use, each with its open tasks, its repositories (the main one named)
 * and the people and agents on its open tasks, the one at work first; a card opens the project's board. Archived ones
 * wait under a heading, folded. With none, the right hand says what a project is beside "New project".
 */
export function ProjectsPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const list = useIssueProjects(org.id);
  // Every task the reader sees, for who works on each project; the cards draw without it while it loads.
  const issues = useIssues(org.id);
  const crews = useMemo(() => projectCrews(issues.data ?? []), [issues.data]);
  const look = useRightHandLook();
  const posts = can(org, "post");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const projects = list.data?.projects ?? [];
  const live = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  const none = list.isSuccess && live.length === 0;
  const newButton = posts && (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      {t("issues.projects.new")}
    </Button>
  );
  return (
    <div className="page page--list projects">
      <PageHeader
        title={t("issues.projects.page.title")}
        meta={t("issues.projects.page.subtitle")}
        // The empty state takes over this button: one way in, in the middle of the page.
        actions={!none && newButton}
      />
      {list.isLoading && <LoadingCards count={3} />}
      {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && (
        <div className="ac-groups">
          {none ? (
            <EmptyState
              className="projects__empty"
              size="page"
              agent={look}
              title={t("issues.projects.page.firstTitle")}
              actions={newButton || undefined}
            >
              {t("issues.projects.page.firstText")}
            </EmptyState>
          ) : (
            <div className="projects__list">
              {live.map((p) => (
                <ProjectCard key={p.id} project={p} crew={crews.get(p.id)} />
              ))}
            </div>
          )}
          {archived.length > 0 && (
            <section className="projects__group" aria-label={t("issues.projects.archived")}>
              <GroupHeading
                title={t("issues.projects.archived")}
                count={archived.length}
                aside={
                  <Button variant="link" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
                    {t(showArchived ? "issues.projects.page.hideArchived" : "issues.projects.page.showArchived")}
                  </Button>
                }
              />
              {showArchived && (
                <div className="projects__list">
                  {archived.map((p) => (
                    <ProjectCard key={p.id} project={p} crew={crews.get(p.id)} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
      <ProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** One project: its color and name, its open tasks, its main repository and how many more, and who is on it. */
function ProjectCard({ project: p, crew }: { project: IssueProject; crew?: ProjectCrew }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [main, ...more] = p.repositories;
  // An open task with nobody on it makes a crew of none: no faces, and no foot for them alone.
  const onIt = crew && crew.assignees.length > 0 ? crew : undefined;
  return (
    <Link
      to="/org/$orgId/issues"
      params={{ orgId: org.id }}
      search={{ project: p.id }}
      className="ac-card ac-card--interactive projects-card"
      data-archived={p.archived || undefined}
    >
      <span className="ac-iconline projects-card__title">
        <ColorDot color={p.color} />
        <span className="projects-card__name">{p.name}</span>
      </span>
      <span className="projects-card__meta">
        {p.open > 0 ? t("issues.projects.page.open", { count: p.open }) : t("issues.projects.page.noOpen")}
      </span>
      <span className="ac-iconline projects-card__repo">
        <Icon name="repo" size={16} />
        {main ? (
          <span className="projects-card__repo-text">
            <span className="projects-card__repo-name">{main}</span>
            {more.length > 0 && (
              <span className="projects-card__quiet">
                {" "}
                {t("issues.projects.page.moreRepos", { count: more.length })}
              </span>
            )}
          </span>
        ) : (
          <span className="projects-card__quiet">{t("issues.projects.page.noRepo")}</span>
        )}
      </span>
      {(onIt || p.githubImport) && (
        <span className="projects-card__foot">
          {onIt && <AssigneeFaces all={onIt.assignees} working={onIt.working} max={5} />}
          {p.githubImport && <Chip icon="repo">{t("issues.projects.repos.importing")}</Chip>}
        </span>
      )}
    </Link>
  );
}
