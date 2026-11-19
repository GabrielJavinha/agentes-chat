# 0202. A project's GitHub repositories

- Status: Accepted (§1 to §5 built; §6 planned)
- Date: 2026-11-19
- Extends: 0171 (projects in Tarefas), 0033 and 0156 (the workspace's GitHub), the agent's repositories
  (`agent_repositories`)
- Code: `packages/engine/src/issue-projects.ts` (`setProjectRepositories`, `projectRepositories`,
  `cleanProjectRepositories`, `PROJECT_REPOSITORIES_MAX`, `taskOfRun`, `runProjectMainRepo`, `projectReposLines`);
  route `PUT …/issue-projects/{projectId}/repositories` (`apps/server/src/routes/app/issues.ts`); web
  `ProjectRepositories` in `apps/web/src/pages/IssueProjects.tsx`; agents: `issueWorkBrief` (`issue-work.ts`),
  `openTasksBrief` (`issues.ts`), `list_issues` (`issue-tools.ts`), `git_clone` (`git/tools.ts`), `prepareAgentCode`
  (`git/machine.ts`), the GitHub check's `defaultRepo` (`tools/checks.ts`, `tools/types.ts`); reach:
  `agentRepositoryList`, `agentOwnRepositoryList`, `taskProjectRepositoriesOf` (`git/repos.ts`)

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

### 3. The board shows them

Under a project board's title, "Repositórios" lists them as chips, the main one first and marked. A chip's menu opens
it on GitHub and, for an administrator, makes it the main one or unlinks it. "Vincular repositório" (or "Mudar")
opens a picker of what the workspace's GitHub reaches (`GET …/github/repositories`) by account, with a search, where
the order of checking is the order kept. A board whose project has none shows nothing to anyone but an
administrator.

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

### 6. Planned: issues and pull requests

Behind a switch per project, off by default, and only with the GitHub App installed: a GitHub issue opened in a
linked repository becomes a task in the project (`issues.github_url`), its closing and reopening move the task, and
a pull request that names a task joins its `pull_requests`.

## Not in this change

- The phone shows nothing of a project's repositories yet.
- An agent's own list and a project's repositories are separate lists: picking repositories for a project changes no
  agent's settings.
