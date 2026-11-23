# 0218. A project's GitHub repositories

- Status: Accepted (built)
- Date: 2026-11-19
- Extends: 0171 (projects in Tarefas), 0033 and 0156 (the workspace's GitHub), the agent's repositories
  (`agent_repositories`)
- Code: `packages/engine/src/issue-projects.ts` (`setProjectRepositories`, `projectRepositories`,
  `cleanProjectRepositories`, `PROJECT_REPOSITORIES_MAX`, `taskOfRun`, `runProjectMainRepo`, `projectReposLines`);
  route `PUT …/issue-projects/{projectId}/repositories` (`apps/server/src/routes/app/issues.ts`); web
  `ProjectRepositories` in `apps/web/src/pages/IssueProjects.tsx`; agents: `issueWorkBrief` (`issue-work.ts`),
  `openTasksBrief` (`issues.ts`), `list_issues` (`issue-tools.ts`), `git_clone` (`git/tools.ts`), `prepareAgentCode`
  (`git/machine.ts`), the GitHub check's `defaultRepo` (`tools/checks.ts`, `tools/types.ts`); reach:
  `agentRepositoryList`, `agentOwnRepositoryList`, `taskProjectRepositoriesOf` (`git/repos.ts`); import:
  `packages/engine/src/git/github-project-sync.ts` (`githubSyncEventOf`, `queueGitHubProjectSync`,
  `handleGitHubProjectSync`, `closedIssuesOf`), `setProjectGithubImport`, route
  `PUT …/issue-projects/{projectId}/github-import`, migration 0312; the Projects page: `apps/web/src/pages/ProjectsPage.tsx`
  (route `org.$orgId.projects.index.tsx`), `projectCrews` (`packages/client/src/lib/issue-projects.ts`), the sidebar's
  `projects` (`packages/engine/src/sidebar-items.ts` and its mirror `packages/client/src/lib/sidebar-items.ts`)

## Context

A project (ADR 0171) is a name, a colour and a board, often for one client or one product, and that work lives in
one or a few GitHub repositories. Today nothing says which: an agent given a task in the project has to be told the
repository each time, or uses the first of its own list (`agent_repositories`), which may belong to another client.
People can't see from the board where the code is either.

## Decision

### 1. A project names its repositories, in order

`issue_project_repositories` holds a project's repositories: `org_id`, `project_id` (deleted with the project),
`repo` as `owner/name` and `position`. The first one is the project's main one. A project holds a repository once
whatever its capitals, and at most 20 (`PROJECT_REPOSITORIES_MAX`). A whole account (`owner/*`) is never one: a
project works on repositories, and §5 would turn an account into a grant of everything in it.

`GET …/issue-projects` carries each project's `repositories`. `PUT …/issue-projects/{id}/repositories` replaces the
list. A GitHub address and `.git` are taken and cleaned. A repository the workspace's GitHub no longer lists stays
until someone takes it out, since GitHub hiding one for a while (an app suspended, a token expired) shouldn't
unlink it.

### 2. Only an administrator links them

Whoever may create tasks (`post`) still creates, renames, archives and deletes projects (ADR 0171 §3). Linking a
repository takes `administrator` (an owner holds it), because the agents working on a project's tasks are pointed at
its repositories (§4) and may come to reach them (§5): linking one decides where agents work with code, which is an
administrator's call, as giving an agent more repositories is. Every change is audited as
`issue.project_repositories_changed` with the list before and after.

### 3. The project's overview shows them

On the project's overview (§8), "Repositórios" lists them as chips, the main one first and marked. A chip's menu opens
it on GitHub and, for an administrator, makes it the main one or unlinks it. "Vincular repositório" (or "Mudar")
opens a picker of what the workspace's GitHub reaches (`GET …/github/repositories`) by account, with a search, where
the order of checking is the order kept. A project that has none shows nothing there to anyone but an
administrator. They first sat under the project board's title; the board now links to the overview instead.

### 4. The agents' context

A run's task is the one it is tied to (`agent_runs.issue_id`), else the task whose own conversation it is in (ADR
0145): read from the database (`taskOfRun`), since a computer turn's checkouts are synced before the run's context is
built.

- The task's brief (`issueWorkBrief`) has a "Repositories" section: the project's repositories, its main one first,
  and to work in the main one unless the task or the person names another.
- "Your open tasks" says each task's project's repositories (three, then how many more), and `list_issues` says each
  project's repositories once, under its tasks.
- `git_clone` with no `repo` clones the main repository of the run's task's project, and asks for one when there is
  none. A GitHub tool that works on a repository nobody named declares it (`defaultRepo`): the Tool Gateway's GitHub
  check checks the agent's repositories against that one, so an unnamed call is never let through, and the tool
  resolves and checks it again when it runs, in case the project changed in between.
- On a connected computer, the turn starts in the project's main repository, unless the conversation names another
  checkout, and that repository is kept up to date before the turn and offered to clone when it isn't there. Only
  when the agent reaches it (§5): a run on a task it isn't assigned to, in a project whose repository is outside its
  list, is neither synced there nor starts there, and the GitHub check refuses it as before.

### 5. Reach

An agent with its own list of repositories reaches, besides it, the repositories of the projects in which it has an
open task: to do, in progress or in review, with the agent among its assignees (`taskProjectRepositoriesOf`). It is
computed each time the list is read (`agentRepositoryList`: its own list first, then what the list doesn't cover), so
the git proxy, the Tool Gateway's GitHub check, the read tokens straight from GitHub (ADR 0116), the checkouts synced
before a turn and the "Your GitHub repositories" prompt all check the same thing, and nothing is kept to undo.
Finishing or canceling the task, or taking the agent off it, ends that reach at the next read. An agent with no list
already reaches every repository and is unchanged.

What only the agent's own list decides reads that list alone (`agentOwnRepositoryList`):

- its settings, which show and save its own list, and the rule that its owner only narrows it: a task's repository is
  never a way to keep a repository for good;
- "Pode fazer merge sem perguntar": chosen among its own repositories and applied within them, so reach through a task
  never merges without a person's approval;
- whether it works on its own computer rather than spilling over to another (it "has repositories").

Who may give an agent a task in a project gives it that project's repositories while the task is open. That is why §2
keeps the linking to administrators: they decide which repositories a project's work may touch, and assigning work
stays the everyday act it is.

### 6. Issues and pull requests

An administrator turns a project's import on (`issue_projects.github_import`, `PUT …/github-import`, audited as
`issue.project_github_import_changed`), and who did is kept (`github_import_by`): its tasks are made in their name,
with their permissions, so one who leaves the workspace or can no longer create tasks stops it, quietly. It needs the
GitHub App installed where the repository is: the events come through its webhook (`issues` and `pull_request`, which
it already asks for), each queued once per delivery as a job of its own (`github_app.project_sync`), apart from what
agents hear (ADR 0156), since one delivery may be both.

- An issue opened in one of the project's repositories becomes a task in it, once (found again by its address and its
  source `{ type: "github", repo, number }`). When several projects import from one repository, the oldest takes it.
  An issue a bot opens (Dependabot and the like) is not imported. An archived project imports nothing.
- Edited, the task's title and description follow; closed, the task is done, or canceled when GitHub says not planned;
  reopened, it is to do again.
- A pull request opened, edited or reopened joins each imported task whose issue it closes, as GitHub reads its words
  ("Fixes #12", "closes acme/web#3", the issue's address): the link moves the task to review as any linked pull
  request does. One that only mentions an issue joins nothing. A bot's pull request joins too: that is how an agent's,
  opened through the app, reaches its task. Its merge closes the issue on GitHub, and that closes the task.
- What comes from GitHub is outside text. The title keeps no control or format character, no envelope marker, one line
  of at most 200 characters, since it is read in many prompts outside any envelope. The description is kept as
  written (at most 20,000 characters) and agents read it inside an `untrustedBlock` in the task's brief, as the issue
  tools already show every description.
- The tasks are seen by the whole workspace, whatever the repository's own visibility on GitHub: an administrator
  chose to bring that repository's issues in.

### 7. A page of projects

Projects have a page of their own, "Projetos", a tool of the sidebar right after Tarefas (`projects` in the sidebar's
items: in the list by default in a team's workspace, in More in a personal one, ADR 0159), and in Go to. It shows a
card per project in use, by name: its color and name, how many open tasks the reader sees in it, its main repository
and how many more ("Sem repositório" when it has none), the people and agents on its open tasks, the agent at work
first (`projectCrews`, from the tasks the reader already lists), and whether its GitHub issues are imported. A card
opens the project's overview (§8).
Archived projects wait under their heading, folded until "Mostrar arquivados". With no project in use the page is an
empty state that says what a project is and offers "Novo projeto", for whoever may post. It reads only what the
projects menu and the board already read, so the server is unchanged.

### 8. A project's overview

Each project has an overview at `/projects/<id>`, the way in from its card. Its header holds the project's name, how
many of its tasks are done (a canceled one counts in none), "Abrir quadro" for its board (`/issues?project=`, which
stays where it was) and, for whoever may post, a menu to edit, archive or delete it. Below come its repositories and
the import (§3, §6), the stalled work the board also shows, then, from the project's own tasks (`projectOverview`):

- "Etapas": its tasks in each of the board's stages.
- "Precisa de atenção": its open tasks past their due day, the longest overdue first, then the ones whose background
  work stopped on something (ADR 0121), each saying why; a list only when there are some.
- "Quem trabalha nele": the people and agents on its open tasks with how many each, the agent at work first, then one
  that stopped midway, then by how many.
- "Atualizadas por último": the tasks changed last, at most eight, each with its stage and when.

Each task opens its own page. A project with no task says so once. A project that is gone, deleted from this page or
elsewhere, sends the reader back to the projects. The project's board links here ("Visão geral"). It reads only the
project's tasks as the board does, so the server is unchanged.

## Not in this change

- The phone shows nothing of a project's repositories yet, nor the Projects page or a project's overview.
- A project's own history: its overview lists the tasks changed last, not what changed on each (that is on the task).
- An agent's own list and a project's repositories are separate lists: picking repositories for a project changes no
  agent's settings.
- Issues already open when the import is turned on: only what GitHub sends from then on is imported.
- Comments, labels and assignees on GitHub, and anything back from a task to its issue: closing a task closes nothing
  on GitHub.
