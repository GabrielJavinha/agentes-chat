# 0202. A project's GitHub repositories

- Status: Accepted (§1 to §3 built; §4 to §6 planned)
- Date: 2026-11-19
- Extends: 0171 (projects in Tarefas), 0033 and 0156 (the workspace's GitHub), the agent's repositories
  (`agent_repositories`)
- Code: `packages/engine/src/issue-projects.ts` (`setProjectRepositories`, `projectRepositories`,
  `cleanProjectRepositories`, `PROJECT_REPOSITORIES_MAX`); route `PUT …/issue-projects/{projectId}/repositories`
  (`apps/server/src/routes/app/issues.ts`); web `ProjectRepositories` in `apps/web/src/pages/IssueProjects.tsx`

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

### 4. Planned: the agents' context

A run on a task whose project has repositories is told them, its main one first, and `git_clone` starts from the main
one when nobody names a repository. `list_issues` and "Your open tasks" say a task's project's repositories.

### 5. Planned: reach

An agent with its own list of repositories reaches, besides it, the repositories of the projects in which it has an
open task. This is computed where the list is read (`agentRepositoryList`), so the git proxy, the Tool Gateway and
`git_clone` check the same thing. An agent with no list already reaches every repository and is unchanged. Closing the
task, or taking the agent off it, ends that reach. §2 is what keeps this from being a way around who may widen an
agent's access.

### 6. Planned: issues and pull requests

Behind a switch per project, off by default, and only with the GitHub App installed: a GitHub issue opened in a
linked repository becomes a task in the project (`issues.github_url`), its closing and reopening move the task, and
a pull request that names a task joins its `pull_requests`.

## Not in this change

- The phone shows nothing of a project's repositories yet.
- An agent's own list and a project's repositories are separate lists: picking repositories for a project changes no
  agent's settings.
