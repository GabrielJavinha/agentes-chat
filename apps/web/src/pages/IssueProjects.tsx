import type { IssueProject, IssueProjectRef, IssueProjects } from "@agenteschat/client";
import {
  useGitHubRepos,
  useIssueProjectAction,
  useIssueProjects,
  useSetProjectRepositories,
} from "@agenteschat/client";
import {
  NO_PROJECT,
  PROJECT_COLORS,
  PROJECT_NAME_MAX,
  pickableProjects,
  projectFilterRows,
} from "@agenteschat/client/lib/issue-projects";
import { can } from "@agenteschat/client/lib/permissions";
import { makeFirst } from "@agenteschat/client/lib/repos";
import {
  Button,
  Checkbox,
  Chip,
  ChipButton,
  ColorDot,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  ditherUrl,
  Field,
  FilterChip,
  type FilterOption,
  Input,
  Locked,
  Menu,
  MenuItem,
} from "@agenteschat/ui";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFilterCopy } from "@/components/filters";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import "@/components/roles/roles.css";

/** The first color no project wears yet, so a new one stands apart without a choice. */
const freeColor = (projects: IssueProjectRef[]) =>
  PROJECT_COLORS.find((c) => !projects.some((p) => p.color === c)) ?? PROJECT_COLORS[0] ?? "graphite";

/**
 * "Novo projeto" and "Editar projeto": a name and one of the roles' colors. Mounted while open. `onDone` gets the
 * project as saved, so whoever opened it from a task's field can put the task in it.
 */
export function ProjectDialog({
  project,
  onClose,
  onDone,
}: {
  /** The project to edit. None: a new one. */
  project?: IssueProjectRef;
  onClose: () => void;
  onDone?: (project: IssueProjectRef) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueProjectAction(org.id);
  const projects = useIssueProjects(org.id).data?.projects ?? [];
  const [name, setName] = useState(project?.name ?? "");
  const [picked, setPicked] = useState<string | null>(project?.color ?? null);
  const color = picked ?? freeColor(projects);
  const save = () => {
    const value = name.trim();
    if (!value || action.isPending) return;
    if (project && value === project.name && color === project.color) return onClose();
    action.mutate(
      project ? { type: "update", projectId: project.id, name: value, color } : { type: "create", name: value, color },
      {
        onSuccess: (saved) => {
          if (saved) onDone?.(saved);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(project ? "issues.projects.edit" : "issues.projects.new")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Locked when={action.isPending}>
          <DialogBody>
            <Field label={t("rolesPage.name")} id="issue-project-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={PROJECT_NAME_MAX}
                autoComplete="off"
                autoFocus
              />
            </Field>
            <div className="roles-colors" role="radiogroup" aria-label={t("rolesPage.color")}>
              {PROJECT_COLORS.map((c) => (
                // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={t("rolesPage.colorOf", { color: c })}
                  className="roles-color"
                  style={{ backgroundImage: `url("${ditherUrl(c, 8)}")` }}
                  onClick={() => setPicked(c)}
                />
              ))}
            </div>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={action.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim() || action.isPending}
            loading={action.isPending}
          >
            {project ? t("common.save") : t("issues.projects.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Excluir o projeto X?": its tasks stay, with no project. Mounted while open. */
export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: IssueProjectRef;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueProjectAction(org.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !action.isPending && onClose()}
      title={t("issues.projects.deleteTitle", { name: project.name })}
      description={t("issues.projects.deleteBody")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button type="button" onClick={onClose} disabled={action.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={action.isPending}
          disabled={action.isPending}
          onClick={() =>
            action.mutate(
              { type: "delete", projectId: project.id },
              {
                onSuccess: () => {
                  onDeleted();
                  onClose();
                },
              },
            )
          }
        >
          {t("issues.projects.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The toolbar's "Projeto" chip, which is the whole projects list: each project with its color and its open tasks,
 * "Sem projeto", the archived ones under their own heading, and "Novo projeto" for who may create one. Picking one
 * opens its board. With one picked the chip wears its dot and name, and × goes back to every task.
 */
export function ProjectChip({
  data,
  value,
  onChange,
  onNew,
}: {
  data: IssueProjects | undefined;
  /** A project's id, `none`, or nothing. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** Who may create tasks: "Novo projeto" at the menu's end. */
  onNew?: () => void;
}) {
  const { t } = useTranslation();
  const copy = useFilterCopy();
  const projects = data?.projects ?? [];
  const row = (p: IssueProject | null): FilterOption =>
    p
      ? {
          value: p.id,
          label: p.name,
          leading: <ColorDot color={p.color} />,
          count: p.open,
          ...(p.archived ? { group: t("issues.projects.archived") } : {}),
        }
      : { value: NO_PROJECT, label: t("issues.projects.none"), leading: <ColorDot />, count: data?.unfiled ?? 0 };
  // Before the first project there is nothing to filter by: the menu is "Novo projeto" alone, and who can't make one
  // has no chip.
  if (projects.length === 0 && !onNew) return null;
  const options = projects.length === 0 ? [] : projectFilterRows(projects).map(row);
  return (
    <FilterChip
      label={t("issues.projects.label")}
      icon="layers"
      options={options}
      value={value ? [value] : []}
      onChange={(next) => onChange(next[0])}
      valueText={(o) => o.label}
      valueLeading
      clearLabel={copy.clearOf(t("issues.projects.label"))}
      searchLabel={t("issues.projects.label")}
      action={onNew && { label: t("issues.projects.new"), icon: "plus", onSelect: onNew }}
    />
  );
}

/** In a task's project select: opens "Novo projeto" instead of choosing. */
export const NEW_PROJECT = "new";

/** What a task's "Projeto" select offers: the projects in use (and the task's own, even archived), none, a new one. */
export function useProjectOptions(current: IssueProjectRef | null | undefined, mayCreate: boolean) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const projects = useIssueProjects(org.id).data?.projects ?? (current ? [{ ...current, open: 0 }] : []);
  return [
    ...pickableProjects(projects, current).map((p) => ({
      value: p.id,
      label: p.name,
      leading: <ColorDot color={p.color} />,
    })),
    { value: NO_PROJECT, label: t("issues.projects.none"), leading: <ColorDot /> },
    ...(mayCreate ? [{ value: NEW_PROJECT, label: t("issues.projects.new"), action: true }] : []),
  ];
}

const githubUrl = (repo: string) => `https://github.com/${repo}`;
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Under a project board's title (ADR 0202): "Repositórios", the project's GitHub repositories (its main one first,
 * marked), each a chip whose menu opens it on GitHub and, for an administrator, makes it the main one or unlinks it,
 * then "Vincular repositório" or "Mudar". Nothing when it has none and the reader can't link one.
 */
export function ProjectRepositories({ project }: { project: IssueProject }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const save = useSetProjectRepositories(org.id, project.id);
  const [picking, setPicking] = useState(false);
  const admin = can(org, "administrator");
  const list = project.repositories;
  if (list.length === 0 && !admin) return null;
  return (
    <div className="agp-repos">
      <span className="agp-repos__line">
        <span className="agp-repos__label">{t("issues.projects.repos.label")}</span>
        {list.map((repo, i) => (
          <Fragment key={repo}>
            <Menu
              label={t("repos.options", { repo })}
              trigger={
                <ChipButton
                  icon={i === 0 && list.length > 1 ? "pin" : "repo"}
                  className="agp-chipbtn"
                  aria-label={`${repo} · ${t("repos.options", { repo })}`}
                >
                  {repo}
                </ChipButton>
              }
            >
              <MenuItem icon="external" onSelect={() => window.open(githubUrl(repo), "_blank", "noopener,noreferrer")}>
                {t("issues.projects.repos.open")}
              </MenuItem>
              {admin && i > 0 && (
                <MenuItem icon="pin" disabled={save.isPending} onSelect={() => save.mutate(makeFirst(list, repo))}>
                  {t("issues.projects.repos.makeMain")}
                </MenuItem>
              )}
              {admin && (
                <MenuItem
                  icon="close"
                  disabled={save.isPending}
                  onSelect={() => save.mutate(list.filter((r) => r !== repo))}
                >
                  {t("repos.remove")}
                </MenuItem>
              )}
            </Menu>
            {i === 0 && list.length > 1 && <Chip>{t("issues.projects.repos.main")}</Chip>}
          </Fragment>
        ))}
        {admin && (
          <Button variant="link" onClick={() => setPicking(true)}>
            {list.length === 0 ? t("issues.projects.repos.link") : t("repos.change")}
          </Button>
        )}
      </span>
      {picking && <ProjectReposDialog project={project} onClose={() => setPicking(false)} />}
    </div>
  );
}

/**
 * Which repositories the project works on: the ones the workspace's GitHub reaches, by account, with a search. The
 * order picked is kept (the first is the main one); one linked before that GitHub no longer lists stays on top, so
 * saving never drops it unseen.
 */
function ProjectReposDialog({ project, onClose }: { project: IssueProject; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const listing = useGitHubRepos(org.id);
  const save = useSetProjectRepositories(org.id, project.id);
  const [pick, setPick] = useState(project.repositories);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const listed = (listing.data?.accounts ?? []).flatMap((a) => a.repositories.map((r) => r.fullName));
  const unlisted = project.repositories.filter((r) => !listed.some((l) => sameRepo(l, r)));
  const matches = (name: string) => !query || name.toLowerCase().includes(query);
  const toggle = (name: string, on: boolean) =>
    setPick((p) => (on ? [...p.filter((r) => !sameRepo(r, name)), name] : p.filter((r) => !sameRepo(r, name))));
  const id = (s: string) => `project-repo-${s.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const row = (name: string, priv?: boolean) => (
    <label key={name} htmlFor={id(name)} className="scope-row">
      <Checkbox
        id={id(name)}
        checked={pick.some((r) => sameRepo(r, name))}
        onCheckedChange={(on) => toggle(name, on === true)}
      />
      <span className="scope-row__text">
        <b>{name}</b>
      </span>
      {pick[0] && sameRepo(pick[0], name) && pick.length > 1 && (
        <Chip icon="pin" className="agp-repodialog__first">
          {t("issues.projects.repos.main")}
        </Chip>
      )}
      {priv && <Chip icon="lock">{t("repos.private")}</Chip>}
    </label>
  );
  const accounts = (listing.data?.accounts ?? [])
    .map((a) => ({ ...a, repositories: a.repositories.filter((r) => matches(r.fullName)) }))
    .filter((a) => a.repositories.length > 0);
  const shownUnlisted = unlisted.filter(matches);
  const empty = accounts.length === 0 && shownUnlisted.length === 0;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title={t("issues.projects.repos.dialogTitle", { name: project.name })}
      description={t("issues.projects.repos.dialogDesc")}
      closeLabel={t("common.close")}
      className="agp-repodialog"
    >
      {listing.isLoading ? (
        <div className="ac-dialog__body">
          <LoadingLine width={220} />
        </div>
      ) : listing.isError ? (
        <p className="ac-dialog__empty">{t("repos.unavailable")}</p>
      ) : listing.data && !listing.data.connected && unlisted.length === 0 ? (
        <p className="ac-dialog__empty">{t("issues.projects.repos.notConnected")}</p>
      ) : (
        <Locked when={save.isPending}>
          <DialogSearchList
            query={q}
            onQueryChange={setQ}
            searchLabel={t("repos.search")}
            searchPlaceholder={t("repos.search")}
            listLabel={t("issues.projects.repos.label")}
            isEmpty={empty}
            emptyText={query ? t("repos.noMatch", { q }) : t("repos.none")}
          >
            {shownUnlisted.length > 0 && (
              <section className="agp-repogroup">{shownUnlisted.map((name) => row(name))}</section>
            )}
            {accounts.map((a) => (
              <section key={a.login} className="agp-repogroup" aria-label={a.login}>
                <p className="ac-eyebrow">{a.login}</p>
                {a.repositories.map((r) => row(r.fullName, r.private))}
              </section>
            ))}
          </DialogSearchList>
        </Locked>
      )}
      <DialogFooter bar>
        <Button onClick={onClose} disabled={save.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={save.isPending || (pick.length === 0 && project.repositories.length === 0)}
          onClick={() => save.mutate(pick, { onSuccess: onClose })}
        >
          {pick.length === 0
            ? t("issues.projects.repos.saveNone")
            : t("issues.projects.repos.save", { count: pick.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
